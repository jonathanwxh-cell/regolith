// Points of interest: discoverable places off the mission spine, each with a
// procedural prop, a discovery beat, and optionally a held action (scan /
// retrieve / photo). Also bakes ARGO-1's old wheel trail into the track map.
import * as THREE from "three";
import { MATS } from "./rover.js";
import { distToSeg } from "./terrain.js";

const dusty = (hex, rough = 0.95) => new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0.05 });
const M = {
  canopy: dusty(0xcfc4b4, 0.9),
  canopyStripe: dusty(0xb8542e, 0.9),
  shell: dusty(0xd8d2c6, 0.7),
  shield: new THREE.MeshStandardMaterial({ color: 0x2c221c, roughness: 0.85, metalness: 0.1 }),
  argoBody: dusty(0xa88a6a, 0.98),
  argoPanel: new THREE.MeshStandardMaterial({ color: 0x3b3a42, roughness: 0.75, metalness: 0.25 }),
  argoPanelDust: dusty(0x8c7255, 1.0),
  meteorite: new THREE.MeshStandardMaterial({ color: 0x3a3a3d, roughness: 0.42, metalness: 0.72 }),
  ice: new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.35, metalness: 0.0 }),
  tube: new THREE.MeshStandardMaterial({ color: 0xd8dde0, roughness: 0.35, metalness: 0.7 }),
  post: dusty(0x9b9186, 0.7),
};

export class POIs {
  constructor(scene, terrain, story, missions) {
    this.scene = scene;
    this.terrain = terrain;
    this.story = story;
    this.missions = missions;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.transitWindow = false;
    this.list = this.define();
  }

