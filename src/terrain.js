// Terrain: a 6 km quad — a Jezero-modeled impact crater (center offset east)
// whose western rim is breached by a driveable inlet canyon climbing to a
// highland plateau: mesas, a paleolake basin with shoreline terraces, a
// lava-tube skylight, and the landing site of a rover that came before you.
//
// Two-tier render meshes (near tile + 6x6 far tiles) + a material-mask
// texture + GPU track splats, with exact-match JS height sampling for physics.
// Height = main(3 m/texel) + mid(0.75 m tiled) + detail(0.19 m tiled), all
// sampled identically in JS and GLSL.
//
// Generation is multi-resolution: low-frequency bands evaluate on coarse
// grids and upsample; only high-frequency content runs per texel.
// Grounded numbers (DESIGN.md / AGENTS.md "References"): delta strata ~25 m,
// Kodiak butte 80 m, rim walls 800-1200 m above floor (compressed here),
// flood boulders to 1.5 m, twilight up to 2 h after sunset.
import * as THREE from "three";
import { Simplex2, clamp, lerp, smoothstep } from "./noise.js";

export const WORLD = 6144;      // meters, square, centered on origin
export const HM = 2048;         // main heightmap resolution (3 m / texel)
export const DETAIL_N = 256;    // detail heightmap resolution
export const DETAIL_SPAN = 48;  // meters covered by one detail tile
export const MID_N = 512;       // mid-scale relief tile resolution
export const MID_SPAN = 384;    // meters covered by one mid tile (0.75 m/texel)
export const TILE_SPAN = 384;   // near tile size (m)
export const TILE_SEG = 512;    // near tile segments
export const CX = 900, CZ = 0;  // crater center
export const PLAY_R = 1960;     // playable crater radius
const FAR_TILES = 6, FAR_TILE_SEG = 128;
const MASK_N = 1024;            // material mask resolution (6 m / texel)

// ---------------------------------------------------------------- layout
// All positions are WORLD coordinates. The crater is centered on (CX, CZ);
// the plateau is the region west of x = -1450.
export function makeLayout(seed) {
  const rng = new Simplex2(seed);
  const j = (a, s) => rng.noise(a, s) * 30;
  return {
    lander: { x: CX + 980 + j(1, 2), z: -1140 + j(3, 4) },
    halo: { x: CX + 720, z: -780, r: 95 },               // fresh crater
    old: { x: CX + 250, z: 900, r: 260 },                // big subdued crater
    delta: {
      apexX: CX - 1520, apexZ: 240, dir: 0,              // fan opens east
      halfAng: 1.02, radius: 920, topH: 30,
    },
    kodiak: { x: CX - 380, z: -60, r: 118, h: 56 },      // remnant butte
    seitah: { x: CX + 450, z: -250, rx: 560, rz: 400, rot: 0.5 },
    playa: { x: CX - 150, z: 260, r: 400 },
    overlook: { x: CX + 900, z: 1350 },                  // rim bench (NE)
    // inlet canyon: crater floor at the delta apex -> plateau mouth
    valley: { ax: CX - 1520, az: 240, bx: -1620, bz: 300, halfW: 230, plateauH: 140 },
    // plateau (x < -1450)
    argoSite: { x: -2200, z: 600 },                      // ARGO-1 landing platform
    shore: { x: -2300, z: -700, r: 520 },                // paleolake basin + terraces
    skylight: { x: -2000, z: 1500, r: 26, depth: 32 },   // lava-tube pit
    mesas: [
      { x: -2600, z: 100, r: 160, h: 48 },
      { x: -1900, z: -1500, r: 120, h: 36 },
      { x: -2700, z: -2100, r: 200, h: 60 },
    ],
  };
}

export class Terrain {
  constructor(seed = 20260813) {
    this.seed = seed;
    this.layout = makeLayout(seed);
    this.heights = new Float32Array(HM * HM);
    this.detail = new Float32Array(DETAIL_N * DETAIL_N);
    this.mid = new Float32Array(MID_N * MID_N);
    this.mask = new Uint8Array(MASK_N * MASK_N * 4); // R strata, G playa, B sand, A rim
    this.craters = [];
    this.minH = 0; this.maxH = 0;
    this.group = new THREE.Group();
    this.trackQueue = [];
    this.farTiles = [];
  }

  // ---------------------------------------------------------- playable zones
  inCrater(x, z) { return Math.hypot(x - CX, z - CZ) < PLAY_R; }
  inValley(x, z) {
    const V = this.layout.valley, D = this.layout.delta;
    const fx = D.apexX + Math.cos(-0.3) * 960, fz = D.apexZ + Math.sin(-0.3) * 960;
    return distToSeg(x, z, V.ax, V.az, V.bx, V.bz) < V.halfW * 0.9 || distToSeg(x, z, V.ax, V.az, fx, fz) < 125;
  }
  onPlateau(x, z) { return x < -1450 && x > -2950 && Math.abs(z) < 2900; }
  isPlayable(x, z) {
    if (Math.abs(x) > 3000 || Math.abs(z) > 3000) return false;
    const S = this.layout.skylight;
    if (Math.hypot(x - S.x, z - S.z) < S.r + 4) return false; // don't drive into the pit
    return this.inCrater(x, z) || this.inValley(x, z) || this.onPlateau(x, z);
  }

