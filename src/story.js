// Story engine: named ops voices, the ARGO-1 arc, choices, sample tubes,
// world events (impact, Phobos transit, solar conjunction, global storm) and
// composed endings. Beats are declarative: a `when` predicate over game state,
// lines delivered through the comms panel with pacing, optional [1]/[2]
// choice, flags persisted in the save.
import { clamp } from "./noise.js";

export const CHARS = {
  FD: { name: "VOSS", role: "FLIGHT", color: "#ffb86b" },
  GEO: { name: "OKAFOR", role: "GEOLOGY", color: "#86d67c" },
  SYS: { name: "REYES", role: "SYSTEMS", color: "#7dd3fc" },
  ARGO: { name: "ARGO-1", role: "RECOVERED LOG", color: "#c9a0ff" },
  OPS: { name: "OPS", role: "AUTO", color: "#e8dcc8" },
};

export const MAX_TUBES = 10;

// ARGO-1's recovered logs: uplinks its own ops team sent it, sol by sol,
// during the global storm that killed it. Unlocked one at a time after the
// memory core is retrieved.
const ARGO_LOGS = [
  { sol: 412, text: "ARGO, Meridian. Good morning. Plateau survey's complete and you are GO for the inlet descent. Take the ramp slow, she's steep at the mouth. Proud of you. — R.K." },
  { sol: 440, text: "You made the floor. First wheels in this crater. Our geologist says the delta front is the whole reason we came. Mine too. Mine too." },
  { sol: 517, text: "Tau's climbing across the whole hemisphere. Storm season. We're steering you toward the dunes — sand holds heat overnight. Array output sixty-two percent. Fine. It's fine." },
  { sol: 528, text: "Tau four point one. Array eighteen percent. We've cut heaters to the mast and the arm. Just keep the core warm. Stay with us." },
  { sol: 531, text: "No downlink for two sols. If any of this is reaching you: wake at dawn, point the array at the sun, and wait. We're here. We're not going anywhere." },
  { sol: 560, text: "Still calling. Every day. The storm's clearing now. The models say your batteries are past recovery. Nobody here is listening to the models." },
  { sol: 604, text: "ARGO-1, final uplink. Meridian Ops is standing down. You saw a river delta on Mars with your own eyes, and you sent it home. Thank you. Goodnight. — R.K. and everyone." },
];

export class Story {
  constructor(hud, missions) {
    this.hud = hud;
    this.missions = missions;
    this.flags = {};
    this.fired = new Set();
    this.queue = [];          // pending lines
    this.speaking = null;     // line currently being typed
    this.speakT = 0;
    this.gap = 0;
    this.pendingChoice = null;
    this.tubes = [];          // sealed samples [{name, from}]
    this.argoLogsShown = 0;
    this.argoLogClock = 0;
    this.commsBlackout = false;
    this.pendingSample = null;
    this.tick = 0;
    this.events = new WorldEvents(this);
    this.beats = makeBeats();
  }

  // ---------------------------------------------------------------- output
  say(who, text, opts = {}) {
    this.queue.push({ who, text, ...opts });
  }
  saySeq(lines, opts = {}) { for (const [who, text] of lines) this.say(who, text, opts); }
  setFlag(k, v = true) { this.flags[k] = v; }
  has(k) { return !!this.flags[k]; }

  offerChoice(prompt, a, b, onA, onB) {
    this.queue.push({ choice: { prompt, a, b, onA, onB } });
  }
  choose(n) {
    const c = this.pendingChoice;
    if (!c) return false;
    this.pendingChoice = null;
    this.hud.hideChoice();
    if (n === 1) c.onA(); else c.onB();
    return true;
  }

  // sample-tube flow: called by instruments after any science result
  offerSample(name, from, ctx) {
    if (this.tubes.length >= MAX_TUBES) {
      this.say("SYS", `${name} — no tubes left. We seal what we've got.`);
      return;
    }
    const left = MAX_TUBES - this.tubes.length;
    this.offerChoice(`SEAL A SAMPLE TUBE? "${name}" (${left} tube${left === 1 ? "" : "s"} left)`, "SEAL IT", "LEAVE IT",
      () => {
        // Re-check at answer time: two offers can queue up behind one pending
        // choice, and both were sized against the same stale tube count.
        if (this.tubes.length >= MAX_TUBES) {
          this.say("SYS", `${name} — no tubes left. We seal what we've got.`);
          return;
        }
        this.tubes.push({ name, from });
        this.say("SYS", `Tube ${this.tubes.length} sealed: ${name}. ${MAX_TUBES - this.tubes.length} remaining.`);
        ctx.audio.confirm();
      },
      () => { this.say("GEO", `Logged, not sealed. ${name} stays where it is.`); });
  }

