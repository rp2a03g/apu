# DESIGN.md — Sound Emulation Foundry 設計原則書

本書はこのプロジェクトの**恒久的な設計原則**を定める。すべての実装(人間・AIを問わず、
またどのモデルで作業する場合でも)は、着手前に本書を読み、**不変条件(INV)に違反しない**
ことを確認してから進めること。個々の機能の実装順序と受け入れ条件は [ROADMAP.md](ROADMAP.md) に定める。

## 0. ビジョン

ブラウザだけで完結する、エミュレータ音源ベースのチップチューン制作環境。

- **入口を増やす**: MML手書き(ppmck文化圏) → ピアノロール → MIDI録音 → 鼻歌、と
  入力手段を段階的に増やし、最終的にMMLを知らない人・スマホユーザーでも作れるようにする。
- **出口を増やす**: エミュ再生 → NSF/SPC書き出し → URL共有 → コンペ開催 → 他ツール連携。
- **読む機能が独自性**: nsf2mml/spc2mml/kss2mml/gbs2mml/hes2mml による「既存曲→MML」の
  逆変換は他ツールにない資産。常に「作る」と「読む」の双方向を維持する。

---

## 1. 不変条件 (INVariants) — 絶対に破らないルール

### INV-1: 静的ホスティングのみで完全動作する

- ビルドサーバー・APIサーバー・DBを**アーキテクチャの前提にしない**。
  `index.html` + `src/` を任意の静的ファイルサーバー(GitHub Pages等)に置けば全機能が動くこと。
- npm/node/webpack等のビルドツールチェーンを導入しない。この環境にはNode/Pythonは無く、
  開発時のサーバーは `tools/static-server.ps1` (PowerShell) を使う。
- キャプチャWorker用バンドル(`src/audio/*-capture-worker.js`)は例外的な「結合ビルド」であり、
  `tools/build-capture-workers.ps1` で生成する(PowerShellのみで完結)。仕組みは
  `src/audio/README-worker-build.txt` を参照。
  (AudioWorklet用バンドルは index.html から一度も参照されない未使用コードだったため2026-09-11に削除した)
- 将来サーバー機能(公式コンペ置き場・投票等)を作る場合も、それは**上乗せのオプション**とし、
  サーバーが無くてもツール本体の全機能が動く状態を保つ。

### INV-2: ppmck方言のMMLテキストが「正典」(真実の源)

- 曲の保存形式・共有形式・編集の最終的な書き込み先は常にMMLテキストである。
- 方言はppmck互換を基本とし、意図的に逸脱する場合は README の対応コマンド一覧に明記する。
- ピアノロール編集・鼻歌入力・AI支援など、どんな新しい編集手段も
  **最終的にMMLテキストへの変更として着地**させる。独自バイナリ形式を保存形式にしない。

### INV-3: ノートイベントIRがすべてのハブ

- 入力(MMLパース、NSF/SPC/KSS解析、MIDI録音、鼻歌、将来の他形式インポート)と
  出力(MML生成、ロール表示、エミュ再生、将来の他形式エクスポート)は、
  §3で定義する **Song IR** を経由して接続する。
- 新しい入力/出力を追加するとき、既存の入力/出力のコードを改造してはならない。
  「IRへの変換器」または「IRからの変換器」を**追加**する。
- ロールで発見した音程/タイミングのバグは、ロール側にパッチせず
  **共有抽出ロジック(src/convert/ や各 *2mml)側を直す**(ロールはIRのビューにすぎない)。

### INV-4: コアとUIの分離 — コアはDOMに触れない

- **コア層** = `src/emulator/` `src/mml/`(lexer/compiler/player) `src/convert/`
  `src/asm/` `src/nsf/` `src/spc/` `src/kss/` `src/gbs/` `src/hes/` `src/psf/` `src/dpcm/` `src/driver/`
  `src/nsf2mml/` `src/spc2mml/` `src/kss2mml/` `src/gbs2mml/` `src/hes2mml/`
  `src/vgm2mml/` `src/psf2mml/` `src/input/`、および将来の `src/ir/` `src/share/`。
  これらは `document`/`window.document`/DOM API を一切参照しないピュアJSであること
  (Web Worker内でも動く必要があるため。`globalThis` 置換でバンドルされる)。
