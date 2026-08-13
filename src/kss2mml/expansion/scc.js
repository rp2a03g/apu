/*
 * Konami SCC/SCC+ → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock, waveReg) → { channels: [...], n163Wave }
 *
 * レジスタ窓の位置(0x9800台 / 0xB800台)も配置もclassic(SCC)とSCC+(SCC-I)で異なるため、
 * kssBus.js の _sccWrite と同じ状態機械をwriteLogから再現してモードを追跡する
 * (配置の詳細は src/emulator/expansion/sccAudio.js のコメント参照)。
 *
 * このアプリのMMLプレイヤーはSCCへ直接対応しないため、波形はN163形式(符号無し4bit,16点)へ
 * リサンプリングしてwaveReg(WaveRegistry、曲全体で重複排除)に登録し、@<n>(instrument)で
 * チャンネルごと・曲中の切替も含めて選択する(nsf2mml/expansion/n163.jsと同じ考え方)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Kss2MmlExpansion = MML.Kss2MmlExpansion || {};

  // ★2026-08-02: 16(N163_WAVE_LEN既定)から32(SCCの実波形長そのもの)へ変更。N163Alloc
  // (src/mml/n163Alloc.js)は@N<n>定義の実際の配列長をそのまま読むので16固定である必要はなく、
  // 16へ間引くと波形が持つ倍音情報が失われる(音色の解像度劣化)。32にすると
  // resampleWave()のリサンプリングが恒等写像になり、ビット深度変換(8bit符号付き→4bit
  // 符号無し)だけの劣化で済む。ただしN163内蔵RAMの波形領域は128ニブル固定
  // (N163Alloc.MAX_BYTES=64byte、numCh混在時でも定数)なので、同時に4つを超える異なる
  // 32要素波形が使われる曲ではRAM不足のconflictが出る可能性がある(要検証)。
  MML.Kss2MmlExpansion.SCC_WAVE_LEN = 32;
  const OUT_WAVE_LEN = MML.Kss2MmlExpansion.SCC_WAVE_LEN;

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }

  // classic(SCC)とSCC+(SCC-I)でレジスタ窓の位置も配置も異なるため、kssBus.js の
  // _sccWrite と同じ状態機械をwriteLogから再現してモードを追跡する。
  // ・0xBFFE/0xBFFF書込みのbit5でレジスタ窓を 0x9000 系 / 0xB000 系へ切替
  // ・窓先頭(0x9000 or 0xB000)への書込みが 0x3F ならclassic有効、bit7立ちならSCC+有効
  // これを見ずに0xB800台をclassic配置で解釈すると、SCC+タイトル(スナッチャー系)の
  // 周波数/音量を波形と取り違えて音符が一切抽出できない。
  function makeSccDecoder() {
    return { base: 0x9000, plus: false };
  }
  // 音源レジスタ窓内のオフセット(0x00-0xFF)を返す。窓外・モードレジスタ等は-1。
  function decodeAddr(state, addr, value) {
    if ((addr & 0xFFFE) === 0xBFFE) { state.base = 0x9000 | ((value & 0x20) << 8); return -1; }
    if (addr < state.base) return -1;
    const off = addr - state.base;
    if (off === 0) {
      if (value === 0x3F) state.plus = false;
      else if (value & 0x80) state.plus = true;
      return -1;
    }
    if (off < 0x800 || off > 0x8FF) return -1;
    return off - 0x800;
  }

  // SCCの符号付き8bit波形(32点)を N163形式(4bit符号無し, 16点)へ変換する。
  // N163エンコーダ経由でしか再生できないため(compiler.jsにSCCネイティブ経路が無い)、
  // 波形が完全一致するわけではないが近似として抽出する。
  function resampleWave(wave) {
    const out = new Array(OUT_WAVE_LEN);
    for (let i = 0; i < OUT_WAVE_LEN; i++) {
      const srcPos = Math.floor((i / OUT_WAVE_LEN) * 32) % 32;
      out[i] = Math.max(0, Math.min(15, (wave[srcPos] + 128) >> 4));
    }
    return out;
  }

  // 実チップが1フレーム(1/60秒)の間に取り得る書込み数の現実的な上限。5ch分の波形を
  // まるごと差し替えても 5*32=160byte 程度にしかならない。KSSはbankNum>0(Konami系
  // バンク切替マッパー)の曲であれば0x9800-9FFF/0xB800-BFFF窓を常時SCCとしてデコードする
  // (kssBus.js参照、Space Manbow等0x3Fトリックを使わないタイトル救済のため)が、この窓は
  // 実チップ非搭載時にはROM/ワークRAMとして通常のデータ用途にも使われうる。ある曲でその
  // 領域へ数百〜数千byte規模の一括書込み(LDIR等によるデータロード)が起きると、SCCレジスタ
  // 書込みと誤認識してデタラメな音程/音量の音符が延々鳴り続ける不具合になる
  // (Ys1 12曲目で実測: 1フレームで4096byte書込み)。閾値を超えるフレームはチップ操作とは
  // みなさず読み捨てる。
  const BULK_COPY_THRESHOLD_PER_FRAME = 256;

  function buildTimeline(writeLog) {
    const freq = new Uint16Array(5);
    const volume = new Uint8Array(5);
    let enable = 0x1F;
    const wave = [];
    for (let i = 0; i < 5; i++) wave.push(new Int8Array(32));
    const state = makeSccDecoder();
    return writeLog.map(writes => {
      let rangeWriteCount = 0;
      for (const { addr, io } of writes) {
        if (io) continue;
        if ((addr >= 0x9800 && addr <= 0x9FFF) || (addr >= 0xB800 && addr <= 0xBFFF)) rangeWriteCount++;
      }
      const isBulkCopy = rangeWriteCount > BULK_COPY_THRESHOLD_PER_FRAME;
      for (const { addr, value, io } of writes) {
        if (io) continue;
        if (isBulkCopy && ((addr >= 0x9800 && addr <= 0x9FFF) || (addr >= 0xB800 && addr <= 0xBFFF))) continue;
        const off = decodeAddr(state, addr, value);
        if (off < 0) continue;
        if (state.plus) {
          // SCC+: 0x00-0x9F=波形ch0-4 / 0xA0-0xA9=周波数 / 0xAA-0xAE=音量 / 0xAF=有効ビット
          if (off < 0xA0) { wave[off >> 5][off & 0x1F] = value; continue; }
          if (off <= 0xA9) {
            const ch = (off - 0xA0) >> 1;
            if (off & 1) freq[ch] = (freq[ch] & 0x00FF) | ((value & 0x0F) << 8);
            else freq[ch] = (freq[ch] & 0x0F00) | value;
          } else if (off <= 0xAE) {
            volume[off - 0xAA] = value & 0x0F;
          } else if (off === 0xAF) {
            enable = value & 0x1F;
          }
          continue;
        }
        // classic: 0x00-0x7F=波形ch0-3(ch3はch4と共有) / 0x80-0x89=周波数 / 0x8A-0x8E=音量 / 0x8F=有効ビット
        if (off < 0x80) {
          const ch = off >> 5;
          wave[ch][off & 0x1F] = value;
          if (ch === 3) wave[4][off & 0x1F] = value;
          continue;
        }
        if (off > 0x8F) continue;
        if (off <= 0x89) {
          const ch = (off - 0x80) >> 1;
          if (off & 1) freq[ch] = (freq[ch] & 0x00FF) | ((value & 0x0F) << 8);
          else freq[ch] = (freq[ch] & 0x0F00) | value;
        } else if (off <= 0x8E) {
          volume[off - 0x8A] = value & 0x0F;
        } else if (off === 0x8F) {
          enable = value & 0x1F;
        }
      }
      // wave はチャンネルごとに独立コピーして返す(以降の書込みで上書きされないよう)
      return { freq: Array.from(freq), volume: Array.from(volume), enable, wave: wave.map(w => w.slice()) };
    });
  }

  // ピッチが同じ間は音色(波形)切替だけでは区切らないが、音量がそれまでの減衰傾向から
  // 上向きに跳ね上がった(=ソフトウェアエンベロープの再アタック)場合は同音連打として
  // 必ず新イベントに区切る(kss2mml/expansion/ay.jsと同じ考え方)。
  // 【周波数レジスタへの書込みを合図に加える案(freqTouched)は撤回】F1 Spirit 64曲目の
  // Tチャンネルで「音程が同じままの同音連打で周波数レジスタが書き直されない(値が
  // 変わらないので省略される)」曲があり、freqTouchedを必須にすると本来の再アタック
  // (音量が2から5へ跳ね上がる箇所)を見逃すことが判明した。音量が上向きに跳ね上がる
  // こと自体が再アタックの十分な合図になる。
  // それ以外の音量変化は同じ音符内のvolSeqへ積み、toCommon側でenvReg(渡されていれば)
  // により@v<n>ソフトウェアエンベロープへ畳み込む。
  // waveRegへの登録は実際に鳴っている(note!==null)イベントに絞ってtoCommon側で行う
  // (ここで毎フレーム登録すると、波形テーブル書換え中の過渡状態や無音区間の値まで
  //  無関係な音色として大量に登録されてしまうため)。
  function extractChannelEvents(timeline, ch, clock) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const period = t.freq[ch];
      const volume = t.volume[ch];
      const enabled = !!((t.enable >> ch) & 1);
      const freqHz = period > 8 ? clock / (32 * (period + 1)) : 0;
      const note = (enabled && volume > 0 && freqHz > 0) ? freqToNoteNumber(freqHz) : null;
      const wave = resampleWave(t.wave[ch]);
      const waveKey = wave.join(',');
      if (!cur) { cur = { note, wave, waveKey, freqHz: note !== null ? freqHz : null, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: false }; continue; }
      const retrigger = note !== null && volume > cur.volSeq[cur.volSeq.length - 1];
      if (retrigger || note !== cur.note || (note !== null && waveKey !== cur.waveKey)) {
        // 音量ジャンプ(再アタック推定)・波形切替が無く、純粋に音程だけが変わった場合は
        // スラー分割のタイ候補とする(ay.jsと同じ考え方)
        const pureNoteChange = !retrigger && note !== cur.note && waveKey === cur.waveKey;
        flush(f);
        cur = { note, wave, waveKey, freqHz: note !== null ? freqHz : null, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(volume);
        cur.pitchSeq.push(period);
      }
    }
    flush(timeline.length);
    return events;
  }

  // waveReg/envRegは省略可(MML変換時のみ渡される)。ピアノロール用タイムライン構築
  // (src/main.js buildKssRollTimeline)は音色番号/エンベロープを必要としないため渡してこない。
  // ここを無条件に waveReg.assign(...) していたため、SCCが実際に発音した瞬間だけ
  // TypeErrorで落ち、その例外がcaptureKssSongAsyncのonProgress経由でPromiseを
  // rejectさせ、ピアノロールの先読みが丸ごと死ぬ(=ロールが出ない/途中で止まる)
  // 不具合になっていた。ay.jsのenvRegと同じくnull許容にする。
  MML.Kss2MmlExpansion.scc = function (writeLog, totalFrames, clock, waveReg, envReg) {
    const timeline = buildTimeline(writeLog);
    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: volSeq[0] } : { envelopeV: idx };
    }
    // pitchEpは呼び出し元(kss2mml/converter.js)がev.freqSeqから借用先(N163)の
    // 生レジスタ空間へ変換して付与する(ay.jsと同じ理由、DESIGN-PITCH.md Phase 1)。
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      (ev.note !== null && waveReg) ? { instrument: waveReg.assign(ev.wave) } : {},
      ev.note !== null && ev.freqHz != null
        ? { rawFreq: ev.freqHz, freqSeq: ev.pitchSeq.map(p => p > 8 ? clock / (32 * (p + 1)) : 0) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      toVolumeFields(ev.volSeq)
    );
    const finalFrame = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    return {
      channels: [0, 1, 2, 3, 4].map(ch => ({
        // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)
        events: MML.Convert.mergeVibratoAndArpeggio(extractChannelEvents(timeline, ch, clock)).map(toCommon),
        hasVolume: true,
        hasEnvelope: true,
        hasInstrument: true
      })),
      n163Wave: finalFrame ? resampleWave(finalFrame.wave[0]) : new Array(OUT_WAVE_LEN).fill(0)
    };
  };
})(window);
