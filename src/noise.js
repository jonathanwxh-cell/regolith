// Seeded 2D simplex noise + fBm helpers. Deterministic across runs.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = [
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 0, 1, 0, -1,
];

export class Simplex2 {
  constructor(seed = 1337) {
    const rand = mulberry32(seed);
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const n = Math.floor(rand() * (i + 1));
      const q = p[i]; p[i] = p[n]; p[n] = q;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  noise(xin, yin) {
    const perm = this.perm;
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi0 = (perm[ii + perm[jj]] & 7) * 2;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD[gi0] * x0 + GRAD[gi0 + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi1 = (perm[ii + i1 + perm[jj + j1]] & 7) * 2;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD[gi1] * x1 + GRAD[gi1 + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi2 = (perm[ii + 1 + perm[jj + 1]] & 7) * 2;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD[gi2] * x2 + GRAD[gi2 + 1] * y2);
    }
    return 70 * (n0 + n1 + n2); // ~[-1, 1]
  }
  fbm(x, y, oct = 5, lac = 2.02, gain = 0.5) {
    let a = 0.5, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += a * this.noise(x * f, y * f);
      norm += a;
      f *= lac; a *= gain;
    }
    return sum / norm;
  }
  ridged(x, y, oct = 4, lac = 2.1, gain = 0.55) {
    let a = 0.5, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      const n = 1 - Math.abs(this.noise(x * f, y * f));
      sum += a * n * n;
      norm += a;
      f *= lac; a *= gain;
    }
    return sum / norm; // [0,1]
  }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
