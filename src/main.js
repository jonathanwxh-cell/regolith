// REGOLITH — boot, input, game loop, persistence, quality management.
import * as THREE from "three";
import { Terrain } from "./terrain.js";
import { Sky } from "./sky.js";
import { Rocks } from "./rocks.js";
import { Rover } from "./rover.js";
import { CameraRig } from "./cameras.js";
import { Dust } from "./dust.js";
import { Missions, SAVE_KEY } from "./missions.js";
import { Instruments } from "./instruments.js";
import { HUD } from "./hud.js";
import { AudioSys } from "./audio.js";
import { Post } from "./post.js";
import { clamp } from "./noise.js";

const app = document.getElementById("app");
const hud = new HUD(document.body);

// ---- error surface (debug aid)
window.addEventListener("error", (e) => {
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;bottom:4px;left:4px;z-index:99;color:#ff8a7a;font:11px monospace;background:#000c;padding:4px 8px;max-width:90vw";
  d.textContent = `ERR: ${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`;
  document.body.appendChild(d);
});

// ---- renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.classList.add("webgl");
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.12, 9000);

// ---- state
const S = {
  mode: "title",       // title | sim | paused | map | end
  warp: 1,
  fps: 60,
  playSeconds: 0,
  trail: [],
  captureFlag: false,
  quality: 2,
  saveTimer: 0,
  lastLampHint: false,
  battWarned: {},
  stormPrev: "idle",
};

let terrain, sky, rocks, rover, rig, dust, missions, instruments, post;
const audio = new AudioSys();

// ---- input
const keys = {};
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  keys[e.code] = true;
  onKey(e.code, e);
});
window.addEventListener("keyup", (e) => {
  keys[e.code] = false;
  if (e.code === "KeyE" && instruments && instruments.action) instruments.cancel();
});
for (const b of document.querySelectorAll("#touchControls .tcB")) {
  const code = b.dataset.k;
  b.addEventListener("pointerdown", (e) => { e.preventDefault(); keys[code] = true; onKey(code, null); });
  b.addEventListener("pointerup", () => { keys[code] = false; });
  b.addEventListener("pointerleave", () => { keys[code] = false; });
}

function onKey(code, e) {
  if (S.mode === "title") return;
  if (code === "Escape") {
    if (S.mode === "map") return toggleMap();
    if (document.pointerLockElement) return; // browser handles exit
    if (S.mode === "sim") pauseGame(true);
    else if (S.mode === "paused") pauseGame(false);
    return;
  }
  if (S.mode !== "sim") {
    if (code === "KeyM" && S.mode === "map") toggleMap();
    return;
  }
  switch (code) {
    case "KeyC": audio.uiTick(); rig.cycle(); break;
    case "KeyF":
      if (rig.mode === "MASTCAM") rig.setMode("CHASE");
      else rig.setMode("MASTCAM");
      audio.uiTick();
      break;
    case "KeyG": if (rig.mode === "MASTCAM") S.captureFlag = true; break;
    case "KeyE": {
      const ca = instruments.contextAction();
      if (ca && ca.type !== "blocked") instruments.start(ca.type);
      else if (ca) audio.uiBack();
      break;
    }
    case "KeyM": toggleMap(); break;
    case "KeyL":
      rover.lampsOn = !rover.lampsOn;
      audio.uiTick();
      hud.notify(rover.lampsOn ? "WORK LAMPS ON" : "WORK LAMPS OFF");
      break;
    case "F3": hud.el.fps.classList.toggle("hidden"); e && e.preventDefault(); break;
  }
}
renderer.domElement.addEventListener("click", () => {
  if (S.mode === "sim" && rig.mode === "MASTCAM") {
    if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock?.();
    else S.captureFlag = true;
  }
});

function toggleMap() {
  if (S.mode === "sim") {
    S.mode = "map";
    hud.el.map.classList.remove("hidden");
    hud.drawFullMap(rover, missions, S.trail);
    audio.uiTick();
  } else if (S.mode === "map") {
    S.mode = "sim";
    hud.el.map.classList.add("hidden");
    audio.uiBack();
  }
}
function pauseGame(on) {
  if (on) {
    S.mode = "paused";
    hud.el.pause.classList.remove("hidden");
    hud.restoreLog(missions);
    audio.uiBack();
  } else {
    S.mode = "sim";
    hud.el.pause.classList.add("hidden");
    audio.uiTick();
  }
}

