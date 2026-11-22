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
  Emu.ZoomRomSet = { find, hint, INFO };
})(typeof globalThis !== 'undefined' ? globalThis : this);
