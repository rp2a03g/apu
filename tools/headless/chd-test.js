#!/usr/bin/env node
/*
 * CHD(MAME の圧縮ディスクイメージ)の CD の読み取りの確認。同じディスクの cue+bin と突き合わせる。
 *   node tools/headless/chd-test.js "disc.chd" "disc.cue"
 * CHD は手元の chdman で作る:  chdman createcd -i disc.cue -o disc.chd [-c cdzl | -c cdfl]
 *   - トラックの表(番号、音声かデータか、始まりと終わりのセクタ)が cue から作った物と同じか
 *   - データのトラックの全セクタ(2048 バイト)と、音声のトラックの全サンプルが同じか
 * どの圧縮が何かたまり使われているかも出す(cdlz / cdzl / cdfl / 無圧縮 / 同じ中身の使い回し)。
 */
'use strict';
const fs = require('fs'), path = require('path');
const { load, readBytes } = require('./load'); const { MML } = load({ strict: true });
const E = MML.Emu; let bad = 0; const ok = (c, m) => { console.log((c ? 'OK  ' : 'NG  ') + m); if (!c) bad++; };
const [chdFile, cueFile] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!chdFile || !cueFile) { console.error('usage: node tools/headless/chd-test.js "disc.chd" "disc.cue"'); process.exit(2); }

(async () => {
  const bytes = readBytes(chdFile);
  ok(E.Chd.isChd(bytes), 'CHD と見分ける');
  const chd = E.Chd.open(bytes);
  const names = chd.compressors.map(c => c ? String.fromCharCode(c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255) : '-');
  const use = {}; for (let i = 0; i < chd.hunkCount; i++) { const t = chd.mapComp[i], k = t < 4 ? names[t] : t === 4 ? '無圧縮' : '使い回し'; use[k] = (use[k] || 0) + 1; }
  console.log(`かたまり ${chd.hunkCount} 個(1 個 ${chd.hunkBytes} バイト)、圧縮 ${names.join(' ')}、内訳 ${Object.keys(use).map(k => k + ' ' + use[k]).join('、')}`);
  const t0 = Date.now(); let prog = 0;
  const set = await E.Chd.toCdSet(bytes, () => { prog++; });
  console.log(`展開 ${((Date.now() - t0) / 1000).toFixed(1)} 秒、途中の知らせ ${prog} 回、トラック ${set.files.length}、合計 ${(set.files.reduce((a, f) => a + f.data.length, 0) / 1048576).toFixed(0)}MB`);
  const a = E.PceDisc.fromSet(set);
  const dir = path.dirname(cueFile), cueText = fs.readFileSync(cueFile, 'latin1');
  const files = fs.readdirSync(dir).filter(n => /\.(bin|img|iso|wav|raw)$/i.test(n)).map(n => ({ name: n, data: readBytes(path.join(dir, n)) }));
  const b = E.PceDisc.fromSet({ kind: 'cue', text: cueText, files });
  const row = (t) => `${t.number}:${t.audio ? 'A' : 'D'}:${t.first}-${t.last}`;
  const ta = a.tracks.map(row).join(' '), tb = b.tracks.map(row).join(' ');
  ok(ta === tb, `トラックの表が同じ(${a.tracks.length} トラック、${a.sectorCount} セクタ)`);
  if (ta !== tb) { console.log('  CHD: ' + ta.slice(0, 400)); console.log('  cue: ' + tb.slice(0, 400)); }
  let dataSec = 0, dataBad = 0, audSec = 0, audBad = 0, firstBad = -1; const x = new Uint8Array(2048), y = new Uint8Array(2048);
  for (const t of b.tracks) {
    for (let s = t.first; s <= t.last; s++) {
      if (!t.audio) {
        dataSec++; a.readData(s, x); b.readData(s, y);
        let same = true; for (let i = 0; i < 2048; i++) if (x[i] !== y[i]) { same = false; break; }
        if (!same) { dataBad++; if (firstBad < 0) firstBad = s; }
      } else {
        audSec++; let same = true;
        for (let n = 0; n < 588 && same; n++) if (a.sample(s, n, 0) !== b.sample(s, n, 0) || a.sample(s, n, 1) !== b.sample(s, n, 1)) same = false;
        if (!same) { audBad++; if (firstBad < 0) firstBad = s; }
      }
    }
  }
  ok(dataSec > 0 && dataBad === 0, `データの ${dataSec} セクタが同じ(違い ${dataBad})`);
  ok(audSec > 0 && audBad === 0, `音声の ${audSec} セクタ(${audSec * 588} サンプル)が同じ(違い ${audBad})`);
  if (firstBad >= 0) console.log('  最初に違ったセクタ ' + firstBad);
  ok(a.signature === b.signature, 'ディスクの見分けの数(ステート用)が同じ');
  console.log(bad ? `NG ${bad} 件` : '全部 OK');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
