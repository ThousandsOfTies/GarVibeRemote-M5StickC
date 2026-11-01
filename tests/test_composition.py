import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from composition import product


class ProductCompositionTests(unittest.TestCase):
    def test_binding_selects_names_and_builds_one_shared_application(self):
        selected = product()
        binding = json.loads((ROOT / 'hardware/binding.json').read_text(encoding='utf-8'))
        self.assertEqual(binding, {'schema_version': 1, 'display': 'lcd', 'buttons': ['A', 'B', 'C'], 'orientation': 'portrait'})
        generated = selected.prepare()
        app = selected.components['application']
        self.assertEqual(selected.data['build']['sources'], [
            'vibe-remote/device-app/DeviceApplication.cpp', 'vibe-remote/compact-ui/CompactUi.cpp'])
        self.assertTrue((app / selected.data['build']['sources'][0]).is_file())
        self.assertIn('gar_application', (generated / 'application_config.h').read_text(encoding='utf-8'))
        self.assertIn('BluetoothSerial', (generated / 'board.ini').read_text(encoding='utf-8'))
        sources = (generated / 'gar_composed_sources.h').read_text(encoding='utf-8')
        self.assertEqual(3, sources.count('#include'))
        self.assertIn('board-m5stickc-plus2', sources)
        self.assertIn('#define LV_MEM_SIZE GAR_APPLICATION_LVGL_HEAP_BYTES',
                      (ROOT / 'firmware/stickc-plus2/include/stickc_lv_conf.h').read_text(encoding='utf-8'))
        self.assertEqual(49152, selected.data['application']['lvgl_heap_bytes'])

    def test_application_and_board_own_their_respective_logic(self):
        selected = product()
        app = selected.components['application'] / 'vibe-remote/device-app'
        for source in app.glob('*.*'):
            if source.suffix not in ('.h', '.cpp'):
                continue
            text = source.read_text(encoding='utf-8')
            for forbidden in ('M5Unified', 'BluetoothSerial.h', 'm5stickc-plus2', 'pinMode('):
                self.assertNotIn(forbidden, text)
        for name in ('DeviceApplication.h', 'DeviceLink.h', 'PairingConsent.h'):
            self.assertFalse((ROOT / 'firmware/stickc-plus2/include' / name).exists())
        self.assertFalse((ROOT / 'firmware/stickc-plus2/src/DeviceApplication.cpp').exists())


if __name__ == '__main__':
    unittest.main()
