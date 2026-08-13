// The rover: procedural Perseverance-class build (rocker-bogie, mast, arm,
// RTG, HGA), raycast suspension driving model, power/battery sim, track
// stamping and animation controllers for arm / mast / dish.
import * as THREE from "three";
import * as BGU from "three/addons/utils/BufferGeometryUtils.js";
import { clamp, lerp } from "./noise.js";

const WHEEL_R = 0.2625;
const TRACK_W = 1.02;            // half-track (x)
const WZ_F = 1.05, WZ_M = -0.1, WZ_R = -1.0;
const RIDE_H = 0.86;             // chassis origin above mean contact
const G_MARS = 3.71;

export const MATS = {
  mli: new THREE.MeshStandardMaterial({ color: 0xc79437, metalness: 0.85, roughness: 0.38 }),
  body: new THREE.MeshStandardMaterial({ color: 0xd9d5cc, metalness: 0.15, roughness: 0.6 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x35363a, metalness: 0.35, roughness: 0.62 }),
  wheel: new THREE.MeshStandardMaterial({ color: 0x8f8b83, metalness: 0.5, roughness: 0.62 }),
  wheelIn: new THREE.MeshStandardMaterial({ color: 0x4a463f, metalness: 0.3, roughness: 0.8 }),
  strut: new THREE.MeshStandardMaterial({ color: 0xcac6bd, metalness: 0.6, roughness: 0.5 }),
  lens: new THREE.MeshStandardMaterial({ color: 0x101418, metalness: 0.1, roughness: 0.22 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe8e6e0, metalness: 0.1, roughness: 0.5 }),
};

export class Rover {
  constructor(terrain, rocks) {
    this.terrain = terrain;
    this.rocks = rocks;
    this.group = new THREE.Group();
    this.pos = new THREE.Vector3(terrain.layout.lander.x + 6, 0, terrain.layout.lander.z + 4);
    this.heading = 0.4;
    this.v = 0;
    this.steerVis = 0;
    this.pitch = 0; this.roll = 0;
    this.odometer = 0;
    this.battery = 1080;         // Wh
    this.batteryCap = 1200;
    this.powerNet = 0;
    this.lampsOn = false;
    this.inSand = false;
    this.slipping = false;
    this.limp = false;
    this.blocked = false;
    this.tiltDeg = 0;
    this.wheelSpin = 0;
    this._stampAcc = [0, 0];
    this._smYaw = { f: 0, m: 0, r: 0, roll: 0 };
    this.turnInPlace = false;

    this.buildModel();
    this.armCtl = new ArmController(this.armJoints);
    this.mastCtl = new MastController(this.mastYaw, this.mastPitch);
    this.snapToGround();
  }

  // ------------------------------------------------------------------ model
  buildModel() {
    const g = this.group;
    const chassis = this.chassis = new THREE.Group();
    chassis.position.y = RIDE_H;
    g.add(chassis);

    const add = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      if (shadow) { m.castShadow = true; m.receiveShadow = true; }
      parent.add(m);
      return m;
    };

    // ---- body (WEB) with gold MLI flanks + white deck
    add(chassis, new THREE.BoxGeometry(1.3, 0.52, 1.62), MATS.body, 0, 0.28, 0);
    add(chassis, new THREE.BoxGeometry(1.34, 0.34, 1.5), MATS.mli, 0, 0.24, 0);
    add(chassis, new THREE.BoxGeometry(1.36, 0.05, 1.68), MATS.body, 0, 0.57, 0); // deck plate
    add(chassis, new THREE.BoxGeometry(1.02, 0.2, 0.4), MATS.dark, -0.1, 0.68, -0.2);
    add(chassis, new THREE.BoxGeometry(0.3, 0.14, 0.3), MATS.white, 0.34, 0.66, 0.28);
    add(chassis, new THREE.CylinderGeometry(0.05, 0.05, 0.28, 10), MATS.white, 0.52, 0.72, -0.62); // UHF helix
    add(chassis, new THREE.CylinderGeometry(0.09, 0.09, 0.05, 12), MATS.dark, 0.52, 0.6, -0.62);
    this.nameplate(chassis);

