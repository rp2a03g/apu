/*
 * MIPS R3000A コアの単体テスト(ヘッドレス)
 *   node tools/headless/r3000-test.js
 *
 * SingleStepTests に MIPS の版は無いので、独立した「別表現の正解」と突き合わせる:
 *   - MULT/MULTU: BigInt で 64bit 積を計算
 *   - DIV/DIVU: 0除算/最小値÷-1 の実機仕様値
 *   - LWL/LWR/SWL/SWR: バイト単位の定義(「aから整列境界までのバイトをレジスタの上位/下位へ」)
 *   - ロード遅延/分岐遅延/例外/RFE: 手で組んだ命令列の期待値
 */
'use strict';
const { load } = require('./load');
const { MML } = load({ skip: [/main\.js$/, /src\/ui\//, /src\/audio\//, /capture-worker/] });
const CPU = MML.Emu.CPUR3000;

// ── 最小バス(RAM 64KB、0x00000000/0x80000000 ミラー) ─────────
function makeBus() {
  const ram = new Uint8Array(0x10000);
  const dv = new DataView(ram.buffer);
  const m = (a) => (a >>> 0) & 0xFFFF;
  return {
    ram, irqLine: false,
    read8: (a) => ram[m(a)], read16: (a) => dv.getUint16(m(a), true), read32: (a) => dv.getInt32(m(a), true),
    write8: (a, v) => { ram[m(a)] = v; }, write16: (a, v) => dv.setUint16(m(a), v, true), write32: (a, v) => dv.setInt32(m(a), v, true),
  };
}

// ── 簡易アセンブラ ────────────────────────────────────────────
const R = (fn, rs, rt, rd, sa = 0) => ((rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | fn) >>> 0;
const I = (opc, rs, rt, imm) => ((opc << 26) | (rs << 21) | (rt << 16) | (imm & 0xFFFF)) >>> 0;
const A = {
  nop: () => 0,
  addiu: (rt, rs, imm) => I(0x09, rs, rt, imm), addi: (rt, rs, imm) => I(0x08, rs, rt, imm),
  ori: (rt, rs, imm) => I(0x0D, rs, rt, imm), lui: (rt, imm) => I(0x0F, 0, rt, imm),
  lw: (rt, off, base) => I(0x23, base, rt, off), sw: (rt, off, base) => I(0x2B, base, rt, off),
  lwl: (rt, off, base) => I(0x22, base, rt, off), lwr: (rt, off, base) => I(0x26, base, rt, off),
  swl: (rt, off, base) => I(0x2A, base, rt, off), swr: (rt, off, base) => I(0x2E, base, rt, off),
  lb: (rt, off, base) => I(0x20, base, rt, off), lh: (rt, off, base) => I(0x21, base, rt, off),
  beq: (rs, rt, off) => I(0x04, rs, rt, off), bne: (rs, rt, off) => I(0x05, rs, rt, off),
  jal: (t) => ((0x03 << 26) | ((t >>> 2) & 0x03FFFFFF)) >>> 0, j: (t) => ((0x02 << 26) | ((t >>> 2) & 0x03FFFFFF)) >>> 0,
  jr: (rs) => R(0x08, rs, 0, 0), jalr: (rd, rs) => R(0x09, rs, 0, rd),
  mult: (rs, rt) => R(0x18, rs, rt, 0), multu: (rs, rt) => R(0x19, rs, rt, 0),
  div: (rs, rt) => R(0x1A, rs, rt, 0), divu: (rs, rt) => R(0x1B, rs, rt, 0),
  mfhi: (rd) => R(0x10, 0, 0, rd), mflo: (rd) => R(0x12, 0, 0, rd),
  add: (rd, rs, rt) => R(0x20, rs, rt, rd), addu: (rd, rs, rt) => R(0x21, rs, rt, rd),
  syscall: () => 0x0C, rfe: () => (0x10 << 26) | (0x10 << 21) | 0x10,
  mfc0: (rt, rd) => (0x10 << 26) | (rt << 16) | (rd << 11), mtc0: (rt, rd) => (0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11),
  bgezal: (rs, off) => I(0x01, rs, 0x11, off), bltz: (rs, off) => I(0x01, rs, 0x00, off),
};

let fails = 0, total = 0;
function check(name, actual, expected) {
  total++;
  if (actual !== expected) { fails++; console.log(`FAIL ${name}: got ${fmt(actual)} expected ${fmt(expected)}`); }
}
const fmt = (v) => (typeof v === 'number' ? '0x' + (v >>> 0).toString(16) : String(v));

function runProgram(words, setup, steps) {
  const bus = makeBus();
  const cpu = new CPU(bus);
  cpu.reset();
  cpu.sr = 0; // 例外ベクタを 0x80000080 に(BEV=0)
  const base = 0x1000;
  for (let i = 0; i < words.length; i++) bus.write32(base + i * 4, words[i] | 0);
  cpu.setEntry(0x80000000 | base, 0x8000F000, 0);
  if (setup) setup(cpu, bus);
  for (let i = 0; i < (steps || words.length); i++) cpu.step();
  return { cpu, bus };
}

// ── 1. MULT/MULTU vs BigInt ───────────────────────────────────
{
  const bus = makeBus(); const cpu = new CPU(bus); cpu.reset();
  const samples = [0, 1, -1, 2, -2, 0x7FFFFFFF, -0x80000000, 0x12345678, -0x12345678, 0xFFFF, 0x10000, -0x10000, 0x7FFF0001, 0x80000001 | 0];
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) | 0; return seed; };
  for (let i = 0; i < 400; i++) samples.push(rnd());
  for (const a of samples) for (const b of samples.slice(0, 40)) {
    cpu.mult(a, b, true);
    const p = BigInt(a) * BigInt(b);
    const lo = Number(BigInt.asIntN(32, p)), hi = Number(BigInt.asIntN(32, p >> 32n));
    check(`mult ${a}*${b} lo`, cpu.lo, lo); check(`mult ${a}*${b} hi`, cpu.hi, hi);
    cpu.mult(a, b, false);
    const pu = BigInt(a >>> 0) * BigInt(b >>> 0);
    check(`multu ${a}*${b} lo`, cpu.lo, Number(BigInt.asIntN(32, pu))); check(`multu ${a}*${b} hi`, cpu.hi, Number(BigInt.asIntN(32, pu >> 32n)));
  }
}

// ── 2. DIV/DIVU の仕様値 ──────────────────────────────────────
{
  const t = (asm, r1, r2, lo, hi, name) => {
    const { cpu } = runProgram([asm(1, 2), A.mflo(3), A.mfhi(4), A.nop()], (c) => { c.r[1] = r1; c.r[2] = r2; }, 4);
    check(name + ' lo', cpu.r[3], lo | 0); check(name + ' hi', cpu.r[4], hi | 0);
  };
  t(A.div, 7, 2, 3, 1, 'div 7/2'); t(A.div, -7, 2, -3, -1, 'div -7/2'); t(A.div, 7, -2, -3, 1, 'div 7/-2');
  t(A.div, 5, 0, -1, 5, 'div 5/0'); t(A.div, -5, 0, 1, -5, 'div -5/0'); t(A.div, -0x80000000, -1, -0x80000000, 0, 'div min/-1');
  t(A.divu, 0xFFFFFFFF | 0, 2, 0x7FFFFFFF, 1, 'divu max/2'); t(A.divu, 9, 0, -1, 9, 'divu 9/0');
}

// ── 3. LWL/LWR/SWL/SWR vs バイト定義 ───────────────────────────
{
  let seed = 777;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return seed; };
  for (let iter = 0; iter < 200; iter++) {
    const off = 0x2000 + (rnd() & 0xFF) + (iter & 3);
    const memWord = rnd(), regVal = rnd();
    const memBytes = [memWord & 0xFF, (memWord >>> 8) & 0xFF, (memWord >>> 16) & 0xFF, (memWord >>> 24) & 0xFF];
    const regBytes = [regVal & 0xFF, (regVal >>> 8) & 0xFF, (regVal >>> 16) & 0xFF, (regVal >>> 24) & 0xFF];
    const al = off & ~3, k0 = off & 3;
    // LWL: メモリ a..(a&~3) のバイトをレジスタ上位側へ
    {
      const exp = regBytes.slice();
      for (let k = 0; k <= k0; k++) exp[3 - k] = memBytes[k0 - k];
      const { cpu } = runProgram([A.lwl(2, off, 1), A.nop(), A.nop()], (c, b) => { c.r[1] = 0; c.r[2] = regVal; b.write32(al, memWord); }, 3);
      check(`lwl off&3=${k0}`, cpu.r[2], (exp[0] | (exp[1] << 8) | (exp[2] << 16) | (exp[3] << 24)) | 0);
    }
    // LWR: メモリ a..(a|3) のバイトをレジスタ下位側へ
    {
      const exp = regBytes.slice();
      for (let k = 0; k <= 3 - k0; k++) exp[k] = memBytes[k0 + k];
      const { cpu } = runProgram([A.lwr(2, off, 1), A.nop(), A.nop()], (c, b) => { c.r[1] = 0; c.r[2] = regVal; b.write32(al, memWord); }, 3);
      check(`lwr off&3=${k0}`, cpu.r[2], (exp[0] | (exp[1] << 8) | (exp[2] << 16) | (exp[3] << 24)) | 0);
    }
    // SWL
    {
      const exp = memBytes.slice();
      for (let k = 0; k <= k0; k++) exp[k0 - k] = regBytes[3 - k];
      const { bus } = runProgram([A.swl(2, off, 1), A.nop()], (c, b) => { c.r[1] = 0; c.r[2] = regVal; b.write32(al, memWord); }, 2);
      check(`swl off&3=${k0}`, bus.read32(al), (exp[0] | (exp[1] << 8) | (exp[2] << 16) | (exp[3] << 24)) | 0);
    }
    // SWR
    {
      const exp = memBytes.slice();
      for (let k = 0; k <= 3 - k0; k++) exp[k0 + k] = regBytes[k];
      const { bus } = runProgram([A.swr(2, off, 1), A.nop()], (c, b) => { c.r[1] = 0; c.r[2] = regVal; b.write32(al, memWord); }, 2);
      check(`swr off&3=${k0}`, bus.read32(al), (exp[0] | (exp[1] << 8) | (exp[2] << 16) | (exp[3] << 24)) | 0);
    }
  }
  // 非整列ワードの読み(lwl+lwr の定石)。lwr が lwl の遅延中の値を土台にすること
  for (let k0 = 0; k0 < 4; k0++) {
    const off = 0x3000 + k0;
    const { cpu } = runProgram([A.lwl(2, off + 3, 1), A.lwr(2, off, 1), A.nop(), A.nop()], (c, b) => {
      c.r[1] = 0; c.r[2] = 0x11111111;
      for (let i = 0; i < 8; i++) b.write8(0x3000 + i, 0xA0 + i);
    }, 4);
    const exp = ((0xA0 + k0) | ((0xA1 + k0) << 8) | ((0xA2 + k0) << 16) | ((0xA3 + k0) << 24)) | 0;
    check(`lwl+lwr unaligned k0=${k0}`, cpu.r[2], exp);
  }
}

// ── 4. ロード結果は即時に見える(PS1 実機準拠。cpuR3000.js ld() の注記) ─────
{
  const { cpu } = runProgram([A.lw(2, 0, 1), A.addiu(3, 2, 0), A.nop()], (c, b) => { c.r[1] = 0x4000; c.r[2] = 7; b.write32(0x4000, 99); }, 2);
  check('load: next instruction sees new value', cpu.r[3], 99);
  const r2 = runProgram([A.lw(2, 0, 1), A.addiu(2, 0, 5), A.nop()], (c, b) => { c.r[1] = 0x4000; b.write32(0x4000, 99); }, 2);
  check('load then overwrite', r2.cpu.r[2], 5);
  const r3 = runProgram([A.lw(2, 0, 1), A.lw(2, 4, 1), A.nop()], (c, b) => { c.r[1] = 0x4000; b.write32(0x4000, 11); b.write32(0x4004, 22); }, 2);
  check('back-to-back loads', r3.cpu.r[2], 22);
  const r4 = runProgram([A.lb(2, 0, 1), A.lh(3, 2, 1), A.nop()], (c, b) => { c.r[1] = 0x4000; b.write32(0x4000, 0x8000FF80 | 0); }, 2);
  check('lb sign', r4.cpu.r[2], -128); check('lh sign', r4.cpu.r[3], -32768);
  // Philosoma の起動コード: lw s7,4(s4) の直後に add s7,s7,s4(遅延があるとオーバーフロー例外)
  const r5 = runProgram([A.lw(23, 4, 20), A.add(23, 23, 20), A.nop()], (c, b) => { c.sr = 0; c.r[23] = 0x80040000 | 0; c.r[20] = 0x80004000 | 0; b.write32(0x4004, 0x20); }, 2);
  check('philosoma idiom: no overflow', r5.cpu.exceptionCount, 0);
  check('philosoma idiom: value', r5.cpu.r[23], 0x80004020 | 0);
}

// ── 5. 分岐遅延 / リンク ───────────────────────────────────────
{
  // beq taken: 遅延スロットは実行される、その次は飛ばされる
  const { cpu } = runProgram([A.beq(0, 0, 2), A.addiu(2, 0, 1), A.addiu(3, 0, 1), A.addiu(4, 0, 1), A.nop()], null, 4);
  check('beq: delay slot ran', cpu.r[2], 1); check('beq: skipped', cpu.r[3], 0); check('beq: target ran', cpu.r[4], 1);
  // jal: ra = jal+8、遅延スロット実行
  const r2 = runProgram([A.jal(0x80001020), A.addiu(2, 0, 1), A.nop(), A.nop(), A.nop(), A.nop(), A.nop(), A.nop(), A.addiu(3, 0, 1), A.nop()], null, 4);
  check('jal: ra', r2.cpu.r[31], 0x80001008 | 0); check('jal: slot', r2.cpu.r[2], 1); check('jal: target', r2.cpu.r[3], 1);
  // jr 戻り
  const r3 = runProgram([A.addiu(1, 0, 0x1010), A.lui(1, 0x8000), A.ori(1, 1, 0x1018), A.jr(1), A.nop(), A.addiu(5, 0, 9), A.addiu(6, 0, 9)], null, 6);
  check('jr: skipped', r3.cpu.r[5], 0); check('jr: landed', r3.cpu.r[6], 9);
  // bgezal: rt=0x11、ra は常に設定される
  const r4 = runProgram([A.bgezal(0, 1), A.nop(), A.addiu(2, 0, 3), A.nop()], null, 3);
  check('bgezal: ra', r4.cpu.r[31], 0x80001008 | 0); check('bgezal: taken', r4.cpu.r[2], 3);
  // bltz 不成立
  const r5 = runProgram([A.bltz(0, 1), A.nop(), A.addiu(2, 0, 3), A.nop()], null, 3);
  check('bltz not taken', r5.cpu.r[2], 3);
}

// ── 6. 例外(SYSCALL)・SR シフト・EPC・RFE ─────────────────────
{
  const prog = [A.addiu(2, 0, 1), A.syscall(), A.addiu(3, 0, 1)];
  const { cpu } = runProgram(prog, (c) => { c.sr = 0x00000401; }, 2);
  check('syscall: pc=vector', cpu.pc, 0x80000080 | 0);
  check('syscall: epc', cpu.epc, 0x80001004 | 0);
  check('syscall: cause code', (cpu.cause >> 2) & 0x1F, 8);
  check('syscall: sr shifted', cpu.sr & 0x3F, 0x04);
  cpu.rfe();
  check('rfe: sr restored', cpu.sr & 0x3F, 0x01);
  // 遅延スロット内の例外: EPC は分岐命令、BD ビット
  const r2 = runProgram([A.beq(0, 0, 3), A.syscall(), A.nop(), A.nop(), A.nop()], (c) => { c.sr = 0; }, 2);
  check('syscall in delay slot: epc=branch', r2.cpu.epc, 0x80001000 | 0);
  check('syscall in delay slot: BD', r2.cpu.cause < 0, true);
  // 割込み受理
  const r3 = runProgram([A.addiu(2, 0, 1), A.addiu(3, 0, 1), A.nop()], (c, b) => { c.sr = 0x00000401; b.irqLine = true; }, 1);
  check('irq: taken before first instr', r3.cpu.pc, 0x80000080 | 0);
  check('irq: epc', r3.cpu.epc, 0x80001000 | 0);
  check('irq: cause IP2', r3.cpu.cause & 0x400, 0x400);
  check('irq: no instr ran', r3.cpu.r[2], 0);
  // マスクされていれば受理しない
  const r4 = runProgram([A.addiu(2, 0, 1), A.nop()], (c, b) => { c.sr = 0x00000001; b.irqLine = true; }, 1);
  check('irq masked: ran', r4.cpu.r[2], 1);
  // BEV=1 なら 0xBFC00180
  const r5 = runProgram([A.syscall(), A.nop()], (c) => { c.sr = 0x00400000; }, 1);
  check('bev vector', r5.cpu.pc, 0xBFC00180 | 0);
}

// ── 7. ADD/ADDI オーバーフロー例外 ────────────────────────────
{
  const { cpu } = runProgram([A.add(3, 1, 2), A.nop()], (c) => { c.sr = 0; c.r[1] = 0x7FFFFFFF; c.r[2] = 1; c.r[3] = 5; }, 1);
  check('add overflow: exception', (cpu.cause >> 2) & 0x1F, 12); check('add overflow: rd untouched', cpu.r[3], 5);
  const r2 = runProgram([A.addu(3, 1, 2), A.nop()], (c) => { c.r[1] = 0x7FFFFFFF; c.r[2] = 1; }, 1);
  check('addu wraps', r2.cpu.r[3], -0x80000000);
  const r3 = runProgram([A.addi(3, 1, -1), A.nop()], (c) => { c.sr = 0; c.r[1] = -0x80000000; c.r[3] = 5; }, 1);
  check('addi overflow', (r3.cpu.cause >> 2) & 0x1F, 12);
  // r0 は常に0
  const r4 = runProgram([A.addiu(0, 0, 5), A.lw(0, 0, 1), A.nop(), A.nop()], (c, b) => { c.r[1] = 0x4000; b.write32(0x4000, 3); }, 4);
  check('r0 stays zero', r4.cpu.r[0], 0);
}

console.log(`${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