  // ------------------------------------------------------------------ tick
  update(dt, ctx) {
    this.tick += dt;
    // deliver lines with pacing (typewriter handled by HUD)
    if (this.speaking) {
      this.speakT += dt;
      const done = this.speakT > this.speaking.text.length / 34 + 1.4;
      if (done) { this.speaking = null; this.gap = 0.7; }
    } else if (this.gap > 0) {
      this.gap -= dt;
    } else if (!this.pendingChoice && this.queue.length) {
      const item = this.queue.shift();
      if (item.choice) {
        this.pendingChoice = item.choice;
        this.hud.showChoice(item.choice);
      } else if (this.commsBlackout && !item.always && item.who !== "ARGO" && item.who !== "OPS") {
        // Earth can't hear us — the line is lost to the sun
      } else {
        this.speaking = item;
        this.speakT = 0;
        this.hud.commsLine(CHARS[item.who], item.text);
        this.hud.pushLog(this.missions, `[${CHARS[item.who].name}] ${item.text}`);
        ctx.audio.radio();
      }
    }

    // beats
    if (this.tick - (this._lastEval || 0) > 0.5) {
      this._lastEval = this.tick;
      for (const b of this.beats) {
        if (this.fired.has(b.id)) continue;
        if (b.when(ctx, this)) {
          this.fired.add(b.id);
          b.run(ctx, this);
        }
      }
    }

    // ARGO logs unlock over time once the core is home
    if (this.has("argo_core") && this.argoLogsShown < ARGO_LOGS.length) {
      this.argoLogClock += dt;
      const interval = this.argoLogsShown === 0 ? 8 : 200;
      if (this.argoLogClock > interval && !this.speaking && this.queue.length === 0) {
        this.argoLogClock = 0;
        const log = ARGO_LOGS[this.argoLogsShown++];
        this.say("ARGO", `[SOL ${log.sol}] ${log.text}`);
        ctx.music.cue && ctx.music.cue("ghost", 45);
        if (this.argoLogsShown === 3) this.say("SYS", "…solar. She was solar. Every one of those logs is someone watching a number fall.");
        if (this.argoLogsShown === 5) this.say("GEO", "They kept sending. Two sols of nothing and they kept sending.");
        if (this.argoLogsShown === ARGO_LOGS.length) {
          this.say("GEO", "…Voss?");
          this.say("FD", "I know. Keep driving.");
          this.setFlag("argo_logs_done");
        }
      }
    }

    this.events.update(dt, ctx);
  }

  // ------------------------------------------------------------------ save
  saveData() {
    return {
      flags: this.flags, fired: [...this.fired], tubes: this.tubes,
      argoLogsShown: this.argoLogsShown, events: this.events.saveData(),
      commsBlackout: this.commsBlackout,
    };
  }
  restore(d) {
    if (!d) return;
    this.flags = d.flags || {};
    this.fired = new Set(d.fired || []);
    this.tubes = d.tubes || [];
    this.argoLogsShown = d.argoLogsShown || 0;
    this.events.restore(d.events);
    // Blackout is a paired HUD state — restoring the flag without the banner
    // leaves the player silently cut off with no on-screen reason.
    this.commsBlackout = !!d.commsBlackout;
    if (this.hud) this.hud.setBlackout(this.commsBlackout);
  }

