/*
 * GB音量エンベロープ(NRx2)の解析的シミュレーション
 * MML.Gbs2MmlExpansion.hwEnvelope = { volumeAt, updateAnchor }
 *
 * GB実機のエンベロープはフレームシーケンサ由来の固定64Hzクロックで、period(NRx2下位3bit)
 * クロックごとに1段階だけ増減する(src/emulator/apuGb.jsのEnvelope.clock()と同じ仕様)。
 * このクロックはドライバのPLAY呼び出し頻度(playFps、GBSリップ毎に可変。59.7275Hz等)とは
 * 完全に独立している。
 *
 * 従来の実装は「駆動フレーム境界(playFps)でスナップショットしたvolをそのまま読む」方式
 * だったが、各スナップショット自体は正確でも、64HzとplayFpsが単純な整数比にならないため
 * (例: 64/59.7275≈1.0719)、同一形状のエンベロープでもトリガーされた絶対位置によって
 * 64Hzクロックとの位相がずれ、駆動フレーム境界から観測される段数が変わってしまっていた
 * (ある音符では15段のうち14段しか観測されない、等)。これが@v<n>テーブルの
 * 「本来同じ形状のはずなのに微妙に違う」大量重複の直接原因だった(実測・原因調査は
 * gbs-envelope-64hz-aliasing-bugメモリ参照)。
 *
 * 対策として、トリガー時点(またはまれにトリガー無しのNRx2書換え時点)を起点(anchor)に、
 * 「経過ドライバフレーム数 → 経過秒数 → 64Hzクロック数 → floor(クロック数/period)段階」
 * を解析式で直接計算し直す。これなら同一の(initVol,dir,period)形状は絶対位置に関係なく
 * 常に同一の数値列を生成する(位相非依存)ため、位相ズレによる疑似重複が解消される。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Gbs2MmlExpansion = MML.Gbs2MmlExpansion || {};

  // anchor.frame起点からのドライバフレームオフセットにおける音量(0-15)。
  // frame(整数、driverフレーム番号)とplayFps(曲固有のPLAY呼び出し頻度、非整数)から
  // 経過秒数→経過64Hzクロック数を求め、period個ごとに1段階増減する実機の式を適用する。
  function volumeAt(anchor, frame, playFps) {
    if (anchor.period === 0) return anchor.initVol; // period=0はエンベロープ無効(実機仕様)
    const k = frame - anchor.frame; // anchor起点からの経過driverフレーム数(>=0)
    const steps = Math.floor((k * 64) / (playFps * anchor.period));
    const v = anchor.initVol + (anchor.dir === 1 ? steps : -steps);
    return Math.max(0, Math.min(15, v));
  }

  // 新しいanchorが必要か判定して返す(変化が無ければ既存anchorをそのまま返す)。
  // - トリガー発生時(triggered=true): 実機のEnvelope.trigger()と同じくvolume=initVolへ
  //   リセットされるため、initVol/dir/periodが前回と同じ値でも必ず起点を更新する。
  // - トリガー無しでNRx2が書き換わった場合(period/direction/initVolのいずれかが変化):
  //   ごくまれなケースだが、音符が継続中のまま音量の減衰形状だけ変わる可能性があるため
  //   その時点を新たな起点として扱う。
  function updateAnchor(anchor, c, frame, triggered) {
    if (triggered || !anchor || c.envInitVol !== anchor.initVol || c.envDir !== anchor.dir || c.envPeriod !== anchor.period) {
      return { frame, initVol: c.envInitVol, dir: c.envDir, period: c.envPeriod };
    }
    return anchor;
  }

  MML.Gbs2MmlExpansion.hwEnvelope = { volumeAt, updateAnchor };
})(window);
