import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gar_target_artifact', ROOT / 'scripts/gar_target_artifact.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


def image(segment=b'CODE'):
    header = bytearray(24)
    header[0], header[1], header[23] = 0xe9, 1, 1
    data = header + struct.pack('<II', 0x3ffb0000, len(segment)) + segment
    checksum = 0xef
    for value in segment:
        checksum ^= value
    data += b'\0' * (15 - len(data) % 16) + bytes([checksum])
    return bytes(data) + hashlib.sha256(data).digest()


def partitions(size=0x300000):
    entry = struct.pack('<2sBBII16sI', b'\xaa\x50', 0, 0, 0x10000, size, b'app0', 0)
    table = entry + b'\xeb\xeb' + b'\xff' * 14 + hashlib.md5(entry).digest()
    return table + b'\xff' * (3072 - len(table))


class GarTargetArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'product'
        self.root.mkdir()
        root_patch = patch.object(exporter, 'ROOT', self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        self.build = self.root / '.cache/fixture/build'
        self.packages = self.root / '.cache/fixture/packages'
        self.build.mkdir(parents=True)
        self.boot_app = self.packages / 'framework-arduinoespressif32/tools/partitions/boot_app0.bin'
        self.boot_app.parent.mkdir(parents=True)
        (self.build / 'bootloader.bin').write_bytes(image(b'BOOT'))
        (self.build / 'partitions.bin').write_bytes(partitions())
        (self.build / 'firmware.bin').write_bytes(image())
        self.boot_app.write_bytes(b'\xff' * 8192)
        self.output = self.root / 'artifacts/from-codespace'

    def publish(self):
        return exporter.publish_bundle(self.build, self.packages)

    def test_bundle_contains_only_flash_payload_and_complete_checksums(self):
        # Unrelated build/cache files must never be included in the GAR snapshot.
        (self.build / 'firmware.elf').write_bytes(b'not for flashing')
        self.publish()
        manifest = json.loads((self.output / 'artifact.json').read_text())
        self.assertEqual(manifest['target'], 'esp32')
        self.assertEqual(manifest['deploy']['app']['files'],
                         [{'src': 'files/stickc-plus2', 'dest': 'stickc-plus2'}])
        payload = self.output / 'files/stickc-plus2'
        self.assertEqual({path.name for path in payload.iterdir()}, {*exporter.FLASH_FILES, 'SHA256SUMS'})
        sums = dict(line.split('  ') for line in (payload / 'SHA256SUMS').read_text().splitlines())
        self.assertEqual(set(sums.values()), set(exporter.FLASH_FILES))
        for digest, name in sums.items():
            self.assertEqual(hashlib.sha256((payload / name).read_bytes()).hexdigest(), digest)
        self.assertFalse((self.output / 'artifact-info.json').exists())

    def test_export_is_independent_of_mutable_build_cache_and_replaces_stale_files(self):
        self.publish()
        copy = self.output / 'files/stickc-plus2/firmware.bin'
        first = copy.read_bytes()
        (self.build / 'firmware.bin').write_bytes(image(b'NEXT'))
        self.assertEqual(copy.read_bytes(), first)
        (self.output / 'stale-secret.txt').write_text('must not be captured')
        self.publish()
        self.assertEqual(copy.read_bytes(), image(b'NEXT'))
        self.assertFalse((self.output / 'stale-secret.txt').exists())

    def test_missing_empty_or_corrupted_files_invalidate_staging_manifest(self):
        original = (self.build / 'firmware.bin').read_bytes()
        for bad in (None, b'', b'not an ESP32 firmware', original[:-1], original[:-33] + b'\0' * 33):
            with self.subTest(input=bad):
                (self.build / 'firmware.bin').write_bytes(original)
                self.publish()
                if bad is None:
                    (self.build / 'firmware.bin').unlink()
                else:
                    (self.build / 'firmware.bin').write_bytes(bad)
                with self.assertRaises(exporter.BuildError):
                    self.publish()
                self.assertFalse((self.output / 'artifact.json').exists())

    def test_wrong_chip_partition_digest_and_partition_capacity_are_rejected(self):
        invalid_chip = bytearray(image())
        invalid_chip[12] = 5  # ESP32-C3 rather than the Plus2's original ESP32.
        (self.build / 'firmware.bin').write_bytes(invalid_chip)
        with self.assertRaisesRegex(exporter.BuildError, 'original ESP32'):
            self.publish()
        (self.build / 'firmware.bin').write_bytes(image())
        (self.build / 'partitions.bin').write_bytes(partitions(64))
        with self.assertRaisesRegex(exporter.BuildError, 'does not fit'):
            self.publish()
        corrupt = bytearray(partitions())
        corrupt[50] ^= 1
        (self.build / 'partitions.bin').write_bytes(corrupt)
        with self.assertRaisesRegex(exporter.BuildError, 'digest mismatch'):
            self.publish()

    def test_linked_input_and_linked_output_are_rejected_without_following_them(self):
        outside = Path(self.temporary.name) / 'outside.bin'
        outside.write_bytes(image())
        firmware = self.build / 'firmware.bin'
        firmware.unlink()
        try:
            firmware.symlink_to(outside)
        except OSError as error:
            self.skipTest(f'Symlink creation unavailable: {error}')
        with self.assertRaisesRegex(exporter.BuildError, 'Symlinks'):
            self.publish()
        firmware.unlink()
        firmware.write_bytes(image())
        self.output.parent.mkdir(parents=True, exist_ok=True)
        unrelated = Path(self.temporary.name) / 'unrelated'
        unrelated.mkdir()
        sentinel = unrelated / 'artifact.json'
        sentinel.write_text('keep')
        self.output.symlink_to(unrelated, target_is_directory=True)
        with self.assertRaisesRegex(exporter.BuildError, 'Symlinks'):
            self.publish()
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_package_only_never_installs_compiles_or_accesses_serial_devices(self):
        with patch.object(exporter, 'build_firmware') as build, patch.object(exporter.subprocess, 'run') as run:
            result = exporter.main(['--package-only', '--build-dir', str(self.build),
                                    '--packages-dir', str(self.packages)])
        self.assertEqual(result, 0)
        build.assert_not_called()
        run.assert_not_called()

    def test_target_mismatch_or_build_failure_cannot_leave_a_successful_staging_manifest(self):
        self.publish()
        with patch.dict(os.environ, GAR_TARGET='another-target'), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(exporter.main(['--package-only', '--build-dir', str(self.build),
                                            '--packages-dir', str(self.packages)]), 1)
        self.assertFalse((self.output / 'artifact.json').exists())
        self.publish()
        with patch.object(exporter, 'os', SimpleNamespace(name='posix', environ=os.environ)), \
                patch.object(exporter, 'build_firmware', side_effect=subprocess.CalledProcessError(1, ['fixture'])), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(exporter.main([]), 1)
        self.assertFalse((self.output / 'artifact.json').exists())

    def test_runtime_platforms_are_isolated_from_each_other_and_existing_windows_tools(self):
        with patch.object(exporter.sys, 'platform', 'linux'):
            linux = exporter.runtime_paths()
        with patch.object(exporter.sys, 'platform', 'win32'):
            windows = exporter.runtime_paths()
        self.assertNotEqual(linux[0], windows[0])
        self.assertNotEqual(linux[2], windows[2])
        for runtime, _, cache, _ in (linux, windows):
            self.assertTrue(runtime.is_relative_to(self.root / '.gar/target-build-tools'))
            self.assertTrue(cache.is_relative_to(self.root / '.cache/gar-target-build'))
            self.assertFalse(runtime.is_relative_to(self.root / '.gar/firmware-tools'))

    def test_clean_removes_only_staging_and_keeps_toolchain_cache(self):
        self.publish()
        sentinel = self.build / 'keep'
        sentinel.write_text('cache')
        exporter.clean_output()
        self.assertFalse(self.output.exists())
        self.assertEqual(sentinel.read_text(), 'cache')

    def test_gar_build_cache_moves_tools_off_the_product_bind_mount(self):
        base = Path(self.temporary.name) / 'docker-cache'
        with patch.dict(os.environ, GAR_BUILD_CACHE=str(base)):
            runtime, python, cache, env = exporter.runtime_paths()
        self.assertTrue(runtime.is_relative_to(base / 'target-build-tools'))
        self.assertTrue(cache.is_relative_to(base / 'target-build'))
        self.assertTrue(python.is_relative_to(runtime))
        self.assertEqual(env['PLATFORMIO_CORE_DIR'], str(cache / 'core'))
        self.assertIn(f'py{exporter.sys.version_info.major}.{exporter.sys.version_info.minor}', runtime.name)
        with patch.dict(os.environ, GAR_BUILD_CACHE='relative-cache'):
            with self.assertRaisesRegex(exporter.BuildError, 'absolute'):
                exporter.runtime_paths()


if __name__ == '__main__':
    unittest.main()
