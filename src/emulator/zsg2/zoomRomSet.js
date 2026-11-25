/*
 * MML.Emu.ZoomRomSet
 *
 * アーカイブの一覧から、タイトーの ZOOM 音源基板(FX-1B: ZSG-2+TMS57002)の ROM の組を見つける。
 *   find(entries) → { program: エントリ, waves: [エントリ…], info } か null
 *   hint(entries) → 音源の ROM が入っていない「メイン基板だけの zip」らしい時 true(案内を出すため)
 *
 * 見分け方(FX-1B の ROM の名前の付け方。基板上の位置が拡張子になっている):
 *   サウンドプログラム = ちょうど 512KB で名前が「.14」で終わる物、波形 = 名前が「.27」で終わる物(1MB 以上、4 バイト単位)
 * 中身に目印は無いので、名前と大きさだけで決める。曲のコードの範囲は、分かっている組だけ表に持つ(INFO)。
 * 表に無い組はコード 1〜32 を並べ、鳴らなかったコードは開いた時に知らせる。
 * 範囲の外のコードの扱いはドライバで違う(実測): 黙る物(RayStorm の 21 以上)と、1 番の曲を鳴らす物(G-Darius の 17 以上)がある。
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};
  // サウンドプログラムの名前 → ゲーム名と、曲のあるコード(実測した物だけ)
  const INFO = {
    'e39-07.14': { game: 'G-Darius', first: 1, last: 16 },    // サウンドテストの SOUND CODE B が 1〜16
    'e24-09.14': { game: 'RayStorm', first: 2, last: 20 }     // コード 0〜40 を 3 秒ずつ鳴らして、キーオンが出た範囲(実機・MAME とは未照合)
  };
  const base = (name) => String(name || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  function find(entries) {
    const files = (entries || []).filter((e) => !e.isDir);
    const program = files.find((e) => e.size === 0x80000 && /\.14$/.test(base(e.name)));
    const waves = files.filter((e) => /\.27$/.test(base(e.name)) && e.size >= 0x100000 && !(e.size & 3)).sort((a, b) => base(a.name) < base(b.name) ? -1 : 1);
    if (!program || !waves.length) return null;
    const known = INFO[base(program.name)];
    return { program, waves, info: known ? { ...known, known: true } : { game: '', first: 1, last: 32, known: false } };
  }
  // タイトーの ROM の名前(英字 1 つ+数字 2 桁-数字 2 桁.位置)だけが並んでいて、音源の ROM が無い
  function hint(entries) {
    const files = (entries || []).filter((e) => !e.isDir);
    return files.length > 0 && !find(entries) && files.every((e) => /^[a-z]\d\d-[0-9a-z]{2}\.[0-9a-z]+$/.test(base(e.name)) || /^tt\d\d$/.test(base(e.name)));
  }
  // ── メイン基板(ソニー ZN-1+FX-1B)の ROM。本物のテストモード画面を出す時だけ要る(src/emulator/zn/znMain.js)──
  // MAME の ROM は 3 つの zip に分かれている: BIOS(coh1000t.zip)、親セット(音源とデータ)、子セット(プログラム 2 本だけ)。
  // 並びは MAME の src/mame/sony/zn.cpp の ROM_START のとおり。prog = [奇数番地, 偶数番地](1 バイトおきに並べて 2MB)
  const BIOS = { bios: 'm534002c-14.ic353', cat1: 'tt01.ic652', zip: 'coh1000t' };
  const GD_DATA = [['e39-01.1', 0x400000], ['e39-02.2', 0x800000], ['e39-03.12', 0xC00000]];
  const MAINS = {
    gdarius: { prog: ['e39-09.ic4', 'e39-10.ic3'], data: GD_DATA, cat2: 'tt07', parent: 'gdarius2' },
    gdariusu: { prog: ['e39-08.ic4', 'e39-10.ic3'], data: GD_DATA, cat2: 'tt07', parent: 'gdarius2' },
    gdariusj: { prog: ['e39-06.4', 'e39-05.3'], data: GD_DATA, cat2: 'tt07', parent: 'gdarius2' },
    gdarius2: { prog: ['e39-12.4', 'e39-11.3'], data: GD_DATA, cat2: 'tt07', parent: '' }
  };
  const PART_NAMES = new Set([BIOS.bios, BIOS.cat1]);
  for (const k in MAINS) { const m = MAINS[k]; for (const n of m.prog) PART_NAMES.add(n); for (const d of m.data) PART_NAMES.add(d[0]); PART_NAMES.add(m.cat2); }
  /** この zip が、あとで他の zip と合わせて使う部品を持っているか(持っていれば呼ぶ側が控えておく) */
  function isPart(entries) {
    return (entries || []).some((e) => !e.isDir && (PART_NAMES.has(base(e.name)) || (e.size === 0x80000 && /\.14$/.test(base(e.name))) || /\.27$/.test(base(e.name))));
  }
  /**
   * メイン基板の ROM の組を探す。entries は控えてある zip を全部合わせた一覧、prefer は今開いた zip の名前(同じ名前のセットを優先)。
   * そろっていれば { set, prog: [奇数, 偶数], data: [{ entry, at }], cat2, bios, cat1 }、足りなければ { missing: [zip の名前…] }、対象外なら null
   */
  function findMain(entries, prefer) {
    const by = new Map(); for (const e of entries || []) if (!e.isDir) by.set(base(e.name), e);
    const want = String(prefer || '').toLowerCase().replace(/\.[^.]+$/, '');
    const keys = Object.keys(MAINS).sort((a, b) => (b === want) - (a === want));
    const has = (m) => m.prog.every((n) => by.has(n));
    const key = keys.find((k) => has(MAINS[k]));
    const anyData = GD_DATA.some((d) => by.has(d[0]));
    if (!key && !anyData) return null;
    const missing = [];
    if (!key) missing.push('gdarius');                                  // プログラム 2 本(どの版でもよい。代表の名前を出す)
    const m = MAINS[key || 'gdarius2'];
    if (!m.data.every((d) => by.has(d[0])) || !by.has(m.cat2)) missing.push('gdarius2');
    if (!by.has(BIOS.bios) || !by.has(BIOS.cat1)) missing.push(BIOS.zip);
    if (missing.length) return { missing };
    return { set: key, prog: m.prog.map((n) => by.get(n)), data: m.data.map((d) => ({ entry: by.get(d[0]), at: d[1] })), cat2: by.get(m.cat2), bios: by.get(BIOS.bios), cat1: by.get(BIOS.cat1) };
  }
  Emu.ZoomRomSet = { find, hint, isPart, findMain, INFO };
})(typeof globalThis !== 'undefined' ? globalThis : this);
