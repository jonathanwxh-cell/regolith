// Terrain: a 4 km quad on the floor of a large impact crater, modeled on
// Jezero (Perseverance's site): a west-wall river delta with terraced strata
// and a feeder channel, a Kodiak-style remnant butte, a Séítah-style dune
// field, a playa, ~120 craters, and the crater's inner rim wall as the world
// edge. Two-tier render meshes + a material-mask texture + GPU track splats,
// with exact-match JS height sampling for physics.
//
// Generation is multi-resolution: low-frequency noise bands are evaluated on
// coarse grids and bilinearly upsampled, so 2048² costs about what a naive
// 1024² did. Grounded numbers (see DESIGN.md "References"): delta strata
// ~25 m, Kodiak butte 80 m, rim walls 800-1200 m above floor, flood boulders
// to 1.5 m, twilight glow up to 2 h after sunset.
import * as THREE from "three";
import { Simplex2, clamp, lerp, smoothstep } from "./noise.js";

export const WORLD = 4096;      // meters, square, centered on origin
export const HM = 2048;         // main heightmap resolution (2 m / texel)
export const DETAIL_N = 256;    // detail heightmap resolution
export const DETAIL_SPAN = 48;  // meters covered by one detail tile
export const TILE_SPAN = 384;   // near tile size (m)
export const TILE_SEG = 512;    // near tile segments
export const PLAY_R = 1960;     // playable radius (rover clamp)
const FAR_SEG = 512;
const MASK_N = 1024;            // material mask resolution (4 m / texel)

// ---------------------------------------------------------------- layout

export function makeLayout(seed) {
  const rng = new Simplex2(seed);
  const j = (a, s) => rng.noise(a, s) * 30;
  return {
    lander: { x: 980 + j(1, 2), z: -1140 + j(3, 4) },
    halo: { x: 720, z: -780, r: 95 },                    // fresh crater
    old: { x: 250, z: 900, r: 260 },                     // big subdued crater
    delta: {
      apexX: -1520, apexZ: 240, dir: 0,                  // fan opens east
      halfAng: 1.02, radius: 920, topH: 30,              // strata ~25-30 m
    },
    kodiak: { x: -380, z: -60, r: 118, h: 56 },          // remnant butte
    seitah: { x: 450, z: -250, rx: 560, rz: 400, rot: 0.5 },
    playa: { x: -150, z: 260, r: 400 },
    overlook: { x: 900, z: 1350 },                       // rim bench
    channel: { ax: -2150, az: 240 },                     // Neretva-style inlet
  };
}

export class Terrain {
  constructor(seed = 20260813) {
    this.seed = seed;
    this.layout = makeLayout(seed);
    this.heights = new Float32Array(HM * HM);
    this.detail = new Float32Array(DETAIL_N * DETAIL_N);
    this.mask = new Uint8Array(MASK_N * MASK_N * 4); // R delta, G playa, B sand, A rim
    this.craters = [];
    this.minH = 0; this.maxH = 0;
    this.group = new THREE.Group();
    this.trackQueue = [];
  }

