# M5StickC Plus2 USB版

Webシミュレータと同じ`vibe-remote/compact-ui/CompactUi.cpp`を、LVGL 7.11.0とM5Unifiedで実機に載せます。
LCDは135×240、Aで決定、Bで一覧／戻る、C短押しで循環選択。本文は自動スクロールします。
本体のC（GPIO35）はM5Unified上では`BtnPWR`として取得します。`BtnC`は使用しません。
新しい実機用wrapperです。旧共有`m5stickc-client`の画面やWi-Fiコードは使用しません。

対象は**M5StickC Plus2のみ**です。USBシリアル機器の型番では本体を識別できません。
初代StickC／Plus／T-Watch用に、この環境を書き込まないでください。

## 書き込み

Productルートで実行します。Pythonとインターネット接続が必要です。
ツールは`.gar/firmware-tools`と`~/.cache/gar-stickc`に隔離し、既存のPlatformIO設定と分離します。

```powershell
python scripts/firmware.py build
python scripts/setup_remote.py ports
python scripts/firmware.py identify --port COM6
python scripts/firmware.py backup --port COM6 --model m5stickc-plus2
python scripts/firmware.py flash --port COM6 --model m5stickc-plus2
```

COM6は例です。`ports`で実際にUSBとして表示されるポートを指定します。
バックアップは8MB全体を読み出し、`artifacts/firmware/日時`へサイズとSHA256を記録します。
既存アプリの内容を含むためGitには入れません。書き込みでは既存アプリを置き換えます。

## USBで画面・ボタン・往復通信を確認

```powershell
.\.gar\firmware-tools\Scripts\python.exe scripts/serial_demo.py --port COM6
```

3つの試験用セッションをPCから実機へ送り、実際のボタン操作をPCで受信します。
この端末を開いたまま、CでYES／NOを選び、Aで決定してください。PCに`event: answer`と
`source: m5stickc-plus2-usb`が出て、実機に受信確認が出れば往復できています。
Bで一覧、Cで次、Aで切り替えも確認します。質問はすべて試験用で、Codexの操作承認には使いません。
停止はCtrl+C。停止後8秒で実機の接続表示が切り替わり、回答は送れなくなります。

USB通信は115200bps、UTF-8の改行区切りJSONです。パケットは64KiBまで。
`hello`／`ping`で8秒の接続期限を更新し、`sessions`／`state`／`ack`を共有UIへ渡します。
`snapshot`を送ると画面の論理状態を返します。回答は共有UIが生成する`uiAction`に
実機由来の`source`を付けて返します。PCはセッション・質問・回答IDを照合してackを返します。

BLE通信と実Codexセッションへの接続は、まだこのUSB試験版の範囲外です。
シミュレータ用のHTTPサーバや、以前のBluetooth中継を起動する必要はありません。
