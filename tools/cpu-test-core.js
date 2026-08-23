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
        const { ram, bus } = makeRam();
        const cpu = new MML.Emu.CPUSm83(bus);
        const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'sp', 'pc'];

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
        }
        const stateOf = () => ({ a: cpu.a, f: cpu.f, b: cpu.b, c: cpu.c, d: cpu.d, e: cpu.e, h: cpu.h, l: cpu.l, sp: cpu.sp, pc: cpu.pc });

        return {
          isImplemented: () => true,
          runOne(tests, per) {
            const n = Math.min(per, tests.length);
            let pass = 0, cycBad = 0, stateBad = 0, ramBad = 0, imeBad = 0; const fails = [];
            for (let i = 0; i < n; i++) {
              const t = tests[i], I = t.initial, F = t.final;
              for (const [a, v] of I.ram) ram[a] = v;
              applyState(I);
              const cyc = cpu.step();
              const got = stateOf();
              let regOK = true;
              for (const k of KEYS) { if (got[k] !== F[k]) { regOK = false; break; } }
              const imeOK = cpu.ime === !!F.ime;
              const ramOK = ramMatches(ram, F);
              // ベクタのcyclesはMサイクル単位。こちらはTサイクルを返すので4倍で比較する
              const cycOK = cyc === t.cycles.length * 4;
              if (regOK && ramOK && cycOK && imeOK) pass++;
              else {
                if (!cycOK) cycBad++; if (!regOK) stateBad++; if (!ramOK) ramBad++; if (!imeOK) imeBad++;
                if (fails.length < 3) fails.push({ name: t.name, regOK, ramOK, cycOK, imeOK, exp: F, got, cycExp: t.cycles.length * 4, cycGot: cyc });
              }
              clearRam(ram, I, F);
            }
            return { pass, total: n, cycBad, stateBad, ramBad, imeBad, fails };
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

  CpuTest.opcodeFiles = opcodeFiles;
})(typeof window !== 'undefined' ? window : globalThis);
