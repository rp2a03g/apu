/*
 * Game Boy (DMG) 内蔵音源エミュレータ
 * MML.Emu.APUGb
 *
 * CH1(パルス+周波数スイープ), CH2(パルス), CH3(波形メモリ32サンプル×4bit),
 * CH4(ノイズ) の4チャンネルを実装。レジスタは $FF10-$FF26(NR10-NR52) + $FF30-$FF3F(波形RAM)。
 * clock() を1 Tステート(CPUクロック4194304Hz)ごとに呼び出す設計
 * (gbsPlayer.jsがCPUの消費サイクル数だけ呼ぶ想定。apu2a03.jsのclock()と同じ考え方)。
 *
 * 参考: Pan Docs "Audio Details" https://gbdev.io/pandocs/Audio_details.html
 *       gbdev.gg8.se wiki "Gameboy sound hardware"
 *
 * ★CH3(波形メモリ)は32サンプル×4bit・音量はグローバル4段階シフトのみで、
 *   FDSのような変調機能もN163のような可変長波形も無い(GB実機の素の仕様どおり実装する)。
 *   このCH3をgbs2mml変換でN163に借用する話(MML出力側の話)とは別問題。
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

  // ノイズの分周値テーブル(Pan Docs記載の8値)。周期(Tステート) = 16 * NOISE_DIVISOR[r] * 2^shift
  // (f = 524288 / divisor / 2^(shift+1) Hz、CPUクロック4194304Hz = 524288*8 から導出)
  const NOISE_DIVISOR = [8, 16, 32, 48, 64, 80, 96, 112];

  // $FF10オフセット基準の「読み出し不能ビットは1で返す」ORマスク(Pan Docs準拠)
  const READ_OR_MASK = {
    0x00: 0x80, 0x01: 0x3F, 0x02: 0x00, 0x03: 0xFF, 0x04: 0xBF,
    0x06: 0x3F, 0x07: 0x00, 0x08: 0xFF, 0x09: 0xBF,
    0x0A: 0x7F, 0x0B: 0xFF, 0x0C: 0x9F, 0x0D: 0xFF, 0x0E: 0xBF,
    0x10: 0xFF, 0x11: 0x00, 0x12: 0x00, 0x13: 0xBF
  };

  // CH1(スイープ有)/CH2(スイープ無)共用の音量エンベロープ(NRx2)
  class Envelope {
    constructor() {
      this.initialVolume = 0;
      this.direction = 0; // 0=減衰,1=増加
      this.period = 0;
      this.volume = 0;
      this.timer = 0;
    }
    write(value) {
      this.initialVolume = (value >> 4) & 0x0F;
      this.direction = (value & 0x08) ? 1 : 0;
      this.period = value & 0x07;
    }
    dacOn() { return this.initialVolume !== 0 || this.direction !== 0; } // NRx2上位5bitが非0
    trigger() {
      this.volume = this.initialVolume;
      this.timer = this.period === 0 ? 8 : this.period;
    }
    clock() {
      if (this.period === 0) return; // period=0はエンベロープ無効(実機仕様)
      if (this.timer > 0) this.timer--;
      if (this.timer === 0) {
        this.timer = this.period;
        if (this.direction === 1 && this.volume < 15) this.volume++;
        else if (this.direction === 0 && this.volume > 0) this.volume--;
      }
    }
  }

  class PulseChannel {
    constructor(hasSweep) {
      this.hasSweep = !!hasSweep;
      this.enabled = false;
      this.duty = 2;
      this.dutyStep = 0;
      this.lengthCounter = 0;
      this.lengthEnabled = false;
      this.freq = 0; // 11bit
      this.timer = 0;
      this.envelope = new Envelope();
      // スイープ(CH1のみ意味を持つ)
      this.sweepPeriod = 0;
      this.sweepDirection = 0; // 0=増加,1=減少
      this.sweepShift = 0;
      this.sweepTimer = 0;
      this.sweepEnabled = false;
      this.shadowFreq = 0;
      // トリガ(音符アタック)のたびに増える通し番号。gbs2mmlのキャプチャがwriteLog
      // replayなしで「このフレームでアタックがあったか」を判定するのに使う
      // (nsf2mml/converter.jsのt.attack[chKey]に相当。GBは実際のトリガbitを持つため
      // ay.js/scc.jsの音量上昇ヒューリスティックより確実に判定できる)。
      this.triggerSeq = 0;
    }

    writeNRx0(value) { // NR10(CH1のみ)
      this.sweepPeriod = (value >> 4) & 0x07;
      this.sweepDirection = (value & 0x08) ? 1 : 0;
      this.sweepShift = value & 0x07;
    }
    writeNRx1(value) { // NR11/NR21
      this.duty = (value >> 6) & 0x03;
      this.lengthCounter = 64 - (value & 0x3F);
    }
    writeNRx2(value) { // NR12/NR22
      this.envelope.write(value);
      if (!this.envelope.dacOn()) this.enabled = false;
    }
    writeNRx3(value) { // NR13/NR23
      this.freq = (this.freq & 0x700) | value;
    }
    writeNRx4(value) { // NR14/NR24
      this.freq = (this.freq & 0xFF) | ((value & 0x07) << 8);
      this.lengthEnabled = (value & 0x40) !== 0;
      if (value & 0x80) this.trigger();
    }

    trigger() {
      this.triggerSeq++;
      if (this.envelope.dacOn()) this.enabled = true;
      if (this.lengthCounter === 0) this.lengthCounter = 64;
      this.timer = (2048 - this.freq) * 4;
      this.dutyStep = 0;
      this.envelope.trigger();
      if (this.hasSweep) {
        this.shadowFreq = this.freq;
        this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
        this.sweepEnabled = this.sweepPeriod !== 0 || this.sweepShift !== 0;
        if (this.sweepShift !== 0) this.sweepCalc(); // トリガ時の即時オーバーフロー確認(実機仕様)
      }
    }

    // シャドウ周波数からスイープ後の値を計算し、オーバーフローならチャンネルを止める
    sweepCalc() {
      const delta = this.shadowFreq >> this.sweepShift;
      const newFreq = this.sweepDirection === 1 ? (this.shadowFreq - delta) : (this.shadowFreq + delta);
      if (newFreq > 0x7FF) this.enabled = false;
      return newFreq;
    }

    clockSweep() {
      if (!this.hasSweep || !this.sweepEnabled) return;
      if (this.sweepTimer > 0) this.sweepTimer--;
      if (this.sweepTimer === 0) {
        this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
        if (this.sweepPeriod !== 0) {
          const newFreq = this.sweepCalc();
          if (newFreq <= 0x7FF && this.sweepShift !== 0) {
            this.shadowFreq = newFreq;
            this.freq = newFreq;
            this.sweepCalc(); // 反映後の2度目のオーバーフロー確認(実機仕様)
          }
        }
      }
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0) {
        this.lengthCounter--;
        if (this.lengthCounter === 0) this.enabled = false;
      }
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = (2048 - this.freq) * 4;
        this.dutyStep = (this.dutyStep + 1) & 7;
      } else {
        this.timer--;
      }
    }

    output() {
      // lengthCounter===0自体はここでは見ない。実機はlengthEnabled時のみカウントダウンし、
      // 0到達時にclockLength()がenabledをfalseにする(このifは実質lengthEnabled=falseなら
      // 常に無評価)。ここでも重ねてlengthCounterを見ると、GbsReplayStreamPlayerのように
      // trigger()/clockLength()のライフサイクルを経由せずenabledだけをスナップショットから
      // 直接書き戻す再生経路で、初期値0のままのlengthCounterに引っかかり常時無音化する
      // バグになっていた(ユーザー報告: パルス/ノイズが鳴らずwaveのみ鳴る)。
      if (!this.enabled) return 0;
      if (DUTY_TABLE[this.duty][this.dutyStep] === 0) return 0;
      return this.envelope.volume;
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
      this.volumeShift = 0; // 0=ミュート,1=100%,2=50%(>>1),3=25%(>>2)
      // 展開済み4bitサンプル(0-15)。実機は電源投入時に波形RAMへ$00,$FF,$00,$FF...という
      // 固定パターンが入っている(DMG A-C/MGB/CGB共通、DMG0のみ別パターンだが極めて稀な
      // 初期リビジョンのため無視)。波形RAMを一度も書き込まず初期状態のまま再生する曲が
      // 実在する(例: R-Type/Irem)ため、全0初期化だと実機と異なり無音になってしまう。
      // ニブル展開すると[0,0,15,15]の4個パターンが8回繰り返す形になる。
      this.wave = new Uint8Array([0,0,15,15, 0,0,15,15, 0,0,15,15, 0,0,15,15, 0,0,15,15, 0,0,15,15, 0,0,15,15, 0,0,15,15]);
      this.samplePos = 0;
      this.triggerSeq = 0; // PulseChannelと同じ用途(gbs2mml向け)
    }

    writeNR30(value) {
      this.dacOn = (value & 0x80) !== 0;
      if (!this.dacOn) this.enabled = false;
    }
    writeNR31(value) { this.lengthCounter = 256 - value; }
    writeNR32(value) { this.volumeShift = (value >> 5) & 0x03; }
    writeNR33(value) { this.freq = (this.freq & 0x700) | value; }
    writeNR34(value) {
      this.freq = (this.freq & 0xFF) | ((value & 0x07) << 8);
      this.lengthEnabled = (value & 0x40) !== 0;
      if (value & 0x80) this.trigger();
    }
    // $FF30-$FF3F: 1byte=2サンプル(上位ニブル=先, 下位ニブル=後)
    writeWaveRam(offset, value) {
      this.wave[offset * 2] = (value >> 4) & 0x0F;
      this.wave[offset * 2 + 1] = value & 0x0F;
    }
    readWaveRam(offset) {
      return (this.wave[offset * 2] << 4) | this.wave[offset * 2 + 1];
    }

    trigger() {
      this.triggerSeq++;
      if (this.dacOn) this.enabled = true;
      if (this.lengthCounter === 0) this.lengthCounter = 256;
      this.timer = (2048 - this.freq) * 2;
      this.samplePos = 0;
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0) {
        this.lengthCounter--;
        if (this.lengthCounter === 0) this.enabled = false;
      }
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = (2048 - this.freq) * 2;
        this.samplePos = (this.samplePos + 1) & 31;
      } else {
        this.timer--;
      }
    }

    output() {
      if (!this.enabled || !this.dacOn || this.volumeShift === 0) return 0;
      return this.wave[this.samplePos] >> (this.volumeShift - 1);
    }
  }

  class NoiseChannel {
    constructor() {
      this.enabled = false;
      this.lengthCounter = 0;
      this.lengthEnabled = false;
      this.envelope = new Envelope();
      this.clockShift = 0;
      this.widthMode = 0; // 0=15bit, 1=7bit
      this.divisorCode = 0;
      this.timer = 0;
      this.lfsr = 0x7FFF;
      // PulseChannel/WaveChannelと同じ用途(gbs2mml向けトリガ検出、apuGb.js冒頭コメント参照)。
      // ★これが未初期化(undefined)のままだとtrigger()の`this.triggerSeq++`が
      // undefined+1=NaNを生み、以後ずっとNaNのまま(NaN+1もNaN)。NaNはNaN自身とも
      // !==で「不一致」判定されるため、抽出側のtriggerSeq変化検出が「毎フレーム
      // トリガーされた」と誤判定し、休符が1フレームずつバラバラに分断されて
      // MML再生時のノイズ(ドラム)パートの発音位置が実機と大きくズレる原因になっていた。
      this.triggerSeq = 0;
    }

    writeNR41(value) { this.lengthCounter = 64 - (value & 0x3F); }
    writeNR42(value) {
      this.envelope.write(value);
      if (!this.envelope.dacOn()) this.enabled = false;
    }
    writeNR43(value) {
      this.clockShift = (value >> 4) & 0x0F;
      this.widthMode = (value & 0x08) ? 1 : 0;
      this.divisorCode = value & 0x07;
    }
    writeNR44(value) {
      this.lengthEnabled = (value & 0x40) !== 0;
      if (value & 0x80) this.trigger();
    }

    periodT() { return 16 * NOISE_DIVISOR[this.divisorCode] * (1 << this.clockShift); }

    trigger() {
      this.triggerSeq++;
      if (this.envelope.dacOn()) this.enabled = true;
      if (this.lengthCounter === 0) this.lengthCounter = 64;
      this.timer = this.periodT();
      this.lfsr = 0x7FFF;
      this.envelope.trigger();
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0) {
        this.lengthCounter--;
        if (this.lengthCounter === 0) this.enabled = false;
      }
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.periodT();
        const bit = (this.lfsr & 1) ^ ((this.lfsr >> 1) & 1);
        this.lfsr = (this.lfsr >> 1) | (bit << 14);
        if (this.widthMode) this.lfsr = (this.lfsr & ~0x40) | (bit << 6);
      } else {
        this.timer--;
      }
    }

    output() {
      // lengthCounter===0自体はここでは見ない。実機はlengthEnabled時のみカウントダウンし、
      // 0到達時にclockLength()がenabledをfalseにする(このifは実質lengthEnabled=falseなら
      // 常に無評価)。ここでも重ねてlengthCounterを見ると、GbsReplayStreamPlayerのように
      // trigger()/clockLength()のライフサイクルを経由せずenabledだけをスナップショットから
      // 直接書き戻す再生経路で、初期値0のままのlengthCounterに引っかかり常時無音化する
      // バグになっていた(ユーザー報告: パルス/ノイズが鳴らずwaveのみ鳴る)。
      if (!this.enabled) return 0;
      return (this.lfsr & 1) === 0 ? this.envelope.volume : 0; // LFSR bit0=0で"高い"(実機の反転規約)
    }
  }

  class APUGb {
    constructor() {
      this.ch1 = new PulseChannel(true);
      this.ch2 = new PulseChannel(false);
      this.ch3 = new WaveChannel();
      this.ch4 = new NoiseChannel();
      this.powerOn = true;
      // NR50/NR51は実機ブートROMがINIT実行前に書き込む post-boot 値で初期化する
      // (Pan Docs "Power Up Sequence"参照)。GBSプレイヤーはブートROM自体を実行せず
      // 直接INITを呼ぶため、多くの市販曲のようにNR50/NR51をINITが明示的に書き換えない
      // 曲では、ここが0のままだと(実機なら$77で鳴る所を)不自然に無音/小音量になる。
      this.nr50 = 0x77; // VIN無効、L/R音量とも最大(7)
      this.nr51 = 0xF3; // CH1-4→L全ON、CH1/2→R ON、CH3/4→R OFF(ブートチャイム由来の値そのまま)
      this.frameSeqStep = 0;
      this.frameSeqCounter = 0;
      this.regRaw = new Uint8Array(0x17); // $FF10-$FF26分(オフセット0=$FF10)
      this.mute = { ch1: false, ch2: false, ch3: false, ch4: false };
      this.vol = { ch1: 1, ch2: 1, ch3: 1, ch4: 1 };
    }

    reset() {
      this.ch1 = new PulseChannel(true);
      this.ch2 = new PulseChannel(false);
      this.ch3 = new WaveChannel();
      this.ch4 = new NoiseChannel();
      this.powerOn = true;
      this.nr50 = 0x77;
      this.nr51 = 0xF3;
      this.frameSeqStep = 0;
      this.frameSeqCounter = 0;
      this.regRaw.fill(0);
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0xFF30 && addr <= 0xFF3F) { this.ch3.writeWaveRam(addr - 0xFF30, value); return; }
      if (addr < 0xFF10 || addr > 0xFF26) return;
      this.regRaw[addr - 0xFF10] = value;
      switch (addr) {
        case 0xFF10: this.ch1.writeNRx0(value); break;
        case 0xFF11: this.ch1.writeNRx1(value); break;
        case 0xFF12: this.ch1.writeNRx2(value); break;
        case 0xFF13: this.ch1.writeNRx3(value); break;
        case 0xFF14: this.ch1.writeNRx4(value); break;
        case 0xFF16: this.ch2.writeNRx1(value); break;
        case 0xFF17: this.ch2.writeNRx2(value); break;
        case 0xFF18: this.ch2.writeNRx3(value); break;
        case 0xFF19: this.ch2.writeNRx4(value); break;
        case 0xFF1A: this.ch3.writeNR30(value); break;
        case 0xFF1B: this.ch3.writeNR31(value); break;
        case 0xFF1C: this.ch3.writeNR32(value); break;
        case 0xFF1D: this.ch3.writeNR33(value); break;
        case 0xFF1E: this.ch3.writeNR34(value); break;
        case 0xFF20: this.ch4.writeNR41(value); break;
        case 0xFF21: this.ch4.writeNR42(value); break;
        case 0xFF22: this.ch4.writeNR43(value); break;
        case 0xFF23: this.ch4.writeNR44(value); break;
        case 0xFF24: this.nr50 = value; break;
        case 0xFF25: this.nr51 = value; break;
        case 0xFF26:
          this.powerOn = (value & 0x80) !== 0;
          if (!this.powerOn) {
            this.ch1.enabled = false; this.ch2.enabled = false;
            this.ch3.enabled = false; this.ch4.enabled = false;
          }
          break;
      }
    }

    readRegister(addr) {
      if (addr >= 0xFF30 && addr <= 0xFF3F) return this.ch3.readWaveRam(addr - 0xFF30);
      if (addr < 0xFF10 || addr > 0xFF26) return 0xFF;
      if (addr === 0xFF26) {
        let v = this.powerOn ? 0x80 : 0x00;
        if (this.ch1.enabled) v |= 0x01;
        if (this.ch2.enabled) v |= 0x02;
        if (this.ch3.enabled) v |= 0x04;
        if (this.ch4.enabled) v |= 0x08;
        return v | 0x70;
      }
      const off = addr - 0xFF10;
      return this.regRaw[off] | (READ_OR_MASK[off] || 0);
    }

    clockLength() { this.ch1.clockLength(); this.ch2.clockLength(); this.ch3.clockLength(); this.ch4.clockLength(); }
    clockSweep() { this.ch1.clockSweep(); }
    clockEnvelope() { this.ch1.envelope.clock(); this.ch2.envelope.clock(); this.ch4.envelope.clock(); }

    // 1 Tステート(4194304Hz)分進める
    clock() {
      this.ch1.clockTimer();
      this.ch2.clockTimer();
      this.ch3.clockTimer();
      this.ch4.clockTimer();

      // フレームシーケンサ: 512Hz(8192Tステートごと)の8ステップ。
      // step 0/2/4/6=長さカウンタ(256Hz)、2/6=スイープ(128Hz)、7=エンベロープ(64Hz)。
      this.frameSeqCounter++;
      if (this.frameSeqCounter >= 8192) {
        this.frameSeqCounter -= 8192;
        this.frameSeqStep = (this.frameSeqStep + 1) & 7;
        switch (this.frameSeqStep) {
          case 0: case 4: this.clockLength(); break;
          case 2: case 6: this.clockLength(); this.clockSweep(); break;
          case 7: this.clockEnvelope(); break;
        }
      }
    }

    /**
     * 現在の出力レベルを {left, right} で取得する(各-1.0〜1.0程度)。
     * GBのDACはNESの非線形ミキサーと異なりほぼ線形。NR51(パンニング)で各chをL/Rバスへ
     * 振り分け、NR50(マスター音量、0-7を実機同様+1して1-8倍のスケール)をバス毎に掛ける。
     * どちらのバスにも振られていないch(パン両ビット0)はここで正しく無音になる。
     * ★旧実装は最後にL/Rバスを平均してモノラル化していた(/2)。センター定位(両バスに
     * 乗っているch)ではleft=rightとなり平均しても値が変わらないため、単純にその/2を
     * 外すだけでモノラル時と同じ音量感を保ったままステレオ分離できる(片側のみに振られた
     * chは平均で半減していたのが、本来の片側フル音量に戻る形)。
     */
    mixSample() {
      const c1 = this.mute.ch1 ? 0 : this.ch1.output() * this.vol.ch1;
      const c2 = this.mute.ch2 ? 0 : this.ch2.output() * this.vol.ch2;
      const c3 = this.mute.ch3 ? 0 : this.ch3.output() * this.vol.ch3;
      const c4 = this.mute.ch4 ? 0 : this.ch4.output() * this.vol.ch4;
      const chans = [c1, c2, c3, c4];
      let left = 0, right = 0;
      for (let i = 0; i < 4; i++) {
        if ((this.nr51 >> (4 + i)) & 1) left += chans[i];
        if ((this.nr51 >> i) & 1) right += chans[i];
      }
      const volL = ((this.nr50 >> 4) & 0x07) + 1; // 1-8
      const volR = (this.nr50 & 0x07) + 1;
      return { left: (left * volL) / 8 / 60, right: (right * volR) / 8 / 60 };
    }
  }

  // NR51($FF25)の対応するchビットがL/R両方とも0なら、音量が非0でも実際は無音
  // (gbs2mml/expansion/pulse.js panAudible()と全く同じ式。ch=0-3がCH1-4)。
  function nr51Audible(nr51, ch) {
    return (((nr51 >> (4 + ch)) & 1) !== 0) || (((nr51 >> ch) & 1) !== 0);
  }

  // リアルタイム鍵盤表示用のライブスナップショット(snapshotAY8910/snapshotSCCと同じ考え方)。
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
    const nFreq = n.enabled ? 4194304 / (16 * NOISE_DIVISOR[n.divisorCode] * (1 << n.clockShift)) : 0;
    return {
      ch1: p(apu.ch1, 0),
      ch2: p(apu.ch2, 1),
      ch3: {
        freq: wFreq, vol: wVol, rawVol: w.volumeShift,
        waveData: Array.from(w.wave, v => v / 7.5 - 1), // 0-15(4bit符号無し) → -1..1
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

  Emu.APUGb = APUGb;
})(window);
