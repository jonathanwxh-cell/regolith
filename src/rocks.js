// Rock fields: chunked InstancedMeshes (frustum-cullable), density shaped by
// noise + crater ejecta, with a sparse list of collidable boulders.
import * as THREE from "three";
import { Simplex2, clamp } from "./noise.js";
import { WORLD } from "./terrain.js";

const CHUNKS = 12;                // 12x12 grid over the 4 km quad
const PER_CHUNK = 520;

export class Rocks {
  constructor(terrain, seed = 7) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.boulders = []; // {x, z, r} collidable

    const geos = [
      makeRockGeo(seed + 1, 1.0, 0.55),
      makeRockGeo(seed + 2, 0.8, 0.8),
      makeRockGeo(seed + 3, 1.25, 0.4),
    ];
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.94, metalness: 0.02, vertexColors: true, color: 0xffffff,
    });
    const S = new Simplex2(seed + 44);
    const rnd = (() => { let s = (seed * 2654435761) >>> 0 || 7; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
    const dummy = new THREE.Object3D();
    const chunkSpan = WORLD / CHUNKS;
    const L = terrain.layout;

    for (let cj = 0; cj < CHUNKS; cj++) {
      for (let ci = 0; ci < CHUNKS; ci++) {
        const geo = geos[(ci + cj) % 3];
        const mesh = new THREE.InstancedMesh(geo, mat, PER_CHUNK);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        let placed = 0;
        const cx0 = -WORLD / 2 + ci * chunkSpan, cz0 = -WORLD / 2 + cj * chunkSpan;
        let attempts = 0;
        while (placed < PER_CHUNK && attempts < PER_CHUNK * 5) {
          attempts++;
          const x = cx0 + rnd() * chunkSpan;
          const z = cz0 + rnd() * chunkSpan;
          if (Math.hypot(x, z) > 2010) continue;             // outside the wall
          // density: noise patches + crater ejecta + geologic units
          let density = 0.35 + 0.65 * Math.max(0, S.fbm(x * 0.004, z * 0.004, 3));
          for (const c of terrain.craters) {
            const d = Math.hypot(x - c.x, z - c.z) / c.r;
            if (d < 0.85) density *= 0.25;                    // clean bowls
            else if (d < 2.0) density += 0.5 * Math.exp(-(d - 1) * 2.0); // ejecta
          }
          const mDelta = terrain.maskAtRaw(x, z, 0);
          const mSand = terrain.maskAtRaw(x, z, 2);
          const mRim = terrain.maskAtRaw(x, z, 3);
          const slope = 1 - terrain.normalAt(x, z, 2.5).y;
          // flood-boulder talus below the delta scarps (clasts to ~1.5 m)
          const talus = mDelta > 0.04 && mDelta < 0.6 && slope > 0.06;
          if (talus) density *= 2.6;
          else if (mDelta > 0.6) density *= 0.3;              // dust-mantled top
          if (mRim > 0.2) density *= 1.7;                     // wall scree
          if (terrain.inBasin(x, z)) density *= 0.22;         // playa is clean
          let slab = false;
          if (mSand > 0.45) {
            // Seitah: mostly sand, but the oldest unit outcrops between ripples
            if (rnd() < 0.1) slab = true;
            else density *= 0.1;
          }
          if (Math.hypot(x - L.lander.x, z - L.lander.z) < 14) continue;
          if (!slab && rnd() > density * 0.85) continue;

          const big = !slab && rnd() < (talus ? 0.09 : 0.035);
          const s = slab ? 1.3 + rnd() * 1.8
            : big ? 0.85 + rnd() * (talus ? 1.05 : 1.9)       // talus clasts <=1.5 m
            : 0.1 + Math.pow(rnd(), 2.2) * 0.7;
          const y = terrain.heightAt(x, z) - s * (slab ? 0.6 : 0.42);
          dummy.position.set(x, y, z);
          dummy.rotation.set(rnd() * (slab ? 0.12 : 0.5) - (slab ? 0.06 : 0.25), rnd() * Math.PI * 2, rnd() * (slab ? 0.12 : 0.5) - (slab ? 0.06 : 0.25));
          if (slab) dummy.scale.set(s * (1.2 + rnd()), s * 0.3, s * (1.2 + rnd()));
          else dummy.scale.set(s * (0.8 + rnd() * 0.5), s * (0.65 + rnd() * 0.5), s * (0.8 + rnd() * 0.5));
          dummy.updateMatrix();
          mesh.setMatrixAt(placed, dummy.matrix);
          placed++;
          if (big && s > 1.0) this.boulders.push({ x, z, r: s * 0.95 });
        }
        mesh.count = placed;
        mesh.instanceMatrix.needsUpdate = true;
        // manual bounding sphere so frustum culling works per chunk
        geo.computeBoundingSphere();
        mesh.boundingSphere = new THREE.Sphere(
          new THREE.Vector3(cx0 + chunkSpan / 2, 0, cz0 + chunkSpan / 2),
          chunkSpan * 0.75 + 40
        );
        mesh.frustumCulled = true;
        this.group.add(mesh);
      }
    }
  }

  // circle pushback for the rover against big boulders
  collide(pos, radius = 1.4) {
    for (const b of this.boulders) {
      const dx = pos.x - b.x, dz = pos.z - b.z;
      const d2 = dx * dx + dz * dz;
      const minD = b.r + radius;
      if (d2 < minD * minD && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (minD - d);
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
        return true;
      }
    }
    return false;
  }
}

function makeRockGeo(seed, spikiness, flatten) {
  const S = new Simplex2(seed * 991);
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = S.fbm(v.x * 1.4 + seed, v.y * 1.4 - seed, 3) * 0.42 * spikiness +
      S.fbm(v.x * 4.2, v.z * 4.2, 2) * 0.14;
    v.multiplyScalar(1 + n);
    v.y *= (1 - flatten * 0.35);
    if (v.y < -0.55) v.y = -0.55 - (v.y + 0.55) * 0.25; // flat-ish base
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  // vertex color: darker undersides + tonal variety
  const col = new Float32Array(pos.count * 3);
  const base = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = clamp(0.5 + S.noise(v.x * 2.1, v.z * 2.1) * 0.5, 0, 1);
    base.setRGB(0.32 + t * 0.14, 0.225 + t * 0.09, 0.16 + t * 0.06);
    const ao = clamp(0.55 + v.y * 0.55, 0.35, 1);
    col[i * 3] = base.r * ao;
    col[i * 3 + 1] = base.g * ao;
    col[i * 3 + 2] = base.b * ao;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}
