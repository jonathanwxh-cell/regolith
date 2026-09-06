// Survey campaign: 7 missions over terrain-resolved sites, task state,
// uplink log, props (lander, relay, nav beam), and localStorage persistence.
import * as THREE from "three";
import { clamp } from "./noise.js";
import { MATS } from "./rover.js";

export const SAVE_KEY = "regolith-save-v4";

export function resolveSites(terrain) {
  const L = terrain.layout;
  // fresh-crater rim point on the lander-facing side
  const dl = new THREE.Vector2(L.lander.x - L.halo.x, L.lander.z - L.halo.z).normalize();
  const rim = { x: L.halo.x + dl.x * L.halo.r * 1.05, z: L.halo.z + dl.y * L.halo.r * 1.05 };
  // dune crest: local max near the Seitah field center
  let dc = { x: L.seitah.x, z: L.seitah.z, h: -Infinity };
  for (let dz = -90; dz <= 90; dz += 6) {
    for (let dx = -90; dx <= 90; dx += 6) {
      const h = terrain.heightAt(L.seitah.x + dx, L.seitah.z + dz);
      if (h > dc.h) dc = { x: L.seitah.x + dx, z: L.seitah.z + dz, h };
    }
  }
  // delta drill: walk a ray out of the fan and stop just past the scarp base
  const D = L.delta;
  const rayA = 0.14;
  let delta = { x: D.apexX + Math.cos(rayA) * D.radius, z: D.apexZ + Math.sin(rayA) * D.radius };
  for (let ra = D.radius * 0.55; ra < D.radius * 1.35; ra += 8) {
    const x = D.apexX + Math.cos(rayA) * ra, z = D.apexZ + Math.sin(rayA) * ra;
    if (terrain.maskAtRaw(x, z, 0) < 0.3) { // fell off the strata: scarp base
      delta = { x: x + Math.cos(rayA) * 42, z: z + Math.sin(rayA) * 42 };
      break;
    }
  }
  // rim bench: flattest high point near the overlook shoulder
  let rs = { x: L.overlook.x, z: L.overlook.z, h: -Infinity };
  for (let dz = -70; dz <= 70; dz += 7) {
    for (let dx = -70; dx <= 70; dx += 7) {
      const x = L.overlook.x + dx, z = L.overlook.z + dz;
      const h = terrain.heightAt(x, z);
      if (h > rs.h && terrain.slopeAt(x, z) < 0.2) rs = { x, z, h };
    }
  }
  return { lander: L.lander, rim, dune: dc, delta, ridge: rs, argo: L.argoSite };
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
      id: "M3", title: "SÉÍTAH SANDS", site: sites.dune, radius: 18,
      tasks: [
        { id: "reach", label: "Reach the dune crest (watch for slip)" },
        { id: "scan", label: "Scan an outcrop between the ripples [E]" },
      ],
      brief: "A maze of transverse dunes — and between them, the oldest rock exposed on this floor. Keep momentum, avoid the lee faces.",
      done: "Olivine-rich cumulate under the sand: this floor is layered igneous rock, older than everything above it. The dunes are migrating ~0.4 m per Earth year.",
      science: {
        name: "INTER-RIPPLE OUTCROP", flavor: "Coarse olivine cumulate with pyroxene, lightly dust-mantled. The lowest exposed unit of the floor — an igneous basement.",
        comp: [["Olivine", 34], ["Pyroxene", 26], ["SiO2", 38], ["FeOT", 17], ["MgO", 14], ["Chlorides", 3]],
      },
    },
    {
      id: "M4", title: "THE DELTA FRONT", site: sites.delta, radius: 18,
      tasks: [
        { id: "reach", label: "Reach the scarp at the delta front" },
        { id: "drill", label: "Core the basal strata [E — long op]" },
      ],
      brief: "A river once entered this crater through the western wall and built that fan. The front scarp exposes ~25 m of layered strata — foreset beds, and boulder layers from flood events. Coring authorized at the base.",
      done: "Clinoform foresets over lakebed muds: SMECTITE CLAYS, carbonate cement, and a conglomerate of transported boulders. Sustained river inflow into a standing lake — with violent floods late. Flagship result; uplink priority.",
      science: {
        name: "DELTA BASAL CORE", flavor: "Smectite-rich mudstone under cross-bedded sandstone; carbonate cement; rounded clasts to 1.5 m nearby speak of flood transport.",
        comp: [["Smectite", 22], ["SiO2", 30], ["Carbonate", 11], ["Sulfates", 9], ["FeOT", 13], ["Jarosite", 4]],
      },
    },
    {
      id: "M5", title: "RIM BENCH RELAY", site: sites.ridge, radius: 18,
      tasks: [
        { id: "reach", label: "Climb the wall corridor to the bench" },
        { id: "relay", label: "Deploy the UHF relay [E]" },
      ],
      brief: "A shoulder on the inner rim wall, ~90 m over the floor. The full wall climbs another kilometer above it — this is as high as wheels go. Long grades: watch tilt and battery.",
      done: "Relay deployed and locked, line-of-sight to the whole quad. From up here you can see the delta, the dunes, and your own tracks. Downhill from here.",
    },
    {
      id: "M6", title: "THE INLET", site: sites.argo, radius: 40,
      tasks: [
        { id: "reach", label: "Climb the inlet canyon to the plateau — ARGO-1's landing site" },
      ],
      brief: "The river's road up through the western wall. Nobody has driven it since ARGO-1 drove down. Her landing platform is up there somewhere.",
      done: "You are on the plateau where the other rover began. Everything below you was her survey area once.",
    },
    {
      id: "M7", title: "EPHEMERAL", site: null, radius: 0,
      tasks: [
        { id: "devil", label: "Photograph an active dust devil (≤150 m, mastcam)" },
      ],
      brief: "Convective vortices peak in early afternoon. Catch one on the mast camera — any time, anywhere.",
      done: "Vortex imaged — core ΔP ~2 Pa, dust flux confirmed. Atmospherics team is delighted.",
    },
    {
      id: "M8", title: "UPLINK", site: sites.lander, radius: 15,
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
  taskDoneById(mid, tid) {
    const i = this.defs.findIndex((m) => m.id === mid);
    if (i < 0) return false;
    const j = this.defs[i].tasks.findIndex((t) => t.id === tid);
    return j >= 0 && !!this.taskState[i][j];
  }
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

  update(dt, rover, events, story) {
    const m = this.cur();
    if (!m || this.complete) { this.beam.visible = this.beamMark.visible = false; return; }
    // a devil photographed earlier counts the moment EPHEMERAL activates
    if (m.id === "M7" && story && story.has("devil_photo") && this.taskDone("devil")) events.task("Dust devil already on file — credited");
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
