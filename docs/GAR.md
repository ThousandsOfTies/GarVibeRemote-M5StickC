# GARでPlus2へ導入する

開発用シミュレータは[VMを使わないシミュレータ](SIMULATION.md)を参照してください。
`host_process`を選択すると`gar sim build／deploy／start／stop／diag`を使用できます。
以下は実機への書き込み手順です。

ビルドは[Productのコンポジション](COMPOSITION.md)から基板設定・共通アプリを選びます。
GAR hookが自動で`prepare`し、基板情報をProduct内へコピーしません。

このProductは、GARの`gar target build`でファームウェアをビルドし、
`gar target deploy`でM5StickC Plus2へ書き込めます。
ここでいう実機へのインストールは、GARの標準操作である`target deploy`です。

GARが担当するのは、ビルド環境の呼び出し、成果物の保存・検証、USBからの書き込みです。
Codexの監視設定、PCブリッジ、Bluetooth中継は[Windows導入ガイド](INSTALL.md)で別に準備します。
Webシミュレータの起動や、Wi-Fiへの接続は不要です。

## 必要なもの

- このリポジトリと固定済みのsubmodule。取得には`git clone --recurse-submodules`を使います。
- [GaplessAgentRuntime](https://github.com/ThousandsOfTies/GaplessAgentRuntime)と、その`gar`コマンド。
- Linuxコンテナを実行できるDocker環境。WindowsではDocker Desktopの起動を確認します。
- **M5StickC Plus2**と、データ通信できるUSBケーブル。
- 初回のツールや依存ライブラリの取得に使うインターネット接続。

ビルド用のPlatformIOはGARのDockerビルド環境で実行します。
USBへの書き込みはWindows側のesptoolで行い、USB機器をコンテナやWSLへ渡しません。
ホスト側のPythonは、GARと既存ファームウェアの準備・バックアップ操作に使用します。

## 1. 実機とバックアップを確認する

対象は**M5StickC Plus2のみ**です。初代StickC、StickC Plus、T-Watchへは書き込みません。
USBシリアルチップやCOM番号だけでは型番を特定できないため、本体の型番を確認してください。

以下はProductルートで実行します。`$UsbCom`には`ports`の結果と抜き差しで確認した、
Plus2の**USB用COMポート**を設定します。Bluetoothの発信・着信COMとは別です。

```powershell
python scripts/setup_remote.py ports
# 確認したUSB用COM番号を$UsbComへ設定してから実行する:
python scripts/firmware.py identify --port $UsbCom
python scripts/firmware.py backup --port $UsbCom --model m5stickc-plus2
```

`identify`と`backup`は必要なホスト側のesptoolを専用環境へ自動で準備します。
GAR経由のビルド前に、Windows側でファームウェアを別途ビルドする必要はありません。
初回書き込み前に、`backup`で8MBの既存フラッシュとSHA256の記録が保存されたことを確認します。
このバックアップは`artifacts/firmware/`に保存され、Gitでは管理しません。
同じ個体の有効なバックアップが保存済みなら、それを確認して再利用できます。
GARの`target deploy`はバックアップを自動作成しません。

USBポートを使用中のシリアルモニタや試験ツールは、実機の読み取り前に終了します。
稼働中のVibeRemote中継については、後述の[更新時の接続](#更新時の接続)も確認してください。

## 2. GARへProductを登録する

GARのセットアップを済ませ、`gar`が使える端末で次を実行します。

```powershell
gar config
```

workspaceを追加するか、同じProductの既存登録を編集し、次の項目を設定します。
ほかのProductの登録・接続先は変更しません。

| 項目 | 設定 |
| --- | --- |
| Workspace名 | `Local/GarVibeRemote-M5StickC` |
| 接続 | Local。このProductを取得した実際のフォルダー |
| ブランチ | 使用しているブランチ。通常は`main` |
| Target | `ESP32 / M5Stack`（`esp32`） |
| BuildEnvironment | Local Docker（保存値は`local`） |
| TargetEnvironment | ESP32 esptool（`esp32_esptool`） |
| ESP32のserial port | 前段で確認したUSBのCOM番号 |
| SimulationEnvironment | 今回の実機導入には不要。選択を省略できる |

`local`のBuildEnvironmentは、ホストでの直接ビルドではなくDockerを使います。
GARの既定ビルドイメージにはPlatformIOが含まれます。
PCごとのworkspaceパスやCOM番号は、GAR側の`.gar/config.json`に保存します。
作者のPCの値をコピーしたり、公開するProduct設定へ個人のパス・COM番号を固定したりしません。

Windowsでは、Dockerの永続ビルドキャッシュを使うと、ツール展開時のファイル共有アクセスを減らせます。
`build.cache`対応版のGARで、設定ファイル内のこのworkspaceへ次を追加します。

```json
{"build": {"cache": true}}
```

GARはworkspaceごとに専用Docker volumeを用意し、`GAR_BUILD_CACHE`でhookへ渡します。
この設定はビルド用キャッシュだけに適用され、ファームウェアのsnapshot保存先やUSB接続先は変わりません。

`gar`がPATHにない場合は、取得したGARの`scripts/gar.cmd`をフルパスで呼び出せます。
次のように`$GarRoot`へそのPCのGARフォルダーを設定し、同じ引数を渡してください。

```powershell
# $GarRootは、このPCに取得したGaplessAgentRuntimeのフォルダー:
& (Join-Path $GarRoot 'scripts/gar.cmd') config
```

登録後、設定された対応操作は読み取り専用で確認できます。

```powershell
gar target --capabilities --workspace Local/GarVibeRemote-M5StickC --json
```

## 3. ビルドする

```powershell
gar target build --workspace Local/GarVibeRemote-M5StickC
```

GARはProductの`scripts/product-target-build.sh`をDocker内で呼び出します。
このhookは`firmware/stickc-plus2`のSPP／USB版と共有CompactUiをビルドし、
`artifacts/from-codespace/`へ`artifact.json`とESP32用のファームウェア一式を出力します。
その後、GARが`TARGET_APP`のsnapshotとして取り込み、build IDとchecksumを付けて保存します。
Gitの状態を取得できる場合は、ソースや共通ツールのコミット情報も記録されます。
未コミットの変更を含む場合など、コミットを確定できない項目は`unknown`になります。

初回は開発ツールとライブラリの取得・展開にも時間がかかります。
`build.cache`が有効なら、ビルド環境・キャッシュはDocker volume内に保存して再利用します。
未設定の場合は`.gar/target-build-tools/`と`.cache/gar-target-build/`へ保存します。
いずれもWindows側のバックアップ用ツール環境は共有しません。

ESP32へ渡すファイルは`bootloader.bin`、`partitions.bin`、`boot_app0.bin`、`firmware.bin`です。
`artifact.json`はProductが作り、GAR管理の`artifact-info.json`はGARが生成します。
生成されたファームウェアやビルドキャッシュをGitへ追加しません。

## 4. snapshotを実機へ書き込む

対象個体・USBポート・バックアップを確認してから実行します。
書き込みでは、Plus2にある既存アプリをVibeRemoteで置き換えます。

```powershell
gar target deploy --workspace Local/GarVibeRemote-M5StickC
```

`deploy`は最新の保存済み`TARGET_APP` snapshotを読み、checksumを確認してUSBへ書き込みます。
Productの作業フォルダーにあるファイルをそのまま書き込まず、暗黙の再ビルドも行いません。
ソースを変更した後は、もう一度`target build`を実行してから`target deploy`を使います。

### 確認できる範囲

現在のGARのESP32対応は、ファームウェアの書き込みまでです。
`target prepare`は不要で、`target preflight`・`target status`・`target diag`による
実機の互換性・アプリ稼働診断には対応していません。
`Flash complete.`やdeploy成功だけで、画面、ボタン、Bluetooth、Codexとの往復が正常とは判定しません。

書き込み後は、縦画面が表示され、A／B／Cが正常に操作できることを確認します。
通信は[SPP／USB接続ガイド](DEVICE_CONNECTION.md)の`device-test`で実際のボタン入力を受信し、
最後に元のCodexチャットへ回答が戻るところまで確認します。
PC内の模擬試験や、Webシミュレータの操作を実機入力の代わりにしません。

## 更新時の接続

1. 自分が起動したVibeRemoteの`device`中継や`serial_demo.py`を終了し、USB／SPPの通信を止める。
2. USB用COMを確認し、GARでbuild・deployを実行する。
3. Plus2の起動後、元と同じ設定で必要な`device`中継を再起動する。
4. 実機の接続表示と、実際の回答の往復を確認する。

PC状態ブリッジやチャット収集処理を停止する必要がある場合は、その処理の起動元と設定を確認してから行います。
ポートを空けるために、無関係のプロセスやほかの機器の接続を終了しません。
既存のBluetooth登録は先に削除せず、再接続できない場合だけ接続ガイドに沿って診断します。

## PC側の導入は別に行う

GARへのProduct登録と、Codexの監視対象・質問連携の設定は別です。
初回導入では[README](../README.md)と[Windows導入ガイド](INSTALL.md)に従い、
`scripts/setup_remote.py`でPC側を準備してください。

- `prepare`：PCブリッジ・中継の依存を準備する。
- `configure`：監視先のプロジェクト・チャット・範囲を設定する。
- `hooks`：監視用Hookを準備する。変更したHookのレビューは利用者が行う。
- `bridge`・`sessions`・`device`：それぞれ独立して起動する。

GARのbuild・deployから、Hookの書き換え、信頼設定の変更、ペアリング、
PCサービスの起動・停止を暗黙に実行しません。トークンやチャットIDをファームウェアへ埋め込みません。