// ---- events hub
const events = {
  notify: (t, k) => hud.notify(t, k || "info"),
  task: (t) => { hud.notify(t, "task"); saveGame(); },
  science: (sci) => {
    hud.showScience(sci);
    hud.pushLog(missions, `SCI · ${sci.name} — ${sci.flavor}`);
  },
  shake: (a) => rig.addShake(a),
  checkAdvance: () => {
    if (!missions.allTasksDone()) return;
    const wasLast = missions.idx === missions.defs.length - 1;
    missions.advance((t) => hud.pushLog(missions, t));
    audio.radio();
    if (missions.complete && wasLast) {
      showEndScreen();
    } else {
      hud.notify(`MISSION ${missions.defs[missions.idx - 1] ? missions.defs[missions.idx - 1].id : ""} COMPLETE`, "task");
    }
    saveGame();
  },
};

function showEndScreen() {
  S.mode = "end";
  const h = Math.floor(S.playSeconds / 3600), m = Math.floor((S.playSeconds % 3600) / 60);
  hud.showEnd([
    ["SOLS ON SURFACE", sky.sol],
    ["DISTANCE", `${(rover.odometer / 1000).toFixed(2)} km`],
    ["PHOTOS", missions.photos],
    ["SAMPLES", missions.samples],
    ["EARTH TIME", `${h}h ${String(m).padStart(2, "0")}m`],
  ]);
  hud.el.end.addEventListener("click", () => {
    hud.el.end.classList.add("hidden");
    S.mode = "sim";
  }, { once: true });
}

// ---- persistence
function saveGame() {
  if (!missions || S.mode === "title") return;
  try {
    const data = missions.saveData({
      rover: {
        x: rover.pos.x, z: rover.pos.z, heading: rover.heading,
        odo: rover.odometer, batt: rover.battery, lamps: rover.lampsOn,
      },
      sky: { sol: sky.sol, tSec: sky.tSec },
      settings: { q: S.quality, vol: audio.volume, beam: missions.beamOn },
      play: S.playSeconds,
      wpt: missions.customWaypoint,
    });
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch { /* storage full/unavailable — ignore */ }
}
function loadSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); }
  catch { return null; }
}

// ---- quality
const QUALITY = [
  { pr: 0.75, shadow: 1024, post: false, dustScale: 0.5 },
  { pr: 1.0, shadow: 2048, post: true, dustScale: 0.8 },
  { pr: Math.min(devicePixelRatio, 1.5), shadow: 2048, post: true, dustScale: 1 },
  { pr: Math.min(devicePixelRatio, 2), shadow: 4096, post: true, dustScale: 1 },
];
function applyQuality(i) {
  S.quality = i;
  const q = QUALITY[i];
  renderer.setPixelRatio(q.pr);
  post.enabled = q.post;
  if (sky.sun.shadow.mapSize.x !== q.shadow) {
    sky.sun.shadow.mapSize.set(q.shadow, q.shadow);
    if (sky.sun.shadow.map) { sky.sun.shadow.map.dispose(); sky.sun.shadow.map = null; }
  }
  onResize();
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (post) post.setSize(innerWidth, innerHeight, QUALITY[S.quality].pr);
}
window.addEventListener("resize", onResize);

// ---- boot
async function boot() {
  try {
    hud.bootProgress(0.02, "GENERATING TERRAIN…");
    terrain = new Terrain(20260813);
    await terrain.generate((f) => hud.bootProgress(0.02 + f * 0.55,
      f < 0.5 ? "GENERATING TERRAIN…" : "RASTERIZING CRATERS…"));
    hud.bootProgress(0.6, "BUILDING MESHES…");
    await nextFrame();
    scene.add(terrain.build(renderer));
    hud.bootProgress(0.68, "SCATTERING ROCK FIELDS…");
    await nextFrame();
    rocks = new Rocks(terrain);
    scene.add(rocks.group);
    hud.bootProgress(0.76, "ASSEMBLING VEHICLE…");
    await nextFrame();
    rover = new Rover(terrain, rocks);
    scene.add(rover.group);
    sky = new Sky(scene, renderer);
    dust = new Dust(scene, terrain);
    missions = new Missions(terrain, scene);
    instruments = new Instruments(rover, missions, dust, audio);
    rig = new CameraRig(camera, rover, terrain, renderer.domElement);
    post = new Post(renderer, scene, camera);
    hud.bootProgress(0.88, "BAKING SURVEY MAP…");
    await nextFrame();
    hud.bakeMap(terrain);
    hud.mapClickCb = (x, z) => {
      if (missions.customWaypoint && Math.hypot(missions.customWaypoint.x - x, missions.customWaypoint.z - z) < 40) {
        missions.customWaypoint = null;
        hud.notify("WAYPOINT CLEARED");
      } else {
        missions.customWaypoint = { x: clamp(x, -1000, 1000), z: clamp(z, -1000, 1000) };
        hud.notify(`WAYPOINT SET ${x.toFixed(0)}E ${z.toFixed(0)}N`);
      }
      hud.drawFullMap(rover, missions, S.trail);
    };
    applyQuality(2);
    onResize();
    hud.bootProgress(1, "SYSTEMS NOMINAL");
    // scorch mark under the lander
    const L = terrain.layout.lander;
    for (let k = 0; k < 30; k++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 3.4;
      terrain.splatTrack(L.x + Math.cos(a) * r, L.z + Math.sin(a) * r, a, 2.2, 2.2, 0.5);
    }
    hud.bootReady(!!loadSave());
    wireTitle();
    window.__RG = { scene, terrain, rover, sky, dust, missions, rocks, renderer, rig, S, THREE };
    requestAnimationFrame(loop);
  } catch (err) {
    hud.el.bootMsg.textContent = `BOOT FAULT: ${err.message}`;
    console.error(err);
    throw err;
  }
}

