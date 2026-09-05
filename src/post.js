// Post pipeline, self-contained (no EffectComposer):
//   scene -> MSAA RT -> [quarter-res bright+blur bloom] -> grade quad -> canvas
//
// History: the original EffectComposer chain (RenderPass + UnrealBloom +
// grade + SMAA) painted large dark ghost shards into the sky of the 4 km
// world. Bisecting exonerated every removable pass individually — the
// artifact rode the composer's own half-float buffer chain. This pipeline
// replaces it: an explicit UnsignedByte MSAA(4x) scene target (better edge AA
// than SMAA here), a two-tap separable bloom at quarter res, and one grade
// pass drawn straight to the canvas. Every input is clamped + NaN-killed.
import * as THREE from "three";

const SAN = /* glsl */`
  vec3 sanitize(vec3 c) {
    c = min(c, vec3(8.0));
    c = max(c, vec3(0.0));
    if (isnan(c.r + c.g + c.b)) c = vec3(0.0);
    return c;
  }
`;
const FS_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function fsMat(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms, fragmentShader, vertexShader: FS_VERT,
    depthTest: false, depthWrite: false,
  });
}

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

    this.sceneRT = new THREE.WebGLRenderTarget(2, 2, {
      samples: 4, depthBuffer: true,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    const q = { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.brightRT = new THREE.WebGLRenderTarget(2, 2, q);
    this.blurRT = new THREE.WebGLRenderTarget(2, 2, q);

    this.brightMat = fsMat(/* glsl */`
      uniform sampler2D tSrc;
      uniform float uThreshold;
      varying vec2 vUv;
      ${SAN}
      void main() {
        vec3 c = sanitize(texture2D(tSrc, vUv).rgb);
        float lum = dot(c, vec3(0.299, 0.587, 0.114));
        gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.35, lum), 1.0);
      }
    `, { tSrc: { value: null }, uThreshold: { value: 0.8 } });

    this.blurMat = fsMat(/* glsl */`
      uniform sampler2D tSrc;
      uniform vec2 uDir;
      uniform vec2 uTexel;
      varying vec2 vUv;
      ${SAN}
      void main() {
        vec2 s = uDir * uTexel;
        vec3 c = sanitize(texture2D(tSrc, vUv).rgb) * 0.227;
        c += sanitize(texture2D(tSrc, vUv + s * 1.385).rgb) * 0.316;
        c += sanitize(texture2D(tSrc, vUv - s * 1.385).rgb) * 0.316;
        c += sanitize(texture2D(tSrc, vUv + s * 3.231).rgb) * 0.070;
        c += sanitize(texture2D(tSrc, vUv - s * 3.231).rgb) * 0.070;
        gl_FragColor = vec4(c, 1.0);
      }
    `, { tSrc: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2(1 / 256, 1 / 256) } });

    this.gradeMat = fsMat(/* glsl */`
      uniform sampler2D tSrc;
      uniform sampler2D tBloom;
      uniform float uBloomStrength;
      uniform float uTime, uGrain, uVignette, uCA, uDust, uMono, uContrast;
      varying vec2 vUv;
      ${SAN}
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uTime * 17.7) * 43758.5453); }
      void main() {
        vec2 uv = vUv;
        vec2 fromC = uv - 0.5;
        float r2 = dot(fromC, fromC);
        float ca = uCA * (0.4 + r2 * 3.2);
        vec3 col;
        col.r = texture2D(tSrc, uv + fromC * ca).r;
        col.g = texture2D(tSrc, uv).g;
        col.b = texture2D(tSrc, uv - fromC * ca).b;
        col = sanitize(col);
        col += sanitize(texture2D(tBloom, uv).rgb) * uBloomStrength;
        if (uDust > 0.01) {
          float d1 = smoothstep(0.35, 0.0, length(uv - vec2(0.23, 0.72)));
          float d2 = smoothstep(0.3, 0.0, length(uv - vec2(0.78, 0.28)));
          float d3 = smoothstep(0.42, 0.0, length(uv - vec2(0.6, 0.85)));
          col = mix(col, vec3(0.42, 0.31, 0.22), (d1 * 0.16 + d2 * 0.12 + d3 * 0.1) * uDust);
        }
        col = (col - 0.5) * uContrast + 0.5;
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(lum) * vec3(1.02, 1.0, 0.96), uMono);
        col *= 1.0 - uVignette * smoothstep(0.12, 0.72, r2);
        col += (hash(uv * vec2(1920.0, 1080.0)) - 0.5) * uGrain * (0.5 + 0.5 * (1.0 - lum));
        gl_FragColor = vec4(col, 1.0);
      }
    `, {
      tSrc: { value: null }, tBloom: { value: null }, uBloomStrength: { value: 0.25 },
      uTime: { value: 0 }, uGrain: { value: 0.042 }, uVignette: { value: 0.34 },
      uCA: { value: 0.0016 }, uDust: { value: 0 }, uMono: { value: 0 }, uContrast: { value: 1.045 },
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.gradeMat);
    this.quad.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.quad);
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setCamera(camera) { this.camera = camera; }

  setSize(w, h, pr) {
    const W = Math.round(w * pr), H = Math.round(h * pr);
    this.sceneRT.setSize(W, H);
    const bw = Math.max(64, Math.round(W / 4)), bh = Math.max(64, Math.round(H / 4));
    this.brightRT.setSize(bw, bh);
    this.blurRT.setSize(bw, bh);
    this.blurMat.uniforms.uTexel.value.set(1 / bw, 1 / bh);
  }

  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.fsCam);
  }

  render(dt, opts) {
    const g = this.gradeMat.uniforms;
    g.uTime.value = (g.uTime.value + dt) % 1000;
    g.uDust.value = opts.storm * 0.9;
    g.uMono.value = opts.mono ? 1 : 0;
    g.uGrain.value = opts.mono ? 0.09 : 0.042;
    g.uBloomStrength.value = 0.22 + opts.duskF * 0.16 + opts.nightF * 0.22;

    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const r = this.renderer;
    // 1) scene into the MSAA target
    r.setRenderTarget(this.sceneRT);
    r.render(this.scene, this.camera);
    // 2) bloom: threshold -> blur H -> blur V
    this.brightMat.uniforms.tSrc.value = this.sceneRT.texture;
    this._blit(this.brightMat, this.brightRT);
    this.blurMat.uniforms.tSrc.value = this.brightRT.texture;
    this.blurMat.uniforms.uDir.value.set(1, 0);
    this._blit(this.blurMat, this.blurRT);
    this.blurMat.uniforms.tSrc.value = this.blurRT.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1);
    this._blit(this.blurMat, this.brightRT);
    // 3) grade to the canvas
    g.tSrc.value = this.sceneRT.texture;
    g.tBloom.value = this.brightRT.texture;
    this._blit(this.gradeMat, null);
  }
}
