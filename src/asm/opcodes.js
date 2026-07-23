/*
 * 6502 命令セット定義（合法151オペコード）
 * MML.Asm.OPCODES[mnemonic][addressingMode] = opcode byte
 * MML.Asm.MODE_SIZES[addressingMode] = 命令全体のバイト数（オペコード含む）
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Asm = MML.Asm = MML.Asm || {};

  Asm.MODE_SIZES = {
    impl: 1,
    acc: 1,
    imm: 2,
    zp: 2,
    zpx: 2,
    zpy: 2,
    indx: 2,
    indy: 2,
    rel: 2,
    abs: 3,
    absx: 3,
    absy: 3,
    ind: 3
  };

  // アキュムレータ操作可（オペランド省略時 acc になる）命令
  Asm.ACCUMULATOR_OPS = new Set(['ASL', 'LSR', 'ROL', 'ROR']);

  // 分岐命令（rel アドレッシングのみ）
  Asm.BRANCH_OPS = new Set(['BCC', 'BCS', 'BEQ', 'BMI', 'BNE', 'BPL', 'BVC', 'BVS']);

  Asm.OPCODES = {
    ADC: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6D, absx: 0x7D, absy: 0x79, indx: 0x61, indy: 0x71 },
    AND: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2D, absx: 0x3D, absy: 0x39, indx: 0x21, indy: 0x31 },
    ASL: { acc: 0x0A, zp: 0x06, zpx: 0x16, abs: 0x0E, absx: 0x1E },
    BCC: { rel: 0x90 },
    BCS: { rel: 0xB0 },
    BEQ: { rel: 0xF0 },
    BIT: { zp: 0x24, abs: 0x2C },
    BMI: { rel: 0x30 },
    BNE: { rel: 0xD0 },
    BPL: { rel: 0x10 },
    BRK: { impl: 0x00 },
    BVC: { rel: 0x50 },
    BVS: { rel: 0x70 },
    CLC: { impl: 0x18 },
    CLD: { impl: 0xD8 },
    CLI: { impl: 0x58 },
    CLV: { impl: 0xB8 },
    CMP: { imm: 0xC9, zp: 0xC5, zpx: 0xD5, abs: 0xCD, absx: 0xDD, absy: 0xD9, indx: 0xC1, indy: 0xD1 },
    CPX: { imm: 0xE0, zp: 0xE4, abs: 0xEC },
    CPY: { imm: 0xC0, zp: 0xC4, abs: 0xCC },
    DEC: { zp: 0xC6, zpx: 0xD6, abs: 0xCE, absx: 0xDE },
    DEX: { impl: 0xCA },
    DEY: { impl: 0x88 },
    EOR: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4D, absx: 0x5D, absy: 0x59, indx: 0x41, indy: 0x51 },
    INC: { zp: 0xE6, zpx: 0xF6, abs: 0xEE, absx: 0xFE },
    INX: { impl: 0xE8 },
    INY: { impl: 0xC8 },
    JMP: { abs: 0x4C, ind: 0x6C },
    JSR: { abs: 0x20 },
    LDA: { imm: 0xA9, zp: 0xA5, zpx: 0xB5, abs: 0xAD, absx: 0xBD, absy: 0xB9, indx: 0xA1, indy: 0xB1 },
    LDX: { imm: 0xA2, zp: 0xA6, zpy: 0xB6, abs: 0xAE, absy: 0xBE },
    LDY: { imm: 0xA0, zp: 0xA4, zpx: 0xB4, abs: 0xAC, absx: 0xBC },
    LSR: { acc: 0x4A, zp: 0x46, zpx: 0x56, abs: 0x4E, absx: 0x5E },
    NOP: { impl: 0xEA },
    ORA: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0D, absx: 0x1D, absy: 0x19, indx: 0x01, indy: 0x11 },
    PHA: { impl: 0x48 },
    PHP: { impl: 0x08 },
    PLA: { impl: 0x68 },
    PLP: { impl: 0x28 },
    ROL: { acc: 0x2A, zp: 0x26, zpx: 0x36, abs: 0x2E, absx: 0x3E },
    ROR: { acc: 0x6A, zp: 0x66, zpx: 0x76, abs: 0x6E, absx: 0x7E },
    RTI: { impl: 0x40 },
    RTS: { impl: 0x60 },
    SBC: { imm: 0xE9, zp: 0xE5, zpx: 0xF5, abs: 0xED, absx: 0xFD, absy: 0xF9, indx: 0xE1, indy: 0xF1 },
    SEC: { impl: 0x38 },
    SED: { impl: 0xF8 },
    SEI: { impl: 0x78 },
    STA: { zp: 0x85, zpx: 0x95, abs: 0x8D, absx: 0x9D, absy: 0x99, indx: 0x81, indy: 0x91 },
    STX: { zp: 0x86, zpy: 0x96, abs: 0x8E },
    STY: { zp: 0x84, zpx: 0x94, abs: 0x8C },
    TAX: { impl: 0xAA },
    TAY: { impl: 0xA8 },
    TSX: { impl: 0xBA },
    TXA: { impl: 0x8A },
    TXS: { impl: 0x9A },
    TYA: { impl: 0x98 }
  };
})(window);
