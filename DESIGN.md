# DESIGN.md — Sound Emulation Foundry 設計原則書

本書はこのプロジェクトの**恒久的な設計原則**を定める。すべての実装(人間・AIを問わず、
またどのモデルで作業する場合でも)は、着手前に本書を読み、**不変条件(INV)に違反しない**
ことを確認してから進めること。個々の機能の実装順序と受け入れ条件は [ROADMAP.md](ROADMAP.md) に定める。

## 0. ビジョン

ブラウザだけで完結する、エミュレータ音源ベースのチップチューン制作環境。

- **入口を増やす**: MML手書き(ppmck文化圏) → ピアノロール → MIDI録音 → 鼻歌、と
  入力手段を段階的に増やし、最終的にMMLを知らない人・スマホユーザーでも作れるようにする。
- **出口を増やす**: エミュ再生 → NSF/SPC書き出し → URL共有 → コンペ開催 → 他ツール連携。
- **読む機能が独自性**: nsf2mml/spc2mml/kss2mml による「既存曲→MML」の逆変換は
  他ツールにない資産。常に「作る」と「読む」の双方向を維持する。

---

## 1. 不変条件 (INVariants) — 絶対に破らないルール

### INV-1: 静的ホスティングのみで完全動作する

- ビルドサーバー・APIサーバー・DBを**アーキテクチャの前提にしない**。
  `index.html` + `src/` を任意の静的ファイルサーバー(GitHub Pages等)に置けば全機能が動くこと。
- npm/node/webpack等のビルドツールチェーンを導入しない。この環境にはNode/Pythonは無く、
  開発時のサーバーは `tools/static-server.ps1` (PowerShell) を使う。
- AudioWorklet用バンドル(`src/audio/*-worklet.js`)は例外的な「手動結合ビルド」であり、
  手順は `src/audio/README-worklet-build.txt` に従う(PowerShellのみで完結)。
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
  `src/asm/` `src/nsf/` `src/spc/` `src/kss/` `src/nsf2mml/` `src/spc2mml/` `src/kss2mml/`
  および将来の `src/ir/` `src/input/` `src/share/`。
  これらは `document`/`window.document`/DOM API を一切参照しないピュアJSであること
  (AudioWorklet内でも動く必要があるため。`globalThis` 置換でバンドルされる)。
- **UI層** = `src/main.js` `src/ui/` `index.html` `src/mml/syntaxHighlight.js`
  `src/mml/waveformEditor.js`。UI層はコア層を呼ぶが、逆は禁止。
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
- このためコンパイラは将来、各音符イベントにソース位置(何文字目〜何文字目)を
  記録する必要がある(ROADMAP フェーズ1参照)。

---

## 2. アーキテクチャ全体図

```
[入力層]                     [ハブ]              [出力層]
ppmck MMLパーサ ──────┐                    ┌────→ ppmck MML生成(正典) INV-2
NSF/SPC/KSS 解析 ─────┤                    ├────→ レジスタログ → エミュ再生
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
  continued?: boolean,  // 小節境界等で分割された継続音(タイで繋ぐ)
  srcRange?: [number, number]  // 原文MML内の文字位置 [開始,終了)。
                               //   部分書き戻し(INV-6)に使う。無い場合もある
}
```

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
| `src/emulator/` | 6502/APU/拡張音源エミュレータ | コア |
| `src/spc/` `src/kss/` | SPC700/Z80系エミュレータ | コア |
| `src/mml/` lexer/compiler/player | MMLコンパイル・直接レンダリング | コア |
| `src/convert/` | フォーマット非依存の BPM検出・音長量子化・MML生成 | コア |
| `src/nsf2mml/` `src/spc2mml/` `src/kss2mml/` | 各形式→ノート抽出 | コア |
| `src/ir/` (新設) | Song IR 定義・検証・移行・MML⇔IR変換 | コア |
| `src/input/` (新設) | MIDI/鼻歌/タップ → TimedPitchEvent → IR | コア(*) |
| `src/share/` (新設) | URL圧縮共有・コンペマニフェスト読み込み | コア |
| `src/vendor/` (新設) | 外部ライブラリの同梱コピー(lz-string等)。CDN読み込み禁止(INV-1) | — |
| `src/audio/` | AudioWorklet・ストリーム再生(手動結合バンドル含む) | 境界 |
| `src/i18n/` | 多言語辞書と文言取得(`MML.I18n`)。DOM非依存 | コア |
| `src/ui/` `src/main.js` `index.html` | UI(`src/ui/i18nDom.js` = 辞書のDOM適用・言語選択) | UI |
| `tools/` | 開発用: static-server.ps1、CPU検証ハーネス | 開発 |

(*) `src/input/` のうちマイク/MIDIデバイスアクセス部分(`navigator.*` を触る箇所)は
薄いアダプタとして分離し、変換ロジック本体はDOM/デバイス非依存に保つこと。

## 5. コーディング規約

- 各ファイルは既存と同じ **IIFE + `window.MML.名前空間`** パターン。ES modules化しない
  (Worklet手動結合バンドルが `)(window)` → `)(globalThis)` 置換で成立しているため)。
- `src/emulator/` 等バンドル対象(README-worklet-build.txt記載のファイル)を編集したら、
  **必ずWorkletバンドルを再ビルド**する。これを忘れるとメインスレッド側だけ直って
  ストリーミング再生側が古いままになる(過去に多発)。
- コメント・UI文言は日本語で書く。既存コードのコメント密度・命名に合わせる。
- **UI文言は日本語を「原文=辞書キー」として書き、表示は `MML.I18n.t()`(別名 `T()`)を通す**
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
- **他形式の音源を、レジスタ互換の近いNES拡張音源を借りて再生する*2mml変換
  (現状: KSSのPSG→FME-7、SCC→N163、FMPAC→VRC7。§0「読む機能が独自性」)を実装・拡張する際は、
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

## 6. 検証方法(この開発環境の前提)

- Node/Pythonは無い。動作確認は **PowerShell静的サーバー(`tools/static-server.ps1`)+
  ブラウザ内評価**で行う。
- CPUコアの検証ハーネス: `tools/6502-test.html` `tools/spc700-test.html` `tools/z80-test.html`
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
3. バンドル対象ファイルを触るか? → 触るならWorklet再ビルドまでが完了条件。
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
5. 受け入れ条件(ROADMAPの該当フェーズに記載)をどう確認するか、着手前に決めたか?
6. 既存機能の回帰確認(最低限: 既存MMLのコンパイル→再生、実NSF/SPC/KSSの1曲再生)を
   完了条件に含めたか?
