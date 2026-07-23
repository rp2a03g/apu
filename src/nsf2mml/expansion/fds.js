/*
 * FDS拡張音源(波形メモリ音源) → MML共通イベント形式 抽出
 * MML.Nsf2MmlExpansion.fds(writeLog, totalFrames, envReg, waveReg, initRegs) → { channels: [...], fdsWave }
 *
 * レジスタ: $4082=周波数下位, $4083=bits0-3周波数上位+bit6=エンベロープ停止+bit7=無効(1)/有効(0),
 *   $4080=音量エンベロープ(bit7=1で直接指定モード、bit6=方向(1=増加)、bits0-5は直接モード時は
 *   ゲイン(0-63)、エンベロープモード時は速度)。$408A=エンベロープ用マスタ速度(0=最速)。
 *   波形は $4040-$407F の64byte(6bit)。
 *   ★注意: bit7=1が「直接指定モード」、bit7=0が「エンベロープモード」(NESdev FDS audio準拠。
 *   以前の実装はこの判定が反転しており、直接モードの音符が常時音量15固定になっていた)。
 * アタック合図: $4083書き込み(コンパイラは毎ノート必ず書く。bit7の1→0がノートオン)。
 * 波形はフレーム毎にスナップショットを取り、変化があれば別ノートとして区切って
 * waveReg(WaveRegistry、曲全体で共有・重複排除)に登録し、@<n>(instrument)で選択する
 * (@FM<n>={64値}としてMML本文に埋め込まれ、compiler.js側は元々対応済み)。
 *
 * ハードウェア音量エンベロープ(bit7=0)は2A03と違い増加も減少もでき、ノートオンでリセット
 * されず全曲を通して連続的に進行する(内部ゲイン0-32)。src/emulator/expansion/fds.jsの
 * FDSAudio._clockEnvelopeと同じ2段カウンタ(envRateClock→volEnvTimer、周期
 * c=8*(envRate+1)*(envSpeed+1) CPUサイクル)をbuildTimeline側でCPUサイクル精度のまま
 * 丸ごとシミュレートし、実測されたフレーム毎ゲイン値をenvReg(EnvelopeRegistry)へ
 * 「ハードウェア由来」(100番台)として登録する。direct/envelopeどちらのモードでも音量の
 * 変化だけではノートを区切らずvolSeqに積み、モードが切り替わった時、またはエンベロープ
 * モード中に$4080へ再度書き込まれた時(実機はどんな値でもタイマーをリセットするため)だけ
 * 区切る。
 *
 * ピッチ変調(モジュレーションユニット): $4084=ゲイン(bit7=1で直接指定、bits0-5)、
 * $4085=カウンタ直接設定(未使用・抽出対象外)、$4086/$4087=周波数(bit7=1で停止/
 * テーブル書込み許可)、$4088=モジュレータテーブル(停止中のみ1エントリ3bitずつ
 * 書き込み、位置は$4087書込みで0にリセット)。$4088は同一アドレスへ32回書き込まれる
 * ため、initRegs(最終値スナップショット)では最後の1エントリしか復元できず、
 * initWrites(INIT実行中の全書き込みを順序付き記録したもの)を再生してテーブル全体を
 * 復元する(src/nsf2mml/expansion/vrc7.jsの間接アドレッシング復元と同じ理由)。
 * (freq,depth,waveform)の組が変化した区間をMH<n>(@MH<n>で定義、@MW<n>がテーブル本体)
 * として抽出し、MML.Convert.WaveRegistryをモジュレータテーブル用に、簡易辞書登録を
 * パラメータ用にそれぞれ曲全体で共有登録する。ゲイン/周波数どちらかが0、または
 * モジュレーション停止中はMHOF相当('off')として扱う。曲中一度もモジュレーションを
 * 使わない場合はfdsMod自体を出力せず(既存曲の出力に影響を与えない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Nsf2MmlExpansion = MML.Nsf2MmlExpansion || {};

  const CPU_CLOCK = 1789773;
  const FPS = 60.0988;

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }
  function fdsFreq(period) { return (period * CPU_CLOCK) / (65536 * 64); }

  // モジュレータテーブル($4088、32エントリ×3bit)はINIT中に同一アドレスへ32回
  // 書き込まれるため、initRegsの最終値スナップショットでは復元できない。initWrites
  // (順序付き全書込みログ)を実機と同じ規約(停止中のみ書込み許可・$4087書込みで
  // 書込位置0にリセット)で再生して初期テーブル内容を復元する。
  function reconstructInitModTable(initWrites) {
    const table = new Uint8Array(32);
    let enabled = false;
    let writePos = 0;
    for (const { addr, value } of (initWrites || [])) {
      if (addr === 0x4087) {
        enabled = (value & 0x80) === 0;
        if (!enabled) writePos = 0;
      } else if (addr === 0x4088) {
        if (!enabled) { table[writePos] = value & 0x07; writePos = (writePos + 1) & 0x1F; }
      }
    }
    return table;
  }

  // initRegs(INIT実行後・PLAY開始前のレジスタ状態スナップショット)から初期状態を
  // 復元する。波形や$4080/$408Aを曲中一度もPLAY側で書き換えず、INIT時の1回だけ設定する
  // 曲(3D Hot Rallyで実際に確認)があるため、これが無いと波形/エンベロープが常に
  // 初期値(全0/直接モードgain=32)のまま検出されてしまう。
  function buildTimeline(writeLog, initRegs, initWrites) {
    const ir = initRegs || {};
    let freqLo = ir[0x4082] !== undefined ? ir[0x4082] : 0;
    let freqHiReg = ir[0x4083] !== undefined ? ir[0x4083] : 0;
    const wave = new Uint8Array(64);
    for (let i = 0; i < 64; i++) if (ir[0x4040 + i] !== undefined) wave[i] = ir[0x4040 + i] & 0x3F;
    let lastWaveKey = wave.join(',');

    // モジュレーションユニットの状態(freq/gainは単一アドレスなのでinitRegsで足りるが、
    // テーブルだけはinitWritesの再生結果を使う)
    let modFreq = (ir[0x4086] !== undefined ? ir[0x4086] : 0) |
                  ((ir[0x4087] !== undefined ? (ir[0x4087] & 0x0F) : 0) << 8);
    let modEnabled = ir[0x4087] !== undefined ? (ir[0x4087] & 0x80) === 0 : false;
    let modGain = (ir[0x4084] !== undefined && (ir[0x4084] & 0x80)) ? (ir[0x4084] & 0x3F) : 0;
    const modTable = reconstructInitModTable(initWrites);
    let modWritePos = 0;

    // ボリュームエンベロープの連続シミュレーション状態
    // (src/emulator/expansion/fds.js FDSAudioのフィールドと同じ意味・同じ初期値)
    let volGain = 32;
    let volEnvEnabled = false;
    let volEnvIncrease = false;
    let volEnvSpeed = 0;
    let envHalt = (freqHiReg & 0x40) !== 0;
    let envRate = ir[0x408A] !== undefined ? ir[0x408A] : 0xE8; // 実機電源ON時のデフォルト
    let envRateClock = 0;
    let volEnvTimer = 0;
    if (ir[0x4080] !== undefined) {
      const v = ir[0x4080];
      if (v & 0x80) { volGain = v & 0x3F; }
      else { volEnvEnabled = true; volEnvIncrease = (v & 0x40) !== 0; volEnvSpeed = v & 0x3F; volEnvTimer = volEnvSpeed + 1; }
    }
    let cycleAccum = 0;
    let lastCyclesInt = 0;
    const CYCLES_PER_FRAME = CPU_CLOCK / FPS;

    // elapsed(CPUサイクル数)分だけ2段カウンタを進める。飽和(0または32到達)したら
    // それ以上進めても無意味なので打ち切る(曲全体を通しても計算量は音量ステップ数
    // =最大32回分に収まる)。
    function advanceEnvelope(elapsed) {
      if (!volEnvEnabled || envHalt) return;
      if (volEnvIncrease ? volGain >= 32 : volGain <= 0) return;
      const envPeriod = (envRate + 1) * 8;
      envRateClock += elapsed;
      while (envRateClock >= envPeriod) {
        envRateClock -= envPeriod;
        volEnvTimer--;
        if (volEnvTimer <= 0) {
          volEnvTimer = volEnvSpeed + 1;
          if (volEnvIncrease) {
            if (volGain < 32) volGain++; else break;
          } else {
            if (volGain > 0) volGain--; else break;
          }
        }
      }
    }

    return writeLog.map(writes => {
      // このフレームの書き込みを先に適用してから、その後でこのフレーム分のサイクルだけ
      // エンベロープを進める(2A03ハードウェアエンベロープ(simulateHwEnvelope)と同じ規約:
      // 「レジスタ書き込みはフレームの先頭で起こり、そのフレーム分のクロックはその後に
      // 効いてくる」)。
      let attack = false;
      let waveChanged = false;
      let envRestart = false; // このフレームで$4080がエンベロープモードとして書かれたか
      for (const { addr, value } of writes) {
        if      (addr === 0x4082) freqLo = value;
        else if (addr === 0x4083) {
          freqHiReg = value;
          attack = true;
          envHalt = (value & 0x40) !== 0;
        } else if (addr === 0x4080) {
          if (value & 0x80) {
            // 直接指定モード(bit7=1): bits0-5をゲインとして即時反映
            volEnvEnabled = false;
            volGain = value & 0x3F;
          } else {
            // エンベロープモード(bit7=0): 実機はどんな値でもタイマーをリセットする
            volEnvEnabled = true;
            volEnvIncrease = (value & 0x40) !== 0;
            volEnvSpeed = value & 0x3F;
            volEnvTimer = volEnvSpeed + 1;
            envRestart = true;
          }
        } else if (addr === 0x408A) {
          envRate = value;
          envRateClock = 0;
        } else if (addr >= 0x4040 && addr <= 0x407F) {
          wave[addr - 0x4040] = value & 0x3F;
          waveChanged = true;
        } else if (addr === 0x4084) {
          if (value & 0x80) modGain = value & 0x3F;
          // エンベロープモード(bit7=0)のモジュレータゲインは抽出非対応(直接指定のみMH化)
        } else if (addr === 0x4086) {
          modFreq = (modFreq & 0x0F00) | value;
        } else if (addr === 0x4087) {
          modFreq = (modFreq & 0x00FF) | ((value & 0x0F) << 8);
          modEnabled = (value & 0x80) === 0;
          if (!modEnabled) modWritePos = 0;
        } else if (addr === 0x4088) {
          if (!modEnabled) { modTable[modWritePos] = value & 0x07; modWritePos = (modWritePos + 1) & 0x1F; }
        }
      }
      let waveKey = lastWaveKey;
      if (waveChanged) { waveKey = wave.join(','); lastWaveKey = waveKey; }
      const modTableKey = modTable.join(',');

      cycleAccum += CYCLES_PER_FRAME;
      const nowInt = Math.floor(cycleAccum);
      advanceEnvelope(nowInt - lastCyclesInt);
      lastCyclesInt = nowInt;

      return {
        freqLo, freqHiReg, attack, wave: Array.from(wave), waveKey,
        envEnabled: volEnvEnabled, envRestart, gain: volGain,
        modFreq, modGain, modEnabled, modTable: Array.from(modTable), modTableKey
      };
    });
  }

  // ピッチ/波形/モードが同じ間は音量変化だけでは区切らずvolSeqに積む
  // (ソフトウェア音量エンベロープ抽出用。src/nsf2mml/converter.jsのパルス抽出と同じ考え方)。
  // モードが切り替わった時、またはエンベロープモード中に$4080が再度書かれた時だけ区切る。
  function extractEvents(timeline) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    function begin(f, note, volume, envEnabled, wave, waveKey, t) {
      cur = {
        note, envEnabled, wave, waveKey, start: f, end: f, volSeq: [volume],
        modFreq: t.modFreq, modGain: t.modGain, modEnabled: t.modEnabled, modTable: t.modTable,
        modKey: `${t.modEnabled ? 1 : 0}|${t.modFreq}|${t.modGain}|${t.modTableKey}`
      };
    }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const period    = t.freqLo | ((t.freqHiReg & 0x0F) << 8);
      const disabled  = !!(t.freqHiReg & 0x80);
      const volume    = Math.max(0, Math.min(15, Math.round(t.gain / 2)));
      const note = (!disabled && period > 0) ? freqToNoteNumber(fdsFreq(period)) : null;
      const modKey = `${t.modEnabled ? 1 : 0}|${t.modFreq}|${t.modGain}|${t.modTableKey}`;

      if (!cur) { begin(f, note, volume, t.envEnabled, t.wave, t.waveKey, t); continue; }

      if (t.attack || note !== cur.note || t.waveKey !== cur.waveKey ||
          t.envEnabled !== cur.envEnabled || (t.envEnabled && t.envRestart) || modKey !== cur.modKey) {
        flush(f);
        begin(f, note, volume, t.envEnabled, t.wave, t.waveKey, t);
      } else {
        cur.volSeq.push(volume);
      }
    }
    flush(timeline.length);
    return events;
  }

  // (freq, depth, waveform)の組を曲全体で重複排除して登録する簡易レジストリ。
  // @MH<n> = { delay, freq, depth, waveform } (delayは抽出時は常に0、正確な
  // フレーム位置に直接イベントを置くため不要)。
  function makeModParamRegistry() {
    const list = [];
    const keyToIndex = new Map();
    return {
      assign(freq, depth, waveform) {
        const key = `${freq}|${depth}|${waveform}`;
        let idx = keyToIndex.get(key);
        if (idx === undefined) {
          idx = list.length;
          keyToIndex.set(key, idx);
          list.push({ freq, depth, waveform });
        }
        return idx;
      },
      defLines() {
        return list.map((p, i) => `@MH${i} = { 0, ${p.freq}, ${p.depth}, ${p.waveform} }`);
      }
    };
  }

  MML.Nsf2MmlExpansion.fds = function (writeLog, totalFrames, envReg, waveReg, initRegs, initWrites) {
    const timeline = buildTimeline(writeLog, initRegs, initWrites);
    const events = extractEvents(timeline);

    const modWaveReg = new MML.Convert.WaveRegistry('@MW');
    const modParamReg = makeModParamRegistry();
    const modUsed = events.some(ev =>
      ev.note !== null && ev.modEnabled && ev.modGain > 0 && ev.modFreq > 0);
    function toModField(ev) {
      if (!ev.modEnabled || ev.modGain <= 0 || ev.modFreq <= 0) return 'off';
      const waveform = modWaveReg.assign(ev.modTable);
      return modParamReg.assign(ev.modFreq, ev.modGain, waveform);
    }

    function toVolumeFields(ev) {
      if (ev.envEnabled) {
        // ハードウェアエンベロープのシミュレート結果。同じ形が曲中に何度も出るとは
        // 限らないため実測(analyzeVolumeShape)して、100番台(ハードウェア由来)に登録する
        const shape = MML.Convert.analyzeVolumeShape(ev.volSeq);
        const idx = envReg ? envReg.registerShape(shape, true) : null;
        return idx == null ? { volume: ev.volSeq[0] } : { envelopeV: idx };
      }
      const idx = envReg ? envReg.assign(ev.volSeq) : null;
      return idx == null ? { volume: ev.volSeq[0] } : { envelopeV: idx };
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note },
      ev.note !== null ? Object.assign(
        { instrument: waveReg ? waveReg.assign(ev.wave) : 0 },
        toVolumeFields(ev),
        modUsed ? { fdsMod: toModField(ev) } : {}
      ) : {}
    );

    return {
      channels: [
        {
          letter: 'E', events: events.map(toCommon), hasVolume: true, hasEnvelope: true,
          hasInstrument: true, hasFdsMod: modUsed
        },
      ],
      fdsWave: timeline.length > 0 ? timeline[timeline.length - 1].wave : null,
      fdsModDefLines: modUsed ? [...modWaveReg.defLines(), ...modParamReg.defLines()] : []
    };
  };

  // デバッグ/テスト用: 実機エミュレータ(src/emulator/expansion/fds.js)とのクロス検証で
  // 内部シミュレーションを直接叩けるようにする(通常利用では不要)
  MML.Nsf2MmlExpansion._fdsBuildTimeline = buildTimeline;

})(window);
