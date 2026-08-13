// Survey campaign: 7 missions over terrain-resolved sites, task state,
// uplink log, props (lander, relay, nav beam), and localStorage persistence.
import * as THREE from "three";
import { clamp } from "./noise.js";
import { MATS } from "./rover.js";

export const SAVE_KEY = "regolith-save-v2";

export function resolveSites(terrain) {
  const L = terrain.layout;
  // crater rim point on the lander-facing side
  const dl = new THREE.Vector2(L.lander.x - L.halo.x, L.lander.z - L.halo.z).normalize();
  const rim = { x: L.halo.x + dl.x * L.halo.r * 1.05, z: L.halo.z + dl.y * L.halo.r * 1.05 };
  // dune crest: local max near dune center
  let dc = { x: L.dune.cx, z: L.dune.cz, h: -Infinity };
  for (let dz = -70; dz <= 70; dz += 6) {
    for (let dx = -70; dx <= 70; dx += 6) {
      const h = terrain.heightAt(L.dune.cx + dx, L.dune.cz + dz);
      if (h > dc.h) dc = { x: L.dune.cx + dx, z: L.dune.cz + dz, h };
    }
  }
  // ridge summit: max in a box around the ridge center
  let rs = { x: L.ridge.x, z: L.ridge.z, h: -Infinity };
  for (let dz = -240; dz <= 240; dz += 9) {
    for (let dx = -240; dx <= 240; dx += 9) {
      const x = L.ridge.x + dx, z = L.ridge.z + dz;
      if (Math.abs(x) > 940 || Math.abs(z) > 940) continue;
      const h = terrain.heightAt(x, z);
      if (h > rs.h) rs = { x, z, h };
    }
  }
  return { lander: L.lander, rim, dune: dc, basin: { x: L.basin.x, z: L.basin.z }, ridge: rs };
}

export function missionDefs(sites) {
  return [
    {
      id: "M1", title: "SYSTEMS CHECKOUT", site: sites.lander, radius: 60,
      tasks: [
        { id: "drive", label: "Drive 40 m from the lander" },
        { id: "photo", label: "Return one surface photo [F → click]" },
      ],
      brief: "Post-EDL checkout. Shake the dust off: verify mobility and imaging.",
      done: "Checkout nominal. All six wheels healthy. Proceed to Halo crater.",
    },
    {
      id: "M2", title: "HALO CRATER RIM", site: sites.rim, radius: 14,
      tasks: [
        { id: "reach", label: "Reach the rim waypoint" },
        { id: "scan", label: "Spectrometer scan of rim ejecta [E]" },
      ],
      brief: "A fresh impact into the plains basalt. Rim blocks expose deep material.",
      done: "Olivine-bearing basalt with impact glass. Ejecta is deep crust — good anchor sample.",
      science: {
        name: "RIM EJECTA BLOCK", flavor: "Olivine basalt + impact melt glass. Unweathered interior — excavated from ~40 m depth.",
        comp: [["SiO2", 44], ["FeOT", 19], ["MgO", 11], ["Al2O3", 8], ["CaO", 7], ["Olivine", 22], ["Glass", 9]],
      },
    },
    {
      id: "M3", title: "SERPENT DUNE FIELD", site: sites.dune, radius: 14,
      tasks: [
        { id: "reach", label: "Reach the dune crest (watch for slip)" },
        { id: "scan", label: "Scan the crest sand [E]" },
      ],
      brief: "Active transverse dunes. Traction will be poor — keep momentum, avoid lee faces.",
      done: "Fine unweathered basaltic sand, chloride traces. The dunes are migrating ~0.4 m per Earth year.",
      science: {
        name: "CREST SAND", flavor: "Well-sorted basaltic sand, 150–300 µm. Chloride salts hint at vanished brines.",
        comp: [["SiO2", 43], ["FeOT", 18], ["MgO", 9], ["Chlorides", 4], ["Pyroxene", 30], ["Magnetite", 6]],
      },
    },
    {
      id: "M4", title: "ELYSIUM PLAYA", site: sites.basin, radius: 16,
      tasks: [
        { id: "reach", label: "Descend to the lakebed floor" },
        { id: "drill", label: "Core sample the playa [E — long op]" },
      ],
      brief: "A closed basin with polygonal fractures — a candidate paleolake. Coring authorized.",
      done: "SMECTITE CLAYS + evaporites in the core. This was standing water. Flagship result — uplink priority.",
      science: {
        name: "PLAYA CORE 0-6 cm", flavor: "Smectite clay laminae over evaporite crusts. Sustained standing water, then slow desiccation.",
        comp: [["Smectite", 24], ["SiO2", 31], ["Sulfates", 14], ["Chlorides", 6], ["FeOT", 12], ["Jarosite", 5]],
      },
    },
    {
      id: "M5", title: "THARSIS OVERLOOK", site: sites.ridge, radius: 16,
      tasks: [
        { id: "reach", label: "Climb to the ridge summit" },
        { id: "relay", label: "Deploy the UHF relay [E]" },
      ],
      brief: "Highest point of the quad. Grades to 25°+ — manage battery and pick your line.",
      done: "Relay deployed and locked. Line-of-sight to the whole quad. Downhill from here.",
    },
    {
      id: "M6", title: "EPHEMERAL", site: null, radius: 0,
      tasks: [
        { id: "devil", label: "Photograph an active dust devil (≤150 m, mastcam)" },
      ],
      brief: "Convective vortices peak in early afternoon. Catch one on the mast camera.",
      done: "Vortex imaged — core ΔP ~2 Pa, dust flux confirmed. Atmospherics team is delighted.",
    },
    {
      id: "M7", title: "UPLINK", site: sites.lander, radius: 15,
      tasks: [
        { id: "reach", label: "Return to the lander" },
        { id: "uplink", label: "Hold for HGA uplink [E]" },
      ],
      brief: "Bring it home. Full survey package transmits via the high-gain antenna.",
      done: "Uplink complete. Survey package received on Earth 11.4 light-minutes later. Outstanding work.",
    },
  ];
}

