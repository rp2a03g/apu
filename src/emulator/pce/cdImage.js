/*
 * CD イメージ(cue+bin/img/iso/wav、ccd+img)の読み込みと、セクタ単位の読み出し
 * MML.Emu.PceDisc(段階 9e)
 *
 * 持ち方: データのファイルは丸ごと Uint8Array で持つ(files[i].data)。セクタは LBA(0 始まり。00:02:00 が LBA 0)で数える。
 *   トラックは { number, audio, sectorSize(2352 / 2048), raw(2352 のデータ=頭 16 バイトが見出し), file, offset(ファイルの中の位置), first, last }。
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3)。[参照] は Mesen 2 の Core/Shared/CdReader.cpp・CdReader.h(読んだだけで写していない):
 *   [参照] cue の読み方。照合のため、トラックの境目とファイルの中の位置の決め方を Mesen と同じにしてある:
 *          - PREGAP(ファイルに入っていない無音)は、それ以降の全トラックの LBA を後ろへずらす
 *          - INDEX 00(ファイルに入っている前置き)がある時、1 つ前のトラックは INDEX 00 の手前で終わる。前置きはどのトラックにも属さない
 *          - 2 つ目以降のファイルは、前のトラックの終わりの次の LBA から始まる
 *          - 最後のトラックはファイルの終わりまで。ディスクの長さ(TOC の終わり)= 最後のセクタ+1+150
 *   [参照] データの読み出し: トラックに属さないセクタ(前置き)は 0 が 2048 個。2352 のデータは頭 16 バイトを飛ばして 2048 個
 *   [参照] サブコード(.sub、1 セクタ 96 バイト=P〜W が 12 バイトずつ)を、ドライブが返す並び(98 個: 同期 2 個 $00 $80+96 個、
 *          1 個の中に P〜W が 1bit ずつ)に直して返す。.sub が無ければ 0
 *   ★ PREGAP の数え方は Mesen の版で違う。照合に使っている実物(2.2.1)は「そのトラックの始まりだけ」をずらし、後ろのトラックへは持ち越さない
 *      (そのため PREGAP が 2 つ以上ある cue では、後ろのトラックの LBA とファイルの中の位置がずれる)。新しいソースは上の通り全部を後ろへずらす。
 *      既定は新しい方。照合の時だけ opts.legacyPregap = true で 2.2.1 の数え方にする(TOC の値で食い違って分かった)
 *   ★ Mesen は「前のトラックの大きさ」を、後ろのトラックのセクタの大きさで計算する(2048 のデータと音声が 1 つのファイルに混ざる時だけ差が出る)。同じにしてある
 *   [推定] cue の FILE が WAVE で中身が RIFF の時は、data チャンクの頭から読む(Mesen はヘッダを飛ばさない)。MP3 などはここでは読めない。
 *     画面の側(nesScreen.js の decodeCdAudio)がブラウザの復号で 44.1kHz・16bit・ステレオの素の PCM に直し、decoded の印を付けて渡す。
 *     圧縮で頭と終わりに数十ミリ秒の余りが付くので、トラックの長さ(=後ろのトラックの始まり)は元のディスクと少し違う
 *   [推定] ccd(CloneCD): [Entry] の Point が 1〜99 の物をトラックとし、PLBA を始まり、Control の bit2 をデータの印として読む。
 *          img は LBA 0 からの 2352 バイト/セクタ。前置きは前のトラックに含める(cue の INDEX 00 が無い時と同じ形)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const msf = (m, s, f) => (m * 60 + s) * 75 + f;
  const parseMsf = (text) => { const p = String(text || '').split(':'); if (p.length !== 3) return -1; const v = p.map(x => parseInt(x, 10)); return v.some(isNaN) ? -1 : msf(v[0], v[1], v[2]); };

  class PceDisc {
    constructor() {
      this.files = [];      // { name, data(Uint8Array), base(データの始まり。WAV の時だけ 0 でない) }
      this.tracks = [];
      this.sectorCount = 0; // 最後のセクタ+1
      this.endLba = 150;    // TOC の「ディスクの終わり」(分秒フレームにする前の値)
      this.sub = null;      // .sub の中身(無ければ null)
    }

    get empty() { return this.tracks.length === 0; }

    /** cue の文字を { name, type, tracks: [{ number, format, pregap, index0, index1 }] } の並びにする */
    static parseCue(text) {
      const files = [];
      for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        const up = line.toUpperCase();
        if (up.startsWith('FILE')) {
          let name = '', type = '';
          const a = line.indexOf('"'), b = line.lastIndexOf('"');
          if (a >= 0 && b > a) { name = line.slice(a + 1, b); type = line.slice(b + 1).trim(); }
          else { const p = line.split(/\s+/); type = p.length > 2 ? p[p.length - 1] : ''; name = p.slice(1, p.length > 2 ? -1 : undefined).join(' '); }
          name = name.trim();
          if (!name) throw new Error('cue: FILE の名前が読めません');
          files.push({ name, type: type.toUpperCase(), tracks: [] });
        } else if (up.startsWith('TRACK')) {
          if (!files.length) throw new Error('cue: FILE の前に TRACK があります');
          const p = line.split(/\s+/);
          const number = parseInt(p[1], 10);
          if (p.length < 3 || isNaN(number)) throw new Error('cue: TRACK が読めません');
          files[files.length - 1].tracks.push({ number, format: p[2].toUpperCase(), pregap: -1, index0: -1, index1: -1 });
        } else if (up.startsWith('PREGAP') || up.startsWith('INDEX')) {
          const f = files[files.length - 1], t = f && f.tracks[f.tracks.length - 1];
          if (!t) throw new Error('cue: TRACK の前に ' + up.slice(0, 6).trim() + ' があります');
          const p = line.split(/\s+/);
          if (up.startsWith('PREGAP')) { const v = parseMsf(p[1]); if (v < 0) throw new Error('cue: PREGAP の時間が読めません'); t.pregap = v; }
          else {
            const n = parseInt(p[1], 10), v = parseMsf(p[2]);
            if (isNaN(n) || v < 0) throw new Error('cue: INDEX が読めません');
            if (n === 0) t.index0 = v; else if (n === 1) t.index1 = v; else throw new Error('cue: INDEX ' + n + ' には対応していません');
          }
        }
      }
      return files;
    }

    /**
     * cue からディスクを作る。resolve(name, type, 何番目のファイルか) はデータのファイルの中身(Uint8Array)を返す(無ければ null)
     */
    static fromCue(text, resolve, opts) {
      const legacy = !!(opts && opts.legacyPregap);
      const disc = new PceDisc();
      const cue = PceDisc.parseCue(text);
      let pregapTotal = 0;
      for (let fi = 0; fi < cue.length; fi++) {
        const cf = cue[fi];
        if (!cf.tracks.length) continue;
        const data = resolve(cf.name, cf.type, fi);
        if (!data) throw new Error('cue: データのファイルがありません: ' + cf.name);
        let base = 0;
        if (data.length > 44 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) base = PceDisc.wavDataOffset(data);
        const fileIndex = disc.files.length;
        disc.files.push({ name: cf.name, data, base });
        const origin = disc.tracks.length ? disc.tracks[disc.tracks.length - 1].last + 1 : 0;
        // ★ PREGAP の合計はファイルごとに数え直す。前のファイルまでの前置きは origin(前のトラックの終わりの次)にもう入っているので、
        //   合計を持ち越すと 2 回数える(Mesen の今のソースは持ち越す。bin 1 個の cue では差が出ない)。
        //   [試験] bin 1 個のディスクをトラックごとのファイルに分けた cue で、各トラックの始まりが元と同じになる事(持ち越すと 3 トラック目から 225 セクタずつずれた)
        pregapTotal = 0;
        for (const ct of cf.tracks) {
          let sectorSize = 2352, audio = false, raw = false;
          if (ct.format === 'AUDIO') audio = true;
          else if (ct.format === 'MODE1/2352') raw = true;
          else if (ct.format === 'MODE1/2048') sectorSize = 2048;
          else throw new Error('cue: 対応していないトラックの形式です: ' + ct.format);
          if (ct.index1 < 0) throw new Error('cue: INDEX 01 の無いトラックがあります');
          const hasPregap = ct.pregap >= 0;
          if (hasPregap) pregapTotal += ct.pregap;
          let gapStart, first;
          if (legacy) {
            const own = hasPregap ? ct.pregap : 0;
            gapStart = ct.index0 >= 0 ? ct.index0 + own + origin : -1;
            if (hasPregap) gapStart = ct.index1 + origin;
            first = ct.index1 + own + origin;
          } else {
            gapStart = ct.index0 >= 0 ? ct.index0 + origin : -1;
            if (hasPregap) gapStart = ct.index1 + pregapTotal - ct.pregap + origin;
            first = ct.index1 + pregapTotal + origin;
          }
          const t = { number: ct.number, audio, raw, sectorSize, file: fileIndex, offset: 0, first, last: first - 1, open: true };
          const prev = disc.tracks[disc.tracks.length - 1];
          if (!prev) t.offset = first * sectorSize;
          else if (prev.open) {
            prev.last = (gapStart >= 0 ? gapStart : first) - 1;
            prev.open = false;
            t.offset = prev.offset + (prev.last - prev.first + 1) * sectorSize; // ★ 後ろのトラックのセクタの大きさで数える(冒頭)
          }
          if (gapStart >= 0 && !hasPregap) t.offset += (first - gapStart) * sectorSize;
          disc.tracks.push(t);
        }
        const lt = disc.tracks[disc.tracks.length - 1];
        lt.last = lt.first + Math.floor(Math.max(0, data.length - base - lt.offset) / lt.sectorSize) - 1;
        lt.open = false;
      }
      disc._finish();
      return disc;
    }

    /** ccd(CloneCD)+img からディスクを作る */
    static fromCcd(text, img) {
      const disc = new PceDisc();
      disc.files.push({ name: 'img', data: img, base: 0 });
      let sec = null; const entries = [];
      for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        const h = /^\[(.+)\]$/.exec(line);
        if (h) { sec = /^Entry/i.test(h[1]) ? {} : null; if (sec) entries.push(sec); continue; }
        const kv = /^([A-Za-z0-9]+)\s*=\s*(.+)$/.exec(line);
        if (sec && kv) sec[kv[1].toLowerCase()] = parseInt(kv[2], kv[2].toLowerCase().startsWith('0x') ? 16 : 10);
      }
      const tr = entries.filter(e => e.point >= 1 && e.point <= 99 && !isNaN(e.plba)).sort((a, b) => a.point - b.point);
      if (!tr.length) throw new Error('ccd: トラックが読めません');
      const total = Math.floor(img.length / 2352);
      for (let i = 0; i < tr.length; i++) {
        const first = tr[i].plba, last = (i + 1 < tr.length ? tr[i + 1].plba : total) - 1, data = (tr[i].control & 4) !== 0;
        disc.tracks.push({ number: tr[i].point, audio: !data, raw: data, sectorSize: 2352, file: 0, offset: first * 2352, first, last, open: false });
      }
      disc._finish();
      return disc;
    }

    /**
     * 一緒に選ばれたファイルの組からディスクを作る。set = { text(cue か ccd の中身), kind 'cue' | 'ccd', files: [{ name, data(Uint8Array) }], sub(Uint8Array、任意), names(一緒に選ばれた全ファイルの名前、任意。案内に使う) }
     * cue の FILE の名前は当てにならない(別の文字コードや、作った人の PC の絶対パスのことがある)ので、
     * 「名前(フォルダを除く、大文字小文字を無視)が同じ物 → FILE が 1 つでデータのファイルも 1 つならそれ → 並び順」で探す
     */
    static fromSet(set, opts) {
      const files = (set.files || []).filter(f => f && f.data);
      const base = (n) => String(n).replace(/^.*[\\/]/, '').toLowerCase();
      let disc;
      if (set.kind === 'ccd') {
        const img = files.find(f => /\.(img|bin)$/i.test(f.name)) || files[0];
        if (!img) throw new Error('ccd: img のファイルがありません');
        disc = PceDisc.fromCcd(set.text, img.data);
      } else {
        const total = PceDisc.parseCue(set.text).filter(f => f.tracks.length).length;
        disc = PceDisc.fromCue(set.text, (name, type, index) => {
          // 圧縮された音声(.mp3 など)を呼び出し側が PCM に直した物(decoded の印つき)は、拡張子を除いた名前で引き当てる
          // (cue は .wav を指しているのに実物は .mp3、という配り方がある。cue が .mp3 を指している時も同じ)
          const stemOf = (n) => base(n).replace(/\.[^.]+$/, '');
          const dec = files.find(f => f.decoded && stemOf(f.name) === stemOf(name));
          if (dec) return dec.data;
          if (type === 'MP3' || /\.(mp3|ogg|flac|ape)$/i.test(name)) throw new Error('cue: 圧縮された音声(' + base(name) + ')のトラックは読めません');
          const plain = files.filter(f => !f.decoded);
          const hit = plain.find(f => base(f.name) === base(name)) || (total === 1 && plain.length === 1 ? plain[0] : null) || (plain.length === total ? plain[index] : null);
          // 一緒に選ばれた物の中に、同じ名前の圧縮された音声(.mp3 など)がある時は、そう知らせる(cue は .wav を指しているのに実物は .mp3、という配り方がある)
          if (!hit) { const stem = base(name).replace(/\.[^.]+$/, ''); const z = (set.names || []).find(n => base(n).replace(/\.[^.]+$/, '') === stem && /\.(mp3|ogg|flac|ape|m4a)$/i.test(n)); if (z) throw new Error('cue: 圧縮された音声(' + base(z) + ')のトラックは読めません(元の音声の .wav か、音声ごと 1 つになった .bin が要ります)'); }
          return hit ? hit.data : null;
        }, opts);
      }
      if (set.sub) disc.sub = set.sub;
      return disc;
    }

    /** ディスクの見分け(ステートが同じディスクの物かを確かめる数) */
    /**
     * PC エンジンの CD らしいか: 最初のデータのトラックの 2 セクタ目(起動の見出し)の 32 バイト目から「PC Engine CD-ROM SYSTEM」。
     * [試験] 手元の 7 本は全部ここにある。[推定] Games Express の CD など、システムカードが別の物は違うかもしれないので、
     * 呼び出し側は「開かない」のではなく「知らせる」だけにする
     */
    get looksPce() {
      const t = this.tracks.find(x => !x.audio); if (!t) return false;
      const buf = new Uint8Array(2048), key = 'PC Engine CD-ROM SYSTEM';
      this.readData(t.first + 1, buf);
      for (let i = 0; i < key.length; i++) if (buf[32 + i] !== key.charCodeAt(i)) return false;
      return true;
    }

    get signature() {
      if (this._sig === undefined) {
        let h = (2166136261 ^ this.sectorCount ^ (this.tracks.length << 24)) | 0;
        const t = this.tracks.find(x => !x.audio), buf = new Uint8Array(2048);
        if (t) for (let s = 0; s < 2 && t.first + s <= t.last; s++) if (this.readData(t.first + s, buf)) for (let i = 0; i < 2048; i += 7) h = Math.imul(h ^ buf[i], 16777619) | 0;
        this._sig = h >>> 0;
      }
      return this._sig;
    }

    static wavDataOffset(d) {
      let p = 12;
      while (p + 8 <= d.length) {
        const id = String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]), len = d[p + 4] | (d[p + 5] << 8) | (d[p + 6] << 16) | (d[p + 7] * 0x1000000);
        if (id === 'data') return p + 8;
        p += 8 + len + (len & 1);
      }
      return 44;
    }

    _finish() {
      const lt = this.tracks[this.tracks.length - 1];
      this.sectorCount = lt ? lt.last + 1 : 0;
      this.endLba = this.sectorCount + 150;
    }

    /** セクタが属するトラック(0 始まりの番号)。どれにも属さなければ -1 */
    trackOf(sector) {
      const t = this.tracks;
      for (let i = 0; i < t.length; i++) if (sector >= t[i].first && sector <= t[i].last) return i;
      return -1;
    }

    /**
     * データのセクタ 2048 バイトを out に入れて、入れた個数を返す。
     * トラックに属さないセクタは 0 が 2048 個。ファイルからはみ出す時は 0 個([参照] 読めなかった時は何も足さない)
     */
    readData(sector, out) {
      const ti = this.trackOf(sector);
      if (ti < 0) { out.fill(0, 0, 2048); return 2048; }
      const t = this.tracks[ti], f = this.files[t.file];
      const at = f.base + t.offset + (sector - t.first) * t.sectorSize + (t.raw ? 16 : 0);
      if (at + 2048 > f.data.length) return 0;
      out.set(f.data.subarray(at, at + 2048));
      return 2048;
    }

    /** 音声の 1 個(セクタの中の n 番目、0-587)。side: 0 = 左、2 = 右 */
    sample(sector, n, side) {
      const ti = this.trackOf(sector);
      if (ti < 0) return 0;
      const t = this.tracks[ti], f = this.files[t.file], d = f.data;
      const at = f.base + t.offset + (sector - t.first) * 2352 + n * 4 + side;
      if (at + 1 >= d.length) return 0;
      const v = d[at] | (d[at + 1] << 8);
      return v & 0x8000 ? v - 0x10000 : v;
    }

    /** サブコードの 1 個(sector × 98 + pos 番目) */
    subByte(index) {
      const sub = this.sub;
      if (!sub) return 0;
      const sector = Math.floor(index / 98), pos = index % 98, base = sector * 96;
      if (base + 96 > sub.length) return 0;
      if (pos === 0) return 0x00;
      if (pos === 1) return 0x80;
      const j = (pos - 2) >> 3, k = 7 - ((pos - 2) & 7);
      let v = 0;
      for (let ch = 0; ch < 8; ch++) v |= ((sub[base + ch * 12 + j] >> k) & 1) << (7 - ch);
      return v;
    }

    /** 画面や記録に出す短い説明 */
    describe() {
      const n = this.tracks.length, d = this.tracks.filter(t => !t.audio).length;
      const sec = Math.floor(this.sectorCount / 75);
      return `CD ${n} トラック(データ ${d}、音声 ${n - d})${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }
  }

  PceDisc.msf = msf;
  Emu.PceDisc = PceDisc;
})(typeof window !== 'undefined' ? window : globalThis);
