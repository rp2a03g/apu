#!/usr/bin/env node
/*
 * ライブ表示(ロール追記モード、段階5)の点検。
 *
 * 1. 先読み(従来)のロール構築 UI.buildRollTracksFromRegSnapshots が変わっていないかの目印
 *    (タイムラインの正規化 JSON のハッシュ)。HEAD の worktree で同じコマンドを走らせて比べる。
 * 2. 追記(KeyboardDisplay.liveRollBegin → liveAppendFrame×n → liveRollEnd)が、同じ材料
 *    (レジスタ像だけ。APU エンベロープ実出力と DPCM の打楽器同定は無い)で一括構築した基準と
 *    音符単位で一致すること。
 * 3. 追記 1 フレームあたりの時間(60fps の 16.7ms に対して十分小さいこと)。
 * 4. 過去向きの座標系 makeRollGeom(..., past=true) の span/tOf/absOf の自己検査。
 *
 * 使い方: node tools/headless/live-roll-test.js "song.nsf" [--song n] [--sec s]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const file = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a));
if (!file) { console.error('usage: node tools/headless/live-roll-test.js "song.nsf" [--song n] [--sec s]'); process.exit(2); }
const song = parseInt(arg('--song', '1'), 10);
const seconds = parseFloat(arg('--sec', '30'));

// 正規化: キー順を揃え、Infinity を文字にし、音符の付随配列はそのまま
function canon(v) {
  if (v === Infinity) return 'inf';
  if (Array.isArray(v)) return v.map(canon);
  // ドラム区画のレーン割当(drumLane/drumSub/drumSubN)は追記側がその場で作る物なので比べない(一括側は受け取り側が後から付ける)
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) if (!/^drum(Lane|Sub|SubN)$/.test(k)) o[k] = canon(v[k]); return o; }
  return v;
}
function tlJson(tl) {
  const tracks = (tl || []).map(t => ({ id: t.id, color: t.color, laneGroup: t.laneGroup, laneCopy: t.laneCopy, tones: t.tones, notes: t.notes }));
  return JSON.stringify(canon(tracks));
}
function hash(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }
function chipsOf(MML, header) {
  const F = MML.NSF.CHIP_FLAGS, flags = header.extraChips || 0, names = [];
  if (flags & F.VRC6) names.push('vrc6'); if (flags & F.VRC7) names.push('vrc7'); if (flags & F.FDS) names.push('fds');
  if (flags & F.MMC5) names.push('mmc5'); if (flags & F.N163) names.push('n163'); if (flags & F.FME7) names.push('fme7');
  return names;
}

(async () => {
  const { MML, global: g } = load({ strict: true });
  const UI = MML.UI;
  const bytes = readBytes(file);
  const header = MML.NSF.parseHeader(bytes);
  const chips = chipsOf(MML, header);
  const SR = 44100, FPS = MML.Emu.FRAME_RATE_NTSC, spf = SR / FPS, frameDur = spf / SR;
  console.log(`${path.basename(file)} song ${song} ${seconds}s chips=[${chips.join(',')}]`);
  const cap = await MML.Emu.captureSongAsync(bytes, { songIndex: song - 1, durationSeconds: seconds, regsOnly: true, sampleRate: SR, yieldFn: () => Promise.resolve() });
  const N = cap.totalFrames;

  // 1) 先読み(従来)
  const batch = UI.buildRollTracksFromRegSnapshots(cap.regSnapshots, cap.writeLog, N, spf, SR, chips, cap.n163Snapshots) || [];
  const batchNotes = batch.reduce((a, t) => a + t.notes.length, 0);
  console.log(`先読み(従来): ${batch.length} tracks, ${batchNotes} notes, hash=${hash(tlJson(batch))}  ← HEAD の worktree と比べる`);

  // 2) 追記: 実際の KeyboardDisplay を通す(DOM はヘッドレスの shim)
  let ok = true;
  let kb = null;
  try {
    kb = new UI.KeyboardDisplay(g.document.createElement('div'));
  } catch (e) {
    console.log(`KeyboardDisplay をヘッドレスで作れませんでした: ${e.message}`);
  }
  if (kb) {
    const state = { regSnapshots: [], writeLog: [], totalFrames: 0, samplesPerFrame: spf, sampleRate: SR };
    kb.setSource(state, chips);
    kb.liveRollBegin({ initRegs: cap.initRegs, initWrites: cap.initWrites });
    const t0 = performance.now();
    let maxMs = 0;
    for (let f = 0; f < N; f++) {
      const a = performance.now();
      kb.liveAppendFrame(cap.writeLog[f]);
      const d = performance.now() - a;
      if (d > maxMs) maxMs = d;
    }
    const total = performance.now() - t0;
    kb.liveRollEnd();
    const live = kb.getRollTimeline() || [];
    const liveNotes = live.reduce((a, t) => a + t.notes.length, 0);
    const openLeft = live.reduce((a, t) => a + t.notes.filter(n => n.open || n.endSec === Infinity).length, 0);
    if (kb.liveFrameCount() !== N) { console.log(`  ★liveFrameCount=${kb.liveFrameCount()} ≠ ${N}`); ok = false; }
    console.log(`追記: ${live.length} tracks, ${liveNotes} notes, 残った未確定=${openLeft}, ${(total / N * 1000).toFixed(1)}µs/frame(平均) 最大 ${maxMs.toFixed(2)}ms/frame, 合計 ${total.toFixed(0)}ms / ${N} frames`);
    if (openLeft) ok = false;
    if (maxMs > 16) { console.log('  ★1フレームの追記が 16ms を超えた'); }

    // 基準: 同じ材料(レジスタ像+間接アクセス音源の履歴だけ)で一括構築
    const ex = { apuEnv: null };
    const st = UI.liveSnapshotSteppers;
    const prime = (s) => { if (cap.initWrites && cap.initWrites.length) s(cap.initWrites); return s; };
    if (chips.includes('vrc7')) ex.vrc7 = cap.writeLog.map(prime(st.vrc7()));
    if (chips.includes('n163')) { const s = prime(st.n163()); ex.n163 = cap.writeLog.map(w => s(w)); ex.n163.maxNumCh = Math.max(1, ...ex.n163.map(x => x.numCh)); }
    if (chips.includes('fme7')) ex.fme7 = cap.writeLog.map(prime(st.fme7()));
    // 追記側と同じレジスタ像(先頭は initRegs、$4015 の既定 0x0F)
    const regs = Object.assign({}, cap.initRegs || {});
    for (const w of (cap.initWrites || [])) if (!w.read && regs[w.addr] === undefined) regs[w.addr] = w.value;
    if (regs[0x4015] === undefined) regs[0x4015] = 0x0F;
    const snaps = new Array(N);
    const dmcStep = st.dmc(); ex.dmcSeq = new Array(N); ex.dmcEnd = new Array(N); // DPCM の通番/終了(追記と同じ)
    for (let f = 0; f < N; f++) {
      for (const w of cap.writeLog[f]) if (!w.read) regs[w.addr] = w.value;
      { const d = dmcStep(cap.writeLog[f], f, regs); ex.dmcSeq[f] = d.seq; ex.dmcEnd[f] = d.end; }
      snaps[f] = (f > 0 && cap.writeLog[f].length === 0) ? snaps[f - 1] : Object.assign({}, regs);
    }
    const ref = UI.buildNoteTimelineFromChannelFrames(f => UI.extractChannels(snaps[f], ex, f, chips), N, frameDur);
    const refNotes = ref.reduce((a, t) => a + t.notes.length, 0);
    const same = tlJson(ref) === tlJson(live);
    console.log(`基準(同じ材料で一括): ${ref.length} tracks, ${refNotes} notes → 追記と${same ? '一致' : '不一致'}`);
    if (!same) {
      ok = false;
      // 最初の違いを示す
      for (const rt of ref) {
        const lt = live.find(t => t.id === rt.id);
        if (!lt) { console.log(`  track ${rt.id} が追記側に無い`); continue; }
        const n = Math.min(rt.notes.length, lt.notes.length);
        for (let i = 0; i < n; i++) {
          if (JSON.stringify(canon(rt.notes[i])) !== JSON.stringify(canon(lt.notes[i]))) {
            console.log(`  ${rt.id}[${i}] 基準=${JSON.stringify(canon(rt.notes[i])).slice(0, 160)}\n           追記=${JSON.stringify(canon(lt.notes[i])).slice(0, 160)}`);
            break;
          }
        }
        if (rt.notes.length !== lt.notes.length) console.log(`  ${rt.id}: 音符数 基準=${rt.notes.length} 追記=${lt.notes.length}`);
      }
    }
    // 先読みとの違いは「材料の差」(エンベロープ実出力/DPCM同定)なので参考値
    console.log(`参考: 先読み(従来)との音符数の差 ${liveNotes - batchNotes}(エンベロープ実出力と DPCM 同定の有無による)`);
  }

  // 4) 過去向きの座標系
  {
    const g1 = UI.makeRollGeom('vertical', 200, 320, 0, 0, true);  // windowSec = 320/80 = 4
    const g0 = UI.makeRollGeom('vertical', 200, 320, 0, 0, false);
    const pos = 10;
    const checks = [
      ['past: 鳴っている音符は縁(t0=0)', JSON.stringify(g1.span(9, Infinity, pos)) === JSON.stringify({ t0: 0, t1: 1 })],
      ['past: 窓より前は null', g1.span(1, 5, pos) === null],
      ['past: 未来は null', g1.span(10.5, 11, pos) === null],
      ['past: 一部だけ窓に', JSON.stringify(g1.span(5, 7, pos)) === JSON.stringify({ t0: 3, t1: 4 })],
      ['past: tOf/absOf', g1.tOf(8, pos) === 2 && g1.absOf(2, pos) === 8],
      ['future: 従来どおり', JSON.stringify(g0.span(11, 12, pos)) === JSON.stringify({ t0: 1, t1: 2 }) && g0.span(5, 9, pos) === null && g0.absOf(2, pos) === 12],
    ];
    for (const [name, pass] of checks) { console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`); if (!pass) ok = false; }
  }
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
