# DESIGN-MSX-CAPTURE.md — 自前 MSX エミュレータ(MSX2VGM)の要件洗い出し(草案、2026-11-08)

NES2VGM(DESIGN-CAPTURE.md §7、src/emulator/nes/)の MSX 版。実機 MSX のソフト(カートリッジ ROM / ディスク)を
自前エミュレータで遊びながら音源レジスタの書き込みを VGM に録り、本体の VGM 経路(鍵盤表示/MML 変換)へ流す。
設計原則 P-1〜P-6(器は VGM、1 フレーム=735 サンプル、影レジスタで初期状態、サンプル本体の同梱、補正は選択肢)は
そのまま引き継ぐ。本書は「何が要るか」の洗い出し。主要な方針 8 点は 2026-11-08 に決定済み(§9)、段階は §10。

----

## 1. 対象範囲(案)

| 区分 | 対象に入れる | 今回は入れない(理由) |
|---|---|---|
| 機種 | MSX1 / MSX2 / MSX2+ / MSXturboR | — |
| CPU | Z80(3.58MHz、M1 ウェイト 1) / R800(turboR、7.16MHz 相当) | — |
| 音源 | PSG(AY-3-8910 / YM2149) / SCC / SCC+(SCC-I) / MSX-MUSIC(YM2413、FM-PAC・内蔵) / MSX-AUDIO(Y8950、ADPCM 込み) / turboR 内蔵 PCM / コナミ 8bit DAC(牌の魔術師・シンセサイザー) | MoonSound(OPL4: 規模が大きくコーパスも薄い) / SFG-01・05(YM2151: 既存 ym2151.js で安いが後回し) / MSX-MIDI / Covox |
| 媒体 | カートリッジ ROM(.rom/.mx1/.mx2、zip 内も) / ディスク(.dsk、ディスク ROM は利用者が用意) | カセット(.cas) / .qd 系 / ハードディスク |
| 映像 | TMS9918(MSX1) / V9938(MSX2) / V9958(MSX2+・turboR) の全画面モード・スプライト・VDP コマンド | インターレース表示の実描画(フレーム合成だけ) / 外部 VDP(Vシリーズ以外) |
| 入力 | キーボード(日本語配列マトリクス) / ジョイスティック 2 口 / turboR の PAUSE | マウス・ライトペン・トラックボール・アルカノイドパドル |

★ turboR の内蔵 PCM とコナミ DAC は turboR / 一部コナミソフトを遊ぶと必ず鳴る。鳴らすだけでなく **録音にも載せる**(規格外ブロック、§5.6。2026-11-08 決定)。

----

## 2. 既存資産と再利用

