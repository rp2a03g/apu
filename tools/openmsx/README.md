# openMSX との突き合わせ(自前 MSX エミュレータの基準)

Mesen は MSX に対応していないので、`tools/mesen/` と同じ役を openMSX で持つ。
自前 MSX エミュレータ(`src/emulator/msx/`)を **同じ ROM・同じ BIOS・同じキー入力・同じフレーム** で openMSX と並べ、画面と VRAM の違いを数える。

細部を記憶で書き、自分で書いたテスト ROM で確かめるだけでは、同じ思い込みが通ってしまう
(2026-11-11 に利用者の報告で見つかった FH・スプライトの縦スクロール・横の set adjust・R14 は、どれもテストと総当たりでは「正常」だった)。外に基準を置くための道具。

## 準備

openMSX の公式 Windows 版(`openmsx-<版>-windows-vc-x64-bin.zip`、GitHub の openMSX/openMSX のリリース)を展開し、
`_tmp_test/openmsx/app/openmsx.exe` に置くか、環境変数 `OPENMSX` で場所を指す。2026-11-11 に 22.0 で確かめた。

- C-BIOS の機種(`cbios2`)は openMSX 付属の C-BIOS 0.29 を使う(本ツール同梱の物と SHA-1 一致)。RAM はこちらと同じ 128K にした機種定義 `SEF_CBIOS_MSX2` を書く。
- 実 BIOS の機種(`fsa1f`)は、手元の分割 BIOS(既定 `_tmp_test/msx/sweep/bios`)を openMSX の `share/systemroms/sef/` に写し、
  こちらと同じスロット配置(メイン 0、サブ 3-0、ディスク TC8566AF 3-1、RAM 128K 3-2、ドライブ 2 台)の機種定義 `SEF_FSA1F` を書く。
  openMSX 付属の FS-A1F は 1 本にまとめた 512K の ROM を要求するので、分割の物では動かない。

## 使い方

```
node tools/openmsx/ab.js game.rom --script "Space:900-905" --shots 600,1200,1500
node tools/openmsx/ab.js --disk a.dsk --disk b.dsk --machine fsa1f --script "Space:1400,disk1:3000,Space:3060" --shots 3600
node tools/openmsx/ab.js --batch _tmp_test/msx/sweep/roms --kind rom --jobs 4 --out _tmp_test/openmsx/ab-roms
```

- `--script`: `キー:押すフレーム-離すフレーム`(キー名は `msxKeyboard.js` の KEYS: Space/Return/Up/F1 …)と `diskN:フレーム`(N 枚目に入れ替え)をカンマで。
- 出力 `<out>/<名前>/`: `cmp_<f>.png`(左こちら・中 openMSX・右 違う画素が赤)、`ours_<f>.png`、`ref_<f>.png`、`ref_<f>.txt`(openMSX の VDP レジスタ)、`result.json`。
- `result.json` の各 shot: `mismatch`(画素の %)、`df`(こちらのどのフレームが最も合ったか、±2)、`ox`/`oy`(位置合わせ)、
  `vramDiff`(128K のうち違うバイト数)と `vramFirst`、`regDiff`(こちら/openMSX)。
- まとめて回すと `<out>/ab.jsonl` に 1 本 1 行、最後にずれの大きい順の表を出す。

## 比べ方と限界

- 画面は色そのものでなく「同じ色の塊になっているか」で比べる(V9938 の 3bit → 8bit の色変換が違うため)。こちらの色 → openMSX の色の
  対応表を作り、いちばん多い対応に乗らない画素の割合(逆向きも数えて大きい方)。
- フレームの起点は両方とも電源投入からの VBlank 回数。こちらが数フレーム先に進む傾向(VRAM の埋まり方で 1〜5 フレーム)があるので、-6〜+3 フレームから最も合う物を採る。
- **CPU の時間の細かい差は積み重なる**: ゲームが進むほど敵の位置などがずれ、描画が正しくても `mismatch` は上がる。
  描画の誤りを探すときは、起動直後・タイトル・静止画面のように時間に左右されにくい所で比べる。
- **レジスタはフレームの終わりの値**: 画面の途中でレジスタを書き換えるゲーム(ラスタ)では `regDiff` は撮る時刻の違いを拾いやすい。

## 罠(実測)

- **スロットル OFF だと描画されず screenshot が真っ黒(640×480)になる**。`set throttle on` のまま `set speed 2000` にし、
  撮る 6 フレーム前から `set speed 100` に戻す(ab.js の Tcl)。この形で 420 フレームが約 1 秒。
- `-script` の `after frame` は「フレーム n の終わり」に呼ばれる。300 回目で `machine_info time` が 5.006 秒(1 フレーム 16.69ms)なので、電源投入からのフレームと一致する。
- `debug read "VDP regs" <n>`、`debug read "VDP status regs" <n>`、`debug read_block VRAM 0 0x20000`、`keymatrixdown/up <行> <マスク>`、`diska <file>` は 22.0 で動いた。

## 古い道具

- `ref-screenshot.tcl` / `reglog.tcl`: ab.js より前に書いた物(2026-11-09、openMSX 無しで書いて未実行)。
  画面の比較は ab.js に置き換えた。`reglog.tcl` の音源レジスタの記録(`debug set_watchpoint`)はまだ確かめていない。
