/*
 * AAC(.m4a)エンコーダ MML.Audio.Aac
 *
 *   MML.Audio.Aac.isSupported()                    -> boolean(APIの有無だけ。同期)
 *   await MML.Audio.Aac.probe(sampleRate, ch)      -> boolean(実際に符号化できるか)
 *   await MML.Audio.Aac.encode(chans, sampleRate, opt) -> Blob('audio/mp4')
 *
 * 符号化そのものはブラウザ内蔵の WebCodecs AudioEncoder に任せる(外部ライブラリ不要)。
 * ただし WebCodecs が返すのは「AACの生のフレーム列」なので、容れ物(MP4/M4A)は自分で
 * 組む必要がある ─ それがこのファイルの後半。.m4a は中身がAACのMP4なので、
 * 音声1トラックだけの最小構成(ftyp + moov + mdat)で足りる。
 *
 * ★対応はブラウザ任せ。Chromium系は mp4a.40.2(AAC-LC)を通すが、他のブラウザや
 *   プラットフォームでは無い場合がある。呼ぶ側は必ず probe() で確認してから出すこと。
 * ★AACには符号化遅延(プライミング)がある。先頭の1024サンプルを edts/elst で読み飛ばす
 *   ことで、WAV/FLACと頭が揃うようにしている。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Audio = MML.Audio = MML.Audio || {};

  const CODEC = 'mp4a.40.2';   // AAC-LC
  const FRAME_SAMPLES = 1024;  // AAC-LCの1フレーム
  // 符号化遅延(プライミング)。0なら edts/elst を付けない。
  // ★実測(Chromium 152): WebCodecsのAAC出力は先頭フレームが入力の先頭に対応しており、
  //   プライミングぶんの余分な音は入っていない。ここで1024を読み飛ばすelstを付けると
  //   本物の音が1024サンプル欠ける(白色雑音との相互相関でlag=-1024を確認)。
  //   よって0。もし将来「頭が二重に鳴る/ずれる」ことがあれば、まずここを疑う
  const PRIMING = 0;

  function isSupported() { return typeof global.AudioEncoder !== 'undefined'; }

  async function probe(sampleRate, channels, bitrate) {
    if (!isSupported()) return false;
    try {
      const r = await global.AudioEncoder.isConfigSupported({
        codec: CODEC, sampleRate, numberOfChannels: channels, bitrate: bitrate || 192000,
      });
      return !!r.supported;
    } catch (e) { return false; }
  }

  // ── MP4ボックス組み立て ───────────────────────────────────────────────
  const enc4 = (s) => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
  function u32(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
  function u16(v) { return [(v >>> 8) & 255, v & 255]; }
  /** box('moov', child1, child2, ...) / 中身は数値配列かUint8Array */
  function box(type) {
    const parts = [];
    let len = 8;
    for (let i = 1; i < arguments.length; i++) {
      const p = arguments[i];
      if (!p) continue;
      parts.push(p);
      len += p.length;
    }
    const out = new Uint8Array(len);
    out.set(u32(len), 0);
    out.set(enc4(type), 4);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function bytes(arr) { return Uint8Array.from(arr); }

  /**
   * ESDS(ES_Descriptor)。asc は AudioSpecificConfig(WebCodecsの decoderConfig.description)。
   * 長さフィールドは常に4バイトの拡張形式(0x80 0x80 0x80 len)で書く ─ 短縮形と両方を
   * 場合分けするより単純で、どのデコーダも受け付ける。
   */
  function esdsBox(asc, avgBitrate) {
    function desc(tag, body) {
      const out = new Uint8Array(5 + body.length);
      out[0] = tag;
      out[1] = 0x80; out[2] = 0x80; out[3] = 0x80; // 4バイト拡張形式の継続バイト
      out[4] = body.length;                         // 中身は必ず128バイト未満に収まる
      out.set(body, 5);
      return out;
    }
    const dsi = desc(0x05, asc);                                   // DecoderSpecificInfo
    const dcdBody = new Uint8Array(13 + dsi.length);
    dcdBody[0] = 0x40;                                             // objectTypeIndication: MPEG-4 Audio
    dcdBody[1] = 0x15;                                             // streamType=audio(5)<<2 | upStream=0 | reserved=1
    dcdBody.set([0, 0, 0], 2);                                     // bufferSizeDB
    dcdBody.set(u32(avgBitrate || 0), 5);                          // maxBitrate
    dcdBody.set(u32(avgBitrate || 0), 9);                          // avgBitrate
    dcdBody.set(dsi, 13);
    const dcd = desc(0x04, dcdBody);                               // DecoderConfigDescriptor
    const sl = desc(0x06, bytes([0x02]));                          // SLConfigDescriptor: MP4固定
    const esBody = new Uint8Array(3 + dcd.length + sl.length);
    esBody.set(u16(1), 0);                                         // ES_ID
    esBody[2] = 0;                                                 // flags
    esBody.set(dcd, 3);
    esBody.set(sl, 3 + dcd.length);
    const es = desc(0x03, esBody);                                 // ES_Descriptor
    const body = new Uint8Array(4 + es.length);
    body.set(es, 4);                                               // version/flags = 0
    return box('esds', body);
  }

  function mp4aBox(channels, sampleRate, asc, avgBitrate) {
    const b = new Uint8Array(28);
    b.set(u16(1), 6);                       // data_reference_index
    b.set(u16(channels), 16);
    b.set(u16(16), 18);                     // sample size(固定値)
    b.set(u32(sampleRate * 65536), 24);     // 16.16固定小数(掛け算で組む: <<16 は符号ビットを踏む)
    return box('mp4a', b, esdsBox(asc, avgBitrate));
  }

  /**
   * 音声1トラックのMP4(=.m4a)を組む。
   * sizes: フレームごとのバイト数、data: 連結済みのAACフレーム列。
   */
  function buildM4a(opt) {
    const { sizes, data, sampleRate, channels, asc, avgBitrate } = opt;
    const nSamples = sizes.length;
    const duration = nSamples * FRAME_SAMPLES;            // メディア時間(timescale=sampleRate)
    // AACは1024サンプル単位なので、最後のフレームには元より長い無音の尻尾が付く。
    // 元の長さが分かっていれば edit list で切り詰め、WAV/FLACと同じ長さのファイルにする
    const real = opt.durationSamples ? Math.min(duration, opt.durationSamples + PRIMING) : duration;
    const trimmed = Math.max(0, real - PRIMING);          // プライミングを除いた再生長

    const ftyp = box('ftyp', bytes(enc4('M4A ').concat(u32(512), enc4('M4A '), enc4('isom'), enc4('mp42'))));

    const mvhd = box('mvhd', bytes([].concat(
      u32(0),            // version/flags
      u32(0), u32(0),    // 作成/更新日時(0でよい)
      u32(1000),         // timescale
      u32(Math.round(trimmed / sampleRate * 1000)),
      u32(0x00010000),   // rate 1.0
      u16(0x0100), u16(0), u32(0), u32(0),      // volume 1.0, reserved
      u32(0x00010000), u32(0), u32(0),          // 単位行列
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), // pre_defined
      u32(2)             // next_track_ID
    )));

    const tkhd = box('tkhd', bytes([].concat(
      [0, 0, 0, 7],      // version 0 / flags: enabled|inMovie|inPreview
      u32(0), u32(0),
      u32(1),            // track_ID
      u32(0),
      u32(Math.round(trimmed / sampleRate * 1000)),
      u32(0), u32(0),
      u16(0), u16(0),    // layer, alternate_group
      u16(0x0100), u16(0), // volume 1.0
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(0), u32(0)     // width, height
    )));

    // プライミング(先頭1024サンプル)を読み飛ばすedit list。
    // ★segment_durationは「動画のtimescale(=1000)」、media_timeは「メディアのtimescale
    //   (=サンプルレート)」で数える。単位が違うので取り違えると長さが桁違いになる
    // edit list: 先頭のプライミング(PRIMING、今は0)を飛ばし、末尾の詰め物を切る。
    // segment_durationは動画のtimescale(1000)、media_timeはメディアのtimescale
    // (=サンプルレート)で数える。単位が違うので取り違えると長さが桁違いになる
    const edts = (PRIMING > 0 || trimmed < duration) ? box('edts', box('elst', bytes([].concat(
      u32(0), u32(1),
      u32(Math.round(trimmed / sampleRate * 1000)), u32(PRIMING),
      u16(1), u16(0)     // media_rate 1.0
    )))) : null;

    const mdhd = box('mdhd', bytes([].concat(
      u32(0), u32(0), u32(0),
      u32(sampleRate), u32(duration),
      u16(0x55c4),       // 言語 'und'
      u16(0)
    )));
    const hdlr = box('hdlr', bytes([].concat(
      u32(0), u32(0), enc4('soun'), u32(0), u32(0), u32(0), [0]
    )));
    const smhd = box('smhd', bytes([].concat(u32(0), u16(0), u16(0))));
    const dref = box('dref', bytes([].concat(u32(0), u32(1))), box('url ', bytes(u32(1))));
    const dinf = box('dinf', dref);

    const stsd = box('stsd', bytes([].concat(u32(0), u32(1))), mp4aBox(channels, sampleRate, asc, avgBitrate));
    const stts = box('stts', bytes([].concat(u32(0), u32(1), u32(nSamples), u32(FRAME_SAMPLES))));
    const stsc = box('stsc', bytes([].concat(u32(0), u32(1), u32(1), u32(nSamples), u32(1))));

    const stszBody = new Uint8Array(12 + nSamples * 4);
    stszBody.set(u32(0), 0);           // version/flags
    stszBody.set(u32(0), 4);           // sample_size=0 → 個別に並べる
    stszBody.set(u32(nSamples), 8);
    for (let i = 0; i < nSamples; i++) stszBody.set(u32(sizes[i]), 12 + i * 4);
    const stsz = box('stsz', stszBody);

    // stcoはmdatの位置に依存する。moovの大きさが決まらないと書けないので、まず0で組んで
    // 全体の長さを測り、確定したオフセットで組み直す(2回組むだけなので単純で確実)
    const build = (chunkOffset) => {
      const stco = box('stco', bytes([].concat(u32(0), u32(1), u32(chunkOffset))));
      const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
      const minf = box('minf', smhd, dinf, stbl);
      const mdia = box('mdia', mdhd, hdlr, minf);
      const trak = box('trak', tkhd, edts, mdia);
      return box('moov', mvhd, trak);
    };
    let moov = build(0);
    const mdatOffset = ftyp.length + moov.length + 8; // +8 = mdatのボックスヘッダ
    moov = build(mdatOffset);

    const mdatHeader = new Uint8Array(8);
    mdatHeader.set(u32(8 + data.length), 0);
    mdatHeader.set(enc4('mdat'), 4);
    return new Blob([ftyp, moov, mdatHeader, data], { type: 'audio/mp4' });
  }

  // ── 公開API ───────────────────────────────────────────────────────────
  /**
   * Float32のチャンネル配列をAAC(.m4a)へ符号化する。
   * opt = { gain, bitrate, onProgress(0..1) }
   */
  async function encode(chans, sampleRate, opt) {
    opt = opt || {};
    if (!isSupported()) throw new Error('このブラウザはAACの書き出しに対応していません');
    const gain = opt.gain === undefined ? 1 : opt.gain;
    const bitrate = opt.bitrate || 192000;
    const channels = chans.length;
    const total = chans[0] ? chans[0].length : 0;

    const chunks = [];   // 符号化済みフレーム
    const sizes = [];
    let asc = null;      // AudioSpecificConfig(最初のoutputのmetadataで来る)
    let failed = null;

    const encoder = new global.AudioEncoder({
      output: (chunk, metadata) => {
        if (!asc && metadata && metadata.decoderConfig && metadata.decoderConfig.description) {
          const d = metadata.decoderConfig.description;
          asc = d instanceof Uint8Array ? d.slice() : new Uint8Array(d.buffer ? d.buffer.slice(0) : d);
        }
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        chunks.push(b);
        sizes.push(b.length);
      },
      error: (e) => { failed = e; },
    });
    encoder.configure({ codec: CODEC, sampleRate, numberOfChannels: channels, bitrate });

    // f32-planar で流す。1回あたり1秒ぶんにして進捗を出しつつ手を離す
    const step = sampleRate;
    for (let at = 0; at < total && !failed; at += step) {
      const take = Math.min(step, total - at);
      const planar = new Float32Array(take * channels);
      for (let c = 0; c < channels; c++) {
        const src = chans[c];
        const base = c * take;
        for (let i = 0; i < take; i++) {
          let v = src[at + i] * gain;
          if (v > 1) v = 1; else if (v < -1) v = -1;
          planar[base + i] = v;
        }
      }
      const ad = new global.AudioData({
        format: 'f32-planar', sampleRate, numberOfFrames: take,
        numberOfChannels: channels, timestamp: Math.round(at / sampleRate * 1e6), data: planar,
      });
      encoder.encode(ad);
      ad.close();
      if (opt.onProgress) opt.onProgress((at + take) / total * 0.9);
      // encodeQueueSize が溜まりすぎないよう、1秒ぶんごとに手を離す
      await new Promise((r) => setTimeout(r, 0));
    }
    // ★エラーはコールバックで飛んでくる。その時点でコーデックは閉じているので、
    //   flush()/close()はどちらも例外を出す。元のエラーを握り潰さないよう順番に注意する
    try { await encoder.flush(); } catch (e) { if (!failed) failed = e; }
    try { encoder.close(); } catch (e) { /* 既に閉じている */ }
    if (failed) throw failed;
    if (!chunks.length) throw new Error('AACの符号化結果が空でした');
    if (!asc) throw new Error('AACのdecoderConfigが取得できませんでした');
    if (opt.onProgress) opt.onProgress(1);

    let n = 0;
    for (const c of chunks) n += c.length;
    const data = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { data.set(c, o); o += c.length; }

    return buildM4a({ sizes, data, sampleRate, channels, asc, avgBitrate: bitrate, durationSamples: total });
  }

  Audio.Aac = { isSupported, probe, encode, buildM4a, CODEC };
})(window);
