"""Private PC settings and hook files. No process startup or device operations."""
from __future__ import annotations
import copy
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'sources/gar-vibe-ui/vibe-remote'
PANEL = ROOT / 'simulation'
EVENTS = ('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
          'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd')

class SetupError(Exception):
    """An actionable message containing no private values."""

def private_path(path: Path) -> Path:
    path = path.resolve()
    if path.is_relative_to(PANEL.resolve()):
        raise SetupError('接続設定は公開用simulationフォルダーの外へ保存してください。')
    return path

def read_config(path: Path) -> dict:
    private_path(path)
    try:
        config = json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        raise SetupError('接続設定を読み込めません。値を表示せず、設定ファイルを確認してください。') from None
    if not isinstance(config, dict):
        raise SetupError('接続設定の形式が不正です。')
    token, port, session = config.get('token'), config.get('port'), config.get('sessionId')
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', token):
        raise SetupError('接続トークンの形式が不正です（値は表示しません）。')
    if type(port) is not int or not 1 <= port <= 65535:
        raise SetupError('接続ポートは1〜65535で指定してください。')
    if session is not None and (not isinstance(session, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', session)):
        raise SetupError('セッションIDの形式が不正です。')
    if config.get('sessionScope','single') not in ('single','project','local','manual'):
        raise SetupError('セッション監視範囲の形式が不正です。')
    if config.get('sessionScope')=='manual' and (not isinstance(config.get('sessionIds'),list) or
            not 1<=len(config['sessionIds'])<=16 or
            any(not isinstance(s,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',s) for s in config['sessionIds']) or
            len(set(config['sessionIds']))!=len(config['sessionIds'])):
        raise SetupError('指定チャットは重複しないIDを1〜16個設定してください。')
    return config

def configure(path: Path, *, project: Path, session=None, label=None, port=None, import_config: Path | None=None, chat_questions=None, session_scope=None, session_ids=None) -> dict:
    path = private_path(path)
    if not project.is_dir():
        raise SetupError('監視するプロジェクトのフォルダーが存在しません。')
    previous = read_config(path) if path.exists() else {}
    if import_config:
        imported = read_config(import_config)
        if previous and previous['token'] != imported['token']:
            raise SetupError('移行元と移行先のトークンが異なります。既存の設定は上書きしていません。')
        # Transfer PC connection facts only. Never inherit an old device's COM
        # port, interactive approval flag, credentials path or firmware settings.
        previous = {**{k: imported[k] for k in ('token','port','sessionId','label','freshnessMs') if k in imported}, **previous}
    config = {**previous, 'product':'GarVibeRemote-M5StickC', 'codexCwd':str(project.resolve()),
              'port':port if port is not None else previous.get('port',39275),
              'sessionId':session if session is not None else previous.get('sessionId'),
              'label':label if label is not None else previous.get('label','M5StickC'),
              'freshnessMs':previous.get('freshnessMs',90000), 'watchInput':False,
              'chatQuestions':chat_questions if chat_questions is not None else previous.get('chatQuestions',False)}
    config['chatQuestionSources']=['m5stickc-plus2-spp','m5stickc-plus2-usb']
    config['sessionScope']=session_scope if session_scope is not None else previous.get('sessionScope','single')
    if session_ids is not None:config['sessionIds']=session_ids
    if config['sessionScope'] not in ('single','project','local','manual'):
        raise SetupError('セッション監視範囲はsingle・project・local・manualで指定してください。')
    if config['sessionScope']!='single' and not config['sessionId']:
        raise SetupError('複数セッションの監視には起動元チャットIDを指定してください。')
    if config['sessionScope']=='manual' and (not isinstance(config.get('sessionIds'),list) or
            not 1<=len(config['sessionIds'])<=16 or
            any(not isinstance(s,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',s) for s in config['sessionIds']) or
            len(set(config['sessionIds']))!=len(config['sessionIds'])):
        raise SetupError('指定チャットは重複しないIDを1〜16個設定してください。')
    for key in ('sppPort','sppBaudRate','firmware','firmwarePath','deviceTransport'):
        config.pop(key,None)
    config.setdefault('token',secrets.token_urlsafe(32))
    if type(config['port']) is not int or not 1 <= config['port'] <= 65535:
        raise SetupError('接続ポートは1〜65535で指定してください。')
    if config['sessionId'] is not None and (not isinstance(config['sessionId'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',config['sessionId'])):
        raise SetupError('セッションIDの形式が不正です。')
    if not isinstance(config['label'],str) or len(config['label'])>120 or any(ord(c)<32 for c in config['label']):
        raise SetupError('作業名は改行なしの120文字以内で指定してください。')
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    if os.name!='nt':path.chmod(0o600)
    return config

def normalized(path) -> str:
    value = str(path).replace('\\','/')
    return value.casefold() if os.name=='nt' else value

def owns_command(command: str, sender: Path) -> bool:
    # Exact path token (quoted or unquoted), not a substring/basename match.
    value, needle = normalized(command), normalized(sender.resolve())
    if re.search(r'(?<![^\s\"\'])'+re.escape(needle)+r'(?=$|[\s\"\'])',value):return True
    # Windows paths in existing commands may use short 8.3 names. Resolve each
    # complete argument so relocating a Product does not leave its old sender.
    for quoted, single, plain in re.findall(r'"([^"]*)"|\'([^\']*)\'|(\S+)',str(command)):
        token=quoted or single or plain
        if not token.endswith('.py'):continue
        try:
            if normalized(Path(token).resolve())==needle:return True
        except (OSError,ValueError):continue
    return False

def prepare_hooks(project: Path, config_path: Path, *, replace_product: Path | None=None) -> Path:
    if not project.is_dir():raise SetupError('監視するプロジェクトのフォルダーが存在しません。')
    config = read_config(config_path)
    if config.get('watchInput'):
        raise SetupError('導入支援のHookは監視専用です。watchInputを無効にした監視用設定を使用してください。')
    sender = APP / 'scripts/codex-hook.py'
    if not sender.is_file():raise SetupError('共有Appがありません。prepareを実行してください。')
    path = project.resolve()/'.codex/hooks.json'
    try:doc=json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else {}
    except (OSError,ValueError):raise SetupError('既存のHook設定を読み込めません。上書きしていません。') from None
    if not isinstance(doc,dict) or not isinstance(doc.get('hooks',{}),dict):
        raise SetupError('既存のHook設定の形式が不正です。上書きしていません。')
    original=copy.deepcopy(doc)
    senders=[sender]
    if replace_product:
        legacy=replace_product.resolve()/'sources/gar-vibe-ui/vibe-remote/scripts/codex-hook.py'
        if not legacy.is_file():raise SetupError('置換元Productの送信スクリプトが見つかりません。')
        senders.append(legacy)
    args=[sys.executable,str(sender), '--config',str(config_path.resolve())]
    command=subprocess.list2cmdline(args) if os.name=='nt' else shlex.join(args)
    hooks=doc.setdefault('hooks',{})
    try:
        for event in EVENTS:
            groups=hooks.setdefault(event,[])
            if not isinstance(groups,list):raise TypeError()
            for group in groups:
                entries=group.get('hooks',[])
                if not isinstance(entries,list):raise TypeError()
                group['hooks']=[entry for entry in entries if not any(owns_command(entry.get('command',''),p) for p in senders)]
            groups[:]=[group for group in groups if group.get('hooks')]
            groups.append({'hooks':[{'type':'command','command':command,'timeout':3}]})
    except (AttributeError,TypeError):
        raise SetupError('既存のHook定義の形式が不正です。上書きしていません。') from None
    if doc==original:return path
    if path.exists():
        backup=ROOT/'.gar/setup-backups'/secrets.token_hex(8)/'hooks.json'
        backup.parent.mkdir(parents=True,exist_ok=True);backup.write_bytes(path.read_bytes())
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return path
