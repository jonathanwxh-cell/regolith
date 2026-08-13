// Terrain: procedural 2 km heightfield, two-tier render meshes, custom PBR
// shader (fragment-space normals, composed albedo, wheel-track splats), and
// exact-match JS height sampling for physics.
import * as THREE from "three";
import { Simplex2, clamp, lerp, smoothstep } from "./noise.js";

export const WORLD = 2048;      // meters, square, centered on origin
export const HM = 1024;         // main heightmap resolution (2 m / texel)
export const DETAIL_N = 256;    // detail heightmap resolution
export const DETAIL_SPAN = 48;  // meters covered by one detail tile
export const TILE_SPAN = 384;   // near tile size (m)
export const TILE_SEG = 512;    // near tile segments
const FAR_SEG = 512;

// ---------------------------------------------------------------- generation

export function makeLayout(seed) {
  const rng = new Simplex2(seed);
  const jx = rng.noise(0.7, 3.1) * 40, jz = rng.noise(5.3, 1.9) * 40;
  return {
    lander: { x: -120 + jx, z: -680 + jz },
    basin: { x: -380, z: 260, r: 330 },
    dune: { cx: 350, cz: -150, dirX: 0.834, dirZ: 0.552, halfW: 240, halfL: 620 },
    ridge: { x: 620, z: 640, r: 520 },
    halo: { x: 180, z: -420, r: 118 },
  };
}

export class Terrain {
  constructor(seed = 20260813) {
    this.seed = seed;
    this.layout = makeLayout(seed);
    this.heights = new Float32Array(HM * HM);
    this.detail = new Float32Array(DETAIL_N * DETAIL_N);
    this.craters = [];
    this.minH = 0; this.maxH = 0;
    this.group = new THREE.Group();
    this.trackQueue = [];
  }

