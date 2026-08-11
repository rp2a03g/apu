/*
 * English dictionary.
 *
 * キー = 日本語の原文(src/i18n/i18n.js の gettext式)。訳し忘れたキーは日本語のまま出る。
 * 点検方法: 英語表示に切り替えてからコンソールで
 *     MML.I18n.missing('en', MML.UI.I18nDom.untranslated())
 * 言語を増やすときはこのファイルをコピーして値だけ差し替え、index.html に <script> を1行足す。
 *
 * 用語方針: MMLコマンド(@v, @FM, D<n> 等)・レジスタ名($4084等)・チップ名(VRC6, N163等)は
 * 万国共通の識別子なので翻訳しない。「ファミコン」は商標のため英語では NES / Famicom 表記を使う。
 */
(function (global) {
  'use strict';
  const I18n = global.MML && global.MML.I18n;
  if (!I18n) { console.error('[i18n] en.js: i18n.js より先に読み込まれています'); return; }

  I18n.register('en', 'English', {

    // ---- ヘッダー / ウィンドウ名 (index.html) ----
    'MMLコンパイラ（拡張音源対応）・NSF書き出し・NSF/SPC/KSSファイル再生・DPCMコンバータ・シンタックスハイライト':
      'MML compiler (expansion chips) · NSF export · NSF/SPC/KSS playback · DPCM converter · syntax highlighting',
    'サブウィンドウ:': 'Windows:',
    'DPCMコンバータ': 'DPCM Converter',
    'サウンドファイルを開く': 'Open Sound File',
    'レジスタ/メモリモニタ': 'Register / Memory Monitor',
    'レジスタ/メモリモニタ (リアルタイム)': 'Register / Memory Monitor (live)',
    '鍵盤表示': 'Keyboard',
    '鍵盤表示 (リアルタイム)': 'Keyboard (live)',
    'FDS波形エディタ': 'FDS Wave Editor',
    'N163波形エディタ': 'N163 Wave Editor',
    '閉じる': 'Close',

    // ---- MMLウィンドウ ----
    'MML作曲 & 再生・シーク': 'MML Composer & Playback',
    'ドラッグでエディタの高さを変更': 'Drag to resize the editor',
    '▶ MML再生': '▶ Play MML',
    '■ 停止': '■ Stop',
    'NSF出力': 'Export NSF',
    '開始点・終了点を曲の最初と最後にリセット': 'Reset start/end points to the whole song',
    '↺ 再生範囲をリセット': '↺ Reset range',
    '再生中ハイライト': 'Highlight while playing',
    '追随スクロール': 'Auto-scroll',
    '追随チャンネル:': 'Follow channel:',
    'なし': 'None',
    '開始点（ドラッグで移動）': 'Start point (drag to move)',
    '終了点（ドラッグで移動）': 'End point (drag to move)',
    '⏸ 一時停止': '⏸ Pause',
    '▶ 再生': '▶ Play',
    '一時停止': 'Pause',
    '再生': 'Play',

    // ---- DPCMコンバータ ----
    'DMCレート': 'DMC rate',
    '変換': 'Convert',
    '▶ プレビュー再生': '▶ Preview',
    'バイナリをダウンロード': 'Download binary',
    '音声ファイルを選択してください。': 'Please choose an audio file.',
    '元サンプルレート      : {rate} Hz': 'Source sample rate : {rate} Hz',
    '元サンプル数          : {n}': 'Source samples     : {n}',
    'DMCレート             : {idx} ({hz} Hz)': 'DMC rate           : {idx} ({hz} Hz)',
    'エンコード後サンプル数: {n}': 'Encoded samples    : {n}',
    'データサイズ          : {n} bytes': 'Data size          : {n} bytes',
    '再生時間              : {time}': 'Duration           : {time}',
    '--- バイナリダンプ (先頭256バイト) ---': '--- Binary dump (first 256 bytes) ---',

    // ---- @DPCM サンプル読み込み ----
    '読込中…': 'Loading...',
    '変換中…': 'Converting...',
    '読み込み済み({n}バイト、.dmc生データ)。再コンパイル/再生してください':
      'Loaded ({n} bytes, raw .dmc). Recompile / play to apply.',
    '読み込み済み({n}バイト、レート{freq}={hz}Hz)。再コンパイル/再生してください':
      'Loaded ({n} bytes, rate {freq} = {hz} Hz). Recompile / play to apply.',
    '変換失敗: {msg}': 'Conversion failed: {msg}',
    'MML内で参照されている@DPCMサンプル:': '@DPCM samples referenced by this MML:',
    '"{file}" (レート{freq}):': '"{file}" (rate {freq}):',
    '読み込み済み({n}バイト)': 'Loaded ({n} bytes)',
    '未読み込み(この曲は無音になります)': 'Not loaded (this part will be silent)',

    // ---- MMLコンパイル / NSF書き出し ----
    'コンパイル中…': 'Compiling...',
    'MMLコンパイルエラーのため書き出せません:': 'Cannot export: the MML has compile errors:',
    'ドライバのアセンブルに失敗しました(内部エラー):': 'Failed to assemble the driver (internal error):',
    '再生準備に失敗しました(内部エラー): {msg}': 'Failed to prepare playback (internal error): {msg}',
    'NSF書き出し完了: {bytes}バイト({banks}バンク、うち曲データ {songBanks}バンク)':
      'NSF exported: {bytes} bytes ({banks} banks, {songBanks} of them song data)',
    '注意: 拡張音源({chips})は現状のNSF書き出しでは未対応のため、該当チャンネルは無音になります(VRC6/MMC5/FME7は対応済み)。':
      'Note: NSF export does not support {chips} yet, so those channels will be silent (VRC6/MMC5/FME7 are supported).',
    '再生準備完了 (テンポ {tempo}, 拡張音源: {chips})': 'Ready to play (tempo {tempo}, expansion: {chips})',
    '総フレーム数: {n}': 'Total frames  : {n}',
    '総再生時間  : {time}': 'Total duration: {time}',
    'チャンネル{ch}: {n} 件': 'Channel {ch}: {n} write(s)',
    'なし (2A03のみ)': 'None (2A03 only)',

    // ---- サウンドファイルウィンドウ (共通) ----
    'NSF/SPC/KSS/GBSファイルを開くと、ここに再生画面が表示されます。（今後 HES/VGM 対応予定）':
      'Open an NSF/SPC/KSS/GBS file and its player will appear here. (HES/VGM planned)',
    '曲番号': 'Track',
    '再生時間(秒)': 'Length (sec)',
    '💾 WAV書き出し': '💾 Export WAV',
    '♪ MML変換': '♪ To MML',
    '変換テンポ': 'Tempo',
    '自動': 'Auto',
    '👆 タップ': '👆 Tap',
    '自動に戻す': 'Back to auto',
    'タップ1回目… 拍に合わせて続けてタップ': 'First tap... keep tapping on the beat',
    '{n}回タップ → {bpm} BPM': '{n} taps → {bpm} BPM',
    '自動検出に戻しました': 'Back to auto detection',
    '対応していないファイル形式です: .{ext}\n(対応形式: NSF, SPC, KSS, GBS, HES)':
      'Unsupported file type: .{ext}\n(Supported: NSF, SPC, KSS, GBS, HES)',
    'NSF (ファミコン)': 'NSF (NES)',
    'SPC (スーパーファミコン)': 'SPC (SNES)',
    'KSS (MSX)': 'KSS (MSX)',
    'GBS (Game Boy)': 'GBS (Game Boy)',
    'HES (PC Engine)': 'HES (PC Engine)',
    'NSF/SPC/KSS/GBS/HESファイルを開くと、ここに再生画面が表示されます。（今後 VGM 対応予定）':
      'Open an NSF/SPC/KSS/GBS/HES file to show the player here. (VGM support planned.)',

    // ---- NSFパネル ----
    'ヘッダ情報 (NSF)': 'Header (NSF)',
    'ファイルサイズが小さすぎます（NSFヘッダは128バイト必要です）。':
      'File is too small (an NSF header needs 128 bytes).',
    'NSFヘッダのマジックナンバーが不正です（NSFファイルではない可能性があります）。':
      'Bad NSF magic number (this may not be an NSF file).',
    '先にNSFファイルを読み込んでください。': 'Load an NSF file first.',
    'NTSC Speed     : {v} (1/1,000,000秒)': 'NTSC speed     : {v} (1/1,000,000 s)',
    'PAL Speed      : {v} (1/1,000,000秒)': 'PAL speed      : {v} (1/1,000,000 s)',
    '拡張音源       : {chips} ({hex})': 'Expansion      : {chips} ({hex})',
    '曲 {song} / {total}  再生時間: {time}': 'Track {song} / {total}  Length: {time}',
    'MML変換用レンダリング中…': 'Rendering for MML conversion...',
    'MML変換中…': 'Converting to MML...',
    '変換エラー: {msg}': 'Conversion error: {msg}',
    'MML変換完了 ({mode} {bpm} BPM{exp}{dpcm}) → MMLエディタに出力しました':
      'Converted to MML ({mode} {bpm} BPM{exp}{dpcm}) → written to the MML editor',
    '指定': 'manual',
    '推定': 'detected',
    '、DPCM {n} ファイル出力': ', {n} DPCM file(s) written',
    '、拡張音源: {chips}': ', expansion: {chips}',
    'WAV書き出し用レンダリング中…': 'Rendering for WAV export...',
    'WAV書き出し中… {pct}%': 'Exporting WAV... {pct}%',
    'WAV + レジスタログ書き出し完了: {file}<br>音源: {chips}':
      'WAV + register log exported: {file}<br>Chips: {chips}',

    // ---- SPCパネル ----
    'ヘッダ情報 (SPC)': 'Header (SPC)',
    'ボイスモニター': 'Voice Monitor',
    'SPC ヘッダが不正です。': 'Invalid SPC header.',
    '読み込みエラー: {msg}': 'Load error: {msg}',
    '先にSPCファイルを読み込んでください。': 'Load an SPC file first.',
    'ID666       : {v}': 'ID666       : {v}',
    'あり': 'yes',
    '曲名        : {v}': 'Song        : {v}',
    'ゲーム      : {v}': 'Game        : {v}',
    'アーティスト: {v}': 'Artist      : {v}',
    'ダンパー    : {v}': 'Dumper      : {v}',
    'コメント    : {v}': 'Comment     : {v}',
    'ダンプ日    : {v}': 'Dump date   : {v}',
    '推奨再生時間: {v} 秒': 'Length      : {v} s',
    '(無題)': '(untitled)',
    '再生中: {title}  (最大 {time})': 'Playing: {title}  (max {time})',
    'MML変換用キャプチャ中… (数秒かかります)': 'Capturing for MML conversion... (takes a few seconds)',
    'MML変換完了 ({mode} {bpm} BPM{exp}{dpcm}) → MMLエディタに出力':
      'Converted to MML ({mode} {bpm} BPM{exp}{dpcm}) → written to the MML editor',
    '書き出し完了: {name}.wav + {name}_dsp_log.csv<br>DSP書き込み {writes} 件 / KON {kon} 件 (先頭{sec}秒)':
      'Exported: {name}.wav + {name}_dsp_log.csv<br>{writes} DSP writes / {kon} key-ons (first {sec} s)',
    'スキップ': 'Skip',
    'DPCM変換': 'DPCM',
    'E: FDS 波形': 'E: FDS wave',
    'G: VRC6 のこぎり': 'G: VRC6 saw',
    '素(BRR)': 'Raw (BRR)',
    'ガウス補間': 'Gaussian',
    'PM変調後': 'After PM',

    // ---- KSSパネル ----
    'ヘッダ情報 (KSS: MSX PSG/SCC/FMPAC)': 'Header (KSS: MSX PSG/SCC/FMPAC)',
    'KSSヘッダが不正です。': 'Invalid KSS header.',
    '先にKSSファイルを読み込んでください。': 'Load a KSS file first.',
    'Magic       : {magic} ({ok})': 'Magic       : {magic} ({ok})',
    '不正': 'bad',
    'データ長    : {n} バイト': 'Data size   : {n} bytes',
    'バンク方式  : {mode}マッパー (追加バンク数 {n})': 'Banking     : {mode} mapper ({n} extra banks)',
    'モード      : {mode}': 'Mode        : {mode}',
    '音源        : {chips}': 'Chips       : {chips}',
    '曲番号範囲  : {first} 〜 {last}': 'Track range : {first} - {last}',
    '再生中: 曲{song}  (最大 {time})': 'Playing: track {song}  (max {time})',
    '書き出し完了: {file} + regs.csv': 'Exported: {file} + regs.csv',
    'MML変換完了 ({mode} {bpm} BPM、音源: {chips}) → MMLエディタに出力(FME-7/N163/VRC7を借用して再生)':
      'Converted to MML ({mode} {bpm} BPM, chips: {chips}) → written to the MML editor (played back via FME-7/N163/VRC7)',
    'KSSピアノロール先読みに失敗:': 'Failed to pre-render the KSS piano roll:',

    // ---- GBSパネル ----
    'ヘッダ情報 (GBS: Game Boy)': 'Header (GBS: Game Boy)',
    'GBSヘッダが不正です。': 'Invalid GBS header.',
    '先にGBSファイルを読み込んでください。': 'Load a GBS file first.',
    '曲数        : {n}': 'Songs       : {n}',
    'PLAY駆動    : {mode} ({fps} Hz)': 'PLAY driver : {mode} ({fps} Hz)',
    'タイマ割込': 'timer interrupt',
    'VBlank割込': 'VBlank interrupt',
    'タイトル    : {title}': 'Title       : {title}',
    '作者        : {author}': 'Author      : {author}',
    '著作権      : {copyright}': 'Copyright   : {copyright}',
    '書き出し完了: {file}': 'Exported: {file}',
    'MML変換完了 ({mode} {bpm} BPM、音源: {chips}) → MMLエディタに出力(FDSを借用して再生)':
      'Converted to MML ({mode} {bpm} BPM, chips: {chips}) → written to the MML editor (played back via FDS)',

    // ---- HESパネル ----
    'ヘッダ情報 (HES: PC Engine/TurboGrafx-16)': 'Header (HES: PC Engine/TurboGrafx-16)',
    'HESヘッダが不正です。': 'Invalid HES header.',
    '先にHESファイルを読み込んでください。': 'Load an HES file first.',
    'トラック番号': 'Track number',
    '先頭トラック: {n} (0x{hex})': 'First track : {n} (0x{hex})',
    'データ      : {size}byte @ 0x{addr}': 'Data        : {size} bytes @ 0x{addr}',
    '再生中: トラック{track}  (最大 {time})': 'Playing: track {track}  (max {time})',
    '(レンダリング中… {pct}%)': '(rendering... {pct}%)',
    'レンダリングエラー: {msg}': 'Render error: {msg}',
    'MML変換完了 ({mode} {bpm} BPM、音源: {chips}{dpcm}) → MMLエディタに出力(N163を借用して再生)':
      'Converted to MML ({mode} {bpm} BPM, chips: {chips}{dpcm}) → written to the MML editor (played back via N163)',

    // ---- モニタ ----
    'MML再生・NSFファイル再生・キャプチャ再生中、サウンドレジスタ・CPUレジスタ・メモリ($0000-$00FF)の状態を16進数/2進数でリアルタイム表示します。':
      'Shows sound registers, CPU registers and memory ($0000-$00FF) in hex/binary while MML, NSF or captured playback is running.',
    'CPUレジスタ': 'CPU registers',
    'サウンドレジスタ': 'Sound registers',
    'メモリ ($0000-$00FF)': 'Memory ($0000-$00FF)',
    '（再生中の情報がありません）': '(nothing is playing)',
    '（MML再生中はCPUレジスタの情報はありません）': '(CPU registers are not available during MML playback)',
    '（書き込みがありません）': '(no writes)',
    '（MML再生中はメモリ情報はありません）': '(memory is not available during MML playback)',

    // ---- 波形エディタ (FDS / N163) ----
    '新規定義を追加': 'Add a new definition',
    'インデックス': 'Index',
    'ファイルとして保存': 'Save to file',
    'ファイルから読み込み(反映を押すまでMMLへは書き込まれません)':
      'Load from file (nothing is written to the MML until you press Apply)',
    'コピー': 'Copy',
    '貼り付け(要素数は自動調整。反映を押すまでMMLへは書き込まれません)':
      'Paste (length is adjusted automatically; nothing is written to the MML until you press Apply)',
    '現在の内容をMMLへ反映': 'Write the current contents to the MML',
    '反映': 'Apply',
    '説明を表示/非表示': 'Show/hide help',
    '@FM<n>: FDS波形メモリ全64サンプル(各0-63)。1周期分の音色波形をそのまま記録します。':
      '@FM<n>: all 64 samples of FDS wave memory (0-63 each). One full cycle of the timbre, stored verbatim.',
    '@MW<n> 変調カーブ (32)': '@MW<n> modulation curve (32)',
    '実際に鳴るピッチオフセットの累積カーブ(-64〜63)を表示・編集します。 ハードウェアは0/+1/+2/+4/リセット/-4/-2/-1の8段階でしか変化できないため、 描いたカーブに最も近い形へ自動的に近似されます。':
      'Shows and edits the accumulated pitch-offset curve (-64 to 63) that is actually heard. The hardware can only step by 0/+1/+2/+4/reset/-4/-2/-1, so the curve you draw is automatically approximated to the closest achievable shape.',
    '@MH<n> 変調パラメータ': '@MH<n> modulation parameters',
    'delay=発音から変調開始までのフレーム数 / freq=変調テーブルの再生速度 / depth=変調の深さ($4084ゲイン。0だと@MWがあっても無効) / waveform=使用する@MW<n>のインデックス':
      'delay = frames from key-on until modulation starts / freq = playback speed of the modulation table / depth = modulation depth ($4084 gain; 0 disables it even if @MW is set) / waveform = index of the @MW<n> to use',
    '@N<n> 波形 (0-15)': '@N<n> wave (0-15)',
    '@N<n>: N163波形。要素数は作曲者が自由に決められます(4の倍数へ自動的に丸められます)。 同時に使用する波形の合計が内蔵RAM(128バイト中、波形用に使える64バイト)を超えると MML反映時にエラーになります。先頭のバッファ番号はこのツールでは使用しません(常に0で書き込みます)。':
      '@N<n>: N163 wave. You choose the length freely (it is rounded to a multiple of 4). If the waves in use at the same time exceed the internal RAM (64 of the 128 bytes are usable for waves), applying to the MML raises an error. The leading buffer number is unused by this tool (always written as 0).',
    '要素数': 'Length',
    'サンプル再生': 'Preview',
    '停止': 'Stop',
    '音量(@v99,"|"=ループ)': 'Volume (@v99, "|" = loop)',

    // ---- コア層のエラー文言 ----
    'ループ終端 "]" が見つかりません': 'Missing loop end "]"',
    'タプレット終端 "}" が見つかりません': 'Missing tuplet end "}"',
    '未対応のヘッダ指示子です: "#{name}"': 'Unsupported header directive: "#{name}"',
    '@OT{index} の値の数が不足しています(24個必要)': '@OT{index} has too few values (24 required)',
    'チャンネル指定が認識できません: "{text}"': 'Unrecognized channel specification: "{text}"',
    '@N{instrument} の波形長{len}サンプルはN163内蔵RAMの空き容量(最大{max}サンプル)を超えています':
      '@N{instrument} is {len} samples long, which exceeds the N163 internal RAM (max {max} samples)',
    'フレーム{frame}: @N{instrument}(ch{channel})をN163内蔵RAMに配置できません({bytes}byte必要・空き不足。同時使用中の波形の合計が128バイトを超えています)':
      'Frame {frame}: cannot place @N{instrument} (ch{channel}) in N163 internal RAM ({bytes} bytes needed, not enough free; the waves in use at once exceed 128 bytes)',
    'KSSヘッダは最低16バイト必要です': 'A KSS header needs at least 16 bytes',
    'SCC/SCC+ (Konami、使用時のみ)': 'SCC/SCC+ (Konami, only when used)',
    'MSX-AUDIO (Y8950, 未対応)': 'MSX-AUDIO (Y8950, unsupported)',

    // ---- 鍵盤表示 / ピアノロール ----
    'PCM (no fixed waveform)': 'PCM (no fixed waveform)',
    '1 周期 (相対波形)': '1 cycle (relative)',
    'ピアノロール': 'Piano roll',
    'セント偏差': 'Cent deviation',
    '速度': 'Speed',
    '{ch} ミュート': 'Mute {ch}',
    'もっと選ぶ...': 'More colors...',
    '既定色に戻す': 'Reset to default color',
    '📋コピー': '📋 Copy',
    'この波形データをクリップボードへコピー(他の波形エディタへ貼り付け可)':
      'Copy this waveform to the clipboard (can be pasted into the other wave editors)',
    '✓ コピー完了': '✓ Copied',
    '✗ 失敗': '✗ Failed',
    '$4011制御': 'driven by $4011',
    '$4087 bit7=0 (モジュレーション有効)': '$4087 bit7=0 (modulation enabled)',
    'BRR (素 + ガウス補間)': 'BRR (raw + Gaussian)',
    'BRR (素 + ガウス補間 + PM)': 'BRR (raw + Gaussian + PM)',

    // ---- 波形エディタの操作 ----
    '保存するファイル名を入力してください(拡張子不要)': 'Enter a file name to save (no extension needed)',
    'エラー:': 'Error:',
    '再生終了': 'Finished',
    '再生中...': 'Playing...',
  });
})(typeof window !== 'undefined' ? window : globalThis);
