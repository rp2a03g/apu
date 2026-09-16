# ヘッドレス実行ハーネス

ブラウザを開かずに、変換器とエミュレータを Node から直接動かすための道具立て。

`src/` は全ファイルが `(function(global){...})(window)` の素朴なIIFEで、単一グローバル
`MML` にぶら下がるだけの構造(file:// 直開きを守るため ESM を使っていない)。
そのおかげで「`index.html` の `<script>` を書かれた順に eval するだけ」でブラウザと
同じ状態を Node 上に再現できる。全169本が0.2秒ほどで読み込める。

## 前提

Node.js が必要(依存パッケージは無し)。パスを通していないシェルからは、
node.exe を置いた場所を先に通しておく。

```bash
export PATH="$PATH:/path/to/nodejs"
```

## ファイル

| ファイル | 役割 |
|---|---|
| `load.js` | `index.html` の script を順に読み込む。単体実行で読み込みレポート |
| `shim.js` | 最小のDOM/AudioContext/Workerシム。UIコードが読み込み時に落ちないための張りぼて |
| `convert.js` | 変換API + CLI(NSF/SPC/KSS/GBS/HES/VGM/PSF、zip/7z/gzip内も可。PSFの `_lib` は同じzip/フォルダから引く) |
| `regress.js` | コーパス一括変換のスナップショット回帰テスト |
| `audio-check.js` | 実際に鳴らした音を数値で点検(クリップ/DC/無音/オクターブずれ/プチノイズ) |
| `cpu-test.js` | CPU命令テストCLI(検証ロジックは `../cpu-test-core.js` をブラウザ版と共有) |
| `help-lint.js` | MMLヘルプ(`;@help`タグ)の自己点検。書式・実演スニペットのコンパイル・コマンド網羅 |
| `i18n-dupkeys.js` | `src/i18n/en.js` の重複キー検出(後勝ちで先の訳が黙って死ぬため) |
| `notelist-check.js` | 楽譜出力用の音符列 `compile().noteList`(音価付き)の点検。フレーム合計/ticks逆算/タイ・連符・w・k・PS・`;@time``;@key` の固定ケース |
| `score-check.js` | 楽譜の表記モデル(src/score/notation.js)と MusicXML 書き出しの点検。小節の合計/音価の厳密一致/タイ・連符・連桁の対応/XMLの整合。`--out DIR` で .musicxml を書く |
| `score-midi-check.js` | MusicXML 書き出しの MuseScore 往復検証(MuseScore 4 の CLI が要る。`MUSESCORE_EXE` か既定パス)。.musicxml → MIDI にして開始tick/長さ/音高を表記モデルと突き合わせ、MuseScore のログに警告が無いことも見る。`--piano` でピアノ2段版 |
| `musicxml-import-check.js` | MusicXML→MML 取り込み(src/score/musicxmlImport.js)の往復検証。自前の書き出し/MuseScore の書き直し/.mxl を取り込んで compile し、音高ごとの鳴っている区間が元と一致するか。引数に .musicxml を渡すと取り込み結果の MML を表示(`--out`) |
| `r3000-test.js` / `r3000-disasm.js` | PSF用 MIPS R3000A の単体テスト(BigInt照合・LWL/LWR等) / 逆アセンブラ(デバッグ用) |
| `psf-probe.js` | PSF容器と `_lib` 連鎖の読み込み確認(PC/SP/セグメント/タグ) |
| `psf-wav.js` | PSF 1曲を44.1kHz WAVへ。停止理由・未実装BIOS呼び出し・キーオン・ピーク/RMSを報告 |
| `psf-sweep.js` | PSFコーパス一括の動作確認(停止/無音/未実装BIOS/実時間比) |
| `psf-idle-check.js` | PSFのアイドル省略が出力を変えないこと(on/offで波形・キーオン時刻が完全一致) |
| `psf-replay-check.js` | PSFキャプチャ→SPU単独再生が元のエミュ出力とサンプル単位で一致すること |
| `psf-loudness.js` | PSF再生ゲインの校正(SPC基準の生RMS比) |
| `psf-convert-survey.js` | PSF→MML変換の品質調査(合成ch/実機スロット別のコンパイル可否・音程検証) |
| `pool-regroup-score.js` | 合成ch(`Emu.PoolChannelRegrouper`)の採点。PSFドライバ内部のトラック構造体を正解にしてレーン純度/トラック集中度を出す |
| `baseline-*.json` | 回帰テストのベースライン(曲ごとのSHA-256とメタ情報)。**gitignore済み** |

ベースラインは手元のコーパスと1対1に対応する曲名一覧なので、リポジトリには入れていない。
初回は `--update` で作る（下記）。

コーパスの置き場所は環境変数 `MML_CORPUS_ROOT` で指定する。**既定値は持たない**ので、
未指定のまま走らせると案内を出して終わる(exit 2)。中身は形式ごとのサブディレクトリ
`nsf` `spc` `kss` `gbs` `hes` `vgm` `psf`。

```bash
export MML_CORPUS_ROOT="D:/snd"      # D:/snd/nsf, D:/snd/vgm ... を見る
```

引数で渡してもよい。`regress.js --corpus "D:/snd/nsf"` / `check-all.js --corpus-root "D:/snd"`。
引数があれば環境変数より優先する。

## 使い方

### 読み込み確認

```bash
node tools/headless/load.js
```

### 1曲変換

```bash
node tools/headless/convert.js "path/to/song.nsf" --sec 15
```

`--song N` で曲番号(省略時はヘッダの宣言値)、`-o out.mml` でファイル出力、
アーカイブなら `--list` で中身一覧・`--entry N` でエントリ選択。
`--preset plain|faithful` / `--cmd D=0,EP=0,NOTE_END=zero` で変換設定(src/convert/options.js の cmd。
省略時は忠実再現=UIの既定と同じ)。基準ピッチは `--cmd TUNING=a440`(12平均律固定)/
`TUNING_MIN=3`(自動検出の最小偏差セント)。

**`--song` の意味はフォーマットで違う。** nsf/gbs/kss は0始まりの曲インデックス、
hes は「トラック番号そのもの」(HESの `firstTrack` は0/1始まりの規約が無く、
ゲームがINIT時のAレジスタとして直接解釈する任意の8bit値)。省略時は
`startingSong` / `firstSong` / `firstTrack` を使うので、基本は省略が正しい。

### 一括回帰テスト

```bash
node tools/headless/regress.js --corpus "path/to/corpus/nsf" --update
```

でベースラインを作り、改修後に `--update` 無しで実行すると、出力が変わった曲だけが
列挙される(変化ありなら exit 1)。

```bash
node tools/headless/regress.js --corpus "path/to/corpus/nsf"
```

- `--sec N` … 1曲あたりの変換秒数(既定15)
- `--entries N|all` … アーカイブ1個から見る曲数(既定1)
- `--dump DIR` … MML本文も書き出す。`--update` 前後で2回ダンプして diff すれば変化の中身が見える
- `--verbose` … 曲名と所要msを1行ずつ。どこで固まっているか見るとき用
- `--only 文字列` … ファイル名部分一致で絞り込み

manifest には本文ではなく SHA-256 を持たせてある(数百〜数千曲の本文をgitに入れると
重いため)。「どの曲が変わったか」は manifest、「どう変わったか」は `--dump` の diff、
という二段構え。

### まとめて回す

```bash
node tools/headless/check-all.js
```

6形式の回帰テスト + CPU命令テストを順に走らせ、最後に表でまとめる。
`--update` でベースライン一括更新、`--skip spc` で時間のかかる形式を外す、`--no-cpu` でCPUテスト省略。
各形式は別プロセスで走るので、1形式のメモリ肥大や異常終了が他へ波及しない。

### MMLヘルプの点検

```bash
node tools/headless/help-lint.js --list
```

サンプルMML(または引数で渡した.mml)の `;@help` タグを索引化して、
書式エラー・本文/実演の欠落・コマンドの重複・各実演スニペットのコンパイル可否を見る。
最後に `src/mml/compiler.js` 冒頭の「対応コマンド:」ブロックと突き合わせて
**ヘルプ未掲載のコマンド**を列挙する(コマンドを実装したのに解説を書き忘れた、を検出する)。
`check-all.js` からも自動で走る(`--no-help` で外せる)。

### 音の数値点検

```bash
node tools/headless/audio-check.js "song.hes" --sec 15
```

ピーク/RMS/DCオフセット/クリップ/無音率/波形の不連続/スペクトルピーク(音名付き)を出す。
`--wav out.wav` で16bit WAVも書ける。

**測定点は「DC遮断の後・リミッタとマスター音量の前」。** 実再生は各 `*-stream-player.js` が
DynamicsCompressor(threshold -3dB / ratio 20)を通すので、0dBFS超過は即歪みではなく
「リミッタが介入する」を意味する。また `captureXxxSongAsync` は生の値を返す一方
ブラウザ再生はDC遮断を通すので、ここで揃えている(揃えないとGBSで存在しないDC +0.22 を
検出してしまう)。SPCだけは実再生側もDC遮断を持たないので素通しが正しい。

音色の良し悪しや曲としての正しさは判定できない。それは人が聴くしかない。

### CPU命令テスト

```bash
node tools/headless/cpu-test.js 6502
node tools/headless/cpu-test.js all --per 200
node tools/headless/cpu-test.js z80 --group ed --opcodes "ed b0,ed b8"
```

外部ベクタ SingleStepTests を CDN から取得し `tools/headless/.vectors/` にキャッシュする
(2回目以降はオフライン。gitignore済み)。既定は代表命令のみで、`--all` は全命令
(6502全命令だと初回に数百MB落ちる)。

検証ロジックは `tools/cpu-test-core.js` にあり、ブラウザ版 `tools/*-test.html` と共有している。
同じ比較コードを2箇所に書くと片方だけ直して食い違っても気付けないため、必ずここを直すこと。

### PSF(PlayStation)の点検

```bash
node tools/headless/r3000-test.js                                   # CPU(期待: 全件 passed)
node tools/headless/psf-sweep.js "D:/snd/psf" --per 2 --sec 15      # 全zipの動作確認
node tools/headless/psf-replay-check.js "D:/snd/psf/xxx.zip" "曲名の一部" 20
node tools/headless/psf-idle-check.js "D:/snd/psf/xxx.zip" "曲名の一部" 10
```

CPU/SPU/HLE BIOS を触ったら sweep と replay-check/idle-check を回す。replay-check と idle-check は
「一致しなければ壊れている」ので、ずれは1サンプルでも原因を追うこと(ブラウザ再生とアイドル省略の正しさの根拠)。

## シムについての注意

`shim.js` はDOMの実装ではなくテスト用の張りぼて。未知のプロパティは「呼べる・辿れる」
偽物を返し、代入は覚えるだけ。UIの挙動検証には使えない(それはブラウザでやること)。

`requestAnimationFrame` は意図的にコールバックを一度も呼ばない。`main.js` の描画ループが
rAFで自己再登録し続けるため、素直に実装するとプロセスが永久に終わらなくなる。