| 必要な物 | 既存 | 再利用の形 |
|---|---|---|
| Z80 | src/emulator/cpuZ80.js(全命令+未定義フラグ、m1Wait、SingleStepTests 済 tools/z80-test.html) | そのまま。割り込み受け付け(INT/IM1・IM2、EI 直後の 1 命令遅延、HALT 脱出)は KSS では使っていないので実機並みの検証が要る。R800 は §3.2 |
| メモリ/バンク | src/emulator/kssBus.js(8K×8 ページ参照の張り替え、SCC 自動デコード) | ページ参照方式は踏襲。KSS のバンク規約 → 実機のスロット+メガ ROM マッパー(§3.3)へ全面的に置き換え。KSS 用バスは残す |
| PSG | expansion/ay8910Msx.js | そのまま。レジスタ 14/15 はジョイスティック/キーボードの I/O ポート(§3.6)なので録音から除外 |
| SCC / SCC+ | expansion/sccAudio.js | そのまま。SCC-I のモードレジスタ($BFFE)と 128K バンクは新規マッパー側 |
| MSX-MUSIC | expansion/opllMsx.js(+Nuked) | そのまま。I/O $7C/$7D。FM-PAC は ROM 16K+SRAM 8K+$7FF6 イネーブルビットつき(§3.3) |
| MSX-AUDIO | expansion/opl.js(type 'y8950'、ADPCM-B、readStatus) | そのまま+タイマ割り込み線を Z80 INT へ(§3.5)。I/O $C0/$C1 |
| コナミ DAC | expansion/majutsushiDac.js | そのまま($5000 台書き込み) |
| 録音の符号化 | src/vgm/vgmRecord.js(encodeNesRecording) | チップ表で駆動する汎用版へ(§5)。NES 用は従来どおり |
| 実時間ループ | src/audio/nes-worklet-impl.js(+tools/build-capture-workers.ps1) | 機種非依存部(音の時刻でフレームを刻む、録音/巻き戻し/battery のメッセージ)を切り出し、本体クラスだけ差し替える |
| 巻き戻し/状態保存 | nes/nesRewind.js、nes/nesState.js | 同じ設計(0.5 秒ごとのスナップショット+パッド記録)。MSX の状態は VRAM 128K+メインRAM 64K〜512K で NES の数十倍なので、スナップショットは前回との差分圧縮(XOR+ランレングス)で持つ(§4) |
| 画面 UI | src/ui/nesScreen.js | **1 窓で機種自動判別**(§6)。見出しボタン列・録音・ライブ表示・設定・タッチ操作は共通層(GameScreen)へ、解像度(256/512 幅)、キーボード入力、カートリッジ 2/ディスク/BIOS のボタンは機種層で出し分け |
| ヘッドレス | tools/headless/nes-run.js、nes-sweep.js | msx-run.js(ROM+BIOS → N フレーム実行 → VGM/画面ダンプ) |
| リファレンス比較 | Mesen 2 の Lua(tools/mesen/) | **Mesen は MSX 非対応**。openMSX の Tcl(スクリーンショット、デバッガ、VGM 録音スクリプトがある: 推定、要確認)で同じ役を作る |
| 録音の補正 | src/vgm/vgmClean.js | そのまま効く(フレーム列の多数決/詰め) |
| 検証用素材 | Desktop\emu sound\kss\(F1 Spirit、FF、Hydlide 3、Gofer 2、Galious、FM-PAC 等) | 同じタイトルの ROM を遊んで録った VGM と KSS 直接変換を A/B(旋律一致)。NES の NSF vs 録音と同じ手口 |

----

## 3. 本体(ハードウェア)の必要機能

### 3.1 Z80(全機種)

- 3,579,545 Hz、M1 ごとに 1 ウェイト(kssPlayer と同じ `m1Wait = 1`)。1 フレーム ≈ 59,736 サイクル(NTSC 262 ライン)。
- INT: VDP の VBlank(+ V9938 のライン割り込み、Y8950 タイマ、RP5C01 は割り込み無し)の論理和。IM1 が基本だが IM2 を使うソフトもある。
  データバスは $FF(RST 38h)。EI の直後 1 命令は受け付けない、HALT 中に INT で脱出。
- NMI は無し。RESET ボタン=リセット。
- 命令サイクル数は既存表で足りる(M1 ウェイトが正しければ実機の体感速度になる)。処理落ちの再現にはサイクル精度が効くので、
  KSS 再生で未検証の「フレーム内の割り込みタイミング」を openMSX と突き合わせる。

### 3.2 R800(turboR)

- Z80 命令の上位互換+ MULUB/MULUW、サイクル表が全面的に違う(ほぼ 1 命令 1〜2 クロック、7.16MHz、DRAM リフレッシュ待ち、
  ページ境界で +1)。I/O $E4/$E6: S1990 の CPU モード選択(Z80/R800 ROM/R800 DRAM)と 16bit タイマ($E6/$E7、255.68kHz)。
- turboR 専用ソフト(Fray、Illusion City の turboR 版など)以外は Z80 モードで動く。
  **段階を分ける案**: 最初は turboR の BIOS を Z80 モードで動かすだけ(R800 命令 2 つは未定義のまま)、R800 の命令/サイクル表は後段。
- turboR には SingleStepTests 相当の公開テストが無い(推定)。openMSX の `cpuregs` デバッグとの突き合わせで代える。
- 実装(7e、2026-11-09): MULUB/MULUW は入れた。命令時間は Z80 の T 数 × 定数(DRAM 0.2 / ROM 0.35)の近似で、R800 の表は未移植(ROADMAP 段階 7 の 7e)。

