/*
 * MIPS R3000A 逆アセンブラ(デバッグ用、ヘッドレス)
 *   const { disasm } = require('./r3000-disasm');
 *   disasm(word, pc) → "addiu sp, sp, -24"
 */
'use strict';
const REG = ['zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];
const hex = (v) => '0x' + (v >>> 0).toString(16);

function disasm(op, pc) {
  op >>>= 0;
  const rs = REG[(op >>> 21) & 31], rt = REG[(op >>> 16) & 31], rd = REG[(op >>> 11) & 31];
  const sa = (op >>> 6) & 31, imm = (op << 16) >> 16, immU = op & 0xFFFF;
  const btarget = hex((pc + 4 + (imm << 2)) | 0);
  const jtarget = hex(((pc + 4) & 0xF0000000) | ((op & 0x03FFFFFF) << 2));
  const mem = (name) => `${name} ${rt}, ${imm}(${rs})`;
  switch (op >>> 26) {
    case 0x00: {
      const fn = op & 0x3F;
      const names = { 0x00: 'sll', 0x02: 'srl', 0x03: 'sra' };
      if (op === 0) return 'nop';
      if (names[fn]) return `${names[fn]} ${rd}, ${rt}, ${sa}`;
      const v = { 0x04: 'sllv', 0x06: 'srlv', 0x07: 'srav' };
      if (v[fn]) return `${v[fn]} ${rd}, ${rt}, ${rs}`;
      switch (fn) {
        case 0x08: return `jr ${rs}`;
        case 0x09: return `jalr ${rd}, ${rs}`;
        case 0x0C: return `syscall ${hex((op >>> 6) & 0xFFFFF)}`;
        case 0x0D: return `break ${hex((op >>> 6) & 0xFFFFF)}`;
        case 0x10: return `mfhi ${rd}`; case 0x11: return `mthi ${rs}`;
        case 0x12: return `mflo ${rd}`; case 0x13: return `mtlo ${rs}`;
        case 0x18: return `mult ${rs}, ${rt}`; case 0x19: return `multu ${rs}, ${rt}`;
        case 0x1A: return `div ${rs}, ${rt}`; case 0x1B: return `divu ${rs}, ${rt}`;
      }
      const r3 = { 0x20: 'add', 0x21: 'addu', 0x22: 'sub', 0x23: 'subu', 0x24: 'and', 0x25: 'or', 0x26: 'xor', 0x27: 'nor', 0x2A: 'slt', 0x2B: 'sltu' };
      if (r3[fn]) return `${r3[fn]} ${rd}, ${rs}, ${rt}`;
      return `special? ${hex(op)}`;
    }
    case 0x01: {
      const n = { 0x00: 'bltz', 0x01: 'bgez', 0x10: 'bltzal', 0x11: 'bgezal' }[(op >>> 16) & 31] || 'regimm?';
      return `${n} ${rs}, ${btarget}`;
    }
    case 0x02: return `j ${jtarget}`;
    case 0x03: return `jal ${jtarget}`;
    case 0x04: return `beq ${rs}, ${rt}, ${btarget}`;
    case 0x05: return `bne ${rs}, ${rt}, ${btarget}`;
    case 0x06: return `blez ${rs}, ${btarget}`;
    case 0x07: return `bgtz ${rs}, ${btarget}`;
    case 0x08: return `addi ${rt}, ${rs}, ${imm}`;
    case 0x09: return `addiu ${rt}, ${rs}, ${imm}`;
    case 0x0A: return `slti ${rt}, ${rs}, ${imm}`;
    case 0x0B: return `sltiu ${rt}, ${rs}, ${imm}`;
    case 0x0C: return `andi ${rt}, ${rs}, ${hex(immU)}`;
    case 0x0D: return `ori ${rt}, ${rs}, ${hex(immU)}`;
    case 0x0E: return `xori ${rt}, ${rs}, ${hex(immU)}`;
    case 0x0F: return `lui ${rt}, ${hex(immU)}`;
    case 0x10: {
      const sub = (op >>> 21) & 31;
      if (sub === 0) return `mfc0 ${rt}, cop0_${(op >>> 11) & 31}`;
      if (sub === 4) return `mtc0 ${rt}, cop0_${(op >>> 11) & 31}`;
      if (sub === 0x10 && (op & 0x3F) === 0x10) return 'rfe';
      return `cop0? ${hex(op)}`;
    }
    case 0x12: return `cop2 ${hex(op)}`;
    case 0x20: return mem('lb'); case 0x21: return mem('lh'); case 0x22: return mem('lwl'); case 0x23: return mem('lw');
    case 0x24: return mem('lbu'); case 0x25: return mem('lhu'); case 0x26: return mem('lwr');
    case 0x28: return mem('sb'); case 0x29: return mem('sh'); case 0x2A: return mem('swl'); case 0x2B: return mem('sw'); case 0x2E: return mem('swr');
    case 0x32: return mem('lwc2'); case 0x3A: return mem('swc2');
    default: return `op? ${hex(op)}`;
  }
}

/** bus から [from, to) を逆アセンブルした行の配列 */
function dump(bus, from, count, mark) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const pc = (from + i * 4) | 0;
    const w = bus.read32(pc);
    out.push(`${pc === mark ? '>' : ' '}${(pc >>> 0).toString(16)}: ${(w >>> 0).toString(16).padStart(8, '0')}  ${disasm(w, pc)}`);
  }
  return out;
}

module.exports = { disasm, dump, REG };