  define() {
    const L = this.terrain.layout;
    const H = L.halo;
    return [
      {
        id: "chute", title: "PARACHUTE CANOPY", x: H.x + 170, z: H.z + 220, r: 55, kind: "find", hintFlag: "argo_hint",
        prop: (g) => this.propParachute(g),
        onDiscover: (s) => {
          s.saySeq([
            ["GEO", "…that's a parachute canopy. Mars-grade nylon, orange and white. Still half-inflated in the lee."],
            ["FD", "Meridian program. ARGO-1. Landed on the plateau in '31, drove off the map in '33. Presumed lost in the global storm. Nobody knew it made it this far."],
            ["SYS", "Solar-powered. That storm would've… yeah."],
          ]);
          s.setFlag("argo_known");
        },
      },
      {
        id: "backshell", title: "BACKSHELL", x: H.x + 80, z: H.z + 360, r: 45, kind: "find", hintFlag: "argo_known",
        prop: (g) => this.propBackshell(g),
        onDiscover: (s) => s.say("SYS", "Backshell. Cone's split — that's a hard landing for the shell, normal for the payload. She was fine at this point."),
      },
      {
        id: "shield", title: "HEAT SHIELD", x: H.x - 60, z: H.z + 480, r: 45, kind: "find", hintFlag: "argo_known",
        prop: (g) => this.propHeatShield(g),
        onDiscover: (s) => s.say("GEO", "Heat shield, ablator side up. Entry debris fans out along the flight path — follow it and you find where the rover started walking."),
      },
      {
        id: "argo", title: "ARGO-1", x: L.seitah.x - 530, z: L.seitah.z + 130, r: 60, kind: "find", hintFlag: "argo_known",
        prop: (g) => this.propArgo(g),
        onDiscover: (s) => {
          s.saySeq([
            ["GEO", "There she is."],
            ["SYS", "Tilted, sand to the hubs. Panels caked solid. She never had a chance once the sky went."],
            ["FD", "Her memory core is a physical module — it survives storms. Pull it and we uplink whatever she saw. Her team never got the end of the story."],
          ]);
          s.offerChoice("RETRIEVE ARGO-1'S MEMORY CORE? (arm op, ~12% battery)", "RETRIEVE IT", "LEAVE HER",
            () => { s.setFlag("argo_core_offered"); s.say("FD", "Copy. Get the arm on her deck. Take your time — she's not going anywhere."); },
            () => { s.setFlag("argo_left"); s.say("FD", "Copy. Position's marked for the record. If you change your mind, she'll be here."); });
        },
        action: {
          label: "HOLD E — RETRIEVE MEMORY CORE", dur: 24, pose: "reach",
          available: (s) => s.has("argo_core_offered") || s.has("argo_left"),
          onDone: (s, ctx) => {
            ctx.rover.battery = Math.max(60, ctx.rover.battery - 144);
            s.setFlag("argo_core");
            s.saySeq([
              ["SYS", "Core's out. Connector's… it's clean. It's clean, Voss."],
              ["FD", "Reading it now. Decoding takes a while — the logs will come through as we get them."],
            ]);
          },
        },
      },
      {
        id: "meteorite", title: "IRON METEORITE", x: L.lander.x - 680, z: L.lander.z - 360, r: 45, kind: "scan",
        prop: (g) => this.propMeteorite(g),
        onDiscover: (s) => s.say("GEO", "Stop. That rock is the wrong color for this floor. Metallic sheen, regmaglypts — scan it."),
        action: {
          label: "HOLD E — SCAN METEORITE", dur: 6, pose: "reach",
          onDone: (s, ctx) => {
            s.setFlag("meteorite");
            s.say("GEO", "Iron-nickel. A meteorite sitting on Mars — it fell here. We name these after whoever finds them. You found it.");
            ctx.science({ name: "IRON-NICKEL METEORITE", flavor: "Kamacite/taenite alloy with regmaglypts. Extraterrestrial to Mars itself.", comp: [["Fe", 91], ["Ni", 7], ["Co", 1], ["S", 1]] });
          },
        },
      },
      {
        id: "ventifacts", title: "VENTIFACT GARDEN", x: L.lander.x - 20, z: L.lander.z + 560, r: 60, kind: "find",
        prop: (g) => this.propVentifacts(g),
        onDiscover: (s) => s.say("GEO", "Ventifacts — wind-carved, all faceted on the same side. They're a compass for the prevailing wind over the last million years."),
      },
      {
        id: "hematite", title: "HEMATITE SPHERULES", x: L.lander.x + 520, z: L.lander.z + 820, r: 55, kind: "scan",
        prop: (g) => this.propSpherules(g),
        onDiscover: (s) => s.say("GEO", "Look at the ground. Spherules — little grey berries weathering out of the rock. Hematite concretions grow in groundwater. Scan one."),
        action: {
          label: "HOLD E — SCAN SPHERULES", dur: 6, pose: "reach",
          onDone: (s, ctx) => {
            s.setFlag("hematite");
            ctx.science({ name: "HEMATITE SPHERULES", flavor: "Concretions precipitated from groundwater in the pore space — water below the surface, long after the lake.", comp: [["Hematite", 62], ["SiO2", 22], ["FeOT", 9], ["Sulfates", 5]] });
          },
        },
      },
      {
        id: "kodiak", title: "KODIAK BUTTE", x: L.kodiak.x + 150, z: L.kodiak.z + 40, r: 70, kind: "view",
        onDiscover: (s) => s.say("GEO", "Kodiak. That's a piece of the delta the erosion forgot — the same strata, standing alone on the floor. Photograph the layering on the north face."),
      },
      {
        id: "deltatop", title: "DELTA TOP", x: L.delta.apexX + 180, z: L.delta.apexZ + 60, r: 80, kind: "view",
        onDiscover: (s) => s.say("GEO", "You're standing on the delta. The river ran right where your wheels are, and the whole crater filled with water below you."),
      },
      {
        id: "argosite", title: "ARGO-1 LANDING SITE", x: L.argoSite.x, z: L.argoSite.z, r: 60, kind: "find", hintFlag: "argo_known",
        prop: (g) => this.propPlatform(g),
        onDiscover: (s) => s.saySeq([
          ["SYS", "Her platform. The solar cells on the petals are still… God, look at the dust on them."],
          ["FD", "This is where the tracks start. Twelve years old and the wind hasn't finished with them."],
        ]),
      },
      {
        id: "cache", title: "ARGO SAMPLE CACHE", x: L.argoSite.x - 60, z: L.argoSite.z + 45, r: 40, kind: "retrieve", hintFlag: "argo_known",
        prop: (g) => this.propCache(g),
        onDiscover: (s) => s.say("GEO", "She cached tubes here before she left the plateau. Three of them. If they're intact, they're going home with ours."),
        action: {
          label: "HOLD E — RECOVER ARGO'S TUBES", dur: 14, pose: "reach",
          onDone: (s, ctx) => {
            s.setFlag("argo_cache");
            for (const n of ["ARGO plateau basalt", "ARGO terrace carbonate", "ARGO regolith"]) if (s.tubes.length < 10) s.tubes.push({ name: n, from: "ARGO-1" });
            s.say("SYS", "Three tubes, seals intact. She did her job. Every bit of it.");
          },
        },
      },
      {
        id: "skylight", title: "LAVA-TUBE SKYLIGHT", x: L.skylight.x + 55, z: L.skylight.z, r: 70, kind: "photo",
        onDiscover: (s) => s.saySeq([
          ["GEO", "Skylight. That's a collapsed roof over a lava tube — a cave. If there's anywhere on Mars something could hide from the radiation, it's down there."],
          ["FD", "We are NOT going down there. Photograph it from the edge. That's a paper on its own."],
        ]),
        action: {
          label: "HOLD E — IMAGE THE PIT", dur: 5, pose: "stowed",
          onDone: (s) => { s.setFlag("skylight"); s.say("GEO", "Twenty-plus meters straight down, and the floor keeps going sideways. Someone will walk in there one day."); },
        },
      },
      {
        id: "shore", title: "SHORELINE TERRACES", x: L.shore.x + 410, z: L.shore.z + 20, r: 60, kind: "scan",
        onDiscover: (s) => s.say("GEO", "Terraces. Three of them, stepping down — those are old shorelines. There was a lake up here too. Scan the tread."),
        action: {
          label: "HOLD E — SCAN THE TERRACE", dur: 7, pose: "reach",
          onDone: (s, ctx) => {
            s.setFlag("shore_carbonates");
            s.say("GEO", "Carbonates along the terrace. Two lakes, one river. This crater and this basin were connected.");
            ctx.science({ name: "TERRACE CARBONATE", flavor: "Mg-carbonate cementing beach sands. Shoreline precipitate from an alkaline plateau lake.", comp: [["Carbonate", 38], ["SiO2", 30], ["MgO", 12], ["FeOT", 9], ["Olivine", 6]] });
          },
        },
      },
      {
        id: "mesa", title: "MESA VERITY", x: L.mesas[0].x + 230, z: L.mesas[0].z, r: 70, kind: "view",
        onDiscover: (s) => s.say("GEO", "Flat top, layered flanks — a mesa. What's left after the plateau around it eroded away. That top was once the ground everywhere."),
      },
      {
        id: "sentinel", title: "THE SENTINEL", x: L.lander.x + 30, z: L.lander.z + 1250, r: 45, kind: "find",
        prop: (g) => this.propSentinel(g),
        onDiscover: (s) => s.saySeq([
          ["SYS", "Uh. That rock is very rectangular."],
          ["GEO", "Jointed basalt. It's a rock, Reyes."],
          ["SYS", "It's a very rectangular rock."],
        ]),
      },
    ];
  }