### 3.3 メモリ(スロット、マッパー)

- **一次スロット 4 × 二次スロット 4**: PPI ポート $A8(一次)、$FFFF(拡張スロットの二次選択、読み出しは反転)。
  8K ページ参照方式(kssBus)を「16K ページ 4 枚 × スロット」に組み替える。
- **メインRAM**: MSX1 は 8K〜64K、MSX2 は 64K 以上(マッパー $FC-$FF、16K ページ×最大 256)、MSX2+ 64K〜、turboR 256K〜512K。
  メモリマッパーのポート読み出しは実装によってビット幅が変わる(未使用上位ビットは 1)。
- **BIOS ROM**(利用者が用意、FDS の disksys.rom と同じ扱い。localStorage/IndexedDB に控える):
  MAIN 32K / SUB 16K(MSX2 以降) / DISK 16K(ディスク機) / KANJI 128K〜256K(日本語ゲームの大半が漢字 ROM を参照、無くても動くが文字が化ける) /
  MSX-MUSIC BIOS 16K(内蔵機・FM-PAC) / turboR の追加(KANJI DRIVER、FIRMWARE 等)。機種プリセット(例: FS-A1 / FS-A1WSX / FS-A1ST)で何が要るか示す。
  ★ **C-BIOS を同梱**(2026-11-08 決定。BSD ライセンス、MSX1/2/2+ カートリッジ用、BASIC・ディスク無し)。ROM カートリッジは BIOS 無しで即遊べる。
  実 BIOS は利用者が用意して控える(FDS の disksys.rom と同じ)。ディスク・turboR・漢字は実 BIOS が要る。C-BIOS の版と各 ROM の SHA-1 は
  tools/headless/mk-cbios-data.js が src/emulator/msx/cbiosData.js(MML.Emu.CBIOS、base64 埋め込み+ライセンス文)に生成する(7a で決定: file:// では fetch が使えないので JS 埋め込み。
  MsxConsole は bios を渡されなければ機種の C-BIOS を使う)。利用者の実 BIOS は [BIOS…] ボタンで読ませ localStorage に控える(優先)。
- **メガ ROM マッパー**(頻度順。openMSX の名称に合わせる):
  Konami(8K、$6000/$8000/$A000) / Konami SCC(8K、$5000/$7000/$9000/$B000 + SCC $9800) / ASCII8(8K、$6000/$6800/$7000/$7800) /
  ASCII16(16K、$6000/$7000) / 素の 16K・32K・48K ミラー / ASCII8 + SRAM(Xanadu 等)/ ASCII16 + SRAM(Hydlide 3 等、SRAM 2K ミラー)/
  Game Master 2(SRAM) / Koei(SRAM 8K〜32K) / Wizardry / R-Type(大容量 ASCII16 の変種) / Cross Blaim / Harry Fox /
  Konami SCC-I(Snatcher・SD スナッチャーのサウンドカートリッジ: 128K RAM、モード $BFFE、SCC+ $B800) / FM-PAC(16K ROM+SRAM、$7FF6 bit0 で OPLL イネーブル、$7FF7 バンク) /
  MSX-AUDIO カートリッジ(FS-CA1 / Philips Music Module: BIOS 32K+RAM、I/O $C0-$C1)。
  **判別**(2026-11-08 決定: 発見的手法+手動+小辞書): .rom にヘッダは無い。(1) openMSX と同じ発見的手法(ROM 全体を走査してバンク切替アドレス
  $5000/$6000/$6800/$7000/$7800/$8000/$9000/$A000/$B000 への書き込み命令を数え、表で採点)、(2) 手元で確認した ROM だけの SHA-1→マッパー辞書
  (ハッシュと種別のみ。ゲーム名は書かない)、(3) 画面の ⚙ で手動上書き(localStorage に ROM ハッシュ別に控える)。ASCII8 と Konami の誤判別が定番。
- カートリッジは 2 スロット(1・2)。MSX-MUSIC/MSX-AUDIO/SCC-I カートリッジを「ゲームと一緒に挿す」UI が要る(FM-PAC を挿して PSG 版が FM 版になるのは MSX らしさ)。

### 3.4 VDP(映像)

