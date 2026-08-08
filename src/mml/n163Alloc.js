/*
 * N163(Namco163)内蔵RAMの波形バイト領域を、曲の実際の使用状況に合わせて
 * 動的に割り当てる共有バッファアロケータ。
 *
 * N163は128byte内蔵RAMのうちレジスタ領域($40-$7F、8byte×8ch)を除いた$00-$3F
 * (64byte=128ニブルサンプル)を波形データに使える。この64byteを「時間軸で
 * 重ならない範囲だけ」複数の@N<n>インスツルメントで使い回す(同じインスツルメントを
 * 複数chが同時に使う場合は同じ領域を共有し、使われなくなったら解放して別の
 * インスツルメントに再利用させる)。
 *
 * compiler.js(ブラウザプレビュー)とppmckDriver.js(NSF書き出し)の両方から
 * このモジュール1箇所だけを呼ぶことで、周波数/波形長換算式が2箇所で食い違って
 * 壊れた過去のN163バグ([[n163-rewrite]]参照)と同じ種類の事故を防ぐ。
 *
 * MML.N163Alloc.allocate(letters, segmentsByChannel, nMap, totalFrames)
 *   -> { occurrences: [...], conflicts: [...] }
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const N163Alloc = MML.N163Alloc = MML.N163Alloc || {};
  // 表示文言の翻訳 (src/i18n/i18n.js)。キーは日本語の原文。MML.I18nが無い環境でも動くよう素通し
  const T = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  // デフォルト波形用の予約領域は作らない(ユーザー確認済み)。
  // @N<n>を一度も呼ばないchの波形内容は不定になる既知の制限として許容する。
  N163Alloc.MAX_BYTES = 64;
  N163Alloc.MAX_SAMPLE_LEN = N163Alloc.MAX_BYTES * 2; // 128サンプル(1バッファがRAM全部を使う場合の上限)

  // 実機のレジスタ丸め: lengthByte=(256-len)&0xFC、実際の再生長=256-lengthByte。
  // どんなlenも4の倍数へ切り上げられる。この式はここ1箇所だけに置き、
  // compiler.js/ppmckDriver.jsはどちらもここを呼ぶ(ローカルに再実装しない)。
  N163Alloc.roundedLen = function (len) {
    const clamped = Math.max(1, Math.min(256, len || 0));
    const lengthByte = (256 - clamped) & 0xFC;
    return 256 - lengthByte;
  };
  N163Alloc.lengthByte = function (len) {
    return (256 - N163Alloc.roundedLen(len)) & 0xFC;
  };
  N163Alloc.byteLen = function (len) {
    return N163Alloc.roundedLen(len) / 2;
  };

  // segmentsToWriteLogN163(compiler.js)のリロード検知条件と完全に同じ条件で、
  // 「あるインスツルメントが連続してロードされている区間」の列を作る。
  // 休符(seg.freq==null)は区間を終わらせない(直前のロード状態を保持し続ける。
  // ユーザー確認済みの仕様: 休符中も領域を保持し、次の別インスツルメント切替でのみ解放)。
  N163Alloc.extractLoadIntervals = function (segments, nMap, totalFrames) {
    const intervals = [];
    let frame = 0, lastInstrument = null, cur = null;
    for (const seg of (segments || [])) {
      const dur = seg.durationFrames || 0;
      if (seg.freq != null && nMap && nMap[seg.instrument] && seg.instrument !== lastInstrument) {
        if (cur) { cur.endFrameExclusive = frame; intervals.push(cur); }
        cur = { instrument: seg.instrument, startFrame: frame, endFrameExclusive: totalFrames };
        lastInstrument = seg.instrument;
      }
      frame += dur;
    }
    if (cur) intervals.push(cur);
    return intervals;
  };

  // フリーリスト(ソート済み{start,len}の配列)から最初に収まる領域を確保する(first-fit)
  function firstFit(freeList, needBytes) {
    for (let i = 0; i < freeList.length; i++) {
      if (freeList[i].len >= needBytes) {
        const region = { start: freeList[i].start, len: needBytes };
        if (freeList[i].len === needBytes) {
          freeList.splice(i, 1);
        } else {
          freeList[i] = { start: freeList[i].start + needBytes, len: freeList[i].len - needBytes };
        }
        return region;
      }
    }
    return null;
  }

  // 解放した領域をフリーリストへ戻し、隣接する空き領域と結合する
  function freeAndCoalesce(freeList, region) {
    freeList.push({ start: region.start, len: region.len });
    freeList.sort((a, b) => a.start - b.start);
    for (let i = 0; i < freeList.length - 1; i++) {
      if (freeList[i].start + freeList[i].len === freeList[i + 1].start) {
        freeList[i] = { start: freeList[i].start, len: freeList[i].len + freeList[i + 1].len };
        freeList.splice(i + 1, 1);
        i--;
      }
    }
  }

  function makeOccurrence(e, region, nMap) {
    const rawLen = (nMap && nMap[e.instrument]) ? nMap[e.instrument].length : 0;
    return {
      channel: e.channel,
      instrument: e.instrument,
      startFrame: e.iv.startFrame,
      endFrameExclusive: e.iv.endFrameExclusive,
      byteOffset: region.start,
      byteLen: region.len,
      lengthByte: N163Alloc.lengthByte(rawLen)
    };
  }

  // letters: N163に割り当てられたチャンネル文字配列(assignExpansionLetters準拠)
  // segmentsByChannel: { channelLetter: [segment,...] }
  // nMap: envelopes.n ({ instrumentIndex: number[] })
  // 戻り値: { occurrences: [{channel,instrument,startFrame,endFrameExclusive,
  //           byteOffset,byteLen,lengthByte}], conflicts: [{frame,channel,instrument,message}] }
  N163Alloc.allocate = function (letters, segmentsByChannel, nMap, totalFrames) {
    const events = [];
    for (const ch of (letters || [])) {
      const intervals = N163Alloc.extractLoadIntervals((segmentsByChannel || {})[ch], nMap, totalFrames);
      for (const iv of intervals) {
        events.push({ kind: 'acquire', frame: iv.startFrame, channel: ch, instrument: iv.instrument, iv });
        events.push({ kind: 'release', frame: iv.endFrameExclusive, channel: ch, instrument: iv.instrument, iv });
      }
    }
    // 同フレームではrelease→acquireの順に処理する(再利用機会を最大化するため)
    events.sort((a, b) => a.frame - b.frame || (a.kind === 'release' ? -1 : 1) - (b.kind === 'release' ? -1 : 1));

    const freeList = [{ start: 0, len: N163Alloc.MAX_BYTES }];
    const keyOf = e => e.channel + '|' + e.instrument + '|' + e.iv.startFrame;
    const allocMap = new Map();           // occurrenceKey -> region({start,len})
    const activeByInstrument = new Map(); // instrument -> Set(occurrenceKey) (現在アクティブな参照)
    const occurrences = [];
    const conflicts = [];

    for (const e of events) {
      const k = keyOf(e);
      if (e.kind === 'release') {
        const region = allocMap.get(k);
        allocMap.delete(k);
        const set = activeByInstrument.get(e.instrument);
        if (set) {
          set.delete(k);
          if (set.size === 0) {
            activeByInstrument.delete(e.instrument);
            if (region) freeAndCoalesce(freeList, region);
          }
        }
        continue;
      }
      // acquire: 同じインスツルメントが既に他chでアクティブなら領域を共有する
      const already = activeByInstrument.get(e.instrument);
      if (already && already.size > 0) {
        const region = allocMap.get(already.values().next().value);
        allocMap.set(k, region);
        already.add(k);
        occurrences.push(makeOccurrence(e, region, nMap));
        continue;
      }
      const rawLen = (nMap && nMap[e.instrument]) ? nMap[e.instrument].length : 0;
      if (rawLen === 0) continue; // 定義が見つからない(通常起きない、防御的)
      if (rawLen > N163Alloc.MAX_SAMPLE_LEN) {
        conflicts.push({
          frame: e.frame, channel: e.channel, instrument: e.instrument,
          message: T('@N{instrument} の波形長{len}サンプルはN163内蔵RAMの空き容量(最大{max}サンプル)を超えています',
            { instrument: e.instrument, len: rawLen, max: N163Alloc.MAX_SAMPLE_LEN })
        });
        continue;
      }
      const needBytes = N163Alloc.byteLen(rawLen);
      const region = firstFit(freeList, needBytes);
      if (!region) {
        conflicts.push({
          frame: e.frame, channel: e.channel, instrument: e.instrument,
          message: T('フレーム{frame}: @N{instrument}(ch{channel})をN163内蔵RAMに配置できません({bytes}byte必要・空き不足。同時使用中の波形の合計が128バイトを超えています)',
            { frame: e.frame, instrument: e.instrument, channel: e.channel, bytes: needBytes })
        });
        continue;
      }
      allocMap.set(k, region);
      let set = activeByInstrument.get(e.instrument);
      if (!set) { set = new Set(); activeByInstrument.set(e.instrument, set); }
      set.add(k);
      occurrences.push(makeOccurrence(e, region, nMap));
    }
    return { occurrences, conflicts };
  };
})(window);
