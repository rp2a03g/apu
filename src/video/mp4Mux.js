/*
 * MP4多重化(映像 H.264 + 音声 AAC) MML.Video.Mp4
 *
 *   MML.Video.Mp4.build({ video, audio }) -> Blob('video/mp4')
 *     video = { width, height, timescale, samples:[{ size, key, dts, pts }], data:Uint8Array, avcC:Uint8Array }
 *       dts/pts は timescale 単位。samples は復号順(WebCodecs の出力順)に並べる。
 *       data は AVCC 形式(4バイト長さ前置の NAL 列。VideoEncoder を avc:{format:'avc'} で構成したときの出力)
 *     audio = MML.Audio.Aac.encodeRaw の戻り値 { sizes, data, sampleRate, channels, asc, avgBitrate, durationSamples }
 *
 * 音声だけの .m4a は src/audio/aacEncoder.js の buildM4a が組む。ここはその映像版で、ボックスの
 * 部品(box/u32…/mp4aBox)は同じものを借りている。moov を先頭に置く(ftyp + moov + mdat)ので
 * 頭から読める。mdat は1秒ごとに映像チャンク・音声チャンクを交互に並べる(インターリーブ)。
 * ★X(Twitter)向けの要件(H.264 High + AAC-LC + moov先頭)は一般的な知識にもとづく推定で、
 *   実際に受け付けられるかは投稿して確かめる。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Video = MML.Video = MML.Video || {};

  const MOVIE_TS = 1000; // mvhd/tkhd/elst の時間単位(ミリ秒)

  function parts() { return MML.Audio.Aac.mp4; } // { box, bytes, u32, u16, enc4, mp4aBox }

  // fullBox('stsd', version, flags, body, child1, ...) — 4バイトの version/flags を頭に付けた box
  function fullBox(type, version, flags) {
    const { box, bytes } = parts();
    const head = bytes([version & 255, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255]);
    return box.apply(null, [type, head].concat(Array.prototype.slice.call(arguments, 3)));
  }

  // ── 共通のトラック部品 ─────────────────────────────────────────────
  function mvhd(durationMs, nextTrackId) {
    const { u32, u16, bytes } = parts();
    return fullBox('mvhd', 0, 0, bytes([].concat(
      u32(0), u32(0), u32(MOVIE_TS), u32(durationMs), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
      u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(nextTrackId)
    )));
  }

  function tkhd(trackId, durationMs, opt) {
    const { u32, u16, bytes } = parts();
    const isVideo = !!opt.width;
    return fullBox('tkhd', 0, 7, bytes([].concat(
      u32(0), u32(0), u32(trackId), u32(0), u32(durationMs), u32(0), u32(0),
      u16(0), u16(0), u16(isVideo ? 0 : 0x0100), u16(0),
      u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
      u32(isVideo ? (opt.width << 16) >>> 0 : 0), u32(isVideo ? (opt.height << 16) >>> 0 : 0)
    )));
  }

  function mdhd(timescale, duration) {
    const { u32, u16, bytes } = parts();
    return fullBox('mdhd', 0, 0, bytes([].concat(u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0))));
  }

  function hdlr(kind, name) {
    const { u32, enc4, bytes } = parts();
    const nm = Array.from(new TextEncoder().encode(name)).concat([0]);
    return fullBox('hdlr', 0, 0, bytes([].concat(u32(0), enc4(kind), u32(0), u32(0), u32(0), nm)));
  }

  function dinf() {
    const { box, u32, bytes } = parts();
    return box('dinf', fullBox('dref', 0, 0, bytes(u32(1)), fullBox('url ', 0, 1, bytes([]))));
  }

  // stsc/stco: chunkSizes = 各チャンクのサンプル数、chunkOffsets = 各チャンクのファイル先頭からの位置
  function stscBox(chunkSizes) {
    const { u32 } = parts();
    const entries = [];
    for (let i = 0; i < chunkSizes.length; i++) {
      if (i === 0 || chunkSizes[i] !== chunkSizes[i - 1]) entries.push([i + 1, chunkSizes[i]]);
    }
    const body = new Uint8Array(4 + entries.length * 12);
    body.set(u32(entries.length), 0);
    entries.forEach(([first, n], i) => { body.set(u32(first), 4 + i * 12); body.set(u32(n), 8 + i * 12); body.set(u32(1), 12 + i * 12); });
    return fullBox('stsc', 0, 0, body);
  }
  function stcoBox(chunkOffsets) {
    const { u32 } = parts();
    const body = new Uint8Array(4 + chunkOffsets.length * 4);
    body.set(u32(chunkOffsets.length), 0);
    chunkOffsets.forEach((o, i) => body.set(u32(o), 4 + i * 4));
    return fullBox('stco', 0, 0, body);
  }
  function stszBox(sizes) {
    const { u32 } = parts();
    const body = new Uint8Array(8 + sizes.length * 4);
    body.set(u32(0), 0);
    body.set(u32(sizes.length), 4);
    sizes.forEach((s, i) => body.set(u32(s), 8 + i * 4));
    return fullBox('stsz', 0, 0, body);
  }

  // ── 映像トラック固有 ─────────────────────────────────────────────
  function avc1Box(width, height, avcC) {
    const { box, u32, u16, bytes } = parts();
    const b = new Uint8Array(78);
    b.set(u16(1), 6);                 // data_reference_index
    b.set(u16(width), 24);
    b.set(u16(height), 26);
    b.set(u32(0x00480000), 28);       // 72dpi
    b.set(u32(0x00480000), 32);
    b.set(u16(1), 40);                // frame_count
    // compressorname(32バイト、先頭が長さ)は0のまま
    b.set(u16(0x0018), 74);           // depth
    b.set(u16(0xFFFF), 76);           // pre_defined = -1
    const avcCBox = box('avcC', avcC);
    return box('avc1', b, avcCBox, box('pasp', bytes([].concat(u32(1), u32(1)))));
  }

  // 複合オフセット(ctts)。B フレームが無ければ null。あれば version 0 で書けるよう
  // 全体を shift だけずらし、その分を elst で読み飛ばす
  function cttsInfo(samples) {
    const offs = samples.map((s) => s.pts - s.dts);
    if (offs.every((o) => o === 0)) return null;
    const shift = -Math.min(0, ...offs);
    return { shift, offsets: offs.map((o) => o + shift) };
  }

  function videoTrak(v, durationMs, chunkSizes, chunkOffsets) {
    const { box, u32, bytes } = parts();
    const n = v.samples.length;
    // stts: 復号時刻の差分(等間隔でない場合も run-length で書く)
    const runs = [];
    for (let i = 0; i < n; i++) {
      const d = (i + 1 < n ? v.samples[i + 1].dts : v.samples[i].dts + (v.frameDur || 0)) - v.samples[i].dts;
      if (runs.length && runs[runs.length - 1][1] === d) runs[runs.length - 1][0]++; else runs.push([1, d]);
    }
    const sttsBody = new Uint8Array(4 + runs.length * 8);
    sttsBody.set(u32(runs.length), 0);
    runs.forEach(([c, d], i) => { sttsBody.set(u32(c), 4 + i * 8); sttsBody.set(u32(d), 8 + i * 8); });
    const stts = fullBox('stts', 0, 0, sttsBody);

    const keys = [];
    v.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
    const stssBody = new Uint8Array(4 + keys.length * 4);
    stssBody.set(u32(keys.length), 0);
    keys.forEach((k, i) => stssBody.set(u32(k), 4 + i * 4));
    const stss = fullBox('stss', 0, 0, stssBody);

    const ct = cttsInfo(v.samples);
    let ctts = null;
    if (ct) {
      const cruns = [];
      for (const o of ct.offsets) {
        if (cruns.length && cruns[cruns.length - 1][1] === o) cruns[cruns.length - 1][0]++; else cruns.push([1, o]);
      }
      const body = new Uint8Array(4 + cruns.length * 8);
      body.set(u32(cruns.length), 0);
      cruns.forEach(([c, o], i) => { body.set(u32(c), 4 + i * 8); body.set(u32(o), 8 + i * 8); });
      ctts = fullBox('ctts', 0, 0, body);
    }
    const mediaDur = v.samples.length ? (v.samples[n - 1].dts + (v.frameDur || 0)) : 0;
    const edts = ct ? box('edts', fullBox('elst', 0, 0, bytes([].concat(
      u32(1), u32(durationMs), u32(ct.shift), u32(0x00010000))))) : null;

    const stsd = fullBox('stsd', 0, 0, bytes(u32(1)), avc1Box(v.width, v.height, v.avcC));
    const stbl = box('stbl', stsd, stts, stss, ctts, stscBox(chunkSizes), stszBox(v.samples.map((s) => s.size)), stcoBox(chunkOffsets));
    const vmhd = fullBox('vmhd', 0, 1, bytes([0, 0, 0, 0, 0, 0, 0, 0]));
    const minf = box('minf', vmhd, dinf(), stbl);
    const mdia = box('mdia', mdhd(v.timescale, mediaDur), hdlr('vide', 'VideoHandler'), minf);
    return box('trak', tkhd(1, durationMs, { width: v.width, height: v.height }), edts, mdia);
  }

  // ── 音声トラック(buildM4a と同じ構成、チャンク分割だけ違う) ─────────────
  function audioTrak(a, durationMs, chunkSizes, chunkOffsets) {
    const { box, u32, u16, bytes, mp4aBox } = parts();
    const FR = MML.Audio.Aac.FRAME_SAMPLES;
    const n = a.sizes.length;
    const duration = n * FR;
    const real = a.durationSamples ? Math.min(duration, a.durationSamples) : duration;
    const edts = real < duration ? box('edts', fullBox('elst', 0, 0, bytes([].concat(
      u32(1), u32(Math.round(real / a.sampleRate * MOVIE_TS)), u32(0), u32(0x00010000))))) : null;
    const stsd = fullBox('stsd', 0, 0, bytes(u32(1)), mp4aBox(a.channels, a.sampleRate, a.asc, a.avgBitrate));
    const stts = fullBox('stts', 0, 0, bytes([].concat(u32(1), u32(n), u32(FR))));
    const stbl = box('stbl', stsd, stts, stscBox(chunkSizes), stszBox(a.sizes), stcoBox(chunkOffsets));
    const smhd = fullBox('smhd', 0, 0, bytes([].concat(u16(0), u16(0))));
    const minf = box('minf', smhd, dinf(), stbl);
    const mdia = box('mdia', mdhd(a.sampleRate, duration), hdlr('soun', 'SoundHandler'), minf);
    return box('trak', tkhd(2, Math.round(real / a.sampleRate * MOVIE_TS), {}), edts, mdia);
  }

  /**
   * 映像+音声を1つのMP4に組む。audio は省略可(映像だけ)。
   * 1秒ごとに [映像チャンク][音声チャンク] を交互に並べる。
   */
  function build(opt) {
    const { box, u32, enc4, bytes } = parts();
    const v = opt.video, a = opt.audio || null;
    const FR = MML.Audio.Aac.FRAME_SAMPLES;
    const vSec = (s) => s.pts / v.timescale;
    const aSec = (i) => i * FR / a.sampleRate;
    const totalSec = Math.max(
      v.samples.length ? (v.samples[v.samples.length - 1].dts + (v.frameDur || 0)) / v.timescale : 0,
      a ? a.sizes.length * FR / a.sampleRate : 0);
    const nChunks = Math.max(1, Math.ceil(totalSec));

    // チャンク割り: 秒ごとのサンプル数(復号順のまま切る。pts で秒を決めるので B フレームがあっても
    // 「その秒に表示される絵」が近くに固まる)
    const vChunkSizes = new Array(nChunks).fill(0);
    v.samples.forEach((s) => { vChunkSizes[Math.min(nChunks - 1, Math.max(0, Math.floor(vSec(s))))]++; });
    const aChunkSizes = a ? new Array(nChunks).fill(0) : null;
    if (a) a.sizes.forEach((_, i) => { aChunkSizes[Math.min(nChunks - 1, Math.floor(aSec(i)))]++; });

    // mdat の並び順と各チャンクのバイト数
    const order = []; // { track:'v'|'a', chunk, bytes }
    let vi = 0, ai = 0;
    for (let c = 0; c < nChunks; c++) {
      let vb = 0; for (let k = 0; k < vChunkSizes[c]; k++) vb += v.samples[vi + k].size; vi += vChunkSizes[c];
      order.push({ track: 'v', chunk: c, bytes: vb });
      if (a) { let ab = 0; for (let k = 0; k < aChunkSizes[c]; k++) ab += a.sizes[ai + k]; ai += aChunkSizes[c]; order.push({ track: 'a', chunk: c, bytes: ab }); }
    }
    // 空チャンクは stsc/stco に書かない(samples_per_chunk=0 は不正)
    const vChunks = vChunkSizes.filter((n) => n > 0);
    const aChunks = a ? aChunkSizes.filter((n) => n > 0) : null;

    const durationMs = Math.round(totalSec * MOVIE_TS);
    const ftyp = box('ftyp', bytes(enc4('isom').concat(u32(512), enc4('isom'), enc4('iso2'), enc4('avc1'), enc4('mp41'))));

    const buildMoov = (mdatStart) => {
      const vOff = [], aOff = [];
      let pos = mdatStart;
      for (const o of order) {
        if (o.bytes === 0) continue;
        (o.track === 'v' ? vOff : aOff).push(pos);
        pos += o.bytes;
      }
      return box('moov', mvhd(durationMs, 3), videoTrak(v, durationMs, vChunks, vOff), a ? audioTrak(a, durationMs, aChunks, aOff) : null);
    };
    let moov = buildMoov(0);
    const mdatStart = ftyp.length + moov.length + 8;
    moov = buildMoov(mdatStart);

    // mdat の中身を並べ替えて詰める(元データは復号順の連結なので、チャンクごとに切り出す)
    let total = 0; for (const o of order) total += o.bytes;
    const mdat = new Uint8Array(8 + total);
    mdat.set(u32(8 + total), 0); mdat.set(enc4('mdat'), 4);
    let w = 8, vPos = 0, aPos = 0;
    vi = 0; ai = 0;
    for (const o of order) {
      if (o.track === 'v') {
        const n = vChunkSizes[o.chunk];
        for (let k = 0; k < n; k++) { const sz = v.samples[vi + k].size; mdat.set(v.data.subarray(vPos, vPos + sz), w); w += sz; vPos += sz; }
        vi += n;
      } else {
        const n = aChunkSizes[o.chunk];
        for (let k = 0; k < n; k++) { const sz = a.sizes[ai + k]; mdat.set(a.data.subarray(aPos, aPos + sz), w); w += sz; aPos += sz; }
        ai += n;
      }
    }
    return new Blob([ftyp, moov, mdat], { type: 'video/mp4' });
  }

  Video.Mp4 = { build };
})(window);