- **UI層** = `src/main.js` `src/ui/` `index.html` `src/mml/syntaxHighlight.js`
  `src/mml/waveformEditor.js` `src/mml/defBlocks.js`。UI層はコア層を呼ぶが、逆は禁止。
  (`defBlocks.js` は定義ブロック `@TAG<n> = { ... }` の走査・書き戻しの共通モジュール。
  文字列を受けて文字列を返す部分だけならDOM非依存だが、textareaへ書き戻す
  `setSource`/`write`/`erase` を持つためUI層に置く。コア層からは呼ばない)
- アプリの状態(現在の曲・再生位置・選択チャンネル等)は将来UI層を丸ごと差し替えられる
  (モバイルUI追加)ことを想定し、UI固有のDOM構造に依存させず main.js 内で一元管理する。

### INV-5: 作品もコンペも「自己完結した成果物」

- 作品の共有単位は URL(MML圧縮埋め込み)・.mmlファイル・NSF/SPC等のバイナリであり、
  いずれも**受け取った側がサーバーなしで再生できる**こと。
- コンペは静的JSONマニフェスト(ROADMAP フェーズ7で仕様化)で定義し、
  誰でも自分の静的ホスティングに置くだけで開催できる。中央サーバーによる登録を要求しない。

### INV-6: 部分書き戻し — 人の書いたMMLを破壊しない

- IR経由の編集(ロール編集等)をMMLへ反映するときは、**変更された範囲のテキストだけを
  書き換え、それ以外の原文(ループ構造 `[ ]n`、マクロ、コメント、空白の癖)を保持**する。
- 「IR→MML全文再生成」で上書きする実装は禁止(ppmckユーザーの手書きMMLが壊れるため)。
  全文生成が許されるのは、原文MMLが存在しない場合(鼻歌からの新規作成、*2mml変換直後)のみ。
- ソース位置(srcStart/srcEnd)自体はlexer.js/compiler.jsで既に音符トークンに記録されている
  (再生ハイライト機能用)。フェーズ1で残っているのは、これをsrc/ir/のSong IR srcRangeとして
  正式に露出させる部分のみ(ROADMAP フェーズ1参照)。

---

## 2. アーキテクチャ全体図

```
[入力層]                     [ハブ]              [出力層]
ppmck MMLパーサ ──────┐                    ┌────→ ppmck MML生成(正典) INV-2
NSF/SPC/KSS/GBS/HES 解析┤                    ├────→ レジスタログ → エミュ再生
Web MIDI 録音 ────────┼──→  Song IR  ──────┼────→ NSF/ROM 書き出し
鼻歌ピッチ検出 ────────┤    (src/ir/)       ├────→ ピアノロール 表示/編集
タップリズム ─────────┤                    ├────→ FamiStudio等 テキスト(将来)
FamiTracker等(将来) ──┘                    └────→ 動画書き出し(将来)

補助パイプライン(入力層の共通部品):
  MIDI/鼻歌/タップ → TimedPitchEvent列 → 量子化(src/convert/) → IRイベント → MML生成
```

- 実再生経路(現状の `MML.Mml.render()` = MML→レジスタログ→APU直接駆動)は温存する。
  IRは「編集・変換・可視化」のためのハブであり、再生音質の経路を変えるものではない。

## 3. Song IR 仕様 (version 1)

IRは**プレーンなJSONシリアライズ可能オブジェクト**とする(クラスインスタンス禁止。
structuredClone/JSON.stringifyがそのまま通ること)。