  // ------------------------------------------------------------- building
  build(renderer) {
    const T = this.terrain;
    for (const p of this.list) {
      p.discovered = false; p.done = false;
      if (!p.prop) continue;
      const g = new THREE.Group();
      const y = T.heightAt(p.x, p.z);
      g.position.set(p.x, y, p.z);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), T.normalAt(p.x, p.z, 2.5));
      p.prop(g);
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(g);
      p.obj = g;
    }
    this.bakeArgoTrail(renderer);
  }

  // ARGO-1's twelve-year-old wheel trail: platform -> canyon -> delta top ->
  // distributary channel -> floor -> the dunes. Faint, wind-softened.
  bakeArgoTrail(renderer) {
    const L = this.terrain.layout;
    const V = L.valley;
    const argo = this.list.find((p) => p.id === "argo");
    const pts = [
      [L.argoSite.x + 20, L.argoSite.z - 30],
      [V.bx - 60, V.bz + 40],
      [(V.ax + V.bx) / 2, (V.az + V.bz) / 2 + 20],
      [V.ax - 30, V.az + 10],
      [V.ax + 420, V.az - 90],
      [V.ax + 900, V.az - 250],
      [V.ax + 1200, V.az - 320],
      [argo.x - 260, argo.z - 60],
      [argo.x, argo.z],
    ];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const heading = Math.atan2(bx - ax, bz - az);
      const n = Math.floor(len / 0.6);
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const wob = Math.sin(t * 40 + i) * 3.5;
        const x = ax + (bx - ax) * t + Math.cos(heading) * wob;
        const z = az + (bz - az) * t - Math.sin(heading) * wob;
        const ox = Math.cos(heading) * 0.62, oz = -Math.sin(heading) * 0.62;
        this.terrain.splatTrack(x + ox, z + oz, heading, 0.34, 0.7, 0.22);
        this.terrain.splatTrack(x - ox, z - oz, heading, 0.34, 0.7, 0.22);
      }
    }
    this.terrain.flushTracks(renderer);
    this.argoTrail = pts;
  }
  nearArgoTrail(x, z) {
    for (let i = 0; i < this.argoTrail.length - 1; i++) {
      const [ax, az] = this.argoTrail[i], [bx, bz] = this.argoTrail[i + 1];
      if (distToSeg(x, z, ax, az, bx, bz) < 40) return true;
    }
    return false;
  }

  spawnImpact(x, z) {
    const T = this.terrain;
    // dark ejecta blanket + bright ice-bearing clasts
    for (let k = 0; k < 40; k++) {
      const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 26;
      T.splatTrack(x + Math.cos(a) * r, z + Math.sin(a) * r, a, 2.6, 2.6, 0.55);
    }
    const g = new THREE.Group();
    g.position.set(x, T.heightAt(x, z), z);
    for (let k = 0; k < 9; k++) {
      const a = Math.random() * Math.PI * 2, r = 15 + Math.random() * 12;
      const px = Math.cos(a) * r, pz = Math.sin(a) * r;
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22 + Math.random() * 0.25, 1), M.ice);
      m.position.set(px, T.heightAt(x + px, z + pz) - g.position.y + 0.1, pz);
      m.castShadow = true;
      g.add(m);
    }
    this.group.add(g);
    const poi = {
      id: "impact", title: "FRESH IMPACT CRATER", x, z, r: 60, kind: "scan", discovered: false, done: false, obj: g,
      onDiscover: (s) => s.say("GEO", "Look at the ejecta — those bright clasts. That's not salt. Scan before the sun gets to them."),
      action: {
        label: "HOLD E — SCAN THE EJECTA", dur: 6, pose: "reach",
        onDone: (s, ctx) => {
          s.setFlag("ice");
          s.saySeq([["GEO", "Water ice. Subsurface ice, excavated last night, sublimating as we watch. There's a cryosphere under this floor."], ["FD", "Logged. That's the second headline."]]);
          ctx.science({ name: "IMPACT-EXPOSED ICE", flavor: "Excavated ground ice with entrained regolith. Fresh, sublimating; the floor hides a cryosphere.", comp: [["H2O ice", 54], ["Regolith", 38], ["Perchlorate", 4], ["Sulfates", 4]] });
        },
      },
    };
    this.list.push(poi);
    this.missions.customWaypoint = { x, z };
  }

  setTransitWindow(on) { this.transitWindow = on; }

  // ------------------------------------------------------------- runtime
  update(dt, rover, story) {
    const s = story;
    for (const p of this.list) {
      if (p.discovered) continue;
      const d = Math.hypot(p.x - rover.pos.x, p.z - rover.pos.z);
      if (d < p.r) {
        p.discovered = true;
        this.onDiscover(p, s);
      }
    }
    // ARGO's trail: noticed once, only after the debris made her real
    if (!s.has("tracks_seen") && s.has("argo_known") && this.nearArgoTrail(rover.pos.x, rover.pos.z)) {
      s.setFlag("tracks_seen");
      s.saySeq([
        ["GEO", "Those tracks aren't ours. Faint, wind-filled — and narrower. Smaller wheels."],
        ["FD", "ARGO's. Follow them if you want. The RTG isn't going to run out."],
      ]);
    }
  }
  onDiscover(p, s) {
    this.hud && this.hud.notify(`DISCOVERY — ${p.title}`, "task");
    p.onDiscover && p.onDiscover(s);
  }

  // contextual action for the instruments layer
  contextAction(rover, story) {
    if (Math.abs(rover.v) > 0.25) return null;
    for (const p of this.list) {
      if (!p.action || p.done) continue;
      if (p.action.available && !p.action.available(story)) continue;
      const d = Math.hypot(p.x - rover.pos.x, p.z - rover.pos.z);
      if (d < Math.min(p.r, 22)) return { type: "poi", label: p.action.label, poi: p };
    }
    return null;
  }
  complete(p, story, ctx) {
    p.done = true;
    p.action.onDone(story, ctx);
    this.hud && this.hud.notify(`${p.title} — complete`, "task");
  }

  markers(story) {
    return this.list.filter((p) => p.discovered || (p.hintFlag && story.has(p.hintFlag)))
      .map((p) => ({ x: p.x, z: p.z, title: p.title, discovered: p.discovered, done: p.done }));
  }
  discoveredCount() { return this.list.filter((p) => p.discovered).length; }

  saveData() { return { disc: this.list.filter((p) => p.discovered).map((p) => p.id), done: this.list.filter((p) => p.done).map((p) => p.id) }; }
  restore(d, story) {
    if (!d) return;
    for (const p of this.list) { p.discovered = d.disc?.includes(p.id) || false; p.done = d.done?.includes(p.id) || false; }
    const ev = story.events.impactSite;
    if (ev && !this.list.find((p) => p.id === "impact")) { this.spawnImpact(ev.x, ev.z); const ip = this.list.find((p) => p.id === "impact"); ip.discovered = d.disc?.includes("impact") || false; ip.done = d.done?.includes("impact") || false; }
  }

  // ---------------------------------------------------------------- props
  propParachute(g) {
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(5.5, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.canopy);
    canopy.scale.set(1.2, 0.28, 0.8);
    canopy.rotation.z = 0.18;
    canopy.position.y = 0.05;
    g.add(canopy);
    for (let i = 0; i < 6; i++) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.1, 6.4), M.canopyStripe);
      stripe.position.set(0, 0.9, 0);
      stripe.rotation.y = (i / 6) * Math.PI;
      stripe.rotation.x = 0.12;
      stripe.scale.set(1, 0.3, 0.75);
      g.add(stripe);
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const line = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 9, 4), M.post);
      line.position.set(Math.cos(a) * 3 - 5, 0.15, Math.sin(a) * 2);
      line.rotation.z = Math.PI / 2 + 0.05;
      g.add(line);
    }
    const bridle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.5), MATS.dark);
    bridle.position.set(-10, 0.15, 0);
    g.add(bridle);
  }
  propBackshell(g) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.2, 1.7, 18, 1, true), M.shell);
    cone.material = M.shell.clone(); cone.material.side = THREE.DoubleSide;
    cone.rotation.set(2.6, 0.4, 0.3);
    cone.position.y = 0.6;
    g.add(cone);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.08, 6, 24), MATS.strut);
    ring.rotation.set(1.0, 0.4, 0.3);
    ring.position.set(0.1, 0.5, 0.2);
    g.add(ring);
  }
  propHeatShield(g) {
    const dish = new THREE.Mesh(new THREE.SphereGeometry(2.4, 20, 8, 0, Math.PI * 2, 0, 0.75), M.shield);
    dish.material = M.shield.clone(); dish.material.side = THREE.DoubleSide;
    dish.scale.y = 0.55;
    dish.rotation.set(0.25, 0, 0.15);
    dish.position.y = 0.35;
    g.add(dish);
  }
  propArgo(g) {
    // MER-class rover: body, wide solar wings, mast, 6 small wheels; tilted
    // into the sand with the downhill side buried
    const r = new THREE.Group();
    r.rotation.set(0.32, 0.9, -0.12);
    r.position.y = -0.22;
    g.add(r);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 1.2), M.argoBody);
    body.position.y = 0.5;
    r.add(body);
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.05, 1.5), M.argoPanelDust);
      wing.position.set(side * 1.15, 0.78, 0);
      wing.rotation.z = side * 0.08;
      r.add(wing);
      const cells = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.052, 1.4), M.argoPanel);
      cells.position.set(side * 1.15, 0.79, 0);
      cells.rotation.z = side * 0.08;
      cells.material = M.argoPanel.clone(); cells.material.opacity = 0.35; cells.material.transparent = true;
      r.add(cells);
    }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 1.4), M.argoPanelDust);
    deck.position.y = 0.78; r.add(deck);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.2, 8), M.argoBody);
    mast.position.set(-0.3, 1.35, 0.35); r.add(mast);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.14), M.argoBody);
    head.position.set(-0.3, 1.98, 0.35); r.add(head);
    const wheelGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.16, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    for (const side of [-1, 1]) for (const z of [0.55, 0, -0.55]) {
      const w = new THREE.Mesh(wheelGeo, MATS.wheelIn);
      w.position.set(side * 0.72, 0.14, z);
      r.add(w);
    }
    // sand drift banked against the downhill side
    const drift = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 8), dusty(0x7a4e33, 1));
    drift.scale.set(1.4, 0.35, 1.1);
    drift.position.set(0.9, -0.05, 0.2);
    g.add(drift);
  }
  propPlatform(g) {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, 0.4, 6), MATS.body);
    base.position.y = 0.3; g.add(base);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const petal = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 1.2), M.argoPanelDust);
      petal.position.set(Math.cos(a) * 1.6, 0.12, Math.sin(a) * 1.6);
      petal.rotation.y = -a;
      petal.rotation.z = 0.06;
      g.add(petal);
      const cells = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.062, 1.1), M.argoPanel);
      cells.position.copy(petal.position); cells.position.y += 0.005; cells.rotation.copy(petal.rotation);
      cells.material = M.argoPanel.clone(); cells.material.transparent = true; cells.material.opacity = 0.3;
      g.add(cells);
    }
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 1.8), MATS.strut);
    ramp.position.set(0, 0.28, 1.9); ramp.rotation.x = 0.3; g.add(ramp);
  }
  propCache(g) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.25, 1.0), dusty(0x4a3528, 0.9));
    slab.position.y = 0.12; slab.rotation.y = 0.4; g.add(slab);
    for (let i = 0; i < 3; i++) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 8), M.tube);
      t.position.set(-0.3 + i * 0.3, 0.33, 0.1);
      t.rotation.z = Math.PI / 2 + (i - 1) * 0.15;
      g.add(t);
    }
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.1, 6), M.post);
    post.position.set(0.8, 0.55, -0.4); g.add(post);
    const tag = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.01), M.canopyStripe);
    tag.position.set(0.8, 1.02, -0.4); g.add(tag);
  }
  propMeteorite(g) {
    const geo = new THREE.IcosahedronGeometry(0.62, 2);
    const p = geo.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      v.multiplyScalar(0.85 + 0.25 * Math.abs(Math.sin(v.x * 7.1 + v.y * 5.3) * Math.cos(v.z * 6.7)));
      p.setXYZ(i, v.x, v.y * 0.8, v.z);
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, M.meteorite);
    m.position.y = 0.32;
    g.add(m);
  }
  propVentifacts(g) {
    for (let i = 0; i < 14; i++) {
      const s = 0.5 + Math.random() * 1.2;
      const rock = new THREE.Mesh(new THREE.BoxGeometry(s * 2.2, s * 0.7, s * 0.9), dusty(0x4e3a2a, 0.9));
      const a = Math.random() * Math.PI * 2, d = 4 + Math.random() * 30;
      rock.position.set(Math.cos(a) * d, s * 0.2, Math.sin(a) * d);
      rock.rotation.y = 0.55 + (Math.random() - 0.5) * 0.2; // aligned to the wind
      rock.rotation.z = -0.25;
      g.add(rock);
    }
  }
  propSpherules(g) {
    const geo = new THREE.SphereGeometry(0.05, 8, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x5d5a60, roughness: 0.5, metalness: 0.2 });
    const inst = new THREE.InstancedMesh(geo, mat, 400);
    const d = new THREE.Object3D();
    for (let i = 0; i < 400; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 28;
      d.position.set(Math.cos(a) * r, 0.03, Math.sin(a) * r);
      d.scale.setScalar(0.6 + Math.random() * 0.9);
      d.updateMatrix();
      inst.setMatrixAt(i, d.matrix);
    }
    g.add(inst);
  }
  propSentinel(g) {
    const rock = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.6, 0.9), dusty(0x3e2e22, 0.85));
    rock.position.y = 1.2; rock.rotation.y = 0.3; rock.rotation.z = 0.05;
    g.add(rock);
  }
}