  async generate(onProgress) {
    const S = new Simplex2(this.seed);
    const SW = new Simplex2(this.seed + 101);
    const SR = new Simplex2(this.seed + 202);
    const SM = new Simplex2(this.seed + 303);
    const rand = (a => () => (a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(this.seed ^ 0x5f3759df);
    const L = this.layout;
    const H = this.heights;
    const px2w = WORLD / HM; // 2 m
    const w2i = (wx) => (wx / WORLD + 0.5) * HM - 0.5;

    // -- base pass: warped fBm plains + regional relief + ridge + basin + dunes
    const duneLen = Math.hypot(L.dune.dirX, L.dune.dirZ);
    const ddx = L.dune.dirX / duneLen, ddz = L.dune.dirZ / duneLen;
    for (let j = 0; j < HM; j++) {
      const wz = (j / HM - 0.5) * WORLD + px2w * 0.5;
      for (let i = 0; i < HM; i++) {
        const wx = (i / HM - 0.5) * WORLD + px2w * 0.5;
        // domain warp
        const qx = wx + 130 * SW.fbm(wx * 0.0011, wz * 0.0011, 3);
        const qz = wz + 130 * SW.fbm(wx * 0.0011 + 7.7, wz * 0.0011 + 3.3, 3);
        let h = 30 * S.fbm(qx * 0.00062, qz * 0.00062, 3);          // regional
        h += 15 * S.fbm(qx * 0.0016, qz * 0.0016, 5);               // plains
        h += 2.6 * S.fbm(wx * 0.012, wz * 0.012, 3);                // rubble
        // ridged highland (NE)
        const dr = Math.hypot(wx - L.ridge.x, wz - L.ridge.z);
        const rm = smoothstep(L.ridge.r, L.ridge.r * 0.25, dr);
        if (rm > 0) h += rm * (14 + 52 * SR.ridged(wx * 0.0021, wz * 0.0021, 5));
        // lakebed basin: scoop + flatten floor
        const db = Math.hypot(wx - L.basin.x, wz - L.basin.z);
        if (db < L.basin.r * 1.35) {
          const t = smoothstep(L.basin.r * 1.35, L.basin.r * 0.55, db);
          const floor = -14 + 1.1 * S.fbm(wx * 0.004, wz * 0.004, 2);
          h = lerp(h, lerp(h * 0.35 - 8, floor, smoothstep(L.basin.r * 0.85, L.basin.r * 0.35, db)), t);
        }
        // dune band (asymmetric transverse dunes)
        const rx = wx - L.dune.cx, rz = wz - L.dune.cz;
        const along = rx * ddx + rz * ddz;
        const across = -rx * ddz + rz * ddx;
        const bandM = smoothstep(L.dune.halfW, L.dune.halfW * 0.55, Math.abs(across)) *
                      smoothstep(L.dune.halfL, L.dune.halfL * 0.62, Math.abs(along)) *
                      (0.55 + 0.45 * S.fbm(wx * 0.0021 + 40, wz * 0.0021 - 17, 2));
        if (bandM > 0.02) {
          const warp = 9 * S.fbm(wx * 0.006, wz * 0.006, 2);
          let ph = (across + warp) / 34; ph -= Math.floor(ph); // 0..1 sawtooth phase
          const prof = ph < 0.72 ? smoothstep(0, 0.72, ph) : 1 - smoothstep(0.72, 1, ph); // slow windward, steep lee
          h += bandM * (2.4 * prof + 0.5 * S.noise(along * 0.05, across * 0.2));
        }
        // world-edge containment wall
        const edge = Math.max(Math.abs(wx), Math.abs(wz));
        if (edge > 900) h += smoothstep(900, 1020, edge) * 26;
        H[j * HM + i] = h;
      }
      if ((j & 63) === 0 && onProgress) { onProgress(j / HM * 0.7); await frame(); }
    }

    // -- craters (bbox rasterized): halo + 33 random
    const craters = [{ x: L.halo.x, z: L.halo.z, r: L.halo.r }];
    for (let c = 0; c < 33; c++) {
      const r = 8 + Math.pow(rand(), 2.2) * 64;
      const x = (rand() - 0.5) * 1800, z = (rand() - 0.5) * 1800;
      if (Math.hypot(x - L.lander.x, z - L.lander.z) < 130 + r) continue;
      if (Math.hypot(x - L.basin.x, z - L.basin.z) < L.basin.r * 0.8) continue;
      craters.push({ x, z, r });
    }
    this.craters = craters;
    const SE = new Simplex2(this.seed + 404);
    for (const c of craters) {
      const R = c.r, depth = Math.min(0.17 * R, 13), rim = Math.min(0.055 * R, 4.2);
      const ext = R * 2.1;
      const i0 = Math.max(0, Math.floor(w2i(c.x - ext))), i1 = Math.min(HM - 1, Math.ceil(w2i(c.x + ext)));
      const j0 = Math.max(0, Math.floor(w2i(c.z - ext))), j1 = Math.min(HM - 1, Math.ceil(w2i(c.z + ext)));
      for (let j = j0; j <= j1; j++) {
        const wz = (j / HM - 0.5) * WORLD + px2w * 0.5;
        for (let i = i0; i <= i1; i++) {
          const wx = (i / HM - 0.5) * WORLD + px2w * 0.5;
          const d = Math.hypot(wx - c.x, wz - c.z) / R;
          if (d > 2.1) continue;
          let dh = 0;
          if (d < 1) {
            const bowl = (d * d * 1.12 - 1) * depth;                 // depression
            dh = bowl + rim * Math.exp(-Math.pow((d - 1) * 3.2, 2));
          } else {
            dh = rim * Math.exp(-Math.pow((d - 1) * 3.2, 2));        // rim outside
            dh += rim * 0.5 * Math.exp(-(d - 1) * 2.4) * SE.fbm(wx * 0.05, wz * 0.05, 2); // ejecta
          }
          H[j * HM + i] += dh;
        }
      }
    }
    if (onProgress) { onProgress(0.8); await frame(); }

    // -- detail tile (small-scale relief shared by shader + physics)
    const SD = new Simplex2(this.seed + 505);
    for (let j = 0; j < DETAIL_N; j++) {
      for (let i = 0; i < DETAIL_N; i++) {
        // periodic via 4D-trick substitute: sample on a torus using two offset reads
        const u = i / DETAIL_N, v = j / DETAIL_N;
        const bx = u * DETAIL_SPAN, bz = v * DETAIL_SPAN;
        let d = 0.22 * SD.fbm(bx * 0.55, bz * 0.55, 3) + 0.09 * SD.fbm(bx * 1.7, bz * 1.7, 2);
        // force tileability by blending toward the wrapped edge
        const fx = smoothstep(0.0, 0.12, Math.min(u, 1 - u));
        const fz = smoothstep(0.0, 0.12, Math.min(v, 1 - v));
        d *= 0.35 + 0.65 * fx * fz;
        this.detail[j * DETAIL_N + i] = d;
      }
    }

    let mn = Infinity, mx = -Infinity;
    for (let k = 0; k < H.length; k++) { const v = H[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
    this.minH = mn; this.maxH = mx;
    if (onProgress) { onProgress(0.86); await frame(); }
  }

  // ------------------------------------------------------------- JS sampling
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
    const n = new THREE.Vector3(hx0 - hx1, 2 * e, hz0 - hz1);
    return n.normalize();
  }
  slopeAt(wx, wz) { return Math.acos(clamp(this.normalAt(wx, wz).y, -1, 1)); }
  inDuneBand(wx, wz) {
    const L = this.layout.dune;
    const len = Math.hypot(L.dirX, L.dirZ);
    const ddx = L.dirX / len, ddz = L.dirZ / len;
    const rx = wx - L.cx, rz = wz - L.cz;
    const along = rx * ddx + rz * ddz, across = -rx * ddz + rz * ddx;
    return Math.abs(across) < L.halfW * 0.6 && Math.abs(along) < L.halfL * 0.62;
  }
  inBasin(wx, wz) {
    const B = this.layout.basin;
    return Math.hypot(wx - B.x, wz - B.z) < B.r;
  }

  // ------------------------------------------------------------ GPU assembly
  build(renderer) {
    // height + detail as float textures (nearest; bilinear done manually)
    this.heightTex = new THREE.DataTexture(this.heights, HM, HM, THREE.RedFormat, THREE.FloatType);
    this.heightTex.magFilter = this.heightTex.minFilter = THREE.NearestFilter;
    this.heightTex.needsUpdate = true;
    this.detailTex = new THREE.DataTexture(this.detail, DETAIL_N, DETAIL_N, THREE.RedFormat, THREE.FloatType);
    this.detailTex.magFilter = this.detailTex.minFilter = THREE.NearestFilter;
    this.detailTex.needsUpdate = true;

    // wheel-track accumulation target
    this.tracksRT = new THREE.WebGLRenderTarget(2048, 2048, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    });
    this.trackScene = new THREE.Scene();
    this.trackCam = new THREE.OrthographicCamera(-WORLD / 2, WORLD / 2, WORLD / 2, -WORLD / 2, -10, 10);
    this.trackCam.position.set(0, 1, 0);
    this.trackCam.up.set(0, 0, -1);
    this.trackCam.lookAt(0, 0, 0);
    // NOTE: ortho top=+W/2 means world +z maps to v=0; account for that in shader uv
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
    // clear the RT once
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
      uTileOrigin: { value: new THREE.Vector2(0, 0) },
      uRover: { value: new THREE.Vector3(0, 0, 0) },
      uBasin: { value: new THREE.Vector3(this.layout.basin.x, this.layout.basin.z, this.layout.basin.r) },
      uDune: { value: new THREE.Vector4(this.layout.dune.cx, this.layout.dune.cz, this.layout.dune.dirX, this.layout.dune.dirZ) },
      uDuneExt: { value: new THREE.Vector2(this.layout.dune.halfW, this.layout.dune.halfL) },
    };

    // near tile
    const nearGeo = new THREE.PlaneGeometry(TILE_SPAN, TILE_SPAN, TILE_SEG, TILE_SEG);
    nearGeo.rotateX(-Math.PI / 2);
    this.nearMat = this.makeMaterial({ near: true });
    this.nearMesh = new THREE.Mesh(nearGeo, this.nearMat);
    this.nearMesh.frustumCulled = false;
    this.nearMesh.receiveShadow = true;
    // terrain does NOT self-cast: fragment normals carry the relief, and a
    // displaced depth pass produces acne + a visible frustum-edge seam
    this.nearMesh.castShadow = false;
    this.group.add(this.nearMesh);

    // far mesh (CPU-displaced, no detail)
    const farGeo = new THREE.PlaneGeometry(WORLD, WORLD, FAR_SEG, FAR_SEG);
    farGeo.rotateX(-Math.PI / 2);
    const pos = farGeo.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), z = pos.getZ(k);
      pos.setY(k, this.sampleMain(x, z) + this.sampleDetail(x, z));
    }
    farGeo.computeVertexNormals();
    this.farMat = this.makeMaterial({ near: false });
    this.farMesh = new THREE.Mesh(farGeo, this.farMat);
    this.farMesh.receiveShadow = true;
    this.farMesh.frustumCulled = false;
    this.group.add(this.farMesh);

