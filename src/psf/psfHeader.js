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
})(window);
