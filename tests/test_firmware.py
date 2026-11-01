import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
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

    def test_serial_tools_are_isolated_and_pinned_without_platformio(self):
        with tempfile.TemporaryDirectory() as folder:
            python=Path(folder)/'isolated/python.exe'
            with patch.object(firmware,'PYTHON',python),patch.object(firmware.venv,'EnvBuilder') as builder,\
                 patch.object(firmware.subprocess,'run',return_value=subprocess.CompletedProcess([],1)) as run:
                firmware.serial_toolchain()
                builder.assert_called_once_with(with_pip=True)
                builder.return_value.create.assert_called_once_with(python.parent.parent)
                self.assertEqual(run.call_args_list[1].args[0],[str(python),'-m','pip','install','esptool==4.5.1'])
                self.assertTrue(all('platformio' not in str(call.args[0]) for call in run.call_args_list))

    def test_existing_serial_tools_are_reused_without_installing(self):
        with patch.object(firmware,'ensure_python'),\
             patch.object(firmware.subprocess,'run',return_value=subprocess.CompletedProcess([],0)) as run:
            firmware.serial_toolchain()
            self.assertEqual(run.call_count,1)
            self.assertIn("esptool.__version__ == '4.5.1'",run.call_args.args[0][-1])

    def test_esptool_command_uses_isolated_module_without_cached_firmware(self):
        with patch.object(firmware,'serial_toolchain') as prepare,patch.object(firmware,'environment') as environment:
            command=firmware.esptool('COM6','flash_id')
            prepare.assert_called_once_with();environment.assert_not_called()
            self.assertEqual(command[:3],[str(firmware.PYTHON),'-m','esptool'])
            self.assertEqual(command[-1],'flash_id');self.assertIn('esp32',command)

    def test_backup_prepares_only_serial_tool_and_records_complete_flash_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);python=root/'host/python.exe';python.parent.mkdir();python.touch()
            original=b'\x5a'*0x800000
            commands=[]
            def run(command,**kwargs):
                commands.append(command)
                if command[1]=='-c':return subprocess.CompletedProcess(command,0)
                self.assertEqual(command[1:3],['-m','esptool'])
                self.assertIn('read_flash',command)
                Path(command[-1]).write_bytes(original)
                return subprocess.CompletedProcess(command,0)
            with patch.object(firmware,'ROOT',root),patch.object(firmware,'PYTHON',python),\
                 patch.object(firmware,'usb_port',return_value='COM6'),patch.object(firmware,'toolchain') as build_tools,\
                 patch.object(firmware.subprocess,'run',side_effect=run),\
                 patch.object(sys,'argv',['firmware.py','backup','--port','COM6','--model','m5stickc-plus2']),\
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(firmware.main(),0)
                build_tools.assert_not_called()
            records=list((root/'artifacts/firmware').glob('*/backup.json'));self.assertEqual(len(records),1)
            self.assertEqual(json.loads(records[0].read_text()),{
                'model':'m5stickc-plus2','size':len(original),'sha256':hashlib.sha256(original).hexdigest()})
            self.assertEqual(len(commands),2)

    def test_backup_rejects_incomplete_read_without_success_record(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            def run(command,**kwargs):
                Path(command[-1]).write_bytes(b'incomplete')
                return subprocess.CompletedProcess(command,0)
            with patch.object(firmware,'ROOT',root),patch.object(firmware,'usb_port',return_value='COM6'),\
                 patch.object(firmware,'serial_toolchain'),patch.object(firmware.subprocess,'run',side_effect=run),\
                 patch.object(sys,'argv',['firmware.py','backup','--port','COM6','--model','m5stickc-plus2']),\
                 contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(firmware.main(),1)
            self.assertEqual(list((root/'artifacts/firmware').glob('*/backup.json')),[])

    def test_rejected_port_does_not_prepare_tools_or_invoke_esptool(self):
        with patch.object(firmware,'usb_port',side_effect=RuntimeError('not USB')),\
             patch.object(firmware,'serial_toolchain') as prepare,patch.object(firmware.subprocess,'run') as run,\
             patch.object(sys,'argv',['firmware.py','identify','--port','COM4']),\
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(firmware.main(),1)
            prepare.assert_not_called();run.assert_not_called()

if __name__=='__main__':unittest.main()