    // distant mesa ring for horizon scale
    this.group.add(makeMesaRing(this.seed));
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
      // tiny value noise for albedo work
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
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.96, metalness: 0.0,
    });
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
          uniform vec3 uRover;
          uniform vec3 uBasin;
          uniform vec4 uDune;
          uniform vec2 uDuneExt;
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
            float slope = 1.0 - worldN.y;
            float nBig = tfbm(wxz * 0.013);
            float nMed = tfbm(wxz * 0.061);
            float nFine = tfbm(wxz * 0.43);
            // base regolith
            vec3 soil = mix(vec3(0.386, 0.223, 0.133), vec3(0.475, 0.286, 0.176), nBig);
            // dark basalt exposures on slopes + noisy patches
            float basaltM = smoothstep(0.5, 0.88, nMed + slope * 1.3);
            soil = mix(soil, vec3(0.234, 0.163, 0.118), basaltM * 0.6);
            // bright fine dust in flats
            float dustM = smoothstep(0.6, 0.8, nBig) * smoothstep(0.10, 0.02, slope);
            soil = mix(soil, vec3(0.557, 0.361, 0.230), dustM * 0.42);
            // dune band: redder, ripple striping
            float dlen = length(uDune.zw);
            vec2 dd = uDune.zw / max(dlen, 1e-5);
            vec2 rp = wxz - uDune.xy;
            float along = dot(rp, dd);
            float across = dot(rp, vec2(-dd.y, dd.x));
            float bandM = smoothstep(uDuneExt.x, uDuneExt.x * 0.55, abs(across)) *
                          smoothstep(uDuneExt.y, uDuneExt.y * 0.62, abs(along));
            float ripple = 0.5 + 0.5 * sin(across * 4.2 + tfbm(wxz * 0.12) * 6.0);
            soil = mix(soil, mix(vec3(0.42, 0.222, 0.122), vec3(0.51, 0.30, 0.17), ripple), bandM * 0.55);
            // playa (lakebed floor): pale, polygonal cracks
            float db = distance(wxz, uBasin.xy);
            float playaM = smoothstep(uBasin.z * 0.8, uBasin.z * 0.45, db) * smoothstep(0.09, 0.02, slope);
            float crack = smoothstep(0.045, 0.0, abs(tfbm(wxz * 0.11) - 0.5)) * playaM;
            soil = mix(soil, vec3(0.52, 0.386, 0.263), playaM * 0.65);
            soil *= 1.0 - crack * 0.35;
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

  makeDepthMaterial() {
    const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uHeight: this.uniforms.uHeight,
        uDetail: this.uniforms.uDetail,
        uTileOrigin: this.uniforms.uTileOrigin,
      });
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${this.glslCommon()}\nuniform vec2 uTileOrigin;`)
        .replace("#include <begin_vertex>", /* glsl */`
          vec3 transformed = vec3(position);
          vec2 wxz = position.xz + uTileOrigin;
          transformed.y = totalH(wxz);
        `);
    };
    return mat;
  }

  // ---------------------------------------------------------------- runtime
  splatTrack(x, z, heading, width = 0.42, len = 0.6, strength = 0.5) {
    this.trackQueue.push({ x, z, heading, width, len, strength });
  }
  update(roverPos, renderer, stormFade = 0) {
    // snap near tile to grid so vertices never swim
    const step = TILE_SPAN / TILE_SEG;
    const ox = Math.round(roverPos.x / step) * step;
    const oz = Math.round(roverPos.z / step) * step;
    this.nearMesh.position.set(ox, 0, oz);
    this.uniforms.uTileOrigin.value.set(ox, oz);
    this.uniforms.uRover.value.copy(roverPos);

    // render queued track stamps into the RT
    if (this.trackQueue.length > 0 || stormFade > 0) {
      let n = 0;
      for (const m of this._stampPool) m.visible = false;
      while (this.trackQueue.length && n < this._stampPool.length) {
        const s = this.trackQueue.shift();
        const m = this._stampPool[n++];
        m.visible = true;
        m.position.set(s.x, 0, s.z);
        m.rotation.z = -s.heading; // plane rotated -x90; z-rot spins in ground plane
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

function makeStampTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 64, 64);
  // two tread bands with lug gaps
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  g.globalCompositeOperation = "destination-out";
  for (let y = 2; y < 64; y += 7) g.fillRect(0, y, 64, 2.4); // tread gaps
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function makeMesaRing(seed) {
  const S = new Simplex2(seed + 606);
  const N = 220, R = 3400;
  const positions = [];
  const idx = [];
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = Math.cos(a) * R, z = Math.sin(a) * R;
    let h = 40 + 190 * Math.max(0, S.fbm(Math.cos(a) * 2.3, Math.sin(a) * 2.3, 4));
    h *= 0.55 + 0.45 * S.noise(Math.cos(a) * 7, Math.sin(a) * 7);
    positions.push(x, -30, z, x, h, z);
  }
  for (let i = 0; i < N; i++) {
    const b = i * 2;
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x6b4834, roughness: 1, metalness: 0, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}
