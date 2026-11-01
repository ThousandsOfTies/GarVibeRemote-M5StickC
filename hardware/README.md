# 基板内蔵部品の選択

`binding.json`はProductが利用するLCDとボタンの名前を選択します。
物理GPIO番号・画面寸法・Flash・電源保持端子の正本は、submoduleの
`sources/board-m5stickc-plus2/profiles/arduino-esp32.json`です。
実機とシミュレータは同じ選択を使い、別のピン表を作りません。

組み合わせと設定の生成は[コンポジション](../docs/COMPOSITION.md)を参照してください。
