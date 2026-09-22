/*
 * FDS (ディスクシステム) 拡張音源エミュレータ
 * MML.Emu.FDSAudio
 *
 * 64サンプル(6bit)のウェーブテーブル波形メモリ音源 + ボリュームエンベロープ + ピッチモジュレータ。
 *
 *   $4040-$407F : 波形メモリ(6bit, $4089 bit7=1 の間のみ書き込み可)
 *   $4080       : ボリュームエンベロープ (bit7=1:直接指定, bit6=方向, bits0-5=速度/ゲイン)
 *   $4082       : 周波数下位8bit
 *   $4083       : bits0-3=周波数上位4bit, bit6=エンベロープ停止, bit7=1で消音/波形リセット
 *   $4084       : モジュレータゲイン/エンベロープ (同形式)。ゲインはピッチ変調の深さを決める(0=変調なし)
 *   $4085       : モジュレータカウンタ直接設定 (7bit符号付き)
 *   $4086       : モジュレータ周波数下位8bit
 *   $4087       : bits0-3=モジュレータ周波数上位4bit, bit7=1で停止
 *   $4088       : モジュレータテーブル書き込み (停止中のみ有効, 下位3bit)。再生位置に書いて2ステップ進む
 *
 * 変調ユニットは NSFPlay 2.6 nes_fds.cpp(rainwarrior、実機検証済み)に合わせてある(2026-09-22)。
 * リファレンスWAV(NSFPlay、FDSのみ・LPF無し)との0.1秒窓スペクトル類似度で採点した。要点:
 *   - テーブルは32項目だが位置は64ステップ(1項目を2回ずつ)。16bitの端数アキュムレータ
 *   - カウンタは7bitで折り返す(63+1=-64)。クランプではない
 *   - 変調量 = counter×gain を >>4(端数があり結果のbit7が0なら 負:-1/正:+2 の丸め)、
 *     -64..191 へ8bit折り返し、×freq/64(四捨五入)。折り返しは実機の挙動で、深いFMでは
 *     周波数が搬送波の最大4倍まで跳ねる(Golf US Course 3秒目で実際に鳴っている音)
 *   - 変調式は $4087 で停止中も常に効く($4085 直書きのベンド)。停止はテーブルの歩進を
 *     止めて端数を0にするだけで、位置は保つ。$4088 は再生位置へ書く
 * 以前は「1項目1回・クランプ・折り返し無し(Math.max(0))・停止中は無効」で、深さが半分、
 * 深いFMで別の音になっていた。
 *   $4089       : bit7=波形メモリ書き込み許可, bits0-1=マスターボリューム
 *   $408A       : エンベロープ速度マスタ (0=最速, 値が大きいほど遅い)
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // NESdev 準拠: マスターボリューム 0=全量, 1=2/3, 2=2/4, 3=2/5
  const MASTER_VOLUME_SCALE = [1.0, 2 / 3, 2 / 4, 2 / 5];

  // モジュレータテーブルの3bitエントリをカウンタ増分に変換
  // 0=+0, 1=+1, 2=+2, 3=+4, 4=リセット(0), 5=-4, 6=-2, 7=-1
  const MOD_TABLE_DELTA = [0, 1, 2, 4, 0, -4, -2, -1];
  const MOD_STEPS = 64;                  // 変調テーブルの位置は64ステップ(32項目×2)
  const MOD_STEP_CYCLES = 65536;         // 1ステップ = 65536/modFreq CPUサイクル

  class FDSAudio {
    constructor() {
      this.wave = new Uint8Array(64);
      this.waveWriteEnable = false;
      this.masterVolume = 0;

      // ボリュームエンベロープ
      this.volEnvEnabled = false; // bit7=0 のとき有効
      this.volEnvIncrease = false; // bit6
      this.volEnvSpeed = 0;        // bits0-5 (リロード値)
      this.volGain = 32;           // 実際の出力ゲイン (0-32)
      this.volEnvTimer = 0;

      // メインチャンネル
      this.freq = 0;
      this.disabled = true;
      this.envHalt = false; // $4083 bit6
      this.phaseAcc = 0;
      this.effectiveFreq = 0; // モジュレーション適用後の実ピッチ(内部単位、鍵盤表示用)

      // モジュレータエンベロープ
      this.modEnvEnabled = false;
      this.modEnvIncrease = false;
      this.modEnvSpeed = 0;
      this.modGain = 32;
      this.modEnvTimer = 0;

      // モジュレータ
      this.modFreq = 0;
      this.modEnabled = false; // bit7=0 のとき有効
      this.modPhaseAcc = 0;               // 位置の端数(0..65535)
      this.modTable = new Uint8Array(MOD_STEPS); // 生3bit値 (0-7)。$4088 1回で2項目埋まる
      this.modTablePos = 0;   // 再生位置(0..63)。$4088 の書き込み位置も兼ねる
      this.modCounter = 0;    // 現在のモジュレータ出力値 (-64..63、7bit折り返し)

      // エンベロープマスタ速度レジスタ ($408A)
      // FDS 電源ON時デフォルト = $E8 = 232 (実機ハードウェア仕様)
      // ゲームが $408A を書かない場合もこの値が使われる
      this.envRate = 0xE8;
      this.envRateClock = 0;

      this.mute = { wave: false };
      this.vol = { wave: 1 };
    }

    reset() {
      this.wave = new Uint8Array(64);
      this.waveWriteEnable = false;
      this.masterVolume = 0;
      this.volEnvEnabled = false;
      this.volEnvIncrease = false;
      this.volEnvSpeed = 0;
      this.volGain = 32;
      this.volEnvTimer = 0;
      this.freq = 0;
      this.disabled = true;
      this.envHalt = false;
      this.phaseAcc = 0;
      this.effectiveFreq = 0;
      this.modEnvEnabled = false;
      this.modEnvIncrease = false;
      this.modEnvSpeed = 0;
      this.modGain = 32;
      this.modEnvTimer = 0;
      this.modFreq = 0;
      this.modEnabled = false;
      this.modPhaseAcc = 0;
      this.modTable = new Uint8Array(MOD_STEPS);
      this.modTablePos = 0;
      this.modCounter = 0;
      this.envRate = 0xE8; // FDS 電源ON時デフォルト
      this.envRateClock = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0x4040 && addr <= 0x407F) {
        if (this.waveWriteEnable) this.wave[addr - 0x4040] = value & 0x3F;
      } else if (addr === 0x4080) {
        if (value & 0x80) {
          // 直接指定モード: bits0-5 をゲインとして即時反映(6bit生値を保持。出力段で32に
          // 頭打ちするのはmixSample側。エンベロープ減衰は書かれた値から数え始めるため)
          this.volEnvEnabled = false;
          this.volGain = value & 0x3F;
        } else {
          // エンベロープモード
          this.volEnvEnabled = true;
          this.volEnvIncrease = (value & 0x40) !== 0;
          this.volEnvSpeed = value & 0x3F;
          this.volEnvTimer = this.volEnvSpeed + 1;
        }
      } else if (addr === 0x4082) {
        this.freq = (this.freq & 0x0F00) | value;
      } else if (addr === 0x4083) {
        this.freq = (this.freq & 0x00FF) | ((value & 0x0F) << 8);
        this.envHalt = (value & 0x40) !== 0;
        this.disabled = (value & 0x80) !== 0;
        if (this.disabled) this.phaseAcc = 0;
        if (this.envHalt) { this.volEnvTimer = this.volEnvSpeed + 1; this.modEnvTimer = this.modEnvSpeed + 1; }
      } else if (addr === 0x4084) {
        if (value & 0x80) {
          this.modEnvEnabled = false;
          this.modGain = value & 0x3F;
        } else {
          this.modEnvEnabled = true;
          this.modEnvIncrease = (value & 0x40) !== 0;
          this.modEnvSpeed = value & 0x3F;
          this.modEnvTimer = this.modEnvSpeed + 1;
        }
      } else if (addr === 0x4085) {
        // モジュレータカウンタを直接設定 (7bit符号付き)
        const v = value & 0x7F;
        this.modCounter = (v >= 64) ? (v - 128) : v;
      } else if (addr === 0x4086) {
        this.modFreq = (this.modFreq & 0x0F00) | value;
      } else if (addr === 0x4087) {
        this.modFreq = (this.modFreq & 0x00FF) | ((value & 0x0F) << 8);
        this.modEnabled = (value & 0x80) === 0;
        // 停止時は位置の端数だけ0にする(再生位置は保つ。変調式は停止中も効き続ける)
        if (!this.modEnabled) this.modPhaseAcc = 0;
      } else if (addr === 0x4088) {
        // モジュレータ停止中に、現在の再生位置へ1項目(=2ステップ分)書いて進める
        if (!this.modEnabled) {
          this.modTable[this.modTablePos] = value & 0x07;
          this.modTablePos = (this.modTablePos + 1) & (MOD_STEPS - 1);
          this.modTable[this.modTablePos] = value & 0x07;
          this.modTablePos = (this.modTablePos + 1) & (MOD_STEPS - 1);
        }
      } else if (addr === 0x4089) {
        this.waveWriteEnable = (value & 0x80) !== 0;
        this.masterVolume = value & 0x03;
      } else if (addr === 0x408A) {
        this.envRate = value;
        this.envRateClock = 0;
      }
    }

    // バス読み出し ($4090 = ボリュームエンベロープ出力, $4092 = モジュレータエンベロープ出力)
    readRegister(addr) {
      if (addr === 0x4090) return this.volGain & 0x3F;
      if (addr === 0x4092) return this.modGain & 0x3F;
      return 0;
    }

    // エンベロープを1ティック進める (エンベロープマスタ速度に応じて呼ばれる)
    _clockEnvelope() {
      if (this.disabled) return; // $4083 bit7=1 の間はどちらのエンベロープも進まない
      // ボリュームエンベロープ
      if (this.volEnvEnabled && !this.envHalt) {
        this.volEnvTimer--;
        if (this.volEnvTimer <= 0) {
          this.volEnvTimer = this.volEnvSpeed + 1;
          if (this.volEnvIncrease) {
            if (this.volGain < 32) this.volGain++;
          } else {
            if (this.volGain > 0) this.volGain--;
          }
        }
      }
      // モジュレータエンベロープ
      if (this.modEnvEnabled && !this.envHalt) {
        this.modEnvTimer--;
        if (this.modEnvTimer <= 0) {
          this.modEnvTimer = this.modEnvSpeed + 1;
          if (this.modEnvIncrease) {
            if (this.modGain < 32) this.modGain++;
          } else {
            if (this.modGain > 0) this.modGain--;
          }
        }
      }
    }

    clock() {
      // エンベロープクロック: NESdev "c = 8 * (e+1) * (m+1)" のm(マスタ速度)部分。
      // period = 8 * (envRate + 1) CPU サイクルに1回(envRate=0→8, envRate=$E8=232→1864 cycles)。
      // 旧実装は envRate×8 (envRate=0のみ特別扱い)で、envRate>0全域で周期が短すぎた
      // (envRate=1で本来16のところ8になる等、小さい値ほど相対誤差が大きいバグ)
      this.envRateClock++;
      const envPeriod = (this.envRate + 1) * 8;
      if (this.envRateClock >= envPeriod) {
        this.envRateClock = 0;
        this._clockEnvelope();
      }

      // モジュレータテーブルの歩進(1ステップ = 65536/modFreq サイクル、64ステップで1周。
      // レジスタログ実測: modFreq=16 で 6.83 Hz ビブラート → 16×1789773/(64×65536)=6.83Hz ✓)
      this._stepMod(1);

      // メインチャンネル
      if (this.disabled || this.freq === 0) return;
      // 鍵盤表示等の外部参照用(実際に揺れているピッチをHz換算する際、$4082/4083の
      // 生の周期値ではなくこちらを使う。単位はthis.freqと同じ内部単位)
      const effectiveFreq = this._modulatedFreq();
      this.effectiveFreq = effectiveFreq;
      this.phaseAcc = (this.phaseAcc + effectiveFreq) & 0x3FFFFF; // 64サンプル × 16bit端数
    }

    // 変調テーブルを cycles サイクル分歩進させる(停止中は進まない)
    _stepMod(cycles) {
      if (!this.modEnabled || this.modFreq === 0) return;
      this.modPhaseAcc += this.modFreq * cycles;
      while (this.modPhaseAcc >= MOD_STEP_CYCLES) {
        this.modPhaseAcc -= MOD_STEP_CYCLES;
        const raw = this.modTable[this.modTablePos];
        this.modTablePos = (this.modTablePos + 1) & (MOD_STEPS - 1);
        if (raw === 4) {
          this.modCounter = 0; // リセット
        } else {
          let c = this.modCounter + MOD_TABLE_DELTA[raw];
          if (c > 63) c -= 128; else if (c < -64) c += 128; // 7bit折り返し
          this.modCounter = c;
        }
      }
    }

    // 変調適用後の周波数(内部単位)。NSFPlay nes_fds.cpp の "complex mod calculation" と同じ式。
    // $4087 で停止中でも効く(カウンタは止まったまま = $4085 直書きの固定ベンド)
    _modulatedFreq() { return FDSAudio.modulatedFreq(this.freq, this.modCounter, this.modGain); }

    /**
     * 変調式そのもの(純関数)。freq=$4082/83 の12bit周期値、counter=モジュレータカウンタ(-64..63)、
     * gain=$4084 のゲイン。戻り値は変調後の周期値(内部単位、freq と同じ)。
     * nsf2mml($4085 直書きの固定ベンドを音符/Dへ落とす)からも使う。
     */
    static modulatedFreq(freq, counter, gain) {
      if (gain === 0 || counter === 0) return freq;
      let temp = counter * gain;
      const rem = temp & 0x0F;
      temp >>= 4; // 算術シフト(符号保持)
      if (rem > 0 && (temp & 0x80) === 0) temp += (counter < 0) ? -1 : 2;
      while (temp >= 192) temp -= 256; // 8bitの折り返し(-64..191)
      while (temp < -64) temp += 256;
      temp = freq * temp;
      const r2 = temp & 0x3F;
      temp >>= 6;
      if (r2 >= 32) temp += 1;
      return freq + temp; // temp >= -freq なので負にならない
    }

    /**
     * 表示専用の早送り: 変調ユニットとエンベロープだけを cycles CPUサイクル分進め、その間の
     * 実効周波数(effectiveFreqと同じ内部単位)の平均/最小/最大を返す。音は作らない。
     * ピアノロール構築(src/ui/keyboard.js buildFdsModSnapshots)が writeLog から
     * 「フレーム内でピッチがどれだけ動いたか」を復元するのに使う。1フレーム=約29780サイクルを
     * clock()で1サイクルずつ回すと1曲で数億回になるため、STEP サイクル刻みの粗い歩進にしてある
     * (変調テーブルの歩進は最速でも16サイクルに1回なので、表示用には十分)。
     * 歩進と変調式は clock() と同じ _stepMod / _modulatedFreq を使う(式の二重管理はしない)。
     * @returns {{mean:number,min:number,max:number}|null} 発音していない/変調が効いていない間は null
     */
    advanceForDisplay(cycles) {
      const STEP = 16;
      const envPeriod = (this.envRate + 1) * 8;
      let sum = 0, n = 0, min = Infinity, max = -Infinity;
      for (let c = 0; c < cycles; c += STEP) {
        const step = Math.min(STEP, cycles - c); // 端数を切り上げない(切り上げると clock() と位置がずれていく)
        this.envRateClock += step;
        while (this.envRateClock >= envPeriod) { this.envRateClock -= envPeriod; this._clockEnvelope(); }
        this._stepMod(step);
        if (this.disabled || this.freq === 0) continue;
        const eff = this._modulatedFreq();
        sum += eff; n++;
        if (eff < min) min = eff;
        if (eff > max) max = eff;
      }
      return n > 0 ? { mean: sum / n, min, max } : null;
    }

    mixSample() {
      if (this.disabled || this.mute.wave) return 0;
      const index = Math.floor(this.phaseAcc / 65536) % 64;
      const sample = this.wave[index] & 0x3F; // 0-63
      const centered = sample - 32; // -32..31
      // 実機の有効ゲインは32で頭打ち(33-63を書いても32相当。以前はクランプ漏れで最大約2倍
      // 大きく鳴っていた、2026-08-24)
      const volScale = Math.min(32, this.volGain) / 32;
      const masterScale = MASTER_VOLUME_SCALE[this.masterVolume & 0x03];
      // FDS 混合係数: NES 実機の抵抗網 (FDS=47Ω直列, 2A03=100Ω直列, 負荷=39Ω) から
      // FDS 出力は 2A03 の約 39% 程度に相当。係数 0.20 は実機バランスに合わせた値。
      return (centered / 32) * volScale * masterScale * 0.20 * this.vol.wave;
    }
  }

  Emu.FDSAudio = FDSAudio;
})(window);