NES の PPU(296 行)に相当する部分が最大。V9938 の全機能を 1 本で書き、TMS9918/V9958 は型違いにする。

- 共通: I/O $98(VRAM)/$99(レジスタ・ステータス)/$9A(パレット)/$9B(間接レジスタ)。VRAM 16K(MSX1)/64K〜128K(MSX2〜)。
  NTSC 262 ライン(50Hz は 313 ライン、レジスタ 9 bit1)。
- TMS9918: GRAPHIC1/2、MULTICOLOR、TEXT1、スプライトモード 1(4 枚/ライン、5 枚目フラグ、衝突)。
- V9938: SCREEN 4〜8(GRAPHIC3〜7)、TEXT2(80 桁)、スプライトモード 2(8 枚/ライン、ラインごとの色、CC ビット)、212 ライン、
  垂直スクロール(R23)、パレット 16×9bit、ライン割り込み(R19/S1)、ステータス S0〜S9、**VDP コマンド**(HMMM/LMMM/HMMV/LMMV/YMMM/LINE/SRCH/PSET/POINT
  とそのタイミング: MSX2 ゲームは転送完了を S2 の CE で待つので、速すぎても遅すぎても画が崩れたり処理落ちが変わる)。
  VRAM アクセスタイミング(スプライト/表示中のアクセススロット)は後回し可(画面は正しく、timing は近似)。
- V9958: 横スクロール(R26/R27、R25 のマスク)、YJK/YAE(SCREEN 10〜12)、コマンドのビットマップ以外モード対応、波形的な違いは無し。
- 出力: 256×212(+ボーダー)を基本に、TEXT2/GRAPHIC5・6 は 512 幅 → canvas は 512×424 相当で描き、CSS で整数倍。
  NES は 256×240 固定で ArrayBuffer 1 枚だったので、幅可変(モード切替)をフレーム単位で主スレッドへ伝える。

### 3.5 周辺

- **PPI 8255**($A8-$AB): スロット選択、キーボード行選択、キー読み(11 行×8)、カセットモータ/出力、キークリック音(PSG と別の 1bit 音: 録音対象外、鳴らすのは任意)。
- **RTC RP5C01**($B4/$B5、MSX2〜): BIOS が起動時に設定ブロック(画面色・ビープ・ロゴ)を読む。時計の進みと SRAM 4 ブロック(保存)。
- **漢字 ROM**($D8-$DB、JIS 第一/第二): 日本語ゲームに必須級。
- **ディスク**(後段): WD2793(Philips/Sony 系)または TC8566AF(松下系、turboR は必ずこれ)と、ディスク ROM のドライブ結線。
  .dsk(720K 2DD / 360K 1DD、ヘッダ無し生イメージ)。ディスク ROM は利用者が用意(C-BIOS には無い)。
  ★ ディスクベースのゲーム(Ys、Xak、Illusion City、イース III 等)がコーパスの多数派なので、ここまで来ないと「MSX2 の名曲」の多くは録れない。
- **turboR S1990**: CPU 切替、タイマ、PAUSE キー/LED、**PCM**($A4 データ/$A5 制御、8bit、15.75kHz を S1990 タイマで駆動)。
- **Y8950 のタイマ割り込み**: FS-CA1 の BIOS や一部ドライバが IRQ で曲を進める。opl.js は status を読めるが INT 線が無いので足す。
- **キーボード**: 日本語配列(JIS/50音)のマトリクス表を既定に。NES のキー割り当て UI を「MSX キー ← PC キー」の表へ拡張。
  ジョイスティックは PSG レジスタ 15(出力: 口選択・パルス)/14(入力)経由。ゲームパッドは NES と同じ標準配置を流用(A=トリガ 1、B=トリガ 2)。

----

## 4. 動作(実時間ループ、録音以外)

- AudioWorklet で「音の時刻」基準にフレームを刻む(nes-worklet-impl と同じ)。1 フレーム=VDP の VBlank。60Hz なら 735 サンプル、
  50Hz(VDP R9 bit1)なら 882 サンプル。フレーム長は VDP が決め、Worklet はその長さぶん CPU を進める(NES の 735 固定を可変に)。
