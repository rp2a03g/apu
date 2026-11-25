/*
 * HuC6202(VPC: SuperGrafx の優先順位の石)— 2 個の VDC の絵を 1 行ずつ重ねる
 * MML.Emu.PceVpc(段階 9d)
 *
 * SuperGrafx は VDC を 2 個持ち、この石が画素ごとにどちらを出すかを決める。
 *   レジスタ(I/O $0008-$000E。$0000-$0007 が VDC1、$0010-$0017 が VDC2):
 *     $08: 下位 4bit = 窓 1 と窓 2 の両方の内側、上位 4bit = 窓 2 だけの内側 の決まり
 *     $09: 下位 4bit = 窓 1 だけの内側、上位 4bit = どの窓の内側でもない所 の決まり
 *          決まり 4bit = bit0 VDC1 を出す / bit1 VDC2 を出す / bit2-3 重ね方(0 と 3: VDC1 が上、1: VDC2 のスプライトは VDC1 の BG の上、
 *          2: VDC1 のスプライトは VDC2 の BG の下)
 *     $0A/$0B: 窓 1 の幅(10bit)、$0C/$0D: 窓 2 の幅(10bit)。行の左から数えて幅より手前が「内側」
 *     $0E: bit0 = ST0/ST1/ST2 の書き先を VDC2 にする
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3): 全部 [参照] Mesen 2 の Core/PCE/PceVpc.cpp(読んで動きを合わせた。写していない)。
 *   ★ 窓の位置は「レジスタの値 − 16」を行バッファの頭からのドット数として使う(Mesen と同じ。左の枠の分の扱いが実機と合っているかは未確認)
 *   ★ 重ね方 2 で「VDC2 のスプライトとの上下」は Mesen のソースにも (?) が付いている
 *   電源投入時は $08 = $09 = $11(どこでも VDC1 だけを出す)
 * 確かめ方: tools/headless/pce-rom-ab.js(SuperGrafx の ROM の画面を Mesen と全画素比べる)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  class PceVpc {
    /** @param {object} host - { vce, vdc(1 個目), vdc2 } */
    constructor(host) {
      this.host = host;
      this.cfg = new Uint8Array(4); // 添字: bit0 = 窓 1 の内側、bit1 = 窓 2 の内側。値は決まり 4bit
      this.reset();
    }
    reset() {
      this.priority1 = 0; this.priority2 = 0; this.window1 = 0; this.window2 = 0; this.stToVdc2 = false;
      this.xStart = 0;
      this.write(0x08, 0x11); this.write(0x09, 0x11);
    }
    read(reg) {
      switch (reg) {
        case 0x08: return this.priority1;
        case 0x09: return this.priority2;
        case 0x0A: return this.window1 & 0xFF;
        case 0x0B: return this.window1 >> 8;
        case 0x0C: return this.window2 & 0xFF;
        case 0x0D: return this.window2 >> 8;
        default: return 0;
      }
    }
    write(reg, value) {
      switch (reg) {
        case 0x08: this.cfg[3] = value & 0x0F; this.cfg[2] = (value >> 4) & 0x0F; this.priority1 = value; break;
        case 0x09: this.cfg[1] = value & 0x0F; this.cfg[0] = (value >> 4) & 0x0F; this.priority2 = value; break;
        case 0x0A: this.window1 = (this.window1 & 0x300) | value; break;
        case 0x0B: this.window1 = (this.window1 & 0xFF) | ((value & 3) << 8); break;
        case 0x0C: this.window2 = (this.window2 & 0x300) | value; break;
        case 0x0D: this.window2 = (this.window2 & 0xFF) | ((value & 3) << 8); break;
        case 0x0E: this.stToVdc2 = (value & 1) !== 0; break;
        default: break;
      }
    }
    /** 行の頭 */
    lineStart() { this.xStart = 0; }
    /** 今の横位置まで、2 個の VDC の行を重ねて out へ書く(レジスタを書かれる直前と、行の終わりに呼ぶ) */
    merge() {
      const h = this.host, v1 = h.vdc, v2 = h.vdc2, V = Emu.PceVdc;
      const sl = v1.scanline;
      if (sl < V.FIRST_LINE || sl >= V.FIRST_LINE + V.ROWS) return;
      const div = h.vce.divider;
      const xMax = Math.min(Math.floor(1365 / div), Math.floor(v1.hClock / div));
      const r1 = v1.row, r2 = v2.row, out = v1.out, base = (sl - V.FIRST_LINE) * V.ROW_W;
      const w1 = Math.max(0, this.window1 - 16), w2 = Math.max(0, this.window2 - 16);
      const T = V.TRANSPARENT, S = V.SPRITE, bgColor = h.vce.pal[0];
      for (let i = this.xStart; i < xMax; i++) {
        const c = this.cfg[(i < w1 ? 1 : 0) | (i < w2 ? 2 : 0)];
        let color;
        switch (c & 3) {
          case 1: color = r1[i]; break;
          case 2: color = r2[i]; break;
          case 3: {
            const a = r1[i], b = r2[i];
            const mode = (c >> 2) & 3;
            if (mode === 1) color = ((a & T) || ((b & S) && !(a & S))) ? b : a;
            else if (mode === 2) color = ((a & T) || ((a & S) && !(b & S) && !(b & T))) ? b : a;
            else color = (a & T) ? b : a;
            break;
          }
          default: color = bgColor; break;
        }
        out[base + i] = color;
      }
      this.xStart = xMax;
    }
  }

  Emu.PceVpc = PceVpc;
})(typeof window !== 'undefined' ? window : globalThis);
