// Camera rig: CHASE (spring follow + mouse orbit offset), ORBIT (cinematic),
// MASTCAM (pointer-locked first person on the mast, zoomable — drives the
// physical mast), HAZCAM (fixed wide front). Terrain-aware (never clips in).
import * as THREE from "three";
import { clamp, lerp } from "./noise.js";

export const CAM_MODES = ["CHASE", "ORBIT", "MASTCAM", "HAZCAM"];

export class CameraRig {
  constructor(camera, rover, terrain, dom) {
    this.camera = camera;
    this.rover = rover;
    this.terrain = terrain;
    this.dom = dom;
    this.mode = "CHASE";
    this.chaseDist = 8.5;
    this.chaseYaw = 0;         // offset from rover heading
    this.chasePitch = 0.32;
    this.orbitT = 0;
    this.mastYaw = 0; this.mastPitch = 0;
    this.mastFov = 42;
    this.smPos = new THREE.Vector3();
    this.smLook = new THREE.Vector3();
    this.shake = 0;
    this._init = false;
    this._drag = null;

    dom.addEventListener("mousedown", (e) => {
      if (this.mode === "CHASE" || this.mode === "ORBIT") {
        this._drag = { x: e.clientX, y: e.clientY, yaw: this.chaseYaw, pitch: this.chasePitch };
      }
    });
    window.addEventListener("mousemove", (e) => {
      if (this._drag) {
        this.chaseYaw = this._drag.yaw - (e.clientX - this._drag.x) * 0.006;
        this.chasePitch = clamp(this._drag.pitch + (e.clientY - this._drag.y) * 0.004, 0.03, 1.2);
      } else if (this.mode === "MASTCAM" && document.pointerLockElement === this.dom) {
        this.mastYaw -= e.movementX * 0.0022 * (this.mastFov / 42);
        this.mastPitch = clamp(this.mastPitch - e.movementY * 0.0022 * (this.mastFov / 42), -0.9, 0.9);
      }
    });
    window.addEventListener("mouseup", () => { this._drag = null; });
    dom.addEventListener("wheel", (e) => {
      if (this.mode === "MASTCAM") {
        this.mastFov = clamp(this.mastFov * (e.deltaY > 0 ? 1.12 : 0.89), 7, 60);
      } else {
        this.chaseDist = clamp(this.chaseDist * (e.deltaY > 0 ? 1.1 : 0.91), 3.4, 26);
      }
    }, { passive: true });
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === "MASTCAM") {
      this.dom.requestPointerLock?.();
      this.mastYaw = 0; this.mastPitch = 0;
      this.rover.mastCtl.aim(0, 0);
    } else {
      if (document.pointerLockElement === this.dom) document.exitPointerLock?.();
      this.camera.fov = 55;
      this.camera.updateProjectionMatrix();
      this.rover.mastCtl.idle();
    }
  }
  cycle() {
    const i = CAM_MODES.indexOf(this.mode);
    this.setMode(CAM_MODES[(i + 1) % CAM_MODES.length]);
    return this.mode;
  }

  addShake(a) { this.shake = Math.min(this.shake + a, 1); }

  update(dt) {
    const r = this.rover;
    const cam = this.camera;
    this.shake = Math.max(0, this.shake - dt * 1.8);
    const shakeV = new THREE.Vector3(
      (Math.random() - 0.5) * this.shake * 0.14,
      (Math.random() - 0.5) * this.shake * 0.1,
      (Math.random() - 0.5) * this.shake * 0.14
    );

    if (this.mode === "CHASE" || this.mode === "ORBIT") {
      let yaw, dist, pitch;
      if (this.mode === "ORBIT") {
        this.orbitT += dt * 0.07;
        yaw = this.orbitT;
        dist = this.chaseDist * 1.25;
        pitch = 0.22 + 0.1 * Math.sin(this.orbitT * 0.4);
      } else {
        yaw = r.heading + Math.PI + this.chaseYaw;
        dist = this.chaseDist;
        pitch = this.chasePitch;
      }
      const target = new THREE.Vector3(r.pos.x, r.pos.y + 1.15, r.pos.z);
      const off = new THREE.Vector3(
        Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)
      ).multiplyScalar(dist);
      const desired = target.clone().add(off);
      // keep above terrain
      const minY = this.terrain.heightAt(desired.x, desired.z) + 0.55;
      if (desired.y < minY) desired.y = minY;
      if (!this._init) { this.smPos.copy(desired); this.smLook.copy(target); this._init = true; }
      this.smPos.lerp(desired, 1 - Math.exp(-dt * (this.mode === "ORBIT" ? 1.6 : 5.5)));
      this.smLook.lerp(target, 1 - Math.exp(-dt * 9));
      cam.position.copy(this.smPos).add(shakeV);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.smLook);
      if (Math.abs(cam.fov - 55) > 0.1) { cam.fov = lerp(cam.fov, 55, 0.2); cam.updateProjectionMatrix(); }
    } else if (this.mode === "MASTCAM") {
      const p = r.mastWorld();
      cam.position.copy(p).add(shakeV);
      const yaw = r.heading + this.mastYaw;
      const cp = Math.cos(this.mastPitch);
      const dir = new THREE.Vector3(Math.sin(yaw) * cp, Math.sin(this.mastPitch), Math.cos(yaw) * cp);
      cam.up.set(0, 1, 0);
      cam.lookAt(p.clone().add(dir));
      // subtle rover sway
      cam.rotation.z += r.roll * 0.35;
      if (Math.abs(cam.fov - this.mastFov) > 0.05) {
        cam.fov = lerp(cam.fov, this.mastFov, 0.25);
        cam.updateProjectionMatrix();
      }
      r.mastCtl.aim(this.mastYaw, -this.mastPitch);
    } else { // HAZCAM
      const f = r.forward();
      const p = new THREE.Vector3(r.pos.x, r.pos.y + 0.9, r.pos.z).addScaledVector(f, 1.05);
      cam.position.copy(p).add(shakeV);
      cam.up.set(0, 1, 0);
      cam.lookAt(p.clone().add(f).add(new THREE.Vector3(0, -0.32, 0)));
      if (Math.abs(cam.fov - 92) > 0.1) { cam.fov = lerp(cam.fov, 92, 0.3); cam.updateProjectionMatrix(); }
    }
  }
}