  // ------------------------------------------------------------ generation
  async generate(onProgress) {
    const S = new Simplex2(this.seed);
    const SW = new Simplex2(this.seed + 101);
    const SR = new Simplex2(this.seed + 202);
    const SM = new Simplex2(this.seed + 303);
    const SP = new Simplex2(this.seed + 808);
    const rand = (a => () => (a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(this.seed ^ 0x5f3759df);
    const L = this.layout;
    const H = this.heights;
    const px2w = WORLD / HM;

    // ---- pass A (256², 24 m): warp fields + regional relief
    const AN = 256;
    const warpX = new Float32Array(AN * AN);
    const warpZ = new Float32Array(AN * AN);
    const regional = new Float32Array(AN * AN);
    for (let jj = 0; jj < AN; jj++) {
      const wz = (jj / AN - 0.5) * WORLD;
      for (let ii = 0; ii < AN; ii++) {
        const wx = (ii / AN - 0.5) * WORLD;
        warpX[jj * AN + ii] = 150 * SW.fbm(wx * 0.0009, wz * 0.0009, 2);
        warpZ[jj * AN + ii] = 150 * SW.fbm(wx * 0.0009 + 7.7, wz * 0.0009 + 3.3, 2);
        regional[jj * AN + ii] = 24 * S.fbm(wx * 0.00048, wz * 0.00048, 3);
      }
    }
    if (onProgress) { onProgress(0.04); await frame(); }

    // ---- pass B (512², 12 m): ridged rim texture + rolling plains
    const BN = 512;
    const ridgedF = new Float32Array(BN * BN);
    const plainsLow = new Float32Array(BN * BN);
    for (let jj = 0; jj < BN; jj++) {
      const wz = (jj / BN - 0.5) * WORLD;
      for (let ii = 0; ii < BN; ii++) {
        const wx = (ii / BN - 0.5) * WORLD;
        ridgedF[jj * BN + ii] = SR.ridged(wx * 0.0016, wz * 0.0016, 4);
        plainsLow[jj * BN + ii] = 11 * S.fbm(wx * 0.0009 + 31, wz * 0.0009 - 12, 3);
      }
      if ((jj & 127) === 0 && onProgress) { onProgress(0.04 + jj / BN * 0.08); await frame(); }
    }

    const grid = (arr, N, wx, wz) => {
      let gx = (wx / WORLD + 0.5) * N - 0.5, gz = (wz / WORLD + 0.5) * N - 0.5;
      gx = clamp(gx, 0, N - 2); gz = clamp(gz, 0, N - 2);
      const i0 = Math.floor(gx), j0 = Math.floor(gz);
      const fx = gx - i0, fz = gz - j0;
      const a = arr[j0 * N + i0], b = arr[j0 * N + i0 + 1];
      const c = arr[(j0 + 1) * N + i0], d = arr[(j0 + 1) * N + i0 + 1];
      return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
    };

    // ---- feature helpers (analytic, per-pixel)
    const D = L.delta, K = L.kodiak, SE = L.seitah, P = L.playa, V = L.valley;
    const seCos = Math.cos(SE.rot), seSin = Math.sin(SE.rot);
    const ovAng = Math.atan2(L.overlook.z - CZ, L.overlook.x - CX);
    const quant = (v, s) => Math.round(v / s) * s;
    const vLen = Math.hypot(V.bx - V.ax, V.bz - V.az);

    const out = { h: 0, strata: 0, playa: 0, sand: 0, rim: 0 };
    const buildBase = (wx, wz) => {
      const qx = wx + grid(warpX, AN, wx, wz);
      const qz = wz + grid(warpZ, AN, wx, wz);
      let h = grid(regional, AN, qx, qz) + grid(plainsLow, BN, qx, qz);
      h += 1.7 * S.fbm(wx * 0.014, wz * 0.014, 2);
      h += 0.55 * SM.fbm(wx * 0.045, wz * 0.045, 2);
      let dMask = 0, pMask = 0, sMask = 0, rMask = 0;

      // -- crater rim: rises to a crest then descends to the plateau level
      //    outside. Softened corridor + bench for the overlook mission.
      const cx = wx - CX, cz = wz - CZ;
      const r = Math.hypot(cx, cz);
      const rg = grid(ridgedF, BN, qx, qz);
      const aDiff = Math.abs(angDelta(Math.atan2(cz, cx), ovAng));
      const corridor = smoothstep(0.22, 0.05, aDiff);
      if (r > 1550) {
        const inner = Math.pow(smoothstep(1880, 2320, r), 2);
        const outer = smoothstep(2320, 2850, r);
        const crest = (240 + 260 * rg) * (1 - corridor * 0.45);
        h += inner * crest * (1 - outer) + outer * (V.plateauH + 22 * rg);
        h += smoothstep(1550, 1980, r) * (8 + 10 * rg) * (1 - outer); // talus apron
        rMask = Math.max(rMask, smoothstep(1700, 1960, r) * (1 - outer));
      }
      // The M5 overlook bench ramps up from the OPEN CRATER FLOOR, so it must
      // live outside the rim guard above. Nested inside `r > 1550` its 1310→1585
      // ramp-in was clipped at 0.96, standing an 80 m wall with 88° faces on
      // playable floor at r≈1550. Its own band gives the intended ~18° ramp.
      if (r > 1280 && r < 1900 && corridor > 0.02) {
        const bench = corridor * smoothstep(1310, 1585, r) * smoothstep(1850, 1700, r);
        h = lerp(h, 92 + 4 * rg, bench * 0.9);
      }

      // -- plateau relief (west of the rim): rougher basalt plain, mesas,
      //    the paleolake basin with shoreline terraces, the skylight
      if (wx < -1200) {
        const pm = smoothstep(-1200, -1500, wx);
        h += pm * (14 * SP.fbm(wx * 0.0022, wz * 0.0022, 3) + 2.2 * SP.fbm(wx * 0.012, wz * 0.012, 2));
        for (const M of L.mesas) {
          const d = Math.hypot(wx - M.x, wz - M.z);
          if (d < M.r * 1.5) {
            const t = smoothstep(M.r, M.r * 0.55, d) * (0.85 + 0.15 * SP.noise(Math.atan2(wz - M.z, wx - M.x) * 2.7, 3.1));
            if (t > 0.002) {
              const floorLocal = h;
              let hm = floorLocal + t * (M.h + 1.2 * SP.fbm(wx * 0.03, wz * 0.03, 2));
              const sc = 4 * t * (1 - t);
              hm = lerp(hm, floorLocal + quant(hm - floorLocal, 6), sc * 0.45);
              h = hm; dMask = Math.max(dMask, t);
            }
          }
        }
        {
          const SH = L.shore;
          const d = Math.hypot(wx - SH.x, wz - SH.z);
          if (d < SH.r * 1.25) {
            const m = smoothstep(SH.r * 1.25, SH.r * 0.6, d);
            // three terraces stepping down into the basin
            let dh = -12 * smoothstep(SH.r * 0.9, SH.r * 0.3, d);
            for (const tr of [0.95, 0.78, 0.6]) dh -= 3.2 * smoothstep(SH.r * tr + 12, SH.r * tr - 12, d);
            h += pm * dh;
            pMask = Math.max(pMask, m * smoothstep(SH.r * 0.55, SH.r * 0.25, d));
          }
        }
        {
          const SK = L.skylight;
          const d = Math.hypot(wx - SK.x, wz - SK.z);
          if (d < SK.r * 2.2) {
            h -= pm * SK.depth * smoothstep(SK.r + 6, SK.r - 4, d);   // vertical-walled pit
            h += pm * 3 * smoothstep(SK.r * 2.2, SK.r + 8, d) * smoothstep(SK.r - 2, SK.r + 8, d); // slight rim
          }
        }
      }

      // -- the delta fan (terraced strata front)
      {
        const dx = wx - D.apexX, dz = wz - D.apexZ;
        const ra = Math.hypot(dx, dz);
        if (ra < D.radius * 1.35 && wx > D.apexX - 40) {
          const ang = Math.atan2(dz, dx);
          const aFall = smoothstep(D.halfAng, D.halfAng * 0.7, Math.abs(ang));
          const lobed = D.radius * (0.8 + 0.22 * S.fbm(ang * 1.25 + 9, 4.4, 2) + 0.06 * S.fbm(wx * 0.004, wz * 0.004, 2));
          const tEdge = smoothstep(lobed, lobed - 70, ra) * aFall;
          if (tEdge > 0.002) {
            const floorLocal = h;
            const top = D.topH - ra * 0.0055 + 1.2 * S.fbm(wx * 0.02, wz * 0.02, 2);
            let hd = floorLocal + tEdge * top;
            const sc = 4 * tEdge * (1 - tEdge);
            hd = lerp(hd, floorLocal + quant(hd - floorLocal, 5.5), sc * 0.42);
            h = hd;
            dMask = Math.max(dMask, tEdge);
          }
        }
      }

      // -- Kodiak-style remnant butte
      {
        const d = Math.hypot(wx - K.x, wz - K.z);
        if (d < K.r * 1.5) {
          const t = smoothstep(K.r, K.r * 0.55, d) * (0.85 + 0.15 * S.noise(Math.atan2(wz - K.z, wx - K.x) * 2.3, 7.7));
          if (t > 0.002) {
            const floorLocal = h;
            let hb = floorLocal + t * (K.h + 1.5 * S.fbm(wx * 0.03, wz * 0.03, 2));
            const sc = 4 * t * (1 - t);
            hb = lerp(hb, floorLocal + quant(hb - floorLocal, 6), sc * 0.45);
            h = hb; dMask = Math.max(dMask, t);
          }
        }
      }

      // -- inlet canyon + distributary channel, applied AFTER the fan so the
      //    channel incises the strata (as Jezero's delta really is). The
      //    canyon floor is SET to a graded ramp (plateau -> delta top), so it
      //    is a causeway through the rim rather than a notch; the second
      //    segment cuts down through the fan to the crater floor.
      {
        const d1 = distToSeg(wx, wz, V.bx, V.bz, V.ax, V.az);
        if (d1 < V.halfW * 1.3) {
          const t = clamp(((wx - V.bx) * (V.ax - V.bx) + (wz - V.bz) * (V.az - V.bz)) / (vLen * vLen), 0, 1);
          const ramp = lerp(V.plateauH + 6, D.topH + 1, smoothstep(0.05, 0.95, t)) + 2.0 * S.fbm(wx * 0.01, wz * 0.01, 2);
          const carve = smoothstep(V.halfW * 1.3, V.halfW * 0.55, d1);
          h = lerp(h, ramp, carve);
          rMask = Math.max(rMask, smoothstep(V.halfW * 0.55, V.halfW * 1.2, d1) * (1 - t * 0.5));
        }
        const fx = D.apexX + Math.cos(-0.3) * 960, fz = D.apexZ + Math.sin(-0.3) * 960;
        const d2 = distToSeg(wx, wz, V.ax, V.az, fx, fz);
        if (d2 < 150) {
          const len2 = Math.hypot(fx - V.ax, fz - V.az);
          const t = clamp(((wx - V.ax) * (fx - V.ax) + (wz - V.az) * (fz - V.az)) / (len2 * len2), 0, 1);
          const ramp = lerp(D.topH + 1, 0, smoothstep(0.02, 0.9, t)) + 1.2 * S.fbm(wx * 0.02, wz * 0.02, 2);
          const carve = smoothstep(150, 70, d2);
          h = lerp(h, Math.min(h, ramp), carve);
        }
      }

      // -- playa
      {
        const d = Math.hypot(wx - P.x, wz - P.z);
        if (d < P.r * 1.3) {
          const m = smoothstep(P.r * 1.3, P.r * 0.5, d);
          const pf = -7 + 0.9 * S.fbm(wx * 0.004, wz * 0.004, 2);
          h = lerp(h, lerp(h * 0.4, pf, smoothstep(P.r * 0.9, P.r * 0.35, d)), m);
          pMask = Math.max(pMask, m * smoothstep(P.r * 1.1, P.r * 0.6, d));
        }
      }

      // -- Séítah dune maze
      {
        const rx0 = wx - SE.x, rz0 = wz - SE.z;
        const u = rx0 * seCos + rz0 * seSin, v = -rx0 * seSin + rz0 * seCos;
        const e = (u * u) / (SE.rx * SE.rx) + (v * v) / (SE.rz * SE.rz);
        if (e < 1.4) {
          const m = smoothstep(1.15, 0.55, e) * (0.6 + 0.4 * S.fbm(wx * 0.0021 + 40, wz * 0.0021 - 17, 2));
          if (m > 0.02) {
            const warp = 10 * S.fbm(wx * 0.006, wz * 0.006, 2);
            let ph = (v + warp) / 38; ph -= Math.floor(ph);
            const prof = ph < 0.7 ? smoothstep(0, 0.7, ph) : 1 - smoothstep(0.7, 1, ph);
            h += m * (3.1 * prof + 0.5 * S.noise(u * 0.05, v * 0.2));
            sMask = Math.max(sMask, m);
          }
        }
      }

      // -- world-edge ridges so the map never ends in a cliff to nothing
      {
        const edge = Math.max(Math.abs(wx), Math.abs(wz));
        if (edge > 2800) h += smoothstep(2800, 3072, edge) * (70 + 90 * rg);
      }

      out.h = h; out.strata = dMask; out.playa = pMask; out.sand = sMask; out.rim = rMask;
      return out;
    };
    // (No `this._buildBase = buildBase` here: nothing reads it, and the closure
    //  pinned ~2.9 MB of generation scratch for the life of the page.)

    // ---- pass C (2048², 3 m): assemble heights + the material mask
    const M = this.mask;
    for (let jj = 0; jj < HM; jj++) {
      const wz = (jj / HM - 0.5) * WORLD + px2w * 0.5;
      const writeMask = (jj & 1) === 0;
      const mj = jj >> 1;
      for (let ii = 0; ii < HM; ii++) {
        const wx = (ii / HM - 0.5) * WORLD + px2w * 0.5;
        const b = buildBase(wx, wz);
        H[jj * HM + ii] = b.h;
        if (writeMask && (ii & 1) === 0) {
          const k = (mj * MASK_N + (ii >> 1)) * 4;
          M[k] = b.strata * 255; M[k + 1] = b.playa * 255;
          M[k + 2] = b.sand * 255; M[k + 3] = b.rim * 255;
        }
      }
      if ((jj & 63) === 0 && onProgress) { onProgress(0.12 + jj / HM * 0.55); await frame(); }
    }

    // ---- craters (crater floor + plateau; spared on strata + dune cores)
    const craters = [
      { x: L.halo.x, z: L.halo.z, r: L.halo.r, fresh: 1 },
      { x: L.old.x, z: L.old.z, r: L.old.r, fresh: 0.35 },
    ];
    for (let c = 0; c < 190; c++) {
      const r = 12 + Math.pow(rand(), 2.4) * 80;
      const x = (rand() - 0.5) * 5800, z = (rand() - 0.5) * 5800;
      const floor = Math.hypot(x - CX, z - CZ) < 1900;
      const plat = this.onPlateau(x, z) && x < -1550;
      if (!floor && !plat) continue;
      if (Math.hypot(x - L.lander.x, z - L.lander.z) < 160 + r) continue;
      if (Math.hypot(x - L.argoSite.x, z - L.argoSite.z) < 120 + r) continue;
      if (this.maskAtRaw(x, z, 0) > 0.15) continue;
      if (this.maskAtRaw(x, z, 2) > 0.5 && r < 40) continue;
      if (this.inValley(x, z)) continue;
      craters.push({ x, z, r, fresh: plat ? 0.3 + rand() * 0.4 : 0.5 + rand() * 0.5 });
    }
    this.craters = craters;
    for (let ci = 0; ci < craters.length; ci++) {
      this._rasterCrater(craters[ci]);
      if ((ci & 15) === 0 && onProgress) { onProgress(0.67 + ci / craters.length * 0.15); await frame(); }
    }

    // ---- tiled relief fields shared by shader + physics
    const SD = new Simplex2(this.seed + 505);
    const tileField = (arr, N, span, fn) => {
      for (let jj = 0; jj < N; jj++) {
        for (let ii = 0; ii < N; ii++) {
          const u = ii / N, v = jj / N;
          let d = fn(u * span, v * span);
          const fx = smoothstep(0.0, 0.12, Math.min(u, 1 - u));
          const fz = smoothstep(0.0, 0.12, Math.min(v, 1 - v));
          arr[jj * N + ii] = d * (0.35 + 0.65 * fx * fz);
        }
      }
    };
    tileField(this.detail, DETAIL_N, DETAIL_SPAN, (bx, bz) =>
      0.22 * SD.fbm(bx * 0.55, bz * 0.55, 3) + 0.09 * SD.fbm(bx * 1.7, bz * 1.7, 2));
    tileField(this.mid, MID_N, MID_SPAN, (bx, bz) =>
      0.42 * SD.fbm(bx * 0.05 + 9, bz * 0.05 + 4, 3) + 0.18 * SD.fbm(bx * 0.16, bz * 0.16, 2));

    let mn = Infinity, mx = -Infinity;
    for (let k = 0; k < H.length; k++) { const v = H[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
    this.minH = mn; this.maxH = mx;
    if (onProgress) { onProgress(0.84); await frame(); }
  }

  _rasterCrater(c) {
    const H = this.heights, px2w = WORLD / HM;
    const SEj = this._SEj || (this._SEj = new Simplex2(this.seed + 404));
    const w2i = (wx) => (wx / WORLD + 0.5) * HM - 0.5;
    const R = c.r, depth = Math.min(0.17 * R, 16) * c.fresh, rim = Math.min(0.05 * R, 4.5) * c.fresh;
    const ext = R * 2.1;
    const i0 = Math.max(0, Math.floor(w2i(c.x - ext))), i1 = Math.min(HM - 1, Math.ceil(w2i(c.x + ext)));
    const j0 = Math.max(0, Math.floor(w2i(c.z - ext))), j1 = Math.min(HM - 1, Math.ceil(w2i(c.z + ext)));
    for (let jj = j0; jj <= j1; jj++) {
      const wz = (jj / HM - 0.5) * WORLD + px2w * 0.5;
      for (let ii = i0; ii <= i1; ii++) {
        const wx = (ii / HM - 0.5) * WORLD + px2w * 0.5;
        const d = Math.hypot(wx - c.x, wz - c.z) / R;
        if (d > 2.1) continue;
        let dh = 0;
        if (d < 1) dh = (d * d * 1.12 - 1) * depth + rim * Math.exp(-Math.pow((d - 1) * 3.2, 2));
        else {
          dh = rim * Math.exp(-Math.pow((d - 1) * 3.2, 2));
          dh += rim * 0.5 * Math.exp(-(d - 1) * 2.4) * SEj.fbm(wx * 0.05, wz * 0.05, 2);
        }
        H[jj * HM + ii] += dh;
      }
    }
    return { i0, i1, j0, j1 };
  }

  // Runtime impact: punch a fresh crater, re-upload heights, refit far tiles.
  punchCrater(x, z, r) {
    const c = { x, z, r, fresh: 1.6 };
    this.craters.push(c);
    this._rasterCrater(c);
    if (this.heightTex) this.heightTex.needsUpdate = true;
    for (const tile of this.farTiles) {
      const b = tile.geometry.boundingSphere;
      if (!b || Math.hypot(b.center.x - x, b.center.z - z) > b.radius + r * 2.2) continue;
      const p = tile.geometry.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const px = p.getX(k), pz = p.getZ(k);
        if (Math.hypot(px - x, pz - z) < r * 2.3) p.setY(k, this.heightAt(px, pz));
      }
      p.needsUpdate = true;
      tile.geometry.computeVertexNormals();
      tile.geometry.computeBoundingSphere();  // vertices moved; stale sphere mis-culls
    }
  }

  // ------------------------------------------------------------- sampling
  sampleMain(wx, wz) {
    const H = this.heights;
    let gx = (wx / WORLD + 0.5) * HM - 0.5;
    let gz = (wz / WORLD + 0.5) * HM - 0.5;
    gx = clamp(gx, 0, HM - 2); gz = clamp(gz, 0, HM - 2);
    const i0 = Math.floor(gx), j0 = Math.floor(gz);
    const fx = gx - i0, fz = gz - j0;
    const a = H[j0 * HM + i0], b = H[j0 * HM + i0 + 1];
    const c = H[(j0 + 1) * HM + i0], d = H[(j0 + 1) * HM + i0 + 1];
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
  }
  _sampleTiled(arr, N, span, wx, wz) {
    let u = wx / span, v = wz / span;
    u -= Math.floor(u); v -= Math.floor(v);
    const gx = u * N - 0.5, gz = v * N - 0.5;
    const i0 = Math.floor(gx), j0 = Math.floor(gz);
    const fx = gx - i0, fz = gz - j0;
    const w = (n) => ((n % N) + N) % N;
    const a = arr[w(j0) * N + w(i0)], b = arr[w(j0) * N + w(i0 + 1)];
    const c = arr[w(j0 + 1) * N + w(i0)], d = arr[w(j0 + 1) * N + w(i0 + 1)];
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
  }
  sampleDetail(wx, wz) { return this._sampleTiled(this.detail, DETAIL_N, DETAIL_SPAN, wx, wz); }
  sampleMid(wx, wz) { return this._sampleTiled(this.mid, MID_N, MID_SPAN, wx, wz); }
  heightAt(wx, wz) { return this.sampleMain(wx, wz) + this.sampleMid(wx, wz) + this.sampleDetail(wx, wz); }
  normalAt(wx, wz, e = 0.6) {
    const hx0 = this.heightAt(wx - e, wz), hx1 = this.heightAt(wx + e, wz);
    const hz0 = this.heightAt(wx, wz - e), hz1 = this.heightAt(wx, wz + e);
    return new THREE.Vector3(hx0 - hx1, 2 * e, hz0 - hz1).normalize();
  }
  slopeAt(wx, wz) { return Math.acos(clamp(this.normalAt(wx, wz).y, -1, 1)); }

  maskAtRaw(wx, wz, ch) {
    let gx = (wx / WORLD + 0.5) * MASK_N, gz = (wz / WORLD + 0.5) * MASK_N;
    gx = clamp(Math.round(gx), 0, MASK_N - 1); gz = clamp(Math.round(gz), 0, MASK_N - 1);
    return this.mask[(gz * MASK_N + gx) * 4 + ch] / 255;
  }
  inDuneBand(wx, wz) { return this.maskAtRaw(wx, wz, 2) > 0.45; }
  inBasin(wx, wz) { return this.maskAtRaw(wx, wz, 1) > 0.45; }
  onDelta(wx, wz) { return this.maskAtRaw(wx, wz, 0) > 0.3; }

  // ------------------------------------------------------------ GPU assembly
  build(renderer) {
    const floatTex = (data, n) => {
      const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.FloatType);
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      return t;
    };
    this.heightTex = floatTex(this.heights, HM);
    this.detailTex = floatTex(this.detail, DETAIL_N);
    this.midTex = floatTex(this.mid, MID_N);
    this.maskTex = new THREE.DataTexture(this.mask, MASK_N, MASK_N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.maskTex.magFilter = this.maskTex.minFilter = THREE.LinearFilter;
    this.maskTex.needsUpdate = true;

    this.tracksRT = new THREE.WebGLRenderTarget(4096, 4096, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    });
    this.trackScene = new THREE.Scene();
    this.trackCam = new THREE.OrthographicCamera(-WORLD / 2, WORLD / 2, WORLD / 2, -WORLD / 2, -10, 10);
    this.trackCam.position.set(0, 1, 0);
    this.trackCam.up.set(0, 0, -1);
    this.trackCam.lookAt(0, 0, 0);
    this.stampMat = new THREE.MeshBasicMaterial({
      map: makeStampTexture(), transparent: true, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false, opacity: 0.4,
    });
    this.fadeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD, WORLD),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.006, depthTest: false, depthWrite: false })
    );
    this.fadeQuad.rotation.x = -Math.PI / 2;
    this.fadeQuad.visible = false;
    this.trackScene.add(this.fadeQuad);
    renderer.setRenderTarget(this.tracksRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.setRenderTarget(null);
    this._stampPool = [];
    for (let i = 0; i < 64; i++) {
      // Each stamp needs its OWN material: opacity is read at draw time, so a
      // shared one rendered the whole batch at the last stamp's strength and
      // made splatTrack's `strength` argument a no-op (ARGO's faint 0.22 trail,
      // the sand/rock track distinction, the lander scorch all collapsed).
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.stampMat.clone());
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.trackScene.add(m);
      this._stampPool.push(m);
    }

    this.uniforms = {
      uHeight: { value: this.heightTex },
      uDetail: { value: this.detailTex },
      uMid: { value: this.midTex },
      uTracks: { value: this.tracksRT.texture },
      uMask: { value: this.maskTex },
      uTileOrigin: { value: new THREE.Vector2(0, 0) },
      uRover: { value: new THREE.Vector3(0, 0, 0) },
    };

    const nearGeo = new THREE.PlaneGeometry(TILE_SPAN, TILE_SPAN, TILE_SEG, TILE_SEG);
    nearGeo.rotateX(-Math.PI / 2);
    this.nearMat = this.makeMaterial({ near: true });
    this.nearMesh = new THREE.Mesh(nearGeo, this.nearMat);
    this.nearMesh.frustumCulled = false;
    this.nearMesh.receiveShadow = true;
    this.nearMesh.castShadow = false;
    this.group.add(this.nearMesh);

    // far surface: 6x6 frustum-culled tiles
    this.farMat = this.makeMaterial({ near: false });
    const span = WORLD / FAR_TILES;
    for (let tj = 0; tj < FAR_TILES; tj++) {
      for (let ti = 0; ti < FAR_TILES; ti++) {
        const cx = -WORLD / 2 + (ti + 0.5) * span;
        const cz = -WORLD / 2 + (tj + 0.5) * span;
        const g = new THREE.PlaneGeometry(span, span, FAR_TILE_SEG, FAR_TILE_SEG);
        g.rotateX(-Math.PI / 2);
        g.translate(cx, 0, cz);
        const p = g.attributes.position;
        for (let k = 0; k < p.count; k++) p.setY(k, this.heightAt(p.getX(k), p.getZ(k)));
        g.computeVertexNormals();
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, this.farMat);
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        this.farTiles.push(mesh);
        this.group.add(mesh);
      }
    }

    // distant rim silhouettes (crater-centered)
    this.group.add(makeRimRing(this.seed + 606, 4600, 260, 560, 0x63422f, CX, CZ));
    this.group.add(makeRimRing(this.seed + 707, 7200, 560, 1080, 0x5c3e2d, CX, CZ));
    return this.group;
  }

  glslCommon() {
    return /* glsl */`
      uniform sampler2D uHeight;
      uniform sampler2D uDetail;
      uniform sampler2D uMid;
      const float WORLD_M = ${WORLD.toFixed(1)};
      const float HM_N = ${HM.toFixed(1)};
      const float DET_N = ${DETAIL_N.toFixed(1)};
      const float DET_SPAN = ${DETAIL_SPAN.toFixed(1)};
      const float MID_NF = ${MID_N.toFixed(1)};
      const float MID_SPANF = ${MID_SPAN.toFixed(1)};
      float sampleMainH(vec2 wxz) {
        vec2 g = (wxz / WORLD_M + 0.5) * HM_N - 0.5;
        g = clamp(g, vec2(0.0), vec2(HM_N - 2.0));
        ivec2 i0 = ivec2(floor(g));
        vec2 f = fract(g);
        float a = texelFetch(uHeight, i0, 0).r;
        float b = texelFetch(uHeight, i0 + ivec2(1, 0), 0).r;
        float c = texelFetch(uHeight, i0 + ivec2(0, 1), 0).r;
        float d = texelFetch(uHeight, i0 + ivec2(1, 1), 0).r;
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float sampleTiled(sampler2D tex, float N, float span, vec2 wxz) {
        vec2 uv = fract(wxz / span);
        vec2 g = uv * N - 0.5;
        ivec2 i0 = ivec2(floor(g));
        vec2 f = fract(g);
        int n = int(N);
        ivec2 w00 = (i0 % n + n) % n;
        ivec2 w11 = ((i0 + 1) % n + n) % n;
        float a = texelFetch(tex, ivec2(w00.x, w00.y), 0).r;
        float b = texelFetch(tex, ivec2(w11.x, w00.y), 0).r;
        float c = texelFetch(tex, ivec2(w00.x, w11.y), 0).r;
        float d = texelFetch(tex, ivec2(w11.x, w11.y), 0).r;
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float totalH(vec2 wxz) {
        return sampleMainH(wxz) + sampleTiled(uMid, MID_NF, MID_SPANF, wxz) + sampleTiled(uDetail, DET_N, DET_SPAN, wxz);
      }
      float thash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float tnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(thash(i), thash(i + vec2(1, 0)), u.x),
                   mix(thash(i + vec2(0, 1)), thash(i + vec2(1, 1)), u.x), u.y);
      }
      float tfbm(vec2 p) {
        float a = 0.55 * tnoise(p);
        p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.13;
        a += 0.28 * tnoise(p);
        p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.07;
        a += 0.17 * tnoise(p);
        return a;
      }
    `;
  }

  makeMaterial({ near }) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0.0 });
    // CRITICAL: identical onBeforeCompile SOURCE TEXT for both variants — without
    // distinct cache keys three unifies their programs (see AGENTS.md).
    mat.customProgramCacheKey = () => (near ? "regolith-terrain-near" : "regolith-terrain-far");
    const self = this;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.defines = shader.defines || {};
      if (near) shader.defines.NEAR_TILE = 1;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${this.glslCommon()}\nuniform vec2 uTileOrigin;\nvarying vec3 vWPos;`)
        .replace("#include <begin_vertex>", /* glsl */`
          vec3 transformed = vec3(position);
          #ifdef NEAR_TILE
            vec2 wxz = position.xz + uTileOrigin;
            transformed.y = totalH(wxz);
            vWPos = vec3(wxz.x, transformed.y, wxz.y);
          #else
            vWPos = position.xyz;
          #endif
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${this.glslCommon()}
          uniform sampler2D uTracks;
          uniform sampler2D uMask;
          uniform vec3 uRover;
          varying vec3 vWPos;`)
        .replace("#include <normal_fragment_begin>", /* glsl */`
          float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
          vec3 normal = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);
          vec3 nonPerturbedNormal = normal;
        `)
        .replace("#include <map_fragment>", /* glsl */`
          #ifdef NEAR_TILE
            float nE = 0.42;
          #else
            float nE = 3.2;
          #endif
          // Discard FIRST: the four totalH() calls below are 48 dependent
          // texture fetches, and every fragment under the near tile threw them
          // away. vWPos is all the test needs.
          #ifndef NEAR_TILE
            if (distance(vWPos.xz, uRover.xz) < 176.0) discard;
          #endif
          float hx0 = totalH(vWPos.xz - vec2(nE, 0.0));
          float hx1 = totalH(vWPos.xz + vec2(nE, 0.0));
          float hz0 = totalH(vWPos.xz - vec2(0.0, nE));
          float hz1 = totalH(vWPos.xz + vec2(0.0, nE));
          vec3 worldN = normalize(vec3(hx0 - hx1, 2.0 * nE, hz0 - hz1));
          {
            vec2 wxz = vWPos.xz;
            vec2 muv = wxz / WORLD_M + 0.5;
            vec4 mk = texture(uMask, muv);
            float slope = 1.0 - worldN.y;
            float nBig = tfbm(wxz * 0.013);
            float nMed = tfbm(wxz * 0.061);
            float nFine = tfbm(wxz * 0.43);
            float plateau = smoothstep(-1200.0, -1500.0, wxz.x);
            vec3 soil = mix(vec3(0.386, 0.223, 0.133), vec3(0.475, 0.286, 0.176), nBig);
            // plateau lava plain: grayer, blockier basalt
            soil = mix(soil, mix(vec3(0.30, 0.20, 0.135), vec3(0.40, 0.26, 0.17), nMed), plateau * 0.55);
            float basaltM = smoothstep(0.5, 0.88, nMed + slope * 1.3);
            soil = mix(soil, vec3(0.234, 0.163, 0.118), basaltM * 0.6);
            float dustM = smoothstep(0.6, 0.8, nBig) * smoothstep(0.10, 0.02, slope);
            soil = mix(soil, vec3(0.557, 0.361, 0.230), dustM * 0.42);
            float rip = 0.5 + 0.5 * sin(dot(wxz, vec2(0.86, 0.51)) * 2.6 + tfbm(wxz * 0.09) * 5.0);
            soil *= 1.0 - (1.0 - smoothstep(0.0, 0.14, slope)) * rip * 0.05;
            float ripple = 0.5 + 0.5 * sin((wxz.x * 0.83 + wxz.y * 0.55) * 4.2 + tfbm(wxz * 0.12) * 6.0);
            soil = mix(soil, mix(vec3(0.42, 0.222, 0.122), vec3(0.51, 0.30, 0.17), ripple), mk.b * 0.6);
            float crack = smoothstep(0.045, 0.0, abs(tfbm(wxz * 0.11) - 0.5)) * mk.g;
            soil = mix(soil, vec3(0.52, 0.386, 0.263), mk.g * 0.62);
            soil *= 1.0 - crack * 0.35;
            if (mk.r > 0.01) {
              float band = 0.5 + 0.5 * sin(vWPos.y * 1.85 + tfbm(wxz * 0.2) * 2.2);
              vec3 strata = mix(vec3(0.545, 0.4, 0.28), vec3(0.43, 0.3, 0.2), band);
              float exposure = smoothstep(0.06, 0.3, slope);
              vec3 deltaCol = mix(vec3(0.5, 0.35, 0.235), strata, exposure);
              soil = mix(soil, deltaCol, mk.r * 0.85);
            }
            if (mk.a > 0.01) {
              float scree = 0.5 + 0.5 * sin(vWPos.y * 0.55 + tfbm(wxz * 0.05) * 4.0);
              vec3 wallCol = mix(vec3(0.36, 0.235, 0.155), vec3(0.29, 0.2, 0.14), scree);
              soil = mix(soil, wallCol, mk.a * smoothstep(0.05, 0.25, slope) * 0.7);
            }
            soil *= 0.78 + 0.42 * nFine;
            soil *= 0.88 + 0.24 * tnoise(wxz * 2.7);
            vec2 tuv = vec2(wxz.x / WORLD_M + 0.5, 0.5 - wxz.y / WORLD_M);
            float tr = texture(uTracks, tuv).r;
            soil *= 1.0 - 0.28 * min(tr, 1.0);
            diffuseColor = vec4(soil, 1.0);
          }
        `)
        .replace("#include <roughnessmap_fragment>", /* glsl */`
          float roughnessFactor = roughness;
          {
            vec2 tuv2 = vec2(vWPos.x / WORLD_M + 0.5, 0.5 - vWPos.z / WORLD_M);
            float tr2 = texture(uTracks, tuv2).r;
            roughnessFactor = clamp(roughness - 0.05 * tr2, 0.0, 1.0);
          }
        `);
      self._shaderRefs = self._shaderRefs || [];
      self._shaderRefs.push(shader);
    };
    return mat;
  }

  // ---------------------------------------------------------------- runtime
  splatTrack(x, z, heading, width = 0.42, len = 0.6, strength = 0.5) {
    this.trackQueue.push({ x, z, heading, width, len, strength });
  }
  // flush queued stamps now (used at boot for pre-baked trails)
  flushTracks(renderer) {
    while (this.trackQueue.length) this._renderStamps(renderer, 0);
  }
  _renderStamps(renderer, stormFade) {
    let n = 0;
    for (const m of this._stampPool) m.visible = false;
    while (this.trackQueue.length && n < this._stampPool.length) {
      const s = this.trackQueue.shift();
      const m = this._stampPool[n++];
      m.visible = true;
      m.position.set(s.x, 0, s.z);
      m.rotation.z = -s.heading;
      m.scale.set(s.width, s.len, 1);
      m.material.opacity = s.strength;
    }
    this.fadeQuad.visible = stormFade > 0;
    if (stormFade > 0) this.fadeQuad.material.opacity = stormFade;
    const oldTarget = renderer.getRenderTarget();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.tracksRT);
    renderer.render(this.trackScene, this.trackCam);
    renderer.setRenderTarget(oldTarget);
    renderer.autoClear = oldAutoClear;
    for (const m of this._stampPool) m.visible = false;
    this.fadeQuad.visible = false;
  }
  update(roverPos, renderer, stormFade = 0) {
    const step = TILE_SPAN / TILE_SEG;
    const ox = Math.round(roverPos.x / step) * step;
    const oz = Math.round(roverPos.z / step) * step;
    this.nearMesh.position.set(ox, 0, oz);
    this.uniforms.uTileOrigin.value.set(ox, oz);
    this.uniforms.uRover.value.copy(roverPos);
    if (this.trackQueue.length > 0 || stormFade > 0) this._renderStamps(renderer, stormFade);
  }
}

function frame() { return new Promise((r) => requestAnimationFrame(r)); }
function angDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
export function distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return Math.hypot(px - ax, pz - az);  // degenerate: 0/0 -> NaN
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function makeStampTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 64, 64);
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  g.globalCompositeOperation = "destination-out";
  for (let y = 2; y < 64; y += 7) g.fillRect(0, y, 64, 2.4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function makeRimRing(seed, radius, hMin, hMax, color, cx, cz) {
  const S = new Simplex2(seed);
  const N = 260;
  const positions = [];
  const idx = [];
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = cx + Math.cos(a) * radius, z = cz + Math.sin(a) * radius;
    let h = hMin + (hMax - hMin) * Math.max(0.12, 0.5 + 0.5 * S.fbm(Math.cos(a) * 2.1, Math.sin(a) * 2.1, 4));
    h *= 0.7 + 0.3 * S.noise(Math.cos(a) * 6.3, Math.sin(a) * 6.3);
    // the ring dips where the inlet canyon breaches the rim (west)
    const gap = Math.exp(-Math.pow(angDelta(a, Math.PI) / 0.09, 2));
    h *= 1 - gap * 0.75;
    positions.push(x, -40, z, x, h, z);
  }
  for (let i = 0; i < N; i++) {
    const b = i * 2;
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}
