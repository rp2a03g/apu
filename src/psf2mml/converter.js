/*
 * PSF → MML コンバータ
 * MML.PSF2MML
 *
 * PSF(PlayStation)の SPU は「サンプル再生の音源」なので、VGM の PCM チップ(C352 等)と同じ経路で変換する
 * (ロール=変換デバッガの原則 INV-3: 鍵盤表示/ロールと変換が同じスナップショットを読む)。
 *   1. Emu.capturePsfSongAsync(regsOnly)で CPU+SPU を回し、フレームごとのボイス状態とサンプルを取る
 *   2. Emu.snapshotPsx で C352 と同じ形のスナップショット(24ボイス)へ変換し、options.poolMode でレーンを作る
 *      'track'(既定)… ドライバ内部トラック×声部(Emu.PsfTrackVoicer。レーン数は曲で決まる)
 *      'logical'    … 合成ch(Emu.PoolChannelRegrouper、32本)
 *      'phys'       … 実機ボイス(24本)
 *      (鍵盤ヘッダの切替と同じ語彙。main.js vgmPoolModes.psx)
 *   3. VGM2MML.convertData へ「header.chips.psx を持つ仮想 VGM データ」として渡す
 *
 *   MML.PSF2MML.header(info, lanes?)    → 仮想 VGM ヘッダ(sourceChannels/defaultPlan の引数)。lanes はトラックモードのレーン表
 *   MML.PSF2MML.sourceChannels(info, lanes?) → [{id:'psx:0'.., 'psx:drum', ...}]
 *   MML.PSF2MML.defaultPlan(info)       → {sourceId: targetType}(合成ch/実機スロット用。先頭から N163)
 *   MML.PSF2MML.laneLabels(lanes)       → レーン番号順の名前('T17-2' 等)
 *   MML.PSF2MML.trackPlan(data)         → {sourceId: targetType}(トラックモードの既定割当。下のコメント)
 *   MML.PSF2MML.captureData(info, sec, options) → Promise<data>(変換用データ。ヘッドレス検証でも使う)
 *   MML.PSF2MML.fromPsf(info, sec, options)     → Promise<result>(VGM2MML.convertData の結果 + family)
 *
 * options は VGM2MML.fromVgm と同じ({bpm, channelMap(ソースIDキー), vrc7Inst, tone, drumHits, toneSettings, cmd,
 * poolMode('track'|'logical'|'phys'), onProgress})。
 * DOM 非依存(INV-4)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const PSF2MML = MML.PSF2MML = MML.PSF2MML || {};

  const FRAME_RATE = 60;

  PSF2MML.laneLabels = function (lanes) {
    const Emu = MML.Emu;
    const voices = new Map();
    for (const l of lanes) voices.set(l.group, (voices.get(l.group) || 0) + 1);
    return lanes.map(l => Emu.PsfTrackVoicer.laneName(l, voices.get(l.group)));
  };

  PSF2MML.header = function (info, lanes) {
    const t = (info && info.tags) || {};
    return {
      chips: { psx: lanes ? { lanes: lanes.length, labels: PSF2MML.laneLabels(lanes) } : {} },
      usedChips: [{ id: 'psx', name: 'PlayStation SPU', impl: true }],
      gd3: { trackEn: t.title || '', gameEn: t.game || '', authorEn: t.artist || '' },
    };
  };

  PSF2MML.sourceChannels = function (info, lanes) { return MML.VGM2MML.sourceChannels(PSF2MML.header(info, lanes)); };
  PSF2MML.defaultPlan = function (info) { return MML.VGM2MML.defaultPlan(PSF2MML.header(info)); };

  // トラックモードの既定割当で埋めていく借用先の順(N163 → VRC6 → FME-7 → MMC5 → 2A03 パルス → 三角)。
  // サンプル音源なので波形を持つ N163 を先に、足りなければ矩形波系へ(ユーザー承認 2026-09-14「割当先は増やしてよい」)
  const TRACK_SLOT_ORDER = ['n163_0', 'n163_1', 'n163_2', 'n163_3', 'n163_4', 'n163_5', 'n163_6', 'n163_7',
    'vrc6pulse1', 'vrc6pulse2', 'vrc6saw', 'fme7a', 'fme7b', 'fme7c', 'mmc5pulse1', 'mmc5pulse2',
    'pulse1', 'pulse2', 'triangle'];
  PSF2MML.TRACK_SLOT_ORDER = TRACK_SLOT_ORDER;

  // 借用先の最低音(MIDI 番号)。周期レジスタの幅から決まる実機の音域(src/mml/compiler.js pitchRangeIssue と同じ式で
  // 周期が上限に収まる最も低い音): 2A03/MMC5 パルス 11bit=A1(33) / 三角 11bit・VRC6 パルス 12bit=A0(21) /
  // VRC6 ノコギリ 12bit(/14)=C1(24) / FME-7 12bit(/32)=A-1(9)。N163 は周波数比例なので実質下限なし。
  // ★VRC6 パルスは 2026-09-14 まで 2A03 と同じ11bitで計算していて A1 より下が A1 に貼り付いていた(compiler.js vrc6PulsePeriod)
  function targetLowestMidi(target) {
    if (/^(pulse[12]|mmc5pulse[12])$/.test(target)) return 33;
    if (target === 'triangle' || /^vrc6pulse/.test(target)) return 21;
    if (target === 'vrc6saw') return 24;
    if (/^fme7/.test(target)) return 9;
    return -Infinity;
  }

  /**
   * トラックモードの既定割当。data は captureData(poolMode 'track')の結果(または同じ形 {psx:{snapshots, lanes, doubles?}})。
   * 載せる順:
   *   1. 単音の旋律トラック(音符の多い順)
   *   2. 和音トラックの声部1(=枠が足りなければ和音は一番上の声だけ残る)
   *   3. 和音トラックの残りの声部
   *   4. 複製(デチューン二重化/エコー。src/convert/poolDoubles.js)のレーン
   * 音程の取れないレーン(打楽器)は割り当てず、ドラムパート psx:drum を 2A03 ノイズへ。
   * @returns {Object<string,string>} sourceId → target
   */
  // レーンごとの音符の頭の数(全部 / 音程の取れたもの)
  function laneStats(frames, n) {
    const onsets = new Array(n).fill(0), pitched = new Array(n).fill(0);
    const prev = new Array(n).fill(null);
    for (const fr of frames) {
      for (let li = 0; li < fr.length && li < n; li++) {
        const c = fr[li];
        if (c && c.active && c.seq !== prev[li]) {
          onsets[li]++;
          if (c.pitchConf >= 0.5 && c.pitchHz > 0) pitched[li]++;
        }
        prev[li] = c && c.active ? c.seq : null;
      }
    }
    return { onsets, pitched };
  }

  /**
   * 複製レーン(音程の取れた音符の半分以上が別レーンの複製=デチューン二重化/エコー)→ 元のレーン番号。
   * data.psx.doubles(PoolDoubles.find の結果)が無ければここで探す。鍵盤の行名(「≈T8」)と trackPlan が共有する
   * @returns {Map<number, number>}
   */
  PSF2MML.copyLanes = function (data, stats) {
    const frames = data.psx.snapshots, n = (data.psx.lanes || []).length;
    const st = stats || laneStats(frames, n);
    const PD = MML.Convert && MML.Convert.PoolDoubles;
    const doubles = data.psx.doubles || (PD ? PD.find(frames) : null);
    const out = new Map();
    if (!doubles) return out;
    for (let li = 0; li < n; li++) {
      if (!st.pitched[li] || (doubles.copyCount.get(li) || 0) < st.pitched[li] * 0.5) continue;
      // 元は一番多く対応したレーン
      let best = null;
      for (const g of doubles.groups) if (g.copy === li && (!best || g.notes > best.notes)) best = g;
      if (best) out.set(li, best.of);
    }
    return out;
  };

  PSF2MML.trackPlan = function (data) {
    const frames = data.psx.snapshots, lanes = data.psx.lanes || [];
    const n = lanes.length;
    const stats = laneStats(frames, n);
    const onsets = stats.onsets, pitched = stats.pitched;
    const copyOf = PSF2MML.copyLanes(data, stats);
    const isCopy = (li) => copyOf.has(li);
    const isPitched = (li) => pitched[li] > 0 && pitched[li] >= onsets[li] * 0.5;
    // トラックごとにまとめる(声部順)
    const groups = new Map();
    for (const l of lanes) { if (!groups.has(l.group)) groups.set(l.group, []); groups.get(l.group).push(l.index); }
    const sum = (arr) => arr.reduce((a, li) => a + pitched[li], 0);
    const mono = [], chordTop = [], chordRest = [], copies = [];
    const tracks = [...groups.values()].map(ls => ls.filter(isPitched)).filter(ls => ls.length);
    tracks.sort((a, b) => sum(b) - sum(a));
    for (const ls of tracks) {
      const own = ls.filter(li => !isCopy(li));
      for (const li of ls) if (isCopy(li)) copies.push(li);
      if (!own.length) continue;
      if (lanes[ls[0]] && groups.get(lanes[ls[0]].group).length === 1) { mono.push(own[0]); continue; }
      chordTop.push(own[0]);
      for (const li of own.slice(1)) chordRest.push(li);
    }
    copies.sort((a, b) => pitched[b] - pitched[a]);
    // レーンの最低音(音程の取れた音の MIDI 番号)。載せ先の音域の制約に使う
    const lowest = new Array(n).fill(Infinity);
    for (const fr of frames) {
      for (let li = 0; li < fr.length && li < n; li++) {
        const c = fr[li];
        if (c && c.active && c.pitchConf >= 0.5 && c.pitchHz > 0) {
          const m = 69 + 12 * Math.log2(c.pitchHz / 440);
          if (m < lowest[li]) lowest[li] = m;
        }
      }
    }
    const plan = {};
    for (let li = 0; li < n; li++) plan['psx:' + li] = 'skip';
    const free = TRACK_SLOT_ORDER.slice();
    for (const li of [...mono, ...chordTop, ...chordRest, ...copies]) {
      // 載せ先の最低音より低い音を含むレーンは、その載せ先を飛ばして次の空きへ(コンパイラは音域外の音を
      // 「鳴らさない+警告」にするので、既定の割当でベースが消えないように)
      const k = free.findIndex(t => !(lowest[li] < targetLowestMidi(t) - 0.5));
      if (k < 0) { if (!free.length) break; continue; } // 残りが VRC6 パルスだけで載せられない(次のレーンは載るかも)
      plan['psx:' + li] = free[k];
      free.splice(k, 1);
    }
    plan['psx:drum'] = 'noise';
    return plan;
  };

  /**
   * キャプチャして変換用データを作る
   * @returns {Promise<{frameRate, totalFrames, header, psx:{snapshots, samples, pooled, lanes?}, cap}>}
   */
  PSF2MML.captureData = async function (info, durationSeconds, options) {
    options = options || {};
    const Emu = MML.Emu;
    const cap = await Emu.capturePsfSongAsync(info, {
      durationSeconds: durationSeconds || 60,
      regsOnly: true,
      yieldFn: options.yieldFn,
    }, options.onProgress ? (done, total) => options.onProgress(done, total) : null);
    const bank = new Emu.PsxSampleBank(cap.samples);
    let snapshots = cap.snapshots.map(s => Emu.snapshotPsx(s, bank));
    // ボイス音量の正規化: PS1 のドライバはボイス音量を控えめに書いて主音量で持ち上げる曲が多く、
    // 生の値(エンベロープ×ボイス音量、最大1)のままだと借用先の音量が v1〜5 に潰れて比率も丸めで消える
    // (実測 SaGa Frontier: 曲中最大 0.3 前後)。曲全体の最大を 1 へ引き延ばす(ch 間の比は保つ。
    // SPC 変換の songMaxVol と同じ考え方)。鍵盤/ロールは実機の値のまま表示する
    let maxVol = 0;
    for (const frame of snapshots) for (const c of frame) if (c.active && c.vol > maxVol) maxVol = c.vol;
    if (maxVol > 0 && maxVol < 1) {
      const k = 1 / maxVol;
      for (const frame of snapshots) {
        for (const c of frame) {
          if (!c.vol) continue;
          c.vol = Math.min(1, c.vol * k);
          c.rawVol = Math.round(c.vol * 255);
        }
      }
    }
    const mode = options.poolMode || 'track';
    let lanes = null;
    if (mode === 'track') {
      const vc = new Emu.PsfTrackVoicer();
      snapshots = snapshots.map(s => vc.step(s));
      lanes = vc.laneTable();
    } else if (mode === 'logical') {
      const rg = new Emu.PoolChannelRegrouper(Emu.POOL_CHIP_CHANNELS.psx);
      snapshots = snapshots.map(s => rg.step(s));
    }
    // ドラム(DPCM)用の実サンプル表('psx:start:end' → Float32Array)。vgmPlayer.js collectUsedSamples と同じキー
    const samples = {};
    for (let id = 0; id < cap.samples.length; id++) {
      const smp = cap.samples[id];
      if (!smp) continue;
      const key = 'psx:' + smp.addr + ':' + (smp.addr + smp.blocks * 16);
      if (!samples[key]) samples[key] = bank.samplePcm({ kind: 'psx', start: smp.addr, end: smp.addr + smp.blocks * 16, id });
    }
    return {
      frameRate: FRAME_RATE,
      totalFrames: snapshots.length,
      header: PSF2MML.header(info, lanes),
      // pooled: 合成ch/トラックのレーン(VGM2MML.convertData が複製パートを探す)。lanes: トラックモードのレーン表
      psx: { snapshots, samples, pooled: mode !== 'phys', lanes },
      cap,
    };
  };

  PSF2MML.fromPsf = async function (info, durationSeconds, options) {
    options = options || {};
    const data = await PSF2MML.captureData(info, durationSeconds, options);
    const opt = Object.assign({}, options, { sourceLabel: 'PSF' });
    // トラックモードで割当の指定が無い(ヘッドレス等)ときは、トラック単位の既定割当を使う
    // (VGM2MML の「音符の多いch上位を N163 の8枠へ」ではトラック/和音の単位が崩れる)
    if (data.psx.lanes && !opt.channelMap) opt.channelMap = PSF2MML.trackPlan(data);
    const result = MML.VGM2MML.convertData(data, opt);
    result.family = 'psf';
    result.bios = data.cap.bios;
    return result;
  };
})(window);
