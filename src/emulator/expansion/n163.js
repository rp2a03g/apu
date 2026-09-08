/*
 * N163 (Namco 163) 拡張音源エミュレータ
 * MML.Emu.N163Audio
 *
 * 128バイト内部RAMにチャンネルレジスタ($40-$7F)と波形データを保持する
 * ウェーブテーブル音源(最大8チャンネル)。
 *
 *   $F800 : 内部RAMアドレス設定 (bit7=1で$4800書き込み毎にオートインクリメント)
 *   $4800 : 現在のアドレスへデータ書き込み
 *
 * チャンネル ch(0-7) のレジスタは RAM (0x40 + ch*8) の8バイト (インターリーブ配置):
 *   +0 周波数 Low   +2 周波数 Mid   +4 周波数 High(bit0-1) | 波形長(bit2-7)
 *   +1 位相 Low     +3 位相 Mid     +5 位相 High   (24bit位相アキュムレータ, RAMに格納)
 *   +6 波形アドレス(4bitサンプル単位)
 *   +7 音量(bit0-3) | 有効ch数(bit4-6, $7Fのみ)
 * 周波数=18bit, 波形長 length = 256 - (+4 & 0xFC) サンプル(4-256)。
 * 波形は4bitサンプルを1バイトに2つ(リトルエンディアン)格納。
 * 有効チャンネルは上位 (($7F>>4)&7)+1 個で、15 CPUサイクルごとに1chずつ巡回更新される。
 * 出力周波数 f = CPU * freq / (15 * 65536 * length * numChannels)。
 *
 * 注: 実機は freq/phase をインターリーブ配置。ドライバは freq を +0/+2/+4 に書き、
 *     間の位相バイト +1/+3/+5 を LDA $4800 で「読み飛ばし」て保存する(読み出しも
 *     オートインクリメントするのを利用)。Rolling Thunder のCPUトレースで確定。
 *
 * 注2: 波形長は NESdev Wiki 準拠で bit2-7 の6bit(4-256サンプル, length=256-(+4&0xFC))。
 *     これが標準の N163 挙動(NSFPlay/Mesen/VirtuaNSF既定と同じ)。ただし「古いドライバ」で
 *     作られた一部NSF(例: Famicompo mini vol.3 entry023)は波形長を最大32サンプル前提で
 *     使っており、256版だと音程・波形テーブルが崩れる。VirtuaNSFはこれ用に「N163を32サンプル
 *     に制限するモード」を別途用意している(readme 1.0.7.1)。
 *     → legacyWaveLen=true で対応(2026-09-07)。旧ドライバは +4 に (n<<2)|$80 を書く
 *     (VirtuaNES 0.97 の APU_N106: tonelen = 0x20-(data&0x1C))。VirtuaNESの周波数式は
 *     実機式と同じ f = CPU*freq/(15*65536*length*numCh) なので、違いは波形長の解釈だけ。
 *     そこで「+4 への書き込み値を現行エンコードへ書き換えて RAM に置く」方式にした:
 *       (v & 0x1F) | 0xE0   … 256-(0xE0|(n<<2)) = 32-4n = 0x20-(v&0x1C) と同じ長さ
 *     RAM 自体が現行仕様の値になるため、音声合成・鍵盤/ロール(snapshotN163)・
 *     nsf2mml の波形抽出・n163Snapshots 経由の再生(NsfReplayStreamPlayer)が全て
 *     無変更で正しくなる。判定は MML.NSF.detectLegacyN163Driver(nsfBus.js から設定)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CHANNELS = 8;
  const UPDATE_CYCLES = 15; // 1チャンネル更新に要するCPUサイクル

  class N163Audio {
    constructor() {
      this.ram = new Uint8Array(128);
      this.addr = 0;
      this.autoInc = false;
      this.updateCounter = 0; // 15CPUサイクルごとに1ch更新
      this.rrIndex = 0;       // 有効ch内の巡回位置
      this.mute = new Array(NUM_CHANNELS).fill(false);
      this.vol = new Array(NUM_CHANNELS).fill(1);
      // 旧ppmckドライバ(波形長32サンプル形式)互換。true のとき +4 レジスタへの書き込みを
      // 現行エンコードへ変換して格納する(ファイル冒頭コメント 注2 参照)。
      this.legacyWaveLen = false;
    }

    reset() {
      this.ram = new Uint8Array(128);
      this.addr = 0;
      this.autoInc = false;
      this.updateCounter = 0;
      this.rrIndex = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr === 0xF800) {
        this.addr = value & 0x7F;
        this.autoInc = (value & 0x80) !== 0;
      } else if (addr === 0x4800) {
        // 旧ドライバ互換: チャンネルレジスタ +4(波形長|周波数上位)への書き込みは
        // bit2-4 の3bit波形長(0x20-(v&0x1C))を現行の6bit形式(0xE0|(v&0x1C))へ変換する。
        // 周波数上位2bit(bit0-1)はそのまま。
        if (this.legacyWaveLen && this.addr >= 0x40 && (this.addr & 7) === 4) {
          value = (value & 0x1F) | 0xE0;
        }
        this.ram[this.addr] = value;
        if (this.autoInc) this.addr = (this.addr + 1) & 0x7F;
      }
    }

    // $4800 読み出し: 現在のアドレスの内部RAMを返し、オートインクリメント時はアドレスも進める。
    // (書き込みとアドレス/オートインクリメントを共有。実機同様、読み出しでもインクリメント。
    //  ※ ストア命令の空読みはCPU側で抑止済み。ここに来るのは真の LDA $4800 のみ)
    readData() {
      const v = this.ram[this.addr];
      if (this.autoInc) this.addr = (this.addr + 1) & 0x7F;
      return v;
    }

    numChannels() {
      return ((this.ram[0x7F] >> 4) & 0x07) + 1;
    }

    // ch(0-7, 7=$78が最上位)を1回更新: 位相を進めてRAM(+1/+3/+5)へ書き戻す
    _updateChannel(ch) {
      const base = 0x40 + ch * 8;
      const ram = this.ram;
      const freq = ram[base] | (ram[base + 2] << 8) | ((ram[base + 4] & 0x03) << 16);
      const length = 256 - (ram[base + 4] & 0xFC); // 4-256 サンプル
      let phase = ram[base + 1] | (ram[base + 3] << 8) | (ram[base + 5] << 16);
      phase = (phase + freq) % (length * 0x10000);
      ram[base + 1] = phase & 0xFF;
      ram[base + 3] = (phase >> 8) & 0xFF;
      ram[base + 5] = (phase >> 16) & 0xFF;
    }

    // ch の現在の出力サンプル(0-15)。位相上位8bitで波形を索引。
    _sample(ch) {
      const base = 0x40 + ch * 8;
      const ram = this.ram;
      const length = 256 - (ram[base + 4] & 0xFC);
      const phase = ram[base + 1] | (ram[base + 3] << 8) | (ram[base + 5] << 16);
      const sampleIndex = (phase >> 16) % length;
      const nibbleAddr = (ram[base + 6] + sampleIndex) & 0xFF; // 波形アドレスは4bitサンプル単位
      const byte = ram[(nibbleAddr >> 1) & 0x7F];
      return (nibbleAddr & 1) ? ((byte >> 4) & 0x0F) : (byte & 0x0F);
    }

    clock() {
      // 実機は15 CPUサイクルで1チャンネルを更新・出力し、有効ch(上位num個)を巡回する。
      if (++this.updateCounter < UPDATE_CYCLES) return;
      this.updateCounter = 0;
      const num = this.numChannels();
      this.rrIndex = (this.rrIndex + 1) % num;
      this._updateChannel((NUM_CHANNELS - num) + this.rrIndex);
    }

    mixSample() {
      const num = this.numChannels();
      let sum = 0;
      for (let ch = NUM_CHANNELS - num; ch < NUM_CHANNELS; ch++) {
        if (this.mute[ch]) continue;
        const volume = this.ram[0x40 + ch * 8 + 7] & 0x0F;
        sum += (this._sample(ch) - 8) * volume * this.vol[ch]; // -120..105
      }
      // 時間多重出力の可聴成分は有効ch平均。120で正規化してゲイン。
      // ゲインは他チップとのバランスで調整(0.8→0.3で全体を半分以下に下げた)。
      return (sum / num / 120) * 0.5;
    }
  }

  // 鍵盤表示用: 128バイトRAMから各チャンネルの freq/vol/波形 スナップショットを作る。
  // 表示スロット i(0..7) → ハードウェアch (7-i)。有効なのは上位 numCh 個($78が常にN1)。
  // 事前キャプチャ(writeLogから復元したRAM)・リアルタイム(ライブチップのRAM)双方から使う。
  Emu.snapshotN163 = function (ram) {
    const CPU = 1789773;
    const sampleAt = (a) => (ram[(a >> 1) & 0x7F] >> ((a & 1) * 4)) & 0x0F;
    const numCh = ((ram[0x7F] >> 4) & 7) + 1;
    const channels = [];
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const ch = 7 - i;
      const base = 0x40 + ch * 8;
      const f18 = ram[base] | (ram[base + 2] << 8) | ((ram[base + 4] & 0x03) << 16);
      const length = 256 - (ram[base + 4] & 0xFC);
      const rawVol = ram[base + 7] & 0x0F;
      const vol = rawVol / 15;
      const freq = f18 > 0 ? f18 * CPU / (15 * 65536 * length * numCh) : 0;
      const waveData = new Array(length);
      for (let k = 0; k < length; k++) waveData[k] = (sampleAt((ram[base + 6] + k) & 0xFF) - 8) / 8;
      channels.push({ freq, vol, rawVol, active: (i < numCh) && vol > 0 && freq > 0, waveData });
    }
    return { channels, numCh };
  };

  Emu.N163Audio = N163Audio;
})(window);
