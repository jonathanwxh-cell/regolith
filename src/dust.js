// Particulates: wheel dust, drill dust bursts, roaming daytime dust devils,
// and horizontal storm streaks. One pooled Points system with a soft-sprite
// shader; dust devils are separate columns with a scrolling-noise shader.
import * as THREE from "three";
import { Simplex2, clamp } from "./noise.js";

const POOL = 1400;

export class Dust {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.scene = scene;
    this.noise = new Simplex2(31337);
    this.emitters = [];
    this.t = 0;

    // ---- pooled soft particles
    const pos = new Float32Array(POOL * 3);
    const attr = new Float32Array(POOL * 4); // birth, life, size0, size1
    const vel = new Float32Array(POOL * 3);
    this.vel = vel;
    this.birth = new Float32Array(POOL);
    this.life = new Float32Array(POOL);
    this.alive = new Uint8Array(POOL);
    this.head = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aData", new THREE.BufferAttribute(attr, 4).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color().setRGB(0.55, 0.37, 0.235) }, // sunlit dust (linear)
      uSunFactor: { value: 1 },
      uFogColor: { value: new THREE.Color(0xd8a173) },
      uFogDensity: { value: 0.0003 },
      uPixelRatioH: { value: 800 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        attribute vec4 aData;
        uniform float uTime;
        uniform float uPixelRatioH;
        varying float vA;
        varying float vFogD;
        void main() {
          float age = uTime - aData.x;
          float lifeF = clamp(age / max(aData.y, 0.001), 0.0, 1.0);
          vA = (1.0 - lifeF) * smoothstep(0.0, 0.12, lifeF);
          float size = mix(aData.z, aData.w, lifeF);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uPixelRatioH / max(-mv.z, 0.5);
          vFogD = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uSunFactor;
        varying float vA;
        varying float vFogD;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float a = smoothstep(0.5, 0.08, d) * vA * 0.26;
          if (a < 0.004) discard;
          float fogF = 1.0 - exp(-pow(vFogD * uFogDensity, 2.0));
          vec3 col = mix(uColor * uSunFactor, uFogColor, fogF);
          gl_FragColor = vec4(col, a);
        }
      `,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);

    // ---- dust devils
    this.devils = [];
    for (let i = 0; i < 3; i++) this.devils.push(new DustDevil(scene, terrain, i));
  }

  spawn(x, y, z, vx, vy, vz, life, s0, s1) {
    const i = this.head;
    this.head = (this.head + 1) % POOL;
    const geo = this.points.geometry;
    geo.attributes.position.setXYZ(i, x, y, z);
    geo.attributes.aData.setXYZW(i, this.t, life, s0, s1);
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.birth[i] = this.t; this.life[i] = life; this.alive[i] = 1;
  }

  wheelBurst(e, windV) {
    // e: {x,y,z,s}
    const n = e.s > 1.2 ? 3 : e.s > 0.5 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      this.spawn(
        e.x + (Math.random() - 0.5) * 0.4, e.y + Math.random() * 0.12, e.z + (Math.random() - 0.5) * 0.4,
        (Math.random() - 0.5) * 0.7 + windV.x * 0.3,
        0.35 + Math.random() * 0.7 * e.s,
        (Math.random() - 0.5) * 0.7 + windV.z * 0.3,
        1.1 + Math.random() * 1.4,
        0.25 + Math.random() * 0.3,
        1.3 + Math.random() * 1.6 * e.s
      );
    }
  }

  drillBurst(p) {
    for (let k = 0; k < 26; k++) {
      const a = Math.random() * Math.PI * 2;
      this.spawn(
        p.x + Math.cos(a) * 0.1, p.y + 0.05, p.z + Math.sin(a) * 0.1,
        Math.cos(a) * (0.4 + Math.random() * 0.9), 0.7 + Math.random() * 1.4, Math.sin(a) * (0.4 + Math.random() * 0.9),
        1.4 + Math.random() * 1.6, 0.12, 0.9 + Math.random() * 0.8
      );
    }
  }

  update(dt, env, rover, camera) {
    this.t += dt;
    this.uniforms.uTime.value = this.t;
    this.uniforms.uFogColor.value.copy(this.scene.fog.color);
    this.uniforms.uFogDensity.value = this.scene.fog.density;
    this.uniforms.uPixelRatioH.value = window.innerHeight * 0.62;
    this.uniforms.uSunFactor.value = 0.12 + env.dayF * 0.88;

    const wind = env.windDir;
    // integrate alive particles
    const geo = this.points.geometry;
    const posA = geo.attributes.position;
    for (let i = 0; i < POOL; i++) {
      if (!this.alive[i]) continue;
      if (this.t - this.birth[i] > this.life[i]) { this.alive[i] = 0; continue; }
      const ix = i * 3;
      this.vel[ix] += wind.x * dt * 0.5;
      this.vel[ix + 1] -= dt * 0.55; // settle
      this.vel[ix + 2] += wind.z * dt * 0.5;
      posA.setXYZ(i,
        posA.getX(i) + this.vel[ix] * dt,
        Math.max(posA.getY(i) + this.vel[ix + 1] * dt, this.terrain.heightAt(posA.getX(i), posA.getZ(i)) + 0.04),
        posA.getZ(i) + this.vel[ix + 2] * dt
      );
    }
    posA.needsUpdate = true;
    geo.attributes.aData.needsUpdate = true;

    // wheel dust
    const list = rover.wheelEmitters(this._elist || (this._elist = []));
    for (const e of list) if (Math.random() < 0.75) this.wheelBurst(e, wind);

    // storm streaks around the camera
    const storm = env.storm.intensity;
    if (storm > 0.08) {
      const n = Math.floor(storm * 7);
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, rr = 6 + Math.random() * 34;
        const x = camera.position.x + Math.cos(a) * rr;
        const z = camera.position.z + Math.sin(a) * rr;
        const y = this.terrain.heightAt(x, z) + 0.3 + Math.random() * 5;
        this.spawn(x, y, z,
          wind.x * (3 + Math.random() * 5), 0.15, wind.z * (3 + Math.random() * 5),
          0.8 + Math.random() * 0.8, 0.6, 2.4 + Math.random() * 2.5);
      }
    }

    // devils
    const active = env.dayF > 0.55 && storm < 0.3;
    for (const d of this.devils) d.update(dt, active, env, this);
  }

  nearestDevil(p) {
    let best = null, bd = Infinity;
    for (const d of this.devils) {
      if (!d.active) continue;
      const dd = Math.hypot(d.pos.x - p.x, d.pos.z - p.z);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best ? { devil: best, dist: bd } : null;
  }
}

class DustDevil {
  constructor(scene, terrain, idx) {
    this.terrain = terrain;
    this.idx = idx;
    this.active = false;
    this.pos = new THREE.Vector3();
    this.height = 120;
    this.radius = 4.5;
    this.t = Math.random() * 100;
    this.respawnT = 20 + idx * 40;
    this.noise = new Simplex2(555 + idx);

    this.uniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color().setRGB(0.5, 0.345, 0.225) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying float vY;
        uniform float uTime;
        void main() {
          vUv = uv;
          vec3 p = position;
          float sway = sin(uTime * 0.8 + uv.y * 5.0) * uv.y * 3.5;
          p.x += sway;
          p.z += cos(uTime * 0.63 + uv.y * 4.0) * uv.y * 2.8;
          p.xz *= (0.55 + uv.y * 1.5); // widen with height
          vY = uv.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        varying float vY;
        uniform float uTime;
        uniform float uOpacity;
        uniform vec3 uColor;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          vec2 u = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
        }
        void main() {
          vec2 p = vec2(vUv.x * 3.0 + uTime * 0.55, vUv.y * 5.0 - uTime * 0.85);
          float n = vnoise(p) * 0.6 + vnoise(p * 2.7) * 0.4;
          float a = smoothstep(0.32, 0.72, n) * uOpacity;
          a *= smoothstep(0.0, 0.12, vY) * smoothstep(1.0, 0.55, vY);
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a * 0.38);
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24, 24, true), mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  spawnAt() {
    this.pos.set((Math.random() - 0.5) * 1500, 0, (Math.random() - 0.5) * 1500);
    this.height = 90 + Math.random() * 110;
    this.radius = 3 + Math.random() * 4.5;
    this.life = 90 + Math.random() * 160;
    this.age = 0;
    this.active = true;
    this.mesh.visible = true;
  }

  update(dt, allowed, env, dust) {
    this.t += dt;
    this.uniforms.uTime.value = this.t;
    if (!this.active) {
      this.respawnT -= dt;
      if (this.respawnT <= 0 && allowed) this.spawnAt();
      return;
    }
    this.age += dt;
    if (this.age > this.life || !allowed) {
      this.uniforms.uOpacity.value = Math.max(0, this.uniforms.uOpacity.value - dt * 0.3);
      if (this.uniforms.uOpacity.value <= 0.01) {
        this.active = false;
        this.mesh.visible = false;
        this.respawnT = 60 + Math.random() * 180;
      }
    } else {
      this.uniforms.uOpacity.value = Math.min(1, this.uniforms.uOpacity.value + dt * 0.25);
    }
    // wander
    const nx = this.noise.noise(this.t * 0.02, 0) * 2.4;
    const nz = this.noise.noise(0, this.t * 0.02) * 2.4;
    this.pos.x += (env.windDir.x * 2.8 + nx) * dt;
    this.pos.z += (env.windDir.z * 2.8 + nz) * dt;
    this.pos.y = this.terrain.heightAt(this.pos.x, this.pos.z);
    this.mesh.position.set(this.pos.x, this.pos.y + this.height / 2, this.pos.z);
    this.mesh.scale.set(this.radius, this.height, this.radius);
    // ground skirt particles
    if (Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2;
      dust.spawn(
        this.pos.x + Math.cos(a) * this.radius * 0.8, this.pos.y + 0.2, this.pos.z + Math.sin(a) * this.radius * 0.8,
        Math.cos(a + 1.7) * 3.2, 1.6 + Math.random() * 2, Math.sin(a + 1.7) * 3.2,
        1.2 + Math.random(), 0.4, 2.2
      );
    }
  }
}
