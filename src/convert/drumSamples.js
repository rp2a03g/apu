/*
 * ドラムサンプルごとの設定(DPCM書き出し用)
 *   MML.Convert.DrumSamples
 *
 * 単位は「チャンネル」ではなく「サンプル(=ドラム区画のパッド1枚)」(2026-08-29、方針)。
 *   ・@DPCM<n> 定義は元々サンプルごとに freq を持てるので、レートもサンプル単位が自然
 *   ・プール式チップ(C140/C352/QSound/MultiPCM)は同じ太鼓が毎回別スロットへ移るため、
 *     チャンネル単位で持つと指定が飛んでしまう
 *   ・チャンネルという縛りはMMLにもハードウェアにも根拠が無い
 *
 * キーはサンプル内容のハッシュ(Emu.SamplePitchUtil.sampleHash)。基準音の手動補正・
 * 打楽器/音階の指定と同じ流儀で、同じROMを使う別の曲/別リビジョンでも指定が効く。
 * スナップショットの sampleHash から引ける(各チップの snapshotXxx が載せている)。
 *
 * 設定内容:
 *   enabled … false ならそのサンプルは変換しない。DPCMのクリップを作らず、MMLの
 *             打点も出さない(その分は休符になる)
 *   rate    … 'auto' | 0..15  DMCレート表(MML.Dpcm.DMC_RATE_TABLE_NTSC)のindex
 *   name    … パッド/ロール/@DPCMの書き出しファイル名に使う表示名(既定はROMアドレスの16進)
 *   vol     … 変換ボリューム 1〜100(%)。DPCMは実機で音量指定ができない(ppmckのDPCMチャンネルは
 *             @vが効かない)ので、波形そのものを小さくするのが唯一の音量調整手段になる。
 *             ★上げる方向は用意していない: ミックス時のピーク正規化と喧嘩するのと、
 *             DPCMのデルタ幅(2/127)に対して振幅を下げるほど量子化ノイズが増えるため
 *             (50%で約6dB悪化)、増幅は素直に元サンプル側でやるべきという判断
 *   include … 外部ファイルで中身を差し替える(データ挿げ替え)。{ name } を持ち、
 *             実PCMは runtime の差し替えテーブル(setIncludePcm)から引く。
 *             ファイルの実体はlocalStorageに置けないので、名前だけ永続化し、
 *             PCMはDPCMコンバータ側が読み込んだときに登録する
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const KEY = 'drumSampleSettings'; // localStorage: { [sampleHash]: {enabled, rate, include} }
  // split(2026-09-10): 長いサンプルの分割(ドラム(DPCM)パネル下段の分割ビューで編集)。
  //   { segs: [{ end, rate, used }] } … end=区間の終わり(サンプル先頭からの秒。割合ではない:
  //   DDAのようなストリームはキャプチャ時間でクリップの長さが変わるので、割合だと境目がずれる)、
  //   rate=区間のDMCレート(null=行のレートに従う)、used=反映に含めるか。null なら共通層の自動分割
  //   (src/convert/drumHits.js が上限を超えるときだけフレーム整数で均等に切る)。
  //   最後の end より後ろ(決めたときより長いクリップの残り)は未使用扱い
  // target/noise/priority(2026-09-18、ノイズパッド):
  //   target   … null(既定=割当どおり: 打点が持つ assignTarget、E なら 'dpcm'・D なら 'noise'。実サンプルは 'dpcm')
  //              | 'dpcm'(実サンプルを@DPCMへ) | 'noise'(2A03ノイズ(D)の音符列へ。src/convert/drumHits.js noise())
  //   noise    … 載せ先がノイズのときの音色。{ preset:'<id>' }(src/convert/noisePresets.js) /
  //              { custom:{idx,mode,vol,ep,en,detune} }(このパッドだけの音色) / { auto:true }(音程から自動=元の
  //              音程を最寄りの周期へ、音量は元のまま)。null=既定(音程を持つパッドは auto、無ければ先頭プリセット)
  //   priority … ノイズchは1本なので重なった打点は「後着が前を切る」。同時なら優先度の高い方
  //              (-1=低 / 0=通常 / 1=高)。元曲が持つノイズの音符は通常(0)扱いでパッドが同点で勝つ
  const DEFAULTS = { enabled: true, rate: 'auto', vol: 100, include: null, name: null, split: null,
                     target: null, noise: null, priority: 0 };

  // 差し替え用PCMの実体(セッション中のみ)。hash → { name, pcm: Float32Array, rate: Hz }
  const includePcm = new Map();

  function load() {
    try { return JSON.parse(global.localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function save(map) {
    try { global.localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }

  /** そのサンプルの設定(未設定は既定値)。hashが無ければ既定値を返す */
  function get(hash) {
    if (!hash) return Object.assign({}, DEFAULTS);
    return Object.assign({}, DEFAULTS, load()[hash] || {});
  }

  /** 部分更新。既定値と同じになった項目は捨てて、保存を最小限にする */
  function set(hash, patch) {
    if (!hash) return;
    const map = load();
    const cur = Object.assign({}, DEFAULTS, map[hash] || {}, patch || {});
    const keep = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (JSON.stringify(cur[k]) !== JSON.stringify(DEFAULTS[k])) keep[k] = cur[k];
    }
    if (Object.keys(keep).length) map[hash] = keep; else delete map[hash];
    save(map);
  }

  function clear(hash) { set(hash, Object.assign({}, DEFAULTS)); }

  /** split 設定の形を整える(壊れていれば null=自動)。segs は end(秒) 昇順に揃える */
  function sanitizeSplit(sp) {
    if (!sp || !Array.isArray(sp.segs) || !sp.segs.length) return null;
    const segs = [];
    let prev = 0;
    for (const s of sp.segs) {
      const end = Number(s && s.end);
      if (!Number.isFinite(end) || !(end > prev)) continue;
      const rate = (s.rate == null || s.rate === 'auto') ? null : Math.max(0, Math.min(15, s.rate | 0));
      segs.push({ end, rate, used: s.used !== false });
      prev = end;
    }
    return segs.length ? { segs } : null;
  }

  /** 変換ボリューム(%)を 1〜100 に丸める。0を許すと「変換しない」と意味が重なるので下限は1 */
  function clampVol(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return DEFAULTS.vol;
    return Math.max(1, Math.min(100, n));
  }

  /**
   * ファイル名/ラベルに使える表示名へ整える。@DPCM定義の "ファイル名" にそのまま入るので、
   * MMLのダブルクォート・パス区切り・空白を落とす(コンパイラ側で壊れるため)。
   */
  function sanitizeName(name) {
    if (!name) return '';
    return String(name).replace(/[^0-9A-Za-z_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  }

  /**
   * 差し替えPCMを登録する(DPCMコンバータが読み込んだ外部ファイル)。
   * pcm は -1..1 のFloat32Array、rate はその再生レート(Hz)。
   */
  function setIncludePcm(hash, name, pcm, rate) {
    if (!hash) return;
    if (pcm && pcm.length) includePcm.set(hash, { name, pcm, rate: rate || 0 });
    else includePcm.delete(hash);
    set(hash, { include: pcm && pcm.length ? { name } : null });
  }
  function getIncludePcm(hash) { return hash ? (includePcm.get(hash) || null) : null; }

  /**
   * 変換/試聴の入り口。そのサンプルを「どう鳴らすか」を1つにまとめて返す。
   *   { enabled, rate, vol, gain, name, pcm, srcRate, includedName }
   * pcm/srcRate は差し替えがあればそちら、無ければ渡された元のもの。
   * ★gain は pcm に掛ける倍率(vol/100)。ここで pcm を作り直さないのは、collectHits が
   *   打点ごとに resolve を呼ぶため(毎回 Float32Array を確保すると重い)。呼び出し側は
   *   既にチャンネル音量を掛けているので、そこへ一緒に掛ければコストゼロで済む。
   */
  function resolve(hash, pcm, srcRate) {
    const s = get(hash);
    const inc = getIncludePcm(hash);
    const vol = clampVol(s.vol);
    return {
      enabled: s.enabled !== false,
      target: s.target === 'noise' ? 'noise' : (s.target === 'dpcm' ? 'dpcm' : null), // null=割当どおり(打点の assignTarget)
      noise: s.noise || null,
      priority: (s.priority | 0),
      rate: s.rate,
      vol: vol,
      gain: vol / 100,
      name: s.name || null,
      pcm: (inc && inc.pcm) ? inc.pcm : pcm,
      srcRate: (inc && inc.rate > 0) ? inc.rate : srcRate,
      includedName: inc ? inc.name : (s.include ? s.include.name : null),
      // 名前だけ残っていてPCMが未登録(再読み込み後など)。UIが「読み込み直して」と出せる
      includeMissing: !!(s.include && !inc),
      // 手動の分割(共通層 drumHits.js が「単独で鳴っている区間」に効かせる。上の DEFAULTS 参照)
      split: sanitizeSplit(s.split),
    };
  }

  MML.Convert.DrumSamples = {
    DEFAULTS, get, set, clear, resolve, clampVol, sanitizeName, sanitizeSplit,
    setIncludePcm, getIncludePcm,
    all: load,
  };
})(window);
