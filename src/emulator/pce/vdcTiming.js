/*
 * HuC6270(VDC)の「時間の骨組み」だけ: 横と縦の状態機械、垂直帰線と走査線の割り込み、ステータス
 * MML.Emu.PceVdcTiming
 *
 * 絵(VRAM、BG、スプライト)は持たない。HES の再生に要るのは「割り込みがいつ来るか」だけなので、まずここだけ作った(段階 9a)。
 * 本体の VDC(段階 9c)はこの上に絵を足す。
 *
 * VDC は自分の中で 横 = 同期(HSW)→ 表示開始待ち(HDS)→ 表示(HDW)→ 表示終了(HDE) を回し、
 * 縦 = 同期(VSW)→ 表示開始待ち(VDS)→ 表示(VDW)→ 表示終了(VCR) を 1 行に 1 回進める。VCE(色の石)が 1365 マスタークロックごとに
 * 水平同期を、画面の終わりの 3 行で垂直同期を掛けて、VDC の周回を強制的に頭へ戻す。
 * 横のレジスタが短いと 1 行の中で横の周回が 2 周し、縦のカウンタが 1 行に 2 回進む(電源投入時の値がこれ。HES は横のレジスタを
 * 設定しない曲が多いので、垂直帰線が画面の半分の位置で来る)。
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3): このファイルの時間の決まりは全部 [参照] Mesen 2 の Core/PCE/PceVdc.cpp
 * (Exec / ProcessVdcEvents / ProcessEvent / SetHorizontalMode / ProcessHorizontalSyncStart / SetVertMode / ClockVCounter /
 *  IncrementRcrCounter / ProcessEndOfScanline / TriggerVerticalBlank)と PceVce.cpp。読んで動きを合わせた(写していない)。
 * Mesen 自身が「概算」「要検証」とコメントしている所は下に ★ で写してある。
 * 確かめ方: tools/headless/pce-iotrace.js(HES の I/O を時刻つきで Mesen と並べる。VDC ステータスの読み=垂直帰線の時刻が合うか)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const LINE_CLOCKS = 1365;
  const H_DS = 0, H_DW = 1, H_DE = 2, H_SW = 3;
  const V_DS = 0, V_DW = 1, V_DE = 2, V_SW = 3;
  const EV_NONE = 0, EV_LATCH_Y = 1, EV_LATCH_X = 2, EV_HDS_IRQ = 3, EV_INC_RCR = 4;
  const NEVER = 0xFFFF;
  const ST_VBLANK = 0x20, ST_RCR = 0x04;

  class PceVdcTiming {
    constructor() { this.reset(); }

    reset() {
      // VCE 側の設定
      this.divider = 4;        // ドットクロック: 4 = 5.37MHz、3 = 7.16MHz、2 = 10.74MHz
      this.lines = 262;        // 1 画面の行数(VCE の bit2 で 263)
      // レジスタ(書かれた値)と、同期の頭で取り込んだ値。電源投入時は表示幅 32 桁・240 行、ほかは 0
      this.reg = { hsw: 0, hds: 0, hdw: 0x1F, hde: 0, vsw: 0, vds: 0, vdw: 239, vcr: 0 };
      this.lat = { hsw: 0, hds: 0, hdw: 0x1F, hde: 0, vsw: 0, vds: 0, vdw: 239, vcr: 0 };
      this.currentReg = 0;
      this.enableVblankIrq = false;  // R05 bit3
      this.enableRcrIrq = false;     // R05 bit2
      this.rcrReg = 0;               // R06(10bit)
      // 状態
      this.hClock = 0; this.scanline = 0;
      this.hMode = H_DS; this.hCounter = 0;
      this.vMode = V_DS; this.vCounter = 0;
      this.rcr = 0;
      this.event = EV_NONE; this.eventCounter = 0;
      this.needRcrInc = false; this.needVClock = false;
      this.needVblank = false; this.vblankDone = false;
      this.status = 0;         // 読むと消える印(bit5 垂直帰線、bit2 走査線)
      this.irq = false;        // IRQ1 の線
      this.frameCount = 0;
    }

    _dots(n) { return n * this.divider; }

    /** マスタークロック 3 個ぶん進める */
    exec() {
      if (this.hCounter <= 3 || this.eventCounter <= 3) {
        for (let i = 0; i < 3; i++) {
          this.hClock++;
          if (--this.hCounter === 0) this._setHMode((this.hMode + 1) & 3);
          if (this.eventCounter && --this.eventCounter === 0) this._event();
        }
      } else {
        this.hCounter -= 3;
        if (this.eventCounter > 0) this.eventCounter -= 3;
        this.hClock += 3;
      }
      if (this.hClock === LINE_CLOCKS) this._endOfLine();
    }

    _setHMode(m) {
      this.hMode = m;
      const L = this.lat;
      switch (m) {
        case H_DS: this.hCounter = this._dots((L.hds + 1) * 8); break;
        case H_DW:
          // 表示期間に入るたびに「縦を 1 つ進める」予約が立ち、表示の終わり近くで実行される
          this.needVClock = true; this.needRcrInc = true;
          this.event = EV_INC_RCR;
          this.eventCounter = this._dots((L.hdw - 1) * 8 + 2);
          this.hCounter = this._dots((L.hdw + 1) * 8);
          break;
        case H_DE: this.hCounter = this._dots((L.hde + 1) * 8); break;
        default: this.hCounter = this._dots((L.hsw + 1) * 8); this._hsyncStart(); break;
      }
    }

    // 水平同期の頭: 横のレジスタを取り込み、この行の出来事(スクロールの取り込み → 割り込みの上げ時)を予約する
    _hsyncStart() {
      const L = this.lat, R = this.reg;
      L.hsw = R.hsw; L.hds = R.hds; L.hdw = R.hdw; L.hde = R.hde;
      this.event = EV_NONE; this.eventCounter = NEVER;
      const displayStart = (this.hClock + this.hCounter + this._dots((L.hds + 1) * 8)) & 0xFFFF;
      if (displayStart - this._dots(24) >= LINE_CLOCKS) return;
      let lead;
      // ★ Mesen: 表示期間中は表示開始の 34 ドット前(これより短いとちらつくゲームがある、という合わせ込み)、それ以外は 25 ドット前
      if (this.vMode === V_DW) { this.event = EV_LATCH_Y; lead = this._dots(34); }
      else { this.event = EV_HDS_IRQ; lead = this._dots(25); }
      if (displayStart - lead <= this.hClock) this._event();
      else this.eventCounter = displayStart - lead - this.hClock;
    }

    _event() {
      switch (this.event) {
        case EV_LATCH_Y: this.needVClock = true; this.event = EV_LATCH_X; this.eventCounter = this._dots(2); break;
        case EV_LATCH_X: this.event = EV_HDS_IRQ; this.eventCounter = this._dots(6); break;
        case EV_HDS_IRQ:
          if (this.needVblank) this._vblank();
          this.event = EV_NONE; this.eventCounter = NEVER; break;
        case EV_INC_RCR: this._incRcr(); this.event = EV_NONE; this.eventCounter = NEVER; break;
        default: break;
      }
    }

    _setVMode(m) {
      this.vMode = m;
      const L = this.lat;
      switch (m) {
        case V_DS: this.vCounter = L.vds + 2; break;
        case V_DW: this.vCounter = L.vdw + 1; this.rcr = 0; break;
        case V_DE: this.vCounter = L.vcr; break;
        default: { // 垂直同期の頭で縦のレジスタを取り込む
          const R = this.reg; L.vsw = R.vsw; L.vds = R.vds; L.vdw = R.vdw; L.vcr = R.vcr;
          this.vCounter = L.vsw + 1; break;
        }
      }
    }

    _clockV() {
      if (--this.vCounter === 0) this._setVMode((this.vMode + 1) & 3);
      this.needVClock = false;
    }

    _incRcr() {
      this.rcr = (this.rcr + 1) & 0xFFFF; // 16bit(表示期間に入らないまま回り続ける設定でも Mesen と同じ所で一周する)
      this.needRcrInc = false;
      this._clockV();
      // 表示が終わった行: 垂直帰線の割り込みを予約(上げるのは次の「割り込みの上げ時」)
      if (this.vMode === V_DE && this.rcr === this.lat.vdw + 1) { this.needVblank = true; this.vblankDone = true; }
      // 走査線の割り込み(R06 と比べる。値は $40 が画面の 1 行目)
      if (this.enableRcrIrq && this.rcr === this.rcrReg - 0x40) { this.status |= ST_RCR; this.irq = true; }
    }

    // 垂直帰線。印と割り込みは許可(R05 bit3)の時だけ
    _vblank() {
      if (this.enableVblankIrq) { this.status |= ST_VBLANK; this.irq = true; }
      this.needVblank = false;
    }

    _endOfLine() {
      this.hClock = 0;
      this.scanline++;
      if (this.scanline === 256) this.frameCount++;
      else if (this.scanline >= this.lines) { this.scanline = 0; this.vblankDone = false; }
      // 行の中でやり残した「縦を進める」をここで済ませる
      if (this.needRcrInc) this._incRcr();
      else if (this.needVClock) this._clockV();
      // VCE が水平同期を掛ける: VDC が何をしていても同期へ
      this.hMode = H_SW;
      // ★ Mesen: 7MHz の時だけ同期が長い(32 ドット、ほかは 24)。これより短いと崩れるゲームがある、という合わせ込み
      this.hCounter = this._dots(this.divider === 3 ? 32 : 24);
      this._hsyncStart();
      if (this.scanline === this.lines - 3) this._setVMode(V_SW);              // VCE が終わりの 3 行で垂直同期を掛ける
      else if (this.scanline === this.lines - 2 && !this.vblankDone) this.needVblank = true;
    }

    /** VDC のポート(0-3)への書き込み。時間に関わるレジスタだけ受ける */
    write(port, value) {
      switch (port & 3) {
        case 0: this.currentReg = value & 0x1F; return;
        case 1: return;
        default: {
          const msb = (port & 3) === 3, R = this.reg;
          switch (this.currentReg) {
            case 0x05: if (!msb) { this.enableRcrIrq = (value & 0x04) !== 0; this.enableVblankIrq = (value & 0x08) !== 0; } break;
            case 0x06: this.rcrReg = msb ? ((this.rcrReg & 0xFF) | (value << 8)) & 0x3FF : ((this.rcrReg & 0xFF00) | value) & 0x3FF; break;
            case 0x0A: if (msb) R.hds = value & 0x7F; else R.hsw = value & 0x1F; break;
            case 0x0B: if (msb) R.hde = value & 0x7F; else R.hdw = value & 0x7F; break;
            case 0x0C: if (msb) R.vds = value; else R.vsw = value & 0x1F; break;
            case 0x0D: R.vdw = msb ? ((R.vdw & 0xFF) | (value << 8)) & 0x1FF : ((R.vdw & 0xFF00) | value) & 0x1FF; break;
            case 0x0E: if (!msb) R.vcr = value; break;
            default: break;
          }
        }
      }
    }

    /** ステータス(ポート 0)の読み出し。印と割り込みの線が消える */
    readStatus() {
      const v = this.status;
      this.status = 0; this.irq = false;
      return v;
    }

    /** VCE の制御レジスタ($0400)への書き込み: ドットクロックと行数 */
    writeVceControl(value) {
      this.lines = (value & 0x04) ? 263 : 262;
      this.divider = (value & 3) === 0 ? 4 : (value & 3) === 1 ? 3 : 2;
    }
  }

  Emu.PceVdcTiming = PceVdcTiming;
})(window);
