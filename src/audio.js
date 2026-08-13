// Procedural audio: filtered-noise wind with gusts, motor drive hum, drill,
// UI blips, scan sweep, radio chirps, storm alarm. Zero audio assets.
import { clamp } from "./noise.js";

export class AudioSys {
  constructor() {
    this.ready = false;
    this.muted = false;
    this.volume = 0.8;
  }

  init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // --- wind: white noise -> lowpass + bandpass, slowly modulated
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = noiseBuf;
    this.windSrc.loop = true;
    this.windLP = ctx.createBiquadFilter();
    this.windLP.type = "lowpass";
    this.windLP.frequency.value = 320;
    this.windBP = ctx.createBiquadFilter();
    this.windBP.type = "bandpass";
    this.windBP.frequency.value = 160;
    this.windBP.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0;
    this.windSrc.connect(this.windLP);
    this.windLP.connect(this.windBP);
    this.windBP.connect(this.windGain);
    this.windGain.connect(this.master);
    this.windSrc.start();

    // --- motor: two detuned saws through lowpass
    this.motorOsc1 = ctx.createOscillator();
    this.motorOsc1.type = "sawtooth";
    this.motorOsc2 = ctx.createOscillator();
    this.motorOsc2.type = "sawtooth";
    this.motorOsc2.detune.value = 9;
    this.motorLP = ctx.createBiquadFilter();
    this.motorLP.type = "lowpass";
    this.motorLP.frequency.value = 220;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    this.motorOsc1.connect(this.motorLP);
    this.motorOsc2.connect(this.motorLP);
    this.motorLP.connect(this.motorGain);
    this.motorGain.connect(this.master);
    this.motorOsc1.start(); this.motorOsc2.start();

    // --- drill: noise through highish bandpass, gated
    this.drillBP = ctx.createBiquadFilter();
    this.drillBP.type = "bandpass";
    this.drillBP.frequency.value = 900;
    this.drillBP.Q.value = 2.2;
    this.drillGain = ctx.createGain();
    this.drillGain.gain.value = 0;
    const drillSrc = ctx.createBufferSource();
    drillSrc.buffer = noiseBuf;
    drillSrc.loop = true;
    drillSrc.connect(this.drillBP);
    this.drillBP.connect(this.drillGain);
    this.drillGain.connect(this.master);
    drillSrc.start();

    // --- terrain rumble: regolith crunch under the wheels (noise -> low LP),
    // keyed to ground speed + suspension bump energy
    this.rumbleLP = ctx.createBiquadFilter();
    this.rumbleLP.type = "lowpass";
    this.rumbleLP.frequency.value = 180;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    const rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = noiseBuf;
    rumbleSrc.loop = true;
    rumbleSrc.playbackRate.value = 0.6;
    rumbleSrc.connect(this.rumbleLP);
    this.rumbleLP.connect(this.rumbleGain);
    this.rumbleGain.connect(this.master);
    rumbleSrc.start();

    // --- servo whine: mast/arm actuators
    this.servoOsc = ctx.createOscillator();
    this.servoOsc.type = "triangle";
    this.servoOsc.frequency.value = 430;
    this.servoGain = ctx.createGain();
    this.servoGain.gain.value = 0;
    this.servoOsc.connect(this.servoGain);
    this.servoGain.connect(this.master);
    this.servoOsc.start();

    this._thumpAt = 0;
    this.ready = true;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }
  setMuted(m) { this.muted = m; this.setVolume(this.volume); }

  update(dt, { wind, speed, slipping, drilling, storm, bump = 0, servo = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const windAmt = clamp((wind - 1.5) / 24, 0, 1);
    const g = 0.05 + windAmt * 0.5 + storm * 0.32;
    this.windGain.gain.setTargetAtTime(g * 0.55, t, 0.4);
    this.windLP.frequency.setTargetAtTime(240 + windAmt * 900 + storm * 700, t, 0.5);
    this.windBP.frequency.setTargetAtTime(120 + windAmt * 500 + Math.sin(t * 0.7) * 60, t, 0.6);

    const sp = clamp(Math.abs(speed) / 3.6, 0, 1);
    this.motorGain.gain.setTargetAtTime(sp > 0.02 ? 0.028 + sp * 0.06 : 0, t, 0.12);
    const f = 34 + sp * 60 + (slipping ? 22 : 0);
    this.motorOsc1.frequency.setTargetAtTime(f, t, 0.15);
    this.motorOsc2.frequency.setTargetAtTime(f * 1.503, t, 0.15);
    this.motorLP.frequency.setTargetAtTime(160 + sp * 320, t, 0.2);

    this.drillGain.gain.setTargetAtTime(drilling ? 0.09 : 0, t, 0.1);

    // regolith crunch: grows with speed, spikes with suspension activity
    const bumpAmt = clamp(bump * 2.2, 0, 1);
    const rg = sp > 0.02 ? sp * 0.05 + bumpAmt * 0.11 + (slipping ? 0.03 : 0) : 0;
    this.rumbleGain.gain.setTargetAtTime(rg, t, 0.12);
    this.rumbleLP.frequency.setTargetAtTime(140 + sp * 160 + bumpAmt * 240, t, 0.15);

    // hard suspension hit -> low thud (rate-limited)
    if (bumpAmt > 0.55 && sp > 0.1 && t - this._thumpAt > 0.18) {
      this._thumpAt = t;
      this.blip(64 + Math.random() * 22, 0.11, 0.1 + bumpAmt * 0.08, "sine");
    }

    // actuator whine while the arm or mast is moving
    this.servoGain.gain.setTargetAtTime(clamp(servo, 0, 1) * 0.016, t, 0.08);
    this.servoOsc.frequency.setTargetAtTime(390 + servo * 130 + Math.sin(t * 3.1) * 18, t, 0.1);
  }

  blip(freq = 880, dur = 0.07, vol = 0.12, type = "sine") {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  uiTick() { this.blip(1150, 0.045, 0.06); }
  uiBack() { this.blip(560, 0.05, 0.06); }
  confirm() { this.blip(880, 0.06, 0.09); setTimeout(() => this.blip(1320, 0.09, 0.09), 70); }
  warn() { this.blip(340, 0.14, 0.14, "square"); setTimeout(() => this.blip(340, 0.14, 0.12, "square"), 200); }
  radio() {
    this.blip(1567, 0.05, 0.07); setTimeout(() => this.blip(1245, 0.05, 0.07), 60);
    setTimeout(() => this.blip(1865, 0.08, 0.07), 130);
  }
  camShutter() { this.blip(2200, 0.03, 0.1, "triangle"); setTimeout(() => this.blip(1100, 0.03, 0.08, "triangle"), 40); }
  scanTone(f) { this.blip(500 + f * 900, 0.05, 0.05, "sine"); }
  uplinkSeq() {
    [0, 120, 240, 380, 520].forEach((ms, i) =>
      setTimeout(() => this.blip(740 + i * 180, 0.09, 0.08), ms));
  }
}
