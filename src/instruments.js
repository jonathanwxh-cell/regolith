// Instruments: the contextual action machine (spectrometer scan, core drill,
// relay deploy, uplink hold) + the photo system with mastcam framing checks.
import * as THREE from "three";
import { clamp } from "./noise.js";

export class Instruments {
  constructor(rover, missions, dust, audio) {
    this.rover = rover;
    this.missions = missions;
    this.dust = dust;
    this.audio = audio;
    this.action = null;      // {type, t, dur, label}
    this.lastScience = null; // for the scan panel
    this.gallery = [];       // {img, sol, lmst, cam}
    this._drillTick = 0;
  }

  // What can E do right now? -> {type, label} | null
  contextAction() {
    if (this.action) return null;
    const r = this.rover;
    if (Math.abs(r.v) > 0.25) return null;
    const pa = this.pois && this.pois.contextAction(r, this.story);
    // POI ops cost charge like any other arm op, so they honour limp mode too.
    if (pa && r.limp) return { type: "blocked", label: "BATTERY TOO LOW" };
    const m = this.missions.cur();
    // After the finale the campaign is over but the quad is still yours —
    // keep discoveries actionable in free roam.
    if (!m || this.missions.complete) return pa || null;
    const tasks = m.tasks;
    const stt = this.missions.curTasks();
    const near = m.site ? Math.hypot(m.site.x - r.pos.x, m.site.z - r.pos.z) < m.radius : false;
    for (let i = 0; i < tasks.length; i++) {
      if (stt[i]) continue;
      const t = tasks[i];
      if (t.id === "scan" && near) {
        if (r.limp) return { type: "blocked", label: "BATTERY TOO LOW TO SCAN" };
        return { type: "scan", label: "HOLD E — SPECTROMETER SCAN" };
      }
      if (t.id === "drill" && near) {
        if (r.limp) return { type: "blocked", label: "BATTERY TOO LOW TO DRILL" };
        return { type: "drill", label: "HOLD E — CORE DRILL (LONG OP)" };
      }
      if (t.id === "relay" && near) return { type: "relay", label: "HOLD E — DEPLOY RELAY" };
      if (t.id === "uplink" && near) return { type: "uplink", label: "HOLD E — BEGIN UPLINK" };
    }
    return pa || null;
  }

  start(type, poi) {
    const durs = { scan: 7, drill: 16, relay: 6, uplink: 20 };
    this.action = { type, t: 0, dur: poi ? poi.action.dur : (durs[type] || 6), poi };
    if (type === "scan") this.rover.armCtl.setPose("reach");
    if (type === "drill") this.rover.armCtl.setPose("drill");
    if (type === "poi") this.rover.armCtl.setPose(poi.action.pose || "reach");
    if (type === "uplink") this.aimHGA = true;
    this.audio.uiTick();
  }
  cancel() {
    if (!this.action) return;
    this.action = null;
    this.rover.armCtl.setPose("stowed");
    this.aimHGA = false;
    this.audio.uiBack();
  }

  update(dt, events) {
    const a = this.action;
    if (this.aimHGA || (a && a.type === "uplink")) {
      // aim the dish up-and-southeast ("Earth")
      const r = this.rover;
      r.hgaAz.rotation.y = lerpA(r.hgaAz.rotation.y, 2.2 - r.heading, dt * 1.6);
      r.hgaEl.rotation.x = lerpA(r.hgaEl.rotation.x, -0.9, dt * 1.6);
    }
    if (!a) return;
    if (Math.abs(this.rover.v) > 0.3) { this.cancel(); events.notify("OP ABORTED — VEHICLE MOVING", "warn"); return; }
    a.t += dt;
    const f = a.t / a.dur;
    if (a.type === "scan" && Math.random() < dt * 6) this.audio.scanTone(f);
    if (a.type === "drill") {
      this._drillTick += dt;
      if (this._drillTick > 0.9 && f > 0.25 && f < 0.92) {
        this._drillTick = 0;
        const p = this.rover.turretWorld();
        this.dust.drillBurst(p);
        events.shake(0.25);
      }
    }
    if (a.type === "uplink" && Math.random() < dt * 1.4) this.audio.blip(900 + Math.random() * 700, 0.04, 0.04);
    if (f >= 1) {
      this.finish(a.type, events);
      this.action = null;
    }
  }

  finish(type, events) {
    const m = this.missions.cur();
    this.rover.armCtl.setPose("stowed");
    if (type === "poi") {
      const poi = this.action.poi;
      this.audio.confirm();
      this.pois.complete(poi, this.story, {
        rover: this.rover, audio: this.audio,
        science: (sci) => { this.lastScience = sci; this.missions.samples++; events.science(sci); this.story.offerSample(sci.name, poi.id, { audio: this.audio }); },
      });
      return;
    }
    if (type === "scan" || type === "drill") {
      this.lastScience = m.science || null;
      this.missions.samples++;
      this.missions.taskDone(type);
      this.audio.confirm();
      if (this.lastScience) events.science(this.lastScience);
      events.task(`${type === "drill" ? "Core" : "Scan"} complete — ${m.science ? m.science.name : m.id}`);
      if (this.lastScience && this.story) this.story.offerSample(this.lastScience.name, m.id, { audio: this.audio });
    } else if (type === "relay") {
      this.missions.spawnRelay();
      this.missions.taskDone("relay");
      this.audio.confirm();
      events.task("UHF relay deployed");
    } else if (type === "uplink") {
      this.aimHGA = false;
      this.missions.taskDone("uplink");
      this.audio.uplinkSeq();
      events.task("Uplink transmitted");
    }
    events.checkAdvance();
  }

  get busy() { return !!this.action; }
  get drilling() { return this.action && this.action.type === "drill" && this.action.t / this.action.dur > 0.25; }

  // --------------------------------------------------------------- photos
  capturePhoto(renderer, camMode, meta, devilInfo) {
    const src = renderer.domElement;
    const w = 512, h = Math.round(512 * src.height / src.width);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.drawImage(src, 0, 0, w, h);
    // burn a NASA-style caption bar
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.fillRect(0, h - 22, w, 22);
    g.fillStyle = "#e8dcc8";
    g.font = "10px ui-monospace, monospace";
    g.fillText(`REGOLITH-1  ${camMode}  SOL ${meta.sol}  LMST ${meta.lmst}`, 8, h - 8);
    const img = c.toDataURL("image/jpeg", 0.78);
    const shot = { img, sol: meta.sol, lmst: meta.lmst, cam: camMode };
    this.gallery.push(shot);
    if (this.gallery.length > 24) this.gallery.shift();
    this.missions.photos++;
    this.audio.camShutter();

    // mission hooks
    const events = meta.events;
    const m = this.missions.cur();
    if (m && m.id === "M1" && this.missions.taskDone("photo")) {
      events.task("Surface photo returned");
      events.checkAdvance();
    }
    if (devilInfo && devilInfo.ok && this.story) this.story.setFlag("devil_photo");
    if (m && m.id === "M7" && devilInfo && devilInfo.ok && this.missions.taskDone("devil")) {
      events.task(`Dust devil imaged at ${Math.round(devilInfo.dist)} m`);
      events.checkAdvance();
    }
    return shot;
  }
}

function lerpA(a, b, t) { return a + (b - a) * Math.min(t, 1); }
