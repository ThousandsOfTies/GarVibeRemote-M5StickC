# GarVibeRemote-M5StickC

M5StickC Plus2の小さな画面と物理ボタンで、エージェントの状態確認とYES／NO回答を行うProductです。
**現在はWebシミュレータの初版です。BLE・実機ファームウェア・Codex接続は未実装です。**

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
依存ライブラリは`dependencies.json`のバージョン・SHA256で検証して取得し、`.cache`へ保存します。
生成WASMは`simulation/runtime`に置き、Gitには含めません。

Emscriptenの新規導入は[公式手順](https://emscripten.org/docs/getting_started/downloads.html)を参照してください。
`--wsl`はそのWSLのPATH、または`~/.cache/gar-ui/emsdk/emsdk_env.sh`を使用します。
HTTPサーバは静的ファイルの配信だけを行います。Hookの変更や中継の起動は行いません。

## 操作

液晶は**240×135の横向き、タッチ非対応**。画面をクリックしても回答は送信されません。
本体上のA/B/Cをマウスで押すか、ボタンにフォーカスした状態でA/B/Cキーを使います。

| 場面 | A | B | C |
| --- | --- | --- | --- |
| 本文を読む | 次のページ。最終ページでは回答画面へ | 前のページ | 本文の先頭へ |
| 回答を選ぶ | YES／NOの切替 | **0.9秒以上押して離すと確定** | 本文に戻る |

初期選択はNO。短押し・質問の変更・切断・フォーカス喪失では回答しません。
背景は黒、枠は実行中が緑、入力待ち／エラーが赤、待機／完了がグレーです。
長文・短文・実行中・待機中・完了・エラー、切断と再接続、受信エラーを試せます。
模擬PCの受信結果は画面右側（狭い画面では下側）で確認できます。
Cは2秒以上押して離すと電源ON、6秒以上でOFFも試せます。実機の電源動作の完全再現はしていません。

## 構成と責務

```text
simulation/adapter.mjs  ── state / ack ──▶ C++ CompactUi (WASM / LVGL 7)
    模擬PC・シナリオ    ◀── uiAction ────      │ 240×135 pixels
              ▲                             ▼
              └──── 物理ボタンedge ── <gar-stickc-plus2> + canvas
```

- `sources/gar-tools/web-simulator/components/m5stickc-plus2.mjs`：再利用可能な筐体・LCD境界・物理ボタン。
- `sources/gar-vibe-ui/vibe-remote/compact-ui/`：C++によるLVGL描画、UTF-8ページ分割、回答選択と長押し判定。
- `simulation/`：Product固有の文面・模擬PC・接続条件・画面構成。
- `scripts/simulate.py`：共通HTTPサーバへの薄い入口。
- `hardware/binding.json`：Plus2の画面・ボタン対応。

入力は既存VibeRemoteの`state`形式、出力は`uiAction`形式です。ackは質問・回答IDを照合します。
実際のPCブリッジとの接続時にはack契約と切断時の再同期処理を実装します。
マルチセッション切替、Bluetooth電波・電池寿命・実機の日本語可読性はまだ再現／確認していません。
初代StickC、StickC Plusの実機互換は保証しません。

## 確認

```powershell
node --test tests/ui.test.mjs
# 共通部品の単体例（別ポートで起動）
python sources/gar-tools/web-simulator/serve.py --panel sources/gar-tools/web-simulator/examples/stickc-parts --port 8773
# 共通部品のブラウザ試験
python sources/gar-tools/web-simulator/serve.py --panel sources/gar-tools/web-simulator/tests/stickc-browser --port 8774
```

UI試験は実際のWASMとLVGL描画を使い、文字欠落、ページ保持、長押し、キャンセル、切断、ack、独立インスタンスを確認します。
部品単体例は縦・横の2台を独立して操作できます。Product adapterは部品のShadow DOMを参照しません。
シミュレータ起動中に`http://127.0.0.1:8772/tests/index.html`を開くと、Productのボタン入力から
模擬PCの受信確認までのブラウザ連携試験も実行できます。

ハードウェア参照：[M5Stack公式 StickC Plus2](https://docs.m5stack.com/en/core/StickC-Plus2)。
共通ソースはsubmoduleです。変更時は共有リポジトリを先にコミット・プッシュし、そのコミットをこのProductで固定します。