- 早送り/一時停止/リセット/状態保存・読込/巻き戻し(逆再生)/連射: NES と同じ操作体系。状態の大きさ: VRAM 128K+RAM 最大 512K+SRAM+Y8950 ADPCM RAM 256K。
  巻き戻しのスナップショットは **前回との差分圧縮**(2026-11-08 決定: XOR+ランレングス。ゲーム中に毎フレーム変わる領域は狭い)。
  間隔 0.5 秒・2 分ぶんは NES と同じにできる見込み(推定)。7a で nes-state-cost.js の MSX 版で実測し、収まらなければ間隔を伸ばす。
  状態保存(F5/F7)は差分でなく全量。
- バッテリーバックアップ: カートリッジ SRAM(ASCII8/16 SRAM、GM2、Koei)、FM-PAC SRAM、RTC SRAM、ディスクの書き戻し。NES の battery(IndexedDB)と同じ経路。
- ライブ表示(鍵盤表示のロールへ流す): 書き込み列の形が同じなら main.js 側は無改修で済む想定(chip 名: psg/scc/opll/opl/dac)。

----

## 5. 録音(VGM 符号化)

### 5.1 チップと VGM コマンド

| 音源 | 書き込みの入口 | VGM | ヘッダ | 備考 |
|---|---|---|---|---|
| PSG | I/O $A0(アドレス)/$A1(データ) | 0xA0 rr dd | 0x74 clock=1,789,772、0x78 type=AY-3-8910(YM2149 機は 0x10)、flags | レジスタ 0〜13 だけ。14/15(ジョイスティック)は落とす。本体の vgmPlayer は既に 0xA0 を読む |
| SCC / SCC+ | メモリ $9800-$98FF($B800-、SCC+) | 0xD2 pp aa dd | 0x9C clock=1,789,772(bit31=SCC+) | pp: 0=波形 1=周波数 2=音量 3=キーオン 4=波形 ch5 5=テスト。vgmPlayer の _sccWrite の逆写像を 1 本書く。モード/バンクレジスタは載せない |
| MSX-MUSIC | I/O $7C/$7D | 0x51 aa dd | 0x10 clock=3,579,545 | FM-PAC の $7FF6 イネーブルは載せない(録音開始像で解決) |
| MSX-AUDIO | I/O $C0/$C1 | 0x5C aa dd | 0x5C clock=3,579,545 | ADPCM は §5.3 |
| turboR PCM / コナミ DAC | I/O $A4 / メモリ $5000 台 | 規格外ブロック MSXX | — | §5.6 |

GD3: system "MSX" / "MSX2" / "MSX2+" / "MSX turbo R"、creator 本ツール、notes に補正印("cleaned: sfx lag")は NES と同じ。

### 5.2 フレームと時刻

- 60Hz 中は P-2 どおり 1 フレーム=735 サンプル(0x62)。フレーム内時刻 t は書き込み時の CPU サイクル/そのフレームのサイクル数×フレーム長。
- **50Hz 中は 1 フレーム=882 サンプル(0x63)で出す**(2026-11-08 決定。実時間に忠実)。P-2 を「1 フレーム=VBlank 1 回、長さは 0x62/0x63 で表す」に
  広げる(DESIGN-CAPTURE.md P-2 の追記が要る)。影響:
  - 本体の VGM→MML 変換は書き込みの VGM 時刻を 1/60 秒格子へ乗せるだけなので、海外の 50Hz VGM と同じく無改修で通る(テンポ推定は書き込み間隔から)。
  - vgmClean.js(効果音除去/処理落ち補正)は 735 格子前提。フレーム=wait 命令 1 個として扱うよう直し、出力も元の wait 長(0x62/0x63)を保つ。
  - 1 曲の途中で 50/60 を切り替えるソフトはフレーム長が混在する。vgmClean のループ周期検出はフレーム数で見るので問題なし(推定)。
  - GD3 notes に "rate: 50Hz" を印として入れ、鍵盤表示のロールのフレーム目盛りが読めるようにする。

### 5.3 Y8950 ADPCM(P-5 の MSX 版)