```js
{
  version: 1,
  meta: {
    title: string|null,
    fps: number,        // フレームレート。NSF≈60.0988, KSS 60/50, SPCはエンジンtick
    bpm: number,        // テンポ(検出 or 指定)
    fpb: number         // 1拍(4分音符)あたりのフレーム数 = fps * 60 / bpm
  },
  instruments: {        // 音色定義。キーは "@番号" の番号(文字列化)
    "0": { /* 形式は音源依存。duty, envelope, wave等。当面は自由形式 */ }
  },
  channels: [
    {
      letter: string,   // MMLチャンネル文字 ('A'〜)。compiler.jsの割当に従う
      chip:   string,   // '2A03'|'VRC6'|'VRC7'|'FDS'|'MMC5'|'N163'|'FME7'|'SPC'|'PSG'|'SCC'|'OPLL'
      voice:  string,   // 'pulse1'|'triangle'|'noise'|'wave'|... チップ内の声部名
      events: [ NoteEvent, ... ]   // start昇順
    }
  ]
}
```

**NoteEvent** は `src/convert/mmlEmit.js` が既に受け取っているイベント形式の正式化である:

```js
{
  start: number,        // フレーム単位(曲頭=0)
  end: number,          // 終了フレーム(排他)
  note: number|null,    // null=休符。note = octave*12 + 半音(c=0)。
                        //   mmlEmit.noteNumberToMmlParts() と同一の規約
  volume?: number,
  instrument?: number,
  envelopeV?: number, envelopeVr?: number,
  detune?: number,      // D<n>。変換先チップの周期/周波数レジスタへの生オフセット定数
  pitchEp?: number,     // EP<n>参照インデックス(下記pitchMod分類結果をレジストリ登録した番号)。
                        //   mmlEmit.jsはこの数値だけを見る(DESIGN-PITCH.md Phase 1)
  pitchEpDelay?: number, // EP<n>,<delay>のdelay(別プロジェクトA、2026-08-11実装済み)
  vibrato?: number,      // MP<n>参照インデックス(周期ビブラートがlfo_sub厳密再現可能な
                        //   場合のみ。別プロジェクトB gate解除、2026-08-15実装。
                        //   fitできなければ従来通りpitchEpのループEPへフォールバックする)
  portamento?: { target: number, duration: number, delay: number }, // PT<target>,<duration>[,<delay>]
                        //   (別プロジェクトC、2026-08-11実装済み)
  noteEnv?: number,      // EN<n>参照インデックス(高速アルペジオ、2026-08-14実装済み。
                        //   ノート番号空間の累積オフセットのためVRC7でも使える)
  pitchMod?: {          // 分類の中間結果(IR上はオプション、無くても良い。実装は
                        //   src/convert/pitch.js の classifyPitchMod の戻り値そのもの)
    type: 'periodic' | 'literal' | 'ramp', // periodic=周期ビブラート(Phase 1)、
                        //   literal/ramp=非周期の装飾(こぶし/アタックベンド/ランプ、Phase 3)。
                        //   'ramp'は単調増加/減少、'literal'はそれ以外の任意形状
    delay: number,      // 区間先頭の実測ゼロフレーム数(別プロジェクトAでvaluesと分離済み)
    values: number[]    // periodicは1周期分、literal/rampは区間全体の生レジスタオフセット
                        //   差分列(末尾は同一値足踏みをtrim済み)。ループ無し(literal/ramp)は
                        //   テーブル末尾到達後、最終値を永久ホールドする
                        //   (src/mml/compiler.js stepEnvelope参照)
  },
  continued?: boolean,  // 小節境界等で分割された継続音(タイで繋ぐ)
  srcRange?: [number, number]  // 原文MML内の文字位置 [開始,終了)。
                               //   部分書き戻し(INV-6)に使う。無い場合もある
}
```

