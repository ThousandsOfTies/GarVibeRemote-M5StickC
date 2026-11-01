#!/usr/bin/env python3
"""Build the Plus2 firmware and export a GAR flash bundle; never access a device."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import struct
import subprocess
import sys
import tempfile
import venv

ROOT = Path(__file__).resolve().parents[1]
PIO_VERSION = '6.1.19'
PIO_ENV = 'stickc-plus2-usb'
FLASH_SIZE = 0x800000
FLASH_FILES = ('bootloader.bin', 'partitions.bin', 'boot_app0.bin', 'firmware.bin')


class BuildError(ValueError):
    pass


def output_directory():
    return ROOT / 'artifacts/from-codespace'


def require_plain_path(path):
    """Do not follow a directory link while reading or replacing build output."""
    path = Path(path).absolute()
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
            raise BuildError(f'Symlinks/junctions are not build inputs or output: {path}')
    return path


def checked_output():
    output = require_plain_path(output_directory())
    if not output.resolve().is_relative_to(ROOT.resolve()) or output == ROOT.resolve():
        raise BuildError('Artifact output must stay inside this Product workspace.')
    if output.exists() and not output.is_dir():
        raise BuildError(f'Artifact output is not a directory: {output}')
    return output


def invalidate_output():
    output = checked_output()
    manifest = require_plain_path(output / 'artifact.json')
    # A failed build must not leave a previous staging manifest available for capture.
    manifest.unlink(missing_ok=True)
    return output


def runtime_paths():
    tag = f'{sys.platform}-{platform.machine().lower()}-py{sys.version_info.major}.{sys.version_info.minor}'
    shared_cache = os.environ.get('GAR_BUILD_CACHE')
    if shared_cache:
        base = Path(shared_cache)
        if not base.is_absolute():
            raise BuildError('GAR_BUILD_CACHE must be an absolute build-cache directory.')
        runtime = base / 'target-build-tools' / f'{tag}-pio-{PIO_VERSION}'
        cache = base / 'target-build' / tag
    else:
        runtime = ROOT / '.gar/target-build-tools' / f'{tag}-pio-{PIO_VERSION}'
        cache = ROOT / '.cache/gar-target-build' / tag
    python = runtime / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    env = dict(os.environ, PLATFORMIO_CORE_DIR=str(cache / 'core'),
               PLATFORMIO_BUILD_DIR=str(cache / 'build'),
               PLATFORMIO_LIBDEPS_DIR=str(cache / 'libdeps'))
    return runtime, python, cache, env


def build_firmware():
    runtime, python, cache, env = runtime_paths()
    require_plain_path(runtime)
    require_plain_path(cache)
    if not python.is_file():
        venv.EnvBuilder(with_pip=True).create(runtime)
    check = subprocess.run([str(python), '-c',
                            f"import platformio; assert platformio.__version__ == '{PIO_VERSION}'"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if check.returncode:
        subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
                        f'platformio=={PIO_VERSION}'], env=env, check=True)
    subprocess.run([str(python), '-m', 'platformio', 'run',
                    '-d', str(ROOT / 'firmware/stickc-plus2'), '-e', PIO_ENV], env=env, check=True)
    return cache / 'build' / PIO_ENV, cache / 'core/packages'


def read_binary(path, maximum):
    path = require_plain_path(path)
    if not path.is_file() or not 0 < path.stat().st_size <= maximum:
        raise BuildError(f'Missing, empty or oversized firmware input: {path}')
    data = path.read_bytes()
    if not 0 < len(data) <= maximum:
        raise BuildError(f'Firmware input changed while being read: {path}')
    return data


def validate_image(name, data):
    """Check ESP32 image framing, segment checksum and the optional SHA-256 digest."""
    if len(data) < 24 or data[0] != 0xe9 or not 1 <= data[1] <= 16:
        raise BuildError(f'{name}: invalid ESP32 image header')
    if struct.unpack_from('<H', data, 12)[0] != 0 or data[23] not in (0, 1):
        raise BuildError(f'{name}: image is not for the original ESP32')
    cursor, checksum = 24, 0xef
    for _ in range(data[1]):
        if cursor + 8 > len(data):
            raise BuildError(f'{name}: truncated segment header')
        length = struct.unpack_from('<I', data, cursor + 4)[0]
        cursor += 8
        if length % 4 or cursor + length > len(data):
            raise BuildError(f'{name}: invalid segment length')
        for value in data[cursor:cursor + length]:
            checksum ^= value
        cursor += length
    checksum_offset = (cursor // 16) * 16 + 15
    if checksum_offset >= len(data) or data[checksum_offset] != checksum:
        raise BuildError(f'{name}: segment checksum mismatch')
    if data[23]:
        end = checksum_offset + 1
        if data[end:end + 32] != hashlib.sha256(data[:end]).digest():
            raise BuildError(f'{name}: image digest mismatch')


def validate_partitions(data, firmware_size):
    if len(data) % 32 or len(data) > 0x1000:
        raise BuildError('partitions.bin: invalid partition table size')
    ranges, app_size, entries = [], None, 0
    for index in range(0, len(data), 32):
        entry = data[index:index + 32]
        if entry == b'\xff' * 32:
            if any(value != 0xff for value in data[index:]):
                raise BuildError('partitions.bin: data follows the end marker')
            break
        if entry[:2] == b'\xeb\xeb':
            if entry[:16] != b'\xeb\xeb' + b'\xff' * 14 or entry[16:] != hashlib.md5(data[:index]).digest():
                raise BuildError('partitions.bin: partition table digest mismatch')
            if any(value != 0xff for value in data[index + 32:]):
                raise BuildError('partitions.bin: data follows the table digest')
            break
        if entry[:2] != b'\xaa\x50':
            raise BuildError('partitions.bin: invalid partition entry')
        kind, _, offset, size = struct.unpack_from('<BBII', entry, 2)
        if offset < 0x9000 or not size or offset + size > FLASH_SIZE:
            raise BuildError('partitions.bin: partition lies outside the Plus2 flash layout')
        if any(offset < end and offset + size > start for start, end in ranges):
            raise BuildError('partitions.bin: overlapping partitions')
        ranges.append((offset, offset + size))
        entries += 1
        if kind == 0 and offset == 0x10000:
            app_size = size
    if not entries or app_size is None or firmware_size > app_size:
        raise BuildError('partitions.bin: firmware does not fit the app partition at 0x10000')


def publish_bundle(build_dir, packages_dir):
    output = invalidate_output()
    build_dir, packages_dir = require_plain_path(build_dir), require_plain_path(packages_dir)
    sources = {name: build_dir / name for name in FLASH_FILES}
    sources['boot_app0.bin'] = packages_dir / 'framework-arduinoespressif32/tools/partitions/boot_app0.bin'
    limits = {'bootloader.bin': 0x7000, 'partitions.bin': 0x1000,
              'boot_app0.bin': 0x2000, 'firmware.bin': FLASH_SIZE - 0x10000}
    payload = {name: read_binary(sources[name], limits[name]) for name in FLASH_FILES}
    if len(payload['boot_app0.bin']) != 0x2000:
        raise BuildError('boot_app0.bin: expected the 8192-byte Arduino boot selection image')
    for name in ('bootloader.bin', 'firmware.bin'):
        validate_image(name, payload[name])
    validate_partitions(payload['partitions.bin'], len(payload['firmware.bin']))
    manifest = {'name': 'GarVibeRemote-M5StickC', 'target': 'esp32',
                'deploy': {'app': {'files': [{'src': 'files/stickc-plus2', 'dest': 'stickc-plus2'}]}}}
    output.parent.mkdir(parents=True, exist_ok=True)
    # Both source and destination have been checked inside the Product workspace.
    # Replacing the complete staging directory keeps cache files and stale payloads out.
    with tempfile.TemporaryDirectory(prefix='.gar-target-', dir=output.parent) as temporary:
        bundle = Path(temporary) / 'bundle'
        firmware = bundle / 'files/stickc-plus2'
        firmware.mkdir(parents=True)
        for name, data in payload.items():
            (firmware / name).write_bytes(data)
        sums = ''.join(f'{hashlib.sha256(payload[name]).hexdigest()}  {name}\n' for name in FLASH_FILES)
        (firmware / 'SHA256SUMS').write_text(sums, encoding='utf-8', newline='\n')
        (bundle / 'artifact.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
        if output.exists():
            # TemporaryDirectory owns cleanup of this verified workspace-local directory.
            output.rename(Path(temporary) / 'previous')
        bundle.rename(output)
    return output


def clean_output():
    output = invalidate_output()
    if output.exists():
        with tempfile.TemporaryDirectory(prefix='.gar-target-clean-', dir=output.parent) as temporary:
            output.rename(Path(temporary) / 'previous')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=['build', 'clean'], default='build')
    parser.add_argument('--package-only', action='store_true', help='Export an existing build without installing tools or compiling')
    parser.add_argument('--build-dir', type=Path, help='Existing PlatformIO environment output directory')
    parser.add_argument('--packages-dir', type=Path, help='Existing PlatformIO packages directory')
    args = parser.parse_args(argv)
    try:
        invalidate_output()
        if os.environ.get('GAR_TARGET', 'esp32') != 'esp32':
            raise BuildError('This Product build hook requires GAR_TARGET=esp32.')
        if args.action == 'clean':
            if args.package_only or args.build_dir or args.packages_dir:
                raise BuildError('clean does not accept packaging arguments.')
            clean_output()
            return 0
        if args.package_only:
            if args.build_dir is None or args.packages_dir is None:
                raise BuildError('--package-only requires --build-dir and --packages-dir.')
            build_dir, packages_dir = args.build_dir, args.packages_dir
        else:
            if args.build_dir or args.packages_dir:
                raise BuildError('--build-dir and --packages-dir require --package-only.')
            if os.name == 'nt':
                raise BuildError('Run the GAR build hook in the selected Linux/Docker build environment.')
            build_dir, packages_dir = build_firmware()
        output = publish_bundle(build_dir, packages_dir)
        print(f'GAR Plus2 flash bundle ready: {output}')
        return 0
    except (BuildError, OSError, subprocess.SubprocessError) as error:
        print(f'GAR target build failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