    // ---- RTG (rear, finned, slightly tilted)
    const rtg = new THREE.Group();
    rtg.position.set(0, 0.52, -1.02);
    rtg.rotation.x = -0.3; // canted up like the real MMRTG
    chassis.add(rtg);
    add(rtg, new THREE.CylinderGeometry(0.15, 0.15, 0.6, 14), MATS.white, 0, 0, -0.26, Math.PI / 2);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const fin = add(rtg, new THREE.BoxGeometry(0.012, 0.32, 0.5), MATS.white, Math.cos(a) * 0.185, Math.sin(a) * 0.185, -0.26);
      fin.rotation.z = a;
    }

    // ---- mast
    const mastRoot = new THREE.Group();
    mastRoot.position.set(-0.42, 0.6, 0.62);
    chassis.add(mastRoot);
    add(mastRoot, new THREE.BoxGeometry(0.22, 0.18, 0.22), MATS.body, 0, 0.02, 0);
    add(mastRoot, new THREE.CylinderGeometry(0.045, 0.055, 0.86, 10), MATS.strut, 0, 0.5, 0);
    this.mastYaw = new THREE.Group();
    this.mastYaw.position.set(0, 0.96, 0);
    mastRoot.add(this.mastYaw);
    this.mastPitch = new THREE.Group();
    this.mastYaw.add(this.mastPitch);
    const head = new THREE.Group();
    this.mastPitch.add(head);
    add(head, new THREE.BoxGeometry(0.34, 0.16, 0.18), MATS.body, 0, 0.05, 0);
    add(head, new THREE.CylinderGeometry(0.062, 0.062, 0.07, 14), MATS.dark, 0, 0.05, 0.1, Math.PI / 2); // SuperCam
    add(head, new THREE.CylinderGeometry(0.055, 0.055, 0.04, 14), MATS.lens, 0, 0.05, 0.125, Math.PI / 2);
    add(head, new THREE.CylinderGeometry(0.03, 0.03, 0.05, 10), MATS.lens, -0.11, 0.05, 0.095, Math.PI / 2); // Mastcam-Z L
    add(head, new THREE.CylinderGeometry(0.03, 0.03, 0.05, 10), MATS.lens, 0.11, 0.05, 0.095, Math.PI / 2);  // Mastcam-Z R
    this.mastHeadObj = head;

    // ---- robotic arm (5 DoF-ish)
    const J = this.armJoints = {};
    J.shoulderYaw = new THREE.Group();
    J.shoulderYaw.position.set(0.28, 0.3, 0.82);
    chassis.add(J.shoulderYaw);
    add(J.shoulderYaw, new THREE.CylinderGeometry(0.09, 0.09, 0.14, 12), MATS.dark, 0, 0, 0);
    J.shoulderPitch = new THREE.Group();
    J.shoulderYaw.add(J.shoulderPitch);
    const upper = add(J.shoulderPitch, new THREE.BoxGeometry(0.09, 0.09, 0.78), MATS.strut, 0, 0, 0.39);
    J.elbow = new THREE.Group();
    J.elbow.position.set(0, 0, 0.78);
    J.shoulderPitch.add(J.elbow);
    add(J.elbow, new THREE.CylinderGeometry(0.07, 0.07, 0.12, 10), MATS.dark, 0, 0, 0, 0, 0, Math.PI / 2);
    const fore = add(J.elbow, new THREE.BoxGeometry(0.075, 0.075, 0.62), MATS.strut, 0, 0, 0.31);
    J.wrist = new THREE.Group();
    J.wrist.position.set(0, 0, 0.62);
    J.elbow.add(J.wrist);
    J.turret = new THREE.Group();
    J.wrist.add(J.turret);
    add(J.turret, new THREE.CylinderGeometry(0.13, 0.13, 0.16, 14), MATS.dark, 0, 0, 0.06, Math.PI / 2);
    this.drillBit = add(J.turret, new THREE.CylinderGeometry(0.022, 0.016, 0.24, 8), MATS.strut, 0, -0.1, 0.16, Math.PI / 2);
    add(J.turret, new THREE.CylinderGeometry(0.045, 0.045, 0.05, 10), MATS.lens, 0.08, 0.06, 0.14, Math.PI / 2);

    // ---- HGA dish
    this.hgaAz = new THREE.Group();
    this.hgaAz.position.set(0.42, 0.62, -0.55);
    chassis.add(this.hgaAz);
    add(this.hgaAz, new THREE.CylinderGeometry(0.04, 0.05, 0.18, 10), MATS.strut, 0, 0.09, 0);
    this.hgaEl = new THREE.Group();
    this.hgaEl.position.y = 0.2;
    this.hgaAz.add(this.hgaEl);
    const dishMat = MATS.white.clone();
    dishMat.side = THREE.DoubleSide;
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 8, 0, Math.PI * 2, 0, 0.75), dishMat);
    dish.rotation.x = Math.PI / 2;
    dish.scale.y = 0.55;
    dish.castShadow = true;
    this.hgaEl.add(dish);
    add(this.hgaEl, new THREE.CylinderGeometry(0.012, 0.012, 0.16, 6), MATS.dark, 0, 0, 0.12, Math.PI / 2);

    // ---- hazcams
    add(chassis, new THREE.BoxGeometry(0.16, 0.06, 0.05), MATS.dark, 0.2, 0.12, 0.83);
    add(chassis, new THREE.BoxGeometry(0.16, 0.06, 0.05), MATS.dark, -0.2, 0.12, 0.83);
    add(chassis, new THREE.BoxGeometry(0.16, 0.06, 0.05), MATS.dark, 0, 0.16, -0.84);

    // ---- suspension + wheels (all offsets derived so wheels touch ground)
    const wheelGeo = makeWheelGeo();
    this.wheels = [];
    this.steerGroups = [];
    this.suspension = {};
    const WCY = WHEEL_R - RIDE_H;          // wheel-center y in chassis frame (-0.5975)
    const ROCKER_Y = 0.34, ROCKER_Z = 0.15;
    const BOGIE_RY = -0.08, BOGIE_RZ = -0.72; // bogie pivot in rocker frame
    for (const side of [-1, 1]) {
      const rocker = new THREE.Group();
      rocker.position.set(TRACK_W * side * 0.92, ROCKER_Y, ROCKER_Z);
      chassis.add(rocker);
      const xo = (TRACK_W - TRACK_W * 0.92) * side; // small outboard offset
      // front arm -> steer pivot above the front wheel
      const fY = WCY - ROCKER_Y, fZ = WZ_F - ROCKER_Z;
      const steerF = new THREE.Group();
      steerF.position.set(xo, fY + 0.24, fZ);
      rocker.add(steerF);
      addTube(rocker, MATS.strut, 0, 0, 0, xo, fY + 0.24, fZ, 0.04);
      addTube(steerF, MATS.strut, 0, 0, 0, 0, -0.24, 0.03, 0.03);
      const wF = new THREE.Mesh(wheelGeo, MATS.wheel);
      wF.position.set(0, -0.24, 0);
      wF.castShadow = true;
      steerF.add(wF);
      // bogie: holds mid + rear wheels
      const bogie = new THREE.Group();
      bogie.position.set(0, BOGIE_RY, BOGIE_RZ);
      rocker.add(bogie);
      const bWY = WCY - ROCKER_Y - BOGIE_RY;          // wheel-center y in bogie frame
      const mZ = WZ_M - ROCKER_Z - BOGIE_RZ, rZ = WZ_R - ROCKER_Z - BOGIE_RZ;
      addTube(bogie, MATS.strut, 0, 0, 0, xo, bWY + 0.1, mZ, 0.036);
      addTube(bogie, MATS.strut, 0, 0, 0, xo, bWY + 0.22, rZ, 0.036);
      const wM = new THREE.Mesh(wheelGeo, MATS.wheel);
      wM.position.set(xo, bWY, mZ);
      wM.castShadow = true;
      bogie.add(wM);
      const steerR = new THREE.Group();
      steerR.position.set(xo, bWY + 0.22, rZ);
      bogie.add(steerR);
      addTube(steerR, MATS.strut, 0, 0, 0, 0, -0.22, 0.02, 0.028);
      const wR = new THREE.Mesh(wheelGeo, MATS.wheel);
      wR.position.set(0, -0.22, 0);
      wR.castShadow = true;
      steerR.add(wR);
      this.wheels.push(wF, wM, wR);
      this.steerGroups.push({ f: steerF, r: steerR, side });
      this.suspension[side === -1 ? "L" : "R"] = { rocker, bogie };
    }

    // wheel positions in rover-local frame for terrain sampling
    this.wheelLocal = [
      new THREE.Vector3(-TRACK_W, 0, WZ_F), new THREE.Vector3(-TRACK_W, 0, WZ_M), new THREE.Vector3(-TRACK_W, 0, WZ_R),
      new THREE.Vector3(TRACK_W, 0, WZ_F), new THREE.Vector3(TRACK_W, 0, WZ_M), new THREE.Vector3(TRACK_W, 0, WZ_R),
    ];

    // ---- work lamps
    this.lamps = [];
    for (const side of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff4da, 0, 30, 0.72, 0.5, 1.1);
      spot.position.set(side * 0.3, 0.62, 0.7);
      spot.target.position.set(side * 0.8, -1.4, 6);
      chassis.add(spot); chassis.add(spot.target);
      this.lamps.push(spot);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.035, 10),
        new THREE.MeshBasicMaterial({ color: 0x332e22 }));
      lens.position.set(side * 0.3, 0.62, 0.755);
      chassis.add(lens);
      lens.userData.isLampLens = true;
      this[side === -1 ? "lampLensL" : "lampLensR"] = lens;
    }
  }

  nameplate(parent) {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 96;
    const g = c.getContext("2d");
    g.fillStyle = "#dedbd2"; g.fillRect(0, 0, 256, 96);
    g.fillStyle = "#8a2b1e";
    g.font = "700 34px system-ui, sans-serif";
    g.fillText("REGOLITH-1", 14, 44);
    g.fillStyle = "#333";
    g.font = "600 17px system-ui, sans-serif";
    g.fillText("MARS SURFACE SURVEYOR", 14, 74);
    for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? "#c9b038" : "#2a2a2a"; g.fillRect(200 + 0, 8 + i * 10, 44, 10); }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.19),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    plate.position.set(-0.676, 0.3, 0.2);
    plate.rotation.y = -Math.PI / 2;
    parent.add(plate);
  }

  // --------------------------------------------------------------- physics
  forward() { return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading)); }
  right() { return new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading)); }

  snapToGround() {
    this.pos.y = this.terrain.heightAt(this.pos.x, this.pos.z);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.heading;
  }

  wheelWorldXZ(i) {
    const l = this.wheelLocal[i];
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    return {
      x: this.pos.x + l.x * c + l.z * s,
      z: this.pos.z - l.x * s + l.z * c,
    };
  }

  step(dt, dtSim, input, env) {
    const T = this.terrain;
    const fwd = this.forward();

    // --- terrain feel
    const pF = this.wheelMid(WZ_F), pR = this.wheelMid(WZ_R);
    const hF = T.heightAt(pF.x, pF.z), hR = T.heightAt(pR.x, pR.z);
    const groundPitch = Math.atan2(hF - hR, WZ_F - WZ_R); // + = climbing
    this.inSand = T.inDuneBand(this.pos.x, this.pos.z);
    const sandFactor = this.inSand ? 0.55 : 1;

    // --- battery / limp
    this.limp = this.battery < 60;
    const maxV = (this.limp ? 0.9 : 3.6) * sandFactor;

    // --- longitudinal
    const th = this.blocked && input.throttle > 0 ? 0 : input.throttle;
    let target = th * (th > 0 ? maxV : 1.2);
    const slopeAcc = -G_MARS * Math.sin(groundPitch) * (this.v >= 0 ? 1 : -1) * 0.6;
    let acc = clamp((target - this.v) * 2.6, -2.6, 2.2) * sandFactor;
    if (input.brake) acc = clamp(-this.v * 6, -4, 4);
    this.v += (acc + (Math.abs(this.v) > 0.02 || Math.abs(th) > 0.05 ? slopeAcc : 0)) * dt;
    if (Math.abs(this.v) < 0.012 && Math.abs(th) < 0.04) this.v = 0;
    this.slipping = this.inSand && Math.abs(th) > 0.3;

    // --- steering / yaw
    this.turnInPlace = Math.abs(this.v) < 0.22 && Math.abs(input.steer) > 0.12 && !input.brake;
    let om = 0;
    if (this.turnInPlace) {
      om = -input.steer * 0.62;
      this.wheelSpin += 1.6 * Math.abs(input.steer) * dt / WHEEL_R * 0.4;
    } else {
      om = -input.steer * clamp(this.v / 4.2, -0.85, 0.85);
    }
    this.heading += om * dt;
    const steerTarget = this.turnInPlace ? Math.sign(input.steer) * 0.9 : input.steer * 0.5;
    this.steerVis = lerp(this.steerVis, steerTarget, 1 - Math.exp(-dt * 7));

    // --- integrate position
    const dist = this.v * dt;
    this.pos.addScaledVector(fwd, dist);
    this.odometer += Math.abs(dist);
    if (this.rocks) this.rocks.collide(this.pos, 1.45);
    const B = 1000;
    this.hitBoundary = false;
    if (Math.abs(this.pos.x) > B) { this.pos.x = clamp(this.pos.x, -B, B); this.hitBoundary = true; this.v *= 0.2; }
    if (Math.abs(this.pos.z) > B) { this.pos.z = clamp(this.pos.z, -B, B); this.hitBoundary = true; this.v *= 0.2; }

    // --- wheel contacts -> chassis pose
    const ys = [];
    for (let i = 0; i < 6; i++) {
      const w = this.wheelWorldXZ(i);
      ys.push(T.heightAt(w.x, w.z));
    }
    const meanY = (ys[0] + ys[1] + ys[2] + ys[3] + ys[4] + ys[5]) / 6;
    const pitchT = Math.atan2(((ys[0] + ys[3]) - (ys[2] + ys[5])) / 2, WZ_F - WZ_R);
    const rollT = Math.atan2(((ys[3] + ys[4] + ys[5]) - (ys[0] + ys[1] + ys[2])) / 3, TRACK_W * 2);
    // suspension activity metric for audio: how hard the chassis is being
    // worked right now (attitude error + vertical chase), smoothed
    const bumpInst = (Math.abs(pitchT - this.pitch) + Math.abs(rollT - this.roll)) * 2.4 +
      Math.abs(meanY - this.pos.y) * 1.6;
    this.bump = lerp(this.bump || 0, Math.min(bumpInst, 1.5), 1 - Math.exp(-dt * 6));
    this.pos.y = lerp(this.pos.y, meanY, 1 - Math.exp(-dt * 9));
    this.pitch = lerp(this.pitch, pitchT, 1 - Math.exp(-dt * 7));
    this.roll = lerp(this.roll, rollT, 1 - Math.exp(-dt * 7));
    this.tiltDeg = Math.max(Math.abs(this.pitch), Math.abs(this.roll)) * 180 / Math.PI;
    this.blocked = this.tiltDeg > 38;

    // --- pose the model
    this.group.position.copy(this.pos);
    this.group.rotation.set(0, this.heading, 0);
    this.chassis.rotation.set(-this.pitch, 0, -this.roll);
    this.chassis.position.y = RIDE_H;

    // rocker-bogie articulation (deviation of contacts from the chassis plane)
    for (const side of [-1, 1]) {
      const key = side === -1 ? "L" : "R";
      const o = side === -1 ? 0 : 3;
      const base = meanY;
      const df = ys[o] - base, dm = ys[o + 1] - base, dr = ys[o + 2] - base;
      const alpha = clamp(Math.atan2(df - (dm + dr) / 2, 1.9), -0.55, 0.55);
      const beta = clamp(Math.atan2(dm - dr, 0.95) - alpha, -0.62, 0.62);
      const S = this.suspension[key];
      S.rocker.rotation.x = lerp(S.rocker.rotation.x, -alpha, 1 - Math.exp(-dt * 11));
      S.bogie.rotation.x = lerp(S.bogie.rotation.x, -beta, 1 - Math.exp(-dt * 11));
    }

    // wheel spin + steer pose
    this.wheelSpin += (this.v / WHEEL_R) * (this.slipping ? 2.1 : 1) * dt;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    for (const sg of this.steerGroups) {
      const inPlace = this.turnInPlace;
      const fAng = inPlace ? -this.steerVis * 0.85 * sg.side * (sg.side > 0 ? 1 : 1) : this.steerVis;
      sg.f.rotation.y = inPlace ? -Math.sign(this.steerVis) * 0.78 * sg.side : this.steerVis;
      sg.r.rotation.y = inPlace ? Math.sign(this.steerVis) * 0.78 * sg.side : -this.steerVis * 0.7;
    }

    // --- track stamps
    if (Math.abs(dist) > 1e-4) {
      this._stampAcc[0] += Math.abs(dist);
      if (this._stampAcc[0] > 0.34) {
        this._stampAcc[0] = 0;
        for (const i of [0, 2, 3, 5]) { // front + rear rows read as two tracks
          const w = this.wheelWorldXZ(i);
          this.terrain.splatTrack(w.x, w.z, this.heading, 0.4, 0.7, this.inSand ? 0.7 : 0.45);
        }
      }
    } else if (this.turnInPlace) {
      this._stampAcc[1] += Math.abs(om) * dt;
      if (this._stampAcc[1] > 0.12) {
        this._stampAcc[1] = 0;
        for (let i = 0; i < 6; i++) {
          const w = this.wheelWorldXZ(i);
          this.terrain.splatTrack(w.x, w.z, this.heading + Math.PI / 2, 0.38, 0.5, 0.5);
        }
      }
    }

    // --- power model (sim-time)
    const driving = Math.abs(th) > 0.04;
    let draw = 42;                                        // avionics
    if (driving) draw += 70 + 210 * Math.abs(this.v) / 3.6 + Math.max(0, Math.sin(groundPitch)) * 240;
    if (this.slipping) draw += 60;
    if (this.lampsOn) draw += 28;
    if (env.tempC < -55) draw += 85; else if (env.tempC < -30) draw += 40;
    if (this.armCtl.busy) draw += 55;
    this.powerNet = 110 - draw;
    this.battery = clamp(this.battery + this.powerNet * (dtSim / 3600), 0, this.batteryCap);

    // --- controllers
    this.armCtl.update(dt);
    this.mastCtl.update(dt, this);
    this.updateLamps();
  }

  wheelMid(zOff) {
    const f = this.forward();
    return { x: this.pos.x + f.x * zOff, z: this.pos.z + f.z * zOff };
  }
  sidePoint(xOff) {
    const r = this.right();
    return { x: this.pos.x + r.x * xOff, z: this.pos.z + r.z * xOff };
  }

  updateLamps() {
    for (const l of this.lamps) l.intensity = this.lampsOn ? 36 : 0;
    const c = this.lampsOn ? 0xfff0c8 : 0x332e22;
    if (this.lampLensL) { this.lampLensL.material.color.setHex(c); }
  }

  // world position of the mast head (camera mount)
  mastWorld(out) {
    return this.mastHeadObj.getWorldPosition(out || new THREE.Vector3());
  }
  turretWorld(out) {
    return this.armJoints.turret.getWorldPosition(out || new THREE.Vector3());
  }

  // dust emitters for the particle system
  wheelEmitters(list) {
    list.length = 0;
    const speed = Math.abs(this.v);
    if (speed < 0.15 && !this.turnInPlace && !this.slipping) return list;
    const strength = clamp(speed / 3.6, 0.12, 1) * (this.slipping ? 2.4 : 1) * (this.inSand ? 1.6 : 1);
    for (let i = 0; i < 6; i++) {
      const w = this.wheelWorldXZ(i);
      list.push({ x: w.x, y: this.terrain.heightAt(w.x, w.z) + 0.1, z: w.z, s: strength });
    }
    return list;
  }
}

