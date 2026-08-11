/*
 * NSF → MML コンバータ (2A03 内蔵音源のみ)
 * MML.NSF2MML.convert(writeLog, nsfBytes, header, songIndex)
 *   → { mml: string, dpcmFiles: [{name, bytes}], bpm: number }
 *
 * 出力 MML チャンネル:
 *   A = Pulse 1, B = Pulse 2, C = Triangle, D = Noise
 *   DMCは実機ppmckc準拠(音符バイト=dpcm_dataテーブルの行選択)で実演奏化する。
 *   (sampleAddr,sampleLen,rate,dac,loop)の組が同じトリガーをまとめて@DPCM<n>定義
 *   にし、E以降の専用チャンネル(dpcmは常に最優先でEを占める)で常に基準ノート
 *   (o4c)により@<n>を選び直す形で再現する(buildDpcmDefs/buildDpcmEvents参照)。
 *   抽出したサンプル本体は引き続きdpcmFilesとして.dmcバイナリでも返す。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};

  const FPS        = 60.0988;   // NTSC
  const CPU_CLOCK  = 1789773;

  // noteNumber 規約: MML コンパイラに合わせ o4a = 57 (MIDI-12)
  // ── ヘルパー ───────────────────────────────────────────────────

  function pulseFreq(period) {
    return period >= 8 ? CPU_CLOCK / (16 * (period + 1)) : 0;
  }
  function triFreq(period) {
    return period >= 4 ? CPU_CLOCK / (32 * (period + 1)) : 0;
  }
  // 長さカウンタテーブル(src/emulator/apu2a03.jsのLENGTH_TABLEと同一。三角波の$400B書込み
  // 上位5bitのインデックスで参照する)。
  const LENGTH_TABLE = [
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30
  ];
  // 三角波は音量レジスタを持たず、$4008(bit7=halt、bits0-6=線形カウンタリロード値)と
  // $400B書込み時の長さカウンタ(上記テーブル)の2つのハードウェアカウンタだけで発音の
  // オン/オフを制御する(apu2a03.js TriangleChannel参照)。haltビットが立っている間は
  // 両カウンタとも減少しない(継続音/レガート用)。haltが立っていない場合は「バスドラム的な
  // 短い一発」に使われることが多く、線形カウンタ(240Hz、1フレームに4回)と長さカウンタ
  // (120Hz、1フレームに2回)のどちらか早く0に達した方で自然に消音する。この消音は
  // レジスタ値そのものは変化しないため($4015のステータスビットも立ったまま)、
  // レジスタの値だけを見る抽出処理では検出できず、次の書込みまでずっと同じ音が
  // 連続音として鳴っているように見えてしまう(女神転生II 11曲目のバスドラム的三角波が
  // 連続トーンになる、とユーザー報告)。ここでこの自然減衰をシミュレートし、実際に
  // 音が止まるフレームで休符へ切り替える。
  function triangleAudibleFrames(haltFlag, linearReload, lengthCounterValue) {
    if (haltFlag) return Infinity; // 継続モード: 自然減衰しない(次のイベントまで鳴り続ける)
    const framesForLinear = Math.ceil((linearReload + 1) / 4); // 240Hz、リロードに1ティック分の余裕
    const framesForLength = Math.ceil(lengthCounterValue / 2); // 120Hz
    return Math.max(1, Math.min(framesForLinear, framesForLength));
  }
  // pulseFreq/triFreqの逆関数(丸めない生の連続値)。applyPitchDetune(src/convert/detune.js)は
  // 「理論値の周期」と「実測値の周期」の差を最後に1回だけ丸めてD<n>にするため、ここで先に
  // 整数化してはいけない(kss2mml-pitch-detune-correction参照)。実機の周期レジスタは整数
  // でしか書けないため、元のNSFが「12平均律を理論通りに丸めた値」と厳密には限らない
  // (ドライバ/ツール固有のピッチテーブル誤差、意図的なデチューン/コーラス等)場合、この
  // 差がそのまま失われてしまうのを防ぐ。
  function pulsePeriodRaw(freq) { return CPU_CLOCK / (16 * freq) - 1; }
  function triPeriodRaw(freq) { return CPU_CLOCK / (32 * freq) - 1; }
  // 拡張音源側(src/nsf2mml/expansion/*.js)の各周波数式の逆関数。同じ理由(コーラス検知時の
  // D<n>算出、src/convert/detune.js MML.Convert.detectChorusDetune)で丸めない生の連続値。
  function vrc6PulsePeriodRaw(freq) { return CPU_CLOCK / (16 * freq) - 1; } // vrc6.js pulseFreq()の逆関数
  function vrc6SawPeriodRaw(freq) { return CPU_CLOCK / (14 * freq) - 1; }   // vrc6.js sawFreq()の逆関数
  function fme7ToneRaw(freq) { return CPU_CLOCK / (32 * freq); }           // fme7.js toneFreq()の逆関数
  function fdsPeriodRaw(freq) { return freq * 65536 * 64 / CPU_CLOCK; }    // fds.js fdsFreq()の逆関数
  // vrc7.js vrc7Freq(fnum,block)の逆関数。kss2mml/converter.jsのvrc7FnumRawと同じ式で、
  // blockは自己選択(生fnum値なので同一block内なら周波数に比例、ズレは小さいため常に
  // block自体は揺れない前提で問題ない)。
  function vrc7FnumRaw(freq) {
    for (let block = 0; block <= 7; block++) {
      const fnum = (freq * 524288) / (49716 * Math.pow(2, block));
      if (fnum <= 511) return fnum;
    }
    return 511;
  }
  // n163.js freq=freqReg*CLOCK/(15*65536*length*numCh)の逆関数。
  // ★lengthは必ず「そのノートが実際にコンパイル時に使う波形長」と一致させること
  // (D<n>算出時のlengthと適用時のlengthが食い違うと、女神転生II 11曲目で実測した通り
  // オフセットが丸ごと倍/半分になり音痴に聞こえるバグになる)。以前はnsf2mml/expansion/
  // n163.jsの波形抽出が常に16サンプルへリサンプリングしていたためlengthを16固定にして
  // いたが、その後「波形は実機の生の長さのまま抽出する」よう修正した(女神転生II 20曲目、
  // 実機32サンプルの波形が16に間引かれ音色の解像度が失われる別バグの修正、
  // n163.jsのreadNativeWave参照)ため、ここでもev.rawLength(=そのノートの実際の
  // 波形サンプル数、n163.jsのtoCommonがev.wave.lengthから渡す)をそのまま使う
  // (roundedLenは実機レジスタの丸め規則そのものなので既に丸め済み、再度丸め直す必要はない)。
  // numCh(有効ch数)は曲全体で不変という前提のもと、抽出側の実測値(ev.rawNumCh)をそのまま使う。
  function n163FreqRegRaw(freq, ev) {
    const length = (ev && ev.rawLength) || 16;
    const numCh = (ev && ev.rawNumCh) || 8;
    return freq * 15 * 65536 * length * numCh / CPU_CLOCK;
  }
  // チップ種別+チャンネルindexから対応する生周期関数を返す(result.channelsの並び順:
  // vrc6=[p1,p2,saw], mmc5=[p1,p2], fme7=[A,B,C], n163=[ch0..], vrc7=[ch0..ch5], fds=[単一])。
  function expansionPeriodFn(chip, index) {
    switch (chip) {
      case 'vrc6': return index === 2 ? vrc6SawPeriodRaw : vrc6PulsePeriodRaw;
      case 'mmc5': return pulsePeriodRaw;
      case 'fme7': return fme7ToneRaw;
      case 'n163': return n163FreqRegRaw;
      case 'vrc7': return vrc7FnumRaw;
      case 'fds':  return fdsPeriodRaw;
      default: return null;
    }
  }
  // 周波数 → MML noteNumber (o4a=57)
  function freqToNote(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }
  // ノイズ periodIdx (0-15) → MML noteNumber
  // noisePeriodIndex(noteNumber) = 15 - (noteNumber % 16)
  // → noteNumber = 15 - periodIdx  (+16 でオクターブ調整)
  function noisePeriodToNoteNum(periodIdx) {
    return (31 - periodIdx); // o2 g 〜 o1 e の範囲
  }

  // ── タイムライン構築 ──────────────────────────────────────────
  // writeLog (フレームごとの書き込み配列) → フレーム毎状態配列

  function buildTimeline(writeLog, initRegs) {
    // INITルーチン後の初期レジスタ状態から開始（省略時はデフォルト値）
    const ir = initRegs || {};
    function irByte(addr, def) { return (ir[addr] !== undefined) ? ir[addr] : def; }
    const r = {
      p1: [irByte(0x4000,0), irByte(0x4001,0), irByte(0x4002,0), irByte(0x4003,0)],
      p2: [irByte(0x4004,0), irByte(0x4005,0), irByte(0x4006,0), irByte(0x4007,0)],
      tr: [irByte(0x4008,0), irByte(0x4009,0), irByte(0x400A,0), irByte(0x400B,0)],
      no: [irByte(0x400C,0), irByte(0x400D,0), irByte(0x400E,0), irByte(0x400F,0)],
      dm: [irByte(0x4010,0), irByte(0x4011,0), irByte(0x4012,0), irByte(0x4013,0)],
      status: irByte(0x4015, 0)
    };
    // チャンネルごとの「アタック」フラグ（r3/r7 への書き込み）
    const attack = { p1:false, p2:false, tr:false, no:false };

    return writeLog.map(writes => {
      for (const k in attack) attack[k] = false;

      for (const { addr, value } of writes) {
        if      (addr >= 0x4000 && addr <= 0x4003) { r.p1[addr & 3] = value; if ((addr&3)===3) attack.p1=true; }
        else if (addr >= 0x4004 && addr <= 0x4007) { r.p2[addr & 3] = value; if ((addr&3)===3) attack.p2=true; }
        else if (addr >= 0x4008 && addr <= 0x400B) { r.tr[addr & 3] = value; if ((addr&3)===3) attack.tr=true; }
        else if (addr >= 0x400C && addr <= 0x400F) { r.no[addr & 3] = value; if ((addr&3)===2||(addr&3)===3) attack.no=true; }
        else if (addr >= 0x4010 && addr <= 0x4013) { r.dm[addr & 3] = value; }
        else if (addr === 0x4015) r.status = value;
      }
      return {
        p1:[...r.p1], p2:[...r.p2], tr:[...r.tr],
        no:[...r.no], dm:[...r.dm],
        status: r.status,
        attack: { ...attack }
      };
    });
  }

  // ── イベント抽出 ──────────────────────────────────────────────

  // パルスチャンネル (p1/p2): [{note, vol, duty, constVol, envKey, start, end, volSeq, pitchSeq}]
  // volSeq はセグメント内フレーム毎の生音量値の列(固定音量モード時のソフトウェア音量
  // エンベロープ抽出用)。envKey はエンベロープモード時の周期(bits0-3)+ループフラグ
  // (bit5)で、ハードウェア減衰エンベロープの再現に使う(nsf2mml/converter.js側で
  // MML.Convert.simulateHwEnvelope に渡す)。
  // ピッチ/duty/固定音量モードが同じ間は音量変化だけでは区切らず、volSeqに積む。
  // ただしエンベロープモード中にenvKey(周期/ループ)が変わった場合は別ノートとして
  // 区切る(このツールはノート単位でしか減衰カーブを表現できないため)。
  // pitchSeq はセグメント内フレーム毎の生周期レジスタ値の列(DESIGN-PITCH.md Phase 0。
  // volSeqのconstVol gateとは独立に、セグメントが続く全フレームで無条件に積む)。
  function extractPulseEvents(timeline, chKey, statusBit) {
    const events = [];
    let cur = null;

    function flush(end) {
      if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; }
    }
    function begin(f, note, vol, duty, constVol, envKey, rawFreq, period) {
      cur = { note, vol, duty, constVol, envKey, start: f, end: f, volSeq: [vol], pitchSeq: [period], rawFreq };
    }

    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const r = t[chKey];
      const active = !!(t.status & statusBit);
      const period = r[2] | ((r[3] & 7) << 8);
      const constVol = !!(r[0] & 0x10); // bit4=1: 固定音量, bit4=0: エンベロープモード
      const rawVol  = r[0] & 0xF;
      const envKey  = r[0] & 0x2F; // bits0-3=エンベロープ周期, bit5=ループフラグ
      // エンベロープモード時は bits3-0 はエンベロープ周期であり音量ではない
      // (実際の減衰値は toVolumeFields 側で simulateHwEnvelope により再現する)。
      // エンベロープは0x4003書き込み時に15から開始するため、有音として扱う。
      const vol     = constVol ? rawVol : 15;
      const audible = constVol ? rawVol > 0 : true; // エンベロープモードは常に有音
      const duty = (r[0] >> 6) & 3;
      const freq = pulseFreq(period);
      const note = (active && audible && freq > 0) ? freqToNote(freq) : null;
      const rawFreq = note !== null ? freq : null;

      if (!cur) {
        begin(f, note, vol, duty, constVol, envKey, rawFreq, period);
        continue;
      }
      // アタック書き込みがあれば必ず新イベント
      if (t.attack[chKey]) {
        flush(f); begin(f, note, vol, duty, constVol, envKey, rawFreq, period);
      } else if (note !== cur.note || duty !== cur.duty || constVol !== cur.constVol ||
                 (!constVol && envKey !== cur.envKey)) {
        flush(f); begin(f, note, vol, duty, constVol, envKey, rawFreq, period);
      } else {
        cur.pitchSeq.push(period);
        if (constVol) {
          // 固定音量モードのまま音量だけ変化する場合はソフトウェアエンベロープの
          // 一部として同一ノートに積む(区切らない)。
          cur.vol = vol;
          cur.volSeq.push(vol);
        }
      }
    }
    flush(timeline.length);
    return events;
  }

  // 三角波: [{note, start, end}]
  function extractTriEvents(timeline) {
    const events = [];
    let cur = null;
    let silenceAtFrame = Infinity; // このフレーム以降は線形/長さカウンタで自然消音済み(休符扱い)

    function flush(end) {
      if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; }
    }

    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const r = t.tr;
      const active = !!(t.status & 4);
      const period = r[2] | ((r[3] & 7) << 8);
      const freq = triFreq(period);

      // halt=1(継続モード)は実機仕様上reload flagが永久にセットされたままになるため、線形
      // カウンタは毎四分フレーム$4008下位7bitをそのままライブ反映し続ける($400Bを介した
      // アタックが無くても、$4008単体の書込みだけでreload=0にすれば即座に消音できる。
      // 女神転生II 11曲目のバスドラム的三角波は$400Bでなくこの手法(常時halt=1固定+
      // $4008=$80(reload=0)による都度ミュート)を使っていた)。halt=0(単発減衰)モードは
      // 従来通りアタック起点の時間経過でシミュレートする。
      const haltFlagNow = !!(r[0] & 0x80);
      const linearReloadNow = r[0] & 0x7F;
      if (t.attack.tr && !haltFlagNow) {
        const lengthCounterValue = LENGTH_TABLE[(r[3] >> 3) & 0x1F];
        silenceAtFrame = f + triangleAudibleFrames(haltFlagNow, linearReloadNow, lengthCounterValue);
      }
      const gated = haltFlagNow ? (linearReloadNow > 0) : (f < silenceAtFrame);
      const note = (active && freq > 0 && gated) ? freqToNote(freq) : null;
      const rawFreq = note !== null ? freq : null;

      if (!cur) { cur = { note, start: f, end: f, rawFreq, pitchSeq: [period] }; continue; }

      if (t.attack.tr) {
        flush(f); cur = { note, start: f, end: f, rawFreq, pitchSeq: [period] };
      } else if (note !== cur.note) {
        flush(f); cur = { note, start: f, end: f, rawFreq, pitchSeq: [period] };
      } else {
        cur.pitchSeq.push(period);
      }
    }
    if (cur) { cur.end = timeline.length; if (cur.end > cur.start) events.push(cur); }
    return events;
  }

  // ノイズ: [{periodIdx, mode, vol, on, constVol, envKey, start, end, volSeq}]
  // パルスチャンネルと同様、$400Cはbit4=固定音量/bit4=0でエンベロープモード(bits0-3=周期,
  // bit5=ループ)という同じレイアウトなので、パルスと同じ考え方でconstVol/envKeyを見る。
  // 周期/モード/on-offが同じ間は音量変化だけでは区切らずvolSeq(フレーム毎の生音量値)に積み、
  // エンベロープモード中にenvKeyが変わった場合のみ別ノートとして区切る。
  function extractNoiseEvents(timeline) {
    const events = [];
    let cur = null;

    function flush(end) {
      if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; }
    }

    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const r = t.no;
      const active = !!(t.status & 8);
      const periodIdx = r[2] & 0xF;
      const mode = (r[2] & 0x80) ? 1 : 0; // 1=short(metal), 0=long(normal)
      const constVol = !!(r[0] & 0x10);
      const rawVol = r[0] & 0xF;
      const envKey = r[0] & 0x2F;
      const vol = constVol ? rawVol : 15; // 実際の減衰値はtoVolumeFields側でsimulateHwEnvelope
      const on = active && (constVol ? rawVol > 0 : true);

      if (!cur) { cur = { periodIdx, mode, vol, on, constVol, envKey, start: f, end: f, volSeq: [vol] }; continue; }

      if (t.attack.no) {
        flush(f); cur = { periodIdx, mode, vol, on, constVol, envKey, start: f, end: f, volSeq: [vol] };
      } else if (periodIdx !== cur.periodIdx || mode !== cur.mode || on !== cur.on ||
                 constVol !== cur.constVol || (!constVol && envKey !== cur.envKey)) {
        flush(f); cur = { periodIdx, mode, vol, on, constVol, envKey, start: f, end: f, volSeq: [vol] };
      } else if (constVol) {
        cur.vol = vol;
        cur.volSeq.push(vol);
      }
    }
    if (cur) { cur.end = timeline.length; if (cur.end > cur.start) events.push(cur); }
    return events;
  }

  // DMC サンプルトリガ抽出: [{rate, addr, len, start, bankState}]
  // rate($4010下位4bit)・loop($4010 bit6)・dac($4011、トリガー時点の値)を
  // すべてtimeline(累積レジスタ状態)からそのまま読む。timelineは書込みが無い
  // フレームも直前の値を保持し続けるため、「このトリガーの直前に$4011が
  // 明示的に書かれたか」を別途追跡する必要はなく、実機が実際に持っていた
  // レジスタ値をそのまま忠実に再現できる(ppmckcのdpcm_dataテーブル1行分に相当)。
  // bankState: トリガー時点で$8000-$FFFFの8つの4KB窓に実際にマップされていた
  // バンク番号(src/emulator/nsfBus.jsの$5FF8-$5FFF書き込みをそのまま追跡)。
  // バンクスイッチ非使用のNSFではheader.bankswitchが無い/全0なので常に全0のまま。
  function extractDmcTriggers(timeline, writeLog, header) {
    const triggers = [];
    let lastAddr = 0, lastLen = 0;
    const bankState = (header && header.bankswitch) ? header.bankswitch.slice() : [0, 0, 0, 0, 0, 0, 0, 0];

    for (let f = 0; f < writeLog.length; f++) {
      for (const { addr, value } of writeLog[f]) {
        if (addr === 0x4012) lastAddr = value;
        if (addr === 0x4013) lastLen  = value;
        if (addr >= 0x5FF8 && addr <= 0x5FFF) bankState[addr - 0x5FF8] = value;
        if (addr === 0x4015 && (value & 0x10)) {
          const dm = timeline[f]?.dm || [0, 0, 0, 0];
          triggers.push({
            start: f,
            rate: dm[0] & 0xF,
            loop: !!(dm[0] & 0x40),
            dac: dm[1] & 0x7F,
            sampleAddr: 0xC000 + lastAddr * 64,
            sampleLen:  lastLen  * 16 + 1,
            bankState: bankState.slice()
          });
        }
      }
    }
    return triggers;
  }

  // バンクスイッチ解決に必要な情報をまとめる。src/emulator/nsfBus.jsのNsfBus
  // コンストラクタと全く同じロジック(パディング・バンク数計算)で作る必要がある
  // (でないとINIT/PLAYと同じ理由でズレる。nsf-bankswitch-padding参照)。
  function computeBankInfo(nsfBytes, header) {
    const loadAddr = (header && header.loadAddr) || 0x8000;
    const program = nsfBytes ? nsfBytes.slice(128) : new Uint8Array(0); // ヘッダ除去
    const useBankswitch = (header.bankswitch || []).some(b => b !== 0);
    if (!useBankswitch) return { useBankswitch: false, program, loadAddr };
    const pad = loadAddr & 0x0FFF;
    const romImage = new Uint8Array(pad + program.length);
    romImage.set(program, pad);
    const bankCount = Math.max(1, Math.ceil(romImage.length / 0x1000));
    return { useBankswitch: true, romImage, bankCount, loadAddr };
  }

  // トリガーの実サンプルバイト列を実際に解決する。バンクスイッチ時は
  // 「CPUアドレスの上位桁=バンク番号」という誤った前提(旧実装のバグ)を使わず、
  // トリガー時点でその4KB窓に実際にマップされていたバンク番号(bankState)を使う。
  // サンプルが4KB境界を跨いでバンクをまたぐ場合にも1バイトずつ正しく解決する。
  function resolveDmcBytes(bankInfo, bankState, sampleAddr, sampleLen) {
    if (!bankInfo.useBankswitch) {
      const offset = sampleAddr - bankInfo.loadAddr;
      if (offset < 0 || offset + sampleLen > bankInfo.program.length) return null;
      return bankInfo.program.slice(offset, offset + sampleLen);
    }
    const bytes = new Uint8Array(sampleLen);
    for (let i = 0; i < sampleLen; i++) {
      const addr = (sampleAddr + i) & 0xFFFF;
      if (addr < 0x8000) { bytes[i] = 0; continue; }
      const slot = (addr - 0x8000) >> 12;
      if (slot > 7) { bytes[i] = 0; continue; }
      const bankIndex = (bankState ? bankState[slot] : 0) % bankInfo.bankCount;
      const romOffset = bankIndex * 0x1000 + (addr & 0x0FFF);
      bytes[i] = romOffset < bankInfo.romImage.length ? bankInfo.romImage[romOffset] : 0;
    }
    return bytes;
  }

  // トリガーがどの実サンプルを指すかの識別キー。バンクスイッチ時は同じ
  // (sampleAddr,sampleLen)でも実際に鳴る中身がバンク次第で変わりうるため、
  // 開始バンク番号もキーに含めて別サンプル扱いにする(実測でMetal Max等の
  // 商用NSFで実際に必要だったことを確認済み)。
  function dmcTriggerFileKey(trig, bankInfo) {
    if (!bankInfo.useBankswitch) return `${trig.sampleAddr}:${trig.sampleLen}`;
    const slot = (trig.sampleAddr - 0x8000) >> 12;
    const bankState = trig.bankState || [0, 0, 0, 0, 0, 0, 0, 0];
    const bankIndex = (slot >= 0 && slot <= 7) ? (bankState[slot] % bankInfo.bankCount) : 0;
    return `${bankIndex}:${trig.sampleAddr}:${trig.sampleLen}`;
  }

  // NSF バイナリから DPCM サンプルを抽出
  function extractDpcmFiles(triggers, bankInfo) {
    const seen = new Map(); // fileKey → filename
    const files = [];

    for (const trig of triggers) {
      const key = dmcTriggerFileKey(trig, bankInfo);
      if (seen.has(key)) continue;

      const bytes = resolveDmcBytes(bankInfo, trig.bankState, trig.sampleAddr, trig.sampleLen);
      if (!bytes) continue;

      const name = `dpcm_${files.length}.dmc`;
      seen.set(key, name);
      files.push({ name, bytes, sampleAddr: trig.sampleAddr, sampleLen: trig.sampleLen, fileKey: key });
    }
    return files;
  }

  // ppmckcの実装(nes_include/ppmck/dpcm.h)は「音符バイト=dpcm_dataテーブルの
  // 行インデックス」で、各行が[$4010制御(レート+ループ),$4011初期DAC,$4012アドレス,
  // $4013長さ]を丸ごと持つ(音高からレートを動的計算する仕組みは実機には無い)。
  // これに忠実にするため、(sampleAddr,sampleLen,rate,dac,loop)の組が同じトリガーを
  // 1つの@DPCM<n>定義にまとめ、Eチャンネルの音符は常に基準ノート(o4c=noteNumber48)
  // で@<n>を選び直すだけにする。compiler.jsのdpcmRateIndexForNoteは基準ノートでは
  // 必ず定義そのもののfreqを返す(量子化誤差ゼロ)ため、既存の音高quantizeロジックを
  // 一切変更せずに実機同等の「行選択」方式を再現できる。
  function buildDpcmDefs(triggers, dpcmFiles, bankInfo) {
    const fileByKey = new Map();
    for (const f of dpcmFiles) fileByKey.set(f.fileKey, f.name);

    const comboIndexByKey = new Map();
    const defs = [];
    for (const trig of triggers) {
      const fileKey = dmcTriggerFileKey(trig, bankInfo);
      const file = fileByKey.get(fileKey);
      if (!file) continue; // ROM範囲外等でサンプル抽出できなかったトリガーは無視(休符化)

      const comboKey = `${fileKey}:${trig.rate}:${trig.dac}:${trig.loop ? 1 : 0}`;
      if (comboIndexByKey.has(comboKey)) continue;
      comboIndexByKey.set(comboKey, defs.length);
      defs.push({
        index: defs.length, file,
        freq: trig.rate, size: trig.sampleLen, dac: trig.dac, mode: trig.loop ? 1 : 0
      });
    }
    return { defs, comboIndexByKey };
  }

  function buildDpcmEvents(triggers, comboIndexByKey, totalFrames, bankInfo) {
    const events = [];
    for (let i = 0; i < triggers.length; i++) {
      const trig = triggers[i];
      const fileKey = dmcTriggerFileKey(trig, bankInfo);
      const comboKey = `${fileKey}:${trig.rate}:${trig.dac}:${trig.loop ? 1 : 0}`;
      const instrument = comboIndexByKey.get(comboKey);
      if (instrument === undefined) continue;
      const end = i + 1 < triggers.length ? triggers[i + 1].start : totalFrames;
      if (end <= trig.start) continue;
      events.push({ start: trig.start, end, note: 48, instrument });
    }
    return events;
  }

  // ── メインエントリ ────────────────────────────────────────────
  // BPM検出・音長量子化・チャンネルMML生成は共通モジュール
  // (src/convert/bpm.js, duration.js, mmlEmit.js) に切り出し済み。

  MML.NSF2MML = {};

  MML.NSF2MML.convert = function (writeLog, nsfBytes, header, songIndex, initRegs, initWrites, options) {
    options = options || {};
    const timeline = buildTimeline(writeLog, initRegs);

    // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2): 半音境界を跨ぐビブラートが
    // 音符連打に化ける問題を、抽出後の後処理パスとして統合する(ノイズ(evD)は
    // 音程=周期インデックスの離散値でビブラートの概念が無いため対象外)。
    const evA = MML.Convert.mergeAlternatingVibrato(extractPulseEvents(timeline, 'p1', 1));
    const evB = MML.Convert.mergeAlternatingVibrato(extractPulseEvents(timeline, 'p2', 2));
    const evC = MML.Convert.mergeAlternatingVibrato(extractTriEvents(timeline));
    const evD = extractNoiseEvents(timeline);
    const dmcTriggers = extractDmcTriggers(timeline, writeLog, header);
    const bankInfo    = computeBankInfo(nsfBytes, header || {});
    const dpcmFiles   = extractDpcmFiles(dmcTriggers, bankInfo);

    // テンポ推定: 全有音イベントの音長 + チャンネル毎の発音開始間隔(IOI)から。
    // IOIはゲートタイム(音符を短く切る発音)の影響を受けないため音長より頑健。
    const timingChannels = [
      evA.filter(e => e.note !== null),
      evB.filter(e => e.note !== null),
      evC.filter(e => e.note !== null),
      evD.filter(e => e.on),
    ];
    const noteDurations = [];
    for (const chEvents of timingChannels) {
      for (const e of chEvents) noteDurations.push(e.end - e.start);
      noteDurations.push(...MML.Convert.onsetIntervals(chEvents.map(e => e.start)));
    }

    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, FPS)
      : MML.Convert.detectBpm(noteDurations, FPS);
    // MML本文に埋め込まれるテンポは整数(t<n>)に丸められる(mmlEmit.js)。音長量子化の
    // グリッド(fpb)も同じ丸め後の値で計算しないと、書き出し時と再生(コンパイル)時で
    // 基準テンポが食い違い、打ち直しの多いパートで誤差が蓄積してドリフトする
    // ([[tempo-rounding-drift-future-issue]]参照)。
    const fpb = FPS * 60 / Math.round(bpm);
    const totalFrames = timeline.length;

    // DPCM: ppmckc準拠(音符=テーブル行選択)で@DPCM<n>定義+実際のノートイベントを作る
    const { defs: dpcmDefs, comboIndexByKey: dpcmComboIndex } = buildDpcmDefs(dmcTriggers, dpcmFiles, bankInfo);
    const dpcmEvents = buildDpcmEvents(dmcTriggers, dpcmComboIndex, totalFrames, bankInfo);

    // 拡張音源(複数同時使用可)を header.extraChips から全て検出する。
    // 順序はsrc/mml/compiler.jsのEXPANSION_PRIORITY(実機ppmck固定優先順位)に合わせる
    // (NSFのextraChipsにdpcmビットは無いためfilterで自然に除外される)。
    const extraChips = (header && header.extraChips) || 0;
    const expansions = MML.Mml.EXPANSION_PRIORITY.filter(name => {
      const flag = MML.NSF.CHIP_FLAGS[name.toUpperCase()];
      return flag && (extraChips & flag);
    });

    // コメントヘッダ
    const title = (header && header.songName)  ? header.songName  : 'Unknown';
    const artist = (header && header.artist)   ? header.artist    : '';
    const copy   = (header && header.copyright)? header.copyright : '';
    const songNo = (songIndex != null) ? songIndex + 1 : '?';
    const totalS = (header && header.totalSongs) ? header.totalSongs : '?';

    // DPCMが1件でもあれば'dpcm'を最優先枠として文字割当に混ぜる(実機ppmck同様、
    // 他拡張音源が使われていてもE以降の文字はdpcm→fds→vrc7→...の固定優先順で
    // 詰めて割り当てられ、DPCMは常にE)。src/mml/compiler.jsのEXPANSION_PRIORITYと
    // 同じ規則をここでも再現し、MML本文をコンパイルした時と同じ文字になるようにする。
    const letterExpansions = dpcmDefs.length > 0 ? ['dpcm', ...expansions] : expansions;
    const expansionLetterMap = MML.Mml.assignExpansionLetters(letterExpansions);
    const dpcmLetter = dpcmDefs.length > 0 ? expansionLetterMap.dpcm[0] : null;

    const headerComment = [
      `; =========================================================`,
      `; NSF → MML 変換 (2A03 内蔵音源)`,
      `; Title    : ${title}`,
      `; Artist   : ${artist}`,
      `; Copyright: ${copy}`,
      `; Song     : ${songNo} / ${totalS}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      `; チャンネル: A=Pulse1 B=Pulse2 C=Triangle D=Noise` + (dpcmLetter ? ` ${dpcmLetter}=DPCM` : ''),
      ...(expansions.length > 0 ? [`; 拡張音源  : ${expansions.join(', ')}`] : []),
      `; =========================================================`,
      `; ※ 自動変換のため手動での調整が必要な場合があります。`,
      `; ※ ノイズ周期はピッチ値でエンコードされています (o2g=period0(高) 〜 o1e=period15(低))。`,
      ...(dpcmDefs.length > 0 ? [
        `; ※ DPCMは抽出済み.dmcファイルを「MML作曲」パネルのDPCMサンプル欄で選択する`,
        `;   か、そのまま再コンパイルすると自動でキャッシュされたバイト列が使われます。`
      ] : []),
      `; =========================================================`,
      ``
    ].join('\n');

    // 音量変化を曲全体で共有登録するレジストリ。固定音量モード(constVol)でvolSeqが
    // 全フレーム同一値(フラット)ならvolumeを、変化があれば実測形状のenvelopeV(0番台)を、
    // エンベロープモード(!constVol)ならハードウェア減衰カーブを厳密シミュレートした
    // envelopeV(100番台、HARDWARE_INDEX_BASE)を使う。休符(note===null)には音量は不要。
    const envReg = new MML.Convert.EnvelopeRegistry();
    function toVolumeFields(ev) {
      if (!ev.constVol) {
        const period = ev.envKey & 0x0F;
        const loop = !!(ev.envKey & 0x20);
        const shape = MML.Convert.simulateHwEnvelope(period, loop);
        const idx = envReg.registerShape(shape, true);
        return { envelopeV: idx };
      }
      const idx = envReg.assign(ev.volSeq);
      return idx == null ? { volume: ev.volSeq[0] } : { envelopeV: idx };
    }

    // ピッチエンベロープ(厳密周期ビブラート)を曲全体で共有登録するレジストリ
    // (DESIGN-PITCH.md Phase 1)。基準点はev.rawFreqと同じ生成元(ev.pitchSeq[0])
    // なのでD<n>(detectChorusDetuneが後段で設定)とcompiler.js側で正しく合成される。
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry();
    function toPitchFields(ev) {
      if (ev.rawFreq == null || !ev.pitchSeq) return {};
      const assigned = pitchReg.assign(ev.pitchSeq);
      return assigned ? { pitchEp: assigned.index, pitchEpDelay: assigned.delay } : {};
    }

    // イベントを共通形式 { start, end, note, volume?/envelopeV?, instrument?, rawFreq? } に整形
    const toCommon = (ev) => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, instrument: ev.duty, rawFreq: ev.rawFreq },
      ev.note !== null ? toVolumeFields(ev) : {},
      ev.note !== null ? toPitchFields(ev) : {}
    );
    const chEventsA = evA.map(toCommon);
    const chEventsB = evB.map(toCommon);
    const chEventsC = evC.map(ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, rawFreq: ev.rawFreq },
      ev.note !== null ? toPitchFields(ev) : {}
    ));
    const chEventsD = evD.map(ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.on ? noisePeriodToNoteNum(ev.periodIdx) : null },
      ev.on ? toVolumeFields(ev) : {}
    ));

    // 音程補正: NSF→2A03(及び拡張音源)はネイティブ変換(変換元・変換先が同一チップ・同一
    // クロック)であり、KSSのPSG→FME-7のような「変換先チップの格子が粗い」二重量子化は
    // 起こらない。よって単独ノートの実測誤差はほぼノイズであり補正すべきではなく、複数
    // チャンネルが同じ音程を同時に鳴らしている(コーラス)場合に限って実測周波数の違いを
    // 意図的なデチューン効果とみなして補正する MML.Convert.detectChorusDetune を使う
    // (applyPitchDetuneではない、kss2mml-pitch-detune-correction参照)。2A03本体だけでなく
    // 拡張音源(VRC6等)を含めた全チャンネルを横断してグループ化することで、チップをまたいだ
    // コーラス(例: 2A03パルス+VRC6パルスの同時発音)も検知できるようにする。そのため実際の
    // 呼び出しは拡張音源抽出後(下記detuneEntries)にまとめて1回だけ行う。ノイズ(D)は
    // periodIdxが元々16通りの離散値でしか存在せず補正の余地が無いため対象外。
    const detuneEntries = [
      { events: chEventsA, periodFn: pulsePeriodRaw },
      { events: chEventsB, periodFn: pulsePeriodRaw },
      { events: chEventsC, periodFn: triPeriodRaw },
    ];

    // 各チップの抽出モジュール(src/nsf2mml/expansion/*.js)を呼んでチャンネルを追加する。
    // 全チャンネルを小節揃えスコア形式(1回のemitScore呼び出し)で出力する。
    // テンポは先頭に "ABCD... t<bpm>" の形で1回だけ出す。
    const scoreChannels = [
      { letter: 'A', events: chEventsA, hasInstrument: true, hasVolume: true, hasEnvelope: true, hasDetune: true, hasPitchMod: true },
      { letter: 'B', events: chEventsB, hasInstrument: true, hasVolume: true, hasEnvelope: true, hasDetune: true, hasPitchMod: true },
      { letter: 'C', events: chEventsC, hasDetune: true, hasPitchMod: true },
      { letter: 'D', events: chEventsD, hasVolume: true, hasEnvelope: true },
      ...(dpcmLetter ? [{ letter: dpcmLetter, events: dpcmEvents, hasInstrument: true }] : []),
    ];

    // FDS/N163の自作波形も曲全体で共有登録するレジストリ(@FM<n>/@N<n>としてMML本文の
    // ヘッダに埋め込む。それぞれ定義書式が異なる別レジストリが必要)。
    const fdsWaveReg = new MML.Convert.WaveRegistry('@FM');
    const n163WaveReg = new MML.Convert.WaveRegistry('@N', v => [0, ...v]);
    // VRC7カスタム音色(ユーザー定義音色, レジスタ$00-$07)。全ch共有の1系統のみで、
    // @OP<n>定義+曲中の切替はOP<n>即時コマンド(mmlEmit.jsのhasVrc7Tone)で表現する
    const vrc7ToneReg = new MML.Convert.WaveRegistry('@OP');

    // 各抽出モジュールは単独使用を前提にE以降のレターを内部で仮に振っているため、
    // src/mml/compiler.js の assignExpansionLetters をそのまま再利用してレターを
    // 振り直す。実機ppmck同様、各チップの文字範囲は他の拡張音源の有無に関わらず
    // 完全固定(例: VRC6のみでも常にM-O。E-Lは未使用のまま空く。詰め直しはしない)。
    // (expansionLetterMapはヘッダーコメント生成時にdpcmを含めて計算済みのものを再利用する)
    let fdsWave = null, n163Wave = null, fdsModDefLines = [], n163ChannelCount = 0;
    for (const chip of expansions) {
      const extractor = MML.Nsf2MmlExpansion && MML.Nsf2MmlExpansion[chip];
      if (!extractor) continue;
      const result = extractor(writeLog, totalFrames, envReg,
        chip === 'fds' ? fdsWaveReg : chip === 'n163' ? n163WaveReg : chip === 'vrc7' ? vrc7ToneReg : undefined,
        initRegs, initWrites, options.n163Snapshots, pitchReg);
      const letters = expansionLetterMap[chip];
      const hasPitchModForChip = chip !== 'vrc7'; // VRC7はfnum/block対数空間でD/EP/MP非対応(DESIGN-PITCH.md §7)
      result.channels.forEach((ch, index) => {
        scoreChannels.push(Object.assign({}, ch, { letter: letters[index], hasDetune: true, hasPitchMod: hasPitchModForChip }));
        detuneEntries.push({ events: ch.events, periodFn: expansionPeriodFn(chip, index) });
      });
      if (result.fdsWave)  fdsWave  = result.fdsWave;
      if (result.n163Wave) n163Wave = result.n163Wave;
      if (result.fdsModDefLines) fdsModDefLines = result.fdsModDefLines;
      if (chip === 'n163') n163ChannelCount = result.channels.length;
    }

    // 2A03本体+全拡張音源を横断してコーラス検知+D<n>補正(上のdetuneEntries参照)
    MML.Convert.detectChorusDetune(detuneEntries, detuneEntries.map(e => e.periodFn));

    // @DPCM<n>定義行(実機ppmckcと同じ書式)。ヘッダー行として他の音色定義と同列に出す
    const dpcmDefLines = dpcmDefs.map(d =>
      `@DPCM${d.index} = { "${d.file}", ${d.freq}, ${d.size}, ${d.dac}, ${d.mode} }`);

    // #TITLE/#COMPOSER/#MAKER/#EX-*(機能する本文ディレクティブ。上の`; `コメントとは別。
    // これがないとMML本文だけからは拡張音源が有効にならず、UI側の操作が必要になってしまう)
    const directiveLines = [
      ...(title ? [`#TITLE ${title}`] : []),
      ...(artist ? [`#COMPOSER ${artist}`] : []),
      ...(copy ? [`#MAKER ${copy}`] : []),
      ...expansions.map(chip => chip === 'n163'
        ? `${MML.Mml.EX_CHIP_DIRECTIVE[chip]} ${n163ChannelCount}`
        : MML.Mml.EX_CHIP_DIRECTIVE[chip]),
      ``
    ];

    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm,
      headerLines: [...directiveLines, ...dpcmDefLines, ...envReg.defLines(), ...pitchReg.defLines(),
        ...fdsWaveReg.defLines(), ...n163WaveReg.defLines(), ...vrc7ToneReg.defLines(), ...fdsModDefLines]
    });

    const mml = [headerComment, scoreText].join('\n');

    return { mml, dpcmFiles, bpm: Math.round(bpm), expansions, fdsWave, n163Wave };
  };

})(window);
