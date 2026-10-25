#!/usr/bin/env python3
"""Build/backup/flash the fixed M5StickC Plus2 USB firmware. No Bluetooth setup."""
from __future__ import annotations
import argparse
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import venv

ROOT=Path(__file__).resolve().parents[1]
PROJECT=ROOT/'firmware/stickc-plus2'
PYTHON=ROOT/'.gar/firmware-tools'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
spec=importlib.util.spec_from_file_location('stickc_setup',ROOT/'scripts/setup_remote.py')
setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)

def environment():
    env=os.environ.copy()
    identity=hashlib.sha256(str(ROOT.resolve()).casefold().encode()).hexdigest()[:8]
    cache=Path.home()/'.cache/gar-stickc'
    env.update(PLATFORMIO_CORE_DIR=str(cache/'pio61'),PLATFORMIO_BUILD_DIR=str(cache/identity/'build'),
               PLATFORMIO_LIBDEPS_DIR=str(cache/identity/'libs'))
    return env

def toolchain():
    if not PYTHON.is_file():venv.EnvBuilder(with_pip=True).create(PYTHON.parent.parent)
    check=subprocess.run([str(PYTHON),'-c',"import platformio; assert platformio.__version__ == '6.1.19'"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if check.returncode:subprocess.run([str(PYTHON),'-m','pip','install','platformio==6.1.19'],check=True)

def usb_port(port):
    ports,_=setup.serial_ports()
    if os.name=='nt' and not any(p['port']==port.upper() and p['kind']=='usb' for p in ports):
        raise RuntimeError('指定したポートはUSB機器として確認できません。setup_remote.py portsで確認してください。')
    return port.upper() if os.name=='nt' else port

def esptool(port,*args):
    program=Path(environment()['PLATFORMIO_CORE_DIR'])/'packages/tool-esptoolpy/esptool.py'
    if not program.is_file():raise RuntimeError('先にfirmware.py buildを実行してください。')
    return [str(PYTHON),str(program),'--chip','esp32','--port',port,'--baud','921600',*map(str,args)]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('build')
    for name in ('identify','backup','flash'):
        sub=commands.add_parser(name);sub.add_argument('--port',required=True)
        if name in ('backup','flash'):sub.add_argument('--model',required=True,choices=['m5stickc-plus2'])
    args=parser.parse_args()
    try:
        if args.command!='build':args.port=usb_port(args.port)
        if args.command=='build':
            toolchain();subprocess.run([str(PYTHON),'-m','platformio','run','-d',str(PROJECT)],env=environment(),check=True)
        elif args.command=='identify':subprocess.run(esptool(args.port,'flash_id'),check=True)
        elif args.command=='backup':
            folder=ROOT/'artifacts/firmware'/datetime.now().strftime('%Y%m%d-%H%M%S')
            folder.mkdir(parents=True,exist_ok=False);target=folder/'original-flash.bin'
            subprocess.run(esptool(args.port,'read_flash','0','0x800000',target),check=True)
            if target.stat().st_size!=0x800000:raise RuntimeError('バックアップのサイズが8MBと一致しません。')
            digest=hashlib.sha256(target.read_bytes()).hexdigest()
            (folder/'backup.json').write_text(json.dumps({'model':args.model,'size':target.stat().st_size,'sha256':digest})+'\n',encoding='utf-8')
            print(f'Backup saved: {target}')
        else:
            toolchain();subprocess.run([str(PYTHON),'-m','platformio','run','-d',str(PROJECT),'-t','upload','--upload-port',args.port],env=environment(),check=True)
    except (RuntimeError,OSError,subprocess.SubprocessError) as error:
        print(f'Firmware operation failed: {error}',file=sys.stderr);return 1
    return 0

if __name__=='__main__':
    for stream in (sys.stdout,sys.stderr):
        if hasattr(stream,'reconfigure'):stream.reconfigure(encoding='utf-8')
    raise SystemExit(main())