function wireTitle() {
  hud.el.btnNew.addEventListener("click", () => {
    localStorage.removeItem(SAVE_KEY);
    startSim(null);
  });
  hud.el.btnContinue.addEventListener("click", () => startSim(loadSave()));
  hud.el.btnResume.addEventListener("click", () => pauseGame(false));
  hud.el.btnReset.addEventListener("click", () => {
    localStorage.removeItem(SAVE_KEY);
    location.reload();
  });
  hud.el.qualitySel.addEventListener("change", (e) => {
    applyQuality(parseInt(e.target.value, 10));
    audio.uiTick();
  });
  hud.el.volSlider.addEventListener("input", (e) => audio.setVolume(parseFloat(e.target.value)));
  hud.el.beamChk.addEventListener("change", (e) => { missions.beamOn = e.target.checked; });
}

function startSim(save) {
  audio.init();
  if (save) {
    missions.restore(save);
    if (save.rover) {
      rover.pos.x = save.rover.x; rover.pos.z = save.rover.z;
      rover.heading = save.rover.heading || 0;
      rover.odometer = save.rover.odo || 0;
      rover.battery = save.rover.batt ?? 1080;
      rover.lampsOn = !!save.rover.lamps;
      rover.snapToGround();
    }
    if (save.sky) { sky.sol = save.sky.sol || 1; sky.tSec = save.sky.tSec || sky.tSec; }
    if (save.settings) {
      applyQuality(save.settings.q ?? 2);
      hud.el.qualitySel.value = String(S.quality);
      audio.setVolume(save.settings.vol ?? 0.8);
      hud.el.volSlider.value = String(audio.volume);
      missions.beamOn = save.settings.beam !== false;
      hud.el.beamChk.checked = missions.beamOn;
    }
    S.playSeconds = save.play || 0;
    if (save.wpt) missions.customWaypoint = save.wpt;
    hud.restoreLog(missions);
    hud.notify(`RESUMED — SOL ${sky.sol}`, "task");
  } else {
    hud.pushLog(missions, "OPS: Touchdown confirmed. REGOLITH-1 is on Mars.");
    hud.pushLog(missions, `OPS/M1 BRIEF: ${missions.defs[0].brief}`);
    hud.notify("TOUCHDOWN CONFIRMED — SOL 1", "task");
  }
  hud.hideTitle();
  S.mode = "sim";
}

