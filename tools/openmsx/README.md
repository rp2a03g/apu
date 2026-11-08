# openMSX 用の比較道具(自前 MSX エミュレータの基準づくり)

Mesen は MSX に対応していないので、`tools/mesen/` の Lua と同じ役を openMSX の Tcl で用意した物。
自前 MSX エミュレータ(`src/emulator/msx/`、ヘッドレスは `tools/headless/msx-run.js`)の画面と録音列を、
同じ ROM・同じフレームで openMSX と見比べるために使う。

| ファイル | 役 | 本ツール側の相手 |
|---|---|---|
| `ref-screenshot.tcl` | 決まったフレームに入力し、決まったフレームで PNG+VDP レジスタを保存 | `msx-run.js --press/--key --png` |
| `reglog.tcl` | 音源レジスタの書き込みを「フレーム chip addr value」の 1 行 1 書き込みで記録 | `msx-run.js --vgm` の録音列(比較スクリプトは未作成) |

実行例:

```
openmsx -machine C-BIOS_MSX2_JP -cart game.rom -script tools/openmsx/ref-screenshot.tcl
```

機種名は openMSX の `share/machines/` にある物。本ツールの同梱 C-BIOS と合わせるなら `C-BIOS_MSX1_JP` / `C-BIOS_MSX2_JP` / `C-BIOS_MSX2+_JP`、
実 BIOS を控えてあるなら相当する実機の定義(FS-A1WSX、FS-A1ST など。システム ROM は openMSX 側にも要る)。

## 注意

- **未検証(2026-11-09)**: この道具を書いた PC に openMSX が入っておらず、一度も実行していない。Tcl API の名前
  (`after frame`、`screenshot -raw`、`keymatrixdown/up`、`debug read "VDP regs"`、`debug set_watchpoint` と
  `$::wp_last_address` / `$::wp_last_value`)は openMSX のマニュアルの記憶で書いている。動かないときは openMSX のコンソールで `help <コマンド>` を見て直す。
- フレーム番号の起点は「スクリプト開始からの VBlank 回数」。本ツールの `msx-run.js` は電源投入からの VBlank 回数なので、
  `-script` が電源投入直後に走る前提でないと 1〜2 フレームずれる。ずれたら shots の番号を調整する。
- 画面の比較は色そのものでなく「形」で見る(本ツールの V9938 パレットと openMSX の色変換は一致しない)。
