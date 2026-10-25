#!/usr/bin/env python3
"""Prepare the M5StickC PC bridge. Static HTTP, device transport and setup are separate."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
APP=ROOT/'sources/gar-vibe-ui/vibe-remote'
CONFIG=ROOT/'artifacts/connection/local.json'
RUNTIME=ROOT/'.gar/connection-node'
spec=importlib.util.spec_from_file_location('remote_config',ROOT/'scripts/remote_config.py')
settings=importlib.util.module_from_spec(spec);spec.loader.exec_module(settings)
SetupError=settings.SetupError

def source_hash():
    digest=hashlib.sha256()
    files=[APP/'src'/name for name in ('codexBridge.ts','codexInteraction.ts','codexStatus.ts','protocol.ts')]
    files+=[ROOT/'config/connection-node/package-lock.json']
    for path in files:digest.update(path.name.encode());digest.update(path.read_bytes())
    return digest.hexdigest()

def runtime_ready():
    try:
        return (RUNTIME/'codexBridge.cjs').is_file() and (RUNTIME/'node_modules/ws/package.json').is_file() and json.loads((RUNTIME/'build.json').read_text())['sourceHash']==source_hash()
    except (OSError,ValueError,KeyError):return False

def run(command,*,cwd=ROOT,capture=False):
    result=subprocess.run([str(x) for x in command],cwd=cwd,capture_output=capture,text=capture,encoding='utf-8' if capture else None)
    if result.returncode:raise SetupError(f'処理が完了しませんでした（終了コード {result.returncode}）。')
    return result

def prepare_dependencies():
    if not (APP/'src/codexBridge.ts').is_file():
        git=shutil.which('git')
        if not git:raise SetupError('Gitが必要です。')
        run([git,'submodule','update','--init','--recursive'])
    node,npm=shutil.which('node'),shutil.which('npm')
    if not node or not npm:raise SetupError('Node.jsとnpmが必要です。')
    version=run([node,'--version'],capture=True).stdout.strip()
    if int(version.lstrip('v').split('.')[0])<24:raise SetupError('Node.js 24以降が必要です。')
    RUNTIME.mkdir(parents=True,exist_ok=True)
    for name in ('package.json','package-lock.json'):shutil.copyfile(ROOT/'config/connection-node'/name,RUNTIME/name)
    run([npm,'ci','--omit=dev','--no-audit','--no-fund'],cwd=RUNTIME)
    build=("require(process.argv[1]).buildSync({entryPoints:[process.argv[2]],outfile:process.argv[3],"
           "nodePaths:[process.argv[4]],alias:{ws:process.argv[4]+'/ws'},bundle:true,"
           "platform:'node',format:'cjs',target:'node24',logLevel:'info'})")
    run([node,'-e',build,RUNTIME/'node_modules/esbuild',APP/'src/codexBridge.ts',RUNTIME/'codexBridge.cjs',RUNTIME/'node_modules'])
    (RUNTIME/'build.json').write_text(json.dumps({'sourceHash':source_hash()})+'\n',encoding='utf-8')

def classify_ports(items):
    result=[]
    for item in items:
        name=item.get('Name') or '';match=re.search(r'\((COM[1-9][0-9]*)\)',name,re.I)
        if not match:continue
        identity=(item.get('PNPDeviceID') or '').upper()
        kind='bluetooth' if identity.startswith('BTHENUM\\') else 'usb' if identity.startswith('USB\\') else 'other'
        result.append({'port':match[1].upper(),'kind':kind,'name':name})
    return sorted(result,key=lambda x:int(x['port'][3:]))

def serial_ports():
    if os.name!='nt':return [],'Windows以外ではポートを手元で確認してください。'
    shell=shutil.which('powershell.exe')
    if not shell:return [],'PowerShellが見つかりません。'
    query=("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); "
           "@(Get-CimInstance Win32_PnPEntity -Filter \"PNPClass='Ports'\" | "
           "Where-Object {$_.ConfigManagerErrorCode -eq 0} | Select-Object Name,PNPDeviceID) | ConvertTo-Json -Compress")
    try:
        result=subprocess.run([shell,'-NoProfile','-NonInteractive','-Command',query],capture_output=True,text=True,encoding='utf-8',timeout=20)
        if result.returncode:return [],'Windowsからポート一覧を取得できませんでした。'
        rows=json.loads(result.stdout.lstrip('\ufeff') or '[]')
        return classify_ports(rows if isinstance(rows,list) else [rows]),None
    except (OSError,ValueError,subprocess.TimeoutExpired):return [],'ポート一覧を取得できませんでした。'

def bridge_status(config):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req=urllib.request.Request(f"http://127.0.0.1:{config['port']}/state",headers={'Authorization':'Bearer '+config['token']})
    try:
        with opener.open(req,timeout=1) as response:envelope=json.load(response)
        current=envelope.get('state') if isinstance(envelope,dict) else None
        if not isinstance(current,dict):return {'state':'error'}
        session=current.get('session') or {}
        if not isinstance(session,dict):return {'state':'error'}
        return {'state':'reachable','sessionMatches':session.get('id')==config.get('sessionId')}
    except urllib.error.HTTPError as error:return {'state':'authentication-error' if error.code in (401,403) else 'error'}
    except (OSError,ValueError,urllib.error.URLError):return {'state':'offline'}

def hook_status(config):
    project=Path(config.get('codexCwd') or ROOT);path=project/'.codex/hooks.json'
    if not path.exists():return {'state':'missing','configuredEvents':0,'trust':'not-checked'}
    try:
        doc=json.loads(path.read_text(encoding='utf-8-sig'));events=doc.get('hooks',{})
        count=sum(any(settings.owns_command(entry.get('command',''),APP/'scripts/codex-hook.py')
                      for group in events.get(event,[]) for entry in group.get('hooks',[])) for event in settings.EVENTS)
        return {'state':'configured' if count==len(settings.EVENTS) else 'incomplete','configuredEvents':count,'trust':'not-checked'}
    except (OSError,ValueError,AttributeError,TypeError):return {'state':'invalid','configuredEvents':0,'trust':'not-checked'}

def doctor(path):
    ports,note=serial_ports()
    report={'python':sys.version.split()[0],'node':bool(shutil.which('node')),'npm':bool(shutil.which('npm')),
            'git':bool(shutil.which('git')),'application':(APP/'src/codexBridge.ts').is_file(),
            'bridgeBuilt':runtime_ready(),'ports':ports,'portNote':note,
            'deviceFirmware':'usb-test-source','deviceTransport':'usb-serial','bleTransport':'not-implemented','simulator':'local-mock',
            'deviceInput':'not-checked'}
    if not path.exists():report['config']='missing'
    else:
        try:
            config=settings.read_config(path)
            report.update(config='ready',selectedSession=bool(config.get('sessionId')),
                          bridge=bridge_status(config),hooks=hook_status(config))
        except SetupError:report['config']='invalid'
    return report

def install_skill(destination):
    source=ROOT/'skills/stickc-setup';files=[Path('SKILL.md'),Path('agents/openai.yaml')]
    if destination.exists() and any(destination.iterdir()):
        if any(not (destination/name).is_file() or (destination/name).read_bytes()!=(source/name).read_bytes() for name in files):
            raise SetupError('同名のスキルが存在します。上書きせず内容を確認してください。')
    for name in files:
        target=destination/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,target)
    reference=destination/'references/installation.json';reference.parent.mkdir(parents=True,exist_ok=True)
    reference.write_text(json.dumps({'productRoot':str(ROOT.resolve())},ensure_ascii=False)+'\n',encoding='utf-8')

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,default=CONFIG)
    commands=parser.add_subparsers(dest='command',required=True)
    for name in ('doctor','ports','prepare','bridge','test'):commands.add_parser(name)
    for name in ('configure','setup'):
        sub=commands.add_parser(name);sub.add_argument('--project',type=Path,required=True)
        sub.add_argument('--session-id');sub.add_argument('--label');sub.add_argument('--port',type=int)
        sub.add_argument('--import-config',type=Path)
        if name=='setup':sub.add_argument('--replace-product',type=Path)
    sub=commands.add_parser('hooks');sub.add_argument('--project',type=Path,required=True);sub.add_argument('--replace-product',type=Path)
    sub=commands.add_parser('install-skill');sub.add_argument('--destination',type=Path,default=Path.home()/'.agents/skills/stickc-setup')
    args=parser.parse_args(argv)
    try:
        if args.command=='doctor':print(json.dumps(doctor(args.config),ensure_ascii=False,indent=2))
        elif args.command=='ports':
            ports,note=serial_ports();print(json.dumps({'ports':ports,'note':note},ensure_ascii=False,indent=2))
        elif args.command=='prepare':prepare_dependencies();print('PCブリッジの実行環境を準備しました。')
        elif args.command=='install-skill':install_skill(args.destination);print('stickc-setupスキルを配置しました。')
        elif args.command in ('configure','setup'):
            if args.command=='setup':prepare_dependencies()
            settings.configure(args.config,project=args.project,session=args.session_id,label=args.label,port=args.port,import_config=args.import_config)
            if args.command=='setup':
                settings.prepare_hooks(args.project,args.config,replace_product=args.replace_product)
                print('Hook定義を準備しました。Codex側でレビュー・信頼してください。')
            print('PC接続設定を準備しました（トークン非表示）。USB実機試験は実機版ガイドを確認してください。')
        elif args.command=='hooks':
            settings.prepare_hooks(args.project,args.config,replace_product=args.replace_product)
            print('Hook定義を準備しました。Codex側でレビュー・信頼してください。')
        else:
            node=shutil.which('node')
            if not node or not runtime_ready():raise SetupError('prepareでNode.jsの実行環境を先に準備してください。')
            if args.command=='test':run([node,ROOT/'scripts/connection_test.cjs',RUNTIME])
            else:
                settings.read_config(args.config)
                run([node,RUNTIME/'codexBridge.cjs','--config',args.config.resolve()])
    except KeyboardInterrupt:return 130
    except SetupError as error:print(str(error),file=sys.stderr);return 1
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError):
        print('処理できませんでした。導入ガイドとdoctorの結果を確認してください（秘密の値は非表示）。',file=sys.stderr);return 1
    return 0

if __name__=='__main__':
    for stream in (sys.stdout,sys.stderr):
        if hasattr(stream,'reconfigure'):stream.reconfigure(encoding='utf-8')
    raise SystemExit(main())
