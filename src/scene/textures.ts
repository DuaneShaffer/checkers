import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';

type RGB = readonly [number, number, number];

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function context(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, seed: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x, y, seed + i * 101) * amp;
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface WoodSpecies {
  light: RGB;
  dark: RGB;
  rings: number;
  warp: number;
  figure: number;
  pores: number;
}

export const WALNUT: WoodSpecies = { light: [96, 60, 38], dark: [46, 26, 15], rings: 7, warp: 0.55, figure: 0.22, pores: 0.28 };
export const WALNUT_FRAME: WoodSpecies = { light: [84, 50, 30], dark: [36, 20, 12], rings: 6, warp: 0.7, figure: 0.25, pores: 0.3 };
export const MAPLE: WoodSpecies = { light: [226, 204, 166], dark: [200, 170, 128], rings: 5, warp: 0.35, figure: 0.14, pores: 0.1 };

const LUT_SIZE = 1024;
const LATEWOOD = Float32Array.from({ length: LUT_SIZE + 1 }, (_, i) => {
  const ring = i / LUT_SIZE;
  return smooth(0.62, 0.9, ring) * (1 - smooth(0.9, 1, ring));
});
const PORE = Float32Array.from({ length: LUT_SIZE + 1 }, (_, i) => smooth(0.72, 0.95, i / LUT_SIZE));

interface WoodBlock {
  width: number;
  height: number;
  /** world-unit grain coordinates at the block's left/right pixel edges (x) */
  along: [number, number];
  /** world-unit across-grain coordinates at the block's top/bottom pixel edges (y) */
  across: [number, number];
}

interface WoodPixels {
  tone: Float32Array;
  late: Float32Array;
}