// ---------------------------------------------------------------- arm anim
const ARM_POSES = {
  stowed: { sy: 0, sp: -1.25, el: 2.5, wr: -1.25 },
  reach: { sy: 0, sp: 0.52, el: -0.62, wr: 0.42 },
  drill: { sy: 0, sp: 0.72, el: -0.78, wr: 0.62 },
};
class ArmController {
  constructor(joints) {
    this.j = joints;
    this.cur = { ...ARM_POSES.stowed };
    this.target = "stowed";
    this.busy = false;
    this.drillOsc = 0;
    this.onReach = null;
    this.apply();
  }
  setPose(name, cb) {
    this.target = name;
    this.onReach = cb || null;
  }
  update(dt) {
    const t = ARM_POSES[this.target];
    let done = true;
    for (const k of ["sy", "sp", "el", "wr"]) {
      this.cur[k] = lerp(this.cur[k], t[k], 1 - Math.exp(-dt * 1.8));
      if (Math.abs(this.cur[k] - t[k]) > 0.03) done = false;
    }
    this.busy = !done || this.target === "drill";
    if (this.target === "drill" && done) this.drillOsc += dt * 30;
    else this.drillOsc *= 0.9;
    this.apply();
    if (done && this.onReach) { const cb = this.onReach; this.onReach = null; cb(); }
  }
  apply() {
    this.j.shoulderYaw.rotation.y = this.cur.sy;
    this.j.shoulderPitch.rotation.x = this.cur.sp;
    this.j.elbow.rotation.x = this.cur.el;
    this.j.wrist.rotation.x = this.cur.wr + Math.sin(this.drillOsc) * 0.012;
    this.j.turret.rotation.z = this.drillOsc * 0.5;
  }
}

