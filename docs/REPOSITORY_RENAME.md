# 共通アプリ名の変更

共通アプリのGitHub名とサブモジュールの配置先を揃えました。

| 旧名 | 新名 |
| --- | --- |
| `gar-vibe-ui` | `gar-vibe-remote` |
| `sources/gar-vibe-ui` | `sources/gar-vibe-remote` |

Product名は `GarVibeRemote-M5StickC` のままです。サブモジュールのURL、ビルド、導入処理、テストも新しい配置先を参照します。GitHub側の改名で履歴は維持しています。

既存の作業内容を保存してからProductを更新し、`git submodule sync --recursive` と
`git submodule update --init --recursive` を実行してください。
旧ディレクトリーに未コミットの変更が残っている場合は、新しい作業場所へ引き継いでから整理します。

既存の監視プロセスやHookは、この更新だけでは書き換えません。
導入手順の明示的な `hooks` 操作を次に実行すると、このProductの旧送信スクリプトへの参照だけを置き換え、ほかのHookを保持します。
必要なHookのレビューは通常の導入手順に従ってください。
