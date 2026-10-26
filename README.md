# GarVibeRemote-M5StickC

M5StickC Plus2の小さな画面と物理ボタンで、エージェントの状態確認とYES／NO回答を行うProductです。
**Webシミュレータ、Bluetooth Classic SPP／USBの実機版、PC側の導入支援があります。BLEは未実装です。**

Plus2実機への書き込みとUSBでの操作確認は[実機版ガイド](firmware/stickc-plus2/README.md)を参照してください。
実機版も同じLVGL画面・自動スクロール・セッション一覧・C／Aの選択と決定を使用します。

PC側の準備・設定生成・Hook登録・診断は[Windows導入ガイド](docs/INSTALL.md)、
実機とのペアリング・中継・送受信試験は[SPP／USB接続ガイド](docs/DEVICE_CONNECTION.md)を参照してください。
`python scripts/setup_remote.py prepare`で準備し、`test`でPC内の送受信を確認できます。
`install-skill`で`$stickc-setup`を配置できます。Copilot監視は移植していません。

## 試す

Python 3.10以上、Node.js、Emscriptenが必要です。cloneには共有リポジトリへのアクセス権が必要です。

```powershell
git clone --recurse-submodules https://github.com/ThousandsOfTies/GarVibeRemote-M5StickC.git
cd GarVibeRemote-M5StickC
# Emscriptenを有効にした環境で一度ビルド
python scripts/build.py
# WSLにEmscriptenを用意してあるWindowsでは代わりに:
# python scripts/build.py --wsl Ubuntu-26.04
python scripts/simulate.py --port 8772
```

