import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import gar_sim_artifact as exporter
import gar_target_artifact as target
sys.path.pop(0)


class GarSimulationArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for module in (exporter, target):
            root_patch = patch.object(module, 'ROOT', self.root)
            root_patch.start()
            self.addCleanup(root_patch.stop)
        self.simulation = self.root / 'simulation'
        self.simulation.mkdir()
        for name in (*exporter.PANEL_FILES, *exporter.SERVER_FILES):
            shutil.copyfile(ROOT / 'simulation' / name, self.simulation / name)
        runtime = self.simulation / 'runtime'
        runtime.mkdir()
        (runtime / 'lvgl-ui.mjs').write_text('export default async()=>({});')
        (runtime / 'lvgl-ui.wasm').write_bytes(b'\x00asm\x01\x00\x00\x00')
        (runtime / 'build.json').write_text(json.dumps({'width': 135, 'height': 240,
            'runtime': 'shared-device-application', 'applicationSourceHash': 'test-source'}))
        tools = self.root / 'sources/gar-tools/web-simulator'
        tools.mkdir(parents=True)
        shutil.copyfile(ROOT / 'sources/gar-tools/web-simulator/serve.py', tools / 'serve.py')
        shutil.copytree(ROOT / 'sources/gar-tools/web-simulator/components', tools / 'components')
        self.output = self.root / 'artifacts/from-codespace'

    def test_standalone_bundle_contains_shared_device_parts_without_settings_or_caches(self):
        (self.simulation / '.env').write_text('secret')
        (self.simulation / 'private.json').write_text('{"token":"private"}')
        (self.simulation / 'ui-runtime').mkdir()
        (self.simulation / 'ui-runtime/old.wasm').write_bytes(b'old')
        exporter.publish_bundle()
        host = self.output / 'files/host'
        self.assertTrue((host / 'gar-components/m5stickc-plus2.mjs').is_file())
        self.assertTrue((host / 'host-controller.cjs').is_file())
        self.assertTrue((host / 'runtime/lvgl-ui.wasm').is_file())
        self.assertFalse((host / '.env').exists())
        self.assertFalse((host / 'private.json').exists())
        self.assertFalse((host / 'ui-runtime').exists())
        descriptor = json.loads((host / 'host-process.json').read_text())
        self.assertEqual(descriptor['executable'], 'node')
        self.assertEqual(descriptor['health_url'], 'http://127.0.0.1:8772/health')
        manifest = json.loads((self.output / 'artifact.json').read_text())
        self.assertEqual(manifest['deploy']['app']['files'], [{'src': 'files/host', 'dest': '.'}])

    def test_snapshot_inputs_are_copied_and_old_staging_is_replaced(self):
        exporter.publish_bundle()
        bundle = self.output / 'files/host/index.html'
        before = bundle.read_bytes()
        (self.simulation / 'index.html').write_text('next')
        self.assertEqual(bundle.read_bytes(), before)
        (self.output / 'private.txt').write_text('stale')
        exporter.publish_bundle()
        self.assertEqual(bundle.read_text(), 'next')
        self.assertFalse((self.output / 'private.txt').exists())

    def test_invalid_or_missing_runtime_removes_old_manifest(self):
        for wrong in (b'', b'not wasm'):
            (self.simulation / 'runtime/lvgl-ui.wasm').write_bytes(b'\x00asm\x01\x00\x00\x00')
            exporter.publish_bundle()
            (self.simulation / 'runtime/lvgl-ui.wasm').write_bytes(wrong)
            with self.assertRaises(exporter.BuildError):
                exporter.publish_bundle()
            self.assertFalse((self.output / 'artifact.json').exists())

    def test_wrong_display_fails_before_capture(self):
        (self.simulation / 'runtime/build.json').write_text(json.dumps({'width': 240, 'height': 240}))
        with self.assertRaises(exporter.BuildError):
            exporter.publish_bundle()

    def test_ui_only_module_is_not_captured_as_the_shared_application(self):
        (self.simulation / 'runtime/build.json').write_text(json.dumps({'width': 135, 'height': 240}))
        with self.assertRaisesRegex(exporter.BuildError, 'UI-only'):
            exporter.publish_bundle()

    def test_failed_build_never_leaves_previous_sim_or_target_capture_available(self):
        exporter.publish_bundle()
        with patch.object(exporter.subprocess, 'run', side_effect=OSError('compiler unavailable')):
            self.assertEqual(exporter.main([]), 1)
        self.assertFalse((self.output / 'artifact.json').exists())


if __name__ == '__main__':
    unittest.main()
