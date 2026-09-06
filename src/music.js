// Music: four MiniMax-generated ambient beds, crossfaded by context.
// Streams via HTMLAudioElement -> MediaElementAudioSourceNode into the shared
// AudioSys graph (its own bus, so music volume is independent of SFX).
//
// Tracks live in public/audio/ and are REGENERATABLE — see AGENTS.md "Music"
// for the exact generate_music prompts. Missing files fail silent: the game
// must run fine without them (dev checkouts, blocked audio, etc).
import { clamp } from "./noise.js";

const TRACKS = {
  title: "audio/beacon.mp3",   // quiet piano/strings main theme
  day: "audio/drift.mp3",      // warm sparse daylight ambient
  night: "audio/nocturne.mp3", // cold sub-drone night ambient
  storm: "audio/haze.mp3",     // tense rumble under the wind SFX
  ghost: "audio/ghost.mp3",    // degraded, lonely — ARGO-1's recovered logs
};
const FADE = 4.5;              // crossfade seconds
const HOLD = 3.0;              // context must be stable this long before switching
const LEVEL = { title: 0.5, day: 0.34, night: 0.3, storm: 0.26, ghost: 0.42 };

export class MusicSys {
  constructor(audio) {
    this.audio = audio;        // AudioSys — must be init()ed before start()
    this.volume = 0.6;
    this.tracks = {};          // name -> {el, node, gain, failed}
    this.current = null;
    this.pending = null;
    this.pendingT = 0;
    this.started = false;
    this.cueName = null;
    this.cueUntil = 0;
    this.clock = 0;
  }

  // temporarily override the context (story moments); falls back after `seconds`
  cue(name, seconds) {
    if (!TRACKS[name]) return;
    this.cueName = name;
    this.cueUntil = this.clock + seconds;
  }

  start() {
    if (this.started || !this.audio.ready) return;
    const ctx = this.audio.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = this.volume;
    this.bus.connect(this.audio.master);
    this.started = true;
  }

  setVolume(v) {
    this.volume = v;
    if (this.bus) this.bus.gain.setTargetAtTime(v, this.audio.ctx.currentTime, 0.1);
  }

  _track(name) {
    if (this.tracks[name]) return this.tracks[name];
    const el = new Audio(TRACKS[name]);
    el.loop = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    const t = { el, node: null, gain: null, failed: false };
    el.addEventListener("error", () => { t.failed = true; }, { once: true });
    this.tracks[name] = t;
    return t;
  }

  _ensureGraph(t) {
    if (t.node || t.failed || !this.started) return;
    const ctx = this.audio.ctx;
    t.node = ctx.createMediaElementSource(t.el);
    t.gain = ctx.createGain();
    t.gain.gain.value = 0;
    t.node.connect(t.gain);
    t.gain.connect(this.bus);
  }

  // desired context, evaluated by the caller each frame
  update(dt, desired) {
    this.clock += dt;
    if (!this.started) return;
    if (this.cueName) {
      if (this.clock < this.cueUntil && !(this.tracks[this.cueName] && this.tracks[this.cueName].failed)) desired = this.cueName;
      else this.cueName = null;
    }
    // hysteresis so dawn/dusk and storm edges don't flap the crossfade
    if (desired !== this.current) {
      this.pendingT = desired === this.pending ? this.pendingT + dt : 0;
      this.pending = desired;
      const immediate = this.current === null || this.current === "title" || desired === "title";
      if (this.pendingT >= (immediate ? 0 : HOLD)) this._switch(desired);
    } else {
      this.pending = null;
      this.pendingT = 0;
    }
    // pause anything fully faded out (stops streaming/decoding)
    for (const [name, t] of Object.entries(this.tracks)) {
      if (name !== this.current && t.el && !t.el.paused && t.gain && t.gain.gain.value < 0.004) {
        t.el.pause();
      }
    }
  }

  _switch(name) {
    const ctx = this.audio.ctx;
    const now = ctx.currentTime;
    const prev = this.current;
    this.current = name;
    this.pending = null;
    this.pendingT = 0;
    if (prev && this.tracks[prev] && this.tracks[prev].gain) {
      this.tracks[prev].gain.gain.setTargetAtTime(0, now, FADE / 3);
    }
    if (!name) return;
    const t = this._track(name);
    if (t.failed) return;
    this._ensureGraph(t);
    if (!t.gain) return;
    const play = t.el.play();
    if (play) play.catch(() => { t.failed = true; });
    t.gain.gain.setTargetAtTime(LEVEL[name] ?? 0.3, now, FADE / 3);
  }
}

// Pick the context for this frame from world state.
export function musicContext(mode, sky) {
  if (mode === "title") return "title";
  if (sky.storm.intensity > 0.45) return "storm";
  if (sky.nightF > 0.55) return "night";
  return "day";
}
