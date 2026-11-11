/*
 * MSX のフロッピーディスク(DESIGN-MSX-CAPTURE.md §3.5、段階 7d) — MML.Emu.MsxDiskImage / Emu.WD2793 / Emu.TC8566AF / Emu.MsxDiskInterface
 *
 * ■ ディスク画像(.dsk、ヘッダ無しの生セクタ列。セクタ 512 バイト)
 *   720K = 2 面×80 トラック×9 セクタ、360K = 1 面×80×9、640K = 2×80×8、320K = 1×80×8。並びはトラック→面→セクタ(MSX-DOS/標準 .dsk)。
 *   書き込みは画像の配列に直接入れて dirty を立てる(本体のバッテリー保存で書き戻す)。
 * ■ FDC は 2 系統(機種で違う。ディスク ROM(利用者が用意)が叩く方に合わせる。設定 ⚙「ディスク」で選ぶ)
 *   WD2793(Philips/Sony 系): $7FF8 ステータス/コマンド、$7FF9 トラック、$7FFA セクタ、$7FFB データ、$7FFC 面(bit0)、$7FFD ドライブ(bit0-1)と
 *     モータ(bit7)、$7FFF 読み: bit6=~IRQ、bit7=~DRQ(負論理。openMSX PhilipsFDC と同じ)。$BFF8-$BFFF にも鏡像。
 *     コマンド: タイプ I(RESTORE/SEEK/STEP/STEP-IN/STEP-OUT。ステップ時間 r1r0=6/12/20/30ms)、タイプ II(READ/WRITE SECTOR、m=複数)、
 *     タイプ III(READ ADDRESS、READ TRACK は未対応=すぐ終わる、WRITE TRACK=フォーマットはバイトを飲み込むだけ)、タイプ IV(FORCE INTERRUPT)。
 *     データは 1 バイトごとに DRQ(CPU が読むとすぐ次のバイト。実機の 32µs/バイトより速いが、ドライバは DRQ を見て回すので支障なし)。
 *   TC8566AF(松下/turboR。μPD765 互換): $7FF8 制御 0(bit0-1 ドライブ、bit2=1 で動作、bit3 モータ)、$7FF9 制御 1、$7FFA メインステータス(読み:
 *     RQM bit7、DIO bit6、NDM bit5、CB bit4)、$7FFB データ、$7FF9 bit0 TC(転送の打ち切り)。コマンド: SPECIFY/SENSE DRIVE STATUS/RECALIBRATE/SENSE INTERRUPT STATUS/SEEK/
 *     READ DATA/WRITE DATA/READ ID/FORMAT TRACK(非 DMA、結果 7 バイト)。無効コマンドは ST0=$80。割り込み線は MSX では使わない(ポーリング)。
 * ■ インターフェース(MsxDiskInterface): スロット 3-1 に置く。$4000-$7FFF がディスク ROM(16K。32K は前半だけ)、末尾 8 バイトが FDC のレジスタ。
 *   ドライブは A/B の 2 台(images[] から入れる。insertDisk(n) はドライブ A に n 番の画像)。
 * 時間は本体が clock(cycles) で進める(Z80 サイクル)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SECTOR = 512;
  const CPU_HZ = 3579545;
  const ms = (n) => Math.round(CPU_HZ * n / 1000);

  class MsxDiskImage {
    constructor(bytes) {
      this.img = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const n = this.img.length;
      // 面数とセクタ数を大きさから
      if (n === 737280) { this.sides = 2; this.spt = 9; } else if (n === 368640) { this.sides = 1; this.spt = 9; }
      else if (n === 655360) { this.sides = 2; this.spt = 8; } else if (n === 327680) { this.sides = 1; this.spt = 8; }
      else { this.sides = n > 368640 ? 2 : 1; this.spt = 9; } // 不明: 720K/360K として扱う
      this.tracks = Math.max(1, Math.round(n / (this.sides * this.spt * SECTOR)));
      this.dirty = false;
      this.writeProtect = false;
    }
    static isDsk(bytes) { const n = bytes.length; return n === 737280 || n === 368640 || n === 655360 || n === 327680; }
    offset(track, side, sector) { return ((track * this.sides + side) * this.spt + (sector - 1)) * SECTOR; }
    hasSector(track, side, sector) { return track >= 0 && track < this.tracks && side >= 0 && side < this.sides && sector >= 1 && sector <= this.spt; }
    readByte(track, side, sector, i) { return this.img[this.offset(track, side, sector) + i]; }
    writeByte(track, side, sector, i, v) { const o = this.offset(track, side, sector) + i; if (this.img[o] !== v) { this.img[o] = v; this.dirty = true; } }
  }

  class Drive {
    constructor() { this.image = null; this.track = 0; this.side = 0; this.motor = false; this.indexCount = 0; this.access = 0; } // access: 読み書きしたバイト数(アクセスランプ用。増えたら点ける)
    get ready() { return !!this.image; }
  }

  // ── WD2793 ──
  const STEP_MS = [6, 12, 20, 30];
  class WD2793 {
    constructor(drives) {
      this.drives = drives;
      this.drive = drives[0];
      this.reset();
    }
    reset() {
      this.status = 0; this.track = 0; this.sector = 1; this.data = 0;
      this.cmd = 0; this.busy = false; this.drq = false; this.irq = false;
      this.dirIn = true;         // ステップの向き(1=内側)
      this.wait = 0;             // コマンド完了までのサイクル
      this.phase = 0;            // 0 無し、1 タイプ I、2 読み、3 書き、4 READ ADDRESS、5 WRITE TRACK、6 READ TRACK
      this.pos = 0; this.multi = false; this.addrBuf = null;
      this.sideSel = 0;
    }
    selectDrive(n) { this.drive = this.drives[n] || null; }
    setSide(s) { this.sideSel = s & 1; if (this.drive) this.drive.side = this.sideSel; }
    // ── レジスタ ──
    readStatus() {
      this.irq = false;
      let s = this.status;
      if (this.phase === 1 || this.phase === 0) { // タイプ I の形: bit2 TRACK0、bit1 INDEX(回転で点滅)、bit5 ヘッドロード
        s &= ~0x06;
        if (this.drive && this.drive.track === 0) s |= 0x04;
        if (this.drive && this.drive.ready && ((this.drive.indexCount >> 6) & 1)) s |= 0x02;
      }
      if (!this.drive || !this.drive.ready) s |= 0x80; else s &= ~0x80;
      if (this.drive && this.drive.image && this.drive.image.writeProtect) s |= 0x40;
      return (s & ~0x03) | (this.busy ? 0x01 : 0) | (this.drq ? 0x02 : 0);
    }
    readData() {
      const v = this.data; // 今のバイトを返してから次のバイトを用意する(先に進めると 1 バイト目が飛ぶ)
      if (this.drq && (this.phase === 2 || this.phase === 4)) this._nextRead();
      return v;
    }
    writeData(v) {
      this.data = v & 0xFF;
      if (this.drq && (this.phase === 3 || this.phase === 5)) this._nextWrite(v & 0xFF);
    }
    writeCommand(v) {
      v &= 0xFF;
      const type4 = (v & 0xF0) === 0xD0;
      if (this.busy && !type4) return;
      this.irq = false;
      if (type4) { // FORCE INTERRUPT
        const was = this.busy;
        this.busy = false; this.drq = false; this.phase = 0; this.wait = 0;
        this.status &= ~0x01;
        if (v & 0x08 || !was) this.irq = true; // 即時割り込み(bit3)。待機中なら IRQ だけ
        return;
      }
      this.cmd = v;
      this.busy = true; this.drq = false; this.status = 0;
      const d = this.drive;
      if (v < 0x80) { // タイプ I
        this.phase = 1;
        const rate = ms(STEP_MS[v & 3]);
        let steps = 0;
        const op = v >> 4;
        if (op === 0) { steps = d ? d.track : 0; if (d) d.track = 0; this.track = 0; this.dirIn = true; }                 // RESTORE
        else if (op === 1) { const to = this.data; steps = d ? Math.abs(to - d.track) : 0; this.dirIn = to >= this.track; if (d) d.track = Math.max(0, Math.min(d.image ? d.image.tracks + 1 : 85, to)); this.track = to; } // SEEK(データレジスタへ)
        else {
          if (op >= 4 && op <= 5) this.dirIn = true; else if (op >= 6) this.dirIn = false;
          if (d) d.track = Math.max(0, Math.min(85, d.track + (this.dirIn ? 1 : -1)));
          if (v & 0x10) this.track = d ? d.track : this.track; // u: トラックレジスタも更新
          steps = 1;
        }
        if (v & 0x08) this.status |= 0x20; // h: ヘッドロード
        if (v & 0x04 && d && d.ready && d.track !== this.track) this.status |= 0x10; // V: 照合(トラック不一致)
        this.wait = Math.max(ms(1), steps * rate);
        return;
      }
      const op = v & 0xF0;
      if (op === 0x80 || op === 0x90 || op === 0xA0 || op === 0xB0) { // READ/WRITE SECTOR
        this.multi = !!(v & 0x10);
        const write = op >= 0xA0;
        if (!d || !d.ready) { this.busy = false; this.irq = true; this.status |= 0x80; this.phase = 0; return; }
        if (!d.image.hasSector(d.track, d.side, this.sector)) { this.status |= 0x10; this.wait = ms(2); this.phase = 7; return; } // RNF
        if (write && d.image.writeProtect) { this.status |= 0x40; this.wait = ms(1); this.phase = 7; return; }
        this.phase = write ? 3 : 2; this.pos = 0;
        this.wait = ms(1); // セクタが頭に来るまで(近似)。その後 1 バイト目の DRQ
        return;
      }
      if (op === 0xC0) { // READ ADDRESS: トラック、面、セクタ、サイズ(2=512)、CRC×2
        if (!d || !d.ready) { this.busy = false; this.irq = true; this.status |= 0x80; this.phase = 0; return; }
        this.addrBuf = [d.track, d.side, 1, 2, 0, 0]; this.pos = 0; this.phase = 4; this.wait = ms(1);
        return;
      }
      if (op === 0xE0) { this.phase = 6; this.pos = 0; this.wait = ms(1); return; }  // READ TRACK(未対応: 0 を返して終わる)
      if (op === 0xF0) { this.phase = 5; this.pos = 0; this.wait = ms(1); return; }  // WRITE TRACK(フォーマット: 飲み込むだけ)
      this.busy = false; this.phase = 0; this.irq = true;
    }
    // ── 時間 ──
    clock(cycles) {
      for (const d of this.drives) if (d.motor) d.indexCount = (d.indexCount + cycles) & 0xFFFFF;
      if (!this.busy || this.wait <= 0) return;
      this.wait -= cycles;
      if (this.wait > 0) return;
      this.wait = 0;
      switch (this.phase) {
        case 1: case 7: this.busy = false; this.phase = 0; this.irq = true; break; // タイプ I 完了 / エラー終了
        case 2: this._fetch(); this.drq = true; break;                             // 最初のバイト
        case 3: case 5: this.drq = true; break;                                    // 最初の DRQ(書き)
        case 4: this.data = this.addrBuf[0]; this.drq = true; break;
        case 6: this.data = 0; this.drq = true; break;
        default: break;
      }
    }
    _fetch() { const d = this.drive; d.access++; this.data = d.image.readByte(d.track, d.side, this.sector, this.pos); }
    _nextRead() {
      const d = this.drive;
      if (this.phase === 4) {
        this.pos++;
        if (this.pos >= 6) { this.drq = false; this.busy = false; this.phase = 0; this.irq = true; this.sector = d.track; return; } // READ ADDRESS の後はセクタレジスタにトラック
        this.data = this.addrBuf[this.pos]; return;
      }
      this.pos++;
      if (this.pos >= SECTOR) {
        this.pos = 0;
        if (this.multi && d.image.hasSector(d.track, d.side, this.sector + 1)) { this.sector++; this._fetch(); return; }
        this.drq = false; this.busy = false; this.phase = 0; this.irq = true; return;
      }
      this._fetch();
    }
    _nextWrite(v) {
      const d = this.drive;
      if (this.phase === 5) { // WRITE TRACK: 1 トラックぶん(6250 バイト)飲み込んで終わる
        if (++this.pos >= 6250) { this.drq = false; this.busy = false; this.phase = 0; this.irq = true; }
        return;
      }
      d.access++; d.image.writeByte(d.track, d.side, this.sector, this.pos, v);
      this.pos++;
      if (this.pos >= SECTOR) {
        this.pos = 0;
        if (this.multi && d.image.hasSector(d.track, d.side, this.sector + 1)) { this.sector++; return; }
        this.drq = false; this.busy = false; this.phase = 0; this.irq = true;
      }
    }
  }

  // ── TC8566AF(μPD765 互換) ──
  const CMD_LEN = { 0x03: 3, 0x04: 2, 0x07: 2, 0x08: 1, 0x0F: 3, 0x06: 9, 0x0C: 9, 0x05: 9, 0x09: 9, 0x0A: 2, 0x0D: 6, 0x11: 9, 0x19: 9, 0x1D: 9 };
  class TC8566AF {
    constructor(drives) { this.drives = drives; this.reset(); }
    reset() {
      this.drive = this.drives[0]; this.driveNo = 0;
      this.phase = 0;            // 0 コマンド待ち、1 コマンドのバイト受け、2 実行(データ)、3 結果
      this.cmd = []; this.cmdLen = 0;
      this.result = []; this.resPos = 0;
      this.st0 = 0; this.st1 = 0; this.st2 = 0; this.st3 = 0;
      this.pcn = [0, 0, 0, 0];   // ドライブごとのシリンダ
      this.seekEnd = false; this.intPending = false;
      this.dataPos = 0; this.sectorCount = 0; this.xfer = null; // 実行中の READ/WRITE の状態
      this.enabled = true;
    }
    selectDrive(n) { this.driveNo = n & 3; this.drive = this.drives[this.driveNo] || null; }
    get mainStatus() {
      let s = 0x80; // RQM
      if (this.phase === 2) s |= 0x20 | 0x10 | (this.xfer && this.xfer.write ? 0 : 0x40); // 実行中: NDM、CB、読みなら DIO=1
      else if (this.phase === 3) s |= 0x40 | 0x10;                                            // 結果: DIO=1、CB
      else if (this.phase === 1) s |= 0x10;
      return s;
    }
    readData() {
      if (this.phase === 3) {
        const v = this.result[this.resPos++] | 0;
        if (this.resPos >= this.result.length) { this.phase = 0; this.result = []; }
        return v;
      }
      if (this.phase === 2 && this.xfer && !this.xfer.write) {
        const x = this.xfer, d = this.drive;
        d.access++; const v = d.image.readByte(x.c, x.h, x.r, this.dataPos);
        this._advance();
        return v;
      }
      return 0xFF;
    }
    writeData(v) {
      v &= 0xFF;
      if (this.phase === 2 && this.xfer && this.xfer.write) {
        const x = this.xfer, d = this.drive;
        if (x.format) { if (++this.dataPos >= 4 * d.image.spt) this._finish(0x00); return; } // FORMAT: セクタごとの 4 バイト(C H R N)を飲み込む
        d.access++; d.image.writeByte(x.c, x.h, x.r, this.dataPos, v);
        this._advance();
        return;
      }
      if (this.phase === 0) {
        this.cmd = [v]; this.cmdLen = CMD_LEN[v & 0x1F] || 1;
        if (this.cmdLen === 1) this._execute(); else this.phase = 1;
        return;
      }
      if (this.phase === 1) {
        this.cmd.push(v);
        if (this.cmd.length >= this.cmdLen) this._execute();
      }
    }
    _advance() {
      const x = this.xfer;
      x.justAdvanced = false;
      if (++this.dataPos < SECTOR) return;
      this.dataPos = 0;
      if (x.r >= x.eot) { this._finish(0x00); return; } // EOT まで転送した: 正常終了(ST1 の EN は立てない。ドライバは結果の R を見る)
      x.r++; x.justAdvanced = true;
      if (!this.drive.image.hasSector(x.c, x.h, x.r)) { this._finish(0x40, 0x80); return; } // 無い: EN
    }
    // TC(Terminal Count): 実行中なら転送を打ち切って結果へ。セクタ境界で来たら結果の R は次のセクタ(もう進めてある)
    terminalCount() {
      if (this.phase !== 2 || !this.xfer) return;
      this.dataPos = 0;
      this._finish(0x00, 0x00);
    }
    _finish(st0, st1) {
      const x = this.xfer, d = this.drive;
      this.st0 = (st0 | this.driveNo | (x.h << 2)) & 0xFF; this.st1 = st1 || 0; this.st2 = 0;
      let c = x.c, h = x.h, r = x.r;
      if (!x.format && !(x.justAdvanced && this.dataPos === 0)) { r++; if (r > d.image.spt) { r = 1; c++; } }
      this.result = [this.st0, this.st1, this.st2, c, h, r, 2];
      this.resPos = 0; this.phase = 3; this.xfer = null;
    }
    _execute() {
      const c = this.cmd, op = c[0] & 0x1F, d = this.drive;
      switch (op) {
        case 0x03: this.phase = 0; break;                                     // SPECIFY
        case 0x04: { // SENSE DRIVE STATUS → ST3
          const n = c[1] & 3; const dr = this.drives[n];
          this.st3 = n | ((c[1] >> 2) & 1) << 2 | (dr && dr.image ? 0x20 : 0) | (dr && dr.track === 0 ? 0x10 : 0) | (dr && dr.image && dr.image.sides === 2 ? 0x08 : 0) | (dr && dr.image && dr.image.writeProtect ? 0x40 : 0);
          this.result = [this.st3]; this.resPos = 0; this.phase = 3; break;
        }
        case 0x07: { // RECALIBRATE
          this.selectDrive(c[1] & 3);
          if (this.drive) this.drive.track = 0; this.pcn[this.driveNo] = 0;
          this.st0 = 0x20 | this.driveNo; this.seekEnd = true; this.phase = 0; break;
        }
        case 0x0F: { // SEEK
          this.selectDrive(c[1] & 3);
          const to = c[2];
          if (this.drive) this.drive.track = Math.max(0, Math.min(85, to)); this.pcn[this.driveNo] = to;
          this.st0 = 0x20 | this.driveNo; this.seekEnd = true; this.phase = 0; break;
        }
        case 0x08: { // SENSE INTERRUPT STATUS → ST0, PCN(待っている割り込みが無ければ ST0=$80)
          if (this.seekEnd) { this.seekEnd = false; this.result = [this.st0, this.pcn[this.driveNo]]; }
          else this.result = [0x80];
          this.resPos = 0; this.phase = 3; break;
        }
        case 0x06: case 0x0C: case 0x05: case 0x09: { // READ DATA / READ DELETED / WRITE DATA / WRITE DELETED
          this.selectDrive(c[1] & 3);
          const h = (c[1] >> 2) & 1;
          if (!d || !d.image) { this.xfer = { c: c[2], h, r: c[4], eot: c[6], write: false }; this._finish(0x40, 0x00); this.st0 |= 0x08; this.result[0] = this.st0; break; } // NR
          d.side = h;
          const x = { c: c[2], h, r: c[4], eot: c[6], write: op === 0x05 || op === 0x09 };
          if (!d.image.hasSector(x.c, x.h, x.r)) { this.xfer = x; this._finish(0x40, 0x04); break; } // ND
          if (x.write && d.image.writeProtect) { this.xfer = x; this._finish(0x40, 0x02); break; }  // NW
          this.xfer = x; this.dataPos = 0; this.phase = 2;
          d.track = x.c;
          break;
        }
        case 0x0A: { // READ ID → ST0 ST1 ST2 C H R N
          this.selectDrive(c[1] & 3);
          const h = (c[1] >> 2) & 1;
          if (!d || !d.image) { this.result = [0x48 | this.driveNo, 0, 0, 0, h, 1, 2]; }
          else this.result = [this.driveNo | (h << 2), 0, 0, d.track, h, 1, 2];
          this.resPos = 0; this.phase = 3; break;
        }
        case 0x0D: { // FORMAT TRACK: N SC GPL D のあとセクタごとの 4 バイト(飲み込む)
          this.selectDrive(c[1] & 3);
          const h = (c[1] >> 2) & 1;
          if (!d || !d.image || d.image.writeProtect) { this.xfer = { c: d ? d.track : 0, h, r: 1, eot: 1, write: true, format: true }; this._finish(0x40, 0x02); break; }
          this.xfer = { c: d.track, h, r: 1, eot: 1, write: true, format: true }; this.dataPos = 0; this.phase = 2; break;
        }
        default: this.result = [0x80]; this.resPos = 0; this.phase = 3; break; // 無効
      }
    }
    clock() {}
  }

  // ── スロットに挿すディスクインターフェース ──
  class MsxDiskInterface {
    /** @param {Uint8Array} rom ディスク ROM(16K) @param {'wd2793'|'tc8566af'} kind @param {MsxDiskImage[]} images */
    constructor(rom, kind, images) {
      this.rom = rom || new Uint8Array(0x4000).fill(0xFF);
      this.kind = kind === 'tc8566af' ? 'tc8566af' : 'wd2793';
      this.images = images || [];
      this.drives = [new Drive(), new Drive()];
      this.fdc = this.kind === 'tc8566af' ? new TC8566AF(this.drives) : new WD2793(this.drives);
      this.ctrl = 0;
      if (this.images.length) this.drives[0].image = this.images[0];
      this.inserted = this.images.length ? 0 : -1;
    }
    reset() { this.fdc.reset(); this.ctrl = 0; for (const d of this.drives) { d.track = 0; d.side = 0; d.motor = false; } }
    get diskCount() { return this.images.length; }
    get dirty() { return this.images.some((i) => i.dirty); }
    clearDirty() { for (const i of this.images) i.dirty = false; }
    // アクセスランプ: ドライブごとの { access(読み書きしたバイト数), media(入っているか) }。ドライブは A/B の 2 台
    diskActivity() { return this.drives.map((d) => ({ access: d.access, media: !!d.image })); }
    insertDisk(n) { if (!this.images.length) return; n = ((n % this.images.length) + this.images.length) % this.images.length; this.drives[0].image = this.images[n]; this.inserted = n; }
    ejectDisk() { this.drives[0].image = null; this.inserted = -1; }
    addImage(img) { this.images.push(img); return this.images.length - 1; }
    clock(cycles) { this.fdc.clock(cycles); }
    read(a) {
      if (a >= 0x7FF8 && a <= 0x7FFF || (a >= 0xBFF8 && a <= 0xBFFF)) return this._readReg(a & 7);
      if (a >= 0x4000 && a < 0x8000) { const o = a - 0x4000; return o < this.rom.length ? this.rom[o] : 0xFF; }
      return 0xFF;
    }
    write(a, v) {
      if (a >= 0x7FF8 && a <= 0x7FFF || (a >= 0xBFF8 && a <= 0xBFFF)) this._writeReg(a & 7, v & 0xFF);
    }
    _readReg(r) {
      const f = this.fdc;
      if (this.kind === 'wd2793') {
        switch (r) {
          case 0: return f.readStatus();
          case 1: return f.track;
          case 2: return f.sector;
          case 3: return f.readData();
          case 4: return 0xFE | f.sideSel;
          case 5: return this.ctrl;
          case 7: return (0xC0 & ~(f.irq ? 0x40 : 0) & ~(f.drq ? 0x80 : 0)) | 0x3F; // bit6=~IRQ、bit7=~DRQ、他は 1
          default: return 0xFF;
        }
      }
      switch (r) {
        case 2: return f.mainStatus;
        case 3: return f.readData();
        default: return 0xFF;
      }
    }
    _writeReg(r, v) {
      const f = this.fdc;
      if (this.kind === 'wd2793') {
        switch (r) {
          case 0: f.writeCommand(v); return;
          case 1: f.track = v; return;
          case 2: f.sector = v; return;
          case 3: f.writeData(v); return;
          case 4: f.setSide(v & 1); return;
          case 5: { // bit0-1 ドライブ(2/3 は無し)、bit7 モータ
            this.ctrl = v;
            const n = v & 3;
            f.selectDrive(n < 2 ? n : 0);
            for (let i = 0; i < 2; i++) this.drives[i].motor = !!(v & 0x80) && n === i;
            if (f.drive) f.drive.side = f.sideSel;
            return;
          }
          default: return;
        }
      }
      switch (r) {
        case 0: { // 制御 0: bit0-1 ドライブ、bit2 有効(0 でリセット)、bit3 モータ
          this.ctrl = v;
          if (!(v & 0x04)) f.reset();
          f.selectDrive(v & 3);
          for (let i = 0; i < 2; i++) this.drives[i].motor = !!(v & 0x08) && (v & 3) === i;
          return;
        }
        case 1: if (v & 0x01) f.terminalCount(); return; // 制御 1: bit0 TC(転送の打ち切り。実機のディスク ROM は 1 セクタ読むごとに 2→3→2 と打つ)
        case 3: f.writeData(v); return;
        default: return;
      }
    }
  }

  Emu.MsxDiskImage = MsxDiskImage;
  Emu.WD2793 = WD2793;
  Emu.TC8566AF = TC8566AF;
  Emu.MsxDiskInterface = MsxDiskInterface;
})(typeof window !== 'undefined' ? window : globalThis);
