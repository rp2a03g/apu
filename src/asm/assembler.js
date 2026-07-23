/*
 * 簡易 6502 アセンブラ（2パス方式）
 * MML.Asm.assemble(source, options) -> { bytes, symbols, origin, errors, listing }
 *
 * 対応構文:
 *   ラベル定義      : LABEL:  もしくは行頭の LABEL（コロンなし、独立行のみ）
 *   命令            : MNEMONIC [operand]
 *   即値            : #$10 #10 #%00010000 #<LABEL #>LABEL
 *   ゼロページ      : $10  /  <LABEL（強制ゼロページ）
 *   絶対            : $1234 / LABEL
 *   インデックス    : $1234,X  $10,X  $10,Y  LABEL,X ...
 *   間接            : ($1234)  ($10,X)  ($10),Y
 *   相対(分岐)      : BNE LABEL / BNE *+5
 *   ディレクティブ  : .org $8000 / .byte $01,"TEXT",10 / .word LABEL / .res 16 [,fill]
 *   数値            : $hex  %binary  10進数  'A'(文字コード)
 *   コメント        : ; 以降
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Asm = MML.Asm = MML.Asm || {};

  class AsmError extends Error {
    constructor(message, lineNo) {
      super(message);
      this.lineNo = lineNo;
    }
  }

  // 数値・ラベル参照を含む式を評価する。
  // symbols が null の場合はラベル参照を 0 として扱う（パス1のサイズ判定用）。
  function evalExpr(expr, symbols, lineNo) {
    expr = expr.trim();
    if (expr === '') throw new AsmError('式が空です', lineNo);

    // 低位・高位バイト抽出 (<addr / >addr)
    if (expr[0] === '<' || expr[0] === '>') {
      const v = evalExpr(expr.slice(1), symbols, lineNo);
      return expr[0] === '<' ? (v & 0xFF) : ((v >> 8) & 0xFF);
    }

    // 加減算 (label+1, label-2 など)。$ や % の直後の符号は数値の一部ではないため
    // 先頭以降で + / - を探す。
    for (let i = 1; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '+' || ch === '-') {
        const left = evalExpr(expr.slice(0, i), symbols, lineNo);
        const right = evalExpr(expr.slice(i + 1), symbols, lineNo);
        return ch === '+' ? left + right : left - right;
      }
    }

    return evalTerm(expr, symbols, lineNo);
  }

  function evalTerm(term, symbols, lineNo) {
    term = term.trim();
    if (term === '*') {
      // 現在の PC（呼び出し側で symbols.__pc に設定）
      if (symbols && typeof symbols.__pc === 'number') return symbols.__pc;
      return 0;
    }
    if (term[0] === '$') {
      const v = parseInt(term.slice(1), 16);
      if (isNaN(v)) throw new AsmError(`不正な16進数値: ${term}`, lineNo);
      return v;
    }
    if (term[0] === '%') {
      const v = parseInt(term.slice(1), 2);
      if (isNaN(v)) throw new AsmError(`不正な2進数値: ${term}`, lineNo);
      return v;
    }
    if (term[0] === "'" && term.length >= 2) {
      return term.charCodeAt(1);
    }
    if (/^[0-9]+$/.test(term)) {
      return parseInt(term, 10);
    }
    // ラベル参照
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(term)) {
      if (symbols === null) return 0; // パス1のサイズ判定: 値は不要
      if (Object.prototype.hasOwnProperty.call(symbols, term)) return symbols[term];
      throw new AsmError(`未定義のラベル: ${term}`, lineNo);
    }
    throw new AsmError(`式を解釈できません: ${term}`, lineNo);
  }

  // 式の中にラベル参照（数値リテラルではない識別子）が含まれるかを判定
  function isPureNumeric(expr) {
    expr = expr.trim();
    if (expr[0] === '<' || expr[0] === '>') return isPureNumeric(expr.slice(1));
    for (let i = 1; i < expr.length; i++) {
      if (expr[i] === '+' || expr[i] === '-') {
        return isPureNumeric(expr.slice(0, i)) && isPureNumeric(expr.slice(i + 1));
      }
    }
    expr = expr.trim();
    if (expr[0] === '$' || expr[0] === '%' || expr[0] === "'") return true;
    if (/^[0-9]+$/.test(expr)) return true;
    if (expr === '*') return true;
    return false;
  }

  // オペランド文字列からアドレッシングモードと内部式を決定する。
  // forceZp の判定は < プレフィックスの有無で行う。
  function decodeOperand(mnemonic, operand, lineNo) {
    operand = operand.trim();

    if (operand === '') {
      return { mode: Asm.ACCUMULATOR_OPS.has(mnemonic) ? 'acc' : 'impl', expr: null };
    }
    if (/^A$/i.test(operand) && Asm.ACCUMULATOR_OPS.has(mnemonic)) {
      return { mode: 'acc', expr: null };
    }
    if (operand[0] === '#') {
      return { mode: 'imm', expr: operand.slice(1) };
    }
    if (operand[0] === '(') {
      const m1 = operand.match(/^\((.+),\s*[Xx]\)$/);
      if (m1) return { mode: 'indx', expr: m1[1] };
      const m2 = operand.match(/^\((.+)\)\s*,\s*[Yy]$/);
      if (m2) return { mode: 'indy', expr: m2[1] };
      const m3 = operand.match(/^\((.+)\)$/);
      if (m3) return { mode: 'ind', expr: m3[1] };
      throw new AsmError(`括弧の構文が不正です: ${operand}`, lineNo);
    }
    if (Asm.BRANCH_OPS.has(mnemonic)) {
      return { mode: 'rel', expr: operand };
    }
    const mx = operand.match(/^(.+),\s*[Xx]$/);
    if (mx) {
      const expr = mx[1];
      const forceZp = expr[0] === '<';
      const big = !forceZp && (expr[0] === '>' || !isPureNumeric(expr) || evalExpr(expr, null, lineNo) > 0xFF);
      return { mode: big ? 'absx' : 'zpx', expr };
    }
    const my = operand.match(/^(.+),\s*[Yy]$/);
    if (my) {
      const expr = my[1];
      const forceZp = expr[0] === '<';
      const big = !forceZp && (expr[0] === '>' || !isPureNumeric(expr) || evalExpr(expr, null, lineNo) > 0xFF);
      return { mode: big ? 'absy' : 'zpy', expr };
    }

    // 通常のゼロページ／絶対
    const forceZp = operand[0] === '<';
    const big = !forceZp && (operand[0] === '>' || !isPureNumeric(operand) || evalExpr(operand, null, lineNo) > 0xFF);
    return { mode: big ? 'abs' : 'zp', expr: operand };
  }

  // 行を {label, mnemonic, operand, directive, args, raw, lineNo} に分解
  function parseLine(raw, lineNo) {
    let line = raw;
    const semi = line.indexOf(';');
    if (semi >= 0) line = line.slice(0, semi);
    line = line.trim();
    if (line === '') return { lineNo, raw, empty: true };

    let label = null;
    const colon = line.indexOf(':');
    if (colon >= 0) {
      const candidate = line.slice(0, colon).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) {
        label = candidate;
        line = line.slice(colon + 1).trim();
      }
    } else {
      // コロン無し独立ラベル行（行全体がラベル名のみ）。
      // ただし RTS / INX / TXA のような、オペランド無しで単独行になり得る
      // implied/accumulatorモード命令のニーモニックと一致する場合はラベルとして
      // 扱わず、命令として解釈する（そうしないとオペランド無し命令が
      // 常にラベル宣言に化けてバイトが1つも出力されず消えてしまう）。
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(line) && !Asm.OPCODES[line.toUpperCase()]) {
        return { lineNo, raw, label: line, empty: true };
      }
    }

    if (line === '') return { lineNo, raw, label, empty: true };

    const sp = line.search(/\s/);
    let mnemonic, operand;
    if (sp < 0) {
      mnemonic = line;
      operand = '';
    } else {
      mnemonic = line.slice(0, sp);
      operand = line.slice(sp + 1).trim();
    }

    if (mnemonic[0] === '.') {
      return { lineNo, raw, label, directive: mnemonic.toLowerCase(), args: operand };
    }

    return { lineNo, raw, label, mnemonic: mnemonic.toUpperCase(), operand };
  }

  // .byte/.word ディレクティブの引数をトップレベルのカンマで分割（文字列リテラル内のカンマは無視）
  function splitArgs(args) {
    const items = [];
    let cur = '';
    let inStr = false;
    for (let i = 0; i < args.length; i++) {
      const ch = args[i];
      if (ch === '"' ) inStr = !inStr;
      if (ch === ',' && !inStr) {
        items.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim() !== '') items.push(cur.trim());
    return items;
  }

  function directiveSize(directive, args, symbols, lineNo) {
    switch (directive) {
      case '.byte':
      case '.db': {
        let n = 0;
        for (const item of splitArgs(args)) {
          if (item[0] === '"') n += item.length - 2;
          else n += 1;
        }
        return n;
      }
      case '.word':
      case '.dw':
        return splitArgs(args).length * 2;
      case '.res':
      case '.ds': {
        const parts = splitArgs(args);
        return evalExpr(parts[0], symbols, lineNo);
      }
      case '.org':
        return 0;
      default:
        throw new AsmError(`未知のディレクティブ: ${directive}`, lineNo);
    }
  }

  function emitDirective(directive, args, symbols, pc, lineNo, out) {
    switch (directive) {
      case '.byte':
      case '.db':
        for (const item of splitArgs(args)) {
          if (item[0] === '"') {
            for (let i = 1; i < item.length - 1; i++) out.push(item.charCodeAt(i) & 0xFF);
          } else {
            out.push(evalExpr(item, symbols, lineNo) & 0xFF);
          }
        }
        return;
      case '.word':
      case '.dw':
        for (const item of splitArgs(args)) {
          const v = evalExpr(item, symbols, lineNo) & 0xFFFF;
          out.push(v & 0xFF, (v >> 8) & 0xFF);
        }
        return;
      case '.res':
      case '.ds': {
        const parts = splitArgs(args);
        const count = evalExpr(parts[0], symbols, lineNo);
        const fill = parts.length > 1 ? (evalExpr(parts[1], symbols, lineNo) & 0xFF) : 0;
        for (let i = 0; i < count; i++) out.push(fill);
        return;
      }
      case '.org':
        return; // pc 自体は呼び出し側で処理
      default:
        throw new AsmError(`未知のディレクティブ: ${directive}`, lineNo);
    }
  }

  /**
   * MML.Asm.assemble
   * @param {string} source - アセンブリソース
   * @param {{origin?: number}} options
   * @returns {{bytes: Uint8Array, symbols: Object, origin: number, end: number, errors: Array}}
   */
  Asm.assemble = function (source, options = {}) {
    const errors = [];
    const lines = source.split('\n').map((l, i) => {
      try {
        return parseLine(l, i + 1);
      } catch (e) {
        errors.push({ lineNo: i + 1, message: e.message });
        return { lineNo: i + 1, raw: l, empty: true };
      }
    });

    let origin = options.origin !== undefined ? options.origin : 0x8000;
    const symbols = {};
    let originSet = false;

    // --- パス1: ラベルアドレスとサイズの確定 ---
    let pc = origin;
    for (const line of lines) {
      if (line.empty) {
        if (line.label) symbols[line.label] = pc;
        continue;
      }
      if (line.label) symbols[line.label] = pc;

      try {
        if (line.directive) {
          if (line.directive === '.org') {
            pc = evalExpr(line.args, symbols, line.lineNo);
            if (!originSet) { origin = pc; originSet = true; }
            line.size = 0;
          } else {
            line.size = directiveSize(line.directive, line.args, symbols, line.lineNo);
          }
        } else {
          const table = Asm.OPCODES[line.mnemonic];
          if (!table) throw new AsmError(`未知の命令: ${line.mnemonic}`, line.lineNo);
          const decoded = decodeOperand(line.mnemonic, line.operand, line.lineNo);
          line.decoded = decoded;
          line.size = Asm.MODE_SIZES[decoded.mode];
        }
      } catch (e) {
        errors.push({ lineNo: line.lineNo, message: e.message });
        line.size = 0;
      }
      line.pc = pc;
      pc += (line.size || 0);
    }

    const end = pc;

    // --- パス2: バイト列生成 ---
    const out = [];
    pc = origin;
    for (const line of lines) {
      if (line.empty || line.size === undefined) continue;
      symbols.__pc = pc;
      try {
        if (line.directive) {
          if (line.directive === '.org') {
            const target = evalExpr(line.args, symbols, line.lineNo);
            while (pc < target) { out.push(0); pc++; }
            pc = target;
            continue;
          }
          emitDirective(line.directive, line.args, symbols, pc, line.lineNo, out);
        } else {
          const { mode, expr } = line.decoded;
          const table = Asm.OPCODES[line.mnemonic];
          const opcode = table[mode];
          if (opcode === undefined) {
            throw new AsmError(`命令 ${line.mnemonic} はアドレッシングモード ${mode} に対応していません`, line.lineNo);
          }
          out.push(opcode);
          if (mode === 'rel') {
            const target = evalExpr(expr, symbols, line.lineNo);
            const offset = target - (pc + 2);
            if (offset < -128 || offset > 127) {
              throw new AsmError(`分岐範囲外です (offset=${offset}): ${line.raw.trim()}`, line.lineNo);
            }
            out.push(offset & 0xFF);
          } else if (Asm.MODE_SIZES[mode] === 2 && mode !== 'rel') {
            out.push(evalExpr(expr, symbols, line.lineNo) & 0xFF);
          } else if (Asm.MODE_SIZES[mode] === 3) {
            const v = evalExpr(expr, symbols, line.lineNo) & 0xFFFF;
            out.push(v & 0xFF, (v >> 8) & 0xFF);
          }
        }
      } catch (e) {
        errors.push({ lineNo: line.lineNo, message: e.message });
        for (let i = 0; i < (line.size || 0); i++) out.push(0);
      }
      pc += (line.size || 0);
    }

    delete symbols.__pc;
    return { bytes: new Uint8Array(out), symbols, origin, end, errors };
  };
})(window);