[シミュレータを開く](http://127.0.0.1:8772/)。UIソース変更後は再ビルドしてページを再読み込みします。
実機と同じCodexの本番状態を表示する場合は、別端末で`python scripts/setup_remote.py simulator-feed`を起動し、
[本番表示](http://127.0.0.1:8772/?live=1)を開きます。閲覧専用で、回答は実機から行います。
接続トークンはPC内の中継だけで使います。試験データの画面は通常のURLで引き続き使用できます。
依存ライブラリは`dependencies.json`のバージョン・SHA256で検証して取得し、`.cache`へ保存します。
生成WASMは`simulation/runtime`に置き、Gitには含めません。

Emscriptenの新規導入は[公式手順](https://emscripten.org/docs/getting_started/downloads.html)を参照してください。
`--wsl`はそのWSLのPATH、または`~/.cache/gar-ui/emsdk/emsdk_env.sh`を使用します。
HTTPサーバは静的ファイルの配信だけを行います。Hookの変更や中継の起動は行いません。

## 操作

液晶は**135×240の縦向き、タッチ非対応**。画面をクリックしても回答は送信されません。
本体上のA/B/Cをマウスで押すか、ボタンにフォーカスした状態でA/B/Cキーを使います。

| 場面 | A | B | C |
| --- | --- | --- | --- |
| 本文・回答 | **選択中の回答を決定・送信** | セッション一覧を開く | 次の選択肢へ（循環） |
| セッション一覧 | **選択中のセッションへ切り替える** | 切り替えずに戻る | 次のセッションへ（循環） |

YES／NOではNOを初期選択。3つ以上の選択肢にも対応し、Cでフォーカスが一巡します。
Aは短押しして離すと決定します。質問の変更・切断・フォーカス喪失では押下を無効化します。
本文は9px/秒（日本語で約3文字/秒が目安）で縦スクロールし、先頭1.8秒・末尾2.8秒停止して繰り返します。
収まる文章は動きません。本文と独立して選択肢を固定表示します。
本文の背景は黒、枠は実行中が緑、入力待ち／エラーが赤、待機／完了がグレーです。
セッション名は枠と同じ緑・赤・グレーの背景に黒文字で表示し、一覧にも適用します。
外枠は液晶端から2px内側に4px幅で描き、実機とシミュレータで共通です。
初期画面は3つの模擬セッションです。B→C→Aで切り替えられます。
別セッションからの通知で表示は切り替わらず、一覧を閉じると読んでいた位置から再開します。
長文・短文・複数選択肢・実行中・待機中・完了・エラー、切断と再接続、受信エラーを試せます。
模擬PCの受信結果は画面右側（狭い画面では下側）で確認できます。
Cは2秒以上押して離すと電源ON、6秒以上でOFFも試せます。実機の電源動作の完全再現はしていません。

## 構成と責務

```text
simulation/adapter.mjs  ── sessions / state / ack ──▶ C++ CompactUi (WASM / LVGL 7)
    模擬PC・シナリオ    ◀──── uiAction ──────────      │ 135×240 pixels
              ▲                             ▼
              └──── 物理ボタンedge ── <gar-stickc-plus2> + canvas
```

- `sources/gar-tools/web-simulator/components/m5stickc-plus2.mjs`：再利用可能な筐体・LCD境界・物理ボタン。
- `sources/gar-vibe-ui/vibe-remote/compact-ui/`：C++によるLVGL描画、自動スクロール、セッション一覧、回答の選択と決定。
- `simulation/`：Product固有の文面・模擬PC・接続条件・画面構成。
- `scripts/simulate.py`：共通HTTPサーバへの薄い入口。
- `hardware/binding.json`：Plus2の画面・ボタン対応。

入力は既存VibeRemoteの`state`形式と、全件を渡す`sessions`形式です。
出力`uiAction`とackにはセッション・質問・回答IDを付け、別セッションの回答と照合します。
16セッション・各8選択肢まで保持できます。形式の詳細は共有Appの`compact-ui/README.md`を参照してください。
SPP／USBともID付きackと8秒の接続期限を使用します。
`scripts/device_bridge.cjs`が既存Codexブリッジの状態・回答を新画面へ接続し、切断時には再同期します。
USB実機で表示・自動スクロール・A/B/C操作・回答の往復を確認済みです。
現在のPCブリッジは選択した1セッションを配信します。実セッション一覧の自動収集と、長時間利用時の電池寿命は未対応・未確認です。
初代StickC、StickC Plusの実機互換は保証しません。

## 確認

```powershell
node --test tests/ui.test.mjs
node --test tests/device_bridge.test.cjs
node --test tests/simulator_feed.test.cjs
node --test tests/chat_questions.test.cjs
python -m unittest discover -s tests -p 'test_*.py' -v
# Emscripten有効時の通信部品テスト（生成先は.cache内）
em++ -std=c++17 -Ifirmware/stickc-plus2/include tests/device_link.cpp -sSINGLE_FILE=1 -sENVIRONMENT=node -sEXIT_RUNTIME=1 -o .cache/device-link-test.cjs
node .cache/device-link-test.cjs
# 共通部品の単体例（別ポートで起動）
python sources/gar-tools/web-simulator/serve.py --panel sources/gar-tools/web-simulator/examples/stickc-parts --port 8773
# 共通部品のブラウザ試験
python sources/gar-tools/web-simulator/serve.py --panel sources/gar-tools/web-simulator/tests/stickc-browser --port 8774
```

UI試験は実際のWASMとLVGL描画を使い、文字欠落、スクロール速度と位置保持、C／Aの選択と決定、
セッション切替、キャンセル、切断、セッション別ack、独立インスタンスを確認します。
部品単体例は縦・横の2台を独立して操作できます。Product adapterは部品のShadow DOMを参照しません。
シミュレータ起動中に`http://127.0.0.1:8772/tests/index.html`を開くと、Productのボタン入力から
模擬PCの受信確認までのブラウザ連携試験も実行できます。

ハードウェア参照：[M5Stack公式 StickC Plus2](https://docs.m5stack.com/en/core/StickC-Plus2)。
共通ソースはsubmoduleです。変更時は共有リポジトリを先にコミット・プッシュし、そのコミットをこのProductで固定します。
