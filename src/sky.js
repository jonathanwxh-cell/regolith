// Sky + atmosphere: sol clock, sun arc, Mars sky dome (butterscotch day, blue
// sunset glow, stars + Phobos/Deimos), fog, environment lighting, weather
// (temperature / wind / pressure) and the regional dust-storm scheduler.
import * as THREE from "three";
import { Simplex2, clamp, lerp, smoothstep } from "./noise.js";

export const SOL_SECONDS = 88775; // one Mars sol
const TILT = 0.42;                // sun path tilt toward +z (south)
const _fogMix = new THREE.Color();

export class Sky {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.timeScale = 60;
    this.sol = 1;
    this.tSec = SOL_SECONDS * (9.5 / 24.66); // start ~09:30 LMST
    this.noise = new Simplex2(9091);
    this.storm = { phase: "idle", intensity: 0, t: 0, next: SOL_SECONDS * (0.9 + Math.random() * 0.9) };
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.dayF = 1; this.duskF = 0; this.nightF = 0;
    this._envKey = "";

    this.group = new THREE.Group();
    scene.add(this.group);

    // -- dome
    this.domeUniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uDayF: { value: 1 }, uDuskF: { value: 0 }, uNightF: { value: 0 }, uDustF: { value: 0 },
      uFogColor: { value: new THREE.Color(0xd8a173) },
    };
    const domeMat = new THREE.ShaderMaterial({
      uniforms: this.domeUniforms,
      side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uSunDir;
        uniform float uDayF, uDuskF, uNightF, uDustF;
        uniform vec3 uFogColor;
        varying vec3 vDir;
        void main() {
          vec3 v = normalize(vDir);
          float h = clamp(v.y, -0.08, 1.0);
          float sunDot = clamp(dot(v, uSunDir), -1.0, 1.0);
          // day: butterscotch, brighter at horizon
          vec3 dayZen = vec3(0.545, 0.353, 0.243);
          vec3 dayHor = vec3(0.831, 0.612, 0.435);
          vec3 day = mix(dayHor, dayZen, pow(clamp(h * 1.6, 0.0, 1.0), 0.62));
          // warm forward-scatter around the sun
          day += vec3(0.55, 0.38, 0.22) * pow(max(sunDot, 0.0), 14.0) * 0.55;
          day += vec3(0.9, 0.72, 0.5) * pow(max(sunDot, 0.0), 90.0) * 0.9;
          // dusk: dark tan sky, the famous cool blue glow near the sun
          vec3 duskBase = mix(vec3(0.30, 0.173, 0.11), vec3(0.104, 0.066, 0.05), pow(clamp(h * 2.0, 0.0, 1.0), 0.7));
          vec3 blueGlow = vec3(0.40, 0.57, 0.82) * pow(max(sunDot, 0.0), 19.0) * 1.6;
          vec3 duskWarm = vec3(0.72, 0.35, 0.14) * pow(max(sunDot, 0.0), 7.0) * 0.35;
          vec3 dusk = duskBase + blueGlow + duskWarm;
          // night
          vec3 night = mix(vec3(0.028, 0.02, 0.017), vec3(0.006, 0.005, 0.006), clamp(h * 2.5, 0.0, 1.0));
          vec3 col = day * uDayF + dusk * uDuskF + night * uNightF;
          // dust storm: hazy monochrome squash
          vec3 stormCol = vec3(0.42, 0.3, 0.21) * (0.35 + 0.65 * uDayF);
          col = mix(col, stormCol, uDustF * 0.85);
          // blend into the fog color at the horizon so terrain and sky meet seamlessly
          col = mix(uFogColor, col, smoothstep(-0.015, 0.06, v.y));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(6000, 48, 32), domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -100;
    this.group.add(this.dome);

    // -- sun disc + glow
    this.sunDisc = new THREE.Mesh(
      new THREE.CircleGeometry(36, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff3e0, fog: false, depthWrite: false })
    );
    this.sunDisc.renderOrder = -99;
    this.group.add(this.sunDisc);
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(), color: 0xffd9a8, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    this.sunGlow.scale.setScalar(900);
    this.sunGlow.renderOrder = -98;
    this.group.add(this.sunGlow);

    // -- stars
    this.stars = makeStars();
    this.stars.renderOrder = -97;
    this.group.add(this.stars);

    // -- moons
    this.phobos = makeMoon(0x9a938c, 26);
    this.deimos = makeMoon(0x8d8781, 12);
    this.group.add(this.phobos, this.deimos);

    // -- lights
    this.sun = new THREE.DirectionalLight(0xffe3c4, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -58; sc.right = 58; sc.top = 58; sc.bottom = -58;
    sc.near = 40; sc.far = 560;
    this.sun.shadow.bias = -0.00028;
    this.sun.shadow.normalBias = 0.9;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xcf9a6c, 0x5e3d28, 0.5);
    scene.add(this.hemi);
    this.amb = new THREE.AmbientLight(0x6a748c, 0.02); // starlight floor
    scene.add(this.amb);

    // -- fog
    this.fog = new THREE.FogExp2(0xd8a173, 0.00028);
    scene.fog = this.fog;

    // -- environment (PMREM of the dome)
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    const envDome = new THREE.Mesh(this.dome.geometry, domeMat);
    const envGround = new THREE.Mesh(
      new THREE.CircleGeometry(6000, 24),
      new THREE.MeshBasicMaterial({ color: 0x7a4e33 })
    );
    envGround.rotation.x = -Math.PI / 2;
    envGround.position.y = -4;
    this.envScene.add(envDome, envGround);
  }

  // sun direction for an arbitrary sol-second
  sunDirAt(tSec) {
    const dayFrac = tSec / SOL_SECONDS;
    const th = (dayFrac - 0.25) * Math.PI * 2; // 06:00 -> 0 (east), noon -> pi/2
    const E = new THREE.Vector3(1, 0, 0);
    const U = new THREE.Vector3(0, Math.cos(TILT), Math.sin(TILT));
    return E.multiplyScalar(Math.cos(th)).addScaledVector(U, Math.sin(th)).normalize();
  }

  lmst() {
    const f = this.tSec / SOL_SECONDS;
    const hh = Math.floor(f * 24), mm = Math.floor((f * 24 - hh) * 60);
    const ss = Math.floor((((f * 24 - hh) * 60) - mm) * 60);
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  temperatureC() {
    const f = this.tSec / SOL_SECONDS;
    return -46 + 38 * Math.cos((f - 0.604) * Math.PI * 2) + 1.5 * this.noise.noise(this.tSec * 0.0001, 3.7);
  }
  windMS() {
    const base = 3.2 + 3.4 * Math.abs(this.noise.noise(this.tSec * 0.00006, 9.1)) +
      2.2 * Math.abs(this.noise.noise(this.tSec * 0.0009, 2.2));
    return base + this.storm.intensity * 19;
  }
  pressurePa() {
    const f = this.tSec / SOL_SECONDS;
    let p = 716 + 9 * Math.sin(f * Math.PI * 4 + 0.8) + 1.2 * this.noise.noise(this.tSec * 0.0002, 5.5);
    if (this.storm.phase === "approach") p -= 42 * this.storm.t;      // foreshadowing drop
    if (this.storm.phase === "active") p -= 42;
    if (this.storm.phase === "decay") p -= 42 * (1 - this.storm.t);
    return p;
  }
  isDay() { return this.sunDir.y > 0.03; }

  // ---- storm scheduling: waits on sim time, but the event itself plays out
  // in REAL seconds (approach 45s -> active 3-6 min -> decay 75s)
  updateStorm(dtSim, dtReal) {
    const s = this.storm;
    switch (s.phase) {
      case "idle":
        s.next -= dtSim;
        if (s.next <= 0 && this.isDay()) { s.phase = "approach"; s.t = 0; }
        break;
      case "approach":
        s.t += dtReal / 45;
        if (s.t >= 1) { s.phase = "active"; s.t = 0; s.dur = 180 + Math.random() * 180; }
        s.intensity = 0.15 * s.t;
        break;
      case "active":
        s.t += dtReal;
        s.intensity = 0.15 + 0.85 * smoothstep(0, 40, s.t);
        if (s.t >= s.dur) { s.phase = "decay"; s.t = 0; }
        break;
      case "decay":
        s.t += dtReal / 75;
        s.intensity = Math.max(0, 1 - s.t);
        if (s.t >= 1) { s.phase = "idle"; s.intensity = 0; s.next = SOL_SECONDS * (0.7 + Math.random() * 1.4); }
        break;
    }
  }
  forceStormSoon() { if (this.storm.phase === "idle") this.storm.next = Math.min(this.storm.next, 60); }

  update(dtReal, warp, camera, roverPos) {
    const dtSim = dtReal * this.timeScale * warp;
    this.tSec += dtSim;
    while (this.tSec >= SOL_SECONDS) { this.tSec -= SOL_SECONDS; this.sol++; }
    this.updateStorm(dtSim, dtReal);

    const sd = this.sunDirAt(this.tSec);
    this.sunDir.copy(sd);
    const el = Math.asin(clamp(sd.y, -1, 1));
    const elDeg = el * 180 / Math.PI;

    // phase factors — Martian twilight glows up to ~2 h after sunset (high
    // dust scatters light onto the night side), so dusk decays slowly below
    // the horizon and full night comes late
    this.dayF = smoothstep(-1, 10, elDeg) * smoothstep(-8, 4, elDeg);
    const duskW = elDeg > 0.5 ? 5.5 : 14;
    this.duskF = Math.exp(-Math.pow((elDeg - 0.5) / duskW, 2)) * 0.95;
    this.nightF = smoothstep(0, -15, elDeg);
    const storm = this.storm.intensity;

    this.domeUniforms.uSunDir.value.copy(sd);
    this.domeUniforms.uDayF.value = this.dayF;
    this.domeUniforms.uDuskF.value = this.duskF;
    this.domeUniforms.uNightF.value = this.nightF;
    this.domeUniforms.uDustF.value = storm;

    // sky group rides the camera
    this.group.position.copy(camera.position);
    this.sunDisc.position.copy(sd).multiplyScalar(5500);
    this.sunDisc.lookAt(camera.position);
    this.sunDisc.material.color.setHex(elDeg < 8 ? 0xffd9b8 : 0xfff3e0);
    this.sunDisc.visible = elDeg > -1.5 && storm < 0.75;
    this.sunGlow.position.copy(sd).multiplyScalar(5300);
    this.sunGlow.material.opacity = (0.28 + 0.5 * this.dayF) * (1 - storm * 0.85) * (1 - this.duskF * 0.55) * smoothstep(-3, 3, elDeg);

    // stars + moons
    this.stars.material.opacity = this.nightF * (1 - storm);
    this.stars.visible = this.stars.material.opacity > 0.02;
    this.stars.rotation.y = this.tSec / SOL_SECONDS * Math.PI * 2; // sky rotates
    placeMoon(this.phobos, this.tSec, 7.66 * 3600, -1, 0.53);      // rises west
    placeMoon(this.deimos, this.tSec, 30.3 * 3600, 1, 0.31);
    const moonVis = clamp(this.nightF + this.duskF * 0.4, 0, 1) * (1 - storm);
    this.phobos.material.opacity = moonVis * 0.9;
    this.deimos.material.opacity = moonVis * 0.6;
    // scripted Phobos transit: a dark disc crossing the sun over ~40 s
    if (this.forceTransit) {
      this._transitT = (this._transitT || 0) + dtReal;
      const k = clamp(this._transitT / 40, 0, 1);
      const side = new THREE.Vector3().crossVectors(sd, new THREE.Vector3(0, 1, 0)).normalize();
      const p = sd.clone().addScaledVector(side, (k - 0.5) * 0.028).normalize();
      this.phobos.position.copy(p).multiplyScalar(5200);
      this.phobos.visible = true;
      this.phobos.material.opacity = 1;
      this.phobos.material.color.setHex(0x120c09);
      this.phobos.scale.setScalar(44);
    } else if (this._transitT) {
      this._transitT = 0;
      this.phobos.material.color.setHex(0x9a938c);
      this.phobos.scale.setScalar(26);
    }

    // sun light
    const sunI = (0.2 + 3.4 * Math.pow(Math.max(0, Math.sin(el)), 0.6)) * (el > 0 ? 1 : 0);
    this.sun.intensity = sunI * (1 - storm * 0.72);
    const warm = clamp(1 - elDeg / 28, 0, 1);
    this.sun.color.setRGB(1, lerp(0.89, 0.55, warm), lerp(0.77, 0.3, warm));
    this.sun.position.copy(roverPos).addScaledVector(sd, 300);
    this.sun.target.position.copy(roverPos);
    this.sun.visible = el > -0.02;

    this.hemi.intensity = 0.07 + 0.88 * this.dayF * (1 - storm * 0.4) + this.duskF * 0.12;
    this.amb.intensity = 0.02 + this.nightF * 0.022;

    // fog (linear-space components; the dome blends to this at the horizon)
    const wD = this.dayF, wK = this.duskF * 0.7, wN = this.nightF;
    const fnorm = Math.max(1e-4, wD + wK + wN);
    _fogMix.setRGB(
      (0.60 * wD + 0.145 * wK + 0.011 * wN) / fnorm,
      (0.415 * wD + 0.082 * wK + 0.007 * wN) / fnorm,
      (0.27 * wD + 0.055 * wK + 0.0055 * wN) / fnorm
    );
    this.fog.color.lerp(_fogMix, 0.06);
    this.domeUniforms.uFogColor.value.copy(this.fog.color);
    // clear-sol visibility on Mars is tens of km; the 7 km rim should read
    // as a faint silhouette, not vanish
    this.fog.density = 0.00019 + storm * 0.0046 + this.duskF * 0.00006;

    // environment relight on sun-bucket change
    const key = `${Math.round(elDeg / 3)}|${Math.round(storm * 6)}|${Math.round(this.nightF * 4)}`;
    if (key !== this._envKey) {
      this._envKey = key;
      const rt = this.pmrem.fromScene(this.envScene, 0.05);
      if (this._envRT) this._envRT.dispose();
      this._envRT = rt;
      this.scene.environment = rt.texture;
      this.scene.environmentIntensity = 0.75;
    }

    return { sunDir: sd, elDeg, dayF: this.dayF, storm: this.storm, wind: this.windMS() };
  }
}

function makeGlowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,240,220,1)");
  grad.addColorStop(0.25, "rgba(255,210,160,0.35)");
  grad.addColorStop(1, "rgba(255,190,130,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function makeStars() {
  const N = 3400;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const rnd = (() => { let s = 424243; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  // milky-way band plane
  const bandN = new THREE.Vector3(0.4, 0.65, 0.65).normalize();
  for (let i = 0; i < N; i++) {
    let v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (v.lengthSq() < 1e-4) v.set(0.1, 1, 0.2);
    v.normalize();
    const inBand = i > N * 0.62;
    if (inBand) {
      // squash toward the band plane
      const d = v.dot(bandN);
      v.addScaledVector(bandN, -d * (0.82 + rnd() * 0.12)).normalize();
    }
    pos[i * 3] = v.x * 5600; pos[i * 3 + 1] = v.y * 5600; pos[i * 3 + 2] = v.z * 5600;
    const mag = (inBand ? 0.25 + rnd() * 0.35 : 0.35 + Math.pow(rnd(), 3.2) * 0.65) * 1.3;
    const tint = rnd();
    col[i * 3] = mag * (0.85 + tint * 0.15);
    col[i * 3 + 1] = mag * (0.85 + Math.abs(tint - 0.5) * 0.2);
    col[i * 3 + 2] = mag * (1.0 - tint * 0.2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true,
    opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

function makeMoon(color, size) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(30, 28, 3, 32, 32, 26);
  grad.addColorStop(0, "#e8e2da");
  grad.addColorStop(0.75, "#9a938c");
  grad.addColorStop(1, "rgba(120,113,106,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(32, 32, 26, 21, 0.5, 0, Math.PI * 2);
  g.fill();
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), color, transparent: true, opacity: 0,
    depthWrite: false, fog: false,
  }));
  spr.scale.setScalar(size);
  return spr;
}

function placeMoon(spr, tSec, periodSec, dir, tilt) {
  const th = ((tSec / periodSec) * Math.PI * 2 * dir) % (Math.PI * 2);
  const E = new THREE.Vector3(1, 0, 0);
  const U = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt));
  const p = E.multiplyScalar(Math.cos(th)).addScaledVector(U, Math.sin(th)).normalize();
  spr.position.copy(p).multiplyScalar(5400);
  spr.visible = p.y > -0.05;
}
