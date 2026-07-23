/*
 * N163拡張音源(波形音源、最大8ch・可変) → MML共通イベント形式 抽出
 * MML.Nsf2MmlExpansion.n163(writeLog, totalFrames, envReg, waveReg, initRegs, initWrites)
 *   → { channels: [...], n163Wave }
 *
 * レジスタ: $F800=内部RAMアドレス(bits0-6)+自動インクリメント(bit7), $4800=データ。
 *   有効チャンネル数 numCh = (($7F>>4)&7)+1。実機は内部8ch中「上位 numCh 個」だけを
 *   15CPUサイクルごとに巡回・ミックスする。チャンネルchのレジスタブロックは 0x40+ch*8:
 *     +0/+2/+4 = 18bit周波数(+4のbit2-7は波形長フィールドと共用, +1/+3/+5は位相),
 *     +6 = 波形開始オフセット(4bitサンプル単位), +7 = bits0-3=音量($7Fのみbits4-6=numCh)。
 *   出力周波数 f = CPU * freqReg / (15 * 65536 * length * numCh)、length = 256-(+4&0xFC)。
 * 専用のアタックレジスタが無いため、音量 0→非0 の遷移をノートオンとして扱う。
 *
 * 【重要】以前の実装は「常に8ch・ch0(0x40)の波形を全ch共有」と決め打っていたため、
 *  4chの曲では実チャンネル(上位4個=0x60/0x68/0x70/0x78)を読まず、未使用領域(0x40-0x58、
 *  実際には波形データが入る)をチャンネルとして誤読していた。ここでは $7F から numCh を求め、
 *  上位 numCh 個だけを「下位アドレス側から」letters[0..] に割り当てる(コンパイラ/ppmckDriver
 *  の internalIdx = (8-numCh)+i と一致)。周波数も numCh を含む実機式で算出する。
 *
 * 波形は各チャンネルが自分の波形(+6のオフセット/+4の長さ)を持つため、ch0共有ではなく
 * チャンネルごとに実波形を読み出し、コンパイラのN163波形長(16サンプル)へリサンプリングして
 * waveReg(WaveRegistry、曲全体で共有・重複排除)に登録し、@<n>(instrument)で選択する。
 * N163にはハードウェア音量エンベロープが無く音量は完全にソフトウェア書き込みのみなので、
 * ピッチ/波形が同じ間は音量変化だけでは区切らずvolSeqに積み、envReg(EnvelopeRegistry)へ
 * 実測形状として登録する(2A03等と同じ考え方)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Nsf2MmlExpansion = MML.Nsf2MmlExpansion || {};

  const CPU_CLOCK = 1789773;
  const OUT_WAVE_LEN = 16; // コンパイラ側 N163_WAVE_LEN と一致させる

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }

  // 128byte RAM から base のチャンネルの波形を実長で読み、OUT_WAVE_LEN 点へリサンプリングする。
  // 波形アドレス(+6)・波形長(+4)は各チャンネル固有。サンプルは4bit(ニブル)単位でRAMに詰まる。
  function resampleWave(ram, base) {
    const waveOffset = ram[base + 6];
    const length = Math.max(1, 256 - (ram[base + 4] & 0xFC));
    const sampleAt = a => (ram[(a >> 1) & 0x7F] >> ((a & 1) * 4)) & 0x0F;
    const raw = [];
    for (let i = 0; i < length; i++) raw.push(sampleAt((waveOffset + i) & 0xFF));
    const wave = new Array(OUT_WAVE_LEN);
    for (let i = 0; i < OUT_WAVE_LEN; i++) {
      const srcPos = Math.floor((i / OUT_WAVE_LEN) * raw.length) % raw.length;
      wave[i] = raw[srcPos] || 0;
    }
    return wave;
  }

  // フレームごとの 128byte RAM スナップショットと有効ch数の配列を作る。
  // 【最優先】capture.js が採取したライブチップの n163Snapshots があればそれを使う。
  //   N163は$F800(アドレスラッチ)+$4800(データ)の間接アドレッシングで、ドライバは位相バイトを
  //   $4800の「読み飛ばし」でスキップする(読み出しもオートインクリメントを進める)。writeLogは
  //   書き込みしか記録しないため、ログ再生ではアドレスポインタがズレて周波数/波形/音量が
  //   全て誤った位置から読まれる(Rolling Thunder等のインターリーブ配置ドライバで顕著)。
  // 【フォールバック】スナップショットが無い場合のみ writeLog を再生する(近似・非インターリーブ用)。
  function buildTimeline(writeLog, initWrites, n163Snapshots) {
    if (n163Snapshots && n163Snapshots.length) {
      return n163Snapshots.map(snap => {
        const ram = snap || new Uint8Array(128);
        return { ram, numCh: ((ram[0x7F] >> 4) & 0x07) + 1 };
      });
    }
    const ram = new Uint8Array(128);
    let addr = 0, autoInc = false;
    function applyWrite(a, value) {
      if      (a === 0xF800) { addr = value & 0x7F; autoInc = !!(value & 0x80); }
      else if (a === 0x4800) { ram[addr] = value; if (autoInc) addr = (addr + 1) & 0x7F; }
    }
    for (const { addr: a, value } of (initWrites || [])) applyWrite(a, value);
    return writeLog.map(writes => {
      for (const { addr: a, value } of writes) applyWrite(a, value);
      return { ram: ram.slice(), numCh: ((ram[0x7F] >> 4) & 0x07) + 1 };
    });
  }

  // ピッチ/波形が同じ間は音量変化だけでは区切らずvolSeqに積む(ソフトウェア音量エンベロープ抽出用)。
  function extractChannelEvents(timeline, base) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const ram = timeline[f].ram;
      const numCh = timeline[f].numCh;
      const freqReg = ram[base + 0] | (ram[base + 2] << 8) | ((ram[base + 4] & 0x03) << 16);
      const volume  = ram[base + 7] & 0x0F;
      const length  = Math.max(1, 256 - (ram[base + 4] & 0xFC));
      const freq = (freqReg * CPU_CLOCK) / (15 * 65536 * length * numCh);
      const wave = resampleWave(ram, base);
      const waveKey = wave.join(',');
      const note = (volume > 0 && freqReg > 0) ? freqToNoteNumber(freq) : null;
      if (!cur) { cur = { note, wave, waveKey, start: f, end: f, volSeq: [volume] }; continue; }
      if (note !== cur.note || waveKey !== cur.waveKey) {
        flush(f);
        cur = { note, wave, waveKey, start: f, end: f, volSeq: [volume] };
      } else {
        cur.volSeq.push(volume);
      }
    }
    flush(timeline.length);
    return events;
  }

  MML.Nsf2MmlExpansion.n163 = function (writeLog, totalFrames, envReg, waveReg, initRegs, initWrites, n163Snapshots) {
    const timeline = buildTimeline(writeLog, initWrites, n163Snapshots);
    // 曲を通しての有効ch数(通常は一定)。上位 numCh 個を下位アドレス側から letters[0..] に割当てる。
    let songNumCh = 1;
    for (const t of timeline) if (t.numCh > songNumCh) songNumCh = t.numCh;

    const letters = 'EFGHIJKL'.split(''); // 仮のレター。converter.js が expansionLetterMap['n163'] で振り直す
    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: volSeq[0] } : { envelopeV: idx };
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note },
      ev.note !== null ? Object.assign(
        { instrument: waveReg ? waveReg.assign(ev.wave) : 0 },
        toVolumeFields(ev.volSeq)
      ) : {}
    );

    const channels = [];
    for (let i = 0; i < songNumCh; i++) {
      const base = 0x40 + (8 - songNumCh + i) * 8; // internalIdx = (8-numCh)+i、下位側から
      channels.push({
        letter: letters[i],
        events: extractChannelEvents(timeline, base).map(toCommon),
        hasVolume: true,
        hasEnvelope: true,
        hasInstrument: true
      });
    }

    // 波形エディタUIの既定波形として、最終フレームの先頭(最下位アドレス)チャンネルの波形を返す
    const lastRam = timeline.length > 0 ? timeline[timeline.length - 1].ram : null;
    const n163Wave = lastRam ? resampleWave(lastRam, 0x40 + (8 - songNumCh) * 8) : null;

    return { channels, n163Wave };
  };

})(window);