export class Missions {
  constructor(terrain, scene) {
    this.terrain = terrain;
    this.scene = scene;
    this.sites = resolveSites(terrain);
    this.defs = missionDefs(this.sites);
    this.idx = 0;
    this.taskState = this.defs.map((m) => m.tasks.map(() => false));
    this.log = [];
    this.photos = 0;
    this.samples = 0;
    this.startDist = null;
    this.complete = false;
    this.beamOn = true;
    this.customWaypoint = null;

    this.buildProps();
  }

  buildProps() {
    // ---- lander (descent platform)
    const lander = new THREE.Group();
    const s = this.sites.lander;
    const gy = this.terrain.heightAt(s.x, s.z);
    lander.position.set(s.x, gy - 0.06, s.z);
    lander.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), this.terrain.normalAt(s.x, s.z, 2.6));
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 0.35, 8), MATS.body);
    deck.position.y = 0.72;
    deck.castShadow = deck.receiveShadow = true;
    lander.add(deck);
    const mli = new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.42, 0.22, 8), MATS.mli);
    mli.position.y = 0.5;
    mli.castShadow = true;
    lander.add(mli);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.15, 8), MATS.strut);
      leg.position.set(Math.cos(a) * 1.55, 0.42, Math.sin(a) * 1.55);
      leg.rotation.z = Math.cos(a) * 0.5;
      leg.rotation.x = -Math.sin(a) * 0.5;
      leg.castShadow = true;
      lander.add(leg);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.08, 10), MATS.dark);
      foot.position.set(Math.cos(a) * 1.82, 0.04, Math.sin(a) * 1.82);
      foot.castShadow = true;
      lander.add(foot);
    }
    const rampGeo = new THREE.BoxGeometry(1.1, 0.06, 2.3);
    const ramp = new THREE.Mesh(rampGeo, MATS.strut);
    ramp.position.set(0, 0.45, 2.0);
    ramp.rotation.x = 0.38;
    ramp.castShadow = ramp.receiveShadow = true;
    lander.add(ramp);
    this.scene.add(lander);
    this.landerObj = lander;

    // ---- nav beam (holographic waypoint column)
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffb86b, transparent: true, opacity: 0.16, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 46, 12, 1, true), beamMat);
    this.beam.frustumCulled = false;
    this.scene.add(this.beam);
    const markMat = new THREE.MeshBasicMaterial({ color: 0xffb86b, transparent: true, opacity: 0.7 });
    this.beamMark = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.0, 24), markMat);
    this.beamMark.rotation.x = -Math.PI / 2;
    this.scene.add(this.beamMark);
  }

  spawnRelay() {
    const r = new THREE.Group();
    const s = this.sites.ridge;
    r.position.set(s.x, this.terrain.heightAt(s.x, s.z), s.z);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.9, 6), MATS.strut);
      leg.position.set(Math.cos(a) * 0.35, 0.4, Math.sin(a) * 0.35);
      leg.rotation.z = Math.cos(a) * 0.45;
      leg.rotation.x = -Math.sin(a) * 0.45;
      leg.castShadow = true;
      r.add(leg);
    }
    const boxm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.24, 0.22), MATS.body);
    boxm.position.y = 0.9;
    boxm.castShadow = true;
    r.add(boxm);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.1, 6), MATS.dark);
    ant.position.y = 1.6;
    ant.castShadow = true;
    r.add(ant);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff4d3a }));
    beacon.position.y = 2.17;
    r.add(beacon);
    this.relayBeacon = beacon;
    this.scene.add(r);
    this.relayObj = r;
  }

  cur() { return this.defs[this.idx]; }
  curTasks() { return this.taskState[this.idx]; }

  taskDone(taskId) {
    const m = this.cur();
    if (!m) return false;
    const i = m.tasks.findIndex((t) => t.id === taskId);
    if (i < 0 || this.taskState[this.idx][i]) return false;
    this.taskState[this.idx][i] = true;
    return true;
  }
  allTasksDone() { return this.taskState[this.idx].every(Boolean); }

  advance(pushLog) {
    const m = this.cur();
    pushLog(`OPS/${m.id}: ${m.done}`);
    if (this.idx < this.defs.length - 1) {
      this.idx++;
      const n = this.cur();
      pushLog(`OPS/${n.id} BRIEF: ${n.brief}`);
    } else {
      this.complete = true;
    }
  }

  // active nav target (mission site or custom waypoint)
  navTarget() {
    const m = this.cur();
    if (m && m.site) return { x: m.site.x, z: m.site.z, label: m.id };
    return null;
  }

  distTo(pos) {
    const t = this.navTarget();
    if (!t) return null;
    return Math.hypot(t.x - pos.x, t.z - pos.z);
  }

  update(dt, rover, events) {
    const m = this.cur();
    if (!m || this.complete) { this.beam.visible = this.beamMark.visible = false; return; }
    // beam placement
    const t = this.navTarget();
    if (t && this.beamOn) {
      const gy = this.terrain.heightAt(t.x, t.z);
      this.beam.visible = true;
      this.beam.position.set(t.x, gy + 23, t.z);
      this.beam.material.opacity = 0.1 + 0.06 * Math.sin(performance.now() * 0.003);
      this.beamMark.visible = true;
      this.beamMark.position.set(t.x, gy + 0.25, t.z);
    } else {
      this.beam.visible = this.beamMark.visible = false;
    }
    if (this.relayBeacon) {
      this.relayBeacon.material.color.setHex(
        Math.floor(performance.now() / 700) % 2 ? 0xff4d3a : 0x611710);
    }

    // reach tasks
    if (m.site) {
      const d = Math.hypot(m.site.x - rover.pos.x, m.site.z - rover.pos.z);
      if (m.id === "M1") {
        if (this.startDist === null) this.startDist = { x: rover.pos.x, z: rover.pos.z };
        const dd = Math.hypot(rover.pos.x - this.startDist.x, rover.pos.z - this.startDist.z);
        if (dd > 40 && this.taskDone("drive")) events.task("Mobility verified — 40 m traverse");
      } else if (d < m.radius) {
        if (this.taskDone("reach")) events.task(`Waypoint ${m.id} reached`);
      }
    }
  }

  // ---------- persistence
  saveData(extra) {
    return {
      v: 2, idx: this.idx, tasks: this.taskState, log: this.log.slice(-60),
      photos: this.photos, samples: this.samples, complete: this.complete,
      relay: !!this.relayObj, ...extra,
    };
  }
  restore(d) {
    this.idx = clamp(d.idx ?? 0, 0, this.defs.length - 1);
    if (Array.isArray(d.tasks)) {
      d.tasks.forEach((row, i) => {
        if (this.taskState[i]) row.forEach((v, j) => { if (j < this.taskState[i].length) this.taskState[i][j] = !!v; });
      });
    }
    this.log = d.log || [];
    this.photos = d.photos || 0;
    this.samples = d.samples || 0;
    this.complete = !!d.complete;
    if (d.relay) this.spawnRelay();
  }
}
