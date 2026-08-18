/*
 * VGM ヘッダ解析
 * MML.VGM
 *
 * VGM(Video Game Music)は 44100Hz サンプル単位のサウンドチップ・レジスタ書込みログ。
 * CPUエミュレーションは不要で、ヘッダのチップクロック表(非ゼロ=使用中)と
 * コマンドストリームだけで再生できる。仕様: https://vgmrips.net/wiki/VGM_Specification
 *
 * ★実ファイル(emu sound/vgm)で確認済みの罠(ROADMAP.md VGM節):
 *  - v1.50未満は 0x34(データ開始オフセット)が0 → 0x40固定。
 *  - v1.10未満は 0x28/0x2A(SN76489ノイズfeedback/シフト幅)が0 → Sega既定(0x0009/16)。
 *  - NES APUクロック(0x84)のbit31=FDS併用。全チップ共通でbit30=デュアルチップ。
 *  - .vgz(gzip)は呼び出し側で MML.Archive.gunzipIfNeeded() してから渡すこと
 *    (拡張子は当てにならないので先頭2バイトで判別する)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const VGM = MML.VGM = MML.VGM || {};

  VGM.SAMPLE_RATE = 44100;

  // チップクロックのヘッダオフセット表。id はエミュレータ配線(vgmPlayer.js)・
  // 鍵盤表示のキーとして使う。impl は現時点で実装済み(再生できる)かどうか。
  // 未実装チップはコマンドを読み飛ばすだけ(ROADMAP: 全チップ実装は不要)。
  VGM.CHIPS = [
    { id: 'sn76489',  name: 'SN76489',    offset: 0x0C, minVer: 0x100, impl: true },
    { id: 'ym2413',   name: 'YM2413',     offset: 0x10, minVer: 0x100, impl: true },
    { id: 'ym2612',   name: 'YM2612',     offset: 0x2C, minVer: 0x110, impl: true },
    { id: 'ym2151',   name: 'YM2151',     offset: 0x30, minVer: 0x110 },
    { id: 'segapcm',  name: 'SegaPCM',    offset: 0x38, minVer: 0x151 },
    { id: 'rf5c68',   name: 'RF5C68',     offset: 0x40, minVer: 0x151 },
    { id: 'ym2203',   name: 'YM2203',     offset: 0x44, minVer: 0x151 },
    { id: 'ym2608',   name: 'YM2608',     offset: 0x48, minVer: 0x151 },
    { id: 'ym2610',   name: 'YM2610/B',   offset: 0x4C, minVer: 0x151 },
    { id: 'ym3812',   name: 'YM3812',     offset: 0x50, minVer: 0x151 },
    { id: 'ym3526',   name: 'YM3526',     offset: 0x54, minVer: 0x151 },
    { id: 'y8950',    name: 'Y8950',      offset: 0x58, minVer: 0x151 },
    { id: 'ymf262',   name: 'YMF262',     offset: 0x5C, minVer: 0x151 },
    { id: 'ymf278b',  name: 'YMF278B',    offset: 0x60, minVer: 0x151 },
    { id: 'ymf271',   name: 'YMF271',     offset: 0x64, minVer: 0x151 },
    { id: 'ymz280b',  name: 'YMZ280B',    offset: 0x68, minVer: 0x151 },
    { id: 'rf5c164',  name: 'RF5C164',    offset: 0x6C, minVer: 0x151 },
    { id: 'pwm',      name: 'PWM',        offset: 0x70, minVer: 0x151 },
    { id: 'ay8910',   name: 'AY8910',     offset: 0x74, minVer: 0x151, impl: true },
    { id: 'gb',       name: 'GB DMG',     offset: 0x80, minVer: 0x161, impl: true },
    { id: 'nes',      name: 'NES APU',    offset: 0x84, minVer: 0x161, impl: true },
    { id: 'multipcm', name: 'MultiPCM',   offset: 0x88, minVer: 0x161 },
    { id: 'upd7759',  name: 'uPD7759',    offset: 0x8C, minVer: 0x161 },
    { id: 'okim6258', name: 'OKIM6258',   offset: 0x90, minVer: 0x161 },
    { id: 'okim6295', name: 'OKIM6295',   offset: 0x98, minVer: 0x161 },
    { id: 'k051649',  name: 'K051649',    offset: 0x9C, minVer: 0x161, impl: true },
    { id: 'k054539',  name: 'K054539',    offset: 0xA0, minVer: 0x161 },
    { id: 'huc6280',  name: 'HuC6280',    offset: 0xA4, minVer: 0x161, impl: true },
    { id: 'c140',     name: 'C140',       offset: 0xA8, minVer: 0x161 },
    { id: 'k053260',  name: 'K053260',    offset: 0xAC, minVer: 0x161 },
    { id: 'pokey',    name: 'Pokey',      offset: 0xB0, minVer: 0x161 },
    { id: 'qsound',   name: 'QSound',     offset: 0xB4, minVer: 0x161 },
    { id: 'scsp',     name: 'SCSP',       offset: 0xB8, minVer: 0x171 },
    { id: 'wswan',    name: 'WonderSwan', offset: 0xC0, minVer: 0x171 },
    { id: 'vsu',      name: 'VSU',        offset: 0xC4, minVer: 0x171 },
    { id: 'saa1099',  name: 'SAA1099',    offset: 0xC8, minVer: 0x171 },
    { id: 'es5503',   name: 'ES5503',     offset: 0xCC, minVer: 0x171 },
    { id: 'es5506',   name: 'ES5505/6',   offset: 0xD0, minVer: 0x171 },
    { id: 'x1_010',   name: 'X1-010',     offset: 0xD8, minVer: 0x171 },
    { id: 'c352',     name: 'C352',       offset: 0xDC, minVer: 0x171 },
    { id: 'ga20',     name: 'GA20',       offset: 0xE0, minVer: 0x171 },
    { id: 'mikey',    name: 'Mikey',      offset: 0xE4, minVer: 0x172 }
  ];

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  VGM.isVgm = function (bytes) {
    return bytes && bytes.length >= 0x40 && bytes[0] === 0x56 && bytes[1] === 0x67 && bytes[2] === 0x6d && bytes[3] === 0x20; // "Vgm "
  };

  // GD3タグ: "Gd3 " + version(4) + length(4) + UTF-16LE のNUL区切り文字列11本
  // (曲名英/日, ゲーム名英/日, システム名英/日, 作者英/日, 日付, ダンパー, メモ)
  function parseGd3(bytes, off) {
    if (off + 12 > bytes.length) return null;
    if (!(bytes[off] === 0x47 && bytes[off + 1] === 0x64 && bytes[off + 2] === 0x33 && bytes[off + 3] === 0x20)) return null;
    const len = u32(bytes, off + 8);
    const end = Math.min(bytes.length, off + 12 + len);
    const strs = [];
    let cur = '';
    for (let p = off + 12; p + 1 < end && strs.length < 11; p += 2) {
      const c = u16(bytes, p);
      if (c === 0) { strs.push(cur); cur = ''; }
      else cur += String.fromCharCode(c);
    }
    const g = (i) => strs[i] || '';
    return {
      trackEn: g(0), trackJa: g(1), gameEn: g(2), gameJa: g(3), systemEn: g(4), systemJa: g(5),
      authorEn: g(6), authorJa: g(7), date: g(8), dumper: g(9), notes: g(10)
    };
  }

  /**
   * @param {Uint8Array} bytes - 解凍済みVGM
   * @returns {object} header
   */
  VGM.parseHeader = function (bytes) {
    const magicOk = VGM.isVgm(bytes);
    if (!magicOk) return { magicOk: false };
    const version = u32(bytes, 0x08); // BCD (0x00000171 = 1.71)
    const eofOffset = u32(bytes, 0x04) + 0x04;
    const gd3Rel = u32(bytes, 0x14);
    const totalSamples = u32(bytes, 0x18);
    const loopRel = u32(bytes, 0x1C);
    const loopSamples = u32(bytes, 0x20);
    const rate = version >= 0x101 ? u32(bytes, 0x24) : 0;
    let dataOffset = version >= 0x150 ? u32(bytes, 0x34) : 0;
    dataOffset = dataOffset ? 0x34 + dataOffset : 0x40; // 0=旧形式(0x40固定)
    // ヘッダの実サイズ。古いバージョンはヘッダ末尾が0x40までしか無く、
    // それ以降のオフセットは「曲データ」なので、チップ表を読む時は必ず dataOffset 未満か確認する。
    const headerEnd = Math.min(dataOffset, bytes.length);
    const rd32 = (o) => (o + 4 <= headerEnd ? u32(bytes, o) : 0);

    const chips = {};
    const usedChips = [];
    for (const c of VGM.CHIPS) {
      if (version < c.minVer) continue;
      const raw = rd32(c.offset);
      if (!raw) continue;
      const clock = raw & 0x3FFFFFFF;
      const dual = !!(raw & 0x40000000);
      const flag31 = !!(raw & 0x80000000);
      if (!clock) continue;
      const info = { id: c.id, name: c.name, clock, dual, impl: !!c.impl };
      if (c.id === 'nes') info.fds = flag31;                 // bit31: FDS併用
      if (c.id === 'sn76489') info.t6w28 = flag31;           // bit31: T6W28(NGP)
      if (c.id === 'ym2612') info.ym3438 = flag31;
      if (c.id === 'ym2413') info.vrc7 = flag31;             // bit31: VRC7 (仕様上の互換フラグ)
      if (c.id === 'ay8910') {
        info.ayType = bytes[0x78];
        info.ayFlags = bytes[0x79];
      }
      if (c.id === 'k051649') info.sccPlus = flag31;         // bit31: SCC+ (K052539)
      chips[c.id] = info;
      usedChips.push(info);
    }

    // SN76489: v1.10未満はフィールド自体が無い(0)。Sega既定へフォールバック。
    let snFeedback = version >= 0x110 ? u16(bytes, 0x28) : 0;
    let snShiftWidth = version >= 0x110 ? bytes[0x2A] : 0;
    const snFlags = version >= 0x151 ? bytes[0x2B] : 0;
    if (!snFeedback) snFeedback = 0x0009;
    if (!snShiftWidth) snShiftWidth = 16;
    if (chips.sn76489) Object.assign(chips.sn76489, { feedback: snFeedback, shiftWidth: snShiftWidth, flags: snFlags });

    const volumeModifier = version >= 0x160 ? (bytes[0x7C] << 24 >> 24) : 0; // signed 8bit
    const loopBase = version >= 0x160 ? (bytes[0x7E] << 24 >> 24) : 0;
    const loopModifier = version >= 0x151 ? bytes[0x7F] : 0;

    // 拡張ヘッダ(v1.70+、0xBC): 2個目チップのクロック上書きと、チップ別音量。
    // 例: Exed Exes(Arcade)は AY8910 の音量 0x0028(=40/256≒16%) を指定しており、これを
    // 掛けないとAYが不釣り合いに大きく鳴る。
    // chip volume: chipId(bit7=2個目のチップ), flags, volume(16bit LE。bit15=0なら絶対値で
    // 0x100=100%、bit15=1なら相対倍率(0x100=1.0倍))
    const EXTRA_CHIP_IDS = {
      0x00: 'sn76489', 0x01: 'ym2413', 0x02: 'ym2612', 0x03: 'ym2151', 0x04: 'segapcm', 0x05: 'rf5c68',
      0x06: 'ym2203', 0x07: 'ym2608', 0x08: 'ym2610', 0x09: 'ym3812', 0x0A: 'ym3526', 0x0B: 'y8950',
      0x0C: 'ymf262', 0x0D: 'ymf278b', 0x0E: 'ymf271', 0x0F: 'ymz280b', 0x10: 'rf5c164', 0x11: 'pwm',
      0x12: 'ay8910', 0x13: 'gb', 0x14: 'nes', 0x15: 'multipcm', 0x16: 'upd7759', 0x17: 'okim6258',
      0x18: 'okim6295', 0x19: 'k051649', 0x1A: 'k054539', 0x1B: 'huc6280', 0x1C: 'c140', 0x1D: 'k053260',
      0x1E: 'pokey', 0x1F: 'qsound', 0x20: 'scsp', 0x21: 'wswan', 0x22: 'vsu', 0x23: 'saa1099',
      0x24: 'es5503', 0x25: 'es5506', 0x26: 'x1_010', 0x27: 'c352', 0x28: 'ga20'
    };
    const extra = { chipClocks: {}, chipVolumes: {} }; // chipVolumes[id or id+'_2'] = 倍率(1.0=100%)
    const extraRel = version >= 0x170 && dataOffset > 0xBC + 4 ? u32(bytes, 0xBC) : 0;
    if (extraRel) {
      const base = 0xBC + extraRel;
      const hdrSize = u32(bytes, base);
      const clkRel = hdrSize >= 8 ? u32(bytes, base + 4) : 0;
      const volRel = hdrSize >= 12 ? u32(bytes, base + 8) : 0;
      if (clkRel) {
        let p = base + 4 + clkRel;
        const n = bytes[p++];
        for (let i = 0; i < n && p + 5 <= bytes.length; i++, p += 5) {
          const id = EXTRA_CHIP_IDS[bytes[p] & 0x7F];
          if (id) extra.chipClocks[id] = u32(bytes, p + 1) & 0x3FFFFFFF;
        }
      }
      if (volRel) {
        let p = base + 8 + volRel;
        const n = bytes[p++];
        for (let i = 0; i < n && p + 4 <= bytes.length; i++, p += 4) {
          const id = EXTRA_CHIP_IDS[bytes[p] & 0x7F];
          const second = !!(bytes[p] & 0x80);
          const v = u16(bytes, p + 2);
          if (!id) continue;
          const key = second ? id + '_2' : id;
          extra.chipVolumes[key] = (v & 0x8000) ? (v & 0x7FFF) / 0x100 : v / 0x100;
        }
      }
    }

    const gd3Offset = gd3Rel ? 0x14 + gd3Rel : 0;
    const gd3 = gd3Offset ? parseGd3(bytes, gd3Offset) : null;

    return {
      magicOk: true,
      version,
      versionText: ((version >> 8) & 0xFF).toString(16) + '.' + ((version >> 4) & 0xF).toString(16) + (version & 0xF).toString(16),
      eofOffset,
      dataOffset,
      totalSamples,
      loopOffset: loopRel ? 0x1C + loopRel : 0,
      loopSamples,
      rate,           // 50/60(ヒント)。0=不明。時刻の正はサンプル累積のほう
      chips,          // id → info
      usedChips,      // 配列(ヘッダ順)
      volumeModifier, loopBase, loopModifier,
      volumeFactor: Math.pow(2, volumeModifier / 0x20), // 全体音量倍率(0x7C、v1.60+。0=等倍)
      extra,
      gd3,
      durationSeconds: totalSamples / VGM.SAMPLE_RATE,
      loopSeconds: loopSamples / VGM.SAMPLE_RATE
    };
  };

  // 表示用: GD3のトラック名(英優先、無ければ日)等
  VGM.displayTitle = function (h) {
    if (!h || !h.gd3) return '';
    return h.gd3.trackEn || h.gd3.trackJa || '';
  };
})(window);
