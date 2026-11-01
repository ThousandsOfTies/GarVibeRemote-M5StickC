# Productのコンポジション

このProductは、アプリ・共通ツール・基板の3リポジトリをsubmoduleで固定します。
構成の正本は[product.json](../product.json)です。

| 役割 | submodule | 所有するもの |
| --- | --- | --- |
| アプリ | `sources/gar-vibe-remote` | CompactUi、JSONL、USB/SPPの所有権・期限、ペアリング確認、回答の生成 |
| 共通機構 | `sources/gar-tools` | 構成検査、ビルド環境の準備・実行、シミュレータ部品・LVGLのPCビルド |
| 基板 | `sources/board-m5stickc-plus2` | LCD・ボタン・電源端子、Flash、M5系ドライバ依存、Arduino用のLCD/USB/SPP/電池/ボタンI/O |

```text
GarVibeRemote-M5StickC/
  product.json                   組み合わせ・アプリの設定・ビルド対象
  hardware/binding.json          利用する基板内蔵部品の名前
  sources/
    gar-vibe-remote/              共通アプリ
    gar-tools/                    共通機構
    board-m5stickc-plus2/          独立した基板リポジトリ
  firmware/stickc-plus2/
    platformio.ini               生成済み基板設定＋アプリ依存
    src/main.cpp                 基板I/Oとアプリcallbackの接続
    src/components.cpp           選択済みソースを一度だけ組み込む入口
  simulation/                    PC用の入口・模擬PC・パネル接続
  scripts/                       PCのCodex連携・導入とGAR hook
  .gar/composition/              生成物（Git管理外）
```

## 手元で確認する

PRをマージする前に新規取得する場合は、この変更のブランチを指定します。

```sh
git clone --branch refactor/board-composition --recurse-submodules https://github.com/ThousandsOfTies/GarVibeRemote-M5StickC.git
cd GarVibeRemote-M5StickC
python tools/product.py describe
python tools/product.py validate
python tools/product.py prepare
```

`describe`は実際のsubmoduleコミットと変更の有無を表示します。
検査と生成は実機へ接続しません。

`hardware/binding.json`は`lcd`とA/B/Cを選択するだけです。GPIO番号やLCD解像度は
基板プロファイルに置き、Productへ複製しません。Bluetooth名、デバイス識別名、
画面の向き・明るさ、LVGLのメモリ量は`product.json`でアプリ利用時の設定として指定します。
アプリ内にPlus2の名称を埋め込まず、実機とPCで同じ設定を渡します。

`prepare`は基板プロファイルからPlatformIOの`[board]`設定とC++定数を生成します。
アプリ設定からはC/C++で使う定数と、選択済みのソース参照を生成します。
ヘッダーはWindows/Linux別のフォルダーに分け、同じcheckoutを利用しても混ざりません。
生成物は手で編集しません。SDK・PlatformIO本体・WASM・ファームウェアはGitへ入れません。

## 実行までの接続

実機では基板アダプターがM5Unified・USB・SPP・LVGLの時計を担当します。
アプリはバイト列、ボタンedge、電池、切断・オーバーフロー、認証要求と結果を受け取ります。
ペアリングを許可する判断と回答の生成はアプリが行います。
Productの`main.cpp`はそのcallbackを結びます。

PCでは同じ`device-app/DeviceApplication.cpp`と`compact-ui/CompactUi.cpp`をWASMへビルドします。
基板のGPIO処理はビルドせず、Productの`host-entry.cpp`が同じアプリAPIへ入力を渡します。
パネルは既存のgar-toolsの筐体部品を使い、実際のLVGLの画素を表示します。
模擬PC、シナリオ、ACKとパネルの接続はProductに置きます。

```sh
# 実機用ビルドだけ（書き込み・ポート操作はしない）
python tools/product.py build
# 既存のWindows向けビルド入口も、自動でprepareする
python scripts/firmware.py build
```

GARの実機／シミュレータのbuild hookも同じ構成を使います。
既存の成果物検証、snapshot、deploy経路は[GAR導入手順](GAR.md)と
[シミュレータ手順](SIMULATION.md)に記載しています。
MCUの起動はArduinoの`setup`/`loop`であり、LyraのBusyBox用起動ファイルは作りません。
`tools/product.py package`はLinux向けです。Plus2の配布物は既存のGAR build hookで作成します。

PC側の監視範囲、Codex Appとの版依存接続、Hookの導入、USB/SPPの中継はこのProductの
組み合わせに属するため残します。基板リポジトリにチャット、質問、回答の知識は入れません。
今回の構成変更後の実機への書き込み・再ペアリング・Hook更新は行っていません。
