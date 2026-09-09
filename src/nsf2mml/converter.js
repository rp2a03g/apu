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
  // 長さカウンタ(120Hz=1フレームに2回減少)が0になるまでのフレーム数。halt($4000/$400C
  // bit5、エンベロープのループフラグと共用)が立っている間は減少しないので継続音になる。
  // 上の三角波と全く同じ話がパルス/ノイズにもあり、そちらは長さカウンタだけで決まる
  // (FamicomBox「Game Select」のノイズは長さカウンタ2/10=1フレーム/5フレームだけ鳴る
  // 打楽器的な使い方をしており、これを見ないと次の書込みまで鳴りっぱなしになる)。
  function lengthAudibleFrames(lengthCounterValue) {
    return Math.max(1, Math.ceil(lengthCounterValue / 2));
  }
  // スイープユニット(実機/src/emulator/apu2a03.js PulseChannel、src/audio/mml-worklet.js)。
  // negate時のパルス1は1の補数(さらに-1)、パルス2は2の補数。
  function sweepTargetPeriod(period, sweepReg, isPulse1) {
    const change = period >> (sweepReg & 7);
    return (sweepReg & 8) ? period - change - (isPulse1 ? 1 : 0) : period + change;
  }
  function sweepMutes(period, sweepReg, isPulse1) {
    return period < 8 || sweepTargetPeriod(period, sweepReg, isPulse1) > 0x7FF;
  }
  // sweepRegisterByte(src/mml/compiler.js)の逆関数。speedは1が最速…15が最遅で
  // period=round((speed-1)/2)という線形近似なので、speed=2*period+1で厳密に戻せる。
  // depthの下位4bit(negate+shift)はレジスタのbit3-0そのまま。
  function sweepToMmlArgs(sweepReg) {
    return { speed: ((sweepReg >> 4) & 7) * 2 + 1, depth: sweepReg & 0x0F };
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
  // vrc7.js vrc7Freq(fnum,block)の逆関数。src/convert/borrow.js に集約(block は音符の理論値側で
  // 固定。「ズレは小さいので block は揺れない」前提は境界付近の音符で破れていた、2026-09-07)
  function vrc7FnumRaw(freq, ev) { return MML.Convert.Borrow.vrc7FnumRaw(freq, ev); }
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
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
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
    // 長さカウンタのロード(=レジスタ3への書き込み)だけを表すフラグ。ノイズはattackが
    // $400E(周期)の書込みでも立つためattackとは別に持つ必要がある(長さカウンタをロード
    // するのは$400Fだけ)。パルス/三角はattackと同義だが対称性のため同じように持つ。
    const lengthLoad = { p1:false, p2:false, tr:false, no:false };
    // 周期レジスタ(r2/r3)への書き込みフラグ。スイープユニットのシミュレーション
    // (extractPulseEvents)で「書き込みによるタイマ再ロード」を検出するのに使う。
    const periodWrite = { p1:false, p2:false };
    // $4001/$4005(スイープ)への書き込みフラグ(実機のsweepReload相当)
    const sweepWrite = { p1:false, p2:false };

    return writeLog.map(writes => {
      for (const k in attack) { attack[k] = false; lengthLoad[k] = false; }
      periodWrite.p1 = periodWrite.p2 = false;
      sweepWrite.p1 = sweepWrite.p2 = false;

      for (const { addr, value } of writes) {
        if      (addr >= 0x4000 && addr <= 0x4003) { r.p1[addr & 3] = value; if ((addr&3)===3) { attack.p1=true; lengthLoad.p1=true; } if ((addr&3)===2||(addr&3)===3) periodWrite.p1=true; if ((addr&3)===1) sweepWrite.p1=true; }
        else if (addr >= 0x4004 && addr <= 0x4007) { r.p2[addr & 3] = value; if ((addr&3)===3) { attack.p2=true; lengthLoad.p2=true; } if ((addr&3)===2||(addr&3)===3) periodWrite.p2=true; if ((addr&3)===1) sweepWrite.p2=true; }
        else if (addr >= 0x4008 && addr <= 0x400B) { r.tr[addr & 3] = value; if ((addr&3)===3) { attack.tr=true; lengthLoad.tr=true; } }
        else if (addr >= 0x400C && addr <= 0x400F) { r.no[addr & 3] = value; if ((addr&3)===2||(addr&3)===3) attack.no=true; if ((addr&3)===3) lengthLoad.no=true; }
        else if (addr >= 0x4010 && addr <= 0x4013) { r.dm[addr & 3] = value; }
        else if (addr === 0x4015) r.status = value;
      }
      return {
        p1:[...r.p1], p2:[...r.p2], tr:[...r.tr],
        no:[...r.no], dm:[...r.dm],
        status: r.status,
        attack: { ...attack },
        lengthLoad: { ...lengthLoad },
        periodWrite: { ...periodWrite },
        sweepWrite: { ...sweepWrite }
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
    // tieCandidate: このイベントの開始が「純粋な音程変化のみ」による分割だったか
    // (実アタック/デューティ/固定音量切替/エンベロープ周期変化を一切伴わない)。
    // スラー分割(src/convert/pitch.js markSlurTies、2026-08-12)がこのフラグを見て、
    // 独立した再アタック音符ではなくタイ(&)で繋いだレガートにできるかを判定する
    // hwEnvSeq: フレーム毎の「この frame でハードウェア音量エンベロープが打ち直されたか」
    // ($4003/$4007書込み=長さカウンタロードは実機で減衰レベルを15へ再ロードする)。
    // 抽出直後はイベント先頭以外に立つことは無いが、EP/EN統合(src/convert/pitch.js
    // mergeVibratoAndArpeggio)が複数の音符を1音へまとめると1音の中に複数の打ち直しが
    // 含まれるようになる。1音符=1本の減衰カーブしか持てないため、その場合は
    // toVolumeFields側で実測レベル列をソフトウェアエンベロープ(@v<n>)として書き出す
    // (これが無いと、統合された2音目以降のアタックが消えて最初の減衰カーブのまま
    //  0まで落ちて無音になる。FamicomBox「Game Select」で実測)
    // dutySeq: フレーム毎のデューティ(2026-09-08、楽器化)。デューティの変化では音符を区切らず
    //   ここに積む(以前は区切って再アタックしていた=元曲に無い位相リセット+エンベロープ再開)。
    //   変化があれば nsf2mml 側で @<n>={...} デューティエンベロープ(@@<n>)にする
    // keyOffAt: リリース開始(音符先頭からのフレーム数)。固定音量モードで「同じ音程のまま $4003 を
    //   書き直し、その音量が直前以下」の書き込みは、mck ドライバの putReleaseEffect(リリース
    //   区間の先頭をノートオンとして打ち直す)そのもの。以前は再アタックとみなして音符を割っていた
    //   (Famicompo「Wing Defenders」で実測)。ここで割らずにマークだけ付け、volSeq をそのまま
    //   積み続ける(toVolumeFields が keyOffAt で @v と @vr に切り分ける)。同じ音程・音量以下の
    //   打ち直しは固定音量モードでは位相リセット以外に音の違いが無いので、本物の再アタック
    //   (エコー等)をリリースと読んでも音は変わらない
    function begin(f, note, vol, duty, constVol, envKey, rawFreq, period, tieCandidate, sweep, sweepKey, attackNow) {
      cur = { note, vol, duty, constVol, envKey, start: f, end: f, volSeq: [vol], pitchSeq: [period], rawFreq,
        tieCandidate: !!tieCandidate, sweep: sweep || null, sweepKey: sweepKey || 0,
        hwEnvSeq: [!!attackNow], dutySeq: [duty], keyOffAt: null };
    }

    // リリース判定用のフレーム情報(MML.NSF2MML.Instrument.decaysAfter 参照)
    const Inst = MML.NSF2MML.Instrument;
    const frameInfo = (f2) => {
      const t2 = timeline[f2];
      if (!t2) return null;
      const r2 = t2[chKey];
      return { attack: !!t2.attack[chKey], constVol: !!(r2[0] & 0x10), vol: r2[0] & 0xF };
    };
    const isPulse1 = chKey === 'p1';
    // スイープユニットの内部状態(実機apu2a03.js PulseChannelと同じ)。writeLogには
    // レジスタへの書き込みしか残らないため、スイープが実際に書き換えていく周期は
    // ここでシミュレートしないと分からない(周期レジスタは止まったままに見える)。
    let simPeriod = -1, sweepDivider = 0, sweepReload = false;
    // 長さカウンタ(halt=0のとき自然消音する)。三角波のsilenceAtFrameと同じ考え方
    let silenceAtFrame = Infinity;

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
      // 長さカウンタ: $4003/$4007書込みでロードされ、halt($4000 bit5)が0の間だけ120Hzで
      // 減少して0で消音する。halt=1(継続音)なら減らないので自然消音しない。
      const lengthHalt = !!(r[0] & 0x20);
      if (t.lengthLoad[chKey]) silenceAtFrame = f + lengthAudibleFrames(LENGTH_TABLE[(r[3] >> 3) & 0x1F]);
      // haltが立っている間はカウンタが減らない(=期限が来ない)。既に0まで減り切った後に
      // haltを立てても復活はしないので、期限前のときだけ無期限へ延ばす
      if (lengthHalt && f < silenceAtFrame) silenceAtFrame = Infinity;
      const lengthGated = f < silenceAtFrame;
      // スイープユニットによる強制ミュート(実機/emulator apu2a03.js PulseChannel.isMutedと同じ規則):
      // スイープの有効/無効に関わらず、周期<8 または「目標周期(=period+(period>>shift)、
      // negate時は減算)が$7FFを超える」ときチャンネルは無音になる。特に$4001/$4005=$00
      // (negate=0, shift=0)のまま周期$400以上(o2a以下)の音符を書く曲では、レジスタ上は
      // 音符に見えても実際には一切鳴らない(Batman Prototype 1曲目: 元曲は$4005=$00で
      // Pulse2の低音が全て無音なのに、変換MMLはそれを音符として出力していた=元曲に
      // 無いベースが鳴る)。ここで無音として扱い休符にする(sweepRegisterByteのOFF値$08を
      // 書くコンパイラ側/NSFドライバ側は影響を受けない)
      //
      // ★スイープが「有効」(bit7=1かつshift>0)の場合は、上記のミュート判定だけでなく
      // 実際に周期レジスタがハードウェア側で書き換わっていく(120Hz=1フレーム2回)。
      // writeLogにはその変化が残らないため、ここで実機と同じ手順(apu2a03.js
      // PulseChannel.clockHalfFrame)でシミュレートする。音符自体の音程は書き込まれた
      // 周期(=発音開始時の音程)のままにしておき、動き自体はMMLのs<speed>,<depth>
      // コマンド(compiler.js sweepRegisterByte)で再現させる。ここでシミュレートするのは
      // 「いつスイープが自分でミュートするか」を知るためで、これが無いと元曲では
      // 下降して消えるだけの短い効果音が、変換MMLでは平坦な長い音符になってしまう
      // (FamicomBox「Game Select」のパルス1: $4001=$83で6フレームに約2オクターブ下降)。
      const sweepReg = r[1];
      const sweepEnabled = !!(sweepReg & 0x80) && (sweepReg & 7) > 0;
      // 周期レジスタへの書き込み(タイマ再ロード)/$4001書込み(dividerリロード)を反映
      if (simPeriod < 0 || t.periodWrite[chKey]) simPeriod = period;
      if (t.sweepWrite[chKey]) sweepReload = true;
      const simMuted = sweepMutes(simPeriod, sweepReg, isPulse1);
      const note = (active && audible && freq > 0 && lengthGated && !simMuted) ? freqToNote(freq) : null;
      const rawFreq = note !== null ? freq : null;
      const sweep = sweepEnabled ? sweepToMmlArgs(sweepReg) : null;
      // スイープの識別キー(有効時のみ。無効時は$08/$7F等どの値でも音に影響しないので0)
      const sweepKey = sweepEnabled ? sweepReg : 0;
      // このフレーム分(半フレーム2回)スイープユニットを進める
      for (let h = 0; h < 2; h++) {
        if (sweepDivider === 0 && sweepEnabled) {
          const target = sweepTargetPeriod(simPeriod, sweepReg, isPulse1);
          if (target <= 0x7FF) simPeriod = target;
        }
        if (sweepDivider === 0 || sweepReload) { sweepDivider = (sweepReg >> 4) & 7; sweepReload = false; }
        else sweepDivider--;
      }

      if (!cur) {
        begin(f, note, vol, duty, constVol, envKey, rawFreq, period, false, sweep, sweepKey, t.attack[chKey]);
        continue;
      }
      // アタック書き込み: 同じ音程・固定音量のまま音量が直前以下で、かつその後数フレームの
      // うちに直前の音量より確実に下がる(=減衰していく)なら「リリース開始」(begin の keyOffAt
      // 参照)、それ以外は新イベント。★「その後下がる」の確認が無いと、一定音量で同じ音を
      // 連打するだけの曲(c8 c8 c8 c8、$4003 を毎回書き直す)が1つの長い音符に化ける
      const releaseMark = !!t.attack[chKey] && note !== null && sweepKey === cur.sweepKey &&
        Inst.isReleaseRewrite(frameInfo, f, cur, note === cur.note, constVol, vol);
      // デューティ変化+音量上昇の再トリガー(Instrument.isRetrigger)は新しい音符。音量が上がらない
      // デューティ変化(立ち上がりの音色、DQ2 の余韻の音色落とし)は区切らず dutySeq に積む
      const lastDuty = cur.dutySeq[cur.dutySeq.length - 1];
      const retrigger = !t.attack[chKey] && Inst.isRetrigger(cur, constVol, duty, vol);
      if (t.attack[chKey] && !releaseMark) {
        flush(f); begin(f, note, vol, duty, constVol, envKey, rawFreq, period, false, sweep, sweepKey, true);
      } else if (!releaseMark && (retrigger || note !== cur.note || constVol !== cur.constVol ||
                 sweepKey !== cur.sweepKey || (!constVol && envKey !== cur.envKey))) {
        // 音程だけが変わった(デューティ(直前フレームと比較)/固定音量切替/エンベロープ周期/スイープは
        // 不変で再トリガーでもない)場合のみタイ候補とする
        const pureNoteChange = !retrigger && note !== cur.note && duty === lastDuty && constVol === cur.constVol &&
          sweepKey === cur.sweepKey && !sweepEnabled && (constVol || envKey === cur.envKey);
        flush(f); begin(f, note, vol, duty, constVol, envKey, rawFreq, period, pureNoteChange, sweep, sweepKey, false);
      } else {
        if (releaseMark) cur.keyOffAt = f - cur.start;
        cur.pitchSeq.push(period);
        cur.hwEnvSeq.push(false); // アタックは必ず上の分岐で新イベントになるためここは常にfalse
        cur.dutySeq.push(duty);
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

      if (!cur) { cur = { note, start: f, end: f, rawFreq, pitchSeq: [period], tieCandidate: false }; continue; }

      if (t.attack.tr) {
        flush(f); cur = { note, start: f, end: f, rawFreq, pitchSeq: [period], tieCandidate: false };
      } else if (note !== cur.note) {
        // 三角波はデューティ/エンベロープの概念が無いため、アタック無し+音程変化のみで
        // 分割される場合は常にタイ候補(pureな音程変化)
        flush(f); cur = { note, start: f, end: f, rawFreq, pitchSeq: [period], tieCandidate: true };
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
    let silenceAtFrame = Infinity; // 長さカウンタ(halt=0)による自然消音フレーム
    // リリース判定(パルスと同じ。$400F の打ち直しで同じ周期のまま音量が下がっていく=リリース開始)
    const Inst = MML.NSF2MML.Instrument;
    const frameInfo = (f2) => {
      const t2 = timeline[f2];
      if (!t2) return null;
      return { attack: !!t2.attack.no, constVol: !!(t2.no[0] & 0x10), vol: t2.no[0] & 0xF };
    };

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
      // 長さカウンタ($400F書込みでロード、halt=$400C bit5)。パルス/三角と同じ扱いで、
      // これを見ないと1〜数フレームだけの打楽器的なノイズが次の書込みまで鳴り続けてしまう
      const lengthHalt = !!(r[0] & 0x20);
      if (t.lengthLoad.no) silenceAtFrame = f + lengthAudibleFrames(LENGTH_TABLE[(r[3] >> 3) & 0x1F]);
      if (lengthHalt && f < silenceAtFrame) silenceAtFrame = Infinity;
      const on = active && (constVol ? rawVol > 0 : true) && f < silenceAtFrame;

      if (!cur) { cur = { periodIdx, mode, vol, on, constVol, envKey, start: f, end: f, volSeq: [vol], keyOffAt: null }; continue; }

      const releaseMark = !!t.attack.no && on && cur.on &&
        Inst.isReleaseRewrite(frameInfo, f, cur, periodIdx === cur.periodIdx && mode === cur.mode, constVol, vol);
      if (t.attack.no && !releaseMark) {
        flush(f); cur = { periodIdx, mode, vol, on, constVol, envKey, start: f, end: f, volSeq: [vol], keyOffAt: null };
      } else if (!releaseMark && (periodIdx !== cur.periodIdx || mode !== cur.mode || on !== cur.on ||
                 constVol !== cur.constVol || (!constVol && envKey !== cur.envKey))) {
        flush(f); cur = { periodIdx, mode, vol, on, constVol, envKey, start: f, end: f, volSeq: [vol], keyOffAt: null };
      } else if (constVol) {
        if (releaseMark) cur.keyOffAt = f - cur.start;
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
  // dpcmRom: 省略可。NSFファイルを持たない呼び出し元(VGM)がDPCMサンプルの実体を
  // 直接渡すための代替経路。{ bytes, loadAddr } で、bytesはloadAddrから始まるCPU
  // アドレス空間のイメージ(VGMはデータブロック0x67 type=0xC2でエミュレータのメモリへ
  // 書き込まれた$C000-$FFFFの16KB)。バンクスイッチの概念が無いので常に単純な線形解決
  function computeBankInfo(nsfBytes, header, dpcmRom) {
    if (dpcmRom && dpcmRom.bytes && dpcmRom.bytes.length) {
      return { useBankswitch: false, program: dpcmRom.bytes, loadAddr: dpcmRom.loadAddr || 0xC000 };
    }
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

  // ── DPCMサンプルの打点リスト/サンプル表(2026-09-03、ドラムパッド全形式展開) ──────
  // ロールのドラム区画・パッド試聴・ドラム(DPCM)パネルが使う。キーは鍵盤のDM行と同じ
  // 'dmc:<sampleAddr>:<sampleLen>'(バンクスイッチNSFはファイルキー側で区別するので、
  // 同じ(addr,len)で中身が違うサンプルは 'dmc:<addr>:<len>:<bank>' になる)。
  // pcm は実機DMCと同じ遷移でデルタ復号した波形(MML.Dpcm.decode)、rate はトリガー時の
  // $4010 レート。DPCMは音量を持たないので vol=1。
  //   hits:    [{ key, hash, pcm, rate, vol:1, startFrame, endFrame, label, fileKey, trig }]
  //   samples: { key → { key, pcm, rate, hash, label, bytes, fileKey } }
  MML.NSF2MML = MML.NSF2MML || {};
  MML.NSF2MML.dmcHits = function (writeLog, nsfBytes, header, options) {
    options = options || {};
    const timeline = buildTimeline(writeLog, options.initRegs || null);
    const triggers = extractDmcTriggers(timeline, writeLog, header || {});
    const bankInfo = computeBankInfo(nsfBytes, header || {}, options.dpcmRom);
    const U = (global.Emu && global.Emu.SamplePitchUtil) || (MML.Emu && MML.Emu.SamplePitchUtil) || null;
    const samples = {}, hits = [];
    const totalFrames = timeline.length;
    for (let i = 0; i < triggers.length; i++) {
      const trig = triggers[i];
      const fileKey = dmcTriggerFileKey(trig, bankInfo);
      // キーは鍵盤/ロール(keyboard.js DM行)と同じ 'dmc:<addr>:<len>'。バンクスイッチで中身が
      // 違うサンプルも同じパッドにまとまる(ロール側はバンクを知れないため。稀なので許容)
      const key = 'dmc:' + trig.sampleAddr + ':' + trig.sampleLen;
      let s = samples[key];
      if (!s) {
        const bytes = resolveDmcBytes(bankInfo, trig.bankState, trig.sampleAddr, trig.sampleLen);
        if (!bytes) continue;
        const pcm = MML.Dpcm ? MML.Dpcm.decode(bytes, bytes.length * 8, trig.dac) : null;
        if (!pcm) continue;
        s = { key, pcm, rate: MML.Dpcm.DMC_RATE_TABLE_NTSC[trig.rate & 0xF], bytes, fileKey,
              hash: (U && U.sampleHash) ? ('dmc-' + U.sampleHash(bytes, 0, bytes.length)) : null,
              label: trig.sampleAddr.toString(16).toUpperCase() };
        samples[key] = s;
      }
      const end = i + 1 < triggers.length ? triggers[i + 1].start : totalFrames;
      hits.push({ key, sampleKey: key, hash: s.hash, pcm: s.pcm, rate: MML.Dpcm.DMC_RATE_TABLE_NTSC[trig.rate & 0xF],
                  label: s.label, vol: 1, startFrame: trig.start, endFrame: Math.max(trig.start + 1, end), fileKey, trig });
    }
    return { hits, samples, triggers, bankInfo };
  };

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

  MML.NSF2MML = MML.NSF2MML || {}; // dmcHits(上)が先に生やしている

  // ── 楽器化(2026-09-08)。2A03パルス/ノイズ/MMC5パルス(expansion/mmc5.js)で共有 ──
  // 「複数の音符に割れていた1音を楽器定義(@v+@vr+@@/@@r+ゲート)へ畳む」ための判定と出力フィールド。
  // 抽出器側(extractPulseEvents 等)は ev.keyOffAt(リリース開始)/ev.dutySeq(フレーム毎のデューティ)
  // /ev.volSeq を積み、ここで @v/@vr/@@/@@r へ切り分ける。詳細は各関数のコメントと README「楽器化」
  MML.NSF2MML.Instrument = (function () {
    const RELEASE_LOOKAHEAD = 6;   // リリース判定で先読みするフレーム数
    const DUTY_ATTACK_FRAMES = 4;  // ここまでのデューティ変化は「立ち上がりの音色」

    // frameInfo(f) → { attack, constVol, vol } | null(範囲外)。f で打ち直した音量 v0 のあと
    // RELEASE_LOOKAHEAD フレーム以内に、固定音量のまま base(打ち直し直前の音量)より小さい音量に
    // なれば true。v0 より上がる瞬間があれば立ち上がり(13→15→減衰の再アタック。DQ2 の同音連打で
    // 実測)なので false。途中で再アタック/エンベロープモード切替があれば打ち切り
    function decaysAfter(frameInfo, f, base) {
      const i0 = frameInfo(f);
      if (!i0) return false;
      for (let k = 1; k <= RELEASE_LOOKAHEAD; k++) {
        const i2 = frameInfo(f + k);
        if (!i2 || i2.attack || !i2.constVol) break;
        if (i2.vol > i0.vol) return false;
        if (i2.vol < base) return true;
      }
      return false;
    }
    // アタック書き込み(キーオン)が「リリース開始」か: 同じ音程・固定音量のまま、打ち直した音量が
    // 直前以下で、その後確実に下がる。mck ドライバの putReleaseEffect(リリース区間の先頭をノートオン
    // として打ち直す)そのもの。固定音量モードでは位相リセット以外に音の違いが無いので、本物の
    // 再アタック(エコー等)をリリースと読んでも音は変わらない
    function isReleaseRewrite(frameInfo, f, cur, samePitch, constVol, vol) {
      return cur.keyOffAt == null && samePitch && constVol && cur.constVol && vol <= cur.vol &&
        decaysAfter(frameInfo, f, cur.vol);
    }
    // $4003 を書かずに「デューティを変えつつ音量を上げる」のは、位相リセットのクリックを避けて
    // 再アタックするドライバの書き方(Konami: 音符の頭だけデューティ2・音量6)。新しい音符として区切る
    function isRetrigger(cur, constVol, duty, vol) {
      const lastDuty = cur.dutySeq[cur.dutySeq.length - 1];
      return constVol && cur.constVol && duty !== lastDuty && vol > cur.vol;
    }
    // キーオフ位置(keyOffAt)の確定。抽出器が打ち直しで付けたものが無ければ、固定音量モードの音符で
    // 「デューティが音符の途中(先頭 DUTY_ATTACK_FRAMES 以降)で1回だけ変わりそのまま終わる」場合を
    // キーオフとみなす(ドラゴンクエストII等: 減衰の最後に音色を 1→0 へ落として余韻にする=実機
    // ppmck の @@r そのもの)。以前はここで音符を割って再アタックしていた(元曲に無い位相リセット)
    function decideKeyOff(ev, cmd) {
      if (ev.keyOffAt != null || !ev.constVol || !ev.dutySeq || ev.dutySeq.length < 2 || !cmd.INST) return;
      const ds = ev.dutySeq;
      const changes = [];
      for (let i = 1; i < ds.length; i++) if (ds[i] !== ds[i - 1]) changes.push(i);
      if (changes.length === 1 && changes[0] >= DUTY_ATTACK_FRAMES) ev.keyOffAt = changes[0];
    }
    // リリース付きの音符が「無音で終わった」(次のイベントが休符)かを控える。isSilent(ev) は
    // そのチャンネルの休符判定(パルス: note===null、ノイズ: !on)
    function markSilence(events, isSilent) {
      for (let i = 0; i < events.length; i++) {
        if (events[i].keyOffAt != null) events[i].endedBySilence = (i + 1 >= events.length) || isSilent(events[i + 1]);
      }
    }
    // 音符の終端(キーオフがあればそこ)
    function endOf(ev) { return (ev.keyOffAt != null && ev.keyOffAt > 0) ? ev.start + ev.keyOffAt : ev.end; }
    // 固定音量モードの音量列 → { volume | envelopeV, envelopeVr?, releaseEnd? }
    // リリース(keyOffAt): 音量列を本体(@v)とリリース(@vr)に切り分ける。音符は keyOffAt で終わり、以後は
    // mmlEmit が k<len> で、NOTE_END='next' のゲート吸収なら q/@q/@k で「ゲートオフ=リリース開始」を
    // 再現する。リリースの最後の段が短い(末尾値の連続が RELEASE_TAIL_ZERO_MAX 以下)まま無音になった
    // 音符は、その無音がリリース表の最終段 0 そのもの(例: Wing Defenders の {4 4 3 2} → {4 4 3 2 0})
    // なので 0 を足す(MML.Convert.releaseWithZero)。これで音符はゲートで伸ばせて q6 だけで書ける。
    // 末尾値を長く保持したあと切れる場合(例: 音量 2 を保持したあと切れる)は、0 を足すと保持フレーム数
    // ぶんの表(2 2 2 … 0)が音符長ごとに量産されるので足さず、無音の始まり(元イベントの end)を
    // releaseEnd に残す(mmlEmit はそこまでを k、以降を r で出し、NOTE_END のゲート吸収はその連鎖を
    // 対象外にする)
    function volumeFields(ev, envReg, vrReg) {
      if (vrReg && ev.keyOffAt != null && ev.keyOffAt > 0 && ev.keyOffAt < ev.volSeq.length) {
        const body = ev.volSeq.slice(0, ev.keyOffAt);
        const endedSilent = ev.endedBySilence && ev.end > ev.start + ev.keyOffAt;
        const rel = MML.Convert.releaseWithZero(ev.volSeq.slice(ev.keyOffAt), endedSilent);
        const vrIdx = vrReg.assignHold(rel);
        const idx = envReg.assign(body);
        const fields = idx == null ? { volume: MML.Convert.plainVolume(body) } : { envelopeV: idx };
        fields._volSeq = body; // スラー連鎖の音量連結(envelope.js mergeSlurVolumes)用
        if (vrIdx != null) {
          fields.envelopeVr = vrIdx;
          if (endedSilent && rel[rel.length - 1] !== 0) fields.releaseEnd = ev.end;
        }
        return fields;
      }
      // 打ち直しの印が無ければ、他形式と同じ印無しのリリース切り出し(envelope.js detectRelease)
      return envReg.volumeFieldsWithRelease ? envReg.volumeFieldsWithRelease(ev.volSeq)
        : (() => { const idx = envReg.assign(ev.volSeq); return idx == null ? { volume: MML.Convert.plainVolume(ev.volSeq) } : { envelopeV: idx }; })();
    }
    // デューティ列(dutySeq) → { toneEnv?, releaseTone? }
    //   ・キーオフ(keyOffAt)より前の本体で変化が無い … 従来どおり固定の @<duty>(instrument)
    //   ・本体の変化が先頭 DUTY_ATTACK_FRAMES 以内だけ({3 1 1 1…}) … 立ち上がりの音色として
    //     @<n>={3 1}(末尾保持)を登録し @@<n> で選ぶ(mck 風の音色)
    //   ・それ以外(音符の途中で何度も変わる) … ループ検出込みの表(デューティ LFO)
    //   ・キーオフ以降のデューティが本体の最後と違う … リリース音色 @@r<n>(実機 _REL_ORG_TONE、
    //     @vr の音色版。ゲートオフの瞬間に音色を差し替える)として @<n>={…} を別に登録する
    function toneFields(ev, dutyReg, cmd) {
      if (!dutyReg || !ev.dutySeq || !cmd.INST) return {};
      const cut = ev.keyOffAt != null ? Math.max(1, ev.keyOffAt) : ev.dutySeq.length;
      const body = ev.dutySeq.slice(0, cut);
      const rel = ev.dutySeq.slice(cut);
      const fields = {};
      if (new Set(body).size > 1) {
        let lastChange = 0;
        for (let i = 1; i < body.length; i++) if (body[i] !== body[i - 1]) lastChange = i;
        const idx = lastChange < DUTY_ATTACK_FRAMES ? dutyReg.assignHold(body) : dutyReg.assign(body);
        if (idx != null) fields.toneEnv = idx;
      }
      if (rel.length > 0 && rel.some(d => d !== body[body.length - 1])) {
        const idx = dutyReg.assignHold(rel);
        if (idx != null) fields.releaseTone = idx;
      }
      return fields;
    }
    return { decaysAfter, isReleaseRewrite, isRetrigger, decideKeyOff, markSilence, endOf, volumeFields, toneFields, DUTY_ATTACK_FRAMES };
  })();

  // 基準ピッチ(#TUNING)の自動検出: 変換本体(convertNsfOnce)を必要なら2回走らせる
  // (src/convert/options.js MML.Convert.autoTune 参照。全 *2mml 共通の入口の作り)
  MML.NSF2MML.convert = function (writeLog, nsfBytes, header, songIndex, initRegs, initWrites, options) {
    return MML.Convert.autoTune(options, (o) => convertNsfOnce(writeLog, nsfBytes, header, songIndex, initRegs, initWrites, o));
  };
  function convertNsfOnce(writeLog, nsfBytes, header, songIndex, initRegs, initWrites, options) {
    options = options || {};
    // 変換設定(src/convert/options.js): コマンド使用/不使用・譜面整形。全レジストリと
    // detune.js・emitScore へ同じ cmd を渡す
    const cmd = MML.Convert.normalizeCmd(options.cmd);
    const timeline = buildTimeline(writeLog, initRegs);

    // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2): 半音境界を跨ぐビブラートが
    // 音符連打に化ける問題を、抽出後の後処理パスとして統合する(ノイズ(evD)は
    // 音程=周期インデックスの離散値でビブラートの概念が無いため対象外)。
    // P-5「不明瞭→EPテーブル」側(スラー分割の相方、2026-08-12): mergeVibratoAndArpeggio
    // (高速アルペジオ→EN統合、2026-08-14で拡張)の直後に必ず連結して呼ぶ(pitchEp割当て前の
    // 生pitchSeqを直接連結するため)
    const evA = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractPulseEvents(timeline, 'p1', 1)));
    const evB = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractPulseEvents(timeline, 'p2', 2)));
    const evC = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractTriEvents(timeline)));
    const evD = extractNoiseEvents(timeline);
    let dmcTriggers = extractDmcTriggers(timeline, writeLog, header);
    const bankInfo    = computeBankInfo(nsfBytes, header || {}, options.dpcmRom);
    let dpcmFiles   = extractDpcmFiles(dmcTriggers, bankInfo);
    // ドラム(DPCM)パネルのサンプル単位設定(src/convert/drumSamples.js)を反映する(2026-09-03):
    //   変換しない … そのサンプルのトリガーを落とす(その分は休符。音声サンプルを外してROMを減らす用途)
    //   名前       … .dmc のファイル名にする
    // レート変更/差し替え/音量はNSFでは無損失経路(ROMバイト列そのまま)を崩すので今は反映しない
    // (必要なら src/convert/drumHits.js の再エンコード経路へ載せる)。
    // 設定はサンプル内容のハッシュで引く(dmcHits と同じ計算)。
    if (MML.Convert.DrumSamples && dpcmFiles.length && cmd.DRUM !== false) {
      const DS = MML.Convert.DrumSamples;
      const U = (global.Emu && global.Emu.SamplePitchUtil) || (MML.Emu && MML.Emu.SamplePitchUtil) || null;
      const dropKeys = new Set();
      for (const f of dpcmFiles) {
        const hash = (U && U.sampleHash) ? ('dmc-' + U.sampleHash(f.bytes, 0, f.bytes.length)) : null;
        if (!hash) continue;
        const st = DS.get(hash);
        if (st.enabled === false) { dropKeys.add(f.fileKey); continue; }
        const nm = st.name ? DS.sanitizeName(st.name) : '';
        if (nm) f.name = nm + '.dmc';
      }
      if (dropKeys.size) {
        dmcTriggers = dmcTriggers.filter(t => !dropKeys.has(dmcTriggerFileKey(t, bankInfo)));
        dpcmFiles = dpcmFiles.filter(f => !dropKeys.has(f.fileKey));
      }
      // 名前の衝突(別サンプルに同名を付けた)は連番で分ける
      const used = new Set();
      for (const f of dpcmFiles) {
        let n = f.name;
        for (let i = 2; used.has(n); i++) n = f.name.replace(/\.dmc$/, '') + '_' + i + '.dmc';
        used.add(n); f.name = n;
      }
    }

    // テンポ推定: チャンネル毎の発音開始間隔(IOI)から(MML.Convert.tempoMaterial、src/convert/bpm.js)。
    // IOIはゲートタイム(音符を短く切る発音)の影響を受けないため音長より頑健。
    const timingChannels = [
      evA.filter(e => e.note !== null),
      evB.filter(e => e.note !== null),
      evC.filter(e => e.note !== null),
      evD.filter(e => e.on),
    ];
    const noteDurations = [];
    for (const chEvents of timingChannels) {
      noteDurations.push(...MML.Convert.tempoMaterial(chEvents.map(e => e.start), chEvents.map(e => e.end - e.start)));
    }

    // 2倍/半分の決着は「実際に音価を書いてみて素直な方」(MML.Convert.chooseTempoOctave、src/convert/mmlEmit.js)
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, FPS)
      : MML.Convert.chooseTempoOctave(MML.Convert.detectBpm(noteDurations, FPS),
          timingChannels.map(events => ({ events })), FPS, { totalFrames: timeline.length, cmd });
    // MML本文に埋め込まれるテンポは整数(t<n>)に丸められる(mmlEmit.js)。音長量子化の
    // グリッド(fpb)も同じ丸め後の値で計算しないと、書き出し時と再生(コンパイル)時で
    // 基準テンポが食い違い、打ち直しの多いパートで誤差が蓄積してドリフトする
    // ([[tempo-rounding-drift-future-issue]]参照)。
    const fpb = FPS * 60 / Math.round(bpm);
    const totalFrames = timeline.length;

    // DPCM: ppmckc準拠(音符=テーブル行選択)で@DPCM<n>定義+実際のノートイベントを作る
    const { defs: dpcmDefs, comboIndexByKey: dpcmComboIndex } = buildDpcmDefs(dmcTriggers, dpcmFiles, bankInfo);
    const dpcmEvents = buildDpcmEvents(dmcTriggers, dpcmComboIndex, totalFrames, bankInfo);
    // 合成音ch(パルス/三角/ノイズ/拡張)をE(DPCM)へ載せた打点(options.drumHits、main.js synthDrum)。
    // 実機DPCMの定義(ROMそのまま)の後ろへ再エンコードした定義を連番で足す(src/convert/drumHits.js)
    let synthDrumStats = null;
    if (cmd.DRUM !== false && options.drumHits && options.drumHits.length && MML.Convert.DrumHits && MML.Dpcm) {
      const r = MML.Convert.DrumHits.dpcm(options.drumHits, FPS, {
        totalFrames, dmcRate: cmd.DMC_RATE, rateMix: cmd.RATE_MIX, poly: cmd.DRUM_POLY, prefix: 'nsf_drum', maxClipSec: 10 });
      const base = dpcmDefs.length;
      for (const d of r.defs) {
        dpcmFiles.push({ name: d.file, bytes: r.files[d.index].bytes, fileKey: 'synth:' + d.file });
        dpcmDefs.push({ index: base + d.index, file: d.file, freq: d.freq, size: d.size, dac: d.dac, mode: d.mode });
      }
      for (const ev of r.events) dpcmEvents.push({ start: ev.start, end: ev.end, note: 48, instrument: base + ev.instrument });
      dpcmEvents.sort((a, b) => a.start - b.start);
      // 打点が重なる区間は直近の打点が勝つ(DPCMは1本)。前のイベントの尻尾を次の頭で切る
      for (let i = 0; i + 1 < dpcmEvents.length; i++) if (dpcmEvents[i].end > dpcmEvents[i + 1].start) dpcmEvents[i].end = Math.max(dpcmEvents[i].start + 1, dpcmEvents[i + 1].start);
      synthDrumStats = r.stats;
    }

    // 拡張音源(複数同時使用可)を header.extraChips から全て検出する。
    // 順序はsrc/mml/compiler.jsのEXPANSION_PRIORITY(実機ppmck固定優先順位)に合わせる
    // (NSFのextraChipsにdpcmビットは無いためfilterで自然に除外される)。
    const extraChips = (header && header.extraChips) || 0;
    let expansions = MML.Mml.EXPANSION_PRIORITY.filter(name => {
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
      // NSFe の曲ラベル(tlbl)があれば添える(NSFヘッダには曲ごとの名前が無い)
      ...(MML.NSF.trackLabel && MML.NSF.trackLabel(header, songIndex) ? [`; Track    : ${MML.NSF.trackLabel(header, songIndex)}`] : []),
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
      ...MML.Convert.tuningCommentLines(),
      `; =========================================================`,
      ``
    ].join('\n');

    // 音量変化を曲全体で共有登録するレジストリ。固定音量モード(constVol)でvolSeqが
    // 全フレーム同一値(フラット)ならvolumeを、変化があれば実測形状のenvelopeV(0番台)を、
    // エンベロープモード(!constVol)ならハードウェア減衰カーブを厳密シミュレートした
    // envelopeV(100番台、HARDWARE_INDEX_BASE)を使う。休符(note===null)には音量は不要。
    const envReg = new MML.Convert.EnvelopeRegistry(cmd);
    function toVolumeFields(ev) {
      if (!ev.constVol) {
        const period = ev.envKey & 0x0F;
        const loop = !!(ev.envKey & 0x20);
        const shape = MML.Convert.simulateHwEnvelope(period, loop);
        // EP/EN統合(src/convert/pitch.js)で複数の音符が1音にまとまり、その中に
        // ハードウェアエンベロープの打ち直しが2回以上含まれる場合(元曲が音符ごとに
        // $4003を書いてアタックし直している場合)は、共有の100番台テーブル(1本の減衰
        // カーブ)では表現できない。打ち直しを反映した実測レベル列を組んで通常の
        // ソフトウェアエンベロープ(0番台@v<n>)として登録する。★これが無いと統合された
        // 2音目以降のアタックが消え、最初の減衰カーブのまま0へ落ちて後半が無音になる
        // (FamicomBox「Game Select」のパルス1 A3-A#3-A3トリル/パルス2の90フレーム
        //  アルペジオで実測。統合しない従来の分割出力なら各音符が自前のアタックを持つ)
        const seq = ev.hwEnvSeq;
        if (seq && seq.filter(Boolean).length > 1) {
          const vals = shape.values;
          const levelAt = (i) => shape.loop == null
            ? vals[Math.min(i, vals.length - 1)]     // 非ループ: 0到達後は末尾保持
            : vals[i % vals.length];                 // ループ: 1サイクルを繰り返す
          const dur = ev.end - ev.start;
          const levels = [];
          let since = 0;
          for (let f = 0; f < dur; f++) {
            if (f > 0) since = seq[f] ? 0 : since + 1;
            levels.push(levelAt(since));
          }
          const idx = envReg.assign(levels);
          return idx == null ? { volume: MML.Convert.plainVolume(levels), _volSeq: levels } : { envelopeV: idx, _volSeq: levels };
        }
        const idx = envReg.registerShape(shape, true);
        // 変換設定ENV=OFF時はnull → ピーク値のv<n>へ(src/convert/options.js plainVolume)
        return idx == null ? { volume: MML.Convert.plainVolume(shape) } : { envelopeV: idx };
      }
      // リリース(keyOffAt)の切り分けと通常の @v/v は共有ヘルパー(MML.NSF2MML.Instrument)
      return Inst.volumeFields(ev, envReg, inst.vrReg);
    }
    // 楽器化(2026-09-08): リリース表(@vr<n>)とデューティ(音色)エンベロープ表(@<n>={...})の登録先。
    // 判定・切り分けは MML.NSF2MML.Instrument(このファイル上部)。拡張音源(MMC5)にも渡す
    const Inst = MML.NSF2MML.Instrument;
    const inst = { vrReg: envReg.release, dutyReg: new MML.Convert.EnvelopeRegistry(cmd, '@'), cmd }; // @vr は envReg が持つ(defLines が一緒に出す)
    const vrReg = inst.vrReg, dutyReg = inst.dutyReg;
    const toToneFields = (ev) => Inst.toneFields(ev, dutyReg, cmd);

    // ピッチエンベロープ(厳密周期ビブラート)を曲全体で共有登録するレジストリ
    // (DESIGN-PITCH.md Phase 1)。基準点はev.rawFreqと同じ生成元(ev.pitchSeq[0])
    // なのでD<n>(detectChorusDetuneが後段で設定)とcompiler.js側で正しく合成される。
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry(cmd);
    // 2A03パルス/三角波は周期レジスタ(値が下がるほど音程が上がる)なのでdirectionUp=false
    // (compiler.jsのperiodFnIncreasing→vibratoSequence呼び出しと同じ規則、src/convert/pitch.js
    // fitVibrato参照)。
    function toPitchFields(ev) {
      if (ev.rawFreq == null || !ev.pitchSeq) return {};
      const fields = {};
      MML.Convert.applyPitchAssignment(fields, pitchReg.assign(ev.pitchSeq, false));
      return fields;
    }

    // ノートエンベロープ(高速アルペジオ)を曲全体で共有登録するレジストリ(2026-08-14)。
    // mergeVibratoAndArpeggioがev.noteEnvOffsetsを付与済みのイベントだけ登録する
    // (toPitchFieldsと同じ「classify+registerを1回で済ませる」inlineスタイル)。
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry(cmd);
    function toNoteEnvFields(ev) {
      if (!ev.noteEnvOffsets) return {};
      const idx = noteEnvReg.registerShape(ev.noteEnvOffsets);
      return idx != null ? { noteEnv: idx } : {};
    }

    // イベントを共通形式 { start, end, note, volume?/envelopeV?, instrument?, rawFreq? } に整形
    // (tieCandidateはスラー分割判定用にそのまま素通しする。src/convert/pitch.js
    // markSlurTies参照)
    // リリース(keyOffAt)付きの音符は「次が休符=無音で終わった」かを先に控える(toVolumeFields が
    // リリース表の末尾に 0 を足すかの判断に使う)
    for (const evs of [evA, evB]) {
      for (const ev of evs) if (ev.note !== null) Inst.decideKeyOff(ev, cmd);
      Inst.markSilence(evs, e => e.note === null);
    }
    Inst.markSilence(evD, e => !e.on);
    const toCommon = (ev) => Object.assign(
      { start: ev.start, end: Inst.endOf(ev),
        note: ev.note, instrument: ev.duty, rawFreq: ev.rawFreq,
        tieCandidate: ev.tieCandidate, sweep: ev.sweep || null },
      ev.note !== null ? toToneFields(ev) : {},
      ev.note !== null ? toVolumeFields(ev) : {},
      ev.note !== null ? toPitchFields(ev) : {},
      ev.note !== null ? toNoteEnvFields(ev) : {}
    );
    const chEventsA = evA.map(toCommon);
    const chEventsB = evB.map(toCommon);
    const chEventsC = evC.map(ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, rawFreq: ev.rawFreq, tieCandidate: ev.tieCandidate },
      ev.note !== null ? toPitchFields(ev) : {},
      ev.note !== null ? toNoteEnvFields(ev) : {}
    ));
    const chEventsD = evD.map(ev => Object.assign(
      { start: ev.start, end: Inst.endOf(ev), note: ev.on ? noisePeriodToNoteNum(ev.periodIdx) : null },
      ev.on ? toVolumeFields(ev) : {}
    ));
    // スラー分割(2026-08-12): 純粋な音程変化のみで区切られ、両側とも十分な長さ+
    // 自前の変調が無い隣接ペアをタイ(&)で繋ぐ(src/convert/pitch.js markSlurTies)。
    // pitchEp/portamentoが確定した後・detuneEntries(D<n>算出)より前でよい
    // (D<n>はslurTieの判定に使わないため順不同、ここでまとめて処理する)
    MML.Convert.markSlurTies(chEventsA);
    MML.Convert.markSlurTies(chEventsB);
    MML.Convert.markSlurTies(chEventsC);

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
      { letter: 'A', events: chEventsA, hasInstrument: true, hasVolume: true, hasEnvelope: true, hasDetune: true, hasPitchMod: true, hasSweep: true },
      { letter: 'B', events: chEventsB, hasInstrument: true, hasVolume: true, hasEnvelope: true, hasDetune: true, hasPitchMod: true, hasSweep: true },
      { letter: 'C', events: chEventsC, hasDetune: true, hasPitchMod: true },
      { letter: 'D', events: chEventsD, hasVolume: true, hasEnvelope: true },
      ...(dpcmLetter ? [{ letter: dpcmLetter, events: dpcmEvents, hasInstrument: true }] : []),
    ];

    // FDS/N163の自作波形も曲全体で共有登録するレジストリ(@FM<n>/@N<n>としてMML本文の
    // ヘッダに埋め込む。それぞれ定義書式が異なる別レジストリが必要)。
    const fdsWaveReg = new MML.Convert.WaveRegistry('@FM');
    const n163WaveReg = MML.Convert.n163WaveRegistry();
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
        initRegs, initWrites, options.n163Snapshots, pitchReg, noteEnvReg, inst);
      const letters = expansionLetterMap[chip];
      const hasPitchModForChip = chip !== 'vrc7'; // VRC7はfnum/block対数空間でD/EP/MP非対応(DESIGN-PITCH.md §7)
      // EN(ノートエンベロープ)はfnum/blockを都度再計算するだけなのでVRC7でも使える
      // (D/EP/MPと違い生レジスタへの単純加算を必要としない、src/mml/compiler.js
      // segmentsToWriteLogVrc7参照)。hasPitchModとは独立にVRC7も含め常にtrue。
      result.channels.forEach((ch, index) => {
        scoreChannels.push(Object.assign({}, ch, { letter: letters[index], hasDetune: true, hasPitchMod: hasPitchModForChip, hasNoteEnv: true }));
        detuneEntries.push({ events: ch.events, periodFn: expansionPeriodFn(chip, index) });
      });
      if (result.fdsWave)  fdsWave  = result.fdsWave;
      if (result.n163Wave) n163Wave = result.n163Wave;
      if (result.fdsModDefLines) fdsModDefLines = result.fdsModDefLines;
      if (chip === 'n163') n163ChannelCount = result.channels.length;
    }

    // 2A03本体+全拡張音源を横断してコーラス検知+D<n>補正(上のdetuneEntries参照)
    MML.Convert.detectChorusDetune(detuneEntries, detuneEntries.map(e => e.periodFn), { cmd });

    // ── チャンネル割当(案E): ユーザーが鍵盤表示で借用先を変えたぶんを反映する ──
    // NSFはネイティブ変換(元のチップがそのまま出力先)なので、割当変更でできるのは
    // 「同じ音源の別チャンネルへ移す」「2A03パルス↔MMC5パルスへ移す」「出力しない(skip)」の3つ。
    // 音程の生周期換算式と音量の尺度が完全に同じ組合せに限る(それ以外は抽出時点で
    // ネイティブ前提のEP/@vが確定済みのため、ここで移すと音程・音量が狂う)。
    const planNotes = [];
    if (options.channelMap) {
      const applied = applyNsfChannelMap(scoreChannels, options.channelMap, {
        expansions, expansionLetterMap, n163ChannelCount, dpcmLetter, planNotes,
      });
      for (const chip of applied.addedChips) if (expansions.indexOf(chip) < 0) expansions.push(chip);
      expansions.sort((a, b) => MML.Mml.EXPANSION_PRIORITY.indexOf(a) - MML.Mml.EXPANSION_PRIORITY.indexOf(b));
    }

    // VRC7自作音色(@0)の同時使用を1系統へ(src/convert/vrc7Tone.js)。元がVRC7なので実機は
    // 必ず1系統に収まっているはずだが、ドライバが音符ごとに$00-$07を書き直す曲だと
    // フレーム単位のスナップショットがchごとに別の瞬間の値を拾って衝突しうる。
    // 放置するとMMLがコンパイルできず全パート無音になるので、ここでも通す
    // (衝突が無ければ何もしないので既定のNSFでは出力不変)
    const vrc7Notes = MML.Convert.Vrc7Tone.resolveForScore(scoreChannels, vrc7ToneReg);

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

    // 音符の区切り(NOTE_END、src/convert/envelope.js)。@v表を書き換えるので defLines() より前
    MML.Convert.applyNoteEnd(scoreChannels, envReg, cmd, fpb, FPS);
    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm, cmd,
      headerLines: [...MML.Convert.tuningHeaderLines(), ...directiveLines, ...dpcmDefLines, ...envReg.defLines(), ...dutyReg.defLines(),
        ...pitchReg.defLines(), ...noteEnvReg.defLines(),
        ...fdsWaveReg.defLines(), ...n163WaveReg.defLines(), ...vrc7ToneReg.defLines(), ...fdsModDefLines]
    });

    // チャンネル割当をユーザーが変えたときだけ、実際の並びと適用できなかった指定を書き添える
    // (上のヘッダコメントは既定の並び前提の固定文なので、そこは触らず追記する)
    const planComment = (options.channelMap
      ? [`; チャンネル割当: ユーザー指定 (${scoreChannels.map(c => c.letter).join('')})`,
        ...planNotes.map(n => `; ※ ${n}`), ``]
      : []).concat(vrc7Notes.length ? [...vrc7Notes.map(n => `; ※ ${n}`), ``] : []).join('\n');
    const mml = [headerComment + planComment, scoreText].join('\n');

    // 変換結果の音程検証(src/convert/verify.js): 最終MMLを実コンパイルして
    // 「実際に鳴る音の高さ」を変換元イベントと突き合わせる(失敗しても変換は妨げない)
    const pitchCheck = MML.Convert.verifyPitch
      ? MML.Convert.verifyPitch(mml, scoreChannels, { frameRate: FPS, totalFrames: totalFrames,
          compileOpts: { dpcmSamples: Object.fromEntries(dpcmFiles.map(f => [f.name, f.bytes])) } })
      : null;

    return { mml, dpcmFiles, bpm: Math.round(bpm), expansions, fdsWave, n163Wave, pitchCheck, scoreChannels };
  };

  // ── チャンネル割当(案E) ────────────────────────────────────────
  // NSFはネイティブ変換なので「借用先」という概念が無く、割当でできるのは
  //   ・同じ音源の別チャンネルへ移す(N163 ch3→ch1、VRC7 ch1↔ch2 等)
  //   ・2A03パルス ↔ MMC5パルス(周期式・音量尺度が完全に同一)
  //   ・そのチャンネルを出力しない(skip)
  // の3つに限る。他チップへ移すには抽出前に借用先を決める必要がある(EP/@vが
  // ネイティブの生レジスタ空間で確定済みのため、後から移すと音程・音量が狂う)。
  // 変換元チャンネルのIDは鍵盤表示の行IDと同じ体系(P1/P2/TR/NO/DM/FDS/VR<n>/V6P1…)。
  const NSF_APU_SRC = {
    P1: { letter: 'A', family: 'pulse' }, P2: { letter: 'B', family: 'pulse' },
    TR: { letter: 'C', family: 'triangle' }, NO: { letter: 'D', family: 'noise' },
  };
  const NSF_EXP_SRC = [
    [/^DM$/, () => ({ chip: 'dpcm', index: 0, family: 'dpcm' })],
    [/^FDS$/, () => ({ chip: 'fds', index: 0, family: 'fds' })],
    [/^VR([1-6])$/, m => ({ chip: 'vrc7', index: +m[1] - 1, family: 'vrc7' })],
    [/^V6(P1|P2|SW)$/, m => ({ chip: 'vrc6', index: { P1: 0, P2: 1, SW: 2 }[m[1]], family: m[1] === 'SW' ? 'vrc6saw' : 'vrc6pulse' })],
    [/^FE([1-3])$/, m => ({ chip: 'fme7', index: +m[1] - 1, family: 'fme7' })],
    [/^M5(P1|P2)$/, m => ({ chip: 'mmc5', index: m[1] === 'P1' ? 0 : 1, family: 'pulse' })],
    // N163の表示行N{k}はハードウェアch(numCh-k)。MML文字は下位アドレス側から順に振られる
    // (src/ui/keyboard.js getPartLetter と同じ規則)
    [/^N([1-8])$/, (m, ctx) => ({ chip: 'n163', index: ctx.n163ChannelCount - (+m[1]), family: 'n163' })],
  ];
  function nsfSourceInfo(id, ctx) {
    if (NSF_APU_SRC[id]) return Object.assign({ chip: '2a03' }, NSF_APU_SRC[id]);
    for (const pair of NSF_EXP_SRC) {
      const m = pair[0].exec(id);
      if (!m) continue;
      const info = pair[1](m, ctx);
      if (info.index < 0) return null;
      const letters = ctx.expansionLetterMap[info.chip] || [];
      return Object.assign({}, info, { letter: letters[info.index] });
    }
    return null;
  }

  function applyNsfChannelMap(scoreChannels, channelMap, ctx) {
    const Plan = MML.Convert.ChannelPlan;
    const notes = ctx.planNotes;
    const addedChips = [];
    const byLetter = new Map();
    for (const ch of scoreChannels) byLetter.set(ch.letter, ch);

    const moves = [];   // { ch, to }   to=null はskip(出力しない)
    for (const id of Object.keys(channelMap)) {
      const target = channelMap[id];
      const src = nsfSourceInfo(id, ctx);
      if (!src || !src.letter) continue;
      const ch = byLetter.get(src.letter);
      if (!ch) continue;
      if (target === 'skip') { moves.push({ ch, to: null }); continue; }
      // 'dpcm'(E): このchを打楽器として分離レンダリングした打点(options.drumHits)がEへ入る。
      // 旋律としての出力は消す(二重発音の防止。DM行自身は元々Eなので対象外)
      if (target === 'dpcm' && src.family !== 'dpcm') { moves.push({ ch, to: null }); continue; }
      const info = Plan.targetInfo(target);
      const dstLetter = Plan.letterOfTarget(target);
      if (!dstLetter || dstLetter === src.letter) continue;
      if (info.family !== src.family) {
        notes.push(`${src.letter} → ${Plan.targetLabel(target)} はNSF(ネイティブ変換)では音程・音量の尺度が変わるため適用できません。`);
        continue;
      }
      if (info.chip === 'n163' && info.index >= ctx.n163ChannelCount) {
        notes.push(`${src.letter} → ${Plan.targetLabel(target)} はこの曲のN163有効ch数(${ctx.n163ChannelCount})の外なので適用できません。`);
        continue;
      }
      moves.push({ ch, to: dstLetter, chip: info.chip });
    }
    // 移動元は空くので、その空きへ入る移動(A↔Bの入れ替え等)は許す。空かない文字は拒否する
    const vacated = new Set(moves.map(mv => mv.ch.letter));
    const applied = [];
    for (const mv of moves) {
      if (mv.to === null) { applied.push(mv); continue; }
      const occupant = byLetter.get(mv.to);
      if (occupant && !vacated.has(mv.to)) {
        notes.push(`${mv.ch.letter} → ${mv.to} は ${mv.to} が既に使われているため適用できません。`);
        continue;
      }
      applied.push(mv);
    }
    for (const mv of applied) {
      if (mv.to === null) {
        const i = scoreChannels.indexOf(mv.ch);
        if (i >= 0) scoreChannels.splice(i, 1);
        continue;
      }
      mv.ch.letter = mv.to;
      if (mv.chip && mv.chip !== '2a03' && mv.chip !== 'dpcm' && addedChips.indexOf(mv.chip) < 0) addedChips.push(mv.chip);
    }
    MML.Convert.sortChannelsByLetter(scoreChannels);
    return { addedChips };
  }

  // 鍵盤表示のチャンネル割当UIが「この形式で選べる借用先」を絞るために使う
  // (NSFは同じ音源内の移動と2A03パルス↔MMC5パルスだけ)
  MML.NSF2MML.sourceInfo = nsfSourceInfo;

})(window);