// --------------------------------------------------------------- mast anim
class MastController {
  constructor(yaw, pitch) {
    this.yaw = yaw; this.pitch = pitch;
    this.mode = "idle"; // idle | aim | drive
    this.aimYaw = 0; this.aimPitch = 0;
    this.idleT = 0;
  }
  aim(yaw, pitch) { this.mode = "aim"; this.aimYaw = yaw; this.aimPitch = pitch; }
  drive() { this.mode = "drive"; }
  idle() { this.mode = "idle"; }
  update(dt, rover) {
    this.idleT += dt;
    let ty = 0, tp = 0;
    if (this.mode === "aim") { ty = this.aimYaw; tp = this.aimPitch; }
    else if (this.mode === "idle" && Math.abs(rover.v) < 0.05) {
      ty = Math.sin(this.idleT * 0.16) * 0.9;
      tp = -0.12 + Math.sin(this.idleT * 0.09) * 0.1;
    }
    const py = this.yaw.rotation.y, pp = this.pitch.rotation.x;
    this.yaw.rotation.y = lerp(py, ty, 1 - Math.exp(-dt * 2.2));
    this.pitch.rotation.x = lerp(pp, tp, 1 - Math.exp(-dt * 2.2));
    // angular speed of the head, for the servo-whine SFX
    this.rate = (Math.abs(this.yaw.rotation.y - py) + Math.abs(this.pitch.rotation.x - pp)) / Math.max(dt, 1e-3);
  }
}

