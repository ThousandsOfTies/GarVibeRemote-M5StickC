# M5StickC Plus2 SPP／USB版

Webシミュレータと同じ`vibe-remote/compact-ui/CompactUi.cpp`を、LVGL 7.11.0とM5Unifiedで実機に載せます。
Bluetooth Classic SPP（`GarVibe-M5StickC-Plus2`）とUSBシリアルを使用します。BLE／Wi-Fiは使用しません。
ペアリング・PC中継・独立した往復試験は[SPP／USB接続ガイド](../../docs/DEVICE_CONNECTION.md)を参照してください。
LCDは135×240、Aで決定、Bで一覧／戻る、C短押しで循環選択。本文は自動スクロールします。
状態の外枠は液晶端から2px内側の4px幅です。入力待ちは赤、実行中は緑、待機時はグレーです。
セッション名も、枠と同じ赤・緑・グレーの背景と黒文字で表示します。一覧も同じ配色です。
本体のC（GPIO35）はM5Unified上では`BtnPWR`として取得します。`BtnC`は使用しません。
新しい実機用wrapperです。旧共有`m5stickc-client`の画面やWi-Fiコードは使用しません。

対象は**M5StickC Plus2のみ**です。USBシリアル機器の型番では本体を識別できません。
初代StickC／Plus／T-Watch用に、この環境を書き込まないでください。

## 現行のコード構成

| ファイル | 責務 |
| --- | --- |
| `src/main.cpp` | M5Unified・LVGL・USB／SPPの接続、ペアリングの通知とメインループ |
| `include/DeviceLink.h` | JSON Linesの組み立て、USB／SPPの操作権、8秒の接続期限。ハードウェアAPIは持たない |
| `include/PairingConsent.h` | 番号照合の確認・拒否・認証・30秒の期限。Bluetooth APIは持たない |
| Productの`sources/gar-vibe-ui/vibe-remote/compact-ui/` | 画面描画・スクロール・セッション切替・A／B／C操作。実機とWASMで共通 |
| `scripts/shared_ui.py` | ビルド時に共有UI・フォント・LVGL設定を参照するためのパス設定 |

この実機の描画・操作は共有UIへ、通信のフレーム処理と確認状態は独立した部品へ分けています。
共有Appの`m5stickc-client/src/main.cpp`は旧Wi-Fi版で、このビルドからは参照しません。
実機を更新せずに部品を検証する場合は、Productの`tests/device_link.cpp`と`tests/ui.test.mjs`を使います。

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

USB通信は115200bps、SPPも同じUTF-8の改行区切りJSONです。パケットは64KiBまで。
`hello`で通信方式ごとに操作権を取得し、`ping`で8秒の接続期限を更新します。
`sessions`／`state`／`ack`を共有UIへ渡します。SPPは16KiBの受信バッファを持ち、BluetoothタスクではJSONやLVGLを処理しません。
先に接続したUSB／SPPの一方だけが操作できます。`goodbye`・SPP切断・期限切れで操作権を解放します。
`snapshot`を送ると画面の論理状態を返します。回答は共有UIが生成する`uiAction`に
実機由来の`source`を付けて返します。PCはセッション・質問・回答IDを照合してackを返します。

`deviceInfo`の`protocol: gar-compact-v1`、`sppReady`、`activeTransport`で起動状態を確認できます。
ペアリングはSSPの6桁番号照合です。Plus2でCでYESを選び、Aで決定します。未確認・30秒の時間切れでは許可しません。
`pairingMode`／`pairingState`／`authenticationAttempts`／`lastAuthentication`はUSBの`deviceInfo`・`snapshot`で確認できます。
Bluetoothコールバックは認証要求と結果を通知するだけで、画面と確認操作はメインタスクで処理します。
PCトークンはデバイス中継内で使うため、ファームウェアへ埋め込みません。
BLEは未実装です。シミュレータ用のHTTPサーバや、旧T-WatchのBluetooth中継は使いません。