  // ------------------------------------------------------------ generation
  async generate(onProgress) {
    const S = new Simplex2(this.seed);
    const SW = new Simplex2(this.seed + 101);
    const SR = new Simplex2(this.seed + 202);
    const SM = new Simplex2(this.seed + 303);
    const rand = (a => () => (a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(this.seed ^ 0x5f3759df);
    const L = this.layout;
    const H = this.heights;
    const px2w = WORLD / HM;

    // ---- pass A (256², 16 m): warp fields + regional relief
    const AN = 256, AS = WORLD / AN;
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

    // ---- pass B (512², 8 m): ridged rim texture + rolling plains
    const BN = 512, BS = WORLD / BN;
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

    // ---- feature helpers (analytic, evaluated per-pixel)
    const D = L.delta, K = L.kodiak, SE = L.seitah, P = L.playa;
    const seCos = Math.cos(SE.rot), seSin = Math.sin(SE.rot);
    const chAx = L.channel.ax, chAz = L.channel.az;
    const chBx = D.apexX, chBz = D.apexZ;
    const ovAng = Math.atan2(L.overlook.z, L.overlook.x);
    const quant = (v, s) => Math.round(v / s) * s;

    // scratch outputs of buildBase
    const out = { h: 0, delta: 0, playa: 0, sand: 0, rim: 0 };
    const buildBase = (wx, wz) => {
      const qx = wx + grid(warpX, AN, wx, wz);
      const qz = wz + grid(warpZ, AN, wx, wz);
      let h = grid(regional, AN, qx, qz) + grid(plainsLow, BN, qx, qz);
      h += 1.7 * S.fbm(wx * 0.014, wz * 0.014, 2);       // 35-70 m undulation
      h += 0.55 * SM.fbm(wx * 0.045, wz * 0.045, 2);     // 10-20 m rubble
      let dMask = 0, pMask = 0, sMask = 0, rMask = 0;

      // -- crater rim wall (radial; ridged spurs; a softened corridor makes
      //    the overlook bench reachable). The wall base stays well outside
      //    the playable floor so it reads as a distant rampart, not a pit.
      const r = Math.hypot(wx, wz);
      if (r > 1550) {
        const rg = grid(ridgedF, BN, qx, qz);
        let wall = smoothstep(1880, 2400, r);
        const aDiff = Math.abs(angDelta(Math.atan2(wz, wx), ovAng));
        const corridor = smoothstep(0.22, 0.05, aDiff);
        wall *= 1 - corridor * 0.45;
        h += wall * wall * (240 + 260 * rg);             // inner wall + spurs
        h += smoothstep(1550, 1980, r) * (8 + 10 * rg);  // talus apron
        rMask = Math.max(rMask, smoothstep(1700, 1960, r));
        // overlook bench: a flat shoulder partway up the corridor, with a
        // long climbable ramp (~16 deg) instead of a cliff
        if (corridor > 0.02) {
          const bench = corridor * smoothstep(1310, 1585, r) * smoothstep(1850, 1700, r);
          h = lerp(h, 92 + 4 * rg, bench * 0.9);
        }
      }

      // -- feeder channel: carves through the wall down to the delta apex
      {
        const d = distToSeg(wx, wz, chAx, chAz, chBx, chBz);
        const carve = smoothstep(170, 55, d) * smoothstep(chBx + 160, chBx - 120, wx);
        if (carve > 0) h -= carve * (15 + 4 * S.noise(wx * 0.01, wz * 0.01));
      }

      // -- the delta fan (terraced strata front, ~30 m thick like Jezero's)
      {
        const dx = wx - D.apexX, dz = wz - D.apexZ;
        const ra = Math.hypot(dx, dz);
        if (ra < D.radius * 1.35) {
          const ang = Math.atan2(dz, dx);
          const aFall = smoothstep(D.halfAng, D.halfAng * 0.7, Math.abs(ang));
          const lobed = D.radius * (0.8 + 0.22 * S.fbm(ang * 1.25 + 9, 4.4, 2) +
            0.06 * S.fbm(wx * 0.004, wz * 0.004, 2));
          const tEdge = smoothstep(lobed, lobed - 70, ra) * aFall;
          if (tEdge > 0.002) {
            const floorLocal = h;
            const top = D.topH - ra * 0.0055 + 1.2 * S.fbm(wx * 0.02, wz * 0.02, 2);
            let hd = floorLocal + tEdge * top;
            // benches: quantize the scarp band into strata steps
            const scarpiness = 4 * tEdge * (1 - tEdge);
            hd = lerp(hd, floorLocal + quant(hd - floorLocal, 5.5), scarpiness * 0.42);
            h = hd;
            dMask = Math.max(dMask, tEdge);
          }
        }
      }

      // -- Kodiak-style remnant butte on the open floor
      {
        const d = Math.hypot(wx - K.x, wz - K.z);
        if (d < K.r * 1.5) {
          const t = smoothstep(K.r, K.r * 0.55, d) *
            (0.85 + 0.15 * S.noise(Math.atan2(wz - K.z, wx - K.x) * 2.3, 7.7));
          if (t > 0.002) {
            const floorLocal = h;
            let hb = floorLocal + t * (K.h + 1.5 * S.fbm(wx * 0.03, wz * 0.03, 2));
            const scarpiness = 4 * t * (1 - t);
            hb = lerp(hb, floorLocal + quant(hb - floorLocal, 6), scarpiness * 0.45);
            h = hb;
            dMask = Math.max(dMask, t); // same strata material as the delta
          }
        }
      }

      // -- playa (paleolake low distal of the delta front)
      {
        const d = Math.hypot(wx - P.x, wz - P.z);
        if (d < P.r * 1.3) {
          const m = smoothstep(P.r * 1.3, P.r * 0.5, d);
          const pf = -7 + 0.9 * S.fbm(wx * 0.004, wz * 0.004, 2);
          h = lerp(h, lerp(h * 0.4, pf, smoothstep(P.r * 0.9, P.r * 0.35, d)), m);
          pMask = Math.max(pMask, m * smoothstep(P.r * 1.1, P.r * 0.6, d));
        }
      }

      // -- Séítah dune maze (transverse dunes; oldest outcrops poke between)
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

      out.h = h; out.delta = dMask; out.playa = pMask; out.sand = sMask; out.rim = rMask;
      return out;
    };
    this._buildBase = buildBase; // probes (site resolution) reuse it

    // ---- pass C (2048², 2 m): assemble heights + the material mask
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
          M[k] = b.delta * 255; M[k + 1] = b.playa * 255;
          M[k + 2] = b.sand * 255; M[k + 3] = b.rim * 255;
        }
      }
      if ((jj & 63) === 0 && onProgress) { onProgress(0.12 + jj / HM * 0.55); await frame(); }
    }

