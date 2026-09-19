/*
 * AY-3-8910(PSG) → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.ay(writeLog, totalFrames) → { channels: [...] }
 *
 * ポート0xA0=レジスタ選択, 0xA1=データ書込。reg0/1,2/3,4/5=ch0-2の12bit周期(lo/hi)、
 * reg8/9/10=ch0-2の音量(下位4bit、bit4=エンベロープ使用)。専用アタックレジスタが
 * 無いため音量0→非0の遷移をノートオンとして扱う(nsf2mml/expansion/fme7.jsと同型)。
 * reg6=ノイズ周期(5bit,全ch共有)、reg7=ミキサー(bit0-2=トーン有効/bit3-5=ノイズ有効、
 * どちらも0で有効のactive-low)。ミキサーはppmckの`@<n>`(0=ミュート/1=トーン/2=ノイズ/
 * 3=トーン+ノイズ)へ対応させ、`@2`ではノート番号自体がノイズ周期(0-31)になる。
 * reg11/12=エンベロープ周期(16bit)、reg13=エンベロープ形状(書込み=位相リセット)。どれも全ch共有。
 *
 * ★借用先 FME-7(5B)は内蔵1/2プリスケーラのぶん、同じレジスタ値で MSX PSG の1オクターブ下を鳴らす
 *   (エミュレータ実装: ay8910Msx.js は Z80 3.58MHz/16、fme7.js は CPU 1.79MHz/16 で内部を進める)。
 *   トーンは周波数→ノート番号を経由するので自動で合うが、**ノイズ周期と
 *   エンベロープ周期は生のレジスタ値のまま出るので、ここで clock 比(≒1/2)を掛けて写す**(2026-09-19)。
 *   掛けていなかったため、ノイズは1オクターブ低く(打楽器の「シャッ」が「ザー」に)鳴っていた。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Kss2MmlExpansion = MML.Kss2MmlExpansion || {};

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }
  function toneFreq(period, clock) { return period >= 1 ? clock / (32 * period) : 0; }

  // ノイズLFSRのシフトレート。トーンと同じ分周(ay8910Msx.js clock()内で1/16、2フリップで
  // 1シフト)なので式もトーンと同一。周期0は実機同様1として扱う。
  function noiseFreq(np, clock) { return clock / (32 * Math.max(1, np)); }

  // 2A03ノイズの実測16周期(NTSC。apu2a03.js / gbs2mml/expansion/noise.js と同じテーブル)。
  // ピアノロールのノイズ行は全チップこの16段階へ揃えてC1(24)〜D#2(39)に並べる約束なので
  // (keyboard.js noisePeriodIndexToMidi)、AYのノイズ周波数も対数距離で最寄りに写像する。
  // ★AYのノイズ周期(0-31)をそのままノート番号にすると midi = 周期+12 となり、
  //   周期が小さい曲では MIDI_MIN(24) を下回ってロールに描画されない。
  const NES_CPU_CLOCK = 1789772.5;
  const NES_NOISE_FREQS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068]
    .map(p => NES_CPU_CLOCK / p);
  function noiseFreqToRollIndex(freqHz) {
    if (!freqHz) return 0;
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < NES_NOISE_FREQS.length; i++) {
      const d = Math.abs(Math.log2(freqHz / NES_NOISE_FREQS[i]));
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return best;
  }

  // 借用先 FME-7 の周期レジスタへ写す(冒頭コメントの★)。FME-7 の内部は CPU/16、この抽出器の clock は
  // ay8910Msx.js の clock() 呼び出しレート(KSS は Z80 3579545)で内部は clock/16。周期はレートに比例させる。
  // 0 はどちらのチップでも「1扱い」なので 0 のまま、それ以外は 1 未満へ落とさない(MSX のノイズ周期1=
  // 111.8kHz は FME-7 では出せないので最寄りの1=55.9kHzへ)
  const FME7_CLOCK = 1789773;
  function toFme7Period(raw, clock, max) {
    if (!raw) return 0;
    return Math.max(1, Math.min(max, Math.round(raw * FME7_CLOCK / clock)));
  }

  // ハードウェアエンベロープの出力レベル(0-31)を、形状書込みから ticks 内部クロック後について求める。
  // ay8910Msx.js AyEnvelope と同じ手順(書込み直後の最初の clock で1段進み、以後 period ごとに1段)。
  // S/M を出せない借用先(ENV=OFF や 2A03 等)へ載せるときの固定音量の代わりに使う
  function hwEnvLevelAt(shape, period, ticks) {
    const hold = (shape & 1) !== 0, alt = (shape & 2) !== 0, cont = (shape & 8) !== 0;
    let att = (shape & 4) !== 0;
    let n = ticks < 1 ? 0 : Math.floor((ticks - 1) / Math.max(1, period)) + 1;
    if (n > 128) n = 64 + ((n - 64) % 64); // 64段より先は周期的(ホールド系は既に止まっている)
    let level = att ? 0 : 31, step = 0;
    for (let i = 0; i < n; i++) {
      step++;
      if (step > 31) {
        step = 0;
        if (!cont) return 0;
        if (hold) return alt ? (att ? 0 : 31) : (att ? 31 : 0);
        if (alt) att = !att;
      }
      level = att ? step : (31 - step);
    }
    return level;
  }

  function buildTimeline(writeLog, clock) {
    let addrReg = 0;
    const regs = new Uint8Array(16);
    // ミキサー(reg7)を一度も書かない曲があるため、エミュレータ(ay8910Msx.js)と同じ
    // 既定値から始める。0のまま始めると全chがトーン+ノイズ有効として抽出されてしまう
    regs[7] = 0x38;
    // 書込み時刻付きトレース(位相エイリアシング対策、extractToneEvents 参照)。ch別の音量 [{t,v}] と
    // 周期 [{t,v}]。t は分数フレーム(kssPackWrite の frac、旧ログは全て .0 で hasFrac=false)
    const traces = { vol: [[], [], []], pitch: [[], [], []], hasFrac: false };
    const timeline = writeLog.map((writes, f) => {
      let envRestart = false; // このフレームで reg13(形状)が書かれた=エンベロープの位相リセット
      let envRestartFrac = 0; // その書込みのフレーム内位置(0-1、エンベロープ減衰のシミュレーション用)
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite): addr=bit0-15 / value=bit16-23 / io=bit24 / frac=bit25-30
      for (const pw of writes) {
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF, io = (pw >> 24) & 1;
        if (!io) continue;
        if (addr === 0xA0) addrReg = value & 0x0F;
        else if (addr === 0xA1) {
          regs[addrReg] = value;
          const frac = ((pw >>> 25) & 0x3F) / 64;
          if (frac > 0) traces.hasFrac = true;
          const t = f + frac;
          if (addrReg === 13) { envRestart = true; envRestartFrac = frac; }
          if (addrReg >= 8 && addrReg <= 10) traces.vol[addrReg - 8].push({ t, v: (value & 0x10) ? 15 : (value & 0x0F) });
          else if (addrReg <= 5) { const ch = addrReg >> 1; traces.pitch[ch].push({ t, v: regs[ch * 2] | ((regs[ch * 2 + 1] & 0x0F) << 8) }); }
        }
      }
      const periods = [
        regs[0] | ((regs[1] & 0x0F) << 8),
        regs[2] | ((regs[3] & 0x0F) << 8),
        regs[4] | ((regs[5] & 0x0F) << 8),
      ];
      const volumes = [0, 1, 2].map(ch => {
        const v = regs[8 + ch];
        return (v & 0x10) ? 15 : (v & 0x0F); // エンベロープ使用時は簡略化して最大音量扱い
      });
      // reg7(ミキサー)のbit0-2=トーン無効(1で無効/active-low)。ここが立っている間は
      // そのチャンネルのトーン周期レジスタが古い値を保持したままノイズ専用や無音に
      // 切り替わっていることがあり(打楽器的なノイズ音とメロディを同じチャンネルで
      // 高速に切り替えるMSXドライバでよくある手法、実ファイルで確認済み)、それを見ずに
      // 周期レジスタだけでノート判定すると、ノイズ区間なのに直前のトーン音程のまま
      // 音量だけ変化する偽ノート(ノイズの減衰エンベロープを別々の短いノートの連打と
      // 誤検出)になっていた。
      const modes = [0, 1, 2].map(ch =>
        (((regs[7] >> ch) & 1) ? 0 : 1) | (((regs[7] >> (3 + ch)) & 1) ? 0 : 2));
      return {
        periods, volumes, modes, noisePeriod: regs[6] & 0x1F,
        envUsed: [0, 1, 2].map(ch => (regs[8 + ch] & 0x10) !== 0),
        envShape: regs[13] & 0x0F, envPeriod: regs[11] | (regs[12] << 8), envRestart, envRestartFrac,
      };
    });
    timeline.traces = traces;
    return timeline;
  }
  // ソフトエンベロープ/ピッチ列の位相エイリアシング対策(hes2mml/expansion/wave.js buildVolTimeline
  // 冒頭コメント参照)。ドライバのタイマー周期がフレームと合わない曲(MSX の 60Hz/50Hz 混在、VGM の
  // VSYNC ドライバの揺らぎ)では、同じエンベロープでも段の位置が±1フレームずれた変種(11 11 11 10 10 …
  // と 11 11 10 10 10 …)が量産される。書込み時刻トレースがあれば、音符の開始書込みを原点にした
  // 相対時刻で音量列/周期列を読み直す。マージ処理より前に、イベント長を変えずに行う
  function resampleEvents(events, traces, ch) {
    const R = MML.Convert.TickResample;
    if (!R || !traces || !traces.hasFrac) return;
    const vt = traces.vol[ch], pt = traces.pitch[ch];
    const off = R.sampleOffsetFor([vt, pt]);
    for (const ev of events) {
      if (ev.note === null) continue;
      const a = R.noteAnchorT(ev.start, [vt, pt]);
      // ハードウェアエンベロープの音符は volSeq をチップの減衰から作っている(レジスタの音量値ではない)
      if (vt.length && !ev.envUsed) ev.volSeq = R.resampleSeq(vt, ev.start, ev.end, ev.volSeq, a, off);
      // 超音波を o9b へ寄せた音符(topClamp)は周期の実測を当て直さない(o9b 相当の一定値のまま。EP を作らせない)
      if (pt.length && !ev.topClamp) ev.pitchSeq = R.resampleSeq(pt, ev.start, ev.end, ev.pitchSeq, a, off);
    }
  }

  // ピッチ/トーン有効状態が同じ間は音量変化だけでは区切らずvolSeqに積む
  // (ソフトウェア音量エンベロープ抽出用。src/nsf2mml/expansion/fme7.jsと同じ考え方)。
  // ただし音量がそれまでの減衰傾向から上向きに跳ね上がった(=エンベロープ再アタック)
  // 場合は、同じ音程・同じ音量のままの同音連打であっても必ず新イベントに区切る。
  // 【周期レジスタへの書込みそのものを合図にする案(periodTouched)は撤回】PSGにも
  // SCC同様キーオン信号が無いため当初は「周期レジスタへの書込み+音量上昇」の両方を
  // 要求していたが、F1 Spirit 64曲目のSCC(同じ手法を移植したscc.js)で「音程が同じ
  // ままの同音連打で周波数レジスタが書き直されない(値が変わらないので省略される)」
  // 曲があり、periodTouchedを必須にすると本来の再アタックを見逃すことが判明した。
  // 音量が上向きに跳ね上がること自体がソフトウェアエンベロープの再アタックを意味する
  // ため、これだけで十分な合図になる(Ys1 12曲目のperiodTouched=falseの偽陽性ケースは
  // 音量も変化しない継続ティックだったため、この条件だけで元々弾かれていた)。
  //
  // ★ハードウェアエンベロープ(音量レジスタ bit4)の音符(2026-09-19): 従来は「最大音量15の固定音量」に
  //   潰していたため、減衰形状(S0/S9 等)で鳴らすドラム・ベースが v15 で鳴りっぱなしになり、借用先 FME-7 が
  //   元の PSG より大きく聞こえる主因だった(Salamander 29曲目 ch A で実測、報告参照)。FME-7 は同じ
  //   エンベロープを持つので nsf2mml/expansion/fme7.js と同じく S<n>/M<n> で出す。区切りは
  //   「reg13 書込み(位相リセット)」「形状/周期の変化」「エンベロープ使用の切替」。音量の上昇では区切らない
  //   (エンベロープの三角波などで上がるのは正常)。volSeq はチップの減衰をフレームごとに計算した値
  //   (hwEnvLevelAt、4bit へ)で、S/M を出せない借用先・ENV=OFF のときの固定音量の根拠にだけ使う。
  function extractToneEvents(timeline, chIndex, clock, frameRate) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    // エンベロープは全ch共有の1個なので、位相リセット(reg13書込み)の時刻もチップ全体で1つ
    let envT0 = null; // 直近の reg13 書込みのフレーム時刻(分数込み)。null=まだ一度も書かれていない
    const ticksPerFrame = clock / 16 / (frameRate || 60);
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      if (t.envRestart) envT0 = f + t.envRestartFrac;
      const period = t.periods[chIndex];
      const envUsed = !!(t.envUsed && t.envUsed[chIndex]);
      const envKey = envUsed ? `hw${envT0 == null ? '-' : envT0}` : undefined; // 位相リセットごとに別の値
      const envTicks = envT0 == null ? 0 : (f + 0.5 - envT0) * ticksPerFrame;
      const volume = envUsed
        ? (envT0 == null ? 15 : hwEnvLevelAt(t.envShape, t.envPeriod, envTicks) >> 1)
        : t.volumes[chIndex];
      // 一発形状(Continue=0、または Hold で0に止まる形)を32段鳴らし終えた後は無音のまま。
      // FME-7 へ出すと音符の頭で位相リセット(S<n>)が入り鳴ってしまうので休符にする
      const envSilent = envUsed && envT0 != null && volume === 0 &&
        (!(t.envShape & 8) || (t.envShape & 1)) && envTicks >= 1 + 31 * Math.max(1, t.envPeriod);
      const mode = t.modes[chIndex];
      // ★2026-08-22: 「トーン有効だがトーン周期0」= トーン発生器は実質鳴っていないので、
      // ノイズが有効ならノイズ単独(@2)として扱う。実測でAleste Gaiden(MSX2)のch Aが
      // 全曲この状態(mode=3=トーン+ノイズ有効、period=0)で打楽器を鳴らしており、
      // 従来は mode===2 しかノイズ扱いしなかったため下の枝に落ちて period>=1 を満たさず
      // note=null(=休符)になり、ロールにもMMLにも一切出てこなかった。
      const toneUsable = (mode & 1) !== 0 && period >= 1;
      const effMode = toneUsable ? mode : ((mode & 2) ? 2 : 0);
      // @2(ノイズ単独)はノート番号=ノイズ周期。それ以外はトーン周期から音程を求める
      let note = null;
      let freqHz = null; // トーン発音時の実周波数(デチューン検出用、ノイズ単独時はnull)
      let seqPeriod = period; // pitchSeq に積む周期(超音波を o9b へ寄せたときはその周期)
      if ((envUsed ? !envSilent : volume > 0) && effMode !== 0) {
        if (effMode === 2) note = t.noisePeriod;
        else if (toneUsable) {
          freqHz = toneFreq(period, clock); note = freqToNoteNumber(freqHz);
          // ★超音波のトーン(周期1〜3。MSX で 112kHz〜37kHz)は MML の最高音 o9b(119)より上で note=null(休符)に
          //   なっていた。Konami のドラムは周期1+ハードウェアエンベロープの1フレームで「カチッ」という頭を作る
          //   (方形波の平均=直流が音量ぶん跳ねるだけで、高さは聞こえない)。休符にすると打楽器の頭が1フレーム
          //   遅れて聞こえ、アタックも消える(Metal Gear 2 曲153 の X: バスドラの打点ごと。2026-09-19)。
          //   方形波の直流の跳ね(=クリック)は周期に依らないので、o9c(108、8.4kHz。高さの成分だけは近似)で鳴らす(周期も o9c 相当にして
          //   EP を作らせない)。★o9b まで寄せないこと: NSF 書き出しの 6502 ドライバは o9 の音程表が崩れていて
          //   (o9c〜o9a は全部周期7、o9a+/o9b は桁あふれで低音になる。t1.mml で JS 再生と実測比較)、o9c だけが一致する
          // ★2026-09-19 改: NSF の FME7 周期表を o9b まで広げた(ppmckDriver.js noteTableSize。o9 の音符を使う曲だけ FME7 の表を120音にする)ので o9b(119)に寄せ、
          //   さらに FME7 で元と同じく超音波になる周期(AY周期の半分、最低1。FME7 は内部で /2 するため)を
          //   fme7TopPeriod に控える。kss2mml/converter.js が D で o9b の周期からそこまで上げる(D が使えない
          //   借用先・D=OFF のときは o9b=約14kHz のまま)。以前の o9c は FME7 で 7990Hz の聞こえる高音になり、
          //   打楽器の頭に「キン」という金属音が乗っていた(Metal Gear 2 曲153 のバスドラ。元曲は AY 周期1=約112kHz)
          if (note === null && freqHz > 0 && MML.Convert.noteToFreq && freqHz > MML.Convert.noteToFreq(119)) {
            const top = MML.Convert.noteToFreq(119);
            freqHz = top; note = 119; seqPeriod = Math.max(1, Math.round(clock / (32 * top)));
          }
        }
      }
      const mode_ = effMode; // 以降(イベント分割・@<n>出力)は実効モードで判断する
      const noise = mode_ === 3 ? t.noisePeriod : null; // @3のみN<n>を出す
      // エンベロープ関連のフィールド。使わない音符は全部 undefined にしておく(pitch.js の統合キー
      // HYSTERESIS_HARD_KEYS に envUsed/envShape/envPeriod/envKey があり、値が違うと統合されない)
      const envFields = envUsed ? { envUsed: true, envShape: t.envShape, envPeriod: t.envPeriod, envKey } : {};
      const mk = (tie) => Object.assign({ note, mode: mode_, noise, freqHz, start: f, end: f, volSeq: [volume], pitchSeq: [seqPeriod], tieCandidate: tie }, envFields,
        seqPeriod !== period ? { topClamp: true, fme7TopPeriod: Math.max(1, Math.round(period * 1789773 / (2 * clock))) } : {});
      if (!cur) { cur = mk(false); continue; }
      const envBoundary = envUsed !== !!cur.envUsed ||
        (envUsed && (envKey !== cur.envKey || t.envShape !== cur.envShape || t.envPeriod !== cur.envPeriod));
      const retrigger = note !== null && !envUsed && volume > cur.volSeq[cur.volSeq.length - 1];
      if (retrigger || envBoundary || note !== cur.note || mode_ !== cur.mode || noise !== cur.noise) {
        // 音量ジャンプ(再アタック推定)が無く、純粋に音程だけが変わった場合はスラー分割の
        // タイ候補とする(src/convert/pitch.js markSlurTies参照。AYには専用アタック
        // レジスタが無いためretrigger推定(音量上昇)を「実アタックの代用」として使う)
        const pureNoteChange = !retrigger && !envBoundary && note !== cur.note && mode_ === cur.mode && noise === cur.noise;
        flush(f);
        cur = mk(pureNoteChange);
      } else {
        cur.volSeq.push(volume);
        cur.pitchSeq.push(seqPeriod);
      }
    }
    flush(timeline.length);
    resampleEvents(events, timeline.traces, chIndex);
    return events;
  }

  // ── 1つのハードウェアエンベロープの中で音程だけが刻まれる打楽器(タム/バスドラの下降)を1音+EN へ(2026-09-19) ──
  // 抽出は「音程が変わったら別の音符」なので、reg13 を1回書いただけで 1 フレームずつ音程を下げるタム
  // (Salamander 曲29: g→d→b→a を各1フレーム)が4つの音符に割れる。借用先 FME-7 の S<n> は音符ごとに形状 R13 を
  // 書き直す(=エンベロープの位相リセット、compiler.js segmentsToWriteLogFme7 / ppmckDriver.js。キーオン相当)ので、
  // 元は1回だけの減衰が音符の数だけ頭から打ち直され、打楽器が長く大きく鳴り、打点も増えて聞こえていた
  // (実測: Salamander 曲29 の X で元の打ち直し 160 回 → 変換後 355 回)。
  // 異音程のタイ(&)は本家 ppmck に無い([[ppmck-ampersand-is-length-add]])ので、本家にある EN<n>(ノート番号の
  // 累積差分、ループ無し=最後の値で止まる)で1音にまとめる。半音未満のずれ(D)は捨てる(打楽器の下降なので近似で足りる)。
  // 対象は「同じ位相リセット(envKey)・同じ形状/周期・同じミキサー(トーン系)・隙間無し」で、最後以外の音符が
  // HW_SWEEP_STEP_MAX フレーム以下の連なりだけ(1つのエンベロープの上でゆっくり旋律を弾く曲を1音にしないため)
  const HW_SWEEP_STEP_MAX = 3;
  function mergeHwEnvSweeps(events) {
    const out = [];
    const sameEnv = (a, b) => a.envUsed && b.envUsed && a.envKey === b.envKey && a.envShape === b.envShape &&
      a.envPeriod === b.envPeriod && a.mode === b.mode && a.noise === b.noise && a.end === b.start;
    for (let i = 0; i < events.length; i++) {
      const head = events[i];
      if (head.note == null || !head.envUsed || !(head.mode & 1) || head.end - head.start > HW_SWEEP_STEP_MAX) { out.push(head); continue; }
      let j = i + 1;
      while (j < events.length && events[j].note != null && sameEnv(events[j - 1], events[j]) &&
        events[j].note !== events[j - 1].note) {
        j++;
        if (events[j - 1].end - events[j - 1].start > HW_SWEEP_STEP_MAX) break; // 長い音符は連なりの最後にだけ置ける
      }
      const run = events.slice(i, j);
      const values = [];
      for (let k = 0; k < run.length; k++) {
        values.push(k === 0 ? 0 : run[k].note - run[k - 1].note);
        if (k < run.length - 1) for (let f = run[k].start + 1; f < run[k].end; f++) values.push(0);
      }
      if (run.length < 2 || values.some(v => v < -127 || v > 126)) { out.push(head); continue; }
      // 末尾に 0 を足す: 本家 ppmckc は「|」の無い表でも最後の1値の前へループ点を置く(datamake.c checkLoop)ので、
      // 最後が -2 だと本家では毎フレーム -2 ずつ下がり続ける。0 で終われば本家でもそこで止まる(本ツールは元々止まる)
      values.push(0);
      const last = run[run.length - 1];
      out.push(Object.assign({}, head, {
        end: last.end,
        volSeq: [].concat(...run.map(e => e.volSeq)),
        pitchSeq: [], // 音程の動きは EN で表す(EP の検出に回さない。mergeRapidArpeggio と同じ)
        noteEnvTable: { values, loop: null }
      }));
      i = j - 1;
    }
    return out;
  }

  // opts.frameRate: 書込みログのフレームレート(省略時60。ハードウェアエンベロープの減衰計算にだけ使う)
  MML.Kss2MmlExpansion.ay = function (writeLog, totalFrames, clock, envReg, opts) {
    const frameRate = (opts && opts.frameRate) || 60;
    // opts.hwEnvSweepEN: mergeHwEnvSweeps を使う(EN を出せるときだけ。呼び出し元が ev.noteEnvTable を @EN へ登録する)
    const hwSweep = (opts && opts.hwEnvSweepEN) ? mergeHwEnvSweeps : (evs => evs);
    const timeline = buildTimeline(writeLog, clock);
    // 楽器化(2026-09-08): 減衰の終わり(サステイン後の急な落ち)を印無しで切り出して @vr(リリース表)へ
    // (MML.Convert.EnvelopeRegistry.volumeFieldsWithRelease、src/convert/envelope.js detectRelease)。
    // 返る keyOffAt/releaseTailLast は applyNoteEnd 冒頭の applyReleaseSplits が音符の終端へ反映する
    function toVolumeFields(volSeq) {
      if (!envReg) return { volume: MML.Convert.plainVolume(volSeq) };
      return envReg.volumeFieldsWithRelease ? envReg.volumeFieldsWithRelease(volSeq)
        : (() => { const idx = envReg.assign(volSeq); return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx }; })();
    }
    // pitchEp(EP<n>参照)は借用先(FME7)の生レジスタ空間への変換が必要なため、ここでは
    // 付けずev.freqSeq(Hz)だけ残し、呼び出し元のkss2mml/converter.jsが
    // MML.Convert.rescalePitchSeqFromFreqで変換してから登録する(DESIGN-PITCH.md Phase 1、
    // src/convert/pitch.js冒頭コメント参照)。
    // ハードウェアエンベロープの音符: FME-7 の S<n>/M<n>(周期は FME-7 の clock へ写す)。volume は
    // S/M を出せないとき(ENV=OFF、FME-7 以外の借用先)の代わり(減衰の最大値=固定音量)
    function toHwEnvFields(ev) {
      return { fme7EnvShape: ev.envShape, fme7EnvPeriod: toFme7Period(ev.envPeriod, clock, 0xFFFF), volume: MML.Convert.plainVolume(ev.volSeq) };
    }
    // ノート番号(@2)と N<n>(@3)のノイズ周期は FME-7 の周期へ写す(冒頭コメントの★)。
    // 抽出中(分節の判定)は元の周期のまま持ち、ここで一度だけ変換する
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note !== null && ev.mode === 2 ? toFme7Period(ev.note, clock, 31) : ev.note, tieCandidate: ev.tieCandidate },
      ev.note !== null ? { instrument: ev.mode } : {},
      ev.note !== null && ev.noise !== null ? { fme7Noise: toFme7Period(ev.noise, clock, 31) } : {},
      // ピアノロール専用の疑似音程(0-15、C1〜D#2)。MML側のノート番号(=ノイズ周期、
      // ppmckのFME-7 @2仕様)はそのまま note に残し、表示だけこちらを使う
      // (src/audio/roll-builders.js の toNotes 参照)。MML変換はこのフィールドを見ない。
      ev.note !== null && ev.mode === 2
        ? { noiseRollIndex: noiseFreqToRollIndex(noiseFreq(ev.note, clock)) } : {},
      ev.note !== null && ev.freqHz != null
        ? { rawFreq: ev.freqHz, freqSeq: ev.pitchSeq.map(p => toneFreq(p, clock)) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      ev.noteEnvTable ? { noteEnvTable: ev.noteEnvTable } : {}, // mergeHwEnvSweeps(呼び出し元が @EN へ登録する)
      // 超音波を o9b へ寄せた音符: FME7 で元と同じ超音波にする周期(kss2mml/converter.js が D で合わせる)
      ev.fme7TopPeriod ? { fme7TopPeriod: ev.fme7TopPeriod } : {},
      ev.envUsed ? toHwEnvFields(ev) : toVolumeFields(ev.volSeq)
    );
    return {
      channels: [0, 1, 2].map(ch => ({
        // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2): 半音境界を跨ぐビブラートが
        // 音符連打に化ける問題を、抽出後の後処理パスとして統合する(既存の毎フレーム
        // ループ自体は変えない)+高速アルペジオ→EN統合(2026-08-14)+P-5「不明瞭→EPテーブル」側(2026-08-12)
        events: MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(hwSweep(extractToneEvents(timeline, ch, clock, frameRate)))).map(toCommon),
        hasVolume: true, hasEnvelope: true, hasInstrument: true, hasFme7Noise: true, hasFme7Env: true
      }))
    };
  };
})(window);
