# WindowsでPC側の導入を準備する

対象は **GarVibeRemote-M5StickC / M5StickC Plus2** です。旧Productの導入支援から、
PCの設定生成・Hook登録・診断・通信試験を移植しました。Copilot監視は含めていません。

PC側の設定と、[縦画面用のUSB実機試験版](../firmware/stickc-plus2/README.md)を準備できます。
**BLE通信、PCブリッジと新画面のセッション／ack契約の接続は未実装**です。
既存の共有M5StickCファームウェアはこの縦画面とは別実装なので、代わりに書き込みません。
WebシミュレータとUSB試験用の質問は、どちらも模擬セッションです。

## 最初の準備

Python 3.10以上、Node.js 24以上（npmを含む）、Gitが必要です。PC側にはWSL・Emscripten・
PlatformIO・VS Codeは不要です。以下はProductルートで実行します。

```powershell
python scripts/setup_remote.py doctor
python scripts/setup_remote.py prepare
python scripts/setup_remote.py test
python scripts/setup_remote.py install-skill
```

`prepare`は固定した依存関係を`.gar/connection-node`へ導入し、共有AppのPCブリッジをビルドします。
共有Appの開発用node_modulesやシミュレータは変更しません。
`test`の`status: passed`と`scope: pc-loopback`は、PC内の認証・状態配信・質問／回答の試験です。
仮のクライアントが回答するので、実機接続や本人の承認を意味しません。

スキルは`~/.agents/skills/stickc-setup`に配置されます。Codexで`$stickc-setup`を指定して
利用できます。旧T-Watch専用の`watch-setup`は別のスキルなので上書きしません。

## PC接続設定

`PROJECT`は監視するプロジェクトのフォルダー、`CHAT_ID`は対象チャットのIDです。
チャットのIDを指定しない場合、既存PCブリッジは受け取った最新セッションの状態を表示します。
新画面の複数セッション一覧への自動配信は、別途接続処理が必要です。

```powershell
python scripts/setup_remote.py configure --project "PROJECT" --session-id "CHAT_ID" --label "作業名"
python scripts/setup_remote.py hooks --project "PROJECT"
```

設定は`artifacts/connection/local.json`に保存します。トークンを自動生成し、再実行時も保持します。
設定にはPC側の監視先を保存し、実機用COM番号や対話的な実行承認は設定しません。
実行コマンド・ログ・Gitや公開用simulationへトークンをコピーしないでください。

`setup --project "PROJECT" ...`は`prepare`、`configure`、`hooks`をまとめて行う入口です。
サーバ起動、Web配信、信頼設定、機器書き込みは行いません。

## 旧Productの設定を移す場合

旧設定の秘密の値を表示せず、PC用のトークン・ポート・監視先・作業名だけを移します。
元の設定は変更しません。既存の移行先設定とトークンが異なれば上書きせず停止します。

```powershell
python scripts/setup_remote.py configure --project "PROJECT" --import-config "OLD_PRODUCT/artifacts/codex-bridge/local.json"
python scripts/setup_remote.py hooks --project "PROJECT" --replace-product "OLD_PRODUCT"
```

`--replace-product`を付けたときだけ、その旧Productの送信Hookを除き、新しい送信先へ置き換えます。
他のHookは保持し、変更前のファイルを`.gar/setup-backups`へ保存します。
COM番号、旧ファームウェア設定、`watchInput:true`は移行しません。

Hookを新規作成・変更した後は、監視するプロジェクトをCodexで開き、定義をレビューして信頼します。
CLIなら`codex -C "PROJECT"`から`/hooks`を使えます。設定ファイル生成だけでは実行可能になりません。
信頼記録を自動編集したりチェックを無効にしたりしません。
[公式のHookレビュー手順](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)。

## PCブリッジの起動と診断

```powershell
python scripts/setup_remote.py bridge
# 別の端末で:
python scripts/setup_remote.py doctor
python scripts/setup_remote.py ports
```

`bridge`はフォアグラウンドの独立した常駐処理です。停止は同じ端末のCtrl+Cで行います。
既存ブリッジが同じポートを使っていれば、元の処理を確認してから切り替えてください。
補助コマンドが既存の処理を停止したり、自動再起動・自動常駐したりはしません。

`doctor`は設定を変更せず、秘密の値や質問文を表示しません。
`bridge.state: reachable`は認証付きHTTPでPCブリッジを読めたことを示します。
`hooks.state: configured`は対象8イベントの送信定義があることだけを表し、
`hooks.trust: not-checked`のとおりレビュー済みかは判定しません。
`deviceFirmware`は`usb-test-source`、`deviceTransport`は`usb-serial`、`bleTransport`は
`not-implemented`です。`deviceInput: not-checked`は、この診断では物理入力を検査していないことを表します。

`ports`はWindowsのUSB／Bluetoothポートを区別して列挙する診断機能です。
COM番号だけから機種や送信方向、BLE接続の可否を判定しません。BLEはシリアルCOMと別の接続方式です。

## 診断で止まった場合

| 表示・状態 | 対応 |
| --- | --- |
| config: missing | `configure`でPC設定を作る |
| config: invalid | 値を公開せず設定を確認する。自動再生成はしない |
| bridgeBuilt: false | `prepare`で現在の共有ソースをビルドする |
| bridge.state: offline | 正しい設定で`bridge`を起動する |
| authentication-error | 起動中のブリッジとPC設定の対応を確認する |
| sessionMatches: false | 起動中の監視先が保存した設定と異なる |
| hooks.state: missing / incomplete | `hooks --project`で定義を準備し、Codexでレビューする |
| PC試験成功だが実機に表示されない | USB実機版の書き込みとserial_demoの起動を確認する。実Codexへの接続は未実装 |

旧フォルダーを削除する前に、稼働中ブリッジ、Hook、旧スキルの参照先を確認します。
この実装の移植だけでは、利用中の設定やサービスを勝手に切り替えません。
