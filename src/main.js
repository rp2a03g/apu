/*
 * Phase 1 動作確認UI
 * - 6502アセンブラのテスト（アセンブル結果・シンボルテーブル・エラー表示）
 * - NSFヘッダ情報入力 → NSFバイナリ生成・ダウンロード
 */
(function () {
  const sourceEl = document.getElementById('source');
  const asmOutputEl = document.getElementById('asmOutput');
  const nsfOutputEl = document.getElementById('nsfOutput');

  sourceEl.value = MML.Driver.SAMPLE_SOURCE;

  const mmlSourceEl = document.getElementById('mmlSource');
  const mmlOutputEl = document.getElementById('mmlOutput');
  mmlSourceEl.value = MML.Mml.SAMPLE_SOURCE;

  // --- Phase 6: シンタックスハイライト & 波形エディタ ---
  const mmlHighlightEl = document.getElementById('mmlHighlight');
  // srcStart(絶対文字位置) -> DOM要素。再生ハイライト機能が対象spanをO(1)で引くための索引で、
  // オーバーレイのHTMLが変わるたび(attachHighlighterのonUpdate経由で)再構築する
  let mmlHighlightIndex = new Map();
  MML.Mml.attachHighlighter(mmlSourceEl, mmlHighlightEl, () => {
    mmlHighlightIndex = MML.Mml.buildOffsetIndex(mmlHighlightEl);
  });
  MML.WaveformEditor.init();

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

  const EXPANSION_CHIP_FLAGS = {
    none: 0,
    vrc6: MML.NSF.CHIP_FLAGS.VRC6,
    vrc7: MML.NSF.CHIP_FLAGS.VRC7,
    fds: MML.NSF.CHIP_FLAGS.FDS,
    mmc5: MML.NSF.CHIP_FLAGS.MMC5,
    n163: MML.NSF.CHIP_FLAGS.N163,
    fme7: MML.NSF.CHIP_FLAGS.FME7
  };

  // MML.Mml.compile()のresult.expansionsは'dpcm'を含みうる(チャンネル文字割当等の
  // 内部処理で拡張音源と同じ優先順位機構を借用しているため)。しかしDPCMは2A03内蔵
  // 機能であり、VRC6/FDS等のカートリッジ側拡張チップとは性質が異なる(実機にDPCMを
  // 「載せるか選ぶ」という概念自体が無い)ため、ユーザー向け表示では拡張音源として
  // 数えない。機能的な配列自体(result.expansions)は変更せず表示時にだけ除外する
  function displayExpansions(list) {
    return (list || []).filter(name => name !== 'dpcm');
  }

  // チェック済みの拡張音源チップ名の配列を返す(複数選択可)
  function getExpansionChips() {
    return Array.from(document.querySelectorAll('.expansionChipCheck:checked')).map(el => el.value);
  }

  function setExpansionChips(names) {
    const set = new Set(names || []);
    document.querySelectorAll('.expansionChipCheck').forEach(el => { el.checked = set.has(el.value); });
  }

  function getExtraChipsFlag() {
    return getExpansionChips().reduce((flags, name) => flags | (EXPANSION_CHIP_FLAGS[name] || 0), 0);
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
    clearTimeout(muteRerenderTimer);
    muteRerenderTimer = setTimeout(() => {
      if (lastPlayMode === 'capture-nsf') {
        runCapture();
      }
      // MML / NSF Worklet 再生中はミュートを即時送信するので到達しない
    }, 300);
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
      if (lastPlayMode === 'capture-mml') workletDuration = activePlayer.getDuration();
    }
    if (spcActivePlayer && spcActivePlayer.setSpeed) spcActivePlayer.setSpeed(factor);
    if (kssActivePlayer && kssActivePlayer.setSpeed) kssActivePlayer.setSpeed(factor);
  };

  let monitorState = null;

  // ピアノロールの先読みキャプチャは非同期で走るため、曲切替/停止で古い結果を
  // 反映しないよう世代トークンで無効化する(NSF実ファイル再生・SPC・KSSの3経路)。
  let nsfRollToken = 0;
  let spcRollToken = 0;
  let kssRollToken = 0;

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
      cpuRegMonitorEl.textContent = '（再生中の情報がありません）';
      soundRegMonitorEl.textContent = '（再生中の情報がありません）';
      memMonitorEl.textContent = '（再生中の情報がありません）';
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
      cpuRegMonitorEl.textContent = '（MML再生中はCPUレジスタの情報はありません）';
    }

    // --- サウンドレジスタ ---
    if (regAddrs.length === 0) {
      soundRegMonitorEl.textContent = '（書き込みがありません）';
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
      memMonitorEl.textContent = '（MML再生中はメモリ情報はありません）';
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
    mmlHighlightedElements = new Set();
    mmlHighlightLastFrame = -1;
    mmlHighlightLastFollowSrc = -1;
  }

  function scrollMmlEditorToElement(el) {
    const containerRect = mmlHighlightEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const delta = (elRect.top + elRect.height / 2) - (containerRect.top + containerRect.height / 2);
    mmlSourceEl.scrollTop += delta; // overlay側はattachHighlighterのscrollリスナーで自動追従
  }

  function updateMmlPlaybackHighlight(frameIndex) {
    const compiled = lastMmlCompiled;
    const active = mmlHighlightEnableEl.checked && !mmlHighlightSuppressed && lastPlayMode === 'capture-mml' &&
      compiled && compiled.highlightRanges && frameIndex >= 0;
    if (!active) { if (mmlHighlightedElements.size > 0) clearMmlPlaybackHighlight(); return; }
    if (frameIndex === mmlHighlightLastFrame) return; // 位置が変わっていなければ再描画不要
    mmlHighlightLastFrame = frameIndex;

    const nextElements = new Set();
    const followCh = mmlFollowChannelEl.value;
    let followEl = null;
    for (const ch of compiled.channelLetters) {
      if (keyboardDisplay.isChannelMuted(ch)) continue;
      const r = findActiveHighlightRange(compiled.highlightRanges[ch], frameIndex, ch);
      if (!r) continue;
      const els = collectElementsInRange(r.srcStart, r.srcEnd);
      for (const el of els) nextElements.add(el);
      if (ch === followCh && els.length > 0) followEl = els[0];
    }

    for (const el of mmlHighlightedElements) {
      if (!nextElements.has(el)) el.classList.remove('mml-playing');
    }
    for (const el of nextElements) el.classList.add('mml-playing');
    mmlHighlightedElements = nextElements;

    if (mmlAutoScrollEnableEl.checked && followEl) {
      const followSrc = Number(followEl.dataset.s);
      if (followSrc !== mmlHighlightLastFollowSrc) {
        mmlHighlightLastFollowSrc = followSrc;
        scrollMmlEditorToElement(followEl);
      }
    }
  }

  // MMLコンパイル結果が変わるたびに追随チャンネル候補を更新する
  function populateFollowChannelSelect(channelLetters) {
    const prev = mmlFollowChannelEl.value;
    mmlFollowChannelEl.innerHTML = '<option value="">なし</option>';
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
      let frameIndex = Math.floor(pos / frameDuration);
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

  let lastAssembly = null;

  function assemble() {
    const result = MML.Asm.assemble(sourceEl.value, { origin: 0x8000 });
    lastAssembly = result;

    let out = '';
    if (result.errors.length > 0) {
      out += result.errors.map(e => `[Line ${e.lineNo}] ${e.message}`).join('\n');
      out += '\n\n';
    } else {
      out += 'アセンブル成功\n\n';
    }

    out += `Origin: ${toHex(result.origin, 4)}  End: ${toHex(result.end, 4)}  Size: ${result.bytes.length} bytes\n\n`;

    out += '--- シンボルテーブル ---\n';
    const symNames = Object.keys(result.symbols).filter(k => !k.startsWith('__'));
    if (symNames.length === 0) {
      out += '(なし)\n';
    } else {
      for (const name of symNames) {
        out += `${name.padEnd(16)} = ${toHex(result.symbols[name], 4)}\n`;
      }
    }

    out += '\n--- バイナリダンプ ---\n';
    out += hexDump(result.bytes, result.origin);

    asmOutputEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = result.errors.length > 0 ? 'error' : '';
    pre.textContent = out;
    asmOutputEl.appendChild(pre);

    return result;
  }

  function buildNSF() {
    const result = lastAssembly || assemble();
    if (result.errors.length > 0) {
      nsfOutputEl.innerHTML = '<div class="error">アセンブルエラーがあるためNSFを生成できません。先にアセンブルしてください。</div>';
      return null;
    }

    const headerOpt = {
      songName: document.getElementById('songName').value,
      artist: document.getElementById('artist').value,
      copyright: document.getElementById('copyright').value,
      totalSongs: parseInt(document.getElementById('totalSongs').value, 10) || 1,
      startingSong: parseInt(document.getElementById('startingSong').value, 10) || 1,
      extraChips: getExtraChipsFlag()
    };

    const nsfBytes = MML.NSF.buildFromAssembly(headerOpt, result, { init: 'INIT', play: 'PLAY' });
    const parsed = MML.NSF.parseHeader(nsfBytes);

    let out = `NSFサイズ: ${nsfBytes.length} bytes (header 128 + program ${result.bytes.length})\n\n`;
    out += '--- ヘッダ内容 ---\n';
    out += `Magic OK       : ${parsed.magicOk}\n`;
    out += `Version        : ${parsed.version}\n`;
    out += `Total Songs    : ${parsed.totalSongs}\n`;
    out += `Starting Song  : ${parsed.startingSong}\n`;
    out += `Load Address   : ${toHex(parsed.loadAddr, 4)}\n`;
    out += `Init Address   : ${toHex(parsed.initAddr, 4)}\n`;
    out += `Play Address   : ${toHex(parsed.playAddr, 4)}\n`;
    out += `Song Name      : ${parsed.songName}\n`;
    out += `Artist         : ${parsed.artist}\n`;
    out += `Copyright      : ${parsed.copyright}\n`;
    out += `NTSC Speed     : ${parsed.ntscSpeed}\n`;
    out += `PAL Speed      : ${parsed.palSpeed}\n`;
    out += `Extra Chips    : ${toHex(parsed.extraChips, 2)}\n\n`;

    out += '--- ヘッダ先頭128バイト ダンプ ---\n';
    out += hexDump(nsfBytes.slice(0, 128), 0);

    nsfOutputEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = out;
    nsfOutputEl.appendChild(pre);

    return nsfBytes;
  }

  // --- Phase 2: エミュレータ試聴 ---
  let audioCtx = null;
  let currentSource = null;
  const PREVIEW_SECONDS = 3;

  function playPreview() {
    const bytes = buildNSF();
    if (!bytes) return;

    stopPreview();

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const player = new MML.Emu.NsfPlayer(bytes);
    const startingSong = parseInt(document.getElementById('startingSong').value, 10) || 1;
    player.initSong(startingSong - 1);

    const sampleRate = audioCtx.sampleRate;
    const totalSamples = Math.round(sampleRate * PREVIEW_SECONDS);
    const raw = new Float32Array(totalSamples);
    let pos = 0;
    while (pos < totalSamples) {
      const frame = player.renderFrame(sampleRate);
      for (let i = 0; i < frame.length && pos < totalSamples; i++, pos++) {
        raw[pos] = frame[i];
      }
    }

    const blocked = MML.Emu.dcBlock(raw);
    const buffer = audioCtx.createBuffer(1, totalSamples, sampleRate);
    const data = buffer.getChannelData(0);
    const gain = 3.0; // DCブロック後は振幅が小さいため増幅
    for (let i = 0; i < totalSamples; i++) {
      data[i] = Math.max(-1, Math.min(1, blocked[i] * gain));
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start();
    currentSource = source;
  }

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
  const seekTicksEl = document.getElementById('seekTicks');
  const SEEK_RESOLUTION = 1000;

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
  // 終了点に到達したら1回だけ自動一時停止する。停止位置より手前へシークし直すまで再武装しない
  // （そうしないと、終了点で止まった直後に▶を押した瞬間また即座に止まってしまう）
  let rangeEndArmed = true;

  // --- ストリーミング再生（ScriptProcessorNode） ---
  let activePlayer    = null;  // MmlStreamPlayer or NsfStreamPlayer
  let workletDuration = 0;    // 総再生時間（秒）
  let lastMmlCompiled = null;  // モニタ用にコンパイル結果を保持

  function formatTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function getTransportPosition() {
    if (activePlayer) {
      return Math.max(0, Math.min(workletDuration, activePlayer.getPosition()));
    }
    if (!capturedBuffer) return 0;
    const pos = transportPlaying
      ? transportOffset + (audioCtx.currentTime - transportStartTime)
      : transportOffset;
    return Math.max(0, Math.min(capturedBuffer.duration, pos));
  }

  function updateTransportUI() {
    const duration = activePlayer ? workletDuration : (capturedBuffer ? capturedBuffer.duration : 0);
    const playing = activePlayer ? activePlayer.isPlaying : transportPlaying;
    document.getElementById('btnTransportPlayPause').textContent = playing ? '⏸ 一時停止' : '▶ 再生';
    updateRangeMarkersUI(duration);
    updateSeekTicksUI(duration);
    if (!duration) return;
    const pos = getTransportPosition();
    seekBarEl.value = String(Math.round((pos / duration) * SEEK_RESOLUTION));
    timeDisplayEl.textContent = `${formatTime(pos)} / ${formatTime(duration)}`;
    if (playing) {
      if (pos >= duration) {
        transportStop();
      } else if (rangeEndSec !== null && pos >= rangeEndSec) {
        if (rangeEndArmed) {
          rangeEndArmed = false;
          transportPause();
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

  // 現在シーク可能かどうか（NSFストリーミング再生はシーク非対応、transportSeekと同じ判定）
  function canSeek() {
    if (activePlayer) return lastPlayMode === 'capture-mml';
    return !!capturedBuffer;
  }

  function currentDuration() {
    return activePlayer ? workletDuration : (capturedBuffer ? capturedBuffer.duration : 0);
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

  // 開始点/終了点ハンドルのドラッグ操作。ドラッグ中は左右反転しないよう互いにクランプする
  function setupRangeHandleDrag(handleEl, which) {
    const MIN_GAP = 0.05; // 秒。開始点と終了点が完全に重ならないための最小間隔
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
        const frac = Math.max(0, Math.min(1, (ev.clientX - wrapRect.left) / wrapRect.width));
        const sec = frac * duration;
        if (which === 'start') {
          rangeStartSec = Math.max(0, Math.min(sec, rangeEndSec - MIN_GAP));
        } else {
          rangeEndSec = Math.min(duration, Math.max(sec, rangeStartSec + MIN_GAP));
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

  function transportPlay() {
    mmlHighlightSuppressed = false;
    // 現在位置が再生範囲の開始点より手前なら、再生前に開始点までジャンプする
    if (canSeek() && rangeStartSec > 0 && getTransportPosition() < rangeStartSec - 0.001) {
      transportSeek(rangeStartSec);
    }
    if (activePlayer) {
      if (activePlayer.isPlaying) return;
      if (audioCtx) audioCtx.resume();
      activePlayer.play();
      updateNsfPlayButton();
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
    if (activePlayer) {
      if (!activePlayer.isPlaying) return;
      activePlayer.pause();
      if (transportRaf) cancelAnimationFrame(transportRaf);
      updateNsfPlayButton();
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
    // 停止後は曲頭(0)ではなく再生範囲の開始点に戻る（開始点未設定時は従来通り0）
    const restoreTo = rangeStartSec || 0;
    if (activePlayer) {
      activePlayer.stop();
      if (restoreTo > 0 && lastPlayMode === 'capture-mml') {
        activePlayer.seek(Math.round(restoreTo * audioCtx.sampleRate));
      }
      if (transportRaf) cancelAnimationFrame(transportRaf);
      updateNsfPlayButton();
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
    if (activePlayer) {
      if (lastPlayMode !== 'capture-mml') return; // NSFはシーク非対応
      const wasPlaying = activePlayer.isPlaying;
      activePlayer.pause();
      activePlayer.seek(Math.round(Math.max(0, Math.min(workletDuration, seconds)) * audioCtx.sampleRate));
      if (wasPlaying) {
        activePlayer.play();
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

  function applyCaptureResult(result, sampleRate, extraInfo, chips) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    transportStop();
    capturedBuffer = null;

    const buffer = audioCtx.createBuffer(1, result.audio.length, sampleRate);
    const data = buffer.getChannelData(0);
    const gain = 3.0;
    for (let i = 0; i < result.audio.length; i++) {
      data[i] = Math.max(-1, Math.min(1, result.audio[i] * gain));
    }
    capturedBuffer = buffer;
    transportOffset = 0;

    setMonitorSource(result, getTransportPosition, chips || []);

    let totalWrites = 0;
    for (const writes of result.writeLog) totalWrites += writes.length;

    let out = extraInfo || '';
    out += `フレーム数        : ${result.totalFrames}\n`;
    out += `1フレームのサンプル数: ${result.samplesPerFrame.toFixed(2)}\n`;
    out += `総サンプル数      : ${result.audio.length}\n`;
    out += `サンプルレート    : ${sampleRate} Hz\n`;
    out += `総再生時間        : ${formatTime(buffer.duration)}\n`;
    out += `レジスタ書き込み総数: ${totalWrites}\n`;

    captureOutputEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = out;
    captureOutputEl.appendChild(pre);

    preservePlaybackRange(buffer.duration);
    updateTransportUI();
    seekBarEl.value = '0';
    timeDisplayEl.textContent = `00:00 / ${formatTime(buffer.duration)}`;
  }

  async function runCapture() {
    const bytes = buildNSF();
    if (!bytes) return;

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const duration = parseInt(document.getElementById('captureDuration').value, 10) || 10;
    const startingSong = parseInt(document.getElementById('startingSong').value, 10) || 1;
    const sampleRate = audioCtx.sampleRate;

    const btnCapture = document.getElementById('btnCapture');
    btnCapture.disabled = true;
    captureOutputEl.innerHTML = '<div>レンダリング中… 0%</div>';

    const t0 = performance.now();
    const result = await MML.Emu.captureSongAsync(bytes, {
      songIndex: startingSong - 1,
      durationSeconds: duration,
      sampleRate,
      mute: getChannelMuteConfig()
    }, (done, total) => {
      captureOutputEl.innerHTML = `<div>レンダリング中… ${Math.round(done / total * 100)}%</div>`;
    });
    const elapsedMs = performance.now() - t0;

    btnCapture.disabled = false;
    lastPlayMode = 'capture-nsf';
    applyCaptureResult(result, sampleRate, `キャプチャ完了 (処理時間: ${elapsedMs.toFixed(1)} ms)\n\n`,
      getExpansionChips());
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
        statusEl.textContent = '読込中…';
        const arrayBuffer = await file.arrayBuffer();
        dpcmSampleCache[filename] = new Uint8Array(arrayBuffer);
        statusEl.textContent = `読み込み済み(${dpcmSampleCache[filename].length}バイト、.dmc生データ)。` +
          '再コンパイル/再生してください';
        statusEl.className = 'ok';
        return;
      }
      statusEl.textContent = '変換中…';
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
      statusEl.textContent = `読み込み済み(${result.bytes.length}バイト、レート${freq}=${result.rateHz.toFixed(0)}Hz)。` +
        '再コンパイル/再生してください';
      statusEl.className = 'ok';
    } catch (e) {
      statusEl.textContent = `変換失敗: ${e.message}`;
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
    title.textContent = 'MML内で参照されている@DPCMサンプル:';
    dpcmSampleListEl.appendChild(title);
    for (const filename of names) {
      const freq = files[filename];
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:2px;';

      const label = document.createElement('span');
      label.textContent = `"${filename}" (レート${freq}):`;
      row.appendChild(label);

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*,.dmc';
      row.appendChild(input);

      const status = document.createElement('span');
      status.className = dpcmSampleCache[filename] ? 'ok' : '';
      status.textContent = dpcmSampleCache[filename]
        ? `読み込み済み(${dpcmSampleCache[filename].length}バイト)`
        : '未読み込み(この曲は無音になります)';
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
      expansions: getExpansionChips(),
      fdsWave: MML.WaveformEditor.getFdsWave(),
      n163Wave: MML.WaveformEditor.getN163Wave(),
      mute: getChannelMuteConfig(),
      dpcmSamples: dpcmSampleCache
    };
  }

  function compileMml() {
    const result = MML.Mml.compile(mmlSourceEl.value, getMmlOpt());

    let out = '';
    if (result.errors.length > 0) {
      out += result.errors.map(e => e.lineNo ? `[Line ${e.lineNo}] ${e.message}` : e.message).join('\n');
      out += '\n\n';
    } else {
      out += 'コンパイル成功\n\n';
    }

    out += `テンポ      : ${result.tempo}\n`;
    const shownExpansions = displayExpansions(result.expansions);
    out += `拡張音源    : ${shownExpansions.length > 0 ? shownExpansions.join(', ') : 'なし'}\n`;
    out += `総フレーム数: ${result.totalFrames}\n`;
    out += `総再生時間  : ${formatTime(result.totalFrames / result.frameRate)}\n\n`;

    for (const ch of result.channelLetters) {
      const writes = result.tracks[ch].reduce((a, w) => a + w.length, 0);
      out += `チャンネル${ch}: レジスタ書き込み ${writes} 件\n`;
    }

    mmlOutputEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = result.errors.length > 0 ? 'error' : 'ok';
    pre.textContent = out;
    mmlOutputEl.appendChild(pre);

    return result;
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
      msg.textContent = 'MMLコンパイルエラーのため書き出せません:\n' +
        result.errors.map(e => e.lineNo ? `[Line ${e.lineNo}] ${e.message}` : e.message).join('\n');
      mmlOutputEl.appendChild(msg);
      return;
    }

    const headerOpt = {
      songName: document.getElementById('songName').value,
      artist: document.getElementById('artist').value,
      copyright: document.getElementById('copyright').value,
      totalSongs: 1,
      startingSong: 1
    };
    const built = MML.Driver.buildBankedNsfBytes(result, headerOpt);
    if (built.asmErrors.length > 0) {
      msg.className = 'error';
      msg.textContent = 'ドライバのアセンブルに失敗しました(内部エラー):\n' +
        built.asmErrors.map(e => `[Line ${e.lineNo}] ${e.message}`).join('\n');
      mmlOutputEl.appendChild(msg);
      return;
    }
    const nsfBytes = built.nsfBytes;
    MML.NSF.download(nsfBytes, (headerOpt.songName || 'output') + '.nsf');

    let out = `NSF書き出し完了: ${nsfBytes.length}バイト(${built.bankCount}バンク、` +
      `うち曲データ ${Math.max(0, built.bankCount - 8)}バンク)\n`;
    if (built.unsupportedExpansions.length > 0) {
      out += `注意: 拡張音源(${built.unsupportedExpansions.join(', ')})は現状のNSF書き出しでは` +
        '未対応のため、該当チャンネルは無音になります(VRC6/MMC5/FME7は対応済み)。\n';
    }
    msg.className = 'ok';
    msg.textContent = out;
    mmlOutputEl.appendChild(msg);
  }

  function runMmlStream() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const btnMmlCapture = document.getElementById('btnMmlCapture');
    btnMmlCapture.disabled = true;
    captureOutputEl.innerHTML = '<div>コンパイル中…</div>';

    const compiled = MML.Mml.compile(mmlSourceEl.value, getMmlOpt());
    if (compiled.errors.length > 0) {
      captureOutputEl.innerHTML =
        `<div class="error">${compiled.errors.map(e => e.lineNo ? `[Line ${e.lineNo}] ${e.message}` : e.message).join('\n')}</div>`;
      btnMmlCapture.disabled = false;
      return;
    }

    // 既存の再生を停止
    transportStop();
    stopActivePlayer();
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
    player.onEnded = () => {
      if (transportRaf) cancelAnimationFrame(transportRaf);
      updateTransportUI();
    };

    activePlayer    = player;
    player.setSpeed(currentSpeedFactor);
    workletDuration = player.getDuration();

    const duration = workletDuration;
    const shownExpansions = displayExpansions(compiled.expansions);
    const expansionsLabel = shownExpansions.length > 0 ? shownExpansions.join(', ') : 'なし';
    let out = `再生準備完了 (テンポ ${compiled.tempo}, 拡張音源: ${expansionsLabel})\n\n`;
    out += `総フレーム数: ${compiled.totalFrames}\n`;
    out += `総再生時間  : ${formatTime(duration)}\n`;
    for (const ch of compiled.channelLetters) {
      const writes = compiled.tracks[ch].reduce((a, w) => a + w.length, 0);
      out += `チャンネル${ch}: ${writes} 件\n`;
    }
    captureOutputEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = out;
    captureOutputEl.appendChild(pre);

    preservePlaybackRange(duration);
    seekBarEl.value = '0';
    timeDisplayEl.textContent = `00:00 / ${formatTime(duration)}`;
    btnMmlCapture.disabled = false;

    transportPlay();
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
      dpcmOutputEl.innerHTML = '<div class="error">音声ファイルを選択してください。</div>';
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
    out += `元サンプルレート      : ${audioBuffer.sampleRate} Hz\n`;
    out += `元サンプル数          : ${samples.length}\n`;
    out += `DMCレート             : ${rateIndex} (${result.rateHz.toFixed(1)} Hz)\n`;
    out += `エンコード後サンプル数: ${result.sampleCount}\n`;
    out += `データサイズ          : ${result.bytes.length} bytes\n`;
    out += `再生時間              : ${formatTime(result.sampleCount / result.rateHz)}\n\n`;
    out += '--- バイナリダンプ (先頭256バイト) ---\n';
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

  // ミュート変更時の自動再レンダリング管理
  let lastPlayMode = null; // 'nsf' | 'capture-nsf' | 'capture-mml'
  let muteRerenderTimer = null;

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
    return names.length > 0 ? names.join(', ') : 'なし (2A03のみ)';
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
    out += `NTSC Speed     : ${header.ntscSpeed} (1/1,000,000秒)\n`;
    out += `PAL Speed      : ${header.palSpeed} (1/1,000,000秒)\n`;
    out += `PAL/NTSC Bit   : ${toHex(header.palNtscBit, 2)}\n`;
    out += `拡張音源       : ${describeChips(header.extraChips)} (${toHex(header.extraChips, 2)})\n`;

    nsfFileHeaderEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = header.magicOk ? 'ok' : 'error';
    pre.textContent = out;
    nsfFileHeaderEl.appendChild(pre);
  }

  async function loadNsfFile() {
    const file = nsfFileEl.files[0];
    if (!file) return;

    stopNsfFilePlayback();
    keyboardDisplay.reset();
    loadedNsfBytes = null;
    loadedNsfHeader = null;

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.length < 128) {
      nsfFileHeaderEl.innerHTML = '<div class="error">ファイルサイズが小さすぎます（NSFヘッダは128バイト必要です）。</div>';
      return;
    }

    const header = MML.NSF.parseHeader(bytes);
    if (!header.magicOk) {
      nsfFileHeaderEl.innerHTML = '<div class="error">NSFヘッダのマジックナンバーが不正です（NSFファイルではない可能性があります）。</div>';
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
    btn.textContent = isPlaying ? '⏸ 一時停止' : '▶ 再生';
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
        info.textContent = 'タップ1回目… 拍に合わせて続けてタップ';
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
      info.textContent = `${taps.length}回タップ → ${bpm} BPM`;
    });

    btnClear.addEventListener('click', () => {
      input.value = '';
      taps = [];
      info.textContent = '自動検出に戻しました';
    });
  }
  setupTempoControl('nsf');
  setupTempoControl('spc');
  setupTempoControl('kss');

  // 変換テンポ入力欄の値 (空/不正なら null = 自動検出)
  function getManualBpm(prefix) {
    const v = parseFloat(document.getElementById(`${prefix}TempoBpm`).value);
    return (isFinite(v) && v >= 40 && v <= 400) ? v : null;
  }

  // 最後にキャプチャした生の result (writeLog 込み) を保持
  let lastNsfCaptureResult = null;

  async function runNsf2Mml() {
    if (!loadedNsfBytes || !loadedNsfHeader) {
      nsfFileStatusEl.innerHTML = '<div class="error">先にNSFファイルを読み込んでください。</div>';
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
      nsfFileStatusEl.innerHTML = '<div>MML変換用レンダリング中…</div>';

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

    nsfFileStatusEl.innerHTML = '<div>MML変換中…</div>';
    // 少し待って UI を更新させる
    await new Promise(r => setTimeout(r, 10));

    const nsfManualBpm = getManualBpm('nsf');
    let converted;
    try {
      converted = MML.NSF2MML.convert(
        result.writeLog, loadedNsfBytes, loadedNsfHeader, songNo - 1, result.initRegs, result.initWrites,
        { bpm: nsfManualBpm, n163Snapshots: result.n163Snapshots });
    } catch (e) {
      nsfFileStatusEl.innerHTML = `<div class="error">変換エラー: ${e.message}</div>`;
      return;
    }

    // MML エディタに挿入
    mmlSourceEl.value = converted.mml;
    mmlSourceEl.dispatchEvent(new Event('input')); // シンタックスハイライト更新

    // 検出した拡張音源チェックボックスと抽出済み波形を反映
    // (これをやらないと拡張チャンネルのMMLは出力されてもコンパイル時に鳴らない)
    if (converted.expansions) setExpansionChips(converted.expansions);
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
      ? `、DPCM ${converted.dpcmFiles.length} ファイル出力` : '';
    const expMsg = converted.expansions && converted.expansions.length > 0
      ? `、拡張音源: ${converted.expansions.join(', ')}` : '';
    nsfFileStatusEl.innerHTML =
      `<div class="ok">MML変換完了 (${nsfManualBpm ? '指定' : '推定'} ${converted.bpm} BPM${expMsg}${dpcmMsg}) → MMLエディタに出力しました</div>`;
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

  async function exportNsfWav() {
    if (!loadedNsfBytes || !loadedNsfHeader) {
      nsfFileStatusEl.innerHTML = '<div class="error">先にNSFファイルを読み込んでください。</div>';
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
    nsfFileStatusEl.innerHTML = '<div>WAV書き出し用レンダリング中…</div>';
    const result = await MML.Emu.captureSongAsync(loadedNsfBytes, {
      songIndex: songNo - 1,
      durationSeconds: duration,
      sampleRate,
      mute: getChannelMuteConfig()
    }, (done, total) => {
      nsfFileStatusEl.innerHTML = `<div>WAV書き出し中… ${Math.round(done / total * 100)}%</div>`;
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
    nsfFileStatusEl.innerHTML =
      `<div class="ok">WAV + レジスタログ書き出し完了: ${filename}<br>音源: ${activeChips.join(', ')}</div>`;
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
      nsfFileStatusEl.innerHTML = '<div class="error">先にNSFファイルを読み込んでください。</div>';
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

    // 既存の再生を停止
    stopActivePlayer();
    capturedBuffer       = null;
    lastNsfCaptureResult = null;
    lastPlayMode         = 'nsf';

    const player = new MML.Audio.NsfStreamPlayer(audioCtx);
    player.load(loadedNsfBytes, songNo - 1, totalFrames, getChannelMuteConfig());
    player.onEnded = () => {
      if (transportRaf) cancelAnimationFrame(transportRaf);
      updateNsfPlayButton();
      updateTransportUI();
    };

    activePlayer    = player;
    player.setSpeed(currentSpeedFactor);
    workletDuration = duration;

    nsfFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = `曲 ${songNo} / ${totalSongs}  再生時間: ${formatTime(duration)}`;
    nsfFileStatusEl.appendChild(pre);

    resetPlaybackRangeToFull(duration);
    seekBarEl.value = '0';
    timeDisplayEl.textContent = `00:00 / ${formatTime(duration)}`;

    transportPlay();

    // 鍵盤表示: bus.onWrite でリアルタイム追跡（バックグラウンドキャプチャ不要）
    const captureChips = chipsFromExtraFlags(loadedNsfHeader.extraChips || 0);
    resetN163Max();
    const liveSnap = {};
    // INIT時の書き込み(FDS/N163の波形メモリ等、再生中は書き直されない)を初期値として取り込む
    Object.assign(liveSnap, player.initRegs || {});
    liveSnap[0x4015] = 0x0F; // initSong は bus.write を経由しないため手動補完
    player.player.bus.onWrite = (addr, value) => { liveSnap[addr] = value; };
    setMonitorSource({
      regSnapshots: [liveSnap], // totalFrames=1 にして常に liveSnap[0] を参照
      totalFrames: 1,
      samplesPerFrame: audioCtx.sampleRate / MML.Emu.FRAME_RATE_NTSC,
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

    // ピアノロール先読み用キャプチャ(実際の音声再生とは別に裏で走らせる、非同期・非ブロッキング。
    // regsOnly:true で音声バッファ生成をスキップし高速化する)。onProgressで途中経過(その時点
    // までのregSnapshots/writeLog)を渡してもらい、キャプチャ完了を待たずに段階的にロールを埋める。
    // ★SPC/KSSと同じ理由でロール再構築(setRollTimelineFromRegSnapshots内のO(全フレーム)走査)
    // は間引く(onProgress自体は音切れ防止のため高頻度のまま)。
    const ROLL_REBUILD_INTERVAL_FRAMES = 120;
    const myNsfRollToken = ++nsfRollToken;
    const nsfSamplesPerFrame = audioCtx.sampleRate / MML.Emu.FRAME_RATE_NTSC;
    let lastNsfRollBuiltFrame = 0;
    MML.Emu.captureSongAsync(loadedNsfBytes, {
      songIndex: songNo - 1, durationSeconds: duration, sampleRate: audioCtx.sampleRate,
      mute: getChannelMuteConfig(), regsOnly: true,
      shouldCancel: () => myNsfRollToken !== nsfRollToken
    }, (done, total, regSnapshots, writeLog, n163Snapshots) => {
      if (myNsfRollToken !== nsfRollToken) return; // 曲切替/停止で無効化済み
      if (done - lastNsfRollBuiltFrame < ROLL_REBUILD_INTERVAL_FRAMES && done < total) return;
      lastNsfRollBuiltFrame = done;
      keyboardDisplay.setRollTimelineFromRegSnapshots(
        regSnapshots, writeLog, done, nsfSamplesPerFrame, audioCtx.sampleRate, captureChips, n163Snapshots
      );
    }).catch(() => { /* 先読み失敗時はピアノロールなしで続行 */ });
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
  document.getElementById('btnDpcmDownload').addEventListener('click', downloadDpcm);

  document.getElementById('btnAssemble').addEventListener('click', assemble);
  document.getElementById('btnBuildNsf').addEventListener('click', buildNSF);
  document.getElementById('btnDownloadNsf').addEventListener('click', () => {
    const bytes = buildNSF();
    if (bytes) MML.NSF.download(bytes, 'output.nsf');
  });
  document.getElementById('btnPlay').addEventListener('click', playPreview);
  document.getElementById('btnStop').addEventListener('click', stopPreview);

  document.getElementById('btnCapture').addEventListener('click', runCapture);
  document.getElementById('btnMmlCompile').addEventListener('click', compileMml);
  document.getElementById('btnMmlExportNsf').addEventListener('click', exportMmlNsf);
  document.getElementById('btnMmlCapture').addEventListener('click', runMmlStream);
  document.getElementById('btnTransportPlayPause').addEventListener('click', () => {
    const playing = activePlayer ? activePlayer.isPlaying : transportPlaying;
    if (playing) transportPause();
    else transportPlay();
  });
  document.getElementById('btnTransportStop').addEventListener('click', transportStop);
  document.getElementById('btnRewind').addEventListener('click', () => transportSeek(getTransportPosition() - 5));
  document.getElementById('btnForward').addEventListener('click', () => transportSeek(getTransportPosition() + 5));
  document.getElementById('btnRangeReset').addEventListener('click', () => resetPlaybackRangeToFull(currentDuration()));
  window.__rangeDebug = {
    setRange: (s, e) => { rangeStartSec = s; rangeEndSec = e; updateRangeMarkersUI(); updateMmlRangeHighlight(); },
    rangeSelectedTexts: () => Array.from(document.querySelectorAll('.mml-range-selected')).map(el => el.textContent),
    overlayHtml: () => document.getElementById('mmlHighlight').innerHTML
  };
  seekBarEl.addEventListener('input', () => {
    if (activePlayer) {
      // MML はシーク可能、NSF はシーク非対応
      if (lastPlayMode === 'capture-mml') {
        const frac = parseInt(seekBarEl.value, 10) / SEEK_RESOLUTION;
        transportSeek(frac * workletDuration);
      }
      return;
    }
    if (!capturedBuffer) return;
    const frac = parseInt(seekBarEl.value, 10) / SEEK_RESOLUTION;
    transportSeek(frac * capturedBuffer.duration);
  });

  // 初回アセンブル
  assemble();

  // ── SPC ファイル読み込み・再生 ────────────────────────────────────
  const spcFileEl       = document.getElementById('spcFile');
  const spcFileHeaderEl = document.getElementById('spcFileHeader');
  const spcPlayDurEl    = document.getElementById('spcPlayDuration');
  const spcFileStatusEl = document.getElementById('spcFileStatus');

  let loadedSpcBytes  = null;
  let loadedSpcHeader = null;
  let spcIsRendering  = false;
  let spcActivePlayer = null; // SpcStreamPlayer

  function renderSpcHeader(h) {
    let out = '';
    out += `Magic OK    : ${h.magicOk}\n`;
    out += `PC          : ${toHex(h.pc, 4)}\n`;
    out += `A=${toHex(h.a,2)}  X=${toHex(h.x,2)}  Y=${toHex(h.y,2)}  PSW=${toHex(h.psw,2)}  SP=${toHex(h.sp,2)}\n`;
    out += `ID666       : ${h.hasId666 ? 'あり' : 'なし'}\n`;
    if (h.id666) {
      const id = h.id666;
      if (id.songTitle)  out += `曲名        : ${id.songTitle}\n`;
      if (id.gameTitle)  out += `ゲーム      : ${id.gameTitle}\n`;
      if (id.artistName) out += `アーティスト: ${id.artistName}\n`;
      if (id.dumperName) out += `ダンパー    : ${id.dumperName}\n`;
      if (id.comments)   out += `コメント    : ${id.comments}\n`;
      if (id.dumpDate)   out += `ダンプ日    : ${id.dumpDate}\n`;
      if (id.playSeconds) out += `推奨再生時間: ${id.playSeconds} 秒\n`;
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
    stopSpcPlayback();
    keyboardDisplay.reset();
    loadedSpcBytes = null; loadedSpcHeader = null;

    const buf   = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    try {
      const h = MML.SPC.parseHeader(bytes);
      if (!h.magicOk) {
        spcFileHeaderEl.innerHTML = '<div class="error">SPC ヘッダが不正です。</div>';
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
      spcFileHeaderEl.innerHTML = `<div class="error">読み込みエラー: ${e.message}</div>`;
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
    btn.textContent = playing ? '⏸ 一時停止' : '▶ 再生';
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
        .map(e => ({
          startSec: e.frame * frameDur, endSec: (e.frame + e.len) * frameDur, midi: e.pitchSemi + 12,
          vol: (e.adsr1 & 0x80) ? (((e.adsr2 >> 5) & 7) / 7) : 1,
        })),
    }));
  }

  function playSpcStream() {
    if (!loadedSpcBytes) {
      spcFileStatusEl.innerHTML = '<div class="error">先にSPCファイルを読み込んでください。</div>';
      return;
    }
    // 再生中なら一時停止 / 停止中なら再開
    if (spcActivePlayer) {
      if (spcActivePlayer.isPlaying) {
        spcActivePlayer.pause();
      } else {
        spcActivePlayer.play();
      }
      updateSpcPlayButton();
      return;
    }

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const duration    = parseInt(spcPlayDurEl.value, 10) || 180;
    const totalFrames = Math.ceil(duration * 60); // 60fps 換算

    // ピアノロール先読み用キャプチャ(実際の音声再生とは別に裏で走らせる、非同期・非ブロッキング)。
    // onProgressで途中経過(その時点までのlog)を渡してもらい、キャプチャ完了(最大でduration秒
    // 分)を待たずに段階的にロールを埋めていく。
    //
    // ★captureAsyncのonProgressは(音切れ防止のため)10フレームごとという高頻度で呼ばれるが、
    // ここで毎回 extractVoiceEvents(=O(その時点までの全フレーム)の総ざらい) を回すと、
    // 曲が長く書き込みが多いほど回数を重ねるごとに重くなるO(n^2)的な負荷になり、
    // 実際に書き込みの多い曲(R-Type III「Outer Space」等)ではキャプチャ全体が実時間の
    // 何倍もかかってしまい、ロールが実再生に追いつけず「序盤ロールが出ない/直近の音が
    // 欠ける」原因になっていた。ロールの再構築自体は間引いて(約1秒=60フレームごと)呼ぶ
    // ことで、captureAsync自体の頻繁なyield(音切れ防止)はそのまま維持しつつ負荷を大きく下げる。
    const ROLL_REBUILD_INTERVAL_FRAMES = 120;
    keyboardDisplay.setRollTimeline(null);
    const myRollToken = ++spcRollToken;
    let lastRollBuiltFrame = 0;
    // 原音チューニング補正マップを一度だけ算出(BRRサンプルは曲頭から不変なので、ごく短い
    // キャプチャで全サンプルを収集できる)。ロール再構築ごとに再計算しないよう使い回す。
    let spcFineTune = null;
    try {
      spcFineTune = MML.SPC2MML.computeSrcnFineTune(MML.SPC2MML.capture(loadedSpcBytes, 0.05).brrSamples);
    } catch (_) { /* 失敗時は補正なし(従来動作)で続行 */ }
    // ライブ鍵盤(updateVoiceMonitor)も同じ補正で表示するため共有する
    spcActiveFineTune = spcFineTune;
    MML.SPC2MML.captureAsync(loadedSpcBytes, duration, (frame, frames, log) => {
      if (myRollToken !== spcRollToken) return; // 曲切替/停止で無効化済み
      if (frame - lastRollBuiltFrame < ROLL_REBUILD_INTERVAL_FRAMES && frame < frames) return;
      lastRollBuiltFrame = frame;
      keyboardDisplay.setRollTimeline(buildSpcRollTimeline(log.slice(0, frame), MML.SPC2MML.FRAME_RATE, spcFineTune));
    }, () => myRollToken !== spcRollToken).catch(() => { /* 先読み失敗時はピアノロールなしで続行 */ });

    const player = new MML.Audio.SpcStreamPlayer(audioCtx);
    player.load(loadedSpcBytes, totalFrames, {});
    player.onEnded = () => { updateSpcPlayButton(); };
    spcActivePlayer = player;
    player.setSpeed(currentSpeedFactor);

    const id = loadedSpcHeader.id666;
    const title = (id && id.songTitle) ? id.songTitle : '(無題)';
    spcFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = `再生中: ${title}  (最大 ${formatTime(duration)})`;
    spcFileStatusEl.appendChild(pre);

    // ミュート状態を復元
    if (player.player) player.player.dsp.mutedVoices = spcMutedVoices;
    player.play();
    updateSpcPlayButton();
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
      spcFileStatusEl.innerHTML = '<div class="error">先にSPCファイルを読み込んでください。</div>';
      return;
    }
    if (spcIsRendering) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const duration   = parseInt(spcPlayDurEl.value, 10) || 180;
    const sampleRate = audioCtx.sampleRate;
    const DSP_RATE   = 32000;

    spcIsRendering = true;
    updateSpcPlayButton();
    spcFileStatusEl.innerHTML = '<div>WAV書き出し中… 0%</div>';
    await new Promise(r => setTimeout(r, 0));

    let   player       = new MML.Emu.SpcPlayer(loadedSpcBytes);
    player.dsp.mutedVoices = spcMutedVoices;  // ミュート状態を WAV 書き出しに反映
    const totalDspSmp  = duration * DSP_RATE;
    const totalOutSmp  = Math.round(duration * sampleRate);
    const audio        = new Float32Array(totalOutSmp);

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
        audio[outPos++] = (lastL + lastR) * 0.5;
      }

      // 進捗更新
      const pct = Math.round(dspDone / totalDspSmp * 100);
      spcFileStatusEl.innerHTML = `<div>WAV書き出し中… ${pct}%</div>`;
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
    const wavBlob = buildWavBlob(audio, sampleRate, 2.0);
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
      `<div class="ok">書き出し完了: ${name}.wav + ${name}_dsp_log.csv<br>` +
      `DSP書き込み ${totalWrites} 件 / KON ${konCount} 件 (先頭${LOG_SEC}秒)</div>`;
  }

  async function runSpc2Mml() {
    if (!loadedSpcBytes) {
      spcFileStatusEl.innerHTML = '<div class="error">先にSPCファイルを読み込んでください。</div>';
      return;
    }
    if (spcIsRendering) return;

    const duration = parseInt(spcPlayDurEl.value, 10) || 60;
    spcIsRendering = true;
    updateSpcPlayButton();
    spcFileStatusEl.innerHTML = '<div>MML変換用キャプチャ中… (数秒かかります)</div>';

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
      spcFileStatusEl.innerHTML = `<div class="error">変換エラー: ${e.message}</div>`;
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
      ? `、DPCM ${result.dmcFiles.length} ファイル出力` : '';
    const expMsg = result.expansion && result.expansion !== 'none'
      ? `、拡張音源: ${result.expansion}` : '';
    spcFileStatusEl.innerHTML =
      `<div class="ok">MML変換完了 (${spcManualBpm ? '指定' : '推定'} ${result.bpm} BPM${expMsg}${dmcMsg}) → MMLエディタに出力</div>`;
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
    { value: 'skip',       label: 'スキップ' },
    { value: 'pulse1',     label: 'A: Pulse 1' },
    { value: 'pulse2',     label: 'B: Pulse 2' },
    { value: 'triangle',   label: 'C: Triangle' },
    { value: 'noise',      label: 'D: Noise' },
    { value: 'dpcm',       label: 'DPCM変換' },
    { value: 'fds',        label: 'E: FDS 波形' },
    { value: 'vrc6pulse1', label: 'E: VRC6 Pulse1' },
    { value: 'vrc6pulse2', label: 'F: VRC6 Pulse2' },
    { value: 'vrc6saw',    label: 'G: VRC6 のこぎり' },
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
        if (spcActivePlayer && spcActivePlayer.player) {
          spcActivePlayer.player.dsp.mutedVoices = spcMutedVoices;
        }
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
        { data: raw, mode: 'steps', color: '#8a8a98', label: '素(BRR)' },
        { data: smooth, mode: 'line', color: '#6ea8ff', label: 'ガウス補間' },
      ].concat(smoothPM ? [{ data: smoothPM, mode: 'line', dash: [4, 3], color: '#ff8844', label: 'PM変調後' }] : []),
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
    if (spcActivePlayer && spcActivePlayer.player) {
      spcActivePlayer.player.dsp.mutedVoices = spcMutedVoices;
    }
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

  // KSSで使う鍵盤表示チャンネル種別 (ヘッダのFMPAC有無で可変)
  function kssMonitorChips(header) {
    const chips = ['kss', 'kssPsg', 'kssScc'];
    if (header && header.device.mode === 'MSX' && header.device.fmpac) chips.push('kssOpll');
    return chips;
  }

  function renderKssHeader(h) {
    let out = '';
    out += `Magic       : ${h.magic} (${h.magicOk ? 'OK' : '不正'})\n`;
    out += `Load/Init/Play: ${toHex(h.loadAddr,4)} / ${toHex(h.initAddr,4)} / ${toHex(h.playAddr,4)}\n`;
    out += `データ長    : ${h.dataLength} バイト\n`;
    out += `バンク方式  : ${h.bankMode}マッパー (追加バンク数 ${h.bankNum})\n`;
    out += `モード      : ${h.device.mode}${h.device.palMode ? ' / PAL' : ' / NTSC'}\n`;
    out += `音源        : ${MML.KSS.describeChips(h).join(', ')}\n`;
    if (h.hasSongRange) out += `曲番号範囲  : ${h.firstSong} 〜 ${h.lastSong}\n`;
    kssFileHeaderEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = h.magicOk ? 'ok' : 'error';
    pre.textContent = out;
    kssFileHeaderEl.appendChild(pre);
  }

  async function loadKssFile() {
    const file = kssFileEl.files[0];
    if (!file) return;
    stopKssPlayback();
    keyboardDisplay.reset();
    loadedKssBytes = null; loadedKssHeader = null;

    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    try {
      const h = MML.KSS.parseHeader(bytes);
      if (!h.magicOk) {
        kssFileHeaderEl.innerHTML = '<div class="error">KSSヘッダが不正です。</div>';
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
      kssFileHeaderEl.innerHTML = `<div class="error">読み込みエラー: ${e.message}</div>`;
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
  function buildKssRollTimeline(writeLog, totalFrames, frameRate, header) {
    const frameDur = 1 / frameRate;
    const clock = MML.KSS.Z80_CLOCK;
    // volume は ay/scc/opll いずれも0-15(4bit)なので/15で0-1に正規化する。
    // note: Kss2MmlExpansion(ay/scc/opll)のfreqToNoteNumberはMML変換側で使う共通の
    // ノート番号体系(57+12*log2(freq/440)、nsf2mml/expansion/fme7.js等でも同じ)を採用しており、
    // 標準MIDI(69+12*log2(freq/440)、keyboard.jsのfreqToMidiと同じ)より1オクターブ(12)低い。
    // MML変換自体はこの体系で正しく動くため触らず、鍵盤描画に合わせるロール側でのみ+12補正する。
    const toNotes = (events) => events.filter(e => e.note !== null)
      .map(e => ({ startSec: e.start * frameDur, endSec: e.end * frameDur, midi: e.note + 12, vol: (e.volume || 0) / 15 }));
    const tracks = [];

    const ayResult = MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock);
    const KP_COLS = ['#66ddff', '#33aaff', '#0077dd'];
    ayResult.channels.forEach((ch, i) => tracks.push({ id: `KP${i + 1}`, color: KP_COLS[i], notes: toNotes(ch.events) }));

    const sccResult = MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock);
    sccResult.channels.forEach((ch, i) => tracks.push({ id: `KS${i + 1}`, color: `hsl(${(280 + i * 20) % 360},80%,60%)`, notes: toNotes(ch.events) }));

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
    btn.textContent = playing ? '⏸ 一時停止' : '▶ 再生';
    btn.disabled = kssIsRendering;
  }

  function playKssStream() {
    if (!loadedKssBytes) {
      kssFileStatusEl.innerHTML = '<div class="error">先にKSSファイルを読み込んでください。</div>';
      return;
    }
    if (kssActivePlayer) {
      if (kssActivePlayer.isPlaying) kssActivePlayer.pause();
      else kssActivePlayer.play();
      updateKssPlayButton();
      return;
    }

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const songNo = parseInt(kssSongIndexEl.value, 10) || 0;
    const duration = parseInt(kssPlayDurEl.value, 10) || 180;
    const totalFrames = Math.ceil(duration * (loadedKssHeader.device.palMode ? MML.KSS.PAL_FPS : MML.KSS.NTSC_FPS));

    const player = new MML.Audio.KssStreamPlayer(audioCtx);
    player.load(loadedKssBytes, songNo, totalFrames, getChannelMuteConfig());
    player.onEnded = () => { updateKssPlayButton(); };
    kssActivePlayer = player;
    player.setSpeed(currentSpeedFactor);

    // ピアノロール先読み用キャプチャ(実際の音声再生とは別に裏で走らせる、非同期・非ブロッキング)。
    // regsOnly:true で波形合成を省略し、実再生(ScriptProcessorNode)とメインスレッドを共有しても
    // 音切れを起こしにくくする。onProgressで途中経過(その時点までのwriteLog)を渡してもらい、
    // キャプチャ完了を待たずに段階的にロールを埋めていく。
    // ★SPCと同じ理由(onProgressの高頻度呼び出しのたびにKss2MmlExpansion.ay/scc/opllの
    // 全フレーム総ざらいを回すと、書き込みの多い曲でO(n^2)的に重くなりキャプチャが実再生に
    // 追いつけなくなる)でロール再構築は間引く。captureKssSongAsync自体のyield頻度は変えない。
    const ROLL_REBUILD_INTERVAL_FRAMES = 120;
    keyboardDisplay.setRollTimeline(null);
    const myKssRollToken = ++kssRollToken;
    const kssFrameRate = loadedKssHeader.device.palMode ? MML.KSS.PAL_FPS : MML.KSS.NTSC_FPS;
    let lastKssRollBuiltFrame = 0;
    MML.Emu.captureKssSongAsync(loadedKssBytes, {
      songIndex: songNo, durationSeconds: duration, sampleRate: audioCtx.sampleRate,
      mute: getChannelMuteConfig().expansion, regsOnly: true,
      shouldCancel: () => myKssRollToken !== kssRollToken
    }, (done, total, writeLog) => {
      if (myKssRollToken !== kssRollToken) return; // 曲切替/停止で無効化済み
      if (done - lastKssRollBuiltFrame < ROLL_REBUILD_INTERVAL_FRAMES && done < total) return;
      lastKssRollBuiltFrame = done;
      keyboardDisplay.setRollTimeline(buildKssRollTimeline(writeLog.slice(0, done), done, kssFrameRate, loadedKssHeader));
    }).catch(() => { /* 先読み失敗時はピアノロールなしで続行 */ });

    kssFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = `再生中: 曲${songNo}  (最大 ${formatTime(duration)})`;
    kssFileStatusEl.appendChild(pre);

    player.play();
    updateKssPlayButton();

    // 鍵盤表示: PSG/SCC/FMPACをライブチップから直接スナップショット
    setMonitorSource({
      regSnapshots: [{}],
      totalFrames: 1,
      samplesPerFrame: audioCtx.sampleRate / (loadedKssHeader.device.palMode ? MML.KSS.PAL_FPS : MML.KSS.NTSC_FPS),
      sampleRate: audioCtx.sampleRate,
      writeLog: [],
      cpuSnapshots: null,
      memSnapshots: null,
      getKssPsg: liveKssPsg,
      getKssScc: liveKssScc,
      getKssOpll: liveKssOpll
    }, () => kssActivePlayer ? kssActivePlayer.getPosition() : 0, kssMonitorChips(loadedKssHeader));
  }

  function changeKssSong(delta) {
    const min = parseInt(kssSongIndexEl.min, 10) || 0;
    const max = parseInt(kssSongIndexEl.max, 10) || 255;
    let v = (parseInt(kssSongIndexEl.value, 10) || 0) + delta;
    v = Math.max(min, Math.min(max, v));
    kssSongIndexEl.value = String(v);
    if (kssActivePlayer) { stopKssPlayback(); playKssStream(); }
  }

  async function exportKssWav() {
    if (!loadedKssBytes) {
      kssFileStatusEl.innerHTML = '<div class="error">先にKSSファイルを読み込んでください。</div>';
      return;
    }
    if (kssIsRendering) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const songNo = parseInt(kssSongIndexEl.value, 10) || 0;
    const duration = parseInt(kssPlayDurEl.value, 10) || 30;
    const sampleRate = audioCtx.sampleRate;
    kssIsRendering = true;
    updateKssPlayButton();
    kssFileStatusEl.innerHTML = '<div>WAV書き出し用レンダリング中…</div>';

    const result = await MML.Emu.captureKssSongAsync(loadedKssBytes, {
      songIndex: songNo, durationSeconds: duration, sampleRate, mute: getChannelMuteConfig().expansion
    }, (done, total) => {
      kssFileStatusEl.innerHTML = `<div>WAV書き出し中… ${Math.round(done / total * 100)}%</div>`;
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

    kssFileStatusEl.innerHTML = `<div class="ok">書き出し完了: ${filename} + regs.csv</div>`;
  }

  async function runKss2Mml() {
    if (!loadedKssBytes) {
      kssFileStatusEl.innerHTML = '<div class="error">先にKSSファイルを読み込んでください。</div>';
      return;
    }
    if (kssIsRendering) return;

    const songNo = parseInt(kssSongIndexEl.value, 10) || 0;
    const duration = parseInt(kssPlayDurEl.value, 10) || 60;
    kssIsRendering = true;
    updateKssPlayButton();
    kssFileStatusEl.innerHTML = '<div>MML変換用キャプチャ中… (数秒かかります)</div>';
    await new Promise(resolve => setTimeout(resolve, 10));

    const kssManualBpm = getManualBpm('kss');
    let result;
    try {
      result = await MML.KSS2MML.fromKss(loadedKssBytes, songNo, Math.min(duration, 60), { bpm: kssManualBpm });
    } catch (e) {
      kssIsRendering = false;
      updateKssPlayButton();
      kssFileStatusEl.innerHTML = `<div class="error">変換エラー: ${e.message}</div>`;
      return;
    }

    kssIsRendering = false;
    updateKssPlayButton();

    mmlSourceEl.value = result.mml;
    mmlSourceEl.dispatchEvent(new Event('input'));

    // 変換結果はNES拡張音源(FME-7/N163/VRC7)を借りて再生する設計のため、
    // コンパイル時に鳴るようチェックボックスと波形エディタへ反映する
    // (NSF2MMLと同じ理由。反映しないと出力されたチャンネルが無音になる)。
    if (result.expansions) setExpansionChips(result.expansions);
    if (result.n163Wave && MML.WaveformEditor.n163Wave) MML.WaveformEditor.n163Wave.setData(result.n163Wave);

    kssFileStatusEl.innerHTML =
      `<div class="ok">MML変換完了 (${kssManualBpm ? '指定' : '推定'} ${result.bpm} BPM、音源: ${result.chips.join(', ')}) → MMLエディタに出力(FME-7/N163/VRC7を借用して再生)</div>`;
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
})();