`pitchMod`/`pitchEp`は DESIGN-PITCH.md Phase 1 で追加(厳密周期ビブラート→ループ`EP<n>`)、
`type:'literal'/'ramp'`は Phase 3 で追加(非周期の装飾→非ループ`EP<n>`)。その後の別プロジェクトで
`pitchEpDelay`(A)・`portamento`(C)・`vibrato`(B、gate解除は2026-08-15)・`noteEnv`(EN、2026-08-14)が
追加されている。`src/ir/`(Song IR実装)がまだ存在しないため`MML.IR.validate`への型チェック追加は未着手。
`src/ir/`実装時にこのフィールドの型チェックも忘れずに追加すること。

**TimedPitchEvent**(リアルタイム入力の共通形式。量子化前):

```js
{ timeSec: number, midiNote: number|null, velocity?: number }
// null=無音区間。鼻歌検出は freqHz→midiNote 変換後にこの形式で出力する
```

### IRに関する規約

- 時間はすべて**フレーム単位**(既存の全コードと一致)。秒が必要な出口で fps から換算する。
- `src/ir/` に置く関数はすべて `MML.IR.*` 名前空間に生やす(既存の `MML.Convert.*` 等と同様の
  IIFE + `window`(コアなので実際は `global`) パターン)。
- IRの構造を変えるときは `version` を上げ、旧versionの読み込み互換を `MML.IR.migrate()` で維持する。

## 4. モジュールマップ

| ディレクトリ | 役割 | 層 |
|---|---|---|
| `src/asm/` `src/nsf/` | 6502アセンブラ・NSF生成 | コア |
| `src/driver/` | MML→NSFバイトコードを再生する6502ドライバ(ppmckDriver.js) | コア |
| `src/dpcm/` | 音声→DPCM(2A03 DMC)変換 | コア |
| `src/emulator/` | 6502/APU/拡張音源エミュレータ | コア |
| `src/spc/` `src/kss/` `src/gbs/` `src/hes/` | SPC700/Z80/SM83/HuC6280系ヘッダ解析 | コア |
| `src/vgm/` | VGMヘッダ解析(チップクロック表/ループ/GD3) | コア |
| `src/archive/` | zip(セントラルディレクトリ/deflate-raw)・7z(ヘッダ解析+自前LZMA/LZMA2展開)・gzip の汎用リーダー。全形式共通の「曲リストの器」(SPC等の1ファイル1曲形式もアーカイブで曲送り) | コア |
| `src/mml/` lexer/compiler/player | MMLコンパイル・直接レンダリング | コア |
| `src/convert/` | フォーマット非依存の BPM検出・音長量子化・MML生成 | コア |
| `src/score/` | 楽譜出力: compile() の noteList(音価付き音符列)→表記モデル(notation.js: 小節/タイ/連符/連桁/臨時記号/調。buildPianoNotation で右手/左手の和音2段にも畳む)→MusicXML(musicxml.js)/記譜間隔の段組みと canvas 描画(engrave.js、楽譜ウィンドウ src/ui/scoreView.js)。入力側は musicxmlImport.js(+xmlLite.js)が MusicXML/.mxl を MML にする。入口は MML の音価だけ(ロールのレジスタ由来データは使わない)。描画は自前(外部楽譜ライブラリ同梱禁止、ROADMAP「フェーズ外: 楽譜出力」) | コア |
| `src/nsf2mml/` `src/spc2mml/` `src/kss2mml/` `src/gbs2mml/` `src/hes2mml/` `src/vgm2mml/` | 各形式→ノート抽出(vgm2mmlはチップファミリごとに他の*2mmlへ委譲。kss/gbs/hesは`convertCapture`でキャプチャと変換を分離済み) | コア |
| `src/ir/` (新設) | Song IR 定義・検証・移行・MML⇔IR変換 | コア |
| `src/input/` | メトロノーム(metronome.js)・入力レイテンシ/時間軸写像(latency.js)・演奏入力の合流点(noteSource.js: 全入力源 → TimedPitchEvent)・PC鍵盤の配列(keyMap.js)・tick格子への量子化と和音のまとめ(quantize.js)・Web MIDIアダプタ(midiInput.js)。今後 鼻歌(pitchDetect.js/micInput.js)を足す | コア(*) |
| `src/share/` (新設) | URL圧縮共有・コンペマニフェスト読み込み | コア |
| `src/vendor/` (新設) | 外部ライブラリの同梱コピー(lz-string等)。CDN読み込み禁止(INV-1) | — |
| `src/audio/` | ストリーム再生・キャプチャWorker(結合バンドル含む) | 境界 |
| `src/i18n/` | 多言語辞書と文言取得(`MML.I18n`)。DOM非依存 | コア |
| `src/ui/` `src/main.js` `index.html` | UI(`src/ui/i18nDom.js` = 辞書のDOM適用・言語選択) | UI |
| `tools/` | 開発用: static-server.ps1、CPU検証ハーネス | 開発 |

