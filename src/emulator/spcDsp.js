/*
 * SNES DSP エミュレータ (CXD1222Q/CXD2922Q)
 * MML.Emu.SpcDsp
 *
 * 8ボイス BRR サンプル再生、ADSR エンベロープ、エコー処理
 * clock() を 32 SPC700 サイクルごとに呼び出すと 32kHz で 1 ステレオサンプルを生成
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // ── ガウシアン補間テーブル (512 entries) ─────────────────────────
  // SNES DSP の4タップ・ガウシアン補間カーネル。
  // 【修正】旧テーブルは形状が誤っており(index 426 付近で 0x3FF 頭打ち・末尾 0)、
  // 4タップの合計が 2048 にならず、補間利得がサブサンプル位置(frac)に依存して
  // 最大 ±30% 変動していた。frac は毎サンプル進むため、この利得リップルが持続音
  // (特に低音)に信号比例の高域うなり=音割れを生じさせていた。
  // 正しくは実機同様に単調増加(ピーク G[511]≈1305)し、各列(4タップ)合計が
  // ほぼ 2048 になる単位利得カーネルでなければならない。
  //   G[n] = round(h((511.5 - n)/256) * scale),  h(u) = exp(-u^2 / (2σ^2))
  // σ=0.63 で実機ピーク(≈1305)を再現し、全列合計が 2044〜2050(±0.3%)に収まる。
  const GAUSS = (() => {
    const SIGMA = 0.63;
    const h = (u) => Math.exp(-(u * u) / (2 * SIGMA * SIGMA));
    // f=0..1 の全列平均合計が 2048 になるよう scale を決定(単位利得化)
    let colAvg = 0;
    for (let p = 0; p < 256; p++) {
      const f = (p + 0.5) / 256;
      colAvg += h(1 + f) + h(f) + h(1 - f) + h(2 - f);
    }
    const scale = 2048 / (colAvg / 256);
    const t = new Int16Array(512);
    for (let n = 0; n < 512; n++) {
      const u = (511.5 - n) / 256;
      t[n] = Math.round(h(u) * scale);
    }
    return t;
  })();

  // ── エンベロープレートテーブル ──────────────────────────────────
  // 各エントリ = 何 DSP サンプルごとに envelope を更新するか
  const RATE_TABLE = new Uint16Array([
    0,2048,1536,1280,1024,768,640,512,
    384,320,256,192,160,128,96,80,
    64,48,40,32,24,20,16,12,
    10,8,6,5,4,3,2,1,
  ]);

  // ── BRR デコーダ ─────────────────────────────────────────────────
  function decodeBrrBlock(ram, addr, prev1, prev2) {
    const header = ram[addr & 0xFFFF];
    const shift  = header >> 4;
    const filter = (header >> 2) & 3;
    const loop   = (header >> 1) & 1;
    const end    = header & 1;
    const samples = new Int16Array(16);

    for (let i = 0; i < 8; i++) {
      const byte = ram[(addr + 1 + i) & 0xFFFF];
      for (let nib = 0; nib < 2; nib++) {
        const raw = (nib === 0) ? (byte >> 4) : (byte & 0xF);
        // 4bit符号拡張 → 16bit
        let s = (raw & 8) ? (raw | 0xFFFFFFF0) : raw;
        // シフト適用
        if (shift <= 12) {
          s = (s << shift) >> 1;
        } else {
          // range 13-15: nybble の符号ビット（bit3）で飽和
          // 実機では BRR フェードアウト用の意図的な無音化に使われる
          // 負 nybble (bit3=1) → -1、非負 nybble (bit3=0) → 0
          s = (s >> 3) & ~1;  // 符号だけ残して偶数化（SNESAPU 準拠）
        }

        // フィルタ適用
        switch (filter) {
          case 1: s += prev1 - (prev1 >> 4); break;
          case 2: s += (prev1 << 1) - ((prev1 * 3) >> 5) - prev2 + (prev2 >> 4); break;
          case 3: s += (prev1 << 1) - ((prev1 * 13) >> 6) - prev2 + ((prev2 * 3) >> 4); break;
        }
        // 15bit符号付きにクランプ
        s = Math.max(-32768, Math.min(32767, s));
        // 15bit（下位 1bit は常に 0）
        s = (s << 1) >> 1;
        samples[i * 2 + nib] = s;
        prev2 = prev1;
        prev1 = s;
      }
    }
    return { samples, prev1, prev2, loop, end };
  }

  // ── ボイス状態 ────────────────────────────────────────────────────
  class Voice {
    constructor() {
      this.volL = 0; this.volR = 0;
      this.pitch = 0;
      this.srcn  = 0;
      this.adsr1 = 0; this.adsr2 = 0; this.gain = 0;
      this.env   = 0;          // 11bit エンベロープ値 0x000-0x7FF
      this.envMode = 'off';    // 'attack'|'decay'|'sustain'|'release'|'off'
      this.sampleIdx = 0;      // デコード済みサンプルバッファ内インデックス
      this.pitchFrac = 0;      // 12.12 固定小数点の小数部 (0-0xFFF)
      this.pitchInt  = 0;      // 整数部
      // [0-3]=直前ブロック末尾4サンプル(履歴), [4-19]=現ブロック16サンプル
      this.brrBuf  = new Int16Array(20);
      this.brrPrev1 = 0; this.brrPrev2 = 0;
      this.brrAddr  = 0;       // 次に読む BRR ブロックアドレス
      this.loopAddr = 0;
      this.konDelay = 0;       // KON 後の遅延サンプル数
      this.outSample = 0;      // 直近のボイス出力 (for PMON)
      this.envRate  = 0;       // エンベロープ更新カウンタ
    }
  }

  // ── DSP クラス ────────────────────────────────────────────────────
  class SpcDsp {
    /**
     * @param {Uint8Array} ram - SPC 64KB RAM (参照渡し)
     */
    constructor(ram) {
      this.ram = ram;
      // BRR サンプル読み取り専用の元データコピー（エコー書き込みによる破壊を防ぐ）
      // spcPlayer 側から set される
      this.origRam = null;
      this.regs = new Uint8Array(128); // DSP レジスタ
      this.voices = Array.from({length:8}, () => new Voice());
      this.kon  = 0;  // KON ラッチ
      this.koff = 0;  // KOFF ラッチ
      this.endx = 0;  // ENDX フラグ
      this.mutedVoices = 0;  // ミュートビットマスク (bit0=Voice0 ... bit7=Voice7)
      this.voiceVol = new Array(8).fill(1); // ボイスごとの音量(0〜2、既定1=100%)。鍵盤表示のch別音量バー用
      // エコー
      this.echoPos = 0;
      this.echoBufL = new Int32Array(8192);
      this.echoBufR = new Int32Array(8192);
      // メインステレオ出力
      this.outL = 0;
      this.outR = 0;
      // ノイズ
      this.noiseLfsr = 0x4000;
      this.noiseSample = 0;
      this.noiseCounter = 0;
      // ログ用 DSP 書き込みコールバック
      this.onWrite = null;
      // サンプルカウンタ (エンベロープ/エコー用)
      this.sampleClock = 0;
    }

    reset() {
      this.regs.fill(0);
      this.voices.forEach(v => {
        Object.assign(v, new Voice());
      });
      this.endx = 0; this.echoPos = 0;
      this.echoBufL.fill(0); this.echoBufR.fill(0);
      this.outL = 0; this.outR = 0;
      this.noiseLfsr = 0x4000; this.sampleClock = 0;
    }

    // ── レジスタ アクセス ──────────────────────────────────────────
    readReg(addr) {
      addr &= 0x7F;
      const v = addr & 0x0F;
      if (v === 0x08) return this.voices[addr >> 4].env & 0xFF;
      if (v === 0x09) return this.voices[addr >> 4].outSample >> 7;
      if (addr === 0x7C) { const e=this.endx; this.endx=0; return e; }
      return this.regs[addr];
    }

    writeReg(addr, val) {
      addr &= 0x7F; val &= 0xFF;
      this.regs[addr] = val;
      if (this.onWrite) this.onWrite(addr, val);

      const ch = addr >> 4, reg = addr & 0x0F;
      const v  = this.voices[ch];

      switch (addr) {
        case 0x4C: // KON
          this.kon = val;
          for (let i = 0; i < 8; i++) {
            if (val & (1 << i)) this._keyOn(i);
          }
          break;
        case 0x5C: // KOFF
          this.koff = val;
          for (let i = 0; i < 8; i++) {
            if (val & (1 << i)) this.voices[i].envMode = 'release';
          }
          break;
        case 0x6C: // FLG
          if (val & 0x80) this.reset(); // RESET
          break;
      }

      // per-voice ADSR/GAIN
      if (reg === 0x05) v.adsr1 = val;
      else if (reg === 0x06) v.adsr2 = val;
      else if (reg === 0x07) v.gain  = val;
    }

    // ── KON ───────────────────────────────────────────────────────
    _keyOn(ch) {
      const v = this.voices[ch];
      const srcn = this.regs[(ch << 4) | 0x04];
      const dir  = this.regs[0x5D];
      const dirAddr = (dir << 8) + srcn * 4;
      // brrDirCache があればそちらを優先（エコーバッファとの重複破壊対策）
      if (this.brrDirCache) {
        const base = srcn * 4;
        v.brrAddr  = this.brrDirCache[base] | (this.brrDirCache[base+1] << 8);
        v.loopAddr = this.brrDirCache[base+2] | (this.brrDirCache[base+3] << 8);
      } else {
        v.brrAddr  = this.ram[dirAddr & 0xFFFF] | (this.ram[(dirAddr+1) & 0xFFFF] << 8);
        v.loopAddr = this.ram[(dirAddr+2) & 0xFFFF] | (this.ram[(dirAddr+3) & 0xFFFF] << 8);
      }
      v.srcn     = srcn;
      v.pitchFrac = 0; v.pitchInt = 0;
      v.sampleIdx = 0;
      v.brrPrev1 = 0; v.brrPrev2 = 0;
      v.brrBuf.fill(0); // 20要素すべてクリア（履歴も含む）
      v.env      = 0;
      v.envMode  = 'attack';
      v.envRate  = 0;
      v.konDelay = 5; // KON 後 5 サンプル遅延
      // KON したボイスの ENDX ビットをクリア (SNESAPU v2.11.3 相当)
      this.endx &= ~(1 << ch);
    }

    // ── エンベロープ更新 ───────────────────────────────────────────
    _updateEnvelope(ch) {
      const v = this.voices[ch];
      if (v.envMode === 'off') return;

      const adsr1 = this.regs[(ch << 4) | 0x05];
      const adsr2 = this.regs[(ch << 4) | 0x06];
      const gain  = this.regs[(ch << 4) | 0x07];
      const adsrEn = adsr1 & 0x80;

      if (v.envMode === 'release') {
        // Release: 指数減衰 rate=31 (毎サンプル) - 線形 -8 ではなく指数
        v.env -= ((v.env - 1) >> 8) + 1;
        if (v.env <= 0) { v.env = 0; v.envMode = 'off'; }
        return;
      }

      if (!adsrEn) {
        // GAIN モード
        const mode = (gain >> 5) & 3;
        const rate = gain & 0x1F;
        if (gain & 0x80) {
          // カスタムモード。rate=0は実機では「周期無限=エンベロープ変化なし」(sustainの
          // sr===0と同じ扱い)。RATE_TABLE[0]=0のまま比較すると毎サンプル発火=最速減衰に
          // 化け、GAIN $A0(exp減衰,rate0)を「現レベル保持」として使うFF4等のAKAOドライバで
          // 全ボイスが数フレームで無音になっていた(2026-08-25、FF4全曲異常の真因)。
          if (rate === 0) { v.env = Math.max(0, Math.min(0x7FF, v.env)); return; }
          v.envRate++;
          if (v.envRate >= RATE_TABLE[rate]) {
            v.envRate = 0;
            switch (mode) {
              case 0: v.env -= 32; break; // Linear decrease
              case 1: // Exponential decrease
                v.env -= ((v.env - 1) >> 8) + 1;
                break;
              case 2: v.env += 32; break; // Linear increase
              case 3: v.env += (v.env < 0x600) ? 32 : 8; break; // Bent increase
            }
          }
        } else {
          // Direct GAIN: 直接 0-127 → 0x000-0x7E0
          v.env = (gain & 0x7F) << 4;
        }
        v.env = Math.max(0, Math.min(0x7FF, v.env));
        return;
      }

      // ADSR モード
      if (v.envMode === 'attack') {
        const ar = (adsr1 & 0x0F);
        const rate = ar === 15 ? 31 : ar * 2 + 1;
        v.envRate++;
        if (v.envRate >= RATE_TABLE[rate]) {
          v.envRate = 0;
          v.env += (ar === 15) ? 1024 : 32;
          if (v.env >= 0x7E0) { v.env = 0x7E0; v.envMode = 'decay'; }
        }
      } else if (v.envMode === 'decay') {
        const dr = (adsr1 >> 4) & 0x07;
        const rate = 8 + dr * 2;
        v.envRate++;
        if (v.envRate >= RATE_TABLE[rate]) {
          v.envRate = 0;
          v.env -= ((v.env - 1) >> 8) + 1;
          const sl = ((adsr2 >> 5) & 0x07);
          const sustLevel = (sl + 1) << 8;
          if (v.env <= sustLevel) { v.env = sustLevel; v.envMode = 'sustain'; }
        }
      } else if (v.envMode === 'sustain') {
        const sr = adsr2 & 0x1F;
        if (sr === 0) return;
        v.envRate++;
        if (v.envRate >= RATE_TABLE[sr]) {
          v.envRate = 0;
          v.env -= ((v.env - 1) >> 8) + 1;
          if (v.env <= 0) { v.env = 0; v.envMode = 'off'; }
        }
      }
      v.env = Math.max(0, Math.min(0x7FF, v.env));
    }

    // ── BRR サンプル取得（ガウシアン補間） ────────────────────────
    // brrBuf[0-3]=直前ブロック末尾4サンプル, brrBuf[4-19]=現ブロック16サンプル
    // sampleIdx=i(0-15) → buf[4+i], buf[3+i], buf[2+i], buf[1+i] を参照
    // i=0 のとき buf[1-3] は直前ブロックの末尾サンプルを正しく参照する
    _getSample(v) {
      const i   = v.sampleIdx;
      const s0  = v.brrBuf[1 + i];
      const s1  = v.brrBuf[2 + i];
      const s2  = v.brrBuf[3 + i];
      const s3  = v.brrBuf[4 + i];
      const frac = (v.pitchFrac >> 4) & 0xFF;
      const out = (GAUSS[0xFF - frac] * s0 + GAUSS[0x1FF - frac] * s1 +
                   GAUSS[0x100 + frac] * s2 + GAUSS[frac] * s3) >> 11;
      return Math.max(-32768, Math.min(32767, out));
    }

    // ── ノイズ更新 ────────────────────────────────────────────────
    _updateNoise() {
      const flg  = this.regs[0x6C];
      const rate = flg & 0x1F;
      if (rate === 0) return;
      this.noiseCounter++;
      if (this.noiseCounter >= RATE_TABLE[rate]) {
        this.noiseCounter = 0;
        const bit = (this.noiseLfsr & 1) ^ ((this.noiseLfsr >> 1) & 1);
        this.noiseLfsr = ((this.noiseLfsr >> 1) | (bit << 14)) & 0x7FFF;
        this.noiseSample = (this.noiseLfsr & 0x7FFF) - (bit ? 0x8000 : 0);
      }
    }

    // ── メインクロック (32 SPC サイクルごとに呼ぶ) ─────────────────
    clock() {
      this.sampleClock++;
      this._updateNoise();

      const flg  = this.regs[0x6C];
      const non  = this.regs[0x3D]; // noise enable
      const pmon = this.regs[0x2D]; // pitch modulation
      const eon  = this.regs[0x4D]; // echo enable
      const echoOff = (flg & 0x20) !== 0;

      let mainL = 0, mainR = 0, echoInL = 0, echoInR = 0;
      let prevVoiceOut = 0;

      for (let ch = 0; ch < 8; ch++) {
        const v   = this.voices[ch];
        const base = ch << 4;

        // KON 遅延 (5サンプル: ピッチ進行・エンベロープも停止)
        if (v.konDelay > 0) {
          v.konDelay--;
          if (v.konDelay === 0) {
            // 最初のブロックをデコード（履歴部[0-3]は0のまま=KON直後は無音から開始）
            const res = decodeBrrBlock(this.origRam || this.ram, v.brrAddr, 0, 0);
            v.brrBuf.fill(0, 0, 4);        // 履歴ゼロクリア
            v.brrBuf.set(res.samples, 4);   // 現ブロックを[4-19]に配置
            v.brrPrev1 = res.prev1; v.brrPrev2 = res.prev2;
            v.brrAddr += 9;
            v.sampleIdx = 0;
            v.pitchFrac = 0;
          }
          continue; // 遅延中はサンプル生成をスキップ
        }

        // エンベロープ更新
        this._updateEnvelope(ch);

        // ピッチ計算
        let pitchVal = (this.regs[base+2] | ((this.regs[base+3] & 0x3F) << 8));
        // ピッチモジュレーション (PMON bit で前ボイス出力を乗算)
        if (ch > 0 && (pmon & (1 << ch))) {
          pitchVal = (pitchVal * (prevVoiceOut + 0x8000)) >> 15;
          pitchVal = Math.max(0, Math.min(0x3FFF, pitchVal));
        }
        v.pitch = pitchVal;

        // 位置進行
        v.pitchFrac += pitchVal;
        const steps = (v.pitchFrac >> 12) & 0xF;
        v.pitchFrac &= 0xFFF;
        v.sampleIdx = (v.sampleIdx + steps) % 16;

        // 次ブロックが必要かチェック (sampleIdx < steps ⇔ ブロック境界を越えた)
        if (v.sampleIdx < steps || v.sampleIdx >= 16) {
          // 直前ブロック末尾4サンプルを履歴[0-3]に保存してから上書き
          v.brrBuf[0] = v.brrBuf[16];
          v.brrBuf[1] = v.brrBuf[17];
          v.brrBuf[2] = v.brrBuf[18];
          v.brrBuf[3] = v.brrBuf[19];
          const res = decodeBrrBlock(this.origRam || this.ram, v.brrAddr, v.brrPrev1, v.brrPrev2);
          v.brrBuf.set(res.samples, 4); // 現ブロックを[4-19]に配置
          v.brrPrev1 = res.prev1; v.brrPrev2 = res.prev2;
          if (res.end) {
            this.endx |= (1 << ch);
            if (res.loop) {
              v.brrAddr = v.loopAddr;
              v.envMode = v.envMode === 'attack' ? 'decay' : v.envMode; // ループ時はdecayへ
            } else {
              v.envMode = 'off';
              v.env = 0;
            }
          } else {
            v.brrAddr += 9;
          }
        }

        // サンプル取得
        let sample;
        if (non & (1 << ch)) {
          sample = this.noiseSample; // ノイズ
        } else {
          sample = this._getSample(v);
        }

        // エンベロープ適用
        const envApplied = Math.round((sample * v.env) / 0x800);
        v.outSample = Math.max(-32768, Math.min(32767, envApplied));

        // ボリューム適用・ミックス
        const volL = (this.regs[base+0] << 24) >> 24; // 符号付き
        const volR = (this.regs[base+1] << 24) >> 24;
        const mixL = Math.round((v.outSample * volL) / 128);
        const mixR = Math.round((v.outSample * volR) / 128);

        if (!(this.mutedVoices & (1 << ch))) {
          const vv = this.voiceVol[ch];
          mainL += mixL * vv; mainR += mixR * vv;
          if (eon & (1 << ch)) { echoInL += mixL * vv; echoInR += mixR * vv; }
        }

        prevVoiceOut = v.outSample;
      }

      // マスターボリューム
      const mvolL = (this.regs[0x0C] << 24) >> 24;
      const mvolR = (this.regs[0x1C] << 24) >> 24;

      // エコー処理
      const edl      = this.regs[0x7D] & 0x0F;
      // エコーバッファのサイズ = EDL × 2KB（EDL=0 は最小 4 バイト = 1 フレーム）。
      // フレーム(=4バイト)単位では EDL × 512。以前は (edl+1)*512 と 1 段大きく取って
      // いたため、ESA が高位のゲーム（例 Axelay "Unkai" ESA=$D8/EDL=5 → 0xD800+）で
      // 書き込みアドレスが $FFFF を跨いでページ0（$F1 タイマー制御やドライバの
      // ゼロページ変数）を上書きし、バッファ一巡直後（約0.08秒）にタイマーが停止して
      // 曲が最初の音で止まっていた。
      const eLen     = (edl === 0 ? 1 : edl * 512); // フレーム数 (512〜7680)
      const ePos     = this.echoPos;              // 既に % eLen 済み
      const esa      = this.regs[0x6D];
      const echoBase = (esa << 8);

      // FIR フィルタ読み取り (8タップ、1フレームずつ遡る)
      let echoL = 0, echoR = 0;
      for (let tap = 0; tap < 8; tap++) {
        const fir     = (this.regs[tap * 0x10 + 0x0F] << 24) >> 24;
        const tapPos  = (ePos - tap + eLen) % eLen;  // tap*2→tap に修正
        const addr    = (echoBase + tapPos * 4) & 0xFFFF;
        const eL = (this.ram[addr] | (this.ram[(addr+1)&0xFFFF] << 8)) << 16 >> 16;
        const eR = (this.ram[(addr+2)&0xFFFF] | (this.ram[(addr+3)&0xFFFF] << 8)) << 16 >> 16;
        echoL += (eL * fir) >> 7;
        echoR += (eR * fir) >> 7;
      }
      echoL = Math.max(-32768, Math.min(32767, echoL));
      echoR = Math.max(-32768, Math.min(32767, echoR));

      // エコーフィードバック書き込み
      // BRR サンプルディレクトリ領域 (DIR<<8 ～ DIR<<8+1023) には書き込まない。
      // エコーバッファとディレクトリが重複する場合、実機では整合した値になるが
      // 我々の計算値は異なるため、初期 SPC ダンプ値をそのまま保持することで
      // KON 時に正しいサンプルアドレスを読めるようにする。
      if (!echoOff) {
        const efb = (this.regs[0x0D] << 24) >> 24;
        const writeL = Math.max(-32768, Math.min(32767, echoInL + ((echoL * efb) >> 7)));
        const writeR = Math.max(-32768, Math.min(32767, echoInR + ((echoR * efb) >> 7)));
        const waddr = (echoBase + ePos * 4) & 0xFFFF;
        // BRR ディレクトリは brrDirCache にキャッシュ済みなので RAM には自由に書ける
        this.ram[waddr]               = writeL & 0xFF;
        this.ram[(waddr+1) & 0xFFFF]  = (writeL >> 8) & 0xFF;
        this.ram[(waddr+2) & 0xFFFF]  = writeR & 0xFF;
        this.ram[(waddr+3) & 0xFFFF]  = (writeR >> 8) & 0xFF;
      }
      this.echoPos = (this.echoPos + 1) % eLen;

      // エコーボリューム適用（全ボイスミュート中はエコーも無音）
      const allMuted = (this.mutedVoices & 0xFF) === 0xFF;
      const evolL = allMuted ? 0 : (this.regs[0x2C] << 24) >> 24;
      const evolR = allMuted ? 0 : (this.regs[0x3C] << 24) >> 24;

      // 最終出力 (-1.0〜+1.0 に正規化)
      const outL = (Math.round((mainL * mvolL) / 128) + Math.round((echoL * evolL) / 128));
      const outR = (Math.round((mainR * mvolR) / 128) + Math.round((echoR * evolR) / 128));
      this.outL = Math.max(-32768, Math.min(32767, outL)) / 32768;
      this.outR = Math.max(-32768, Math.min(32767, outR)) / 32768;
    }
  }

  // ── 鍵盤表示(大波形)プレビュー用: ガウス補間+ピッチ進行を dsp本体と同じ式で
  // 非破壊に計算する。voice本体(sampleIdx/pitchFrac)は変更しない。ブロック境界を
  // 跨ぐ新規BRRフェッチは行わず、現在のbrrBuf(16サンプル+履歴4)内で折り返す簡易プレビュー。
  function previewVoiceOutput(voice, pitchVal, count) {
    let sampleIdx = voice.sampleIdx, pitchFrac = voice.pitchFrac;
    const buf = voice.brrBuf;
    const out = new Array(count);
    for (let n = 0; n < count; n++) {
      const i = sampleIdx;
      const s0 = buf[1 + i], s1 = buf[2 + i], s2 = buf[3 + i], s3 = buf[4 + i];
      const frac = (pitchFrac >> 4) & 0xFF;
      const v = (GAUSS[0xFF - frac] * s0 + GAUSS[0x1FF - frac] * s1 +
                 GAUSS[0x100 + frac] * s2 + GAUSS[frac] * s3) >> 11;
      out[n] = Math.max(-32768, Math.min(32767, v));
      pitchFrac += pitchVal;
      const steps = (pitchFrac >> 12) & 0xF;
      pitchFrac &= 0xFFF;
      sampleIdx = (sampleIdx + steps) % 16;
    }
    return out;
  }

  Emu.SpcDsp = SpcDsp;
  Emu.decodeBrrBlock = decodeBrrBlock;
  Emu.previewVoiceOutput = previewVoiceOutput;
  Emu.GAUSS = GAUSS;

})(window);
