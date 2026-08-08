/*
 * MMLコンパイラ動作確認用のサンプル楽曲
 * ラヴェル「ボレロ」風、全音源(2A03+FDS+VRC7+VRC6+N163+FME7+MMC5)を使った試作。
 * DPCM(E)はサンプルファイルのアップロードが要るためこのサンプルでは未使用。
 *
 * 構成: 3/4拍子、16小節のテーマ(A句+B句、各8小節)を$wマクロで1回だけ定義し、
 * 全チャンネルがそれを(必要ならK<n>で移調しながら)使い回す。実際のボレロ同様、
 * 同じ旋律を鳴らしたまま楽器(チャンネル)を段階的に増やして音を厚くしていく:
 *   波1(1-16小節)  : スネア(D)+低音ペダル(C)+FDS独奏(F)
 *   波2(17-32小節) : 2A03パルス(A,B)+VRC6(M,N,O)+VRC7 1ch(G)が旋律に合流(一部を並行移調でハモらせる)
 *   波3(33-48小節) : VRC7残り5ch(H-L)の和音パッド+N163 8ch(P-W)の和音パッド+
 *                     FME7(X,Y,Z)の刺し込みアクセント+MMC5(a,b)が旋律を上のオクターブで重ねてトゥッティに
 * A: 2A03パルス1 / B: 2A03パルス2 / C: 2A03三角波(ペダル) / D: 2A03ノイズ(スネア)
 * F: FDS / G-L: VRC7(FM) / M-O: VRC6 / P-W: N163 / X-Z: FME7 / a-b: MMC5
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Mml = MML.Mml = MML.Mml || {};

  Mml.SAMPLE_SOURCE =
`; ==========================================
; Sound Emulation Foundry - サンプルMML「ボレロ」(全音源)
; ==========================================
#TITLE Bolero (All Chips)
#COMPOSER Sound Emulation Foundry
#MAKER 2026
#EX-DISKFM
#EX-VRC7
#EX-VRC6
#EX-NAMCO106
#EX-FME7
#EX-MMC5

; 16小節のテーマ(A句8小節+B句8小節、3/4拍子)を1回だけ定義。各チャンネルはこの
; wを(K<n>で移調しつつ)必要な回数だけ呼び出して旋律を共有する
$w c4d8e8f4 e8d8c4e8f8 g4f8e8d4 c2. e4f8g8a4 g8f8e4g8a8 b4a8g8f4 g2. e4f+8g8a4 g8f+8e4d8c8 d4e-8f8g4 f2. a4b-8>c8<b4 a8g8f+4g8a8 g4e8c8d4 c2.

; --- 波1: 土台(スネア+低音ペダル)+FDS独奏、全48小節を通して鳴らす ---
A t72
C o2 v13 [c2.]48
D o4 v8 [c8c8c16c16c16c16c8c8 c8c8c8c16c16c16c16c8]24
F o5 v12 @0 w w w

; --- 波2: 17小節目から2A03パルス+VRC6+VRC7 1chが合流(32小節分) ---
A o5 v10 @1 [r2.]16 w w
B o5 v9 @2 [r2.]16 K7 w w
G o5 v11 @6 [r2.]16 w w
M o6 v9 @3 [r2.]16 w w
N o5 v8 @5 [r2.]16 K4 w w
O o4 v9 [r2.]16 K-12 w w

; --- 波3: 33小節目からVRC7和音パッド+N163和音パッド+FME7アクセント+MMC5が
;     旋律をオクターブ上で重ねてトゥッティ(16小節分) ---
H o4 v6 @1 [r2.]32 [c2.]16
I o4 v6 @1 [r2.]32 [e2.]16
J o4 v6 @9 [r2.]32 [g2.]16
K o5 v6 @1 [r2.]32 [c2.]16
L o5 v6 @9 [r2.]32 [e2.]16
P o3 v5 [r2.]32 [c2.]16
Q o3 v5 [r2.]32 [g2.]16
R o4 v5 [r2.]32 [c2.]16
S o4 v5 [r2.]32 [e2.]16
T o4 v5 [r2.]32 [g2.]16
U o5 v5 [r2.]32 [c2.]16
V o5 v5 [r2.]32 [e2.]16
W o5 v5 [r2.]32 [g2.]16
X o5 v11 q4 [r2.]32 [c8r2r8]16
Y o5 v11 q4 [r2.]32 [e8r2r8]16
Z o5 v11 q4 [r2.]32 [g8r2r8]16
a o5 v9 @1 [r2.]32 K12 w
b o5 v8 @2 [r2.]32 K19 w
`;
})(window);
