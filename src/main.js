/*
 * Phase 1 動作確認UI
 * - 6502アセンブラのテスト（アセンブル結果・シンボルテーブル・エラー表示）
 * - NSFヘッダ情報入力 → NSFバイナリ生成・ダウンロード
 */
(function () {
  // 表示文言の翻訳(src/i18n/i18n.js)。キーは日本語の原文そのもの
  const T = (key, params) => MML.I18n.t(key, params);

  const mmlSourceEl = document.getElementById('mmlSource');
  const mmlOutputEl = document.getElementById('mmlOutput');
  mmlSourceEl.value = MML.Mml.SAMPLE_SOURCE;

  // --- Phase 6: シンタックスハイライト & 波形エディタ ---
  const mmlHighlightEl = document.getElementById('mmlHighlight');
  // srcStart(絶対文字位置) -> DOM要素。再生ハイライト機能が対象spanをO(1)で引くための索引で、
  // オーバーレイのHTMLが変わるたび(attachHighlighterのonUpdate経由で)再構築する
  let mmlHighlightIndex = new Map();
  let mmlHighlightIndexGen = 0; // オーバーレイHTMLが作り直されるたびに増える(追随スクロールの位置キャッシュ無効化用)
  MML.Mml.attachHighlighter(mmlSourceEl, mmlHighlightEl, () => {
    mmlHighlightIndex = MML.Mml.buildOffsetIndex(mmlHighlightEl);
    mmlHighlightIndexGen++;
  });
  // ウィンドウ幅が変わると行の折り返しが変わり要素のoffsetTopもずれるため、位置キャッシュを無効化する
  window.addEventListener('resize', () => { mmlHighlightIndexGen++; });

  // --- MML再生連動ハイライト・追随スクロールのコントロール ---
  const mmlHighlightEnableEl = document.getElementById('mmlHighlightEnable');
  const mmlAutoScrollEnableEl = document.getElementById('mmlAutoScrollEnable');
  const mmlFollowChannelEl = document.getElementById('mmlFollowChannel');
  mmlAutoScrollEnableEl.addEventListener('change', () => { mmlHighlightLastFollowSrc = -1; });
  mmlFollowChannelEl.addEventListener('change', () => { mmlHighlightLastFollowSrc = -1; });
  mmlHighlightEnableEl.addEventListener('change', () => { updateMmlRangeHighlight(); });

  // --- フローティングウィンドウ（位置・サイズ・表示状態を記憶） ---
  MML.FloatingWindows.init();
  MML.FloatingWindows.initSplitters();
  MML.UI.FdsWaveEditor.init(mmlSourceEl);
  MML.UI.N163WaveEditor.init(mmlSourceEl);

  // MML.Mml.compile()のresult.expansionsは'dpcm'を含みうる(チャンネル文字割当等の
  // 内部処理で拡張音源と同じ優先順位機構を借用しているため)。しかしDPCMは2A03内蔵
  // 機能であり、VRC6/FDS等のカートリッジ側拡張チップとは性質が異なる(実機にDPCMを
  // 「載せるか選ぶ」という概念自体が無い)ため、ユーザー向け表示では拡張音源として
  // 数えない。機能的な配列自体(result.expansions)は変更せず表示時にだけ除外する
  function displayExpansions(list) {
    return (list || []).filter(name => name !== 'dpcm');
  }


  // extraChips フラグから拡張音源名の配列に変換する
  function chipsFromExtraFlags(flags) {
    const names = [];
    if (flags & MML.NSF.CHIP_FLAGS.VRC6) names.push('vrc6');
    if (flags & MML.NSF.CHIP_FLAGS.VRC7) names.push('vrc7');
    if (flags & MML.NSF.CHIP_FLAGS.FDS) names.push('fds');
    if (flags & MML.NSF.CHIP_FLAGS.MMC5) names.push('mmc5');
    if (flags & MML.NSF.CHIP_FLAGS.N163) names.push('n163');
    if (flags & MML.NSF.CHIP_FLAGS.FME7) names.push('fme7');
    return names;
  }

  // レジスタアドレスから所属音源チップ名を返す（ログ注記用）
  function regChipName(addr) {
    if (addr >= 0x4000 && addr <= 0x4017) return '2A03';
    if (addr === 0x4023 || (addr >= 0x4040 && addr <= 0x408A)) return 'FDS';
    if ((addr >= 0x9000 && addr <= 0x9002) || (addr >= 0xA000 && addr <= 0xA002) || (addr >= 0xB000 && addr <= 0xB002)) return 'VRC6';
    if (addr === 0x9010 || addr === 0x9030) return 'VRC7';
    if (addr >= 0x5000 && addr <= 0x5015) return 'MMC5';
    if (addr === 0xF800 || addr === 0x4800) return 'N163';
    if (addr === 0xC000 || addr === 0xE000) return 'FME7';
    return '';
  }

  // 鍵盤表示のチェックボックス状態からミュート設定を取得する
  function getChannelMuteConfig() {
    return keyboardDisplay.getMuteConfig();
  }

  // ミュート変更 → ストリーミング再生中は即時反映、それ以外は再レンダリング
  function scheduleRerenderOnMute() {
    if (activePlayer) {
      activePlayer.applyMute(getChannelMuteConfig());
      return;
    }
    if (kssActivePlayer) {
      kssActivePlayer.applyMute(getChannelMuteConfig());
      return;
    }
    if (gbsActivePlayer) {
      gbsActivePlayer.applyMute(getChannelMuteConfig());
      return;
    }
    if (hesActivePlayer) {
      hesActivePlayer.applyMute(getChannelMuteConfig());
      return;
    }
    // MML / NSF Worklet 再生中は上記のいずれかで即時反映されるため、
    // 非再生中はミュート設定を変えても再レンダリングは不要
  }

  function toHex(n, digits) {
    return '$' + n.toString(16).toUpperCase().padStart(digits, '0');
  }

  function hexDump(bytes, baseAddr) {
    let lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const addr = toHex((baseAddr + i) & 0xFFFF, 4);
      const chunk = Array.from(bytes.slice(i, i + 16));
      const hex = chunk.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      lines.push(`${addr}: ${hex}`);
    }
    return lines.join('\n');
  }

  function toBin(n, digits) {
    return '%' + (n >>> 0).toString(2).padStart(digits, '0');
  }

  // --- レジスタ/メモリ モニタ（リアルタイム表示） ---
  const cpuRegMonitorEl = document.getElementById('cpuRegMonitor');
  const soundRegMonitorEl = document.getElementById('soundRegMonitor');
  const memMonitorEl = document.getElementById('memMonitor');

  // --- 鍵盤表示 ---
  const keyboardDisplay = new MML.UI.KeyboardDisplay(document.getElementById('keyboardDisplay'));
  keyboardDisplay.onMuteChange = () => {
    scheduleRerenderOnMute();
    mmlHighlightLastFrame = -1; // ミュート変更を即座にハイライト表示へ反映させる
    updateMmlRangeHighlight();
  };
  // 起動時から APU チャンネル行を表示（再生前でも空白にならないよう）
  keyboardDisplay.setSource({ regSnapshots: [{}], totalFrames: 1, samplesPerFrame: 735, sampleRate: 44100 }, []);

  // --- 再生速度(1/1〜1/8。音程を保ったままテンポだけ落とす) ---
  // 現在アクティブなプレイヤー(MML/NSF/SPCのいずれか)に速度を適用し、
  // 曲を読み込み直した時にも直前の設定を引き継げるよう値を保持しておく。
  let currentSpeedFactor = 1;
  keyboardDisplay.onSpeedChange = (factor) => {
    currentSpeedFactor = factor;
    if (activePlayer && activePlayer.setSpeed) {
      activePlayer.setSpeed(factor);
      if (lastPlayMode === 'capture-mml' || lastPlayMode === 'nsf') workletDuration = activePlayer.getDuration();
    }
    if (spcActivePlayer && spcActivePlayer.setSpeed) {
      spcActivePlayer.setSpeed(factor);
      if (lastPlayMode === 'spc') workletDuration = spcActivePlayer.getDuration();
    }
    if (kssActivePlayer && kssActivePlayer.setSpeed) {
      kssActivePlayer.setSpeed(factor);
      if (lastPlayMode === 'kss') workletDuration = kssActivePlayer.getDuration();
    }
    if (gbsActivePlayer && gbsActivePlayer.setSpeed) {
      gbsActivePlayer.setSpeed(factor);
      if (lastPlayMode === 'gbs') workletDuration = gbsActivePlayer.getDuration();
    }
    if (hesActivePlayer && hesActivePlayer.setSpeed) {
      hesActivePlayer.setSpeed(factor);
      if (lastPlayMode === 'hes') workletDuration = hesActivePlayer.getDuration();
    }
  };

  let monitorState = null;

  // ピアノロールの先読みキャプチャは非同期で走るため、曲切替/停止で古い結果を
  // 反映しないよう世代トークンで無効化する(NSF実ファイル再生・SPC・KSSの3経路)。
  let nsfRollToken = 0;
  let spcRollToken = 0;
  let kssRollToken = 0;
  let gbsRollToken = 0;
  let hesRollToken = 0;

  // NSF/SPC/KSSの先読みキャプチャは再生を止めても最後まで走り続けようとするため、
  // 「別のフォーマットの再生/変換を始めたのに、前のフォーマットの先読みが
  // keyboardDisplay.setRollTimeline() を上書きし続ける」という取り違えが起きる
  // (KSS再生中にMML変換→MML再生すると、MMLのロールがKSSのロールで塗り潰される)。
  // 他フォーマットの再生を開始する側は必ずこれを呼んで、走っている先読みを無効化する。
  function invalidateOtherRollPrefetch(keep) {
    if (keep !== 'nsf') nsfRollToken++;
    if (keep !== 'spc') spcRollToken++;
    if (keep !== 'kss') kssRollToken++;
    if (keep !== 'gbs') gbsRollToken++;
    if (keep !== 'hes') hesRollToken++;
  }

  // リアルタイム再生(ScriptProcessorNode・メインスレッドAPU)中の
  // 現在のエンベロープ実出力を返す。MML/NSFどちらのストリームプレイヤーにも対応。
  function liveApuEnv() {
    const p = activePlayer;
    if (!p) return null;
    const apu = p.apu || (p.player && p.player.apu);
    if (!apu) return null;
    // FDSの実ゲインも読む: NSF=bus.expansion.fds / MML=expansionAudio
    let fds = null;
    if (p.player && p.player.bus && p.player.bus.expansion) fds = p.player.bus.expansion.fds || null;
    else if (p.expansionMap) fds = p.expansionMap.fds || null;
    // DPCMサンプル読み出し用のバス。NSF実ファイル再生はp.player.bus、
    // MML再生(MmlStreamPlayer)はp.dpcmBusにそれぞれ保持されている
    const bus = (p.player && p.player.bus) || p.dpcmBus || null;
    return MML.Emu.snapshotApuEnv(apu, fds, bus);
  }

  // リアルタイム再生中のライブN163状態(128バイトRAM)からスナップショットを作る。
  // 行数を安定させるため numCh の走行最大値(n163MaxCh)を保持し maxNumCh として返す。
  let n163MaxCh = 1;
  function resetN163Max() { n163MaxCh = 1; }
  function liveN163() {
    const p = activePlayer;
    if (!p) return null;
    let n = null;
    if (p.player && p.player.bus && p.player.bus.expansion) n = p.player.bus.expansion.n163 || null;
    else if (p.expansionMap) n = p.expansionMap.n163 || null;
    if (!n) return null;
    const snap = MML.Emu.snapshotN163(n.ram);
    if (snap.numCh > n163MaxCh) n163MaxCh = snap.numCh;
    snap.maxNumCh = n163MaxCh;
    return snap;
  }

  // リアルタイム再生中のライブFME-7チップから3ch分のスナップショットを作る
  // ($C000/$E000ラッチ式のため flat regSnapshot では復元できずライブ必須)。
  function liveFME7() {
    const p = activePlayer;
    if (!p) return null;
    let f = null;
    if (p.player && p.player.bus && p.player.bus.expansion) f = p.player.bus.expansion.fme7 || null;
    else if (p.expansionMap) f = p.expansionMap.fme7 || null;
    if (!f || !MML.Emu.snapshotFME7) return null;
    return MML.Emu.snapshotFME7(f);
  }

  // リアルタイム再生中のライブMMC5チップからスナップショットを作る
  // (エンベロープ実出力・$5011 PCMを反映)。
  function liveMMC5() {
    const p = activePlayer;
    if (!p) return null;
    let m = null;
    if (p.player && p.player.bus && p.player.bus.expansion) m = p.player.bus.expansion.mmc5 || null;
    else if (p.expansionMap) m = p.expansionMap.mmc5 || null;
    if (!m || !MML.Emu.snapshotMMC5) return null;
    return MML.Emu.snapshotMMC5(m);
  }

  // リアルタイム再生中のライブVRC7(OPLL)チップからスナップショットを作る
  // ($9010/$9030ラッチ式で復元不可。周波数/音量/FM波形をライブで反映)。
  function liveVRC7() {
    const p = activePlayer;
    if (!p) return null;
    let v = null;
    if (p.player && p.player.bus && p.player.bus.expansion) v = p.player.bus.expansion.vrc7 || null;
    else if (p.expansionMap) v = p.expansionMap.vrc7 || null;
    if (!v || !MML.Emu.snapshotVRC7) return null;
    return MML.Emu.snapshotVRC7(v);
  }

  // KSS(MSX)再生中のライブPSG/SCC/FMPACスナップショット(鍵盤表示用)
  function liveKssPsg() {
    if (!kssActivePlayer || !kssActivePlayer.player) return null;
    return MML.Emu.snapshotAY8910(kssActivePlayer.player.psg);
  }
  function liveKssScc() {
    if (!kssActivePlayer || !kssActivePlayer.player) return null;
    return MML.Emu.snapshotSCC(kssActivePlayer.player.scc);
  }
  function liveKssOpll() {
    if (!kssActivePlayer || !kssActivePlayer.player || !kssActivePlayer.player.opll) return null;
    return MML.Emu.snapshotOPLL(kssActivePlayer.player.opll);
  }

  // GBS再生中のライブAPUスナップショット(鍵盤表示用)
  function liveGbsApu() {
    if (!gbsActivePlayer || !gbsActivePlayer.apu) return null;
    return MML.Emu.snapshotGbApu(gbsActivePlayer.apu);
  }

  // HES(PC Engine)再生中のライブPSGスナップショット(鍵盤表示用)。HesReplayStreamPlayerは
  // player=this(自己参照)でapuをそのまま持つ(GbsReplayStreamPlayer等と同じ形)。
  // DDAとして扱っているchは、波形メモリ(c.wave)がDDA突入中の内容で固まったまま
  // 更新されず実際のPCM波形と無関係になる(apuHuC6280.js PsgChannel.writeData()参照)ため、
  // hesActivePlayer.getDdaWave()(直近の実際のdac値のリングバッファ)で上書きする。
  // ★ddaChannelは曲全体を通して固定の1ch(extractDdaClips()が曲中で最もDDA区間が
  // 長いchを選ぶ)なので、そのchが曲の一部でだけDDAを使い残りは普通の波形chとして
  // 使われる曲(percussion+melodyの兼任、実測: TP03018.hes index77 ch4)では、DDA区間を
  // 抜けた後もsnap[ddaCh].waveが無条件に上書きされ続け、getDdaWave()のリングバッファに
  // 残った(現在とは無関係な、直近のDDAヒットの)過去データがそのまま鍵盤表示に出続けて
  // いた。DDAヒットが増えるたびリングバッファの中身が入れ替わるため、見た目上は本来の
  // 波形chの表示が「毎回のDDA発音のたびに壊れていく」ように見える(ユーザー報告の
  // 「波形が崩れていく」「変化の際ノイズ出てる」はこの現象)。現在フレームで実際に
  // dda中(snap[ddaCh].dda)の時だけ上書きするよう限定し、通常の波形ch表示に戻す。
  function liveHesApu() {
    if (!hesActivePlayer || !hesActivePlayer.player || !hesActivePlayer.player.apu) return null;
    const snap = MML.Emu.snapshotHuC6280Apu(hesActivePlayer.player.apu);
    const ddaCh = hesActivePlayer.ddaChannel;
    if (ddaCh != null && ddaCh >= 0 && snap[ddaCh] && snap[ddaCh].dda && typeof hesActivePlayer.getDdaWave === 'function') {
      snap[ddaCh] = Object.assign({}, snap[ddaCh], {
        wave: hesActivePlayer.getDdaWave().map(v => v / 15.5 - 1)
      });
    }
    return snap;
  }

  // chips: string[] 例 ['vrc6'] / [] = APUのみ
  function setMonitorSource(result, getPositionSeconds, chips) {
    const addrSet = new Set();
    (result.regSnapshots || []).forEach((snap) => {
      Object.keys(snap).forEach((k) => addrSet.add(Number(k)));
    });
    monitorState = {
      regSnapshots: result.regSnapshots,
      cpuSnapshots: result.cpuSnapshots,
      memSnapshots: result.memSnapshots,
      sampleRate: result.sampleRate,
      samplesPerFrame: result.samplesPerFrame,
      totalFrames: result.totalFrames,
      regAddrs: Array.from(addrSet).sort((a, b) => a - b),
      getPosition: getPositionSeconds
    };
    keyboardDisplay.setSource(result, chips || []);
  }

  function renderMonitor(frameIndex) {
    if (!monitorState) {
      cpuRegMonitorEl.textContent = T('（再生中の情報がありません）');
      soundRegMonitorEl.textContent = T('（再生中の情報がありません）');
      memMonitorEl.textContent = T('（再生中の情報がありません）');
      return;
    }

    const { regSnapshots, cpuSnapshots, memSnapshots, regAddrs } = monitorState;

    // --- CPUレジスタ ---
    if (cpuSnapshots) {
      const cpu = cpuSnapshots[frameIndex];
      const flagNames = 'NV-BDIZC';
      const flagsStr = flagNames.split('').map((name, i) => {
        const bit = (cpu.P >> (7 - i)) & 1;
        return `${name}:${bit}`;
      }).join(' ');
      cpuRegMonitorEl.textContent =
        `A  = ${toHex(cpu.A, 2)}  ${toBin(cpu.A, 8)}\n` +
        `X  = ${toHex(cpu.X, 2)}  ${toBin(cpu.X, 8)}\n` +
        `Y  = ${toHex(cpu.Y, 2)}  ${toBin(cpu.Y, 8)}\n` +
        `S  = ${toHex(cpu.S, 2)}  ${toBin(cpu.S, 8)}\n` +
        `P  = ${toHex(cpu.P, 2)}  ${toBin(cpu.P, 8)}  (${flagsStr})\n` +
        `PC = ${toHex(cpu.PC, 4)} ${toBin(cpu.PC, 16)}`;
    } else {
      cpuRegMonitorEl.textContent = T('（MML再生中はCPUレジスタの情報はありません）');
    }

    // --- サウンドレジスタ ---
    if (regAddrs.length === 0) {
      soundRegMonitorEl.textContent = T('（書き込みがありません）');
    } else {
      const snap = regSnapshots[frameIndex] || {};
      soundRegMonitorEl.textContent = regAddrs.map((addr) => {
        const value = snap[addr] !== undefined ? snap[addr] : 0;
        return `${toHex(addr, 4)} = ${toHex(value, 2)}  ${toBin(value, 8)}`;
      }).join('\n');
    }

    // --- メモリ ($0000-$00FF) ---
    if (memSnapshots) {
      memMonitorEl.textContent = hexDump(memSnapshots[frameIndex], 0);
    } else {
      memMonitorEl.textContent = T('（MML再生中はメモリ情報はありません）');
    }
  }

  // --- MML再生連動ハイライト・追随スクロール ---
  // 「今光っている要素だけclassList付け外し」方式。以前は毎フレーム(60fps)ソース全文を
  // 再トークン化してオーバーレイのinnerHTMLを総入れ替えしており重かったため書き換えた。
  // オーバーレイHTML自体はattachHighlighterのonUpdate(入力/コンパイル時)でのみ再構築し、
  // mmlHighlightIndex(srcStart -> 既存span要素)を通して対象要素をO(1)で引く。
  // 再生中の毎フレーム処理は「対象span数個のclassList操作」のみで、ソース長に依存しない。
  //
  // highlightRanges(compiled.highlightRanges[ch])内で現在フレームを含むレンジを探す際、
  // 前回ヒットしたindexをチャンネルごとにキャッシュし、そこから前後に線形探索する
  // (曲の進行にあわせてindexも単調に進むため、巻き戻し/早送りでも数ステップで収束する)
  let mmlHighlightRangeCache = {}; // channel -> 前回ヒットindex
  let mmlHighlightedElements = new Set(); // 現在.mml-playingを付与中の要素
  let mmlHighlightLastFrame = -1;
  let mmlHighlightLastFollowSrc = -1; // 直近で追随スクロールした対象spanのdata-s(重複防止)
  let mmlHighlightSuppressed = false; // ■停止直後はPlayを押すまでハイライトを出さない
  let mmlRangeHighlightedElements = new Set(); // 現在.mml-range-selectedを付与中の要素（再生範囲=開始点〜終了点の常時表示）
  // .mml-playingはtext-shadow4枚重ねの縁取り付きで、classList操作自体は軽くても
  // ブラウザ側の再描画(ペイント)コストは無視できない。文字数の多いMMLではフレーム毎(60fps)の
  // 描画更新がその分カクつきの原因になるため、見た目の滑らかさを大きく損なわない範囲で
  // 更新頻度を間引く。追随スクロールのgetBoundingClientRect()は強制同期レイアウトを伴い
  // さらに重いので、それとは別によりゆるい間隔で間引く
  // MML再生はScriptProcessorNode(メインスレッド)でオーディオを生成しており(AudioWorkletでは
  // なくメインスレッドを選んだ設計。src/audio/stream-player.js冒頭コメント参照)、ここでのJS処理は
  // オーディオコールバックと同じスレッド/実行キューを取り合う。拡張音源を多く積んだ曲は
  // renderFrame自体が既にバッファ時間(93ms)の大半を使っており、ここでの追加コストが
  // わずかでも録音アンダーラン(音切れ・もたつき)の引き金になり得る。そのため間引き間隔を
  // 長めに取り、かつ毎回のSet/配列の再アロケーションを避けてGCの発生機会自体を減らす
  const MML_HIGHLIGHT_MIN_INTERVAL_MS = 100; // 約10fps上限
  const MML_AUTOSCROLL_MIN_INTERVAL_MS = 200;
  let mmlHighlightLastUpdateTime = 0;
  let mmlAutoScrollLastTime = 0;
  let mmlHighlightGen = 0; // 要素に付ける世代番号(Set再アロケーションなしで差分更新するため)

  function findActiveHighlightRange(ranges, frame, ch) {
    if (!ranges || ranges.length === 0) return null;
    let idx = mmlHighlightRangeCache[ch] || 0;
    if (idx >= ranges.length) idx = ranges.length - 1;
    if (!(ranges[idx].startFrame <= frame && frame < ranges[idx].endFrame)) {
      if (frame < ranges[idx].startFrame) {
        while (idx > 0 && ranges[idx].startFrame > frame) idx--;
      } else {
        while (idx < ranges.length - 1 && ranges[idx].endFrame <= frame) idx++;
      }
    }
    mmlHighlightRangeCache[ch] = idx;
    const r = ranges[idx];
    return (r.startFrame <= frame && frame < r.endFrame) ? r : null;
  }

  // srcStartを起点にmmlHighlightIndexから要素を引き、DOM上を後続span方向へ辿って
  // srcEndまでに収まる要素を集める(タイ"c&d"のように1レンジが複数トークンspanに
  // またがる場合に、間の"&"トークンなども含めて拾う)
  function collectElementsInRange(srcStart, srcEnd) {
    const result = [];
    let el = mmlHighlightIndex.get(srcStart);
    while (el) {
      const s = Number(el.dataset.s);
      if (!(s < srcEnd)) break;
      result.push(el);
      el = el.nextElementSibling;
    }
    return result;
  }

  // collectElementsInRangeと同じ探索だが、配列を新規アロケートせずコールバックで渡す版。
  // updateMmlPlaybackHighlightは毎フレーム(スロットル済みとはいえ)呼ばれ、かつ
  // ScriptProcessorNodeのオーディオコールバックと同じメインスレッドを取り合うため、
  // 無駄なGCの発生機会をできる限り減らす目的でこちらを使う
  function forEachElementInRange(srcStart, srcEnd, cb) {
    let el = mmlHighlightIndex.get(srcStart);
    while (el) {
      const s = Number(el.dataset.s);
      if (!(s < srcEnd)) break;
      cb(el);
      el = el.nextElementSibling;
    }
  }

  // startFrame〜endFrameと重なるレンジをすべて集める(範囲ハイライト用。単一フレームの
  // findActiveHighlightRangeと違い区間全体が対象なので、該当区間の全レンジを線形に拾う)
  function collectHighlightRangesInInterval(ranges, startFrame, endFrame) {
    const result = [];
    if (!ranges) return result;
    for (const r of ranges) {
      if (r.startFrame < endFrame && r.endFrame > startFrame) result.push(r);
    }
    return result;
  }

  // シークバーの開始点(青)〜終了点(赤)ハンドルが示す再生範囲を、再生中かどうかに関わらず
  // 常時ハイライト表示する(.mml-range-selected)。ドラッグ中はハンドル移動のたびに呼ばれ、
  // 「ここからここまで再生される」がMMLエディタ上で視覚的にわかるようにする。
  // 全体(曲頭〜曲末)が選択されている場合は表示しない(全文が光っても意味がないため)。
  function updateMmlRangeHighlight() {
    const compiled = lastMmlCompiled;
    const duration = currentDuration();
    const isPartialRange = rangeEndSec !== null && duration > 0 &&
      (rangeStartSec > 0.001 || rangeEndSec < duration - 0.001);
    const active = mmlHighlightEnableEl.checked && lastPlayMode === 'capture-mml' &&
      compiled && compiled.highlightRanges && isPartialRange;
    if (!active) {
      if (mmlRangeHighlightedElements.size > 0) {
        for (const el of mmlRangeHighlightedElements) el.classList.remove('mml-range-selected');
        mmlRangeHighlightedElements = new Set();
      }
      return;
    }
    const startFrame = Math.max(0, Math.floor(rangeStartSec * compiled.frameRate));
    const endFrame = Math.ceil(rangeEndSec * compiled.frameRate);
    const source = mmlSourceEl.value;
    const nextElements = new Set();
    for (const ch of compiled.channelLetters) {
      if (keyboardDisplay.isChannelMuted(ch)) continue;
      const ranges = collectHighlightRangesInInterval(compiled.highlightRanges[ch], startFrame, endFrame);
      if (ranges.length === 0) continue;
      ranges.sort((a, b) => a.srcStart - b.srcStart);
      // 音符ひとつずつ個別にハイライトすると空白のたびに途切れて見えるため、同じ行内で
      // 隣接するノートはまとめて1つの連続した背景として塗る(改行を挟んだら別ランに
      // 区切る。そうしないと他チャンネルの行を挟んで誤って地続きに塗ってしまう)
      let runStart = ranges[0].srcStart;
      let runEnd = ranges[0].srcEnd;
      const flushRun = () => {
        for (const el of collectElementsInRange(runStart, runEnd)) nextElements.add(el);
      };
      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i];
        if (source.slice(runEnd, r.srcStart).includes('\n')) {
          flushRun();
          runStart = r.srcStart;
          runEnd = r.srcEnd;
        } else {
          runEnd = Math.max(runEnd, r.srcEnd);
        }
      }
      flushRun();
    }
    for (const el of mmlRangeHighlightedElements) {
      if (!nextElements.has(el)) el.classList.remove('mml-range-selected');
    }
    for (const el of nextElements) el.classList.add('mml-range-selected');
    mmlRangeHighlightedElements = nextElements;
  }

  function clearMmlPlaybackHighlight() {
    for (const el of mmlHighlightedElements) el.classList.remove('mml-playing');
    mmlHighlightedElements.clear();
    mmlHighlightLastFrame = -1;
    mmlHighlightLastFollowSrc = -1;
  }

  // 追随スクロールの位置キャッシュ。getBoundingClientRect/offsetTopは呼ぶたびに強制同期
  // レイアウト(reflow)を起こし、直前のclassList変更で汚れた状態だとオーバーレイ全体の
  // 再計算(実測で文字数の多いMMLで約11ms)を毎回誘発する。そこで各要素のoverlay内相対位置
  // (offsetTop/offsetHeight)を再生開始時に一度だけ全採取してキャッシュし、以降のスクロールは
  // レイアウトを一切読まず数値計算だけで済ませる(オーバーレイHTMLが変わるまでキャッシュ有効)。
  let mmlGeomCacheGen = -1;
  let mmlOverlayClientH = 0;
  function ensureScrollGeomCache() {
    if (mmlGeomCacheGen === mmlHighlightIndexGen) return;
    // ここでの読み取りは1フレームぶんの強制レイアウト(再生開始直後に一度だけ)。
    // 一度キャッシュすれば以降のフレームはレイアウトを読まない
    mmlOverlayClientH = mmlHighlightEl.clientHeight;
    for (const el of mmlHighlightIndex.values()) {
      el._mmlTop = el.offsetTop;
      el._mmlH = el.offsetHeight;
    }
    mmlGeomCacheGen = mmlHighlightIndexGen;
  }

  function scrollMmlEditorToElement(el) {
    ensureScrollGeomCache();
    if (el._mmlTop == null) return;
    // 対象要素がオーバーレイの縦中央に来るようtextareaのscrollTopを設定
    // (overlay側はattachHighlighterのscrollリスナーで自動追従する)
    mmlSourceEl.scrollTop = el._mmlTop + el._mmlH / 2 - mmlOverlayClientH / 2;
  }

  function updateMmlPlaybackHighlight(frameIndex) {
    const compiled = lastMmlCompiled;
    const active = mmlHighlightEnableEl.checked && !mmlHighlightSuppressed && lastPlayMode === 'capture-mml' &&
      compiled && compiled.highlightRanges && frameIndex >= 0;
    if (!active) { if (mmlHighlightedElements.size > 0) clearMmlPlaybackHighlight(); return; }
    if (frameIndex === mmlHighlightLastFrame) return; // 位置が変わっていなければ再描画不要
    const now = performance.now();
    if (now - mmlHighlightLastUpdateTime < MML_HIGHLIGHT_MIN_INTERVAL_MS) return; // 描画頻度を間引く(次に許可される時点の最新フレームへ飛ぶ)
    mmlHighlightLastUpdateTime = now;
    mmlHighlightLastFrame = frameIndex;

    // Set/配列を毎回新規アロケートせず、要素に世代番号を刻んで差分更新する(GC発生を減らす)。
    // 要素自身に立てた_mmlGenと今回のgenを比べるだけなので、Setの中身は永続的に使い回せる
    mmlHighlightGen++;
    const gen = mmlHighlightGen;
    const followCh = mmlFollowChannelEl.value;
    let followEl = null;
    for (const ch of compiled.channelLetters) {
      if (keyboardDisplay.isChannelMuted(ch)) continue;
      const r = findActiveHighlightRange(compiled.highlightRanges[ch], frameIndex, ch);
      if (!r) continue;
      let first = null;
      forEachElementInRange(r.srcStart, r.srcEnd, (el) => {
        if (first === null) first = el;
        if (el._mmlGen !== gen) {
          el._mmlGen = gen;
          if (!mmlHighlightedElements.has(el)) {
            el.classList.add('mml-playing');
            mmlHighlightedElements.add(el);
          }
        }
      });
      if (ch === followCh && first !== null) followEl = first;
    }
    // 今回の世代番号が付かなかった(=もう対象でなくなった)要素だけ消す
    for (const el of mmlHighlightedElements) {
      if (el._mmlGen !== gen) {
        el.classList.remove('mml-playing');
        mmlHighlightedElements.delete(el);
      }
    }

    if (mmlAutoScrollEnableEl.checked && followEl) {
      const followSrc = Number(followEl.dataset.s);
      if (followSrc !== mmlHighlightLastFollowSrc && now - mmlAutoScrollLastTime >= MML_AUTOSCROLL_MIN_INTERVAL_MS) {
        mmlHighlightLastFollowSrc = followSrc;
        mmlAutoScrollLastTime = now;
        scrollMmlEditorToElement(followEl);
      }
    }
  }

  // MMLコンパイル結果が変わるたびに追随チャンネル候補を更新する
  function populateFollowChannelSelect(channelLetters) {
    const prev = mmlFollowChannelEl.value;
    mmlFollowChannelEl.innerHTML = '<option value="">' + T('なし') + '</option>';
    for (const ch of channelLetters) {
      const opt = document.createElement('option');
      opt.value = ch;
      opt.textContent = ch;
      mmlFollowChannelEl.appendChild(opt);
    }
    mmlFollowChannelEl.value = channelLetters.includes(prev) ? prev : '';
    mmlHighlightRangeCache = {};
    mmlHighlightLastFrame = -1;
    mmlHighlightLastFollowSrc = -1;
  }

  function monitorLoop() {
    if (monitorState && monitorState.getPosition) {
      const frameDuration = monitorState.samplesPerFrame / monitorState.sampleRate;
      const pos = monitorState.getPosition();
      // MML再生(MmlStreamPlayer)はgetCurrentFrame()が speedFactor込みで既に正確な
      // 曲フレーム位置を返す。pos(実時間)/frameDurationは等速(speedFactor=1)前提の
      // 換算式なので、再生速度を等速以外にするとハイライト/レジスタモニタが
      // 実際の再生と食い違っていた(pos基準のframeDuration換算をそのまま使うのは
      // getCurrentFrame()を持たない他フォーマットへのフォールバックのみ)。
      let frameIndex = (activePlayer && typeof activePlayer.getCurrentFrame === 'function')
        ? activePlayer.getCurrentFrame()
        : Math.floor(pos / frameDuration);
      frameIndex = Math.max(0, Math.min(monitorState.totalFrames - 1, frameIndex));
      renderMonitor(frameIndex);
      keyboardDisplay.update(pos);
      updateMmlPlaybackHighlight(frameIndex);
    } else {
      keyboardDisplay.update(0); // 停止中もピアノを常時描画
      updateMmlPlaybackHighlight(-1);
    }
    // SPCはmonitorState(regSnapshots前提)に乗らず専用のupdateSpcVoices()経由(80ms間隔)
    // でしか描画されないため、ロールの再描画だけここでも(rAF=約60fps)呼んで滑らかにする
    // (ボイス詳細UI自体は変わらず80ms間隔のままでよい、体感の重さには影響しない)。
    if (spcActivePlayer && spcActivePlayer.isPlaying) {
      keyboardDisplay.updateRollPosition(spcActivePlayer.getPosition());
    }
    requestAnimationFrame(monitorLoop);
  }
  requestAnimationFrame(monitorLoop);

  // --- エミュレータ試聴(DPCMプレビュー等で共用) ---
  let audioCtx = null;
  let currentSource = null;

  function stopPreview() {
    if (currentSource) {
      try { currentSource.stop(); } catch (e) { /* already stopped */ }
      currentSource = null;
    }
  }

  // --- Phase 3: 一括キャプチャ & シーク/早送り/巻き戻し再生 ---
  const captureOutputEl = document.getElementById('captureOutput');
  const seekBarWrapEl = document.getElementById('seekBarWrap');
  const seekBarEl = document.getElementById('seekBar');
  const timeDisplayEl = document.getElementById('timeDisplay');
  const seekHandleStartEl = document.getElementById('seekHandleStart');
  const seekHandleEndEl = document.getElementById('seekHandleEnd');
  const seekRangeFillEl = document.getElementById('seekRangeFill');
  const seekBufferedFillEl = document.getElementById('seekBufferedFill');
  const seekTicksEl = document.getElementById('seekTicks');
  const SEEK_RESOLUTION = 1000;

  // NSF/KSS実ファイル再生のバックグラウンドキャプチャ進捗(0〜1)。シークバーの
  // バッファ済み範囲インジケータ表示に使う。該当モード以外では常に非表示。
  let nsfBufferedFraction = 1;
  let kssBufferedFraction = 1;
  let spcBufferedFraction = 1;
  let gbsBufferedFraction = 1;
  // HES(HesReplayStreamPlayer)もNSF/KSS/GBSと同じく、バックグラウンドの
  // regsOnlyキャプチャが先読みで埋めた範囲までシーク・再生できる。
  let hesBufferedFraction = 1;
  function currentBufferedFraction() {
    if (lastPlayMode === 'nsf') return nsfBufferedFraction;
    if (lastPlayMode === 'kss') return kssBufferedFraction;
    if (lastPlayMode === 'spc') return spcBufferedFraction;
    if (lastPlayMode === 'gbs') return gbsBufferedFraction;
    if (lastPlayMode === 'hes') return hesBufferedFraction;
    return null;
  }
  function updateSeekBufferedUI() {
    if (!seekBufferedFillEl) return;
    const frac = currentBufferedFraction();
    if (frac === null || frac >= 1) {
      seekBufferedFillEl.style.display = 'none';
      return;
    }
    seekBufferedFillEl.style.display = 'block';
    seekBufferedFillEl.style.width = `${frac * 100}%`;
  }

  let capturedBuffer = null;
  let transportSource = null;
  let transportPlaying = false;
  let transportOffset = 0;   // 再生位置（秒）
  let transportStartTime = 0; // audioCtx.currentTime（再生開始時）
  let transportRaf = null;

  // --- 再生範囲（シークバー上の開始点=青ハンドル/終了点=赤ハンドル、ドラッグで移動） ---
  // 初期値は曲の最初(0)と最後(duration)。MML再生のたびに毎回リセットされると
  // 「作曲中に任意の位置から再生し直す」用途で不便なため、以後の再コンパイル/再生では
  // preservePlaybackRange() で新しいdurationにクランプしつつ既存の範囲を維持する。
  // 明示的に全体へ戻したい時だけ resetPlaybackRangeToFull() を使う(「範囲をリセット」ボタン)。
  let rangeStartSec = 0;
  let rangeEndSec = null;     // null = まだ曲がロードされていない
  // MML内の!!(開始)/!!!(終了)マーカーとの連動用。「前回コンパイル時のフレーム位置」を
  // 覚えておき、そこから変化した(=ユーザーがMML側のマーカーを動かした/追加/削除した)
  // 時だけ再生範囲へ反映する。値が変わっていなければ、ユーザーがハンドルを手動でドラッグして
  // 動かした範囲をそのまま尊重する(applyMmlPlaybackMarkers参照)。undefined = 未初期化
  let lastStartMarkerFrame;
  let lastEndMarkerFrame;
  // 終了点に到達したら1回だけ自動一時停止する。停止位置より手前へシークし直すまで再武装しない
  // （そうしないと、終了点で止まった直後に▶を押した瞬間また即座に止まってしまう）
  let rangeEndArmed = true;

  // --- ストリーミング再生（ScriptProcessorNode） ---
  let activePlayer    = null;  // MmlStreamPlayer or NsfStreamPlayer
  let workletDuration = 0;    // 総再生時間（秒）
  let lastMmlCompiled = null;  // モニタ用にコンパイル結果を保持

  // 「MML再生」ボタンの3状態を区別するフラグ。■停止(または曲の自然終了)で true に戻り、
  // そのときだけボタンは「▶ MML再生」(押すと再コンパイルして最初から再生)を表示する。
  // 一時停止中(false かつ非再生)は「▶ 再生」(押すと一時停止位置から再コンパイルなしで再開)になる
  let mmlPlaybackStopped = true;

  function formatTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // activePlayer(MML/NSF)とkssActivePlayer(KSS)は排他利用(片方の再生開始時に
  // もう片方を止める設計)。共有トランスポート関数から「今アクティブな方」を
  // 1箇所で判定できるようにする(再生/一時停止/シーク操作は両者で同じインターフェース
  // を持つため、呼び出し側でフォーマットを区別する必要がない)。
  function currentTransportPlayer() {
    return activePlayer || kssActivePlayer || spcActivePlayer || gbsActivePlayer || hesActivePlayer;
  }

  // NSF/KSS/SPC/GBS/HESそれぞれの再生ボタンの見た目を更新する。実在しないものは
  // 内部で自身のプレイヤーの有無をチェックするため、まとめて呼んでよい。
  function updateFormatPlayButtons() {
    updateNsfPlayButton();
    updateKssPlayButton();
    updateSpcPlayButton();
    updateGbsPlayButton();
    updateHesPlayButton();
  }

  function getTransportPosition() {
    const p = currentTransportPlayer();
    if (p) {
      return Math.max(0, Math.min(workletDuration, p.getPosition()));
    }
    if (!capturedBuffer) return 0;
    const pos = transportPlaying
      ? transportOffset + (audioCtx.currentTime - transportStartTime)
      : transportOffset;
    return Math.max(0, Math.min(capturedBuffer.duration, pos));
  }

  function updateTransportUI() {
    const p = currentTransportPlayer();
    const duration = p ? workletDuration : (capturedBuffer ? capturedBuffer.duration : 0);
    const playing = p ? p.isPlaying : transportPlaying;
    const captureBtn = document.getElementById('btnMmlCapture');
    captureBtn.classList.toggle('is-playing', !mmlPlaybackStopped && playing);
    captureBtn.title = mmlPlaybackStopped ? T('MML再生') : (playing ? T('一時停止') : T('再生'));
    updateRangeMarkersUI(duration);
    updateSeekTicksUI(duration);
    updateSeekBufferedUI();
    if (!duration) return;
    const pos = getTransportPosition();
    seekBarEl.value = String(Math.round((pos / duration) * SEEK_RESOLUTION));
    timeDisplayEl.textContent = `${formatTime(pos)} / ${formatTime(duration)}`;
    if (playing && isFadeableSoundFileMode() && p && p.gainNode && audioCtx) {
      updateEndFadeGain(p, pos, duration);
    }
    if (playing) {
      if (pos >= duration) {
        if (isSoundFileMode()) finishSoundFilePlayback(); else transportStop();
      } else if (rangeEndSec !== null && pos >= rangeEndSec) {
        if (rangeEndArmed) {
          rangeEndArmed = false;
          if (isSoundFileMode()) finishSoundFilePlayback(); else transportStop();
        } else {
          transportRaf = requestAnimationFrame(updateTransportUI);
        }
      } else {
        rangeEndArmed = true;
        transportRaf = requestAnimationFrame(updateTransportUI);
      }
    } else {
      if (rangeEndSec === null || pos < rangeEndSec) rangeEndArmed = true;
    }
  }

  // duration(または再生範囲の終了点、どちらか早い方)の手前FADE_SEC秒からgainNodeを
  // 直線的に0まで下げ、終了点到達とほぼ同時に無音になるようにする(finishSoundFilePlayback
  // が実際に停止/次曲送りするのはその後)。手前へシークし直す等でフェード区間を外れたら
  // 即座に元の音量へ戻す。
  function updateEndFadeGain(p, pos, duration) {
    const target = rangeEndSec !== null ? Math.min(duration, rangeEndSec) : duration;
    const remain = target - pos;
    const g = p.gainNode.gain;
    if (remain <= FADE_SEC) {
      if (!endFadeActive) {
        endFadeActive = true;
        try {
          const now = audioCtx.currentTime;
          g.cancelScheduledValues(now);
          g.setValueAtTime(g.value, now);
          g.linearRampToValueAtTime(0.0001, now + Math.max(0, remain));
        } catch (e) { /* ignore */ }
      }
    } else if (endFadeActive) {
      endFadeActive = false;
      try {
        const now = audioCtx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(p._baseGain != null ? p._baseGain : g.value, now);
      } catch (e) { /* ignore */ }
    }
  }

  // 現在シーク可能かどうか（transportSeekと同じ判定）
  // HES(HesReplayStreamPlayer)もGBS/KSSと同じくバックグラウンドキャプチャの
  // 先読み範囲内でseek()に対応する。
  function canSeek() {
    if (currentTransportPlayer()) return lastPlayMode === 'capture-mml' || lastPlayMode === 'nsf' || lastPlayMode === 'kss' || lastPlayMode === 'spc' || lastPlayMode === 'gbs' || lastPlayMode === 'hes';
    return !!capturedBuffer;
  }

  function currentDuration() {
    return currentTransportPlayer() ? workletDuration : (capturedBuffer ? capturedBuffer.duration : 0);
  }

  // 開始点(青)/終了点(赤)ハンドルと範囲の塗りつぶしをシークバー上に表示する
  function updateRangeMarkersUI(duration) {
    if (duration === undefined) duration = currentDuration();
    const pct = (sec) => Math.max(0, Math.min(100, (sec / duration) * 100));
    if (!duration || rangeEndSec === null) {
      seekHandleStartEl.style.display = 'none';
      seekHandleEndEl.style.display = 'none';
      seekRangeFillEl.style.display = 'none';
      return;
    }
    seekHandleStartEl.style.display = 'block';
    seekHandleEndEl.style.display = 'block';
    const startPct = pct(rangeStartSec);
    const endPct = pct(rangeEndSec);
    seekHandleStartEl.style.left = `${startPct}%`;
    seekHandleEndEl.style.left = `${endPct}%`;
    if (endPct <= startPct) {
      seekRangeFillEl.style.display = 'none';
    } else {
      seekRangeFillEl.style.display = 'block';
      seekRangeFillEl.style.left = `${startPct}%`;
      seekRangeFillEl.style.width = `${endPct - startPct}%`;
    }
  }

  // シークバーの目盛り(時間の縦線+ラベル)を生成する。durationが変わった時だけ再構築する
  let lastTicksDuration = -1;
  function updateSeekTicksUI(duration) {
    if (!seekTicksEl) return; // 目盛りUIは廃止済み(ヘッダーのシークバーには表示しない)
    if (duration === undefined) duration = currentDuration();
    if (duration === lastTicksDuration) return;
    lastTicksDuration = duration;
    seekTicksEl.innerHTML = '';
    if (!duration) return;
    const TARGET_TICK_COUNT = 8;
    const NICE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    let interval = NICE_STEPS[NICE_STEPS.length - 1];
    for (const step of NICE_STEPS) {
      if (duration / step <= TARGET_TICK_COUNT) { interval = step; break; }
    }
    for (let t = 0; t <= duration + 0.001; t += interval) {
      const pct = Math.min(100, (t / duration) * 100);
      const tick = document.createElement('div');
      tick.className = 'seek-tick';
      tick.style.left = `${pct}%`;
      const label = document.createElement('span');
      label.className = 'seek-tick-label';
      label.textContent = formatTime(t);
      tick.appendChild(label);
      seekTicksEl.appendChild(tick);
    }
  }

  // 再生範囲を曲の最初(0)〜最後(duration)にリセットする（ハンドルは常にこの範囲を表す）
  function resetPlaybackRangeToFull(duration) {
    rangeStartSec = 0;
    rangeEndSec = duration || 0;
    rangeEndArmed = true;
    updateRangeMarkersUI(duration);
    updateSeekTicksUI(duration);
    updateMmlRangeHighlight();
  }

  // MML作曲中は「▶ MML再生」を押すたびに再コンパイル→再生し直すのが主な使い方であり、
  // そのたびに開始点/終了点が曲頭・曲末にリセットされると不便なため、既存の範囲を維持する。
  // 新しいdurationに収まるようクランプするだけで、初回(まだ範囲が無い)や
  // 範囲が潰れてしまった場合(曲が大幅に短くなった等)は全体にフォールバックする。
  function preservePlaybackRange(duration) {
    duration = duration || 0;
    if (rangeEndSec === null) {
      rangeStartSec = 0;
      rangeEndSec = duration;
    } else {
      rangeStartSec = Math.max(0, Math.min(rangeStartSec, duration));
      rangeEndSec = Math.max(0, Math.min(rangeEndSec, duration));
      if (rangeEndSec <= rangeStartSec) {
        rangeStartSec = 0;
        rangeEndSec = duration;
      }
    }
    rangeEndArmed = true;
    updateRangeMarkersUI(duration);
    updateSeekTicksUI(duration);
    updateMmlRangeHighlight();
  }

  // MML内の!!/!!!マーカーと再生範囲(青/赤ハンドル)を連動させる(!/!!/!!! 特殊マーカー)。
  // forceApply=true(範囲が初回ロード状態=preservePlaybackRangeがrangeEndSec===nullから
  // 全体初期化した直後)なら常に反映し、そうでなければ「前回コンパイル時と比べてMML側の
  // マーカー位置が実際に変わった時だけ」反映する。これにより、MMLを編集せず単にハンドルを
  // 手動ドラッグしただけなら、次の再コンパイルでその手動位置が上書きされてしまうことがない
  function applyMmlPlaybackMarkers(compiled, duration, forceApply) {
    const startChanged = forceApply || compiled.startMarkerFrame !== lastStartMarkerFrame;
    const endChanged = forceApply || compiled.endMarkerFrame !== lastEndMarkerFrame;
    lastStartMarkerFrame = compiled.startMarkerFrame;
    lastEndMarkerFrame = compiled.endMarkerFrame;
    if (!startChanged && !endChanged) return;
    if (startChanged) {
      rangeStartSec = compiled.startMarkerFrame != null ? compiled.startMarkerFrame / compiled.frameRate : 0;
    }
    if (endChanged) {
      rangeEndSec = compiled.endMarkerFrame != null ? compiled.endMarkerFrame / compiled.frameRate : duration;
    }
    rangeStartSec = Math.max(0, Math.min(rangeStartSec, duration));
    rangeEndSec = Math.max(0, Math.min(rangeEndSec, duration));
    if (rangeEndSec <= rangeStartSec) { rangeStartSec = 0; rangeEndSec = duration; }
    rangeEndArmed = true;
    updateRangeMarkersUI(duration);
    updateSeekTicksUI(duration);
    updateMmlRangeHighlight();
  }

  // 指定フレームをchチャンネルの原文MML上のどこに挿入すべきか([[startFrame]]がtargetFrame以上
  // になる最初の音符の直前)を返す。targetFrameが曲末より後ろなら最後の音符の直後。
  // そのチャンネルに(srcRangeを持つ)音符が1つも無ければnull(書き込み不能)
  function findMmlInsertPosForFrame(compiled, ch, targetFrame) {
    const ranges = compiled.highlightRanges && compiled.highlightRanges[ch];
    if (!ranges || ranges.length === 0) return null;
    const sorted = ranges.slice().sort((a, b) => a.srcStart - b.srcStart);
    for (const r of sorted) {
      if (r.startFrame >= targetFrame) return r.srcStart;
    }
    return sorted[sorted.length - 1].srcEnd;
  }

  // removeRange(既存マーカーの[start,end)、無ければnull)を取り除きつつ、insertPos(削除前の
  // 原文における位置)へinsertTextを挿入した新しい文字列を返す
  function spliceMarkerText(text, removeRange, insertPos, insertText) {
    if (!removeRange) {
      return text.slice(0, insertPos) + insertText + text.slice(insertPos);
    }
    if (insertPos <= removeRange.start) {
      const withInsert = text.slice(0, insertPos) + insertText + text.slice(insertPos);
      const shift = insertText.length;
      return withInsert.slice(0, removeRange.start + shift) + withInsert.slice(removeRange.end + shift);
    }
    const withoutOld = text.slice(0, removeRange.start) + text.slice(removeRange.end);
    const adjPos = insertPos - (removeRange.end - removeRange.start);
    return withoutOld.slice(0, adjPos) + insertText + withoutOld.slice(adjPos);
  }

  // シークバーの開始/終了ハンドルのドラッグ確定後、その位置を!!(開始)/!!!(終了)マーカーとして
  // MML本文へ書き戻す(!/!!/!!! 特殊マーカー、ユーザー要望の「相互に更新できるように」)。
  // 既存マーカーがあれば同じチャンネルのその位置を置き換え、無ければ最初のチャンネルへ新規挿入する。
  // 書き込み対象チャンネルに音符が1つも無い場合は書き込めないので何もしない(無理に挿入しない)
  function writeMmlPlaybackMarker(which) {
    const compiled = lastMmlCompiled;
    if (!compiled) return;
    const isStart = which === 'start';
    const markerText = isStart ? '!!' : '!!!';
    const existingCh = isStart ? compiled.startMarkerChannel : compiled.endMarkerChannel;
    const existingRange = isStart ? compiled.startMarkerSrcRange : compiled.endMarkerSrcRange;
    const targetCh = existingCh || (compiled.channelLetters && compiled.channelLetters[0]);
    if (!targetCh) return;
    const targetFrame = Math.round((isStart ? rangeStartSec : rangeEndSec) * compiled.frameRate);
    const insertPos = findMmlInsertPosForFrame(compiled, targetCh, targetFrame);
    if (insertPos == null) return;

    mmlSourceEl.value = spliceMarkerText(mmlSourceEl.value, existingRange, insertPos, markerText);
    mmlSourceEl.dispatchEvent(new Event('input')); // シンタックスハイライト更新
    // ここでprepareMmlStream()(重い再コンパイル)を呼ぶと内部でtransportStop()が走り、
    // 「再生しながら範囲をドラッグして聴き比べる」という本来の使い方を毎回中断させてしまう。
    // 再生中の音声・トランスポート状態には触れず、次回のdirectMarkerSrcRange参照(連続ドラッグ時に
    // 今書いたばかりのマーカーを重複挿入せず置換できるようにするため)とlastStartMarkerFrame/
    // lastEndMarkerFrame追跡だけを軽量に同期する
    const recompiled = MML.Mml.compile(mmlSourceEl.value, getMmlOpt());
    lastMmlCompiled = recompiled;
    lastStartMarkerFrame = recompiled.startMarkerFrame;
    lastEndMarkerFrame = recompiled.endMarkerFrame;
  }

  // 開始点/終了点ハンドルのドラッグ操作。ドラッグ中は左右反転しないよう互いにクランプする。
  // 最小間隔を秒数の固定値にすると、長い曲では画面上ではほぼ0pxになり2つのハンドルが
  // 重なってしまい、DOM順で後にある終点側だけしか掴めなくなる(始点が下敷きになる)バグが
  // あったため、常に画面上で一定px以上離れるよう duration/表示幅から逆算した秒数を使う。
  const MIN_GAP_PX = 12;
  function setupRangeHandleDrag(handleEl, which) {
    handleEl.addEventListener('pointerdown', (e) => {
      if (!canSeek()) return;
      const duration = currentDuration();
      if (!duration) return;
      e.preventDefault();
      handleEl.setPointerCapture(e.pointerId);
      handleEl.classList.add('dragging');
      mmlHighlightSuppressed = false; // ドラッグ中はハイライトで範囲を視覚的に確認できるようにする

      const onMove = (ev) => {
        const wrapRect = seekBarWrapEl.getBoundingClientRect();
        const minGap = (MIN_GAP_PX / wrapRect.width) * duration;
        const frac = Math.max(0, Math.min(1, (ev.clientX - wrapRect.left) / wrapRect.width));
        const sec = frac * duration;
        if (which === 'start') {
          rangeStartSec = Math.max(0, Math.min(sec, rangeEndSec - minGap));
        } else {
          rangeEndSec = Math.min(duration, Math.max(sec, rangeStartSec + minGap));
        }
        rangeEndArmed = getTransportPosition() < rangeEndSec;
        updateRangeMarkersUI(duration);
        updateMmlRangeHighlight();
      };
      const onUp = () => {
        handleEl.classList.remove('dragging');
        handleEl.removeEventListener('pointermove', onMove);
        handleEl.removeEventListener('pointerup', onUp);
        handleEl.removeEventListener('pointercancel', onUp);
        // MML再生中のみ、確定した範囲を!!/!!!マーカーとしてMML本文へ書き戻す
        // (NSF/KSS/SPC等の実ファイル再生ではMML本文が存在しないため対象外)
        if (lastPlayMode === 'capture-mml') writeMmlPlaybackMarker(which);
      };
      handleEl.addEventListener('pointermove', onMove);
      handleEl.addEventListener('pointerup', onUp);
      handleEl.addEventListener('pointercancel', onUp);
    });
  }
  setupRangeHandleDrag(seekHandleStartEl, 'start');
  setupRangeHandleDrag(seekHandleEndEl, 'end');

  function stopActivePlayer() {
    if (activePlayer) {
      activePlayer.destroy();
      activePlayer = null;
    }
    workletDuration = 0;
  }

  // フォーマット非依存の「今鳴っている全プレイヤーを止める」。新規ファイル読込時や
  // 他フォーマットの再生開始時に呼ぶことで、旧フォーマットが鳴りっぱなしになるのを防ぐ
  // (各play*Stream/load*Fileが個別にstop*Playbackを列挙する方式だと、フォーマット追加時に
  // 呼び忘れが起きやすい。実際HES/GBS追加時に他フォーマット側の停止漏れが発生していた)。
  function stopAllFormatPlayback() {
    stopActivePlayer();
    stopKssPlayback();
    stopSpcPlayback();
    stopGbsPlayback();
    stopHesPlayback();
  }

  // ウィンドウを閉じた時用: stopAllFormatPlayback()と違い、MML再生中(activePlayerを
  // 共用している)を巻き込まない。stopNsfFilePlayback()自体がlastPlayMode==='nsf'の
  // 時だけactivePlayerへ触れる設計なので、他4つ(専用変数を持つ)と合わせて無条件に呼べる。
  function stopSoundFileWindowPlayback() {
    stopNsfFilePlayback();
    stopKssPlayback();
    stopSpcPlayback();
    stopGbsPlayback();
    stopHesPlayback();
  }

  // duration/再生範囲終了点への到達で自動的に次の曲/トラックへ進む対象かどうか
  // (SPCは1ファイル=1曲のため曲送りの概念が無く、対象外)
  function isSoundFileMode() {
    return lastPlayMode === 'nsf' || lastPlayMode === 'kss' || lastPlayMode === 'gbs' || lastPlayMode === 'hes';
  }
  function isFadeableSoundFileMode() {
    return isSoundFileMode() || lastPlayMode === 'spc';
  }

  // 曲リストの最後まで達したら先頭(0/最小値)へ戻ってループする「自動送り」版。
  // ボタン操作のchangeXxxSong/Track(クランプ)とは違い、無限に再生が続けられるようラップする。
  function autoAdvanceNsfSong() {
    if (!loadedNsfHeader) return;
    const totalSongs = Math.max(1, loadedNsfHeader.totalSongs);
    let songNo = (parseInt(nsfSongIndexEl.value, 10) || 1) + 1;
    if (songNo > totalSongs) songNo = 1;
    nsfSongIndexEl.value = String(songNo);
    lastNsfCaptureResult = null;
    playNsfStream();
  }
  function autoAdvanceKssSong() {
    const min = parseInt(kssSongIndexEl.min, 10) || 0;
    const max = parseInt(kssSongIndexEl.max, 10) || 255;
    let v = (parseInt(kssSongIndexEl.value, 10) || 0) + 1;
    if (v > max) v = min;
    kssSongIndexEl.value = String(v);
    playKssStream();
  }
  function autoAdvanceGbsSong() {
    const min = parseInt(gbsSongIndexEl.min, 10) || 0;
    const max = parseInt(gbsSongIndexEl.max, 10) || 0;
    let v = (parseInt(gbsSongIndexEl.value, 10) || 0) + 1;
    if (v > max) v = min;
    gbsSongIndexEl.value = String(v);
    playGbsStream();
  }
  function autoAdvanceHesTrack() {
    let v = (parseInt(hesTrackIndexEl.value, 10) || 0) + 1;
    if (v > 255) v = 0;
    hesTrackIndexEl.value = String(v);
    playHesStream();
  }

  // duration/再生範囲終了点へ到達した(フェードアウト完了済み)時に呼ぶ。プレイヤーを
  // 破棄してから次のインデックスへ進める(transportStop()だけだとactivePlayerが残ったまま
  // 一時停止扱いになり、次のplayXxxStream()呼び出しが「一時停止解除」に化けてしまうため)。
  // SPCは曲送りの概念が無いので停止するだけ。
  function finishSoundFilePlayback() {
    endFadeActive = false;
    const mode = lastPlayMode;
    if (mode === 'nsf') { stopNsfFilePlayback(); autoAdvanceNsfSong(); }
    else if (mode === 'kss') { stopKssPlayback(); autoAdvanceKssSong(); }
    else if (mode === 'gbs') { stopGbsPlayback(); autoAdvanceGbsSong(); }
    else if (mode === 'hes') { stopHesPlayback(); autoAdvanceHesTrack(); }
    else if (mode === 'spc') { stopSpcPlayback(); }
    else { transportStop(); }
  }

  function transportPlay() {
    mmlHighlightSuppressed = false;
    // 現在位置が再生範囲の開始点より手前なら、再生前に開始点までジャンプする
    if (canSeek() && rangeStartSec > 0 && getTransportPosition() < rangeStartSec - 0.001) {
      transportSeek(rangeStartSec);
    }
    const p = currentTransportPlayer();
    if (p) {
      if (p.isPlaying) return;
      if (audioCtx) audioCtx.resume();
      p.play();
      updateFormatPlayButtons();
      transportRaf = requestAnimationFrame(updateTransportUI);
      return;
    }
    if (!capturedBuffer) return;
    if (transportPlaying) return;
    if (transportOffset >= capturedBuffer.duration) transportOffset = 0;

    const source = audioCtx.createBufferSource();
    source.buffer = capturedBuffer;
    source.connect(audioCtx.destination);
    source.start(0, transportOffset);
    transportSource = source;
    transportStartTime = audioCtx.currentTime;
    transportPlaying = true;
    transportRaf = requestAnimationFrame(updateTransportUI);
  }

  function transportPause() {
    const p = currentTransportPlayer();
    if (p) {
      if (!p.isPlaying) return;
      p.pause();
      if (transportRaf) cancelAnimationFrame(transportRaf);
      updateFormatPlayButtons();
      updateTransportUI();
      return;
    }
    if (!transportPlaying) return;
    transportOffset = getTransportPosition();
    if (transportSource) {
      try { transportSource.stop(); } catch (e) { /* ignore */ }
      transportSource = null;
    }
    transportPlaying = false;
    if (transportRaf) cancelAnimationFrame(transportRaf);
    updateTransportUI();
  }

  function transportStop() {
    mmlHighlightSuppressed = true;
    mmlPlaybackStopped = true;
    // 停止後は曲頭(0)ではなく再生範囲の開始点に戻る（開始点未設定時は従来通り0）
    const restoreTo = rangeStartSec || 0;
    const p = currentTransportPlayer();
    if (p) {
      p.stop();
      if (restoreTo > 0 && (lastPlayMode === 'capture-mml' || lastPlayMode === 'nsf' || lastPlayMode === 'kss' || lastPlayMode === 'spc' || lastPlayMode === 'gbs' || lastPlayMode === 'hes')) {
        p.seek(Math.round(restoreTo * audioCtx.sampleRate));
      }
      if (transportRaf) cancelAnimationFrame(transportRaf);
      updateFormatPlayButtons();
      updateTransportUI();
      return;
    }
    transportPause();
    transportOffset = restoreTo;
    updateTransportUI();
  }

  function transportSeek(seconds) {
    // シークバーを動かした位置をハイライトで即座に確認できるようにする（■停止直後でも）
    mmlHighlightSuppressed = false;
    const p = currentTransportPlayer();
    if (p) {
      if (lastPlayMode !== 'capture-mml' && lastPlayMode !== 'nsf' && lastPlayMode !== 'kss' && lastPlayMode !== 'spc' && lastPlayMode !== 'gbs' && lastPlayMode !== 'hes') return;
      const wasPlaying = p.isPlaying;
      p.pause();
      p.seek(Math.round(Math.max(0, Math.min(workletDuration, seconds)) * audioCtx.sampleRate));
      if (wasPlaying) {
        p.play();
        transportRaf = requestAnimationFrame(updateTransportUI);
      } else {
        updateTransportUI();
      }
      return;
    }
    if (!capturedBuffer) return;
    const wasPlaying = transportPlaying;
    if (transportPlaying) {
      if (transportSource) { try { transportSource.stop(); } catch (e) { /* ignore */ } transportSource = null; }
      transportPlaying = false;
      if (transportRaf) cancelAnimationFrame(transportRaf);
    }
    transportOffset = Math.max(0, Math.min(capturedBuffer.duration, seconds));
    if (wasPlaying) transportPlay();
    else updateTransportUI();
  }

  // compiled.tracks からモニタ用 regSnapshots を即時構築（音声生成なし）
  function buildRegSnapshotsFromTracks(compiled) {
    const { tracks, channelLetters, totalFrames, statusAddr } = compiled;
    const snapshots = new Array(totalFrames);
    const regs = { [statusAddr]: 0x0F };
    for (let f = 0; f < totalFrames; f++) {
      for (const ch of channelLetters) {
        for (const w of tracks[ch][f]) regs[w.addr] = w.value;
      }
      snapshots[f] = Object.assign({}, regs);
    }
    return snapshots;
  }

  // compiled.tracks からフレームごとの全チャンネル書き込みをまとめたwriteLogを構築する。
  // N163/FME7はラッチ+間接アドレッシングのため、レジスタスナップショット(最終値)だけでは
  // 鍵盤表示のピアノロール構築(src/ui/keyboard.jsのbuildN163Snapshots/buildFme7Snapshots、
  // $F800/$4800・$C000/$E000の書き込み列を再生してチップ内部状態を復元する)に使う
  // writeLogが必要。MML再生(runMmlStream)はNSF実ファイル再生と違いwriteLogを
  // 渡していなかったため、ピアノロールにN163/FME7の音符が一切出ない不具合があった。
  function buildWriteLogFromTracks(compiled) {
    const { tracks, channelLetters, totalFrames } = compiled;
    const writeLog = new Array(totalFrames);
    for (let f = 0; f < totalFrames; f++) {
      const writes = [];
      for (const ch of channelLetters) for (const w of tracks[ch][f]) writes.push(w);
      writeLog[f] = writes;
    }
    return writeLog;
  }

  // --- フェーズ1.7: MML本文の@DPCM<n>参照ファイルの読み込みUI ---
  // ファイル名(@DPCM<n>={"file",...}の"file")をキーにエンコード済みバイト列を
  // キャッシュする。セッション内で一度読み込めば、再コンパイル・再生時に
  // 都度ファイル選択し直す必要はない(compiler.jsのopt.dpcmSamples[filename]と対応)
  const dpcmSampleCache = {};
  const dpcmSampleListEl = document.getElementById('dpcmSampleList');

  // MML本文をスキャンし、@DPCM<n>定義から{ file: freq }を集める
  // (ファイル名が重複する場合は先に出現した定義のfreqを採用する)
  function scanDpcmFileDefs(source) {
    const { envelopes } = MML.Mml.splitChannels(source);
    const files = {};
    for (const idx of Object.keys(envelopes.dpcm)) {
      const def = envelopes.dpcm[idx];
      if (def.file && !(def.file in files)) files[def.file] = def.freq || 0;
    }
    return files;
  }

  // .dmcは既に2A03 DMC形式(1bitデルタ変調)にエンコード済みの生バイナリなので、
  // decodeAudioData(PCM前提のデコーダ)には通さずそのままキャッシュする。
  // 拡張子はファイル選択(input.files[0].name)側で判定する(MML本文の"file"文字列と
  // 一致させる必要があるため、キーはfilenameのまま変えない)
  function isDmcFilename(name) {
    return /\.dmc$/i.test(name || '');
  }

  async function loadDpcmSampleFile(filename, freq, file, statusEl) {
    try {
      if (isDmcFilename(file.name)) {
        statusEl.textContent = T('読込中…');
        const arrayBuffer = await file.arrayBuffer();
        dpcmSampleCache[filename] = new Uint8Array(arrayBuffer);
        statusEl.textContent = T('読み込み済み({n}バイト、.dmc生データ)。再コンパイル/再生してください',
          { n: dpcmSampleCache[filename].length });
        statusEl.className = 'ok';
        return;
      }
      statusEl.textContent = T('変換中…');
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      let samples;
      if (audioBuffer.numberOfChannels === 1) {
        samples = audioBuffer.getChannelData(0);
      } else {
        const ch0 = audioBuffer.getChannelData(0);
        const ch1 = audioBuffer.getChannelData(1);
        samples = new Float32Array(ch0.length);
        for (let i = 0; i < ch0.length; i++) samples[i] = (ch0[i] + ch1[i]) / 2;
      }
      const result = MML.Dpcm.encode(samples, audioBuffer.sampleRate, freq);
      dpcmSampleCache[filename] = result.bytes;
      statusEl.textContent = T('読み込み済み({n}バイト、レート{freq}={hz}Hz)。再コンパイル/再生してください',
        { n: result.bytes.length, freq, hz: result.rateHz.toFixed(0) });
      statusEl.className = 'ok';
    } catch (e) {
      statusEl.textContent = T('変換失敗: {msg}', { msg: e.message });
      statusEl.className = 'error';
    }
  }

  // MML本文中の@DPCM参照ファイル一覧を、ファイル選択UIとして表示する。
  // 既に読み込み済み(dpcmSampleCacheにある)ファイルは行を保持したまま状態表示のみ更新する
  function refreshDpcmSampleList(source) {
    const files = scanDpcmFileDefs(source);
    const names = Object.keys(files);
    if (names.length === 0) {
      dpcmSampleListEl.style.display = 'none';
      dpcmSampleListEl.innerHTML = '';
      return;
    }
    dpcmSampleListEl.style.display = '';
    dpcmSampleListEl.innerHTML = '';
    const title = document.createElement('div');
    title.textContent = T('MML内で参照されている@DPCMサンプル:');
    dpcmSampleListEl.appendChild(title);
    for (const filename of names) {
      const freq = files[filename];
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:2px;';

      const label = document.createElement('span');
      label.textContent = T('"{file}" (レート{freq}):', { file: filename, freq });
      row.appendChild(label);

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*,.dmc';
      row.appendChild(input);

      const status = document.createElement('span');
      status.className = dpcmSampleCache[filename] ? 'ok' : '';
      status.textContent = dpcmSampleCache[filename]
        ? T('読み込み済み({n}バイト)', { n: dpcmSampleCache[filename].length })
        : T('未読み込み(この曲は無音になります)');
      row.appendChild(status);

      input.addEventListener('change', () => {
        const f = input.files[0];
        if (f) loadDpcmSampleFile(filename, freq, f, status);
      });

      dpcmSampleListEl.appendChild(row);
    }
  }

  // --- Phase 4: MMLコンパイラ ---
  function getMmlOpt() {
    refreshDpcmSampleList(mmlSourceEl.value);
    return {
      fdsWave: MML.WaveformEditor.getFdsWave(),
      n163Wave: MML.WaveformEditor.getN163Wave(),
      mute: getChannelMuteConfig(),
      dpcmSamples: dpcmSampleCache
    };
  }

  // MMLをコンパイルし、ppmck方式バイトコード(src/nsf/mckBytecode.js)+
  // 専用ドライバ(src/driver/ppmckDriver.js)経由でNSFファイルとして書き出す。
  // 現状は2A03のパルス1/パルス2/三角波/ノイズ(A-D)のみ対応(ROADMAP.mdフェーズ1.6)。
  function exportMmlNsf() {
    const result = MML.Mml.compile(mmlSourceEl.value, getMmlOpt());

    mmlOutputEl.innerHTML = '';
    const msg = document.createElement('div');

    if (result.errors.length > 0) {
      msg.className = 'error';
      msg.textContent = T('MMLコンパイルエラーのため書き出せません:') + '\n' +
        result.errors.map(e => e.lineNo ? `[Line ${e.lineNo}] ${e.message}` : e.message).join('\n');
      mmlOutputEl.appendChild(msg);
      return;
    }

    // #TITLE/#COMPOSER/#MAKER(MML本文)からNSFヘッダを組み立てる
    // (DESIGN.md INV-2: MMLテキストが正典。UI入力欄は廃止)
    const meta = result.meta || {};
    const headerOpt = {
      songName: meta.title || '',
      artist: meta.composer || '',
      copyright: meta.maker || '',
      totalSongs: 1,
      startingSong: 1
    };
    const built = MML.Driver.buildBankedNsfBytes(result, headerOpt);
    if (built.asmErrors.length > 0) {
      msg.className = 'error';
      msg.textContent = T('ドライバのアセンブルに失敗しました(内部エラー):') + '\n' +
        built.asmErrors.map(e => `[Line ${e.lineNo}] ${e.message}`).join('\n');
      mmlOutputEl.appendChild(msg);
      return;
    }
    const nsfBytes = built.nsfBytes;
    MML.NSF.download(nsfBytes, (headerOpt.songName || 'output') + '.nsf');

    let out = T('NSF書き出し完了: {bytes}バイト({banks}バンク、うち曲データ {songBanks}バンク)',
      { bytes: nsfBytes.length, banks: built.bankCount, songBanks: Math.max(0, built.bankCount - 8) }) + '\n';
    if (built.unsupportedExpansions.length > 0) {
      out += T('注意: 拡張音源({chips})は現状のNSF書き出しでは未対応のため、該当チャンネルは無音になります(VRC6/MMC5/FME7は対応済み)。',
        { chips: built.unsupportedExpansions.join(', ') }) + '\n';
    }
    msg.className = 'ok';
    msg.textContent = out;
    mmlOutputEl.appendChild(msg);
  }

  // compileOnly=true: コンパイル・再生準備(モニタ/DPCMサンプル欄/チャンネル選択欄など各種UIの
  // 反映)のみ行い、実際の音声再生は開始しない。NSF2MML等の変換直後にMML本文だけを差し替えても
  // これらの要素は自動更新されないため、変換完了時にはこちらを呼ぶ
  function prepareMmlStream(compileOnly) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const btnMmlCapture = document.getElementById('btnMmlCapture');
    btnMmlCapture.disabled = true;
    captureOutputEl.innerHTML = '<div>' + T('コンパイル中…') + '</div>';

    // 「まだ曲がロードされていない/直前に明示的にリセットされた」状態かどうかをここで
    // 記録しておく(この先のpreservePlaybackRangeでrangeEndSecがnullでなくなるため、
    // 呼び出し後では判定できない)。applyMmlPlaybackMarkers参照
    const isFreshRangeLoad = (rangeEndSec === null);

    const compiled = MML.Mml.compile(mmlSourceEl.value, getMmlOpt());
    if (compiled.errors.length > 0) {
      captureOutputEl.innerHTML =
        `<div class="error">${compiled.errors.map(e => e.lineNo ? `[Line ${e.lineNo}] ${e.message}` : e.message).join('\n')}</div>`;
      btnMmlCapture.disabled = false;
      return;
    }

    // compile()自体は成功していても、この先(再生用プレイヤー構築等)で予期しない例外が
    // 起きると、それを捕まえるcatchが無かったため「コンパイル中…」の表示とボタンの
    // disabled状態がそのまま固まり、ユーザーからは「MMLコンパイルが終わらない」ように
    // 見えていた(実際はUncaught例外で処理が中断していただけ)。実例: HES由来のMMLで
    // DPCMサンプルが長すぎるとMmlStreamPlayer.load()のbuildDpcmBusがRangeErrorを投げていた
    // (src/mml/compiler.js layoutDpcmSamples側で修正済みだが、想定外の例外一般に対する
    // フォールバックとしてここでも捕捉し、必ずUIへエラー表示・ボタン復帰させる)
    try {
      // 既存の再生を停止。MMLとNSF/SPC/KSSファイル再生は排他(同時に鳴らす意味がない)なので、
      // 音だけでなくピアノロールの先読みキャプチャもここで確実に止める。止めないと
      // KSS/SPCの先読みが完了までsetRollTimeline()を上書きし続け、MMLのロールが壊れる。
      transportStop();
      stopAllFormatPlayback();
      stopVoiceMonitor();
      invalidateOtherRollPrefetch();
      capturedBuffer = null;

      lastMmlCompiled = compiled;
      lastPlayMode    = 'capture-mml';
      populateFollowChannelSelect(compiled.channelLetters);

      // モニタ用 regSnapshots をメインスレッドで即時構築（音声生成なし）
      resetN163Max();
      const regSnapshots    = buildRegSnapshotsFromTracks(compiled);
      const writeLog        = buildWriteLogFromTracks(compiled);
      const samplesPerFrame = audioCtx.sampleRate / compiled.frameRate;
      setMonitorSource(
        { regSnapshots, writeLog, cpuSnapshots: null, memSnapshots: null,
          sampleRate: audioCtx.sampleRate, samplesPerFrame,
          totalFrames: compiled.totalFrames,
          getApuEnv: liveApuEnv, getN163: liveN163,
          getFME7: liveFME7, getMmc5: liveMMC5, getVRC7: liveVRC7 }, // 音量/拡張音源表示をライブ反映
        getTransportPosition,
        compiled.expansions
      );

      // MmlStreamPlayer を生成してデータをロード
      const player = new MML.Audio.MmlStreamPlayer(audioCtx);
      player.load(compiled, getChannelMuteConfig());
      // 曲末まで再生し終えて音声スレッド側が自然にisPlaying=falseにした場合も、
      // ■停止を押したときと同じ状態(mmlPlaybackStopped、開始点への復帰)にする
      player.onEnded = () => {
        if (transportRaf) cancelAnimationFrame(transportRaf);
        transportStop();
      };

      activePlayer    = player;
      player.setSpeed(currentSpeedFactor);
      workletDuration = player.getDuration();
    } catch (e) {
      captureOutputEl.innerHTML = `<div class="error">${T('再生準備に失敗しました(内部エラー): {msg}', { msg: e.message })}</div>`;
      btnMmlCapture.disabled = false;
      return;
    }

    const duration = workletDuration;
    const shownExpansions = displayExpansions(compiled.expansions);
    const expansionsLabel = shownExpansions.length > 0 ? shownExpansions.join(', ') : T('なし');
    let out = T('再生準備完了 (テンポ {tempo}, 拡張音源: {chips})',
      { tempo: compiled.tempo, chips: expansionsLabel }) + '\n\n';
    out += T('総フレーム数: {n}', { n: compiled.totalFrames }) + '\n';
    out += T('総再生時間  : {time}', { time: formatTime(duration) }) + '\n';
    for (const ch of compiled.channelLetters) {
      const writes = compiled.tracks[ch].reduce((a, w) => a + w.length, 0);
      out += T('チャンネル{ch}: {n} 件', { ch, n: writes }) + '\n';
    }
    captureOutputEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = out;
    captureOutputEl.appendChild(pre);

    preservePlaybackRange(duration);
    applyMmlPlaybackMarkers(compiled, duration, isFreshRangeLoad);
    seekBarEl.value = '0';
    timeDisplayEl.textContent = `00:00 / ${formatTime(duration)}`;
    btnMmlCapture.disabled = false;

    if (!compileOnly) {
      mmlPlaybackStopped = false;
      transportPlay();
    }
  }

  function runMmlStream() {
    prepareMmlStream(false);
  }

  // --- Phase 6: DPCMコンバータ ---
  const dpcmFileEl = document.getElementById('dpcmFile');
  const dpcmRateEl = document.getElementById('dpcmRate');
  const dpcmOutputEl = document.getElementById('dpcmOutput');
  let lastDpcmResult = null;

  MML.Dpcm.DMC_RATE_TABLE_NTSC.forEach((hz, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i}: ${hz.toFixed(1)} Hz`;
    dpcmRateEl.appendChild(opt);
  });
  dpcmRateEl.value = '15';

  async function convertDpcm() {
    const file = dpcmFileEl.files[0];
    if (!file) {
      dpcmOutputEl.innerHTML = '<div class="error">' + T('音声ファイルを選択してください。') + '</div>';
      return;
    }

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    let samples;
    if (audioBuffer.numberOfChannels === 1) {
      samples = audioBuffer.getChannelData(0);
    } else {
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = audioBuffer.getChannelData(1);
      samples = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) samples[i] = (ch0[i] + ch1[i]) / 2;
    }

    const rateIndex = parseInt(dpcmRateEl.value, 10);
    const result = MML.Dpcm.encode(samples, audioBuffer.sampleRate, rateIndex);
    lastDpcmResult = result;

    let out = '';
    out += T('元サンプルレート      : {rate} Hz', { rate: audioBuffer.sampleRate }) + '\n';
    out += T('元サンプル数          : {n}', { n: samples.length }) + '\n';
    out += T('DMCレート             : {idx} ({hz} Hz)', { idx: rateIndex, hz: result.rateHz.toFixed(1) }) + '\n';
    out += T('エンコード後サンプル数: {n}', { n: result.sampleCount }) + '\n';
    out += T('データサイズ          : {n} bytes', { n: result.bytes.length }) + '\n';
    out += T('再生時間              : {time}', { time: formatTime(result.sampleCount / result.rateHz) }) + '\n\n';
    out += T('--- バイナリダンプ (先頭256バイト) ---') + '\n';
    out += MML.Dpcm.hexDump(result.bytes.slice(0, 256));

    dpcmOutputEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = out;
    dpcmOutputEl.appendChild(pre);
  }

  function previewDpcm() {
    if (!lastDpcmResult) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    stopPreview();

    const decoded = MML.Dpcm.decode(lastDpcmResult.bytes, lastDpcmResult.sampleCount);
    const buffer = audioCtx.createBuffer(1, decoded.length, lastDpcmResult.rateHz);
    buffer.getChannelData(0).set(decoded);

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start();
    currentSource = source;
  }

  function downloadDpcm() {
    if (!lastDpcmResult) return;
    const blob = new Blob([lastDpcmResult.bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dpcm.bin';
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- NSFファイル読み込み・再生 ---
  const nsfFileEl = document.getElementById('nsfFile');
  const nsfFileHeaderEl = document.getElementById('nsfFileHeader');
  const nsfSongIndexEl = document.getElementById('nsfSongIndex');
  const nsfSongTotalEl = document.getElementById('nsfSongTotal');
  const nsfPlayDurationEl = document.getElementById('nsfPlayDuration');
  const nsfFileStatusEl = document.getElementById('nsfFileStatus');

  let loadedNsfBytes = null;
  let loadedNsfHeader = null;
  let nsfFileSource = null;
  let nsfPlaybackBuffer = null;   // レンダリング済み AudioBuffer
  let nsfPlaybackOffset = 0;      // 一時停止位置（秒）
  let nsfPlaybackStartTime = 0;   // 再生開始時の audioCtx.currentTime
  let nsfIsRendering = false;

  // 再生状態の種別管理
  let lastPlayMode = null; // 'nsf' | 'capture-mml'

  // duration/再生範囲終了点へ近づいた時のフェードアウト(NSF/SPC/KSS/GBS/HES共通)。
  // 5秒かけてgainNodeを0まで下げ、終了点到達と同時に無音になるようにする
  // (finishSoundFilePlayback/updateTransportUI参照)。
  const FADE_SEC = 5;
  let endFadeActive = false;

  const NSF_CHIP_NAMES = [
    ['VRC6', MML.NSF.CHIP_FLAGS.VRC6],
    ['VRC7', MML.NSF.CHIP_FLAGS.VRC7],
    ['FDS', MML.NSF.CHIP_FLAGS.FDS],
    ['MMC5', MML.NSF.CHIP_FLAGS.MMC5],
    ['N163', MML.NSF.CHIP_FLAGS.N163],
    ['FME7', MML.NSF.CHIP_FLAGS.FME7]
  ];

  function describeChips(flags) {
    const names = NSF_CHIP_NAMES.filter(([, bit]) => (flags & bit) !== 0).map(([name]) => name);
    return names.length > 0 ? names.join(', ') : T('なし (2A03のみ)');
  }

  function renderNsfFileHeader(header) {
    let out = '';
    out += `Magic OK       : ${header.magicOk}\n`;
    out += `Version        : ${header.version}\n`;
    out += `Total Songs    : ${header.totalSongs}\n`;
    out += `Starting Song  : ${header.startingSong}\n`;
    out += `Load Address   : ${toHex(header.loadAddr, 4)}\n`;
    out += `Init Address   : ${toHex(header.initAddr, 4)}\n`;
    out += `Play Address   : ${toHex(header.playAddr, 4)}\n`;
    out += `Song Name      : ${header.songName}\n`;
    out += `Artist         : ${header.artist}\n`;
    out += `Copyright      : ${header.copyright}\n`;
    out += T('NTSC Speed     : {v} (1/1,000,000秒)', { v: header.ntscSpeed }) + '\n';
    out += T('PAL Speed      : {v} (1/1,000,000秒)', { v: header.palSpeed }) + '\n';
    out += `PAL/NTSC Bit   : ${toHex(header.palNtscBit, 2)}\n`;
    out += T('拡張音源       : {chips} ({hex})',
      { chips: describeChips(header.extraChips), hex: toHex(header.extraChips, 2) }) + '\n';

    nsfFileHeaderEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = header.magicOk ? 'ok' : 'error';
    pre.textContent = out;
    nsfFileHeaderEl.appendChild(pre);
  }

  async function loadNsfFile() {
    const file = nsfFileEl.files[0];
    if (!file) return;

    stopAllFormatPlayback();
    stopNsfFilePlayback();
    keyboardDisplay.reset();
    loadedNsfBytes = null;
    loadedNsfHeader = null;

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.length < 128) {
      nsfFileHeaderEl.innerHTML = '<div class="error">' + T('ファイルサイズが小さすぎます（NSFヘッダは128バイト必要です）。') + '</div>';
      return;
    }

    const header = MML.NSF.parseHeader(bytes);
    if (!header.magicOk) {
      nsfFileHeaderEl.innerHTML = '<div class="error">' + T('NSFヘッダのマジックナンバーが不正です（NSFファイルではない可能性があります）。') + '</div>';
      return;
    }

    loadedNsfBytes = bytes;
    loadedNsfHeader = header;
    renderNsfFileHeader(header);

    const totalSongs = Math.max(1, header.totalSongs);
    nsfSongIndexEl.min = '1';
    nsfSongIndexEl.max = String(totalSongs);
    nsfSongIndexEl.value = String(Math.min(totalSongs, Math.max(1, header.startingSong || 1)));
    nsfSongTotalEl.textContent = `/ ${totalSongs}`;

    nsfFileStatusEl.innerHTML = '';
  }

  function updateNsfPlayButton() {
    const btn = document.getElementById('btnNsfFilePlay');
    btn.disabled = nsfIsRendering;
    const isPlaying = lastPlayMode === 'nsf' && activePlayer && activePlayer.isPlaying;
    btn.classList.toggle('is-playing', isPlaying);
    btn.title = isPlaying ? T('一時停止') : T('再生');
  }

  function stopNsfFilePlayback() {
    if (lastPlayMode === 'nsf' && activePlayer) {
      stopActivePlayer();
    }
    if (lastPlayMode === 'nsf') {
      nsfRollToken++; // 進行中の先読みキャプチャ結果を無効化
      keyboardDisplay.setRollTimeline(null);
    }
    nsfPlaybackOffset = 0;
    updateNsfPlayButton();
  }

  // ── 変換テンポ入力 (NSF/SPC/KSS共通) ─────────────────────────────
  // 数値入力欄が空なら自動検出。タップボタンは再生を聴きながら拍に合わせて
  // 連打するとBPMを算出して入力欄へ書き込む(2秒以上間が空くと計測リセット)。
  // 入力値は各コンバータ側で MML.Convert.refineBpm によりフレームグリッドへ
  // 吸着補正されるので、タップの±数%の誤差はそこで吸収される。
  function setupTempoControl(prefix) {
    const input = document.getElementById(`${prefix}TempoBpm`);
    const btnTap = document.getElementById(`btn${prefix[0].toUpperCase()}${prefix.slice(1)}TempoTap`);
    const btnClear = document.getElementById(`btn${prefix[0].toUpperCase()}${prefix.slice(1)}TempoClear`);
    const info = document.getElementById(`${prefix}TempoTapInfo`);
    let taps = [];

    btnTap.addEventListener('click', () => {
      const now = performance.now();
      if (taps.length > 0 && now - taps[taps.length - 1] > 2000) taps = [];
      taps.push(now);
      taps = taps.slice(-16); // 直近16タップの移動窓
      if (taps.length < 2) {
        if (info) info.textContent = T('タップ1回目… 拍に合わせて続けてタップ');
        return;
      }
      const intervals = [];
      for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
      // 中央値から大きく外れた間隔(ミスタップ)を除いて平均
      const sorted = intervals.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const good = intervals.filter(v => v > median * 0.5 && v < median * 1.5);
      const avg = good.reduce((a, b) => a + b, 0) / good.length;
      const bpm = Math.max(40, Math.min(400, Math.round(60000 / avg)));
      input.value = String(bpm);
      if (info) info.textContent = T('{n}回タップ → {bpm} BPM', { n: taps.length, bpm });
    });

    btnClear.addEventListener('click', () => {
      input.value = '';
      taps = [];
      if (info) info.textContent = T('自動検出に戻しました');
    });
  }
  setupTempoControl('nsf');
  setupTempoControl('spc');
  setupTempoControl('kss');
  setupTempoControl('gbs');
  setupTempoControl('hes');

  // 変換テンポ入力欄の値 (空/不正なら null = 自動検出)
  function getManualBpm(prefix) {
    const v = parseFloat(document.getElementById(`${prefix}TempoBpm`).value);
    return (isFinite(v) && v >= 40 && v <= 400) ? v : null;
  }

  // 最後にキャプチャした生の result (writeLog 込み) を保持
  let lastNsfCaptureResult = null;

  async function runNsf2Mml() {
    if (!loadedNsfBytes || !loadedNsfHeader) {
      nsfFileStatusEl.innerHTML = '<div class="error">' + T('先にNSFファイルを読み込んでください。') + '</div>';
      return;
    }
    if (nsfIsRendering) return;

    const totalSongs = Math.max(1, loadedNsfHeader.totalSongs);
    let songNo = parseInt(nsfSongIndexEl.value, 10) || 1;
    songNo = Math.max(1, Math.min(totalSongs, songNo));

    let result = lastNsfCaptureResult;
    // キャプチャ済み結果がなければ新規キャプチャ
    if (!result) {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const duration = parseInt(nsfPlayDurationEl.value, 10) || 30;
      nsfIsRendering = true;
      updateNsfPlayButton();
      nsfFileStatusEl.innerHTML = '<div>' + T('MML変換用レンダリング中…') + '</div>';

      result = await MML.Emu.captureSongAsync(loadedNsfBytes, {
        songIndex: songNo - 1,
        durationSeconds: duration,
        sampleRate: audioCtx.sampleRate,
        mute: {}
      });
      nsfIsRendering = false;
      updateNsfPlayButton();
      lastNsfCaptureResult = result;
    }

    nsfFileStatusEl.innerHTML = '<div>' + T('MML変換中…') + '</div>';
    // 少し待って UI を更新させる
    await new Promise(r => setTimeout(r, 10));

    const nsfManualBpm = getManualBpm('nsf');
    let converted;
    try {
      converted = MML.NSF2MML.convert(
        result.writeLog, loadedNsfBytes, loadedNsfHeader, songNo - 1, result.initRegs, result.initWrites,
        { bpm: nsfManualBpm, n163Snapshots: result.n163Snapshots });
    } catch (e) {
      nsfFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }

    // MML エディタに挿入
    mmlSourceEl.value = converted.mml;
    mmlSourceEl.dispatchEvent(new Event('input')); // シンタックスハイライト更新

    // 抽出済み波形を波形エディタへ反映(拡張音源の有効化自体はMML本文に埋め込まれた
    // #EX-*ディレクティブがコンパイル時に自動検出するため、UI側の操作は不要)
    if (converted.fdsWave && MML.WaveformEditor.fdsWave) MML.WaveformEditor.fdsWave.setData(converted.fdsWave);
    if (converted.n163Wave && MML.WaveformEditor.n163Wave) MML.WaveformEditor.n163Wave.setData(converted.n163Wave);

    // DPCM バイナリファイルをダウンロード(保存用)。同時にdpcmSampleCacheへ
    // 直接投入し、生成されたMML中の@DPCM<n>定義をユーザーがファイル再選択
    // しなくてもそのまま再生・NSF書き出しできるようにする
    for (const f of converted.dpcmFiles) {
      downloadBin(f.name, f.bytes);
      dpcmSampleCache[f.name] = f.bytes;
    }

    const dpcmMsg = converted.dpcmFiles.length > 0
      ? T('、DPCM {n} ファイル出力', { n: converted.dpcmFiles.length }) : '';
    const expMsg = converted.expansions && converted.expansions.length > 0
      ? T('、拡張音源: {chips}', { chips: converted.expansions.join(', ') }) : '';
    nsfFileStatusEl.innerHTML = '<div class="ok">' +
      T('MML変換完了 ({mode} {bpm} BPM{exp}{dpcm}) → MMLエディタに出力しました',
        { mode: nsfManualBpm ? T('指定') : T('推定'), bpm: converted.bpm, exp: expMsg, dpcm: dpcmMsg }) + '</div>';

    // 変換直後にコンパイルだけ実行し、DPCMサンプル欄/チャンネル選択欄/モニタ等の
    // 各種UIをMML本文に反映する(再生は開始しない)。
    // 新規変換された曲なので、前回再生していた曲の再生範囲(赤/青ハンドル)を
    // 引き継がず全体にリセットする(preservePlaybackRangeによる引き継ぎを無効化)
    rangeStartSec = 0;
    rangeEndSec = null;
    prepareMmlStream(true);
  }

  // Float32Array (DCブロック済み, gain適用前) → 16bit PCM WAV Blob を生成
  function buildWavBlob(samples, sampleRate, gainFactor = 1.0) {
    const numSamples = samples.length;
    const bufLen = 44 + numSamples * 2;
    const buf = new ArrayBuffer(bufLen);
    const view = new DataView(buf);
    const write4 = (off, v) => view.setUint32(off, v, true);
    const write2 = (off, v) => view.setUint16(off, v, true);
    // RIFF header
    [0x52,0x49,0x46,0x46].forEach((b,i) => view.setUint8(i, b)); // "RIFF"
    write4(4, bufLen - 8);
    [0x57,0x41,0x56,0x45].forEach((b,i) => view.setUint8(8+i, b)); // "WAVE"
    [0x66,0x6D,0x74,0x20].forEach((b,i) => view.setUint8(12+i, b)); // "fmt "
    write4(16, 16); write2(20, 1); write2(22, 1); // PCM, mono
    write4(24, sampleRate); write4(28, sampleRate * 2); // sampleRate, byteRate
    write2(32, 2); write2(34, 16); // blockAlign, bitsPerSample
    [0x64,0x61,0x74,0x61].forEach((b,i) => view.setUint8(36+i, b)); // "data"
    write4(40, numSamples * 2);
    // サンプル書き込み (clamp → int16)
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, samples[i] * gainFactor));
      view.setInt16(44 + i * 2, Math.round(s * 32767), true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // Float32Array×2 (L/R, DCブロック済み, gain適用前) → 16bit PCM interleaved stereo WAV Blob を生成
  function buildWavBlobStereo(left, right, sampleRate, gainFactor = 1.0) {
    const numSamples = left.length;
    const bufLen = 44 + numSamples * 4; // 2ch × 16bit(2byte)
    const buf = new ArrayBuffer(bufLen);
    const view = new DataView(buf);
    const write4 = (off, v) => view.setUint32(off, v, true);
    const write2 = (off, v) => view.setUint16(off, v, true);
    // RIFF header
    [0x52,0x49,0x46,0x46].forEach((b,i) => view.setUint8(i, b)); // "RIFF"
    write4(4, bufLen - 8);
    [0x57,0x41,0x56,0x45].forEach((b,i) => view.setUint8(8+i, b)); // "WAVE"
    [0x66,0x6D,0x74,0x20].forEach((b,i) => view.setUint8(12+i, b)); // "fmt "
    write4(16, 16); write2(20, 1); write2(22, 2); // PCM, stereo
    write4(24, sampleRate); write4(28, sampleRate * 4); // sampleRate, byteRate(=sampleRate*numCh*bytesPerSample)
    write2(32, 4); write2(34, 16); // blockAlign(=numCh*bytesPerSample), bitsPerSample
    [0x64,0x61,0x74,0x61].forEach((b,i) => view.setUint8(36+i, b)); // "data"
    write4(40, numSamples * 4);
    // サンプル書き込み (interleaved L,R, clamp → int16)
    for (let i = 0; i < numSamples; i++) {
      const l = Math.max(-1, Math.min(1, left[i] * gainFactor));
      const r = Math.max(-1, Math.min(1, right[i] * gainFactor));
      view.setInt16(44 + i * 4,     Math.round(l * 32767), true);
      view.setInt16(44 + i * 4 + 2, Math.round(r * 32767), true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // GBSライブ再生(GbsReplayStreamPlayer)と同じgain(2.5)+リミッタ(DynamicsCompressorNode)を
  // OfflineAudioContextでオフライン適用する(exportGbsWav用)。パラメータはgbs-stream-player.js
  // createLimiter()と完全に同じ値を使い、ライブ再生とWAV書き出しで同じ音になるようにする。
  async function applyGbsLimiterOffline(audioL, audioR, sampleRate) {
    const n = audioL.length;
    const offlineCtx = new OfflineAudioContext(2, n, sampleRate);
    const abuf = offlineCtx.createBuffer(2, n, sampleRate);
    abuf.copyToChannel(audioL, 0);
    abuf.copyToChannel(audioR, 1);
    const src = offlineCtx.createBufferSource();
    src.buffer = abuf;
    const gainNode = offlineCtx.createGain();
    gainNode.gain.value = 2.5;
    const limiter = offlineCtx.createDynamicsCompressor();
    limiter.threshold.value = -3.0;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;
    src.connect(gainNode);
    gainNode.connect(limiter);
    limiter.connect(offlineCtx.destination);
    src.start();
    const rendered = await offlineCtx.startRendering();
    return { left: rendered.getChannelData(0), right: rendered.getChannelData(1) };
  }

  async function exportNsfWav() {
    if (!loadedNsfBytes || !loadedNsfHeader) {
      nsfFileStatusEl.innerHTML = '<div class="error">' + T('先にNSFファイルを読み込んでください。') + '</div>';
      return;
    }
    if (nsfIsRendering) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const totalSongs = Math.max(1, loadedNsfHeader.totalSongs);
    let songNo = parseInt(nsfSongIndexEl.value, 10) || 1;
    songNo = Math.max(1, Math.min(totalSongs, songNo));
    const duration = parseInt(nsfPlayDurationEl.value, 10) || 30;
    const sampleRate = audioCtx.sampleRate;
    nsfIsRendering = true;
    updateNsfPlayButton();
    nsfFileStatusEl.innerHTML = '<div>' + T('WAV書き出し用レンダリング中…') + '</div>';
    const result = await MML.Emu.captureSongAsync(loadedNsfBytes, {
      songIndex: songNo - 1,
      durationSeconds: duration,
      sampleRate,
      mute: getChannelMuteConfig()
    }, (done, total) => {
      nsfFileStatusEl.innerHTML = '<div>' + T('WAV書き出し中… {pct}%', { pct: Math.round(done / total * 100) }) + '</div>';
    });
    nsfIsRendering = false;
    updateNsfPlayButton();
    const songName = (loadedNsfHeader.songName || 'output').replace(/[^\w\-]/g, '_');

    // gain=3.0 を適用したWAVを出力
    const blob = buildWavBlob(result.audio, sampleRate, 3.0);
    const filename = `${songName}_song${songNo}.wav`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);

    // 全レジスタ書き込みログを出力（フレームごと・チップ名注記付き）
    // chip 列は末尾に追加。既存の frame,addr,value 3列はそのまま残す（後方互換）。
    let csv = 'frame,addr,value,chip\n';
    result.writeLog.forEach((writes, f) => {
      writes.forEach(w => {
        csv += `${f},0x${w.addr.toString(16).toUpperCase()},0x${w.value.toString(16).toUpperCase().padStart(2,'0')},${regChipName(w.addr)}\n`;
      });
    });
    const logBlob = new Blob([csv], { type: 'text/csv' });
    const logUrl = URL.createObjectURL(logBlob);
    const b = document.createElement('a');
    b.href = logUrl; b.download = `${songName}_song${songNo}_regs.csv`; b.click();
    URL.revokeObjectURL(logUrl);

    // 有効音源リスト（2A03 + ヘッダの拡張音源フラグ）
    const activeChips = ['2A03'].concat(
      chipsFromExtraFlags(loadedNsfHeader.extraChips || 0).map(c => c.toUpperCase()));
    nsfFileStatusEl.innerHTML = '<div class="ok">' +
      T('WAV + レジスタログ書き出し完了: {file}<br>音源: {chips}',
        { file: filename, chips: activeChips.join(', ') }) + '</div>';
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function downloadBin(filename, bytes) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function playNsfStream() {
    if (!loadedNsfBytes || !loadedNsfHeader) {
      nsfFileStatusEl.innerHTML = '<div class="error">' + T('先にNSFファイルを読み込んでください。') + '</div>';
      return;
    }

    // 再生中なら一時停止 / 一時停止中なら再開
    if (activePlayer && lastPlayMode === 'nsf') {
      if (activePlayer.isPlaying) {
        transportPause();
      } else {
        transportPlay();
      }
      return;
    }

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const totalSongs = Math.max(1, loadedNsfHeader.totalSongs);
    let songNo = parseInt(nsfSongIndexEl.value, 10) || 1;
    songNo = Math.max(1, Math.min(totalSongs, songNo));
    nsfSongIndexEl.value = String(songNo);

    const duration    = parseInt(nsfPlayDurationEl.value, 10) || 30;
    const totalFrames = Math.ceil(duration * MML.Emu.FRAME_RATE_NTSC);

    // 既存の再生を停止(他フォーマットの先読みキャプチャも止める。走らせたままだとNSFの
    // ピアノロールを他フォーマットの結果で上書きしてしまう)
    stopAllFormatPlayback();
    stopVoiceMonitor();
    capturedBuffer       = null;
    lastNsfCaptureResult = null;
    lastPlayMode         = 'nsf';
    nsfBufferedFraction  = 0;
    updateSeekBufferedUI();

    // NSF実ファイル再生は、6502を実際に駆動するバックグラウンドキャプチャ(regsOnly、
    // ピアノロールと共用)を1本だけ走らせ、実際の音声はそのwriteLogをNsfReplayStreamPlayerが
    // (CPUを動かさず)再生する。以前はライブ再生用の別プレイヤーとロール先読みキャプチャが
    // 同時に2本の6502エミュレーションを回しており、これがNSF/KSS再生開始直後のカクつきの
    // 原因だった。副産物としてシーク・再生中のライブミュートにも対応できる
    // (MmlStreamPlayerと同じ「書き込みログをCPU無しで再生する」方式のため)。
    const player = new MML.Audio.NsfReplayStreamPlayer(audioCtx);
    player._baseGain = player.gainNode.gain.value;
    endFadeActive = false;
    player.onEnded = () => {
      if (transportRaf) cancelAnimationFrame(transportRaf);
      updateNsfPlayButton();
      updateTransportUI();
      // durationちょうどで曲が自然終了した場合、内部プレイヤーのこの通知がupdateTransportUI()の
      // rAFポーリング(pos>=duration)より先に発火しisPlaying=falseへ変わるため、そちらの
      // finishSoundFilePlayback()呼び出しが実質発火しない(レース)。ここでも呼んでおく
      // (setTimeoutで一度onaudioprocessコールバックのスタックを抜けてから実行する)。
      setTimeout(() => { if (currentTransportPlayer() === player) finishSoundFilePlayback(); }, 0);
    };
    // 10秒連続無音を検出したら(SILENCE_SEC、stream-player.js)、1秒待ってから次の曲へ
    // 進む(既に無音のためフェードは不要)。setTimeout発火時点でこのplayerがまだ
    // アクティブか確認し、その間にユーザーが手動で操作していたら何もしない。
    player.onSilenceTimeout = () => {
      setTimeout(() => {
        if (currentTransportPlayer() !== player) return;
        stopNsfFilePlayback();
        autoAdvanceNsfSong();
      }, 1000);
    };
    activePlayer    = player;
    player.setSpeed(currentSpeedFactor);
    workletDuration = duration;

    nsfFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = T('曲 {song} / {total}  再生時間: {time}',
      { song: songNo, total: totalSongs, time: formatTime(duration) });
    nsfFileStatusEl.appendChild(pre);

    resetPlaybackRangeToFull(duration);
    seekBarEl.value = '0';
    timeDisplayEl.textContent = `00:00 / ${formatTime(duration)}`;

    const captureChips = chipsFromExtraFlags(loadedNsfHeader.extraChips || 0);
    resetN163Max();

    // バックグラウンドキャプチャ(regsOnly、CPU実行あり)。ピアノロールと実再生の両方の
    // 情報源を兼ねる。onProgressで途中経過(その時点までのregSnapshots/writeLog、進行中の
    // 配列への参照なので以後キャプチャが進むにつれ自動的に埋まっていく)を受け取り、
    // 最初の1回でplayer.load()して再生を開始する(以降のチャンクを待つ必要はない)。
    // ★ロール再構築(setRollTimelineFromRegSnapshots内のO(全フレーム)走査)は
    // SPC/KSSと同じ理由で間引く(onProgress自体は音切れ防止のため高頻度のまま)。
    const ROLL_REBUILD_INTERVAL_FRAMES = 120;
    const myNsfRollToken = ++nsfRollToken;
    const nsfSamplesPerFrame = audioCtx.sampleRate / MML.Emu.FRAME_RATE_NTSC;
    let lastNsfRollBuiltFrame = 0;
    let nsfPlaybackLoaded = false;
    MML.Emu.captureSongAsync(loadedNsfBytes, {
      songIndex: songNo - 1, durationSeconds: duration, sampleRate: audioCtx.sampleRate,
      regsOnly: true,
      shouldCancel: () => myNsfRollToken !== nsfRollToken
    }, (done, total, regSnapshots, writeLog, n163Snapshots, initRegs, initWrites) => {
      if (myNsfRollToken !== nsfRollToken) return; // 曲切替/停止で無効化済み

      if (!nsfPlaybackLoaded) {
        nsfPlaybackLoaded = true;
        player.load(loadedNsfBytes, songNo - 1, totalFrames,
          { writeLog, initWrites, initRegs, n163Snapshots }, getChannelMuteConfig());

        // 鍵盤表示のライブ現在値表示用(常に「今の」レジスタ状態を反映する専用スナップショット。
        // ピアノロール=曲全体の先読みタイムラインとは別物)
        const liveSnap = {};
        Object.assign(liveSnap, initRegs || {});
        liveSnap[0x4015] = 0x0F; // initSong は bus.write を経由しないため手動補完
        player.setOnWrite((addr, value) => { liveSnap[addr] = value; });
        setMonitorSource({
          regSnapshots: [liveSnap], // totalFrames=1 にして常に liveSnap[0] を参照
          totalFrames: 1,
          samplesPerFrame: nsfSamplesPerFrame,
          sampleRate: audioCtx.sampleRate,
          writeLog: [],
          cpuSnapshots: null,
          memSnapshots: null,
          initRegs: liveSnap,
          getApuEnv: liveApuEnv, // 音量表示にハードウェアエンベロープ実出力を反映
          getN163: liveN163,     // N163はライブチップのRAMから直接スナップショット
          getFME7: liveFME7,     // FME-7もライブチップから(ラッチ式で復元不可)
          getMmc5: liveMMC5,     // MMC5もライブ(エンベロープ/PCM反映)
          getVRC7: liveVRC7      // VRC7もライブ(周波数/音量/FM波形)
        }, () => activePlayer ? activePlayer.getPosition() : 0, captureChips);

        transportPlay();
      }

      nsfBufferedFraction = total > 0 ? done / total : 0;
      updateSeekBufferedUI();

      if (done - lastNsfRollBuiltFrame < ROLL_REBUILD_INTERVAL_FRAMES && done < total) return;
      lastNsfRollBuiltFrame = done;
      keyboardDisplay.setRollTimelineFromRegSnapshots(
        regSnapshots, writeLog, done, nsfSamplesPerFrame, audioCtx.sampleRate, captureChips, n163Snapshots
      );
    }).catch(() => { /* 先読みキャプチャ失敗時は再生を開始できない */ });
  }

  function changeNsfSong(delta) {
    if (!loadedNsfHeader) return;
    const totalSongs = Math.max(1, loadedNsfHeader.totalSongs);
    let songNo = parseInt(nsfSongIndexEl.value, 10) || 1;
    songNo = Math.max(1, Math.min(totalSongs, songNo + delta));
    nsfSongIndexEl.value = String(songNo);
    // 曲が変わるので Worklet を停止して最初からストリーミング
    stopNsfFilePlayback();
    lastNsfCaptureResult = null;
    playNsfStream();
  }

  nsfFileEl.addEventListener('change', loadNsfFile);
  document.getElementById('btnNsfFilePlay').addEventListener('click', playNsfStream);
  document.getElementById('btnNsfFileStop').addEventListener('click', stopNsfFilePlayback);
  document.getElementById('btnNsfExportWav').addEventListener('click', exportNsfWav);
  document.getElementById('btnNsf2Mml').addEventListener('click', runNsf2Mml);
  document.getElementById('btnNsfSongPrev').addEventListener('click', () => changeNsfSong(-1));
  document.getElementById('btnNsfSongNext').addEventListener('click', () => changeNsfSong(1));
  nsfSongIndexEl.addEventListener('change', () => {
    if (!loadedNsfHeader) return;
    const totalSongs = Math.max(1, loadedNsfHeader.totalSongs);
    let songNo = parseInt(nsfSongIndexEl.value, 10) || 1;
    songNo = Math.max(1, Math.min(totalSongs, songNo));
    nsfSongIndexEl.value = String(songNo);
    stopNsfFilePlayback();
    lastNsfCaptureResult = null;
    if (loadedNsfBytes) playNsfStream();
  });

  document.getElementById('btnDpcmConvert').addEventListener('click', convertDpcm);
  document.getElementById('btnDpcmPreview').addEventListener('click', previewDpcm);
  document.getElementById('btnDpcmStop').addEventListener('click', stopPreview);
  document.getElementById('btnDpcmDownload').addEventListener('click', downloadDpcm);

  document.getElementById('btnMmlExportNsf').addEventListener('click', exportMmlNsf);
  document.getElementById('btnMmlCapture').addEventListener('click', () => {
    const playing = activePlayer ? activePlayer.isPlaying : transportPlaying;
    if (playing) transportPause();
    else if (!mmlPlaybackStopped) transportPlay(); // 一時停止中: 再コンパイルせずその位置から再開
    else runMmlStream(); // 停止中: 再コンパイルして最初(または再生範囲開始点)から再生
  });
  document.getElementById('btnTransportStop').addEventListener('click', transportStop);
  document.getElementById('btnRangeReset').addEventListener('click', () => resetPlaybackRangeToFull(currentDuration()));
  seekBarEl.addEventListener('input', () => {
    if (currentTransportPlayer()) {
      if (lastPlayMode === 'capture-mml' || lastPlayMode === 'nsf' || lastPlayMode === 'kss' || lastPlayMode === 'spc' || lastPlayMode === 'gbs' || lastPlayMode === 'hes') {
        let frac = parseInt(seekBarEl.value, 10) / SEEK_RESOLUTION;
        // NSF/KSS/SPC実ファイル再生はバックグラウンドキャプチャが追いついた範囲までしか
        // シークできない。プレイヤー側の内部クランプ(NsfReplayStreamPlayer.seek()/
        // KssReplayStreamPlayer.seek())だけに任せると、ユーザーがバッファより先へ
        // ドラッグした「つもり」のまま実際は手前へ戻っていて無音状態になり「シークすると
        // 止まる」ように見えるため、ここでハンドル自体をバッファ済み範囲より先へ
        // 動かせないようにスナップバックする。
        const bufferedFrac = currentBufferedFraction();
        if (bufferedFrac !== null && frac > bufferedFrac) {
          frac = bufferedFrac;
          seekBarEl.value = String(Math.round(frac * SEEK_RESOLUTION));
        }
        transportSeek(frac * workletDuration);
      }
      return;
    }
    if (!capturedBuffer) return;
    const frac = parseInt(seekBarEl.value, 10) / SEEK_RESOLUTION;
    transportSeek(frac * capturedBuffer.duration);
  });

  // ── SPC ファイル読み込み・再生 ────────────────────────────────────
  const spcFileEl       = document.getElementById('spcFile');
  const spcFileHeaderEl = document.getElementById('spcFileHeader');
  const spcPlayDurEl    = document.getElementById('spcPlayDuration');
  const spcFileStatusEl = document.getElementById('spcFileStatus');

  let loadedSpcBytes  = null;
  let loadedSpcHeader = null;
  let spcIsRendering  = false;
  let spcActivePlayer = null; // SpcReplayStreamPlayer

  function renderSpcHeader(h) {
    let out = '';
    out += `Magic OK    : ${h.magicOk}\n`;
    out += `PC          : ${toHex(h.pc, 4)}\n`;
    out += `A=${toHex(h.a,2)}  X=${toHex(h.x,2)}  Y=${toHex(h.y,2)}  PSW=${toHex(h.psw,2)}  SP=${toHex(h.sp,2)}\n`;
    out += T('ID666       : {v}', { v: h.hasId666 ? T('あり') : T('なし') }) + '\n';
    if (h.id666) {
      const id = h.id666;
      if (id.songTitle)  out += T('曲名        : {v}', { v: id.songTitle }) + '\n';
      if (id.gameTitle)  out += T('ゲーム      : {v}', { v: id.gameTitle }) + '\n';
      if (id.artistName) out += T('アーティスト: {v}', { v: id.artistName }) + '\n';
      if (id.dumperName) out += T('ダンパー    : {v}', { v: id.dumperName }) + '\n';
      if (id.comments)   out += T('コメント    : {v}', { v: id.comments }) + '\n';
      if (id.dumpDate)   out += T('ダンプ日    : {v}', { v: id.dumpDate }) + '\n';
      if (id.playSeconds) out += T('推奨再生時間: {v} 秒', { v: id.playSeconds }) + '\n';
    }
    spcFileHeaderEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = h.magicOk ? 'ok' : 'error';
    pre.textContent = out;
    spcFileHeaderEl.appendChild(pre);
  }

  async function loadSpcFile() {
    const file = spcFileEl.files[0];
    if (!file) return;
    stopAllFormatPlayback();
    keyboardDisplay.reset();
    loadedSpcBytes = null; loadedSpcHeader = null;
    // SPCのボイスミュートはkeyboardDisplay._muteStateを経由しない専用機構(spcMutedVoices
    // ビットマスク)のため、reset()の_muteState.clear()だけではクリアされない。新しい
    // ファイルを開いたらこちらも同様にクリアする(他フォーマットと同じ方針、changeSpcTrack
    // 相当の概念が無いSPCでも「新規ファイルではミュートを引き継がない」を揃える)。
    spcMutedVoices = 0;
    for (let ch = 0; ch < 8; ch++) updateMuteButton(ch, spcMutedVoices);

    const buf   = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    try {
      const h = MML.SPC.parseHeader(bytes);
      if (!h.magicOk) {
        spcFileHeaderEl.innerHTML = '<div class="error">' + T('SPC ヘッダが不正です。') + '</div>';
        return;
      }
      loadedSpcBytes  = bytes;
      loadedSpcHeader = h;
      renderSpcHeader(h);
      // 推奨再生時間(ID666)を再生時間欄へ反映
      const recSec = h.id666 && h.id666.playSeconds;
      if (recSec) {
        const min = parseInt(spcPlayDurEl.min, 10) || 1;
        const max = parseInt(spcPlayDurEl.max, 10) || 3600;
        spcPlayDurEl.value = String(Math.max(min, Math.min(max, recSec)));
      }
      spcFileStatusEl.innerHTML = '';
    } catch (e) {
      spcFileHeaderEl.innerHTML = '<div class="error">' + T('読み込みエラー: {msg}', { msg: e.message }) + '</div>';
    }
  }

  function stopSpcPlayback() {
    if (spcActivePlayer) {
      spcActivePlayer.destroy();
      spcActivePlayer = null;
    }
    spcRollToken++; // 進行中の先読みキャプチャ結果を無効化
    keyboardDisplay.setRollTimeline(null);
    updateSpcPlayButton();
  }

  function updateSpcPlayButton() {
    const btn = document.getElementById('btnSpcFilePlay');
    if (!btn) return;
    const playing = spcActivePlayer && spcActivePlayer.isPlaying;
    btn.classList.toggle('is-playing', !!playing);
    btn.title = playing ? T('一時停止') : T('再生');
    btn.disabled    = spcIsRendering;
  }

  // SPC captureAsync() の結果(log)からピアノロール用タイムライン(共通形状)を構築する。
  // SPCは完全リアルタイム合成で先読みデータを持たないため、再生開始と同時に裏で
  // captureAsync を走らせ、完了次第このタイムラインを keyboardDisplay へ反映する。
  //
  // MML.SPC2MML.extractVoiceEvents(MML変換のconvert()と共用)をそのまま使う。ロールは
  // MML変換の出力を目で確認できる「デバッガ」的な役割も持たせたいため、ロール専用の
  // 抽出ロジックを別途持たず、MML変換と全く同じ抽出結果を描画する(ポルタメント/レガート
  // 対応はextractVoiceEvents側で行う。src/spc2mml/converter.js参照)。
  function buildSpcRollTimeline(log, frameRate, srcnFineTune) {
    const frameDur = 1 / frameRate;
    // MML変換と同じ原音チューニング補正を渡し、ロール表示の音程も実機発音に一致させる
    // (ロール=MML変換デバッガの方針。補正マップは再生開始時に一度だけ算出して使い回す)。
    const voiceEvents = MML.SPC2MML.extractVoiceEvents(log, { srcnFineTune });
    return voiceEvents.map((events, ch) => ({
      id: `V${ch}`,
      color: `hsl(${ch * 45},90%,65%)`,
      notes: events
        .filter(e => e.pitchSemi !== null)
        // 音量シェーディング用の簡易近似: ADSRモード(adsr1 bit7=1)ならサスティンレベル(adsr2 bit5-7、
        // 0-7)を目安の音量とする。GAINモード(直接指定)は減衰カーブを追わず常に最大音量扱い。
        // pitchSemi は note-number 空間(57=A4=MIDI69)なので MIDI へは +12。
        // 従来 +9 になっており、ロールがNSF/実機より3半音低く表示されていた
        // (KSSロールの midi:e.note+12 と不整合。src/main.js buildKssRollTimeline参照)。
        .map(e => {
          // freqSeq(セント偏差オーバーレイ用): DSPピッチレジスタ(pitch=0x1000で原音32kHz)を
          // pitchToSemitone(src/spc2mml/converter.js)と同じ式でHzへ変換する。
          // continuousSemi(57基準)=12*log2(pitch/0x1000)+tune+60 → freq=440*2^((continuousSemi-57)/12)
          // = 440*(pitch/0x1000)*2^((tune+3)/12)。tuneはpitchSemi算出時と同じサンプル別チューニング。
          const tune = (srcnFineTune && srcnFineTune[e.srcn]) || 0;
          const tuneFactor = Math.pow(2, (tune + 3) / 12);
          return {
            startSec: e.frame * frameDur, endSec: (e.frame + e.len) * frameDur, midi: e.pitchSemi + 12,
            vol: (e.adsr1 & 0x80) ? (((e.adsr2 >> 5) & 7) / 7) : 1,
            freqSeq: (e.pitchSeq || []).map(p => 440 * (p / 4096) * tuneFactor),
          };
        }),
    }));
  }

  function playSpcStream() {
    if (!loadedSpcBytes) {
      spcFileStatusEl.innerHTML = '<div class="error">' + T('先にSPCファイルを読み込んでください。') + '</div>';
      return;
    }
    // 再生中なら一時停止 / 一時停止中なら再開
    if (spcActivePlayer && lastPlayMode === 'spc') {
      if (spcActivePlayer.isPlaying) transportPause();
      else transportPlay();
      return;
    }

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // 他フォーマットの再生と先読みキャプチャを止める(ロールの取り違え防止)
    transportStop();
    stopAllFormatPlayback();
    invalidateOtherRollPrefetch('spc');
    lastPlayMode = 'spc';
    spcBufferedFraction = 0;
    updateSeekBufferedUI();

    const duration = parseInt(spcPlayDurEl.value, 10) || 180;

    // NSF/KSS実ファイル再生と同じ理由(二重エミュレーション解消・シーク・再生中ライブミュート
    // 対応)で、ライブ再生用プレイヤーとロール先読みキャプチャを1本のバックグラウンド
    // キャプチャに統合する(NsfReplayStreamPlayer/KssReplayStreamPlayerと対になる
    // SpcReplayStreamPlayer、src/audio/spc-stream-player.js)。ただしSPCはNSF/KSSと違い
    // regsOnly相当の軽量ショートカットが存在せず(MML.SPC2MML.captureAsyncは元から
    // CPU+DSPフル駆動の実コスト計算)、今回の統合の主眼は「軽量化」ではなく「ライブ
    // 再生用と先読み用の2本を同時に走らせてCPUを食い合っていたのを1本にまとめる」こと。
    const player = new MML.Audio.SpcReplayStreamPlayer(audioCtx);
    player._baseGain = player.gainNode.gain.value;
    endFadeActive = false;
    player.onEnded = () => {
      updateSpcPlayButton();
      updateTransportUI();
      // NsfReplayStreamPlayerと同じレース対策(onEnded参照)。SPCは曲送りが無いので停止のみ。
      setTimeout(() => { if (currentTransportPlayer() === player) finishSoundFilePlayback(); }, 0);
    };
    spcActivePlayer = player;
    player.setSpeed(currentSpeedFactor);
    workletDuration = duration;

    resetPlaybackRangeToFull(duration);
    seekBarEl.value = '0';
    timeDisplayEl.textContent = `00:00 / ${formatTime(duration)}`;

    const id = loadedSpcHeader.id666;
    const title = (id && id.songTitle) ? id.songTitle : T('(無題)');
    spcFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = T('再生中: {title}  (最大 {time})', { title, time: formatTime(duration) });
    spcFileStatusEl.appendChild(pre);

    // 原音チューニング補正マップを一度だけ算出(BRRサンプルは曲頭から不変なので、ごく短い
    // キャプチャで全サンプルを収集できる)。ロール再構築ごとに再計算しないよう使い回す。
    let spcFineTune = null;
    try {
      spcFineTune = MML.SPC2MML.computeSrcnFineTune(MML.SPC2MML.capture(loadedSpcBytes, 0.05).brrSamples);
    } catch (_) { /* 失敗時は補正なし(従来動作)で続行 */ }
    // ライブ鍵盤(updateVoiceMonitor)も同じ補正で表示するため共有する
    spcActiveFineTune = spcFineTune;

    // バックグラウンドキャプチャ。ピアノロールと実再生の両方の情報源を兼ねる。
    // onProgressで途中経過(その時点までのframeLog、進行中の配列への参照なので以後
    // キャプチャが進むにつれ自動的に埋まっていく)を受け取り、最初の1回でplayer.load()
    // して再生を開始する(以降のチャンクを待つ必要はない)。
    //
    // ★ロール再構築(setRollTimeline内のO(全フレーム)走査)は従来通り間引く(onProgress
    // 自体は音切れ防止のため高頻度のまま、captureAsync自体のyield頻度は変えない)。
    const ROLL_REBUILD_INTERVAL_FRAMES = 120;
    keyboardDisplay.setRollTimeline(null);
    const myRollToken = ++spcRollToken;
    let lastRollBuiltFrame = 0;
    let spcPlaybackLoaded = false;
    MML.SPC2MML.captureAsync(loadedSpcBytes, duration, (frame, frames, frameLog) => {
      if (myRollToken !== spcRollToken) return; // 曲切替/停止で無効化済み

      if (!spcPlaybackLoaded) {
        spcPlaybackLoaded = true;
        player.load(loadedSpcBytes, frames, frameLog, spcMutedVoices);
        transportPlay();
      }

      spcBufferedFraction = frames > 0 ? frame / frames : 0;
      updateSeekBufferedUI();

      if (frame - lastRollBuiltFrame < ROLL_REBUILD_INTERVAL_FRAMES && frame < frames) return;
      lastRollBuiltFrame = frame;
      keyboardDisplay.setRollTimeline(buildSpcRollTimeline(frameLog.slice(0, frame), MML.SPC2MML.FRAME_RATE, spcFineTune));
    }, () => myRollToken !== spcRollToken).catch((e) => {
      // 先読み失敗時はピアノロールなしで続行するが、原因を追えるようログには残す
      console.error('SPC先読みキャプチャに失敗:', e);
    });
  }

  // DSP レジスタ番号 → 人間可読名
  function dspRegName(reg) {
    reg &= 0x7F;
    const ch = reg >> 4, r = reg & 0x0F;
    const VOICE_REGS = ['VOLL','VOLR','PITCHL','PITCHH','SRCN','ADSR1','ADSR2','GAIN','ENVX','OUTX'];
    if (ch < 8 && r < VOICE_REGS.length) return `V${ch}_${VOICE_REGS[r]}`;
    const GLOBAL = {
      0x0C:'MVOLL', 0x1C:'MVOLR', 0x2C:'EVOLL', 0x3C:'EVOLR',
      0x4C:'KON',   0x5C:'KOFF',  0x6C:'FLG',   0x7C:'ENDX',
      0x0D:'EFB',   0x2D:'PMON',  0x3D:'NON',   0x4D:'EON',
      0x5D:'DIR',   0x6D:'ESA',   0x7D:'EDL',
    };
    if (GLOBAL[reg]) return GLOBAL[reg];
    // FIR係数 C0-C7
    if ((reg & 0x0F) === 0x0F && ch < 8) return `FIR_C${ch}`;
    return `REG_${reg.toString(16).toUpperCase().padStart(2,'0')}`;
  }

  async function exportSpcWav() {
    if (!loadedSpcBytes) {
      spcFileStatusEl.innerHTML = '<div class="error">' + T('先にSPCファイルを読み込んでください。') + '</div>';
      return;
    }
    if (spcIsRendering) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const duration   = parseInt(spcPlayDurEl.value, 10) || 180;
    const sampleRate = audioCtx.sampleRate;
    const DSP_RATE   = 32000;

    spcIsRendering = true;
    updateSpcPlayButton();
    spcFileStatusEl.innerHTML = '<div>' + T('WAV書き出し中… 0%') + '</div>';
    await new Promise(r => setTimeout(r, 0));

    let   player       = new MML.Emu.SpcPlayer(loadedSpcBytes);
    player.dsp.mutedVoices = spcMutedVoices;  // ミュート状態を WAV 書き出しに反映
    const totalDspSmp  = duration * DSP_RATE;
    const totalOutSmp  = Math.round(duration * sampleRate);
    const audioL       = new Float32Array(totalOutSmp);
    const audioR       = new Float32Array(totalOutSmp);

    // ── DSP 書き込みログ収集 ──────────────────────────────────────
    // KONイベントのみ全期間記録 + 先頭 LOG_SEC 秒分の詳細ログ
    const LOG_SEC      = Math.min(duration, 30);
    const LOG_DSP_LIMIT = LOG_SEC * DSP_RATE;
    const dspWriteLog  = []; // { dspSample, reg, name, val }
    let   logDspCount  = 0;

    // コールバックを変数化（再起動時に再アタッチできるよう）
    const busOnWrite = (addr, val) => {
      if (logDspCount < LOG_DSP_LIMIT) {
        if (addr === 0x00F1) { // CONTROL: bit0-2=タイマー有効
          dspWriteLog.push({
            dspSample: logDspCount,
            timeSec:   (logDspCount / DSP_RATE).toFixed(4),
            reg: 0x1FF, name: 'BUS_$F1_CTRL', val,
          });
        }
        // RAM[$0080-$009F] への書き込み追跡（ボイス新規ノートフラグ）
        if (addr >= 0x0080 && addr <= 0x009F && logDspCount < LOG_DSP_LIMIT) {
          dspWriteLog.push({
            dspSample: logDspCount,
            timeSec:   (logDspCount / DSP_RATE).toFixed(4),
            reg: 0x213, name: 'RAM80_WR',
            val: (addr << 8) | val,
          });
        }
        // SPC CPU → SNES 方向の I/O ポート書き込み（ドライバがコマンドに応答する値）
        if (addr >= 0x00F4 && addr <= 0x00F7) {
          dspWriteLog.push({
            dspSample: logDspCount,
            timeSec:   (logDspCount / DSP_RATE).toFixed(4),
            reg: 0x200 + (addr - 0x00F4), name: `SPC_WR_$F${addr - 0x00F0}`, val,
          });
        }
      }
    };
    player.bus.onWrite = busOnWrite;

    // $FD タイマー読み取りをログ（先頭 1 秒のみ、非ゼロのみ）
    const LOG_READ_LIMIT = 1 * DSP_RATE;
    let dpPtrRdCount = 0;
    const busOnRead = (addr, val) => {
      if (logDspCount >= LOG_READ_LIMIT) return;
      // $FD: タイマー0カウンタ読み取り（非ゼロのみ記録）
      if (addr === 0x00FD && val !== 0) {
        dspWriteLog.push({
          dspSample: logDspCount,
          timeSec:   (logDspCount / DSP_RATE).toFixed(4),
          reg: 0x210, name: 'BUS_RD_$FD_timer', val,
        });
      }
      // DP 音楽ポインタ ($0030-$003F) と $0080-$00C0 の読み取り（最初の 30 件）
      if (addr >= 0x0030 && addr <= 0x00C0 && dpPtrRdCount < 30) {
        dpPtrRdCount++;
        dspWriteLog.push({
          dspSample: logDspCount,
          timeSec:   (logDspCount / DSP_RATE).toFixed(4),
          reg: 0x212, name: 'DP_PTR_RD',
          val: (addr << 8) | val,
        });
      }
    };
    player.bus.onRead = busOnRead;

    const dspOnWrite = (reg, val) => {
      if (logDspCount < LOG_DSP_LIMIT) {
        dspWriteLog.push({
          dspSample: logDspCount,
          timeSec:   (logDspCount / DSP_RATE).toFixed(4),
          reg,
          name: dspRegName(reg),
          val,
        });
      }
    };

    player.dsp.onWrite = dspOnWrite;

    // ── チャンクごとにレンダリング (UIフリーズ防止) ────────────────
    const CHUNK_DSP    = DSP_RATE;          // 1秒ごとに yield
    let   dspFrac      = 0;
    let   lastL = 0, lastR = 0;
    let   outPos       = 0;
    let   dspDone      = 0;

    while (dspDone < totalDspSmp && outPos < totalOutSmp) {
      const chunkEnd = Math.min(dspDone + CHUNK_DSP, totalDspSmp);

      // 1チャンク分レンダリング
      while (dspDone < chunkEnd && outPos < totalOutSmp) {
        dspFrac += DSP_RATE / sampleRate;
        while (dspFrac >= 1.0) {
          // STOP/SLEEP でハルトしたら初期状態から再起動してループ
          if (player.isHalted) {
            dspWriteLog.push({
              dspSample: logDspCount,
              timeSec:   (logDspCount / DSP_RATE).toFixed(4),
              reg: 0x1FD, name: 'CPU_HALT_RESTART',
              val: player.cpu.PC,
            });
            player.bus.onWrite = null;
            player.dsp.onWrite = null;
            player.bus.onRead  = null;
            player = new MML.Emu.SpcPlayer(loadedSpcBytes);
            player.dsp.mutedVoices = spcMutedVoices;  // ループ再起動時もミュート引き継ぎ
            player.bus.onWrite = busOnWrite;
            player.dsp.onWrite = dspOnWrite;
            player.bus.onRead  = busOnRead;
          }
          const s = player.renderSample();
          lastL = s.L; lastR = s.R;
          dspFrac  -= 1.0;
          // 毎秒 CPU PC をスナップショット（どこでCPUが止まるか追跡）
          if (logDspCount % DSP_RATE === 0) {
            const sec = logDspCount / DSP_RATE;
            dspWriteLog.push({
              dspSample: logDspCount,
              timeSec: sec.toFixed(4),
              reg: 0x1FE, name: `CPU_PC_t${sec}s`,
              val: player.cpu.PC,
            });
          }
          if (logDspCount === LOG_READ_LIMIT) player.bus.onRead = null;
          logDspCount++;
          dspDone++;
        }
        audioL[outPos] = lastL; audioR[outPos] = lastR; outPos++;
      }

      // 進捗更新
      const pct = Math.round(dspDone / totalDspSmp * 100);
      spcFileStatusEl.innerHTML = '<div>' + T('WAV書き出し中… {pct}%', { pct }) + '</div>';
      await new Promise(r => setTimeout(r, 0));
    }

    spcIsRendering = false;
    updateSpcPlayButton();

    const id   = loadedSpcHeader.id666;
    const name = ((id && id.songTitle) ? id.songTitle : 'spc_output')
                   .replace(/[^\w\-]/g, '_');

    // ── WAV 出力 ─────────────────────────────────────────────────
    // ガウシアン補間の修正で DSP 出力が本来レベルに戻ったため、ライブ再生の
    // gainNode と同じく 2.0 に下げてクリップを防ぐ（旧値 3.0）。
    // VOL_L/VOL_R($x2/$x3)を反映したステレオ出力。
    const wavBlob = buildWavBlobStereo(audioL, audioR, sampleRate, 2.0);
    const wavUrl  = URL.createObjectURL(wavBlob);
    const wa = document.createElement('a');
    wa.href = wavUrl; wa.download = `${name}.wav`; wa.click();
    URL.revokeObjectURL(wavUrl);

    // ── DSP レジスタログ CSV 出力 ─────────────────────────────────
    // ヘッダ: 初期DSPレジスタ状態サマリ
    let csv = '# SPC DSP Register Write Log\n';
    csv += `# File: ${name}.spc  Duration: ${duration}s  LogRange: 0-${LOG_SEC}s\n`;
    csv += '#\n';
    // I/O ポート初期状態（診断用）
    csv += '# === Initial I/O Port State (RAM dump values used for ioPorts) ===\n';
    const ramDump = MML.SPC.getRam(loadedSpcBytes);
    for (let p = 0; p < 4; p++) {
      csv += `# RAM[$F${4+p}] = 0x${ramDump[0x00F4+p].toString(16).toUpperCase().padStart(2,'0')} (${ramDump[0x00F4+p]})  → ioPorts[${p}] initialized to this value\n`;
    }
    csv += '#\n';
    csv += '# === Initial DSP Register State ===\n';
    const dspRegsInit = MML.SPC.getDspRegs(loadedSpcBytes);
    for (let r = 0; r < 128; r++) {
      if (dspRegsInit[r] !== 0) {
        csv += `# REG[${r.toString(16).toUpperCase().padStart(2,'0')}] ${dspRegName(r)} = 0x${dspRegsInit[r].toString(16).toUpperCase().padStart(2,'0')} (${dspRegsInit[r]})\n`;
      }
    }
    csv += '#\n';

    // KON イベントサマリ（各ボイスのピッチも付記）
    const konEvents = dspWriteLog.filter(e => e.name === 'KON' && e.val !== 0);
    csv += `# KON events (first ${LOG_SEC}s): ${konEvents.length}\n`;
    // ログ中の直近ピッチを追跡
    const lastPitch = new Array(8).fill(0);
    const lastSrcn  = new Array(8).fill(0);
    for (const e of dspWriteLog) {
      const ch = e.reg >> 4;
      if (ch < 8) {
        if ((e.reg & 0x0F) === 0x02) lastPitch[ch] = (lastPitch[ch] & 0x3F00) | e.val;
        if ((e.reg & 0x0F) === 0x03) lastPitch[ch] = (lastPitch[ch] & 0x00FF) | ((e.val & 0x3F) << 8);
        if ((e.reg & 0x0F) === 0x04) lastSrcn[ch]  = e.val;
      }
      if (e.name === 'KON' && e.val !== 0) {
        for (let ch2 = 0; ch2 < 8; ch2++) {
          if (e.val & (1 << ch2)) {
            csv += `#   t=${e.timeSec}s  Voice${ch2} KON  pitch=0x${lastPitch[ch2].toString(16).toUpperCase().padStart(4,'0')}  srcn=${lastSrcn[ch2]}\n`;
          }
        }
      }
    }
    csv += '#\n';

    // 書き込みログ本体
    csv += 'time_sec,dsp_sample,reg_hex,reg_name,value_hex,value_dec\n';
    for (const e of dspWriteLog) {
      csv += `${e.timeSec},${e.dspSample},0x${e.reg.toString(16).toUpperCase().padStart(2,'0')},${e.name},0x${e.val.toString(16).toUpperCase().padStart(2,'0')},${e.val}\n`;
    }

    const csvBlob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const csvUrl  = URL.createObjectURL(csvBlob);
    const ca = document.createElement('a');
    ca.href = csvUrl; ca.download = `${name}_dsp_log.csv`; ca.click();
    URL.revokeObjectURL(csvUrl);

    const totalWrites = dspWriteLog.length;
    const konCount    = konEvents.length;
    spcFileStatusEl.innerHTML =
      '<div class="ok">' + T('書き出し完了: {name}.wav + {name}_dsp_log.csv<br>DSP書き込み {writes} 件 / KON {kon} 件 (先頭{sec}秒)',
        { name, writes: totalWrites, kon: konCount, sec: LOG_SEC }) + '</div>';
  }

  async function runSpc2Mml() {
    if (!loadedSpcBytes) {
      spcFileStatusEl.innerHTML = '<div class="error">' + T('先にSPCファイルを読み込んでください。') + '</div>';
      return;
    }
    if (spcIsRendering) return;

    const duration = parseInt(spcPlayDurEl.value, 10) || 60;
    spcIsRendering = true;
    updateSpcPlayButton();
    spcFileStatusEl.innerHTML = '<div>' + T('MML変換用キャプチャ中… (数秒かかります)') + '</div>';

    await new Promise(resolve => setTimeout(resolve, 10));

    // チャンネルマップをUIから取得
    const channelMap = Array.from({ length: 8 }, (_, ch) => {
      const sel = document.getElementById(`spc-v${ch}-target`);
      return { type: sel ? sel.value : (ch < 4 ? ['pulse1','pulse2','triangle','noise'][ch] : 'skip') };
    });

    const spcManualBpm = getManualBpm('spc');
    let result;
    try {
      result = MML.SPC2MML.fromSpc(loadedSpcBytes, Math.min(duration, 60), { channelMap, bpm: spcManualBpm });
    } catch (e) {
      spcIsRendering = false;
      spcFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }

    spcIsRendering = false;
    updateSpcPlayButton();

    // MML エディタへ出力
    mmlSourceEl.value = result.mml;
    mmlSourceEl.dispatchEvent(new Event('input'));

    // 抽出したFDS/N163波形を波形エディタへ反映(getMmlOpt()はここからのみ波形を読むため)
    if (result.fdsWave && MML.WaveformEditor.fdsWave) MML.WaveformEditor.fdsWave.setData(result.fdsWave);
    if (result.n163Wave && MML.WaveformEditor.n163Wave) MML.WaveformEditor.n163Wave.setData(result.n163Wave);

    // DPCM ファイルをダウンロード(保存用)。同時にdpcmSampleCacheへ直接投入
    for (const f of result.dmcFiles || []) {
      downloadBin(f.name, f.bytes);
      dpcmSampleCache[f.name] = f.bytes;
    }

    const dmcMsg = (result.dmcFiles && result.dmcFiles.length > 0)
      ? T('、DPCM {n} ファイル出力', { n: result.dmcFiles.length }) : '';
    const expMsg = result.expansion && result.expansion !== 'none'
      ? T('、拡張音源: {chips}', { chips: result.expansion }) : '';
    spcFileStatusEl.innerHTML = '<div class="ok">' +
      T('MML変換完了 ({mode} {bpm} BPM{exp}{dpcm}) → MMLエディタに出力',
        { mode: spcManualBpm ? T('指定') : T('推定'), bpm: result.bpm, exp: expMsg, dpcm: dmcMsg }) + '</div>';

    // 変換直後にコンパイルだけ実行し、DPCMサンプル欄/チャンネル選択欄/モニタ等の
    // 各種UIをMML本文に反映する(再生は開始しない)。
    // 新規変換された曲なので、前回再生していた曲の再生範囲(赤/青ハンドル)を
    // 引き継がず全体にリセットする(preservePlaybackRangeによる引き継ぎを無効化)
    rangeStartSec = 0;
    rangeEndSec = null;
    prepareMmlStream(true);
  }

  // ── SPC ボイスモニター ───────────────────────────────────────────
  const voiceMonitorEl = document.getElementById('spcVoiceMonitor');
  const voicePanelEl   = document.getElementById('spcVoicePanel');
  let   voiceMonitorTimer = null;
  // ミュート状態を停止・WAV 書き出しをまたいで保持
  let   spcMutedVoices = 0;

  // 原音チューニング補正マップ(再生開始時に算出、srcn→半音)。ロール/MML変換と同じ
  // 補正をライブ鍵盤にも適用して表示を一致させる。未算出時はnull(=補正0で基準だけ揃える)。
  let spcActiveFineTune = null;
  const SPC_REF_HZ = 440 * Math.pow(2, 3 / 12); // ≈523.25Hz。pitch=0x1000・補正0のときのHz(=C5)
  function spcTuneForSrcn(srcn) {
    return spcActiveFineTune ? (spcActiveFineTune[srcn] || 0) : 0;
  }

  // SPC ピッチ → 実発音周波数[Hz]。サンプル原音(補正tune)と pitch/0x1000 の比から求める。
  // ロール/MML変換(pitch=0x1000・補正0を note60=C5基準)と同じ音程になる。鍵盤ハイライトは
  // keyboard.js の freqToMidi(freq) 経由なので、ここが真の周波数を返せば鍵とロールが一致する。
  // 旧実装は pitch=0x1000 を A4=440Hz、かつ原音補正なしとしていたため、ロール(実機準拠)と
  // 最大で 3半音+原音差ぶんズレて鍵盤が光っていた。
  function pitchToHz(pitch, tune = 0) {
    return pitch > 0 ? SPC_REF_HZ * Math.pow(2, tune / 12) * (pitch / 0x1000) : 0;
  }

  // ピッチ値 → 音名 (標準MIDI: 60 = C4)。基準・補正はpitchToHzと揃える。
  function pitchToNote(pitch, tune = 0) {
    if (!pitch) return '--';
    const note = Math.round(72 + 12 * Math.log2(pitch / 0x1000) + tune);
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const oct  = Math.floor(note / 12) - 1;
    return `${names[((note % 12) + 12) % 12]}${oct}`;
  }

  // ピッチ値 → キーボード上の x 座標 (0-1 の割合)。基準・補正はpitchToHzと揃える。
  function pitchToX(pitch, tune = 0) {
    if (!pitch) return 0.5;
    const note = 72 + 12 * Math.log2(Math.max(1, pitch) / 0x1000) + tune;
    return Math.max(0, Math.min(1, (note - 36) / 60)); // C2-C7 の範囲
  }

  // チャンネルターゲット選択肢
  const TARGET_OPTIONS = [
    { value: 'skip',       label: T('スキップ') },
    { value: 'pulse1',     label: 'A: Pulse 1' },
    { value: 'pulse2',     label: 'B: Pulse 2' },
    { value: 'triangle',   label: 'C: Triangle' },
    { value: 'noise',      label: 'D: Noise' },
    { value: 'dpcm',       label: T('DPCM変換') },
    { value: 'fds',        label: T('E: FDS 波形') },
    { value: 'vrc6pulse1', label: 'E: VRC6 Pulse1' },
    { value: 'vrc6pulse2', label: 'F: VRC6 Pulse2' },
    { value: 'vrc6saw',    label: T('G: VRC6 のこぎり') },
    { value: 'mmc5pulse1', label: 'E: MMC5 Pulse1' },
    { value: 'mmc5pulse2', label: 'F: MMC5 Pulse2' },
    { value: 'fme7a',      label: 'E: FME7 A' },
    { value: 'fme7b',      label: 'F: FME7 B' },
    { value: 'fme7c',      label: 'G: FME7 C' },
    { value: 'n163_0',     label: 'E: N163 ch0' },
    { value: 'n163_1',     label: 'F: N163 ch1' },
    { value: 'n163_2',     label: 'G: N163 ch2' },
    { value: 'n163_3',     label: 'H: N163 ch3' },
  ];
  const DEFAULT_TARGET_TYPES = ['pulse1','pulse2','triangle','noise','skip','skip','skip','skip'];

  function buildTargetSelect(ch) {
    const sel = document.createElement('select');
    sel.id = `spc-v${ch}-target`;
    sel.style.cssText = 'width:100%;font-size:10px;margin-top:3px;background:#222;color:#ccc;border:1px solid #555;border-radius:3px;';
    for (const opt of TARGET_OPTIONS) {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      if (opt.value === DEFAULT_TARGET_TYPES[ch]) el.selected = true;
      sel.appendChild(el);
    }
    sel.addEventListener('click', e => e.stopPropagation());
    return sel;
  }

  // ボイスモニター UI を構築
  function buildVoiceMonitor() {
    voicePanelEl.innerHTML = '';
    for (let ch = 0; ch < 8; ch++) {
      const div = document.createElement('div');
      div.id = `spc-voice-${ch}`;
      div.style.cssText = `
        width:110px; border:1px solid #444; border-radius:4px;
        padding:4px; font-size:11px; cursor:pointer;
        background:#1a1a2e; position:relative; user-select:none;
      `;
      div.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b style="color:#aef">V${ch}</b>
          <span id="spc-v${ch}-mute" style="
            font-size:10px; padding:1px 4px; border-radius:3px;
            border:1px solid #666; cursor:pointer; background:#333;
          ">MUTE</span>
        </div>
        <div id="spc-v${ch}-srcn" style="color:#fa0;font-size:10px;">SRCN--</div>
        <div id="spc-v${ch}-note" style="color:#fff;font-weight:bold;font-size:12px;text-align:center;">--</div>
        <div style="background:#222;height:4px;border-radius:2px;margin:2px 0;">
          <div id="spc-v${ch}-env" style="height:4px;border-radius:2px;background:#4af;width:0%;transition:width 0.05s;"></div>
        </div>
        <div style="background:#111;height:12px;border-radius:2px;position:relative;overflow:hidden;">
          <div id="spc-v${ch}-key" style="
            position:absolute; top:1px; width:4px; height:10px;
            background:#ff0; border-radius:2px;
            transform:translateX(-50%); left:50%; transition:left 0.08s;
          "></div>
        </div>
      `;
      div.appendChild(buildTargetSelect(ch));
      voicePanelEl.appendChild(div);

      // ミュートボタン（停止・WAV書き出しをまたいで状態保持）
      div.querySelector(`#spc-v${ch}-mute`).addEventListener('click', (e) => {
        e.stopPropagation();
        spcMutedVoices ^= (1 << ch);           // 永続ミュート状態を更新
        // applyMute()経由にすることでSpcReplayStreamPlayer側が_lastMutedとして保持し、
        // シーク時の再構築(_buildChips())後も設定が消えないようにする(dsp.mutedVoicesを
        // 直接上書きするだけだと再構築のたびにリセットされてしまう)。
        if (spcActivePlayer) spcActivePlayer.applyMute(spcMutedVoices);
        updateMuteButton(ch, spcMutedVoices);
      });
    }
  }

  function updateMuteButton(ch, mutedVoices) {
    const el = document.getElementById(`spc-v${ch}-mute`);
    if (!el) return;
    const muted = !!(mutedVoices & (1 << ch));
    el.style.background = muted ? '#c00' : '#333';
    el.style.color       = muted ? '#fff' : '#aaa';
    el.textContent       = muted ? 'MUTED' : 'MUTE';
  }

  // ゲイン/ADSRエンベロープレジスタの生値からモード情報を取り出す（鍵盤表示のenv列用）
  // ADSR: $X5 bit7=1 → { mode:'adsr', ar, dr, sl, sr }
  // GAIN: $X7 bit7=0 → direct(0-127) / bit7=1 → bit6,5 でカーブ種別、bit4-0が値(0-31)
  function decodeSpcEnv(adsr1, adsr2, gainReg) {
    if (adsr1 & 0x80) {
      return { mode: 'adsr', ar: adsr1 & 0xF, dr: (adsr1 >> 4) & 7, sl: (adsr2 >> 5) & 7, sr: adsr2 & 0x1F };
    }
    if (!(gainReg & 0x80)) {
      return { mode: 'gain', kind: 'direct', value: gainReg & 0x7F };
    }
    const b6 = (gainReg >> 6) & 1, b5 = (gainReg >> 5) & 1;
    const kind = (b6 === 0 && b5 === 0) ? 'lindec' :
                 (b6 === 0 && b5 === 1) ? 'exp' :
                 (b6 === 1 && b5 === 0) ? 'linatk' : 'bentatk';
    return { mode: 'gain', kind, value: gainReg & 0x1F };
  }

  // 大波形パネル用: 素のBRR値・ガウス補間後の滑らかな波形・(PM有効chなら)ピッチ変調後の
  // 波形を非破壊プレビューで生成する（dspの実状態は変更しない。previewVoiceOutput参照）。
  function buildSpcWaveLayers(v, pitchVal, ch, pmOn, voices) {
    const raw = Array.from(v.brrBuf.subarray(4, 20), s => s / 32768);
    const SMOOTH_COUNT = 48;
    const smooth = MML.Emu.previewVoiceOutput(v, pitchVal, SMOOTH_COUNT).map(s => s / 32768);
    let smoothPM = null;
    if (ch > 0 && pmOn) {
      const prevOut = voices[ch - 1].outSample;
      let modPitch = (pitchVal * (prevOut + 0x8000)) >> 15;
      modPitch = Math.max(0, Math.min(0x3FFF, modPitch));
      smoothPM = MML.Emu.previewVoiceOutput(v, modPitch, SMOOTH_COUNT).map(s => s / 32768);
    }
    return {
      t: 'wave', nx: 16, ny: 32768, signed: true,
      data: raw,
      layers: [
        { data: raw, mode: 'steps', color: '#8a8a98', label: T('素(BRR)') },
        { data: smooth, mode: 'line', color: '#6ea8ff', label: T('ガウス補間') },
      ].concat(smoothPM ? [{ data: smoothPM, mode: 'line', dash: [4, 3], color: '#ff8844', label: T('PM変調後') }] : []),
    };
  }

  // ボイス状態を定期更新
  function updateVoiceMonitor() {
    if (!spcActivePlayer || !spcActivePlayer.player) return;
    const dsp    = spcActivePlayer.player.dsp;
    const regs   = dsp.regs;
    const voices = dsp.voices;

    for (let ch = 0; ch < 8; ch++) {
      const v     = voices[ch];
      const base  = ch << 4;
      const pitch = regs[base+2] | ((regs[base+3] & 0x3F) << 8);
      const srcn  = regs[base+4];
      const env   = v.env;
      const active = v.envMode !== 'off' && env > 0;

      const noteEl = document.getElementById(`spc-v${ch}-note`);
      const srcnEl = document.getElementById(`spc-v${ch}-srcn`);
      const envEl  = document.getElementById(`spc-v${ch}-env`);
      const keyEl  = document.getElementById(`spc-v${ch}-key`);
      const cardEl = document.getElementById(`spc-voice-${ch}`);
      if (!noteEl) continue;

      const muted = !!(spcMutedVoices & (1 << ch));
      noteEl.textContent = active ? pitchToNote(pitch, spcTuneForSrcn(srcn)) : '--';
      srcnEl.textContent = `SRC${srcn}`;
      const envPct = Math.round((env / 0x7FF) * 100);
      envEl.style.width    = `${envPct}%`;
      envEl.style.background = v.envMode === 'attack'  ? '#4f4' :
                               v.envMode === 'decay'   ? '#fa4' :
                               v.envMode === 'sustain' ? '#4af' :
                               v.envMode === 'release' ? '#f44' : '#444';

      // ミニ鍵盤インジケーター
      if (active && pitch > 0) {
        const x = pitchToX(pitch, spcTuneForSrcn(srcn));
        keyEl.style.left    = `${x * 100}%`;
        keyEl.style.display = 'block';
        keyEl.style.background = `hsl(${ch * 45},90%,65%)`;
      } else {
        keyEl.style.display = 'none';
      }

      // カード背景: ミュート中は暗く（spcMutedVoices を正とする）
      cardEl.style.background = muted ? '#111' : (active ? '#1a2040' : '#1a1a2e');
      cardEl.style.borderColor = active && !muted ? `hsl(${ch * 45},70%,40%)` : '#444';
      updateMuteButton(ch, dsp.mutedVoices);
    }

    // 鍵盤表示に SPC ボイス状態を同期
    const pmonReg = regs[0x2D], nonReg = regs[0x3D], eonReg = regs[0x4D];
    // $7D(EDL) bit0-3: エコーディレイ時間 = EDL × 16ms (0=0ms, 1=16ms, … 15=240ms)
    const echoDelayMs = (regs[0x7D] & 0x0F) * 16;
    const spcVoices = [];
    for (let ch = 0; ch < 8; ch++) {
      const v     = voices[ch];
      const base  = ch << 4;
      const pitch = regs[base+2] | ((regs[base+3] & 0x3F) << 8);
      const srcn  = regs[base+4];
      const active = v.envMode !== 'off' && v.env > 0;
      const muted  = !!(spcMutedVoices & (1 << ch));
      const volL = (regs[base+0] << 24) >> 24;
      const volR = (regs[base+1] << 24) >> 24;
      const env  = decodeSpcEnv(regs[base+5], regs[base+6], regs[base+7]);
      const pmOn = !!(pmonReg & (1 << ch));
      const noiseOn = !!(nonReg & (1 << ch));
      const echoOn = !!(eonReg & (1 << ch));
      const wave = active ? buildSpcWaveLayers(v, pitch, ch, pmOn, voices) : null;
      spcVoices.push({
        label:  `V${ch}`,
        freq:   active && !muted ? pitchToHz(pitch, spcTuneForSrcn(srcn)) : 0,
        vol:    active && !muted ? v.env / 0x7FF : 0,
        // rawVolは実機のENVXレジスタ($X8)が返す値と同じ0-127(内部11bit envの上位7bit)。
        // 内部envはDSPが計算精度用に持つ11bit値(0-2047)なので、そのままでは
        // 「実際にプログラム/CPUから読めるレジスタ値」と食い違うため合わせている。
        rawVol: active ? (v.env >> 4) : null,
        active: active && !muted,
        muted,
        color:  `hsl(${ch * 45},90%,65%)`,
        wave,
        env,
        volL, volR,
        pmOn, noiseOn, echoOn, echoDelayMs,
      });
    }
    const master = {
      volL:  (regs[0x0C] << 24) >> 24,
      volR:  (regs[0x1C] << 24) >> 24,
      echoL: (regs[0x2C] << 24) >> 24,
      echoR: (regs[0x3C] << 24) >> 24,
      fir: [0, 1, 2, 3, 4, 5, 6, 7].map(i => (regs[i * 0x10 + 0x0F] << 24) >> 24),
    };
    const spcPos = spcActivePlayer ? spcActivePlayer.getPosition() : 0;
    keyboardDisplay.updateSpcVoices(spcVoices, master, spcPos);
  }

  function startVoiceMonitor() {
    // ミュート状態をボタン表示に反映（ドロップダウンは再構築しない）
    for (let ch = 0; ch < 8; ch++) updateMuteButton(ch, spcMutedVoices);
    clearInterval(voiceMonitorTimer);
    voiceMonitorTimer = setInterval(() => {
      if (spcActivePlayer && spcActivePlayer.isPlaying) updateVoiceMonitor();
    }, 80);
  }

  function stopVoiceMonitor() {
    clearInterval(voiceMonitorTimer);
    keyboardDisplay.updateSpcVoices([]);
  }

  // 鍵盤表示側のミュートチェックボックス操作 → ボイスモニターと同じミュート機構に反映
  keyboardDisplay.onSpcMuteChange = (idx, muted) => {
    spcMutedVoices = muted ? (spcMutedVoices | (1 << idx)) : (spcMutedVoices & ~(1 << idx));
    if (spcActivePlayer) spcActivePlayer.applyMute(spcMutedVoices);
    updateMuteButton(idx, spcMutedVoices);
  };

  // ページ読み込み時にボイスモニターを構築（ドロップダウンを最初から表示）
  buildVoiceMonitor();

  spcFileEl.addEventListener('change', loadSpcFile);
  document.getElementById('btnSpcFilePlay').addEventListener('click', () => {
    playSpcStream();
    startVoiceMonitor();
    keyboardDisplay.setMode('spc');
  });
  document.getElementById('btnSpcFileStop').addEventListener('click', () => {
    stopSpcPlayback();
    stopVoiceMonitor();
    keyboardDisplay.setMode('nsf');
  });
  document.getElementById('btnSpcExportWav').addEventListener('click', exportSpcWav);
  document.getElementById('btnSpc2Mml').addEventListener('click', runSpc2Mml);

  // ── KSS ファイル読み込み・再生 ────────────────────────────────────
  const kssFileEl       = document.getElementById('kssFile');
  const kssFileHeaderEl = document.getElementById('kssFileHeader');
  const kssPlayDurEl    = document.getElementById('kssPlayDuration');
  const kssFileStatusEl = document.getElementById('kssFileStatus');
  const kssSongIndexEl  = document.getElementById('kssSongIndex');
  const kssSongTotalEl  = document.getElementById('kssSongTotal');

  let loadedKssBytes  = null;
  let loadedKssHeader = null;
  let kssIsRendering  = false;
  let kssActivePlayer = null; // KssStreamPlayer

  // KSSで使う鍵盤表示チャンネル種別 (ヘッダのFMPAC有無・SCC使用有無で可変)。
  // SCCはKSSヘッダに現れないため「積んでいるか」はヘッダだけでは決まらない。
  // ・16Kバンクモード+RAMモードのファイルはバス側でSCCデコード自体を止めている
  //   (src/emulator/kssBus.js の sccDisable)ので確実に非搭載。
  // ・それ以外は先読みキャプチャでSCCレジスタへの実書込みを検出できたときだけ出す
  //   (PSG+FMPACだけの曲でKS1-KS5の空行が5行居座るのを防ぐ)。
  function kssHasSccDecoder(header) {
    return !!header && !(header.bankMode === '16K' && header.device.ramMode);
  }
  function kssMonitorChips(header, sccUsed) {
    const chips = ['kss', 'kssPsg'];
    if (sccUsed) chips.push('kssScc');
    if (header && header.device.mode === 'MSX' && header.device.fmpac) chips.push('kssOpll');
    return chips;
  }

  // writeLogのフレーム範囲[from,to)にSCC音源レジスタ(周波数/音量/有効ビット)への
  // 書込みがあるか。波形テーブルはクリア目的で0書きされることがあるため判定材料にせず、
  // 実際に発音に効くレジスタだけを見る。classic(SCC)は0x80-0x8F、SCC+(SCC-I)は
  // 0xA0-0xAFに並ぶので両方を対象にする(src/emulator/expansion/sccAudio.js参照)。
  function kssWriteLogUsesScc(writeLog, from, to) {
    for (let f = from; f < to && f < writeLog.length; f++) {
      for (const w of writeLog[f]) {
        if (w.io) continue;
        const off = (w.addr >= 0x9800 && w.addr <= 0x98FF) ? w.addr - 0x9800
          : (w.addr >= 0xB800 && w.addr <= 0xB8FF) ? w.addr - 0xB800 : -1;
        if (off < 0 || w.value === 0) continue;
        if ((off >= 0x80 && off <= 0x8F) || (off >= 0xA0 && off <= 0xAF)) return true;
      }
    }
    return false;
  }

  function renderKssHeader(h) {
    let out = '';
    out += T('Magic       : {magic} ({ok})', { magic: h.magic, ok: h.magicOk ? 'OK' : T('不正') }) + '\n';
    out += `Load/Init/Play: ${toHex(h.loadAddr,4)} / ${toHex(h.initAddr,4)} / ${toHex(h.playAddr,4)}\n`;
    out += T('データ長    : {n} バイト', { n: h.dataLength }) + '\n';
    out += T('バンク方式  : {mode}マッパー (追加バンク数 {n})', { mode: h.bankMode, n: h.bankNum }) + '\n';
    out += T('モード      : {mode}', { mode: h.device.mode + (h.device.palMode ? ' / PAL' : ' / NTSC') }) + '\n';
    out += T('音源        : {chips}', { chips: MML.KSS.describeChips(h).join(', ') }) + '\n';
    if (h.hasSongRange) out += T('曲番号範囲  : {first} 〜 {last}', { first: h.firstSong, last: h.lastSong }) + '\n';
    kssFileHeaderEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = h.magicOk ? 'ok' : 'error';
    pre.textContent = out;
    kssFileHeaderEl.appendChild(pre);
  }

  async function loadKssFile() {
    const file = kssFileEl.files[0];
    if (!file) return;
    stopAllFormatPlayback();
    keyboardDisplay.reset();
    loadedKssBytes = null; loadedKssHeader = null;

    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    try {
      const h = MML.KSS.parseHeader(bytes);
      if (!h.magicOk) {
        kssFileHeaderEl.innerHTML = '<div class="error">' + T('KSSヘッダが不正です。') + '</div>';
        return;
      }
      loadedKssBytes = bytes;
      loadedKssHeader = h;
      renderKssHeader(h);
      const first = h.hasSongRange ? h.firstSong : 0;
      const last = h.hasSongRange ? h.lastSong : 255;
      kssSongIndexEl.min = String(first);
      kssSongIndexEl.max = String(last);
      kssSongIndexEl.value = String(first);
      kssSongTotalEl.textContent = `/ ${last}`;
      kssFileStatusEl.innerHTML = '';
    } catch (e) {
      kssFileHeaderEl.innerHTML = '<div class="error">' + T('読み込みエラー: {msg}', { msg: e.message }) + '</div>';
    }
  }

  function stopKssPlayback() {
    if (kssActivePlayer) {
      kssActivePlayer.destroy();
      kssActivePlayer = null;
    }
    kssRollToken++; // 進行中の先読みキャプチャ結果を無効化
    keyboardDisplay.setRollTimeline(null);
    updateKssPlayButton();
  }

  // KSS captureKssSongAsync() の結果(writeLog)からピアノロール用タイムライン(共通形状)を
  // 構築する。PSG→KP/SCC→KS/FMPAC→KF は src/ui/keyboard.js の extractChannels() が
  // kssPsg/kssScc/kssOpll チップ向けに使っている色分けと揃えている。
  function buildKssRollTimeline(writeLog, totalFrames, frameRate, header, sccUsed) {
    const frameDur = 1 / frameRate;
    const clock = MML.KSS.Z80_CLOCK;
    // volume は ay/scc/opll いずれも0-15(4bit)なので/15で0-1に正規化する。
    // note: Kss2MmlExpansion(ay/scc/opll)のfreqToNoteNumberはMML変換側で使う共通の
    // ノート番号体系(57+12*log2(freq/440)、nsf2mml/expansion/fme7.js等でも同じ)を採用しており、
    // 標準MIDI(69+12*log2(freq/440)、keyboard.jsのfreqToMidiと同じ)より1オクターブ(12)低い。
    // MML変換自体はこの体系で正しく動くため触らず、鍵盤描画に合わせるロール側でのみ+12補正する。
    //
    // ★ay/scc/opllの抽出イベントは「音量が1でも変わったら別イベント」に切れている
    // (MML変換側が音量エンベロープ@v<n>を作るのに必要なため)。実機ドライバは毎フレーム
    // 音量ニブルを書き直すのが普通なので、そのままロールに描くと1つのロングトーンが
    // 1フレーム幅の短冊数百本に分解されて「ロールが壊れて見える」。ピアノロールでは
    // 音程が同じまま途切れず続いている区間を1本の音符に統合する。
    // ただしキーオンによる打ち直し(retrigger)だけは音符の区切りとして残す。
    const toNotes = (events) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const prev = out[out.length - 1];
        if (prev && !e.retrigger && endFrame === e.start && prev.midi === e.note + 12) {
          prev.endSec = e.end * frameDur;
          prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
          if (e.freqSeq) prev.freqSeq.push(...e.freqSeq);
        } else {
          out.push({ startSec: e.start * frameDur, endSec: e.end * frameDur, midi: e.note + 12, vol: (e.volume || 0) / 15, freqSeq: e.freqSeq ? e.freqSeq.slice() : [] });
        }
        endFrame = e.end;
      }
      return out;
    };
    const tracks = [];

    const ayResult = MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock);
    const KP_COLS = ['#66ddff', '#33aaff', '#0077dd'];
    ayResult.channels.forEach((ch, i) => tracks.push({ id: `KP${i + 1}`, color: KP_COLS[i], notes: toNotes(ch.events) }));

    // SCC未使用の曲では鍵盤表示側にもKS行を出さないので、ロールのトラックも作らない
    // (トラックidと鍵盤の行が1対1で対応している必要がある)
    if (sccUsed) {
      const sccResult = MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock);
      sccResult.channels.forEach((ch, i) => tracks.push({ id: `KS${i + 1}`, color: `hsl(${(280 + i * 20) % 360},80%,60%)`, notes: toNotes(ch.events) }));
    }

    if (header && header.device.mode === 'MSX' && header.device.fmpac) {
      const opllResult = MML.Kss2MmlExpansion.opll(writeLog, totalFrames);
      const KF_COLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc','#ffd9a0','#ffe0b0','#ffe8c0'];
      opllResult.channels.forEach((ch, i) => tracks.push({ id: `KF${i + 1}`, color: KF_COLS[i % KF_COLS.length], notes: toNotes(ch.events) }));
    }

    return tracks;
  }

  function updateKssPlayButton() {
    const btn = document.getElementById('btnKssFilePlay');
    if (!btn) return;
    const playing = kssActivePlayer && kssActivePlayer.isPlaying;
    btn.classList.toggle('is-playing', !!playing);
    btn.title = playing ? T('一時停止') : T('再生');
    btn.disabled = kssIsRendering;
  }

  function playKssStream() {
    if (!loadedKssBytes) {
      kssFileStatusEl.innerHTML = '<div class="error">' + T('先にKSSファイルを読み込んでください。') + '</div>';
      return;
    }
    // 再生中なら一時停止 / 一時停止中なら再開
    if (kssActivePlayer && lastPlayMode === 'kss') {
      if (kssActivePlayer.isPlaying) transportPause();
      else transportPlay();
      return;
    }

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // 他フォーマットの再生と先読みキャプチャを止める(ロールの取り違え防止)
    transportStop();
    stopAllFormatPlayback();
    stopVoiceMonitor();
    invalidateOtherRollPrefetch('kss');
    lastPlayMode = 'kss';
    kssBufferedFraction = 0;
    updateSeekBufferedUI();

    const songNo = parseInt(kssSongIndexEl.value, 10) || 0;
    const duration = parseInt(kssPlayDurEl.value, 10) || 180;
    const kssFrameRate = loadedKssHeader.device.palMode ? MML.KSS.PAL_FPS : MML.KSS.NTSC_FPS;
    const totalFrames = Math.ceil(duration * kssFrameRate);

    // NSF実ファイル再生と同じ理由(二重エミュレーション解消・シーク・再生中ライブミュート
    // 対応)で、ライブ再生用プレイヤーとロール先読みキャプチャを1本のバックグラウンド
    // regsOnlyキャプチャに統合する(NsfReplayStreamPlayerと対になるKssReplayStreamPlayer、
    // src/audio/kss-stream-player.js)。KSSはKssBus.write()が通常メモリ書込みも含め全て
    // onWriteへ渡すため、NSFの$4015/$4017のような「バスを経由しない直接書込み」問題は無く、
    // またKssPlayer.renderFrame()自体がregsOnly時もチップのclock()を省略しない設計のため、
    // NSFのcapture.js側で必要だった追加修正(clock呼び出し追加)も不要だった(実測でPSG
    // レジスタ状態が実CPU駆動と200フレームぶん完全一致することを確認済み)。
    const player = new MML.Audio.KssReplayStreamPlayer(audioCtx);
    player._baseGain = player.gainNode.gain.value;
    endFadeActive = false;
    player.onEnded = () => {
      updateKssPlayButton();
      updateTransportUI();
      // NsfReplayStreamPlayerと同じレース対策(playNsfStream内のonEnded参照)
      setTimeout(() => { if (currentTransportPlayer() === player) finishSoundFilePlayback(); }, 0);
    };
    // NsfReplayStreamPlayerと同じ理由(playNsfStream参照): 10秒無音を検出したら1秒待って次の曲へ
    player.onSilenceTimeout = () => {
      setTimeout(() => {
        if (currentTransportPlayer() !== player) return;
        stopKssPlayback();
        autoAdvanceKssSong();
      }, 1000);
    };
    kssActivePlayer = player;
    player.setSpeed(currentSpeedFactor);
    workletDuration = duration;

    // 鍵盤表示: PSG/SCC/FMPACをライブチップから直接スナップショットする。
    // SCC使用が判明した時点で行構成を変えるため、再呼び出しできる形にしておく。
    function applyKssMonitorSource(sccUsed) {
      setMonitorSource({
        regSnapshots: [{}],
        totalFrames: 1,
        samplesPerFrame: audioCtx.sampleRate / kssFrameRate,
        sampleRate: audioCtx.sampleRate,
        writeLog: [],
        cpuSnapshots: null,
        memSnapshots: null,
        getKssPsg: liveKssPsg,
        getKssScc: liveKssScc,
        getKssOpll: liveKssOpll
      }, () => kssActivePlayer ? kssActivePlayer.getPosition() : 0, kssMonitorChips(loadedKssHeader, sccUsed));
    }

    resetPlaybackRangeToFull(duration);
    seekBarEl.value = '0';
    timeDisplayEl.textContent = `00:00 / ${formatTime(duration)}`;

    kssFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = T('再生中: 曲{song}  (最大 {time})', { song: songNo, time: formatTime(duration) });
    kssFileStatusEl.appendChild(pre);

    // バックグラウンドキャプチャ(regsOnly)。ピアノロールと実再生の両方の情報源を兼ねる。
    // onProgressで途中経過(その時点までのwriteLog、進行中の配列への参照なので以後
    // キャプチャが進むにつれ自動的に埋まっていく)を受け取り、最初の1回でplayer.load()
    // して再生を開始する(以降のチャンクを待つ必要はない)。
    // ★ロール再構築(setRollTimeline内のO(全フレーム)走査)はSPCと同じ理由で間引く
    // (onProgress自体は音切れ防止のため高頻度のまま、captureKssSongAsync自体のyield頻度は
    // 変えない)。
    const ROLL_REBUILD_INTERVAL_FRAMES = 120;
    keyboardDisplay.setRollTimeline(null);
    const myKssRollToken = ++kssRollToken;
    let lastKssRollBuiltFrame = 0;
    // SCCは「使われたと分かった時点で行を足す」単調な運用にする(出したり消したりすると
    // 再生中に行数が揺れて見づらいため)。バス側でSCCを殺しているファイルは常に非表示。
    let kssSccUsed = false;
    let kssSccScanned = 0;
    const kssSccPossible = kssHasSccDecoder(loadedKssHeader);
    let kssPlaybackLoaded = false;
    MML.Emu.captureKssSongAsync(loadedKssBytes, {
      songIndex: songNo, durationSeconds: duration, sampleRate: audioCtx.sampleRate,
      regsOnly: true,
      shouldCancel: () => myKssRollToken !== kssRollToken
    }, (done, total, writeLog) => {
      if (myKssRollToken !== kssRollToken) return; // 曲切替/停止で無効化済み

      if (!kssPlaybackLoaded) {
        kssPlaybackLoaded = true;
        player.load(loadedKssBytes, songNo, totalFrames, { writeLog }, getChannelMuteConfig());
        applyKssMonitorSource(kssSccUsed);
        transportPlay();
      }

      kssBufferedFraction = total > 0 ? done / total : 0;
      updateSeekBufferedUI();

      if (kssSccPossible && !kssSccUsed && kssWriteLogUsesScc(writeLog, kssSccScanned, done)) {
        kssSccUsed = true;
        // SCC行を追加して鍵盤表示を組み直す。setMonitorSource()はロールも初期化して
        // しまうので、同じコールバック内で必ず作り直させる(間引きを一度だけ解除)。
        applyKssMonitorSource(kssSccUsed);
        lastKssRollBuiltFrame = -Infinity;
      }
      kssSccScanned = done;
      if (done - lastKssRollBuiltFrame < ROLL_REBUILD_INTERVAL_FRAMES && done < total) return;
      lastKssRollBuiltFrame = done;
      keyboardDisplay.setRollTimeline(
        buildKssRollTimeline(writeLog.slice(0, done), done, kssFrameRate, loadedKssHeader, kssSccUsed));
    }).catch((e) => {
      // 先読み失敗時はピアノロールなしで続行するが、原因を追えるようログには残す
      // (ここを完全に握り潰していたため、Kss2MmlExpansion.sccのTypeErrorで
      //  ロールが出なくなっていた不具合の発見が遅れた)
      console.error('KSS先読みキャプチャに失敗:', e);
    });
  }

  function changeKssSong(delta) {
    const min = parseInt(kssSongIndexEl.min, 10) || 0;
    const max = parseInt(kssSongIndexEl.max, 10) || 255;
    let v = (parseInt(kssSongIndexEl.value, 10) || 0) + delta;
    v = Math.max(min, Math.min(max, v));
    kssSongIndexEl.value = String(v);
    // NSFのchangeNsfSong()と同じく、再生中かどうかに関係なく無条件に再生を開始する
    // (以前はkssActivePlayerがある時だけ再開しており、ファイル読込直後は曲送りボタンが
    // 番号を進めるだけで再生されないというNSFとの挙動差があった)
    stopKssPlayback();
    playKssStream();
  }

  async function exportKssWav() {
    if (!loadedKssBytes) {
      kssFileStatusEl.innerHTML = '<div class="error">' + T('先にKSSファイルを読み込んでください。') + '</div>';
      return;
    }
    if (kssIsRendering) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const songNo = parseInt(kssSongIndexEl.value, 10) || 0;
    const duration = parseInt(kssPlayDurEl.value, 10) || 30;
    const sampleRate = audioCtx.sampleRate;
    kssIsRendering = true;
    updateKssPlayButton();
    kssFileStatusEl.innerHTML = '<div>' + T('WAV書き出し用レンダリング中…') + '</div>';

    const result = await MML.Emu.captureKssSongAsync(loadedKssBytes, {
      songIndex: songNo, durationSeconds: duration, sampleRate, mute: getChannelMuteConfig().expansion
    }, (done, total) => {
      kssFileStatusEl.innerHTML = '<div>' + T('WAV書き出し中… {pct}%', { pct: Math.round(done / total * 100) }) + '</div>';
    });

    kssIsRendering = false;
    updateKssPlayButton();

    const filename = `kss_song${songNo}.wav`;
    const blob = buildWavBlob(result.audio, sampleRate, 2.5);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);

    let csv = 'frame,addr_or_port,io,value\n';
    result.writeLog.forEach((writes, f) => {
      writes.forEach(w => { csv += `${f},0x${w.addr.toString(16).toUpperCase()},${w.io ? 1 : 0},0x${w.value.toString(16).toUpperCase().padStart(2,'0')}\n`; });
    });
    const logBlob = new Blob([csv], { type: 'text/csv' });
    const logUrl = URL.createObjectURL(logBlob);
    const b = document.createElement('a');
    b.href = logUrl; b.download = `kss_song${songNo}_regs.csv`; b.click();
    URL.revokeObjectURL(logUrl);

    kssFileStatusEl.innerHTML = '<div class="ok">' + T('書き出し完了: {file} + regs.csv', { file: filename }) + '</div>';
  }

  async function runKss2Mml() {
    if (!loadedKssBytes) {
      kssFileStatusEl.innerHTML = '<div class="error">' + T('先にKSSファイルを読み込んでください。') + '</div>';
      return;
    }
    if (kssIsRendering) return;

    const songNo = parseInt(kssSongIndexEl.value, 10) || 0;
    const duration = parseInt(kssPlayDurEl.value, 10) || 60;
    kssIsRendering = true;
    updateKssPlayButton();
    kssFileStatusEl.innerHTML = '<div>' + T('MML変換用キャプチャ中… (数秒かかります)') + '</div>';
    await new Promise(resolve => setTimeout(resolve, 10));

    const kssManualBpm = getManualBpm('kss');
    let result;
    try {
      result = await MML.KSS2MML.fromKss(loadedKssBytes, songNo, duration, { bpm: kssManualBpm });
    } catch (e) {
      kssIsRendering = false;
      updateKssPlayButton();
      kssFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }

    kssIsRendering = false;
    updateKssPlayButton();

    mmlSourceEl.value = result.mml;
    mmlSourceEl.dispatchEvent(new Event('input'));

    // 変換結果はNES拡張音源(FME-7/N163/VRC7)を借りて再生する設計。有効化はMML本文に
    // 埋め込まれた#EX-*ディレクティブで行われるため、波形エディタへの反映のみ行う
    if (result.n163Wave && MML.WaveformEditor.n163Wave) MML.WaveformEditor.n163Wave.setData(result.n163Wave);

    kssFileStatusEl.innerHTML =
      '<div class="ok">' + T('MML変換完了 ({mode} {bpm} BPM、音源: {chips}) → MMLエディタに出力(FME-7/N163/VRC7を借用して再生)',
        { mode: kssManualBpm ? T('指定') : T('推定'), bpm: result.bpm, chips: result.chips.join(', ') }) + '</div>';

    // 変換直後にコンパイルだけ実行し、DPCMサンプル欄/チャンネル選択欄/モニタ等の
    // 各種UIをMML本文に反映する(再生は開始しない)。
    // 新規変換された曲なので、前回再生していた曲の再生範囲(赤/青ハンドル)を
    // 引き継がず全体にリセットする(preservePlaybackRangeによる引き継ぎを無効化)
    rangeStartSec = 0;
    rangeEndSec = null;
    prepareMmlStream(true);
  }

  kssFileEl.addEventListener('change', loadKssFile);
  document.getElementById('btnKssFilePlay').addEventListener('click', () => {
    playKssStream();
    keyboardDisplay.setMode('nsf');
  });
  document.getElementById('btnKssFileStop').addEventListener('click', () => {
    stopKssPlayback();
    keyboardDisplay.setMode('nsf');
  });
  document.getElementById('btnKssExportWav').addEventListener('click', exportKssWav);
  document.getElementById('btnKss2Mml').addEventListener('click', runKss2Mml);
  document.getElementById('btnKssSongPrev').addEventListener('click', () => changeKssSong(-1));
  document.getElementById('btnKssSongNext').addEventListener('click', () => changeKssSong(1));

  // ── GBS ファイル読み込み・再生 ────────────────────────────────────
  // ★現段階ではネイティブ再生のみ(KSS/NSFのような背景先読みキャプチャ・ピアノロール・
  //   ライブモニタ連携・シーク(scrub)は未実装)。gbs2mml実装時にcaptureGbsSongAsyncを
  //   作る際、KSSのKssReplayStreamPlayerと同様の仕組みへ発展させる想定
  //   (その際はlastPlayMode==='gbs'をcanSeek()/transportStop()のシーク対応リストへ追加すること)。
  const gbsFileEl       = document.getElementById('gbsFile');
  const gbsFileHeaderEl = document.getElementById('gbsFileHeader');
  const gbsPlayDurEl    = document.getElementById('gbsPlayDuration');
  const gbsFileStatusEl = document.getElementById('gbsFileStatus');
  const gbsSongIndexEl  = document.getElementById('gbsSongIndex');
  const gbsSongTotalEl  = document.getElementById('gbsSongTotal');

  let loadedGbsBytes  = null;
  let loadedGbsHeader = null;
  let gbsIsRendering  = false;
  let gbsActivePlayer = null; // GbsStreamPlayer

  function renderGbsHeader(h) {
    let out = '';
    out += T('Magic       : {magic} ({ok})', { magic: h.magic, ok: h.magicOk ? 'OK' : T('不正') }) + '\n';
    out += `Load/Init/Play: ${toHex(h.loadAddr,4)} / ${toHex(h.initAddr,4)} / ${toHex(h.playAddr,4)}\n`;
    out += T('曲数        : {n}', { n: h.numSongs }) + '\n';
    out += T('PLAY駆動    : {mode} ({fps} Hz)',
      { mode: h.timerEnabled ? T('タイマ割込') : T('VBlank割込'), fps: h.playFps.toFixed(2) }) + '\n';
    if (h.title) out += T('タイトル    : {title}', { title: h.title }) + '\n';
    if (h.author) out += T('作者        : {author}', { author: h.author }) + '\n';
    if (h.copyright) out += T('著作権      : {copyright}', { copyright: h.copyright }) + '\n';
    gbsFileHeaderEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = h.magicOk ? 'ok' : 'error';
    pre.textContent = out;
    gbsFileHeaderEl.appendChild(pre);
  }

  async function loadGbsFile() {
    const file = gbsFileEl.files[0];
    if (!file) return;
    stopAllFormatPlayback();
    keyboardDisplay.reset();
    loadedGbsBytes = null; loadedGbsHeader = null;

    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    try {
      const h = MML.GBS.parseHeader(bytes);
      if (!h.magicOk) {
        gbsFileHeaderEl.innerHTML = '<div class="error">' + T('GBSヘッダが不正です。') + '</div>';
        return;
      }
      loadedGbsBytes = bytes;
      loadedGbsHeader = h;
      renderGbsHeader(h);
      gbsSongIndexEl.min = String(h.firstSong);
      gbsSongIndexEl.max = String(Math.max(h.firstSong, h.numSongs));
      gbsSongIndexEl.value = String(h.firstSong);
      gbsSongTotalEl.textContent = `/ ${h.numSongs}`;
      gbsFileStatusEl.innerHTML = '';
    } catch (e) {
      gbsFileHeaderEl.innerHTML = '<div class="error">' + T('読み込みエラー: {msg}', { msg: e.message }) + '</div>';
    }
  }

  function stopGbsPlayback() {
    if (gbsActivePlayer) {
      gbsActivePlayer.destroy();
      gbsActivePlayer = null;
    }
    gbsRollToken++; // 進行中の先読みキャプチャ結果を無効化
    keyboardDisplay.setRollTimeline(null);
    updateGbsPlayButton();
  }

  // captureGbsSongAsync() の結果(snapshots)からピアノロール用タイムライン(共通形状)を
  // 構築する。src/gbs2mml/expansion/*.js の抽出関数をenvReg/waveReg無し(ロールは
  // 音色番号/エンベロープを必要としない)で呼び出すのはbuildKssRollTimelineと同じ考え方。
  function buildGbsRollTimeline(snapshots, frameRate) {
    const frameDur = 1 / frameRate;
    // toNotes: 音程が同じまま途切れず続いている区間を1本の音符に統合する
    // (buildKssRollTimelineと同じ考え方。ただしGBは実トリガbitがあるため
    // retrigger判定はtriggerSeqの変化そのもの=extraction側で既にイベント境界として
    // 反映済みなので、ここでは単純にnote/startの連続性だけ見ればよい)。
    const toNotes = (events) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const prev = out[out.length - 1];
        if (prev && endFrame === e.start && prev.midi === e.note + 12) {
          prev.endSec = e.end * frameDur;
          prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
          if (e.freqSeq) prev.freqSeq.push(...e.freqSeq);
        } else {
          out.push({ startSec: e.start * frameDur, endSec: e.end * frameDur, midi: e.note + 12, vol: (e.volume || 0) / 15, freqSeq: e.freqSeq ? e.freqSeq.slice() : [] });
        }
        endFrame = e.end;
      }
      return out;
    };
    const tracks = [];
    // ★pulse()の音量はhwEnvelope.js側で64Hz実機クロックとplayFps(=frameRate)の位相を
    // 見て再計算するため、frameRateを渡さないとvolumeAt()内でNaNになりvol>0が常にfalseに
    // なる(=無音扱い)。この呼び出しはhwEnvelope.js導入時から一度もframeRateを渡して
    // おらず、GB1/GB2/GNのロール行が常に空になっていた(waveだけが表示されていた原因。
    // wave.jsは音量に生のvolumeShiftを直接使いplayFpsに依存しないため無症状だった)。
    const ch1 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch1', null, frameRate);
    const ch2 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch2', null, frameRate);
    const noise = MML.Gbs2MmlExpansion.noise(snapshots, null, frameRate);
    const wave = MML.Gbs2MmlExpansion.wave(snapshots);
    tracks.push({ id: 'GB1', color: '#66ddff', notes: toNotes(ch1.events) });
    tracks.push({ id: 'GB2', color: '#0077dd', notes: toNotes(ch2.events) });
    tracks.push({ id: 'GN', color: '#aaaaaa', notes: toNotes(noise.events) });
    tracks.push({ id: 'GW', color: '#ffcc00', notes: toNotes(wave.events) });
    return tracks;
  }

  function updateGbsPlayButton() {
    const btn = document.getElementById('btnGbsFilePlay');
    if (!btn) return;
    const playing = gbsActivePlayer && gbsActivePlayer.isPlaying;
    btn.classList.toggle('is-playing', !!playing);
    btn.title = playing ? T('一時停止') : T('再生');
    btn.disabled = gbsIsRendering;
  }

  function playGbsStream() {
    if (!loadedGbsBytes) {
      gbsFileStatusEl.innerHTML = '<div class="error">' + T('先にGBSファイルを読み込んでください。') + '</div>';
      return;
    }
    // 再生中なら一時停止 / 一時停止中なら再開
    if (gbsActivePlayer && lastPlayMode === 'gbs') {
      if (gbsActivePlayer.isPlaying) transportPause();
      else transportPlay();
      return;
    }

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // 他フォーマットの再生と先読みキャプチャを止める(ロールの取り違え防止)
    transportStop();
    stopAllFormatPlayback();
    stopVoiceMonitor();
    invalidateOtherRollPrefetch('gbs');
    lastPlayMode = 'gbs';
    gbsBufferedFraction = 0;
    updateSeekBufferedUI();

    // ヘッダのfirstSongは1始まり(表示用)。INIT呼出は0始まりの曲番号を渡す仕様
    // (src/gbs/gbsHeader.js・src/emulator/gbsPlayer.js参照)。
    const songNoDisplay = parseInt(gbsSongIndexEl.value, 10) || loadedGbsHeader.firstSong;
    const songIndex = Math.max(0, songNoDisplay - loadedGbsHeader.firstSong);
    const duration = parseInt(gbsPlayDurEl.value, 10) || 180;
    const gbsFrameRate = loadedGbsHeader.playFps;
    const totalFrames = Math.ceil(duration * gbsFrameRate);

    // NSF/KSSと同じ理由(二重エミュレーション解消・シーク対応)で、ライブ再生用プレイヤーと
    // ロール先読みキャプチャを1本のバックグラウンドregsOnlyキャプチャに統合する
    // (KssReplayStreamPlayerと対になるGbsReplayStreamPlayer、src/audio/gbs-stream-player.js)。
    const player = new MML.Audio.GbsReplayStreamPlayer(audioCtx);
    player._baseGain = player.gainNode.gain.value;
    endFadeActive = false;
    player.onEnded = () => {
      updateGbsPlayButton();
      updateTransportUI();
      // NsfReplayStreamPlayerと同じレース対策(playNsfStream内のonEnded参照)
      setTimeout(() => { if (currentTransportPlayer() === player) finishSoundFilePlayback(); }, 0);
    };
    // NsfReplayStreamPlayerと同じ理由(playNsfStream参照): 10秒無音を検出したら1秒待って次の曲へ
    player.onSilenceTimeout = () => {
      setTimeout(() => {
        if (currentTransportPlayer() !== player) return;
        stopGbsPlayback();
        autoAdvanceGbsSong();
      }, 1000);
    };
    gbsActivePlayer = player;
    player.setSpeed(currentSpeedFactor);
    workletDuration = duration;

    resetPlaybackRangeToFull(duration);
    seekBarEl.value = '0';
    timeDisplayEl.textContent = `00:00 / ${formatTime(duration)}`;

    gbsFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = T('再生中: 曲{song}  (最大 {time})', { song: songNoDisplay, time: formatTime(duration) });
    gbsFileStatusEl.appendChild(pre);

    // バックグラウンドキャプチャ(regsOnly)。ピアノロールと実再生の両方の情報源を兼ねる。
    // onProgressで途中経過(その時点までのsnapshots、進行中の配列への参照なので以後
    // キャプチャが進むにつれ自動的に埋まっていく)を受け取り、最初の1回でplayer.load()
    // して再生を開始する(以降のチャンクを待つ必要はない)。
    const ROLL_REBUILD_INTERVAL_FRAMES = 120;
    keyboardDisplay.setRollTimeline(null);
    const myGbsRollToken = ++gbsRollToken;
    let lastGbsRollBuiltFrame = 0;
    let gbsPlaybackLoaded = false;
    MML.Emu.captureGbsSongAsync(loadedGbsBytes, {
      songIndex, durationSeconds: duration, sampleRate: audioCtx.sampleRate,
      regsOnly: true,
      shouldCancel: () => myGbsRollToken !== gbsRollToken
    }, (done, total, data) => {
      if (myGbsRollToken !== gbsRollToken) return; // 曲切替/停止で無効化済み

      if (!gbsPlaybackLoaded) {
        gbsPlaybackLoaded = true;
        player.load(loadedGbsBytes, songIndex, totalFrames, { snapshots: data.snapshots }, getChannelMuteConfig());
        // 鍵盤表示: GB APUをライブチップから直接スナップショットする(KSSのapplyKssMonitorSourceと同じ考え方)。
        setMonitorSource({
          regSnapshots: [{}], totalFrames: 1,
          samplesPerFrame: audioCtx.sampleRate / gbsFrameRate,
          sampleRate: audioCtx.sampleRate,
          writeLog: [], cpuSnapshots: null, memSnapshots: null,
          getGbsApu: liveGbsApu
        }, () => gbsActivePlayer ? gbsActivePlayer.getPosition() : 0, ['gbs']);
        transportPlay();
      }

      gbsBufferedFraction = total > 0 ? done / total : 0;
      updateSeekBufferedUI();

      if (done - lastGbsRollBuiltFrame < ROLL_REBUILD_INTERVAL_FRAMES && done < total) return;
      lastGbsRollBuiltFrame = done;
      keyboardDisplay.setRollTimeline(buildGbsRollTimeline(data.snapshots.slice(0, done), gbsFrameRate));
    }).catch((e) => {
      // 先読み失敗時はピアノロールなしで続行するが、原因を追えるようログには残す(KSSと同じ理由)
      console.error('GBS先読みキャプチャに失敗:', e);
    });
  }

  function changeGbsSong(delta) {
    const min = parseInt(gbsSongIndexEl.min, 10) || 0;
    const max = parseInt(gbsSongIndexEl.max, 10) || 0;
    let v = (parseInt(gbsSongIndexEl.value, 10) || 0) + delta;
    v = Math.max(min, Math.min(max, v));
    gbsSongIndexEl.value = String(v);
    // NSFのchangeNsfSong()と同じく無条件に再生を開始する(KSSと同じ理由、changeKssSong参照)
    stopGbsPlayback();
    playGbsStream();
  }

  async function exportGbsWav() {
    if (!loadedGbsBytes) {
      gbsFileStatusEl.innerHTML = '<div class="error">' + T('先にGBSファイルを読み込んでください。') + '</div>';
      return;
    }
    if (gbsIsRendering) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const songNoDisplay = parseInt(gbsSongIndexEl.value, 10) || loadedGbsHeader.firstSong;
    const songIndex = Math.max(0, songNoDisplay - loadedGbsHeader.firstSong);
    const duration = parseInt(gbsPlayDurEl.value, 10) || 30;
    const sampleRate = audioCtx.sampleRate;
    gbsIsRendering = true;
    updateGbsPlayButton();
    gbsFileStatusEl.innerHTML = '<div>' + T('WAV書き出し用レンダリング中…') + '</div>';
    await new Promise(resolve => setTimeout(resolve, 10)); // UIを一度更新させてから重い処理へ入る

    const player = new MML.Emu.GbsPlayer(loadedGbsBytes);
    player.initSong(songIndex);
    const totalFrames = Math.ceil(duration * player.frameRate);
    const totalSamples = Math.round(totalFrames * sampleRate / player.frameRate);
    const audioL = new Float32Array(totalSamples);
    const audioR = new Float32Array(totalSamples);
    let pos = 0;
    for (let f = 0; f < totalFrames && pos < totalSamples; f++) {
      const chunk = player.renderFrame(sampleRate, false, true); // stereo
      const n = Math.min(chunk.left.length, totalSamples - pos);
      audioL.set(chunk.left.subarray(0, n), pos);
      audioR.set(chunk.right.subarray(0, n), pos);
      pos += n;
    }

    gbsIsRendering = false;
    updateGbsPlayButton();

    // ライブ再生(GbsReplayStreamPlayer)と同じgain(2.5)+リミッタをオフライン適用する。
    // buildWavBlobStereo単体のMath.max(-1,Math.min(1,...))は単純なハードクランプで、
    // 密度の高い区間ではピークが±1.5前後まで達し大きく歪む(GBSクリッピング修正の
    // 経緯参照)。ライブ再生側は既にDynamicsCompressorNodeで対策済みだったが、
    // WAV書き出しは別経路のため対策が漏れていた。同じ音を書き出すため、
    // OfflineAudioContextでライブ再生と同一のgain→リミッタのグラフを通してから書き出す。
    const { left: limitedL, right: limitedR } = await applyGbsLimiterOffline(audioL, audioR, sampleRate);

    const filename = `gbs_song${songNoDisplay}.wav`;
    // NR51(パンレジスタ)を反映したステレオ出力。gainはリミッタ側で適用済みなので1.0。
    const blob = buildWavBlobStereo(limitedL, limitedR, sampleRate, 1.0);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);

    gbsFileStatusEl.innerHTML = '<div class="ok">' + T('書き出し完了: {file}', { file: filename }) + '</div>';
  }

  async function runGbs2Mml() {
    if (!loadedGbsBytes) {
      gbsFileStatusEl.innerHTML = '<div class="error">' + T('先にGBSファイルを読み込んでください。') + '</div>';
      return;
    }
    if (gbsIsRendering) return;

    const songNoDisplay = parseInt(gbsSongIndexEl.value, 10) || loadedGbsHeader.firstSong;
    const songIndex = Math.max(0, songNoDisplay - loadedGbsHeader.firstSong);
    const duration = parseInt(gbsPlayDurEl.value, 10) || 60;
    gbsIsRendering = true;
    updateGbsPlayButton();
    gbsFileStatusEl.innerHTML = '<div>' + T('MML変換用キャプチャ中… (数秒かかります)') + '</div>';
    await new Promise(resolve => setTimeout(resolve, 10));

    const gbsManualBpm = getManualBpm('gbs');
    let result;
    try {
      result = await MML.GBS2MML.fromGbs(loadedGbsBytes, songIndex, duration, { bpm: gbsManualBpm });
    } catch (e) {
      gbsIsRendering = false;
      updateGbsPlayButton();
      gbsFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }

    gbsIsRendering = false;
    updateGbsPlayButton();

    mmlSourceEl.value = result.mml;
    mmlSourceEl.dispatchEvent(new Event('input'));

    // 変換結果はNES拡張音源(FDS)を借りて再生する設計。有効化はMML本文に埋め込まれた
    // #EX-*ディレクティブで行われるため、波形エディタへの反映のみ行う
    if (result.fdsWave && MML.WaveformEditor.fdsWave) MML.WaveformEditor.fdsWave.setData(result.fdsWave);

    gbsFileStatusEl.innerHTML =
      '<div class="ok">' + T('MML変換完了 ({mode} {bpm} BPM、音源: {chips}) → MMLエディタに出力(FDSを借用して再生)',
        { mode: gbsManualBpm ? T('指定') : T('推定'), bpm: result.bpm, chips: result.chips.join(', ') }) + '</div>';

    // 変換直後にコンパイルだけ実行し、DPCMサンプル欄/チャンネル選択欄/モニタ等の
    // 各種UIをMML本文に反映する(再生は開始しない)。新規変換された曲なので、前回再生
    // していた曲の再生範囲(赤/青ハンドル)を引き継がず全体にリセットする。
    rangeStartSec = 0;
    rangeEndSec = null;
    prepareMmlStream(true);
  }

  gbsFileEl.addEventListener('change', loadGbsFile);
  document.getElementById('btnGbsFilePlay').addEventListener('click', () => {
    playGbsStream();
    keyboardDisplay.setMode('nsf');
  });
  document.getElementById('btnGbsFileStop').addEventListener('click', () => {
    stopGbsPlayback();
    keyboardDisplay.setMode('nsf');
  });
  document.getElementById('btnGbsExportWav').addEventListener('click', exportGbsWav);
  document.getElementById('btnGbs2Mml').addEventListener('click', runGbs2Mml);
  document.getElementById('btnGbsSongPrev').addEventListener('click', () => changeGbsSong(-1));
  document.getElementById('btnGbsSongNext').addEventListener('click', () => changeGbsSong(1));

  // ── HES(PC Engine)ファイル読み込み・再生 ────────────────────────────────
  // ★HESヘッダにはNSF/GBSと違い「曲数」「PLAYアドレス」が存在しない(hesBus.js冒頭コメント
  //   参照)。トラック番号はゲーム依存の任意値のため、min/max/曲数表示は行わず自由入力とする
  //   (既定値はheader.firstTrack)。再生自体は本物のIRQディスパッチで駆動されるため
  //   (hesPlayer.js)、GBS同様バックグラウンド先読みキャプチャ+スナップショット再生方式。
  const hesFileEl       = document.getElementById('hesFile');
  const hesFileHeaderEl = document.getElementById('hesFileHeader');
  const hesPlayDurEl    = document.getElementById('hesPlayDuration');
  const hesFileStatusEl = document.getElementById('hesFileStatus');
  const hesTrackIndexEl = document.getElementById('hesTrackIndex');

  let loadedHesBytes  = null;
  let loadedHesHeader = null;
  let hesIsRendering  = false;
  let hesActivePlayer = null; // HesReplayStreamPlayer

  function renderHesHeader(h) {
    let out = '';
    out += T('Magic       : {magic} ({ok})', { magic: h.tag, ok: h.magicOk ? 'OK' : T('不正') }) + '\n';
    out += `Init: ${toHex(h.initAddr, 4)}\n`;
    out += T('先頭トラック: {n} (0x{hex})', { n: h.firstTrack, hex: h.firstTrack.toString(16).toUpperCase() }) + '\n';
    out += `MPR0-7: ${h.banks.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}\n`;
    out += T('データ      : {size}byte @ 0x{addr}', { size: h.dataSize, addr: h.addr.toString(16).toUpperCase() }) + '\n';
    if (h.title) out += T('タイトル    : {title}', { title: h.title }) + '\n';
    if (h.author) out += T('作者        : {author}', { author: h.author }) + '\n';
    if (h.copyright) out += T('著作権      : {copyright}', { copyright: h.copyright }) + '\n';
    hesFileHeaderEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = h.magicOk ? 'ok' : 'error';
    pre.textContent = out;
    hesFileHeaderEl.appendChild(pre);
  }

  async function loadHesFile() {
    const file = hesFileEl.files[0];
    if (!file) return;
    stopAllFormatPlayback();
    keyboardDisplay.reset();
    loadedHesBytes = null; loadedHesHeader = null;

    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    try {
      const h = MML.HES.parseHeader(bytes);
      if (!h.magicOk) {
        hesFileHeaderEl.innerHTML = '<div class="error">' + T('HESヘッダが不正です。') + '</div>';
        return;
      }
      loadedHesBytes = bytes;
      loadedHesHeader = h;
      renderHesHeader(h);
      hesTrackIndexEl.value = String(h.firstTrack);
      hesFileStatusEl.innerHTML = '';
    } catch (e) {
      hesFileHeaderEl.innerHTML = '<div class="error">' + T('読み込みエラー: {msg}', { msg: e.message }) + '</div>';
    }
  }

  function stopHesPlayback() {
    if (hesActivePlayer) {
      hesActivePlayer.destroy();
      hesActivePlayer = null;
    }
    hesRollToken++; // 進行中の先読みキャプチャ結果を無効化
    keyboardDisplay.setRollTimeline(null);
    updateHesPlayButton();
  }

  // captureHesSongAsync() の結果(snapshots)からピアノロール用タイムライン(共通形状)を
  // 構築する。src/hes2mml/expansion/*.js の抽出関数をenvReg/waveReg無し(ロールは
  // 音色番号/エンベロープを必要としない)で呼び出すのはbuildKssRollTimelineと同じ考え方。
  function buildHesRollTimeline(snapshots, frameRate) {
    const frameDur = 1 / frameRate;
    const toNotes = (events) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const prev = out[out.length - 1];
        if (prev && endFrame === e.start && prev.midi === e.note + 12) {
          prev.endSec = e.end * frameDur;
          prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
          if (e.freqSeq) prev.freqSeq.push(...e.freqSeq);
        } else {
          out.push({ startSec: e.start * frameDur, endSec: e.end * frameDur, midi: e.note + 12, vol: (e.volume || 0) / 15, freqSeq: e.freqSeq ? e.freqSeq.slice() : [] });
        }
        endFrame = e.end;
      }
      return out;
    };
    const tracks = [];
    const waveResult = MML.Hes2MmlExpansion.wave(snapshots);
    // id/色はkeyboard.js extractChannels()のisHesブロック(PSG0-5, PCOLS)と揃える
    // (揃えないとch設定の色ピッカー・鍵盤表示・ピアノロールで同じchなのに色が食い違う)。
    const colors = ['#66ddff', '#33aaff', '#0099ff', '#33cc99', '#ffaa00', '#ff6699'];
    // ノイズはch4/5(ノイズ生成回路を持つ物理ch)独自の発音であり、行/鍵盤表示でも
    // 同じPSG4/PSG5の行がwave/noiseを兼ねる(keyboard.js extractChannels参照)。
    // 以前はMML.Hes2MmlExpansion.noise()(MML書き出し用、2A03への借用は物理1chしか
    // 無いためch5優先で1本にマージ)の結果をどの行にも属さない別id('PN')の孤立トラック
    // として表示していたため、①色が行と食い違う②ミュートしてもch4/5どちらのミュートも
    // 効かない③該当ch(ノイズ発音中)の行自体はwaveの休符のまま何も表示されない、
    // という3点セットのバグになっていた。ロールは6ch独立表示なので、noiseChannel()で
    // ch4とch5をそれぞれ個別に(マージ無しで)抽出し、そのchの波形音符と同じトラックへ
    // 合流させる(wave/noiseは同一chで排他なので時間的に重ならず、単純にマージしてよい)。
    waveResult.channels.forEach((ch, i) => {
      let notes = toNotes(ch.events);
      if (i === 4 || i === 5) {
        const noiseNotes = toNotes(MML.Hes2MmlExpansion.noiseChannel(snapshots, i).events);
        if (noiseNotes.length) notes = notes.concat(noiseNotes).sort((a, b) => a.startSec - b.startSec);
      }
      tracks.push({ id: `PSG${i}`, color: colors[i % colors.length], notes });
    });
    return tracks;
  }

  function updateHesPlayButton() {
    const btn = document.getElementById('btnHesFilePlay');
    if (!btn) return;
    const playing = hesActivePlayer && hesActivePlayer.isPlaying;
    btn.classList.toggle('is-playing', !!playing);
    btn.title = playing ? T('一時停止') : T('再生');
    btn.disabled = hesIsRendering;
  }

  // ★HESはHesReplayStreamPlayer(GBS/KSSと同じスナップショット再生方式)を使う。
  //   PCM(DDA)対応の経緯・設計の詳細はsrc/audio/hes-stream-player.js冒頭コメント参照。
  //   要点: DDAチャンネルの生の書込み値列(dpcmTrace)を、クリップ化・DMCエンコード等の
  //   変換を挟まずそのまま再生時にAPUへ書き戻す。CPU命令エミュレーションは相変わらず
  //   一切リアルタイムでは行わず、波形/ノイズchは従来通りのスナップショット再生のまま。
  function playHesStream() {
    if (!loadedHesBytes) {
      hesFileStatusEl.innerHTML = '<div class="error">' + T('先にHESファイルを読み込んでください。') + '</div>';
      return;
    }
    if (hesActivePlayer && lastPlayMode === 'hes') {
      if (hesActivePlayer.isPlaying) transportPause();
      else transportPlay();
      return;
    }

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    transportStop();
    stopAllFormatPlayback();
    stopVoiceMonitor();
    invalidateOtherRollPrefetch('hes');
    lastPlayMode = 'hes';
    hesBufferedFraction = 0;
    updateSeekBufferedUI();

    const track = parseInt(hesTrackIndexEl.value, 10) || 0;
    const duration = parseInt(hesPlayDurEl.value, 10) || 180;
    const hesFrameRate = MML.HES.VBLANK_FPS;
    const totalFrames = Math.ceil(duration * hesFrameRate);

    // ★2026-08 PCM(DDA)対応前の設計に戻した(GBS/KSSと同じHesReplayStreamPlayer、
    // ユーザー要望)。CPU駆動のリアルタイム合成(HesStreamPlayer)や事前一括レンダリング
    // (HesBufferedPlayer、いずれもsrc/audio/hes-stream-player.jsに定義は残したまま)は
    // DDA(PCM)の高頻度書込みを正確に再現するために順に試したが、いずれも「がくがく」
    // する・鍵盤表示が働かない等の副作用が解消しきれなかったため、まずは安定していた
    // この方式へ戻す。PCM(DDA)を使う曲の音は再びこの方式の制約(フレーム単位の
    // スナップショットでは追いきれない)を受ける。
    const player = new MML.Audio.HesReplayStreamPlayer(audioCtx);
    player._baseGain = player.gainNode.gain.value;
    endFadeActive = false;
    player.onEnded = () => {
      updateHesPlayButton();
      updateTransportUI();
      // NsfReplayStreamPlayerと同じレース対策(playNsfStream内のonEnded参照)
      setTimeout(() => { if (currentTransportPlayer() === player) finishSoundFilePlayback(); }, 0);
    };
    // NsfReplayStreamPlayerと同じ理由(playNsfStream参照): 10秒無音を検出したら1秒待って次の曲へ
    player.onSilenceTimeout = () => {
      setTimeout(() => {
        if (currentTransportPlayer() !== player) return;
        stopHesPlayback();
        autoAdvanceHesTrack();
      }, 1000);
    };
    hesActivePlayer = player;
    player.setSpeed(currentSpeedFactor);
    workletDuration = duration;

    resetPlaybackRangeToFull(duration);
    seekBarEl.value = '0';
    timeDisplayEl.textContent = `00:00 / ${formatTime(duration)}`;

    hesFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = T('再生中: トラック{track}  (最大 {time})', { track, time: formatTime(duration) });
    hesFileStatusEl.appendChild(pre);

    // バックグラウンドキャプチャ(regsOnly)。ピアノロールと実再生の両方の情報源を兼ねる。
    const ROLL_REBUILD_INTERVAL_FRAMES = 120;
    keyboardDisplay.setRollTimeline(null);
    const myHesRollToken = ++hesRollToken;
    let lastHesRollBuiltFrame = 0;
    let hesPlaybackLoaded = false;
    MML.Emu.captureHesSongAsync(loadedHesBytes, {
      track, durationSeconds: duration, sampleRate: audioCtx.sampleRate,
      regsOnly: true,
      shouldCancel: () => myHesRollToken !== hesRollToken
    }, (done, total, data) => {
      if (myHesRollToken !== hesRollToken) return; // 曲切替/停止で無効化済み

      if (!hesPlaybackLoaded) {
        hesPlaybackLoaded = true;
        player.load(loadedHesBytes, track, totalFrames, { snapshots: data.snapshots }, getChannelMuteConfig());
        setMonitorSource({
          regSnapshots: [{}], totalFrames: 1,
          samplesPerFrame: audioCtx.sampleRate / hesFrameRate,
          sampleRate: audioCtx.sampleRate,
          writeLog: [], cpuSnapshots: null, memSnapshots: null,
          getHesApu: liveHesApu
        }, () => hesActivePlayer ? hesActivePlayer.getPosition() : 0, ['hes']);
        transportPlay();
      }

      hesBufferedFraction = total > 0 ? done / total : 0;
      updateSeekBufferedUI();

      if (done - lastHesRollBuiltFrame < ROLL_REBUILD_INTERVAL_FRAMES && done < total) return;
      lastHesRollBuiltFrame = done;
      const snapsSoFar = data.snapshots.slice(0, done);
      keyboardDisplay.setRollTimeline(buildHesRollTimeline(snapsSoFar, hesFrameRate));
      // DDA(PCM)を担当するchの判定も同じ頻度で更新する(main.js playHesStream()冒頭の
      // 設計方針、hes-stream-player.js HesReplayStreamPlayer.setDdaChannel()参照)。
      // どのchをDDAとして扱うかの判定(曲全体でDDA区間が最も長い1ch)だけhes2mml変換と
      // 共通のロジック(extractDdaClips)を借りるが、実際の再生には生のdpcmTrace列を
      // そのまま渡す(クリップ化・DMCエンコードは経由しない。hes-stream-player.js
      // 冒頭コメント参照: それらを経由すると「以前(CPU駆動ライブ再生)の音」と別物になる)。
      if (data.dpcmTrace && data.controlTrace) {
        const ddaInfo = MML.Hes2MmlExpansion.extractDdaClips(snapsSoFar, data.dpcmTrace, data.controlTrace, hesFrameRate);
        player.setDdaChannel(ddaInfo.channel, ddaInfo.channel >= 0 ? data.dpcmTrace[ddaInfo.channel] : null);
      }
    }).catch((e) => {
      console.error('HES先読みキャプチャに失敗:', e);
    });
  }

  function changeHesTrack(delta) {
    let v = (parseInt(hesTrackIndexEl.value, 10) || 0) + delta;
    v = Math.max(0, Math.min(255, v));
    hesTrackIndexEl.value = String(v);
    // NSFのchangeNsfSong()と同じく無条件に再生を開始する(KSS/GBSと同じ理由、changeKssSong参照)
    stopHesPlayback();
    playHesStream();
  }

  async function exportHesWav() {
    if (!loadedHesBytes) {
      hesFileStatusEl.innerHTML = '<div class="error">' + T('先にHESファイルを読み込んでください。') + '</div>';
      return;
    }
    if (hesIsRendering) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const track = parseInt(hesTrackIndexEl.value, 10) || 0;
    const duration = parseInt(hesPlayDurEl.value, 10) || 30;
    const sampleRate = audioCtx.sampleRate;
    hesIsRendering = true;
    updateHesPlayButton();
    hesFileStatusEl.innerHTML = '<div>' + T('WAV書き出し用レンダリング中…') + '</div>';
    await new Promise(resolve => setTimeout(resolve, 10));

    const player = new MML.Emu.HesPlayer(loadedHesBytes);
    player.initSong(track);
    const totalFrames = Math.ceil(duration * player.frameRate);
    const totalSamples = Math.round(totalFrames * sampleRate / player.frameRate);
    const audioL = new Float32Array(totalSamples);
    const audioR = new Float32Array(totalSamples);
    let pos = 0;
    for (let f = 0; f < totalFrames && pos < totalSamples; f++) {
      const chunk = player.renderFrame(sampleRate, false, null, true); // stereo
      const n = Math.min(chunk.left.length, totalSamples - pos);
      audioL.set(chunk.left.subarray(0, n), pos);
      audioR.set(chunk.right.subarray(0, n), pos);
      pos += n;
    }

    hesIsRendering = false;
    updateHesPlayButton();

    const filename = `hes_track${track}.wav`;
    // $0805(chバランス)/$0801(全体バランス)を反映したステレオ出力。
    const blob = buildWavBlobStereo(audioL, audioR, sampleRate, 4.0);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);

    hesFileStatusEl.innerHTML = '<div class="ok">' + T('書き出し完了: {file}', { file: filename }) + '</div>';
  }

  async function runHes2Mml() {
    if (!loadedHesBytes) {
      hesFileStatusEl.innerHTML = '<div class="error">' + T('先にHESファイルを読み込んでください。') + '</div>';
      return;
    }
    if (hesIsRendering) return;

    const track = parseInt(hesTrackIndexEl.value, 10) || 0;
    const duration = parseInt(hesPlayDurEl.value, 10) || 60;
    hesIsRendering = true;
    updateHesPlayButton();
    hesFileStatusEl.innerHTML = '<div>' + T('MML変換用キャプチャ中… (数秒かかります)') + '</div>';
    await new Promise(resolve => setTimeout(resolve, 10));

    const hesManualBpm = getManualBpm('hes');
    let result;
    try {
      result = await MML.HES2MML.fromHes(loadedHesBytes, track, duration, { bpm: hesManualBpm });
    } catch (e) {
      hesIsRendering = false;
      updateHesPlayButton();
      hesFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }

    hesIsRendering = false;
    updateHesPlayButton();

    mmlSourceEl.value = result.mml;
    mmlSourceEl.dispatchEvent(new Event('input'));

    if (result.n163Wave && MML.WaveformEditor.n163Wave) MML.WaveformEditor.n163Wave.setData(result.n163Wave);

    // DPCM(DDA/PCM抽出分)バイナリファイルをダウンロード(保存用)。同時にdpcmSampleCacheへ
    // 直接投入し、生成されたMML中の@DPCM<n>定義をユーザーがファイル再選択しなくても
    // そのまま再生・NSF書き出しできるようにする(nsf2mml/converter.jsと同じパターン)
    for (const f of (result.dpcmFiles || [])) {
      downloadBin(f.name, f.bytes);
      dpcmSampleCache[f.name] = f.bytes;
    }
    const dpcmMsg = (result.dpcmFiles && result.dpcmFiles.length > 0)
      ? T('、DPCM {n} ファイル出力', { n: result.dpcmFiles.length }) : '';

    hesFileStatusEl.innerHTML =
      '<div class="ok">' + T('MML変換完了 ({mode} {bpm} BPM、音源: {chips}{dpcm}) → MMLエディタに出力(N163を借用して再生)',
        { mode: hesManualBpm ? T('指定') : T('推定'), bpm: result.bpm, chips: result.chips.join(', '), dpcm: dpcmMsg }) + '</div>';

    rangeStartSec = 0;
    rangeEndSec = null;
    prepareMmlStream(true);
  }

  hesFileEl.addEventListener('change', loadHesFile);
  document.getElementById('btnHesFilePlay').addEventListener('click', () => {
    playHesStream();
    keyboardDisplay.setMode('nsf');
  });
  document.getElementById('btnHesFileStop').addEventListener('click', () => {
    stopHesPlayback();
    keyboardDisplay.setMode('nsf');
  });
  document.getElementById('btnHesExportWav').addEventListener('click', exportHesWav);
  document.getElementById('btnHes2Mml').addEventListener('click', runHes2Mml);
  document.getElementById('btnHesTrackPrev').addEventListener('click', () => changeHesTrack(-1));
  document.getElementById('btnHesTrackNext').addEventListener('click', () => changeHesTrack(1));

  // ==========================================================================
  // 統合サウンドファイルウィンドウ: 拡張子でNSF/SPC/KSSパネルを切り替える
  // ==========================================================================
  (function initUnifiedSoundFileWindow() {
    const soundFileEl = document.getElementById('soundFile');
    const soundPlayTitleEl = document.getElementById('soundPlayTitle');
    const formatToInputId = { nsf: 'nsfFile', spc: 'spcFile', kss: 'kssFile', gbs: 'gbsFile', hes: 'hesFile' };
    const formatToLabel = { nsf: T('NSF (ファミコン)'), spc: T('SPC (スーパーファミコン)'), kss: 'KSS (MSX)', gbs: 'GBS (Game Boy)', hes: 'HES (PC Engine)' };

    function showSoundPanel(format) {
      ['none', 'nsf', 'spc', 'kss', 'gbs', 'hes'].forEach((f) => {
        const panel = document.getElementById('soundPanel-' + f);
        if (panel) panel.style.display = f === format ? '' : 'none';
      });
      soundPlayTitleEl.textContent = formatToLabel[format] || T('サウンドファイルを開く');
    }

    soundFileEl.addEventListener('change', () => {
      const file = soundFileEl.files[0];
      if (!file) return;
      const ext = file.name.split('.').pop().toLowerCase();
      const targetInputId = formatToInputId[ext];
      if (!targetInputId) {
        alert(T('対応していないファイル形式です: .{ext}\n(対応形式: NSF, SPC, KSS, GBS, HES)', { ext }));
        soundFileEl.value = '';
        return;
      }
      const targetInput = document.getElementById(targetInputId);
      const dt = new DataTransfer();
      dt.items.add(file);
      targetInput.files = dt.files;
      targetInput.dispatchEvent(new Event('change'));
      showSoundPanel(ext);
    });

    // ヘッダーの「サウンドファイルを開く」ボタン: ウィンドウを開くのと同時に
    // ファイル選択ダイアログを直接表示する（floatingWindows.jsの汎用トグル処理の後に実行され、
    // その時点でウィンドウの表示/非表示は確定している）
    const openBtn = document.querySelector('.toggle-btn[data-target="win-soundplay"]');
    const soundWinEl = document.getElementById('win-soundplay');
    if (openBtn && soundWinEl) {
      openBtn.addEventListener('click', () => {
        if (soundWinEl.style.display !== 'none') {
          soundFileEl.click();
        }
      });
    }

    // ウィンドウ自体のタイトル行にあるファイルを開くアイコン(ウィンドウが既に開いている状態で
    // 別のファイルへ差し替える用)
    const inlineOpenBtn = document.getElementById('btnSoundFileOpenInline');
    if (inlineOpenBtn) inlineOpenBtn.addEventListener('click', () => soundFileEl.click());

    // ウィンドウを閉じたら再生を止め、先読みキャプチャ(writeLog/snapshots等)も破棄する
    // (floatingWindows.jsの汎用closeハンドラは表示/非表示の切替のみで、鳴りっぱなし・
    // メモリ蓄積を防ぐ処理を持たないため、このウィンドウ専用に追加で配線する)。
    const soundWinCloseBtn = soundWinEl ? soundWinEl.querySelector('.float-window-close') : null;
    if (soundWinCloseBtn) {
      soundWinCloseBtn.addEventListener('click', () => stopSoundFileWindowPlayback());
    }
  })();
})();
