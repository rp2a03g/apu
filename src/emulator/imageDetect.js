/*
 * ゲームの ROM/ディスク画像を中身で見分ける共通層 MML.Emu.Image(2026-11-09)
 *
 * 拡張子に頼らず、ヘッダとサイズで「どの機種の、何の媒体か」を決める。ドロップ/[開く]/URL 読み込み/アーカイブ(zip/7z/rar/lzh)の
 * 中身、のどの経路でも同じ判定を通す(ゲーム画面 nesScreen.js の open()、main.js の openSoundFile/openArchive が使う)。
 * 新しい機種は detect に判定を足し、nesScreen.js の開き方の表(registerOpener)に開き方を登録すれば全経路に乗る。
 *
 *   detect(bytes, name) → { kind, machine, media } | null
 *     kind: 'nes'(iNES) / 'fds'(ディスクシステムの画像) / 'fds-bios'(disksys.rom) / 'msx-rom'(カートリッジ) / 'msx-dsk'(ディスク画像) /
 *           'gb'(ゲームボーイのカートリッジ。ヘッダ $0104 のロゴ先頭と $014D のチェックサムで見る)
 *     machine: 'nes' | 'msx' | 'gb'、media: 'cart' | 'disk' | 'bios'
 *   looksLikeGameEntry(name, size): アーカイブの一覧(中身を読む前)で「ゲームの画像らしい」か。拡張子がゲームの物か、拡張子無しでディスクのサイズ
 *   combineFds(list): 複数の .fds(1 枚ずつの画像)の面を順に並べて 1 本の .fds(ヘッダ無し)にする(zip に DISK1/DISK2 と分かれている物)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const GAME_EXTS = ['nes', 'fds', 'rom', 'mx1', 'mx2', 'dsk', 'gb', 'gbc', 'sgb'];
  const GB_EXTS = ['gb', 'gbc', 'sgb'];
  const MSX_CART_EXTS = ['rom', 'mx1', 'mx2'];
  const DSK_SIZES = new Set([737280, 368640, 655360, 327680]); // 720K 2DD / 360K 1DD / 640K / 320K
  const FDS_SIDE = 65500;

  function extOf(name) { const b = (name || '').replace(/\\/g, '/'); const base = b.slice(b.lastIndexOf('/') + 1); const i = base.lastIndexOf('.'); return i > 0 ? base.slice(i + 1).toLowerCase() : ''; }

  // スーパーゲームボーイの BIOS(SNES のカートリッジ。256K = 初代、512K = SGB2): LoROM のヘッダの題名で見分ける
  function isSgbBios(bytes) {
    let b = bytes; if ((b.length & 0x3FF) === 0x200) b = b.subarray(0x200); // コピー機のヘッダ
    if (b.length !== 0x40000 && b.length !== 0x80000) return false;
    let t = ''; for (let i = 0; i < 13; i++) t += String.fromCharCode(b[0x7FC0 + i]);
    return t === 'Super GAMEBOY';
  }
  function detect(bytes, name) {
    if (!bytes || bytes.length < 16) return null;
    const ext = extOf(name);
    const F = Emu.FdsDisk;
    if (bytes[0] === 0x4E && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1A) return { kind: 'nes', machine: 'nes', media: 'cart' };
    if (F && F.isFds && F.isFds(bytes)) return { kind: 'fds', machine: 'nes', media: 'disk' };
    if (F && F.isFdsBios && F.isFdsBios(bytes)) return { kind: 'fds-bios', machine: 'nes', media: 'bios' };
    if (isSgbBios(bytes)) return { kind: 'sgb-bios', machine: 'gb', media: 'bios' };
    // ゲームボーイ: ヘッダが整っていれば拡張子に関係なく(.rom/.bin でも)。拡張子が GB の物ならヘッダが崩れていても GB として開く
    if ((Emu.GbCart && Emu.GbCart.isGb(bytes)) || GB_EXTS.includes(ext)) return { kind: 'gb', machine: 'gb', media: 'cart' };
    // MSX のディスク: サイズで(拡張子が無い物も多い。カートリッジの拡張子なら ROM として扱う)
    if (DSK_SIZES.has(bytes.length) && !MSX_CART_EXTS.includes(ext)) return { kind: 'msx-dsk', machine: 'msx', media: 'disk' };
    // MSX のカートリッジ: 拡張子がそれ、または拡張子が無くて 'AB' ヘッダ(先頭か $4000)がありサイズが 8K の倍数
    const ab = (o) => bytes.length > o + 1 && bytes[o] === 0x41 && bytes[o + 1] === 0x42;
    if (MSX_CART_EXTS.includes(ext)) return { kind: 'msx-rom', machine: 'msx', media: 'cart' };
    if (ext === '' && bytes.length % 0x2000 === 0 && bytes.length >= 0x2000 && (ab(0) || ab(0x4000))) return { kind: 'msx-rom', machine: 'msx', media: 'cart' };
    if (ext === 'dsk') return { kind: 'msx-dsk', machine: 'msx', media: 'disk' }; // サイズが規格外でも拡張子を信じる(本体側で弾かれる)
    return null;
  }
  function looksLikeGameEntry(name, size) {
    const ext = extOf(name);
    if (GAME_EXTS.includes(ext)) return true;
    return ext === '' && size !== undefined && DSK_SIZES.has(size);
  }
  function combineFds(list) {
    const F = Emu.FdsDisk; if (!F) throw new Error('FdsDisk がありません');
    const raws = [];
    for (const b of list) { const r = F.parse(b); for (const s of r.raw) raws.push(s); }
    const out = new Uint8Array(raws.length * FDS_SIDE);
    raws.forEach((s, i) => out.set(s.subarray(0, FDS_SIDE), i * FDS_SIDE));
    return out;
  }
  Emu.Image = { isSgbBios, GAME_EXTS, MSX_CART_EXTS, DSK_SIZES, extOf, detect, looksLikeGameEntry, combineFds };
})(typeof window !== 'undefined' ? window : globalThis);
