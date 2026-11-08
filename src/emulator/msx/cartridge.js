/*
 * MSX カートリッジ(ROM とメガ ROM マッパー) — 自前 MSX エミュレータ(DESIGN-MSX-CAPTURE.md §3.3、段階 7a/7b)
 * MML.Emu.MsxCartridge
 *
 * .rom にはヘッダが無いので、種別は (1) 呼び手の指定(手動上書き/辞書)→ (2) guessType() の発見的手法で決める。
 * guessType は openMSX の RomInfo::guessRomType と同じ考え方: ROM 全体を走査して「LD (nn),A」(0x32 lo hi)の
 * 書き込み先がどのバンク切替アドレスかを数え、種別ごとに採点する(ここでは要点だけ移植した近似。ASCII8 と
 * Konami の取り違えが定番なので、外れたら画面の ⚙ で手動指定する前提)。
 *
 * 種別(8K ページ単位の参照張り替え。kssBus.js と同じく mem へコピーしない):
 *   plain      : 64K 以下の素の ROM。'AB' ヘッダの INIT 番地で置き場所(0x4000 か 0x8000)を決め、8K/16K は 64K 空間に鏡像
 *   konami     : Konami(SCC 無し)。8K バンク。0x4000 固定(バンク 0)、レジスタ 0x6000/0x8000/0xA000 → 0x6000/0x8000/0xA000
 *   konamiScc  : Konami SCC。8K バンク。レジスタ 0x5000/0x7000/0x9000/0xB000 → 0x4000/0x6000/0x8000/0xA000。
 *                0x9000 のバンクが 0x3F のとき 0x9800-0x9FFF に SCC(sccAudio.js、classic 配置)
 *   konamiSccI : Konami SCC-I(サウンドカートリッジ。7b): 128K RAM を 8K×16 バンクで konamiScc と同じレジスタで切り替える。
 *                モードレジスタ 0xBFFE/0xBFFF: bit5=SCC+ 配置(0xB800-0xBFFF、0xB000 のバンク値 bit7 で窓が開く)、
 *                bit4=全バンク RAM 書き込み可、bit0-2=窓 0x4000/0x6000/0x8000 の RAM 書き込み可(書き込み可の窓では
 *                バンクレジスタも SCC も書けず RAM に入る。openMSX SCCPlusCart と同じ)。rom を渡すと RAM の初期内容になる
 *   konamiDac  : 牌の魔術師: konami マッパー+0x5000-0x5FFF に 8bit D/A(expansion/majutsushiDac.js。本体が opts.dac で渡す)。
 *                発見的判定では konami に見えるので手動指定(辞書)で選ぶ
 *   ascii8     : ASCII 8K。レジスタ 0x6000/0x6800/0x7000/0x7800 → 0x4000/0x6000/0x8000/0xA000
 *   ascii16    : ASCII 16K。レジスタ 0x6000/0x7000 → 0x4000/0x8000(16K バンク)
 *   SRAM 付き(ASCII8/16 SRAM、Game Master 2、Koei)、R-Type、Cross Blaim は 7c。
 *
 * 音源の書き込みは onWrite(kind, addr, value) で本体へ知らせる(kind 'scc' はメモリ番地、'dac' は 0x5000 台の番地)。
 * 読み出し: read(addr) は 0x0000-0xFFFF のどこでも呼ばれうる(スロットに挿さった状態)。ROM の無い所は 0xFF。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const PAGE = 0x2000;
  const EMPTY = new Uint8Array(PAGE).fill(0xFF);
  const SCCI_RAM = 0x20000; // SCC-I の RAM(128K)

  // SRAM 付き(7c): ascii8Sram(ASCII8+SRAM 8K。バンク値の「ROM のバンク数の次のビット」が立つと SRAM。openMSX RomAscii8_8)、
  //   ascii16Sram(ASCII16+SRAM 2K 鏡像。バンク値 bit4。RomAscii16_2)、gameMaster2(Konami+SRAM 8K。バンク値 bit4 で SRAM、bit5 で 4K の半分、
  //   書けるのは 0xB000 台だけ)、koei(ASCII8+SRAM 8K〜32K。バンク値 bit7 で SRAM)。SRAM へ書くと sramDirty(本体のバッテリー保存)
  const TYPES = ['plain', 'konami', 'konamiScc', 'konamiSccI', 'konamiDac', 'ascii8', 'ascii16', 'ascii8Sram', 'ascii16Sram', 'gameMaster2', 'koei'];
  const SRAM_SIZE = { ascii8Sram: 0x2000, ascii16Sram: 0x800, gameMaster2: 0x2000, koei: 0x8000 };

  // 'AB' ヘッダ(0x4000 境界ごと)の位置を返す(-1 なら無し)
  function findHeader(rom) {
    for (let off = 0; off + 16 <= rom.length && off < 0x10000; off += 0x4000) {
      if (rom[off] === 0x41 && rom[off + 1] === 0x42) return off;
    }
    return -1;
  }

  // 発見的な種別判定(openMSX RomInfo::guessRomType の近似)。64K 以下は plain
  function guessType(rom) {
    if (rom.length <= 0x10000) return 'plain';
    const score = { konami: 0, konamiScc: 0, ascii8: 0, ascii16: 0 };
    for (let i = 0; i + 2 < rom.length; i++) {
      if (rom[i] !== 0x32) continue; // LD (nn),A
      const a = rom[i + 1] | (rom[i + 2] << 8);
      switch (a) {
        case 0x5000: case 0x9000: case 0xB000: score.konamiScc++; break;
        case 0x4000: case 0x8000: case 0xA000: score.konami++; break;
        case 0x6800: case 0x7800: score.ascii8++; break;
        case 0x6000: score.konami++; score.ascii8++; score.ascii16++; break;
        case 0x7000: score.konamiScc++; score.ascii8++; score.ascii16++; break;
        case 0x77FF: score.ascii16++; break;
        default: break;
      }
    }
    if (score.ascii8) score.ascii8--; // ASCII8 は他より出やすい(openMSX と同じ補正)
    let best = 'konamiScc', bestN = -1;
    for (const t of ['konamiScc', 'konami', 'ascii8', 'ascii16']) { // 同点はこの順(Konami が多数派)
      if (score[t] > bestN) { best = t; bestN = score[t]; }
    }
    return best;
  }

  class MsxCartridge {
    /**
     * @param {Uint8Array|null} rom  ROM(konamiSccI は無くてよい: 空の RAM で始まる)
     * @param {object} [opts] { type: 種別(省略で推定), scc: SCCAudio(konamiScc/konamiSccI のとき音源を挿す), dac: MajutsushiDAC(konamiDac) }
     */
    constructor(rom, opts) {
      opts = opts || {};
      this.rom = rom ? (rom instanceof Uint8Array ? rom : new Uint8Array(rom)) : new Uint8Array(0);
      const given = opts.type && TYPES.includes(opts.type);
      this.type = given ? opts.type : (this.rom.length ? guessType(this.rom) : 'konamiSccI');
      this.guessed = !given;
      this.scc = opts.scc || null;
      this.dac = opts.dac || null;
      this.onWrite = null; // (kind, addr, value) 音源(SCC/DAC)の書き込み。本体が録音/ライブ表示に使う
      // 8K ページ参照(0x0000-0xFFFF の 8 ページ)。バンク ROM は bankSize 単位の配列
      this.pages = new Array(8).fill(EMPTY);
      this.bankSize = (this.type === 'ascii16' || this.type === 'ascii16Sram') ? 0x4000 : PAGE;
      this.banks = [];
      if (this.type === 'konamiSccI') {
        // RAM 128K を 8K×16 のバンクに割る(ram は 1 本。banks はその部分参照)
        this.ram = new Uint8Array(SCCI_RAM);
        if (this.rom.length) this.ram.set(this.rom.subarray(0, Math.min(this.rom.length, SCCI_RAM)));
        for (let i = 0; i < SCCI_RAM / PAGE; i++) this.banks.push(this.ram.subarray(i * PAGE, (i + 1) * PAGE));
        this.bankMask = 0x0F;
      } else {
        this.ram = null;
        const n = Math.max(1, Math.ceil(this.rom.length / this.bankSize));
        for (let i = 0; i < n; i++) {
          const b = new Uint8Array(this.bankSize).fill(0xFF);
          b.set(this.rom.subarray(i * this.bankSize, Math.min(this.rom.length, (i + 1) * this.bankSize)));
          this.banks.push(b);
        }
        this.bankMask = n <= 1 ? 0 : (1 << Math.ceil(Math.log2(n))) - 1;
      }
      this.bankSel = new Uint8Array(4); // 4 つのバンク窓(0x4000/0x6000/0x8000/0xA000、ascii16 は 0x4000/0x8000 の 2 つ)
      // SRAM(7c): 窓ごとに「SRAM が見えている」印(sramSel)。sramBank は SRAM 内のバンク(gameMaster2 の半分、koei の 8K 単位)
      this.sram = SRAM_SIZE[this.type] ? new Uint8Array(SRAM_SIZE[this.type]) : null;
      this.sramSel = new Uint8Array(4); this.sramBank = new Uint8Array(4);
      this.sramDirty = false;
      this.sramEnableBit = this.type === 'ascii8Sram' ? Math.max(0x20, 1 << Math.ceil(Math.log2(Math.max(2, this.banks.length)))) : this.type === 'ascii16Sram' ? 0x10 : this.type === 'gameMaster2' ? 0x10 : this.type === 'koei' ? 0x80 : 0;
      this.sccEnabled = false;   // classic SCC の窓(0x9800)が開いている
      this.sccPlusEnabled = false; // SCC+ の窓(0xB800)が開いている(konamiSccI、0xB000 の bit7)
      this.mode = 0;             // konamiSccI のモードレジスタ(0xBFFE)
      this.reset();
    }

    get header() { return findHeader(this.rom); }
    get title() {
      if (this.type === 'konamiSccI') return `SCC-I ${this.rom.length ? ((this.rom.length / 1024) | 0) + 'K+' : ''}RAM 128K`;
      return `${this.type}${this.guessed ? '(推定)' : ''} ${(this.rom.length / 1024) | 0}K`;
    }
    get isKonamiLike() { return this.type === 'konami' || this.type === 'konamiScc' || this.type === 'konamiSccI' || this.type === 'konamiDac' || this.type === 'gameMaster2'; }
    get isAscii16() { return this.type === 'ascii16' || this.type === 'ascii16Sram'; }
    get hasSram() { return !!this.sram; }

    reset() {
      this.sccEnabled = false; this.sccPlusEnabled = false; this.mode = 0;
      this.sramSel.fill(0); this.sramBank.fill(0);
      if (this.scc) this.scc.reset();
      if (this.dac) this.dac.reset();
      if (this.type === 'plain') { this._mapPlain(); return; }
      for (let i = 0; i < 4; i++) this.bankSel[i] = this.isKonamiLike ? i : 0;
      this._remap();
    }

    // 素の ROM: 'AB' の位置と INIT 番地で置き場所を決める
    _mapPlain() {
      const rom = this.rom, size = rom.length;
      const hdr = findHeader(rom);
      let base;
      if (size <= 0x4000) {
        // 8K/16K: INIT が 0x8000 以上なら 0x8000 に、それ以外は 0x4000 に(64K 空間へ鏡像)
        const init = hdr >= 0 ? (rom[hdr + 2] | (rom[hdr + 3] << 8)) : 0x4000;
        base = init >= 0x8000 ? 0x8000 : 0x4000;
        // 8K は 8K ページそのまま、16K は 2 ページ。鏡像は 0x0000-0xFFFF 全体(置き場所は読み手に見えない)
        const img = new Uint8Array(size <= PAGE ? PAGE : 0x4000).fill(0xFF); img.set(rom);
        void base;
        for (let p = 0; p < 8; p++) this.pages[p] = img.length === PAGE ? img : img.subarray(((p & 1) * PAGE), ((p & 1) + 1) * PAGE);
        return;
      }
      if (size <= 0x8000) {
        // 32K: 'AB' が先頭なら 0x4000-0xBFFF、'AB' が 0x4000 にあるなら 0x0000-0x7FFF(前半がデータ)
        base = hdr === 0x4000 ? 0x0000 : 0x4000;
      } else if (size <= 0xC000) {
        base = hdr === 0x4000 ? 0x0000 : 0x4000; // 48K: 0x0000-0xBFFF か 0x4000-0xFFFF
      } else base = 0x0000; // 64K
      const img = new Uint8Array(0x10000).fill(0xFF);
      img.set(rom.subarray(0, Math.min(size, 0x10000 - base)), base);
      for (let p = 0; p < 8; p++) this.pages[p] = img.subarray(p * PAGE, (p + 1) * PAGE);
    }

    _remap() {
      const pg = this.pages;
      pg[0] = EMPTY; pg[1] = EMPTY; pg[6] = EMPTY; pg[7] = EMPTY;
      if (this.isAscii16) {
        for (let w = 0; w < 2; w++) {
          if (this.sramSel[w]) { const s = this._sramView(w, 0x4000); pg[2 + w * 2] = s.subarray(0, PAGE); pg[3 + w * 2] = s.subarray(PAGE, 2 * PAGE); continue; }
          const b = this.banks[this.bankSel[w] & this.bankMask] || EMPTY16();
          pg[2 + w * 2] = b.subarray(0, PAGE); pg[3 + w * 2] = b.subarray(PAGE, 2 * PAGE);
        }
        return;
      }
      for (let w = 0; w < 4; w++) pg[2 + w] = this.sramSel[w] ? this._sramView(w, PAGE) : (this.banks[this.bankSel[w] & this.bankMask] || EMPTY);
    }
    // 窓 w に見せる SRAM(size バイト)。小さい SRAM は鏡像にした像を作る(読みは pages 経由、書きは write() が sram へ直接)
    _sramView(w, size) {
      const s = this.sram;
      if (this.type === 'ascii16Sram') { // 2K を 16K に鏡像
        const v = this._sramMirror || (this._sramMirror = new Uint8Array(0x4000));
        for (let i = 0; i < 0x4000; i += s.length) v.set(s, i);
        return v;
      }
      if (this.type === 'gameMaster2') { // 4K の半分を 8K に鏡像
        const v = this._sramMirror || (this._sramMirror = new Uint8Array(PAGE));
        const half = s.subarray(this.sramBank[w] * 0x1000, this.sramBank[w] * 0x1000 + 0x1000);
        v.set(half, 0); v.set(half, 0x1000);
        return v;
      }
      const off = (this.sramBank[w] * size) % s.length;
      return s.subarray(off, off + size);
    }
    // SRAM の読みの像(鏡像の複製)は書き込みで古くなるので、書いたら張り直す
    _sramWrite(w, addr, v) {
      const s = this.sram;
      let off;
      if (this.type === 'ascii16Sram') off = addr & 0x7FF;
      else if (this.type === 'gameMaster2') off = this.sramBank[w] * 0x1000 + (addr & 0xFFF);
      else off = ((this.sramBank[w] * PAGE) + (addr & 0x1FFF)) % s.length;
      if (s[off] === v) return;
      s[off] = v; this.sramDirty = true;
      if (this._sramMirror) this._remap();
    }

    read(addr) { return this.pages[addr >>> 13][addr & 0x1FFF]; }

    // konamiSccI: 窓 w(0-3)が RAM として書けるか(モードレジスタ bit4=全部、bit0-2=窓 0-2)
    _ramWritable(w) { return !!(this.mode & 0x10) || (w < 3 && !!((this.mode >> w) & 1)); }

    write(addr, v) {
      switch (this.type) {
        case 'plain': return;
        case 'konami':
        case 'konamiDac':
          if (this.type === 'konamiDac' && addr >= 0x5000 && addr <= 0x5FFF) {
            if (this.dac) this.dac.write(v);
            if (this.onWrite) this.onWrite('dac', addr, v);
            return;
          }
          if (addr === 0x6000) this.bankSel[1] = v; else if (addr === 0x8000) this.bankSel[2] = v; else if (addr === 0xA000) this.bankSel[3] = v; else return;
          this._remap(); return;
        case 'konamiScc':
          if (this.sccEnabled && addr >= 0x9800 && addr <= 0x9FFF) {
            if (this.scc) this.scc.writeClassic(addr & 0xFF, v);
            if (this.onWrite) this.onWrite('scc', addr, v);
            return;
          }
          if ((addr & 0xF800) === 0x5000) this.bankSel[0] = v;
          else if ((addr & 0xF800) === 0x7000) this.bankSel[1] = v;
          else if ((addr & 0xF800) === 0x9000) { this.bankSel[2] = v; this.sccEnabled = (v & 0x3F) === 0x3F; }
          else if ((addr & 0xF800) === 0xB000) this.bankSel[3] = v;
          else return;
          this._remap(); return;
        case 'konamiSccI': {
          if (addr < 0x4000 || addr >= 0xC000) return;
          if ((addr & 0xFFFE) === 0xBFFE) { // モードレジスタ(RAM 書き込み可の窓でも効く)
            this.mode = v;
            if (this.onWrite) this.onWrite('scc', addr, v); // SCC+ 配置の切替は録音/ロールの読み手(kss2mml の SCC デコーダ)も要る
            return;
          }
          const w = (addr - 0x4000) >> 13;
          if (this._ramWritable(w)) { this.banks[this.bankSel[w] & this.bankMask][addr & 0x1FFF] = v; return; }
          const plus = !!(this.mode & 0x20);
          if (plus && this.sccPlusEnabled && addr >= 0xB800) {
            if (this.scc) this.scc.writePlus(addr & 0xFF, v);
            if (this.onWrite) this.onWrite('scc', addr, v);
            return;
          }
          if (!plus && this.sccEnabled && addr >= 0x9800 && addr <= 0x9FFF) {
            if (this.scc) this.scc.writeClassic(addr & 0xFF, v);
            if (this.onWrite) this.onWrite('scc', addr, v);
            return;
          }
          if ((addr & 0x1800) !== 0x1000) return; // バンクレジスタは各窓の +0x1000-0x17FF(0x5000/0x7000/0x9000/0xB000)
          this.bankSel[w] = v;
          if (w === 2) this.sccEnabled = (v & 0x3F) === 0x3F;
          if (w === 3) { this.sccPlusEnabled = !!(v & 0x80); if (this.onWrite) this.onWrite('scc', addr, v); } // 窓の開閉も読み手が要る
          this._remap(); return;
        }
        case 'ascii8':
          if (addr >= 0x6000 && addr < 0x8000) { this.bankSel[(addr - 0x6000) >> 11] = v; this._remap(); }
          return;
        case 'ascii16':
          if (addr >= 0x6000 && addr < 0x6800) { this.bankSel[0] = v; this._remap(); }
          else if (addr >= 0x7000 && addr < 0x7800) { this.bankSel[1] = v; this._remap(); }
          return;
        case 'ascii8Sram': case 'koei': {
          // SRAM が見えている 0x8000-0xBFFF への書き込みは SRAM へ。バンクレジスタは 0x6000-0x7FFF
          if (addr >= 0x8000 && addr < 0xC000) { const w = (addr - 0x4000) >> 13; if (this.sramSel[w]) this._sramWrite(w, addr, v); return; }
          if (addr >= 0x6000 && addr < 0x8000) {
            const w = (addr - 0x6000) >> 11;
            if (v & this.sramEnableBit) { this.sramSel[w] = 1; this.sramBank[w] = v & ((this.sram.length >> 13) - 1); }
            else { this.sramSel[w] = 0; this.bankSel[w] = v; }
            this._remap();
          }
          return;
        }
        case 'ascii16Sram': {
          if (addr >= 0x8000 && addr < 0xC000) { if (this.sramSel[1]) this._sramWrite(1, addr, v); return; }
          let w = -1;
          if (addr >= 0x6000 && addr < 0x6800) w = 0; else if (addr >= 0x7000 && addr < 0x7800) w = 1;
          if (w < 0) return;
          if (v & this.sramEnableBit) this.sramSel[w] = 1; else { this.sramSel[w] = 0; this.bankSel[w] = v; }
          this._remap(); return;
        }
        case 'gameMaster2': {
          // SRAM への書き込みは 0xB000-0xBFFF(窓 3 に SRAM が見えているとき)。バンクレジスタは 0x6000/0x8000/0xA000(各窓の先頭 4K: 0x6000-0x6FFF 等)
          if (addr >= 0xB000 && addr < 0xC000) { if (this.sramSel[3]) this._sramWrite(3, addr, v); return; }
          if (addr >= 0x6000 && addr < 0xC000 && !(addr & 0x1000)) {
            const w = (addr - 0x4000) >> 13;
            if (v & 0x10) { this.sramSel[w] = 1; this.sramBank[w] = (v >> 5) & 1; }
            else { this.sramSel[w] = 0; this.bankSel[w] = v & 0x0F; }
            this._remap();
          }
          return;
        }
        default: return;
      }
    }
    // SCC の読み出し(窓が開いているとき)。本体が read の前に見る。-1 なら SCC ではない
    readScc(addr) {
      if (!this.scc) return -1;
      if (this.type === 'konamiScc') return (this.sccEnabled && addr >= 0x9800 && addr <= 0x9FFF) ? this.scc.readClassic(addr & 0xFF) : -1;
      if (this.type === 'konamiSccI') {
        const plus = !!(this.mode & 0x20);
        if (plus && this.sccPlusEnabled && addr >= 0xB800 && addr <= 0xBFFF) return this.scc.readPlus(addr & 0xFF);
        if (!plus && this.sccEnabled && addr >= 0x9800 && addr <= 0x9FFF) return this.scc.readClassic(addr & 0xFF);
      }
      return -1;
    }
    get hasScc() { return (this.type === 'konamiScc' || this.type === 'konamiSccI') && !!this.scc; }
    // バッテリーバックアップ(SRAM)の出し入れ(本体の getBattery/setBattery)
    getSram() { return this.sram ? this.sram.slice() : null; }
    setSram(bytes) { if (!this.sram || !bytes) return false; this.sram.set(bytes.subarray(0, Math.min(bytes.length, this.sram.length))); this.sramDirty = false; if (this._sramMirror) this._remap(); return true; }
    get hasDac() { return this.type === 'konamiDac' && !!this.dac; }
    get sccPlusMode() { return this.type === 'konamiSccI' && !!(this.mode & 0x20); }
  }
  const EMPTY16_BUF = new Uint8Array(0x4000).fill(0xFF);
  function EMPTY16() { return EMPTY16_BUF; }

  MsxCartridge.TYPES = TYPES;
  MsxCartridge.guessType = guessType;
  MsxCartridge.findHeader = findHeader;
  Emu.MsxCartridge = MsxCartridge;
})(typeof window !== 'undefined' ? window : globalThis);
