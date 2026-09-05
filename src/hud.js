// HUD: JPL-ops style interface. Injects all DOM, owns the minimap/topo map
// bakes, compass tape, tilt ball, power/env telemetry, mission card, scan
// spectrum panel, photo UI + gallery, pause/settings, title and end screens.
import { clamp, lerp } from "./noise.js";
import { WORLD } from "./terrain.js";

export class HUD {
  constructor(root) {
    this.root = root;
    root.insertAdjacentHTML("beforeend", TEMPLATE);
    const $ = (s) => root.querySelector(s);
    this.el = {
      hud: $("#hud"), compass: $("#compass"), missionTitle: $("#missionTitle"),
      missionTasks: $("#missionTasks"), missionDist: $("#missionDist"),
      clock: $("#clockVal"), warpChip: $("#warpChip"), temp: $("#tempVal"),
      wind: $("#windVal"), press: $("#pressVal"), speed: $("#speedVal"),
      odo: $("#odoVal"), tilt: $("#tiltCanvas"), battBar: $("#battBar"),
      battPct: $("#battPct"), netW: $("#netW"), modeChips: $("#modeChips"),
      minimap: $("#minimap"), notif: $("#notif"), prompt: $("#prompt"),
      ring: $("#actionRing"), ringFill: $("#ringFill"), ringLabel: $("#ringLabel"),
      scanPanel: $("#scanPanel"), scanCanvas: $("#scanCanvas"), scanName: $("#scanName"),
      scanFlavor: $("#scanFlavor"), scanClose: $("#scanClose"),
      photoUI: $("#photoUI"), focal: $("#focalVal"), gallery: $("#galleryStrip"),
      map: $("#mapOverlay"), mapCanvas: $("#mapCanvas"),
      pause: $("#pauseOverlay"), title: $("#titleOverlay"), bootBar: $("#bootBar"),
      bootMsg: $("#bootMsg"), titleButtons: $("#titleButtons"), btnNew: $("#btnNew"),
      btnContinue: $("#btnContinue"), end: $("#endOverlay"), endStats: $("#endStats"),
      alert: $("#alertBanner"), fps: $("#fpsChip"), camChip: $("#camChip"),
      logList: $("#logList"), photoView: $("#photoView"), photoViewImg: $("#photoViewImg"),
      qualitySel: $("#qualitySel"), volSlider: $("#volSlider"), musicSlider: $("#musicSlider"), beamChk: $("#beamChk"),
      btnResume: $("#btnResume"), btnReset: $("#btnReset"), touch: $("#touchControls"),
      vignetteHint: $("#hintBar"),
    };
    this.notifTimers = [];
    this._lastText = 0;
    this.mapClickCb = null;
    this.el.scanClose.addEventListener("click", () => this.hideScan());
    this.el.photoView.addEventListener("click", () => this.el.photoView.classList.add("hidden"));
    this.el.mapCanvas.addEventListener("click", (e) => {
      if (!this.mapClickCb) return;
      const r = this.el.mapCanvas.getBoundingClientRect();
      const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
      this.mapClickCb((u - 0.5) * WORLD, (0.5 - v) * WORLD); // north-up

    });
    if (("ontouchstart" in window) && matchMedia("(pointer: coarse)").matches) {
      this.el.touch.classList.remove("hidden");
    }
  }

