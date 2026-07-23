/*
 * ppmck方式のコンパクトなバイトコードでMMLの音符セグメント列をシリアライズする。
 * MML.Mml.compile()が返すフレーム単位レジスタ書き込みログ(tracks)は、そのまま
 * NSFへ書き出すには32KBを簡単に超えて非現実的なため採用しない(ROADMAP.mdフェーズ1.6)。
 * 代わりに、音符1個を基本2〜3バイトで表現できるコマンドバイト列形式を使う。
 *
 * オペコード(ppmck実機ソース https://github.com/munshkr/ppmck の
 * src/ppmckc/mckc.h ・ nes_include/ppmck/internal.h ・各拡張音源.h を実測して採用。
 * 値は実機と同一。全チャンネル種別(2A03パルス/三角/ノイズ・VRC6・VRC7・FDS・N106・
 * FME7・MMC5)が共有するコア命令セットで、実機もこの命令セットを全チップ共通で
 * 使い回している):
 *   0x00-0xF0 : 音符(音程)。直後1バイトが音長(フレーム数、1-255)
 *   0xF4      : ウェイト。直後1バイトがフレーム数を直前のイベントへ加算する
 *               (256以上の音長を255バイトずつに分割して継続するために使う)
 *   0xF7      : ノートエンベロープ(EN)選択。次バイトはインデックス(255=off)
 *   0xF8      : ピッチエンベロープ(EP)選択。次バイトはインデックス(255=off)
 *   0xFB      : ビブラート(MP)選択。次バイトはインデックス(255=off)
 *   0xFC      : 休符。直後1バイトがフレーム数
 *   0xFD      : 音量直接指定。次バイトは 0x80|(0-15)。このチャンネルのソフトウェア
 *               音量エンベロープ(下記0xF3)を解除する(compiler.js側の明示的なv<n>が
 *               state.envelopeVをnullクリアするのと同じ意味)
 *   0xFE      : 音色(デューティ/音色番号)直接指定。次バイトは 0x80|値
 *   0xFF      : トラック終端
 *
 * チップ固有の追加オペコード:
 *   0xF0      : VRC7カスタム音色再ロード(OP<n>、音符に紐付かない即時イベント)。
 *               次バイトは 0x80|(音色テーブルindex 0-127)。本実装の独自拡張
 *               (実機ppmckにも同種のオペコードはあるが値は異なる)
 *   0xF5      : FDSモジュレーション再ロード(MH<n>/MHOF、音符に紐付かない即時イベント)。
 *               次バイトは@MH<n>のn(0-254)、255ならMHOF(モジュレーション停止=$4084に
 *               gain0を書くだけ)。本実装の独自拡張(実機ppmckに同種オペコードは無い)
 *   0xF1      : ノイズ周波数(N<n>、FME7)。次バイトは0-31
 *   0xF2      : ハードウェアエンベロープ(FME7)。次の3バイトが[形状,周期下位,周期上位]
 *               (実機は形状と周期を別オペコードに分けて2回書くが、本実装はデータ量を
 *               減らすため1つのオペコードにまとめている。実機とは非互換の独自拡張)
 *   0xF3      : ソフトウェア音量エンベロープ(@v<n>)選択。本実装の独自拡張(実機ppmckには
 *               無い)。次バイトはremap後のコンパクトなテーブル番号(0-254、曲中で実際に
 *               使われているenvelopeVだけを詰めた番号。src/driver/ppmckDriver.jsが
 *               ROM上に埋め込むENV_PTR_LO/HI等のテーブルへの添字と一致させる)。
 *               このチャンネルの次の音符から有効になり、音符が続く間は6502ドライバ側が
 *               毎フレーム値を進める(ノートオンでtick=0にリセット、テーブル終端は
 *               ループ指定が無ければ末尾保持、あればループ位置へ戻る)。0xFDで解除される
 *
 * 音符バイトの音程エンコードのみ実機と異なる: 実機は4bit音名+4bitオクターブ
 * シフト(右シフト1回=1オクターブ上げ)というテーブル参照+シフト方式だが、
 * 本実装ではMML.Mml.compile()が既に計算しているnoteNumber(octave*12+semitone、
 * c=0)をそのままバイト値として使う(0-0xF0=0-240の範囲に収まり十分な音域がある。
 * 0xF1以降はFME7拡張オペコード等と衝突するため使わない)。
 * オペコードのバイト値と「音符+音長を最小単位にするコンパクトなバイトコード」という
 * 設計思想は実機と揃えているが、生成したバイト列そのものは実機ppmckcの出力とは
 * バイナリ互換ではない。
 *
 * segmentsByChannel(Mml.compile()の戻り値)はチャンネル種別に関わらず同じ形の
 * セグメント列(buildSegments()の出力)なので、このシリアライザは2A03/拡張音源
 * すべてのチャンネルに共通で使える(音源固有のレジスタ変換は行わず、MML上の値
 * (noteNumber・volume・instrument・各種インデックス)をそのまま記録する。
 * 実際のレジスタ値への変換は再生側=6502ドライバの仕事になる)。
 *
 * 未対応(ROADMAP.mdフェーズ1.6タスク1の続き、意図的に見送っている理由をそれぞれ記載):
 *   - ループ([...]n → 0xA0/0xA1): 実機のループ命令はジャンプ先アドレス(バンク+
 *     オフセット)を埋め込む方式で、これは最終的なROM上のバイト配置が決まらないと
 *     生成できない(0xEEのバンク切り替えと同じ仕組みを流用しているため)。つまり
 *     「セグメント列→バイト列」の変換だけでは完結せず、ドライバ組み立て・ROM配置
 *     (タスク2-4)の段階で扱うべき機能であり、本タスク(タスク1)の対象外とする。
 *     現状はコンパイラ側で既にループを展開済み(expandLoops)のセグメント列をそのまま
 *     線形にシリアライズする(サイズは大きくなるがループの有無で再生内容は変わらない)。
 *   - スイープ(0xF9): 本ツールのsweep実装はソフトウェア近似(半音オフセットを毎フレーム
 *     計算する方式)であり、実機の生ハードウェアスイープレジスタ直接書き込み(0xF9)とは
 *     表現形式が異なるため、そのまま流用できない。
 *   - デチューン(0xFA、D<n>): 2026-07-24実装完了。compiler.jsが算出した周期/周波数
 *     レジスタ値への生オフセットをそのまま2バイト(符号付き16bit、リトルエンディアン)で
 *     書き出す(0xF9のスイープと違い、こちらは単純な加算オフセットなのでバイトコード化に
 *     表現形式のギャップが無い)。6502ドライバ側(src/driver/ppmckDriver.js)のAPPLY_DETUNE
 *     (2A03/VRC6/MMC5/FME7/FDS共通)・APPLY_DETUNE_N163(N163専用、3バイト精度)が
 *     実際の加算・負方向クランプを行う。実機6502エミュレータ上でのNSF書き出し往復
 *     検証済み(全対応チップで期待通りの周期差、高音+大きな負のデチューンでも
 *     0クランプでラップアラウンドしないことを確認)。
 *   - DPCM: チャンネル文字の割当方針が未確定(ROADMAP.mdフェーズ1.7タスク1で
 *     ユーザー確認待ち)のため、この段階では対象にしない。
 *   - FDSの`MH<n>`(曲中の変調再ロード)はVRC7の`OP<n>`(0xF0)と同じ音符に紐付かない
 *     即時コマンドとして0xF5オペコードで対応する(下記OP_FDS_MOD_RELOAD参照)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const NSF = MML.NSF = MML.NSF || {};
  const MckBytecode = NSF.MckBytecode = NSF.MckBytecode || {};

  const OP_NOTE_ENV = 0xf7;
  const OP_PITCH_ENV = 0xf8;
  const OP_DETUNE = 0xfa; // D<n>デチューン選択。次の2バイトが符号付き16bit値(下位,上位、リトルエンディアン)
  const OP_VIBRATO = 0xfb;
  const OP_WAIT = 0xf4;
  const OP_REST = 0xfc;
  const OP_VOL = 0xfd;
  const OP_VOL_ENV = 0xf3; // ソフトウェア音量エンベロープ(@v<n>)選択。本実装の独自拡張
  const OP_TONE = 0xfe;
  const OP_END = 0xff;
  // 注意: NOTE_MAXは全オペコードより小さくすること。元は0xF3だったが、
  // 0xF1/0xF2(FME7拡張)と重複し得るバグのため0xF0に修正し、さらに
  // バンク切り替え(0xEE、src/driver/ppmckDriver.js側でシリアライズ後に挿入する
  // バンクジャンプマーカー)とも重複しないよう0xEDまで下げた
  const NOTE_MAX = 0xed;

  // FME7専用の追加オペコード(実機と非互換の独自拡張。ファイル冒頭コメント参照)
  const OP_FME7_NOISE = 0xf1;
  const OP_FME7_HARDENV = 0xf2;
  // VRC7専用: OP<n>(曲中のカスタム音色再ロード、音符に紐付かない即時イベント)。
  // 次バイトは 0x80|(音色テーブルindex, 0-127)。serialize()の第2引数
  // immediateWrites(kind:'vrc7Tone')から、対応するフレーム位置のセグメント直前に挿入する
  const OP_VRC7_TONE_RELOAD = 0xf0;
  // FDS専用: MH<n>/MHOF(曲中のモジュレーション再ロード、音符に紐付かない即時イベント)。
  // 次バイトは@MH<n>のn(0-254)、255=MHOF
  const OP_FDS_MOD_RELOAD = 0xf5;
  const FDS_MOD_OFF = 0xff;

  // 音長(フレーム数)を、255ずつのチャンクに分割して書き込む。
  // 最初のチャンクはそのまま直後に、2つ目以降は 0xF4(ウェイト) + チャンクの形で続ける
  function pushLength(bytes, frames) {
    let rest = Math.max(0, Math.round(frames));
    if (rest > 0xff) {
      bytes.push(0xff);
      rest -= 0xff;
    } else {
      bytes.push(rest);
      return;
    }
    while (rest > 0) {
      bytes.push(OP_WAIT);
      if (rest > 0xff) {
        bytes.push(0xff);
        rest -= 0xff;
      } else {
        bytes.push(rest);
        rest = 0;
      }
    }
  }

  // segments: buildSegments()と同じ形の音符セグメント列
  // (MML.Mml.compile()の戻り値の segmentsByChannel['A'] 等)。
  // 2A03・拡張音源共通(チップ固有レジスタへの変換はしない。ファイル冒頭コメント参照)。
  // immediateWrites: 省略可。compile()の戻り値のimmediateWritesByChannel[ch]
  // (音符に紐付かないOP<n>=VRC7カスタム音色再ロード等)。kind:'vrc7Tone'のみ対応
  // (frame位置はセグメントの累積durationFrames境界と必ず一致する。buildSegments()が
  // OP<n>トークン処理時点のelapsedFramesをそのまま記録しており、OP<n>自体は時間を
  // 消費しないため)。value===255(OPOF相当)はcompiler.js側の解釈と合わせ無視する
  // envIndexRemap: 省略可。{元のenvelopeV値: ROM上のコンパクトなテーブル番号(0始まり)}。
  // src/driver/ppmckDriver.jsが曲全体で実際に使われているenvelopeV値だけを詰めて
  // 採番したもの(0-99のソフトウェア由来・100番台のハードウェア由来を区別せず同じ
  // 番号空間として扱う)。省略時(nullや未指定のenvelopeVは)常にプレーン音量(OP_VOL)
  // として出力する
  MckBytecode.serialize = function (segments, immediateWrites, envIndexRemap) {
    const bytes = [];
    let lastVolume = null;
    let lastVolMode = null; // 'plain' | 'env' (src/convert/mmlEmit.jsのcurVolModeと同じ考え方。
                             // モード切替時は値/番号が前回と同じでも必ず出し直す)
    let lastEnvIdx = null;
    let lastTone = null;
    let lastNoteEnv = null;
    let lastPitchEnv = null;
    let lastVibrato = null;
    let lastFme7Noise = null;
    let lastFme7EnvShape = null;
    let lastFme7EnvPeriod = null;
    let lastDetune = 0; // D<n>の既定値は0(compiler.jsのstate.detune初期値と同じ)

    const tonereloads = (immediateWrites || [])
      .filter(iw => iw.kind === 'vrc7Tone' && iw.value !== 255)
      .slice()
      .sort((a, b) => a.frame - b.frame);
    let tonereloadIdx = 0;
    let elapsed = 0;
    const flushToneReloadsUpTo = (frame) => {
      while (tonereloadIdx < tonereloads.length && tonereloads[tonereloadIdx].frame <= frame) {
        bytes.push(OP_VRC7_TONE_RELOAD, 0x80 | (tonereloads[tonereloadIdx].value & 0x7f));
        tonereloadIdx++;
      }
    };

    // FDSのMH<n>/MHOF。VRC7のOP<n>と違い255(MHOF)も意味のある値(モジュレーション
    // 停止)なのでフィルタで除外しない
    const modreloads = (immediateWrites || [])
      .filter(iw => iw.kind === 'fdsMod')
      .slice()
      .sort((a, b) => a.frame - b.frame);
    let modreloadIdx = 0;
    const flushModReloadsUpTo = (frame) => {
      while (modreloadIdx < modreloads.length && modreloads[modreloadIdx].frame <= frame) {
        const v = modreloads[modreloadIdx].value;
        bytes.push(OP_FDS_MOD_RELOAD, v === 255 ? FDS_MOD_OFF : (v & 0xff));
        modreloadIdx++;
      }
    };

    for (const seg of segments) {
      flushToneReloadsUpTo(elapsed);
      flushModReloadsUpTo(elapsed);
      elapsed += seg.durationFrames;
      const gateDenom = seg.gateDenom || 8;
      const gate = seg.gate == null ? 8 : seg.gate;
      const gateFrames = seg.qFrames != null
        ? Math.max(1, seg.durationFrames - seg.qFrames)
        : Math.max(1, Math.round(seg.durationFrames * (gate / gateDenom)));

      if (seg.freq != null) {
        const remapIdx = (envIndexRemap && seg.envelopeV != null) ? envIndexRemap[seg.envelopeV] : undefined;
        if (remapIdx !== undefined) {
          // ソフトウェア音量エンベロープ選択。モードが切り替わった直後は番号が前回と
          // 同じでも必ず出し直す(6502ドライバ側もOP_VOLでENVACTをクリアするため、
          // 出し直さないとエンベロープが再度有効化されない)
          if (remapIdx !== lastEnvIdx || lastVolMode !== 'env') {
            bytes.push(OP_VOL_ENV, remapIdx & 0xff);
            lastEnvIdx = remapIdx;
          }
          lastVolMode = 'env';
        } else {
          const volume = Math.max(0, Math.min(15, seg.volume));
          if (volume !== lastVolume || lastVolMode !== 'plain') {
            bytes.push(OP_VOL, 0x80 | volume);
            lastVolume = volume;
          }
          lastVolMode = 'plain';
        }
        const tone = seg.instrument || 0;
        if (tone !== lastTone) {
          bytes.push(OP_TONE, 0x80 | (tone & 0x7f));
          lastTone = tone;
        }
        if (seg.noteEnv != null && seg.noteEnv !== lastNoteEnv) {
          bytes.push(OP_NOTE_ENV, seg.noteEnv & 0xff);
          lastNoteEnv = seg.noteEnv;
        }
        if (seg.pitchEnv != null && seg.pitchEnv !== lastPitchEnv) {
          bytes.push(OP_PITCH_ENV, seg.pitchEnv & 0xff);
          lastPitchEnv = seg.pitchEnv;
        }
        if (seg.vibrato != null && seg.vibrato !== lastVibrato) {
          bytes.push(OP_VIBRATO, seg.vibrato & 0xff);
          lastVibrato = seg.vibrato;
        }
        const detune = seg.detune || 0;
        if (detune !== lastDetune) {
          // 符号付き16bit、リトルエンディアン(6502側は2バイトの通常のADC加算でそのまま
          // 符号付き値として扱える。詳細はsrc/driver/ppmckDriver.jsのAPPLY_DETUNE参照)
          const d16 = detune & 0xffff;
          bytes.push(OP_DETUNE, d16 & 0xff, (d16 >> 8) & 0xff);
          lastDetune = detune;
        }
        if (seg.fme7Noise != null && seg.fme7Noise !== lastFme7Noise) {
          bytes.push(OP_FME7_NOISE, seg.fme7Noise & 0x1f);
          lastFme7Noise = seg.fme7Noise;
        }
        if (seg.fme7EnvShape != null &&
            (seg.fme7EnvShape !== lastFme7EnvShape || seg.fme7EnvPeriod !== lastFme7EnvPeriod)) {
          const period = seg.fme7EnvPeriod || 0;
          bytes.push(OP_FME7_HARDENV, seg.fme7EnvShape & 0x0f, period & 0xff, (period >> 8) & 0xff);
          lastFme7EnvShape = seg.fme7EnvShape;
          lastFme7EnvPeriod = seg.fme7EnvPeriod;
        }

        const noteByte = Math.max(0, Math.min(NOTE_MAX, Math.round(seg.noteNumber)));
        bytes.push(noteByte);
        pushLength(bytes, gateFrames);
        if (gateFrames < seg.durationFrames) {
          bytes.push(OP_REST);
          pushLength(bytes, seg.durationFrames - gateFrames);
        }
      } else {
        bytes.push(OP_REST);
        pushLength(bytes, seg.durationFrames);
      }
    }
    flushToneReloadsUpTo(elapsed);
    flushModReloadsUpTo(elapsed);

    bytes.push(OP_END);
    return new Uint8Array(bytes);
  };

  // シリアライズ結果を読み戻し、イベント列にする(往復テスト用。実際の6502ドライバの
  // 代わりにJSで同じ解釈をする)。noteEnv/pitchEnv/vibrato/fme7*はその時点で選択中の
  // 値として各noteイベントに載せる
  MckBytecode.deserialize = function (bytes) {
    const rawEvents = [];
    let i = 0;
    let volume = null, tone = null;
    let noteEnv = null, pitchEnv = null, vibrato = null;
    let fme7Noise = null, fme7EnvShape = null, fme7EnvPeriod = null;
    let detune = 0;
    let envIdx = null; // OP_VOL_ENVで選択中のコンパクトなテーブル番号(nullならプレーン音量)

    while (i < bytes.length) {
      const b = bytes[i]; i++;
      if (b === OP_END) break;
      if (b === OP_VOL) { volume = bytes[i] & 0x7f; envIdx = null; i++; continue; }
      if (b === OP_VOL_ENV) { envIdx = bytes[i]; i++; continue; }
      if (b === OP_TONE) { tone = bytes[i] & 0x7f; i++; continue; }
      if (b === OP_VRC7_TONE_RELOAD) {
        const toneIndex = bytes[i] & 0x7f; i++;
        rawEvents.push({ type: 'vrc7ToneReload', toneIndex });
        continue;
      }
      if (b === OP_FDS_MOD_RELOAD) {
        const v = bytes[i]; i++;
        rawEvents.push({ type: 'fdsModReload', mhIndex: v === FDS_MOD_OFF ? 255 : v });
        continue;
      }
      if (b === OP_NOTE_ENV) { noteEnv = bytes[i]; i++; continue; }
      if (b === OP_PITCH_ENV) { pitchEnv = bytes[i]; i++; continue; }
      if (b === OP_DETUNE) {
        const d16 = bytes[i] | (bytes[i + 1] << 8);
        detune = d16 >= 0x8000 ? d16 - 0x10000 : d16;
        i += 2;
        continue;
      }
      if (b === OP_VIBRATO) { vibrato = bytes[i]; i++; continue; }
      if (b === OP_FME7_NOISE) { fme7Noise = bytes[i]; i++; continue; }
      if (b === OP_FME7_HARDENV) {
        fme7EnvShape = bytes[i]; i++;
        fme7EnvPeriod = bytes[i] | (bytes[i + 1] << 8); i += 2;
        continue;
      }
      if (b === OP_REST) { const frames = bytes[i]; i++; rawEvents.push({ type: 'rest', frames }); continue; }
      if (b === OP_WAIT) { const frames = bytes[i]; i++; rawEvents.push({ type: 'wait', frames }); continue; }
      const frames = bytes[i]; i++;
      rawEvents.push({
        type: 'note', noteNumber: b, frames, volume, tone, envIdx,
        noteEnv, pitchEnv, vibrato, fme7Noise, fme7EnvShape, fme7EnvPeriod, detune
      });
    }

    // ウェイトは直前のイベントの音長に合算する(実機と同じ「カウンタ延長」の意味で、
    // 新しいノートオン/ノートオフを発生させない)
    const events = [];
    for (const e of rawEvents) {
      if (e.type === 'wait' && events.length > 0) {
        events[events.length - 1].frames += e.frames;
      } else {
        events.push(e);
      }
    }
    return events;
  };

  // 各コマンドの開始バイト位置を列挙する(トラック終端0xFFの位置も含む)。
  // NSFバンク切り替え(src/driver/ppmckDriver.js)で、4KBバンク境界をコマンドの
  // 途中で跨がないよう安全な分割点を選ぶために使う
  MckBytecode.commandBoundaries = function (bytes) {
    const offsets = [];
    let i = 0;
    while (i < bytes.length) {
      offsets.push(i);
      const b = bytes[i]; i++;
      if (b === OP_END) break;
      if (b === OP_FME7_HARDENV) { i += 3; continue; }
      if (b === OP_DETUNE) { i += 2; continue; }
      // OP_VOL/OP_TONE/OP_NOTE_ENV/OP_PITCH_ENV/OP_VIBRATO/OP_FME7_NOISE/
      // OP_REST/OP_WAIT/音符バイト は、いずれも直後1バイトのパラメータを持つ
      i += 1;
    }
    return offsets;
  };
})(window);
