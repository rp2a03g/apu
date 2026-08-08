# Sound Emulation Foundry - ppmckc ed.

ブラウザ上で動作するファミコン(RP2A03)＋拡張音源対応MML制作環境。
MMLコンパイラ・6502アセンブラ・NSFジェネレーター・音源エミュレータをすべてJavaScriptで内製する。

> **開発に着手する前に必ず読むこと:**
> - [DESIGN.md](DESIGN.md) — 恒久的な設計原則(不変条件 INV-1〜6、Song IR仕様、層の分離ルール)
> - [ROADMAP.md](ROADMAP.md) — 実装フェーズと各タスクの受け入れ条件

## 現在の状態: Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 + Phase 6

### Phase 1: 6502アセンブラ & NSFジェネレーター

- `src/asm/opcodes.js` — 6502 命令セット（合法151オペコード）の定義
- `src/asm/assembler.js` — 2パス方式の簡易6502アセンブラ
  - ラベル、各種アドレッシングモード、`.org` `.byte`/`.db` `.word`/`.dw` `.res`/`.ds` ディレクティブに対応
- `src/nsf/nsfHeader.js` — NSF 128バイトヘッダの生成・解析
- `src/nsf/nsfBuilder.js` — ヘッダ＋プログラムイメージからNSFバイナリを生成、ダウンロード

### Phase 2: NSF対応エミュレータ（6502 CPU + 2A03音源）

- `src/emulator/cpu6502.js` — 6502 CPUコア（全151オペコード、`call()`でINIT/PLAYサブルーチン実行）
- `src/emulator/apu2a03.js` — 2A03 APU（パルスx2・三角波・ノイズ・DMCの4ch合成、NES非線形ミキサー実装）
- `src/emulator/nsfBus.js` — NSF実行用メモリバス（$4000-$4017をAPUへルーティング、バンクスイッチ対応）
- `src/emulator/nsfPlayer.js` — INIT/PLAY呼び出し + フレーム単位の音声サンプル生成
- `src/driver/sampleDriver.js` — 約440Hzのトーンを鳴らすパルス1チャンネルの最小ドライバ
- `index.html` / `src/main.js` — アセンブル結果・NSFヘッダプレビュー・ダウンロード・「▶試聴」によるエミュレータ再生UI

### Phase 3: 再生ログ一括キャプチャ & シーク/早送り/巻き戻し

- `src/emulator/capture.js`
  - `MML.Emu.captureSong(nsfBytes, opt)` — INIT実行後、指定秒数分のPLAYルーチンを毎フレーム実行し、全フレームの音声波形（DCブロック済み）とレジスタ書き込みタイムラインログを一括生成
  - `MML.Emu.dcBlock(samples)` — APU出力のDCオフセットを除去するワンポールDCブロッカー
- `index.html` / `src/main.js`
  - 「再生・シーク（一括キャプチャ）」パネルを追加（キャプチャ長さ指定、キャプチャ実行ボタン）
  - キャプチャ結果を `AudioBuffer` 化し、`AudioBufferSourceNode.start(0, offset)` による即時シークを実現
  - 再生・一時停止・停止・巻き戻し(-5秒)・早送り(+5秒)・シークバーによるトランスポートUIを実装

### Phase 4: MMLコンパイラ（ppmck互換 基本コマンド）

