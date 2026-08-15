/*
 * HuC6280内蔵PSG (PC Engine/TurboGrafx-16 プログラマブルサウンドジェネレータ) エミュレータ
 * MML.Emu.APUHuC6280
 *
 * 6チャンネル、各chが32サンプル・5bit符号無しの波形メモリを持つ(waveform playback)。
 * ch4/5のみノイズ生成機能を追加で持つ(bit7=noise on/offでch毎に波形出力とノイズ出力が
 * 排他)。各chは「Direct D/A」モードに切替可能(波形メモリ経由せず書込み値を直接出力、
 * 音声ストリーミング再生に使う)。LFO(周波数変調、ch0をch1のFM変調)は実機に存在するが
 * 音楽ドライバでの利用例が乏しく、参考実装(Game_Music_Emu)も自ら「未対応」と明記している
 * 機能のため本実装でも対象外とする。
 *
 * 参考: "PC Engine Hardware: PSG" by Paul Clifford (magicengine.com/mkit) — レジスタ配置・
 *   周波数換算式($0802/0803, $0807)の一次資料。ボリューム/バランスの対数合成式は実測に
 *   基づく独自導出(32段・約1.5dB/stepの減衰特性という文献記載の"事実"から関数化した
 *   ものであり、既存実装のテーブルを転記したものではない。詳細はgainFromIndex参照)。
 *
 * clock() を PSGクロック(3579545Hz。NTSCカラーバースト、HES.PSG_CLOCK)ごとに1回呼び出す
 * 設計(apu2a03.js/apuGb.jsと同じ考え方)。マスタークロック(7159090Hz)側のCPUと同期させる
 * hesPlayer.js は、CPU 2サイクルにつきPSG clock()を1回、という比で駆動する
 * (7159090 / 3579545 = 2ちょうど)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const WAVE_LEN = 32;
  const CH_COUNT = 6;

  // 32段(0-31)の対数ゲインテーブル。文献記載の「~1.5dB/step、31=1.0倍、0=無音」という
  // 減衰特性から作る(2^((n-31)/4) は 4step=6dB=電圧半減 の等比数列。1step≒1.505dB相当で
  // 文献の記述と整合する)。
  function gainFromIndex(n) {
    n = Math.max(0, Math.min(31, n | 0));
    return n === 0 ? 0 : Math.pow(2, (n - 31) / 4);
  }

  class PsgChannel {
    constructor(hasNoise) {
      this.hasNoise = !!hasNoise;
      this.wave = new Uint8Array(WAVE_LEN);
      this.wavePos = 0;    // 読出/書込 共有ポインタ(実機仕様、wavePlayback.js冒頭コメント参照)
      this.freq = 0;       // 12bit周期レジスタ($0802/$0803)
      this.control = 0;    // $0804: bit7=ch on, bit6=DDA, bit4-0=volume
      this.balance = 0xFF; // $0805: bit7-4=left, bit3-0=right
      this.dac = 0;        // DDAモード時の直接出力値(0-31)
      this.noiseCtrl = 0;  // $0807 (ch4/5のみ有効): bit7=on, bit4-0=noise period select
      this.lfsr = this.hasNoise ? 1 : 0;
      this.wavePhaseAcc = 0;  // PSGクロック単位の波形読出しタイマ(小数を持たず整数カウントダウン)
      this.noisePhaseAcc = 0;
      this.noiseOut = 0; // ノイズLFSRの現在ビット(0/1)由来の出力値(0 or 31)
    }

    reset() {
      this.wave.fill(0);
      this.wavePos = 0;
      this.freq = 0;
      this.control = 0;
      this.balance = 0xFF;
      this.dac = 0;
      this.noiseCtrl = 0;
      this.lfsr = this.hasNoise ? 1 : 0;
      this.wavePhaseAcc = 0;
      this.noisePhaseAcc = 0;
      this.noiseOut = 0;
    }

    get on() { return (this.control & 0x80) !== 0; }
    get dda() { return (this.control & 0x40) !== 0; }
    get volume() { return this.control & 0x1F; }

    writeControl(value) {
      // DDAモードが1→0へ落ちた瞬間、波形の読出/書込ポインタが先頭へリセットされる
      // (実機仕様。$0806での波形テーブル再ロードを先頭から行うための挙動)。
      if ((this.control & 0x40) && !(value & 0x40)) this.wavePos = 0;
      this.control = value;
    }

    writeData(value) {
      value &= 0x1F;
      if (!this.dda) {
        this.wave[this.wavePos] = value;
        this.wavePos = (this.wavePos + 1) & (WAVE_LEN - 1);
      } else if (this.on) {
        this.dac = value;
      }
    }

    // PSGクロック1tickぶん波形読出し位相・ノイズ位相を進める。HesReplayStreamPlayer
    // (src/audio/hes-stream-player.js)のリアルタイム再生が1サンプルあたり数十回
    // 直接呼ぶホットパスのため、clockBy(1)経由(関数呼出しが1段増える)にはせず
    // 従来通りその場で計算する(clockBy()と結果は数学的に同一)。
    clock() {
      if (this.on && !this.dda && this.freq > 0) {
        this.wavePhaseAcc++;
        if (this.wavePhaseAcc >= this.freq) {
          this.wavePhaseAcc = 0;
          this.wavePos = (this.wavePos + 1) & (WAVE_LEN - 1);
        }
      }
      if (this.hasNoise && this.on && (this.noiseCtrl & 0x80)) {
        const invVal = Math.max(1, (~this.noiseCtrl) & 0x1F);
        const periodTicks = invVal * 64;
        this.noisePhaseAcc++;
        if (this.noisePhaseAcc >= periodTicks) {
          this.noisePhaseAcc -= periodTicks;
          const bit = (this.lfsr & 1) ^ ((this.lfsr >> 3) & 1);
          this.lfsr = ((this.lfsr >> 1) | (bit << 16)) & 0x1FFFF;
          this.noiseOut = (this.lfsr & 1) ? 31 : 0;
        }
      }
    }

    // clock()のnティック分バッチ版(数学的にclock()をn回呼ぶのと同値)。
    // リアルタイム再生時の「がくがく」対策(hesBus.js clockBy()と同じ理由。
    // hesPlayer.js renderFrame()冒頭コメント参照)。波形位相(wavePhaseAcc)は単純な
    // 折り返しカウンタなので割り算でO(1)に飛ばせる。ノイズのLFSRは1tickごとの
    // シフト演算(状態遷移)そのものが出力なので数学的に一括計算はできないが、
    // 1オーディオサンプルあたりの折り返し回数は周期が最速でも64tickなので
    // (n≈162tick/サンプルに対し)たかだか数回で済み、単純ループのままで十分軽い。
    clockBy(n) {
      if (n <= 0) return;
      if (this.on && !this.dda && this.freq > 0) {
        // period=0は「無限に長い周期」= 実質フリーズ(0除算回避、聴感上ほぼ無音相当)。
        const period = this.freq;
        let acc = this.wavePhaseAcc + n;
        if (acc >= period) {
          const steps = Math.floor(acc / period);
          acc -= steps * period;
          this.wavePos = (this.wavePos + steps) & (WAVE_LEN - 1);
        }
        this.wavePhaseAcc = acc;
      }
      if (this.hasNoise && this.on && (this.noiseCtrl & 0x80)) {
        // 周波数式(文献): freq = PSG_CLOCK / (64 * (5bit値 XOR 31))。生値31(XOR後0)は
        // 0除算になるため最小周期1として扱う(実機は最高速のはず、という近似)。
        const invVal = Math.max(1, (~this.noiseCtrl) & 0x1F);
        const periodTicks = invVal * 64;
        let acc = this.noisePhaseAcc + n;
        if (acc >= periodTicks) {
          const steps = Math.floor(acc / periodTicks);
          acc -= steps * periodTicks;
          // 1bit LFSR(周期性が明確な単純フィボナッチ型)。実機の正確なタップ位置は資料が
          // 無いため、聴感上の「ホワイトノイズらしさ」を優先した17bit LFSR(タップ0,3)を採用
          // (2A03/GBのノイズと同種の近似。正確な多項式はハードウェア未公開)。
          for (let s = 0; s < steps; s++) {
            const bit = (this.lfsr & 1) ^ ((this.lfsr >> 3) & 1);
            this.lfsr = ((this.lfsr >> 1) | (bit << 16)) & 0x1FFFF;
          }
          this.noiseOut = (this.lfsr & 1) ? 31 : 0;
        }
        this.noisePhaseAcc = acc;
      }
    }

    // 現在の生サンプル値(0-31)
    rawSample() {
      if (!this.on) return 0;
      if (this.dda) return this.dac;
      if (this.hasNoise && (this.noiseCtrl & 0x80)) return this.noiseOut;
      return this.wave[this.wavePos];
    }

    // (left, right) の実効ゲイン(0.0-1.0)を返す。$0805(ch balance)と全体balanceを
    // 減算合成する(文献の"vol = chVol - 60、L = vol + chL*2 + gL*2"という式を再構成)。
    gainLR(globalBalance) {
      const vol = this.volume - 0x1E * 2;
      const lPan = (this.balance >> 4) & 0x0F, rPan = this.balance & 0x0F;
      const gL = (globalBalance >> 4) & 0x0F, gR = globalBalance & 0x0F;
      const left = Math.max(0, vol + lPan * 2 + gL * 2);
      const right = Math.max(0, vol + rPan * 2 + gR * 2);
      return { left: gainFromIndex(left), right: gainFromIndex(right) };
    }
  }

  class APUHuC6280 {
    constructor() {
      this.ch = [];
      for (let i = 0; i < CH_COUNT; i++) this.ch.push(new PsgChannel(i >= 4));
      this.selected = 0;   // $0800: 操作対象ch(bit2-0)
      this.balance = 0xFF; // $0801: 全体バランス
      this.mute = { ch0: false, ch1: false, ch2: false, ch3: false, ch4: false, ch5: false };
      this.vol = { ch0: 1, ch1: 1, ch2: 1, ch3: 1, ch4: 1, ch5: 1 };
    }

    reset() {
      for (const c of this.ch) c.reset();
      this.selected = 0;
      this.balance = 0xFF;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      switch (addr) {
        case 0x0800: this.selected = value & 0x07; return;
        case 0x0801: this.balance = value; return;
      }
      if (this.selected >= CH_COUNT) return; // ch6/7は存在しない(書込みは無視)
      const c = this.ch[this.selected];
      switch (addr) {
        case 0x0802: c.freq = (c.freq & 0xF00) | value; return;
        case 0x0803: c.freq = (c.freq & 0x0FF) | ((value & 0x0F) << 8); return;
        case 0x0804: c.writeControl(value); return;
        case 0x0805: c.balance = value; return;
        case 0x0806: c.writeData(value); return;
        case 0x0807: c.noiseCtrl = value; return;
        // 0x0808/0x0809 = LFO周波数/制御。冒頭コメントの通り本実装では対象外(無視のみ)。
        default: return;
      }
    }

    readRegister(addr) {
      // PSGは基本ライトオンリー(実機もリードは未定義動作に近い)。読み出し依存の曲は
      // 想定しないため0を返す(hesBus.js側で他I/Oと衝突しないよう明示的にここへ来る)。
      return 0;
    }

    // PSGクロック(3579545Hz)ごとに1回呼ぶ
    clock() {
      for (const c of this.ch) c.clock();
    }

    // clock()のnティック分バッチ版。hesPlayer.js renderFrame()から使う(冒頭コメント参照)。
    clockBy(n) {
      for (const c of this.ch) c.clockBy(n);
    }

    /**
     * 現在の出力レベルを {left, right}(概ね-1.0〜1.0)で返す。6ch分のL/Rゲイン付き
     * サンプルをそれぞれのバスへ合算して正規化する。基準は「0-31を中心±15.5とみなした
     * 振幅×ゲイン」の合計を6ch分見込んだスケール。
     * ★旧実装は(left+right)*0.5でモノラル化していた。センター定位(gainLRがleft=rightを
     * 返すch)では平均してもモノラル値と一致するため、L/Rを別々に積むだけでモノラル時と
     * 同じ音量感を保ったままステレオ分離できる。
     */
    mixSample() {
      let sumL = 0, sumR = 0;
      for (let i = 0; i < CH_COUNT; i++) {
        if (this.mute['ch' + i]) continue;
        const c = this.ch[i];
        const raw = (c.rawSample() - 16) * this.vol['ch' + i]; // 0-31を中心0付近へ(±16相当)
        const { left, right } = c.gainLR(this.balance);
        sumL += raw * left;
        sumR += raw * right;
      }
      return { left: sumL / (16 * CH_COUNT), right: sumR / (16 * CH_COUNT) };
    }

    /**
     * mixSample()と同じ正規化(6ch分を単純合算するとmixSample()の返す値に一致する)で、
     * 6chぶんを合算せず個別の配列で返す。hes-stream-player.js HesBufferedPlayerが
     * 「chごとに別々のAudioBufferチャンネルへ書き出し、再生をリアルタイムミュート
     * できるようにする」ために使う(mixSample()は合算済みで後からミュートできないため)。
     * mute(this.mute)はここでは見ない — ミュートは録音後にGainNodeで即時に効かせる設計
     * (録音時にミュートを焼き込むと、再生中のミュート切替に再レンダリングが必要になり
     * 本末転倒なため)。
     */
    mixChannelSamples() {
      const result = new Array(CH_COUNT);
      for (let i = 0; i < CH_COUNT; i++) {
        const c = this.ch[i];
        const raw = c.rawSample() - 16;
        const { left, right } = c.gainLR(this.balance);
        result[i] = (raw * (left + right) * 0.5) / (16 * CH_COUNT);
      }
      return result;
    }
  }

  // 鍵盤表示/ロール用ライブスナップショット(snapshotGbApu等と同じ考え方)。
  // panL/panR: $0805(chバランス)の上位/下位ニブル(0-15、鍵盤表示のL/R列用)。
  // 戻り値の配列自体にglobalPanL/globalPanR($0801、全体バランス)も生やしておく
  // (main.js liveHesApu()参照。ch単位ではないため配列要素にはせず配列のプロパティとして持たせる)。
  Emu.snapshotHuC6280Apu = function (apu) {
    const arr = apu.ch.map((c, i) => {
      const freqHz = (c.on && !c.dda && c.freq > 0) ? MML.HES.PSG_CLOCK / (32 * c.freq) : 0;
      const noiseOn = c.hasNoise && c.on && (c.noiseCtrl & 0x80) !== 0;
      return {
        on: c.on, dda: c.dda, noiseOn,
        freq: freqHz, vol: c.volume / 31, rawVol: c.volume,
        wave: Array.from(c.wave, v => v / 15.5 - 1),
        active: c.on && c.volume > 0 && (c.dda || noiseOn || freqHz > 0),
        panL: (c.balance >> 4) & 0x0F, panR: c.balance & 0x0F
      };
    });
    arr.globalPanL = (apu.balance >> 4) & 0x0F;
    arr.globalPanR = apu.balance & 0x0F;
    return arr;
  };

  Emu.APUHuC6280 = APUHuC6280;
  Emu.APUHuC6280_CH_COUNT = CH_COUNT;
  Emu.APUHuC6280_WAVE_LEN = WAVE_LEN;
})(window);