- サンプル本体は CPU が Y8950 のデータレジスタ($0F、REC|MEMDATA)経由で Y8950 側 RAM(32K〜256K)へ書く。NES の DPCM と同じく「鳴らした時点の中身」を同梱。
  録音側: 再生開始(レジスタ $00 bit7)の直前に、再生範囲(START/STOP、32 バイト単位)の RAM 内容をデータブロック 0x88(DELTA-T、既存の vgmPlayer が受ける形)で出す。
  同内容は 1 回(FNV ハッシュ)。RAM への書き込み列そのものは VGM に載せない。
- 変換側(vgm → MML の E ch/パッド)は VGM の 0x88 経路が既にある(ROADMAP 2026-08-30)。

### 5.4 録音開始時の像(P-4)

- PSG: レジスタ 0〜13 の影。SCC: 波形 RAM 4(5)×32+周波数/音量/キーオン。OPLL: $00-$07 ユーザー音色+$0E リズム+$10-$38 の影(キーオンは書き込み時刻順に)。
  Y8950: $00-$FF の影+ADPCM RAM の「今鳴っている範囲」。各 Emu.*Audio に `audioImage()` を揃える(NES のマッパーと同じ名前)。
- 順序は「音を出すイネーブルを最後に」(PSG R7、OPLL/OPL のキーオン、SCC のチャネルイネーブル)。

### 5.5 どのチップを録るか

- 本体が挿している物(PSG は常に、SCC はカートリッジ、OPLL は内蔵/FM-PAC、Y8950 はカートリッジ)で決まる。ヘッダの clock は 0 で未使用。
- 「挿しているが鳴らない」(FM-PAC を挿したのに PSG 版の曲)は録音に 0 件で現れる。注記不要。

### 5.6 turboR PCM / コナミ DAC(2026-11-08 決定: 規格外ブロックで載せる)

- VGM にこの DAC は無いので、NESX(0x67 0x66 0xBF "NESX")と同じ流儀の本ツール専用ブロック **"MSXX"** に載せる。
  kind=0 ヘッダ(機種、どの DAC か: bit0=turboR PCM、bit1=コナミ DAC $5000、bit2=コナミシンセサイザー $4000)、
  kind=1 サンプル列(書き込み 1 回=値 8bit+フレーム内時刻 7bit。同じフレームの物は 1 ブロック)。turboR PCM は $A5 の制御(再生/録音/ミュート)も kind=2 で載せる。
- 本体側: vgmPlayer のデータブロック読みで MSXX を受け、再生は既存 majutsushiDac.js(時刻つき 8bit 列)へ、turboR PCM も同じ DAC クラスで鳴らす。
  変換は X68000 OKIM6258 と同じ「DAC ストリームの切り出し→ドラムパッド/@DPCM」経路(vgm-okim6258-dac-log-drums)に乗せる。
- 他ツールは MSXX を読み飛ばす(0x67 ブロックの規約)。NSF 書き出しには関係しない。
- 実装は turboR PCM が 7e、コナミ DAC が 7b(majutsushiDac が既にあるので安い)。

----

## 6. UI(ゲーム画面の MSX 版)

- 見出しボタン列は NES と同じ: [開く][リセット][早送り][状態保存][状態読込][⚙] … [一時停止][巻き戻し][録音]。MSX で増える物:
  [カートリッジ 2(FM-PAC / MSX-AUDIO / SCC-I / 何も無し)] [ディスク A/B 入れ替え] [BIOS…(機種プリセット、不足一覧)] [キーボード表示(タッチ端末用ソフトキーボード)]。
- **窓は NES と共用**(2026-11-08 決定): 「ゲーム画面」窓にファイルの種類で機種を自動判別(iNES ヘッダ/.fds → NES、.rom/.mx1/.mx2/.dsk → MSX)。
  nesScreen.js を GameScreen(共通層: 見出し、録音、ライブ表示、巻き戻し、設定、タッチ)+機種層(nes/msx: 本体の生成、入力表、専用ボタン、解像度)に分ける。
  Worklet バンドルも 1 本(nes-worklet → game-worklet、本体クラスを load の機種で選ぶ)。設定(localStorage)は nes.cfg を game.cfg へ移行し機種別の節を持つ。