    // ---- craters (bbox rasterized; ~120, spared on the delta + dune cores)
    const craters = [
      { x: L.halo.x, z: L.halo.z, r: L.halo.r, fresh: 1 },
      { x: L.old.x, z: L.old.z, r: L.old.r, fresh: 0.35 },
    ];
    for (let c = 0; c < 130; c++) {
      const r = 12 + Math.pow(rand(), 2.4) * 80;
      const x = (rand() - 0.5) * 3400, z = (rand() - 0.5) * 3400;
      if (Math.hypot(x, z) > 1900) continue;
      if (Math.hypot(x - L.lander.x, z - L.lander.z) < 160 + r) continue;
      if (this.maskAtRaw(x, z, 0) > 0.15) continue;      // not on delta strata
      if (this.maskAtRaw(x, z, 2) > 0.5 && r < 40) continue; // buried by dunes
      craters.push({ x, z, r, fresh: 0.5 + rand() * 0.5 });
    }
    this.craters = craters;
    const SEj = new Simplex2(this.seed + 404);
    const w2i = (wx) => (wx / WORLD + 0.5) * HM - 0.5;
    for (let ci = 0; ci < craters.length; ci++) {
      const c = craters[ci];
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
      if ((ci & 15) === 0 && onProgress) { onProgress(0.67 + ci / craters.length * 0.15); await frame(); }
    }

    // ---- detail tile (small-scale relief shared by shader + physics)
    const SD = new Simplex2(this.seed + 505);
    for (let jj = 0; jj < DETAIL_N; jj++) {
      for (let ii = 0; ii < DETAIL_N; ii++) {
        const u = ii / DETAIL_N, v = jj / DETAIL_N;
        const bx = u * DETAIL_SPAN, bz = v * DETAIL_SPAN;
        let d = 0.22 * SD.fbm(bx * 0.55, bz * 0.55, 3) + 0.09 * SD.fbm(bx * 1.7, bz * 1.7, 2);
        const fx = smoothstep(0.0, 0.12, Math.min(u, 1 - u));
        const fz = smoothstep(0.0, 0.12, Math.min(v, 1 - v));
        d *= 0.35 + 0.65 * fx * fz;
        this.detail[jj * DETAIL_N + ii] = d;
      }
    }