function renderWood(block: WoodBlock, species: WoodSpecies, seed: number): WoodPixels {
  const { width: w, height: h } = block;
  const [a0, a1] = block.along;
  const [b0, b1] = block.across;
  const gw = Math.max(2, Math.ceil(Math.abs(a1 - a0) * 4));
  const gh = Math.max(2, Math.ceil(Math.abs(b1 - b0) * 12));
  const warp = new Float32Array((gw + 1) * (gh + 1));
  const figure = new Float32Array((gw + 1) * (gh + 1));
  for (let gy = 0; gy <= gh; gy++) {
    const b = b0 + ((b1 - b0) * gy) / gh;
    for (let gx = 0; gx <= gw; gx++) {
      const a = a0 + ((a1 - a0) * gx) / gw;
      const i = gy * (gw + 1) + gx;
      warp[i] = (fbm(a * 0.22, b * 1.6, seed, 3) - 0.5) * species.warp * 2;
      figure[i] = (fbm(a * 0.5, b * 3, seed + 13, 2) - 0.5) * species.figure * 2;
    }
  }
  const tone = new Float32Array(w * h);
  const late = new Float32Array(w * h);
  const poreCells = Math.ceil(Math.abs(a1 - a0) * 9) + 2;
  const poreBase = Math.floor(Math.min(a0, a1) * 9);
  const poreRowValues = new Float32Array(poreCells + 1);
  for (let py = 0; py < h; py++) {
    const fy = ((py + 0.5) / h) * gh;
    const y0 = Math.min(gh - 1, Math.floor(fy));
    const ty = fy - y0;
    const across = b0 + ((b1 - b0) * (py + 0.5)) / h;
    const poreRow = Math.floor(across * 160);
    for (let c = 0; c <= poreCells; c++) poreRowValues[c] = hash2(poreBase + c, poreRow, seed + 7);
    for (let px = 0; px < w; px++) {
      const fx = ((px + 0.5) / w) * gw;
      const x0 = Math.min(gw - 1, Math.floor(fx));
      const tx = fx - x0;
      const i00 = y0 * (gw + 1) + x0;
      const i10 = i00 + gw + 1;
      const wTop = warp[i00] + (warp[i00 + 1] - warp[i00]) * tx;
      const wBot = warp[i10] + (warp[i10 + 1] - warp[i10]) * tx;
      const fTop = figure[i00] + (figure[i00 + 1] - figure[i00]) * tx;
      const fBot = figure[i10] + (figure[i10 + 1] - figure[i10]) * tx;
      const t = (across + wTop + (wBot - wTop) * ty) * species.rings;
      const lw = LATEWOOD[((t - Math.floor(t)) * LUT_SIZE) | 0];
      const pa = (a0 + ((a1 - a0) * (px + 0.5)) / w) * 9 - poreBase;
      const pi = pa | 0;
      const pf = pa - pi;
      const pn = poreRowValues[pi];
      const pore = pn + (poreRowValues[pi + 1] - pn) * pf;
      const k = py * w + px;
      late[k] = lw;
      const v = 0.32 + lw * 0.5 + PORE[(pore * LUT_SIZE) | 0] * species.pores + fTop + (fBot - fTop) * ty;
      tone[k] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  return { tone, late };
}

function mix(a: RGB, b: RGB, t: number, out: number[]): void {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

function finishColorTexture(c: HTMLCanvasElement, anisotropy: number): CanvasTexture {
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  return tex;
}

function finishDataTexture(c: HTMLCanvasElement, anisotropy: number): CanvasTexture {
  const tex = new CanvasTexture(c);
  tex.anisotropy = anisotropy;
  return tex;
}

export interface BoardTextures {
  map: Texture;
  /** roughness in G, metalness in B */
  orm: Texture;
}

/**
 * 8x8 field: canvas row r is engine row r (toward +z), canvas column c is engine column c.
 * Dark (playable) squares are walnut, light squares maple.
 */
export function makeFieldTextures(size: number, anisotropy: number): BoardTextures {
  const color = makeCanvas(size, size);
  const orm = makeCanvas(size, size);
  const cImg = context(color).createImageData(size, size);
  const oImg = context(orm).createImageData(size, size);
  const cell = size / 8;
  const rgb = [0, 0, 0];
  const seam = Math.max(1, Math.round(size / 1024));
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const dark = (row + col) % 2 === 1;
      const species = dark ? WALNUT : MAPLE;
      const offA = hash2(row, col, 3) * 40;
      const offB = hash2(col, row, 5) * 40;
      const tint = 0.94 + hash2(row, col, 9) * 0.1;
      const wood = renderWood({ width: cell, height: cell, along: [offA, offA + 1], across: [offB, offB + 1] }, species, 17 + row * 8 + col);
      for (let py = 0; py < cell; py++) {
        for (let px = 0; px < cell; px++) {
          const k = py * cell + px;
          mix(species.light, species.dark, wood.tone[k], rgb);
          const edge = px < seam || py < seam || px >= cell - seam || py >= cell - seam;
          const shade = (edge ? 0.7 : 1) * tint;
          const i = ((row * cell + py) * size + col * cell + px) * 4;
          cImg.data[i] = Math.min(255, rgb[0] * shade);
          cImg.data[i + 1] = Math.min(255, rgb[1] * shade);
          cImg.data[i + 2] = Math.min(255, rgb[2] * shade);
          cImg.data[i + 3] = 255;
          oImg.data[i] = 255;
          oImg.data[i + 1] = (dark ? 0.42 : 0.36) * 255 + wood.late[k] * 40 + (edge ? 40 : 0);
          oImg.data[i + 2] = 0;
          oImg.data[i + 3] = 255;
        }
      }
    }
  }
  context(color).putImageData(cImg, 0, 0);
  context(orm).putImageData(oImg, 0, 0);
  return { map: finishColorTexture(color, anisotropy), orm: finishDataTexture(orm, anisotropy) };
}

export const RAIL_TEX_LENGTH = 9.6;
/** Across-the-rail span (world units) mapped onto the top half of the rail texture. */
export const RAIL_TEX_ACROSS = 0.8;
export const INLAY_FROM = 0.115;
export const INLAY_TO = 0.155;

/**
 * Frame rail texture. Top half (v 0..0.5) maps the rail's top face, across = v / 0.5 * RAIL_TEX_ACROSS
 * from the field edge, and carries the brass inlay; the bottom half is plain wood for the sides.
 */
export function makeRailTextures(width: number, anisotropy: number): BoardTextures {
  const height = width / 4;
  const color = makeCanvas(width, height);
  const orm = makeCanvas(width, height);
  const cImg = context(color).createImageData(width, height);
  const oImg = context(orm).createImageData(width, height);
  const rgb = [0, 0, 0];
  const brass: RGB = [201, 164, 92];
  const half = height / 2;
  const sides = renderWood({ width, height: half, along: [0, RAIL_TEX_LENGTH], across: [4, 3] }, WALNUT_FRAME, 71);
  const top = renderWood({ width, height: half, along: [0, RAIL_TEX_LENGTH], across: [RAIL_TEX_ACROSS, 0] }, WALNUT_FRAME, 71);
  for (let py = 0; py < height; py++) {
    const onTop = py >= half;
    const wood = onTop ? top : sides;
    const ry = onTop ? py - half : py;
    const across = onTop ? RAIL_TEX_ACROSS * (1 - (ry + 0.5) / half) : 0;
    const inlay = onTop && across >= INLAY_FROM && across <= INLAY_TO;
    for (let px = 0; px < width; px++) {
      const k = ry * width + px;
      const i = (py * width + px) * 4;
      if (inlay) {
        const sheen = 0.9 + valueNoise((px / width) * RAIL_TEX_LENGTH * 30, across * 4, 3) * 0.2;
        cImg.data[i] = brass[0] * sheen;
        cImg.data[i + 1] = brass[1] * sheen;
        cImg.data[i + 2] = brass[2] * sheen;
      } else {
        mix(WALNUT_FRAME.light, WALNUT_FRAME.dark, wood.tone[k], rgb);
        cImg.data[i] = rgb[0];
        cImg.data[i + 1] = rgb[1];
        cImg.data[i + 2] = rgb[2];
      }
      cImg.data[i + 3] = 255;
      oImg.data[i] = 255;
      oImg.data[i + 1] = inlay ? 0.3 * 255 : 0.46 * 255 + wood.late[k] * 30;
      oImg.data[i + 2] = inlay ? 255 : 0;
      oImg.data[i + 3] = 255;
    }
  }
  context(color).putImageData(cImg, 0, 0);
  context(orm).putImageData(oImg, 0, 0);
  const map = finishColorTexture(color, anisotropy);
  const ormTex = finishDataTexture(orm, anisotropy);
  for (const t of [map, ormTex]) t.wrapS = RepeatWrapping;
  return { map, orm: ormTex };
}

/** Rows outside [vFrom, vTo] stay flat. */
export function makeReedingNormalMap(reeds: number, vFrom: number, vTo: number, anisotropy: number): Texture {
  const width = reeds * 16;
  const height = 128;
  const c = makeCanvas(width, height);
  const img = context(c).createImageData(width, height);
  for (let py = 0; py < height; py++) {
    const v = 1 - (py + 0.5) / height;
    const band = smooth(vFrom, vFrom + 0.012, v) * (1 - smooth(vTo - 0.012, vTo, v));
    for (let px = 0; px < width; px++) {
      const phase = ((px + 0.5) / 16) % 1;
      const p = phase * 2 - 1;
      const nx = p * 0.8 * band;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx));
      const i = (py * width + px) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = 128;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  context(c).putImageData(img, 0, 0);
  const tex = finishDataTexture(c, anisotropy);
  tex.wrapS = RepeatWrapping;
  return tex;
}

function radialTexture(size: number, stops: [number, number][]): Texture {
  const c = makeCanvas(size, size);
  const ctx = context(c);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, alpha] of stops) g.addColorStop(at, `rgba(255,255,255,${alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export interface HighlightTextures {
  glowRing: Texture;
  ring: Texture;
  dot: Texture;
  square: Texture;
  outline: Texture;
  contactShadow: Texture;
}

export function makeHighlightTextures(): HighlightTextures {
  const glowRing = radialTexture(256, [
    [0, 0],
    [0.62, 0],
    [0.76, 0.55],
    [0.82, 1],
    [0.86, 0.5],
    [1, 0],
  ]);
  const ring = radialTexture(256, [
    [0, 0],
    [0.66, 0],
    [0.7, 1],
    [0.8, 1],
    [0.85, 0],
    [1, 0],
  ]);
  const dot = radialTexture(128, [
    [0, 1],
    [0.42, 1],
    [0.55, 0.35],
    [1, 0],
  ]);
  const square = makeSquareTexture(false);
  const outline = makeSquareTexture(true);
  const contactShadow = radialTexture(256, [
    [0, 0.62],
    [0.5, 0.5],
    [0.8, 0.16],
    [1, 0],
  ]);
  return { glowRing, ring, dot, square, outline, contactShadow };
}

function makeSquareTexture(outline: boolean): Texture {
  const size = 128;
  const c = makeCanvas(size, size);
  const ctx = context(c);
  if (outline) {
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = 7;
    const r = 14;
    const inset = 8;
    ctx.beginPath();
    ctx.roundRect(inset, inset, size - inset * 2, size - inset * 2, r);
    ctx.stroke();
  } else {
    const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.72);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0.45)');
    ctx.fillStyle = g;
    ctx.fillRect(2, 2, size - 4, size - 4);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
