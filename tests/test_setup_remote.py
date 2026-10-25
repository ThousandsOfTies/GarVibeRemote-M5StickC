import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('setup_remote',ROOT/'scripts/setup_remote.py')
setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)
settings=setup.settings

class SetupTests(unittest.TestCase):
    def test_repeat_configuration_preserves_token_session_label_and_unrelated_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);config=root/'private/local.json'
            first=settings.configure(config,project=root,session='chat-1',label='作業')
            first['custom']='keep';config.write_text(json.dumps(first))
            second=settings.configure(config,project=root)
            self.assertEqual(first['token'],second['token']);self.assertEqual(second['sessionId'],'chat-1')
            self.assertEqual(second['label'],'作業');self.assertEqual(second['custom'],'keep')
            self.assertFalse(second['watchInput']);self.assertEqual(settings.read_config(config),second)

    def test_import_transfers_pc_settings_without_old_hardware_or_approvals(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);old=root/'old.json';new=root/'new.json'
            original={'token':'private-token-for-migration','port':39500,'sessionId':'chat-1','label':'作業',
                      'sppPort':'COM4','sppBaudRate':115200,'watchInput':True,'firmwarePath':'old/device'}
            old.write_text(json.dumps(original));before=old.read_bytes()
            migrated=settings.configure(new,project=root,import_config=old)
            for key in ('token','port','sessionId','label'):self.assertEqual(migrated[key],original[key])
            self.assertFalse(migrated['watchInput']);self.assertNotIn('sppPort',migrated);self.assertNotIn('firmwarePath',migrated)
            self.assertEqual(old.read_bytes(),before)
            another=root/'another.json';another.write_text(json.dumps({**original,'token':'a-different-private-token'}))
            saved=new.read_bytes()
            with self.assertRaises(settings.SetupError):settings.configure(new,project=root,import_config=another)
            self.assertEqual(new.read_bytes(),saved)

    def test_invalid_options_fail_without_creating_config_or_exposing_secrets(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);path=root/'private/config.json'
            for args in ({'port':0},{'port':True},{'session':'../bad'},{'label':'a\nb'}):
                with self.assertRaises(settings.SetupError):settings.configure(path,project=root,**args)
                self.assertFalse(path.exists())
            with self.assertRaises(settings.SetupError):settings.configure(path,project=root/'missing')
            path.parent.mkdir();secret='TOKEN SHOULD NEVER APPEAR';path.write_text(json.dumps({'token':secret,'port':39275}))
            with self.assertRaises(settings.SetupError) as caught:settings.read_config(path)
            self.assertNotIn(secret,str(caught.exception))

    def test_public_directory_and_symlink_to_public_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);public=root/'public';public.mkdir()
            with patch.object(settings,'PANEL',public):
                with self.assertRaises(settings.SetupError):settings.configure(public/'local.json',project=root)
                try:(root/'alias').symlink_to(public,target_is_directory=True)
                except OSError:return
                with self.assertRaises(settings.SetupError):settings.configure(root/'alias/local.json',project=root)

    def test_hook_generation_preserves_other_hooks_is_idempotent_and_uses_monitoring_only(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);config=root/'config.json';settings.configure(config,project=root)
            hook=root/'.codex/hooks.json';hook.parent.mkdir()
            foreign={'matcher':'Bash','hooks':[{'type':'command','command':'other-tool --check','timeout':7}]}
            hook.write_text(json.dumps({'custom':'keep','hooks':{'PreToolUse':[foreign]}}))
            with patch.object(settings,'ROOT',root):
                settings.prepare_hooks(root,config);first=hook.read_bytes();settings.prepare_hooks(root,config)
            self.assertEqual(hook.read_bytes(),first);doc=json.loads(first);self.assertEqual(doc['custom'],'keep')
            self.assertIn(foreign,doc['hooks']['PreToolUse'])
            for event in settings.EVENTS:
                own=[h for g in doc['hooks'][event] for h in g['hooks'] if settings.owns_command(h['command'],settings.APP/'scripts/codex-hook.py')]
                self.assertEqual(len(own),1);self.assertEqual(own[0]['timeout'],3)
                self.assertNotIn('--watch-input',own[0]['command']);self.assertNotIn(settings.read_config(config)['token'],own[0]['command'])
            self.assertEqual(len(list((root/'.gar/setup-backups').glob('*/hooks.json'))),1)

    def test_replacement_is_explicit_and_does_not_match_another_script_with_same_prefix(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);project=root/'project';project.mkdir();old=root/'old-product'
            sender=old/'sources/gar-vibe-ui/vibe-remote/scripts/codex-hook.py';sender.parent.mkdir(parents=True);sender.write_text('# fixture')
            config=root/'config.json';settings.configure(config,project=project)
            path=project/'.codex/hooks.json';path.parent.mkdir()
            original={'hooks':{'Stop':[{'hooks':[{'type':'command','command':f'python "{sender}" --config old'},
                         {'type':'command','command':f'python "{sender}.other"'}]}]}}
            path.write_text(json.dumps(original))
            with patch.object(settings,'ROOT',root):settings.prepare_hooks(project,config)
            self.assertIn(' --config old',path.read_text())
            with patch.object(settings,'ROOT',root):settings.prepare_hooks(project,config,replace_product=old)
            doc=json.loads(path.read_text());commands=[h['command'] for g in doc['hooks']['Stop'] for h in g['hooks']]
            self.assertFalse(any(' --config old' in c for c in commands));self.assertTrue(any('.other' in c for c in commands))

    def test_bad_hook_file_or_interactive_setting_cannot_overwrite_existing_hooks(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);config=root/'config.json';settings.configure(config,project=root)
            path=root/'.codex/hooks.json';path.parent.mkdir();path.write_text('{broken')
            with self.assertRaises(settings.SetupError):settings.prepare_hooks(root,config)
            self.assertEqual(path.read_text(),'{broken')
            path.write_text(json.dumps({'hooks':{'Stop':'invalid'}}))
            with self.assertRaises(settings.SetupError):settings.prepare_hooks(root,config)
            d=settings.read_config(config);d['watchInput']=True;config.write_text(json.dumps(d))
            with self.assertRaises(settings.SetupError):settings.prepare_hooks(root,config)

    def test_doctor_is_read_only_and_redacts_prompt_token_and_session_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);path=root/'config.json';settings.configure(path,project=root,session='private-session',label='private-label')
            before=path.read_bytes();token=settings.read_config(path)['token']
            with patch.object(setup,'serial_ports',return_value=([],None)),patch.object(setup,'bridge_status',return_value={'state':'offline'}):
                report=setup.doctor(path)
            self.assertEqual(path.read_bytes(),before);self.assertEqual(report['deviceTransport'],'usb-serial')
            self.assertEqual(report['bleTransport'],'not-implemented');self.assertEqual(report['deviceInput'],'not-checked')
            serialized=json.dumps(report)
            for secret in (token,'private-session','private-label','watchInput'):self.assertNotIn(secret,serialized)
            self.assertEqual(report['hooks']['trust'],'not-checked')

    def test_authenticated_bridge_probe_only_returns_reachability_and_session_match(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                if self.headers.get('Authorization')!='Bearer a-private-test-token':self.send_response(401);self.end_headers();return
                data=json.dumps({'state':{'session':{'id':'selected'},'ui':{'message':'private prompt'}}}).encode()
                self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            config={'port':server.server_port,'token':'a-private-test-token','sessionId':'selected'}
            report=setup.bridge_status(config);self.assertEqual(report,{'state':'reachable','sessionMatches':True})
            self.assertEqual(setup.bridge_status({**config,'token':'wrong'})['state'],'authentication-error')
            self.assertNotIn('private prompt',json.dumps(report))
        finally:server.shutdown();server.server_close();thread.join()

    def test_hook_diagnostics_counts_only_this_products_sender_and_never_claims_trust(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);path=root/'config.json';config=settings.configure(path,project=root)
            with patch.object(settings,'ROOT',root):settings.prepare_hooks(root,path)
            self.assertEqual(setup.hook_status(config),{'state':'configured','configuredEvents':8,'trust':'not-checked'})

    def test_serial_ports_classify_connection_type_without_claiming_device_or_direction(self):
        result=setup.classify_ports([{'Name':'Generic serial (COM12)','PNPDeviceID':'USB\\VID_1'},
              {'Name':'Serial port (COM4)','PNPDeviceID':'BTHENUM\\something'},{'Name':'not a port','PNPDeviceID':'USB'}])
        self.assertEqual([(p['port'],p['kind']) for p in result],[('COM4','bluetooth'),('COM12','usb')])
        self.assertFalse(any('direction' in p or 'device' in p for p in result))

    def test_skill_installs_location_and_refuses_to_overwrite_a_custom_skill(self):
        with tempfile.TemporaryDirectory() as folder:
            dest=Path(folder)/'stickc-setup';setup.install_skill(dest);setup.install_skill(dest)
            record=json.loads((dest/'references/installation.json').read_text())
            self.assertEqual(Path(record['productRoot']),ROOT)
            (dest/'SKILL.md').write_text('custom')
            with self.assertRaises(settings.SetupError):setup.install_skill(dest)
            self.assertEqual((dest/'SKILL.md').read_text(),'custom')

    def test_cli_configuration_does_not_start_services_install_tools_or_write_hooks(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);config=root/'config.json'
            with patch.object(setup,'prepare_dependencies') as prepare,patch.object(setup,'run') as run,contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(setup.main(['--config',str(config),'configure','--project',str(root)]),0)
            prepare.assert_not_called();run.assert_not_called();self.assertFalse((root/'.codex').exists())
            self.assertNotIn(settings.read_config(config)['token'],stdout.getvalue())

    def test_cli_setup_prepares_hooks_without_running_a_server(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);config=root/'config.json'
            with patch.object(setup,'prepare_dependencies') as prepare,patch.object(setup,'run') as run,patch.object(settings,'ROOT',root),contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(setup.main(['--config',str(config),'setup','--project',str(root)]),0)
            prepare.assert_called_once();run.assert_not_called();self.assertTrue((root/'.codex/hooks.json').is_file())

    def test_cli_errors_do_not_include_invalid_private_config(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);path=root/'config.json';secret='CONFIDENTIAL INVALID TOKEN';path.write_text(json.dumps({'token':secret,'port':1}))
            with contextlib.redirect_stderr(io.StringIO()) as output:
                code=setup.main(['--config',str(path),'configure','--project',str(root)])
            self.assertEqual(code,1);self.assertNotIn(secret,output.getvalue())

if __name__=='__main__':unittest.main()
