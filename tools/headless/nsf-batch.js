/*
 * 「変換 → コンパイル → NSF書き出し」を一括でやる耳検証用CLI
 *
 *   node tools/headless/nsf-batch.js "D:/snd/nsf/foo.nsf"            # 1曲
 *   node tools/headless/nsf-batch.js "D:/snd/spc" --out _out         # フォルダごと
 *   node tools/headless/nsf-batch.js "pack.zip" --songs all --sec 60 # zip内全部・曲番号も全部
 *   node tools/headless/nsf-batch.js "D:/snd/nsf" --per-game        # 元ファイルごとにフォルダを分ける
 *
 * 出力先(既定 _out/)に、曲ごとに
 *   <名前>.mml   変換結果(ブラウザでそのまま開ける)
 *   <名前>.nsf   その MML をコンパイルして ppmck ドライバに載せたもの(実機/NSFPlayで聴ける)
 *   <名前>.wav   --wav を付けたときだけ(ブラウザ再生と同じ描画)
 *   *.dmc        @DPCM が出た曲のサンプル(.mml と同じフォルダに置けば再読込できる)
 *   _report.txt  一覧(下の1行表示と同じもの)
 * を書く。元曲を聴き比べながら「変換が合っているか」を耳で確かめるための道具で、
 * 判定はしない(機械判定は audio-check.js / mml-check.js、回帰は check-all.js の担当)。
 *
 * 変換そのものは convert.js の convertBytes をそのまま呼ぶので、UI・regress と同じ結果になる。
 * NSF書き出しは mml-check.js と同じ経路(Mml.compile → Driver.buildBankedNsfBytes)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { expandInput, convertBytes, probe, defaultSong, parseCmdFlags, ctx, SONG_EXTS } = require('./convert');

const ARCHIVE_EXTS = ['zip', '7z'];
const ALL_EXTS = SONG_EXTS.concat(ARCHIVE_EXTS);

function extOf(name) { return path.extname(name).toLowerCase().replace('.', ''); }

/** 引数(ファイル/フォルダ)を入力ファイルの一覧に広げる。フォルダは再帰 */
function expandPaths(args) {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name));
      return;
    }
    if (ALL_EXTS.includes(extOf(p))) out.push(p);
  };
  for (const a of args) {
    if (!fs.existsSync(a)) { console.error(`見つからない: ${a}`); continue; }
    walk(a);
  }
  return out;
}

/** Windowsのファイル名に使えない文字を潰す */
function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+$/, '').slice(0, 120) || 'song';
}

/**
 * --songs の解決。
 * 「曲番号」の意味はフォーマットごとに違う(convert.js の defaultSong 参照)ので、
 * all のときだけ形式ごとの並べ方を使い分ける。nsf/gbs は0始まりのインデックス、
 * kss/hes はヘッダの開始番号からの連番(hes の firstTrack は0/1始まりの規約が無い)。
 */
function songList(spec, format, header, name) {
  const base = defaultSong(format, header);
  const n = header.totalSongs || header.songCount || header.numSongs || 1;
  const single = ['spc', 'vgm', 'psf'].includes(format);
  if (!spec) return [base];
  if (spec === 'all') {
    if (single) return [base];
    const start = (format === 'nsf' || format === 'gbs') ? 0 : base;
    return Array.from({ length: n }, (_, i) => start + i);
  }
  const want = spec.split(',').map(s => parseInt(s.trim(), 10)).filter(x => !isNaN(x));
  if (single) return [base];
  // 曲番号が範囲外だと「同じ曲を名前だけ変えて何本も書く」ことになる(気づきにくいので落とす)。
  // 番号の意味が0始まりのインデックスだと分かっているフォーマットだけ弾く
  // (hes の firstTrack は規約が無く、kss は宣言より多い曲を持つことがある)
  if (format === 'nsf' || format === 'gbs') {
    const ok = want.filter(x => x >= 0 && x < n);
    for (const x of want.filter(x => !ok.includes(x))) console.error(`⚠ ${name}: 曲番号 ${x} は範囲外(0..${n - 1})なので飛ばす`);
    return ok;
  }
  return want;
}

