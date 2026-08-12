/*
 * GBS(Game Boy)実行用メモリバス
 * MML.Emu.GbsBus
 *
 * GBSはMBC1風の単一バンクレジスタ($2000-$3FFF書込、下位5bit、0は1として扱う)を
 * 前提にする(Game_Music_Emu等の実装に合わせた簡略MBC1)。$0000-$3FFFは常に固定
 * (loadAddr未満は未使用領域として0を返す)、$4000-$7FFFが切替バンク窓。
 * データストリームは「loadAddrから$8000まで」を固定+バンク1の内容とみなし、
 * それ以降を$4000バイト単位のバンク2,3,...として連結する設計
 * (ヘッダにバンク数やデータ長のフィールドが無いため、ファイルサイズから逆算する)。
 *
 * $FF10-$FF3Fの音源レジスタはapu(MML.Emu.APUGb)へ委譲する。
 * VRAM/SRAM/OAM/その他I/Oレジスタ(タイマ・LCD等)は実際には機能をエミュレートせず、
 * ドライバコードが暴走・クラッシュしないための単純な読み書き可能領域として確保するのみ
 * (gbsPlayer.jsがPLAYをサブルーチン直接呼び出しする簡略設計のため、実タイマ/割込
 * ハードウェアの精密な動作は不要。詳細はgbsPlayer.js冒頭コメント参照)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  class GbsBus {
    /**
     * @param {object} header - GBS.parseHeader() の結果
     * @param {Uint8Array} rom - ヘッダを除いた曲データ(header.dataOffset以降)
     */
    constructor(header, rom) {
      this.header = header;
      this.rom = rom;
      this.loadAddr = header.loadAddr;
      this.bankNum = 1; // 選択中バンク(実機同様5bit、0は1として扱う)
      this.apu = null; // gbsPlayer.jsが構築後にセットする
      this.onWrite = null; // (addr, value) => void。write-logキャプチャ用(gbs2mml向け)

      this.vram = new Uint8Array(0x2000); // $8000-$9FFF
      this.sram = new Uint8Array(0x2000); // $A000-$BFFF
      this.wram = new Uint8Array(0x2000); // $C000-$DFFF(エコー$E000-$FDFFも共有)
      this.oam = new Uint8Array(0xA0);    // $FE00-$FE9F
      this.io = new Uint8Array(0x80);     // $FF00-$FF7F(APU領域以外の雑多レジスタの下書き)
      this.hram = new Uint8Array(0x80);   // $FF80-$FFFE
      this.ie = 0;                        // $FFFF

      // RSTベクタ($0000-$0038、8バイト間隔で8個)パッチ。GBSファイルは実機のブートROM/
      // カートリッジヘッダを経由しないため、$0000-$(loadAddr-1)は本来ROMに存在しない
      // (romByte()がaddr<loadAddrで0を返す=常にNOP)。ドライバコードが`RST n`命令
      // (1バイトの省略呼出し、GBコードで多用される)を使うと、パッチが無いままではNOPの
      // 連続を空回りしながらloadAddr地点へ迷い込み、本来の呼び出し先とは無関係な
      // コードを誤実行してしまう(実測: CGB-BFTJ-JPN.gbsのRST $28[opcode 0xEF]が
      // PLAY中に複数回発行され、これが原因で音量計算が常に0になり無音化していた)。
      // Mesen2(GbsCart.h InitPlayback())と同じ方式で、各RSTベクタを
      // `JP loadAddr+i`(3バイト: 0xC3, lo, hi)へジャンプさせるコードで上書きする。
      this.vectorPatch = new Uint8Array(0x40);
      for (let i = 0; i <= 0x38; i += 8) {
        const target = (this.loadAddr + i) & 0xFFFF;
        this.vectorPatch[i]     = 0xC3; // JP nn
        this.vectorPatch[i + 1] = target & 0xFF;
        this.vectorPatch[i + 2] = (target >> 8) & 0xFF;
      }
    }

    reset() {
      this.bankNum = 1;
      this.vram.fill(0);
      this.sram.fill(0);
      this.wram.fill(0);
      this.oam.fill(0);
      this.io.fill(0);
      this.hram.fill(0);
      this.ie = 0;
    }

    romByte(addr) {
      if (addr < 0x40) return this.vectorPatch[addr]; // RSTベクタパッチ(コンストラクタ冒頭コメント参照)
      const L = this.loadAddr;
      if (addr < L) return 0; // loadAddr未満はROMデータの対象外
      if (addr < 0x4000) {
        const off = addr - L;
        return off < this.rom.length ? this.rom[off] : 0;
      }
      // $4000-$7FFF: bankNum=1は固定領域の直後(=バンク切替が無い曲の自然な続き)、
      // bankNum>=2はそれ以降を$4000バイト単位で連結したもの。
      const fixedLen = 0x4000 - L;
      const off = fixedLen + (this.bankNum - 1) * 0x4000 + (addr - 0x4000);
      return off < this.rom.length ? this.rom[off] : 0;
    }

    read(addr) {
      addr &= 0xFFFF;
      if (addr < 0x8000) return this.romByte(addr);
      if (addr < 0xA000) return this.vram[addr - 0x8000];
      if (addr < 0xC000) return this.sram[addr - 0xA000];
      if (addr < 0xE000) return this.wram[addr - 0xC000];
      if (addr < 0xFE00) return this.wram[addr - 0xE000]; // エコーRAM
      if (addr < 0xFEA0) return this.oam[addr - 0xFE00];
      if (addr < 0xFF00) return 0xFF; // 未使用領域
      if (addr < 0xFF80) {
        if (addr >= 0xFF10 && addr <= 0xFF3F && this.apu) return this.apu.readRegister(addr);
        return this.io[addr - 0xFF00];
      }
      if (addr < 0xFFFF) return this.hram[addr - 0xFF80];
      return this.ie;
    }

    write(addr, value) {
      addr &= 0xFFFF; value &= 0xFF;
      if (this.onWrite) this.onWrite(addr, value);
      if (addr >= 0x2000 && addr < 0x4000) {
        let n = value & 0x1F;
        if (n === 0) n = 1;
        this.bankNum = n;
        return;
      }
      if (addr < 0x8000) return; // その他のROM領域書込は無視(GBSは単純MBC1のみ対象)
      if (addr < 0xA000) { this.vram[addr - 0x8000] = value; return; }
      if (addr < 0xC000) { this.sram[addr - 0xA000] = value; return; }
      if (addr < 0xE000) { this.wram[addr - 0xC000] = value; return; }
      if (addr < 0xFE00) { this.wram[addr - 0xE000] = value; return; }
      if (addr < 0xFEA0) { this.oam[addr - 0xFE00] = value; return; }
      if (addr < 0xFF00) return;
      if (addr < 0xFF80) {
        if (addr >= 0xFF10 && addr <= 0xFF3F && this.apu) { this.apu.writeRegister(addr, value); return; }
        this.io[addr - 0xFF00] = value;
        return;
      }
      if (addr < 0xFFFF) { this.hram[addr - 0xFF80] = value; return; }
      this.ie = value;
    }
  }

  Emu.GbsBus = GbsBus;
})(window);