- `src/mml/lexer.js` — ソースをチャンネル(A-D)別のコマンド文字列に分割し、トークン化
- `src/mml/compiler.js` — `MML.Mml.compile(source)`
  - 対応コマンド: `cdefgab`（音符, `+`/`#`/`-`で半音, 数値で音長, `.`で付点）, `r`（休符）, `n<num>[,<len>]`（直接音程指定,オクターブ2のCを0とした通し番号）, `o` `>` `<`（オクターブ）, `l`（デフォルト音長）, `v`（音量0-15）, `v+` `v-`（音量相対増減,省略時±1）, `q`（ゲートタイム0-8）, `@q<n>`（フレーム単位の早期ノートオフ）, `t`（テンポ、曲中の任意位置で変更可）, `K<n>`（移調・半音）, `@`（音色=デューティ比）, `&`（タイ）, `[ ]n`（繰り返し）, `[ ... | ... ]n`（最後の周回だけ`|`以降を演奏しない）, `{ ... }<len>`（連符・等分）, `EN<n>`/`ENOF`+`@EN<n>={...}`（ノートエンベロープ=高速アルペジオ、A/B/C/D対応、仕様通り厳密実装）, `EP<n>`/`EPOF`+`@EP<n>={...}`（ピッチエンベロープ、A/B/C対応、近似実装）, `MP<n>`/`MPOF`+`@MP<n>={delay,speed,depth}`（ビブラート、A/B/C対応、近似実装）, `s<speed>,<depth>`（スイープ、A/B/C対応、近似実装）
  - 「近似実装」と明記したコマンドは、ppmck実機ドライバの内部除算ルーチンまでは追い切れておらず、方向・大まかな挙動は実測確認済みだが数値カーブの完全一致は未検証(詳細は`ROADMAP.md`フェーズ1.5参照)
  - `@OP<n>={8バイト,$XX可}` / `@OT<n>={TL,FB,...}`（VRC7カスタム音色。8バイト生形式とMGSDRV互換形式の両方に対応、内部的には同じ音色テーブルに統合）, `@FM<n>={64値}`（FDS波形メモリ）, `@N<n>={buf,...}`（N163波形、16サンプルに正規化）, `@MW<n>={32値}`+`@MH<n>={delay,freq,depth,waveform}`+`MH<n>`/`MHOF`（FDSピッチ変調）, `S<n>`/`M<n>`/`N<n>`（FME7ハードウェアエンベロープ形状/周期・ノイズ周波数、実機PSGレジスタ仕様通り厳密実装）
  - VRC7/FDS/N163は「音色・波形スロットが1系統のみで全ch共有」という実機の制約はあるが、**曲中の動的な切り替えに対応**: VRC7は`OP<n>`コマンド（出現位置で即座にカスタム音色を再ロード）、FDS/N163は`@<n>`（音色番号指定コマンド）で選択中の`@FM<n>`/`@N<n>`が変わるたびに自動的に波形を再ロードする
  - 複数行にまたがる`{ ... }`定義ブロック（コメント入り可）に対応
  - `#TITLE`/`#COMPOSER`/`#MAKER`/`#PROGRAMER`（メタ情報、`compile()`戻り値の`meta`に格納。NSFヘッダ等への反映は今後の課題）, `#OCTAVE-REV`（`>``<`反転）, `#GATE-DENOM`（`q<n>`のゲート分母変更）, `#EX-VRC6`等（拡張音源宣言、UIのチェックボックスと統合されMML本文だけで有効化できる）, `#AUTO-BANKSWITCH`等バンキング系・`#INCLUDE`（未対応・認識のみで無視）, `$<char> <mml>`（マクロ定義、1回だけの非再帰展開）
  - `@DPCM<n>={"file",freq,size,dac,mode}`（DMCサンプル定義）はパース済み。`compile()`の`opt.dpcmSamples[filename]=Uint8Array`で変換済みバイト列を外部から受け取れる（フェーズA）。実際の再生チャンネルへの配線・ファイル選択UIとの統合は未実装（`ROADMAP.md`フェーズ1.7で計画）
  - **MML→NSF書き出し（バンク切り替え・拡張音源対応）**: 「MML作曲」パネルの「NSF書き出し」ボタンで、実際に再生可能な`.nsf`ファイルをダウンロードできる。MMLはppmck方式のコンパクトなバイトコード（音符1個が基本2〜3バイト、`src/nsf/mckBytecode.js`）にシリアライズされ、専用の6502ドライバ（`src/driver/ppmckDriver.js`、実機ppmckの設計を参考に新規実装）が解釈・再生する。NSFバンク切り替え（`$5FF8`-`$5FFF`、4KB窓×8）に対応しており、1チャンネルが4KBを超える曲データも複数バンクにまたがって正しく再生できる。2A03(A-D)に加えVRC6・MMC5・FME7・FDS・N163・VRC7の全拡張音源に対応（`MML.Mml.compile()`の正解データと突き合わせて実測確認済み）。**使用しているチップのハンドラ・波形/周期テーブルのみを条件付きで固定領域に埋め込む**設計のため、2A03のみの曲では未使用チップのデータは一切含まれない（固定領域実測: 2A03のみ5160B、全6チップ使用でも8431B）。FDS `@FM`・N163 `@N`・VRC7 `@OP`/`@OT`+`OP<n>`のカスタム波形・音色も、実際に定義されている場合のみテーブル・再ロード処理を条件付きで埋め込んで再生できる（定義が無ければ従来通り既定波形/ROMプリセットのみ）。DPCM・ループ最適化は未対応。詳細は`ROADMAP.md`フェーズ1.6参照
  - チャンネル割り当て: A=パルス1, B=パルス2, C=三角波, D=ノイズ
  - 出力はチャンネル別・フレーム単位のAPUレジスタ書き込みログ