function writeWav(file, a, sr) {
  const n = a.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

/**
 * 1曲ぶん: 変換 → .mml/.dmc → compile → .nsf(→ .wav)
 * @returns {{name:string, line:string, ok:boolean}}
 */
async function makeOne(item, bytes, song, opt) {
  const MML = ctx();
  // 同名の元ファイルが別フォルダにあると出力先がぶつかる(コーパスに1件あった:
  // 素の .nsf と、同名を収めたサブフォルダ)。先に書いた曲を黙って上書きしないよう連番で逃がす
  let stem = safeName(path.basename(item.name, path.extname(item.name)) + (opt.songSuffix ? `_s${song}` : ''));
  if (opt.seen) {
    const key = () => path.join(opt.out, stem).toLowerCase();  // Windowsは大小同一視
    const base = stem;
    for (let k = 2; opt.seen.has(key()); k++) stem = `${base}_${k}`;
    opt.seen.add(key());
  }
  const mmlPath = path.join(opt.out, stem + '.mml');
  const nsfPath = path.join(opt.out, stem + '.nsf');

  if (opt.skipExisting && fs.existsSync(nsfPath)) return { name: stem, ok: true, line: `${stem}  (既にある・省略)` };

  // resolveLib を渡さないと PSF の _lib(共通ドライバ)を引けない(convertFile と同じ受け渡し)
  const r = await convertBytes(bytes, item.format,
    { song, seconds: opt.seconds, cmd: opt.cmd, resolveLib: item.resolveLib || null });

  // @DPCM のサンプルは .mml と同じフォルダへ(ブラウザの「同フォルダ書き出し」と同じ置き方)。
  // コンパイルにも実バイトが要るので、名前→バイト列の対応表をそのまま compile に渡す。
  // ★名前は曲をまたいで衝突する(どの曲も dpcm_0.dmc から振り直す)。中身が違うのに
  //   上書きすると、先に書いた曲の .mml が後の曲のサンプルを指してしまうので、
  //   中身が違うときだけ曲名を頭に付けて別ファイルにし、MML本文の参照も差し替える
  let mml = r.mml;
  const dpcmSamples = {};
  for (const f of (r.files || [])) {
    let name = safeName(f.name);
    const p = path.join(opt.out, name);
    if (fs.existsSync(p) && !Buffer.from(f.bytes).equals(fs.readFileSync(p))) {
      name = `${stem}__${name}`;
      mml = mml.split(`"${f.name}"`).join(`"${name}"`);
    }
    fs.writeFileSync(path.join(opt.out, name), Buffer.from(f.bytes));
    dpcmSamples[name] = f.bytes;
  }
  fs.writeFileSync(mmlPath, mml);

  const compiled = MML.Mml.compile(mml, { dpcmSamples });
  const chips = (r.expansions || []).join(',') || '2a03';
  const head = `${stem}  ${item.format}/${chips}  bpm${Math.round(r.bpm || 0)}  ${r.mml.split('\n').length}行`;

  if (compiled.errors && compiled.errors.length) {
    return { name: stem, ok: false, line: `❌ ${head}  コンパイルエラー ${compiled.errors.length}件: ${compiled.errors[0].message}` };
  }

  const meta = compiled.meta || {};
  const built = MML.Driver.buildBankedNsfBytes(compiled, {
    songName: meta.title || item.name, artist: meta.composer || '', copyright: meta.maker || '',
    totalSongs: 1, startingSong: 1,
  });
  if (built.asmErrors && built.asmErrors.length) {
    return { name: stem, ok: false, line: `❌ ${head}  NSFドライバのアセンブル失敗: ${built.asmErrors[0].message}` };
  }
  fs.writeFileSync(nsfPath, Buffer.from(built.nsfBytes));

  if (opt.wav) {
    const render = MML.Mml.render(mml, { sampleRate: opt.sr, dpcmSamples });
    let audio = render.audio;
    if (opt.seconds > 0 && audio.length > opt.seconds * opt.sr) audio = audio.subarray(0, Math.floor(opt.seconds * opt.sr));
    writeWav(path.join(opt.out, stem + '.wav'), audio, opt.sr);
  }

  const warn = [];
  if (compiled.warnings && compiled.warnings.length) warn.push(`⚠警告${compiled.warnings.length}`);
  if (built.unsupportedExpansions && built.unsupportedExpansions.length) warn.push(`⚠NSF非対応 ${built.unsupportedExpansions.join(',')}`);
  return {
    name: stem, ok: true,
    line: `✅ ${head}  NSF ${built.nsfBytes.length}B(${built.bankCount}banks)${warn.length ? '  ' + warn.join(' ') : ''}`,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  // 値を取るオプションの「次の語」は入力パスではない
  const VALUE_FLAGS = ['--out', '--sec', '--songs', '--preset', '--cmd', '--sr', '--max'];
  const inputs = argv.filter((a, i) => !a.startsWith('-') && !(i > 0 && VALUE_FLAGS.includes(argv[i - 1])));
  if (!inputs.length) {
    console.error('usage: node tools/headless/nsf-batch.js <ファイル|フォルダ...> [--out DIR] [--sec 30] [--songs all|0,2,5] [--max N]');
    console.error('                                       [--preset plain|faithful] [--cmd D=0,EP=0,...] [--wav] [--sr 48000] [--skip-existing] [--per-game]');
    process.exit(2);
  }

  const opt = {
    out: path.resolve(flag('--out', '_out')),
    seconds: parseInt(flag('--sec', '30'), 10),
    sr: parseInt(flag('--sr', '48000'), 10),
    wav: argv.includes('--wav'),
    max: parseInt(flag('--max', '0'), 10) || 0,
    perGame: argv.includes('--per-game'),
    skipExisting: argv.includes('--skip-existing'),
    cmd: parseCmdFlags(flag('--preset', null), flag('--cmd', null)),
  };
  const songsSpec = flag('--songs', null);
  fs.mkdirSync(opt.out, { recursive: true });

  const files = expandPaths(inputs);
  if (!files.length) { console.error('変換対象が無い'); process.exit(1); }

  // 何曲になるかを先に数えて出す(zipを丸ごと渡したときに桁を間違えて気づけるように。
  // 1本のzipに47曲入っていることがあるので、多すぎるときは --max で頭から何曲かに絞る)
  const jobs = [];
  for (const file of files) {
    let items;
    try { items = await expandInput(file); }
    catch (e) { console.error(`❌ ${path.basename(file)}: ${e.message}`); continue; }
    if (!items.length) { console.error(`⚠ ${path.basename(file)}: 対応する曲が入っていない`); continue; }
    if (opt.max && items.length > opt.max) {
      console.error(`⚠ ${path.basename(file)}: ${items.length} エントリのうち先頭 ${opt.max} 件だけ`);
      items = items.slice(0, opt.max);
    }
    for (const item of items) jobs.push({ file, item });
  }
  console.error(`入力 ${files.length} ファイル / ${jobs.length} エントリ → ${opt.out}(各 ${opt.seconds} 秒)\n`);

  const lines = [];
  const seen = new Set();   // 出力先(フォルダ+名前)の重複を見張る
  let done = 0, ng = 0, i = 0;
  for (const { file, item } of jobs) {
    i++;
    // --per-game: 出力先を「元ファイル1本=1フォルダ」に分ける。アーカイブは中身が
    // 同じゲームの曲なのでアーカイブ名でまとめる(曲ごとではない)
    const outDir = opt.perGame ? path.join(opt.out, safeName(path.basename(file, path.extname(file)))) : opt.out;
    if (outDir !== opt.out) fs.mkdirSync(outDir, { recursive: true });
    let bytes, songs;
    try {
      bytes = await item.read();
      const p = await probe(bytes, item.format);
      songs = songList(songsSpec, item.format, p.header, item.name);
    } catch (e) {
      ng++; const line = `❌ ${item.name}: ${e.message}`;
      console.log(`[${i}/${jobs.length}] ${line}`); lines.push(line); continue;
    }
    for (const song of songs) {
      try {
        const r = await makeOne(item, bytes, song, Object.assign({ songSuffix: songs.length > 1 }, opt, { out: outDir, seen }));
        if (r.ok) done++; else ng++;
        console.log(`[${i}/${jobs.length}] ${r.line}`);
        lines.push(r.line);
      } catch (e) {
        ng++; const line = `❌ ${item.name} (song ${song}): ${e.message}`;
        console.log(`[${i}/${jobs.length}] ${line}`); lines.push(line);
      }
    }
  }

  fs.writeFileSync(path.join(opt.out, '_report.txt'), lines.join('\n') + '\n');
  console.error(`\n書き出し ${done} 曲 / 失敗 ${ng} 曲 → ${opt.out}`);
  if (ng) process.exitCode = 1;
}

main().catch((e) => { console.error(`失敗: ${e.stack || e.message}`); process.exit(1); });
