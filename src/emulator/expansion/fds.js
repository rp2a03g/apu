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
 *   $4088       : モジュレータテーブル書き込み (停止中のみ有効, 下位3bit)
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
      this.modPhaseAcc = 0;
      this.modTable = new Uint8Array(32); // 生3bit値 (0-7)
      this.modWritePos = 0;
      this.modTablePos = 0;   // 再生位置
      this.modCounter = 0;    // 現在のモジュレータ出力値 (-64..63)

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
      this.modTable = new Uint8Array(32);
      this.modWritePos = 0;
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
        if (!this.modEnabled) {
          // 停止時: 書き込み位置・再生位置・位相をリセット
          this.modPhaseAcc = 0;
          this.modWritePos = 0;
          this.modTablePos = 0;
        }
      } else if (addr === 0x4088) {
        // モジュレータ停止中にテーブルを書き込む (1エントリ = 3bit)
        if (!this.modEnabled) {
          this.modTable[this.modWritePos] = value & 0x07;
          this.modWritePos = (this.modWritePos + 1) & 0x1F;
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

      // モジュレータ: APUクロック(CPU/2)相当、オーバーフロー閾値 = 2 × 65536 = 131072
      // レジスタログ実測: modFreq=16 で 6.83 Hz ビブラート → 16×1789773/(32×131072)=6.83Hz ✓
      if (this.modEnabled && this.modFreq > 0) {
        this.modPhaseAcc += this.modFreq;
        while (this.modPhaseAcc >= 131072) {
          this.modPhaseAcc -= 131072;
          const raw = this.modTable[this.modTablePos];
          this.modTablePos = (this.modTablePos + 1) & 0x1F;
          if (raw === 4) {
            // リセット: カウンタを0に
            this.modCounter = 0;
          } else {
            this.modCounter += MOD_TABLE_DELTA[raw];
            // クランプ (-64..63)
            if (this.modCounter > 63) this.modCounter = 63;
            if (this.modCounter < -64) this.modCounter = -64;
          }
        }
      }

      // メインチャンネル
      if (this.disabled || this.freq === 0) return;

      // ピッチ変調: NESdev FDS audio 準拠の実機アルゴリズム
      //   1. temp = modCounter × modGain          （gain=$4084。gain=0なら変調ゼロ）
      //   2. 4bit右シフト(符号保持)、下位4bitに端数があり結果が非負なら+1(切り上げ)
      //   3. effectiveFreq = freq + freq × delta / 64
      // ★注意: 以前は「+0x400してから8bitマスク、-64」という手順で(2)(3)を行って
      // いたが、これは|temp|(=|modCounter×modGain|)が0x400(1024)未満の範囲でしか
      // 正しく機能しない近似で、modGainが大きくmodCounterが強く負に振れる(絶対値の
      // 積が1024を超える)と8bitマスクで符号が反転し、逆方向の桁違いなピッチになる
      // 深刻なバグだった(実測: modGain=32,modCounter=-64で本来delta=-128のところ
      // +128を返す)。Almana no Kiseki(FDS)2曲目でモジュレーション有効時に音痴に
      // なる不具合の原因。旧実装の校正根拠だったmodGain=16のケースはtemp>>4の結果が
      // ±64に収まるため両実装で一致し、回帰は無い。
      let effectiveFreq = this.freq;
      if (this.modEnabled) {
        const temp = this.modCounter * this.modGain;
        const rem = temp & 0x0F;
        let delta = temp >> 4; // 算術シフト(符号保持)。|temp|<=64*63なので32bit範囲内で安全
        if (rem !== 0 && delta >= 0) delta += 1;
        if (delta !== 0) {
          const bias = Math.round((delta * this.freq) / 64);
          effectiveFreq = Math.max(0, this.freq + bias);
        }
      }
      // 鍵盤表示等の外部参照用(実際に揺れているピッチをHz換算する際、$4082/4083の
      // 生の周期値ではなくこちらを使う。単位はthis.freqと同じ内部単位)
      this.effectiveFreq = effectiveFreq;

      this.phaseAcc += effectiveFreq;
      const cycleLen = 64 * 65536;
      if (this.phaseAcc >= cycleLen) this.phaseAcc -= cycleLen;
    }

    /**
     * 表示専用の早送り: 変調ユニットとエンベロープだけを cycles CPUサイクル分進め、その間の
     * 実効周波数(effectiveFreqと同じ内部単位)の平均/最小/最大を返す。音は作らない。
     * ピアノロール構築(src/ui/keyboard.js buildFdsModSnapshots)が writeLog から
     * 「フレーム内でピッチがどれだけ動いたか」を復元するのに使う。1フレーム=約29780サイクルを
     * clock()で1サイクルずつ回すと1曲で数億回になるため、STEP サイクル刻みの粗い歩進にしてある
     * (変調テーブルの歩進は最速でも32サイクルに1回なので、表示用には十分)。
     * ★clock() の変調/エンベロープ部分と同じ式。clock() を直したらここも必ず合わせること
     *   (tools不要の確認: 同じ書込みを与えて clock() 実測の平均/最小/最大と突き合わせる)。
     * @returns {{mean:number,min:number,max:number}|null} 発音していない/変調が効いていない間は null
     */
    advanceForDisplay(cycles) {
      const STEP = 16;
      const envPeriod = (this.envRate + 1) * 8;
      let sum = 0, n = 0, min = Infinity, max = -Infinity;
      for (let c = 0; c < cycles; c += STEP) {
        this.envRateClock += STEP;
        while (this.envRateClock >= envPeriod) { this.envRateClock -= envPeriod; this._clockEnvelope(); }
        if (this.modEnabled && this.modFreq > 0) {
          this.modPhaseAcc += this.modFreq * STEP;
          while (this.modPhaseAcc >= 131072) {
            this.modPhaseAcc -= 131072;
            const raw = this.modTable[this.modTablePos];
            this.modTablePos = (this.modTablePos + 1) & 0x1F;
            if (raw === 4) this.modCounter = 0;
            else {
              this.modCounter += MOD_TABLE_DELTA[raw];
              if (this.modCounter > 63) this.modCounter = 63;
              if (this.modCounter < -64) this.modCounter = -64;
            }
          }
        }
        if (this.disabled || this.freq === 0 || !this.modEnabled) continue;
        let eff = this.freq;
        const temp = this.modCounter * this.modGain;
        let delta = temp >> 4;
        if ((temp & 0x0F) !== 0 && delta >= 0) delta += 1;
        if (delta !== 0) eff = Math.max(0, this.freq + Math.round((delta * this.freq) / 64));
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