(*) `src/input/` のうちマイク/MIDIデバイスアクセス部分(`navigator.*` を触る箇所)は
薄いアダプタとして分離し、変換ロジック本体はDOM/デバイス非依存に保つこと。

## 5. コーディング規約

- 各ファイルは既存と同じ **IIFE + `window.MML.名前空間`** パターン。ES modules化しない
  (キャプチャWorkerバンドルが `)(window)` → `)(globalThis)` 置換で成立しているため)。
- `src/emulator/` `src/ui/keyboard.js` 等バンドル対象(`tools/build-capture-workers.ps1` の
  `Files` に載っているファイル)を編集したら、**必ず `tools/build-capture-workers.ps1` を
  実行して再ビルド**する。これを忘れるとメインスレッド側だけ直ってWorker側が古いままになる
  (過去に多発)。クライアントは鮮度チェックで警告を出すが、頼らず必ず再ビルドすること。
- コメント・UI文言は日本語で書く。既存コードのコメント密度・命名に合わせる。
- **UI文言は日本語を「原文=辞書キー」として書き、表示は `MML.I18n.t()`(別名 `T()`)を通す**
  - 追加する原文が**辞書に既にあるか必ず確認する**。`src/i18n/en.js` は素のオブジェクトなので
    同じキーを2回書くと後勝ちで前の訳が黙って消える。同じ語を別の意味で使うときは
    `原文|文脈` 形式のキーにする(例 `三角波|干渉源`。`t()` が `|` 以降を落として原文へ戻す)。
    `tools/headless/check-all.js` の i18n lint が訳違いの重複を失敗として検出する。
  (gettext式。ビルドツールを導入できない INV-1 の制約下でキー名の二重管理を避けるため)。
  - `index.html` の静的文言は属性を足さなくてよい。`src/ui/i18nDom.js` がDOMを走査して
    辞書に載っている日本語を自動置換する(除外: `textarea` / `.output` / `[data-i18n-skip]`)。
  - JSが組み立てる文言は必ず `T('原文', { param })` を通す。埋め込み値は `{name}` で書く。
  - 言語の追加は `src/i18n/<code>.js` を1つ足して `index.html` に `<script>` を1行足すだけ。
    UIの言語選択肢は登録済み辞書から自動生成される。
  - 開発者向けの `console.*` ログとコード中のコメントは翻訳しない(日本語のまま)。
  - 翻訳漏れの点検: 英語表示にして `MML.I18n.missing('en', MML.UI.I18nDom.untranslated())`。
- エミュレータの精度修正は必ず実測根拠(SingleStepTests、実機由来ドキュメント、実NSF/SPCでの
  聴感確認)とセットで行い、既存曲の回帰確認をする。
