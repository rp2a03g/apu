/*
 * ドラムマップ: 音程を持たないサンプルPCM(打楽器/効果音)を「1サンプル=1レーン」へ束ねる共通表
 *
 *   MML.Convert.DrumMap.key(sample)   → 'c140:294064' のような同定キー(sample={kind,start})
 *   MML.Convert.DrumMap.build(obs)    → { lanes, laneOf, otherLane }
 *   MML.Convert.DrumMap.noteOf(lane)  → そのレーンのノート番号
 *
 * なぜ共通化するか(2026-08-29):
 *   ピアノロールのドラム区画(src/ui/keyboard.js)と、vgm2mml のドラム音符出力
 *   (src/vgm2mml/expansion/opn.js)が **同じサンプルに同じレーン番号=同じ音程** を割り当てないと、
 *   「ロールで見た太鼓」と「MMLに出た音符」が食い違う。ロールはMML変換のデバッガという方針
 *   ([[roll-as-mml-debugger]])なので、割当規則はここ1箇所に置いて両方から呼ぶ。
 *
 * 並び順を「初出時刻順」にしてある理由(★重要):
 *   打点数の多い順の方が見やすい(よく鳴る太鼓が左に来る)のだが、ロール側は音量が変わると
 *   1回のキーオンが複数ノートに割れるため「打点数」が両者で一致しない。初出時刻なら
 *   どちらから数えても同じ値になるので、レーン番号が確実に一致する。
 *
 * ノート番号:
 *   レーン0を NOTE_BASE とし、レーン1つにつき半音1つ。★16 にしてあるのは ppmck の
 *   2A03ノイズchの音域に合わせるため: ノイズchはノート番号 n が周期index 31-n を選ぶので
 *   (src/mml/compiler.js noisePeriodIndex、vgm2mml/expansion/sn76489.js noiseFreqToNote)、
 *   有効なノート番号は 16〜31 のちょうど16個。レーン上限16と1対1で対応する。
 *   ドラムパートの既定の借用先が2A03ノイズなので、この対応が取れていないと
 *   上限側のレーンが無効なノート番号になって落ちる。
 */
