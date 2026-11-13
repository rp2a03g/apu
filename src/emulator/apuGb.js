/*
 * Game Boy 内蔵音源エミュレータ
 * MML.Emu.APUGb
 *
 * CH1(パルス+周波数スイープ)、CH2(パルス)、CH3(波形メモリ 32 サンプル×4bit)、CH4(ノイズ)。
 * レジスタは $FF10-$FF26(NR10-NR52)+ $FF30-$FF3F(波形 RAM)。
 *
 * ★2026-11-13 作り直し(DESIGN-GB-CAPTURE.md §2.2)。旧実装との違い:
 *   - ノイズの周期が 16 倍遅かった(16×分周値×2^shift としていた。正しくは 分周値×2^shift。VGMPlay 0.52 と突き合わせて確認)
 *   - 各 ch のタイマが「周期+1」T で 1 歩進んでいた(高い音ほど低くずれる)
 *   - フレームシーケンサ(長さ/スイープ/エンベロープ)は本体の DIV で進む(seqTick を本体が呼ぶ)。
 *     単体で使う時(VGM、GBS の写し再生)は内部の 8192T 分周で進む
 *   - 長さカウンタの余分な 1 減算、ゾンビモード、スイープの減算→加算での停止、ノイズ shift 14/15 の停止、
 *     NR52 OFF でのレジスタ消去と書き込み無視、読み出しのマスク、パルスのデューティ位置をトリガで戻さない、
 *     波形 ch のサンプルバッファと再生中の RAM アクセス(DMG/CGB)
 *   - 出力は ch ごとの DAC(デジタル 0〜15 → アナログ、DAC OFF は 0)+ハイパスフィルタ。
 *     NR50 や DAC の ON/OFF、波形 ch の直流分を使った PCM 再生が鳴る
 *
 * 時間は advance(t) で T(4194304Hz)単位に進める。clock() は advance(1)(旧呼び出し側との互換)。
 *
 * 参考: Pan Docs "Audio" "Audio details"、gbdev wiki "Gameboy sound hardware"。細部は blargg の dmg_sound で確かめる
 *       (tools/headless/gb-testroms.js)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const DUTY_TABLE = [
    [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
    [1, 0, 0, 0, 0, 0, 0, 1], // 25%
    [1, 0, 0, 0, 0, 1, 1, 1], // 50%
    [0, 1, 1, 1, 1, 1, 1, 0]  // 75%
  ];

  // ノイズの分周値(T)。LFSR の 1 歩 = NOISE_DIVISOR[r] << shift T(= 262144 / (r × 2^shift) Hz、r=0 は 0.5)
  const NOISE_DIVISOR = [8, 16, 32, 48, 64, 80, 96, 112];

  // 読み出しで 1 が返るビット($FF10 からの並び。$FF27-$FF2F は全部 1)
  const READ_OR_MASK = [
    0x80, 0x3F, 0x00, 0xFF, 0xBF,
    0xFF, 0x3F, 0x00, 0xFF, 0xBF,
    0x7F, 0xFF, 0x9F, 0xFF, 0xBF,
    0xFF, 0xFF, 0x00, 0x00, 0xBF,
    0x00, 0x00, 0x70
  ];

  // 音量エンベロープ(NRx2)。CH1/CH2/CH4 共用
  class Envelope {
    constructor() {
      this.initialVolume = 0;
      this.direction = 0; // 0=減衰, 1=増加
      this.period = 0;
      this.volume = 0;
      this.timer = 0;
      this.running = false; // 自動更新が続いているか(端に着くと止まる。ゾンビモードの式が見る)
    }
    // active: その ch が鳴っている最中か(鳴っている最中の書き込みは音量を変える=ゾンビモード)
    write(value, active) {
      const oldPeriod = this.period, oldDir = this.direction;
      this.initialVolume = (value >> 4) & 0x0F;
      this.direction = (value & 0x08) ? 1 : 0;
      this.period = value & 0x07;
      if (active) {
        let v = this.volume;
        if (oldPeriod === 0 && this.running) v += 1;
        else if (oldDir === 0) v += 2;
        if (oldDir !== this.direction) v = 16 - v;
        this.volume = v & 0x0F;
      }
    }
    dacOn() { return this.initialVolume !== 0 || this.direction !== 0; } // NRx2 の上位 5bit が非 0
    trigger(nextIsEnvStep) {
      this.volume = this.initialVolume;
      this.timer = this.period === 0 ? 8 : this.period;
      if (nextIsEnvStep) this.timer++; // 次のシーケンサ段がエンベロープなら 1 回ぶん遅れる
      this.running = true;
    }
    clock() {
      if (--this.timer > 0) return;
      this.timer = this.period === 0 ? 8 : this.period;
      if (this.period === 0 || !this.running) return;
      if (this.direction === 1 && this.volume < 15) this.volume++;
      else if (this.direction === 0 && this.volume > 0) this.volume--;
      else this.running = false;
    }
  }

  class PulseChannel {
    constructor(hasSweep) {
      this.hasSweep = !!hasSweep;
      this.enabled = false;
      this.dac = false;
      this.duty = 0;
      this.dutyStep = 0;
      this.lengthCounter = 0;
      this.lengthEnabled = false;
      this.freq = 0; // 11bit
      this.timer = 0;
      this.envelope = new Envelope();
      // スイープ(CH1 のみ)
      this.sweepPeriod = 0;
      this.sweepDirection = 0; // 0=加算, 1=減算
      this.sweepShift = 0;
      this.sweepTimer = 0;
      this.sweepEnabled = false;
      this.sweepNegUsed = false; // トリガ以降に減算で計算したか(その後に加算へ変えると ch が止まる)
      this.shadowFreq = 0;
      // トリガのたびに増える通し番号(gbs2mml の抽出が「このフレームでアタックがあったか」を見る)
      this.triggerSeq = 0;
    }

    writeNRx0(value) {
      const wasNeg = this.sweepDirection === 1;
      this.sweepPeriod = (value >> 4) & 0x07;
      this.sweepDirection = (value & 0x08) ? 1 : 0;
      this.sweepShift = value & 0x07;
      if (wasNeg && this.sweepDirection === 0 && this.sweepNegUsed) this.enabled = false;
    }
    writeDuty(value) { this.duty = (value >> 6) & 0x03; }
    writeLength(value) { this.lengthCounter = 64 - (value & 0x3F); }
    writeNRx2(value) {
      this.envelope.write(value, this.enabled);
      this.dac = this.envelope.dacOn();
      if (!this.dac) this.enabled = false;
    }
    writeNRx3(value) { this.freq = (this.freq & 0x700) | value; }
    // oddStep: 次のシーケンサ段が長さを数えない段か(長さの余分な 1 減算の条件)
    writeNRx4(value, oddStep, envNext) {
      this.freq = (this.freq & 0xFF) | ((value & 0x07) << 8);
      const was = this.lengthEnabled;
      this.lengthEnabled = (value & 0x40) !== 0;
      if (!was && this.lengthEnabled && oddStep && this.lengthCounter > 0) {
        if (--this.lengthCounter === 0 && !(value & 0x80)) this.enabled = false;
      }
      if (value & 0x80) this.trigger(oddStep, envNext);
    }

    trigger(oddStep, envNext) {
      this.triggerSeq++;
      if (this.dac) this.enabled = true;
      if (this.lengthCounter === 0) { this.lengthCounter = 64; if (this.lengthEnabled && oddStep) this.lengthCounter--; }
      this.timer = (2048 - this.freq) * 4; // デューティ位置は戻さない(電源 OFF でだけ戻る)
      this.envelope.trigger(envNext);
      if (this.hasSweep) {
        this.shadowFreq = this.freq;
        this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
        this.sweepEnabled = this.sweepPeriod !== 0 || this.sweepShift !== 0;
        this.sweepNegUsed = false;
        if (this.sweepShift !== 0) this.sweepCalc(); // トリガ時にもあふれを確かめる
      }
    }

    // シャドウ周波数からスイープ後の値を計算する。あふれたら ch を止める
    sweepCalc() {
      const delta = this.shadowFreq >> this.sweepShift;
      let newFreq;
      if (this.sweepDirection === 1) { newFreq = this.shadowFreq - delta; this.sweepNegUsed = true; }
      else newFreq = this.shadowFreq + delta;
      if (newFreq > 0x7FF) this.enabled = false;
      return newFreq;
    }

    clockSweep() {
      if (!this.hasSweep) return;
      if (--this.sweepTimer > 0) return;
      this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
      if (!this.sweepEnabled || this.sweepPeriod === 0) return;
      const newFreq = this.sweepCalc();
      if (newFreq <= 0x7FF && this.sweepShift !== 0) {
        this.shadowFreq = newFreq;
        this.freq = newFreq;
        this.sweepCalc(); // 反映した値でもう一度あふれを確かめる
      }
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0 && --this.lengthCounter === 0) this.enabled = false;
    }

    advance(t) {
      this.timer -= t;
      while (this.timer <= 0) {
        this.timer += (2048 - this.freq) * 4;
        this.dutyStep = (this.dutyStep + 1) & 7;
      }
    }
    clockTimer() { this.advance(1); }

    // DAC へ入るデジタル値(0〜15)。ch が止まっていれば 0
    output() {
      if (!this.enabled) return 0;
      return DUTY_TABLE[this.duty][this.dutyStep] ? this.envelope.volume : 0;
    }
  }

  class WaveChannel {
    constructor() {
      this.enabled = false;
      this.dacOn = false;
      this.lengthCounter = 0;
      this.lengthEnabled = false;
      this.freq = 0;
      this.timer = 0;
      this.volumeShift = 0; // 0=ミュート, 1=100%, 2=50%, 3=25%
      // 展開済みの 4bit サンプル(0-15)。電源投入時の波形 RAM は $00,$FF の繰り返し(DMG。書かずに鳴らす曲がある)
      this.wave = new Uint8Array(32);
      for (let i = 0; i < 32; i++) this.wave[i] = (i & 2) ? 15 : 0;
      this.samplePos = 0;
      this.sampleBuffer = 0; // 最後に取り込んだサンプル。トリガしても次の取り込みまで前の値が出る
      this.sinceFetch = 0x7FFFFFFF; // 最後の取り込みからの T(DMG は取り込みと同時でないと RAM に触れない)
      this.triggerSeq = 0;
    }

    writeNR30(value) {
      this.dacOn = (value & 0x80) !== 0;
      if (!this.dacOn) this.enabled = false;
    }
    writeLength(value) { this.lengthCounter = 256 - value; }
    writeNR32(value) { this.volumeShift = (value >> 5) & 0x03; }
    writeNR33(value) { this.freq = (this.freq & 0x700) | value; }
    writeNR34(value, oddStep, dmg) {
      this.freq = (this.freq & 0xFF) | ((value & 0x07) << 8);
      const was = this.lengthEnabled;
      this.lengthEnabled = (value & 0x40) !== 0;
      if (!was && this.lengthEnabled && oddStep && this.lengthCounter > 0) {
        if (--this.lengthCounter === 0 && !(value & 0x80)) this.enabled = false;
      }
      if (value & 0x80) this.trigger(oddStep, dmg);
    }
    // $FF30-$FF3F: 1 バイト = 2 サンプル(上位ニブルが先)
    writeWaveRam(offset, value) {
      this.wave[offset * 2] = (value >> 4) & 0x0F;
      this.wave[offset * 2 + 1] = value & 0x0F;
    }
    readWaveRam(offset) {
      return (this.wave[offset * 2] << 4) | this.wave[offset * 2 + 1];
    }

    trigger(oddStep, dmg) {
      this.triggerSeq++;
      // DMG: 鳴っている最中に、次の取り込みの直前でトリガすると波形 RAM の先頭が壊れる
      if (dmg && this.enabled && this.timer === WaveChannel.CORRUPT_T) {
        const off = (((this.samplePos + 1) & 31) >> 1);
        if (off < 4) this.writeWaveRam(0, this.readWaveRam(off));
        else { const b = off & ~3; for (let i = 0; i < 4; i++) this.writeWaveRam(i, this.readWaveRam(b + i)); }
      }
      if (this.dacOn) this.enabled = true;
      if (this.lengthCounter === 0) { this.lengthCounter = 256; if (this.lengthEnabled && oddStep) this.lengthCounter--; }
      this.timer = (2048 - this.freq) * 2 + WaveChannel.TRIGGER_DELAY_T;
      this.samplePos = 0; // バッファは取り込み直さない(最初に出るのは前の値)
      this.sinceFetch = 0x7FFFFFFF;
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0 && --this.lengthCounter === 0) this.enabled = false;
    }

    advance(t) {
      if (this.sinceFetch < 0x40000000) this.sinceFetch += t;
      if (!this.enabled) return; // 止まっている間は位置も進まない
      this.timer -= t;
      while (this.timer <= 0) {
        const period = (2048 - this.freq) * 2;
        this.timer += period;
        this.samplePos = (this.samplePos + 1) & 31;
        this.sampleBuffer = this.wave[this.samplePos];
        this.sinceFetch = period - this.timer;
      }
    }
    clockTimer() { this.advance(1); }

    output() {
      if (!this.enabled || this.volumeShift === 0) return 0;
      return this.sampleBuffer >> (this.volumeShift - 1);
    }
  }
  WaveChannel.TRIGGER_DELAY_T = 6; // トリガから最初の取り込みまでの余分な遅れ
  WaveChannel.CORRUPT_T = 2;       // 「次の取り込みの直前」= 残り 2T
  WaveChannel.ACCESS_T = 2;        // DMG: 取り込みからこの T 未満なら RAM に触れる

  class NoiseChannel {
    constructor() {
      this.enabled = false;
      this.dac = false;
      this.lengthCounter = 0;
      this.lengthEnabled = false;
      this.envelope = new Envelope();
      this.clockShift = 0;
      this.widthMode = 0; // 0=15bit, 1=7bit
      this.divisorCode = 0;
      this.timer = 0;
      this.lfsr = 0x7FFF;
      this.triggerSeq = 0;
    }

    writeLength(value) { this.lengthCounter = 64 - (value & 0x3F); }
    writeNR42(value) {
      this.envelope.write(value, this.enabled);
      this.dac = this.envelope.dacOn();
      if (!this.dac) this.enabled = false;
    }
    writeNR43(value) {
      this.clockShift = (value >> 4) & 0x0F;
      this.widthMode = (value & 0x08) ? 1 : 0;
      this.divisorCode = value & 0x07;
    }
    writeNR44(value, oddStep, envNext) {
      const was = this.lengthEnabled;
      this.lengthEnabled = (value & 0x40) !== 0;
      if (!was && this.lengthEnabled && oddStep && this.lengthCounter > 0) {
        if (--this.lengthCounter === 0 && !(value & 0x80)) this.enabled = false;
      }
      if (value & 0x80) this.trigger(oddStep, envNext);
    }

    periodT() { return NOISE_DIVISOR[this.divisorCode] << this.clockShift; }

    trigger(oddStep, envNext) {
      this.triggerSeq++;
      if (this.dac) this.enabled = true;
      if (this.lengthCounter === 0) { this.lengthCounter = 64; if (this.lengthEnabled && oddStep) this.lengthCounter--; }
      this.timer = this.periodT();
      this.lfsr = 0x7FFF;
      this.envelope.trigger(envNext);
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0 && --this.lengthCounter === 0) this.enabled = false;
    }

    advance(t) {
      this.timer -= t;
      if (this.timer > 0) return;
      const period = this.periodT();
      if (this.clockShift >= 14) { this.timer = period; return; } // shift 14/15 は LFSR が進まない
      while (this.timer <= 0) {
        this.timer += period;
        const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1;
        this.lfsr = (this.lfsr >> 1) | (bit << 14);
        if (this.widthMode) this.lfsr = (this.lfsr & ~0x40) | (bit << 6);
      }
    }
    clockTimer() { this.advance(1); }

    output() {
      if (!this.enabled) return 0;
      return (this.lfsr & 1) === 0 ? this.envelope.volume : 0; // LFSR の bit0 が 0 で出力あり
    }
  }

  class APUGb {
    // model: 'dmg'(既定)/ 'cgb'。波形 RAM の再生中アクセス、OFF 中の長さ書き込み、フィルタの定数が変わる
    constructor(model) {
      this.model = model || 'dmg';
      this.regRaw = new Uint8Array(0x17); // $FF10-$FF26 に最後に書いた値
      this.mute = { ch1: false, ch2: false, ch3: false, ch4: false };
      this.vol = { ch1: 1, ch2: 1, ch3: 1, ch4: 1 };
      this.externalSeq = false; // true: フレームシーケンサは本体が DIV の立ち下がりで seqTick() を呼ぶ
      this.divBit = null;       // () => DIV の該当ビットが今 1 か(電源 ON 直後の 1 回を飛ばす判定)
      this._out = { left: 0, right: 0 };
      this.setSampleRate(44100);
      this.reset();
    }

    reset() {
      this.ch1 = new PulseChannel(true);
      this.ch2 = new PulseChannel(false);
      this.ch3 = new WaveChannel();
      this.ch4 = new NoiseChannel();
      this.ch1.duty = 2; // ブート ROM 実行後の NR11=$BF(50%)。NR21 は $3F(12.5%)。デューティを書かない曲はこの値で鳴る
      // 単体利用(GBS の旧経路、VGM)は起動直後から鳴らせる状態で始める: 電源 ON、NR50/NR51 はブート ROM 実行後の値。
      // 本体コア(gbConsole.js)は reset の後で起動後のレジスタを書き直す
      this.powerOn = true;
      this.nr50 = 0x77;
      this.nr51 = 0xF3;
      this.regRaw.fill(0);
      this.regRaw[0x14] = 0x77; this.regRaw[0x15] = 0xF3; this.regRaw[0x16] = 0x80;
      this.seqStep = 0;     // 次に実行するシーケンサ段(0-7)。偶数=長さ、2/6=スイープ、7=エンベロープ
      this.seqCounter = 0;  // 内部分周(externalSeq=false の時)
      this.skipSeq = false;
      this.capL = 0; this.capR = 0;
    }

    // ハイパスフィルタ(出力段のコンデンサ)の 1 サンプルぶんの係数。mixSample を呼ぶ頻度を伝える
    setSampleRate(sr) {
      this.sampleRate = sr;
      this.hpf = Math.pow(this.model === 'cgb' ? 0.998943 : 0.999958, 4194304 / sr);
    }

    // フレームシーケンサを 1 段進める(512Hz)
    seqTick() {
      if (!this.powerOn) return;
      if (this.skipSeq) { this.skipSeq = false; return; }
      const s = this.seqStep;
      this.seqStep = (s + 1) & 7;
      if (!(s & 1)) { this.ch1.clockLength(); this.ch2.clockLength(); this.ch3.clockLength(); this.ch4.clockLength(); }
      if (s === 2 || s === 6) this.ch1.clockSweep();
      if (s === 7) { this.ch1.envelope.clock(); this.ch2.envelope.clock(); this.ch4.envelope.clock(); }
    }
    // 旧名(外から呼ぶ所は無いが残す)
    clockLength() { this.ch1.clockLength(); this.ch2.clockLength(); this.ch3.clockLength(); this.ch4.clockLength(); }
    clockSweep() { this.ch1.clockSweep(); }
    clockEnvelope() { this.ch1.envelope.clock(); this.ch2.envelope.clock(); this.ch4.envelope.clock(); }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0xFF30 && addr <= 0xFF3F) {
        const w = this.ch3;
        if (w.enabled) { // 再生中: 今読んでいるバイトに当たる。DMG は取り込みと同時の時だけ
          if (this.model === 'dmg' && w.sinceFetch >= WaveChannel.ACCESS_T) return;
          w.writeWaveRam(w.samplePos >> 1, value);
        } else w.writeWaveRam(addr - 0xFF30, value);
        return;
      }
      if (addr < 0xFF10 || addr > 0xFF26) return;
      const dmg = this.model === 'dmg';
      if (!this.powerOn && addr !== 0xFF26) {
        // 電源 OFF 中は書けない。DMG だけ長さカウンタ(NRx1 の長さ部分)は書ける
        if (!dmg) return;
        if (addr === 0xFF11) this.ch1.writeLength(value);
        else if (addr === 0xFF16) this.ch2.writeLength(value);
        else if (addr === 0xFF1B) this.ch3.writeLength(value);
        else if (addr === 0xFF20) this.ch4.writeLength(value);
        return;
      }
      this.regRaw[addr - 0xFF10] = value;
      const odd = (this.seqStep & 1) === 1, envNext = this.seqStep === 7;
      switch (addr) {
        case 0xFF10: this.ch1.writeNRx0(value); break;
        case 0xFF11: this.ch1.writeDuty(value); this.ch1.writeLength(value); break;
        case 0xFF12: this.ch1.writeNRx2(value); break;
        case 0xFF13: this.ch1.writeNRx3(value); break;
        case 0xFF14: this.ch1.writeNRx4(value, odd, envNext); break;
        case 0xFF16: this.ch2.writeDuty(value); this.ch2.writeLength(value); break;
        case 0xFF17: this.ch2.writeNRx2(value); break;
        case 0xFF18: this.ch2.writeNRx3(value); break;
        case 0xFF19: this.ch2.writeNRx4(value, odd, envNext); break;
        case 0xFF1A: this.ch3.writeNR30(value); break;
        case 0xFF1B: this.ch3.writeLength(value); break;
        case 0xFF1C: this.ch3.writeNR32(value); break;
        case 0xFF1D: this.ch3.writeNR33(value); break;
        case 0xFF1E: this.ch3.writeNR34(value, odd, dmg); break;
        case 0xFF20: this.ch4.writeLength(value); break;
        case 0xFF21: this.ch4.writeNR42(value); break;
        case 0xFF22: this.ch4.writeNR43(value); break;
        case 0xFF23: this.ch4.writeNR44(value, odd, envNext); break;
        case 0xFF24: this.nr50 = value; break;
        case 0xFF25: this.nr51 = value; break;
        case 0xFF26: {
          const on = (value & 0x80) !== 0;
          if (this.powerOn && !on) this._powerOff();
          else if (!this.powerOn && on) {
            this.powerOn = true;
            this.seqStep = 0; this.seqCounter = 0;
            // 本体の DIV で進む時: 該当ビットが 1 の最中に電源を入れると、最初の立ち下がりは数えない
            this.skipSeq = !!(this.externalSeq && this.divBit && this.divBit());
            this.ch1.dutyStep = 0; this.ch2.dutyStep = 0;
            this.ch3.sampleBuffer = 0;
          }
          this.regRaw[0x16] = value & 0x80;
          break;
        }
      }
    }

    // NR52 OFF: $FF10-$FF25 を全部 0 にする(波形 RAM は残る。DMG は長さカウンタも残る)
    _powerOff() {
      const keep = this.model === 'dmg' ? [this.ch1.lengthCounter, this.ch2.lengthCounter, this.ch3.lengthCounter, this.ch4.lengthCounter] : null;
      for (let a = 0xFF10; a < 0xFF26; a++) { if (a !== 0xFF15 && a !== 0xFF1F) this.writeRegister(a, 0); }
      this.regRaw.fill(0);
      this.powerOn = false;
      for (const ch of [this.ch1, this.ch2, this.ch3, this.ch4]) { ch.enabled = false; ch.lengthEnabled = false; ch.lengthCounter = 0; }
      this.ch1.envelope.volume = 0; this.ch2.envelope.volume = 0; this.ch4.envelope.volume = 0;
      if (keep) { this.ch1.lengthCounter = keep[0]; this.ch2.lengthCounter = keep[1]; this.ch3.lengthCounter = keep[2]; this.ch4.lengthCounter = keep[3]; }
    }

    readRegister(addr) {
      if (addr >= 0xFF30 && addr <= 0xFF3F) {
        const w = this.ch3;
        if (!w.enabled) return w.readWaveRam(addr - 0xFF30);
        if (this.model === 'dmg' && w.sinceFetch >= WaveChannel.ACCESS_T) return 0xFF;
        return w.readWaveRam(w.samplePos >> 1);
      }
      if (addr < 0xFF10 || addr > 0xFF2F) return 0xFF;
      if (addr > 0xFF26) return 0xFF;
      if (addr === 0xFF26) {
        return (this.powerOn ? 0x80 : 0) | 0x70 | (this.ch1.enabled ? 1 : 0) | (this.ch2.enabled ? 2 : 0) | (this.ch3.enabled ? 4 : 0) | (this.ch4.enabled ? 8 : 0);
      }
      const off = addr - 0xFF10;
      return this.regRaw[off] | READ_OR_MASK[off];
    }

    // CGB の PCM12 / PCM34($FF76/$FF77): 各 ch の今のデジタル出力
    readPcm12() { return this.ch1.output() | (this.ch2.output() << 4); }
    readPcm34() { return this.ch3.output() | (this.ch4.output() << 4); }

    // t T 進める
    advance(t) {
      if (this.powerOn) {
        this.ch1.advance(t); this.ch2.advance(t); this.ch3.advance(t); this.ch4.advance(t);
        if (!this.externalSeq) {
          this.seqCounter += t;
          while (this.seqCounter >= 8192) { this.seqCounter -= 8192; this.seqTick(); }
        }
      }
    }
    clock() { this.advance(1); }

    /**
     * 今の出力を {left, right} で返す(同じオブジェクトを使い回す。呼ぶたびにフィルタが 1 サンプル進む)。
     * ch ごとに DAC がデジタル 0〜15 をアナログ −1〜+1 に直す(DAC OFF は 0)。NR51 で左右へ配り、NR50 の音量(1〜8)を掛け、
     * 出力段のコンデンサ(ハイパスフィルタ)を通す。大きさは旧実装に合わせてある(1ch の振れ幅が 0.25)。
     */
    mixSample() {
      const m = this.mute, vol = this.vol, nr51 = this.nr51;
      let left = 0, right = 0, a;
      if (this.ch1.dac && !m.ch1) { a = (this.ch1.output() / 7.5 - 1) * vol.ch1; if (nr51 & 0x10) left += a; if (nr51 & 0x01) right += a; }
      if (this.ch2.dac && !m.ch2) { a = (this.ch2.output() / 7.5 - 1) * vol.ch2; if (nr51 & 0x20) left += a; if (nr51 & 0x02) right += a; }
      if (this.ch3.dacOn && !m.ch3) { a = (this.ch3.output() / 7.5 - 1) * vol.ch3; if (nr51 & 0x40) left += a; if (nr51 & 0x04) right += a; }
      if (this.ch4.dac && !m.ch4) { a = (this.ch4.output() / 7.5 - 1) * vol.ch4; if (nr51 & 0x80) left += a; if (nr51 & 0x08) right += a; }
      left *= (((this.nr50 >> 4) & 7) + 1) * 0.015625;  // ÷8(音量)÷8(1ch の振れ幅 2 → 0.25)
      right *= ((this.nr50 & 7) + 1) * 0.015625;
      const o = this._out;
      o.left = left - this.capL; this.capL = left - o.left * this.hpf;
      o.right = right - this.capR; this.capR = right - o.right * this.hpf;
      return o;
    }
  }

  // NR51 の該当ビットが左右とも 0 なら、音量があっても聞こえない(ch=0-3)
  function nr51Audible(nr51, ch) {
    return (((nr51 >> (4 + ch)) & 1) !== 0) || (((nr51 >> ch) & 1) !== 0);
  }

  // 鍵盤表示用のライブ値(snapshotAY8910/snapshotSCC と同じ考え方)
  Emu.snapshotGbApu = function (apu) {
    const p = (ch, chIndex) => {
      const freq = ch.enabled ? 131072 / (2048 - ch.freq) : 0;
      return {
        freq, vol: ch.envelope.volume / 15, rawVol: ch.envelope.volume,
        duty: ch.duty, envPeriod: ch.envelope.period,
        active: ch.enabled && ch.envelope.volume > 0 && freq > 0 && nr51Audible(apu.nr51, chIndex)
      };
    };
    const w = apu.ch3;
    const wVol = { 0: 0, 1: 1, 2: 0.5, 3: 0.25 }[w.volumeShift] || 0;
    const wFreq = (w.enabled && w.dacOn) ? 65536 / (2048 - w.freq) : 0;
    const n = apu.ch4;
    const nFreq = n.enabled ? 4194304 / (NOISE_DIVISOR[n.divisorCode] * Math.pow(2, n.clockShift)) : 0;
    return {
      ch1: p(apu.ch1, 0),
      ch2: p(apu.ch2, 1),
      ch3: {
        freq: wFreq, vol: wVol, rawVol: w.volumeShift,
        waveData: Array.from(w.wave, v => v / 7.5 - 1), // 0-15 → -1..1
        active: w.enabled && w.dacOn && wVol > 0 && wFreq > 0 && nr51Audible(apu.nr51, 2)
      },
      ch4: {
        freq: nFreq, vol: n.envelope.volume / 15, rawVol: n.envelope.volume,
        widthMode: n.widthMode, envPeriod: n.envelope.period,
        active: n.enabled && n.envelope.volume > 0 && nr51Audible(apu.nr51, 3)
      },
      nr50: apu.nr50, nr51: apu.nr51
    };
  };

  APUGb.NOISE_DIVISOR = NOISE_DIVISOR;
  APUGb.WaveChannel = WaveChannel;
  Emu.APUGb = APUGb;
})(window);
