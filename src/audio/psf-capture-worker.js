/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built by tools/build-capture-workers.ps1 at 2026-09-18 03:02:26
 *
 * regsOnly capture worker bundle (psfCapture). Loaded on the main thread as a plain
 * script, but the emulator code inside MML.WorkerBundles.psfCapture is never
 * executed there; capture-worker-client.js stringifies it into a Blob Worker.
 */
(function (global) {
  var MML = global.MML = global.MML || {};
  MML.WorkerBundles = MML.WorkerBundles || {};
  MML.WorkerBundles.psfCaptureBuiltAt = '2026-09-18 03:02:26';
  MML.WorkerBundles.psfCapture = function () {
/*
 * PSF (Portable Sound Format) 容器 / PS-EXE 解析
 * MML.PSF
 *
 *   PSF.parse(bytes)            → { version, reserved, program(圧縮のまま), crc, tags, tagOrder }
 *   PSF.inflateProgram(psf)     → Promise<Uint8Array>  zlib展開(DecompressionStream 'deflate')
 *   PSF.parseExe(bytes)         → { pc, gp, sp, textAddr, textSize, text }  PS-X EXE ヘッダ
 *   PSF.load(bytes, resolveLib) → Promise<{ pc, sp, gp, segments, tags, refresh, libs, lengthMs, fadeMs }>
 *   PSF.parseTime(str)          → ms  ("mm:ss.ddd" / "ss.ddd" / "h:mm:ss")
 *
 * 対象は PSF1 (version 0x01、PlayStation)。version 0x02 (PSF2) は容器の解析までで、load() は拒否する。
 *
 * _lib 連鎖(Highly Experimental / psflib.c 準拠):
 *   1. _lib があればそれを先に(再帰的に)読み込む
 *   2. 自身のテキスト区間を上書き
 *   3. _lib2, _lib3, … を順に上書き
 *   初期 PC/SP/GP は「最初に読み込んだEXE」(最深の_lib)のものを採る。
 *   タグは本体のものを使い、_refresh だけは本体に無ければ_lib側から拾う。
 *
 * 外部ライブラリは使わない(INV-1)。DOM非依存(INV-4)。Worker内でも動く。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const PSF = MML.PSF = MML.PSF || {};
  const tr = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  const VERSION_NAMES = { 0x01: 'PSF1', 0x02: 'PSF2', 0x11: 'SSF', 0x12: 'DSF', 0x13: 'USF', 0x21: 'QSF', 0x22: 'GSF', 0x23: '2SF', 0x41: 'SNSF' };

  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  // ── CRC32 (zlib互換、テーブル方式) ────────────────────────────
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  PSF.crc32 = crc32;

  // ── タグ文字列のデコード ─────────────────────────────────────
  // 規約上は Latin-1(utf8=1 の時だけUTF-8)だが、実在ファイルは UTF-8/Shift-JIS が混在する。
  // UTF-8として妥当ならUTF-8、駄目なら Shift-JIS、それも駄目なら Latin-1 に落とす。
  function decodeTagBytes(bytes, forceUtf8) {
    if (typeof TextDecoder === 'undefined') {
      let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s;
    }
    const tryDecode = (enc) => { try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch (e) { return null; } };
    let s = tryDecode('utf-8');
    if (s !== null) return s;
    if (!forceUtf8) { s = tryDecode('shift_jis'); if (s !== null) return s; }
    return new TextDecoder('latin1').decode(bytes);
  }

  function isAsciiOnly(bytes) { for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) return false; return true; }

  /**
   * [TAG] 以降を解析する。同じキーが複数行あれば改行で連結(規約どおり)。
   * @returns {{tags:Object<string,string>, tagOrder:string[]}}
   */
  function parseTags(bytes, start) {
    const tags = Object.create(null);
    const order = [];
    if (start + 5 > bytes.length) return { tags, tagOrder: order };
    if (String.fromCharCode(bytes[start], bytes[start + 1], bytes[start + 2], bytes[start + 3], bytes[start + 4]) !== '[TAG]') {
      return { tags, tagOrder: order };
    }
    const body = bytes.subarray(start + 5);
    // 先に utf8 タグの有無を(ASCIIで)見てから全体をデコードする
    let forceUtf8 = false;
    if (!isAsciiOnly(body)) {
      const ascii = new TextDecoder('latin1').decode(body);
      forceUtf8 = /(^|\n)\s*utf8\s*=/.test(ascii);
    }
    const text = decodeTagBytes(body, forceUtf8);
    for (const rawLine of text.split(/\r?\n|\r/)) {
      const eq = rawLine.indexOf('=');
      if (eq < 0) continue;
      const key = rawLine.slice(0, eq).trim().toLowerCase();
      const val = rawLine.slice(eq + 1).trim();
      if (!key) continue;
      if (key in tags) tags[key] += '\n' + val;
      else { tags[key] = val; order.push(key); }
    }
    return { tags, tagOrder: order };
  }

  /**
   * PSF容器を解析する(同期。プログラムは圧縮のまま返す)
   * @param {Uint8Array} bytes
   */
  PSF.parse = function (bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length < 16 || bytes[0] !== 0x50 || bytes[1] !== 0x53 || bytes[2] !== 0x46) {
      throw new Error(tr('PSFファイルではありません(先頭が "PSF" ではない)'));
    }
    const version = bytes[3];
    const reservedSize = u32(bytes, 4);
    const programSize = u32(bytes, 8);
    const crc = u32(bytes, 12);
    if (16 + reservedSize + programSize > bytes.length) {
      throw new Error(tr('PSFファイルが途中で切れています'));
    }
    const reserved = bytes.subarray(16, 16 + reservedSize);
    const program = bytes.subarray(16 + reservedSize, 16 + reservedSize + programSize);
    const { tags, tagOrder } = parseTags(bytes, 16 + reservedSize + programSize);
    return {
      version, versionName: VERSION_NAMES[version] || ('0x' + version.toString(16)),
      reserved, program, crc, tags, tagOrder,
    };
  };

  /** 圧縮プログラムを zlib 展開する。CRC不一致は例外(壊れたファイルを黙って鳴らさない) */
  PSF.inflateProgram = async function (psf) {
    if (psf.program.length === 0) return new Uint8Array(0);
    const actual = crc32(psf.program);
    if (actual !== psf.crc) {
      throw new Error(tr('PSFのCRCが一致しません(期待 {expected} / 実際 {actual})', {
        expected: psf.crc.toString(16).padStart(8, '0'), actual: actual.toString(16).padStart(8, '0') }));
    }
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unsupported');
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(psf.program);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
  };

  /**
   * PS-X EXE ヘッダ(0x800バイト)を解析する
   * 0x00 "PS-X EXE"  0x10 初期PC  0x14 初期GP  0x18 テキスト先頭アドレス  0x1C テキストサイズ
   * 0x30 初期SP(スタック基底)  0x34 スタックサイズ
   */
  PSF.parseExe = function (bytes) {
    if (bytes.length < 0x800) throw new Error(tr('PS-EXEが短すぎます(ヘッダ0x800バイト未満)'));
    let magic = '';
    for (let i = 0; i < 8; i++) magic += String.fromCharCode(bytes[i]);
    if (magic !== 'PS-X EXE') throw new Error(tr('PS-EXEのマジックが不正です: {magic}', { magic }));
    const pc = u32(bytes, 0x10);
    const gp = u32(bytes, 0x14);
    const textAddr = u32(bytes, 0x18);
    const declaredTextSize = u32(bytes, 0x1C);
    const sp = u32(bytes, 0x30);
    const spSize = u32(bytes, 0x34);
    // ヘッダの text サイズは信用しない。PSF プレイヤー(psflib/Highly Experimental)と同じく
    // 0x800 以降の中身を全部載せる。実在ファイルに両方向のずれがある:
    //   Ogre Battle は宣言 103960 に対し実体 1.64MB(曲データが宣言の外にある)、
    //   Ridge Racer Revolution は宣言 262144 に対し実体 65536。
    const textSize = bytes.length - 0x800;
    return { pc, gp, sp, spSize, textAddr, textSize, declaredTextSize, text: bytes.subarray(0x800) };
  };

  /** "h:mm:ss.ddd" / "mm:ss.ddd" / "ss.ddd" → ms。解釈不能なら null */
  PSF.parseTime = function (str) {
    if (str == null) return null;
    const s = String(str).trim();
    if (!s) return null;
    const parts = s.split(':');
    if (parts.length > 3) return null;
    let ms = 0;
    for (const p of parts) {
      const v = parseFloat(p);
      if (!isFinite(v)) return null;
      ms = ms * 60 + v * 1000;
    }
    return Math.round(ms);
  };

  /**
   * PSF1を _lib 連鎖ごと読み込む。
   * @param {Uint8Array} bytes 本体のPSF
   * @param {function(string):Promise<Uint8Array|null>} resolveLib _libタグの名前から兄弟ファイルの内容を返す
   * @returns {Promise<object>} { version, pc, sp, gp, segments:[{addr,data,name}], tags, refresh, libs:[name], lengthMs, fadeMs, title }
   */
  PSF.load = async function (bytes, resolveLib, _depth, _state) {
    const depth = _depth | 0;
    if (depth > 10) throw new Error(tr('_libの入れ子が深すぎます(循環参照?)'));
    const psf = PSF.parse(bytes);
    if (psf.version !== 0x01) {
      throw new Error(tr('{name} は未対応です(対応はPSF1のみ)', { name: psf.versionName }));
    }
    const state = _state || { first: true, pc: 0, sp: 0, gp: 0, segments: [], libs: [], refresh: 0 };
    const loadLib = async (name) => {
      if (!resolveLib) throw new Error(tr('_lib "{name}" を解決できません(同じ場所に置いてください)', { name }));
      const libBytes = await resolveLib(name);
      if (!libBytes) throw new Error(tr('_lib "{name}" が見つかりません', { name }));
      state.libs.push(name);
      await PSF.load(libBytes, resolveLib, depth + 1, state);
    };
    if (psf.tags._lib) await loadLib(psf.tags._lib);
    // 自身
    if (psf.program.length) {
      const exeBytes = await PSF.inflateProgram(psf);
      const exe = PSF.parseExe(exeBytes);
      if (state.first) { state.first = false; state.pc = exe.pc; state.sp = exe.sp; state.gp = exe.gp; }
      state.segments.push({ addr: exe.textAddr, data: exe.text, pc: exe.pc, sp: exe.sp, gp: exe.gp });
    }
    if (!state.refresh && psf.tags._refresh) state.refresh = parseInt(psf.tags._refresh, 10) || 0;
    for (let i = 2; i < 100; i++) {
      const key = '_lib' + i;
      if (!psf.tags[key]) break;
      await loadLib(psf.tags[key]);
    }
    if (depth > 0) return state;
    if (state.first) throw new Error(tr('PSFに実行プログラムが含まれていません'));
    const tags = psf.tags;
    const refresh = (parseInt(tags._refresh, 10) || state.refresh || 60);
    return {
      version: psf.version,
      pc: state.pc, sp: state.sp, gp: state.gp,
      segments: state.segments,
      tags, tagOrder: psf.tagOrder,
      refresh: refresh === 50 ? 50 : 60,
      libs: state.libs,
      lengthMs: PSF.parseTime(tags.length),
      fadeMs: PSF.parseTime(tags.fade),
      title: tags.title || '',
    };
  };
})(globalThis);

/*
 * 再生ログ一括キャプチャ（プリレンダー）
 * MML.Emu.captureSong / MML.Emu.dcBlock
 *
 * INIT実行後、指定秒数分のPLAYルーチンを毎フレーム実行し、
 * - 全レジスタ書き込みのタイムラインログ
 * - 全フレーム分の音声波形（DCブロック済み）
 * を一括生成する。生成後はシーク・早送り・巻き戻しが
 * 音声バッファへのアクセスのみで完結する。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  /**
   * KSS形式writeLogの1書込みを1つの整数へ詰める(2026-09-04)。
   *   bit0-15 = addr(メモリアドレス or I/Oポート) / bit16-23 = value / bit24 = io(1ならI/O)
   *
   * {addr,value,io}のJSオブジェクトは実測75〜90B/件で、KSSは1フレーム平均84〜152件書くため
   * 60秒で27〜41MB(実RSS)を占めていた。詰めればフレームごとの Int32Array で4B/件になる
   * (実測 xak.kss 60秒: 27MB → 1.2MB)。型付き配列なので構造化クローン(キャプチャWorkerの
   * 差分送信)もそのまま通る。読む側は kss2mml/expansion/*.js と kss-stream-player.js と
   * roll-builders.js。
   *
   * ★定義場所はここ(capture.js)。KSS(kssPlayer.js)とVGM(vgmPlayer.js: AY/SSG/SCC/OPLL/OPLの
   *   書込みをKSS形式で積む)の両方が使い、両方のWorkerバンドルに入る唯一の共通ファイルのため。
   *   以前は kssPlayer.js にあり、VGMのWorkerバンドル(kssPlayer.jsを含まない)で
   *   「Emu.kssPackWrite is not a function」で落ちて、AY/SSG/OPLを使うVGMのロールが空になる
   *   (途中で落ちると取得済み範囲で打ち切られる)不具合の原因になっていた(2026-09-07)。
   */
  // frac: フレーム内の書込み時刻(0〜1、省略時0)を bit25-30 に 1/64 フレーム刻みで詰める(2026-09-08)。
  // kss2mml の AY/SCC 抽出器がソフトエンベロープの位相エイリアシング対策(hes2mml/expansion/wave.js
  // resampleSeq)に使う。writeLog の形(Int32Array のフレーム配列)は変えないので Worker プロトコルと
  // ロール構築(addr/value/io だけを見る)はそのまま。旧ログ(frac 無し)は 0 として扱われ従来どおり
  Emu.kssPackWrite = (addr, value, io, frac) => (addr & 0xFFFF) | ((value & 0xFF) << 16) | (io ? 0x1000000 : 0) |
    ((frac > 0 ? Math.min(63, Math.round(frac * 64)) : 0) << 25);
  Emu.kssUnpackFrac = (pw) => ((pw >>> 25) & 0x3F) / 64;

  /**
   * チャンネルごとのミュート設定をチップの mute プロパティへ反映する。
   * target がオブジェクトならキー一致、配列ならインデックス一致で上書きする。
   */
  Emu.applyMute = function (target, source) {
    if (!target || !source) return;
    if (Array.isArray(target)) {
      for (let i = 0; i < target.length; i++) {
        if (source[i] !== undefined) target[i] = !!source[i];
      }
    } else {
      for (const k of Object.keys(target)) {
        if (source[k] !== undefined) target[k] = !!source[k];
      }
    }
  };

  /**
   * チャンネルごとの音量(0〜2、1=100%で2まではブースト)設定をチップの vol プロパティへ
   * 反映する。applyMuteと同じkey/index一致方式(未指定のチャンネルは既存値=通常1のまま
   * 変更しない)。
   */
  Emu.applyVolume = function (target, source) {
    if (!target || !source) return;
    if (Array.isArray(target)) {
      for (let i = 0; i < target.length; i++) {
        if (source[i] !== undefined) target[i] = Math.max(0, Math.min(2, source[i]));
      }
    } else {
      for (const k of Object.keys(target)) {
        if (source[k] !== undefined) target[k] = Math.max(0, Math.min(2, source[k]));
      }
    }
  };

  // NESの非線形ミキサー出力(DCオフセット付き)をAC成分に変換するDCブロッカー
  Emu.dcBlock = function (samples) {
    const out = new Float32Array(samples.length);
    let prevX = 0, prevY = 0;
    const R = 0.999;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = x - prevX + R * prevY;
      out[i] = y;
      prevX = x;
      prevY = y;
    }
    return out;
  };

  /**
   * 楽曲キャプチャの共通セットアップ。player・バッファ・ログ配列を返す。
   * @private
   */
  function _setupCapture(nsfBytes, opt) {
    const songIndex = opt.songIndex || 0;
    const durationSeconds = opt.durationSeconds || 10;
    const sampleRate = opt.sampleRate || 44100;

    const player = new Emu.NsfPlayer(nsfBytes);
    // initSong の書き込みを runningRegs に先取りしてスナップショットの初期状態とする。
    // initWrites は同じ書き込みを順序付きで(重複アドレスも全て)記録したもの。
    // $F800/$4800(N163)・$C000/$E000(FME7)・$9010/$9030(VRC7)のようなラッチ+データ間接
    // アドレッシングのチップは、runningRegsの最終値スナップショットだけでは内部レジスタ
    // 全体を復元できない(同じ2アドレスに何度も書き込むため)ので、拡張音源の
    // buildTimeline側で書き込みシーケンスをそのまま再生できるようにこちらも保持する。
    const runningRegs = {};
    const initWrites = [];
    // NsfPlayer.initSong()は$4017(フレームカウンタリセット)・$4015(全チャンネル有効化)を
    // bus.write()を経由せずAPU.writeRegister()へ直接書き込むため、onWriteフックを
    // 通らずinitWritesに記録されない。NSF自体のINITルーチンがこれらを書き直さない曲
    // (例: アルマナの軌跡のようなFDS曲で2A03パルス/三角/ノイズ側を$4015再設定しない
    // ドライバ)だと、initWritesの再生だけで音源を組み立てるNsfReplayStreamPlayerでは
    // $4015が一度も有効化されず2A03が全チャンネル無音になる不具合があった。
    // initSong()内部の書き込み順序と同じ順で先に記録しておく(曲のINITが実際に
    // 書き直した場合は後続の通常記録で上書きされるので問題ない)。
    runningRegs[0x4017] = 0x40; initWrites.push({ addr: 0x4017, value: 0x40 });
    runningRegs[0x4015] = 0x0F; initWrites.push({ addr: 0x4015, value: 0x0F });
    player.bus.onWrite = (a, val) => { runningRegs[a] = val; initWrites.push({ addr: a, value: val }); };
    player.initSong(songIndex, !!opt.pal);
    player.bus.onWrite = null;

    if (opt.mute) {
      if (opt.mute.apu) Emu.applyMute(player.apu.mute, opt.mute.apu);
      if (opt.mute.expansion) {
        for (const [name, chip] of Object.entries(player.bus.expansion)) {
          if (opt.mute.expansion[name]) Emu.applyMute(chip.mute, opt.mute.expansion[name]);
        }
      }
    }

    const frameRate = opt.pal ? (1000000 / 19997) : Emu.FRAME_RATE_NTSC;
    const totalFrames = Math.max(1, Math.ceil(durationSeconds * frameRate));
    const samplesPerFrame = sampleRate / frameRate;
    // regsOnly モードでは音声バッファ不要（巨大配列の確保・dcBlock をスキップ）
    const regsOnly = !!opt.regsOnly;
    const totalSamples = regsOnly ? 0 : Math.ceil(totalFrames * samplesPerFrame);

    const raw = new Float32Array(totalSamples);
    const writeLog = new Array(totalFrames);
    const regSnapshots = new Array(totalFrames);
    const cpuSnapshots = new Array(totalFrames);
    const memSnapshots = new Array(totalFrames);
    const apuEnvSnapshots = new Array(totalFrames);
    // N163内部128byte RAMのフレームごとスナップショット。N163は$F800(アドレスラッチ)+$4800
    // (データ)の間接アドレッシングで、しかもドライバは位相バイトを「読み飛ばし」でスキップする
    // (読み出しもオートインクリメントを進める)。writeLogは書き込みしか記録しないため、
    // ログの再生だけではアドレスポインタがズレて内部RAMを正しく復元できない。ライブチップの
    // RAMを直接採取して nsf2mml抽出/ピアノロールへ渡す(この不一致がN163変換崩れの根因)。
    const n163Snapshots = new Array(totalFrames);

    let pendingWrites = [];
    player.bus.onWrite = (addr, value) => pendingWrites.push({ addr, value });

    // INIT後・PLAY前の初期レジスタ状態をスナップショット
    const initRegs = Object.assign({}, runningRegs);

    return { player, sampleRate, frameRate, totalFrames, samplesPerFrame, totalSamples,
             raw, writeLog, regSnapshots, cpuSnapshots, memSnapshots, apuEnvSnapshots, n163Snapshots, runningRegs, initRegs, initWrites,
             pendingWritesRef: { get current() { return pendingWrites; }, set(v) { pendingWrites = v; player.bus.onWrite = (a, val) => pendingWrites.push({ addr: a, value: val }); } } };
  }

  /**
   * APU矩形波1/2・ノイズの「実際に出力中の音量レベル」を取得する。
   * ハードウェアエンベロープ(減衰)使用時、レジスタの下位4bitは音量ではなく減衰速度なので、
   * 内部の decay 値(0-15)を読む必要がある。env=true なら減衰モード。
   * envelope.output() は constant時=設定音量 / 減衰時=現在のdecay値 を返す。
   */
  // DPCMサンプルのデルタ復号キャッシュ（(addr,len)が変わった時だけ再復号）
  let _dmcCache = { key: '' };
  function _dmcSample(bus, addr, len) {
    if (!bus || !len) return null;
    const key = addr + ':' + len;
    if (_dmcCache.key !== key) {
      const n = len * 8;
      const samples = new Float32Array(n);
      let level = 64; // 7bit DAC の中央から delta(+2/-2, 0..127クランプ) で再構成
      let k = 0;
      for (let b = 0; b < len; b++) {
        const byte = bus.read((addr + b) & 0xFFFF) & 0xFF;
        for (let bit = 0; bit < 8; bit++) {
          if (byte & (1 << bit)) { if (level <= 125) level += 2; }
          else { if (level >= 2) level -= 2; }
          samples[k++] = (level - 64) / 64; // -1..1
        }
      }
      _dmcCache = { key, addr, len, samples };
    }
    return { addr, len, samples: _dmcCache.samples };
  }

  Emu.snapshotApuEnv = function (apu, fds, bus) {
    // level/env=音量エンベロープの実出力。len/period/mutedは「レジスタ値だけでは分からない
    // 実状態」で、長さカウンタによる自然消音・スイープユニットが書き換えた実周期・スイープ
    // 強制ミュートを鍵盤/ピアノロールの発音判定と音程表示に使う(nsf2mml/converter.jsの
    // extractPulseEvents/extractNoiseEventsが行うシミュレーションと同じ情報)。
    const rd = (ch) => ({ level: ch.envelope.output(), env: !ch.envelope.constant,
      len: ch.lengthCounter, period: ch.timerPeriod,
      muted: typeof ch.isMuted === 'function' ? ch.isMuted() : false });
    const out = { pulse1: rd(apu.pulse1), pulse2: rd(apu.pulse2), noise: rd(apu.noise) };
    // 三角波は音量レジスタが無く、長さカウンタ+線形カウンタだけで発音が止まる
    // seq: シーケンサ位置。三角波は消音中も最後の値をDCとして保持し、そのDCが
    // 非線形tndミキサー経由でノイズ/DPCMの聞こえ方に効くため、見かけ音量の計算に要る
    if (apu.triangle) out.triangle = { len: apu.triangle.lengthCounter, linear: apu.triangle.linearCounter,
                                       seq: apu.triangle.seqStep };
    // FDS $4080: bit7=1で直接ゲイン, bit7=0でエンベロープ(減衰)。実ゲイン(volGain 0-32)を採取。
    // effectiveFreq: モジュレーション適用後の実ピッチ(内部単位)。鍵盤表示でMH<n>使用中の
    // 実際に揺れているピッチをHz換算する用途(生の$4082/4083周期だけでは変調前の値になる)。
    // modEnabled: モジュレーションユニットの実際の有効状態。$4087が一度も書かれていない
    // (曲がMH<n>を全く使わない)場合、生レジスタは既定値0のままでbit7=0=有効に見えて
    // しまう(実際は一度も有効化されていないのに鍵盤表示が常時ON扱いになるバグの原因)。
    // fds.modEnabled(インスタンスの実状態、既定false)を使えばこの誤検出を避けられる。
    if (fds) out.fds = { gain: fds.volGain, env: !!fds.volEnvEnabled, effectiveFreq: fds.effectiveFreq, modEnabled: !!fds.modEnabled };
    // DPCM: 実出力レベル(outputLevel 0-127)と、メモリ上のサンプルをデルタ復号した波形
    if (apu.dmc) {
      // playing: 実際にサンプルを読み進めている最中か($4015 bit4 の書込み値ではなく実状態。
      // 鍵盤/ロールの発声判定用。鳴り終わると bytesRemaining=0 かつ shiftReg を出し切る)
      // amp: 直近1フレームのDAC振幅(0〜127)=DPCMの体感音量。level(現在値)は波形の
      // 位置でしかなく音量にならないため、鍵盤表示の音量数値はこちらを使う
      const dmc = { level: apu.dmc.outputLevel, amp: apu.dmc.takeAmplitude(), seq: apu.dmc.seq || 0,
                    playing: apu.dmc.bytesRemaining > 0 || (apu.dmc.bitsRemaining > 0 && !apu.dmc.silence) };
      if (bus) {
        const s = _dmcSample(bus, apu.dmc.sampleAddr, apu.dmc.sampleLength);
        if (s) { dmc.addr = s.addr; dmc.len = s.len; dmc.samples = s.samples; }
      }
      out.dmc = dmc;
    }
    return out;
  };

  /** 1フレーム分を処理してバッファ・ログを更新する。posを返す。 */
  function _processFrame(ctx, f, pos) {
    const { player, sampleRate, totalSamples, raw, writeLog, regSnapshots,
            cpuSnapshots, memSnapshots, apuEnvSnapshots, n163Snapshots, runningRegs, pendingWritesRef } = ctx;
    pendingWritesRef.set([]);
    const frame = player.renderFrame(sampleRate);
    writeLog[f] = pendingWritesRef.current;
    for (const w of pendingWritesRef.current) runningRegs[w.addr] = w.value;
    // 書き込みが1件も無かったフレームは前フレームとスナップショットが同一なので、
    // オブジェクトを共有してアロケーション(=GC圧)を減らす。消費側(ピアノロール/
    // モニタ/nsf2mml)はいずれも読み取り専用アクセスのため共有しても安全。
    regSnapshots[f] = (f > 0 && pendingWritesRef.current.length === 0)
      ? regSnapshots[f - 1] : Object.assign({}, runningRegs);
    const n163 = player.bus.expansion && player.bus.expansion.n163;
    if (n163) n163Snapshots[f] = n163.ram.slice();
    cpuSnapshots[f] = {
      A: player.cpu.A, X: player.cpu.X, Y: player.cpu.Y,
      P: player.cpu.P, S: player.cpu.S, PC: player.cpu.PC
    };
    memSnapshots[f] = player.bus.mem.slice(0, 0x100);
    apuEnvSnapshots[f] = Emu.snapshotApuEnv(player.apu, player.bus.expansion && player.bus.expansion.fds, player.bus);
    for (let i = 0; i < frame.length && pos < totalSamples; i++, pos++) {
      raw[pos] = frame[i];
    }
    return pos;
  }

  function _buildResult(ctx) {
    return {
      audio: ctx.raw.length > 0 ? Emu.dcBlock(ctx.raw) : ctx.raw,
      sampleRate: ctx.sampleRate,
      totalFrames: ctx.totalFrames,
      samplesPerFrame: ctx.samplesPerFrame,
      writeLog: ctx.writeLog,
      regSnapshots: ctx.regSnapshots,
      cpuSnapshots: ctx.cpuSnapshots,
      memSnapshots: ctx.memSnapshots,
      apuEnvSnapshots: ctx.apuEnvSnapshots,
      n163Snapshots: ctx.n163Snapshots,
      initRegs: ctx.initRegs,
      initWrites: ctx.initWrites
    };
  }

  /**
   * 楽曲を一括キャプチャする（同期版・後方互換）
   * @param {Uint8Array} nsfBytes - 完全なNSFバイナリ（128バイトヘッダ含む）
   * @param {object} opt
   * @param {number} [opt.songIndex=0]
   * @param {number} [opt.durationSeconds=10]
   * @param {number} [opt.sampleRate=44100]
   * @param {boolean} [opt.pal=false]
   */
  Emu.captureSong = function (nsfBytes, opt = {}) {
    const ctx = _setupCapture(nsfBytes, opt);
    let pos = 0;
    for (let f = 0; f < ctx.totalFrames; f++) {
      pos = _processFrame(ctx, f, pos);
    }
    return _buildResult(ctx);
  };

  /**
   * 楽曲を非同期でキャプチャする（UI をブロックしない）
   * CHUNK_FRAMES フレームごとにブラウザへ制御を返すため、長尺でも UI がフリーズしない。
   * regsOnly時はチャンクを細かくし(ピアノロールの先読み用途で使われ、実再生と
   * メインスレッドを共有するため)、onProgressにはその時点までのregSnapshots/writeLog
   * (末尾は未確定=空のまま伸びていく同一配列参照)も渡すので、キャプチャ完了を待たずに
   * 途中経過だけでピアノロールを段階的に埋めていける。
   * @param {Uint8Array} nsfBytes
   * @param {object} opt - captureSong と同じオプション
   * @param {function(done:number, total:number, regSnapshots:Array, writeLog:Array, n163Snapshots:Array):void} [onProgress] - 進捗コールバック
   * @returns {Promise<object>} captureSong と同じ戻り値
   */
  Emu.captureSongAsync = async function (nsfBytes, opt = {}, onProgress = null) {
    const ctx = _setupCapture(nsfBytes, opt);
    const regsOnly = !!opt.regsOnly;
    // ★2026-08-20 スライス制御を「フレーム数固定(CHUNK_FRAMES)」から「時間予算固定」へ変更。
    // 端末の速度差(同じフレーム数でも掛かる時間はバラバラ)を自動吸収し、メインスレッド
    // 実行時は1スライスあたり最大~sliceBudgetMsしかブロックしない。Worker実行時
    // (src/audio/capture-worker-client.js経由)はUIをブロックしないため、呼び出し側が
    // 大きい予算とsetTimeoutより高速なyield(opt.yieldFn、4msクランプ回避)を渡して
    // スループット優先にできる。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : (regsOnly ? 5 : 15);
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    let sliceStart = performance.now();
    let pos = 0;
    // regsOnly専用: 1フレーム=CPUサイクルCYCLES_PER_FRAME分、というサイクル駆動で
    // PLAYを刻む(NsfPlayer.renderFrame()と全く同じサイクル会計方式・クロック呼び出し)。
    // 省略するのはaudio.mixSample()と出力バッファへの書き込みだけ(regsOnlyの目的である
    // 「音声波形は要らない」を満たすのに必要十分)。
    // ★当初はapu.clock()/expansion.clock()自体も丸ごと省略していたが、これは誤りだった。
    // FDSの$4090(エンベロープ実測値読み出し)のように、ドライバがチップの内部状態を
    // 読み戻して「エンベロープが既定値まで減衰したら次の命令へ分岐する」種類の楽器
    // マクロを使う曲(Ai Senshi Nicol(FDS)等)では、clock()を呼ばないとエンベロープが
    // 初期値のまま一切減衰しないため、この分岐条件が実際のプレイとは異なる結果になり
    // (常に「まだ減衰していない」ため)、本来発生するはずの命令分岐先の書き込みが
    // 丸ごとwriteLogから欠落する不具合があった。clock()自体はmixSample()に比べて
    // 十分軽い(波形合成をしないだけ)ため、追加しても速度上のメリットはほぼ失われない。
    // cpuDebtは端数サイクルを次のフレームへ確実に持ち越す必要があるため、
    // renderFrame()と同じく「+=」で加算する(「=」で上書きすると端数が失われる)。
    const CYCLES_PER_FRAME = Emu.CPU_CLOCK_NTSC / Emu.FRAME_RATE_NTSC;
    let regsOnlyCycleAccum = 0;
    let regsOnlyCpuDebt = 0;
    for (let f = 0; f < ctx.totalFrames; f++) {
      if (regsOnly) {
        // CPU実行 + チップのクロック(エンベロープ等の内部状態更新)のみ。
        // 音声波形合成(mixSample())と出力バッファ書き込みだけを省略する。
        ctx.pendingWritesRef.set([]);
        if (!ctx.player.cpu.callActive) ctx.player.cpu.beginCall(ctx.player.header.playAddr);
        const regsOnlyExpansion = Object.values(ctx.player.bus.expansion);
        regsOnlyCycleAccum += CYCLES_PER_FRAME;
        while (regsOnlyCycleAccum >= 1) {
          if (regsOnlyCpuDebt <= 0) {
            if (ctx.player.cpu.callActive) regsOnlyCpuDebt += ctx.player.cpu.stepCall();
            else regsOnlyCpuDebt = 1;
          }
          regsOnlyCpuDebt--;
          ctx.player.apu.clock();
          for (let e = 0; e < regsOnlyExpansion.length; e++) regsOnlyExpansion[e].clock();
          regsOnlyCycleAccum -= 1;
        }
        ctx.writeLog[f] = ctx.pendingWritesRef.current;
        for (const w of ctx.pendingWritesRef.current) ctx.runningRegs[w.addr] = w.value;
        // 書き込み無しフレームは前フレームとスナップショット同一なのでオブジェクトを共有
        // (_processFrame側の同名コメント参照)
        ctx.regSnapshots[f] = (f > 0 && ctx.pendingWritesRef.current.length === 0)
          ? ctx.regSnapshots[f - 1] : Object.assign({}, ctx.runningRegs);
        const n163 = ctx.player.bus.expansion && ctx.player.bus.expansion.n163;
        if (n163) ctx.n163Snapshots[f] = n163.ram.slice();
      } else {
        pos = _processFrame(ctx, f, pos);
      }
      // f===0でも必ず一度onProgressを発火する(最初のonProgressで実再生のplayer.load()が
      // 走るため、時間予算いっぱいまで溜めると再生開始が遅れる)。以降は時間予算を
      // 超えたときだけスライス境界にする。
      if (f === 0 || performance.now() - sliceStart >= sliceBudgetMs) {
        // initRegs/initWritesは末尾に追加(既存呼び出し元は無視するだけで後方互換)。
        // NSF実再生をこのwriteLogから直接合成する新エンジン(NsfReplayStreamPlayer)が
        // INIT時点の初期状態を再生開始前に必要とするため、完了(Promise解決)を待たずに
        // 最初のonProgressの時点で渡せるようにした。
        if (onProgress) onProgress(f + 1, ctx.totalFrames, ctx.regSnapshots, ctx.writeLog, ctx.n163Snapshots, ctx.initRegs, ctx.initWrites);
        await yieldFn();
        sliceStart = performance.now();
        // 呼び出し元が「もう不要」と判断したら(曲切替/停止の連打で先読みが積み上がるのを防ぐ)
        // ここで即座に打ち切る。onProgress側だけをトークンで無視する方式だと、キャプチャ
        // ループ自体(重いCPUエミュレーション)は最後まで回り続けてしまい、連打するたびに
        // 積み重なって実再生と競合しUIが重くなる不具合があったため。
        if (opt.shouldCancel && opt.shouldCancel()) return _buildResult(ctx);
      }
    }
    if (onProgress) onProgress(ctx.totalFrames, ctx.totalFrames, ctx.regSnapshots, ctx.writeLog, ctx.n163Snapshots, ctx.initRegs, ctx.initWrites);
    return _buildResult(ctx);
  };
})(globalThis);

/*
 * MIPS R3000A CPU エミュレータ (PlayStation)
 * MML.Emu.CPUR3000
 *
 * - MIPS I 命令セット + COP0(SR/CAUSE/EPC/BadVaddr、RFE)。GTE(COP2)は演算しない(レジスタ読みは0)。
 * - 分岐遅延スロットを実装する。ロード結果は即時に見える(ld() の注記参照)。
 * - 例外: 割込み(0)/アドレス(4: 命令フェッチの非整列のみ)/SYSCALL(8)/BREAK(9)/不正命令(10)/オーバーフロー(12)。
 *   データアクセスの非整列は例外にしない(実機/DuckStation と同じ。バス側でバイト単位に読む)。
 *   ベクタは SR.BEV に従い 0x80000080 / 0xBFC00180。
 * - 命令あたりのサイクルは固定 CPI(既定2、PCSXのBIASと同じ)。実機のキャッシュ/バス待ちは模倣しない。
 *   (音源ドライバの時間管理はルートカウンタ/VBlank割込み駆動なので、CPIの誤差は
 *    ビジーループの消費時間にしか効かない)
 *
 * バスに要求するもの:
 *   bus.read8/read16/read32(addr), bus.write8/write16/write32(addr, value)
 *   bus.irqLine  (I_STAT & I_MASK != 0 なら true。CAUSE.IP2 に反映される)
 *   bus.onSyscall?(cpu)  HLE BIOS が SYSCALL/BREAK を横取りしたいとき(true を返すと例外を起こさない)
 *   bus.onTrap?(cpu, pc) 実行アドレスが bus.trapMask に一致したとき(HLE BIOSの入口)。true で命令を実行しない
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const EXC_INT = 0, EXC_ADEL = 4, EXC_ADES = 5, EXC_SYS = 8, EXC_BP = 9, EXC_RI = 10, EXC_CPU = 11, EXC_OV = 12;
  const DEFAULT_CPI = 2;

  class CPUR3000 {
    constructor(bus) {
      this.bus = bus;
      this.r = new Int32Array(32);
      this.hi = 0; this.lo = 0;
      this.pc = 0xBFC00000 | 0;
      this.nextPc = 0;
      this.sr = 0; this.cause = 0; this.epc = 0; this.badVaddr = 0;
      this.cop0 = new Int32Array(16); // その他のCOP0レジスタ(BPC/DCIC等)の置き場
      this.branchDelay = false;   // 次に実行する命令が分岐遅延スロットか
      this.inDelay = false;       // 今実行中の命令が分岐遅延スロットか
      this.curPc = 0;             // 実行中の命令のアドレス(例外のEPC用)
      this.cycles = 0;            // 累積サイクル
      this.cpi = DEFAULT_CPI;
      this.halted = false;        // HLE側が「もう進めない」と判断したとき
      this.exceptionCount = 0;
    }

    reset() {
      this.r.fill(0);
      this.hi = 0; this.lo = 0;
      this.pc = 0xBFC00000 | 0; this.nextPc = (this.pc + 4) | 0;
      this.sr = 0x10900000 | 0; // BEV=1, CU0 は不要。RFE前はカーネルモード
      this.cause = 0; this.epc = 0; this.badVaddr = 0;
      this.cop0.fill(0);
      this.cop0[15] = 0x00000002; // PRID
      this.branchDelay = false; this.inDelay = false;
      this.cycles = 0;
      this.halted = false;
      this.exceptionCount = 0;
    }

    /** レジスタを直接設定して実行開始点を決める(PSF: PC/SP/GP) */
    setEntry(pc, sp, gp) {
      this.pc = pc | 0; this.nextPc = (pc + 4) | 0;
      this.r[29] = sp | 0; this.r[28] = gp | 0;
      this.branchDelay = false;
    }

    // ── 例外 ──────────────────────────────────────────────
    exception(code, badAddr) {
      this.exceptionCount++;
      const bd = this.inDelay;
      this.epc = bd ? (this.curPc - 4) | 0 : this.curPc;
      this.cause = (this.cause & 0x0000FF00) | (code << 2) | (bd ? 0x80000000 : 0) | (this.cop0[13] & 0x30000000);
      if (code === EXC_ADEL || code === EXC_ADES) this.badVaddr = badAddr | 0;
      // SR: KU/IE を2ビット分シフト(現在→旧)
      this.sr = (this.sr & ~0x3F) | ((this.sr << 2) & 0x3C);
      const vec = (this.sr & 0x400000) ? 0xBFC00180 : 0x80000080;
      this.pc = vec | 0; this.nextPc = (vec + 4) | 0;
      this.branchDelay = false; this.inDelay = false;
    }

    /** RFE: SR の KU/IE を戻す */
    rfe() {
      this.sr = (this.sr & ~0x0F) | ((this.sr >> 2) & 0x0F);
    }

    /** 割込み要求ラインの状態を CAUSE.IP2 に写し、受理できれば例外を起こす */
    pollInterrupt() {
      if (this.bus.irqLine) this.cause |= 0x400; else this.cause &= ~0x400;
      if ((this.sr & 1) && (this.sr & this.cause & 0xFF00)) {
        this.curPc = this.pc;
        // 分岐遅延スロットの直前で受理すると EPC が分岐命令になる: そのまま扱える
        this.inDelay = this.branchDelay;
        this.exception(EXC_INT, 0);
        return true;
      }
      return false;
    }

    // ── 実行 ──────────────────────────────────────────────
    /**
     * 指定サイクルぶん実行する(命令境界で停止)。戻り値は実際に消費したサイクル。
     */
    run(budget) {
      const start = this.cycles;
      const end = start + budget;
      while (this.cycles < end && !this.halted) {
        this.step();
      }
      return this.cycles - start;
    }

    /** 1命令実行。戻り値は消費サイクル */
    step() {
      const bus = this.bus;
      const r = this.r;
      // 割込み受理(命令境界)
      if (bus.irqLine || (this.cause & 0x400)) {
        if (this.pollInterrupt()) { this.cycles += this.cpi; return this.cpi; }
      }
      const pc = this.pc;
      this.curPc = pc;
      this.inDelay = this.branchDelay;
      this.branchDelay = false;
      // HLE BIOS の入口(トラップ)
      if (bus.trapMask !== undefined && ((pc & bus.trapMask) >>> 0) === bus.trapBase) {
        if (bus.onTrap(this, pc)) {
          this.cycles += this.cpi;
          return this.cpi;
        }
      }
      if (pc & 3) { this.exception(EXC_ADEL, pc); this.cycles += this.cpi; return this.cpi; }
      const op = bus.read32(pc) | 0;
      this.pc = this.nextPc;
      this.nextPc = (this.nextPc + 4) | 0;

      const rs = (op >>> 21) & 31, rt = (op >>> 16) & 31, rd = (op >>> 11) & 31;
      const imm = op << 16 >> 16;        // 符号拡張即値
      const immU = op & 0xFFFF;
      const sa = (op >>> 6) & 31;
      let cyc = this.cpi;

      switch (op >>> 26) {
        case 0x00: // SPECIAL
          switch (op & 0x3F) {
            case 0x00: this.wr(rd, r[rt] << sa); break;                    // SLL
            case 0x02: this.wr(rd, r[rt] >>> sa); break;                   // SRL
            case 0x03: this.wr(rd, r[rt] >> sa); break;                    // SRA
            case 0x04: this.wr(rd, r[rt] << (r[rs] & 31)); break;          // SLLV
            case 0x06: this.wr(rd, r[rt] >>> (r[rs] & 31)); break;         // SRLV
            case 0x07: this.wr(rd, r[rt] >> (r[rs] & 31)); break;          // SRAV
            case 0x08: this.nextPc = r[rs]; this.branchDelay = true; break; // JR
            case 0x09: { const t = r[rs]; this.wr(rd, this.nextPc); this.nextPc = t; this.branchDelay = true; break; } // JALR
            case 0x0C: // SYSCALL
              if (bus.onSyscall && bus.onSyscall(this, false)) break;
              this.exception(EXC_SYS, 0); break;
            case 0x0D: // BREAK
              if (bus.onSyscall && bus.onSyscall(this, true)) break;
              this.exception(EXC_BP, 0); break;
            case 0x10: this.wr(rd, this.hi); break;                        // MFHI
            case 0x11: this.hi = r[rs]; break;                             // MTHI
            case 0x12: this.wr(rd, this.lo); break;                        // MFLO
            case 0x13: this.lo = r[rs]; break;                             // MTLO
            case 0x18: this.mult(r[rs], r[rt], true); cyc += 6; break;     // MULT
            case 0x19: this.mult(r[rs], r[rt], false); cyc += 6; break;    // MULTU
            case 0x1A: { // DIV
              const a = r[rs], b = r[rt];
              if (b === 0) { this.lo = a >= 0 ? -1 : 1; this.hi = a; }
              else if (a === -2147483648 && b === -1) { this.lo = -2147483648; this.hi = 0; }
              else { this.lo = (a / b) | 0; this.hi = a % b; }
              cyc += 30; break;
            }
            case 0x1B: { // DIVU
              const a = r[rs] >>> 0, b = r[rt] >>> 0;
              if (b === 0) { this.lo = -1; this.hi = a | 0; }
              else { this.lo = Math.floor(a / b) | 0; this.hi = (a % b) | 0; }
              cyc += 30; break;
            }
            case 0x20: { // ADD
              const a = r[rs], b = r[rt], s = (a + b) | 0;
              if (((a ^ s) & (b ^ s)) < 0) { this.exception(EXC_OV, 0); break; }
              this.wr(rd, s); break;
            }
            case 0x21: this.wr(rd, (r[rs] + r[rt]) | 0); break;            // ADDU
            case 0x22: { // SUB
              const a = r[rs], b = r[rt], s = (a - b) | 0;
              if (((a ^ b) & (a ^ s)) < 0) { this.exception(EXC_OV, 0); break; }
              this.wr(rd, s); break;
            }
            case 0x23: this.wr(rd, (r[rs] - r[rt]) | 0); break;            // SUBU
            case 0x24: this.wr(rd, r[rs] & r[rt]); break;                  // AND
            case 0x25: this.wr(rd, r[rs] | r[rt]); break;                  // OR
            case 0x26: this.wr(rd, r[rs] ^ r[rt]); break;                  // XOR
            case 0x27: this.wr(rd, ~(r[rs] | r[rt])); break;               // NOR
            case 0x2A: this.wr(rd, r[rs] < r[rt] ? 1 : 0); break;          // SLT
            case 0x2B: this.wr(rd, (r[rs] >>> 0) < (r[rt] >>> 0) ? 1 : 0); break; // SLTU
            default: this.exception(EXC_RI, 0); break;
          }
          break;
        case 0x01: { // REGIMM
          const cond = r[rs] < 0;
          const link = (rt & 0x1E) === 0x10;
          const target = (this.pc + (imm << 2)) | 0;
          if (link) this.wr(31, this.nextPc);
          // BLTZ(0)/BGEZ(1)/BLTZAL(16)/BGEZAL(17)。他のrtはビット0で判定する実機挙動
          if ((rt & 1) ? !cond : cond) this.nextPc = target;
          this.branchDelay = true;
          break;
        }
        case 0x02: this.nextPc = ((this.pc & 0xF0000000) | ((op & 0x03FFFFFF) << 2)) | 0; this.branchDelay = true; break; // J
        case 0x03: this.wr(31, this.nextPc); this.nextPc = ((this.pc & 0xF0000000) | ((op & 0x03FFFFFF) << 2)) | 0; this.branchDelay = true; break; // JAL
        case 0x04: if (r[rs] === r[rt]) this.nextPc = (this.pc + (imm << 2)) | 0; this.branchDelay = true; break; // BEQ
        case 0x05: if (r[rs] !== r[rt]) this.nextPc = (this.pc + (imm << 2)) | 0; this.branchDelay = true; break; // BNE
        case 0x06: if (r[rs] <= 0) this.nextPc = (this.pc + (imm << 2)) | 0; this.branchDelay = true; break;   // BLEZ
        case 0x07: if (r[rs] > 0) this.nextPc = (this.pc + (imm << 2)) | 0; this.branchDelay = true; break;    // BGTZ
        case 0x08: { // ADDI
          const a = r[rs], s = (a + imm) | 0;
          if (((a ^ s) & (imm ^ s)) < 0) { this.exception(EXC_OV, 0); break; }
          this.wr(rt, s); break;
        }
        case 0x09: this.wr(rt, (r[rs] + imm) | 0); break;                  // ADDIU
        case 0x0A: this.wr(rt, r[rs] < imm ? 1 : 0); break;                // SLTI
        case 0x0B: this.wr(rt, (r[rs] >>> 0) < (imm >>> 0) ? 1 : 0); break; // SLTIU
        case 0x0C: this.wr(rt, r[rs] & immU); break;                       // ANDI
        case 0x0D: this.wr(rt, r[rs] | immU); break;                       // ORI
        case 0x0E: this.wr(rt, r[rs] ^ immU); break;                       // XORI
        case 0x0F: this.wr(rt, immU << 16); break;                         // LUI
        case 0x10: // COP0
          switch (rs) {
            case 0x00: this.ld(rt, this.mfc0(rd)); break;                  // MFC0
            case 0x02: this.ld(rt, this.mfc0(rd)); break;                  // CFC0(実機には無いが無害)
            case 0x04: this.mtc0(rd, r[rt]); break;                        // MTC0
            case 0x06: break;                                               // CTC0
            case 0x10: if ((op & 0x3F) === 0x10) this.rfe(); break;        // RFE
            default: break;
          }
          break;
        case 0x11: // COP1(無い): 例外
        case 0x13: this.exception(EXC_CPU, 0); break;
        case 0x12: // COP2(GTE): 演算はしない。読みは0
          switch (rs) {
            case 0x00: case 0x02: this.ld(rt, 0); break;                   // MFC2/CFC2
            default: break;                                                 // MTC2/CTC2/演算
          }
          break;
        case 0x20: { const a = (r[rs] + imm) | 0; this.ld(rt, bus.read8(a) << 24 >> 24); cyc++; break; }   // LB
        case 0x21: { const a = (r[rs] + imm) | 0; this.ld(rt, bus.read16(a) << 16 >> 16); cyc++; break; } // LH
        case 0x22: { // LWL
          const a = (r[rs] + imm) | 0;
          const mem = bus.read32(a & ~3) | 0;
          const cur = r[rt];
          let v;
          switch (a & 3) {
            case 0: v = (mem << 24) | (cur & 0x00FFFFFF); break;
            case 1: v = (mem << 16) | (cur & 0x0000FFFF); break;
            case 2: v = (mem << 8) | (cur & 0x000000FF); break;
            default: v = mem; break;
          }
          this.ld(rt, v); cyc++; break;
        }
        case 0x23: { const a = (r[rs] + imm) | 0; this.ld(rt, bus.read32(a) | 0); cyc++; break; } // LW
        case 0x24: { const a = (r[rs] + imm) | 0; this.ld(rt, bus.read8(a) & 0xFF); cyc++; break; }     // LBU
        case 0x25: { const a = (r[rs] + imm) | 0; this.ld(rt, bus.read16(a) & 0xFFFF); cyc++; break; } // LHU
        case 0x26: { // LWR
          const a = (r[rs] + imm) | 0;
          const mem = bus.read32(a & ~3) | 0;
          const cur = r[rt];
          let v;
          switch (a & 3) {
            case 0: v = mem; break;
            case 1: v = (mem >>> 8) | (cur & 0xFF000000); break;
            case 2: v = (mem >>> 16) | (cur & 0xFFFF0000); break;
            default: v = (mem >>> 24) | (cur & 0xFFFFFF00); break;
          }
          this.ld(rt, v | 0); cyc++; break;
        }
        case 0x28: { const a = (r[rs] + imm) | 0; if (!(this.sr & 0x10000)) bus.write8(a, r[rt] & 0xFF); cyc++; break; }   // SB
        case 0x29: { const a = (r[rs] + imm) | 0; if (!(this.sr & 0x10000)) bus.write16(a, r[rt] & 0xFFFF); cyc++; break; } // SH
        case 0x2A: { // SWL
          const a = (r[rs] + imm) | 0;
          if (this.sr & 0x10000) break;
          const al = a & ~3;
          const mem = bus.read32(al) | 0, v = r[rt];
          let out;
          switch (a & 3) {
            case 0: out = (mem & 0xFFFFFF00) | (v >>> 24); break;
            case 1: out = (mem & 0xFFFF0000) | (v >>> 16); break;
            case 2: out = (mem & 0xFF000000) | (v >>> 8); break;
            default: out = v; break;
          }
          bus.write32(al, out | 0); cyc++; break;
        }
        case 0x2B: { const a = (r[rs] + imm) | 0; if (!(this.sr & 0x10000)) bus.write32(a, r[rt]); cyc++; break; } // SW
        case 0x2E: { // SWR
          const a = (r[rs] + imm) | 0;
          if (this.sr & 0x10000) break;
          const al = a & ~3;
          const mem = bus.read32(al) | 0, v = r[rt];
          let out;
          switch (a & 3) {
            case 0: out = v; break;
            case 1: out = (mem & 0x000000FF) | (v << 8); break;
            case 2: out = (mem & 0x0000FFFF) | (v << 16); break;
            default: out = (mem & 0x00FFFFFF) | (v << 24); break;
          }
          bus.write32(al, out | 0); cyc++; break;
        }
        case 0x30: case 0x31: case 0x33: this.exception(EXC_CPU, 0); break; // LWC0/1/3
        case 0x32: { const a = (r[rs] + imm) | 0; bus.read32(a); cyc++; break; }   // LWC2 (GTEへ: 読み捨て)
        case 0x38: case 0x39: case 0x3B: this.exception(EXC_CPU, 0); break; // SWC0/1/3
        case 0x3A: { const a = (r[rs] + imm) | 0; if (!(this.sr & 0x10000)) bus.write32(a, 0); cyc++; break; } // SWC2 (GTEレジスタは0)
        default: this.exception(EXC_RI, 0); break;
      }

      r[0] = 0;
      this.cycles += cyc;
      return cyc;
    }

    /** レジスタへ即時書き込み(遅延中の同レジスタへのロードは捨てる) */
    wr(reg, val) {
      if (reg === 0) return;
      this.r[reg] = val | 0;
    }

    /**
     * ロード結果の書き込み。
     * MIPS I の仕様書上は「次の命令からは古い値が見える」ロード遅延があるが、PS1 の実機では
     * 即時に見える(Philosoma の起動コードが lw s7 直後の add s7,s7,s4 で新しい値を前提にしており、
     * 遅延を入れると加算オーバーフロー例外で止まる)。PCSX/Mednafen/DuckStation も即時扱い。
     */
    ld(reg, val) {
      if (reg === 0) return;
      this.r[reg] = val | 0;
    }

    mult(a, b, signed) {
      let neg = false;
      let ua = a, ub = b;
      if (signed) {
        if (a < 0) { ua = (-a) | 0; neg = !neg; }
        if (b < 0) { ub = (-b) | 0; neg = !neg; }
      }
      ua >>>= 0; ub >>>= 0;
      const ah = ua >>> 16, al = ua & 0xFFFF, bh = ub >>> 16, bl = ub & 0xFFFF;
      const ll = al * bl;
      const mid = al * bh + ah * bl + Math.floor(ll / 65536);
      let lo = (ll % 65536 + (mid % 65536) * 65536) >>> 0;
      let hi = (ah * bh + Math.floor(mid / 65536)) >>> 0;
      if (neg) {
        lo = (-lo) >>> 0;
        hi = ((~hi) + (lo === 0 ? 1 : 0)) >>> 0;
      }
      this.lo = lo | 0; this.hi = hi | 0;
    }

    mfc0(reg) {
      switch (reg) {
        case 8: return this.badVaddr;
        case 12: return this.sr;
        case 13: return this.cause;
        case 14: return this.epc;
        default: return this.cop0[reg & 15];
      }
    }

    mtc0(reg, val) {
      switch (reg) {
        case 12: this.sr = val | 0; break;
        case 13: this.cause = (this.cause & ~0x300) | (val & 0x300); break; // ソフト割込みビットのみ書ける
        case 14: this.epc = val | 0; break;
        case 8: break;
        default: this.cop0[reg & 15] = val | 0; break;
      }
    }
  }

  CPUR3000.EXC = { INT: EXC_INT, ADEL: EXC_ADEL, ADES: EXC_ADES, SYS: EXC_SYS, BP: EXC_BP, RI: EXC_RI, CPU: EXC_CPU, OV: EXC_OV };
  Emu.CPUR3000 = CPUR3000;
})(globalThis);

/*
 * PlayStation SPU (CXD2922/CXD2925) エミュレータ
 * MML.Emu.SpuPsx
 *
 * 24ボイスの SPU-ADPCM 再生、ハードADSR、ボイス/メイン音量スイープ、ピッチ変調(PMON)、
 * ノイズ、リバーブ、SPU RAM 転送(FIFO手動書き/DMA読み書き)、IRQ9。
 * clock() 1回で 44.1kHz のステレオ1サンプル(outL/outR、-32768..32767)を生成する。
 * CPU 33.8688MHz ÷ 768 = 44100Hz。
 *
 * 出典は psx-spx "Sound Processing Unit (SPU)" の記述(ガウス表・ADSR のカウンタ式・
 * ノイズ・リバーブ式・39タップFIR はそこから写した)。ADSR は「Counter += Increment、
 * bit15 が立ったら1ステップ」の実機検証済みの形を使う。
 *
 * レジスタは 0x1F801C00.. をハーフワード index(0..0xFF)で扱う:
 *   voice n: n*8 + {0:volL 1:volR 2:pitch 3:startAddr 4:adsrLo 5:adsrHi 6:curAdsrVol 7:repeatAddr}
 *   0xC0 mainL 0xC1 mainR 0xC2 vLOUT 0xC3 vROUT 0xC4/C5 KON 0xC6/C7 KOFF 0xC8/C9 PMON 0xCA/CB NON
 *   0xCC/CD EON 0xCE/CF ENDX 0xD1 mBASE 0xD2 IRQaddr 0xD3 transferAddr 0xD4 FIFO 0xD5 SPUCNT
 *   0xD6 transferCtrl 0xD7 SPUSTAT 0xD8/D9 CD vol 0xDA/DB ext vol 0xDC/DD curMainVol 0xE0..FF reverb
 *   0x100..0x12F current voice volume L/R (read)  0x130..0x13F 不明(RAM扱い)
 *
 * フック:
 *   onWrite(index, value)   レジスタ書き込み(キャプチャ用)
 *   onKeyOn(voice, startAddr) KON でボイスが鳴り始めた時
 *   onIrq()                 IRQ9 発生
 * ミュート/音量: mute[24](bool) / vol[24](0..2)。Emu.applyMute/applyVolume と同じ配列規約。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SPU_RAM_SIZE = 0x80000;
  const NUM_VOICES = 24;
  const SAMPLES_PER_BLOCK = 28;

  // ── ガウス補間表(psx-spx、512エントリ。4タップの和は 0x7F80 ±1) ──
  const GAUSS = new Int16Array([
        -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,
         0,     0,     0,     0,     0,     0,     0,     1,     1,     1,     1,     2,     2,     2,     3,     3,
         3,     4,     4,     5,     5,     6,     7,     7,     8,     9,     9,    10,    11,    12,    13,    14,
        15,    16,    17,    18,    19,    21,    22,    24,    25,    27,    28,    30,    32,    33,    35,    37,
        39,    41,    44,    46,    48,    51,    53,    56,    58,    61,    64,    67,    70,    73,    77,    80,
        84,    87,    91,    95,    99,   103,   107,   111,   116,   120,   125,   130,   135,   140,   145,   150,
       156,   161,   167,   173,   179,   186,   192,   199,   205,   212,   219,   227,   234,   242,   250,   257,
       266,   274,   283,   291,   300,   309,   319,   328,   338,   348,   358,   369,   379,   390,   401,   412,
       424,   436,   448,   460,   473,   485,   498,   512,   525,   539,   553,   567,   582,   597,   612,   627,
       643,   659,   675,   692,   708,   726,   743,   761,   779,   797,   816,   835,   854,   874,   894,   914,
       935,   956,   977,   999,  1020,  1043,  1066,  1089,  1112,  1136,  1160,  1184,  1209,  1234,  1260,  1286,
      1312,  1339,  1366,  1394,  1422,  1450,  1479,  1508,  1537,  1567,  1598,  1628,  1660,  1691,  1723,  1756,
      1789,  1822,  1856,  1890,  1924,  1959,  1995,  2031,  2067,  2104,  2141,  2179,  2217,  2256,  2295,  2334,
      2374,  2415,  2456,  2497,  2539,  2582,  2624,  2668,  2712,  2756,  2801,  2846,  2892,  2938,  2985,  3032,
      3079,  3128,  3176,  3225,  3275,  3325,  3376,  3427,  3479,  3531,  3584,  3637,  3691,  3745,  3799,  3855,
      3910,  3967,  4023,  4081,  4138,  4197,  4255,  4315,  4374,  4435,  4495,  4557,  4619,  4681,  4744,  4807,
      4871,  4935,  5000,  5065,  5131,  5197,  5264,  5332,  5399,  5468,  5536,  5606,  5676,  5746,  5817,  5888,
      5959,  6032,  6104,  6177,  6251,  6325,  6400,  6475,  6550,  6626,  6702,  6779,  6856,  6934,  7012,  7091,
      7170,  7249,  7329,  7409,  7490,  7571,  7653,  7735,  7817,  7900,  7983,  8066,  8150,  8234,  8319,  8404,
      8489,  8575,  8661,  8748,  8834,  8922,  9009,  9097,  9185,  9273,  9362,  9451,  9541,  9630,  9720,  9811,
      9901,  9992, 10083, 10174, 10266, 10358, 10450, 10542, 10635, 10727, 10820, 10913, 11007, 11100, 11194, 11288,
     11382, 11476, 11571, 11665, 11760, 11855, 11950, 12045, 12140, 12236, 12331, 12427, 12522, 12618, 12714, 12809,
     12905, 13001, 13097, 13193, 13289, 13385, 13481, 13577, 13673, 13769, 13865, 13961, 14056, 14152, 14248, 14343,
     14439, 14534, 14630, 14725, 14820, 14915, 15010, 15104, 15199, 15293, 15387, 15481, 15575, 15669, 15762, 15855,
     15948, 16041, 16133, 16226, 16317, 16409, 16500, 16592, 16682, 16773, 16863, 16953, 17042, 17131, 17220, 17308,
     17396, 17484, 17571, 17658, 17744, 17830, 17916, 18001, 18086, 18170, 18254, 18337, 18420, 18502, 18584, 18665,
     18746, 18826, 18905, 18985, 19063, 19141, 19219, 19295, 19372, 19447, 19522, 19597, 19671, 19744, 19816, 19888,
     19959, 20030, 20100, 20169, 20238, 20306, 20373, 20439, 20505, 20570, 20634, 20698, 20760, 20822, 20884, 20944,
     21004, 21063, 21121, 21178, 21235, 21290, 21345, 21399, 21452, 21505, 21556, 21607, 21657, 21706, 21754, 21801,
     21848, 21893, 21938, 21982, 22025, 22066, 22107, 22148, 22187, 22225, 22262, 22299, 22334, 22369, 22402, 22435,
     22467, 22498, 22527, 22556, 22584, 22611, 22637, 22662, 22686, 22709, 22731, 22752, 22772, 22791, 22809, 22826,
     22842, 22857, 22872, 22885, 22897, 22908, 22918, 22927, 22935, 22942, 22948, 22953, 22957, 22960, 22962, 22963,
  ]);

  // ── リバーブ入出力の 39 タップ FIR(psx-spx) ──
  const REVERB_FIR = new Int16Array([
        -1,     0,     2,     0,   -10,     0,    35,     0,
      -103,     0,   266,     0,  -616,     0,  1332,     0,
     -2960,     0, 10246, 16384, 10246,     0, -2960,     0,
      1332,     0,  -616,     0,   266,     0,  -103,     0,
        35,     0,   -10,     0,     2,     0,    -1,
  ]);

  // SPU-ADPCM フィルタ係数(XA と同じ)
  const ADPCM_POS = [0, 60, 115, 98, 122];
  const ADPCM_NEG = [0, 0, -52, -55, -60];

  const PH_OFF = 0, PH_ATTACK = 1, PH_DECAY = 2, PH_SUSTAIN = 3, PH_RELEASE = 4;

  function clamp16(v) { return v < -32768 ? -32768 : (v > 32767 ? 32767 : v); }

  /**
   * 音量エンベロープ(ADSR の各相/音量スイープ共通)。psx-spx の式そのまま。
   * @returns 新しいレベル
   */
  function envTick(env, level) {
    // env: {shift, stepVal, decreasing, exponential, negative, counter}
    let step = 7 - env.stepVal;
    if (env.decreasing !== env.negative) step = ~step;      // +7..+4 → -8..-5
    const shift = env.shift;
    step = shift < 11 ? (step << (11 - shift)) : step;
    let inc = shift > 11 ? (0x8000 >> (shift - 11)) : 0x8000;
    if (env.exponential && !env.decreasing && level > 0x6000) {
      if (shift < 10) step >>= 2;
      else if (shift >= 11) inc >>= 2;
      else { step >>= 1; inc >>= 1; }
    } else if (env.exponential && env.decreasing) {
      step = (step * level) >> 15;
    }
    if ((env.stepVal | (shift << 2)) !== 0x7F) { if (inc < 1) inc = 1; }
    env.counter += inc;
    if ((env.counter & 0x8000) === 0) return level;
    env.counter = 0;
    level += step;
    if (!env.decreasing) return level < -0x8000 ? -0x8000 : (level > 0x7FFF ? 0x7FFF : level);
    if (env.negative) return level < -0x8000 ? -0x8000 : (level > 0 ? 0 : level);
    return level < 0 ? 0 : level;
  }

  function makeEnv() { return { shift: 0, stepVal: 0, decreasing: false, exponential: false, negative: false, counter: 0 }; }

  class Voice {
    constructor(index) {
      this.index = index;
      this.buf = new Int16Array(SAMPLES_PER_BLOCK + 3); // [0..2]=前ブロック末尾3サンプル、[3..30]=現ブロック
      this.reset();
    }
    reset() {
      this.buf.fill(0);
      this.curAddr = 0;        // 現在のADPCMブロック(バイトアドレス)
      this.repeatAddr = 0;     // バイトアドレス
      this.counter = 0;        // ピッチカウンタ(bit12以上=ブロック内サンプル、bit4-11=補間index)
      this.hasBlock = false;
      this.blockFlags = 0;
      this.ignoreLoopAddr = false;
      this.phase = PH_OFF;
      this.level = 0;          // ADSR レベル 0..0x7FFF
      this.env = makeEnv();
      this.out = 0;            // VxOUTX(ADSR適用後・音量前)
      this.outL = 0; this.outR = 0;
      this.volL = 0; this.volR = 0;         // 現在の音量(-0x8000..0x7FFF)
      this.sweepL = null; this.sweepR = null; // スイープ中なら makeEnv()
      this.keyOnFrame = -1;
      this.keyOnSerial = 0;    // キーオンの通し番号(同じフレーム内の打ち直し検出用)
    }
  }

  class SpuPsx {
    constructor() {
      this.ram = new Uint8Array(SPU_RAM_SIZE);
      this.ram16 = new Int16Array(this.ram.buffer);
      this.regs = new Uint16Array(0x200);
      this.voices = [];
      for (let i = 0; i < NUM_VOICES; i++) this.voices.push(new Voice(i));
      this.mute = new Array(NUM_VOICES).fill(false);
      this.vol = new Array(NUM_VOICES).fill(1);
      this.onWrite = null; this.onKeyOn = null; this.onIrq = null;
      this.onRamWrite = null; // (byteAddr, int16) 転送(FIFO/DMA)による SPU RAM 書き込み(キャプチャ用)
      // replayMode: 記録済みの書き込みを流し直す再生専用。FIFO/DMA からの RAM 書き込みは
      // 行わない(RAM はキャプチャの onRamWrite 記録を ramWrite16Direct で直接反映する)。
      this.replayMode = false;
      this.reverbBuf = new Int32Array(0); // 未使用(将来のため)
      this.reset();
    }

    reset() {
      this.ram.fill(0);
      this.regs.fill(0);
      for (const v of this.voices) v.reset();
      this.outL = 0; this.outR = 0;
      this.voiceOutL = new Int32Array(NUM_VOICES);
      this.voiceOutR = new Int32Array(NUM_VOICES);
      this.kon = 0; this.koff = 0; this.pmon = 0; this.non = 0; this.eon = 0; this.endx = 0;
      this.cnt = 0; this.stat = 0;
      this.irqAddr = 0; this.irqFlag = false;
      this.transferAddr = 0; this.transferCur = 0;
      this.fifo = new Uint16Array(32); this.fifoLen = 0;
      this.mainVolL = 0; this.mainVolR = 0; this.mainSweepL = null; this.mainSweepR = null;
      this.mainEnvL = makeEnv(); this.mainEnvR = makeEnv();
      this.noiseLevel = 0; this.noiseTimer = 0;
      // リバーブ
      this.rvBase = 0; this.rvCur = 0;
      this.rvDownL = new Int16Array(64); this.rvDownR = new Int16Array(64);
      this.rvUpL = new Int16Array(64); this.rvUpR = new Int16Array(64);
      this.rvPos = 0;
      this.rvOutL = 0; this.rvOutR = 0;
      this.sampleCount = 0;
    }

    // ── レジスタ ──────────────────────────────────────────
    readReg(index) {
      index &= 0x1FF;
      if (index < 0xC0) {
        const v = this.voices[index >> 3];
        switch (index & 7) {
          case 6: return v.level & 0xFFFF;
          case 7: return (v.repeatAddr >>> 3) & 0xFFFF;
          default: return this.regs[index];
        }
      }
      switch (index) {
        case 0xCE: return this.endx & 0xFFFF;
        case 0xCF: return (this.endx >>> 16) & 0xFF;
        case 0xD7: return this.stat;
        case 0xDC: return this.mainVolL & 0xFFFF;
        case 0xDD: return this.mainVolR & 0xFFFF;
        default:
          if (index >= 0x100 && index < 0x130) {
            const v = this.voices[(index - 0x100) >> 1];
            return ((index & 1) ? v.volR : v.volL) & 0xFFFF;
          }
          return this.regs[index];
      }
    }

    writeReg(index, value) {
      index &= 0x1FF; value &= 0xFFFF;
      if (this.onWrite) this.onWrite(index, value);
      this.regs[index] = value;
      if (index < 0xC0) {
        const v = this.voices[index >> 3];
        switch (index & 7) {
          case 0: this.setVoiceVolume(v, 'L', value); break;
          case 1: this.setVoiceVolume(v, 'R', value); break;
          case 6: v.level = value << 16 >> 16; break;
          // 鳴っている最中に書いたときだけ、以後のループ開始フラグより優先する(DuckStation: ignore_loop_address |= IsOn())。
          // 鳴る前に書いた値はキーオン後の最初のループ開始フラグで上書きされうる(FF7 の AKAO はこれでループ先を指定する)
          case 7: v.repeatAddr = (value << 3) & 0x7FFFF; if (v.phase !== PH_OFF) v.ignoreLoopAddr = true; break;
          default: break; // pitch/startAddr/ADSR は regs から都度読む
        }
        return;
      }
      switch (index) {
        case 0xC0: this.setMainVolume('L', value); break;
        case 0xC1: this.setMainVolume('R', value); break;
        case 0xC4: this.kon = (this.kon & 0xFF0000) | value; this.applyKeyOn(value); break;
        case 0xC5: this.kon = (this.kon & 0xFFFF) | ((value & 0xFF) << 16); this.applyKeyOn((value & 0xFF) << 16); break;
        case 0xC6: this.koff = (this.koff & 0xFF0000) | value; this.applyKeyOff(value); break;
        case 0xC7: this.koff = (this.koff & 0xFFFF) | ((value & 0xFF) << 16); this.applyKeyOff((value & 0xFF) << 16); break;
        case 0xC8: this.pmon = (this.pmon & 0xFF0000) | value; break;
        case 0xC9: this.pmon = (this.pmon & 0xFFFF) | ((value & 0xFF) << 16); break;
        case 0xCA: this.non = (this.non & 0xFF0000) | value; break;
        case 0xCB: this.non = (this.non & 0xFFFF) | ((value & 0xFF) << 16); break;
        case 0xCC: this.eon = (this.eon & 0xFF0000) | value; break;
        case 0xCD: this.eon = (this.eon & 0xFFFF) | ((value & 0xFF) << 16); break;
        case 0xCE: this.endx = (this.endx & 0xFF0000) | value; break;
        case 0xCF: this.endx = (this.endx & 0xFFFF) | ((value & 0xFF) << 16); break;
        case 0xD1: this.rvBase = (value << 3) & 0x7FFFF; this.rvCur = this.rvBase; break;
        case 0xD2: this.irqAddr = (value << 3) & 0x7FFFF; break;
        case 0xD3: this.transferAddr = (value << 3) & 0x7FFFF; this.transferCur = this.transferAddr; break;
        case 0xD4: // FIFO
          if (this.fifoLen < 32) this.fifo[this.fifoLen++] = value;
          else { this.fifo.copyWithin(0, 1); this.fifo[31] = value; }
          if (((this.cnt >> 4) & 3) === 1) this.drainFifo(); // 既に手動書きモードなら随時反映
          break;
        case 0xD5: this.setControl(value); break;
        case 0xD6: break; // transfer control(type=2 normal のみ対応)
        default: break;
      }
    }

    setControl(value) {
      const prev = this.cnt;
      this.cnt = value;
      if (!(value & 0x40)) this.irqFlag = false; // IRQ9 disable/acknowledge
      const mode = (value >> 4) & 3;
      if (mode === 1 && ((prev >> 4) & 3) !== 1) this.drainFifo();
      if (mode === 0) this.fifoLen = 0;
      this.updateStat();
    }

    updateStat() {
      const mode = (this.cnt >> 4) & 3;
      let s = this.cnt & 0x3F;
      if (this.irqFlag) s |= 0x40;
      if (mode >= 2) s |= 0x80;
      if (mode === 2) s |= 0x100;
      if (mode === 3) s |= 0x200;
      this.stat = s;
    }

    get irqEnabled() { return (this.cnt & 0x8040) === 0x8040; }

    raiseIrq() {
      if (this.irqFlag) return;
      this.irqFlag = true;
      this.updateStat();
      if (this.onIrq) this.onIrq();
    }

    /** 転送(FIFO/DMA)による RAM 書き込み。IRQ アドレスに触れたら IRQ */
    ramWrite16(addr, value) {
      addr &= 0x7FFFE;
      if (this.replayMode) return;
      if (this.onRamWrite) this.onRamWrite(addr, value << 16 >> 16);
      this.ram16[addr >> 1] = value << 16 >> 16;
      if (this.irqEnabled && ((addr ^ this.irqAddr) & ~7) === 0) this.raiseIrq();
    }

    /** 記録済みの RAM 書き込みを直接反映する(replayMode 用、IRQ/フックなし) */
    ramWrite16Direct(addr, value) {
      this.ram16[(addr & 0x7FFFE) >> 1] = value;
    }

    drainFifo() {
      for (let i = 0; i < this.fifoLen; i++) {
        this.ramWrite16(this.transferCur, this.fifo[i]);
        this.transferCur = (this.transferCur + 2) & 0x7FFFF;
      }
      this.fifoLen = 0;
    }

    /** DMA4 書き込み(1ワード=2ハーフワード) */
    dmaWrite32(word) {
      this.ramWrite16(this.transferCur, word & 0xFFFF);
      this.transferCur = (this.transferCur + 2) & 0x7FFFF;
      this.ramWrite16(this.transferCur, (word >>> 16) & 0xFFFF);
      this.transferCur = (this.transferCur + 2) & 0x7FFFF;
    }

    /** DMA4 読み出し(1ワード) */
    dmaRead32() {
      const lo = this.ram16[this.transferCur >> 1] & 0xFFFF;
      this.transferCur = (this.transferCur + 2) & 0x7FFFF;
      const hi = this.ram16[this.transferCur >> 1] & 0xFFFF;
      this.transferCur = (this.transferCur + 2) & 0x7FFFF;
      return (lo | (hi << 16)) | 0;
    }

    setVoiceVolume(v, side, value) {
      if (value & 0x8000) {
        const env = makeEnv();
        env.shift = (value >> 2) & 0x1F; env.stepVal = value & 3;
        env.decreasing = !!(value & 0x2000); env.exponential = !!(value & 0x4000); env.negative = !!(value & 0x1000);
        if (side === 'L') v.sweepL = env; else v.sweepR = env;
      } else {
        const vol = (value << 17) >> 16; // 15bit符号付き×2
        if (side === 'L') { v.volL = vol; v.sweepL = null; } else { v.volR = vol; v.sweepR = null; }
      }
    }

    setMainVolume(side, value) {
      if (value & 0x8000) {
        const env = makeEnv();
        env.shift = (value >> 2) & 0x1F; env.stepVal = value & 3;
        env.decreasing = !!(value & 0x2000); env.exponential = !!(value & 0x4000); env.negative = !!(value & 0x1000);
        if (side === 'L') this.mainSweepL = env; else this.mainSweepR = env;
      } else {
        const vol = (value << 17) >> 16;
        if (side === 'L') { this.mainVolL = vol; this.mainSweepL = null; } else { this.mainVolR = vol; this.mainSweepR = null; }
      }
    }

    applyKeyOn(bits) {
      for (let i = 0; i < NUM_VOICES; i++) {
        if (!(bits & (1 << i))) continue;
        const v = this.voices[i];
        v.curAddr = (this.regs[i * 8 + 3] << 3) & 0x7FFFF;
        v.counter = 0;
        v.hasBlock = false;
        v.buf.fill(0);
        v.level = 0;
        v.phase = PH_ATTACK;
        v.env.counter = 0;
        v.ignoreLoopAddr = false;
        v.keyOnFrame = this.sampleCount;
        v.keyOnSerial = (v.keyOnSerial + 1) | 0;
        this.endx &= ~(1 << i);
        if (this.onKeyOn) this.onKeyOn(i, v.curAddr);
      }
    }

    applyKeyOff(bits) {
      for (let i = 0; i < NUM_VOICES; i++) {
        if (!(bits & (1 << i))) continue;
        const v = this.voices[i];
        if (v.phase !== PH_OFF) { v.phase = PH_RELEASE; v.env.counter = 0; }
      }
    }

    // ── ADPCM ────────────────────────────────────────────
    /** v.curAddr のブロックを v.buf[3..30] へ復号する(履歴は buf[1],buf[2]) */
    decodeBlock(v) {
      const ram = this.ram;
      const addr = v.curAddr;
      if (this.irqEnabled && ((addr ^ this.irqAddr) & ~0xF) === 0) this.raiseIrq();
      const hdr = ram[addr];
      let shift = hdr & 0x0F;
      if (shift > 12) shift = 9;
      let filter = (hdr >> 4) & 7;
      if (filter > 4) filter = 4;
      const flags = ram[addr + 1];
      v.blockFlags = flags;
      if ((flags & 4) && !v.ignoreLoopAddr) v.repeatAddr = addr;
      const f0 = ADPCM_POS[filter], f1 = ADPCM_NEG[filter];
      const buf = v.buf;
      // 前ブロック末尾3サンプルを先頭へ
      buf[0] = buf[28]; buf[1] = buf[29]; buf[2] = buf[30];
      let old = buf[2], older = buf[1];
      let o = 3;
      for (let i = 2; i < 16; i++) {
        const b = ram[addr + i];
        for (let n = 0; n < 2; n++) {
          const nib = n ? (b >> 4) : (b & 0x0F);
          let s = ((nib << 12) << 16 >> 16) >> shift;
          s += (old * f0 + older * f1 + 32) >> 6;
          s = clamp16(s);
          buf[o++] = s;
          older = old; old = s;
        }
      }
      v.hasBlock = true;
    }

    /** ブロック末尾に達したとき(ループ終端処理→次ブロック) */
    advanceBlock(v) {
      const flags = v.blockFlags;
      if (flags & 1) { // Loop End
        this.endx |= (1 << v.index);
        v.curAddr = v.repeatAddr;
        // End+Mute。ノイズ再生中のボイスでは無視される(ADPCM の読み進みは続く)
        if (!(flags & 2) && !(this.non & (1 << v.index))) {
          v.phase = PH_OFF; v.level = 0; v.env.counter = 0;
        }
      } else {
        v.curAddr = (v.curAddr + 16) & 0x7FFFF;
      }
      this.decodeBlock(v);
    }

    // ── ADSR ─────────────────────────────────────────────
    adsrTick(v) {
      if (v.phase === PH_OFF) { v.level = 0; return; }
      const lo = this.regs[v.index * 8 + 4], hi = this.regs[v.index * 8 + 5];
      const env = v.env;
      let target = -1, targetIsMin = false;
      switch (v.phase) {
        case PH_ATTACK:
          env.shift = (lo >> 10) & 0x1F; env.stepVal = (lo >> 8) & 3;
          env.decreasing = false; env.exponential = !!(lo & 0x8000); env.negative = false;
          target = 0x7FFF; break;
        case PH_DECAY:
          env.shift = (lo >> 4) & 0x0F; env.stepVal = 0;
          env.decreasing = true; env.exponential = true; env.negative = false;
          target = Math.min(0x7FFF, ((lo & 0x0F) + 1) << 11); targetIsMin = true; break;
        case PH_SUSTAIN:
          env.shift = (hi >> 8) & 0x1F; env.stepVal = (hi >> 6) & 3;
          env.decreasing = !!(hi & 0x4000); env.exponential = !!(hi & 0x8000); env.negative = false;
          break;
        case PH_RELEASE:
          env.shift = hi & 0x1F; env.stepVal = 0;
          env.decreasing = true; env.exponential = !!(hi & 0x20); env.negative = false;
          target = 0; targetIsMin = true; break;
        default: break;
      }
      v.level = envTick(env, v.level);
      if (target >= 0) {
        if (targetIsMin ? (v.level <= target) : (v.level >= target)) {
          if (v.phase === PH_ATTACK) { v.phase = PH_DECAY; env.counter = 0; }
          else if (v.phase === PH_DECAY) { v.phase = PH_SUSTAIN; env.counter = 0; }
          else if (v.phase === PH_RELEASE) { v.phase = PH_OFF; v.level = 0; }
        }
      }
    }

    static sweepTick(env, level) {
      const next = envTick(env, level);
      // 到達したら終了(スイープはそのレベルで止まる)
      const done = env.decreasing ? (env.negative ? next <= -0x8000 : next <= 0) : next >= 0x7FFF;
      return { level: next, done };
    }

    // ── ノイズ ────────────────────────────────────────────
    noiseTick() {
      const shift = (this.cnt >> 10) & 0x0F;
      const step = ((this.cnt >> 8) & 3) + 4;
      this.noiseTimer -= step;
      const lvl = this.noiseLevel;
      const parity = ((lvl >> 15) ^ (lvl >> 12) ^ (lvl >> 11) ^ (lvl >> 10) ^ 1) & 1;
      if (this.noiseTimer < 0) {
        this.noiseLevel = ((lvl << 1) | parity) << 16 >> 16;
        this.noiseTimer += 0x20000 >> shift;
        if (this.noiseTimer < 0) this.noiseTimer += 0x20000 >> shift;
      }
    }

    // ── リバーブ ──────────────────────────────────────────
    rvAddr(off) {
      // off はバイトオフセット。mBASE..0x7FFFE で折り返す
      let a = this.rvCur + off;
      const size = SPU_RAM_SIZE - this.rvBase;
      if (a >= SPU_RAM_SIZE) a = this.rvBase + ((a - this.rvBase) % size);
      else if (a < this.rvBase) a = this.rvBase + (((a - this.rvBase) % size) + size) % size;
      return a & 0x7FFFE;
    }
    rvRead(regIdx, minus2) {
      const off = (this.regs[0xE0 + regIdx] << 3) - (minus2 ? 2 : 0);
      return this.ram16[this.rvAddr(off) >> 1];
    }
    rvReadDisp(regIdx, dispIdx) {
      const off = ((this.regs[0xE0 + regIdx] - this.regs[0xE0 + dispIdx]) << 3);
      return this.ram16[this.rvAddr(off) >> 1];
    }
    rvWrite(regIdx, value) {
      if (!(this.cnt & 0x80)) return; // Reverb Master Enable=0 なら書かない
      const off = this.regs[0xE0 + regIdx] << 3;
      this.ram16[this.rvAddr(off) >> 1] = clamp16(value);
    }

    /** 22.05kHz で1回。inL/inR は FIR で間引いた入力 */
    reverbProcess(inL, inR) {
      const R = this.regs;
      const vol = (i) => R[0xE0 + i] << 16 >> 16;
      const mul = (a, b) => (a * b) >> 15;
      const vIIR = vol(2), vCOMB1 = vol(3), vCOMB2 = vol(4), vCOMB3 = vol(5), vCOMB4 = vol(6), vWALL = vol(7);
      const vAPF1 = vol(8), vAPF2 = vol(9), vLIN = vol(0x1E), vRIN = vol(0x1F);
      const Lin = mul(vLIN, inL), Rin = mul(vRIN, inR);
      // Same side reflection
      const mLSAME2 = this.rvRead(0x0A, true), mRSAME2 = this.rvRead(0x0B, true);
      this.rvWrite(0x0A, mul(clamp16(Lin + mul(this.rvRead(0x10), vWALL) - mLSAME2), vIIR) + mLSAME2);
      this.rvWrite(0x0B, mul(clamp16(Rin + mul(this.rvRead(0x11), vWALL) - mRSAME2), vIIR) + mRSAME2);
      // Different side reflection
      const mLDIFF2 = this.rvRead(0x12, true), mRDIFF2 = this.rvRead(0x13, true);
      this.rvWrite(0x12, mul(clamp16(Lin + mul(this.rvRead(0x19), vWALL) - mLDIFF2), vIIR) + mLDIFF2);
      this.rvWrite(0x13, mul(clamp16(Rin + mul(this.rvRead(0x18), vWALL) - mRDIFF2), vIIR) + mRDIFF2);
      // Comb
      let Lout = clamp16(mul(vCOMB1, this.rvRead(0x0C)) + mul(vCOMB2, this.rvRead(0x0E)) + mul(vCOMB3, this.rvRead(0x14)) + mul(vCOMB4, this.rvRead(0x16)));
      let Rout = clamp16(mul(vCOMB1, this.rvRead(0x0D)) + mul(vCOMB2, this.rvRead(0x0F)) + mul(vCOMB3, this.rvRead(0x15)) + mul(vCOMB4, this.rvRead(0x17)));
      // APF1
      {
        const l = this.rvReadDisp(0x1A, 0x00), r = this.rvReadDisp(0x1B, 0x00);
        Lout = clamp16(Lout - mul(vAPF1, l)); this.rvWrite(0x1A, Lout); Lout = clamp16(mul(Lout, vAPF1) + l);
        Rout = clamp16(Rout - mul(vAPF1, r)); this.rvWrite(0x1B, Rout); Rout = clamp16(mul(Rout, vAPF1) + r);
      }
      // APF2
      {
        const l = this.rvReadDisp(0x1C, 0x01), r = this.rvReadDisp(0x1D, 0x01);
        Lout = clamp16(Lout - mul(vAPF2, l)); this.rvWrite(0x1C, Lout); Lout = clamp16(mul(Lout, vAPF2) + l);
        Rout = clamp16(Rout - mul(vAPF2, r)); this.rvWrite(0x1D, Rout); Rout = clamp16(mul(Rout, vAPF2) + r);
      }
      // 次のバッファ位置
      let next = (this.rvCur + 2) & 0x7FFFE;
      if (next < this.rvBase) next = this.rvBase;
      this.rvCur = next;
      return { l: Lout, r: Rout };
    }

    /** 44.1kHz ごとのリバーブ入出力(FIRで 22.05kHz と往復) */
    reverbTick(inL, inR) {
      const pos = this.rvPos;
      this.rvDownL[pos] = clamp16(inL); this.rvDownR[pos] = clamp16(inR);
      if (pos & 1) {
        // 間引き: 39タップ FIR(中心=19)
        let accL = 0, accR = 0;
        for (let k = 0; k < 39; k += 2) { // 奇数タップは中心以外0
          const c = REVERB_FIR[k];
          const i = (pos - k) & 63;
          accL += c * this.rvDownL[i]; accR += c * this.rvDownR[i];
        }
        {
          const i = (pos - 19) & 63;
          accL += REVERB_FIR[19] * this.rvDownL[i]; accR += REVERB_FIR[19] * this.rvDownR[i];
        }
        const out = this.reverbProcess(clamp16(accL >> 15), clamp16(accR >> 15));
        this.rvUpL[pos >> 1 & 31] = out.l; this.rvUpR[pos >> 1 & 31] = out.r;
      }
      // 補間: 偶数位置は偶数タップの和(×2)、奇数位置は中心タップ
      let oL, oR;
      const upIdx = (pos >> 1) & 31;
      if (pos & 1) {
        let accL = 0, accR = 0;
        for (let k = 0; k < 39; k += 2) {
          const c = REVERB_FIR[k];
          const i = (upIdx - (k >> 1)) & 31;
          accL += c * this.rvUpL[i]; accR += c * this.rvUpR[i];
        }
        oL = clamp16(accL >> 14); oR = clamp16(accR >> 14);
      } else {
        const i = (upIdx - 10) & 31; // 中心タップ(19): 偶数位置では o[m-10] だけが寄与
        oL = this.rvUpL[i]; oR = this.rvUpR[i];
      }
      this.rvPos = (pos + 1) & 63;
      const vLOUT = this.regs[0xC2] << 16 >> 16, vROUT = this.regs[0xC3] << 16 >> 16;
      this.rvOutL = (oL * vLOUT) >> 15; this.rvOutR = (oR * vROUT) >> 15;
    }

    // ── 1サンプル ─────────────────────────────────────────
    clock() {
      const enabled = (this.cnt & 0xC000) === 0xC000;
      this.noiseTick();
      let sumL = 0, sumR = 0, rvL = 0, rvR = 0;
      let prevOut = 0;
      for (let i = 0; i < NUM_VOICES; i++) {
        const v = this.voices[i];
        const base = i * 8;
        if (!v.hasBlock) this.decodeBlock(v);
        // 補間
        const si = (v.counter >> 12) + 3;
        const gi = (v.counter >> 4) & 0xFF;
        const buf = v.buf;
        let s = ((GAUSS[0x0FF - gi] * buf[si - 3]) >> 15)
              + ((GAUSS[0x1FF - gi] * buf[si - 2]) >> 15)
              + ((GAUSS[0x100 + gi] * buf[si - 1]) >> 15)
              + ((GAUSS[0x000 + gi] * buf[si]) >> 15);
        if (this.non & (1 << i)) s = this.noiseLevel;
        // ADSR
        this.adsrTick(v);
        const out = (s * v.level) >> 15;
        v.out = out;
        // 音量スイープ
        if (v.sweepL) { const r = SpuPsx.sweepTick(v.sweepL, v.volL); v.volL = r.level; if (r.done) v.sweepL = null; }
        if (v.sweepR) { const r = SpuPsx.sweepTick(v.sweepR, v.volR); v.volR = r.level; if (r.done) v.sweepR = null; }
        let l = (out * v.volL) >> 15, r = (out * v.volR) >> 15;
        if (this.mute[i]) { l = 0; r = 0; }
        else if (this.vol[i] !== 1) { l = (l * this.vol[i]) | 0; r = (r * this.vol[i]) | 0; }
        this.voiceOutL[i] = l; this.voiceOutR[i] = r;
        v.outL = l; v.outR = r;
        sumL += l; sumR += r;
        if (this.eon & (1 << i)) { rvL += l; rvR += r; }
        // ピッチカウンタ
        let step = this.regs[base + 2];
        if (i > 0 && (this.pmon & (1 << i))) {
          const factor = (prevOut + 0x8000);
          step = ((step << 16 >> 16) * factor) >> 15;
          step &= 0xFFFF;
        }
        if (step > 0x3FFF) step = 0x4000;
        v.counter += step;
        while ((v.counter >> 12) >= SAMPLES_PER_BLOCK) {
          v.counter -= SAMPLES_PER_BLOCK << 12;
          this.advanceBlock(v);
        }
        prevOut = out;
      }
      // メイン音量(スイープ)
      if (this.mainSweepL) { const r = SpuPsx.sweepTick(this.mainSweepL, this.mainVolL); this.mainVolL = r.level; if (r.done) this.mainSweepL = null; }
      if (this.mainSweepR) { const r = SpuPsx.sweepTick(this.mainSweepR, this.mainVolR); this.mainVolR = r.level; if (r.done) this.mainSweepR = null; }
      this.reverbTick(rvL, rvR);
      // リバーブ出力は主音量の前に足す(DuckStation SPU::Execute と同じ順序)
      const outL = (clamp16(sumL + this.rvOutL) * this.mainVolL) >> 15;
      const outR = (clamp16(sumR + this.rvOutR) * this.mainVolR) >> 15;
      this.outL = enabled ? outL : 0; this.outR = enabled ? outR : 0;
      this.sampleCount++;
    }

    // ── 補助(キャプチャ/表示用) ──────────────────────────
    /** ボイスの現在状態の控え(鍵盤表示/ロール用) */
    voiceInfo(i) {
      const v = this.voices[i];
      const base = i * 8;
      return {
        active: v.phase !== PH_OFF,
        phase: v.phase,
        level: v.level,
        pitch: this.regs[base + 2],
        startAddr: (this.regs[base + 3] << 3) & 0x7FFFF,
        curAddr: v.curAddr,
        repeatAddr: v.repeatAddr,
        volL: v.volL, volR: v.volR,
        noise: !!(this.non & (1 << i)),
        pmon: !!(this.pmon & (1 << i)),
        reverb: !!(this.eon & (1 << i)),
        adsr: this.regs[base + 4] | (this.regs[base + 5] << 16),
        keyOnFrame: v.keyOnFrame,
      };
    }
  }

  SpuPsx.NUM_VOICES = NUM_VOICES;
  SpuPsx.GAUSS = GAUSS;
  SpuPsx.PHASE = { OFF: PH_OFF, ATTACK: PH_ATTACK, DECAY: PH_DECAY, SUSTAIN: PH_SUSTAIN, RELEASE: PH_RELEASE };
  SpuPsx.envTick = envTick;

  /**
   * SPU RAM 上の ADPCM サンプルを PCM に復号する(音色抽出/表示用)。
   * addr から Loop End フラグのブロックまで読み、ループ開始点も返す。
   * @returns {{pcm:Int16Array, loopStart:number|null, loopEnd:boolean, blocks:number, endMute:boolean}}
   */
  SpuPsx.decodeSample = function (ram, addr, maxBlocks) {
    const limit = maxBlocks || 4096;
    const out = [];
    let old = 0, older = 0;
    let loopStart = null, loopEnd = false, endMute = false;
    let a = addr & 0x7FFF0;
    let blocks = 0;
    for (; blocks < limit; blocks++) {
      const hdr = ram[a];
      let shift = hdr & 0x0F; if (shift > 12) shift = 9;
      let filter = (hdr >> 4) & 7; if (filter > 4) filter = 4;
      const flags = ram[a + 1];
      if (flags & 4) loopStart = blocks * SAMPLES_PER_BLOCK;
      const f0 = ADPCM_POS[filter], f1 = ADPCM_NEG[filter];
      for (let i = 2; i < 16; i++) {
        const b = ram[a + i];
        for (let n = 0; n < 2; n++) {
          const nib = n ? (b >> 4) : (b & 0x0F);
          let s = ((nib << 12) << 16 >> 16) >> shift;
          s += (old * f0 + older * f1 + 32) >> 6;
          s = clamp16(s);
          out.push(s);
          older = old; old = s;
        }
      }
      if (flags & 1) { loopEnd = true; endMute = !(flags & 2); blocks++; break; }
      a = (a + 16) & 0x7FFFF;
      if (a === 0) break;
    }
    return { pcm: Int16Array.from(out), loopStart, loopEnd, blocks, endMute };
  };

  /**
   * 実際に鳴るとおりのサンプル構造を復号する(音程解析/ドラムパッド/変換用)。
   * start からループ終端フラグまでを「頭」とし、ループする場合の戻り先は
   *   - 頭の中にループ開始フラグがあり、かつ repeat レジスタが鳴っている間に書き換えられていなければそのフラグ
   *   - それ以外はドライバが書いた repeat レジスタ(FF7 の AKAO 等はフラグを使わずレジスタで指定する)
   * 戻り先が頭の外なら、そこからループ終端までを復号して後ろへつなぐ(loopStart = 頭の長さ)。
   * @returns {{pcm:Int16Array, loopStart:number|null, looped:boolean, endMute:boolean, blocks:number,
   *            loopAddr:number|null, byteRanges:Array<[number,number]>}}
   */
  SpuPsx.describeSample = function (ram, start, repeatReg, ignoreFlag) {
    start &= 0x7FFF0;
    const head = SpuPsx.decodeSample(ram, start, 8192);
    const headEnd = start + head.blocks * 16;
    const base = { blocks: head.blocks, endMute: head.endMute, byteRanges: [[start, headEnd]] };
    if (!head.loopEnd || head.endMute) {
      return Object.assign(base, { pcm: head.pcm, loopStart: null, looped: false, loopAddr: null });
    }
    let loopAddr;
    if (!ignoreFlag && head.loopStart != null) loopAddr = start + (head.loopStart / SAMPLES_PER_BLOCK) * 16;
    else loopAddr = repeatReg & 0x7FFF0;
    if (loopAddr >= start && loopAddr < headEnd) {
      return Object.assign(base, { pcm: head.pcm, loopStart: ((loopAddr - start) / 16) * SAMPLES_PER_BLOCK, looped: true, loopAddr });
    }
    const tail = SpuPsx.decodeSample(ram, loopAddr, 8192);
    const pcm = new Int16Array(head.pcm.length + tail.pcm.length);
    pcm.set(head.pcm, 0); pcm.set(tail.pcm, head.pcm.length);
    base.byteRanges.push([loopAddr, loopAddr + tail.blocks * 16]);
    return Object.assign(base, { pcm, loopStart: head.pcm.length, looped: true, loopAddr });
  };

  Emu.SpuPsx = SpuPsx;
  Emu.SPU_PSX_RATE = 44100;
})(globalThis);

/*
 * PlayStation バス(PSF再生用の最小構成)
 * MML.Emu.PsxBus
 *
 *   RAM 2MB(0x00000000/0x80000000/0xA0000000 の各セグメントで 4 回ミラー)
 *   スクラッチパッド 1KB (0x1F800000)
 *   割込みコントローラ I_STAT/I_MASK (0x1F801070/74)
 *   DMA 7ch (0x1F801080..) — SPU(ch4) は即時転送、GPU(ch2)/OTC(ch6)/他は形だけ完了させる
 *   ルートカウンタ 3 本 (0x1F801100..)
 *   GPU ステータス (0x1F801814) — VBlank ごとに奇偶ビットが反転するだけ
 *   SPU (0x1F801C00..0x1F801FFF) → Emu.SpuPsx
 *   BIOS 領域 (0x1FC00000..) は HLE のトラップ用(読みは 0)
 *
 * 時間の進め方: CPU の累積サイクル(cpu.cycles)を sync(cycles) に渡すと、
 * その時点までのルートカウンタ・VBlank・SPU(768 サイクルごとに 1 サンプル)を進める。
 * SPU の出力は audioL/audioR(Int16Array のリング)に溜まり、player が取り出す。
 *
 * CPU クロック 33.8688MHz。フレーム周期は GPU クロック(53.693175MHz)の
 * NTSC 3413×263 / PAL 3406×314 ドットから換算する(59.83Hz / 50.20Hz)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CPU_CLOCK = 33868800;
  const GPU_CLOCK = 53693175;
  const RAM_SIZE = 0x200000;
  const CYCLES_PER_SAMPLE = 768;

  const IRQ_VBLANK = 1, IRQ_GPU = 2, IRQ_CDROM = 4, IRQ_DMA = 8, IRQ_TMR0 = 16, IRQ_TMR1 = 32, IRQ_TMR2 = 64, IRQ_SIO0 = 128, IRQ_SIO1 = 256, IRQ_SPU = 512, IRQ_PIO = 1024;

  class RootCounter {
    constructor(index, bus) {
      this.index = index; this.bus = bus;
      this.reset();
    }
    reset() {
      this.count = 0; this.mode = 0; this.target = 0;
      this.frac = 0;        // 分周の端数(CPUサイクル)
      this.irqDone = false; // ワンショットで発火済み
      this.reachedTarget = false; this.reachedOverflow = false;
      this.irqRequest = true; // bit10: 0=要求中(反転論理)
    }
    /** 1カウントあたりの CPU サイクル(小数可) */
    divisor() {
      const src = (this.mode >> 8) & 3;
      switch (this.index) {
        case 0: return (src & 1) ? this.bus.cyclesPerDot : 1;
        case 1: return (src & 1) ? this.bus.cyclesPerHblank : 1;
        default: return (src & 2) ? 8 : 1;
      }
    }
    stopped() {
      if (!(this.mode & 1)) return false;
      const sm = (this.mode >> 1) & 3;
      if (this.index === 2) return sm === 0 || sm === 3;
      return false; // 0/1 のブランク同期は自由走行として扱う
    }
    writeMode(v) {
      this.mode = v & 0x3FF;
      this.count = 0; this.frac = 0;
      this.irqDone = false; this.irqRequest = true;
      this.reachedTarget = false; this.reachedOverflow = false;
    }
    readMode() {
      let v = this.mode | (this.irqRequest ? 0x400 : 0) | (this.reachedTarget ? 0x800 : 0) | (this.reachedOverflow ? 0x1000 : 0);
      this.reachedTarget = false; this.reachedOverflow = false;
      return v;
    }
    fireIrq() {
      const repeat = !!(this.mode & 0x40);
      if (!repeat && this.irqDone) return;
      this.irqDone = true;
      if (this.mode & 0x80) { // トグル
        this.irqRequest = !this.irqRequest;
        if (!this.irqRequest) this.bus.raiseIrq(IRQ_TMR0 << this.index);
      } else {
        this.irqRequest = false;
        this.bus.raiseIrq(IRQ_TMR0 << this.index);
        this.irqRequest = true; // パルス
      }
    }
    targetHit() { this.reachedTarget = true; if (this.mode & 0x10) this.fireIrq(); }
    overflowHit() { this.reachedOverflow = true; if (this.mode & 0x20) this.fireIrq(); }
    advance(cycles) {
      if (this.stopped()) return;
      const div = this.divisor();
      let ticks;
      if (div === 1) ticks = cycles;
      else { this.frac += cycles; ticks = Math.floor(this.frac / div); this.frac -= ticks * div; }
      const tgt = this.target & 0xFFFF;
      const resetOnTarget = !!(this.mode & 8);
      if (resetOnTarget && tgt === 0) { // 毎カウント到達: 1回だけ扱う
        if (ticks > 0) this.targetHit();
        this.count = 0;
        return;
      }
      while (ticks > 0) {
        if (resetOnTarget) {
          // 0..tgt を往復。count > tgt(目標を下げた直後)は 0xFFFF まで走る
          const n = (this.count <= tgt) ? tgt - this.count : 0xFFFF - this.count;
          if (ticks <= n) { this.count += ticks; ticks = 0; if (this.count === tgt) this.reachedTarget = true; }
          else {
            ticks -= n + 1;
            if (this.count + n === tgt) this.targetHit(); else this.overflowHit();
            this.count = 0;
          }
        } else {
          const n = 0xFFFF - this.count;
          if (ticks <= n) {
            const nc = this.count + ticks;
            if (this.count < tgt && nc >= tgt) this.targetHit();
            this.count = nc; ticks = 0;
          } else {
            if (this.count < tgt) this.targetHit();
            ticks -= n + 1;
            this.overflowHit();
            this.count = 0;
          }
        }
      }
    }
  }

  class PsxBus {
    constructor(spu) {
      this.ramBuf = new ArrayBuffer(RAM_SIZE);
      this.ram = new Uint8Array(this.ramBuf);
      this.ram16 = new Uint16Array(this.ramBuf);
      this.ram32 = new Int32Array(this.ramBuf);
      this.scratchBuf = new ArrayBuffer(0x400);
      this.scratch = new Uint8Array(this.scratchBuf);
      this.scratch16 = new Uint16Array(this.scratchBuf);
      this.scratch32 = new Int32Array(this.scratchBuf);
      this.spu = spu || new Emu.SpuPsx();
      this.spu.onIrq = () => this.raiseIrq(IRQ_SPU);
      this.counters = [new RootCounter(0, this), new RootCounter(1, this), new RootCounter(2, this)];
      this.memCtrl = new Int32Array(9);
      this.dmaMadr = new Int32Array(7); this.dmaBcr = new Int32Array(7); this.dmaChcr = new Int32Array(7);
      this.audioL = new Int16Array(65536); this.audioR = new Int16Array(65536);
      this.audioWrite = 0; this.audioRead = 0;
      this.onWrite = null;   // (addr, value, size) 任意のフック(デバッグ用)
      this.writeSeq = 0;         // CPU からの書き込み回数(アイドル判定用)
      this.ioSeq = 0;            // 時間で値が変わりうる I/O の読み出し回数(アイドル判定用)
      this.protectStubs = false; // HLE スタブ(0x80..0xCF)への書き込みを弾く(ドライバがベクタを消しても HLE が生き残るように)
      this.speedFactor = 1;      // テンポ変更: CPU/タイマ/VBlank だけ速くする(SPU は不変)
      this.trapMask = 0x1FF80000; this.trapBase = 0x1FC00000; // BIOS 領域(セグメントビットは落として比較)
      this.onTrap = null; this.onSyscall = null;
      this.setRefresh(60);
      this.reset();
    }

    setRefresh(hz) {
      const pal = hz === 50;
      const dots = pal ? 3406 * 314 : 3413 * 263;
      this.cyclesPerFrame = dots * CPU_CLOCK / GPU_CLOCK;
      this.cyclesPerHblank = this.cyclesPerFrame / (pal ? 314 : 263);
      this.cyclesPerDot = CPU_CLOCK / GPU_CLOCK * 8; // 320px モード相当(ドットクロック=GPU/8)
      this.frameRate = CPU_CLOCK / this.cyclesPerFrame;
    }

    reset() {
      this.ram.fill(0); this.scratch.fill(0);
      this.spu.reset();
      for (const c of this.counters) c.reset();
      this.iStat = 0; this.iMask = 0; this.irqLine = false;
      this.dmaMadr.fill(0); this.dmaBcr.fill(0); this.dmaChcr.fill(0);
      this.dpcr = 0x07654321; this.dicr = 0;
      this.memCtrl.fill(0);
      this.ramSize = 0x00000B88;
      this.cacheCtrl = 0;
      this.gpuStat = 0x14802000 | 0;
      this.gpuOdd = false;
      this.syncedCycles = 0;
      this.frameAccum = 0; this.spuAccum = 0;
      this.frameCount = 0;
      this.audioWrite = 0; this.audioRead = 0;
      this.onVblank = null;
      this.onSample = null;
    }

    // ── 割込み ────────────────────────────────────────────
    raiseIrq(bit) { this.iStat |= bit; this.updateIrqLine(); }
    updateIrqLine() { this.irqLine = (this.iStat & this.iMask) !== 0; }

    // ── 時間 ──────────────────────────────────────────────
    /** cpu.cycles(累積)まで周辺を進める */
    sync(cycles) {
      let elapsed = cycles - this.syncedCycles;
      if (elapsed <= 0) return;
      this.syncedCycles = cycles;
      const timerElapsed = this.speedFactor === 1 ? elapsed : elapsed * this.speedFactor;
      for (const c of this.counters) c.advance(timerElapsed);
      this.frameAccum += timerElapsed;
      while (this.frameAccum >= this.cyclesPerFrame) {
        this.frameAccum -= this.cyclesPerFrame;
        this.gpuOdd = !this.gpuOdd;
        this.frameCount++;
        this.raiseIrq(IRQ_VBLANK);
        if (this.onVblank) this.onVblank(this.frameCount);
      }
      this.spuAccum += elapsed;
      const spu = this.spu;
      while (this.spuAccum >= CYCLES_PER_SAMPLE) {
        this.spuAccum -= CYCLES_PER_SAMPLE;
        spu.clock();
        const w = this.audioWrite;
        this.audioL[w] = spu.outL; this.audioR[w] = spu.outR;
        this.audioWrite = (w + 1) & 0xFFFF;
        if (this.onSample) this.onSample(spu);
      }
    }

    /** 溜まった音声サンプル数 */
    get audioAvailable() { return (this.audioWrite - this.audioRead) & 0xFFFF; }
    /** サンプルを1つ取り出す({l,r} を避けて2値を配列 out[0],out[1] に書く) */
    popSample(out) {
      const r = this.audioRead;
      out[0] = this.audioL[r]; out[1] = this.audioR[r];
      this.audioRead = (r + 1) & 0xFFFF;
    }

    // ── メモリ ────────────────────────────────────────────
    read8(addr) {
      const p = addr & 0x1FFFFFFF;
      if (p < 0x800000) return this.ram[p & 0x1FFFFF];
      if ((p & 0x1FFFFC00) === 0x1F800000) return this.scratch[p & 0x3FF];
      if ((p & 0x1FFFF000) === 0x1F801000) {
        this.ioSeq++;
        if (p >= 0x1F801C00 && p < 0x1F802000) { const h = this.spu.readReg((p - 0x1F801C00) >> 1); return (p & 1) ? (h >> 8) & 0xFF : h & 0xFF; }
        const w = this.ioRead32(p & ~3);
        return (w >>> ((p & 3) * 8)) & 0xFF;
      }
      if (p >= 0x1F000000 && p < 0x1F800000) return 0xFF; // 拡張1(未接続)
      return 0;
    }
    read16(addr) {
      const p = addr & 0x1FFFFFFF;
      if (p & 1) return this.read8(addr) | (this.read8(addr + 1) << 8);
      if (p < 0x800000) return this.ram16[(p & 0x1FFFFF) >> 1];
      if ((p & 0x1FFFFC00) === 0x1F800000) return this.scratch16[(p & 0x3FF) >> 1];
      if ((p & 0x1FFFF000) === 0x1F801000) {
        this.ioSeq++;
        if (p >= 0x1F801C00 && p < 0x1F802000) return this.spu.readReg((p - 0x1F801C00) >> 1);
        const w = this.ioRead32(p & ~3);
        return (w >>> ((p & 2) * 8)) & 0xFFFF;
      }
      if (p >= 0x1F000000 && p < 0x1F800000) return 0xFFFF;
      return 0;
    }
    read32(addr) {
      const p = addr & 0x1FFFFFFF;
      if (p & 3) return (this.read16(addr) | (this.read16(addr + 2) << 16)) | 0;
      if (p < 0x800000) return this.ram32[(p & 0x1FFFFF) >> 2];
      if ((p & 0x1FFFFC00) === 0x1F800000) return this.scratch32[(p & 0x3FF) >> 2];
      if ((p & 0x1FFFF000) === 0x1F801000) {
        this.ioSeq++;
        if (p >= 0x1F801C00 && p < 0x1F802000) {
          const i = (p - 0x1F801C00) >> 1;
          return (this.spu.readReg(i) | (this.spu.readReg(i + 1) << 16)) | 0;
        }
        return this.ioRead32(p);
      }
      if (p >= 0x1F000000 && p < 0x1F800000) return -1;
      if ((addr >>> 0) === 0xFFFE0130) { this.ioSeq++; return this.cacheCtrl; }
      return 0;
    }
    write8(addr, v) {
      this.writeSeq++;
      const p = addr & 0x1FFFFFFF;
      if (p < 0x800000) { if (this.protectStubs && ((p & 0x1FFFFF) - 0x80 >>> 0) < 0x50) return; this.ram[p & 0x1FFFFF] = v; return; }
      if ((p & 0x1FFFFC00) === 0x1F800000) { this.scratch[p & 0x3FF] = v; return; }
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00 && p < 0x1F802000) { if (!(p & 1)) this.spu.writeReg((p - 0x1F801C00) >> 1, v & 0xFF); return; }
        // 8bit I/O 書き(CD-ROM 等)は無視
        return;
      }
    }
    write16(addr, v) {
      this.writeSeq++;
      const p = addr & 0x1FFFFFFF;
      if ((p & 1) && p < 0x800000) { this.write8(addr, v & 0xFF); this.write8(addr + 1, (v >>> 8) & 0xFF); return; }
      if (p < 0x800000) { if (this.protectStubs && ((p & 0x1FFFFF) - 0x80 >>> 0) < 0x50) return; this.ram16[(p & 0x1FFFFF) >> 1] = v; return; }
      if ((p & 0x1FFFFC00) === 0x1F800000) { this.scratch16[(p & 0x3FF) >> 1] = v; return; }
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00 && p < 0x1F802000) { this.spu.writeReg((p - 0x1F801C00) >> 1, v); return; }
        if (p >= 0x1F801100 && p < 0x1F801130) { this.timerWrite(p, v & 0xFFFF); return; }
        if (p === 0x1F801070) { this.iStat &= v; this.updateIrqLine(); return; }
        if (p === 0x1F801074) { this.iMask = v & 0x7FF; this.updateIrqLine(); return; }
        return;
      }
    }
    write32(addr, v) {
      this.writeSeq++;
      const p = addr & 0x1FFFFFFF;
      if ((p & 3) && p < 0x800000) { this.write16(addr, v & 0xFFFF); this.write16(addr + 2, (v >>> 16) & 0xFFFF); return; }
      if (p < 0x800000) { if (this.protectStubs && ((p & 0x1FFFFF) - 0x80 >>> 0) < 0x50) return; this.ram32[(p & 0x1FFFFF) >> 2] = v; return; }
      if ((p & 0x1FFFFC00) === 0x1F800000) { this.scratch32[(p & 0x3FF) >> 2] = v; return; }
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00 && p < 0x1F802000) {
          const i = (p - 0x1F801C00) >> 1;
          this.spu.writeReg(i, v & 0xFFFF); this.spu.writeReg(i + 1, (v >>> 16) & 0xFFFF);
          return;
        }
        this.ioWrite32(p, v);
        return;
      }
      if ((addr >>> 0) === 0xFFFE0130) { this.cacheCtrl = v; return; }
    }

    // ── I/O ───────────────────────────────────────────────
    ioRead32(p) {
      if (p >= 0x1F801000 && p < 0x1F801024) return this.memCtrl[(p - 0x1F801000) >> 2];
      switch (p) {
        case 0x1F801060: return this.ramSize;
        case 0x1F801070: return this.iStat;
        case 0x1F801074: return this.iMask;
        case 0x1F8010F0: return this.dpcr;
        case 0x1F8010F4: return this.dicr;
        case 0x1F801814: return (this.gpuStat & 0x7FFFFFFF) | (this.gpuOdd ? 0x80000000 : 0);
        case 0x1F801810: return 0;
        case 0x1F801040: return 0xFFFFFFFF | 0; // SIO0 data(パッド無し)
        case 0x1F801044: return 0x5; // SIO0 stat: TX ready
        case 0x1F801800: return 0x18; // CDROM: parameter fifo empty/ready
        default: break;
      }
      if (p >= 0x1F801080 && p < 0x1F8010F0) {
        const ch = (p - 0x1F801080) >> 4;
        switch (p & 0xC) { case 0: return this.dmaMadr[ch]; case 4: return this.dmaBcr[ch]; case 8: return this.dmaChcr[ch]; default: return 0; }
      }
      if (p >= 0x1F801100 && p < 0x1F801130) {
        const c = this.counters[(p - 0x1F801100) >> 4];
        switch (p & 0xC) { case 0: return c.count & 0xFFFF; case 4: return c.readMode(); case 8: return c.target; default: return 0; }
      }
      return 0;
    }

    ioWrite32(p, v) {
      if (p >= 0x1F801000 && p < 0x1F801024) { this.memCtrl[(p - 0x1F801000) >> 2] = v; return; }
      switch (p) {
        case 0x1F801060: this.ramSize = v; return;
        case 0x1F801070: this.iStat &= v; this.updateIrqLine(); return;
        case 0x1F801074: this.iMask = v & 0x7FF; this.updateIrqLine(); return;
        case 0x1F8010F0: this.dpcr = v; return;
        case 0x1F8010F4: this.dicrWrite(v); return;
        case 0x1F801810: return; // GP0
        case 0x1F801814: return; // GP1
        default: break;
      }
      if (p >= 0x1F801080 && p < 0x1F8010F0) {
        const ch = (p - 0x1F801080) >> 4;
        switch (p & 0xC) {
          case 0: this.dmaMadr[ch] = v & 0x00FFFFFF; return;
          case 4: this.dmaBcr[ch] = v; return;
          case 8: this.dmaChcrWrite(ch, v); return;
          default: return;
        }
      }
      if (p >= 0x1F801100 && p < 0x1F801130) { this.timerWrite(p, v & 0xFFFF); return; }
    }

    timerWrite(p, v) {
      const c = this.counters[(p - 0x1F801100) >> 4];
      switch (p & 0xC) {
        case 0: c.count = v & 0xFFFF; break;
        case 4: c.writeMode(v); break;
        case 8: c.target = v & 0xFFFF; break;
        default: break;
      }
    }

    // ── DMA ───────────────────────────────────────────────
    dicrWrite(v) {
      // bit24-30 は書き込み 1 でリセット(ack)、bit0-23 は R/W
      const flags = this.dicr & 0x7F000000 & ~(v & 0x7F000000);
      this.dicr = (v & 0x00FFFFFF) | flags;
      this.updateDicrMaster();
    }
    updateDicrMaster() {
      const force = !!(this.dicr & 0x8000);
      const master = !!(this.dicr & 0x800000);
      const flagged = ((this.dicr >>> 24) & 0x7F) & ((this.dicr >>> 16) & 0x7F);
      if (force || (master && flagged)) this.dicr |= 0x80000000; else this.dicr &= 0x7FFFFFFF;
    }
    dmaComplete(ch) {
      this.dmaChcr[ch] &= ~0x11000000; // busy/trigger を落とす
      if ((this.dicr & 0x800000) && (this.dicr & (1 << (16 + ch)))) {
        this.dicr |= (1 << (24 + ch));
        const before = this.dicr & 0x80000000;
        this.updateDicrMaster();
        if (!before && (this.dicr & 0x80000000)) this.raiseIrq(IRQ_DMA);
      }
    }
    dmaChcrWrite(ch, v) {
      this.dmaChcr[ch] = v;
      if (!(v & 0x01000000)) return;                     // start/busy
      if (!(this.dpcr & (8 << (ch * 4)))) return;        // チャンネル無効
      const sync = (v >> 9) & 3;
      if (sync === 0 && !(v & 0x10000000)) return;       // 手動モードはトリガ待ち
      const toDevice = !!(v & 1);
      const step = (v & 2) ? -4 : 4;
      let addr = this.dmaMadr[ch] & 0x1FFFFC;
      const bcr = this.dmaBcr[ch];
      let words;
      if (sync === 0) { words = bcr & 0xFFFF; if (words === 0) words = 0x10000; }
      else if (sync === 1) { const bs = bcr & 0xFFFF, ba = (bcr >>> 16) & 0xFFFF; words = (bs === 0 ? 0x10000 : bs) * (ba === 0 ? 0x10000 : ba); }
      else words = 0; // linked list(GPU)
      switch (ch) {
        case 4: { // SPU
          const spu = this.spu;
          for (let i = 0; i < words; i++) {
            if (toDevice) spu.dmaWrite32(this.ram32[addr >> 2]);
            else this.ram32[addr >> 2] = spu.dmaRead32();
            addr = (addr + step) & 0x1FFFFC;
          }
          break;
        }
        case 6: { // OTC: 逆順リンクリストを RAM に書く
          for (let i = 0; i < words; i++) {
            const next = (i === words - 1) ? 0xFFFFFF : ((addr - 4) & 0x1FFFFC);
            this.ram32[addr >> 2] = next;
            addr = (addr - 4) & 0x1FFFFC;
          }
          break;
        }
        case 2: { // GPU: リンクリストは辿るだけ
          if (sync === 2) {
            let guard = 0;
            let node = addr;
            while (node !== 0xFFFFFC && (node & 0x800000) === 0 && guard++ < 100000) {
              const hdr = this.ram32[node >> 2];
              const next = hdr & 0xFFFFFF;
              if (next === 0xFFFFFF) break;
              node = next & 0x1FFFFC;
            }
          } else {
            addr = (addr + words * step) & 0x1FFFFC;
          }
          break;
        }
        default: // MDEC/CDROM/PIO: 読みは 0 で埋める
          if (!toDevice) for (let i = 0; i < words; i++) { this.ram32[addr >> 2] = 0; addr = (addr + step) & 0x1FFFFC; }
          break;
      }
      this.dmaMadr[ch] = addr;
      this.dmaComplete(ch);
    }

    // ── ユーティリティ ────────────────────────────────────
    /** RAM への一括書き込み(PS-EXE セグメント) */
    loadSegment(addr, data) {
      const p = addr & 0x1FFFFF;
      const n = Math.min(data.length, RAM_SIZE - p);
      this.ram.set(data.subarray(0, n), p);
      return n;
    }
    readString(addr, max) {
      let s = '';
      for (let i = 0; i < (max || 1024); i++) {
        const c = this.read8(addr + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
  }

  PsxBus.CPU_CLOCK = CPU_CLOCK;
  PsxBus.CYCLES_PER_SAMPLE = CYCLES_PER_SAMPLE;
  PsxBus.IRQ = { VBLANK: IRQ_VBLANK, GPU: IRQ_GPU, CDROM: IRQ_CDROM, DMA: IRQ_DMA, TMR0: IRQ_TMR0, TMR1: IRQ_TMR1, TMR2: IRQ_TMR2, SIO0: IRQ_SIO0, SIO1: IRQ_SIO1, SPU: IRQ_SPU, PIO: IRQ_PIO };
  Emu.PsxBus = PsxBus;
})(globalThis);

/*
 * PlayStation カーネル(BIOS)の高水準模倣(HLE)
 * MML.Emu.PsxBios
 *
 * BIOS ROM は同梱できないので、PSF の音源ドライバが使うカーネル機能を JS で肩代わりする。
 * 方針は PCSX / Highly Experimental の HLE と同じ:
 *   - RAM 0xA0/0xB0/0xC0 の呼び出し口と 0x80 の例外ベクタに、BIOS 領域(0xBFC01000..)の
 *     「トラップ番地」へ飛ぶ 4 命令のスタブを置く。CPU がトラップ番地に来たら JS で処理して戻る。
 *   - 例外(割込み): レジスタを TCB に退避 → カーネルイベント(ルートカウンタ/VBlank)を配送 →
 *     SysEnqIntRP で登録された利用者ハンドラ列を verifier/handler の順に呼ぶ →
 *     SetCustomExitFromException(HookEntryInt) の jmp_buf があればそこへ longjmp(libetc の
 *     コールバック機構がこれ)、無ければ I_STAT を ack して ReturnFromException。
 *   - SYSCALL: EnterCriticalSection(1)/ExitCriticalSection(2) は SR の IEp/IM2 を操作して即復帰。
 *   - イベント(OpenEvent/EnableEvent/DeliverEvent/WaitEvent/TestEvent…)、ルートカウンタ
 *     (SetRCnt/StartRCnt…)、ヒープ(InitHeap/malloc/free)、文字列/メモリ関数、printf(ログのみ)。
 *   - ネストした呼び出し(イベントハンドラ等)は softCall(): ra を「戻りトラップ番地」にして
 *     CPU を回し、そこへ戻ってきたら抜ける。その間も bus.sync で周辺を進める。
 *
 * 未知の関数番号は「0 を返す」だけにして unknownCalls に記録する(黙って壊れない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const TRAP_A0 = 0xBFC01000 | 0, TRAP_B0 = 0xBFC01010 | 0, TRAP_C0 = 0xBFC01020 | 0;
  const TRAP_EXC = 0xBFC01030 | 0, TRAP_RET = 0xBFC01040 | 0, TRAP_IDLE = 0xBFC01050 | 0;
  const KERNEL_STACK = 0x8000FF00 | 0;       // HLE が使うカーネルスタック
  const KERNEL_ALLOC_BASE = 0x8000E000 | 0;  // alloc_kernel_memory の払い出し先
  const EV_FREE = 0, EV_DISABLED = 0x1000, EV_ACTIVE = 0x2000, EV_READY = 0x4000;
  const EvMdINTR = 0x1000, EvMdNOINTR = 0x2000;
  const EvSpINT = 0x0002;
  const SOFTCALL_STEP_LIMIT = 20000000;

  // レジスタ番号
  const A0 = 4, A1 = 5, A2 = 6, A3 = 7, V0 = 2, V1 = 3, T1 = 9, SP = 29, FP = 30, RA = 31, GP = 28;

  class PsxBios {
    constructor(bus, cpu) {
      this.bus = bus; this.cpu = cpu;
      this.ttyLog = [];
      this.unknownCalls = new Map();
      this.reset();
      bus.onTrap = (c, pc) => this.onTrap(c, pc);
    }

    reset() {
      this.events = [];
      for (let i = 0; i < 256; i++) this.events.push({ status: EV_FREE, cls: 0, spec: 0, mode: 0, func: 0 });
      this.chains = [[], [], [], []];
      this.jmpBuf = 0;
      this.tcb = null;
      this.autoAck = [false, true, true, true]; // [vblank, tmr0, tmr1, tmr2]
      this.heapBase = 0; this.heapSize = 0; this.heapBlocks = [];
      this.kernelAllocPtr = KERNEL_ALLOC_BASE;
      this.randSeed = 0x12345678;
      this.softDepth = 0; this.softReturned = false;
      this.inException = false;
      this.lastExceptionCount = -1;
      this.sideEffectSeq = 0;
      this.exceptionDepth = 0;
      this.halted = false; this.haltReason = '';
      this.badExceptions = 0;
      this.ttyLog.length = 0;
      this.stats = { a0: 0, b0: 0, c0: 0, exc: 0, syscall: 0, softCalls: 0, events: 0 };
    }

    /** RAM にスタブを置く(bus.reset 後に呼ぶ) */
    install() {
      const bus = this.bus;
      // 例外ベクタは k0、関数呼び出し口は t0 を使う(実機 BIOS と同じ)。
      // 呼び出し口で k0 を使うと、スタブ実行中に割込みが入ったとき例外入口が k0 を
      // 上書きし、復帰後の jr k0 が例外トラップへ飛んで無限ループになる。
      const stub = (at, target, reg) => {
        const hi = (target >>> 16) & 0xFFFF, lo = target & 0xFFFF;
        bus.write32(at, (0x0F << 26) | (reg << 16) | hi);                  // lui reg, hi
        bus.write32(at + 4, (0x0D << 26) | (reg << 21) | (reg << 16) | lo); // ori reg, reg, lo
        bus.write32(at + 8, (reg << 21) | 0x08);                          // jr reg
        bus.write32(at + 12, 0);                                          // nop
      };
      stub(0x80, TRAP_EXC, 26);
      stub(0xA0, TRAP_A0, 8); stub(0xB0, TRAP_B0, 8); stub(0xC0, TRAP_C0, 8);
      // 0xBFC00000(リセットベクタ)にも来たら halt
      bus.protectStubs = true;
    }

    // ── トラップ入口 ──────────────────────────────────────
    onTrap(cpu, pc) {
      switch (pc | 0) {
        // 状態を読むだけの呼び出し(TestEvent/WaitEvent)以外は、アイドル判定を崩すため sideEffectSeq を進める
        case TRAP_A0: this.stats.a0++; this.sideEffectSeq++; this.callA0(cpu.r[T1] & 0xFF); return true;
        case TRAP_B0: { this.stats.b0++; const n = cpu.r[T1] & 0xFF; if (n !== 0x0A && n !== 0x0B) this.sideEffectSeq++; this.callB0(n); return true; }
        case TRAP_C0: this.stats.c0++; this.sideEffectSeq++; this.callC0(cpu.r[T1] & 0xFF); return true;
        case TRAP_EXC:
          this.sideEffectSeq++;
          if (cpu.exceptionCount === this.lastExceptionCount) { this.halt('jumped to exception vector without an exception'); return true; }
          this.lastExceptionCount = cpu.exceptionCount;
          this.exception(); return true;
        case TRAP_RET: this.softReturned = true; return true;
        case TRAP_IDLE: return true; // 何もしない(時間だけ進む)
        default:
          this.halt('unexpected pc in BIOS area: 0x' + (pc >>> 0).toString(16));
          return true;
      }
    }

    halt(reason) {
      if (!this.halted) { this.halted = true; this.haltReason = reason; }
      this.cpu.halted = true;
    }

    /** 呼び出し元(ra)へ戻る */
    ret(v0) {
      const cpu = this.cpu;
      if (v0 !== undefined) cpu.r[V0] = v0 | 0;
      cpu.pc = cpu.r[RA]; cpu.nextPc = (cpu.pc + 4) | 0;
      cpu.branchDelay = false;
    }

    /** 同じ関数をもう一度実行させる(ビジーウェイト相当。割込みは間に入れる) */
    retry() {
      const cpu = this.cpu;
      cpu.nextPc = (cpu.pc + 4) | 0; // pc は変えない(トラップに留まる)
      cpu.branchDelay = false;
    }

    unknown(table, n) {
      const key = table + ':' + n.toString(16).padStart(2, '0');
      this.unknownCalls.set(key, (this.unknownCalls.get(key) || 0) + 1);
      this.ret(0);
    }

    // ── ネスト呼び出し ────────────────────────────────────
    /**
     * addr の MIPS 関数を呼び、戻るまで CPU を回す。戻り値は v0。
     * 呼び出し中のレジスタは全て保存/復元する(呼び出し元の状態を壊さない)。
     */
    softCall(addr, args) {
      const cpu = this.cpu, bus = this.bus;
      if (!addr) return 0;
      this.stats.softCalls++;
      const savedR = Int32Array.from(cpu.r);
      const saved = { pc: cpu.pc, nextPc: cpu.nextPc, hi: cpu.hi, lo: cpu.lo, branchDelay: cpu.branchDelay, returned: this.softReturned };
      cpu.branchDelay = false;
      if (args) for (let i = 0; i < args.length && i < 4; i++) cpu.r[A0 + i] = args[i] | 0;
      cpu.r[RA] = TRAP_RET;
      cpu.r[SP] = (KERNEL_STACK - 0x100 * this.softDepth) | 0;
      cpu.pc = addr | 0; cpu.nextPc = (addr + 4) | 0;
      this.softDepth++;
      this.softReturned = false;
      let steps = 0;
      while (!this.softReturned && !cpu.halted) {
        cpu.step();
        if ((++steps & 0xFF) === 0) bus.sync(cpu.cycles);
        if (steps > SOFTCALL_STEP_LIMIT) { this.halt('softCall runaway at 0x' + (addr >>> 0).toString(16)); break; }
      }
      this.softDepth--;
      const result = cpu.r[V0];
      cpu.r.set(savedR);
      cpu.pc = saved.pc; cpu.nextPc = saved.nextPc; cpu.hi = saved.hi; cpu.lo = saved.lo;
      cpu.branchDelay = saved.branchDelay;
      this.softReturned = saved.returned;
      return result;
    }

    // ── 例外 ──────────────────────────────────────────────
    exception() {
      const cpu = this.cpu, bus = this.bus;
      const code = (cpu.cause >> 2) & 0x1F;
      this.stats.exc++;
      if (code === 8) { // SYSCALL
        this.stats.syscall++;
        const fn = cpu.r[A0];
        if (fn === 1) { cpu.r[V0] = (cpu.sr & 0x4) ? 1 : 0; cpu.sr &= ~0x404; }      // EnterCriticalSection
        else if (fn === 2) { cpu.sr |= 0x404; cpu.r[V0] = 0; }                        // ExitCriticalSection
        else if (fn === 3) { cpu.r[V0] = 0; }                                         // ChangeThreadSubFunction
        cpu.pc = (cpu.epc + 4) | 0; cpu.nextPc = (cpu.pc + 4) | 0;
        cpu.rfe();
        cpu.branchDelay = false;
        return;
      }
      if (code === 0) { // 割込み
        this.saveTcb();
        this.exceptionDepth++;
        const pending = bus.iStat & bus.iMask;
        // カーネルのタイマ/VBlank ハンドラ相当: イベント配送
        if (pending & 1) {
          this.deliverEvent(0xF2000003, EvSpINT);
          this.deliverEvent(0xF0000001, EvSpINT);
          if (this.autoAck[0]) { bus.iStat &= ~1; bus.updateIrqLine(); }
        }
        for (let i = 0; i < 3; i++) {
          const bit = 0x10 << i;
          if (pending & bit) {
            this.deliverEvent(0xF2000000 + i, EvSpINT);
            if (this.autoAck[1 + i]) { bus.iStat &= ~bit; bus.updateIrqLine(); }
          }
        }
        if (pending & 0x200) this.deliverEvent(0xF0000009, EvSpINT); // SPU
        if (pending & 0x008) this.deliverEvent(0xF0000004, EvSpINT); // (慣例的な DMA クラス)
        // 利用者の割込みハンドラ列(SysEnqIntRP)
        for (let prio = 0; prio < 4; prio++) {
          const chain = this.chains[prio];
          for (let k = 0; k < chain.length; k++) {
            const el = chain[k];
            const verifier = bus.read32(el + 8), handler = bus.read32(el + 4);
            if (!verifier) continue;
            const v = this.softCall(verifier, []);
            if (v !== 0 && handler) this.softCall(handler, [v]);
          }
        }
        this.exceptionDepth--;
        if (this.jmpBuf) {
          // libetc のコールバック機構へ longjmp(I_STAT の ack は向こうがやる)
          const jb = this.jmpBuf;
          cpu.r[RA] = bus.read32(jb); cpu.r[SP] = bus.read32(jb + 4); cpu.r[FP] = bus.read32(jb + 8);
          for (let i = 0; i < 8; i++) cpu.r[16 + i] = bus.read32(jb + 12 + i * 4);
          cpu.r[GP] = bus.read32(jb + 44);
          cpu.r[V0] = 1;
          cpu.pc = cpu.r[RA]; cpu.nextPc = (cpu.pc + 4) | 0; cpu.branchDelay = false;
          return;
        }
        // 誰も処理しないビットが残ると無限に再入するので、保留していた分は全て ack する
        bus.iStat &= ~pending; bus.updateIrqLine();
        this.returnFromException();
        return;
      }
      // その他の例外(アドレスエラー/不正命令/オーバーフロー): 実機なら SystemError で停止。
      // 変換用途では「その命令を飛ばして続行」し、多発したら止める。
      this.badExceptions++;
      if (this.badExceptions === 1) this.ttyLog.push(`[exception code ${code} at 0x${(cpu.epc >>> 0).toString(16)} badvaddr=0x${(cpu.badVaddr >>> 0).toString(16)}]`);
      if (this.badExceptions > 10000) { this.halt('too many CPU exceptions (code ' + code + ')'); return; }
      cpu.pc = (cpu.epc + 4) | 0; cpu.nextPc = (cpu.pc + 4) | 0;
      cpu.rfe(); cpu.branchDelay = false;
    }

    saveTcb() {
      const cpu = this.cpu;
      this.tcb = { r: Int32Array.from(cpu.r), hi: cpu.hi, lo: cpu.lo, epc: cpu.epc, sr: cpu.sr };
    }

    returnFromException() {
      const cpu = this.cpu;
      const t = this.tcb;
      if (!t) { this.halt('ReturnFromException without saved context'); return; }
      cpu.r.set(t.r); cpu.hi = t.hi; cpu.lo = t.lo;
      cpu.sr = t.sr;
      cpu.pc = t.epc; cpu.nextPc = (t.epc + 4) | 0;
      cpu.rfe();
      cpu.branchDelay = false;
      cpu.cause &= ~0x400; // 再評価させる
    }

    // ── イベント ──────────────────────────────────────────
    deliverEvent(cls, spec) {
      for (let i = 0; i < this.events.length; i++) {
        const ev = this.events[i];
        if (ev.status !== EV_ACTIVE || (ev.cls >>> 0) !== (cls >>> 0) || ev.spec !== spec) continue;
        this.stats.events++;
        if (ev.mode === EvMdINTR && ev.func) this.softCall(ev.func, []);
        else ev.status = EV_READY;
      }
    }
    eventOf(id) {
      const idx = id & 0xFFFF;
      if ((id & 0xFFFF0000) !== (0xF1000000 | 0) || idx >= this.events.length) return null;
      return this.events[idx];
    }

    // ── A0 ────────────────────────────────────────────────
    callA0(n) {
      const cpu = this.cpu, bus = this.bus, r = cpu.r;
      const a0 = r[A0], a1 = r[A1], a2 = r[A2];
      switch (n) {
        case 0x0E: this.ret(Math.abs(a0) | 0); return;              // abs
        case 0x0F: this.ret(Math.abs(a0) | 0); return;              // labs
        case 0x10: case 0x11: this.ret(parseInt(bus.readString(a0, 32), 10) | 0); return; // atoi/atol
        case 0x13: { // setjmp
          bus.write32(a0, r[RA]); bus.write32(a0 + 4, r[SP]); bus.write32(a0 + 8, r[FP]);
          for (let i = 0; i < 8; i++) bus.write32(a0 + 12 + i * 4, r[16 + i]);
          bus.write32(a0 + 44, r[GP]);
          this.ret(0); return;
        }
        case 0x14: { // longjmp
          r[RA] = bus.read32(a0); r[SP] = bus.read32(a0 + 4); r[FP] = bus.read32(a0 + 8);
          for (let i = 0; i < 8; i++) r[16 + i] = bus.read32(a0 + 12 + i * 4);
          r[GP] = bus.read32(a0 + 44);
          this.ret(a1); return;
        }
        case 0x15: { // strcat
          let d = a0; while (bus.read8(d)) d++;
          let s = a1, c; do { c = bus.read8(s++); bus.write8(d++, c); } while (c);
          this.ret(a0); return;
        }
        case 0x16: { // strncat
          let d = a0; while (bus.read8(d)) d++;
          let s = a1, i = 0;
          for (; i < a2; i++) { const c = bus.read8(s++); if (!c) break; bus.write8(d++, c); }
          bus.write8(d, 0); this.ret(a0); return;
        }
        case 0x17: { // strcmp
          let p = a0, q = a1;
          for (;;) { const x = bus.read8(p++), y = bus.read8(q++); if (x !== y) { this.ret(x - y); return; } if (!x) { this.ret(0); return; } }
        }
        case 0x18: { // strncmp
          let p = a0, q = a1;
          for (let i = 0; i < a2; i++) { const x = bus.read8(p++), y = bus.read8(q++); if (x !== y) { this.ret(x - y); return; } if (!x) break; }
          this.ret(0); return;
        }
        case 0x19: { let d = a0, s = a1, c; do { c = bus.read8(s++); bus.write8(d++, c); } while (c); this.ret(a0); return; } // strcpy
        case 0x1A: { // strncpy
          let d = a0, s = a1, i = 0, ended = false;
          for (; i < a2; i++) { let c = 0; if (!ended) { c = bus.read8(s++); if (!c) ended = true; } bus.write8(d++, c); }
          this.ret(a0); return;
        }
        case 0x1B: { let p = a0, len = 0; if (a0) while (bus.read8(p++)) len++; this.ret(len); return; } // strlen
        case 0x1C: case 0x1E: { // index/strchr
          let p = a0; for (;;) { const c = bus.read8(p); if (c === (a1 & 0xFF)) { this.ret(p); return; } if (!c) { this.ret(0); return; } p++; }
        }
        case 0x1D: case 0x1F: { // rindex/strrchr
          let p = a0, found = 0; for (;;) { const c = bus.read8(p); if (c === (a1 & 0xFF)) found = p; if (!c) break; p++; } this.ret(found); return;
        }
        case 0x24: { // strstr
          const hay = bus.readString(a0, 4096), needle = bus.readString(a1, 4096);
          const idx = hay.indexOf(needle); this.ret(idx < 0 ? 0 : (a0 + idx)); return;
        }
        case 0x25: this.ret((a0 >= 0x61 && a0 <= 0x7A) ? a0 - 0x20 : a0); return; // toupper
        case 0x26: this.ret((a0 >= 0x41 && a0 <= 0x5A) ? a0 + 0x20 : a0); return; // tolower
        case 0x27: this.memmove(a1, a0, a2); this.ret(a1); return;    // bcopy(src,dst,len)
        case 0x28: this.memset(a0, 0, a1); this.ret(a0); return;      // bzero
        case 0x29: this.ret(this.memcmp(a0, a1, a2)); return;         // bcmp
        case 0x2A: this.memmove(a0, a1, a2); this.ret(a0); return;    // memcpy
        case 0x2B: this.memset(a0, a1, a2); this.ret(a0); return;     // memset
        case 0x2C: this.memmove(a0, a1, a2); this.ret(a0); return;    // memmove
        case 0x2D: this.ret(this.memcmp(a0, a1, a2)); return;         // memcmp
        case 0x2E: { for (let i = 0; i < a2; i++) if (bus.read8(a0 + i) === (a1 & 0xFF)) { this.ret(a0 + i); return; } this.ret(0); return; } // memchr
        case 0x2F: { this.randSeed = (Math.imul(this.randSeed, 1103515245) + 12345) | 0; this.ret((this.randSeed >>> 16) & 0x7FFF); return; } // rand
        case 0x30: this.randSeed = a0; this.ret(0); return;           // srand
        case 0x33: this.ret(this.malloc(a0)); return;
        case 0x34: this.free(a0); this.ret(0); return;
        case 0x37: { const p = this.malloc(Math.imul(a0, a1)); if (p) this.memset(p, 0, Math.imul(a0, a1)); this.ret(p); return; } // calloc
        case 0x38: { // realloc
          if (!a0) { this.ret(this.malloc(a1)); return; }
          const blk = this.heapBlocks.find(b => b.addr === (a0 | 0));
          const p = this.malloc(a1);
          if (p && blk) this.memmove(p, a0, Math.min(blk.size, a1));
          this.free(a0); this.ret(p); return;
        }
        case 0x39: this.heapBase = a0 | 0; this.heapSize = a1 | 0; this.heapBlocks = []; this.ret(0); return; // InitHeap
        case 0x3C: this.tty(String.fromCharCode(a0 & 0xFF)); this.ret(a0); return; // std_out_putchar
        case 0x3E: this.tty(bus.readString(a0, 1024) + '\n'); this.ret(0); return; // std_out_puts
        case 0x3F: this.printf(); this.ret(0); return;
        case 0x40: this.halt('SystemErrorUnresolvedException'); return;
        case 0x44: this.ret(0); return;                               // FlushCache
        case 0x4D: this.ret(bus.read32(0x1F801814)); return;          // GetGPUStatus
        case 0x4E: this.ret(0); return;                               // gpu_sync
        case 0x46: case 0x47: case 0x48: case 0x49: case 0x4A: case 0x4B: case 0x4C: this.ret(0); return; // GPU 各種
        case 0x54: case 0x71: this.ret(1); return;                    // CdInit / _96_init
        case 0x56: case 0x72: this.ret(1); return;                    // CdRemove / _96_remove
        case 0x55: case 0x70: this.ret(1); return;                    // _bu_init
        case 0x78: case 0x7C: case 0x7E: case 0x81: this.ret(1); return; // CdAsync*
        case 0x90: case 0x91: case 0x92: case 0x93: this.ret(0); return;
        case 0x94: case 0x95: this.ret(0); return;
        case 0x96: case 0x97: case 0x98: case 0x99: this.ret(0); return; // Add*Device
        case 0x9C: this.ret(0); return;                               // SetConf
        case 0x9D: bus.write32(a0, 4); bus.write32(a1, 16); bus.write32(a2, 0x801FFF00); this.ret(0); return; // GetConf
        case 0x9E: this.ret(0); return;                               // SetCdromIrqAutoAbort
        case 0x9F: this.ret(0); return;                               // SetMemSize
        case 0xA1: this.halt('SystemErrorBootOrDiskFailure'); return;
        case 0xA2: case 0xA3: this.ret(0); return;                    // EnqueueCdIntr/DequeueCdIntr
        case 0xA4: case 0xA5: case 0xA6: this.ret(0); return;         // CdGetLbn/CdReadSector/CdGetStatus
        case 0x00: case 0x01: case 0x02: case 0x03: case 0x04: case 0x05: this.ret(-1); return; // file I/O
        case 0x06: this.halt('exit()'); return;
        case 0x3A: this.halt('SystemErrorExit'); return;
        case 0x08: this.ret(-1); return;                              // getc
        case 0x09: this.tty(String.fromCharCode(a0 & 0xFF)); this.ret(a0); return; // putc
        default: this.unknown('A0', n); return;
      }
    }

    // ── B0 ────────────────────────────────────────────────
    callB0(n) {
      const cpu = this.cpu, bus = this.bus, r = cpu.r;
      const a0 = r[A0], a1 = r[A1], a2 = r[A2], a3 = r[A3];
      switch (n) {
        case 0x00: { // alloc_kernel_memory
          const p = this.kernelAllocPtr; this.kernelAllocPtr = (p + ((a0 + 7) & ~7)) | 0;
          if ((this.kernelAllocPtr & 0x1FFFFF) > 0xFF00) { this.kernelAllocPtr = KERNEL_ALLOC_BASE; }
          this.ret(p); return;
        }
        case 0x01: this.ret(0); return; // free_kernel_memory
        // ── ルートカウンタ ──
        case 0x02: { // SetRCnt(index, target, mode)
          const t = a0 & 3;
          if (t !== 3) {
            const base = 0x1F801100 + t * 0x10;
            bus.write32(base + 8, a1 & 0xFFFF);
            let mode = 0;
            if (a2 & 0x1000) mode |= 0x050;   // RCntMdINTR: 目標でIRQ+繰り返し
            if (a2 & 0x0100) mode |= 0x008;   // 目標で0に戻す
            if (a2 & 0x0010) mode |= 0x001;   // RCntMdSP (stop)
            if (t === 2 && (a2 & 0x0001)) mode |= 0x200; // sysclk/8
            bus.write32(base + 4, mode);
          }
          this.ret(1); return;
        }
        case 0x03: { const t = a0 & 3; this.ret(t === 3 ? 0 : bus.counters[t].count & 0xFFFF); return; } // GetRCnt
        case 0x04: { const t = a0 & 3; bus.iMask |= (t === 3 ? 1 : (0x10 << t)); bus.updateIrqLine(); this.ret(1); return; } // StartRCnt
        case 0x05: { const t = a0 & 3; bus.iMask &= ~(t === 3 ? 1 : (0x10 << t)); bus.updateIrqLine(); this.ret(1); return; } // StopRCnt
        case 0x06: { const t = a0 & 3; if (t !== 3) bus.counters[t].count = 0; this.ret(1); return; } // ResetRCnt
        // ── イベント ──
        case 0x07: this.deliverEvent(a0, a1 & 0xFFFF); this.ret(0); return; // DeliverEvent
        case 0x08: { // OpenEvent(class, spec, mode, func)
          const idx = this.events.findIndex(e => e.status === EV_FREE);
          if (idx < 0) { this.ret(-1); return; }
          const ev = this.events[idx];
          ev.status = EV_DISABLED; ev.cls = a0; ev.spec = a1 & 0xFFFF; ev.mode = a2 & 0xFFFF; ev.func = a3;
          this.ret((0xF1000000 | idx) | 0); return;
        }
        case 0x09: { const ev = this.eventOf(a0); if (ev) ev.status = EV_FREE; this.ret(1); return; } // CloseEvent
        case 0x0A: { // WaitEvent
          const ev = this.eventOf(a0);
          if (!ev || ev.status === EV_FREE) { this.ret(0); return; }
          if (ev.status === EV_READY) { ev.status = EV_ACTIVE; this.ret(1); return; }
          if (ev.status === EV_DISABLED) { this.ret(0); return; }
          this.retry(); return; // 来るまで待つ(割込みは入る)
        }
        case 0x0B: { const ev = this.eventOf(a0); if (ev && ev.status === EV_READY) { ev.status = EV_ACTIVE; this.ret(1); } else this.ret(0); return; } // TestEvent
        case 0x0C: { const ev = this.eventOf(a0); if (ev && ev.status !== EV_FREE) ev.status = EV_ACTIVE; this.ret(1); return; } // EnableEvent
        case 0x0D: { const ev = this.eventOf(a0); if (ev && ev.status !== EV_FREE) ev.status = EV_DISABLED; this.ret(1); return; } // DisableEvent
        case 0x20: { for (const ev of this.events) if (ev.status === EV_READY && (ev.cls >>> 0) === (a0 >>> 0) && ev.spec === (a1 & 0xFFFF)) ev.status = EV_ACTIVE; this.ret(0); return; } // UnDeliverEvent
        // ── スレッド(形だけ) ──
        case 0x0E: this.ret(0xFF000001 | 0); return; // OpenThread
        case 0x0F: this.ret(1); return;              // CloseThread
        case 0x10: this.ret(1); return;              // ChangeThread
        // ── パッド ──
        case 0x12: case 0x13: case 0x14: case 0x15: this.ret(1); return;
        case 0x16: this.ret(0xFFFF); return;
        case 0x5B: this.ret(0); return;              // ChangeClearPad
        // ── 例外関連 ──
        case 0x17: this.returnFromException(); return;
        case 0x18: this.jmpBuf = 0; this.ret(0); return;               // SetDefaultExitFromException
        case 0x19: this.jmpBuf = a0 | 0; this.ret(0); return;          // SetCustomExitFromException(HookEntryInt)
        // ── ファイル/TTY ──
        case 0x32: this.ret(-1); return; // FileOpen
        case 0x33: case 0x34: case 0x36: case 0x37: this.ret(-1); return;
        case 0x35: this.ret(a2); return; // FileWrite(標準出力扱い)
        case 0x38: this.halt('exit()'); return;
        case 0x3B: this.tty(String.fromCharCode(a1 & 0xFF)); this.ret(a1); return; // FilePutc
        case 0x3C: this.ret(-1); return;
        case 0x3D: this.tty(String.fromCharCode(a0 & 0xFF)); this.ret(a0); return; // std_out_putchar
        case 0x3F: this.tty(bus.readString(a0, 1024) + '\n'); this.ret(0); return; // std_out_puts
        case 0x47: case 0x48: this.ret(0); return; // AddDevice/RemoveDevice
        case 0x49: this.ret(0); return;
        case 0x4A: case 0x4B: case 0x4C: this.ret(1); return; // InitCard/StartCard/StopCard
        case 0x4D: case 0x4E: case 0x4F: case 0x50: this.ret(0); return;
        case 0x51: case 0x53: this.ret(0); return;
        case 0x54: case 0x55: this.ret(0); return; // GetLastError
        case 0x56: this.ret(0xC0); return;         // GetC0Table(便宜上)
        case 0x57: this.ret(0xB0); return;         // GetB0Table
        case 0x58: this.ret(0); return;
        case 0x59: this.ret(0); return;
        case 0x5C: case 0x5D: this.ret(1); return; // get_card_status/wait_card_status
        default: this.unknown('B0', n); return;
      }
    }

    // ── C0 ────────────────────────────────────────────────
    callC0(n) {
      const cpu = this.cpu, bus = this.bus, r = cpu.r;
      const a0 = r[A0], a1 = r[A1];
      switch (n) {
        case 0x00: case 0x01: this.ret(0); return; // EnqueueTimerAndVblankIrqs / EnqueueSyscallHandler
        case 0x02: { // SysEnqIntRP(priority, element)
          const prio = a0 & 3;
          if (!this.chains[prio].includes(a1 | 0)) this.chains[prio].unshift(a1 | 0);
          this.ret(0); return;
        }
        case 0x03: { // SysDeqIntRP
          const prio = a0 & 3;
          this.chains[prio] = this.chains[prio].filter(e => e !== (a1 | 0));
          this.ret(0); return;
        }
        case 0x04: { const idx = this.events.findIndex(e => e.status === EV_FREE); this.ret(idx < 0 ? -1 : idx); return; } // get_free_EvCB_slot
        case 0x05: this.ret(0); return;
        case 0x06: this.ret(0); return;
        case 0x07: this.ret(0); return; // InstallExceptionHandlers(スタブは既にある)
        case 0x08: this.ret(0); return; // SysInitMemory
        case 0x09: this.ret(0); return; // SysInitKernelVariables
        case 0x0A: { // ChangeClearRCnt(t, flag) → 旧値
          const t = a0 & 3;
          const slot = t === 3 ? 0 : 1 + t;
          const old = this.autoAck[slot] ? 1 : 0;
          this.autoAck[slot] = !!a1;
          this.ret(old); return;
        }
        case 0x0B: this.halt('SystemError(C0:0B)'); return;
        case 0x0C: this.ret(0); return; // InitDefInt
        case 0x0D: { // SetIrqAutoAck(irq, flag)
          const irq = a0 | 0;
          if (irq === 0) this.autoAck[0] = !!a1;
          else if (irq >= 4 && irq <= 6) this.autoAck[irq - 3] = !!a1;
          this.ret(0); return;
        }
        case 0x12: case 0x13: this.ret(0); return; // InstallDevices/FlushStdInOutPut
        case 0x1B: this.ret(0); return;            // KernelRedirect
        case 0x1C: this.ret(0); return;            // AdjustA0Table
        default: this.unknown('C0', n); return;
      }
    }

    // ── メモリ補助 ────────────────────────────────────────
    memmove(dst, src, len) {
      const bus = this.bus;
      if (len <= 0) return;
      const d = dst >>> 0, s = src >>> 0;
      // RAM 同士なら typed array で一気に(重なりは copyWithin が面倒を見る)
      const dp = d & 0x1FFFFFFF, sp = s & 0x1FFFFFFF;
      if (dp < 0x800000 && sp < 0x800000 && (dp & 0x1FFFFF) + len <= 0x200000 && (sp & 0x1FFFFF) + len <= 0x200000) {
        bus.ram.copyWithin(dp & 0x1FFFFF, sp & 0x1FFFFF, (sp & 0x1FFFFF) + len);
        return;
      }
      if (d > s && d < s + len) { for (let i = len - 1; i >= 0; i--) bus.write8(d + i, bus.read8(s + i)); }
      else { for (let i = 0; i < len; i++) bus.write8(d + i, bus.read8(s + i)); }
    }
    memset(dst, val, len) {
      const bus = this.bus;
      const dp = (dst >>> 0) & 0x1FFFFFFF;
      if (dp < 0x800000 && (dp & 0x1FFFFF) + len <= 0x200000) { bus.ram.fill(val & 0xFF, dp & 0x1FFFFF, (dp & 0x1FFFFF) + len); return; }
      for (let i = 0; i < len; i++) bus.write8(dst + i, val & 0xFF);
    }
    memcmp(a, b, len) {
      const bus = this.bus;
      for (let i = 0; i < len; i++) { const x = bus.read8(a + i), y = bus.read8(b + i); if (x !== y) return x - y; }
      return 0;
    }

    // ── ヒープ(first-fit) ─────────────────────────────────
    malloc(size) {
      if (!this.heapSize) return 0;
      size = (size + 7) & ~7;
      if (size <= 0) size = 8;
      const blocks = this.heapBlocks.sort((x, y) => x.addr - y.addr);
      let cur = this.heapBase;
      for (const b of blocks) {
        if (b.addr - cur >= size) break;
        cur = b.addr + b.size;
      }
      if (cur + size > this.heapBase + this.heapSize) return 0;
      this.heapBlocks.push({ addr: cur | 0, size });
      return cur | 0;
    }
    free(addr) {
      const i = this.heapBlocks.findIndex(b => b.addr === (addr | 0));
      if (i >= 0) this.heapBlocks.splice(i, 1);
    }

    // ── TTY / printf ──────────────────────────────────────
    tty(s) {
      if (this.ttyLog.length > 2000) return;
      const last = this.ttyLog.length - 1;
      if (last >= 0 && !this.ttyLog[last].endsWith('\n')) this.ttyLog[last] += s;
      else this.ttyLog.push(s);
    }
    printf() {
      const cpu = this.cpu, bus = this.bus;
      const fmt = bus.readString(cpu.r[A0], 1024);
      let argIdx = 1;
      const nextArg = () => {
        const i = argIdx++;
        if (i < 4) return cpu.r[A0 + i];
        return bus.read32(cpu.r[SP] + i * 4);
      };
      let out = '';
      for (let i = 0; i < fmt.length; i++) {
        const c = fmt[i];
        if (c !== '%') { out += c; continue; }
        let j = i + 1, spec = '';
        while (j < fmt.length && /[-+ 0-9.lh#]/.test(fmt[j])) spec += fmt[j++];
        const conv = fmt[j] || '';
        i = j;
        const width = parseInt(spec.replace(/[^0-9]/g, ''), 10) || 0;
        const pad = (s) => { if (s.length >= width) return s; return (spec.startsWith('0') ? '0' : ' ').repeat(width - s.length) + s; };
        switch (conv) {
          case 'd': case 'i': out += pad(String(nextArg())); break;
          case 'u': out += pad(String(nextArg() >>> 0)); break;
          case 'x': out += pad((nextArg() >>> 0).toString(16)); break;
          case 'X': out += pad((nextArg() >>> 0).toString(16).toUpperCase()); break;
          case 'c': out += String.fromCharCode(nextArg() & 0xFF); break;
          case 's': out += bus.readString(nextArg(), 1024); break;
          case 'p': out += '0x' + (nextArg() >>> 0).toString(16); break;
          case '%': out += '%'; break;
          default: out += '%' + spec + conv; break;
        }
      }
      this.tty(out);
    }
  }

  PsxBios.TRAP = { A0: TRAP_A0, B0: TRAP_B0, C0: TRAP_C0, EXC: TRAP_EXC, RET: TRAP_RET, IDLE: TRAP_IDLE };
  Emu.PsxBios = PsxBios;
})(globalThis);

/*
 * PSF1 プレイヤー(CPU + バス + SPU + HLE BIOS の結線)
 * MML.Emu.PsfPlayer
 *
 *   const info = await MML.PSF.load(bytes, resolveLib);
 *   const p = new MML.Emu.PsfPlayer(info);
 *   p.reset();
 *   const { left, right } = p.render(44100);   // 44.1kHz のステレオ Float32Array
 *
 * - 44.1kHz(SPU の実レート)で生成する。出力レートへの変換は呼び出し側(ストリームプレイヤー)。
 * - speedFactor: CPU とタイマ/VBlank だけ速める(SPU クロックは不変=音程は変わらない)。
 *   CPU は bus.sync に渡すサイクルを「実時間 × speedFactor」ぶん回す。
 * - アイドル省略(厳密): 1スライス(約128サイクル)を実行した前後で CPU 状態(全レジスタ/hi/lo/
 *   PC/nextPc/SR/CAUSE)が完全に一致し、その間に書き込み・時間依存 I/O の読み出し・副作用のある
 *   BIOS 呼び出しが無ければ、その状態は「割込みが来るまで変わらない不動点」。以後は同じサイクル数
 *   ずつ時間だけ進め、割込み要求が立った時点で実行に戻る。実行した場合と完全に同じ結果になる
 *   (tools/headless で idleSkip on/off の出力一致を確認する)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SYNC_INTERVAL = 128;      // 何サイクルごとに周辺を進めるか
  const DEFAULT_SP = 0x801FFFF0 | 0;

  class PsfPlayer {
    constructor(info) {
      this.info = info;
      this.spu = new Emu.SpuPsx();
      this.bus = new Emu.PsxBus(this.spu);
      this.cpu = new Emu.CPUR3000(this.bus);
      this.bios = new Emu.PsxBios(this.bus, this.cpu);
      this.bus.setRefresh(info.refresh || 60);
      this.frameRate = this.bus.frameRate;
      this.sampleRate = Emu.SPU_PSX_RATE;
      this.speedFactor = 1;
      this.idleSkip = true;
      this.stats = { steps: 0, idleCycles: 0 };
      this.reset();
    }

    get mute() { return this.spu.mute; }

    reset() {
      const bus = this.bus, cpu = this.cpu, info = this.info;
      bus.reset();
      bus.setRefresh(info.refresh || 60);
      this.bios.reset();
      this.bios.install();
      for (const seg of info.segments) bus.loadSegment(seg.addr, seg.data);
      cpu.reset();
      cpu.sr = 0x40000401 | 0;   // CU2, IM2, IEc(割込みは I_MASK で止まっている)
      const sp = info.sp ? info.sp : DEFAULT_SP;
      cpu.setEntry(info.pc, sp, info.gp);
      cpu.r[30] = sp;
      cpu.r[31] = Emu.PsxBios.TRAP.IDLE; // main から戻ってきたら何もしないループ
      this.cycleTarget = 0;
      this.stats.steps = 0; this.stats.idleCycles = 0;
      this.samplesOut = 0;
      this.regSnap = new Int32Array(38);
    }

    get halted() { return this.cpu.halted; }
    get haltReason() { return this.bios.haltReason; }

    /**
     * SPU サンプルが n 個溜まるまで CPU/周辺を回す
     */
    runUntilSamples(n) {
      const bus = this.bus, cpu = this.cpu, bios = this.bios;
      const snap = this.regSnap;
      const realCycles = () => (this.speedFactor === 1 ? cpu.cycles : Math.round(cpu.cycles / this.speedFactor));
      while (bus.audioAvailable < n) {
        if (cpu.halted) {
          // 止まっても音(リリース等)は出し続ける: 時間だけ進める
          cpu.cycles += 768;
          bus.sync(realCycles());
          continue;
        }
        const idle = this.idleSkip;
        let wSeq = 0, ioSeq = 0, bSeq = 0;
        if (idle) { this.saveState(snap); wSeq = bus.writeSeq; ioSeq = bus.ioSeq; bSeq = bios.sideEffectSeq; }
        const start = cpu.cycles;
        const sliceEnd = start + SYNC_INTERVAL;
        while (cpu.cycles < sliceEnd && !cpu.halted) cpu.step();
        this.stats.steps++;
        bus.sync(realCycles());
        if (idle && !bus.irqLine && !cpu.halted && bus.writeSeq === wSeq && bus.ioSeq === ioSeq &&
            bios.sideEffectSeq === bSeq && this.sameState(snap)) {
          // 不動点: 同じスライスを実行し続けるのと同じだけ時間を進める
          const used = cpu.cycles - start;
          while (!bus.irqLine && bus.audioAvailable < n) {
            cpu.cycles += used;
            this.stats.idleCycles += used;
            bus.sync(realCycles());
          }
        }
      }
    }

    saveState(a) {
      const cpu = this.cpu;
      a.set(cpu.r);
      a[32] = cpu.hi; a[33] = cpu.lo; a[34] = cpu.pc; a[35] = cpu.nextPc;
      a[36] = cpu.sr; a[37] = cpu.cause | (cpu.branchDelay ? 0x40000000 : 0);
    }

    sameState(a) {
      const cpu = this.cpu, r = cpu.r;
      if (a[34] !== cpu.pc || a[35] !== cpu.nextPc || a[36] !== cpu.sr || a[32] !== cpu.hi || a[33] !== cpu.lo) return false;
      if (a[37] !== (cpu.cause | (cpu.branchDelay ? 0x40000000 : 0))) return false;
      for (let i = 1; i < 32; i++) if (a[i] !== r[i]) return false;
      return true;
    }

    /**
     * 44.1kHz で n サンプル生成する
     * @returns {{left:Float32Array, right:Float32Array}}
     */
    render(n) {
      const left = new Float32Array(n), right = new Float32Array(n);
      this.renderInto(left, right, 0, n);
      return { left, right };
    }

    renderInto(left, right, offset, n) {
      const bus = this.bus;
      const tmp = [0, 0];
      let done = 0;
      while (done < n) {
        const want = Math.min(4096, n - done);
        this.runUntilSamples(want);
        for (let i = 0; i < want; i++) {
          bus.popSample(tmp);
          left[offset + done + i] = tmp[0] / 32768;
          right[offset + done + i] = tmp[1] / 32768;
        }
        done += want;
      }
      this.samplesOut += n;
    }
  }

  // ── キャプチャ ──────────────────────────────────────────
  // フレームは SPU の 44.1kHz を 735 サンプルずつ区切った 60Hz(ビデオの 59.83Hz とは独立。
  // ロール/変換/再生の時間軸をサンプル単位の整数にそろえるため)。
  const SAMPLES_PER_FRAME = 735;
  const FRAME_RATE = 44100 / SAMPLES_PER_FRAME;   // = 60
  // スナップショット(フレーム末尾時点)の配置: ボイスごとに VOICE_FIELDS 個 + 全体
  const SNAP = {
    VOICE_FIELDS: 11,
    PHASE: 0,   // 0=off 1=attack 2=decay 3=sustain 4=release
    PITCH: 1,   // VxPitch レジスタ(0x1000 = 原音 44.1kHz)
    LEVEL: 2,   // ADSR レベル 0..0x7FFF
    VOLL: 3, VOLR: 4,   // 現在音量(スイープ適用後、-0x8000..0x7FFF)
    START: 5,   // 開始アドレス(バイト)
    SERIAL: 6,  // キーオン通し番号
    FLAGS: 7,   // bit0 noise, bit1 pmon, bit2 reverb
    CUR: 8,     // 現在の ADPCM ブロックアドレス(バイト)
    SAMPLE: 9,  // キーオン時に鳴らし始めたサンプルの番号(cap.samples の添字、未発音は -1)
    TRACK: 10,  // キーオンを出したドライバ内部のトラック番号(cap.trackProbe.tracks の添字、不明は -1)
    MAIN_L: 24 * 11, MAIN_R: 24 * 11 + 1,
    LENGTH: 24 * 11 + 2,
  };

  // FNV-1a 32bit(バイト列)。サンプル内容の同定用(音色キー 'pcm:<hash>' / ドラムパッド)
  function fnvBytes(bytes, from, to) {
    let h = 0x811c9dc5;
    for (let i = from; i < to; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * SPU RAM 上のサンプルを、実際に鳴るループ構造どおりに復号して同定する(SpuPsx.describeSample)。
   * repeatReg/ignoreFlag はキーオンしたフレーム末尾のボイス状態(ドライバがレジスタで指定したループ先)。
   * @returns {{addr, pcm:Int16Array, loopStart:number|null, looped:boolean, endMute:boolean, blocks, loopAddr,
   *            bytes:Uint8Array(頭+ループ部の生 ADPCM。音色ハッシュ用), hash, rate:44100}}
   */
  function describeSample(ram, addr, repeatReg, ignoreFlag) {
    const d = Emu.SpuPsx.describeSample(ram, addr, repeatReg, ignoreFlag);
    let total = 0;
    for (const [a, b] of d.byteRanges) total += Math.max(0, Math.min(ram.length, b) - a);
    const bytes = new Uint8Array(total + 4);
    let o = 0;
    for (const [a, b] of d.byteRanges) { const e = Math.min(ram.length, b); bytes.set(ram.subarray(a, e), o); o += e - a; }
    // ループ位置も同定に含める(同じ波形でもループ先が違えば別の音)
    const ls = d.loopStart == null ? 0xFFFFFFFF : d.loopStart;
    bytes[o] = ls & 0xFF; bytes[o + 1] = (ls >>> 8) & 0xFF; bytes[o + 2] = (ls >>> 16) & 0xFF; bytes[o + 3] = (ls >>> 24) & 0xFF;
    return {
      addr: addr & 0x7FFF0, pcm: d.pcm, loopStart: d.loopStart, looped: d.looped,
      endMute: d.endMute, blocks: d.blocks, loopAddr: d.loopAddr, rate: 44100,
      bytes, hash: fnvBytes(bytes, 0, bytes.length),
    };
  }

  function takeSnapshot(spu, sampleOfVoice, trackOfVoice) {
    const a = new Int32Array(SNAP.LENGTH);
    const F = SNAP.VOICE_FIELDS;
    for (let i = 0; i < 24; i++) {
      const v = spu.voices[i], o = i * F;
      a[o] = v.phase; a[o + 1] = spu.regs[i * 8 + 2]; a[o + 2] = v.level;
      a[o + 3] = v.volL; a[o + 4] = v.volR; a[o + 5] = (spu.regs[i * 8 + 3] << 3) & 0x7FFFF;
      a[o + 6] = v.keyOnSerial;
      a[o + 7] = ((spu.non >> i) & 1) | (((spu.pmon >> i) & 1) << 1) | (((spu.eon >> i) & 1) << 2);
      a[o + 8] = v.curAddr;
      a[o + 9] = sampleOfVoice[i];
      a[o + 10] = trackOfVoice[i];
    }
    a[SNAP.MAIN_L] = spu.mainVolL; a[SNAP.MAIN_R] = spu.mainVolR;
    return a;
  }

  // ── ドライバ内部トラックの推定 ─────────────────────────────────────────
  // PS1 のドライバの多くは、キーオンのたびに空いているボイスを次々と使い回す(余韻を残したまま次の音を
  // 別ボイスで鳴らす)。ボイス番号では旋律がばらばらになるので、ドライバ自身の「トラック(シーケンスの
  // パート)構造体」を CPU の実行中の状態から推定し、キーオンにトラック番号を付ける。
  // 逆アセンブルはしない。短く試し走らせして次の2か所の CPU 状態を集め、候補を採点する:
  //  1) SPU のボイスレジスタ(ピッチ/開始アドレス)を書く瞬間
  //  2) 1) の書き込み元が「ボイスごとの影テーブル(base + voice*stride)」の一括書き出しだった場合は、
  //     その影テーブルへ書き込む瞬間(もう一度試し走らせして RAM 書き込みを監視する)
  // 候補 = 書き込み命令の pc × (汎用レジスタ r1..r31 | スタック sp+0..0xFC)。キーオン直前(4フレーム以内)の
  // 値でキーオンを分類し、次を満たす最良のものをトラックとみなす:
  //  - 値がすべて RAM 上のポインタで、2〜64 種類
  //  - 1種類がボイス1本に張り付いていない(=ボイス構造体ではない)
  //  - 同じ値のキーオンが同じサンプルを鳴らす割合(純度)が高く、同じフレームに重ならない
  //  - 値が等間隔に並ぶ(構造体の配列。音色データへのポインタ等は不規則なので落ちる)
  // 実測(2026-09-14、tools/headless/pool-regroup-score.js / 24曲の自動探索): ナムコ系・北斗の拳・
  // Philosoma・桃太郎伝説・信長の野望 烈風伝・オウガバトル・FF8・クロノ・サガフロ2 で見つかる。
  // Crash Bandicoot・ペルソナ2・かまいたちの夜は見つからない(合成chの推定に戻る)。
  const PROBE_STACK_WORDS = 64;
  const physAddr = (x) => (x >>> 0) & 0x1FFFFFFF;
  const isRamPtr = (x) => { const p = physAddr(x); return p >= 0x10000 && p < 0x200000; };

  async function probeRun(info, secs, tables, yieldFn, budgetMs, minKeyons) {
    const player = new PsfPlayer(info);
    const { spu, bus, cpu } = player;
    const events = [], keyons = [];
    const grab = (kind, v) => {
      const r = new Uint32Array(32);
      for (let i = 0; i < 32; i++) r[i] = cpu.r[i] >>> 0;
      const st = new Uint32Array(PROBE_STACK_WORDS);
      const sp = cpu.r[29];
      if (isRamPtr(sp)) for (let k = 0; k < PROBE_STACK_WORDS; k++) st[k] = bus.read32((sp + k * 4) | 0) >>> 0;
      events.push({ kind, v, f: Math.floor(spu.sampleCount / SAMPLES_PER_FRAME), pc: physAddr(cpu.pc), r, st });
    };
    spu.onWrite = (index) => { if (index < 0xC0 && ((index & 7) === 2 || (index & 7) === 3)) grab('spu', index >> 3); };
    spu.onKeyOn = (v, addr) => keyons.push({ v, f: Math.floor(spu.sampleCount / SAMPLES_PER_FRAME), addr, ev: events.length });
    if (tables && tables.length) {
      for (const m of ['write8', 'write16', 'write32']) {
        const orig = bus[m];
        bus[m] = function (a, val) {
          const p = physAddr(a);
          if (p < 0x200000) {
            for (const t of tables) if (p >= t.base && p < t.base + 24 * t.stride) { grab('ram', ((p - t.base) / t.stride) | 0); break; }
          }
          return orig.call(bus, a, val);
        };
      }
    }
    const total = Math.round(secs * FRAME_RATE) * SAMPLES_PER_FRAME;
    const now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();
    const tmp = [0, 0];
    let done = 0;
    // ★止める判定は4フレームごとに見る(時間の区切りごとに見ると、どこで止まるかが実行ごとに変わり、
    //   見つかるトラックの並び=トラック番号が鍵盤表示と変換で食い違った)
    const enough = () => done >= total || player.halted || (minKeyons && keyons.length >= minKeyons && done >= 8 * 44100);
    while (!enough()) {
      const t0 = now();
      while (!enough() && now() - t0 < budgetMs) {
        player.runUntilSamples(SAMPLES_PER_FRAME * 4);
        for (let i = 0; i < SAMPLES_PER_FRAME * 4; i++) bus.popSample(tmp);
        done += SAMPLES_PER_FRAME * 4;
      }
      if (yieldFn) await yieldFn();
    }
    return { events, keyons, done };
  }

  // 同じ pc のボイスレジスタ書き込みで、あるレジスタが base + voice*stride になっている = 影テーブル
  function findShadowTables(events) {
    const byPc = new Map();
    for (const e of events) if (e.kind === 'spu') { if (!byPc.has(e.pc)) byPc.set(e.pc, []); byPc.get(e.pc).push(e); }
    const found = [];
    for (const evs of byPc.values()) {
      if (evs.length < 24 || new Set(evs.map(e => e.v)).size < 4) continue;
      // 基準の2点は後半から取る(曲の初期化で別のテーブルを一巡することがある。ナムコ系で実測)
      const late = evs.slice(evs.length >> 1);
      for (let k = 1; k < 32; k++) {
        const a = late.find(e => isRamPtr(e.r[k]));
        const b = a && late.find(e => e.v !== a.v && isRamPtr(e.r[k]));
        if (!b) continue;
        const stride = (physAddr(b.r[k]) - physAddr(a.r[k])) / (b.v - a.v);
        if (!Number.isInteger(stride) || stride < 4 || stride > 0x400) continue;
        const base = physAddr(a.r[k]) - a.v * stride;
        let ok = 0;
        for (const e of evs) if (physAddr(e.r[k]) === base + e.v * stride) ok++;
        if (ok >= evs.length * 0.8) found.push({ base, stride });
      }
    }
    // 同じテーブルの別表現(先頭+2 を指すレジスタ等)は1つにまとめる
    const out = [];
    for (const t of found.sort((x, y) => x.base - y.base)) {
      if (!out.some(u => u.stride === t.stride && Math.abs(u.base - t.base) < t.stride)) out.push({ base: t.base & ~1, stride: t.stride });
    }
    return out.slice(0, 4);
  }

  const gcd = (a, b) => { while (b) { const t = a % b; a = b; b = t; } return a; };

  function scoreTrackCandidates(events, keyons, kind) {
    // キーオンごとに、同じボイスへの直前(4フレーム以内)の各 pc の最後の書き込みを結び付ける
    const lastByVoice = Array.from({ length: 24 }, () => new Map());
    const links = new Map(); // pc → [{e, kon}]
    let ei = 0;
    for (const kon of keyons) {
      while (ei < kon.ev) { const e = events[ei++]; if (e.kind === kind) lastByVoice[e.v].set(e.pc, e); }
      for (const [pc, e] of lastByVoice[kon.v]) {
        if (kon.f - e.f > 4) continue;
        if (!links.has(pc)) links.set(pc, []);
        links.get(pc).push({ e, kon });
      }
      lastByVoice[kon.v].clear();
    }
    const cands = [];
    for (const [pc, ls] of links) {
      if (ls.length < keyons.length * 0.6) continue;
      const voicesUsed = new Set(ls.map(l => l.kon.v)).size;
      for (let s = 1; s < 32 + PROBE_STACK_WORDS; s++) {
        const reg = s < 32 ? s : 0, stackOff = s < 32 ? -1 : (s - 32) * 4;
        const groups = new Map();
        let bad = 0;
        for (const l of ls) {
          const val = reg ? l.e.r[reg] : l.e.st[stackOff >> 2];
          if (!isRamPtr(val)) { if (++bad > ls.length * 0.01) break; continue; }
          const g = physAddr(val);
          if (!groups.has(g)) { if (groups.size >= 64) { bad = Infinity; break; } groups.set(g, []); }
          groups.get(g).push(l.kon);
        }
        if (bad > ls.length * 0.01 || groups.size < 2) continue;
        let pure = 0, overlap = 0, voiceSum = 0;
        for (const g of groups.values()) {
          const bySmp = new Map(), byFrame = new Map(), vs = new Set();
          for (const k of g) {
            bySmp.set(k.addr, (bySmp.get(k.addr) || 0) + 1);
            byFrame.set(k.f, (byFrame.get(k.f) || 0) + 1);
            vs.add(k.v);
          }
          let mx = 0; for (const n of bySmp.values()) if (n > mx) mx = n;
          pure += mx;
          for (const n of byFrame.values()) if (n > 1) overlap += n - 1;
          voiceSum += vs.size;
        }
        const n = ls.length - bad;
        const purity = pure / n, overlapRate = overlap / n, voicesPerGroup = voiceSum / groups.size;
        const voiceBound = voicesPerGroup <= 1.05 && groups.size >= voicesUsed * 0.8;
        const addrs = [...groups.keys()].sort((x, y) => x - y);
        let g = 0; for (let i = 1; i < addrs.length; i++) g = gcd(g, addrs[i] - addrs[i - 1]);
        const regular = g >= 4 && (addrs[addrs.length - 1] - addrs[0]) / g <= 1024;
        cands.push({ kind, pc, reg, stackOff, groups: groups.size, purity, overlapRate, voicesPerGroup,
          coverage: n / keyons.length, voiceBound, regular, stride: g, addrs,
          score: purity - overlapRate * 0.5 + Math.min(1, n / keyons.length) * 0.1 });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    return cands;
  }

  Emu._psfTrackProbeInternals = { probeRun, findShadowTables, scoreTrackCandidates }; // ヘッドレス診断用
  const acceptTrackCandidate = (c) => c && !c.voiceBound && c.regular && c.purity >= 0.7 && c.overlapRate <= 0.5 && c.coverage >= 0.6;

  /**
   * ドライバ内部トラックのフック位置を推定する(キャプチャ前の試し走らせ。副作用なし)。
   * @returns {Promise<{found:boolean, reason?:string, kind?:'spu'|'ram', pc?, reg?, stackOff?, table?:{base,stride},
   *                    tracks?:number[], groups?, purity?, overlapRate?, coverage?, keyons?}>}
   *   tracks はトラック構造体の物理アドレス(昇順)。スナップショットの TRACK はこの添字(後から見つかったものは末尾に足す)
   */
  Emu.probePsfTracksAsync = async function (info, opt) {
    opt = opt || {};
    const secs = opt.seconds || 20;
    const yieldFn = opt.yieldFn || null, budget = opt.sliceBudgetMs || 8;
    const a = await probeRun(info, secs, null, yieldFn, budget, 400);
    if (a.keyons.length < 16) return { found: false, reason: 'keyons', keyons: a.keyons.length };
    const cands = scoreTrackCandidates(a.events, a.keyons, 'spu');
    const tables = findShadowTables(a.events);
    if (tables.length) {
      const b = await probeRun(info, a.done / 44100, tables, yieldFn, budget, 0);
      const viaTable = scoreTrackCandidates(b.events, b.keyons, 'ram');
      // 本キャプチャのフックが同じ RAM 範囲だけを見るように、監視したテーブルを持たせる
      for (const c of viaTable) { c.tables = tables; cands.push(c); }
      cands.sort((x, y) => y.score - x.score);
    }
    const best = cands.find(acceptTrackCandidate);
    if (!best) {
      const top = cands[0];
      // 診断用: 上位候補の要約(tools/headless/pool-regroup-score.js が表示する)
      const summary = cands.slice(0, 3).map(c => `${c.kind}@${c.pc.toString(16)} ${c.reg ? 'r' + c.reg : 'sp+' + c.stackOff.toString(16)} g${c.groups} p${c.purity.toFixed(2)} o${c.overlapRate.toFixed(2)} cov${c.coverage.toFixed(2)}${c.voiceBound ? ' voice' : ''}${c.regular ? '' : ' irregular'}`);
      return { found: false, reason: top ? (top.voiceBound ? 'voiceBound' : 'weak') : 'none', keyons: a.keyons.length, tables: tables, top: summary };
    }
    return {
      found: true, kind: best.kind, pc: best.pc, reg: best.reg, stackOff: best.stackOff,
      tables: best.kind === 'ram' ? best.tables : null,
      tracks: best.addrs, stride: best.stride, groups: best.groups,
      purity: best.purity, overlapRate: best.overlapRate, coverage: best.coverage, keyons: a.keyons.length,
    };
  };

  /**
   * PSF をキャプチャする(再生用の書き込みログ + ロール/変換用のフレームスナップショット)。
   * @param {object} info  MML.PSF.load() の結果(Worker へは structured clone で渡せる)
   * @param {object} opt   {durationSeconds, regsOnly(音声を作らない), speedFactor, mute,
   *                        sliceBudgetMs, yieldFn, shouldCancel}
   * @param {function} onProgress (doneFrames, totalFrames, cap)
   * @returns {Promise<object>} cap
   *   frameLog[f]: Int32Array [offInFrame, (index<<16)|value, ...]  SPU レジスタ書き込み
   *   ramLog: [{f, off, addr, data:Int16Array}]  SPU RAM 転送(連続したハーフワードはまとめる)
   *   snapshots[f]: Int32Array(SNAP.LENGTH)  フレーム末尾の状態
   *   audioL/audioR: Float32Array(44.1kHz)  regsOnly でなければ
   */
  Emu.capturePsfSongAsync = async function (info, opt, onProgress) {
    opt = opt || {};
    const player = new PsfPlayer(info);
    if (opt.speedFactor) player.speedFactor = opt.speedFactor;
    const spu = player.spu, bus = player.bus;
    if (opt.mute) Emu.applyMute(spu.mute, opt.mute);
    const totalFrames = Math.max(1, Math.round((opt.durationSeconds || 180) * FRAME_RATE));
    const totalSamples = totalFrames * SAMPLES_PER_FRAME;
    const wantAudio = !opt.regsOnly;
    const cap = {
      frameRate: FRAME_RATE, samplesPerFrame: SAMPLES_PER_FRAME, totalFrames,
      frameLog: [], ramLog: [], snapshots: [],
      samples: [],             // [{addr, pcm, loopStart, looped, endMute, blocks, hash, rate}]
      audioL: wantAudio ? new Float32Array(totalSamples) : null,
      audioR: wantAudio ? new Float32Array(totalSamples) : null,
      player,
    };
    // サンプルの同定: 同じアドレスでも RAM が書き換わったら内容ハッシュで見直す
    // ★サンプル番号はキーオンしたフレームの末尾で決める。ループ先をレジスタで指定するドライバ(FF7 の AKAO 等)は
    //   キーオンの前後に repeat レジスタを書くので、キーオンの瞬間ではまだ分からない
    const sampleOfVoice = new Int32Array(24).fill(-1);
    const pendingStart = new Int32Array(24).fill(-1);
    const byKey = new Map();     // 'start:repeat:ignore' → {gen, id}
    const byHash = new Map();    // hash → id
    let ramGen = 0;
    const sampleIdFor = (addr, repeatReg, ignore) => {
      const key = addr + ':' + repeatReg + ':' + (ignore ? 1 : 0);
      const c = byKey.get(key);
      if (c && c.gen === ramGen) return c.id;
      const desc = describeSample(spu.ram, addr, repeatReg, ignore);
      let id = byHash.get(desc.hash);
      if (id === undefined) { id = cap.samples.length; cap.samples.push(desc); byHash.set(desc.hash, id); }
      byKey.set(key, { gen: ramGen, id });
      return id;
    };
    const resolvePending = () => {
      for (let v = 0; v < 24; v++) {
        if (pendingStart[v] < 0) continue;
        const voice = spu.voices[v];
        sampleOfVoice[v] = sampleIdFor(pendingStart[v], voice.repeatAddr, voice.ignoreLoopAddr);
        pendingStart[v] = -1;
      }
    };
    let cur = [];            // 今のフレームの書き込み
    let curFrame = 0;
    // ドライバ内部トラック(Emu.probePsfTracksAsync)。regsOnly(ロール/変換用)だけ。opt.trackProbe===false で無効
    const trackOfVoice = new Int32Array(24).fill(-1);
    let noteTrackOwner = null;   // (voice) → そのボイスへ書いたトラックを控える
    let trackAtKeyOn = null;     // (voice) → キーオン時点のトラック番号
    if (opt.regsOnly && opt.trackProbe !== false) {
      const probe = await Emu.probePsfTracksAsync(info, { yieldFn: opt.yieldFn, sliceBudgetMs: opt.sliceBudgetMs });
      cap.trackProbe = probe;
      if (probe.found) {
        const cpu = player.cpu;
        const owner = new Int32Array(24).fill(-1), ownerFrame = new Int32Array(24).fill(-1000);
        const trackIndex = new Map(probe.tracks.map((a, i) => [a, i]));
        noteTrackOwner = (v) => {
          const val = probe.reg ? cpu.r[probe.reg] : bus.read32((cpu.r[29] + probe.stackOff) | 0);
          if (!isRamPtr(val)) return;
          owner[v] = physAddr(val); ownerFrame[v] = curFrame;
        };
        trackAtKeyOn = (v) => {
          if (curFrame - ownerFrame[v] > 4) return -1;
          let id = trackIndex.get(owner[v]);
          if (id === undefined) { id = probe.tracks.length; probe.tracks.push(owner[v]); trackIndex.set(owner[v], id); }
          return id;
        };
        if (probe.kind === 'ram') {
          const tables = probe.tables;
          for (const m of ['write8', 'write16', 'write32']) {
            const orig = bus[m];
            bus[m] = function (a, val) {
              const p = physAddr(a);
              if (p < 0x200000 && physAddr(cpu.pc) === probe.pc) {
                for (const t of tables) if (p >= t.base && p < t.base + 24 * t.stride) { noteTrackOwner(((p - t.base) / t.stride) | 0); break; }
              }
              return orig.call(bus, a, val);
            };
          }
        }
      }
    }
    spu.onKeyOn = (voice, addr) => {
      pendingStart[voice] = addr;
      if (trackAtKeyOn) trackOfVoice[voice] = trackAtKeyOn(voice);
    };
    let ramChunk = null;     // {f, off, addr, vals:[]}
    const flushRam = () => {
      if (!ramChunk) return;
      cap.ramLog.push({ f: ramChunk.f, off: ramChunk.off, addr: ramChunk.addr, data: Int16Array.from(ramChunk.vals) });
      ramChunk = null;
    };
    const spuHookPc = (noteTrackOwner && cap.trackProbe.kind === 'spu') ? cap.trackProbe.pc : -1;
    spu.onWrite = (index, value) => {
      cur.push(spu.sampleCount - curFrame * SAMPLES_PER_FRAME, (index << 16) | value);
      if (spuHookPc >= 0 && index < 0xC0 && ((index & 7) === 2 || (index & 7) === 3) && physAddr(player.cpu.pc) === spuHookPc) noteTrackOwner(index >> 3);
    };
    spu.onRamWrite = (addr, value) => {
      ramGen++;
      const sc = spu.sampleCount;
      const f = Math.floor(sc / SAMPLES_PER_FRAME);
      const off = sc - f * SAMPLES_PER_FRAME;
      if (ramChunk && ramChunk.f === f && ramChunk.off === off &&
          addr === ramChunk.addr + ramChunk.vals.length * 2 && ramChunk.vals.length < 65536) {
        ramChunk.vals.push(value);
      } else {
        flushRam();
        ramChunk = { f, off, addr, vals: [value] };
      }
    };
    bus.onSample = (s) => {
      // clock() 直後。sampleCount は生成済みサンプル数
      if (s.sampleCount % SAMPLES_PER_FRAME === 0) {
        flushRam();
        resolvePending();
        cap.frameLog.push(Int32Array.from(cur));
        cap.snapshots.push(takeSnapshot(s, sampleOfVoice, trackOfVoice));
        cur = [];
        curFrame++;
      }
    };
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    const budget = opt.sliceBudgetMs || (opt.regsOnly ? 8 : 15);
    const now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();
    const tmp = [0, 0];
    let popped = 0;
    const CHUNK = SAMPLES_PER_FRAME * 4;
    while (curFrame < totalFrames) {
      if (opt.shouldCancel && opt.shouldCancel()) { cap.cancelled = true; break; }
      const t0 = now();
      while (curFrame < totalFrames && now() - t0 < budget) {
        const want = Math.min(CHUNK, totalSamples - popped);
        if (want <= 0) break;
        player.runUntilSamples(want);
        for (let i = 0; i < want; i++) {
          bus.popSample(tmp);
          if (wantAudio) { cap.audioL[popped + i] = tmp[0] / 32768; cap.audioR[popped + i] = tmp[1] / 32768; }
        }
        popped += want;
      }
      if (onProgress && curFrame < totalFrames) onProgress(curFrame, totalFrames, cap);
      if (curFrame < totalFrames) await yieldFn();
    }
    // runUntilSamples は要求より少し先まで進むことがあるので、曲長の外のフレームは捨てる
    if (cap.frameLog.length > totalFrames) { cap.frameLog.length = totalFrames; cap.snapshots.length = totalFrames; }
    cap.ramLog = cap.ramLog.filter(r => r.f < totalFrames);
    spu.onWrite = null; spu.onRamWrite = null; spu.onKeyOn = null; bus.onSample = null;
    cap.bios = { halted: player.halted, haltReason: player.haltReason, unknownCalls: [...player.bios.unknownCalls.entries()] };
    if (onProgress) onProgress(cap.frameLog.length, totalFrames, cap);
    return cap;
  };

  /**
   * キャプチャした書き込みログを SPU だけで再生する(CPU は動かさない)。
   * ストリームプレイヤー/WAV 書き出し/ヘッドレス検証で共有する。
   * cap は {frameLog, ramLog} を持っていればよい(Worker から差分で育つ途中の配列でもよい)。
   *
   * 時間の持ち方: pos = 曲のサンプル位置(実数)。step() は「pos 以下に記録された書き込みを
   * 反映 → SPU を1サンプル進める → pos += speed」。speed=1 なら元のエミュレーションと
   * サンプル単位で一致する(tools/headless/psf-replay-check.js)。speed≠1 はログの進みだけを
   * 変え、SPU のクロック(=音程)は変えない(他形式の Replay プレイヤーと同じテンポ変更)。
   */
  class PsfReplay {
    constructor(cap) {
      this.cap = cap;
      this.spu = new Emu.SpuPsx();
      this.spu.replayMode = true;
      this.speed = 1;
      this.reset();
    }
    reset() {
      this.spu.reset();
      this.pos = 0;            // 曲のサンプル位置(実数)
      this.wFrame = 0;         // 書き込みを反映済みのフレーム
      this.wIdx = 0;           // frameLog[wFrame] の次の書き込み(ペア単位で +2)
      this.rIdx = 0;           // ramLog の次
    }
    get frame() { return Math.floor(this.pos / SAMPLES_PER_FRAME); }
    /** 次の1サンプルを生成できるか(キャプチャが追いついているか) */
    ready() { return Math.floor(this.pos / SAMPLES_PER_FRAME) < this.cap.frameLog.length; }
    /** 曲長(キャプチャ予定の全フレーム)に達したか */
    ended(totalFrames) { return Math.floor(this.pos / SAMPLES_PER_FRAME) >= totalFrames; }
    /** 曲のサンプル位置 target(整数)までの RAM 転送とレジスタ書き込みを反映する */
    applyUpTo(target) {
      const cap = this.cap, spu = this.spu;
      const ramLog = cap.ramLog;
      const tf = Math.floor(target / SAMPLES_PER_FRAME);
      while (this.rIdx < ramLog.length) {
        const r = ramLog[this.rIdx];
        if (r.f * SAMPLES_PER_FRAME + r.off > target) break;
        const d = r.data;
        for (let i = 0; i < d.length; i++) spu.ramWrite16Direct(r.addr + i * 2, d[i]);
        this.rIdx++;
      }
      while (this.wFrame <= tf && this.wFrame < cap.frameLog.length) {
        const w = cap.frameLog[this.wFrame];
        const limit = (this.wFrame < tf) ? Infinity : target - tf * SAMPLES_PER_FRAME;
        while (this.wIdx < w.length && w[this.wIdx] <= limit) {
          const packed = w[this.wIdx + 1];
          spu.writeReg(packed >>> 16, packed & 0xFFFF);
          this.wIdx += 2;
        }
        if (this.wFrame < tf) { this.wFrame++; this.wIdx = 0; } else break;
      }
    }
    /** 1サンプル生成(ready() が true のときだけ呼ぶ) */
    step() {
      this.applyUpTo(Math.floor(this.pos));
      this.spu.clock();
      this.pos += this.speed;
    }
    /**
     * frame の先頭へ移動する。0..frame-1 の RAM 転送と書き込みを SPU を回さずに流し直す。
     * ADPCM の再生位置や ADSR の途中経過は復元しない(SPC の再生と同じ割り切り)。
     * 鳴りっぱなしの音を作らないよう KON は流さない。
     */
    seekFrame(frame) {
      const cap = this.cap, spu = this.spu;
      frame = Math.max(0, Math.min(frame, cap.frameLog.length));
      this.reset();
      const ramLog = cap.ramLog;
      for (let f = 0; f < frame; f++) {
        while (this.rIdx < ramLog.length && ramLog[this.rIdx].f <= f) {
          const r = ramLog[this.rIdx++];
          for (let i = 0; i < r.data.length; i++) spu.ramWrite16Direct(r.addr + i * 2, r.data[i]);
        }
        const w = cap.frameLog[f];
        for (let i = 0; i < w.length; i += 2) {
          const idx = w[i + 1] >>> 16;
          if (idx === 0xC4 || idx === 0xC5) continue;
          spu.writeReg(idx, w[i + 1] & 0xFFFF);
        }
      }
      this.pos = frame * SAMPLES_PER_FRAME;
      this.wFrame = frame; this.wIdx = 0;
    }
  }

  PsfPlayer.SAMPLES_PER_FRAME = SAMPLES_PER_FRAME;
  PsfPlayer.FRAME_RATE = FRAME_RATE;
  PsfPlayer.SNAP = SNAP;
  Emu.PsfReplay = PsfReplay;
  Emu.PSF_SNAP = SNAP;
  Emu.describePsfSample = describeSample;
  Emu.PsfPlayer = PsfPlayer;
})(globalThis);

/*
 * YM2610 (OPNB) 音源エミュレータ — FM + ADPCM-A + ADPCM-B (Neo Geo / VGM)
 * MML.Emu.YM2610Audio
 *
 * YM2610は SSG(AY-3-8910互換,3ch) + FM(4ch) + ADPCM-A(6ch) + ADPCM-B(1ch) を1チップに
 * 内蔵する。このファイルは FM と ADPCM-A/B を扱う(SSGはEmu.AY8910Audioをそのまま再利用)。
 * VGM上は 0x58(ポート0)/0x59(ポート1) のレジスタ書込みでまとめて叩かれるので、SSG/FMの
 * 振り分けは呼び出し側(vgmPlayer.js)が行う(SSGはここに来ても弾くだけ)。
 *
 * ★FM部は YM2612コア(ym2612Nuked.js=Nuked-OPN2移植)の薄いラッパー。
 * 理由: YM2610のFMレジスタ配置はYM2612と完全に同一(0x30 DT/MUL … 0xB4 L/R/AMS/PMS、0x22 LFO、
 * 0x27 ch3モード、0x28 キーオン、サンプルレート=clock/144、周波数式も同じ)で、違いは
 *   (1) 6chぶんのアドレス空間のうち実チャンネルが各ポートのオフセット1,2だけ
 *       (オフセット0,3は結線されていないダミー。ymfm(aaronsgiles/ymfm, BSD-3)の
 *       ym2610 channel_mask=0x36=YM2612番号でch1,2,4,5 と一致。YM2610Bは6ch全部が実チャンネル)、
 *   (2) ch6 DAC(0x2A/0x2B、YM2612固有)が無い、
 *   (3) SSG/ADPCM-A/ADPCM-Bのレジスタ領域(port0 0x00-0x1F, port1 0x00-0x2F)が挟まる、
 * の3点だけなので、YM2612コアを6chのまま動かしてダミーch/DACを常時ミュートし、
 * 該当領域の書込みを弾くだけで済む。ch3特殊モード(0x27上位ビット、YM2612のch3=port0
 * オフセット2=YM2610のFM2に相当。MAME fm.cppのym2610もCH[2]に適用)もそのまま効く。
 * キーオン0x28の値1,2,5,6 → YM2612コアのch1,2,4,5 = 本クラスのFM1-4。
 *
 * コアは chipType:'ym3438' で使う: FMオペレータ本体(PG/EG/log-sin・exp ROM/LFO/SSG-EG)は
 * OPNファミリ共通設計だが、YM2612固有の9bit DACラダー効果はYM2610には無い
 * (OPNA/OPNBは内部加算して16bit出力)ため、ラダー無しモードが正しい。
 *
 * ★ADPCM-A/B は ymfm(ymfm_adpcm.cpp / ymfm_opn.cpp ym2610)の関数単位の移植:
 *   ADPCM-A: 6ch、4bit ADPCM(MSM5205系、12bit累算器はラップ)、アドレスは 開始/終了レジスタ<<8、
 *            終了比較は下位20bitのみ(twinspri等の実挙動)、FMサンプル3回に1回クロック
 *            (=EGサイクル、Neo Geo 8MHz で 18518Hz)。音量=(IL^0x1f)+(TL^0x3f) を乗数15-(v&7)と
 *            シフト5+(v>>3)へ。パンL/R。
 *   ADPCM-B: 1ch、4bit ADPCM(累算器16bitクランプ、ステップ127〜24576を0.9〜2.4倍)、
 *            Δ-N(16bit位相累算、fs=ΔN×55555/65536)、線形補間、レベル(0-255)、リピート、
 *            リミット/終了アドレス(<<8)、YM2610では常に外部メモリ(ROM)モード。
 *   ROMは VGM データブロック 0x82(ADPCM-A)/0x83(ADPCM-B=DELTA-T) を loadRom() で受け取る。
 *   出力尺度: ymfmでは FMチャンネルのフルスケール=4096(13bit>>1)、ADPCM-A最大≒15360、
 *   ADPCM-B最大≒16320(レベル255、YM2610はrshift=1)。本クラスのFMコアはフルスケール0.2
 *   (実測)なのでADPCM出力は ×0.2/4096 で同じ比率に合わせる(ADPCM_SCALE)。
 *
 * ★表示専用のサンプルピッチ解析(samplePitch / decodeAdpcmA・B / detectCps): 音程レジスタの無い
 *   ADPCM-Aと、Δ-Nしか無いADPCM-Bに絶対音名を出すため、ROM上のサンプルを1回だけデコードして
 *   基本周期(cps=1入力サンプルあたりの周期数)を求めキャッシュする(詳細は同関数群のコメント)。
 *
 *   手動キャリブレーション(setSampleTuning: cps上書き、localStorage 'ym2610AdpcmTuning' にサンプル内容の
 *   ハッシュをキーで永続化)と、波形アイコン用の1周期/概形波形(makeSampleWave)もここで作る。
 *
 * 外部I/F: writeReg(port,reg,val) / clock()(マスタークロック毎) / mixSample() / loadRom(kind,...) /
 * samplePitch(kind,start,end) / setSampleTuning(kind,start,end,cps|null) /
 * mute[fmCh] / vol[fmCh] / muteAdpcm[7](A1-6,B) / volAdpcm[7](書き換えたら syncMuteVol()) /
 * core / numFm(4 or 6) / flushWrites() / Emu.snapshotYM2610(chip)。
 * Neo Geo: 8000000Hz → 55555Hz。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CYCLES_PER_SAMPLE = 144;
  const ADPCM_SCALE = 0.2 / 4096; // ymfm出力単位 → 本クラスのFM尺度(FMチャンネルのフルスケール0.2)

  // ── ADPCM-A (ymfm adpcm_a_channel/engine) ──
  const ADPCMA_STEPS = [
    16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552
  ];
  const ADPCMA_STEP_INC = [-1, -1, -1, -1, 2, 5, 7, 9];
  const ADPCMA_ADDR_SHIFT = 8;

  class AdpcmA {
    /**
     * @param {object} owner - romA / sampleRate を持つチップ本体
     * @param {{fixedAddr?: Array<{start:number,end:number}>}} [opts]
     *   fixedAddr: サンプルの開始/終了(バイト、endは実機表と同じinclusive)を固定する。
     *   YM2608の内蔵リズム(6サンプルのアドレスがROM固定でレジスタが無い)用。
     *   省略時は従来どおり開始/終了レジスタ(YM2610 ADPCM-A)。
     */
    constructor(owner, opts) {
      this.owner = owner;
      this.fixedAddr = (opts && opts.fixedAddr) || null;
      this.regs = new Uint8Array(0x30);
      this.ch = [];
      // seq: キーオン通番(clock()を回さない先読みキャプチャがキーオンを検出するため。ロール用)
      for (let i = 0; i < 6; i++) this.ch.push({ playing: false, curnibble: 0, curbyte: 0, curaddress: 0, acc: 0, stepIndex: 0, seq: 0 });
      this.reset();
    }
    // ch i の開始バイトアドレス(fixedAddr優先)
    _startAddr(i) {
      if (this.fixedAddr) return this.fixedAddr[i].start;
      return (this.regs[0x10 + i] | (this.regs[0x18 + i] << 8)) << ADPCMA_ADDR_SHIFT;
    }
    // ch i の終了バイトアドレス(exclusive、fixedAddr優先)
    _endAddr(i) {
      if (this.fixedAddr) return this.fixedAddr[i].end + 1;
      return ((this.regs[0x20 + i] | (this.regs[0x28 + i] << 8)) + 1) << ADPCMA_ADDR_SHIFT;
    }
    // ch i の現在の開始/終了レジスタから求めたサンプル長(秒)。ADPCM-Aは18518Hz(=FMサンプルレート/3)固定
    lengthSeconds(i) {
      const bytes = Math.max(0, this._endAddr(i) - this._startAddr(i));
      return bytes * 2 / (this.owner.sampleRate / 3);
    }
    reset() {
      this.regs.fill(0);
      // パンは両方ON・音色レベル最大が既定(Neo Geoホームブリュー(ffeast等)が依存する。ymfmと同じ)
      for (let i = 0x08; i <= 0x0D; i++) this.regs[i] = 0xDF;
      for (const c of this.ch) { c.playing = false; c.curnibble = 0; c.curbyte = 0; c.curaddress = 0; c.acc = 0; c.stepIndex = 0; }
    }
    write(reg, data) {
      this.regs[reg] = data;
      if (reg === 0x00) {
        const on = !(data & 0x80); // bit7=1 dump(停止)、0=キーオン
        for (let i = 0; i < 6; i++) if (data & (1 << i)) this._keyonoff(i, on);
      }
    }
    _keyonoff(i, on) {
      const c = this.ch[i];
      c.playing = on;
      if (on) {
        c.curaddress = this._startAddr(i);
        c.curnibble = 0; c.curbyte = 0; c.acc = 0; c.stepIndex = 0;
        c.seq++;
        // 鳴っているサンプルの範囲(バイト)。ドライバがキーオン後に次の音のレジスタを先書きしても
        // 表示側(ピッチ解析)が正しいサンプルを見られるようキーオン時点で確定させる
        c.smpStart = c.curaddress;
        c.smpEnd = this._endAddr(i);
      }
    }
    // FMサンプル3回に1回。
    clock() {
      const rom = this.owner.romA;
      for (let i = 0; i < 6; i++) {
        const c = this.ch[i];
        if (!c.playing) { c.acc = 0; continue; }
        let data;
        if (c.curnibble === 0) {
          // 終了アドレス(inclusive)の次のバイトを読もうとした時点で停止。比較は下位20bitのみ
          const end = this._endAddr(i);
          if (((c.curaddress ^ end) & 0xFFFFF) === 0) { c.playing = false; c.acc = 0; continue; }
          c.curbyte = rom && c.curaddress < rom.length ? rom[c.curaddress] : 0;
          c.curaddress = (c.curaddress + 1) & 0xFFFFFF;
          data = c.curbyte >> 4; c.curnibble = 1;
        } else {
          data = c.curbyte & 0x0F; c.curnibble = 0;
        }
        let delta = ((2 * (data & 7) + 1) * ADPCMA_STEPS[c.stepIndex]) >> 3;
        if (data & 8) delta = -delta;
        c.acc = (c.acc + delta) & 0xFFF; // 12bit累算器はラップ(MSM5205と同じ)
        c.stepIndex = Math.max(0, Math.min(48, c.stepIndex + ADPCMA_STEP_INC[data & 7]));
      }
    }
    // ch i の現在出力(ymfm単位、パン適用前)。0=無音
    value(i) {
      const c = this.ch[i];
      const vol = ((this.regs[0x08 + i] & 0x1F) ^ 0x1F) + ((this.regs[0x01] & 0x3F) ^ 0x3F);
      if (vol >= 63) return 0;
      const mul = 15 - (vol & 7);
      const shift = 4 + 1 + (vol >> 3);
      let a = c.acc & 0xFFF; if (a & 0x800) a -= 0x1000; // 12bit符号拡張
      return (((a << 4) * mul) >> shift) & ~3;
    }
    panL(i) { return !!(this.regs[0x08 + i] & 0x80); }
    panR(i) { return !!(this.regs[0x08 + i] & 0x40); }
  }

  // ── ADPCM-B (ymfm adpcm_b_channel/engine、YM2610=外部メモリ固定・addrshift 8) ──
  const ADPCMB_STEP_MIN = 127, ADPCMB_STEP_MAX = 24576;
  const ADPCMB_STEP_SCALE = [57, 57, 57, 57, 77, 102, 128, 153];
  const ADPCMB_ADDR_SHIFT = 8;

  class AdpcmB {
    /**
     * @param {object} owner - romB / sampleRate を持つチップ本体
     * @param {{addrShift?: number, forceExternal?: boolean}} [opts]
     *   addrShift: 開始/終了/リミットレジスタ値→バイトアドレスのシフト。
     *   YM2610=8(256バイト単位、既定)、YM2608/Y8950=5(32バイト単位。MAME ymdeltat portshift)。
     *   forceExternal: control1へ外部メモリ・録音無効を強制(YM2610の実機挙動、既定true)。
     *   Y8950はCPU書込み(REC|MEMDATA)を使うので false にする(書込み自体は呼び出し側が実装)。
     */
    constructor(owner, opts) {
      this.owner = owner;
      this.addrShift = (opts && opts.addrShift) || ADPCMB_ADDR_SHIFT;
      this.forceExternal = !opts || opts.forceExternal !== false;
      this.regs = new Uint8Array(0x11);
      this.reset();
    }
    reset() {
      this.regs.fill(0);
      this.regs[0x0C] = this.regs[0x0D] = 0xFF; // リミット既定=全開
      this._resetChannel();
    }
    _resetChannel() {
      this.playing = false; this.curnibble = 0; this.curbyte = 0; this.position = 0; this.curaddress = 0;
      this.acc = 0; this.prevAcc = 0; this.step = ADPCMB_STEP_MIN;
      if (this.seq === undefined) this.seq = 0; // 開始通番(先読みキャプチャ用、AdpcmA.ch[].seqと同じ役割)。リセットでは戻さない
    }
    // 現在の開始/終了/Δ-Nから求めたサンプル長(秒)。リピート時は無限(Infinity)
    lengthSeconds() {
      const start = (this.regs[0x02] | (this.regs[0x03] << 8)) << this.addrShift;
      const end = ((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << this.addrShift;
      const rate = this.rate();
      if (this.regs[0x00] & 0x10) return Infinity;
      return rate > 0 ? Math.max(0, end - start) * 2 / rate : 0;
    }
    // reg = port0 アドレス - 0x10 (0x00-0x0B)
    write(reg, data) {
      // YM2610は外部モード強制・録音無効(ymfm ym2610::write_data)
      if (reg === 0x00 && this.forceExternal) data = (data | 0x20) & ~0x40;
      this.regs[reg] = data;
      if (reg === 0x00) {
        if (data & 0x80) this._loadStart(); // start
        if (data & 0x01) this._resetChannel(); // reset
      }
    }
    _loadStart() {
      this.playing = true;
      this.curaddress = (this.regs[0x02] | (this.regs[0x03] << 8)) << this.addrShift;
      this.curnibble = 0; this.curbyte = 0; this.position = 0; this.acc = 0; this.prevAcc = 0; this.step = ADPCMB_STEP_MIN;
      this.seq++;
      this.smpStart = this.curaddress; // 鳴っているサンプルの範囲(AdpcmA.ch[].smpStart/Endと同じ用途)
      this.smpEnd = ((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << this.addrShift;
    }
    _atEnd() { return this.curaddress === ((((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << this.addrShift) - 1); }
    _atLimit() { return this.curaddress === ((((this.regs[0x0C] | (this.regs[0x0D] << 8)) + 1) << this.addrShift) - 1); }
    // FMサンプル毎
    clock() {
      if (!(this.regs[0x00] & 0x80) || !this.playing) { this.playing = false; return; }
      const deltaN = this.regs[0x09] | (this.regs[0x0A] << 8);
      const position = this.position + deltaN;
      this.position = position & 0xFFFF;
      if (position < 0x10000) return;
      const rom = this.owner.romB;
      if (this.curnibble === 0) this.curbyte = rom && this.curaddress < rom.length ? rom[this.curaddress] : 0;
      const data = ((this.curbyte << (4 * this.curnibble)) & 0xFF) >> 4;
      this.curnibble ^= 1;
      if (this.curnibble === 0) {
        if (this._atEnd()) {
          if (this.regs[0x00] & 0x10) this._loadStart(); // repeat
          else { this.acc = 0; this.prevAcc = 0; this.playing = false; return; }
        } else if (this._atLimit()) {
          this.curaddress = 0;
        } else {
          this.curaddress = (this.curaddress + 1) & 0xFFFFFF;
        }
      }
      this.prevAcc = this.acc;
      let delta = ((2 * (data & 7) + 1) * this.step) >> 3;
      if (data & 8) delta = -delta;
      this.acc = Math.max(-32768, Math.min(32767, this.acc + delta));
      this.step = Math.max(ADPCMB_STEP_MIN, Math.min(ADPCMB_STEP_MAX, ((this.step * ADPCMB_STEP_SCALE[data & 7]) / 64) | 0));
    }
    // 現在出力(ymfm単位、パン適用前)。線形補間×レベル(/256)、さらにYM2610では>>1
    // (ymfm ym2610::clock_fm_and_adpcm の m_adpcm_b.output(…, rshift=1))
    value() {
      const r = ((this.prevAcc * ((this.position ^ 0xFFFF) + 1) + this.acc * this.position) >> 16);
      return (r * this.regs[0x0B]) >> 9;
    }
    panL() { return !!(this.regs[0x01] & 0x80); }
    panR() { return !!(this.regs[0x01] & 0x40); }
    // 表示用: 現在の再生レート(Hz)
    rate() { return (this.regs[0x09] | (this.regs[0x0A] << 8)) * this.owner.sampleRate / 65536; }
  }

  // ── サンプルのピッチ解析(鍵盤/ロールの音程表示用。再生には一切関与しない) ──
  // ADPCM-A/B のサンプルは ROM 上の固定データなので、同じ範囲(開始/終了アドレス)は毎回同じ波形。
  // 初めて見たサンプルを1回だけ丸ごとデコードして基本周期を求め、「1入力サンプルあたりの周期数
  // cps」(再生レート非依存)としてキャッシュする。表示周波数 = cps × 現在の再生レート
  // (ADPCM-A: 固定18518Hz、ADPCM-B: Δ-N由来)。ADPCM-Bは「1つのサンプルをΔ-Nで音階演奏」が
  // 典型なので、Δ-Nの比で正確な音程差 + 解析で正確な基準、の組み合わせで絶対音名まで出せる。
  // ADPCM-Aは「音程ごとに別サンプル」の場合にサンプルごとの検出値がそのまま絶対音になる。
  // ドラム/ノイズ系は検出信頼度(conf)が低くなるので、表示側はしきい値で音程なし表示に落とす。
  //
  // 検出は McLeod の NSDF(正規化二乗差関数、実体は正規化自己相関)。アタック部(先頭15%)を避けて
  // 最大 PITCH_FRAMES 個の窓を等間隔に取り、各窓で「最初の主要ピーク」(グローバル最大の90%以上で
  // 最初に現れる正の山、放物線補間)を周期とする。窓ごとの結果の中央値を採用し、中央値±3%以内で
  // 一致した窓の割合を conf(0-1)にする(オクターブ誤りや非周期部分があると下がる)。
  // コスト: 窓1600×ラグ800×6窓≒8M積和/サンプル、ユニークなサンプルごとに1回だけ(数ms〜十数ms)。
  // PITCH_MIN_LAG: 検出上限周波数=レート/16(ADPCM-A 18518Hz→1157Hz、ADPCM-B 55kHz→3.4kHz)。
  // 小さくするとハイハット等の高域ノイズが最小ラグ境界に偽ピークを作る(初版は8で 18518/8=2314.8Hz
  // が実曲のハイハットに出た)。境界(τ==PITCH_MIN_LAG)で最大となる山も真の極大でないので捨てる。
  const PITCH_WIN = 1600, PITCH_MAX_LAG = 800, PITCH_MIN_LAG = 16, PITCH_FRAMES = 6, PITCH_CLARITY = 0.85;

  function decodeAdpcmA(rom, start, end) {
    const n = Math.max(0, Math.min(end, rom.length) - start);
    const out = new Float32Array(n * 2);
    let acc = 0, stepIndex = 0, k = 0;
    for (let a = start; a < start + n; a++) {
      const byte = rom[a];
      for (const data of [byte >> 4, byte & 0x0F]) {
        let delta = ((2 * (data & 7) + 1) * ADPCMA_STEPS[stepIndex]) >> 3;
        if (data & 8) delta = -delta;
        acc = (acc + delta) & 0xFFF;
        stepIndex = Math.max(0, Math.min(48, stepIndex + ADPCMA_STEP_INC[data & 7]));
        let s = acc; if (s & 0x800) s -= 0x1000;
        out[k++] = s / 2048;
      }
    }
    return out;
  }
  function decodeAdpcmB(rom, start, end) {
    const n = Math.max(0, Math.min(end, rom.length) - start);
    const out = new Float32Array(n * 2);
    let acc = 0, step = ADPCMB_STEP_MIN, k = 0;
    for (let a = start; a < start + n; a++) {
      const byte = rom[a];
      for (const data of [byte >> 4, byte & 0x0F]) {
        let delta = ((2 * (data & 7) + 1) * step) >> 3;
        if (data & 8) delta = -delta;
        acc = Math.max(-32768, Math.min(32767, acc + delta));
        step = Math.max(ADPCMB_STEP_MIN, Math.min(ADPCMB_STEP_MAX, ((step * ADPCMB_STEP_SCALE[data & 7]) / 64) | 0));
        out[k++] = acc / 32768;
      }
    }
    return out;
  }

  // 1窓のNSDFから周期(ラグ、小数)と明瞭度(0-1)を返す
  function nsdfPeriod(pcm, off, W, maxLag) {
    let mean = 0;
    for (let i = 0; i < W; i++) mean += pcm[off + i];
    mean /= W;
    const x = new Float32Array(W);
    for (let i = 0; i < W; i++) x[i] = pcm[off + i] - mean;
    const nsdf = new Float32Array(maxLag + 1);
    for (let tau = PITCH_MIN_LAG; tau <= maxLag; tau++) {
      let acf = 0, m = 0;
      for (let i = 0; i + tau < W; i++) { const a = x[i], b = x[i + tau]; acf += a * b; m += a * a + b * b; }
      nsdf[tau] = m > 0 ? 2 * acf / m : 0;
    }
    // 正の山ごとの最大値を集める(負→正の交差から次の負への交差まで)
    const peaks = [];
    let inPos = false, best = -1, bestTau = 0;
    for (let tau = PITCH_MIN_LAG; tau <= maxLag; tau++) {
      const v = nsdf[tau];
      if (v > 0) {
        if (!inPos) { inPos = true; best = -1; }
        if (v > best) { best = v; bestTau = tau; }
      } else if (inPos) {
        inPos = false;
        if (bestTau > PITCH_MIN_LAG) peaks.push({ tau: bestTau, v: best }); // 境界の偽ピークは捨てる
      }
    }
    if (inPos && best > 0 && bestTau > PITCH_MIN_LAG && bestTau < maxLag) peaks.push({ tau: bestTau, v: best });
    if (!peaks.length) return null;
    let gmax = 0;
    for (const p of peaks) if (p.v > gmax) gmax = p.v;
    const p = peaks.find(q => q.v >= gmax * 0.9);
    // 放物線補間
    let tau = p.tau;
    if (tau > PITCH_MIN_LAG && tau < maxLag) {
      const y0 = nsdf[tau - 1], y1 = nsdf[tau], y2 = nsdf[tau + 1];
      const d = y0 - 2 * y1 + y2;
      if (d < 0) tau += 0.5 * (y0 - y2) / d;
    }
    return { lag: tau, clarity: p.v };
  }

  // pcm(Float32Array)から {cps, conf}。conf<0.5 は表示側で「音程なし」扱い
  function detectCps(pcm) {
    const len = pcm.length;
    if (len < 256) return { cps: 0, conf: 0 };
    const W = Math.min(PITCH_WIN, Math.floor(len * 0.6));
    const maxLag = Math.min(PITCH_MAX_LAG, Math.floor(W / 2));
    if (maxLag <= PITCH_MIN_LAG + 2) return { cps: 0, conf: 0 };
    const first = Math.floor(len * 0.15);
    const span = len - first - W;
    const frames = span <= 0 ? 1 : Math.min(PITCH_FRAMES, Math.floor(span / (W / 2)) + 1);
    const lags = [];
    for (let f = 0; f < frames; f++) {
      const off = span <= 0 ? Math.max(0, len - W) : first + Math.floor(span * f / Math.max(1, frames - 1));
      const r = nsdfPeriod(pcm, off, W, maxLag);
      if (r && r.clarity >= PITCH_CLARITY) lags.push(r.lag);
    }
    if (!lags.length) return { cps: 0, conf: 0 };
    lags.sort((a, b) => a - b);
    const med = lags[lags.length >> 1];
    let agree = 0;
    for (const l of lags) if (Math.abs(l - med) / med <= 0.03) agree++;
    return { cps: 1 / med, conf: agree / frames };
  }

  // サンプル内容のハッシュ(FNV-1a、先頭4KB+長さ)。手動キャリブレーションのキー。ROM上のアドレスは
  // ゲームごと/ダンプごとに違いうるが、サンプル内容が同じなら同じ音なので内容で同定する。
  function sampleHash(rom, start, end) {
    let h = 0x811c9dc5;
    const n = Math.min(end, rom.length) - start;
    const lim = Math.min(n, 4096);
    for (let i = 0; i < lim; i++) { h ^= rom[start + i]; h = Math.imul(h, 0x01000193); }
    h ^= n; h = Math.imul(h, 0x01000193);
    return (h >>> 0).toString(16) + '-' + n.toString(16);
  }
  const TUNING_KEY = 'ym2610AdpcmTuning'; // localStorage: { [sampleHash]: cps }
  // 毎回localStorageから読む(サンプル初出時とキャリブレーション時だけなので頻度は低い。
  // メモリキャッシュにすると開発者ツール等で消した設定が残り続けて紛らわしい)
  function getTuningMap() {
    try { return JSON.parse(global.localStorage.getItem(TUNING_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveTuningMap(map) {
    try { global.localStorage.setItem(TUNING_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }

  // ── 打楽器/音階の手動上書き ────────────────────────────────────────────
  // 「このサンプルは打楽器か、音階楽器か」はピッチ解析の信頼度(conf>=0.5)で自動判定して
  // いるが、外れる曲がある。ユーザーが耳で決めた指定をここへ集約する。
  // ★applyKindOverride を samplePitch() の中で conf に反映させることで、
  //   ロールのドラム区画・鍵盤のnote列・vgm2mmlのドラムパート・DPCM変換の4箇所が
  //   すべて自動的に追随する(判定の分岐を増やさない)。
  // キーはサンプル内容のハッシュ(チューニングと同じ)。ROM上のアドレスと違い、
  // 別のゲーム/別のリビジョンでも同じ音なら同じ指定が効く。
  const KIND_KEY = 'samplePitchKind'; // localStorage: { [sampleHash]: 'drum' | 'pitch' }
  function getKindMap() {
    try { return JSON.parse(global.localStorage.getItem(KIND_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveKindMap(map) {
    try { global.localStorage.setItem(KIND_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }
  /** samplePitch() の結果 r に手動指定を反映する(r.kindManual に指定内容を残す) */
  function applyKindOverride(r) {
    if (!r || !r.hash) return r;
    const k = getKindMap()[r.hash];
    if (k === 'drum') { r.conf = 0; r.kindManual = 'drum'; }
    else if (k === 'pitch' && r.cps > 0) { r.conf = 1; r.kindManual = 'pitch'; }
    else r.kindManual = null;
    return r;
  }
  /** 手動指定の設定/解除。kind: 'drum' | 'pitch' | null(=自動へ戻す) */
  function setKindOverride(hash, kind) {
    if (!hash) return;
    const map = getKindMap();
    if (kind === 'drum' || kind === 'pitch') map[hash] = kind; else delete map[hash];
    saveKindMap(map);
  }

  // 波形アイコン用の128点。cps>0(音程あり)なら持続部(先頭40%位置)から1周期を線形補間で切り出し、
  // 音程なし(ドラム等)ならサンプル全体を128区間に分け各区間の絶対値最大(符号付き)=概形。
  // どちらも最大絶対値で正規化(±1)。
  function makeSampleWave(pcm, cps) {
    const N = 128;
    const len = pcm.length;
    if (len < 8) return null;
    const out = new Float32Array(N);
    let mx = 1e-9;
    if (cps > 0) {
      const period = 1 / cps;
      let off = Math.floor(len * 0.4);
      if (off + period + 1 >= len) off = Math.max(0, len - period - 2);
      for (let k = 0; k < N; k++) {
        const pos = off + period * k / N;
        const i = Math.floor(pos), f = pos - i;
        const v = pcm[i] * (1 - f) + (pcm[Math.min(len - 1, i + 1)] || 0) * f;
        out[k] = v; if (Math.abs(v) > mx) mx = Math.abs(v);
      }
    } else {
      for (let k = 0; k < N; k++) {
        const a = Math.floor(len * k / N), b = Math.max(a + 1, Math.floor(len * (k + 1) / N));
        let best = 0;
        for (let i = a; i < b; i++) if (Math.abs(pcm[i]) > Math.abs(best)) best = pcm[i];
        out[k] = best; if (Math.abs(best) > mx) mx = Math.abs(best);
      }
    }
    for (let k = 0; k < N; k++) out[k] /= mx;
    return out;
  }

  class YM2610Audio {
    /**
     * @param {number} [clock=8000000] - マスタークロック(サンプルレート=clock/144)
     * @param {{ym2610b?: boolean}} [opts] - ym2610b: YM2610B(FM 6ch全部が実チャンネル)
     */
    constructor(clock, opts) {
      this.clockHz = clock || 8000000;
      this.core = new Emu.YM2612Nuked(this.clockHz, { chipType: 'ym3438' });
      this.sampleRate = this.core.sampleRate;
      this.isB = !!(opts && opts.ym2610b);
      // 本クラスのFM1-n → YM2612コア(6ch)上のチャンネル番号
      this.coreCh = this.isB ? [0, 1, 2, 3, 4, 5] : [1, 2, 4, 5];
      this.numFm = this.coreCh.length;
      this.mute = new Array(this.numFm).fill(false);
      this.vol = new Array(this.numFm).fill(1);
      this.muteAdpcm = new Array(7).fill(false); // 0-5=ADPCM-A ch1-6, 6=ADPCM-B
      this.volAdpcm = new Array(7).fill(1);
      this.romA = null; this.romB = null;
      this._pitchCache = new Map(); // 'a:start:end' / 'b:start:end' → {cps, conf}(samplePitch)
      this.adpcmA = new AdpcmA(this);
      this.adpcmB = new AdpcmB(this);
      this.cyc = 0; this.cycA = 0;
      this.adpcmL = 0; this.adpcmR = 0;
      this.syncMuteVol();
    }

    // mute[]/vol[]をコアの6要素へ写す。ダミーch(YM2610の0,3)とDAC(6)は常時ミュート。
    syncMuteVol() {
      const c = this.core;
      for (let i = 0; i < 7; i++) c.mute[i] = true;
      for (let i = 0; i < this.numFm; i++) { c.mute[this.coreCh[i]] = !!this.mute[i]; c.vol[this.coreCh[i]] = this.vol[i]; }
    }

    reset() {
      this.core.reset(); this.adpcmA.reset(); this.adpcmB.reset();
      this.cyc = 0; this.cycA = 0; this.adpcmL = 0; this.adpcmR = 0;
      this.syncMuteVol();
    }

    /**
     * VGMデータブロック 0x82(ADPCM-A ROM)/0x83(ADPCM-B ROM)。
     * @param {'a'|'b'} kind  @param {number} romSize  @param {number} start  @param {Uint8Array} data
     */
    loadRom(kind, romSize, start, data) {
      const key = kind === 'b' ? 'romB' : 'romA';
      let rom = this[key];
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this[key] = n; }
      rom.set(data, start);
      this._pitchCache.clear(); // ROMが変わったら解析結果は無効
    }

    /**
     * サンプル(ROM上のstart..end-1バイト)の基本周期解析結果(キャッシュ)。表示専用。
     * @param {'a'|'b'} kind
     * @returns {{cps:number, conf:number, cpsAuto:number, confAuto:number, manual:boolean, hash:string, wave:Float32Array|null}|null}
     *   cps=1入力サンプルあたりの周期数(手動補正があればその値、conf=1)。cpsAuto/confAutoは自動検出値。
     *   wave=波形アイコン用128点(音程あり: 持続部の1周期 / 無し: サンプル全体の概形)
     */
    samplePitch(kind, start, end) {
      if (start === undefined || end === undefined || !(end > start)) return null;
      const key = kind + ':' + start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const rom = kind === 'b' ? this.romB : this.romA;
      if (!rom) return null;
      const pcm = this._decodeSample(kind, start, end);
      const auto = detectCps(pcm);
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false, hash: sampleHash(rom, start, end), wave: null };
      // 手動キャリブレーション(localStorage、サンプル内容のハッシュがキーなので同じゲームの他トラックでも効く)
      const t = getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      // 打楽器/音階の手動上書きをconfへ反映(ロール/鍵盤/変換の4箇所がこの1点で追随する)
      applyKindOverride(r);
      r.wave = makeSampleWave(pcm, r.conf >= 0.5 ? r.cps : 0);
      this._pitchCache.set(key, r);
      return r;
    }
    _decodeSample(kind, start, end) {
      const rom = kind === 'b' ? this.romB : this.romA;
      // 極端に長いサンプル(ADPCM-Bのループ曲データ等)は先頭部分だけ見る(解析コスト上限)
      const MAX_BYTES = 64 * 1024;
      const e = Math.min(end, start + MAX_BYTES);
      return kind === 'b' ? decodeAdpcmB(rom, start, e) : decodeAdpcmA(rom, start, e);
    }

    /**
     * スナップショットの sample({kind,start,end}) → デコード済みPCM(Float32Array、-1..1)。
     * vgm2mmlのドラム→@DPCM変換が実サンプルを必要とするための公開口。
     * ROMはこのチップ(=キャプチャWorker側)にしか無く、関数はpostMessageを越えられないので、
     * キャプチャの最後にここを呼んで実データだけをメインスレッドへ渡す
     * (src/emulator/vgmPlayer.js の collectUsedSamples 参照)。
     */
    /**
     * 打楽器/音階の手動上書き。kind: 'drum' | 'pitch' | null(=自動へ戻す)。
     * ピッチ解析の信頼度(conf)による自動判定が外れた曲を、ユーザーが耳で直すための口。
     * 指定はサンプル内容のハッシュをキーに localStorage へ入る(setSampleTuningと同じ流儀。
     * ROMアドレスと違い、同じ音なら別のゲーム/リビジョンでも効く)。
     * ★confへの反映は Emu.SamplePitchUtil.applyKindOverride が samplePitch() の中で行うので、
     *   ロールのドラム区画・鍵盤のnote列・vgm2mmlのドラムパート・DPCM変換が自動的に追随する。
     */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const r = this.samplePitch(sample.kind, sample.start, sample.end);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      // 「音階として扱う」を選んでも、周期がまったく検出できていない(cps=0)サンプルは
      // 使える音程が無い。呼び出し側へ知らせて基準音の手動補正を促す(黙って無視しない)
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._pitchCache.delete(sample.kind + ':' + sample.start + ':' + sample.end); // 次回参照で上書きを反映し直す
      return { kind: kind || null, needsTuning: needsTuning };
    }

    samplePcm(sample) {
      if (!sample) return null;
      return this._decodeSample(sample.kind, sample.start, sample.end);
    }

    /**
     * サンプルの手動ピッチ補正(表示専用)。cps=null で解除。localStorage に永続化し、
     * 同じ内容のサンプル(ハッシュ一致)なら別トラック/別セッションでも効く。
     */
    setSampleTuning(kind, start, end, cps) {
      const r = this.samplePitch(kind, start, end);
      if (!r) return null;
      const map = getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; r.cps = cps; r.conf = 1; r.manual = true; }
      else { delete map[r.hash]; r.cps = r.cpsAuto; r.conf = r.confAuto; r.manual = false; }
      saveTuningMap(map);
      r.wave = makeSampleWave(this._decodeSample(kind, start, end), r.conf >= 0.5 ? r.cps : 0);
      return r;
    }

    // レジスタ書込み(port 0/1)。SSG(port0 0x00-0x0F)は呼び出し側がAY8910Audioへ振り分ける前提
    // (渡ってきても弾く)。
    writeReg(port, reg, val) {
      reg &= 0xFF; val &= 0xFF;
      if (port === 0) {
        if (reg < 0x10) return;                              // SSG / I/Oポート
        if (reg < 0x1C) { this.adpcmB.write(reg - 0x10, val); return; } // ADPCM-B
        if (reg === 0x1C) return;                            // EOSフラグ制御(再生には無関係)
        if (reg < 0x20) return;
        if (reg === 0x2A || reg === 0x2B) return;            // YM2612のDAC。YM2610には無い
      } else if (reg < 0x30) {
        this.adpcmA.write(reg, val); return;                 // ADPCM-A
      }
      this.core.writeReg(port, reg, val);
    }

    clock() {
      this.core.clock();
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      // FMサンプル毎: ADPCM-B。3回に1回(EGサイクル): ADPCM-A
      this.adpcmB.clock();
      if (++this.cycA >= 3) { this.cycA = 0; this.adpcmA.clock(); }
      let l = 0, r = 0;
      const A = this.adpcmA;
      for (let i = 0; i < 6; i++) {
        if (this.muteAdpcm[i] || !A.ch[i].playing) continue;
        const v = A.value(i) * this.volAdpcm[i];
        if (A.panL(i)) l += v;
        if (A.panR(i)) r += v;
      }
      if (!this.muteAdpcm[6] && this.adpcmB.playing) {
        const v = this.adpcmB.value() * this.volAdpcm[6];
        if (this.adpcmB.panL()) l += v;
        if (this.adpcmB.panR()) r += v;
      }
      this.adpcmL = l * ADPCM_SCALE; this.adpcmR = r * ADPCM_SCALE;
    }
    mixSample() {
      const s = this.core.mixSample();
      return { left: s.left + this.adpcmL, right: s.right + this.adpcmR };
    }
    // 書込みキュー適用(clock()を回さない先読み/シーク経路用)
    flushWrites(collapse) { if (this.core.flushWrites) this.core.flushWrites(collapse); }
  }

  // 鍵盤表示用スナップショット: FMはYM2612版の6chから実チャンネルを抜き出す(形は同じ)。
  // adpcmA[6]/adpcmB: {active, vol(0-1), rawVol, rawVolMax, panL, panR, rate, pitchHz, pitchConf, ...}
  //   pitchHz/pitchConf: 鳴っているサンプルのピッチ解析(samplePitch)結果 × 現在の再生レート。
  //   conf<0.5 は表示側で音程なし扱い(ドラム等)。ADPCM-Aは音程レジスタが無いのでこれが唯一の音程情報、
  //   ADPCM-Bは refRate ベースの仮基準(下記)より優先して使う。
  Emu.snapshotYM2610 = function (chip, opt) {
    const s = Emu.snapshotYM2612(chip.core, opt);
    const A = chip.adpcmA, B = chip.adpcmB;
    const tl = (A.regs[0x01] & 0x3F);
    const adpcmA = [];
    const rateA = chip.sampleRate / 3;
    for (let i = 0; i < 6; i++) {
      const il = A.regs[0x08 + i] & 0x1F;
      const att = (il ^ 0x1F) + (tl ^ 0x3F); // 0=最大
      const vol = att >= 63 ? 0 : Math.max(0, 1 - att / 63);
      const c = A.ch[i];
      const p = c.seq ? chip.samplePitch('a', c.smpStart, c.smpEnd) : null;
      // seq/lenSec: clock()を回さない先読みキャプチャ(vgmPlayer.js captureVgmSongAsync)が、キーオン通番の
      // 変化とサンプル長から「鳴っている区間」を推定するために使う(ライブ表示は playing で足りる)
      adpcmA.push({ active: c.playing && vol > 0, vol, rawVol: il, rawVolMax: 31, panL: A.panL(i) ? 1 : 0, panR: A.panR(i) ? 1 : 0,
        rate: rateA, seq: c.seq, lenSec: A.lengthSeconds(i),
        pitchHz: p ? p.cps * rateA : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'a', start: c.smpStart, end: c.smpEnd } : null }); // 手動キャリブレーション用の同定情報
    }
    const lvl = B.regs[0x0B];
    const rateB = B.rate();
    const pb = B.seq ? chip.samplePitch('b', B.smpStart, B.smpEnd) : null;
    const adpcmB = { active: B.playing && !!(B.regs[0x00] & 0x80) && lvl > 0, vol: lvl / 255, rawVol: lvl, rawVolMax: 255,
      panL: B.panL() ? 1 : 0, panR: B.panR() ? 1 : 0, rate: rateB, seq: B.seq, lenSec: B.lengthSeconds(), executing: !!(B.regs[0x00] & 0x80),
      pitchHz: pb ? pb.cps * rateB : 0, pitchConf: pb ? pb.conf : 0, pitchManual: !!(pb && pb.manual), sampleKind: pb ? (pb.kindManual || 'auto') : 'auto', sampleHash: pb ? pb.hash : null,
      waveData: pb ? pb.wave : null,
      sample: B.seq ? { kind: 'b', start: B.smpStart, end: B.smpEnd } : null,
      // refRate: ピッチ解析が信頼できない時のフォールバック用。ADPCM-Bの再生レート(Delta-N由来)を
      // 鍵盤/ロールで疑似音程表示する際の基準(=C4扱い)。ADPCM-Bには「これが基準ピッチ」という
      // レジスタは無いので、同チップのADPCM-A固定レート(chip.sampleRate/3)を基準に採用した
      // (keyboard.js側の相対表示。絶対音名は目安)
      refRate: rateA };
    return { channels: chip.coreCh.map(i => s.channels[i]), adpcmA, adpcmB };
  };

  Emu.YM2610Audio = YM2610Audio;

  // サンプルピッチ解析ユーティリティの共有(GA20等、他のPCMチップからの流用。抽出器を複製しない)。
  // getTuningMap/saveTuningMap の localStorage キーはYM2610と共通('ym2610AdpcmTuning')だが、
  // キーはサンプル内容ハッシュなのでチップをまたいで共有しても衝突しない(むしろ同じサンプルなら
  // 同じ補正が効くのが望ましい)。
  // ループ区間の基本周期推定(qsound.jsで実証した「ループ因数分解方式」の共有版)。
  // ハードウェアループは継ぎ目なく繋がる=ループ長は基本周期の整数倍。k=2..64の lag=N/k で
  // 巡回自己相関(補間つき)を測り、最大相関の90%以上の中で最大のk(=最高周波数解釈)を採る。
  // 汎用detectCpsは探索上限(PITCH_MAX_LAG)を長周期ベースが超えるが、この方式は上限なし。
  // どのkも通らなければ「ループ全体=1周期」(単一周期シンセ波形。≤1024サンプルに限る)。
  // 返り値は detectCps 互換 {cps, conf} または null。
  function loopCps(one) {
    const N = one.length;
    if (N < 16) return null;
    let mean = 0;
    for (let i = 0; i < N; i++) mean += one[i];
    mean /= N;
    const x = new Float32Array(N);
    let e = 0;
    for (let i = 0; i < N; i++) { x[i] = one[i] - mean; e += x[i] * x[i]; }
    if (e < 1e-9) return null;
    let bestK = 0, bestCorr = 0;
    const cands = [];
    for (let k = 2; k <= 64; k++) {
      const lag = N / k;
      if (lag < 8) break;
      let acf = 0;
      for (let i = 0; i < N; i++) {
        const pos = (i + lag) % N;
        const j = Math.floor(pos), f = pos - j;
        const v = x[j] * (1 - f) + x[(j + 1) % N] * f;
        acf += x[i] * v;
      }
      const corr = acf / e;
      cands.push([k, corr]);
      if (corr > bestCorr) { bestCorr = corr; bestK = k; }
    }
    if (bestCorr >= 0.85) {
      for (const [k, corr] of cands) if (corr >= bestCorr * 0.9 && k > bestK) bestK = k;
      return { cps: bestK / N, conf: Math.min(1, bestCorr) };
    }
    if (N <= 1024) return { cps: 1 / N, conf: 0.75 };
    return null;
  }

  Emu.SamplePitchUtil = { detectCps, makeSampleWave, sampleHash, getTuningMap, saveTuningMap, loopCps,
                          getKindMap, saveKindMap, applyKindOverride, setKindOverride };

  // ── OPNファミリ共有(YM2608=ym2608.jsが流用) ─────────────────────────
  // AdpcmA(fixedAddr指定でYM2608内蔵リズムに使える)/AdpcmB(addrShift=5でYM2608 DELTA-T)/
  // デコーダ、そして表示用サンプルピッチ解析API一式。
  // attachSampleApi: YM2610Audioのピッチ解析メソッド群(this.romA/romB/_pitchCacheしか
  // 参照しない)を別チップのprototypeへそのまま移植する(実装の複製を作らない)。
  Emu.OpnAdpcm = {
    AdpcmA, AdpcmB, decodeAdpcmA, decodeAdpcmB, ADPCM_SCALE,
    attachSampleApi(proto) {
      proto.loadRom = YM2610Audio.prototype.loadRom;
      proto.samplePitch = YM2610Audio.prototype.samplePitch;
      proto._decodeSample = YM2610Audio.prototype._decodeSample;
      proto.samplePcm = YM2610Audio.prototype.samplePcm;
      proto.setSampleTuning = YM2610Audio.prototype.setSampleTuning;
      proto.setSampleKind = YM2610Audio.prototype.setSampleKind;
    }
  };
})(globalThis);

/*
 * Sega MultiPCM (315-5560 / YMW-258-F) 28ch PCM 音源 (VGM: chip 'multipcm'。
 * セガ Model 1(Virtua Racing/Virtua Fighter=デュアル構成)/Model 2(Daytona USA/Virtua Cop)/
 * System Multi 32(OutRunners)。Model 1系のリップは音楽全体がMultiPCMに載る)
 * MML.Emu.MultiPCMAudio
 *
 * 8bit符号付きPCM×28スロット、ADSRエンベロープ+TL+4bitパン内蔵。**全サンプルがループ**
 * (ワンショットはEGのディケイで無音化する方式=SPC/YMF278系の設計)。
 * MAME multipcm.cpp(ElSemiコア)準拠:
 *   サンプルレート = clock/180(8MHz → 44444Hz。分周の根拠はコンストラクタのコメント)
 *   ポート(VGMコマンド 0xB5 aa dd、aaのbit7=デュアル2個目):
 *     0=データ / 1=スロット選択(値0-31、7/15/23/31は無効=28ch) / 2=スロットレジスタ選択
 *   スロットレジスタ:
 *     r0=パン(上位4bit、0=中央/1-7=右寄せ/9-15=左寄せ/8=ミュート相当)
 *     r1=サンプル番号下位8bit(書込み時にROM先頭のサンプル表12バイトを読込む)
 *     r2=bit0:サンプル番号bit8、bit2-7:F-number下位6bit
 *     r3=bit0-3:F-number上位4bit、bit4-7:オクターブ(-1バイアス、8以上=負)
 *       再生ステップ = (1024+F)/1024 × 2^oct(F-number線形=OPL系と同じ)
 *     r4=bit7:キーオン(オフセット0からEGアタック開始)/0:キーオフ(リリースへ)
 *     r5=bit1-7:TL(0.375dB/step)、bit0=1:徐々に遷移/0:即時
 *     r6/r7=LFO(ビブラート/トレモロ)…未実装(本実装の割り切り)
 *   サンプル表(ROM先頭、番号×12バイト): +0-2=開始22bit(上位2bit=フォーマット、
 *   12bitサンプルは未実装=セガ系は8bit)、+3-4=ループ点、+5-6=0x10000-終了位置、
 *   +7=LFO、+8=AR/D1R、+9=DL/D2R、+10=KRS/RR、+11=AM
 *   EG: ATTACK→DECAY1→(DLで)DECAY2→(キーオフで)RELEASE。時間はElSemiのBaseTimes表
 *   (アタックms、ディケイ系は×14.32833)、レート=4×値+キースケール(RC≠15のとき2×RC+oct)。
 *   減衰ドメインは線形インデックス0-1023(=0〜-96dBを指数変換)、DLは3dB/段。
 * VGM: ROMはデータブロック0x89(デュアルはサイズbit31)、ヘッダ0x88。
 *   セガバンキング: コマンド **0xC3 cc bb aa**(値=aabb、ccのbit0/bit1=バンク2本、
 *   bit7=デュアル2個目)。アドレス0x100000-0x1FFFFFの窓に対し
 *   物理 = 1MBページ基底(値<<16) + (addr & 0xFFFFF)。bankWrite()のコメント参照。
 *
 * ★ピッチ: F-number/octレジスタで1サンプルを音階演奏(C140系)+全サンプルループなので、
 * 解析は detectCps → 失敗時 SamplePitchUtil.loopCps(ループ因数分解、QSoundで実証)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 28;
  // スロット選択値(0-31)→スロット番号(8個ごとに1つ無効)
  const VALUE_TO_SLOT = [];
  for (let i = 0; i < 32; i++) VALUE_TO_SLOT.push((i & 7) === 7 ? -1 : (i >> 3) * 7 + (i & 7));

  // EG時間表(ElSemi/MAME multipcm: アタックのフルスケール遷移ms。レート0-3は無限=保持)
  // ★値は MAME multipcm.cpp と同じ(BSD-3-Clause, Copyright Miguel Angel Horna)。THIRD-PARTY-NOTICES.md 参照
  const BASE_TIMES_MS = [
    0, 0, 0, 0, 6222.95, 4978.37, 4148.66, 3556.01, 3111.47, 2489.21, 2074.33, 1778.00,
    1555.74, 1244.63, 1037.19, 889.08, 777.87, 622.31, 518.59, 444.54, 388.93, 311.16,
    259.32, 222.27, 194.47, 155.60, 129.66, 111.16, 97.23, 77.82, 64.85, 55.60,
    48.62, 38.91, 32.43, 27.80, 24.31, 19.46, 16.24, 13.92, 12.15, 9.75, 8.12, 6.98,
    6.08, 4.90, 4.08, 3.49, 3.04, 2.49, 2.13, 1.90, 1.72, 1.41, 1.18, 1.04,
    0.91, 0.73, 0.59, 0.50, 0.45, 0.45, 0.45, 0.45];
  const AR2DR = 14.32833; // ディケイ系はアタックの約14.3倍遅い(ElSemi定数)
  const EG_MAX = 1023;    // 線形音量インデックス(1023=0dB、0=-96dB)
  const DB_RANGE = 96;

  // 状態: 0=off, 1=attack, 2=decay1, 3=decay2, 4=release
  const EG_OFF = 0, EG_ATTACK = 1, EG_DECAY1 = 2, EG_DECAY2 = 3, EG_RELEASE = 4;

  class MultiPCMAudio {
    /** @param {number} [clock=8000000] - クロック(サンプルレート=clock/180) */
    constructor(clock) {
      this.clockHz = clock || 8000000;
      // ★分周は180(ElSemi/VGMPlayのMULTIPCM_CLOCKDIV=180系譜。8MHz→44444Hz)。
      //   MAME現行のclock/224だと全サンプルが3/4速+約4半音フラットになる。
      //   OutRunners「Mega Driver」の実盤FLACとのクロマ(調)照合で確定:
      //   ÷180=相関0.998(ピークE一致)/÷224=0.969(調性拡散)/÷224×4/3=0.986(Fへ半音シャープ)。
      //   VGMリップのヘッダクロックは180分周前提で書かれている。
      this.cyclesPerSample = 180;
      this.sampleRate = this.clockHz / 180;
      this.rom = null;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this._pitchCache = new Map(); // '物理start:len' → {cps, conf, …}
      this.reset();
    }
    reset() {
      this.ch = [];
      for (let i = 0; i < NUM_CH; i++) this.ch.push({
        regs: new Uint8Array(8),
        playing: false, pan: 0,
        smpNum: 0, start: 0, loop: 0, end: 0, fmt: 0,
        ar: 0, d1r: 0, dl: 0, d2r: 0, rr: 0, krs: 0,
        pos: 0, frac: 0, step: 0, octSigned: 0,
        tlIdx: 0, tlDestIdx: 0,
        egState: EG_OFF, egVol: 0, egRate: 0, egTarget: 0,
        seq: 0, physStart: 0, smpLen: 0, loopOff: 0, lenSecEst: 0 });
      this.curSlot = 0;
      this.curAddr = 0;
      this.bankL = 0; this.bankR = 0; this.bankPage = 0; this._sawBankR = false;
      this.bankingEnabled = false;
      this.bankFromCommand = false;
      this.cyc = 0;
      this.lastL = 0; this.lastR = 0;
    }

    /** VGMデータブロック 0x89(MultiPCM ROM)。 */
    loadRom(romSize, start, data) {
      let rom = this.rom;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.rom = n; }
      rom.set(data, start);
      this._pitchCache.clear();
    }
    // ★リップ欠陥の救済(OutRunners等のMulti32): ブート時(ログ開始前)にバンクが設定済みで
    // 0xC3がVGMに1つも無いのに、サンプル表はバンク窓(0x100000-0x1FFFFF)経由のアドレスを指す。
    // トラックごとにバンクが違い(Mega Driver=0x380000/Splash Wave=0x180000等)、ROMデータ
    // ブロックは物理位置に置かれる。「窓が空なら〜」の事前判定はSplash Wave(物理0x180000台=
    // 窓の上半分と重なる位置にデータ)で誤爆したため、**キーオン時の遅延検証**にする:
    // マッピング先が空(先頭2KBが全ゼロ)のとき、データが実在する0x80000境界バンクを
    // 全候補から探して(非ゼロ密度最大)その窓半分に採用する。
    // 本物の0xC3が来た曲(Model 1/2等)は探索しない(空=本当に無音データかもしれないため)。
    _findAutoBank(start, len) {
      const rom = this.rom;
      const off = start & 0xFFFFF; // ページ基底からの相対(A19はアドレス側が供給)
      const density = (page) => {
        if (page + off >= rom.length) return -1;
        let nz = 0;
        const n = Math.min(len, 2048);
        for (let i = 0; i < n; i += 16) if (rom[page + off + i]) nz++;
        return nz;
      };
      let best = -1, bestPage = -1;
      for (let page = 0; page + 0x80000 <= rom.length; page += 0x80000) {
        const d = density(page);
        if (d > best) { best = d; bestPage = page; }
      }
      return best > 8 ? bestPage : -1; // それらしいデータが無ければ諦める
    }
    _autoBankAtKeyon(c) {
      if (this.bankFromCommand || !this.rom || this.rom.length <= 0x200000) return;
      if (c.start < 0x100000 || c.start >= 0x200000) return;
      // 現在のマッピング先にデータがあるなら何もしない
      let nz = 0;
      const n = Math.min(c.smpLen, 2048);
      for (let i = 0; i < n; i += 16) if (this.rom[c.physStart + i]) nz++;
      if (nz > 8) return;
      const page = this._findAutoBank(c.start, c.smpLen);
      if (page < 0) return;
      this.bankPage = page;
      this.bankingEnabled = true;
      c.physStart = this._mapAddr(c.start);
    }

    /*
     * セガバンキング(VGM 0xC3 cc bb aa)。cc の bit0/bit1 で2つのバンク値が来るが、
     * ★実ログでは両者は必ず「同じ1MBページの下半分/上半分」で、別ページを指すことはない
     * (手元コーパス175曲の内訳: cc3=1つの値を両方に 136曲、cc1=X+0x80000 & cc2=X 22曲、
     * cc1=0(=上半分を使わない) & cc2=X 17曲)。したがって窓(0x100000-0x1FFFFF)の写像は
     * **1MBページ基底 + アドレス下位20bit** が正しく、A19(どちらの半分か)はアドレス自身が供給する。
     * MAME/VGMPlay 式の「bit19でL/Rを選び bank|(addr&0x7FFFF)」にすると、cc3(Model 1/2)の曲で
     * 上半分のサンプルが全部下半分へ落ち、別の音が鳴る(Daytona USAで発覚)。
     * 実測: 窓内サンプル1279個のうち写像先にデータがあるのは本方式1279 / 旧方式841。
     * ページ基底は cc bit1(下半分側)の値を採り、bit1が一度も来ていない間だけ bit0 を使う。
     */
    bankWrite(sel, val) {
      const base = (val << 16) >>> 0;
      if (sel & 1) this.bankL = base;
      if (sel & 2) { this.bankR = base; this._sawBankR = true; }
      if ((sel & 2) || !this._sawBankR) this.bankPage = base;
      this.bankingEnabled = true;
      this.bankFromCommand = true; // 本物の0xC3がある曲では遅延自動バンク探索をしない
    }
    // 論理→物理アドレス。★バンキングは0xC3書込みがあった曲だけ有効(VGMPlayのSegaBanking
    // フラグ相当)。サンプルアドレスは22bit=4MB直接参照でき、OutRunners等はバンク無しで
    // 0x100000以上を直に指す。無条件適用するとbank=0の別領域を読んで無音/ゴミになる。
    // 窓は 0x100000-0x1FFFFF の1MBだけ(MAMEの &0x1FFFFF 相当。手元コーパスに
    // 0x200000以上を開始アドレスに持つサンプルは1つも無い)。
    _mapAddr(addr) {
      if (this.bankingEnabled && addr >= 0x100000 && addr < 0x200000) {
        return (this.bankPage + (addr & 0xFFFFF)) >>> 0;
      }
      return addr;
    }
    _read(addr) {
      const a = this._mapAddr(addr >>> 0);
      return this.rom && a < this.rom.length ? this.rom[a] : 0;
    }

    /** ポート書込み(VGM 0xB5 aa dd: aa=0データ/1スロット選択/2レジスタ選択) */
    write(port, val) {
      val &= 0xFF;
      switch (port & 7) {
        case 1: this.curSlot = VALUE_TO_SLOT[val & 0x1F]; break;
        case 2: this.curAddr = Math.min(7, val); break;
        case 0: {
          const i = this.curSlot;
          if (i < 0) break;
          this._writeSlot(this.ch[i], this.curAddr, val);
          break;
        }
      }
    }

    _writeSlot(c, reg, val) {
      c.regs[reg] = val;
      switch (reg) {
        case 0: c.pan = (val >> 4) & 0xF; break;
        case 1: { // サンプル番号下位。★発音中は即時反映しない(MAMEは即時だが、キーオン前の
          // 数サンプル間、旧ノートが新サンプルのアドレス空間を読んでフルスケールのゴミを
          // 出す=Virtua Racingのプチノイズ実測1.1の正体)。キーオン時に regs[1]/regs[2] から
          // 読み直すので、ここでは未発音スロットだけ即時ロード(表示用)。
          if (!c.playing) this._loadSample(c, val | ((c.regs[2] & 1) << 8));
          break;
        }
        case 2: case 3: { // ピッチ: F-number 10bit + oct 4bit(-1バイアス、線形F-number)
          const octRaw = ((c.regs[3] >> 4) - 1) & 0xF;
          c.octSigned = octRaw >= 8 ? octRaw - 16 : octRaw;
          const fnum = ((c.regs[3] & 0xF) << 6) | (c.regs[2] >> 2);
          c.step = (1024 + fnum) / 1024 * Math.pow(2, c.octSigned);
          break;
        }
        case 4: // キーオン/オフ
          if (val & 0x80) {
            this._loadSample(c, c.regs[1] | ((c.regs[2] & 1) << 8)); // サンプル情報はここでラッチ
            c.playing = true;
            c.pos = 0; c.frac = 0;
            c.egState = EG_ATTACK;
            // ★EGは現在レベルからアタック(0リセットすると、リリース途中のスロットへの
            //   再キーオンで振幅が一瞬0へ飛びプチノイズになる)
            c.egRate = this._egStep(c.ar, c, false);
            c.seq++;
            c.physStart = this._mapAddr(c.start);
            this._autoBankAtKeyon(c); // リップ欠陥の救済(マッピング先が空ならバンク探索)
            this._estimateLen(c);
          } else if (c.playing) {
            // RR=0xFも即時停止でなく最速リリース(ElSemi: rate 63=0.45ms)。即時0だと
            // 波形途中でフルスケール級のハードカット=プチノイズになる(Virtua Racing実測1.1)
            c.egState = EG_RELEASE;
            c.egRate = this._egStep(Math.max(1, c.rr), c, true);
          }
          break;
        case 5: { // TL(0.375dB/step)。★bit0=0が「徐々に遷移」、bit0=1が「即時」(MAME準拠。
          // 当初極性を逆にしていて、ドライバのフェード書込み(0xfe等)が即時-47dBカット=
          // フルスケール級プチノイズになっていた。Virtua Racing実測: TLだけをスロット5本へ
          // 一斉書込みするフェード手順)
          c.tlDestIdx = (val >> 1) & 0x7F;
          if (val & 1) c.tlIdx = c.tlDestIdx;
          break;
        }
        // r6/r7: LFO未実装
      }
    }

    _loadSample(c, num) {
      c.smpNum = num;
      const a = num * 12;
      const b = (o) => this._read(a + o);
      c.fmt = (b(0) >> 6) & 3; // 0=8bit(12bitは未実装。セガ系ROMは8bit)
      c.start = ((b(0) << 16) | (b(1) << 8) | b(2)) & 0x3FFFFF;
      c.loop = (b(3) << 8) | b(4);
      c.end = 0xFFFF - ((b(5) << 8) | b(6)); // 格納値は負の長さ(MAME: 0xFFFF - 値。off-by-oneでループ末尾に1バイト余分に入るとユニゾンベースのループ折返しが同時クリック化する)
      c.ar = b(8) >> 4; c.d1r = b(8) & 0xF;
      c.dl = b(9) >> 4; c.d2r = b(9) & 0xF;
      c.krs = b(10) >> 4; c.rr = b(10) & 0xF;
      if (c.end <= 0 || c.end > 0x10000) c.end = 0x10000;
      if (c.loop >= c.end) c.loop = 0;
      c.smpLen = c.end;
      c.loopOff = c.loop;
    }

    // EGレート(4×値+キースケール)→ 1出力サンプルあたりの線形インデックス増分
    _egStep(val, c, decay) {
      if (val <= 0) return 0; // 保持
      const ks = (c.krs === 0xF) ? 0 : Math.max(0, Math.min(15, 2 * c.krs + c.octSigned));
      const r = Math.max(0, Math.min(63, 4 * val + ks));
      let ms = BASE_TIMES_MS[r];
      if (ms <= 0) return 0;
      if (decay) ms *= AR2DR;
      return EG_MAX / (ms / 1000 * this.sampleRate);
    }
    // DL(3dB/段)→線形インデックスの目標値
    _dlTarget(c) {
      const db = c.dl >= 15 ? DB_RANGE : c.dl * 3;
      return Math.max(0, EG_MAX - db * EG_MAX / DB_RANGE);
    }
    // キーオン時のEG可聴時間の見積り(regsOnlyキャプチャの発音区間窓用。
    // 全サンプルループなので「終わり」はEGが決める。D2R=0(保持)ならInfinity)
    _estimateLen(c) {
      // ★Infinity×0=NaNに注意(D1R=0かつDL=0のサステイン音で発生し、キャプチャの
      //   発音窓が f < NaN=false で即死していた)。段ごとに有限性を確認して合算する。
      const t = (val, decay) => {
        const step = this._egStep(val, c, decay);
        return step > 0 ? EG_MAX / step / this.sampleRate : Infinity;
      };
      const dlDb = c.dl >= 15 ? DB_RANGE : c.dl * 3;
      const tA = t(c.ar, false);
      let sec = tA === Infinity ? 0 : tA; // AR保持は_egAdvance側で即時扱いなので0
      if (dlDb > 0) {
        const tD1 = t(c.d1r, true);
        if (tD1 === Infinity) { c.lenSecEst = Infinity; return; } // ディケイ1が進まない=持続
        sec += tD1 * (dlDb / DB_RANGE);
        if (dlDb >= DB_RANGE - 6) { c.lenSecEst = sec; return; } // DLでほぼ無音
      }
      const tD2 = t(c.d2r, true);
      c.lenSecEst = tD2 === Infinity ? Infinity : sec + tD2 * ((DB_RANGE - dlDb) / DB_RANGE);
      // loop=0のワンショットはサンプル終端でも終わる(EG見積りとの短い方)
      if (!c.loop && c.step > 0) {
        const smpSec = c.smpLen / (c.step * this.sampleRate);
        if (smpSec < c.lenSecEst) c.lenSecEst = smpSec;
      }
    }

    _egAdvance(c) {
      switch (c.egState) {
        case EG_ATTACK:
          c.egVol += c.egRate || EG_MAX; // レート0(保持)はアタックだけ即時扱い
          if (c.egVol >= EG_MAX) { c.egVol = EG_MAX; c.egState = EG_DECAY1; c.egRate = this._egStep(c.d1r, c, true); c.egTarget = this._dlTarget(c); }
          break;
        case EG_DECAY1:
          c.egVol -= c.egRate;
          if (c.egVol <= c.egTarget) { c.egVol = c.egTarget; c.egState = EG_DECAY2; c.egRate = this._egStep(c.d2r, c, true); }
          break;
        case EG_DECAY2:
        case EG_RELEASE:
          c.egVol -= c.egRate;
          if (c.egVol <= 0) { c.egVol = 0; c.playing = false; c.egState = EG_OFF; }
          break;
      }
    }
    // 線形インデックス→ゲイン(0〜-96dB指数変換)
    _egGain(c) {
      if (c.egVol >= EG_MAX) return 1;
      if (c.egVol <= 0) return 0;
      return Math.pow(10, -(EG_MAX - c.egVol) * DB_RANGE / EG_MAX / 20);
    }

    _calcSample() {
      let l = 0, r = 0;
      if (this.rom) {
        for (let i = 0; i < NUM_CH; i++) {
          const c = this.ch[i];
          if (!c.playing) continue;
          // 位置進行。★loopオフセット0は「ループ」ではなく**ワンショット=終端で停止**
          // (OutRunners「Mega Driver」9秒のギターベンドで発覚: loop0のまま先頭へ巻き戻すと
          // 「切れてまた頭から再生」になる。実測: loop0ノートの中央値はキーオフが終端の
          // 少し前(p50 -0.1〜0秒)=ドライバはワンショット自然終了前提で、終端後キーオフも
          // 9%あるが実盤FLACにリスタート音は無い)。loop>0のみ末尾ループ。
          c.frac += c.step;
          const adv = c.frac | 0;
          if (adv) {
            c.frac -= adv;
            c.pos += adv;
            if (c.pos >= c.end) {
              if (!c.loop) { c.playing = false; c.egState = EG_OFF; continue; }
              while (c.pos >= c.end) c.pos -= c.end - c.loop;
            }
          }
          this._egAdvance(c);
          if (!c.playing) continue;
          // TL補間(MAME: 減衰減少=音量上げは78.2ms/フルレンジ、増加=下げは156.4ms)
          if (c.tlIdx !== c.tlDestIdx) {
            if (c.tlIdx > c.tlDestIdx) {
              c.tlIdx = Math.max(c.tlDestIdx, c.tlIdx - 128 / (0.0782 * this.sampleRate));
            } else {
              c.tlIdx = Math.min(c.tlDestIdx, c.tlIdx + 128 / (0.1564 * this.sampleRate));
            }
          }
          if (this.mute[i]) continue;
          const s0 = ((this._read(c.start + c.pos) << 24) >> 24);
          const s1 = ((this._read(c.start + (c.pos + 1 >= c.end ? c.loop : c.pos + 1)) << 24) >> 24);
          const s = (s0 + (s1 - s0) * c.frac) * 256; // 線形補間(MAME準拠)
          const g = this._egGain(c) * Math.pow(10, -c.tlIdx * 0.375 / 20) * this.vol[i];
          // パン: 0=中央、1-7=右寄せ(左を3dB/段減衰)、9-15=左寄せ、8=両ミュート相当
          const p = c.pan >= 8 ? c.pan - 16 : c.pan;
          const attL = p > 0 ? Math.pow(10, -p * 3 / 20) : (p === -8 ? 0 : 1);
          const attR = p < 0 ? Math.pow(10, p * 3 / 20) : 1;
          l += s * g * attL;
          r += s * g * attR;
        }
      }
      // 1chフルスケール≒32767。28ch合算を±1.0程度へ(実曲の同時発音を考慮した経験値)
      this.lastL = l / (32768 * 3);
      this.lastR = r / (32768 * 3);
    }

    clock() {
      if (++this.cyc < this.cyclesPerSample) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }

    /** 再生レート(1秒あたりのサンプルバイト数) */
    playRate(i) { return this.ch[i].step * this.sampleRate; }

    /** サンプル(物理[start,end)、ループ点=startからのオフセットloopOff)の基本周期解析
     *  (キャッシュ)。他チップと同じ(kind,start,end)署名=手動キャリブレーション互換。
     *  全サンプルループなので detectCps 失敗時は loopCps(ループ因数分解)へ。 */
    samplePitch(kind, start, end, loopOff) {
      if (start === undefined || end === undefined || !(end > start) || !this.rom) return null;
      const key = start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const len = end - start;
      const pcm = this._decodeSample(start, end);
      let auto = U.detectCps(pcm);
      let wavePcm = pcm;
      if (auto.conf < 0.5 && loopOff > 0 && loopOff < len && (len - loopOff) >= 16 && (len - loopOff) <= 16384) {
        const one = this._decodeSample(start + loopOff, end);
        const r2 = U.loopCps(one);
        if (r2) { auto = r2; wavePcm = one; }
      }
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false, wave: null,
        lenBytes: pcm.length,
        hash: U.sampleHash(this.rom, start, Math.min(end, start + 64 * 1024)) };
      const t = U.getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      r.wave = U.makeSampleWave(wavePcm, r.conf >= 0.5 ? r.cps : 0);
      // 打楽器/音階の手動上書きをconfへ反映(Emu.SamplePitchUtil。ロール/鍵盤/変換の
      // 4箇所がこの1点で追随する)。キャッシュへ入れる前に適用する
      Emu.SamplePitchUtil.applyKindOverride(r);
      this._pitchCache.set(key, r);
      return r;
    }
    _decodeSample(start, end) {
      const rom = this.rom;
      const n = Math.max(0, Math.min(end - start, 64 * 1024, rom.length - start));
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = ((rom[start + i] << 24) >> 24) / 128;
      return pcm;
    }

    /**
     * スナップショットの sample({kind,start,end}) → デコード済みPCM(Float32Array、-1..1)。
     * vgm2mmlのドラム→@DPCM変換が実サンプルを必要とするための公開口。
     * ROMはこのチップ(=キャプチャWorker側)にしか無く、関数はpostMessageを越えられないので、
     * キャプチャの最後にここを呼んで実データだけをメインスレッドへ渡す
     * (src/emulator/vgmPlayer.js の collectUsedSamples 参照)。
     */
    /**
     * 打楽器/音階の手動上書き。kind: 'drum' | 'pitch' | null(=自動へ戻す)。
     * ピッチ解析の信頼度(conf)による自動判定が外れた曲を、ユーザーが耳で直すための口。
     * 指定はサンプル内容のハッシュをキーに localStorage へ入る(setSampleTuningと同じ流儀。
     * ROMアドレスと違い、同じ音なら別のゲーム/リビジョンでも効く)。
     * ★confへの反映は Emu.SamplePitchUtil.applyKindOverride が samplePitch() の中で行うので、
     *   ロールのドラム区画・鍵盤のnote列・vgm2mmlのドラムパート・DPCM変換が自動的に追随する。
     */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const r = this.samplePitch(sample.kind, sample.start, sample.end);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      // 「音階として扱う」を選んでも、周期がまったく検出できていない(cps=0)サンプルは
      // 使える音程が無い。呼び出し側へ知らせて基準音の手動補正を促す(黙って無視しない)
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._pitchCache.delete(sample.start + ':' + sample.end); // 次回参照で上書きを反映し直す
      return { kind: kind || null, needsTuning: needsTuning };
    }

    samplePcm(sample) {
      if (!sample) return null;
      return this._decodeSample(sample.start, sample.end);
    }

    /** 手動ピッチ補正(表示専用)。他チップと同じlocalStorage永続化。 */
    setSampleTuning(kind, start, end, cps) {
      const r = this.samplePitch(kind, start, end);
      if (!r) return null;
      const U = Emu.SamplePitchUtil;
      const map = U.getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; r.cps = cps; r.conf = 1; r.manual = true; }
      else { delete map[r.hash]; r.cps = r.cpsAuto; r.conf = r.confAuto; r.manual = false; }
      U.saveTuningMap(map);
      r.wave = U.makeSampleWave(this._decodeSample(start, end), r.conf >= 0.5 ? r.cps : 0);
      return r;
    }
  }

  // 鍵盤表示用スナップショット(配列28要素、C352/QSoundと同じ3段階表示向け):
  // { active, vol(EG×TL)、rawVol、panL/panR(0-15)、rate、seq、loop(常にtrue=Infinity側は
  //   lenSecEstで判定)、lenSec(EG見積り)、pitchHz、pitchConf、pitchManual、waveData、sample }
  Emu.snapshotMultiPCM = function (chip) {
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.ch[i];
      const rate = chip.playRate(i);
      // ライブはEG実値、regsOnlyキャプチャはEGが回らない(egVol=0のまま)のでTLのみで表示
      // regsOnlyキャプチャ(EGが回らない=egVolが0のまま)はエンベロープ1扱い。
      // ライブは実EGレベルをそのまま使う(★以前は床値0.05を敷いていて、リリース済み/
      // ほぼ無音のスロットまで常時アクティブ=鍵盤の同時発光行が28本に張り付き、
      // 描画負荷で表示/音声が追い付かなくなっていた。OutRunnersで発覚)。
      // TLはランプ途中値でなく目標値(tlDestIdx)を表示する(regsOnlyではランプが
      // 進まないため。78-156msの遷移は表示粒度では無視してよい)。
      const egG = c.egState === EG_ATTACK && c.egVol === 0 ? 1 : chip._egGain(c);
      const tlG = Math.pow(10, -c.tlDestIdx * 0.375 / 20);
      const vol = Math.min(1, (c.playing ? egG : 0) * tlG);
      const p = c.seq ? chip.samplePitch('multipcm', c.physStart, c.physStart + c.smpLen, c.loopOff) : null;
      const pan = c.pan >= 8 ? c.pan - 16 : c.pan;
      // release: キーオフ済みで余韻だけ鳴っている(合成chが同じ音色の次のノートへレーンを譲る目印)
      // ★表示規約(2026-09-17): 音量は**0が最大**のTL実レジスタ(0-127、0.375dB/段)、
      //   パンは符号付きの実レジスタ(-8..+7、中央0。正=右)。バーは従来どおり0-100%。
      out.push({ active: c.playing && vol > 0.01 && rate > 0, release: c.egState === EG_RELEASE, vol, volApparent: vol,
        rawVol: c.tlDestIdx, rawVolMax: 127, volZeroMax: true,
        panReg: pan, panCenter: 0, panDir: 1, panSigned: true,
        rate, seq: c.seq, loop: c.lenSecEst === Infinity, lenSec: c.lenSecEst,
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'multipcm', start: c.physStart, end: c.physStart + c.smpLen } : null });
    }
    return out;
  };

  Emu.MultiPCMAudio = MultiPCMAudio;

  // ───────────────────────────────────────────────────────────────────────
  // チャンネルプール式ドライバの割当逆算(ソフトウェアチャンネル合成)
  //
  // セガ系ドライバはスロットを共有プールとして扱い、ノートオンごとに次の空きスロットへ
  // 巡回割当する(実測: 発音行がPCM1→28へ行進)。物理スロット表示は実機に忠実だが、
  // 1本のメロディが行をまたいで散り、鍵盤/ロール/MML変換の可読性が壊れる。
  // このクラスはスナップショット列(フレーム×スロット)を受け取り、
  // 「音色(サンプル同定)が同じ・時間的に連続・音程が近い」ノートを同じ論理チャンネルへ
  // 束ね直した同型のスナップショット列を返す(=下流の鍵盤/ロール/変換がそのまま使える)。
  //
  // 使い方: フレームごとに step(physSnap) → 論理スナップショット(同じ形の配列)。
  // ライブ(rAF駆動)とキャプチャ(フレーム駆動)の両方から同じ実装を使う。
  // 割当規則(2026-09-14 改訂。PSF babel14 のドライバ内部トラックを正解にした採点で
  //  トラック集中度 18.7%→60% 前後。詳細は tools/headless/pool-regroup-score.js):
  //  1) 発音中のノート(スロットi×キーオン通番seq)は同じ論理レーンに固定
  //  2) 新しいノートは同じ音色(サンプル)のレーンへ(snap.laneKey があればそれ。PSF はドライバ内部の
  //     トラック番号 = psfPlayer.js Emu.probePsfTracksAsync)。空きレーンに加え、リリース中
  //     (snap.release=キーオフ済みで余韻だけ鳴っている)のレーンも奪ってよい
  //     (★これが本命。プール式ドライバは余韻を鳴らしたまま次の音を別ボイスで鳴らすので、
  //     余韻を「発音中」と見ると同じ楽器が毎音別レーンへ散る。MMLは余韻の重なりを書けない)。
  //     候補のうち直近に使ったもの・音程が近いものを優先
  //  3) 同じ音色のレーンが無く、その音色が初登場なら、直近(30ステップ)に空いた音程の近い
  //     レーンを「同じ楽器の別サンプル」とみなして引き継ぐ(音域ごとにサンプルを分ける楽器
  //     =Outfoxiesのコーラス、PS1のVAB等)。引き継いだ音色はそのレーンの音色族に加える
  //  4) 無ければ未使用レーン → 最も昔に空いた別音色のレーン → リリース中の別音色レーン
  //  ★旧版は「空きが無ければ最も昔のレーンを音色に関係なく奪う」+「音色を無視した引き継ぎを
  //   毎回許す」+「余韻も発音中」だったため、24本が埋まった時点で全レーンが音色混在になっていた
  // プール式PCMチップのスロット数(vgmPlayer.js が new Emu.PoolChannelRegrouper(n) に渡す値と同じ)。
  // 画面側で snapshots から logical を作り直すとき(roll-builders.js RollBuild.poolLogical)にも使う
  // ★psx だけ実機ボイス(24)より多い32本: ドライバ内部のトラックで束ねると、トラック数+和音の分で24本を超える
  //   (babel14 で30本。24本に押し込むと別トラックのレーンを使い回してレーン純度が100%→83%に落ちる)。
  //   実機スロット表示のスナップショットは24要素のまま(鍵盤の行数はスナップショットの長さに従う)
  Emu.POOL_CHIP_CHANNELS = { multipcm: 28, segapcm: 16, c140: 24, c352: 32, qsound: 16, psx: 32 };

  Emu.PoolChannelRegrouper = class {
    constructor(numCh) {
      this.numCh = numCh;
      this.lanes = [];
      // fam: このレーンが受け持つ音色キーの集合(規則3で別サンプルを足す)。lastMidi: 最後のノートの音程(音程なしは null)
      for (let i = 0; i < numCh; i++) this.lanes.push({
        fam: null, boundSlot: -1, boundSeq: -1, lastSlot: -1, lastStep: -1e9, lastMidi: null, outSeq: 0 });
      this.stepCount = 0;
      this.seenKeys = new Set();
      this.dropped = new Map(); // スロット → seq(リリース中にレーンを譲ったノート。seq が変わるまで割り当て直さない)
      this._idle = { active: false, vol: 0, rawVol: 0, rawVolMax: 255, panL: 15, panR: 15,
        rate: 0, seq: 0, loop: false, lenSec: 0, pitchHz: 0, pitchConf: 0, pitchManual: false,
        waveData: null, sample: null };
    }
    step(snap) {
      const st = ++this.stepCount;
      const lanes = this.lanes;
      const out = new Array(this.numCh);
      const slotLane = new Array(snap.length).fill(-1);
      // 1) 既存バインドの継続判定
      for (let li = 0; li < lanes.length; li++) {
        const L = lanes[li];
        if (L.boundSlot < 0) continue;
        const c = snap[L.boundSlot];
        if (c && c.active && c.seq === L.boundSeq) {
          slotLane[L.boundSlot] = li;
        } else {
          L.lastStep = st;
          L.boundSlot = -1; L.boundSeq = -1;
        }
      }
      const releasing = (L) => L.boundSlot >= 0 && !!snap[L.boundSlot].release;
      // 2) 新規ノートの割当(スロット順)
      for (let s = 0; s < snap.length; s++) {
        const c = snap[s];
        if (!c || !c.active || slotLane[s] >= 0) continue;
        if (this.dropped.get(s) === c.seq) continue;
        // laneKey: ドライバ内部のトラックが分かっているチップ(PSF)はトラック単位で束ねる(音色より確か)
        const key = c.laneKey || (c.sample ? (c.sample.start + ':' + c.sample.end) : (c.noise ? 'noise' : 'x'));
        const midi = c.pitchHz > 0 ? 69 + 12 * Math.log2(c.pitchHz / 440) : null;
        let best = -1, bestCost = Infinity, joinFam = false;
        for (let li = 0; li < lanes.length; li++) {
          const L = lanes[li];
          if (!L.fam || !L.fam.has(key)) continue;
          const rel = releasing(L);
          if (L.boundSlot >= 0 && !rel) continue; // 鳴っている最中のレーンは奪わない
          // 直近に使ったほど・音程が近いほど低コスト。同じ物理ボイスの続きは優先(ボイス固定のドライバで
          // パートが入れ替わらないように)。リリース中のレーンは空きレーンが1本も無いときだけ
          // (★空きより先に奪うと、ボイス固定の曲で別パートの余韻を奪ってパートが混ざる。Capcom Generation で実測)
          const age = L.boundSlot >= 0 ? 0 : st - L.lastStep;
          const d = (midi !== null && L.lastMidi !== null) ? Math.abs(midi - L.lastMidi) : 0;
          const cost = age * 0.2 + d * 0.1 + (L.lastSlot === s ? -2 : 0) + (rel ? 1e6 : 0);
          if (cost < bestCost) { bestCost = cost; best = li; }
        }
        // 3) 初登場の音色は、直近に空いた音程の近いレーンの「別サンプル」とみなす
        //    (音程なしノート=ドラムは対象外なので、ドラムがメロディレーンへ混ざることはない)
        if (best < 0 && midi !== null && !c.laneKey && !this.seenKeys.has(key)) {
          for (let li = 0; li < lanes.length; li++) {
            const L = lanes[li];
            if (L.boundSlot >= 0 || !L.fam || L.lastMidi === null) continue;
            const age = st - L.lastStep, d = Math.abs(midi - L.lastMidi);
            if (age > 30 || d > 7) continue;
            const cost = age * 0.1 + d;
            if (cost < bestCost) { bestCost = cost; best = li; joinFam = true; }
          }
        }
        // 4) 未使用 → 最も昔に空いた別音色 → リリース中の別音色
        if (best < 0) best = lanes.findIndex(L => !L.fam);
        if (best < 0) {
          let oldest = Infinity;
          for (let li = 0; li < lanes.length; li++) if (lanes[li].boundSlot < 0 && lanes[li].lastStep < oldest) { oldest = lanes[li].lastStep; best = li; }
        }
        if (best < 0) best = lanes.findIndex(releasing);
        this.seenKeys.add(key);
        if (best < 0) continue; // 全レーンが鳴っている最中(次のフレームでまた探す)
        const L = lanes[best];
        if (L.boundSlot >= 0) { this.dropped.set(L.boundSlot, L.boundSeq); slotLane[L.boundSlot] = -1; }
        if (joinFam) L.fam.add(key);
        else if (!L.fam || !L.fam.has(key)) L.fam = new Set([key]);
        L.boundSlot = s; L.boundSeq = c.seq; L.lastSlot = s;
        if (midi !== null) L.lastMidi = midi;
        L.outSeq++;
        slotLane[s] = best;
      }
      // 出力(論理seq=レーン内通番。ロールのリトリガー検出が正しく効くように)
      for (let li = 0; li < lanes.length; li++) {
        const L = lanes[li];
        if (L.boundSlot >= 0) {
          const c = snap[L.boundSlot];
          out[li] = Object.assign({}, c, { seq: L.outSeq });
        } else {
          out[li] = Object.assign({}, this._idle, { seq: L.outSeq });
        }
      }
      return out;
    }
  };
})(globalThis);

/*
 * PSF(PS1 SPU)のサンプル解析と、鍵盤/ロール/変換向けスナップショット
 * MML.Emu.PsxSampleBank / MML.Emu.snapshotPsx
 *
 * PSF は VGM の PCM チップ(C352/C140 等)と同じ「サンプル再生の音源」なので、
 * 鍵盤表示・ピアノロール・ドラムパッド・MML 変換は VGM の PCM チップ経路をそのまま使う。
 * そのために、キャプチャのフレームスナップショット(psfPlayer.js takeSnapshot の Int32Array)を
 * Emu.snapshotC352 と同じ形のオブジェクト配列(24要素)へ変換する。
 *   { active, vol(0-1), rawVol, rawVolMax, panL, panR(0-15), rate(原サンプル/秒), seq(キーオン通番),
 *     loop, lenSec, pitchHz, pitchConf, pitchManual, sampleKind, sampleHash, waveData,
 *     sample:{kind:'psx', start, end, id}, noise }
 *
 * サンプルの基本周期は Emu.SamplePitchUtil(ym2610.js)で解析し、手動キャリブレーション/
 * 打楽器・音階の上書き(localStorage、サンプル内容ハッシュがキー)も他チップと共有する。
 * ハッシュは SamplePitchUtil.sampleHash を SPU-ADPCM の生バイト列に掛けたもの
 * (ROM を持つチップが ROM の生バイトに掛けるのと同じ考え方)。
 *
 * ★既知の割り切り:
 *  - ピッチ変調(PMON)中のボイスは変調前のピッチレジスタで表示/変換する。
 *  - 同じ SPU RAM 番地へ別内容のサンプルが再転送された場合、sample.start/end(番地)が同じなので
 *    ドラムパッドのキー('psx:<start>')は同じになる(解析とハッシュは内容ごとに別)。
 *
 * DOM 非依存(INV-4)。キャプチャ Worker のロール構築でも使う。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_VOICES = 24;
  const SPU_RATE = 44100;

  class PsxSampleBank {
    /** @param {Array} samples cap.samples(Worker から伸びていく同じ配列でもよい) */
    constructor(samples) {
      this.samples = samples || [];
      this._pitchCache = new Map();   // id → 解析結果
    }

    /** start/end(番地)から一番新しいサンプル番号を引く(手動操作の口は番地しか持たないため) */
    _idOf(start, end) {
      for (let i = this.samples.length - 1; i >= 0; i--) {
        const s = this.samples[i];
        if (s && s.addr === start && s.addr + s.blocks * 16 === end) return i;
      }
      return -1;
    }

    _pcmFloat(s, from, to) {
      const src = s.pcm;
      const a = Math.max(0, from || 0), b = Math.min(src.length, to === undefined ? src.length : to);
      const out = new Float32Array(Math.max(0, b - a));
      for (let i = 0; i < out.length; i++) out[i] = src[a + i] / 32768;
      return out;
    }

    /**
     * サンプルの基本周期(cps=原サンプル1個あたりの周期数)。c352.js samplePitch と同じ設計:
     * 失敗時はループ区間をタイル状に並べて再解析する(短い単一周期ループのシンセ波形対策)。
     * 引数は他チップと同じ(kind, start, end)。id を直接渡してもよい(4番目)。
     */
    samplePitch(kind, start, end, id) {
      if (id === undefined || id < 0) id = this._idOf(start, end);
      const s = this.samples[id];
      if (!s || !s.pcm || !s.pcm.length) return null;
      let r = this._pitchCache.get(id);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const pcm = this._pcmFloat(s);
      let auto = U.detectCps(pcm);
      let wavePcm = pcm;
      if (auto.conf < 0.5 && s.looped && s.loopStart != null && s.loopStart < s.pcm.length) {
        const one = this._pcmFloat(s, s.loopStart);
        if (one.length >= 2 && one.length <= 8192) {
          const reps = Math.max(2, Math.ceil(4096 / one.length));
          const tiled = new Float32Array(one.length * reps);
          for (let k = 0; k < reps; k++) tiled.set(one, k * one.length);
          const a2 = U.detectCps(tiled);
          if (a2.conf >= 0.5) { auto = a2; wavePcm = tiled; }
        }
      }
      const bytes = s.bytes || new Uint8Array(0);
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false,
        hash: U.sampleHash(bytes, 0, bytes.length), wave: null, lenBytes: s.pcm.length };
      const t = U.getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      r.wave = U.makeSampleWave(wavePcm, r.conf >= 0.5 ? r.cps : 0);
      U.applyKindOverride(r);
      this._pitchCache.set(id, r);
      return r;
    }

    /** スナップショットの sample → デコード済み PCM(Float32Array、-1..1)。DPCM 変換用 */
    samplePcm(sample) {
      if (!sample) return null;
      const id = sample.id !== undefined ? sample.id : this._idOf(sample.start, sample.end);
      const s = this.samples[id];
      return s ? this._pcmFloat(s) : null;
    }

    /** 打楽器/音階の手動上書き(c352.js setSampleKind と同じ契約) */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const id = sample.id !== undefined ? sample.id : this._idOf(sample.start, sample.end);
      const r = this.samplePitch(sample.kind, sample.start, sample.end, id);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._clearByHash(r.hash);
      return { kind: kind || null, needsTuning };
    }

    /** 手動ピッチ補正(c352.js setSampleTuning と同じ localStorage 永続化) */
    setSampleTuning(kind, start, end, cps) {
      const id = this._idOf(start, end);
      const r = this.samplePitch(kind, start, end, id);
      if (!r) return null;
      const U = Emu.SamplePitchUtil;
      const map = U.getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; } else { delete map[r.hash]; }
      U.saveTuningMap(map);
      this._clearByHash(r.hash);
      return this.samplePitch(kind, start, end, id);
    }

    /** 同じ内容(ハッシュ)のサンプルの解析結果を全部捨てる(上書き設定を反映し直す) */
    _clearByHash(hash) {
      for (const [id, r] of this._pitchCache) if (r.hash === hash) this._pitchCache.delete(id);
    }
  }

  /**
   * psfPlayer.js takeSnapshot の Int32Array → snapshotC352 と同じ形の配列(24要素)
   * @param {Int32Array} snap
   * @param {PsxSampleBank} bank
   */
  Emu.snapshotPsx = function (snap, bank) {
    const S = Emu.PSF_SNAP;
    const F = S.VOICE_FIELDS;
    const out = new Array(NUM_VOICES);
    for (let i = 0; i < NUM_VOICES; i++) {
      const o = i * F;
      const phase = snap[o + S.PHASE];
      const level = snap[o + S.LEVEL];
      const pitch = Math.min(0x4000, snap[o + S.PITCH]);
      // ★L/R列は VOLL/VOLR の**生レジスタ(16bit符号付き、-0x8000..0x7FFF)**をそのまま出す
      //   (2026-09-17、ユーザー合意)。これはパンではなく「左右それぞれの音量」で、
      //   0=その側が無音・負=逆相。abs()して0-15へ潰すと逆相が見えなくなる。
      const volLReg = snap[o + S.VOLL], volRReg = snap[o + S.VOLR];
      const volL = Math.abs(volLReg) / 0x7FFF, volR = Math.abs(volRReg) / 0x7FFF;
      const env = level / 0x7FFF;
      const vol = Math.min(1, env * Math.max(volL, volR));
      const rate = SPU_RATE * pitch / 0x1000;
      const noise = !!(snap[o + S.FLAGS] & 1);
      const seq = snap[o + S.SERIAL];
      const id = snap[o + S.SAMPLE];
      const s = (id >= 0 && bank) ? bank.samples[id] : null;
      const p = (s && !noise && seq) ? bank.samplePitch('psx', s.addr, s.addr + s.blocks * 16, id) : null;
      const loop = !!(s && s.looped);
      // ドライバ内部のトラック番号(psfPlayer.js Emu.probePsfTracksAsync。見つからない曲/古いキャプチャは -1)
      const track = S.TRACK !== undefined ? snap[o + S.TRACK] : -1;
      out[i] = {
        // 実際に聞こえているボイスだけ(ドライバの初期化で音量0のまま鳴らし続けるダミーを除く。C352 の vmax>0 と同じ)
        active: phase !== 0 && vol > 0 && (noise || rate > 0),
        // キーオフ済みで余韻だけ鳴っている(ADSR のリリース段。合成chが同じ音色の次のノートへレーンを譲る目印)
        release: phase === 4,
        // 合成ch(Emu.PoolChannelRegrouper)がサンプルの代わりに束ねる鍵。トラックが分かればトラック単位
        track, laneKey: (track >= 0 && seq) ? 'trk:' + track : null,
        // vol は**変換が attDb へ戻す線形振幅**なので意味を変えない(borrow.js VOL_FROM_DB)。
        // 表示は別立て: 数値(rawVol)= ADSR の現在値そのもの、バー(volApparent)= その比。
        // L/R音量はL/R列に実値で出るので、バーには混ぜない(RF5C164 を ENV だけにしたのと同じ扱い)。
        vol, rawVol: level, rawVolMax: 0x7FFF, volApparent: env,
        panL: volLReg, panR: volRReg, lrWide: true,
        rate, seq, loop,
        lenSec: loop ? Infinity : (rate > 0 && s ? s.pcm.length / rate : 0),
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual),
        sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: (s && !noise && seq) ? { kind: 'psx', start: s.addr, end: s.addr + s.blocks * 16, id } : null,
        noise,
        slot: i, // 物理ボイス番号(合成ch/トラックのレーンへ移しても残る。レーン単位ミュートが使う)
      };
    }
    return out;
  };

  // ── トラックモード(ドライバ内部トラック × 声部のレーン) ────────────────────
  // 合成ch(Emu.PoolChannelRegrouper)は「空いているレーンの使い回し」なので、和音を弾くトラックの声部が
  // 別トラックと並んだ無関係な番号のレーンへ散り、MML の枠もレーン単位で選ばれて和音が歯抜けになる
  // (babel14: 5声のトラックが V21,V22,V25,V26,V27 に散ってまるごと落ちた)。
  // ここではレーンを「トラック(snap.track。psfPlayer.js Emu.probePsfTracksAsync)× 声部」で作る:
  //  - 同じフレームに始まった同じトラックの音は、高い音から順に空いている声部の若い番号へ
  //  - 途中から入る音は、空いている声部のうち直前の音程が近いものへ
  //  - 空き = 何も鳴らしていない、またはリリース中(余韻は次の音に譲る。合成chと同じ理由)
  //  - 空きが無ければそのトラックの声部を1本増やす(=レーンを末尾に足す)
  // トラック不明の音(推定できなかった曲、効果音)はサンプルごとの疑似トラックとして同じ規則で束ねる。
  // レーンは追記のみ(番号が途中で変わらない)なので、キャプチャ途中から少しずつ作っても、変換で作り直しても
  // 同じ番号になる(鍵盤の行ID PX<n> と変換のソースID psx:<n-1> が対応し続ける)。
  // 出力: step(snap) → レーン配列(その時点のレーン数ぶん)。各要素はそのボイスのスナップショットの写し
  //   (seq はレーン内通番)か空き。どちらにも lane(this.lanes の要素: {index, group, track, voice, label情報})を付ける。
  class PsfTrackVoicer {
    constructor() {
      this.lanes = [];            // {index, group, track, voice, groupIndex}(追記のみ)
      this._state = [];           // レーン番号 → {slot, seq, outSeq, lastMidi}
      this._groups = new Map();   // group → [レーン番号...](声部順)
      this._groupOrder = [];      // group の出現順(トラック不明の疑似トラックの番号づけ)
      this._dropped = new Map();  // 物理ボイス → seq(余韻を譲ったノート。seq が変わるまで拾い直さない)
      this._idle = [];            // レーン番号 → 空きの出力オブジェクト(毎フレーム作らない)
    }
    _addLane(group, track) {
      const li = this.lanes.length;
      let list = this._groups.get(group);
      if (!list) { list = []; this._groups.set(group, list); this._groupOrder.push(group); }
      const lane = { index: li, group, track, voice: list.length, groupIndex: this._groupOrder.indexOf(group) };
      list.push(li);
      this.lanes.push(lane);
      this._state.push({ slot: -1, seq: -1, outSeq: 0, lastMidi: null });
      // ★空きレーンも**鳴っているレーンと同じ表示規約**にそろえる(2026-09-17)。
      //   rawVolMax=255 / panL=panR=15 は旧規約(0-15のパン)の名残で、L/R に VOLL/VOLR の
      //   実レジスタを出すようにした今は「出力があるレーン」に見えてしまう。
      this._idle.push({ active: false, vol: 0, volApparent: 0, rawVol: 0, rawVolMax: 0x7FFF,
        panL: 0, panR: 0, lrWide: true, rate: 0, seq: 0,
        loop: false, lenSec: 0, pitchHz: 0, pitchConf: 0, pitchManual: false, waveData: null, sample: null, slot: -1, lane });
      return li;
    }
    step(snap) {
      const st = this._state;
      const slotLane = new Array(snap.length).fill(-1);
      // 1) 続いているノート
      for (let li = 0; li < st.length; li++) {
        const s = st[li];
        if (s.slot < 0) continue;
        const c = snap[s.slot];
        if (c && c.active && c.seq === s.seq) slotLane[s.slot] = li;
        else { s.slot = -1; s.seq = -1; }
      }
      // 2) 新しいノートをトラックごとに集める
      const fresh = new Map(); // group → [{s, c, midi}]
      for (let s = 0; s < snap.length; s++) {
        const c = snap[s];
        if (!c || !c.active || slotLane[s] >= 0) continue;
        if (this._dropped.get(s) === c.seq) continue;
        const group = c.track >= 0 ? 't' + c.track : 's' + (c.sample ? c.sample.start : (c.noise ? 'n' : 'x'));
        const midi = c.pitchHz > 0 ? 69 + 12 * Math.log2(c.pitchHz / 440) : null;
        if (!fresh.has(group)) fresh.set(group, []);
        fresh.get(group).push({ s, c, midi });
      }
      for (const [group, notes] of fresh) {
        const track = notes[0].c.track >= 0 ? notes[0].c.track : -1;
        if (!this._groups.has(group)) this._addLane(group, track);
        notes.sort((a, b) => (b.midi === null ? -1e9 : b.midi) - (a.midi === null ? -1e9 : a.midi) || a.s - b.s);
        const chord = notes.length > 1;
        for (const n of notes) {
          const list = this._groups.get(group);
          let best = -1, bestCost = Infinity;
          for (const li of list) {
            const s = st[li];
            const releasing = s.slot >= 0 && snap[s.slot] && snap[s.slot].release;
            if (s.slot >= 0 && !releasing) continue;
            // 和音: 若い声部から(高い音から順に来るので、上の声が若い番号にそろう)
            // 単音: 直前の音程が近い声部。余韻を奪うより空きを優先
            const d = (n.midi !== null && s.lastMidi !== null) ? Math.abs(n.midi - s.lastMidi) : 0;
            const cost = (chord ? li * 0.001 : d + li * 0.001) + (releasing ? 0.5 : 0);
            if (cost < bestCost) { bestCost = cost; best = li; }
          }
          if (best < 0) best = this._addLane(group, track);
          const s = st[best];
          if (s.slot >= 0) { this._dropped.set(s.slot, s.seq); slotLane[s.slot] = -1; }
          s.slot = n.s; s.seq = n.c.seq; s.outSeq++;
          if (n.midi !== null) s.lastMidi = n.midi;
          slotLane[n.s] = best;
        }
      }
      // 3) 出力(空きはレーンごとに1個のオブジェクトを使い回す。seq は 0 固定=次の音は必ずリトリガー扱い)
      const out = new Array(st.length);
      for (let li = 0; li < st.length; li++) {
        const s = st[li];
        out[li] = s.slot >= 0 ? Object.assign({}, snap[s.slot], { seq: s.outSeq, lane: this.lanes[li] }) : this._idle[li];
      }
      return out;
    }
    /** その時点までのレーン表(Worker をまたいで運べる素のオブジェクト) */
    laneTable() { return this.lanes.map(l => ({ index: l.index, group: l.group, track: l.track, voice: l.voice, groupIndex: l.groupIndex })); }
  }
  // レーンの表示名(鍵盤の行名・MML ヘッダの元ch名)。voices はそのトラックの声部数
  PsfTrackVoicer.laneName = function (lane, voices) {
    const base = lane.track >= 0 ? 'T' + lane.track : 'S' + lane.groupIndex;
    return voices > 1 ? base + '-' + (lane.voice + 1) : base;
  };
  // lane.copyOf(複製の印、main.js が後から付ける)を付け替えるたびに上げる。鍵盤の行名キャッシュの鍵
  PsfTrackVoicer.copyVersion = 0;
  Emu.PsfTrackVoicer = PsfTrackVoicer;

  Emu.PsxSampleBank = PsxSampleBank;
  Emu.PSX_NUM_VOICES = NUM_VOICES;
})(globalThis);

/*
 * チャンネル別鍵盤表示ウィジェット (ミュート統合版)
 * MML.UI.KeyboardDisplay
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};

  // 表示文言の翻訳(src/i18n/i18n.js)。キーは日本語の原文そのもの
  const T = (key, params) => MML.I18n.t(key, params);

  const CPU_CLOCK = 1789773;
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // canvasはCSSを継承しないので、style.cssの --sans / --mono を実行時に読んでフォント指定に使う。
  // 総称ファミリ(sans-serif/monospace)任せだと日本語フォント未導入の環境で豆腐(□)になり、
  // 中国語ロケールでは漢字が簡体字の字形で描かれる(canvasにはlang属性が効かない)。
  let _fontStacks = null;
  function fontStack(kind) {
    if (!_fontStacks) {
      const cs = getComputedStyle(document.documentElement);
      const pick = (name, fallback) =>
        (cs.getPropertyValue(name) || '').replace(/\s+/g, ' ').trim() || fallback;
      _fontStacks = {
        sans: pick('--sans', 'sans-serif'),
        mono: pick('--mono', 'monospace'),
      };
    }
    return _fontStacks[kind];
  }

  const MIDI_MIN = 24;
  const MIDI_MAX = 108;
  const TOTAL_WHITE = 50;

  // ピアノロールの時間軸スケール(px/秒)。先読み時間幅(秒)は「時間軸の長さ(px)÷この値」で
  // 決まる(=ロールが長いほど遠い未来まで見える)。従来の固定値(高さ320px/4秒)と同じ80px/秒。
  const ROLL_PX_PER_SEC = 80;

  // ピアノロールcanvasの高さ(ロールを一覧の下に置く配置のとき)。style.cssの .kbd-roll { height }
  // と必ず一致させること(折りたたみ時にウィンドウ高さをこの値ぶん増減させるため、
  // ズレると鍵盤の位置がずれる)。
  const ROLL_CANVAS_HEIGHT = 320;
  const MIN_WINDOW_HEIGHT = 160;
  // 鍵盤canvasの「鍵の長さ」方向のpx数(縦向きロール=鍵盤の高さ、横向きロール=鍵盤の幅)。
  // style.cssの .kbd-piano-wrap { height } / .kbd-roll-wrap--horizontal .kbd-piano-wrap { width } と一致させること。
  const PIANO_KEY_LEN = 68;
  // SPCボイス一覧(part/mute/ch/L/R/vol/env/wave/PM/note/freq/echo)の全列が収まる一覧幅。
  // style.cssの .kbd-left.kbd-left--spc { width } と一致させること
  const SPC_LIST_MIN_WIDTH = 512;
  // チャンネル割当の「借用先/音色」列(.kbd-h-assign/.kbd-assign の230px + gap)。
  // style.css の .kbd-left--assign の各幅(=各フォーマットの固定幅+この値)と一致させること
  const ASSIGN_COL_WIDTH = 236;
  // 一覧の固定幅(style.css の .kbd-left / --hes / --gbs / --spc と一致させること)
  const LIST_WIDTH_NSF = 320, LIST_WIDTH_PAN = 370;

  // ── 鍵盤表示レイアウト設定 ────────────────────────────────────
  // rollOrientation: 'vertical'  = Synthesia式(音程=横軸、音符が上から鍵盤へ降る。鍵盤は下)
  //                  'horizontal'= DAW式(音程=縦軸、音符が右から鍵盤へ流れる。鍵盤は左)
  // rollPlacement:   'bottom' = チャンネル一覧の下 / 'right' = 一覧の右 / 'window' = 別ウィンドウ
  // listColumns:     'single' = 1列 / 'auto' = 幅に応じて自動多段
  // rollLanes:       'all' = 全チャンネルを1つの鍵盤/ロールに重ねて表示
  //                  'perChannel' = 使用チャンネルごとに鍵盤+ロールのレーンを並べる(縦向き=横に並ぶ、
  //                                 横向き=縦に積む。各レーンはそのchの音域ぶんの大きさを持ち、
  //                                 収まらない分は .kbd-lanes 全体がスクロールする)
  // fileInfoPlacement: 開いているサウンドファイルのヘッダ情報(=ファイル情報ペイン)の置き場。
  //                  'auto' = 他の置き場に合わせて自動で決める(_effectiveFileInfoPlacement)
  //                  'top' / 'bottom' = チャンネル一覧の上 / 下
  //                  'left' / 'right' = チャンネル一覧の左 / 右
  //                  下配置のとき大波形も一覧の下にある(=一覧が多段)なら、ファイル情報と
  //                  大波形は同じ帯(.kbd-below)に左右で並ぶ(ユーザー指示 2026-09-10)
  // 既定値は従来の見た目(縦・下・1列・まとめて)+ファイル情報は自動。localStorageに永続化する。
  const LAYOUT_STORAGE_KEY = 'mml_keyboardLayout_v1';
  // rollView:        'roll' = ピアノロール(鍵盤の音程軸に音符の棒)
  //                  'score' = 楽譜(音程軸を五線に置き換え、時間軸はロールと同じ実時間比例。MMLの
  //                            コンパイル結果から作る表記モデル(src/score/notation.js)を setScore() で
  //                            受け取ったときだけ有効で、実ファイル再生中はロールに戻る。
  //                            ROADMAP「フェーズ外: 楽譜出力」段階3、2026-09-16)
  const LAYOUT_DEFAULTS = Object.freeze({ rollOrientation: 'vertical', rollPlacement: 'bottom', listColumns: 'single', rollLanes: 'all', fileInfoPlacement: 'auto', rollView: 'roll' });
  const LAYOUT_CHOICES = Object.freeze({
    rollOrientation: ['vertical', 'horizontal'],
    rollPlacement: ['bottom', 'right', 'window'],
    listColumns: ['single', 'auto'],
    rollLanes: ['all', 'perChannel'],
    fileInfoPlacement: ['auto', 'top', 'bottom', 'left', 'right'],
    rollView: ['roll', 'score'],
  });
  // チャンネルごとのレーン: そのchが曲全体で鳴らす音域(+使っているドラムレーン)だけを
  // 音程軸いっぱいに表示する(_updateLaneRanges)。音域はchごとに違うので拡大率もchごとに違い、
  // 音程方向のスクロール/自動追従は無い(白鍵10本の窓を自動スクロールさせる旧方式は、
  // 窓が動くたびに音程の基準が変わって見づらかった)。
  // レーンの大きさ(音程軸方向のpx。縦向き=幅、横向き=高さ)は既定で LANE_PX_PER_WHITE×音域幅、
  // レーンの境目のスプリッターをドラッグすると個別に変えられる(=そのレーンだけ拡大縮小する)。
  // 全レーンの合計が入り切らないぶんは .kbd-lanes が音程軸方向にスクロールする。
  const FILE_INFO_DEFAULT_W = 260; // ファイル情報ペインの既定の幅(左右に並ぶ置き場)
  const FILE_INFO_DEFAULT_H = 120; // ファイル情報ペインの既定の高さ(上下に積む置き場)
  const LANE_PX_PER_WHITE = 15;  // 既定の拡大率(白鍵1本あたりpx)。旧実装の窓(白鍵10本=150px)と同じ
  const LANE_MIN_PX = 40;        // レーンの音程軸方向の最小px(ドラッグの下限)
  const LANE_MIN_WHITE = 7;      // 音域が狭いchでも最低このぶんは見せる(白鍵7本=1オクターブ)
  const LANE_RANGE_PAD = 0.5;    // 音域の両端に足す余白(白鍵)。端の音符が枠に張り付かないように
  const LANE_UNKNOWN_PX = 150;   // 音域が分からないレーン(1音も鳴らないch/先読み未完)の既定の大きさ
  const LANE_LABEL_PX = 14;      // .kbd-lane-labelの高さ。横向きではレーンの大きさに含まれる
                                 // (style.cssの.kbd-lane-labelのheightと一致させること)
  // スポットライト(案D): チャンネル一覧の行にホバー/クリックすると、ロール上でその行の
  // ノートだけを原色・最前面で描き、他chはこの不透明度まで減光する。ミュート(=音も消える)
  // とは別軸の「注目だけ」の仕組みで、PCM多chがドラムを叩いていて音符が重なるときに
  // 「今どの行を見ているか」を切り分けるために使う。
  const SPOTLIGHT_DIM_ALPHA = 0.16;
  // ── ドラム区画(音程ロールと同じcanvasの低音側に置く) ─────────────
  // 打楽器として鳴っているサンプルPCM(pcmSampleRow の drumKey)は音程軸に載せられないので、
  // 音程鍵盤(MIDI_MIN=C1)より低音側に「1レーン=1サンプル」の区画を作ってそこへ置く。
  // 音程軸の単位は白鍵1本ぶん(wk)で、ドラム1レーンは DRUM_LANE_WHITE 本ぶんの幅を持つ
  // (白鍵と同じ幅だとラベルが入らないので少し広くしてある)。ドラムが1つも無い曲では
  // レーン数0=区画の幅0になり、音程軸の座標は従来と完全に一致する。
  // レーン割当そのもの(どのサンプルが何番レーンか・上限・溢れの扱い)は
  // src/convert/drumMap.js に置いてある。vgm2mmlのドラム音符出力と同じ表を使うため。
  /**
   * 音源の識別色 '#rrggbb' → セレクトの候補一覧に敷く薄い背景色。
   * 明度は明暗テーマの両方で文字が読めるよう、下地へ薄く乗せるだけにする。
   */
  function tintOf(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '';
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.18)`;
  }

  const DRUM_LANE_WHITE = 1.5;  // ドラム1レーンの幅(白鍵何本ぶんか)
  // レーンの色 = どの太鼓か。チャンネルの色(=どのスロットが鳴らしたか)とは別軸なので、
  // 打点は「塗り=このレーン色 / 枠線=チャンネル色」の二重符号化で描く。プール式チップ
  // (C140/C352/QSound/MultiPCM)は同じ太鼓が毎回別スロットへ移るため、色をchに割り当てると
  // 太鼓の色が踊ってしまう。塗りをサンプル側に固定するとその問題が出ない。
  const DRUM_LANE_COLORS = ['#e8564a', '#f0a232', '#4a9de8', '#9b6ef3', '#22b3a4', '#d94fa0',
                            '#7a8a99', '#c2a03a', '#5ac47a', '#ff7fa8', '#8ab4ff', '#d0703a',
                            '#59c2c9', '#b06ee0', '#9aa832', '#e06060'];
  const DRUM_OTHER_COLOR = '#8a93a1'; // 「その他」レーン

  // 曲が終わった後の挙動。ヘッダの1つのアイコンをクリックのたびに巡回して選ぶ
  // 複数の元chを1本にまとめて載せられる借用先(重複=競合ではない)。
  // DPCMは「選んだPCMチャンネルの打楽器を、同時発音ぶんはミックスして1本のサンプル列にする」
  // という作りなので、何本選んでもよい
  const MULTI_SOURCE_TARGETS = new Set(['dpcm']);

  const REPEAT_MODES = ['next', 'one', 'shuffle', 'stop'];
  const REPEAT_MODE_KEY = 'mml_repeatMode';
  const REPEAT_ICONS = {
    next: { label: () => T('曲が終わったら: 次の曲へ'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9.5M11.5 4.8 14 7l-2.5 2.2"/><path d="M16 13H6.5M8.5 10.8 6 13l2.5 2.2"/></svg>' },
    one: { label: () => T('曲が終わったら: 同じ曲を繰り返す'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 8.5A4.5 4.5 0 0 1 10 4h5M12.5 1.8 15 4l-2.5 2.2"/><path d="M14.5 11.5A4.5 4.5 0 0 1 10 16H5M7.5 13.8 5 16l2.5 2.2"/><text x="10" y="12.6" font-size="7" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">1</text></svg>' },
    shuffle: { label: () => T('曲が終わったら: ランダム再生'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h3l8 8h3M3 14h3l8-8h3"/><path d="M14.8 3.8 17 6l-2.2 2.2M14.8 11.8 17 14l-2.2 2.2"/></svg>' },
    stop: { label: () => T('曲が終わったら: 停止'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="10" height="10" rx="1.5"/></svg>' },
  };
  function loadLayoutSettings() {
    const out = Object.assign({}, LAYOUT_DEFAULTS);
    try {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(LAYOUT_DEFAULTS)) {
          if (LAYOUT_CHOICES[k].includes(raw[k])) out[k] = raw[k];
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function saveLayoutSettings(s) {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  // ── ロール/鍵盤の座標系 ───────────────────────────────────────
  // ロールと鍵盤は「音程軸(p)」と「時間軸(t)」の2軸で描き、向き(orientation)に応じて
  // canvasのx/yへ写像する。描画ルーチン側は向きを意識せずp/tだけで書けるようにするための抽象。
  //   p: 0(最低音側の端) → pitchLen(最高音側の端)。keyX()と同じ単位(白鍵1本=wk px)
  //   t: 0(現在=鍵盤に接する端) → timeLen(先読みの果て)
  //   vertical  : p→x(左→右)、t→y(下→上)   … 音符が上から降ってくる
  //   horizontal: p→y(下→上)、t→x(左→右)   … 音符が右から流れてくる
  // 縦向きの写像は従来実装と同じ式(H - t)になるよう書いてあり、丸めまで含めて描画結果は不変。
  // visibleWhite: 音程軸に収める白鍵の本数(省略=鍵盤全体TOTAL_WHITE。チャンネルごとのレーンは
  // そのchの音域ぶん=lane.visWhiteで、表示窓の低音側の端(lane.offWhite)は呼び出し側がkeyX()の結果から引く)
  // nDrum: ドラム区画のレーン数(0=区画なし)。音程軸は [ドラム区画][音程鍵盤] の並びで、
  // 全体の長さは (nDrum * DRUM_LANE_WHITE + TOTAL_WHITE) 白鍵ぶん。keyX()が返す音程側の
  // 座標には drumOff(区画の幅px)を足して使う。
  function makeRollGeom(orientation, W, H, visibleWhite, nDrum) {
    const vertical = orientation !== 'horizontal';
    const pitchLen = vertical ? W : H;
    const timeLen = vertical ? H : W;
    const drumUnits = (nDrum || 0) * DRUM_LANE_WHITE;
    const wk = pitchLen / (visibleWhite || (TOTAL_WHITE + drumUnits));
    const bk = Math.max(3, wk * 0.60);
    // 先読み時間幅(秒)と、秒→時間軸pxの変換。時間軸320pxのとき従来通り4秒/80px/秒になる
    const windowSec = timeLen / ROLL_PX_PER_SEC;
    const tPx = (sec) => (sec / windowSec) * timeLen;
    return {
      vertical, W, H, pitchLen, timeLen, wk, bk, windowSec, tPx,
      nDrum: nDrum || 0, drumOff: drumUnits * wk, drumLaneW: DRUM_LANE_WHITE * wk,
      // 音程軸[pLo, pLo+pSize) × 時間軸[tLo, tHi) の矩形をcanvas座標{x,y,w,h}へ。
      // minT: 時間軸方向の最小サイズ(px)。短い音符も見えるように下限を設ける用途
      rect(pLo, pSize, tLo, tHi, minT) {
        if (vertical) {
          const y0 = H - tHi, y1 = H - tLo;
          return { x: pLo, y: y0, w: pSize, h: Math.max(minT || 0, y1 - y0) };
        }
        return { x: tLo, y: H - pLo - pSize, w: Math.max(minT || 0, tHi - tLo), h: pSize };
      },
      // 点(p, t) → canvas座標
      point(p, t) { return vertical ? { x: p, y: H - t } : { x: t, y: H - p }; },
    };
  }

  // ドラム区画のレーン lane の音程軸上の範囲(px)。sub/subN を渡すと、レーンをsubN分割した
  // うちの sub 番目(同時発音の横並び)の範囲を返す。
  // note列クリックで「打楽器/音階の指定」を出す行(サンプルPCM系のチャンネル)。
  // NA/NB=YM2610 ADPCM、GA=GA20、SP=SegaPCM、CN=C140、CS=C352、QS=QSound、
  // OK=OKIM6295、MP=MultiPCM
  const SAMPLE_ROW_RE = /^(N[AB]\d?|GA\d|SP\d+|CN\d+|CS\d+|QS\d+|OK\d|MP\d+)$/;

  function drumLaneX(lane, sub, subN, laneW) {
    const n = Math.max(1, subN || 1);
    const s = Math.min(n - 1, Math.max(0, sub || 0));
    const w = laneW / n;
    return { x: lane * laneW + s * w, size: w };
  }

  const WHITE_IDX = [0,-1,1,-1,2,3,-1,4,-1,5,-1,6];
  const IS_BLACK   = [0, 1,0, 1,0,0, 1,0, 1,0, 1,0];

  // APU パルスのデューティ比 (High 区間の割合): 12.5% / 25% / 50% / 75%
  const APU_DUTY = [0.125, 0.25, 0.5, 0.75];

  // ノイズ周期テーブル（$400E bits0-3 → LFSRシフト間のCPU待機サイクル数, NTSC）
  // ノイズ周波数 = CPU_CLOCK / NOISE_PERIOD[index]（idx0≈447kHz … idx15≈440Hz）
  const NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];

  // GBノイズの実測周波数(c.freq、256通りのclockShift×divisorCode)を、既存の2A03ノイズ
  // 16周期のうち対数距離で最も近いものにマッチさせた素のindex(0-15)に変換する
  // (gbs2mml/expansion/noise.jsのgbNoiseFreqToNote()と同じ考え方だが、MMLノート番号
  // ではなく鍵盤表示のnote列にそのまま出す周期indexが欲しいだけなので31-idxはしない)。
  function gbNoiseFreqToIndex(freqHz) {
    if (!freqHz) return 0;
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < NOISE_PERIOD.length; i++) {
      const diff = Math.abs(Math.log2(freqHz / (CPU_CLOCK / NOISE_PERIOD[i])));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  }

  // DMC(DPCM)レートテーブル（$4010 bits0-3 → サンプル1bitあたりのCPUサイクル数, NTSC）
  // 再生周波数 = CPU_CLOCK / DMC_RATE[index]（idx0≈4182Hz … idx15≈33144Hz）
  const DMC_RATE = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

  // ── チャンネル色のユーザーカスタマイズ ────────────────────────
  // 鍵盤左上のチャンネル一覧の丸(kbd-dot)クリックで選べる色一覧、
  // および localStorage への保存/読込。ロール・鍵盤・波形表示すべてがこの
  // 上書き色を参照するため、変更は即座に全表示へ反映される。
  const CHANNEL_COLOR_STORAGE_KEY = 'mml_channelColors';

  function loadColorOverrides() {
    const map = new Map();
    try {
      const raw = localStorage.getItem(CHANNEL_COLOR_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        for (const id in obj) map.set(id, obj[id]);
      }
    } catch (e) { /* ignore */ }
    return map;
  }

  function saveColorOverrides(map) {
    try {
      const obj = {};
      for (const [id, color] of map) obj[id] = color;
      localStorage.setItem(CHANNEL_COLOR_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  }

  // ── マスター音量 ──────────────────────────────────────────
  // src/audio/stream-player.js MML.Audio.getMasterGain() と同じキー/値域(0〜1)。
  // 音声グラフ側(getMasterGain)も新規AudioContext生成時にこの値を読むため、
  // どちらが先にロードされても一致する。
  const MASTER_VOLUME_STORAGE_KEY = 'mml_masterVolume';
  function loadMasterVolume() {
    try {
      const raw = parseFloat(localStorage.getItem(MASTER_VOLUME_STORAGE_KEY));
      if (Number.isFinite(raw)) return Math.max(0, Math.min(1, raw));
    } catch (e) { /* ignore */ }
    return 1;
  }
  function saveMasterVolume(vol) {
    try { localStorage.setItem(MASTER_VOLUME_STORAGE_KEY, String(vol)); } catch (e) { /* ignore */ }
  }

  // ── ch別音量(通常フォーマット: channelId → 0〜1) ─────────────────
  // 色オーバーライドと同じ流儀(localStorage永続化、新規ファイルを開いても保持=
  // ミュートのようなファイル切替時クリアはしない。音量調整は「一度決めたら
  // ずっと使う」EQ的な設定なので、ファイルをまたいで残ってほしいという想定)。
  const CHANNEL_VOLUME_STORAGE_KEY = 'mml_channelVolumes';
  function loadChannelVolumes() {
    const map = new Map();
    try {
      const raw = localStorage.getItem(CHANNEL_VOLUME_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        for (const id in obj) {
          const v = parseFloat(obj[id]);
          if (Number.isFinite(v)) map.set(id, Math.max(0, Math.min(2, v)));
        }
      }
    } catch (e) { /* ignore */ }
    return map;
  }
  function saveChannelVolumes(map) {
    try {
      const obj = {};
      for (const [id, vol] of map) obj[id] = vol;
      localStorage.setItem(CHANNEL_VOLUME_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  }

  // ── SPCボイス音量(V0〜V7、配列index=ボイス番号) ─────────────────
  const SPC_VOLUME_STORAGE_KEY = 'mml_spcVoiceVolumes';
  function loadSpcVoiceVolumes() {
    try {
      const raw = JSON.parse(localStorage.getItem(SPC_VOLUME_STORAGE_KEY) || 'null');
      if (Array.isArray(raw) && raw.length === 8) {
        return raw.map((v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1; });
      }
    } catch (e) { /* ignore */ }
    return new Array(8).fill(1);
  }
  function saveSpcVoiceVolumes(arr) {
    try { localStorage.setItem(SPC_VOLUME_STORAGE_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
  }

  // ── 静的ミュートパス定義 ──────────────────────────────────────
  const MUTE_INFO_MAP = {
    P1:   { section: 'apu', key: 'pulse1' },
    P2:   { section: 'apu', key: 'pulse2' },
    TR:   { section: 'apu', key: 'triangle' },
    NO:   { section: 'apu', key: 'noise' },
    DM:   { section: 'apu', key: 'dmc' },
    V6P1: { section: 'expansion', chip: 'vrc6', type: 'object', key: 'pulse1' },
    V6P2: { section: 'expansion', chip: 'vrc6', type: 'object', key: 'pulse2' },
    V6SW: { section: 'expansion', chip: 'vrc6', type: 'object', key: 'saw' },
    FDS:  { section: 'expansion', chip: 'fds',  type: 'object', key: 'wave' },
    M5P1: { section: 'expansion', chip: 'mmc5', type: 'object', key: 'pulse1' },
    M5P2: { section: 'expansion', chip: 'mmc5', type: 'object', key: 'pulse2' },
    M5PC: { section: 'expansion', chip: 'mmc5', type: 'object', key: 'pcm' },
    GB1:  { section: 'expansion', chip: 'gb', type: 'object', key: 'ch1' },
    GB2:  { section: 'expansion', chip: 'gb', type: 'object', key: 'ch2' },
    GN:   { section: 'expansion', chip: 'gb', type: 'object', key: 'ch4' },
    GW:   { section: 'expansion', chip: 'gb', type: 'object', key: 'ch3' },
    PSG0: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch0' },
    PSG1: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch1' },
    PSG2: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch2' },
    PSG3: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch3' },
    PSG4: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch4' },
    PSG5: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch5' },
  };

  // リズムchのミュート添字。★2026-08-22: 以前は実チャンネル(BD=6, SD/HH=7, TOM/CYM=8)を
  // そのまま使っていたが、SDとHH(およびTOMとCYM)が同じ添字を共有するため
  // getMuteConfig() が行順に config[index] = muted を書く際に**後の行が前の行を上書き**し、
  // 「SDをミュートしても消えず、鳴っていないHHをミュートすると消える」状態になっていた。
  // OPLLコア(opllNuked.js)は打楽器ごとに出力サイクルを識別できるので、5種に独立した
  // 添字(9-13)を与える。0-8はメロディch用なので衝突しない。
  const KF_RHYTHM_INDEX = { KFBD: 9, KFSD: 10, KFTOM: 11, KFCYM: 12, KFHH: 13 };

  function getMuteInfo(id) {
    if (MUTE_INFO_MAP[id]) return MUTE_INFO_MAP[id];
    const vrc7 = id.match(/^VR(\d+)$/);
    if (vrc7) return { section: 'expansion', chip: 'vrc7', type: 'array', index: +vrc7[1] - 1 };
    // N163: 表示 N{k} はハードウェアch (8-k)。N1=$78(ch7), N8=$40(ch0)。
    // chip.mute[] はハードch索引なので index にハードch番号を返す(表示行→muteの対応を一致させる)。
    const n163 = id.match(/^N(\d+)$/);
    if (n163) return { section: 'expansion', chip: 'n163', type: 'array', index: 8 - (+n163[1]) };
    const fme7 = id.match(/^FE(\d+)$/);
    if (fme7) return { section: 'expansion', chip: 'fme7', type: 'array', index: +fme7[1] - 1 };
    // KSS: PSG(KP1-3)/SCC(KS1-5)/FMPAC(KF1-9、リズムモード中はKFBD/KFSD/KFTOM/KFCYM/KFHH)
    const kp = id.match(/^KP(\d+)$/);
    if (kp) return { section: 'expansion', chip: 'psg', type: 'array', index: +kp[1] - 1 };
    const ks = id.match(/^KS(\d+)$/);
    if (ks) return { section: 'expansion', chip: 'scc', type: 'array', index: +ks[1] - 1 };
    const kf = id.match(/^KF(\d+)$/);
    if (kf) return { section: 'expansion', chip: 'opll', type: 'array', index: +kf[1] - 1 };
    // VGM: SN76489(SN1-3=トーン, SNN=ノイズ)。chip.mute[]はトーン0-2,ノイズ3の4要素
    // VGMのデュアルチップ(2個目)はSN4-6/SNN2=index 4-7(vgmPlayer.js側が2個目のch0-3として読む)
    const sn = id.match(/^SN(\d)$/);
    if (sn) return { section: 'expansion', chip: 'sn76489', type: 'array', index: +sn[1] <= 3 ? +sn[1] - 1 : +sn[1] };
    if (id === 'SNN') return { section: 'expansion', chip: 'sn76489', type: 'array', index: 3 };
    if (id === 'SNN2') return { section: 'expansion', chip: 'sn76489', type: 'array', index: 7 };
    // VGM: YM2612(YM1-6=FM ch、YMDA=DAC)。chip.mute[]はFM 0-5、DAC 6
    const ym = id.match(/^YM(\d)$/);
    if (ym) return { section: 'expansion', chip: 'ym2612', type: 'array', index: +ym[1] - 1 };
    if (id === 'YMDA') return { section: 'expansion', chip: 'ym2612', type: 'array', index: 6 };
    // VGM: YM2151(OPM、OM1-8=FM ch)。chip.mute[]はch 0-7
    const om = id.match(/^OM(\d)$/);
    if (om) return { section: 'expansion', chip: 'ym2151', type: 'array', index: +om[1] - 1 };
    // VGM: YM2203(OPN、OP1-3=FM ch、デュアル2個目はOP4-6=index 3-5。vgmPlayer.js側が
    // 2個目のch0-2として読む)。内蔵SSGはKP1-3(KP4-6)行(chip 'psg')を流用
    const op = id.match(/^OP(\d)$/);
    if (op) return { section: 'expansion', chip: 'ym2203fm', type: 'array', index: +op[1] - 1 };
    // VGM: YM2608(OPNA、OA1-6=FM ch)。内蔵リズム(OABD/OASD/OACY/OAHH/OATM/OARM)と
    // ADPCM-B(OAB)は chip.muteAdpcm[] の 0-5 / 6。内蔵SSGはKP1-3行(chip 'psg')を流用
    const OA_RHYTHM = { OABD: 0, OASD: 1, OACY: 2, OAHH: 3, OATM: 4, OARM: 5, OAB: 6 };
    if (OA_RHYTHM[id] !== undefined) return { section: 'expansion', chip: 'ym2608adpcm', type: 'array', index: OA_RHYTHM[id] };
    const oa = id.match(/^OA(\d)$/);
    if (oa) return { section: 'expansion', chip: 'ym2608fm', type: 'array', index: +oa[1] - 1 };
    // OPL系(KSSのMSX-AUDIO / VGMのYM3812・YM3526・Y8950): OL1-9=メロディch、リズム/ADPCMは
    // chip.mute[]の9-14(Emu.OPL_MUTE: BD=9,SD=10,TOM=11,CYM=12,HH=13,ADPCM=14)
    const OL_FIXED = { OLBD: 9, OLSD: 10, OLTM: 11, OLCY: 12, OLHH: 13, OLB: 14 };
    if (OL_FIXED[id] !== undefined) return { section: 'expansion', chip: 'opl', type: 'array', index: OL_FIXED[id] };
    const ol = id.match(/^OL(\d)$/);
    if (ol) return { section: 'expansion', chip: 'opl', type: 'array', index: +ol[1] - 1 };
    // VGM: GA20(Irem PCM、GA1-4)。chip.mute[]はch 0-3(GALLはGB行なので\dで区別される)
    const ga = id.match(/^GA(\d)$/);
    if (ga) return { section: 'expansion', chip: 'ga20', type: 'array', index: +ga[1] - 1 };
    // VGM: K007232(コナミPCM、K71-K72)。chip.mute[]はch 0-1
    const k7 = id.match(/^K7(\d)$/);
    if (k7) return { section: 'expansion', chip: 'k007232', type: 'array', index: +k7[1] - 1 };
    // VGM: K054539(コナミ8ch PCM、K51-K58)。chip.mute[]はch 0-7
    const k5 = id.match(/^K5(\d+)$/);
    if (k5) return { section: 'expansion', chip: 'k054539', type: 'array', index: +k5[1] - 1 };
    // VGM: MSM5205/6585(PC Engine CD ADPCM等、1ch)。chip.mute[]は1要素
    if (id === 'M5') return { section: 'expansion', chip: 'msm5205', type: 'array', index: 0 };
    // VGM: SegaPCM(SP1-16)。chip.mute[]はch 0-15
    const sp = id.match(/^SP(\d+)$/);
    if (sp) return { section: 'expansion', chip: 'segapcm', type: 'array', index: +sp[1] - 1 };
    // VGM: C140(CN1-24)。chip.mute[]はch 0-23
    const cn = id.match(/^CN(\d+)$/);
    if (cn) return { section: 'expansion', chip: 'c140', type: 'array', index: +cn[1] - 1 };
    // VGM: C352(CS1-32)。chip.mute[]はch 0-31
    const cs = id.match(/^CS(\d+)$/);
    if (cs) return { section: 'expansion', chip: 'c352', type: 'array', index: +cs[1] - 1 };
    // PSF: PlayStation SPU(PX1-24 = ボイス0-23)。PsfReplayStreamPlayer.applyMute の配列 index
    const px = id.match(/^PX(\d+)$/);
    if (px) return { section: 'expansion', chip: 'psx', type: 'array', index: +px[1] - 1 };
    // VGM: OKIM6258(X68000 ADPCM、1ch)。chip.mute[]は1要素
    if (id === 'OKI') return { section: 'expansion', chip: 'okim6258', type: 'array', index: 0 };
    // VGM: QSound(QS1-16)。chip.mute[]はch 0-15
    const qs = id.match(/^QS(\d+)$/);
    if (qs) return { section: 'expansion', chip: 'qsound', type: 'array', index: +qs[1] - 1 };
    // VGM: OKIM6295(OK1-4)。chip.mute[]はch 0-3('OKI'=OKIM6258は上の完全一致で先に拾われる)
    const ok = id.match(/^OK(\d)$/);
    if (ok) return { section: 'expansion', chip: 'okim6295', type: 'array', index: +ok[1] - 1 };
    // VGM: MultiPCM(MP1-28)。chip.mute[]はch 0-27('M5P1'等MMC5とは前方不一致)
    const mp = id.match(/^MP(\d+)$/);
    if (mp) return { section: 'expansion', chip: 'multipcm', type: 'array', index: +mp[1] - 1 };
    // VGM: YM2610(Neo Geo) FM(NF1-4)。内蔵SSGはKP1-3行(chip 'psg')を流用し、vgmPlayer.jsの
    // YM2610アダプタが e.psg を自分のSSGへ適用する
    const nf = id.match(/^NF(\d)$/);
    if (nf) return { section: 'expansion', chip: 'ym2610fm', type: 'array', index: +nf[1] - 1 };
    // YM2610 ADPCM-A(NA1-6)/ADPCM-B(NB)。chip.muteAdpcm[]は A=0-5, B=6
    const na = id.match(/^NA(\d)$/);
    if (na) return { section: 'expansion', chip: 'ym2610adpcm', type: 'array', index: +na[1] - 1 };
    if (id === 'NB') return { section: 'expansion', chip: 'ym2610adpcm', type: 'array', index: 6 };
    // VGM: 32X PWM(PWL/PWR)。chip.mute[]は L=0, R=1
    if (id === 'PWL') return { section: 'expansion', chip: 'pwm', type: 'array', index: 0 };
    if (id === 'PWR') return { section: 'expansion', chip: 'pwm', type: 'array', index: 1 };
    // VGM: RF5C164(メガCD PCM、RC1-8) / RF5C68(RB1-8)
    const rc = id.match(/^RC(\d)$/);
    if (rc) return { section: 'expansion', chip: 'rf5c164', type: 'array', index: +rc[1] - 1 };
    const rb = id.match(/^RB(\d)$/);
    if (rb) return { section: 'expansion', chip: 'rf5c68', type: 'array', index: +rb[1] - 1 };
    if (KF_RHYTHM_INDEX[id] !== undefined) return { section: 'expansion', chip: 'opll', type: 'array', index: KF_RHYTHM_INDEX[id] };
    return null;
  }

  // ── チップ名見出し + 短縮ch名 ──────────────────────────────────
  // ch.id(P1/VR3/N5など内部識別子)はチップごとに命名規則がバラバラで一覧性が
  // 低いため、表示上はチップ名を見出し行として挟み、行側は見出し配下で完結する
  // 短い名前(P1/FM3/W5など)にする。ch.id自体は変更しない(ミュート状態のキー・
  // getPartLetterのパターンマッチ・大波形選択などが全てch.id前提のため)。
  // 完全一致(ids)を先に見て、無ければ前方一致(prefix)にフォールバックする
  // (例: 'NO'は2A03グループの完全一致で先に拾われ、N163のprefix:'N'とは衝突しない)。
  const CHANNEL_DISPLAY_GROUPS = [
    { header: 'RP2A03 (Family Computer / Nintendo Entertainment System)', ids: { P1: 'P1', P2: 'P2', TR: 'Tri', NO: 'No', DM: 'DPCM' } },
    { header: 'RP2C33 (Family Computer Disk System)', ids: { FDS: 'FDS' } },
    { header: 'VRC6 (Virtual Rom Controller 6)', ids: { V6P1: 'P1', V6P2: 'P2', V6SW: 'Saw' } },
    { header: 'VRC7 (Virtual Rom Controller 7)', prefix: 'VR', name: (id) => 'FM' + id.slice(2) },
    { header: 'N163 (Namco 163)', prefix: 'N', name: (id) => 'W' + id.slice(1) },
    { header: 'SUNSOFT5B (FME-7 , YM2149)', ids: { FE1: 'P1', FE2: 'P2', FE3: 'P3' } },
    { header: 'MMC5 (Memory Management Controller 5)', ids: { M5P1: 'P1', M5P2: 'P2', M5PC: 'PCM' } },
    { header: 'YM2149 (Software controlled Sound Generator)', ids: { KP1: 'P1', KP2: 'P2', KP3: 'P3', KP4: 'P1(2)', KP5: 'P2(2)', KP6: 'P3(2)' } },
    { header: 'SCC (Sound Creative Chip)', prefix: 'KS', name: (id) => 'W' + id.slice(2) },
    { header: 'YM2413 (MSX-MUSIC , OPLL)', ids: { KFBD: 'BD', KFSD: 'SD', KFTOM: 'Tom', KFCYM: 'Cym', KFHH: 'HH' }, prefix: 'KF', name: (id) => 'FM' + id.slice(2) },
    { header: 'LR35902 (Game Boy)', ids: { GALL: 'ALL', GB1: 'P1', GB2: 'P2', GN: 'No', GW: 'Wave' } },
    { header: 'HuC6280(PC Engine / TurboGrafx-16)', ids: { HALL: 'ALL', PSG0: 'Ch0', PSG1: 'Ch1', PSG2: 'Ch2', PSG3: 'Ch3', PSG4: 'Ch4', PSG5: 'Ch5' } },
    { header: 'SN76489 (SG-1000 / Master System / Game Gear / Mega Drive PSG)', ids: { SN1: 'P1', SN2: 'P2', SN3: 'P3', SNN: 'No', SN4: 'P1(2)', SN5: 'P2(2)', SN6: 'P3(2)', SNN2: 'No(2)' } },
    { header: 'YM2612 (OPN2 , Mega Drive FM)', ids: { YMDA: 'DAC' }, prefix: 'YM', name: (id) => 'FM' + id.slice(2) },
    { header: 'YM2151 (OPM , X68000 / Arcade)', prefix: 'OM', name: (id) => 'FM' + id.slice(2) },
    // OP4-6はデュアルチップ2個目のFM1-3(内蔵SSGはKP1-6行を流用)
    { header: 'YM2203 (OPN , PC-8801 / Arcade)', prefix: 'OP', name: (id) => { const n = +id.slice(2); return n <= 3 ? 'FM' + n : 'FM' + (n - 3) + '(2)'; } },
    // OABD等=内蔵リズム、OAB=ADPCM-B(完全一致で先に拾う)。内蔵SSGはKP1-3行を流用
    { header: 'YM2608 (OPNA , PC-8801 SB2 / PC-9801)', ids: { OABD: 'BD', OASD: 'SD', OACY: 'Cym', OAHH: 'HH', OATM: 'Tom', OARM: 'Rim', OAB: 'PCMB' },
      prefix: 'OA', name: (id) => 'FM' + id.slice(2) },
    // OPL系(YM3812/YM3526/Y8950): OLBD等=リズムモード打楽器、OLB=Y8950 ADPCM-B
    { header: 'OPL (YM3812 / YM3526 / Y8950 MSX-AUDIO)', ids: { OLBD: 'BD', OLSD: 'SD', OLTM: 'Tom', OLCY: 'Cym', OLHH: 'HH', OLB: 'ADPCM' },
      prefix: 'OL', name: (id) => 'FM' + id.slice(2) },
    // GA1-4は完全一致(ids)で拾う(GBの'GALL'と prefix 'GA' を衝突させない)
    { header: 'GA20 (Irem M92 / M107 PCM)', ids: { GA1: 'PCM1', GA2: 'PCM2', GA3: 'PCM3', GA4: 'PCM4' } },
    // pool: サンプルPCM系はドライバがスロットをペア交互/巡回割当する曲がある
    // (実測: SegaPCM 8-23%移動 / C140 37-100% / C352 74-79% / QSound 8-63% / MultiPCM 100%)。
    // ヘッダに「合成ch/実機スロット」トグルを出し、割当逆算した表示・変換と選べるようにする
    { header: 'SegaPCM (315-5218 , OutRun / After Burner)', prefix: 'SP', name: (id) => 'PCM' + id.slice(2), pool: 'segapcm' },
    { header: 'C140 (Namco System 2 / 21)', prefix: 'CN', name: (id) => 'PCM' + id.slice(2), pool: 'c140' },
    { header: 'C352 (Namco System 11 / 12 / 22)', prefix: 'CS', name: (id) => 'PCM' + id.slice(2), pool: 'c352' },
    { header: 'OKIM6258 (MSM6258 , Sharp X68000)', ids: { OKI: 'ADPCM' } },
    // PSF(PS1): ボイス番号は実機どおり0始まりで表示(PX1=Voice0)。ドライバがボイスを動的に割り当てるので pool
    // poolModes: 表示モード切替の段(既定は2段 logical/phys)。PSF はドライバ内部トラック単位の「トラック」を先頭に足す
    { header: 'SPU (CXD2922 , PlayStation)', prefix: 'PX', name: (id) => 'V' + (+id.slice(2) - 1), pool: 'psx', poolModes: ['track', 'logical', 'phys'] },
    { header: 'QSound (DL-1425 , Capcom CPS2)', prefix: 'QS', name: (id) => 'PCM' + id.slice(2), pool: 'qsound' },
    // ★prefix 'OK' は 'OKI'(OKIM6258)にも前方一致するが、完全一致(ids)が全グループ横断で
    //   先に評価されるので衝突しない(getChannelDisplayの2段ループ参照)
    { header: 'OKIM6295 (MSM6295 , Toaplan / Raizing etc.)', prefix: 'OK', name: (id) => 'ADPCM' + id.slice(2) },
    // pool: チャンネルプール式(ドライバがボイスを巡回割当する)チップの印。ヘッダ行に
    // 「実機スロット/合成ch」の表示モード切替を出す(_rebuildRows参照)
    { header: 'MultiPCM (315-5560 , Sega Model 1 / 2)', prefix: 'MP', name: (id) => 'PCM' + id.slice(2), pool: 'multipcm' },
    // NF1-4は完全一致(ids)で先に拾う(N163のprefix 'N' と衝突させない)
    { header: 'YM2610 (OPNB , Neo Geo)', ids: { NF1: 'FM1', NF2: 'FM2', NF3: 'FM3', NF4: 'FM4', NF5: 'FM5', NF6: 'FM6',
        NA1: 'PCMA1', NA2: 'PCMA2', NA3: 'PCMA3', NA4: 'PCMA4', NA5: 'PCMA5', NA6: 'PCMA6', NB: 'PCMB' } }, // NA=ADPCM-A, NB=ADPCM-B
    { header: 'PWM (Sega 32X)', ids: { PWL: 'L', PWR: 'R' } },
    { header: 'RF5C164 (Mega-CD PCM)', prefix: 'RC', name: (id) => 'PCM' + id.slice(2) },
    { header: 'RF5C68 (PCM)', prefix: 'RB', name: (id) => 'PCM' + id.slice(2) },
  ];
  function getChannelDisplay(id) {
    for (const g of CHANNEL_DISPLAY_GROUPS) {
      if (g.ids && g.ids[id]) return { header: g.header, name: g.ids[id], pool: g.pool };
    }
    for (const g of CHANNEL_DISPLAY_GROUPS) {
      if (g.prefix && id.startsWith(g.prefix)) return { header: g.header, name: g.name(id), pool: g.pool, poolModes: g.poolModes };
    }
    return { header: '', name: id };
  }

  // ── MMLパート文字(A-Z,a,b)の算出 ──────────────────────────────
  // 実際のMML変換(nsf2mml/kss2mml)が振るチャンネル文字を鍵盤表示にも出す。
  // 2A03固定4ch=A-D、DPCM=E(未使用でも常にこのスロット)、拡張音源以降は
  // src/mml/compiler.jsのassignExpansionLettersで機種に関わらず完全固定。
  // GB1/GB2/GNは2A03コア(自チップ、拡張音源宣言不要)を借用するのでA/B/Dに固定
  // (src/gbs2mml/converter.js参照。GBのCH1/CH2/CH4はそのままNESパルス1/2/ノイズへ乗る)。
  // SN76489(VGM)のノイズchも2A03ノイズ(D)へ借用する(vgm2mml、ROADMAP VGM節 段階3)。
  const APU_PART_LETTER = { P1: 'A', P2: 'B', TR: 'C', NO: 'D', DM: 'E', GB1: 'A', GB2: 'B', GN: 'D', SNN: 'D' };

  // chips(内部chip名の配列)をassignExpansionLettersが受け取る拡張音源名に変換する。
  // KSSはPSG→FME-7・SCC→N163・FMPAC→VRC7、GBSは波形ch→FDS(実機較正済みの音量バランスを
  // 持つため、当初のN163から変更した。src/gbs2mml/expansion/wave.js冒頭コメント参照)を
  // 借用して再生するため(src/kss2mml/converter.js・src/gbs2mml/converter.js参照)、
  // レター体系もそれらをそのまま流用する。
  const BORROWED_CHIP_TO_EXPANSION = { kssPsg: 'fme7', kssScc: 'n163', kssOpll: 'vrc7', gbs: 'fds', hes: 'n163', sn76489: 'fme7' };
  function chipsToExpansions(chips) {
    const priority = MML.Mml && MML.Mml.EXPANSION_PRIORITY;
    const set = new Set();
    for (const c of chips) {
      const exp = BORROWED_CHIP_TO_EXPANSION[c] || c;
      if (priority && priority.includes(exp)) set.add(exp);
    }
    return Array.from(set);
  }

  // チャンネル割当(変換元ch → NSF側の借用先パート)の共通モジュール。読み込み順の都合で
  // 未定義でも鍵盤表示は動く(その場合はpart列が従来どおりの固定表示になるだけ)。
  function channelPlan() { return (MML.Convert && MML.Convert.ChannelPlan) || null; }
  // 今の表示元がMML再生か(setSourceInfo経由)。MML側に切り替えている間はチャンネル割当も
  // 「割当先の音で聴く」も意味が無いので、両方まとめて無効にする(ユーザー指定 2026-09-06)。
  // ★ChannelPlan.setFormat は MML では呼ばれず直前のサウンドファイルの形式が残るため、
  //   plan.editable() だけで判定すると MML 再生に割当プレビューのミュートが掛かって無音になる
  //   (実際に起きた: VGMで🎧をONにした後のMML再生が全chミュート)。
  let sourceIsMml = false;
  function assignEditable() {
    const plan = channelPlan();
    return !!plan && plan.editable() && !sourceIsMml;
  }
  function assignLockReason() {
    if (sourceIsMml) return T('MML再生中はチャンネル割当と「割当先の音で聴く」は使えません(サウンドファイルの再生時だけ意味があります)');
    const plan = channelPlan();
    return plan ? (plan.lockReason() || '') : '';
  }

  // part列(丸の隣のパート文字)。クリックで1行ぶんの割当ポップオーバーを開けるチップにする。
  // 割当を変更できないフォーマット(NSF等)では従来どおりただの文字表示のまま。
  function partChipHtml(ch) {
    const editable = assignEditable() && !ch.isAllRow && ch.target !== undefined;
    const cls = 'kbd-part' + (editable ? ' kbd-part--editable' : '');
    return `<span class="${cls}" data-ch="${ch.id || ''}">${ch.letter || (editable ? '—' : '')}</span>`;
  }

  // 見出しの part 列に置くチャンネル割当トグル(案E)。ONで一覧に「借用先/音色」列が生える。
  // 「part」という文字の代わりにアイコンだけを置く(列の意味そのものがボタンになっている)。
  function headerAssignBtnHtml() {
    return `<button type="button" class="kbd-h-part kbd-assign-btn"` +
      ` aria-label="${T('チャンネル割当(変換元ch → NSF側のパート)を表示')}">` +
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 6h5M3 14h5"/><path d="M12 6h5M12 14h5"/><path d="M8 6c2.5 0 1.5 8 4 8"/><path d="M8 14c2.5 0 1.5-8 4-8"/></svg></button>';
  }
  // 見出しの「借用先」列に置く「割当先の音で聴く」トグル(src/audio/assign-preview.js)。
  // ONで元chをミュートし、借用先のNSF音源で鳴らし直す(変換後の音色を再生中に確かめる)。
  function headerPreviewBtnHtml() {
    return `<button type="button" class="kbd-preview-btn" aria-label="${T('割当先の音で聴く')}">\u{1F3A7}</button>`;
  }
  // 試聴ボタンの右に出す、割当表示ONの間だけのモード表示(ユーザー指示 2026-09-12)。
  // 置き場は借用先列(230px)の余白の中なので、列幅も行との縦揃えも変わらない
  function headerAssignModeHtml() {
    return `<span class="kbd-h-assign-mode">${T('チャンネル別割り当てモード')}</span>`;
  }
  // 見出しの mute 列に置く一括ミュートボタン。全chミュートでなければ全ミュート、
  // 全ミュート済みなら全解除(トグル)。
  function headerMuteAllBtnHtml() {
    return `<button type="button" class="kbd-h-mute-solo kbd-muteall-btn" aria-label="${T('全チャンネルをミュート')}">\u{1F507}</button>`;
  }
  // 見出しの vol 列に置く一括音量リセットボタン。押すと全chの音量スライダーを100%へ戻す
  // (行ごとのダブルクリックでの100%復帰と同じ動作を全chまとめて行う)。
  function headerVolResetBtnHtml() {
    return `<button type="button" class="kbd-h-vol kbd-volreset-btn" title="${T('全チャンネルの音量を100%に戻す')}">vol</button>`;
  }

  // 割当表示ONのときだけ現れる「借用先 / 音色」のセレクト2つ(案Eの列展開)
  function assignCellHtml(ch) {
    if (ch.isAllRow) return `<span class="kbd-assign"></span>`;
    return `<span class="kbd-assign">` +
      `<select class="kbd-assign-target"></select>` +
      `<select class="kbd-assign-tone"></select>` +
      // 借用先にDPCMを選んだ行だけ出す「パッド」ボタン(ドラム(DPCM)パネルを開く)。
      // ツールバーではなくここに置く: DPCMを選んだ流れでそのまま詰められるため
      `<button type="button" class="kbd-assign-drum" style="display:none">${T('パッド')}</button>` +
      // 音色が1つしかない借用先(三角波/のこぎり波/FME-7)に出す注記。空欄だと「未設定」に見えるため
      `<i class="kbd-assign-plain" style="display:none"></i>` +
      // 音色一覧(音色ごとの載せ先/音色)を開くボタン。指定がある行は件数を出す(_syncAssignSelects)
      `<button type="button" class="kbd-assign-tones" style="display:none">♪</button>` +
      `</span>`;
  }

  // ch.id → MMLパート文字。letterMapはassignExpansionLettersの戻り値
  // ({ チップ名: [割当文字...] })。該当なし(対応するMML文字を持たないチャンネル、
  // 例: MMC5の$5011直接PCM)は空文字を返す。
  function getPartLetter(id, letterMap, n163NumCh) {
    if (APU_PART_LETTER[id]) return APU_PART_LETTER[id];
    const lm = letterMap || {};
    let m;
    if (id === 'FDS') return (lm.fds || [])[0] || '';
    if ((m = id.match(/^V6(P1|P2|SW)$/))) return (lm.vrc6 || [])[{ P1: 0, P2: 1, SW: 2 }[m[1]]] || '';
    if ((m = id.match(/^M5(P1|P2)$/))) return (lm.mmc5 || [])[{ P1: 0, P2: 1 }[m[1]]] || '';
    if (id === 'M5PC') return ''; // $5011直接PCMはppmckのMML文字を持たない
    if ((m = id.match(/^VR(\d+)$/))) return (lm.vrc7 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^FE(\d+)$/))) return (lm.fme7 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^N(\d+)$/))) {
      // 表示N{k}はハードウェアch(8-k)。MML文字は下位アドレス側(ch0)から順に振られる
      // (src/nsf2mml/expansion/n163.js参照)ため、曲全体の有効ch数numChに対し文字indexはnumCh-k。
      // numChは静的なletterMap.n163.length(常に8)ではなく、実際にこの曲で使われているch数
      // (extractChannelsのnumRows、呼び出し側から渡される)を使う必要がある。
      const letters = lm.n163 || [];
      const numCh = n163NumCh || letters.length || 8;
      return letters[numCh - (+m[1])] || '';
    }
    if ((m = id.match(/^KP(\d+)$/))) return (lm.fme7 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^SN(\d)$/))) return (lm.fme7 || [])[+m[1] - 1] || ''; // SN76489トーン3本→FME7(vgm2mml)
    if ((m = id.match(/^KS(\d+)$/))) return (lm.n163 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^KF(\d+)$/))) return (lm.vrc7 || [])[+m[1] - 1] || '';
    if (id === 'GW') return (lm.fds || [])[0] || ''; // GBの波形chはFDS(1ch)を借用(src/gbs2mml/converter.js参照)
    // HESのPSG ch0-5はN163へ直接(反転無し)の順で借用する(src/hes2mml/converter.js参照。
    // N163実機のアドレッシングに基づく反転(上のKS/N163ケース)とは異なる独自の割当規則)。
    if ((m = id.match(/^PSG(\d)$/))) return (lm.n163 || [])[+m[1]] || '';
    if (KF_RHYTHM_INDEX[id] !== undefined) return (lm.vrc7 || [])[KF_RHYTHM_INDEX[id]] || '';
    return '';
  }

  // ── 周波数 / MIDI 変換 ────────────────────────────────────────

  // 基準ピッチ(#TUNING、セント)。MML再生(setSource の result.tuningCents)と変換結果の音程検証
  // (buildRollTracksFromRegSnapshotsPure の extra.tuningCents)が設定する。実ファイル再生は0
  let rollTuningCents = 0;
  function freqToMidi(f) {
    if (!f || f <= 0) return null;
    const m = Math.round(69 + 12 * Math.log2(f / 440) - rollTuningCents / 100);
    return (m >= MIDI_MIN && m <= MIDI_MAX) ? m : null;
  }

  // ── パン/音量の表示規約(2026-09-17、ユーザー合意) ─────────────────────────
  // 方針: **数値のセルには実レジスタ値を出す**(チップごとにスケールも向きも違ってよい)。
  //       0-100% に揃えるのは音量バー(vol / volApparent)だけで、そこで音源差を吸収する。
  //  ・パン機能を持たないチップ(OPL系/GA20/OKIM6295/MSM5205)は PAN_NONE
  //  ・音量値を持たず L/R でしか音量が決まらないチップ(C140/C352/SegaPCM)は音量列が VOL_NONE
  //  ・中央のあるパンレジスタ(K054539/QSound/MultiPCM)は L セルに生値、R セルに中央基準の位置
  //  ・16bit の値を出すチップ(PSX/QSound)は行の L/R 列を広げる(ch.lrWide)
  const PAN_NONE = '—';
  const VOL_NONE = '—';
  /**
   * 中央のあるパンレジスタの「中央基準の位置」表示。
   * v=中央 → 'C'、左寄り → 'L<n>'、右寄り → 'R<n>'(n は中央からの段数)。
   * dir: +1 なら「値が大きいほど右」、-1 なら「値が大きいほど左」。
   */
  /**
   * スナップショットの表示規約フィールド → 行オブジェクト(2026-09-17)。
   * 個々の push に書き足すと必ずどれか漏れるので、panL/panR を渡す行は全部ここを通す
   * ([[keyboard-live-getter-forwarding-list]] と同じ罠)。
   *  c.panNone      パン機能なし → L/R は '—'
   *  c.volNone      音量値を持たない(L/Rでしか決まらない) → 音量列は '—'
   *  c.panReg       中央のあるパンレジスタ → L に生値、R に中央基準の位置(C/L3/R5)
   *  c.rearL/rearR  C352 のリア出力 → L/R に「前+後」を併記
   *  c.lrWide       16bit の値を出す行 → L/R 列を広げる
   */
  function panVolFields(c) {
    const out = {};
    // ★バーの値(volApparent)もここで渡す。個別の push に書くと必ず渡し忘れる
    //   (K054539 で実際に踏んだ。数値だけ直ってバーが変わらない、という形で出る)
    if (c.volApparent !== undefined) out.volApparent = c.volApparent;
    // 音量の数値とスケールもスナップショット側が正典(行側のハードコードを上書きする)。
    // ★この関数は push の**末尾**で展開されるので、行に書いてある rawVolMax より後勝ちになる
    if (c.rawVolMax !== undefined) { out.rawVol = c.rawVol; out.rawVolMax = c.rawVolMax; }
    if (c.volNone) out.volText = VOL_NONE;
    if (c.volZeroMax) out.volZeroMax = true;
    if (c.volSigned) out.volSigned = true;
    if (c.panNone) { out.panLText = PAN_NONE; out.panRText = PAN_NONE; return out; }
    if (c.panReg !== undefined) {
      // 生値の書式はレジスタの読み方に合わせる(ユーザーが仕様書で見る形):
      //  ・K054539(0x11-0x1f) / QSound(0x110-0x130) は16進
      //  ・MultiPCM(-8..+7、中央0)は符号付き10進
      out.panLText = c.panHex ? c.panReg.toString(16).toUpperCase()
        : (c.panSigned && c.panReg > 0 ? '+' + c.panReg : String(c.panReg));
      out.panRText = panPos(c.panReg, c.panCenter || 0, c.panDir || 1);
      return out;
    }
    out.panL = c.panL; out.panR = c.panR;
    if (c.rearL !== undefined) {
      // フロントとリアを1セルに併記する(前+後)。4値を2列へ収める
      out.panLText = c.panL + '+' + c.rearL;
      out.panRText = c.panR + '+' + c.rearR;
      out.lrWide = true;
    }
    if (c.lrWide) out.lrWide = true;
    return out;
  }
  // FM の音量は音色のキャリアTL(=そのchの音量そのもの)。**0が最大**の実レジスタを出す
  // (2026-09-17のユーザー合意。VRC7/OPLL が元から 0=最大 で出しているのと揃う)。
  //  ・OPN系(YM2612/2151/2203/2608/2610): patch.AL のアルゴリズムでキャリアopが決まる。TLは0-127
  //  ・OPL系(YM3812/3526/Y8950): patch.car.TL(0-63)。cnt=1(加算接続)は mod もキャリア
  // vgm2mml の fmAttDb と同じ取り方(CARRIER_OPS)なので、表示とMMLの音量が同じ根拠になる。
  const FM_CARRIER_OPS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
  function carrierTl(patch) {
    if (!patch) return null;
    if (patch.ops && patch.AL !== undefined) {
      let tl = 127;
      for (const op of FM_CARRIER_OPS[patch.AL & 7]) tl = Math.min(tl, patch.ops[op].TL);
      return { tl, max: 127 };
    }
    if (patch.car && patch.car.TL !== undefined) {
      const tl = patch.cnt === 1 ? Math.min(patch.car.TL, patch.mod ? patch.mod.TL : 63) : patch.car.TL;
      return { tl, max: 63 };
    }
    return null;
  }
  /** FM行の音量列(0=最大のキャリアTL)。patchが無ければ従来どおり0-15の派生値 */
  function fmVolFields(patch, fallbackRaw) {
    const c = carrierTl(patch);
    return c ? { rawVol: c.tl, rawVolMax: c.max, volZeroMax: true }
             : { rawVol: fallbackRaw, rawVolMax: 15 };
  }
  function panPos(v, center, dir) {
    const d = (v - center) * (dir || 1);
    if (d === 0) return 'C';
    return (d > 0 ? 'R' : 'L') + Math.abs(d);
  }
  // ノイズchの周期index(ch.noiseIndex、0〜15。NSF/GBSどちらも同じ2A03の16段階スケールへ
  // 揃えている)を、そのままC1(MIDI 24)〜D#2(MIDI 39)の16音に1:1対応させる(ユーザー指定)。
  function noisePeriodIndexToMidi(idx) {
    if (idx === undefined || idx === null) return null;
    return 24 + Math.max(0, Math.min(15, idx)); // idx0=C1 〜 idx15=D#2
  }

  // DPCM($4010再生速度index、ch.dmcRateIdx、0〜15)もノイズと同じC1〜D#2に1:1対応させる
  // (ユーザー指定: ノイズchとバンドが重なってよい)。
  function dmcRateIndexToMidi(idx) {
    if (idx === undefined || idx === null) return null;
    return 24 + Math.max(0, Math.min(15, idx)); // idx0=C1 〜 idx15=D#2(ノイズと同じ)
  }

  // YM2610 ADPCM-A/B(ch.adpcmPitch、NA/NB行)の音程。
  //  - ch.adpcmExact: ym2610.js のサンプルピッチ解析(ROM上のサンプルをデコードして基本周期を検出)
  //    ×再生レートの実周波数が ch.freq に入っているので通常の freqToMidi。
  //  - それ以外(ADPCM-Bで解析が信頼できない時): Delta-Nは連続値の再生レートだが、実際の音程は
  //    元サンプルの収録内容に依存し絶対音名を保証するレジスタは無い。同チップのADPCM-A固定レート
  //    (refRate=chip.sampleRate/3)を基準ピッチ(C4=MIDI60)とみなしレートの比を半音数へ変換する
  //    (目安。ピッチベンド等の相対的な上下動は正しく追従する)。
  // 解析の信頼度しきい値(pitchConf、0-1: 窓ごとの検出周期が中央値±3%で一致した割合)
  const ADPCM_PITCH_CONF = 0.5;

  // PSF トラックモードのレーン(Emu.PsfTrackVoicer の出力。各要素に lane={index, group, track, voice, groupIndex})の
  // 並び順と行名。ロール構築は全フレームぶん呼ぶので、レーン数とレーン表(最後の lane の同一性)が同じなら使い回す。
  // 並び: トラックの分かった順(トラック番号)→ トラック不明の疑似トラック(出現順)、同じトラック内は声部順
  let psxTrackOrderCache = null;
  function psxTrackOrder(s) {
    const n = s.length, last = s[n - 1].lane;
    // 複製の印(lane.copyOf)は後から付くので、付け替えのたびに上がる版数も鍵に入れる
    // 言語を切り替えたら説明文(title)も作り直す
    const copyKey = ((MML.Emu && MML.Emu.PsfTrackVoicer && MML.Emu.PsfTrackVoicer.copyVersion) || 0) + ':' + (MML.I18n ? MML.I18n.getLang() : '');
    if (psxTrackOrderCache && psxTrackOrderCache.n === n && psxTrackOrderCache.last === last && psxTrackOrderCache.copyKey === copyKey) return psxTrackOrderCache;
    const lanes = s.map(c => c.lane);
    const voices = new Map();
    for (const l of lanes) voices.set(l.group, (voices.get(l.group) || 0) + 1);
    // 並び順: 元トラックの番号 → その声部 → その複製。複製は元トラック名(T8 等)から番号を引く
    const numOf = (l) => {
      if (l.copyOf) {
        const num = parseInt(l.copyOf.slice(1), 10);
        if (isFinite(num)) return (l.copyOf[0] === 'T' ? 0 : 100000) + num;
      }
      return l.track >= 0 ? l.track : 100000 + l.groupIndex;
    };
    const rank = (l) => numOf(l) * 1000 + (l.copyOf ? 500 : 0) + l.voice;
    const hueNum = lanes.map(numOf);
    const order = lanes.map((l, i) => i).sort((a, b) => rank(lanes[a]) - rank(lanes[b]));
    const name = MML.Emu && MML.Emu.PsfTrackVoicer ? MML.Emu.PsfTrackVoicer.laneName : (l) => String(l.index);
    // 行名の列は狭い(32px)ので、複製は「T9≈」とだけ出し、何の複製かは行名の説明(title)に出す
    const label = lanes.map(l => name(l, voices.get(l.group)) + (l.copyOf ? '≈' : ''));
    // ロールの区画(rollLanes='perChannel')は「ドライバのトラック1本=1区画」。和音の声部は同じ区画へ重ね、
    // 複製(デチューン二重化/エコー)は元トラックの区画へ点線で重ねる
    const group = lanes.map(l => l.copyOf || name(l, 1));
    const copy = lanes.map(l => !!l.copyOf);
    // (Worker のロール構築には翻訳辞書が無いので、そこでは説明を作らない)
    const title = lanes.map(l => l.copyOf && MML.I18n ? T('{name} は {of} の複製(デチューン二重化/エコー)', { name: name(l, voices.get(l.group)), of: l.copyOf }) : '');
    psxTrackOrderCache = { n, last, copyKey, order, label, title, group, copy, hueNum };
    return psxTrackOrderCache;
  }

  // サンプルPCM系チップ(GA20/SegaPCM/C140/C352/QSound/MultiPCM/OKIM6295/YM2610 ADPCM-A)の
  // 「ピッチ解析が信頼できなかった」行の共通形。音階演奏していない=打楽器/効果音なので、
  // ロールでは音程軸ではなくドラム区画(音程鍵盤より低音側のレーン群)へ置く。
  //  drumKey: どの太鼓かの同定キー。ドラム区画のレーンはこのキー単位で割り当てる。
  //           sample.start はサンプルROM上の開始アドレスで、同じ音なら曲中ずっと同じ値になる
  //           (vgm2mml/expansion/opn.js が既にリトリガー判定のキーに使っているのと同じ考え方)。
  //           サンプル同定情報を持たないチップ(OKIM6258/PWM/RF5C68/164 = ROMもアドレスも無い
  //           ストリーミングDAC)ではnullになり、従来どおり dmcRateIdx 経由の疑似音程に落ちる。
  //  drumSeq: キーオン通番。同じ太鼓を連打したとき区間が1本に融合しないよう区切りに使う。
  function pcmSampleRow(c) {
    return {
      sample: true, dmcReg: c.rawVol, dmcRateIdx: 15, dmcFreq: c.rate || 0,
      drumKey: c.sample ? (c.sample.kind + ':' + c.sample.start) : null,
      drumSeq: c.seq || 0,
    };
  }
  function adpcmPitchToMidi(ch) {
    if (ch.adpcmExact) return ch.freq > 0 ? freqToMidi(ch.freq) : null;
    const rateHz = ch.freq, refRate = ch.adpcmRefRate;
    if (!rateHz || rateHz <= 0 || !refRate) return null;
    const m = Math.round(60 + 12 * Math.log2(rateHz / refRate));
    return (m >= MIDI_MIN && m <= MIDI_MAX) ? m : null;
  }

  // セント偏差オーバーレイ(DESIGN-PITCH.md Phase 0)用。丸め後のMIDIノート番号の
  // 理論周波数からのズレをセントで返す(detune.jsの cents=1200*log2(raw/ideal) と同じ式)。
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // セント偏差オーバーレイの線色をノート帯の色に合わせて自動で切り替えるための輝度計算。
  // チャンネル色はhex('#66ddff')/hsl(...)/ユーザーのカラーピッカー選択色など形式が混在するため、
  // 自前でパースせず1x1canvasにfillして実際に描画されるRGBを読み戻す(どんな形式でも
  // ブラウザ自身のCSS色パーサーに任せられる)。同じ色文字列を毎フレーム読み戻すのは
  // 無駄なのでキャッシュする(色は基本的にユーザーが変更した時だけ変わる)。
  const _lumCache = new Map();
  let _lumProbeCtx = null;
  function relativeLuminance(colorStr) {
    if (_lumCache.has(colorStr)) return _lumCache.get(colorStr);
    if (!_lumProbeCtx) {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      _lumProbeCtx = c.getContext('2d', { willReadFrequently: true });
    }
    _lumProbeCtx.fillStyle = colorStr;
    _lumProbeCtx.fillRect(0, 0, 1, 1);
    const [r, g, b] = _lumProbeCtx.getImageData(0, 0, 1, 1).data;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    _lumCache.set(colorStr, lum);
    return lum;
  }
  // 明るい帯(輝度0.55超)には暗い線、暗い帯には白い線を重ねてコントラストを確保する。
  // ★暗い線側は純黒(0,0,0)にすると、偏差が帯からはみ出てロール背景(#14141a、
  // 輝度8%程度とほぼ黒)に重なった瞬間アルファ合成の結果もほぼ黒のまま=見えなくなる
  // (黒を黒に重ねてもアルファ値に関わらず黒のまま、という合成の性質による)。
  // ★中間グレーへ変更したところ、白鍵境界のグリッド線(#3d3d4a、無彩色の青灰色)と
  // 色味が近く紛らわしいとの指摘。無彩色同士の衝突を避けるため彩度のある暖色(赤系)にする。
  // 黄色/橙は明るい帯の既定色候補(黄色いチャンネル色等)と被って見えにくくなりうるため避け、
  // 赤系(色相環上で黄色から離れている)を選ぶ。
  function overlayLineColor(bgColorStr) {
    return relativeLuminance(bgColorStr) > 0.55 ? 'rgba(214,69,65,0.9)' : 'rgba(255,255,255,0.85)';
  }

  function midiToName(m) {
    return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
  }
  // 鍵盤の描画範囲(C1〜C8)の外でも音名を返す(note列の表示用)。以前は範囲外を '??' にしていたが、
  // OPMのキャリアMUL0.5のベース(21Hz=E0付近)やMUL3の高音(8kHz=B8)は実在の音程なので、
  // 「何の音か分からない」より音名(範囲外は色を落として区別)の方が読める(2026-09-07)
  function freqToMidiAny(f) {
    if (!f || f <= 0) return null;
    const m = Math.round(69 + 12 * Math.log2(f / 440) - rollTuningCents / 100);
    return (m >= 0 && m <= 127) ? m : null;
  }

  // ── APU 2A03 周波数計算 ───────────────────────────────────────

  function pulseFreq(lo, hi3) {
    const p = lo | ((hi3 & 7) << 8);
    return p >= 8 ? CPU_CLOCK / (16 * (p + 1)) : 0;
  }

  function pulseVol(reg0) {
    return (reg0 & 0x10) ? (reg0 & 0xF) / 15 : ((reg0 & 0xF) > 0 ? 1 : 0);
  }

  function pulseActive(reg0) {
    if (reg0 & 0x10) return (reg0 & 0xF) > 0;
    return true;
  }

  // NESの非線形 tnd ミキサー近似 (apu2a03.js の mixSample() と同じ式)。
  // triangle/noise/dmc は単純加算ではなくこの共有ミキサーを通るため、
  // 一方の出力レベルが上がるともう一方の相対的な聞こえ方が変化する。
  function tndOut(tri, noi, dmc) {
    const tndSum = (tri / 8227) + (noi / 12241) + (dmc / 22638);
    return tndSum > 0 ? 159.79 / (1 / tndSum + 100) : 0;
  }

  // ── 見かけ音量(tnd非線形ミキサーの干渉) ──────────────────────────
  // ある1chの「実際の寄与」= そのchを鳴らした時と消した時の出力差。他chの出力が上がるほど小さくなる。
  // ★非線形なので「他chの平均値を1回だけ式に入れる」やり方では合わない。他chが取りうる各状態で
  //   寄与を出し、その出現比で平均する必要がある(Jensenの不等式)。各chの状態の動き方:
  //     ノイズ … LFSRで 0 と level を往復する(実測デューティ0.518。ここでは1/2として扱う)
  //     三角波 … 32段シーケンサで 0〜15 を往復する(消音中も最後の値をDCとして保持する)
  //     DPCM  … その瞬間のDAC値そのもの(往復しないのでそのまま入れる)
  //   APUを実際に回して三角波の寄与振幅を測った実測との比較(ノイズ15/DPCM0):
  //     実測 0.920 / 状態を平均する今の式 0.900 / 平均値を1回入れる旧式 0.807
  // シーケンサ位置(0〜31) → 出力レベル(0〜15)。apu2a03.js の TRIANGLE_SEQ と同じ対応
  const TRIANGLE_SEQ_LEVEL = (seq) => (seq & 31) < 16 ? 15 - (seq & 31) : (seq & 31) - 16;
  const TRI_FULL = tndOut(15, 0, 0);   // 三角波が単独で鳴っている時の寄与
  const NOISE_FULL = tndOut(0, 15, 0); // ノイズが単独で最大レベルで鳴っている時の寄与

  /**
   * 三角波の実際の寄与(0〜1)。1 = 干渉なし。
   * @param {number} noiseLevel 実際に聞こえているノイズのレベル(消音中は0を渡すこと)
   * @param {number} dmcLevel   DPCMの現在のDAC値(0〜127)
   */
  function triApparent(noiseLevel, dmcLevel) {
    const off = tndOut(15, 0, dmcLevel) - tndOut(0, 0, dmcLevel);
    if (!(noiseLevel > 0)) return TRI_FULL > 0 ? Math.max(0, Math.min(1, off / TRI_FULL)) : 1;
    const on = tndOut(15, noiseLevel, dmcLevel) - tndOut(0, noiseLevel, dmcLevel);
    return Math.max(0, Math.min(1, ((on + off) / 2) / TRI_FULL));
  }

  /**
   * ノイズの実際の寄与(0〜1)。1 = 単独で最大レベル。レベル自体の低さも含んだ絶対値。
   * @param {number} noiseLevel ノイズのエンベロープ出力(0〜15)
   * @param {?number} triSeq    三角波のシーケンサ値(0〜15)。不明ならnull=0〜15の平均で代表する
   * @param {number} dmcLevel   DPCMの現在のDAC値(0〜127)
   */
  function noiseApparent(noiseLevel, triSeq, dmcLevel) {
    if (!(noiseLevel > 0)) return 0;
    let sum = 0, n = 0;
    if (triSeq === null || triSeq === undefined) {
      for (let v = 0; v <= 15; v++) { sum += tndOut(v, noiseLevel, dmcLevel) - tndOut(v, 0, dmcLevel); n++; }
    } else {
      sum = tndOut(triSeq, noiseLevel, dmcLevel) - tndOut(triSeq, 0, dmcLevel); n = 1;
    }
    return Math.max(0, Math.min(1, (sum / n) / NOISE_FULL));
  }

  // 見かけ音量の表示文字列。音量数値欄は20px=10pxフォントで3文字ぶんしかないため、
  // 1未満は先頭の0を落として ".98" の3文字にし、1に丸まる時だけ "1.0" とする。
  function apparentStr(r) {
    if (!(r >= 0)) return null;
    if (r >= 0.995) return "1.0";
    return "." + String(Math.round(r * 100)).padStart(2, "0");
  }

  // 干渉源の名前(ツールチップの{src}に入る)。maskBy の値がそのままキー
  const MASK_SRC = {
    // ★「原文|文脈」形式。"三角波"等は波形名/チャンネル名として既にen.jsにあり、素のキーだと衝突して既存の訳を壊す(実測で重複を検出)
    noise: "ノイズ|干渉源", dpcm: "DPCM($4011)|干渉源", noisedpcm: "ノイズとDPCM($4011)|干渉源",
    tri: "三角波|干渉源", tridpcm: "三角波とDPCM($4011)|干渉源",
  };
  // 三角波は音量レジスタが無いので数値そのものが比率。ノイズは数値がレジスタ値なので言い方を変える
  const MASK_TIP_RATIO = "{src}と同じDACを共有しているため音量が下がっています(表示は実際に鳴っている割合)";
  const MASK_TIP_REG = "{src}と同じDACを共有しているため、実際の音量はこのレジスタ値より下がっています";


  // ── チャンネル状態抽出 ────────────────────────────────────────

  function extractChannels(snap, extraSnaps, frameIdx, chips) {
    const channels = [];
    let n163NumRows = null; // MMLパート文字算出用(N163のnumChはgetPartLetterのフォールバックでは分からない)
    snap = snap || {};
    const status = snap[0x4015] || 0;
    // このフレームのAPUエンベロープ実出力。ライブ関数優先→静的配列→無ければレジスタ直読みにフォールバック。
    let apuEnv = null;
    if (extraSnaps) {
      if (extraSnaps.apuEnvLive) apuEnv = extraSnaps.apuEnvLive();
      if (!apuEnv && extraSnaps.apuEnv) apuEnv = extraSnaps.apuEnv[frameIdx];
    }

    // KSS(MSX)/GBS(Game Boy)/HES(PC Engine)再生中はNES内蔵チャンネル(2A03)を表示しない
    // (KSSはPSG/SCC/FMPACのみ、GBSはGB1/GB2/GN/GWのみ、HESはPSG0-5のみを表示する)。
    const isKss = chips.includes('kss');
    const isGbs = chips.includes('gbs');
    const isHes = chips.includes('hes');
    // VGMはヘッダで使うチップが決まる: NES APUを含まないVGM(MSX/GB/PCE系)では2A03行を出さない
    // (main.js側が chips に 'vgm' と、NES APU使用時のみ 'nes' を入れる)。
    const isVgmNoNes = chips.includes('vgm') && !chips.includes('nes');
    if (!isKss && !isGbs && !isHes && !isVgmNoNes) {
    // 2A03パルスのスイープユニット強制ミュート(emulator apu2a03.js PulseChannel.isMuted /
    // nsf2mml converter.js extractPulseEventsと同じ規則): 周期<8 または目標周期>$7FF
    // (特に$4001/$4005=$00のまま周期$400以上=o2a以下)は実際には鳴らないので非アクティブ表示
    const pulseSweepMuted = (sweepReg, period, isPulse1) => {
      const change = period >> (sweepReg & 7);
      const target = (sweepReg & 8) ? period - change - (isPulse1 ? 1 : 0) : period + change;
      return period < 8 || target > 0x7FF;
    };
    // ライブAPU状態(apuEnv)があるときは、レジスタ値では分からない実状態を優先する:
    //  ・period … スイープユニットが書き換えた実周期(レジスタは書いた瞬間の値のまま止まって
    //     見えるため、これが無いとスイープの上昇/下降が表示に一切出ない)
    //  ・muted … スイープ強制ミュート(上のpulseSweepMutedと同じ判定を実機側で行った結果)
    //  ・len … 長さカウンタ。halt=0の短い打楽器的な音は次の書込みを待たず自然消音する
    // (2026-08-19、FamicomBox「Game Select」。nsf2mml/converter.js側の同名シミュレーションと
    //  同じ情報で、ロール表示と変換MMLが食い違わないようにする)
    const pulseChannelState = (e, regPeriod, sweepReg, isPulse1) => {
      const period = (e && e.period != null) ? e.period : regPeriod;
      const muted = (e && e.muted !== undefined) ? e.muted : pulseSweepMuted(sweepReg, period, isPulse1);
      const lenOk = (e && e.len !== undefined) ? e.len > 0 : true;
      return { freq: period >= 8 ? CPU_CLOCK / (16 * (period + 1)) : 0, muted, lenOk };
    };
    // APU Pulse 1
    {
      const r = snap[0x4000] || 0;
      const regPeriod = (snap[0x4002] || 0) | (((snap[0x4003] || 0) & 7) << 8);
      const e = apuEnv ? apuEnv.pulse1 : null;
      const { freq, muted, lenOk } = pulseChannelState(e, regPeriod, snap[0x4001] || 0, true);
      const rv = e ? e.level : (r & 0xF);
      channels.push({ id: 'P1', color: '#ff4466', freq, vol: e ? e.level / 15 : pulseVol(r), rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false, duty: (r >> 6) & 3,
        wave: { t: 'pulse', hi: APU_DUTY[(r >> 6) & 3], nx: 8, ny: 2 },
        active: !!(status & 1) && pulseActive(r) && freq > 0 && !muted && lenOk });
    }
    // APU Pulse 2
    {
      const r = snap[0x4004] || 0;
      const regPeriod = (snap[0x4006] || 0) | (((snap[0x4007] || 0) & 7) << 8);
      const e = apuEnv ? apuEnv.pulse2 : null;
      const { freq, muted, lenOk } = pulseChannelState(e, regPeriod, snap[0x4005] || 0, false);
      const rv = e ? e.level : (r & 0xF);
      channels.push({ id: 'P2', color: '#ff8800', freq, vol: e ? e.level / 15 : pulseVol(r), rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false, duty: (r >> 6) & 3,
        wave: { t: 'pulse', hi: APU_DUTY[(r >> 6) & 3], nx: 8, ny: 2 },
        active: !!(status & 2) && pulseActive(r) && freq > 0 && !muted && lenOk });
    }
    // Triangleの「見かけ音量」計算に使う Noise/DMC の現在値を先読みしておく
    // (NOブロック・DMブロックでも同じ値を使い回す)。
    const noiseRegPre = snap[0x400C] || 0;
    const eNoisePre = apuEnv ? apuEnv.noise : null;
    const noiseLevelPre = eNoisePre ? eNoisePre.level : (noiseRegPre & 0xF);
    // ★干渉源になるのは「実際に音が出ているノイズ」だけ。$4015で無効、または長さカウンタが0の
    //   ノイズはレベル値がレジスタに残っていても出力0で、三角波は一切減衰しない
    //   (APUを回した実測でも減衰0。以前はレジスタ値だけを見て無音のノイズでも減衰表示していた)
    const noiseAudiblePre = !!(status & 8) && noiseLevelPre > 0 &&
      (!eNoisePre || eNoisePre.len === undefined || eNoisePre.len > 0);
    const noiseMaskPre = noiseAudiblePre ? noiseLevelPre : 0;
    // 三角波は消音中も最後のシーケンサ値をDCとして保持し、そのDCもtndミキサーに効く
    const triSeqPre = (apuEnv && apuEnv.triangle && apuEnv.triangle.seq !== undefined)
      ? TRIANGLE_SEQ_LEVEL(apuEnv.triangle.seq) : null;
    const dmcRegPre = (snap[0x4011] || 0) & 0x7F; // $4011 レジスタ値（直接書き込み検出用）
    const dmcPre = apuEnv ? apuEnv.dmc : null;
    const dmcLevelPre = (dmcPre && dmcPre.level !== undefined) ? dmcPre.level : dmcRegPre;

    // APU Triangle
    // 音量レジスタが無いチャンネルなので、普段は音量数値を出さない(空欄)。
    // ノイズ/DPCMと共有する非線形tndミキサーの干渉で実際の寄与が下がっている時だけ、
    // その割合を ".98" の形で黄色表示する(レジスタ値ではないと分かる書き方にしてある)。
    {
      const lo = snap[0x400A] || 0, hi = snap[0x400B] || 0;
      const p = lo | ((hi & 7) << 8);
      const freq = p >= 4 ? CPU_CLOCK / (32 * (p + 1)) : 0;
      const ratio = triApparent(noiseMaskPre, dmcLevelPre);
      const masked = ratio < 0.995;
      const maskBy = !masked ? null
        : (noiseMaskPre > 0 && dmcLevelPre > 0) ? "noisedpcm" : (dmcLevelPre > 0 ? "dpcm" : "noise");
      channels.push({ id: "TR", color: "#00cc44", freq, vol: ratio,
        rawVol: masked ? apparentStr(ratio) : null, rawVolMax: 1,
        envMode: false, maskBy, maskTip: MASK_TIP_RATIO,
        wave: { t: "tri", nx: 32, ny: 16 },
        // 三角波は長さカウンタ/線形カウンタのどちらかが0になると消音する(レジスタ値は
        // 変わらないためライブ状態が無いと判定できない。nsf2mml側のtriangleAudibleFrames相当)
        active: !!(status & 4) && freq > 0 &&
          (!apuEnv || !apuEnv.triangle || (apuEnv.triangle.len > 0 && apuEnv.triangle.linear > 0)) });
    }

    // APU Noise
    {
      // $400E bit7=1 で短周期(93step)、0で長周期(32767step)。bit0-3 は周期テーブルのインデックス
      const noiseReg = snap[0x400E] || 0;
      const noiseShort = !!(noiseReg & 0x80);
      const noiseIndex = noiseReg & 0x0F;
      const e = eNoisePre;
      const rv = noiseLevelPre;
      const noiseFreq = CPU_CLOCK / NOISE_PERIOD[noiseIndex]; // LFSRシフトレート
      const triAudible = !!(status & 4) &&
        (!apuEnv || !apuEnv.triangle || (apuEnv.triangle.len > 0 && apuEnv.triangle.linear > 0));
      // ★三角波は鳴っている間 0〜15 を往復する。1フレームの瞬間値をそのまま使うと
      //   フレームごとに 0〜15 へばらつき、ノイズのバーが毎フレーム暴れる。鳴っている間は
      //   「0〜15の平均」で代表させ(null)、消音して値が固定されている時だけ保持値を使う。
      const triMaskSeq = triAudible ? null : triSeqPre;
      const triMasks = triAudible || (triSeqPre !== null && triSeqPre > 0);
      const noiseRatio = noiseApparent(rv, triMaskSeq, dmcLevelPre);
      const noiseMaskBy = (rv > 0 && (triMasks || dmcLevelPre > 0))
        ? ((triMasks && dmcLevelPre > 0) ? 'tridpcm' : (dmcLevelPre > 0 ? 'dpcm' : 'tri')) : null;
      // ★vol は「レジスタどおりの大きさ」のままにする。ピアノロールがこれを音の濃さに使っており、
      //   ロールはMML変換の突き合わせ用(MMLに載るのはレジスタ値)なので、干渉ぶんを混ぜると
      //   一定音量のドラムが濃淡バラバラに見えて変換バグと紛らわしくなる。
      //   干渉を含んだ「実際に聞こえる大きさ」は volApparent に分け、鍵盤表示の音量バーだけが使う。
      channels.push({ id: "NO", color: "#888888", freq: 0, vol: e ? e.level / 15 : pulseVol(noiseRegPre),
        volApparent: noiseRatio, rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false, maskBy: noiseMaskBy, maskTip: MASK_TIP_REG,
        wave: { t: 'noise', short: noiseShort, nx: noiseShort ? 93 : 32767, ny: 2 },
        active: !!(status & 8) && pulseActive(noiseRegPre) && (!e || e.len === undefined || e.len > 0),
        noise: true, noiseShort, noiseIndex, noiseFreq });
    }
    // APU DMC
    {
      const dv = dmcRegPre;
      const dmcRateIdx = (snap[0x4010] || 0) & 0x0F;
      const dmcFreq = CPU_CLOCK / DMC_RATE[dmcRateIdx]; // DPCM再生周波数
      // DPCMサンプルをデルタ復号した波形（apuEnv.dmc 経由）。無ければ "固有波形なし" 扱い。
      const dmc = dmcPre;
      // ★音量数値/バーは「DACの現在値」ではなく「直近1フレームのDAC振幅(0〜127)」を使う。
      //   現在値は波形の位置でしかなく音量にならない(実測: SMB3のスネアが減衰しても現在値は
      //   中央値46のまま。振幅は 94→68→42→28→16→10 と減衰をそのまま描く)。
      //   振幅が取れない経路(キャプチャ済みログにampが無い等)だけ従来どおり現在値に落とす。
      const level = (dmcPre && dmcPre.amp !== undefined) ? dmcPre.amp : dmcLevelPre;
      const wave = (dmc && dmc.len > 0)
        ? { t: 'wave', data: dmc.samples, nx: dmc.len * 8, ny: 128, sig: dmc.addr + ':' + dmc.len, pcm: true }
        : { t: 'sample', nx: 0, ny: 0 };
      // dmcDirect: $4011 直接書込み(生PCM)の検出対象はこの行だけ(update()参照)
      // drumKey/drumSeq(2026-09-03): サンプル(アドレス+長さ)が分かるときはロールをレート
      // 疑似音程ではなくドラム区画(1サンプル=1レーン)へ。VGMのサンプルPCM行と同じ形。
      // キーは nsf2mml/converter.js dmcHits と同じ 'dmc:<addr>:<len>'
      // APUエンベロープが無い経路(キャプチャWorkerのロール構築)では $4012/$4013 のレジスタ値から
      // 同じキーを組む。通番は extraSnaps.dmcSeq(writeLogの$4015 bit4書込みの累計。nsf2mml
      // extractDmcTriggers と同じ数え方)から取る
      const regLen = snap[0x4013];
      const regKey = (regLen !== undefined) ? ('dmc:' + (0xC000 + (snap[0x4012] || 0) * 64) + ':' + (regLen * 16 + 1)) : null;
      const dmcKey = (dmc && dmc.len > 0) ? ('dmc:' + dmc.addr + ':' + dmc.len) : regKey;
      const dmcSeq = (dmc && dmc.seq) ? dmc.seq
        : ((extraSnaps && extraSnaps.dmcSeq && extraSnaps.dmcSeq[frameIdx]) || 0);
      // 発声中か: $4015 bit4(最後に書かれた値)だけでは鳴り終わりが分からない。ライブ経路は
      // APUの実状態(bytesRemaining/bitsRemaining)、履歴経路は buildDmcTimeline が $4013 の長さと
      // $4010 のレート/ループから求めた終了フレームで切る
      const dmcPlaying = (dmc && dmc.playing !== undefined) ? dmc.playing
        : ((extraSnaps && extraSnaps.dmcEnd) ? frameIdx < extraSnaps.dmcEnd[frameIdx] : true);
      channels.push({ id: 'DM', color: '#aa44ff', freq: 0, vol: level / 127, rawVol: level, rawVolMax: 127,
        wave, active: !!(status & 0x10) && dmcPlaying, sample: true, dmcRateIdx, dmcFreq, dmcReg: dv, dmcDirect: true,
        drumKey: dmcKey, drumSeq: dmcSeq });
    }
    } // !isKss && !isGbs

    if (chips.includes('fds')) {
      const lo = snap[0x4082] || 0, hi = snap[0x4083] || 0;
      const f12 = lo | ((hi & 0xF) << 8);
      const disabled = !!(hi & 0x80);
      // $4080: bit7=1で直接ゲイン, bit7=0でエンベロープ(減衰)。実ゲイン(volGain 0-32)を優先し、
      // 無ければレジスタ直読み(直接ゲイン時のみ正しい)にフォールバック。
      // 実効ゲインは32で頭打ち(v33-63を書いても32相当、src/emulator/expansion/fds.js mixSample)
      // なのでバーは32=100%固定。以前はレジスタ直読みフォールバック時だけ/63にしていたため
      // 同じ音量でもライブ時と半分の長さに見えていた(2026-08-24)
      const fe = apuEnv ? apuEnv.fds : null;
      const gain = fe ? fe.gain : ((snap[0x4080] || 0) & 0x3F);
      const gainMax = 32;
      const vol = Math.min(1, gain / gainMax);
      const freq = (!disabled && f12 > 0) ? f12 * CPU_CLOCK / (64 * 65536) : 0;
      // 波形メモリ $4040-$407F (6bit, 0-63) を -1..1 に正規化
      const fdsWave = new Array(64);
      for (let i = 0; i < 64; i++) fdsWave[i] = ((snap[0x4040 + i] || 0) & 0x3F) / 31.5 - 1;
      // $4087 bit7=0 でピッチモジュレーションユニットが有効(MH<n>使用中)。
      // 実機は明示的に$4087 bit7=1で停止するまで有効なままなので、gain(=$4084)が
      // 0でもここは別途チェックする(MHOF時は両方0/1になる。src/mml/compiler.jsの
      // resolveFdsModWriteを参照)。fe(apuEnv.fds)があれば実インスタンスの実状態
      // (既定false)を使う。$4087が曲中一度も書かれない場合、生レジスタスナップショットは
      // 未定義→0扱いになりbit7=0=有効に誤検出してしまう(MH<n>を全く使っていないのに
      // 鍵盤表示が常時ON扱いになるバグの原因だった)ため、レジスタ直読みは
      // feが取れない場合のフォールバックに留める
      const modActive = fe ? !!fe.modEnabled : !((snap[0x4087] || 0) & 0x80);
      // 実際に揺れている実ピッチ(Hz)。fe.effectiveFreq(src/emulator/expansion/fds.js
      // clock()で計算済み)はfreqと同じ内部単位(f12と同スケール)なので同じ式でHz換算する。
      // note(音名)は表示のちらつきを避けるため変調前のfreqのまま据え置き、freq列の
      // 数値表示だけをこちらに差し替える(モジュレーション無効時はfreqと同じ値になる)
      const modFreq = (fe && modActive && !disabled) ? fe.effectiveFreq * CPU_CLOCK / (64 * 65536) : freq;
      channels.push({ id: 'FDS', color: '#ff88aa', freq, modFreq, vol, rawVol: gain, rawVolMax: gainMax,
        envMode: fe ? fe.env : false, modActive,
        wave: { t: 'wave', data: fdsWave, nx: 64, ny: 64 },
        active: !disabled && vol > 0 && freq > 0 });
    }

    if (chips.includes('vrc6')) {
      for (const [id, color, b0, blo, bhi, div] of [
        ['V6P1', '#00ccff', 0x9000, 0x9001, 0x9002, 16],
        ['V6P2', '#0088ff', 0xA000, 0xA001, 0xA002, 16],
      ]) {
        const ctrl = snap[b0] || 0, lo = snap[blo] || 0, hi = snap[bhi] || 0;
        const period = lo | ((hi & 0xF) << 8);
        const en = !!(hi & 0x80);
        const rv = ctrl & 0xF;
        const vol = rv / 15;
        const duty = (ctrl >> 4) & 7; // VRC6 は High 区間 = (duty+1)/16
        const freq = (en && period > 0) ? CPU_CLOCK / (div * (period + 1)) : 0;
        channels.push({ id, color, freq, vol, rawVol: rv, rawVolMax: 15, duty,
          wave: { t: 'pulse', hi: (duty + 1) / 16, nx: 16, ny: 2 },
          active: en && vol > 0 && freq > 0 });
      }
      {
        const ctrl = snap[0xB000] || 0, lo = snap[0xB001] || 0, hi = snap[0xB002] || 0;
        const period = lo | ((hi & 0xF) << 8);
        const en = !!(hi & 0x80);
        const rv = ctrl & 0x3F;
        const vol = Math.min(1, rv / 42);
        const freq = (en && period > 0) ? CPU_CLOCK / (14 * (period + 1)) : 0;
        // 波形表示にも蓄積レートを渡す(43以上は実機の8bit桁溢れで鋸波が崩れる。waveSampleValue参照)
        channels.push({ id: 'V6SW', color: '#00ffcc', freq, vol, rawVol: rv, rawVolMax: 42,
          wave: { t: 'saw', nx: 7, ny: 32, rate: rv },
          active: en && rv > 0 && freq > 0 });
      }
    }

    if (chips.includes('vrc7')) {
      // リアルタイムはライブVRC7(実FM波形付き)、事前キャプチャは writeLog由来。
      const live = extraSnaps && extraSnaps.vrc7Live;
      const snaps = live ? live() : (extraSnaps && extraSnaps.vrc7 ? extraSnaps.vrc7[frameIdx] : null);
      const COLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc'];
      for (let ch = 0; ch < 6; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false, rawVol: 15 };
        // VRC7: rawVol は 0=最大, 15=無音 なので内部値をそのまま表示
        // FM合成波形があれば波形表示、無ければFMアイコン
        // VRC7はFM=連続波形なので smooth:true で線形補間(階段でなく曲線)表示
        const wave = (c.waveData && c.waveData.length)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `VR${ch+1}`, color: COLS[ch], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15, volZeroMax: true,
          wave, active: c.active, fmPatch: c.patch || null });
      }
    }

    if (chips.includes('n163')) {
      // リアルタイム再生はライブN163関数、事前キャプチャは writeLog 由来の配列。
      const live = extraSnaps && extraSnaps.n163Live;
      const arr = extraSnaps && extraSnaps.n163;
      let snaps, numRows;
      if (live) {
        snaps = live(); // { channels, numCh, maxNumCh }
        numRows = snaps ? (snaps.maxNumCh || snaps.numCh || 1) : 1;
      } else {
        snaps = arr ? arr[frameIdx] : null;
        // 行数は曲全体の最大numChで固定（frame0=1chに縛られない・行が増減しない）
        numRows = (arr && arr.maxNumCh) ? arr.maxNumCh : 1;
      }
      n163NumRows = numRows;
      // 表示順は下位アドレス側(MML文字の若い方)を上段にするため i を降順で積む
      // (id自体はN{i+1}=ハードch(8-(i+1))のまま。getMuteInfo等の対応関係は変えない)。
      for (let i = numRows - 1; i >= 0; i--) {
        const c = snaps ? snaps.channels[i] : { freq: 0, vol: 0, active: false };
        const hue = (180 + i * 25) % 360;
        channels.push({ id: `N${i+1}`, color: `hsl(${hue},80%,60%)`, freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave: { t: 'wave', data: c.waveData || [0, 0], nx: (c.waveData ? c.waveData.length : 0), ny: 16 },
          active: c.active });
      }
    }

    if (chips.includes('fme7')) {
      // リアルタイムはライブFME7関数(ラッチ式で復元不可)、事前キャプチャは writeLog由来配列。
      const live = extraSnaps && extraSnaps.fme7Live;
      const snaps = live ? live() : (extraSnaps && extraSnaps.fme7 ? extraSnaps.fme7[frameIdx] : null);
      const COLS = ['#88ff44','#55dd22','#33bb00'];
      for (let ch = 0; ch < 3; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false };
        channels.push({ id: `FE${ch+1}`, color: COLS[ch], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: c.rawVolMax !== undefined ? c.rawVolMax : 15,
          envMode: !!c.envMode,
          // ノイズ有効chはノイズ波形、それ以外は50%矩形波
          wave: c.noise ? { t: 'noise', short: false, nx: 32767, ny: 2 } : { t: 'pulse', hi: 0.5, nx: 2, ny: 2 },
          active: c.active });
      }
    }

    if (chips.includes('mmc5')) {
      // リアルタイムはライブMMC5(エンベロープ実出力・PCM反映)、事前キャプチャはレジスタ値。
      const ls = extraSnaps && extraSnaps.mmc5Live ? extraSnaps.mmc5Live() : null;
      const mst = snap[0x5015] || 0;
      for (const [i, base, bit] of [[0, 0x5000, 1], [1, 0x5004, 2]]) {
        const r = snap[base] || 0;
        let c;
        if (ls) {
          c = i === 0 ? ls.pulse1 : ls.pulse2;
        } else {
          const freq = pulseFreq(snap[base + 2] || 0, snap[base + 3] || 0);
          c = { freq, vol: pulseVol(r), rawVol: r & 0xF, duty: (r >> 6) & 3,
                active: !!(mst & bit) && pulseActive(r) && freq > 0 };
        }
        channels.push({ id: i === 0 ? 'M5P1' : 'M5P2',
          color: i === 0 ? '#ff6655' : '#ffaa44', freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          duty: c.duty !== undefined ? c.duty : ((r >> 6) & 3),
          wave: { t: 'pulse', hi: APU_DUTY[c.duty !== undefined ? c.duty : ((r >> 6) & 3)], nx: 8, ny: 2 },
          active: c.active });
      }
      // $5011 生PCM チャンネル
      const pcm = ls ? ls.pcm : { level: snap[0x5011] || 0, vol: (snap[0x5011] || 0) / 255, active: (snap[0x5011] || 0) > 0 };
      channels.push({ id: 'M5PC', color: '#ff4488', freq: 0, vol: pcm.vol, rawVol: pcm.level, rawVolMax: 255,
        wave: { t: 'sample' }, active: pcm.active });
    }

    if (chips.includes('kssPsg')) {
      // PSG(AY-3-8910): 2A03のFME-7表示と同じ考え方(50%矩形波固定、noise有効chはノイズ波形)。
      const live = extraSnaps && extraSnaps.kssPsgLive;
      const snaps = live ? live() : null;
      const COLS = ['#66ddff', '#33aaff', '#0077dd'];
      // VGMのデュアルAY8910(2個目)はスナップショットが6要素で返るのでKP4-6行も出す
      const nKp = snaps && snaps.length > 3 ? snaps.length : 3;
      for (let ch = 0; ch < nKp; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false };
        // ★2026-08-22: ノイズ専用ch(トーン無効 or トーン周期0でノイズだけ鳴らす打楽器)は
        // SN76489/GBSのノイズ行と同じ扱いにして、note列に周期indexを出す。
        // 従来は波形アイコンだけノイズにしていたため、note列が空のままで何のchか読めなかった。
        // ★音量は内部32段(0-31)の実レベル。スナップショットが rawVolMax を持つならそれに従う
        //   (ライブAY=32段 / writeLog再生のFME7=4bitレジスタ0-15)。ハードエンベロープ中は
        //   「レジスタそのままではない」印として黄色(envMode)にする。★行へ渡し忘れると効かない
        const noiseRow = { id: `KP${ch + 1}`, color: COLS[ch % 3], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: c.rawVolMax !== undefined ? c.rawVolMax : 15,
          envMode: !!c.envMode,
          wave: c.noise ? { t: 'noise', short: false, nx: 32767, ny: 2 } : { t: 'pulse', hi: 0.5, nx: 2, ny: 2 },
          active: c.active };
        if (c.noiseOnly) {
          noiseRow.noise = true;
          noiseRow.noiseFreq = c.noiseFreq;
          noiseRow.noiseIndex = gbNoiseFreqToIndex(c.noiseFreq);
          noiseRow.noiseShort = false;
          noiseRow.freq = 0; // 音程は持たない(古いトーン周期の残骸を出さない)
        }
        channels.push(noiseRow);
      }
    }

    if (chips.includes('kssScc')) {
      // SCC: N163と同じ波形メモリ音源(要素数のみ異なる: SCCは32点符号付き8bit)。
      const live = extraSnaps && extraSnaps.kssSccLive;
      const snaps = live ? live() : null;
      for (let ch = 0; ch < 5; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false };
        const hue = (280 + ch * 20) % 360;
        channels.push({ id: `KS${ch + 1}`, color: `hsl(${hue},80%,60%)`, freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave: { t: 'wave', data: c.waveData || [0, 0], nx: (c.waveData ? c.waveData.length : 0), ny: 32 },
          active: c.active });
      }
    }

    if (chips.includes('kssOpll')) {
      // FMPAC(YM2413): VRC7と同じFM表示だが、9メロディモードとリズムモード(6melody+BD/SD/TOM/CYM/HH)
      // の両方に対応する(VRC7ハードウェアにはリズムモードが存在しないため6ch固定だった)。
      const live = extraSnaps && extraSnaps.kssOpllLive;
      const snap2 = live ? live() : null;
      // ★2026-08-22: リズムモード(レジスタ$0E bit5)は「打つ瞬間だけ立てて即降ろす」ドライバが
      // 実在する(SMS版After Burnerは毎秒10〜16回トグル)。生ビットに追随すると9ch表示と
      // 6ch+リズム表示が激しく入れ替わって読めないため、**一度でも見たら以後は保持する**
      // 単調な運用にする(SCC行を出したら消さないのと同じ考え方)。フラグはextraSnapsに
      // 持たせているのでsetSource()の this._extraSnaps = {} で曲ごとにリセットされる。
      if (snap2 && snap2.rhythmMode && extraSnaps) extraSnaps.opllRhythmSeen = true;
      const opllRhythm = !!(extraSnaps && extraSnaps.opllRhythmSeen);
      const melody = snap2 ? snap2.melody : [];
      const MCOLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc','#ffd9a0','#ffe0b0','#ffe8c0'];
      for (let ch = 0; ch < (opllRhythm ? 6 : (melody.length || 9)); ch++) {
        const c = melody[ch] || { freq: 0, vol: 0, active: false, rawVol: 15 };
        const wave = (c.waveData && c.waveData.length)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `KF${ch + 1}`, color: MCOLS[ch % MCOLS.length], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15, volZeroMax: true,
          wave, active: c.active, fmPatch: c.patch || null });
      }
      if (opllRhythm && snap2 && snap2.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RLABEL = { bd: 'BD', sd: 'SD', tom: 'TOM', cym: 'CYM', hh: 'HH' };
        // ★ロールと同じ規則で音程を決める(ここを変えたら src/kss2mml/expansion/opll.js の
        // RHYTHM_DEFS / extractRhythmEvents も必ず同じに直すこと。両者がずれると
        // 「ロールと鍵盤で音符が違う」状態になる)。
        //   BD(ch6)/TOM(ch8) … fnum/blockの実音程を持つので、描画範囲(MIDI_MIN以上)なら実音程
        //   それ以外(音程なし=SD/CYM/HH、または実音程が低すぎて範囲外) … 疑似音程 index
        //     (ロールは midi = 24 + index に置く。鍵盤は noiseIndex 経由で同じキーになる)
        const RPSEUDO = { bd: 0, sd: 2, tom: 4, cym: 6, hh: 8 };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          const r = snap2.rhythm[key];
          const realMidi = freqToMidi(r.freq); // 範囲外はnullが返る
          const row = { id: `KF${RLABEL[key]}`, color: RCOLS[key], freq: realMidi !== null ? r.freq : 0, vol: r.vol,
            rawVol: null, rawVolMax: null,
            wave: realMidi !== null ? { t: 'pulse', hi: 0.5, nx: 2, ny: 2 } : { t: 'noise', short: true, nx: 93, ny: 2 },
            active: r.active, drum: true };
          if (realMidi === null) {
            row.noise = true;
            row.noiseIndex = RPSEUDO[key];
            row.noiseShort = true;
            row.noiseLabel = RLABEL[key]; // note列は周期indexでなく打楽器名を出す
          }
          channels.push(row);
        }
      }
    }

    if (chips.includes('sn76489')) {
      // SN76489(VGM: SMS/GG/SG-1000/MD PSG): 矩形3本(50%固定)+ノイズ1ch。ライブ関数優先、
      // 無ければ先読みスナップショット配列(extraSnaps.sn[frameIdx]、ロール構築用)。
      // L/R列はGame Gearのステレオレジスタ(他機種では常に1/1)。
      const live = extraSnaps && extraSnaps.snLive;
      const sAll = live ? live() : (extraSnaps && extraSnaps.sn ? extraSnaps.sn[frameIdx] : null);
      const COLS = ['#66ddff', '#33aaff', '#0077dd'];
      // デュアルチップ(2個目)はスナップショットが8要素(4+4)で返る: 2組目はSN4-6/SNN2行
      const nGroups = sAll && sAll.length >= 8 ? 2 : 1;
      for (let g = 0; g < nGroups; g++) {
      const s = sAll ? sAll.slice(g * 4, g * 4 + 4) : null;
      for (let ch = 0; ch < 3; ch++) {
        const c = s ? s[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1 };
        channels.push({ id: `SN${g * 3 + ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave: { t: 'pulse', hi: 0.5, nx: 2, ny: 2 }, active: c.active, ...panVolFields(c) });
      }
      {
        const c = s ? s[3] : { freq: 0, vol: 0, rawVol: 0, active: false, white: true, noiseFreq: 0, panL: 1, panR: 1 };
        // 周期性ノイズ(white=false)は短周期の繰り返し=2A03の短周期ノイズ表示に寄せる。
        // note列はシフトレートを2A03ノイズ16周期の最寄りindexに写像(GBのGN行と同じ考え方)。
        channels.push({ id: g === 0 ? 'SNN' : 'SNN2', color: '#888888', freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave: { t: 'noise', short: !c.white, nx: c.white ? 65535 : 16, ny: 2 },
          active: c.active, noise: true, noiseIndex: gbNoiseFreqToIndex(c.noiseFreq), noiseFreq: c.noiseFreq, noiseShort: !c.white,
          ...panVolFields(c) });
      }
      }
    }

    if (chips.includes('ym2612')) {
      // YM2612(VGM: メガドライブ): 4op FM×6ch(VRC7/OPLL行と同じFM波形表示)+DAC行。ライブ関数
      // 優先、無ければ先読みスナップショット配列(extraSnaps.ym2612[frameIdx]、ロール構築用)。
      const live = extraSnaps && extraSnaps.ymLive;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2612 ? extraSnaps.ym2612[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa', '#fff8cc'];
      for (let ch = 0; ch < 6; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `YM${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, ...fmVolFields(c.patch, c.rawVol),
          wave, active: c.active, ...panVolFields(c), fmPatch: c.patch || null });
      }
      {
        const d = s ? s.dac : { enabled: false, level: 0, vol: 0, active: false };
        channels.push({ id: 'YMDA', color: '#aa44ff', freq: 0, vol: d.vol, rawVol: d.enabled ? d.level : null, rawVolMax: 255,
          wave: { t: 'sample' }, active: !!d.active, sample: true, dmcReg: d.level, dmcRateIdx: 15, dmcFreq: 0 });
      }
    }

    if (chips.includes('ym2608fm')) {
      // YM2608(VGM: OPNA、PC-88 SB2/PC-98): 4op FM×6ch(YM2612と同じFM波形表示)+
      // 内蔵リズム6行(BD/SD/Cym/HH/Tom/Rim。固定サンプルなので音程なしの「サンプル」行)+
      // ADPCM-B行(NB行と同じ3段階表示)。内蔵SSGは 'kssPsg' のKP1-3行として別途出す。
      const live = extraSnaps && extraSnaps.ym2608FmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2608fm ? extraSnaps.ym2608fm[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffd422', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa'];
      for (let ch = 0; ch < 6; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `OA${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, ...fmVolFields(c.patch, c.rawVol),
          wave, active: c.active, ...panVolFields(c), fmPatch: c.patch || null });
      }
      // 内蔵リズム: NA行と同じデータ形状(ロール/ドラム区画/パッド流用)。ピッチ解析は
      // ドラム音なので通常conf<0.5=「サンプル」行のまま。リズムROM未読込でもキーオンは
      // 見えるので行は光る(音は出ない)。
      const RIDS = ['OABD', 'OASD', 'OACY', 'OAHH', 'OATM', 'OARM'];
      const adpcmWave8 = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 6; ch++) {
        const c = s && s.adpcmA ? s.adpcmA[ch] : { vol: 0, rawVol: 0, rawVolMax: 31, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (20 + ch * 12) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: RIDS[ch], color: `hsl(${hue},80%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 31,
          wave: adpcmWave8(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
      {
        const c = s && s.adpcmB ? s.adpcmB : { vol: 0, rawVol: 0, rawVolMax: 255, active: false, panL: 1, panR: 1, rate: 0, refRate: 1, pitchHz: 0, pitchConf: 0 };
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: 'OAB', color: '#cc66ff', freq: exact ? c.pitchHz : (c.rate || 0), vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: adpcmWave8(c), active: !!c.active, adpcmPitch: true, adpcmExact: exact, adpcmRefRate: c.refRate || 1, adpcmRate: c.rate || 0,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto',
          ...panVolFields(c) });
      }
    }

    if (chips.includes('opl')) {
      // OPL系(VGM: YM3812/YM3526/Y8950、KSS: MSX-AUDIO): 2op FM×9ch、またはリズムモード
      // (6メロディ+BD/SD/TOM/CYM/HH)。表示流儀はkssOpll(FMPAC)と同じで、リズムモードは
      // 一度見たら以後保持する単調運用(extraSnaps.oplRhythmSeen)。
      const live = extraSnaps && extraSnaps.oplLive;
      const s = live ? live() : null;
      if (s && s.rhythm && s.rhythm.on && extraSnaps) extraSnaps.oplRhythmSeen = true;
      const oplRhythm = !!(extraSnaps && extraSnaps.oplRhythmSeen);
      const MCOLS = ['#66ffcc', '#55eebb', '#44ddaa', '#33cc99', '#22bb88', '#11aa77', '#66e0d0', '#55d0c0', '#44c0b0'];
      for (let ch = 0; ch < (oplRhythm ? 6 : 9); ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, waveData: null };
        // 波形列はOPN/OPM行と同じく実際の合成波形(opl.js snapshotOPL の waveData。波形選択WS/
        // 接続/帰還込み)。無い時だけ汎用FMアイコン
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `OL${ch + 1}`, color: MCOLS[ch % MCOLS.length], freq: c.freq, vol: c.vol,
          ...fmVolFields(c.patch, c.rawVol),
          wave, active: c.active, fmPatch: c.patch || null });
      }
      if (oplRhythm) {
        // ★ロール(src/kss2mml/expansion/opl.js RHYTHM_DEFS)と同じ規則で音程を決める:
        //   BD(ch6)/TOM(ch8)は実音程(範囲内なら)、SD/CYM/HHは疑似音程レーン
        const r = (s && s.rhythm) || null;
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RIDS = { bd: 'OLBD', sd: 'OLSD', tom: 'OLTM', cym: 'OLCY', hh: 'OLHH' };
        const RPSEUDO = { bd: 0, sd: 2, tom: 4, cym: 6, hh: 8 };
        const RLABEL = { bd: 'BD', sd: 'SD', tom: 'TOM', cym: 'CYM', hh: 'HH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          const d = r ? r[key] : { keyOn: false, active: false, vol: 0, freq: 0 };
          const realMidi = freqToMidi(d.freq);
          const row = { id: RIDS[key], color: RCOLS[key], freq: realMidi !== null ? d.freq : 0, vol: d.vol,
            rawVol: null, rawVolMax: null,
            wave: realMidi !== null ? { t: 'pulse', hi: 0.5, nx: 2, ny: 2 } : { t: 'noise', short: true, nx: 93, ny: 2 },
            active: d.active, drum: true };
          if (realMidi === null) { row.noise = true; row.noiseIndex = RPSEUDO[key]; row.noiseShort = true; row.noiseLabel = RLABEL[key]; }
          channels.push(row);
        }
      }
      // Y8950 ADPCM-B行(NB/OAB行と同じ3段階表示。スナップショットが持つ時だけ)
      if (s && s.adpcmB) {
        const c = s.adpcmB;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: 'OLB', color: '#cc66ff', freq: exact ? c.pitchHz : (c.rate || 0), vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' },
          active: !!c.active, adpcmPitch: true, adpcmExact: exact, adpcmRefRate: c.refRate || 1, adpcmRate: c.rate || 0,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto',
          panL: 1, panR: 1 });
      }
    }

    if (chips.includes('ym2203fm')) {
      // YM2203(VGM: OPN、PC-88/PC-98/アーケード): 4op FM×3ch(YM2612と同じFM波形表示)。
      // 内蔵SSGは 'kssPsg' のKP1-3行として別途出す(main.js vgmKeyboardChips)。デュアルチップは
      // ライブスナップショットが6ch(3+3)で返り、OP4-6/KP4-6行が2個目になる。
      const live = extraSnaps && extraSnaps.ym2203FmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2203fm ? extraSnaps.ym2203fm[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa', '#fff8cc'];
      const nFm = s && s.channels ? s.channels.length : 3;
      for (let ch = 0; ch < nFm; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `OP${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, ...fmVolFields(c.patch, c.rawVol),
          wave, active: c.active, ...panVolFields(c), fmPatch: c.patch || null });
      }
    }

    if (chips.includes('ym2151')) {
      // YM2151(VGM: OPM、X68000/アーケード): 4op FM×8ch(YM2612と同じFM波形表示)。
      // ch8はノイズモード(c.noise)がありうるが表示は通常のFM行(ノイズ中はfreq=0で無音符扱い)。
      const live = extraSnaps && extraSnaps.ym2151Live;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2151 ? extraSnaps.ym2151[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffd422', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa', '#fff6bb', '#fff8cc'];
      for (let ch = 0; ch < 8; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `OM${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, ...fmVolFields(c.patch, c.rawVol),
          wave, active: c.active, ...panVolFields(c), fmPatch: c.patch || null });
      }
    }

    if (chips.includes('ga20')) {
      // GA20(VGM: アイレムM92/M107 PCM): 4ch 8bit PCM。YM2610 ADPCM行(NA/NB)と同じ3段階表示:
      // サンプルピッチ解析(ga20.js samplePitch=Emu.SamplePitchUtil共有)が信頼できれば
      // 実周波数×再生レートの通常音名(adpcmExact)、できなければ「サンプル」行。
      // GA20はレートレジスタで1サンプルを音階演奏するチップなので、音程が取れれば絶対音名になる。
      // note列クリックの手動キャリブレーション(adpcmSample)もNA/NB行と共通(main.js onAdpcmCalibrate)。
      const live = extraSnaps && extraSnaps.ga20Live;
      const s = live ? live() : (extraSnaps && extraSnaps.ga20 ? extraSnaps.ga20[frameIdx] : null);
      const gaWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 4; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (170 + ch * 14) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `GA${ch + 1}`, color: `hsl(${hue},75%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: gaWave(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('k007232')) {
      // K007232(VGM: コナミ・アーケードPCM): 2ch 7bit PCM。GA1-4行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、できなければ「サンプル」行)。ピッチレジスタで
      // 1サンプルを音階演奏するチップなので、音程が取れれば絶対音名になる。
      // L/R列はch毎の左右音量レジスタ(0-255)を0-1へ正規化した値(片側0=完全に振り切り)。
      const live = extraSnaps && extraSnaps.k007232Live;
      const s = live ? live() : (extraSnaps && extraSnaps.k007232 ? extraSnaps.k007232[frameIdx] : null);
      const kWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 2; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (285 + ch * 20) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `K7${ch + 1}`, color: `hsl(${hue},75%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: kWave(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('k054539')) {
      // K054539(VGM: コナミ・アーケード8ch PCM): GA1-4行と同じ3段階表示(ピッチ解析が
      // 信頼できれば絶対音名、できなければ「サンプル」行)。24bitのピッチレジスタで
      // 1サンプルを音階演奏するチップなので、音程が取れれば絶対音名になる。
      // L/R列は定パワーのパン表(pantab)を 0-1 で出した値。8bit PCM / 16bit PCM / 4bit DPCM が混在する。
      const live = extraSnaps && extraSnaps.k054539Live;
      const s = live ? live() : (extraSnaps && extraSnaps.k054539 ? extraSnaps.k054539[frameIdx] : null);
      const kWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      // デュアルチップはスナップショットが16要素(8+8)で返る。2組目は K59-K516 行
      const nCh = s && s.length >= 16 ? 16 : 8;
      for (let ch = 0; ch < nCh; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (25 + ch * 16) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        // volApparent: 音量バー用の値(k054539.js を参照)。vol は変換が減衰dBに戻す線形振幅なので、
        //   対数レジスタのこのチップではバーが7〜13%しか動かない。★行へ渡し忘れるとバーに効かない
        channels.push({ id: `K5${ch + 1}`, color: `hsl(${hue},75%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, volApparent: c.volApparent, rawVol: c.rawVol, rawVolMax: 255,
          wave: kWave(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('msm5205')) {
      // MSM5205/6585(VGM: PC Engine CD ADPCM等): 1chストリーミングADPCM。ROMも音程レジスタも
      // 無く、さらにPC EngineのVGMはDACストリームではなく 0x32 の直書きなので、サンプルの
      // 同定キー(=波形アイコン)も取れない。OKI行と同じ「サンプル」行(音量=現在振幅)。
      const live = extraSnaps && extraSnaps.msm5205Live;
      const s = live ? live() : (extraSnaps && extraSnaps.msm5205 ? extraSnaps.msm5205[frameIdx] : null);
      const c = s ? s[0] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0 };
      channels.push({ id: 'M5', color: '#ffbb55', freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: c.rawVolMax !== undefined ? c.rawVolMax : 255,
        wave: { t: 'sample' }, active: !!c.active, sample: true, dmcReg: c.rawVol, dmcRateIdx: 15, dmcFreq: c.rate || 0,
        ...panVolFields(c) });
    }

    if (chips.includes('segapcm')) {
      // SegaPCM(VGM: OutRun/After Burner等): 16ch ステレオPCM。GA1-4行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。デルタレジスタで
      // 1サンプルを音階演奏するチップなので、音程が取れれば絶対音名になる。
      // L/R列はch毎のL/R音量(7bit)を0-15へ丸めた値。手動キャリブレーションもGA/NA行と共通。
      const live = extraSnaps && extraSnaps.segapcmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.segapcm ? extraSnaps.segapcm[frameIdx] : null);
      const spWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 16; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (200 + ch * 9) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `SP${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 127,
          wave: spWave(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('c140')) {
      // C140(VGM: ナムコSystem 2/21): 24ch ステレオPCM。SP/GA行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。System 2はメロディも
      // C140で弾く曲が多く、周波数レジスタ由来のrateがピッチベンドも追従する。
      const live = extraSnaps && extraSnaps.c140Live;
      const s = live ? live() : (extraSnaps && extraSnaps.c140 ? extraSnaps.c140[frameIdx] : null);
      const cnWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 24; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (330 + ch * 6) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `CN${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: cnWave(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('c352')) {
      // C352(VGM: ナムコSystem 11/12/22等): 32ch PCM。CN/SP/GA行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。ノイズフラグの
      // ボイス(LFSR)はサンプルが無いのでピッチ解析対象外=「サンプル」行のまま。
      const live = extraSnaps && extraSnaps.c352Live;
      const s = live ? live() : (extraSnaps && extraSnaps.c352 ? extraSnaps.c352[frameIdx] : null);
      const csWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 32; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (30 + ch * 5) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `CS${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: csWave(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('psx')) {
      // PSF(PlayStation SPU): 24ボイスのADPCMサンプル再生。C352/C140と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行=ドラム区画)。
      // スナップショットは src/emulator/psxSampleBank.js Emu.snapshotPsx が C352 と同じ形で作る。
      const live = extraSnaps && extraSnaps.psxLive;
      const s = live ? live() : (extraSnaps && extraSnaps.psx ? extraSnaps.psx[frameIdx] : null);
      const pxWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      // 行数はスナップショットの長さ(実機スロット=24ボイス、合成ch=32本。Emu.POOL_CHIP_CHANNELS.psx 参照)
      // (トラックモードは曲頭でまだレーンが1本も無いフレームが空配列になる → 0行)
      const nPx = s ? s.length : 24;
      // トラックモード(要素に lane がある。Emu.PsfTrackVoicer): 行はトラック順・声部順に並べ、行名はトラック名、
      // 色はトラックごと(声部は明るさ違い)。行ID PX<n> はレーン番号のまま(割当/変換のソースID psx:<n-1> と対応)
      const pxOrder = (s && nPx && s[0] && s[0].lane) ? psxTrackOrder(s) : null;
      for (let k = 0; k < nPx; k++) {
        const ch = pxOrder ? pxOrder.order[k] : k;
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const lane = pxOrder ? s[ch].lane : null;
        const hueNum = lane ? (lane.copyOf ? pxOrder.hueNum[ch] : (lane.track >= 0 ? lane.track : 40 + lane.groupIndex)) : 0;
        const color = lane
          // 複製は元トラックと同じ色相のまま彩度と明度を落とす(点線でも色で元が分かるように)
          ? `hsl(${(200 + hueNum * 137.508) % 360},${lane.copyOf ? 55 : 75}%,${Math.min(80, (lane.copyOf ? 45 : 58) + lane.voice * 7)}%)`
          : `hsl(${(200 + ch * 7) % 360},75%,62%)`;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `PX${ch + 1}`, color, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          ...(lane ? { label: pxOrder.label[ch], labelTitle: pxOrder.title[ch], laneGroup: pxOrder.group[ch], laneCopy: pxOrder.copy[ch] } : {}),
          wave: pxWave(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('ym2610fm')) {
      // YM2610(VGM: Neo Geo): 4op FM×4ch(YM2612と同じFM波形表示)。内蔵SSGは 'kssPsg' の
      // KP1-3行として別途出す(main.js vgmKeyboardChips)。ライブ関数優先、無ければ先読み
      // スナップショット配列(extraSnaps.ym2610fm[frameIdx]、ロール構築用)。
      const live = extraSnaps && extraSnaps.ym2610FmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2610fm ? extraSnaps.ym2610fm[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa', '#fff8cc'];
      const nFm = s && s.channels ? s.channels.length : 4; // YM2610B は6ch
      for (let ch = 0; ch < nFm; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `NF${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, ...fmVolFields(c.patch, c.rawVol),
          wave, active: c.active, ...panVolFields(c), fmPatch: c.patch || null });
      }
      // ADPCM-A(6ch)/ADPCM-B(1ch)の音程表示(3段階、adpcmPitchToMidi参照):
      //  (1) サンプルのピッチ解析(ym2610.js samplePitch: ROM上のサンプルを1回デコードして基本周期を
      //      検出、×再生レート)が信頼できる(pitchConf>=ADPCM_PITCH_CONF) → 実周波数として通常の
      //      音名表示(adpcmExact)。ADPCM-Aは「音程ごとに別サンプル」の場合、ADPCM-Bは
      //      「1サンプルをΔ-Nで音階演奏」の場合にこれで絶対音名が出る。
      //  (2) ADPCM-Bで解析が信頼できない → Δ-N由来レートを仮基準(refRate=C4)からの相対音程として
      //      表示(目安、noteに'?')。
      //  (3) ADPCM-Aで解析が信頼できない(ドラム/ノイズ等) → 音程レジスタが無い(再生レート固定
      //      18518Hz、開始/終了アドレスで別サンプルを選ぶだけ)ので DMC/RF5C164 と同じ「サンプル」行。
      // 音量=音色レベル(A)/レベル(B)、L/Rはパン。
      // 波形アイコン: ym2610.js がデコード済みサンプルから作った128点(音程あり=持続部の1周期、無し=
      // サンプル全体の概形)。無ければ従来の「サンプル」グリフ。
      // adpcmSample: 手動キャリブレーション(note列クリック→onAdpcmCalibrate)用のサンプル同定情報。
      const adpcmWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 6; ch++) {
        const c = s && s.adpcmA ? s.adpcmA[ch] : { vol: 0, rawVol: 0, rawVolMax: 31, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (20 + ch * 12) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `NA${ch + 1}`, color: `hsl(${hue},80%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 31,
          wave: adpcmWave(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
      {
        const c = s && s.adpcmB ? s.adpcmB : { vol: 0, rawVol: 0, rawVolMax: 255, active: false, panL: 1, panR: 1, rate: 0, refRate: 1, pitchHz: 0, pitchConf: 0 };
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: 'NB', color: '#cc66ff', freq: exact ? c.pitchHz : (c.rate || 0), vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: adpcmWave(c), active: !!c.active, adpcmPitch: true, adpcmExact: exact, adpcmRefRate: c.refRate || 1, adpcmRate: c.rate || 0,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto',
          ...panVolFields(c) });
      }
    }

    if (chips.includes('qsound')) {
      // QSound(VGM: カプコンCPS1ダッシュ/CPS2): 16ch PCM。CS/SP/GA行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。
      const live = extraSnaps && extraSnaps.qsoundLive;
      const s = live ? live() : (extraSnaps && extraSnaps.qsound ? extraSnaps.qsound[frameIdx] : null);
      const qsWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 16; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (260 + ch * 7) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `QS${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: qsWave(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('multipcm')) {
      // MultiPCM(VGM: セガModel 1/2/Multi 32): 28ch PCM。CS/QS行と同じ3段階表示
      // (F-number/octで1サンプルを音階演奏するチップなのでピッチ解析が通れば絶対音名)。
      const live = extraSnaps && extraSnaps.multipcmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.multipcm ? extraSnaps.multipcm[frameIdx] : null);
      const mpWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 28; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (190 + ch * 6) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `MP${ch + 1}`, color: `hsl(${hue},72%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: mpWave(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('okim6295')) {
      // OKIM6295(VGM: 東亜プラン/ライジング等): 4ch ADPCM。音程レジスタは無い(固定レート)が
      // 「音程ごとに別サンプル」方式の曲があるので、NA/GA行と同じ3段階表示
      // (フレーズのピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。モノラル。
      const live = extraSnaps && extraSnaps.okim6295Live;
      const s = live ? live() : (extraSnaps && extraSnaps.okim6295 ? extraSnaps.okim6295[frameIdx] : null);
      const okWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 4; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (100 + ch * 15) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `OK${ch + 1}`, color: `hsl(${hue},70%,58%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 0x20,
          wave: okWave(c), active: !!c.active, ...panVolFields(c),
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('okim6258')) {
      // OKIM6258(VGM: X68000 ADPCM): 1chストリーミングADPCM。ROMも音程レジスタも無いので
      // YMDA/PWMと同じ「サンプル」行(音量=現在振幅、キャプチャ時は再生中の下限0.3)。
      // 波形アイコンはDACストリームで流れているサンプルの128点(okim6258.js snapshot の waveData、
      // NA行等と同じ makeSampleWave: 音程あり=1周期/無し=全体の概形)。無ければ従来の破線
      const live = extraSnaps && extraSnaps.okim6258Live;
      const s = live ? live() : (extraSnaps && extraSnaps.okim6258 ? extraSnaps.okim6258[frameIdx] : null);
      const c = s ? s[0] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, waveData: null };
      const okiWave = (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      channels.push({ id: 'OKI', color: '#ff9944', freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: c.rawVolMax !== undefined ? c.rawVolMax : 255,
        wave: okiWave, active: !!c.active, sample: true, dmcReg: c.rawVol, dmcRateIdx: 15, dmcFreq: c.rate || 0,
        ...panVolFields(c) });
    }

    if (chips.includes('pwm')) {
      // 32X PWM(VGM): 左右2chのPCM DAC。DMC/YMDAと同じ「サンプル」行(音量=振幅)
      const live = extraSnaps && extraSnaps.pwmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.pwm ? extraSnaps.pwm[frameIdx] : null);
      // wave列は直近に流れたサンプル128点(pwm32x.js waveOf)。32X側で合成済みの
      // 1本のストリームなので音色は読み取れないが、鳴っているかは一目で分かる
      // (ユーザー要望 2026-09-09)。先読みキャプチャ側には波形が無いので従来の破線
      for (const [id, key, color] of [['PWL', 'l', '#66ddff'], ['PWR', 'r', '#ff8866']]) {
        const c = s ? s[key] : { level: 0, vol: 0, active: false };
        const w = (c.waveData && c.waveData.length)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'sample' };
        channels.push({ id, color, freq: 0, vol: c.vol, rawVol: c.level, rawVolMax: s ? s.cycle : 4095,
          wave: w, active: !!c.active, sample: true, dmcReg: c.level, dmcRateIdx: 15, dmcFreq: 0,
          panL: key === 'l' ? 1 : 0, panR: key === 'r' ? 1 : 0 });
      }
    }

    for (const [tok, prefix, liveKey] of [['rf5c164', 'RC', 'rf5c164Live'], ['rf5c68', 'RB', 'rf5c68Live']]) {
      if (!chips.includes(tok)) continue;
      // RF5C68/164(VGM): 8ch PCM。音程はサンプル依存で不明なのでDMCと同じ「サンプル」行、音量=env×パン
      const live = extraSnaps && extraSnaps[liveKey];
      const s = live ? live() : (extraSnaps && extraSnaps[tok] ? extraSnaps[tok][frameIdx] : null);
      for (let ch = 0; ch < 8; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 0, panR: 0 };
        const hue = (200 + ch * 18) % 360;
        channels.push({ id: `${prefix}${ch + 1}`, color: `hsl(${hue},70%,60%)`, freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: { t: 'sample' }, active: !!c.active, sample: true, dmcReg: c.rawVol, dmcRateIdx: 15, dmcFreq: c.rate || 0,
          ...panVolFields(c) });
      }
    }

    if (isGbs) {
      const live = extraSnaps && extraSnaps.gbsApuLive;
      const s = live ? live() : null;
      // NR50(マスター音量+VIN)/NR51(パンニング)。ライブでなければ全て0(無音扱い)。
      const nr50 = s ? s.nr50 : 0;
      const nr51 = s ? s.nr51 : 0;
      const volL = (nr50 >> 4) & 0x07, volR = nr50 & 0x07;
      const vinL = !!(nr50 & 0x80), vinR = !!(nr50 & 0x08);
      // ALL行($FF24、全体バランス。HESのALL行と同じ考え方): 実チャンネルではないので
      // L/R列(NR50のマスター音量0-7)だけを持つ。VINが有効な側は数字を黄色にする。
      channels.push({ id: 'GALL', color: '#888', isAllRow: true, panL: volL, panR: volR, vinL, vinR });
      // GB CH1/CH2(パルス+スイープ/パルス): 2A03パルス表示と同じ考え方(duty波形)。
      // エンベロープperiod=0(ハード任せでなく実質固定/ドライバ管理)は白、1-7(ハード自動増減)は黄。
      const PCOLS = [['GB1', '#66ddff'], ['GB2', '#0077dd']];
      for (let i = 0; i < 2; i++) {
        const c = s ? s['ch' + (i + 1)] : { freq: 0, vol: 0, rawVol: 0, duty: 2, envPeriod: 0, active: false };
        channels.push({ id: PCOLS[i][0], color: PCOLS[i][1], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          envMode: (c.envPeriod || 0) > 0, duty: c.duty,
          wave: { t: 'pulse', hi: APU_DUTY[c.duty], nx: 8, ny: 2 },
          active: c.active, panL: (nr51 >> (4 + i)) & 1, panR: (nr51 >> i) & 1 });
      }
      // GB CH4(ノイズ): 7bit/15bit幅モードで短周期/長周期のノイズ波形を切り替える。
      // note列は実測周波数を既存2A03ノイズ16周期の最寄りにマッチさせたindex(0-15)、
      // freq列はGB自体の実測再生速度(Hz)。note色は15bit=白/7bit=黄(ch.noiseShort)。
      {
        const c = s ? s.ch4 : { freq: 0, vol: 0, rawVol: 0, widthMode: 0, envPeriod: 0, active: false };
        channels.push({ id: 'GN', color: '#888888', freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          envMode: (c.envPeriod || 0) > 0,
          wave: { t: 'noise', short: !!c.widthMode, nx: c.widthMode ? 127 : 32767, ny: 2 },
          active: c.active, noise: true, noiseIndex: gbNoiseFreqToIndex(c.freq), noiseFreq: c.freq, noiseShort: !!c.widthMode,
          panL: (nr51 >> 7) & 1, panR: (nr51 >> 3) & 1 });
      }
      // GB CH3(波形メモリ): N163と同じ波形メモリ表示(要素数のみ異なる: GBは32点符号無し4bit)。
      // CH3にはエンベロープが無いためvol色は変更しない(envMode未設定=通常色のまま)。
      {
        const c = s ? s.ch3 : { freq: 0, vol: 0, rawVol: 0, waveData: [0, 0], active: false };
        channels.push({ id: 'GW', color: '#ffcc00', freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 3,
          wave: { t: 'wave', data: c.waveData, nx: c.waveData.length, ny: 16 },
          active: c.active, panL: (nr51 >> 6) & 1, panR: (nr51 >> 2) & 1 });
      }
    }

    if (isHes) {
      // PSG(PC Engine) 6ch: 32サンプル5bit波形音源。ch4/5はノイズモード中のみノイズ波形表示に
      // 切り替わる(hesBus.js/apuHuC6280.js参照。物理的にノイズ生成回路を持つのはch4/5のみ)。
      const live = extraSnaps && extraSnaps.hesApuLive;
      const s = live ? live() : null;
      const PCOLS = ['#66ddff', '#33aaff', '#0099ff', '#33cc99', '#ffaa00', '#ff6699'];
      // ALL行($0801、全体バランス。SPCのALL行と同じ考え方): 実チャンネルではないので
      // active/wave/note/freqは無く、L/R列だけを持つ(_rebuildRows()のisAllRow参照)。
      channels.push({
        id: 'HALL', color: '#888', isAllRow: true,
        panL: s ? s.globalPanL : 15, panR: s ? s.globalPanR : 15
      });
      for (let i = 0; i < 6; i++) {
        const c = s ? s[i] : { freq: 0, vol: 0, rawVol: 0, wave: [0, 0], noiseOn: false, active: false, dda: false, panL: 15, panR: 15 };
        const wave = c.noiseOn
          ? { t: 'noise', short: false, nx: 131071, ny: 2 }
          : { t: 'wave', data: c.wave, nx: c.wave.length, ny: 32 };
        channels.push({ id: `PSG${i}`, color: PCOLS[i], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 31,
          wave, active: c.active, noise: c.noiseOn, noiseLabel: c.noiseOn ? 'noise' : undefined,
          dda: c.dda, panL: c.panL, panR: c.panR });
      }
    }

    const letterMap = (MML.Mml && MML.Mml.assignExpansionLetters) ? MML.Mml.assignExpansionLetters(chipsToExpansions(chips)) : {};
    // part列は元々「この元chはNSF側のどのパートになるか」の表示(=既に割当表だった)。
    // 既定はgetPartLetter()のハードコード規則(従来の変換結果と同一)のままで、チャンネル割当
    // (src/convert/channelPlan.js)でユーザーが変えた行だけ、その借用先のレターへ差し替える。
    const plan = channelPlan();
    for (const c of channels) {
      const hardLetter = getPartLetter(c.id, letterMap, n163NumRows);
      if (!plan || c.isAllRow) { c.letter = hardLetter; continue; }
      c.defaultTarget = plan.defaultTarget(c.id, plan.targetOfLetter(hardLetter));
      const ent = plan.get(c.id);
      c.target = (ent && ent.target) || c.defaultTarget;
      // 既定のままなら従来どおりgetPartLetter()の文字をそのまま使う(表示を変えない)
      c.letter = (ent && ent.target) ? plan.letterOfTarget(ent.target)
        : (hardLetter || plan.letterOfTarget(c.defaultTarget));
    }

    return channels;
  }

  // 音量(0-1)を9段階(0-8)に量子化する。ピアノロールの音量シェーディングは連続値ではなく
  // 「段階的に暗く」なる見た目にするため、ノート区間の分割もこの量子化レベル単位で行う。
  const ROLL_VOL_LEVELS = 8;
  function quantizeVol(v) {
    return Math.max(0, Math.min(ROLL_VOL_LEVELS, Math.round((v || 0) * ROLL_VOL_LEVELS)));
  }

  // ── ピアノロール: フレーム単位のチャンネル状態からノート区間を抽出 ──
  // getChannelsAtFrame(frameIdx) は extractChannels() と同じ形の channels[] を返す関数。
  // 同じMIDIノート・同じ量子化音量レベルが連続する区間を1つのノートにまとめる
  // (ノイズ/サンプルチャンネルは対象外)。
  // freqSeq: DESIGN-PITCH.md Phase 0のセント偏差オーバーレイ用。ノート区間内フレーム毎の
  // 生周波数(Hz)をvolSeqと同じ「区切らず積む」考え方で保持する(丸め後のmidiは一定のまま、
  // 実際の周波数だけがビブラート等で揺れている様子を後で細線描画するため)。
  function buildNoteTimelineFromChannelFrames(getChannelsAtFrame, totalFrames, frameDur) {
    const tracks = new Map(); // id → { id, color, notes:[], cur:{startFrame,midi,drumKey,volQ,freqs}|null }
    // ドラム区画のレーン割当はここではやらない。RollBuild.vgm はチップごとに
    // この関数を別々に呼んでタイムラインを連結するので、ここで割り当てると
    // 2つのサンプルチップを積んだVGMで両方が「レーン0」から番号を振ってしまう。
    // noteにはdrumKeyだけ載せ、曲全体が揃った受け取り側で一括して割り当てる
    // (KeyboardDisplay._rebuildDrumLanes → MML.Convert.DrumMap.build)。
    const TK = MML.Convert && MML.Convert.ToneKey; // 音色キー(音色一覧パネル用。roll-builders.js toneOf と同じ役割)
    const pushNote = (track, endSec) => {
      const c = track.cur;
      const note = { startSec: c.startFrame * frameDur, endSec, midi: c.midi,
                     vol: c.volQ / ROLL_VOL_LEVELS, freqSeq: c.freqs };
      if (c.drumKey) note.drumKey = c.drumKey;
      if (c.tone) note.tone = c.tone;
      // sampleRow: サンプル再生ch(2A03 DMC/YM2612 DAC/32X PWM/RF5C…)のノート。midiは
      // レート由来の疑似音程なので「音高=楽器の区別」にならない。E(DPCM)へ載せて打楽器化する
      // ときは1発ごとに切り出して内容で束ねる必要があるため、印だけ付けておく
      // (main.js synthDrumNotes / buildSynthHits。2026-09-04)
      if (c.sampleRow) note.sampleRow = true;
      track.notes.push(note);
      track.cur = null;
    };
    for (let f = 0; f < totalFrames; f++) {
      const channels = getChannelsAtFrame(f) || [];
      for (const ch of channels) {
        let track = tracks.get(ch.id);
        if (!track) { track = { id: ch.id, color: ch.color, notes: [], tones: {}, cur: null }; tracks.set(ch.id, track); }
        track.color = ch.color;
        // laneGroup: ロールの区画キー(PSF のトラックモード)。laneCopy: 複製パート(点線で描く)
        if (ch.laneGroup !== undefined) { track.laneGroup = ch.laneGroup; track.laneCopy = !!ch.laneCopy; }
        // ノイズch/DPCM(サンプル)chはch.freqが常に0(実波形の「音程」ではないため)なので、
        // 代わりに周期選択レジスタのindex(0-15)をそのまま16音へ1:1対応させた疑似ノート番号
        // (noisePeriodIndexToMidi/dmcRateIndexToMidi冒頭コメント参照)として使う。GBSのロール
        // (main.js buildGbsRollTimeline)は元々noise.jsの周期判定で音程付きで表示できていたが、
        // この共通経路(NSF/MML再生のロール、および全フォーマット共通の鍵盤ハイライトdrawPiano)は
        // ノイズ・DPCM双方を丸ごと除外していたため、NSFのノイズ/DPCMがロールにも鍵盤にも出ない・
        // GBSのノイズが鍵盤に出ない、という食い違いになっていた。
        //  drumKey付き(打楽器として鳴っているサンプルPCM)は音程を持たないので、midiではなく
        //  drumKeyの側で同一性を判断する。以降 midi と drumKey は排他(どちらか一方だけ非null)。
        let midi, pitchFreq, drumKey = null, drumSeq = 0;
        if (!ch.active) { midi = null; pitchFreq = 0; }
        else if (ch.drumKey) { midi = null; pitchFreq = 0; drumKey = ch.drumKey; drumSeq = ch.drumSeq || 0; }
        else if (ch.noise) { midi = noisePeriodIndexToMidi(ch.noiseIndex); pitchFreq = ch.noiseFreq; }
        else if (ch.adpcmPitch) { midi = adpcmPitchToMidi(ch); pitchFreq = ch.freq; }
        else if (ch.sample) { midi = dmcRateIndexToMidi(ch.dmcRateIdx); pitchFreq = ch.dmcFreq; }
        else { midi = ch.freq ? freqToMidi(ch.freq) : null; pitchFreq = ch.freq; }
        const sounding = midi !== null || drumKey !== null;
        const volQ = sounding ? quantizeVol(ch.vol) : 0;
        const cur = track.cur;
        // drumSeqはキーオン通番。同じ太鼓を同じ音量で連打したとき(16分のハイハット等)、
        // これを見ないと区間が1本の長い棒に融合してしまう
        // ★ドラム区画(drumKey)のノートは音量変化で割らない: DPCMは出力レベル=波形そのもの、
        //   サンプルPCMも減衰はサンプル自身が持つので、割ると1打点が数十の細切れになり
        //   パッドの打点数も実トリガー数と食い違う(実測: Super C 126トリガー→1707ノート)
        if (cur && (!sounding || midi !== cur.midi || drumKey !== cur.drumKey || drumSeq !== cur.drumSeq || (!drumKey && volQ !== cur.volQ))) {
          pushNote(track, f * frameDur);
        }
        if (sounding && !track.cur) {
          // 音色キーは発音開始の瞬間だけ引く(毎フレーム引くと重い。ノート途中の音色変化は次のノートで拾う)
          let tone;
          if (TK && midi !== null) {
            tone = TK.ofLive(ch);
            if (tone && !track.tones[tone]) track.tones[tone] = TK.infoOfLive(ch, tone);
          }
          track.cur = { startFrame: f, midi, drumKey, drumSeq, volQ, freqs: [], tone,
                        sampleRow: !!ch.sample && !drumKey };
        }
        if (track.cur) track.cur.freqs.push(pitchFreq);
      }
    }
    const totalSec = totalFrames * frameDur;
    const result = [];
    for (const track of tracks.values()) {
      if (track.cur) pushNote(track, totalSec);
      result.push({ id: track.id, color: track.color, notes: track.notes, tones: track.tones });
    }
    result.frameDur = frameDur; // セント偏差オーバーレイ描画時にfreqSeqのフレーム間隔を復元するため
    return result;
  }

  // ── 間接アクセス音源の内部状態再構築 ─────────────────────────

  function buildVrc7Snapshots(writeLog) {
    const regs = new Uint8Array(64);
    let latch = 0;
    return writeLog.map(writes => {
      for (const w of writes) {
        if (w.addr === 0x9010) latch = w.value & 0x3F;
        else if (w.addr === 0x9030) regs[latch] = w.value;
      }
      return Array.from({ length: 6 }, (_, ch) => {
        const fnumLo = regs[0x10 + ch];
        const b2 = regs[0x20 + ch];
        const keyOn = !!(b2 & 0x10);
        const block = (b2 >> 1) & 7;
        const fnum = fnumLo | ((b2 & 1) << 8);
        const rawVol = regs[0x30 + ch] & 0xF; // 0=最大, 15=無音
        const vol = (15 - rawVol) / 15;
        const freq = (keyOn && fnum > 0) ? fnum * Math.pow(2, block) * 49716 / 524288 : 0;
        return { freq, vol, rawVol, active: keyOn && rawVol < 15 };
      });
    });
  }

  // 事前キャプチャ経路: writeLog($F800/$4800)から128バイトRAMを復元し、
  // フレームごとに Emu.snapshotN163() でスナップショット化する。
  function buildN163Snapshots(writeLog) {
    const ram = new Uint8Array(128);
    let latch = 0, autoInc = false;
    let maxNumCh = 1;
    const frames = writeLog.map(writes => {
      for (const w of writes) {
        if (w.addr === 0xF800) { latch = w.value & 0x7F; autoInc = !!(w.value & 0x80); }
        else if (w.addr === 0x4800) { ram[latch] = w.value; if (autoInc) latch = (latch + 1) & 0x7F; }
      }
      const snap = MML.Emu.snapshotN163(ram);
      if (snap.numCh > maxNumCh) maxNumCh = snap.numCh;
      return snap;
    });
    frames.maxNumCh = maxNumCh;
    return frames;
  }

  // ライブキャプチャ経路: capture.jsがフレームごとに採取した実チップRAM(128byte)の配列から
  // 直接スナップショット化する(writeLog再生による間接アドレッシングのポインタずれが無い、
  // buildN163Snapshots()より正確な代替)。
  function buildN163SnapshotsFromLiveRam(n163Snapshots) {
    let maxNumCh = 1;
    const frames = n163Snapshots.map(ram => {
      const snap = MML.Emu.snapshotN163(ram || new Uint8Array(128));
      if (snap.numCh > maxNumCh) maxNumCh = snap.numCh;
      return snap;
    });
    frames.maxNumCh = maxNumCh;
    return frames;
  }

  function buildFme7Snapshots(writeLog) {
    const regs = new Uint8Array(16);
    let latch = 0;
    regs[7] = 0x38;
    return writeLog.map(writes => {
      for (const w of writes) {
        if (w.addr === 0xC000) latch = w.value & 0xF;
        else if (w.addr === 0xE000) regs[latch] = w.value;
      }
      return Array.from({ length: 3 }, (_, ch) => {
        const period = regs[ch * 2] | ((regs[ch * 2 + 1] & 0xF) << 8);
        const toneOn = !((regs[7] >> ch) & 1);
        const noiseOn = !((regs[7] >> (3 + ch)) & 1);
        const rawVol = regs[8 + ch] & 0xF;
        const vol = rawVol / 15;
        // 実機5B/AYは +1 しない。f = CPU/(32*period)。
        const freq = (toneOn && period > 0) ? CPU_CLOCK / (32 * period) : 0;
        // ノイズ単独(@2)はトーンが止まっていても発音中(Emu.snapshotFME7と同じ判定)
        return { freq, vol, rawVol, noise: noiseOn,
                 active: toneOn ? (vol > 0 && freq > 0) : (noiseOn && vol > 0) };
      });
    });
  }

  // ── 鍵盤描画 ────────────────────────────────────────────────

  // 演奏入力で押している鍵の色(チャンネル色と衝突しにくい彩度の高い青緑)
  const PERFORM_KEY_COLOR = '#22d3ee';

  function keyX(midi, wkW) {
    if (midi < MIDI_MIN || midi > MIDI_MAX) return null;
    const rel = midi - MIDI_MIN;
    const oct = Math.floor(rel / 12);
    const semi = rel % 12;
    if (!IS_BLACK[semi]) {
      return { x: (oct * 7 + WHITE_IDX[semi]) * wkW, isBlack: false };
    }
    const lw = oct * 7 + WHITE_IDX[semi - 1];
    return { x: (lw + 1) * wkW, isBlack: true };
  }

  // ── 素波形アイコン描画 ────────────────────────────────────────
  // ピッチ・音量を含まない、そのチャンネルの1周期ぶんの生波形を表示する。

  // 位相 phase(0..1) に対する正規化振幅 (-1..1)
  function waveSampleValue(wave, phase) {
    switch (wave.t) {
      case 'pulse': return phase < wave.hi ? 1 : -1;
      case 'tri': {
        // NES三角波: 32ステップ / 16段の階段波 (15→0→15)
        const step = Math.floor(phase * 32) % 32;
        const v = step < 16 ? (15 - step) : (step - 16); // 0..15
        return (v / 15) * 2 - 1;
      }
      case 'saw': {
        // VRC6のこぎり波: 8bitアキュムレータへ蓄積レートを6回加算→リセットの7段階段状。
        // 出力は上位5bit(0-31)。実機通り&0xFFで折り返すので、レート43以上は桁溢れで
        // 波形が崩れる(src/emulator/expansion/vrc6.js Vrc6Saw.clock()と同じ計算)。
        // rate未指定(ロール等の静的アイコン)は理想形(=レート42相当)
        const step = Math.floor(phase * 7) % 7;
        const rate = wave.rate == null ? 42 : wave.rate;
        const out = ((step * rate) & 0xFF) >> 3;
        return (out / 31) * 2 - 1;
      }
      case 'fm':    return Math.sin(phase * Math.PI * 2);
      case 'wave': {
        const d = wave.data;
        if (!d.length) return 0;
        if (wave.smooth) {
          // FM等の連続波形: サンプル間を線形補間して滑らかな曲線にする
          const x = phase * d.length;
          const i0 = Math.floor(x) % d.length;
          const i1 = (i0 + 1) % d.length;
          const f = x - Math.floor(x);
          return d[i0] * (1 - f) + d[i1] * f;
        }
        // ウェーブテーブル(N163等)は本当に階段状なので最近傍
        return d[Math.floor(phase * d.length) % d.length];
      }
    }
    return 0;
  }

  // 波形クリップボード用: そのチャンネルの1周期ぶんを具体的な数値配列にして返す。
  // pulse/saw/tri等はwave.hi等のパラメータだけで実データ配列を持たないため
  // waveSampleValue()で一定解像度サンプリングして配列化する。noise(LFSR)/fm(実データ
  // 無しの代替アイコン)/sample(固有波形無し)はコピー対象外としてnullを返す
  function getCopyableWaveSamples(wave) {
    if (!wave) return null;
    if (wave.t === 'wave') {
      // SPCの多層波形は素のBRR値(層0)を代表として使う
      if (wave.layers && wave.layers.length && wave.layers[0].data && wave.layers[0].data.length) {
        return Array.from(wave.layers[0].data);
      }
      return (wave.data && wave.data.length) ? Array.from(wave.data) : null;
    }
    if (wave.t === 'pulse' || wave.t === 'saw' || wave.t === 'tri') {
      const resolution = Math.max(8, Math.min(256, wave.nx || 32));
      const arr = [];
      for (let i = 0; i < resolution; i++) arr.push(waveSampleValue(wave, i / resolution));
      return arr;
    }
    return null;
  }

  // 再描画要否判定用シグネチャ（形状 or 表示状態が変わった時だけ描き直す）
  function waveSig(wave, on) {
    if (!wave) return 'x';
    let s = wave.t + (on ? '1' : '0');
    if (wave.t === 'pulse') s += wave.hi.toFixed(3);
    else if (wave.t === 'saw') s += wave.rate == null ? '' : wave.rate;
    else if (wave.t === 'noise') s += wave.short ? 'S' : 'L';
    else if (wave.t === 'wave') {
      if (wave.layers) {
        // SPCの多層波形(素/ガウス補間/PM変調後)は各レイヤーをまとめてハッシュ化
        for (const layer of wave.layers) {
          const d = layer.data;
          let h = d.length;
          for (let i = 0; i < d.length; i++) h = (h * 31 + Math.round(d[i] * 1000)) | 0;
          if (layer.xs) for (let i = 0; i < layer.xs.length; i++) h = (h * 31 + Math.round(layer.xs[i] * 1000)) | 0;
          s += ':' + d.length + ':' + h;
        }
      } else if (wave.sig) {
        s += ':' + wave.sig; // DPCM等の大容量データはキャッシュキー(addr:len)で判定しハッシュ省略
      } else {
        const d = wave.data;
        let h = d.length;
        for (let i = 0; i < d.length; i++) h = (h * 31 + Math.round(d[i] * 100)) | 0;
        s += ':' + d.length + ':' + h;
      }
    }
    return s;
  }

  // ノイズを離散バー(階段)で描く。周期全体(短=93 / 長=32767)を表示幅ぶんに間引いて
  // 1周期を表現する（長周期は省略表示）。X軸 0..周期-1 と対応。
  function drawNoiseStairs(ctx, short, x0, w, mid, amp) {
    const period = short ? 93 : 32767;
    const maxBars = Math.max(8, Math.floor(w / 3)); // 1バー最低3px確保
    const bars = Math.min(period, maxBars);
    const barW = w / bars;
    let sr = 1, step = 0;
    ctx.beginPath();
    for (let k = 0; k < bars; k++) {
      const target = Math.round(k * (period - 1) / Math.max(1, bars - 1));
      while (step < target) { // LFSR を target ステップまで進める
        const b0 = sr & 1;
        const other = short ? ((sr >> 6) & 1) : ((sr >> 1) & 1);
        sr = (sr >> 1) | ((b0 ^ other) << 14);
        step++;
      }
      const y = mid - ((sr & 1) ? -1 : 1) * amp; // bit0=0→出力ON(上), 1→無音(下)
      const xa = x0 + k * barW, xb = x0 + (k + 1) * barW;
      if (k === 0) ctx.moveTo(xa, y); else ctx.lineTo(xa, y);
      ctx.lineTo(xb, y);
    }
    ctx.stroke();
  }

  function drawWaveIcon(canvas, wave, color, on) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!wave) return;
    const mid = H / 2, amp = H / 2 - 3;
    ctx.strokeStyle = on ? color : '#4a4a58';
    ctx.lineWidth = on ? 2 : 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();

    if (wave.t === 'sample') {
      // DMC/PCM: 固有波形なし。中央に破線を引く
      ctx.setLineDash([4, 4]);
      ctx.moveTo(3, mid); ctx.lineTo(W - 3, mid);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    if (wave.t === 'noise') {
      // 1周期を表示幅ぶんに間引いた離散バーで描画（short/longで異なるパターン）
      drawNoiseStairs(ctx, wave.short, 0, W, mid, amp);
      return;
    }

    const PERIODS = 2; // 周期性が読み取れるよう2周期ぶん描く
    for (let x = 0; x <= W; x++) {
      const phase = ((x / W) * PERIODS) % 1;
      const y = mid - waveSampleValue(wave, phase) * amp;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 波形タイプの表示名
  function waveTypeLabel(wave) {
    if (!wave) return '';
    switch (wave.t) {
      case 'pulse':  return 'Pulse';
      case 'tri':    return 'Triangle';
      case 'saw':    return 'Sawtooth';
      case 'noise':  return 'Noise (' + (wave.short ? 'short' : 'long') + ')';
      case 'wave':
        if (wave.layers) return wave.layers.length > 2
          ? T('BRR (素 + ガウス補間 + PM)') : T('BRR (素 + ガウス補間)');
        return wave.smooth ? 'FM' : (wave.pcm ? 'DPCM' : 'Wavetable');
      case 'fm':     return 'FM';
      case 'sample': return 'PCM (DMC)';
    }
    return wave.t;
  }

  // ── FM音色データのテキスト化(大波形表示の下に出す・コピー用) ──
  // 数値行は各値を width 桁に右寄せして sep で繋ぎ、見出し行(コメント)は同じ幅のラベルを " " で
  // 繋ぐので列が縦に揃う(ユーザー指定の書式:
  //   ; TL FB
  //     20, 0,
  //   ; AR DR SL RR KL ML AM VB EG KR DT
  //     15, 4, 2, 4, 0, 1, 0, 0, 1, 0, 0,
  //     15, 4, 2, 4, 0, 1, 0, 0, 1, 0, 0
  // )。表示は行ごとに「コメント(先頭が ; の行、または行中の ; 以降)」と「データ」を色分けする
  // (renderFmPatchHtml)。書式はドライバごとに選べる(FM_PATCH_FORMATS、localStorageに保存)。
  // 各書式の並びは公式ドキュメントで確認済み:
  //   PMD    : `; nm alg fbl` / `@nnn alg fbl` / `; ar dr sr rr sl tl ks ml dt ams` ×op1-4 (3桁ゼロ埋めが慣例)
  //   FMP7   : `'@ FA n` / `'@ AR,DR,SR,RR,SL,TL,KS,ML,DT,AM` ×4 / `'@ AL,FB` (' の無い行はコメント)
  //   MUCOM88: `  @n`(先頭空白2つ以上) / `FB,AL` / `AR,DR,SR,RR,SL,TL,KS,ML,DT ; opN` ×4
  //   op1..op4 はいずれも論理順(op2=レジスタ+8)。SSG-EGはPMD/FMP7/MUCOM88の書式に無いので、
  //   使われている時だけコメントで添える。
  //   OPLL系: @OT(このツール/mck、MGSDRV互換の並び)、@v(MGSDRV)、@OP(生8バイト、mck)。
  const FM_PATCH_FORMATS = {
    opn:  [{ id: 'pmd', label: 'PMD' }, { id: 'fmp7', label: 'FMP7' }, { id: 'mucom88', label: 'MUCOM88' }, { id: 'regs', label: 'レジスタ(バイナリ)' }],
    opll: [{ id: 'ot', label: '@OT (mck)' }, { id: 'mgs', label: '@v (MGSDRV)' }, { id: 'op', label: '@OP (バイナリ8バイト)' }]
  };
  const FM_PATCH_FMT_KEY = { opn: 'kbdFmPatchFmtOpn', opll: 'kbdFmPatchFmtOpll' };
  function getFmPatchFormat(type) {
    const list = FM_PATCH_FORMATS[type] || [];
    let id = null;
    try { id = localStorage.getItem(FM_PATCH_FMT_KEY[type]); } catch (e) { /* ignore */ }
    return list.some(f => f.id === id) ? id : (list[0] ? list[0].id : null);
  }
  function setFmPatchFormat(type, id) {
    try { localStorage.setItem(FM_PATCH_FMT_KEY[type], id); } catch (e) { /* ignore */ }
  }

  function fmtPatchRows(width, groups, sep, indent) {
    // groups: [{ labels:[...], rows:[[...],[...]], prefix?, tail?:[..] }, ...]
    sep = sep === undefined ? ',' : sep; indent = indent === undefined ? '  ' : indent;
    const lines = [];
    for (const g of groups) {
      if (g.labels) lines.push('; ' + g.labels.map(l => String(l).padStart(width)).join(' '));
      g.rows.forEach((row, i) => {
        const tail = g.tails && g.tails[i] ? g.tails[i] : '';
        lines.push((g.prefix !== undefined ? g.prefix : indent) + row.map(v => String(v).padStart(width)).join(sep) + (g.trailingComma === false ? '' : ',') + tail);
      });
    }
    // 最終行の末尾カンマだけ落とす(コメント末尾なら手前のデータ行)
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*;/.test(lines[i])) continue;
      lines[i] = lines[i].replace(/,(\s*;.*)?$/, '$1');
      break;
    }
    return lines.join('\n');
  }

  // ---- OPLL / VRC7 (YM2413系) ----
  const opllOpRow = (o) => [o.AR, o.DR, o.SL, o.RR, o.KL, o.ML, o.AM, o.PM, o.EG, o.KR, o.WF];
  const OPLL_OP_LABELS = ['AR', 'DR', 'SL', 'RR', 'KL', 'ML', 'AM', 'VB', 'EG', 'KR', 'DT'];
  // {mod,car} → VRC7/OPLLのカスタム音色レジスタ8バイト(lexer.js parseVrc7ToneAltDef / vrc7.js dump2patch の逆)
  function opllPatchBytes(p) {
    const m = p.mod, c = p.car;
    return [
      ((m.AM & 1) << 7) | ((m.PM & 1) << 6) | ((m.EG & 1) << 5) | ((m.KR & 1) << 4) | (m.ML & 15),
      ((c.AM & 1) << 7) | ((c.PM & 1) << 6) | ((c.EG & 1) << 5) | ((c.KR & 1) << 4) | (c.ML & 15),
      ((m.KL & 3) << 6) | (m.TL & 63),
      ((c.KL & 3) << 6) | ((c.WF & 1) << 4) | ((m.WF & 1) << 3) | (m.FB & 7),
      ((m.AR & 15) << 4) | (m.DR & 15),
      ((c.AR & 15) << 4) | (c.DR & 15),
      ((m.SL & 15) << 4) | (m.RR & 15),
      ((c.SL & 15) << 4) | (c.RR & 15)
    ];
  }
  function formatOpllPatch(p, fmt, ch) {
    const m = p.mod, c = p.car;
    const head = `; ${ch.id} inst ${p.inst}${p.inst === 0 ? ' (user)' : ' (ROM)'}`;
    if (fmt === 'op') {
      return head + '\n@OP0 = {\n  ' + opllPatchBytes(p).map(b => '$' + b.toString(16).toUpperCase().padStart(2, '0')).join(',') + '\n}';
    }
    const body = fmtPatchRows(2, [
      { labels: ['TL', 'FB'], rows: [[m.TL, m.FB]] },
      { labels: OPLL_OP_LABELS, rows: [opllOpRow(m), opllOpRow(c)] }
    ]);
    if (fmt === 'mgs') return head + '\n@v0 = {\n' + body + '\n}';
    return head + '\n@OT0 = {\n' + body + '\n}';
  }

  // ---- OPN (YM2612 / YM2610) ----
  function opnExtraComments(p) {
    const lines = [];
    if (p.ops.some(o => o.SE)) lines.push('; ssg-eg ' + p.ops.map(o => o.SE).join(' ') + ' (op1..op4)');
    // OPM(YM2151)のみ: DT2(粗デチューン 0/+600/+781/+950セント)。OPNには無いフィールド
    if (p.ops.some(o => o.DT2)) lines.push('; dt2 ' + p.ops.map(o => o.DT2 || 0).join(' ') + ' (op1..op4)');
    lines.push(`; ams ${p.AMS} pms ${p.PMS} pan ${p.L ? 'L' : '-'}${p.R ? 'R' : '-'}`);
    return lines.join('\n');
  }
  function formatOpnPatch(p, fmt, ch) {
    const head = `; ${ch.id}`;
    const pmdRow = (o) => [o.AR, o.DR, o.SR, o.RR, o.SL, o.TL, o.KS, o.ML, o.DT, o.AM];
    if (fmt === 'fmp7') {
      const body = fmtPatchRows(3, [
        { labels: ['AR', 'DR', 'SR', 'RR', 'SL', 'TL', 'KS', 'ML', 'DT', 'AM'], rows: p.ops.map(pmdRow), prefix: "'@ ", trailingComma: false },
        { labels: ['AL', 'FB'], rows: [[p.AL, p.FB]], prefix: "'@ ", trailingComma: false }
      ]);
      return `${head}\n'@ FA 0\n` + body + '\n' + opnExtraComments(p);
    }
    if (fmt === 'mucom88') {
      const body = fmtPatchRows(3, [
        { labels: ['FB', 'AL'], rows: [[p.FB, p.AL]], prefix: '   ', trailingComma: false },
        { labels: ['AR', 'DR', 'SR', 'RR', 'SL', 'TL', 'KS', 'ML', 'DT'], rows: p.ops.map(o => [o.AR, o.DR, o.SR, o.RR, o.SL, o.TL, o.KS, o.ML, o.DT]),
          prefix: '  ', trailingComma: false, tails: [' ; op1', ' ; op2', ' ; op3', ' ; op4'] }
      ]);
      return `${head}\n  @0\n` + body + '\n' + opnExtraComments(p);
    }
    if (fmt === 'regs') {
      // レジスタ順(op1,op3,op2,op4)で $30〜$90 の各グループと $B0/$B4。ch1相当のオフセット0で表記
      const regOrder = [0, 2, 1, 3]; // 論理op → レジスタスロット順に並べ替え
      const hx = (v) => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
      const grp = (label, f) => `; ${label}\n  ` + regOrder.map(i => hx(f(p.ops[i]))).join(',');
      return [head + ' (register order op1,op3,op2,op4 = +0,+4,+8,+12)',
        grp('$30 DT/ML', o => (o.DT << 4) | o.ML),
        grp('$40 TL', o => o.TL),
        grp('$50 KS/AR', o => (o.KS << 6) | o.AR),
        grp('$60 AM/DR', o => (o.AM << 7) | o.DR),
        grp('$70 SR', o => o.SR),
        grp('$80 SL/RR', o => (o.SL << 4) | o.RR),
        grp('$90 SSG-EG', o => o.SE),
        '; $B0 FB/AL\n  ' + hx((p.FB << 3) | p.AL),
        '; $B4 L/R/AMS/PMS\n  ' + hx((p.L << 7) | (p.R << 6) | (p.AMS << 4) | p.PMS)
      ].join('\n');
    }
    // PMD(既定): 3桁ゼロ埋め・空白区切りが慣例
    const z3 = (v) => String(v).padStart(3, '0');
    const lines = [head, '; nm  alg fbl', `@000 ${z3(p.AL)} ${z3(p.FB)}`, ';  ar  dr  sr  rr  sl  tl  ks  ml  dt ams'];
    for (const o of p.ops) lines.push(' ' + pmdRow(o).map(z3).join(' '));
    lines.push(opnExtraComments(p));
    return lines.join('\n');
  }

  // ch.fmPatch → 表示テキスト(無ければnull)。fmt省略時は保存済み/既定の書式
  function formatFmPatch(ch, fmt) {
    const p = ch && ch.fmPatch;
    if (!p) return null;
    const f = fmt || getFmPatchFormat(p.type);
    if (p.type === 'opll') return formatOpllPatch(p, f, ch);
    if (p.type === 'opn') return formatOpnPatch(p, f, ch);
    return null;
  }
  // テキスト → 色分けHTML(コメント=先頭';'の行と行中の';'以降、それ以外=データ)
  function renderFmPatchHtml(text) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text.split('\n').map((line) => {
      const i = line.indexOf(';');
      if (i < 0) return `<span class="kbd-patch-data">${esc(line)}</span>`;
      if (/^\s*;/.test(line)) return `<span class="kbd-patch-comment">${esc(line)}</span>`;
      return `<span class="kbd-patch-data">${esc(line.slice(0, i))}</span><span class="kbd-patch-comment">${esc(line.slice(i))}</span>`;
    }).join('\n');
  }

  // ── SPC エンベロープ(env列)アイコン描画 ─────────────────────────
  // ADSRモード限定: AR/DR/SL/SRの生値から模式的なエンベロープ形状(Attack→Decay→
  // Sustain→Release)を描く。レートが速いほど傾きが急峻になる簡易表現（時間軸は正確ではない）。
  function drawEnvIcon(canvas, env, color, on) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!env || env.mode !== 'adsr') return;
    const arT = env.ar / 15, drT = env.dr / 7;
    const slY = env.sl / 7; // サステインレベル 0-7 → 0-1
    const wA = 3 + (1 - arT) * (W * 0.30);
    const wD = 3 + (1 - drT) * (W * 0.24);
    const wS = W * 0.18;
    const wR = Math.max(3, W - wA - wD - wS - 2);
    const x0 = 1, yTop = 2, yBase = H - 2;
    const ySus = yBase - slY * (yBase - yTop);
    ctx.strokeStyle = on ? color : '#4a4a58';
    ctx.lineWidth = on ? 1.6 : 1.2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, yBase);
    ctx.lineTo(x0 + wA, yTop);                  // Attack
    ctx.lineTo(x0 + wA + wD, ySus);              // Decay → Sustain level
    ctx.lineTo(x0 + wA + wD + wS, ySus);         // Sustain (簡易的に水平)
    ctx.lineTo(x0 + wA + wD + wS + wR, yBase);   // Release
    ctx.stroke();
  }

  // 再描画要否判定用シグネチャ（大波形用: 形状＋要素数）
  function bigWaveSig(wave) {
    if (!wave) return 'x';
    return waveSig(wave, true) + '|' + wave.nx + 'x' + wave.ny;
  }

  // 選択チャンネルの素波形を拡大表示する。表示サイズ固定・1周期ぶん。
  // 軸目盛りは0始まりで、原点0は左下1か所のみ、各軸の最大値(要素数-1)を端に表示する。
  function drawBigWave(canvas, wave, color) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    // 全ての余白・線幅・フォントサイズは基準解像度560px幅に対して調整済みの値を
    // Sでスケールする（キャンバス解像度を変えても比率を保ったまま拡大縮小できる）。
    const S = W / 560;
    // signed: SPC(BRR)のような符号付き16bit系列。桁数が多く("-32768"等)、
    // 既定の余白・フォントだと左端からはみ出すため余白を広げてフォントを一段階小さくする。
    const signed = !!(wave && wave.signed);
    // 軸ラベル用の余白（左=Y目盛り, 下=X目盛り）
    const mL = (signed ? 74 : 56) * S, mR = 18 * S, mT = 14 * S, mB = 38 * S;
    const x0 = mL, x1 = W - mR, y0 = mT, y1 = H - mB;
    const w = x1 - x0, mid = (y0 + y1) / 2, amp = (y1 - y0) / 2;
    const tickGap = 8 * S;

    // プロット枠・中心線
    ctx.strokeStyle = '#3a3a46';
    ctx.lineWidth = 1 * S;
    ctx.strokeRect(x0, y0, w, y1 - y0);
    ctx.beginPath();
    ctx.setLineDash([3 * S, 5 * S]);
    ctx.moveTo(x0, mid); ctx.lineTo(x1, mid);
    ctx.strokeStyle = '#4a4a58';
    ctx.stroke();
    ctx.setLineDash([]);

    if (!wave || wave.t === 'sample') {
      ctx.fillStyle = '#777788';
      ctx.font = Math.round(20 * S) + 'px ' + fontStack('sans');
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(wave ? 'PCM (no fixed waveform)' : '—', (x0 + x1) / 2, mid);
      return;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5 * S;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (wave.t === 'noise') {
      // 1周期を間引いた離散バーで表示（短=93=実1周期 / 長=32767を省略表示）
      drawNoiseStairs(ctx, wave.short, x0, w, mid, amp);
    } else if (wave.t === 'wave' && wave.layers) {
      // SPC: 素のBRR値(階段状+ドット、他のウェーブテーブル表示と同じ最近傍表現)・
      // ガウス補間後の滑らかな波形(線)・PM変調後(破線)を重ね描き＋凡例
      for (const layer of wave.layers) {
        const d = layer.data;
        if (!d || !d.length) continue;
        ctx.strokeStyle = layer.color;
        ctx.fillStyle = layer.color;
        ctx.setLineDash((layer.dash || []).map(v => v * S));
        if (layer.mode === 'steps') {
          // 階段状(最近傍)表示。BRRデコード直後の生サンプル値をそのまま示す。
          ctx.lineWidth = 2 * S;
          ctx.beginPath();
          for (let i = 0; i <= w; i++) {
            const phase = (i / w) % 1;
            const idx = Math.floor(phase * d.length) % d.length;
            const y = mid - d[idx] * amp;
            const x = x0 + i;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
          // サンプル点をドット表示（要素数が視覚的に分かる）
          for (let k = 0; k < d.length; k++) {
            const x = x0 + (k / d.length) * w;
            const y = mid - d[k] * amp;
            ctx.beginPath();
            ctx.arc(x, y, 3 * S, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (layer.mode === 'dots') {
          // 出力サンプル(点)。xs[k] は横位置(0〜1、サンプル位置/16)。hollow は輪郭だけ(PM変調後)
          ctx.lineWidth = 1.5 * S;
          for (let k = 0; k < d.length; k++) {
            const x = x0 + (layer.xs ? layer.xs[k] : k / d.length) * w;
            const y = mid - d[k] * amp;
            ctx.beginPath();
            ctx.arc(x, y, 3 * S, 0, Math.PI * 2);
            if (layer.hollow) ctx.stroke(); else ctx.fill();
          }
        } else {
          // ガウス補間後: 連続的な線形補間曲線(横軸=サンプル位置、BRRの階段と同じ)
          ctx.lineWidth = 2.2 * S;
          ctx.beginPath();
          for (let i = 0; i <= w; i++) {
            const phase = (i / w) % 1;
            const x2 = phase * d.length;
            const i0 = Math.floor(x2) % d.length;
            const i1 = (i0 + 1) % d.length;
            const f = x2 - Math.floor(x2);
            const val = d[i0] * (1 - f) + d[i1] * f;
            const y = mid - val * amp;
            const x = x0 + i;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      // 凡例（プロット左上に色見本＋ラベル）
      ctx.font = Math.round(13 * S) + 'px ' + fontStack('sans');
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      let ly = y0 + 4 * S;
      for (const layer of wave.layers) {
        ctx.fillStyle = layer.color;
        ctx.fillRect(x0 + 4 * S, ly + 2 * S, 10 * S, 3 * S);
        ctx.fillText(layer.label, x0 + 18 * S, ly);
        ly += 15 * S;
      }
    } else {
      ctx.beginPath();
      for (let i = 0; i <= w; i++) {
        const phase = (i / w) % 1; // 全音源1周期ぶん
        const y = mid - waveSampleValue(wave, phase) * amp;
        const x = x0 + i;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // ウェーブテーブルは各サンプル点をドット表示（要素数が視覚的に分かる）。
      // FM(smooth)の連続波形やDPCMのような大容量データはドットを省く（線のみ）。
      if (wave.t === 'wave' && !wave.smooth && wave.data && wave.data.length && wave.data.length <= 256) {
        const d = wave.data;
        ctx.fillStyle = color;
        for (let k = 0; k < d.length; k++) {
          const x = x0 + (k / d.length) * w;
          const y = mid - d[k] * amp;
          ctx.beginPath();
          ctx.arc(x, y, 3 * S, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    if (wave.smooth) {
      // FM等の連続波形: 要素数(描画解像度)や振幅は素の値が存在しない(音階/音量/EG依存)
      // ため数値目盛りは出さない。位相=1周期・中心0(相対波形)だけを示す。
      ctx.fillStyle = '#8a8a98';
      ctx.font = Math.round(17 * S) + 'px ' + fontStack('sans');
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText('0', x0 - tickGap, mid); // Y中心(ゼロ交差)のみ
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(T('1 周期 (相対波形)'), x0 + w / 2, y1 + tickGap);
    } else {
      // ウェーブテーブル等: 軸目盛り。signed=trueのPCM系(BRR等)は符号付きレンジ
      // (-ny 〜 0 〜 ny-1。例: ny=32768 なら -32768〜0〜32767)、それ以外は
      // 従来通り0始まり(0 〜 ny-1)で表示する。
      ctx.fillStyle = '#b6b6c6';
      // canvasは var() 非対応。実フォント名を指定
      ctx.font = Math.round((signed ? 18 : 22) * S) + 'px ' + fontStack('mono');
      const nxMax = wave.nx - 1, nyMax = wave.ny - 1;
      const nxMid = Math.floor(nxMax / 2);
      let yBottomLabel, yMidLabel;
      if (signed) {
        yBottomLabel = String(-wave.ny);
        yMidLabel = '0';
      } else {
        const nyMid = Math.floor(nyMax / 2);
        yBottomLabel = '0';
        yMidLabel = nyMid > 0 ? String(nyMid) : null;
      }
      // Y軸（左）: 下=yBottomLabel → 上=nyMax(signed時は符号付き最大値と一致)
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(yBottomLabel, x0 - tickGap, y1);                   // 原点/最小値 (左下)
      if (yMidLabel !== null) ctx.fillText(yMidLabel, x0 - tickGap, mid); // Y中間
      ctx.fillText(String(nyMax), x0 - tickGap, y0);                  // Y最大 (左上)
      // X軸（下）: 左=0 → 右=nxMax
      ctx.textBaseline = 'top';
      if (nxMid > 0) { ctx.textAlign = 'center'; ctx.fillText(String(nxMid), x0 + w / 2, y1 + tickGap); } // X中間
      ctx.textAlign = 'right'; ctx.fillText(String(nxMax), x1, y1 + tickGap); // X最大 (右下)
    }
  }

  // 鍵盤描画。orientation='vertical'(既定)は横並びの鍵盤(鍵の長さ=canvasの高さ、黒鍵は
  // 上=ロール側に付く)、'horizontal'は縦並びの鍵盤(鍵の長さ=canvasの幅、黒鍵は右=ロール側に
  // 付く、高音が上)。音程軸の座標はロール側と同じkeyX()を共有する。
  // visibleWhite/offsetWhite(省略可): 鍵盤全体でなく白鍵visibleWhite本ぶんの音程窓を、白鍵offsetWhite
  // (小数可)から表示する(チャンネルごとのレーン用。ロール側と同じ窓を使う)
  // drums: {lanes:[{label,color}], laneOf:Map(drumKey→レーン番号)} ドラム区画のパッド。
  // 省略/空なら区画なし(音程軸の座標は従来と完全に一致する)。
  // performNotes: 演奏入力(src/ui/performInput.js)で今押されている音のMIDIノート番号。
  // 再生中のチャンネルとは別の色(アクセント色)で点灯させ、自分が弾いた音を区別できるようにする
  function drawPiano(canvas, channels, orientation, visibleWhite, offsetWhite, drums, performNotes) {
    const vertical = orientation !== 'horizontal';
    // 内部解像度は表示サイズ(CSS px、border除く)に合わせる。表示サイズは_cachedWidth/_cachedHeight
    // (ResizeObserverでキャッシュ)を優先し、毎フレームoffsetWidth/clientHeightを読んで
    // 強制レイアウトが走るのを避ける
    const newW = canvas._cachedWidth || canvas.clientWidth || (vertical ? 560 : PIANO_KEY_LEN);
    const newH = canvas._cachedHeight || canvas.clientHeight || (vertical ? PIANO_KEY_LEN : 560);
    if (newW === 0 || newH === 0) return;
    if (canvas.width !== newW) canvas.width = newW;   // サイズ変化時のみ再割り当て（毎フレームのリフロー防止）
    if (canvas.height !== newH) canvas.height = newH;
    const W = canvas.width, H = canvas.height;
    const pitchLen = vertical ? W : H;   // 音程軸の長さ
    const keyLen = vertical ? H : W;     // 鍵の長さ
    const drumLanes = (drums && drums.lanes) || [];
    const drumUnits = drumLanes.length * DRUM_LANE_WHITE;
    const wkW = pitchLen / (visibleWhite || (TOTAL_WHITE + drumUnits));  // 白鍵1本の太さ(音程軸方向)
    const offPx = (offsetWhite || 0) * wkW;  // 表示窓の低音側の端(px)。keyX()の結果からこれを引く
    const drumLaneW = DRUM_LANE_WHITE * wkW;
    const pitchOff = drumUnits * wkW - offPx; // 音程側の座標補正(ドラム区画ぶん右へ + 窓スクロール)
    const bkW = Math.max(3, wkW * 0.60); // 黒鍵の太さ
    const bkH = Math.round(keyLen * 0.62); // 黒鍵の長さ
    const ctx = canvas.getContext('2d');
    // ★クリック位置→ノート番号の逆写像(_noteAtPoint)のために、この描画で使った幾何を
    //   canvasへ焼き付けておく。向き・レーンごとの音程窓・ドラム区画の有無で値が変わるため、
    //   逆写像側で計算し直すと必ずどこかの組み合わせでずれる
    canvas._pianoGeom = { vertical, wkW, bkW, bkH, pitchOff, pitchLen, keyLen, W, H };

    const keyColors = {};
    const laneColors = {}; // ドラム区画: レーン番号 → 今そこを鳴らしているchの色
    for (const ch of channels) {
      if (!ch.active) continue;
      // 打楽器として鳴っているサンプルPCMは音程を持たないのでドラム区画のパッドを光らせる
      if (ch.drumKey && drums && drums.laneOf) {
        const lane = drums.laneOf.get(ch.drumKey);
        if (lane !== undefined && laneColors[lane] === undefined) laneColors[lane] = ch.color;
        continue;
      }
      // パッドに載っている行(_applyPadKeys)で打点が当たっていない間は、音程鍵盤側は光らせない
      // (レート由来の疑似音程D#2に貼り付いて見えるのを避ける)
      if (ch.padRow) continue;
      // ノイズch/DPCM(サンプル)chはそれぞれch.noiseIndex/ch.dmcRateIdxを疑似ノートとして使う
      // (noisePeriodIndexToMidi/dmcRateIndexToMidi冒頭コメント参照)。YM2610 ADPCM-A/Bは
      // 解析済みピッチ(adpcmExact)またはDelta-N由来レートを adpcmPitchToMidi で音程へ。
      const midi = ch.noise ? noisePeriodIndexToMidi(ch.noiseIndex)
        : ch.adpcmPitch ? adpcmPitchToMidi(ch)
        : ch.sample ? dmcRateIndexToMidi(ch.dmcRateIdx)
        : (ch.freq ? freqToMidi(ch.freq) : null);
      if (midi !== null && !keyColors[midi]) keyColors[midi] = ch.color;
    }
    // 自分が弾いている音は再生中の音より手前(上書き)で光らせる
    for (const m of (performNotes || [])) keyColors[m] = PERFORM_KEY_COLOR;

    ctx.clearRect(0, 0, W, H);

    // ドラム区画のパッド(鍵盤の代わり)。1パッド=1サンプル。手前側(=ロールと反対の端)に
    // レーン色の帯とラベルを出し、鳴っている間は鍵と同じくchの色で点灯する。
    for (let i = 0; i < drumLanes.length; i++) {
      const x0 = i * drumLaneW - offPx;
      if (x0 + drumLaneW < 0 || x0 > pitchLen) continue; // 表示窓の外
      const laneColor = drumLanes[i].color || DRUM_OTHER_COLOR;
      const lit = laneColors[i];
      ctx.fillStyle = lit || '#2f2c3a';
      ctx.strokeStyle = '#44404a';
      ctx.lineWidth = 0.5;
      if (vertical) {
        ctx.fillRect(x0 + 0.5, 0.5, drumLaneW - 1, keyLen - 1);
        ctx.strokeRect(x0 + 0.5, 0.5, drumLaneW - 1, keyLen - 1);
        ctx.fillStyle = laneColor; // ロール側(上端)にレーン色の帯 = ロールの打点の塗りと同じ色
        ctx.fillRect(x0 + 1.5, 1.5, drumLaneW - 3, 5);
        if (drumLaneW >= 9) { // ラベルは縦書き(90度回転)。レーンが細いときは省略
          ctx.save();
          ctx.translate(x0 + drumLaneW / 2, keyLen - 5);
          ctx.rotate(-Math.PI / 2);
          ctx.fillStyle = lit ? '#1a1830' : '#a9a3bb';
          ctx.font = Math.min(9, Math.floor(drumLaneW) - 2) + 'px ' + fontStack('mono');
          ctx.textBaseline = 'middle';
          // ★名前はユーザーが自由に付けられるので、パッドの長さに収める(はみ出すと
          //   隣のレーンや音程鍵盤の上に文字が乗る)
          ctx.fillText(drumLanes[i].label, 0, 0, keyLen - 10);
          ctx.restore();
        }
      } else {
        const y = H - x0 - drumLaneW;
        ctx.fillRect(0.5, y + 0.5, keyLen - 1, drumLaneW - 1);
        ctx.strokeRect(0.5, y + 0.5, keyLen - 1, drumLaneW - 1);
        ctx.fillStyle = laneColor; // ロール側(右端)にレーン色の帯
        ctx.fillRect(keyLen - 6.5, y + 1.5, 5, drumLaneW - 3);
        if (drumLaneW >= 9) {
          ctx.fillStyle = lit ? '#1a1830' : '#a9a3bb';
          ctx.font = Math.min(9, Math.floor(drumLaneW) - 2) + 'px ' + fontStack('mono');
          ctx.textBaseline = 'middle';
          ctx.fillText(drumLanes[i].label, 4, y + drumLaneW / 2 + 0.5, keyLen - 12);
        }
      }
    }

    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      const rel = midi - MIDI_MIN;
      const semi = rel % 12;
      if (IS_BLACK[semi]) continue;
      const pos = keyX(midi, wkW);
      if (!pos) continue;
      pos.x += pitchOff;
      if (pos.x + wkW < 0 || pos.x > pitchLen) continue; // 表示窓の外
      const color = keyColors[midi];
      ctx.fillStyle = color ? color : '#d4cfbc';
      ctx.strokeStyle = '#44404a';
      ctx.lineWidth = 0.5;
      if (vertical) {
        ctx.fillRect(pos.x + 0.5, 0.5, wkW - 1, keyLen - 1);
        ctx.strokeRect(pos.x + 0.5, 0.5, wkW - 1, keyLen - 1);
        if (color) { // 発音中: 手前(下端)に濃い帯
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.55;
          ctx.fillRect(pos.x + 0.5, keyLen - 8, wkW - 1, 7);
          ctx.globalAlpha = 1;
        }
        // Cの音名(横向きと同じく鍵に書く)。黒鍵に隠れない手前側=下端寄りへ
        if (semi === 0 && wkW >= 8) {
          ctx.fillStyle = color ? '#1a1830' : '#6b6b7a';
          ctx.font = Math.min(9, Math.floor(wkW) - 1) + 'px ' + fontStack('sans');
          ctx.textBaseline = 'bottom';
          ctx.fillText(midiToName(midi), pos.x + 2, keyLen - 9);
        }
      } else {
        const y = H - pos.x - wkW; // 高音が上: 音程軸pをcanvasの下から上へ
        ctx.fillRect(0.5, y + 0.5, keyLen - 1, wkW - 1);
        ctx.strokeRect(0.5, y + 0.5, keyLen - 1, wkW - 1);
        if (color) { // 発音中: 手前(左端)に濃い帯
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.55;
          ctx.fillRect(1, y + 0.5, 7, wkW - 1);
          ctx.globalAlpha = 1;
        }
        // Cの音名は鍵の上(黒鍵に隠れない手前側)に書く。鍵が細すぎるときは省略する
        if (semi === 0 && wkW >= 8) {
          ctx.fillStyle = color ? '#1a1830' : '#6b6b7a';
          ctx.font = Math.min(9, Math.floor(wkW) - 1) + 'px ' + fontStack('sans');
          ctx.textBaseline = 'middle';
          ctx.fillText(midiToName(midi), 10, y + wkW / 2 + 0.5);
        }
      }
    }

    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      const rel = midi - MIDI_MIN;
      const semi = rel % 12;
      if (!IS_BLACK[semi]) continue;
      const pos = keyX(midi, wkW);
      if (!pos) continue;
      pos.x += pitchOff;
      if (pos.x + bkW < 0 || pos.x - bkW > pitchLen) continue; // 表示窓の外
      const color = keyColors[midi];
      ctx.fillStyle = color ? color : '#1a1830';
      if (vertical) {
        ctx.fillRect(pos.x - bkW / 2, 0, bkW, bkH);
        if (color) {
          ctx.fillStyle = '#1a1830';
          ctx.globalAlpha = 0.35;
          ctx.fillRect(pos.x - bkW / 2, 0, bkW, bkH * 0.65);
          ctx.globalAlpha = 1;
        }
      } else {
        const y = H - pos.x - bkW / 2;
        ctx.fillRect(keyLen - bkH, y, bkH, bkW); // 黒鍵はロール側(右端)に付く
        if (color) {
          ctx.fillStyle = '#1a1830';
          ctx.globalAlpha = 0.35;
          ctx.fillRect(keyLen - bkH * 0.65, y, bkH * 0.65, bkW);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  // ── KeyboardDisplay クラス ────────────────────────────────────

  class KeyboardDisplay {
    constructor(container) {
      this.container = container;
      container._kbdInstance = this; // 検証/デバッグ用の逆参照(DevToolsからインスタンスに触るため)
      this._state = null;
      this._extraSnaps = null;
      this._chips = [];
      this._rowEls = [];
      this._prevChannels = [];
      this._muteState = new Map(); // channelId → true(muted)
      this._spcVoices = [];       // SPC ボイス状態 [{label,freq,vol,active,color,wave,muted,rawVol,env,volL,volR,pmOn,noiseOn,echoOn}]
      this._spcRowEls = [];       // SPC 用行要素(V0-V7)
      this._spcAllRow = null;     // SPC ALL行(マスター音量/エコー/FIRフィルタ)要素
      this._prevSpcVoices = [];   // 大波形選択用の直近SPCボイス状態
      this._mode = 'nsf';         // 'nsf' | 'spc' — 再生中のファイル種別に応じて表示を排他切替
      this._lastDmc4011 = null;   // DMC $4011 直接書き込み検出用（前回のレジスタ値）
      this._speedDenom = 1;        // 再生速度分母(1〜8。実速度=1/_speedDenom)
      this._rollTimeline = null;  // ピアノロール用ノート区間 [{color, notes:[{startSec,endSec,midi}]}]
      this._drumLanes = [];       // ドラム区画のレーン表 [{key,label,color,subN}](_rebuildDrumLanes)
      this._drumLaneOf = new Map(); // drumKey → レーン番号(鍵盤のパッド点灯用)
      this._drumLaneNames = {};   // drumKey → ユーザーが付けた表示名(ドラム(DPCM)パネルから同期)
      this._rollCursor = {};      // track.id → 「もう画面上端より上に流れ去った」最初のnote index(_renderRollの走査起点キャッシュ)
      this._rollSongTimeBase = 0; // 最後に実測位置が更新された時点での「曲内基準の経過時間」(確定値)
      this._rollLastRawPos = null; // 直前に_renderRollへ渡された実時間(壁時計)位置
      this._rollBaseWallMs = null; // _rollSongTimeBase確定時点のperformance.now()(補間の起点)
      this.onMuteChange = null;
      // 割当プレビュー(「割当先の音で聴く」)。セッション内だけの状態(再読込で必ずOFF=元の音)
      this._previewMode = false;
      this.onPreviewChange = null;      // () => void  ON/OFF・割当・ミュートが変わったとき(main.js syncAssignPreview)
      this.spcLiveRows = null;          // () => rows[] SPC再生中のボイス状態(main.js spcPreviewRows)。getLiveChannels()が使う
      this._poolModes = {};             // チャンネルプール式チップの表示モード(chipToken → 'logical'|'phys')
      this.onPoolModeChange = null;     // (chipToken, mode) => void  ヘッダのモード切替
      this.onSpcMuteChange = null; // (voiceIndex:number, muted:bool) => void
      this.onSpeedChange = null;   // (factor:number) => void  曲切替をまたいで保持する
      this.onMasterVolumeChange = null; // (vol:0〜1) => void  曲切替をまたいで保持する
      this.onLayoutChange = null;       // (layout) => void  setLayout()で設定が変わった時
      this.onRollSeek = null;           // (seconds:実時間) => 実際にシークした秒|null  ロールのドラッグシーク(_attachRollSeekDrag)
      this._rollDrag = null;            // ドラッグシーク中の状態 {id,x,y,startPos,pos,moved}
      this._spotlightHoverId = null;    // スポットライト(案D): ホバー中の行のch.id(一時的)
      this._spotlightPinnedId = null;   // スポットライト(案D): ch名クリックで固定した行のch.id(ホバーより優先)
      this._rollSeekBarEls = null;      // ロール見出し行に置くシークバー要素(setRollSeekBar)
      this._lanes = [];                 // チャンネルごとのレーン [{id, laneEl, rollCanvas, pianoCanvas, offWhite, visWhite}](_rebuildLanes)
      this._laneSizes = new Map();      // id → レーンの音程軸方向のpx。スプリッターで変えた分だけ入る(空=既定の自動割り付け)
      this._lanesEl = null;
      this._sizeObserver = null;
      this._sourceInfo = null;          // 表示中の再生ソース {kind, name}(setSourceInfo)。タイトル行のバッジに出す
      this._srcBadgeEl = null;
      this._titleEl = null;
      this._transportEl = null;         // タイトル行の再生コントロール(⏮ ▶/⏸ ■ ⏭)。バッジの右に置く
      this._transportBtns = null;       // { prev, play, stop, next }
      // 再生コントロールの状態(main.js が setTransportState() で更新する)。canPrevNext は
      // 「m3u/アーカイブを開いていればその曲送り、実ファイル単体なら曲番号送り」が可能か
      // どうかで、MML再生を表示中は常に false(=グレーアウト)。
      this._transportState = { playing: false, canPlay: false, canStop: false, canPrevNext: false, canToggleSource: false };
      this.onTransport = null;          // (action:'play'|'stop'|'prev'|'next') => void
      this.onSourceToggle = null;       // () => void  バッジ(MML/FILE)クリックでMML↔サウンドファイル切替
      this.onSourceListRequest = null;  // () => { name, listName?, items:[string]|null, index } | null  表示名(アーカイブなら曲名)と曲一覧(main.js)
      this.onSourceSelect = null;       // (index) => void  ファイル名の一覧から曲を選んだとき
      this._rollLastDrawnPos = 0;       // _renderRoll()が最後に描いた曲内秒(ドラッグ開始位置の基準)
      this._pendingSelectionReset = false; // reset()が立てるフラグ。次に実データでチャンネル一覧が
                                            // 判明した時(setSource()/updateSpcVoices())、大波形の選択
                                            // (_selectedId)がそこにも存在すれば維持・無ければ一番若い
                                            // chへ切替える一度きりの判定を行う(_consumePendingSelectionReset)
      this._masterVolume = loadMasterVolume(); // localStorage永続化(mml_masterVolume)
      this.onVolumeChange = null;       // () => void  ch別音量バー操作時(getVolumeConfig()参照)
      this.onAdpcmCalibrate = null;     // (ch) => void  YM2610 ADPCM行のnote列クリック(手動ピッチ補正。ch.adpcmSample={kind,start,end})
      // ドラム区画のパッドクリック試聴。(sampleKey, mode:'raw'|'dpcm') => void
      // ★PCM→DMCは必ず劣化するので、レートを耳で決められることが必須(ユーザー指示)。
      //   パッドは1枚=1サンプルなので「複数chが同時に鳴っていて何を聴いているか分からない」
      //   問題が原理的に起きない。
      this.onDrumAudition = null;
      this._drumAuditionMode = 'raw';
      this.onOpenDrumPanel = null;    // 割当セルの「パッド」ボタン(ドラム(DPCM)パネルを開く)
      this.onOpenTonePanel = null;    // (chId) => void 音色セレクトの「音色ごとに指定…」(音色一覧を開く。main.js)
      this.toneOverrideCount = null;  // (chId) => number そのchの音色のうち音色ごとの指定を持つ数(main.js)
      this.onOpenFile = null;         // ヘッダの「ファイルを開く」
      this.onToMml = null;            // ヘッダの「to MML」
      this.onMaxSecondsChange = null; // ロール見出しの演奏最大時間(秒)が変わったとき (sec) => void
      this.onExport = null;           // ロール見出しの「出力」 (formatId, seconds) => void
      this._exportOpt = null;         // setExportControls() の最後の内容(見出し再構築時に戻す)
      this._exportFmtSig = null;      // 出力形式リストの中身(変わった時だけ作り直す)
      this.onRepeatModeChange = null; // 曲が終わった後の挙動が変わったとき
      this._repeatBtnEl = null;
      this._repeatMode = 'next';
      try {
        const m = localStorage.getItem(REPEAT_MODE_KEY);
        if (m && REPEAT_MODES.indexOf(m) >= 0) this._repeatMode = m;
      } catch (e) { /* ignore */ }
      // (ch, kind:'drum'|'pitch'|null) => void  note列の小メニューでの打楽器/音階の手動指定
      this.onSampleKind = null;
      this._sampleMenuEl = null;
      this._sampleMenuOutside = null;
      this.onSpcVolumeChange = null;    // (volArray:number[8]) => void
      this._channelVolumes = loadChannelVolumes();   // channelId → 0〜2(1=100%、localStorage永続化)
      this._spcVoiceVolumes = loadSpcVoiceVolumes(); // [V0..V7] → 0〜2(1=100%、localStorage永続化)
      this._colorOverrides = loadColorOverrides(); // channelId → ユーザー指定色(localStorage永続化)
      // チャンネル割当(案E): 一覧に「借用先」列を出すか(トグル状態はlocalStorage永続化)。
      // 幅が足りないレイアウトでは列を隠し、part列チップ→ポップオーバー経由で編集する。
      try { this._assignMode = localStorage.getItem('mml_kbdAssignMode') === '1'; } catch (e) { this._assignMode = false; }
      this._assignPop = null;
      this._assignPopClose = null;
      this._layout = loadLayoutSettings();         // ロールの向き/置き場/一覧の多段(localStorage永続化)
      // 下配置でのロール高さ / 右配置での一覧幅(どちらもスプリッターで変更、localStorage永続化)
      this._rollHeight = ROLL_CANVAS_HEIGHT;
      // 一覧/大波形のサイズ(スプリッターで可変。0=未設定でCSS既定)
      this._listRowsHeight = 0;
      this._bigWaveWidth = 0;
      try {
        const rh = parseInt(localStorage.getItem('mml_keyboardRowsHeight'), 10);
        if (Number.isFinite(rh) && rh >= 60) this._listRowsHeight = rh;
        const ww = parseInt(localStorage.getItem('mml_keyboardWaveWidth'), 10);
        if (Number.isFinite(ww) && ww >= 120) this._bigWaveWidth = ww;
      } catch (e) { /* ignore */ }
      this._listWidth = null;
      try {
        const h = parseInt(localStorage.getItem('mml_pianoRollHeight'), 10);
        if (Number.isFinite(h) && h >= 80) this._rollHeight = h;
        const w = parseInt(localStorage.getItem('mml_keyboardListWidth'), 10);
        if (Number.isFinite(w) && w >= 200) this._listWidth = w;
      } catch (e) { /* ignore */ }
      this._rollCollapsed = false;
      this._bigWaveCollapsed = false;
      // ファイル情報ペイン(開いているサウンドファイルのヘッダ情報。旧「サウンドファイルを開く」
      // ウィンドウから移設)。置き場は _layout.fileInfoPlacement、大きさはスプリッターで可変
      this._fileInfoWidth = 0;
      this._fileInfoHeight = 0;
      this._fileInfoCollapsed = false;
      try {
        const fw = parseInt(localStorage.getItem('mml_kbdFileInfoWidth'), 10);
        if (Number.isFinite(fw) && fw >= 120) this._fileInfoWidth = fw;
        const fh = parseInt(localStorage.getItem('mml_kbdFileInfoHeight'), 10);
        if (Number.isFinite(fh) && fh >= 48) this._fileInfoHeight = fh;
        this._fileInfoCollapsed = localStorage.getItem('mml_kbdFileInfoCollapsed') === '1';
      } catch (e) { /* ignore */ }
      // 音源(チップ)ごとのch一覧の折りたたみ。キーは見出し文字列(getChannelDisplay().header)
      // そのもの。音源単位で覚えておきたい設定なので曲やフォーマットをまたいで残す
      this._chipCollapsed = new Set();
      try {
        const raw = JSON.parse(localStorage.getItem('mml_kbdChipCollapsed') || '[]');
        if (Array.isArray(raw)) this._chipCollapsed = new Set(raw.filter(v => typeof v === 'string'));
      } catch (e) { /* ignore */ }
      this._fileInfoTitleKey = '';  // 見出しの原文(日本語)。言語切替のたびにT()で引き直す
      this._fileInfoNodes = [];     // main.jsから預かった表示要素(#xxxFileHeader / #xxxFileStatus)
      this._build();

      /*
       * 言語切替時の作り直し。行のtitle等は "P1 ミュート" のようにチャンネル名を
       * 埋め込んだ文字列なので、i18nDom.js のDOM走査(辞書の完全一致で引く)では
       * 訳せない。T()を通す生成処理そのものを走らせ直す必要がある。
       */
      if (MML.I18n) {
        MML.I18n.onChange(() => {
          const mode = this._mode;
          this._build();               // ウィジェット枠(速度ラベル/ロール見出し/コピーボタン)を作り直す
          // _build() がコンテナを空にするので、行要素の参照も捨てて次のupdate()で作り直させる
          this._rowEls = [];
          this._spcRowEls = [];
          this._spcAllRow = null;
          if (this._prevChannels) this._rebuildRows(this._prevChannels);
          this.setMode(mode);
        });
      }
    }

    _build() {
      // ロールペインは別ウィンドウ(#pianoRollDisplay)に取り付けられていることがあり、
      // container.innerHTML=''では消えないので明示的に外す(言語切替時の作り直し用)
      if (this._rollPaneEl && this._rollPaneEl.parentNode) this._rollPaneEl.parentNode.removeChild(this._rollPaneEl);
      this.container.innerHTML = '';
      this._selectedId = null;   // 大波形表示にユーザーが選んだチャンネルID(ファイル読込でのみリセット)
      this._shownWaveId = null;  // 大波形に今表示しているチャンネルID(選択chが一覧に無い間は若いchを一時表示、_syncShownWave参照)
      this._bigWaveSig = '';     // 大波形の再描画要否判定用

      // 上段: 左=速度バー+チャンネル一覧(+大波形の詳細帯) / 右=選択波形の拡大表示 or ロールペイン
      // (置き場はレイアウト設定で決まる: _mountBigWave()/_mountRollPane()参照。
      //  SPCモードは列数が多いため setMode() で専用レイアウトに切り替える)
      const main = document.createElement('div');
      main.className = 'kbd-main';
      this._mainEl = main;

      const left = document.createElement('div');
      left.className = 'kbd-left';
      this._leftEl = left;

      // マスター音量バー(0〜100%)。フォーマットを問わず全ての音声出力に効く
      // (MML.Audio.getMasterGain、src/audio/stream-player.js参照)。速度バーの
      // すぐ左に置く。localStorageへ即保存し、次回起動時も値を維持する。
      const masterVolBar = document.createElement('div');
      masterVolBar.className = 'kbd-mastervol kbd-mastervol--header';
      const initialPct = Math.round((this._masterVolume != null ? this._masterVolume : 1) * 100);
      masterVolBar.innerHTML =
        `<span class="kbd-mastervol-label">${T('音量')}</span>` +
        `<input type="range" class="kbd-mastervol-range" min="0" max="100" step="1" value="${initialPct}">` +
        `<span class="kbd-mastervol-value">${initialPct}%</span>`;
      const masterVolRange = masterVolBar.querySelector('.kbd-mastervol-range');
      const masterVolValueEl = masterVolBar.querySelector('.kbd-mastervol-value');
      masterVolRange.addEventListener('input', () => {
        const pct = parseInt(masterVolRange.value, 10) || 0;
        const vol = pct / 100;
        this._masterVolume = vol;
        masterVolValueEl.textContent = `${pct}%`;
        saveMasterVolume(vol);
        if (this.onMasterVolumeChange) this.onMasterVolumeChange(vol);
      });

      // 再生速度バー(1/1〜1/8)。音程を保ったままテンポだけを落とす。
      // ウィンドウのタイトル行(タイトル文字の右)に置く。本体側は毎回_build()で
      // 作り直されるため、タイトル行に前回挿入した分を先に取り除いてから差し替える。
      const speedBar = document.createElement('div');
      speedBar.className = 'kbd-speed kbd-speed--header';
      speedBar.innerHTML =
        `<span class="kbd-speed-label">${T('速度')}</span>` +
        `<input type="range" class="kbd-speed-range" min="1" max="8" step="1" value="1">` +
        `<span class="kbd-speed-value">1/1</span>`;
      const speedRange = speedBar.querySelector('.kbd-speed-range');
      const speedValueEl = speedBar.querySelector('.kbd-speed-value');
      speedRange.value = String(this._speedDenom || 1);
      speedValueEl.textContent = `1/${this._speedDenom || 1}`;
      speedRange.addEventListener('input', () => {
        const denom = parseInt(speedRange.value, 10) || 1;
        this._speedDenom = denom;
        speedValueEl.textContent = `1/${denom}`;
        if (this.onSpeedChange) this.onSpeedChange(1 / denom);
      });
      // レイアウト設定ボタン(⚙)。クリックでポップオーバー(_openLayoutPopover)を開く。
      // 速度バーの右(閉じるボタンの手前)に置く
      const layoutBtn = document.createElement('button');
      layoutBtn.type = 'button';
      layoutBtn.className = 'kbd-layout-btn';
      layoutBtn.title = T('鍵盤表示のレイアウト設定');
      layoutBtn.setAttribute('aria-label', T('鍵盤表示のレイアウト設定'));
      layoutBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="1"/><path d="M3 12h14M9 3v9"/></svg>';
      layoutBtn.addEventListener('click', (e) => { e.stopPropagation(); this._openLayoutPopover(layoutBtn); });

      // 再生コントロール(⏮ ▶/⏸ ■ ⏭)。バッジ(=今どちらを表示中かのファイル名)の右に置き、
      // 「今鳴っている方(MML側 / サウンドファイル側)」をそのまま操作する。⏮⏭ は
      // アーカイブ(m3u)を開いていればその曲送り、実ファイル単体なら曲番号送りで、
      // MML再生を表示中は操作対象が無いのでグレーアウトする(setTransportState)。
      const transportBar = this._buildTransportBar();
      // 曲が終わった後の挙動(次の曲 / 1曲リピート / ランダム / 停止)。1つのアイコンが
      // クリックのたびに切り替わる。ファイル名バッジの左に置く
      const repeatBtn = this._buildRepeatBtn();
      // ファイルを開く / to MML。ヘッダ左端(旧「鍵盤表示」の文字の位置)へ移す。
      // 元のツールバー側のボタンをそのまま押す複製なので、動作の実体は1箇所のまま
      const openBtn = this._buildProxyBtn('kbd-open-btn', T('ファイルを開く'),
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5c0-.83.67-1.5 1.5-1.5h3.4l1.4 1.6H16c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5v-8.6Z"/></svg>',
        () => { if (this.onOpenFile) this.onOpenFile(); });
      const toMmlBtn = this._buildProxyBtn('kbd-tomml-btn', T('MMLへ変換'),
        '<span class="kbd-tomml-text">to MML</span>',
        () => { if (this.onToMml) this.onToMml(); });

      const winEl = this.container.closest('.float-window');
      const headerEl = winEl && winEl.querySelector('.float-window-header');
      if (headerEl) {
        for (const sel of ['.kbd-mastervol', '.kbd-speed', '.kbd-layout-btn', '.kbd-src-badge', '.kbd-transport']) {
          const old = headerEl.querySelector(sel);
          if (old) old.remove();
        }
        for (const sel of ['.kbd-open-btn', '.kbd-tomml-btn', '.kbd-repeat-btn', '.kbd-src-name']) {
          const old = headerEl.querySelector(sel);
          if (old) old.remove();
        }
        const closeBtn = headerEl.querySelector('.float-window-close');
        headerEl.insertBefore(speedBar, closeBtn || null);
        headerEl.insertBefore(masterVolBar, speedBar);
        // ★ヘッダ左端は「鍵盤表示」という文字ではなく[ファイルを開く][レイアウト][to MML]。
        //   タイトル文字はウィンドウの見出しとして自明なので置かない(ユーザー指示)
        const titleEl = headerEl.querySelector('span');
        if (titleEl && !titleEl.classList.contains('kbd-src-badge')) {
          titleEl.textContent = '';
          titleEl.style.display = 'none';
          this._titleEl = titleEl;
        }
        // 並びは [ファイルを開く][to MML][レイアウト](ユーザー指示で to MML と レイアウトを入れ替え)
        headerEl.insertBefore(openBtn, titleEl || masterVolBar);
        headerEl.insertBefore(toMmlBtn, titleEl || masterVolBar);
        headerEl.insertBefore(layoutBtn, titleEl || masterVolBar);
        this._srcBadgeEl = document.createElement('span');
        this._srcBadgeEl.className = 'kbd-src-badge';
        this._srcBadgeEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!this._transportState.canToggleSource) return;
          if (this.onSourceToggle) this.onSourceToggle();
        });
        // 並びは [再生コントロール][MML/FILEバッジ][終了後の挙動][ファイル名/リスト名](ユーザー指示 2026-09-06)。
        // バッジは「今どちらを表示しているか」だけを示し、名前は右の別ボタンに出す。名前のボタンは
        // 曲一覧(アーカイブのm3u/複数曲形式の曲番号)から選べるドロップダウンになる
        this._srcNameEl = document.createElement('button');
        this._srcNameEl.type = 'button';
        this._srcNameEl.className = 'kbd-hdr-btn kbd-src-name';
        this._srcNameEl.addEventListener('click', (e) => { e.stopPropagation(); this._openSourcePopover(); });
        headerEl.insertBefore(this._srcBadgeEl, masterVolBar);
        headerEl.insertBefore(this._srcNameEl, masterVolBar);
        headerEl.insertBefore(transportBar, this._srcBadgeEl);
        headerEl.insertBefore(repeatBtn, this._srcNameEl);
        this._renderSourceBadge();
        this._renderTransport();
      } else {
        left.appendChild(transportBar); // フォールバック(タイトル行が見つからない場合)
        left.appendChild(masterVolBar);
        left.appendChild(speedBar);

        left.appendChild(layoutBtn);
        this._renderTransport();
      }

      const header = document.createElement('div');
      header.className = 'kbd-header';
      header.innerHTML =
        headerAssignBtnHtml() +
        headerMuteAllBtnHtml() +
        `<span class="kbd-h-name">ch</span>` +
        `<span class="kbd-h-assign">${T('借用先')}${headerPreviewBtnHtml()}${headerAssignModeHtml()}</span>` +
        `<span class="kbds-h-lr kbds-h-l">L</span>` +
        `<span class="kbds-h-lr">R</span>` +
        headerVolResetBtnHtml() +
        `<span class="kbd-h-wave">wave</span>` +
        `<span class="kbd-h-note">note</span>` +
        `<span class="kbd-h-freq">freq</span>`;
      // L/R列(SPCのステレオパン表示と同じクラスを流用)はHES(PSG)のみ値が入り、
      // 他フォーマットは空欄のまま(_rebuildRows参照)。
      // dot 列オフセット不要（kbd-h-part が dot+パート文字両方をカバー）
      this._headerEl = header;
      // DPCM(打楽器を実サンプルのまま焼く)の実コスト表示。借用先にDPCMを選んだ瞬間に
      // 「1本増やしたらROMが何KB増えるか」が見えないと選びようがないため、割当UIのすぐ下に出す
      // (ユーザー要望。実機ROMの容量を意識する方針 [[nsf-export-size-consciousness]])
      this._dpcmCostEl = document.createElement('div');
      this._dpcmCostEl.className = 'kbd-dpcm-cost';
      this._dpcmCostEl.style.display = 'none';
      // ドラムパッドの下ごしらえ(分離レンダリング)の進捗。曲の長さぶん再エミュレーション
      // するので数十秒〜数分かかる。ドラム(DPCM)パネルを開いていないと何も起きていないように
      // 見えてしまうため、パッドと同じ鍵盤表示の中にも出す(ユーザー要望 2026-09-09)
      this._dpcmStatusEl = document.createElement('div');
      this._dpcmStatusEl.className = 'kbd-dpcm-status';
      this._dpcmStatusEl.style.display = 'none';
      this._dpcmStatusEl.innerHTML = '<span class="kbd-dpcm-status-text"></span>' +
        '<span class="kbd-dpcm-status-bar"><i></i></span>';
      left.appendChild(header);

      this._rowsEl = document.createElement('div');
      this._rowsEl.className = 'kbd-rows';
      // 行本体は内側の要素に入れる(.kbd-rowsは縦スクロールの箱、.kbd-rows-innerが1列/多段の
      // 並べ方を担当。多段のとき高さauto=中身なりに伸びるので、はみ出しは横でなく縦スクロールになる)
      left.appendChild(this._dpcmCostEl);
      left.appendChild(this._dpcmStatusEl);
      this._rowsInnerEl = document.createElement('div');
      this._rowsInnerEl.className = 'kbd-rows-inner';
      this._rowsEl.appendChild(this._rowsInnerEl);
      left.appendChild(this._rowsEl);

      // SPC ボイス用セクション（再生中のみ表示）。列数がNSFと異なるため専用ヘッダーを持つが、
      // NSF側と同じく left 直下に置く（left 側の幅は .kbd-left--spc で少し広げる）。
      // ボイス単位のレジスタが無いマスター値(エコー音量L/R、FIR係数C0-C7)は列にせず、
      // ALL行の下の1行(.kbds-master、updateSpcVoices参照)にまとめて表示する。
      this._spcHeaderEl = document.createElement('div');
      this._spcHeaderEl.className = 'kbd-header kbds-header';
      this._spcHeaderEl.style.display = 'none';
      this._spcHeaderEl.innerHTML =
        headerAssignBtnHtml() +
        headerMuteAllBtnHtml() +
        `<span class="kbd-h-name">ch</span>` +
        `<span class="kbd-h-assign">${T('借用先')}${headerPreviewBtnHtml()}${headerAssignModeHtml()}</span>` +
        `<span class="kbds-h-lr kbds-h-l">L</span>` +
        `<span class="kbds-h-lr">R</span>` +
        headerVolResetBtnHtml() +
        `<span class="kbds-h-env">env</span>` +
        `<span class="kbd-h-wave">wave</span>` +
        `<span class="kbds-h-pm">PM</span>` +
        `<span class="kbd-h-note">note</span>` +
        `<span class="kbds-h-freq">freq</span>` +
        `<span class="kbds-h-echo">echo</span>`;
      left.appendChild(this._spcHeaderEl);

      this._spcSectionEl = document.createElement('div');
      this._spcSectionEl.className = 'kbd-rows';
      this._spcSectionEl.style.display = 'none';
      left.appendChild(this._spcSectionEl);

      // 見出しのボタン(part列=チャンネル割当トグル / mute列=一括ミュート)を配線する。
      // メイン一覧とSPC一覧で見出しが2つあるので、両方まとめて拾って同じ動作にする。
      this._assignBtns = Array.prototype.slice.call(left.querySelectorAll('.kbd-assign-btn'));
      for (const b of this._assignBtns) {
        b.addEventListener('click', (e) => { e.stopPropagation(); this._setAssignMode(!this._assignMode); });
      }
      this._previewBtns = Array.prototype.slice.call(left.querySelectorAll('.kbd-preview-btn'));
      for (const b of this._previewBtns) {
        b.addEventListener('click', (e) => { e.stopPropagation(); this._setPreviewMode(!this._previewMode); });
      }
      this._renderPreviewToggle();
      this._muteAllBtns = Array.prototype.slice.call(left.querySelectorAll('.kbd-muteall-btn'));
      for (const b of this._muteAllBtns) {
        b.addEventListener('click', (e) => { e.stopPropagation(); this._toggleAllMute(); });
      }
      for (const b of left.querySelectorAll('.kbd-volreset-btn')) {
        b.addEventListener('click', (e) => { e.stopPropagation(); this._resetAllVolumes(); });
      }

      // 選択チャンネルの素波形を拡大表示（表示サイズ固定・要素数はX/Y数値で表現）。
      // 置き場は一覧の右(従来)または一覧の下の折りたたみ帯(_mountBigWave()参照)
      const big = document.createElement('div');
      big.className = 'kbd-bigwave';
      const bigHeader = document.createElement('div');
      bigHeader.className = 'kbd-bigwave-header';
      // 折りたたみトグル(一覧の下に置く配置でだけ表示。状態はlocalStorageに保存)。既定は畳んだ状態
      // (一覧の高さを優先)で、波形アイコンをクリックして選んだときに自動で開く(_selectWave参照)
      try { this._bigWaveCollapsed = localStorage.getItem('mml_bigWaveCollapsed') !== '0'; } catch (e) { this._bigWaveCollapsed = true; }
      this._bigToggleEl = document.createElement('span');
      this._bigToggleEl.className = 'kbd-bigwave-toggle';
      this._bigToggleEl.textContent = this._bigWaveCollapsed ? '▶' : '▼';
      this._bigToggleEl.title = T('大波形の表示/非表示');
      this._bigToggleEl.addEventListener('click', () => {
        this._bigWaveCollapsed = !this._bigWaveCollapsed;
        try { localStorage.setItem('mml_bigWaveCollapsed', this._bigWaveCollapsed ? '1' : '0'); } catch (e) { /* ignore */ }
        this._applyLayoutClasses();
      });
      this._bigTitleEl = document.createElement('div');
      this._bigTitleEl.className = 'kbd-bigwave-title';
      this._bigTitleEl.textContent = 'Click a wave icon to enlarge';
      // 波形エディタ(FDS波形エディタ等)との相互コピペ用。実際の波形テーブルを
      // 持つ表示(t:'wave')のときだけ有効化する(ノイズ/PCM等は固有波形が無いため不可)
      this._bigCopyBtn = document.createElement('button');
      this._bigCopyBtn.className = 'kbd-bigwave-copy secondary';
      this._bigCopyBtn.textContent = T('📋波形');
      this._bigCopyBtn.title = T('この波形データをクリップボードへコピー(他の波形エディタへ貼り付け可)');
      this._bigCopyBtn.disabled = true;
      this._bigWaveCopyData = null;
      this._bigCopyBtn.addEventListener('click', () => {
        if (!this._bigWaveCopyData || !(MML.UI && MML.UI.WaveClipboard)) return;
        MML.UI.WaveClipboard.copyValues(this._bigWaveCopyData).then((ok) => {
          const orig = T('📋波形');
          this._bigCopyBtn.textContent = ok ? T('✓ コピー完了') : T('✗ 失敗');
          setTimeout(() => { this._bigCopyBtn.textContent = orig; }, 1000);
        });
      });
      // FM音色データ(OPLL/VRC7=@OT形式、YM2612/YM2610=OPN形式)のコピー。大波形の下の
      // テキスト(_bigPatchEl)と同じ内容をクリップボードへ(formatFmPatch参照)
      this._bigPatchCopyBtn = document.createElement('button');
      this._bigPatchCopyBtn.className = 'kbd-bigwave-copy secondary';
      this._bigPatchCopyBtn.textContent = T('📋音色');
      this._bigPatchCopyBtn.title = T('このFM音色データ(下のテキスト)をクリップボードへコピー');
      this._bigPatchCopyBtn.style.display = 'none';
      this._bigPatchText = null;
      this._bigPatchCopyBtn.addEventListener('click', () => {
        if (!this._bigPatchText) return;
        const orig = T('📋音色');
        navigator.clipboard.writeText(this._bigPatchText).then(
          () => { this._bigPatchCopyBtn.textContent = T('✓ コピー完了'); },
          () => { this._bigPatchCopyBtn.textContent = T('✗ 失敗'); }
        ).finally(() => setTimeout(() => { this._bigPatchCopyBtn.textContent = orig; }, 1000));
      });
      // 音色データの書式選択(FM_PATCH_FORMATS: OPN=PMD/FMP7/MUCOM88/レジスタ、OPLL=@OT/@v/@OP)。
      // FMチャンネル選択時だけ表示、選択は音源種別ごとにlocalStorageへ保存
      this._bigPatchFmtSel = document.createElement('select');
      this._bigPatchFmtSel.className = 'kbd-bigwave-fmt';
      this._bigPatchFmtSel.title = T('音色データの書式');
      this._bigPatchFmtSel.style.display = 'none';
      this._bigPatchFmtType = null; // 今optionを入れてある音源種別('opn'/'opll')
      this._bigPatchCh = null;      // 音色テキストを出している対象ch(書式変更時の再描画用)
      this._bigPatchFmtSel.addEventListener('change', () => {
        if (!this._bigPatchFmtType) return;
        setFmPatchFormat(this._bigPatchFmtType, this._bigPatchFmtSel.value);
        this._bigPatchText = null; // 強制更新
        if (this._bigPatchCh) this._renderBigWave(this._bigPatchCh);
      });
      bigHeader.appendChild(this._bigToggleEl);
      bigHeader.appendChild(this._bigTitleEl);
      bigHeader.appendChild(this._bigCopyBtn);
      bigHeader.appendChild(this._bigPatchFmtSel);
      bigHeader.appendChild(this._bigPatchCopyBtn);
      this._bigCanvas = document.createElement('canvas');
      this._bigCanvas.className = 'kbd-bigwave-canvas';
      this._bigCanvas.width = 560;   // 内部解像度(表示の2倍)。表示サイズは.kbd-bigwave-canvasで指定
      this._bigCanvas.height = 280;
      // 表示サイズが変わったら(一覧の下に幅いっぱいで置く配置など)内部解像度を表示幅の2倍に
      // 合わせて描き直す(drawBigWave()は幅基準でスケールするので解像度が変わっても比率は保たれる)。
      // ★高さは表示高さから取らず常に幅の1/2にする: height:autoのcanvasは属性の縦横比で表示高さが
      // 決まるため、表示高さ→属性高さと決めると互いに追いかけて比率が崩れる
      new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cw = Math.round(entry.contentRect.width * 2), chh = Math.round(cw / 2);
          if (cw <= 0 || chh <= 0) continue;
          if (this._bigCanvas.width === cw && this._bigCanvas.height === chh) continue;
          this._bigCanvas.width = cw;
          this._bigCanvas.height = chh;
          this._bigWaveSig = '';
          if (this._shownWaveId) {
            const sel = (this._prevChannels || []).concat(this._prevSpcVoices || []).find(c => c.id === this._shownWaveId);
            if (sel) this._renderBigWave(sel);
          }
        }
      }).observe(this._bigCanvas);
      big.appendChild(bigHeader);
      // 本体 = 大波形canvas + FM音色データ(FMチャンネル選択時のみ表示、_renderBigWave が更新)。
      // 音色データの箱は大波形と同じ大きさ(CSS .kbd-bigwave-patch)で、置き場は
      //  ・ロールが右(大波形が一覧の左下)      → 大波形の下(従来どおり)
      //  ・ロールが下で一覧が1列               → 大波形の下
      //  ・ロールが下/別窓で一覧が幅に応じて多段 → 大波形の右(.kbd-bigwave--patch-right、_applyLayoutClasses)
      const bigBody = document.createElement('div');
      bigBody.className = 'kbd-bigwave-body';
      bigBody.appendChild(this._bigCanvas);
      this._bigPatchEl = document.createElement('pre');
      this._bigPatchEl.className = 'kbd-bigwave-patch';
      this._bigPatchEl.style.display = 'none';
      bigBody.appendChild(this._bigPatchEl);
      big.appendChild(bigBody);
      this._bigWaveEl = big;

      // ファイル情報ペイン(見出し=折りたたみトグル+タイトル / 本体=main.jsから預かる
      // #xxxFileHeader・#xxxFileStatus の置き場)。旧「サウンドファイルを開く」ウィンドウに
      // 唯一残っていたヘッダ情報を鍵盤表示へ引き取ったもの(ユーザー指示 2026-09-10)。
      // 置き場(上/下/左/右/自動)はレイアウト設定で選ぶ → _mountPanes()
      const fi = document.createElement('div');
      fi.className = 'kbd-fileinfo';
      const fiHeader = document.createElement('div');
      fiHeader.className = 'kbd-fileinfo-header';
      this._fiToggleEl = document.createElement('span');
      this._fiToggleEl.className = 'kbd-fileinfo-toggle';
      this._fiToggleEl.textContent = this._fileInfoCollapsed ? '▶' : '▼';
      this._fiTitleEl = document.createElement('div');
      this._fiTitleEl.className = 'kbd-fileinfo-title';
      fiHeader.title = T('ファイル情報の表示/非表示');
      fiHeader.addEventListener('click', () => {
        this._fileInfoCollapsed = !this._fileInfoCollapsed;
        try { localStorage.setItem('mml_kbdFileInfoCollapsed', this._fileInfoCollapsed ? '1' : '0'); } catch (e) { /* ignore */ }
        this._applyLayoutClasses();
      });
      fiHeader.appendChild(this._fiToggleEl);
      fiHeader.appendChild(this._fiTitleEl);
      this._fiBodyEl = document.createElement('div');
      this._fiBodyEl.className = 'kbd-fileinfo-body';
      fi.appendChild(fiHeader);
      fi.appendChild(this._fiBodyEl);
      this._fileInfoEl = fi;
      this._renderFileInfo();

      // 一覧の下の帯。大波形とファイル情報のうち「一覧の下」に置かれる方が入る箱で、
      // 両方が下に来たときは左右に並ぶ(ファイル情報が左、大波形が右)
      this._belowEl = document.createElement('div');
      this._belowEl.className = 'kbd-below';

      // 一覧と右隣(大波形 or ロールペイン)の間のスプリッター(ロールを右に置く配置でのみ表示。
      // ドラッグで一覧の幅を変える。幅はlocalStorageに保存)
      this._listSplitterEl = this._makeSplitter('vertical', (delta, start) => {
        const w = Math.max(200, Math.round(start + delta));
        this._listWidth = w;
        left.style.width = w + 'px';
      }, () => left.offsetWidth, () => {
        try { localStorage.setItem('mml_keyboardListWidth', String(this._listWidth)); } catch (e) { /* ignore */ }
      });
      // 一覧(音源ごとのCH表示)と大波形の間のスプリッター。大波形が一覧の下にあるとき(縦並び)
      // はCH一覧の高さを、右にあるとき(横並び)は大波形の幅を変える。ユーザー要望で
      // 「各表示の境目でサイズを変えられる」ようにするためのもの
      // ★対象は「いま見えている一覧」(_activeRowsEl)。SPC再生中はボイス一覧が別要素
      //   (_spcSectionEl)で、隠れている _rowsEl の高さを変えても何も起きなかった
      //   (ユーザー報告「SPC鳴らしてるときch枠が下に広げられない」2026-09-10)
      this._waveSplitterEl = this._makeSplitter('horizontal', (delta, start) => {
        const h = Math.max(60, Math.round(start + delta));
        this._listRowsHeight = h;
        const el = this._activeRowsEl();
        el.style.flex = 'none';
        el.style.height = h + 'px';
      }, () => this._activeRowsEl().offsetHeight, () => {
        try { localStorage.setItem('mml_keyboardRowsHeight', String(this._listRowsHeight)); } catch (e) { /* ignore */ }
      });
      this._waveSplitterVEl = this._makeSplitter('vertical', (delta, start) => {
        const w = Math.max(120, Math.round(start - delta)); // 左へドラッグ=大波形が広くなる
        this._bigWaveWidth = w;
        this._bigWaveEl.style.flex = 'none';
        this._bigWaveEl.style.width = w + 'px';
      }, () => this._bigWaveEl.offsetWidth, () => {
        try { localStorage.setItem('mml_keyboardWaveWidth', String(this._bigWaveWidth)); } catch (e) { /* ignore */ }
      });
      // 一覧(上段)とロールペイン(下段)の間のスプリッター(ロールを下に置く配置でのみ表示。
      // ドラッグでロールの高さを変える。高さはlocalStorageに保存)
      this._rollSplitterEl = this._makeSplitter('horizontal', (delta, start) => {
        const h = Math.max(80, Math.round(start - delta)); // 上へドラッグ=ロールが高くなる
        this._setRollHeight(h);
      }, () => this._rollHeight, () => {
        try { localStorage.setItem('mml_pianoRollHeight', String(this._rollHeight)); } catch (e) { /* ignore */ }
      });

      main.appendChild(left);
      this.container.appendChild(main);

      // ピアノロール+鍵盤(ロールペイン)。自己完結したDOM塊として作り、レイアウト設定に
      // 応じた置き場(一覧の下/右/別ウィンドウ)へ_mountRollPane()で取り付ける。
      this._buildRollPane();
      this._mountRollPane();
      this._mountPanes();
      this._leftEl.classList.toggle('kbd-left--assign', !!this._assignMode && !sourceIsMml);
      this._applyLayoutClasses();
      // チャンネル割当が変わったら(この鍵盤表示のセレクト経由でも、他のUI経由でも)
      // part列の文字・スキップ減光・重複警告を貼り直す
      // ★_build()は言語切替のたびに走るので、購読は初回だけ(毎回足すとリスナーが増え続ける)
      const plan = channelPlan();
      if (plan && !this._planHooked) {
        this._planHooked = true;
        plan.onChange(() => this._refreshAssignUi());
      }
      this._renderAssignToggle();
    }

    // ドラッグ可能な仕切り。orientation='vertical'は縦線(左右のペインを分ける、横ドラッグ)、
    // 'horizontal'は横線(上下のペインを分ける、縦ドラッグ)。
    // onDrag(delta, startSize): ドラッグ中に毎回、startSizeはgetStart()でドラッグ開始時に取得。
    // onEnd(): ドラッグ終了時(永続化用)。
    _makeSplitter(orientation, onDrag, getStart, onEnd) {
      const el = document.createElement('div');
      el.className = 'kbd-splitter kbd-splitter--' + orientation;
      let startPos = 0, startSize = 0, active = false;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        active = true;
        startPos = orientation === 'vertical' ? e.clientX : e.clientY;
        startSize = getStart();
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
        e.preventDefault();
      });
      el.addEventListener('pointermove', (e) => {
        if (!active) return;
        const cur = orientation === 'vertical' ? e.clientX : e.clientY;
        onDrag(cur - startPos, startSize);
      });
      const finish = (e) => {
        if (!active) return;
        active = false;
        el.classList.remove('dragging');
        try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (onEnd) onEnd();
      };
      el.addEventListener('pointerup', finish);
      el.addEventListener('pointercancel', finish);
      return el;
    }

    // ロールを一覧の下に置く配置でのロールcanvasの高さ(px)を設定する(スプリッター/初期化から)
    _setRollHeight(h) {
      this._rollHeight = h;
      if (this._rollCanvas) this._applyLayoutClasses(); // ロールcanvas/レーン群の高さへ反映
    }

    // ── ロールペイン(ピアノロール見出し+ロールcanvas+鍵盤canvas)の構築 ─────────
    // ロールは未来の音符を鍵盤へ向かって流して表示する(向きは_layout.rollOrientation、
    // 座標系はmakeRollGeom()参照)。折りたたみ状態は localStorage に保存し次回起動時も維持する。
    _buildRollPane() {
      const rollWrap = document.createElement('div');
      rollWrap.className = 'kbd-roll-wrap';
      this._rollPaneEl = rollWrap;
      const rollHeader = document.createElement('div');
      rollHeader.className = 'kbd-roll-header';
      let rollCollapsed = false;
      try { rollCollapsed = localStorage.getItem('mml_pianoRollCollapsed') === '1'; } catch (e) { /* ignore */ }
      try { this._showCentsOverlay = localStorage.getItem('mml_pianoRollCentsOverlay') === '1'; } catch (e) { this._showCentsOverlay = false; }
      rollHeader.innerHTML =
        `<span class="kbd-roll-toggle">${rollCollapsed ? '▶' : '▼'}</span>` +
        `<span class="kbd-roll-label">${T('ピアノロール')}</span>` +
        `<span class="kbd-roll-seek-slot"></span>` + // main.jsから渡されるシークバー(setRollSeekBar)の置き場
        // 演奏最大時間(秒)+出力。時間表示の「/ 総時間」だった場所を入力欄にして、
        // その右に出力形式と出力ボタンを置く(ユーザー指示 2026-09-09)。
        // 実体は各フォーマットのパネルにある再生時間欄/書き出しボタンで、ここはその代理
        `<span class="kbd-roll-export" style="display:none">` +
          `<span class="kbd-roll-export-sep">/</span>` +
          `<input type="number" class="kbd-max-sec" min="1" max="3600" step="1" title="${T('演奏最大時間(秒)')}">` +
          `<span class="kbd-roll-export-unit">${T('秒')}</span>` +
          `<select class="kbd-export-fmt" title="${T('出力形式')}"></select>` +
          `<button type="button" class="kbd-export-btn" title="${T('この長さで書き出す')}">${T('出力')}</button>` +
        `</span>` +
        `<span class="kbd-roll-drum-audition" style="display:none">` +
          `<span class="kbd-roll-drum-label">${T('パッド試聴')}</span>` +
          `<button type="button" class="kbd-drum-aud-btn kbd-drum-aud-btn--on" data-mode="raw">${T('原音')}</button>` +
          `<button type="button" class="kbd-drum-aud-btn" data-mode="dpcm">DPCM</button>` +
        `</span>` +
        `<label class="kbd-roll-cents-toggle">` +
        `<input type="checkbox" class="kbd-roll-cents-checkbox"${this._showCentsOverlay ? ' checked' : ''}>` +
        `${T('セント偏差')}</label>`;
      // シークバー(range input/ハンドル)の操作でロールの折りたたみ(見出しclick)を起こさない
      const seekSlot = rollHeader.querySelector('.kbd-roll-seek-slot');
      seekSlot.addEventListener('click', (e) => e.stopPropagation());
      seekSlot.addEventListener('mousedown', (e) => e.stopPropagation());
      this._mountRollSeekBar(seekSlot);
      // 演奏最大時間+出力(setExportControls で main.js から中身と表示可否をもらう)
      this._exportEl = rollHeader.querySelector('.kbd-roll-export');
      this._maxSecEl = rollHeader.querySelector('.kbd-max-sec');
      this._exportFmtEl = rollHeader.querySelector('.kbd-export-fmt');
      const exportBtn = rollHeader.querySelector('.kbd-export-btn');
      // 見出し行のクリック(ロールの折りたたみ)を起こさない
      this._exportEl.addEventListener('click', (e) => e.stopPropagation());
      this._exportEl.addEventListener('mousedown', (e) => e.stopPropagation());
      this._maxSecEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this._maxSecEl.blur(); });
      this._maxSecEl.addEventListener('change', () => {
        const v = Math.max(1, Math.min(3600, parseInt(this._maxSecEl.value, 10) || 0));
        this._maxSecEl.value = String(v);
        if (this.onMaxSecondsChange) this.onMaxSecondsChange(v);
      });
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.onExport) return;
        const sec = Math.max(1, Math.min(3600, parseInt(this._maxSecEl.value, 10) || 0));
        this.onExport(this._exportFmtEl.value, sec);
      });
      // 言語切替で見出しを作り直した後も状態を戻す(selectは新品なので必ず作り直させる)
      this._exportFmtSig = null;
      this.setExportControls(this._exportOpt);
      // オーバーレイのON/OFFはロール見出しクリック(折りたたみ)とは独立させるため、
      // クリックイベントの伝播をここで止める(bubbling先のrollHeaderハンドラを発火させない)。
      // ドラム区画のパッド試聴の切替(原音 / DPCM変換後)。区画があるときだけ出す
      this._drumAuditionEl = rollHeader.querySelector('.kbd-roll-drum-audition');
      for (const btn of rollHeader.querySelectorAll('.kbd-drum-aud-btn')) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._drumAuditionMode = btn.dataset.mode;
          for (const b of rollHeader.querySelectorAll('.kbd-drum-aud-btn')) {
            b.classList.toggle('kbd-drum-aud-btn--on', b.dataset.mode === this._drumAuditionMode);
          }
        });
      }

      const centsCheckbox = rollHeader.querySelector('.kbd-roll-cents-checkbox');
      centsCheckbox.addEventListener('click', (e) => e.stopPropagation());
      centsCheckbox.addEventListener('change', () => {
        this._showCentsOverlay = centsCheckbox.checked;
        try { localStorage.setItem('mml_pianoRollCentsOverlay', this._showCentsOverlay ? '1' : '0'); } catch (e) { /* ignore */ }
      });
      this._rollCanvas = document.createElement('canvas');
      this._rollCanvas.className = 'kbd-roll';
      this._rollCanvas.height = ROLL_CANVAS_HEIGHT;
      // 折りたたみは「一覧の下」配置でのみ有効(右/別ウィンドウ配置ではロールがペインの
      // 主役なので畳む意味が薄く、別ウィンドウは閉じれば済む)。表示状態の反映は
      // _applyLayoutClasses()に集約する
      rollHeader.addEventListener('click', () => {
        if (this._effectivePlacement() !== 'bottom') return;
        const collapsed = !this._rollCollapsed;
        this._rollCollapsed = collapsed;
        try { localStorage.setItem('mml_pianoRollCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
        // 畳んだらロールの高さぶんウィンドウ自体を縮め(=鍵盤が上へ詰まる)、
        // 開いたらロールの高さぶん広げる(=鍵盤がロールの下へ移動する)。
        // こうしないとチャンネル一覧(.kbd-main, flex:1 1 auto)が伸縮を全部吸収してしまい、
        // 折りたたんでも窓の高さが変わらず鍵盤の位置も動かない。増減量はペインの実測高さの
        // 差分(まとめ表示ならロール高さ、レーン表示ならレーン全体の高さ)。
        // 高さの永続化は floatingWindows.js の ResizeObserver → persist() が行う。
        const win = rollWrap.closest('.float-window');
        const before = rollWrap.offsetHeight;
        this._applyLayoutClasses();
        const after = rollWrap.offsetHeight;
        if (win) {
          const cur = parseInt(win.style.height, 10) || win.offsetHeight;
          win.style.height = Math.max(MIN_WINDOW_HEIGHT, cur + (after - before)) + 'px';
        }
      });
      this._rollCollapsed = rollCollapsed;
      this._rollHeaderEl = rollHeader;
      this._attachRollSeekDrag(this._rollCanvas);

      // 鍵盤canvas。ロールと同じペインに入れる(音符が鍵盤へ流れ着く一体表示のため、
      // ロールの置き場が変わっても必ず一緒に動く)
      this._canvas = document.createElement('canvas');
      this._canvas.className = 'kbd-piano';
      this._canvas.height = PIANO_KEY_LEN;
      // 鍵盤canvasはサイズ決め用のラッパー(.kbd-piano-wrap)の中に絶対配置で入れる。
      // canvas要素はwidth/height属性が「固有サイズ」としてレイアウトに効くため、横向きの
      // 横並びレイアウトで古い属性値(前の配置での高さ)が行の高さを押し広げてしまう。
      // 絶対配置ならレイアウトに寄与せず、常にラッパーのサイズに追随する
      const pianoWrap = document.createElement('div');
      pianoWrap.className = 'kbd-piano-wrap';
      pianoWrap.appendChild(this._canvas);
      this._pianoWrapEl = pianoWrap;

      // 本体(ロール+鍵盤)。縦向きは縦積み(ロールの下に鍵盤)、横向きは横並び(鍵盤の右にロール)。
      // 向きの切替はCSSクラス(.kbd-roll-wrap--horizontal)で行う(_applyLayoutClasses参照)
      const body = document.createElement('div');
      body.className = 'kbd-roll-body';
      body.appendChild(this._rollCanvas);
      body.appendChild(pianoWrap);
      this._rollBodyEl = body;

      // チャンネルごとのレーン表示(rollLanes='perChannel')用のコンテナ。中身(各レーンの
      // ロール+鍵盤canvas)は_rebuildLanes()が使用チャンネルに合わせて作り直す。
      // 縦向きはレーンが横に並び(横スクロール)、横向きは縦に積まれる(縦スクロール)
      const lanes = document.createElement('div');
      lanes.className = 'kbd-lanes';
      this._lanesEl = lanes;
      this._lanes = [];

      rollWrap.appendChild(rollHeader);
      rollWrap.appendChild(body);
      rollWrap.appendChild(lanes);

      // drawPiano()/_renderRoll()は毎フレーム(60fps)canvasの表示サイズを必要とするが、
      // canvas.offsetWidth/Heightを直接読むと毎回強制同期レイアウトが走る(要素のサイズ自体は
      // リサイズ時以外変わらないのに)。MML再生ハイライト機能の毎フレームDOM更新と
      // 同じフレーム内で両方が動くと、この強制レイアウトがお互いの保留中のDOM変更を
      // 巻き込んで重くなる(レイアウトスラッシング)。ResizeObserverで実際にリサイズ
      // された時だけ幅・高さをキャッシュし、毎フレームの読み取りをキャッシュ参照に置き換える
      // (レーンのcanvasも_rebuildLanes()で同じオブザーバに登録する)
      this._sizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          entry.target._cachedWidth = Math.round(entry.contentRect.width);
          entry.target._cachedHeight = Math.round(entry.contentRect.height);
        }
      });
      this._sizeObserver.observe(this._rollCanvas);
      this._sizeObserver.observe(this._canvas);
      this._rebuildLanes();
      this._applyLayoutClasses();
    }

    // チャンネルごとのレーン表示の中身を、現在の一覧(NSF等: _rowEls / SPC: _spcRowEls)に
    // 合わせて作り直す。各レーンは [ラベル(色丸+パート文字+ch名)] + [ロールcanvas+鍵盤canvas]で、
    // 間にはドラッグで大きさ(=拡大率)を変えるスプリッターを挟む。
    // 一覧が組み直された時(_rebuildRows/updateSpcVoices/setMode)と設定切替時に呼ぶ。
    // 'all'モードでは中身を空にしておく(描画コストをかけない)
    _rebuildLanes() {
      const lanesEl = this._lanesEl;
      if (!lanesEl) return;
      // 古いcanvasの監視解除
      for (const l of this._lanes) {
        try { this._sizeObserver.unobserve(l.rollCanvas); this._sizeObserver.unobserve(l.pianoCanvas); } catch (e) { /* ignore */ }
      }
      const prevIds = this._lanes.map(l => l.id).join('\u0000');
      this._lanes = [];
      lanesEl.innerHTML = '';
      if (this._layout.rollLanes !== 'perChannel') return;
      const rows = (this._mode === 'spc' ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow && el.waveCanvas);
      // チャンネルの顔ぶれが変わったら(=別の曲/別のフォーマット)、手で変えた大きさは捨てて既定へ戻す
      if (rows.map(r => r.id).join('\u0000') !== prevIds) this._laneSizes.clear();
      // 区画の単位: 既定は1行1区画。laneGroup を持つ行(PSF のトラックモード)は同じトラックの声部と
      // その複製をまとめて1区画にする(和音が声部ごとにバラバラの区画へ散らないように)
      const groups = [];
      const groupByKey = new Map();
      for (const rowEl of rows) {
        const g = rowEl.laneGroup ? groupByKey.get(rowEl.laneGroup) : null;
        if (g) { g.push(rowEl); continue; }
        const fresh = [rowEl];
        if (rowEl.laneGroup) groupByKey.set(rowEl.laneGroup, fresh);
        groups.push(fresh);
      }
      for (const groupRows of groups) {
        const rowEl = groupRows[0];
        if (this._lanes.length) lanesEl.appendChild(this._makeLaneSplitter(this._lanes.length - 1));
        const lane = document.createElement('div');
        lane.className = 'kbd-lane';
        const label = document.createElement('div');
        label.className = 'kbd-lane-label';
        const nameEl = rowEl.row.querySelector('.kbd-name');
        const laneName = rowEl.laneGroup || (nameEl ? nameEl.textContent : rowEl.id);
        const letters = groupRows.map(r => r.letter).filter(Boolean).join(' ');
        label.innerHTML = `<span class="kbd-lane-dot" style="background:${rowEl.color}"></span>` +
          `<span class="kbd-lane-text">${letters ? letters + ' ' : ''}${laneName}</span>`;
        label.title = groupRows.map(r => r.id + (r.laneCopy ? ' ≈' : '')).join(', ');
        const rollCanvas = document.createElement('canvas');
        rollCanvas.className = 'kbd-roll';
        rollCanvas.height = ROLL_CANVAS_HEIGHT;
        this._attachRollSeekDrag(rollCanvas);
        const pianoCanvas = document.createElement('canvas');
        pianoCanvas.className = 'kbd-piano';
        pianoCanvas.height = PIANO_KEY_LEN;
        const pianoWrap = document.createElement('div');
        pianoWrap.className = 'kbd-piano-wrap';
        pianoWrap.appendChild(pianoCanvas);
        const body = document.createElement('div');
        body.className = 'kbd-roll-body kbd-lane-body';
        body.appendChild(rollCanvas);
        body.appendChild(pianoWrap);
        lane.appendChild(label);
        lane.appendChild(body);
        lanesEl.appendChild(lane);
        this._sizeObserver.observe(rollCanvas);
        this._sizeObserver.observe(pianoCanvas);
        // offWhite/visWhite(音程窓)は_updateLaneRanges()がタイムラインから決める。
        // それまでの初期値は鍵盤全体(まとめ表示と同じ見え方)
        this._lanes.push({ id: rowEl.id, ids: groupRows.map(r => r.id), laneEl: lane, rollCanvas, pianoCanvas, offWhite: 0, visWhite: 0, rangeKnown: false });
      }
      this._updateLaneRanges();
    }

    // レーンの境目のスプリッター。ドラッグでその手前(縦向き=左、横向き=上)のレーンの大きさを
    // 変える = そのchのロール/鍵盤だけが拡大縮小する。全体が入り切らなくなったぶんは
    // .kbd-lanes がスクロールする。ダブルクリックで全レーンを既定の大きさへ戻す。
    _makeLaneSplitter(index) {
      const horizontal = this._layout.rollOrientation === 'horizontal';
      const el = this._makeSplitter(horizontal ? 'horizontal' : 'vertical', (delta, start) => {
        const lane = this._lanes[index];
        if (!lane) return;
        this._laneSizes.set(lane.id, Math.max(LANE_MIN_PX, Math.round(start + delta)));
        this._applyLaneSizes();
      }, () => {
        // 掴んだ瞬間に全レーンの「今の実寸」を固定値へ焼き付ける。自動割り付け(flex-grow)の
        // ままだと1つ変えた余りが他レーンへ再配分され、掴んだ境目がポインタからズレるため
        this._freezeLaneSizes();
        const lane = this._lanes[index];
        return lane ? (this._laneSizes.get(lane.id) || 0) : 0;
      });
      el.classList.add('kbd-lane-splitter');
      el.title = T('ドラッグでこのチャンネルの表示幅(拡大率)を変える / ダブルクリックで既定に戻す');
      el.addEventListener('dblclick', () => {
        this._laneSizes.clear();
        this._applyLaneSizes();
      });
      return el;
    }

    // 各レーンの音程窓を「そのchが曲全体で鳴らす音域」に合わせる。
    //   lane.offWhite = 窓の低音側の端(白鍵単位。ドラム区画を含む音程軸の座標)
    //   lane.visWhite = 窓の幅(白鍵の本数)。canvasの音程軸長さ÷これが拡大率になる
    // タイムラインが無い/そのchの音符が1つも無い間は鍵盤全体(まとめ表示と同じ)にする。
    // タイムラインやドラム区画が変わるたびに呼ぶ(_rebuildDrumLanes の呼び出し元と対)。
    _updateLaneRanges() {
      if (!this._lanes.length) return;
      const drumUnits = (this._drumLanes || []).length * DRUM_LANE_WHITE;
      const total = TOTAL_WHITE + drumUnits;
      for (const lane of this._lanes) {
        const laneIds = lane.ids || [lane.id];
        const tracks = (this._rollTimeline || []).filter(t => laneIds.indexOf(t.id) >= 0);
        let lo = Infinity, hi = -Infinity;
        for (const note of [].concat(...tracks.map(t => t.notes))) {
          let p0, p1;
          if (note.drumLane !== undefined) {
            // ドラムの打点はレーン番号が音程軸上の位置(1レーン=DRUM_LANE_WHITE白鍵ぶん)
            const d = drumLaneX(note.drumLane, 0, 1, DRUM_LANE_WHITE);
            p0 = d.x; p1 = d.x + d.size;
          } else {
            const kp = keyX(note.midi, 1);
            if (!kp) continue;
            p0 = (kp.isBlack ? kp.x - 0.3 : kp.x) + drumUnits;
            p1 = (kp.isBlack ? kp.x + 0.3 : kp.x + 1) + drumUnits;
          }
          if (p0 < lo) lo = p0;
          if (p1 > hi) hi = p1;
        }
        if (lo === Infinity) {
          // 1音も鳴らないch(や先読みキャプチャ完了前)は音域が決まらない。鍵盤全体を出すが、
          // 音域が分かっているレーンと同じ拡大率で場所を取らないよう大きさは控えめにする
          lane.offWhite = 0; lane.visWhite = total; lane.rangeKnown = false;
          continue;
        }
        lane.rangeKnown = true;
        lo -= LANE_RANGE_PAD; hi += LANE_RANGE_PAD;
        if (hi - lo < LANE_MIN_WHITE) {  // 1音しか鳴らさないch等が極端に拡大されないように
          const c = (lo + hi) / 2;
          lo = c - LANE_MIN_WHITE / 2;
          hi = c + LANE_MIN_WHITE / 2;
        }
        lo = Math.max(0, lo); hi = Math.min(total, hi);
        lane.offWhite = lo;
        lane.visWhite = Math.max(1, hi - lo);
      }
      this._applyLaneSizes();
    }

    // レーンの音程軸方向の大きさをDOMへ反映する。
    // 既定(手で変えていない状態)は音域幅×LANE_PX_PER_WHITE = どのレーンも同じ拡大率にし、
    // 音程軸に余りがあれば音域幅に比例して配って隙間を埋める(flex-growを大きさに比例させる)。
    // スプリッターで1つでも変えたら全レーンを固定px(=はみ出したぶんはスクロール)へ切り替える。
    _applyLaneSizes() {
      const extra = this._layout.rollOrientation === 'horizontal' ? LANE_LABEL_PX : 0; // 横向きはラベル行もレーンの高さに含まれる
      const fixed = this._laneSizes.size > 0;
      for (const lane of this._lanes) {
        const base = lane.rangeKnown
          ? Math.max(LANE_MIN_PX, Math.round((lane.visWhite || 0) * LANE_PX_PER_WHITE) + extra)
          : LANE_UNKNOWN_PX + extra;
        const size = fixed ? (this._laneSizes.get(lane.id) || base) : base;
        lane.laneEl.style.flex = fixed ? ('0 0 ' + size + 'px') : (base + ' 0 ' + base + 'px');
      }
      this._scheduleLaneRedraw();
    }

    // レーンの大きさを変えた直後の描き直し。停止中はrAFが回っていないので自分で1回描く。
    // canvasの表示サイズはResizeObserverがキャッシュするが反映は次フレーム以降なので、
    // ここではレイアウト確定後(rAF)に実寸を読んでキャッシュを更新してから描く。
    _scheduleLaneRedraw() {
      if (this._laneRedrawPending || !this._lanes.length) return;
      this._laneRedrawPending = true;
      const run = () => {
        this._laneRedrawPending = false;
        for (const lane of this._lanes) {
          for (const c of [lane.rollCanvas, lane.pianoCanvas]) {
            const w = c.clientWidth, h = c.clientHeight;
            if (w) c._cachedWidth = w;
            if (h) c._cachedHeight = h;
          }
        }
        this._redrawRollForSpotlight();
        this._drawPianos(this._lastPianoChannels || this._lastChannels || []);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else run();
    }

    // 自動割り付け中のレーンを「今の実寸」で固定値に置き換える(スプリッターを掴んだ瞬間に呼ぶ)
    _freezeLaneSizes() {
      const horizontal = this._layout.rollOrientation === 'horizontal';
      for (const lane of this._lanes) {
        if (this._laneSizes.has(lane.id)) continue;
        const px = horizontal ? lane.laneEl.offsetHeight : lane.laneEl.offsetWidth;
        this._laneSizes.set(lane.id, Math.max(LANE_MIN_PX, Math.round(px) || LANE_MIN_PX));
      }
    }

    // 鍵盤だけ描き直す。停止中(rAFが回っていない)に演奏入力で押した鍵を点灯させるために、
    // src/ui/performInput.js が押鍵のたびに呼ぶ。ロールは触らないので安い
    refreshPianos() {
      this._drawPianos(this._lastPianoChannels || this._lastChannels || []);
    }

    // 鍵盤描画: 全チャンネルまとめ(1枚)か、レーンごと(そのchだけ)か
    _drawPianos(allChannels) {
      const PI = MML.UI && MML.UI.PerformInput;
      const performNotes = (PI && PI.isArmed()) ? PI.heldNotes() : null;
      if (this._layout.rollLanes === 'perChannel' && this._lanes.length) {
        for (const l of this._lanes) {
          // 音程窓はロール側と共通(_updateLaneRanges が決めたそのchの音域)
          const laneIds = l.ids || [l.id];
          drawPiano(l.pianoCanvas, allChannels.filter(c => laneIds.indexOf(c.id) >= 0), this._layout.rollOrientation, l.visWhite || 0, l.offWhite || 0, this._drumsForPiano(), performNotes);
          if (this._drumLanes && this._drumLanes.length) this._attachDrumAudition(l.pianoCanvas);
          this._attachPerformInput(l.pianoCanvas);
        }
        return;
      }
      drawPiano(this._canvas, allChannels, this._layout.rollOrientation, 0, 0, this._drumsForPiano(), performNotes);
      this._attachPerformInput(this._canvas);
      // ドラム区画があるときだけパッド試聴を有効にする(区画=パッドが無ければ押す物が無い)
      const hasDrums = !!(this._drumLanes && this._drumLanes.length);
      if (hasDrums) this._attachDrumAudition(this._canvas);
      if (this._drumAuditionEl) this._drumAuditionEl.style.display = (hasDrums && this.onDrumAudition) ? '' : 'none';
    }

    // 表示中の再生ソースをタイトル行のバッジに出す。kind: 'mml' | 'nsf'|'spc'|'kss'|'gbs'|'hes'
    // (サウンドファイル) | null(未ロード)。name: ファイル名や曲名(省略可)。
    // main.js が MML再生の準備(prepareMmlStream)と各loadXxxFile()で呼ぶ。
    setSourceInfo(kind, name) {
      this._sourceInfo = kind ? { kind, name: name || '' } : null;
      this._renderSourceBadge();
      // MML側へ切り替えたら割当UI(part列・借用先列・🎧)をまとめて無効に、ファイル側へ戻したら復帰
      const wasMml = sourceIsMml;
      sourceIsMml = kind === 'mml';
      if (wasMml !== sourceIsMml) {
        if (this._leftEl) this._leftEl.classList.toggle('kbd-left--assign', !!this._assignMode && !sourceIsMml);
        this._renderAssignToggle();
        this._renderPreviewToggle();
        if (this._previewMode) this._notifyPreview(); // ミュート設定/プレビュー計画を今の表示元で組み直す
      }
    }
    _renderSourceBadge() {
      const el = this._srcBadgeEl;
      if (!el) return;
      const info = this._sourceInfo;
      el.classList.remove('kbd-src-badge--mml', 'kbd-src-badge--file');
      if (!info) { el.textContent = ''; el.title = ''; el.style.display = 'none'; return; }
      el.style.display = '';
      const isMml = info.kind === 'mml';
      el.classList.add(isMml ? 'kbd-src-badge--mml' : 'kbd-src-badge--file');
      // バッジは MML / FILE の2択(今どちらの再生を表示・操作しているか)。名前は右の別ボタンへ
      el.textContent = isMml ? 'MML' : 'FILE';
      const base = isMml ? T('MML再生を表示中') : T('サウンドファイル再生を表示中');
      el.title = this._transportState.canToggleSource
        ? base + '\n' + T('クリックでMML再生 / サウンドファイル再生を切り替え')
        : base;
      el.classList.toggle('kbd-src-badge--clickable', !!this._transportState.canToggleSource);
      this._renderSourceName();
    }
    // ファイル名(MMLならタイトル)/アーカイブのリスト名。曲一覧があればクリックで選べる
    _renderSourceName() {
      const el = this._srcNameEl;
      if (!el) return;
      const info = this._sourceInfo;
      const list = (info && this.onSourceListRequest) ? (this.onSourceListRequest() || null) : null;
      const name = (list && list.name) || (info && info.name) || '';
      const pickable = !!(list && list.items && list.items.length > 1);
      if (!name) { el.style.display = 'none'; el.textContent = ''; return; }
      el.style.display = '';
      if (el.textContent !== name) el.textContent = name;
      el.classList.toggle('kbd-src-name--pick', pickable);
      // アーカイブなら1行目にリスト名(zip/m3u)、2行目に曲名
      el.title = (list && list.listName ? list.listName + '\n' : '') + name + (pickable ? '\n' + T('クリックで曲を選ぶ') : '');
    }
    refreshSourceName() { this._renderSourceName(); }
    // 今表示している曲の名前(タイトル行のファイル名ボタンと同じ文字列)。
    // ミニ操作窓の見出しと Media Session の曲名に使う
    getSourceName() {
      const info = this._sourceInfo;
      const list = (info && this.onSourceListRequest) ? (this.onSourceListRequest() || null) : null;
      return (list && list.name) || (info && info.name) || '';
    }
    _openSourcePopover() {
      this._closeSourcePopover();
      const list = this.onSourceListRequest ? this.onSourceListRequest() : null;
      if (!list || !list.items || list.items.length < 2) return;
      const pop = document.createElement('div');
      pop.className = 'kbd-src-pop';
      let curEl = null;
      list.items.forEach((label, i) => {
        const row = document.createElement('div');
        row.className = 'kbd-src-pop-item' + (i === list.index ? ' kbd-src-pop-item--cur' : '');
        row.textContent = label;
        row.title = label;
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          this._closeSourcePopover();
          if (this.onSourceSelect) this.onSourceSelect(i);
        });
        pop.appendChild(row);
        if (i === list.index) curEl = row;
      });
      const r = this._srcNameEl.getBoundingClientRect();
      pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 430)) + 'px';
      pop.style.top = (r.bottom + 4) + 'px';
      document.body.appendChild(pop);
      this._srcPopEl = pop;
      if (curEl) curEl.scrollIntoView({ block: 'center' });
      const onDown = (e) => { if (!pop.contains(e.target)) this._closeSourcePopover(); };
      const onKey = (e) => { if (e.key === 'Escape') this._closeSourcePopover(); };
      this._srcPopCleanup = () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); };
      setTimeout(() => { document.addEventListener('mousedown', onDown, true); document.addEventListener('keydown', onKey, true); }, 0);
    }
    _closeSourcePopover() {
      if (this._srcPopCleanup) { this._srcPopCleanup(); this._srcPopCleanup = null; }
      if (this._srcPopEl) { this._srcPopEl.remove(); this._srcPopEl = null; }
    }

    // ── タイトル行の再生コントロール(⏮ ▶/⏸ ■ ⏭) ───────────────────
    // 操作対象は「今表示している方」(バッジと同じ = MML再生 or サウンドファイル再生)。
    // 実際の再生/停止/曲送りはmain.js側が持っているので、ここは押されたことを
    // onTransport(action)で伝えるだけにして、状態(有効/無効・再生中か)は
    // setTransportState()で外から流し込む。
    _buildTransportBar() {
      const ICONS = {
        prev: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M6.6 4.5v11h1.8v-11zM16 5.2c0-.8-.9-1.2-1.5-.8l-5.1 4.1a1 1 0 0 0 0 1.6l5.1 4.1c.6.5 1.5 0 1.5-.8z"/></svg>',
        play: '<svg class="icon-play" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 4.2v11.6c0 .8.9 1.3 1.6.9l9-5.8c.6-.4.6-1.4 0-1.8l-9-5.8c-.7-.4-1.6.1-1.6.9Z"/></svg>' +
              '<svg class="icon-pause" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="4" width="3.4" height="12"/><rect x="11.6" y="4" width="3.4" height="12"/></svg>',
        stop: '<svg viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.2"/></svg>',
        next: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M13.4 4.5v11h-1.8v-11zM4 5.2c0-.8.9-1.2 1.5-.8l5.1 4.1a1 1 0 0 1 0 1.6l-5.1 4.1c-.6.5-1.5 0-1.5-.8z"/></svg>'
      };
      const bar = document.createElement('div');
      bar.className = 'kbd-transport';
      this._transportBtns = {};
      for (const action of ['prev', 'play', 'stop', 'next']) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'kbd-tp-btn kbd-tp-btn--' + action;
        btn.innerHTML = ICONS[action];
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (btn.disabled) return;
          if (this.onTransport) this.onTransport(action);
        });
        bar.appendChild(btn);
        this._transportBtns[action] = btn;
      }
      return bar;
    }

    // ヘッダへ置く小さな代理ボタン(実体は別の場所のボタン/main.jsのコールバック)
    _buildProxyBtn(cls, title, innerHtml, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kbd-hdr-btn ' + cls;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = innerHtml;
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    }

    // 曲が終わった後の挙動。1つのアイコンをクリックのたびに次のモードへ回す
    _buildRepeatBtn() {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kbd-hdr-btn kbd-repeat-btn';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = REPEAT_MODES.indexOf(this._repeatMode);
        this.setRepeatMode(REPEAT_MODES[(i + 1) % REPEAT_MODES.length]);
        if (this.onRepeatModeChange) this.onRepeatModeChange(this._repeatMode);
      });
      this._repeatBtnEl = b;
      this._renderRepeatBtn();
      return b;
    }

    setRepeatMode(mode) {
      if (REPEAT_MODES.indexOf(mode) < 0) mode = 'next';
      this._repeatMode = mode;
      try { localStorage.setItem(REPEAT_MODE_KEY, mode); } catch (e) { /* ignore */ }
      this._renderRepeatBtn();
    }
    getRepeatMode() { return this._repeatMode; }

    // ── ミニ操作窓(src/ui/miniTransport.js)から使う公開API ────────────────
    // 小窓はタイトル行のボタン群と同じ操作を提供するが、DOMは別に作るので
    // 「今の見た目」と「切り替え方」だけをここから渡す(状態の持ち主はこのクラスのまま)。
    getRepeatIcon() {
      const info = REPEAT_ICONS[this._repeatMode] || REPEAT_ICONS.next;
      return { svg: info.svg, label: info.label() };
    }
    cycleRepeatMode() {
      const i = REPEAT_MODES.indexOf(this._repeatMode);
      this.setRepeatMode(REPEAT_MODES[(i + 1) % REPEAT_MODES.length]);
      if (this.onRepeatModeChange) this.onRepeatModeChange(this._repeatMode);
      return this._repeatMode;
    }
    // 今表示しているチャンネル行のミュート状態。ALL行は含めない
    getMuteRows() {
      const spc = this._mode === 'spc';
      const rows = (spc ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow && el.checkbox);
      // 色は行の丸(.kbd-dot)に実際に出ている値をそのまま渡す。ユーザーが色を
      // 変えた場合もこれで追随する(_getColorの上書きが既に入っているため)
      return rows.map((el) => {
        const dot = el.row && el.row.querySelector('.kbd-dot');
        return {
          id: el.id, label: el.id, muted: !el.checkbox.checked,
          color: (dot && dot.style.background) || '',
          chip: el.chip || '',
        };
      });
    }
    // 行のミュートを反転する。実体は行のチェックボックスを押すのと同じ経路を通すので、
    // SPC(onSpcMuteChange)との分岐もチェックボックス側のハンドラがそのまま面倒を見る
    toggleMuteRow(id) {
      const all = this._rowEls.concat(this._spcRowEls);
      const el = all.find(x => x.id === id && x.checkbox);
      if (!el) return false;
      el.checkbox.checked = !el.checkbox.checked;
      el.checkbox.dispatchEvent(new Event('change'));
      return true;
    }

    _renderRepeatBtn() {
      const b = this._repeatBtnEl;
      if (!b) return;
      const info = REPEAT_ICONS[this._repeatMode] || REPEAT_ICONS.next;
      b.innerHTML = info.svg;
      b.title = info.label();
      b.setAttribute('aria-label', info.label());
      b.classList.toggle('kbd-repeat-btn--stop', this._repeatMode === 'stop');
    }

    // main.js が再生状態の変化ごとに呼ぶ。state: { playing, canPlay, canStop, canPrevNext, canToggleSource }
    setTransportState(state) {
      const s = this._transportState;
      let changed = false;
      for (const k of ['playing', 'canPlay', 'canStop', 'canPrevNext', 'canToggleSource']) {
        const v = !!(state && state[k]);
        if (s[k] !== v) { s[k] = v; changed = true; }
      }
      if (!changed) return; // 毎フレーム呼ばれても実際に変わった時だけDOMを触る
      this._renderTransport();
      this._renderSourceBadge(); // バッジのクリック可否(カーソル/ツールチップ)も一緒に更新
    }

    _renderTransport() {
      const b = this._transportBtns;
      if (!b) return;
      const s = this._transportState;
      b.prev.disabled = !s.canPrevNext;
      b.next.disabled = !s.canPrevNext;
      b.play.disabled = !s.canPlay;
      b.stop.disabled = !s.canStop;
      b.play.classList.toggle('is-playing', s.playing);
      b.play.title = s.playing ? T('一時停止') : T('再生');
      b.stop.title = T('停止');
      b.prev.title = T('前の曲');
      b.next.title = T('次の曲');
    }

    // 大波形に「今表示するch」(_shownWaveId)を、表示中の一覧(rowEls)に合わせて決め直す。
    // ユーザーが選んだch(_selectedId)が一覧にあればそれ、無ければ一番若いch(波形アイコンを
    // 持つ最初の行)を一時的に表示する。_selectedId自体はここでは変えない(停止→再生や曲送りで
    // 一覧が一時的に2A03だけになっても、選択が勝手に若いchへ変わってしまわないように)。
    // ファイルの読み込み直しに伴う「選択を捨てて若いchへ戻すか、同じchが新ファイルにも
    // あるなら維持するか」の判定は_consumePendingSelectionReset()が別途行う(こちらを呼ぶ前に
    // 呼ばれる想定)。一覧の下の折りたたみ帯は自動で開かない(ユーザーがクリックしたときだけ開く)
    _syncShownWave(rowEls) {
      const rows = (rowEls || []).filter(el => el.waveCanvas);
      const keep = rows.find(el => el.id === this._selectedId);
      const target = keep || rows[0];
      const id = target ? target.id : null;
      if (id !== this._shownWaveId) this._bigWaveSig = '';
      this._shownWaveId = id;
      for (const el of this._rowEls.concat(this._spcRowEls)) {
        if (el.waveCanvas) el.waveCanvas.classList.toggle('kbd-wave--selected', el.id === id);
      }
      if (!id) return;
      const ch = (this._prevChannels || []).find(c => c.id === id) ||
                 (this._prevSpcVoices || []).find(c => c.id === id);
      if (ch) this._renderBigWave(ch);
    }

    // reset()(ファイルの読み込み直し)が立てたフラグを、新ファイルの実際のチャンネル一覧
    // (waveIds: 波形を持つ行のid配列)が判明した最初の1回だけ消費して、大波形の選択
    // (_selectedId)を確定させる。同じch(id)が新ファイルにもあれば選択を維持(同じ音源構成の
    // 別ファイルを続けて開いた場合など)、無ければ一番若いchへ切り替える。
    // waveIdsが空(まだ実データが来ていない一覧)の間は消費せず次回に持ち越す。
    // 呼び出し側は結果を_syncShownWave()に反映させるため、この直後に必ず_syncShownWave()を呼ぶこと。
    _consumePendingSelectionReset(waveIds) {
      if (!this._pendingSelectionReset || !waveIds || !waveIds.length) return;
      this._pendingSelectionReset = false;
      if (!waveIds.includes(this._selectedId)) this._selectedId = waveIds[0];
    }

    // ロール見出し行に置くシークバー(MMLエディタのトランスポート行と同じもの。DOMはmain.jsが
    // createSeekBarInstance()で作り位置/範囲/時間表示を同期し続けるので、ここでは置くだけ)。
    // 言語切替で見出しを作り直しても同じ要素を差し戻す(_buildRollPane→_mountRollSeekBar)。
    setRollSeekBar(wrapEl, timeEl) {
      this._rollSeekBarEls = wrapEl ? { wrapEl, timeEl } : null;
      const slot = this._rollHeaderEl && this._rollHeaderEl.querySelector('.kbd-roll-seek-slot');
      if (slot) this._mountRollSeekBar(slot);
    }

    /**
     * ロール見出しの「演奏最大時間+出力」を更新する(main.jsが唯一の呼び出し元)。
     * opt = { visible, seconds, formats:[[value,label], ...] }
     * サウンドファイル再生中だけ出す(MML再生の総時間は曲の長さそのもので、指定する物ではない)。
     */
    setExportControls(opt) {
      this._exportOpt = opt || null;
      if (!this._exportEl) return;
      const on = !!(opt && opt.visible);
      this._exportEl.style.display = on ? '' : 'none';
      if (!on) return;
      // 中身が変わったときだけ作り直す(毎フレーム呼ばれるので、選択中の値を消さないため)
      const sig = opt.formats ? opt.formats.map((f) => f[0]).join(',') : '';
      if (opt.formats && this._exportFmtSig !== sig) {
        this._exportFmtSig = sig;
        const keep = this._exportFmtEl.value;
        this._exportFmtEl.innerHTML = '';
        for (const [value, label] of opt.formats) {
          const o = document.createElement('option');
          o.value = value; o.textContent = label;
          this._exportFmtEl.appendChild(o);
        }
        if (opt.formats.some((f) => f[0] === keep)) this._exportFmtEl.value = keep;
      }
      // 入力中(フォーカス中)は書き換えない。打っている途中の値が毎フレーム消えてしまうため
      if (document.activeElement !== this._maxSecEl && opt.seconds != null) {
        const v = String(Math.round(opt.seconds));
        if (this._maxSecEl.value !== v) this._maxSecEl.value = v;
      }
    }
    _mountRollSeekBar(slot) {
      const els = this._rollSeekBarEls;
      slot.innerHTML = '';
      if (!els) return;
      slot.appendChild(els.wrapEl);
      if (els.timeEl) slot.appendChild(els.timeEl);
    }

    // ── ロールをドラッグしてシーク ─────────────────────────────────
    // ロール上でポインタを押して動かすと、音符の流れる方向に沿って再生位置を動かす
    // (縦向き=上下: 下へ引くと未来の音符が鍵盤へ近づく=進む / 横向き=左右: 左へ引くと進む)。
    // 1px = 1/ROLL_PX_PER_SEC 秒(ロールの時間軸スケールと同じなので、つかんだ音符が指に付いてくる)。
    // 実際のシークは onRollSeek(実時間の秒) に委ね(main.js: seekToSeconds)、ドラッグ中は
    // 間引いて呼び、離した時に最終位置で呼ぶ。返ってきた(クランプ後の)秒で表示位置を合わせる。
    // ドラッグ中の描画は _renderRoll() が _rollDrag.pos を優先する。
    // ロール上の点(clientX/Y)にノートがあればそのトラックidを返す(無ければnull)。
    // 判定は _drawRollCanvas の描画と同じ座標計算を使う。
    //  ・ノートの上 → そのchを大波形へフォーカスする(ドラッグシークはしない)
    //  ・ノートの無いところ → 従来どおりドラッグでシーク
    _trackAtRollPoint(canvas, clientX, clientY, onlyId, lane) {
      if (!this._rollTimeline || !this._rollTimeline.length) return null;
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const nDrum = (this._drumLanes || []).length;
      const g = makeRollGeom(this._layout.rollOrientation, canvas.width, canvas.height, lane ? (lane.visWhite || 0) : 0, nDrum);
      // CSS表示サイズ → canvas内部解像度
      const cx = (clientX - r.left) * (canvas.width / r.width);
      const cy = (clientY - r.top) * (canvas.height / r.height);
      // canvas座標 → (音程軸p, 時間軸t)。makeRollGeom の point() の逆変換
      const p = g.vertical ? cx : (g.H - cy);
      const t = g.vertical ? (g.H - cy) : cx;
      if (t < 0 || t > g.timeLen) return null;
      const pos = this._rollLastDrawnPos || 0;
      const sec = pos + t / ROLL_PX_PER_SEC;
      const wkW = g.wk, bkW = g.bk;
      const offPx = lane ? (lane.offWhite || 0) * wkW : 0;
      const pitchOff = g.drumOff - offPx;
      // 手前(描画順が後=最前面)から探したいので逆順に見る
      for (let ti = this._rollTimeline.length - 1; ti >= 0; ti--) {
        const track = this._rollTimeline[ti];
        if (!this._inLane(onlyId, track.id)) continue;
        for (const note of track.notes) {
          if (note.startSec > sec || note.endSec <= sec) continue;
          let pLo, pSize;
          if (note.drumLane !== undefined) {
            if (note.drumLane >= nDrum) continue;
            const d = drumLaneX(note.drumLane, note.drumSub, note.drumSubN, g.drumLaneW);
            pLo = d.x - offPx + 1;
            pSize = Math.max(2, d.size - 2);
          } else {
            const kp = keyX(note.midi, wkW);
            if (!kp) continue;
            kp.x += pitchOff;
            pLo = kp.isBlack ? kp.x - bkW / 2 : kp.x + 0.5;
            pSize = kp.isBlack ? bkW : (wkW - 1);
          }
          if (p >= pLo && p < pLo + pSize) return track.id;
        }
      }
      return null;
    }

    _attachRollSeekDrag(canvas) {
      canvas.classList.add('kbd-roll--seekable');
      canvas.title = T('音符をクリックでそのchを波形表示へ / 音符の無いところをドラッグでシーク');
      const SEEK_THROTTLE_MS = 60;
      let lastSeekMs = 0;
      const applySeek = (songSec, force) => {
        const nowMs = performance.now();
        if (!force && nowMs - lastSeekMs < SEEK_THROTTLE_MS) return;
        lastSeekMs = nowMs;
        if (!this.onRollSeek) return;
        // ロールの位置は曲内の絶対秒。プレイヤー/シークバーの秒は「現在の再生速度での実時間」
        // なので速度分母を掛けて渡す(逆変換は _renderRoll のrawPos*speedFactor参照)
        const denom = this._speedDenom || 1;
        const got = this.onRollSeek(songSec * denom);
        if (typeof got === 'number' && Number.isFinite(got)) this._rollDrag.pos = got / denom;
      };
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !this._rollTimeline) return;
        // ノートの上で押した場合はシークせず、そのchを大波形へフォーカスする
        const hit = this._trackAtRollPoint(canvas, e.clientX, e.clientY, canvas._rollOnlyId != null ? canvas._rollOnlyId : null, canvas._rollLane || null);
        if (hit) { this._selectWave(hit); e.preventDefault(); return; }
        this._rollDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, startPos: this._rollLastDrawnPos || 0, pos: this._rollLastDrawnPos || 0, moved: false };
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* キャプチャ不可でも要素上のmoveで追従する */ }
        canvas.classList.add('dragging');
        e.preventDefault();
      });
      canvas.addEventListener('pointermove', (e) => {
        const d = this._rollDrag;
        if (!d || e.pointerId !== d.id) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return; // クリック程度の揺れでは動かさない
        d.moved = true;
        const vertical = this._layout.rollOrientation !== 'horizontal';
        const deltaSec = (vertical ? dy : -dx) / ROLL_PX_PER_SEC;
        d.pos = Math.max(0, d.startPos + deltaSec);
        applySeek(d.pos, false);
        this._renderRoll(this._rollLastRawPosForDrag()); // 即座に追従して描く
      });
      const finish = (e) => {
        const d = this._rollDrag;
        if (!d || e.pointerId !== d.id) return;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        canvas.classList.remove('dragging');
        if (d.moved) applySeek(d.pos, true);
        this._rollDrag = null;
        // 次の実測位置から補間を組み直す(シーク後の位置に即座に揃える)
        this._rollLastRawPos = null;
        this._rollCursor = {};
      };
      canvas.addEventListener('pointerup', finish);
      canvas.addEventListener('pointercancel', finish);
    }
    // ドラッグ中に_renderRoll()を即時呼びするための「直前の実測位置」(無ければ0)。
    // _renderRoll()はドラッグ中は表示位置に_rollDrag.posを使うので値自体は補間の帳尻用
    _rollLastRawPosForDrag() { return this._rollLastRawPos == null ? 0 : this._rollLastRawPos; }

    // ── スポットライト(案D) ────────────────────────────────────────
    // チャンネル一覧の行にホバー(一時)/ch名クリック(固定)で「注目ch」を決め、ロール描画で
    // そのchだけを原色・最前面に、他chをSPOTLIGHT_DIM_ALPHAまで減光する。
    // ★ホバー中はホバーが勝ち、マウスが一覧から離れたら固定へ戻る。固定は「マウスを離しても
    //   注目を失わない」ためのもので、他の行を覗く操作を殺すためのものではないため。
    _effectiveSpotlightId() { return this._spotlightHoverId || this._spotlightPinnedId; }

    // 停止中はrAFが回っていないので、注目chが変わったらその場で描き直す。
    // _renderRoll()は同じrawPosを渡しても位置を進めない(実測差分ぶんしか加算しない)ので安全。
    _redrawRollForSpotlight() {
      if (!this._rollTimeline) return;
      this._renderRoll(this._rollLastRawPosForDrag());
    }

    // ★ホバーでのピックアップは「その行の小波形が大波形として選択されている」ときだけ効かせる
    //   (ユーザー指示)。一覧の上をマウスが通るだけで次々ロールが切り替わるのを避け、
    //   「注目したいchを波形で選んでから、その行を指す」という操作に揃える。
    _setSpotlightHover(id) {
      if (id !== null && id !== this._shownWaveId) id = null;
      if (this._spotlightHoverId === id) return;
      this._spotlightHoverId = id;
      this._redrawRollForSpotlight();
    }

    // ch名クリックで固定のON/OFF。同じ行をもう一度クリックすると解除する
    _toggleSpotlightPin(id) {
      this._spotlightPinnedId = (this._spotlightPinnedId === id) ? null : id;
      this._applySpotlightClasses();
      this._redrawRollForSpotlight();
    }

    // 固定中の行に目印クラスを付ける(行の再構築後にも呼んで状態を復元する)
    _applySpotlightClasses() {
      for (const r of (this._rowEls || []).concat(this._spcRowEls || [])) {
        if (!r || !r.row) continue;
        r.row.classList.toggle('kbd-ch-row--spot', r.id === this._spotlightPinnedId);
      }
    }

    // 1行にスポットライトの操作を取り付ける(メイン一覧・SPCボイス行の両方から呼ぶ)。
    // ホバーは行全体、固定はch名セルのクリック(丸=色ピッカー/波形=大波形/note=キャリブレーションと
    // 衝突しない場所を選ぶ)
    _attachSpotlight(row, id) {
      row.addEventListener('mouseenter', () => this._setSpotlightHover(id));
      row.addEventListener('mouseleave', () => this._setSpotlightHover(null));
      const nameEl = row.querySelector('.kbd-name');
      if (!nameEl) return;
      nameEl.classList.add('kbd-name--clickable');
      // 行名に説明が付いている行(PSF トラックモードの複製「T9≈」)はそれを先頭に残す
      const spotHint = T('クリックでこのチャンネルに注目(他chを減光)。もう一度クリックで解除');
      nameEl.title = nameEl.title && nameEl.title !== spotHint ? nameEl.title + '\n' + spotHint : spotHint;
      nameEl.addEventListener('click', () => this._toggleSpotlightPin(id));
    }

    // 実効的なロールの置き場。'window'は別ウィンドウのコンテナ(#pianoRollDisplay)が
    // 無いページでは'bottom'扱いにする
    _effectivePlacement() {
      const p = this._layout.rollPlacement;
      if (p === 'window' && !document.getElementById('pianoRollDisplay')) return 'bottom';
      return p;
    }

    // ロールペインをレイアウト設定(_layout.rollPlacement)に応じた親へ取り付ける。
    //   'bottom': チャンネル一覧(.kbd-main)の下(従来配置)。手前にロール高さ用スプリッター
    //   'right' : 一覧の右(.kbd-main内)。手前に一覧幅用スプリッター
    //   'window': 別ウィンドウ(#pianoRollDisplay)
    _mountRollPane() {
      const pane = this._rollPaneEl;
      if (!pane) return;
      if (pane.parentNode) pane.parentNode.removeChild(pane);
      for (const sp of [this._listSplitterEl, this._rollSplitterEl]) {
        if (sp && sp.parentNode) sp.parentNode.removeChild(sp);
      }
      const placement = this._effectivePlacement();
      if (placement === 'right') {
        this._mainEl.appendChild(this._listSplitterEl);
        this._mainEl.appendChild(pane);
      } else if (placement === 'window') {
        document.getElementById('pianoRollDisplay').appendChild(pane);
      } else {
        this.container.appendChild(this._rollSplitterEl);
        this.container.appendChild(pane);
      }
    }

    // 大波形パネルの置き場。ロールが一覧の下で一覧が1列(従来レイアウト)のときは一覧の右、
    // それ以外(右側をロールが使う/一覧が幅いっぱいに広がる)は一覧の下の折りたたみ帯に置く
    _bigWaveBelow() {
      return this._effectivePlacement() !== 'bottom' || this._layout.listColumns === 'auto';
    }
    // チャンネル一覧が幅いっぱいに広がる配置か(下配置で多段、または別ウィンドウ配置)
    _listFlexible() {
      const placement = this._effectivePlacement();
      return placement === 'window' || (placement === 'bottom' && this._layout.listColumns === 'auto');
    }
    // ファイル情報ペインの実際の置き場。'auto' は他の置き場から自動で決める:
    //  ・大波形が一覧の下にあり、かつ一覧が幅いっぱい(多段/別ウィンドウ)
    //      → 一覧の下(大波形と同じ帯に左右で並ぶ。ユーザー指示 2026-09-10)
    //  ・それ以外(一覧が固定幅で左右に余裕が無い)
    //      → 一覧の上(縦に足す方が場所を食わない)
    _effectiveFileInfoPlacement() {
      const p = this._layout.fileInfoPlacement;
      if (LAYOUT_CHOICES.fileInfoPlacement.includes(p) && p !== 'auto') return p;
      return (this._bigWaveBelow() && this._listFlexible()) ? 'bottom' : 'top';
    }

    // 大波形パネルとファイル情報ペインを、レイアウト設定に応じた置き場へ取り付ける。
    //   大波形    : 一覧の右(.kbd-main内) or 一覧の下の帯(.kbd-below)
    //   ファイル情報: 一覧の上/下(.kbd-left内) or 一覧の左/右(.kbd-main内)
    // 「一覧の下」に来たものは .kbd-below にまとめ、両方が下なら左右に並べる(ファイル情報が左)。
    _mountPanes() {
      const big = this._bigWaveEl, fi = this._fileInfoEl, band = this._belowEl;
      if (!big || !fi || !band) return;
      // いったん全部外してから置き直す(置き場が変わるとスプリッターの向きも変わるため)
      for (const el of [big, fi, band, this._waveSplitterEl, this._waveSplitterVEl,
                        this._fiSplitterEl, this._bandSplitterEl]) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
      this._fiSplitterEl = null;
      this._bandSplitterEl = null;
      // 置き場が変わったらインラインサイズは捨てる(縦横で意味が変わるため)
      big.style.flex = '';
      big.style.width = '';
      const fiPlace = this._effectiveFileInfoPlacement();
      const bigBelow = this._bigWaveBelow();

      // ── 一覧の下の帯(.kbd-below) ─────────────────────────────
      band.classList.toggle('kbd-below--row', fiPlace === 'bottom' && bigBelow);
      if (fiPlace === 'bottom') band.appendChild(fi);
      if (bigBelow) {
        if (fiPlace === 'bottom') {
          // 帯の中の仕切り。右へ引く=ファイル情報が広くなる
          this._fiSplitterEl = this._makeSplitter('vertical', (delta, start) => {
            const w = Math.max(120, Math.round(start + delta));
            this._fileInfoWidth = w;
            fi.style.flex = 'none';
            fi.style.width = w + 'px';
          }, () => fi.offsetWidth, () => this._saveFileInfoSize());
          band.appendChild(this._fiSplitterEl);
        }
        band.appendChild(big);
      }
      if (band.firstChild) {
        if (bigBelow) {
          // 従来どおり「一覧の高さ」を変える仕切り(帯は中身なりの高さ)
          this._leftEl.appendChild(this._waveSplitterEl);
        } else {
          // 帯にファイル情報しか無いとき。上へ引く=ファイル情報が高くなる
          this._bandSplitterEl = this._makeSplitter('horizontal', (delta, start) => {
            const h = Math.max(48, Math.round(start - delta));
            this._fileInfoHeight = h;
            fi.style.flex = 'none';
            fi.style.height = h + 'px';
          }, () => fi.offsetHeight, () => this._saveFileInfoSize());
          this._leftEl.appendChild(this._bandSplitterEl);
        }
        this._leftEl.appendChild(band);
      }
      this._applyRowsHeight();

      // ── 大波形が一覧の右(.kbd-main内) ───────────────────────────
      if (!bigBelow) {
        this._mainEl.appendChild(this._waveSplitterVEl);
        this._mainEl.appendChild(big);
        if (this._bigWaveWidth) {
          big.style.flex = 'none';
          big.style.width = this._bigWaveWidth + 'px';
        }
      }

      // ── ファイル情報が一覧の上/左/右 ────────────────────────────
      if (fiPlace === 'top') {
        // 下へ引く=ファイル情報が高くなる
        this._fiSplitterEl = this._makeSplitter('horizontal', (delta, start) => {
          const h = Math.max(48, Math.round(start + delta));
          this._fileInfoHeight = h;
          fi.style.flex = 'none';
          fi.style.height = h + 'px';
        }, () => fi.offsetHeight, () => this._saveFileInfoSize());
        this._leftEl.insertBefore(this._fiSplitterEl, this._leftEl.firstChild);
        this._leftEl.insertBefore(fi, this._leftEl.firstChild);
      } else if (fiPlace === 'left' || fiPlace === 'right') {
        const toRight = fiPlace === 'right'; // 仕切りがペインの左に来るのでドラッグの向きが逆
        this._fiSplitterEl = this._makeSplitter('vertical', (delta, start) => {
          const w = Math.max(120, Math.round(toRight ? start - delta : start + delta));
          this._fileInfoWidth = w;
          fi.style.flex = 'none';
          fi.style.width = w + 'px';
        }, () => fi.offsetWidth, () => this._saveFileInfoSize());
        if (toRight) {
          this._mainEl.insertBefore(this._fiSplitterEl, this._leftEl.nextSibling);
          this._mainEl.insertBefore(fi, this._fiSplitterEl.nextSibling);
        } else {
          this._mainEl.insertBefore(this._fiSplitterEl, this._leftEl);
          this._mainEl.insertBefore(fi, this._fiSplitterEl);
        }
      }
      this._applyFileInfoSize();
    }

    _saveFileInfoSize() {
      try {
        localStorage.setItem('mml_kbdFileInfoWidth', String(this._fileInfoWidth || 0));
        localStorage.setItem('mml_kbdFileInfoHeight', String(this._fileInfoHeight || 0));
      } catch (e) { /* ignore */ }
    }

    // ファイル情報ペインの置き場クラス・大きさ・折りたたみをインラインスタイルへ反映する
    _applyFileInfoSize() {
      const fi = this._fileInfoEl;
      if (!fi) return;
      const place = this._effectiveFileInfoPlacement();
      const collapsed = this._fileInfoCollapsed;
      for (const p of ['top', 'bottom', 'left', 'right']) fi.classList.toggle('kbd-fileinfo--' + p, p === place);
      fi.classList.toggle('kbd-fileinfo--collapsed', collapsed);
      if (this._fiToggleEl) this._fiToggleEl.textContent = collapsed ? '▶' : '▼';
      fi.style.flex = '';
      fi.style.width = '';
      fi.style.height = '';
      // 畳んだ間、およびサウンドファイルをまだ開いていない間(案内文1行だけ)は中身なりの
      // 大きさにする。MMLしか使わない人の鍵盤表示から、空のペインが場所を取らないように。
      // ★flex:'none'(縮まない)まで指定すること。このペインは一覧の列(.kbd-left)の中で唯一
      //   flex-shrinkが効く箱なので、ch数の多い曲(VGMのNamco System 2で33行など)で
      //   一覧が縦に溢れると、見出し1行ぶんの高さごと0まで潰されて消えてしまう
      //   (「畳むと畳むボタンの行まで消える」ユーザー報告 2026-09-12)
      if (collapsed || !(this._fileInfoNodes || []).length) { fi.style.flex = 'none'; return; }
      // 左右に並ぶ置き場は幅を、上下に積む置き場は高さをスプリッターの値で固定する
      const sideways = place === 'left' || place === 'right' || (place === 'bottom' && this._bigWaveBelow());
      fi.style.flex = 'none';
      if (sideways) fi.style.width = (this._fileInfoWidth || FILE_INFO_DEFAULT_W) + 'px';
      else fi.style.height = (this._fileInfoHeight || FILE_INFO_DEFAULT_H) + 'px';
    }

    // ファイル情報ペインの中身を貼り直す(main.jsから預かった要素+見出し)。
    // 見出しは原文(日本語)で持ち、言語切替で作り直されるたびにT()で引き直す
    _renderFileInfo() {
      if (!this._fiTitleEl || !this._fiBodyEl) return;
      this._fiTitleEl.textContent = this._fileInfoTitleKey ? T(this._fileInfoTitleKey) : T('ファイル情報');
      // 今出ている要素は「元の親」(#soundFileControls)へ返してから入れ替える。
      // ★捨ててはいけない: これらは main.js / convertSettings.js が id で引く実体なので、
      //   親から外れたままだと document.getElementById() が null になり、別のフォーマットへ
      //   切り替えた後にヘッダ情報も変換ログも出なくなる
      while (this._fiBodyEl.firstChild) {
        const n = this._fiBodyEl.firstChild;
        if (n._kbdFiHome) n._kbdFiHome.appendChild(n);
        else this._fiBodyEl.removeChild(n);
      }
      const nodes = (this._fileInfoNodes || []).filter(n => n);
      for (const n of nodes) {
        if (!n._kbdFiHome && n.parentNode && n.parentNode !== this._fiBodyEl) n._kbdFiHome = n.parentNode;
      }
      if (!nodes.length) {
        const empty = document.createElement('div');
        empty.className = 'kbd-fileinfo-empty';
        empty.textContent = T('サウンドファイルを開くと、ここにヘッダ情報が出ます。');
        this._fiBodyEl.appendChild(empty);
        return;
      }
      for (const n of nodes) this._fiBodyEl.appendChild(n);
    }

    /**
     * ファイル情報ペインの中身を差し替える(main.jsのsyncKeyboardFileInfoから呼ぶ)。
     * @param {string} titleKey 見出しの原文(日本語)。翻訳はこちら側でT()を通す
     * @param {Element[]} nodes 表示する要素。main.jsが持つ #xxxFileHeader / #xxxFileStatus を付け替える
     */
    setFileInfo(titleKey, nodes) {
      this._fileInfoTitleKey = titleKey || '';
      this._fileInfoNodes = Array.isArray(nodes) ? nodes.slice() : [];
      this._renderFileInfo();
      this._applyFileInfoSize(); // 空↔中身ありで大きさの決め方が変わる
    }

    // レイアウト設定をCSSクラス/インラインサイズへ反映する(向き・置き場・多段・折りたたみ)
    _applyLayoutClasses() {
      const L = this._layout;
      const placement = this._effectivePlacement();
      const horizontal = L.rollOrientation === 'horizontal';
      const below = this._bigWaveBelow();
      const pane = this._rollPaneEl;
      if (pane) {
        pane.classList.toggle('kbd-roll-wrap--horizontal', horizontal);
        // 右/別ウィンドウ配置ではペインが親いっぱいに広がる(ロールがflex:1)。下配置は固定高さ
        pane.classList.toggle('kbd-roll-wrap--fill', placement !== 'bottom');
        pane.classList.toggle('kbd-roll-wrap--nocollapse', placement !== 'bottom');
        pane.classList.toggle('kbd-roll-wrap--window', placement === 'window'); // 窓のタイトルと二重になる見出しラベルを隠す
        // チャンネルごとのレーン表示: まとめ表示の本体(.kbd-roll-body)を隠してレーン群を出す
        const lanesMode = L.rollLanes === 'perChannel';
        pane.classList.toggle('kbd-roll-wrap--lanes', lanesMode);
        const collapsed = placement === 'bottom' && this._rollCollapsed;
        this._rollCanvas.style.display = collapsed ? 'none' : '';
        if (this._lanesEl) this._lanesEl.style.display = (collapsed || !lanesMode) ? 'none' : '';
        const toggle = this._rollHeaderEl && this._rollHeaderEl.querySelector('.kbd-roll-toggle');
        if (toggle) toggle.textContent = collapsed ? '▶' : '▼';
        // 下配置は固定高さ(スプリッターで可変)。レーン表示のコンテナは各レーンに鍵盤も含むので、
        // 縦向きはロール高さ+鍵盤高さぶん確保して全体の高さをまとめ表示と揃える
        this._rollCanvas.style.height = placement === 'bottom' ? (this._rollHeight + 'px') : '';
        if (this._lanesEl) {
          this._lanesEl.style.height = placement === 'bottom'
            ? ((this._rollHeight + (horizontal ? 0 : PIANO_KEY_LEN)) + 'px') : '';
        }
      }
      const left = this._leftEl;
      if (left) {
        // 一覧の幅: 右配置=スプリッターで決めた固定幅 / 下配置で1列=CSS既定の固定幅(従来) /
        // それ以外(下配置で多段、別ウィンドウ配置)=幅いっぱい
        const flexible = this._listFlexible();
        left.classList.toggle('kbd-left--flex', flexible);
        left.classList.toggle('kbd-left--multicol', L.listColumns === 'auto');
        // 大波形を一覧の下に置くときは、行一覧を伸ばして最下部に張り付けるのでなく
        // チャンネル行のすぐ下に続ける(行が少ないと間が空いて「左下」に見えるため)
        left.classList.toggle('kbd-left--wave-below', below);
        // 右配置の一覧幅。SPCモードは列が多いので全列が収まる幅(SPC_LIST_MIN_WIDTH)を下限にする
        let w = '';
        if (placement === 'right') {
          // 割当表示ONのときは「借用先/音色」列(ASSIGN_COL_WIDTH)が入る幅を下限にする
          // (スプリッターで狭めた幅のままだと右側の列が押し出されて見えなくなるため)
          const base = this._mode === 'spc' ? SPC_LIST_MIN_WIDTH
            : (left.classList.contains('kbd-left--hes') || left.classList.contains('kbd-left--gbs'))
              ? LIST_WIDTH_PAN : LIST_WIDTH_NSF;
          const min = this._assignMode ? base + ASSIGN_COL_WIDTH : (this._mode === 'spc' ? SPC_LIST_MIN_WIDTH : 0);
          const want = Math.max(this._listWidth || 0, min);
          if (want > 0) w = want + 'px';
        }
        left.style.width = w;
      }
      const big = this._bigWaveEl;
      if (big) {
        big.classList.toggle('kbd-bigwave--below', below);
        big.classList.toggle('kbd-bigwave--collapsed', below && this._bigWaveCollapsed);
        // FM音色データの箱: ロールが下/別窓で一覧が多段(幅いっぱい)のときだけ大波形の右、他は下
        big.classList.toggle('kbd-bigwave--patch-right', placement !== 'right' && L.listColumns === 'auto');
        this._bigToggleEl.textContent = this._bigWaveCollapsed ? '▶' : '▼';
      }
      if (this._mainEl) this._mainEl.classList.toggle('kbd-main--roll-right', placement === 'right');
      this._applyFileInfoSize(); // ファイル情報ペインの折りたたみ/大きさも一緒に反映する
    }

    // 現在のレイアウト設定(コピー)を返す
    getLayout() { return Object.assign({}, this._layout); }

    // レイアウト設定を部分的に変更して即反映・永続化する。
    // 例: setLayout({ rollOrientation: 'horizontal' })
    setLayout(partial) {
      let changed = false;
      for (const k of Object.keys(LAYOUT_DEFAULTS)) {
        if (partial && LAYOUT_CHOICES[k].includes(partial[k]) && partial[k] !== this._layout[k]) {
          this._layout[k] = partial[k];
          changed = true;
        }
      }
      if (!changed) return;
      // 手で変えたレーンの大きさは向き(幅⇔高さ)や分割方法が変わると意味が変わるので捨てる
      this._laneSizes.clear();
      saveLayoutSettings(this._layout);
      this._mountRollPane();
      this._mountPanes();
      this._rebuildLanes();
      this._applyLayoutClasses();
      // canvasの内部解像度は次の描画でサイズキャッシュから決め直す。向きが変わると
      // 表示サイズも変わるので、古いキャッシュ値で1フレーム描かないよう捨てておく
      for (const c of [this._rollCanvas, this._canvas]) {
        if (!c) continue;
        delete c._cachedWidth;
        delete c._cachedHeight;
      }
      this._rollCursor = {};
      this._rollLastRawPos = null;
      if (this._shownWaveId) this._bigWaveSig = ''; // 置き場が変わった大波形は描き直す
      if (this.onLayoutChange) this.onLayoutChange(this.getLayout());
    }

    // レイアウト設定のポップオーバー(⚙ボタン直下)。ラジオ3組(向き/置き場/一覧)で即反映。
    // 外側クリック/Escで閉じる。既に開いていれば閉じる(トグル)。
    _openLayoutPopover(anchorEl) {
      if (this._layoutPopEl) { this._closeLayoutPopover(); return; }
      const groups = [
        { key: 'rollOrientation', label: T('ピアノロールの向き'), options: [
          ['vertical', T('縦 (音符が上から鍵盤へ降る)')],
          ['horizontal', T('横 (音符が右から鍵盤へ流れる)')],
        ] },
        { key: 'rollPlacement', label: T('ピアノロールの置き場'), options: [
          ['bottom', T('チャンネル一覧の下')],
          ['right', T('チャンネル一覧の右')],
          ['window', T('別ウィンドウ')],
        ] },
        { key: 'listColumns', label: T('チャンネル一覧'), options: [
          ['single', T('1列')],
          ['auto', T('幅に応じて自動で多段')],
        ] },
        { key: 'rollLanes', label: T('ピアノロールの鍵盤'), options: [
          ['all', T('全チャンネルを1つの鍵盤に')],
          ['perChannel', T('チャンネルごとに分割 (収まらない分はスクロール)')],
        ] },
        { key: 'rollView', label: T('ピアノロールの表示'), options: [
          ['roll', T('ピアノロール')],
          ['score', T('楽譜 (五線、時間比例。MML再生のみ)')],
        ] },
        { key: 'fileInfoPlacement', label: T('ファイル情報の置き場'), options: [
          ['auto', T('自動 (他の置き場に合わせる)')],
          ['top', T('チャンネル一覧の上')],
          ['bottom', T('チャンネル一覧の下')],
          ['left', T('チャンネル一覧の左')],
          ['right', T('チャンネル一覧の右')],
        ] },
      ];
      const pop = document.createElement('div');
      pop.className = 'kbd-layout-pop';
      pop.addEventListener('mousedown', (e) => e.stopPropagation()); // ウィンドウのドラッグ/前面化を起こさない
      pop.addEventListener('click', (e) => e.stopPropagation());
      for (const g of groups) {
        const sec = document.createElement('div');
        sec.className = 'kbd-layout-sec';
        const title = document.createElement('div');
        title.className = 'kbd-layout-sec-title';
        title.textContent = g.label;
        sec.appendChild(title);
        for (const [value, text] of g.options) {
          const lab = document.createElement('label');
          lab.className = 'kbd-layout-opt';
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'kbd-layout-' + g.key;
          radio.value = value;
          radio.checked = this._layout[g.key] === value;
          radio.addEventListener('change', () => { if (radio.checked) this.setLayout({ [g.key]: value }); });
          lab.appendChild(radio);
          lab.appendChild(document.createTextNode(text));
          sec.appendChild(lab);
        }
        pop.appendChild(sec);
      }
      document.body.appendChild(pop);
      // アンカー(⚙)の直下、右端揃え。画面からはみ出す場合は左へ寄せる
      const r = anchorEl.getBoundingClientRect();
      const pw = pop.offsetWidth, ph = pop.offsetHeight;
      let left = r.right - pw, top = r.bottom + 4;
      if (left < 4) left = 4;
      if (top + ph > window.innerHeight - 4) top = Math.max(4, r.top - ph - 4);
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
      this._layoutPopEl = pop;
      this._layoutPopClose = (e) => {
        if (e.type === 'keydown' && e.key !== 'Escape') return;
        if (e.type === 'mousedown' && (pop.contains(e.target) || anchorEl.contains(e.target))) return;
        this._closeLayoutPopover();
      };
      setTimeout(() => {
        document.addEventListener('mousedown', this._layoutPopClose, true);
        document.addEventListener('keydown', this._layoutPopClose, true);
      }, 0);
    }
    _closeLayoutPopover() {
      if (!this._layoutPopEl) return;
      this._layoutPopEl.remove();
      this._layoutPopEl = null;
      document.removeEventListener('mousedown', this._layoutPopClose, true);
      document.removeEventListener('keydown', this._layoutPopClose, true);
      this._layoutPopClose = null;
    }

    setSource(result, chips) {
      this._chips = Array.isArray(chips) ? chips.filter(c => c && c !== 'none') : [];
      // 楽譜モードの表記モデルは曲ごと(MML のコンパイル結果)なので、ソースが変わったら捨てる。
      // MML 再生なら main.js が setMonitorSource() の直後に setScore() で入れ直す
      this._score = null;
      this._scoreCursor = {};
      // 基準ピッチ(#TUNING): MML再生(main.js setMonitorSource が compiled.settings.tuningCents を渡す)の
      // 鍵盤ハイライト/ロールを、ずらした基準で音名に丸める。実ファイル再生は未指定=0
      rollTuningCents = (result && result.tuningCents) ? +result.tuningCents : 0;
      // L/R(ステレオパン)列はHES/GBSのみ意味を持つため、他フォーマットでは非表示にする
      // (表示/パネル幅はCSS側の.kbd-left--hes/.kbd-left--gbsで切り替え、詳細はstyle.css参照)。
      this._leftEl.classList.toggle('kbd-left--hes', this._chips.includes('hes'));
      // VGMのステレオ定位を持つチップ(SN76489=Game Gearステレオ、YM2612/YM2610=FM/ADPCMのL/R、
      // 32X PWM、RF5C68/164=パン)もGBS用のL/R列表示を流用する。
      // ★以前は gbs/sn76489 だけだったため、SN76489の無い Neo Geo(YM2610)では L/R 列が出ていなかった
      const PAN_CHIPS = ['gbs', 'sn76489', 'ym2612', 'ym2610fm', 'ym2151', 'ym2608fm', 'segapcm', 'c140', 'c352', 'psx', 'okim6258', 'k007232', 'k054539', 'qsound', 'multipcm', 'pwm', 'rf5c164', 'rf5c68'];
      this._leftEl.classList.toggle('kbd-left--gbs', PAN_CHIPS.some(c => this._chips.includes(c)));
      // ★L/R列に16bitの実レジスタを出す音源は列ごと広げる(2026-09-17のユーザー合意)。
      //   PSX=VOLL/VOLR(-32768..32767) / QSound=パン(0x110-0x130) / C352=前後4値の併記。
      //   曲頭はスナップショットがまだ無く行データからは判定できないので、**チップ構成で決める**
      //   (PAN_CHIPS と同じ考え方。列は縦に揃っていないと読めないので一覧まるごと切り替える)
      const LR_WIDE_CHIPS = ['psx', 'qsound', 'c352'];
      this._leftEl.classList.toggle('kbd-left--lrwide', LR_WIDE_CHIPS.some(c => this._chips.includes(c)));
      this._extraSnaps = {};
      const wl = result.writeLog || [];
      if (this._chips.includes('vrc7')) this._extraSnaps.vrc7 = buildVrc7Snapshots(wl);
      if (this._chips.includes('n163')) this._extraSnaps.n163 = buildN163Snapshots(wl);
      if (this._chips.includes('fme7')) this._extraSnaps.fme7 = buildFme7Snapshots(wl);
      // APU矩形波1/2・ノイズのエンベロープ実出力レベル。
      // 事前キャプチャ経路は静的配列(apuEnv)、リアルタイム再生経路は毎回ライブAPUを読む関数(apuEnvLive)。
      this._extraSnaps.apuEnv = result.apuEnvSnapshots || null;
      this._extraSnaps.apuEnvLive = typeof result.getApuEnv === 'function' ? result.getApuEnv : null;
      this._extraSnaps.n163Live = typeof result.getN163 === 'function' ? result.getN163 : null;
      this._extraSnaps.fme7Live = typeof result.getFME7 === 'function' ? result.getFME7 : null;
      this._extraSnaps.mmc5Live = typeof result.getMmc5 === 'function' ? result.getMmc5 : null;
      this._extraSnaps.vrc7Live = typeof result.getVRC7 === 'function' ? result.getVRC7 : null;
      this._extraSnaps.kssPsgLive = typeof result.getKssPsg === 'function' ? result.getKssPsg : null;
      this._extraSnaps.kssSccLive = typeof result.getKssScc === 'function' ? result.getKssScc : null;
      this._extraSnaps.kssOpllLive = typeof result.getKssOpll === 'function' ? result.getKssOpll : null;
      this._extraSnaps.gbsApuLive = typeof result.getGbsApu === 'function' ? result.getGbsApu : null;
      this._extraSnaps.hesApuLive = typeof result.getHesApu === 'function' ? result.getHesApu : null;
      this._extraSnaps.snLive = typeof result.getSn76489 === 'function' ? result.getSn76489 : null;
      this._extraSnaps.ymLive = typeof result.getYm2612 === 'function' ? result.getYm2612 : null;
      this._extraSnaps.ym2610FmLive = typeof result.getYm2610Fm === 'function' ? result.getYm2610Fm : null;
      this._extraSnaps.ym2151Live = typeof result.getYm2151 === 'function' ? result.getYm2151 : null;
      this._extraSnaps.ym2203FmLive = typeof result.getYm2203Fm === 'function' ? result.getYm2203Fm : null;
      this._extraSnaps.ym2608FmLive = typeof result.getYm2608Fm === 'function' ? result.getYm2608Fm : null;
      this._extraSnaps.oplLive = typeof result.getOpl === 'function' ? result.getOpl : null;
      this._extraSnaps.ga20Live = typeof result.getGa20 === 'function' ? result.getGa20 : null;
      this._extraSnaps.k007232Live = typeof result.getK007232 === 'function' ? result.getK007232 : null;
      this._extraSnaps.k054539Live = typeof result.getK054539 === 'function' ? result.getK054539 : null;
      this._extraSnaps.msm5205Live = typeof result.getMsm5205 === 'function' ? result.getMsm5205 : null;
      this._extraSnaps.segapcmLive = typeof result.getSegaPcm === 'function' ? result.getSegaPcm : null;
      this._extraSnaps.c140Live = typeof result.getC140 === 'function' ? result.getC140 : null;
      this._extraSnaps.c352Live = typeof result.getC352 === 'function' ? result.getC352 : null;
      this._extraSnaps.psxLive = typeof result.getPsx === 'function' ? result.getPsx : null;
      this._extraSnaps.okim6258Live = typeof result.getOkim6258 === 'function' ? result.getOkim6258 : null;
      this._extraSnaps.qsoundLive = typeof result.getQsound === 'function' ? result.getQsound : null;
      this._extraSnaps.okim6295Live = typeof result.getOkim6295 === 'function' ? result.getOkim6295 : null;
      this._extraSnaps.multipcmLive = typeof result.getMultiPcm === 'function' ? result.getMultiPcm : null;
      this._extraSnaps.pwmLive = typeof result.getPwm === 'function' ? result.getPwm : null;
      this._extraSnaps.rf5c164Live = typeof result.getRf5c164 === 'function' ? result.getRf5c164 : null;
      this._extraSnaps.rf5c68Live = typeof result.getRf5c68 === 'function' ? result.getRf5c68 : null;
      this._lastDmc4011 = null; // 曲切替時にDMC書き込み検出をリセット
      this._rollSongTimeBase = 0; // 曲切替時にピアノロールの経過時間もリセット
      this._rollLastRawPos = null;
      this._rollBaseWallMs = null;
      this._state = {
        regSnapshots: result.regSnapshots || [],
        writeLog: result.writeLog || [], // ロール構築でDPCMの発声終了(buildDmcTimeline)を出すのに使う
        totalFrames: result.totalFrames || 0,
        samplesPerFrame: result.samplesPerFrame || 735,
        sampleRate: result.sampleRate || 44100,
      };

      const snap0 = this._state.regSnapshots[0] || {};
      this._prevChannels = extractChannels(snap0, this._extraSnaps, 0, this._chips);
      this._rebuildRows(this._prevChannels);
      this.setMode('nsf');

      // 全曲分のレジスタスナップショットが既にある場合(MML/事前キャプチャ済みNSF)は
      // ピアノロールを即座に構築できる。ライブ追跡のみ(totalFrames=1)の場合は
      // 未構築のままにし、setRollTimelineFromRegSnapshots()/setRollTimeline() による
      // 非同期の先読みキャプチャ結果を待つ。
      if (this._state.totalFrames > 1) {
        const frameDur = this._state.samplesPerFrame / this._state.sampleRate;
        // ロール構築はフレームfごとの「過去の履歴」を辿る必要があるが、n163Live/fme7Live/
        // vrc7Live/mmc5Liveは「今まさに再生中のライブチップの現在状態」を返す関数であり、
        // フレームに関わらず常に同じ値を返してしまう(全フレームがその場のスナップショットの
        // コピーになる=事実上ずっと無音として扱われる)。extractChannelsはchips.includes(...)の
        // 各分岐で「Live関数があれば無条件にそちらを優先」するため、setSource()をMML再生
        // (呼び出し時点ではまだ再生開始前でactivePlayerが無く、Live関数は必ずnullを返す)
        // から呼んだ場合にN163/FME7の音符がピアノロールに一切出ない不具合があった。
        // ロール構築専用にLive系を外し、writeLog由来の履歴配列(n163/fme7/vrc7)または
        // レジスタスナップショット直読み(mmc5)にフォールバックさせる
        // (setRollTimelineFromRegSnapshots()と同じ考え方)。
        const dmcTl = buildDmcTimeline(this._state.writeLog || [], this._state.totalFrames, frameDur);
        const rollExtraSnaps = Object.assign({}, this._extraSnaps,
          { n163Live: null, fme7Live: null, vrc7Live: null, mmc5Live: null, dmcSeq: dmcTl.seq, dmcEnd: dmcTl.end });
        this._rollTimeline = buildNoteTimelineFromChannelFrames(
          (f) => extractChannels(this._state.regSnapshots[f] || {}, rollExtraSnaps, f, this._chips),
          this._state.totalFrames, frameDur
        );
      } else {
        this._rollTimeline = null;
      }
      this._rebuildDrumLanes();
      this._updateLaneRanges();
    }

    // ピアノロール用タイムラインを直接差し替える(共通形状: [{color, notes:[{startSec,endSec,midi}]}])。
    // SPC/KSSのような完全リアルタイム合成フォーマットで、裏で走らせた先読みキャプチャの
    // 結果を非同期に反映する際に main.js から呼ばれる。
    setRollTimeline(timeline) {
      this._rollTimeline = timeline || null;
      this._rollCursor = {};
      this._rebuildDrumLanes();
      this._updateLaneRanges();
    }

    // ロールのトラックの区画情報を後から更新する。metaById: 行ID → {laneGroup, laneCopy}。
    // PSF のトラックモードは複製(デチューン二重化/エコー)の判定が曲を最後まで取り込んでから決まるので、
    // 既に組んであるタイムラインへ印だけ足して描き直す(ロールを組み直すと重いため。main.js psfRefreshTrackPlan)
    setRollTrackLaneMeta(metaById) {
      if (!this._rollTimeline || !metaById) return;
      for (const t of this._rollTimeline) {
        const m = metaById[t.id];
        if (!m) continue;
        t.laneGroup = m.laneGroup;
        t.laneCopy = !!m.laneCopy;
      }
      this._updateLaneRanges();
      this._redrawRollForSpotlight();
    }

    // 楽譜モード(レイアウト設定 rollView='score')の材料。score = { notation(src/score/notation.js の
    // 表記モデル), fps(コンパイラのフレームレート), loopPointFrame, totalFrames } | null。
    // 表記モデルの各音符片は frameStart/frameEnd(コンパイラのフレーム)を持つので、fps で秒に直せば
    // ロールと同じ「再生位置 pos からの相対秒」で描ける。null で楽譜なし(ロール表示に戻る)
    setScore(score) {
      this._score = score && score.notation ? score : null;
      this._scoreCursor = {};
      if (!this._score) return;
      // 毎フレームの走査用に、パートごとの音符片を時間順に平らに並べておく(小節の入れ子を辿らない)
      for (const part of this._score.notation.parts) {
        const flat = [];
        for (const m of part.measures) for (const it of m.items) flat.push(it);
        part.flatItems = flat;
      }
    }
    getScore() { return this._score; }

    // ドラム区画のレーン表を、タイムラインのノートに書き込まれた drumLane/drumKey から組み直す。
    // ★配列に生やしたプロパティ(result.drumLanes のような形)はWorkerからのpostMessageの
    //   構造化複製で消えるため、レーン表そのものは渡さず「noteが持っている情報から復元する」
    //   方式にしてある(assignDrumLanes冒頭のコメント参照)。
    // this._drumLanes: [{key, label, color, subN}]  区画に出す順(=レーン番号順)
    // this._drumLaneOf: Map(drumKey → レーン番号)   鍵盤のパッド点灯(drawPiano)用
    // drawPiano()へ渡すドラム区画の情報。区画が無いときはundefinedを返し、鍵盤の描画を
    // 従来と完全に同じにする
    /**
     * DPCMの実コスト表示。cost = {clips, segments, bytes} | null(=DPCM未使用で非表示)。
     * 'pending' を渡すと計算中の表示にする。
     */
    setDpcmCost(cost) {
      if (!this._dpcmCostEl) return;
      if (!cost) { this._dpcmCostEl.style.display = 'none'; return; }
      this._dpcmCostEl.style.display = '';
      if (cost === 'pending') { this._dpcmCostEl.textContent = T('DPCM: 計算中…'); return; }
      const kb = (cost.bytes / 1024).toFixed(1);
      this._dpcmCostEl.innerHTML =
        `<span class="kbd-dpcm-cost-label">DPCM</span>` +
        T('定義 {clips} / 打点 {segments} / ROM {kb} KB', { clips: cost.clips, segments: cost.segments, kb });
      // ROMが大きいときは色で知らせる。16KB(DMC領域1ページ)を超えると16KBごとのページに分けて
      // トリガー時にバンク切替する(2026-09-10、無音にはならない)ので、16KB超=黄色「大きい」だけ
      this._dpcmCostEl.classList.toggle('kbd-dpcm-cost--warn', cost.bytes >= 16 * 1024);
      this._dpcmCostEl.classList.remove('kbd-dpcm-cost--over');
    }

    /**
     * ドラムパッドの下ごしらえ(分離レンダリング)の進捗表示。
     * text を空/nullにすると消える。frac は 0〜1(不明なら省略)。
     * 呼び出し元は main.js setDrumRenderStatus(ドラム(DPCM)パネルの表示と対)。
     */
    setDpcmRenderStatus(text, frac) {
      const el = this._dpcmStatusEl;
      if (!el) return;
      if (!text) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.querySelector('.kbd-dpcm-status-text').textContent = text;
      const bar = el.querySelector('.kbd-dpcm-status-bar');
      const pct = (typeof frac === 'number' && frac > 0) ? Math.max(0, Math.min(1, frac)) : 0;
      bar.style.display = pct > 0 ? '' : 'none';
      bar.firstChild.style.width = (pct * 100).toFixed(1) + '%';
    }

    // note列クリックの小メニュー。「このサンプルは打楽器か音階か」の手動指定と、
    // 既存の基準音キャリブレーションをまとめて出す。
    // ★指定はサンプル単位(chではない)。プール式チップは同じ太鼓が毎回別スロットへ移るので、
    //   ch単位で持つと指定が飛ぶ。
    _openSampleMenu(anchorEl, ch) {
      this._closeSampleMenu();
      const menu = document.createElement('div');
      menu.className = 'kbd-sample-menu';
      const cur = ch.sampleKind || 'auto'; // 'auto'|'drum'|'pitch'(extractChannelsが載せる)
      const items = [
        ['auto', T('自動判定にまかせる')],
        ['drum', T('打楽器として扱う')],
        ['pitch', T('音階として扱う')],
      ];
      for (const [kind, label] of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'kbd-sample-menu-item' + (kind === cur ? ' kbd-sample-menu-item--on' : '');
        b.textContent = label;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this._closeSampleMenu();
          if (this.onSampleKind) this.onSampleKind(ch, kind === 'auto' ? null : kind);
        });
        menu.appendChild(b);
      }
      if (this.onAdpcmCalibrate) {
        const sep = document.createElement('div');
        sep.className = 'kbd-sample-menu-sep';
        menu.appendChild(sep);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'kbd-sample-menu-item';
        b.textContent = T('基準音を手動補正…');
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this._closeSampleMenu();
          this.onAdpcmCalibrate(ch);
        });
        menu.appendChild(b);
      }
      document.body.appendChild(menu);
      const r = anchorEl.getBoundingClientRect();
      menu.style.left = Math.round(Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = Math.round(Math.min(r.bottom + 2, window.innerHeight - menu.offsetHeight - 8)) + 'px';
      this._sampleMenuEl = menu;
      // 次のクリックで閉じる(メニュー内のクリックは上でstopPropagation済み)
      this._sampleMenuOutside = () => this._closeSampleMenu();
      setTimeout(() => document.addEventListener('click', this._sampleMenuOutside, { once: true }), 0);
    }

    _closeSampleMenu() {
      if (this._sampleMenuOutside) {
        document.removeEventListener('click', this._sampleMenuOutside);
        this._sampleMenuOutside = null;
      }
      if (this._sampleMenuEl && this._sampleMenuEl.parentNode) this._sampleMenuEl.parentNode.removeChild(this._sampleMenuEl);
      this._sampleMenuEl = null;
    }

    /** ドラム区画のレーン表(ドラム(DPCM)パネル用)。[{key,label,color,subN}] */
    getDrumLanes() { return (this._drumLanes || []).slice(); }
    /** ロールのタイムライン(音色一覧の目録 main.js rebuildToneInventory 用) */
    getRollTimeline() { return this._rollTimeline; }
    /** そのchに今効いている借用先(ユーザー指定 → 行の既定 → 割当計画の既定) */
    getEffectiveTarget(chId) {
      const plan = channelPlan();
      if (!plan) return 'skip';
      const ent = plan.get(chId) || {};
      return ent.target || this._defaultTargetOf(chId) || 'skip';
    }
    /** MMLのチャンネル文字(part列)から表示色を引く(楽譜ウィンドウのパート色用) */
    getChannelColorByLetter(letter) {
      const el = this._rowEls.find(e => e.letter === letter);
      return el ? el.color : null;
    }
    /** そのchの表示色(色の上書き込み) */
    getChannelColor(chId) {
      const el = this._rowEls.concat(this._spcRowEls).find(e => e.id === chId);
      return el ? el.color : null;
    }
    /** 割当UI(part列/セレクト/重複警告)の再描画を外から促す(音色ごとの指定の件数表示など) */
    refreshAssignUi() { this._refreshAssignUi(); }

    /**
     * ドラム区画のパッド名を差し替える。map は { drumKey → 表示名 }。
     * ★名前の実体は「サンプル内容のハッシュ」で持っている(src/convert/drumSamples.js)。
     *   ロールのノートはハッシュを持たない(Workerからの構造化複製で載せる情報を増やしたくない)ので、
     *   drumKey↔ハッシュの対応を知っている main.js 側から名前だけを流し込む形にしてある。
     */
    setDrumLaneNames(map) {
      this._drumLaneNames = map || {};
      if (!this._drumLanes || !this._drumLanes.length) return;
      for (const l of this._drumLanes) {
        if (l.key && this._drumLaneNames[l.key]) l.label = this._drumLaneNames[l.key];
        else if (l.key) l.label = l.autoLabel;
      }
      // 停止中でもその場で見た目を更新する(パッドの文字はロールと鍵盤の両方に出る)
      this._redrawRollForSpotlight();
      this._drawPianos(this._lastPianoChannels || this._lastChannels || []);
    }

    /** サンプルごとの打点数(ドラム(DPCM)パネルの「打点」列)。drumKey → 件数 */
    getDrumHitCounts() {
      const out = {};
      for (const track of (this._rollTimeline || [])) {
        for (const n of track.notes) if (n.drumKey) out[n.drumKey] = (out[n.drumKey] || 0) + 1;
      }
      return out;
    }

    _drumsForPiano() {
      if (!this._drumLanes || !this._drumLanes.length) return undefined;
      return { lanes: this._drumLanes, laneOf: this._drumLaneOf };
    }

    // 鍵盤canvasのクリック位置 → ドラム区画のレーン番号(区画の外なら-1)。
    // 座標系は drawPiano と同じ(音程軸は縦向き=x、横向き=下から上へのy)
    _drumLaneAtPoint(canvas, clientX, clientY) {
      const lanes = this._drumLanes || [];
      if (!lanes.length) return -1;
      const r = canvas.getBoundingClientRect();
      const vertical = this._layout.rollOrientation !== 'horizontal';
      const pitchLen = vertical ? r.width : r.height;
      const p = vertical ? (clientX - r.left) : (r.bottom - clientY);
      const wk = pitchLen / (TOTAL_WHITE + lanes.length * DRUM_LANE_WHITE);
      const lane = Math.floor(p / (DRUM_LANE_WHITE * wk));
      return (lane >= 0 && lane < lanes.length) ? lane : -1;
    }

    // 鍵盤canvasのクリック位置 → MIDIノート番号(鍵の上でなければ null)。
    // 幾何は直前の drawPiano が canvas._pianoGeom へ焼き付けたものを使う。
    // 黒鍵は白鍵の手前(ロール側)に乗っているので先に判定する。
    _noteAtPoint(canvas, clientX, clientY) {
      const g = canvas._pianoGeom;
      if (!g) return null;
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      // canvasの内部解像度は表示サイズに合わせてあるが、途中で変わる瞬間に備えて比率補正する
      const cx = (clientX - r.left) * (g.W / r.width);
      const cy = (clientY - r.top) * (g.H / r.height);
      // p: 音程軸(低音→高音)、q: 鍵の長さ方向(0=ロール側の端)
      const p = g.vertical ? cx : (g.H - cy);
      const q = g.vertical ? cy : (g.keyLen - cx);
      if (q < 0 || q > g.keyLen || p < 0 || p > g.pitchLen) return null;
      if (q <= g.bkH) {
        for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
          const rel = midi - MIDI_MIN;
          if (!IS_BLACK[rel % 12]) continue;
          const pos = keyX(midi, g.wkW);
          if (!pos) continue;
          const x = pos.x + g.pitchOff;
          if (p >= x - g.bkW / 2 && p <= x + g.bkW / 2) return midi;
        }
      }
      for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
        const rel = midi - MIDI_MIN;
        if (IS_BLACK[rel % 12]) continue;
        const pos = keyX(midi, g.wkW);
        if (!pos) continue;
        const x = pos.x + g.pitchOff;
        if (p >= x && p < x + g.wkW) return midi;
      }
      return null;
    }

    // 鍵盤canvasに演奏入力(押している間だけ鳴らす/ドラッグでグリッサンド)を取り付ける。
    // 実際に効くのは演奏入力モード中だけ。ドラム区画の上では null が返るのでパッド試聴と衝突しない
    _attachPerformInput(canvas) {
      if (!canvas || canvas._performWired) return;
      canvas._performWired = true;
      const PI = () => (MML.UI && MML.UI.PerformInput);
      let playing = null;   // 今このcanvasから鳴らしている音
      const release = (e) => {
        if (playing == null) return;
        const pi = PI();
        if (pi) pi.noteOff(playing, 'piano', e);
        playing = null;
      };
      canvas.addEventListener('pointerdown', (e) => {
        const pi = PI();
        if (!pi || !pi.isArmed()) return;
        const midi = this._noteAtPoint(canvas, e.clientX, e.clientY);
        if (midi == null) return;
        e.preventDefault();
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        release(e);
        playing = midi;
        pi.noteOn(midi, 'piano', e);
      });
      canvas.addEventListener('pointermove', (e) => {
        const pi = PI();
        if (!pi) return;
        if (playing == null) {
          if (pi.isArmed()) {
            canvas.style.cursor = (this._noteAtPoint(canvas, e.clientX, e.clientY) != null) ? 'pointer' : '';
          }
          return;
        }
        // 押したままなぞる = グリッサンド。同じ鍵の中では打ち直さない
        const midi = this._noteAtPoint(canvas, e.clientX, e.clientY);
        if (midi == null || midi === playing) return;
        pi.noteOff(playing, 'piano', e);
        playing = midi;
        pi.noteOn(midi, 'piano', e);
      });
      canvas.addEventListener('pointerup', release);
      canvas.addEventListener('pointercancel', release);
      canvas.addEventListener('pointerleave', release);
    }

    // 鍵盤canvasにパッド試聴のクリックを取り付ける(_buildRollPane / _rebuildLanes から)
    _attachDrumAudition(canvas) {
      if (!canvas || canvas._drumAuditionWired) return;
      canvas._drumAuditionWired = true;
      canvas.addEventListener('click', (e) => {
        const lane = this._drumLaneAtPoint(canvas, e.clientX, e.clientY);
        if (lane < 0 || !this.onDrumAudition) return;
        const info = this._drumLanes[lane];
        if (!info || !info.key || info.key === '*') return;
        this.onDrumAudition(info.key, this._drumAuditionMode);
      });
      canvas.addEventListener('mousemove', (e) => {
        const lane = this._drumLaneAtPoint(canvas, e.clientX, e.clientY);
        canvas.style.cursor = (lane >= 0 && this.onDrumAudition) ? 'pointer' : '';
      });
    }

    // ── 鍵盤側でパッドを光らせるための索引(2026-09-09) ──────────────────────
    // ロールの打点(drumKey付きノート)は「行ID → 時刻順の区間表」で持っておく。
    // 分離レンダリング由来のパッド(VGMのDAC/32X PWM、GBのノイズ等)やSPCのE指定ボイスは、
    // ライブのレジスタ抽出(extractChannels)からは drumKey が分からない(サンプル同定情報が
    // 無い)。そのため鍵盤表示は疑似音程(dmcRateIdx=15 → D#2)に落ちてしまい、ロールでは
    // パッドに出ているのに鍵盤だけ D#2 に貼り付く、という食い違いが起きていた。
    // 再生位置でこの表を引き、鳴っている打点の drumKey をライブの行へ被せて解消する。
    _buildDrumNoteIndex(tracks) {
      const idx = new Map();
      for (const track of tracks) {
        let list = null;
        for (const n of track.notes) {
          if (!n.drumKey) continue;
          (list || (list = [])).push(n);
        }
        if (!list) continue;
        list.sort((a, b) => a.startSec - b.startSec);
        idx.set(track.id, list);
      }
      this._drumNotesByTrack = idx;
    }

    /**
     * ライブのチャンネル配列へ「今この行が鳴らしている打点」の drumKey を被せる。
     * 既に drumKey を持つ行(実サンプルのアドレスが分かるチップ)はそのまま。
     * posSeconds はロールと同じ曲内の秒。
     */
    _applyPadKeys(channels, posSeconds) {
      const idx = this._drumNotesByTrack;
      if (!idx || !idx.size) return;
      const t = (this._rollLastDrawnPos != null ? this._rollLastDrawnPos : posSeconds) || 0;
      for (const ch of channels) {
        if (!ch || ch.drumKey) continue;
        // ★サンプルを自力で同定できる行(adpcmSampleを持つサンプルPCM系: MultiPCM/C352/
        //   QSound/C140/SegaPCM/GA20/OKIM6295/YM2610 ADPCM)は対象外。打楽器として鳴って
        //   いる間は extractChannels 側が既に drumKey を入れており、音階として鳴っている
        //   間は本物の音程を持っている。ここで「この行はパッドに載っている」を行単位で
        //   決めてしまうと、**プール割当チップ(同じ物理行が曲中で打楽器と音階楽器を
        //   行き来する)で音階側の鍵盤が一度も光らなくなる**(Daytona USAで発覚 2026-09-12。
        //   28行のうち1度でも打楽器を鳴らした行が全部padRow=音程鍵盤の点灯対象外になっていた)。
        if ('adpcmSample' in ch) continue;
        const list = idx.get(ch.id);
        if (!list) continue;
        // この行はパッドに載っている。打点が来ていない間もレートの疑似音程(D#2)へは
        // 落とさない(音程を持たない行なのでそこに意味は無く、ずっと貼り付いて見える)
        ch.padRow = true;
        // 打点は短い(数十ms)ので線形走査でよいが、曲が長いと件数が多い。
        // 開始秒でソート済みなので二分探索で「開始が t 以下の最後の打点」を取る
        let lo = 0, hi = list.length - 1, at = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid].startSec <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
        }
        // 同時発音(同じ行で区間が重なる)もあるので、少し手前まで遡って被っている物を探す
        for (let i = at; i >= 0 && i > at - 8; i--) {
          const n = list[i];
          if (n.endSec > t) { ch.drumKey = n.drumKey; ch.active = true; break; }
        }
      }
    }

    _rebuildDrumLanes() {
      this._drumLanes = [];
      this._drumLaneOf = new Map();
      this._drumNotesByTrack = null;
      const DrumMap = MML.Convert && MML.Convert.DrumMap;
      const tracks = this._rollTimeline || [];
      if (!DrumMap || !tracks.length) return;
      this._buildDrumNoteIndex(tracks);

      // 1) 曲全体の打点を集めてレーンを決める(vgm2mmlのドラム音符出力と同じ表)
      const obs = [];
      for (const track of tracks) {
        for (const n of track.notes) if (n.drumKey) obs.push({ key: n.drumKey, sec: n.startSec });
      }
      if (!obs.length) return;
      // 表示用は上限を広く取る(DISPLAY_MAX_LANES)。16はドラムパートを2A03ノイズへ焼くときの
      // ノート数制約で、ロールを縛る理由が無い。先頭16レーンの番号は変換側と一致する
      const map = DrumMap.build(obs, { maxLanes: DrumMap.DISPLAY_MAX_LANES });

      // 2) 各打点にレーン番号を書き戻し、レーンごとに集める
      const byLane = map.lanes.map(() => []);
      for (const track of tracks) {
        for (const n of track.notes) {
          if (!n.drumKey) continue;
          const lane = map.laneOf.has(n.drumKey) ? map.laneOf.get(n.drumKey) : map.otherLane;
          if (lane < 0 || lane >= byLane.length) { delete n.drumLane; continue; }
          n.drumLane = lane;
          byLane[lane].push(n);
        }
      }

      // 3) レーン内の同時発音をサブスロットへ振る(貪欲な区間彩色。開始時刻の昇順に、
      //    「まだ前の打点が終わっている」一番若いサブスロットへ入れる)。分割数は曲全体で
      //    決まるので、再生位置によって打点の幅が踊らない。
      const lanes = [];
      const labels = DrumMap.labels(map.lanes.map((l) => l.key));
      for (let i = 0; i < byLane.length; i++) {
        const notes = byLane[i];
        notes.sort((a, b) => a.startSec - b.startSec);
        const ends = [];
        for (const n of notes) {
          let s = 0;
          while (s < ends.length && ends[s] > n.startSec + 1e-9) s++;
          n.drumSub = s;
          ends[s] = n.endSec;
        }
        const subN = Math.max(1, ends.length);
        for (const n of notes) n.drumSubN = subN;
        const isOther = map.lanes[i].key === null;
        const auto = isOther ? T('他') : (labels[i] || '');
        const named = (!isOther && this._drumLaneNames) ? this._drumLaneNames[map.lanes[i].key] : null;
        lanes.push({
          key: map.lanes[i].key,
          autoLabel: auto,   // 名前を消したときに戻す既定ラベル(ROMアドレスの16進)
          label: named || auto,
          color: isOther ? DRUM_OTHER_COLOR : DRUM_LANE_COLORS[i % DRUM_LANE_COLORS.length],
          subN,
        });
      }
      this._drumLanes = lanes;
      this._drumLaneOf = map.laneOf;
    }

    // regSnapshots形式(NSFのライブ再生を裏で先読みキャプチャした結果など)からピアノロールの
    // タイムラインを構築して差し替える。setSource()と同じ抽出ロジックをそのまま再利用する。
    // n163Snapshots(省略可): capture.jsが毎フレーム採取したN163チップの生RAM(128byte)配列。
    // 渡された場合はwriteLog再生によるbuildN163Snapshots()の代わりにこちらを使う。
    // N163は$F800(アドレスラッチ)+$4800(データ)の間接アドレッシングで、実機ドライバは
    // 位相バイトを「$4800の空読み」で読み飛ばす(読み出しもオートインクリメントを進める)ため、
    // writeLogの書き込みだけを再生するbuildN163Snapshots()はアドレスポインタがズレて
    // 誤ったチャンネル/周波数/波形を復元してしまう(Rolling Thunder等で顕著、
    // [[n163-capture-snapshot-and-numch]]参照)。ライブRAMスナップショットなら常に正しい。
    setRollTimelineFromRegSnapshots(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots) {
      this._rollCursor = {};
      this._rollTimeline = this.buildRollTracksFromRegSnapshots(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots);
      this._rebuildDrumLanes();
      this._updateLaneRanges();
    }

    // setRollTimelineFromRegSnapshots()のトラック構築部分。VGM(main.js playVgmStream)のように
    // NES APU由来のトラックと他チップ(GB/HuC6280/AY/SCC/OPLL)由来のトラックを1本の
    // タイムラインへ連結したい呼び出し側のために、差し替えず配列を返す版を分離した。
    // extra(省略可): extraSnapsへ追加でマージする先読み配列({sn: [...]}等。VGMのSN76489ロール用)。
    buildRollTracksFromRegSnapshots(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots, extra) {
      // 実体はモジュールレベルの純粋関数(buildRollTracksFromRegSnapshotsPure)。
      // thisに依存しないため、キャプチャWorker(ロール構築のオフスレッド化、
      // src/audio/roll-builders.js)からも UI.buildRollTracksFromRegSnapshots 経由で
      // 同じコードを使えるよう分離した。
      return buildRollTracksFromRegSnapshotsPure(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots, extra);
    }

    // 新しいファイルを読み込んだ直後などに呼ぶ。前のファイルの発音色が鍵盤/ピアノロールに
    // 残ったまま次のファイルを読み込んだように見えてしまう問題(再生ボタンを押すまで
    // update()/updateSpcVoices()に新しいデータが渡らず、直前の描画がそのまま残る)を防ぐため、
    // 表示を無音状態に戻して即座に再描画する。
    // 新しいファイルを開いた時に呼ぶ(main.jsの各loadXxxFile()冒頭)。曲送り/トラック送り
    // (同一ファイル内での切替)ではミュート状態を保持したいため、ここでしかクリアしない。
    // _muteStateはチャンネルid('P1'等、フォーマット固有だがファイルをまたいで共通)をキーに
    // 永続化されており、以前は新しいファイルを開いてもクリアされなかった。結果、
    // 再生開始直後にgetChannelMuteConfig()が(_rebuildRows前の空/旧チャンネル一覧を反映した)
    // 「何もミュートされていない」設定を再生側へ渡してしまう一方、直後のロール/鍵盤再構築が
    // 古い_muteStateを見て該当chを再びミュート表示するため、表示は「ミュートのまま」なのに
    // 実際の再生は「全ch鳴る」という食い違いが起きていた。新規ファイルではミュートを
    // 引き継がない方針にして解消する。
    // *2MML変換の音程検証(src/convert/verify.js)で見つかった不一致箇所。ロールに赤枠で
    // 重ね描きする({sec,endSec,expectedMidi,gotMidi,letter}の配列)。次のファイル/変換で更新。
    setConversionDiffs(diffs) {
      this._conversionDiffs = (diffs && diffs.length) ? diffs : null;
    }

    reset() {
      this._spcVoices = [];
      this._conversionDiffs = null;
      this._prevSpcVoices = [];
      this._muteState.clear();
      // スポットライト(案D)の固定も新ファイルへは持ち越さない(ミュート状態と同じ扱い。
      // 前の曲にしか無いch.idが固定されたまま残ると、注目が効かない見た目になるため)
      this._spotlightPinnedId = null;
      this._spotlightHoverId = null;
      // 大波形の選択(_selectedId)はここでは変えない。新ファイルの実際のチャンネル構成が
      // 判明した時点(次のsetSource()/updateSpcVoices()の実データ呼び出し)で、同じchが
      // 新ファイルにもあれば維持、無ければ一番若いchへ切り替える判定を1回だけ行う
      // (_pendingSelectionResetフラグ、_consumePendingSelectionReset参照)。曲送り/停止→再生
      // (同一ファイル内での切替)ではこのフラグは立てないため選択はそのまま保たれる。
      // ここより前に消費されていない古いフラグが残っていたら(短時間に連続でファイルを
      // 読み込み直した場合)、直後のダミーsetSource()呼び出しがその場で誤って消費してしまう
      // 前に破棄しておく。
      this._pendingSelectionReset = false;
      this.setSource({ regSnapshots: [{}], totalFrames: 1, samplesPerFrame: 735, sampleRate: 44100, writeLog: [] }, []);
      this._pendingSelectionReset = true;
      this.update(0);
    }

    /** いま見えている一覧の枠。SPC再生中はボイス一覧(_spcSectionEl)が本体で _rowsEl は非表示 */
    _activeRowsEl() { return this._mode === 'spc' ? this._spcSectionEl : this._rowsEl; }
    /** 一覧の高さ(スプリッターで決めた値)を、見えている方だけに適用する */
    _applyRowsHeight() {
      const on = this._activeRowsEl();
      const off = (on === this._rowsEl) ? this._spcSectionEl : this._rowsEl;
      if (off) { off.style.flex = ''; off.style.height = ''; }
      if (!on) return;
      // 大波形が右にあるときは縦の取り合いが無いので高さ指定は捨てる(従来どおり)
      if (this._bigWaveBelow() && this._listRowsHeight) { on.style.flex = 'none'; on.style.height = this._listRowsHeight + 'px'; }
      else { on.style.flex = ''; on.style.height = ''; }
    }

    // 表示モード切替: NSF/MMLチャンネル一覧 と SPCボイス一覧 は同時表示せず、
    // 再生中のファイル種別に応じて排他的に切り替える。
    setMode(mode) {
      if (this._mode === mode) return;
      this._mode = mode;
      const spc = mode === 'spc';
      this._headerEl.style.display = spc ? 'none' : '';
      this._rowsEl.style.display = spc ? 'none' : '';
      this._spcHeaderEl.style.display = spc ? '' : 'none';
      this._spcSectionEl.style.display = spc ? '' : 'none';
      // SPCはNSFより列が多い(L/R/env/PM/echo)ぶん一覧の幅を少し広げる(.kbd-left--spc)。
      // レイアウト(ロールの置き場/大波形の置き場)はNSF等と共通のまま(以前はSPC専用の
      // 1000px幅テーブル+大波形の重ね配置だったが、マスター値を1行にまとめて廃止した)
      this._leftEl.classList.toggle('kbd-left--spc', spc);
      this._applyRowsHeight();    // 一覧の高さ指定を、切り替えた先の枠へ移す
      this._applyLayoutClasses(); // 右配置の一覧幅(SPCは下限あり)を反映
      // 大波形に表示するchを表示中の一覧に合わせる(選択chが無ければ一番若いch/V0を一時表示)
      this._syncShownWave(spc ? this._spcRowEls : this._rowEls);
      this._rebuildLanes(); // チャンネルごとのレーン表示も表示中の一覧に合わせる
      this._refreshAssignUi(); // 借用先の重複判定は「表示中の一覧」が対象なので切替のたびに計算し直す
      this._renderMuteAllBtn(); // 一括ミュートの状態も表示中の一覧が対象

      // ウィンドウが狭くて一覧の全列が収まらない場合だけ、収まる幅まで自動拡張する
      // (縮小はしない。ユーザーが既に手動でそれ以上広げていればそのまま尊重する)
      if (spc) {
        const winEl = this.container.closest('.float-window');
        if (winEl && this._effectivePlacement() !== 'window') {
          const minW = this._effectivePlacement() === 'bottom' && this._layout.listColumns === 'single' ? 720 : 560;
          if (winEl.offsetWidth < minW) winEl.style.width = minW + 'px';
        }
      }
    }

    // 上書き色があればそれを、無ければ既定色をそのまま返す
    _getColor(id, defaultColor) {
      const ov = this._colorOverrides.get(id);
      return ov || defaultColor;
    }

    // kbd-dot に色ピッカーを割り当てる。defaultColor は「既定色に戻す」用に
    // そのチャンネルの本来の色(上書き適用前)を保持しておく必要がある。
    _attachColorPicker(dotEl, id, defaultColor) {
      dotEl.addEventListener('click', (e) => {
        e.stopPropagation();
        UI.ColorPicker.open(
          dotEl,
          this._getColor(id, defaultColor),
          (color) => this._setColorOverride(id, color),
          () => this._setColorOverride(id, null),
        );
      });
    }

    // 色の変更を反映: 上書きマップ更新→永続化→表示中の行/大波形/次フレームの
    // ロール・鍵盤描画すべてに反映されるようにする。
    _setColorOverride(id, color) {
      if (color) this._colorOverrides.set(id, color);
      else this._colorOverrides.delete(id);
      saveColorOverrides(this._colorOverrides);

      for (const el of this._rowEls.concat(this._spcRowEls)) {
        if (el.id !== id) continue;
        const newColor = this._getColor(id, el.defaultColor || el.color);
        el.color = newColor;
        const dot = el.row.querySelector('.kbd-dot');
        if (dot) dot.style.background = newColor;
      }

      if (this._shownWaveId === id) {
        this._bigWaveSig = ''; // 色はwave形状に含まれないため強制再描画
        const sel = (this._prevChannels || []).concat(this._prevSpcVoices || [])
          .find((c) => c.id === id);
        if (sel) this._renderBigWave(sel);
      }
    }

    // ── チャンネル割当(案E: 鍵盤表示の行で借用先を決める) ────────────────
    // part列の文字とセレクトのラベル(「P: N163 ch1」)は channelPlan.js 側が持つ固定レター表
    // (assignExpansionLettersは他チップの有無に関わらず同じ文字を返す)から引くので、
    // ここで曲ごとのletterMapを作る必要はない。

    // 1行ぶんのpart列チップと「借用先/音色」セレクトを配線する。セレクトは割当表示ON
    // (_assignMode)のときだけ見えるが、DOMは常に作っておく(トグルのたびに行を組み直すと
    // 再生中の描画が途切れるため)。
    _wireAssign(row, ch) {
      const plan = channelPlan();
      if (!plan) return;
      const chId = ch.id;
      const editable = assignEditable();
      const partEl = row.querySelector('.kbd-part');
      const targetSel = row.querySelector('.kbd-assign-target');
      const toneSel = row.querySelector('.kbd-assign-tone');
      if (partEl) {
        if (editable) {
          partEl.title = T('クリックで借用先(NSF側のパート)を選ぶ');
          partEl.addEventListener('click', (e) => { e.stopPropagation(); this._openAssignPopover(partEl, chId); });
        } else {
          partEl.title = assignLockReason();
        }
      }
      if (!targetSel || !toneSel) return;
      targetSel.disabled = toneSel.disabled = !editable;
      if (!editable) targetSel.title = assignLockReason();
      targetSel.addEventListener('change', () => this._setAssignTarget(chId, targetSel.value));
      toneSel.addEventListener('change', () => {
        // 「音色ごとに指定…」: 値ではなく音色一覧(src/ui/tonePanel.js)をこのchで開く操作
        if (toneSel.value === plan.TONE_PER_INSTRUMENT) {
          const el = this._rowEls.concat(this._spcRowEls).find(e => e.id === chId);
          if (el) this._syncAssignSelects(el);
          if (this.onOpenTonePanel) this.onOpenTonePanel(chId);
          return;
        }
        const cur = plan.get(chId) || {};
        const kind = plan.toneKindFor(cur.target || this._defaultTargetOf(chId), undefined, plan.channelKind(chId));
        const def = kind ? plan.toneOptionsFor(kind, plan.channelKind(chId)).def : null;
        plan.set(chId, { tone: toneSel.value === def ? null : toneSel.value });
      });
      // クリックが行の他の操作(大波形選択・色ピッカー)に伝播しないようにする
      for (const el of [targetSel, toneSel]) el.addEventListener('click', (e) => e.stopPropagation());
      const drumBtn = row.querySelector('.kbd-assign-drum');
      if (drumBtn) drumBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.onOpenDrumPanel) this.onOpenDrumPanel();
      });
      // 音色の選択肢が無い借用先(三角波/FME-7/のこぎり波等)でも音色ごとの載せ先は指定できるので、
      // 音色セレクトが隠れるときはこのボタンで音色一覧を開く
      const tonesBtn = row.querySelector('.kbd-assign-tones');
      if (tonesBtn) tonesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.onOpenTonePanel) this.onOpenTonePanel(chId);
      });
    }

    // この曲に実在する借用先(表示中の各行の既定の借用先)。NSFのように「同じ音源の
    // 別チャンネルへ移す」しかできない形式で、存在しない枠を候補に出さないために使う。
    _availTargets() {
      const rows = this._mode === 'spc' ? this._spcRowEls : this._rowEls;
      return rows.map(el => el.defaultTarget).filter(Boolean);
    }

    _defaultTargetOf(chId) {
      const plan = channelPlan();
      if (!plan) return 'skip';
      const el = this._rowEls.concat(this._spcRowEls).find(e => e.id === chId);
      return (el && el.defaultTarget) || plan.defaultTarget(chId, 'skip');
    }

    // 借用先を選び直す。既定と同じ値を選んだらユーザー指定を消して「自動」に戻す。
    // 借用先が他のchと重なったときの扱いは全形式「赤い重複警告を出すだけ」に統一(2026-09-09、
    // ユーザー指示)。以前はNSF側の行(_rowEls)だけ「先に居たchを自動でスキップへ落とす」ラジオ動作で、
    // SPCの行(_spcRowEls)は警告だけ、と形式で挙動が違っていた。自動解除は選んだ側の意図を
    // 越えて他の行を書き換えてしまうので、どちらを鳴らすかはユーザーが赤い行を見て決める。
    // 変換器側は従来どおり先着優先(後のchは「変換対象外」の注記)。
    _setAssignTarget(chId, value) {
      const plan = channelPlan();
      if (!plan) return;
      const def = this._defaultTargetOf(chId);
      plan.set(chId, { target: value === def ? null : value, tone: null });
    }

    // セレクトの中身を現在の割当に合わせて作り直す(借用先を変えると音色の選択肢も変わる)
    _syncAssignSelects(el) {
      const plan = channelPlan();
      if (!plan || !el.targetSel) return;
      const srcKind = plan.channelKind(el.id);
      const ent = plan.get(el.id) || {};
      const target = ent.target || el.defaultTarget || 'skip';
      const opts = plan.targetsForChannel(el.id, el.defaultTarget, this._availTargets());
      // 既定の借用先が候補に無い(種別判定と既定がずれている)場合も選べるように足す
      const list = opts.indexOf(target) >= 0 ? opts : opts.concat([target]);
      const sig = list.join(',') + '|' + target;
      if (el.targetSig !== sig) {
        el.targetSig = sig;
        el.targetSel.innerHTML = '';
        for (const t of list) {
          const o = document.createElement('option');
          o.value = t;
          // 行内のセレクトは幅が狭いので「(既定)」は付けない(既定から変えた行はpart列の
          // チップがアクセント色になるので区別はつく)。ポップオーバー側には付ける。
          // サンプルPCMでない行の E(DPCM) は「このchを打楽器として分離レンダリングしてDPCM化」
          // (main.js synthDrum)なので、そう読める語を添える
          o.textContent = plan.targetLabel(t) + ((t === 'dpcm' && plan.isSynthDrumTarget && plan.isSynthDrumTarget(el.id, t)) ? T('(打楽器化)') : '');
          // 音源ごとの色分けは「選ぶとき(=リストを開いたとき)」だけ、薄い背景色で出す。
          // ★文字色は塗らない(読みづらいというユーザー指摘)。行に閉じているセレクト本体も
          //   既定の見た目のままにして、色は候補一覧の中でのグルーピングだけに使う。
          const c = plan.colorOfTarget ? plan.colorOfTarget(t) : '';
          if (c) o.style.backgroundColor = tintOf(c);
          el.targetSel.appendChild(o);
        }
      }
      el.targetSel.value = target;
      // 以前は借用先の色をセレクト本文とpart列の文字色に塗っていた。もう塗らないので、
      // 行を作り直さずに切り替わったときのために明示的に消しておく
      el.targetSel.style.color = '';
      if (el.partEl) el.partEl.style.color = '';

      if (el.drumBtn) el.drumBtn.style.display = (target === 'dpcm') ? '' : 'none';
      const toneKind = plan.toneKindFor(target, undefined, srcKind);
      // 音色ごとの指定(src/convert/toneSettings.js)を持つ音色の数。セレクト/ボタンの表示に添える
      const nTone = this.toneOverrideCount ? this.toneOverrideCount(el.id) : 0;
      const perToneLabel = T('音色ごとに指定…') + (nTone ? ` (${nTone})` : '');
      // ★♪ボタンは「音色ごとの指定が使える行」には常に出す(2026-09-10)。以前は音色セレクトが
      //   隠れる行だけだったので、音色一覧で指定してもチャンネル一覧の見た目が変わらなかった
      //   (件数がセレクトの最終項目にしか出ず、開かないと見えない。ユーザー報告)
      const perOk = plan.editable() && target !== 'skip' && target !== 'dpcm' && plan.format() !== 'nsf';
      if (el.tonesBtn) {
        el.tonesBtn.style.display = perOk ? '' : 'none';
        el.tonesBtn.textContent = nTone ? `♪${nTone}` : '♪';
        el.tonesBtn.title = perToneLabel;
        el.tonesBtn.classList.toggle('kbd-assign-tones--custom', nTone > 0);
      }
      // 音色が1つしかない借用先は選ぶものが無い。音源そのままで鳴ることを明示する
      if (el.plainEl) {
        const showPlain = !toneKind && target !== 'skip' && target !== 'dpcm';
        el.plainEl.style.display = showPlain ? '' : 'none';
        if (showPlain) {
          el.plainEl.textContent = T('音源そのまま');
          el.plainEl.title = T('{t} は音色が1つだけなので、音源の音色そのままで鳴ります', { t: plan.targetLabel(target) });
        }
      }
      if (!toneKind) { el.toneSel.style.display = 'none'; el.toneSig = ''; return; }
      el.toneSel.style.display = '';
      const to = plan.toneOptionsFor(toneKind, srcKind);
      const tsig = toneKind + '|' + srcKind;
      if (el.toneSig !== tsig) {
        el.toneSig = tsig;
        el.toneSel.innerHTML = '';
        for (const pair of to.opts) {
          const o = document.createElement('option');
          o.value = pair[0]; o.textContent = pair[1];
          el.toneSel.appendChild(o);
        }
        // 末尾に「音色ごとに指定…」(選ぶと音色一覧が開く。値としては保存しない。NSFは対象外)
        if (plan.format() !== 'nsf') {
          const o = document.createElement('option');
          o.value = plan.TONE_PER_INSTRUMENT; o.className = 'kbd-assign-tone-per';
          el.toneSel.appendChild(o);
          el.perToneOpt = o;
        } else el.perToneOpt = null;
      }
      if (el.perToneOpt) el.perToneOpt.textContent = perToneLabel;
      el.toneSel.classList.toggle('kbd-assign-tone--per', nTone > 0);
      el.toneSel.title = nTone ? T('この行の音色 {n} 件に音色ごとの指定があります(音色一覧で変更)', { n: nTone }) : '';
      el.toneSel.value = ent.tone !== undefined ? ent.tone : to.def;
    }

    // 割当が変わったとき(plan.onChange)に呼ぶ。part列の文字・スキップの減光・
    // 借用先の重複(赤)を表示中の全行へ反映する。
    _refreshAssignUi() {
      const plan = channelPlan();
      if (!plan) return;
      // ★対象は「今表示中の一覧」だけ。両方(_rowEls+_spcRowEls)を混ぜると、SPC表示中に
      //   隠れているNSF側の行(A/B/C/D…)まで数えてしまい、全行が重複警告になる
      const rows = (this._mode === 'spc' ? this._spcRowEls : this._rowEls)
        .filter(el => !el.isAllRow && el.partEl);
      const count = {};
      for (const el of rows) {
        const ent = plan.get(el.id) || {};
        el.target = ent.target || el.defaultTarget || 'skip';
        if (el.target !== 'skip') count[el.target] = (count[el.target] || 0) + 1;
      }
      // スキップの減光と重複警告は「割当が意味を持つ形式」だけに出す。NSFのようにMMLパート文字を
      // 持たない行(MMC5の$5011直接PCM等)まで一律に減光すると、従来の見た目を壊してしまう
      const editable = plan.editable();
      for (const el of rows) {
        const custom = !!(plan.get(el.id) || {}).target;
        el.letter = el.target === 'skip' ? '' : plan.letterOfTarget(el.target);
        el.partEl.textContent = el.letter || (editable ? '—' : '');
        el.partEl.classList.toggle('kbd-part--custom', custom);
        // スキップ行の減光は「割当表示ON(=借用先を編集している最中)」の間だけ。割当表示を
        // 切ったら、割当が無い行も普通の明るさに戻す(減光したままだと、ただ曲を聴いている間も
        // 半分の行が沈んで見える。ユーザー指示 2026-09-12)
        el.row.classList.toggle('kbd-ch-row--skip', this._assignMode && editable && el.target === 'skip');
        // DPCMは複数chをまとめて載せる先なので重複扱いにしない(上の MULTI_SOURCE_TARGETS 参照)
        const dup = editable && el.target !== 'skip' && !MULTI_SOURCE_TARGETS.has(el.target) && count[el.target] > 1;
        el.row.classList.toggle('kbd-ch-row--conflict', dup);
        if (el.partEl) {
          el.partEl.title = dup ? T('この借用先は他のチャンネルと重複しています')
            : plan.editable() ? T('クリックで借用先(NSF側のパート)を選ぶ') : (plan.lockReason() || '');
        }
        this._syncAssignSelects(el);
      }
      this._renderAssignToggle();
      this._renderPreviewToggle();
      this._notifyPreview();
    }

    // part列チップのクリックで開く1行ぶんの割当ポップオーバー(縦置き・多段・別窓など
    // 幅が足りないレイアウトでも必ず使える経路。案Eの土台)
    _openAssignPopover(anchorEl, chId) {
      const plan = channelPlan();
      if (!plan || !plan.editable()) return;
      this._closeAssignPopover();
      const el = this._rowEls.concat(this._spcRowEls).find(e => e.id === chId);
      if (!el) return;
      const pop = document.createElement('div');
      pop.className = 'kbd-assign-pop';
      const srcKind = plan.channelKind(chId);
      const ent = plan.get(chId) || {};
      const target = ent.target || el.defaultTarget || 'skip';

      const rowOf = (labelText, control) => {
        const r = document.createElement('label');
        r.className = 'kbd-assign-pop-row';
        const s = document.createElement('span');
        s.textContent = labelText;
        r.appendChild(s); r.appendChild(control);
        return r;
      };
      const targetSel = document.createElement('select');
      const list = plan.targetsForChannel(chId, el.defaultTarget, this._availTargets());
      for (const t of (list.indexOf(target) >= 0 ? list : list.concat([target]))) {
        const o = document.createElement('option');
        o.value = t;
        o.textContent = plan.targetLabel(t)
          + ((t === 'dpcm' && plan.isSynthDrumTarget && plan.isSynthDrumTarget(chId, t)) ? T('(打楽器化)') : '')
          + (t === el.defaultTarget ? T('(既定)') : '');
        targetSel.appendChild(o);
      }
      targetSel.value = target;
      targetSel.addEventListener('change', () => { this._setAssignTarget(chId, targetSel.value); this._openAssignPopover(anchorEl, chId); });
      pop.appendChild(rowOf(T('借用先'), targetSel));

      const toneKind = plan.toneKindFor(target, undefined, srcKind);
      if (toneKind) {
        const to = plan.toneOptionsFor(toneKind, srcKind);
        const toneSel = document.createElement('select');
        for (const pair of to.opts) {
          const o = document.createElement('option');
          o.value = pair[0]; o.textContent = pair[1];
          toneSel.appendChild(o);
        }
        toneSel.value = ent.tone !== undefined ? ent.tone : to.def;
        toneSel.addEventListener('change', () => plan.set(chId, { tone: toneSel.value === to.def ? null : toneSel.value }));
        pop.appendChild(rowOf(T('音色'), toneSel));
      }
      // 音色ごとの指定(音色一覧パネル)。NSFはネイティブ変換なので対象外
      if (plan.format() !== 'nsf' && target !== 'skip' && target !== 'dpcm') {
        const nTone = this.toneOverrideCount ? this.toneOverrideCount(chId) : 0;
        const tonesBtn = document.createElement('button');
        tonesBtn.type = 'button';
        tonesBtn.className = 'kbd-assign-pop-tones';
        tonesBtn.textContent = T('音色ごとに指定…') + (nTone ? ` (${nTone})` : '');
        tonesBtn.title = T('このchで使われている音色ごとに、載せ先と音色を指定する(音色一覧を開く)');
        tonesBtn.addEventListener('click', () => { this._closeAssignPopover(); if (this.onOpenTonePanel) this.onOpenTonePanel(chId); });
        pop.appendChild(rowOf(T('音色別'), tonesBtn));
      }
      if (plan.hasVolSliderFor(target)) {
        const volWrap = document.createElement('span');
        volWrap.className = 'kbd-assign-pop-vol';
        const vol = document.createElement('input');
        vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.step = '5';
        vol.value = String(ent.volPct !== undefined ? ent.volPct : 100);
        const volNum = document.createElement('span');
        volNum.textContent = vol.value + '%';
        vol.addEventListener('input', () => { volNum.textContent = vol.value + '%'; });
        vol.addEventListener('change', () => plan.set(chId, { volPct: vol.value === '100' ? null : parseInt(vol.value, 10) }));
        volWrap.appendChild(vol); volWrap.appendChild(volNum);
        pop.appendChild(rowOf(T('変換音量'), volWrap));
      }
      const foot = document.createElement('div');
      foot.className = 'kbd-assign-pop-foot';
      const pvLabel = document.createElement('label');
      pvLabel.className = 'kbd-assign-pop-preview';
      pvLabel.title = T('割当先の音で聴く(元chをミュートし、借用先のNSF音源で鳴らす。スキップは無音、DPCMは元のまま)');
      const pvChk = document.createElement('input');
      pvChk.type = 'checkbox'; pvChk.checked = this._previewMode;
      pvChk.addEventListener('change', () => this._setPreviewMode(pvChk.checked));
      pvLabel.appendChild(pvChk); pvLabel.appendChild(document.createTextNode('\u{1F3A7} ' + T('割当先の音で聴く')));
      foot.appendChild(pvLabel);
      const auto = document.createElement('button');
      auto.type = 'button';
      auto.textContent = T('自動に戻す');
      auto.addEventListener('click', () => { plan.clearChannel(chId); this._closeAssignPopover(); });
      foot.appendChild(auto);
      pop.appendChild(foot);

      document.body.appendChild(pop);
      const r = anchorEl.getBoundingClientRect();
      pop.style.left = Math.max(4, Math.min(window.innerWidth - pop.offsetWidth - 4, r.left)) + 'px';
      pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 4, r.bottom + 2) + 'px';
      this._assignPop = pop;
      this._assignPopClose = (e) => { if (!pop.contains(e.target) && e.target !== anchorEl) this._closeAssignPopover(); };
      setTimeout(() => document.addEventListener('mousedown', this._assignPopClose), 0);
    }

    _closeAssignPopover() {
      if (this._assignPopClose) document.removeEventListener('mousedown', this._assignPopClose);
      this._assignPopClose = null;
      if (this._assignPop) { this._assignPop.remove(); this._assignPop = null; }
    }

    // 一覧の「割当」トグル(幅が足りるときだけ列展開する。案Eの2段目)
    _setAssignMode(on) {
      this._assignMode = !!on;
      try { localStorage.setItem('mml_kbdAssignMode', on ? '1' : '0'); } catch (e) { /* private browsing等 */ }
      this._leftEl.classList.toggle('kbd-left--assign', this._assignMode && !sourceIsMml);
      this._applyLayoutClasses();
      this._refreshAssignUi();
      // 「借用先/音色」列(200px)が入りきらない幅のままだと右側の列(L/R・vol・wave)が
      // 押し出されて見えなくなるので、収まる幅まで自動拡張する(setMode()のSPC下限と同じ考え方。
      // 縮小はしない=ユーザーが既に広げていればそのまま尊重する)
      if (this._assignMode) {
        const winEl = this.container.closest('.float-window');
        const placement = this._effectivePlacement();
        if (winEl && placement !== 'window') {
          // 一覧の幅(CSSの.kbd-left--assignで広がった値)+ロールの最低限が収まる窓幅を確保する
          const need = this._leftEl.offsetWidth + (placement === 'right' ? 260 : 24);
          if (winEl.offsetWidth < need) winEl.style.width = need + 'px';
        }
      }
    }

    // ── 割当プレビュー(「割当先の音で聴く」、src/audio/assign-preview.js) ────────────
    // ONの間、割当を持つ行は元chをミュートして借用先のNSF音源で鳴らす。スキップ行は無音、
    // E(DPCM)行と割当対象外の行(リズム等)は元の音のまま。再生側の実体は main.js が持ち、
    // ここは「何を・どの音色で」(getPreviewPlan)と「今の元chの状態」(getLiveChannels)を渡すだけ。
    _setPreviewMode(on) {
      this._previewMode = !!on;
      this._renderPreviewToggle();
      this._notifyPreview();
    }
    isPreviewMode() { return !!this._previewMode; }
    _notifyPreview() { if (this.onPreviewChange) this.onPreviewChange(); }
    _renderPreviewToggle() {
      if (!this._previewBtns) return;
      const editable = assignEditable();
      for (const btn of this._previewBtns) {
        btn.classList.toggle('kbd-preview-btn--on', !!this._previewMode);
        btn.disabled = !editable;
        btn.title = editable ? T('割当先の音で聴く(元chをミュートし、借用先のNSF音源で鳴らす。スキップは無音、DPCMは元のまま)') : assignLockReason();
      }
    }
    // 表示中の一覧の行ごとの割当(プレビュー用)。tone は選択が無ければ借用先ごとの既定値
    getPreviewPlan() {
      const plan = channelPlan();
      if (!assignEditable()) return [];
      const rows = (this._mode === 'spc' ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow && el.partEl && el.checkbox);
      const out = [];
      for (const el of rows) {
        if (plan.isUnassignable && plan.isUnassignable(el.id)) continue;
        const ent = plan.get(el.id) || {};
        const target = ent.target || el.defaultTarget || 'skip';
        const kind = plan.channelKind(el.id);
        const toneKind = plan.toneKindFor(target, undefined, kind);
        const tone = ent.tone !== undefined ? ent.tone : (toneKind ? plan.toneOptionsFor(toneKind, kind).def : null);
        out.push({ id: el.id, target, tone, kind, muted: !el.checkbox.checked });
      }
      return out;
    }
    // プレビュー中に元chをミュートする行か(getMuteConfig/previewSpcMuteMaskが使う)
    _previewMutesRow(el) {
      if (!this._previewMode || el.isAllRow || !el.partEl) return false;
      const plan = channelPlan();
      if (!assignEditable()) return false;   // MML表示中は元chを消さない
      if (plan.isUnassignable && plan.isUnassignable(el.id)) return false;
      const target = (plan.get(el.id) || {}).target || el.defaultTarget || 'skip';
      return target !== 'dpcm';
    }
    // SPC: プレビューで消す元ボイスのビットマスク(main.js effectiveSpcMute が spcMutedVoices とORする)
    previewSpcMuteMask() {
      let mask = 0;
      this._spcRowEls.forEach((el, idx) => { if (this._previewMutesRow(el)) mask |= (1 << idx); });
      return mask;
    }
    // 「今の元chの状態」を extractChannels() と同じ形で返す(再生側の onaudioprocess から毎フレーム呼ばれる)。
    // ライブ追跡のフォーマット(regSnapshots=[liveSnap]+Live関数)ではフレーム番号に関わらず現在値、
    // 全フレーム分のスナップショットがある場合はそのフレームの値。SPCはmain.jsのライブ関数へ委譲
    getLiveChannels(frameIdx) {
      if (this._mode === 'spc') return this.spcLiveRows ? this.spcLiveRows() : null;
      if (!this._state) return null;
      const snaps = this._state.regSnapshots || [];
      const live = snaps.length <= 1;
      const fi = live ? 0 : Math.max(0, Math.min(snaps.length - 1, frameIdx | 0));
      return extractChannels(snaps[fi] || {}, this._extraSnaps, fi, this._chips);
    }

    _renderAssignToggle() {
      const plan = channelPlan();
      if (!this._assignBtns) return;
      const editable = assignEditable();
      for (const btn of this._assignBtns) {
        btn.classList.toggle('kbd-assign-btn--on', !!this._assignMode);
        btn.classList.toggle('kbd-assign-btn--custom', !!plan && plan.isCustom());
        btn.disabled = !editable;
        btn.title = editable ? T('チャンネル割当(変換元ch → NSF側のパート)を表示') : assignLockReason();
      }
    }

    // ── 一括ミュート(見出しのミュート列のボタン) ──────────────────────
    // 表示中の一覧(SPCモードならボイス一覧)の実チャンネルだけを対象にする。
    // 全chミュートでなければ全ミュート、全ミュート済みなら全解除。
    _muteRows() {
      return (this._mode === 'spc' ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow && el.checkbox);
    }
    _allMuted() {
      const rows = this._muteRows();
      return rows.length > 0 && rows.every(el => !el.checkbox.checked);
    }
    _toggleAllMute() {
      const rows = this._muteRows();
      if (!rows.length) return;
      const muted = !this._allMuted(); // 全ミュートでなければ全ミュート、そうなら全解除
      if (this._mode === 'spc') {
        // SPCはボイス番号でミュート機構が別(main.js onSpcMuteChange → ビットマスク)
        rows.forEach((el, idx) => {
          el.checkbox.checked = !muted;
          if (this.onSpcMuteChange) this.onSpcMuteChange(idx, muted);
        });
      } else {
        for (const el of rows) {
          el.checkbox.checked = !muted;
          this._muteState.set(el.id, muted);
        }
        // 行ごとに呼ぶとその都度再生側へ設定が飛ぶので、まとめて1回だけ通知する
        if (this.onMuteChange) this.onMuteChange(this.getMuteConfig());
      }
      this._renderMuteAllBtn();
      this._notifyPreview();
    }
    // 見出しの vol 列のボタン: 全chの音量スライダーを100%へ戻す(行ごとのダブルクリックの
    // 全ch版)。ミュートと違いトグルではなく常にリセット。
    _resetAllVolumes() {
      const spc = this._mode === 'spc';
      const rows = (spc ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow);
      if (!rows.length) return;
      for (const el of rows) {
        const slider = el.row.querySelector('.kbd-vol-slider');
        if (slider) slider.value = '100';
      }
      if (spc) {
        for (let i = 0; i < this._spcVoiceVolumes.length; i++) this._spcVoiceVolumes[i] = 1;
        saveSpcVoiceVolumes(this._spcVoiceVolumes);
        if (this.onSpcVolumeChange) this.onSpcVolumeChange(this._spcVoiceVolumes.slice());
      } else {
        for (const el of rows) this._channelVolumes.set(el.id, 1);
        saveChannelVolumes(this._channelVolumes);
        if (this.onVolumeChange) this.onVolumeChange();
      }
    }

    // ボタンの見た目: 全ミュート中は押し込み表示にして「もう一度押すと解除」だと分かるようにする
    _renderMuteAllBtn() {
      if (!this._muteAllBtns) return;
      const all = this._allMuted();
      for (const btn of this._muteAllBtns) {
        btn.classList.toggle('kbd-muteall-btn--on', all);
        btn.title = all ? T('全チャンネルのミュートを解除') : T('全チャンネルをミュート');
      }
    }

    // 音源(チップ)単位でch一覧を開閉する。見出しクリックから呼ばれ、状態はlocalStorageへ。
    // ch行を隠すだけで、ミュート・音量・ピアノロールのレーンには一切触れない
    // (「見えていないチャンネルが勝手に黙る」を避けるため)。
    _toggleChipCollapse(chip) {
      if (!chip) return;
      if (this._chipCollapsed.has(chip)) this._chipCollapsed.delete(chip);
      else this._chipCollapsed.add(chip);
      try {
        localStorage.setItem('mml_kbdChipCollapsed', JSON.stringify([...this._chipCollapsed]));
      } catch (e) { /* ignore */ }
      this._applyChipCollapse();
    }

    // 折りたたみ状態を現在の行へ反映する(行の再構築後と開閉のたび)。畳んだ音源の見出しには
    // 隠れているch数を出し、行の更新はupdate()側で丸ごと省く(el.collapsed)
    _applyChipCollapse() {
      const groups = this._rowsInnerEl.querySelectorAll('.kbd-chip-group');
      for (const group of groups) {
        const chip = group.dataset.chip || '';
        const collapsed = !!chip && this._chipCollapsed.has(chip);
        group.classList.toggle('kbd-chip-group--collapsed', collapsed);
        const tog = group.querySelector('.kbd-chip-toggle');
        if (tog) tog.textContent = collapsed ? '▶' : '▼';
        const count = group.querySelector('.kbd-chip-count');
        if (count) count.textContent = T('({n}ch)', { n: group.querySelectorAll('.kbd-ch-row').length });
      }
      for (const el of this._rowEls) {
        const collapsed = !!el.chip && this._chipCollapsed.has(el.chip);
        // 畳んでいる間は更新を止めているので、開いた行は次のupdate()で必ず描き直させる
        if (el.collapsed && !collapsed) el.waveSig = '';
        el.collapsed = collapsed;
      }
    }

    _rebuildRows(channels) {
      this._rowsInnerEl.innerHTML = '';
      this._rowEls = [];
      let lastHeader = null;
      // チップごとに .kbd-chip-group で括る(多段表示のとき同じチップの行が列をまたいで
      // 千切れないようにするため。1列表示では見た目に影響しない)
      let group = null;
      for (const ch of channels) {
        const mi = getMuteInfo(ch.id);
        const muted = this._muteState.get(ch.id) || false;
        const disp = getChannelDisplay(ch.id);

        if (!group || (disp.header && disp.header !== lastHeader)) {
          group = document.createElement('div');
          group.className = 'kbd-chip-group';
          this._rowsInnerEl.appendChild(group);
          if (disp.header) {
            const headerRow = document.createElement('div');
            headerRow.className = 'kbd-chip-header kbd-chip-header--toggle';
            headerRow.title = T('クリックでこの音源のch一覧を開閉');
            // 見出しをクリックするとこの音源のch行だけを畳む(音源ごとの状態はlocalStorageへ保存)。
            // 畳んだ側はch数だけを見出しに出し、行の更新(波形描画など)もupdate()側で省く
            group.dataset.chip = disp.header;
            const tog = document.createElement('span');
            tog.className = 'kbd-chip-toggle';
            const label = document.createElement('span');
            label.className = 'kbd-chip-label';
            label.textContent = disp.header;
            const count = document.createElement('span');
            count.className = 'kbd-chip-count';
            headerRow.appendChild(tog);
            headerRow.appendChild(label);
            headerRow.appendChild(count);
            headerRow.addEventListener('click', () => this._toggleChipCollapse(disp.header));
            // チャンネルプール/ペア交互割当のチップ: 表示モード切替(実機スロット=素材のまま /
            // 合成ch=割当逆算)。行構成は同じでデータ系列だけが替わる。見た目は2状態の
            // トグルスイッチ(クリックで切替、点灯側が現在モード)。
            if (disp.pool) {
              const sw = document.createElement('span');
              sw.className = 'kbd-pool-toggle';
              sw.dataset.pool = disp.pool;
              sw.style.cssText = 'display:inline-flex;margin-left:8px;font-size:9px;border:1px solid #444;border-radius:8px;overflow:hidden;cursor:pointer;user-select:none;vertical-align:middle;';
              const modes = disp.poolModes || ['logical', 'phys'];
              sw.title = modes.indexOf('track') >= 0
                ? T('表示モード: トラック=ドライバ内部のトラックごと(和音は声部ごとの行) / 合成ch=音色と音程の連続性でメロディを同じ行へ束ね直す / 実機スロット=ドライバの割当そのまま')
                : T('チャンネルプール式音源の表示モード: 実機スロット=ドライバの巡回割当そのまま / 合成ch=音色と音程の連続性でメロディを同じ行へ束ね直す');
              const MODE_LABEL = { track: T('トラック'), logical: T('合成ch'), phys: T('実機スロット') };
              const segs = modes.map((m) => {
                const s = document.createElement('span');
                s.textContent = MODE_LABEL[m];
                s.style.cssText = 'padding:1px 6px;';
                s.dataset.mode = m;
                sw.appendChild(s);
                return s;
              });
              const current = () => this._poolModes[disp.pool] || modes[0];
              const paint = () => {
                const cur = current();
                for (const s of segs) {
                  const on = s.dataset.mode === cur;
                  s.style.background = on ? '#3a6ea5' : '#22242e';
                  s.style.color = on ? '#fff' : '#667';
                }
              };
              sw._paint = paint; // setPoolModes()からの再描画用
              paint();
              sw.addEventListener('click', (e) => {
                e.stopPropagation(); // 見出しクリック(折りたたみ)と二重に反応させない
                // 押した段へ切り替える(段の外=枠線の上なら2段のときだけ従来どおり反転)
                const seg = e.target && e.target.dataset && e.target.dataset.mode;
                const cur = current();
                const mode = seg || (modes.length === 2 ? modes[1 - modes.indexOf(cur)] : cur);
                if (mode === cur) return;
                this._poolModes[disp.pool] = mode;
                paint();
                if (this.onPoolModeChange) this.onPoolModeChange(disp.pool, mode);
              });
              headerRow.appendChild(sw);
            }
            group.appendChild(headerRow);
          }
          lastHeader = disp.header;
        }

        const row = document.createElement('div');
        const rowColor = this._getColor(ch.id, ch.color);
        row.className = 'kbd-ch-row';
        // ALL行(ch.isAllRow、HESの$0801全体バランス用。SPCのALL行と同じ考え方)は
        // 実チャンネルではないのでミュートチェックボックスの代わりにプレースホルダを置き、
        // wave/note/freqは何も表示しない(空欄のまま)。
        row.innerHTML =
          `<span class="kbd-dot" style="background:${rowColor}"></span>` +
          partChipHtml(ch) +
          (ch.isAllRow
            ? `<span class="kbd-mute-ph"></span>`
            : `<input type="checkbox" class="kbd-mute"${muted ? '' : ' checked'} title="${T('{ch} ミュート', { ch: ch.id })}">`) +
          `<span class="kbd-name"${ch.labelTitle ? ` title="${ch.labelTitle}"` : ''}>${ch.label || disp.name}</span>` +
          assignCellHtml(ch) +
          `<span class="kbds-lr kbds-l"></span>` +
          `<span class="kbds-lr"></span>` +
          `<span class="kbd-vol-num">0</span>` +
          `<span class="kbd-vol-wrap">` +
            `<span class="kbd-vol-bar" style="background:transparent"></span>` +
            (ch.isAllRow ? '' :
              `<input type="range" class="kbd-vol-slider" min="0" max="200" step="1" value="${Math.round((this._channelVolumes.get(ch.id) ?? 1) * 100)}" title="${T('{ch} 音量(中央100%・ダブルクリックで100%)', { ch: ch.id })}">` +
              `<span class="kbd-vol-tooltip"></span>`) +
          `</span>` +
          (ch.isAllRow ? `<span class="kbd-wave" style="visibility:hidden"></span>` : `<canvas class="kbd-wave" width="68" height="28"></canvas>`) +
          `<span class="kbd-note">${ch.isAllRow ? '' : '—'}</span>` +
          `<span class="kbd-freq"></span>`;

        let checkbox = null;
        if (!ch.isAllRow) {
          checkbox = row.querySelector('.kbd-mute');
          checkbox.addEventListener('change', () => {
            this._muteState.set(ch.id, !checkbox.checked);
            if (this.onMuteChange) this.onMuteChange(this.getMuteConfig());
            this._notifyPreview();
            this._renderMuteAllBtn(); // 見出しの一括ミュートボタンの状態を追随させる
            // ミュートはロールの見え方(減光)にも効くので、停止中でもその場で描き直す
            this._redrawRollForSpotlight();
          });
        }
        if (!ch.isAllRow) this._attachVolumeSlider(row, ch.id);

        // 波形アイコンをクリックで大波形表示に選択(ALL行には波形アイコン自体が無い)
        const waveCanvas = ch.isAllRow ? null : row.querySelector('.kbd-wave');
        const chId = ch.id;
        if (waveCanvas) {
          waveCanvas.classList.add('kbd-wave--clickable');
          if (chId === this._shownWaveId) waveCanvas.classList.add('kbd-wave--selected');
          waveCanvas.addEventListener('click', () => {
            this._selectWave(chId);
            // ★選んだ直後はカーソルがその行の上にあるので、そのままピックアップさせる。
            //   ホバーはmouseenterでしか発火しないため、クリックで選んだだけでは
            //   ロールが反応しなかった(ユーザー報告)
            this._setSpotlightHover(chId);
          });
        }

        // 丸のクリックで色ピッカーを開く(選んだ色は即localStorageへ保存され全表示に反映)
        this._attachColorPicker(row.querySelector('.kbd-dot'), ch.id, ch.color);

        // YM2610 ADPCM行(NA1-6/NB): note列クリックで手動ピッチキャリブレーション(onAdpcmCalibrate、
        // main.jsがプロンプトを出してチップの setSampleTuning を呼ぶ)。対象は「今その行で鳴っている
        // サンプル」(ch.adpcmSample)なので、直近の update() の channels(_lastChannels)から引く
        // (_prevChannelsは行再構築時にしか更新されず古い)
        // note列クリック: サンプルPCM系の行(adpcmSampleを持つ行)なら「打楽器/音階の手動指定 +
        // 基準音の手動補正」の小メニューを出す。★どちらもサンプル単位の指定なので、
        // 「今その行で鳴っているサンプル」(_lastChannels)を対象にする
        if (SAMPLE_ROW_RE.test(ch.id)) {
          const noteElForClick = row.querySelector('.kbd-note');
          noteElForClick.classList.add('kbd-note--clickable');
          noteElForClick.title = T('クリックで打楽器/音階の指定と基準音の手動補正');
          noteElForClick.addEventListener('click', () => {
            const cur = (this._lastChannels || this._prevChannels || []).find(c => c.id === chId);
            if (cur && cur.adpcmSample) this._openSampleMenu(noteElForClick, cur);
          });
        }

        const lrEls = row.querySelectorAll('.kbds-lr');

        // チャンネル割当(part列のチップ + 割当表示ONのときのセレクト。案E)
        if (!ch.isAllRow) this._wireAssign(row, ch);
        // スポットライト(案D): 行ホバー=一時的に注目、ch名クリック=固定
        if (!ch.isAllRow) this._attachSpotlight(row, ch.id);

        group.appendChild(row);
        this._rowEls.push({
          row,
          id: ch.id,
          chip: lastHeader || '', // この行が属する音源の見出し(折りたたみ判定用)
          collapsed: false,
          isAllRow: !!ch.isAllRow,
          volBar: row.querySelector('.kbd-vol-bar'),
          volNum: row.querySelector('.kbd-vol-num'),
          volWrap: row.querySelector('.kbd-vol-wrap'), volMasked: false, volTip: '',
          lEl: lrEls[0], rEl: lrEls[1],
          waveCanvas,
          waveSig: '',
          noteEl: row.querySelector('.kbd-note'),
          freqEl: row.querySelector('.kbd-freq'),
          checkbox,
          muteInfo: mi,
          color: rowColor,
          defaultColor: ch.color,
          letter: ch.letter,
          laneGroup: ch.laneGroup || null, // ロールの区画キー(PSF トラックモード。null=1行1区画)
          laneCopy: !!ch.laneCopy,
          // チャンネル割当(案E): part列チップとセレクトの参照+この行の既定の借用先
          partEl: row.querySelector('.kbd-part'),
          targetSel: row.querySelector('.kbd-assign-target'),
          toneSel: row.querySelector('.kbd-assign-tone'),
          drumBtn: row.querySelector('.kbd-assign-drum'),
          tonesBtn: row.querySelector('.kbd-assign-tones'),
          plainEl: row.querySelector('.kbd-assign-plain'),
          defaultTarget: ch.defaultTarget,
          target: ch.target,
        });
      }
      this._applyChipCollapse(); // 音源ごとの折りたたみ状態を新しい行へ反映
      // 大波形に表示するchを新しい一覧に合わせる(SPCモード中はSPC側の一覧が表示中なので触らない)
      if (this._mode !== 'spc') {
        this._consumePendingSelectionReset(this._rowEls.filter(el => el.waveCanvas).map(el => el.id));
        this._syncShownWave(this._rowEls);
        this._rebuildLanes(); // チャンネルごとのレーン表示も一覧に合わせる
      }
      this._refreshAssignUi(); // part列の文字・スキップ減光・重複警告を新しい行へ反映
      this._renderMuteAllBtn();
      this._applySpotlightClasses(); // 固定中のスポットライトの目印を新しい行へ復元
    }

    // ch別音量スライダー(音量バー領域に重ねる半透明オーバーレイ)を1行ぶん配線する。
    // 通常は薄く見えるだけで、ドラッグ中(またはホバー/フォーカス中)だけ数値ツールチップを
    // 出す。値は0〜200%(中央=100%)のrange inputで、_channelVolumes(localStorage永続化)を
    // 直接操作する。ダブルクリックで100%へ戻る。
    // getVolumeConfig()の項参照: 適用先はこのMapを直接読むため、ここではUIの見た目の
    // 同期(初期値反映・スライダー操作時の即時保存)だけを担当すればよい。
    _attachVolumeSlider(row, id) {
      const slider = row.querySelector('.kbd-vol-slider');
      const tooltip = row.querySelector('.kbd-vol-tooltip');
      if (!slider) return;
      const showTooltip = () => {
        tooltip.textContent = `${slider.value}%`;
        tooltip.classList.add('visible');
      };
      const hideTooltip = () => tooltip.classList.remove('visible');
      slider.addEventListener('pointerdown', () => { slider.classList.add('dragging'); showTooltip(); });
      slider.addEventListener('pointerup', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('pointercancel', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('keydown', () => showTooltip()); // キーボード操作(矢印キー)にも対応
      slider.addEventListener('blur', hideTooltip);
      slider.addEventListener('input', () => {
        const vol = (parseInt(slider.value, 10) || 0) / 100;
        showTooltip();
        this._channelVolumes.set(id, vol);
        saveChannelVolumes(this._channelVolumes);
        if (this.onVolumeChange) this.onVolumeChange();
      });
      slider.addEventListener('dblclick', () => {
        slider.value = '100';
        slider.dispatchEvent(new Event('input'));
      });
    }

    // SPCボイス(V0〜V7)版。_spcVoiceVolumes(配列index=ボイス番号)を直接操作する点以外は
    // _attachVolumeSlider()と同じ(見た目・ツールチップ挙動を統一するため実装も揃えている)。
    _attachSpcVolumeSlider(row, idx) {
      const slider = row.querySelector('.kbd-vol-slider');
      const tooltip = row.querySelector('.kbd-vol-tooltip');
      if (!slider) return;
      const showTooltip = () => {
        tooltip.textContent = `${slider.value}%`;
        tooltip.classList.add('visible');
      };
      const hideTooltip = () => tooltip.classList.remove('visible');
      slider.addEventListener('pointerdown', () => { slider.classList.add('dragging'); showTooltip(); });
      slider.addEventListener('pointerup', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('pointercancel', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('keydown', () => showTooltip());
      slider.addEventListener('blur', hideTooltip);
      slider.addEventListener('input', () => {
        const vol = (parseInt(slider.value, 10) || 0) / 100;
        showTooltip();
        this._spcVoiceVolumes[idx] = vol;
        saveSpcVoiceVolumes(this._spcVoiceVolumes);
        if (this.onSpcVolumeChange) this.onSpcVolumeChange(this._spcVoiceVolumes.slice());
      });
      slider.addEventListener('dblclick', () => {
        slider.value = '100';
        slider.dispatchEvent(new Event('input'));
      });
    }

    // 波形アイコンのクリック: 選択チャンネルを切り替え、拡大表示を更新
    // NSF/SPC どちらの行がクリックされても対応できるよう両リストを見る（IDは重複しない）
    _selectWave(chId) {
      this._selectedId = chId;
      this._shownWaveId = chId;
      this._bigWaveSig = '';   // 強制再描画
      // 一覧の下の折りたたみ帯に置かれていて畳まれていたら、選んだ時点で開く
      if (this._bigWaveCollapsed && this._bigWaveBelow()) {
        this._bigWaveCollapsed = false;
        try { localStorage.setItem('mml_bigWaveCollapsed', '0'); } catch (e) { /* ignore */ }
        this._applyLayoutClasses();
      }
      // HESのALL行はwaveCanvasを持たない(el.waveCanvas===null)ため、他行を飛ばして
      // 例外にならないようガードする(ガード無しだとALL行で例外→以降の行のtoggleが
      // 一件も実行されず青枠が付かなくなる。大波形表示自体はupdate()側の毎フレーム
      // 再描画で別途追従するため気付かれにくい)。
      for (const el of this._rowEls) {
        if (el.waveCanvas) el.waveCanvas.classList.toggle('kbd-wave--selected', el.id === chId);
      }
      for (const el of this._spcRowEls) {
        if (el.waveCanvas) el.waveCanvas.classList.toggle('kbd-wave--selected', el.id === chId);
      }
      // 直近のチャンネル状態で即時描画
      const ch = (this._prevChannels || []).find(c => c.id === chId) ||
                 (this._prevSpcVoices || []).find(c => c.id === chId);
      if (ch) this._renderBigWave(ch);
    }

    // 選択チャンネルの素波形を右パネルへ描画（形状変化時のみ再描画）
    _renderBigWave(ch) {
      if (!ch || !ch.wave) return;
      // コピー可否は再描画をスキップする場合でも常に最新化する(表示形状のsigが
      // 同じでもチャンネル切替直後にボタン状態が古いままになるのを防ぐため)
      this._bigWaveCopyData = getCopyableWaveSamples(ch.wave);
      if (this._bigCopyBtn) this._bigCopyBtn.disabled = !this._bigWaveCopyData;

      // FM音色データ(OPLL/VRC7/YM2612/YM2610)。波形の見た目(sig)が同じでもパラメータは
      // 変わりうるので、sig判定より前に毎回テキストを比較して更新する
      if (this._bigPatchEl) {
        const ptype = ch.fmPatch ? ch.fmPatch.type : null;
        this._bigPatchCh = ptype ? ch : null;
        // 書式selectのoptionを音源種別に合わせる(種別が変わった時だけ作り直す)
        if (ptype !== this._bigPatchFmtType) {
          this._bigPatchFmtType = ptype;
          this._bigPatchFmtSel.innerHTML = '';
          for (const f of (FM_PATCH_FORMATS[ptype] || [])) {
            const o = document.createElement('option'); o.value = f.id; o.textContent = T(f.label);
            this._bigPatchFmtSel.appendChild(o);
          }
          if (ptype) this._bigPatchFmtSel.value = getFmPatchFormat(ptype);
          this._bigPatchFmtSel.style.display = ptype ? '' : 'none';
        }
        const text = formatFmPatch(ch);
        if (text !== this._bigPatchText) {
          this._bigPatchText = text;
          this._bigPatchEl.innerHTML = text ? renderFmPatchHtml(text) : '';
          this._bigPatchEl.style.display = text ? '' : 'none';
          this._bigPatchCopyBtn.style.display = text ? '' : 'none';
        }
      }

      const sig = bigWaveSig(ch.wave);
      if (sig === this._bigWaveSig) return;
      this._bigWaveSig = sig;
      const color = this._getColor(ch.id, ch.color);
      drawBigWave(this._bigCanvas, ch.wave, color);
      this._bigTitleEl.innerHTML =
        `<span class="kbd-bigwave-dot" style="background:${color}"></span>` +
        `${ch.id}　${waveTypeLabel(ch.wave)}`;
    }

    // 現在のチェックボックス状態からミュート設定を返す
    /** 1つでもミュートされている行があるか(無音自動送りの判定を止めるため。main.js参照) */
    hasAnyMute() {
      for (const el of this._rowEls) if (el.checkbox && !el.checkbox.checked) return true;
      for (const el of (this._spcRowEls || [])) if (el.checkbox && !el.checkbox.checked) return true;
      return false;
    }

    // 行ID → ミュート設定の座標({section, chip, key|index, type})。main.js の合成音ch打楽器化
    // (他chを全部ミュートして1chだけレンダリング)が「1chだけ生かした設定」を組むのに使う
    getMuteInfoFor(id) { return getMuteInfo(id) || null; }
    // 現在のピアノロールのタイムライン(共通形状 [{id, color, notes:[{startSec,endSec,midi,vol,drumKey?}]}])
    getRollTimeline() { return this._rollTimeline || null; }

    // opts.ignorePreview: 「割当先の音で聴く」中の元ch消し込みを含めない(WAV書き出しは常に元の音)
    getMuteConfig(opts) {
      const config = { apu: {}, expansion: {} };
      const withPreview = !(opts && opts.ignorePreview);
      for (const el of this._rowEls) {
        const mi = el.muteInfo;
        if (!mi) continue;
        const muted = !el.checkbox.checked || (withPreview && this._previewMutesRow(el));
        if (mi.section === 'apu') {
          config.apu[mi.key] = muted;
        } else {
          if (!config.expansion[mi.chip]) {
            config.expansion[mi.chip] = mi.type === 'array' ? [] : {};
          }
          if (mi.type === 'array') {
            config.expansion[mi.chip][mi.index] = muted;
          } else {
            config.expansion[mi.chip][mi.key] = muted;
          }
        }
      }
      return config;
    }

    // 現在のch別音量設定を返す(getMuteConfig()と同じ形状、値は0〜1)。getMuteConfig()と
    // 違い_rowEls(現在表示中の行のDOM)ではなく永続化Map(_channelVolumes)から直接組み立てる
    // (getMuteInfo(id)はidの文字列だけから決まる純粋関数のため、行がまだ再構築されて
    // いない/別フォーマットの行のままでも正しく引ける。ミュートで「再生開始直後、行が
    // まだ古いままの状態でgetMuteConfig()を呼ぶと的外れな設定を返す」問題が起きていた
    // [[keyboard-mute-state-new-file-leak]]のと同じ穴を音量では踏まないための設計)。
    getVolumeConfig() {
      const config = { apu: {}, expansion: {} };
      for (const [id, vol] of this._channelVolumes) {
        const mi = getMuteInfo(id);
        if (!mi) continue;
        if (mi.section === 'apu') {
          config.apu[mi.key] = vol;
        } else {
          if (!config.expansion[mi.chip]) {
            config.expansion[mi.chip] = mi.type === 'array' ? [] : {};
          }
          if (mi.type === 'array') {
            config.expansion[mi.chip][mi.index] = vol;
          } else {
            config.expansion[mi.chip][mi.key] = vol;
          }
        }
      }
      return config;
    }

    // SPCボイス音量(配列、V0〜V7)。呼び出し側が書き換えても影響しないようコピーを返す
    getSpcVolumeConfig() {
      return this._spcVoiceVolumes.slice();
    }

    // MMLチャンネル文字(A,B,...拡張音源含む) → 現在ミュート中かどうか。
    // 再生ハイライト機能(main.js)がハイライト表示をミュート状態と連動させるために使う
    isChannelMuted(letter) {
      if (!letter) return false;
      for (const el of this._rowEls) {
        if (el.letter === letter) return !el.checkbox.checked;
      }
      return false;
    }

    update(posSeconds) {
      if (!this._state) return;
      const { regSnapshots, totalFrames, samplesPerFrame, sampleRate } = this._state;
      if (!regSnapshots || totalFrames === 0) return;

      const frameDur = samplesPerFrame / sampleRate;
      const fi = Math.max(0, Math.min(totalFrames - 1, Math.floor(posSeconds / frameDur)));

      const snap = regSnapshots[fi] || {};
      const channels = extractChannels(snap, this._extraSnaps, fi, this._chips);
      // ドラムパッドへ載せた行(分離レンダリング由来など)は、ロールの打点から
      // 「今どのパッドが鳴っているか」を補う(_applyPadKeys 冒頭コメント参照)
      this._applyPadKeys(channels, posSeconds);
      // 直近の抽出結果(_prevChannelsは行の再構築時にしか更新されない=行構成の基準用。
      // 「今この行で鳴っているもの」を要する処理(ADPCM手動キャリブレーションのクリック等)はこちらを見る)
      this._lastChannels = channels;

      // 行数が同じでも並び/行名が変わったら組み直す(PSF のトラックモードは行名を持ち、表示モード切替や
      // 複製の印で行の意味が変わる。行名を持たない形式は ID の並びだけを見る)
      const rowSig = channels.some(c => c.label !== undefined) ? channels.map(c => c.id + '' + (c.label || '') + '' + (c.labelTitle || '')).join('') : null;
      if (channels.length !== this._rowEls.length || rowSig !== this._rowSig) {
        this._rowSig = rowSig;
        this._prevChannels = channels;
        this._rebuildRows(channels);
      }

      for (let i = 0; i < channels.length && i < this._rowEls.length; i++) {
        const ch = channels[i];
        const el = this._rowEls[i];

        // 音源ごと折りたたみで隠れている行は見えないので、波形アイコンの描画ごと省く
        // (鍵盤・ピアノロールは channels から直接描くのでここを飛ばしても欠けない)
        if (el.collapsed) continue;

        // L/R列(SPCのステレオパン表示と同じ考え方、色もSPCの.kbds-lrに合わせグレー固定)。
        // panL/panRを持つch(HES: ALL行の$0801, 各chの$0805。GBS: ALL行のNR50, 各chのNR51)
        // だけ値を出し、他フォーマットは空欄のまま。GBSのALL行はVIN有効時だけ黄色にする。
        // ★panLText/panRText(文字列)があればそれを出す(2026-09-17のパン/音量表示改修)。
        //   パン機能を持たないチップの '—'、中央基準の位置表示('C'/'L3'/'R5')、
        //   C352 の前後4値のような「数値1つに収まらない表示」はこちらを使う。
        const lTxt = ch.panLText !== undefined ? ch.panLText : (ch.panL !== undefined ? String(ch.panL) : '');
        const rTxt = ch.panRText !== undefined ? ch.panRText : (ch.panR !== undefined ? String(ch.panR) : '');
        if (el.lEl) { el.lEl.textContent = lTxt; el.lEl.style.color = ch.vinL ? '#ffcc44' : (lTxt === PAN_NONE ? '#555566' : ''); }
        if (el.rEl) { el.rEl.textContent = rTxt; el.rEl.style.color = ch.vinR ? '#ffcc44' : (rTxt === PAN_NONE ? '#555566' : ''); }

        // ALL行(実チャンネルではない)はL/R以外に表示するものが無いので、以降のvol/wave/note/freq
        // 更新はスキップする(チェックボックスも無いためel.checkbox.checkedへのアクセスもできない)。
        if (el.isAllRow) continue;

        const muted = !el.checkbox.checked;

        // DMC: $4011 が書き込まれた瞬間だけ検出（レジスタ値の変化＝直接DAC書き込み）。
        // 直接PCM再生中は発声扱いにし、その瞬間だけ数値を黄色にする。
        // ★対象は 2A03 DM 行(ch.dmcDirect)だけ。以前は sample:true の全行(RF5C164/PWM/ADPCM等)で
        //   1つの _lastDmc4011 を共有していたため、サンプル行が複数あると隣の行の値と比較して
        //   常に「書き換わった」と判定され、PCM行の音量数値が意味なく黄色になり active も強制されていた
        let dmcWritten = false;
        if (ch.dmcDirect && ch.dmcReg !== undefined) {
          if (this._lastDmc4011 !== null && ch.dmcReg !== this._lastDmc4011) {
            dmcWritten = true;
            ch.active = true;
          }
          this._lastDmc4011 = ch.dmcReg;
        }

        const showVol = ch.active && !muted;
        // volApparent(干渉ぶんを含む実際に聞こえる大きさ)があればバーはそちらを出す。
        // vol はロールが使うレジスタどおりの値なので混ぜない。
        const volShown = ch.volApparent !== undefined ? ch.volApparent : ch.vol;
        const pct = showVol ? Math.round(volShown * 100) : 0;
        el.volBar.style.width = pct + '%';
        el.volBar.style.background = pct > 0 ? el.color : 'transparent';

        // 減衰エンベロープ、DMC直接書き込み、または見かけ音量が下がっている(maskBy)時は
        // 音量数値を黄色にして「レジスタをそのまま読んだ値ではない/そのとおりには鳴っていない」を示す。
        const masked = showVol && !!ch.maskBy;
        // volText: 音量数値の文字列指定(2026-09-17)。音量値そのものを持たず L/R でしか
        //   音量が決まらないチップ(C140/C352/SegaPCM)は '—' を入れる。バーはそのまま出す。
        const rawStr = ch.volText !== undefined ? (showVol || ch.volText === VOL_NONE ? ch.volText : '')
          : ((showVol && ch.rawVol !== null && ch.rawVol !== undefined) ? String(ch.rawVol) : '');
        el.volNum.textContent = rawStr;
        el.volNum.style.color = (!rawStr || rawStr === VOL_NONE) ? '#555566'
          : ((ch.envMode === true || dmcWritten || masked) ? '#ffcc44' : '#e6e6ef');
        // 干渉で音量が下がっている行は音量バーの枠も黄色にして、バーの短さが
        // 「レジスタが小さい」ではなく「干渉で削られている」ことを示す。
        if (el.volWrap && el.volMasked !== masked) {
          el.volWrap.classList.toggle('kbd-vol-wrap--masked', masked);
          el.volMasked = masked;
        }
        // カーソルを合わせた時の説明。干渉源(ノイズ/三角波/DPCM)を名指しする。
        // 三角波は数値そのものが比率、ノイズは数値がレジスタ値なので言い回しを変える(maskTip)。
        // 実レジスタをそのまま出す列は、読み方(0が最大/符号付き/音量値を持たない)を説明で補う
        const tip = masked ? T(ch.maskTip || MASK_TIP_RATIO, { src: T(MASK_SRC[ch.maskBy] || '') })
          : ch.volText === VOL_NONE ? T('この音源は音量値を持たず、L/Rの音量だけで決まります')
          : ch.volZeroMax ? T('実レジスタ値(0が最大、{max}が最小)', { max: ch.rawVolMax })
          : ch.volSigned ? T('現在の振幅(符号付き、-{max}〜+{max})', { max: ch.rawVolMax })
          : '';
        if (el.volTip !== tip) {
          el.volNum.title = tip;
          if (el.volWrap) el.volWrap.title = tip;
          el.volTip = tip;
        }

        // 素波形アイコン: 発声中のみ更新。使っていないチャンネルは更新しない
        // （発声→停止の遷移時に1回だけ暗色で描き、以後は据え置き＝波形データのハッシュ計算も省略）。
        const waveOn = ch.active && !muted;
        if (waveOn || el.waveOn !== waveOn) {
          const wsig = waveSig(ch.wave, waveOn);
          if (wsig !== el.waveSig) {
            el.waveSig = wsig;
            drawWaveIcon(el.waveCanvas, ch.wave, el.color, waveOn);
          }
          el.waveOn = waveOn;
        }

        if (!ch.active || muted) {
          // APUチャンネルが$4015で無効化されている場合は "-" を表示
          const apuIds = ['P1','P2','TR','NO','DM'];
          const isApuDisabled = apuIds.includes(ch.id) && !muted;
          el.noteEl.textContent = muted ? '(M)' : (isApuDisabled ? '-' : '—');
          el.noteEl.style.color = '#555566';
          el.freqEl.textContent = '';
        } else if (ch.dda) {
          // HES PSG: DDA(ソフトウェアPCM)モードで生DAC値を直接再生中
          el.noteEl.textContent = 'PCM';
          el.noteEl.style.color = '#e6e6ef';
          el.freqEl.textContent = '';
        } else if (ch.noise) {
          // note: 周期インデックス数値。長周期=白 / 短周期=黄。ch.noiseLabelがあれば
          // (HES: 固定文字列'noise'。ノイズ周期がindex化されていない音源向け)そちらを優先。
          el.noteEl.textContent = ch.noiseLabel !== undefined ? ch.noiseLabel : String(ch.noiseIndex);
          el.noteEl.style.color = ch.noiseShort ? '#ffcc44' : '#e6e6ef';
          // freq: ノイズ周波数 (Hz)。ノイズ周波数の実測値を持たない音源では空欄のまま。
          el.freqEl.textContent = (ch.noiseFreq !== undefined) ? (Math.round(ch.noiseFreq).toLocaleString() + ' Hz') : '';
        } else if (ch.adpcmPitch) {
          // YM2610 ADPCM-A/B: adpcmExact(サンプル解析ピッチ×再生レート)なら通常の音名+実周波数、
          // それ以外(ADPCM-Bの解析不能時)は目安の音名に'?'を付け、freq列にはDelta-N由来の
          // 再生レート(Hz、=元のPCMサンプリングレート)を出す
          const midi = adpcmPitchToMidi(ch);
          if (ch.adpcmExact) {
            el.noteEl.textContent = midi !== null ? midiToName(midi) : '??';
            el.noteEl.style.color = ch.adpcmManual ? '#ffcc44' : '#e6e6ef'; // 手動補正済みは黄色
            el.freqEl.textContent = ch.freq > 0 ? ch.freq.toFixed(1) + ' Hz' : '';
          } else {
            el.noteEl.textContent = midi !== null ? midiToName(midi) + '?' : '??';
            el.noteEl.style.color = midi !== null ? '#e6e6ef' : '#555566';
            el.freqEl.textContent = ch.freq > 0 ? Math.round(ch.freq).toLocaleString() + ' Hz' : '';
          }
        } else if (ch.drumKey && this._drumLaneOf && this._drumLaneOf.has(ch.drumKey)) {
          // 打楽器として鳴っているサンプルPCM: note列は「今このスロットが鳴らしている太鼓」
          // (ドラム区画のレーンのラベルと色)。プール式チップは同じ太鼓が毎回別スロットへ
          // 移るので、行を見ただけでどの音か分かるこの表示が効く。
          // (従来はdmcRateIdxを出していたが、この経路では常に固定値15で情報が無かった)
          const laneIdx = this._drumLaneOf.get(ch.drumKey);
          const laneInfo = this._drumLanes[laneIdx];
          el.noteEl.textContent = (laneInfo && laneInfo.label) || '?';
          el.noteEl.style.color = (laneInfo && laneInfo.color) || '#e6e6ef';
          el.freqEl.textContent = ch.dmcFreq > 0 ? Math.round(ch.dmcFreq).toLocaleString() + ' Hz' : '';
        } else if (ch.padRow) {
          // パッドに載っている行(_applyPadKeys)で、今この瞬間に当たっている打点が無い場合。
          // レートの疑似音程を出しても意味が無いので空欄にする
          el.noteEl.textContent = '—';
          el.noteEl.style.color = '#555566';
          el.freqEl.textContent = '';
        } else if (ch.sample) {
          // note: $4010 再生速度インデックス / freq: DPCM再生周波数
          el.noteEl.textContent = String(ch.dmcRateIdx);
          el.noteEl.style.color = '#e6e6ef';
          el.freqEl.textContent = Math.round(ch.dmcFreq).toLocaleString() + ' Hz';
        } else {
          el.noteEl.style.color = '#e6e6ef';
          const midi = freqToMidi(ch.freq);
          // freq列はFDSモジュレーション適用後の実ピッチ(ch.modFreq)があればそちらを表示する。
          // note(音名)は表示のちらつきを避けるため変調前のch.freqのまま判定する
          const dispFreq = ch.modFreq !== undefined ? ch.modFreq : ch.freq;
          if (midi !== null) {
            el.noteEl.textContent = midiToName(midi);
            el.freqEl.textContent = dispFreq.toFixed(1) + ' Hz';
          } else {
            // 鍵盤範囲外(C1未満/C8超)は音名を出しつつ色を落とす(freqToMidiAny参照)。
            // 周波数はあるのに音名が決まらないときだけ '??'
            const any = freqToMidiAny(ch.freq);
            el.noteEl.textContent = any !== null ? midiToName(any) : (ch.freq > 0 ? '??' : '—');
            if (any !== null) el.noteEl.style.color = '#9a9ab0';
            el.freqEl.textContent = ch.freq > 0 ? dispFreq.toFixed(1) + ' Hz' : '';
          }
          // FDSのピッチモジュレーション(MH<n>)有効中はfreq列を黄色で強調し、
          // どのレジスタ条件によるものかtitle属性(ツールチップ)で示す。
          // ★注意: title自体はfreqEl(モジュレーション中は毎フレームtextContentが
          // 変化する要素)ではなくrow(行全体、変調中でも中身が変わらない要素)に
          // 付ける。freqElに付けるとブラウザがtextContent変化のたびhoverタイマーを
          // リセットしてしまい、ネイティブツールチップが実質出せなくなる(SPCのADSR
          // ツールチップは値が音符の間ほぼ変化しないため同じ問題が起きなかっただけ)
          el.freqEl.style.color = ch.modActive ? '#ffcc44' : '';
          el.row.title = ch.modActive ? T('$4087 bit7=0 (モジュレーション有効)') : '';
        }
      }

      // 選択チャンネルの大波形を更新（FDS/N163 等は波形が変化するため毎フレーム判定）
      if (this._shownWaveId) {
        const sel = channels.find(c => c.id === this._shownWaveId);
        if (sel) this._renderBigWave(sel);
      }

      // SPC ボイスを合流させてピアノに反映(色はユーザー上書きを解決してから渡す)
      const spcCh = this._spcVoices.map(v => ({
        id: v.label, color: this._getColor(v.label, v.color), freq: v.freq, vol: v.vol,
        active: v.active, rawVol: null, rawVolMax: null,
      }));
      // ★SPCボイスも _applyPadKeys を通す(2026-09-18)。ここは update() 冒頭の
      //   _applyPadKeys(channels) より**後**で合流するので、通し忘れると drumKey が付かない。
      //   drawPiano は drumKey が無いと音程鍵盤側を光らせるので、E(DPCM)指定したボイスが
      //   「ロールのドラム区画のパッドは消えたまま、鍵盤だけ光る」という食い違いになっていた。
      this._applyPadKeys(spcCh, posSeconds);
      const allChannels = channels.map(c => ({ ...c, color: this._getColor(c.id, c.color) })).concat(spcCh);
      // 演奏入力の押鍵で鍵盤だけ描き直す refreshPianos() も同じ一覧を使う(SPCボイスが消えないように)
      this._lastPianoChannels = allChannels;
      this._drawPianos(allChannels);

      // ピアノロールはSPCモード中は updateSpcVoices() 側が描画するため、ここでは
      // それ以外(NSF/MML/KSS)のときだけ描画する(同じcanvasへの二重描画を避ける)。
      if (this._mode !== 'spc') this._renderRoll(posSeconds);
    }

    /** チャンネルプール式チップの表示モード初期値(main.jsがlocalStorageから復元して渡す)。 */
    setPoolModes(modes) {
      Object.assign(this._poolModes, modes || {});
      for (const sw of this._rowsInnerEl.querySelectorAll('.kbd-pool-toggle')) {
        if (sw._paint) sw._paint(); // data-poolごとに自分のモードを塗り直す
      }
    }

    // トラックid(NSF:'P1'等/SPC:'V0'-'V7'/KSS:'KP1'等)がミュート中かどうかを判定する。
    // SPCボイスは _muteState を経由しない専用のミュート機構(spc-row checkbox)を使うため、
    // _spcRowEls から直接読む。それ以外は通常のチャンネル一覧と共通の _muteState を使う。
    _isTrackMuted(id) {
      if (typeof id === 'string' && /^V\d+$/.test(id)) {
        const idx = parseInt(id.slice(1), 10);
        const el = this._spcRowEls[idx];
        if (el) return !el.checkbox.checked;
      }
      return this._muteState.get(id) || false;
    }

    // ピアノロール描画。音程軸は鍵盤とkeyX()で共有し、時間軸は「現在(鍵盤に接する端)→未来」
    // へ向かって音符を流す。向き(縦=上から降る/横=右から流れる)はmakeRollGeom()が吸収する。
    // _rollTimeline が無い間(先読みキャプチャ完了前など)は前回の描画内容をクリアするだけにする。
    // 描画先: 全チャンネルまとめ(rollLanes='all')なら_rollCanvas 1枚(フィルタ無し)、
    // チャンネルごと(rollLanes='perChannel')なら各レーンのcanvas(そのchのノートだけ)。
    // onlyId: null=全ch / 文字列=その行だけ / 配列=その区画に属する行だけ(PSF トラックモードの和音の声部+複製)
    _inLane(onlyId, id) {
      if (onlyId === null || onlyId === undefined) return true;
      return Array.isArray(onlyId) ? onlyId.indexOf(id) >= 0 : onlyId === id;
    }
    _rollTargets() {
      if (this._layout.rollLanes === 'perChannel' && this._lanes && this._lanes.length) {
        return this._lanes.map(l => ({ canvas: l.rollCanvas, onlyId: l.ids || l.id, lane: l }));
      }
      return [{ canvas: this._rollCanvas, onlyId: null, lane: null }];
    }

    _renderRoll(posSeconds) {
      const targets = this._rollTargets();
      if (!targets.length || !targets[0].canvas) return;
      // 折りたたみ中(表示要素がdisplay:none)は描かない
      const host = targets[0].onlyId === null ? this._rollCanvas : this._lanesEl;
      if (!host || host.style.display === 'none') return;

      // posSeconds(実プレイヤーのgetPosition())はオーディオコールバック単位(数十〜100ms程度)
      // でしか更新されないため、rAF(約16ms間隔)からは同じ値が何フレームも続いた後に一気に
      // 進む「カクつき」に見える。そこで「最後に実測位置が更新された時点の確定値」
      // (_rollSongTimeBase)は実測差分だけで進め(二重加算を避けるため補間分は加算しない)、
      // 描画に使うposはそこに「その後の壁時計経過分」をその場で足すだけにする(蓄積しない)。
      // 実測値が来るたびbaseが実測差分ぶんだけ更新され、補間分は自動的に上書きされる。
      // また、実測位置がしばらく(ROLL_INTERP_CAP_MS以上)更新されない=再生していない状態
      // とみなし、補間による経過をそこで頭打ちにして停止中はロールが動き続けないようにする。
      const ROLL_INTERP_CAP_MS = 400;
      const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const rawPos = posSeconds || 0;
      const speedFactor = 1 / (this._speedDenom || 1);
      if (this._rollLastRawPos === null || rawPos < this._rollLastRawPos - 0.001) {
        // 新規再生開始(rawPos=0)またはシークによる巻き戻り。rawPosは「現在の速度で
        // 曲頭から目標地点まで再生した場合の実時間」(stream-player.jsのseek()参照)
        // なので、rawPos*speedFactorが常に正しい曲内絶対秒になる(新規再生開始時は
        // rawPos=0なので特別扱い不要で0と一致する)。
        this._rollSongTimeBase = rawPos * speedFactor;
        this._rollBaseWallMs = nowMs;
        this._rollCursor = {}; // 巻き戻り時は各trackの走査起点キャッシュも巻き戻す
      } else if (rawPos > this._rollLastRawPos + 1e-6) {
        this._rollSongTimeBase += (rawPos - this._rollLastRawPos) * speedFactor; // 実測位置が更新された
        this._rollBaseWallMs = nowMs;
      }
      this._rollLastRawPos = rawPos;
      const elapsedSinceBaseMs = Math.min(ROLL_INTERP_CAP_MS, Math.max(0, nowMs - (this._rollBaseWallMs || nowMs)));
      let pos = this._rollSongTimeBase + (elapsedSinceBaseMs / 1000) * speedFactor;
      // ロールをドラッグしてシーク中は、実測位置でなくドラッグ位置を表示する(_attachRollSeekDrag参照)。
      // 巻き戻し方向にも動くので走査起点キャッシュは使わない
      if (this._rollDrag) {
        pos = this._rollDrag.pos;
        this._rollCursor = {};
      }
      this._rollLastDrawnPos = pos;
      for (const t of targets) {
        // ヒットテスト(_trackAtRollPoint)が同じ座標系を使えるよう、そのcanvasの表示条件を控える
        t.canvas._rollOnlyId = t.onlyId;
        t.canvas._rollLane = t.lane || null;
        this._drawRollCanvas(t.canvas, pos, t.onlyId, t.lane || null);
      }
    }

    // 時間軸: 曲内の絶対秒(0,1,2,3…)ごとに音程軸方向の線を引き、ノートと同じ式でスクロールさせる。
    // 再生が進むにつれて線が鍵盤側へ流れ、新しい秒の線が先読みの果て(縦向き=上端、横向き=右端)
    // から現れる(累積の経過時間)。ロールと楽譜モードで共通
    _drawRollTimeGrid(ctx, g, pos) {
      const H = g.H;
      const winEnd = pos + g.windowSec;
      ctx.strokeStyle = '#3d3d4a';
      ctx.fillStyle = '#6b6b7a';
      ctx.font = '9px ' + fontStack('sans');
      const firstSec = Math.ceil(pos);
      for (let s = firstSec; s < winEnd; s++) {
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        if (g.vertical) {
          const y = Math.round(H - g.tPx(s - pos)) + 0.5;
          ctx.moveTo(0, y);
          ctx.lineTo(g.W, y);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.textBaseline = 'bottom';
          ctx.fillText(`${s}s`, 2, y - 1);
        } else {
          const x = Math.round(g.tPx(s - pos)) + 0.5;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, H);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.textBaseline = 'top';
          ctx.fillText(`${s}s`, x + 2, 1);
        }
      }
      ctx.globalAlpha = 1;
    }

    // ── 楽譜モード(五線、時間比例。ROADMAP「フェーズ外: 楽譜出力」段階3) ──────────────
    // ロールと同じ座標系(makeRollGeom: 時間軸 t=再生位置からの相対秒、音程軸 p)で、音程軸だけを
    // 五線に置き換える。描くのは五線・小節線・符頭・加線・臨時記号・休符の目印・パート名まで
    // (旗/連桁/音価の型は描かない=段階4の本記譜)。音符の長さは時間比例の棒で示す。
    // 再生位置の「今」は鍵盤側の端(t=0)で、鳴っている音符の符頭は端に留まって光る。
    // データは setScore() の表記モデル。frameStart/frameEnd(コンパイラのフレーム)を fps で秒にする。
    _drawScoreCanvas(canvas, ctx, g, pos, onlyId, lane) {
      const score = this._score;
      const notation = score.notation;
      const fps = score.fps || 60;
      const H = g.H;
      this._drawRollTimeGrid(ctx, g, pos);
      // ループ地点(L)より後ろの末尾複製(compile() が tracks に足す区間)は譜面には無いので、
      // その区間の再生位置はループ地点からの相対位置へ戻して描く
      let posFrame = pos * fps;
      if (score.loopPointFrame != null && score.totalFrames > 0) {
        const natural = (score.totalFrames + score.loopPointFrame) / 2;
        const loopLen = natural - score.loopPointFrame;
        if (loopLen > 0 && posFrame >= natural) posFrame = score.loopPointFrame + ((posFrame - natural) % loopLen);
      }
      const posSec = posFrame / fps;
      const windowSec = g.windowSec;
      // 描くパート: チャンネルごとのレーン表示ならそのchの文字に対応するパートだけ
      const rowByLetter = new Map();
      for (const el of this._rowEls) if (el.letter) rowByLetter.set(el.letter, el);
      let parts = notation.parts;
      if (onlyId !== null && onlyId !== undefined) {
        const firstId = Array.isArray(onlyId) ? onlyId[0] : onlyId;
        const row = this._rowEls.find(e => e.id === firstId);
        parts = parts.filter(p => row && p.letter === row.letter);
      }
      if (!parts.length) return;
      const spotId = this._effectiveSpotlightId();
      const n = parts.length;
      const bandH = g.pitchLen / n;                      // 1パートの帯(音程軸方向のpx)
      const sp = Math.max(1.5, Math.min(7, bandH / 11)); // 五線の間隔
      const r = Math.max(1.5, sp * 0.55);                // 符頭の半径
      const labelPx = Math.max(8, Math.min(11, sp * 1.8));
      const LETTER_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
      const ACC_TEXT = { '-2': '♭♭', '-1': '♭', '0': '♮', '1': '♯', '2': '\u{1D12A}' };
      // 音程軸の線を [pLo, pHi] × 時間 t で引く/時間軸の線を p で引く(向きの違いは g が吸収)
      const lineT = (t, pLo, pHi) => { const a = g.point(pLo, t), b = g.point(pHi, t); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); };
      const lineP = (p, tLo, tHi) => { const a = g.point(p, tLo), b = g.point(p, tHi); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); };

      parts.forEach((part, pi) => {
        // 先頭のパートを最高音側(縦向き=右、横向き=上)へ。帯の中央に五線を置く
        const bandLo = g.pitchLen - (pi + 1) * bandH;
        const pBase = bandLo + bandH / 2 - 2 * sp;       // 第1線(いちばん低い線)
        const row = rowByLetter.get(part.letter);
        const color = row ? row.color : '#9a9ab0';
        const muted = row ? this._isTrackMuted(row.id) : false;
        const dim = (muted || (spotId && row && row.id !== spotId)) ? SPOTLIGHT_DIM_ALPHA : 1;
        // 音部記号ごとの第1線の音(全音階の段番号: オクターブ*7+文字)。ト音=E4、ヘ音=G2、打楽器=E4(unpitched の表示位置)
        const ref = (part.clef && part.clef.sign === 'F') ? 2 * 7 + 4 : 4 * 7 + 2;
        // 帯の境目(薄く)と五線
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = '#3d3d4a';
        ctx.lineWidth = 1;
        ctx.beginPath(); lineP(Math.round(bandLo) + 0.5, 0, g.timeLen); ctx.stroke();
        ctx.globalAlpha = 0.9 * dim;
        ctx.strokeStyle = '#8a8aa0';
        ctx.beginPath();
        for (let i = 0; i < 5; i++) lineP(Math.round(pBase + i * sp) + 0.5, 0, g.timeLen);
        ctx.stroke();
        // 小節線と小節番号
        ctx.fillStyle = '#9a9ab0';
        ctx.font = `${labelPx}px ` + fontStack('sans');
        for (const m of part.measures) {
          const t = m.frameStart / fps - posSec;
          if (t < 0 || t > windowSec) continue;
          ctx.globalAlpha = 0.8 * dim;
          ctx.strokeStyle = '#c0c0d0';
          ctx.beginPath(); lineT(g.tPx(t), pBase, pBase + 4 * sp); ctx.stroke();
          if (sp >= 3) {
            const pt = g.point(pBase + 4 * sp + 2, g.tPx(t) + 2);
            ctx.textBaseline = g.vertical ? 'bottom' : 'bottom';
            ctx.textAlign = 'left';
            ctx.fillText(String(m.number), pt.x, pt.y);
          }
        }
        // 音符片(時間順)。鍵盤側へ流れ去った片は走査起点をキャッシュして飛ばす(ロールと同じ)
        const flat = part.flatItems || [];
        let idx = this._scoreCursor[part.letter] || 0;
        if (idx > flat.length) idx = flat.length;
        while (idx < flat.length && flat[idx].frameEnd / fps <= posSec) idx++;
        this._scoreCursor[part.letter] = idx;
        for (let i = idx; i < flat.length; i++) {
          const it = flat[i];
          const t0 = it.frameStart / fps - posSec;
          if (t0 >= windowSec) break;
          const t1 = Math.min(windowSec, it.frameEnd / fps - posSec);
          const tA = Math.max(0, t0);
          if (it.rest) {
            // 休符: 第3線の上に薄い帯(小節休符はさらに薄く)
            if (t1 <= tA) continue;
            ctx.globalAlpha = (it.measureRest ? 0.10 : 0.22) * dim;
            ctx.fillStyle = '#c0c0d0';
            const rr = g.rect(pBase + 2 * sp - sp * 0.3, sp * 0.6, g.tPx(tA), g.tPx(t1), 1);
            ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
            continue;
          }
          const sym = it.pitch || it.unpitched;
          if (!sym) continue;
          const sounding = t0 <= 0 && t1 > 0;
          // 和音(ピアノ譜の表記モデル)は各音を同じ手順で描く
          const syms = it.chord && it.chord.length > 1 ? it.chord.map(c => c.pitch) : [sym];
          for (const sy of syms) {
          const stepIdx = sy.octave * 7 + LETTER_INDEX[sy.step];
          const d = stepIdx - ref;                       // 第1線からの半段数
          const p = pBase + d * sp / 2;
          if (p < bandLo - sp || p > bandLo + bandH + sp) continue; // 帯の外(極端な音域)は描かない
          // 音長の棒(時間比例)。タイの続き片も棒だけは描く
          ctx.globalAlpha = 0.45 * dim;
          ctx.fillStyle = color;
          const bar = g.rect(p - sp * 0.18, sp * 0.36, g.tPx(tA), g.tPx(t1), 2);
          ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
          if (it.tieStop) continue;                      // タイで繋いだ続きの片: 符頭は打ち直さない
          const tHead = g.tPx(tA) + r;                   // 符頭の中心(時間軸)。鳴っている間は端に留まる
          // 加線(第1線より下/第5線より上の、線の位置に当たる半段ごと)
          ctx.globalAlpha = 0.9 * dim;
          ctx.strokeStyle = '#8a8aa0';
          ctx.lineWidth = 1;
          if (d < 0 || d > 8) {
            ctx.beginPath();
            const ks = d < 0 ? -2 : 10, ke = d, kd = d < 0 ? -2 : 2;
            for (let k = ks; (kd < 0 ? k >= ke : k <= ke); k += kd) {
              const a = g.point(pBase + k * sp / 2, tHead - r * 1.7), b = g.point(pBase + k * sp / 2, tHead + r * 1.7);
              ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
            }
            ctx.stroke();
          }
          // 符頭(打楽器は×)
          const c = g.point(p, tHead);
          ctx.globalAlpha = dim;
          ctx.fillStyle = color;
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, r * 0.5);
          if (part.percussion) {
            ctx.beginPath();
            ctx.moveTo(c.x - r, c.y - r); ctx.lineTo(c.x + r, c.y + r);
            ctx.moveTo(c.x - r, c.y + r); ctx.lineTo(c.x + r, c.y - r);
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.ellipse(c.x, c.y, g.vertical ? r * 1.15 : r * 1.3, g.vertical ? r * 1.3 : r * 1.15, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          if (sounding) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(c.x, c.y, r * 1.9, 0, Math.PI * 2);
            ctx.stroke();
          }
          // 臨時記号(符頭の手前=鍵盤側)
          if (it.accidental && sp >= 3) {
            const acc = ACC_TEXT[String(sy.alter)] || '';
            if (acc) {
              ctx.font = `${Math.round(sp * 2.2)}px ` + fontStack('sans');
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = '#e6e6ef';
              const ap = g.point(p, tHead - r * 2.6);
              ctx.fillText(acc, ap.x, ap.y);
            }
          }
          }
        }
        // パート名(帯の高音側の端、鍵盤側)
        ctx.globalAlpha = 0.9 * dim;
        ctx.fillStyle = color;
        ctx.font = `${labelPx}px ` + fontStack('sans');
        ctx.textAlign = 'left';
        if (g.vertical) { ctx.textBaseline = 'bottom'; ctx.fillText(part.name, bandLo + 2, H - 2); }
        else { ctx.textBaseline = 'top'; ctx.fillText(part.name, 2, H - (bandLo + bandH) + 2); }
      });
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }

    // 1枚のロールcanvasを曲内秒posの状態で描く。onlyId!=nullならそのチャンネルのノートだけ描く
    // (チャンネルごとのレーン表示用。laneが渡されたら音程窓=そのchの音域[lane.offWhite,
    // +lane.visWhite)だけを音程軸いっぱいに描く。窓は_updateLaneRanges()が曲全体から決めた
    // 固定値で、再生中に動かない)。
    _drawRollCanvas(canvas, pos, onlyId, lane) {
      // 内部解像度は表示サイズ(CSS px)に追随させる(縦向き・一覧の下配置ではCSSの固定高さ
      // ROLL_CANVAS_HEIGHTと一致する)。フォールバックのclientHeightはborder-topを含まない値
      const newW = canvas._cachedWidth || canvas.offsetWidth || 560;
      const newH = canvas._cachedHeight || canvas.clientHeight || canvas.height;
      if (newW === 0 || newH === 0) return;
      if (canvas.width !== newW) canvas.width = newW;
      if (canvas.height !== newH) canvas.height = newH;
      const nDrum = (this._drumLanes || []).length;
      const g = makeRollGeom(this._layout.rollOrientation, canvas.width, canvas.height, lane ? (lane.visWhite || 0) : 0, nDrum);
      const { wk: wkW, bk: bkW, H } = g;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, H);
      // 楽譜モード: 表記モデルがあるとき(MML再生中)だけ五線で描く。無ければ従来のロール
      if (this._layout.rollView === 'score' && this._score) {
        this._drawScoreCanvas(canvas, ctx, g, pos, onlyId, lane);
        return;
      }
      const windowSec = g.windowSec;
      const winEnd = pos + windowSec;
      const offPx = lane ? (lane.offWhite || 0) * wkW : 0; // 音程窓の低音側端(px)。keyX()の結果から引く
      const pitchOff = g.drumOff - offPx; // 音程側の座標補正(ドラム区画ぶん右へ + 窓スクロール)

      // ドラム区画のレーングリッド(淡い下地+レーン境界)。音程鍵盤より低音側に置く。
      for (let i = 0; i < nDrum; i++) {
        const d = drumLaneX(i, 0, 1, g.drumLaneW);
        const x0 = d.x - offPx;
        if (x0 + d.size < 0 || x0 > g.pitchLen) continue;
        ctx.fillStyle = '#000000';
        ctx.globalAlpha = i % 2 ? 0.06 : 0.12; // 交互の縞でレーンの境目を分かりやすく(黒鍵の網掛けと同系)
        let r = g.rect(x0, d.size, 0, g.timeLen);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#3d3d4a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (g.vertical) { const x = Math.round(x0) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        else { const y = Math.round(H - x0) + 0.5; ctx.moveTo(0, y); ctx.lineTo(g.W, y); }
        ctx.stroke();
      }
      // ドラム区画と音程鍵盤の境目(区画があるときだけ)
      if (nDrum) {
        ctx.strokeStyle = '#7a86a8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (g.vertical) { const x = Math.round(g.drumOff - offPx) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        else { const y = Math.round(H - (g.drumOff - offPx)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(g.W, y); }
        ctx.stroke();
      }

      // 鍵盤ごとの音程グリッド(白鍵の境界線+黒鍵レーンの淡い網掛け)とCの音名ラベル。
      // グリッドは音程軸に直交する全時間帯の帯/線なので、時間軸[0, timeLen)いっぱいに引く。
      for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
        const rel = midi - MIDI_MIN;
        const semi = rel % 12;
        const keyPos = keyX(midi, wkW);
        if (!keyPos) continue;
        keyPos.x += pitchOff;
        if (keyPos.x + wkW < 0 || keyPos.x - wkW > g.pitchLen) continue; // 音程窓の外
        if (IS_BLACK[semi]) {
          ctx.fillStyle = '#000000';
          ctx.globalAlpha = 0.25;
          const r = g.rect(keyPos.x - bkW / 2, bkW, 0, g.timeLen);
          ctx.fillRect(r.x, r.y, r.w, r.h);
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = '#3d3d4a';
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (g.vertical) {
            const x = Math.round(keyPos.x) + 0.5;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
          } else {
            const y = Math.round(H - keyPos.x) + 0.5;
            ctx.moveTo(0, y);
            ctx.lineTo(g.W, y);
          }
          ctx.stroke();
          // ★音名ラベルはロールではなく鍵盤(drawPiano)に書く。以前は縦向きだけロールの
          //   上端に書いていたが、横向きは鍵に書いており置き場が食い違っていた(ユーザー指摘)。
        }
      }

      this._drawRollTimeGrid(ctx, g, pos);

      if (!this._rollTimeline || !this._rollTimeline.length) return;
      const frameDur = this._rollTimeline.frameDur || (1 / 60);

      // track.notesはstartSec昇順(buildNoteTimelineFromChannelFrames参照)なので、
      // 「もう鍵盤側へ流れ去った(endSec<=pos)」ノートを読み飛ばす起点を
      // trackごとにキャッシュし、次フレームはそこから再開する(巻き戻り時は上でリセット済み)。
      // 曲が長い/ノート数が多いほど毎フレーム全ノート走査のコストが線形に効いてくるため、
      // 未再生ノートだけを毎フレーム定数時間で拾えるようにする最適化(文字数の多いMMLで
      // ピアノロールがカクつく問題の対策)
      // スポットライト(案D): 注目chがあるときは他chを減光し、注目chは最後=最前面に描く
      // (ノートは不透明塗りなので、描画順が後のchが必ず勝つ。並べ替えないと注目chが
      // 他chに上書きされて「注目しているのに見えない」ことがある)。
      const spotId = this._effectiveSpotlightId();
      const spotActive = !!spotId && this._rollTimeline.some(t => t.id === spotId);
      const liveColor = {};
      for (const c of (this._lastChannels || [])) if (c && c.id) liveColor[c.id] = c.color;
      const byCopy = (list) => list.filter(t => !t.laneCopy).concat(list.filter(t => t.laneCopy));
      const drawOrder = byCopy(spotActive
        ? this._rollTimeline.filter(t => t.id !== spotId).concat(this._rollTimeline.filter(t => t.id === spotId))
        : this._rollTimeline);

      for (const track of drawOrder) {
        if (!this._inLane(onlyId, track.id)) continue; // レーン表示: この区画の行のノートだけ
        // ミュート中のchは「消す」のではなくスポットライトと同じ減光で描く。
        // 消してしまうと、そのchが元々何も鳴っていないのか消しているのか区別できない
        const muted = this._isTrackMuted(track.id);
        const dimAlpha = (muted || (spotActive && track.id !== spotId)) ? SPOTLIGHT_DIM_ALPHA : 1;
        const notes = track.notes;
        let idx = this._rollCursor[track.id] || 0;
        if (idx > notes.length) idx = notes.length;
        while (idx < notes.length && notes[idx].endSec <= pos) idx++;
        this._rollCursor[track.id] = idx;
        for (let i = idx; i < notes.length; i++) {
          const note = notes[i];
          if (note.startSec >= winEnd) break; // 以降は全て未来のノート(startSec昇順のため打ち切れる)
          // 音量による濃淡はやめ、常にチャンネル本来の色をそのまま(不透明・フィルタ無し)で描く。
          const noteColor = this._getColor(track.id, liveColor[track.id] || track.color);
          const isDrum = note.drumLane !== undefined;
          let pLo, pSize;
          if (isDrum) {
            // ドラム区画の打点。レーン=どのサンプルか、レーン内の分割=同時発音の横並び
            if (note.drumLane >= nDrum) continue; // レーン表より後に来たタイムライン(再構築待ち)
            const d = drumLaneX(note.drumLane, note.drumSub, note.drumSubN, g.drumLaneW);
            const x0 = d.x - offPx;
            if (x0 + d.size < 0 || x0 > g.pitchLen) continue;
            pLo = x0 + 1;
            pSize = Math.max(2, d.size - 2);
          } else {
            const keyPos = keyX(note.midi, wkW);
            if (!keyPos) continue;
            keyPos.x += pitchOff;
            if (keyPos.x + wkW < 0 || keyPos.x - wkW > g.pitchLen) continue; // 音程窓の外
            // 音程軸: 白鍵は境界線1px内側、黒鍵はレーン幅いっぱい
            pLo = keyPos.isBlack ? keyPos.x - bkW / 2 : keyPos.x + 0.5;
            pSize = keyPos.isBlack ? bkW : (wkW - 1);
          }
          const relEnd = Math.min(windowSec, note.endSec - pos);
          const relStart = Math.max(0, note.startSec - pos);
          // 時間軸: 最低2pxは見えるようにする
          const r = g.rect(pLo, pSize, g.tPx(relStart), g.tPx(relEnd), 2);
          ctx.globalAlpha = dimAlpha;
          if (isDrum) {
            // 塗り=サンプル(どの太鼓か) / 枠線=チャンネル(どのスロットが鳴らしたか)の二重符号化。
            // プール式チップでは同じ太鼓が毎回別スロットへ移るので、色をchに割り当てると
            // 太鼓の色が踊る。塗りをサンプル側に固定するとその問題が出ない。
            const laneInfo = this._drumLanes[note.drumLane];
            ctx.fillStyle = (laneInfo && laneInfo.color) || DRUM_OTHER_COLOR;
            ctx.fillRect(r.x, r.y, r.w, r.h);
            if (r.w > 3 && r.h > 3) {
              ctx.strokeStyle = noteColor;
              ctx.lineWidth = 1.5;
              ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5);
            }
            ctx.globalAlpha = 1;
            continue; // ドラムの打点にセント偏差オーバーレイは無い(音程を持たないため)
          }
          if (track.laneCopy) {
            // 複製パート(デチューン二重化/エコー。src/convert/poolDoubles.js)は元トラックと同じ区画へ
            // 点線の枠だけで重ねる(元の音符と見分けが付き、かつ元を隠さない)
            ctx.strokeStyle = noteColor;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 2]);
            ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
            ctx.setLineDash([]);
          } else {
            ctx.fillStyle = noteColor;
            ctx.fillRect(r.x, r.y, r.w, r.h);
          }

          // セント偏差オーバーレイ(DESIGN-PITCH.md Phase 0): freqSeq(ノート区間内フレーム毎の
          // 生周波数)を丸め後noteの理論周波数と比較し、音程軸方向のズレとして細線描画する。
          // 「±100セント=±1鍵盤幅」を音程軸オフセット(wkW基準)として表現する。
          if (this._showCentsOverlay && note.freqSeq && note.freqSeq.length) {
            const idealFreq = midiToFreq(note.midi);
            const centerP = pLo + pSize / 2;
            ctx.beginPath();
            let started = false;
            for (let k = 0; k < note.freqSeq.length; k++) {
              const freq = note.freqSeq[k];
              if (!freq || freq <= 0) continue;
              const tAbs = note.startSec + k * frameDur;
              if (tAbs < pos || tAbs > winEnd) continue;
              const cents = 1200 * Math.log2(freq / idealFreq);
              const pt = g.point(centerP + (cents / 100) * wkW, g.tPx(tAbs - pos));
              if (!started) { ctx.moveTo(pt.x, pt.y); started = true; } else { ctx.lineTo(pt.x, pt.y); }
            }
            if (started) {
              ctx.strokeStyle = overlayLineColor(noteColor);
              ctx.lineWidth = 1;
              ctx.stroke();
            }
          }
          ctx.globalAlpha = 1;
        }
      }

      // *2MML変換の音程検証で見つかった不一致箇所(setConversionDiffs)を赤枠で重ね描きする。
      // 塗り(gotMidi=実際に鳴る高さ)と枠(expectedMidi=元の高さ)の両方を示す。
      // 時間軸はソースの秒(ロールと同じ)なのでそのまま描ける。
      if (this._conversionDiffs && onlyId === null) {
        for (const d of this._conversionDiffs) {
          if (d.endSec <= pos || d.sec >= winEnd) continue;
          const relStart = Math.max(0, d.sec - pos);
          const relEnd = Math.min(windowSec, d.endSec - pos);
          for (const [midi, fill] of [[d.gotMidi, true], [d.expectedMidi, false]]) {
            const keyPos = keyX(midi, wkW);
            if (!keyPos) continue;
            keyPos.x += pitchOff;
            if (keyPos.x + wkW < 0 || keyPos.x - wkW > g.pitchLen) continue;
            const pLo = keyPos.isBlack ? keyPos.x - bkW / 2 : keyPos.x + 0.5;
            const pSize = keyPos.isBlack ? bkW : (wkW - 1);
            const r = g.rect(pLo, pSize, g.tPx(relStart), g.tPx(relEnd), 2);
            if (fill) {
              ctx.fillStyle = 'rgba(255,40,40,0.35)';
              ctx.fillRect(r.x, r.y, r.w, r.h);
            }
            ctx.strokeStyle = '#ff2828';
            ctx.lineWidth = fill ? 2 : 1;
            if (!fill) ctx.setLineDash([3, 3]);
            ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
            ctx.setLineDash([]);
          }
        }
      }
    }

    // ── SPC ボイス行 DOM構築 ─────────────────────────────────────
    // mute,ch,L,R,vol,env,wave,PM,note,freq,echo,echoL,echoR,C0-C7 の列を持つ。
    // echoL/echoR/C0-C7 はチャンネル単位のレジスタが存在しないため常に空欄
    // （ALL行のみそこにマスター値を表示する）。
    _buildSpcRow(v, idx) {
      const row = document.createElement('div');
      const rowColor = this._getColor(v.label, v.color);
      const plan = channelPlan();
      // SPCのボイスは元々パート文字を持たない(getPartLetterが空を返す)。既定の借用先は
      // main.jsが setDefaults() で与える(V0→A、V1→B、V2→C、V3→D、V4-7→スキップ)。
      const defaultTarget = plan ? plan.defaultTarget(v.label, 'skip') : 'skip';
      const ent = plan ? (plan.get(v.label) || {}) : {};
      const target = ent.target || defaultTarget;
      const letter = plan ? plan.letterOfTarget(target) : '';
      row.className = 'kbd-ch-row';
      row.innerHTML =
        `<span class="kbd-dot" style="background:${rowColor}"></span>` +
        partChipHtml({ id: v.label, letter, target }) +
        `<input type="checkbox" class="kbd-mute" checked title="${T('{ch} ミュート', { ch: v.label })}">` +
        `<span class="kbd-name">${v.label}</span>` +
        assignCellHtml({ id: v.label }) +
        `<span class="kbds-lr kbds-l"></span>` +
        `<span class="kbds-lr"></span>` +
        `<span class="kbd-vol-num">0</span>` +
        `<span class="kbd-vol-wrap">` +
          `<span class="kbd-vol-bar" style="background:transparent"></span>` +
          `<input type="range" class="kbd-vol-slider" min="0" max="200" step="1" value="${Math.round((this._spcVoiceVolumes[idx] ?? 1) * 100)}" title="${T('{ch} 音量(中央100%・ダブルクリックで100%)', { ch: v.label })}">` +
          `<span class="kbd-vol-tooltip"></span>` +
        `</span>` +
        `<span class="kbds-env"><canvas class="kbds-env-canvas" width="34" height="16"></canvas><span class="kbds-env-text"></span></span>` +
        `<canvas class="kbd-wave" width="68" height="28"></canvas>` +
        `<span class="kbds-pm">-</span>` +
        `<span class="kbd-note">—</span>` +
        `<span class="kbds-freq"></span>` +
        `<span class="kbds-echo">-</span>`;

      const checkbox = row.querySelector('.kbd-mute');
      checkbox.addEventListener('change', () => {
        if (this.onSpcMuteChange) this.onSpcMuteChange(idx, !checkbox.checked);
        this._renderMuteAllBtn(); // 見出しの一括ミュートボタンの状態を追随させる
        this._notifyPreview();
      });
      this._attachSpcVolumeSlider(row, idx);

      // 波形アイコンをクリックで大波形表示に選択（NSF側と同じ挙動）
      const waveCanvas = row.querySelector('.kbd-wave');
      const chId = v.label;
      waveCanvas.classList.add('kbd-wave--clickable');
      if (chId === this._shownWaveId) waveCanvas.classList.add('kbd-wave--selected');
      waveCanvas.addEventListener('click', () => {
        this._selectWave(chId);
        this._setSpotlightHover(chId); // NSF側と同じく、選んだ直後にロールもピックアップ
      });

      // 丸のクリックで色ピッカーを開く
      this._attachColorPicker(row.querySelector('.kbd-dot'), v.label, v.color);
      // チャンネル割当(part列チップ + 割当表示ONのときのセレクト)
      this._wireAssign(row, { id: v.label, target: target });
      // スポットライト(案D): メイン一覧と同じ操作をSPCボイス行にも付ける
      this._attachSpotlight(row, v.label);

      const lrEls = row.querySelectorAll('.kbds-lr');
      return {
        id: v.label,
        row,
        partEl: row.querySelector('.kbd-part'),
        targetSel: row.querySelector('.kbd-assign-target'),
        toneSel: row.querySelector('.kbd-assign-tone'),
        // ★「パッド」ボタン(_syncAssignSelects が target===dpcm のとき表示する)。NSF側の行(_rowEls)には
        //   あったがSPCボイス行では参照を持っておらず、Eを選んでもボタンが出なかった(2026-09-07修正)
        drumBtn: row.querySelector('.kbd-assign-drum'),
        tonesBtn: row.querySelector('.kbd-assign-tones'),
        plainEl: row.querySelector('.kbd-assign-plain'),
        defaultTarget,
        target,
        letter,
        volBar: row.querySelector('.kbd-vol-bar'),
        volNum: row.querySelector('.kbd-vol-num'),
        lEl: lrEls[0], rEl: lrEls[1],
        envCanvas: row.querySelector('.kbds-env-canvas'),
        envText: row.querySelector('.kbds-env-text'),
        waveCanvas,
        waveSig: '',
        waveOn: false,
        pmEl: row.querySelector('.kbds-pm'),
        noteEl: row.querySelector('.kbd-note'),
        freqEl: row.querySelector('.kbds-freq'),
        echoEl: row.querySelector('.kbds-echo'),
        checkbox,
        color: rowColor,
        defaultColor: v.color,
      };
    }

    // ALL行: L・R にマスター音量($0C/$1C)。それより右(vol以降)はボイス単位の値が無いので、
    // 1つのセル(.kbds-master)にエコー音量L/R($2C/$3C)とFIRフィルタ係数C0-C7をまとめて表示する
    // (以前は echoL/echoR/C0-C7 を独立した列にしていたが、ALL行以外は常に空欄で幅ばかり
    // 食っていたため、一覧幅を他フォーマット並みに収める目的で1セルにした)。
    _buildSpcAllRow() {
      const row = document.createElement('div');
      row.className = 'kbd-ch-row kbds-all-row';
      row.innerHTML =
        `<span class="kbd-dot" style="background:#888"></span>` +
        `<span class="kbd-part"></span>` +
        `<span class="kbd-mute-ph"></span>` +
        `<span class="kbd-name">ALL</span>` +
        `<span class="kbd-assign"></span>` +
        `<span class="kbds-lr kbds-l"></span>` +
        `<span class="kbds-lr"></span>` +
        `<span class="kbds-master" title="echo L/R = ${'$'}2C/${'$'}3C, FIR = C0..C7"></span>`;
      const lrEls = row.querySelectorAll('.kbds-lr');
      return {
        row,
        lEl: lrEls[0], rEl: lrEls[1],
        masterEl: row.querySelector('.kbds-master'),
      };
    }

    // ── SPC ボイス同期 ────────────────────────────────────────────
    // voices: [{label:'V0', freq:Hz, vol:0-1, rawVol:0-0x7FF, active:bool, muted:bool,
    //   color:'hsl(...)', wave:{t:'wave',data,layers,nx,ny}|null, env:{mode,...},
    //   volL, volR, pmOn, noiseOn, echoOn}] × 8
    // master: { volL, volR, echoL, echoR, fir:[C0..C7] } — ALL行用のマスター値。
    // posSeconds: 現在の再生位置(秒)。ピアノロールの先読み描画位置に使う。
    updateSpcVoices(voices, master, posSeconds) {
      this._spcVoices = voices || [];
      this._prevSpcVoices = this._spcVoices.map(v => ({
        id: v.label, color: v.color, freq: v.freq, vol: v.vol, active: v.active, wave: v.wave,
      }));
      const anyActive = this._spcVoices.some(v => v.active);

      // ALL行は初回のみ構築（内容は毎回更新）。見出しは理屈上はALL行含む全体に
      // かかるべきだが、見た目はALL行をヘッダ扱いにしたいのでALLとV0の間に置く。
      if (!this._spcAllRow) {
        this._spcSectionEl.innerHTML = '';
        this._spcAllRow = this._buildSpcAllRow();
        this._spcSectionEl.appendChild(this._spcAllRow.row);
        const chipHeader = document.createElement('div');
        chipHeader.className = 'kbd-chip-header';
        chipHeader.textContent = 'SPC700 (Super Famicom / Super Nintendo Entertainment System)';
        this._spcSectionEl.appendChild(chipHeader);
      }

      // 行数が変化した場合だけ per-voice 行を再構築（通常は初回の8行のみ。ALL行は保持）
      const spcRowsChanged = this._spcRowEls.length !== this._spcVoices.length;
      if (spcRowsChanged) {
        for (const el of this._spcRowEls) el.row.remove();
        this._spcRowEls = this._spcVoices.map((v, idx) => {
          const el = this._buildSpcRow(v, idx);
          this._spcSectionEl.appendChild(el.row);
          return el;
        });
        this._refreshAssignUi(); // part列の文字・スキップ減光・重複警告を新しい行へ反映
        this._renderMuteAllBtn();
        this._applySpotlightClasses(); // 固定中のスポットライトの目印を新しい行へ復元
      }
      // 大波形に表示するボイスを新しい一覧に合わせる(選択がSPCボイス以外ならV0を一時表示)。
      // ★SPCのボイス数は常に8で固定のため、reset()でファイルを読み込み直しても行の再構築
      // (spcRowsChanged)自体は2回目以降起きない。ファイル読み込み直し直後の選択判定
      // (_consumePendingSelectionReset)は行の再構築有無に関わらずここで必ず試みる必要がある
      if (this._mode === 'spc' && this._spcVoices.length) {
        const hadPending = this._pendingSelectionReset;
        this._consumePendingSelectionReset(this._spcRowEls.filter(el => el.waveCanvas).map(el => el.id));
        if (spcRowsChanged || hadPending) {
          this._syncShownWave(this._spcRowEls);
          this._rebuildLanes(); // チャンネルごとのレーン表示もボイス一覧に合わせる
        }
      }

      // ALL行データ更新（マスター音量・エコー音量・FIRフィルタ、各 -128〜127）
      if (master && this._spcAllRow) {
        const a = this._spcAllRow;
        a.lEl.textContent = String(master.volL);
        a.rEl.textContent = String(master.volR);
        const fir = (master.fir || []).map(v => String(v)).join(' ');
        const txt = `echo ${master.echoL}/${master.echoR}  FIR ${fir}`;
        if (a.masterEl.textContent !== txt) a.masterEl.textContent = txt;
      }

      // 各ボイス行データ更新
      for (let i = 0; i < this._spcVoices.length && i < this._spcRowEls.length; i++) {
        const v  = this._spcVoices[i];
        const el = this._spcRowEls[i];
        const muted = v.muted !== undefined ? v.muted : !el.checkbox.checked;
        el.checkbox.checked = !muted; // ボイスモニター側のMUTEボタンとも同期

        // L/R: ステレオパンレジスタ（-128〜127、発声状態に関わらず常時表示）
        el.lEl.textContent = v.volL !== undefined ? String(v.volL) : '';
        el.rEl.textContent = v.volR !== undefined ? String(v.volR) : '';

        const showVol = v.active && !muted;
        const pct = showVol ? Math.round(v.vol * 100) : 0;
        el.volBar.style.width      = pct + '%';
        el.volBar.style.background = pct > 0 ? el.color : 'transparent';
        el.volNum.textContent = (showVol && v.rawVol !== null && v.rawVol !== undefined)
          ? String(v.rawVol) : '';
        el.volNum.style.color = showVol ? '#e6e6ef' : '#555566';

        // env列: ADSRモードは簡易グラフアイコン、GAINモードはモード名+数値のテキスト
        if (v.env && v.env.mode === 'adsr') {
          el.envCanvas.style.display = '';
          el.envText.style.display = 'none';
          el.envCanvas.title = `ADSR AR=${v.env.ar} DR=${v.env.dr} SL=${v.env.sl} SR=${v.env.sr}`;
          drawEnvIcon(el.envCanvas, v.env, el.color, showVol);
        } else if (v.env) {
          el.envCanvas.style.display = 'none';
          el.envText.style.display = '';
          // 表示は略号のみ（D/LD/E/LA/BA）、正式名はtitle属性のツールチップで示す
          const GAIN_KIND = {
            direct:  { abbr: 'D',  full: 'direct' },
            lindec:  { abbr: 'LD', full: 'linear decay' },
            exp:     { abbr: 'E',  full: 'exponential' },
            linatk:  { abbr: 'LA', full: 'linear attack' },
            bentatk: { abbr: 'BA', full: 'bent attack' },
          }[v.env.kind] || { abbr: v.env.kind, full: v.env.kind };
          el.envText.textContent = `${GAIN_KIND.abbr} ${v.env.value}`;
          el.envText.title = `${GAIN_KIND.full} ${v.env.value}`;
          el.envText.style.color = showVol ? '#cfcfe0' : '#555566';
        }

        // 素波形アイコン: 発声中のみ更新（NSF側と同じく発声→停止の遷移時のみ暗色で描き直す）
        const waveOn = v.active && !muted;
        if (waveOn || el.waveOn !== waveOn) {
          const wsig = waveSig(v.wave, waveOn);
          if (wsig !== el.waveSig) {
            el.waveSig = wsig;
            drawWaveIcon(el.waveCanvas, v.wave, el.color, waveOn);
          }
          el.waveOn = waveOn;
        }

        // PM列: $2Dのビットでon/off
        el.pmEl.textContent = v.pmOn ? 'on' : '-';
        el.pmEl.style.color = v.pmOn ? el.color : '#555566';

        // echo列: $4Dのビットが立っていれば $7D(EDL)下位4bitから求めたエコーディレイ時間を表示
        el.echoEl.textContent = v.echoOn ? `${v.echoDelayMs}ms` : '-';
        el.echoEl.style.color = v.echoOn ? '#e6e6ef' : '#555566';

        if (!showVol) {
          el.noteEl.textContent = muted ? '(M)' : '—';
          el.noteEl.style.color = '#555566';
          el.freqEl.textContent = '';
        } else {
          const midi = freqToMidi(v.freq);
          if (midi !== null) {
            el.noteEl.textContent = midiToName(midi);
            el.freqEl.textContent = v.freq.toFixed(1) + ' Hz';
          } else {
            const any = freqToMidiAny(v.freq);
            el.noteEl.textContent = any !== null ? midiToName(any) : (v.freq > 0 ? '??' : '—');
            if (any !== null) el.noteEl.style.color = '#9a9ab0';
            el.freqEl.textContent = v.freq > 0 ? v.freq.toFixed(1) + ' Hz' : '';
          }
          // $3Dでノイズ発声中のchはnote列を黄色で強調
          el.noteEl.style.color = v.noiseOn ? '#ffcc44' : '#e6e6ef';
        }
      }

      // 選択チャンネルの大波形を更新
      if (this._shownWaveId) {
        const sel = this._prevSpcVoices.find(c => c.id === this._shownWaveId);
        if (sel) this._renderBigWave(sel);
      }

      // ピアノを即時再描画（SPC のみ再生中も更新）
      if (anyActive) {
        const snap = this._state && this._state.regSnapshots
          ? (this._state.regSnapshots[0] || {}) : {};
        const nesChannels = (this._state
          ? extractChannels(snap, this._extraSnaps, 0, this._chips)
          : []).map(c => ({ ...c, color: this._getColor(c.id, c.color) }));
        const spcCh = this._spcVoices.map(v => ({
          id: v.label, color: this._getColor(v.label, v.color), freq: v.freq, vol: v.vol,
          active: v.active, rawVol: null, rawVolMax: null,
        }));
        // ★SPC再生中のピアノを描くのは update() ではなく**ここ**(上の分岐参照)。
        //   _applyPadKeys を通さないと drumKey が付かず、E(DPCM)指定したボイスの打点が
        //   ドラム区画のパッドではなく音程鍵盤側で光る(2026-09-18のユーザー報告)。
        const allChannels = nesChannels.concat(spcCh);
        this._applyPadKeys(allChannels, posSeconds || 0);
        this._lastPianoChannels = allChannels;
        this._drawPianos(allChannels);
      }

      if (this._mode === 'spc') this._renderRoll(posSeconds || 0);
    }

    // SPCはNSF/MML/KSSと違いupdate()(=rAFのmonitorLoopから毎フレーム呼ばれる)を経由せず、
    // updateSpcVoices()が専用の80ms setInterval(ボイス詳細UIの更新にはこれで十分)からしか
    // 呼ばれない設計のため、ロールの再描画までそれに引きずられて12.5fps相当になり、
    // NSF/KSS(rAF=約60fps)と比べて明らかにカクカクして見えていた(2026-07-18、ユーザー報告)。
    // ボイス詳細表示は変えずに、ロールの再描画だけ切り離してrAF頻度で呼べるようにする軽量メソッド。
    updateRollPosition(posSeconds) {
      this._renderRoll(posSeconds);
    }

  }

  // regSnapshots形式からピアノロールのトラック配列を構築する(KeyboardDisplayの
  // 同名メソッドの実体。this非依存の純粋関数なので、キャプチャWorkerバンドル
  // (NSF/VGMのロール構築オフスレッド化)からも直接呼べるようモジュールレベルに置く。
  // 詳細コメントはKeyboardDisplay.setRollTimelineFromRegSnapshots参照)。
  // DPCMの発声タイムライン(writeLogから)。フレームごとに
  //   seq[f] … キーオン通番の累計($4015 bit4書込みを1トリガーと数える。nsf2mml extractDmcTriggers と同じ)
  //   end[f] … いま鳴っているサンプルが鳴り終わるフレーム(ループなら Infinity、鳴っていなければ 0)
  // を返す。★$4015 のbit4は「最後に書かれた値」なので、それだけを見るとサンプルが鳴り終わっても
  // 次のトリガー/停止書込みまで発声中に見える(ロールの棒が実発声より長く伸びていた)。
  // 実機DMCは $4013 の長さ(len*16+1 バイト×8bit)を $4010 のレート(CPUクロック÷周期)で
  // 読み切ったら止まる(bit6のループ時は再開)ので、それを計算して発声の終わりにする。
  // 再生中の再トリガー(bytesRemaining>0 のときの bit4 書込み)は実機では無視されるので、
  // 終了時刻の更新も「鳴り終わってからのトリガー」だけにする(通番は従来どおり全部数える)。
  function buildDmcTimeline(wl, totalFrames, frameDur) {
    const seq = new Int32Array(totalFrames);
    const end = new Float64Array(totalFrames);
    let n = 0, curEnd = 0;
    let rateIdx = 0, loop = false, lenReg = 0;
    for (let f = 0; f < totalFrames; f++) {
      for (const w of (wl[f] || [])) {
        if (w.addr === 0x4010) { rateIdx = w.value & 0x0F; loop = !!(w.value & 0x40); }
        else if (w.addr === 0x4013) lenReg = w.value & 0xFF;
        else if (w.addr === 0x4015) {
          if (w.value & 0x10) {
            n++;
            if (f >= curEnd) {
              const bytes = lenReg * 16 + 1;
              const rateHz = CPU_CLOCK / DMC_RATE[rateIdx];
              curEnd = loop ? Infinity : f + (bytes * 8 / rateHz) / frameDur;
            }
          } else {
            curEnd = 0; // bit4クリア=停止
          }
        }
      }
      seq[f] = n;
      end[f] = curEnd;
    }
    return { seq, end };
  }

  function buildRollTracksFromRegSnapshotsPure(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots, extra) {
    if (!regSnapshots || totalFrames <= 0) return null;
    const wl = writeLog || [];
    const frameDur = samplesPerFrame / sampleRate;
    const dmcTl = buildDmcTimeline(wl, totalFrames, frameDur);
    const extraSnaps = Object.assign({}, extra || {}, {
      dmcSeq: dmcTl.seq, dmcEnd: dmcTl.end,
      vrc7: chips.includes('vrc7') ? buildVrc7Snapshots(wl) : null,
      n163: chips.includes('n163')
        ? (n163Snapshots && n163Snapshots.length ? buildN163SnapshotsFromLiveRam(n163Snapshots) : buildN163Snapshots(wl))
        : null,
      fme7: chips.includes('fme7') ? buildFme7Snapshots(wl) : null,
    });
    // extra.tuningCents(#TUNING、verify.js): 構築の間だけ音名の丸め基準をずらす(呼び出し元は
    // 変換中のメインスレッドで、鍵盤が別ファイルを表示中かもしれないので必ず元へ戻す)
    const prevTuning = rollTuningCents;
    if (extra && extra.tuningCents != null) rollTuningCents = +extra.tuningCents || 0;
    try {
      return buildNoteTimelineFromChannelFrames(
        (f) => extractChannels(regSnapshots[f] || {}, extraSnaps, f, chips),
        totalFrames, frameDur
      );
    } finally { rollTuningCents = prevTuning; }
  }

  UI.KeyboardDisplay = KeyboardDisplay;
  UI.buildRollTracksFromRegSnapshots = buildRollTracksFromRegSnapshotsPure; // roll-builders.js(Worker)用
  UI.midiToNoteName = midiToName; // main.js(ADPCM手動キャリブレーションのプロンプト表示)用
})(globalThis);

/*
 * *2MML 変換設定(コマンド使用/不使用・譜面整形)の共通定義
 *
 * 目的(2026-08-24): 熟練者が「ほぼ音階だけのプレーンな譜面」から自分で編曲を始められる
 * ように、各 *2mml がセント単位の補正コマンド(D/EP/MP/PT/EN)や音量エンベロープ(@v等)を
 * 出す/出さないを選べるようにする。全6形式(nsf/spc/kss/gbs/hes/vgm)で共通の1つの
 * オブジェクト options.cmd を受け取り、
 *   (1) 割当層(EnvelopeRegistry/PitchEnvelopeRegistry/NoteEnvelopeRegistry/detune.js)で
 *       登録自体を止める(→ ヘッダの @v/@EP/@MP/@EN テーブル定義も自然に消える)
 *   (2) 出力層(mmlEmit.js emitScore/emitChannel)でチャンネルフラグをANDマスクする(安全網)
 *   (3) 譜面整形(短い休符の吸収)を emitScore 手前のイベント整形で行う
 * の3段で効かせる。
 * これとは別に、音符の区切り方(NOTE_END、下記)は各 *2mml が emitScore の直前に
 * MML.Convert.applyNoteEnd(src/convert/envelope.js)を呼んで効かせる
 * (エンベロープ表の登録先が要るため emitScore 内では行えない)。
 *
 * cmd の各キー(全て boolean。省略時は true = 従来通り忠実再現):
 *   D      … D<n>(チャンネル/チップ間デチューン、detune.js)
 *   EP     … EP<n>(ピッチエンベロープ。MP/PT の受け皿でもある)
 *   MP     … MP<n>(ビブラート)。falseで EP が true なら周期EPテーブルへ落ちる
 *   PT     … PT<n>(ポルタメント)。falseで EP が true なら非ループEPテーブルへ落ちる
 *   EN     … EN<n>(高速アルペジオのノートエンベロープ)。false時はアルペジオ統合
 *            (mergeRapidArpeggio)自体は行い、基音1音として出す(音符連打には戻さない。
 *            編曲の出発点としては1音の方が読みやすいため)
 *   ENV    … @v/@vr(ソフト/ハード音量エンベロープ)と FME7 の S/M。false時は各イベントの
 *            音量列のピーク値を v<n> として出す(MML.Convert.plainVolume)
 *   V      … v<n>(音量そのもの)。false なら v も出さず既定音量
 *   SWEEP  … s<speed>,<depth>(2A03ハードウェアスイープ)
 *   INST   … @<n>(音色/デューティ)、OP<n>(VRC7音色)、MH<n>(FDS変調)、N<n>(FME7ノイズ周期)
 *   DRUM   … VGMのサンプルPCM(C140/C352/QSound/MultiPCM/SegaPCM/GA20/OKIM6295/YM2610
 *            ADPCM-A)で音程が取れなかった発音=打楽器を、1本のドラムパートとして音符化する
 *            (サンプルごとに疑似音程を割り当てる。src/convert/drumMap.js)。falseなら従来
 *            どおり休符(ドラムはMMLに出ない)
 *
 * 譜面整形(既定 false = 従来通り。★近似=音が変わりうる整形はここに集める):
 *   GATE_APPROX … ゲートを揃える(2026-09-08、既定 true)。NOTE_END='next' のゲート候補に、キーオフ位置の
 *                 ずれが GATE_TOL フレーム以内の q<n> も許し、切り替えを重くしてチャンネルの大半を1つの
 *                 q で書く(休符や k<len> の細切れを出さない)。レガートと長い無音は切らない。false なら
 *                 厳密一致のゲートだけ(以前の挙動)
 *   GATE_TOL    … その許容フレーム数(0〜8、既定2)
 *   PART_ORDER/BARS_PER_LINE/BAR_ALIGN/CHANNEL_ORDER … 出力の書式(2026-09-08、本ファイル LAYOUT_DEFAULTS
 *                 参照。プリセット外)。CHANNEL_ORDER='letter' はアルファベット順(既定)、'source' は
 *                 変換元の割り当て順(各 *2mml が積んだ順=元の音源のチャンネル順)
 *   LEN_SNAP    … 音長を丸める(2026-09-08、既定2フレーム、0=厳密)。音符/休符の長さがこのフレーム数以内で
 *                 大きな音価に乗るならタイの列(4&2&8..&64.&192)にせず 1 個で書き、余りは次の音符へ持ち越す
 *                 (src/convert/duration.js framesToLengths の slackFrames。持ち越しは ±許容に収め、一致は持ち越し込みで
 *                 許容の2倍以内の最も近い音価。小節線から許容以内の音符は小節線で割らない)。ドライバのテンポが小数で音符長が
 *                 ±1〜2 フレーム揺れる曲(ppmck の t71 等)の譜面を素直にする。境界のずれは最大このフレーム数
 *   LEN_DP      … 音長をチャンネル全体で最適化する(2026-09-09、忠実再現=ON / プレーン譜面=OFF)。音符ごとに
 *                 直前の余りだけ見て最も近い音価を選ぶ greedy(framesToLengths)の代わりに、チャンネルの全イベント
 *                 列を見渡して「音価の書きにくさ+境界の位置ずれ(フレーム)²」の合計が最小の割り当てを動的計画法で
 *                 選ぶ(duration.js quantizeSeq)。速いテンポで 5,5,5,6 フレームと揺れる16分が `24..` に化ける、
 *                 3連8分の隣で持ち越しが逆向きに溜まり `16.` になる、を直す。境界のずれは常に LEN_SNAP 以内に
 *                 収める(greedy は持ち越しの超過を捨てて黙ってずれる)ので、格子に乗らない音符の多い実曲では
 *                 3連系やタイが少し増える。合成曲の往復テストで音長一致 91%→97%
 *   DPCM_EXACT  … 分割したDPCMの音長は丸めない(2026-09-09、既定 true)。DMC 1本の上限(4080バイト)を超える
 *                 打点は src/convert/drumHits.js がフレーム整数の区間へ分割し、区間ごとに @DPCM 定義と打点を
 *                 立てて連続再生する(ストリーム再生)。その区間の音長を LEN_SNAP/LEN_DP の丸めから外して
 *                 厳密に書く。丸めると区間の継ぎ目に空白/食い込みが出るため。false なら普通の音符と同じ扱い
 *   ENV_MERGE   … 似た @v 表を統合する(2026-09-08)。値の並び(段の値列)が同じで各段の長さが±1・全体長も
 *                 ±1以内の表を、最も多くの音符が参照する変種へ寄せる(EnvelopeRegistry.mergeSimilar)。
 *                 ドライバのエンベロープが自走タイマー(2.33フレーム周期等)で進む曲では段の位置が音符の
 *                 開始位相ごとに違い、同じ楽器でも 3,2,2 / 2,3,2 / 2,2,3 の変種が量産される。ppmck の
 *                 @v はフレーム毎の絶対値なので正確に1本にはできず、これは段の境目が最大1フレーム動く
 *                 近似(ハードウェア減衰表・exact 表は対象外)
 *   SHAPE_REST  … 音符の直後の短い休符(1/32未満)を音符に吸収(ゲートタイムの隙間除去)。
 *                 伸ばした区間は最後の音量のまま鳴るので近似
 *   FOLD_DOUBLES … 合成ch(プール式PCMの論理レーン。PSF/VGMのMultiPCM等)の複製パートを省く(2026-09-14、
 *                 忠実再現=OFF / プレーン譜面=ON)。ドライバが同じ旋律を別ボイスで重ねたデチューン二重化や
 *                 数フレーム遅れのエコーを src/convert/poolDoubles.js が検出し、複製側のノートを変換から外す
 *                 (ヘッダに何を省いたか書く)。OFF でも、N163 等の枠へ自動で載せるレーンを選ぶときは複製を後回しにする
 *   (旧 SHAPE_QUANT「16分音符格子へ丸める」は 2026-09-07 に廃止。キーオン自体が格子から
 *    外れている曲にしか効かず、丸めれば必ずタイミングが崩れるため。保存済み設定に残って
 *    いても読み捨てる)
 *
 * 音符の区切り(2026-09-07。細かい音長 `@v156 d+4&d+64.&d+192 r…` 対策):
 *   NOTE_END … 'next'(既定) | 'zero'
 *     抽出器は音量レジスタが0になった瞬間に音符を閉じるため、音長が「減衰が0に達した
 *     フレーム」というテンポ格子と無関係な値になる(同じ情報は @v 表にもあり二重表現)。
 *     'next' … 音符の直後の休符を音符に吸収して次の音符の頭まで伸ばす(音長=キーオン間隔)。
 *              無音区間は、減衰が自然に0へ到達した@v付き音符なら @v表の末尾に 0 を1つ足して
 *              (コンパイラ stepEnvelope も NSF ドライバも末尾値を保持する)、それ以外は
 *              ゲートタイム q<n>/@q<n>(コンパイラはゲートオフを休符と同じに書く)で表す。
 *              どちらも再生結果は完全に同じ(タイミング不変の厳密な変形)
 *     'zero' … 従来どおり音量0で区切る(最も細かく、そのままの姿)
 *     詳細・対象外は envelope.js applyNoteEnd 冒頭コメント。
 *
 * 値キー(booleanでない設定。2026-08-26):
 *   PITCH_SA … N163出力のSA<num>(ピッチシフト量)自動選択。'octave' | 'note' | 'off'
 *     EP/MP/Dテーブル値のbyte幅とN163周波数レジスタ18bitの桁差を埋める(選び方の詳細は
 *     src/convert/pitch.js n163SaForBase冒頭コメント参照)。既定'octave'(オクターブ連動、
 *     セント精度がオクターブ非依存でテーブル共有も効く)。'note'=音符ごと最高精度、
 *     'off'=SA不使用(従来互換、深い変調は割当失敗して落ちる)。
 *   N163_CH … N163の実効チャンネル数(#EX-N163 <n> に書く値。'fixed8' | 'used')。
 *     実機N163は8chを時間多重するので、有効ch数を減らすと1chあたりの取り分が増える。
 *     ★1つ動かすと3つ同時に動く:
 *       波形RAM  … 128-8*ch数 バイト(1ch=120 / 8ch=64)。減らすほど大きい波形を置ける
 *       音量     … 出力は有効ch数で平均されるので、減らすほど同じ v が大きく鳴る(1chは5chの5倍)
 *       周波数   … freqReg ∝ ch数。減らすほどレジスタ値が小さくなり、音程の刻みは粗く、
 *                  出せる最高音は上がる(32サンプル波形で 8ch=1864Hz / 1ch=14915Hz)
 *     'fixed8'(既定) … 常に8ch。ch数で変わる値を固定で扱えるので、曲によって音量や音域が
 *       変わらない。波形RAMは64バイトに固定され、高い音は出しにくい。
 *     'used' … 割り当てたスロットのうち一番大きい番号を使う(ch1+ch8なら8、ch2+ch6なら6)。
 *       大きい波形を使いたい・音量を出したい・高い音を出したいときはこちら。
 *     ★nsf2mmlだけは対象外。元がN163のネイティブ変換で、実効ch数は元の曲が決めているため。
 *   N163_WAVE … 波形長を自動で縮めるかどうか。縮めると2つの制約が同時にゆるむ。
 *     (a) 内蔵RAM … 波形に使えるのは 128-8*有効ch数 バイトだけ
 *     (b) 音域   … freqReg = freq*15*65536*波形長*ch数/CPU が18bitを超える音は鳴らない
 *                  (32サンプル・8chなら a+6 が上限。波形を半分にすれば上限は1オクターブ上がる)
 *     'both'(既定) … (a)と(b)の両方に収まるように縮める。音域の詰め直しは「音域外の音符が
 *       実際に使っている @N」だけを対象にする(曲全体を一律に落とさない)。
 *     'fit' … (a)のRAMだけ見る(従来の既定)。音域外の音符はコンパイル時に警告付きで無音になる。
 *     'keep' … 何も縮めない。RAMに収まらない曲はコンパイルエラーで再生も書き出しもできないが、
 *       本家ppmckへ持って行って手で詰め直したい場合はこちら。
 *     ★どの場合も「あふれた瞬間に居る波形」を大きい順に必要な数だけ縮め、縮めたぶんは
 *       ヘッダコメントに明記する。同じ @N を他のチャンネルが使っていればそちらの音色も鈍くなる。
 *
 * DPCM(打楽器)キー(2026-09-05、変換設定ダイアログからドラム(DPCM)パネル最下段へ移動):
 *   DMC_RATE  … サンプルごとのDMCレート指定が「自動」のときに使うレート。DMCレート表
 *     (MML.Dpcm.DMC_RATE_TABLE_NTSC)のindex 0..15、既定15(33.1kHz)。1bitデルタ変調は
 *     1bitあたり±2/127しか動けないため、レートが追従能力(アタックのなまり)とアイドルトーン
 *     (平坦部で乗るレート/2のキーン音)を直接決める。音質とデータ量はレートに比例する。
 *     ★旧 PCM_RATE('max'|8|4|2|1=ソースレートの倍率方式)は廃止。サンプルPCMは再生レートが
 *       DMC上限以上のことが多く倍率方式が効かなかった。旧キーは読み捨てる(数値が衝突するため
 *       キー名を変えた)
 *   RATE_MIX  … 同時に鳴った打点のDMCレート指定が食い違うとき、'quality'=高い方 / 'size'=低い方
 *   DRUM_POLY … 打点が重なったとき 'mix'=その瞬間の音をミックスして1クリップ / 'mono'=直近1音
 *   これらはプリセット(忠実再現/プレーン譜面)の一致判定に含めない(パネル側の独立した設定)。
 *   全形式のドラム(DPCM)経路(src/convert/drumHits.js)が見る。
 *
 * 基準ピッチ(全体オフセット、2026-09-07。下の MML.Convert.detectTuning 冒頭コメント参照):
 *   TUNING     … 'auto'(既定) = 曲全体の音程偏差の中央値を測り、その分ずらした基準で音符へ丸めて
 *                `#TUNING <cent>` をヘッダに出す / 'a440' = 従来どおり A4=440Hz の12平均律固定
 *   TUNING_MIN … 'auto' のとき、測った偏差の絶対値がこのセント数未満なら何もしない(既定5、0〜50)。
 *                閾値未満の曲の出力は 'a440' と完全に同じ
 */
(function (global) {
  'use strict';
  const MML   = global.MML   = global.MML   || {};
  MML.Convert = MML.Convert || {};

  const CMD_KEYS = ['D', 'EP', 'MP', 'PT', 'EN', 'ENV', 'V', 'SWEEP', 'INST', 'DRUM'];
  const SHAPE_KEYS = ['SHAPE_REST', 'ENV_MERGE', 'GATE_APPROX', 'FOLD_DOUBLES'];
  // GATE_TOL: ゲートを揃える(GATE_APPROX)ときに許すキーオフ位置のずれ(フレーム、0〜8、既定2)
  const GATE_TOL_DEFAULT = 2, GATE_TOL_MAX = 8;
  MML.Convert.GATE_TOL_DEFAULT = GATE_TOL_DEFAULT;
  MML.Convert.GATE_TOL_MAX = GATE_TOL_MAX;
  // LEN_SNAP: 音長を丸める許容フレーム数(0=厳密(192分)、1〜4、既定2。src/convert/duration.js framesToLengths)
  const LEN_SNAP_DEFAULT = 2, LEN_SNAP_MAX = 4;
  MML.Convert.LEN_SNAP_DEFAULT = LEN_SNAP_DEFAULT;
  MML.Convert.LEN_SNAP_MAX = LEN_SNAP_MAX;
  MML.Convert.lenSnapOf = (cmd) => (cmd && cmd.LEN_SNAP > 0) ? Math.min(LEN_SNAP_MAX, cmd.LEN_SNAP) : 0;
  // LEN_DP: 音長をチャンネル全体で最適化する(2026-09-09、src/convert/duration.js quantizeSeq)。
  // 忠実再現プリセットは ON、プレーン譜面は OFF(格子に乗らない実曲では 3連系やタイが増えるため)
  MML.Convert.lenDpOf = (cmd) => !!(cmd && cmd.LEN_DP);
  // DPCM_EXACT: 分割したDPCM(ストリーム再生の区間、src/convert/drumHits.js)の音長を LEN_SNAP/LEN_DP の
  // 丸めから外して厳密に書く(2026-09-09、既定ON。省略時もON=未指定の古い設定と互換)。
  // 区間の長さがずれると継ぎ目に空白/食い込みが出るため
  MML.Convert.dpcmExactOf = (cmd) => !(cmd && cmd.DPCM_EXACT === false);

  // ── チャンネルの並び順(2026-09-09) ──────────────────────────────────────
  // 各 *2mml は scoreChannels へ「元の音源のチャンネル順」で積み、最後にレター順へ並べ替える。
  // その並べ替えで元の順を失わないよう、積んだ順を srcIndex として刻んでおく(CHANNEL_ORDER='source')。
  //   stampChannelSource … まだ刻まれていないものだけ現在の並びで採番(後から足した ch は末尾に続く)
  //   sortChannelsByLetter … 刻んでからレター順(各 *2mml の従来の sort を置き換える)
  //   orderChannels … 出力直前の並べ替え。配列は作り直すので呼び元の並びは変えない
  MML.Convert.stampChannelSource = function (channels) {
    let next = 0;
    for (const ch of channels || []) if (ch && ch.srcIndex != null && ch.srcIndex >= next) next = ch.srcIndex + 1;
    for (const ch of channels || []) if (ch && ch.srcIndex == null) ch.srcIndex = next++;
    return channels;
  };
  // チャンネル文字の比較は必ずコードポイント順(A-Z のあとに a,b)。
  // ★localeCompare は 'a' < 'B' と判定するので使わない: 実機ppmckの文字順は大文字A-Zのあとに
  //   小文字a,b(拡張音源のE-Zab)なのに、出力が aAbBCDEFG と大小交互に並んで音源ごとの
  //   まとまりが崩れていた(2026-09-10 ユーザー指摘)。同じ理由の前例が
  //   src/convert/channelPlan.js sortByLetter にある
  const byLetter = (a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0);
  MML.Convert.compareChannelLetter = byLetter;
  MML.Convert.sortChannelsByLetter = function (channels) {
    MML.Convert.stampChannelSource(channels);
    channels.sort(byLetter);
    return channels;
  };
  MML.Convert.orderChannels = function (channels, order) {
    const out = (channels || []).slice();
    MML.Convert.stampChannelSource(out);
    if (order === 'source') out.sort((a, b) => (a.srcIndex - b.srcIndex) || byLetter(a, b));
    else out.sort(byLetter);
    return out;
  };
  // 出力の書式(2026-09-08、src/convert/mmlEmit.js emitScore)。プリセットには含めない(内容でなく見た目)
  //   PART_ORDER    … 'block'=チャンネル順に BARS_PER_LINE 小節ずつ並べる / 'part'=パートごとに最後まで出してから次へ
  //   BARS_PER_LINE … 1行に入れる小節数(1〜16、既定4)
  //   BAR_ALIGN     … 小節の区切りを全パートで桁揃えする(false=スペース1つで区切る、既定)
  const PART_ORDER_VALUES = ['block', 'part'];
  const CHANNEL_ORDER_VALUES = ['letter', 'source'];
  const BARS_PER_LINE_MAX = 16;
  const LAYOUT_DEFAULTS = { PART_ORDER: 'block', BARS_PER_LINE: 4, BAR_ALIGN: false, CHANNEL_ORDER: 'letter' };
  const LAYOUT_KEYS = Object.keys(LAYOUT_DEFAULTS);
  MML.Convert.LAYOUT_DEFAULTS = LAYOUT_DEFAULTS;
  MML.Convert.LAYOUT_KEYS = LAYOUT_KEYS;
  MML.Convert.PART_ORDER_VALUES = PART_ORDER_VALUES;
  MML.Convert.CHANNEL_ORDER_VALUES = CHANNEL_ORDER_VALUES;
  MML.Convert.BARS_PER_LINE_MAX = BARS_PER_LINE_MAX;
  // 音符の区切り(冒頭コメント NOTE_END)
  const NOTE_END_VALUES = ['next', 'zero'];
  MML.Convert.NOTE_END_VALUES = NOTE_END_VALUES;
  const PITCH_SA_VALUES = ['octave', 'note', 'off'];
  // ── DPCM(打楽器)キー(冒頭コメント参照)。ドラム(DPCM)パネル最下段の設定 ──
  // DMC_RATE: DMCレート表のindex(0=4.2kHz … 15=33.1kHz)。「自動」のサンプルに使う
  const DMC_RATE_MAX = 15;
  // 同時発音をミックスして1サンプルに焼くときのDMCレートの決め方
  //   'quality' … 寄与するサンプルのうち高い方を採る(既定)
  //   'size'    … 低い方に合わせて容量を優先する
  const RATE_MIX_VALUES = ['quality', 'size'];
  MML.Convert.RATE_MIX_VALUES = RATE_MIX_VALUES;
  // 打楽器の同時発音の扱い(src/convert/drumHits.js poly)
  //   'mix'  … その瞬間に鳴っている打点をミックスして1クリップに焼く(既定、忠実)
  //   'mono' … ミックスしない。直近に叩かれた打点だけを鳴らす(定義がサンプル数までしか
  //            増えないので容量制御に使う。実測: NCS91002 はミックス54定義36KB→単音7定義)
  const DRUM_POLY_VALUES = ['mix', 'mono'];
  MML.Convert.DRUM_POLY_VALUES = DRUM_POLY_VALUES;
  // 基準ピッチ(冒頭コメント参照)
  const TUNING_VALUES = ['auto', 'a440'];
  MML.Convert.TUNING_VALUES = TUNING_VALUES;
  const TUNING_MIN_DEFAULT = 5, TUNING_MIN_MAX = 50;
  MML.Convert.TUNING_MIN_DEFAULT = TUNING_MIN_DEFAULT;
  MML.Convert.TUNING_MIN_MAX = TUNING_MIN_MAX;
  const DPCM_KEYS = ['DMC_RATE', 'RATE_MIX', 'DRUM_POLY'];
  const DPCM_DEFAULTS = { DMC_RATE: DMC_RATE_MAX, RATE_MIX: 'quality', DRUM_POLY: 'mix' };
  MML.Convert.DPCM_KEYS = DPCM_KEYS;
  MML.Convert.DPCM_DEFAULTS = DPCM_DEFAULTS;
  // N163内蔵RAMに波形が収まらないときの扱い(冒頭コメント参照)
  const N163_WAVE_VALUES = ['both', 'fit', 'keep'];
  MML.Convert.N163_WAVE_VALUES = N163_WAVE_VALUES;
  // N163の実効チャンネル数の決め方(冒頭コメント参照)
  const N163_CH_VALUES = ['fixed8', 'used'];
  MML.Convert.N163_CH_VALUES = N163_CH_VALUES;

  /**
   * 変換器が使うN163の実効チャンネル数。変換設定 N163_CH('fixed8' | 'used')で決まる。
   * 'used' は「使ったスロットのうち一番大きい番号+1」(ch1+ch8なら8、ch2+ch6なら6)。
   * ここで返した値を必ず (1) 周波数式 (2) n163Fitの波形RAM枠 (3) #EX-N163の宣言 の
   * 3か所すべてに使うこと。1つでも食い違うと音痴・音量差・波形あふれが起きる。
   * ★lexer.js ではなくここに置くのは、SPCの変換がキャプチャWorkerのバンドル内でも
   *   動くため(バンドルに入るのは src/convert/options.js。build-capture-workers.ps1 参照)。
   * @param {object} cmd normalizeCmd済みの変換設定
   * @param {number[]} usedIndexes 使ったN163スロット番号(0始まり)
   */
  MML.Convert.n163NumChFor = function (cmd, usedIndexes) {
    if (!cmd || cmd.N163_CH !== 'used') return 8;
    let n = 0;
    for (const i of (usedIndexes || [])) n = Math.max(n, (i | 0) + 1);
    return Math.max(1, Math.min(8, n));
  };

  MML.Convert.CMD_KEYS = CMD_KEYS;
  MML.Convert.SHAPE_KEYS = SHAPE_KEYS;
  MML.Convert.PITCH_SA_VALUES = PITCH_SA_VALUES;

  const PRESETS = {
    // 忠実再現(従来の既定)
    faithful: { D: true, EP: true, MP: true, PT: true, EN: true, ENV: true, V: true, SWEEP: true, INST: true, DRUM: true,
                SHAPE_REST: false, ENV_MERGE: false, FOLD_DOUBLES: false, GATE_APPROX: true, GATE_TOL: GATE_TOL_DEFAULT, LEN_SNAP: LEN_SNAP_DEFAULT, LEN_DP: true, DPCM_EXACT: true,
                NOTE_END: 'next', PITCH_SA: 'octave', N163_WAVE: 'both', N163_CH: 'fixed8',
                TUNING: 'auto', TUNING_MIN: TUNING_MIN_DEFAULT },
    // プレーン譜面: 音階+音色だけ。編曲の出発点用
    plain:    { D: false, EP: false, MP: false, PT: false, EN: false, ENV: false, V: false, SWEEP: false, INST: true, DRUM: true,
                SHAPE_REST: true, ENV_MERGE: false, FOLD_DOUBLES: true, GATE_APPROX: true, GATE_TOL: GATE_TOL_DEFAULT, LEN_SNAP: LEN_SNAP_DEFAULT, LEN_DP: false, DPCM_EXACT: true,
                NOTE_END: 'next', PITCH_SA: 'octave', N163_WAVE: 'both', N163_CH: 'fixed8',
                TUNING: 'auto', TUNING_MIN: TUNING_MIN_DEFAULT },
  };
  MML.Convert.CMD_PRESETS = PRESETS;

  // options.cmd(部分指定可)を全キー揃った正規形にする。省略キーは faithful 既定
  // (DPCMキーは DPCM_DEFAULTS)。
  MML.Convert.normalizeCmd = function (cmd) {
    const out = Object.assign({}, DPCM_DEFAULTS, LAYOUT_DEFAULTS, PRESETS.faithful);
    if (cmd && typeof cmd === 'object') {
      for (const k of [...CMD_KEYS, ...SHAPE_KEYS]) if (cmd[k] != null) out[k] = !!cmd[k];
      // 数値は文字列でも受ける(localStorage/JSON経由やUIのselect値が'14'等になるため)
      if (cmd.DMC_RATE != null) {
        const v = parseInt(cmd.DMC_RATE, 10);
        if (v >= 0 && v <= DMC_RATE_MAX) out.DMC_RATE = v;
      }
      if (cmd.PITCH_SA != null && PITCH_SA_VALUES.indexOf(cmd.PITCH_SA) >= 0) out.PITCH_SA = cmd.PITCH_SA;
      if (cmd.NOTE_END != null && NOTE_END_VALUES.indexOf(cmd.NOTE_END) >= 0) out.NOTE_END = cmd.NOTE_END;
      if (cmd.GATE_TOL != null) {
        const v = parseInt(cmd.GATE_TOL, 10);
        if (v >= 0 && v <= GATE_TOL_MAX) out.GATE_TOL = v;
      }
      if (cmd.LEN_SNAP != null) {
        const v = parseInt(cmd.LEN_SNAP, 10);
        if (v >= 0 && v <= LEN_SNAP_MAX) out.LEN_SNAP = v;
      }
      if (cmd.LEN_DP != null) out.LEN_DP = !!cmd.LEN_DP;
      if (cmd.DPCM_EXACT != null) out.DPCM_EXACT = !!cmd.DPCM_EXACT;
      if (cmd.PART_ORDER != null && PART_ORDER_VALUES.indexOf(cmd.PART_ORDER) >= 0) out.PART_ORDER = cmd.PART_ORDER;
      if (cmd.CHANNEL_ORDER != null && CHANNEL_ORDER_VALUES.indexOf(cmd.CHANNEL_ORDER) >= 0) out.CHANNEL_ORDER = cmd.CHANNEL_ORDER;
      if (cmd.BARS_PER_LINE != null) {
        const v = parseInt(cmd.BARS_PER_LINE, 10);
        if (v >= 1 && v <= BARS_PER_LINE_MAX) out.BARS_PER_LINE = v;
      }
      if (cmd.BAR_ALIGN != null) out.BAR_ALIGN = !!cmd.BAR_ALIGN;
      if (cmd.RATE_MIX != null && RATE_MIX_VALUES.indexOf(cmd.RATE_MIX) >= 0) out.RATE_MIX = cmd.RATE_MIX;
      if (cmd.DRUM_POLY != null && DRUM_POLY_VALUES.indexOf(cmd.DRUM_POLY) >= 0) out.DRUM_POLY = cmd.DRUM_POLY;
      if (cmd.N163_WAVE != null && N163_WAVE_VALUES.indexOf(cmd.N163_WAVE) >= 0) out.N163_WAVE = cmd.N163_WAVE;
      if (cmd.N163_CH != null && N163_CH_VALUES.indexOf(cmd.N163_CH) >= 0) out.N163_CH = cmd.N163_CH;
      if (cmd.TUNING != null && TUNING_VALUES.indexOf(cmd.TUNING) >= 0) out.TUNING = cmd.TUNING;
      if (cmd.TUNING_MIN != null) {
        const v = parseFloat(cmd.TUNING_MIN);
        if (v >= 0 && v <= TUNING_MIN_MAX) out.TUNING_MIN = v;
      }
    }
    return out;
  };

  // どれかがプリセットと完全一致すればその名前、無ければ 'custom'。
  // DPCMキー(DPCM_KEYS)はドラム(DPCM)パネル側の設定なので一致判定に含めない
  MML.Convert.cmdPresetName = function (cmd) {
    const n = MML.Convert.normalizeCmd(cmd);
    for (const name of Object.keys(PRESETS)) {
      const p = MML.Convert.normalizeCmd(PRESETS[name]);
      if ([...CMD_KEYS, ...SHAPE_KEYS, 'NOTE_END', 'GATE_TOL', 'LEN_SNAP', 'LEN_DP', 'DPCM_EXACT', 'PITCH_SA', 'N163_WAVE', 'N163_CH', 'TUNING', 'TUNING_MIN'].every(k => p[k] === n[k])) return name;
    }
    return 'custom';
  };

  // ── 基準ピッチ(全体オフセット、2026-09-07) ────────────────────────────
  // 「その曲は本当に A4=440Hz の12平均律で鳴っているのか」を先に測り、測った基準で音符へ丸める。
  // ゲーム曲は12平均律を狙って作られているが、ドライバ固有の音程表やクロック都合で曲全体が
  // 数十セントずれていることがある(実例: Gofer no Yabou II。kss2mml/converter.js の
  // detectChorusDetune 採用経緯を参照)。A440 基準のまま丸めると
  //   借用変換    : 全音符に無意味な D<n> が付く(applyPitchDetune の minCents=10 を常に超える)
  //   ネイティブ変換: 原曲より系統的にずれた音程で鳴る
  //   偏差±50付近 : 音符ごとに丸めの向きが変わり、同じ音が隣の半音へ転んだり戻ったりする
  // という壊れ方をする。対策は曲全体で1つのセント値(#TUNING)を持ち、抽出側の丸めと再生側
  // (compiler.js / ppmckDriver.js の周波数テーブル)の両方で同じ値を使うこと。音符の名前は
  // 変わらず(キー/トランスポーズとは別物)、鳴る周波数だけが全体にずれる。
  //
  //   tuningCents()          … 現在有効なオフセット(セント)。既定0。抽出器の丸め(freqToNote)と
  //                            detune.js / pitch.js の理論値計算が参照する
  //   withTuning(c, fn, info)… fn の間だけオフセットを c にする(同期処理専用。finally で戻す)
  //   freqToNote(freq)       … 周波数→ノート番号(o4a=57、0..119、範囲外は null)。全 *2mml 抽出器共通
  //   noteToFreq(note)       … 逆変換。オフセット込み=その音符が変換先で実際に鳴る周波数
  //   detectTuning(chs, o)   … 抽出結果(scoreChannels)から全体オフセットを推定
  //   autoTune(opts, run)    … 変換本体 run(opts) を走らせ、オフセットが閾値以上なら
  //                            そのオフセットで run をもう一度走らせて再量子化した結果を返す
  //   tuningHeaderLines()    … 出力MMLに入れる `#TUNING <cent>` 行(0なら空配列)
  //   tuningCommentLines()   … ヘッダコメント用の説明行(0なら空配列)
  //
  // ★抽出器(kss2mml/expansion 等)はキャプチャWorkerのバンドルにも入る。Worker 側では
  //   withTuning が呼ばれないので常に0=従来どおりの丸め(ロール表示は元ファイルの音程のまま)。
  let _tuning = { cents: 0, info: null };
  MML.Convert.tuningCents = function () { return _tuning.cents; };
  MML.Convert.withTuning = function (cents, fn, info) {
    const prev = _tuning;
    _tuning = { cents: +cents || 0, info: info || null };
    try { return fn(); } finally { _tuning = prev; }
  };
  MML.Convert.freqToNote = function (freq) {
    if (!(freq > 0)) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440) - _tuning.cents / 100);
    return (n >= 0 && n <= 119) ? n : null;
  };
  MML.Convert.noteToFreq = function (note) {
    return 440 * Math.pow(2, (note - 57) / 12 + _tuning.cents / 1200);
  };
  function fmtCents(c) {
    const s = (Math.round(c * 10) / 10).toFixed(1).replace(/\.0$/, '');
    return (c > 0 ? '+' : '') + s;
  }
  MML.Convert.formatTuningCents = fmtCents;
  MML.Convert.tuningHeaderLines = function () {
    return _tuning.cents ? [`#TUNING ${fmtCents(_tuning.cents)}`] : [];
  };
  MML.Convert.tuningCommentLines = function () {
    if (!_tuning.cents) return [];
    const hz = (440 * Math.pow(2, _tuning.cents / 1200)).toFixed(1);
    const info = _tuning.info;
    const stat = info && info.count ? `、音符${info.count}個の偏差中央値、四分位範囲${fmtCents(info.iqr).replace(/^\+/, '')}` : '';
    return [
      `; 基準ピッチ: A4=${hz}Hz (12平均律から ${fmtCents(_tuning.cents)} cent。自動検出${stat})`,
      `;   → #TUNING で再生側/NSF書き出しの周波数テーブルも同じだけずれます(音名はそのまま)`,
    ];
  };

  // 全体オフセットの推定。channels は各 *2mml が emitScore/verifyPitch に渡す scoreChannels
  // ({ letter, events:[{ start, end, note, rawFreq|freqHz }] })。
  //   - 各音符の「最寄り半音からのセント偏差」を音符の長さで重み付けし、その中央値を採る。
  //     レジスタの整数丸めによる偏差は音符ごとに±どちらにも出るので大量に集めると打ち消し合い、
  //     ドライバ固有の全体ずれだけが残る。平均でなく中央値なのはベンド/ビブラート中の外れ値に
  //     引っ張られないため
  //   - ノイズ(D)/DPCM(E)/ドラム/ノート番号が周期そのもののイベントは音程の意味が違うので除外
  //   - 四分位範囲が広い(opts.maxIqr、既定30セント)=曲全体がピッチ操作だらけ、または区間/チップで
  //     基準が二極化していて「全体ずれ」とは言えない場合と、音符が少なすぎる場合(opts.minCount、
  //     既定8)は 0(適用しない)。実測: HES NC62001 は中央値-33で四分位範囲40、適用すると10セント超の
  //     ずれの音符(=D<n>が付く音符)が110→204個に増えた(二極化の典型)
  //   - 適用後に「±10セント以内に乗る音符の割合」(fitAfter)が適用前(fitBefore)より明らかに
  //     下がるなら 0(上の二極化を中央値だけでは見抜けない場合の安全網)
  //   - |中央値| < opts.minCents(既定 TUNING_MIN_DEFAULT)なら 0
  // 戻り値 { cents, median, iqr, count, fitBefore, fitAfter, reason, byGroup }
  //   cents は適用値(0=適用しない)。reason は不適用の理由 'few'|'iqr'|'fit'|'below'(適用時は null)。
  //   byGroup はチャンネル文字の群(A-C=2A03, G-L=VRC7, P-W=N163, X-Z=FME7 …)ごとの中央値/音符数で、
  //   「OPLL と PSG で基準が違う」ような二極化をユーザーが読み取るための内訳(main.js renderTuning)
  MML.Convert.detectTuning = function (channels, opts) {
    opts = opts || {};
    const minCents = opts.minCents != null ? +opts.minCents : TUNING_MIN_DEFAULT;
    const maxIqr = opts.maxIqr != null ? opts.maxIqr : 30;
    const minCount = opts.minCount != null ? opts.minCount : 8;
    const samples = [];
    const groups = {}; // 群名 → [dev, w][]
    const groupOf = (L) => {
      if (!L) return '?';
      if (/^[A-C]$/.test(L)) return 'A-C';
      if (L === 'F') return 'F';
      if (/^[G-L]$/.test(L)) return 'G-L';
      if (/^[M-O]$/.test(L)) return 'M-O';
      if (/^[P-W]$/.test(L)) return 'P-W';
      if (/^[X-Z]$/.test(L)) return 'X-Z';
      if (/^[ab]$/.test(L)) return 'a-b';
      return L;
    };
    for (const ch of channels || []) {
      if (!ch || !ch.events) continue;
      if (ch.letter === 'D' || ch.letter === 'E' || ch.noise || ch.isDrum || ch.drum) continue;
      const g = groupOf(ch.letter);
      for (const ev of ch.events) {
        if (ev.note == null || ev.verifySkip || ev.drum) continue;
        if (ev.fme7Noise !== undefined && ev.instrument === 2) continue;
        const freq = ev.rawFreq != null ? ev.rawFreq : ev.freqHz;
        if (!(freq > 0)) continue;
        let dev = (57 + 12 * Math.log2(freq / 440) - ev.note) * 100;
        dev -= 100 * Math.round(dev / 100); // 最寄り半音からの偏差(-50..50)へ畳む
        const w = Math.max(1, (ev.end - ev.start) || 1);
        samples.push([dev, w]);
        (groups[g] = groups[g] || []).push([dev, w]);
      }
    }
    const wmedian = (arr) => {
      const s = arr.slice().sort((a, b) => a[0] - b[0]);
      let tot = 0; for (const x of s) tot += x[1];
      let acc = 0; for (const x of s) { acc += x[1]; if (acc >= tot / 2) return x[0]; }
      return s.length ? s[s.length - 1][0] : 0;
    };
    const byGroup = Object.keys(groups).map((g) => ({ group: g, median: wmedian(groups[g]), count: groups[g].length }));
    const none = { cents: 0, median: 0, iqr: 0, count: samples.length, reason: 'few', byGroup };
    if (samples.length < minCount) return none;
    samples.sort((a, b) => a[0] - b[0]);
    let total = 0;
    for (const s of samples) total += s[1];
    const quantile = (q) => {
      let acc = 0;
      for (const s of samples) { acc += s[1]; if (acc >= total * q) return s[0]; }
      return samples[samples.length - 1][0];
    };
    const median = quantile(0.5);
    const iqr = quantile(0.75) - quantile(0.25);
    const wrap = (d) => d - 100 * Math.round(d / 100);
    const fitOf = (shift) => { let acc = 0; for (const s of samples) if (Math.abs(wrap(s[0] - shift)) <= 10) acc += s[1]; return acc / total; };
    const fitBefore = fitOf(0), fitAfter = fitOf(median);
    const out = { cents: 0, median, iqr, count: samples.length, fitBefore, fitAfter, reason: null, byGroup };
    if (iqr > maxIqr) { out.reason = 'iqr'; return out; }
    if (fitAfter + 0.05 < fitBefore) { out.reason = 'fit'; return out; }
    if (Math.abs(median) < minCents) { out.reason = 'below'; return out; }
    out.cents = Math.round(median * 10) / 10;
    return out;
  };

  // 変換本体を必要なら2回走らせる(各 *2mml の入口が呼ぶ)。run(options) は変換結果
  // オブジェクトを返し、その中に scoreChannels(emitScore に渡した配列)を含めること
  // (検出に使ったあと結果からは外す。UI が保持する結果を肥大させないため)。
  // 1回目は必ず A440 基準(=従来の出力)。閾値未満ならそれをそのまま返すので、'a440' 指定や
  // 全体ずれの無い曲の出力・処理時間は従来と変わらない。
  // guard(省略可) { minCents, maxIqr }: 形式側の下限(ユーザーの TUNING_MIN より厳しい方を採る)。
  //   (2026-09-07 の一時期、SPC がサンプル原音推定の偏りを「全体ずれ」と誤検出するのを避けるため
  //    15セント/四分位範囲15 を渡していた。原音推定の修正(spc2mml/converter.js detectBrrFundamental)後は
  //    不要になり、現在はどの形式も渡していない)
  MML.Convert.autoTune = function (options, run, guard) {
    const cmd = MML.Convert.normalizeCmd(options && options.cmd);
    guard = guard || {};
    const finish = (res, info) => {
      if (res && typeof res === 'object') { res.tuning = info; delete res.scoreChannels; }
      return res;
    };
    const first = MML.Convert.withTuning(0, () => run(options));
    // 固定指定でも検出だけは行い、結果(適用していれば何セントだったか)をステータスへ出せるようにする
    const minCents = Math.max(cmd.TUNING_MIN, guard.minCents || 0);
    const det = MML.Convert.detectTuning(first && first.scoreChannels, {
      minCents, maxIqr: guard.maxIqr != null ? guard.maxIqr : undefined,
    });
    det.minCents = minCents;
    if (cmd.TUNING !== 'auto') { det.cents = 0; det.reason = 'fixed'; det.mode = 'a440'; return finish(first, det); }
    det.mode = 'auto';
    if (!det.cents) return finish(first, det);
    return finish(MML.Convert.withTuning(det.cents, () => run(options), det), det);
  };

  // ── チャンネル別の変換音量(2026-08-25) ──────────────────────────────
  // 規約: options.channelMap[ch].volPct = 0..100(既定100)。そのチャンネルの変換時
  // 音量を何%にするかの縮小専用の比率(v15等で頭打ちのため上げる方向は無い)。
  // パート(借用先)指定・音色指定と組で、SPC以外のフォーマットのチャンネル割当UIにも
  // 同じキー名・同じ意味で展開する予定の共通規約。計算はこのヘルパーに一本化する。
  MML.Convert.channelVolScale = function (cfg) {
    const p = cfg && cfg.volPct != null ? parseFloat(cfg.volPct) : 100;
    if (!isFinite(p)) return 1;
    return Math.max(0, Math.min(100, p)) / 100;
  };

  // エンベロープを出さない時の代表音量: 音量列(または{values}形状)のピーク値。
  // 先頭値だとアタック途中(0から立ち上がる音源)の値になることがあるため最大値を取る。
  MML.Convert.plainVolume = function (seqOrShape) {
    const seq = Array.isArray(seqOrShape) ? seqOrShape : (seqOrShape && seqOrShape.values) || [];
    let m = null;
    for (const v of seq) if (typeof v === 'number' && (m === null || v > m)) m = v;
    return m === null ? 0 : m;
  };

  // mmlEmit.js の per-channel フラグを cmd でANDマスクする(出力層の安全網)
  MML.Convert.maskEmitFlags = function (flags, cmd) {
    const c = MML.Convert.normalizeCmd(cmd);
    const f = Object.assign({}, flags);
    if (!c.D)     f.hasDetune = false;
    if (!c.EP && !c.MP && !c.PT) f.hasPitchMod = false;
    if (!c.EN)    f.hasNoteEnv = false;
    if (!c.ENV)   { f.hasEnvelope = false; f.hasFme7Env = false; }
    if (!c.V)     f.hasVolume = false;
    if (!c.SWEEP) f.hasSweep = false;
    if (!c.INST)  { f.hasInstrument = false; f.hasVrc7Tone = false; f.hasFdsMod = false; f.hasFme7Noise = false; }
    return f;
  };

  // ── 譜面整形 ───────────────────────────────────────────────────────
  // events: mmlEmit.js と同じ { start, end, note, ... } の配列(フレーム単位、昇順前提)。
  // 新しい配列を返す(元は変更しない)。
  //   SHAPE_REST : 音符の直後の休符(または隙間)が restThreshold フレーム未満なら直前の
  //                音符を延ばして埋める(ゲートタイムの隙間除去)
  //   (SHAPE_QUANT=16分格子への丸めは 2026-09-07 に廃止。冒頭コメント参照)
  MML.Convert.shapeEvents = function (events, fpb, cmd) {
    const c = MML.Convert.normalizeCmd(cmd);
    if (!c.SHAPE_REST) return events;
    let evs = (events || []).slice().sort((a, b) => a.start - b.start).map(e => Object.assign({}, e));

    if (c.SHAPE_REST) {
      const restThreshold = fpb / 8; // 1/32 音符未満
      const out = [];
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        const prev = out[out.length - 1];
        // リリース表(@vr)付きの音符の直後の休符はリリースが鳴る区間(mmlEmit が k<len> で出す)
        // なので吸収しない
        if (ev.note === null && prev && prev.note !== null && prev.envelopeVr == null && (ev.end - ev.start) < restThreshold) {
          prev.end = Math.max(prev.end, ev.end); // 休符を直前の音符へ吸収
          continue;
        }
        // 明示休符が無い単なる隙間も同じ扱い(fillGaps が後で休符化する前に埋める)
        if (prev && prev.note !== null && ev.start > prev.end && (ev.start - prev.end) < restThreshold) {
          prev.end = ev.start;
        }
        out.push(ev);
      }
      evs = out;
    }
    return evs;
  };
})(globalThis);

/*
 * ピッチ変調(ビブラート)検出 → { delay, values, loop? } 変換。
 * @EP<N> = { ... | ... } テーブル構文(src/mml/lexer.js PITCH_NOTE_ENVELOPE_DEF_RE)用の
 * データを作る。DESIGN-PITCH.md Phase 1(厳密周期ビブラート→ループEP)の実装。
 *
 * MML.Convert.classifyPitchMod(pitchSeq) ->
 *   { type:'periodic', delay, values } | { type:'literal'|'ramp', delay, values } | null
 *   pitchSeq: 1音符区間のフレーム毎の生ピッチレジスタ値(*2mmlのev.pitchSeq、Phase 0で追加)。
 *   戻り値 null … 変調が見つからない(フラット・短すぎ・範囲外)。
 *                 呼び出し側は従来通りD<n>(定数オフセット)のみを使うべき。
 *
 * 判定は基準値(pitchSeq[0]、detune.js/D<n>と同じ基準点)からの差分列に対して行う。
 * D<n>とEP<n>はcompiler.js側で加算される(pitchRegisterOffset: offset = detune +
 * stepEnvelope(ep) + ...)ため、基準点さえ揃っていれば両者は独立に正しく合成される。
 *
 * ★2026-08-11(DESIGN-PITCH.md 別プロジェクトA): `delay`はテーブル本体(values)とは
 * 別に返す独立フィールドになった。以前は「変調開始前の実測ゼロ区間」をテーブル先頭に
 * そのままゼロ値として焼き込んでいた(EP<n>,<delay>引数が未実装だったための代替、
 * P-1参照)が、`EP<n>,<delay>`引数拡張の実装によりMML側で明示的に指定できるようになった
 * ため、pitch.js側では常にゼロ区間をテーブルから分離してdelayとして返す
 * (`values`にゼロ埋めのpadding抜き)。呼び出し側(*2mml converter)は
 * `ev.pitchEp`(テーブル番号)と`ev.pitchEpDelay`(delayフレーム数)の両方を
 * mmlEmit.jsへ渡し、`EP<n>,<delay>`として出力する。利点: 同じLFO形状を遅延違いで
 * 使う曲でもテーブルが重複登録されずEnvelopeRegistryの重複排除が効く、NSF書き出しの
 * ROMサイズもゼロ埋めNバイトよりdelay1バイトの方が小さい(§4参照)。
 *
 * 周期探索パラメータはenvelope.js/retrigger.jsの前例に倣い、このモジュール専用に
 * 独立させる(共有しない。DESIGN-PITCH.md P-3参照)。envelope.jsが踏んだ2つのバグ
 * (loop食い違いの前方一致共有、固定窓による長周期の誤検出)は同じ形で回避する。
 *
 * MML.Convert.PitchEnvelopeRegistry … 曲全体で共有するEPテーブル登録先(重複排除)。
 * EnvelopeRegistryと同型・同ルール(0番から採番、loop食い違いは前方一致させない)。
 *
 * MML.Convert.rescalePitchSeqFromFreq(freqSeq, periodFn) -> number[]
 *   借用変換(DESIGN.md §5、変換元と変換先でチップ・クロックが異なる)用。ev.pitchSeq
 *   (変換元チップの生レジスタ値)をそのままEPへ使うと、変換元と変換先で周期レジスタの
 *   スケール(クロック比)が違うため変調の深さが誤って伸縮する(例: KSS PSG→FME7は
 *   クロック比≈2倍)。ev.freqSeq(Hz、Phase 0で追加済み)を変換先チップのperiodFn
 *   (detectChorusDetune/applyPitchDetuneが使うのと同じ生周期換算関数、例:
 *   fme7PeriodRaw/n163FreqRegRaw/pulsePeriodRaw)へ通してから分類する。
 *   detune.js冒頭コメントと同じ「差を取ってから1回だけ丸める」方針(基準フレームの
 *   連続値を保持し、各フレームは基準との差分を丸めてから整数化する。フレーム毎に
 *   独立で丸めてから引き算すると誤差が余分に乗る)。
 *   ネイティブ変換(変換元=変換先、NSF本体+拡張音源)はスケール変換が不要なので
 *   ev.pitchSeqをそのままPitchEnvelopeRegistry.assignへ渡せばよく、この関数は使わない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  // 非周期(こぶし/アタックベンド/ランプ、DESIGN-PITCH.md Phase 3)を非ループEPテーブルとして
  // 書き出すための閾値。周期判定用の定数(MIN_PERIOD等)とは独立させる(P-3参照)。
  // 非周期側は「同じ形が繰り返される」という裏付けが取れない(1回きりの観測)ため、
  // 周期判定のMIN_LOOP_RANGE(=2)よりやや厳しめにして丸め誤差ノイズの誤検出を避ける。
  const MIN_LITERAL_RANGE  = 3;
  const MIN_LITERAL_FRAMES = 4; // MIN_PERIODと同じ考え方(3フレーム以下は打鍵ジッタと区別できない)

  const MIN_PERIOD       = 4;  // 3フレーム以下の「周期」は単発の打鍵ジッタと区別できないため除外
  const MAX_PERIOD       = 64; // Phase 0実測(GBS周期12、SPC周期13-15)を踏まえた余裕のある上限
  // 誤検出防止の基準は「最低N周期分の一致」(envelope.jsの流儀)ではなく「一致確認に使った
  // 絶対フレーム数」で取る。★実データ(GBS Star Wars CH1)で実測した所、1音符が32フレーム
  // 程度と短くビブラート周期が15フレームに達する曲があり、「最低2周期分」要求だと
  // 30フレーム超が必要になり大半の実ノートで確認しきれず未検出になっていた
  // (envelope.jsの用途=音量は数百フレームの持続音が前提だが、ピッチのビブラートは
  // 1音符=数十フレームの中で完結することが多く前提が異なる)。決定的(ノイズ無し)な
  // エミュレーション値の完全一致比較であるため、MIN_CONFIRM_FRAMES分の一致さえあれば
  // 偶然の一致はほぼあり得ない(全区間フラットの場合はflatRunチェックで別途除外済み、
  // 周期が短いほど実質の確認周期数は増えるので短周期の検出精度は従来通り高いまま)。
  const MIN_CONFIRM_FRAMES = 8;
  const MIN_LOOP_RANGE = 2; // ループ内振幅(最大-最小)がこれ未満なら装飾として弾く(丸め誤差対策)
  const MAX_SEARCH_START = 64; // ループ開始位置(=delay相当)の探索上限
  const MAX_CHECK_WINDOW = 180; // 確認窓の下限(envelope.jsのMAX_ENV_FRAMESと同じ考え方)
  const EP_VALUE_MIN = -127, EP_VALUE_MAX = 126; // @EP<n>テーブル値は符号付きbyte(lexer.js参照)
  const MAX_EP_DELAY = 255; // EP<n>,<delay>のdelayは1byte(mckBytecode.js/ppmckDriver.js側)

  // 厳密周期チェック。確認窓は「MAX_CHECK_WINDOW」と「period+MIN_CONFIRM_FRAMES(呼び出し元の
  // maxPeriod計算が既に保証する下限)」の大きい方に取る(envelope.js:isPeriodicFromと同じ
  // 固定窓バグの回避策)。
  function isPeriodicFrom(seq, start, period) {
    const limit = Math.min(seq.length, start + Math.max(MAX_CHECK_WINDOW, period + MIN_CONFIRM_FRAMES));
    for (let i = start + period; i < limit; i++) {
      if (seq[i] !== seq[i - period]) return false;
    }
    return true;
  }

  // 末尾の「同一値が続く足踏み区間」だけを1個残してtrimする
  // ([[envelope-nonloop-tail-trim-fix]]と同じ考え方: 非ループの絶対オフセット列は末尾値を
  // 保持し続ける意味なので、末尾の重複はテーブル長を縮めるだけで再生結果に影響しない。
  // 実際の@EPテーブルは registerShape で差分列+末尾0へ変換される)。
  function trimTrailingHold(diff) {
    let end = diff.length;
    while (end > 1 && diff[end - 1] === diff[end - 2]) end--;
    return diff.slice(0, end);
  }

  // 先頭の連続ゼロ区間を切り出してdelayフレーム数として返す(残りがテーブル本体)。
  // classifyPitchModのperiodic/literal/ramp全パターンで共通利用(2026-08-11 別プロジェクトA)。
  function splitLeadingDelay(arr) {
    let i = 0;
    while (i < arr.length && arr[i] === 0) i++;
    return { delay: i, rest: arr.slice(i) };
  }

  function isMonotonic(arr) {
    let up = true, down = true;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] < arr[i - 1]) up = false;
      if (arr[i] > arr[i - 1]) down = false;
    }
    return up || down;
  }

  MML.Convert.classifyPitchMod = function (pitchSeq) {
    if (!pitchSeq || pitchSeq.length < MIN_LITERAL_FRAMES) return null;
    const base = pitchSeq[0];
    const diff = pitchSeq.map(p => p - base);
    const n = diff.length;

    let flatRun = 0;
    while (flatRun < n && diff[flatRun] === 0) flatRun++;
    if (flatRun === n) return null; // 全区間フラット。従来のD<n>のみで表現できる

    const maxStart = Math.min(flatRun, MAX_SEARCH_START);
    for (let start = 0; start <= maxStart; start++) {
      const remain = n - start;
      // 確認フレーム数(remain-period)がMIN_CONFIRM_FRAMES未満になる周期は試さない
      const maxPeriod = Math.min(MAX_PERIOD, remain - MIN_CONFIRM_FRAMES);
      for (let period = MIN_PERIOD; period <= maxPeriod; period++) {
        if (!isPeriodicFrom(diff, start, period)) continue;
        const loop = diff.slice(start, start + period);
        if (loop.some(v => v < EP_VALUE_MIN || v > EP_VALUE_MAX)) continue; // この周期は範囲外、他を試す
        // 振幅が小さすぎる周期は却下し他を試す。特にKSS/GBS/HES/SPCの借用変換は
        // rescalePitchSeqFromFreq(Hz経由の丸め)を通すため、実際には無変調のノートでも
        // 境界値の丸め起因で1ステップだけ変化する区間がたまたま長い周期として
        // 「厳密に一致」してしまうことがある(実測: SPC Frog's Themeで振幅1のみの
        // 30フレーム超ループを誤検出)。ネイティブ変換(丸め無し)でも振幅1は
        // 装飾として意味を持ちにくいため、形式を問わず同じ基準で弾く。
        const loopMax = Math.max(...loop), loopMin = Math.min(...loop);
        if (loopMax - loopMin < MIN_LOOP_RANGE) continue;
        if (start > MAX_EP_DELAY) return null; // delayがbyte幅を超える異常値は安全側に倒す
        return { type: 'periodic', delay: start, values: loop };
      }
    }

    // 周期的でなければ、非周期だが意味のある変調(こぶし/アタックベンド/ランプ、
    // DESIGN-PITCH.md Phase 3)として非ループEPテーブル(literal、末尾は最終値を永久
    // ホールド)を試す。末尾の同一値足踏みをtrimしたのち、先頭の実測ゼロ区間も
    // delayとして切り出す(別プロジェクトA、pitch.js冒頭コメント参照)。
    const trimmed = trimTrailingHold(diff);
    const { delay: litDelay, rest } = splitLeadingDelay(trimmed);
    if (rest.length >= MIN_LITERAL_FRAMES) {
      const litMax = Math.max(...rest), litMin = Math.min(...rest);
      if (litMax - litMin >= MIN_LITERAL_RANGE &&
          !rest.some(v => v < EP_VALUE_MIN || v > EP_VALUE_MAX) &&
          litDelay <= MAX_EP_DELAY) {
        return { type: isMonotonic(rest) ? 'ramp' : 'literal', delay: litDelay, values: rest };
      }
    }
    return null;
  };

  // cmd: src/convert/options.js の変換設定(省略可)。EP/MP/PT の個別ON/OFFを assign() で見る。
  MML.Convert.PitchEnvelopeRegistry = function (cmd) {
    this.cmd = MML.Convert.normalizeCmd(cmd);
    this.tables = new Map(); // index(@EP<N>の番号) -> { values, loop }
    this.keyToIndex = new Map();
    this.nextIndex = 0;
    // @MP<N>(ビブラート、{delay,speed,depth})用の独立した番号空間・重複排除マップ。
    // EPと違い、MPは本文側コマンド(MP<n>)がdelay引数を取れない(lexer.js参照。
    // EP<n>,<delay>のような拡張が無い)ため、delayもテーブル自体のキーに含める必要がある。
    this.vibratoTables = new Map(); // index(@MP<N>の番号) -> { delay, speed, depth }
    this.vibratoKeyToIndex = new Map();
    this.nextVibratoIndex = 0;
  };

  // {delay,speed,depth}が完全一致する@MP<n>を再利用し、無ければ新規登録する。
  MML.Convert.PitchEnvelopeRegistry.prototype.registerVibrato = function (mp) {
    const key = mp.delay + ',' + mp.speed + ',' + mp.depth;
    let idx = this.vibratoKeyToIndex.get(key);
    if (idx === undefined) {
      idx = this.nextVibratoIndex++;
      this.vibratoKeyToIndex.set(key, idx);
      this.vibratoTables.set(idx, mp);
    }
    return idx;
  };

  function shapeKey(shape) {
    return shape.values.join(',') + '|' + (shape.loop == null ? '-' : shape.loop);
  }

  // aがbの前方一致(prefix)かどうか(envelope.jsのisPrefixと同じ)。
  function isPrefix(a, b) {
    if (a.length > b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // pitchMod({type,delay,values})を{values,loop}テーブルへ変換して登録し、
  // {index, delay}を返す(2026-08-11 別プロジェクトA: delayはテーブルと独立管理する
  // ようになったため、登録先インデックスとは別に呼び出し元のpitchModが持つdelayを
  // そのまま素通しで返す。テーブル自体にdelayの概念は無い=同じ形なら異なるdelay値の
  // 呼び出し同士でも同じテーブル番号を共有できる)。
  //
  // ★@EPの値は本家ppmck準拠の「毎フレームの差分の累積」(2026-09-13修正、compiler.js
  // pitchEnvelopeValue参照。以前は各フレームの絶対オフセットをそのまま書いており、当ツール内では
  // 辻褄が合っていたが本家ppmckcでコンパイルすると別の動きになっていた)。classifyPitchModが
  // 返すvaluesは「基準からの絶対オフセット列」なので、ここで差分列へ変換して登録する
  // (toCumulativeDeltas)。this.tables に持つのは差分列:
  //  ・periodic: [a0 | a1-a0, ..., a(P-1)-a(P-2), a0-a(P-1)] loop=1。1周ぶんの差分の合計は
  //    必ず0(閉じた巡回)なので周回しても音程がドリフトしない(buildNoteEnvelopeDeltasと同じ理屈)
  //  ・literal/ramp: [a0, a1-a0, ..., a(n-1)-a(n-2)] loop=null。実機は「|」無しテーブルの末尾値を
  //    足し続けるので、defLines(書き出し時)で末尾に 0 を付けて止める(tablesには付けずに持つ:
  //    下記の前方一致共有を絶対オフセット時代と同じ条件で判定するため)
  // 差分がbyte幅(EP_VALUE_MIN..MAX)を超える形は登録せずnullを返す(→基準音のみ)。
  // ★loop有り同士(片方でもloop!=null)は前方一致していても共有・置き換えを一切行わない
  // (envelope.js EnvelopeRegistry.registerShapeと同じ理由・同じガード。
  // [[envelope-registry-loop-upgrade-bug]]参照。ループ有りのvaluesは「最小の繰り返し単位」に
  // 切り詰められており配列長が観測フレーム数を反映しないため、前方一致だけを根拠にした
  // 共有/差し替えは無関係な変調を混同する事故になる)。
  function toCumulativeDeltas(absValues, isPeriodic) {
    if (!absValues || absValues.length === 0) return null;
    const out = [absValues[0]];
    for (let k = 1; k < absValues.length; k++) out.push(absValues[k] - absValues[k - 1]);
    if (isPeriodic) out.push(absValues[0] - absValues[absValues.length - 1]);
    if (out.some(v => v < EP_VALUE_MIN || v > EP_VALUE_MAX)) return null;
    return { values: out, loop: isPeriodic ? 1 : null };
  }
  MML.Convert.toCumulativePitchDeltas = toCumulativeDeltas;

  MML.Convert.PitchEnvelopeRegistry.prototype.registerShape = function (pitchMod) {
    if (!pitchMod) return null;
    const isPeriodic = pitchMod.type === 'periodic';
    const shape = toCumulativeDeltas(pitchMod.values, isPeriodic);
    if (!shape) return null;
    for (const [idx, existing] of this.tables) {
      if (existing.loop != null || shape.loop != null) continue;
      if (isPrefix(existing.values, shape.values)) {
        if (shape.values.length > existing.values.length) this.tables.set(idx, shape);
        return { index: idx, delay: pitchMod.delay };
      }
      if (isPrefix(shape.values, existing.values)) return { index: idx, delay: pitchMod.delay };
    }
    const key = shapeKey(shape);
    let idx = this.keyToIndex.get(key);
    if (idx === undefined) {
      idx = this.nextIndex++;
      this.keyToIndex.set(key, idx);
      this.tables.set(idx, shape);
    }
    return { index: idx, delay: pitchMod.delay };
  };

  // ── ポルタメントコマンド(DESIGN-PITCH.md 別プロジェクトC、2026-08-11) ──────
  // P-5「単調ランプ→ポルタメント(コマンドは将来)」の実装。検出側(classifyPitchMod)は
  // 無変更のまま、type:'ramp'の結果を後段(このファイル内)でさらに判定する:
  // 「MPの`warizan_start`(delay無し・反転無しの片道版)で寸分違わず再現できる、
  // 単純な一定ペースの直線グライドか」を検査し、再現できればPT<target>,<duration>
  // (2値だけの軽量コマンド、テーブル不要)へ、できなければ従来通り非ループEP
  // テーブル(literal、全フレーム値をそのまま保持)へ回す。
  // ★実機ppmck公式ドキュメント(doc/mck.txt)には専用のポルタメントコマンドが存在せず
  // 「ピッチエンベロープ(EP)で代用してください」と明記されている。したがってこの
  // PT<n>コマンドはppmck方言からの独自拡張であり(README.md方言対応表に明記、INV-2)、
  // EPは今後も可逆性チェックに失敗した場合のフォールバックとして必須(P-1「音の
  // 正しさ=軌跡保存」の非負妥協ライン。近似で妥協せず、再現できないものは安全側=EPへ)。
  // MMLの構文・バイトコード上(mckBytecode.js)のtargetは符号付き16bit(D<n>と同じ)まで
  // 表現できるが、6502ドライバ側のCEILDIV(MPと共有、ceilDivPpmck相当)がCDA/CDB共に
  // 1byteスクラッチのため|target|は255までしか正しく計算できない。この判定側でも
  // 同じ上限を掛けておく(判定と実装の上限がズレると「JS側は portamento と判定したのに
  // 6502側は8bit溢れで誤動作する」事故になるため、必ず両方揃えること)。
  const MAX_PORTAMENTO_TARGET = 255;
  const MAX_PORTAMENTO_DURATION = 255; // 6502側PTSTEPINT/duration格納は1byte

  // MPのwarizan_start(ceil除算によるBresenham風の一定ペース階段化)の片道版。
  // target(0からの目標オフセット)へduration フレームで到達する列をシミュレートする
  // (compiler.jsのvibratoSequence/ceilDivPpmckと同じアルゴリズムを反転無しで流用)。
  function simulatePortamento(target, duration) {
    const absTarget = Math.abs(target);
    const dir = target < 0 ? -1 : 1;
    let stepSize, stepInterval;
    if (duration === absTarget) { stepSize = 1; stepInterval = 1; }
    else if (duration > absTarget) { stepInterval = ceilDivPpmck(duration, absTarget); stepSize = 1; }
    else { stepSize = ceilDivPpmck(absTarget, duration); stepInterval = 1; }
    const seq = new Array(duration);
    let value = 0, counter = stepInterval;
    for (let t = 0; t < duration; t++) {
      if (counter === stepInterval) { counter = 0; value += dir * stepSize; }
      counter++;
      seq[t] = value;
    }
    return seq;
  }

  // ceilDiv(a,b): a>bの2値をwarizanと同じ規則(割り切れなければ+1、実測トレース済み。
  // src/mml/compiler.jsのceilDivPpmckと同一実装をここでも独立に持つ、共有しない
  // 理由はP-3参照)で割る。
  function ceilDivPpmck(a, b) {
    if (a === b) return 1;
    let q = 0, rem = a;
    while (rem > 0) { q++; rem -= b; }
    return q;
  }

  // valuesがsimulatePortamento(target,duration)と1バイトも違わず一致するかを確認し、
  // 一致すれば{target,duration}を、しなければnullを返す(rampだが直線でない=EPへ)。
  function fitPortamento(values) {
    const duration = values.length;
    const target = values[values.length - 1];
    if (target === 0 || duration < 1) return null;
    if (Math.abs(target) > MAX_PORTAMENTO_TARGET || duration > MAX_PORTAMENTO_DURATION) return null;
    const simulated = simulatePortamento(target, duration);
    for (let i = 0; i < duration; i++) if (simulated[i] !== values[i]) return null;
    return { target, duration };
  }

  // ── ビブラートコマンド(DESIGN-PITCH.md 別プロジェクトB、gate解除は2026-08-15) ──
  // P-5「周期的振動(三角形状)→MP<n>」の実装。別プロジェクトBでcompiler.jsのMPが
  // lfo_sub/warizan_startの厳密移植になった(2026-08-11)後も、抽出側(ここ)は
  // 「MPは近似実装だった名残」でしばらく常にループEP<n>を使い続けていた
  // (gateが実装完了後も外されないまま残っていた、2026-08-15にユーザー指摘で発覚・解消)。
  // 検出側(classifyPitchMod)は無変更のまま、type:'periodic'の結果を後段(このファイル内)
  // でさらに判定する: 「MPの`lfo_sub`(delay無しでオシレーション形状だけを見る)で
  // 寸分違わず再現できる、階段状の対称往復振動か」を検査し、再現できればMP<n>
  // (3パラメータだけの軽量コマンド、テーブルは{delay,speed,depth}の3値のみ)へ、
  // できなければ従来通りループEPテーブルへ回す(fitPortamentoと全く同じ「シミュレート
  // して安全に妥協しない」設計方針)。
  const MAX_MP_SPEED = 255, MAX_MP_DEPTH = 255; // @MP<n>={delay,speed,depth}は各値1byte幅
                                                 // (mckBytecode.js/ppmckDriver.js側、delay/speed/depth共通)

  // compiler.jsのvibratoSequence(lfo_sub厳密移植)と同一アルゴリズムをここでも独立に持つ
  // (ceilDivPpmckと同じ理由=P-3で共有しない)。delay=0固定(delayはpitchModが別途返すため、
  // ここでは純粋なオシレーション形状の照合だけを行う)。
  function simulateVibrato(quarter, rawDepth, dur, direction) {
    let stepSize, stepInterval;
    if (quarter === rawDepth) { stepSize = 1; stepInterval = 1; }
    else if (quarter > rawDepth) { stepInterval = ceilDivPpmck(quarter, rawDepth); stepSize = 1; }
    else { stepSize = ceilDivPpmck(rawDepth, quarter); stepInterval = 1; }
    const seq = new Array(dur);
    let reverseCounter = quarter, adcSbcCounter = stepInterval, dir = direction, value = 0;
    for (let t = 0; t < dur; t++) {
      if (reverseCounter === quarter * 2) { reverseCounter = 0; dir = -dir; }
      if (adcSbcCounter === stepInterval) { adcSbcCounter = 0; value += dir * stepSize; }
      reverseCounter++; adcSbcCounter++;
      seq[t] = value;
    }
    return seq;
  }

  // periodFn(freqを生レジスタへ写す関数)が増加関数か減少関数かを実測判定する
  // (compiler.jsのperiodFnIncreasingと全く同じ2点比較、独立に持つ=P-3)。
  function periodFnIncreasingLocal(periodFn) {
    return periodFn(2000) > periodFn(200);
  }

  // 周期的ビブラート(classifyPitchModのperiodic、1周期分のvalues)がMP<n>の
  // {speed,depth}パラメータ空間(lfo_sub、ceil除算の階段状LFO)で寸分違わず再現できるか
  // 検査する。再現できれば{speed,depth}を、できなければnullを返す(呼び出し側は
  // 従来通りループEPテーブルへフォールバックする)。
  //
  // directionUp: 出力先チップの周波数方向。true=周波数レジスタ(値が上がるほど音程が
  // 上がる: FDS/N163)、false=周期レジスタ(値が下がるほど音程が上がる: 2A03/VRC6/
  // MMC5/FME7)。compiler.jsのperiodFnIncreasing→vibratoSequence呼び出しと完全に同じ
  // 規則で、呼び出し元が出力先チャンネルのチップに合わせて渡す必要がある(渡し間違えると
  // 実際にMPで再コンパイルした時だけ逆位相になる=ここでのbit一致確認をすり抜けてしまう
  // 唯一のポイントなので注意)。VRC7はEP/MP対象外(fnum/blockの対数空間)なので
  // directionUpをundefinedのまま渡せば自動的にフィットを試みない。
  //
  // ★探索範囲: 観測周期period が4の倍数でなければ不採用(quarter=period/4が整数に
  // ならないと lfo_sub の基本周期4*quarterと噛み合わない。quarter>depthの場合は
  // ceil除算の噛み合わせで真の周期が4*quarterより長くなることがあるが、そのケースは
  // 下の「3周期ぶん完全一致」チェックで自然に弾かれる=安全側にEPへフォールバックする)。
  // quarterは上記でただ1通りに決まるため、depthだけを観測振幅(peak)近傍で総当たりする。
  //
  // ★位相はvalues[0]がそのままsim[0](オシレーション開始直後の最初のステップ済み値)と
  // 一致することを要求する(任意回転は許容しない)。理由: vibratoSequenceは「delay
  // フレームだけ0を保持し、その直後は必ず自前の初期状態(reverseCounter=quarter,
  // adcSbcCounter=stepInterval,value=0)から新規にオシレーションを開始する」実装であり、
  // ノート開始のたびに位相をリセットする(=途中の任意の位相から始めることはできない、
  // かつsim自体は最初の1フレーム目から必ずステップ済みの非0値になり、0そのものには
  // ならない)。
  //
  // ★ただし「values先頭の連続0」だけは特別扱いしてdelay側へ吸収する。classifyPitchModは
  // (EP用途では位相を気にする理由が無いため)観測データの0交差を「delay」側に含めるか
  // 「valuesの先頭」に含めるかを一意に決めない=前方一致で複数の(start,period)が同等に
  // 有効なため、実測で「valuesの先頭が0(オシレーション自身の自然な0交差)」という
  // 決定をしがちだと確認済み(delay=5で生成した合成データがdelay=4+values=[0,-2,...]と
  // 分類され、素朴にpitchMod.delayをそのまま使うと1フレームずれた誤った波形になる、
  // 実装時に発覚)。0は「delayホールド中の値」でもあるため、この曖昧さは
  // 「valuesの先頭の連続0をdelay側の延長とみなす」ことで一意に解消できる(0以外の
  // 値は延長候補になり得ない=sim自体が0を返さないため、この吸収は安全側の補正であり
  // 妥協ではない)。吸収した後の残りの列がsim[0..]と寸分違わず一致することを要求する
  // (先頭以外の回転は引き続き許容しない)。
  const MAX_VIBRATO_FIT_PERIOD = 64; // MAX_PERIODと同じ(classifyPitchModが返す周期の上限)
  const MAX_MP_DELAY = 255; // @MP<n>のdelayも1byte幅(mckBytecode.js/ppmckDriver.js側)

  function fitVibrato(values, baseDelay, directionUp) {
    if (directionUp == null) return null;
    const period = values.length;
    if (period < 4 || period % 4 !== 0 || period > MAX_VIBRATO_FIT_PERIOD) return null;
    let leadingZeros = 0;
    while (leadingZeros < period && values[leadingZeros] === 0) leadingZeros++;
    if (leadingZeros >= period) return null; // 全区間0(あり得ないはずだが念のため)
    const delay = baseDelay + leadingZeros;
    if (delay > MAX_MP_DELAY) return null;
    const quarter = period / 4;
    if (quarter > MAX_MP_SPEED) return null;
    const direction = directionUp ? 1 : -1;
    const peak = Math.max(...values.map(v => Math.abs(v)));
    const depthLo = Math.max(1, peak - quarter - 1);
    const depthHi = Math.min(MAX_MP_DEPTH, peak + quarter + 1);
    const simDur = period * 3; // 3周期ぶん確認し、真に無限に繰り返し可能なことを保証する
    for (let rawDepth = depthLo; rawDepth <= depthHi; rawDepth++) {
      const sim = simulateVibrato(quarter, rawDepth, simDur, direction);
      let ok = true;
      for (let i = 0; i < simDur; i++) {
        if (sim[i] !== values[(i + leadingZeros) % period]) { ok = false; break; }
      }
      if (ok) return { delay, speed: quarter, depth: rawDepth };
    }
    return null;
  }

  // pitchSeqを解析し、{kind:'portamento', target, duration, delay} |
  // {kind:'vibrato', index} | {kind:'ep', index, delay} | nullを返す(呼び出し側は
  // kindで分岐してev.portamento/ev.vibrato/ev.pitchEp+ev.pitchEpDelayを設定する)。
  // 変調が見つからなければnull(呼び出し側はD<n>のみを使うべき合図)。
  //
  // directionUp: 周期的ビブラート(periodic)をMP<n>へフィットする際に使う出力先チップの
  // 周波数方向(fitVibrato参照)。省略時(undefined)はMPへのフィットを試みず、
  // 従来通り常にループEPテーブルを使う(VRC7=EP/MP対象外チャンネルの既定動作と一致)。
  // ── SA<num>(ピッチシフト量、ppmckc公式・N163専用)の自動選択 ─────────────
  // EPテーブル値は符号付きbyte(EP_VALUE_MIN/MAX)・MP depthも1byteだが、N163の周波数
  // レジスタは18bitで1オクターブごとに値が2倍になる。深いビブラート等は生オフセットが
  // byte幅を大きく超えて割当が失敗するため(実測: HESの変調イベントの58〜98%が黙って
  // 破棄されていた)、SA<num>で値を<num>回左シフトして適用するようにし、テーブルには
  // 縮めた値(>>sa)を登録する。量子化は2^sa単位=変調深さの約1/127で、セント換算1〜2程度。
  //
  // saMode('PITCH_SA'変換設定、src/convert/options.js):
  //   'octave' … 基準レジスタ値のオクターブに連動(sa=floor(log2(base))-10、正規化後の
  //              基準値が1024〜2047になる位置)。同じセント形状のビブラートがオクターブを
  //              またいで同一のテーブル値になり、EnvelopeRegistryのdedupeが効く。
  //              量子化ステップはセント換算0.85〜1.7で一定(オクターブ非依存)。既定。
  //   'note'   … 音符ごとに必要最小のsa(最高精度、テーブル共有は減る)
  //   'off'    … SAを使わない(従来互換。byte幅を超える変調は従来どおり割当失敗)
  // どのモードもレンジに収まらない場合はsa+1のエスケープで引き上げる(上限8=本家仕様)。
  MML.Convert.n163SaForBase = function (baseReg) {
    if (!(baseReg > 0)) return 0;
    return Math.max(0, Math.min(8, Math.floor(Math.log2(baseReg)) - 10));
  };

  // pitchSeq(生レジスタ値列)に対する実際のsaを決める。baseSa(モードごとの基本値)から、
  // 最大偏差がEPのbyte幅に収まるまで引き上げる
  function resolveSa(pitchSeq, baseSa) {
    const base = pitchSeq[0];
    let maxAbs = 0;
    for (const v of pitchSeq) { const d = Math.abs(v - base); if (d > maxAbs) maxAbs = d; }
    let sa = Math.max(0, Math.min(8, baseSa || 0));
    while (sa < 8 && (maxAbs >> sa) > EP_VALUE_MAX) sa++;
    return sa;
  }

  // saOpts(省略可): { mode: 'octave'|'note'|'off', baseSa: number }。
  // N163が出力先のときだけ渡す(assignPitchEnvelopeのopts.saMode経由、または
  // nsf2mml/spc2mmlのN163パスから直接)。戻り値にsa(使用したシフト量)が付く。
  MML.Convert.PitchEnvelopeRegistry.prototype.assign = function (pitchSeq, directionUp, saOpts) {
    const cmd = this.cmd;
    if (!cmd.EP && !cmd.MP && !cmd.PT) return null; // 変換設定で全てOFF(基準音のみ)
    let sa = 0;
    let seq = pitchSeq;
    if (saOpts && saOpts.mode && saOpts.mode !== 'off') {
      sa = resolveSa(pitchSeq, saOpts.baseSa || 0);
      if (sa > 0) {
        const base = pitchSeq[0];
        seq = pitchSeq.map(v => base + Math.round((v - base) / (1 << sa)));
      }
    }
    // ★MMLのEP/PT値は全音源「正=音程が上がる」(2026-09-14統一、compiler.js pitchRegDir参照)。
    // pitchSeqはレジスタ空間なので、周期レジスタ系(directionUp=false: 音程が上がると値が減る)は
    // 基準値を軸に反転してからMML値として分類・登録する。MPのfitVibratoにも反転後の列を渡すので
    // 方向は常に「上向き=正」(true)で扱う
    if (directionUp === false) {
      const base0 = seq[0];
      seq = seq.map(v => 2 * base0 - v);
      directionUp = true;
    }
    const pitchMod = MML.Convert.classifyPitchMod(seq);
    if (!pitchMod) return null;
    if (pitchMod.type === 'ramp') {
      const fit = cmd.PT ? fitPortamento(pitchMod.values) : null;
      // PT(独自拡張)はSAのシフト対象外(compiler.js pitchRegisterOffset参照)のため、
      // targetを生スケールへ戻して返す
      if (fit) return { kind: 'portamento', target: fit.target * (1 << sa), duration: fit.duration, delay: pitchMod.delay, sa };
    } else if (pitchMod.type === 'periodic') {
      const fit = cmd.MP ? fitVibrato(pitchMod.values, pitchMod.delay, directionUp) : null;
      if (fit) {
        const idx = this.registerVibrato({ delay: fit.delay, speed: fit.speed, depth: fit.depth });
        return { kind: 'vibrato', index: idx, sa };
      }
    }
    if (!cmd.EP) return null; // EPが受け皿として使えなければ基準音のみ
    const registered = this.registerShape(pitchMod);
    return registered ? { kind: 'ep', index: registered.index, delay: registered.delay, sa } : null;
  };

  MML.Convert.PitchEnvelopeRegistry.prototype.defLines = function () {
    const epLines = Array.from(this.tables.keys()).sort((a, b) => a - b).map(i => {
      const t = this.tables.get(i);
      const parts = t.values.map(String);
      if (t.loop != null) parts.splice(t.loop, 0, '|');
      // 非ループは末尾0で止める(registerShapeのコメント参照。末尾が既に0なら付けない)
      else if (t.values[t.values.length - 1] !== 0) parts.push('0');
      return `@EP${i} = { ${parts.join(' ')} }`;
    });
    const mpLines = Array.from(this.vibratoTables.keys()).sort((a, b) => a - b).map(i => {
      const t = this.vibratoTables.get(i);
      return `@MP${i} = { ${t.delay}, ${t.speed}, ${t.depth} }`;
    });
    return [...epLines, ...mpLines];
  };

  // periodFn(freq, ev): applyPitchDetune/detectChorusDetuneと同じ2引数版
  // 生周期換算関数(evはHESのn163PeriodRawのようにev.rawLength等を参照する場合に必要)。
  MML.Convert.rescalePitchSeqFromFreq = function (freqSeq, periodFn, ev) {
    const cont0 = periodFn(freqSeq[0], ev);
    const base = Math.round(cont0);
    return freqSeq.map(f => base + Math.round(periodFn(f, ev) - cont0));
  };

  // 借用変換(KSS/GBS/HES)向けのまとめ役: channels([{events}])の各イベントの
  // ev.freqSeqをperiodFn(detectChorusDetune/applyPitchDetuneと同じ生周期換算関数)で
  // 借用先チップの生レジスタ空間へ変換して分類・登録し、該当すればev.pitchEpを立てる
  // (MML出力側でのgetter用にイベントオブジェクトを直接書き換える。detectChorusDetuneが
  // ev.detuneを直接書き込むのと同じ流儀)。
  // opts.saMode('octave'|'note'|'off'): 出力先がN163のときだけ渡すSA<num>自動選択
  // (n163SaForBase冒頭コメント参照)。省略時はSA無し(従来動作)。
  MML.Convert.assignPitchEnvelope = function (channels, periodFn, pitchReg, opts) {
    // このperiodFn(=呼び出し元が渡す借用先チップの生周期換算関数)自体の増減方向を
    // 1回だけ調べ、fitVibratoへ渡す(compiler.jsのperiodFnIncreasingと同じ2点比較)。
    const directionUp = periodFnIncreasingLocal(periodFn);
    const saMode = opts && opts.saMode && opts.saMode !== 'off' ? opts.saMode : null;
    for (const ch of channels) {
      for (const ev of ch.events) {
        if (ev.note === null || !ev.freqSeq || ev.freqSeq.length === 0) continue;
        const rescaled = MML.Convert.rescalePitchSeqFromFreq(ev.freqSeq, periodFn, ev);
        const saOpts = saMode
          ? { mode: saMode, baseSa: saMode === 'octave' ? MML.Convert.n163SaForBase(rescaled[0]) : 0 }
          : undefined;
        const assigned = pitchReg.assign(rescaled, directionUp, saOpts);
        MML.Convert.applyPitchAssignment(ev, assigned);
        // SAはD<n>にも効く(compiler.js pitchRegisterOffset、本家freq_add_mcknumber参照)ため、
        // この音符のDも同じシフトで縮めて出力する(量子化2^sa単位≈1〜2セント)
        if (ev.pitchSa && ev.detune) ev.detune = Math.round(ev.detune / (1 << ev.pitchSa));
      }
      // スラー分割(別プロジェクトE、2026-08-12): pitchEp/portamentoが確定した直後に
      // まとめて行う(markSlurTiesの安全ガードが両方の値を参照するため)。KSS(ay/scc)・
      // GBS(pulse/wave)・HES(wave)は全てこの共通ヘルパーを経由するため、ここ1箇所で
      // 3形式に一括で効く(Project A/Cと同じ集約点の再利用)
      MML.Convert.markSlurTies(ch.events);
    }
  };

  // pitchReg.assign()の戻り値({kind:'portamento',...}|{kind:'vibrato',...}|{kind:'ep',...}|null)
  // をevへ適用する共通ヘルパー(2026-08-11 別プロジェクトC、2026-08-15 別プロジェクトB gate解除)。
  // 呼び出し元(assignPitchEnvelope・各*2mmlのtoPitchFields相当)で同じkind分岐を
  // 重複させないためにここへ集約する。
  MML.Convert.applyPitchAssignment = function (ev, assigned) {
    if (!assigned) return;
    // SA<num>(assign()のsaOpts参照): この音符のEP/MP値が>>saで登録されているため、
    // 再生時に同じsaで戻せるようイベントへ記録する(mmlEmitがSA<n>コマンドとして出力)
    if (assigned.sa != null && assigned.sa > 0) ev.pitchSa = assigned.sa;
    if (assigned.kind === 'portamento') {
      ev.portamento = { target: assigned.target, duration: assigned.duration, delay: assigned.delay };
    } else if (assigned.kind === 'vibrato') {
      ev.vibrato = assigned.index;
    } else {
      ev.pitchEp = assigned.index;
      ev.pitchEpDelay = assigned.delay;
    }
  };

  // ── 高速アルペジオ→ノートエンベロープ(EN)統合(2026-08-14) ──────────────
  // チップチューンでは、1chしか無い音源で和音を鳴らすため「フレーム単位で複数の
  // 音程を高速に切り替える」演奏方法(アルペジオ)が非常によく使われる。抽出ループ
  // 自体は「音程(半音丸め値)が変わったら即新イベント」という規則のため、これは
  // 1フレームだけの極短いイベントの連なりとして抽出される。従来はこれをEP(生
  // レジスタ差分のピッチエンベロープ)で表現しようとしていたが、EPは「基準ノート
  // からの生レジスタオフセット」空間のテーブルであり、本来「複数の異なる音程を
  // 正確に鳴らしている」という演奏意図を表すのに適さない(値がチップ・音域ごとに
  // 意味の変わる生レジスタ単位になり、可読性も低い)。ここでは、各ステップの実測
  // 周波数が最寄りの12平均律半音に十分近い(=本当にその音程を狙って鳴らしている)
  // 場合に限り、1つの音符+EN<n>(ノート番号空間の相対オフセット、ppmck仕様通り
  // 累積値)へ統合する。セント誤差が大きい(=半音に乗っていない生々しいピッチベンド/
  // ビブラート)場合は対象外とし、従来通りEP/個別音符のままにする(実測: GBS Robocop
  // CH2冒頭のアルペジオは誤差1〜3セントで綺麗に半音に乗っており、CH1のEP0/EP4等の
  // 浅いビブラートは22〜47セットとずれているため、この閾値で正しく判別できる)。
  const MAX_ARPEGGIO_STEP_FRAMES = 8; // 1ステップがこれ以下のフレーム数なら「高速」とみなす
  const MIN_ARPEGGIO_PERIOD = 2;
  const MAX_ARPEGGIO_PERIOD = 8; // 一般的な和音の構成音数を超える周期は誤検出とみなして除外
  const MIN_ARPEGGIO_CYCLES = 2; // 最低2周期分の反復確認(偶然の一致除け)
  const ARPEGGIO_CENTS_TOLERANCE = 25; // 半音の1/4以内なら「その半音に厳密に乗っている」とみなす
  // トリル判別(mergeAlternatingVibratoの形状ゲート、同所コメント参照)
  const TRILL_MIN_CENTS = 70;          // 方形でもこれ未満の浅い変調はビブラートとして統合を許す
  const TRILL_MIDDLE_FRAC_MAX = 0.15;  // 中間帯滞在サンプル比がこれ未満なら方形(2値切替)とみなす
  const EN_VALUE_MIN = -127, EN_VALUE_MAX = 126; // @EN<n>テーブル値は符号付きbyte(lexer.js参照、EPと共通)

  // freq(Hz)が最寄りの12平均律半音(o4a=57=440Hz基準、他の抽出コードと同じ規約)から
  // 何セントずれているかを返す(-50〜+50の範囲)。
  function centsFromNearestSemitone(freq) {
    if (!(freq > 0)) return Infinity;
    // 基準ピッチ(#TUNING、src/convert/options.js MML.Convert.tuningCents)込み。抽出器の丸め
    // (freqToNote)と同じ基準で「半音に乗っているか」を判定しないと、全体ずれのある曲で
    // 綺麗なアルペジオまで「半音に乗っていない」と誤判定して EN 統合から漏れる
    const cont = 57 + 12 * Math.log2(freq / 440) - MML.Convert.tuningCents() / 100;
    return (cont - Math.round(cont)) * 100;
  }

  // 実測周波数(Hz)を保持するフィールド名はフォーマットの抽出コードによって
  // rawFreq/freqHzのどちらか一方に揺れている(toCommon内で最終的にどちらも
  // rawFreqへ揃えて出力されるが、mergeRapidArpeggioはtoCommon実行前の生イベントを
  // 見るためこの時点では揺れが残っている)。両対応にしておくことで、呼び出し側
  // フォーマット毎の個別対応を増やさずに済む。
  function eventFreq(ev) {
    return ev.rawFreq != null ? ev.rawFreq : ev.freqHz;
  }

  // absorbed(短いイベントの連なり)のnote列から、周期的に繰り返す最小周期を探す
  // (classifyPitchModのperiodic探索と同じ「最小周期優先・最低2周期分確認」方針)。
  // 見つかれば{ period, matchLen }(matchLen=absorbed先頭から実際にその周期へ
  // 一致し続けた長さ、period以上でperiodの倍数とは限らない)を返す。無ければnull。
  function findArpeggioPeriod(notes) {
    const n = notes.length;
    const maxPeriod = Math.min(MAX_ARPEGGIO_PERIOD, Math.floor(n / MIN_ARPEGGIO_CYCLES));
    for (let period = MIN_ARPEGGIO_PERIOD; period <= maxPeriod; period++) {
      let matchLen = period;
      while (matchLen < n && notes[matchLen] === notes[matchLen - period]) matchLen++;
      if (matchLen >= period * MIN_ARPEGGIO_CYCLES) return { period, matchLen };
    }
    return null;
  }

  // 周期分のnote列(cycleNotes、最後の要素が「MML本文の音符として書き出す基準ノート」
  // になる。詳細は下記)から、@EN<n>用の累積差分テーブルを作る。
  //
  // cumulativeEnvelopeValue(compiler.js)は値を毎フレーム加算していく「累積」方式で、
  // @v(stepEnvelope)のような単純な周期的インデックス参照ではない(EPも2026-09-13以降は
  // 同じ累積方式、registerShape/toCumulativeDeltas参照)。そのため
  // ループ(loop=0)で正しく繰り返すには、1周期ぶんの差分の合計が必ず0になっている
  // 必要がある(そうでないと繰り返すたびに音程がドリフトしてしまう)。
  // 「周期内の最後のノート(cycleNotes末尾)」を基準(オフセット0)に選び、
  // 差分列を「基準→note[0]→note[1]→...→note[P-2]→基準(次周期の頭)」という
  // 閉じた巡回として構成すると、和音の回り方に関わらず合計は必ず0になる
  // (P角形を1周する経路の合計変位は常に0という単純な性質)。
  // durations(各ステップのフレーム数、通常は全て1)ぶん、2フレーム目以降は
  // 差分0(保持)を挟む。
  function buildNoteEnvelopeDeltas(cycleNotes, durations) {
    const period = cycleNotes.length;
    const refNote = cycleNotes[period - 1];
    let prevOffset = 0; // 基準ノート自身のオフセット
    const deltas = [];
    for (let k = 0; k < period; k++) {
      const offset = cycleNotes[k] - refNote;
      deltas.push(offset - prevOffset);
      for (let f = 1; f < durations[k]; f++) deltas.push(0);
      prevOffset = offset;
    }
    return { refNote, deltas };
  }

  // ★和音→アルペジオ(src/input/quantize.js)でも同じ符号化を使うので公開する。
  //   EN<n>の中身の作り方が2箇所に分かれると、片方だけ直して食い違う
  MML.Convert.buildNoteEnvelopeDeltas = buildNoteEnvelopeDeltas;

  // mergeAlternatingVibratoと同じ「隣接イベント列→統合後イベント列」形式。
  // 統合したイベントには ev.noteEnvOffsets(累積差分配列)を付与する(登録・EN<n>への
  // 割当ては呼び出し元のassignNoteEnvelopeが曲全体で共有するNoteEnvelopeRegistry経由で
  // 行う。envelope.js/pitch.jsの既存レジストリと同じ「検出はここ、登録は呼び出し元」
  // という役割分担)。mergeAlternatingVibratoより先に(=優先して)呼ぶこと
  // (セントの綺麗な高速アルペジオはこちらで、それ以外の2値往復ビブラートは
  // mergeAlternatingVibratoで、と役割を分けるため)。
  MML.Convert.mergeRapidArpeggio = function (events) {
    const result = [];
    let i = 0;
    const n = events.length;
    while (i < n) {
      const home = events[i];
      const homeFreq = eventFreq(home);
      if (home.note == null || homeFreq == null ||
          (home.end - home.start) > MAX_ARPEGGIO_STEP_FRAMES ||
          Math.abs(centsFromNearestSemitone(homeFreq)) > ARPEGGIO_CENTS_TOLERANCE) {
        result.push(home); i++; continue;
      }
      // 短く・セントの綺麗な・音色が揃っている連続イベントを貪欲に集める
      // (★直接連続する同ノートはretrigger等のハード境界とみなし跨がない、
      // mergeAlternatingVibratoと同じ安全策)
      const run = [home];
      let j = i + 1;
      while (j < n) {
        const seg = events[j];
        const segFreq = eventFreq(seg);
        if (seg.note == null || segFreq == null) break;
        if ((seg.end - seg.start) > MAX_ARPEGGIO_STEP_FRAMES) break;
        if (seg.note === run[run.length - 1].note) break;
        if (Math.abs(centsFromNearestSemitone(segFreq)) > ARPEGGIO_CENTS_TOLERANCE) break;
        if (!hysteresisCompatible(seg, home)) break;
        run.push(seg);
        j++;
      }
      const found = findArpeggioPeriod(run.map(e => e.note));
      if (found) {
        const used = run.slice(0, found.matchLen);
        const cycle = used.slice(0, found.period);
        const cycleNotes = cycle.map(e => e.note);
        const durations = cycle.map(e => e.end - e.start);
        const { refNote, deltas } = buildNoteEnvelopeDeltas(cycleNotes, durations);
        if (!deltas.some(v => v < EN_VALUE_MIN || v > EN_VALUE_MAX)) {
          const last = used[used.length - 1];
          // refNote(=cycle末尾のノート)を基準ノートとしてMML本文に書き出すため、
          // rawFreq/freqSeqもhome(周期先頭)ではなくrefNoteに対応する値へ揃える
          // (揃えないと、後段のapplyPitchDetune/detectChorusDetuneがnoteとrawFreqの
          // 食い違い=無関係な2音間の周波数比較からD<n>を誤計算してしまう)。
          // rawFreq/freqHzの両方を設定するのは、フォーマットごとにtoCommon()が
          // 参照するフィールド名が揺れているため(eventFreq()コメント参照)。
          const refEvent = cycle[cycle.length - 1];
          const refFreq = eventFreq(refEvent);
          result.push(Object.assign({}, home, {
            note: refNote,
            rawFreq: refFreq,
            freqHz: refFreq,
            end: last.end,
            volSeq: concatField(used, 'volSeq'),
            // 統合前の各音符が持っていた「ハード音量エンベロープの打ち直し」位置
            // (nsf2mml/converter.js begin()のhwEnvSeq参照)。1音符=1本の減衰カーブしか
            // 持てないため、統合先で実測レベル列を組み直せるようにフレーム毎の並びのまま繋ぐ
            hwEnvSeq: concatField(used, 'hwEnvSeq'),
            // pitchSeqはhome(周期先頭の1音符ぶん、通常は極短い)のまま残すと、各*2mmlの
            // toCommon()がev.pitchSeq.map(periodFn)からfreqSeqを組み立てる際にend-startと
            // 長さの合わないデータになる。空にしておけばfreqSeq=[]となり、後段の
            // assignPitchEnvelopeが「変調無し」として安全にスキップする
            // (noteEnvOffsetsで表現済みなのでEP側の変調検出はそもそも不要)。
            pitchSeq: [],
            noteEnvOffsets: deltas
          }));
          i += used.length;
          continue;
        }
      }
      result.push(home);
      i++;
    }
    return result;
  };

  // cmd: src/convert/options.js の変換設定(省略可)。cmd.EN===false なら登録せず null
  // (アルペジオ統合済みイベントは基音1音のまま出る)。
  MML.Convert.NoteEnvelopeRegistry = function (cmd) {
    this.cmd = MML.Convert.normalizeCmd(cmd);
    this.tables = new Map(); // index(@EN<N>の番号) -> { values, loop }
    this.keyToIndex = new Map();
    this.nextIndex = 0;
  };

  // 周期的アルペジオは常にloop=0(先頭からループ、buildNoteEnvelopeDeltasが1周期分の
  // 合計0の閉じた差分列を作るため)。EnvelopeRegistry/PitchEnvelopeRegistryと同じ
  // 「loop有無が食い違うテーブルは前方一致でも共有しない」規約([[envelope-registry-loop-upgrade-bug]]
  // 参照)は、EN側は現状ループ専用(非ループ生成経路が無い)ため該当しないが、将来
  // 非ループEN生成を追加する場合はここも同じガードを入れること。
  MML.Convert.NoteEnvelopeRegistry.prototype.registerShape = function (deltas) {
    if (!deltas || deltas.length === 0 || !this.cmd.EN) return null;
    const key = deltas.join(',');
    let idx = this.keyToIndex.get(key);
    if (idx === undefined) {
      idx = this.nextIndex++;
      this.keyToIndex.set(key, idx);
      this.tables.set(idx, { values: deltas, loop: 0 });
    }
    return idx;
  };

  MML.Convert.NoteEnvelopeRegistry.prototype.defLines = function () {
    return Array.from(this.tables.keys()).sort((a, b) => a - b).map(i => {
      const t = this.tables.get(i);
      const parts = t.values.map(String);
      if (t.loop != null) parts.splice(t.loop, 0, '|');
      return `@EN${i} = { ${parts.join(' ')} }`;
    });
  };

  // assignPitchEnvelopeと対になる、mergeRapidArpeggioが付与したev.noteEnvOffsetsを
  // 曲全体で共有するNoteEnvelopeRegistryへ登録してev.noteEnvを確定する。
  // mergeRapidArpeggio自身が登録まで行わないのは、EnvelopeRegistry/PitchEnvelopeRegistry
  // と同じく複数チャンネルをまたいだ重複排除を1つの共有レジストリで行うため
  // (曲中の別チャンネル・別箇所で偶然同じ形のアルペジオが出れば1つのEN<n>にまとまる)。
  MML.Convert.assignNoteEnvelope = function (channels, noteEnvReg) {
    for (const ch of channels) {
      for (const ev of ch.events) {
        if (!ev.noteEnvOffsets) continue;
        const idx = noteEnvReg.registerShape(ev.noteEnvOffsets);
        if (idx != null) ev.noteEnv = idx;
        delete ev.noteEnvOffsets;
      }
    }
  };

  // extractEvents直後にどのフォーマットも呼んでいた「MML.Convert.mergeAlternatingVibrato(...)」
  // を置き換える統合ヘルパー。mergeRapidArpeggioを必ず先に(優先して)適用し、そこで
  // 統合されなかった残りのイベントにだけmergeAlternatingVibratoを適用する
  // (pitch.js冒頭のmergeRapidArpeggioコメント参照)。rawFreqを持たない抽出結果
  // (SPC/ノイズ/OPLL等)ではmergeRapidArpeggioは何もせず素通りするだけなので、
  // 呼び出し側を条件分岐させずに一律この関数へ差し替えて問題ない。
  // opts.maxAbsorbCents: mergeAlternatingVibratoの統合上限(同関数コメント参照)。省略時は無制限
  MML.Convert.mergeVibratoAndArpeggio = function (events, opts) {
    return MML.Convert.mergeAlternatingVibrato(MML.Convert.mergeRapidArpeggio(events), opts);
  };

  // ── 分節のヒステリシス化(DESIGN-PITCH.md Phase 2、§5手順3) ──────────────
  // 「半音丸め値が変わったら即分割」(note !== cur.note)のせいで、半音境界を跨ぐ
  // 深いビブラートが音符連打(note spam)に化ける問題を、抽出後の後処理パスとして
  // 修正する(各extractorの毎フレームループ自体は変更しない。既存のsplitRetriggers
  // と同じ「抽出→後処理パスで分割/統合」の型を踏襲)。
  //
  // 方式: 隣接するイベント列から「同じ2つの隣接ノート番号(home/alt)が交互に現れる
  // 連続区間」を貪欲に集め、連結したpitchSeqが実際に
  // MML.Convert.classifyPitchMod で周期的と判定できた場合にのみ1イベントへ統合する。
  // T(セント)/M(フレーム)の固定しきい値を新たに発明せず、Phase 1で既に実データ調整済みの
  // 周期検出(MIN_CONFIRM_FRAMES/MIN_LOOP_RANGE等)をそのまま「これは統合してよい
  // ビブラートか」の判定に流用する(判定基準を増やさずP-3の厳密周期性だけで揺れを
  // 判別する)。
  //
  // ★同じノート番号の隣接イベント(retrigger等、ハード境界由来)は絶対に跨がない
  // (実データで確認: KSSのYs1やGBSの一部曲では、ビブラートと無関係な音量打ち直しが
  // 同じ音程のまま複数イベントに分かれることがあり、これを跨いで統合すると打ち直しが
  // 消えてしまう。DMG-CVJ.gbsで実測)。「home,home」のような直接連続する同ノートは
  // 常にheam boundaryとみなし、そこで貪欲集めを打ち切る(集められた区間が短すぎれば
  // 何も統合しない=安全側)。
  //
  // ev.duty/waveKey/mode/noise/envUsed/envShape/envPeriod/modKey/constVol/envKeyの
  // いずれかが食い違う隣接イベントも統合しない(音色/エンベロープの変化は既存どおり
  // 独立した音符のまま)。
  const HYSTERESIS_HARD_KEYS = [
    'duty', 'constVol', 'envKey', 'waveKey', 'mode', 'noise',
    'envUsed', 'envShape', 'envPeriod', 'modKey',
    // FDS(nsf2mml/expansion/fds.js)専用: ハードウェア音量エンベロープの有効/無効が
    // 食い違う隣接イベントは統合しない(音量の扱いが根本的に変わるため)
    'envEnabled',
    // OPLL(kss2mml/expansion/opll.js)専用: 音色番号・VRC7カスタム音色が食い違う
    // 隣接イベントは統合しない(dutyに相当する「音色選択」がこのフィールド名のため)
    'instrument', 'vrc7Tone',
    // SPC(spc2mml/converter.js)専用: 楽器(サンプル/エンベロープ)が食い違う隣接イベントは
    // 統合しない。他形式のイベントにはこれらのキー自体が存在しないため素通りする。
    'srcn', 'adsr1', 'adsr2', 'gain'
  ];
  function hysteresisCompatible(a, b) {
    for (const k of HYSTERESIS_HARD_KEYS) {
      if ((k in a || k in b) && a[k] !== b[k]) return false;
    }
    return true;
  }
  function concatField(list, key) {
    if (!list[0] || !list[0][key]) return undefined;
    return list.reduce((acc, e) => acc.concat(e[key] || []), []);
  }

  MML.Convert.mergeAlternatingVibrato = function (events, opts) {
    const result = [];
    let i = 0;
    const n = events.length;
    while (i < n) {
      const home = events[i];
      if (home.note == null || !home.pitchSeq) { result.push(home); i++; continue; }
      let altNote = null;
      const absorbed = [home];
      let j = i + 1;
      while (j < n) {
        const seg = events[j];
        if (seg.note == null || !seg.pitchSeq) break;
        const prevNote = absorbed[absorbed.length - 1].note;
        if (seg.note === prevNote) break; // 直接連続する同ノート=ハード境界、跨がない
        if (seg.note !== home.note) {
          if (altNote === null) {
            if (Math.abs(seg.note - home.note) !== 1) break; // 隣接半音以外は対象外
            altNote = seg.note;
          } else if (seg.note !== altNote) {
            break; // 3値目が出たら対象外(こぶし・グリッサンド等はここで自然に除外される)
          }
        }
        if (!hysteresisCompatible(seg, home)) break;
        absorbed.push(seg);
        j++;
      }
      // home単体では判定しない(最低1往復=home,alt,homeの3イベント必要)
      if (absorbed.length >= 3 && altNote !== null) {
        const last = absorbed[absorbed.length - 1];
        const candidateSeq = concatField(absorbed, 'pitchSeq');
        // ★Phase 3でclassifyPitchModが非周期(literal/ramp)も返すようになったため、
        // ここは明示的に'periodic'型だけを統合の根拠とする(元々の意図どおり「規則的
        // 周期で2音を高速往復=ビブラート」だけを統合対象とし、非周期の2値往復
        // (トレモロ的な打ち直し等、周期性の裏付けが無いもの)を誤って1音化しない)。
        const classified = MML.Convert.classifyPitchMod(candidateSeq);
        // ★形状判別+統合上限(2026-08-26、DESIGN-PITCH.md §5「トリル判別」の実装):
        //
        // (1) トリル判別(形状、全フォーマット共通): LFOテーブル駆動のビブラートは中間値を
        //     通る三角/正弦状、トリル奏法は2値切替の方形状。正規化振幅の中間帯(25%〜75%)に
        //     滞在するサンプル比率(middleFrac)で判別し、方形かつ変調幅が奏法として意味を持つ
        //     深さ(TRILL_MIN_CENTS以上)なら統合せず音符の交互のまま残す。浅い2値切替
        //     (レジスタ分解能の都合で中間値を持てない境界ビブラート、数〜数十セント)は
        //     従来どおり統合する。実例: Final Fantasy(NSF)の96〜105セント方形=トリル、
        //     NX91002 idx34(HES)の149セント階段=三角ビブラート。
        //
        // (2) opts.maxAbsorbCents(フォーマット別の表現力上限): 統合された変調は後段の
        //     MP/EPテーブル(fitVibrato→ループEP→literal EPの3段構え)で再現される前提だが、
        //     テーブル値は符号付きbyte(EP_VALUE_MIN/MAX)・MP depthも1byteのため、表現可能な
        //     変調幅は借用先チップの周期単位に依存する。HES→N163借用は単位が大きく
        //     (半音≈1100周期単位)深い変調はレンジ外で割当が失敗し変調が丸ごと消えるため、
        //     フォーマット側が上限を渡して超えるものは音符の交互のまま残す(次善の近似)。
        //     省略時は無制限。
        let spanCents = 0, middleFrac = 0;
        {
          let mn = Infinity, mx = 0;
          for (const v of candidateSeq) if (v > 0) { if (v < mn) mn = v; if (v > mx) mx = v; }
          if (mn < Infinity && mx > mn) {
            spanCents = 1200 * Math.log2(mx / mn);
            const lo = mn + (mx - mn) * 0.25, hi = mn + (mx - mn) * 0.75;
            let mid = 0, n = 0;
            for (const v of candidateSeq) if (v > 0) { n++; if (v > lo && v < hi) mid++; }
            middleFrac = n > 0 ? mid / n : 0;
          }
        }
        const isTrill = spanCents >= TRILL_MIN_CENTS && middleFrac < TRILL_MIDDLE_FRAC_MAX;
        const spanOk = !(opts && opts.maxAbsorbCents != null && spanCents >= opts.maxAbsorbCents);
        if (classified && classified.type === 'periodic' && !isTrill && spanOk) {
          result.push(Object.assign({}, home, {
            end: last.end,
            volSeq: concatField(absorbed, 'volSeq'),
            // mergeRapidArpeggio側と同じ理由でフレーム毎の並びのまま繋ぐ
            hwEnvSeq: concatField(absorbed, 'hwEnvSeq'),
            pitchSeq: candidateSeq
          }));
          i = j;
          continue;
        }
      }
      result.push(home);
      i++;
    }
    return result;
  };

  // ── スラー分割(DESIGN-PITCH.md §3「レガートA→G」「こぶし」、2026-08-12) ──────
  // 現状の抽出ループは「半音丸め値が変わったら即新イベント」という境界規則自体は
  // Phase 2でも変えていない(mergeAlternatingVibratoは周期的な2値往復だけを後から
  // 再統合するだけ)ため、非周期の音程クロス(1回きりのレガート/こぶし)は既に
  // 別々のイベントとして抽出済みである。このスラー分割は「新しいプラトー検出/分割
  // アルゴリズム」ではなく、隣接イベントの境界が(a)実アタック/デューティ/エンベロープ
  // 種別変化を伴わない**純粋な音程変化のみ**で、(b)両側とも十分な長さ(プラトー)を
  // 持ち、(c)どちらの側も自前の変調(EP/PT)が既に割り当てられていない、という
  // 3条件を満たす場合に限り、独立した再アタック音符ではなくタイ(&)で繋いだ
  // レガートとして出力する後処理パス。
  //
  // 呼び出し順序: 抽出(ev.tieCandidateを立てる。純粋な音程変化での分割だったかを
  // extractor自身が記録する。他の要因では立てない)→音量/ピッチ割当て(pitchEp/
  // portamentoの確定)→本関数、の順を必ず守ること(本関数はpitchEp/portamentoが
  // 未割当のイベントしかタイの対象にしない。理由: compiler.jsのタイ処理は「新しい
  // セグメントを作らず前のセグメントを延長する」設計のため、タイで繋いだ2音目以降が
  // 独自のD/EP/MP/PTを持つことはできない(仮に出力しても再生時に無視される)。
  // よって、タイに使うと自前の変調を握りつぶすことになる候補は安全側にスキップする)。
  //
  // 「不明瞭」な場合(短すぎる/自前の変調がある)は何もしない = 従来通りの独立した
  // 再アタック音符のまま(markSlurTiesが安全に判定できるペアだけを個別にタイで繋ぐ)。
  // P-5「プラトー明瞭→スラー分割、不明瞭→EPテーブル」の不明瞭側(非周期の複数プラトーを
  // 1音+EPへ統合する側)は`mergeUnclearPitchRuns`(下記)が別途担当する。
  const MIN_SLUR_PLATEAU_FRAMES = 4; // Phase 3のMIN_LITERAL_FRAMESと同じ考え方(打鍵ジッタ除外)

  function qualifiesForSlur(ev) {
    // ev.noteEnv(2026-08-14拡張): タイで繋いだ2音目以降が独自のD/EP/MP/PTを持てないのと
    // 同じ理由でEN<n>も持てない(RD_NOTEでのtick0/累積値0への再初期化が起きないため、
    // タイ側にEN<n>を出力しても再生時に無視される)。ここで除外しないと、
    // mergeRapidArpeggioが統合したEN持ちイベントがタイ候補と誤認されて
    // mmlEmit側のEN再送出(前回状態との差分判定)がスキップされ、テーブル定義だけが
    // 出力されて実際にどの音符もEN<n>を参照しないという「検出したのに黙って
    // 捨てられる」退行になる(実測: SPC変換で発覚)。
    return !!ev && ev.note != null && (ev.end - ev.start) >= MIN_SLUR_PLATEAU_FRAMES &&
      ev.pitchEp == null && ev.portamento == null && ev.noteEnv == null && ev.vibrato == null;
  }

  MML.Convert.markSlurTies = function (events) {
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1], ev = events[i];
      // hysteresisCompatible(HYSTERESIS_HARD_KEYS、mergeAlternatingVibratoと共有)も
      // ここで再利用する: SPCのsrcn/adsr1/adsr2/gain(楽器/エンベロープ)等、tieCandidate
      // 計算だけでは拾いきれないチップ固有の「音色が変わったら別音符」制約を、
      // extractorごとに個別実装させず一箇所に集約するため
      if (ev.tieCandidate && prev.end === ev.start &&
          qualifiesForSlur(prev) && qualifiesForSlur(ev) && hysteresisCompatible(prev, ev)) {
        ev.slurTie = true;
      }
    }
    return events;
  };

  // ── P-5「不明瞭→EPテーブル」側(スラー分割の相方、2026-08-12) ──────────────
  // tieCandidateで繋がった隣接イベントの連なり(§3の「レガート/こぶし」候補)のうち、
  // 全メンバーが個々に十分な長さ(プラトー、MIN_SLUR_PLATEAU_FRAMES以上)を持つとは
  // 限らない場合(=markSlurTiesが安全側にスキップしうる「不明瞭」な連なり)、run全体を
  // 1つのイベントへ統合し、そのpitchSeqをclassifyPitchModで再分類できるか試す。
  // 再分類できれば(周期/非ループどちらでも良い)「1音+EPテーブル」表現(§3の
  // `EP4 a2`)に置き換わる。できなければ何もしない(=従来通り個々のイベントのまま。
  // markSlurTiesが安全に判定できるペアだけ個別にタイで繋ぐ、既存動作への後退)。
  // ★実際のEP登録(pitchReg.assign)はここでは行わない。統合後のpitchSeqを持つ1つの
  // イベントとして返すだけで、呼び出し元の通常のtoPitchFields相当が普段通り処理する
  // (mergeAlternatingVibratoと全く同じ「試し分類→統合、実登録は後段に委ねる」設計)。
  //
  // 呼び出し順序: 抽出(tieCandidate計算済み)→mergeAlternatingVibrato→本関数→
  // (pitchEp/portamento割当て)→markSlurTies、を必ず守ること(本関数は割当て前の
  // 生のpitchSeqを直接連結して再分類するため、割当て後には呼べない。呼び出し箇所は
  // mergeAlternatingVibratoと全く同じ12箇所、その直後に連結して呼ぶだけでよい)。
  // ★2026-08-14: 本関数は当面パススルー(無効化)する。実測(Last Bible DMG-M7J.gbs、
  // GBS波形ch→FDS借用)で2件の実害が確認された:
  //  ①上限の無いrun収集: tieCandidateの連鎖が続く限り無制限に伸び続け、短い装飾音
  //    (<4フレーム)混じりの本物のメロディ(約4秒=239フレーム)をまるごと1つのrunに
  //    飲み込んだ。EP<n>の生レジスタ差分が符号付きbyte範囲(EP_VALUE_MIN/MAX=-127〜126)を
  //    超えてpitchReg.assign()がnullを返し、mergeがそのまま握りつぶされてピッチ情報が
  //    完全に消失(pitchEp/pitchBreaksどちらにも登録されない)、音符が先頭ノートに
  //    凍りついたまま伸び続ける「音程が全く動かなくなる」不具合になっていた。
  //  ②run長に8*MIN_SLUR_PLATEAU_FRAMES(32フレーム)の上限を設けて①を塞いだ後も、
  //    E4→G4→B4→F#4のような明瞭な複数の実在ノート(E短調アルペジオ、各ノートは正確に
  //    半音上に乗っている)がclassifyPitchMod()に「ランプ/周期」として誤って連続ピッチ
  //    カーブに近似され、本来の離散音程と異なる音(実測: g/bが欠落しfが混入する等)に
  //    化ける「音を外す」不具合が発生した。classifyPitchMod()は本来「同じ音の中での
  //    こぶし/アタックベンド」のような連続的なピッチ揺れを想定した分類器であり、
  //    「複数の異なる実音符が短時間に並ぶ」ケース(本関数がmarkSlurTiesの補完として
  //    対象にしたかったはずの範囲)の判別に十分な精度が無いことが分かった。
  // 通常のタイ機構(markSlurTies→pushNoteのpitchBreaks)は十分な長さ(MIN_SLUR_PLATEAU_
  // FRAMES以上)を持つ音符同士なら正確にレガート表現できることを実測確認済みなので、
  // 「不明瞭(短すぎる)音符が混じる連なりは無理に1つへ統合せず、個々のイベントのまま
  // 独立した音符として出力する」という安全側(近似ゼロ、劣化なし)に倒す。
  MML.Convert.mergeUnclearPitchRuns = function (events) { return events; };

})(globalThis);

/*
 * 音源非依存: 専用アタックレジスタを持たないチップ(N163, FME7等)向けの、
 * 同一ピッチ内での「打ち直し(ロール奏法)」検出。
 *
 * N163やFME7(AY-3-8910互換)は2A03/VRC6/MMC5の長さカウンタ+アタック専用書込みや、
 * VRC7のキーオン、FDSの音量エンベロープ回路のような「ノートオン」のハードウェア概念を
 * 持たず、CPUが直接音量レジスタを書き換えるだけの素朴な発振器である。そのため
 * 「同じ音程・同じ波形/モードのまま音量だけリセットして音符を打ち直す」ロール奏法と、
 * 「同じ音程のまま音量が緩やかに上下するトレモロ」を、ピッチ/波形の変化だけを見る
 * 抽出処理では区別できず、ロールを1本の長い音符に誤結合してしまう
 * (女神転生II 25曲目、N163 Sパートで実測・報告。11曲目のN163ベースも当初トレモロと
 * 誤解釈していたが実際はロールだったとユーザー確認済み)。
 *
 * 判定方針(ユーザーとの設計検討の結論):
 *   A. 単フレームのジャンプ量: 前フレームよりopts.jumpThreshold以上音量が増えたら
 *      打ち直しの合図とする(周期性が無くても機能する。単発の打ち直しにも対応できる
 *      唯一の手段)。
 *   B. 周期の起伏+振幅: 音量列に繰り返し周期がある場合、1周期の中で「山から谷まで
 *      (立ち下がり)」「谷から次の山まで(立ち上がり、周期をまたぐ)」何フレームか、
 *      振幅(山-谷)がどれだけかを見る。トレモロは立ち上がり・立ち下がりが同程度の
 *      時間をかける(対称)のに対し、ロールは立ち下がりだけゆっくりで立ち上がりは
 *      ほぼ一瞬(非対称)、かつ振幅もその音符全体の最大音量付近まで戻る。
 *
 *   AとBは同じ判定を別の方法でやっているのではなく守備範囲が違う: Bは周期が
 *   検出できて初めて使える(最低3周期分の一致が必要、envelope.jsのループ判定と同じ
 *   考え方)。周期が見つかりBで「ロールらしい」と判定できた区間はBの結果(周期ごとの
 *   機械的な分割)を採用し、それ以外(周期が見つからない、または見つかったが
 *   トレモロと判定された)はAに任せる。両者を突き合わせて多数決するのではなく、
 *   担当領域を分けることで「判定が食い違ったらどうするか」という問題自体を無くしている。
 *
 * MML.Convert.splitRetriggers(volSeq, opts) -> [{start, end}, ...]
 *   volSeq: 同一ピッチ・同一波形/モードの区間のフレーム毎の生音量値(0始まりのローカル配列)
 *   opts.jumpThreshold (既定2): Aの閾値
 *   opts.minPeriod/maxPeriod/minRepeats/maxSearchStart: Bの周期探索パラメータ。
 *     envelope.jsのループ探索と考え方は同じだが、この用途向けに別定数として独立させて
 *     いる(ロール奏法とトレモロ効果の実測される周期長の傾向が異なりうるため、
 *     チューニングを混ぜない)。
 *   戻り値: volSeq を start/end (半開区間、volSeq自身のインデックス基準) に分割した配列。
 *     呼び出し側はこの範囲ごとにvolSeqをスライスして別々の音符イベントとして扱うこと。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const DEFAULT_JUMP_THRESHOLD = 2;
  // ★抽出パス1(音程変化の境界)からも同じ基準を使うために公開する(2026-08-26)。
  // アタックレジスタを持たないチップ(N163・HES PSG)は「音量の跳ね上がり」だけが
  // 打ち直しの手がかりだが、splitRetriggersは同一音程ラン内(パス2)しか走らないため、
  // 音程が変わる境界での再アタックは各extractorのpureNoteChange判定側で見る必要がある
  // (見落とすと、実際は打ち直している音程変化をレガートと誤認してタイ(&)で繋いでしまい、
  // タイ側では@v等を再指定しない仕様のため音量エンベロープが減衰し続ける。
  // 実測: 女神転生II 12曲目のN163 Q/Rパートで発覚)。
  MML.Convert.RETRIGGER_JUMP_THRESHOLD = DEFAULT_JUMP_THRESHOLD;
  const DEFAULT_MIN_PERIOD = 2;
  const DEFAULT_MAX_PERIOD = 48;
  const DEFAULT_MIN_REPEATS = 3;
  const DEFAULT_MAX_SEARCH_START = 96;
  const RISE_RATIO_DIVISOR = 3;       // 立ち上がりが周期の1/3以下ならロールらしいとみなす
  const MIN_AMPLITUDE = 2;            // 振幅がこれ未満ならロールとはみなさない
  const PEAK_NEAR_MAX_TOLERANCE = 1;  // 山がこの範囲内で全体最大値に近ければ「フルで戻った」とみなす

  // envelope.jsのisPeriodicFromと同じ考え方だが、この用途向けにパラメータを独立させて
  // 別途持つ(意図的に共有しない。用途によってチューニングしたい値が変わりうるため)。
  function findRepeatingPeriod(seq, minPeriod, maxPeriod, minRepeats, maxSearchStart) {
    const n = seq.length;
    const searchLimit = Math.min(n, maxSearchStart);
    for (let start = 0; start < searchLimit; start++) {
      const remain = n - start;
      const maxP = Math.min(maxPeriod, Math.floor(remain / minRepeats));
      for (let period = minPeriod; period <= maxP; period++) {
        let ok = true;
        for (let i = start + period; i < n; i++) {
          if (seq[i] !== seq[i - period]) { ok = false; break; }
        }
        if (ok) return { start, period };
      }
    }
    return null;
  }

  // 1周期分の値(cycle)を見て「ロール(アタックの繰り返し)らしいか」を判定する(Method B)。
  // 山(peak)は周期の先頭側、谷(trough)は周期の末尾側にあるという実測パターン
  // (例: 5,5,5,4,3,3,3,3,2,2)を前提に、立ち下がり(peak→trough)と立ち上がり
  // (trough→次周期のpeak、周期をまたぐ分)のフレーム数を比較する。
  function isAttackLikeCycle(cycle, overallMax) {
    const period = cycle.length;
    const peakVal = Math.max(...cycle);
    const peakIdx = cycle.indexOf(peakVal);
    const troughVal = Math.min(...cycle);
    const troughIdx = cycle.lastIndexOf(troughVal);
    const fallFrames = Math.max(0, troughIdx - peakIdx);
    const riseFrames = period - fallFrames;
    const amplitude = peakVal - troughVal;
    return riseFrames * RISE_RATIO_DIVISOR <= period &&
      amplitude >= MIN_AMPLITUDE &&
      peakVal >= overallMax - PEAK_NEAR_MAX_TOLERANCE;
  }

  // Method A: 前フレームよりthreshold以上音量が増えた地点で区切る
  function splitByJump(seq, threshold, offset) {
    const ranges = [];
    let segStart = 0;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] - seq[i - 1] >= threshold) {
        ranges.push({ start: offset + segStart, end: offset + i });
        segStart = i;
      }
    }
    ranges.push({ start: offset + segStart, end: offset + seq.length });
    return ranges;
  }

  MML.Convert.splitRetriggers = function (volSeq, opts) {
    opts = opts || {};
    const jumpThreshold = opts.jumpThreshold != null ? opts.jumpThreshold : DEFAULT_JUMP_THRESHOLD;
    const n = volSeq.length;
    if (n <= 1) return [{ start: 0, end: n }];

    const period = findRepeatingPeriod(
      volSeq,
      opts.minPeriod || DEFAULT_MIN_PERIOD,
      opts.maxPeriod || DEFAULT_MAX_PERIOD,
      opts.minRepeats || DEFAULT_MIN_REPEATS,
      opts.maxSearchStart || DEFAULT_MAX_SEARCH_START
    );

    if (period) {
      const cycle = volSeq.slice(period.start, period.start + period.period);
      const overallMax = Math.max(...volSeq);
      if (isAttackLikeCycle(cycle, overallMax)) {
        // 周期部分は機械的に1周期=1音符として分割。その手前(リード部分)だけMethod Aを適用
        const ranges = period.start > 0 ? splitByJump(volSeq.slice(0, period.start), jumpThreshold, 0) : [];
        let i = period.start;
        while (i < n) {
          const end = Math.min(i + period.period, n);
          ranges.push({ start: i, end });
          i = end;
        }
        return ranges.filter(r => r.end > r.start);
      }
      // トレモロ判定: 分割せず1つの音符のまま(周期はanalyzeVolumeShape側で改めて検出される)
      return [{ start: 0, end: n }];
    }

    // 周期が見つからない: 全区間をMethod A(単フレームジャンプ)だけで判定
    return splitByJump(volSeq, jumpThreshold, 0);
  };
})(globalThis);

/*
 * 音色の同定キー — MML.Convert.ToneKey (2026-09-09、音色別指定「音色一覧」の土台)
 *
 * 「変換元チャンネルの中で使われている音色(楽器)1つ」を、形式に依らない文字列キーで同定する。
 * 設定(src/convert/toneSettings.js)はこのキーで持つので、同じ音色が別チャンネルに出ても・
 * 同じゲームの別トラックでも同じ設定が効く(DPCMパッドの「サンプル内容ハッシュ」と同じ考え方。
 * src/convert/drumSamples.js 冒頭参照)。
 *
 * キーの形(先頭の種別で見分ける):
 *   'brr:<hash>'    SPCのBRRサンプル(MML.SPC2MML.brrHash と同じ値)
 *   'pcm:<hash>'    VGMのサンプルPCM(Emu.SamplePitchUtil.sampleHash)
 *   'opn:<hash>'    OPN/OPM系4op FM音色(キャリアのTLは音量なので除いて同定)
 *   'opll:<n>'      OPLL/VRC7の内蔵音色 @1-@15
 *   'opllc:<hash>'  OPLL/VRC7 自作音色(レジスタ$00-$07の8バイト)。OPL(2op)の音色はOPLL形式へ
 *                   変換済みのバイト列で同定する(抽出器 kss2mml/expansion/opl.js が変換する)
 *   'wave:<hash>'   波形メモリ(SCC/GB波形/HuC6280/N163/FDS)。32点・0..15へ正規化してから同定
 *   'duty:<n>'      デューティ矩形波(2A03/MMC5/GB=0-3、VRC6=0-7)
 *   'sq:<chip>'     デューティ固定の矩形波(AY/SN76489)。チップに1音色
 *   'tri' / 'saw' / 'noise' / 'sample'  音色の区別を持たない行
 *
 * ★同じ音色を「抽出器のイベント」(ofEvent)と「鍵盤/ロールのライブ状態」(ofLive)の両方から
 *   同じキーに落とせることが要件。ロールのノートに載せたキーで音色一覧を組み、変換側は
 *   イベントから引いた同じキーで設定を適用する。片方だけ変えるとキーが食い違って設定が効かなくなる。
 *
 * Worker(ロール構築 src/audio/roll-builders.js)でも動かすのでDOM/localStorageは触らない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const WAVE_LEN = 32;

  // FNV-1a 32bit(整数列)。sampleHash と同じ系のハッシュだが入力が整数配列なので別実装
  function fnv(values, seed) {
    let h = seed === undefined ? 0x811c9dc5 : seed;
    for (let i = 0; i < values.length; i++) {
      const v = values[i] | 0;
      h ^= v & 0xff; h = Math.imul(h, 0x01000193);
      h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  /** 任意長・任意値域の1周期波形 → 32点・0..15 の正規化波形(同定と表示に使う) */
  function normalizeWave(data) {
    if (!data || !data.length) return null;
    const n = data.length;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = +data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const out = new Array(WAVE_LEN);
    if (!(hi > lo)) { out.fill(8); return out; }
    for (let i = 0; i < WAVE_LEN; i++) {
      const v = +data[Math.floor(i * n / WAVE_LEN)];
      out[i] = Math.max(0, Math.min(15, Math.round((v - lo) / (hi - lo) * 15)));
    }
    return out;
  }
  function waveKey(data) {
    const w = normalizeWave(data);
    return w ? 'wave:' + fnv(w) : null;
  }

  // ── OPN/OPM 4op ───────────────────────────────────────────────────
  // 各アルゴリズムのキャリア(出力に直結するop、論理op番号0-3)。キャリアのTLは音量なので同定から外す
  const OPN_CARRIERS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
  const OP_FIELDS = ['DT', 'ML', 'TL', 'KS', 'AR', 'DR', 'SR', 'SL', 'RR', 'AM', 'SE', 'DT2'];
  function opnKey(p) {
    if (!p || !p.ops || !p.ops.length) return null;
    const alg = (p.AL || 0) & 7;
    const carriers = OPN_CARRIERS[alg];
    const vals = [alg, (p.FB || 0) & 7];
    for (let i = 0; i < p.ops.length; i++) {
      const o = p.ops[i] || {};
      for (const f of OP_FIELDS) {
        let v = o[f];
        if (v === undefined) v = 0;
        if (f === 'TL' && carriers.indexOf(i) >= 0) v = 0;
        vals.push(v);
      }
    }
    return 'opn:' + fnv(vals);
  }

  // ── OPLL/VRC7 ─────────────────────────────────────────────────────
  // {mod, car} 形式の音色 → レジスタ$00-$07の8バイト(src/ui/keyboard.js opllPatchBytes と同じ並び)
  function opllBytesOf(p) {
    const m = p && p.mod, c = p && p.car;
    if (!m || !c) return null;
    return [
      ((m.AM & 1) << 7) | ((m.PM & 1) << 6) | ((m.EG & 1) << 5) | ((m.KR & 1) << 4) | (m.ML & 15),
      ((c.AM & 1) << 7) | ((c.PM & 1) << 6) | ((c.EG & 1) << 5) | ((c.KR & 1) << 4) | (c.ML & 15),
      ((m.KL & 3) << 6) | (m.TL & 63),
      ((c.KL & 3) << 6) | ((c.WF & 1) << 4) | ((m.WF & 1) << 3) | (m.FB & 7),
      ((m.AR & 15) << 4) | (m.DR & 15),
      ((c.AR & 15) << 4) | (c.DR & 15),
      ((m.SL & 15) << 4) | (m.RR & 15),
      ((c.SL & 15) << 4) | (c.RR & 15),
    ];
  }
  function opllCustomKey(bytes) {
    if (!bytes || bytes.length < 8) return null;
    return 'opllc:' + fnv(Array.from(bytes).slice(0, 8));
  }
  function opllKey(inst, bytes) {
    const n = inst | 0;
    if (n > 0 && n <= 15) return 'opll:' + n;
    return opllCustomKey(bytes);
  }

  // ── 抽出器イベント → キー ─────────────────────────────────────────
  // ctx: { chip, kind, brrSamples? }(borrow.js の source s をそのまま渡せる)
  // 抽出器がイベントに載せる同定情報:
  //   ev.srcn(SPC) / ev.sampleHash(VGM PCM) / ev.opnPatch(OPN系) / ev.srcTone(OPLL/OPL 8バイト) /
  //   ev.instrument(OPLLの内蔵音色番号・GB/2A03デューティ) / ev.srcWave(波形メモリの生波形)
  function ofEvent(ev, ctx) {
    if (!ev || ev.note === null) return null;
    const chip = ctx && ctx.chip;
    if (ev.srcn !== undefined && ctx && ctx.brrSamples) {
      const h = MML.SPC2MML && MML.SPC2MML.brrHash ? MML.SPC2MML.brrHash(ctx.brrSamples[ev.srcn]) : null;
      return h ? 'brr:' + h : 'brr:srcn' + ev.srcn;
    }
    if (ev.sampleHash) return 'pcm:' + ev.sampleHash;
    if (ev.opnPatch) return opnKey(ev.opnPatch);
    if (chip === 'ym2413' || chip === 'opl' || chip === 'vrc7') {
      if (ev.srcTone) return opllCustomKey(ev.srcTone);
      if (ev.instrument > 0) return 'opll:' + (ev.instrument & 15);
      return null;
    }
    if (ev.srcWave) return waveKey(ev.srcWave);
    if (chip === 'ay8910' || chip === 'sn76489') return 'sq:' + chip;
    if (chip === 'gb' && ctx.kind === 'square') return ev.instrument !== undefined ? 'duty:' + (ev.instrument & 3) : 'duty:2';
    return null;
  }

  // ── 鍵盤/ロールのライブ状態(extractChannels の1行) → キー ─────────────────
  // 同定に使うのは: ch.fmPatch(OPN/OPM/OPLL) / ch.sampleHash(サンプルPCM) / ch.wave(波形) / ch.duty
  const patchKeyCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function ofLive(ch) {
    if (!ch) return null;
    if (ch.srcn !== undefined && ch.brrHash) return 'brr:' + ch.brrHash;
    if (ch.sampleHash) return 'pcm:' + ch.sampleHash;
    const p = ch.fmPatch;
    if (p) {
      if (patchKeyCache && typeof p === 'object') {
        const c = patchKeyCache.get(p);
        if (c !== undefined) return c;
      }
      let k = null;
      if (p.type === 'opll') k = opllKey(p.inst, opllBytesOf(p));
      else if (p.ops) k = opnKey(p);
      if (patchKeyCache && typeof p === 'object') patchKeyCache.set(p, k);
      return k;
    }
    const w = ch.wave;
    if (ch.noise) return 'noise';
    if (!w) return null;
    if (w.t === 'wave' && w.data && w.data.length) return waveKey(w.data);
    if (w.t === 'pulse') {
      if (ch.duty !== undefined && ch.duty !== null) return 'duty:' + ch.duty;
      if (/^(KP|SN)\d/.test(ch.id || '')) return 'sq:' + (/^SN/.test(ch.id) ? 'sn76489' : 'ay8910');
      return null;
    }
    if (w.t === 'tri') return 'tri';
    if (w.t === 'saw') return 'saw';
    if (w.t === 'sample') return 'sample';
    return null;
  }

  // ── 表示・試聴用の付随情報(キーだけでは音が作れないので、初出時に一緒に控える) ────
  //   { kind:'brr'|'pcm'|'opn'|'opll'|'wave'|'duty'|'sq'|'other', label, wave?(32点0..15), patch?, bytes?, inst?, duty? }
  function infoOfLive(ch, key) {
    if (!key) return null;
    const kind = key.split(':')[0];
    const info = { kind: kind === 'opllc' ? 'opll' : kind, label: '' };
    const p = ch.fmPatch;
    if (info.kind === 'opll' && p) {
      info.inst = p.inst | 0;
      info.bytes = opllBytesOf(p);
      info.label = info.inst > 0 ? '@' + info.inst : 'OP';
    } else if (info.kind === 'opn' && p) {
      info.patch = p;
      info.label = 'FM' + (p.AL !== undefined ? ' AL' + p.AL : '');
    } else if (info.kind === 'wave' && ch.wave && ch.wave.data) {
      info.wave = normalizeWave(ch.wave.data);
      info.label = 'wave';
    } else if (info.kind === 'duty') {
      info.duty = ch.duty | 0;
      info.label = 'duty ' + info.duty;
    } else if (info.kind === 'sq') {
      info.label = 'square';
    } else if (info.kind === 'pcm') {
      info.sample = ch.adpcmSample || null;
      info.label = 'PCM';
    }
    return info;
  }
  function infoOfEvent(ev, ctx, key) {
    if (!key) return null;
    const kind = key.split(':')[0];
    const info = { kind: kind === 'opllc' ? 'opll' : kind, label: '' };
    if (info.kind === 'opll') {
      if (ev.srcTone) { info.bytes = Array.from(ev.srcTone).slice(0, 8); info.inst = 0; info.label = 'OP'; }
      else { info.inst = ev.instrument | 0; info.label = '@' + info.inst; }
    } else if (info.kind === 'opn') {
      info.patch = ev.opnPatch; info.label = 'FM AL' + (ev.opnPatch.AL | 0);
    } else if (info.kind === 'wave') {
      info.wave = normalizeWave(ev.srcWave); info.label = 'wave';
    } else if (info.kind === 'duty') {
      info.duty = ev.instrument | 0; info.label = 'duty ' + info.duty;
    } else if (info.kind === 'sq') {
      info.label = 'square';
    } else if (info.kind === 'brr') {
      info.srcn = ev.srcn; info.label = 'srcn' + ev.srcn;
    } else if (info.kind === 'pcm') {
      info.label = 'PCM';
    }
    return info;
  }

  /** 設定を持てるキーか(音色の区別が無い 'tri'/'saw'/'noise'/'sample' は対象外) */
  function isAssignable(key) {
    return !!key && /^(brr|pcm|opn|opll|opllc|wave|duty|sq):/.test(key);
  }

  MML.Convert.ToneKey = {
    WAVE_LEN, fnv, normalizeWave, waveKey, opnKey, opllBytesOf, opllKey, opllCustomKey,
    ofEvent, ofLive, infoOfLive, infoOfEvent, isAssignable,
  };
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * ピアノロール タイムライン構築(全フォーマット共通・純粋関数)
 * MML.RollBuild
 *
 * 元はmain.jsのbuildXxxRollTimeline群(+keyboard.jsのbuildRollTracksFromRegSnapshots)
 * としてメインスレッド専用だったが、キャプチャWorker化に伴い「1回あたりO(曲全体)の
 * タイムライン構築」がメインスレッドの長タスク(実測~90ms=オーディオバッファ級)として
 * 残ったため、構築そのものをキャプチャWorker内で実行できるようここへ分離した
 * (README-worker-build.txt参照)。メインスレッド(Workerフォールバック時)とWorker
 * バンドルの両方から同じコードが使われる。
 *
 * 依存(すべて実行時参照なので読み込み順は問わない。Workerバンドルには
 * tools/build-capture-workers.ps1が対応フォーマットぶんだけ同梱する):
 *   nsf/vgm: MML.UI.buildRollTracksFromRegSnapshots (src/ui/keyboard.js)
 *   kss/vgm: MML.Kss2MmlExpansion.ay/scc/opll (+MML.Convert: convert/pitch.js)
 *   gbs/vgm: MML.Gbs2MmlExpansion.pulse/noise/wave
 *   hes/vgm: MML.Hes2MmlExpansion.wave/noiseChannel/extractDdaClips
 *   spc:     MML.SPC2MML.extractVoiceEvents
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const RollBuild = MML.RollBuild = MML.RollBuild || {};

  // ── 高速アルペジオ(@EN)の展開 ────────────────────────────────────────
  // MML.Convert.mergeRapidArpeggio(src/convert/pitch.js)は、フレーム単位で音程が
  // 周期的に切り替わる高速アルペジオを「基準ノート1音 + ev.noteEnvOffsets(=@EN<n>、
  // フレーム毎の累積半音差分)」へ畳む。MML本文としてはそれが正しい表現だが、
  // ロールはそのイベントをそのまま描くため、基準ノート1本の長い帯になり、毎フレームの
  // 実レジスタ値を出している鍵盤表示と見た目が食い違う
  // (Space Manbow(MSX) 60曲目のSCC ch3=Rで実測。3.2秒以降のアルペジオ全域)。
  // @ENは「前フレームからの半音差分」なので基準ノートから順に足し込めば元の音程列が
  // 完全に復元でき、それは実レジスタ列とも(MMLを再生したときの実発音とも)一致する。
  // deltas省略時は分割せず元の1区間をそのまま返すので、呼び出し側は無条件に通してよい。
  RollBuild.expandNoteEnv = function (start, end, note, deltas) {
    if (!deltas || !deltas.length) return [{ start, end, note }];
    const out = [];
    let cur = note;
    let segStart = start;
    for (let f = start; f < end; f++) {
      const d = deltas[(f - start) % deltas.length];
      if (!d) continue;
      if (f > start) { out.push({ start: segStart, end: f, note: cur }); segStart = f; }
      cur += d;
    }
    out.push({ start: segStart, end, note: cur });
    return out;
  };

  // ── SPC ──────────────────────────────────────────────────────────────
  // drumKinds(省略可): srcn → 'drum' | 'pitch' の手動上書き(main.jsがBRR内容ハッシュで引く)。
  // 打楽器と判定したsrcnの発音は音程ノートではなく drumKey 付きノート(ドラム区画/パッド)に
  // する。判定はMML変換と同じ MML.SPC2MML.drumSrcns(ロール=MML変換デバッガの方針)。
  // 音色キー(src/convert/toneKey.js)をロールのノートに載せ、トラックの tones 表に表示/試聴用の
  // 付随情報を控える(音色一覧パネル src/ui/tonePanel.js の材料。main.js rebuildToneInventory)。
  // ★ノートに載せるのは文字列キーだけ(Workerからの構造化複製で運ぶ量を増やさない)。
  //   付随情報は音色ごとに1回、トラックオブジェクトのプロパティ tones に置く(配列に生やした
  //   プロパティは複製で消えるので、必ずトラック(オブジェクト)側に置く)
  RollBuild.toneOf = function (ev, ctx, tones) {
    const TK = MML.Convert && MML.Convert.ToneKey;
    if (!TK || !ctx) return undefined;
    const k = TK.ofEvent(ev, ctx);
    if (!k) return undefined;
    if (tones && !tones[k]) tones[k] = TK.infoOfEvent(ev, ctx, k);
    return k;
  };

  RollBuild.spc = function (log, frameRate, srcnFineTune, drumKinds) {
    const frameDur = 1 / frameRate;
    // MML変換と同じ原音チューニング補正を渡し、ロール表示の音程も実機発音に一致させる
    // (ロール=MML変換デバッガの方針。補正マップは再生開始時に一度だけ算出して使い回す)。
    const voiceEvents = MML.SPC2MML.extractVoiceEvents(log, { srcnFineTune });
    const drumSrcns = (drumKinds !== false && MML.SPC2MML.drumSrcns)
      ? MML.SPC2MML.drumSrcns(voiceEvents, srcnFineTune, drumKinds || null) : new Set();
    let drumSeq = 0;
    return voiceEvents.map((events, ch) => ({
      id: `V${ch}`,
      color: `hsl(${ch * 45},90%,65%)`,
      notes: events
        .filter(e => e.pitchSemi !== null)
        // 打楽器サンプルの発音: 音程軸ではなくドラム区画へ(midi無し、drumKey='brr:<srcn>')
        .map(e => (!e.non && drumSrcns.has(e.srcn))
          ? { drum: true, startSec: e.frame * frameDur, endSec: (e.frame + e.len) * frameDur, midi: null,
              drumKey: 'brr:' + e.srcn, drumSeq: ++drumSeq, vol: Math.max(0, Math.min(1, (e.vol || 0) / 127)), freqSeq: [] }
          : e)
        // 音量シェーディング用の簡易近似: ADSRモード(adsr1 bit7=1)ならサスティンレベル(adsr2 bit5-7、
        // 0-7)を目安の音量とする。GAINモード(直接指定)は減衰カーブを追わず常に最大音量扱い。
        // pitchSemi は note-number 空間(57=A4=MIDI69)なので MIDI へは +12。
        .reduce((acc, e) => {
          if (e.drum) { acc.push(e); return acc; } // ドラム区画のノートはそのまま
          // freqSeq(セント偏差オーバーレイ用): DSPピッチレジスタ(pitch=0x1000で原音32kHz)を
          // pitchToSemitone(src/spc2mml/converter.js)と同じ式でHzへ変換する。
          const tune = (srcnFineTune && srcnFineTune[e.srcn]) || 0;
          const tuneFactor = Math.pow(2, (tune + 3) / 12);
          const vol = (e.adsr1 & 0x80) ? (((e.adsr2 >> 5) & 7) / 7) : 1;
          const freqSeq = (e.pitchSeq || []).map(p => 440 * (p / 4096) * tuneFactor);
          // @EN(高速アルペジオ)統合済みイベントはフレーム単位の音程列へ戻す
          // (RollBuild.expandNoteEnv参照。未統合イベントは1区間のまま素通りする)
          const steps = RollBuild.expandNoteEnv(e.frame, e.frame + e.len, e.pitchSemi + 12, e.noteEnvOffsets);
          for (let si = 0; si < steps.length; si++) {
            acc.push({
              startSec: steps[si].start * frameDur, endSec: steps[si].end * frameDur, midi: steps[si].note,
              vol, freqSeq: si === 0 ? freqSeq : [],
              // srcn: 借用先にE(DPCM)を選んだボイスをロール上でパッドへ置き換えるのに使う
              // (main.js applySynthDrumToRoll。ノートからBRRサンプルを特定できるのはこれだけ)
              srcn: e.srcn,
            });
          }
          return acc;
        }, []),
    }));
  };

  // ── KSS ──────────────────────────────────────────────────────────────
  // headerがSCCデコーダを持ちうる構成か(16Kバンク+RAMモードはバス側でSCCが殺される)
  RollBuild.kssHasSccDecoder = function (header) {
    return !!header && !(header.bankMode === '16K' && header.device.ramMode);
  };

  // writeLogのフレーム範囲[from,to)にSCC音源レジスタ(周波数/音量/有効ビット)への
  // 書込みがあるか。波形テーブルはクリア目的で0書きされることがあるため判定材料にせず、
  // 実際に発音に効くレジスタだけを見る。classic(SCC)は0x80-0x8F、SCC+(SCC-I)は
  // 0xA0-0xAF側も見る。
  RollBuild.kssWriteLogUsesScc = function (writeLog, from, to) {
    for (let f = from; f < to && f < writeLog.length; f++) {
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite)
      for (const pw of writeLog[f]) {
        if ((pw >> 24) & 1) continue;
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF;
        const off = (addr >= 0x9800 && addr <= 0x98FF) ? addr - 0x9800
          : (addr >= 0xB800 && addr <= 0xB8FF) ? addr - 0xB800 : -1;
        if (off < 0 || value === 0) continue;
        if ((off >= 0x80 && off <= 0x8F) || (off >= 0xA0 && off <= 0xAF)) return true;
      }
    }
    return false;
  };

  // PSG→KP/SCC→KS/FMPAC→KF は src/ui/keyboard.js の extractChannels() の色分けと揃える。
  // clockOverride(省略可): AY/SCC抽出器に渡すZ80相当クロック。KSSは常にMSXの3.58MHz、
  // VGMはチップごとに違う(vgmPlayer.js captureVgmSongAsync の kss.clock)ので呼び出し側が渡す。
  // oplOpts(省略可): { used, clock, adpcm } — OPL系(KSSのMSX-AUDIO / VGMのYM3812・YM3526・
  // Y8950)のOL行を作る。KSSは header.device.msxAudio から、VGMは data.kss.opl/oplClock から。
  RollBuild.kss = function (writeLog, totalFrames, frameRate, header, sccUsed, clockOverride, oplOpts) {
    const frameDur = 1 / frameRate;
    const clock = clockOverride || (MML.KSS ? MML.KSS.Z80_CLOCK : 3579545);
    // volume は ay/scc/opll いずれも0-15(4bit)なので/15で0-1に正規化する。
    // ★2026-08-22: ただし **OPLLだけ向きが逆**。AY/SCCの音量は「大きいほど大音量」だが、
    // OPLLのレジスタ$30下位4bitは減衰値で0が最大音量・15が無音(3dB/step)。
    // レジスタ生値の向きは変えられない(MML変換が v<n> をそのまま $30 のニブルへ書き戻す
    // 往復経路になっている。src/mml/compiler.js segmentsToWriteLogVrc7 の
    // `(instrument << 4) | seg.volume`、src/vgm2mml/converter.js の `ev.volume * 3` 参照)。
    // そのため反転はこの表示用正規化の中だけで行う。
    // note: Kss2MmlExpansionのfreqToNoteNumberはMML変換共通のノート番号体系(57=A4)で、
    // 標準MIDIより1オクターブ(12)低い。鍵盤描画に合わせるロール側でのみ+12補正する。
    // ★抽出イベントは「音量が1でも変わったら別イベント」に切れているため、音程が同じまま
    // 途切れず続いている区間を1本の音符に統合する(retriggerだけは区切りとして残す)。
    const toNotes = (events, attenuated, ctx, tones) => {
      const norm = (v) => {
        const n = Math.max(0, Math.min(15, v || 0));
        return (attenuated ? (15 - n) : n) / 15;
      };
      // ノイズ行(AYの@2)は note がノイズ周期そのもの(ppmckのFME-7仕様)なので、
      // そのまま +12 すると MIDI_MIN(24) を下回って描画されない。抽出器が付けてくれる
      // noiseRollIndex(0-15)を使い、他チップのノイズ行と同じ C1〜D#2 に並べる
      // (keyboard.js noisePeriodIndexToMidi と同じ 24+idx)。
      const midiOf = (e) => (e.noiseRollIndex !== undefined) ? 24 + e.noiseRollIndex : e.note + 12;
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        // @EN(高速アルペジオ)統合済みイベントはフレーム単位の音程列へ戻す
        // (RollBuild.expandNoteEnv参照。未統合イベントは1区間のまま素通りする)。
        // freqSeq(セント偏差オーバーレイ)と retrigger は元イベント先頭の区間にだけ効く。
        const steps = RollBuild.expandNoteEnv(e.start, e.end, midiOf(e), e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && !(e.retrigger && si === 0) && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, norm(e.volume));
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: norm(e.volume), freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    // 音色キー付きのトラック(ctx は toneKey.js ofEvent の文脈=チップと種別)
    const mk = (id, color, events, attenuated, ctx) => { const tones = {}; return { id, color, notes: toNotes(events, attenuated, ctx, tones), tones }; };

    const ayResult = MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock);
    const KP_COLS = ['#66ddff', '#33aaff', '#0077dd'];
    ayResult.channels.forEach((ch, i) => tracks.push(mk(`KP${i + 1}`, KP_COLS[i], ch.events, false, { chip: 'ay8910', kind: 'square' })));

    // SCC未使用の曲では鍵盤表示側にもKS行を出さないので、ロールのトラックも作らない
    // (トラックidと鍵盤の行が1対1で対応している必要がある)
    if (sccUsed) {
      const sccResult = MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock);
      sccResult.channels.forEach((ch, i) => tracks.push(mk(`KS${i + 1}`, `hsl(${(280 + i * 20) % 360},80%,60%)`, ch.events, false, { chip: 'k051649', kind: 'wave' })));
    }

    if (header && header.device.mode === 'MSX' && header.device.fmpac) {
      const opllResult = MML.Kss2MmlExpansion.opll(writeLog, totalFrames);
      const KF_COLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc','#ffd9a0','#ffe0b0','#ffe8c0'];
      // 第2引数true = OPLLの音量は減衰値なので表示用に反転する(toNotes冒頭のコメント参照)
      opllResult.channels.forEach((ch, i) => tracks.push(mk(`KF${i + 1}`, KF_COLS[i % KF_COLS.length], ch.events, true, { chip: 'ym2413', kind: 'fm' })));
      // リズムモードの打楽器5行。id/色/並び順は鍵盤側(keyboard.js の kssOpll 分岐、
      // RCOLS/RLABEL)と1対1で合わせる。音程を持たないので疑似音程(noiseRollIndex)で
      // 5レーンに分けている(kss2mml/expansion/opll.js の RHYTHM_DEFS 参照)。
      if (opllResult.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RLABEL = { bd: 'BD', sd: 'SD', tom: 'TOM', cym: 'CYM', hh: 'HH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          tracks.push({ id: `KF${RLABEL[key]}`, color: RCOLS[key],
            notes: toNotes(opllResult.rhythm[key] || [], true) });
        }
      }
    }

    // OPL系(MSX-AUDIO/YM3812/YM3526/Y8950): KF行と同じ流儀でOL行。音量はOPLL同様
    // 減衰値(attenuated=true)。リズムモード曲は打楽器5行、Y8950 ADPCM打点はOLB行。
    if (oplOpts && oplOpts.used && MML.Kss2MmlExpansion.opl) {
      const oplResult = MML.Kss2MmlExpansion.opl(writeLog, totalFrames, oplOpts.clock);
      const OL_COLS = ['#66ffcc', '#55eebb', '#44ddaa', '#33cc99', '#22bb88', '#11aa77', '#66e0d0', '#55d0c0', '#44c0b0'];
      oplResult.channels.forEach((ch, i) => tracks.push(mk(`OL${i + 1}`, OL_COLS[i % OL_COLS.length], ch.events, true, { chip: 'opl', kind: 'fm' })));
      if (oplResult.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RIDS = { bd: 'OLBD', sd: 'OLSD', tom: 'OLTM', cym: 'OLCY', hh: 'OLHH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          tracks.push({ id: RIDS[key], color: RCOLS[key], notes: toNotes(oplResult.rhythm[key] || [], true) });
        }
      }
      if (oplResult.adpcm) tracks.push({ id: 'OLB', color: '#cc66ff', notes: toNotes(oplResult.adpcm, true) });
    }

    return tracks;
  };

  // ── GBS ──────────────────────────────────────────────────────────────
  RollBuild.gbs = function (snapshots, frameRate) {
    const frameDur = 1 / frameRate;
    // toNotes: 音程が同じまま途切れず続いている区間を1本の音符に統合する(GBは実トリガbitが
    // あるためretrigger判定はtriggerSeqの変化そのもの=抽出側で既にイベント境界として反映済み)。
    // @EN(高速アルペジオ)統合済みイベントの展開はKSS側と同じ(RollBuild.expandNoteEnv参照)。
    const toNotes = (events, ctx, tones) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    const mk = (id, color, events, ctx) => { const tones = {}; return { id, color, notes: toNotes(events, ctx, tones), tones }; };
    // ★pulse()の音量はhwEnvelope.js側で64Hz実機クロックとplayFps(=frameRate)の位相を
    // 見て再計算するため、frameRateを渡さないとvolumeAt()内でNaNになり無音扱いになる。
    const ch1 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch1', null, frameRate);
    const ch2 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch2', null, frameRate);
    const noise = MML.Gbs2MmlExpansion.noise(snapshots, null, frameRate);
    const wave = MML.Gbs2MmlExpansion.wave(snapshots);
    tracks.push(mk('GB1', '#66ddff', ch1.events, { chip: 'gb', kind: 'square' }));
    tracks.push(mk('GB2', '#0077dd', ch2.events, { chip: 'gb', kind: 'square' }));
    tracks.push({ id: 'GN', color: '#aaaaaa', notes: toNotes(noise.events) });
    tracks.push(mk('GW', '#ffcc00', wave.events, { chip: 'gb', kind: 'wave' }));
    return tracks;
  };

  // ── HES ──────────────────────────────────────────────────────────────
  // dpcmTrace/controlTrace(省略可): 渡されると DDA(PCM)の打点を drumKey 付きノートとして
  // 該当chのトラックへ足す(ロールのドラム区画/パッドに出る。VGMのサンプルPCMと同じ形)。
  // 打点の同定は hes2mml/expansion/dpcm.js ddaHits(MML変換と同じ登録簿)なので、
  // ロールで見た太鼓と変換で出る @DPCM が一致する([[roll-as-mml-debugger]])。
  RollBuild.hes = function (snapshots, frameRate, dpcmTrace, controlTrace) {
    const frameDur = 1 / frameRate;
    // @EN(高速アルペジオ)統合済みイベントの展開はKSS側と同じ(RollBuild.expandNoteEnv参照)。
    const toNotes = (events, ctx, tones) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    const waveResult = MML.Hes2MmlExpansion.wave(snapshots);
    // id/色はkeyboard.js extractChannels()のisHesブロック(PSG0-5, PCOLS)と揃える。
    const colors = ['#66ddff', '#33aaff', '#0099ff', '#33cc99', '#ffaa00', '#ff6699'];
    // ノイズはch4/5独自の発音で、行/鍵盤表示でも同じPSG4/PSG5の行がwave/noiseを兼ねる
    // (wave/noiseは同一chで排他なので時間的に重ならず、単純にマージしてよい)。
    waveResult.channels.forEach((ch, i) => {
      const tones = {};
      let notes = toNotes(ch.events, { chip: 'huc6280', kind: 'wave' }, tones);
      if (i === 4 || i === 5) {
        const noiseNotes = toNotes(MML.Hes2MmlExpansion.noiseChannel(snapshots, i).events);
        if (noiseNotes.length) notes = notes.concat(noiseNotes).sort((a, b) => a.startSec - b.startSec);
      }
      tracks.push({ id: `PSG${i}`, color: colors[i % colors.length], notes, tones });
    });
    // DDA(PCM)の打点 → ドラム区画のノート(midi無し、drumKey/drumSeq付き)。
    // 同じ太鼓の連打が1本に融合しないよう drumSeq に打点の通番を入れる
    if (dpcmTrace && controlTrace && MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.ddaHits) {
      try {
        const { hits } = MML.Hes2MmlExpansion.ddaHits(snapshots, dpcmTrace, controlTrace, frameRate);
        hits.forEach((h, i) => {
          const tr = tracks[h.ch];
          if (!tr) return;
          tr.notes.push({ startSec: h.startFrame * frameDur, endSec: h.endFrame * frameDur, midi: null,
                          drumKey: h.key, drumSeq: i + 1, vol: h.vol, freqSeq: [] });
        });
        for (const tr of tracks) tr.notes.sort((a, b) => a.startSec - b.startSec);
      } catch (e) { /* DDA抽出の失敗でロール全体を落とさない */ }
    }
    return tracks;
  };

  // ── NSF(keyboard.jsの共通抽出経路への橋渡し)──────────────────────────
  RollBuild.nsf = function (regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots) {
    return MML.UI.buildRollTracksFromRegSnapshots(
      regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots);
  };

  // ── VGM(チップファミリごとに上の各ビルダー/共通抽出経路を連結)─────────
  // opts.poolMode: チャンネルプール式チップの表示モード({multipcm:'logical'|'phys'})。
  // 'logical'なら割当逆算済みスナップショット(data.multipcm.logical)でロールを組む
  RollBuild.vgm = function (data, done, opts) {
    const frameRate = data.frameRate;
    const sr = 44100;
    const buildTracks = MML.UI.buildRollTracksFromRegSnapshots;
    let tracks = [];
    if (data.nes) {
      const nesChips = ['nes'].concat(data.nes.fds ? ['fds'] : []);
      const t = buildTracks(data.nes.regSnapshots, data.nes.writeLog, done, sr / frameRate, sr, nesChips, null);
      if (t) tracks = tracks.concat(t);
    }
    if (data.gb) tracks = tracks.concat(RollBuild.gbs(data.gb.snapshots.slice(0, done), frameRate));
    if (data.hes) tracks = tracks.concat(RollBuild.hes(data.hes.snapshots.slice(0, done), frameRate));
    if (data.kss) {
      const wl = data.kss.writeLog.slice(0, done);
      const fakeHeader = { device: { mode: 'MSX', fmpac: data.kss.opll } };
      const kssTracks = RollBuild.kss(wl, done, frameRate, fakeHeader, data.kss.scc, data.kss.clock,
        data.kss.opl ? { used: true, clock: data.kss.oplClock } : null);
      // AY未使用(SCC/OPLLのみ)のVGMではKP行が鍵盤に無いのでロール側も落とす
      tracks = tracks.concat(data.kss.ay ? kssTracks : kssTracks.filter(t => !/^KP\d/.test(t.id)));
    }
    // 2個目のPSG(vgmPlayer.js captureVgmSongAsync の kss2): 同じKSS抽出器で作って KP4-6 へ付け替える
    if (data.kss2) {
      const wl2 = data.kss2.writeLog.slice(0, done);
      const t2 = RollBuild.kss(wl2, done, frameRate, { device: { mode: 'MSX', fmpac: false } }, false, data.kss2.clock, null)
        .filter(t => /^KP[1-3]$/.test(t.id))
        .map(t => Object.assign({}, t, { id: 'KP' + (+t.id.slice(2) + 3) }));
      tracks = tracks.concat(t2);
    }
    // スナップショット型チップ: extractChannels(keyboard.js)が読むextraSnapsに
    // フレーム毎スナップショット配列を渡して同じ抽出経路でトラック化する
    const snapChips = ['sn', 'ym2612', 'ym2610fm', 'ym2151', 'ym2203fm', 'ym2608fm', 'ga20', 'k007232', 'k054539', 'msm5205', 'segapcm', 'c140', 'c352', 'okim6258', 'qsound', 'okim6295', 'multipcm', 'pwm', 'rf5c164', 'rf5c68'];
    const chipToken = { sn: 'sn76489' };
    const poolMode = (opts && opts.poolMode) || {};
    for (const key of snapChips) {
      if (!data[key]) continue;
      const token = chipToken[key] || key;
      const snaps = (poolMode[key] === 'logical') ? (RollBuild.poolLogical(data, key) || data[key].snapshots) : data[key].snapshots;
      const extra = {}; extra[key] = snaps;
      const t = buildTracks(snaps, [], done, sr / frameRate, sr, ['vgm', token], null, extra);
      if (t) tracks = tracks.concat(t);
    }
    return tracks;
  };

  // ── PSF(PlayStation SPU)────────────────────────────────────────────
  // キャプチャ(psfPlayer.js capturePsfSongAsync / Worker の鏡像)の Int32Array スナップショットを
  // Emu.snapshotPsx で C352 と同じ形のオブジェクトへ変換し、VGM の PCM チップと同じ抽出経路
  // (keyboard.js extractChannels の 'psx' 行)でトラック化する。変換済みのフレームは state に
  // 溜めて次回は続きだけ作る(ロールは曲が伸びるたびに何度も組み直すため)。
  // opts.poolMode.psx === 'phys' なら実機ボイス、それ以外は合成ch(Emu.PoolChannelRegrouper)。
  RollBuild.psfObjectSnapshots = function (cap, state) {
    const Emu = MML.Emu;
    if (!state.bank || state.bank.samples !== cap.samples) state.bank = new Emu.PsxSampleBank(cap.samples);
    if (!state.data) state.data = { psx: { snapshots: [] } };
    const out = state.data.psx.snapshots;
    const n = cap.snapshots.length;
    for (let i = out.length; i < n; i++) {
      if (!cap.snapshots[i]) break; // Worker の鏡像は穴が空かない想定だが、念のため途中で止める
      out.push(Emu.snapshotPsx(cap.snapshots[i], state.bank));
    }
    return state.data;
  };
  RollBuild.psf = function (cap, done, opts, state) {
    const frameRate = cap.frameRate || 60;
    const sr = 44100;
    const data = RollBuild.psfObjectSnapshots(cap, state || {});
    const poolMode = (opts && opts.poolMode) || {};
    const snaps = RollBuild.psxFrames(data, poolMode.psx);
    const n = Math.min(done, snaps.length);
    const t = MML.UI.buildRollTracksFromRegSnapshots(snaps, [], n, sr / frameRate, sr, ['vgm', 'psx'], null, { psx: snaps });
    return t || [];
  };

  // PSF の表示モード別のレーン列: 'phys'=実機ボイス / 'logical'=合成ch / 'track'(既定)=トラック×声部
  RollBuild.psxFrames = function (data, mode) {
    if (mode === 'phys') return data.psx.snapshots;
    if (mode === 'logical') return RollBuild.poolLogical(data, 'psx') || data.psx.snapshots;
    return RollBuild.psxTrackFrames(data) || data.psx.snapshots;
  };

  // ── PSF の「トラック」レーン(Emu.PsfTrackVoicer) ───────────────────────
  // poolLogical と同じく snapshots が伸びた分だけ続きから足す(声部の割り当ては状態を持つので同じインスタンスで続ける)。
  // d.__trackState.vc.lanes がレーン表(鍵盤の行名/変換のソース名)
  RollBuild.psxTrackFrames = function (data) {
    const d = data && data.psx;
    const Emu = MML.Emu;
    if (!d || !Array.isArray(d.snapshots) || !Emu.PsfTrackVoicer) return null;
    let S = d.__trackState;
    if (!S) {
      Object.defineProperty(d, '__trackState', { value: { vc: new Emu.PsfTrackVoicer(), out: [] }, configurable: true, writable: true });
      S = d.__trackState;
    }
    for (let i = S.out.length; i < d.snapshots.length; i++) S.out.push(S.vc.step(d.snapshots[i]));
    return S.out;
  };

  // ── プール式PCMチップの「合成ch」スナップショット ─────────────────────
  // logical は snapshots を Emu.PoolChannelRegrouper に先頭から順に通しただけの決定的なデータ。
  // キャプチャWorkerは通信量を減らすため logical を送らない(2026-09-13。c140 では progress の
  // 復元時間の約4割がこれだった)ので、画面側で合成ch表示が要るときだけここで作る。
  // snapshots が伸びていれば続きから足す(回帰器は状態を持つので同じインスタンスで続ける)。
  // メインスレッドで丸ごとキャプチャした data には logical が揃っているので、そのまま返す。
  RollBuild.poolLogical = function (data, key) {
    const d = data && data[key];
    const Emu = MML.Emu;
    if (!d || !Array.isArray(d.snapshots)) return null;
    const st = d.__logicalState;
    if (!st && Array.isArray(d.logical) && d.logical.length >= d.snapshots.length) return d.logical;
    const numCh = Emu && Emu.POOL_CHIP_CHANNELS && Emu.POOL_CHIP_CHANNELS[key];
    if (!numCh || !Emu.PoolChannelRegrouper) return null;
    if (!st || d.logical !== st.out) {
      // 列挙されない印にして、構造化複製やJSON化で運ばれないようにする
      Object.defineProperty(d, '__logicalState', { value: { rg: new Emu.PoolChannelRegrouper(numCh), out: [] }, configurable: true, writable: true });
      d.logical = d.__logicalState.out;
    }
    const S = d.__logicalState;
    for (let i = S.out.length; i < d.snapshots.length; i++) S.out.push(S.rg.step(d.snapshots[i]));
    return S.out;
  };

  // ── 構築スロットル ────────────────────────────────────────────────────
  // 壁時計ベース+直前の構築実測コスト×10を次回までの最小間隔にする適応制御
  // (構築のCPU占有率を~10%以下に自動制御。曲が進み1回の走査が重くなるほど自動的に
  // 間遠になる)。メインスレッドでは加えて非表示タブ中は最終回以外スキップする
  // (Worker内にはdocumentが無いので可視性チェックは自動的に無効=常時構築でよい。
  // Worker内の構築はメインスレッドをブロックしないため)。
  RollBuild.makeThrottle = function () {
    let lastBuildEnd = -Infinity;
    let minIntervalMs = 300;
    return {
      shouldBuild(done, total) {
        if (done >= total) return true; // 最終回は必ず構築(取りこぼし防止)
        if (typeof document !== 'undefined' && document.hidden) return false;
        return performance.now() - lastBuildEnd >= minIntervalMs;
      },
      didBuild(buildStartMs) {
        lastBuildEnd = performance.now();
        minIntervalMs = Math.max(300, Math.min(5000, (lastBuildEnd - buildStartMs) * 10));
      },
      force() { lastBuildEnd = -Infinity; }
    };
  };

  // ── ロール構築ジョブ(フォーマット差異の吸収)─────────────────────────
  // Worker実装(capture-worker-*-impl.js)とクライアントのフォールバック
  // (capture-worker-client.js)の両方から使う。build(data, done, total)は
  // {timeline, info} を返す(infoはフォーマット固有の副産物: KSSのsccUsed、
  // HESのddaChannel)。dataの形はフォーマットごとのキャプチャ進行データ:
  //   nsf: {regSnapshots, writeLog, n163Snapshots} / kss: {writeLog}
  //   gbs: {snapshots} / hes: {snapshots, dpcmTrace, controlTrace}
  //   spc: {frameLog} / vgm: captureVgmSongAsyncのdataそのもの
  //   psf: capturePsfSongAsync の cap({snapshots, samples, frameRate})
  RollBuild.createRollJob = function (format, params) {
    params = params || {};
    if (format === 'nsf') {
      return { build: (data, done) => ({
        timeline: RollBuild.nsf(data.regSnapshots, data.writeLog, done,
          params.samplesPerFrame, params.sampleRate, params.chips || [], data.n163Snapshots),
        info: {}
      }) };
    }
    if (format === 'kss') {
      const sccPossible = RollBuild.kssHasSccDecoder(params.header);
      let sccUsed = false;
      let scanned = 0;
      // MSX-AUDIO(Y8950)を積むKSSはOL行も作る(クロックはMSX固定3.58MHz)
      const oplOpts = (params.header && params.header.device && params.header.device.msxAudio)
        ? { used: true, clock: 3579545 } : null;
      return { build: (data, done) => {
        // SCCは「使われたと分かった時点で行を足す」単調運用(main.js playKssStream参照)
        if (sccPossible && !sccUsed && RollBuild.kssWriteLogUsesScc(data.writeLog, scanned, done)) sccUsed = true;
        scanned = done;
        return {
          timeline: RollBuild.kss(data.writeLog.slice(0, done), done, params.frameRate, params.header, sccUsed, null, oplOpts),
          info: { sccUsed }
        };
      } };
    }
    if (format === 'gbs') {
      return { build: (data, done) => ({
        timeline: RollBuild.gbs(data.snapshots.slice(0, done), params.frameRate), info: {}
      }) };
    }
    if (format === 'hes') {
      return { build: (data, done) => {
        const snaps = data.snapshots.slice(0, done);
        const out = { timeline: RollBuild.hes(snaps, params.frameRate, data.dpcmTrace, data.controlTrace), info: {} };
        // DDA(PCM)を担当するchの判定(曲全体でDDA区間が最も長い1ch)も同じ頻度で更新する。
        // 実際の再生に使う生のdpcmTrace列はメインスレッド側が保持しているので、
        // ここではチャンネル番号だけをinfoで返す(main.js側でsetDdaChannel)。
        if (data.dpcmTrace && data.controlTrace && MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.extractDdaClips) {
          out.info.ddaChannel = MML.Hes2MmlExpansion.extractDdaClips(
            snaps, data.dpcmTrace, data.controlTrace, params.frameRate).channel;
        }
        return out;
      } };
    }
    if (format === 'spc') {
      return { build: (data, done) => ({
        timeline: RollBuild.spc(data.frameLog.slice(0, done), params.frameRate, params.fineTune || null, params.drumKinds || null),
        info: {}
      }) };
    }
    if (format === 'psf') {
      const state = {};
      return { build: (data, done) => ({ timeline: RollBuild.psf(data, done, params, state), info: {} }) };
    }
    if (format === 'vgm') {
      // params.poolMode: プール式チップの表示モード(Worker実行時はopt.roll経由で届く)
      return { build: (data, done) => ({ timeline: RollBuild.vgm(data, done, params), info: {} }) };
    }
    return null;
  };
})(globalThis);

/*
 * KSS/GBS/VGM/SPC/HES regsOnlyキャプチャ Worker本体(汎用ディスパッチ)
 *
 * NSF用のnsf-capture-worker-impl.jsと同じ仕組み(README-worker-build.txt参照)だが、
 * こちらは1本で複数フォーマットを扱う。各フォーマットのバンドルにこのファイルを
 * 結合し、msg.formatで対応するcaptureXxxSongAsyncへディスパッチする(バンドルに
 * 入っていないフォーマットを要求されたらerrorを返す)。
 *
 * プロトコル(capture-worker-client.jsの汎用ランナーと対):
 *   受信 {cmd:'capture', format:'kss'|'gbs'|'vgm'|'spc'|'hes', bytes, opt}
 *   受信 {cmd:'cancel'}
 *   送信 {type:'progress', done, total, arrays:{path:差分slice}, [meta]}
 *        - onProgressが渡すペイロード(進行中に育つ配列を含む構造)を走査し、
 *          「トップレベルまたは1段ネストの配列」をフレーム配列として前回送信位置
 *          からの差分だけ送る。配列以外(スカラ・フラグ・headerオブジェクト)は
 *          初回のみmetaとして送る。
 *   送信 {type:'done', [finalMeta]} … finalMetaはキャプチャ完了後に追加された
 *        非配列プロパティ(VGMのnes.dpcmRom等)を拾うための最終メタ再送
 *   送信 {type:'error', message}
 *   送信 {type:'roll', done, total, timeline, info}
 *        … opt.rollが渡された場合のみ。ピアノロールのタイムライン構築(1回あたり
 *          O(done)の全走査。メインスレッドでは長タスク=カクつきの主因だった)を
 *          Worker内で行い、完成品だけを送る(src/audio/roll-builders.js参照)。
 *          infoはフォーマット固有の副産物(KSS:sccUsed / HES:ddaChannel)。
 *   送信 {type:'rollError', message} … ロール構築の失敗(以後この曲では送らない。
 *        クライアントはメインスレッド構築へ切り替える)。キャプチャ自体は継続する。
 *
 * ★HESも汎用差分プロトコルを使わない: dpcmTrace/controlTraceが「外側は固定長6(ch数)、
 * 中身のch別イベント配列が伸びる」二重配列で、汎用差分(トップレベル/1段ネスト配列の
 * 長さ基準)では外側6要素を初回に送ったきり以後更新されない。専用ハンドラ(_runHes)で
 * snapshotsは長さ基準、トレース2本はch別の長さ基準で差分送信する。
 *
 * ★SPCだけは汎用差分プロトコルを使わない: MML.SPC2MML.captureAsyncのframeLogは
 * 「全フレーム分を空配列で事前確保してから埋めていく」ため、配列長が最初から
 * total固定で、長さ基準の差分検出が機能しない(初回に空配列の山を全送信し、以後
 * 何も送らなくなる)。完了フレーム数done基準で {start, frames:[...]} を差分送信する
 * 専用ハンドラ(_runSpc)を使う。書き込み途中の未完了フレーム(frameLog[done])は
 * まだ伸びている最中なので送らない(次のスライス境界で完成後に送られる)。
 */
(function (global) {
  const MML = global.MML;
  const Emu = MML.Emu;

  // Worker内で解析を進める1スライスの長さ(ms)。1スライスごとに進捗(progress)を1通送る。
  // ★以前は30msだったが、30msぶんのデータ(VGMで3000〜5000件)をメインスレッドが受け取って復元するのに
  //   40〜95msかかり、再生開始直後の画面の止まりと音声コールバックの遅れの原因になっていた
  //   (2026-09-13 実Chromeで計測。Worker受信のうちロール(type:roll)は1〜2msで、重いのはprogressだった)。
  //   送る総量は変えずに1通を小さくして、受信を短い処理に分ける。cancel応答性の上限でもある。
  //   8msで1通の復元が最大32ms、4msで最大20〜25msになり、ワルキューレの伝説/レイブレーサーの開始直後の長いタスク(50ms超)が消えた。
  const WORKER_SLICE_MS = 30;     // 既定(SPC/HES/KSS/GBS。受信が軽いので細かく区切る必要が無い)
  const WORKER_SLICE_MS_VGM = 4;  // VGMだけ: PCMプール系で1通の復元が重いため細かく区切る
  // setTimeout(0)の4msクランプを回避するマクロタスクyield(nsf-capture-worker-impl.jsと同じ)
  function macroYield() {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }

  // onProgressペイロードを「フレーム配列(差分送信)」と「メタ(初回/最終のみ送信)」に
  // 分解する。sentは path->送信済み件数 の記録(呼び出しをまたいで保持)。
  // 'header'キーはVGMのパース済みヘッダ(ネストした静的オブジェクト)なので、
  // 中身を配列走査せず丸ごとメタ扱いにする。
  function diffPayload(payload, sent, includeMeta) {
    const arrays = {};
    const meta = includeMeta ? {} : null;
    for (const key of Object.keys(payload)) {
      const v = payload[key];
      if (Array.isArray(v)) {
        const n = sent[key] || 0;
        if (v.length > n) { arrays[key] = v.slice(n); sent[key] = v.length; }
      } else if (v && typeof v === 'object' && key !== 'header' && !ArrayBuffer.isView(v)) {
        let subMeta = null;
        for (const k2 of Object.keys(v)) {
          const v2 = v[k2];
          // プール式PCMチップの logical(合成ch)は snapshots から画面側で作り直せるので送らない
          // (roll-builders.js RollBuild.poolLogical)。c140 で progress の復元時間の約4割を占めていた
          if (k2 === 'logical' && Array.isArray(v.snapshots)) continue;
          if (Array.isArray(v2)) {
            const path = key + '.' + k2;
            const n = sent[path] || 0;
            if (v2.length > n) { arrays[path] = v2.slice(n); sent[path] = v2.length; }
          } else if (meta) {
            (subMeta = subMeta || {})[k2] = v2;
          }
        }
        // 配列しか持たないファミリでも「存在する(nullではない)」ことをメタで伝える
        if (meta) meta[key] = subMeta || {};
      } else if (meta) {
        meta[key] = v; // スカラ / null / 型付き配列
      }
    }
    return { arrays, meta };
  }

  // 各フォーマットのキャプチャ呼び出し。onProgressの引数形状の違いをここで
  // 「ペイロードオブジェクト1個」に正規化する(client側で逆変換する)。
  const FORMATS = {
    kss: (bytes, opt, onP) =>
      Emu.captureKssSongAsync(bytes, opt, (done, total, writeLog) => onP(done, total, { writeLog })),
    gbs: (bytes, opt, onP) =>
      Emu.captureGbsSongAsync(bytes, opt, (done, total, data) => onP(done, total, data)),
    vgm: (bytes, opt, onP) =>
      Emu.captureVgmSongAsync(bytes, opt, (done, total, data) => onP(done, total, data))
  };

  let cancelled = false;

  // ロール構築・送信(opt.rollが無ければ無効)。スロットルはRollBuild.makeThrottleを流用
  // (Worker内にdocumentが無いため可視性チェックは自動的に素通り=常時構築。構築は
  // メインスレッドをブロックしないので問題なく、コストに応じた間隔制御だけが効く)。
  function makeRollSender(format, msg) {
    const RollBuild = MML.RollBuild;
    if (!RollBuild || !msg.opt || !msg.opt.roll) return null;
    let params;
    if (format === 'kss') params = { frameRate: msg.opt.roll.frameRate, header: MML.KSS.parseHeader(msg.bytes) };
    else if (format === 'spc') params = { frameRate: MML.SPC2MML.FRAME_RATE, fineTune: msg.opt.roll.fineTune || null, drumKinds: msg.opt.roll.drumKinds || null };
    else params = msg.opt.roll; // gbs/hes: {frameRate} / vgm: {}
    const job = RollBuild.createRollJob(format, params);
    if (!job) return null;
    const throttle = RollBuild.makeThrottle();
    let failed = false;
    return (data, done, total) => {
      if (failed || !throttle.shouldBuild(done, total)) return;
      const t0 = performance.now();
      try {
        const r = job.build(data, done, total);
        throttle.didBuild(t0);
        global.postMessage({ type: 'roll', done, total, timeline: r.timeline, info: r.info });
      } catch (err) {
        failed = true;
        global.postMessage({ type: 'rollError', message: String((err && err.stack) || err) });
      }
    };
  }

  // SPC専用(冒頭コメント参照)。opt.durationSecondsだけを使う。
  async function _runSpc(msg) {
    const sendRoll = makeRollSender('spc', msg);
    let lastSent = 0;
    const onProgress = (done, total, frameLog) => {
      if (done <= lastSent) return;
      global.postMessage({ type: 'progress', done, total, start: lastSent, frames: frameLog.slice(lastSent, done) });
      lastSent = done;
      if (sendRoll) sendRoll({ frameLog }, done, total);
    };
    await MML.SPC2MML.captureAsync(msg.bytes, msg.opt.durationSeconds, onProgress,
      () => cancelled, { yieldFn: macroYield, sliceBudgetMs: WORKER_SLICE_MS });
    global.postMessage({ type: 'done', cancelled });
  }

  // HES専用(冒頭コメント参照)。regsOnly前提(client側でperChannelAudio等は弾く)。
  async function _runHes(msg) {
    const sendRoll = makeRollSender('hes', msg);
    let sentSnap = 0;
    const sentDpcm = [0, 0, 0, 0, 0, 0];
    const sentCtl  = [0, 0, 0, 0, 0, 0];
    let metaSent = false;
    const onProgress = (done, total, data) => {
      const chunk = {
        type: 'progress', done, total,
        snapStart: sentSnap,
        snapshots: data.snapshots.slice(sentSnap),
        dpcmTrace: [], controlTrace: []
      };
      sentSnap = data.snapshots.length;
      for (let c = 0; c < 6; c++) {
        // dpcmTraceは列ごとの型付き配列(Emu.HesTraceBuf)なので、列ごとに差分を切って送る
        chunk.dpcmTrace.push(data.dpcmTrace[c].slicePlain(sentDpcm[c]));
        sentDpcm[c] = data.dpcmTrace[c].length;
        chunk.controlTrace.push(data.controlTrace[c].slice(sentCtl[c]));
        sentCtl[c] = data.controlTrace[c].length;
      }
      if (!metaSent) { metaSent = true; chunk.frameRate = data.frameRate; }
      global.postMessage(chunk);
      if (sendRoll) sendRoll(data, done, total);
    };
    const opt = Object.assign({}, msg.opt, {
      regsOnly: true,
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      sliceBudgetMs: WORKER_SLICE_MS
    });
    await Emu.captureHesSongAsync(msg.bytes, opt, onProgress);
    global.postMessage({ type: 'done', cancelled });
  }

  // PSF専用。msg.info = MML.PSF.load() の結果(_lib 解決はメインスレッドで済ませてから渡す)。
  // 差分: frameLog/snapshots はフレーム数、ramLog/samples は件数で切って送る。
  async function _runPsf(msg) {
    const sendRoll = makeRollSender('psf', msg);
    let sentFrames = 0, sentRam = 0, sentSamples = 0;
    let metaSent = false;
    const onProgress = (done, total, cap) => {
      const n = cap.frameLog.length;
      const chunk = {
        type: 'progress', done, total,
        frameStart: sentFrames,
        frameLog: cap.frameLog.slice(sentFrames, n),
        snapshots: cap.snapshots.slice(sentFrames, n),
        ramStart: sentRam, ramLog: cap.ramLog.slice(sentRam),
        sampleStart: sentSamples, samples: cap.samples.slice(sentSamples),
      };
      sentFrames = n; sentRam = cap.ramLog.length; sentSamples = cap.samples.length;
      if (!metaSent) { metaSent = true; chunk.meta = { frameRate: cap.frameRate, samplesPerFrame: cap.samplesPerFrame, totalFrames: cap.totalFrames }; }
      global.postMessage(chunk);
      if (sendRoll) sendRoll(cap, n, total);
    };
    const opt = Object.assign({}, msg.opt, {
      regsOnly: true,
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      sliceBudgetMs: WORKER_SLICE_MS
    });
    const cap = await Emu.capturePsfSongAsync(msg.info, opt, onProgress);
    global.postMessage({ type: 'done', cancelled, bios: cap.bios });
  }

  global.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.cmd === 'cancel') { cancelled = true; return; }
    if (msg.cmd !== 'capture') return;

    if (msg.format === 'hes') {
      if (typeof Emu.captureHesSongAsync !== 'function') {
        global.postMessage({ type: 'error', message: 'unsupported format in this bundle: hes' });
        return;
      }
      cancelled = false;
      try { await _runHes(msg); }
      catch (err) { global.postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
      return;
    }

    if (msg.format === 'psf') {
      if (typeof Emu.capturePsfSongAsync !== 'function') {
        global.postMessage({ type: 'error', message: 'unsupported format in this bundle: psf' });
        return;
      }
      cancelled = false;
      try { await _runPsf(msg); }
      catch (err) { global.postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
      return;
    }

    if (msg.format === 'spc') {
      if (!MML.SPC2MML || typeof MML.SPC2MML.captureAsync !== 'function') {
        global.postMessage({ type: 'error', message: 'unsupported format in this bundle: spc' });
        return;
      }
      cancelled = false;
      try { await _runSpc(msg); }
      catch (err) { global.postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
      return;
    }

    const run = FORMATS[msg.format];
    if (!run || typeof (msg.format === 'kss' ? Emu.captureKssSongAsync
                       : msg.format === 'gbs' ? Emu.captureGbsSongAsync
                       : Emu.captureVgmSongAsync) !== 'function') {
      global.postMessage({ type: 'error', message: 'unsupported format in this bundle: ' + msg.format });
      return;
    }

    cancelled = false;
    const opt = Object.assign({}, msg.opt, {
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      sliceBudgetMs: msg.format === 'vgm' ? WORKER_SLICE_MS_VGM : WORKER_SLICE_MS
    });

    // VGMだけ、送ったデータの大きさに応じて次の解析を少し待つ。PCMプール系の曲は1通の複製が重く、
    // 解析が速すぎると画面側が受信の復元で埋まって、解析が終わるまで音と描画が詰まる(2026-09-13実測、
    // ワルキューレの伝説3曲目で最初の1秒に復元650ms)。postMessage に掛かった時間(=複製の手間の目安)の
    // PACE_RATIO 倍だけ待ち、画面側の受信を時間方向に薄める。軽い曲では待ち時間はほぼ0になる
    const PACE_RATIO = msg.format === 'vgm' ? 3 : 0;
    const PACE_MAX_MS = 120;
    let paceMs = 0;
    opt.yieldFn = () => {
      if (paceMs <= 0) return macroYield();
      const ms = paceMs; paceMs = 0;
      return new Promise((resolve) => setTimeout(resolve, ms));
    };
    const sendRoll = makeRollSender(msg.format, msg);
    const sent = {};
    let metaSent = false;
    let lastPayload = null;
    const onProgress = (done, total, payload) => {
      lastPayload = payload;
      const { arrays, meta } = diffPayload(payload, sent, !metaSent);
      const chunk = { type: 'progress', done, total, arrays };
      if (!metaSent) { metaSent = true; chunk.meta = meta; }
      const tPost = performance.now();
      global.postMessage(chunk);
      if (PACE_RATIO > 0 && done < total) paceMs = Math.min(PACE_MAX_MS, (performance.now() - tPost) * PACE_RATIO);
      if (sendRoll) sendRoll(payload, done, total);
    };

    try {
      await run(msg.bytes, opt, onProgress);
      // キャプチャ完了後に追加された非配列プロパティ(VGMのnes.dpcmRom等)を最終メタで拾う
      const doneMsg = { type: 'done', cancelled };
      if (lastPayload) doneMsg.finalMeta = diffPayload(lastPayload, sent, true).meta;
      global.postMessage(doneMsg);
    } catch (err) {
      global.postMessage({ type: 'error', message: String((err && err.stack) || err) });
    }
  };
})(globalThis);

  };
})(window);