- **チャンネルの音量/ピッチがチップ内蔵のハードウェアユニット(エンベロープ/LFO/変調等)で
  「レジスタ再書込み無しに内部クロックだけで」進行する場合、その内部クロックとドライバの
  PLAY呼び出し頻度(フレームレート)が独立した別クロックであることを必ず意識すること。**
  抽出コードが「駆動フレーム境界でその時点の値をそのまま読む(1フレーム1サンプル)」方式を
  取ると、値自体はサイクル精度エミュレータなので毎回正しくても、2つのクロックの比が
  単純な整数比でない場合、**同一形状のハードウェアエンベロープでもトリガーされた絶対位置
  次第で観測される段数が変わってしまう**(位相エイリアシング)。これは「もっと細かく
  サンプリングする」対策では直らない(同じ瞬間を読んでも同じ値が返るだけ)。実例:
  GBS(Game Boy)のCH1/CH2/CH4は固定64Hzのハードウェアエンベロープクロックを持つが、
  ドライバのPLAY頻度(playFps)はGBSリップ毎に非整数・可変(例: 59.7275Hz)で、単純な
  整数比にならないため、`@v<n>`(ソフトウェア音量エンベロープテーブル)が本来同一のはずの
  形状で大量に疑似重複していた(実測: 1曲で88個→本来20個程度)。
  新しいフォーマット/チップを追加・拡張する際は、そのチャンネルに該当するハードウェア
  ユニットがあるかどうかをまず確認し、あれば次のいずれかの安全な方式を取ること
  (「駆動フレーム境界で値をそのまま読む」方式は、その内部クロックが *証明可能に*
  ドライバのフレームレートの固定・厳密な整数倍になっている場合(例: NSFネイティブ2A03/MMC5の
  エンベロープ=240Hzクロックが、抽出側の固定60.0988Hzフレームレートのちょうど4倍)にのみ許容できる):
  1. **ハードウェア・パススルー**: 減衰値そのものはソフトウェア的にシミュレートせず、
     周期/形状/音色などの「設定」だけを抽出し、コンパイル後のMML再生時に変換先チップ自身の
     同種ハードウェアユニットへその設定を書き込んで、実時間でリアルタイムに動かす。
     疑似乱数的な位相ズレが原理的に発生しない(実例: FME-7ハードエンベロープの
     `fme7EnvShape`/`fme7EnvPeriod`、VRC7/OPLLのTL+キーオン/キーオフによるADSR、
     `src/nsf2mml/expansion/fme7.js`・`src/nsf2mml/expansion/vrc7.js`・
     `src/kss2mml/expansion/opll.js`)。
  2. **解析的/サイクル精度の再計算**: トリガー時点(またはCPUサイクル単位の経過時間)を
     起点に、実機と同じ式(例: `floor(経過クロック数/period)`)で値を直接計算し直す。
     位相非依存になるため同一形状は常に同一の数値列になる(実例: SPCの`ADSR`/`GAIN`は
     `simulateSpcEnvelope`でDSPの真の32000Hzクロックドメインをそのままティック単位で
     シミュレート、FDSの音量/変調エンベロープは`advanceEnvelope(elapsed)`でCPUサイクル
     単位に丸ごとシミュレート、GBSは`src/gbs2mml/expansion/hwEnvelope.js`の
     `volumeAt`/`updateAnchor`でトリガー起点の解析式を使う)。
  ハードウェアユニットが無い(音量/ピッチがCPUの直接レジスタ書込みだけで決まる)チャンネル
  ではこの問題は起こらない(駆動フレームと同じクロックでしか値が変化しないため)。
  2026-08時点の全フォーマットの監査結果: GBSのCH1/CH2/CH4(ハードウェアエンベロープを
  素朴にサンプリングしていた)のみがこの問題を持っていた。KSSのAY/PSGハードウェア
  エンベロープは別の理由(未実装、使用時は一律最大音量15として簡略化)で影響を受けない
  (ただしこちらはこちらで別の精度課題として残っている)。
