/*
 * Phase 1 動作確認UI
 * - 6502アセンブラのテスト（アセンブル結果・シンボルテーブル・エラー表示）
 * - NSFヘッダ情報入力 → NSFバイナリ生成・ダウンロード
 */
(function () {
  // 表示文言の翻訳(src/i18n/i18n.js)。キーは日本語の原文そのもの
  const T = (key, params) => MML.I18n.t(key, params);

  // 版番号(src/version.js)をタイトルの横に出す。バグ報告でどの版かを伝えてもらうため
  const appVersionEl = document.getElementById('appVersion');
  if (appVersionEl && MML.VERSION) appVersionEl.textContent = 'v' + MML.VERSION;

  const mmlSourceEl = document.getElementById('mmlSource');
  const mmlOutputEl = document.getElementById('mmlOutput');
  mmlSourceEl.value = MML.Mml.SAMPLE_SOURCE;

  // フォント/配色設定の復元(エディタが色付きテキストを表示する前に反映する必要があるため
  // attachHighlighterより先に呼ぶ)
  MML.UI.EditorSettings.init();
  MML.UI.ConvertSettings.init(); // *2MML 変換設定(src/ui/convertSettings.js)

  // --- Phase 6: シンタックスハイライト & 波形エディタ ---
  const mmlHighlightEl = document.getElementById('mmlHighlight');
  // srcStart(絶対文字位置) -> DOM要素。再生ハイライト機能が対象spanをO(1)で引くための索引で、
  // オーバーレイのHTMLが変わるたび(attachHighlighterのonUpdate経由で)再構築する
  let mmlHighlightIndex = new Map();
  let mmlHighlightIndexGen = 0; // オーバーレイHTMLが作り直されるたびに増える(追随スクロールの位置キャッシュ無効化用)
  MML.Mml.attachHighlighter(mmlSourceEl, mmlHighlightEl, () => {
    mmlHighlightIndex = MML.Mml.buildOffsetIndex(mmlHighlightEl);
    mmlHighlightIndexGen++;
    MML.UI.EditorLineInfo.refresh(); // 行番号ガターの桁数/カーソル行の印を作り直したオーバーレイへ付け直す
  });
  // 行番号ガター(ON)/カーソル位置バッジ(OFF)の切り替え(src/ui/editorLineInfo.js)。
  // ガターの幅が変わると折り返し位置=要素のoffsetTopもずれるので、位置キャッシュを捨てさせる
  MML.UI.EditorLineInfo.init({
    textarea: mmlSourceEl,
    overlay: mmlHighlightEl,
    editorEl: mmlHighlightEl.parentElement,
    toggleEl: document.getElementById('mmlLineNumbers'),
    posEl: document.getElementById('mmlCursorPos'),
    onLayoutChange: () => { mmlHighlightIndexGen++; },
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
  MML.UI.Vrc7ToneEditor.init(mmlSourceEl);
  MML.UI.EnvelopeEditor.init(mmlSourceEl);
  // エディタのキー操作: Tab=タブ文字(フォーカスを飛ばさない)、F5=再生/一時停止(src/ui/editorKeys.js)
  MML.UI.EditorKeys.init(mmlSourceEl, {
    playPause: () => document.getElementById('btnMmlCapture').click(),
    save: (saveAs) => saveMmlFile({ saveAs }),
  });

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
  // ignorePreview=true: 「割当先の音で聴く」の元ch消し込みを含めない(WAV書き出し用。書き出しは常に元の音)
  function getChannelMuteConfig(ignorePreview) {
    return keyboardDisplay.getMuteConfig(ignorePreview ? { ignorePreview: true } : undefined);
  }

  // ── 割当プレビュー(「割当先の音で聴く」、src/audio/assign-preview.js) ─────────────
  // 鍵盤表示のチャンネル割当で選んだ借用先のNSF音源で、再生中の元chを鳴らし直す。実体は
  // 1つで、再生を始めるたびに(NSF/SPC/KSS/GBS/HES/VGM)そのプレイヤーへ載せる(attachAssignPreview)。
  // 元chの消し込みは鍵盤表示の getMuteConfig()/previewSpcMuteMask() がミュート設定へ重ねる。
  let assignPreview = null;
  function attachAssignPreview(player) {
    if (!MML.Audio.AssignPreview || !player || !player.audioCtx) return;
    if (!assignPreview) assignPreview = new MML.Audio.AssignPreview(player.audioCtx.sampleRate);
    player.preview = assignPreview;
    // フォーマットごとにプレイヤーのgainが違う(実測RMS校正)ので、NSF再生と同じ音量へ補正する
    assignPreview.hostGain = player._baseGain || (player.gainNode ? player.gainNode.gain.value : 1.56);
    assignPreview.reset();
    syncAssignPreview();
  }
  // プレビュー用の音量正規化オフセット。キャプチャのスナップショット(変換が読むのと同じもの)から
  // チップごとに求める。VGM以外の形式や、まだキャプチャが無いときは空(=従来どおり絶対値のまま)。
  function previewVolumeRefs() {
    const fn = MML.Vgm2MmlExpansion && MML.Vgm2MmlExpansion.attRefOfSnapshots;
    const data = vgmCaptureMirror && vgmCaptureMirror.data;
    if (!fn || !data) return null;
    const refs = {};
    for (const key of ['ga20', 'k007232', 'k054539', 'segapcm', 'c140', 'c352', 'qsound', 'okim6295', 'multipcm', 'psx']) {
      const e = data[key];
      if (e && Array.isArray(e.snapshots) && e.snapshots.length) refs[key] = fn(e.snapshots);
    }
    return refs;
  }
  function syncAssignPreview() {
    if (!assignPreview) return;
    const plan = MML.Convert && MML.Convert.ChannelPlan;
    const on = keyboardDisplay.isPreviewMode() && !!plan && plan.editable();
    assignPreview.setPlan(on ? keyboardDisplay.getPreviewPlan() : []);
    assignPreview.setProvider((f) => keyboardDisplay.getLiveChannels(f));
    // 変換と同じ「曲・チップ単位の音量正規化」をプレビューにも効かせる。プレビューは
    // 現在フレームしか見えないので、曲全体から求めた基準をこちらから渡す。
    // ★基準は変換とまったく同じ関数(Vgm2MmlExpansion.attRefOfSnapshots)で作る。別実装にすると
    //   「プレビューでは小さいのに変換すると大きい」というズレが生まれる(K054539で約10dB)。
    assignPreview.setVolumeRefs(previewVolumeRefs());
    assignPreview.enabled = on;
    // 元chのミュート(プレビュー分を含む)を再生中のプレイヤーへ貼り直す
    scheduleRerenderOnMute();
    if (spcActivePlayer) spcActivePlayer.applyMute(effectiveSpcMute());
  }
  // SPCのボイスミュート: ユーザーのミュート(spcMutedVoices) + プレビューで消す元ボイス
  function effectiveSpcMute() {
    return spcMutedVoices | (keyboardDisplay.previewSpcMuteMask ? keyboardDisplay.previewSpcMuteMask() : 0);
  }
  // SPC再生中のボイス状態を鍵盤表示の行(V0-V7)と同じ形で返す(プレビューが毎フレーム読む。
  // updateVoiceMonitor は80ms間隔の表示用なので使わず、ライブDSPから直接組む)
  function spcPreviewRows() {
    const p = spcActivePlayer && spcActivePlayer.player;
    if (!p || !p.dsp) return null;
    const dsp = p.dsp, regs = dsp.regs, voices = dsp.voices;
    const nonReg = regs[0x3D];
    // ノイズ周期($6C下位5bit)→2A03ノイズのノート番号(31-周期index)。spc2mmlと同じ規則
    const noiseNote = MML.SPC2MML && MML.SPC2MML.noiseNoteNum ? MML.SPC2MML.noiseNoteNum(regs[0x6C] & 0x1F) : null;
    const noiseIndex = noiseNote === null ? null : Math.max(0, Math.min(15, 31 - noiseNote));
    const rows = [];
    for (let ch = 0; ch < 8; ch++) {
      const v = voices[ch];
      const base = ch << 4;
      const pitch = regs[base + 2] | ((regs[base + 3] & 0x3F) << 8);
      const srcn = regs[base + 4];
      const active = v.envMode !== 'off' && v.env > 0;
      const noise = !!(nonReg & (1 << ch));
      // ボイス音量(VOL_L/R、符号付き7bit)の大きい方をエンベロープに掛ける(定位は落とす)
      const vv = Math.max(Math.abs((regs[base] << 24) >> 24), Math.abs((regs[base + 1] << 24) >> 24)) / 127;
      rows.push({ id: `V${ch}`, active, vol: active ? (v.env / 0x7FF) * vv : 0,
        freq: active && !noise ? pitchToHz(pitch, spcTuneForSrcn(srcn)) : 0,
        noise, noiseIndex, noiseShort: false,
        srcn, brrHash: spcBrrHashOf(srcn) }); // 音色キー(src/convert/toneKey.js ofLive)用
    }
    return rows;
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
    if (psfActivePlayer) {
      psfActivePlayer.applyMute(getChannelMuteConfig());
      return;
    }
    if (vgmActivePlayer) {
      vgmActivePlayer.applyMute(getChannelMuteConfig());
      return;
    }
    // MML / NSF Worklet 再生中は上記のいずれかで即時反映されるため、
    // 非再生中はミュート設定を変えても再レンダリングは不要
  }

  // 鍵盤表示のch別音量スライダーからの設定を取得する(getChannelMuteConfigと同じ形状、値は0〜2で1=100%)
  function getChannelVolumeConfig() {
    return keyboardDisplay.getVolumeConfig();
  }

  // GBS/HESのWAV書き出し用: 鍵盤のch別ミュート/音量を、素のAPUオブジェクトへ直接入れる。
  // これらのプレイヤークラス(GbsPlayer/HesPlayer)はapplyMuteを持たず、
  // 実再生では gbs/hes-stream-player.js のラッパーが同じことをしている。
  // key: 設定オブジェクト内のチップ名('gb' / 'hes')。
  function applyChannelSettingsToApu(apu, key) {
    if (!apu) return;
    const m = getChannelMuteConfig(); const me = m.expansion || m;
    if (me[key]) Object.assign(apu.mute, me[key]);
    const v = getChannelVolumeConfig(); const ve = v.expansion || v;
    if (ve[key] && MML.Emu.applyVolume) MML.Emu.applyVolume(apu.vol, ve[key]);
  }

  // ch別音量変更 → ストリーミング再生中は即時反映(scheduleRerenderOnMuteと同じ考え方。
  // SPCは専用配列形式のためonSpcVolumeChangeで別途扱う)
  function scheduleRerenderOnVolume() {
    if (activePlayer) { activePlayer.applyVolume(getChannelVolumeConfig()); return; }
    if (kssActivePlayer) { kssActivePlayer.applyVolume(getChannelVolumeConfig()); return; }
    if (gbsActivePlayer) { gbsActivePlayer.applyVolume(getChannelVolumeConfig()); return; }
    if (hesActivePlayer) { hesActivePlayer.applyVolume(getChannelVolumeConfig()); return; }
    if (psfActivePlayer) { psfActivePlayer.applyVolume(getChannelVolumeConfig()); return; }
    if (vgmActivePlayer) { vgmActivePlayer.applyVolume(getChannelVolumeConfig()); return; }
  }

  function toHex(n, digits) {
    return '$' + n.toString(16).toUpperCase().padStart(digits, '0');
  }

  // --- 鍵盤表示 ---
  const keyboardDisplay = new MML.UI.KeyboardDisplay(document.getElementById('keyboardDisplay'));
  // ★検証用の口(2026-09-17)。ブラウザ上で ch一覧の表示を確かめるには update() を呼ぶ必要があるが、
  //   実体は監視ループ(requestAnimationFrame)の中にしか無い。rAF はタブ/ペインが隠れていると
  //   **一度も発火しない**ので、自動での画面確認ができなかった(実測: 45秒で0回)。
  //   ここから直接 update(秒) を叩ければ、再生していなくても任意の位置の表示を検査できる。
  //   実行時の挙動には一切影響しない(読み出し専用の参照を1つ生やすだけ)。
  MML.UI.keyboardDisplay = keyboardDisplay;
  // 楽譜ウィンドウ(本記譜、src/ui/scoreView.js)。表記モデルは鍵盤表示の楽譜モードと同じ物を渡す
  const scoreView = new MML.UI.ScoreView(document.getElementById('scoreView'));
  scoreView.colorOf = (letter) => keyboardDisplay.getChannelColorByLetter(letter);
  MML._keyboardDisplay = keyboardDisplay; // 診断用(DevToolsから状態を見る。[[remote-console-diagnosis-technique]])
  // ── 無音自動送りとミュートの関係 ────────────────────────────────────────
  // ★ミュートは「聴き方」の設定であって曲の内容ではないので、無音判定に混ぜない。
  //   VGM/KSS/GBS/HESはライブ出力(=ミュート適用後)を見て10秒無音で次の曲へ進むため、
  //   全chミュートすると必ず曲が飛んでしまっていた(ユーザー報告: ワルキューレの伝説3曲目)。
  //   1つでもミュートがある間は判定自体を止める(NSFの先読みスキャン側は別途ミュート非適用)。
  function syncSilenceDetect() {
    // ★プレイヤーの let 宣言はこの関数より後ろにあるので、初期化前(TDZ)に呼ばれることがある。
    //   その時点ではまだプレイヤーが無く何もする必要が無いので握りつぶしてよい
    try {
      const enabled = !(keyboardDisplay.hasAnyMute && keyboardDisplay.hasAnyMute());
      for (const p of [activePlayer, vgmActivePlayer, kssActivePlayer, gbsActivePlayer, hesActivePlayer, spcActivePlayer, psfActivePlayer]) {
        if (p) p.silenceDetectEnabled = enabled;
      }
    } catch (e) { /* 初期化順の都合。再生開始時に必ず呼び直される */ }
  }

  keyboardDisplay.onMuteChange = () => {
    syncSilenceDetect();
    scheduleRerenderOnMute();
    mmlHighlightLastFrame = -1; // ミュート変更を即座にハイライト表示へ反映させる
    updateMmlRangeHighlight();
  };
  keyboardDisplay.onVolumeChange = () => { scheduleRerenderOnVolume(); };
  keyboardDisplay.onPreviewChange = () => syncAssignPreview();
  keyboardDisplay.spcLiveRows = spcPreviewRows;
  // ── ドラムサンプル台帳(全形式共用、2026-09-03) ──────────────────────────
  // drumSampleStore: パッドのキー('kind:start' = MML.Convert.DrumMap.key と同じ粒度)
  //   → { pcm: Float32Array, rate: Hz, hash, chip, chans }
  // 各形式のキャプチャが終わったときに組み直す(VGM: updateVgmDrumSamples、
  // 実データの出どころは src/emulator/vgmPlayer.js collectUsedSamples)。
  // パッド試聴・ドラム(DPCM)パネル・DPCMコスト表示はこの台帳だけを見る。
  let drumSampleStore = {};
  // 打点プロバイダ(形式ごと): いま表示中の曲について「DPCMへ載せる打点リスト」を作る係。
  //   { format, frameRate, totalFrames, build(rateIndex) → hits, listedKeys() → [パッドに出すキー] }
  // hits の形は src/convert/drumHits.js 冒頭参照。DPCMコスト表示(recomputeDpcmCost)が使う。
  let drumHitsProvider = null;
  let auditionSource = null; // 再生中のノード(次を鳴らすとき止める)

  /**
   * 台帳をフォーマット側の採取結果で差し替える(キャプチャ完了時)。
   * ★合成音chの打楽器化(synthDrum、キー 'syn:*')で登録済みのサンプルは残す(2026-09-04修正)。
   *   以前は各 updateXxxDrumSamples が drumSampleStore を丸ごと置き換えていたため、
   *   キャプチャ途中でEを選ぶと完了時にPCMだけ消え、パッドの試聴もDPCMコスト計算も壊れていた。
   */
  function setDrumSampleStore(store) {
    const keep = {};
    for (const k of Object.keys(drumSampleStore)) if (k.startsWith('syn:')) keep[k] = drumSampleStore[k];
    drumSampleStore = Object.assign(keep, store || {});
  }

  /** 倍率1.0ならそのまま返す(無駄なコピーを避ける)。それ以外は掛けた新しい配列を返す */
  function applyGain(pcm, gain) {
    if (!pcm || !(gain >= 0) || gain === 1) return pcm;
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * gain;
    return out;
  }

  function playFloatPcm(pcm, rateHz) {
    if (!pcm || !pcm.length || !(rateHz > 0)) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (auditionSource) { try { auditionSource.stop(); } catch (e) { /* ignore */ } auditionSource = null; }
    // AudioBufferのサンプルレートには下限があるので、低いDMCレートはそのままだと作れない。
    // コンテキストのレートへ線形補間で伸ばしてから鳴らす(音は同じ)
    const ctxRate = audioCtx.sampleRate;
    const n = Math.max(1, Math.round(pcm.length * ctxRate / rateHz));
    const buf = audioCtx.createBuffer(1, n, ctxRate);
    const out = buf.getChannelData(0);
    const step = rateHz / ctxRate;
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const idx = pos | 0;
      const a = pcm[Math.min(idx, pcm.length - 1)];
      const b = pcm[Math.min(idx + 1, pcm.length - 1)];
      out[i] = a + (b - a) * (pos - idx);
      pos += step;
    }
    const srcNode = audioCtx.createBufferSource();
    srcNode.buffer = buf;
    const g = audioCtx.createGain();
    g.gain.value = 0.9;
    srcNode.connect(g).connect(audioCtx.destination);
    srcNode.start();
    auditionSource = srcNode;
  }

  keyboardDisplay.onDrumAudition = (sampleKey, mode) => {
    const s = drumSampleStore[sampleKey];
    if (!s) return;
    // ★レート・差し替え・変換有無はサンプル単位の設定から引く(src/convert/drumSamples.js)
    const DS = MML.Convert.DrumSamples;
    const st = DS ? DS.resolve(s.hash, s.pcm, s.rate) : { pcm: s.pcm, srcRate: s.rate, rate: 'auto', gain: 1 };
    // ★変換ボリュームは試聴にも同じ倍率で効かせる(ユーザー指示)。「原音」側にも掛けるのは、
    //   このボタンが「元のPCM」ではなく「いまの設定で変換元として使われる音」の試聴だから
    //   (差し替えファイルもここから鳴る)。原音とDPCMの音量差で品質を誤判断しないためでもある
    const gain = st.gain != null ? st.gain : 1;
    if (mode !== 'dpcm') { playFloatPcm(applyGain(st.pcm, gain), st.srcRate); return; }
    // ★DPCM側は「簡易再生」ではなく、MML変換と同じ encode → decode を必ず通す
    //   (そうしないと実際に鳴る音と試聴が食い違う。[[hes-dda-clip-boundary-frame-mixing]]の
    //    ネイティブ再生と同じ方針)
    const table = MML.Dpcm.DMC_RATE_TABLE_NTSC;
    // 'auto' は変換(drumHits.js)と同じくドラム(DPCM)パネル最下段の DMC_RATE(既定は最高レート)
    const autoRate = MML.Convert.normalizeCmd(MML.UI.ConvertSettings ? MML.UI.ConvertSettings.get() : null).DMC_RATE;
    let ri = (st.rate !== 'auto' && st.rate !== null && st.rate !== undefined) ? (parseInt(st.rate, 10) | 0) : autoRate;
    if (!(ri >= 0 && ri < table.length)) ri = table.length - 1;
    const dstRate = table[ri];
    const src = st.pcm, srcRate = st.srcRate;
    const n = Math.max(1, Math.round(src.length * dstRate / srcRate));
    const res = new Float32Array(n);
    const step = srcRate / dstRate;
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const idx = pos | 0;
      const a = src[Math.min(idx, src.length - 1)];
      const b = src[Math.min(idx + 1, src.length - 1)];
      res[i] = (a + (b - a) * (pos - idx)) * gain;
      pos += step;
    }
    const dac = Math.max(0, Math.min(127, Math.round((res[0] + 1) / 2 * 127)));
    const enc = MML.Dpcm.encode(res, dstRate, ri, { startCounter: dac });
    const dec = MML.Dpcm.decode(enc.bytes, enc.sampleCount, dac);
    playFloatPcm(dec, dstRate);
  };

  // ── 打楽器/音階の手動上書き ────────────────────────────────────────────
  // ピッチ解析の信頼度(conf>=0.5)による自動判定が外れた曲を、耳で直すための指定。
  // ★指定はチップ側(Emu.SamplePitchUtil、サンプル内容のハッシュで localStorage 永続化)に
  //   入り、samplePitch() が conf に反映する。よってロールのドラム区画・鍵盤のnote列・
  //   vgm2mmlのドラムパート・DPCM変換の4箇所がこの1点で自動的に追随する。
  keyboardDisplay.onSampleKind = (ch, kind) => {
    const smp = ch.adpcmSample;
    if (!smp) return;
    const chip = sampleChipFor(smp.kind);
    if (!chip || !chip.setSampleKind) return;
    const res = chip.setSampleKind(smp, kind) || {};
    // 「音階として扱う」を選んだのに周期が検出できていないサンプルは、基準音が無いと
    // 音程を決めようがない。そのまま基準音の入力へ繋ぐ(黙って何も起きないのを避ける)
    if (res.needsTuning && keyboardDisplay.onAdpcmCalibrate) {
      setTimeout(() => keyboardDisplay.onAdpcmCalibrate(ch), 0);
    }
    // 判定が変わるとロールのドラム区画の中身が変わるので、保持済みキャプチャから組み直す
    afterSampleKindChange();
  };

  // 「打楽器/音階」の指定が変わったあとの追随(鍵盤のnote列メニューとドラムパネルの共通処理)。
  // ★2026-09-04: 以前はVGMのときだけ組み直していたので、他形式では指定しても何も起きなかった。
  function afterSampleKindChange() {
    spcPitchSrcnCache = null;
    const fmt = (MML.Convert.ChannelPlan && MML.Convert.ChannelPlan.format()) || kbdSourceKind;
    if (fmt === 'psf' && psfCaptureMirror && MML.RollBuild) {
      // PSF も VGM の PCM チップと同じく音程判定そのものが変わるので全再構築
      rebuildPsfRoll();
      updatePsfDrumSamples();
    } else if (fmt === 'vgm' && vgmCaptureMirror && MML.RollBuild) {
      // VGMはサンプルの音程判定そのものが変わる(ドラム区画に出る音符の集合が変わる)ので全再構築
      try {
        const t = MML.RollBuild.vgm(vgmCaptureMirror.data, vgmCaptureMirror.done, { poolMode: vgmPoolModes });
        pushRollTimeline(t);
      } catch (e) { console.warn('打楽器/音階の指定後のロール再構築に失敗:', e); }
      updateVgmDrumSamples(vgmCaptureMirror.data);
    } else if (synthDrum.rawRoll) {
      // SPC等: ロールのパッド置き換えは applySynthDrumToRoll が指定を見て毎回やり直す
      keyboardDisplay.setRollTimeline(applySynthDrumToRoll(synthDrum.rawRoll));
    }
    refreshDrumPanel();
    scheduleDpcmCostUpdate();
  }
  // ドラム(DPCM)パネルの「扱い」列。指定先は鍵盤のnote列メニューと同じ1点(内容ハッシュ)
  function setDrumSampleKind(hash, kind) {
    const U = MML.Emu && MML.Emu.SamplePitchUtil;
    if (!hash || !U || !U.setKindOverride) return;
    U.setKindOverride(hash, kind === 'auto' ? null : kind);
    afterSampleKindChange();
  }

  // sample.kind('c140'/'a'/'b'/'ga20'…) → 解析を持っているチップ本体。
  // onAdpcmCalibrate の分岐と同じ対応表(YM2610だけアダプタが .fm でチップを持つ)
  function sampleChipFor(kindStr) {
    if (kindStr === 'psx') return psfSampleBank; // PSF(src/emulator/psxSampleBank.js)
    const p = vgmActivePlayer && vgmActivePlayer.player;
    if (!p || !p.adapterById) return null;
    if (kindStr === 'a' || kindStr === 'b') {
      const a = p.adapterById.ym2610;
      return a ? a.fm : null;
    }
    const a = p.adapterById[kindStr];
    return a ? a.chip : null;
  }

  // ── ドラム(DPCM)パネル ────────────────────────────────────────────────
  // 1行=1サンプル。設定の単位がチャンネルではなくサンプルなので、鍵盤の割当UIではなく
  // 専用の表で扱う(src/ui/drumPanel.js、設定の実体は src/convert/drumSamples.js)。
  // 鍵盤左端のドラムパッドは「クリックで即試聴」、この表は「じっくり詰める」用。
  // 外部ファイルでサンプルを差し替える(インクルード)。DPCMコンバータと同じ経路で
  // 音声ファイルを読み、デコードしたPCMをそのサンプルの代わりに使う。
  // ★差し替えたPCMは変換にも試聴にもそのまま乗る(drumSamples.resolve が一括で返すため)。
  let drumIncludeInput = null;
  // DPCMコンバータで選択中の行の音をそのままパッドへ割り当てる(融合。src/ui/dpcmEditor.js currentSource)
  function converterSource() {
    return (MML.UI.DpcmEditor && MML.UI.DpcmEditor.currentSource) ? MML.UI.DpcmEditor.currentSource() : null;
  }
  function includeFromConverter(row) {
    const src = converterSource();
    if (!row || !row.hash || !src) return;
    MML.Convert.DrumSamples.setIncludePcm(row.hash, src.name, src.pcm, src.rate);
    MML.UI.DrumPanel.render();
    refreshDrumPanel();
    scheduleDpcmCostUpdate();
  }
  function converterSourceName() { const src = converterSource(); return src ? src.name : null; }

  function includeDrumSample(row) {
    if (!row || !row.hash) return;
    if (!drumIncludeInput) {
      drumIncludeInput = document.createElement('input');
      drumIncludeInput.type = 'file';
      drumIncludeInput.accept = 'audio/*';
      drumIncludeInput.style.display = 'none';
      document.body.appendChild(drumIncludeInput);
    }
    drumIncludeInput.onchange = async () => {
      const file = drumIncludeInput.files && drumIncludeInput.files[0];
      drumIncludeInput.value = '';
      if (!file) return;
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const buf = await audioCtx.decodeAudioData(await file.arrayBuffer());
        // モノラル化(左右の平均)。DPCMは元々モノラル
        const n = buf.length;
        const pcm = new Float32Array(n);
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < n; i++) pcm[i] += d[i] / buf.numberOfChannels;
        }
        MML.Convert.DrumSamples.setIncludePcm(row.hash, file.name, pcm, buf.sampleRate);
        MML.UI.DrumPanel.render();
        scheduleDpcmCostUpdate();
      } catch (e) {
        console.error('差し替えファイルの読み込みに失敗:', e);
        alert(T('音声ファイルを読み込めませんでした: {msg}', { msg: e.message }));
      }
    };
    drumIncludeInput.click();
  }

  const DRUM_ROW_COLORS = ['#e8564a', '#f0a232', '#4a9de8', '#9b6ef3', '#22b3a4', '#d94fa0',
                          '#7a8a99', '#c2a03a', '#5ac47a', '#ff7fa8', '#8ab4ff', '#d0703a'];
  function refreshDrumPanel() {
    const P = MML.UI.DrumPanel;
    if (!P) return;
    const lanes = keyboardDisplay.getDrumLanes ? keyboardDisplay.getDrumLanes() : [];
    const hits = keyboardDisplay.getDrumHitCounts ? keyboardDisplay.getDrumHitCounts() : {};
    const laneOf = {};
    for (const l of lanes) if (l.key && l.key !== '*') laneOf[l.key] = l;

    // ★一覧に出すサンプル = 「ロールのドラム区画に出ているもの」+「DPCMへ載せたchが鳴らすもの」。
    //   後者は音程が取れていてもDPCMへ変換されるので、パッドにも出す必要がある
    //   (DPCMで音律を奏でることもある。ユーザー指示)。後者の判定は形式ごとに違うので
    //   打点プロバイダ(drumHitsProvider.listedKeys)に任せる
    const keys = [];
    for (const l of lanes) if (l.key && l.key !== '*') keys.push(l.key);
    const extra = ((drumHitsProvider && drumHitsProvider.listedKeys) ? (drumHitsProvider.listedKeys() || []) : [])
      .concat(synthDrumSampleKeys()); // 合成音chの打楽器化分(main.js synthDrum)
    for (const k of extra) if (keys.indexOf(k) < 0 && drumSampleStore[k]) keys.push(k);

    const DS = MML.Convert.DrumSamples;
    const U = MML.Emu && MML.Emu.SamplePitchUtil;
    const kindMap = (U && U.getKindMap) ? U.getKindMap() : null;
    // ★「音階として扱う」と指定したサンプルは打点リストから外れるので、そのままだと行ごと
    //   消えて指定を戻せなくなる(2026-09-04修正)。この曲の台帳にある限り一覧に残す
    if (kindMap) {
      for (const k of Object.keys(drumSampleStore)) {
        const s = drumSampleStore[k];
        if (s && s.hash && kindMap[s.hash] === 'pitch' && keys.indexOf(k) < 0) keys.push(k);
      }
    }
    const labels = MML.Convert.DrumMap ? MML.Convert.DrumMap.labels(keys) : keys;
    // 打点プロバイダ(SPC/VGM)の打点が持つ assignTarget(D で打楽器化したボイス/chのサンプル→'noise')。
    // 行の「割当どおり」の載せ先に使う。合成音chの分は台帳(drumSampleStore)側の assignTarget を見る
    const provAssign = {};
    if (drumHitsProvider && typeof drumHitsProvider.build === 'function') {
      try {
        const b = drumHitsProvider.build();
        for (const h of (Array.isArray(b) ? b : ((b && b.hits) || []))) if (h && h.assignTarget === 'noise') provAssign[h.key] = 'noise';
      } catch (e) { /* 一覧の既定表示だけの材料なので失敗しても続ける */ }
    }
    const laneNames = {}; // drumKey → ユーザーが付けた名前(ロールのパッドへ流す)
    const rows = keys.map((k, i) => {
      const s = drumSampleStore[k], l = laneOf[k];
      const st = (DS && s && s.hash) ? DS.get(s.hash) : null;
      const name = st ? (st.name || null) : null;
      // 差し替え(インクルード)したサンプルは、名前を付けていなければファイル名をパッドに出す(ユーザー指示)
      const incName = (st && st.include && st.include.name) ? st.include.name.replace(/.[^.]*$/, '') : null;
      if (name || incName) laneNames[k] = name || incName;
      return { key: k,
               // label は「名前が未設定のときに出す既定表示」。名前そのものは行側が設定から引く
               // 台帳が既定ラベルを持つ形式(HESのROMオフセット/clip番号)はそれを優先する
               label: incName || (s && s.label) || (l && l.autoLabel) || (l && l.label) || labels[i] || k,
               color: (l && l.color) || DRUM_ROW_COLORS[i % DRUM_ROW_COLORS.length],
               hits: hits[k] || 0,
               // 扱い(自動/打楽器/音階)の現在値。実体はサンプル内容ハッシュ単位の上書き
               kind: (s && s.hash && kindMap) ? (kindMap[s.hash] || 'auto') : 'auto',
               hash: s ? s.hash : null, pcm: s ? s.pcm : null, srcRate: s ? s.rate : 0,
               // ノイズパッド: 割当どおりの載せ先(D で打楽器化=noise、他は dpcm)と元の音程(音程から自動の材料)
               defaultTarget: ((s && s.assignTarget === 'noise') || provAssign[k] === 'noise') ? 'noise' : 'dpcm',
               srcMidi: (s && s.srcMidi != null) ? s.srcMidi : null };
    });
    // ★パッド名はロールのドラム区画と同期させる(ユーザー指示)。名前の実体はサンプルの
    //   ハッシュ側にあり、ロールのノートはハッシュを持たないのでここで橋渡しする
    if (keyboardDisplay.setDrumLaneNames) keyboardDisplay.setDrumLaneNames(laneNames);
    P.setRows(rows);
  }

  if (MML.UI.DrumPanel) {
    MML.UI.DrumPanel.mount(document.getElementById('drumPanel'), {
      onChange: () => { scheduleDpcmCostUpdate(); },
      // 名前を変えたらロールのパッドへ流し直す(ROMコストは名前では変わらないので再計算しない)
      onRename: () => { refreshDrumPanel(); },
      onPlay: (row, mode) => { if (keyboardDisplay.onDrumAudition) keyboardDisplay.onDrumAudition(row.key, mode); },
      // ノイズパッドの音色の試聴(2026-09-18): 音色→1音のMML(noisePresets.js toneToMml)を本物のコンパイラ+
      // 2A03エミュ(MML.Mml.render)で描画して鳴らす。変換結果と同じ音になる
      onAuditionNoise: (tone) => {
        try {
          const src = MML.Convert.NoisePresets.toneToMml(tone);
          const r = MML.Mml.render(src, { sampleRate: 44100 });
          if (r && r.audio && r.audio.length) playFloatPcm(r.audio, 44100);
        } catch (e) { console.error('ノイズ音色の試聴に失敗:', e); }
      },
      // 扱い(自動/打楽器/音階)の手動上書き。鍵盤のnote列メニュー(VGMのPCM行)と同じ1点へ書く
      onKind: (row, kind) => setDrumSampleKind(row.hash, kind),
      onInclude: (row) => includeDrumSample(row),
      onIncludeFromConverter: (row) => includeFromConverter(row),
      converterName: () => converterSourceName(),
    });
  }

  // ── 音色一覧(音色ごとの変換設定、2026-09-09) ──────────────────────────────────
  // 実体: 設定は src/convert/toneSettings.js(キー=src/convert/toneKey.js、localStorage永続化)、
  // 表は src/ui/tonePanel.js。ここは「この曲で使われている音色の目録」を作って表へ渡し、
  // 試聴と変換オプション(planConvertOptions の toneSettings)への橋渡しをする。
  // 目録の材料はロールのタイムライン: ノートに載った音色キー(n.tone、roll-builders.js toneOf /
  // keyboard.js buildNoteTimelineFromChannelFrames)とトラックの tones 表(表示/試聴用の付随情報)。
  // SPCはノートの srcn からBRRハッシュで引く(Workerに brrSamples が無いのでメイン側で解決)。
  let toneInventory = [];
  let toneInventoryTimer = null;
  let spcBrrHashFor = null;
  const spcBrrHashCache = new Map(); // srcn → 'brr-…'
  function spcBrrHashOf(srcn) {
    if (spcBrrHashFor !== spcActiveBrrSamples) { spcBrrHashCache.clear(); spcBrrHashFor = spcActiveBrrSamples; }
    if (!spcActiveBrrSamples || srcn == null) return null;
    if (spcBrrHashCache.has(srcn)) return spcBrrHashCache.get(srcn);
    const h = MML.SPC2MML && MML.SPC2MML.brrHash ? MML.SPC2MML.brrHash(spcActiveBrrSamples[srcn]) : null;
    spcBrrHashCache.set(srcn, h);
    return h;
  }
  function scheduleToneInventory() {
    if (toneInventoryTimer) clearTimeout(toneInventoryTimer);
    toneInventoryTimer = setTimeout(() => { toneInventoryTimer = null; rebuildToneInventory(); }, 200);
  }
  function rebuildToneInventory() {
    const TK = MML.Convert.ToneKey, Plan = MML.Convert.ChannelPlan;
    if (!TK || !Plan) return;
    const tl = synthDrum.rawRoll || (keyboardDisplay.getRollTimeline ? keyboardDisplay.getRollTimeline() : null) || [];
    const isSpc = Plan.format() === 'spc';
    const map = new Map();
    for (const tr of tl) {
      const tones = tr.tones || {};
      for (const n of tr.notes || []) {
        let key = n.tone, info = key ? tones[key] : null;
        if (!key && isSpc && n.srcn != null && n.midi != null) {
          const h = spcBrrHashOf(n.srcn);
          key = h ? 'brr:' + h : null;
          info = { kind: 'brr', srcn: n.srcn, label: 'srcn' + n.srcn };
        }
        if (!key || !TK.isAssignable(key)) continue;
        let r = map.get(key);
        if (!r) {
          const k0 = key.split(':')[0];
          r = { key, kind: k0 === 'opllc' ? 'opll' : k0, label: (info && info.label) || key, info: info || {},
                chans: [], chanSet: new Set(), count: 0, first: n.startSec };
          map.set(key, r);
        } else if (info && (!r.info || !Object.keys(r.info).length)) r.info = info;
        r.count++;
        if (n.startSec < r.first) r.first = n.startSec;
        if (!r.chanSet.has(tr.id)) { r.chanSet.add(tr.id); r.chans.push({ id: tr.id }); }
      }
    }
    toneInventory = Array.from(map.values());
    for (const r of toneInventory) {
      for (const c of r.chans) {
        c.target = keyboardDisplay.getEffectiveTarget ? keyboardDisplay.getEffectiveTarget(c.id) : 'skip';
        c.letter = (c.target && c.target !== 'skip') ? Plan.letterOfTarget(c.target) : '';
      }
      r.color = keyboardDisplay.getChannelColor ? keyboardDisplay.getChannelColor(r.chans[0].id) : null;
      // 試聴用の実PCM(SPCのBRR / VGMのサンプル。台帳 drumSampleStore はハッシュを持つ)
      if (r.kind === 'brr' && spcActiveBrrSamples && r.info && r.info.srcn != null) {
        const brr = spcActiveBrrSamples[r.info.srcn];
        if (brr && brr.bytes && brr.bytes.length && MML.SPC2MML.decodeBrrBytes) { r.pcm = MML.SPC2MML.decodeBrrBytes(brr.bytes); r.srcRate = 32000; }
      } else if (r.kind === 'pcm') {
        const h = r.key.slice(4);
        const s = Object.keys(drumSampleStore).map(k => drumSampleStore[k]).find(x => x && x.hash === h);
        if (s) { r.pcm = s.pcm; r.srcRate = s.rate; }
      }
    }
    if (MML.UI.TonePanel) MML.UI.TonePanel.setRows(toneInventory);
    if (keyboardDisplay.refreshAssignUi) keyboardDisplay.refreshAssignUi(); // 「音色ごとに指定…(n)」の件数
  }
  /** planConvertOptions 用: この曲に出てくる音色キー */
  function toneInventoryKeys() { return toneInventory.map(r => r.key); }
  /** 鍵盤の音色セレクト「音色ごとに指定…(n)」用: そのchの音色のうち設定(音色/載せ先)を持つ数 */
  keyboardDisplay.toneOverrideCount = (chId) => {
    const S = MML.Convert.ToneSettings;
    if (!S) return 0;
    let n = 0;
    for (const r of toneInventory) {
      if (!r.chanSet.has(chId)) continue;
      const st = S.get(r.key);
      if (st.tone || st.target) n++;
    }
    return n;
  };
  // 割当セルの「音色ごとに指定…」→ 音色一覧ウィンドウをそのchで絞って開く
  keyboardDisplay.onOpenTonePanel = (chId) => {
    const w = document.getElementById('win-tones');
    if (w && getComputedStyle(w).display === 'none') {
      const btn = document.querySelector('.toggle-btn[data-target="win-tones"]');
      if (btn) btn.click(); else w.style.display = 'flex';
    }
    if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-tones');
    rebuildToneInventory();
    if (MML.UI.TonePanel) MML.UI.TonePanel.setFilter(chId || null);
  };
  // 変換結果の「VRC7自作音色があぶれてプリセットへ落ちた音色」を一覧の注記へ
  function noteToneDemotions(result) {
    if (MML.UI.TonePanel) MML.UI.TonePanel.setDemotions((result && result.toneDemotions) || []);
  }

  // ── 音色の試聴 ─────────────────────────────────────────────────────
  // 'raw' … 元の音: サンプルは実PCM、それ以外は音色の1周期波形(FMは定常波形)を鳴らす
  // 'mml' … 変換後: いまの載せ先/音色指定で1行のMMLを組み、変換と同じコンパイラ+NSF音源で鳴らす
  //          (最終出力と同じ経路で鳴らすので別実装の乖離が無い。[[roll-as-mml-debugger]] と同じ考え)
  let toneAuditionPlayer = null;
  function stopToneAudition() {
    if (toneAuditionPlayer) { try { toneAuditionPlayer.stop(); } catch (e) { /* ignore */ } toneAuditionPlayer = null; }
  }
  // 音色の1周期(±1、任意長)。無ければ null(サンプルのみ等)
  function toneCycleOf(row) {
    const TD = MML.Convert.ToneDerive, info = row.info || {};
    if (info.wave && info.wave.length) return info.wave.map(v => v / 7.5 - 1);
    if (row.kind === 'opn' && info.patch && TD) return TD.opnSteadyWave(info.patch);
    if (row.kind === 'opll' && TD) {
      let bytes = info.bytes;
      if (!bytes && info.inst > 0 && MML.Emu.OPLLNuked && MML.Emu.OPLLNuked.presetBytes) bytes = MML.Emu.OPLLNuked.presetBytes('ym2413', info.inst);
      return bytes ? TD.opllSteadyWave(bytes) : null;
    }
    if (row.kind === 'duty' || row.kind === 'sq') {
      const d = row.kind === 'duty' ? [0.125, 0.25, 0.5, 0.75][(info.duty | 0) & 3] : 0.5;
      return Array.from({ length: 64 }, (_, i) => (i / 64 < d ? 1 : -1));
    }
    return null;
  }
  // 借用先の音色定義+@指定を作る(変換 borrow.js adaptEvents と同じ材料から)
  function toneAuditionMml(row, ctx) {
    const Plan = MML.Convert.ChannelPlan, TD = MML.Convert.ToneDerive, B = MML.Convert.Borrow;
    const target = ctx.target;
    if (!target || target === 'skip' || target === 'dpcm') return null;
    const tt = Plan.targetInfo(target);
    const letter = Plan.letterOfTarget(target);
    if (!tt.chip || !letter) return null;
    const toneKind = ctx.toneKind;
    const st = ctx.st || {};
    // 効く音色指定: 音色の設定 → チャンネルの指定 → 既定
    let tone;
    if (toneKind) {
      tone = st.tone && st.tone[toneKind] !== undefined ? st.tone[toneKind] : undefined;
      if (tone === undefined) {
        const ch0 = (row.chans || [])[0];
        const ent = ch0 ? (Plan.get(ch0.id) || {}) : {};
        tone = ent.tone !== undefined ? ent.tone : Plan.toneOptionsFor(toneKind, row.kind === 'opn' ? 'fm4' : row.kind === 'opll' ? 'fm' : 'any').def;
      }
    }
    const lines = [];
    if (tt.chip !== '2a03') lines.push(tt.chip === 'n163' ? `${MML.Mml.EX_CHIP_DIRECTIVE.n163} ${tt.index + 1}` : MML.Mml.EX_CHIP_DIRECTIVE[tt.chip]);
    let inst = '', vol = 'v12', pre = '';
    const cycle = toneCycleOf(row);
    const wave32 = (B && B.toneWave(tone)) || (cycle && TD ? TD.toN163(cycle, 32) : null) || B.N163_SQUARE_WAVE;
    if (tt.family === 'pulse' || tt.family === 'vrc6pulse') {
      const def = tt.family === 'pulse' ? 2 : 7;
      const n = parseInt(tone, 10);
      inst = '@' + (isFinite(n) ? n : def);
    } else if (tt.family === 'fme7') { inst = '@1'; }
    else if (tt.family === 'n163') {
      const reg = MML.Convert.n163WaveRegistry();
      inst = '@' + reg.assign(wave32);
      lines.push(...reg.defLines());
    } else if (tt.family === 'fds') {
      const reg = new MML.Convert.WaveRegistry('@FM');
      const mx = Math.max(1, ...wave32);
      const w64 = Array.from({ length: 64 }, (_, i) => Math.max(0, Math.min(63, Math.round(wave32[Math.floor(i / 2)] * 63 / mx))));
      inst = '@' + reg.assign(w64);
      lines.push(...reg.defLines());
      vol = 'v32';
    } else if (tt.family === 'vrc7') {
      vol = 'v2';
      const info = row.info || {};
      if (tone === 'auto' && row.kind === 'opll' && info.inst > 0) inst = '@' + info.inst;
      else if (tone === '0' || tone === 'auto') {
        let bytes = (row.kind === 'opll' && info.bytes) ? info.bytes : null;
        if (!bytes && row.kind === 'opn' && info.patch && MML.VGM2MML && MML.VGM2MML.opnToOpllBytes) bytes = MML.VGM2MML.opnToOpllBytes(info.patch);
        if (!bytes && cycle && TD && TD.vrc7BytesFromWave) bytes = TD.vrc7BytesFromWave(cycle);
        if (bytes) {
          const reg = new MML.Convert.WaveRegistry('@OP');
          const idx = reg.assign(Array.from(bytes));
          lines.push(...reg.defLines());
          pre = `OP${idx} `; inst = '@0';
        } else inst = '@1';
      } else inst = '@' + Math.max(1, Math.min(15, parseInt(tone, 10) || 1));
    } else if (tt.family === 'noise') {
      const idx = Plan.noiseIndexFor(tone, 261.63, 1);
      const n = 31 - idx;
      const NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
      lines.push(`${letter} v12 o${Math.floor(n / 12)} ${NAMES[n % 12]}8 r8 ${NAMES[n % 12]}8 r8 ${NAMES[n % 12]}4`);
      return lines.join('\n') + '\n';
    } else if (tt.family === 'triangle') { vol = ''; }
    else if (tt.family === 'vrc6saw') { vol = 'v40'; }
    lines.push(`${letter} ${pre}${inst} ${vol} o4 c4 e4 g4 >c2`.replace(/\s+/g, ' '));
    return lines.join('\n') + '\n';
  }
  function toneAudition(row, mode, ctx) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    stopToneAudition();
    if (mode !== 'mml') {
      if (row.pcm && row.pcm.length) { playFloatPcm(row.pcm, row.srcRate || 32000); return; }
      const cyc = toneCycleOf(row);
      if (!cyc || !cyc.length) return;
      const sr = audioCtx.sampleRate, dur = 0.9, n = Math.round(sr * dur), out = new Float32Array(n), f = 261.63;
      for (let i = 0; i < n; i++) {
        const ph = (i * f / sr) % 1, t = i / n;
        const env = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
        out[i] = Math.max(-1, Math.min(1, cyc[Math.floor(ph * cyc.length)] || 0)) * 0.45 * env;
      }
      playFloatPcm(out, sr);
      return;
    }
    let src;
    try { src = toneAuditionMml(row, ctx || {}); } catch (e) { console.warn('音色試聴のMML生成に失敗:', e); return; }
    if (!src) return;
    const compiled = MML.Mml.compile(src, { dpcmSamples: dpcmSampleCache });
    if (compiled.errors && compiled.errors.length) { console.warn('音色試聴MMLのコンパイルエラー:', compiled.errors, src); return; }
    if (auditionSource) { try { auditionSource.stop(); } catch (e) { /* ignore */ } auditionSource = null; }
    const p = new MML.Audio.MmlStreamPlayer(audioCtx);
    p.load(compiled, null);
    p.onEnded = () => { if (toneAuditionPlayer === p) toneAuditionPlayer = null; };
    p.play();
    toneAuditionPlayer = p;
  }

  if (MML.UI.TonePanel) {
    MML.UI.TonePanel.mount(document.getElementById('tonePanel'), {
      onChange: () => { if (keyboardDisplay.refreshAssignUi) keyboardDisplay.refreshAssignUi(); },
      onPlay: (row, mode, ctx) => toneAudition(row, mode, ctx),
      // NSFはネイティブ変換で音色ごとの指定が効かない(一覧のみ。[[nsf-to-nsf-borrow-rearrange-todo]])
      editable: () => { const P = MML.Convert.ChannelPlan; return !!(P && P.editable() && P.format() !== 'nsf'); },
    });
    if (MML.Convert.ToneSettings && MML.Convert.ToneSettings.onChange) {
      MML.Convert.ToneSettings.onChange(() => { if (keyboardDisplay.refreshAssignUi) keyboardDisplay.refreshAssignUi(); });
    }
  }

  // ── DPCMの実コスト表示(割当を変えるたびに再計算) ────────────────────────
  // 借用先にDPCMを選んだchが増えるとROMがどれだけ増えるかは、実際に区間を切って
  // ミックス→重複排除→DMC化してみないと分からない(重複排除の効き方が曲次第のため)。
  // 実測で137定義・25秒ぶんの全工程が146msなので、そのまま本番と同じ計算を回して出す。
  // 割当セレクトの連打で詰まらないようデバウンスする。
  let dpcmCostTimer = null;
  function scheduleDpcmCostUpdate() {
    if (dpcmCostTimer) clearTimeout(dpcmCostTimer);
    dpcmCostTimer = setTimeout(() => { dpcmCostTimer = null; recomputeDpcmCost(); }, 250);
  }
  // 形式非依存: 打点プロバイダ(drumHitsProvider)から打点リストをもらい、変換と同じ
  // MML.Convert.DrumHits.dpcm を回して定義数/打点数/ROM量を出す
  function recomputeDpcmCost() {
    const prov = drumHitsProvider;
    if (!MML.Convert.DrumHits || !MML.Dpcm) { keyboardDisplay.setDpcmCost(null); return; }
    const synthHits = synthDrumHitsAll();
    // 形式が実サイズを直接答えられる(NSF: ROMバイト列そのまま、再エンコードしない)ならそれを使う。
    // 合成音chの打楽器化分(再エンコード)があればその見積りを足す
    if (prov && typeof prov.stats === 'function') {
      let st = null;
      try {
        st = prov.stats();
        if (synthHits.length && st) {
          const cmd = MML.Convert.normalizeCmd(MML.UI.ConvertSettings ? MML.UI.ConvertSettings.get() : null);
          const r = MML.Convert.DrumHits.dpcm(synthHits, prov.frameRate, { totalFrames: prov.totalFrames, dmcRate: cmd.DMC_RATE, rateMix: cmd.RATE_MIX, poly: cmd.DRUM_POLY });
          st = { clips: st.clips + r.stats.clips, bytes: st.bytes + r.stats.bytes, segments: st.segments + r.stats.segments, dropped: st.dropped + r.stats.dropped };
        }
      } catch (e) { console.error('DPCMコスト計算に失敗:', e); }
      keyboardDisplay.setDpcmCost(st);
      if (MML.UI.DrumPanel) MML.UI.DrumPanel.setCost(st);
      return;
    }
    let hits = [], rateIndex = null;
    try {
      const b = prov ? prov.build() : null;
      if (b && Array.isArray(b)) hits = b;
      else if (b && b.hits) { hits = b.hits; rateIndex = b.rateIndex != null ? b.rateIndex : null; }
    } catch (e) { console.error('DPCM打点の収集に失敗:', e); }
    hits = (hits || []).concat(synthHits);
    const info = synthDrumFrameInfo();
    if (!hits.length || !info.totalFrames) { keyboardDisplay.setDpcmCost(null); if (MML.UI.DrumPanel) MML.UI.DrumPanel.setCost(null); return; }
    keyboardDisplay.setDpcmCost('pending');
    // 計算自体は同期だが、'計算中…'を一度描かせてから走らせる
    setTimeout(() => {
      try {
        const cmd = MML.Convert.normalizeCmd(MML.UI.ConvertSettings ? MML.UI.ConvertSettings.get() : null);
        const r = MML.Convert.DrumHits.dpcm(hits, info.frameRate,
          { totalFrames: info.totalFrames, dmcRate: cmd.DMC_RATE, rateMix: cmd.RATE_MIX, poly: cmd.DRUM_POLY, rateIndex });
        keyboardDisplay.setDpcmCost(r.stats);
        if (MML.UI.DrumPanel) MML.UI.DrumPanel.setCost(r.stats);
      } catch (e) {
        console.error('DPCMコスト計算に失敗:', e);
        keyboardDisplay.setDpcmCost(null);
      }
    }, 0);
  }

  // ── 合成音chの打楽器化(分離レンダリング → 打点)(2026-09-03、ユーザー合意) ─────────────
  // 割当UIでサンプルPCM以外の行に E(DPCM) を選ぶと「このchは打楽器」。他chを全部ミュートして
  // そのchだけをレンダリングし、ロールのノート(オンセット/音高/音量)で切り出した音を
  // 「1音高=1パッド」のサンプルにする。打点は各 *2mml の options.drumHits として渡り、
  // src/convert/drumHits.js が @DPCM へ焼く。GBSのように実PCMを持たない形式でも
  // ドラムパッドに乗るのはこの経路(GBのノイズドラム→DPCM等)。
  //   ・キーは 'syn:<行ID>:<midi>'。ロールのドラム区画/パッド/変換で同じ
  //   ・代表サンプル=その音高で最も長い打点の切り出し(短い打点は次のトリガーで切れる=DMCと同じ)
  //   ・レンダリングは形式ごとの音声付きキャプチャ(captureXxxSongAsync + ミュート)。数秒かかる
  //     ので割当変更時に裏で回し、結果はキャッシュ。曲/形式が変わったら捨てる
  const synthDrum = {
    byCh: new Map(),     // chId → { hits, samples }
    pending: new Map(),  // chId → Promise
    token: 0,            // 曲/形式が変わるたび +1(古いレンダリング結果を捨てる)
    rawRoll: null,       // 打楽器化を適用する前のロールタイムライン(全形式共通形状)
  };
  MML._synthDrum = synthDrum; // 診断用(DevToolsから状態を見る。[[remote-console-diagnosis-technique]])
  function synthDrumReset() {
    for (const ent of synthDrum.byCh.values()) for (const k of Object.keys(ent.samples)) delete drumSampleStore[k];
    synthDrum.byCh.clear(); synthDrum.pending.clear(); synthDrum.token++; synthDrum.rawRoll = null;
  }
  // いま打楽器化されている合成音chのID一覧(割当が 'dpcm' で、サンプルPCMでない行)
  function synthDrumChIds() {
    const Plan = MML.Convert.ChannelPlan;
    if (!Plan || !Plan.isSynthDrumTarget) return [];
    // ★既定で E(DPCM) の行(VGMのDAC等)も対象にするので effectiveTargets を使う
    const all = Plan.effectiveTargets ? Plan.effectiveTargets() : {};
    return Object.keys(all).filter(id => Plan.isSynthDrumTarget(id, all[id]));
  }
  const synthDrumKeyOf = (chId, midi) => 'syn:' + chId + ':' + midi;
  // ── SPC: 借用先にE(DPCM)を選んだボイス(2026-09-04) ────────────────────────
  // SPCボイスは実BRRサンプルを持つので分離レンダリング(synthDrum)は要らない。E を選ぶと
  // 「そのボイスが鳴らした全サンプルをパッドにする」意味になり、複数ボイスをEにすれば
  // 打点は1本のDPCMへまとまる(DrumHits.dpcm が同時打点をミックス)。
  // 例外は「音階として扱う」と指定したsrcn(=従来の音程付きDPCM)。指定の実体は
  // Emu.SamplePitchUtil のkind上書き(BRR内容ハッシュ、localStorage)で、変換・ロール・
  // パッドの3箇所がこの1点を見る。
  function spcDpcmVoiceIds() {
    const Plan = MML.Convert.ChannelPlan;
    if (!Plan || Plan.format() !== 'spc') return [];
    const all = Plan.effectiveTargets ? Plan.effectiveTargets() : {};
    return Object.keys(all).filter(id => /^V[0-7]$/.test(id) && all[id] === 'dpcm');
  }
  function spcDpcmVoiceNums() { return spcDpcmVoiceIds().map(id => +id.slice(1)); }
  let spcPitchSrcnCache = null; // srcn集合(BRR台帳が変わるたびに捨てる)
  function spcPitchSrcnSet() {
    if (spcPitchSrcnCache) return spcPitchSrcnCache;
    const kinds = spcDrumKindsOf(spcActiveBrrSamples) || {};
    const s = new Set();
    for (const k of Object.keys(kinds)) if (kinds[k] === 'pitch') s.add(parseInt(k, 10));
    spcPitchSrcnCache = s;
    return s;
  }
  // ロールの1トラック → 打点ノート列(同音高で隙間なく続くノート=音量段の分割は1打点に統合)。
  // ★サンプル再生ch(note.sampleRow: YM2612のDAC・32X PWM・RF5C・OKIM6258など)はここでは
  //   扱わない。あれはレジスタ上「1本の連続したストリーム」で、ロールのノート境界は音量段の
  //   変わり目でしかなく打点ではない(OutRunners実測: 10秒で96ノート・全て隣接・音高は
  //   レート由来の固定値)。分離レンダリングした音から立ち上がりを拾う別経路
  //   (buildSynthHitsFromOnsets)が担当し、結果は synthDrum.byCh[id].notes に入る。
  function synthDrumNotes(track) {
    const out = [];
    let seq = 0;
    for (const n of track.notes) {
      if (n.midi == null || n.drumKey || n.sampleRow) continue;
      const key = synthDrumKeyOf(track.id, n.midi);
      const last = out[out.length - 1];
      if (last && last.drumKey === key && Math.abs(last.endSec - n.startSec) < 1e-3) {
        last.endSec = n.endSec; last.vol = Math.max(last.vol, n.vol || 0); continue;
      }
      out.push({ startSec: n.startSec, endSec: n.endSec, midi: null, drumKey: key, drumSeq: ++seq,
                 vol: n.vol || 0, freqSeq: [], srcMidi: n.midi });
    }
    return out;
  }
  // ロールタイムラインの受け口(全形式共通)。打楽器化したchのノートをドラム区画のノートへ置き換える
  function pushRollTimeline(timeline) {
    synthDrum.rawRoll = timeline;
    keyboardDisplay.setRollTimeline(applySynthDrumToRoll(timeline));
    scheduleToneInventory(); // 音色一覧(使われている音色の目録)も同じ材料から組み直す
  }
  // SPC: 借用先にE(DPCM)を選んだボイスは、そのボイスが鳴らした全BRRサンプルがパッドになる
  // (音階として扱う指定のsrcnは除く)。ロールでも同じ見え方にするため、音程ノートを
  // drumKey='brr:<srcn>' のドラム区画ノートへ置き換える。srcnはRollBuild.spcがノートに載せる。
  // ★キーは変換側(MML.SPC2MML.drumHits)と同一なので、ロールのパッドとMMLの@DPCMが一致する
  //   ([[roll-as-mml-debugger]])。
  function spcDpcmVoiceNotes(track) {
    const pitchSrcns = spcPitchSrcnSet();
    const out = [];
    let seq = 0;
    for (const n of track.notes) {
      if (n.drumKey) { out.push(n); continue; }
      if (n.midi == null || n.srcn == null || pitchSrcns.has(n.srcn)) { out.push(n); continue; }
      const key = 'brr:' + n.srcn;
      const last = out[out.length - 1];
      if (last && last.drumKey === key && Math.abs(last.endSec - n.startSec) < 1e-3) {
        last.endSec = n.endSec; last.vol = Math.max(last.vol, n.vol || 0); continue;
      }
      out.push({ startSec: n.startSec, endSec: n.endSec, midi: null, drumKey: key, drumSeq: ++seq,
                 vol: n.vol || 0, freqSeq: [], srcn: n.srcn });
    }
    return out;
  }
  function applySynthDrumToRoll(timeline) {
    if (!timeline) return timeline;
    const ids = synthDrumChIds();
    const spcIds = spcDpcmVoiceIds();
    if (!ids.length && !spcIds.length) return timeline;
    return timeline.map(tr => {
      if (spcIds.indexOf(tr.id) >= 0) return Object.assign({}, tr, { notes: spcDpcmVoiceNotes(tr) });
      if (ids.indexOf(tr.id) < 0) return tr;
      // サンプル再生chの打点は分離レンダリング後に決まる(ent.notes)。それまでは何も出さない
      const ent = synthDrum.byCh.get(tr.id);
      const drumNotes = (ent && ent.notes && ent.notes.length) ? ent.notes : synthDrumNotes(tr);
      // ★ロール構築の時点で実サンプルを同定済みの打点(drumKey付き・midi無し)はそのまま残す(2026-09-19)。
      //   HESのDDAはPSGの波形chと同じ行(PSG0-5)に載るので、DDAの行に E を選ぶとこの行が打楽器化の対象になり、
      //   以前は drumKey 付きノートまで捨てていた。分離レンダリングは音程ノートからしか打点を作らない
      //   (synthDrumNotes)ので、DDAだけの行は打点0個になり、ロールのドラム区画も鍵盤のパッドも消えていた
      //   (ユーザー報告「HESで鍵盤にドラムパッドが出てこない」。割当はファイル別に自動保存されるので開き直しても戻らない)。
      //   分離レンダリング由来の打点は synth: キーで別物なので二重にはならない
      const realDrums = tr.notes.filter(n => n.midi == null && n.drumKey && !(ent && ent.samples && ent.samples[n.drumKey]));
      return Object.assign({}, tr, { notes: drumNotes.concat(realDrums, tr.notes.filter(n => n.midi == null && !n.drumKey))
        .sort((a, b) => a.startSec - b.startSec) });
    });
  }
  // そのchだけ生かしたミュート設定(表示中の行から組む。形状は getMuteConfig と同じ)
  function soloMuteConfig(chId) {
    const cfg = keyboardDisplay.getMuteConfig();
    for (const k of Object.keys(cfg.apu)) cfg.apu[k] = true;
    for (const chip of Object.keys(cfg.expansion)) {
      const e = cfg.expansion[chip];
      if (Array.isArray(e)) { for (let i = 0; i < e.length; i++) e[i] = true; }
      else for (const k of Object.keys(e)) e[k] = true;
    }
    const mi = keyboardDisplay.getMuteInfoFor ? keyboardDisplay.getMuteInfoFor(chId) : null;
    if (mi) {
      if (mi.section === 'apu') cfg.apu[mi.key] = false;
      else {
        const e = cfg.expansion[mi.chip] = cfg.expansion[mi.chip] || (mi.type === 'array' ? [] : {});
        if (mi.type === 'array') e[mi.index] = false; else e[mi.key] = false;
      }
    }
    return cfg;
  }
  // 表示中の形式のフレームレートと総フレーム数(打点のフレーム換算用)
  function synthDrumFrameInfo() {
    const prov = drumHitsProvider;
    if (prov && prov.frameRate && prov.totalFrames) return { frameRate: prov.frameRate, totalFrames: prov.totalFrames };
    const fmt = kbdSourceKind;
    let frameRate = 60;
    if (fmt === 'nsf') frameRate = 60.0988;
    else if (fmt === 'gbs' && loadedGbsHeader) frameRate = loadedGbsHeader.playFps || 60;
    else if (fmt === 'kss' && loadedKssHeader) frameRate = loadedKssHeader.device.palMode ? MML.KSS.PAL_FPS : MML.KSS.NTSC_FPS;
    else if (fmt === 'hes') frameRate = MML.HES.VBLANK_FPS;
    else if (fmt === 'vgm') frameRate = MML.Emu.VGM_FRAME_RATE;
    // 総フレームはロールの最終ノートから(キャプチャ長そのものは形式ごとにローカル変数なので)
    let endSec = 0;
    for (const tr of (synthDrum.rawRoll || [])) for (const n of tr.notes) if (n.endSec > endSec) endSec = n.endSec;
    return { frameRate, totalFrames: Math.max(1, Math.ceil(endSec * frameRate)) };
  }
  // 1chだけをレンダリングして音声(Float32Array)を返す。形式ごとの音声付きキャプチャを使う
  // ★分離レンダリングは「再生しながら裏で走る」ので、1スライスのブロック時間を短く抑える
  //   (2026-09-04)。既定の15msでも再生とロール描画に割り込むため、明示的に小さく渡す。
  //   実測(OutRunners 3分・VGMのFM 1ch): 64フレームごとのyieldだと47秒中44秒が
  //   メインスレッド占有(50ms超の長タスク176回・最長531ms)で、音がカクつく。
  const ISOLATE_SLICE_MS = 6;
  // ただし何も鳴っていないなら割り込む相手がいないので、スライスを長く取って早く終わらせる
  // (2026-09-09: 4分の32X曲でパッドが出るまで2分半かかり「出てこない」と見えていた)。
  // 25msはrAFの描画1コマ(16ms)を1回落とす程度で、ロールが止まって見えるほどではない
  const ISOLATE_SLICE_MS_IDLE = 25;
  function isolateSliceMs() {
    const p = currentTransportPlayer();
    return (p && p.isPlaying) ? ISOLATE_SLICE_MS : ISOLATE_SLICE_MS_IDLE;
  }
  // ★yieldは setTimeout(0) ではなく MessageChannel を使う(キャプチャWorkerの macroYield と同じ)。
  //   setTimeout には4msの下限クランプがあり(非表示タブでは1秒まで伸びる)、6msスライスだと
  //   待ち時間の方が長くなって所要時間が何倍にもなる。MessageChannelはクランプされない。
  function isolateYield() {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }
  /** 表示中の形式の先読みキャプチャがまだ伸びているか(分離レンダリングの二重実行よけ) */
  function captureStillGrowing() {
    const fmt = (MML.Convert.ChannelPlan && MML.Convert.ChannelPlan.format()) || kbdSourceKind;
    const f = { nsf: () => nsfBufferedFraction, spc: () => spcBufferedFraction, kss: () => kssBufferedFraction,
                gbs: () => gbsBufferedFraction, hes: () => hesBufferedFraction, vgm: () => vgmBufferedFraction,
                psf: () => psfBufferedFraction }[fmt];
    return !!f && f() < 0.999;
  }
  /** ログから打点が取れる行(VGMのDAC)。分離レンダリングが要らないので待つ必要も無い */
  function isLogDrumRow(chId) { return !!DAC_ROW_CHIP[chId] || chId === 'KDA'; } // KDA: KSS 牌の魔術師の D/A(kssDacDrumFor)
  /**
   * 分離レンダリング(ドラムパッドの下ごしらえ)の進捗表示。chId=null で消す。
   * 出す先はドラム(DPCM)パネルの下段と、鍵盤表示のパッドの上(パネルを開いていなくても
   * 進み具合が見えるように。2026-09-09 ユーザー要望)。
   */
  function setDrumRenderStatus(chId, frac) {
    const text = chId ? T('打楽器の分離レンダリング中: {ch}', { ch: chId })
      + (frac > 0 ? '  ' + Math.round(frac * 100) + '%' : '') : '';
    if (MML.UI.DrumPanel && MML.UI.DrumPanel.setStatus) MML.UI.DrumPanel.setStatus(text);
    if (keyboardDisplay.setDpcmRenderStatus) keyboardDisplay.setDpcmRenderStatus(text, frac);
  }
  async function renderIsolatedChannel(chId, durationSeconds, onProgress) {
    // ★形式は ChannelPlan 側から取る。変換直後は鍵盤のソースが MML 再生('mml')へ切り替わり
    //   kbdSourceKind では元形式が分からなくなる(実際に空振りした)
    const fmt = (MML.Convert.ChannelPlan && MML.Convert.ChannelPlan.format()) || kbdSourceKind;
    const cfg = soloMuteConfig(chId);
    const sampleRate = 44100;
    const slice = { sliceBudgetMs: isolateSliceMs(), yieldFn: isolateYield };
    if (fmt === 'nsf' && loadedNsfBytes) {
      const songNo = parseInt(nsfSongIndexEl.value, 10) || 1;
      const r = await MML.Emu.captureSongAsync(loadedNsfBytes, Object.assign({ songIndex: songNo - 1, durationSeconds, sampleRate, mute: cfg }, slice), onProgress);
      return { audio: r.audio, sampleRate: r.sampleRate || sampleRate };
    }
    if (fmt === 'gbs' && loadedGbsBytes) {
      // 曲番号は表示値−firstSong(runGbs2Mml と同じ換算)
      const disp = parseInt(gbsSongIndexEl.value, 10) || loadedGbsHeader.firstSong;
      const songIndex = Math.max(0, disp - loadedGbsHeader.firstSong);
      const r = await MML.Emu.captureGbsSongAsync(loadedGbsBytes, Object.assign({ songIndex, durationSeconds, sampleRate, mute: cfg.expansion.gb || {} }, slice), onProgress);
      return { audio: r.audio, sampleRate };
    }
    if (fmt === 'kss' && loadedKssBytes) {
      const r = await MML.Emu.captureKssSongAsync(loadedKssBytes, Object.assign({ songIndex: parseInt(kssSongIndexEl.value, 10) || 0, durationSeconds, sampleRate, mute: cfg.expansion }, slice), onProgress);
      return { audio: r.audio, sampleRate };
    }
    if (fmt === 'hes' && loadedHesBytes) {
      const r = await MML.Emu.captureHesSongAsync(loadedHesBytes, Object.assign({ track: parseInt(hesTrackIndexEl.value, 10) || 0, durationSeconds, sampleRate, mute: cfg.expansion.hes || {} }, slice), onProgress);
      return { audio: r.audio, sampleRate };
    }
    if (fmt === 'psf' && loadedPsfInfo) {
      // PSF: CPU+SPU のフルエミュレーション(44.1kHz ステレオ)をモノラルへ
      const r = await MML.Emu.capturePsfSongAsync(loadedPsfInfo, Object.assign({ durationSeconds, mute: (cfg.expansion && cfg.expansion.psx) || [] }, slice),
        onProgress ? (done, total) => onProgress(done, total) : null);
      const n = r.audioL.length, audio = new Float32Array(n);
      for (let i = 0; i < n; i++) audio[i] = (r.audioL[i] + r.audioR[i]) * 0.5;
      return { audio, sampleRate: 44100 };
    }
    if (fmt === 'vgm' && loadedVgmBytes) {
      // exportVgmWav と同じ描き方(コマンド消化+チップ合成)。ステレオをモノラルへ。
      // yieldはフレーム数ではなく経過時間で判断する(1フレームの重さがチップ構成で
      // 何倍も変わるため、64フレーム固定だと重い曲で数百msブロックする)
      const player = new MML.Emu.VgmPlayer(loadedVgmBytes);
      player.applyMute(cfg);
      const totalFrames = Math.ceil(durationSeconds * player.frameRate);
      const total = Math.round(totalFrames * sampleRate / player.frameRate);
      const audio = new Float32Array(total);
      let pos = 0;
      let sliceStart = performance.now();
      for (let f = 0; f < totalFrames && pos < total && !player.ended; f++) {
        const chunk = player.renderFrame(sampleRate, false, true);
        const L = chunk.l || chunk.left || chunk[0], R = chunk.r || chunk.right || chunk[1];
        const n = L ? L.length : 0;
        for (let i = 0; i < n && pos < total; i++, pos++) audio[pos] = (L[i] + (R ? R[i] : L[i])) * 0.5;
        if (performance.now() - sliceStart >= isolateSliceMs()) {
          if (onProgress) onProgress(f, totalFrames);
          await isolateYield();
          sliceStart = performance.now();
        }
      }
      return { audio: audio.subarray(0, pos), sampleRate };
    }
    return null;
  }
  // ── VGM: ストリーミングDACの打点をログから引く(2026-09-04) ────────────────
  // YM2612のDAC・32X PWM・OKIM6258は、鳴っている音から打点を推測すると同じ太鼓が
  // 何種類にも割れる(切り出し長・音量・直前のフィルタ状態が毎回違うため)。
  // VGMログは「どこから流し始めたか」(0xE0シーク / 0x93・0x95のstart)を持っているので、
  // **その開始アドレスをそのままサンプル同定に使う**(C140などの sample.start と同じ)。
  // 実測 OutRunners「Mega Driver」: 実ドラムは8種類・各5〜23回、レートも約5kHzで一定。
  // 無音(DACレベル書き込みだけ)や短すぎる繋ぎは vgmPlayer.js collectDacHits が落としている。
  // ★ログ由来の経路は YM2612 のDAC(符号なし8bit生PCM)と OKIM6258(X68000、4bit OKI ADPCM)。
  //   OKIM6258 はDACストリーム(chipType 0x17)で1バイト=2サンプルを流すので、バンクの
  //   ADPCMバイト列をそのままデコードすればパッドの原音になる(2026-09-05。デコーダは
  //   src/emulator/expansion/okim6258.js Emu.decodeOKIM6258Adpcm、実再生と同じ差分表)。
  //   ストリーム周波数はバイトレートなのでサンプルレートはその2倍。
  //   ★0xB7 直書きでデータを流す曲はストリーム打点が無いのでパッドは出ない(YMDAの
  //     「打点が無ければDAC未使用」と同じ扱い。分離レンダリングへは落とさない)。
  //   32X PWM(2026-09-10、段階3): 0xB2直書きの1本のストリームで開始アドレスのような同定情報が
  //   無いので、キャプチャがサンプル列そのものを記録し(vgmPlayer.js pwmRec → data.pwmStream)、
  //   無音の切れ目でクリップに分けて「クリップ1本=打点1個」にする(vgmStreamDrumFor)。
  //   数秒〜数十秒の連続音声はそのまま長いクリップになり、共通層 drumHits.js の分割
  //   (自動/パネル下段の手動)で区間ごとの @DPCM とトリガーへ。行は PWL に集約(L/Rを1本にまとめる)
  const DAC_ROW_CHIP = { YMDA: 'ym2612', OKI: 'okim6258', PWL: 'pwm', M5: 'msm5205' };
  // 同定情報を持たない「1本のストリーム」をクリップへ分ける共通処理。
  // しきい値は音源ごとに別。32X PWM は「数秒〜数十秒の連続音声を1本」で、後段の
  // drumHits.js の分割に任せる前提の値(2026-09-10からの実績値。変えない)。
  // MSM5205(PC Engine CD)は**打楽器のループが流れてくる**ので、同じ値だと25秒の曲が
  // まるごと1クリップ=1定義(DPCM換算47KB)になってしまい使えなかった。実測でしきい値を詰めた:
  //   sil 0.08 / gap 0.03 / min 0.02 / ext 0.015 / 重複排除あり
  //   → ドラゴンスレイヤー03 Battle: 1定義25秒47.6KB → 10定義92打点・中央0.145秒・9.7KB
  //      スターパロジャー01: 1定義25秒22.8KB → 4定義145打点・中央0.033秒・1.2KB
  // ★ext(端伸ばし)が要る理由: 打点の分離だけを見て sil を上げると、クリップの端が
  //   波形の途中(振幅8%地点)で切れてプチノイズになる。検出は高いしきい値で行い、
  //   切り出す範囲だけ ext まで外へ広げると、端の段差が約10%→約2%に下がる(実測)。
  // ★dedup: 同じドラムの繰り返しを1定義に畳む。MSM5205はADPCMの内部状態が打点ごとに違い
  //   完全一致しないので、HES DDA の ClipRegistry と同じ「完全一致→前方一致→あいまい」で見る。
  const STREAM_DRUM_SRC = {
    pwm:     { key: 'pwmStream',     tag: 'pwm', sil: 0.02, gap: 0.25, min: 0.01, ext: 0,     dedup: false },
    msm5205: { key: 'msm5205Stream', tag: 'msm', sil: 0.08, gap: 0.03, min: 0.02, ext: 0.015, dedup: true }
  };
  const STREAM_DEDUP_MIN = 8; // これ未満のクリップは前方一致の判定に使わない(hes2mml MIN_CLIP_SAMPLES と同じ趣旨)
  // クリップ内容の重複排除。比較は 0-31 の粗いスケール(HES DDA と同じ土俵)。
  // 戻り値は「既存クリップの通し番号」か、新規なら null。
  function streamClipMatch(store, coarse) {
    const exact = store.exact.get(coarse.join(','));
    if (exact !== undefined) return exact;
    for (let i = 0; i < store.list.length; i++) {
      const u = store.list[i];
      const common = Math.min(u.length, coarse.length);
      if (common >= STREAM_DEDUP_MIN) {
        let prefix = true;
        for (let k = 0; k < common; k++) if (u[k] !== coarse[k]) { prefix = false; break; }
        if (prefix) return i; // 短い打点は長い定義の頭(実機DMCの「途中で切る」と同じ意味論)
      }
      if (Math.abs(u.length - coarse.length) > Math.max(u.length, coarse.length) * 0.02 + 2) continue;
      for (let off = -4; off <= 4; off++) {
        let sum = 0, n = 0;
        for (let k = 0; k < coarse.length; k++) {
          const j = k + off;
          if (j < 0 || j >= u.length) continue;
          sum += Math.abs(coarse[k] - u[j]); n++;
        }
        if (n >= coarse.length * 0.9 && sum / n <= 1.0) return i;
      }
    }
    return null;
  }
  function vgmStreamDrumFor(chId, frameInfo, chip) {
    const src = STREAM_DRUM_SRC[chip];
    if (!src) return null;
    const ps = vgmCaptureMirror && vgmCaptureMirror.data && vgmCaptureMirror.data[src.key];
    const log = ps && ps.log;
    if (!log || !log.samples || !log.samples.length || !log.frameEnd || !log.frameEnd.length) return null;
    const S = log.samples, FE = log.frameEnd, N = S.length;
    const frameRate = frameInfo.frameRate;
    const rate0 = log.rate > 0 ? log.rate : 22050;
    const gap = Math.max(1, Math.round(src.gap * rate0)), minLen = Math.max(8, Math.round(src.min * rate0));
    const sil = Math.round(src.sil * 32767);
    const ext = src.ext ? Math.round(src.ext * 32767) : 0;
    // サンプル番号 → フレーム(frameEnd は各フレーム末尾の累積本数)
    const frameOf = (i) => { let lo = 0, hi = FE.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (FE[m] > i) hi = m; else lo = m + 1; } return lo; };
    const U = MML.Emu && MML.Emu.SamplePitchUtil;
    const samples = {}, hits = [], notes = [];
    const store = { list: [], exact: new Map(), keyOf: [] }; // 重複排除の台帳(src.dedup のときだけ使う)
    let seq = 0, clipNo = 0;
    let i = 0;
    while (i < N) {
      while (i < N && Math.abs(S[i]) < sil) i++;      // 無音を飛ばす
      if (i >= N) break;
      const a0 = i;
      let lastLoud = i;
      while (i < N) {
        if (Math.abs(S[i]) >= sil) lastLoud = i;
        else if (i - lastLoud >= gap) break;
        i++;
      }
      const b0 = lastLoud + 1;
      // 切り出す範囲だけ ext まで外へ広げる(端の段差=プチノイズを避ける。上のコメント参照)
      let a = a0, b = b0;
      if (ext) {
        while (a > 0 && Math.abs(S[a - 1]) >= ext) a--;
        while (b < N && Math.abs(S[b]) >= ext) b++;
      }
      if (b - a < minLen) continue;
      const st = Math.min(frameOf(a), frameInfo.totalFrames);
      const en = Math.max(st + 1, Math.min(frameOf(b - 1) + 1, frameInfo.totalFrames));
      // レートはクリップ自身の「本数÷長さ」(直書きの間隔は曲中ほぼ一定。フレーム境界の丸めは数秒で1%未満)
      const rate = (b - a) / Math.max(1 / frameRate, (en - st) / frameRate);
      let key = null;
      if (src.dedup) {
        const coarse = new Uint8Array(b - a);
        for (let k = 0; k < coarse.length; k++) coarse[k] = Math.max(0, Math.min(31, Math.round((S[a + k] / 32767 + 1) * 15.5)));
        const hit = streamClipMatch(store, coarse);
        if (hit !== null) key = store.keyOf[hit];       // 同じ音 → 既存の定義を使い回す
        else { store.exact.set(coarse.join(','), store.list.length); store.list.push(coarse); }
      }
      if (key === null) {
        const pcm = new Float32Array(b - a);
        for (let k = 0; k < pcm.length; k++) pcm[k] = S[a + k] / 32767;
        // ハッシュは先頭8192サンプル固定(HES DDA と同じ理由: キャプチャ時間でクリップ長が変わっても同じ設定を引く)
        const hn = Math.min(pcm.length, 8192);
        const u8 = new Uint8Array(hn);
        for (let k = 0; k < hn; k++) u8[k] = Math.max(0, Math.min(255, Math.round(pcm[k] * 127 + 128)));
        key = src.tag + ':' + a;
        clipNo++;
        samples[key] = { key, pcm, rate, hash: (U && U.sampleHash) ? (src.tag + '-' + U.sampleHash(u8, 0, hn)) : null,
                         chip: src.tag + 'stream', chans: [chId], label: src.tag + clipNo };
        if (src.dedup) store.keyOf[store.list.length - 1] = key;
      }
      const s = samples[key];
      hits.push({ key, sampleKey: key, hash: s.hash, pcm: s.pcm, rate: s.rate, vol: 1,
                  startFrame: st, endFrame: en, exactEnd: true, chId });
      notes.push({ startSec: st / frameRate, endSec: en / frameRate, midi: null, drumKey: key, drumSeq: ++seq, vol: 1, freqSeq: [] });
    }
    if (!hits.length) return null;
    return { hits, samples, notes };
  }
  /** データバンクのバイト列 → Float32(-1..1)。OKIM6258はADPCM、PWMは2バイト12bit、他は符号なし8bit */
  function decodeDacBytes(bank, start, bytes, stepSize, chip) {
    if (chip === 'okim6258' && MML.Emu && MML.Emu.decodeOKIM6258Adpcm) {
      return MML.Emu.decodeOKIM6258Adpcm(bank, start, Math.min(bytes, Math.max(0, bank.length - start)));
    }
    if (stepSize >= 2) {
      const n = Math.floor(bytes / stepSize);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = start + i * stepSize;
        out[i] = (((bank[o] | (bank[o + 1] << 8)) & 0xFFF) - 2048) / 2048;
      }
      return out;
    }
    const n = Math.min(bytes, Math.max(0, bank.length - start));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = (bank[start + i] - 128) / 128;
    return out;
  }
  function vgmDacDrumFor(chId, frameInfo) {
    const chip = DAC_ROW_CHIP[chId];
    if (STREAM_DRUM_SRC[chip]) return vgmStreamDrumFor(chId, frameInfo, chip);
    const dp = vgmCaptureMirror && vgmCaptureMirror.data && vgmCaptureMirror.data.dacpcm;
    const d = dp && dp.log; // 1段包んである理由は vgmPlayer.js collectDacHits 参照
    if (!chip || !d || !d.hits || !d.hits.length) return null;
    const list = d.hits.filter(h => h.chip === chip);
    if (!list.length) return null;
    const U = MML.Emu && MML.Emu.SamplePitchUtil;
    // 同じ開始アドレス=同じサンプル。パッドの代表PCMは一番長く流れた分を採る
    const longest = new Map();
    for (const h of list) {
      const cur = longest.get(h.start);
      if (!cur || h.bytes > cur.bytes) longest.set(h.start, h);
    }
    const samples = {};
    for (const [start, h] of longest) {
      const bank = d.banks[h.bankType];
      if (!bank) continue;
      const pcm = decodeDacBytes(bank, start, h.bytes, h.stepSize || 1, chip);
      if (pcm.length < 8) continue;
      const u8 = new Uint8Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) u8[i] = Math.max(0, Math.min(255, Math.round(pcm[i] * 127 + 128)));
      const key = 'dacpcm:' + start;
      // OKIM6258はストリーム周波数がバイトレート(1バイト=2ニブル=2サンプル)なので2倍
      const rate = chip === 'okim6258' ? h.rate * 2 : h.rate;
      samples[key] = { key, pcm, rate,
        hash: (U && U.sampleHash) ? ('dac-' + U.sampleHash(u8, 0, u8.length)) : null,
        chip: 'dacpcm', chans: [chId] };
    }
    const hits = [], notes = [];
    let seq = 0;
    for (const h of list) {
      const key = 'dacpcm:' + h.start;
      const s = samples[key];
      if (!s) continue;
      const st = Math.min(h.startFrame, frameInfo.totalFrames);
      const en = Math.max(st + 1, Math.min(h.endFrame, frameInfo.totalFrames));
      // ★レートは打点ごとの実測値ではなくパッド共通の値を使う。0x8n経路の実測レートは
      //   打点ごとに数十Hz揺れる(5012/5079…)ため、そのまま渡すと DrumHits.dpcm の
      //   重複排除キーが打点ごとに変わり、9種類の太鼓が100定義に膨れる(実測)
      hits.push({ key, sampleKey: key, hash: s.hash, pcm: s.pcm, rate: s.rate, vol: 1,
                  startFrame: st, endFrame: en, exactEnd: true, chId });
      notes.push({ startSec: st / frameInfo.frameRate, endSec: en / frameInfo.frameRate,
                   midi: null, drumKey: key, drumSeq: ++seq, vol: 1, freqSeq: [] });
    }
    if (!hits.length) return null;
    return { hits, samples, notes };
  }

  // ── KSS: 牌の魔術師の 8bit D/A(KDA行)の打点を書込みログから引く(2026-09-19) ──────────
  // D/A への書込み(メモリ 0x5000-0x5FFF の符号なし8bit)がそのまま波形なので、音から推測せず
  // ログの値を並べれば原音になる(VGM の DAC と同じく「ログに答えがあるならログを読む」)。
  // 区切りは「D/A へ1回も書かなかったフレーム」。ゲームは1回の PLAY の中で DI したまま
  // 最後まで流し切り、鳴り終わると書込みが止まる(D/A は最後の値を保持するだけ)ので、
  // 振幅のしきい値で切る 32X PWM 方式(vgmStreamDrumFor)より確実。
  // レートはクリップの最初と最後の書込み時刻(writeLog の frac、1/64フレーム刻み)から出す
  // (実測 約16.7kHz。M1ウェイト込み)。同じ内容のクリップは1つのパッドにまとめ、レートも最初の1回の値を使う
  // (打点ごとの実測値を渡すと DrumHits.dpcm の重複排除キーがずれる。vgmDacDrumFor と同じ理由)
  function kssDacDrumFor(chId, frameInfo) {
    const wl = kssCaptureWriteLog;
    if (!wl || !wl.length) return null;
    const U = MML.Emu && MML.Emu.SamplePitchUtil;
    const unpackFrac = MML.Emu.kssUnpackFrac;
    const frameRate = frameInfo.frameRate;
    const n = Math.min(wl.length, frameInfo.totalFrames);
    const samples = {}, hits = [], notes = [];
    let seq = 0, clipNo = 0;
    let vals = null, t0 = 0, t1 = 0, f0 = 0, f1 = 0;
    const flush = () => {
      if (!vals || vals.length < 8) { vals = null; return; }
      const u8 = Uint8Array.from(vals);
      const hash = (U && U.sampleHash) ? U.sampleHash(u8, 0, u8.length) : String(u8.length) + ':' + f0;
      const key = 'kda:' + hash;
      if (!samples[key]) {
        const pcm = new Float32Array(u8.length);
        for (let i = 0; i < u8.length; i++) pcm[i] = (u8[i] - 128) / 128;
        const span = (t1 - t0) / frameRate;
        const rate = span > 0 ? (u8.length - 1) / span : u8.length * frameRate;
        const hn = Math.min(u8.length, 8192); // 設定の保存キーは先頭8192サンプル固定(HES DDA / vgmStreamDrumFor と同じ)
        clipNo++;
        samples[key] = { key, pcm, rate, hash: (U && U.sampleHash) ? ('kda-' + U.sampleHash(u8, 0, hn)) : null,
                         chip: 'kssdac', chans: [chId], label: 'dac' + clipNo };
      }
      const s = samples[key];
      const st = Math.min(f0, frameInfo.totalFrames);
      const en = Math.max(st + 1, Math.min(f1 + 1, frameInfo.totalFrames));
      // label: .dmc のファイル名/パッド名(drumHits.js clipFileName)。無いとキーのハッシュを番地と読み違えて「6.dmc」になる
      hits.push({ key, sampleKey: key, hash: s.hash, pcm: s.pcm, rate: s.rate, label: s.label, vol: 1,
                  startFrame: st, endFrame: en, exactEnd: true, chId });
      notes.push({ startSec: st / frameRate, endSec: en / frameRate, midi: null, drumKey: key, drumSeq: ++seq, vol: 1, freqSeq: [] });
      vals = null;
    };
    for (let f = 0; f < n; f++) {
      const w = wl[f];
      let any = false;
      if (w) {
        for (const pw of w) {
          if ((pw >> 24) & 1) continue;
          const addr = pw & 0xFFFF;
          if (addr < 0x5000 || addr > 0x5FFF) continue;
          const t = f + unpackFrac(pw);
          if (!vals) { vals = []; t0 = t; f0 = f; }
          vals.push((pw >> 16) & 0xFF);
          t1 = t; f1 = f;
          any = true;
        }
      }
      if (!any && vals) flush();
    }
    flush();
    if (!hits.length) return null;
    return { hits, samples, notes };
  }

  // ── サンプル再生ch(ストリーミングDAC)の打点検出(2026-09-04) ──────────────
  // YM2612のDAC・32X PWM・RF5C164/68・OKIM6258はレジスタ上「1本の連続したPCMストリーム」で、
  // どこが1発の太鼓なのかがレジスタからは分からない(ロールのノート境界は音量段の変わり目)。
  // そこで分離レンダリングした音そのものから立ち上がりを拾い、似た音を1パッドへ束ねる。
  // メガドライブ曲のドラムはここに載っていることが多い(ユーザー報告「アウトランでE→パッド出ず」)。
  const ONSET_HOP_SEC = 0.005;   // 包絡の刻み
  const ONSET_WIN = 8;           // 直前の平均を取る区間数(=40ms)
  const ONSET_RATIO = 1.8;       // 直前平均の何倍で「立ち上がり」とみなすか
  const ONSET_FLOOR = 0.06;      // 全体ピークに対する下限(これ未満は無音扱い)
  const ONSET_MIN_GAP = 0.045;   // 連続する打点の最小間隔[秒]
  const HIT_MAX_SEC = 0.6;       // 1打点の切り出し上限(ROM容量の歯止め)
  const SIM_THRESHOLDS = [0.75, 0.65, 0.55]; // パッドが増えすぎたら順に緩める
  const SIM_MAX_PADS = 16;

  /** DC除去(1極ハイパスy=x-x1+0.998y1)。DACの出力は無信号でも一定値なので必須 */
  function removeDc(audio) {
    const out = new Float32Array(audio.length);
    let px = 0, py = 0;
    for (let i = 0; i < audio.length; i++) { const v = audio[i] - px + 0.998 * py; out[i] = v; px = audio[i]; py = v; }
    return out;
  }
  /** 短時間RMSの立ち上がり検出 → 打点の開始時刻[秒]の配列 */
  function detectOnsets(pcm, sampleRate) {
    const hop = Math.max(1, Math.round(ONSET_HOP_SEC * sampleRate));
    const n = Math.floor(pcm.length / hop);
    if (n < ONSET_WIN + 2) return [];
    const e = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = i * hop; j < (i + 1) * hop; j++) s += pcm[j] * pcm[j];
      e[i] = Math.sqrt(s / hop);
    }
    let peak = 0;
    for (let i = 0; i < n; i++) if (e[i] > peak) peak = e[i];
    if (!(peak > 0)) return [];
    const floor = peak * ONSET_FLOOR;
    const minGap = Math.max(1, Math.round(ONSET_MIN_GAP / ONSET_HOP_SEC));
    const out = [];
    let last = -1e9;
    for (let i = ONSET_WIN; i < n; i++) {
      let m = 0;
      for (let k = i - ONSET_WIN; k < i; k++) m += e[k];
      m /= ONSET_WIN;
      if (e[i] > floor && e[i] > ONSET_RATIO * Math.max(m, floor * 0.25) && i - last >= minGap) {
        out.push(i * ONSET_HOP_SEC); last = i;
      }
    }
    return out;
  }
  /**
   * 打点の特徴ベクトル: 立ち上がり80msを24区間に割り、各区間のRMS(包絡)とゼロ交差率
   * (音の高さ・ノイズらしさ)を並べて、それぞれ長さ1へ正規化したもの。
   * 音量差・切り出し長の差には鈍く、太鼓の種類(キック/スネア/ハイハット)には敏感。
   */
  const FEAT_BINS = 24, FEAT_SEC = 0.08;
  function hitFeature(clip, sampleRate) {
    const span = Math.max(FEAT_BINS, Math.min(clip.length, Math.round(FEAT_SEC * sampleRate)));
    const v = new Float64Array(FEAT_BINS * 2);
    for (let i = 0; i < FEAT_BINS; i++) {
      const a = Math.floor(i * span / FEAT_BINS), b = Math.max(a + 1, Math.floor((i + 1) * span / FEAT_BINS));
      let s = 0, z = 0;
      for (let j = a; j < b && j < clip.length; j++) {
        s += clip[j] * clip[j];
        if (j > a && (clip[j] >= 0) !== (clip[j - 1] >= 0)) z++;
      }
      v[i] = Math.sqrt(s / (b - a)); v[FEAT_BINS + i] = z / (b - a);
    }
    let na = 0, nb = 0;
    for (let i = 0; i < FEAT_BINS; i++) { na += v[i] * v[i]; nb += v[FEAT_BINS + i] * v[FEAT_BINS + i]; }
    na = Math.sqrt(na) || 1; nb = Math.sqrt(nb) || 1;
    for (let i = 0; i < FEAT_BINS; i++) { v[i] /= na; v[FEAT_BINS + i] /= nb; }
    return v;
  }
  const featSim = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s / 2; };
  /** 特徴ベクトル列 → パッド番号列(貪欲クラスタリング。パッドが増えすぎたら閾値を緩める) */
  function clusterHits(feats) {
    let best = null;
    for (const th of SIM_THRESHOLDS) {
      const reps = [], of = [];
      for (const f of feats) {
        let bi = -1, bs = -1;
        for (let k = 0; k < reps.length; k++) { const s = featSim(f, reps[k]); if (s > bs) { bs = s; bi = k; } }
        if (bi >= 0 && bs >= th) of.push(bi); else { of.push(reps.length); reps.push(f); }
      }
      best = { of, pads: reps.length };
      if (reps.length <= SIM_MAX_PADS) break;
    }
    return best || { of: [], pads: 0 };
  }
  /** サンプル再生ch用: レンダリング音から打点を検出してパッド/打点/ロール用ノートを作る */
  function buildSynthHitsFromOnsets(chId, audio, sampleRate, frameInfo) {
    const pcmAll = removeDc(audio);
    const onsets = detectOnsets(pcmAll, sampleRate);
    if (!onsets.length) return { hits: [], samples: {}, notes: [] };
    const U = MML.Emu && MML.Emu.SamplePitchUtil;
    const clips = [], feats = [], peaks = [];
    for (let i = 0; i < onsets.length; i++) {
      const endSec = Math.min(onsets[i] + HIT_MAX_SEC,
        i + 1 < onsets.length ? onsets[i + 1] + 0.05 : onsets[i] + HIT_MAX_SEC);
      const s0 = Math.max(0, Math.floor(onsets[i] * sampleRate));
      const s1 = Math.min(pcmAll.length, Math.ceil(endSec * sampleRate));
      const clip = pcmAll.subarray(s0, s1);
      let pk = 0;
      for (let j = 0; j < clip.length; j++) { const a = Math.abs(clip[j]); if (a > pk) pk = a; }
      clips.push(clip); peaks.push(pk); feats.push(hitFeature(clip, sampleRate));
    }
    const { of } = clusterHits(feats);
    // パッドごとの代表波形は「その仲間の中で一番長い切り出し」(短い打点だけだと尻尾が欠ける)
    const repIdx = [];
    for (let i = 0; i < of.length; i++) {
      const p = of[i];
      if (repIdx[p] === undefined || clips[i].length > clips[repIdx[p]].length) repIdx[p] = i;
    }
    const samples = {};
    const keyOfPad = repIdx.map((_, p) => synthDrumKeyOf(chId, 'd') + (p + 1));
    for (let p = 0; p < repIdx.length; p++) {
      const src = clips[repIdx[p]];
      const pk = peaks[repIdx[p]];
      if (src.length < 8 || !(pk > 0)) continue; // 無音の区間はパッドにしない
      const pcm = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) pcm[i] = pk > 0 ? src[i] / pk * 0.98 : 0; // DMCの7bitを使い切る
      const u8 = new Uint8Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) u8[i] = Math.max(0, Math.min(255, Math.round(pcm[i] * 127 + 128)));
      samples[keyOfPad[p]] = { key: keyOfPad[p], pcm, rate: sampleRate,
        hash: (U && U.sampleHash) ? ('syn-' + U.sampleHash(u8, 0, u8.length)) : null,
        label: chId + ' ' + (p + 1), chip: 'synth', chans: [chId] };
    }
    let maxPeak = 0;
    for (const p of peaks) if (p > maxPeak) maxPeak = p;
    if (!(maxPeak > 0)) maxPeak = 1;
    const hits = [], notes = [];
    for (let i = 0; i < onsets.length; i++) {
      const key = keyOfPad[of[i]];
      const s = samples[key];
      if (!s) continue;
      const endSec = i + 1 < onsets.length ? onsets[i + 1] : onsets[i] + HIT_MAX_SEC;
      const st = Math.round(onsets[i] * frameInfo.frameRate);
      const en = Math.max(st + 1, Math.round(endSec * frameInfo.frameRate));
      hits.push({ key, sampleKey: key, hash: s.hash, pcm: s.pcm, rate: s.rate, label: s.label,
                  vol: peaks[i] / maxPeak, startFrame: st, endFrame: en, exactEnd: true, chId });
      notes.push({ startSec: onsets[i], endSec, midi: null, drumKey: key, drumSeq: i + 1,
                   vol: peaks[i] / maxPeak, freqSeq: [] });
    }
    return { hits, samples, notes };
  }

  // レンダリング済み音声とロールのノートから打点/サンプル表を作る
  function buildSynthHits(chId, audio, sampleRate, frameInfo) {
    const tl = synthDrum.rawRoll || keyboardDisplay.getRollTimeline();
    const tr = tl && tl.find(t => t.id === chId);
    if (!tr || !audio || !audio.length) return { hits: [], samples: {} };
    // ストリーミングDACの行は音そのものから打点を拾う(上のコメント参照)
    if (tr.notes.some(n => n.sampleRow)) return buildSynthHitsFromOnsets(chId, audio, sampleRate, frameInfo);
    const notes = synthDrumNotes(tr);
    if (!notes.length) return { hits: [], samples: {} };
    const U = MML.Emu && MML.Emu.SamplePitchUtil;
    const byKey = new Map();
    notes.forEach((n, i) => {
      const cur = byKey.get(n.drumKey);
      const len = n.endSec - n.startSec;
      if (!cur || len > cur.len) byKey.set(n.drumKey, { n, i, len });
    });
    const samples = {};
    for (const [key, rep] of byKey) {
      const n = rep.n;
      // 切り出し: ノートの頭〜終わり+短い尻尾(次の打点まで、最大80ms)
      const next = notes[rep.i + 1];
      const tail = Math.min(0.08, next ? Math.max(0, next.startSec - n.endSec) : 0.08);
      const s0 = Math.max(0, Math.floor(n.startSec * sampleRate));
      const s1 = Math.min(audio.length, Math.ceil((n.endSec + tail) * sampleRate));
      if (s1 - s0 < 8) continue;
      const pcm = new Float32Array(s1 - s0);
      let peak = 0;
      for (let i = 0; i < pcm.length; i++) { pcm[i] = audio[s0 + i]; const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
      if (peak > 0) for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i] / peak * 0.98; // DMCの7bitを使い切る
      const u8 = new Uint8Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) u8[i] = Math.max(0, Math.min(255, Math.round(pcm[i] * 127 + 128)));
      const hash = (U && U.sampleHash) ? ('syn-' + U.sampleHash(u8, 0, u8.length)) : null;
      const label = chId + ' ' + (MML.UI.midiToNoteName ? MML.UI.midiToNoteName(n.srcMidi) : String(n.srcMidi));
      // srcMidi: このパッドの元の音程(ノイズパッドの「音程から自動」が周期indexを決めるのに使う)
      samples[key] = { key, pcm, rate: sampleRate, hash, label, chip: 'synth', chans: [chId], srcMidi: n.srcMidi };
    }
    let maxVol = 0;
    for (const n of notes) if (n.vol > maxVol) maxVol = n.vol;
    if (!(maxVol > 0)) maxVol = 1;
    const hits = [];
    for (const n of notes) {
      const s = samples[n.drumKey];
      if (!s) continue;
      const st = Math.round(n.startSec * frameInfo.frameRate);
      hits.push({ key: n.drumKey, sampleKey: n.drumKey, hash: s.hash, pcm: s.pcm, rate: s.rate, label: s.label,
                  vol: n.vol / maxVol, startFrame: st, endFrame: Math.max(st + 1, Math.round(n.endSec * frameInfo.frameRate)),
                  exactEnd: true, chId, srcMidi: n.srcMidi });
    }
    return { hits, samples };
  }
  // 打点/パッドに「どの借用先で打楽器化したか」(assignTarget: E='dpcm' / D='noise')を刻む(2026-09-18)。
  // パッドの載せ先の既定「割当どおり」がこれを見る(src/convert/drumHits.js effectiveTarget)。D で打楽器化した
  // chの打点は、パッドが既定(音程から自動)のままなら従来の pitchedToNoise 出力そのまま、プリセットに
  // 変えた分だけ差し替わる(drumHits.js noise() の overrides)
  function stampSynthDrumAssign(id, ent) {
    const Plan = MML.Convert.ChannelPlan;
    const all = (Plan && Plan.effectiveTargets) ? Plan.effectiveTargets() : {};
    const tgt = all[id] === 'noise' ? 'noise' : 'dpcm';
    for (const h of (ent.hits || [])) h.assignTarget = tgt;
    for (const k of Object.keys(ent.samples || {})) { const s = ent.samples[k]; if (s) s.assignTarget = tgt; if (drumSampleStore[k]) drumSampleStore[k].assignTarget = tgt; }
  }
  // 打楽器化されたchのレンダリングを揃える(未レンダリングのchを裏で回し、外れたchを台帳から外す)。
  // 変換の直前に await して打点を確定させる
  function synthDrumEnsure() {
    const ids = synthDrumChIds();
    for (const [id, ent] of Array.from(synthDrum.byCh)) {
      if (ids.indexOf(id) >= 0) continue;
      for (const k of Object.keys(ent.samples)) delete drumSampleStore[k];
      synthDrum.byCh.delete(id);
    }
    const jobs = [];
    const info = synthDrumFrameInfo();
    let logDrumUpdated = false; // ログ由来の打点(VGMのDAC)は同期で決まるので、最後にロールへ流す
    for (const id of ids) {
      // 済みでも、その後キャプチャが伸びていたら(先読み途中で打楽器化した場合)全長で取り直す
      const done = synthDrum.byCh.get(id);
      if (done) stampSynthDrumAssign(id, done); // 割当が E↔D で変わっても打点/パッドの assignTarget を追従させる
      if (done && done.totalFrames >= info.totalFrames * 0.98) continue;
      // ★VGMのストリーミングDAC(YMDA)は必ずログ由来だけで決める(2026-09-04)。
      //   打点が無ければ「そのchはDACを使っていない」ということなので、何も作らずに終わる。
      //   ここで分離レンダリングへ落ちると、YMDAの既定がE(DPCM)である以上
      //   **DACを使っていないメガドライブ曲でも毎回フル再エミュレーションが走る**
      //   (ユーザー報告「ローリングサンダー2はPCM無いのに重い」の原因)。
      if (isLogDrumRow(id)) {
        const fromLog = id === 'KDA' ? kssDacDrumFor(id, info) : vgmDacDrumFor(id, info);
        if (fromLog) {
          fromLog.totalFrames = info.totalFrames;
          stampSynthDrumAssign(id, fromLog);
          synthDrum.byCh.set(id, fromLog);
          Object.assign(drumSampleStore, fromLog.samples);
          logDrumUpdated = true;
        }
        continue;
      }
      // ★先読みキャプチャがまだ伸びている間は分離レンダリングを始めない(2026-09-04)。
      //   途中の長さで走らせても、完了時に全長でもう一度走ることになり、重い処理が
      //   2回ぶん再生に割り込む(実測: VGM 3分1chで1回47秒・メインスレッド占有44秒)。
      //   キャプチャ完了時に各形式の .then() が synthDrumEnsure() を呼び直すので取りこぼさない。
      if (captureStillGrowing()) continue;
      if (synthDrum.pending.has(id)) { jobs.push(synthDrum.pending.get(id)); continue; }
      const token = synthDrum.token;
      // ★進捗を必ず出す(2026-09-04)。曲の長さぶん再エミュレーションするので数十秒かかり
      //   (実測: VGM 3分1chで47秒)、無表示だと「急に重くなった」ようにしか見えない。
      //   以前は存在しない要素(kbdDrumRenderStatus)へ書いていて何も出ていなかった
      setDrumRenderStatus(id, 0);
      const p = (async () => {
        try {
          const r = await renderIsolatedChannel(id, info.totalFrames / info.frameRate,
            (done, total) => { if (token === synthDrum.token) setDrumRenderStatus(id, total > 0 ? done / total : 0); });
          if (token !== synthDrum.token || !r) return;
          const built = buildSynthHits(id, r.audio, r.sampleRate, info);
          built.totalFrames = info.totalFrames;
          stampSynthDrumAssign(id, built);
          synthDrum.byCh.set(id, built);
          Object.assign(drumSampleStore, built.samples);
        } catch (e) {
          console.error('打楽器の分離レンダリングに失敗:', id, e);
        } finally {
          synthDrum.pending.delete(id);
          if (!synthDrum.pending.size) setDrumRenderStatus(null);
          if (token === synthDrum.token) {
            // 束ね直し(remap)の結果をロールにも反映する。サンプル再生chは1発ごとの仮キーで
            // 先に描いてあるので、レンダリングが終わった時点でパッドが正しい数に収束する
            if (synthDrum.rawRoll) keyboardDisplay.setRollTimeline(applySynthDrumToRoll(synthDrum.rawRoll));
            refreshDrumPanel();
            scheduleDpcmCostUpdate();
          }
        }
      })();
      synthDrum.pending.set(id, p);
      jobs.push(p);
    }
    if (logDrumUpdated) {
      // ログ由来の打点はレンダリングを待たないので、ここでロール/パッド/コストへ即反映する
      if (synthDrum.rawRoll) keyboardDisplay.setRollTimeline(applySynthDrumToRoll(synthDrum.rawRoll));
      refreshDrumPanel();
      scheduleDpcmCostUpdate();
    }
    return Promise.all(jobs);
  }
  // 打楽器化された全chの打点(変換の options.drumHits / DPCMコスト表示用)
  function synthDrumHitsAll() {
    const out = [];
    for (const id of synthDrumChIds()) {
      const ent = synthDrum.byCh.get(id);
      if (ent) out.push(...ent.hits);
    }
    return out;
  }
  function synthDrumSampleKeys() {
    const out = [];
    for (const id of synthDrumChIds()) {
      const ent = synthDrum.byCh.get(id);
      if (ent) out.push(...Object.keys(ent.samples));
    }
    return out;
  }

  // VGMの打点プロバイダ。割当UIで借用先に 'dpcm' を選んだPCMソースchの打点を集める
  // (vgm2mml/converter.js の dpcmDrums 呼び出しと同じ選び方)。
  function vgmDrumHitsProvider(mirror) {
    const dpcmSources = () => {
      const Plan = MML.Convert.ChannelPlan;
      const out = { byChip: new Map(), rateIndex: null };
      if (!loadedVgmHeader || !mirror || !mirror.data) return out;
      const def = MML.VGM2MML.defaultPlan(loadedVgmHeader);
      for (const s of MML.VGM2MML.sourceChannels(loadedVgmHeader)) {
        if (s.kind !== 'pcm' || s.ch < 0) continue;
        const chId = Plan.chIdForVgmSource(s.id);
        const ent = (chId && Plan.get(chId)) || {};
        const tgt = ent.target || def[s.id] || 'skip';
        if (tgt !== 'dpcm' && tgt !== 'noise') continue; // 'noise'=D で打楽器化(ノイズパッド、2026-09-18)。打点に assignTarget を刻む
        if (!out.byChip.has(s.chip)) out.byChip.set(s.chip, []);
        out.byChip.get(s.chip).push(s.ch);
        if (tgt === 'noise') { if (!out.noiseByChip) out.noiseByChip = new Map(); if (!out.noiseByChip.has(s.chip)) out.noiseByChip.set(s.chip, []); out.noiseByChip.get(s.chip).push(s.ch); }
        const v = ent.tone;
        if (out.rateIndex === null && v !== undefined && v !== null && v !== '' && v !== 'auto') {
          const n = parseInt(v, 10);
          if (Number.isFinite(n)) out.rateIndex = n;
        }
      }
      return out;
    };
    const CHIP_OF_DATA = { ga20: 'ga20', k007232: 'k007232', k054539: 'k054539', segapcm: 'segapcm', c140: 'c140', c352: 'c352',
                          qsound: 'qsound', okim6295: 'okim6295', multipcm: 'multipcm', ym2610fm: 'ym2610', ym2608fm: 'ym2608' };
    return {
      format: 'vgm',
      frameRate: MML.Emu.VGM_FRAME_RATE,
      get totalFrames() { return mirror && mirror.done ? mirror.done : 0; },
      build() {
        const { byChip, rateIndex, noiseByChip } = dpcmSources();
        const chips = MML.VGM2MML.DRUM_CHIPS || [];
        const sources = [];
        let totalFrames = 0;
        for (const [chipFlag, chans] of byChip) {
          const d = chips.find(x => x.flag === chipFlag);
          const e = d && mirror.data[d.data];
          if (!d || !e || !e.samples) continue;
          totalFrames = Math.max(totalFrames, e.snapshots.length);
          sources.push({ chip: chipFlag, snapshots: e.snapshots, chans, shape: d.shape, samples: e.samples,
                         noiseChans: (noiseByChip && noiseByChip.get(chipFlag)) || [] });
        }
        if (!sources.length || !totalFrames || !MML.Vgm2MmlExpansion.collectDrumHits) return null;
        return { hits: MML.Vgm2MmlExpansion.collectDrumHits(sources, MML.Emu.VGM_FRAME_RATE, totalFrames), rateIndex };
      },
      // パッド一覧に足すキー = DPCMへ載せたchが鳴らしたサンプル(音程が取れていてもDPCMになる)
      listedKeys() {
        const { byChip } = dpcmSources();
        const keys = [];
        for (const k of Object.keys(drumSampleStore)) {
          const s = drumSampleStore[k];
          const set = byChip.get(CHIP_OF_DATA[s.chip]);
          if (set && (s.chans || []).some(ch => set.indexOf(ch) >= 0)) keys.push(k);
        }
        return keys;
      },
    };
  }
  // 鍵盤の行で借用先を変えたら、その行に出る音色の「載せ先」指定(音色一覧、localStorage)は解除する
  // (音色指定と名前は残す)。優先順位は「音色の設定 > チャンネル」のままなので、以前に音色一覧で
  // 指定した載せ先が残っていると、行で三角波を選んでも音色側のN163が勝って見た目と食い違う
  // (ユーザー報告 2026-09-10: R-Type Leo FM7。音色一覧が壊れていた頃の指定が残っていた)。
  // あとから行で選んだ操作を勝たせる(ユーザー選択 2026-09-10)。同じ音色を鳴らす他の行にも効く
  function clearToneTargetsOnRow(chId) {
    const S = MML.Convert.ToneSettings;
    if (!S || !chId) return;
    for (const r of toneInventory) {
      if (!(r.chans || []).some(c => c.id === chId)) continue;
      if (S.get(r.key).target) S.set(r.key, { target: null });
    }
  }
  if (MML.Convert.ChannelPlan && MML.Convert.ChannelPlan.onChange) {
    MML.Convert.ChannelPlan.onChange((info) => {
      if (info && info.patch && 'target' in info.patch) clearToneTargetsOnRow(info.chId);
      // 合成音chの打楽器化(E選択)が変わったら: ロールを組み直し、未レンダリングのchを裏で回す
      if (synthDrum.rawRoll) keyboardDisplay.setRollTimeline(applySynthDrumToRoll(synthDrum.rawRoll));
      synthDrumEnsure();
      refreshDrumPanel();
      scheduleDpcmCostUpdate();
      scheduleToneInventory(); // 音色一覧の「使用ch」(パート文字/借用先)も追随
    });
  }

  // YM2610 ADPCM行(NA1-6/NB)のnote列クリック → そのサンプルの基準音を手動補正(表示専用)。
  // 入力: 音名(例 "C4"、"a#3")=そのサンプルの現在の再生レートでその音になるよう基準を設定 /
  //       "+20"/"-15" = 現在の表示音程からのセント補正 / 空欄 = 補正解除。
  // ym2610.js setSampleTuning がサンプル内容ハッシュをキーに localStorage へ永続化する。
  keyboardDisplay.onAdpcmCalibrate = (ch) => {
    if (!ch.adpcmSample) return;
    const smp = ch.adpcmSample;
    const p = vgmActivePlayer && vgmActivePlayer.player;
    // kind 'a'/'b'=YM2610(fmラッパーが解析を持つ)、'ga20'/'segapcm'=各チップ本体。
    // いずれも samplePitch/setSampleTuning の同一インターフェース(内容ハッシュのlocalStorage共有)
    const fm = smp.kind === 'psx'
      ? psfSampleBank
      : smp.kind === 'ga20'
      ? (p && p.adapterById.ga20 && p.adapterById.ga20.chip)
      : smp.kind === 'segapcm'
      ? (p && p.adapterById.segapcm && p.adapterById.segapcm.chip)
      : smp.kind === 'c140'
      ? (p && p.adapterById.c140 && p.adapterById.c140.chip)
      : smp.kind === 'c352'
      ? (p && p.adapterById.c352 && p.adapterById.c352.chip)
      : smp.kind === 'qsound'
      ? (p && p.adapterById.qsound && p.adapterById.qsound.chip)
      : smp.kind === 'okim6295'
      ? (p && p.adapterById.okim6295 && p.adapterById.okim6295.chip)
      : smp.kind === 'multipcm'
      ? (p && p.adapterById.multipcm && p.adapterById.multipcm.chip)
      : (p && p.adapterById.ym2610 && p.adapterById.ym2610.fm);
    if (!fm) return;
    const info = fm.samplePitch(smp.kind, smp.start, smp.end);
    if (!info) return;
    const rate = ch.adpcmRate || 0;
    const curHz = info.cps > 0 ? info.cps * rate : 0;
    const curName = curHz > 0 ? MML.UI.midiToNoteName(Math.round(69 + 12 * Math.log2(curHz / 440))) : '';
    const msg = T('{ch} のサンプルの基準音を補正します。\n現在: {cur}{manual}\n音名(例: C4)、またはセント補正(例: +20 / -15)を入力。空欄で補正解除。',
      { ch: ch.id, cur: curHz > 0 ? `${curName} (${curHz.toFixed(1)} Hz)` : T('音程なし'), manual: info.manual ? T('  [手動補正中]') : '' });
    const ans = window.prompt(msg, '');
    if (ans === null) return;
    const s = ans.trim();
    let cps = null;
    if (s === '') cps = null;
    else if (/^[+-]\d+(\.\d+)?$/.test(s)) { if (info.cps > 0) cps = info.cps * Math.pow(2, parseFloat(s) / 1200); }
    else {
      const m = s.match(/^([a-gA-G])([#b]?)(-?\d)$/);
      if (m && rate > 0) {
        const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
        const midi = 12 * (parseInt(m[3], 10) + 1) + base;
        cps = 440 * Math.pow(2, (midi - 69) / 12) / rate;
      } else { window.alert(T('入力を解釈できませんでした: {s}', { s })); return; }
    }
    fm.setSampleTuning(smp.kind, smp.start, smp.end, cps);
    if (smp.kind === 'psx') { rebuildPsfRoll(); updatePsfDrumSamples(); }
  };
  // 起動時から APU チャンネル行を表示（再生前でも空白にならないよう）
  keyboardDisplay.setSource({ regSnapshots: [{}], totalFrames: 1, samplesPerFrame: 735, sampleRate: 44100 }, []);

  // 鍵盤表示のレイアウト設定(ロールの置き場)とピアノロール別ウィンドウの連動:
  // 「別ウィンドウ」のときだけツールバーのトグルボタンを見せ、切り替えた瞬間に窓を開く。
  // 別ウィンドウ以外に戻したら窓を閉じてボタンも隠す(中身のロールペインは
  // keyboardDisplay 側が鍵盤表示ウィンドウへ戻している)。
  {
    const rollWinBtn = document.getElementById('btnTogglePianoRollWindow');
    const rollWinEl = document.getElementById('win-pianoroll');
    const syncRollWindow = (layout, opening) => {
      const useWindow = layout.rollPlacement === 'window';
      if (rollWinBtn) rollWinBtn.hidden = !useWindow;
      if (!rollWinEl || !rollWinBtn) return;
      const visible = rollWinEl.style.display !== 'none';
      if (useWindow && opening && !visible) rollWinBtn.click();
      if (!useWindow && visible) rollWinBtn.click();
    };
    syncRollWindow(keyboardDisplay.getLayout(), false);
    keyboardDisplay.onLayoutChange = (layout) => syncRollWindow(layout, true);
  }
  // ピアノロールをドラッグしてのシーク(縦向きは上下、横向きは左右)。keyboardDisplay側は
  // 「現在の再生速度での実時間の秒」(シークバーと同じ単位)を渡してくるので、そのまま
  // 共通のシーク入口へ。実際にシークした秒(クランプ後)を返してロールの表示位置を合わせる。
  keyboardDisplay.onRollSeek = (seconds) => seekToSeconds(seconds);
  // 鍵盤表示タイトルのバッジ用: <input type=file>に読み込まれているファイル名(無ければ空文字)
  function fileInputName(inputEl) {
    return (inputEl && inputEl.files && inputEl.files[0]) ? inputEl.files[0].name : '';
  }

  // --- 鍵盤表示タイトル行のバッジ+再生コントロール ---------------------------
  // 拡張子(=フォーマット)→サウンドファイルパネル内の再生ボタンid。鍵盤表示側の▶からは
  // このボタンをclick()して再生する(playXxxStream()を直接呼ぶと、ボタン側が一緒に行う
  // 処理(SPCのstartVoiceMonitor()等)を通らないため。D&D再生と同じ理由・同じ流儀)。
  const SOUND_FORMAT_PLAY_BTN = { nsf: 'btnNsfFilePlay', spc: 'btnSpcFilePlay', kss: 'btnKssFilePlay', gbs: 'btnGbsFilePlay', hes: 'btnHesFilePlay', vgm: 'btnVgmFilePlay', psf: 'btnPsfFilePlay' };
  const SOUND_FORMAT_STOP_BTN = { nsf: 'btnNsfFileStop', spc: 'btnSpcFileStop', kss: 'btnKssFileStop', gbs: 'btnGbsFileStop', hes: 'btnHesFileStop', vgm: 'btnVgmFileStop', psf: 'btnPsfFileStop' };
  // 曲番号(インデックス)を持つ形式 → その入力欄id。SPC/VGMは1ファイル1曲なので載らない
  // (単体で開いている限り戻り/送りの対象が無い。アーカイブを開いていればそちらの曲送りになる)。
  // 曲数はファイルごとに違うので、有効/無効の判定は入力欄のmin/maxから行う(下記
  // updateKeyboardTransport)。1曲だけのNSF等では ⏮⏭ もグレーアウトする。
  const SOUND_FORMAT_SONG_INPUT = { nsf: 'nsfSongIndex', kss: 'kssSongIndex', gbs: 'gbsSongIndex', hes: 'hesTrackIndex' };
  // 鍵盤表示ヘッダへ複製した「to MML」ボタンが押す実体(今表示している形式のもの)
  const SOUND_FORMAT_TOMML_BTN = { nsf: 'btnNsf2Mml', spc: 'btnSpc2Mml', kss: 'btnKss2Mml', gbs: 'btnGbs2Mml', hes: 'btnHes2Mml', vgm: 'btnVgm2Mml', psf: 'btnPsf2Mml' };
  // 演奏最大時間(秒)の入力欄と書き出しボタン。鍵盤表示のロール見出しに置いた
  // 「最大時間+出力形式+出力」(keyboard.js setExportControls)がこれらの代理になる
  const SOUND_FORMAT_DUR_INPUT = { nsf: 'nsfPlayDuration', spc: 'spcPlayDuration', kss: 'kssPlayDuration', gbs: 'gbsPlayDuration', hes: 'hesPlayDuration', vgm: 'vgmPlayDuration', psf: 'psfPlayDuration' };
  const SOUND_FORMAT_WAV_BTN = { nsf: 'btnNsfExportWav', spc: 'btnSpcExportWav', kss: 'btnKssExportWav', gbs: 'btnGbsExportWav', hes: 'btnHesExportWav', vgm: 'btnVgmExportWav', psf: 'btnPsfExportWav' };
  // 出力形式リスト。既定はWAV。レジスタログCSVはWAVと一緒に必ず出ていたのをやめ、
  // 選んだときだけ出す独立した形式にした(2026-09-09 ユーザー指示)
  // レジスタログを持つのは自前のCPUを回す形式(NSF/SPC/KSS)だけ。他は音声のみ
  const EXPORT_REGLOG_FORMATS = { nsf: true, spc: true, kss: true, mml: true };
  // AACはブラウザ内蔵のWebCodecsに任せるので、対応しているときだけ選択肢に出す
  // (src/audio/aacEncoder.js。Chromium系は通るが他は分からない)。判定は非同期なので
  // 起動時に1回だけ測ってここへ控える
  let aacExportAvailable = false;
  (async () => {
    try { aacExportAvailable = await MML.Audio.Aac.probe(44100, 2); } catch (e) { aacExportAvailable = false; }
  })();
  function exportFormatsFor(fmt) { // fmt: 形式名 または 'mml'(MML再生。NSFとして鳴らすのでレジスタログも出せる)
    const list = [['wav', 'WAV'], ['flac', 'FLAC']];
    if (aacExportAvailable) list.push(['aac', 'AAC (.m4a)']);
    if (EXPORT_REGLOG_FORMATS[fmt]) list.push(['reglog', T('レジスタログ(CSV)')]);
    return list;
  }
  // 直前に選ばれた出力形式('wav' | 'reglog')。各 exportXxxWav() がこれを見て出し分ける
  let exportMode = 'wav';

  let kbdSourceKind = null;     // 鍵盤表示が今表示しているソース 'mml' | 形式名 | null
  let loadedSoundFormat = null; // 直近に読み込んだサウンドファイルの形式(MML再生へ切り替えた後も覚えておく)

  // keyboardDisplay.setSourceInfo()の唯一の入口。バッジの表示に加えて「今どちらを
  // 操作対象にするか」(kbdSourceKind)と再生コントロールの状態も一緒に更新する。
  // 鍵盤表示のチャンネル割当(案E、src/convert/channelPlan.js)を各 *2mml の options 形へ。
  // ユーザーが既定から何も変えていなければ channelMap=null を返し、変換器は従来どおりの
  // 既定経路(出力が一切変わらない道)を通る。
  function planConvertOptions() {
    const Plan = MML.Convert && MML.Convert.ChannelPlan;
    // 音色ごとの設定(src/convert/toneSettings.js): この曲に出てくる音色ぶんだけ渡す。1つでも
    // 「変換に効く指定」があれば、既定割当のままでもユーザー指定経路(借用層)を通す必要がある
    // (既定経路は音色を見ない)。NSFはネイティブ変換で対象外
    const TSm = MML.Convert && MML.Convert.ToneSettings;
    const keys = toneInventoryKeys();
    const toneSettings = (TSm && Plan && Plan.format() !== 'nsf') ? TSm.snapshot(keys) : null;
    const toneCustom = !!(TSm && toneSettings && TSm.hasAny(keys));
    // ★drumHits は既定のままでも返す(2026-09-04): VGMのDACのように「既定がE(DPCM)」の行が
    //   あるので、ユーザーが何も触っていない状態こそが普通のケースになった
    if (!Plan || (!Plan.isCustom() && !toneCustom)) return { channelMap: null, tone: {}, drumHits: synthDrumHitsAll(), toneSettings: null };
    const all = Plan.all();
    const channelMap = {};
    const tone = {};
    for (const id of Object.keys(all)) {
      if (all[id].target) channelMap[id] = all[id].target;
      if (all[id].tone !== undefined) tone[id] = all[id].tone;
    }
    // drumHits: E(DPCM)へ載せた合成音chの打点(分離レンダリング済み。synthDrumEnsure を await してから呼ぶ)
    return { channelMap, tone, drumHits: synthDrumHitsAll(), toneSettings: toneCustom ? toneSettings : null };
  }

  function setKbdSource(kind, name) {
    kbdSourceKind = kind || null;
    if (kind !== 'mml') scoreView.setScore(null); // 楽譜は MML のコンパイル結果からしか作れない
    if (kind && kind !== 'mml') loadedSoundFormat = kind;
    keyboardDisplay.setSourceInfo(kind, name);
    updateKeyboardTransport();
    // 鍵盤表示のチャンネル割当(案E)が「今どの形式か」を知るための唯一の入口。
    // 同じ形式で呼び直されても割当は消さない(消すのは新ファイルを開いたときのnewFile)
    if (MML.Convert && MML.Convert.ChannelPlan && kind && kind !== 'mml') {
      MML.Convert.ChannelPlan.setFormat(kind);
    }
  }

  // アーカイブ(zip/7z の m3u 曲リスト)の曲数と曲送り。実体は initUnifiedSoundFileWindow 内で
  // 差し替える(archiveAutoAdvanceOrStopと同じ流儀。archive変数がそのIIFE内ローカルのため)。
  let archiveTrackCount = () => 0;
  let archiveChangeTrack = () => {};
  let archiveInfo = () => null;          // () => { name, titles:[string], index } | null  (鍵盤表示のファイル名ボタンの曲一覧)
  let archiveSelectTrack = () => {};     // (index) => void

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
    if (vgmActivePlayer && vgmActivePlayer.setSpeed) {
      vgmActivePlayer.setSpeed(factor);
      if (lastPlayMode === 'vgm') workletDuration = vgmActivePlayer.getDuration();
    }
    if (psfActivePlayer && psfActivePlayer.setSpeed) {
      psfActivePlayer.setSpeed(factor);
      if (lastPlayMode === 'psf') workletDuration = psfActivePlayer.getDuration();
    }
  };

  // --- マスター音量(0〜1、全フォーマット共通の最終段。src/audio/stream-player.js
  // MML.Audio.getMasterGain参照) --- 値自体の永続化(localStorage)はkeyboardDisplay側が
  // 行う(色/速度と同じ流儀)。audioCtxがまだ無い場合は何もしない
  // (次にgetMasterGain()が呼ばれた時点でlocalStorageの値を自分で読むため、取りこぼしはない)。
  keyboardDisplay.onMasterVolumeChange = (vol) => {
    if (audioCtx) MML.Audio.getMasterGain(audioCtx).gain.value = vol;
  };

  let monitorState = null;

  // ピアノロールの先読みキャプチャは非同期で走るため、曲切替/停止で古い結果を
  // 反映しないよう世代トークンで無効化する(NSF実ファイル再生・SPC・KSSの3経路)。
  let nsfRollToken = 0;
  let spcRollToken = 0;
  let kssRollToken = 0;
  let gbsRollToken = 0;
  let hesRollToken = 0;
  let vgmRollToken = 0;
  let psfRollToken = 0;

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
    if (keep !== 'vgm') vgmRollToken++;
    if (keep !== 'psf') psfRollToken++;
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
  // ★チップ本体(psg/scc)のnullチェックが必須。KssReplayStreamPlayerは this.player = this の
  // 自己参照で、psg/scc/opllは load() が呼ばれるまで null のまま。曲送り直後は「前の曲の
  // monitorStateが毎フレーム新プレイヤーを触るが、まだload()前」という窓ができるため、
  // ここを素通りさせると snapshotAY8910(null) で TypeError になり、monitorLoop の
  // requestAnimationFrame 再登録に到達せず描画ループが永久に止まる。
  function liveKssPsg() {
    if (!kssActivePlayer || !kssActivePlayer.player || !kssActivePlayer.player.psg) return null;
    return MML.Emu.snapshotAY8910(kssActivePlayer.player.psg);
  }
  function liveKssScc() {
    if (!kssActivePlayer || !kssActivePlayer.player || !kssActivePlayer.player.scc) return null;
    return MML.Emu.snapshotSCC(kssActivePlayer.player.scc);
  }
  function liveKssOpll() {
    if (!kssActivePlayer || !kssActivePlayer.player || !kssActivePlayer.player.opll) return null;
    return MML.Emu.snapshotOPLL(kssActivePlayer.player.opll);
  }
  function liveKssOpl() {
    if (!kssActivePlayer || !kssActivePlayer.player || !kssActivePlayer.player.opl) return null;
    return MML.Emu.snapshotOPL(kssActivePlayer.player.opl);
  }
  // 牌の魔術師の 8bit D/A(KDA行)。★スナップショットは呼ぶたびに「前回からの書込み有無」を消費する
  function liveKssDac() {
    if (!kssActivePlayer || !kssActivePlayer.player || !kssActivePlayer.player.dac) return null;
    return MML.Emu.snapshotMajutsushiDac(kssActivePlayer.player.dac);
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
  // エディタ本文以外のMML(MMLコマンドヘルプの実演スニペット等)を再生している間だけ非nullになる。
  // 鍵盤表示/ピアノロール/モニタ/シークバーは通常再生と同じ経路で動かしたいが、
  // 再生位置ハイライトだけは「今エディタに写っていない本文」の文字位置を指してしまうので抑止する
  let mmlExternalSourceLabel = null;
  let mmlExternalSourceOnEnded = null;
  // 実演再生中に退避しておくユーザーの再生範囲(青/赤ハンドル)。実演は常に全体を鳴らしたいが、
  // ユーザーが自分の曲に設定した範囲を壊してはいけないので、開始時に退避し停止時に戻す
  let mmlExternalSavedRange = null;
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
    const active = mmlHighlightEnableEl.checked && !mmlExternalSourceLabel && lastPlayMode === 'capture-mml' &&
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
    for (const el of mmlHighlightedElements) {
      el.classList.remove('mml-playing');
      if (el._mmlFollow) { el.classList.remove('mml-playing-follow'); el._mmlFollow = false; }
    }
    if (MML.UI.EditorLineInfo && MML.UI.EditorLineInfo.setPlayingLineEl) MML.UI.EditorLineInfo.setPlayingLineEl(null);
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
    const active = mmlHighlightEnableEl.checked && !mmlHighlightSuppressed && !mmlExternalSourceLabel && lastPlayMode === 'capture-mml' &&
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
      // 追尾チャンネル(mmlFollowChannel)だけは別色(.mml-playing-follow、色設定の「追尾チャンネル…」)。
      // 全チャンネルが同じ白だと、どれを追っているのか譜面上で見分けられなかった。
      // ★クラスの付け外しは追尾状態が変わった要素だけ(_mmlFollow)。毎フレーム全要素へ
      //   classList を書くと再生中にスタイル再計算が走る(.mml-playing と同じ配慮)
      const isFollow = ch === followCh;
      forEachElementInRange(r.srcStart, r.srcEnd, (el) => {
        if (first === null) first = el;
        if (el._mmlGen !== gen) {
          el._mmlGen = gen;
          if (!mmlHighlightedElements.has(el)) {
            el.classList.add('mml-playing');
            mmlHighlightedElements.add(el);
          }
          if (!el._mmlFollow !== !isFollow) {
            el.classList.toggle('mml-playing-follow', isFollow);
            el._mmlFollow = isFollow;
          }
        }
      });
      if (isFollow && first !== null) followEl = first;
    }
    // 今回の世代番号が付かなかった(=もう対象でなくなった)要素だけ消す
    for (const el of mmlHighlightedElements) {
      if (el._mmlGen !== gen) {
        el.classList.remove('mml-playing');
        if (el._mmlFollow) { el.classList.remove('mml-playing-follow'); el._mmlFollow = false; }
        mmlHighlightedElements.delete(el);
      }
    }
    // 行番号ガターも追尾チャンネルの現在行を強調する(行番号ONのときだけ効く)。
    // 追随スクロールのON/OFFとは独立: 追尾チャンネルを選んでいれば番号は付いていく
    if (MML.UI.EditorLineInfo && MML.UI.EditorLineInfo.setPlayingLineEl) {
      MML.UI.EditorLineInfo.setPlayingLineEl(followEl);
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

  // monitorLoop本体。例外が漏れると requestAnimationFrame の再登録に到達せず、
  // 鍵盤・ピアノロール・レジスタモニタの描画が「ページを再読込するまで永久に」止まる。
  // 1フレームぶんの不具合の代償としては大きすぎるので、monitorLoop側で必ず捕まえて
  // 次フレームを繋ぐ(原因究明のためログは最初の1回だけ出す)。
  // ★2026-08-22: KSS曲送り時に liveKssPsg が未ロードのチップを触って TypeError を投げ、
  //   これでロールが死んでいた。個別の原因は直したが、構造としてもここで塞いでおく。
  let monitorLoopErrorLogged = false;
  function monitorLoopBody() {
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
      keyboardDisplay.update(pos);
      updateMmlPlaybackHighlight(frameIndex);
      scoreView.setFrame(kbdSourceKind === 'mml' ? frameIndex : -1); // 楽譜ウィンドウのカーソル(MML再生のみ)
    } else {
      keyboardDisplay.update(0); // 停止中もピアノを常時描画
      updateMmlPlaybackHighlight(-1);
      scoreView.setFrame(-1);
    }
    // SPCはmonitorState(regSnapshots前提)に乗らず専用のupdateSpcVoices()経由(80ms間隔)
    // でしか描画されないため、ロールの再描画だけここでも(rAF=約60fps)呼んで滑らかにする
    // (ボイス詳細UI自体は変わらず80ms間隔のままでよい、体感の重さには影響しない)。
    if (spcActivePlayer && spcActivePlayer.isPlaying) {
      keyboardDisplay.updateRollPosition(spcActivePlayer.getPosition());
    }
    // 無音自動送り用の先読みスキャン(SPC以外)を少しずつ進める。scanSilenceStep自身が
    // 無音発見済み/曲末到達/先読みキャプチャ未到達のいずれかで自動的に仕事をやめるため、
    // 毎フレーム呼びっぱなしでよい(SCAN_STEP_SONG_SECONDS参照)。
    if (isSoundFileMode()) {
      const p = currentTransportPlayer();
      if (p && p.isPlaying && typeof p.scanSilenceStep === 'function') {
        p.scanSilenceStep(SCAN_STEP_SONG_SECONDS);
      }
    }
  }
  function monitorLoop() {
    try {
      monitorLoopBody();
    } catch (e) {
      if (!monitorLoopErrorLogged) {
        monitorLoopErrorLogged = true;
        console.error('monitorLoopで例外(以後この警告は出しません。描画は継続します):', e);
      }
    }
    requestAnimationFrame(monitorLoop); // 例外の有無に関わらず必ず次フレームを繋ぐ
  }
  requestAnimationFrame(monitorLoop);

  // --- 音声デコード/試聴用のAudioContext(ドラムパネルの差し替え読み込み・パッド試聴で共用) ---
  let audioCtx = null;

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

  // シークバーは複数箇所に同じものを置く(MMLエディタのトランスポート行=主、鍵盤表示の
  // ピアノロール見出し行=副。後者はkeyboardDisplay.setRollSeekBar()で渡す)。全インスタンスを
  // ここに登録し、位置/範囲ハンドル/バッファ済み表示/時間表示の更新は forEachSeekBar() で
  // 全部へ同時に流す。ドラッグ等の入力は各インスタンスから同じ共通処理へ入る。
  const seekBars = [];
  function forEachSeekBar(fn) { for (const sb of seekBars) fn(sb); }
  function setSeekBarValue(v) { forEachSeekBar((sb) => { sb.barEl.value = String(v); }); }
  // 時間表示は "経過 / 総時間"。鍵盤表示(ロール見出し)側は総時間の位置を
  // 「演奏最大時間の入力ボックス」に置き換えたので、経過だけを出す(2026-09-09 ユーザー指示)
  function setTimeDisplay(text) {
    forEachSeekBar((sb) => {
      if (!sb.timeEl) return;
      sb.timeEl.textContent = sb.currentOnly ? String(text).split('/')[0].trim() : text;
    });
  }
  // 主インスタンス(index.htmlの固定id要素)
  seekBars.push({ wrapEl: seekBarWrapEl, barEl: seekBarEl, timeEl: timeDisplayEl,
    handleStartEl: seekHandleStartEl, handleEndEl: seekHandleEndEl,
    rangeFillEl: seekRangeFillEl, bufferedFillEl: seekBufferedFillEl });
  // 副インスタンスを生成する(主と同じ構造・クラス。idは付けない)。keyboardDisplay側の見出し行に置く用
  function createSeekBarInstance() {
    const wrapEl = document.createElement('div');
    wrapEl.className = 'seek-bar-wrap seek-bar-wrap--roll';
    wrapEl.innerHTML =
      `<input type="range" min="0" max="${SEEK_RESOLUTION}" value="0" step="1" />` +
      `<div class="seek-buffered-fill"></div>` +
      `<div class="seek-range-fill"></div>` +
      `<div class="seek-handle seek-handle-start" title="${T('開始点（ドラッグで移動）')}"></div>` +
      `<div class="seek-handle seek-handle-end" title="${T('終了点（ドラッグで移動）')}"></div>`;
    const timeEl = document.createElement('span');
    timeEl.className = 'seek-time seek-time--roll';
    timeEl.textContent = String(timeDisplayEl.textContent || '00:00').split('/')[0].trim();
    const inst = { wrapEl, barEl: wrapEl.querySelector('input'), timeEl, currentOnly: true,
      handleStartEl: wrapEl.querySelector('.seek-handle-start'), handleEndEl: wrapEl.querySelector('.seek-handle-end'),
      rangeFillEl: wrapEl.querySelector('.seek-range-fill'), bufferedFillEl: wrapEl.querySelector('.seek-buffered-fill') };
    // 初期状態は主インスタンスの現在の表示をそのまま写す(以後はupdateTransportUI等が
    // 両方へ流す)。※ここでupdateRangeMarkersUI()等を呼ぶと、その先のcurrentTransportPlayer()が
    // まだ初期化前(TDZ)のkssActivePlayer等に触れて例外になるため呼ばない
    const src = seekBars[0];
    inst.barEl.value = src.barEl.value;
    for (const k of ['handleStartEl', 'handleEndEl', 'rangeFillEl', 'bufferedFillEl']) {
      inst[k].style.cssText = src[k].style.cssText;
    }
    seekBars.push(inst);
    setupSeekBarInput(inst);
    setupRangeHandleDrag(inst, inst.handleStartEl, 'start');
    setupRangeHandleDrag(inst, inst.handleEndEl, 'end');
    return inst;
  }

  // NSF/KSS実ファイル再生のバックグラウンドキャプチャ進捗(0〜1)。シークバーの
  // バッファ済み範囲インジケータ表示に使う。該当モード以外では常に非表示。
  let nsfBufferedFraction = 1;
  let kssBufferedFraction = 1;
  let spcBufferedFraction = 1;
  let gbsBufferedFraction = 1;
  // HES(HesReplayStreamPlayer)もNSF/KSS/GBSと同じく、バックグラウンドの
  // regsOnlyキャプチャが先読みで埋めた範囲までシーク・再生できる。
  let hesBufferedFraction = 1;
  let vgmBufferedFraction = 1;
  let psfBufferedFraction = 1;
  function currentBufferedFraction() {
    if (lastPlayMode === 'nsf') return nsfBufferedFraction;
    if (lastPlayMode === 'kss') return kssBufferedFraction;
    if (lastPlayMode === 'spc') return spcBufferedFraction;
    if (lastPlayMode === 'gbs') return gbsBufferedFraction;
    if (lastPlayMode === 'hes') return hesBufferedFraction;
    if (lastPlayMode === 'vgm') return vgmBufferedFraction;
    if (lastPlayMode === 'psf') return psfBufferedFraction;
    return null;
  }
  function updateSeekBufferedUI() {
    const frac = currentBufferedFraction();
    forEachSeekBar((sb) => {
      const el = sb.bufferedFillEl;
      if (!el) return;
      if (frac === null || frac >= 1) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'block';
      el.style.width = `${frac * 100}%`;
    });
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
  // 再生範囲(青→赤)をくり返す。ONだと終了点で止めずに開始点へ戻す。
  // 重ね録り(src/ui/recordPanel.js)は「1周ぶん録る」ためにこの折り返しで録音を閉じる。
  let loopRange = (function () {
    try { return localStorage.getItem('mml.loopRange') === '1'; } catch (e) { return false; }
  })();

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
    return activePlayer || kssActivePlayer || spcActivePlayer || gbsActivePlayer || hesActivePlayer || vgmActivePlayer || psfActivePlayer;
  }

  // NSF/KSS/SPC/GBS/HESそれぞれの再生ボタンの見た目を更新する。実在しないものは
  // 内部で自身のプレイヤーの有無をチェックするため、まとめて呼んでよい。
  function updateFormatPlayButtons() {
    updateNsfPlayButton();
    updateKssPlayButton();
    updateSpcPlayButton();
    updateGbsPlayButton();
    updateHesPlayButton();
    updateVgmPlayButton();
    updatePsfPlayButton();
  }

  /*
   * 「今この瞬間に鳴っている曲の位置」と、そのオーディオ時刻の対応表。
   * ★getTransportPosition()(= getPosition())と currentTime を直接突き合わせてはいけない。
   *   ScriptProcessorNodeは1バッファ先(4096sample≒93ms)を埋めるので必ずずれる。
   *   src/audio/stream-player.js の songTimeAt() が e.playbackTime 基準の正しい対応を持つ
   *   (実測: この対応表で予約したマーカー音と曲の音の一致は誤差5ms)。
   * MML再生時のみ。サウンドファイル再生や停止中は null。
   */
  function getPlaybackClock() {
    const p = currentTransportPlayer();
    if (!p || typeof p.songTimeAt !== 'function' || !p.isPlaying || !audioCtx) return null;
    const ctxTime = audioCtx.currentTime;
    const songSec = p.songTimeAt(ctxTime);
    return (songSec == null) ? null : { songSec, ctxTime };
  }

  /*
   * 再生UIの更新を次フレームへ予約する。前の予約は取り消すので、何度呼んでも
   * 走るのは1本だけ(ハートビートと同時に呼ばれても増えない)。
   */
  function scheduleTransportUi() {
    if (transportRaf) cancelAnimationFrame(transportRaf);
    transportRaf = requestAnimationFrame(updateTransportUI);
    ensureTransportHeartbeat();
  }

  /*
   * ★requestAnimationFrameが回らない環境の保険(2026-09-06)。
   *   再生範囲の終端での停止/くり返しは updateTransportUI() の中にあるため、rAFが
   *   止まると「終了点で止まらない/ループが折り返さない」が起きる。背面タブでは
   *   rAFは完全に止まり、埋め込みプレビューでは可視でも回らない環境がある(実測)。
   *   setIntervalは背面でも1秒までしか間引かれないので最低限の頻度は保てる。
   *   可視時はrAFが先に回るのでこちらは実質何もしない(updateTransportUIは冪等)。
   *
   * ★常駐タイマーにしてはいけない: index.html の <script> を順に読むだけの
   *   ヘッドレスハーネス(tools/headless/load.js)でも main.js は評価されるため、
   *   モジュール直下に setInterval を置くとNodeのイベントループが終わらず
   *   `node tools/headless/convert.js` が永久にぶら下がる(実際に踏んだ)。
   *   再生が始まったときだけ起こし、止まったら自分で片付ける。
   */
  let transportHeartbeat = null;
  function ensureTransportHeartbeat() {
    if (transportHeartbeat !== null) return;
    transportHeartbeat = setInterval(() => {
      const pl = currentTransportPlayer();
      const playing = pl ? pl.isPlaying : transportPlaying;
      if (playing) updateTransportUI();
      else stopTransportHeartbeat();
    }, 250);
  }
  function stopTransportHeartbeat() {
    if (transportHeartbeat === null) return;
    clearInterval(transportHeartbeat);
    transportHeartbeat = null;
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
    updateKeyboardTransport(); // 鍵盤表示タイトル行の▶/⏸/■(MML側の状態変化はここを通る)
    updateRangeMarkersUI(duration);
    updateSeekTicksUI(duration);
    updateSeekBufferedUI();
    if (!duration) return;
    const pos = getTransportPosition();
    // メトロノームの同期は対応表(songTimeAt)が立ってから成立するので、毎フレーム機会を与える
    // (同期要求が無ければ何もしない)
    if (MML.UI.MetronomePanel) MML.UI.MetronomePanel.tickPlaybackSync();
    setSeekBarValue(Math.round((pos / duration) * SEEK_RESOLUTION));
    setTimeDisplay(`${formatTime(pos)} / ${formatTime(duration)}`);
    if (playing && isFadeableSoundFileMode() && p && p.gainNode && audioCtx) {
      updateEndFadeGain(p, pos, duration);
    }
    if (playing) {
      if (pos >= duration) {
        if (isSoundFileMode()) finishSoundFilePlayback(); else transportStop();
      } else if (rangeEndSec !== null && pos >= rangeEndSec) {
        if (loopRange && canSeek()) {
          // くり返し: 止めずに開始点へ戻す。重ね録り中はここで1周ぶんを閉じる
          transportSeek(rangeStartSec || 0);
          if (MML.UI.RecordPanel) MML.UI.RecordPanel.onLoopWrapped();
          scheduleTransportUi();
        } else if (rangeEndArmed) {
          rangeEndArmed = false;
          if (isSoundFileMode()) finishSoundFilePlayback(); else transportStop();
        } else {
          scheduleTransportUi();
        }
      } else {
        rangeEndArmed = true;
        scheduleTransportUi();
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
    if (currentTransportPlayer()) return lastPlayMode === 'capture-mml' || lastPlayMode === 'nsf' || lastPlayMode === 'kss' || lastPlayMode === 'spc' || lastPlayMode === 'gbs' || lastPlayMode === 'hes' || lastPlayMode === 'vgm' || lastPlayMode === 'psf';
    return !!capturedBuffer;
  }

  function currentDuration() {
    return currentTransportPlayer() ? workletDuration : (capturedBuffer ? capturedBuffer.duration : 0);
  }

  // 開始点(青)/終了点(赤)ハンドルと範囲の塗りつぶしをシークバー上に表示する
  function updateRangeMarkersUI(duration) {
    if (duration === undefined) duration = currentDuration();
    const pct = (sec) => Math.max(0, Math.min(100, (sec / duration) * 100));
    const show = !!duration && rangeEndSec !== null;
    const startPct = show ? pct(rangeStartSec) : 0;
    const endPct = show ? pct(rangeEndSec) : 0;
    forEachSeekBar((sb) => {
      if (!show) {
        sb.handleStartEl.style.display = 'none';
        sb.handleEndEl.style.display = 'none';
        sb.rangeFillEl.style.display = 'none';
        return;
      }
      sb.handleStartEl.style.display = 'block';
      sb.handleEndEl.style.display = 'block';
      sb.handleStartEl.style.left = `${startPct}%`;
      sb.handleEndEl.style.left = `${endPct}%`;
      if (endPct <= startPct) {
        sb.rangeFillEl.style.display = 'none';
      } else {
        sb.rangeFillEl.style.display = 'block';
        sb.rangeFillEl.style.left = `${startPct}%`;
        sb.rangeFillEl.style.width = `${endPct - startPct}%`;
      }
    });
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
  // 実演再生(ヘルプ)の前に退避した再生範囲を戻す。戻す先の曲は実演スニペットのままなので、
  // 表示上の整合は次の通常コンパイル時のpreservePlaybackRange(クランプ)に任せる
  function restoreExternalPlaybackRange() {
    if (!mmlExternalSavedRange) return;
    rangeStartSec = mmlExternalSavedRange.start;
    rangeEndSec = mmlExternalSavedRange.end;
    mmlExternalSavedRange = null;
    rangeEndArmed = true;
    const duration = currentDuration();
    updateRangeMarkersUI(duration);
    updateSeekTicksUI(duration);
    updateMmlRangeHighlight();
  }

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
  function setupRangeHandleDrag(inst, handleEl, which) {
    handleEl.addEventListener('pointerdown', (e) => {
      if (!canSeek()) return;
      const duration = currentDuration();
      if (!duration) return;
      e.preventDefault();
      e.stopPropagation(); // フローティングウィンドウのドラッグ/前面化に取られないようにする
      try { handleEl.setPointerCapture(e.pointerId); } catch (err) { /* キャプチャ不可でも要素上のmoveで追従する */ }
      handleEl.classList.add('dragging');
      mmlHighlightSuppressed = false; // ドラッグ中はハイライトで範囲を視覚的に確認できるようにする

      const onMove = (ev) => {
        const wrapRect = inst.wrapEl.getBoundingClientRect();
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
  setupRangeHandleDrag(seekBars[0], seekHandleStartEl, 'start');
  setupRangeHandleDrag(seekBars[0], seekHandleEndEl, 'end');

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
    stopVgmPlayback();
    stopPsfPlayback();
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
    stopVgmPlayback();
    stopPsfPlayback();
  }

  // duration/再生範囲終了点への到達で自動的に次の曲/トラックへ進む対象かどうか
  // (SPCは1ファイル=1曲のため曲送りの概念が無く、対象外)
  // ★2026-09-18: 'spc' も含める。以前は「SPCは曲送りの概念が無い」として外していたが、曲末(duration/再生範囲の
  //   終了点)に到達した時の分岐 `isSoundFileMode() ? finishSoundFilePlayback() : transportStop()` がSPCだけ
  //   transportStop() に落ち、「同じ曲を繰り返す」やアーカイブの次エントリ送り(archiveAutoAdvanceOrStop)が
  //   効かずに止まっていた(単体SPC・リピート'one'で実測)。finishSoundFilePlayback 自体はSPCを扱える
  function isSoundFileMode() {
    return lastPlayMode === 'nsf' || lastPlayMode === 'kss' || lastPlayMode === 'gbs' || lastPlayMode === 'hes' || lastPlayMode === 'vgm' || lastPlayMode === 'psf' || lastPlayMode === 'spc';
  }
  function isFadeableSoundFileMode() {
    return isSoundFileMode();
  }

  // 曲リストの最後まで達したら先頭(0/最小値)へ戻ってループする「自動送り」版。
  // ボタン操作のchangeXxxSong/Track(クランプ)とは違い、無限に再生が続けられるようラップする。
  // ── 曲が終わった後の挙動(鍵盤表示ヘッダのアイコンで選ぶ) ──────────────────
  //   'next'    … 次の曲(またはアーカイブの次エントリ)へ。従来の挙動
  //   'one'     … 同じ曲を繰り返す
  //   'shuffle' … 同じファイル/アーカイブの中からランダムに選ぶ
  //   'stop'    … 停止する
  function repeatMode() { return keyboardDisplay.getRepeatMode ? keyboardDisplay.getRepeatMode() : 'next'; }
  // モードに応じた次のインデックスを返す(cur/min/maxは曲番号の範囲)。nullなら停止
  function nextIndexFor(cur, min, max) {
    const mode = repeatMode();
    if (mode === 'stop') return null;
    if (mode === 'one') return cur;
    if (mode === 'shuffle' && max > min) {
      let v = cur;
      for (let i = 0; i < 8 && v === cur; i++) v = min + Math.floor(Math.random() * (max - min + 1));
      return v;
    }
    return wrapIndex(cur + 1, min, max);
  }

  function autoAdvanceNsfSong() {
    if (!loadedNsfHeader) return;
    const totalSongs = Math.max(1, loadedNsfHeader.totalSongs);
    const cur = parseInt(nsfSongIndexEl.value, 10) || 1;
    // 「次の曲」でNSFeの再生順(plst)があればその並びで進む。他のモードは曲番号の範囲で選ぶ
    const songNo = (repeatMode() === 'next' && nsfePlaylist(loadedNsfHeader)) ? stepNsfSong(cur, 1) : nextIndexFor(cur, 1, totalSongs);
    if (songNo === null) { updateKeyboardTransport(); return; }
    nsfSongIndexEl.value = String(songNo);
    lastNsfCaptureResult = null;
    playNsfStream();
  }
  function autoAdvanceKssSong() {
    const min = parseInt(kssSongIndexEl.min, 10) || 0;
    const max = parseInt(kssSongIndexEl.max, 10) || 255;
    const v = nextIndexFor(parseInt(kssSongIndexEl.value, 10) || 0, min, max);
    if (v === null) { updateKeyboardTransport(); return; }
    kssSongIndexEl.value = String(v);
    playKssStream();
  }
  function autoAdvanceGbsSong() {
    const min = parseInt(gbsSongIndexEl.min, 10) || 0;
    const max = parseInt(gbsSongIndexEl.max, 10) || 0;
    const v = nextIndexFor(parseInt(gbsSongIndexEl.value, 10) || 0, min, max);
    if (v === null) { updateKeyboardTransport(); return; }
    gbsSongIndexEl.value = String(v);
    playGbsStream();
  }
  function autoAdvanceHesTrack() {
    const hMin = parseInt(hesTrackIndexEl.min, 10) || 0;
    const hMax = parseInt(hesTrackIndexEl.max, 10) || 255;
    const v = nextIndexFor(parseInt(hesTrackIndexEl.value, 10) || 0, hMin, hMax);
    if (v === null) { updateKeyboardTransport(); return; }
    hesTrackIndexEl.value = String(v);
    playHesStream();
  }

  // 1ファイル1曲の形式(SPC/VGM)の再生終了時に、アーカイブ(zip/7z)を開いていれば次のエントリへ
  // 進める(initUnifiedSoundFileWindow内で実体を差し替える。単体ファイルなら何もしない)。
  let archiveAutoAdvanceOrStop = () => {};

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
    else if (mode === 'spc') { stopSpcPlayback(); archiveAutoAdvanceOrStop(); }
    else if (mode === 'vgm') { stopVgmPlayback(); archiveAutoAdvanceOrStop(); }
    else if (mode === 'psf') { stopPsfPlayback(); archiveAutoAdvanceOrStop(); }
    else { transportStop(); }
  }

  // ── 鍵盤表示タイトル行の再生コントロール(⏮ ▶/⏸ ■ ⏭) ─────────────
  // 操作対象はバッジと同じ「今表示している方」(MML再生 / サウンドファイル再生)。
  // どちらの経路も、既にある本体側のボタンと同じ関数へ集約する(挙動を二重に持たない)。
  function updateKeyboardTransport() {
    // 再生開始/停止のたびに、無音判定の有効/無効(ミュート中は無効)を今のプレイヤーへ入れ直す。
    // プレイヤーは曲ごとに作り直されるので、ミュート変更時だけでは間に合わない
    syncSilenceDetect();
    const kind = kbdSourceKind;
    const p = currentTransportPlayer();
    let playing = false, canPlay = false, canStop = false, canPrevNext = false;
    if (!kind || kind === 'mml') {
      // MML再生: btnMmlCapture / btnTransportStop と同じ判定
      playing = !mmlPlaybackStopped && (p ? p.isPlaying : transportPlaying);
      canPlay = true;
      canStop = !mmlPlaybackStopped;
      canPrevNext = false; // MMLには曲送りの概念が無いのでグレーアウト
    } else {
      const active = lastPlayMode === kind && !!p;
      playing = active && p.isPlaying;
      canPlay = true;
      canStop = active;
      // アーカイブ(m3u)を開いていればそのファイル送り、単体ファイルなら曲番号送り
      const songEl = SOUND_FORMAT_SONG_INPUT[kind] ? document.getElementById(SOUND_FORMAT_SONG_INPUT[kind]) : null;
      const multiSong = !!songEl && (parseInt(songEl.max, 10) || 0) > (parseInt(songEl.min, 10) || 0);
      canPrevNext = archiveTrackCount() > 1 || multiSong;
    }
    keyboardDisplay.setTransportState({ playing, canPlay, canStop, canPrevNext, canToggleSource: !!loadedSoundFormat });
    keyboardDisplay.refreshSourceName(); // 曲送り/アーカイブ選択で名前と一覧の現在位置を追随させる
    updateKeyboardExportControls();
    updateMiniTransport({ playing, canPlay, canStop, canPrevNext, kind });
  }

  // ── ミニ操作窓(src/ui/miniTransport.js) ───────────────────────────────
  // 外部エディタで作業中に、ブラウザを前面へ出さずに操作するための小窓。
  // 操作は鍵盤表示タイトル行と同じ関数(keyboardDisplay.onTransport等)へ流すので、
  // ここがやるのは「今の状態を渡す」ことだけ。
  const MiniTransport = MML.UI.MiniTransport;

  // 今鳴っている(鳴らせる)曲の名前。MML側はファイル名、ファイル側は鍵盤表示と同じ文字列
  function currentPlaybackTitle() {
    const kind = kbdSourceKind;
    if (!kind || kind === 'mml') {
      return FileSync.fileName() || currentMmlFileName || T('MML');
    }
    return keyboardDisplay.getSourceName() || String(kind).toUpperCase();
  }

  function updateMiniTransport(s) {
    if (!MiniTransport) return;
    const icon = keyboardDisplay.getRepeatIcon();
    MiniTransport.setState({
      playing: s.playing, canPlay: s.canPlay, canStop: s.canStop, canPrevNext: s.canPrevNext,
      canToggleSource: !!loadedSoundFormat,
      kind: s.kind || 'mml',
      title: currentPlaybackTitle(),
      repeatSvg: icon.svg, repeatLabel: icon.label,
    });
    // チャンネル一覧は小窓を開いているときだけ作る(毎フレーム呼ばれるため)
    if (MiniTransport.isOpen()) MiniTransport.setChannels(keyboardDisplay.getMuteRows());
    updateMediaSession(s.playing);
  }

  function initMiniTransport() {
    if (!MiniTransport) return;
    MiniTransport.init({
      // 操作は全部、鍵盤表示タイトル行と同じ入口へ入れる(二重実装を作らない)
      onAction: (action) => keyboardDisplay.onTransport(action),
      onToggleSource: () => keyboardDisplay.onSourceToggle(),
      onRepeatCycle: () => { keyboardDisplay.cycleRepeatMode(); updateKeyboardTransport(); },
      onMuteToggle: (id) => {
        keyboardDisplay.toggleMuteRow(id);
        MiniTransport.setChannels(keyboardDisplay.getMuteRows());
      },
      makeSeekBar: () => createSeekBarInstance(),
      // 小窓だけで別の曲へ移れるように。実体は鍵盤表示ヘッダの「ファイルを開く」と同じ
      onOpenFile: () => keyboardDisplay.onOpenFile(),
      onCloseChange: (open) => {
        const b = document.getElementById('btnMiniTransport');
        if (b) b.setAttribute('aria-pressed', open ? 'true' : 'false');
        updateKeyboardTransport();
      },
      // 小窓側のタイマーから呼ばれる。本体タブが最小化されると本体のrAFは止まるので、
      // 小窓の表示(時間・シーク位置・ボタンの状態)はこちら側から進める
      onTick: () => {
        const pl = currentTransportPlayer();
        if (pl ? pl.isPlaying : transportPlaying) updateTransportUI();
        else updateKeyboardTransport();
      },
    });
    const btn = document.getElementById('btnMiniTransport');
    if (btn) {
      btn.addEventListener('click', async () => {
        if (MiniTransport.isOpen()) { MiniTransport.close(); return; }
        const res = await openMiniTransport();
        if (res && res.unsupported) {
          mmlFileStatus(T('このブラウザはミニ操作窓(Document Picture-in-Picture)に対応していません。'), 'error');
        } else if (res && res.error) {
          mmlFileStatus(T('ミニ操作窓を開けませんでした: {msg}', { msg: res.error.message || res.error.name }), 'error');
        }
      });
      btn.hidden = !MiniTransport.supported();
    }
    // ★ここで直接 updateKeyboardTransport() を呼ばないこと。この位置はまだ初期化の途中で、
    //   その先の currentTransportPlayer() が未初期化の kssActivePlayer 等に触れて
    //   ReferenceError(TDZ)になる。createSeekBarInstance に同じ注意書きがあるのと同じ理由。
    //   初期状態の反映は初期化が終わってからで間に合う
    setTimeout(updateKeyboardTransport, 0);
  }

  // ★クリックハンドラの中から呼ぶこと。requestWindow はユーザー操作が無いと拒否される
  // (2026-09-12 実測: NotAllowedError "Document PiP requires user activation")。
  // このため「ウィンドウを最小化したら自動で出す」は作れない。再生を押したときに出す方式にしてある
  async function openMiniTransport() {
    const res = await MiniTransport.open();
    if (res && res.ok) {
      MiniTransport.setChannels(keyboardDisplay.getMuteRows());
      updateKeyboardTransport();
    }
    return res;
  }

  // ── OSのメディアコントロール(Media Session) ──────────────────────────
  // Windowsのメディアパネルとメディアキーからの操作を、小窓と同じ入口へ流す。
  // 曲名もそこへ出す。file:// でも動くことは実測済み(2026-09-12)
  let mediaSessionBound = false;
  let lastMediaTitle = '';
  function updateMediaSession(playing) {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!mediaSessionBound) {
      mediaSessionBound = true;
      const bind = (act, fn) => { try { ms.setActionHandler(act, fn); } catch (e) { /* 未対応のアクションは無視 */ } };
      // 再生と一時停止は同じトグル(各形式の再生ボタンが元々トグルなので合わせる)
      bind('play', () => keyboardDisplay.onTransport('play'));
      bind('pause', () => keyboardDisplay.onTransport('play'));
      bind('stop', () => keyboardDisplay.onTransport('stop'));
      bind('previoustrack', () => keyboardDisplay.onTransport('prev'));
      bind('nexttrack', () => keyboardDisplay.onTransport('next'));
    }
    const title = currentPlaybackTitle();
    if (title && title !== lastMediaTitle) {
      lastMediaTitle = title;
      try {
        ms.metadata = new MediaMetadata({
          title,
          artist: T('Sound Emulation Foundry'),
          album: kbdSourceKind && kbdSourceKind !== 'mml' ? String(kbdSourceKind).toUpperCase() : 'MML',
        });
      } catch (e) { /* MediaMetadata が無い環境では曲名を出さないだけ */ }
    }
    const want = playing ? 'playing' : 'paused';
    if (ms.playbackState !== want) ms.playbackState = want;
  }

  // ロール見出しの「演奏最大時間(秒)+出力形式+出力」。サウンドファイルとMML再生の両方で出す
  // (MML再生は 2026-09-19 ユーザー指示で追加。exportMmlAudio 参照)
  function keyboardDurationInput() {
    const id = SOUND_FORMAT_DUR_INPUT[kbdSourceKind];
    return id ? document.getElementById(id) : null;
  }
  // MML再生の書き出し秒数。null = 曲の長さ(ループがあれば1周目の終わりまで)をそのまま使う。
  // ユーザーが欄を書き換えたらその値を保つ(曲を変えても。サウンドファイルの「最大時間」と同じ扱い)
  let mmlExportSeconds = null;
  function mmlDefaultExportSeconds() {
    const c = lastMmlCompiled;
    return c && c.frameRate ? Math.max(1, Math.ceil(c.totalFrames / c.frameRate)) : 60;
  }
  function updateKeyboardExportControls() {
    if (kbdSourceKind === 'mml') {
      keyboardDisplay.setExportControls({ visible: !!lastMmlCompiled,
        seconds: mmlExportSeconds || mmlDefaultExportSeconds(), formats: exportFormatsFor('mml') });
      return;
    }
    const durEl = keyboardDurationInput();
    keyboardDisplay.setExportControls(durEl
      ? { visible: true, seconds: parseInt(durEl.value, 10) || 0, formats: exportFormatsFor(kbdSourceKind) }
      : { visible: false });
  }
  keyboardDisplay.onMaxSecondsChange = (sec) => {
    if (kbdSourceKind === 'mml') { mmlExportSeconds = sec > 0 ? sec : null; return; }
    const durEl = keyboardDurationInput();
    if (durEl) durEl.value = String(sec);
  };
  keyboardDisplay.onExport = (fmtId, sec) => {
    exportMode = ['wav', 'flac', 'aac', 'reglog'].indexOf(fmtId) >= 0 ? fmtId : 'wav';
    if (kbdSourceKind === 'mml') {
      if (sec > 0) mmlExportSeconds = sec;
      exportMmlAudio(sec > 0 ? sec : mmlDefaultExportSeconds()).catch((e) => {
        console.error(e);
        captureOutputEl.innerHTML = '<div class="error">' + escapeHtml(T('書き出しに失敗しました: {msg}', { msg: e && e.message ? e.message : String(e) })) + '</div>';
      });
      return;
    }
    const durEl = keyboardDurationInput();
    if (durEl) durEl.value = String(sec);
    const btn = document.getElementById(SOUND_FORMAT_WAV_BTN[kbdSourceKind] || '');
    if (btn) btn.click(); // 実体は各形式パネルの書き出しボタン(隠してあるだけ)
  };

  // MML再生の書き出し(WAV/FLAC/AAC/レジスタログ、2026-09-19)。MMLをNSFに書き出し、そのNSFを
  // NSFファイルの書き出しと同じ経路(captureSongAsync)で鳴らす。書き出したNSFを再生したときと同じ音・同じ
  // レジスタ書き込みになり、ループ(L)も指定の秒数まで回る。ミュート中のchは鳴らさない(ファイル再生と同じ)
  let mmlExporting = false;
  async function exportMmlAudio(seconds) {
    if (mmlExporting) return;
    const result = MML.Mml.compile(mmlSourceEl.value, getMmlOpt());
    if (result.errors.length > 0) {
      captureOutputEl.innerHTML = '<div class="error">' + escapeHtml(T('MMLコンパイルエラーのため書き出せません:')) + '\n' + renderCompileErrors(result.errors) + '</div>';
      return;
    }
    const meta = result.meta || {};
    const built = MML.Driver.buildBankedNsfBytes(result, {
      songName: meta.title || '', artist: meta.composer || '', copyright: meta.maker || '', totalSongs: 1, startingSong: 1,
    });
    if (built.asmErrors.length > 0) {
      captureOutputEl.innerHTML = '<div class="error">' + escapeHtml(T('ドライバのアセンブルに失敗しました(内部エラー):') + '\n' +
        built.asmErrors.map(e => `[Line ${e.lineNo}] ${e.message}`).join('\n')) + '</div>';
      return;
    }
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const sampleRate = audioCtx.sampleRate;
    const baseName = (meta.title || (currentMmlFileName || 'mml').replace(/\.[^.]*$/, '') || 'mml').replace(/[\\/:*?"<>|]/g, '_');
    mmlExporting = true;
    try {
      captureOutputEl.innerHTML = '<div>' + T('WAV書き出し用レンダリング中…') + '</div>';
      const cap = await MML.Emu.captureSongAsync(built.nsfBytes, {
        songIndex: 0, durationSeconds: seconds, sampleRate, mute: getChannelMuteConfig(true),
      }, (done, total) => {
        captureOutputEl.innerHTML = '<div>' + T('WAV書き出し中… {pct}%', { pct: Math.round(done / total * 100) }) + '</div>';
      });
      let filename;
      if (exportMode === 'reglog') {
        // NSFファイルのレジスタログ(exportNsfWav)と同じ形式: frame,addr,value,chip
        let csv = 'frame,addr,value,chip\n';
        cap.writeLog.forEach((writes, f) => {
          for (const w of writes) {
            csv += `${f},0x${w.addr.toString(16).toUpperCase()},0x${w.value.toString(16).toUpperCase().padStart(2, '0')},${regChipName(w.addr)}\n`;
          }
        });
        filename = baseName + '_regs.csv';
        downloadText(filename, csv);
      } else {
        // NSFファイルの書き出し(exportNsfWav)と同じ gain 3.0
        filename = await downloadExportAudio(baseName, [cap.audio], sampleRate, 3.0, captureOutputEl);
      }
      captureOutputEl.innerHTML = '<div class="ok">' + T('書き出し完了: {file}', { file: escapeHtml(filename) }) + '</div>';
    } finally {
      mmlExporting = false;
    }
  }

  // 鍵盤表示ヘッダへ移した「ファイルを開く」/「to MML」。実体は既存のボタンをそのまま押す。
  // 「開く」はトップのファイルを開くアイコンと同じく、隠し input のダイアログを直接出す
  keyboardDisplay.onOpenFile = () => {
    const fileEl = document.getElementById('soundFile');
    if (fileEl) fileEl.click();
  };
  // 割当セルの「パッド」ボタン → ドラム(DPCM)パネルを開く
  keyboardDisplay.onOpenDrumPanel = () => {
    const w = document.getElementById('win-drums');
    if (w && getComputedStyle(w).display === 'none') {
      const btn = document.querySelector('.toggle-btn[data-target="win-drums"]');
      if (btn) btn.click(); else w.style.display = 'flex';
    }
    // ★表示するだけでは鍵盤表示の背面に隠れる(zIndexは触ったウィンドウほど大きくなり
    //   永続化されるため)。開いたのに何も出てこないように見えるので必ず最前面へ出す
    if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-drums');
    refreshDrumPanel();
  };

  keyboardDisplay.onToMml = () => {
    // 今表示している形式の「MMLへ変換」ボタンを押す
    const id = SOUND_FORMAT_TOMML_BTN[kbdSourceKind];
    const btn = id && document.getElementById(id);
    if (btn) btn.click();
  };

  keyboardDisplay.onTransport = (action) => {
    const kind = kbdSourceKind;
    if (!kind || kind === 'mml') {
      if (action === 'play') document.getElementById('btnMmlCapture').click();
      else if (action === 'stop') transportStop();
      return; // prev/next は MML では無効(ボタン自体もグレーアウトしている)
    }
    if (action === 'play') {
      const btn = document.getElementById(SOUND_FORMAT_PLAY_BTN[kind]);
      if (btn) btn.click(); // 各形式の再生ボタン = 再生/一時停止のトグル
      return;
    }
    if (action === 'stop') {
      const btn = document.getElementById(SOUND_FORMAT_STOP_BTN[kind]);
      if (btn) btn.click(); // 停止に伴うボイスモニタ停止/setMode('nsf')もパネル側と同じにする
      updateKeyboardTransport();
      return;
    }
    const delta = action === 'next' ? 1 : -1;
    if (archiveTrackCount() > 1) archiveChangeTrack(delta);
    else if (kind === 'nsf') changeNsfSong(delta);
    else if (kind === 'kss') changeKssSong(delta);
    else if (kind === 'gbs') changeGbsSong(delta);
    else if (kind === 'hes') changeHesTrack(delta);
  };

  // バッジ(ファイル名)クリック: MML再生 ↔ サウンドファイル再生の切り替え。
  // どちらも「相手を止めて自分を再生する」経路(prepareMmlStream / 各形式の再生ボタン)を
  // そのまま使うので、鍵盤表示・ピアノロール・シークバーも一緒に切り替わる。
  // サウンドファイルを一度も開いていなければ切り替え先が無いので何もしない。
  // 鍵盤表示タイトル行のファイル名ボタン: 表示する名前と、クリックで選べる曲一覧。
  // アーカイブ(m3u)ならリスト名+エントリ一覧、複数曲形式(NSF/KSS/GBS/HES)ならファイル名+曲番号、
  // 1ファイル1曲ならファイル名だけ。MML側はタイトル(setKbdSourceの名前)をそのまま使う
  keyboardDisplay.onSourceListRequest = () => {
    if (!kbdSourceKind || kbdSourceKind === 'mml') return null;
    const ai = archiveInfo();
    // アーカイブ(m3u)はzipのファイル名ではなく「いま選ばれている曲名」を出す(ユーザー指定 2026-09-06)。
    // リスト名はツールチップへ
    if (ai && ai.titles.length > 1) return { name: ai.titles[ai.index] || ai.name, listName: ai.name, items: ai.titles, index: ai.index };
    const fmt = loadedSoundFormat;
    const fileName = (ai && ai.name) || fileInputName(document.getElementById('soundFile'))
      || (fmt ? fileInputName(document.getElementById(fmt + 'File')) : '') || '';
    const songEl = SOUND_FORMAT_SONG_INPUT[fmt] ? document.getElementById(SOUND_FORMAT_SONG_INPUT[fmt]) : null;
    if (songEl) {
      const min = parseInt(songEl.min, 10) || 0, max = parseInt(songEl.max, 10);
      if (Number.isFinite(max) && max > min) {
        const items = [];
        for (let n = min; n <= max; n++) {
          const label = (fmt === 'nsf' && loadedNsfHeader) ? MML.NSF.trackLabel(loadedNsfHeader, n - 1) : null; // NSFeの曲ラベル(tlbl)
          items.push(label ? `${n}. ${label}` : T('曲 {n}', { n }));
        }
        return { name: fileName, items, index: (parseInt(songEl.value, 10) || min) - min };
      }
    }
    return { name: fileName, items: null, index: 0 };
  };
  keyboardDisplay.onSourceSelect = (i) => {
    const ai = archiveInfo();
    if (ai && ai.titles.length > 1) { archiveSelectTrack(i); return; }
    const fmt = loadedSoundFormat;
    const songEl = SOUND_FORMAT_SONG_INPUT[fmt] ? document.getElementById(SOUND_FORMAT_SONG_INPUT[fmt]) : null;
    if (!songEl) return;
    const min = parseInt(songEl.min, 10) || 0;
    songEl.value = String(min + i);
    songEl.dispatchEvent(new Event('change')); // 各形式の曲番号欄の change ハンドラが停止→再生まで行う
  };
  keyboardDisplay.onSourceToggle = () => {
    if (!loadedSoundFormat) return;
    if (!kbdSourceKind || kbdSourceKind === 'mml') {
      const btn = document.getElementById(SOUND_FORMAT_PLAY_BTN[loadedSoundFormat]);
      if (btn) btn.click();
    } else {
      runMmlStream(); // 内部でtransportStop()+stopAllFormatPlayback()してからMMLを鳴らす
    }
  };

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
      if (MML.UI.MetronomePanel) MML.UI.MetronomePanel.requestPlaybackSync();
      updateFormatPlayButtons();
      scheduleTransportUi();
      return;
    }
    if (!capturedBuffer) return;
    if (transportPlaying) return;
    if (transportOffset >= capturedBuffer.duration) transportOffset = 0;

    const source = audioCtx.createBufferSource();
    source.buffer = capturedBuffer;
    source.connect(MML.Audio.getMasterGain(audioCtx));
    source.start(0, transportOffset);
    transportSource = source;
    transportStartTime = audioCtx.currentTime;
    transportPlaying = true;
    scheduleTransportUi();
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
    clearMmlPlaybackHighlight();
    if (mmlExternalSourceOnEnded) { const fn = mmlExternalSourceOnEnded; mmlExternalSourceOnEnded = null; try { fn(); } catch (e) { console.error(e); } }
    mmlPlaybackStopped = true;
    // ヘルプの実演再生(外部ソース)だった場合は、退避しておいたユーザーの再生範囲を戻す。
    // 範囲を戻すのは停止位置を決めた後(復元後のrangeStartSecへシークすると、
    // 実演スニペットの長さを超えた位置へ飛んでしまうため)
    const wasExternal = mmlExternalSavedRange !== null;
    // 停止後は曲頭(0)ではなく再生範囲の開始点に戻る（開始点未設定時は従来通り0）
    const restoreTo = wasExternal ? 0 : (rangeStartSec || 0);
    if (wasExternal) restoreExternalPlaybackRange();
    const p = currentTransportPlayer();
    if (p) {
      p.stop();
      if (restoreTo > 0 && (lastPlayMode === 'capture-mml' || lastPlayMode === 'nsf' || lastPlayMode === 'kss' || lastPlayMode === 'spc' || lastPlayMode === 'gbs' || lastPlayMode === 'hes' || lastPlayMode === 'vgm' || lastPlayMode === 'psf')) {
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
      if (lastPlayMode !== 'capture-mml' && lastPlayMode !== 'nsf' && lastPlayMode !== 'kss' && lastPlayMode !== 'spc' && lastPlayMode !== 'gbs' && lastPlayMode !== 'hes' && lastPlayMode !== 'vgm' && lastPlayMode !== 'psf') return;
      const wasPlaying = p.isPlaying;
      p.pause();
      p.seek(Math.round(Math.max(0, Math.min(workletDuration, seconds)) * audioCtx.sampleRate));
      if (wasPlaying) {
        p.play();
        // 曲の位置が飛んだので、メトロノームは新しい拍へ合わせ直す
        if (MML.UI.MetronomePanel) MML.UI.MetronomePanel.requestPlaybackSync();
        scheduleTransportUi();
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

  // 秒(現在の再生速度での実時間。シークバー/transportSeek()と同じ単位)へシークする共通入口。
  // シークバーの入力と鍵盤表示のピアノロールをドラッグしてのシーク(keyboardDisplay.onRollSeek)の
  // 両方から呼ぶ。範囲(0〜再生時間)と、NSF/KSS/SPC等の実ファイル再生ではバックグラウンド
  // キャプチャが追いついた範囲(currentBufferedFraction)にクランプし、実際にシークした秒を返す。
  // シークできる状態でなければ何もせず null を返す。
  function seekToSeconds(seconds) {
    if (currentTransportPlayer()) {
      if (lastPlayMode !== 'capture-mml' && lastPlayMode !== 'nsf' && lastPlayMode !== 'kss' && lastPlayMode !== 'spc' && lastPlayMode !== 'gbs' && lastPlayMode !== 'hes' && lastPlayMode !== 'vgm' && lastPlayMode !== 'psf') return null;
      let sec = Math.max(0, Math.min(workletDuration, seconds));
      // プレイヤー側の内部クランプ(NsfReplayStreamPlayer.seek()等)だけに任せると、ユーザーが
      // バッファより先へ動かした「つもり」のまま実際は手前へ戻っていて無音になり「シークすると
      // 止まる」ように見えるため、ここでバッファ済み範囲より先へは行かせない。
      const bufferedFrac = currentBufferedFraction();
      if (bufferedFrac !== null && workletDuration > 0 && sec > bufferedFrac * workletDuration) {
        sec = bufferedFrac * workletDuration;
      }
      transportSeek(sec);
      return sec;
    }
    if (!capturedBuffer) return null;
    const sec = Math.max(0, Math.min(capturedBuffer.duration, seconds));
    transportSeek(sec);
    return sec;
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

  // --- @DPCM<n>参照ファイルの台帳 ---
  // ファイル名(@DPCM<n>={"file",...}の"file")をキーにエンコード済みバイト列を持つ
  // (compiler.jsのopt.dpcmSamples[filename]と対応)。入口は2つ:
  //   ・DPCMコンバータ(src/ui/dpcmEditor.js)で「反映」したもの
  //   ・*2mml変換が出力した .dmc(setDpcmSampleBytes。ファイル再選択なしで即再生/NSF書き出しできる)
  // 以前はMMLエディタ下部に「参照ファイルの選択UI」があったが、コンバータへ統合した
  // (定義をダブルクリック→行の📂で読み込む→反映)。
  const dpcmSampleCache = {};
  function setDpcmSampleBytes(name, bytes) {
    dpcmSampleCache[name] = bytes;
    MML.UI.DpcmStore.put(name, bytes); // 開き直しても戻るように(src/ui/dpcmStore.js)
    if (MML.UI.DpcmEditor && MML.UI.DpcmEditor.refresh) MML.UI.DpcmEditor.refresh();
  }
  // MML本文を丸ごと差し替えたとき(ファイルを開く/変換結果)に呼ぶ。コンバータが持つ未反映の音は捨てる
  function resetDpcmEditor() {
    if (MML.UI.DpcmEditor && MML.UI.DpcmEditor.reset) MML.UI.DpcmEditor.reset();
  }

  // ── @DPCM の .dmc を「開き直しても戻る」「保存したら隣に置く」(2026-09-16、src/ui/dpcmStore.js) ──
  // 保存形式は変えない(.mml はテキストのみ、.dmc は隣 = ppmck 運用)。台帳の中身を IndexedDB に写し、
  // .mml を開いたときに参照名で引き戻す。以前は *2mml 変換のたびに .dmc を Downloads へ落としていたが、
  // .mml と別の場所に散らばって開き直すと E が無音になっていた。
  const DpcmStore = MML.UI.DpcmStore;
  function isDmcFile(f) { return !!f && /\.dmc$/i.test(f.name || ''); }

  // *2mml 変換が出した .dmc を台帳へ(ダウンロードはしない。保存時に afterMmlSaved が同じフォルダへ書く)
  function takeDpcmFiles(files) {
    const list = files || [];
    for (const f of list) setDpcmSampleBytes(f.name, f.bytes);
    if (list.length) {
      const d = document.createElement('div');
      d.textContent = T('DPCM {n} 本を台帳に入れました(.dmc は MML を保存したときに同じフォルダへ書き出せます)', { n: list.length });
      mmlOutputEl.appendChild(d);
    }
    return list.length;
  }

  // 開いた/ドロップした .dmc(File)を台帳へ。戻り値は入れた名前
  async function loadDmcFiles(files) {
    const names = [];
    for (const f of (files || []).filter(isDmcFile)) {
      try { setDpcmSampleBytes(f.name, new Uint8Array(await f.arrayBuffer())); names.push(f.name); }
      catch (e) { /* 読めないものは飛ばす */ }
    }
    return names;
  }

  // 本文が参照する @DPCM のうち台帳に無いものを IndexedDB から戻す
  async function restoreDpcmSamples(text) {
    const names = DpcmStore.namesIn(text);
    if (!names.some(n => !dpcmSampleCache[n])) return { restored: [], missing: [] };
    const r = await DpcmStore.restore(names, dpcmSampleCache);
    if (r.restored.length && MML.UI.DpcmEditor && MML.UI.DpcmEditor.refresh) MML.UI.DpcmEditor.refresh();
    return r;
  }

  // .dmc だけを開いた/ドロップしたとき(MML本文はそのまま)
  async function openDmcOnly(files) {
    const names = await loadDmcFiles(files);
    if (!names.length) return false;
    ensureMmlWindowOpen();
    const referenced = DpcmStore.namesIn(mmlSourceEl.value);
    const used = names.filter(n => referenced.includes(n));
    mmlFileStatus(T('DPCM を読み込みました: {files}', { files: names.join(', ') }) +
      (used.length ? '' : ' ' + T('(今の MML はこのファイルを参照していません)')), 'ok');
    // 参照している定義があれば「未読込」の警告を消すためにコンパイルし直す。再生中は止めない
    if (used.length && mmlPlaybackStopped) prepareMmlStream(true);
    return true;
  }

  // 本文が参照していて台帳にある .dmc → [{name, bytes}]
  function referencedDpcmFiles(text) {
    return DpcmStore.namesIn(text).filter(n => dpcmSampleCache[n]).map(n => ({ name: n, bytes: dpcmSampleCache[n] }));
  }

  // 開いた直後のステータスに DPCM の内訳を添える
  function appendDpcmOpenInfo(loadedNames, r) {
    const add = (text, cls) => { const d = document.createElement('div'); d.className = cls || ''; d.textContent = text; mmlOutputEl.appendChild(d); };
    if (loadedNames && loadedNames.length) add(T('DPCM {n} 本を一緒に読み込みました', { n: loadedNames.length }));
    if (r && r.restored.length) add(T('DPCM {n} 本を前回の内容から復元しました', { n: r.restored.length }));
    if (r && r.missing.length) add(T('⚠ 見つからない .dmc: {files}(該当する音は鳴りません。.dmc を MML と一緒に開くか、ウィンドウへドロップしてください)', { files: r.missing.join(', ') }), 'error');
  }

  // MML を保存した直後: 参照している .dmc を同じフォルダへ。覚えているフォルダに今の .mml が居れば黙って書き、
  // そうでなければ「フォルダを選んで書く」ボタンをステータス欄に出す(ピッカーは1クリックに1回しか開けないので、
  // 保存ダイアログの直後に続けてフォルダ選択を出すことはできない)
  async function afterMmlSaved(fileHandle, text) {
    const files = referencedDpcmFiles(text);
    const missing = DpcmStore.namesIn(text).filter(n => !dpcmSampleCache[n]);
    if (!files.length && !missing.length) return;
    let res = null;
    if (fileHandle && files.length) res = await DpcmStore.writeBeside(fileHandle, files);
    const box = document.createElement('div');
    if (res && res.written.length) {
      box.className = 'ok';
      box.textContent = T('.dmc {n} 本を同じフォルダ({dir})へ書き出しました', { n: res.written.length, dir: res.dirName }) +
        (res.failed.length ? ' ' + T('(書けなかったもの: {files})', { files: res.failed.join(', ') }) : '');
    } else if (files.length) {
      box.textContent = T('この MML は .dmc {n} 本を参照しています。', { n: files.length }) + ' ';
      const btn = document.createElement('button');
      btn.className = 'secondary';
      if (DpcmStore.dirSupported()) {
        btn.textContent = T('.dmc を MML と同じフォルダへ書き出す');
        btn.addEventListener('click', async () => {
          const r = await DpcmStore.pickAndWrite(fileHandle || undefined, files);
          if (!r) { mmlFileStatus(T('.dmc を書き出せませんでした(フォルダが選ばれなかったか、書き込みが許可されませんでした)。'), 'error'); return; }
          mmlFileStatus(T('.dmc {n} 本を {dir} へ書き出しました', { n: r.written.length, dir: r.dirName }) +
            (r.failed.length ? ' ' + T('(書けなかったもの: {files})', { files: r.failed.join(', ') }) : ''), 'ok');
        });
      } else {
        btn.textContent = T('.dmc をダウンロード');
        btn.addEventListener('click', () => { for (const f of files) downloadBin(f.name, f.bytes); });
      }
      box.appendChild(btn);
    }
    if (missing.length) {
      const m = document.createElement('div');
      m.className = 'error';
      m.textContent = T('⚠ 台帳に無い .dmc: {files}(この MML だけでは鳴りません。DPCMコンバータで読み込むか、.dmc をドロップしてください)', { files: missing.join(', ') });
      box.appendChild(m);
    }
    mmlOutputEl.appendChild(box);
  }
  if (MML.UI.DpcmEditor) {
    MML.UI.DpcmEditor.init(mmlSourceEl, {
      getSample: (name) => dpcmSampleCache[name] || null,
      setSample: (name, bytes) => { dpcmSampleCache[name] = bytes; MML.UI.DpcmStore.put(name, bytes); },
      onApplied: () => { if (MML.UI.DrumPanel) MML.UI.DrumPanel.render(); },
    });
  }

  // --- Phase 4: MMLコンパイラ ---
  // *2MML変換結果の音程検証(result.pitchCheck、src/convert/verify.js)をステータス欄用HTMLに
  // 整形し、ロールへ赤マーカー(keyboardDisplay.setConversionDiffs)も渡す共通ヘルパー。
  // 全フォーマットの「MML変換完了」ステータスの直後に足して使う。
  // compile()のwarnings(音域外で鳴らない箇所)をHTML化する。errorsと違い再生は続行する
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // コンパイルエラー一覧を「[Line N] メッセージ」形式のHTMLにする。[Line N]はクリックで
  // エディタのその行へ移動できる(MML.UI.EditorLineInfo.gotoLine、下のクリック委譲参照)。
  // メッセージにはMML本文の断片("チャンネル指定が認識できません: ..."等)が入るので必ずエスケープする
  function renderCompileErrors(errors) {
    return errors.map(e => (e.lineNo
      ? `<span class="mml-err-line" data-line="${e.lineNo}" title="${T('クリックでエディタのこの行へ移動')}">[Line ${e.lineNo}]</span> `
      : '') + escapeHtml(e.message)).join('\n');
  }
  for (const el of [mmlOutputEl, captureOutputEl]) {
    el.addEventListener('click', (ev) => {
      const t = ev.target.closest && ev.target.closest('.mml-err-line');
      if (t) MML.UI.EditorLineInfo.gotoLine(Number(t.dataset.line));
    });
  }

  // ログ欄2枚(上=コンパイル/ファイル操作の結果、下=再生準備)は中身があるときだけ見せる。
  // 空のままだと「何も出ない枠」がエディタの下に居座って場所を食うため(ユーザー指摘 2026-09-11)。
  // 両方とも空ならスプリッターごと下ペインを畳み、エディタが高さを全部使う。
  // 畳むのは [hidden] 属性 + style.css の .mml-log-area[hidden] 等(下ペインのdisplay:flexに勝たせる)
  const mmlLogSplitterEl = document.getElementById('mmlLogSplitter');
  const mmlBottomPaneEl = document.querySelector('.mml-bottom-pane');
  function syncMmlLogVisibility() {
    let anyContent = false;
    for (const el of [mmlOutputEl, captureOutputEl]) {
      const has = el.childNodes.length > 0 && el.textContent.trim().length > 0;
      el.hidden = !has;
      if (has) anyContent = true;
    }
    if (mmlBottomPaneEl) mmlBottomPaneEl.hidden = !anyContent;
    if (mmlLogSplitterEl) mmlLogSplitterEl.hidden = !anyContent;
  }
  for (const el of [mmlOutputEl, captureOutputEl]) {
    new MutationObserver(syncMmlLogVisibility)
      .observe(el, { childList: true, characterData: true, subtree: true });
  }
  syncMmlLogVisibility();

  function renderCompileWarnings(warnings) {
    if (!warnings || !warnings.length) return '';
    return '<div class="error">' +
      warnings.map(w => '⚠ ' + (typeof w === 'string' ? w : w.message)).join('<br>') + '</div>';
  }

  function renderPitchCheck(pc) {
    keyboardDisplay.setConversionDiffs(pc && pc.diffs || []);
    if (!pc) return '';
    const warn = renderCompileWarnings(pc.warnings);
    if (pc.error) return warn + '<div>' + T('音程チェック: 実行不可 ({msg})', { msg: pc.error }) + '</div>';
    if (!pc.diffs || pc.diffs.length === 0) {
      return warn + '<div>' + T('音程チェック: 一致 ({n} 音符を検証)', { n: pc.checked }) + '</div>';
    }
    const nn = MML.Convert.verifyNoteName;
    const lines = pc.diffs.slice(0, 10).map(d =>
      `<div>${d.sec.toFixed(1)}s ${d.letter}: ${nn(d.expected)} → ${nn(d.got)}</div>`).join('');
    const more = pc.diffs.length > 10 ? '<div>' + T('…他 {n} 件', { n: pc.diffs.length - 10 }) + '</div>' : '';
    return warn + '<div class="error">' +
      T('⚠ 音程不一致 {n} 件 (元の高さと違う音で鳴ります。ロールの赤枠が該当箇所)', { n: pc.diffs.length }) +
      lines + more + '</div>';
  }

  // *2MML変換の基準ピッチ自動検出(result.tuning、src/convert/options.js autoTune)のステータス行。
  // 適用したときだけ出す(閾値未満・固定指定のときは従来と同じ出力なので何も言わない)
  // 適用しなかったときも「測った結果と理由」を必ず出す(不適用=無風ではなく、二極化や閾値未満で
  // 見送ったことがユーザーに見えるように)。内訳はチャンネル文字の群ごとの中央値(G-L=OPLL/VRC7,
  // X-Z=PSG/FME7 …)で、「OPLLは+9だがPSGは-2」のような基準の食い違いを読めるようにする。
  function renderTuning(t) {
    if (!t) return '';
    const fmt = MML.Convert.formatTuningCents;
    const detail = (t.count ? T('偏差の中央値 {median} cent、四分位範囲 {iqr}、音符 {n} 個', { median: fmt(t.median || 0), iqr: (t.iqr || 0).toFixed(1), n: t.count }) : T('音符が無いため測れません'));
    const groups = (t.byGroup || []).filter(g => g.count > 0).map(g => `${g.group} ${fmt(g.median)} (${g.count})`).join(' / ');
    const groupsHtml = groups ? '<div class="cs-desc">' + T('内訳(チャンネル群ごとの中央値)') + ': ' + groups + '</div>' : '';
    // 音名別(変換設定 TUNING='note'、#TUNING-NOTE)。音名ごとの中央値(音符数)を並べ、採用した音名を示す
    if (t.mode === 'note') {
      const names = MML.Convert.PITCH_CLASS_NAMES;
      const perPc = (t.perPc || []).filter(p => p.count > 0)
        .map(p => `${names[p.pc]} ${fmt(p.median)} (${p.count})${t.notes && t.notes[p.pc] ? '*' : ''}`).join(' / ');
      const perPcHtml = perPc ? '<div class="cs-desc">' + T('音名ごとの中央値(* = 補正した音名)') + ': ' + perPc + '</div>' : '';
      if (t.notes || t.cents) {
        const list = (t.notes || []).map((c, pc) => (c ? `${names[pc]} ${fmt(c)}` : null)).filter(Boolean).join(', ') || '-';
        return '<div>' + T('音名別チューニング: 全体 {cents} cent(#TUNING)、外れた音名 {list} cent(#TUNING-NOTE)で補正しました', { cents: fmt(t.cents || 0), list }) + '</div>' + perPcHtml;
      }
      return '<div>' + T('音名別チューニング: 補正が必要な音名はありません') + '</div>' + perPcHtml;
    }
    if (t.cents) {
      const hz = (440 * Math.pow(2, t.cents / 1200)).toFixed(1);
      return '<div>' + T('基準ピッチ: 12平均律から {cents} cent (A4={hz}Hz) のずれを検出し、#TUNING で補正しました', { cents: fmt(t.cents), hz }) + ' (' + detail + ')</div>' + groupsHtml;
    }
    const reasons = {
      fixed: T('12平均律固定の設定なので補正しません'),
      few: T('音符が少なすぎるため補正しません'),
      iqr: T('偏差のばらつきが大きく(四分位範囲が30 cent 超)、曲全体の基準ずれとは言えないため補正しません'),
      fit: T('補正すると ±10 cent に乗る音符の割合が {before}→{after} に下がる(チップや区間で基準が食い違っている)ため補正しません', { before: (t.fitBefore || 0).toFixed(2), after: (t.fitAfter || 0).toFixed(2) }),
      below: T('最小偏差 {min} cent 未満なので補正しません', { min: t.minCents != null ? t.minCents : MML.Convert.TUNING_MIN_DEFAULT }),
    };
    return '<div>' + T('基準ピッチ: {detail} → 補正なし。{reason}', { detail, reason: reasons[t.reason] || '' }) + '</div>' + groupsHtml;
  }

  function getMmlOpt() {
    return {
      fdsWave: MML.WaveformEditor.getFdsWave(),
      n163Wave: MML.WaveformEditor.getN163Wave(),
      mute: getChannelMuteConfig(),
      dpcmSamples: dpcmSampleCache
    };
  }

  // MMLをコンパイルし、ppmck方式バイトコード(src/nsf/mckBytecode.js)+
  // 専用ドライバ(src/driver/ppmckDriver.js)経由でNSFファイルとして書き出す。
  // 2A03(A-D)+DPCM+VRC6/MMC5/FME7/FDS/N163/VRC7に対応(ROADMAP.mdフェーズ1.6/1.7。
  // 未対応の拡張音源が指定された場合はbuilt.unsupportedExpansionsで警告表示する)。
  // --- MMLテキストファイルの読み書き ---------------------------------------
  // 保存形式はプレーンテキスト(拡張子.mml)。ppmck等の外部ツールがそのまま読める
  // ようにMML本文以外のものは一切足さない(DESIGN.md INV-2「MMLテキストが正典」)。
  // 読み込みは.mml/.txtの両方を受け付ける(中身は同じテキストで、拡張子だけが違う
  // 運用が多いため)。
  let currentMmlFileName = '';   // 直近に開いた/保存したファイル名(保存ダイアログの既定値)
  let lastSyncedMmlText = null;  // 直近に開いた/保存した時点の本文。未保存の編集検出に使う

  function markMmlTextSynced(name) {
    if (name) currentMmlFileName = name;
    lastSyncedMmlText = mmlSourceEl.value;
  }

  // 「開く」で現在の内容を捨ててよいか。起動直後のサンプルMMLは未編集なら黙って
  // 捨ててよいので、初期値もsynced扱いにしておく(init時にmarkMmlTextSynced()を呼ぶ)
  function confirmDiscardMmlEdits() {
    if (lastSyncedMmlText === null || mmlSourceEl.value === lastSyncedMmlText) return true;
    return window.confirm(T('MMLエディタの内容が変更されています。保存せずに破棄して開きますか？'));
  }

  // *2MML変換でエディタの本文が別の曲に差し替わったときに、前の曲から引き継いではいけない
  // ものをまとめて捨てる(ユーザー指摘 2026-09-16)。呼ぶのは各 run*2Mml の本文差し替え直前。
  //  ・上のログ欄: 前の曲の読み込み/取り込みメッセージ(MusicXML取り込みの要約と注意など)が
  //    残ると新しい曲の話に見えてしまう。下のcaptureOutputEl側は直後のprepareMmlStream()が
  //    書き直すのでここでは触らない
  //  ・ファイル名: 保存ダイアログの既定値。前の曲の名前のまま上書きさせない(空=song.mml)
  //  ・外部エディタ同期: 変換結果は前のファイルの内容ではないので、黙って上書きしないよう切る
  //    (MusicXML取り込みと同じ扱い)。lastSyncedMmlTextは前の曲のまま=未保存扱いにしておき、
  //    次に「開く」でこの変換結果を捨てるときは確認を出す
  function resetMmlForNewSong() {
    mmlOutputEl.innerHTML = '';
    currentMmlFileName = '';
    FileSync.detach();
  }

  function mmlFileStatus(text, cls) {
    mmlOutputEl.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = cls || '';
    msg.textContent = text;
    mmlOutputEl.appendChild(msg);
  }

  // win-mmlはdata-always-visible="true"だがユーザーが閉じている場合がある。
  // トグルボタンのclick()経由にすると「閉じる」方向に働くことがあるため直接表示する
  // (initUnifiedSoundFileWindow内のensureKeyboardWindowOpenと同じ理由・同じ手口)。
  // ★MMLファイルを開いたときの行き先はここ(ユーザー指示 2026-09-10:
  //   「MMLファイルならMMLエディタを開いて何もしない」)
  function ensureMmlWindowOpen() {
    const win = document.getElementById('win-mml');
    if (!win) return;
    if (win.style.display === 'none') {
      win.style.display = 'flex';
      const btn = document.querySelector('.toggle-btn[data-target="win-mml"]');
      if (btn) btn.classList.add('active');
    }
    // 表示するだけでは他のウィンドウの背面に隠れることがあるので必ず最前面へ出す
    if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-mml');
  }

  // .mml/.txtを読み込んでMMLエディタへ展開する。ファイル選択ダイアログ・
  // ドラッグ&ドロップ・トップのファイルを開くアイコンの3経路から共通で呼ばれる
  // handle(FileSystemFileHandle)を渡すと、そのファイルを外部エディタと同期する対象として
  // 接続する(src/ui/fileSync.js)。渡されなければ同期は切る(=ただの読み込み)
  // extraFiles: 一緒に選ばれた/ドロップされた File のうち .dmc を台帳へ入れる(src/ui/dpcmStore.js)
  async function openMmlTextFile(file, handle, extraFiles) {
    if (!file) return false;
    if (!confirmDiscardMmlEdits()) return false;
    // 楽譜(MusicXML/.mxl)なら MML に取り込む(src/score/musicxmlImport.js)。外部エディタ同期は付けない
    if (/\.(musicxml|xml|mxl)$/i.test(file.name)) return openMusicXmlFile(file);
    let text;
    try {
      text = await file.text();
    } catch (e) {
      mmlFileStatus(T('MMLファイルの読み込みに失敗しました: {msg}', { msg: e.message }), 'error');
      return false;
    }
    ensureMmlWindowOpen();
    mmlSourceEl.value = text;
    mmlSourceEl.dispatchEvent(new Event('input')); // シンタックスハイライト更新
    markMmlTextSynced(file.name);
    resetDpcmEditor();
    const dmcLoaded = await loadDmcFiles(extraFiles);
    const dpcmInfo = await restoreDpcmSamples(text);

    // 別の曲を読み込んだので、前の曲の再生範囲(青/赤ハンドル)は引き継がない
    // (NSF2MML等の変換直後と同じ扱い。[[mml-conversion-stale-playback-range-bug]])
    rangeStartSec = 0;
    rangeEndSec = null;
    prepareMmlStream(true);
    if (handle) await FileSync.attach(handle, file, text); else FileSync.detach();
    mmlFileStatus(T('MMLファイルを読み込みました: {file} ({n}バイト)',
      { file: file.name, n: text.length }), 'ok');
    appendDpcmOpenInfo(dmcLoaded, dpcmInfo);
    return true;
  }

  // MusicXML(.musicxml/.xml/.mxl)を MML に取り込んでエディタへ。取り込みの要約と警告は MML 出力欄へ
  async function openMusicXmlFile(file) {
    let result;
    try {
      result = await MML.Score.importMusicXMLBytes(new Uint8Array(await file.arrayBuffer()), file.name, {});
    } catch (e) {
      mmlFileStatus(T('楽譜(MusicXML)の取り込みに失敗しました: {msg}', { msg: e.message }), 'error');
      return false;
    }
    ensureMmlWindowOpen();
    mmlSourceEl.value = result.mml;
    mmlSourceEl.dispatchEvent(new Event('input')); // シンタックスハイライト更新
    markMmlTextSynced(file.name.replace(/\.(musicxml|xml|mxl)$/i, '.mml'));
    FileSync.detach();
    resetDpcmEditor();
    rangeStartSec = 0;
    rangeEndSec = null;
    prepareMmlStream(true);
    const info = result.info;
    let msg = T('楽譜を取り込みました: {file} ({parts}パート / {lines}行 → {channels})', {
      file: file.name, parts: info.parts.length, lines: info.lines, channels: info.channels.map(c => c.letter).join('') || '-' });
    if (info.expansions.length) msg += ' ' + T('(拡張音源: {chips})', { chips: info.expansions.map(s => s.toUpperCase()).join(', ') });
    mmlFileStatus(msg, 'ok');
    if (result.warnings.length) {
      const w = document.createElement('div');
      w.className = 'warn';
      w.textContent = T('取り込みの注意:') + '\n' + result.warnings.join('\n');
      mmlOutputEl.appendChild(w);
    }
    return true;
  }

  // 保存。File System Access API(showSaveFilePicker)があれば保存先とファイル名を
  // 選べる本物の保存ダイアログを出し、無いブラウザでは従来どおりダウンロードに落とす
  async function saveMmlFile(opts) {
    const text = mmlSourceEl.value;
    const suggestedName = currentMmlFileName
      ? currentMmlFileName.replace(/\.[^.]*$/, '') + '.mml'
      : 'song.mml';
    // 外部エディタと同期中のファイルがあれば、そこへ黙って上書きする(テキストエディタの
    // 「上書き保存」と同じ挙動)。保存先を選び直したいときは opts.saveAs で下のピッカーへ回す。
    // Chromeの書き込み権限ダイアログはこのファイルへの初回保存時に1度だけ出る
    if (!(opts && opts.saveAs) && FileSync.isConnected()) {
      const res = await FileSync.write(text);
      if (res.ok) {
        markMmlTextSynced(FileSync.fileName());
        mmlFileStatus(T('MMLファイルを保存しました: {file} ({n}バイト)',
          { file: FileSync.fileName(), n: text.length }), 'ok');
        await afterMmlSaved(FileSync.currentHandle(), text);
        return;
      }
      if (res.denied) {
        mmlFileStatus(T('書き込みが許可されなかったため保存できませんでした。'), 'error');
        return;
      }
      // それ以外の失敗(ファイルが消えた等)は下の「保存先を選ぶ」経路へ落とす
    }
    if (window.showSaveFilePicker) {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: T('MMLファイル'), accept: { 'text/plain': ['.mml', '.txt'] } }]
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return; // ユーザーがキャンセルした
        handle = null; // 権限拒否等: 下のダウンロードへフォールバック
      }
      if (handle) {
        try {
          const writable = await handle.createWritable();
          await writable.write(new Blob([text], { type: 'text/plain;charset=utf-8' }));
          await writable.close();
          markMmlTextSynced(handle.name);
          // 保存した先をそのまま同期対象にする(以後この曲は外部エディタと往復できる)
          await FileSync.attach(handle, null, text);
          mmlFileStatus(T('MMLファイルを保存しました: {file} ({n}バイト)',
            { file: handle.name, n: text.length }), 'ok');
          await afterMmlSaved(handle, text);
        } catch (e) {
          mmlFileStatus(T('MMLファイルの保存に失敗しました: {msg}', { msg: e.message }), 'error');
        }
        return;
      }
    }
    downloadText(suggestedName, text);
    markMmlTextSynced(suggestedName);
    mmlFileStatus(T('MMLファイルを保存しました: {file} ({n}バイト)',
      { file: suggestedName, n: text.length }), 'ok');
    await afterMmlSaved(null, text);
  }

  // --- 外部テキストエディタとの同期 (src/ui/fileSync.js) ---------------------
  // MMLの正本をディスク上の.mmlに置いたまま、使い慣れたテキストエディタで編集してもらう
  // ための配線。ディスク側が正で、エディタ側に未保存の変更があるときだけ判断を仰ぐ。
  // 同期の仕組み・file://での可否・権限の挙動はすべて fileSync.js 冒頭に書いてある。
  const FileSync = MML.UI.FileSync;

  // 外部で保存された本文をエディタへ反映する。「開き直し」ではなく「同じ曲の更新」なので、
  // カーソル位置・スクロール位置・再生範囲(青/赤ハンドル)は引き継ぐ。ここが
  // openMmlTextFileと違うところ(あちらは別の曲なので範囲をリセットする)
  function applyExternalMmlText(text, info) {
    const selStart = mmlSourceEl.selectionStart;
    const selEnd = mmlSourceEl.selectionEnd;
    const scrollTop = mmlSourceEl.scrollTop;
    mmlSourceEl.value = text;
    mmlSourceEl.dispatchEvent(new Event('input')); // シンタックスハイライト更新
    mmlSourceEl.setSelectionRange(Math.min(selStart, text.length), Math.min(selEnd, text.length));
    mmlSourceEl.scrollTop = scrollTop;
    markMmlTextSynced(info && info.name);
    prepareMmlStream(true);
    mmlFileStatus(T('外部の更新を取り込みました: {file} ({time})',
      { file: (info && info.name) || '', time: new Date().toLocaleTimeString() }), 'ok');
  }

  // 衝突(外部もエディタも変わった)ときは勝手に決めずにボタンで選ばせる。
  // ダイアログにしないのは、外部エディタで保存するたびに前面に出てくると作業を邪魔するため
  function mmlFileConflictStatus(name) {
    mmlOutputEl.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'error';
    box.textContent = T('{file} が外部で更新されましたが、エディタ側にも未保存の変更があります。',
      { file: name }) + ' ';
    const take = document.createElement('button');
    take.className = 'secondary';
    take.textContent = T('外部の内容を取り込む');
    take.addEventListener('click', () => FileSync.acceptPending());
    const keep = document.createElement('button');
    keep.className = 'secondary';
    keep.textContent = T('エディタの内容で上書き保存');
    keep.addEventListener('click', () => saveMmlFile());
    box.appendChild(take);
    box.appendChild(document.createTextNode(' '));
    box.appendChild(keep);
    mmlOutputEl.appendChild(box);
  }

  function initMmlFileSync() {
    const linkEl = document.getElementById('mmlFileLink');
    const nameEl = document.getElementById('mmlFileLinkName');
    const actionEl = document.getElementById('mmlFileLinkAction');
    const detachEl = document.getElementById('mmlFileLinkDetach');
    const watchEl = document.getElementById('mmlFileWatchBtn');
    if (!linkEl) return;

    let lastConflictShown = false;

    function render(st) {
      const show = st.connected || st.resumable;
      linkEl.hidden = !show;
      if (!show) return;
      nameEl.textContent = st.name || st.resumableName;
      const live = st.connected && st.watching && !st.conflict;
      const stale = !!st.conflict || !st.connected || !!st.error;
      linkEl.classList.toggle('is-live', live);
      linkEl.classList.toggle('is-stale', stale);
      if (watchEl) {
        watchEl.setAttribute('aria-pressed', st.watchEnabled ? 'true' : 'false');
        watchEl.title = st.watchEnabled
          ? T('外部エディタでの保存を自動で取り込む')
          : T('自動取り込みは停止中（再生ボタンを押したときだけ取り込みます）');
      }
      if (st.conflict) {
        actionEl.hidden = false;
        actionEl.textContent = T('取り込む');
        linkEl.title = T('外部で更新されています');
      } else if (!st.connected || st.error) {
        actionEl.hidden = false;
        actionEl.textContent = T('再接続');
        // 再読込するとハンドルの権限が'prompt'に戻るため、復帰には必ずクリックが要る
        linkEl.title = T('クリックすると外部ファイルとの同期を再開します');
      } else {
        actionEl.hidden = true;
        linkEl.title = T('外部エディタと同期中');
      }
      // 衝突は出た瞬間に1度だけ説明を出す(ポーリングのたびに書き直さない)
      if (st.conflict && !lastConflictShown) mmlFileConflictStatus(st.name);
      lastConflictShown = st.conflict;
    }

    FileSync.init({
      onExternalChange: applyExternalMmlText,
      onStateChange: render,
      // エディタ側に未保存の変更があるか。openMmlTextFile/saveMmlFileと同じ基準を使う
      isDirty: () => lastSyncedMmlText !== null && mmlSourceEl.value !== lastSyncedMmlText,
    });

    if (watchEl) {
      watchEl.addEventListener('click', () => FileSync.setWatchEnabled(!FileSync.isWatchEnabled()));
    }
    actionEl.addEventListener('click', async () => {
      const st = FileSync.state();
      if (st.conflict) { FileSync.acceptPending(); return; }
      const res = await FileSync.reconnect();
      if (!res) {
        mmlFileStatus(T('外部ファイルへ再接続できませんでした（権限が下りなかったか、ファイルが移動/削除されています）。'), 'error');
        return;
      }
      if (res.conflicted) mmlFileConflictStatus(res.name);
    });
    detachEl.addEventListener('click', () => {
      // ×は接続そのものを捨てる(記憶したハンドルも消すので、再読込しても「再接続」は出ない)。
      // 戻る道が画面から消えてしまうので、やめた瞬間にここで案内する。
      // 一時的に止めたいだけなら⟳(自動取り込みのON/OFF)の方
      FileSync.detach();
      mmlFileStatus(T('外部ファイルとの同期をやめました。もう一度同期するには「開く」でファイルを選ぶか、MMLファイルをウィンドウへドロップしてください。'), '');
    });
    // 外部エディタから戻ってきた瞬間に見に行く(最大1秒のポーリング待ちを省くだけ)。
    // これも自動取り込みの一部なので auto を付ける(⟳がOFFならここでは取り込まない)
    window.addEventListener('focus', () => { FileSync.checkNow({ auto: true }); });
  }

  // 楽譜(MusicXML)出力(ROADMAP「フェーズ外: 楽譜出力」段階2): MML → compile() → 表記モデル
  // (src/score/notation.js) → MusicXML 文字列(src/score/musicxml.js)。入口は MML の音価だけ
  // (ロールのレジスタ由来データからは出さない)。;@time / ;@key のコメント指示で拍子と調を渡せる
  // mode: 'all'(1chごとに1段、既定) | 'piano'(右手/左手の2段+打楽器、Score.buildPianoNotation。楽譜ウィンドウの選択)
  function exportMmlMusicXml(mode) {
    const piano = mode === 'piano';
    const result = MML.Mml.compile(mmlSourceEl.value, getMmlOpt());
    mmlOutputEl.innerHTML = '';
    const msg = document.createElement('div');
    if (result.errors.length > 0) {
      msg.className = 'error';
      msg.innerHTML = escapeHtml(T('MMLコンパイルエラーのため書き出せません:')) + '\n' + renderCompileErrors(result.errors);
      mmlOutputEl.appendChild(msg);
      return;
    }
    if (result.warnings && result.warnings.length) {
      const w = document.createElement('div');
      w.innerHTML = renderCompileWarnings(result.warnings);
      mmlOutputEl.appendChild(w);
    }
    let built;
    try {
      built = MML.Score.compiledToMusicXML(result, { piano });
    } catch (e) {
      msg.className = 'error';
      msg.textContent = T('楽譜の組み立てに失敗しました(内部エラー):') + '\n' + (e && e.message ? e.message : String(e));
      mmlOutputEl.appendChild(msg);
      return;
    }
    const meta = result.meta || {};
    const filename = (meta.title || 'output') + (piano ? '-piano' : '') + '.musicxml';
    downloadText(filename, built.xml);
    const n = built.notation;
    const measures = n.parts.length ? Math.max(...n.parts.map(p => p.measures.length)) : 0;
    const key = n.key.estimated ? T('{n}(推定)', { n: n.key.fifths }) : String(n.key.fifths);
    msg.className = 'ok';
    msg.textContent = T('楽譜を書き出しました: {file}({parts}パート / {measures}小節 / 拍子 {time} / 調号 {key})',
      { file: filename, parts: n.parts.length, measures, time: n.time.beats + '/' + n.time.beatType, key });
    mmlOutputEl.appendChild(msg);
  }

  function exportMmlNsf() {
    const result = MML.Mml.compile(mmlSourceEl.value, getMmlOpt());

    mmlOutputEl.innerHTML = '';
    const msg = document.createElement('div');

    if (result.errors.length > 0) {
      msg.className = 'error';
      msg.innerHTML = escapeHtml(T('MMLコンパイルエラーのため書き出せません:')) + '\n' + renderCompileErrors(result.errors);
      mmlOutputEl.appendChild(msg);
      return;
    }
    if (result.warnings && result.warnings.length) {
      const w = document.createElement('div');
      w.innerHTML = renderCompileWarnings(result.warnings);
      mmlOutputEl.appendChild(w);
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

    // 内訳(ドライバ本体/曲データ/DPCM)はbuildBankedNsfBytesが実測で返す(以前の
    // 「bankCount-8=曲データバンク数」はドライバ領域が固定8バンクだった頃の式で、
    // ROM圧縮後は意味を成さなくなっていた)
    let out = T('NSF書き出し完了: {bytes}バイト({banks}バンク: ドライバ {driverBytes}バイト / 曲データ {songBytes}バイト / DPCM {dpcmBytes}バイト)',
      { bytes: nsfBytes.length, banks: built.bankCount, driverBytes: built.driverBytes || 0,
        songBytes: built.songDataBytes || 0, dpcmBytes: built.dpcmBytes || 0 }) + '\n';
    if (built.unsupportedExpansions.length > 0) {
      out += T('注意: 拡張音源({chips})は現状のNSF書き出しでは未対応のため、該当チャンネルは無音になります(VRC6/MMC5/FME7/FDS/N163/VRC7は対応済み)。',
        { chips: built.unsupportedExpansions.join(', ') }) + '\n';
    }
    msg.className = 'ok';
    msg.textContent = out;
    mmlOutputEl.appendChild(msg);
  }

  // compileOnly=true: コンパイル・再生準備(モニタ/DPCMサンプル欄/チャンネル選択欄など各種UIの
  // 反映)のみ行い、実際の音声再生は開始しない。NSF2MML等の変換直後にMML本文だけを差し替えても
  // これらの要素は自動更新されないため、変換完了時にはこちらを呼ぶ
  function prepareMmlStream(compileOnly, externalSource, externalLabel) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const btnMmlCapture = document.getElementById('btnMmlCapture');
    btnMmlCapture.disabled = true;
    captureOutputEl.innerHTML = '<div>' + T('コンパイル中…') + '</div>';

    // 「まだ曲がロードされていない/直前に明示的にリセットされた」状態かどうかをここで
    // 記録しておく(この先のpreservePlaybackRangeでrangeEndSecがnullでなくなるため、
    // 呼び出し後では判定できない)。applyMmlPlaybackMarkers参照
    const isFreshRangeLoad = (rangeEndSec === null);

    mmlExternalSourceLabel = (externalSource != null) ? (externalLabel || T('ヘルプ')) : null;
    const compiled = MML.Mml.compile(externalSource != null ? externalSource : mmlSourceEl.value, getMmlOpt());
    if (compiled.errors.length > 0) {
      captureOutputEl.innerHTML =
        `<div class="error">${renderCompileErrors(compiled.errors)}</div>`;
      btnMmlCapture.disabled = false;
      return;
    }
    // 音域外など「鳴らない箇所」の警告。再生自体は続行する(該当音だけ無音)
    captureOutputEl.innerHTML = renderCompileWarnings(compiled.warnings);

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
      setKbdSource('mml', mmlExternalSourceLabel || (compiled.meta && compiled.meta.title ? compiled.meta.title : '')); // タイトル行のバッジ「MML · 曲名」

      // モニタ用 regSnapshots をメインスレッドで即時構築（音声生成なし）
      resetN163Max();
      const regSnapshots    = buildRegSnapshotsFromTracks(compiled);
      const writeLog        = buildWriteLogFromTracks(compiled);
      const samplesPerFrame = audioCtx.sampleRate / compiled.frameRate;
      setMonitorSource(
        { regSnapshots, writeLog, cpuSnapshots: null, memSnapshots: null,
          sampleRate: audioCtx.sampleRate, samplesPerFrame,
          totalFrames: compiled.totalFrames,
          tuningCents: (compiled.settings && compiled.settings.tuningCents) || 0, // #TUNING(鍵盤/ロールの音名丸め)
          tuningNotes: (compiled.settings && compiled.settings.tuningNotes) || null, // #TUNING-NOTE(音名別)
          getApuEnv: liveApuEnv, getN163: liveN163,
          getFME7: liveFME7, getMmc5: liveMMC5, getVRC7: liveVRC7 }, // 音量/拡張音源表示をライブ反映
        getTransportPosition,
        compiled.expansions
      );
      // 楽譜モード(鍵盤表示のレイアウト設定「ピアノロールの表示: 楽譜」)用の表記モデル
      // (src/score/notation.js)。失敗しても再生は続ける(ロール表示に戻るだけ)
      try {
        keyboardDisplay.setScore({ notation: MML.Score.buildNotation(compiled, {}), compiled, fps: compiled.frameRate,
          loopPointFrame: compiled.loopPointFrame, totalFrames: compiled.totalFrames });
      } catch (e) { console.warn('楽譜モデルの構築に失敗:', e); keyboardDisplay.setScore(null); }
      scoreView.setScore(keyboardDisplay.getScore());

      // MmlStreamPlayer を生成してデータをロード
      const player = new MML.Audio.MmlStreamPlayer(audioCtx);
      player.load(compiled, getChannelMuteConfig());
      player.applyVolume(getChannelVolumeConfig()); // 鍵盤表示のch別音量バー(再生開始時点の値。以後はonVolumeChange→scheduleRerenderOnVolumeで即時反映)
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
    // 冒頭で出したコンパイル警告(音域外・DPCM未読込)は消さずに残す(以前は '' で消していたので
    // 成功時は警告が一度も見えなかった。2026-09-16)
    captureOutputEl.innerHTML = renderCompileWarnings(compiled.warnings);
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = out;
    captureOutputEl.appendChild(pre);

    if (externalSource != null) {
      // ヘルプの実演は必ずスニペット全体を鳴らす。ユーザーが設定していた再生範囲を
      // そのまま使うと、範囲が短いときに実演が最初の一音で打ち切られてしまう
      // (updateTransportUIの rangeEndSec 到達判定)。範囲は退避して停止時に戻す
      if (!mmlExternalSavedRange) mmlExternalSavedRange = { start: rangeStartSec, end: rangeEndSec };
      resetPlaybackRangeToFull(duration);
    } else {
      mmlExternalSavedRange = null;
      preservePlaybackRange(duration);
      applyMmlPlaybackMarkers(compiled, duration, isFreshRangeLoad);
    }
    setSeekBarValue(0);
    setTimeDisplay(`00:00 / ${formatTime(duration)}`);
    btnMmlCapture.disabled = false;

    if (!compileOnly) {
      mmlPlaybackStopped = false;
      transportPlay();
    }
  }

  function runMmlStream() {
    prepareMmlStream(false);
  }

  /*
   * エディタ本文以外のMML文字列を、通常のMML再生とまったく同じ経路で鳴らす公開API。
   * MMLコマンドヘルプ(src/ui/helpPanel.js)の項目ごとの「▶」から使う。
   * 通常経路に乗せることで、鍵盤表示・ピアノロール・レジスタモニタ・シークバー・
   * ch別ミュート/音量がヘルプの実演にもそのまま効く(再生位置ハイライトだけは
   * エディタ本文と中身が違うので mmlExternalSourceLabel で抑止される)。
   */
  MML.UI = MML.UI || {};
  MML.UI.MmlPlayback = {
    // 戻り値: 実際に再生を開始できたか(コンパイルエラー時はfalse)
    playSource(text, label, onEnded) {
      // prepareMmlStreamは冒頭で既存再生をtransportStop()するので、終了コールバックの
      // 登録はその後(=再生開始後)に行う。先に登録すると自分の開始処理で即座に呼ばれてしまう
      mmlExternalSourceOnEnded = null;
      prepareMmlStream(false, String(text || ''), label);
      const started = !mmlPlaybackStopped && mmlExternalSourceLabel != null;
      if (started && typeof onEnded === 'function') mmlExternalSourceOnEnded = onEnded;
      return started;
    },
    stop() { transportStop(); },
    isExternal() { return mmlExternalSourceLabel != null; }
  };

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

  // 無音自動送り用の先読みスキャン(player.scanSilenceStep、monitorLoop参照)を
  // 1回のrAF tickで進める曲内時間の予算(秒)。60fps換算で概ね30倍速でスキャンが
  // 進むため、キャプチャさえ追いついていればどんな長さの曲でも数秒〜数十秒で
  // スキャンが完了(無音発見 or 曲末到達)し、以後は仕事をしなくなる。
  const SCAN_STEP_SONG_SECONDS = 0.5;

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

  // ---- NSFe(曲ラベル/演奏時間/再生順) ----
  // 再生順チャンク(plst、0始まりの曲番号列)。範囲外を除いて空なら無し扱い
  function nsfePlaylist(header) {
    const pl = header && header.nsfe && header.nsfe.playlist;
    if (!pl || pl.length === 0) return null;
    const total = Math.max(1, header.totalSongs);
    const valid = pl.filter(i => i >= 0 && i < total);
    return valid.length > 0 ? valid : null;
  }
  // NSFeのtimeチャンク(曲ごとの演奏時間)を再生時間欄へ反映する。曲が変わったときだけ
  // 書き換える(同じ曲で再生し直すときはユーザーが手で直した値を尊重する)。SPCのID666と同じ扱い。
  // 時間はフェード開始までの長さなので、そのまま「再生時間」(この後FADE_SEC秒フェード)に入れる
  let nsfeAppliedSong = 0;
  function applyNsfeDuration(songNo) {
    if (!loadedNsfHeader || !loadedNsfHeader.nsfe || songNo === nsfeAppliedSong) return;
    nsfeAppliedSong = songNo;
    const ms = MML.NSF.trackTimeMs(loadedNsfHeader, songNo - 1);
    if (ms === null || ms <= 0) return;
    const min = parseInt(nsfPlayDurationEl.min, 10) || 1;
    const max = parseInt(nsfPlayDurationEl.max, 10) || 3600;
    nsfPlayDurationEl.value = String(Math.max(min, Math.min(max, Math.round(ms / 1000))));
  }
  // 曲送り(±1)。NSFeの再生順(plst)があればその並びで進み、無ければ曲番号順にラップ
  function stepNsfSong(songNo, delta) {
    const total = Math.max(1, loadedNsfHeader.totalSongs);
    const pl = nsfePlaylist(loadedNsfHeader);
    if (!pl) return wrapIndex(songNo + delta, 1, total);
    const pos = pl.indexOf(songNo - 1);
    if (pos < 0) return pl[0] + 1;
    return pl[wrapIndex(pos + delta, 0, pl.length - 1)] + 1;
  }
  function formatMsAsClock(ms) {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderNsfFileHeader(header, legacyN163) {
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

    // NSFe固有の情報(NSFヘッダに載らないもの)
    if (header.nsfe) {
      const m = header.nsfe;
      out += T('形式           : NSFe (チャンク: {chunks})', { chunks: m.chunks.join(' ') }) + '\n';
      if (m.ripper) out += `Ripper         : ${m.ripper}\n`;
      if (m.dendySpeed !== null) out += T('Dendy Speed    : {v} (1/1,000,000秒)', { v: m.dendySpeed }) + '\n';
      if (m.nsf2Flags) out += `NSF2 Flags     : ${toHex(m.nsf2Flags, 2)}\n`;
      if (m.playlist) out += T('再生順(plst)   : {list}', { list: m.playlist.map(i => i + 1).join(', ') }) + '\n';
      if (m.trackLabels || m.times || m.trackAuthors) {
        out += T('曲一覧         :') + '\n';
        const n = Math.max(1, header.totalSongs);
        for (let i = 0; i < n; i++) {
          const label = (m.trackLabels && m.trackLabels[i]) || '';
          const author = (m.trackAuthors && m.trackAuthors[i]) ? ` (${m.trackAuthors[i]})` : '';
          const t = (m.times && m.times[i] !== null && m.times[i] !== undefined) ? formatMsAsClock(m.times[i]) : '';
          const fd = (m.fades && m.fades[i]) ? ` +fade ${formatMsAsClock(m.fades[i])}` : '';
          out += `  ${String(i + 1).padStart(3)}. ${label}${author}${t ? `  [${t}${fd}]` : ''}\n`;
        }
      }
      if (m.text) out += T('テキスト       :') + '\n' + m.text.split(/\r?\n/).map(l => '  ' + l).join('\n') + '\n';
    }

    nsfFileHeaderEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = header.magicOk ? 'ok' : 'error';
    pre.textContent = out;
    nsfFileHeaderEl.appendChild(pre);

    // 旧ppmckドライバ(Famicompo mini 時代)のN106判定。当時のVirtuaNES系の解釈
    // (波形長 最大32サンプル)で書かれたNSFは実機仕様のままだと音程が2オクターブ落ちて
    // 音色も崩れるため、エミュレータ側で旧解釈に切り替える(nsfBus.js/n163.js)。
    // ここでは検出結果をログに出すだけ。N163を使わないNSFでは同じドライバでも無関係なので出さない。
    if (legacyN163 && (header.extraChips & MML.NSF.CHIP_FLAGS.N163)) {
      const note = document.createElement('div');
      note.className = 'ok';
      note.textContent = T('旧ppmckドライバ(Famicompo mini 時代)を検出: N163の波形長を旧解釈(VirtuaNES互換・最大32サンプル)で鳴らします。実機仕様で鳴らすと音程が2オクターブ落ち音色も崩れるため、当時の聴こえ方を再現します。');
      nsfFileHeaderEl.appendChild(note);
    }
  }

  async function loadNsfFile() {
    const file = nsfFileEl.files[0];
    if (!file) return;

    stopAllFormatPlayback();
    stopNsfFilePlayback();
    keyboardDisplay.reset();
    MML.Convert.ChannelPlan.newFile("nsf", {}, file.name); // 新ファイル: チャンネル割当(案E)をリセット
    setKbdSource('nsf', file.name);
    loadedNsfBytes = null;
    loadedNsfHeader = null;
    // 別ファイルを読み込んだら前回ファイルのキャプチャ結果は無効(runNsf2Mmlが同じ
    // 曲番号のまま前ファイルのwriteLogを再利用し、新ファイルのヘッダ/バイト列と混ぜて
    // 変換してしまう不具合の修正)
    lastNsfCaptureResult = null;

    const arrayBuffer = await file.arrayBuffer();
    const rawBytes = new Uint8Array(arrayBuffer);

    // NSFe(チャンク形式のNSF拡張)は「128バイトNSFヘッダ+DATA」の素のNSFバイト列へ変換し、
    // 以降の再生/キャプチャ/変換は従来のNSF経路をそのまま通す。曲ラベル/演奏時間/再生順など
    // NSFヘッダに載らない情報は header.nsfe に別枠で入る(src/nsf/nsfHeader.js parseNsfe)
    let bytes, header;
    if (MML.NSF.isNsfe(rawBytes)) {
      try {
        ({ bytes, header } = MML.NSF.normalize(rawBytes));
      } catch (e) {
        nsfFileHeaderEl.innerHTML = '<div class="error">' + T('NSFeファイルを解析できませんでした: {msg}', { msg: e.message }) + '</div>';
        return;
      }
    } else {
      if (rawBytes.length < 128) {
        nsfFileHeaderEl.innerHTML = '<div class="error">' + T('ファイルサイズが小さすぎます（NSFヘッダは128バイト必要です）。') + '</div>';
        return;
      }
      bytes = rawBytes;
      header = MML.NSF.parseHeader(bytes);
      if (!header.magicOk) {
        nsfFileHeaderEl.innerHTML = '<div class="error">' + T('NSFヘッダのマジックナンバーが不正です（NSFファイルではない可能性があります）。') + '</div>';
        return;
      }
    }

    loadedNsfBytes = bytes;
    loadedNsfHeader = header;
    renderNsfFileHeader(header, MML.NSF.detectLegacyN163Driver(bytes.slice(128)));

    const totalSongs = Math.max(1, header.totalSongs);
    nsfSongIndexEl.min = '1';
    nsfSongIndexEl.max = String(totalSongs);
    // NSFeの再生順(plst)があればその先頭から、無ければヘッダの開始曲から
    const pl = nsfePlaylist(header);
    const firstSong = pl ? pl[0] + 1 : (header.startingSong || 1);
    nsfSongIndexEl.value = String(Math.min(totalSongs, Math.max(1, firstSong)));
    nsfSongTotalEl.textContent = `/ ${totalSongs}`;
    nsfeAppliedSong = 0;
    applyNsfeDuration(parseInt(nsfSongIndexEl.value, 10));

    nsfFileStatusEl.innerHTML = '';
    updateKeyboardTransport(); // 曲数が確定したので鍵盤表示の⏮⏭の有効/無効を決め直す(1曲のNSFは無効)
  }

  function updateNsfPlayButton() {
    const btn = document.getElementById('btnNsfFilePlay');
    btn.disabled = nsfIsRendering;
    const isPlaying = lastPlayMode === 'nsf' && activePlayer && activePlayer.isPlaying;
    btn.classList.toggle('is-playing', isPlaying);
    btn.title = isPlaying ? T('一時停止') : T('再生');
    updateKeyboardTransport(); // 鍵盤表示タイトル行の▶/⏸も同じ状態に合わせる
  }

  function stopNsfFilePlayback() {
    if (lastPlayMode === 'nsf' && activePlayer) {
      stopActivePlayer();
    }
    if (lastPlayMode === 'nsf') {
      nsfRollToken++; // 進行中の先読みキャプチャ結果を無効化
      // ★停止ではロールを消さない(別の曲を再生し始めるときだけ消す)。止めた状態でも
      //   ロールとドラムパッドを見られる・試聴できるようにするため(ユーザー要望)
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
  setupTempoControl('vgm');
  setupTempoControl('psf');

  // 変換テンポ入力欄の値 (空/不正なら null = 自動検出)
  function getManualBpm(prefix) {
    const v = parseFloat(document.getElementById(`${prefix}TempoBpm`).value);
    return (isFinite(v) && v >= 40 && v <= 400) ? v : null;
  }

  // MML変換用キャプチャの進捗%表示コールバックを作る(SPCで先行導入した表示を全形式で共通化。
  // 各captureXxxSongAsyncのonProgress(done,total,...)にそのまま渡せる)。%が変わったときだけ
  // DOMを書き換える(onProgressはタイムスライスごとに高頻度で呼ばれるため)。
  function makeCaptureProgress(statusEl) {
    let lastPct = -1;
    return (done, total) => {
      const pct = total > 0 ? Math.floor(done * 100 / total) : 0;
      if (pct === lastPct) return;
      lastPct = pct;
      statusEl.innerHTML = '<div>' + T('MML変換用キャプチャ中… {pct}%', { pct }) + '</div>';
    };
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
      nsfFileStatusEl.innerHTML = '<div>' + T('MML変換用キャプチャ中… (数秒かかります)') + '</div>';

      result = await MML.Emu.captureSongAsync(loadedNsfBytes, {
        songIndex: songNo - 1,
        durationSeconds: duration,
        sampleRate: audioCtx.sampleRate,
        mute: {}
      }, makeCaptureProgress(nsfFileStatusEl));
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
      await synthDrumEnsure(); // 打楽器化したchの分離レンダリングを確定させる
      converted = MML.NSF2MML.convert(
        result.writeLog, loadedNsfBytes, loadedNsfHeader, songNo - 1, result.initRegs, result.initWrites,
        Object.assign({ bpm: nsfManualBpm, n163Snapshots: result.n163Snapshots, cmd: MML.UI.ConvertSettings.get() }, planConvertOptions()));
    } catch (e) {
      nsfFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }

    // MML エディタに挿入
    resetMmlForNewSong(); // 別の曲になるのでログ/ファイル名/外部同期は引き継がない
    mmlSourceEl.value = converted.mml;
    resetDpcmEditor();
    mmlSourceEl.dispatchEvent(new Event('input')); // シンタックスハイライト更新

    // 抽出済み波形を波形エディタへ反映(拡張音源の有効化自体はMML本文に埋め込まれた
    // #EX-*ディレクティブがコンパイル時に自動検出するため、UI側の操作は不要)
    if (converted.fdsWave && MML.WaveformEditor.fdsWave) MML.WaveformEditor.fdsWave.setData(converted.fdsWave);
    if (converted.n163Wave && MML.WaveformEditor.n163Wave) MML.WaveformEditor.n163Wave.setData(converted.n163Wave);

    // .dmc は台帳(dpcmSampleCache + IndexedDB)へ。生成されたMML中の@DPCM<n>定義をファイル再選択なしで
    // そのまま再生・NSF書き出しでき、MMLを保存すると同じフォルダへ書き出せる(takeDpcmFiles)
    takeDpcmFiles(converted.dpcmFiles);

    const dpcmMsg = converted.dpcmFiles.length > 0
      ? T('、DPCM {n} ファイル出力', { n: converted.dpcmFiles.length }) : '';
    const expMsg = converted.expansions && converted.expansions.length > 0
      ? T('、拡張音源: {chips}', { chips: converted.expansions.join(', ') }) : '';
    nsfFileStatusEl.innerHTML = '<div class="ok">' +
      T('MML変換完了 ({mode} {bpm} BPM{exp}{dpcm}) → MMLエディタに出力しました',
        { mode: nsfManualBpm ? T('指定') : T('推定'), bpm: converted.bpm, exp: expMsg, dpcm: dpcmMsg }) + '</div>' +
      renderTuning(converted.tuning) + renderPitchCheck(converted.pitchCheck);

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

  // ── 音声の書き出し(WAV / FLAC / AAC)を1か所にまとめる ─────────────────
  // 形式は鍵盤表示のロール見出しで選ぶ(exportMode)。各 exportXxxWav() は
  // 「レンダリングした生の波形と音量倍率」までを用意して、ここへ渡すだけにする。
  //   ・WAV  … buildWavBlob(Stereo)。従来と同じ16bit PCM
  //   ・FLAC … 自前エンコーダ(src/audio/flacEncoder.js)。可逆でWAVの6割弱
  //   ・AAC  … WebCodecs + 自前のMP4多重化(src/audio/aacEncoder.js)。非可逆
  // 進捗は statusEl へ出す(WAVは一瞬なので出さない)。戻り値は出したファイル名。
  const EXPORT_EXT = { wav: 'wav', flac: 'flac', aac: 'm4a' };
  async function downloadExportAudio(baseName, chans, sampleRate, gain, statusEl) {
    const mode = EXPORT_EXT[exportMode] ? exportMode : 'wav';
    const filename = baseName + '.' + EXPORT_EXT[mode];
    const progress = (label) => (f) => {
      if (statusEl) statusEl.innerHTML = '<div>' + T('{label}書き出し中… {pct}%', { label, pct: Math.round(f * 100) }) + '</div>';
    };
    let blob;
    if (mode === 'flac') {
      blob = await MML.Audio.Flac.encode(chans, sampleRate, { gain, onProgress: progress('FLAC'),
        tags: { TITLE: baseName, ENCODER: 'Sound Emulation Foundry' } });
    } else if (mode === 'aac') {
      blob = await MML.Audio.Aac.encode(chans, sampleRate, { gain, onProgress: progress('AAC') });
    } else if (chans.length >= 2) {
      blob = buildWavBlobStereo(chans[0], chans[1], sampleRate, gain);
    } else {
      blob = buildWavBlob(chans[0], sampleRate, gain);
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    return filename;
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
      mute: getChannelMuteConfig(true)
    }, (done, total) => {
      nsfFileStatusEl.innerHTML = '<div>' + T('WAV書き出し中… {pct}%', { pct: Math.round(done / total * 100) }) + '</div>';
    });
    nsfIsRendering = false;
    updateNsfPlayButton();
    const songName = (loadedNsfHeader.songName || 'output').replace(/[^\w\-]/g, '_');

    // 出力形式は鍵盤表示の「出力形式」で選ぶ(既定WAV)。以前はWAVとレジスタログCSVが
    // 必ず一緒に出ていたが、選んだ方だけを出すようにした(2026-09-09 ユーザー指示)
    let filename;
    if (exportMode === 'reglog') {
      // 全レジスタ書き込みログ（フレームごと・チップ名注記付き）
      // chip 列は末尾に追加。既存の frame,addr,value 3列はそのまま残す（後方互換）。
      let csv = 'frame,addr,value,chip\n';
      result.writeLog.forEach((writes, f) => {
        writes.forEach(w => {
          csv += `${f},0x${w.addr.toString(16).toUpperCase()},0x${w.value.toString(16).toUpperCase().padStart(2,'0')},${regChipName(w.addr)}\n`;
        });
      });
      filename = `${songName}_song${songNo}_regs.csv`;
      downloadText(filename, csv);
    } else {
      // gain=3.0 を適用して選ばれた形式で出力(WAV/FLAC/AAC)
      filename = await downloadExportAudio(`${songName}_song${songNo}`, [result.audio], sampleRate, 3.0, nsfFileStatusEl);
    }

    // 有効音源リスト（2A03 + ヘッダの拡張音源フラグ）
    const activeChips = ['2A03'].concat(
      chipsFromExtraFlags(loadedNsfHeader.extraChips || 0).map(c => c.toUpperCase()));
    nsfFileStatusEl.innerHTML = '<div class="ok">' +
      T('書き出し完了: {file}<br>音源: {chips}',
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

  // ピアノロールのタイムライン構築は、キャプチャWorker内で行われた完成品を
  // opt.roll.onRoll(timeline, info)で受け取って差し替えるだけになった
  // (src/audio/roll-builders.js、capture-worker-client.js参照)。
  // ★2026-08-21 経緯: Worker化でキャプチャが数十倍速になった結果、メインスレッドでの
  // ロール再構築(1回あたりO(done)の曲全体走査)がprogressごとに走って長タスク=
  // カクつきの主因になった(実測: VGM Neo Geo再生6秒間で累計975ms=16%占有、最大110ms)。
  // 適応スロットルで16%→3.5%まで抑えたが、曲末近くの1回~90msのスパイクは残ったため、
  // 構築そのものをWorkerへ移した(スロットルはWorker側とフォールバック時の
  // メインスレッド構築に残っている: RollBuild.makeThrottle)。

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
    applyNsfeDuration(songNo); // NSFeの曲別演奏時間(曲が変わったときだけ再生時間欄を書き換える)

    const duration    = parseInt(nsfPlayDurationEl.value, 10) || 30;
    // 「指定した再生時間ぶん鳴らした後、そこからさらにFADE_SEC秒かけてフェードアウトする」
    // 仕様(ユーザー指定)のため、実際のキャプチャ/再生長はduration+FADE_SECにする。
    // フェード自体はupdateEndFadeGain()がworkletDuration(=captureDuration)の手前
    // FADE_SEC秒から自動的に開始するので、ここではキャプチャ長を伸ばすだけでよい。
    const captureDuration = duration + FADE_SEC;
    const totalFrames = Math.ceil(captureDuration * MML.Emu.FRAME_RATE_NTSC);

    // 既存の再生を停止(他フォーマットの先読みキャプチャも止める。走らせたままだとNSFの
    // ピアノロールを他フォーマットの結果で上書きしてしまう)
    stopAllFormatPlayback();
    stopVoiceMonitor();
    capturedBuffer       = null;
    lastNsfCaptureResult = null;
    lastPlayMode         = 'nsf';
    // 新しい曲を鳴らし始めるのでロールは一旦消す(停止では消さない。stopNsfFilePlayback参照)。
    // 消さないと新しいキャプチャのonRollが届くまで前の曲のロールが残ったままになる
    keyboardDisplay.setRollTimeline(null);
    setKbdSource('nsf', fileInputName(nsfFileEl)); // 再生開始時にもバッジを更新(MML再生後に再生し直した場合など)
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
    attachAssignPreview(player);
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
    workletDuration = captureDuration;

    nsfFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = T('曲 {song} / {total}  再生時間: {time}',
      { song: songNo, total: totalSongs, time: formatTime(duration) });
    nsfFileStatusEl.appendChild(pre);

    resetPlaybackRangeToFull(captureDuration);
    setSeekBarValue(0);
    setTimeDisplay(`00:00 / ${formatTime(captureDuration)}`);

    const captureChips = chipsFromExtraFlags(loadedNsfHeader.extraChips || 0);
    resetN163Max();

    // バックグラウンドキャプチャ(regsOnly、CPU実行あり)。ピアノロールと実再生の両方の
    // 情報源を兼ねる。onProgressで途中経過(その時点までのregSnapshots/writeLog、進行中の
    // 配列への参照なので以後キャプチャが進むにつれ自動的に埋まっていく)を受け取り、
    // 最初の1回でplayer.load()して再生を開始する(以降のチャンクを待つ必要はない)。
    // ロールのタイムライン構築はキャプチャWorker内で行い、opt.roll.onRollで完成品を受け取る
    const myNsfRollToken = ++nsfRollToken;
    // 曲が変わるのでドラムパッド台帳/打点プロバイダ(前の曲・前の形式のもの)を捨てる
    drumSampleStore = {};
    drumHitsProvider = null;
    synthDrumReset();
    keyboardDisplay.setDpcmCost(null);
    const nsfSamplesPerFrame = audioCtx.sampleRate / MML.Emu.FRAME_RATE_NTSC;
    let nsfPlaybackLoaded = false;
    let nsfLatestCap = null; // 進行中キャプチャの {writeLog, initRegs}(完了時にDPCMサンプルを台帳へ)
    // captureSongWorkerAsync: 6502+チップエミュレーションをWeb Workerで実行し、メイン
    // スレッド(オーディオコールバック/ロール描画)とのCPU取り合いによるカクつきを解消する。
    // Worker不可・バンドル未ビルド時は従来のメインスレッド版へ自動フォールバック
    // (src/audio/capture-worker-client.js)。onProgress契約は完全に同一。
    MML.Emu.captureSongWorkerAsync(loadedNsfBytes, {
      songIndex: songNo - 1, durationSeconds: captureDuration, sampleRate: audioCtx.sampleRate,
      regsOnly: true,
      shouldCancel: () => myNsfRollToken !== nsfRollToken,
      roll: {
        samplesPerFrame: nsfSamplesPerFrame, sampleRate: audioCtx.sampleRate, chips: captureChips,
        onRoll: (timeline) => {
          if (myNsfRollToken !== nsfRollToken) return;
          pushRollTimeline(timeline);
        }
      }
    }, (done, total, regSnapshots, writeLog, n163Snapshots, initRegs, initWrites) => {
      if (myNsfRollToken !== nsfRollToken) return; // 曲切替/停止で無効化済み
      nsfLatestCap = { writeLog, initRegs, songNo }; // 完了時のドラムパッド台帳更新用

      if (!nsfPlaybackLoaded) {
        nsfPlaybackLoaded = true;
        player.load(loadedNsfBytes, songNo - 1, totalFrames,
          { writeLog, initWrites, initRegs, n163Snapshots }, getChannelMuteConfig());
        player.applyVolume(getChannelVolumeConfig());

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
    }).then(() => {
      // キャプチャ完了: DPCMサンプルの打点/波形をドラムパッド台帳と打点プロバイダへ
      // (VGM/HES/SPCと同じ役割。サンプルの同定は nsf2mml/converter.js dmcHits)
      if (myNsfRollToken !== nsfRollToken || !nsfLatestCap) return;
      updateNsfDrumSamples(nsfLatestCap.writeLog, nsfLatestCap.initRegs);
      synthDrumEnsure(); // 打楽器化(E選択)済みの合成音chがあれば全長でレンダリングし直す
      refreshDrumPanel();
      scheduleDpcmCostUpdate();
    }).catch(() => { /* 先読みキャプチャ失敗時は再生を開始できない */ });
  }

  // 曲送り/戻しは端で折り返す(送り→最後まで行ったら最初へ、戻し→最初で戻ったら最後へ)。
  // 以前は端で止まる(clamp)だけだった
  function wrapIndex(v, min, max) {
    if (max < min) return min;
    const n = max - min + 1;
    return min + (((v - min) % n) + n) % n;
  }

  function changeNsfSong(delta) {
    if (!loadedNsfHeader) return;
    const totalSongs = Math.max(1, loadedNsfHeader.totalSongs);
    let songNo = parseInt(nsfSongIndexEl.value, 10) || 1;
    songNo = stepNsfSong(songNo, delta); // totalSongs内でラップ(NSFeなら再生順plstに従う)
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
  // 「to MML」は変換設定画面を開き、その中の「コンバート開始」で変換する(ユーザー要望)
  document.getElementById('btnNsf2Mml').addEventListener('click', () => MML.UI.ConvertSettings.open({ format: 'nsf', onConvert: runNsf2Mml }));
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


  document.getElementById('btnMmlExportNsf').addEventListener('click', exportMmlNsf);
  document.getElementById('btnMmlExportMusicXml').addEventListener('click', () => exportMmlMusicXml('all'));
  scoreView.onExport = (mode) => exportMmlMusicXml(mode);
  // MMLエディタのファイル操作(開く/保存)。開くのは.mml/.txtのみ
  (function initMmlFileButtons() {
    const openInput = document.getElementById('mmlOpenFile');
    // 「開く」はまずピッカー(showOpenFilePicker)を試す。ピッカーはハンドルを返すので、
    // そのまま外部エディタとの同期対象にできる。file://でも開けることは実測済み。
    // ピッカーを持たないブラウザ(Firefox等)だけが従来の<input type=file>へ落ちる
    document.getElementById('btnMmlOpenFile').addEventListener('click', async () => {
      const res = await FileSync.pickOpen();
      if (res.aborted) return;
      if (res.handles && res.handles.length) {
        try {
          // .dmc は台帳へ。.mml が無く .dmc だけなら本文はそのままで台帳だけ更新する
          const dmcFiles = [];
          for (const h of res.handles) if (isDmcFile(h)) dmcFiles.push(await h.getFile());
          if (res.handle) {
            const file = await res.handle.getFile();
            await openMmlTextFile(file, res.handle, dmcFiles);
          } else {
            await openDmcOnly(dmcFiles);
          }
        } catch (e) {
          mmlFileStatus(T('MMLファイルの読み込みに失敗しました: {msg}', { msg: e.message }), 'error');
        }
        return;
      }
      openInput.click();
    });
    openInput.addEventListener('change', async () => {
      const files = Array.from(openInput.files || []);
      const dmcFiles = files.filter(isDmcFile);
      const primary = files.find(f => !isDmcFile(f));
      if (primary) await openMmlTextFile(primary, null, dmcFiles);
      else if (dmcFiles.length) await openDmcOnly(dmcFiles);
      openInput.value = ''; // 同じファイルを続けて開き直せるようにする
    });
    document.getElementById('btnMmlSaveFile').addEventListener('click', () => saveMmlFile());
    let dpcmRestoreTimer = null;
    mmlSourceEl.addEventListener('input', () => {
      clearTimeout(dpcmRestoreTimer);
      dpcmRestoreTimer = setTimeout(() => { restoreDpcmSamples(mmlSourceEl.value); }, 500);
    });
    // 起動直後のサンプルMMLを「未編集」の基準にする(この状態なら確認なしで開ける)
    markMmlTextSynced('');
    initMmlFileSync();
  })();
  document.getElementById('btnMmlCapture').addEventListener('click', async () => {
    // 再生の直前に外部ファイルを1回見に行く(自動取り込みをOFFにしていても、
    // 再生したときの音は必ずディスク上の最新と一致させる)。同期していないときは
    // awaitを挟まない(クリックからAudioContext.resume()までを同じタスクに保つ)
    if (FileSync.isConnected()) await FileSync.checkNow();
    const playing = activePlayer ? activePlayer.isPlaying : transportPlaying;
    if (playing) transportPause();
    else if (!mmlPlaybackStopped) transportPlay(); // 一時停止中: 再コンパイルせずその位置から再開
    else runMmlStream(); // 停止中: 再コンパイルして最初(または再生範囲開始点)から再生
  });
  document.getElementById('btnTransportStop').addEventListener('click', transportStop);
  document.getElementById('btnRangeReset').addEventListener('click', () => resetPlaybackRangeToFull(currentDuration()));
  (function initLoopButton() {
    const btn = document.getElementById('btnLoopRange');
    const sync = () => {
      btn.classList.toggle('is-active', loopRange);
      btn.title = loopRange ? T('再生範囲のくり返しをやめる') : T('再生範囲をくり返す');
      btn.setAttribute('aria-pressed', loopRange ? 'true' : 'false');
    };
    btn.addEventListener('click', () => {
      loopRange = !loopRange;
      try { localStorage.setItem('mml.loopRange', loopRange ? '1' : '0'); } catch (e) { /* ignore */ }
      sync();
    });
    sync();
  })();

  // --- メトロノーム(src/ui/metronomePanel.js / src/input/metronome.js) ---
  // ROADMAPフェーズ3(MIDI録音)・フェーズ4(鼻歌入力)が乗る拍の時間軸を、まず単体で使える
  // 道具として用意したもの。入力オフセットの較正値(MML.Input.Latency)も録音側がそのまま使う。
  MML.UI.MetronomePanel.init({
    toggleEl:    document.getElementById('btnMetronome'),
    settingsEl:  document.getElementById('btnMetronomeSettings'),
    getAudioCtx: () => {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      return audioCtx;
    },
    getMmlTempo: currentMmlTempo,
    getPlaybackClock
  });

  // --- 演奏入力(src/ui/performInput.js) ---
  // PC鍵盤/画面ピアノ → MML.Input.NoteSource → src/audio/live-monitor.js(借用先の音源で発音)。
  // 押している鍵の点灯は鍵盤表示側が PerformInput.heldNotes() を引いて描くので、
  // 停止中(rAFが回っていない)でも見えるよう、押鍵のたびに鍵盤だけ描き直させる。
  MML.UI.PerformInput.init({
    toggleEl:    document.getElementById('btnPerformInput'),
    settingsEl:  document.getElementById('btnPerformInputSettings'),
    getAudioCtx: () => {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      return audioCtx;
    },
    onArmedChange: (on) => {
      if (keyboardDisplay) keyboardDisplay.refreshPianos();
      // Escや入力欄フォーカスで演奏入力が切れたら、録音も一緒に閉じる
      if (!on && MML.UI.RecordPanel) MML.UI.RecordPanel.onPerformDisarmed();
    },
    onNotesChange: () => { if (keyboardDisplay) keyboardDisplay.refreshPianos(); }
  });

  // --- 演奏の録音 → MML挿入(src/ui/recordPanel.js) ---
  // 停止すると結果ダイアログが開き、挿入される文字列そのものを確認してから本文へ入る
  // (INV-6: 既存MMLは黙って書き換えない)。
  MML.UI.RecordPanel.init({
    toggleEl:    document.getElementById('btnRecordPerformance'),
    getAudioCtx: () => {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      return audioCtx;
    },
    getEditor: () => mmlSourceEl,
    // 挿入先のチャンネル文字は直近のコンパイル結果から。未コンパイルなら2A03の4本
    getChannelLetters: () => (lastMmlCompiled && lastMmlCompiled.channelLetters) || null,
    getMmlTempo: currentMmlTempo,
    // 重ね録り: 再生中かどうかと、打鍵の時刻→曲の位置 の変換
    getPlaybackClock,
    getSongTimeAt: (ctxTime) => {
      const p = currentTransportPlayer();
      return (p && typeof p.songTimeAt === 'function') ? p.songTimeAt(ctxTime) : null;
    },
    // 既に音符が書かれているチャンネル文字(重ね録りの書き出し先を未使用へ寄せる)
    getUsedLetters: () => {
      try { return Object.keys(MML.Mml.splitChannels(mmlSourceEl.value).channels); }
      catch (e) { return []; }
    }
  });

  // MML本文の最初の t<n> を返す(無ければnull)。判定規則はコンパイラのグローバルテンポ
  // 決定(src/mml/compiler.js「グローバルテンポ」)と同じ splitChannels+tokenize にしてあり、
  // 「メトロノームのテンポと実際の再生テンポが食い違う」ことが起きないようにしている。
  // compile()を通さないのは、まだ一度も再生していないMMLでも追従させたいため。
  let mmlTempoCache = { src: null, bpm: null };
  function currentMmlTempo() {
    const src = mmlSourceEl.value;
    if (mmlTempoCache.src === src) return mmlTempoCache.bpm;
    let bpm = null;
    try {
      const { channels } = MML.Mml.splitChannels(src);
      for (const ch of Object.keys(channels)) {
        const tok = MML.Mml.tokenize(channels[ch].text).find(t => t.type === 'tempo');
        if (tok && Number.isFinite(tok.value) && tok.value > 0) { bpm = tok.value; break; }
      }
    } catch (e) { /* 編集途中の壊れたMMLは静かに諦める(手動テンポへ落ちる) */ }
    mmlTempoCache = { src, bpm };
    return bpm;
  }
  // シークバー(range input)の入力→シーク。主/副どのインスタンスからでも同じ処理
  // ★シークは「まとめて1回」にする(2026-09-04)。<input type="range"> はドラッグ中
  //   1ピクセル動くごとに input を撃つので、素直に毎回シークすると重い曲で固まる。
  //   形式によってはシーク1回が数百ms(曲頭からコマンドを早送りするため。実測:
  //   バーチャレーシングデラックス「Replay」で1回543ms)で、ドラッグ中に数十回積もると
  //   ブラウザが数秒〜数十秒止まる(ユーザー報告「シークするとものすごいガクつく」)。
  //   時間表示とハンドルは即座に動かし、実シークだけを間引く(最後の位置へは必ず行く)。
  const SEEK_COALESCE_MS = 120;
  function setupSeekBarInput(inst) {
    let timer = null;
    let pending = null;
    const run = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pending === null) return;
      const { want, total } = pending;
      pending = null;
      const got = seekToSeconds(want);
      // バッファ済み範囲より先へはシークできないので、ハンドル自体を実際にシークした位置へ
      // スナップバックする(seekToSeconds()のクランプ参照)
      if (got !== null && got < want) setSeekBarValue(Math.round((got / total) * SEEK_RESOLUTION));
    };
    inst.barEl.addEventListener('input', () => {
      const frac = parseInt(inst.barEl.value, 10) / SEEK_RESOLUTION;
      const total = currentTransportPlayer() ? workletDuration : (capturedBuffer ? capturedBuffer.duration : 0);
      if (!total) return;
      pending = { want: frac * total, total };
      setTimeDisplay(`${formatTime(pending.want)} / ${formatTime(total)}`); // 表示だけ先に追随させる
      // ドラッグ中(inputが連射される間)は実シークを後ろへ倒し続け、手が止まったら1回だけ実行
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, SEEK_COALESCE_MS);
    });
    // 離した瞬間/クリック/キー操作は change が来るので、そこで待たずに最終位置へ飛ぶ
    inst.barEl.addEventListener('change', run);
  }
  setupSeekBarInput(seekBars[0]);
  // 鍵盤表示のピアノロール見出し行にも同じシークバー(副インスタンス)を置く。
  // (keyboardDisplay生成直後ではなくここで行うのは、seekBars等がこの位置で初期化されるため)
  {
    const inst = createSeekBarInstance();
    keyboardDisplay.setRollSeekBar(inst.wrapEl, inst.timeEl);
  }
  initMiniTransport(); // ミニ操作窓も同じ副インスタンスを1本使うので、seekBarsが揃うここで作る

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
    MML.Convert.ChannelPlan.newFile("spc", SPC_DEFAULT_TARGETS, file.name); // 新ファイル: チャンネル割当(案E)をリセット
    setKbdSource('spc', file.name);
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
    // ★停止ではロールを消さない(別の曲を再生し始めるときだけ消す)。止めた状態でも
    //   ロールとドラムパッドを見られる・試聴できるようにするため(ユーザー要望)
    updateSpcPlayButton();
  }

  function updateSpcPlayButton() {
    const btn = document.getElementById('btnSpcFilePlay');
    if (!btn) return;
    const playing = spcActivePlayer && spcActivePlayer.isPlaying;
    btn.classList.toggle('is-playing', !!playing);
    btn.title = playing ? T('一時停止') : T('再生');
    btn.disabled    = spcIsRendering;
    updateKeyboardTransport();
  }

  // SPC captureAsync() の結果(log)からピアノロール用タイムライン(共通形状)を構築する。
  // SPCは完全リアルタイム合成で先読みデータを持たないため、再生開始と同時に裏で
  // captureAsync を走らせ、完了次第このタイムラインを keyboardDisplay へ反映する。
  //
  // MML.SPC2MML.extractVoiceEvents(MML変換のconvert()と共用)をそのまま使う。ロールは
  // MML変換の出力を目で確認できる「デバッガ」的な役割も持たせたいため、ロール専用の
  // 抽出ロジックを別途持たず、MML変換と全く同じ抽出結果を描画する(ポルタメント/レガート
  // 対応はextractVoiceEvents側で行う。src/spc2mml/converter.js参照)。
  // SPCのロールタイムライン構築はMML.RollBuild.spc(src/audio/roll-builders.js)へ移設
  // (キャプチャWorker内で構築するため。他フォーマットも同様)

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
    setKbdSource('spc', fileInputName(spcFileEl));
    spcBufferedFraction = 0;
    updateSeekBufferedUI();

    const duration = parseInt(spcPlayDurEl.value, 10) || 180;
    // 指定時間ぶん鳴らした後さらにFADE_SEC秒フェードアウトする仕様のため、実際の
    // キャプチャ/再生長はduration+FADE_SECにする(playNsfStream冒頭コメント参照)。
    // SPCは曲送りが無いのでフェード後は単に停止するだけになる。
    const captureDuration = duration + FADE_SEC;

    // NSF/KSS実ファイル再生と同じ理由(二重エミュレーション解消・シーク・再生中ライブミュート
    // 対応)で、ライブ再生用プレイヤーとロール先読みキャプチャを1本のバックグラウンド
    // キャプチャに統合する(NsfReplayStreamPlayer/KssReplayStreamPlayerと対になる
    // SpcReplayStreamPlayer、src/audio/spc-stream-player.js)。ただしSPCはNSF/KSSと違い
    // regsOnly相当の軽量ショートカットが存在せず(MML.SPC2MML.captureAsyncは元から
    // CPU+DSPフル駆動の実コスト計算)、今回の統合の主眼は「軽量化」ではなく「ライブ
    // 再生用と先読み用の2本を同時に走らせてCPUを食い合っていたのを1本にまとめる」こと。
    const player = new MML.Audio.SpcReplayStreamPlayer(audioCtx);
    player._baseGain = player.gainNode.gain.value;
    attachAssignPreview(player);
    endFadeActive = false;
    player.onEnded = () => {
      updateSpcPlayButton();
      updateTransportUI();
      // NsfReplayStreamPlayerと同じレース対策(onEnded参照)。SPCは曲送りが無いので停止のみ。
      setTimeout(() => { if (currentTransportPlayer() === player) finishSoundFilePlayback(); }, 0);
    };
    spcActivePlayer = player;
    player.setSpeed(currentSpeedFactor);
    workletDuration = captureDuration;

    resetPlaybackRangeToFull(captureDuration);
    setSeekBarValue(0);
    setTimeDisplay(`00:00 / ${formatTime(captureDuration)}`);

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
    let spcBrrSamples = null;
    try {
      spcBrrSamples = MML.SPC2MML.capture(loadedSpcBytes, 0.05).brrSamples;
      spcFineTune = MML.SPC2MML.computeSrcnFineTune(spcBrrSamples);
    } catch (_) { /* 失敗時は補正なし(従来動作)で続行 */ }
    // ライブ鍵盤(updateVoiceMonitor)も同じ補正で表示するため共有する
    spcActiveFineTune = spcFineTune;
    spcActiveBrrSamples = spcBrrSamples;
    spcPitchSrcnCache = null;
    // 打楽器/音階の手動上書き(BRR内容ハッシュ→kind)。ロール(Worker)と変換の両方へ渡す
    const spcDrumKinds = spcDrumKindsOf(spcBrrSamples);
    // 曲が変わるのでドラムパッド台帳/打点プロバイダ(前の曲・前の形式のもの)を捨てる
    drumSampleStore = {};
    drumHitsProvider = null;
    synthDrumReset();
    keyboardDisplay.setDpcmCost(null);

    // バックグラウンドキャプチャ。ピアノロールと実再生の両方の情報源を兼ねる。
    // onProgressで途中経過(その時点までのframeLog、進行中の配列への参照なので以後
    // キャプチャが進むにつれ自動的に埋まっていく)を受け取り、最初の1回でplayer.load()
    // して再生を開始する(以降のチャンクを待つ必要はない)。
    //
    // ロールのタイムライン構築はキャプチャWorker内で行い、onRollで完成品を受け取る
    keyboardDisplay.setRollTimeline(null);
    const myRollToken = ++spcRollToken;
    let spcPlaybackLoaded = false;
    // captureSpcSongWorkerAsync: SPC700+DSPエミュレーションをWeb Workerで実行
    // (NSF/KSS/GBS/VGMと同じ仕組み、src/audio/capture-worker-client.js。Worker不可時は
    // メインスレッド版captureAsyncへ自動フォールバック)。SPCはフレームレンダリングが
    // 特に重く(CPU+DSPフル駆動)、Worker化の体感効果が最も大きいフォーマット。
    MML.Emu.captureSpcSongWorkerAsync(loadedSpcBytes, captureDuration, (frame, frames, frameLog) => {
      if (myRollToken !== spcRollToken) return; // 曲切替/停止で無効化済み

      if (!spcPlaybackLoaded) {
        spcPlaybackLoaded = true;
        player.load(loadedSpcBytes, frames, frameLog, effectiveSpcMute());
        player.applyVolume(keyboardDisplay.getSpcVolumeConfig());
        transportPlay();
      }

      spcBufferedFraction = frames > 0 ? frame / frames : 0;
      updateSeekBufferedUI();
    }, () => myRollToken !== spcRollToken, {
      fineTune: spcFineTune,
      drumKinds: spcDrumKinds,
      onRoll: (timeline) => {
        if (myRollToken !== spcRollToken) return;
        pushRollTimeline(timeline);
      }
    }).then((res) => {
      // キャプチャ完了: 打楽器サンプルの打点/PCMをドラムパッド台帳と打点プロバイダへ
      // (HES/VGMと同じ役割。判定と打点はMML変換と同じ MML.SPC2MML.drumSrcns/drumHits)
      if (myRollToken !== spcRollToken || !res || !res.log) return;
      updateSpcDrumSamples(res.log, spcBrrSamples, spcFineTune, spcDrumKinds);
      synthDrumEnsure(); // 打楽器化(E選択)済みの合成音chがあれば全長でレンダリングし直す
      refreshDrumPanel();
      scheduleDpcmCostUpdate();
    }).catch((e) => {
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
    spcFileStatusEl.innerHTML = '<div>' + T('WAV書き出し中… {pct}%', { pct: 0 }) + '</div>';
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
    // 出力形式(WAV / レジスタログ)は鍵盤表示の「出力形式」で選ぶ。以前は必ず両方出ていた
    if (exportMode !== 'reglog') {
      const file = await downloadExportAudio(name, [audioL, audioR], sampleRate, 2.0, spcFileStatusEl);
      spcFileStatusEl.innerHTML = '<div class="ok">' + T('書き出し完了: {file}', { file }) + '</div>';
      return;
    }

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
      '<div class="ok">' + T('書き出し完了: {name}_dsp_log.csv<br>DSP書き込み {writes} 件 / KON {kon} 件 (先頭{sec}秒)',
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

    // チャンネルマップを鍵盤表示のチャンネル割当(src/convert/channelPlan.js)から取得。
    // 以前はボイスモニターのカード内selectから読んでいたが、割当UIは鍵盤表示へ集約した。
    // tone: 借用先ごとの音色選択 / volPct: 変換音量%(共通規約、src/convert/options.js)
    const Plan = MML.Convert.ChannelPlan;
    const channelMap = Array.from({ length: 8 }, (_, ch) => {
      const id = `V${ch}`;
      const ent = Plan.get(id) || {};
      const type = ent.target || SPC_DEFAULT_TARGETS[id] || 'skip';
      const toneKind = Plan.toneKindFor(type);
      const tone = toneKind
        ? (ent.tone !== undefined ? ent.tone : Plan.toneOptionsFor(toneKind, 'any').def)
        : undefined;
      return { type, tone, volPct: ent.volPct !== undefined ? ent.volPct : 100 };
    });

    const spcManualBpm = getManualBpm('spc');
    let result;
    try {
      // 再生時間欄(ID666の演奏時間=フェード抜きが自動入力される)どおりにキャプチャする。
      // 以前はMath.min(duration, 60)で60秒に切り詰めていた。長い曲でもUIが固まらないよう
      // 同期版fromSpcでなくチャンク実行のcaptureAsync(進捗表示付き)を使う。
      const { log, brrSamples, envLog } = await MML.SPC2MML.captureAsync(loadedSpcBytes, duration,
        makeCaptureProgress(spcFileStatusEl));
      result = MML.SPC2MML.convert(log, brrSamples, { envLog, channelMap, bpm: spcManualBpm, cmd: MML.UI.ConvertSettings.get(),
        drumKinds: spcDrumKindsOf(brrSamples), toneSettings: planConvertOptions().toneSettings });
    } catch (e) {
      spcIsRendering = false;
      spcFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }

    spcIsRendering = false;
    updateSpcPlayButton();

    // MML エディタへ出力
    resetMmlForNewSong(); // 別の曲になるのでログ/ファイル名/外部同期は引き継がない
    mmlSourceEl.value = result.mml;
    noteToneDemotions(result);
    resetDpcmEditor();
    mmlSourceEl.dispatchEvent(new Event('input'));

    // 抽出したFDS/N163波形を波形エディタへ反映(getMmlOpt()はここからのみ波形を読むため)
    if (result.fdsWave && MML.WaveformEditor.fdsWave) MML.WaveformEditor.fdsWave.setData(result.fdsWave);
    if (result.n163Wave && MML.WaveformEditor.n163Wave) MML.WaveformEditor.n163Wave.setData(result.n163Wave);

    // .dmc は台帳へ(保存時に同じフォルダへ書き出せる)
    takeDpcmFiles(result.dmcFiles);

    const dmcMsg = (result.dmcFiles && result.dmcFiles.length > 0)
      ? T('、DPCM {n} ファイル出力', { n: result.dmcFiles.length }) : '';
    const expList = (result.expansions && result.expansions.length) ? result.expansions.join(', ')
      : (result.expansion !== 'none' ? result.expansion : '');
    const expMsg = expList ? T('、拡張音源: {chips}', { chips: expList }) : '';
    spcFileStatusEl.innerHTML = '<div class="ok">' +
      T('MML変換完了 ({mode} {bpm} BPM{exp}{dpcm}) → MMLエディタに出力',
        { mode: spcManualBpm ? T('指定') : T('推定'), bpm: result.bpm, exp: expMsg, dpcm: dmcMsg }) + '</div>' +
      renderTuning(result.tuning) + renderPitchCheck(result.pitchCheck);

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
  // 再生中の曲のBRRサンプル表(srcn → {bytes,...})。パッド/割当UI側から「音階として扱う」
  // 指定(srcn集合)を引くのに使う(spcPitchSrcnSet)
  let spcActiveBrrSamples = null;
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

  // SPCの既定の借用先(V0-V7 → NSF側のパート)。従来の DEFAULT_TARGET_TYPES と同じ値で、
  // 鍵盤表示のチャンネル割当(src/convert/channelPlan.js)へ既定として渡す。
  // 借用先の一覧・ラベル・音色選択肢はすべて channelPlan.js に集約済み(以前はここに
  // TARGET_OPTIONS/buildTargetSelect があり、ボイスモニターのカード内にselectを出していた)。
  const SPC_DEFAULT_TARGETS = { V0: 'pulse1', V1: 'pulse2', V2: 'triangle', V3: 'noise',
    V4: 'skip', V5: 'skip', V6: 'skip', V7: 'skip' };

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
      // 借用先/音色/変換音量の選択は鍵盤表示のチャンネル割当(案E)へ集約したのでここには置かない
      voicePanelEl.appendChild(div);

      // ミュートボタン（停止・WAV書き出しをまたいで状態保持）
      div.querySelector(`#spc-v${ch}-mute`).addEventListener('click', (e) => {
        e.stopPropagation();
        spcMutedVoices ^= (1 << ch);           // 永続ミュート状態を更新
        // applyMute()経由にすることでSpcReplayStreamPlayer側が_lastMutedとして保持し、
        // シーク時の再構築(_buildChips())後も設定が消えないようにする(dsp.mutedVoicesを
        // 直接上書きするだけだと再構築のたびにリセットされてしまう)。
        if (spcActivePlayer) spcActivePlayer.applyMute(effectiveSpcMute());
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

  // 大波形パネル用: 素のBRR値(現ブロック16点)・ガウス補間後の連続波形(同じ横軸=サンプル位置)・
  // 現在ピッチで実際に出る出力サンプル(点)・(PM有効chなら)ピッチ変調後の出力サンプル(点)を
  // 非破壊プレビューで生成する(dspの実状態は変更しない。Emu.previewVoiceWave 参照)。
  // 横軸は全レイヤーとも「現ブロック内のサンプル位置 0〜16」で、BRRの階段と補間曲線が重なる。
  function buildSpcWaveLayers(v, dsp, pitchVal, ch, pmOn, voices) {
    const raw = Array.from(v.brrBuf.subarray(4, 20), s => s / 32768);
    const pv = MML.Emu.previewVoiceWave(v, dsp, pitchVal);
    const curve = Array.from(pv.curve, s => s / 32768);
    const dots = (pts) => ({ data: pts.map(q => q.v / 32768), xs: pts.map(q => q.p / 16) });
    const out = dots(pv.points);
    let outPM = null;
    if (ch > 0 && pmOn) {
      const prevOut = voices[ch - 1].outSample;
      let modPitch = (pitchVal * (prevOut + 0x8000)) >> 15;
      modPitch = Math.max(0, Math.min(0x3FFF, modPitch));
      outPM = dots(MML.Emu.previewVoiceWave(v, dsp, modPitch).points);
    }
    return {
      t: 'wave', nx: 16, ny: 32768, signed: true,
      data: raw,
      layers: [
        { data: raw, mode: 'steps', color: '#8a8a98', label: T('素(BRR)') },
        { data: curve, mode: 'line', color: '#6ea8ff', label: T('ガウス補間') },
        { data: out.data, xs: out.xs, mode: 'dots', color: '#6ea8ff', label: T('出力サンプル') },
      ].concat(outPM ? [{ data: outPM.data, xs: outPM.xs, mode: 'dots', hollow: true, color: '#ff8844', label: T('PM変調後') }] : []),
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
      updateMuteButton(ch, spcMutedVoices); // dsp側はプレビューの消し込みを含むので、表示はユーザー指定のマスクで
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
      const wave = active ? buildSpcWaveLayers(v, dsp, pitch, ch, pmOn, voices) : null;
      spcVoices.push({
        label:  `V${ch}`,
        srcn,   // 鳴らしているサンプル番号。打楽器パッド化したサンプル(ロールの drumKey 'brr:<srcn>')は鍵盤の note 列に音階でなくこれを出す
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
    if (spcActivePlayer) spcActivePlayer.applyMute(effectiveSpcMute());
    updateMuteButton(idx, spcMutedVoices);
  };
  // ch別音量スライダー(V0〜V7)。SPCはミュートと同じくビットマスクではなく配列そのものを
  // 引き回す(applyVolume、src/audio/spc-stream-player.js参照)。
  keyboardDisplay.onSpcVolumeChange = (volArray) => {
    if (spcActivePlayer) spcActivePlayer.applyVolume(volArray);
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
  // 「to MML」は変換設定画面を開き、その中の「コンバート開始」で変換する(ユーザー要望)
  document.getElementById('btnSpc2Mml').addEventListener('click', () => MML.UI.ConvertSettings.open({ format: 'spc', onConvert: runSpc2Mml }));

  // ── KSS ファイル読み込み・再生 ────────────────────────────────────
  const kssFileEl       = document.getElementById('kssFile');
  const kssFileHeaderEl = document.getElementById('kssFileHeader');
  const kssPlayDurEl    = document.getElementById('kssPlayDuration');
  const kssFileStatusEl = document.getElementById('kssFileStatus');
  const kssSongIndexEl  = document.getElementById('kssSongIndex');
  const kssSongTotalEl  = document.getElementById('kssSongTotal');

  let loadedKssBytes  = null;
  let loadedKssHeader = null;
  // 再生中の先読みキャプチャの writeLog(進行中の配列への参照)。牌の魔術師の D/A の打点(kssDacDrumFor)が読む
  let kssCaptureWriteLog = null;
  let kssIsRendering  = false;
  let kssActivePlayer = null; // KssStreamPlayer

  // KSSで使う鍵盤表示チャンネル種別 (ヘッダのFMPAC有無・SCC使用有無で可変)。
  // SCCはKSSヘッダに現れないため「積んでいるか」はヘッダだけでは決まらない。
  // ・16Kバンクモード+RAMモードのファイルはバス側でSCCデコード自体を止めている
  //   (src/emulator/kssBus.js の sccDisable)ので確実に非搭載。
  // ・それ以外は先読みキャプチャでSCCレジスタへの実書込みを検出できたときだけ出す
  //   (PSG+FMPACだけの曲でKS1-KS5の空行が5行居座るのを防ぐ)。
  // kssHasSccDecoder / kssWriteLogUsesScc は MML.RollBuild(src/audio/roll-builders.js)へ
  // 移設(SCC使用判定はキャプチャWorker内のロール構築ジョブが行い、onRollのinfo.sccUsedで
  // 受け取る)
  function kssMonitorChips(header, sccUsed) {
    const chips = ['kss', 'kssPsg'];
    if (sccUsed) chips.push('kssScc');
    if (header && header.device.mode === 'MSX' && header.device.fmpac) chips.push('kssOpll');
    if (header && header.device.mode === 'MSX' && header.device.msxAudio) chips.push('opl'); // MSX-AUDIO(Y8950)=OL行
    if (header && header.device.mode === 'MSX' && header.device.majutsushiDac) chips.push('kssDac'); // 牌の魔術師 D/A=KDA行
    return chips;
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
    MML.Convert.ChannelPlan.newFile("kss", {}, file.name); // 新ファイル: チャンネル割当(案E)をリセット
    setKbdSource('kss', file.name);
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
      // 牌の魔術師の D/A(KDA行)の既定は E(DPCM)。音程を持たず、他に行き場が無い(VGM の YMDA と同じ)
      if (h.device.mode === 'MSX' && h.device.majutsushiDac) MML.Convert.ChannelPlan.setDefaults({ KDA: 'dpcm' });
      renderKssHeader(h);
      const first = h.hasSongRange ? h.firstSong : 0;
      const last = h.hasSongRange ? h.lastSong : 255;
      kssSongIndexEl.min = String(first);
      kssSongIndexEl.max = String(last);
      kssSongIndexEl.value = String(first);
      kssSongTotalEl.textContent = `/ ${last}`;
      kssFileStatusEl.innerHTML = '';
      updateKeyboardTransport(); // 曲数が確定したので鍵盤表示の⏮⏭の有効/無効を決め直す
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
    // ★停止ではロールを消さない(別の曲を再生し始めるときだけ消す)。止めた状態でも
    //   ロールとドラムパッドを見られる・試聴できるようにするため(ユーザー要望)
    updateKssPlayButton();
  }

  // KSSのロールタイムライン構築はMML.RollBuild.kss(src/audio/roll-builders.js)へ移設

  function updateKssPlayButton() {
    const btn = document.getElementById('btnKssFilePlay');
    if (!btn) return;
    const playing = kssActivePlayer && kssActivePlayer.isPlaying;
    btn.classList.toggle('is-playing', !!playing);
    btn.title = playing ? T('一時停止') : T('再生');
    btn.disabled = kssIsRendering;
    updateKeyboardTransport();
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
    setKbdSource('kss', fileInputName(kssFileEl));
    kssBufferedFraction = 0;
    updateSeekBufferedUI();

    const songNo = parseInt(kssSongIndexEl.value, 10) || 0;
    const duration = parseInt(kssPlayDurEl.value, 10) || 180;
    // 指定時間ぶん鳴らした後さらにFADE_SEC秒フェードアウトする仕様のため、実際の
    // キャプチャ/再生長はduration+FADE_SECにする(playNsfStream冒頭コメント参照)。
    const captureDuration = duration + FADE_SEC;
    const kssFrameRate = loadedKssHeader.device.palMode ? MML.KSS.PAL_FPS : MML.KSS.NTSC_FPS;
    const totalFrames = Math.ceil(captureDuration * kssFrameRate);

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
    attachAssignPreview(player);
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
    workletDuration = captureDuration;

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
        getKssOpll: liveKssOpll,
        getKssDac: liveKssDac,
        getOpl: liveKssOpl
}, () => kssActivePlayer ? kssActivePlayer.getPosition() : 0, kssMonitorChips(loadedKssHeader, sccUsed));
      // ★setMonitorSource()はsetSource()経由でロールのタイムラインを必ず捨てる
      // (keyboard.js setSource末尾の this._rollTimeline = null)。既に受け取っている
      // 最新のタイムラインをここで戻さないと、onRollがonProgressより先に届いた場合に
      // ロールが空のまま復帰しない。曲送りでワーカーが温まっていると必ずこの順序になり、
      // 「前の絵が残ったまま音符が出ない/動かない」状態になっていた。
      if (kssLastRollTimeline) pushRollTimeline(kssLastRollTimeline);
    }

    resetPlaybackRangeToFull(captureDuration);
    setSeekBarValue(0);
    setTimeDisplay(`00:00 / ${formatTime(captureDuration)}`);

    kssFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = T('再生中: 曲{song}  (最大 {time})', { song: songNo, time: formatTime(duration) });
    kssFileStatusEl.appendChild(pre);

    // バックグラウンドキャプチャ(regsOnly)。ピアノロールと実再生の両方の情報源を兼ねる。
    // onProgressで途中経過(その時点までのwriteLog、進行中の配列への参照なので以後
    // キャプチャが進むにつれ自動的に埋まっていく)を受け取り、最初の1回でplayer.load()
    // して再生を開始する(以降のチャンクを待つ必要はない)。
    // ロールのタイムライン構築(SCC使用判定込み)はキャプチャWorker内で行い、
    // onRoll(timeline, info)で完成品を受け取る
    keyboardDisplay.setRollTimeline(null);
    const myKssRollToken = ++kssRollToken;
    // 曲が変わるのでドラムパッド台帳/打点プロバイダ/合成音chのレンダリング結果を捨てる
    drumSampleStore = {};
    drumHitsProvider = null;
    synthDrumReset();
    kssCaptureWriteLog = null;
    keyboardDisplay.setDpcmCost(null);
    // SCCは「使われたと分かった時点で行を足す」単調な運用にする(出したり消したりすると
    // 再生中に行数が揺れて見づらいため)。判定はWorker側のロール構築ジョブが行う。
    let kssSccUsed = false;
    let kssPlaybackLoaded = false;
    // 直近にWorkerから受け取ったロールのタイムライン。setMonitorSource()がロールを
    // 捨てた直後に復元するために保持する(applyKssMonitorSource参照)。曲ごとに作り直す
    // ローカル変数なので、前の曲のタイムラインが復元されることは無い。
    let kssLastRollTimeline = null;
    // captureKssSongWorkerAsync: エミュレーションをWeb Workerで実行(NSFと同じ仕組み、
    // src/audio/capture-worker-client.js。Worker不可時はメインスレッド版へ自動フォールバック)
    MML.Emu.captureKssSongWorkerAsync(loadedKssBytes, {
      songIndex: songNo, durationSeconds: captureDuration, sampleRate: audioCtx.sampleRate,
      regsOnly: true,
      shouldCancel: () => myKssRollToken !== kssRollToken,
      roll: {
        frameRate: kssFrameRate, header: loadedKssHeader,
        onRoll: (timeline, info) => {
          if (myKssRollToken !== kssRollToken) return;
          kssLastRollTimeline = timeline; // setMonitorSource後の復元用(applyKssMonitorSource参照)
          if (info.sccUsed && !kssSccUsed) {
            kssSccUsed = true;
            // SCC行を追加して鍵盤表示を組み直す(setMonitorSource()はロールも初期化する
            // ため、この直後のsetRollTimelineで必ず新しいタイムラインが入る)
            applyKssMonitorSource(kssSccUsed);
          }
          pushRollTimeline(timeline);
        }
      }
    }, (done, total, writeLog) => {
      if (myKssRollToken !== kssRollToken) return; // 曲切替/停止で無効化済み
      kssCaptureWriteLog = writeLog;

      if (!kssPlaybackLoaded) {
        kssPlaybackLoaded = true;
        player.load(loadedKssBytes, songNo, totalFrames, { writeLog }, getChannelMuteConfig());
        player.applyVolume(getChannelVolumeConfig());
        applyKssMonitorSource(kssSccUsed);
        transportPlay();
      }

      kssBufferedFraction = total > 0 ? done / total : 0;
      updateSeekBufferedUI();
    }).then(() => {
      // キャプチャ完了: 打楽器化(E選択)済みの合成音chがあれば全長でレンダリングする
      if (myKssRollToken !== kssRollToken) return;
      synthDrumEnsure();
      refreshDrumPanel();
      scheduleDpcmCostUpdate();
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
    let v = wrapIndex((parseInt(kssSongIndexEl.value, 10) || 0) + delta, min, max);
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
      songIndex: songNo, durationSeconds: duration, sampleRate, mute: getChannelMuteConfig(true).expansion
    }, (done, total) => {
      kssFileStatusEl.innerHTML = '<div>' + T('WAV書き出し中… {pct}%', { pct: Math.round(done / total * 100) }) + '</div>';
    });

    kssIsRendering = false;
    updateKssPlayButton();

    // 出力形式(WAV / レジスタログ)は鍵盤表示の「出力形式」で選ぶ。以前は必ず両方出ていた
    let filename;
    if (exportMode === 'reglog') {
      let csv = 'frame,addr_or_port,io,value\n';
      // ★KSS の writeLog は1件を1つの整数に詰めてある(src/emulator/capture.js Emu.kssPackWrite:
      //   bit0-15=addr/port, bit16-23=value, bit24=io)。以前は {addr,value,io} のオブジェクトとして読んでいて
      //   w.addr が undefined → 例外になり、レジスタログを選んで押しても何も起きなかった(2026-09-19 修正)
      result.writeLog.forEach((writes, f) => {
        for (const w of writes) {
          const packed = typeof w === 'number';
          const addr = packed ? (w & 0xFFFF) : w.addr;
          const value = packed ? ((w >>> 16) & 0xFF) : w.value;
          const io = packed ? !!(w & 0x1000000) : !!w.io;
          csv += `${f},0x${addr.toString(16).toUpperCase()},${io ? 1 : 0},0x${value.toString(16).toUpperCase().padStart(2,'0')}\n`;
        }
      });
      filename = `kss_song${songNo}_regs.csv`;
      downloadText(filename, csv);
    } else {
      filename = await downloadExportAudio(`kss_song${songNo}`, [result.audio], sampleRate, 2.5, kssFileStatusEl);
    }

    kssFileStatusEl.innerHTML = '<div class="ok">' + T('書き出し完了: {file}', { file: filename }) + '</div>';
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
      await synthDrumEnsure(); // 打楽器化したchの分離レンダリングを確定させる
      result = await MML.KSS2MML.fromKss(loadedKssBytes, songNo, duration, Object.assign({ bpm: kssManualBpm, cmd: MML.UI.ConvertSettings.get(), onProgress: makeCaptureProgress(kssFileStatusEl) }, planConvertOptions()));
    } catch (e) {
      kssIsRendering = false;
      updateKssPlayButton();
      kssFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }

    kssIsRendering = false;
    updateKssPlayButton();

    resetMmlForNewSong(); // 別の曲になるのでログ/ファイル名/外部同期は引き継がない
    mmlSourceEl.value = result.mml;
    noteToneDemotions(result);
    resetDpcmEditor();
    mmlSourceEl.dispatchEvent(new Event('input'));

    // 変換結果はNES拡張音源(FME-7/N163/VRC7)を借りて再生する設計。有効化はMML本文に
    // 埋め込まれた#EX-*ディレクティブで行われるため、波形エディタへの反映のみ行う
    if (result.n163Wave && MML.WaveformEditor.n163Wave) MML.WaveformEditor.n163Wave.setData(result.n163Wave);
    // 打楽器化したch(E=DPCM)の .dmc は台帳へ(即再生でき、保存時に同じフォルダへ書き出せる)
    takeDpcmFiles(result.dpcmFiles);

    kssFileStatusEl.innerHTML =
      '<div class="ok">' + T('MML変換完了 ({mode} {bpm} BPM、音源: {chips}) → MMLエディタに出力(FME-7/N163/VRC7を借用して再生)',
        { mode: kssManualBpm ? T('指定') : T('推定'), bpm: result.bpm, chips: result.chips.join(', ') }) + '</div>' +
      renderTuning(result.tuning) + renderPitchCheck(result.pitchCheck);

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
  // 「to MML」は変換設定画面を開き、その中の「コンバート開始」で変換する(ユーザー要望)
  document.getElementById('btnKss2Mml').addEventListener('click', () => MML.UI.ConvertSettings.open({ format: 'kss', onConvert: runKss2Mml }));
  document.getElementById('btnKssSongPrev').addEventListener('click', () => changeKssSong(-1));
  document.getElementById('btnKssSongNext').addEventListener('click', () => changeKssSong(1));

  // ── GBS ファイル読み込み・再生 ────────────────────────────────────
  // KSS/NSFと同じく背景先読みキャプチャ(captureGbsSongAsync)+ピアノロール+
  // ライブモニタ連携+シーク(scrub)に対応済み(GbsReplayStreamPlayer、KSSの
  // KssReplayStreamPlayerと同型)。lastPlayMode==='gbs'もcanSeek()のシーク対応リストに
  // 含まれている。
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
    MML.Convert.ChannelPlan.newFile("gbs", {}, file.name); // 新ファイル: チャンネル割当(案E)をリセット
    setKbdSource('gbs', file.name);
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
      updateKeyboardTransport(); // 曲数が確定したので鍵盤表示の⏮⏭の有効/無効を決め直す
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
    // ★停止ではロールを消さない(別の曲を再生し始めるときだけ消す)。止めた状態でも
    //   ロールとドラムパッドを見られる・試聴できるようにするため(ユーザー要望)
    updateGbsPlayButton();
  }

  // captureGbsSongAsync() の結果(snapshots)からピアノロール用タイムライン(共通形状)を
  // 構築する。src/gbs2mml/expansion/*.js の抽出関数をenvReg/waveReg無し(ロールは
  // 音色番号/エンベロープを必要としない)で呼び出すのはMML.RollBuild.kss(roll-builders.js)と同じ考え方。
  // GBSのロールタイムライン構築はMML.RollBuild.gbs(src/audio/roll-builders.js)へ移設

  function updateGbsPlayButton() {
    const btn = document.getElementById('btnGbsFilePlay');
    if (!btn) return;
    const playing = gbsActivePlayer && gbsActivePlayer.isPlaying;
    btn.classList.toggle('is-playing', !!playing);
    btn.title = playing ? T('一時停止') : T('再生');
    btn.disabled = gbsIsRendering;
    updateKeyboardTransport();
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
    setKbdSource('gbs', fileInputName(gbsFileEl));
    gbsBufferedFraction = 0;
    updateSeekBufferedUI();

    // ヘッダのfirstSongは1始まり(表示用)。INIT呼出は0始まりの曲番号を渡す仕様
    // (src/gbs/gbsHeader.js・src/emulator/gbsPlayer.js参照)。
    const songNoDisplay = parseInt(gbsSongIndexEl.value, 10) || loadedGbsHeader.firstSong;
    const songIndex = Math.max(0, songNoDisplay - loadedGbsHeader.firstSong);
    const duration = parseInt(gbsPlayDurEl.value, 10) || 180;
    // 指定時間ぶん鳴らした後さらにFADE_SEC秒フェードアウトする仕様のため、実際の
    // キャプチャ/再生長はduration+FADE_SECにする(playNsfStream冒頭コメント参照)。
    const captureDuration = duration + FADE_SEC;
    const gbsFrameRate = loadedGbsHeader.playFps;
    const totalFrames = Math.ceil(captureDuration * gbsFrameRate);

    // NSF/KSSと同じ理由(二重エミュレーション解消・シーク対応)で、ライブ再生用プレイヤーと
    // ロール先読みキャプチャを1本のバックグラウンドregsOnlyキャプチャに統合する
    // (KssReplayStreamPlayerと対になるGbsReplayStreamPlayer、src/audio/gbs-stream-player.js)。
    const player = new MML.Audio.GbsReplayStreamPlayer(audioCtx);
    player._baseGain = player.gainNode.gain.value;
    attachAssignPreview(player);
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
    workletDuration = captureDuration;

    resetPlaybackRangeToFull(captureDuration);
    setSeekBarValue(0);
    setTimeDisplay(`00:00 / ${formatTime(captureDuration)}`);

    gbsFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = T('再生中: 曲{song}  (最大 {time})', { song: songNoDisplay, time: formatTime(duration) });
    gbsFileStatusEl.appendChild(pre);

    // バックグラウンドキャプチャ(regsOnly)。ピアノロールと実再生の両方の情報源を兼ねる。
    // onProgressで途中経過(その時点までのsnapshots、進行中の配列への参照なので以後
    // キャプチャが進むにつれ自動的に埋まっていく)を受け取り、最初の1回でplayer.load()
    // して再生を開始する(以降のチャンクを待つ必要はない)。
    // ロールのタイムライン構築はキャプチャWorker内で行い、onRollで完成品を受け取る
    keyboardDisplay.setRollTimeline(null);
    const myGbsRollToken = ++gbsRollToken;
    // 曲が変わるのでドラムパッド台帳/打点プロバイダ/合成音chのレンダリング結果を捨てる
    drumSampleStore = {};
    drumHitsProvider = null;
    synthDrumReset();
    keyboardDisplay.setDpcmCost(null);
    let gbsPlaybackLoaded = false;
    let gbsLastRollTimeline = null; // setMonitorSource後の復元用(KSSと同じ理由)
    // captureGbsSongWorkerAsync: エミュレーションをWeb Workerで実行(NSF/KSSと同じ仕組み、
    // src/audio/capture-worker-client.js。Worker不可時はメインスレッド版へ自動フォールバック)
    MML.Emu.captureGbsSongWorkerAsync(loadedGbsBytes, {
      songIndex, durationSeconds: captureDuration, sampleRate: audioCtx.sampleRate,
      regsOnly: true,
      shouldCancel: () => myGbsRollToken !== gbsRollToken,
      roll: {
        frameRate: gbsFrameRate,
        onRoll: (timeline) => {
          if (myGbsRollToken !== gbsRollToken) return;
          gbsLastRollTimeline = timeline; // setMonitorSource後の復元用(KSSと同じ理由)
          pushRollTimeline(timeline);
        }
      }
    }, (done, total, data) => {
      if (myGbsRollToken !== gbsRollToken) return; // 曲切替/停止で無効化済み

      if (!gbsPlaybackLoaded) {
        gbsPlaybackLoaded = true;
        player.load(loadedGbsBytes, songIndex, totalFrames, { snapshots: data.snapshots }, getChannelMuteConfig());
        player.applyVolume(getChannelVolumeConfig());
        // 鍵盤表示: GB APUをライブチップから直接スナップショットする(KSSのapplyKssMonitorSourceと同じ考え方)。
        setMonitorSource({
          regSnapshots: [{}], totalFrames: 1,
          samplesPerFrame: audioCtx.sampleRate / gbsFrameRate,
          sampleRate: audioCtx.sampleRate,
          writeLog: [], cpuSnapshots: null, memSnapshots: null,
          getGbsApu: liveGbsApu
        }, () => gbsActivePlayer ? gbsActivePlayer.getPosition() : 0, ['gbs']);
        // setMonitorSource()はロールを捨てるので、既に届いていれば戻す(KSSと同じ)
        if (gbsLastRollTimeline) keyboardDisplay.setRollTimeline(gbsLastRollTimeline);
        transportPlay();
      }

      gbsBufferedFraction = total > 0 ? done / total : 0;
      updateSeekBufferedUI();
    }).then(() => {
      // キャプチャ完了: 打楽器化(E選択)済みの合成音chがあれば全長でレンダリングする
      if (myGbsRollToken !== gbsRollToken) return;
      synthDrumEnsure();
      refreshDrumPanel();
      scheduleDpcmCostUpdate();
    }).catch((e) => {
      // 先読み失敗時はピアノロールなしで続行するが、原因を追えるようログには残す(KSSと同じ理由)
      console.error('GBS先読みキャプチャに失敗:', e);
    });
  }

  function changeGbsSong(delta) {
    const min = parseInt(gbsSongIndexEl.min, 10) || 0;
    const max = parseInt(gbsSongIndexEl.max, 10) || 0;
    let v = wrapIndex((parseInt(gbsSongIndexEl.value, 10) || 0) + delta, min, max);
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
    // ★2026-08-22: WAV書き出しにも鍵盤のch別ミュート/音量を反映(VGMと同じ抜けがあった)。
    // GbsPlayer自体にはapplyMuteが無く、gbs-stream-player.jsと同じくapuへ直接入れる。
    applyChannelSettingsToApu(player.apu, 'gb');
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

    // NR51(パンレジスタ)を反映したステレオ出力。gainはリミッタ側で適用済みなので1.0。
    const filename = await downloadExportAudio(`gbs_song${songNoDisplay}`, [limitedL, limitedR], sampleRate, 1.0, gbsFileStatusEl);

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
      await synthDrumEnsure(); // 打楽器化したchの分離レンダリングを確定させる
      result = await MML.GBS2MML.fromGbs(loadedGbsBytes, songIndex, duration, Object.assign({ bpm: gbsManualBpm, cmd: MML.UI.ConvertSettings.get(), onProgress: makeCaptureProgress(gbsFileStatusEl) }, planConvertOptions()));
    } catch (e) {
      gbsIsRendering = false;
      updateGbsPlayButton();
      gbsFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }

    gbsIsRendering = false;
    updateGbsPlayButton();

    resetMmlForNewSong(); // 別の曲になるのでログ/ファイル名/外部同期は引き継がない
    mmlSourceEl.value = result.mml;
    noteToneDemotions(result);
    resetDpcmEditor();
    mmlSourceEl.dispatchEvent(new Event('input'));

    // 変換結果はNES拡張音源(FDS)を借りて再生する設計。有効化はMML本文に埋め込まれた
    // #EX-*ディレクティブで行われるため、波形エディタへの反映のみ行う
    if (result.fdsWave && MML.WaveformEditor.fdsWave) MML.WaveformEditor.fdsWave.setData(result.fdsWave);
    // 打楽器化したch(E=DPCM)の .dmc は台帳へ(即再生でき、保存時に同じフォルダへ書き出せる)
    takeDpcmFiles(result.dpcmFiles);

    gbsFileStatusEl.innerHTML =
      '<div class="ok">' + T('MML変換完了 ({mode} {bpm} BPM、音源: {chips}) → MMLエディタに出力(FDSを借用して再生)',
        { mode: gbsManualBpm ? T('指定') : T('推定'), bpm: result.bpm, chips: result.chips.join(', ') }) + '</div>' +
      renderTuning(result.tuning) + renderPitchCheck(result.pitchCheck);

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
  // 「to MML」は変換設定画面を開き、その中の「コンバート開始」で変換する(ユーザー要望)
  document.getElementById('btnGbs2Mml').addEventListener('click', () => MML.UI.ConvertSettings.open({ format: 'gbs', onConvert: runGbs2Mml }));
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
    MML.Convert.ChannelPlan.newFile("hes", {}, file.name); // 新ファイル: チャンネル割当(案E)をリセット
    setKbdSource('hes', file.name);
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
    // ★停止ではロールを消さない(別の曲を再生し始めるときだけ消す)。止めた状態でも
    //   ロールとドラムパッドを見られる・試聴できるようにするため(ユーザー要望)
    updateHesPlayButton();
  }

  // captureHesSongAsync() の結果(snapshots)からピアノロール用タイムライン(共通形状)を
  // 構築する。src/hes2mml/expansion/*.js の抽出関数をenvReg/waveReg無し(ロールは
  // 音色番号/エンベロープを必要としない)で呼び出すのはMML.RollBuild.kss(roll-builders.js)と同じ考え方。
  // HESのロールタイムライン構築はMML.RollBuild.hes(src/audio/roll-builders.js)へ移設

  function updateHesPlayButton() {
    const btn = document.getElementById('btnHesFilePlay');
    if (!btn) return;
    const playing = hesActivePlayer && hesActivePlayer.isPlaying;
    btn.classList.toggle('is-playing', !!playing);
    btn.title = playing ? T('一時停止') : T('再生');
    btn.disabled = hesIsRendering;
    updateKeyboardTransport();
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
    setKbdSource('hes', fileInputName(hesFileEl));
    hesBufferedFraction = 0;
    updateSeekBufferedUI();

    const track = parseInt(hesTrackIndexEl.value, 10) || 0;
    const duration = parseInt(hesPlayDurEl.value, 10) || 180;
    // 指定時間ぶん鳴らした後さらにFADE_SEC秒フェードアウトする仕様のため、実際の
    // キャプチャ/再生長はduration+FADE_SECにする(playNsfStream冒頭コメント参照)。
    const captureDuration = duration + FADE_SEC;
    const hesFrameRate = MML.HES.VBLANK_FPS;
    const totalFrames = Math.ceil(captureDuration * hesFrameRate);

    // ★2026-08 PCM(DDA)対応前の設計に戻した(GBS/KSSと同じHesReplayStreamPlayer、
    // ユーザー要望)。CPU駆動のリアルタイム合成(HesStreamPlayer)や事前一括レンダリング
    // (HesBufferedPlayer、いずれもsrc/audio/hes-stream-player.jsに定義は残したまま)は
    // DDA(PCM)の高頻度書込みを正確に再現するために順に試したが、いずれも「がくがく」
    // する・鍵盤表示が働かない等の副作用が解消しきれなかったため、まずは安定していた
    // この方式へ戻す。PCM(DDA)を使う曲の音は再びこの方式の制約(フレーム単位の
    // スナップショットでは追いきれない)を受ける。
    const player = new MML.Audio.HesReplayStreamPlayer(audioCtx);
    player._baseGain = player.gainNode.gain.value;
    attachAssignPreview(player);
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
    workletDuration = captureDuration;

    resetPlaybackRangeToFull(captureDuration);
    setSeekBarValue(0);
    setTimeDisplay(`00:00 / ${formatTime(captureDuration)}`);

    hesFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = T('再生中: トラック{track}  (最大 {time})', { track, time: formatTime(duration) });
    hesFileStatusEl.appendChild(pre);

    // バックグラウンドキャプチャ(regsOnly)。ピアノロールと実再生の両方の情報源を兼ねる。
    // ロールのタイムライン構築(DDA担当ch判定込み)はキャプチャWorker内で行い、
    // onRoll(timeline, info)で完成品を受け取る
    keyboardDisplay.setRollTimeline(null);
    const myHesRollToken = ++hesRollToken;
    // 曲が変わるのでドラムパッド台帳/打点プロバイダ(前の曲・前の形式のもの)を捨てる
    drumSampleStore = {};
    drumHitsProvider = null;
    synthDrumReset();
    keyboardDisplay.setDpcmCost(null);
    let hesPlaybackLoaded = false;
    let hesLastRollTimeline = null; // setMonitorSource後の復元用(KSSと同じ理由)
    let hesLatestData = null; // onRollでsetDdaChannelに渡す生dpcmTrace(進行中の鏡像)への参照
    // captureHesSongWorkerAsync: HuC6280+APUエミュレーションをWeb Workerで実行
    // (他5フォーマットと同じ仕組み、src/audio/capture-worker-client.js。Worker不可時は
    // メインスレッド版へ自動フォールバック)
    MML.Emu.captureHesSongWorkerAsync(loadedHesBytes, {
      track, durationSeconds: captureDuration, sampleRate: audioCtx.sampleRate,
      regsOnly: true,
      shouldCancel: () => myHesRollToken !== hesRollToken,
      roll: {
        frameRate: hesFrameRate,
        onRoll: (timeline, info) => {
          if (myHesRollToken !== hesRollToken) return;
          hesLastRollTimeline = timeline; // setMonitorSource後の復元用(KSSと同じ理由)
          pushRollTimeline(timeline);
          // DDA(PCM)担当ch: 判定(曲全体でDDA区間が最も長い1ch)はWorker側ジョブが行い、
          // 実際の再生に使う生のdpcmTrace列はこちらが保持する鏡像から渡す
          // (hes-stream-player.js HesReplayStreamPlayer.setDdaChannel()参照)。
          if (info && info.ddaChannel !== undefined && hesLatestData) {
            player.setDdaChannel(info.ddaChannel,
              info.ddaChannel >= 0 ? hesLatestData.dpcmTrace[info.ddaChannel] : null);
          }
        }
      }
    }, (done, total, data) => {
      if (myHesRollToken !== hesRollToken) return; // 曲切替/停止で無効化済み
      hesLatestData = data;

      if (!hesPlaybackLoaded) {
        hesPlaybackLoaded = true;
        player.load(loadedHesBytes, track, totalFrames, { snapshots: data.snapshots }, getChannelMuteConfig());
        player.applyVolume(getChannelVolumeConfig());
        setMonitorSource({
          regSnapshots: [{}], totalFrames: 1,
          samplesPerFrame: audioCtx.sampleRate / hesFrameRate,
          sampleRate: audioCtx.sampleRate,
          writeLog: [], cpuSnapshots: null, memSnapshots: null,
          getHesApu: liveHesApu
        }, () => hesActivePlayer ? hesActivePlayer.getPosition() : 0, ['hes']);
        // setMonitorSource()はロールを捨てるので、既に届いていれば戻す(KSSと同じ)
        if (hesLastRollTimeline) pushRollTimeline(hesLastRollTimeline);
        transportPlay();
      }

      hesBufferedFraction = total > 0 ? done / total : 0;
      updateSeekBufferedUI();
    }).then(() => {
      // キャプチャ完了: DDA(PCM)の打点/サンプルをドラムパッド台帳と打点プロバイダへ
      // (VGMの updateVgmDrumSamples と同じ役割。抽出はMML変換と同じ ddaHits)
      if (myHesRollToken !== hesRollToken || !hesLatestData) return;
      updateHesDrumSamples(hesLatestData, hesFrameRate);
      synthDrumEnsure(); // 打楽器化(E選択)済みの合成音chがあれば全長でレンダリングし直す
      refreshDrumPanel();
      scheduleDpcmCostUpdate();
    }).catch((e) => {
      console.error('HES先読みキャプチャに失敗:', e);
    });
  }

  // NSF: DPCMサンプルの打点 → ドラムパッド台帳+打点プロバイダ。
  // 変換はROMバイト列そのまま(無損失)なので、コストは再エンコードせず実サイズを答える
  // (provider.stats)。パッド設定の「変換しない」を外したぶんは差し引く
  function updateNsfDrumSamples(writeLog, initRegs) {
    setDrumSampleStore({});
    drumHitsProvider = null;
    if (!writeLog || !loadedNsfBytes || !loadedNsfHeader || !MML.NSF2MML.dmcHits) return;
    let r;
    try { r = MML.NSF2MML.dmcHits(writeLog, loadedNsfBytes, loadedNsfHeader, { initRegs }); }
    catch (e) { console.warn('NSF DPCM打点の収集に失敗:', e); return; }
    if (!r.hits.length) return;
    const store = {};
    for (const k of Object.keys(r.samples)) {
      const s = r.samples[k];
      store[k] = { pcm: s.pcm, rate: s.rate, hash: s.hash, label: s.label, chip: 'nsf', chans: [0], bytes: s.bytes };
    }
    setDrumSampleStore(store);
    drumHitsProvider = {
      format: 'nsf', frameRate: 60.0988, totalFrames: writeLog.length,
      build: () => r.hits,
      listedKeys: () => Object.keys(store),
      stats: () => {
        const DS = MML.Convert.DrumSamples;
        let bytes = 0, clips = 0, segments = 0;
        const used = new Set();
        for (const h of r.hits) {
          const s = store[h.key];
          if (!s) continue;
          if (DS && s.hash && DS.get(s.hash).enabled === false) continue;
          segments++;
          if (!used.has(h.key)) { used.add(h.key); clips++; bytes += s.bytes.length; }
        }
        return { clips, bytes, segments, dropped: 0 };
      },
    };
  }

  // SPC: BRRサンプルごとの打楽器/音階の手動上書き(srcn → 'drum' | 'pitch')。
  // 指定の実体は Emu.SamplePitchUtil のkind上書き(内容ハッシュ、localStorage)なので、
  // 同じサンプルを使う別曲/別リビジョンでも効く(VGMのサンプルPCMと同じ流儀)
  function spcDrumKindsOf(brrSamples) {
    const U = MML.Emu && MML.Emu.SamplePitchUtil;
    if (!brrSamples || !U || !U.getKindMap || !MML.SPC2MML.brrHash) return null;
    const map = U.getKindMap();
    const out = {};
    let any = false;
    for (const srcn of Object.keys(brrSamples)) {
      const h = MML.SPC2MML.brrHash(brrSamples[srcn]);
      const k = h && map[h];
      if (k === 'drum' || k === 'pitch') { out[srcn] = k; any = true; }
    }
    return any ? out : null;
  }

  // SPC: 打楽器サンプルの打点 → ドラムパッド台帳+打点プロバイダ。判定/打点はMML変換と
  // 同じ関数(MML.SPC2MML.drumSrcns/drumHits)。対象は「自動判定に当たったsrcnを鳴らす全ボイス」
  // + 「借用先にE(DPCM)を選んだボイスの全srcn(音階指定を除く)」(2026-09-04)
  function updateSpcDrumSamples(log, brrSamples, fineTune, drumKinds) {
    setDrumSampleStore({});
    drumHitsProvider = null;
    if (!log || !log.length || !brrSamples || !MML.SPC2MML.drumHits) return;
    let voiceEvents, drumSrcns;
    try {
      voiceEvents = MML.SPC2MML.extractVoiceEvents(log, { srcnFineTune: fineTune });
      drumSrcns = MML.SPC2MML.drumSrcns(voiceEvents, fineTune, drumKinds || null);
    } catch (e) { console.warn('SPC打楽器打点の収集に失敗:', e); return; }
    // 打楽器/音階の手動指定はパッドから後で変えられるので、自動判定は毎回引き直す
    // (変換 MML.SPC2MML.convert 側も同じ入力から同じ判定をする)
    const drumSrcnsNow = () => {
      const kinds = spcDrumKindsOf(spcActiveBrrSamples);
      try { return MML.SPC2MML.drumSrcns(voiceEvents, fineTune, kinds || null); }
      catch (e) { return drumSrcns; }
    };
    // ボイスの借用先ごとの区分け(変換時 src/spc2mml/converter.js と同じ読み方)。
    //   melo = 自動判定に当たったsrcnだけ打点にするボイス / dpcm = 全srcnを打点にするボイス(E)
    //   noise = D(ノイズ)を選んだボイス(ノイズパッド、2026-09-18): E と同じく全srcnがパッド。打点に assignTarget='noise'
    const voicePlanNow = () => {
      const Plan = MML.Convert.ChannelPlan;
      const melo = [], dpcm = [], noise = [];
      for (let ch = 0; ch < 8; ch++) {
        const ent = Plan.get(`V${ch}`) || {};
        const type = ent.target || SPC_DEFAULT_TARGETS[`V${ch}`] || 'skip';
        if (type === 'skip') continue;
        if (type === 'dpcm') dpcm.push(ch); else if (type === 'noise') noise.push(ch); else melo.push(ch);
      }
      return { melo, dpcm, noise };
    };
    const hitsNow = () => {
      const { melo, dpcm, noise } = voicePlanNow();
      return MML.SPC2MML.drumHits(voiceEvents, brrSamples, drumSrcnsNow(), melo,
        { dpcmChans: dpcm, noiseChans: noise, pitchSrcns: spcPitchSrcnSet() });
    };
    // 台帳(パッド一覧/試聴)は「全ボイス・全srcn」で作っておき、一覧に出すキーだけを
    // listedKeys() で絞る。こうしておくとEを付け外ししてもPCMを取り直さずに済む
    const all = MML.SPC2MML.drumHits(voiceEvents, brrSamples, drumSrcns, [0, 1, 2, 3, 4, 5, 6, 7],
      { dpcmChans: [0, 1, 2, 3, 4, 5, 6, 7], pitchSrcns: null });
    const store = {};
    for (const k of Object.keys(all.samples)) {
      const s = all.samples[k];
      store[k] = { pcm: s.pcm, rate: s.rate, hash: s.hash, label: s.label, chip: 'spc', chans: [] };
    }
    for (const h of all.hits) if (store[h.key] && store[h.key].chans.indexOf(h.ch) < 0) store[h.key].chans.push(h.ch);
    setDrumSampleStore(store);
    drumHitsProvider = {
      format: 'spc', frameRate: MML.SPC2MML.FRAME_RATE, totalFrames: log.length,
      build: () => hitsNow().hits,
      // 一覧に出すのは「実際にDPCMへ焼かれるサンプル」だけ(自動判定の打楽器 + Eボイスの全srcn)
      listedKeys: () => Object.keys(hitsNow().samples),
    };
  }

  // HESのDDA(PCM)→ドラムパッド台帳+打点プロバイダ。DDAは常にE(DPCM)へ載るので
  // 打点は全部が対象、パッド一覧にも全サンプルを出す
  function updateHesDrumSamples(data, frameRate) {
    setDrumSampleStore({});
    drumHitsProvider = null;
    if (!data || !data.snapshots || !data.dpcmTrace || !data.controlTrace) return;
    if (!MML.Hes2MmlExpansion || !MML.Hes2MmlExpansion.ddaHits) return;
    let r;
    try { r = MML.Hes2MmlExpansion.ddaHits(data.snapshots, data.dpcmTrace, data.controlTrace, frameRate); }
    catch (e) { console.warn('HES DDA打点の収集に失敗:', e); return; }
    if (!r.hits.length) return;
    const store = {};
    for (const k of Object.keys(r.samples)) {
      const s = r.samples[k];
      store[k] = { pcm: s.pcm, rate: s.rate, hash: s.hash, label: s.label || null, chip: 'hes', chans: [] };
    }
    for (const h of r.hits) if (store[h.key] && store[h.key].chans.indexOf(h.ch) < 0) store[h.key].chans.push(h.ch);
    setDrumSampleStore(store);
    drumHitsProvider = {
      format: 'hes', frameRate, totalFrames: data.snapshots.length,
      build: () => r.hits,
      listedKeys: () => Object.keys(store),
    };
  }

  function changeHesTrack(delta) {
    const hMin = parseInt(hesTrackIndexEl.min, 10) || 0;
    const hMax = parseInt(hesTrackIndexEl.max, 10) || 255;
    let v = wrapIndex((parseInt(hesTrackIndexEl.value, 10) || 0) + delta, hMin, hMax);
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
    // ★2026-08-22: WAV書き出しにも鍵盤のch別ミュート/音量を反映(VGMと同じ抜けがあった)
    applyChannelSettingsToApu(player.apu, 'hes');
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

    // $0805(chバランス)/$0801(全体バランス)を反映したステレオ出力。
    const filename = await downloadExportAudio(`hes_track${track}`, [audioL, audioR], sampleRate, 4.0, hesFileStatusEl);

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
      await synthDrumEnsure(); // 打楽器化したchの分離レンダリングを確定させる
      result = await MML.HES2MML.fromHes(loadedHesBytes, track, duration, Object.assign({ bpm: hesManualBpm, cmd: MML.UI.ConvertSettings.get(), onProgress: makeCaptureProgress(hesFileStatusEl) }, planConvertOptions()));
    } catch (e) {
      hesIsRendering = false;
      updateHesPlayButton();
      hesFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }

    hesIsRendering = false;
    updateHesPlayButton();

    resetMmlForNewSong(); // 別の曲になるのでログ/ファイル名/外部同期は引き継がない
    mmlSourceEl.value = result.mml;
    noteToneDemotions(result);
    resetDpcmEditor();
    mmlSourceEl.dispatchEvent(new Event('input'));

    if (result.n163Wave && MML.WaveformEditor.n163Wave) MML.WaveformEditor.n163Wave.setData(result.n163Wave);

    // DPCM(DDA/PCM抽出分)の .dmc は台帳へ(nsf2mml と同じ。保存時に同じフォルダへ書き出せる)
    takeDpcmFiles(result.dpcmFiles);
    const dpcmMsg = (result.dpcmFiles && result.dpcmFiles.length > 0)
      ? T('、DPCM {n} ファイル出力', { n: result.dpcmFiles.length }) : '';

    // 借用先を変えているときは「N163を借用」固定の文言が実態と合わなくなるので、
    // 実際に使った拡張音源を出す(チャンネル割当、案E)
    const hesBorrow = MML.Convert.ChannelPlan.isCustom()
      ? T('、拡張音源: {chips}', { chips: (result.expansions || []).join(', ') || '-' })
      : '';
    hesFileStatusEl.innerHTML =
      '<div class="ok">' + (hesBorrow
        ? T('MML変換完了 ({mode} {bpm} BPM、音源: {chips}{dpcm}) → MMLエディタに出力',
          { mode: hesManualBpm ? T('指定') : T('推定'), bpm: result.bpm, chips: result.chips.join(', '), dpcm: dpcmMsg + hesBorrow })
        : T('MML変換完了 ({mode} {bpm} BPM、音源: {chips}{dpcm}) → MMLエディタに出力(N163を借用して再生)',
          { mode: hesManualBpm ? T('指定') : T('推定'), bpm: result.bpm, chips: result.chips.join(', '), dpcm: dpcmMsg })) + '</div>' +
      renderTuning(result.tuning) + renderPitchCheck(result.pitchCheck);

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
  // 「to MML」は変換設定画面を開き、その中の「コンバート開始」で変換する(ユーザー要望)
  document.getElementById('btnHes2Mml').addEventListener('click', () => MML.UI.ConvertSettings.open({ format: 'hes', onConvert: runHes2Mml }));
  document.getElementById('btnHesTrackPrev').addEventListener('click', () => changeHesTrack(-1));
  document.getElementById('btnHesTrackNext').addEventListener('click', () => changeHesTrack(1));

  // ── PSF(PlayStation)ファイル読み込み・再生 ────────────────────────────
  // ★PSF は「曲データ入りの PS-EXE」を MIPS CPU+HLE BIOS で走らせて SPU を鳴らす形式
  //   (src/emulator/psfPlayer.js 冒頭)。再生は SPC と同じく「Worker でフルエミュレーションした
  //   SPU 書き込みログを、メインスレッドの SPU 単独エミュへ流し直す」方式
  //   (src/audio/psf-stream-player.js、速度1ではサンプル単位で一致)。
  // ★鍵盤表示/ロール/ドラムパッド/基準音補正は VGM の PCM チップ(C352 等)と同じ経路を使う。
  //   キャプチャのフレームスナップショットを Emu.snapshotPsx で C352 と同じ形に変換する
  //   (src/emulator/psxSampleBank.js)。行 id は PX<n>。意味は表示モード(vgmPoolModes.psx)で変わる:
  //   'track'(既定)=ドライバ内部トラック×声部のレーン(Emu.PsfTrackVoicer、行名 T17-2 等) / 'logical'=合成ch 32本 /
  //   'phys'=SPU ボイス0-23。変換のソースID psx:<n-1> も同じレーンを指す。
  // ★_lib(.psflib)は、zip ならアーカイブ内の兄弟ファイル、単体ならいっしょに選ばれた/ドロップ
  //   されたファイルから名前で引く(psfSiblingResolver。initUnifiedSoundFileWindow が設定する)。
  const psfFileEl       = document.getElementById('psfFile');
  const psfFileHeaderEl = document.getElementById('psfFileHeader');
  const psfPlayDurEl    = document.getElementById('psfPlayDuration');
  const psfFileStatusEl = document.getElementById('psfFileStatus');

  let loadedPsfInfo = null;      // MML.PSF.load() の結果(_lib 解決済み)
  let loadedPsfName = '';
  let psfIsRendering = false;
  let psfActivePlayer = null;    // PsfReplayStreamPlayer
  let psfCaptureMirror = null;   // { cap, done, token } 進行中/完了済みキャプチャ(ロール再構築・ドラム用)
  let psfSampleBank = null;      // Emu.PsxSampleBank(サンプル解析。鍵盤/ロール/基準音補正で共有)
  let psfSiblingResolver = null; // (name) => Promise<Uint8Array|null>
  let psfLiveRegrouper = null;   // 合成ch表示のライブ用(Emu.PoolChannelRegrouper)
  let psfRollState = {};         // RollBuild.psf の変換済みスナップショット
  let psfCaptureComplete = false; // 表示用キャプチャが最後まで終わったか(トラックモードの既定割当はそこで決める)
  let psfTrackPlanCache = null;  // トラックモードの既定割当 { plan(ソースID→借用先), lanes(レーン表) }(psfRefreshTrackPlan)

  function psfTagLine(label, v) { return v ? `${label}${v}\n` : ''; }

  function renderPsfHeader(info) {
    const t = info.tags || {};
    let out = '';
    out += `PSF1  PC=${toHex(info.pc >>> 0, 8)}  SP=${toHex(info.sp >>> 0, 8)}  ${info.refresh}Hz\n`;
    if (info.libs && info.libs.length) out += T('_lib        : {libs}', { libs: info.libs.join(', ') }) + '\n';
    out += psfTagLine(T('曲名        : '), t.title);
    out += psfTagLine(T('ゲーム      : '), t.game);
    out += psfTagLine(T('アーティスト: '), t.artist);
    out += psfTagLine(T('年          : '), t.year);
    out += psfTagLine(T('著作権      : '), t.copyright);
    out += psfTagLine(T('リッパー    : '), t.psfby || t.ripper);
    if (info.lengthMs != null) out += T('長さ        : {len} 秒 + フェード {fade} 秒', { len: (info.lengthMs / 1000).toFixed(1), fade: ((info.fadeMs || 0) / 1000).toFixed(1) }) + '\n';
    psfFileHeaderEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = out;
    psfFileHeaderEl.appendChild(pre);
  }

  async function loadPsfFile() {
    const file = psfFileEl.files[0];
    if (!file) return;
    stopAllFormatPlayback();
    keyboardDisplay.reset();
    psfSetPlanDefaults(); // 新ファイル: チャンネル割当をリセットして既定割当(先頭8ボイス→N163)を登録
    setKbdSource('psf', file.name);
    loadedPsfInfo = null; loadedPsfName = file.name;
    psfCaptureMirror = null; psfSampleBank = null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const info = await MML.PSF.load(bytes, psfSiblingResolver);
      loadedPsfInfo = info;
      renderPsfHeader(info);
      // タグの長さ(+フェード)を再生時間欄へ。フェード分は再生側の FADE_SEC が別に足すので長さだけ入れる
      if (info.lengthMs) {
        const min = parseInt(psfPlayDurEl.min, 10) || 1;
        const max = parseInt(psfPlayDurEl.max, 10) || 3600;
        psfPlayDurEl.value = String(Math.max(min, Math.min(max, Math.ceil(info.lengthMs / 1000))));
      }
      psfFileStatusEl.innerHTML = '';
      if (info.title) setKbdSource('psf', info.title);
    } catch (e) {
      psfFileHeaderEl.innerHTML = '<div class="error">' + T('読み込みエラー: {msg}', { msg: e.message }) + '</div>';
    }
  }

  // ── PSF チャンネル割当 ──
  // 変換器は vgm2mml の PCM チップ経路なので、割当の既定(PSF2MML.defaultPlan)と変換時のキー(ソースID 'psx:N')は
  // VGM と同じ体系。鍵盤の行ID(PX1-24)との橋渡しは ChannelPlan.chIdForVgmSource(VGM_SRC_TO_CH の psx:'PX')。
  function psfSetPlanDefaults() {
    const Plan = MML.Convert.ChannelPlan;
    const map = {};
    psfTrackPlanCache = null;
    // トラックモードのレーンは曲を取り込むまで決まらない(既定割当は psfRefreshTrackPlan で後から入れる)
    if (MML.PSF2MML && MML.VGM2MML && vgmPoolModes.psx !== 'track') {
      const plan = MML.PSF2MML.defaultPlan(null);
      for (const srcId of Object.keys(plan)) {
        const chId = Plan.chIdForVgmSource(srcId);
        if (chId) map[chId] = plan[srcId];
      }
    }
    Plan.newFile("psf", map, loadedPsfName);
  }
  // 変換用の割当・音色(ソースIDキー)。VGM の getVgmChannelMap/getVgmTone/getVgmVrc7Inst と同じ規則
  function psfConvertMaps() {
    const Plan = MML.Convert.ChannelPlan;
    // トラックモード: 取り込み済みのレーン表で元chを並べ、既定はトラック単位の割当(PSF2MML.trackPlan)。
    // まだ取り込みが終わっていなければ割当を渡さない(fromPsf がその場でトラック単位の既定割当を作る)
    const trackMode = vgmPoolModes.psx === 'track';
    if (trackMode && !psfTrackPlanCache) return { channelMap: null, tone: {}, vrc7Inst: {} };
    const src = MML.PSF2MML.sourceChannels(null, trackMode ? psfTrackPlanCache.lanes : null);
    const def = trackMode ? psfTrackPlanCache.plan : MML.PSF2MML.defaultPlan(null);
    const channelMap = {}, tone = {}, vrc7Inst = {};
    let changed = false;
    for (const s of src) {
      const chId = Plan.chIdForVgmSource(s.id);
      const ent = (chId && Plan.get(chId)) || {};
      channelMap[s.id] = ent.target || def[s.id] || 'skip';
      if (channelMap[s.id] !== (def[s.id] || 'skip')) changed = true;
      if (ent.tone !== undefined) tone[s.id] = ent.tone;
      if (/^vrc7_/.test(channelMap[s.id])) vrc7Inst[s.id] = ent.tone !== undefined ? ent.tone : MML.VGM2MML.defaultVrc7Inst(s.kind);
    }
    // ドラムパート(合成ch)は鍵盤に行が無い。ノイズ枠が空いていればそこへ入れる(VGM と同じ)
    if (!src.some(s => channelMap[s.id] === 'noise')) {
      const drum = src.find(s => /:drum$/.test(s.id) && channelMap[s.id] === 'skip');
      if (drum) { channelMap[drum.id] = 'noise'; changed = true; }
    }
    // トラックモードは常に渡す(渡さないと変換器の「音符の多いch上位を N163 の8枠へ」になりトラック単位が崩れる)
    return { channelMap: (changed || trackMode) ? channelMap : null, tone, vrc7Inst };
  }

  // 保持中のキャプチャから、表示モードのレーン列(RollBuild.psxFrames)を取る。無ければ null
  function psfModeData() {
    if (!psfCaptureMirror || !MML.RollBuild || !MML.RollBuild.psfObjectSnapshots) return null;
    return MML.RollBuild.psfObjectSnapshots(psfCaptureMirror.cap, psfRollState);
  }
  function psfLaneFrames(mode) {
    const data = psfModeData();
    return data ? MML.RollBuild.psxFrames(data, mode) : null;
  }

  // トラックモードの後始末(取り込み完了時・表示モード切替時・ロール再構築時):
  //  - 複製レーン(デチューン二重化/エコー)に「≈T8」の印を付ける(鍵盤の行名)
  //  - トラック単位の既定割当(PSF2MML.trackPlan)をチャンネル割当の既定へ入れる(ユーザーが変えた分は残る)
  // 他のモードでは従来の既定(先頭から N163)に戻す
  function psfRefreshTrackPlan() {
    const Plan = MML.Convert.ChannelPlan;
    const toChMap = (plan) => {
      const map = {};
      for (const srcId of Object.keys(plan)) { const chId = Plan.chIdForVgmSource(srcId); if (chId) map[chId] = plan[srcId]; }
      return map;
    };
    if (vgmPoolModes.psx !== 'track') {
      psfTrackPlanCache = null;
      Plan.setDefaults(toChMap(MML.PSF2MML.defaultPlan(null)));
      return;
    }
    if (!psfCaptureComplete) return;
    const data = psfModeData();
    const frames = data && MML.RollBuild.psxTrackFrames(data);
    const st = data && data.psx.__trackState;
    if (!frames || !st) return;
    try {
      const lanes = st.vc.laneTable();
      const d = { psx: { snapshots: frames, lanes, doubles: MML.Convert.PoolDoubles ? MML.Convert.PoolDoubles.find(frames) : null } };
      const labels = MML.PSF2MML.laneLabels(lanes);
      const copyOf = MML.PSF2MML.copyLanes(d);
      for (const l of st.vc.lanes) l.copyOf = copyOf.has(l.index) ? labels[copyOf.get(l.index)].replace(/-\d+$/, '') : undefined;
      MML.Emu.PsfTrackVoicer.copyVersion++;
      const plan = MML.PSF2MML.trackPlan(d);
      psfTrackPlanCache = { plan, lanes };
      // ロールの区画(トラック単位)と複製の点線表示へ、決まった印を反映する
      const meta = {};
      for (const l of st.vc.lanes) {
        const base = MML.Emu.PsfTrackVoicer.laneName(l, 1);
        meta['PX' + (l.index + 1)] = { laneGroup: l.copyOf || base, laneCopy: !!l.copyOf };
      }
      keyboardDisplay.setRollTrackLaneMeta(meta);
      Plan.setDefaults(toChMap(plan));
    } catch (e) { console.warn('PSF トラックの既定割当に失敗:', e); }
  }

  function stopPsfPlayback() {
    if (psfActivePlayer) {
      psfActivePlayer.destroy();
      psfActivePlayer = null;
    }
    psfRollToken++; // 進行中の先読みキャプチャ結果を無効化
    // ★停止ではロールを消さない(他形式と同じ。止めた状態でもロールとパッドを見られるように)
    updatePsfPlayButton();
  }

  function updatePsfPlayButton() {
    const btn = document.getElementById('btnPsfFilePlay');
    if (!btn) return;
    const playing = psfActivePlayer && psfActivePlayer.isPlaying;
    btn.classList.toggle('is-playing', !!playing);
    btn.title = playing ? T('一時停止') : T('再生');
    btn.disabled = psfIsRendering;
    updateKeyboardTransport();
  }

  // 鍵盤表示のライブ行: 再生位置のフレームのスナップショットを C352 と同じ形へ変換する
  // (SPU 単独再生側はサンプル番号を持たないので、キャプチャのスナップショットを使う)
  function livePsx() {
    if (!psfActivePlayer || !psfCaptureMirror || !psfSampleBank) return null;
    const snaps = psfCaptureMirror.cap.snapshots;
    const f = Math.min(psfActivePlayer.getCurrentFrame(), snaps.length - 1);
    if (f < 0 || !snaps[f]) return null;
    if (vgmPoolModes.psx === 'track') {
      // トラックモードは声部の割り当てが曲の頭からの状態を持つので、ライブで束ね直さず取り込み済みのレーン列を読む。
      // 行が再生位置で増減しないよう、その時点で分かっている全レーンぶんに空きを足す
      const data = psfModeData();
      const frames = data && MML.RollBuild.psxTrackFrames(data);
      const st = data && data.psx.__trackState;
      if (frames && frames[f] && st) {
        const fr = frames[f];
        if (fr.length >= st.vc.lanes.length) return fr;
        const out = fr.slice();
        for (let li = fr.length; li < st.vc.lanes.length; li++) out.push(st.vc._idle[li]);
        return out;
      }
    }
    const obj = MML.Emu.snapshotPsx(snaps[f], psfSampleBank);
    if (vgmPoolModes.psx !== 'logical') return obj;
    if (!psfLiveRegrouper) psfLiveRegrouper = new MML.Emu.PoolChannelRegrouper(MML.Emu.POOL_CHIP_CHANNELS.psx);
    return psfLiveRegrouper.step(obj);
  }

  // 保持中のキャプチャからロールを組み直す(表示モード切替・打楽器/音階指定・基準音補正のあと)
  function rebuildPsfRoll() {
    if (!psfCaptureMirror || !MML.RollBuild || !MML.RollBuild.psf) return;
    psfLiveRegrouper = null;
    psfRollState = {}; // 解析結果(サンプルの音程判定)が変わりうるので変換済みスナップショットも捨てる
    if (psfSampleBank) psfSampleBank._pitchCache.clear();
    // レーン列を作り直したので、複製の印と既定割当も付け直す(ロールの色が複製の印を読むので先に)
    psfRefreshTrackPlan();
    try {
      const cap = psfCaptureMirror.cap;
      const t = MML.RollBuild.psf(cap, cap.snapshots.length, { poolMode: vgmPoolModes }, psfRollState);
      pushRollTimeline(t);
    } catch (e) { console.warn('PSFのロール再構築に失敗:', e); }
  }

  // ドラムパッド台帳: VGM の updateVgmDrumSamples と同じ形('psx:<start>' → {pcm, rate, hash, chip, chans})
  function updatePsfDrumSamples() {
    if (!psfCaptureMirror || !psfSampleBank) return;
    const cap = psfCaptureMirror.cap;
    const S = MML.Emu.PSF_SNAP, F = S.VOICE_FIELDS;
    const out = {};
    const firstRate = {}, chansOf = {};
    for (const snap of cap.snapshots) {
      if (!snap) continue;
      for (let v = 0; v < 24; v++) {
        const id = snap[v * F + S.SAMPLE];
        if (id < 0 || (snap[v * F + S.FLAGS] & 1)) continue;
        if (firstRate[id] === undefined && snap[v * F + S.PHASE] !== 0) firstRate[id] = 44100 * Math.min(0x4000, snap[v * F + S.PITCH]) / 0x1000;
        (chansOf[id] = chansOf[id] || new Set()).add(v);
      }
    }
    for (const idStr of Object.keys(chansOf)) {
      const id = +idStr;
      const smp = cap.samples[id];
      if (!smp) continue;
      const key = 'psx:' + smp.addr;
      if (out[key]) continue;
      const p = psfSampleBank.samplePitch('psx', smp.addr, smp.addr + smp.blocks * 16, id);
      out[key] = { pcm: psfSampleBank.samplePcm({ kind: 'psx', start: smp.addr, end: smp.addr + smp.blocks * 16, id }),
                   rate: firstRate[id] || 44100, hash: p ? p.hash : null, chip: 'psx', chans: Array.from(chansOf[id]) };
    }
    setDrumSampleStore(out);
    drumHitsProvider = psfDrumHitsProvider();
  }

  // PSF の打点プロバイダ。割当で借用先に 'dpcm' を選んだボイスの打点を集める
  // (VGM の vgmDrumHitsProvider と同じ選び方。打点の取り出しは vgm2mml の collectDrumHits を共用)
  function psfDrumHitsProvider() {
    const dpcmVoices = () => {
      const Plan = MML.Convert.ChannelPlan;
      const out = { chans: [], rateIndex: null };
      for (let v = 0; v < MML.Emu.POOL_CHIP_CHANNELS.psx; v++) { // 合成chは32本(実機スロットでは24以降は空)
        const ent = Plan.get('PX' + (v + 1)) || {};
        if (ent.target !== 'dpcm') continue;
        out.chans.push(v);
        const t = ent.tone;
        if (out.rateIndex === null && t !== undefined && t !== null && t !== '' && t !== 'auto') {
          const n = parseInt(t, 10);
          if (Number.isFinite(n)) out.rateIndex = n;
        }
      }
      return out;
    };
    return {
      format: 'psf',
      frameRate: 60,
      get totalFrames() { return psfCaptureMirror ? psfCaptureMirror.cap.snapshots.length : 0; },
      build() {
        const { chans, rateIndex } = dpcmVoices();
        if (!chans.length || !psfCaptureMirror || !MML.Vgm2MmlExpansion || !MML.Vgm2MmlExpansion.collectDrumHits) return null;
        const cap = psfCaptureMirror.cap;
        const data = MML.RollBuild.psfObjectSnapshots(cap, psfRollState);
        // 行(PX<n>)の意味は表示モードで変わる(トラック/合成ch/実機スロット)。変換(PSF2MML.captureData)と同じ束ね方にそろえる
        const snapsForPlan = MML.RollBuild.psxFrames(data, vgmPoolModes.psx);
        const samples = {};
        for (let id = 0; id < cap.samples.length; id++) {
          const smp = cap.samples[id];
          if (!smp) continue;
          const key = 'psx:' + smp.addr + ':' + (smp.addr + smp.blocks * 16);
          if (!samples[key]) samples[key] = psfSampleBank.samplePcm({ kind: 'psx', start: smp.addr, end: smp.addr + smp.blocks * 16, id });
        }
        const sources = [{ chip: 'psx', snapshots: snapsForPlan, chans, shape: 'pcm', samples }];
        return { hits: MML.Vgm2MmlExpansion.collectDrumHits(sources, 60, snapsForPlan.length), rateIndex };
      },
      listedKeys() {
        const { chans } = dpcmVoices();
        return Object.keys(drumSampleStore).filter(k => {
          const smp = drumSampleStore[k];
          return smp && smp.chip === 'psx' && (smp.chans || []).some(v => chans.indexOf(v) >= 0);
        });
      },
    };
  }

  // キャプチャ中に BIOS 模倣が止まった/未実装の呼び出しがあったことを知らせる(黙って無音にしない)
  function psfBiosNotice(bios) {
    if (!bios) return '';
    const parts = [];
    if (bios.halted) parts.push(T('エミュレーションが停止しました: {reason}', { reason: bios.haltReason || '?' }));
    if (bios.unknownCalls && bios.unknownCalls.length) {
      parts.push(T('未実装のBIOS呼び出し: {calls}', { calls: bios.unknownCalls.map(([k, n]) => `${k}×${n}`).join(' ') }));
    }
    return parts.length ? '<div class="error">' + parts.map(escapeHtmlPsf).join('<br>') + '</div>' : '';
  }
  function escapeHtmlPsf(str) {
    return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function playPsfStream() {
    if (!loadedPsfInfo) {
      psfFileStatusEl.innerHTML = '<div class="error">' + T('先にPSFファイルを読み込んでください。') + '</div>';
      return;
    }
    if (psfActivePlayer && lastPlayMode === 'psf') {
      if (psfActivePlayer.isPlaying) transportPause();
      else transportPlay();
      return;
    }
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    transportStop();
    stopAllFormatPlayback();
    invalidateOtherRollPrefetch('psf');
    lastPlayMode = 'psf';
    setKbdSource('psf', loadedPsfInfo.title || loadedPsfName);
    psfBufferedFraction = 0;
    updateSeekBufferedUI();

    const duration = parseInt(psfPlayDurEl.value, 10) || 180;
    const captureDuration = duration + FADE_SEC;
    const totalFrames = Math.ceil(captureDuration * 60);

    const player = new MML.Audio.PsfReplayStreamPlayer(audioCtx);
    player._baseGain = player.gainNode.gain.value;
    attachAssignPreview(player);
    endFadeActive = false;
    player.onEnded = () => {
      updatePsfPlayButton();
      updateTransportUI();
      setTimeout(() => { if (currentTransportPlayer() === player) finishSoundFilePlayback(); }, 0);
    };
    player.onSilenceTimeout = () => {
      setTimeout(() => {
        if (currentTransportPlayer() !== player) return;
        stopPsfPlayback();
        archiveAutoAdvanceOrStop();
      }, 1000);
    };
    psfActivePlayer = player;
    // 行単位のミュート/音量: トラック/合成chの行はレーンなので、そのフレームにレーンが使っているボイスへ写す
    player.setLaneFrames((f) => {
      if (vgmPoolModes.psx === 'phys') return null;
      const frames = psfLaneFrames(vgmPoolModes.psx);
      return frames && frames[f] ? frames[f] : null;
    });
    player.setSpeed(currentSpeedFactor);
    workletDuration = captureDuration;

    resetPlaybackRangeToFull(captureDuration);
    setSeekBarValue(0);
    setTimeDisplay(`00:00 / ${formatTime(captureDuration)}`);

    psfFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = T('再生中: {title}  (最大 {time})', { title: loadedPsfInfo.title || loadedPsfName, time: formatTime(duration) });
    psfFileStatusEl.appendChild(pre);

    setMonitorSource({
      regSnapshots: [{}], totalFrames: 1,
      samplesPerFrame: audioCtx.sampleRate / 60,
      sampleRate: audioCtx.sampleRate,
      writeLog: [], cpuSnapshots: null, memSnapshots: null,
      getPsx: livePsx
    }, () => psfActivePlayer ? psfActivePlayer.getPosition() : 0, ['vgm', 'psx']);

    keyboardDisplay.setRollTimeline(null);
    const myToken = ++psfRollToken;
    psfCaptureMirror = null;
    psfSampleBank = null;
    psfLiveRegrouper = null;
    psfRollState = {};
    psfCaptureComplete = false;
    drumSampleStore = {};
    drumHitsProvider = null;
    synthDrumReset();
    keyboardDisplay.setDpcmCost(null);
    let loaded = false;
    const t0 = performance.now();

    MML.Emu.capturePsfSongWorkerAsync(loadedPsfInfo, {
      durationSeconds: captureDuration,
      regsOnly: true,
      shouldCancel: () => myToken !== psfRollToken,
      roll: {
        poolMode: Object.assign({}, vgmPoolModes),
        onRoll: (timeline) => {
          if (myToken !== psfRollToken) return;
          pushRollTimeline(timeline);
        }
      }
    }, (done, total, cap) => {
      if (myToken !== psfRollToken) return;
      if (!psfSampleBank || psfSampleBank.samples !== cap.samples) psfSampleBank = new MML.Emu.PsxSampleBank(cap.samples);
      psfCaptureMirror = { cap, done, token: myToken };
      if (!loaded && cap.frameLog.length > 0) {
        loaded = true;
        player.load(cap, total, getChannelMuteConfig());
        player.applyVolume(getChannelVolumeConfig());
        transportPlay();
      }
      psfBufferedFraction = total > 0 ? done / total : 0;
      updateSeekBufferedUI();
    }).then((cap) => {
      if (myToken !== psfRollToken || !cap) return;
      if (!psfSampleBank || psfSampleBank.samples !== cap.samples) psfSampleBank = new MML.Emu.PsxSampleBank(cap.samples);
      psfCaptureMirror = { cap, done: cap.snapshots.length, token: myToken };
      psfCaptureComplete = true;
      psfBufferedFraction = 1;
      updateSeekBufferedUI();
      psfRefreshTrackPlan();
      updatePsfDrumSamples();
      synthDrumEnsure();
      refreshDrumPanel();
      scheduleDpcmCostUpdate();
      const notice = psfBiosNotice(cap.bios);
      if (notice) psfFileStatusEl.insertAdjacentHTML('beforeend', notice);
      console.info(`[psf] キャプチャ完了 ${((performance.now() - t0) / 1000).toFixed(1)}s / 曲長 ${captureDuration}s, サンプル ${cap.samples.length}`);
    }).catch((e) => {
      console.error('PSF先読みキャプチャに失敗:', e);
      psfFileStatusEl.insertAdjacentHTML('beforeend', '<div class="error">' + escapeHtmlPsf(T('キャプチャに失敗しました: {msg}', { msg: e.message })) + '</div>');
    });
  }

  async function exportPsfWav() {
    if (!loadedPsfInfo) {
      psfFileStatusEl.innerHTML = '<div class="error">' + T('先にPSFファイルを読み込んでください。') + '</div>';
      return;
    }
    if (psfIsRendering) return;
    const duration = parseInt(psfPlayDurEl.value, 10) || 180;
    psfIsRendering = true;
    updatePsfPlayButton();
    psfFileStatusEl.innerHTML = '<div>' + T('WAV書き出し用レンダリング中…') + '</div>';
    await new Promise(resolve => setTimeout(resolve, 10));
    let cap;
    try {
      // 44.1kHz(SPU の実レート)のまま書き出す。鍵盤のch別ミュートを反映(他形式と同じ)
      const mute = getChannelMuteConfig(true);
      cap = await MML.Emu.capturePsfSongAsync(loadedPsfInfo, {
        durationSeconds: duration, mute: (mute.expansion && mute.expansion.psx) || [],
      }, (done, total) => {
        psfFileStatusEl.innerHTML = '<div>' + T('WAV書き出し用レンダリング中… {pct}%', { pct: Math.round(done * 100 / Math.max(1, total)) }) + '</div>';
      });
    } catch (e) {
      psfIsRendering = false;
      updatePsfPlayButton();
      psfFileStatusEl.innerHTML = '<div class="error">' + T('レンダリングエラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }
    // ch別音量(0〜2)は SPU の vol へ入れたいが、キャプチャ本体は vol を持たないので書き出しでは未対応(ミュートのみ)
    psfIsRendering = false;
    updatePsfPlayButton();
    const base = (loadedPsfName || 'psf').replace(/\.[^.]*$/, '');
    const filename = await downloadExportAudio(base, [cap.audioL, cap.audioR], 44100, 1.0, psfFileStatusEl);
    psfFileStatusEl.innerHTML = '<div class="ok">' + T('書き出し完了: {file}', { file: filename }) + '</div>' + psfBiosNotice(cap.bios);
  }

  async function runPsf2Mml() {
    if (!loadedPsfInfo) {
      psfFileStatusEl.innerHTML = '<div class="error">' + T('先にPSFファイルを読み込んでください。') + '</div>';
      return;
    }
    if (psfIsRendering) return;
    const duration = parseInt(psfPlayDurEl.value, 10) || 60;
    psfIsRendering = true;
    updatePsfPlayButton();
    psfFileStatusEl.innerHTML = '<div>' + T('MML変換用キャプチャ中… (数秒かかります)') + '</div>';
    await new Promise(resolve => setTimeout(resolve, 10));
    const manualBpm = getManualBpm('psf');
    let result;
    try {
      await synthDrumEnsure();
      const planOpt = planConvertOptions();
      const maps = psfConvertMaps();
      result = await MML.PSF2MML.fromPsf(loadedPsfInfo, duration, {
        bpm: manualBpm, cmd: MML.UI.ConvertSettings.get(), onProgress: makeCaptureProgress(psfFileStatusEl),
        poolMode: vgmPoolModes.psx,
        channelMap: maps.channelMap, tone: maps.tone, vrc7Inst: maps.vrc7Inst,
        drumHits: planOpt.drumHits, toneSettings: planOpt.toneSettings,
      });
    } catch (e) {
      psfIsRendering = false;
      updatePsfPlayButton();
      psfFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }
    psfIsRendering = false;
    updatePsfPlayButton();

    resetMmlForNewSong(); // 別の曲になるのでログ/ファイル名/外部同期は引き継がない
    mmlSourceEl.value = result.mml;
    noteToneDemotions(result);
    resetDpcmEditor();
    mmlSourceEl.dispatchEvent(new Event('input'));
    if (result.n163Wave && MML.WaveformEditor.n163Wave) MML.WaveformEditor.n163Wave.setData(result.n163Wave);
    const dmc = result.dpcmFiles || result.dmcFiles || [];
    takeDpcmFiles(dmc); // .dmc は台帳へ(保存時に同じフォルダへ書き出せる)
    const ds = result.dpcmStats;
    const dpcmMsg = ds ? '<div>' + T('DPCM: 定義 {clips} 件 / 打点 {segments} 個 / ROM {kb} KB',
      { clips: ds.clips, segments: ds.segments, kb: (ds.bytes / 1024).toFixed(1) }) + '</div>' : '';
    const borrowNote = T('(借用先: {assign})', { assign: (result.assignments || []).filter(a => !/\(skip\)$/.test(a)).join(', ') });
    psfFileStatusEl.innerHTML =
      '<div class="ok">' + T('MML変換完了 ({mode} {bpm} BPM、音源: {chips}) → MMLエディタに出力{borrow}{ignored}',
        { mode: manualBpm ? T('指定') : T('推定'), bpm: result.bpm, chips: (result.chips || []).join(', '), borrow: borrowNote, ignored: '' }) + '</div>' +
      dpcmMsg + psfBiosNotice(result.bios) + renderTuning(result.tuning) + renderPitchCheck(result.pitchCheck);
    rangeStartSec = 0;
    rangeEndSec = null;
    prepareMmlStream(true);
  }

  psfFileEl.addEventListener('change', loadPsfFile);
  document.getElementById('btnPsfFilePlay').addEventListener('click', () => {
    playPsfStream();
    keyboardDisplay.setMode('nsf');
  });
  document.getElementById('btnPsfFileStop').addEventListener('click', () => {
    stopPsfPlayback();
    keyboardDisplay.setMode('nsf');
  });
  document.getElementById('btnPsfExportWav').addEventListener('click', exportPsfWav);
  document.getElementById('btnPsf2Mml').addEventListener('click', () => MML.UI.ConvertSettings.open({ format: 'psf', onConvert: runPsf2Mml }));

  // ── VGM ファイル読み込み・再生 ────────────────────────────────────
  // ★VGMはCPUを持たないレジスタ書込みログ(src/emulator/vgmPlayer.js冒頭コメント)。
  //   1ファイル1曲で曲番号の概念が無く、曲送りはアーカイブ(zip/7z)バー側が担う
  //   (initUnifiedSoundFileWindow参照)。再生はVgmStreamPlayer(直接駆動)で、
  //   ロール用の先読みキャプチャ(captureVgmSongAsync)はチップのclock()を回さない
  //   コマンド消化だけなので一瞬で終わる(GBS/HESのような二重エミュレーションにならない)。
  //   使うチップはヘッダで決まるため、鍵盤表示のchips配列とロールのトラック群は
  //   ファイルごとに組み立てる(NES APU→2A03行、GB DMG→GB行、HuC6280→PSG行、
  //   AY/SCC/OPLL→KSSのKP/KS/KF行をそのまま流用)。
  const vgmFileEl       = document.getElementById('vgmFile');
  const vgmFileHeaderEl = document.getElementById('vgmFileHeader');
  const vgmPlayDurEl    = document.getElementById('vgmPlayDuration');
  const vgmFileStatusEl = document.getElementById('vgmFileStatus');

  let loadedVgmBytes  = null; // 解凍済み(gzipは読み込み時に解く)
  let loadedVgmName   = '';   // ファイル名(チャンネル割当の自動保存キー、ChannelPlan.newFile の fileKey)
  let loadedVgmHeader = null;
  let vgmIsRendering  = false;
  let vgmActivePlayer = null; // VgmStreamPlayer

  // ヘッダから既定の再生時間(秒)を決める: ループ曲=イントロ+ループ2周、非ループ曲=総サンプル数。
  // どちらもFADE_SECぶんは呼び出し側で足すので、ここでは曲の実尺だけ返す。
  function vgmDefaultDuration(h) {
    if (!h || !h.totalSamples) return 180;
    let sec = h.durationSeconds;
    if (h.loopOffset && h.loopSamples > 0) sec += h.loopSeconds; // 2周目
    return Math.max(1, Math.min(3600, Math.ceil(sec)));
  }

  function renderVgmHeader(h) {
    let out = '';
    out += T('Magic       : {magic} ({ok})', { magic: 'Vgm ', ok: h.magicOk ? 'OK' : T('不正') }) + '\n';
    out += T('バージョン  : {ver}', { ver: h.versionText }) + '\n';
    const g = h.gd3;
    if (g) {
      const track = g.trackEn || g.trackJa, game = g.gameEn || g.gameJa, sys = g.systemEn || g.systemJa, author = g.authorEn || g.authorJa;
      if (track)  out += T('曲名        : {title}', { title: track + (g.trackJa && g.trackEn && g.trackJa !== g.trackEn ? ` / ${g.trackJa}` : '') }) + '\n';
      if (game)   out += T('ゲーム      : {game}', { game: game + (g.gameJa && g.gameEn && g.gameJa !== g.gameEn ? ` / ${g.gameJa}` : '') }) + '\n';
      if (sys)    out += T('システム    : {system}', { system: sys }) + '\n';
      if (author) out += T('作者        : {author}', { author: author + (g.authorJa && g.authorEn && g.authorJa !== g.authorEn ? ` / ${g.authorJa}` : '') }) + '\n';
      if (g.date) out += T('日付        : {date}', { date: g.date }) + '\n';
    }
    const chipNames = h.usedChips.map(c => `${c.name}${c.dual ? ' x2' : ''}${c.id === 'nes' && c.fds ? '+FDS' : ''}${c.id === 'k051649' && c.sccPlus ? '+' : ''} (${c.clock} Hz)${c.impl ? '' : ' ' + T('[未対応・読み飛ばし]')}`);
    out += T('音源        : {chips}', { chips: chipNames.join(', ') || '-' }) + '\n';
    out += T('長さ        : {time}{loop}', {
      time: formatTime(h.durationSeconds),
      loop: (h.loopOffset && h.loopSamples > 0) ? T(' (ループ {loop})', { loop: formatTime(h.loopSeconds) }) : T(' (ループ無し)')
    }) + '\n';
    if (h.rate) out += T('レート      : {rate} Hz', { rate: h.rate }) + '\n';
    vgmFileHeaderEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = h.magicOk ? 'ok' : 'error';
    pre.textContent = out;
    vgmFileHeaderEl.appendChild(pre);
  }

  // ── YM2608 内蔵リズムROM(ym2608_adpcm_rom.bin、8192バイト) ─────────────
  // チップ内蔵のマスクROM(BD/SD/CYM/HH/TOM/RIM)は著作物のため同梱しない(MAME等と同じ扱い)。
  // ユーザーが読み込ませたものをlocalStorageへbase64で永続化し、起動時に復元して
  // エミュレータ(Emu.setYm2608RhythmRom)へ渡す。Worker側キャプチャへは playVgmStream が
  // opt.ym2608RhythmRom で渡す(WorkerにlocalStorageは無い)。未読込ならリズムだけ無音
  // (キーオンは見えるので鍵盤/ロールの点灯は出る)。
  const YM2608_ROM_KEY = 'ym2608AdpcmRom';
  const YM2608_ROM_SIZE = 8192;
  (function restoreYm2608RhythmRom() {
    try {
      const b64 = localStorage.getItem(YM2608_ROM_KEY);
      if (b64) MML.Emu.setYm2608RhythmRom(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    } catch (e) { /* ignore */ }
  })();
  function updateYm2608RomNotice(h) {
    const old = document.getElementById('ym2608RomNotice');
    if (old) old.remove();
    if (!h || !h.chips || !h.chips.ym2608 || MML.Emu.getYm2608RhythmRom()) return;
    const div = document.createElement('div');
    div.id = 'ym2608RomNotice';
    div.className = 'warn';
    const msg = document.createElement('div');
    msg.textContent = T('YM2608の内蔵リズムROMが未読込のため、リズム(ドラム)は無音になります(FM/SSG/ADPCM-Bは鳴ります)。');
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = T('リズムROMを読み込む (ym2608_adpcm_rom.bin)');
    btn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.bin,.rom';
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return;
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          if (bytes.length !== YM2608_ROM_SIZE) {
            alert(T('リズムROMのサイズが不正です({size}バイト。期待値は8192バイト=ym2608_adpcm_rom.bin)。', { size: bytes.length }));
            return;
          }
          let b64 = '';
          for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
          try { localStorage.setItem(YM2608_ROM_KEY, btoa(b64)); } catch (e) { /* 永続化失敗は無視(今セッションは有効) */ }
          MML.Emu.setYm2608RhythmRom(bytes);
          // 再生中のチップにも即反映(次のリズムキーオンから鳴る)。ロール/ドラムパッドは
          // 次の再生開始時のキャプチャから反映される
          const a = vgmActivePlayer && vgmActivePlayer.player ? vgmActivePlayer.player.adapterById.ym2608 : null;
          if (a) a.fm.loadRhythmRom(bytes);
          updateYm2608RomNotice(loadedVgmHeader);
        } catch (e) {
          alert(T('リズムROMを読み込めませんでした: {msg}', { msg: e.message }));
        }
      };
      input.click();
    });
    div.appendChild(msg);
    div.appendChild(btn);
    vgmFileHeaderEl.appendChild(div);
  }

  async function loadVgmFile() {
    const file = vgmFileEl.files[0];
    if (!file) return;
    stopAllFormatPlayback();
    keyboardDisplay.reset();
    setKbdSource('vgm', file.name);
    loadedVgmBytes = null; loadedVgmHeader = null; loadedVgmName = file.name;
    vgmSetPlanDefaults(null);

    try {
      const raw = new Uint8Array(await file.arrayBuffer());
      // 拡張子ではなく中身で判別(.vgm拡張子で中身がgzipのファイルが実在する)
      const bytes = await MML.Archive.gunzipIfNeeded(raw);
      const h = MML.VGM.parseHeader(bytes);
      if (!h.magicOk) {
        vgmFileHeaderEl.innerHTML = '<div class="error">' + T('VGMヘッダが不正です。') + '</div>';
        return;
      }
      loadedVgmBytes = bytes;
      loadedVgmHeader = h;
      renderVgmHeader(h);
      updateYm2608RomNotice(h);
      vgmSetPlanDefaults(h);
      vgmPlayDurEl.value = String(vgmDefaultDuration(h));
      vgmFileStatusEl.innerHTML = '';
      const title = MML.VGM.displayTitle(h);
      if (title) setKbdSource('vgm', title);
      if (h.usedChips.length && !h.usedChips.some(c => c.impl)) {
        vgmFileStatusEl.innerHTML = '<div class="error">' + T('このVGMが使う音源({chips})はまだ対応していません(無音になります)。', { chips: h.usedChips.map(c => c.name).join(', ') }) + '</div>';
      }
    } catch (e) {
      vgmFileHeaderEl.innerHTML = '<div class="error">' + T('読み込みエラー: {msg}', { msg: e.message }) + '</div>';
    }
  }

  function stopVgmPlayback() {
    if (vgmActivePlayer) {
      vgmActivePlayer.destroy();
      vgmActivePlayer = null;
    }
    vgmRollToken++;
    // ★停止ではロールを消さない(別の曲を再生し始めるときだけ消す)。止めた状態でも
    //   ロールとドラムパッドを見られる・試聴できるようにするため(ユーザー要望)
    updateVgmPlayButton();
  }

  function updateVgmPlayButton() {
    const btn = document.getElementById('btnVgmFilePlay');
    if (!btn) return;
    const playing = vgmActivePlayer && vgmActivePlayer.isPlaying;
    btn.classList.toggle('is-playing', !!playing);
    btn.title = playing ? T('一時停止') : T('再生');
    btn.disabled = vgmIsRendering;
    updateKeyboardTransport();
  }

  // 鍵盤表示用のchips配列(src/ui/keyboard.js extractChannels のトークン)をヘッダから組む。
  // 'vgm'は「NES APUを含まないVGMでは2A03行を出さない」判定用の印(keyboard.js isVgmNoNes)。
  function vgmKeyboardChips(h) {
    const chips = ['vgm'];
    if (h.chips.nes) { chips.push('nes'); if (h.chips.nes.fds) chips.push('fds'); }
    if (h.chips.gb) chips.push('gbs');
    if (h.chips.huc6280) chips.push('hes');
    if (h.chips.ay8910) chips.push('kssPsg');
    if (h.chips.k051649) chips.push('kssScc');
    if (h.chips.ym2413) chips.push('kssOpll');
    if (h.chips.sn76489) chips.push('sn76489');
    if (h.chips.ym2612) chips.push('ym2612');
    if (h.chips.ym2151) chips.push('ym2151');
    if (h.chips.ga20) chips.push('ga20');
    if (h.chips.k007232) chips.push('k007232');
    if (h.chips.k054539) chips.push('k054539');
    if (h.chips.msm5205) chips.push('msm5205');
    if (h.chips.segapcm) chips.push('segapcm');
    if (h.chips.c140) chips.push('c140');
    if (h.chips.c352) chips.push('c352');
    if (h.chips.okim6258) chips.push('okim6258');
    if (h.chips.qsound) chips.push('qsound');
    if (h.chips.okim6295) chips.push('okim6295');
    if (h.chips.multipcm) chips.push('multipcm');
    if (h.chips.ym2610) { chips.push('ym2610fm'); chips.push('kssPsg'); } // SSGはKSS PSG行(KP1-3)を流用
    if (h.chips.ym2203) { chips.push('ym2203fm'); if (!chips.includes('kssPsg')) chips.push('kssPsg'); } // SSGはKP1-3(デュアルはKP4-6)を流用
    if (h.chips.ym2608) { chips.push('ym2608fm'); if (!chips.includes('kssPsg')) chips.push('kssPsg'); } // SSGはKP1-3を流用
    if (h.chips.ym3812 || h.chips.ym3526 || h.chips.y8950) chips.push('opl'); // OPL系はOL行を共有
    if (h.chips.pwm) chips.push('pwm');
    if (h.chips.rf5c164) chips.push('rf5c164');
    if (h.chips.rf5c68) chips.push('rf5c68');
    return chips;
  }

  // ── チャンネルプール式チップの表示モード(実機スロット/合成ch) ──────────
  // 'logical'=割当逆算(Emu.PoolChannelRegrouper)、'phys'=物理スロットそのまま。
  // 鍵盤ヘッダの切替UI(keyboard.js)⇔ここ⇔ロール/変換の三者で共有し、localStorageへ永続化。
  const POOL_MODE_KEY = 'vgmPoolModes';
  // プール/ペア交互割当が実測されたPCMチップ(keyboard.jsのpool印と対応)。
  // 既定: 完全プール式で劇的改善のMultiPCMのみ合成ch(既定8枠カバー率45%→100%)、
  // 他はペア交互でも音符ストリームはほぼ安定と実測されたため実機スロット既定
  // (Outfoxies等のマルチサンプル曲では合成が僅かに劣るケースもある。トグルで曲別に選ぶ)
  // psx は 'track'(ドライバ内部トラック×声部、Emu.PsfTrackVoicer)/'logical'/'phys' の3段
  const POOL_CHIP_DEFAULTS = { multipcm: 'logical', c352: 'phys', qsound: 'phys', c140: 'phys', segapcm: 'phys', psx: 'track' };
  const vgmPoolModes = (() => {
    let modes;
    try { modes = Object.assign({}, POOL_CHIP_DEFAULTS, JSON.parse(localStorage.getItem(POOL_MODE_KEY) || '{}')); }
    catch (e) { modes = Object.assign({}, POOL_CHIP_DEFAULTS); }
    // トラックモードの追加(2026-09-14)前に保存された psx の選択は一度だけトラックへ移す(以前は合成chが既定だった)
    try {
      if (!localStorage.getItem('psxTrackModeIntroduced')) {
        modes.psx = 'track';
        localStorage.setItem(POOL_MODE_KEY, JSON.stringify(modes));
        localStorage.setItem('psxTrackModeIntroduced', '1');
      }
    } catch (e) { /* ignore */ }
    return modes;
  })();
  // ライブスナップショットの合成ch変換(モードがlogicalのチップだけ通す)
  const POOL_CHIP_CHANNELS = MML.Emu.POOL_CHIP_CHANNELS; // psx は合成chだけ32本(multipcm.js 参照)
  function poolLive(token, snap) {
    if (!snap || vgmPoolModes[token] !== 'logical') return snap;
    if (!vgmLiveRegroupers[token]) vgmLiveRegroupers[token] = new MML.Emu.PoolChannelRegrouper(POOL_CHIP_CHANNELS[token]);
    return vgmLiveRegroupers[token].step(snap);
  }
  const vgmLiveRegroupers = {}; // chipToken → PoolChannelRegrouperインスタンス(再生/モード切替でリセット)
  let vgmCaptureMirror = null;  // 進行中/完了済みキャプチャの{data, done, token}(モード切替時のロール再構築用)
  keyboardDisplay.setPoolModes(vgmPoolModes);
  keyboardDisplay.onPoolModeChange = (token, mode) => {
    vgmPoolModes[token] = mode;
    try { localStorage.setItem(POOL_MODE_KEY, JSON.stringify(vgmPoolModes)); } catch (e) { /* ignore */ }
    delete vgmLiveRegroupers[token]; // ライブ表示は次フレームから新モードで束ね直す
    // ロールは保持済みキャプチャデータから選択モードで再構築する(Workerを待たない)
    if (vgmCaptureMirror && vgmCaptureMirror.token === vgmRollToken && MML.RollBuild) {
      try {
        const t = MML.RollBuild.vgm(vgmCaptureMirror.data, vgmCaptureMirror.done, { poolMode: vgmPoolModes });
        pushRollTimeline(t);
      } catch (e) { console.warn('表示モード切替のロール再構築に失敗:', e); }
    }
    if (token === 'psx' && lastPlayMode === 'psf') rebuildPsfRoll();
    else if (token === 'psx') psfRefreshTrackPlan();
  };

  // VGM再生中のライブチップスナップショット(鍵盤表示用)。既存の各フォーマット向け
  // ライブ関数(liveGbsApu/liveHesApu/liveKssPsg等)と同じ形を、VgmPlayerのアダプタから返す。
  function vgmAdapter(id) {
    const p = vgmActivePlayer && vgmActivePlayer.player;
    return p ? p.adapterById[id] || null : null;
  }
  const liveVgm = {
    getApuEnv: () => { const a = vgmAdapter('nes'); return a ? MML.Emu.snapshotApuEnv(a.apu, a.fds, a.bus) : null; },
    getGbsApu: () => { const a = vgmAdapter('gb'); return a ? MML.Emu.snapshotGbApu(a.apu) : null; },
    getHesApu: () => { const a = vgmAdapter('huc6280'); return a ? MML.Emu.snapshotHuC6280Apu(a.apu) : null; },
    // デュアルチップ(2個目)があれば連結して返す(鍵盤はKP4-6/SN4-6+SNN2行として出す)。
    // ay8910未使用でym2610があれば、その内蔵SSGをKP1-3行として出す(YM2610=SSG+FM+ADPCM統合チップ、
    // SSGはAY-3-8910互換なのでKSS PSG表示をそのまま流用)。
    getKssPsg: () => {
      const a = vgmAdapter('ay8910');
      // clockHzは各アダプタのclock()呼び出しレート(AYアダプタ=ヘッダ値×2、YM2610=ヘッダ値/2、
      // YM2203=チップのssgTickHz(プリスケーラ追随))
      if (a) { const s = MML.Emu.snapshotAY8910(a.chip, a.clockHz); const b = vgmAdapter('ay8910_2'); return b ? s.concat(MML.Emu.snapshotAY8910(b.chip, b.clockHz)) : s; }
      const y = vgmAdapter('ym2610');
      if (y) return MML.Emu.snapshotAY8910(y.ssg, y.clockHz / 2);
      const o = vgmAdapter('ym2203');
      if (o) { const s = MML.Emu.snapshotAY8910(o.fm.ssg, o.fm.ssgTickHz); const o2 = vgmAdapter('ym2203_2'); return o2 ? s.concat(MML.Emu.snapshotAY8910(o2.fm.ssg, o2.fm.ssgTickHz)) : s; }
      const p8 = vgmAdapter('ym2608');
      if (p8) return MML.Emu.snapshotAY8910(p8.fm.ssg, p8.fm.ssgTickHz);
      return null;
    },
    getKssScc: () => { const a = vgmAdapter('k051649'); return a ? MML.Emu.snapshotSCC(a.chip) : null; },
    getKssOpll: () => { const a = vgmAdapter('ym2413'); return a ? MML.Emu.snapshotOPLL(a.chip) : null; },
    getSn76489: () => { const a = vgmAdapter('sn76489'); if (!a) return null; const s = MML.Emu.snapshotSN76489(a.chip, a.clockHz); const b = vgmAdapter('sn76489_2'); return b ? s.concat(MML.Emu.snapshotSN76489(b.chip, b.clockHz)) : s; }
,
    getYm2612: () => { const a = vgmAdapter('ym2612'); return a ? MML.Emu.snapshotYM2612(a.chip) : null; }
,
    getYm2151: () => { const a = vgmAdapter('ym2151'); return a ? MML.Emu.snapshotYM2151(a.chip) : null; }
,
    getGa20: () => { const a = vgmAdapter('ga20'); return a ? MML.Emu.snapshotGA20(a.chip) : null; }
,
    getK007232: () => { const a = vgmAdapter('k007232'); return a ? MML.Emu.snapshotK007232(a.chip) : null; }
,
    // デュアル(サラマンダー2)は2個目を連結して16要素で返す(SN76489と同じ流儀。鍵盤は幅で追随)
    // ★デュアル(沙羅曼蛇2)は必ず snapshotK054539Dual を通す。素の連結だと2個目の kind が
    //   キャプチャ側('k054539#2')と食い違い、鍵盤のノート列がドラムのレーンを引けなくなる
    getK054539: () => { const a = vgmAdapter('k054539'); if (!a) return null;
      const b = vgmAdapter('k054539_2');
      return MML.Emu.snapshotK054539Dual(a.chip, b ? b.chip : null); }
,
    getMsm5205: () => { const a = vgmAdapter('msm5205'); return a ? MML.Emu.snapshotMSM5205(a.chip) : null; }
,
    getSegaPcm: () => { const a = vgmAdapter('segapcm'); return a ? poolLive('segapcm', MML.Emu.snapshotSegaPCM(a.chip)) : null; }
,
    getC140: () => { const a = vgmAdapter('c140'); return a ? poolLive('c140', MML.Emu.snapshotC140(a.chip)) : null; }
,
    getC352: () => { const a = vgmAdapter('c352'); return a ? poolLive('c352', MML.Emu.snapshotC352(a.chip)) : null; }
,
    getOkim6258: () => { const a = vgmAdapter('okim6258'); return a ? MML.Emu.snapshotOKIM6258(a.chip) : null; }
,
    getQsound: () => { const a = vgmAdapter('qsound'); return a ? poolLive('qsound', MML.Emu.snapshotQSound(a.chip)) : null; }
,
    getOkim6295: () => { const a = vgmAdapter('okim6295'); return a ? MML.Emu.snapshotOKIM6295(a.chip) : null; }
,
    // プール/ペア交互割当チップは表示モードで分岐(poolLive):
    // 'logical'=割当逆算(音色×音程連続性でメロディを同じ行へ)、'phys'=実機スロットのまま
    getMultiPcm: () => { const a = vgmAdapter('multipcm'); return a ? poolLive('multipcm', MML.Emu.snapshotMultiPCM(a.chip)) : null; }
,
    getYm2610Fm: () => { const a = vgmAdapter('ym2610'); return a ? MML.Emu.snapshotYM2610(a.fm) : null; }
,
    // デュアルチップ(2個目)があればFM 3ch+3chを連結して返す(鍵盤はOP1-6行として出す)
    getYm2203Fm: () => {
      const a = vgmAdapter('ym2203');
      if (!a) return null;
      const s = MML.Emu.snapshotYM2203(a.fm);
      const b = vgmAdapter('ym2203_2');
      return b ? { channels: s.channels.concat(MML.Emu.snapshotYM2203(b.fm).channels) } : s;
    }
,
    getYm2608Fm: () => { const a = vgmAdapter('ym2608'); return a ? MML.Emu.snapshotYM2608(a.fm) : null; }
,
    getOpl: () => { const a = vgmAdapter('ym3812') || vgmAdapter('ym3526') || vgmAdapter('y8950'); return a ? MML.Emu.snapshotOPL(a.chip) : null; }
,
    getPwm: () => { const a = vgmAdapter('pwm'); return a ? MML.Emu.snapshotPWM32X(a.chip, true) : null; }
,
    getRf5c164: () => { const a = vgmAdapter('rf5c164'); return a ? MML.Emu.snapshotRF5C164(a.chip) : null; },
    getRf5c68: () => { const a = vgmAdapter('rf5c68'); return a ? MML.Emu.snapshotRF5C164(a.chip) : null; }
  };

  // captureVgmSongAsync()の結果からピアノロール用タイムライン(共通形状)を構築する。
  // チップファミリごとに既存のビルダーへ委譲して連結する(トラックidは鍵盤の行idと1対1)。
  // VGMのロールタイムライン構築はMML.RollBuild.vgm(src/audio/roll-builders.js)へ移設

  function playVgmStream() {
    if (!loadedVgmBytes) {
      vgmFileStatusEl.innerHTML = '<div class="error">' + T('先にVGMファイルを読み込んでください。') + '</div>';
      return;
    }
    if (vgmActivePlayer && lastPlayMode === 'vgm') {
      if (vgmActivePlayer.isPlaying) transportPause();
      else transportPlay();
      return;
    }
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    transportStop();
    stopAllFormatPlayback();
    stopVoiceMonitor();
    invalidateOtherRollPrefetch('vgm');
    lastPlayMode = 'vgm';
    setKbdSource('vgm', MML.VGM.displayTitle(loadedVgmHeader) || fileInputName(vgmFileEl));
    vgmBufferedFraction = 0;
    updateSeekBufferedUI();

    const duration = parseInt(vgmPlayDurEl.value, 10) || vgmDefaultDuration(loadedVgmHeader);
    const captureDuration = duration + FADE_SEC;
    const frameRate = MML.Emu.VGM_FRAME_RATE;
    const totalFrames = Math.ceil(captureDuration * frameRate);
    const chips = vgmKeyboardChips(loadedVgmHeader);

    const player = new MML.Audio.VgmStreamPlayer(audioCtx);
    player._baseGain = player.gainNode.gain.value;
    attachAssignPreview(player);
    endFadeActive = false;
    player.onEnded = () => {
      updateVgmPlayButton();
      updateTransportUI();
      setTimeout(() => { if (currentTransportPlayer() === player) finishSoundFilePlayback(); }, 0);
    };
    player.onSilenceTimeout = () => {
      setTimeout(() => {
        if (currentTransportPlayer() !== player) return;
        stopVgmPlayback();
        archiveAutoAdvanceOrStop();
      }, 1000);
    };
    vgmActivePlayer = player;
    player.setSpeed(currentSpeedFactor);
    workletDuration = captureDuration;

    resetPlaybackRangeToFull(captureDuration);
    setSeekBarValue(0);
    setTimeDisplay(`00:00 / ${formatTime(captureDuration)}`);

    vgmFileStatusEl.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'ok';
    pre.textContent = T('再生中 (最大 {time})', { time: formatTime(duration) });
    vgmFileStatusEl.appendChild(pre);

    player.load(loadedVgmBytes, totalFrames, getChannelMuteConfig());
    player.applyVolume(getChannelVolumeConfig());

    // 鍵盤表示: NES APU行はライブアダプタのレジスタ写し(regs)を直接参照する(NSFのliveSnapと同じ
    // 考え方)。他チップはライブスナップショット関数で。
    const nesAdapter = player.player.adapterById.nes;
    const liveSnap = nesAdapter ? nesAdapter.regs : {};
    if (nesAdapter && liveSnap[0x4015] === undefined) liveSnap[0x4015] = 0x0F;
    setMonitorSource({
      regSnapshots: [liveSnap], totalFrames: 1,
      samplesPerFrame: audioCtx.sampleRate / frameRate,
      sampleRate: audioCtx.sampleRate,
      writeLog: [], cpuSnapshots: null, memSnapshots: null,
      getApuEnv: liveVgm.getApuEnv,
      getGbsApu: liveVgm.getGbsApu,
      getHesApu: liveVgm.getHesApu,
      getKssPsg: liveVgm.getKssPsg,
      getKssScc: liveVgm.getKssScc,
      getKssOpll: liveVgm.getKssOpll,
      getSn76489: liveVgm.getSn76489,
      getYm2612: liveVgm.getYm2612,
      getYm2610Fm: liveVgm.getYm2610Fm,
      getYm2203Fm: liveVgm.getYm2203Fm,
      getYm2608Fm: liveVgm.getYm2608Fm,
      getOpl: liveVgm.getOpl,
      getYm2151: liveVgm.getYm2151,
      getGa20: liveVgm.getGa20,
      // ★ここは「鍵盤表示へ渡すライブ取得関数」の明示リスト。新しいチップを足したら
      //   liveVgm 側だけでなく**ここにも足す**こと。忘れると鍵盤の音量/波形/L-Rが
      //   ライブ再生中だけ出ない(キャプチャ経路のロールは出るので気づきにくい)。
      getK007232: liveVgm.getK007232,
      getK054539: liveVgm.getK054539,
      getMsm5205: liveVgm.getMsm5205,
      getSegaPcm: liveVgm.getSegaPcm,
      getC140: liveVgm.getC140,
      getC352: liveVgm.getC352,
      getOkim6258: liveVgm.getOkim6258,
      getQsound: liveVgm.getQsound,
      getOkim6295: liveVgm.getOkim6295,
      getMultiPcm: liveVgm.getMultiPcm,
      getPwm: liveVgm.getPwm,
      getRf5c164: liveVgm.getRf5c164,
      getRf5c68: liveVgm.getRf5c68
    }, () => vgmActivePlayer ? vgmActivePlayer.getPosition() : 0, chips);
    transportPlay();

    // ピアノロール用の先読み(コマンド消化のみ・高速)。ロールのタイムライン構築は
    // キャプチャWorker内で行い、onRollで完成品を受け取る
    keyboardDisplay.setRollTimeline(null);
    const myToken = ++vgmRollToken;
    // 曲が変わるのでプール式チップのライブ束ね直し状態とロール再構築用ミラーをリセット
    for (const k of Object.keys(vgmLiveRegroupers)) delete vgmLiveRegroupers[k];
    vgmCaptureMirror = null;
    drumSampleStore = {};
    drumHitsProvider = null;
    synthDrumReset();
    keyboardDisplay.setDpcmCost(null);
    // captureVgmSongWorkerAsync: コマンド消化+スナップショット採取をWeb Workerで実行
    // (NSF/KSS/GBSと同じ仕組み、src/audio/capture-worker-client.js。Worker不可時は
    // メインスレッド版へ自動フォールバック)
    MML.Emu.captureVgmSongWorkerAsync(loadedVgmBytes, {
      durationSeconds: captureDuration,
      // YM2608内蔵リズムROM(WorkerにはlocalStorageが無いのでバイト列で渡す)
      ym2608RhythmRom: MML.Emu.getYm2608RhythmRom ? MML.Emu.getYm2608RhythmRom() : null,
      shouldCancel: () => myToken !== vgmRollToken,
      roll: {
        poolMode: Object.assign({}, vgmPoolModes), // プール式チップの表示モード(Worker内ロール構築用)
        onRoll: (timeline) => {
          if (myToken !== vgmRollToken) return;
          pushRollTimeline(timeline);
        }
      }
    }, (done, total, data) => {
      if (myToken !== vgmRollToken) return;
      vgmBufferedFraction = total > 0 ? done / total : 0;
      updateSeekBufferedUI();
      // 表示モード切替時のロール再構築用に、進行中キャプチャの参照を保持する
      vgmCaptureMirror = { data, done, token: myToken };
      updateVgmDrumSamples(data);
      scheduleDpcmCostUpdate();
    }).then(() => {
      // ★実サンプル(data[chip].samples)はキャプチャ完了後にまとめて付く
      //   (Worker経路では 'done' の finalMeta で届く。src/audio/capture-worker-multi-impl.js)。
      //   進捗コールバックの時点ではまだ無いので、完了後にもう一度拾い直さないと
      //   ドラムパッドの試聴が「押しても鳴らない」ままになる
      if (myToken !== vgmRollToken || !vgmCaptureMirror) return;
      // 先読みキャプチャが曲全体を歩きながら作ったシーク用チェックポイントを実再生側へ渡す。
      // これで「まだ再生していない位置」への初回シークも手前5秒からの再開で済む
      // (VgmPlayer.serializeSeekData/adoptSeekData)
      const sd = vgmCaptureMirror.data.vgmSeek && vgmCaptureMirror.data.vgmSeek.all;
      const lp = vgmActivePlayer && vgmActivePlayer.player;
      if (sd && lp && lp.adoptSeekData) { try { lp.adoptSeekData(sd); } catch (e) { console.warn('シーク用チェックポイントの取り込みに失敗:', e); } }
      updateVgmDrumSamples(vgmCaptureMirror.data);
      synthDrumEnsure(); // 打楽器化(E選択)済みの合成音chがあれば全長でレンダリングし直す
      refreshDrumPanel();
      scheduleDpcmCostUpdate();
    }).catch((e) => {
      console.error('VGM先読みキャプチャに失敗:', e);
    });
  }

  // キャプチャ結果の実サンプル(vgmPlayer.js collectUsedSamples)を、ドラム区画のパッド試聴が
  // 引ける形へ。パッドのキーは DrumMap.key = 'kind:start' なので、'kind:start:end' の
  // サンプル表からその形へ詰め替える。rateは最初にそのサンプルがキーオンされたときの再生レート。
  function updateVgmDrumSamples(data) {
    const out = {};
    const CH = [['ga20', 4, 'pcm'], ['k007232', 2, 'pcm'], ['k054539', 16, 'pcm'], ['segapcm', 16, 'pcm'], ['c140', 24, 'pcm'], ['c352', 32, 'pcm'],
                ['qsound', 16, 'pcm'], ['okim6295', 4, 'pcm'], ['multipcm', 28, 'pcm'],
                ['ym2610fm', 6, 'adpcmA'], ['ym2608fm', 6, 'adpcmA'],
                ['ym2610fm', 1, 'adpcmB'], ['ym2608fm', 1, 'adpcmB']]; // ADPCM-B は snapshot.adpcmB の1本
    for (const [key, n, shape] of CH) {
      const e = data && data[key];
      if (!e || !e.samples || !e.snapshots) continue;
      // サンプルごとの再生レートを最初のキーオンから拾う
      const rateOf = {};
      for (const fr of e.snapshots) {
        if (!fr) continue;
        const chans = shape === 'adpcmB' ? [fr.adpcmB] : shape === 'adpcmA' ? (fr.adpcmA || []) : fr;
        for (let i = 0; i < n; i++) {
          const c = chans[i];
          if (!c || !c.sample || !(c.rate > 0)) continue;
          const k = c.sample.kind + ':' + c.sample.start + ':' + c.sample.end;
          if (rateOf[k] === undefined) rateOf[k] = c.rate;
        }
      }
      // そのサンプルを鳴らしたチャンネル(試聴のDMCレートを引くのに使う)
      const chansOf = {}, hashOf = {};
      for (const fr of e.snapshots) {
        if (!fr) continue;
        const chans = shape === 'adpcmB' ? [fr.adpcmB] : shape === 'adpcmA' ? (fr.adpcmA || []) : fr;
        for (let i = 0; i < n; i++) {
          const c = chans[i];
          if (!c || !c.sample) continue;
          const k = c.sample.kind + ':' + c.sample.start + ':' + c.sample.end;
          (chansOf[k] = chansOf[k] || new Set()).add(i);
          if (!hashOf[k] && c.sampleHash) hashOf[k] = c.sampleHash; // サンプル単位設定のキー
        }
      }
      for (const k of Object.keys(e.samples)) {
        const padKey = k.slice(0, k.lastIndexOf(':')); // 'kind:start:end' → 'kind:start'
        if (out[padKey]) continue;
        out[padKey] = { pcm: e.samples[k], rate: rateOf[k] || 0, hash: hashOf[k] || null,
                        chip: key, chans: Array.from(chansOf[k] || []) };
      }
    }
    setDrumSampleStore(out);
    drumHitsProvider = vgmDrumHitsProvider(vgmCaptureMirror);
  }

  async function exportVgmWav() {
    if (!loadedVgmBytes) {
      vgmFileStatusEl.innerHTML = '<div class="error">' + T('先にVGMファイルを読み込んでください。') + '</div>';
      return;
    }
    if (vgmIsRendering) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const duration = parseInt(vgmPlayDurEl.value, 10) || vgmDefaultDuration(loadedVgmHeader);
    const sampleRate = audioCtx.sampleRate;
    vgmIsRendering = true;
    updateVgmPlayButton();
    vgmFileStatusEl.innerHTML = '<div>' + T('WAV書き出し用レンダリング中…') + '</div>';
    await new Promise(resolve => setTimeout(resolve, 10));

    const player = new MML.Emu.VgmPlayer(loadedVgmBytes);
    // ★2026-08-22: WAV書き出しにも鍵盤のch別ミュート/音量を反映する(他形式と同じ挙動)。
    // 以前は新しいVgmPlayerを作るだけで適用しておらず、「1chだけ書き出す」ができなかった
    // (KSSは効くのにVGMだけ全ch鳴る、という食い違いになっていた)。
    player.applyMute(getChannelMuteConfig(true));
    player.applyVolume(getChannelVolumeConfig());
    const totalFrames = Math.ceil(duration * player.frameRate);
    const totalSamples = Math.round(totalFrames * sampleRate / player.frameRate);
    const audioL = new Float32Array(totalSamples);
    const audioR = new Float32Array(totalSamples);
    let pos = 0;
    for (let f = 0; f < totalFrames && pos < totalSamples && !player.ended; f++) {
      const chunk = player.renderFrame(sampleRate, false, true);
      const n = Math.min(chunk.left.length, totalSamples - pos);
      audioL.set(chunk.left.subarray(0, n), pos);
      audioR.set(chunk.right.subarray(0, n), pos);
      pos += n;
      if (f % 300 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    vgmIsRendering = false;
    updateVgmPlayButton();

    const base = (MML.VGM.displayTitle(loadedVgmHeader) || fileInputName(vgmFileEl).replace(/\.[^.]+$/, '') || 'vgm').replace(/[\\/:*?"<>|]/g, '_');
    const filename = await downloadExportAudio(base, [audioL.subarray(0, pos), audioR.subarray(0, pos)], sampleRate, 1.0, vgmFileStatusEl);
    vgmFileStatusEl.innerHTML = '<div class="ok">' + T('書き出し完了: {file}', { file: filename }) + '</div>';
  }

  // ── VGM チャンネル割当(変換元ch→借用先) ──
  // 割当UIはVGMパネル専用の表を廃し、鍵盤表示の行(part列チップ/借用先列、案E)へ集約した。
  // ここではヘッダから決まる構成駆動の既定割当(MML.VGM2MML.defaultPlan)を鍵盤の行ID
  // (KP1/KS1/KF1/YM1/SN1…)へ移して既定として登録し、変換時にユーザー指定を読み戻す。
  function vgmSetPlanDefaults(h) {
    const Plan = MML.Convert.ChannelPlan;
    if (!h) { Plan.newFile('vgm', {}, loadedVgmName); return; }
    const plan = MML.VGM2MML.defaultPlan(h);
    const map = {};
    for (const srcId of Object.keys(plan)) {
      const chId = Plan.chIdForVgmSource(srcId);
      if (chId) map[chId] = plan[srcId];
    }
    // ストリーミングDACの既定は E(DPCM)(2026-09-04、ユーザー指示)。メガドライブの
    // ドラムはYM2612のDACに載っていることがほとんどで、打点はVGMログの
    // シーク位置から正確に取れる(vgmDacDrumFor)。他に行き場が無い行でもある
    // (音程を持たないので旋律chへは載せられない)。
    // X68000のADPCM(OKIM6258)も同じ(2026-09-05、ユーザー指示): ドラム/ボイスがここに載り、
    // 打点はDACストリームの開始アドレスから取れる(DAC_ROW_CHIP)。
    if (h.chips && h.chips.ym2612) map.YMDA = 'dpcm';
    if (h.chips && h.chips.okim6258) map.OKI = 'dpcm';
    // 32X PWM(2026-09-10): 合成済みストリーム(音声/ドラム)は E(DPCM) へ。L/R は PWL に集約(vgmStreamDrumFor)
    if (h.chips && h.chips.pwm) map.PWL = 'dpcm';
    // MSM5205(2026-09-16): PC Engine CD の ADPCM は 0x32 の直書きで、サンプルの同定キーが
    // 無い(DACストリームではない)。32X PWM と同じ「無音の切れ目でクリップに分ける」経路で
    // E(DPCM) へ載せる(vgmStreamDrumFor)。
    if (h.chips && h.chips.msm5205) map.M5 = 'dpcm';
    Plan.newFile('vgm', map, loadedVgmName);
  }
  // 現在の割当をVGM変換器のソースID体系で返す。既定と全く同じなら null(=構成から自動)
  function getVgmChannelMap() {
    if (!loadedVgmHeader) return null;
    const Plan = MML.Convert.ChannelPlan;
    const src = MML.VGM2MML.sourceChannels(loadedVgmHeader);
    // NES/GB/HuC6280のVGMはvgm2mmlが nsf2mml/gbs2mml/hes2mml へ丸ごと委譲する。
    // それらの変換器は鍵盤表示の行IDをそのままキーに使うので、変換せずに渡す。
    if (!src.length) return planConvertOptions().channelMap;
    const def = MML.VGM2MML.defaultPlan(loadedVgmHeader);
    const map = {};
    let changed = false;
    for (const s of src) {
      const chId = Plan.chIdForVgmSource(s.id);
      const ent = (chId && Plan.get(chId)) || {};
      map[s.id] = ent.target || def[s.id] || 'skip';
      if (map[s.id] !== (def[s.id] || 'skip')) changed = true;
    }
    // ★ドラムパート(合成ch)は鍵盤に行が無いので割当UIから直接触れない。既定では
    //   SN76489のノイズが2A03ノイズ(1枠しかない)を先に取り、ドラムは'skip'になる。
    //   ユーザーがSNノイズをスキップにして枠を空けたら、ドラムがそこへ入れるようにする
    //   (=「2つあったらどっちを鳴らすか」を鍵盤側の操作だけで選べるようにする)。
    const noiseTaken = src.some(s => map[s.id] === 'noise');
    if (!noiseTaken) {
      const drum = src.find(s => /:drum$/.test(s.id) && map[s.id] === 'skip');
      if (drum) { map[drum.id] = 'noise'; changed = true; }
    }
    return changed ? map : null;
  }
  // VRC7を借用先に選んだchの音色プリセット(sourceId → 'auto'|'0'..'15')。
  // 鍵盤側の「音色」セレクト(tone)がそのままこの値になる。
  // 借用先ごとの音色(デューティ/波形/ノイズ周期)をVGMのソースID('opn:0' 等)で引ける形にする
  // (getVgmVrc7Inst と同じ写像。planConvertOptions().tone は鍵盤の行IDキーなので VGM では使わない)
  function getVgmTone() {
    const Plan = MML.Convert.ChannelPlan;
    const map = {};
    if (!loadedVgmHeader) return map;
    for (const s of MML.VGM2MML.sourceChannels(loadedVgmHeader)) {
      const chId = Plan.chIdForVgmSource(s.id);
      const ent = (chId && Plan.get(chId)) || {};
      if (ent.tone !== undefined) map[s.id] = ent.tone;
    }
    return map;
  }
  function getVgmVrc7Inst() {
    const Plan = MML.Convert.ChannelPlan;
    const map = {};
    if (!loadedVgmHeader) return map;
    const def = MML.VGM2MML.defaultPlan(loadedVgmHeader);
    for (const s of MML.VGM2MML.sourceChannels(loadedVgmHeader)) {
      const chId = Plan.chIdForVgmSource(s.id);
      const ent = (chId && Plan.get(chId)) || {};
      const target = ent.target || def[s.id] || 'skip';
      if (!/^vrc7_/.test(target)) continue;
      map[s.id] = ent.tone !== undefined ? ent.tone : MML.VGM2MML.defaultVrc7Inst(s.kind);
    }
    return map;
  }

  async function runVgm2Mml() {
    if (!loadedVgmBytes) {
      vgmFileStatusEl.innerHTML = '<div class="error">' + T('先にVGMファイルを読み込んでください。') + '</div>';
      return;
    }
    if (vgmIsRendering) return;
    const duration = parseInt(vgmPlayDurEl.value, 10) || vgmDefaultDuration(loadedVgmHeader);
    vgmIsRendering = true;
    updateVgmPlayButton();
    vgmFileStatusEl.innerHTML = '<div>' + T('MML変換用キャプチャ中… (数秒かかります)') + '</div>';
    await new Promise(resolve => setTimeout(resolve, 10));

    const vgmManualBpm = getManualBpm('vgm');
    let result;
    try {
      await synthDrumEnsure(); // 打楽器化したchの分離レンダリングを確定させる
      // ★drumHits(E へ載せたchの打点)を渡し忘れていた: VGMだけ他5形式と違って
      //   planConvertOptions() の tone しか取っていなかったため、YM2612のDACなどを
      //   打楽器化してもMMLのEパートに出なかった(2026-09-04修正)
      const planOpt = planConvertOptions();
      result = await MML.VGM2MML.fromVgm(loadedVgmBytes, duration, { bpm: vgmManualBpm, channelMap: getVgmChannelMap(), vrc7Inst: getVgmVrc7Inst(), tone: getVgmTone(), drumHits: planOpt.drumHits, toneSettings: planOpt.toneSettings, cmd: MML.UI.ConvertSettings.get(), poolMode: Object.assign({}, vgmPoolModes), onProgress: makeCaptureProgress(vgmFileStatusEl) });
    } catch (e) {
      vgmIsRendering = false;
      updateVgmPlayButton();
      vgmFileStatusEl.innerHTML = '<div class="error">' + T('変換エラー: {msg}', { msg: e.message }) + '</div>';
      return;
    }
    vgmIsRendering = false;
    updateVgmPlayButton();

    resetMmlForNewSong(); // 別の曲になるのでログ/ファイル名/外部同期は引き継がない
    mmlSourceEl.value = result.mml;
    noteToneDemotions(result);
    resetDpcmEditor();
    mmlSourceEl.dispatchEvent(new Event('input'));

    // 委譲先ファミリに応じた波形エディタ反映(nsf2mml: FDS/N163、kss2mml: SCC→N163、gbs2mml: GB波形→FDS)
    if (result.fdsWave && MML.WaveformEditor.fdsWave) MML.WaveformEditor.fdsWave.setData(result.fdsWave);
    if (result.n163Wave && MML.WaveformEditor.n163Wave) MML.WaveformEditor.n163Wave.setData(result.n163Wave);
    takeDpcmFiles(result.dpcmFiles); // .dmc は台帳へ(保存時に同じフォルダへ書き出せる)

    // 借用先の説明(ファミリごと)。ネイティブ変換(NES)は借用無し。
    // PSG系(AY/SCC/OPLL/SN)は構成から自動割当した借用先をそのまま出す(vgm2mml/converter.js composePsgLike)
    const borrowNote = result.family === 'psg'
      ? T('(借用先: {assign})', { assign: (result.assignments || []).join(', ') })
      : (({ gb: T('(2A03/FDSを借用して再生)'), hes: T('(N163を借用して再生)'), nes: '' })[result.family] || '');
    const ignoredMsg = (result.ignoredChips && result.ignoredChips.length)
      ? T('。対象外の音源は無視: {chips}', { chips: result.ignoredChips.join(', ') }) : '';
    // DPCM(打楽器を実サンプルのまま焼いた分)の実測コスト。実機ROMの容量を意識できるよう
    // 定義数とバイト数をその場に出す(ユーザー要望)
    const ds = result.dpcmStats;
    const dpcmMsg = ds ? '<div>' + T('DPCM: 定義 {clips} 件 / 打点 {segments} 個 / ROM {kb} KB',
      { clips: ds.clips, segments: ds.segments, kb: (ds.bytes / 1024).toFixed(1) }) + '</div>' : '';
    vgmFileStatusEl.innerHTML =
      '<div class="ok">' + T('MML変換完了 ({mode} {bpm} BPM、音源: {chips}) → MMLエディタに出力{borrow}{ignored}',
        { mode: vgmManualBpm ? T('指定') : T('推定'), bpm: result.bpm, chips: (result.chips || []).join(', '), borrow: borrowNote, ignored: ignoredMsg }) + '</div>' +
      dpcmMsg + renderTuning(result.tuning) + renderPitchCheck(result.pitchCheck);

    rangeStartSec = 0;
    rangeEndSec = null;
    prepareMmlStream(true);
  }

  vgmFileEl.addEventListener('change', loadVgmFile);
  document.getElementById('btnVgmFilePlay').addEventListener('click', () => {
    playVgmStream();
    keyboardDisplay.setMode('nsf');
  });
  document.getElementById('btnVgmFileStop').addEventListener('click', () => {
    stopVgmPlayback();
    keyboardDisplay.setMode('nsf');
  });
  document.getElementById('btnVgmExportWav').addEventListener('click', exportVgmWav);
  // 「to MML」は変換設定画面を開き、その中の「コンバート開始」で変換する(ユーザー要望)
  document.getElementById('btnVgm2Mml').addEventListener('click', () => MML.UI.ConvertSettings.open({ format: 'vgm', onConvert: runVgm2Mml }));

  // ==========================================================================
  // 統合サウンドファイルウィンドウ: 拡張子でNSF/SPC/KSSパネルを切り替える
  // ==========================================================================
  (function initUnifiedSoundFileWindow() {
    const soundFileEl = document.getElementById('soundFile');
    const formatToInputId = { nsf: 'nsfFile', spc: 'spcFile', kss: 'kssFile', gbs: 'gbsFile', hes: 'hesFile', vgm: 'vgmFile', psf: 'psfFile' };
    // ファイル情報ペインの見出し。翻訳は keyboard.js 側でT()を通すので原文のまま渡す
    const FORMAT_INFO_TITLE = {
      nsf: 'ヘッダ情報 (NSF/NSFe)',
      spc: 'ヘッダ情報 (SPC)',
      kss: 'ヘッダ情報 (KSS: MSX PSG/SCC/FMPAC)',
      gbs: 'ヘッダ情報 (GBS: Game Boy)',
      hes: 'ヘッダ情報 (HES: PC Engine/TurboGrafx-16)',
      vgm: 'ヘッダ情報 (VGM)',
      psf: 'ヘッダ情報 (PSF: PlayStation)',
    };

    // 開いているフォーマットのヘッダ情報とログ(#xxxFileHeader / #xxxFileStatus)を、
    // 鍵盤表示のファイル情報ペインへ付け替える。旧「サウンドファイルを開く」ウィンドウを
    // 廃止した代わりの表示先で、置き場(一覧の上/下/左/右)は鍵盤表示のレイアウト設定で選ぶ
    // (2026-09-10。要素そのものは #soundFileControls の中に作ったままで、親だけを移す)。
    function syncKeyboardFileInfo(format) {
      if (!keyboardDisplay.setFileInfo) return;
      const title = FORMAT_INFO_TITLE[format];
      if (!title) { keyboardDisplay.setFileInfo('', []); return; }
      const nodes = [
        archiveBarEl,                                        // zip/7zのファイル名(開いている時だけ表示)
        document.getElementById(format + 'FileHeader'),
        document.getElementById(format + 'FileStatus'),
      ];
      keyboardDisplay.setFileInfo(title, nodes);
    }

    function showSoundPanel(format) {
      ['none', 'nsf', 'spc', 'kss', 'gbs', 'hes', 'vgm', 'psf'].forEach((f) => {
        const panel = document.getElementById('soundPanel-' + f);
        if (panel) panel.style.display = f === format ? '' : 'none';
      });
      syncKeyboardFileInfo(format);
    }

    // サウンドファイルを開いたら鍵盤表示を出す(旧「サウンドファイルを開く」ウィンドウの
    // 代わり。ヘッダ情報も再生もここに集まっている)。トグルボタンのclick()を使わない理由は
    // 「開いている時に押すと閉じる」方向へ働くため。floatingWindows.jsのsetVisible相当を直接行う
    // (表示stateのlocalStorage永続化は次のトグル操作時点で追いつくので実害はない)。
    function ensureKeyboardWindowOpen() {
      const win = document.getElementById('win-keyboard');
      if (!win) return;
      if (win.style.display === 'none') {
        win.style.display = 'flex';
        const btn = document.querySelector('.toggle-btn[data-target="win-keyboard"]');
        if (btn) btn.classList.add('active');
      }
      if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-keyboard');
    }

    // 拡張子→loadXxxFile()。ファイル選択ダイアログはinputのchangeイベント経由でこれと
    // 同じ関数を呼んでいる(nsfFileEl.addEventListener('change', loadNsfFile)等)。
    // ドラッグ&ドロップ側はイベント発火だと完了(非同期)を待てず再生開始のタイミングが
    // 取れないため、openSoundFile()からは直接awaitで呼ぶ(inputのfilesへは同じくセットする
    // ので、loadXxxFile()側から見た見え方はダイアログ経由と変わらない)。
    const formatToLoadFn = { nsf: loadNsfFile, spc: loadSpcFile, kss: loadKssFile, gbs: loadGbsFile, hes: loadHesFile, vgm: loadVgmFile, psf: loadPsfFile };
    // ドラッグ&ドロップは「開いてそのまま再生」までを1操作で行いたいというユーザー要望。
    // ファイル選択ダイアログ側は従来通りヘッダ確認後に手動で再生ボタンを押す2段階のまま
    // 変えない(呼び出し元のdropハンドラでだけ再生を始める、openSoundFile自体は再生しない)。
    // ★再生は各フォーマットの再生ボタンのclickに委ねる: 以前はplayXxxStream()を直接呼んで
    // いたため、ボタン側が一緒に行う処理(SPCのstartVoiceMonitor()+setMode('spc')等)を
    // 通らず、D&D再生ではロールは動くのにチャンネル一覧が更新されない不具合があった
    // (ボタンidの表はSOUND_FORMAT_PLAY_BTN。鍵盤表示タイトル行の▶も同じ表を使う)
    const formatToPlayFn = {};
    for (const [fmt, id] of Object.entries(SOUND_FORMAT_PLAY_BTN)) {
      formatToPlayFn[fmt] = () => { const btn = document.getElementById(id); if (btn) btn.click(); };
    }

    // ==== アーカイブ(zip/7z)曲リスト ====
    // 「1アーカイブ = 1ゲーム分の複数トラック(+.m3u)」という配布単位(vgmrips/zophar等)を、
    // 全フォーマット共通の「曲リストの器」として扱う。SPC/VGMのように単体では曲番号の
    // 概念が無い形式でも、アーカイブを開けば他形式と同じ曲送りが成立する(NSF等の複数曲
    // 形式は「アーカイブ内のファイル送り」と「ファイル内の曲送り」の2段になる)。
    // 解析/解凍は src/archive/archive.js(MML.Archive。7zは sevenzip.js + lzma.js)。
    // アーカイブ内エントリのフォーマットは拡張子で決めるが、gzip(.vgz)は各loadXxxFile側が
    // 中身で判別する。
    // .psflib は曲ではなく _lib で参照される共通部品なので曲リストには載せない(PSF.load が名前で引く)
    const ARCHIVE_EXTS = ['nsf', 'nsfe', 'spc', 'kss', 'gbs', 'hes', 'vgm', 'vgz', 'psf', 'minipsf'];
    const archiveBarEl = document.getElementById('archiveBar');
    const archiveTrackBarEl = document.getElementById('archiveTrackBar');
    const archiveNameEl = document.getElementById('archiveName');
    const archiveSelectEl = document.getElementById('archiveTrackSelect');
    const archiveTotalEl = document.getElementById('archiveTrackTotal');
    let archive = null; // { name, bytes, playlist:[{entry,title}], index }
    let archiveLoading = false;

    function clearArchive() {
      archive = null;
      if (archiveBarEl) archiveBarEl.style.display = 'none';
      if (archiveTrackBarEl) archiveTrackBarEl.style.display = 'none';
      if (archiveSelectEl) archiveSelectEl.innerHTML = '';
    }

    // アーカイブ表示: ファイル名は #archiveBar(鍵盤表示のファイル情報ペインの一番上)に出す。
    // 曲リスト(#archiveTrackBar)は鍵盤表示タイトル行のファイル名ボタン(曲一覧のドロップダウン)
    // と ⏮⏭ が担うので隠したままにし、ここでは選択状態の同期だけ行う。
    function renderArchiveBar() {
      if (!archiveBarEl) return;
      if (!archive) { archiveBarEl.style.display = 'none'; if (archiveTrackBarEl) archiveTrackBarEl.style.display = 'none'; return; }
      archiveBarEl.style.display = '';
      archiveNameEl.textContent = archive.name;
      archiveNameEl.title = archive.name;
      archiveSelectEl.innerHTML = '';
      archive.playlist.forEach((item, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `${i + 1}. ${item.title}`;
        archiveSelectEl.appendChild(opt);
      });
      archiveSelectEl.value = String(archive.index);
      archiveTotalEl.textContent = `/ ${archive.playlist.length}`;
    }

    // 拡張m3u("file::KSS,song,...")の曲番号を、その形式の曲番号入力欄へ反映する。
    // m3uの番号は形式ごとのネイティブ表記(NSF/GBS=1始まり、KSS/HES=0始まり)で書かれる
    // 慣例なので、各入力欄(同じ表記)へそのまま入れる。1ファイル1曲の形式(SPC/VGM)は無視。
    function applyArchiveSong(fmt, song) {
      const id = SOUND_FORMAT_SONG_INPUT[fmt];
      const el = id ? document.getElementById(id) : null;
      if (!el || song === null || song === undefined) return;
      const min = el.min !== '' ? parseInt(el.min, 10) : -Infinity;
      const max = el.max !== '' ? parseInt(el.max, 10) : Infinity;
      el.value = String(Math.max(min, Math.min(max, song)));
    }

    // アーカイブ内の index 番目の項目を開く。戻り値は openSoundFile と同じ(フォーマット文字列 or false)。
    // autoplay=true なら再生まで行う(曲送り操作用)。同じファイルの曲番号違い(KSSの拡張m3u等)
    // なら読み直さず曲番号だけ変える。
    async function loadArchiveIndex(index, autoplay) {
      if (!archive || archiveLoading) return false;
      const n = archive.playlist.length;
      if (n === 0) return false;
      index = ((index % n) + n) % n;
      archive.index = index;
      archiveLoading = true;
      try {
        const item = archive.playlist[index];
        let fmt;
        if (archive.loadedEntry === item.entry && archive.loadedFormat) {
          fmt = archive.loadedFormat;
          renderArchiveBar();
        } else {
          const bytes = await MML.Archive.readEntry(archive.bytes, item.entry);
          const entryFile = new File([bytes], MML.Archive.baseName(item.entry.name));
          // PSF の _lib(.psflib)はアーカイブ内の兄弟ファイルから引く(エントリと同じフォルダを優先)
          psfSiblingResolver = makeArchiveSiblingResolver(archive, item.entry);
          renderArchiveBar();
          fmt = await openSoundFile(entryFile, { fromArchive: true });
          archive.loadedEntry = fmt ? item.entry : null;
          archive.loadedFormat = fmt || null;
          renderArchiveBar(); // フォーマットが確定したので曲名/選択状態を更新する
        }
        if (fmt) applyArchiveSong(fmt, item.song);
        if (fmt && autoplay) {
          const playFn = formatToPlayFn[fmt];
          if (playFn) playFn();
        }
        return fmt;
      } catch (e) {
        alert(T('アーカイブ内のファイルを開けませんでした: {msg}', { msg: e.message }));
        return false;
      } finally {
        archiveLoading = false;
      }
    }

    async function openArchive(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let parsed;
      try { parsed = await MML.Archive.parse(bytes); }
      catch (e) { alert(T('アーカイブを解析できませんでした: {msg}', { msg: e.message })); return false; }
      let playlist;
      try {
        playlist = await MML.Archive.buildPlaylist(parsed.entries, ARCHIVE_EXTS, (m3u) => MML.Archive.readEntry(bytes, m3u));
      } catch (e) { alert(T('アーカイブを解析できませんでした: {msg}', { msg: e.message })); return false; }
      if (playlist.length === 0) {
        alert(T('アーカイブ内に対応するサウンドファイル(NSF/NSFE/SPC/KSS/GBS/HES/VGM/PSF)がありません。'));
        return false;
      }
      stopAllFormatPlayback();
      archive = { name: file.name, bytes, playlist, index: 0, loadedEntry: null, loadedFormat: null, entries: parsed.entries };
      ensureKeyboardWindowOpen();
      renderArchiveBar();
      return loadArchiveIndex(0, false);
    }

    function changeArchiveTrack(delta) {
      if (!archive) return;
      const n = archive.playlist.length;
      const next = wrapIndex(archive.index + delta, 0, n - 1); // 端で折り返す
      if (next === archive.index) return;
      stopAllFormatPlayback();
      loadArchiveIndex(next, true);
    }

    // 1ファイル1曲の形式(SPC/VGM)の再生終了/無音時の自動送り: アーカイブを開いていれば次の
    // エントリへ(末尾は先頭へラップ)、単体ファイルなら何もしない(従来どおり停止のまま)。
    archiveAutoAdvanceOrStop = () => {
      // 曲が終わった後の挙動(鍵盤表示ヘッダのアイコン)に従う。
      // ★「同じ曲を繰り返す」は単体ファイル(アーカイブ無し/1曲だけ)でも効かせる。
      //   以前はここで即returnしていたため、単体のSPC/VGMではリピートが効かなかった
      if (!archive || archive.playlist.length <= 1) {
        if (repeatMode() === 'one') {
          const playFn = { spc: playSpcStream, vgm: playVgmStream, psf: playPsfStream }[lastPlayMode];
          if (playFn) { playFn(); return; }
        }
        updateKeyboardTransport();
        return;
      }
      const next = nextIndexFor(archive.index, 0, archive.playlist.length - 1);
      if (next === null) { updateKeyboardTransport(); return; }
      loadArchiveIndex(next, true);
    };

    // 鍵盤表示タイトル行の ⏮/⏭ 用。アーカイブ(m3u)を開いていればそちらのファイル送りを
    // 優先し、単体ファイルなら曲番号送りへ落ちる(updateKeyboardTransport / onTransport参照)
    archiveTrackCount = () => (archive ? archive.playlist.length : 0);
    archiveChangeTrack = (delta) => changeArchiveTrack(delta);
    archiveInfo = () => archive
      ? { name: archive.name, titles: archive.playlist.map((it, i) => `${i + 1}. ${it.title}`), index: archive.index }
      : null;
    archiveSelectTrack = (i) => {
      if (!archive || i === archive.index || i < 0 || i >= archive.playlist.length) return;
      stopAllFormatPlayback();
      loadArchiveIndex(i, true);
    };

    if (archiveBarEl) {
      document.getElementById('btnArchivePrev').addEventListener('click', () => changeArchiveTrack(-1));
      document.getElementById('btnArchiveNext').addEventListener('click', () => changeArchiveTrack(1));
      archiveSelectEl.addEventListener('change', () => {
        const i = parseInt(archiveSelectEl.value, 10);
        if (!archive || isNaN(i) || i === archive.index) return;
        stopAllFormatPlayback();
        loadArchiveIndex(i, true);
      });
    }

    // ファイル選択ダイアログ・ドラッグ&ドロップの両方から呼ばれる共通処理。拡張子で
    // 対応フォーマットを判定し、フォーマット別の隠しinputへfilesをセットしてloadXxxFile()の
    // 完了を待つ。戻り値は成功時のフォーマット文字列('nsf'等)、失敗時false。
    // 複数ファイルが来たときに「開く曲」を選ぶ。PSF の .psflib は部品なので曲を優先する
    function pickPrimarySoundFile(files) {
      if (!files || !files.length) return null;
      if (files.length === 1) return files[0];
      const ext = (fl) => fl.name.split('.').pop().toLowerCase();
      return files.find(fl => ext(fl) !== 'psflib' && ext(fl) !== 'dmc') || files[0];
    }
    function makeFileListSiblingResolver(files) {
      const list = Array.from(files || []);
      if (!list.length) return null;
      return async (name) => {
        const want = MML.Archive.baseName(name).toLowerCase();
        const hit = list.find(fl => fl.name.toLowerCase() === want);
        return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
      };
    }
    function makeArchiveSiblingResolver(arc, entry) {
      if (!arc || !arc.entries) return null;
      const dir = entry.name.lastIndexOf('/') >= 0 ? entry.name.slice(0, entry.name.lastIndexOf('/') + 1) : '';
      return async (name) => {
        const lower = name.replace(/\\/g, '/').toLowerCase();
        const files = arc.entries.filter(e => !e.isDir);
        const hit = files.find(e => e.name.toLowerCase() === (dir + lower))
          || files.find(e => e.name.toLowerCase() === lower)
          || files.find(e => MML.Archive.baseName(e.name).toLowerCase() === MML.Archive.baseName(lower));
        return hit ? MML.Archive.readEntry(arc.bytes, hit) : null;
      };
    }

    async function openSoundFile(file, opts) {
      if (!file) return false;
      let ext = file.name.split('.').pop().toLowerCase();
      // zip/7z: 中のサウンドファイルを曲リストとして開く(上記アーカイブ節)。アーカイブ内から
      // 再帰的に呼ばれた場合(opts.fromArchive)は通常のファイルとして扱う。
      if ((ext === 'zip' || ext === '7z') && !(opts && opts.fromArchive)) return openArchive(file);
      if (!(opts && opts.fromArchive)) clearArchive(); // 単体ファイルを開いたらアーカイブ曲リストは閉じる
      if (ext === 'vgz') ext = 'vgm'; // gzip圧縮VGM(中身の判別はloadVgmFile側)
      if (ext === 'nsfe') ext = 'nsf'; // NSFe(チャンク形式のNSF拡張。素のNSFへの変換はloadNsfFile→MML.NSF.normalize)
      if (ext === 'minipsf') ext = 'psf'; // _lib を参照する小さな PSF(中身の形式は同じ)
      if (ext === 'psflib') {
        alert(T('.psflib は曲ではなく共通部品です。.minipsf と一緒に選ぶか、zip のまま開いてください。'));
        return false;
      }
      // 単体ファイルとして開いた PSF の _lib は、同時に選ばれた/ドロップされたファイルから引く
      if (!(opts && opts.fromArchive)) psfSiblingResolver = makeFileListSiblingResolver(opts && opts.siblings);
      // MMLテキスト(.mml/.txt)はサウンドファイルではなくMMLエディタ側で開く。
      // 戻り値'mml'はformatToPlayFnに載っていないので、ドラッグ&ドロップでも
      // 読み込むだけで自動再生はしない(コンパイル準備まではopenMmlTextFileが行う)
      if (ext === 'mml' || ext === 'txt') {
        // opts.handle: ドラッグ&ドロップから拾えたFileSystemFileHandle。あれば
        // そのまま外部エディタとの同期対象になる(src/ui/fileSync.js)。一緒に来た .dmc は台帳へ
        return (await openMmlTextFile(file, opts && opts.handle, ((opts && opts.siblings) || []).filter(isDmcFile))) ? 'mml' : false;
      }
      const targetInputId = formatToInputId[ext];
      if (!targetInputId) {
        alert(T('対応していないファイル形式です: .{ext}\n(対応形式: NSF/NSFE, SPC, KSS, GBS, HES, VGM/VGZ, PSF/MINIPSF, ZIP, 7Z, MML, TXT)', { ext }));
        return false;
      }
      ensureKeyboardWindowOpen();
      const targetInput = document.getElementById(targetInputId);
      const dt = new DataTransfer();
      dt.items.add(file);
      targetInput.files = dt.files;
      showSoundPanel(ext);
      const loadFn = formatToLoadFn[ext];
      if (loadFn) await loadFn();
      return ext;
    }

    // ファイル選択ダイアログもドラッグ&ドロップと同じく「開いたらそのまま再生」する
    // (2026-09-09 ユーザー指示「鍵盤表示でファイル開いたら即再生」。鍵盤表示の
    //  「開く」ボタンもこの input を click() するので、ここ1か所で全経路が揃う)。
    // MMLテキスト('mml')は formatToPlayFn に載っていないので読み込むだけ(ユーザー指示 2026-09-10:
    // 「サウンドファイルなら鍵盤表示を開いて再生 / MMLファイルならMMLエディタを開いて何もしない」。
    //  鍵盤表示を開くのは openSoundFile、MMLエディタを開くのは openMmlTextFile が行う)
    soundFileEl.addEventListener('change', async () => {
      const files = Array.from(soundFileEl.files || []);
      if (files.length && files.every(isDmcFile)) { await openDmcOnly(files); soundFileEl.value = ''; return; }
      const file = pickPrimarySoundFile(files);
      if (!file) return;
      const ok = await openSoundFile(file, { siblings: files });
      if (!ok) { soundFileEl.value = ''; return; }
      const playFn = formatToPlayFn[ok];
      if (playFn) playFn();
    });

    // トップのツールバーの「ファイルを開く」アイコン。かつては「サウンドファイルを開く」
    // ウィンドウのトグルだったが、そのウィンドウを廃止したので今はダイアログを出すだけ
    const openBtn = document.getElementById('btnOpenFile');
    if (openBtn) openBtn.addEventListener('click', () => soundFileEl.click());

    // ドラッグ&ドロップでも同じ経路(openSoundFile)で開けるようにする。ウィンドウが
    // 閉じていてもページ上のどこにドロップしても拾う(ヘッダーの開くボタンと同じ
    // 「開く操作」として扱う)。dragover側でpreventDefault()しないとブラウザ既定動作の
    // ページ遷移(ファイルがそのまま開かれてアプリの状態が失われる)が起きてしまうため必須。
    const dropOverlayEl = document.getElementById('dropOverlay');
    let dragDepth = 0; // dragenter/dragleaveは子要素の出入りでも発火するため深度カウントで判定する
    function isFileDrag(e) {
      return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    }
    document.addEventListener('dragenter', (e) => {
      if (!isFileDrag(e)) return;
      dragDepth++;
      if (dropOverlayEl) dropOverlayEl.classList.add('visible');
    });
    document.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
    });
    document.addEventListener('dragleave', (e) => {
      if (!isFileDrag(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 && dropOverlayEl) dropOverlayEl.classList.remove('visible');
    });
    document.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth = 0;
      if (dropOverlayEl) dropOverlayEl.classList.remove('visible');
      const dropped = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (dropped.length && dropped.every(isDmcFile)) { openDmcOnly(dropped); return; }
      const file = pickPrimarySoundFile(dropped);
      if (!file) return;
      // DataTransferItemはこのハンドラを抜けると無効になるので、ハンドルの取得だけは
      // ここで同期的に始める(awaitは後でよい)。.mmlをドロップしたときに外部エディタとの
      // 同期対象にするために使う(src/ui/fileSync.js)。取れなければ従来どおり読むだけ
      const handlePromise = MML.UI.FileSync.handleFromDropItem(e.dataTransfer.items && e.dataTransfer.items[0]);
      // ドラッグ&ドロップは開いた直後に自動再生まで行う(ファイル選択ダイアログとの
      // 唯一の挙動差。ensureKeyboardWindowOpen/showSoundPanel等の中身はopenSoundFile側で共通)。
      Promise.resolve(handlePromise).catch(() => null).then((handle) => {
        return openSoundFile(file, { handle: (handle && handle.kind === 'file') ? handle : null, siblings: dropped });
      }).then((ext) => {
        const playFn = ext && formatToPlayFn[ext];
        if (playFn) playFn();
      });
    });

    // 鍵盤表示を閉じたらサウンドファイルの再生を止め、先読みキャプチャ(writeLog/snapshots等)も
    // 破棄する(floatingWindows.jsの汎用closeハンドラは表示/非表示の切替のみで、鳴りっぱなし・
    // メモリ蓄積を防ぐ処理を持たないため追加で配線する)。旧「サウンドファイルを開く」
    // ウィンドウの閉じるボタンが担っていた役目を、その表示先である鍵盤表示へ移したもの
    const kbdWinCloseBtn = document.querySelector('#win-keyboard .float-window-close');
    if (kbdWinCloseBtn) {
      kbdWinCloseBtn.addEventListener('click', () => stopSoundFileWindowPlayback());
    }
  })();

  // 鍵盤表示タイトル行の再生コントロールの初期状態(起動直後=まだ何も再生していない=MML扱い)。
  // ★ここで呼ぶ理由: updateKeyboardTransport()はcurrentTransportPlayer()経由で
  // kssActivePlayer等のlet変数を読むので、それらの宣言(ファイル中ほど)より前で呼ぶと
  // TDZの ReferenceError になり、以降の初期化(各ボタンのaddEventListener等)が丸ごと止まる。
  updateKeyboardTransport();
})();
