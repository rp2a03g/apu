/*
 * 全部まとめて回す(改修後の一括チェック用)
 *
 *   node tools/headless/check-all.js                        既定コーパスで全形式
 *   node tools/headless/check-all.js --corpus-root "D:/snd"  コーパスの親を変える
 *   node tools/headless/check-all.js --update                ベースライン更新
 *   node tools/headless/check-all.js --skip spc              時間のかかる形式を外す
 *   node tools/headless/check-all.js --no-cpu                CPU命令テストを省く
 *
 * 各コーパスを別プロセスで走らせる(1形式のメモリ肥大や異常終了が他へ波及しないため)。
 * 変化・失敗・CPUテスト失敗のいずれかがあれば exit 1。
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ROOT = 'C:/Users/user/Desktop/emu sound';
const FORMATS = ['nsf', 'spc', 'kss', 'gbs', 'hes', 'vgm'];

function run(args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const root = flag('--corpus-root', DEFAULT_ROOT);
  const update = argv.includes('--update');
  const seconds = flag('--sec', '15');
  const skip = (flag('--skip', '') || '').split(',').filter(Boolean);
  const rows = [];
  let bad = 0;

  for (const f of FORMATS) {
    if (skip.includes(f)) { rows.push([f, 'skip', '', '', '', '']); continue; }
    process.stderr.write(`\n=== ${f} ===\n`);
    const args = [path.join(__dirname, 'regress.js'), '--corpus', `${root}/${f}`, '--sec', seconds];
    if (update) args.push('--update');
    const { code, out } = run(args);
    process.stderr.write(out.split('\n').filter((l) => !/^[.X~ ]*$/.test(l)).join('\n') + '\n');

    const num = (re) => { const m = out.match(re); return m ? m[1] : '?'; };
    const changed = (out.match(/出力が変化した曲: (\d+)/) || [])[1] || '0';
    const uncomp = num(/コンパイル不可: (\d+)/);
    rows.push([f, num(/対象   : (\d+)/), num(/成功   : (\d+)/), num(/失敗   : (\d+)/), uncomp, update ? '-' : changed]);
    if (code !== 0 && code !== 2) bad++;
  }

  // VRC7内蔵音色ROMの写し(src/convert/vrc7Tone.js)がエミュレータ側とずれていないか。
  // 変換の「近いプリセット探し」がずれた表で動くと、鳴らしてみるまで気付けない
  if (!argv.includes('--no-selfcheck')) {
    process.stderr.write('\n=== selfcheck ===\n');
    const { MML } = require('./load').load({ strict: true });
    const emu = JSON.stringify(MML.Emu.VRC7_INST);
    const cnv = JSON.stringify(MML.Convert.Vrc7Tone.PRESETS);
    let ng = emu === cnv ? 0 : 1;
    for (let i = 1; i <= 15; i++) if (MML.Convert.Vrc7Tone.nearestPreset(MML.Convert.Vrc7Tone.PRESETS[i]) !== i) ng++;
    process.stderr.write(ng === 0 ? 'VRC7音色表: 一致 / 自己一致15音色OK\n'
      : `VRC7音色表: ${emu === cnv ? '一致' : '★エミュレータとずれている'} / 自己一致NG\n`);

    // VRC7音色エディタ(src/ui/vrc7ToneEditor.js)の書式が lexer の解釈とずれていないか。
    // ずれると「エディタで開いて反映しただけで音が変わる」ので、往復一致を毎回見る
    const E = MML.UI.Vrc7ToneEditor && MML.UI.Vrc7ToneEditor._internal;
    let ngT = E ? 0 : 1;
    if (E) {
      for (let i = 1; i <= 15; i++) {
        const bytes = MML.Convert.Vrc7Tone.PRESETS[i];
        const patch = E.bytesToPatch(bytes);
        if (JSON.stringify(E.patchToBytes(patch)) !== JSON.stringify(bytes)) { ngT++; continue; }
        for (const kind of ['op', 'ot']) {
          const text = E.formatDefText(0, patch, kind);
          // 本物のコンパイラ(lexer)へ通した結果が元の8バイトへ戻るか
          const c = MML.Mml.compile('#EX-VRC7\n' + text + '\nG @0 OP0 o4 c1', {});
          const got = ((c.envelopes || {}).op || {})[0];
          if (!got || JSON.stringify(Array.from(got)) !== JSON.stringify(bytes)) ngT++;
          // 書き出したテキストを自分で読み戻せるか(コメント入りの@OTを含む)
          const back = E.readPatch('#EX-VRC7\n' + text + '\nG c1', 0);
          if (!back || back.kind !== kind ||
              JSON.stringify(E.patchToBytes(back.patch)) !== JSON.stringify(bytes)) ngT++;
        }
      }
    }
    process.stderr.write(ngT === 0 ? 'VRC7音色エディタ: @OP/@OT の往復一致OK(15音色)\n'
      : `VRC7音色エディタ: ★往復不一致 ${ngT} 件\n`);
    ng += ngT;

    // 逆算(src/ui/vrc7ToneSolver.js): 実チップの出力1周期から持続音のプリセットを探し直して、
    // 見つけたパラメータで鳴らした波形が元と一致するか(0.95以上)。候補の波形を作る厳密モデルが
    // opllNuked.js の演算とずれると、ここで最良候補を外して一致率が落ちる
    const S = MML.UI.Vrc7ToneSolver, Emu = MML.Emu;
    let ngS = (S && E && Emu && Emu.VRC7Audio) ? 0 : 1;
    if (!ngS) {
      const cycleOf = (bytes) => {
        const chip = new Emu.VRC7Audio(1789773);
        const w = (a, v) => { chip.writeRegister(0x9010, a); chip.writeRegister(0x9030, v); };
        for (let i = 0; i < 8; i++) w(i, bytes[i]);
        w(0x30, 0x00); w(0x10, 0xAD); w(0x20, 0x10 | (4 << 1));   // o4 c(fnum 0x0AD, block 4)
        const n = Math.floor(49716 * 0.5), buf = new Float64Array(n);
        for (let i = 0; i < n; i++) { for (let k = 0; k < 36; k++) chip.clock(); buf[i] = chip.mixSample(); }
        const period = Math.round(49716 / (49716 * 0xAD / Math.pow(2, 15)));
        let pi = 0, pa = 0;
        for (let i = 0; i < n - period * 2; i++) { const v = Math.abs(buf[i]); if (v > pa) { pa = v; pi = i; } }
        const start = Math.max(0, pi - (period >> 1));
        return S.resample(buf.subarray(start, start + period), S.N);
      };
      const results = [];
      for (const idx of [5, 8]) {   // Clarinet / Organ(持続音・定常波形あり)
        const bytes = MML.Convert.Vrc7Tone.PRESETS[idx];
        const tgt = cycleOf(bytes);
        const top = S.searchSync(S.analyze(tgt).mag);
        let best = 0;
        for (const c of top) {
          const q = E.bytesToPatch(bytes);
          q.mod.WF = c.dm; q.car.WF = c.dc; q.mod.ML = c.mlm; q.car.ML = c.mlc; q.fb = c.fb; q.mod.TL = c.tl;
          best = Math.max(best, S.corr(tgt, cycleOf(E.patchToBytes(q))));
        }
        results.push(`${MML.Convert.Vrc7Tone.PRESET_NAMES[idx]} ${best.toFixed(3)}`);
        if (best < 0.95) ngS++;
      }
      process.stderr.write((ngS === 0 ? 'VRC7逆算: 一致率OK(' : 'VRC7逆算: ★一致率不足(') + results.join(' / ') + ')\n');
    } else {
      process.stderr.write('VRC7逆算: ★モジュール未読込\n');
    }
    ng += ngS;
    rows.push(['vrc7tone', '-', '-', String(ng), '-', '-']);
    if (ng) bad++;

    // 音色派生(src/convert/toneDerive.js): FM音色→N163波形が矩形波以外になること、
    // 矩形波→VRC7自作音色の逆算が8バイト返し、その音色の定常波形が矩形波と相関0.8以上あること。
    // どちらかが壊れると「FM→N163が全部矩形波」「@0を選んでも@1に落ちる」の退行になる(2026-09-07)
    const TD = MML.Convert.ToneDerive;
    let ngD = (TD && S && Emu.OPLLNuked && Emu.OPLLNuked.presetBytes) ? 0 : 1;
    const dres = [];
    if (!ngD) {
      const isSquare = (w) => w.every((v, i) => v === (i < w.length / 2 ? 15 : 0));
      const organ = TD.toN163(TD.opllSteadyWave(Emu.OPLLNuked.presetBytes('ym2413', 8)));
      if (!organ || organ.length !== 32 || isSquare(organ) || new Set(organ).size < 4) ngD++;
      dres.push(`OPLL Organ→@N ${organ ? new Set(organ).size + '段階' : 'null'}`);
      const opn = TD.toN163(TD.opnSteadyWave({ AL: 4, FB: 3, AMS: 0, PMS: 0,
        ops: [{ TL: 30, ML: 2, SL: 0, SR: 0 }, { TL: 0, ML: 1, SL: 0, SR: 0 }, { TL: 40, ML: 1, SL: 0, SR: 0 }, { TL: 0, ML: 1, SL: 0, SR: 0 }] }));
      if (!opn || isSquare(opn) || new Set(opn).size < 4) ngD++;
      dres.push(`OPN alg4→@N ${opn ? new Set(opn).size + '段階' : 'null'}`);
      // SL(D1L)=15(=減衰しきる)の音色は、定常状態をそのまま採ると無音になり、平坦な=全部8の
      // @N波形=直流=そのchだけ鳴らない、という退行になっていた(2026-09-09。撥弦/リード系の
      // FM音色ではごく普通の設定で、4op音色2160通りの33%がこれに当たっていた)
      const decay = TD.toN163(TD.opnSteadyWave({ AL: 1, FB: 7, AMS: 0, PMS: 0,
        ops: [{ TL: 20, ML: 6, SL: 15, SR: 0 }, { TL: 30, ML: 13, SL: 15, SR: 0 }, { TL: 30, ML: 3, SL: 15, SR: 0 }, { TL: 60, ML: 1, SL: 15, SR: 0 }] }));
      if (!decay || new Set(decay).size < 4) ngD++;
      dres.push(`OPN SL=15→@N ${decay ? new Set(decay).size + '段階' : 'null(平坦)'}`);
      const sq = TD.squareWave(0.5);
      const bytes = TD.vrc7BytesFromWave(sq);
      let c = 0;
      if (bytes && bytes.length === 8) c = S.corr(S.resample(sq, S.N), S.resample(TD.opllSteadyWave(bytes), S.N));
      if (!(c >= 0.8)) ngD++;
      dres.push(`矩形波→VRC7@0 一致率 ${c.toFixed(3)}`);
    }
    process.stderr.write((ngD === 0 ? '音色派生: OK(' : '音色派生: ★NG(') + dres.join(' / ') + ')\n');
    rows.push(['tonederive', '-', '-', String(ngD), '-', '-']);
    if (ngD) bad++;
  }

  if (!argv.includes('--no-cpu')) {
    process.stderr.write('\n=== cpu ===\n');
    const { code, out } = run([path.join(__dirname, 'cpu-test.js'), 'all', '--per', '200']);
    process.stderr.write(out.split('\n').filter((l) => !/^[.X? -]*$/.test(l)).join('\n') + '\n');
    rows.push(['cpu', '-', '-', code === 0 ? '0' : 'NG', '-', '-']);
    if (code !== 0) bad++;
  }

  if (!argv.includes('--no-help')) {
    process.stderr.write('\n=== help ===\n');
    const { code, out } = run([path.join(__dirname, 'help-lint.js')]);
    process.stderr.write(out.trim() + '\n');
    const items = (out.match(/項目 (\d+)/) || [])[1] || '?';
    const errs = (out.match(/エラー (\d+)/) || [])[1] || '?';
    const missing = (out.match(/未掲載 (\d+)/) || [])[1] || '?';
    rows.push(['help', items, '-', errs, '-', missing + ' 未掲載']);
    if (code !== 0) bad++;
  }

  console.log('\n' + '='.repeat(64));
  console.log('形式    対象    成功    失敗  ｺﾝﾊﾟｲﾙ不可    変化');
  for (const r of rows) {
    console.log(`${String(r[0]).padEnd(7)} ${String(r[1]).padStart(5)} ${String(r[2]).padStart(7)} ${String(r[3]).padStart(7)} ${String(r[4]).padStart(11)} ${String(r[5]).padStart(7)}`);
  }
  console.log('='.repeat(64));
  console.log(bad === 0 ? '✅ 変化・新規失敗なし' : `❌ ${bad} 項目に変化または失敗`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
