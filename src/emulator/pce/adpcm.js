/*
 * CD-ROM² の ADPCM(MSM5205+RAM 64K+番地と長さのカウンタ)
 * MML.Emu.PceAdpcm(段階 9e)
 *
 * host は PceCdRom(setIrq / clearIrq、SCSI の口、時計 host.clock)。exec() はマスタークロック 3 個ごと(need が立っている間だけ呼ばれる)。
 * レジスタ: $1808/$1809 番地の口、$180A RAM の読み書き、$180B CD からの流し込み、$180C 状態(読み)、$180D 制御、$180E 再生の速さ。
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3)。[参照] は Mesen 2 の Core/PCE/CdRom/PceAdpcm.cpp(読んだだけで写していない):
 *   [参照] $180D: bit1 の立ち上がりで書き込み番地 = 番地の口(bit0 が 0 なら -1)、bit3 の立ち上がりで読み出し番地 = 番地の口(bit2 が 0 なら -1)、
 *          bit4 が立っている間は長さ = 番地の口で「終わり」の印を下ろす、bit5 = 再生、bit6 = 長さが 0 になったら止まる、bit7 = リセット
 *   [参照] $180A の読み書きは RAM の空き枠を待つ。枠はマスタークロック 18 個ごとに 4 種類が巡り、読みは 1〜4 枠後、書きは 1〜3 枠後に行われる
 *          (その間 $180C の bit7 / bit2 が立つ)。Mesen のコメント: 実際の遅れは分かっておらず、試験 ROM が通る値
 *   [参照] 読み出しのたびに長さを 1 減らし、0 で「終わり」。書き込みのたびに長さを 1 増やす(17bit)。半分($8000)を下回ると「半分」の印
 *   [参照] 再生: 1 個ごとに 4bit(上位 → 下位の順)。12bit の出力を差分で動かす。長さが $8000 以下で「半分」、0 で「終わり」
 *          速さ = 32000 / (16 - $180E の下位 4bit) Hz
 *   [参照] $180B(CD からの流し込み): bit0 か bit1 が立っている間、SCSI がデータを出して待っていれば、3×20 クロック後に 1 個取り込んで RAM へ書く。
 *          データが尽きたら bit0 だけ下ろす(Mesen のコメント: bit1 まで下ろすと止まるソフト、bit0 を下ろさないと止まるソフトがある)
 *   ★ 「半分」「終わり」の印の立て方は Mesen のまま(読み出し・書き込み・再生で条件が少しずつ違う: 未満/以下)。実機と同じかは未確認
 *   [推定] 差分の表は MSM5205 の一般的な式(段の幅 = 16 × 1.1^n を切り捨て、n = 0〜48)で作る。Mesen の表と 392 個とも同じになることを確かめた
 *   [推定] 音に出す値: (出力 - 2048) × 10 を 16bit の値として扱う(Mesen と同じ)。止まった後は最後の値からゆっくり 0 へ戻す(Mesen は無音)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const MASTER = 21477270;
  const IRQ_HALF = 0x04, IRQ_END = 0x08;

  // 差分の表: 49 段 × 8(下位 3bit)
  const STEP = (() => {
    const t = new Int16Array(49 * 8);
    for (let n = 0; n < 49; n++) {
      const s = Math.floor(16 * Math.pow(1.1, n));
      for (let v = 0; v < 8; v++) t[n * 8 + v] = Math.floor(s / 8) + ((v & 1) ? Math.floor(s / 4) : 0) + ((v & 2) ? Math.floor(s / 2) : 0) + ((v & 4) ? s : 0);
    }
    return t;
  })();
  const STEP_MOVE = [-1, -1, -1, -1, 2, 4, 6, 8];

  class PceAdpcm {
    constructor(host) {
      this.host = host;
      this.ram = new Uint8Array(0x10000);
      this.nibble = false;
      this.readAddr = 0; this.writeAddr = 0; this.addrPort = 0;
      this.dmaCtrl = 0; this.control = 0; this.rate = 0;
      this.length = 0;
      this.endReached = false; this.halfReached = false;
      this.playing = false; this.playRequest = false;
      this.readBuf = 0; this.readWait = 0;
      this.writeBuf = 0; this.writeWait = 0;
      this.out = 0;           // 12bit の出力(リセットで 2048)
      this.magnitude = 0;
      this.dmaWait = 0;
      this.need = true;
      this.clocksPerSample = MASTER / 32000;
      this.sampleCounter = 0;
      // 音に出す側(補間用に 1 つ前と今)
      this.audPrev = 0; this.audCur = 0; this.audAt = 0;
      this.onSample = null;   // (12bit の出力, 4bit の符号, 再生の始まりか) 再生で 1 個進むたび(録音用)
      this.onStop = null;     // 再生が止まった時(録音用)
    }

    _reset() {
      this.playRequest = false;
      this.writeWait = 0; this.readWait = 0;
      this.readAddr = 0; this.writeAddr = 0; this.addrPort = 0;
      this._setEnd(false); this._setHalf(false);
      this.length = 0;
      this.nibble = false;
      this.out = 2048; this.magnitude = 0;
    }
    _setHalf(v) { if (this.halfReached !== v) { this.halfReached = v; if (v) this.host.setIrq(IRQ_HALF); else this.host.clearIrq(IRQ_HALF); } }
    _setEnd(v) { if (this.endReached !== v) { this.endReached = v; if (v) this.host.setIrq(IRQ_END); else this.host.clearIrq(IRQ_END); } }

    _flags() {
      if (this.control & 0x10) { this.length = this.addrPort; this._setEnd(false); }
      if (this.control & 0x80) this._reset();
      if (this.control & 0x20) this.need = true;
    }

    _setControl(value) {
      if ((value & 0x02) && !(this.control & 0x02)) this.writeAddr = (this.addrPort - ((value & 0x01) ? 0 : 1)) & 0xFFFF;
      if ((value & 0x08) && !(this.control & 0x08)) this.readAddr = (this.addrPort - ((value & 0x04) ? 0 : 1)) & 0xFFFF;
      if (!this.playing && (value & 0x20)) this.playRequest = true;
      this.control = value;
      this._flags();
    }

    /** 次の空き枠までの待ち(exec の回数) */
    _slotWait(forRead) {
      const clock = this.host.clock, slot = Math.floor(clock / 18);
      let gap;
      switch (slot & 3) {
        case 1: gap = forRead ? 2 : 1; break;
        case 2: gap = forRead ? 1 : 3; break;
        case 3: gap = forRead ? 4 : 2; break;
        default: gap = forRead ? 3 : 1; break;
      }
      return Math.floor(((slot + gap) * 18 - clock) / 3) & 0xFF;
    }

    exec() {
      this._flags();
      if (this.playing || this.playRequest || (this.control & 0x20)) {
        this.sampleCounter += 3;
        if (this.sampleCounter >= this.clocksPerSample) { this._playSample(); this.sampleCounter -= this.clocksPerSample; }
      }
      if (this.readWait > 0 && --this.readWait === 0) {
        this.readBuf = this.ram[this.readAddr];
        this.readAddr = (this.readAddr + 1) & 0xFFFF;
        if (!(this.control & 0x10)) {
          if (this.length > 0) { this.length--; this._setHalf(this.length < 0x8000); }
          else { this._setEnd(true); this._setHalf(false); }
        }
      }
      if (this.writeWait > 0 && --this.writeWait === 0) {
        this.ram[this.writeAddr] = this.writeBuf;
        this.writeAddr = (this.writeAddr + 1) & 0xFFFF;
        if (this.length === 0) this._setEnd(true);
        this._setHalf(this.length < 0x8000);
        if (!(this.control & 0x10)) this.length = (this.length + 1) & 0x1FFFF;
      }
      const dma = (this.dmaCtrl & 0x03) !== 0;
      if (dma) this._dma();
      this._flags();
      this.need = this.playing || this.playRequest || (this.control & 0x20) !== 0 || this.readWait !== 0 || this.writeWait !== 0 || dma || this.dmaWait !== 0;
    }

    _dma() {
      const scsi = this.host;
      if (this.dmaWait) {
        if (--this.dmaWait === 0) {
          if (!this.writeWait) {
            this.writeWait = this._slotWait(false);
            this.writeBuf = scsi.scsiDataPort();
            scsi.scsiAckAuto();
            if (!scsi.scsiDataReady()) this.dmaCtrl &= ~0x01;
          } else this.dmaWait++;
        }
      } else if (!scsi.ack && !scsi.cdl && scsi.io && scsi.req) this.dmaWait = 20;
    }

    write(reg, value) {
      switch (reg) {
        case 0x08: this.addrPort = (this.addrPort & 0xFF00) | value; break;
        case 0x09: this.addrPort = (this.addrPort & 0x00FF) | (value << 8); break;
        case 0x0A: this.writeWait = this._slotWait(false); this.writeBuf = value; this.need = true; break;
        case 0x0B: if (!this.host.scsiDataReady()) value &= ~0x01; this.dmaCtrl = value; this.need = true; break;
        case 0x0D: this._setControl(value); break;
        case 0x0E: this.rate = value; this.clocksPerSample = MASTER / (32000 / (16 - (value & 0x0F))); break;
        default: break;
      }
    }

    read(reg) {
      switch (reg) {
        case 0x0A: this.readWait = this._slotWait(true); this.need = true; return this.readBuf;
        case 0x0B: return this.dmaCtrl;
        case 0x0C: return (this.endReached ? 0x01 : 0) | (this.writeWait ? 0x04 : 0) | (this.playing ? 0x08 : 0) | (this.readWait ? 0x80 : 0);
        case 0x0D: return this.control;
        case 0x0E: return this.rate;
        default: return 0;
      }
    }

    _playSample() {
      if (this.control & 0x80) { this.playing = (this.control & 0x20) !== 0; this.playRequest = false; return; }
      if (((this.control & 0x40) && this.length === 0) || !(this.control & 0x20) || (!this.playing && !this.playRequest)) {
        this.playRequest = false;
        if (this.playing) { this.playing = false; if (this.onStop) this.onStop(); }
        return;
      }
      let first = false;
      if (this.playRequest) { this.playRequest = false; this.playing = true; this.out = 2048; this.magnitude = 0; first = true; }
      let data;
      if (this.nibble) {
        this.nibble = false;
        data = this.ram[this.readAddr] & 0x0F;
        this.readAddr = (this.readAddr + 1) & 0xFFFF;
        this.length = (this.length - 1) & 0x1FFFF;
      } else {
        this.nibble = true;
        data = this.ram[this.readAddr] >> 4;
      }
      const v = data & 7, d = STEP[(this.magnitude << 3) | v];
      this.out = (this.out + ((data & 8) ? -d : d)) & 0xFFF;
      this.magnitude = Math.max(0, Math.min(48, this.magnitude + STEP_MOVE[v]));
      this._setHalf(this.length <= 0x8000);
      if (this.length === 0) this._setEnd(true);
      this.audPrev = this.audCur; this.audCur = (this.out - 2048) * 10; this.audAt = this.host.clock;
      if (this.onSample) this.onSample(this.out, data, first);
    }

    /** 今の音(16bit 相当の値)。再生中は 1 つ前と今の間を直線でつなぐ。止まっている間はゆっくり 0 へ */
    level(clock) {
      if (this.playing) {
        const f = (clock - this.audAt) / this.clocksPerSample;
        return f >= 1 ? this.audCur : this.audPrev + (this.audCur - this.audPrev) * f;
      }
      if (this.audCur !== 0) { this.audCur *= 0.998; if (Math.abs(this.audCur) < 1) this.audCur = 0; this.audPrev = this.audCur; }
      return this.audCur;
    }
  }

  PceAdpcm.STEP = STEP;
  Emu.PceAdpcm = PceAdpcm;
})(typeof window !== 'undefined' ? window : globalThis);
