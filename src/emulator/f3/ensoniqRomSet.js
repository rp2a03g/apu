/*
 * MML.Emu.EnsoniqRomSet
 *
 * アーカイブの一覧から、タイトーの Ensoniq 音源基板(F3 システム、JC システムほか: 68000+ES5505+ES5510)の ROM の組を見つける。
 *   find(entries, zip の名前) → { hi, lo, waves: [{ entry, at(語の番地) }…], info } か null
 *   parentHint(zip の名前) → その名前が MAME の子セットで、音源の ROM が親セットの zip にある時、親セットの名前(無ければ '')
 *
 * ROM の名前に決まった形が無いので、表(SETS)で引く。表は MAME の機種一覧から機械的に作った物(tools/f3/en-make-romset.js。手で直さない)。
 *   hi / lo : サウンドプログラムの上位バイト側 / 下位バイト側
 *   waves   : 波形 ROM と、置く位置(語の番地)。どれも 8bit で、語の上位バイトに入る
 *   sets    : その ROM の組を使う MAME のセット名と、その題名
 *
 * 指令はどのゲームも同じ形(ダライアス外伝、レイフォース、逆鱗弾で確かめた): 「長さ・命令・引数…」のまとまりを、共有 RAM のリングバッファ
 * (0x400 バイト)に書き、書き込み位置 × 2 を 0x480 / 0x481 に置く。曲 = [03 81 nn][04 86 nn vv]、止める = [04 86 nn 00][03 82 nn]。
 * 起動の後にメイン CPU が [03 80 01]… と [03 20 nn](エフェクトの番号)を送る。
 *
 * ゲームごとの上書き(OVERRIDE。鍵は hi の名前。実測した物だけ):
 *   boot  : 起動した後にメイン CPU が送る指令(16 進のバイト列)。無ければ DEFAULT_BOOT
 *   cmds  : ゲームのサウンドテストの番号 1〜 に対して、ゲームが送る指令(MAME でサウンドテストの番号を 1 つずつ送って採った)。
 *           これがあるゲームは、サウンドテストの番号どおりに(効果音も)鳴らせる。無いゲームは「内部の曲番号」で曲だけ鳴らす
 *   stop  : 止める時に送る番号(cmds の番号)
 *   hex   : 番号を 16 進で見せる、volume : メイン CPU が置く音量
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};
  const DEFAULT_BOOT = ['038001038002038003038004', '032000'];
  // ==== OVERRIDE ここから ====
  const OVERRIDE = {
    'd87-13.bin': { hex: true, volume: 0x30,
      boot: ['038001038002038003038004', '032000', '0421006404210108042102200421031004210425042105000421062f042107380421082004210950'],
      stop: [0x98, 0x99],
      cmds: [
      '068d01014000068e01010f62', '068d01014008068e01012763', '068d01014000068e01011360', '068d01014000068e0101145e',
      '068d01024000068e01021160', '068d01014003068e01011669', '068d01034000068e01030f62', '068d01034008068e01032763',
      '068d01034000068e01031360', '068d01034000068e0103145e', '068d01044000068e01041160', '068d01034003068e01031669',
      '068d02034000068e0203166e', '068d02034000068e02031863', '068d02084000068e02081f5a', '068d02054000068e02052068',
      '068d02054000068e02052667', '068d02064000068e0206296d', '068d02064000068e02062b6f', '068d02064000068e02062c78',
      '068d01074000068e01072e72', '068d01074001068e0107146c', '068d01084001068e01081e73', '068d01084001068e01082b70',
      '068d01074001068e0107266e', '068d01054001068e0105326a', '068d01064001068e01063365', '068d02074001068e02073567',
      '068d02034001068e0203376f', '068d03014004068e03012769', '068d03014004068e0301336e', '068d03014002068e03011176',
      '068d03014002068e03011371', '068d02014004068e02011b70', '068d02014005068e02011b69', '068d02084002068e02081465',
      '068d02044002068e02041672', '068d01014002068e01011861', '068d02044002068e02041a6c', '068d02034002068e02031b69',
      '068d02044002068e02041d6a', '068d02044002068e02041f70', '068d02014005068e0201276c', '068d02054003068e0205116a',
      '068d03014003068e03011471', '068d02024005068e0202336e', '068d02024006068e02021b6c', '068d02024006068e02022764',
      '068d02014006068e02013368', '068d01064007068e01061b67', '068d01054007068e01052769', '068d01064007068e01063367',
      '068d01054008068e01053367', '068d02024009068e02022770', '068d03084002068e03081b61', '068d03084000068e03082c61',
      '068d03084003068e03081f71', '068d0308400a068e03080f6e', '068d03084003068e03081866', '068d03084003068e03081a65',
      '068d03084003068e03081b78', '068d03084008068e03081b69', '068d0308400b068e0308276e', '068d03084003068e03081d6e',
      '03811504861573', '03810504860579', '03810604860672', '0381070486077a',
      '0381080486087c', '0381090486096a', '03810a04860a79', '03810b04860b74',
      '03810c04860c78', '03810d04860d7c', '03810e04860e7b', '03810f04860f77',
      '03811004861075', '03811104861177', '03811204861277', '03811304861377',
      '03811404861477', '03811604861675', '03811604861673', '068d01014000068e01010f66',
      '068d01014008068e01012767', '068d01014000068e01011364', '068d01014000068e01011462', '068d01024000068e01021164',
      '068d01014003068e0101166d', '068d01034000068e01030f66', '068d01034008068e01032767', '068d01034000068e01031364',
      '068d01034000068e01031462', '068d01044000068e01041164', '068d01034003068e0103166d', '068d02034000068e02031672',
      '068d02034000068e02031867', '068d04014000068e04011f5e', '068d04034000068e0403206c', '068d04034000068e0403266b',
      '068d04054000068e04052971', '068d04024000068e04022b73', '068d04014000068e04012c7d', '068d04064000068e04062e76',
      '068d04054001068e04051470', '068d04064001068e04061e77', '068d01084001068e01082b74', '068d01074001068e01072672',
      '068d04044001068e0404326e', '068d04054001068e04053369', '068d04064001068e0406356b', '068d02034001068e02033773',
      '068d04074004068e0407276d', '068d04074004068e04073372', '068d04084002068e0408117a', '068d04074002068e04071375',
      '068d04064004068e04061b74', '068d04064005068e04061b6d', '068d04024002068e04021469', '068d04054002068e04051676',
      '068d04014002068e04011865', '068d04064002068e04061a70', '068d02034002068e02031b6d', '068d04024002068e04021d6e',
      '068d04024002068e04021f74', '068d04064005068e04062770', '068d04024003068e0402116e', '068d03014003068e03011475',
      '068d04084005068e04083372', '068d04074006068e04071b70', '068d04074006068e04072768', '068d04084006068e04083366',
      '068d04054007068e04051b6b', '068d04054007068e0405276d', '068d04054007068e0405336b', '068d04054008068e0405336b',
      '068d02024009068e02022774', '068d03084002068e03081b65', '068d03084000068e03082c65', '068d04024003068e04021f75',
      '068d0402400a068e04020f72', '068d04034003068e0403186a', '068d04044003068e04041a69', '068d04024003068e04021b7c',
      '068d04084008068e04081b6d', '068d0208400b068e02082772', '068d04054003068e04051d72', '032000',
      '0421006404210108042102200421031004210425042105000421062f042107380421082004210950', '032005', '04210040042101000421020c0421031a042104950421050004210668042107400421082704210934', '038201038202038203038204',
      '03820503820603820703820803820903820a03820b03820c03820d03820e03820f038210038211038212038213038214038215038216'
      ] }
  };
  // ==== OVERRIDE ここまで ====
  const SETS = [
    { game: 'Arabian Magic', sets: [['arabianm', 'Arabian Magic'], ['arabianmj', 'Arabian Magic'], ['arabianmu', 'Arabian Magic']], hi: 'd29-18.ic5', lo: 'd29-19.ic6', waves: [['d29-01.ic17', 0x0], ['d29-02.ic18', 0x300000]] },
    { game: 'Arkanoid Returns', sets: [['arkretrn', 'Arkanoid Returns'], ['arkretrnj', 'Arkanoid Returns'], ['arkretrnu', 'Arkanoid Returns']], hi: 'e36-12.32', lo: 'e36-13.33', waves: [['e36-04.38', 0x0]] },
    { game: 'Bubble Bobble II', sets: [['bublbob2', 'Bubble Bobble II'], ['bublbob2o', 'Bubble Bobble II'], ['bubsymphe', 'Bubble Symphony'], ['bubsymphj', 'Bubble Symphony'], ['bubsymphu', 'Bubble Symphony']], hi: 'd90-13.ic32', lo: 'd90-14.ic33', waves: [['d90-04', 0x0], ['d90-05', 0x200000]] },
    { game: 'Bubble Bobble II', sets: [['bublbob2p', 'Bubble Bobble II']], hi: 'snd-h-348f.ic66', lo: 'snd-l-4ec1.ic65', waves: [['cq80-snd-data0-7b5f.ic43', 0x0], ['cq80-snd-data1-933b.ic44', 0x80000], ['cq80-snd3-std5-3a9c.ic10', 0x300000], ['cq80-snd2-std6-a148.ic11', 0x380000]] },
    { game: 'Bubble Memories: The Story Of Bubble Bobble III', sets: [['bubblem', 'Bubble Memories: The Story Of Bubble Bobble III'], ['bubblemj', 'Bubble Memories: The Story Of Bubble Bobble III'], ['bubblemu', 'Bubble Memories: The Story Of Bubble Bobble III']], hi: 'e21-12.32', lo: 'e21-13.33', waves: [['e21-03.rom', 0x0], ['e21-04.rom', 0x200000]] },
    { game: 'Bust-A-Move Again', sets: [['pbobble2u', 'Bust-A-Move Again']], hi: 'e10-16.32', lo: 'e10-17.33', waves: [['e10-04.rom', 0x0], ['e10-03.rom', 0x200000]] },
    { game: 'Chase Bombers', sets: [['cbombers', 'Chase Bombers'], ['cbombersj', 'Chase Bombers']], hi: 'd83_26.ic37', lo: 'd83_27.ic38', waves: [['d83_02.ic39', 0x0], ['d83_03.ic18', 0x400000], ['d83_01.ic40', 0x600000]] },
    { game: 'Chase Bombers', sets: [['cbombersp', 'Chase Bombers']], hi: 'ic47_eprg_h_up_c5c5.bin', lo: 'ic46_eprg_l_low_d5e.bin', waves: [['ic84_0816_wave0.bin', 0x0], ['ic85_8058_wave1.bin', 0x80000], ['ic86_9e88_wave2.bin', 0x100000], ['ic87_42e7_wave3.bin', 0x180000], ['ic88_2704_wave4.bin', 0x200000], ['ic107_3a9c_wave14.bin', 0x700000], ['ic108_a148_wave15.bin', 0x780000]] },
    { game: 'Cleopatra Fortune', sets: [['cleopatr', 'Cleopatra Fortune'], ['cleopatro', 'Cleopatra Fortune']], hi: 'e28-11.bin', lo: 'e28-12.bin', waves: [['e28-03.bin', 0x0]] },
    { game: 'Command War - Super Special Battle & War Game', sets: [['commandw', 'Command War - Super Special Battle & War Game']], hi: 'cw_spr1.bin', lo: 'cw_spr0.bin', waves: [['cw_pcm_0.bin', 0x0], ['cw_pcm_1.bin', 0x200000]] },
    { game: 'Dan-Ku-Ga', sets: [['dankuga', 'Dan-Ku-Ga'], ['gblchmp', 'Global Champion'], ['kaiserkn', 'Kaiser Knuckle'], ['kaiserknj', 'Kaiser Knuckle']], hi: 'd84-26.32', lo: 'd84-27.33', waves: [['d84-01.rom', 0x200000], ['d84-02.rom', 0x400000], ['d84-15.rom', 0x700000]] },
    { game: 'Dangerous Curves', sets: [['dangcurv', 'Dangerous Curves'], ['dangcurvj', 'Dangerous Curves']], hi: 'e09-28.ic31', lo: 'e09-27.ic30', waves: [['e09-17.ic32', 0x0], ['e09-18.ic33', 0x200000], ['e09-19.ic34', 0x400000], ['e09-20.ic35', 0x600000]] },
    { game: 'Darius Gaiden - Silver Hawk', sets: [['dariusg', 'Darius Gaiden - Silver Hawk'], ['dariusgj', 'Darius Gaiden - Silver Hawk'], ['dariusgu', 'Darius Gaiden - Silver Hawk'], ['dariusgx', 'Darius Gaiden - Silver Hawk Extra Version']], hi: 'd87-13.bin', lo: 'd87-14.bin', waves: [['d87-01.bin', 0x0], ['d87-02.bin', 0x200000]] },
    { game: 'Densha de GO!', sets: [['dendego', 'Densha de GO!'], ['dendegoa', 'Densha de GO!'], ['dendegox', 'Densha de GO! EX']], hi: 'e35-26.ic31', lo: 'e35-25.ic30', waves: [['e35-17.ic32', 0x0], ['e35-18.ic33', 0x200000], ['e35-19.ic34', 0x400000], ['e35-20.ic35', 0x600000]] },
    { game: 'Densha de GO! 2 Kousoku-hen', sets: [['dendego2', 'Densha de GO! 2 Kousoku-hen'], ['dendego23k', 'Densha de GO! 2 Kousoku-hen 3000-bandai']], hi: 'e52-30.ic31', lo: 'e52-29.ic30', waves: [['e52-21.ic32', 0x0], ['e52-22.ic33', 0x200000], ['e52-23.ic34', 0x400000], ['e52-24.ic35', 0x600000]] },
    { game: 'Elevator Action Returns', sets: [['elvact2u', 'Elevator Action II'], ['elvactr', 'Elevator Action Returns'], ['elvactrj', 'Elevator Action Returns']], hi: 'e02-13.32', lo: 'e02-14.33', waves: [['e02-04.38', 0x0], ['e02-05.39', 0x200000]] },
    { game: 'Galactic Storm', sets: [['galastrm', 'Galactic Storm']], hi: 'c99_23.ic8', lo: 'c99_22.ic7', waves: [['c99-08.ic3', 0x0], ['c99-09.ic4', 0x100000], ['c99-10.ic5', 0x200000], ['c99-07.ic2', 0x340000]] },
    { game: 'Gekirindan', sets: [['gekiridn', 'Gekirindan'], ['gekiridnj', 'Gekirindan']], hi: 'e11-13.ic32', lo: 'e11-14.ic33', waves: [['e11-04.ic38', 0x0], ['e11-05.ic41', 0x200000]] },
    { game: 'Grid Seeker: Project Storm Hammer', sets: [['gseeker', 'Grid Seeker: Project Storm Hammer'], ['gseekerj', 'Grid Seeker: Project Storm Hammer'], ['gseekeru', 'Grid Seeker: Project Storm Hammer']], hi: 'd40_07.rom', lo: 'd40_08.rom', waves: [['d40_01.rom', 0x0], ['d40_02.rom', 0x300000]] },
    { game: 'Ground Effects / Super Ground Effects', sets: [['groundfx', 'Ground Effects / Super Ground Effects']], hi: 'd51-29.54', lo: 'd51-30.56', waves: [['d51-01.73', 0x0], ['d51-02.74', 0x600000]] },
    { game: 'Gunbuster', sets: [['gunbustr', 'Gunbuster'], ['gunbustrj', 'Gunbuster'], ['gunbustru', 'Gunbuster']], hi: 'd27-25.bin', lo: 'd27-24.bin', waves: [['d27-08.bin', 0x0], ['d27-09.bin', 0x100000], ['d27-10.bin', 0x300000]] },
    { game: 'Gunlock', sets: [['gunlock', 'Gunlock'], ['rayforce', 'RayForce'], ['rayforcej', 'RayForce']], hi: 'd66-23.ic10', lo: 'd66-22.ic23', waves: [['d66-01.ic2', 0x0], ['d66-02.ic3', 0x200000]] },
    { game: 'Gunlock', sets: [['gunlocko', 'Gunlock']], hi: 'd66-23.ic10', lo: 'd66-22.ic23', waves: [['snd0.ic8', 0x0], ['snd1.ic7', 0x80000], ['snd2.ic6', 0x100000], ['snd3.ic5', 0x180000], ['snd4.ic4', 0x200000], ['snd5.ic3', 0x280000], ['snd6.ic2', 0x300000], ['snd7.ic1', 0x380000]] },
    { game: 'International Cup \'94', sets: [['hthero94', 'Hat Trick Hero \'94'], ['intcup94', 'International Cup \'94']], hi: 'd78-08.32', lo: 'd78-09.33', waves: [['d49-04.38', 0x0], ['d49-05.41', 0x300000]] },
    { game: 'Kirameki Star Road', sets: [['kirameki', 'Kirameki Star Road']], hi: 'e44-20.51', lo: 'e44-21.52', waves: [['e44-07.38', 0x0], ['e44-08.39', 0x400000]] },
    { game: 'Land Maker', sets: [['landmakr', 'Land Maker'], ['landmakrj', 'Land Maker']], hi: 'e61-14.32', lo: 'e61-15.33', waves: [['e61-04.38', 0x200000], ['e61-05.39', 0x400000], ['e61-06.40', 0x600000]] },
    { game: 'Land Maker', sets: [['landmakrp', 'Land Maker']], hi: 'spro-1.66', lo: 'spro-0.65', waves: [['snd-0.43', 0x200000], ['snd-1.44', 0x280000], ['snd-2.45', 0x300000], ['snd-3.46', 0x380000], ['snd-4.32', 0x400000], ['snd-5.33', 0x480000], ['snd-6.34', 0x500000], ['snd-7.35', 0x580000], ['snd-8.20', 0x600000], ['snd-9.21', 0x680000], ['snd-10.22', 0x700000], ['snd-11.23', 0x780000]] },
    { game: 'Landing Gear', sets: [['landgear', 'Landing Gear'], ['landgeara', 'Landing Gear'], ['landgearj', 'Landing Gear'], ['landgearja', 'Landing Gear']], hi: 'e17-22.ic31', lo: 'e17-21.ic30', waves: [['e17-13.ic32', 0x0], ['e17-14.ic33', 0x200000], ['e17-15.ic34', 0x400000], ['e17-16.ic35', 0x600000]] },
    { game: 'Light Bringer', sets: [['dungeonm', 'Dungeon Magic'], ['dungeonmu', 'Dungeon Magic'], ['lightbr', 'Light Bringer'], ['lightbrj', 'Light Bringer']], hi: 'd69-18.bin', lo: 'd69-19.bin', waves: [['d69-01.bin', 0x0], ['d69-02.bin', 0x200000]] },
    { game: 'Moriguchi Hiroko no Quiz de Hyuu!Hyuu!', sets: [['quizhuhu', 'Moriguchi Hiroko no Quiz de Hyuu!Hyuu!']], hi: 'e08-18.32', lo: 'e08-17.33', waves: [['e08-07.38', 0x200000], ['e08-08.39', 0x400000], ['e08-09.41', 0x600000]] },
    { game: 'Pop\'n Pop', sets: [['popnpop', 'Pop\'n Pop'], ['popnpopj', 'Pop\'n Pop'], ['popnpopu', 'Pop\'n Pop']], hi: 'e51-13.32', lo: 'e51-14.33', waves: [['e51-04.38', 0x0], ['e51-05.41', 0x200000]] },
    { game: 'Puchi Carat', sets: [['puchicarj', 'Puchi Carat']], hi: 'e46-19.ic32', lo: 'e46-20.ic33', waves: [['e46-07.ic38', 0x200000], ['e46-08.ic39', 0x400000], ['e46-09.ic40', 0x600000]] },
    { game: 'Puchi Carat', sets: [['puchicar', 'Puchi Carat'], ['puchicaru', 'Puchi Carat']], hi: 'e46-21.ic32', lo: 'e46-22.ic33', waves: [['e46-07.ic38', 0x200000], ['e46-08.ic39', 0x400000], ['e46-09.ic40', 0x600000]] },
    { game: 'Puzzle Bobble 2', sets: [['pbobble2', 'Puzzle Bobble 2'], ['pbobble2j', 'Puzzle Bobble 2'], ['pbobble2o', 'Puzzle Bobble 2']], hi: 'e10-12.32', lo: 'e10-13.33', waves: [['e10-04.rom', 0x0], ['e10-03.rom', 0x200000]] },
    { game: 'Puzzle Bobble 2X', sets: [['pbobble2x', 'Puzzle Bobble 2X']], hi: 'e10-30.32', lo: 'e10-31.33', waves: [['e10-04.rom', 0x0], ['e10-03.rom', 0x200000]] },
    { game: 'Puzzle Bobble 3', sets: [['pbobble3j', 'Puzzle Bobble 3']], hi: 'e29-13.ic32', lo: 'e29-14.ic33', waves: [['e29-03.ic38', 0x200000], ['e29-04.ic39', 0x400000], ['e29-05.ic41', 0x600000]] },
    { game: 'Puzzle Bobble 3', sets: [['pbobble3', 'Puzzle Bobble 3'], ['pbobble3u', 'Puzzle Bobble 3']], hi: 'e29-13.rom', lo: 'e29-14.rom', waves: [['e29-03.rom', 0x200000], ['e29-04.rom', 0x400000], ['e29-05.rom', 0x600000]] },
    { game: 'Puzzle Bobble 4', sets: [['pbobble4', 'Puzzle Bobble 4'], ['pbobble4j', 'Puzzle Bobble 4'], ['pbobble4u', 'Puzzle Bobble 4']], hi: 'e49-13.32', lo: 'e49-14.33', waves: [['e49-03', 0x200000], ['e49-04', 0x400000], ['e49-05', 0x600000]] },
    { game: 'Quiz Theater - 3tsu no Monogatari', sets: [['qtheater', 'Quiz Theater - 3tsu no Monogatari']], hi: 'd95-07.32', lo: 'd95-08.33', waves: [['d95-03.38', 0x0], ['d95-04.41', 0x200000]] },
    { game: 'Recalhorn', sets: [['recalh', 'Recalhorn']], hi: 'rh_spr1.bin', lo: 'rh_spr0.bin', waves: [['rh_snd0.bin', 0x0], ['rh_snd1.bin', 0x300000]] },
    { game: 'Riding Fight', sets: [['ridingf', 'Riding Fight'], ['ridingfj', 'Riding Fight'], ['ridingfu', 'Riding Fight']], hi: 'd34-07.5', lo: 'd34-08.6', waves: [['d34-03.17', 0x0], ['d34-04.18', 0x300000]] },
    { game: 'Ring Rage', sets: [['ringrage', 'Ring Rage'], ['ringragej', 'Ring Rage'], ['ringrageu', 'Ring Rage']], hi: 'd21-18.5', lo: 'd21-19.6', waves: [['d21-01.17', 0x0], ['d21-05.18', 0x300000]] },
    { game: 'Side by Side', sets: [['sidebs', 'Side by Side'], ['sidebsj', 'Side by Side'], ['sidebsja', 'Side by Side'], ['sidebsjb', 'Side by Side']], hi: 'e23-24.ic31', lo: 'e23-23.ic30', waves: [['e23-15.ic32', 0x0], ['e23-16.ic33', 0x200000], ['e23-17.ic34', 0x400000], ['e23-18.ic35', 0x600000]] },
    { game: 'Side by Side 2', sets: [['sidebs2', 'Side by Side 2'], ['sidebs2j', 'Side by Side 2 Evoluzione RR'], ['sidebs2ja', 'Side by Side 2 Evoluzione'], ['sidebs2u', 'Side by Side 2']], hi: 'e38-20.ic31', lo: 'e38-19.ic30', waves: [['e23-15.ic32', 0x0], ['e38-17.ic33', 0x200000], ['e38-18.ic34', 0x400000], ['e38-21.ic35', 0x600000]] },
    { game: 'Space Invaders \'95: The Attack Of Lunar Loonies', sets: [['akkanvdr', 'Akkanvader'], ['spcinv95', 'Space Invaders \'95: The Attack Of Lunar Loonies'], ['spcinv95u', 'Space Invaders \'95: The Attack Of Lunar Loonies']], hi: 'e06-09.32', lo: 'e06-10.33', waves: [['e06-04', 0x0], ['e06-05', 0x200000]] },
    { game: 'Space Invaders DX', sets: [['spcinvdj', 'Space Invaders DX']], hi: 'd93-05.bin', lo: 'd93-06.bin', waves: [['d93-11.38', 0x0], ['d93-12.39', 0x80000], ['d93-13.40', 0x100000], ['d93-14.41', 0x180000]] },
    { game: 'Super Chase - Criminal Termination', sets: [['superchsj', 'Super Chase - Criminal Termination']], hi: 'd46-30.ic8', lo: 'd46-29.ic7', waves: [['d46-09.ic4', 0x0], ['d46-08.ic5', 0x400000], ['d46-10.ic2', 0x600000]] },
    { game: 'Super Chase - Criminal Termination', sets: [['superchs', 'Super Chase - Criminal Termination'], ['superchsu', 'Super Chase - Criminal Termination']], hi: 'd46-37.ic8', lo: 'd46-36.ic7', waves: [['d46-12.ic4', 0x0], ['d46-11.ic5', 0x400000], ['d46-10.ic2', 0x600000]] },
    { game: 'Super Chase - Criminal Termination', sets: [['superchsp2', 'Super Chase - Criminal Termination']], hi: 'ic8_upper_0040.ic8', lo: 'ic7_lower_a960.ic7', waves: [['0wave.ic1', 0x0], ['1wave.ic2', 0x80000], ['2wave.ic3', 0x100000], ['3wave.ic4', 0x180000], ['4wave.ic5', 0x200000], ['5wave.ic6', 0x280000], ['6wave.ic7', 0x300000], ['7wave.ic8', 0x380000], ['8wave.ic11', 0x600000], ['9wave.ic12', 0x680000], ['10wave.ic13', 0x700000], ['11wave.ic14', 0x780000]] },
    { game: 'Super Chase - Criminal Termination', sets: [['superchsp', 'Super Chase - Criminal Termination']], hi: 'sound_ic8_upper.bin', lo: 'sound_ic7_lower.bin', waves: [['0wave.ic1', 0x0], ['1wave.ic2', 0x80000], ['2wave.ic3', 0x100000], ['3wave.ic4', 0x180000], ['4wave.ic5', 0x200000], ['5wave.ic6', 0x280000], ['6wave.ic7', 0x300000], ['7wave.ic8', 0x380000]] },
    { game: 'Super Cup Finals', sets: [['scfinals', 'Super Cup Finals']], hi: 'd49-17.ic5', lo: 'd49-18.ic6', waves: [['d49-04.38', 0x0], ['d49-05.41', 0x300000]] },
    { game: 'Taito Cup Finals', sets: [['cupfinal', 'Taito Cup Finals'], ['hthero93', 'Hat Trick Hero \'93'], ['hthero93u', 'Hat Trick Hero \'93'], ['scfinalso', 'Super Cup Finals'], ['scfinalsoc', 'Super Cup Finals']], hi: 'd49-17.32', lo: 'd49-18.33', waves: [['d49-04.38', 0x0], ['d49-05.41', 0x300000]] },
    { game: 'Taito Power Goal', sets: [['hthero95', 'Hat Trick Hero \'95'], ['hthero95a', 'Hat Trick Hero \'95'], ['hthero95u', 'Hat Trick Hero \'95'], ['pwrgoal', 'Taito Power Goal']], hi: 'd94-19.bin', lo: 'd94-20.bin', waves: [['d94-10.bin', 0x0], ['d94-11.bin', 0x200000]] },
    { game: 'Top Ranking Stars', sets: [['prmtmfgt', 'Prime Time Fighter'], ['prmtmfgto', 'Prime Time Fighter'], ['trstar', 'Top Ranking Stars'], ['trstarj', 'Top Ranking Stars'], ['trstaro', 'Top Ranking Stars'], ['trstaroj', 'Top Ranking Stars']], hi: 'd53-13.10', lo: 'd53-14.23', waves: [['d53-01.2', 0x0], ['d53-02.3', 0x200000]] },
    { game: 'Twin Cobra II', sets: [['ktiger2', 'Kyukyoku Tiger II'], ['tcobra2', 'Twin Cobra II'], ['tcobra2u', 'Twin Cobra II']], hi: 'e15-15.ic32', lo: 'e15-16.ic33', waves: [['e15-05.ic38', 0x0], ['e15-06.ic41', 0x200000]] },
    { game: 'Twin Qix', sets: [['twinqix', 'Twin Qix']], hi: 'spr0-1.b66', lo: 'spr0-0.b65', waves: [['snd-0.b43', 0x0], ['snd-1.b44', 0x80000], ['snd-14.b10', 0x100000], ['snd-15.b11', 0x180000]] },
    { game: 'Under Fire', sets: [['undrfire', 'Under Fire'], ['undrfirej', 'Under Fire'], ['undrfireu', 'Under Fire']], hi: 'd67-20', lo: 'd67-21', waves: [['d67-01', 0x0], ['d67-02', 0x600000]] }
  ];
  const PARENT_OF = {"akkanvdr":"spcinv95","arabianmj":"arabianm","arabianmu":"arabianm","arkretrnj":"arkretrn","arkretrnu":"arkretrn","bubblemj":"bubblem","bubblemu":"bubblem","bublbob2o":"bublbob2","bublbob2p":"bublbob2","bubsymphe":"bublbob2","bubsymphj":"bublbob2","bubsymphu":"bublbob2","cbombersj":"cbombers","cbombersp":"cbombers","cleopatro":"cleopatr","dangcurvj":"dangcurv","dariusgj":"dariusg","dariusgu":"dariusg","dendego23k":"dendego2","dendegoa":"dendego","dendegox":"dendego","dungeonm":"lightbr","dungeonmu":"lightbr","elvact2u":"elvactr","elvactrj":"elvactr","gblchmp":"kaiserkn","gekiridnj":"gekiridn","gseekerj":"gseeker","gseekeru":"gseeker","gunbustrj":"gunbustr","gunbustru":"gunbustr","gunlocko":"gunlock","hthero93":"cupfinal","hthero93u":"cupfinal","hthero94":"intcup94","hthero95":"pwrgoal","hthero95a":"pwrgoal","hthero95u":"pwrgoal","kaiserknj":"kaiserkn","ktiger2":"tcobra2","landgeara":"landgear","landgearj":"landgear","landgearja":"landgear","landmakrj":"landmakr","landmakrp":"landmakr","lightbrj":"lightbr","pbobble2j":"pbobble2","pbobble2o":"pbobble2","pbobble2u":"pbobble2","pbobble2x":"pbobble2","pbobble3j":"pbobble3","pbobble3u":"pbobble3","pbobble4j":"pbobble4","pbobble4u":"pbobble4","popnpopj":"popnpop","popnpopu":"popnpop","prmtmfgt":"trstar","prmtmfgto":"trstar","puchicarj":"puchicar","puchicaru":"puchicar","rayforce":"gunlock","rayforcej":"gunlock","ridingfj":"ridingf","ridingfu":"ridingf","ringragej":"ringrage","ringrageu":"ringrage","scfinalso":"scfinals","scfinalsoc":"scfinals","sidebs2j":"sidebs2","sidebs2ja":"sidebs2","sidebs2u":"sidebs2","sidebsj":"sidebs","sidebsja":"sidebs","sidebsjb":"sidebs","spcinv95u":"spcinv95","spcinvdj":"spacedx","superchsj":"superchs","superchsp":"superchs","superchsp2":"superchs","superchsu":"superchs","tcobra2u":"tcobra2","trstarj":"trstar","trstaro":"trstar","trstaroj":"trstar","undrfirej":"undrfire","undrfireu":"undrfire"};
  const base = (name) => String(name || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  function find(entries, zipName) {
    const files = (entries || []).filter((e) => !e.isDir), by = new Map(files.map((e) => [base(e.name), e]));
    for (const s of SETS) {
      const hi = by.get(s.hi), lo = by.get(s.lo), waves = s.waves.map((w) => ({ entry: by.get(w[0]), at: w[1] }));
      if (!hi || !lo || !waves.every((w) => w.entry)) continue;
      // ゲーム名は zip の名前(MAME のセット名)で選ぶ: 同じ音源の ROM を、題名の違うゲームが使う事がある
      const o = OVERRIDE[s.hi] || {}, stem = base(zipName).replace(/\.[^.]+$/, ''), mine = s.sets.find((x) => x[0] === stem);
      return { hi, lo, waves, info: Object.assign({ game: mine ? mine[1] : s.game, boot: DEFAULT_BOOT, hex: true, volume: 0x30 }, o) };
    }
    return null;
  }
  function parentHint(zipName) { const stem = base(zipName).replace(/\.[^.]+$/, ''); return PARENT_OF[stem] || ''; }
  const bytes = (hex) => { const b = []; for (let i = 0; i + 1 < hex.length; i += 2) b.push(parseInt(hex.substr(i, 2), 16)); return b; };
  Emu.EnsoniqRomSet = { find, parentHint, bytes, SETS, OVERRIDE, DEFAULT_BOOT };
})(typeof globalThis !== 'undefined' ? globalThis : this);