  // --------------------------------------------------------------- ending
  ending(ctx) {
    const L = [];
    L.push(["FD", "Package received on Earth. Survey complete. REGOLITH, that's a clean campaign."]);
    if (this.has("organics")) L.push(["GEO", "And the delta laminae go into every headline on the planet. Organics candidate, in place, in a lake bed. I'm allowed to be excited now."]);
    if (this.has("shore_carbonates")) L.push(["GEO", "Carbonates on the plateau terraces too. Two lakes, one river. This whole region was wet, and connected."]);
    if (this.has("ice")) L.push(["SYS", "And ice in that fresh crater. You could drink this place, if you were quick."]);
    if (this.has("meteorite")) L.push(["GEO", "The meteorite's named after you, by the way. Committee's a formality."]);
    if (this.has("argo_core")) {
      L.push(["FD", "One more thing went up in that package. ARGO-1's logs — all of them. Her team is getting a phone call tonight."]);
      L.push(["SYS", "Twelve years late. Still counts."]);
    } else if (this.has("argo_known")) {
      L.push(["FD", "ARGO's still out there in the sand. Someone else's problem now. Or yours — the survey's done, the rover isn't."]);
    }
    if (this.tubes.length) L.push(["GEO", `${this.tubes.length} tube${this.tubes.length === 1 ? "" : "s"} sealed for return: ${this.tubes.map((t) => t.name).join(", ")}.`]);
    L.push(["FD", "The quad is yours. Keep driving."]);
    // `always`: the finale must never be swallowed by a comms blackout — the
    // end screen would otherwise arrive in total silence.
    this.saySeq(L, { always: true });
    this.setFlag("ending_done");
  }
}

// ---------------------------------------------------------------- beats
function makeBeats() {
  const B = [];
  const beat = (id, when, run) => B.push({ id, when, run });

  beat("intro", (c) => c.newGame && c.elapsed > 2, (c, s) => {
    s.saySeq([
      ["FD", "REGOLITH, Voss. Touchdown confirmed, sol one. Checkout first. Wonder later."],
      ["GEO", "I already have wonder. Look at the light on that delta."],
      ["SYS", "RTG's at a hundred and ten watts, battery ninety percent. She's warm. Don't spend it all today."],
    ]);
  });
  beat("first_drive", (c) => c.rover.odometer > 15, (c, s) => {
    s.say("SYS", "Six wheels turning. Tracks look clean. Tilt ball's honest.");
  });
  beat("halo_seen", (c) => c.dist(c.layout.halo) < 240, (c, s) => {
    s.say("GEO", "That's Halo. Fresh — see the ray pattern on the ejecta? Rim blocks will be deep crust, unweathered.");
  });
  beat("argo_hint", (c) => c.missions.idx >= 2, (c, s) => {
    s.say("FD", "One more thing. Orbital flagged a bright object north-east of Halo's rim. Not ours. Not on any manifest. Have a look if the power's there.");
    s.setFlag("argo_hint");
  });
  beat("night_first", (c) => c.sky.nightF > 0.6 && c.elapsed > 60, (c, s) => {
    s.saySeq([
      ["SYS", "Sun's down. Heaters are pulling eighty-five watts against minus eighty. The RTG doesn't care, but the battery will by morning."],
      ["FD", "Drive if you must. Park if you can."],
    ]);
  });
  beat("battery_low", (c) => c.rover.battery / c.rover.batteryCap < 0.2, (c, s) => {
    s.say("SYS", "Twenty percent. That's my line, not yours. Hold T and let the RTG do its job.");
  });
  beat("sand_first", (c) => c.rover.slipping && c.rover.odometer > 100, (c, s) => {
    s.say("GEO", "You're in Séítah. Keep the momentum up and stay off the lee faces — that's the side that swallows wheels.");
  });
  beat("delta_science", (c) => c.missions.taskDoneById("M4", "drill"), (c, s) => {
    s.saySeq([
      ["GEO", "There's a signal in the SHERLOC scan I'm not supposed to say out loud on an open loop. Aromatic. Concentrated in the laminae. I'm going to say 'organics candidate' and be very, very calm."],
      ["FD", "Be calm somewhere else, Okafor. It's logged."],
    ]);
    s.setFlag("organics");
  });
  beat("valley_climb", (c) => c.terrain.inValley(c.rover.pos.x, c.rover.pos.z) && c.rover.pos.x < c.layout.valley.ax - 300, (c, s) => {
    s.saySeq([
      ["FD", "You're in the inlet. That's the river's own road up through the wall."],
      ["GEO", "Nobody's driven this canyon since ARGO drove DOWN it."],
    ]);
  });
  beat("plateau_first", (c) => c.terrain.onPlateau(c.rover.pos.x, c.rover.pos.z), (c, s) => {
    s.saySeq([
      ["FD", "You're above the rim. Turn around."],
      ["GEO", "Look back at it. The whole crater. Take the photo — that's the one that ends up on the wall."],
    ]);
    s.setFlag("plateau");
  });
  beat("bench_view", (c) => c.missions.idx >= 5, (c, s) => {
    s.say("GEO", "From the bench you can see the inlet canyon on the west wall. It goes all the way up. If you ever wanted to know where ARGO came from…");
  });
  beat("global_storm_warn", (c) => c.missions.idx >= 5 && c.elapsed > 900, (c, s) => {
    s.saySeq([
      ["SYS", "Tau's spiking across the whole hemisphere. This is the big one, not a regional. RTG doesn't care. Visibility will."],
      ["FD", "Park if you can't see. It passes. It always passes. Eventually."],
    ]);
    s.events.scheduleGlobalStorm(60);
  });
  return B;
}