- `src/mml/player.js` — `MML.Mml.render(source, opt)`：コンパイル結果を6502/NSFを介さず直接APU2A03に適用し、音声波形を生成（`captureSong()`と互換の戻り値）
- `index.html` / `src/main.js` — 「MML作曲」パネルを追加（コンパイル結果表示、キャプチャして再生・シークパネルで試聴）

### Phase 5: 拡張音源対応（VRC6, VRC7, FDS, MMC5, N163, FME-7）

- `src/emulator/expansion/vrc6.js` — `Emu.VRC6Audio`：パルスx2（16段デューティ）+ サウトゥース波（アキュムレータ方式、/14分周）
- `src/emulator/expansion/mmc5.js` — `Emu.MMC5Audio`：パルスx2（2A03パルスと同形式、スイープなし、$5000-5007/$5015）
- `src/emulator/expansion/fme7.js` — `Emu.FME7Audio`（Sunsoft 5B）：矩形波x3（AY-3-8910形式、$C000アドレスラッチ/$E000データ書き込み）
- `src/emulator/expansion/fds.js` — `Emu.FDSAudio`：64サンプル6bit波形メモリ音源（$4040-407F波形RAM + $4080/$4082/$4083/$4089制御）
- `src/emulator/expansion/n163.js` — `Emu.N163Audio`：128バイト内部RAMによる波形音源（$F800アドレス/$4800データのシンプル化プロトコル）
- `src/emulator/expansion/vrc7.js` — `Emu.VRC7Audio`：簡易2オペレータFM音源（16音色テーブル、$9010アドレス/$9030データ）
- `src/emulator/nsfBus.js` — `opt.extraChips`（`NSF.CHIP_FLAGS`）に応じて拡張音源インスタンスを生成し、各チップのアドレス範囲へのレジスタ書き込みをルーティング
- `src/emulator/nsfPlayer.js` — `renderFrame()`で拡張音源も`clock()`/`mixSample()`し、2A03出力に加算
- `index.html` / `src/main.js` — NSFヘッダ入力パネルに「拡張音源」セレクトボックスを追加（none/VRC6/VRC7/FDS/MMC5/N163/FME-7）、選択値が`extraChips`ヘッダフラグに反映される

### Phase 5: MMLコンパイラの拡張音源チャンネル対応

- `src/mml/compiler.js`
  - `CHANNEL_BASE`を絶対アドレス化（A=$4000, B=$4004, C=$4008, D=$400C, ステータス=$4015）
  - `opt.expansion`（none/vrc6/mmc5/fme7/fds/n163/vrc7）に応じてチャンネルE以降を割り当て:
    - VRC6: E=パルス1 F=パルス2 G=サウトゥース
    - MMC5: E=パルス1 F=パルス2
    - FME-7: E/F/G=矩形波A/B/C
    - FDS: E=波形メモリ音源
    - N163: E/F/G/H=波形音源(4ch, 16サンプル波形)
    - VRC7: E-J=FM音源(6ch)
  - 各チップ用の周波数→レジスタ値変換（サウトゥース分周, FME-7周期, FDS周期, N163周波数レジスタ, VRC7 fnum/block）を実装
  - 拡張音源使用時は初期化レジスタ書き込み（波形ロード、ミキサー設定等）をフレーム0に追加