(function (global) {
  'use strict';
  const MML   = global.MML   = global.MML   || {};
  MML.Convert = MML.Convert || {};

  const MAX_LANES = 16; // これを超えたサンプルは末尾の「その他」レーンへまとめる
  const NOTE_BASE = 16; // レーン0のノート番号(ppmck 2A03ノイズchの音域 16〜31 の下端)
  // ロール表示用のレーン上限(2026-09-04)。16はあくまで「2A03ノイズ疑似音程のドラムパートで
  // 使えるノート数」の制約であって、見るだけのロールを縛る理由が無い。HESのようにDDAクリップだけで
  // 16枠を使い切る形式では、追加した打楽器(合成音chのE指定など)が全部「その他」1本に潰れて
  // 「ロールにパッドが出てこない」ように見えていた(ユーザー報告、NCS91002 track0 で実測)。
  // ★並びは初出時刻順なので、先頭16レーンの番号は表示側と変換側で必ず一致する
  //   (食い違うのは16番目以降=変換側では「その他」に入るぶんだけ)。
  const DISPLAY_MAX_LANES = 32;

  /** サンプル同定情報 {kind, start} → 文字列キー。持たないチップ(ストリーミングDAC)はnull */
  function keyOf(sample) {
    return sample ? (sample.kind + ':' + sample.start) : null;
  }

  /**
   * obs: [{key, sec}] 打点の観測列(順不同でよい)
   * → lanes:     [{key, first, count}]  レーン番号順。溢れた分をまとめる「その他」レーンは key:null
   *   laneOf:    Map(key → レーン番号)
   *   otherLane: 「その他」レーンの番号(溢れが無ければ -1)
   */
  function build(obs, opt) {
    const maxLanes = (opt && opt.maxLanes > 0) ? opt.maxLanes : MAX_LANES;
    const stat = new Map();
    for (const o of obs) {
      if (!o || !o.key) continue;
      const st = stat.get(o.key);
      if (st) { st.count++; if (o.sec < st.first) st.first = o.sec; }
      else stat.set(o.key, { key: o.key, first: o.sec, count: 1 });
    }
    const all = Array.from(stat.values())
      .sort((a, b) => (a.first - b.first) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const overflow = all.length > maxLanes;
    const named = overflow ? all.slice(0, maxLanes - 1) : all;
    const laneOf = new Map();
    named.forEach((s, i) => laneOf.set(s.key, i));
    const otherLane = overflow ? maxLanes - 1 : -1;
    const lanes = named.map((s) => ({ key: s.key, first: s.first, count: s.count }));
    if (overflow) {
      const rest = all.slice(maxLanes - 1);
      for (const s of rest) laneOf.set(s.key, otherLane);
      lanes.push({ key: null, first: rest[0].first, count: rest.reduce((a, s) => a + s.count, 0) });
    }
    return { lanes, laneOf, otherLane };
  }

  /** レーン番号 → ノート番号。マップに無いキー(lane<0)は null */
  function noteOf(lane) {
    return (lane >= 0 && lane < MAX_LANES) ? (NOTE_BASE + lane) : null;
  }

  /**
   * パッド/凡例に出す短いラベル。サンプルROM上の開始アドレスを16進にし、
   * 与えられたキー集合の中で重複しない範囲で下位を切り詰める。
   * ★C140/C352はアドレスが16bitに収まらないので、下位4桁固定だと
   *   0x00000 と 0x70000 が両方 '0000' になる。
   */
  // ★アドレスを持たないキーもある(2026-09-04)。合成音chの打楽器化は 'syn:<行ID>:<midi>'、
  //   SPCのBRRは 'brr:<srcn>' のようにROMアドレスではないので、そのまま読める形へ落とす
  //   (以前は parseInt が NaN になり全部 '?' 表示だった)。
  function nonAddrLabel(k) {
    const parts = String(k).split(':');
    if (parts[0] === 'syn') return parts.slice(1).join(' '); // 'syn:PSG3:37' → 'PSG3 37'
    return parts.slice(1).join(':') || String(k);
  }
  // SPCのBRRはROMアドレスではなくサンプル番号(srcn)。16進にすると実機の呼び名と食い違うので
  // そのまま10進で 'srcn20' と出す(パッド台帳側のラベルとも揃う)
  const SRCN_KEY = /^brr:(\d+)$/;
  function labels(keys) {
    // アドレス系のキーだけを16進の短縮対象にし、それ以外(syn: 等)は素の表記を使う。
    // ★1つ目の':'の直後が数値ならアドレス。NSFのDMCは 'dmc:<開始>:<長さ>' のように
    //   後ろが続くので、末尾まで数値であることは条件にしない
    const hex = keys.map((k) => {
      if (!k || SRCN_KEY.test(k)) return null;
      const m = /^[^:]*:(\d+)(?::|$)/.exec(k);
      return m ? parseInt(m[1], 10).toString(16).toUpperCase() : null;
    });
    const other = keys.map((k, i) => {
      if (!k || hex[i] !== null) return null;
      const s = SRCN_KEY.exec(k);
      return s ? 'srcn' + s[1] : nonAddrLabel(k);
    });
    const real = hex.filter((h) => h !== null);
    const finish = (map) => keys.map((k, i) => (!k ? null : hex[i] === null ? other[i] : map(hex[i])));
    for (let len = 4; len <= 8; len++) {
      const cut = new Map();
      for (const h of real) cut.set(h, h.slice(-len).padStart(Math.min(len, h.length), '0'));
      if (new Set(cut.values()).size === new Set(real).size) return finish((h) => cut.get(h));
    }
    return finish((h) => h);
  }

  MML.Convert.DrumMap = { MAX_LANES, DISPLAY_MAX_LANES, NOTE_BASE, key: keyOf, build, noteOf, labels };
})(window);