- **他形式の音源を、レジスタ互換の近いNES拡張音源を借りて再生する*2mml変換
  (現状: KSSのPSG→FME-7、SCC→N163、FMPAC→VRC7、GBSのCH1/CH2→2A03パルス・CH3→FDS、
  HESのPSG波形→N163・DDA→DMC。§0「読む機能が独自性」)を実装・拡張する際は、
  必ず `src/convert/detune.js` の `MML.Convert.applyPitchDetune()` で音程補正すること。**
  変換元と変換先はチップの入力クロック・レジスタ格子が異なるため、「実測周波数→12平均律の
  最寄りノート番号へ丸め」→「変換先チップの最寄りレジスタ値へ再量子化」という二重の丸めが
  発生し、素直に変換すると特に高音域で原曲より音程がズレる(KSS→FME-7、Final Fantasy(MSX)
  で実証)。`applyPitchDetune`は実測周波数に一番近い変換先レジスタ値をD<n>(生レジスタ
  オフセット)で明示することでこれを補正する。ただし聴感上10セント未満のズレ(`opts.minCents`
  既定10、JNDおよびチューナーの許容幅を参考に決定)は無視し、無意味なD<n>でMMLが
  見づらくなるのを避ける。**KSSに限らず、将来NSF/SPC/その他フォーマットが同種のチップ借用
  (別クロックの音源をFME-7/N163/VRC7等で近似再生)を行う場合も、この枠組みを同様に適用する。**
- **一方、変換元と変換先が同一チップ・同一クロックの「ネイティブ変換」
  (現状: NSF→2A03本体+VRC6/MMC5/FME7/N163/VRC7/FDS各拡張音源)には `applyPitchDetune` を
  使わず、同じ `src/convert/detune.js` の `MML.Convert.detectChorusDetune()` を使うこと。**
  ネイティブ変換は借用変換と違い変換先チップの格子が粗くなる要因が無いため、単独ノートの
  実測誤差はほぼノイズであり補正すべきではない。`detectChorusDetune`は「異なるチャンネルが
  同じノート番号を同時に鳴らしている(コーラス/デチューン効果)」場合に限ってD<n>を付与し、
  単独ノートは理論値からどれだけ離れていても無補正のままにする(グループ内の判定ロジックは
  同ファイルのコメント参照)。**この使い分け(借用変換=applyPitchDetune、ネイティブ変換=
  detectChorusDetune)を取り違えないこと**: ネイティブ変換にapplyPitchDetuneを使うと単独
  ノートのノイズまで誤って補正してしまい、借用変換にdetectChorusDetuneを使うと単独ノートの
  二重量子化ズレ(本来の問題)が無補正のまま残ってしまう。
- **D<n> の値は「実測値をレジスタ格子へ丸めた整数 − テーブルの整数値」で求めること(2026-09-07)。**
  再生側(compiler.js / ppmckDriver.js)が鳴らすのは「周波数テーブルの整数値 round(理論値) + D」
  なので、round(実測 − 理論値) のように差を取ってから丸めると、テーブル側の丸めと逆向きに出た
  ときに1格子ずれる(FME-7 の o6 では1格子≈48セント=半音転ぶ。Final Fantasy(MSX2, PSG) 1曲目で
  実証、音程検証28件不一致→0件)。`detectChorusDetune` はコーラス幅を「丸めた実測値同士の整数差」で
  保ち、グループ全体の1格子ずれ(rc≠T)は「その音域の1格子が10セント以上」のときだけ全員に足す
  (中音域の数セントの格子ずれで意味の無い D±1 を量産しない)。詳細は detune.js 冒頭コメント。
- **どちらの経路でも、周波数→ノート番号の丸めは `MML.Convert.freqToNote()`(src/convert/options.js)
  を使い、独自に `Math.round(57 + 12*log2(f/440))` を書かないこと(2026-09-07)。** 曲全体の基準ピッチ
  (`#TUNING`、セント)はここ1か所で効いている。ドライバ固有の音程表で曲全体が数十セントずれている曲は、
  A440基準のままだと借用変換で全音符に無意味なD<n>が付き、ネイティブ変換では系統的にずれた音程で鳴り、
  偏差が±50セント付近なら音符ごとに丸めの向きが変わって半音が転ぶ。`MML.Convert.autoTune()` が全音符の
  偏差(長さ重み付き中央値、`detectTuning`)を測り、閾値以上ならその基準で変換本体をもう一度走らせて
  `#TUNING` をヘッダに出す。理論値側(`detune.js idealFreqOf`、`pitch.js centsFromNearestSemitone`、
  `compiler.js`/`ppmckDriver.js` の `noteFrequency`、`keyboard.js freqToMidi`)も同じ値を見るので、
  抽出・再生・NSF書き出し・音程検証・ロール表示の基準が常に一致する。音名は変わらない
  (キー/トランスポーズとは別の、チューナーの A4=447Hz のような全体ずらし)。