  // ---------------------------------------------------------------- bakes
  bakeMap(terrain) {
    const N = 1024;
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d");
    const img = g.createImageData(N, N);
    const data = img.data;
    const { minH, maxH } = terrain;
    const lx = -0.62, lz = -0.62, ly = 0.5; // NW light
    // north-up: canvas row 0 is +z (north)
    for (let j = 0; j < N; j++) {
      const wz = (0.5 - j / N) * WORLD;
      for (let i = 0; i < N; i++) {
        const wx = (i / N - 0.5) * WORLD;
        const e = 4;
        const hx0 = terrain.sampleMain(wx - e, wz), hx1 = terrain.sampleMain(wx + e, wz);
        const hz0 = terrain.sampleMain(wx, wz - e), hz1 = terrain.sampleMain(wx, wz + e);
        let nx = hx0 - hx1, ny = 2 * e, nz = hz0 - hz1;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl; ny /= nl; nz /= nl;
        const shade = clamp(0.42 + 1.0 * (nx * lx + ny * ly + nz * lz), 0.1, 1.5);
        const h = terrain.sampleMain(wx, wz);
        // hypsometric tint stretched over the FLOOR, not the 400 m rim wall —
        // normalizing by maxH would flatten the whole floor to one dark tone
        const t = Math.pow(clamp((h - minH) / 150, 0, 1), 1.05);
        let r = lerp(64, 205, t) * shade;
        let gg = lerp(34, 128, t) * shade;
        let b = lerp(22, 88, t) * shade;
        const k = (j * N + i) * 4;
        data[k] = r; data[k + 1] = gg; data[k + 2] = b; data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.mapBake = c;
  }

  // --------------------------------------------------------------- update
  update(dt, ctx) {
    const { rover, sky, missions, camMode, warp, fps, instruments } = ctx;
    const now = performance.now();
    const slowTick = now - this._lastText > 100;
    if (slowTick) this._lastText = now;

    if (slowTick) {
      this.el.clock.textContent = `SOL ${sky.sol}  ${sky.lmst()}`;
      this.el.warpChip.classList.toggle("hidden", warp <= 1);
      this.el.temp.textContent = `${sky.temperatureC().toFixed(1)} °C`;
      this.el.wind.textContent = `${sky.windMS().toFixed(1)} m/s`;
      this.el.press.textContent = `${sky.pressurePa().toFixed(0)} Pa`;
      this.el.speed.textContent = Math.abs(rover.v).toFixed(2);
      this.el.odo.textContent = rover.odometer > 999 ? `${(rover.odometer / 1000).toFixed(2)} km` : `${rover.odometer.toFixed(0)} m`;
      const pct = rover.battery / rover.batteryCap;
      this.el.battBar.style.transform = `scaleX(${pct.toFixed(3)})`;
      this.el.battBar.style.background = pct < 0.12 ? "#ff5f45" : pct < 0.3 ? "#ffb86b" : "#86d67c";
      this.el.battPct.textContent = `${(pct * 100).toFixed(0)}%`;
      this.el.netW.textContent = `${rover.powerNet >= 0 ? "+" : ""}${rover.powerNet.toFixed(0)} W`;
      this.el.netW.style.color = rover.powerNet >= 0 ? "#86d67c" : "#ffb86b";
      this.el.camChip.textContent = camMode;
      this.el.fps.textContent = `${fps.toFixed(0)} FPS`;
      // mode chips
      const chips = [];
      if (rover.inSand) chips.push(["SAND", "#ffb86b"]);
      if (rover.slipping) chips.push(["SLIP", "#ff8a5f"]);
      if (rover.limp) chips.push(["LOW PWR", "#ff5f45"]);
      if (rover.blocked) chips.push(["TILT LIMIT", "#ff5f45"]);
      if (sky.storm.intensity > 0.1) chips.push(["DUST EVENT", "#ff8a5f"]);
      if (warp > 1) chips.push(["WAIT ×300", "#7dd3fc"]);
      this.el.modeChips.innerHTML = chips.map(([t, c]) => `<span style="color:${c};border-color:${c}44">${t}</span>`).join("");
      // mission card
      const m = missions.cur();
      if (m && !missions.complete) {
        this.el.missionTitle.textContent = `${m.id} · ${m.title}`;
        const stt = missions.curTasks();
        this.el.missionTasks.innerHTML = m.tasks.map((t, i) =>
          `<li class="${stt[i] ? "done" : ""}">${stt[i] ? "◆" : "◇"} ${t.label}</li>`).join("");
        const d = missions.distTo(rover.pos);
        this.el.missionDist.textContent = d != null ? `${d < 999 ? d.toFixed(0) + " m" : (d / 1000).toFixed(2) + " km"} to waypoint` : "—";
      } else {
        this.el.missionTitle.textContent = "SURVEY COMPLETE";
        this.el.missionTasks.innerHTML = "<li class='done'>◆ Free roam — the quad is yours</li>";
        this.el.missionDist.textContent = "—";
      }
      // storm banner
      const st = sky.storm;
      if (st.phase === "approach") this.showAlert("⚠ PRESSURE DROP — REGIONAL DUST EVENT INBOUND");
      else if (st.phase === "active") this.showAlert("REGIONAL DUST EVENT IN PROGRESS — VISIBILITY REDUCED");
      else this.hideAlert();
    }

    this.drawCompass(rover, missions);
    this.drawTilt(rover);
    this.drawMinimap(rover, missions, sky);

    // context prompt + action ring
    const act = instruments.action;
    if (act) {
      this.el.prompt.classList.add("hidden");
      this.el.ring.classList.remove("hidden");
      const f = clamp(act.t / act.dur, 0, 1);
      this.el.ringFill.style.strokeDashoffset = `${(1 - f) * 226}`;
      this.el.ringLabel.textContent = `${act.type.toUpperCase()} ${(f * 100).toFixed(0)}%`;
    } else {
      this.el.ring.classList.add("hidden");
      const ca = instruments.contextAction();
      if (ca) {
        this.el.prompt.textContent = ca.label;
        this.el.prompt.classList.toggle("blocked", ca.type === "blocked");
        this.el.prompt.classList.remove("hidden");
      } else {
        this.el.prompt.classList.add("hidden");
      }
    }
    this.el.photoUI.classList.toggle("hidden", camMode !== "MASTCAM");
    if (camMode === "MASTCAM") this.el.focal.textContent = `${(2000 / ctx.mastFov).toFixed(0)} mm`;
  }

  // ------------------------------------------------------------- canvases
  drawCompass(rover, missions) {
    const cv = this.el.compass;
    const g = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const headingDeg = ((rover.heading * 180 / Math.PI) % 360 + 360) % 360;
    // heading 0 = +z north; screen-x maps degrees
    const pxPerDeg = 3.4;
    g.font = "10px ui-monospace, monospace";
    g.textAlign = "center";
    for (let d = -80; d <= 80; d += 5) {
      let deg = Math.round((headingDeg + d) / 5) * 5;
      const off = (deg - headingDeg + 540) % 360 - 180;
      if (Math.abs(off) > 80) continue;
      const x = W / 2 + off * pxPerDeg;
      const norm = ((deg % 360) + 360) % 360;
      const major = norm % 45 === 0;
      g.strokeStyle = major ? "#e8dcc8cc" : "#e8dcc855";
      g.beginPath();
      g.moveTo(x, H - 8);
      g.lineTo(x, H - (major ? 20 : 14));
      g.stroke();
      if (major) {
        const names = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
        g.fillStyle = "#e8dcc8";
        g.fillText(names[norm] ?? String(norm), x, H - 24);
      }
    }
    // waypoint caret
    const t = missions.navTarget();
    if (t) {
      const b = Math.atan2(t.x - rover.pos.x, t.z - rover.pos.z) * 180 / Math.PI;
      const off = (b - headingDeg + 540) % 360 - 180;
      const x = clamp(W / 2 + off * pxPerDeg, 12, W - 12);
      g.fillStyle = "#ffb86b";
      g.beginPath();
      g.moveTo(x, H - 4); g.lineTo(x - 5, H + 2 - 4); g.lineTo(x + 5, H + 2 - 4);
      g.closePath(); g.fill();
    }
    if (missions.customWaypoint) {
      const w = missions.customWaypoint;
      const b = Math.atan2(w.x - rover.pos.x, w.z - rover.pos.z) * 180 / Math.PI;
      const off = (b - headingDeg + 540) % 360 - 180;
      const x = clamp(W / 2 + off * pxPerDeg, 12, W - 12);
      g.fillStyle = "#7dd3fc";
      g.fillRect(x - 3, H - 6, 6, 4);
    }
    // center marker + readout
    g.strokeStyle = "#ffb86b";
    g.beginPath(); g.moveTo(W / 2, 2); g.lineTo(W / 2, 10); g.stroke();
    g.fillStyle = "#ffb86b";
    g.font = "11px ui-monospace, monospace";
    g.fillText(`${headingDeg.toFixed(0).padStart(3, "0")}°`, W / 2, 12 + 9);
  }

  drawTilt(rover) {
    const cv = this.el.tilt;
    const g = cv.getContext("2d");
    const S = cv.width, C = S / 2, R = S / 2 - 5;
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.clip();
    const pitchPx = clamp(rover.pitch, -0.8, 0.8) * R * 1.6;
    g.translate(C, C);
    g.rotate(-rover.roll);
    // sky/ground halves
    g.fillStyle = "#2a1c14";
    g.fillRect(-S, -S + pitchPx, S * 2, S);
    g.fillStyle = "#14100c";
    g.fillRect(-S, pitchPx, S * 2, S);
    g.strokeStyle = "#e8dcc8aa";
    g.beginPath(); g.moveTo(-R, pitchPx); g.lineTo(R, pitchPx); g.stroke();
    g.restore();
    // fixed reticle
    g.strokeStyle = rover.tiltDeg > 30 ? "#ff5f45" : rover.tiltDeg > 22 ? "#ffb86b" : "#7dd3fc";
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(C - 16, C); g.lineTo(C - 5, C);
    g.moveTo(C + 5, C); g.lineTo(C + 16, C);
    g.moveTo(C, C - 3); g.lineTo(C, C + 3);
    g.stroke();
    g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 1;
    g.fillStyle = "#e8dcc8";
    g.font = "9px ui-monospace, monospace";
    g.textAlign = "center";
    g.fillText(`${rover.tiltDeg.toFixed(0)}°`, C, S - 2);
  }

  drawMinimap(rover, missions, sky) {
    const cv = this.el.minimap;
    const g = cv.getContext("2d");
    const S = cv.width;
    g.clearRect(0, 0, S, S);
    if (!this.mapBake) return;
    const span = 470; // meters shown
    const bakePx = this.mapBake.width / WORLD;
    const cx = (rover.pos.x / WORLD + 0.5) * this.mapBake.width;
    const cz = (0.5 - rover.pos.z / WORLD) * this.mapBake.height;
    const half = span * bakePx / 2;
    g.save();
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); g.clip();
    g.drawImage(this.mapBake, cx - half, cz - half, half * 2, half * 2, 0, 0, S, S);
    // night dim
    g.fillStyle = `rgba(6,4,3,${(1 - sky.dayF) * 0.5})`;
    g.fillRect(0, 0, S, S);
    const toMap = (wx, wz) => [
      S / 2 + (wx - rover.pos.x) / span * S,
      S / 2 - (wz - rover.pos.z) / span * S,
    ];
    // sites
    const m = missions.cur();
    if (m && m.site) {
      const [x, y] = toMap(m.site.x, m.site.z);
      g.strokeStyle = "#ffb86b";
      g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.stroke();
      g.fillStyle = "#ffb86b";
      g.beginPath(); g.arc(x, y, 1.6, 0, Math.PI * 2); g.fill();
    }
    if (missions.customWaypoint) {
      const [x, y] = toMap(missions.customWaypoint.x, missions.customWaypoint.z);
      g.strokeStyle = "#7dd3fc";
      g.strokeRect(x - 3, y - 3, 6, 6);
    }
    // rover arrow (north-up: heading 0 points up-screen)
    g.save();
    g.translate(S / 2, S / 2);
    g.rotate(Math.PI - rover.heading);
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.moveTo(0, 6); g.lineTo(-4, -4); g.lineTo(0, -1.6); g.lineTo(4, -4);
    g.closePath(); g.fill();
    g.restore();
    g.restore();
    // bezel
    g.strokeStyle = "#ffffff22";
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 1.5, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#e8dcc877";
    g.font = "8px ui-monospace, monospace";
    g.textAlign = "center";
    g.fillText("N", S / 2, 9);
  }

  drawFullMap(rover, missions, trail) {
    const cv = this.el.mapCanvas;
    const size = Math.min(innerWidth, innerHeight) - 110;
    cv.width = cv.height = size;
    const g = cv.getContext("2d");
    g.drawImage(this.mapBake, 0, 0, size, size);
    const toMap = (wx, wz) => [(wx / WORLD + 0.5) * size, (0.5 - wz / WORLD) * size];
    // grid every 500m
    g.strokeStyle = "#ffffff18";
    g.fillStyle = "#e8dcc866";
    g.font = "10px ui-monospace, monospace";
    for (let m = -1500; m <= 1500; m += 500) {
      const [x] = toMap(m, 0), [, y] = toMap(0, m);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, size); g.stroke();
      g.beginPath(); g.moveTo(0, y); g.lineTo(size, y); g.stroke();
      g.fillText(`${m}`, x + 3, 12);
      g.fillText(`${m}`, 4, y - 3);
    }
    // trail
    if (trail.length > 1) {
      g.strokeStyle = "#ffffff88";
      g.setLineDash([3, 3]);
      g.beginPath();
      trail.forEach((p, i) => {
        const [x, y] = toMap(p[0], p[1]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.stroke();
      g.setLineDash([]);
    }
    // all sites with state
    missions.defs.forEach((m, i) => {
      if (!m.site) return;
      const [x, y] = toMap(m.site.x, m.site.z);
      const state = i < missions.idx ? "done" : i === missions.idx ? "active" : "future";
      g.strokeStyle = state === "done" ? "#86d67c" : state === "active" ? "#ffb86b" : "#e8dcc855";
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke();
      if (state === "done") {
        g.fillStyle = "#86d67c";
        g.beginPath(); g.arc(x, y, 2.4, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = state === "active" ? "#ffb86b" : "#e8dcc8aa";
      g.font = "11px ui-monospace, monospace";
      g.fillText(`${m.id} ${m.title}`, x + 11, y + 4 + (m.id === "M7" ? 13 : 0)); // M7 shares the lander site with M1
    });
    if (missions.customWaypoint) {
      const [x, y] = toMap(missions.customWaypoint.x, missions.customWaypoint.z);
      g.strokeStyle = "#7dd3fc";
      g.strokeRect(x - 5, y - 5, 10, 10);
      g.fillStyle = "#7dd3fc";
      g.font = "10px ui-monospace, monospace";
      g.fillText("WPT", x + 9, y + 4);
    }
    // rover (north-up)
    const [rx, ry] = toMap(rover.pos.x, rover.pos.z);
    g.save();
    g.translate(rx, ry);
    g.rotate(Math.PI - rover.heading);
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.moveTo(0, 8); g.lineTo(-5, -5); g.lineTo(0, -2); g.lineTo(5, -5);
    g.closePath(); g.fill();
    g.restore();
  }

  // --------------------------------------------------------------- panels
  notify(text, kind = "info") {
    const d = document.createElement("div");
    d.className = `notifItem ${kind}`;
    d.textContent = text;
    this.el.notif.appendChild(d);
    requestAnimationFrame(() => d.classList.add("show"));
    setTimeout(() => {
      d.classList.remove("show");
      setTimeout(() => d.remove(), 400);
    }, 6200);
    while (this.el.notif.children.length > 4) this.el.notif.firstChild.remove();
  }

  pushLog(missions, text) {
    missions.log.push(text);
    if (this.el.logList) {
      const li = document.createElement("li");
      li.textContent = text;
      this.el.logList.appendChild(li);
      this.el.logList.scrollTop = this.el.logList.scrollHeight;
    }
  }
  restoreLog(missions) {
    this.el.logList.innerHTML = "";
    for (const t of missions.log) {
      const li = document.createElement("li");
      li.textContent = t;
      this.el.logList.appendChild(li);
    }
  }

  showScience(sci) {
    this.el.scanPanel.classList.remove("hidden");
    this.el.scanName.textContent = sci.name;
    this.el.scanFlavor.textContent = sci.flavor;
    const cv = this.el.scanCanvas;
    const g = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    const start = performance.now();
    const draw = () => {
      const t = clamp((performance.now() - start) / 900, 0, 1);
      g.clearRect(0, 0, W, H);
      g.strokeStyle = "#ffffff22";
      g.beginPath(); g.moveTo(28, 6); g.lineTo(28, H - 30); g.lineTo(W - 6, H - 30); g.stroke();
      const n = sci.comp.length;
      const bw = (W - 40) / n;
      sci.comp.forEach(([el, pct], i) => {
        const x = 34 + i * bw;
        const h = (pct / 34) * (H - 44) * easeOut(t);
        g.fillStyle = i % 2 ? "#ffb86b" : "#d99a55";
        g.fillRect(x, H - 30 - h, bw - 6, h);
        g.fillStyle = "#e8dcc8bb";
        g.font = "8px ui-monospace, monospace";
        g.textAlign = "center";
        g.fillText(el.slice(0, 7), x + (bw - 6) / 2, H - 18);
        g.fillStyle = "#7dd3fc";
        g.fillText(`${pct}`, x + (bw - 6) / 2, H - 34 - h);
      });
      g.fillStyle = "#7dd3fc";
      g.font = "9px ui-monospace, monospace";
      g.textAlign = "right";
      g.fillText("wt% / modal", W - 6, 12);
      if (t < 1) requestAnimationFrame(draw);
    };
    draw();
    clearTimeout(this._scanHide);
    this._scanHide = setTimeout(() => this.hideScan(), 16000);
  }
  hideScan() { this.el.scanPanel.classList.add("hidden"); }

  addGalleryThumb(shot) {
    const img = document.createElement("img");
    img.src = shot.img;
    img.title = `SOL ${shot.sol} ${shot.lmst} ${shot.cam}`;
    img.addEventListener("click", () => {
      this.el.photoViewImg.src = shot.img;
      this.el.photoView.classList.remove("hidden");
    });
    this.el.gallery.prepend(img);
    while (this.el.gallery.children.length > 8) this.el.gallery.lastChild.remove();
  }

  showAlert(text) {
    this.el.alert.textContent = text;
    this.el.alert.classList.remove("hidden");
  }
  hideAlert() { this.el.alert.classList.add("hidden"); }

  bootProgress(f, msg) {
    this.el.bootBar.style.transform = `scaleX(${f.toFixed(3)})`;
    if (msg) this.el.bootMsg.textContent = msg;
  }
  bootReady(hasSave) {
    this.el.bootMsg.textContent = "SYSTEMS NOMINAL";
    this.el.titleButtons.classList.remove("hidden");
    this.el.btnContinue.classList.toggle("hidden", !hasSave);
  }
  hideTitle() {
    this.el.title.classList.add("fadeout");
    setTimeout(() => this.el.title.classList.add("hidden"), 900);
    this.el.hud.classList.remove("hidden");
  }

  showEnd(stats) {
    this.el.end.classList.remove("hidden");
    this.el.endStats.innerHTML = stats.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
  }
}

function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

const TEMPLATE = /* html */`
<div id="titleOverlay">
  <div class="titleInner">
    <div class="titleKicker">MARS SURFACE OPERATIONS</div>
    <h1 class="wordmark">REGOLITH</h1>
    <div class="titleSub">A MARS SURVEY · JEZERO-ADJACENT QUAD · LAT −18.42 LON 77.58</div>
    <div class="bootWrap"><div id="bootBar"></div></div>
    <div id="bootMsg">GENERATING TERRAIN…</div>
    <div id="titleButtons" class="hidden">
      <button id="btnNew" class="tBtn">▸ NEW MISSION</button>
      <button id="btnContinue" class="tBtn hidden">▸ CONTINUE SOL</button>
    </div>
    <div class="titleControls">
      W A S D drive · SPACE brake · mouse orbit · scroll zoom · C camera · F photo mode ·
      E action · M map · L lamps · hold T wait · ESC pause
    </div>
  </div>
</div>

<div id="hud" class="hidden">
  <div class="frame f-tl"></div><div class="frame f-tr"></div>
  <div class="frame f-bl"></div><div class="frame f-br"></div>

  <canvas id="compass" width="640" height="46"></canvas>

  <div id="missionCard" class="panel">
    <div class="pTitle" id="missionTitle">—</div>
    <ul id="missionTasks"></ul>
    <div class="pFoot" id="missionDist">—</div>
  </div>

  <div id="clockCard" class="panel">
    <div class="row"><span class="lbl">MISSION CLOCK</span><span id="warpChip" class="chip hidden">WAIT</span></div>
    <div id="clockVal" class="big">SOL 1 00:00:00</div>
    <div class="row"><span class="lbl">TEMP</span><span id="tempVal" class="val">—</span></div>
    <div class="row"><span class="lbl">WIND</span><span id="windVal" class="val">—</span></div>
    <div class="row"><span class="lbl">PRESS</span><span id="pressVal" class="val">—</span></div>
  </div>

  <div id="driveCard" class="panel">
    <div class="row"><span class="lbl">GROUND SPEED</span><span id="camChip" class="chip">CHASE</span></div>
    <div class="big"><span id="speedVal">0.00</span><span class="unit"> m/s</span></div>
    <div class="row"><span class="lbl">ODOMETER</span><span id="odoVal" class="val">0 m</span></div>
    <div id="modeChips"></div>
  </div>

  <div id="powerCard" class="panel">
    <div class="row"><span class="lbl">BATTERY</span><span id="battPct" class="val">—</span></div>
    <div class="battWrap"><div id="battBar"></div></div>
    <div class="row"><span class="lbl">NET POWER</span><span id="netW" class="val">—</span></div>
  </div>

  <canvas id="tiltCanvas" width="92" height="92"></canvas>
  <canvas id="minimap" width="204" height="204"></canvas>

  <div id="notif"></div>
  <div id="prompt" class="hidden"></div>
  <div id="actionRing" class="hidden">
    <svg viewBox="0 0 80 80">
      <circle cx="40" cy="40" r="36" fill="none" stroke="#ffffff22" stroke-width="3"/>
      <circle id="ringFill" cx="40" cy="40" r="36" fill="none" stroke="#ffb86b" stroke-width="3"
        stroke-dasharray="226" stroke-dashoffset="226" transform="rotate(-90 40 40)"/>
    </svg>
    <div id="ringLabel">0%</div>
  </div>

  <div id="scanPanel" class="panel hidden">
    <div class="pTitle">PIXL/SHERLOC COMPOSITE <button id="scanClose">×</button></div>
    <div id="scanName" class="sciName">—</div>
    <canvas id="scanCanvas" width="308" height="170"></canvas>
    <div id="scanFlavor" class="sciFlavor">—</div>
  </div>

  <div id="photoUI" class="hidden">
    <div class="pfBracket pf-tl"></div><div class="pfBracket pf-tr"></div>
    <div class="pfBracket pf-bl"></div><div class="pfBracket pf-br"></div>
    <div class="pfInfo">MASTCAM-Z · <span id="focalVal">48 mm</span> · CLICK / G — CAPTURE · scroll zoom · F exit</div>
    <div class="pfCross">+</div>
  </div>
  <div id="galleryStrip"></div>

  <div id="alertBanner" class="hidden"></div>
  <div id="fpsChip" class="hidden">60</div>
  <div id="hintBar">C camera · F photo · E action · M map · ESC menu</div>
</div>

<div id="mapOverlay" class="overlay hidden">
  <div class="mapWrap">
    <canvas id="mapCanvas"></canvas>
    <div class="mapHint">TOPOGRAPHIC SURVEY MAP — click to set waypoint · M to close</div>
  </div>
</div>

<div id="pauseOverlay" class="overlay hidden">
  <div class="menuPanel">
    <h2>MISSION PAUSED</h2>
    <div class="menuCols">
      <div class="menuCol">
        <h3>UPLINK LOG</h3>
        <ul id="logList"></ul>
      </div>
      <div class="menuCol">
        <h3>SETTINGS</h3>
        <label class="setRow">QUALITY
          <select id="qualitySel">
            <option value="0">LOW</option><option value="1">MEDIUM</option>
            <option value="2" selected>HIGH</option><option value="3">ULTRA</option>
          </select></label>
        <label class="setRow">VOLUME <input id="volSlider" type="range" min="0" max="1" step="0.05" value="0.8"></label>
        <label class="setRow">MUSIC <input id="musicSlider" type="range" min="0" max="1" step="0.05" value="0.6"></label>
        <label class="setRow">NAV BEAM <input id="beamChk" type="checkbox" checked></label>
        <h3 style="margin-top:14px">CONTROLS</h3>
        <div class="ctrlList">
          W/S throttle · A/D steer (turns in place when stopped)<br>
          SPACE brake · SHIFT precision · C camera · F photo mode<br>
          G/click capture · E hold action · M map · L lamps<br>
          T hold — wait (×300 time) · F3 fps · ESC resume
        </div>
        <button id="btnResume" class="tBtn">▸ RESUME</button>
        <button id="btnReset" class="tBtn danger">RESET SAVE</button>
      </div>
    </div>
  </div>
</div>

<div id="endOverlay" class="overlay hidden">
  <div class="menuPanel center">
    <div class="titleKicker">TRANSMISSION RECEIVED</div>
    <h2 class="endTitle">SURVEY COMPLETE</h2>
    <div id="endStats"></div>
    <div class="endNote">The quad remains open — keep driving, the tracks are yours.</div>
  </div>
</div>

<div id="photoView" class="overlay hidden"><img id="photoViewImg" alt="photo"></div>

<div id="touchControls" class="hidden">
  <div class="tcPad">
    <button data-k="KeyW" class="tcB tcU">▲</button>
    <button data-k="KeyA" class="tcB tcL">◀</button>
    <button data-k="KeyD" class="tcB tcR">▶</button>
    <button data-k="KeyS" class="tcB tcD">▼</button>
  </div>
  <div class="tcActs">
    <button data-k="KeyE" class="tcB">E</button>
    <button data-k="KeyC" class="tcB">CAM</button>
    <button data-k="KeyF" class="tcB">PHO</button>
  </div>
</div>
`;
