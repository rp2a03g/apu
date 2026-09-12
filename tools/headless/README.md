# ヘッドレス実行ハーネス

ブラウザを開かずに、変換器とエミュレータを Node から直接動かすための道具立て。

`src/` は全ファイルが `(function(global){...})(window)` の素朴なIIFEで、単一グローバル
`MML` にぶら下がるだけの構造(file:// 直開きを守るため ESM を使っていない)。
そのおかげで「`index.html` の `<script>` を書かれた順に eval するだけ」でブラウザと
同じ状態を Node 上に再現できる。全168本が0.2秒ほどで読み込める。

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
| `convert.js` | 変換API + CLI(NSF/SPC/KSS/GBS/HES/VGM、zip/7z/gzip内も可) |
| `regress.js` | コーパス一括変換のスナップショット回帰テスト |
| `audio-check.js` | 実際に鳴らした音を数値で点検(クリップ/DC/無音/オクターブずれ/プチノイズ) |
| `cpu-test.js` | CPU命令テストCLI(検証ロジックは `../cpu-test-core.js` をブラウザ版と共有) |
| `help-lint.js` | MMLヘルプ(`;@help`タグ)の自己点検。書式・実演スニペットのコンパイル・コマンド網羅 |
| `baseline-*.json` | 回帰テストのベースライン(曲ごとのSHA-256とメタ情報) |

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

## シムについての注意

`shim.js` はDOMの実装ではなくテスト用の張りぼて。未知のプロパティは「呼べる・辿れる」
偽物を返し、代入は覚えるだけ。UIの挙動検証には使えない(それはブラウザでやること)。

`requestAnimationFrame` は意図的にコールバックを一度も呼ばない。`main.js` の描画ループが
rAFで自己再登録し続けるため、素直に実装するとプロセスが永久に終わらなくなる。
