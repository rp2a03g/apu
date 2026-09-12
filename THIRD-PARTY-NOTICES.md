# 第三者のソフトウェアに関する表示 (Third-party notices)

このプログラム本体は GPL-2.0 で配布している（[LICENSE](LICENSE)）。
その中には、他の作者が書いたコードを移植した部分と、他の実装を参照して
書き起こした部分がある。ここではその出所・著作者・ライセンスをまとめる。

区分の意味は次のとおり。

- **移植** … 元のソースコードを関数単位で書き換えたもの。元の著作権が及ぶ。
- **参照** … 元の実装や資料で挙動を確認しながら、このプロジェクトで新規に
  書き起こしたもの。コードそのものは持ち込んでいない。

---

## 移植したコード

### Nuked-OPLL (Yamaha YM2413 / VRC VII)

- 原典: <https://github.com/nukeykt/Nuked-OPLL> (`opll.c` v1.0.2)
- 著作者: Copyright (C) 2019-2023 Nuke.YKT
- ライセンス: GNU General Public License version 2 or later
- 音色ROM・アルゴリズムは siliconpr0n.org (digshadow, John McMaster) による
  VRC VII の decap / die shot に由来する
- 該当ファイル: `src/emulator/expansion/opllNuked.js`
  （および同じコードを含むキャプチャWorkerバンドル `src/audio/*-capture-worker.js`）
- ライセンス本文: [LICENSE](LICENSE)（本体と同じGPL-2.0）

### Nuked-OPN2 (Yamaha YM2612 / YM3438)

- 原典: <https://github.com/nukeykt/Nuked-OPN2> (`ym3438.c` / `ym3438.h` v1.0.12)
- 著作者: Copyright (C) 2017-2022 Alexey Khokholov (Nuke.YKT)
- ライセンス: GNU **Lesser** General Public License version 2.1 or later
- die shot は Silicon Pr0n (digshadow)、OPL2 ROM は OPLx decapsulated
  (Matthew Gambrell, Olli Niemitalo) に由来する
- 該当ファイル: `src/emulator/expansion/ym2612Nuked.js`
  （`ym2610.js` / `ym2203.js` / `ym2608.js` はこのコアの薄いラッパー）
- ライセンス本文: [LICENSE.LGPL-2.1](LICENSE.LGPL-2.1)
- LGPL-2.1 第3条により、本プログラム全体のGPL-2.0での配布と両立する

### emu2413 (Yamaha YM2413 / OPLL、旧コア)

- 原典: <https://github.com/digital-sound-antiques/emu2413> (`emu2413.c`)
- 著作者: Copyright (c) 2001-2019 Mitsutaka Okazaki
- ライセンス: MIT License（全文は下記）
- 該当ファイル: `src/emulator/expansion/opllMsx.js`, `src/emulator/expansion/vrc7.js`
- 現在の既定コアは Nuked-OPLL。これらはA/B比較用に残してある

### LZMA SDK (7z の LZMA / LZMA2 展開部)

- 原典: LZMA SDK (Igor Pavlov)
- ライセンス: パブリックドメイン
- 該当ファイル: `src/archive/lzma.js`（展開のみ。圧縮は移植していない）

---

## 参照して書き起こしたもの（コードは移植していない）

| 対象 | 参照した実装・資料 | 該当ファイル |
|---|---|---|
| Namco C140 / C352 | MAME `c140.cpp` / `c352.cpp`（C352は superctr による実チップ解析） | `src/emulator/expansion/c140.js`, `c352.js` |
| Sega MultiPCM | MAME `multipcm.cpp`（ElSemiコア） | `src/emulator/expansion/multipcm.js` |
| Sega PCM | MAME `segapcm.cpp` | `src/emulator/expansion/segapcm.js` |
| Capcom QSound | 旧MAME / VGMPlay の HLE `qsound.c` | `src/emulator/expansion/qsound.js` |
| Irem GA20 | MAME `iremga20.cpp` | `src/emulator/expansion/ga20.js` |
| OKIM6258 / OKIM6295 | MAME `okim6258.cpp` / `okim6295.cpp`、VGMPlay `okim6258.c` (Valley Bell) | `src/emulator/expansion/okim6258.js`, `okim6295.js` |
| RF5C164 | MAME `rf5c68.cpp` | `src/emulator/expansion/rf5c164.js` |
| 32X PWM | VGMPlay / Gens `pwm.c` | `src/emulator/expansion/pwm32x.js` |
| SN76489 | VGMPlay / Maxim の PSG コア（`PSG_CUTOFF` の扱い） | `src/emulator/expansion/sn76489.js` |
| OPL (YM3812 / YM3526 / Y8950) | MAME `fmopl.c`（時間スケール） | `src/emulator/expansion/opl.js` |
| Konami SCC / SCC+ | emu2212 (Mitsutaka Okazaki) のレジスタ配置 | `src/emulator/expansion/sccAudio.js` |
| KSS のメモリマップ / 曲初期化 | libkss (digital-sound-antiques) `vm.c` / `mmap.c` | `src/emulator/kssBus.js`, `kssPlayer.js` |
| SM83 (Game Boy CPU) | NESdev BBS "Game Boy CPU isn't a Z80. What is it?" | `src/emulator/cpuSm83.js` |
| VRC6 のこぎり波 | NESdev Wiki | `src/emulator/expansion/vrc6.js` |
| ppmck ドライバの設計 | ppmck (`nes_include/ppmck/`) の状態管理・バンク切替の考え方 | `src/driver/ppmckDriver.js`（コードは新規に書き起こし） |

### SNES DSP ガウス補間テーブル

`src/emulator/spcDsp.js` の `GAUSS[512]` は SNES DSP の内蔵ROMに焼かれている
実機の値そのもので、fullsnes をはじめとするハードウェア資料に公表されている
定数表である。突き合わせには blargg の snes_spc / snes9x `SPC_DSP.cpp` の
`gauss[512]` を使った。

### CPU命令テスト

`tools/headless/cpu-test.js` と `tools/*-test.html` は
[SingleStepTests](https://github.com/SingleStepTests) のテストベクタを実行時に
ダウンロードして使う。ベクタ自体はこのリポジトリには含まれない。

---

## MIT License（emu2413 / emu2212）

```
The MIT License (MIT)

Copyright (c) 2001-2019 Mitsutaka Okazaki

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## このツールが扱う音楽データについて

NSF / NSFe / SPC / KSS / GBS / HES / VGM といった入力ファイル、およびそこから
変換して得られるMML・NSF・波形データには、原曲および元のプログラムの権利が
及ぶ。このリポジトリにはそれらのファイルを一切含めていない。入力に使うファイル
は各自が正当に入手したものを使い、変換結果の取り扱いは各自の責任で判断すること。