// ------------------------------------------------------------ world events
class WorldEvents {
  constructor(story) {
    this.story = story;
    this.done = {};
    this.globalStormAt = null;
    this.transitState = "idle";
    this.transitT = 0;
    this.conjunction = null; // {start, end} in sol-seconds elapsed
    this.impactSite = null;
  }
  // In-flight event state must persist too. Without `conjunction`, a reload
  // after M6 re-arms the blackout every single time; without `globalStormAt`,
  // a reload inside the warning window loses the storm for good (its beat has
  // already fired, so nothing reschedules it).
  saveData() {
    return {
      done: this.done, impactSite: this.impactSite, conjunction: this.conjunction,
      globalStormAt: this.globalStormAt, transitState: this.transitState,
    };
  }
  restore(d) {
    if (!d) return;
    this.done = d.done || {};
    this.impactSite = d.impactSite || null;
    this.conjunction = d.conjunction || null;
    this.globalStormAt = d.globalStormAt ?? null;
    // A transit interrupted mid-flight resumes from "announced": the sun-disc
    // override lives on Sky and is not restored, so never resume in "active".
    this.transitState = d.transitState === "active" ? "announced" : (d.transitState || "idle");
  }
  scheduleGlobalStorm(inSec) { if (!this.done.globalStorm) this.globalStormAt = inSec; }

