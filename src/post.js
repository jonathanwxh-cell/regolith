// Post chain: render -> bloom -> film grade (grain, vignette, chromatic
// aberration, storm lens-dust, hazcam mono) -> SMAA.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGrain: { value: 0.045 },
    uVignette: { value: 0.34 },
    uCA: { value: 0.0016 },
    uDust: { value: 0 },
    uMono: { value: 0 },
    uContrast: { value: 1.045 },
    uLift: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVignette, uCA, uDust, uMono, uContrast, uLift;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uTime * 17.7) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec2 fromC = uv - 0.5;
      float r2 = dot(fromC, fromC);
      // chromatic aberration (radial)
      float ca = uCA * (0.4 + r2 * 3.2);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + fromC * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - fromC * ca).b;
      // storm lens dust: soft blotches
      if (uDust > 0.01) {
        float d1 = smoothstep(0.35, 0.0, length(uv - vec2(0.23, 0.72)));
        float d2 = smoothstep(0.3, 0.0, length(uv - vec2(0.78, 0.28)));
        float d3 = smoothstep(0.42, 0.0, length(uv - vec2(0.6, 0.85)));
        col = mix(col, vec3(0.42, 0.31, 0.22), (d1 * 0.16 + d2 * 0.12 + d3 * 0.1) * uDust);
      }
      // grade
      col = (col - 0.5) * uContrast + 0.5 + uLift;
      // mono (hazcam)
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(lum) * vec3(1.02, 1.0, 0.96), uMono);
      // vignette
      float vig = 1.0 - uVignette * smoothstep(0.12, 0.72, r2);
      col *= vig;
      // grain
      float g = (hash(uv * vec2(1920.0, 1080.0)) - 0.5) * uGrain * (0.5 + 0.5 * (1.0 - lum));
      col += g;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.enabled = true;
    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.6, 0.82);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);
    this.scene = scene;
    this.camera = camera;
  }
  setCamera(camera) {
    this.renderPass.camera = camera;
  }
  setSize(w, h, pr) {
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(pr);
  }
  render(dt, opts) {
    const u = this.grade.uniforms;
    u.uTime.value = (u.uTime.value + dt) % 1000;
    u.uDust.value = opts.storm * 0.9;
    u.uMono.value = opts.mono ? 1 : 0;
    u.uGrain.value = opts.mono ? 0.09 : 0.042;
    this.bloom.strength = 0.22 + opts.duskF * 0.16 + opts.nightF * 0.22;
    if (this.enabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