// -------------------------------------------------------------- wheel geo
function makeWheelGeo() {
  const parts = [];
  const rim = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.4, 22, 1, true);
  rim.rotateZ(Math.PI / 2);
  parts.push(rim);
  const inner = new THREE.CylinderGeometry(WHEEL_R * 0.94, WHEEL_R * 0.94, 0.38, 22);
  inner.rotateZ(Math.PI / 2);
  parts.push(inner);
  // grousers
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const g = new THREE.BoxGeometry(0.41, 0.016, 0.03);
    g.translate(0, WHEEL_R + 0.006, 0);
    // slight chevron: two halves angled
    const m = new THREE.Matrix4().makeRotationX(a);
    g.applyMatrix4(m);
    parts.push(g);
  }
  // spokes
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + (side > 0 ? 0.3 : 0);
      const s = new THREE.BoxGeometry(0.015, WHEEL_R * 1.55, 0.03);
      s.translate(side * 0.17, 0, 0);
      const m = new THREE.Matrix4().makeRotationX(a);
      s.applyMatrix4(m);
      parts.push(s);
    }
  }
  const geo = BGU.mergeGeometries(parts.map((p) => p.index ? p.toNonIndexed() : p), false);
  geo.computeVertexNormals();
  return geo;
}

function addTube(parent, mat, x1, y1, z1, x2, y2, z2, r) {
  const a = new THREE.Vector3(x1, y1, z1), b = new THREE.Vector3(x2, y2, z2);
  const len = a.distanceTo(b);
  const geo = new THREE.CylinderGeometry(r, r, len, 8);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  m.castShadow = true;
  parent.add(m);
  return m;
}
