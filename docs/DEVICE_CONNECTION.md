# Plus2とPCをSPP／USBでつなぐ

対象はM5StickC Plus2です。T-Watchの構成を参考に、Bluetooth Classic SPPの仮想COMポートで接続します。
USBシリアルも同じファームウェア・メッセージ形式で使用できます。BLEは未実装です。

```mermaid
flowchart LR
    Hook[Codex Hook] -->|HTTP /events| Status[PC状態ブリッジ]
    Status <-->|認証付きWebSocket| Device[device_bridge.cjs]
    Device <-->|Bluetooth SPP または USB / JSON Lines| Plus2[Plus2 / CompactUi / LVGL]
```

状態ブリッジは従来どおりPCのlocalhostで動きます。デバイス中継はCOMポートへの接続と形式変換だけを担当し、
HTTPサーバ・シミュレータ・Hook変更・ペアリングを行いません。PC用の接続トークンはPC内で使い、実機へ送信・保存しません。

## 1. ファームウェアとペアリング

[実機ガイド](../firmware/stickc-plus2/README.md)に沿って、Plus2をUSB接続して書き込みます。
Windowsの「設定 → Bluetoothとデバイス → デバイスの追加 → Bluetooth」で
**GarVibe-M5StickC-Plus2**を追加します。PCとPlus2に表示された**6桁の番号**を比較してください。
番号が同じなら、Plus2でCを押してYESを選び、Aで決定します。PC側でも接続を確定します。
番号が違う、または意図しない要求ならNOを選びます。30秒以内に完了しなければ中止します。
固定PIN `1234`は使いません。旧版で失敗した登録がWindowsに残っている場合は、そのPlus2の登録を削除してから追加し直します。
USBの中継が画面を操作している間は新しいペアリングを受け付けないので、中継を止めてから登録します。

「Bluetoothのその他の設定 → COMポート」で、この名前に対応する**発信ポート**を確認してください。
COM番号はPCごとに異なります。旧T-WatchのCOM3／COM4や、USBのCOM6を流用して判断しません。
`python scripts/setup_remote.py ports`はUSB／Bluetoothの分類を表示しますが、機種や発信方向までは判定しません。

## 2. 実機との独立した接続試験

Productルートで実行します。`COM_NUMBER`は確認した発信COM番号に置き換えます。

```powershell
python scripts/setup_remote.py prepare
python scripts/setup_remote.py device-test --port COM_NUMBER --transport spp
```

一時的なPC状態ブリッジを起動し、「実行中」から「入力待ち」への変化を実機から読み戻して検証します。
CでYES／NOを選び、Aで決定するとPC側に回答が返ります。試験は最大60秒で終了します。
`deviceInput: received`と`source: m5stickc-plus2-spp`が、SPP経由の実機入力を受けた証拠です。
`deviceInput: not-checked`は表示・接続だけの確認で、物理ボタン入力を確認したことにはなりません。
この試験は保存済みの接続設定・Hook・稼働中ブリッジを変更せず、回答を操作承認として扱いません。

USBで同じ試験をする場合は、USBのCOM番号と`--transport usb`を指定します。
USBとSPPの中継を同時に起動しないでください。実機は先に接続した側だけに操作権を渡し、もう一方へ`busy`を返します。
USBケーブルを給電用に挿しておくだけならSPP接続を妨げません。

## 3. 監視中のCodexへ接続

[PC導入ガイド](INSTALL.md)で設定とHookを準備し、状態ブリッジを起動してから中継します。

```powershell
# それぞれ別の端末で実行
python scripts/setup_remote.py bridge
python scripts/setup_remote.py device --port COM_NUMBER --transport spp
```

保存済み設定は`artifacts/connection/local.json`です。旧ブリッジを継続使用する場合は、
そのブリッジと同じトークン・ポートの設定ファイルを`--config PATH`で指定できます。
既存プロセスやHookを変更せず、読み取り用のクライアントとして接続します。

```powershell
python scripts/setup_remote.py --config "PRIVATE_CONFIG_PATH" device --port COM_NUMBER --transport spp
```

現在のCodexブリッジは**選択した1セッション**の状態を配信します。未選択の場合は直近に観測したセッションです。
中継は毎回、正しいセッションIDを付けた`sessions`全件スナップショットへ変換します。
過去の状態を別セッションとして溜めたり、切り替わる前の質問へ回答したりしません。
実セッション一覧の自動収集は別の対応です。シミュレータやUSBの複数セッション試験は従来どおり使えます。

既存ブリッジの質問・接続試験のYES／NOは返信できます。導入支援は監視用Hookを生成し、実行承認を有効化しません。
長押しを要求する既存の承認UIは短押しAで承認せず、「PCで承認してください」と表示します。
Copilot監視や旧T-Watchのファームウェア／対話設定は取り込みません。

## 通信と再接続

実機と同時にWebシミュレータへ本番データを表示する場合は、HTTP配信とは別のプロセスを起動します。

```powershell
python scripts/simulate.py --port 8772
# 別の端末:
python scripts/setup_remote.py simulator-feed
# http://127.0.0.1:8772/?live=1 を開く
```

`simulator-feed`はlocalhost:8775の閲覧専用WebSocketで、8772のページからの接続だけを受け付けます。
トークンはPC内で使い、配信ファイル・URL・ブラウザには渡しません。実機のSPP中継と同時に状態を購読できます。
本番表示のAは回答を送らず、PC側の中継もブラウザからのメッセージを転送しません。
本番へのYES／NOは実機から行います。通常のURLは従来の模擬試験です。
ポートを変える場合は`simulator-feed --port PORT --panel-port HTTP_PORT`と、URLの`livePort=PORT`を対応させます。

- USBもSPPもUTF-8のJSON Linesです。改行を除き1行64KiBまで。受信の区切りが日本語の途中でも処理します。
- `hello` → `deviceInfo`で機種・画面・プロトコル・通信方式を確認してから状態を送ります。
- `state`／`sessions`は状態、`uiAction`は回答、`ack`はセッション・質問・回答ID付きの受領確認です。
- 2秒ごとの`ping`と8秒の接続期限を使います。SPP切断や`goodbye`では即座に操作権を解放します。
- 定期的な`hello`／`deviceInfo`で実機の応答と操作権も確認し、途中の再起動・接続期限切れから復帰します。
- PCブリッジへの接続が切れた場合は、実機にも切断を伝えます。COM・WebSocketは3秒間隔で再接続します。
- 再接続では最新状態を取り直します。古い回答は自動再送せず、受領不明ならPCで確認してから選び直します。
- `snapshot`はUSBから状態を読むためにも使用でき、SPPの操作権を奪いません。

`serial-open-failed`は発信COM番号・ペアリング・他の中継の使用状況を確認します。
`device-busy`は別のUSB／SPP中継が操作中、`wrong-device`は機種またはファームウェアの不一致です。
ログには接続トークンや質問本文を出しません。