- `src/mml/player.js` — `MML.Mml.render()`が`opt.expansion`に応じて対応する拡張音源モジュールを生成し、レジスタ書き込みをAPU/拡張音源へ振り分けてミックス
- `src/mml/sampleMml.js` — 拡張音源チャンネル用にEチャンネル（追加メロディ）のサンプルを追加
- `src/main.js` — 「MML作曲」パネルのコンパイル/キャプチャ時に、NSFヘッダの「拡張音源」選択値を`opt.expansion`として渡す

### Phase 6: 波形エディタ、DPCMコンバータ、シンタックスハイライトUI統合

- `src/mml/waveformEditor.js` — `MML.WaveformEditor`
  - canvasベースの波形エディタ（FDS: 64サンプル×6bit, N163: 16サンプル×4bit）
  - ドラッグでの波形編集、サイン波/三角波/サウトゥース/矩形波/ランダムのプリセット適用
  - `getFdsWave()` / `getN163Wave()` で現在の波形データを取得し、`MML.Mml.compile()`/`render()` の `opt.fdsWave` / `opt.n163Wave` に渡して拡張音源の初期波形として使用
- `src/dpcm/dpcmConverter.js` — `MML.Dpcm`
  - `DMC_RATE_TABLE_NTSC`（$4010レート0-15に対応する再生周波数テーブル）
  - `encode(samples, srcRate, rateIndex)`：PCM波形をリサンプリングし、2A03 DMCチャンネル用の1bitデルタ変調(DPCM)バイト列に変換（16バイト境界にパディング）
  - `decode(bytes, sampleCount)`：DPCMバイト列をプレビュー再生用PCM波形に復号
  - `hexDump(bytes)`：16進ダンプ生成
- `src/mml/syntaxHighlight.js` — `MML.Mml.highlight(source)` / `MML.Mml.attachHighlighter(textarea, overlay)`
  - チャンネル指定・音符・コマンド(`o l v q t @`)・オクターブ操作(`> <`)・タイ(`&`)・ループ(`[ ]`)・数値・コメントを色分け
  - textareaの背後にオーバーレイ`<pre>`を重ね、入力/スクロールに同期してハイライトHTMLを更新するオーバーレイ方式
- `index.html` / `src/main.js`
  - 「MML作曲」パネルのテキストエリアにシンタックスハイライトを統合
  - 「波形エディタ」パネルを追加（FDS/N163波形編集、プリセットボタン）
  - 「DPCMコンバータ」パネルを追加（音声ファイル読込→DPCM変換→ダンプ表示→プレビュー再生→バイナリダウンロード）

## 実行方法

ビルド不要。`index.html` をブラウザで直接開くだけで動作する（外部依存なし、classic `<script>` 読み込み）。
「▶ 試聴（エミュレータ再生）」でアセンブル→NSF生成→エミュレータ実行→3秒間のAudio再生を行う。
「キャプチャ実行」で指定秒数分を一括レンダーし、トランスポートUIで再生・シーク・早送り・巻き戻しができる。
「MML作曲」パネルでMMLを編集し「MMLコンパイル」で結果を確認、「MMLをキャプチャ」で再生・シークパネルに送って試聴できる。

「拡張音源」セレクトボックスでVRC6/VRC7/FDS/MMC5/N163/FME-7を選択すると、NSF生成時のヘッダフラグおよびMMLコンパイル/再生時の追加チャンネル（E以降）に反映される。
「波形エディタ」でFDS/N163の波形を編集すると、FDS/N163選択時のMMLコンパイル/キャプチャに反映される。
「DPCMコンバータ」で音声ファイルを選択して「変換」すると、DPCMバイナリのダンプが表示され、「プレビュー再生」で復号波形を試聴、「バイナリをダウンロード」でファイル保存できる。

## 今後のロードマップ

- Phase 6で計画されていた主要機能は実装済み。今後は実機転送用の最適化、ppmck拡張コマンド（エンベロープ・LFO等）への対応などが拡張候補。