## 6. 検証方法(この開発環境の前提)

- Node/Pythonは無い。動作確認は **PowerShell静的サーバー(`tools/static-server.ps1`)+
  ブラウザ内評価**で行う。
- CPUコアの検証ハーネス: `tools/6502-test.html` `tools/spc700-test.html` `tools/z80-test.html`
  `tools/sm83-test.html`
  (SingleStepTests形式)。CPU/音源コアを触ったら該当ハーネスを回す。
- ブラウザで音を再生して検証したら、**ターン終了前に必ず停止ボタンで音を止める**。
- Browser paneは非表示タブで requestAnimationFrame が発火しない。rAF依存UIの検証は
  メソッド直接呼び出し+合成データで行う。

## 7. 実装前チェックリスト(全モデル共通)

新しい変更に着手する前に、次を自問すること:

1. この変更は INV-1〜6 のどれかに違反しないか?
   (特に: サーバー前提にしていないか / MML以外を保存形式にしていないか /
   IRを迂回して入力と出力を直結していないか / コアからDOMを触っていないか /
   MML全文再生成で上書きしていないか)
2. ROADMAP.md の現在フェーズの範囲内か? 範囲外の作業を混ぜていないか?
3. バンドル対象ファイルを触るか? → 触るならキャプチャWorkerバンドル再ビルドまでが完了条件。
4. **ユーザーに見える文言を追加/変更するか? → §5のi18n規約に従ったか?**
   新しいUI文言は「日本語の原文をキーにして `T()` を通し、同じ原文の訳を `src/i18n/en.js`
   にも追加する」までが完了条件。日本語だけ足して英語辞書を放置しない。
   - 静的HTMLの文言: `index.html` に属性を足す必要はない(DOM走査が拾う)が、
     **辞書への追加は必要**。
   - JSが組み立てる文言: `T('原文', { param })` を通す。値の埋め込みは文字列連結ではなく
     必ず `{name}` にする(語順が言語で変わるため、連結すると訳せなくなる)。
   - チャンネル名等を埋め込んだ文言を持つウィジェットを新設したら、`MML.I18n.onChange`
     で自分のDOMを作り直す(DOM走査では原理的に訳せないため。前例: `src/ui/keyboard.js`)。
   - 確認: 対象ウィンドウを開いて英語へ切り替え、
     `MML.I18n.missing('en', MML.UI.I18nDom.untranslated())` が空であること。
   - 翻訳しないもの: コード中のコメント、`console.*` の開発ログ、MMLコマンド/レジスタ名/
     チップ名などの識別子。
5. **新しいフォーマット/チップを追加・拡張するか? → §5の位相エイリアシング注意点を
   確認したか?** そのチャンネルに「レジスタ再書込み無しに内部クロックだけで進行する」
   ハードウェアユニット(エンベロープ/LFO/変調等)があるか確認し、あれば抽出方式が
   ハードウェア・パススルーか解析的/サイクル精度の再計算のどちらかになっているか
   (駆動フレーム境界で値をそのまま読むだけの実装になっていないか)を確認する。
6. 受け入れ条件(ROADMAPの該当フェーズに記載)をどう確認するか、着手前に決めたか?
7. 既存機能の回帰確認(最低限: 既存MMLのコンパイル→再生、実NSF/SPC/KSSの1曲再生)を
   完了条件に含めたか?
