import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('firmware_tools',ROOT/'scripts/firmware.py')
firmware=importlib.util.module_from_spec(spec);spec.loader.exec_module(firmware)

class FirmwareTests(unittest.TestCase):
    @unittest.skipUnless(os.name=='nt','Windows COM classification')
    def test_usb_validation_rejects_bluetooth_and_normalizes_com(self):
        ports=[{'port':'COM4','kind':'bluetooth'},{'port':'COM6','kind':'usb'}]
        with patch.object(firmware.setup,'serial_ports',return_value=(ports,None)):
            with self.assertRaises(RuntimeError):firmware.usb_port('COM4')
            self.assertEqual(firmware.usb_port('com6'),'COM6')

    def test_build_cache_is_deterministic_and_separate_for_different_checkouts(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(firmware,'ROOT',Path(folder)/'a'):first=firmware.environment()
            with patch.object(firmware,'ROOT',Path(folder)/'b'):second=firmware.environment()
            self.assertNotEqual(first['PLATFORMIO_BUILD_DIR'],second['PLATFORMIO_BUILD_DIR'])
            self.assertEqual(first['PLATFORMIO_CORE_DIR'],second['PLATFORMIO_CORE_DIR'])
            self.assertNotIn('TWatch',first['PLATFORMIO_CORE_DIR'])

    def test_esp_tool_is_selected_from_the_products_own_toolchain(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);tool=base/'packages/tool-esptoolpy/esptool.py';tool.parent.mkdir(parents=True);tool.write_text('# fixture')
            with patch.object(firmware,'environment',return_value={'PLATFORMIO_CORE_DIR':str(base)}):
                command=firmware.esptool('COM6','flash_id')
                self.assertEqual(command[1],str(tool));self.assertIn('esp32',command);self.assertEqual(command[-1],'flash_id')
                tool.unlink()
                with self.assertRaises(RuntimeError):firmware.esptool('COM6','flash_id')

if __name__=='__main__':unittest.main()
