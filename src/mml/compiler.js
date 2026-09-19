/*
 * MMLコンパイラ (ppmck互換 基本コマンド + 拡張音源)
 * MML.Mml.compile(source, opt) -> {
 *   tracks: { A: [[ {addr, value}, ... ], ...frames], B: [...], ... },
 *   totalFrames: number,
 *   tempo: number,
 *   expansions: ('dpcm'|'fds'|'vrc7'|'vrc6'|'n163'|'fme7'|'mmc5')[],
 *   expansionLetterMap: { チップ名: [割当チャンネル文字...] },
 *   errors: [...]
 * }
 *
 * 対応チャンネル (2A03、常時):
 *   A = パルス1 ($4000-$4003)
 *   B = パルス2 ($4004-$4007)
 *   C = 三角波 ($4008-$400B)
 *   D = ノイズ ($400C-$400F)
 *
 * 拡張音源チャンネル (opt.expansions の配列で複数同時指定可。実機ppmck
 * (src/ppmckc/mckc.hの_TRACK_STR/BxxxTRACK定義)と同じ固定優先順位
 * dpcm→fds→vrc7→vrc6→n163→fme7→mmc5で、宣言順に関わらずE以降を割り当てる。
 * ★未使用チップの枠は「消費しない」のではなく逆に常に消費される(li+=countが
 * used.has()の判定と無関係に必ず進む、assignExpansionLetters参照): 例えばVRC6のみ
 * 使う曲でもチャンネル文字は常にM-Oになり、E-L(dpcm/fds/vrc7の枠)はそのまま空く。
 * 実機同様、mmc5だけ大文字を使い切った後の小文字a,bを使う(E-Zの22字+a,bの2字=24字):
 *   dpcm : DPCMサンプル再生 (1ch)。@DPCM<n>定義が1つでもあれば自動的に有効化される。
 *          ★本家ppmck準拠(2026-09-19): 音符/n<num> は「どの @DPCM<n> を鳴らすか」の番号で音高ではない。
 *          再生レートは定義の freq で固定。@ v @v @vr D EP EN MP K SD はEでエラー(datamake.c の許可マスク)
 *   fds  : 波形メモリ音源 (1ch)
 *   vrc7 : FM音源 (6ch)
 *   vrc6 : パルス1 パルス2 矩形波(サウ) (3ch)
 *   n163 : 波形音源 (8ch, 波形は4の倍数の可変長。src/mml/n163Alloc.jsの共有バッファへ格納)
 *   fme7 : 矩形波A 矩形波B 矩形波C (3ch)
 *   mmc5 : パルス1 パルス2 (2ch)
 * (後方互換: opt.expansion に単一文字列を渡した場合は1要素の配列として扱う)
 *
 * 対応コマンド:
 *   c d e f g a b  音符 (+ / # でシャープ, - でフラット, 数値で音長, . で付点)
 *   r              休符
 *   n<num>[,<len>] 直接音程指定 (オクターブ2のCを0とした通し番号。★ノイズch(D)では周期index 0-15 の
 *                  直値=本家ppmck準拠。n0が最も高い(速い)ノイズ、n15が最も低い。16以上は16で巡回し警告)
 *                  ノイズch(D)の音符 c〜b は半音番号0-11がそのまま周期index(オクターブ・Kは無視、
 *                  本家ppmckと同じ。12-15は n12〜n15 でのみ書ける)
 *                  ★DPCMch(E)では @DPCM<num> の番号(0-63)の直値=本家ppmck準拠。音符 c〜b は本家ppmckcが
 *                  Eトラックだけオクターブの-2補正をしないため「オクターブ×16+半音番号」(o0 c=0、o1 c=16、
 *                  o2 c=32。12-15など飛び番は n<num> でのみ書ける)。未定義の番号は警告つきで無音
 *   @n<num>[,<len>] 直接周波数指定(本家ppmck準拠)。<num>(10進/$16進/x16進/%2進)を音階テーブルを通さず
 *                  周期/周波数レジスタへそのまま書く。2A03パルス/三角/ノイズ・MMC5は下位11bit、VRC6・FME7・FDSは
 *                  12bit(FDSは周波数比例=大きいほど高い、他は周期=大きいほど低い)。ノイズは下位バイトが$400Eへ
 *                  そのまま行く(bit7=短周期)。VRC7・N163・DPCMではエラー。D<n>は効かず(本家同様)、EP/MP/PTは効く。
 *                  ENは効かない(警告)。&の先の音程は捨てて音長だけ足す(本家同様)。PSのグライド元/先にならない
 *   o<n> > <       オクターブ指定 / 上げ / 下げ
 *   l<n>[.]        デフォルト音長
 *   v<n>           音量 (0-15、絶対指定。FDS/VRC6のこぎり波だけは本家ppmck同様0-63で、
 *                  レジスタ生値=FDSの$4080ゲイン(実効32で頭打ち)/VRC6の$B000蓄積レート
 *                  (実質42が最大。43以上は実機の8bit桁溢れで鋸波が崩れるだけで音量は
 *                  上がらない)。@v/@vrのテーブル値も同じ範囲)
 *   v+<n> v-<n>    音量の相対増減 (省略時は±1)
 *   q<n>[,<m>]     ゲートタイム (0-8、8で音長いっぱい。<m>はフレーム数の加減、省略時0)。
 *                  ゲート長は実機ppmckc(datamake.c calcGateTime)と同じ
 *                  floor(音長×n/8)+m(音長以下に頭打ち、音長>0なら最低1フレーム)。
 *                  ★2026-09-08まで Math.round だったが、実機は整数除算=切り捨て。q6 の
 *                    13フレーム音符は実機9フレームに対して10で鳴っていた(Famicompo
 *                    「Wing Defenders」の実測で発覚)
 *   @q<n>          ゲートタイムをフレーム単位で指定(音符終端の<n>フレーム前でノートオフ。
 *                  実機ppmckc _QUONTIZE2 = q<denom>,-<n> と同じ)
 *   k<len>         キーオフ(実機 _KEY_OFF「リリースエンベロープが発動する休符」)。直前の音符を
 *                  その場でゲートオフし<len>ぶん待つ(@vr があればリリースが鳴る)。直前が音符で
 *                  なければただの休符。<len>省略時は l<n>
 *   @k<n>          キーオンから<n>フレームでキーオフ(本ツール独自拡張。k<len>のフレーム版で
 *                  q/@qより優先、音長以下なら音長いっぱい。0で解除)。固定オン長で鳴らす
 *                  ドライバ(Konami等)の曲を、音符長=キーオン間隔のまま1コマンドで表せる
 *   t<n>           テンポ (BPM。曲中の任意の位置で変更可)
 *   K<n>           移調 (半音、符号あり)
 *   D<n>           デチューン (周期/周波数レジスタへの生オフセット、符号あり。★全音源で正=音程が
 *                  上がる(2026-09-14統一、pitchRegDir参照。EP/PTも同じ向き。レジスタ値としては
 *                  周期レジスタ系で減算になる)。以降の音符に
 *                  持続適用。同じ音を別チャンネルでわずかにずらして鳴らすコーラス効果等に使う。
 *                  2A03パルス/三角/ノイズ(A/B/C/D)・VRC6・MMC5・FME7・FDS・N163対応(N163は
 *                  周波数レジスタが18bit相当のスケールのため同じ値でも変化量は小さくなる)。
 *                  ノイズ(D)では周期index(0-15)への加減算を本家ppmckどおり8bitで桁あふれさせる:
 *                  $400E = (index − D − EP − MP − PT) & $FF なので D16 n0〜n15 → $F0〜$FF(bit7=短周期)。
 *                  wikiwiki.jp/mck の「短周期ノイズは D16〜D1、長周期は D0〜D-15」がそのまま鳴る
 *                  (2026-09-18、実ppmck09aツールチェーンのNSFと$400E列を突き合わせて確認)。
 *                  VRC7はfnum/blockの対数的表現のため対象外。EP/MPと全く同じ「生レジスタへの
 *                  加算」空間の値(下記参照)なので、この3つは同時に足し合わされる
 *   @<n>           音色番号 (パルスのデューティ比 = n % 4 / VRC6パルスのデューティ比 = n % 8
 *                  (実機同様8段階) / VRC7の音色番号 = n % 16)。実機同様、@@<n>で有効化した
 *                  デューティエンベロープはこのコマンドで解除される
 *                  ★ノイズch(D)では本ツール独自拡張: @0=長周期(既定、ホワイトノイズ)/@1=短周期
 *                  (93ステップの周期性ノイズ=金属的な音程感。$400E bit7)。本家ppmckはノイズchの@を
 *                  エラーにするので衝突しない。本家由来の「D16 n0〜n15 で短周期」(ディチューンの
 *                  8bit桁あふれでbit7が立つ技、下記D<n>参照)もそのまま使える
 *   @<n>={...}     デューティ(音色)エンベロープ定義(値0-7、"|"でループ位置)。@v<n>の音色版で、
 *                  1フレーム1ステップでデューティ比が変化する(実機ppmckのgetTone/tone_tbl)
 *   @@<n>          デューティ(音色)エンベロープの選択(実機の音色バイトbit7=0=自作音色)。
 *                  対応はデューティ比を持つチップ(2A03パルスA/B・VRC6パルス・MMC5パルス)。
 *                  波形/音色番号を持つチップ(FDS・N163・VRC7)では@<n>と同じ音色選択になり、
 *                  VRC7のみ@@<64+n>=OP<n>(ユーザー音色ロード+音色番号0)の別名も使える
 *   @@r<n>         リリース音色(255=OFF)。ゲートオフの瞬間に音色を<n>へ差し替える
 *                  (@vrの音色版。実機putReleaseEffectがMCK_SET_TONEを出すのと同じ)。
 *                  N163だけは波形の共有RAM配置が音符単位のため未対応(エラーで通知する)
 *   &              タイ（直前の音を伸ばす）
 *   L              ループ地点マーカー(パラメータなし)。このチャンネルの再生が末尾まで
 *                  達したとき、Lの位置まで戻って演奏を続ける(実機ppmck同様、曲全体を
 *                  無限ループさせるための地点指定。[ ... ]nの小節単位の繰り返しとは別物)。
 *                  ブラウザ再生・シークバーの「曲の長さ」は、Lへ2回戻る(=イントロ1回+
 *                  ループ区間2回)までとして扱う。NSF書き出し(src/driver/ppmckDriver.js)は
 *                  このチャンネルを実際に無限ループさせる
 *   [ ... ]n       繰り返し (n回)
 *   [ ... | ... ]n 繰り返し (最後の周回だけ | から ] までを演奏しない)
 *   { ... }<len>   連符 (中の音符列を<len>の音長で等分)
 *   EN<n> / ENOF   ノートエンベロープ(高速アルペジオ)。@EN<n>={...}で定義(前回値からの
 *                  相対値・累積、仕様通り厳密実装)。「発音ノート番号の値に加算」される
 *                  (ppmck公式リファレンス通りの半音・ノート番号空間)。2A03全4ch(A-D)・
 *                  VRC6・MMC5・FME7(トーンモード)・FDS・N163・VRC7全対応
 *   EP<n> / EPOF   ピッチエンベロープ。@EP<n>={...}で定義。D<n>と全く同じ「周期/周波数
 *                  レジスタへの生オフセット」空間の値(ppmck公式リファレンスのD/EPの説明が
 *                  一字一句同じ「発音周波数の値に加算されます」であること、実機ドライバの
 *                  sound_pitch_enveropeが detune と同じ freq_add_mcknumber を呼ぶことを
 *                  実ソースで確認済み。以前の実装は値/128を半音とみなしていたが誤りだった)。
 *                  ★値はENと同じ「毎フレームの差分の累積」(2026-09-13修正、pitchEnvelopeValue
 *                  参照): 実機はテーブル値を基準値ではなく「現在のレジスタ値」へ毎フレーム
 *                  足し込む(sound_freq_low/highを基準へ戻すのはノートオンのfrequency_setだけ)。
 *                  「|」無しのテーブルは末尾の値を毎フレーム足し続ける(ppmckc checkLoopが
 *                  末尾1値の前にループ点を差し込むため)ので、止めるには末尾を0にする。
 *                  以前は@v用のstepEnvelope(各フレームの絶対値)を流用しており本家と違っていた。
 *                  対応チャンネルはD<n>と同じ(2A03全4ch・VRC6・MMC5・FME7・FDS・N163、
 *                  VRC7は対象外)
 *   MP<n> / MPOF   ソフトウェアビブラート。@MP<n>={delay,speed,depth}で定義。depthはEP/Dと
 *                  同じ生レジスタ単位(実機ドライバのsound_lfoも同じfreq_add_mcknumberを
 *                  呼ぶため)。波形は実機のlfo_sub/warizan_start(nes_include/ppmck/
 *                  sounddrv.h、AoiMoe/ppmck)をそのまま状態遷移として移植(2026-08-11、
 *                  DESIGN-PITCH.md 別プロジェクトB)。滑らかな三角波ではなく「1フレームごと
 *                  ±1、またはNフレームごと±S」という階段状の変化で、Nまたは
 *                  Sは(1/4周期)と(depth)の割り算(割り切れない場合はceil側に丸まる、実測
 *                  確認済み)で決まる。方向(最初に+/-どちらへ動くか)はperiodFnが周波数の
 *                  増加関数か減少関数かで自動判定(periodFnIncreasing、実機の
 *                  freq_vector_table相当)。対応チャンネルはEPと同じ
 *   PT<target>,<duration>[,<delay>] / PTOF
 *                  ポルタメント(単調な直線グライド)。D<n>/EP<n>と同じ生レジスタオフセット
 *                  空間の値へ、delay経過後durationフレームでtargetへ到達し以降は最終値を
 *                  永久ホールドする(portamentoSequence、MPのwarizan_start片道版と同一の
 *                  ceil除算ステップ)。ppmck本家ドキュメント(doc/mck.txt)には専用の
 *                  ポルタメントコマンドが無く「ピッチエンベロープ(EP)で代用してください」と
 *                  明記されているため、これはppmck方言からの独自拡張(2026-08-11、
 *                  DESIGN-PITCH.md 別プロジェクトC)。対応チャンネルはEPと同じ
 *   s<n0>,<n1>     スイープ。ppmck実機ではソフトウェア効果ではなく2A03パルスの実ハードウェア
 *                  スイープユニット($4001/$4005)への生バイト書き込み(CMD_SWEEPが1回書くだけ
 *                  と実ソースで確認済み)なので、2A03パルスA/Bにしか存在しない
 *                  (三角波・ノイズ・拡張音源は対象外。以前の実装は三角波にまで架空の
 *                  ソフトウェア近似を適用していたが誤りだった)。n1(0-15)の下位4bitは
 *                  そのままnegate(符号)+shift(かかり具合)、n0(0-15、0=OFF)は
 *                  「1が最速・15が最遅」の記載に沿ったperiod(0-7)への線形近似
 *                  (この換算式のみ資料未確認の近似、他は実ソースで確認済み)
 *   @OP<n>={8バイト} / @OT<n>={TL,FB,...} VRC7カスタム音色(パッチ0)。曲中`OP<n>`が
 *                    出現するたびその時点でロードし直す(実機同様スロットは1つだけ、
 *                    全ch共有)。@OTはMGSDRV互換形式(近似変換、下記参照)
 *   @FM<n>={64値}    FDS波形メモリ。`@<n>`(音色番号)で選択し、直前の音符と選択が
 *                    変わったときだけ再ロードする(全ch共有のため動的切り替えは1音源内)
 *   @N<n>={buf,...}  N163波形。先頭のバッファ番号は無視。`@<n>`で選択、FMと同様に
 *                    選択変化時だけ再ロード(全ch共有16サンプル固定)
 *   @MW<n>={32値}    FDSモジュレータ(ピッチ変調)テーブル。1フレームごとに変調カウンタ
 *                    (-64〜63)へ加算する増減量そのものを書く。使える値は
 *                    0(維持)/1/2/4/-1/-2/-4/R(カウンタを0にリセット)の8種類だけで、
 *                    それ以外はコンパイルエラー。実機テーブルの3bitコード
 *                    (0,1,2,3=+4,4=リセット,5=-4,6=-2,7=-1)への変換はlexer.jsが行う
 *   @MH<n>={delay,freq,depth,waveform} / MH<n> / MHOF
 *                    FDSモジュレータ設定・有効化コマンド。waveformは@MW<n>のインデックス。
 *                    曲中`MH<n>`が出現した位置(+delayフレーム)で有効化される
 *   S<n>             FME7ハードウェアエンベロープ形状(0-15)
 *   M<n>             FME7ハードウェアエンベロープ周期(0-65535)
 *   N<n>             FME7ノイズ周波数(0-31、R6)。@2の時は無効(ノート番号が周期になるため)
 *   @<n>(X/Y/Z)      FME7のみ音色番号ではなくミキサー指定(ppmck仕様):
 *                    0=ミュート, 1=トーン(既定), 2=ノイズ, 3=トーン+ノイズ。
 *                    @2ではノート番号がそのままノイズ周波数になる(n0=o0c 〜 n31=o2g)
 *   #TITLE/#COMPOSER/#MAKER/#PROGRAMER <str>  メタ情報(戻り値のmetaに格納。再生には影響しない)
 *   #OCTAVE-REV <n>  0以外で`>``<`(オクターブ上げ/下げ)の意味を反転
 *   #GATE-DENOM <n>  q<n>のゲート分母を8から変更(既定8)
 *   #TUNING <cent>   基準ピッチ。全音符の周波数を12平均律(A4=440Hz)からこのセント数だけずらす(小数可、±1200)。
 *                    音名は変わらない(キー/トランスポーズではない)。*2mml変換が曲全体の音程偏差を
 *                    自動検出して出す(src/convert/options.js detectTuning)。NSF書き出しも同じ値を使う
 *   #EX-VRC6/#EX-VRC7/#EX-DISKFM/#EX-MMC5/#EX-N163(=#EX-NAMCO106)/#EX-SUNSOFT5B(=#EX-FME7)
 *                    拡張音源の使用宣言。opt.expansions(UI選択)と統合される
 *                    (MML本文がこれらを含めば、UIで選択していなくてもその音源が有効になる)
 *   #AUTO-BANKSWITCH/#BANK-CHANGE/#SETBANK/#NO-BANKSWITCH
 *                    バンキング指示子。本ツールはROMバンク分割を前提にしないため認識のみ・無視
 *   #INCLUDE/#EFFECT-INCLUDE  外部ファイル読込。静的ホスティングのみで完結する設計上、
 *                    未対応(認識のみ・無視。INV-1参照)
 *   ;@time <n>/<d>   楽譜用の拍子(例 ;@time 3/4)。ppmckcが無視するコメント行で指示する。
 *                    再生には影響せず、戻り値の score.time と noteList(音価付き音符列)を
 *                    楽譜出力(MusicXML/五線表示)だけが使う。無ければ楽譜側が4/4とみなす
 *   ;@key <n>        楽譜用の調号。五度圏の数(♯の数が正、♭の数が負、-7〜7。例 ;@key -1 =
 *                    ヘ長調/ニ短調)。無ければ楽譜側が自動推定する。;@timeと同じく再生には影響しない
 *   $<char> <mml>    マクロ定義。以降そのチャンネル本文中の<char>を<mml>に1回だけ展開する
 *                    (再帰展開はしない。o l v q t K n N S E M s @ & [ | ] { } > < 空白
 *                    数字 . + # - および音符文字 a-g r は既存コマンドと衝突するため
 *                    マクロ文字に使わないこと)
 *   @t<len>,<num>    テンポ2(フレーム単位)。<len>の音符が確実に<num>フレームになる
 *                    非整数tempoを逆算する(t<n>の整数BPM丸めによる端数化を避ける実機コマンド)
 *   w<len>           ウェイト。直前のコマンド(音符/休符/w自身)を<len>音長ぶんそのまま
 *                    延長する(タイと同じ「直前セグメントのdurationFramesを伸ばすだけ」)
 *   y<adr>,<num>     レジスタ(メモリ)直接書き込み。$接頭辞の16進数対応。ブラウザ再生でも
 *                    そのままそのアドレスへ生バイトを書き込む(チップ非依存)
 *   x<param0>,<param1> データストリームへのバイト直接埋め込み。NSF書き出し(6502バイト
 *                    コード)専用のコマンドで、ブラウザ再生には対応する概念が無いため
 *                    パースのみ行い意図的に無視する(NSF書き出し実装は別タスク)
 *   SD<n> / SDOF / SDQR  セルフディレイ(疑似エコー)。@vr(リリースエンベロープ)併用時のみ
 *                    有効で、リリース区間のピッチを<n>個前のノートオンへ差し替える
 *                    (ppmck公式リファレンスの出力例と完全一致することを実測確認済み)。
 *                    リリース区間の先頭は実機同様「ノートオン」として打ち直す。
 *                    SDQRはノートオン履歴(noteHistory)をリセットする。
 *                    <n>は0〜8(SELF_DELAY_MAX)、SD255はSDOFと同じ、三角波とDPCMでは
 *                    使用不可(いずれも実機ppmck ppmckc datamake.c 準拠)。
 *                    ゲート(q<n>)が音符長いっぱい(既定のq8)だとリリース区間自体が
 *                    存在しないため何も起きない点も実機と同じ
 *   SM / SMOF        スムース(A/B/C対応)。周期/周波数レジスタの上位バイト(書込みで波形
 *                    位相がリセットされる)を「値が変化した時だけ書く」モードに切り替え、
 *                    同オクターブ内のレガートでクリック音が出るのを防ぐだけの機能
 *                    (ピッチ自体はグライドしない。実機CMD_SMOOTH/EFF2_SMOOTH_ENABLEを
 *                    実測確認)
 *   PS               ポルタメント(A/B/C対応)。`c PS g`のように次の音符そのものをグライド
 *                    先として使う。実機process_ps/pitchshift_setup(b_div方式のステップ
 *                    計算)を移植した独自実装で、既存のPT<target>,<duration>(明示的な
 *                    生レジスタオフセット指定)とは別物・共存する。実機は最初の1サイクルだけ
 *                    間隔にstepでなくdurationを使うためグライドが次の音符へ食い込むことが
 *                    あるが、本実装はt=0からstep間隔で刻む簡略化を採用する(意図的な近似、
 *                    ppmck公式リファレンスが明記する「PSコマンド後の音程は不正確」の対象)
 *   ! / !! / !!!     特殊マーカー。!(1個)=データスキップ、この記号以降そのチャンネルの
 *                    MMLは一切コンパイルされない(以降無音)。!!(2個)=タイムシフト、
 *                    ここが「再生開始位置」になりシークバーの開始ハンドルと連動する。
 *                    !!!(3個)=**ppmck本家には無いこのツール独自の拡張**で「再生終了位置」、
 *                    シークバーの終了ハンドルと連動する(省略時は曲の最後まで)。戻り値の
 *                    startMarkerFrame/endMarkerFrameで参照できる
 *
 * 注意: 2026-08-10、実機ppmckドライバ(nes_include/ppmck/{internal,sounddrv}.h)を
 * 直接確認し、D<n>/EP/MPが同一のfreq_add_mcknumberルーチンを共有する「周期/周波数
 * レジスタへの生オフセット」であること、sweep(s)はソフトウェア効果ではなく2A03パルスの
 * 実ハードウェアスイープユニットへの1回書き込みであることを確認、それに合わせて
 * EP/MP/sの実装を全面的に修正した(以前のEP=値/128を半音とみなす換算、sweep=三角波の
 * 半音空間ソフトウェア近似はいずれも仕様に無い誤りだった)。2026-08-11、MPの三角波の
 * 形状自体(内部除算ルーチンwarizan)も実ソース(AoiMoe/ppmck、nes_include/ppmck/
 * sounddrv.h)を完全にトレースして忠実移植した(DESIGN-PITCH.md 別プロジェクトB)。
 * 近似が残るのはsweepのn0(speed)→period変換式、@OT(VRC7のMGSDRV互換音色フォーマットの
 * DTパラメータ解釈)のみ(EN・D/EP/MPの空間そのもの・MPの波形・sweepのレジスタ形式・
 * FME7のS/M/N・VRC7の@OP生バイト形式は仕様・実ソースと一致を確認済み)。
 * 詳細はROADMAP.mdフェーズ1.5・DESIGN-PITCH.md §8参照。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Mml = MML.Mml = MML.Mml || {};
  // 表示文言の翻訳 (src/i18n/i18n.js)。キーは日本語の原文。MML.I18nが無い環境でも動くよう素通し
  const T = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  const CPU_CLOCK_NTSC = 1789773;
  const FRAME_RATE_NTSC = 60.0988;
  Mml.FRAME_RATE_NTSC = FRAME_RATE_NTSC; // 変換側(src/convert/envelope.js applyNoteEnd)が元曲のフレームレートとの比を取る
  // 楽譜出力用(noteList.ticks)の分解能。src/convert/duration.js の TPQN と同じ値だが、
  // compiler.js は convert 層に依存しないためここで別に持つ(値を変えるときは両方)
  const SCORE_TPQN = 480;
  const SCORE_WHOLE_TICKS = SCORE_TPQN * 4;
  Mml.SCORE_TPQN = SCORE_TPQN;

  // ";@time <分子>/<分母>" ";@key <五度圏の数>" のコメント指示を原文から拾う(楽譜出力用、
  // 段階1)。最初の1回だけ採用。不正な値は issues に日本語文言で積む(呼び出し側がwarningsへ)
  function parseScoreDirectives(source) {
    const out = { time: null, key: null, issues: [] };
    const lines = String(source == null ? '' : source).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '').trim();
      let m;
      if ((m = /^;@time\b\s*(.*)$/i.exec(line))) {
        const v = /^(\d+)\s*\/\s*(\d+)$/.exec(m[1].trim());
        const beats = v ? +v[1] : 0, beatType = v ? +v[2] : 0;
        if (!v || beats < 1 || beats > 99 || beatType < 1 || beatType > 64 || (beatType & (beatType - 1)) !== 0) {
          out.issues.push(T(';@time は 分子/分母 で指定してください(分母は1/2/4/8/16/32/64、例 ;@time 3/4): {v}', { v: m[1].trim() }));
        } else if (out.time == null) {
          out.time = { beats, beatType };
        }
      } else if ((m = /^;@key\b\s*(.*)$/i.exec(line))) {
        const v = /^([+-]?\d+)$/.exec(m[1].trim());
        const fifths = v ? +v[1] : NaN;
        if (!v || fifths < -7 || fifths > 7) {
          out.issues.push(T(';@key は五度圏の数(-7〜7、♯が正・♭が負)で指定してください: {v}', { v: m[1].trim() }));
        } else if (out.key == null) {
          out.key = { fifths };
        }
      }
    }
    return out;
  }

  const NOTE_SEMITONES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

  // SD<n>(セルフディレイ)で遡れるノートオン履歴の最大数。実機ppmck(ppmckc mckc.h の
  // SELF_DELAY_MAX)と同じ8。0=自分自身の音程、1=1つ前の音程…と数える
  const SELF_DELAY_MAX = 8;

  // 2A03チャンネルのベースアドレス
  const CHANNEL_BASE = { A: 0x4000, B: 0x4004, C: 0x4008, D: 0x400C };
  const STATUS_ADDR = 0x4015;

  // 拡張音源ごとのチャンネル数。実機ppmck(mckc.h)の_TRACK_STR "ABCDEFGHIJKLMNOPQRSTUVWXYZab"
  // 上で各チップの開始トラック番号が固定(BDPCMTRACK=4/BFMTRACK=5/BVRC7TRACK=6/
  // BVRC6TRACK=12/BN106TRACK=15/BFME7TRACK=23/BMMC5TRACK=26)であり、これは他の拡張音源が
  // 使われているかどうかに関わらず完全固定(https://wikiwiki.jp/mck/チャンネル別MML一覧 参照)。
  // 例えばVRC6だけを使う曲でもチャンネル文字は常にM-Oになり、E-Lは(DPCM/FDS/VRC7が
  // 未使用のため)そのまま空く。EXPANSION_PRIORITYの順に「常にカウント分だけ読み進める」
  // ことで、この固定オフセットをそのまま再現する(assignExpansionLetters参照)。
  const CHIP_CHANNEL_COUNTS = { dpcm: 1, fds: 1, vrc7: 6, vrc6: 3, n163: 8, fme7: 3, mmc5: 2 };
  const EXPANSION_PRIORITY = ['dpcm', 'fds', 'vrc7', 'vrc6', 'n163', 'fme7', 'mmc5'];
  const LETTER_POOL = 'EFGHIJKLMNOPQRSTUVWXYZab'.split('');

  const N163_WAVE_LEN = 16;
  const N163_CHANNEL_COUNT = 8; // 実機は1-8chが可変だが、常に8ch分確保する

  // 有効なチップ名配列(重複除去済み、宣言順は問わない)を受け取り、
  // { チップ名: [割当チャンネル文字...] } を返す。実機ppmck同様、各チップの文字範囲は
  // 他の拡張音源が使われているか否かに関わらず完全固定(未使用チップの分もliを進めて
  // 空き枠として残す。詰めて再割当てはしない)
  function assignExpansionLetters(expansions) {
    const used = new Set(expansions);
    const map = {};
    let li = 0;
    for (const exp of EXPANSION_PRIORITY) {
      const count = CHIP_CHANNEL_COUNTS[exp];
      if (used.has(exp)) map[exp] = LETTER_POOL.slice(li, li + count);
      li += count;
    }
    return map;
  }

  // opt.expansions(配列)または後方互換のopt.expansion(単一文字列)を
  // 正規化した文字列配列にする(未知の値・重複は除去)
  function normalizeExpansions(opt) {
    const list = Array.isArray(opt.expansions) ? opt.expansions
      : (opt.expansion && opt.expansion !== 'none' ? [opt.expansion] : []);
    const seen = new Set();
    const result = [];
    for (const exp of list) {
      if (CHIP_CHANNEL_COUNTS[exp] && !seen.has(exp)) { seen.add(exp); result.push(exp); }
    }
    return result;
  }

  // #TUNING(基準ピッチ、セント)の周波数比。Mml.compile() が曲ごとに設定する(lexer.js settings.tuningCents)。
  // ppmckDriver.js の noteFrequency も同じ比で周波数テーブルを作る(ブラウザ再生とNSF書き出しの一致)
  // #TUNING-NOTE(音名別チューニング、settings.tuningNotes: c=0..b=11 のセント)は音名ごとの比を掛ける。
  // ★ppmckDriver.js の noteFrequency と必ず同じ式にすること(ブラウザ再生とNSF書き出しの一致)
  let tuningRatio = 1;
  let tuningNoteRatios = null; // 12要素の比、または null(#TUNING-NOTE 無し)
  function noteFrequency(noteNumber) {
    const nr = tuningNoteRatios ? tuningNoteRatios[((Math.round(noteNumber) % 12) + 12) % 12] : 1;
    // noteNumber: o4 a (A4=440Hz) を基準(57)とした半音単位の値
    return 440 * Math.pow(2, (noteNumber - 57) / 12) * tuningRatio * nr;
  }

  // 音階の範囲(2026-09-19): NSF書き出しのドライバ(ppmckDriver.js)が周期表で引けるのは o0c〜o9b(ノート番号0〜119)。
  // 音符そのものがこの外なら compile() が警告して鳴らさない(NSF でも休符になる)。
  // ★o9 の段(108〜119)の表は、その音を実際に使う曲のそのチップにだけドライバが持つ(ppmckDriver.js noteTableSizes)
  const NOTE_TABLE_TOP = 119;
  // EN(ノートエンベロープ)でずらしたノート番号 → ドライバが実際に引く表の索引。6502側は
  // NOTE+ENVAL を8bitで足し、bit7 が立てば(=負、または127超)0、表の上限を超えれば上限へクランプする
  // (LOOKUP_*_PERIOD の BPL/CMP)。JS 再生も同じ索引で鳴らす(以前は範囲外でも実音程で鳴らしていた)。
  // 上限は常に119でよい: ドライバが108音の表のままにするのは、108〜到達点の表の値が107番と同じ(=クランプしても
  // 同じ周期)ときだけなので、ここで119まで引いた値と一致する
  function enTableNote(n) {
    const v = ((Math.round(n) % 256) + 256) % 256;
    return v >= 128 ? 0 : Math.min(NOTE_TABLE_TOP, v);
  }

  // D<n>(デチューン)。算出済みの周期/周波数レジスタ値へ生のオフセットを加算し、
  // レジスタ幅でクランプする。2A03パルス/三角・VRC6・MMC5・FME7・FDS(2047/4095幅)に加え
  // N163(freqReg、262143幅。18bitスケールなので同じ値でも変化量は小さい)、
  // VRC7(fnum、511幅。block自体は動かさずfnumだけをクランプするため、blockの境界を
  // またぐような大きなデチューン量では近似精度が落ちるが、コーラス効果程度の
  // 小さなずれなら十分機能する)も対応。
  function applyDetune(period, detune, max) {
    return Math.max(0, Math.min(max, period + (detune || 0)));
  }

  // s<n0>,<n1>(スイープ)。実機ppmckのCMD_SWEEP(nes_include/ppmck/internal.h)は
  // MMLの値をソフトウェアでピッチ計算するのではなく、2A03パルスの実ハードウェア
  // スイープユニット($4001/$4005)へ生バイトをそのまま1回書き込むだけと確認済み
  // (よって2A03パルスA/Bにしか存在せず、三角波・拡張音源には無い。以前の実装は
  // 「speed*4フレームで線形に到達する半音オフセット」という架空のソフトウェア近似を
  // 三角波にまで適用していたが誤りだった)。
  // n1(depth,0-15)の下位4bitは公式リファレンスの変化量対応表(1-7=マイナス/8=変化無し/
  // 9-15=プラス)が標準的なNES APUスイープの符号(negate,bit3)+シフト量(bit2-0)の
  // ビット表現と完全に一致するため、そのままnegate+shiftとして使える。
  // n0(speed,0-15。0=OFF、1=最速…15=最遅)からperiod(0-7)への正確な換算式は資料からは
  // 確認できなかったため、「1が最速・15が最遅」の記述に沿った線形近似を用いる
  // (この部分は未検証の近似。他は実ソースで確認済み)
  function sweepRegisterByte(speed, depth) {
    if (!speed) return 0x08; // OFF: 誤ミュート防止のnegateビットだけ立てる定石を維持
    const period = Math.max(0, Math.min(7, Math.round((speed - 1) / 2)));
    return 0x80 | (period << 4) | ((depth || 0) & 0x0F);
  }

  // 2A03/MMC5 パルス: 周期11bit(2047)。o1a(A1≒55Hz)より下は出ない(本家 ppmck freqdata.h のコメントも同じ)
  function pulsePeriod(freq) {
    let p = Math.round(CPU_CLOCK_NTSC / (16 * freq)) - 1;
    return Math.max(0, Math.min(2047, p));
  }

  // VRC6 パルス: 式は2A03パルスと同じ CLOCK/(16*(period+1)) だが、周期は12bit(4095、$9002/$A002 の下位4bit)。
  // o0a(A0≒27.5Hz)まで出る(本家 ppmck vrc6.h の vrc6_pls_frequency_table は psg_frequency_table の2倍=1オクターブ下が基準)。
  // ★2026-09-14まで VRC6 パルスも pulsePeriod(11bitクランプ)で計算していたため、A1 より下の音が A1 に貼り付いていた
  //   (音域判定 pitchRangeIssue は periodMax 4095 で「鳴らせる」と判定するので、警告も出ずに別の音程で鳴った)
  function vrc6PulsePeriod(freq) {
    let p = Math.round(CPU_CLOCK_NTSC / (16 * freq)) - 1;
    return Math.max(0, Math.min(4095, p));
  }

  function trianglePeriod(freq) {
    let p = Math.round(CPU_CLOCK_NTSC / (32 * freq)) - 1;
    return Math.max(0, Math.min(2047, p));
  }

  // 2A03ノイズ: NTSCの周期テーブル(CPUサイクル、apu2a03.jsのNOISE_PERIODと同じ)。
  // ノイズchのセグメントは noteNumber=周期index(0-15、本家ppmck準拠で n0=最も速い)を持ち、
  // freq にはLFSRのシフトレート(=聴感上の「高さ」の目安)を入れる。
  // ★2026-09-18まで noteNumber は通常の音程番号で index=15-(note%16) と反転写像していた
  //   (o4c=15=最低音、16半音で一周、オクターブが効く)。本家ppmck09aを実ビルドして$400E列を
  //   読むと「音符の半音番号(c=0…b=11)がそのままindex、オクターブ無視、n<num>は直値」で、
  //   同じMMLが別の音になっていたため本家準拠へ切り替えた(ppmck-noise-channel-spec)。
  const NOISE_PERIOD_CPU = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
  function noisePeriodIndex(noteNumber) {
    return ((Math.round(noteNumber) % 16) + 16) % 16;
  }
  function noiseLfsrRate(periodIdx) {
    return CPU_CLOCK_NTSC / NOISE_PERIOD_CPU[noisePeriodIndex(periodIdx)];
  }

  // VRC6 矩形波(サウ): freq = CLOCK / (14 * (period+1))
  function sawPeriod(freq) {
    let p = Math.round(CPU_CLOCK_NTSC / (14 * freq)) - 1;
    return Math.max(0, Math.min(4095, p));
  }

  // FME-7: freq = CLOCK / (32 * period)
  // ★MSXのPSG(AY-3-8910)は f=clock/(16*TP) だが、NESの5B(YM2149)は内蔵の1/2プリスケーラが
  // 効いており分母が32になる(NESdev "Sunsoft 5B audio": Frequency = Clock/(32*Period))。
  // 16で計算すると実際の発音が1オクターブ低くなる(鍵盤表示で低音が範囲外の"??"になる)。
  function fme7Period(freq) {
    let p = Math.round(CPU_CLOCK_NTSC / (32 * freq));
    return Math.max(1, Math.min(4095, p));
  }

  // FDS: freq = CLOCK * period / (65536 * 64)
  function fdsFreqToPeriod(freq) {
    let p = Math.round((freq * 65536 * 64) / CPU_CLOCK_NTSC);
    return Math.max(0, Math.min(4095, p));
  }

  // @n<num>(直接周波数指定)のレジスタ値 → 実際に鳴る周波数(Hz)。上の各 *Period の逆関数で、ロール・鍵盤・
  // 音程検証の代表値に使う(レジスタへ書くのは seg.directPeriod そのもので、この値から周期を作り直しはしない)。
  // kind は Mml.compile の directFreqCaps が決める(ノイズは周期indexなのでここへは来ない)
  function directPeriodToHz(kind, p) {
    switch (kind) {
      case 'pulse': return CPU_CLOCK_NTSC / (16 * (p + 1));       // 2A03/MMC5/VRC6パルス
      case 'triangle': return CPU_CLOCK_NTSC / (32 * (p + 1));
      case 'saw': return CPU_CLOCK_NTSC / (14 * (p + 1));
      case 'fme7': return CPU_CLOCK_NTSC / (32 * Math.max(1, p)); // 周期0は実機でも1と同じ
      case 'fds': return (CPU_CLOCK_NTSC * p) / (65536 * 64);     // 周波数比例(大きいほど高い)
      default: return 0;
    }
  }

  // セグメントの変調前の周期/周波数レジスタ値。@n の音符は指定値そのもの、それ以外は周波数から計算する
  function segBasePeriod(seg, periodFn) {
    return seg.directPeriod != null ? seg.directPeriod : periodFn(seg.freq);
  }

  // N163: 実機の出力周波数は f = CLOCK * freqReg / (15 * 65536 * waveLen * numCh)。
  // (時間多重のため有効ch数が多いほど1chの更新頻度が下がり、同じ freqReg でも音程が下がる)
  // これを反転して freqReg を求める。numCh を含めないと再生/NSF書き出しで音程がズレる。
  /**
   * N163の実効チャンネル数。`#EX-N163 <n>` / `#EX-NAMCO106 <n>` に数値があればそれを使い、
   * 無ければ本文から自動検出する(音符を持つ最上位レターの位置+1)。
   *
   * ★数値を優先するのは本家ppmckと同じ(ppmckc/datamake.c `_EX_NAMCO106` → n106_track_num)。
   *   実効ch数は 波形RAMの空き(128-8n) / 周波数レジスタの尺度(freqReg∝n) / 時間多重による
   *   1chあたりの音量と更新レート の全てを決めるので、宣言と実装がズレると音痴・音量差・
   *   波形あふれが同時に起きる(2026-09-11、変換設定 N163_CH の追加に合わせて宣言優先へ)。
   * 数値なしの手書きMMLは従来どおり自動検出なので、既存の書き方は壊れない。
   */
  function n163NumChOf(letters, segmentsByChannel, settings) {
    const declared = settings && settings.n163NumCh;
    if (declared) return Math.max(1, Math.min(N163_CHANNEL_COUNT, declared));
    let n = 0;
    (letters || []).forEach((ch, index) => {
      if ((segmentsByChannel[ch] || []).some(s => s.freq != null)) n = index + 1;
    });
    return Math.max(1, n);
  }

  function n163FreqReg(freq, waveLen, numCh) {
    let r = Math.round((freq * 15 * 65536 * waveLen * (numCh || 1)) / CPU_CLOCK_NTSC);
    return Math.max(0, Math.min(262143, r));
  }

  // ── 借用先チップの音域判定(2026-08-25) ────────────────────────────
  // 各チップの周期/周波数レジスタは有限幅なので、低すぎる/高すぎる音は物理的に出せない
  // (例: 2A03パルスは period 11bit + 実機が period<8 で発音停止するため約55Hz〜約12.4kHz)。
  // 従来は Math.min/max でクランプしていたため「別の音程で鳴る」という最悪の壊れ方をした
  // (FF4のベース o1f が o1a で鳴る)。作曲側はオクターブを上げる等で対処したいので、
  // 音程を勝手に変えるのではなく「その音は鳴らさない+警告」にする(compile()内で使用)。
  // 戻り値: null=表現可能 / 'low'=低すぎる / 'high'=高すぎる
  function pitchRangeIssue(kind, freq, opt) {
    if (!(freq > 0)) return null;
    const o = opt || {};
    switch (kind) {
      case 'pulse': { // 2A03/MMC5(11bit) と VRC6パルス(12bit)。実機は period<8 で発音停止
        const p = Math.round(CPU_CLOCK_NTSC / (16 * freq)) - 1;
        if (p > (o.periodMax || 2047)) return 'low';
        if (p < 8) return 'high';
        return null;
      }
      case 'triangle': {
        const p = Math.round(CPU_CLOCK_NTSC / (32 * freq)) - 1;
        if (p > 2047) return 'low';
        if (p < 2) return 'high';
        return null;
      }
      case 'saw': { // VRC6のこぎり(12bit)
        const p = Math.round(CPU_CLOCK_NTSC / (14 * freq)) - 1;
        if (p > 4095) return 'low';
        if (p < 3) return 'high';
        return null;
      }
      case 'fme7': {
        const p = Math.round(CPU_CLOCK_NTSC / (32 * freq));
        if (p > 4095) return 'low';
        if (p < 1) return 'high';
        return null;
      }
      case 'fds': { // 周波数比例レジスタなので上限が高音側
        const p = Math.round((freq * 65536 * 64) / CPU_CLOCK_NTSC);
        if (p > 4095) return 'high';
        if (p < 1) return 'low';
        return null;
      }
      case 'n163': { // 有効ch数と波形長で上限周波数が変わる(時間多重のため)
        const r = Math.round((freq * 15 * 65536 * (o.waveLen || N163_WAVE_LEN) * (o.numCh || 1)) / CPU_CLOCK_NTSC);
        if (r > 262143) return 'high';
        if (r < 1) return 'low';
        return null;
      }
      case 'vrc7': {
        if ((freq * 524288) / (49716 * 128) > 511) return 'high'; // block=7でもfnum溢れ
        if ((freq * 524288) / 49716 < 1) return 'low';            // block=0でもfnum=0
        return null;
      }
      default: return null; // ノイズ/DPCMは音程軸が別なので対象外
    }
  }

  const PITCH_NOTE_NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
  function noteNumberToName(n) {
    if (n == null) return '?';
    return 'o' + Math.floor(n / 12) + PITCH_NOTE_NAMES[((n % 12) + 12) % 12];
  }

  // VRC7: freq = fnum * 2^block * 49716 / 2^19
  function vrc7FreqToFnumBlock(freq) {
    for (let block = 0; block <= 7; block++) {
      const fnum = Math.round((freq * 524288) / (49716 * Math.pow(2, block)));
      if (fnum <= 511) return { fnum: Math.max(0, fnum), block };
    }
    return { fnum: 511, block: 7 };
  }

  // ループ([...]n / [...|...]n)をフラットなトークン列に展開する。
  // "|" がある場合、そこから "]" までは最後の周回では演奏しない
  // (ppmck仕様: "|があるときは最後の繰り返しのときに|から]までの演奏をしません")
  function expandLoops(tokens, errors) {
    let i = 0;

    function parseUntil(stopSet) {
      const seq = [];
      while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.type === 'loopStart') {
          i++;
          const before = parseUntil(LOOP_BREAK_OR_END);
          let after = null;
          if (i < tokens.length && tokens[i].type === 'loopBreak') {
            i++;
            after = parseUntil(LOOP_END_ONLY);
          }
          if (i < tokens.length && tokens[i].type === 'loopEnd') {
            const count = tokens[i].count == null ? 2 : tokens[i].count;
            i++;
            for (let r = 0; r < count; r++) {
              seq.push(...before);
              if (after && r < count - 1) seq.push(...after);
            }
          } else {
            errors.push({ message: T('ループ終端 "]" が見つかりません') });
            seq.push(...before);
            if (after) seq.push(...after);
          }
        } else if (stopSet.has(tok.type)) {
          return seq;
        } else {
          seq.push(tok);
          i++;
        }
      }
      return seq;
    }

    const LOOP_BREAK_OR_END = new Set(['loopBreak', 'loopEnd']);
    const LOOP_END_ONLY = new Set(['loopEnd']);
    return parseUntil(new Set());
  }

  // 付点n個 → 倍率 1 + 1/2 + 1/4 + ... + 1/2^n (付点1個=1.5倍, 付点2個=1.75倍, ...)。
  // 旧実装は付点の有無だけを見て常に1.5倍していたため、付点2個(".. ")の音符が
  // 実際より短く(1.75倍のはずが1.5倍で)解釈され、SPC2MML等が生成する".."を
  // 多用するMMLで総再生時間が実際より短くなり、曲が進むほど元音源からズレていく
  // 原因になっていた。
  function dotMultiplier(dots) {
    let mult = 1, add = 1;
    for (let i = 0; i < dots; i++) { add /= 2; mult += add; }
    return mult;
  }

  // carryIn/carryOut: 各音符を独立にMath.roundすると端数(最大0.5フレーム)が
  // 毎回切り捨て/切り上げられ、同じ方向の丸め誤差が短い音符の多いパートで
  // 蓄積し、曲が進むほど元音源からズレていく(SPC2MML実測で最大約1秒/60秒の
  // 系統的ドリフトを確認)。直前の余り誤差をcarryInとして次の音符のtargetに
  // 足し込み、carryOutを次へ引き継ぐことで誤差を蓄積させない
  // (src/convert/duration.jsのframesToLengthsと同じ手法)。
  function framesForLength(len, dots, defaultLength, tempo, carryIn) {
    const n = len || defaultLength;
    const framesPerWhole = (240 / tempo) * FRAME_RATE_NTSC;
    const ideal = (framesPerWhole / n) * dotMultiplier(dots);
    const target = ideal + (carryIn || 0);
    const frames = Math.max(1, Math.round(target));
    return { frames, carryOut: target - frames };
  }

  // ループ展開後のトークン列に対し、{ ... }<len> 連符を等分の固定フレーム数に変換する
  // (該当する note/directNote トークンに forcedFrames を直接付与し、
  // tupletStart/tupletEnd 自体は取り除く)。l<n>/t<n> だけを軽く追跡する事前パス。
  function applyTuplets(tokens, initialTempo, errors) {
    const result = [];
    let defaultLength = 4;
    let tempo = initialTempo;
    let i = 0;

    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.type === 'length') { defaultLength = tok.value || defaultLength; result.push(tok); i++; continue; }
      if (tok.type === 'tempo') { tempo = tok.value; result.push(tok); i++; continue; }
      if (tok.type === 'tupletStart') {
        let j = i + 1, depth = 0;
        while (j < tokens.length) {
          if (tokens[j].type === 'tupletStart') depth++;
          else if (tokens[j].type === 'tupletEnd') { if (depth === 0) break; depth--; }
          j++;
        }
        const inner = tokens.slice(i + 1, j);
        const endTok = tokens[j];
        if (!endTok) {
          errors.push({ message: T('タプレット終端 "}" が見つかりません') });
          result.push(...inner);
          i = j;
          continue;
        }
        const tupletLen = endTok.length != null ? endTok.length : defaultLength;
        const totalFrames = framesForLength(tupletLen, endTok.dots || 0, defaultLength, tempo, 0).frames;
        const noteToks = inner.filter(t => t.type === 'note' || t.type === 'directNote' || t.type === 'directFreq');
        const count = noteToks.length;
        if (count > 0) {
          let carry = 0;
          let assigned = 0;
          noteToks.forEach((nt, k) => {
            let frames;
            if (k === count - 1) {
              frames = Math.max(1, totalFrames - assigned);
            } else {
              const target = (totalFrames / count) + carry;
              frames = Math.max(1, Math.round(target));
              carry = target - frames;
            }
            nt.forcedFrames = frames;
            // 楽譜出力用(noteList): 連符の音価そのものを残す(forcedFramesだけでは
            // 「四分音符を3等分」という表記情報が消えるため)。len=連符全体の音価
            nt.tuplet = { count, len: tupletLen, dots: endTok.dots || 0, index: k };
            assigned += frames;
          });
        }
        result.push(...inner);
        i = j + 1;
        continue;
      }
      result.push(tok);
      i++;
    }

    return result;
  }

  // PS(ポルタメント)のグライド元音程を求める: 直近に追加されたセグメントの、
  // その時点で有効な(pitchBreaksがあればその最後の){freq, noteNumber}を返す。休符
  // (freq==null)は読み飛ばして遡る(6502ドライバのNOTE,Xが休符で変わらないのと同じ)。
  // 見つからなければnull
  function lastActivePitch(segments) {
    for (let k = segments.length - 1; k >= 0; k--) {
      const s = segments[k];
      if (s.freq != null) {
        // @n(直接周波数指定)の音符からはグライドしない(ノート番号を持たないので6502側のPSが
        // グライド元の周期を引けない。本家もPSのグライド元は音階の音符だけ)
        if (s.directPeriod != null) return null;
        if (s.pitchBreaks && s.pitchBreaks.length > 0) {
          const pb = s.pitchBreaks[s.pitchBreaks.length - 1];
          return { freq: pb.freq, noteNumber: pb.noteNumber };
        }
        return { freq: s.freq, noteNumber: s.noteNumber };
      }
    }
    return null;
  }

  // チャンネルのトークン列 -> 音符セグメント列
  // settings: #OCTAVE-REV(>/<を反転)・#GATE-DENOM(qのゲート分母、既定8)などの曲全体設定
  // defaultInstrument: @<n>が一度も書かれていないときの音色番号。FME7だけはこの値が
  // ミキサー指定(0=ミュート)を兼ねるため、ppmck同様に既定を1(トーン)にする必要がある
  // chanCaps: このチャンネルで使えるコマンドの制約(省略時は全て許可)。
  //   selfDelay=false のチャンネル(三角波・DPCM)ではSD/SDOF/SDQRをエラーにする。
  //   toneEnv: @@<n>/@@r<n>の意味('duty'=デューティエンベロープ選択、
  //   'instrument'=音色/波形番号選択、null=このチャンネルでは使用不可)。
  //   vrc7: VRC7チャンネルなら真(@@<64+n>=OP<n>の別名に使う)
  //   psAllowed: PS(ポルタメント)を有効にするか。ppmck本家同様に対応トラックはA/B/C
  //   (2A03パルスA/B・三角波)のみ。対象外チャンネルではNSF書き出し(ppmckDriver.jsの
  //   RD_PITCHSHIFT)が「グライドせず通常のアタック」へフォールバックする設計なので、
  //   ブラウザ再生側も同じく通常の音符として扱い両者を一致させる(2026-08-16)
  //   noise: 2A03ノイズch(D)。音符/n<num>を周期index(0-15)として解釈し、o/>/</Kを無視する
  //   (本家ppmck準拠、noisePeriodIndex冒頭コメント参照)。
  //   dpcm: DPCMch(E)。音符/n<num>を @DPCM<n> の番号として解釈し(DPCM_NOTE_BASE 参照)、
  //   本家ppmckc(datamake.c)がDPCMトラックで許可しないコマンド(@ v v+ v- @v @vr D EP EN MP K PT PS s)を
  //   エラーにする。warnings(任意): ここで見つけた
  //   「エラーではないが意図と違う可能性」を積む配列(呼び出し側のwarningsへ合流させる)
  function buildSegments(tokens, initialTempo, errors, settings, defaultInstrument, chanCaps) {
    const caps = chanCaps || { selfDelay: true, toneEnv: 'duty', psAllowed: false };
    const warnings = caps.warnings || [];
    // ノイズchで無視/丸めたコマンドの警告は1チャンネル1回だけ(打楽器パートは同じ書き方を
    // 何百回も繰り返すので、出現ごとに出すと警告欄が埋まる)
    const noiseWarned = { transpose: false, directNote: false, instrument: false };
    // @n(直接周波数指定)のエラー/警告も1チャンネル1回
    const directFreqWarned = { error: false, range: false, en: false };
    // DPCMch(E)で使えないコマンド(本家ppmckcはエラー)。同じコマンドの再出現は1回にまとめる
    const dpcmRejected = new Set();
    const dpcmReject = (name) => {
      if (dpcmRejected.has(name)) return;
      dpcmRejected.add(name);
      errors.push({ message: T('{cmd} はDPCMチャンネル(E)では使用できません(本家ppmck準拠: 音符/n<num>が@DPCM番号、レートは定義のfreqで固定)', { cmd: name }) });
    };
    const cfg = settings || { octaveRev: 0, gateDenom: 8 };
    // volMax: v<n>の上限。本家ppmck(datamake.c _VOLUME)と同じくFDS/VRC6のこぎり波だけ63、
    // 他は15。volDefault: v<n>未指定時の音量(FDS=32=実効フルゲイン、VRC6サウ=63、他=15)
    const volMax = caps.volMax == null ? 15 : caps.volMax;
    const volDefault = caps.volDefault == null ? volMax : caps.volDefault;
    const state = {
      octave: 4, defaultLength: 4, volume: volDefault, gate: 8, gateAdjust: 0, keyOnFrames: 0, instrument: defaultInstrument || 0,
      envelopeV: null, envelopeVr: 255, transpose: 0, detune: 0, qFrames: null,
      vibrato: null, pitchEnv: null, pitchEnvDelay: 0, portamento: null, noteEnv: null,
      sweepSpeed: 0, sweepDepth: 0, fme7Noise: null, fme7EnvShape: null, fme7EnvPeriod: 0,
      // selfDelay: SD<n>の<n>(null=SDOF)。smooth: SM(true)/SMOF(false)。
      // pendingPitchShift: PSトークン読み取り直後〜次の音符処理までのワンショットフラグ
      selfDelay: null, smooth: false, pendingPitchShift: false,
      // SA<num>(ppmckc公式、N163用): D/EP/MPの値を<num>回左シフトしてから周波数値へ
      // 加減算する(pitchRegisterOffset参照)。EP/MPテーブル値・Dが1byte幅なのに対し
      // N163の周波数レジスタは18bitで、深いビブラート等はシフト無しでは表現できない
      pitchSa: 0,
      // toneEnv: @@<n>で選択中のデューティ(音色)エンベロープ番号(null=未選択=@<n>の
      // 固定デューティ)。releaseTone: @@r<n>のリリース音色番号(255=OFF)
      toneEnv: null, releaseTone: 255
    };
    const segments = [];
    // SD(セルフディレイ)用のノートオン履歴(発音順にfreq/noteNumberを積む)。
    // SDQRで空にする
    const noteHistory = [];
    // OP<n>(VRC7音色ロード)/MH<n>(FDS変調)のような「音符に紐付かない、その時点のフレーム
    // 位置で即座に効くコマンド」を記録する。frameはこのトークンに達するまでに
    // 消費された(=直前までのセグメントの合計)フレーム数
    const immediateWrites = [];
    let lengthCarry = 0;
    let tempo = initialTempo;
    let elapsedFrames = 0;
    // 楽譜出力用の音符列(ROADMAP「フェーズ外: 楽譜出力」段階1、2026-09-16)。
    // segments はタイ(&)/w/k で1つに併合され音価(四分/付点/連符)がフレーム数に潰れるが、
    // こちらは「書かれた音符トークン1つ=1要素」で音価を保持する。frames は segments と
    // 同じ値なので、チャンネル内の合計は segments の合計(=totalFramesの材料)と一致する。
    // 純粋な追加情報で、再生/書き出しの他の出力には一切影響しない。
    //   kind:    'note'(音符/休符) | 'wait'(w、直前の音の延長) | 'keyOff'(k、直前の音の
    //            リリース区間=譜面上は休符)
    //   note:    ノート番号(compilerの規約。休符はnull)。len: {n, dots}(連符内は連符全体の音価)
    //   tuplet:  {count, index} 連符内の音符(何等分の何番目)、それ以外はnull
    //   ticks:   四分音符=SCORE_TPQN(480、src/convert/duration.jsのTPQNと同じ)での音価。
    //            連符は割り切れないことがあるので小数を許す
    //   joined:  直前の要素から &/w で繋がっている(同音程ならタイ、異音程ならレガート=スラー)
    //   glide:   PSでこの音へグライドする(譜面上はスラー/グリッサンド相当)
    //   tempo:   この音符時点のテンポ(t/@tの変化点を譜面に出すため)
    //   spelled: 書かれた音名/臨時記号/オクターブ/移調(異名同音の手がかり。n<num>はnull)
    //   srcStart/srcEnd: 原文の文字範囲(highlightRangesと同じ規約)
    const notes = [];
    function recordNote(kind, tok, frames, noteNumber, joined, glide) {
      const tup = tok.tuplet || null;
      const n = tup ? tup.len : (tok.length || state.defaultLength);
      const dots = tup ? tup.dots : (tok.dots || 0);
      let ticks = (SCORE_WHOLE_TICKS / n) * dotMultiplier(dots);
      if (tup) ticks /= tup.count;
      notes.push({
        kind, startFrame: elapsedFrames, frames, note: noteNumber,
        len: { n, dots }, tuplet: tup ? { count: tup.count, index: tup.index } : null, ticks,
        joined: !!joined, glide: !!glide, tempo,
        spelled: tok.type === 'note'
          ? { name: tok.name, accidental: tok.accidental | 0, octave: state.octave, transpose: state.transpose }
          : null,
        srcStart: tok.srcStart, srcEnd: tok.srcEnd
      });
    }
    // L(ループ地点マーカー)が出現した時点でのelapsedFrames。複数回書かれた場合は
    // 最初の1回だけを採用する(2回目以降は無視)
    let loopFrame = null;
    // !!(タイムシフト=再生開始位置)/!!!(本ツール独自拡張=再生終了位置)が出現した時点の
    // elapsedFrames。loopFrameと同じく最初の1回だけを採用する
    let startMarkerFrame = null;
    let endMarkerFrame = null;
    // マーカートークン自身の原文文字範囲({start,end}、無ければnull)。UI側(main.js)が
    // シークバードラッグ後にMMLへ書き戻す際、既存マーカーの置換位置として使う
    let startMarkerSrcRange = null;
    let endMarkerSrcRange = null;

    // srcStart/srcEnd: 元MMLソース上のこの音符/休符トークンの絶対文字範囲(再生ハイライト用、
    // lexer.tokenizeがoffsets付きで呼ばれた場合のみ付与される。無ければundefined)
    // directPeriod(省略可): @n<num>(直接周波数指定)の音符なら、チップの周期/周波数レジスタへそのまま書く値
    // (レジスタ幅でマスク済み)。freq/noteNumber はロール・鍵盤・警告表示用にその値から逆算した代表値
    function pushNote(frames, freq, noteNumber, srcStart, srcEnd, directPeriod) {
      elapsedFrames += frames;
      const prev = segments.length > 0 ? segments[segments.length - 1] : null;
      if (prev && prev.tieNext && (directPeriod != null || prev.directPeriod != null)) {
        // @n が絡むタイ(&): 本家ppmckと同じく「次の要素の音長を足すだけ」で、次の音符の音程は捨てる
        // (datamake.c getDeltaTime。本ツールの異音程レガート=pitchBreaks は @n の周期値を運べないうえ、
        // 本家にも無い拡張なので @n には広げない)。SD用のノートオン履歴にも積まない(本家の last_note も
        // @n では更新されない)
        prev.durationFrames += frames;
        prev.tieNext = false;
        if (srcEnd != null) prev.srcEnd = srcEnd;
        if (freq != null && directPeriod == null) noteHistory.push({ freq, noteNumber });
      } else if (prev && prev.tieNext) {
        // タイ(&): 新しいセグメントを作らず前のセグメントを延長する(ゲート/エンベロープは
        // 継続、再アタックしない)。★2026-08-12修正: 以前は音程が前と異なる場合でも
        // freq/noteNumberを丸ごと捨てて単にdurationFramesを延長するだけだったため、
        // タイで別の音へレガートするMML(DESIGN-PITCH.md §3の`a8 & g8`等、スラー分割の
        // 前提)が実際には音程変化ゼロのまま再生されるバグだった。音程が異なる場合は
        // 「アタック無しでこの相対フレーム位置(prev.durationFrames時点)から新しい音程に
        // 切り替える」という記録をpitchBreaksへ積む。実際の適用はwritePitchModulationの
        // 毎フレームループ(activePitchAt)に委ねる。EP/MP/PTと同じ「値が変わった時だけ
        // 書く・位相リセット副作用のある上位バイトはlastHiガード」を自動的に適用できる
        // (hasPitchModulationがpitchBreaksありのセグメントもtrueを返すようにするだけで、
        // 各チップの書込みハンドラは無改修で正しく動く)。
        // ★2026-08-14修正: 比較対象は「直前に適用済みの音程」であるべきで、prev.noteNumber/
        // prev.freq(セグメント先頭=アンカー音符から一度も更新されない)と比較していたのは
        // バグだった。長いタイ連鎖の途中でアンカーと全く同じ音程へ戻る音符が来ると、
        // 「アンカーと同じだから変化なし」と誤判定されpitchBreaksへの記録がまるごと
        // 抜け落ち、実際にはその前の(アンカーと異なる)音程で止まったまま戻らない
        // 「音を外す」不具合になっていた(Last Bible DMG-M7J.gbs実測、E→D→G→F#→F→Eと
        // 巡ってアンカーEへ戻る箇所でF止まりになり発覚)。pitchBreaksが既にあれば
        // その末尾(直近適用値)、無ければセグメント先頭(アンカー)と比較する。
        const curNoteNumber = (prev.pitchBreaks && prev.pitchBreaks.length > 0)
          ? prev.pitchBreaks[prev.pitchBreaks.length - 1].noteNumber : prev.noteNumber;
        const curFreq = (prev.pitchBreaks && prev.pitchBreaks.length > 0)
          ? prev.pitchBreaks[prev.pitchBreaks.length - 1].freq : prev.freq;
        if (noteNumber != null && freq != null &&
            (noteNumber !== curNoteNumber || freq !== curFreq)) {
          if (!prev.pitchBreaks) prev.pitchBreaks = [];
          prev.pitchBreaks.push({ atFrame: prev.durationFrames, freq, noteNumber });
        }
        prev.durationFrames += frames;
        prev.tieNext = false;
        if (srcEnd != null) prev.srcEnd = srcEnd;
        if (freq != null) noteHistory.push({ freq, noteNumber });
      } else {
        // PS(ポルタメント、実機準拠新規実装): 直前のpitchShiftトークンをここで消費する。
        // グライド元は直近の実音(休符/未発音を飛ばした最後のfreq)。見つからなければ
        // 通常の音符として扱う(グライドしようがないため)
        // @n(直接周波数指定)の音符はグライド先にもグライド元にもならない(通常のアタックで鳴らす。
        // lastActivePitch が @n の音符で null を返す)
        let psGlide = null;
        if (freq != null && directPeriod == null && state.pendingPitchShift && caps.psAllowed) {
          const from = lastActivePitch(segments);
          if (from != null) psGlide = { fromFreq: from.freq, fromNoteNumber: from.noteNumber };
        }
        state.pendingPitchShift = false;

        // SD(セルフディレイ): リリースエンベロープ(@vr)有効時のみ、ゲート終了以降の
        // ピッチを<selfDelay>個前のノートオンへ差し替える(ppmck公式リファレンスの
        // 出力例を実測トレースして再現。noteHistoryは push 後の配列で
        // 「後ろからselfDelay+1番目」を引く)
        let pitchBreaks = null;
        if (freq != null && directPeriod == null) noteHistory.push({ freq, noteNumber });
        if (freq != null && state.selfDelay != null && state.envelopeVr !== 255) {
          const idx = noteHistory.length - 1 - state.selfDelay;
          if (idx >= 0) {
            const target = noteHistory[idx];
            const gf = computeGateFrames({ gate: state.gate, gateAdjust: state.gateAdjust, gateDenom: cfg.gateDenom, qFrames: state.qFrames, keyOnFrames: state.keyOnFrames }, frames);
            // attack: 実機ppmckはリリース区間を「ノートオン」として出力する
            // (putReleaseEffect → putAsm(fp, note))ので、このピッチブレークは
            // タイ(&)のレガートと違い打ち直しを伴う。writePitchModulation参照
            pitchBreaks = [{ atFrame: gf, freq: target.freq, noteNumber: target.noteNumber, attack: true }];
          }
        }

        segments.push({
          durationFrames: frames,
          freq,
          noteNumber,
          srcStart,
          srcEnd,
          volume: state.volume,
          instrument: state.instrument,
          envelopeV: state.envelopeV,
          envelopeVr: state.envelopeVr,
          gate: state.gate,
          gateAdjust: state.gateAdjust,
          gateDenom: cfg.gateDenom,
          qFrames: state.qFrames,
          keyOnFrames: state.keyOnFrames,
          keyOffAt: null,
          vibrato: state.vibrato,
          pitchEnv: state.pitchEnv,
          pitchEnvDelay: state.pitchEnvDelay,
          portamento: state.portamento,
          noteEnv: state.noteEnv,
          sweepSpeed: state.sweepSpeed,
          sweepDepth: state.sweepDepth,
          // @n の音符には D<n> が効かない(本家ppmck: direct_freq_sub は detune_write_sub を通らない。
          // D を足すのは音階テーブルから周波数を作る frequency_set だけ)。EP/MP/PT は効く
          detune: directPeriod != null ? 0 : state.detune,
          fme7Noise: state.fme7Noise,
          fme7EnvShape: state.fme7EnvShape,
          fme7EnvPeriod: state.fme7EnvPeriod,
          smooth: state.smooth,
          pitchSa: state.pitchSa,
          toneEnv: state.toneEnv,
          releaseTone: state.releaseTone,
          // リリース音色の値がデューティエンベロープ番号か固定音色番号かの区別
          // (NSF書き出しの音色バイトbit7に対応。mckBytecode.js参照)
          releaseToneDuty: caps.toneEnv === 'duty',
          psGlide,
          pitchBreaks,
          tieNext: false,
          // @n<num>(直接周波数指定)の周期/周波数レジスタ値。通常の音符には付けない
          ...(directPeriod != null ? { directPeriod } : {})
        });
      }
    }

    // k<len>: 直前の音符をその場でゲートオフして frames ぶん待つ(実機 _KEY_OFF は
    // putReleaseEffect を delta_time ぶん出す=音符の続きとしてリリース区間を伸ばす)。
    // 音符のゲートは音符自身の長さで計算した値(q/@q/@k)を keyOffAt に固定してから
    // durationFrames を伸ばす。直前が音符でなければ(休符の後・先頭)ただの休符
    function pushKeyOff(frames, srcStart, srcEnd) {
      const prev = segments.length > 0 ? segments[segments.length - 1] : null;
      if (prev && prev.freq != null) {
        const g = computeGateFrames(prev, prev.durationFrames);
        prev.keyOffAt = prev.keyOffAt == null ? g : Math.min(prev.keyOffAt, g);
        prev.durationFrames += frames;
        prev.tieNext = false;
        if (srcEnd != null) prev.srcEnd = srcEnd;
        elapsedFrames += frames;
      } else {
        pushNote(frames, null, null, srcStart, srcEnd);
      }
    }

    for (const tok of tokens) {
      switch (tok.type) {
        case 'octave': state.octave = tok.value; break;
        case 'octaveUp': state.octave += cfg.octaveRev ? -1 : 1; break;
        case 'octaveDown': state.octave += cfg.octaveRev ? 1 : -1; break;
        case 'length': state.defaultLength = tok.value || state.defaultLength; break;
        // 明示的なv<n>は実機でも音量レジスタをbit4=0(固定音量)で書き直すのと同じことなので、
        // ソフトウェアエンベロープ(envelopeV)だけでなくFME7ハードウェアエンベロープ
        // (fme7EnvShape、S<n>で設定・解除するコマンドが無く一度設定すると残り続けるため
        // ここで明示的に解除する)も同時にクリアする
        // 上限超え(v16を2A03に書く等)は本家ppmck同様エラー(ABNORMAL_VOLUME_VALUE)。
        // 相対指定の範囲超えも本家同様エラー(VOLUME_RANGE_OVER/UNDER)だがこちらはクランプに留める
        case 'volume':
          if (caps.dpcm) { dpcmReject('v'); break; }
          if (tok.value < 0 || tok.value > volMax) {
            errors.push({ message: T('v の値は 0〜{max} で指定してください ({v})', { max: volMax, v: tok.value }) });
          }
          state.volume = Math.max(0, Math.min(volMax, tok.value)); state.envelopeV = null; state.fme7EnvShape = null; break;
        case 'volumeRel':
          if (caps.dpcm) { dpcmReject('v+/v-'); break; }
          state.volume = Math.max(0, Math.min(volMax, state.volume + tok.delta)); state.envelopeV = null; state.fme7EnvShape = null; break;
        // 実機ppmckcは rate が 0〜denom の範囲外、rate=0でadjust<=0、rate=denomでadjust>0 を
        // エラーにする。ここは範囲に丸めるだけに留める(rateの上限は #GATE-DENOM)
        case 'gate':
          state.gate = Math.max(0, Math.min(cfg.gateDenom || 8, tok.value));
          state.gateAdjust = tok.adjust | 0;
          state.qFrames = null;
          break;
        case 'quantizeFrames': state.qFrames = Math.max(0, tok.value); break;
        case 'keyOnFrames': state.keyOnFrames = Math.max(0, tok.value | 0); break;
        case 'keyOff': {
          const lenResult = framesForLength(tok.length, tok.dots, state.defaultLength, tempo, lengthCarry);
          lengthCarry = lenResult.carryOut;
          {
            const prev = segments.length > 0 ? segments[segments.length - 1] : null;
            recordNote(prev && prev.freq != null ? 'keyOff' : 'note', tok, lenResult.frames, null, false, false);
          }
          pushKeyOff(lenResult.frames, tok.srcStart, tok.srcEnd);
          break;
        }
        case 'tempo': tempo = tok.value; break;
        case 'transpose':
          if (caps.dpcm) { dpcmReject('K'); break; }
          // ノイズch: 本家ppmckはKをノイズtrackでエラーにする(datamake.c ALLTRACK&~NOISETRACK)。
          // 周期indexは音程ではないので移調に意味が無く、無視して警告だけ出す
          if (caps.noise) {
            if (!noiseWarned.transpose) { noiseWarned.transpose = true; warnings.push({ srcStart: tok.srcStart, message: T('K(移調)はノイズchでは無効です(本家ppmck準拠、周期indexは移調できません)') }); }
            break;
          }
          state.transpose = tok.value; break;
        // D255 は本家ppmckの「ディチューン解除」(datamake.c _DETUNE: 255だけ範囲外でも通す番兵。
        // wikiの作例 `D255 n0n1…` はこれ)。0と同じ意味に正規化する
        case 'detune':
          if (caps.dpcm) { dpcmReject('D'); break; }
          state.detune = tok.value === 255 ? 0 : tok.value; break;
        // @<n>: 固定の音色指定。実機同様デューティ(音色)エンベロープ@@<n>を解除する
        // (ppmck internal.h duty_select_part が effect_flag のデューティエンベ有効ビットを
        // 落とすのと同じ)。ノイズchでは @0=長周期/@1=短周期(本ツール独自拡張)
        case 'instrument':
          if (caps.dpcm) { dpcmReject('@'); break; }
          if (caps.noise && tok.value !== 0 && tok.value !== 1 && !noiseWarned.instrument) {
            noiseWarned.instrument = true;
            warnings.push({ srcStart: tok.srcStart, message: T('ノイズchの @<n> は 0(長周期)か 1(短周期)です(@{v} は下位1bitで解釈します)', { v: tok.value }) });
          }
          state.instrument = tok.value; state.toneEnv = null; break;
        // @@<n>: 実機ppmckの音色バイトbit7=0(自作音色)。意味はチップによって変わる。
        //   ・デューティ比を持つチップ(2A03パルスA/B・VRC6パルス・MMC5パルス)
        //     → @<n>={...}で定義したデューティエンベロープの選択(caps.toneEnv==='duty')
        //   ・波形/音色番号を持つチップ(FDS・N163・VRC7)
        //     → そのまま音色(波形)番号の選択。本ツールの@<n>と同じ意味になる
        //       (caps.toneEnv==='instrument')。VRC7だけは@@<64+n>=OP<n>
        //       (@OP<n>で定義したユーザー音色をレジスタへロードし、音色番号0=ユーザー音色)
        //       という別名も実機リファレンスに定義されている
        case 'toneEnv': {
          if (caps.toneEnv === 'duty') {
            state.toneEnv = tok.value;
          } else if (caps.toneEnv === 'instrument') {
            if (caps.vrc7 && tok.value >= 64) {
              immediateWrites.push({ kind: 'vrc7Tone', frame: elapsedFrames, value: tok.value - 64 });
              state.instrument = 0;
            } else {
              state.instrument = tok.value;
            }
          } else {
            errors.push({ message: T('@@/@@r はこのチャンネルでは使用できません(2A03パルス・VRC6パルス・MMC5パルス・FDS・N163・VRC7のみ)') });
          }
          break;
        }
        // @@r<n>: リリース音色(255=OFF)。ゲートオフの瞬間に音色を差し替える
        case 'releaseTone': {
          if (caps.toneEnv == null) {
            errors.push({ message: T('@@/@@r はこのチャンネルでは使用できません(2A03パルス・VRC6パルス・MMC5パルス・FDS・N163・VRC7のみ)') });
            break;
          }
          // N163だけは音色=波形で、波形本体は共有RAMアロケータ(MML.N163Alloc)が
          // 「音符の切れ目」単位で配置を決めているため、音符の途中(ゲートオフ)で
          // 別の波形へ差し替えるにはアロケータ側の対応が要る。黙って無視すると
          // 「書いたのに効かない」不具合になるので、明示的にエラーで知らせる
          if (caps.n163 && tok.value !== 255) {
            errors.push({ message: T('@@r はN163では未対応です(波形の共有RAM配置が音符単位のため)') });
            break;
          }
          state.releaseTone = tok.value;
          break;
        }
        case 'envelopeV': if (caps.dpcm) { dpcmReject('@v'); break; } state.envelopeV = tok.value; break;
        case 'envelopeVr': if (caps.dpcm) { dpcmReject('@vr'); break; } state.envelopeVr = tok.value; break;
        case 'vibrato': if (caps.dpcm) { dpcmReject('MP'); break; } state.vibrato = tok.value; break;
        case 'pitchEnv': if (caps.dpcm) { dpcmReject('EP'); break; } state.pitchEnv = tok.value; state.pitchEnvDelay = tok.delay || 0; break;
        case 'portamento':
          if (caps.dpcm) { dpcmReject('PT'); break; }
          // duration/delay は NSF 書き出しのバイトコードでは1バイト(0xF9、duration=0 が PTOF の番兵)なので、
          // ブラウザ再生も同じ値で鳴らす(2026-09-19。以前は PT<n>,0 や duration/delay>255 で両者が食い違った:
          // duration 0 はこちらだけ1フレームのポルタメントとして効き、256以上はNSFだけ下位バイトに化けていた)
          state.portamento = (tok.target == null || !(tok.duration > 0)) ? null : {
            target: tok.target, duration: Math.min(255, tok.duration), delay: Math.min(255, Math.max(0, tok.delay | 0))
          };
          break;
        case 'noteEnv': if (caps.dpcm) { dpcmReject('EN'); break; } state.noteEnv = tok.value; break;
        case 'sweep': if (caps.dpcm) { dpcmReject('s'); break; } state.sweepSpeed = tok.speed; state.sweepDepth = tok.depth; break;
        case 'fme7Noise': state.fme7Noise = tok.value; break;
        case 'fme7EnvShape': state.fme7EnvShape = tok.value; break;
        case 'fme7EnvPeriod': state.fme7EnvPeriod = tok.value; break;
        case 'loopPoint': if (loopFrame == null) loopFrame = elapsedFrames; break;
        case 'timeShiftStart':
          if (startMarkerFrame == null) {
            startMarkerFrame = elapsedFrames;
            if (tok.srcStart != null) startMarkerSrcRange = { start: tok.srcStart, end: tok.srcEnd };
          }
          break;
        case 'timeShiftEnd':
          if (endMarkerFrame == null) {
            endMarkerFrame = elapsedFrames;
            if (tok.srcStart != null) endMarkerSrcRange = { start: tok.srcStart, end: tok.srcEnd };
          }
          break;
        case 'vrc7Tone': immediateWrites.push({ kind: 'vrc7Tone', frame: elapsedFrames, value: tok.value }); break;
        case 'fdsMod': immediateWrites.push({ kind: 'fdsMod', frame: elapsedFrames, value: tok.value }); break;
        // @t<len>,<num> テンポ2: framesForLengthが逆算どおりの整数フレーム数を返すよう、
        // 「<len>(付点考慮)の音符が<num>フレームになる」ちょうどのtempo値(小数)を算出する
        case 'frameTempo': {
          const len = tok.len || 4;
          const num = tok.num || 30;
          const mult = dotMultiplier(tok.dots || 0);
          tempo = (240 * FRAME_RATE_NTSC * mult) / (num * len);
          break;
        }
        // w<len> ウェイト: タイと同じく直前セグメントのdurationFramesを延長するだけ
        // (音程・音量・エンベロープは一切変更しない)。直前セグメントが無ければ休符として扱う
        case 'wait': {
          const lenResult = framesForLength(tok.length, tok.dots, state.defaultLength, tempo, lengthCarry);
          const frames = lenResult.frames;
          lengthCarry = lenResult.carryOut;
          if (segments.length > 0) {
            const prev = segments[segments.length - 1];
            recordNote('wait', tok, frames, prev.freq != null ? prev.noteNumber : null, true, false);
            elapsedFrames += frames;
            prev.durationFrames += frames;
          } else {
            recordNote('note', tok, frames, null, false, false);
            pushNote(frames, null, null, tok.srcStart, tok.srcEnd);
          }
          break;
        }
        // y<adr>,<num> レジスタ直接書き込み。音符に紐付かない即時イベントとして記録し、
        // compile()側でチャンネル非依存にwriteLogへ差し込む(spliceImmediateWrites参照)
        case 'rawWrite': immediateWrites.push({ kind: 'rawWrite', frame: elapsedFrames, addr: tok.addr, value: tok.value }); break;
        // x<param0>,<param1> はNSF書き出し(6502バイトコード)専用のコマンドで、ブラウザ再生
        // (レジスタログ方式)には対応する概念が無いため意図的に無視する(NSF書き出し実装は別タスク)
        case 'directBytes': break;
        // SD<n>/SDOF/SDQR(セルフディレイ)。本家ppmck(ppmckc datamake.c)に合わせた制約:
        //   ・対応トラックは ALLTRACK & ~TRACK(2) & ~DPCMTRACK = 三角波とDPCM以外
        //   ・SD255はSDOFの別名(_SELF_DELAY_ON で param==255 なら self_delay=-1)
        //   ・<n>の有効範囲は 0〜SELF_DELAY_MAX(8)。外れると変換エラー
        case 'selfDelay': {
          if (!caps.selfDelay) {
            errors.push({ message: T('SD/SDOF/SDQR は三角波・DPCMチャンネルでは使用できません') });
            break;
          }
          if (tok.value === 255) { state.selfDelay = null; break; }
          if (tok.value != null && (tok.value < 0 || tok.value > SELF_DELAY_MAX)) {
            errors.push({ message: T('SD の値は 0〜{max} で指定してください ({v})', { max: SELF_DELAY_MAX, v: tok.value }) });
            break;
          }
          state.selfDelay = tok.value;
          break;
        }
        case 'selfDelayReset':
          if (!caps.selfDelay) {
            errors.push({ message: T('SD/SDOF/SDQR は三角波・DPCMチャンネルでは使用できません') });
            break;
          }
          noteHistory.length = 0;
          break;
        case 'smooth': state.smooth = tok.value; break;
        // SA<num>(N163専用、state.pitchSa冒頭コメント参照)。本家仕様どおり範囲0〜8
        case 'pitchShiftAmount': {
          if (!caps.n163) {
            errors.push({ message: T('SA はN163チャンネル専用です') });
            break;
          }
          if (tok.value == null || tok.value < 0 || tok.value > 8) {
            errors.push({ message: T('SA の値は 0〜8 で指定してください ({v})', { v: tok.value }) });
            break;
          }
          state.pitchSa = tok.value;
          break;
        }
        case 'pitchShift': if (caps.dpcm) { dpcmReject('PS'); break; } state.pendingPitchShift = true; break;
        case 'tie': {
          if (segments.length > 0) segments[segments.length - 1].tieNext = true;
          break;
        }
        case 'note': {
          let frames;
          if (tok.forcedFrames != null) {
            frames = tok.forcedFrames;
          } else {
            const lenResult = framesForLength(tok.length, tok.dots, state.defaultLength, tempo, lengthCarry);
            frames = lenResult.frames;
            lengthCarry = lenResult.carryOut;
          }
          let freq = null;
          let noteNumber = null;
          if (tok.name !== 'r' && caps.dpcm) {
            // DPCMch: 本家ppmckcの音符バイトは (オクターブ<<4)+半音番号 で、DPCMトラックだけオクターブの
            // -2補正が無い(datamake.c: TRACK0-2以外は octave=com のまま)。ドライバ(dpcm.h)はそのバイトを
            // そのまま dpcm_data の番号にするので o0 c=0 … o0 b=11、o1 c=16、o2 c=32(実ppmckcの出力で確認、
            // 2026-09-19)。c-/b+ のオクターブまたぎも本家と同じに繰り上げ/繰り下げる。
            // 内部表現は n<num> と同じ「noteNumber = DPCM_NOTE_BASE + 番号」
            let semi = NOTE_SEMITONES[tok.name] + tok.accidental, oct = state.octave;
            while (semi < 0) { semi += 12; oct--; }
            while (semi > 11) { semi -= 12; oct++; }
            noteNumber = DPCM_NOTE_BASE + Math.max(0, oct * 16 + semi);
            freq = noteFrequency(noteNumber); // 「音符がある」印。DPCMに音高は無い
          } else if (tok.name !== 'r' && caps.noise) {
            // ノイズch: 半音番号(c=0…b=11、c-=11/b+=0で巡回)がそのまま周期index。オクターブ・Kは
            // 無視(本家ppmck frequency_set は音階データの下位4bitしか見ない)。12-15は n12〜n15
            noteNumber = noisePeriodIndex(NOTE_SEMITONES[tok.name] + tok.accidental);
            freq = noiseLfsrRate(noteNumber);
          } else if (tok.name !== 'r') {
            noteNumber = state.octave * 12 + NOTE_SEMITONES[tok.name] + tok.accidental + state.transpose;
            freq = noteFrequency(noteNumber);
          }
          recordNote('note', tok, frames, noteNumber,
            segments.length > 0 && segments[segments.length - 1].tieNext,
            freq != null && state.pendingPitchShift && caps.psAllowed);
          pushNote(frames, freq, noteNumber, tok.srcStart, tok.srcEnd);
          break;
        }
        case 'directNote': {
          let frames;
          if (tok.forcedFrames != null) {
            frames = tok.forcedFrames;
          } else {
            const lenResult = framesForLength(tok.length, tok.dots, state.defaultLength, tempo, lengthCarry);
            frames = lenResult.frames;
            lengthCarry = lenResult.carryOut;
          }
          // n<num>: オクターブ2のCを0とした通し番号。ノイズchでは周期index 0-15 の直値(本家ppmck準拠)、
          // DPCMchでは @DPCM<num> の番号の直値(本家ppmck準拠。K は使えないので加算しない)
          let noteNumber, freq;
          if (caps.dpcm) {
            noteNumber = DPCM_NOTE_BASE + Math.max(0, tok.num);
            freq = noteFrequency(noteNumber);
          } else if (caps.noise) {
            if ((tok.num < 0 || tok.num > 15) && !noiseWarned.directNote) {
              noiseWarned.directNote = true;
              warnings.push({ srcStart: tok.srcStart, message: T('ノイズchの n<num> は周期index 0〜15 です(n{v} は 16 で巡回して n{w} として鳴らします)', { v: tok.num, w: noisePeriodIndex(tok.num) }) });
            }
            noteNumber = noisePeriodIndex(tok.num);
            freq = noiseLfsrRate(noteNumber);
          } else {
            noteNumber = tok.num + 24 + state.transpose;
            freq = noteFrequency(noteNumber);
          }
          recordNote('note', tok, frames, noteNumber,
            segments.length > 0 && segments[segments.length - 1].tieNext,
            state.pendingPitchShift && caps.psAllowed);
          pushNote(frames, freq, noteNumber, tok.srcStart, tok.srcEnd);
          break;
        }
        // @n<num>[,<len>] 直接周波数指定(本家ppmck _KEY)。音階テーブルを通さず、<num>を周期/周波数レジスタへ
        // そのまま書く(2A03/MMC5/ノイズは下位11bit、VRC6/FME7/FDSは12bit。本家 datamake.c の MCK_DIRECT_FREQ と
        // 同じマスク。FDSだけは本家が11bitで切っているが、FDSの周波数レジスタは12bitで本家ドキュメントの表も
        // $800以上を載せているので12bitにする)。本家どおりVRC7・N163・DPCMでは使えない。
        // 本家準拠の意味論: D<n>は効かない / EP・MP(・本ツールのPT)は効く / &の先の音程は捨てて音長だけ足す。
        // ENは本ツールでは効かない(本家は@nの音をENのキーオン処理が直前の音階の音で上書きしてしまう不具合が
        // あるが、それは再現しない。警告を出す)。PSのグライド元/先にもならない
        case 'directFreq': {
          let frames;
          if (tok.forcedFrames != null) {
            frames = tok.forcedFrames;
          } else {
            const lenResult = framesForLength(tok.length, tok.dots, state.defaultLength, tempo, lengthCarry);
            frames = lenResult.frames;
            lengthCarry = lenResult.carryOut;
          }
          const df = caps.directFreq || null;
          let bad = null;
          if (!df) bad = T('@n(直接周波数指定)はこのチャンネルでは使えません(本家ppmck準拠: VRC7・N163・DPCMは不可)');
          else if (tok.value == null) bad = T('@n の後に周波数レジスタ値(数値)を書いてください(例: @n$1AB,4)');
          if (bad) {
            // 本家同様エラーにし、時間だけは消費する(以降のチャンネルのタイミングを崩さないため休符として扱う)
            if (!directFreqWarned.error) { directFreqWarned.error = true; errors.push({ message: bad }); }
            recordNote('note', tok, frames, null, false, false);
            pushNote(frames, null, null, tok.srcStart, tok.srcEnd);
            break;
          }
          const mask = (1 << df.bits) - 1;
          if (tok.value > mask && !directFreqWarned.range) {
            directFreqWarned.range = true;
            warnings.push({ srcStart: tok.srcStart, message: T('@n{v} は {chip} の周波数レジスタ({bits}bit)に収まらないので、下位{bits}bit({m})で鳴らします(本家ppmckと同じ)',
              { v: tok.value, chip: df.label, bits: df.bits, m: tok.value & mask }) });
          }
          if (state.noteEnv != null && state.noteEnv !== 255 && !directFreqWarned.en) {
            directFreqWarned.en = true;
            warnings.push({ srcStart: tok.srcStart, message: T('@n(直接周波数指定)の音符には EN(ノートエンベロープ)は効きません(周期値を直接書くため。EP/MPは効きます)') });
          }
          const period = tok.value & mask;
          let freq, noteNumber;
          if (df.kind === 'noise') {
            // ノイズ: 下位バイトがそのまま$400Eへ行く(bit7=短周期、下位4bit=周期index)。表示用の番号は周期index
            noteNumber = period & 0x0F;
            freq = noiseLfsrRate(noteNumber);
          } else {
            freq = directPeriodToHz(df.kind, period);
            // 表示用の代表ノート番号は o0c〜o9b(0〜119)に収める。NSFのバイトコードでもこの番号が音符バイトになり、
            // 2バイト形式の音符は 0x77(=119)までしか書けない(基点 0x78 以上は1バイト形式と衝突する。118/119 を書く曲は
            // ppmckDriver.js が基点を 0x78 にする。mckBytecode.js NOTE_BASE_DEFAULT 参照)。@n は音階表を引かないので、
            // ここが o9 でもドライバの表は広げない
            noteNumber = freq > 0 ? Math.max(0, Math.min(119, Math.round(57 + 12 * Math.log2(freq / 440)))) : 0;
          }
          recordNote('note', tok, frames, noteNumber,
            segments.length > 0 && segments[segments.length - 1].tieNext, false);
          pushNote(frames, freq, noteNumber, tok.srcStart, tok.srcEnd, period);
          break;
        }
        default:
          break;
      }
    }

    return {
      segments, notes, immediateWrites, loopFrame,
      startMarkerFrame, endMarkerFrame, startMarkerSrcRange, endMarkerSrcRange
    };
  }

  // セグメントのゲート長(フレーム数)を算出する。優先順位:
  //   @k<n>(キーオンからnフレーム、本ツール独自) > @q<n>(終端のnフレーム前) >
  //   q<rate>,<adjust>(実機ppmckc datamake.c calcGateTime と同じ式:
  //     gate = (dur*rate)/denom(整数除算=切り捨て) + adjust、dur超は dur、負は 0、
  //     dur>0 で gate<=0 なら 1)
  // k<len> で固定された keyOffAt があればそれ以下に切る。
  // NSF書き出し(src/nsf/mckBytecode.js)もこの関数(Mml.segmentGateFrames)を使う
  function computeGateFrames(seg, dur) {
    let g;
    if (seg.keyOnFrames > 0) g = Math.min(dur, seg.keyOnFrames);
    else if (seg.qFrames != null) g = Math.max(1, dur - seg.qFrames);
    else g = MML.Mml.ppmckGateFrames(dur, seg.gate == null ? 8 : seg.gate, seg.gateDenom || 8, seg.gateAdjust || 0);
    if (seg.keyOffAt != null) g = Math.min(g, seg.keyOffAt);
    return Math.max(1, Math.min(dur, g));
  }
  Mml.segmentGateFrames = computeGateFrames;
  Mml.ppmckGateFrames = function (dur, rate, denom, adjust) {
    let gate = Math.floor((dur * rate) / (denom || 8)) + (adjust | 0);
    if (gate > dur) gate = dur;
    else if (gate < 0) gate = 0;
    if (dur !== 0 && gate <= 0) gate = 1;
    return gate;
  };

  // ノートエンベロープ(EN)は「前回値からの相対値」の累積(cumulative)。
  // ループがあれば周回後もループ区間の合計を繰り返し足し込み、無ければ全体の合計で頭打ちにする。
  // (★本家ppmckcは「|」無しのテーブルにも末尾1値の前へループ点を差し込む(datamake.c checkLoop)
  //  ので、実機のENは末尾の差分を足し続ける。ENのこの「頭打ち」は本家と違う既知の差、2026-09-13確認。
  //  EPは同日に本家準拠へ直した: pitchEnvelopeValue参照)
  function cumulativeEnvelopeValue(table, tick) {
    const { values, loop } = table;
    if (values.length === 0) return 0;
    if (tick < values.length) {
      let sum = 0;
      for (let i = 0; i <= tick; i++) sum += values[i];
      return sum;
    }
    let full = 0;
    for (let i = 0; i < values.length; i++) full += values[i];
    if (loop == null || loop >= values.length) return full;
    let loopSum = 0;
    for (let i = loop; i < values.length; i++) loopSum += values[i];
    const loopLen = values.length - loop;
    const extra = tick - values.length + 1;
    const fullCycles = Math.floor(extra / loopLen);
    const remainder = extra % loopLen;
    let result = full + fullCycles * loopSum;
    for (let i = 0; i < remainder; i++) result += values[loop + i];
    return result;
  }

  // ソフトウェアビブラート(MP)の生レジスタ単位オフセット列。
  // ★2026-08-11(DESIGN-PITCH.md 別プロジェクトB): 以前は「delay後、四半周期=speedフレーム
  // でdepthに到達する対称三角波」という近似実装だった(内部除算ルーチンwarizanの詳細を
  // 追い切れていなかったため)。実ソース(nes_include/ppmck/sounddrv.h の lfo_sub /
  // warizan_start、AoiMoe/ppmck)を完全にトレースした結果、実機は滑らかな三角波ではなく
  // 「1フレームごとに±1、またはNフレームごとに±Sというカクカクした階段状の変化」を
  // フレーム単位のカウンタで刻む方式だと判明したため、近似式をやめてその状態遷移を
  // そのまま1フレーム=1ステップで再現する(音量エンベロープのstepEnvelopeと同じ発想)。
  //
  // 実機の対応(lfo_set_sub): mp.delay→lfo_start_time(遅延フレーム数)、
  // mp.speed→lfo_reverse_time(LFO周期の1/4)、mp.depth→lfo_depth(warizan_start前の
  // 生のY軸ピーク指定)。
  //
  // warizan_start(lfo_setで1回だけ実行): 「1/4周期」と「Y軸ピーク」の大小関係で、
  // (a) 1/4周期の方が大きい(傾き<1): 単位ステップ=1、(1/4周期)/(Yピーク)フレームごとに
  //     変化させる、(b) Yピークの方が大きい(傾き>1): 1フレームごとに(Yピーク)/(1/4周期)
  //     ぶん変化させる、(c) 等しければ1フレームごとに±1、の3通り。除算はwarizan
  //     (.quotient += floor(a/.divisor)というコメントだが、実際はA>=Mの間incして
  //     引き続けるbcs/bccループのため、割り切れない場合は実質ceil(a/b)を返す。実測
  //     トレース済み: 10/3→4=ceil、9/3→3=floor=ceil(割り切れる場合は一致))。
  function ceilDivPpmck(a, b) {
    if (a === b) return 1; // warizan_startの.plus_one分岐(1/4周期とYピークが等しい場合)
    let q = 0, rem = a;
    while (rem > 0) { q++; rem -= b; }
    return q;
  }

  // periodFnが周波数の増加関数か減少関数かを実測判定する(ppmck実機のfreq_vector_table相当。
  // MPのdepthは符号無しのため、実機は音源チップごとに「周期レジスタ(値が下がるほど音程が
  // 上がる: 2A03/VRC6/MMC5/FME7)」か「周波数レジスタ(値が上がるほど音程が上がる: FDS/N163)」
  // かを引いて最初の変化方向を決める(PITCH_CORRECTIONモード、lfo_initial_vector)。
  // どちらの場合も結果は「最初のクォーター周期で音程が上がる」で共通になるため、実機の
  // 固定テーブルを持たずperiodFn自身の単調増減を実測して同じ効果を得る。
  function periodFnIncreasing(periodFn) {
    return periodFn(2000) > periodFn(200);
  }
  // ★MMLのD<n>/EP/PTの値は全音源「正=音程が上がる」(2026-09-14統一。本家ppmckの
  // #PITCH-CORRECTION相当を常時適用したのと同じ向き)。レジスタへ足す向きはチップで違い、
  // 周期レジスタ系(2A03パルス/三角/ノイズindex・VRC6・MMC5・FME7)は値が減ると音程が上がるので
  // -1、周波数レジスタ系(FDS・N163、VRC7のfnum)は+1。MP(vibratoSequence)は以前から
  // periodFnIncreasingで「最初に上がる」向きに正規化済みなので対象外。
  // NSF書き出し側は ppmckDriver.js APPLY_DETUNE が PITCH_DIR_TABLE(CHTYPE別)で同じ符号を付ける
  function pitchRegDir(periodFn) { return periodFnIncreasing(periodFn) ? 1 : -1; }
  // 周期レジスタ系チップの無変調ノートでD<n>をレジスタへ足す値(符号反転)
  function periodRegDetune(seg) { return -(seg.detune || 0); }

  // lfo_sub本体の忠実移植。1音符ぶん(dur フレーム)を一度に状態遷移させ、フレーム毎の
  // オフセット値配列を返す(stepEnvelopeの事前計算版と同じ考え方)。direction(+1/-1)は
  // periodFnIncreasing(あるいはノイズ等periodFnが無いチャンネルでは固定値)で決める。
  function vibratoSequence(mp, dur, direction) {
    if (!mp || dur <= 0) return null;
    const delay = Math.max(0, mp.delay || 0);
    const quarter = Math.max(1, mp.speed || 1);   // lfo_reverse_time(1/4周期)
    const rawDepth = Math.max(1, mp.depth || 1);  // lfo_depth(warizan_start前)

    let stepSize, stepInterval;
    if (quarter === rawDepth) { stepSize = 1; stepInterval = 1; }
    else if (quarter > rawDepth) { stepInterval = ceilDivPpmck(quarter, rawDepth); stepSize = 1; }
    else { stepSize = ceilDivPpmck(rawDepth, quarter); stepInterval = 1; }

    const seq = new Array(dur);
    let startCounter = delay;          // lfo_start_counter
    let reverseCounter = quarter;      // effect_init: reverse_time初期値のまま開始
    let adcSbcCounter = stepInterval;  // effect_init: adc_sbc_time初期値のまま開始
    let dir = direction;
    let value = 0;

    for (let t = 0; t < dur; t++) {
      if (startCounter > 0) { startCounter--; seq[t] = value; continue; } // 遅延中(dec;rts相当)
      // 反転判定: 2×quarterごとに反転(asl/cmp/lsrの実質。lfo_sub参照)
      if (reverseCounter === quarter * 2) { reverseCounter = 0; dir = -dir; }
      // 変分処理: stepIntervalごとにstepSizeぶん加減算
      if (adcSbcCounter === stepInterval) { adcSbcCounter = 0; value += dir * stepSize; }
      reverseCounter++;
      adcSbcCounter++;
      seq[t] = value;
    }
    return seq;
  }

  // ポルタメント(単調な直線グライド、DESIGN-PITCH.md 別プロジェクトC)。MPのwarizan_start
  // (delay無し・反転無しの片道版)と全く同じアルゴリズム(src/convert/pitch.jsの
  // simulatePortamento/fitPortamentoが可逆性を検査する時に使うのと同一実装。共有しない
  // 理由はP-3参照)。delay経過後、target(0からの目標オフセット)へdurationフレームで
  // 到達し、以降は最終値を永久ホールドする(vibratoSequenceの事前計算方式と同じ発想)。
  // 1ステップの増減量(符号付き、dir込み)と間隔。NSF書き出し(mckBytecode.js serialize)も
  // この関数で前計算した値を0xF9のパラメータとして置き、6502側は足すだけにする(2026-09-19。
  // 以前は6502側がtargetからCEILDIVしており、|target|>255 や target=0 で除数0の無限ループに
  // なってドライバが止まっていた)ので、ブラウザ再生とNSFで式が食い違うことは無い
  function portamentoStepParams(pt) {
    const duration = Math.max(1, pt.duration || 1);
    const target = pt.target || 0;
    const absTarget = Math.abs(target);
    const dir = target < 0 ? -1 : 1;
    let stepSize, stepInterval;
    if (absTarget === 0) { stepSize = 0; stepInterval = 1; }
    else if (duration === absTarget) { stepSize = 1; stepInterval = 1; }
    else if (duration > absTarget) { stepInterval = ceilDivPpmck(duration, absTarget); stepSize = 1; }
    else { stepSize = ceilDivPpmck(absTarget, duration); stepInterval = 1; }
    return { step: dir * stepSize, stepInterval };
  }
  Mml.portamentoStepParams = portamentoStepParams;

  function portamentoSequence(pt, dur) {
    if (!pt || dur <= 0) return null;
    const delay = Math.max(0, pt.delay || 0);
    const duration = Math.max(1, pt.duration || 1);
    const { step, stepInterval } = portamentoStepParams(pt);

    const seq = new Array(dur);
    let value = 0, counter = stepInterval, remaining = duration;
    for (let t = 0; t < dur; t++) {
      if (t < delay) { seq[t] = 0; continue; }
      if (remaining > 0) {
        if (counter === stepInterval) { counter = 0; value += step; }
        counter++;
        remaining--;
      }
      seq[t] = value;
    }
    return seq;
  }

  // セグメントに音程変調(EN/EP/MP/ポルタメント)が何か効いているかどうか。
  // sweep(s<n0>,<n1>)はここに含まない: 実機ppmckのCMD_SWEEPはソフトウェア効果ではなく
  // 2A03パルスの実ハードウェアスイープユニット($4001/$4005)へバイトを1回書くだけの
  // 機能だと判明したため、フレームごとの再計算パイプラインからは分離した
  // (sweepRegisterByte/2A03パルスの書き込み箇所を参照)
  function hasPitchModulation(seg) {
    return (seg.noteEnv != null && seg.noteEnv !== 255) ||
      (seg.pitchEnv != null && seg.pitchEnv !== 255) ||
      (seg.vibrato != null && seg.vibrato !== 255) ||
      seg.portamento != null ||
      seg.psGlide != null ||
      (seg.pitchBreaks != null && seg.pitchBreaks.length > 0);
  }

  // PS(ポルタメント、実機準拠): 実ソース(nes_include/ppmck/sounddrv.hのprocess_ps/
  // pitchshift_setup、AoiMoe/ppmck)をトレースして移植。oldReg(直前の音のレジスタ値)と
  // newReg(このセグメント本来のレジスタ値)の差分を、b_div方式のceil除算で求めた
  // 「歩幅(addfreq)・間隔(step)」で埋めていく階段状のグライド。newReg基準のオフセット列
  // (pitchRegisterOffsetの他の効果と加算合成できる形)で返す。
  // ★実機は最初の1サイクルだけ間隔にstepではなくdurationそのものを使う(結果、
  // グライドが音符の終盤〜次の音符に食い込むことがある)独特の挙動があり、これが
  // ppmck公式リファレンスの「PSコマンド後の音程は正確ではない」という注記の原因と
  // 見られるが、本実装は音符の時間内で目標へ収束する分かりやすい近似(t=0で即座に
  // 最初の1歩を踏む)を採用する(意図的な簡略化。実機の1サイクル目のみの特殊なずれ
  // 自体は移植しない)。★カデンス判定は「counter===stepなら発火」というPT(portamentoSequence)
  // と同一の等値判定にすること。counter--してから0以下判定する減算方式だと、
  // stepが大きい(傾きが緩やかな)グライドでt=0での発火有無がPT/6502側のPS_STEP
  // (PTと同じ等値判定を移植したもの)とズレ、実機さながらの6502エミュレータ検証で
  // 実測乖離が見つかった(2026-08-13)
  // dur: 歩幅/間隔の計算に使う長さ(PS直後の音符の最初の区切りまでのフレーム数=
  // 最初の音長チャンク)。totalDur(省略時=dur): 実際に生成するフレーム数。ceil除算のため
  // diff*stepがdurを超えて目標到達がdurより後ろへ食い込むことがあり、その場合も6502の
  // PS_STEP(次のノートオンでクリアされるまで毎フレーム歩み続ける)と同じく、durを過ぎても
  // 到達まで刻み続ける(2026-08-16、q<n>/タイでdurが短くなるPSのために追加)
  function pitchShiftOffsetSequence(oldReg, newReg, dur, totalDur) {
    if (dur <= 0 || oldReg === newReg) return null;
    if (totalDur == null || totalDur < dur) totalDur = dur;
    const diff = Math.abs(newReg - oldReg);
    let addfreq, step;
    if (dur > diff) { addfreq = 1; step = ceilDivPpmck(dur, diff); }
    else { step = 1; addfreq = ceilDivPpmck(diff, dur); }
    const dir = newReg > oldReg ? 1 : -1;
    const seq = new Array(totalDur);
    let value = oldReg;
    let counter = step;
    for (let t = 0; t < totalDur; t++) {
      if (counter === step) {
        counter = 0;
        value += dir * addfreq;
        if ((dir > 0 && value > newReg) || (dir < 0 && value < newReg)) value = newReg;
      }
      counter++;
      seq[t] = value - newReg;
    }
    return seq;
  }

  // タイ(&)で異なる音程へレガートしたセグメントの、指定tick時点で有効な基準freq/
  // noteNumberを返す(アタック無しの音程切替。pushNoteのpitchBreaks参照)。
  // pitchBreaksが無ければセグメント本来のfreq/noteNumberをそのまま返す。
  function activePitchAt(seg, tick) {
    // directPeriod: @n(直接周波数指定)の音符の周期値。ピッチブレーク(SDの差し替え)の後は音階の音なので消える
    if (!seg.pitchBreaks || seg.pitchBreaks.length === 0) {
      return { freq: seg.freq, noteNumber: seg.noteNumber, directPeriod: seg.directPeriod };
    }
    let freq = seg.freq;
    let noteNumber = seg.noteNumber;
    let directPeriod = seg.directPeriod;
    for (const pb of seg.pitchBreaks) {
      if (pb.atFrame > tick) break;
      freq = pb.freq;
      noteNumber = pb.noteNumber;
      directPeriod = undefined;
    }
    return { freq, noteNumber, directPeriod };
  }

  // EN(ノートエンベロープ)は「発音ノート番号の値に加算」(ppmck公式リファレンス通り、
  // 半音・ノート番号空間、前回値からの相対値の累積)。この関数だけがノート番号空間を扱う。
  // ピッチエンベロープ(EP)の tick フレーム目のオフセット(周期/周波数レジスタへの生の加算量)。
  // 本家ppmck準拠の「毎フレームの差分の累積」(2026-09-13修正。以前は@v用stepEnvelopeを流用して
  // 「各フレームの絶対値」として読んでおり、実機と挙動が違っていた):
  //  ・実機 sound_pitch_enverope → pitch_sub → freq_add_mcknumber は、テーブルの1バイトを
  //    sound_freq_low/high(現在のレジスタ値)へそのまま加減算する。基準値へ戻すのは
  //    ノートオン時の frequency_set(oto_set)だけ。ノートオンのフレームも do_effect が同じ
  //    フレーム内で走るので tick0 から table[0] が効く(以前の実装と同じ起点)。
  //  ・「|」有り: ループ区間の差分を周回して足し続ける(合計0なら往復ベンド)。
  //  ・「|」無し: ppmckc の checkLoop が末尾1値の直前にループ点を差し込むため、実機は
  //    末尾の差分を毎フレーム足し続ける(= loop を values.length-1 と見なす)。
  //    「末尾を0で終える」のが本家流の止め方。ENのcumulativeEnvelopeValueの「頭打ち」とは
  //    ここが違う(そちらは本家と違う既知の差、上記コメント参照)。
  // NSF書き出し側(src/driver/ppmckDriver.js EP_LOOKUP)は同じ意味論の逐次加算版。
  function pitchEnvelopeValue(table, tick) {
    if (!table || table.values.length === 0) return 0;
    if (table.loop == null || table.loop >= table.values.length) {
      return cumulativeEnvelopeValue({ values: table.values, loop: table.values.length - 1 }, tick);
    }
    return cumulativeEnvelopeValue(table, tick);
  }
  Mml.pitchEnvelopeValue = pitchEnvelopeValue;

  function noteEnvelopeOffset(seg, envelopes, tick) {
    if (seg.noteEnv == null || seg.noteEnv === 255) return 0;
    const table = envelopes.en[seg.noteEnv];
    return table ? cumulativeEnvelopeValue(table, tick) : 0;
  }

  // PS(ポルタメント)音符でEP/MP/PT/ENを前の音から継続させるためのtickオフセット
  // (writePitchModulationのfxOffsets引数)。全て0=通常の音符(各効果をtick0から開始)
  const NO_FX_OFFSETS = Object.freeze({ ep: 0, mp: 0, pt: 0, en: 0 });

  // D<n>(デチューン)・EP(ピッチエンベロープ)・MP(ビブラート)は、実機ppmckドライバでは
  // 3つとも同一のサブルーチン(freq_add_mcknumber)を共有し、いずれも「発音周波数の値」
  // =周期/周波数レジスタへ書き込む直前の生の値へそのまま加算される(ppmck公式リファレンスの
  // D/EPの説明文言が一字一句同じ「発音周波数の値に加算されます」であることと、実ソース
  // (nes_include/ppmck/sounddrv.h)でsound_pitch_enverope・sound_lfoが共にfreq_add_mcknumber
  // を呼ぶことで確認済み。2026-08-10修正: 以前のEPは値/128を半音とみなしnoteFrequency()で
  // 再計算していたが、この換算は仕様に存在しない誤りだった)。
  // ここで4つ(D/EP/MP/ポルタメント)を合算してから、呼び出し側がapplyDetune相当の
  // クランプ済み加算を1回だけ行う。vibSeq/ptSeq: 呼び出し側がwritePitchModulation冒頭で
  // 1音符ぶん事前計算したvibratoSequence/portamentoSequence(未使用ならnull)。
  // tick索引で読むだけなので状態を持たない。
  // fx: fxOffsets(NO_FX_OFFSETS参照)。EPはtick+fx.ep、MP/PTは事前計算列の添字tick+fx.mp/
  // tick+fx.ptで参照する(PSでの効果継続用。psSeqだけはPS音符自身のグライドなので常にtick)
  // dir: pitchRegDir(periodFn)(+1/-1)。D/EP/PTのMML値(正=音程が上がる)をレジスタの向きへ直す。
  // MP(vibSeq)とPS(psSeq)は既にレジスタ空間の値なので掛けない
  function pitchRegisterOffset(seg, envelopes, tick, vibSeq, ptSeq, psSeq, fx, dir) {
    fx = fx || NO_FX_OFFSETS;
    dir = dir || 1;
    let offset = seg.detune || 0;
    if (seg.pitchEnv != null && seg.pitchEnv !== 255) {
      const table = envelopes.ep[seg.pitchEnv];
      // EP<n>,<delay>(2026-08-11 別プロジェクトA): delay経過前はテーブルへ触れず0のまま
      // (MPのvibratoSequenceのdelay処理・実機lfo_sub delay中rtsと同じ考え方)。delay経過後は
      // tickをdelayぶん巻き戻してテーブル先頭(index0)から辿る。
      const delay = seg.pitchEnvDelay || 0;
      const epTick = tick + fx.ep;
      // 累積(本家準拠、pitchEnvelopeValue参照)。delay消化後の最初のフレームが table[0]
      if (table && epTick >= delay) offset += pitchEnvelopeValue(table, epTick - delay);
    }
    offset *= dir; // D+EP をレジスタの向きへ(正=音程が上がる → 周期レジスタ系は減算)
    if (vibSeq) offset += vibSeq[tick + fx.mp];
    // SA<num>(N163専用): 本家仕様どおりD/EP/MPの合算値を<num>回左シフトする
    // (実機はdetune_plus_with_asl等の共通aslループ、sounddrv.h freq_add_mcknumber参照)。
    // PT/PS(当プロジェクト独自拡張)はレジスタ値から直接算出した全精度オフセットなので
    // シフト対象にしない。
    if (seg.pitchSa) offset *= (1 << seg.pitchSa);
    if (ptSeq) offset += dir * ptSeq[tick + fx.pt];
    if (psSeq) offset += psSeq[tick];
    return offset;
  }

  // 音程変調(EN/EP/MP/ポルタメント)ありのセグメントについて、フレームごとに周期/周波数
  // レジスタを再計算し、前フレームと値が変わったときだけ書き込む(無変調時の1回書きより
  // 負荷は高いが、総フレーム数は曲の長さ相当なので実用上問題にならない)。
  // periodFn: 基準Hz -> 変調前の周期/周波数レジスタ値。max: applyDetune相当のクランプ上限。
  // writeFn(frame, value): そのフレームの周期/周波数レジスタ書き込みをwriteLogへpushする
  // コールバック(チップごとにアドレス・バイト配置が異なるため、書き込み自体は
  // 呼び出し側に委ねる。writeVolumeEnvelopeと同じ設計)
  // fxOffsets(省略可): PS(ポルタメント)音符でEP/MP/PT/ENを前の音から継続させる場合の
  // 各効果のtickオフセット(=この音符の先頭が各効果のtick何番目にあたるか。NO_FX_OFFSETS
  // 参照)。MP/PTの事前計算列はオフセット分だけ長く求めておき、添字をずらして読む。
  // fx.psDurが渡されればPSグライド自身の傾き計算に使う(gateFrames等からの最初の区切りまで)
  function writePitchModulation(writeLog, startFrame, dur, seg, envelopes, periodFn, max, writeFn, fxOffsets) {
    const fx = fxOffsets || NO_FX_OFFSETS;
    const mpActive = seg.vibrato != null && seg.vibrato !== 255;
    const dir = pitchRegDir(periodFn);
    const vibSeq = mpActive
      ? vibratoSequence(envelopes.mp[seg.vibrato], dur + fx.mp, dir)
      : null;
    const ptSeq = seg.portamento ? portamentoSequence(seg.portamento, dur + fx.pt) : null;
    // PS(ポルタメント、実機準拠): oldReg(グライド元の音のレジスタ値)とnewReg(このセグメント
    // 本来のレジスタ値)を同じperiodFnで求め、その差分を段階的に埋めるオフセット列にする。
    // EN(ノートエンベロープ)継続中は、6502のRD_PITCHSHIFT(LOOKUP_*_PERIODがNOTE+ENVALで
    // 表を引く)と同じく、この時点(t=0)のENオフセットを足したノート番号でグライド元/先を
    // 求める(2026-08-16)。EN無しならfreqそのまま
    let psSeq = null;
    if (seg.psGlide) {
      const en0 = noteEnvelopeOffset(seg, envelopes, fx.en);
      const fromFreq = (en0 !== 0 && seg.psGlide.fromNoteNumber != null)
        ? noteFrequency(enTableNote(seg.psGlide.fromNoteNumber + en0)) : seg.psGlide.fromFreq;
      const toFreq = (en0 !== 0 && seg.noteNumber != null)
        ? noteFrequency(enTableNote(seg.noteNumber + en0)) : seg.freq;
      const oldReg = applyDetune(periodFn(fromFreq), 0, max);
      const newReg = applyDetune(periodFn(toFreq), 0, max);
      // グライドに使う長さは音符全体ではなく最初の区切り(ゲートオフ/タイの音程切替)まで
      // (fx.psDur、q<n>や`PS e8 & f8`で短くなる)。ppmck本家(ppmckcがqを音符+休符に、
      // 異音程タイをスラー+音符に分割し、pitchshift_setupはPS直後の音符の音長で
      // step/addfreqを決める)およびNSF書き出しの6502ドライバ(バイトコードの最初の音長
      // チャンクをCNTに使う)と同じ(2026-08-16修正。以前は音符全体の長さで割っていたため
      // 傾きが食い違っていた)。区切りの後も到達まで刻み続け、到達後は目標値(オフセット0)を保持
      const glideDur = (fx.psDur != null) ? Math.min(dur, fx.psDur) : dur;
      psSeq = pitchShiftOffsetSequence(oldReg, newReg, glideDur, dur);
    }
    // SD(セルフディレイ)のピッチブレークだけは実機ppmckが「ノートオン」として出力する
    // (ppmckc datamake.c putReleaseEffect → putAsm(fp, note))ため、そのフレームでは
    // 値が前フレームと同じでも必ず書き、writeFnへ第3引数attack=trueを渡して
    // 「上位バイト(書込みで位相/カウンタがリセットされる側)の書込み抑止をバイパスして
    // 打ち直す」よう指示する。タイ(&)のピッチブレーク(attack無し)は従来どおり
    // アタックを伴わないレガートのまま
    const attackFrames = (seg.pitchBreaks && seg.pitchBreaks.some(pb => pb.attack))
      ? new Set(seg.pitchBreaks.filter(pb => pb.attack).map(pb => pb.atFrame))
      : null;
    let last = null;
    for (let t = 0; t < dur; t++) {
      const { freq: baseFreq, noteNumber: baseNoteNumber, directPeriod } = activePitchAt(seg, t);
      const regOffset = pitchRegisterOffset(seg, envelopes, t, vibSeq, ptSeq, psSeq, fx, dir);
      let base;
      if (directPeriod != null) {
        // @n(直接周波数指定): 指定値にEP/MP/PTだけを足す(ENはノート番号空間の効果なので効かない。
        // 6502側も LOOKUP_*_PERIOD が DIRACT のとき ENVAL を足さずに指定値を返す)
        base = directPeriod;
      } else {
        const enOffset = noteEnvelopeOffset(seg, envelopes, t + fx.en);
        base = periodFn(enOffset === 0 ? baseFreq : noteFrequency(enTableNote(baseNoteNumber + enOffset)));
      }
      const value = applyDetune(base, regOffset, max);
      const attack = attackFrames != null && attackFrames.has(t);
      if (value !== last || attack) {
        writeFn(startFrame + t, value, attack);
        last = value;
      }
    }
  }

  // writePitchModulationのwriteFnが受け取るattackフラグを、実際に上位バイトを
  // 書き直す(=打ち直す)かどうかへ変換する。SM(スムース)が有効な音符では実機同様
  // 上位バイトの書込み自体を抑止するのがSMの役目なので、アタックでも書かない
  function attackWritesHi(seg, attack) {
    return !!attack && !seg.smooth;
  }

  function newWriteLog(totalFrames) {
    const writeLog = new Array(totalFrames);
    for (let f = 0; f < totalFrames; f++) writeLog[f] = [];
    return writeLog;
  }

  // 音量エンベロープテーブルを1フレーム1ステップで進めた値を返す。
  // loopが設定されていればそこへ周回し、無ければ末尾の値を保持し続ける。
  function stepEnvelope(table, tick) {
    const { values, loop } = table;
    if (values.length === 0) return 0;
    if (tick < values.length) return values[tick];
    if (loop != null && loop < values.length) {
      const loopLen = values.length - loop;
      return values[loop + ((tick - values.length) % loopLen)];
    }
    return values[values.length - 1];
  }

  // 音符の音量エンベロープ(@v<n>)とリリースエンベロープ(@vr<n>)のテーブルを解決する。
  // 全チップ共通(各チップの書き込みハンドラはここで得たvTable/vrTableをそのまま
  // writeVolumeEnvelopeへ渡す)。★2026-08-15、本家ppmck準拠のため2点修正:
  //  ・以前は「@vが設定されている音符」に限ってvrTableを引いていたが、実機の
  //    putReleaseEffect(ppmckc datamake.c)はリリース発動条件に@vの有無を見ない。
  //    v<n>固定音量の音符でも@vrが効くよう、ゲートON区間の音量を保持し続ける
  //    1要素テーブルを合成して同じ経路へ載せる(stepEnvelopeは末尾の値を保持する)
  //  ・本家の@vr<n>は@v<n>定義そのものへの参照(専用の@vr<n>={...}定義構文は本ツール
  //    独自の拡張)。@vr<n>の定義が無い場合は@v<n>の定義へフォールバックし、
  //    本家のMML(`@v1={...}` を定義して `@vr1` で参照する書き方)もそのまま読めるようにする
  function resolveEnvTables(seg, env) {
    const vTable = seg.envelopeV != null ? env.v[seg.envelopeV] : null;
    const vrTable = seg.envelopeVr !== 255
      ? ((env.vr && env.vr[seg.envelopeVr]) || env.v[seg.envelopeVr] || null)
      : null;
    // デューティ(音色)エンベロープ@@<n>/@@r<n>も、@v/@vrと同じく毎フレームの
    // 音量レジスタ書込み(デューティは音量と同じレジスタに同居する)で反映するため、
    // 音量側が固定でもフレーム単位ループへ載せる必要がある
    const { dutyTable, relDutyTable } = resolveDutyTables(seg, env);
    if (!vTable && (vrTable || dutyTable || relDutyTable)) {
      return { vTable: { values: [seg.volume], loop: null }, vrTable };
    }
    return { vTable, vrTable };
  }

  // @@<n>(デューティエンベロープ)/@@r<n>(リリース音色)のテーブルを解決する。
  // 実機ppmckでは音色バイトのbit7=0が「自作音色=@<n>={...}のテーブル番号」を意味し、
  // 1フレーム1ステップでデューティ値(0-7)が変化する(@v<n>の音色版)。
  // @@r<n>はゲートオフの瞬間に音色をそのテーブルへ差し替えるリリース版(255=OFF)。
  function resolveDutyTables(seg, env) {
    const duty = (env && env.duty) || {};
    return {
      dutyTable: seg.toneEnv != null ? (duty[seg.toneEnv] || null) : null,
      relDutyTable: (seg.releaseTone != null && seg.releaseTone !== 255)
        ? (duty[seg.releaseTone] || null) : null
    };
  }

  // 指定tickでのデューティ値。デューティエンベロープが無ければ固定値(fixedDuty)を返す。
  // ゲートオフ以降は@@r<n>のテーブルへ切り替わり、そのテーブルの先頭から進む
  // (@vrがゲートオフでtick0から再スタートするのと同じ)
  function dutyAt(seg, env, tick, gateFrames, fixedDuty) {
    const { dutyTable, relDutyTable } = resolveDutyTables(seg, env);
    if (relDutyTable && tick >= gateFrames) {
      return stepEnvelope(relDutyTable, tick - gateFrames);
    }
    if (dutyTable) return stepEnvelope(dutyTable, tick);
    return fixedDuty;
  }

  // ゲートON区間はvTable、ゲートOFF区間(あれば)はvrTableを1フレーム1ステップで
  // 進めながら、直前と異なる値のフレームでのみwriteFn(frame, vol, duty)を呼ぶ。
  // vrTableが無ければ従来通りゲートOFF時に1回だけ音量0で呼ぶ。
  // writeFnはそのフレームに必要なレジスタ書き込み(1個とは限らない。例:FME7は
  // アドレスラッチ+データの2書き込み)をwriteLog[frame]へ自分でpushする。
  // duty: @@<n>/@@r<n>(デューティエンベロープ)が有効なチップ用に、そのフレームの
  // デューティ値を第3引数で渡す(dutyOpt={env,fixedDuty}を渡した時のみ。デューティは
  // 音量と同じレジスタに同居するため、音量が変わらなくてもデューティが変われば書く)。
  // dutyOptを渡さないチップでは第3引数はundefinedで、writeFn側も従来通り無視する
  // volMax: 音量値の上限(省略時15)。FDS/VRC6のこぎり波だけは本家ppmck同様に音量が6bit
  // (0-63)なので63を渡す(datamake.cの_VOLUME範囲チェックがFMTRACK|VRC6SAWTRACKだけ0-63、
  // 他は0-15になっているのに合わせた。2026-08-24)
  function writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable, writeFn, seg, dutyOpt, volMax) {
    const vMax = volMax == null ? 15 : volMax;
    const dutyOf = dutyOpt
      ? (t) => dutyAt(seg, dutyOpt.env, t, gateFrames, dutyOpt.fixedDuty)
      : () => undefined;
    let lastVol = -1;
    let lastDuty;
    let dutyInit = false;
    for (let t = 0; t < gateFrames; t++) {
      const vol = Math.max(0, Math.min(vMax, stepEnvelope(vTable, t)));
      const duty = dutyOf(t);
      if (vol !== lastVol || !dutyInit || duty !== lastDuty) {
        writeFn(startFrame + t, vol, duty);
        lastVol = vol;
        lastDuty = duty;
        dutyInit = true;
      }
    }
    if (gateFrames < dur) {
      if (vrTable) {
        let lastRVol = -1;
        for (let t = gateFrames; t < dur; t++) {
          const vol = Math.max(0, Math.min(vMax, stepEnvelope(vrTable, t - gateFrames)));
          const duty = dutyOf(t);
          if (vol !== lastRVol || !dutyInit || duty !== lastDuty) {
            writeFn(startFrame + t, vol, duty);
            lastRVol = vol;
            lastDuty = duty;
            dutyInit = true;
          }
        }
      } else {
        writeFn(startFrame + gateFrames, 0, dutyOf(gateFrames));
      }
    }
  }

  // ===== PS(ポルタメント=キーオン無しのグライド、対応A/B/C)のセグメント間継続 =====
  // ppmck本家の実装(AoiMoe/ppmck internal.h `.pitchshift_command`→`pitchshift_setup`)は、
  // PSに続く音符の音程・音長を自前で読み取って`rts`し、通常のノートオン経路(effect_init=
  // ソフトエンベロープ/LFO/ピッチエンベロープ/アルペジオ等の再初期化+音量/デューティ書込み)
  // を一切通らない。つまりPS音符は「前の音がそのまま音程だけ滑って続く」もので、
  // @v/@vr/EP/MP/PT/ENの各効果はtickを止めずに継続する(NSF書き出し側ppmckDriver.jsの
  // RD_PITCHSHIFTも同じ設計)。★2026-08-16修正: 以前のブラウザ再生はPS音符を通常の
  // セグメントと同じくtick0から辿り直していた(=音程だけグライドしつつエンベロープは
  // 再アタック)ため、実機さながらの6502+APUエミュレータとの毎フレーム比較で
  // $4000(音量)/$4002(周期)が食い違っていた。
  //
  // 規則(6502ドライバと1:1に対応):
  //  ・PS音符自身は音量/デューティ/スイープを書かない(アタック無し)。
  //  ・@v/@vr/EP/MP/PT/ENは「直前の音符と選択が同じなら継続、違えば(=mckBytecode.jsが
  //    選択コマンドを出し直す条件と同じ)その効果だけPS音符の先頭でtick0から再スタート」。
  //    - @v: 前の音符がゲートONのままtick中だった時だけ継続(ゲートオフ/休符後は6502の
  //      ENVACT=0に対応して無音のまま。@vrリリース再生中ならリリースを継続)。
  //    - EP/MP/PT/EN: 休符を挟んでも6502側は毎フレーム進み続けるので、tick0を置いた
  //      フレーム(origin)からの経過フレーム数をオフセットとして継続する。
  //  ・PS音符自身がq<n>でゲートオフする時は通常の音符と同じ(@v+@vrならリリース開始、
  //    それ以外は無音)。
  //  ・@@<n>(デューティエンベロープ)はPS継続の対象外(意図的な既知の制限、下記
  //    writePsGlideVolumeのdutyOpt注記参照)。
  // 継続状態(psCarry)はチャンネルごとにセグメントループをまたいで保持する。
  function newPsCarry() {
    return {
      // 各効果のtick0が置かれたフレーム(継続時のオフセット=startFrame-origin)
      origin: { ep: 0, mp: 0, pt: 0, en: 0 },
      // 直前の音符セグメント(mckBytecode.jsの「前回と同じなら選択コマンドを出し直さない」
      // dedup判定と同じ比較相手。休符では更新しない)
      prevNote: null,
      // mckBytecode.jsのlastEnvIdx/lastVolModeと同じ追跡(@v選択コマンドが出るかの判定用)
      lastEnvIdx: null, lastVolMode: 'plain',
      // 音量側の状態機械(6502ドライバのENVACT/ENVTICK/RELPLAY/RELTICKに対応):
      //  mode 'plain'=固定音量を保持中(ENVACT=0) / 'silent'=ゲートオフ・休符後の無音 /
      //  'env'=@vがtick中(tick=直前フレームで書いたtick番号) / 'rel'=@vrリリース再生中
      vol: { mode: 'silent', tick: 0, table: null, relTick: 0, vrTable: null }
    };
  }

  function portamentoKey(seg) {
    const pt = seg.portamento || null;
    return pt ? `${pt.target},${pt.duration},${pt.delay || 0}` : ',0,0';
  }

  // PS音符segについて、EP/MP/PT/ENそれぞれの「選択が直前の音符から変わったか」を
  // mckBytecode.jsの出力条件と同じ比較で判定し、変わった効果はoriginをこの音符の先頭へ
  // 置き直す(6502側は選択ハンドラRD_PITCHENV/RD_VIBRATO/RD_PORTAMENTO/RD_NOTEENVが
  // 状態を再初期化する)。返り値はwritePitchModulationへ渡すfxOffsets
  function psGlideFxOffsets(carry, seg, startFrame) {
    const prev = carry.prevNote;
    const epDelay = (s) => (s.pitchEnv === 255 ? 0 : Math.max(0, Math.min(255, s.pitchEnvDelay || 0)));
    const epChanged = seg.pitchEnv != null &&
      (prev == null || seg.pitchEnv !== prev.pitchEnv || epDelay(seg) !== epDelay(prev));
    const mpChanged = seg.vibrato != null && (prev == null || seg.vibrato !== prev.vibrato);
    const ptChanged = prev == null || portamentoKey(seg) !== portamentoKey(prev);
    const enChanged = seg.noteEnv != null && (prev == null || seg.noteEnv !== prev.noteEnv);
    if (epChanged) carry.origin.ep = startFrame;
    if (mpChanged) carry.origin.mp = startFrame;
    if (ptChanged) carry.origin.pt = startFrame;
    if (enChanged) carry.origin.en = startFrame;
    return {
      ep: startFrame - carry.origin.ep,
      mp: startFrame - carry.origin.mp,
      pt: startFrame - carry.origin.pt,
      en: startFrame - carry.origin.en
    };
  }

  // 通常の音符(アタックあり)を処理した後の継続状態の更新。全効果のoriginをこの音符の
  // 先頭に置き、音量側の状態をゲート/エンベロープの結果に合わせる。
  // volTracked=false(三角波など@vを音量書込みに使わないチャンネル)ではmode 'env'/'rel'に
  // 入らない
  function psCarryAfterNote(carry, seg, startFrame, gateFrames, dur, vTable, vrTable, volTracked) {
    carry.origin.ep = carry.origin.mp = carry.origin.pt = carry.origin.en = startFrame;
    carry.prevNote = seg;
    if (vTable) { carry.lastEnvIdx = seg.envelopeV; carry.lastVolMode = 'env'; } else { carry.lastVolMode = 'plain'; }
    const v = carry.vol;
    if (gateFrames < dur) {
      if (volTracked && vTable && vrTable) {
        v.mode = 'rel'; v.vrTable = vrTable; v.relTick = dur - gateFrames - 1;
      } else {
        v.mode = 'silent';
      }
    } else if (volTracked && vTable && gateFrames > 0) {
      v.mode = 'env'; v.table = vTable; v.tick = gateFrames - 1;
    } else {
      v.mode = 'plain';
    }
  }

  // 独立した休符(r)の後: 6502のRD_RESTはENVACT/RELPLAYを0にして無音化する
  // (EP/MP/PT/ENは進み続けるのでoriginは触らない。prevNoteも音符専用なので不変)
  function psCarryAfterRest(carry) {
    carry.vol.mode = 'silent';
  }

  // PS音符の音量側(2A03パルスA/B用)。上記の規則どおり、直前の音符から継続している
  // @v/@vrをそのまま進めるか、@vの選択が変わった時だけtick0から再スタートする。
  // アタックの音量書込みは行わない。継続中の先頭フレーム(t=0)は値が変わらなくても
  // 1回書く(デューティが@<n>で変わっている可能性があるため。6502側は毎フレーム
  // WRITE_VOL_ONLYで書き直しているので値は常に一致する)。
  // ★dutyOpt(@@<n>デューティエンベロープ)は意図的にPS継続の対象外にしている: 実機は
  // duty tickをDUTYSEL($FF=未選択の番兵)という@vとは独立した第3の状態機械で管理し、
  // 休符で無効化された後は「実際のノートオン(RD_NOTE_BODYのTONEBASE再適用)」でしか
  // 再開しない(RD_PITCHSHIFTは一切タッチしない)という@vよりもさらに複雑な凍結規則を
  // 持つため、この修正のスコープ外として据え置く(PS音符のデューティは常にこの音符
  // 自身のtick0から辿り直す、既存のdutyAtをそのまま使う)。@v/@vr/EP/MP/PT/ENのみが
  // 継続対象(2026-08-16、既知の制限としてドキュメント化)
  // writeFn(frame, vol, duty)は通常のwriteVolumeEnvelopeと同じ規約(dutyOptを渡した時のみ
  // duty引数が意味を持つ)
  function writePsGlideVolume(writeLog, startFrame, gateFrames, dur, seg, vTable, vrTable, carry, writeFn, dutyOpt) {
    const v = carry.vol;
    const envSelEvent = !!vTable && (seg.envelopeV !== carry.lastEnvIdx || carry.lastVolMode !== 'env');
    const clampVol = (x) => Math.max(0, Math.min(15, x));
    const dutyOf = dutyOpt
      ? (t) => dutyAt(seg, dutyOpt.env, t, gateFrames, dutyOpt.fixedDuty)
      : () => undefined;
    let lastDuty;
    let dutyInit = false;
    const markDuty = (t) => { const d = dutyOf(t); const changed = !dutyInit || d !== lastDuty; lastDuty = d; dutyInit = true; return { duty: d, changed }; };
    if (gateFrames > 0) {
      if (v.mode === 'rel') {
        // @vrリリース再生中はそのまま継続(6502のRELPLAYはRD_PITCHSHIFTで止まらない。
        // 同時に@vが再選択されてもSERVICE_CHではリリース側の書込みが後勝ちする)
        let last = -1;
        for (let t = 0; t < gateFrames; t++) {
          const vol = clampVol(stepEnvelope(v.vrTable, v.relTick + 1 + t));
          const { duty, changed } = markDuty(t);
          if (t === 0 || vol !== last || changed) { writeFn(startFrame + t, vol, duty); last = vol; }
        }
        v.relTick += gateFrames;
      } else if (envSelEvent) {
        // @vの選択が変わった(6502のRD_VOLENVが再初期化する)→この音符の先頭からtick0
        let last = -1;
        for (let t = 0; t < gateFrames; t++) {
          const vol = clampVol(stepEnvelope(vTable, t));
          const { duty, changed } = markDuty(t);
          if (vol !== last || changed) { writeFn(startFrame + t, vol, duty); last = vol; }
        }
        v.mode = 'env'; v.table = vTable; v.tick = gateFrames - 1;
      } else if (v.mode === 'env' && vTable) {
        // 同じ@vが直前の音符からtick中→継続
        let last = -1;
        for (let t = 0; t < gateFrames; t++) {
          const vol = clampVol(stepEnvelope(vTable, v.tick + 1 + t));
          const { duty, changed } = markDuty(t);
          if (t === 0 || vol !== last || changed) { writeFn(startFrame + t, vol, duty); last = vol; }
        }
        v.table = vTable; v.tick += gateFrames;
      } else if (v.mode === 'env') {
        // @vがv<n>で解除された(6502のRD_VOLはENVACT=0にするだけで書き込まない)→
        // 直前の値を保持したまま止まる
        v.mode = 'plain';
      }
      // 'plain'/'silent': 何も書かない(6502側もVOL,Xを更新するだけで書き込まない)
    }
    if (gateFrames < dur) {
      if (vTable && vrTable) {
        let last = -1;
        for (let t = gateFrames; t < dur; t++) {
          const vol = clampVol(stepEnvelope(vrTable, t - gateFrames));
          const { duty, changed } = markDuty(t);
          if (vol !== last || changed) { writeFn(startFrame + t, vol, duty); last = vol; }
        }
        v.mode = 'rel'; v.vrTable = vrTable; v.relTick = dur - gateFrames - 1;
      } else {
        writeFn(startFrame + gateFrames, 0, dutyOf(gateFrames));
        v.mode = 'silent';
      }
    }
    carry.prevNote = seg;
    if (vTable) { carry.lastEnvIdx = seg.envelopeV; carry.lastVolMode = 'env'; } else { carry.lastVolMode = 'plain'; }
  }

  // --- 2A03 (A-D) ---
  function segmentsToWriteLog2A03(channel, segments, totalFrames, envelopes) {
    const base = CHANNEL_BASE[channel];
    const writeLog = newWriteLog(totalFrames);
    const env = envelopes || { v: {}, vr: {}, ep: {}, en: {}, mp: {} };

    // パルスチャンネルのスイープレジスタ($4001/$4005)はこのツールでは表現しないが、
    // 未書込のままだとAPU2A03のPulseChannelがデフォルト(negate=false, shift=0)のまま
    // になり、ハードウェア実機と同じ「スイープ無効時でもtarget=period*2>0x7FFで
    // ミュートされる」オーバーフロー判定バグ(period>=1024の低音全て)が働いてしまう。
    // 最初の音符が来るまでのデフォルトとして、negateビットだけ立てて回避する定石
    // ($4001=$08)を書いておく(誤ミュート防止のみ、スイープ自体は作動しない)。
    // 実際のs<n0>,<n1>によるスイープは音符ごとにsweepRegisterByte()で書き直す(下記)
    if (totalFrames > 0 && (channel === 'A' || channel === 'B')) {
      writeLog[0].push({ addr: base + 1, value: 0x08 });
    }

    // SM/SMOF(スムース、対応ABC): $4003/$4007/$400B(addr+3、上位バイト)への書込みは
    // 波形位相をリセットする副作用があり、通常は音符ごとに毎回書き直す(実機同様)。
    // SM有効中は「値が変化したときだけ書く」モードに切り替え、同オクターブ内で音符が
    // 切り替わるレガート passageのクリック音を消す(実機CMD_SMOOTH/EFF2_SMOOTH_ENABLE、
    // sound_data_writeを実測トレースして再現)。セグメントをまたいで直前値を保持する
    let smoothLastHi = -1;
    // PS(ポルタメント、対応A/B/C)のセグメント間継続状態(newPsCarryのコメント参照)
    const psCarry = newPsCarry();

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      const { vTable, vrTable } = resolveEnvTables(seg, env);
      // PS音符(キーオン無しのグライド)か。EP/MP/PT/ENの継続オフセットはここで確定する
      // (psGlideFxOffsetsがoriginも更新するため、音符ごとに1回だけ呼ぶ)。
      // psDur: グライドに使う長さ=この音符の最初の区切り(ゲートオフ、またはタイ(&)/SDの
      // pitchBreak)までのフレーム数(writePitchModulationのpsSeqコメント参照)
      const isPs = seg.freq != null && seg.psGlide != null;
      let fx = NO_FX_OFFSETS;
      if (isPs) {
        let psDur = gateFrames;
        if (seg.pitchBreaks) {
          for (const pb of seg.pitchBreaks) if (pb.atFrame > 0 && pb.atFrame < psDur) psDur = pb.atFrame;
        }
        // 音長バイトは1byteなので最初のチャンクは最大255フレーム(pushLengthの分割と同じ)
        psDur = Math.min(psDur, 255);
        fx = Object.assign(psGlideFxOffsets(psCarry, seg, startFrame), { psDur });
      }

      if (channel === 'A' || channel === 'B') {
        const duty = seg.instrument % 4;
        if (seg.freq != null) {
          // s<n0>,<n1>(スイープ)は実機ハードウェアスイープユニットへの生バイト書き込み
          // なので、EN/EP/MPの周期再計算パイプラインとは無関係に音符ごとへ一度だけ書く
          // (PS音符はアタック無しなので書かない=6502のRD_PITCHSHIFTと同じ)
          if (!isPs) writeLog[startFrame].push({ addr: base + 1, value: sweepRegisterByte(seg.sweepSpeed, seg.sweepDepth) });
          if (hasPitchModulation(seg)) {
            // $4003/$4007(addr+3)への書込みは実機で長さカウンタのロード+デューティ位相の
            // リセットを引き起こすため、値が変わっていなくても毎回書くと(EP/MPで周期が
            // 毎フレーム変わるたび)パルス波が意図せず打ち直され続けてしまう
            // (DESIGN-PITCH.md Phase 1で実測発覚)。上位バイトが実際に変わった時だけ書く。
            // SM有効時はセグメントをまたいでも前回値を引き継ぐ(smoothLastHi)
            let lastHi = seg.smooth ? smoothLastHi : -1;
            writePitchModulation(writeLog, startFrame, dur, seg, env, pulsePeriod, 0x7FF,
              (f, period, attack) => {
                writeLog[f].push({ addr: base + 2, value: period & 0xFF });
                const hi = (period >> 8) & 0x07;
                if (hi !== lastHi || attackWritesHi(seg, attack)) {
                  writeLog[f].push({ addr: base + 3, value: hi });
                  lastHi = hi;
                }
              }, fx);
            smoothLastHi = lastHi;
          } else {
            const period = applyDetune(segBasePeriod(seg, pulsePeriod), periodRegDetune(seg), 0x7FF);
            writeLog[startFrame].push({ addr: base + 2, value: period & 0xFF });
            const hi = (period >> 8) & 0x07;
            if (!seg.smooth || hi !== smoothLastHi) writeLog[startFrame].push({ addr: base + 3, value: hi });
            smoothLastHi = hi;
          }
          const volWrite = (f, vol, d) => writeLog[f].push({ addr: base + 0, value: ((d & 3) << 6) | 0x30 | vol });
          if (isPs) {
            writePsGlideVolume(writeLog, startFrame, gateFrames, dur, seg, vTable, vrTable, psCarry, volWrite,
              { env, fixedDuty: duty });
          } else if (vTable) {
            writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable, volWrite,
              seg, { env, fixedDuty: duty });
            psCarryAfterNote(psCarry, seg, startFrame, gateFrames, dur, vTable, vrTable, true);
          } else {
            writeLog[startFrame].push({ addr: base + 0, value: (duty << 6) | 0x30 | seg.volume });
            if (gateFrames < dur) {
              writeLog[startFrame + gateFrames].push({ addr: base + 0, value: (duty << 6) | 0x30 | 0 });
            }
            psCarryAfterNote(psCarry, seg, startFrame, gateFrames, dur, vTable, vrTable, true);
          }
        } else {
          writeLog[startFrame].push({ addr: base + 0, value: 0x30 });
          psCarryAfterRest(psCarry);
        }
      } else if (channel === 'C') {
        if (seg.freq != null) {
          if (hasPitchModulation(seg)) {
            // $400B(addr+3)への書込みは実機で線形カウンタのreload flagを立てる副作用があり、
            // 値が変わっていなくても毎回書くと(EP/MPで周期が毎フレーム変わるたび)三角波が
            // 意図せず打ち直され続けてしまう。上位バイトの値が実際に変わった時だけ書く
            // (下位バイト単体の書込みには副作用が無いため毎フレーム書いてよい)。
            // SM有効時はセグメントをまたいでも前回値を引き継ぐ(smoothLastHi)
            let lastHi = seg.smooth ? smoothLastHi : -1;
            writePitchModulation(writeLog, startFrame, dur, seg, env, trianglePeriod, 0x7FF,
              (f, period, attack) => {
                writeLog[f].push({ addr: base + 2, value: period & 0xFF });
                const hi = (period >> 8) & 0x07;
                if (hi !== lastHi || attackWritesHi(seg, attack)) {
                  writeLog[f].push({ addr: base + 3, value: hi });
                  lastHi = hi;
                }
              }, fx);
            smoothLastHi = lastHi;
          } else {
            const period = applyDetune(segBasePeriod(seg, trianglePeriod), periodRegDetune(seg), 0x7FF);
            writeLog[startFrame].push({ addr: base + 2, value: period & 0xFF });
            const hi = (period >> 8) & 0x07;
            if (!seg.smooth || hi !== smoothLastHi) writeLog[startFrame].push({ addr: base + 3, value: hi });
            smoothLastHi = hi;
          }
          if (isPs) {
            // 三角波のPS音符: アタック($4008)を書き直さない。自身のゲートオフだけ通常どおり
            if (gateFrames < dur) writeLog[startFrame + gateFrames].push({ addr: base + 0, value: 0x80 });
            psCarry.prevNote = seg;
            if (gateFrames < dur) psCarry.vol.mode = 'silent';
          } else {
            writeLog[startFrame].push({ addr: base + 0, value: seg.volume > 0 ? 0xFF : 0x80 });
            if (gateFrames < dur) {
              writeLog[startFrame + gateFrames].push({ addr: base + 0, value: 0x80 });
            }
            psCarryAfterNote(psCarry, seg, startFrame, gateFrames, dur, vTable, vrTable, false);
          }
        } else {
          writeLog[startFrame].push({ addr: base + 0, value: 0x80 });
          psCarryAfterRest(psCarry);
        }
      } else if (channel === 'D') {
        if (seg.freq != null) {
          // ノイズ(本家ppmck準拠、2026-09-18。noisePeriodIndex冒頭コメント/ppmck-noise-channel-spec):
          //   $400E = ((周期index + EN) & 15 − D − EP − MP − PT) & $FF | (@1 なら $80)
          // 本家ドライバはノイズにも他chと同じ freq_add_mcknumber で8bit加減算するだけなので、
          // D16 n0 → 0−16 = $F0 のように桁あふれで bit7(短周期)が立つ。wikiwiki.jp/mck の
          // 「短周期は D16〜D1、長周期は D0〜D-15」はこの挙動そのもので、そのまま鳴らす。
          // @1(本ツール独自)は bit7 を OR するだけ(桁あふれと両立)。bit6-4 は実機が無視する。
          // EN はノート空間なので index に足してから 16 で巡回(本家は12巡回で n12〜n15 が
          // 壊れるが、16段全部を使えるようにする=ユーザー決定)。
          // ★NSF書き出し側(ppmckDriver.js LOOKUP_NOISE_PERIOD/WFV_T3/WFO_T3)も同じ式。
          const modeBit = (seg.instrument & 1) ? 0x80 : 0;
          if (hasPitchModulation(seg) || seg.detune) {
            let lastVal = -1;
            // ノイズchは周期/周波数レジスタではなく離散indexなのでperiodFnが無く、
            // periodFnIncreasingによる方向自動判定ができない。index は小さいほど高い音なので
            // MP/D/EP/PT の向きは周期レジスタ系と同じ -1 固定(MML値は全音源「正=音程が上がる」、
            // pitchRegDir参照。本家の freq_vector_table もノイズ=$00=周期系で同じ向き)
            const mpActive = seg.vibrato != null && seg.vibrato !== 255;
            const vibSeq = mpActive ? vibratoSequence(env.mp[seg.vibrato], dur, -1) : null;
            // ポルタメントはtarget自体が符号付きなのでMPのような方向判定は不要
            const ptSeq = seg.portamento ? portamentoSequence(seg.portamento, dur) : null;
            for (let t = 0; t < dur; t++) {
              const { noteNumber: baseNoteNumber, directPeriod } = activePitchAt(seg, t);
              // @n(直接周波数指定)は下位バイトをそのまま使う(本家: $400E へ sound_freq_low を書くだけ。
              // bit7 が立っていれば短周期)。EN は効かない(writePitchModulation と同じ)
              const baseIdx = directPeriod != null ? (directPeriod & 0xFF)
                : noisePeriodIndex(baseNoteNumber + noteEnvelopeOffset(seg, env, t));
              const regOffset = pitchRegisterOffset(seg, env, t, vibSeq, ptSeq, null, null, -1);
              const val = ((baseIdx + Math.round(regOffset)) & 0xFF) | modeBit;
              if (val !== lastVal) {
                writeLog[startFrame + t].push({ addr: base + 2, value: val });
                writeLog[startFrame + t].push({ addr: base + 3, value: 0x00 });
                lastVal = val;
              }
            }
          } else {
            writeLog[startFrame].push({ addr: base + 2, value: (seg.directPeriod != null ? (seg.directPeriod & 0xFF) : noisePeriodIndex(seg.noteNumber)) | modeBit });
            writeLog[startFrame].push({ addr: base + 3, value: 0x00 });
          }
          if (vTable) {
            writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable,
              (f, vol) => writeLog[f].push({ addr: base + 0, value: 0x30 | vol }));
          } else {
            writeLog[startFrame].push({ addr: base + 0, value: 0x30 | seg.volume });
            if (gateFrames < dur) {
              writeLog[startFrame + gateFrames].push({ addr: base + 0, value: 0x30 });
            }
          }
        } else {
          writeLog[startFrame].push({ addr: base + 0, value: 0x30 });
        }
      }

      frame += dur;
    }

    return writeLog;
  }

  // --- VRC6 ---
  function segmentsToWriteLogVrc6(index, segments, totalFrames, envelopes) {
    const writeLog = newWriteLog(totalFrames);
    const env = envelopes || { v: {}, vr: {} };

    if (index === 0 || index === 1) {
      const base = index === 0 ? 0x9000 : 0xA000;
      let frame = 0;
      for (const seg of segments) {
        if (frame >= totalFrames) break;
        const startFrame = frame;
        const dur = Math.min(seg.durationFrames, totalFrames - frame);
        const gateFrames = computeGateFrames(seg, dur);
        // VRC6パルスのduty(bits4-6)は実機同様8段階(0-7)。@<n>のnをそのまま使う
        // (2A03/MMC5の4段階=n%4とは異なるチップ固有の範囲)。既定値7=約50%幅
        const duty = ((seg.instrument != null ? seg.instrument : 7) % 8) << 4;
        const { vTable, vrTable } = resolveEnvTables(seg, env);
        if (seg.freq != null) {
          if (hasPitchModulation(seg)) {
            // 上位バイト(enableビット込み)は*2mml抽出側でアタック合図として扱われるため
            // (nsf2mml/expansion/vrc6.js buildTimeline参照)、値が変わった時だけ書く
            // (2A03と同じ理由、DESIGN-PITCH.md Phase 1)。
            let lastHi = -1;
            writePitchModulation(writeLog, startFrame, dur, seg, env, vrc6PulsePeriod, 0xFFF,
              (f, period, attack) => {
                writeLog[f].push({ addr: base + 1, value: period & 0xFF });
                const hi = 0x80 | ((period >> 8) & 0x0F);
                if (hi !== lastHi || attackWritesHi(seg, attack)) {
                  writeLog[f].push({ addr: base + 2, value: hi });
                  lastHi = hi;
                }
              });
          } else {
            const period = applyDetune(segBasePeriod(seg, vrc6PulsePeriod), periodRegDetune(seg), 0xFFF);
            writeLog[startFrame].push({ addr: base + 1, value: period & 0xFF });
            writeLog[startFrame].push({ addr: base + 2, value: 0x80 | ((period >> 8) & 0x0F) });
          }
          if (vTable) {
            writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable,
              (f, vol, d) => writeLog[f].push({ addr: base + 0, value: ((d & 7) << 4) | vol }),
              seg, { env, fixedDuty: duty >> 4 });
          } else {
            writeLog[startFrame].push({ addr: base + 0, value: duty | seg.volume });
            if (gateFrames < dur) writeLog[startFrame + gateFrames].push({ addr: base + 0, value: duty });
          }
        } else {
          writeLog[startFrame].push({ addr: base + 0, value: duty });
        }
        frame += dur;
      }
    } else {
      let frame = 0;
      for (const seg of segments) {
        if (frame >= totalFrames) break;
        const startFrame = frame;
        const dur = Math.min(seg.durationFrames, totalFrames - frame);
        const gateFrames = computeGateFrames(seg, dur);
        const { vTable, vrTable } = resolveEnvTables(seg, env);
        if (seg.freq != null) {
          if (hasPitchModulation(seg)) {
            let lastHi = -1;
            writePitchModulation(writeLog, startFrame, dur, seg, env, sawPeriod, 0xFFF,
              (f, period, attack) => {
                writeLog[f].push({ addr: 0xB001, value: period & 0xFF });
                const hi = 0x80 | ((period >> 8) & 0x0F);
                if (hi !== lastHi || attackWritesHi(seg, attack)) {
                  writeLog[f].push({ addr: 0xB002, value: hi });
                  lastHi = hi;
                }
              });
          } else {
            const period = applyDetune(segBasePeriod(seg, sawPeriod), periodRegDetune(seg), 0xFFF);
            writeLog[startFrame].push({ addr: 0xB001, value: period & 0xFF });
            writeLog[startFrame].push({ addr: 0xB002, value: 0x80 | ((period >> 8) & 0x0F) });
          }
          if (vTable) {
            // 本家ppmck同様、音量(0-63)をそのまま蓄積レートへ書く(以前は0-15を4倍していた)。
            // 43以上は実機の8bitアキュムレータが桁溢れして鋸波が崩れるが、それも実機通り
            writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable,
              (f, vol) => writeLog[f].push({ addr: 0xB000, value: Math.min(63, vol) }),
              undefined, undefined, 63);
          } else {
            const accumRate = Math.min(63, seg.volume);
            writeLog[startFrame].push({ addr: 0xB000, value: accumRate });
            if (gateFrames < dur) writeLog[startFrame + gateFrames].push({ addr: 0xB000, value: 0 });
          }
        } else {
          writeLog[startFrame].push({ addr: 0xB000, value: 0 });
        }
        frame += dur;
      }
    }

    return writeLog;
  }

  // --- MMC5 ---
  function segmentsToWriteLogMmc5(index, segments, totalFrames, envelopes) {
    const writeLog = newWriteLog(totalFrames);
    const base = index === 0 ? 0x5000 : 0x5004;
    const env = envelopes || { v: {}, vr: {} };

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      const duty = seg.instrument % 4;
      const { vTable, vrTable } = resolveEnvTables(seg, env);
      if (seg.freq != null) {
        if (hasPitchModulation(seg)) {
          let lastHi = -1;
          writePitchModulation(writeLog, startFrame, dur, seg, env, pulsePeriod, 0x7FF,
            (f, period, attack) => {
              writeLog[f].push({ addr: base + 2, value: period & 0xFF });
              const hi = (period >> 8) & 0x07;
              if (hi !== lastHi || attackWritesHi(seg, attack)) {
                writeLog[f].push({ addr: base + 3, value: hi });
                lastHi = hi;
              }
            });
        } else {
          const period = applyDetune(segBasePeriod(seg, pulsePeriod), periodRegDetune(seg), 0x7FF);
          writeLog[startFrame].push({ addr: base + 2, value: period & 0xFF });
          writeLog[startFrame].push({ addr: base + 3, value: (period >> 8) & 0x07 });
        }
        if (vTable) {
          writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable,
            (f, vol, d) => writeLog[f].push({ addr: base + 0, value: ((d & 3) << 6) | 0x30 | vol }),
            seg, { env, fixedDuty: duty });
        } else {
          writeLog[startFrame].push({ addr: base + 0, value: (duty << 6) | 0x30 | seg.volume });
          if (gateFrames < dur) writeLog[startFrame + gateFrames].push({ addr: base + 0, value: (duty << 6) | 0x30 });
        }
      } else {
        writeLog[startFrame].push({ addr: base + 0, value: 0x30 });
      }
      frame += dur;
    }

    return writeLog;
  }

  function mmc5InitWrites() {
    return [{ addr: 0x5015, value: 0x03 }];
  }

  // --- FME-7 (Sunsoft 5B) ---
  // @<n>はppmck準拠のミキサー指定(0=ミュート/1=トーン(既定)/2=ノイズ/3=トーン+ノイズ)。
  // ミキサーレジスタ(R7)は3ch共有の1バイトなので、ここ(chごと)では書かず
  // fme7MixerWrites()が全chぶんをまとめて1本のタイムラインとして生成する。
  function fme7Mode(seg) {
    const m = seg.instrument == null ? 1 : seg.instrument;
    return m & 3;
  }

  function segmentsToWriteLogFme7(index, segments, totalFrames, envelopes) {
    const writeLog = newWriteLog(totalFrames);
    const env = envelopes || { v: {}, vr: {} };
    const periodRegLo = index * 2;
    const periodRegHi = index * 2 + 1;
    const volReg = 8 + index;

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      const mode = fme7Mode(seg);
      if (seg.freq != null && mode !== 0) {
        if (mode === 2) {
          // @2(ノイズ)はppmck仕様で「ノート番号(n0=o0c〜n31=o2g)がそのままノイズ周期」に
          // なる。トーン周期は書かない(ミキサーでトーンを切っているため無意味)
          writeLog[startFrame].push({ addr: 0xC000, value: 6 });
          // @n の音符はノート番号が周期からの逆算値(0〜119)なので、NSF書き出し(FME7_PREP: NOTE,X AND #$1F)と
          // 同じ値になるよう下位5bitを使う(@2 はトーンを鳴らさないので @n を書く意味は無いが、両者は揃える)
          // ★2026-09-19: 通常の音符も下位5bit(以前は0〜31へクランプしていたが、NSF は NOTE AND #$1F で、
          //   o2g+ 以上が JS では31、NSF では巡回した値になっていた。R6 は5bitレジスタなので実機もこちら)
          writeLog[startFrame].push({ addr: 0xE000, value: Math.round(seg.noteNumber) & 0x1F });
        } else {
          if (hasPitchModulation(seg)) {
            writePitchModulation(writeLog, startFrame, dur, seg, env, fme7Period, 0xFFF,
              (f, period) => {
                writeLog[f].push({ addr: 0xC000, value: periodRegLo });
                writeLog[f].push({ addr: 0xE000, value: period & 0xFF });
                writeLog[f].push({ addr: 0xC000, value: periodRegHi });
                writeLog[f].push({ addr: 0xE000, value: (period >> 8) & 0x0F });
              });
          } else {
            const period = applyDetune(segBasePeriod(seg, fme7Period), periodRegDetune(seg), 0xFFF);
            writeLog[startFrame].push({ addr: 0xC000, value: periodRegLo });
            writeLog[startFrame].push({ addr: 0xE000, value: period & 0xFF });
            writeLog[startFrame].push({ addr: 0xC000, value: periodRegHi });
            writeLog[startFrame].push({ addr: 0xE000, value: (period >> 8) & 0x0F });
          }
          // R6: ノイズ周期(3chで共有の1レジスタ。実機PSGも同様の制約)。
          // ppmckでは@2のときN<n>は無効(ノート番号が周期になるため)
          if (seg.fme7Noise != null) {
            writeLog[startFrame].push({ addr: 0xC000, value: 6 });
            writeLog[startFrame].push({ addr: 0xE000, value: seg.fme7Noise & 0x1F });
          }
        }
        const { vTable, vrTable } = resolveEnvTables(seg, env);
        if (seg.fme7EnvShape != null) {
          // R11/R12: エンベロープ周期(16bit), R13: 形状。この音符はハードウェアエンベロープ
          // 制御(音量レジスタのbit4=1)で鳴らす(Gimmick!ベース等のハードエンベロープ効果用)
          const period16 = seg.fme7EnvPeriod || 0;
          writeLog[startFrame].push({ addr: 0xC000, value: 11 });
          writeLog[startFrame].push({ addr: 0xE000, value: period16 & 0xFF });
          writeLog[startFrame].push({ addr: 0xC000, value: 12 });
          writeLog[startFrame].push({ addr: 0xE000, value: (period16 >> 8) & 0xFF });
          writeLog[startFrame].push({ addr: 0xC000, value: 13 });
          writeLog[startFrame].push({ addr: 0xE000, value: seg.fme7EnvShape & 0x0F });
          writeLog[startFrame].push({ addr: 0xC000, value: volReg });
          writeLog[startFrame].push({ addr: 0xE000, value: 0x10 });
          if (gateFrames < dur) {
            writeLog[startFrame + gateFrames].push({ addr: 0xC000, value: volReg });
            writeLog[startFrame + gateFrames].push({ addr: 0xE000, value: 0 });
          }
        } else if (vTable) {
          // ソフトウェア音量エンベロープ(@v<n>、AY自体の固定音量レジスタを1フレーム
          // ずつ書き換える。ハードウェアエンベロープ(S<n>/M<n>)とは別の仕組み)
          writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable, (f, vol) => {
            writeLog[f].push({ addr: 0xC000, value: volReg });
            writeLog[f].push({ addr: 0xE000, value: vol });
          });
        } else {
          writeLog[startFrame].push({ addr: 0xC000, value: volReg });
          writeLog[startFrame].push({ addr: 0xE000, value: seg.volume });
          if (gateFrames < dur) {
            writeLog[startFrame + gateFrames].push({ addr: 0xC000, value: volReg });
            writeLog[startFrame + gateFrames].push({ addr: 0xE000, value: 0 });
          }
        }
      } else {
        writeLog[startFrame].push({ addr: 0xC000, value: volReg });
        writeLog[startFrame].push({ addr: 0xE000, value: 0 });
      }
      frame += dur;
    }

    return writeLog;
  }

  // R7(ミキサー): bit0-2=トーン有効(0で有効), bit3-5=ノイズ有効(0で有効)。
  // 初期状態は全ch無音(全bit=1)にしておき、実際の有効化は音符ごとの@<n>から
  // fme7MixerWrites()が組み立てるタイムラインに任せる
  function fme7InitWrites() {
    return [{ addr: 0xC000, value: 7 }, { addr: 0xE000, value: 0x3F }];
  }

  // R7は3ch共有の1バイトなので、chごとのwriteLogから独立に書くと他chのビットを
  // 壊してしまう。ここで3ch分の@<n>(ミキサーモード)をフレーム単位に展開し、
  // 値が変化したフレームにだけR7書き込みを出す1本のタイムラインへまとめる。
  function fme7MixerWrites(letters, segmentsByChannel, totalFrames) {
    // 各chの「フレーム→モード(0-3)」。音符の無い(=まだ何も鳴らしていない)区間は
    // ミュート扱いにして、そのchのビットを立てたままにする
    const modeByFrame = letters.map(ch => {
      const arr = new Uint8Array(totalFrames);
      let frame = 0;
      for (const seg of (segmentsByChannel[ch] || [])) {
        const end = Math.min(totalFrames, frame + seg.durationFrames);
        const mode = seg.freq == null ? 0 : fme7Mode(seg);
        for (let f = frame; f < end; f++) arr[f] = mode;
        frame = end;
        if (frame >= totalFrames) break;
      }
      return arr;
    });

    const writes = [];
    let prev = -1;
    for (let f = 0; f < totalFrames; f++) {
      let mixer = 0x3F; // 全bit=1(トーン・ノイズとも無効)から必要な分だけ落とす
      for (let ch = 0; ch < modeByFrame.length; ch++) {
        const mode = modeByFrame[ch][f];
        if (mode & 1) mixer &= ~(1 << ch);        // トーン有効
        if (mode & 2) mixer &= ~(1 << (3 + ch));  // ノイズ有効
      }
      if (mixer !== prev) {
        writes.push({ frame: f, writes: [{ addr: 0xC000, value: 7 }, { addr: 0xE000, value: mixer }] });
        prev = mixer;
      }
    }
    return writes;
  }

  // --- FDS ---
  // @<n>(instrument, ppmck表記では"M/N"チャンネルの音色番号)で @FM<n> 波形を選択する。
  // FDSは波形メモリが1系統しか無く全ch共有のため(実機の制約)、選択している番号が
  // 前の音符から変わったときだけ64byteの波形を書き直す
  function fdsWaveLoadWrites(wave) {
    if (!wave || wave.length !== 64) return [];
    const writes = [{ addr: 0x4089, value: 0x80 }];
    for (let i = 0; i < 64; i++) writes.push({ addr: 0x4040 + i, value: wave[i] & 0x3F });
    writes.push({ addr: 0x4089, value: 0x00 });
    return writes;
  }

  function segmentsToWriteLogFds(segments, totalFrames, envelopes) {
    const writeLog = newWriteLog(totalFrames);
    const fm = (envelopes && envelopes.fm) || {};
    const env = envelopes || { v: {}, vr: {} };
    let lastInstrument = null;

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      if (seg.freq != null) {
        if (fm[seg.instrument] && seg.instrument !== lastInstrument) {
          writeLog[startFrame].push(...fdsWaveLoadWrites(fm[seg.instrument]));
          lastInstrument = seg.instrument;
        }
        let period;
        if (hasPitchModulation(seg)) {
          period = null;
          // $4083(addr+3相当)は*2mml抽出側でアタック合図として扱われる(bit7=disableの
          // 立ち下がり/立ち上がりで波形位相をリセットする実機仕様、nsf2mml/expansion/fds.js
          // 参照)ため、値が変わった時だけ書く(2A03と同じ理由)。
          let lastHi = -1;
          writePitchModulation(writeLog, startFrame, dur, seg, env, fdsFreqToPeriod, 0xFFF,
            (f, p, attack) => {
              period = p;
              writeLog[f].push({ addr: 0x4082, value: p & 0xFF });
              const hi = (p >> 8) & 0x0F;
              if (hi !== lastHi || attackWritesHi(seg, attack)) {
                writeLog[f].push({ addr: 0x4083, value: hi });
                lastHi = hi;
              }
            });
          if (period == null) period = applyDetune(segBasePeriod(seg, fdsFreqToPeriod), seg.detune, 0xFFF);
        } else {
          period = applyDetune(segBasePeriod(seg, fdsFreqToPeriod), seg.detune, 0xFFF);
          writeLog[startFrame].push({ addr: 0x4082, value: period & 0xFF });
          writeLog[startFrame].push({ addr: 0x4083, value: (period >> 8) & 0x0F });
        }
        const { vTable, vrTable } = resolveEnvTables(seg, env);
        if (vTable) {
          // 直接指定モード(bit7=1)のまま、@v<n>テーブルの値でゲインを1フレームずつ
          // 書き換える(FDSの実機ハードウェアエンベロープ(bit7=0)は使わない。あちらは
          // nsf2mml側の抽出でのみ使う独立した経路)
          writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable,
            (f, vol) => writeLog[f].push({ addr: 0x4080, value: 0x80 | Math.min(63, vol) }),
            undefined, undefined, 63);
        } else {
          const gain = Math.min(63, seg.volume);
          writeLog[startFrame].push({ addr: 0x4080, value: 0x80 | gain });
        }
        // @@r<n>(リリース音色): FDSの音色=波形メモリなので、ゲートオフの瞬間に
        // <n>番の波形をロードし直す。次の音符は自分の音色を必ず書き直せるよう
        // lastInstrumentもリリース音色へ更新しておく
        if (gateFrames < dur && seg.releaseTone !== 255 && fm[seg.releaseTone]) {
          writeLog[startFrame + gateFrames].push(...fdsWaveLoadWrites(fm[seg.releaseTone]));
          lastInstrument = seg.releaseTone;
        }
        // ゲートオフでチャンネルを無効化(bit7)する。ただしリリースエンベロープ(@vr)が
        // ある音符では無効化してしまうとリリースが一切聞こえないため書かない
        // (他チップと同じく、リリース区間はvrTableの音量で鳴らし切る)
        if (gateFrames < dur && !vrTable) {
          writeLog[startFrame + gateFrames].push({ addr: 0x4083, value: 0x80 | ((period >> 8) & 0x0F) });
        }
      } else {
        writeLog[startFrame].push({ addr: 0x4083, value: 0x80 });
      }
      frame += dur;
    }

    return writeLog;
  }

  function fdsDefaultWave() {
    const wave = new Array(64);
    for (let i = 0; i < 64; i++) {
      wave[i] = Math.round(31.5 + 31.5 * Math.sin((2 * Math.PI * i) / 64));
    }
    return wave;
  }

  function fdsInitWrites(customWave) {
    const wave = (customWave && customWave.length === 64) ? customWave : fdsDefaultWave();
    const writes = [];
    writes.push({ addr: 0x4089, value: 0x80 }); // 波形メモリ書き込み許可
    for (let i = 0; i < 64; i++) {
      writes.push({ addr: 0x4040 + i, value: wave[i] & 0x3F });
    }
    writes.push({ addr: 0x4089, value: 0x00 }); // 書き込み禁止・マスター音量フル
    return writes;
  }

  // --- N163 ---
  function n163DefaultWave() {
    return [0, 2, 4, 6, 8, 10, 12, 14, 15, 13, 11, 9, 7, 5, 3, 1];
  }

  // 実機の$4800書き込みはRAMへの「1バイト」書き込みで、波形読み出し側(+6=波形アドレス、
  // N163Audio._sample/resampleWave参照)は「1ニブル=4bitサンプル」単位でその領域を読む。
  // つまり書き込み側も2サンプルを1バイトに詰めて書く必要がある(以前は0-15の値をそのまま
  // 1バイト=1サンプルとして書いていたため、読み出し側は毎回上位ニブル=0を挟んで読んでしまい
  // 波形が[0,0,2,0,4,0,...]のように歯抜けに壊れていた)。waveは既にnormalizeN163Waveで
  // 実際に使う長さへ揃え済みなので、wave.length分だけ詰める。
  function n163PackWaveBytes(wave) {
    const bytes = [];
    for (let i = 0; i < wave.length; i += 2) {
      bytes.push((wave[i] & 0x0F) | ((wave[i + 1] & 0x0F) << 4));
    }
    return bytes;
  }

  function n163InitWrites(numN163Ch) {
    const num = Math.max(1, Math.min(N163_CHANNEL_COUNT, numN163Ch || N163_CHANNEL_COUNT));
    // 波形データの配置は共有アロケータ(MML.N163Alloc、segmentsToWriteLogN163内で使用)が
    // 曲の実際の使用状況に応じて動的に行うため、ここではchごとの専用スロットへの既定波形の
    // 事前書き込みは行わない(@N<n>を一度も呼ばないchは波形が不定になる既知の制限。
    // 予約領域を作らずRAM全体を共有プールにする、というユーザー確認済みの設計)。
    // $7F(内部アドレス、ゼロページではなくポート経由)に有効ch数だけを設定する。
    return [
      { addr: 0xF800, value: 0x7F | 0x80 },
      { addr: 0x4800, value: (num - 1) << 4 }
    ];
  }

  // @<n>(instrument)で @N<n> 波形を選択する。共有アロケータが割り当てたbyteOffsetは
  // chごとに固定ではなくなったため、波形本体だけでなく波形アドレス(+6、ニブル単位=
  // byteOffset*2)も毎回書き直す(以前は初期化時のみで不変という前提だったが、その前提は
  // もう成り立たない)。
  function n163WaveLoadWrites(wave, byteOffset, regBase) {
    if (!wave) return [];
    const packed = n163PackWaveBytes(wave);
    const writes = [{ addr: 0xF800, value: byteOffset | 0x80 }];
    for (const b of packed) writes.push({ addr: 0x4800, value: b });
    writes.push({ addr: 0xF800, value: (regBase + 6) | 0x80 });
    writes.push({ addr: 0x4800, value: byteOffset * 2 });
    return writes;
  }

  // occurrences: MML.N163Alloc.allocate()が返す配列全体(全N163ch分)。このch(ch文字)の
  // ものだけを開始フレームで引けるようにする
  function segmentsToWriteLogN163(ch, index, segments, totalFrames, envelopes, numN163Ch, occurrences) {
    const writeLog = newWriteLog(totalFrames);
    // 実機は内部8ch中「上位 num 個」だけを巡回・ミックスする。letters[index] の内部インデックスは
    // (8-num)+index(下位アドレス側から)。0番から詰めると鳴らないため必ずオフセットする。
    const num = Math.max(1, Math.min(N163_CHANNEL_COUNT, numN163Ch || N163_CHANNEL_COUNT));
    // 有効ch数(num)より上のレター(音符を1つも持たないch)は実機上の実体が無い。
    // 以前はここでregBase=0x80以上(内部RAMの範囲外)を算出し、休符の音量0書込み
    // ($F800=(regBase+7)|0x80)が下位7bitへ折り返って波形RAM($07/$0F/$17/$1F…)を
    // 上書き破壊していた(女神転生II 11曲目: 4ch使用曲のT-Wの休符が@N波形の末尾2サンプルを
    // 毎回0にし、ブラウザ再生の音色だけが崩れていた)。何も書かずに空のログを返す
    if (index >= num) return writeLog;
    const internalIdx = (N163_CHANNEL_COUNT - num) + index;
    const regBase = 0x40 + internalIdx * 8;
    const nMap = (envelopes && envelopes.n) || {};
    const env = envelopes || { v: {}, vr: {} };
    let lastInstrument = null;
    // @N<n>を一度も呼んでいない間の既定値(無難なフォールバック。実際に鳴らす場合は
    // 作曲者が必ず@<n>で切り替えるはずなので、この値が実際に使われることはまず無い)
    let currentLengthByte = 0xF0, currentRoundedLen = 16;
    const occByStart = new Map();
    for (const occ of (occurrences || [])) if (occ.channel === ch) occByStart.set(occ.startFrame, occ);
    // 最上位ch(internalIdx=7)の音量レジスタ(+7)は $7F で有効ch数ビット(4-6)と共用のため、
    // 音量を書くときも numCh ビットを保持する必要がある(他chの+7上位ビットは未使用)。
    const isTopCh = (regBase + 7) === 0x7F;
    const volByte = vol => (isTopCh ? ((num - 1) << 4) : 0) | (vol & 0x0F);

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      if (seg.freq != null) {
        if (nMap[seg.instrument] && seg.instrument !== lastInstrument) {
          const occ = occByStart.get(startFrame);
          if (occ) {
            currentRoundedLen = MML.N163Alloc.roundedLen(nMap[seg.instrument].length);
            currentLengthByte = occ.lengthByte;
            writeLog[startFrame].push(...n163WaveLoadWrites(
              normalizeN163Wave(nMap[seg.instrument], currentRoundedLen), occ.byteOffset, regBase));
          }
          // occが無い場合はRAM配置に失敗している(compiled.errorsにconflictとして記録済み・
          // 呼び出し元は既にコンパイルを中断しているはず)。書き込みは行わず現状維持に留める
          lastInstrument = seg.instrument;
        }
        // 周波数は実機のインターリーブ配置に従い +0/+2/+4 へ書く(間の位相バイト +1/+3 は
        // 触らない)。オートインクリメントに頼らずアドレスを都度選択する。波形長は +4 の上位に共用。
        const writeN163Freq = (f, freqReg) => {
          writeLog[f].push({ addr: 0xF800, value: (regBase + 0) });
          writeLog[f].push({ addr: 0x4800, value: freqReg & 0xFF });
          writeLog[f].push({ addr: 0xF800, value: (regBase + 2) });
          writeLog[f].push({ addr: 0x4800, value: (freqReg >> 8) & 0xFF });
          writeLog[f].push({ addr: 0xF800, value: (regBase + 4) });
          writeLog[f].push({ addr: 0x4800, value: currentLengthByte | ((freqReg >> 16) & 0x03) });
        };
        if (hasPitchModulation(seg)) {
          writePitchModulation(writeLog, startFrame, dur, seg, env,
            freq => n163FreqReg(freq, currentRoundedLen, num), 262143, writeN163Freq);
        } else {
          // 無変調ノートのD<n>もSA<num>のシフト対象(pitchRegisterOffset冒頭コメント参照)
          const detune = (seg.detune || 0) * (1 << (seg.pitchSa || 0));
          const freqReg = applyDetune(n163FreqReg(seg.freq, currentRoundedLen, num), detune, 262143);
          writeN163Freq(startFrame, freqReg);
        }
        const { vTable, vrTable } = resolveEnvTables(seg, env);
        if (vTable) {
          writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable, (f, vol) => {
            writeLog[f].push({ addr: 0xF800, value: (regBase + 7) | 0x80 });
            writeLog[f].push({ addr: 0x4800, value: volByte(vol) });
          });
        } else {
          writeLog[startFrame].push({ addr: 0xF800, value: (regBase + 7) | 0x80 });
          writeLog[startFrame].push({ addr: 0x4800, value: volByte(seg.volume) });
          if (gateFrames < dur) {
            writeLog[startFrame + gateFrames].push({ addr: 0xF800, value: (regBase + 7) | 0x80 });
            writeLog[startFrame + gateFrames].push({ addr: 0x4800, value: volByte(0) });
          }
        }
      } else {
        writeLog[startFrame].push({ addr: 0xF800, value: (regBase + 7) | 0x80 });
        writeLog[startFrame].push({ addr: 0x4800, value: volByte(0) });
      }
      frame += dur;
    }

    return writeLog;
  }

  // --- VRC7 ---
  function segmentsToWriteLogVrc7(index, segments, totalFrames, envelopes) {
    const writeLog = newWriteLog(totalFrames);
    const env = envelopes || { en: {} };
    const ch = index;

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      if (seg.freq != null) {
        const { fnum: baseFnum, block } = vrc7FreqToFnumBlock(seg.freq);
        // fnumは同一block内では周波数に比例するため、他チップと同じ生レジスタへの単純加算
        // オフセットでデチューンできる(0-511の9bit幅でクランプ、block自体は変えない)。
        // block境界をまたぐ本来のデチューン量が必要な場合でも、この曲の狭い範囲の
        // デチューン効果には影響しない程度の近似として十分(他チップのapplyDetuneも
        // 同様に単純クランプのみでキャリー処理はしていない)。
        const fnum = applyDetune(baseFnum, seg.detune, 511);
        const instrument = seg.instrument % 16;
        writeLog[startFrame].push({ addr: 0x9010, value: 0x10 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: fnum & 0xFF });
        // キーオン(bit4)はYM2413実機同様エッジトリガ(src/emulator/expansion/vrc7.js
        // slotOn: keyStatusが既に1のままだとエンベロープが再スタートしない)。前の音符が
        // レガート(ゲート=フル、無音区間なし)で直前まで鳴っていた場合、単にbit4=1を
        // 書くだけでは0→1の遷移が起きず、2音目以降が完全に無音になっていた
        // (Final Fantasy(MSX)で実測)。必ずキーオフを1回挟んでからキーオンを書き、
        // 前の状態に関わらずエッジを保証する。
        writeLog[startFrame].push({ addr: 0x9010, value: 0x20 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: (block << 1) | ((fnum >> 8) & 1) });
        writeLog[startFrame].push({ addr: 0x9010, value: 0x20 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: 0x10 | (block << 1) | ((fnum >> 8) & 1) });
        writeLog[startFrame].push({ addr: 0x9010, value: 0x30 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: (instrument << 4) | seg.volume });
        // EN(ノートエンベロープ)はノート番号空間なのでfnum/block両方に影響しうる
        // (ここだけ他チップと違いvrc7FreqToFnumBlock()でblockごと再計算する)。
        // D<n>/EP/MPはfnum/blockの対数的表現のため対象外(上のapplyDetuneのコメント通り、
        // このチップだけ既存のD<n>実装から一貫して除外している)。
        // キーオン後の再書き込みはkeyonビット(0x10)を立てたまま行い、エッジトリガを
        // 再発生させない(音符の頭でのみ発生させる、上の一連の書き込みと同じ理由)
        if (seg.noteEnv != null && seg.noteEnv !== 255) {
          const table = env.en[seg.noteEnv];
          if (table) {
            let lastFnum = fnum, lastBlock = block;
            for (let t = 1; t < gateFrames; t++) {
              const delta = cumulativeEnvelopeValue(table, t);
              // ★delta===0での早期skipは誤り(2026-08-14修正): 「累積オフセットが0」は
              // 「基準ノートへ戻る」という意味であり「値を変えなくてよい」という意味ではない。
              // 直前のtickで既に基準ノート以外(delta!=0)へ書き換わっていた場合、この行を
              // 素通りしてしまうと基準ノートへ戻す書込みが丸ごと欠落し、レジスタが直前の
              // 値のまま固まってしまう(実機6502ドライバとの往復比較で発覚、EN0={0 4 3 -7}の
              // ようなオフセット0を経由する周期パターンで実測)。「変化が無ければ書かない」
              // 判定は直後のf2===lastFnum&&b2===lastBlockチェックだけで十分かつ正しい。
              const { fnum: f2, block: b2 } = vrc7FreqToFnumBlock(noteFrequency(enTableNote(seg.noteNumber + delta)));
              if (f2 === lastFnum && b2 === lastBlock) continue;
              writeLog[startFrame + t].push({ addr: 0x9010, value: 0x10 + ch });
              writeLog[startFrame + t].push({ addr: 0x9030, value: f2 & 0xFF });
              writeLog[startFrame + t].push({ addr: 0x9010, value: 0x20 + ch });
              writeLog[startFrame + t].push({ addr: 0x9030, value: 0x10 | (b2 << 1) | ((f2 >> 8) & 1) });
              lastFnum = f2; lastBlock = b2;
            }
          }
        }
        if (gateFrames < dur) {
          // @@r<n>(リリース音色): VRC7の音色は$30+chの上位ニブル。ゲートオフの瞬間に
          // 差し替える(音量ニブルはそのまま。@v/@vrによる音量エンベロープ自体は
          // VRC7では未対応のため、実際に聞こえるのはキーオフ後の余韻部分になる)
          if (seg.releaseTone !== 255) {
            writeLog[startFrame + gateFrames].push({ addr: 0x9010, value: 0x30 + ch });
            writeLog[startFrame + gateFrames].push({ addr: 0x9030, value: ((seg.releaseTone % 16) << 4) | seg.volume });
          }
          writeLog[startFrame + gateFrames].push({ addr: 0x9010, value: 0x20 + ch });
          writeLog[startFrame + gateFrames].push({ addr: 0x9030, value: (block << 1) | ((fnum >> 8) & 1) });
        }
      } else {
        writeLog[startFrame].push({ addr: 0x9010, value: 0x20 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: 0 });
        writeLog[startFrame].push({ addr: 0x9010, value: 0x30 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: 0 });
      }
      frame += dur;
    }

    return writeLog;
  }

  // @OP<n>で定義した8バイトをVRC7のカスタム音色(パッチ0)レジスタ($00-$07)へロードする。
  // VRC7はカスタム音色スロットが1つしか無く全ch共有のため(FDS波形メモリ・N163共有波形と
  // 同様の制約)、曲開始時に一度だけ読み込む
  function vrc7InitWrites(bytes) {
    if (!bytes || bytes.length !== 8) return [];
    const writes = [];
    for (let i = 0; i < 8; i++) {
      writes.push({ addr: 0x9010, value: i });
      writes.push({ addr: 0x9030, value: bytes[i] & 0xFF });
    }
    return writes;
  }

  // @N<n>の波形値をtargetLen(共有アロケータが決めた、実機レジスタ丸め後の長さ)へ
  // 正規化する(不足はゼロ埋め、超過は切り詰め)。作曲者が書いた要素数がそのまま
  // 波形長になる仕様なので、以前のような固定16サンプルへの強制丸めはしない。
  function normalizeN163Wave(values, targetLen) {
    if (!values || values.length === 0) return null;
    const len = targetLen || values.length;
    const wave = values.slice(0, len);
    while (wave.length < len) wave.push(0);
    return wave;
  }

  // OP<n>(VRC7)/MH<n>(FDS)のような音符に紐付かない即時コマンドを、記録された
  // フレーム位置のwriteLogへ差し込む。resolverはimmediateWrite 1件から
  // { writes, frameOffset } (frameOffsetは省略可、delay等の追加オフセット用)を返す
  // prepend: そのフレームの音符側の書き込みより**前**へ差し込む。
  // ★VRC7のOP<n>(カスタム音色ロード)はこれが必須。同じフレームに音符の頭が来ると、
  //   末尾へ足す従来の動作では「キーオン → 音色ロード」の順になり、キーオンした時点の
  //   音色(リセット直後は全0=AR0=最も遅い立ち上がり)でエンベロープが走り出してしまう。
  //   実測(mod AR=15の音色): 1音目だけピーク0.0000=完全に無音、2音目以降は0.1304。
  //   実機のドライバも「音色をロードしてからキーオン」する順なので、そちらへ揃える。
  function spliceImmediateWrites(writeLog, immediateWrites, kind, totalFrames, resolver, prepend) {
    for (const iw of immediateWrites) {
      if (iw.kind !== kind) continue;
      const resolved = resolver(iw);
      if (!resolved || !resolved.writes || resolved.writes.length === 0) continue;
      const frame = Math.min(Math.max(0, iw.frame + (resolved.frameOffset || 0)), totalFrames - 1);
      writeLog[frame] = prepend
        ? [...resolved.writes, ...writeLog[frame]]
        : [...writeLog[frame], ...resolved.writes];
    }
  }

  function resolveVrc7ToneWrite(iw, envelopes) {
    if (iw.value === 255) return null; // OPOFに相当する明確な仕様が無いため何もしない
    const bytes = envelopes.op && envelopes.op[iw.value];
    return { writes: vrc7InitWrites(bytes) };
  }

  function resolveFdsModWrite(iw, envelopes) {
    if (iw.value === 255) {
      // MHOF: gain=0にするだけでなく$4087のbit7=1で変調ユニット自体を停止する
      // (実機Almana no Kisekiで実測: 常に[$4084=gain0, $4087=stop]の2本組で書かれる)。
      // 停止しないとカウンタ/テーブル位置が裏で回り続け、次にMH<n>で再開したとき
      // (直後に$4085リセットが無いような書き方をされた場合)想定と違う位相から
      // 再開してしまう
      return { writes: [{ addr: 0x4084, value: 0x80 }, { addr: 0x4087, value: 0x80 }] };
    }
    const mh = envelopes.mh && envelopes.mh[iw.value];
    if (!mh) return null;
    const wave = envelopes.mw && envelopes.mw[mh.waveform];
    const writes = [];
    writes.push({ addr: 0x4087, value: 0x80 }); // 一旦停止(テーブル書込み許可・書込位置リセット)
    // モジュレータカウンタを0にリセットする。実機の$4085直接設定書込みに相当し、
    // これが無いと前回のMH<n>で溜まったカウンタ値が残ったまま新しい変調に引き継がれ、
    // 意図しない偏った(非対称な)ピッチ変調になる(実測: Almana no Kisekiは
    // モジュレーション再ロードのたび必ず$4085=0を書いている)
    writes.push({ addr: 0x4085, value: 0 });
    if (wave) {
      for (let k = 0; k < 32; k++) writes.push({ addr: 0x4088, value: (wave[k] || 0) & 0x07 });
    }
    writes.push({ addr: 0x4086, value: (mh.freq || 0) & 0xFF });
    writes.push({ addr: 0x4087, value: ((mh.freq || 0) >> 8) & 0x0F }); // bit7=0で再開
    writes.push({ addr: 0x4084, value: 0x80 | ((mh.depth || 0) & 0x3F) });
    return { writes, frameOffset: mh.delay || 0 };
  }

  // --- DPCM ---
  // @DPCM<n>で解決済みのサンプルバイト列(dpcmSamples、opt.dpcmSamplesで実バイトが
  // 埋まったもの)を、DMCハードウェアが読める$C000-$FFFF(16KB=1ページ)へ64バイト境界で
  // 順に敷き詰め、$4010-4013相当のレジスタ値を計算する。16KBに収まらない分は次のページ
  // (2026-09-10、DPCMバンク切替): 再生側はトリガーの直前に $5FFC-$5FFF(窓4-7)を
  // そのページへ切り替える(NSFはドライバ、ブラウザ再生は buildDpcmBus の疑似書込み)。
  // 注意: 実機の$4013(サンプル長)は「(値×16)+1」バイトという奇妙な単位のため、
  // 元データの長さそのままでは割り切れないことが多い。ここでは元データ全体が
  // 必ず収まるよう切り上げて(元データより最大15バイト多く、末尾はゼロパディング)
  // レジスタ値を決める(データが途中で切れることはない)。
  // ブラウザ内プレビュー(player.js)用の仮想メモリ配置であり、実際のNSF書き出し時の
  // ROM配置(フェーズ1.7タスク4、$5FFC-$5FFFの専用バンク)とは別
  function layoutDpcmSamples(dpcmSamples) {
    const layout = {};
    let offset = 0; // ページ先頭($C000)からのオフセット(バイト)
    let page = 0;   // 16KBページ番号(0起点)
    // 同じファイル名の定義は1本のデータを共有する(本家ppmckc sortDPCM「音色のダブりを削除」と同じ)。
    // レート(freq)やDACだけ違う定義を並べてもROMは増えない。共有側は shared:true(bytes/addr は同じ)で、
    // ROMへ焼く側(ppmckDriver.js)とサイズ集計は shared を飛ばす
    const byFile = {};
    for (const idx of Object.keys(dpcmSamples)) {
      const def = dpcmSamples[idx];
      if (!def.bytes || def.bytes.length === 0) continue;
      if (byFile[def.file]) {
        const base = byFile[def.file];
        layout[idx] = { ...base, dac: (def.dac == null || def.dac === 255) ? null : (def.dac & 0x7F), shared: true };
        continue;
      }
      const rawLen = def.bytes.length;
      const lengthReg = Math.min(255, Math.max(0, Math.ceil((rawLen - 1) / 16)));
      const playLen = lengthReg * 16 + 1;
      if (offset % 64 !== 0) offset += 64 - (offset % 64);
      // 16KB(1ページ)に収まらなければ次のページへ。1本は最大4081バイトなので必ずどこかのページに
      // 収まる。ページを跨ぐ配置はしない(DMCは$C000-$FFFFを連続に読むため)
      if (offset + playLen > 0x4000) { page++; offset = 0; }
      const addr = 0xC000 + offset;
      layout[idx] = {
        addr,
        page,
        addrReg: offset >> 6,
        lengthReg,
        playLen,
        // dac===255(またはundefined)は「DAC値を変更しない」という実機ppmck driverの
        // 慣例(dpcm.hのskipラベル)に合わせ、$4011書き込み自体を省略する
        dac: (def.dac == null || def.dac === 255) ? null : (def.dac & 0x7F),
        // $4013(長さレジスタ)は8bitのため実機DMCはplayLenバイトまでしか読み出さない。
        // rawLenがplayLenを超える(=lengthRegが255で頭打ちになった)場合、元データを
        // そのまま保持するとここで確保した領域(offsetの増分もplayLen基準)を超えて
        // 書き込まれ、64KB仮想メモリ(src/audio/stream-player.js buildDpcmBus)の
        // 境界超過(RangeError)やNSF書き出し側(ppmckDriver.js)の固定領域破壊を招く
        // (HESの長いDDA/PCM抽出で実測)。再生されない末尾は切り詰めて安全側に倒す。
        bytes: def.bytes.slice(0, playLen)
      };
      byFile[def.file] = layout[idx];
      offset += playLen;
    }
    return layout;
  }

  // ページ数(16KB単位)。2以上なら再生側は $5FFC-$5FFF の切替が要る(NSF書き出しは
  // ppmckDriver.js が DPCM_PAGE_TBL を持ち、ドライバのRAMに1バイト増える)
  function dpcmPageCount(layout) {
    let n = 0;
    for (const idx of Object.keys(layout || {})) n = Math.max(n, (layout[idx].page | 0) + 1);
    return n;
  }

  // DPCMチャンネル(E)の音符は「@DPCM<番号>の選択」で音高ではない(本家ppmck準拠、2026-09-19。
  // 以前は @<n> でサンプルを選び音符の音高でレートを変える独自方式だった)。内部の noteNumber は
  // n<num> と同じ「オクターブ2のC=0」の通し番号で持つので、番号 = noteNumber - DPCM_NOTE_BASE。
  // 定義番号は本家 _DPCM_MAX と同じ 0〜63
  const DPCM_NOTE_BASE = 24;
  const DPCM_DEF_MAX = 63;

  // 音符の番号(noteNumber - DPCM_NOTE_BASE)が指す @DPCM<n> を、音符が来るたびに頭からトリガーする。
  // $4010 = (mode<<6)|freq は定義の値そのもの(本家ppmckc writeDPCM の1バイト目 freq|(mode<<6) と同じ。
  // bit7=IRQ は本家でも非推奨なので落とす)。未定義の番号は何も書かない(=無音。本家は dpcm_data の
  // 空行 0,0,0,0 を鳴らすだけでエラーにしない)。警告は compile() 側で1番号1回出す
  function segmentsToWriteLogDpcm(segments, totalFrames, dpcmLayout, dpcmSamples) {
    const writeLog = newWriteLog(totalFrames);
    const pages = dpcmPageCount(dpcmLayout);
    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      if (seg.freq != null) {
        const idx = seg.noteNumber - DPCM_NOTE_BASE;
        const layout = dpcmLayout[idx];
        const def = dpcmSamples[idx];
        if (layout && def) {
          const control = (((def.mode & 3) << 6) | (def.freq & 0x0F)) & 0x7F;
          writeLog[startFrame].push({ addr: 0x4015, value: 0x0F }); // DMC一旦停止(2A03他chは維持)
          if (pages > 1) {
            // ページ切替(2026-09-10): NSFと同じ $5FFC-$5FFF(窓4-7)へ「仮想バンク番号=ページ×4+k」を書く。
            // ブラウザ再生は player.js/stream-player.js の buildDpcmBus がこれを受けて読出し元を切り替え
            // (APU2A03.writeRegister が bus.write へ回す)、NSF書き出しはドライバが DPCM_PAGE_TBL から
            // 同じ順で書く(ppmckDriver.js WFV_T28)。DMCを止めた直後なので読出し中の切替は起きない
            for (let k = 0; k < 4; k++) writeLog[startFrame].push({ addr: 0x5FFC + k, value: layout.page * 4 + k });
          }
          writeLog[startFrame].push({ addr: 0x4010, value: control });
          if (layout.dac != null) writeLog[startFrame].push({ addr: 0x4011, value: layout.dac });
          writeLog[startFrame].push({ addr: 0x4012, value: layout.addrReg });
          writeLog[startFrame].push({ addr: 0x4013, value: layout.lengthReg });
          writeLog[startFrame].push({ addr: 0x4015, value: 0x1F }); // 再生開始
        }
        // ゲートオフ(q<n>)・休符ではDPCMを止めない(サンプルは末尾まで鳴り切る)。
        // 実機ppmck(dpcm.h no_dpcm: `.if DPCM_RESTSTOP`が無効な既定)と同じ挙動で、
        // ppmckcはq<n>を音符+休符($FC)に分解して出力するためゲートオフも休符と同じ扱い。
        // 以前はゲートオフだけ$4015=$0Fで停止していたが、NSF書き出しのバイトコードは
        // 休符とゲートオフを同じOP_RESTで表す(区別できない)ため、6502側と揃えるには
        // 「どちらも止めない」(ppmck準拠)か「どちらも止める」(#DPCM-RESTSTOP相当)の
        // 二択になり、本家既定に合わせた(2026-08-16、ppmckDriver.js SIL_T DPCMと対)
      }
      frame += dur;
    }
    return writeLog;
  }

  function buildExpansionWriteLog(expansion, ch, index, segments, totalFrames, envelopes, dpcmLayout, dpcmSamples, extra) {
    switch (expansion) {
      case 'vrc6': return segmentsToWriteLogVrc6(index, segments, totalFrames, envelopes);
      case 'mmc5': return segmentsToWriteLogMmc5(index, segments, totalFrames, envelopes);
      case 'fme7': return segmentsToWriteLogFme7(index, segments, totalFrames, envelopes);
      case 'fds': return segmentsToWriteLogFds(segments, totalFrames, envelopes);
      case 'n163': return segmentsToWriteLogN163(ch, index, segments, totalFrames, envelopes,
        extra && extra.numN163Ch, extra && extra.n163Occurrences);
      case 'vrc7': return segmentsToWriteLogVrc7(index, segments, totalFrames, envelopes);
      case 'dpcm': return segmentsToWriteLogDpcm(segments, totalFrames, dpcmLayout, dpcmSamples);
      default: return newWriteLog(totalFrames);
    }
  }

  // VRC7(OP<n>)/FDS(@<n>によるFM<n>選択)/N163(@<n>によるN<n>選択)は曲中の動的切り替えに
  // 対応した(segmentsToWriteLogFds/N163の instrument変化検出、および
  // spliceImmediateWritesによるOP<n>の差し込み)ため、ここでの「@OP0/@FM0/@N0を
  // 曲頭に自動プリロード」は行わない(初回使用時に自然にロードされる/composerが
  // 明示的にOP<n>を呼ぶのが実機の挙動)。opt.fdsWave/opt.n163Wave(波形エディタUI由来、
  // MML本文に@FM/@N定義が無い場合の既定波形)はこれとは別物として引き続き曲頭に適用する
  function expansionInitWrites(expansion, opt, envelopes, extra) {
    switch (expansion) {
      case 'mmc5': return mmc5InitWrites();
      case 'fme7': return fme7InitWrites();
      case 'fds': return fdsInitWrites(opt && opt.fdsWave);
      case 'n163': return n163InitWrites(extra && extra.numN163Ch);
      default: return [];
    }
  }

  Mml.compile = function (source, opt = {}) {
    const errors = [];
    const { channels, errors: splitErrors, envelopes, meta, settings, detectedExpansions } = Mml.splitChannels(source);
    errors.push(...splitErrors);
    // #TUNING(基準ピッチ): 以降の noteFrequency() 全てに効く(compile は同期処理なので曲ごとに設定し直すだけでよい)
    tuningRatio = Math.pow(2, ((settings && settings.tuningCents) || 0) / 1200);
    tuningNoteRatios = (settings && settings.tuningNotes) ? settings.tuningNotes.map(c => Math.pow(2, (c || 0) / 1200)) : null;

    // #EX-VRC6等でMML本文が宣言した拡張音源は、opt.expansions(UI選択)と統合する
    // (INV-2: MMLテキストが正典。UIの選択有無に関わらずMML側の宣言を尊重する)
    const expansions = normalizeExpansions({ expansions: [...(opt.expansions || (opt.expansion ? [opt.expansion] : [])), ...detectedExpansions] });
    const expansionLetterMap = assignExpansionLetters(expansions);
    const expansionLetters = expansions.flatMap(exp => expansionLetterMap[exp]);

    // @DPCM<n>定義と opt.dpcmSamples[filename]=Uint8Array(台帳 main.js dpcmSampleCache の
    // バイト列)を突き合わせる。bytesがnullの場合は未読込(下で dpcm-missing 警告)。
    // 番号は本家 _DPCM_MAX と同じ 0〜63(dpcm_data は 64行×4バイト)
    const dpcmSamples = {};
    for (const idx of Object.keys(envelopes.dpcm)) {
      const def = envelopes.dpcm[idx];
      if ((idx | 0) > DPCM_DEF_MAX) {
        errors.push({ message: T('@DPCM の番号は 0〜{max} です(@DPCM{n}。本家ppmckと同じ64本まで)', { max: DPCM_DEF_MAX, n: idx }) });
        continue;
      }
      dpcmSamples[idx] = { ...def, bytes: (opt.dpcmSamples && opt.dpcmSamples[def.file]) || null };
    }
    const dpcmLayout = layoutDpcmSamples(dpcmSamples);

    // グローバルテンポ: 最初に出現した t<n> を採用 (デフォルト120)
    let tempo = 120;
    for (const ch of Object.keys(channels)) {
      const tokens = Mml.tokenize(channels[ch].text);
      const t = tokens.find(tok => tok.type === 'tempo');
      if (t) { tempo = t.value; break; }
    }

    const channelLetters = ['A', 'B', 'C', 'D', ...expansionLetters];
    const segmentsByChannel = {};
    const immediateWritesByChannel = {};
    const noteListByChannel = {};
    // 楽譜用の拍子/調(段階1)。ppmck MMLに拍子/調の概念は無いので、ppmckcが無視するコメント行
    // ";@time <分子>/<分母>" ";@key <五度圏の数>" で指示する。無ければnull(楽譜側が既定4/4・
    // 調は自動推定)。不正な値は warnings に載せる(コンパイルは止めない)
    const score = parseScoreDirectives(source);
    const loopFrameByChannel = {};
    const startMarkerFrameByChannel = {};
    const endMarkerFrameByChannel = {};
    const startMarkerSrcRangeByChannel = {};
    const endMarkerSrcRangeByChannel = {};
    let totalFrames = 0;

    const fme7Letters = new Set(expansionLetterMap.fme7 || []);
    // buildSegmentsが積む警告(ノイズchで無視したK等)。warningsの宣言が後なので一旦ここへ集める
    const segmentWarnings = [];
    // SD(セルフディレイ)が使えないチャンネル。本家ppmckのコマンド表(datamake.c)で
    // SD/SDOF/SDQRの対応トラックが ALLTRACK & ~TRACK(2) & ~DPCMTRACK になっているため、
    // 三角波(C)とDPCMチャンネルを除外する(三角波は音量制御自体が無くリリース
    // エンベロープが成立しない、DPCMはサンプル再生で音程の差し替えに意味が無い)
    const noSelfDelayLetters = new Set(['C', ...(expansionLetterMap.dpcm || [])]);
    // @@<n>/@@r<n>(音色バイトbit7=0)の対応トラックと意味。実機ppmckのコマンド表
    // (datamake.c: TRACK(0)|TRACK(1)|FMTRACK|VRC7TRACK|VRC6PLSTRACK|N106TRACK|MMC5PLSTRACK)
    // に合わせる。デューティ比を持つチップはデューティエンベロープ選択、波形/音色番号を
    // 持つチップ(FDS/N163/VRC7)は音色選択になる(VRC6はのこぎり波chだけ対象外)
    const vrc6Letters = expansionLetterMap.vrc6 || [];
    const vrc7Letters = new Set(expansionLetterMap.vrc7 || []);
    const dutyToneLetters = new Set([
      'A', 'B',
      ...vrc6Letters.slice(0, 2),
      ...(expansionLetterMap.mmc5 || [])
    ]);
    const fdsLetters = new Set(expansionLetterMap.fds || []);
    const vrc6SawLetter = vrc6Letters[2];
    const instrumentToneLetters = new Set([
      ...(expansionLetterMap.fds || []),
      ...(expansionLetterMap.n163 || []),
      ...vrc7Letters
    ]);
    // @n<num>(直接周波数指定)を使えるチャンネルと、周期/周波数レジスタの幅・逆算式の種類。本家ppmck
    // (datamake.c のコマンド表 ALLTRACK&~DPCMTRACK&~VRC7TRACK&~N106TRACK と MCK_DIRECT_FREQ の上位バイトの
    // マスク: VRC6/SUN5B は4bit=12bit、他は3bit=11bit)に合わせる。FDSだけは12bit(buildSegments の directFreq 参照)。
    // null のチャンネル(VRC7/N163/DPCM)では @n はエラー
    const directFreqCaps = {
      A: { kind: 'pulse', bits: 11, label: '2A03 ' + T('パルス') },
      B: { kind: 'pulse', bits: 11, label: '2A03 ' + T('パルス') },
      C: { kind: 'triangle', bits: 11, label: '2A03 ' + T('三角波') },
      D: { kind: 'noise', bits: 11, label: '2A03 ' + T('ノイズ') }
    };
    vrc6Letters.forEach((L, i) => {
      directFreqCaps[L] = i === 2 ? { kind: 'saw', bits: 12, label: 'VRC6 ' + T('ノコギリ波') }
        : { kind: 'pulse', bits: 12, label: 'VRC6 ' + T('パルス') };
    });
    for (const L of (expansionLetterMap.mmc5 || [])) directFreqCaps[L] = { kind: 'pulse', bits: 11, label: 'MMC5 ' + T('パルス') };
    for (const L of fme7Letters) directFreqCaps[L] = { kind: 'fme7', bits: 12, label: 'FME-7' };
    for (const L of fdsLetters) directFreqCaps[L] = { kind: 'fds', bits: 12, label: 'FDS' };
    for (const ch of channelLetters) {
      const raw = channels[ch] || { text: '', offsets: [] };
      let tokens = Mml.tokenize(raw.text, raw.offsets);
      tokens = expandLoops(tokens, errors);
      tokens = applyTuplets(tokens, tempo, errors);
      const {
        segments, notes, immediateWrites, loopFrame,
        startMarkerFrame, endMarkerFrame, startMarkerSrcRange, endMarkerSrcRange
      } = buildSegments(tokens, tempo, errors, settings, fme7Letters.has(ch) ? 1 : 0, {
        selfDelay: !noSelfDelayLetters.has(ch),
        toneEnv: dutyToneLetters.has(ch) ? 'duty' : (instrumentToneLetters.has(ch) ? 'instrument' : null),
        vrc7: vrc7Letters.has(ch),
        n163: (expansionLetterMap.n163 || []).includes(ch),
        psAllowed: ch === 'A' || ch === 'B' || ch === 'C',
        noise: ch === 'D',
        dpcm: (expansionLetterMap.dpcm || []).includes(ch),
        directFreq: directFreqCaps[ch] || null,
        warnings: segmentWarnings,
        // 音量6bitチャンネル(本家ppmck FMTRACK|VRC6SAWTRACK相当)。FDSは$4080の実効ゲインが
        // 32で頭打ちなので既定音量32、VRC6サウは蓄積レートそのままなので63
        volMax: (fdsLetters.has(ch) || ch === vrc6SawLetter) ? 63 : 15,
        volDefault: fdsLetters.has(ch) ? 32 : (ch === vrc6SawLetter ? 63 : 15)
      });
      segmentsByChannel[ch] = segments;
      immediateWritesByChannel[ch] = immediateWrites;
      noteListByChannel[ch] = notes;
      loopFrameByChannel[ch] = loopFrame;
      startMarkerFrameByChannel[ch] = startMarkerFrame;
      endMarkerFrameByChannel[ch] = endMarkerFrame;
      startMarkerSrcRangeByChannel[ch] = startMarkerSrcRange;
      endMarkerSrcRangeByChannel[ch] = endMarkerSrcRange;
      const sum = segments.reduce((a, s) => a + s.durationFrames, 0);
      totalFrames = Math.max(totalFrames, sum);
    }

    totalFrames = Math.max(1, totalFrames);

    // L(ループ地点)は全チャンネルに同じフレーム位置で置くのが前提の使い方のため、
    // チャンネルレターの並び順(A,B,C,D,拡張...)で最初に見つかったチャンネルの値を
    // 曲全体のループ地点として採用する
    let loopPointFrame = null;
    for (const ch of channelLetters) {
      if (loopFrameByChannel[ch] != null) { loopPointFrame = loopFrameByChannel[ch]; break; }
    }

    // !!(再生開始位置)/!!!(再生終了位置)も同じ考え方で、最初に見つかったチャンネルの
    // 値を曲全体のマーカーとして採用する(シークバー開始/終了ハンドルとの連動に使う)。
    // どのチャンネルの何文字目にあったか(startMarkerChannel/startMarkerSrcRange)も
    // 併せて公開し、UI側がシークバードラッグ後に既存マーカーへ書き戻せるようにする
    let startMarkerFrame = null, startMarkerChannel = null, startMarkerSrcRange = null;
    let endMarkerFrame = null, endMarkerChannel = null, endMarkerSrcRange = null;
    for (const ch of channelLetters) {
      if (startMarkerFrame == null && startMarkerFrameByChannel[ch] != null) {
        startMarkerFrame = startMarkerFrameByChannel[ch];
        startMarkerChannel = ch;
        startMarkerSrcRange = startMarkerSrcRangeByChannel[ch];
      }
      if (endMarkerFrame == null && endMarkerFrameByChannel[ch] != null) {
        endMarkerFrame = endMarkerFrameByChannel[ch];
        endMarkerChannel = ch;
        endMarkerSrcRange = endMarkerSrcRangeByChannel[ch];
      }
    }

    // 再生ハイライト用: フレーム位置 -> ソース文字範囲の対応表(全チャンネル)
    const highlightRanges = {};
    for (const ch of channelLetters) {
      const ranges = [];
      let frame = 0;
      for (const seg of segmentsByChannel[ch]) {
        if (seg.srcStart != null) {
          ranges.push({ startFrame: frame, endFrame: frame + seg.durationFrames, srcStart: seg.srcStart, srcEnd: seg.srcEnd });
        }
        frame += seg.durationFrames;
      }
      highlightRanges[ch] = ranges;
    }

    // ── 音域外の音符を「鳴らさない」+警告(2026-08-25) ────────────────
    // クランプして別音程で鳴らす旧挙動をやめる(pitchRangeIssue のコメント参照)。
    // seg.freq=null にすると以降のwriteLog生成では休符として扱われ、音程は変えずに
    // その音だけ無音になる。警告はチャンネルごとに1件へまとめる(同じ低音が延々続く曲で
    // メッセージが溢れないように、件数だけ添える)。
    const warnings = [...segmentWarnings];
    for (const message of score.issues) warnings.push({ message });
    // @DPCM<n> の .dmc が台帳(opt.dpcmSamples)に無い: 以前は黙って無音にしていた(2026-09-16)。
    // kind は src/convert/verify.js が除外するための印(音程検証は意図的にサンプル無しでコンパイルする)
    for (const idx of Object.keys(dpcmSamples)) {
      if (dpcmSamples[idx].bytes && dpcmSamples[idx].bytes.length) continue;
      warnings.push({ kind: 'dpcm-missing', message: T('@DPCM{n} の "{file}" が読み込まれていないため、この音は鳴りません(.dmc を MML と一緒に開くか、ウィンドウへドロップしてください)', { n: idx, file: dpcmSamples[idx].file }) });
    }
    // E の音符が指す @DPCM 番号が未定義: 本家ppmckは dpcm_data の空行を鳴らすだけでエラーにしないので、
    // ここも警告に留めて無音にする(segmentsToWriteLogDpcm は layout が無ければ何も書かない)。1番号1回
    for (const ch of (expansionLetterMap.dpcm || [])) {
      const seen = new Set();
      for (const seg of segmentsByChannel[ch] || []) {
        if (seg.freq == null) continue;
        const idx = seg.noteNumber - DPCM_NOTE_BASE;
        if (dpcmSamples[idx] || seen.has(idx)) continue;
        seen.add(idx);
        warnings.push({ kind: 'dpcm-undefined', srcStart: seg.srcStart, message: T('{ch} の n{n} に対応する @DPCM{n} が定義されていないため、この音は鳴りません', { ch, n: idx }) });
      }
    }
    {
      const chipOf = {};
      chipOf.A = chipOf.B = { kind: 'pulse', periodMax: 2047, label: '2A03 ' + T('パルス') };
      chipOf.C = { kind: 'triangle', label: '2A03 ' + T('三角波') };
      for (const exp of expansions) {
        (expansionLetterMap[exp] || []).forEach((L, i) => {
          if (exp === 'vrc6') chipOf[L] = (i === 2)
            ? { kind: 'saw', label: 'VRC6 ' + T('ノコギリ波') }
            : { kind: 'pulse', periodMax: 4095, label: 'VRC6 ' + T('パルス') };
          else if (exp === 'mmc5') chipOf[L] = { kind: 'pulse', periodMax: 2047, label: 'MMC5 ' + T('パルス') };
          else if (exp === 'fme7') chipOf[L] = { kind: 'fme7', label: 'FME-7' };
          else if (exp === 'fds')  chipOf[L] = { kind: 'fds',  label: 'FDS' };
          else if (exp === 'vrc7') chipOf[L] = { kind: 'vrc7', label: 'VRC7' };
          else if (exp === 'n163') chipOf[L] = { kind: 'n163', label: 'N163' };
        });
      }
      // N163の有効ch数(segmentsToWriteLogN163へ渡す値と同じ規則で求める)
      const numN163 = n163NumChOf(expansionLetterMap.n163, segmentsByChannel, settings);
      // 宣言した実効ch数より上のN163チャンネルは実機に存在しない(本家ppmckは
      // INVALID_TRACK_HEADER で弾く)。黙って消えると原因が分からないので警告する
      if (settings && settings.n163NumCh) {
        const over = (expansionLetterMap.n163 || []).filter((L, i) =>
          i >= numN163 && (segmentsByChannel[L] || []).some(s => s.freq != null));
        if (over.length) {
          warnings.push({ message: T('{ch} は #EX-N163 の宣言({n}ch)より上のチャンネルなので鳴りません。宣言を増やすか、下のチャンネルへ移してください',
            { ch: over.join(', '), n: numN163 }) });
        }
      }
      const nWaves = (envelopes && envelopes.n) || {};
      for (const ch of channelLetters) {
        const chip = chipOf[ch];
        if (!chip) continue;
        let frame = 0, count = 0, first = null;
        let clampCount = 0, clampFirst = null;
        // タイ(&)の異音程レガート・SD の差し替え先・PS のグライド元が o0c〜o9b の外: NSF のドライバは
        // 表の端へクランプして鳴らす(音符バイトの 0 クランプ+LOOKUP の上限クランプ)ので、JS も同じ音へ
        // 丸めて警告する(音符の途中の音程なので「鳴らさない」はできない)
        const clampTableNote = (n, frameAt, srcStart) => {
          if (n == null || (n >= 0 && n <= NOTE_TABLE_TOP)) return n;
          if (!clampFirst) clampFirst = { frame: frameAt, note: n, srcStart };
          clampCount++;
          return Math.max(0, Math.min(NOTE_TABLE_TOP, Math.round(n)));
        };
        for (const seg of segmentsByChannel[ch] || []) {
          // 音階表(o0c〜o9b)の外の音符(2026-09-19): NSF のドライバは表を引けない(119超は1バイト形式の
          // 音符と衝突して以降のバイト列が全部ずれ、負は o0c になっていた)ので、チップの音域と同じく鳴らさない。
          // @n はノート番号を使わない(代表値は0〜119)ので対象外
          if (seg.freq != null && seg.directPeriod == null &&
              (seg.noteNumber > NOTE_TABLE_TOP || seg.noteNumber < 0)) {
            const issue = seg.noteNumber < 0 ? 'table-low' : 'table-high';
            if (!first) first = { issue, frame, note: seg.noteNumber, srcStart: seg.srcStart };
            count++;
            seg.freq = null;
          }
          // @n(直接周波数指定)は書いた値をそのままレジスタへ送る(本家同様、音域判定で消さない)
          if (seg.freq != null && seg.directPeriod == null) {
            const opt = chip.kind === 'n163'
              ? { waveLen: (nWaves[seg.instrument] || []).length || N163_WAVE_LEN, numCh: Math.max(1, numN163) }
              : chip;
            const issue = pitchRangeIssue(chip.kind, seg.freq, opt);
            if (issue) {
              if (!first) first = { issue, frame, note: seg.noteNumber, srcStart: seg.srcStart };
              count++;
              seg.freq = null; // 音程は変えず、その音だけ鳴らさない
            }
          }
          // (音域外で鳴らさなくなった音符は数えない)
          if (seg.freq != null) {
            if (seg.pitchBreaks) {
              for (const pb of seg.pitchBreaks) {
                const n = clampTableNote(pb.noteNumber, frame + pb.atFrame, seg.srcStart);
                if (n !== pb.noteNumber) { pb.noteNumber = n; pb.freq = noteFrequency(n); }
              }
            }
            if (seg.psGlide && seg.psGlide.fromNoteNumber != null) {
              const n = clampTableNote(seg.psGlide.fromNoteNumber, frame, seg.srcStart);
              if (n !== seg.psGlide.fromNoteNumber) seg.psGlide = { fromFreq: noteFrequency(n), fromNoteNumber: n };
            }
          }
          frame += seg.durationFrames;
        }
        if (first) {
          const params = {
            ch, note: noteNumberToName(first.note), chip: chip.label,
            sec: (first.frame / FRAME_RATE_NTSC).toFixed(1),
            more: count > 1 ? T('(他 {n} 音)', { n: count - 1 }) : ''
          };
          warnings.push({ srcStart: first.srcStart, message: first.issue === 'low'
            ? T('{ch}: {note} ({sec}秒) は {chip} の音域より低いため鳴りません{more}。オクターブを上げてください', params)
            : first.issue === 'high'
              ? T('{ch}: {note} ({sec}秒) は {chip} の音域より高いため鳴りません{more}。オクターブを下げてください', params)
              : first.issue === 'table-low'
                ? T('{ch}: {note} ({sec}秒) は o0c より低いため鳴りません{more}(音階は o0c〜o9b)。オクターブを上げてください', params)
                : T('{ch}: {note} ({sec}秒) は o9b より高いため鳴りません{more}(音階は o0c〜o9b)。オクターブを下げてください', params) });
        }
        if (clampFirst) {
          warnings.push({ srcStart: clampFirst.srcStart, message: T('{ch}: タイ/SD/PS でつながる音程 {note} ({sec}秒) は o0c〜o9b の外なので、端の音で鳴らします{more}', {
            ch, note: noteNumberToName(clampFirst.note),
            sec: (clampFirst.frame / FRAME_RATE_NTSC).toFixed(1),
            more: clampCount > 1 ? T('(他 {n} 音)', { n: clampCount - 1 }) : ''
          }) });
        }
      }
    }

    // トラック終端の無音化(2026-09-19): 曲より先に終わるチャンネルは、最後の音符の直後で無音にする。
    // NSF書き出しのドライバはトラック終端(0xFF)で SILENCE_CH を呼んで止める(ppmckDriver.js
    // RD_ENDTRACK_STOP)のに、ここは何も書かず最後の音が曲の終わりまで鳴りっぱなしだった
    // (音量の無い三角波で顕著。組み込みサンプルを章ごとに順番に鳴らすようにして発覚)。
    // 書き込みログ生成に渡す列の末尾へ「残り全部の休符」を足すだけにして、各チップの休符処理に任せる。
    // segmentsByChannel 自体は変えない(NSFのバイトコードに余計な休符を足さない。ドライバは自前で止める)。
    // L(ループ地点)を持つチャンネルは止めない(下の複製で周回する)。DPCMは休符でも止まらない(本家準拠)
    const segsForLog = (ch) => {
      const segs = segmentsByChannel[ch] || [];
      if (!segs.length || loopFrameByChannel[ch] != null) return segs;
      const last = segs[segs.length - 1];
      if (last.freq == null) return segs; // もう休符で終わっている
      let len = 0;
      for (const s of segs) len += s.durationFrames;
      if (len >= totalFrames) return segs;
      return segs.concat([Object.assign({}, last, {
        durationFrames: totalFrames - len, freq: null, noteNumber: null,
        srcStart: last.srcEnd, srcEnd: last.srcEnd,
        keyOffAt: null, psGlide: null, pitchBreaks: null, tieNext: false
      })]);
    };

    const tracks = {};
    for (const ch of ['A', 'B', 'C', 'D']) {
      tracks[ch] = segmentsToWriteLog2A03(ch, segsForLog(ch), totalFrames, envelopes);
    }

    for (const exp of expansions) {
      const letters = expansionLetterMap[exp];
      // 拡張音源ごとの追加情報(ライト生成・初期化の両方で使う)。N163は実際に使われている
      // チャンネル数(音符を持つ最上位レターの位置+1)を有効ch数として全ライトへ伝える。
      let extra;
      if (exp === 'n163') {
        const numN163Ch = n163NumChOf(letters, segmentsByChannel, settings);
        // 共有バッファアロケータ: 曲全体のN163使用状況から、時間軸で重ならない範囲だけ
        // 波形データを再利用しながらRAM上のバイト位置を割り当てる。空き容量を超えて
        // 同時使用される場合はconflictとして記録し、エラーへ変換する。
        // ★波形に使えるバイト数は 128-8*numN163Ch(有効ch数ぶんレジスタが上から占める)。
        //   ここを64固定にしていたため、6chしか使わない曲が本来収まるのに落ちていた
        const allocResult = MML.N163Alloc.allocate(letters, segmentsByChannel, envelopes.n, totalFrames,
          numN163Ch);
        // kind: 変換側(vgm2mml convertData)が「N163 波形 RAM の空き不足」だけを文言に依らず見分けるための印
        for (const c of allocResult.conflicts) errors.push({ message: c.message, kind: 'n163Ram', frame: c.frame, instrument: c.instrument });
        extra = { numN163Ch: numN163Ch, n163Occurrences: allocResult.occurrences };
      }
      letters.forEach((ch, index) => {
        tracks[ch] = buildExpansionWriteLog(exp, ch, index, segsForLog(ch), totalFrames, envelopes, dpcmLayout, dpcmSamples, extra);
        // OP<n>(VRC7音色)/MH<n>(FDS変調)による曲中の動的切り替えをこのchへ差し込む
        if (exp === 'vrc7') {
          // 第6引数 true = 音符の書き込みより前へ(音色をロードしてからキーオンする。
          // spliceImmediateWrites 冒頭のコメント参照)
          spliceImmediateWrites(tracks[ch], immediateWritesByChannel[ch], 'vrc7Tone', totalFrames,
            iw => resolveVrc7ToneWrite(iw, envelopes), true);
        } else if (exp === 'fds') {
          spliceImmediateWrites(tracks[ch], immediateWritesByChannel[ch], 'fdsMod', totalFrames,
            iw => resolveFdsModWrite(iw, envelopes));
        }
      });
      // ミキサー(R7)は3ch共有のため、chごとのwriteLogではなく先頭chへ1本にまとめて挿す
      if (exp === 'fme7' && letters.length > 0) {
        for (const { frame, writes } of fme7MixerWrites(letters, segmentsByChannel, totalFrames)) {
          tracks[letters[0]][frame] = [...writes, ...tracks[letters[0]][frame]];
        }
      }
      const initWrites = expansionInitWrites(exp, opt, envelopes, extra);
      if (initWrites.length > 0 && letters.length > 0) {
        tracks[letters[0]][0] = [...initWrites, ...tracks[letters[0]][0]];
      }
    }

    // y<adr>,<num>(レジスタ直接書き込み)。音源チップに関わらずどのチャンネルでも同じ
    // 意味(生バイト書き込み)なので、2A03基本chと全拡張音源chへ一律に差し込む。
    // ★同じフレームの音符より前に置く(prepend、2026-09-18)。本家ppmckも本ツールのNSFドライバも
    //   「コマンドを順に実行→音符のレジスタ書き込み」の順なので、`y$400E,$80 c4` の y は直後の
    //   音符に上書きされる。以前は後置きだったためブラウザ再生だけ y が勝ち、NSFと音が違っていた
    for (const ch of channelLetters) {
      spliceImmediateWrites(tracks[ch], immediateWritesByChannel[ch], 'rawWrite', totalFrames,
        iw => ({ writes: [{ addr: iw.addr, value: iw.value }] }), true);
    }

    // L(ループ地点)が使われている場合、このツール(ブラウザ再生・シークバー)での
    // 「曲の長さ」は "曲頭からLへ2回戻るまで"(=イントロ1回 + ループ区間を2回)とする。
    // 各セグメント生成関数(segmentsToWriteLogXxx)は音符ごとに周波数・音量・音色を
    // 必ずフルに書き直す設計(未書込のまま前フレームの値を引き継ぐ書き方をしていない)
    // ため、書き込みログの[loopPointFrame, naturalEndFrame)を単純に複製して末尾へ
    // 追加するだけで「実際にそこへ戻って演奏した場合」と同じ結果になる。
    // NSF書き出し側(src/driver/ppmckDriver.js)はこれとは別に、loopFrameByChannelを使って
    // 実機同様の(このツールの都合による打ち切りが無い)本当の無限ループを行う
    if (loopPointFrame != null && loopPointFrame < totalFrames) {
      const naturalEndFrame = totalFrames;
      const loopLen = naturalEndFrame - loopPointFrame;
      for (const ch of Object.keys(tracks)) {
        tracks[ch] = tracks[ch].concat(tracks[ch].slice(loopPointFrame, naturalEndFrame));
      }
      for (const ch of Object.keys(highlightRanges)) {
        const extraRanges = [];
        for (const r of highlightRanges[ch]) {
          if (r.endFrame <= loopPointFrame) continue;
          extraRanges.push({
            startFrame: Math.max(r.startFrame, loopPointFrame) + loopLen,
            endFrame: r.endFrame + loopLen,
            srcStart: r.srcStart,
            srcEnd: r.srcEnd
          });
        }
        highlightRanges[ch] = highlightRanges[ch].concat(extraRanges);
      }
      totalFrames = naturalEndFrame + loopLen;
    }

    // ── VRC7自作音色(@0)の同時使用チェック ─────────────────────────────
    // 実機VRC7の自作音色スロット(レジスタ$00-$07)はチップ全体で1系統しかないため、
    // 複数チャンネルが同時に「異なるOP<n>の自作音色」を鳴らすことはできない(後から
    // 書いたOP<n>が先に鳴っている音の音色も上書きしてしまう)。時間をずらして使い分ける
    // のは正当なので、発音区間が実際に重なり、かつその時点の選択OP<n>が異なる場合のみ
    // エラーにする(OP<n>未発行の@0同士は現在ロード済みの音色を共有する意図とみなし許容)。
    (() => {
      const vrc7Ls = (expansionLetterMap.vrc7 || []).filter((l) => (segmentsByChannel[l] || []).length);
      if (vrc7Ls.length < 2) return;
      const perCh = vrc7Ls.map((l) => {
        const iv = [];
        let f = 0;
        for (const seg of segmentsByChannel[l]) {
          if (seg.freq != null && (seg.instrument || 0) === 0) iv.push({ s: f, e: f + seg.durationFrames });
          f += seg.durationFrames;
        }
        const tones = (immediateWritesByChannel[l] || [])
          .filter((w) => w.kind === 'vrc7Tone')
          .sort((a, b) => a.frame - b.frame);
        const toneAt = (fr) => {
          let v = null;
          for (const t of tones) { if (t.frame <= fr) v = t.value; else break; }
          return v;
        };
        return { letter: l, iv, toneAt };
      });
      for (let i = 0; i < perCh.length; i++) {
        for (let j = i + 1; j < perCh.length; j++) {
          for (const a of perCh[i].iv) {
            for (const b of perCh[j].iv) {
              const s = Math.max(a.s, b.s);
              if (s >= Math.min(a.e, b.e)) continue;
              const ta = perCh[i].toneAt(s);
              const tb = perCh[j].toneAt(s);
              if (ta != null && tb != null && ta !== tb) {
                errors.push({ message: T(
                  'VRC7の自作音色(@0)はチップ全体で1系統です: {sec}秒付近で {chA}(OP{a}) と {chB}(OP{b}) が同時に異なる自作音色を使っています',
                  { sec: (s / FRAME_RATE_NTSC).toFixed(1), chA: perCh[i].letter, a: ta, chB: perCh[j].letter, b: tb }) });
                return; // 最初の1件で十分(同種の衝突が大量に並ぶのを防ぐ)
              }
            }
          }
        }
      }
    })();

    return {
      tracks,
      totalFrames,
      tempo,
      expansions,
      expansionLetterMap,
      channelLetters,
      loopFrameByChannel,
      loopPointFrame,
      startMarkerFrame,
      startMarkerChannel,
      startMarkerSrcRange,
      endMarkerFrame,
      endMarkerChannel,
      endMarkerSrcRange,
      highlightRanges,
      // noteList: 楽譜出力用の音符列(ch別、書かれた順、音価付き。buildSegmentsのnotes参照)。
      // ループ地点(L)による末尾複製は行わない(譜面は「書かれたとおり」。tracks/highlightRangesとは違う)
      noteList: noteListByChannel,
      // score: ";@time" ";@key" コメント指示(parseScoreDirectives)。{ time: {beats, beatType}|null, key: {fifths}|null }
      score: { time: score.time, key: score.key },
      errors,
      // warnings: コンパイルは成立するが意図どおり鳴らない箇所(音域外など)。
      // errorsと違い再生/書き出しは中止しない(UI側は表示のみ)
      warnings,
      frameRate: FRAME_RATE_NTSC,
      statusAddr: STATUS_ADDR,
      meta,
      settings,
      detectedExpansions,
      dpcmSamples,
      dpcmLayout,
      segmentsByChannel,
      envelopes,
      immediateWritesByChannel
    };
  };

  // s<speed>,<depth> → $4001/$4005の生バイト。NSF書き出し(src/nsf/mckBytecode.js)も
  // 同じバイトをバイトコードへ埋め込むため、ブラウザ再生と完全に同じ値になるよう共有する
  Mml.sweepRegisterByte = sweepRegisterByte;
  // 周波数→各チップの周期/周波数レジスタ値(割当プレビュー src/audio/assign-preview.js が同じ式で鳴らすために公開)
  Mml.pitchRegs = { pulsePeriod, vrc6PulsePeriod, trianglePeriod, noisePeriodIndex, sawPeriod, fme7Period, fdsFreqToPeriod, n163FreqReg, vrc7FreqToFnumBlock };
  Mml.CHANNEL_BASE = CHANNEL_BASE;
  Mml.CHIP_CHANNEL_COUNTS = CHIP_CHANNEL_COUNTS;
  Mml.EXPANSION_PRIORITY = EXPANSION_PRIORITY;
  Mml.assignExpansionLetters = assignExpansionLetters;
  Mml.FRAME_RATE_NTSC = FRAME_RATE_NTSC;
  Mml.N163_WAVE_LEN = N163_WAVE_LEN;
  Mml.N163_CHANNEL_COUNT = N163_CHANNEL_COUNT;
  Mml.fdsDefaultWave = fdsDefaultWave;
  Mml.n163DefaultWave = n163DefaultWave;
  Mml.dpcmPageCount = dpcmPageCount;
  Mml.DPCM_NOTE_BASE = DPCM_NOTE_BASE;
  Mml.DPCM_DEF_MAX = DPCM_DEF_MAX;
})(window);