// ---- loop
let lastT = performance.now();
const windDir = new THREE.Vector3(1, 0, 0);
function loop(now) {
  requestAnimationFrame(loop);
  let dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  S.fps = S.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

  if (S.mode === "title") {
    // idle sunrise scene behind the title
    sky && rover && sky.update(dt, 4, camera, rover.pos);
    if (rover) {
      rig.orbitT += dt * 0.05;
      const a = rig.orbitT;
      camera.position.set(rover.pos.x + Math.sin(a) * 11, rover.pos.y + 2.6, rover.pos.z + Math.cos(a) * 11);
      camera.lookAt(rover.pos.x, rover.pos.y + 1, rover.pos.z);
      terrain.update(rover.pos, renderer, 0);
      post.render(dt, { storm: 0, mono: false, duskF: sky.duskF, nightF: sky.nightF });
    }
    return;
  }
  if (S.mode === "paused" || S.mode === "end" || S.mode === "map") {
    // frozen frame behind overlays; keep map fresh-ish
    if (S.mode === "map" && Math.floor(now / 400) !== Math.floor((now - dt * 1000) / 400)) {
      hud.drawFullMap(rover, missions, S.trail);
    }
    return;
  }

  S.playSeconds += dt;

  // warp: hold T while stationary
  const wantWarp = keys.KeyT && Math.abs(rover.v) < 0.1 && !instruments.busy;
  S.warp = wantWarp ? 300 : 1;

  // input → rover
  const precision = keys.ShiftLeft || keys.ShiftRight ? 0.35 : 1;
  const input = {
    throttle: S.warp > 1 ? 0 : ((keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0)) * precision,
    steer: (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0),
    brake: !!keys.Space,
  };

  const dtSim = dt * sky.timeScale * S.warp;
  const envInfo = sky.update(dt, S.warp, camera, rover.pos);
  // wind direction wanders slowly
  const wa = sky.noise.noise(sky.tSec * 0.00002, 77) * Math.PI * 2;
  windDir.set(Math.cos(wa), 0, Math.sin(wa)).multiplyScalar(1 + envInfo.wind * 0.06);
  const env = {
    tempC: sky.temperatureC(), wind: envInfo.wind, windDir,
    storm: sky.storm, dayF: sky.dayF, duskF: sky.duskF, nightF: sky.nightF,
  };

  rover.step(dt, dtSim, input, env);
  instruments.update(dt, events);
  missions.update(dt, rover, events);
  dust.update(dt, env, rover, camera);
  rig.update(dt);
  terrain.update(rover.pos, renderer, sky.storm.intensity > 0.5 ? 0.0045 : 0);

  // trail
  const lastP = S.trail[S.trail.length - 1];
  if (!lastP || Math.hypot(rover.pos.x - lastP[0], rover.pos.z - lastP[1]) > 4) {
    S.trail.push([rover.pos.x, rover.pos.z]);
    if (S.trail.length > 1600) S.trail.shift();
  }

  ambientAlerts(env);
  audio.update(dt, {
    wind: env.wind, speed: rover.v, slipping: rover.slipping,
    drilling: instruments.drilling, storm: sky.storm.intensity,
  });

  // exposure: lift a touch at night
  renderer.toneMappingExposure = 1.12 + sky.nightF * 0.34;

  hud.update(dt, {
    rover, sky, missions, instruments,
    camMode: rig.mode, warp: S.warp, fps: S.fps, mastFov: rig.mastFov,
  });

  post.render(dt, {
    storm: sky.storm.intensity, mono: rig.mode === "HAZCAM",
    duskF: sky.duskF, nightF: sky.nightF,
  });

  if (S.captureFlag) {
    S.captureFlag = false;
    let devilInfo = null;
    if (rig.mode === "MASTCAM") {
      const nd = dust.nearestDevil(rover.pos);
      if (nd && nd.dist < 150) {
        const dir = new THREE.Vector3(nd.devil.pos.x - camera.position.x, 0, nd.devil.pos.z - camera.position.z).normalize();
        const cd = camera.getWorldDirection(new THREE.Vector3());
        cd.y = 0; cd.normalize();
        const ang = Math.acos(clamp(dir.dot(cd), -1, 1)) * 180 / Math.PI;
        devilInfo = { ok: ang < 14 && sky.dayF > 0.4 && nd.devil.uniforms.uOpacity.value > 0.4, dist: nd.dist };
      }
    }
    const shot = instruments.capturePhoto(renderer, rig.mode, { sol: sky.sol, lmst: sky.lmst(), events }, devilInfo);
    hud.addGalleryThumb(shot);
  }

  // autosave
  S.saveTimer += dt;
  if (S.saveTimer > 15) { S.saveTimer = 0; saveGame(); }
}

function ambientAlerts(env) {
  // storm transitions
  if (sky.storm.phase !== S.stormPrev) {
    if (sky.storm.phase === "approach") { hud.notify("PRESSURE DROPPING — DUST EVENT LIKELY", "warn"); audio.warn(); }
    if (sky.storm.phase === "active") { hud.notify("REGIONAL DUST EVENT — SEEK NO SHELTER, THERE IS NONE", "warn"); }
    if (sky.storm.phase === "idle" && S.stormPrev === "decay") hud.notify("ATMOSPHERE CLEARING", "task");
    S.stormPrev = sky.storm.phase;
  }
  // dark hint
  const dark = sky.dayF < 0.25;
  if (dark && !S.lastLampHint && !rover.lampsOn) {
    S.lastLampHint = true;
    hud.notify("SUN IS DOWN — press L for work lamps");
  }
  if (!dark) S.lastLampHint = false;
  // battery thresholds
  const pct = rover.battery / rover.batteryCap;
  for (const [th, msg] of [[0.3, "BATTERY 30% — plan a recharge stop"], [0.12, "BATTERY 12% — hold T to wait & recharge"], [0.05, "BATTERY CRITICAL — limp mode"]]) {
    if (pct < th && !S.battWarned[th]) { S.battWarned[th] = true; hud.notify(msg, "warn"); audio.warn(); }
    if (pct > th + 0.08) S.battWarned[th] = false;
  }
  if (rover.hitBoundary && !S.boundWarn) {
    S.boundWarn = true;
    hud.notify("QUAD BOUNDARY — survey zone ends here", "warn");
    setTimeout(() => { S.boundWarn = false; }, 6000);
  }
}

window.addEventListener("beforeunload", saveGame);
document.addEventListener("visibilitychange", () => { if (document.hidden) saveGame(); });

function nextFrame() { return new Promise((r) => requestAnimationFrame(r)); }

boot();
