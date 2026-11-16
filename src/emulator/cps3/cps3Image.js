/*
 * CP システム III の入力ファイルの見分けと取り出し。MML.Emu.Cps3.Image
 * DESIGN-CPS3-CAPTURE.md §2.2、§10。
 *
 *   ゲーム CD のイメージ(.bin。MODE1/2352 か 2048 バイト/セクタの ISO9660)
 *     「10」「20」= プログラム(SIMM1/2 の像、暗号のまま)、「30」「31」「40」…= 波形と絵(SIMM3 以降の像)
 *   BIOS(0x80000 バイト、暗号のまま)
 *
 * どのゲームかは鍵で決まる。正しい鍵で解くと、BIOS もプログラムも先頭が「飛び先(4 バイト)、スタック(4 バイト)」の形になる:
 *   BIOS       : 飛び先 < 0x80000、スタック = 0x0208_0000 付近
 *   プログラム : 飛び先 = 0x06xx_xxxx、スタック = 0x02xx_xxxx
 * 鍵 0 の作品(2nd Impact)はプログラムのデータ読みが生なので、生のままでこの形になる。
 * 決まらない時は CD のボリューム名(CAP-SF3-3 など)から決める。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};
  const Cps3 = Emu.Cps3 = Emu.Cps3 || {};

  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const VOLUMES = { 'CAP-WZD': 'redearth', 'CAP-SF3': 'sfiii', 'CAP-3GA': 'sfiii2', 'CAP-JJK': 'jojo', 'CAP-33S': 'sfiii3', 'CAP-JJM': 'jojoba' };
  const NAMES = { redearth: 'Warzard / Red Earth', sfiii: 'Street Fighter III: New Generation', sfiii2: 'Street Fighter III 2nd Impact',
    jojo: "JoJo's Venture", sfiii3: 'Street Fighter III 3rd Strike', jojoba: "JoJo's Bizarre Adventure" };

  // CD のイメージか(2352 バイト/セクタなら同期パターン、どちらの形でも 16 セクタ目に "CD001")
  function sectorLayout(b) {
    if (!b || b.length < 17 * 2048) return null;
    const raw = b.length >= 17 * 2352 && be32(b, 0) === 0x00FFFFFF && be32(b, 8) === 0xFFFFFF00;
    const SEC = raw ? 2352 : 2048, OFF = raw ? 16 : 0, p = 16 * SEC + OFF;
    if (p + 6 > b.length || b[p + 1] !== 0x43 || b[p + 2] !== 0x44 || b[p + 3] !== 0x30 || b[p + 4] !== 0x30 || b[p + 5] !== 0x31) return null;
    return { SEC, OFF };
  }
  /** CD のイメージを読む。{ volume, files: [{ name, lba, size }], read(file) → Uint8Array } か null */
  function openCd(b) {
    const lay = sectorLayout(b);
    if (!lay) return null;
    const read = (lba, bytes) => {
      const out = new Uint8Array(bytes);
      for (let done = 0; done < bytes; done += 2048, lba++) {
        const s = lba * lay.SEC + lay.OFF, n = Math.min(2048, bytes - done);
        if (s + n > b.length) break;
        out.set(b.subarray(s, s + n), done);
      }
      return out;
    };
    const pvd = read(16, 2048);
    let volume = ''; for (let i = 40; i < 72; i++) volume += String.fromCharCode(pvd[i]);
    const files = [];
    const walk = (lba, size, prefix, depth) => {
      const d = read(lba, size);
      for (let p = 0; p < d.length;) {
        const len = d[p];
        if (!len) { p = (Math.floor(p / 2048) + 1) * 2048; continue; }
        const l = le32(d, p + 2), sz = le32(d, p + 10), flags = d[p + 25], nlen = d[p + 32];
        let name = ''; for (let i = 0; i < nlen; i++) name += String.fromCharCode(d[p + 33 + i]);
        if (name !== '\0' && name !== '\x01') {
          const clean = name.replace(/;\d+$/, '').replace(/\.$/, '');
          if (flags & 2) { if (depth < 4) walk(l, sz, prefix + clean + '/', depth + 1); } else files.push({ name: prefix + clean, lba: l, size: sz });
        }
        p += len;
      }
    };
    walk(le32(pvd, 156 + 2), le32(pvd, 156 + 10), '', 0);
    return { volume: volume.trim(), files, read: (f) => read(f.lba, f.size) };
  }
  /** CPS3 のゲーム CD か(ISO9660 で、ルートに「10」と「30」がある) */
  function isCd(b) {
    if (!sectorLayout(b)) return false;
    try { const cd = openCd(b); return !!cd && cd.files.some((f) => f.name === '10') && cd.files.some((f) => f.name === '30'); } catch (e) { return false; }
  }
  // 先頭 8 バイトを各ゲームの鍵で解いて、飛び先とスタックの形になる物を探す。kind = 'bios' か 'program'
  function gameByVector(b, base, kind) {
    for (const game of Object.keys(Cps3.KEYS)) {
      const k = Cps3.KEYS[game], mask = Cps3.makeMask(k[0] >>> 0, k[1] >>> 0, k[2]);
      const raw = kind === 'program' && k[2];                       // 鍵 0 の作品はプログラムのデータ読みが生
      const pc = raw ? be32(b, 0) : (be32(b, 0) ^ mask(base)) >>> 0, sp = raw ? be32(b, 4) : (be32(b, 4) ^ mask(base + 4)) >>> 0;
      if (kind === 'bios' ? (pc < 0x80000 && !(pc & 1) && (sp >>> 20) === 0x020) : ((pc >>> 24) === 0x06 && !(pc & 1) && (sp >>> 24) === 0x02)) return game;
    }
    return null;
  }
  /** BIOS ならゲームの名前(Cps3.KEYS のキー)、違えば null */
  function identifyBios(b) { return b && b.length === 0x80000 ? gameByVector(b, 0, 'bios') : null; }

  /**
   * CD のイメージから本体に渡す物を取り出す。{ game, title, volume, simm1, simm2, gfx } か null。
   * gfx は「30」「31」「40」…を CPU から見える順のまま繋いだ物(音源が読む順はこれを 2 バイトずつ入れ替えた物)
   */
  function unpackCd(b) {
    const cd = openCd(b);
    if (!cd) return null;
    const get = (name) => { const f = cd.files.find((x) => x.name === name); return f ? cd.read(f) : null; };
    const simm1 = get('10');
    if (!simm1 || simm1.length < 0x800000) return null;
    const parts = [];
    for (let simm = 3; simm <= 7; simm++) for (let half = 0; half < 2; half++) { const d = get('' + simm + half); if (d) parts.push({ base: ((simm - 3) * 2 + half) * 0x800000, d }); }
    if (!parts.length) return null;
    const gfx = new Uint8Array(Math.max.apply(null, parts.map((p) => p.base + p.d.length)));
    for (const p of parts) gfx.set(p.d, p.base);
    const game = gameByVector(simm1, 0x6000000, 'program') || VOLUMES[cd.volume.slice(0, 7).toUpperCase()] || null;
    return { game, title: game ? NAMES[game] : '', volume: cd.volume, simm1, simm2: get('20'), gfx };
  }

  Cps3.Image = { isCd, openCd, unpackCd, identifyBios, NAMES };
})(typeof window !== 'undefined' ? window : globalThis);