    let mn = Infinity, mx = -Infinity;
    for (let k = 0; k < H.length; k++) { const v = H[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
    this.minH = mn; this.maxH = mx;
    if (onProgress) { onProgress(0.84); await frame(); }
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
  sampleDetail(wx, wz) {
    const D = this.detail;
    let u = wx / DETAIL_SPAN, v = wz / DETAIL_SPAN;
    u -= Math.floor(u); v -= Math.floor(v);
    let gx = u * DETAIL_N - 0.5, gz = v * DETAIL_N - 0.5;
    const i0 = Math.floor(gx), j0 = Math.floor(gz);
    const fx = gx - i0, fz = gz - j0;
    const w = (n) => ((n % DETAIL_N) + DETAIL_N) % DETAIL_N;
    const a = D[w(j0) * DETAIL_N + w(i0)], b = D[w(j0) * DETAIL_N + w(i0 + 1)];
    const c = D[w(j0 + 1) * DETAIL_N + w(i0)], d = D[w(j0 + 1) * DETAIL_N + w(i0 + 1)];
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
  }
  heightAt(wx, wz) { return this.sampleMain(wx, wz) + this.sampleDetail(wx, wz); }
  normalAt(wx, wz, e = 0.6) {
    const hx0 = this.heightAt(wx - e, wz), hx1 = this.heightAt(wx + e, wz);
    const hz0 = this.heightAt(wx, wz - e), hz1 = this.heightAt(wx, wz + e);
    return new THREE.Vector3(hx0 - hx1, 2 * e, hz0 - hz1).normalize();
  }
  slopeAt(wx, wz) { return Math.acos(clamp(this.normalAt(wx, wz).y, -1, 1)); }

  // material mask lookup (channel: 0 delta strata, 1 playa, 2 sand, 3 rim)
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
    this.heightTex = new THREE.DataTexture(this.heights, HM, HM, THREE.RedFormat, THREE.FloatType);
    this.heightTex.magFilter = this.heightTex.minFilter = THREE.NearestFilter;
    this.heightTex.needsUpdate = true;
    this.detailTex = new THREE.DataTexture(this.detail, DETAIL_N, DETAIL_N, THREE.RedFormat, THREE.FloatType);
    this.detailTex.magFilter = this.detailTex.minFilter = THREE.NearestFilter;
    this.detailTex.needsUpdate = true;
    this.maskTex = new THREE.DataTexture(this.mask, MASK_N, MASK_N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.maskTex.magFilter = this.maskTex.minFilter = THREE.LinearFilter;
    this.maskTex.needsUpdate = true;

    // wheel-track accumulation target (R8; 4096² keeps ~1 m/texel over 4 km)
    this.tracksRT = new THREE.WebGLRenderTarget(4096, 4096, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    });
    this.trackScene = new THREE.Scene();
    this.trackCam = new THREE.OrthographicCamera(-WORLD / 2, WORLD / 2, WORLD / 2, -WORLD / 2, -10, 10);
    this.trackCam.position.set(0, 1, 0);
    this.trackCam.up.set(0, 0, -1);
    this.trackCam.lookAt(0, 0, 0);
    const stampTex = makeStampTexture();
    this.stampMat = new THREE.MeshBasicMaterial({
      map: stampTex, transparent: true, blending: THREE.AdditiveBlending,
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
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.stampMat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.trackScene.add(m);
      this._stampPool.push(m);
    }

    this.uniforms = {
      uHeight: { value: this.heightTex },
      uDetail: { value: this.detailTex },
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
    this.nearMesh.castShadow = false; // fragment normals carry the relief
    this.group.add(this.nearMesh);

    // far surface as a 4x4 grid of modest draws rather than one 263k-vertex
    // mesh: frustum-cullable, and the single huge indexed draw produced
    // corrupted "sky ribbon" triangles on the RT path of at least one
    // ANGLE/D3D11 driver (Intel Arc) while rendering fine direct-to-canvas
    this.farMat = this.makeMaterial({ near: false });
    this.farTiles = [];
    const FT = 4, span = WORLD / FT, seg = FAR_SEG / FT;
    for (let tj = 0; tj < FT; tj++) {
      for (let ti = 0; ti < FT; ti++) {
        const cx = -WORLD / 2 + (ti + 0.5) * span;
        const cz = -WORLD / 2 + (tj + 0.5) * span;
        const g = new THREE.PlaneGeometry(span, span, seg, seg);
        g.rotateX(-Math.PI / 2);
        g.translate(cx, 0, cz);
        const p = g.attributes.position;
        for (let k = 0; k < p.count; k++) {
          const x = p.getX(k), z = p.getZ(k);
          p.setY(k, this.sampleMain(x, z) + this.sampleDetail(x, z));
        }
        g.computeVertexNormals();
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, this.farMat);
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        this.farTiles.push(mesh);
        this.group.add(mesh);
      }
    }

    // the crater rim continues past the heightfield: two silhouette rings
    this.group.add(makeRimRing(this.seed + 606, 4600, 260, 560, 0x63422f));
    this.group.add(makeRimRing(this.seed + 707, 7200, 560, 1080, 0x5c3e2d));
    return this.group;
  }

  glslCommon() {
    return /* glsl */`
      uniform sampler2D uHeight;
      uniform sampler2D uDetail;
      const float WORLD_M = ${WORLD.toFixed(1)};
      const float HM_N = ${HM.toFixed(1)};
      const float DET_N = ${DETAIL_N.toFixed(1)};
      const float DET_SPAN = ${DETAIL_SPAN.toFixed(1)};
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
      float sampleDetailH(vec2 wxz) {
        vec2 uv = fract(wxz / DET_SPAN);
        vec2 g = uv * DET_N - 0.5;
        ivec2 i0 = ivec2(floor(g));
        vec2 f = fract(g);
        ivec2 w00 = (i0 % int(DET_N) + int(DET_N)) % int(DET_N);
        ivec2 w11 = ((i0 + 1) % int(DET_N) + int(DET_N)) % int(DET_N);
        float a = texelFetch(uDetail, ivec2(w00.x, w00.y), 0).r;
        float b = texelFetch(uDetail, ivec2(w11.x, w00.y), 0).r;
        float c = texelFetch(uDetail, ivec2(w00.x, w11.y), 0).r;
        float d = texelFetch(uDetail, ivec2(w11.x, w11.y), 0).r;
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float totalH(vec2 wxz) { return sampleMainH(wxz) + sampleDetailH(wxz); }
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
    // CRITICAL: near and far share identical onBeforeCompile SOURCE TEXT and
    // differ only via this closure, so three's program cache would otherwise
    // unify them — handing the far mesh the near-tile vertex displacement and
    // flinging its geometry into the sky (the "dark ribbon" bug, 2026-09-05).
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
          float hx0 = totalH(vWPos.xz - vec2(nE, 0.0));
          float hx1 = totalH(vWPos.xz + vec2(nE, 0.0));
          float hz0 = totalH(vWPos.xz - vec2(0.0, nE));
          float hz1 = totalH(vWPos.xz + vec2(0.0, nE));
          vec3 worldN = normalize(vec3(hx0 - hx1, 2.0 * nE, hz0 - hz1));
          #ifndef NEAR_TILE
            if (distance(vWPos.xz, uRover.xz) < 176.0) discard;
          #endif
          {
            vec2 wxz = vWPos.xz;
            vec2 muv = wxz / WORLD_M + 0.5;
            vec4 mk = texture(uMask, muv);        // R delta, G playa, B sand, A rim
            float slope = 1.0 - worldN.y;
            float nBig = tfbm(wxz * 0.013);
            float nMed = tfbm(wxz * 0.061);
            float nFine = tfbm(wxz * 0.43);
            // base regolith
            vec3 soil = mix(vec3(0.386, 0.223, 0.133), vec3(0.475, 0.286, 0.176), nBig);
            // Maaz-like dark lava-flow floor patches + slope-exposed basalt
            float basaltM = smoothstep(0.5, 0.88, nMed + slope * 1.3);
            soil = mix(soil, vec3(0.234, 0.163, 0.118), basaltM * 0.6);
            // bright fine dust in flats
            float dustM = smoothstep(0.6, 0.8, nBig) * smoothstep(0.10, 0.02, slope);
            soil = mix(soil, vec3(0.557, 0.361, 0.230), dustM * 0.42);
            // faint aeolian ripples on dust-holding flats
            float rip = 0.5 + 0.5 * sin(dot(wxz, vec2(0.86, 0.51)) * 2.6 + tfbm(wxz * 0.09) * 5.0);
            soil *= 1.0 - (1.0 - smoothstep(0.0, 0.14, slope)) * rip * 0.05;
            // Seitah sand: redder, rippled
            float ripple = 0.5 + 0.5 * sin((wxz.x * 0.83 + wxz.y * 0.55) * 4.2 + tfbm(wxz * 0.12) * 6.0);
            soil = mix(soil, mix(vec3(0.42, 0.222, 0.122), vec3(0.51, 0.30, 0.17), ripple), mk.b * 0.6);
            // playa: pale evaporite floor with polygonal cracks
            float crack = smoothstep(0.045, 0.0, abs(tfbm(wxz * 0.11) - 0.5)) * mk.g;
            soil = mix(soil, vec3(0.52, 0.386, 0.263), mk.g * 0.62);
            soil *= 1.0 - crack * 0.35;
            // delta + butte strata: light-toned layered sediment, banded by
            // elevation on the scarps, dust-mantled on the flat top
            if (mk.r > 0.01) {
              float band = 0.5 + 0.5 * sin(vWPos.y * 1.85 + tfbm(wxz * 0.2) * 2.2);
              vec3 strata = mix(vec3(0.545, 0.4, 0.28), vec3(0.43, 0.3, 0.2), band);
              float exposure = smoothstep(0.06, 0.3, slope);       // scarps show layers
              vec3 deltaCol = mix(vec3(0.5, 0.35, 0.235), strata, exposure);
              soil = mix(soil, deltaCol, mk.r * 0.85);
            }
            // rim wall: rockier, slightly grayer with scree striping
            if (mk.a > 0.01) {
              float scree = 0.5 + 0.5 * sin(vWPos.y * 0.55 + tfbm(wxz * 0.05) * 4.0);
              vec3 wallCol = mix(vec3(0.36, 0.235, 0.155), vec3(0.29, 0.2, 0.14), scree);
              soil = mix(soil, wallCol, mk.a * smoothstep(0.05, 0.25, slope) * 0.7);
            }
            // micro speckle + granule shadowing
            soil *= 0.78 + 0.42 * nFine;
            soil *= 0.88 + 0.24 * tnoise(wxz * 2.7);
            // wheel tracks (disturbed regolith is darker)
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
  update(roverPos, renderer, stormFade = 0) {
    const step = TILE_SPAN / TILE_SEG;
    const ox = Math.round(roverPos.x / step) * step;
    const oz = Math.round(roverPos.z / step) * step;
    this.nearMesh.position.set(ox, 0, oz);
    this.uniforms.uTileOrigin.value.set(ox, oz);
    this.uniforms.uRover.value.copy(roverPos);

    if (this.trackQueue.length > 0 || stormFade > 0) {
      let n = 0;
      for (const m of this._stampPool) m.visible = false;
      while (this.trackQueue.length && n < this._stampPool.length) {
        const s = this.trackQueue.shift();
        const m = this._stampPool[n++];
        m.visible = true;
        m.position.set(s.x, 0, s.z);
        m.rotation.z = -s.heading;
        m.scale.set(s.width, s.len, 1);
        this.stampMat.opacity = s.strength;
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
  }
}

function frame() { return new Promise((r) => requestAnimationFrame(r)); }
function angDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
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

// A ring of rim silhouette beyond the heightfield. Jezero's inner walls rise
// 800-1200 m above the floor; ours are artistically compressed by distance.
function makeRimRing(seed, radius, hMin, hMax, color) {
  const S = new Simplex2(seed);
  const N = 260;
  const positions = [];
  const idx = [];
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
    let h = hMin + (hMax - hMin) * Math.max(0.12, 0.5 + 0.5 * S.fbm(Math.cos(a) * 2.1, Math.sin(a) * 2.1, 4));
    h *= 0.7 + 0.3 * S.noise(Math.cos(a) * 6.3, Math.sin(a) * 6.3);
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