- 機種の選択: MSX1(C-BIOS or 実 BIOS)/ MSX2 / MSX2+ / turboR。既定は「ROM が要求する最小」(MSX2 カートリッジは MSX2)。判別不能時は MSX2。
- 入力: canvas にフォーカスがあるときだけキーを取る(エディタの矢印を奪わない)のは NES と同じ。ただし MSX は **キーボードがゲームの主入力**なので、
  PC キー→MSX キーの表(既定: 矢印=カーソル、Space、Shift、Ctrl、Esc、Enter、F1〜F5、Graph=Alt、英数字そのまま)と、
  「ジョイスティック 1 口目をカーソル+Space に重ねる」オプション(多くのゲームがどちらでも動く)。
- ファイル入口: 開く/ドロップ/?rom= に .rom/.mx1/.mx2/.dsk/.zip。NES の入口(nesScreen)と窓を共有するか別窓かは §9。
- i18n: 新規文言はすべて i18n 込み(恒久指示)。

----

## 7. 検証

- CPU: Z80 は既存の SingleStepTests(z80-test.html)。割り込み周りは実ソフトの起動+openMSX の同フレーム比較。
- VDP: C-BIOS の起動ロゴ(MSX2 ロゴは VDP コマンドで描く)→ 各 SCREEN モードのテスト ROM(手組み。Z80 の小さなアセンブラが要る。MML.Asm は 6502 用)。
  openMSX の `screenshot` と同フレームのピクセル比較(ref-screenshot.lua の MSX 版を Tcl で)。
- 音: 同一タイトルの KSS 直接変換と、ROM を遊んで録った VGM の変換を A/B(旋律一致、NES の NSF vs 録音と同じ)。
  Desktop\emu sound\kss\ に F1 Spirit(PSG/SCC)、F1 Spirit 3D(FM-PAC)、FF(PSG)、Hydlide 3(ASCII16 SRAM)、Galious(Konami)がある。
- 録音した VGM: 本体で開いて再生・鍵盤・変換(check-all.js のコーパスには足さない。リップは二度とコミットしない)。
- ヘッドレス: tools/headless/msx-run.js(ROM/BIOS/DSK、N フレーム、パッド台本、--vgm/--png)、総当たり msx-sweep.js(起動・無音・暴走の自動判定)。
- リファレンス実装(読む物): openMSX(V9938/マッパー/S1990/判別ヒューリスティック)、blueMSX(マッパー一覧)、MSX Datapack / V9938 Technical Data Book / Y8950 Application Manual。

----

## 8. 規模感(推定、行数は既存ファイルからの類推)

| 部品 | 新規行数(推定) | 備考 |
|---|---|---|
| スロット/PPI/マッパーRAM/RTC/漢字 ROM/バス | 500 | kssBus を参考に新規 |
| メガ ROM マッパー+判別 | 700 | mappers.js(1492 行)より小さい |
| V9938/V9958(TMS9918 含む) | 1,800〜2,500 | 最大。コマンドエンジンが半分 |
| Z80 割り込み/タイミング手直し | 100 | 既存に足す |
| R800 | 400〜600 | 命令 2 つ+サイクル表+S1990 |
| FDC+ディスク | 500 | WD2793 と TC8566AF の 2 系統 |
| turboR PCM・Y8950 INT・SCC-I | 150 | 既存音源への追加 |
| 録音符号化の汎用化 | 200 | vgmRecord.js を表駆動に |
| Worklet/UI/状態/巻き戻し(NES からの共通化込み) | 1,000 | nesScreen.js の切り分けが主 |
| ヘッドレス/テスト ROM/openMSX 比較道具 | 500 | — |

NES(6a〜6k、約 1 か月)より一回り大きい。段階は §10 の案。

----

## 9. 決めたこと(2026-11-08、ユーザー確認済み)

