/*
 * MML字句解析
 * - ソース全体をチャンネル(A-Z)別のコマンド文字列に分割
 * - チャンネルごとのコマンド文字列をトークン列に変換
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Mml = MML.Mml = MML.Mml || {};
  // 表示文言の翻訳 (src/i18n/i18n.js)。キーは日本語の原文。MML.I18nが無い環境でも動くよう素通し
  const T = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  // @v<n> = { ... } / @vr<n> = { ... } 音量エンベロープ定義行のパース
  // { } 内はカンマ/空白区切りの0-15の値の列。"|" があればそこがループ位置になり、
  // 演奏が末尾まで達したらそこへ戻る。省略時は末尾の値を保持し続ける。
  const ENVELOPE_DEF_RE = /^@v(r?)(\d+)\s*=\s*\{([^}]*)\}$/i;

  function parseEnvelopeDef(trimmed) {
    const m = trimmed.match(ENVELOPE_DEF_RE);
    if (!m) return null;
    const isRelease = m[1].toLowerCase() === 'r';
    const index = parseInt(m[2], 10);
    const parts = m[3].trim().split(/[\s,]+/).filter(s => s.length > 0);
    const values = [];
    let loop = null;
    for (const part of parts) {
      if (part === '|') { loop = values.length; continue; }
      const n = parseInt(part, 10);
      if (!isNaN(n)) values.push(n);
    }
    return { isRelease, index, table: { values, loop } };
  }

  // @<n> = { ... } デューティ(音色)エンベロープ定義行のパース(実機ppmckのgetTone/tone_tbl)。
  // { } 内は0-7の値の列で、@v<n>と全く同じ書式("|"でループ位置指定、省略時は末尾保持)。
  // トラック中で @@<n> と書くとこのテーブルが選ばれ、1フレーム1ステップでデューティが
  // 変化する(@<n>単体は「固定デューティ+エンベロープ解除」で別物)。
  // ★@v/@EP/@OP/@FM等の他の定義行と紛れないよう、@の直後が数字の場合のみ一致させる
  const TONE_ENVELOPE_DEF_RE = /^@(\d+)\s*=\s*\{([^}]*)\}$/;

  function parseToneEnvelopeDef(trimmed) {
    const m = trimmed.match(TONE_ENVELOPE_DEF_RE);
    if (!m) return null;
    const index = parseInt(m[1], 10);
    const parts = m[2].trim().split(/[\s,]+/).filter(s => s.length > 0);
    const values = [];
    let loop = null;
    for (const part of parts) {
      if (part === '|') { loop = values.length; continue; }
      const n = parseInt(part, 10);
      if (!isNaN(n)) values.push(n);
    }
    return { index, table: { values, loop } };
  }

  // @EP<n> = { ... | ... } (ピッチエンベロープ, -127~126, ループ可)
  // @EN<n> = { ... | ... } (ノートエンベロープ=アルペジオ, 前回値からの相対値, -127~126, ループ可)
  // どちらも @v/@vr と同じテーブル書式(値は符号付き)なので同じパーサを流用する
  const PITCH_NOTE_ENVELOPE_DEF_RE = /^@(EP|EN)(\d+)\s*=\s*\{([^}]*)\}$/i;

  function parsePitchNoteEnvelopeDef(trimmed) {
    const m = trimmed.match(PITCH_NOTE_ENVELOPE_DEF_RE);
    if (!m) return null;
    const kind = m[1].toLowerCase(); // 'ep' | 'en'
    const index = parseInt(m[2], 10);
    const parts = m[3].trim().split(/[\s,]+/).filter(s => s.length > 0);
    const values = [];
    let loop = null;
    for (const part of parts) {
      if (part === '|') { loop = values.length; continue; }
      const n = parseInt(part, 10);
      if (!isNaN(n)) values.push(n);
    }
    return { kind, index, table: { values, loop } };
  }

  // @MP<n> = { delay, speed, depth, decay } (ソフトウェアビブラート/LFO)。
  // decay(param4)は実際のppmckドライバでも未対応("0を入れておいてください")なので無視する
  const VIBRATO_DEF_RE = /^@MP(\d+)\s*=\s*\{([^}]*)\}$/i;

  function parseVibratoDef(trimmed) {
    const m = trimmed.match(VIBRATO_DEF_RE);
    if (!m) return null;
    const index = parseInt(m[1], 10);
    const parts = m[2].trim().split(/[\s,]+/).filter(s => s.length > 0).map(s => parseInt(s, 10));
    return {
      index,
      params: {
        delay: parts[0] || 0,
        speed: parts[1] || 1,
        depth: parts[2] || 0
      }
    };
  }

  // 定義ブロック内の数値1個をパースする。"$XX"形式の16進数にも対応する
  // (ppmckの @OP 音色定義例が "$00,$00,..." 形式のため)
  function parseMmlNumber(s) {
    if (s[0] === '$') return parseInt(s.slice(1), 16);
    return parseInt(s, 10);
  }

  // @OP<n> = { 8バイト } (VRC7カスタム音色。生の8バイトをそのままVRC7レジスタ$00-$07へ)
  const VRC7_TONE_DEF_RE = /^@OP(\d+)\s*=\s*\{([^}]*)\}$/i;

  function parseVrc7ToneDef(trimmed) {
    const m = trimmed.match(VRC7_TONE_DEF_RE);
    if (!m) return null;
    const index = parseInt(m[1], 10);
    const bytes = m[2].trim().split(/[\s,]+/).filter(s => s.length > 0).map(parseMmlNumber);
    return { index, bytes };
  }

  // @FM<n> = { 64個の0-63 } (FDS波形メモリ)
  const FDS_WAVE_DEF_RE = /^@FM(\d+)\s*=\s*\{([^}]*)\}$/i;

  function parseFdsWaveDef(trimmed) {
    const m = trimmed.match(FDS_WAVE_DEF_RE);
    if (!m) return null;
    const index = parseInt(m[1], 10);
    const values = m[2].trim().split(/[\s,]+/).filter(s => s.length > 0).map(parseMmlNumber);
    return { index, values };
  }

  // @N<n> = { バッファ番号, 波形値... } (N163波形)。
  // 先頭のバッファ番号はppmck書式互換のためのダミー(内蔵RAMへの配置は
  // src/mml/n163Alloc.jsの共有バッファアロケータが自動で行う)なので読み飛ばす。
  // 残りの値(各0-15)がそのまま波形になり、その個数=波形長(4〜128サンプル、
  // 実機レジスタの制約で4の倍数へ切り上げ。roundedLen/normalizeN163Wave参照)。
  const N163_WAVE_DEF_RE = /^@N(\d+)\s*=\s*\{([^}]*)\}$/i;

  function parseN163WaveDef(trimmed) {
    const m = trimmed.match(N163_WAVE_DEF_RE);
    if (!m) return null;
    const index = parseInt(m[1], 10);
    const parts = m[2].trim().split(/[\s,]+/).filter(s => s.length > 0).map(parseMmlNumber);
    const values = parts.slice(1); // 先頭はバッファ番号なので除く
    return { index, values };
  }

  // @OT<n> = { TL,FB, AR,DR,SL,RR,KL,ML,AM,VB,EG,KR,DT(モジュレータ), 同11個(キャリア) }
  // MGSDRV互換の音色定義書式。VRC7/OPLLの8バイト生レジスタ形式(@OP)に変換して、
  // 同じ envelopes.op に格納する(OP<n>コマンド側はOP/OT定義の区別を意識しなくてよい)。
  // バイト配置は https://wikiwiki.jp/mck/VRC7のユーザー定義音色 の記載
  // (バイト1/2=AM,VIB,EGTYP,KSR,MULTI、バイト3=KSL,TL(モジュレータのみ)、
  //  バイト4=DC,DM,FB、バイト5-8=AR,DR / SL,RR)に基づく。
  // 「DT」はページの説明("DC及びDMの略")から、各オペレータ行末のDTがその
  // オペレータ自身の波形選択ビット(モジュレータ行→DM、キャリア行→DC)を表すと解釈した
  // (この解釈は未検証の近似。ROADMAP.mdフェーズ1.5参照)
  const VRC7_TONE_ALT_DEF_RE = /^@OT(\d+)\s*=\s*\{([^}]*)\}$/i;

  function parseVrc7ToneAltDef(trimmed) {
    const m = trimmed.match(VRC7_TONE_ALT_DEF_RE);
    if (!m) return null;
    const index = parseInt(m[1], 10);
    const parts = m[2].trim().split(/[\s,]+/).filter(s => s.length > 0).map(parseMmlNumber);
    if (parts.length < 24) return { index, bytes: null };
    const TL = parts[0], FB = parts[1];
    const mod = parts.slice(2, 13);
    const car = parts.slice(13, 24);
    const [mAR, mDR, mSL, mRR, mKL, mML, mAM, mVB, mEG, mKR, mDT] = mod;
    const [cAR, cDR, cSL, cRR, cKL, cML, cAM, cVB, cEG, cKR, cDT] = car;
    const bytes = [
      ((mAM & 1) << 7) | ((mVB & 1) << 6) | ((mEG & 1) << 5) | ((mKR & 1) << 4) | (mML & 15),
      ((cAM & 1) << 7) | ((cVB & 1) << 6) | ((cEG & 1) << 5) | ((cKR & 1) << 4) | (cML & 15),
      ((mKL & 3) << 6) | (TL & 63),
      ((cKL & 3) << 6) | ((cDT & 1) << 4) | ((mDT & 1) << 3) | (FB & 7),
      ((mAR & 15) << 4) | (mDR & 15),
      ((cAR & 15) << 4) | (cDR & 15),
      ((mSL & 15) << 4) | (mRR & 15),
      ((cSL & 15) << 4) | (cRR & 15)
    ];
    return { index, bytes };
  }

  // @MW<n> = { 32個の変調量 } (FDSモジュレータテーブル)。
  // ★MML上は「実際の増減量そのもの」を書く: 0(維持) / 1 / 2 / 4 / -1 / -2 / -4 と
  //   R(変調カウンタを0にリセット)。それ以外の値はコンパイルエラーにする。
  // 実機のテーブルエントリは3bitのコード値(0=+0,1=+1,2=+2,3=+4,4=リセット,5=-4,
  // 6=-2,7=-1。src/emulator/expansion/fds.js MOD_TABLE_DELTA)なので、MML表記から
  // 生コードへの変換はここ(字句解析)だけで行い、以降(compiler.js/ppmckDriver.js)は
  // 従来通り生コードだけを扱う。
  const FDS_MOD_TOKEN_TO_CODE = new Map([
    ['0', 0], ['1', 1], ['+1', 1], ['2', 2], ['+2', 2], ['4', 3], ['+4', 3],
    ['R', 4], ['-4', 5], ['-2', 6], ['-1', 7]
  ]);
  // 生コード(0-7) → MML表記。逆変換(*2mml書き出し・FDS波形エディタ)から使う
  const FDS_MOD_CODE_TO_TOKEN = ['0', '1', '2', '4', 'R', '-4', '-2', '-1'];
  // MMLに書ける値の一覧(エラーメッセージ用)
  const FDS_MOD_TOKEN_LIST = '0 / 1 / 2 / 4 / -1 / -2 / -4 / R';

  // MML表記1個 → 生コード。使えない値なら undefined を返す
  Mml.fdsModTokenToCode = function (token) {
    return FDS_MOD_TOKEN_TO_CODE.get(String(token).trim().toUpperCase());
  };
  // 生コード → MML表記(範囲外は"0"扱い)
  Mml.fdsModCodeToToken = function (code) {
    return FDS_MOD_CODE_TO_TOKEN[code & 7] || '0';
  };

  const FDS_MOD_WAVE_DEF_RE = /^@MW(\d+)\s*=\s*\{([^}]*)\}$/i;

  function parseFdsModWaveDef(trimmed) {
    const m = trimmed.match(FDS_MOD_WAVE_DEF_RE);
    if (!m) return null;
    const index = parseInt(m[1], 10);
    const tokens = m[2].trim().split(/[\s,]+/).filter(s => s.length > 0);
    const values = [];
    const invalid = [];
    for (const token of tokens) {
      const code = Mml.fdsModTokenToCode(token);
      if (code === undefined) invalid.push(token);
      else values.push(code);
    }
    return { index, values, invalid };
  }

  // @MH<n> = { delay, freq, depth, waveform(@MW<n>のインデックス) } (FDSモジュレータ設定)
  const FDS_MOD_PARAM_DEF_RE = /^@MH(\d+)\s*=\s*\{([^}]*)\}$/i;

  function parseFdsModParamDef(trimmed) {
    const m = trimmed.match(FDS_MOD_PARAM_DEF_RE);
    if (!m) return null;
    const index = parseInt(m[1], 10);
    const parts = m[2].trim().split(/[\s,]+/).filter(s => s.length > 0).map(parseMmlNumber);
    return {
      index,
      params: { delay: parts[0] || 0, freq: parts[1] || 0, depth: parts[2] || 0, waveform: parts[3] || 0 }
    };
  }

  // @DPCM<n> = { "file", freq, size, dac, mode } (DMCサンプル定義)。
  // フェーズA(コンパイラ側のみ): ここではパースして envelopes.dpcm に格納するところまでを行う。
  // 実際のファイル読込・DPCM変換はブラウザのファイル選択が必要なためUI層の仕事であり、
  // Mml.compile() は opt.dpcmSamples[filename]=Uint8Array で変換済みバイト列を
  // 外から受け取れるようにするに留める(チャンネルへの実際の再生配線・専用チャンネル文字の
  // 割当は別タスク。ROADMAP.mdフェーズ9参照)。
  // freq=DMCレート表インデックス(0-15、実機$4010下位4bit相当), size=想定バイト数,
  // dac=初期DAC値(実機$4011相当), mode=ループフラグ(実機$4010 bit6相当)
  const DPCM_DEF_RE = /^@DPCM(\d+)\s*=\s*\{\s*"([^"]*)"\s*,\s*([^}]*)\}$/i;

  function parseDpcmDef(trimmed) {
    const m = trimmed.match(DPCM_DEF_RE);
    if (!m) return null;
    const index = parseInt(m[1], 10);
    const parts = m[3].trim().split(/[\s,]+/).filter(s => s.length > 0).map(parseMmlNumber);
    return {
      index,
      sample: { file: m[2], freq: parts[0] || 0, size: parts[1] || 0, dac: parts[2] || 0, mode: parts[3] || 0 }
    };
  }

  // sourceを行分割しつつ、各行の先頭が元sourceの何文字目(絶対オフセット)かを記録する。
  // source.split(/\r\n|\r|\n/)は改行の種類(\r\n/\r/\n)を捨ててしまい長さの計算ができないため、
  // 再生ハイライト機能(MML再生中に対応するソース文字をエディタ上でハイライトする)用に
  // 絶対オフセットを保持できるこちらを使う
  function splitLinesWithOffsets(source) {
    const re = /\r\n|\r|\n/g;
    const rawLines = [];
    const lineStarts = [];
    let last = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      rawLines.push(source.slice(last, m.index));
      lineStarts.push(last);
      last = m.index + m[0].length;
    }
    rawLines.push(source.slice(last));
    lineStarts.push(last);
    return { rawLines, lineStarts };
  }

  // ソースを行ごとに解析する前に、"{"と"}"の対応が取れるまで複数行を1論理行へ結合する
  // (@OT等の定義がコメント入りの複数行で書かれることがあるため)。
  // 行コメント(;以降)はこの時点で既に除去して結合するので、結合後の行に対して
  // 通常のコメント除去処理を再度行う必要はない
  //
  // offsets[k] は結合後テキストtext[k]が元source中のどの絶対文字位置に由来するかを表す
  // (行を跨いで結合する際に挿入する区切りスペースは由来位置を持たないので-1)。
  // 再生ハイライト機能でMML再生位置→ソース文字範囲への対応を取るために使う。
  function joinBraceBlocks(rawLines, lineStarts) {
    const joined = []; // { text, lineNo(開始行), offsets }
    let acc = '';
    let accOffsets = [];
    let accStartLineNo = 0;
    let depth = 0;
    for (let i = 0; i < rawLines.length; i++) {
      const lineNo = i + 1;
      const lineStart = lineStarts[i];
      let line = rawLines[i];
      const commentIdx = line.indexOf(';');
      if (commentIdx >= 0) line = line.slice(0, commentIdx);
      const lineOffsets = [];
      for (let k = 0; k < line.length; k++) lineOffsets.push(lineStart + k);

      if (depth === 0 && acc === '') accStartLineNo = lineNo;
      if (acc === '') {
        acc = line;
        accOffsets = lineOffsets;
      } else {
        acc = acc + ' ' + line;
        accOffsets = accOffsets.concat([-1], lineOffsets);
      }
      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') depth = Math.max(0, depth - 1);
      }
      if (depth === 0) {
        joined.push({ text: acc, lineNo: accStartLineNo, offsets: accOffsets });
        acc = '';
        accOffsets = [];
      }
    }
    if (acc.trim() !== '') joined.push({ text: acc, lineNo: accStartLineNo, offsets: accOffsets }); // 閉じ括弧不足のまま終端
    return joined;
  }

  // #TITLE等のヘッダ指示子。"#名前 [引数]" の形式(引数はコマンドにより文字列/数値)
  const HEADER_DIRECTIVE_RE = /^#(\S+)\s*(.*)$/;

  function parseHeaderDirective(trimmed) {
    const m = trimmed.match(HEADER_DIRECTIVE_RE);
    if (!m) return null;
    return { name: m[1].toUpperCase(), args: m[2].trim() };
  }

  // #EX-*(拡張音源使用宣言)のチップ名対応表
  const EX_CHIP_MAP = {
    'EX-DISKFM': 'fds', 'EX-VRC7': 'vrc7', 'EX-VRC6': 'vrc6',
    'EX-NAMCO106': 'n163', 'EX-FME7': 'fme7', 'EX-MMC5': 'mmc5'
  };

  // EX_CHIP_MAPの逆引き(nsf2mml/spc2mml/kss2mml等の自動変換がMML本文へ
  // #EX-*ディレクティブを埋め込む際に使う)
  const EX_CHIP_DIRECTIVE = {};
  for (const name in EX_CHIP_MAP) EX_CHIP_DIRECTIVE[EX_CHIP_MAP[name]] = '#' + name;
  Mml.EX_CHIP_DIRECTIVE = EX_CHIP_DIRECTIVE;

  // バンキング系(本ツールはROMバンク分割を前提にしないため認識のみ・無視する)
  const BANKING_DIRECTIVES = new Set(['AUTO-BANKSWITCH', 'BANK-CHANGE', 'SETBANK', 'NO-BANKSWITCH']);

  // ファイル系(静的ホスティングのみで完結する設計上、外部ファイル読込は未対応。認識のみ・無視する)
  const UNSUPPORTED_FILE_DIRECTIVES = new Set(['EFFECT-INCLUDE', 'INCLUDE']);

  // $<char> <mml> マクロ定義のパース
  const MACRO_DEF_RE = /^\$(.)\s+(.*)$/;

  function parseMacroDef(trimmed) {
    const m = trimmed.match(MACRO_DEF_RE);
    if (!m) return null;
    return { char: m[1], body: m[2] };
  }

  // マクロ文字をチャンネル本文中に見つけたら定義内容で置き換える(1回だけ、再帰展開はしない)。
  // bodyObj = { text, offsets }。マクロ本体側は元ソース上の定義位置を持たないため、
  // 展開後の全文字は呼び出し元のマクロ文字1文字分の位置にまとめて対応させる
  // (再生ハイライトはマクロ呼び出し箇所全体が光る、という簡略化)。
  function expandMacros(bodyObj, macros) {
    if (Object.keys(macros).length === 0) return bodyObj;
    let text = '';
    const offsets = [];
    for (let i = 0; i < bodyObj.text.length; i++) {
      const c = bodyObj.text[i];
      const off = bodyObj.offsets[i];
      if (Object.prototype.hasOwnProperty.call(macros, c)) {
        const expansion = ' ' + macros[c] + ' ';
        text += expansion;
        for (let k = 0; k < expansion.length; k++) offsets.push(off);
      } else {
        text += c;
        offsets.push(off);
      }
    }
    return { text, offsets };
  }

  // ソースを行ごとに解析し、チャンネル別のコマンド文字列に連結する
  // 行の書式: "<チャンネル文字(複数可)> <コマンド...>  ; コメント"
  Mml.splitChannels = function (source) {
    const channels = {};
    const errors = [];
    const envelopes = { v: {}, vr: {}, ep: {}, en: {}, mp: {}, op: {}, fm: {}, n: {}, mw: {}, mh: {}, dpcm: {}, duty: {} };
    const meta = { title: null, composer: null, maker: null, programer: null };
    const settings = { octaveRev: 0, gateDenom: 8 };
    const detectedExpansions = [];
    const macros = {};
    const { rawLines, lineStarts } = splitLinesWithOffsets(source);
    const lines = joinBraceBlocks(rawLines, lineStarts);

    for (const { text, lineNo, offsets } of lines) {
      const trimmed = text.trim();
      if (trimmed === '') continue;
      // trimmed(前後の空白を除去)に対応する絶対オフセット列。チャンネル本文行の
      // オフセット計算(下のchans/body分岐)でのみ使う
      const leadStrip = text.length - text.trimStart().length;
      const trimmedOffsets = offsets.slice(leadStrip, leadStrip + trimmed.length);

      if (trimmed[0] === '#') {
        const directive = parseHeaderDirective(trimmed);
        if (directive) {
          switch (directive.name) {
            case 'TITLE': meta.title = directive.args; break;
            case 'COMPOSER': meta.composer = directive.args; break;
            case 'MAKER': meta.maker = directive.args; break;
            case 'PROGRAMER': meta.programer = directive.args; break;
            case 'OCTAVE-REV': settings.octaveRev = parseInt(directive.args, 10) || 0; break;
            case 'GATE-DENOM': settings.gateDenom = parseInt(directive.args, 10) || 8; break;
            default: {
              if (EX_CHIP_MAP[directive.name]) detectedExpansions.push(EX_CHIP_MAP[directive.name]);
              else if (BANKING_DIRECTIVES.has(directive.name) || UNSUPPORTED_FILE_DIRECTIVES.has(directive.name)) {
                // 認識するが本ツールでは無視する(バンキング非対応/静的ホスティングのみのためファイル読込非対応)
              } else {
                errors.push({ lineNo, message: T('未対応のヘッダ指示子です: "#{name}"', { name: directive.name }) });
              }
            }
          }
        }
        continue;
      }

      const macroDef = parseMacroDef(trimmed);
      if (macroDef) {
        macros[macroDef.char] = macroDef.body;
        continue;
      }

      const envDef = parseEnvelopeDef(trimmed);
      if (envDef) {
        (envDef.isRelease ? envelopes.vr : envelopes.v)[envDef.index] = envDef.table;
        continue;
      }

      const pitchNoteEnvDef = parsePitchNoteEnvelopeDef(trimmed);
      if (pitchNoteEnvDef) {
        envelopes[pitchNoteEnvDef.kind][pitchNoteEnvDef.index] = pitchNoteEnvDef.table;
        continue;
      }

      const vibratoDef = parseVibratoDef(trimmed);
      if (vibratoDef) {
        envelopes.mp[vibratoDef.index] = vibratoDef.params;
        continue;
      }

      const vrc7ToneDef = parseVrc7ToneDef(trimmed);
      if (vrc7ToneDef) {
        envelopes.op[vrc7ToneDef.index] = vrc7ToneDef.bytes;
        continue;
      }

      const vrc7ToneAltDef = parseVrc7ToneAltDef(trimmed);
      if (vrc7ToneAltDef) {
        if (vrc7ToneAltDef.bytes) envelopes.op[vrc7ToneAltDef.index] = vrc7ToneAltDef.bytes;
        else errors.push({ lineNo, message: T('@OT{index} の値の数が不足しています(24個必要)', { index: vrc7ToneAltDef.index }) });
        continue;
      }

      const fdsWaveDef = parseFdsWaveDef(trimmed);
      if (fdsWaveDef) {
        envelopes.fm[fdsWaveDef.index] = fdsWaveDef.values;
        continue;
      }

      const n163WaveDef = parseN163WaveDef(trimmed);
      if (n163WaveDef) {
        envelopes.n[n163WaveDef.index] = n163WaveDef.values;
        continue;
      }

      const fdsModWaveDef = parseFdsModWaveDef(trimmed);
      if (fdsModWaveDef) {
        if (fdsModWaveDef.invalid.length > 0) {
          errors.push({
            lineNo,
            message: T('@MW{index} に使えない値があります: {values}(使えるのは {allowed} のみ)', {
              index: fdsModWaveDef.index,
              values: fdsModWaveDef.invalid.join(', '),
              allowed: FDS_MOD_TOKEN_LIST
            })
          });
        }
        envelopes.mw[fdsModWaveDef.index] = fdsModWaveDef.values;
        continue;
      }

      const fdsModParamDef = parseFdsModParamDef(trimmed);
      if (fdsModParamDef) {
        envelopes.mh[fdsModParamDef.index] = fdsModParamDef.params;
        continue;
      }

      const dpcmDef = parseDpcmDef(trimmed);
      if (dpcmDef) {
        envelopes.dpcm[dpcmDef.index] = dpcmDef.sample;
        continue;
      }

      // @<n> = {...}(デューティエンベロープ)は最も汎用的な書式のため、他の@XX定義を
      // すべて試した後に判定する(正規表現自体も@直後が数字の場合しか一致しない)
      const toneEnvDef = parseToneEnvelopeDef(trimmed);
      if (toneEnvDef) {
        envelopes.duty[toneEnvDef.index] = toneEnvDef.table;
        continue;
      }

      const m = trimmed.match(/^([A-Za-z]+)\s+(.*)$/) || trimmed.match(/^([A-Za-z]+)$/);
      if (!m) {
        errors.push({ lineNo, message: T('チャンネル指定が認識できません: "{text}"', { text: trimmed }) });
        continue;
      }
      // 実機ppmck同様、チャンネル文字は大文字小文字を区別する(MMC5の2chが
      // 大文字を使い切った後の小文字a,bに割り当てられるため。以前はtoUpperCase()で
      // 大文字小文字を区別せず処理していたが、これだと小文字a/bが2A03のA/Bと
      // 衝突してしまうため廃止した)
      const chans = m[1];
      const rawBody = m[2] || '';
      const body = rawBody.trim();
      // \s+(貪欲マッチ)が空白を全て飲み込むため、trimmed末尾に空白は残らずrawBodyは
      // 既にトリム済みのはず(bodyとrawBodyは通常一致)だが念のためtrim()はそのまま残す
      const afterHeaderIdx = trimmed.length - rawBody.length;
      const bodyOffsets = trimmedOffsets.slice(afterHeaderIdx, afterHeaderIdx + body.length);

      for (const ch of chans) {
        if (!channels[ch]) channels[ch] = { text: '', offsets: [] };
        channels[ch].text += ' ' + body;
        channels[ch].offsets.push(-1, ...bodyOffsets);
      }
    }

    for (const ch of Object.keys(channels)) {
      channels[ch] = expandMacros(channels[ch], macros);
    }


    // DPCMは2A03内蔵機能(VRC6/FDS等のカートリッジ側拡張チップとは異なり、
    // 選択式の「拡張音源」ではない)なので、UIのチェックボックスや#EX-*宣言を
    // 必要とせず、@DPCM<n>定義が1つでもあれば自動的に有効化する
    if (Object.keys(envelopes.dpcm).length > 0 && !detectedExpansions.includes('dpcm')) {
      detectedExpansions.push('dpcm');
    }

    return { channels, errors, envelopes, meta, settings, detectedExpansions };
  };

  // コマンド文字列 -> トークン列。
  // offsets(省略可): str[k]が元ソースのどの絶対文字位置に由来するかを表す配列
  // (lexer.splitChannels/expandMacrosが生成するもの)。渡された場合、note/directNote
  // トークンに元ソース上の範囲 srcStart/srcEnd を付与する(再生ハイライト機能用。
  // 音符/休符以外のトークンはハイライト対象セグメントを作らないので付与しない)。
  Mml.tokenize = function (str, offsets) {
    const tokens = [];
    let i = 0;
    const n = str.length;

    // [tokStart, i) の範囲に対応する元ソース絶対範囲をtokに付与する
    function tagSource(tok, tokStart) {
      if (!offsets) return tok;
      const s = offsets[tokStart];
      if (s == null || s < 0) return tok;
      let e = -1;
      for (let k = i - 1; k >= tokStart; k--) {
        if (offsets[k] != null && offsets[k] >= 0) { e = offsets[k]; break; }
      }
      tok.srcStart = s;
      tok.srcEnd = (e >= 0 ? e : s) + 1;
      return tok;
    }

    function isDigit(c) { return c >= '0' && c <= '9'; }

    function readNumber() {
      let s = '';
      while (i < n && isDigit(str[i])) { s += str[i]; i++; }
      return s.length > 0 ? parseInt(s, 10) : null;
    }

    function readSignedNumber() {
      let sign = 1;
      if (str[i] === '+' || str[i] === '-') { sign = str[i] === '-' ? -1 : 1; i++; }
      const v = readNumber();
      return v == null ? null : sign * v;
    }

    // y<adr>,<num>(レジスタ書き込み)/x<param0>,<param1>(直接埋め込み)専用。NESのメモリ
    // アドレスは16進で書きたいことが多いため、"$"接頭辞の16進数にも対応する(@OP等の定義
    // ブロック内で使われるparseMmlNumberと同じ規約。10進の既存コマンド群には影響しない)
    function readNumberHex() {
      if (str[i] === '$') {
        i++;
        let s = '';
        while (i < n && /[0-9a-fA-F]/.test(str[i])) { s += str[i]; i++; }
        return s.length > 0 ? parseInt(s, 16) : null;
      }
      return readNumber();
    }

    // 大文字小文字を区別せず、現在位置から2文字リテラル(例:"OF")に一致するか判定し、
    // 一致すればiを進めてtrueを返す
    function matchLiteral2(lit) {
      if (i + 1 < n && str[i].toUpperCase() === lit[0] && str[i + 1].toUpperCase() === lit[1]) {
        i += 2;
        return true;
      }
      return false;
    }

    while (i < n) {
      const c = str[i];

      if (c === ' ' || c === '\t') { i++; continue; }
      const tokStart = i;

      // 音符 c d e f g a b, 休符 r
      // ただし "E" は EN<n>/EP<n>(ノート/ピッチエンベロープ)コマンドの頭文字でもあるため、
      // 直後が N/P なら(音符の修飾子として無効な組み合わせなので)そちらを優先する
      const isEnvelopePrefix = (c === 'E' || c === 'e') &&
        (str[i + 1] === 'N' || str[i + 1] === 'n' || str[i + 1] === 'P' || str[i + 1] === 'p');
      // 大文字"D"はD<n>(デチューン)コマンド専用にする(小文字dは通常通り音符d)。
      // ノート名の大文字許容(c-b/rの大文字表記)自体はここでは崩さず、Dだけ除外する
      if (!isEnvelopePrefix && c !== 'D' && /[a-grA-GR]/.test(c) && /[cdefgabrCDEFGABR]/.test(c)) {
        const name = c.toLowerCase();
        i++;
        let accidental = 0;
        while (i < n && (str[i] === '+' || str[i] === '#' || str[i] === '-')) {
          accidental += (str[i] === '-') ? -1 : 1;
          i++;
        }
        const length = readNumber();
        let dots = 0;
        while (i < n && str[i] === '.') { dots++; i++; }
        tokens.push(tagSource({ type: 'note', name, accidental, length, dots }, tokStart));
        continue;
      }

      switch (c) {
        case 'o': case 'O': {
          i++;
          // OP<n>/OPOF = VRC7カスタム音色ロード。"o"/"O"単体のオクターブ指定と衝突するため、
          // 直後が P/p のときだけコマンド側として扱う(オクターブ指定の後にPは来ない)
          if (str[i] === 'P' || str[i] === 'p') {
            i++;
            if (matchLiteral2('OF')) tokens.push({ type: 'vrc7Tone', value: 255 });
            else { const v = readNumber(); tokens.push({ type: 'vrc7Tone', value: v == null ? 0 : v }); }
          } else {
            const v = readNumber();
            tokens.push({ type: 'octave', value: v == null ? 4 : v });
          }
          break;
        }
        case '>': i++; tokens.push({ type: 'octaveUp' }); break;
        case '<': i++; tokens.push({ type: 'octaveDown' }); break;
        case 'l': {
          i++;
          const v = readNumber();
          let dots = 0;
          while (i < n && str[i] === '.') { dots++; i++; }
          tokens.push({ type: 'length', value: v, dots });
          break;
        }
        // 大文字L = ループ地点マーカー(小文字lのデフォルト音長とは別コマンド。以前は
        // l/Lを区別せず同じ長さコマンドとして扱っていたが、ppmck本来の意味に合わせて分離した)。
        // パラメータは取らない。曲の再生がチャンネル末尾に達したとき、このチャンネルの
        // Lの位置まで戻って演奏を続ける(compiler.js buildSegments/src/driver/ppmckDriver.js参照)
        case 'L': i++; tokens.push({ type: 'loopPoint' }); break;
        case 'v': case 'V': {
          i++;
          if (str[i] === '+' || str[i] === '-') {
            const sign = str[i] === '-' ? -1 : 1;
            i++;
            const d = readNumber();
            tokens.push({ type: 'volumeRel', delta: sign * (d == null ? 1 : d) });
          } else {
            const v = readNumber();
            tokens.push({ type: 'volume', value: v == null ? 15 : v });
          }
          break;
        }
        case 'q': case 'Q': {
          i++;
          const v = readNumber();
          tokens.push({ type: 'gate', value: v == null ? 8 : v });
          break;
        }
        case 't': case 'T': {
          i++;
          const v = readNumber();
          tokens.push({ type: 'tempo', value: v == null ? 120 : v });
          break;
        }
        case '@': {
          i++;
          // @@<n> / @@r<n>(実機ppmckの_ORG_TONE/_REL_ORG_TONE)。@<n>が「固定の音色を
          // 指定してデューティエンベロープを解除する」(音色バイトbit7=1)のに対し、
          // @@<n>は「自作音色=@<n>={...}で定義したデューティ(音色)エンベロープを選ぶ」
          // (bit7=0)。@@r<n>はそのリリース版で、ゲートオフの瞬間に音色を差し替える
          // (255=OFF)。compiler.js buildSegmentsのtoneEnv/releaseTone参照
          if (str[i] === '@') {
            i++;
            if (str[i] === 'r' || str[i] === 'R') {
              i++;
              const v = readNumber();
              tokens.push({ type: 'releaseTone', value: v == null ? 0 : v });
            } else {
              const v = readNumber();
              tokens.push({ type: 'toneEnv', value: v == null ? 0 : v });
            }
          } else if (str[i] === 'v' || str[i] === 'V') {
            i++;
            let isRelease = false;
            if (str[i] === 'r' || str[i] === 'R') { isRelease = true; i++; }
            const v = readNumber();
            tokens.push({ type: isRelease ? 'envelopeVr' : 'envelopeV', value: v == null ? 0 : v });
          } else if (str[i] === 'q' || str[i] === 'Q') {
            i++;
            const v = readNumber();
            tokens.push({ type: 'quantizeFrames', value: v == null ? 0 : v });
          } else if (str[i] === 't' || str[i] === 'T') {
            // @t<len>,<num> テンポ2: 音長<len>が確実に<num>フレームになるようテンポを
            // 逆算する(t<n>の整数BPM丸めによるフレーム数の端数化を避けるための実機コマンド)。
            // <len>,<num>の初期値は4,30(ppmck公式リファレンス通り)
            i++;
            const len = readNumber();
            let dots = 0;
            while (i < n && str[i] === '.') { dots++; i++; }
            let num = null;
            if (str[i] === ',') { i++; num = readNumber(); }
            tokens.push({ type: 'frameTempo', len: len == null ? 4 : len, dots, num: num == null ? 30 : num });
          } else {
            const v = readNumber();
            tokens.push({ type: 'instrument', value: v == null ? 0 : v });
          }
          break;
        }
        case 'K': {
          i++;
          const v = readSignedNumber();
          tokens.push({ type: 'transpose', value: v == null ? 0 : v });
          break;
        }
        // D<n> = デチューン(生の周期レジスタ値への符号付きオフセット、以降の音符に持続適用)。
        // K<n>(半音単位の移調)とは別軸で、同じ音を別チャンネルでわずかにずらして
        // 鳴らすコーラス/デチューン効果に使う
        case 'D': {
          i++;
          const v = readSignedNumber();
          tokens.push({ type: 'detune', value: v == null ? 0 : v });
          break;
        }
        case 'n': {
          i++;
          const num = readNumber();
          if (str[i] === ',') i++;
          const length = readNumber();
          let dots = 0;
          while (i < n && str[i] === '.') { dots++; i++; }
          tokens.push(tagSource({ type: 'directNote', num: num == null ? 0 : num, length, dots }, tokStart));
          break;
        }
        // 大文字N<num> = FME7ノイズ周波数(0-31)。小文字n<num>(直接音程指定)とは別コマンド
        case 'N': {
          i++;
          const v = readNumber();
          tokens.push({ type: 'fme7Noise', value: v == null ? 0 : v });
          break;
        }
        // 大文字S<num> = FME7エンベロープ形状(0-15)。小文字s<speed>,<depth>(スイープ)とは別コマンド。
        // ただし直後がD/Mの場合はSD<n>/SDOF/SDQR(セルフディレイ)・SM/SMOF(スムース)を優先する
        // (いずれもFME7エンベロープ形状の数値表記とは衝突しない、ppmck公式コマンド)
        case 'S': {
          i++;
          if (str[i] === 'D' || str[i] === 'd') {
            i++;
            if (matchLiteral2('QR')) tokens.push({ type: 'selfDelayReset' });
            else if (matchLiteral2('OF')) tokens.push({ type: 'selfDelay', value: null });
            else { const v = readNumber(); tokens.push({ type: 'selfDelay', value: v == null ? 0 : v }); }
          } else if (str[i] === 'M' || str[i] === 'm') {
            i++;
            if (matchLiteral2('OF')) tokens.push({ type: 'smooth', value: false });
            else tokens.push({ type: 'smooth', value: true });
          } else {
            const v = readNumber();
            tokens.push({ type: 'fme7EnvShape', value: v == null ? 0 : v });
          }
          break;
        }
        // EP<n>[,<delay>] ピッチエンベロープ選択。<delay>は省略可(既定0=即座に開始)、
        // 選択解除EPOFにはdelayの概念が無い(2026-08-11 別プロジェクトA: EP<n>,<delay>引数拡張。
        // s<n0>,<n1>と同じカンマ区切りの追加引数パターンを踏襲)
        case 'E': {
          i++;
          if (str[i] === 'P' || str[i] === 'p') {
            i++;
            if (matchLiteral2('OF')) tokens.push({ type: 'pitchEnv', value: 255, delay: 0 });
            else {
              const v = readNumber();
              let delay = 0;
              if (str[i] === ',') { i++; const d = readNumber(); delay = d == null ? 0 : d; }
              tokens.push({ type: 'pitchEnv', value: v == null ? 0 : v, delay });
            }
          } else if (str[i] === 'N' || str[i] === 'n') {
            i++;
            if (matchLiteral2('OF')) tokens.push({ type: 'noteEnv', value: 255 });
            else { const v = readNumber(); tokens.push({ type: 'noteEnv', value: v == null ? 0 : v }); }
          }
          break;
        }
        case 'M': {
          i++;
          if (str[i] === 'P' || str[i] === 'p') {
            i++;
            if (matchLiteral2('OF')) tokens.push({ type: 'vibrato', value: 255 });
            else { const v = readNumber(); tokens.push({ type: 'vibrato', value: v == null ? 0 : v }); }
          } else if (str[i] === 'H' || str[i] === 'h') {
            i++;
            if (matchLiteral2('OF')) tokens.push({ type: 'fdsMod', value: 255 });
            else { const v = readNumber(); tokens.push({ type: 'fdsMod', value: v == null ? 0 : v }); }
          } else {
            // 素の M<num> = FME7エンベロープ周期(0-65535)
            const v = readNumber();
            tokens.push({ type: 'fme7EnvPeriod', value: v == null ? 0 : v });
          }
          break;
        }
        // s<n0>,<n1> スイープ。両方とも0-15の符号なし値(n1の下位4bitがnegate+shiftを
        // 兼ねるため符号は付かない。旧実装はn1を符号付きで読んでいたが誤り。
        // compiler.js sweepRegisterByte参照)
        case 's': {
          i++;
          const speed = readNumber();
          let depth = null;
          if (str[i] === ',') { i++; depth = readNumber(); }
          tokens.push({ type: 'sweep', speed: speed == null ? 0 : speed, depth: depth == null ? 0 : depth });
          break;
        }
        // PT<target>,<duration>[,<delay>] ポルタメント(単調な直線グライド、DESIGN-PITCH.md
        // 別プロジェクトC)。PTOFで解除。target(符号付き)はD<n>/EP<n>と同じ「変換先チップの
        // 生レジスタオフセット」空間、durationはグライドに要するフレーム数、delayは省略可
        // (既定0)。★ppmck本家ドキュメント(doc/mck.txt)には専用のポルタメントコマンドが
        // 無く「ピッチエンベロープ(EP)で代用してください」と明記されているため、これは
        // ppmck方言からの独自拡張(README.md方言対応表・INV-2参照)。
        case 'P': {
          i++;
          if (str[i] === 'T' || str[i] === 't') {
            i++;
            if (matchLiteral2('OF')) tokens.push({ type: 'portamento', target: null });
            else {
              const target = readSignedNumber();
              let duration = null, delay = 0;
              if (str[i] === ',') { i++; duration = readNumber(); }
              if (str[i] === ',') { i++; const d = readNumber(); delay = d == null ? 0 : d; }
              tokens.push({
                type: 'portamento',
                target: target == null ? 0 : target,
                duration: duration == null ? 0 : duration,
                delay
              });
            }
          } else if (str[i] === 'S' || str[i] === 's') {
            // PS ポルタメント(ppmck本家、実機準拠の別実装。PTとは独立)。次に来る音符
            // そのものをグライド先として使うため引数を取らない(compiler.js buildSegments参照)
            i++;
            tokens.push({ type: 'pitchShift' });
          }
          break;
        }
        case '&': i++; tokens.push({ type: 'tie' }); break;
        case '[': i++; tokens.push({ type: 'loopStart' }); break;
        case '|': i++; tokens.push({ type: 'loopBreak' }); break;
        case ']': {
          i++;
          const v = readNumber();
          tokens.push({ type: 'loopEnd', count: v });
          break;
        }
        case '{': i++; tokens.push({ type: 'tupletStart' }); break;
        case '}': {
          i++;
          const v = readNumber();
          let dots = 0;
          while (i < n && str[i] === '.') { dots++; i++; }
          tokens.push({ type: 'tupletEnd', length: v, dots });
          break;
        }
        // w<len> ウェイト: 直前のコマンド(音符/休符/w自身)をさらに<len>音長ぶん保持する。
        // タイ(&)と同じ「直前セグメントの長さを延長するだけ」で実現できる(compiler.js参照)
        case 'w': {
          i++;
          const v = readNumber();
          let dots = 0;
          while (i < n && str[i] === '.') { dots++; i++; }
          tokens.push(tagSource({ type: 'wait', length: v, dots }, tokStart));
          break;
        }
        // y<adr>,<num> レジスタ(メモリ)直接書き込み。ブラウザ再生でもそのまま
        // 該当アドレスへの生バイト書き込みとして再現する(compiler.js参照)
        case 'y': {
          i++;
          const addr = readNumberHex();
          let value = null;
          if (str[i] === ',') { i++; value = readNumberHex(); }
          tokens.push({ type: 'rawWrite', addr: addr == null ? 0 : addr, value: value == null ? 0 : value });
          break;
        }
        // x<param0>,<param1> データストリームへのバイト直接埋め込み。NSF書き出し(6502
        // バイトコード)専用のコマンドで、ブラウザ再生(レジスタログ方式)には対応する概念が
        // 無いためパースのみ行い無視する(compiler.js側でも意図的に未処理、NSF書き出し実装は
        // 別タスク)
        case 'x': {
          i++;
          const p0 = readNumberHex();
          let p1 = null;
          if (str[i] === ',') { i++; p1 = readNumberHex(); }
          tokens.push({ type: 'directBytes', param0: p0 == null ? 0 : p0, param1: p1 == null ? 0 : p1 });
          break;
        }
        // ! / !! / !!!  特殊マーカー。
        // ! (1個)      = データスキップ。この記号以降、このチャンネルのMMLはコンパイルしない
        //                (ppmck公式リファレンス通り。トークン化自体をここで打ち切る)
        // !! (2個)     = タイムシフト。ここが「再生開始位置」になる(ppmck公式、ppmck9a ex7以降)。
        //                シークバーの開始ハンドル(青)と相互リンクする(main.js側)
        // !!! (3個)    = 本ツール独自拡張(ユーザー要望、2026-08-13)。「再生終了位置」。
        //                シークバーの終了ハンドル(赤)と相互リンクする。省略時は曲の最後まで
        case '!': {
          i++;
          let bangs = 1;
          while (bangs < 3 && str[i] === '!') { bangs++; i++; }
          if (bangs === 1) {
            // データスキップ: 以降のこのチャンネルのテキストは一切トークン化しない
            i = n;
          } else if (bangs === 2) {
            tokens.push(tagSource({ type: 'timeShiftStart' }, tokStart));
          } else {
            tokens.push(tagSource({ type: 'timeShiftEnd' }, tokStart));
          }
          break;
        }
        default:
          // 未対応文字は無視
          i++;
          break;
      }
    }

    return tokens;
  };
})(window);
