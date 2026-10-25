#!/usr/bin/env python3
"""USB-only physical UI test with three synthetic sessions; no Codex approvals."""
import argparse
import json
import secrets
import time
import sys
import serial

def encode(value):return (json.dumps(value,ensure_ascii=False)+'\n').encode('utf-8')

def examples():
    generation=secrets.token_hex(4)
    def state(id,name,status,message,actions=()):
        return {'session':{'id':id,'name':name},'ui':{'id':f'usb-test-{generation}-{id}','state':status,'message':message,'actions':list(actions)}}
    actions=[{'id':'yes','label':'YES','button':'A'},{'id':'no','label':'NO','button':'B'}]
    question='実機の画面と操作を確認するための質問です。本文はゆっくり自動スクロールします。CでYESまたはNOを選び、Aで決定してください。Bでセッション一覧を開き、Cで次のセッションへ進み、Aで切り替えます。この回答はUSB接続したPCへ返されます。今回の質問は表示と送受信の試験で、ファイルの変更や操作の許可には使いません。'
    return [state('screen','画面の試験','waiting',question,actions),
            state('running','実行中の試験','running','処理の状況を表示する試験です。緑色の枠と、実行中を表すアイコンを確認してください。'),
            state('choices','選択肢の試験','waiting','この後の進め方を選んでください。この質問も試験用です。',
                  [{'id':'continue','label':'続ける','button':'A'},{'id':'revise','label':'修正する','button':'B'},{'id':'stop','label':'中止する','button':'C'}])]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',required=True);parser.add_argument('--duration',type=float,default=0)
    args=parser.parse_args();samples=examples();by_id={s['session']['id']:s for s in samples}
    if args.duration<0:parser.error('--duration must be zero or positive')
    port=serial.Serial();port.port=args.port;port.baudrate=115200;port.timeout=.05;port.write_timeout=2
    # Do not deliberately reset the board when opening a UI test session.
    port.dtr=False;port.rts=False
    started=time.monotonic();last_ping=0;last_snapshot=0;ready=False;last_view=None;buffer=bytearray()
    def send(value):port.write(encode(value))
    try:
        port.open()
        print(json.dumps({'event':'usb-open','port':args.port,'scope':'physical-ui-test','codexConnected':False}),flush=True)
        while not args.duration or time.monotonic()-started<args.duration:
            now=time.monotonic()
            if now-last_ping>=2:send({'type':'ping' if ready else 'hello'});last_ping=now
            if ready and now-last_snapshot>=5:send({'type':'snapshot'});last_snapshot=now
            block=port.read(4096)
            if block:buffer.extend(block)
            if len(buffer)>131072:buffer.clear()
            while b'\n' in buffer:
                raw,_,rest=buffer.partition(b'\n');buffer=bytearray(rest)
                try:message=json.loads(raw.decode('utf-8'))
                except (ValueError,UnicodeError):continue
                if not isinstance(message,dict):continue
                type=message.get('type')
                if type=='deviceInfo':
                    if message.get('device')!='m5stickc-plus2' or (message.get('width'),message.get('height'))!=(135,240):
                        raise RuntimeError('Unexpected device or display dimensions')
                    if message.get('protocol')=='gar-compact-v1' and message.get('activeTransport')!='usb-serial':continue
                    print(json.dumps({'event':'device-ready',**message}),flush=True)
                    # Also restore the trial after the device reboots on the
                    # same USB port. Repeated snapshots retain UI focus/scroll.
                    send({'type':'sessions','sessions':samples});ready=True
                elif type=='busy':
                    raise RuntimeError('Another USB/SPP controller owns the display; stop that relay first')
                elif type=='uiAction':
                    s=by_id.get(message.get('sessionId'));actions=s['ui']['actions'] if s else []
                    valid=bool(s and s['ui']['id']==message.get('uiId') and any(a['id']==message.get('actionId') for a in actions))
                    send({'type':'ack','sessionId':message.get('sessionId'),'uiId':message.get('uiId'),
                          'actionId':message.get('actionId'),'ok':valid})
                    print(json.dumps({'event':'answer','sessionId':message.get('sessionId'),'answer':message.get('actionId'),
                                      'source':message.get('source'),'accepted':valid,'scope':'physical-ui-test'}),flush=True)
                elif type=='button':
                    print(json.dumps({'event':'button','button':message.get('button'),'phase':message.get('phase')}),flush=True)
                elif type=='snapshot':
                    view={key:message.get(key) for key in ('sessionId','state','listOpen','listFocus','choice','pending','acknowledged','connected','scrollPixels')}
                    if view!=last_view:print(json.dumps({'event':'view',**view}),flush=True);last_view=view
            if not ready and now-started>12:raise RuntimeError('Device did not respond to USB handshake')
    except KeyboardInterrupt:return 0
    except (serial.SerialException,RuntimeError,OSError) as error:print(f'USB test failed: {error}',file=sys.stderr);return 1
    finally:
        if port.is_open:
            try:send({'type':'goodbye'});port.flush()
            except (serial.SerialException,OSError):pass
        port.close()
    return 0

if __name__=='__main__':raise SystemExit(main())
