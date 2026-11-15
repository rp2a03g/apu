/*
 * CPU命令テストの検証ロジック(DOM非依存の共通コア)
 *
 * tools/*-test.html(ブラウザ版)と tools/headless/cpu-test.js(CLI版)の両方が
 * これを読み込む。同じ検証コードを2箇所に書くと、片方だけ直して食い違っても
 * 気付けないため、比較ロジックはここだけに置く。
 *
 * 外部テストベクタ: SingleStepTests (65x02/nes6502, z80, sm83, spc700)
 * 各CPUで「1命令を1回 step して、レジスタ・RAM・サイクル数が期待値と一致するか」を見る。
 *
 * 使い方:
 *   const spec = MML.CpuTest.SPECS['6502'];
 *   const runner = spec.createRunner();
 *   const r = runner.runOne(await (await fetch(spec.vectorBase + f.path)).json(), 1000);
 *   //  → { pass, total, cycBad, stateBad, ramBad, fails }
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const CpuTest = MML.CpuTest = MML.CpuTest || {};

  const hex2 = (n) => n.toString(16).padStart(2, '0');

  /** 256命令ぶんのファイル一覧を作る。prefix付き(z80のcb/ed等)はスペース区切り */
  function opcodeFiles(group, prefix) {
    const out = [];
    for (let op = 0; op < 256; op++) {
      const h = hex2(op);
      const name = prefix ? `${prefix} ${h}` : h;
      out.push({ group, op, hex: h, name, path: `${encodeURIComponent(name)}.json`, localPath: `${name}.json` });
    }
    return out;
  }

  /** 共通の RAM + バス。テストは64KB空間しか使わない */
  function makeRam() {
    const ram = new Uint8Array(65536);
    return {
      ram,
      bus: { read: (a) => ram[a & 0xFFFF], write: (a, v) => { ram[a & 0xFFFF] = v & 0xFF; } },
    };
  }

  /** 1ケース分の後始末。次のケースに前のRAMが漏れないよう触ったアドレスを0に戻す */
  function clearRam(ram, I, F) {
    for (const [a] of I.ram) ram[a] = 0;
    for (const [a] of F.ram) ram[a] = 0;
  }

  function ramMatches(ram, F) {
    for (const [a, v] of F.ram) { if (ram[a] !== v) return false; }
    return true;
  }

  // ---------------------------------------------------------------- 6502
  CpuTest.SPECS = {
    '6502': {
      label: '6502 (nes6502 / 10進無効=2A03仕様)',
      vectorBase: 'https://cdn.jsdelivr.net/gh/SingleStepTests/65x02@main/nes6502/v1/',
      scripts: ['src/emulator/cpu6502.js'],
      defaultPer: 1000,
      groups: () => [{ key: 'main', files: opcodeFiles('main', null) }],
      createRunner() {
        const { ram, bus } = makeRam();
        const cpu = new MML.Emu.CPU6502(bus);
        return {
          // 非公式命令は未実装。テスト対象から外す(失敗ではない)
          isImplemented: (op) => !!MML.Emu.OPS[op],
          runOne(tests, per) {
            const n = Math.min(per, tests.length);
            let pass = 0, cycBad = 0, stateBad = 0, ramBad = 0; const fails = [];
            for (let i = 0; i < n; i++) {
              const t = tests[i], I = t.initial, F = t.final;
              for (const [a, v] of I.ram) ram[a] = v;
              cpu.PC = I.pc; cpu.S = I.s; cpu.A = I.a; cpu.X = I.x; cpu.Y = I.y; cpu.P = I.p; cpu.halted = false;
              const cyc = cpu.step();
              const regOK = cpu.PC === F.pc && cpu.S === F.s && cpu.A === F.a && cpu.X === F.x && cpu.Y === F.y && cpu.P === F.p;
              const ramOK = ramMatches(ram, F);
              const cycOK = cyc === t.cycles.length;
              if (regOK && ramOK && cycOK) pass++;
              else {
                if (!cycOK) cycBad++; if (!regOK) stateBad++; if (!ramOK) ramBad++;
                if (fails.length < 3) fails.push({
                  name: t.name, regOK, ramOK, cycOK,
                  exp: { pc: F.pc, s: F.s, a: F.a, x: F.x, y: F.y, p: F.p, cyc: t.cycles.length },
                  got: { pc: cpu.PC, s: cpu.S, a: cpu.A, x: cpu.X, y: cpu.Y, p: cpu.P, cyc },
                });
              }
              clearRam(ram, I, F);
            }
            return { pass, total: n, cycBad, stateBad, ramBad, fails };
          },
        };
      },
    },

    // ---------------------------------------------------------------- Z80
    z80: {
      label: 'Z80 (MSX/KSS)',
      vectorBase: 'https://cdn.jsdelivr.net/gh/SingleStepTests/z80@main/v1/',
      scripts: ['src/emulator/cpuZ80.js'],
      defaultPer: 300,
      groups: () => [
        { key: 'main', files: opcodeFiles('main', null) },
        { key: 'cb', files: opcodeFiles('cb', 'cb') },
        { key: 'ed', files: opcodeFiles('ed', 'ed') },
        { key: 'dd', files: opcodeFiles('dd', 'dd') },
        { key: 'fd', files: opcodeFiles('fd', 'fd') },
      ],
      createRunner() {
        const ram = new Uint8Array(65536);
        const ports = new Uint8Array(256);
        const bus = {
          read: (a) => ram[a & 0xFFFF], write: (a, v) => { ram[a & 0xFFFF] = v & 0xFF; },
          ioRead: (p) => ports[p & 0xFF], ioWrite: (p, v) => { ports[p & 0xFF] = v & 0xFF; },
        };
        const cpu = new MML.Emu.CPUZ80(bus);
        const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'i', 'r', 'sp', 'pc', 'im', 'iff1', 'iff2', 'ix', 'iy', 'af_', 'bc_', 'de_', 'hl_'];

        function applyState(s) {
          cpu.a = s.a; cpu.f = s.f; cpu.b = s.b; cpu.c = s.c; cpu.d = s.d; cpu.e = s.e; cpu.h = s.h; cpu.l = s.l;
          cpu.i = s.i; cpu.r = s.r; cpu.sp = s.sp; cpu.pc = s.pc; cpu.im = s.im;
          cpu.iff1 = !!s.iff1; cpu.iff2 = !!s.iff2;
          cpu.setIX(s.ix); cpu.setIY(s.iy);
          cpu.a2 = (s.af_ >> 8) & 0xFF; cpu.f2 = s.af_ & 0xFF;
          cpu.b2 = (s.bc_ >> 8) & 0xFF; cpu.c2 = s.bc_ & 0xFF;
          cpu.d2 = (s.de_ >> 8) & 0xFF; cpu.e2 = s.de_ & 0xFF;
          cpu.h2 = (s.hl_ >> 8) & 0xFF; cpu.l2 = s.hl_ & 0xFF;
          cpu.halted = false;
        }
        function stateOf() {
          return {
            a: cpu.a, f: cpu.f, b: cpu.b, c: cpu.c, d: cpu.d, e: cpu.e, h: cpu.h, l: cpu.l,
            i: cpu.i, r: cpu.r, sp: cpu.sp, pc: cpu.pc, im: cpu.im,
            iff1: cpu.iff1 ? 1 : 0, iff2: cpu.iff2 ? 1 : 0,
            ix: cpu.getIX(), iy: cpu.getIY(),
            af_: (cpu.a2 << 8) | cpu.f2, bc_: (cpu.b2 << 8) | cpu.c2,
            de_: (cpu.d2 << 8) | cpu.e2, hl_: (cpu.h2 << 8) | cpu.l2,
          };
        }

        return {
          isImplemented: () => true,
          runOne(tests, per) {
            const n = Math.min(per, tests.length);
            let pass = 0, cycBad = 0, stateBad = 0, ramBad = 0; const fails = [];
            for (let i = 0; i < n; i++) {
              const t = tests[i], I = t.initial, F = t.final;
              for (const [a, v] of I.ram) ram[a] = v;
              // IN命令が読む値はテストベクタの'ports'に記録されている(実機は16bitポートアドレスだが
              // 実際のMSXペリフェラルは下位8bitしかデコードしないため、下位8bitだけ再現すれば十分)
              if (t.ports) { for (const [a, v, rw] of t.ports) { if (rw === 'r') ports[a & 0xFF] = v; } }
              applyState(I);
              const cyc = cpu.step();
              const got = stateOf();
              let regOK = true;
              for (const k of KEYS) { if (got[k] !== F[k]) { regOK = false; break; } }
              const ramOK = ramMatches(ram, F);
              const cycOK = cyc === t.cycles.length;
              if (regOK && ramOK && cycOK) pass++;
              else {
                if (!cycOK) cycBad++; if (!regOK) stateBad++; if (!ramOK) ramBad++;
                if (fails.length < 3) fails.push({ name: t.name, regOK, ramOK, cycOK, exp: F, got, cycExp: t.cycles.length, cycGot: cyc });
              }
              clearRam(ram, I, F);
            }
            return { pass, total: n, cycBad, stateBad, ramBad, fails };
          },
        };
      },
    },

    // ---------------------------------------------------------------- SM83
    sm83: {
      label: 'SM83 (GB/GBS)',
      vectorBase: 'https://cdn.jsdelivr.net/gh/SingleStepTests/sm83@main/v1/',
      scripts: ['src/emulator/cpuSm83.js'],
      defaultPer: 300,
      groups: () => [
        { key: 'main', files: opcodeFiles('main', null) },
        { key: 'cb', files: opcodeFiles('cb', 'cb') },
      ],
      createRunner() {
        const { ram } = makeRam();
        // M サイクルごとのバスの動きも突き合わせる: tick が 1 サイクルを開き、read/write がその中身を埋める
        // (何も埋まらなければ内部サイクル)。ベクタの cycles は [番地, 値, "r-m"/"-wm"/"---"]
        let trace = [];
        const bus = {
          tick: () => { trace.push(null); },
          read: (a) => { const v = ram[a & 0xFFFF]; trace[trace.length - 1] = ['r', a & 0xFFFF, v]; return v; },
          write: (a, v) => { ram[a & 0xFFFF] = v & 0xFF; trace[trace.length - 1] = ['w', a & 0xFFFF, v & 0xFF]; },
        };
        const cpu = new MML.Emu.CPUSm83(bus);
        const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'sp', 'pc'];
        function busMatches(cycles) {
          if (trace.length !== cycles.length) return false;
          for (let i = 0; i < cycles.length; i++) {
            const c = cycles[i], t = trace[i], kind = c[2][0] === 'r' ? 'r' : c[2][1] === 'w' ? 'w' : '-';
            if (kind === '-') { if (t) return false; continue; }
            if (!t || t[0] !== kind || t[1] !== c[0] || t[2] !== c[1]) return false;
          }
          return true;
        }

        // テストベクタの initial.ie は前提条件の一部(HALTバグ等の分岐用)を表すだけで、
        // final側には存在しない(=検証対象外)。$FFFFは通常のram読み書き対象アドレスとしても
        // 使われうる(PCがラップして$FFFFから命令フェッチするケース等)ため、ie専用の書込みで
        // ram[0xFFFF]を上書きしてはいけない(実際にこれで命令バイトを破壊するバグがあった)。
        function applyState(s) {
          cpu.a = s.a; cpu.f = s.f; cpu.b = s.b; cpu.c = s.c; cpu.d = s.d; cpu.e = s.e; cpu.h = s.h; cpu.l = s.l;
          cpu.sp = s.sp; cpu.pc = s.pc;
          cpu.ime = !!s.ime;
          cpu.imePending = 0;
          cpu.halted = false;
          cpu.stopped = false;
          cpu.haltBug = false;
        }
        const stateOf = () => ({ a: cpu.a, f: cpu.f, b: cpu.b, c: cpu.c, d: cpu.d, e: cpu.e, h: cpu.h, l: cpu.l, sp: cpu.sp, pc: cpu.pc });

        return {
          isImplemented: () => true,
          runOne(tests, per) {
            const n = Math.min(per, tests.length);
            let pass = 0, cycBad = 0, stateBad = 0, ramBad = 0, imeBad = 0, busBad = 0; const fails = [];
            for (let i = 0; i < n; i++) {
              const t = tests[i], I = t.initial, F = t.final;
              for (const [a, v] of I.ram) ram[a] = v;
              applyState(I);
              trace = [];
              let cyc = cpu.step();
              const nominalOK = cpu.lastNominal === cyc; // 命令表の公称値と、実際に進めた M サイクルの合計
              // HALT のベクタは止まった後の空回り 2 サイクルまで含む
              while (cpu.halted && cyc < t.cycles.length * 4) cyc += cpu.step();
              const got = stateOf();
              let regOK = true;
              for (const k of KEYS) { if (got[k] !== F[k]) { regOK = false; break; } }
              const imeOK = cpu.ime === !!F.ime;
              const ramOK = ramMatches(ram, F);
              // ベクタのcyclesはMサイクル単位。こちらはTサイクルを返すので4倍で比較する
              const cycOK = cyc === t.cycles.length * 4 && nominalOK;
              const busOK = busMatches(t.cycles);
              if (regOK && ramOK && cycOK && imeOK && busOK) pass++;
              else {
                if (!cycOK) cycBad++; if (!regOK) stateBad++; if (!ramOK) ramBad++; if (!imeOK) imeBad++; if (!busOK) busBad++;
                if (fails.length < 3) fails.push({ name: t.name, regOK, ramOK, cycOK, imeOK, busOK, nominal: cpu.lastNominal, exp: F, got, cycExp: t.cycles.length * 4, cycGot: cyc, busExp: t.cycles, busGot: trace });
              }
              clearRam(ram, I, F);
            }
            return { pass, total: n, cycBad, stateBad, ramBad, imeBad, busBad, fails };
          },
        };
      },
    },

    // ---------------------------------------------------------------- SPC700
    spc700: {
      label: 'SPC700 (SNES/SPC)',
      vectorBase: 'https://cdn.jsdelivr.net/gh/SingleStepTests/spc700@main/v1/',
      scripts: ['src/emulator/spc700.js'],
      // このベクタにはサイクル数の検証を行わない(SPC700コアはstep()がサイクルを返さない)
      defaultPer: Infinity,
      groups: () => [{ key: 'main', files: opcodeFiles('main', null) }],
      createRunner() {
        const { ram, bus } = makeRam();
        const cpu = new MML.Emu.SPC700(bus);
        return {
          isImplemented: () => true,
          runOne(tests, per) {
            const n = Math.min(per, tests.length);
            let pass = 0, stateBad = 0, ramBad = 0; const fails = [];
            for (let i = 0; i < n; i++) {
              const t = tests[i], I = t.initial, F = t.final;
              for (const [a, v] of I.ram) ram[a] = v;
              cpu.PC = I.pc; cpu.A = I.a; cpu.X = I.x; cpu.Y = I.y;
              cpu.SP = I.sp; cpu.PSW = I.psw; cpu.halted = false;
              cpu.step();
              const regOK = cpu.A === F.a && cpu.X === F.x && cpu.Y === F.y
                && cpu.SP === F.sp && cpu.PC === F.pc && cpu.PSW === F.psw;
              const ramOK = ramMatches(ram, F);
              if (regOK && ramOK) pass++;
              else {
                if (!regOK) stateBad++; if (!ramOK) ramBad++;
                if (fails.length < 3) fails.push({
                  name: t.name, regOK, ramOK, cycOK: true,
                  exp: { a: F.a, x: F.x, y: F.y, sp: F.sp, pc: F.pc, psw: '0x' + F.psw.toString(16) },
                  got: { a: cpu.A, x: cpu.X, y: cpu.Y, sp: cpu.SP, pc: cpu.PC, psw: '0x' + cpu.PSW.toString(16) },
                });
              }
              clearRam(ram, I, F);
            }
            return { pass, total: n, cycBad: 0, stateBad, ramBad, fails };
          },
        };
      },
    },
  };

  // ---------------------------------------------------------------- 65816
  // ファイルは命令ごとに 2 本: <op>.n.json(ネイティブ)と <op>.e.json(エミュレーション)。番地は 24bit なので RAM は 16MB。
  // 見る物: レジスタ(pc s p a x y dbr d pbr e)、RAM、サイクル数
  CpuTest.SPECS['65816'] = {
    label: '65C816 (SNES / スーパーゲームボーイ)',
    vectorBase: 'https://raw.githubusercontent.com/SingleStepTests/65816/main/v1/',
    scripts: ['src/emulator/cpu65816.js'],
    defaultPer: 10000,
    groups: () => ['n', 'e'].map((mode) => ({
      key: mode,
      files: Array.from({ length: 256 }, (_, op) => { const h = hex2(op); return { group: mode, op, hex: h, name: h + '.' + mode, path: h + '.' + mode + '.json', localPath: h + '.' + mode + '.json' }; }),
    })),
    createRunner() {
      const ram = new Uint8Array(1 << 24);
      const bus = { read: (a) => ram[a & 0xFFFFFF], write: (a, v) => { ram[a & 0xFFFFFF] = v & 0xFF; } };
      const cpu = new MML.Emu.CPU65816(bus);
      const KEYS = ['pc', 's', 'p', 'a', 'x', 'y', 'dbr', 'd', 'pbr', 'e'];
      return {
        isImplemented: () => true,
        runOne(tests, per) {
          const n = Math.min(per, tests.length);
          let pass = 0, cycBad = 0, stateBad = 0, ramBad = 0; const fails = [];
          for (let i = 0; i < n; i++) {
            const t = tests[i], I = t.initial, F = t.final;
            for (const [a, v] of I.ram) ram[a] = v;
            for (const k of KEYS) cpu[k] = I[k];
            cpu.waiting = false; cpu.stopped = false;
            // ベクタの初期値は e=1 でも S の上位などが好き勝手な値。実機が保っている形(S 上位=$01、X/Y 上位=0、M=X=1)に直してから走らせる
            if (cpu.e) { cpu.s = 0x0100 | (cpu.s & 0xFF); cpu.x &= 0xFF; cpu.y &= 0xFF; cpu.p |= 0x30; }
            let cyc = cpu.step();
            // MVN/MVP のベクタは「A が $FFFF になるまで」を 1 回として数えている(実機は 1 バイトごとに命令を取り直す)
            if (t.cycles.length > 7 && (ram[(I.pbr << 16) | I.pc] === 0x44 || ram[(I.pbr << 16) | I.pc] === 0x54)) { let guard = 0; while (cpu.pc === I.pc && guard++ < 70000) cyc += cpu.step(); }
            // WAI/STP のベクタは止まった後の空回り 1 サイクルまで含む
            while ((cpu.waiting || cpu.stopped) && cyc < t.cycles.length) cyc += cpu.step();
            let regOK = true; for (const k of KEYS) if (cpu[k] !== F[k]) { regOK = false; break; }
            let ramOK = true; for (const [a, v] of F.ram) if (ram[a] !== v) { ramOK = false; break; }
            const cycOK = cyc === t.cycles.length;
            if (regOK && ramOK && cycOK) pass++;
            else {
              if (!cycOK) cycBad++; if (!regOK) stateBad++; if (!ramOK) ramBad++;
              if (fails.length < 3) { const got = {}; for (const k of KEYS) got[k] = cpu[k]; got.cyc = cyc; const exp = {}; for (const k of KEYS) exp[k] = F[k]; exp.cyc = t.cycles.length; const ini = {}; for (const k of KEYS) ini[k] = I[k]; fails.push({ name: t.name, regOK, ramOK, cycOK, exp, got, ini }); }
            }
            for (const [a] of I.ram) ram[a] = 0;
            for (const [a] of F.ram) ram[a] = 0;
          }
          return { pass, total: n, cycBad, stateBad, ramBad, fails };
        },
      };
    },
  };

  // ---------------------------------------------------------------- HuC6280
  // SingleStepTests/huc6280(MIT)。Mesen 2 が作ったベクタなので「Mesen と同じか」を測る物(実機の保証ではない)。
  // ファイルはバイナリ(<op>.json.bin)。番地は MPR を通した後の 21bit(2MB の平らな RAM、I/O は無い)。
  // 見る物: レジスタ(A X Y S P PC)、MPR、RAM、サイクル数、サイクルごとのバスの動き(番地・値・読み/書き/内部)。
  // 記録は 500 サイクル/500 番地まで(ブロック転送はそこまでを比べ、総サイクル数は num_cycles で見る)。
  // TSB/TRB($04 $0C $14 $1C)の Z フラグだけは比べない: ベクタは (A & メモリ)=0、手元の Mesen 2 の実物とソースは「書き戻す値が 0」で、
  // 本体は後者に合わせてある(cpuHuC6280.js の TSB の説明)。ベクタと違った件数は zDiff に数える。
  CpuTest.SPECS.huc6280 = {
    label: 'HuC6280 (PC エンジン / HES)',
    vectorBase: 'https://raw.githubusercontent.com/SingleStepTests/huc6280/main/v1/',
    scripts: ['src/emulator/cpuHuC6280.js'],
    defaultPer: 2500,
    groups: () => [{ key: 'main', files: Array.from({ length: 256 }, (_, op) => { const h = hex2(op); return { group: 'main', op, hex: h, name: h, path: h + '.json.bin', localPath: h + '.json.bin' }; }) }],
    decode(b) {
      const u32 = (p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
      const n = u32(0); let p = 4; const out = [];
      const state = (q) => {
        const sz = u32(q); let r = q + 4;
        const s = { A: b[r], X: b[r + 1], Y: b[r + 2], S: b[r + 3], P: b[r + 4], PC: b[r + 5] | (b[r + 6] << 8), MPR: Array.from(b.subarray(r + 7, r + 15)), ram: [] };
        r += 15; const nr = u32(r); r += 4;
        for (let i = 0; i < nr; i++) { s.ram.push([u32(r), b[r + 4]]); r += 5; }
        return [sz, s];
      };
      for (let i = 0; i < n; i++) {
        const full = u32(p); let q = p + 4;
        let name = ''; for (let k = 0; k < 50 && b[q + k]; k++) name += String.fromCharCode(b[q + k]);
        const t = { name: name.trim() }; q += 50;
        t.opcode = u32(q); q += 4;
        let sz; [sz, t.initial] = state(q); q += sz; [sz, t.final] = state(q); q += sz;
        t.num_cycles = u32(q); const rec = u32(q + 4); q += 8;
        t.cycles = new Uint32Array(rec);
        for (let k = 0; k < rec; k++) { t.cycles[k] = u32(q); q += 4; }
        out.push(t); p += full;
      }
      return out;
    },
    createRunner() {
      const ram = new Uint8Array(1 << 21);
      const mpr = new Uint8Array(8);
      // バスの記録: 1 サイクル 1 個。0 = 内部サイクル、それ以外はベクタと同じ詰め方(bit0 読み、bit1 書き、bit3-23 番地、bit24-31 値)
      let trace = [], tn = 0;
      const bus = {
        tick: () => { trace[tn++] = 0; },
        read: (a) => { const pa = (mpr[a >>> 13] << 13) | (a & 0x1FFF), v = ram[pa]; trace[tn - 1] = (1 | (pa << 3) | (v << 24)) >>> 0; return v; },
        write: (a, v) => { const pa = (mpr[a >>> 13] << 13) | (a & 0x1FFF); ram[pa] = v; trace[tn - 1] = (2 | (pa << 3) | (v << 24)) >>> 0; },
        setMpr: (i, v) => { mpr[i] = v; },
        getMpr: (i) => mpr[i],
        irqLines: () => 0,
      };
      const cpu = new MML.Emu.CPUHuC6280(bus);
      const KEYS = ['A', 'X', 'Y', 'S', 'P', 'PC'], KEYS_CUT = ['S', 'P', 'PC'];
      const showBus = (list, n) => { let s = ''; for (let i = 0; i < Math.min(n, 24); i++) { const c = list[i] >>> 0; s += (c & 3) ? ((c >>> 3) & 0x1FFFFF).toString(16) + ':' + (c >>> 24).toString(16) + ((c & 1) ? 'r' : 'w') + ' ' : '-- '; } return s; };
      return {
        isImplemented: () => true,
        runOne(tests, per) {
          const n = Math.min(per, tests.length);
          let pass = 0, cycBad = 0, stateBad = 0, ramBad = 0, busBad = 0, cutCount = 0, zDiff = 0; const fails = [];
          for (let i = 0; i < n; i++) {
            const t = tests[i], I = t.initial, F = t.final;
            for (const [a, v] of I.ram) ram[a] = v;
            for (let k = 0; k < 8; k++) mpr[k] = I.MPR[k];
            cpu.A = I.A; cpu.X = I.X; cpu.Y = I.Y; cpu.S = I.S; cpu.P = I.P; cpu.PC = I.PC;
            cpu.irqSample = 0;
            tn = 0;
            const cyc = cpu.step();
            // 記録が 500 サイクルで切られたケース(長いブロック転送)は、読む元のメモリが最初の 500 番地ぶんしか載っていない。
            // 転送した中身と、転送でスタックを上書きした時の A/X/Y は確かめようが無いので、S・P・PC・総サイクル数・切られる前までのバスだけを見る
            const cut = t.num_cycles > t.cycles.length;
            let regOK = true;
            const zSkip = t.opcode === 0x04 || t.opcode === 0x0C || t.opcode === 0x14 || t.opcode === 0x1C;
            if (zSkip && ((cpu.P ^ F.P) & 0x02)) zDiff++;
            for (const k of (cut ? KEYS_CUT : KEYS)) if (k === 'P' && zSkip ? ((cpu.P ^ F.P) & ~0x02) !== 0 : cpu[k] !== F[k]) { regOK = false; break; }
            for (let k = 0; k < 8; k++) if (mpr[k] !== F.MPR[k]) regOK = false;
            const ramOK = cut || ramMatches(ram, F);
            const cycOK = cyc === t.num_cycles;
            if (cut) cutCount++;
            // 読み/書き/内部の別と番地・値。ベクタの「空読み」印(bit2)は見ない
            let busOK = true;
            const rec = t.cycles.length;
            if (tn < rec) busOK = false;
            else for (let k = 0; k < rec; k++) { const e = t.cycles[k]; const want = (e & 3) ? (e & ~4) >>> 0 : 0; if (trace[k] !== want) { busOK = false; break; } }
            if (regOK && ramOK && cycOK && busOK) pass++;
            else {
              if (!cycOK) cycBad++; if (!regOK) stateBad++; if (!ramOK) ramBad++; if (!busOK) busBad++;
              if (fails.length < 3) {
                const got = {}; for (const k of KEYS) got[k] = cpu[k]; got.MPR = Array.from(mpr); got.cyc = cyc;
                const exp = {}; for (const k of KEYS) exp[k] = F[k]; exp.MPR = F.MPR; exp.cyc = t.num_cycles;
                const ini = {}; for (const k of KEYS) ini[k] = I[k]; ini.MPR = I.MPR;
                fails.push({ name: t.name, regOK, ramOK, cycOK, busOK, exp, got, ini, bus: busOK ? '' : '期待 ' + showBus(t.cycles, rec) + '/ 実際 ' + showBus(trace, tn) });
              }
            }
            for (const [a] of I.ram) ram[a] = 0;
            for (const [a] of F.ram) ram[a] = 0;
            if (cut) ram.fill(0); // 記録に無い番地へも書いている
          }
          return { pass, total: n, cycBad, stateBad, ramBad, busBad, cut: cutCount, zDiff, fails };
        },
      };
    },
  };

  CpuTest.opcodeFiles = opcodeFiles;
})(typeof window !== 'undefined' ? window : globalThis);