  update(dt, c) {
    const s = this.story;
    // --- meteorite impact: the night after M2, punch a fresh crater 1.5-2.4 km
    //     off, in the crater floor, and send the player to it
    if (!this.done.impact && c.missions.idx >= 2 && c.sky.nightF > 0.5 && c.elapsed > 120) {
      this.done.impact = true;
      const L = c.layout;
      // The old loop fell out at 60 tries and used the last candidate WITHOUT
      // re-testing it, so an unlucky draw could put the objective on the rim
      // wall or in a dune trap. Validate, and fall back to guaranteed-reachable
      // ground rather than shipping an unreachable waypoint.
      const okSite = (px, pz) => c.terrain.inCrater(px, pz) && c.terrain.isPlayable(px, pz) &&
        Math.hypot(px - L.lander.x, pz - L.lander.z) > 200 &&
        c.terrain.maskAtRaw(px, pz, 0) < 0.1 && !c.terrain.inDuneBand(px, pz);
      let x = 0, z = 0, ok = false;
      for (let tries = 0; tries < 60 && !ok; tries++) {
        const a = Math.random() * Math.PI * 2, d = 1500 + Math.random() * 900;
        x = c.rover.pos.x + Math.cos(a) * d; z = c.rover.pos.z + Math.sin(a) * d;
        ok = okSite(x, z);
      }
      if (!ok) {
        for (let tries = 0; tries < 200 && !ok; tries++) {
          const a = Math.random() * Math.PI * 2, d = 300 + Math.random() * 1200;
          x = L.playa.x + Math.cos(a) * d; z = L.playa.z + Math.sin(a) * d;
          ok = okSite(x, z);
        }
        if (!ok) { x = L.playa.x; z = L.playa.z; }   // last resort: open floor
      }
      c.terrain.punchCrater(x, z, 18);
      this.impactSite = { x, z };
      c.pois.spawnImpact(x, z);
      c.missions.customWaypoint = { x, z };   // "Waypoint's on your map" — only on the real event
      const bearing = ((Math.atan2(x - c.rover.pos.x, z - c.rover.pos.z) * 180 / Math.PI) + 360) % 360;
      const range = Math.hypot(x - c.rover.pos.x, z - c.rover.pos.z);
      s.say("OPS", `IMPACT FLASH detected ${c.sky.lmst()} LMST — bearing ${bearing.toFixed(0)}°, range ${(range / 1000).toFixed(1)} km. Seismic confirm.`);
      s.saySeq([
        ["GEO", "A new crater. Tonight. Nature just cored the floor for us — and fresh ejecta can hold ice for a few sols before it sublimates."],
        ["FD", "Waypoint's on your map. Go when it's light."],
      ]);
      c.audio.warn();
      c.rig.addShake(0.6);
      c.hud.rebakeSoon();
    }
    // --- Phobos transit of the sun: announced at 14:00 on any sol >= 2 (once)
    if (!this.done.transit && c.sky.sol >= 2) {
      const f = c.sky.tSec / 88775;
      if (this.transitState === "idle" && f > 14.0 / 24.66 && f < 14.15 / 24.66) {
        this.transitState = "announced";
        s.say("GEO", "Phobos transits the sun in twenty minutes. Forty seconds of it, no more. Mastcam, aim at the sun — the solar filter's automatic. Don't miss it.");
        c.pois.setTransitWindow(true);
      }
      if (this.transitState === "announced" && f > 14.33 / 24.66) {
        this.transitState = "active";
        c.sky.forceTransit = true;
        this.transitT = 0;
        s.say("OPS", "TRANSIT IN PROGRESS.");
      }
      if (this.transitState === "active") {
        this.transitT += dt;
        if (this.transitT > 42) {
          this.transitState = "over";
          this.done.transit = true;
          c.sky.forceTransit = false;
          c.pois.setTransitWindow(false);
          s.say("GEO", s.has("transit") ? "Got it. A moon crossing a star, from the ground, on another world. Frame it." : "Missed it. There'll be another in a few sols — Phobos is a busy little moon.");
        }
      }
    }
    // --- solar conjunction: a sol of silence, once, after M6 starts
    if (!this.done.conjunction && c.missions.idx >= 6 && !this.conjunction) {
      this.conjunction = { start: c.elapsed + 40, end: c.elapsed + 40 + 88775 / c.sky.timeScale };
    }
    if (this.conjunction) {
      if (!s.commsBlackout && c.elapsed > this.conjunction.start && c.elapsed < this.conjunction.end) {
        s.saySeq([
          ["FD", "Solar conjunction. The sun's between us and you for a sol. No uplink, no downlink. You're on your own — autonomy rules apply."],
          ["SYS", "Watch your own battery. Nobody's going to nag you for twenty-five minutes."],
          ["FD", "See you on the other side."],
        ]);
        s.commsBlackout = true;
        c.hud.setBlackout(true);
      }
      if (s.commsBlackout && c.elapsed > this.conjunction.end) {
        s.commsBlackout = false;
        this.done.conjunction = true;
        c.hud.setBlackout(false);
        s.saySeq([
          ["FD", "REGOLITH, Voss. …You're still there. Good."],
          ["SYS", "Battery's higher than when we left. Show-off."],
        ]);
      }
    }
    // --- global dust storm (long, deep), scheduled by its warning beat
    if (this.globalStormAt !== null) {
      this.globalStormAt -= dt;
      if (this.globalStormAt <= 0) {
        this.globalStormAt = null;
        this.done.globalStorm = true;
        c.sky.storm.phase = "active";
        c.sky.storm.t = 0;
        c.sky.storm.dur = 720; // 12 real minutes
        c.sky.storm.intensity = 0.2;
        s.say("OPS", "GLOBAL DUST EVENT — optical depth rising. Expect near-zero visibility.");
      }
    }
  }
}

export function bearingTo(from, to) {
  return ((Math.atan2(to.x - from.x, to.z - from.z) * 180 / Math.PI) + 360) % 360;
}
export { ARGO_LOGS, clamp as _clamp };