| # | 項目 | 決定 | 根拠・影響 |
|---|---|---|---|
| 1 | 範囲 | PSG/SCC/SCC+/MSX-MUSIC/MSX-AUDIO+turboR PCM+コナミ DAC。SFG(YM2151)・MoonSound は外す | PCM/DAC は規格外ブロック MSXX で VGM にも載せる(§5.6) |
| 2 | BIOS | C-BIOS 同梱+実 BIOS は利用者が用意して控える | ROM カートリッジは即遊べる。ディスク/turboR/漢字は実 BIOS(§3.3) |
| 3 | ディスク | 対象に入れる。段階 7d | カートリッジと MSX2 VDP が動いてから。ディスク ROM は実 BIOS 頼み(§3.5) |
| 4 | R800 | Z80 モードで始め、R800 は 7e | turboR BIOS を Z80 モードで起動。MULUB/MULUW・サイクル表・S1990 は最後(§3.2) |
| 5 | 50Hz | 50Hz 中は 882 サンプル wait(0x63)で出す | P-2 を広げる。vgmClean.js を wait 命令単位のフレームに直す(§5.2) |
| 6 | 窓 | NES と 1 窓、ファイルで機種自動判別 | nesScreen.js を共通層+機種層に分け、Worklet バンドルも 1 本(§6) |
| 7 | マッパー判別 | 発見的手法+手動上書き+手元確認分だけの SHA-1 小辞書 | 辞書はハッシュと種別のみ、ゲーム名は書かない(§3.3) |
| 8 | 巻き戻しの容量 | 前回との差分圧縮(XOR+ランレングス) | 間隔 0.5 秒・2 分は維持見込み(推定)。7a で実測(§4) |

残っている小さな未決(実装時に決める): ~~C-BIOS の同梱経路~~(7a で JS 埋め込み cbiosData.js に決着、2026-11-08)、キーボード既定表の細部、
MSXX ブロックのビット配置、Y8950 ADPCM RAM 像の「鳴っている範囲」の切り方(START/STOP のまま 32 バイト単位)。

----

## 10. 段階(決定に合わせて更新)

- **7a 骨格**(実装 2026-11-08、進捗は ROADMAP.md 段階 7): スロット/PPI/マッパーRAM、Z80 割り込み、TMS9918 相当の表示、キーボード/ジョイスティック、PSG、素 ROM+Konami/Konami SCC/ASCII8/ASCII16 マッパー+判別、
  C-BIOS 同梱で MSX1 カートリッジが遊べる。nesScreen → GameScreen の共通層分離と Worklet バンドル統合。msx-run.js。差分圧縮の巻き戻しと容量実測。
- **7b 音源と録音**(実装 2026-11-08、進捗は ROADMAP.md 段階 7。タイマ INT・KSS との A/B は未): SCC/SCC+ マッパー、FM-PAC、MSX-AUDIO カートリッジ(ADPCM 同梱、タイマ INT)、コナミ DAC、VGM 符号化(60Hz/50Hz の可変フレーム、MSXX)、
  録音開始像、ライブ表示、vgmClean の可変フレーム対応、KSS との A/B。
- **7c MSX2**(実装 2026-11-08、進捗は ROADMAP.md 段階 7。機種プリセット UI と辞書は未): V9938 全モード+コマンド+ライン割り込み、RTC、漢字 ROM、SRAM 系マッパーとバッテリー、実 BIOS の控え、機種プリセット。
- **7d ディスク**(実装 2026-11-09、進捗は ROADMAP.md 段階 7。実ディスク ROM での起動は未確認): FDC 2 系統、.dsk、ディスク ROM、書き戻し。
- **7e MSX2+/turboR**(実装 2026-11-09、進捗は ROADMAP.md 段階 7。実 turboR BIOS での起動は未確認、R800 の命令時間は近似): V9958、S1990、turboR PCM(MSXX)、R800。
- **7f 仕上げ**(実装 2026-11-09、進捗は ROADMAP.md 段階 7。openMSX の道具は未検証): タッチ用ソフトキーボード、openMSX 比較道具、総当たり(msx-sweep.js)。
- **7g 実ソフトでの総当たり**(2026-11-09、ROADMAP.md 段階 7): 手元の ROM/.dsk/実 BIOS で回して TC8566AF の TC、turboR の $F4/$E9/スロット配置、マッパー辞書を直した。実 BIOS(MSX1/MSX2/MSX2+/turboR)での起動と実ディスク ROM での .dsk 起動を確認済み。
