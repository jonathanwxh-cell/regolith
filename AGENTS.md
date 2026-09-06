# AGENTS.md — working on REGOLITH

Engineering manual. Read this before touching code.
[DESIGN.md](DESIGN.md) = what the game is and why. [README.md](README.md) = the front page.

```
local     C:\Users\Greyf\Desktop\Claude Code\regolith
repo      github.com/jonathanwxh-cell/regolith  (public, main)
box       ~/apps/regolith                       (clone; served static by app-host :8000)
live      https://regolith.alyoechosys.dev
```

Vanilla three.js r185 bundled by esbuild into one IIFE. No framework, no runtime
dependencies, no external network calls at runtime. Every texture, mesh and sound effect is
generated in code; the only asset files are the four MiniMax-generated music tracks in
`public/audio/` (same-origin, streamed — see **Music** below). State persists to
`localStorage` under `regolith-save-v4`.

## Commands

```
npm install
npm run dev            # esbuild dev server on 127.0.0.1:8971
npm run build          # bundle + restamp index.html ?v=  (ALWAYS before committing)
npm run verify         # repo gates — must pass before commit
npm run verify:live    # + prove the deployed bytes match this repo
```

## Module map

| File | Owns | Notes |
|---|---|---|
| `src/noise.js` | Seeded simplex, fBm, ridged fBm, `clamp/lerp/smoothstep` | Deterministic; same seed ⇒ same world |
| `src/terrain.js` | Heightfield generation, two-tier meshes, terrain shader, wheel-track render target | The load-bearing module. Read the Contracts section before editing |
| `src/sky.js` | Sol clock, sun arc, sky dome, stars/moons, fog, PMREM env, weather + storm scheduler | Owns *all* time-of-day state |
| `src/rocks.js` | Chunked `InstancedMesh` rock fields, boulder collision | 8×8 chunks × ≤420, frustum-culled per chunk |
| `src/rover.js` | Rover model, rocker-bogie posing, driving physics, power model, arm/mast controllers | Exports `MATS` (shared materials) |
| `src/cameras.js` | 4 camera modes, pointer lock, terrain-aware framing | `CHASE ORBIT MASTCAM HAZCAM` |
| `src/dust.js` | Pooled particles, wheel/drill bursts, dust devils, storm streaks | 1400-particle ring buffer |
| `src/missions.js` | 8-mission spine, site resolution, props (lander/relay/nav beam), save shape | Mission content lives in `missionDefs()` |
| `src/story.js` | Ops voices, declarative story beats + flags, comms pacing, [1]/[2] choices, sample tubes, world events, composed endings | See **Story & sandbox** |
| `src/pois.js` | Discoverable places with procedural props + held actions; ARGO-1's baked wheel trail; the impact-crater POI | Content lives in `define()` |
| `src/instruments.js` | Contextual action state machine (mission actions, then POI actions), photo capture + gallery | Couples to mission task ids and `poi.action` |
| `tools/suno.mjs` | Music generation via Suno (sunoapi.org); reads the key from `../.secrets/suno.env` | MiniMax music is withdrawn — this is the only path |
| `src/hud.js` | All DOM (injected from one template string), canvas widgets, map bakes | No HTML in `index.html` beyond `#app` |
| `src/audio.js` | Procedural WebAudio SFX — wind, motor, terrain rumble, thumps, servo, drill, UI, radio | Must be `init()`d from a user gesture |
| `src/music.js` | Context-crossfaded music (title/day/night/storm) streaming from `public/audio/` | Own bus under `audio.master`; fails silent if files are missing |
| `src/post.js` | Self-contained pipeline: MSAA(4x) scene RT → quarter-res bloom → grade to canvas | No EffectComposer — see the header comment for why |
| `src/main.js` | Boot, input, game loop, persistence, quality tiers | Exposes `window.__RG` |

## Contracts

Break one of these and the failure shows up somewhere unrelated. Each is a real bug I hit.

**Heading is +z-north.** `forward = (sin h, 0, cos h)`, so heading 0 points at **+z = North**,
heading 90° at **+x = East**. The compass, minimap arrow, sun azimuth and waypoint bearings all
assume this. The sun rises toward +x and sets toward −x. **Both maps draw north-up**: the bake
writes row 0 = +z, every overlay uses `y = center − dz`, and arrows rotate by `π − heading`.
Flip any one of those independently and navigation silently lies.

**One `onBeforeCompile` variant = one `customProgramCacheKey`.** The near-tile and far-tile
materials inject *identical shader source text* and differ only through a closed-over `near`
flag. three.js caches programs by source text — without distinct cache keys it hands one
material the other's program, and the far mesh renders with the near tile's vertex
displacement: its geometry smears across the sky as huge dark ribbons. This cost a long
debugging session (2026-09-05) because which mesh got the wrong program depended on shader
compile order, so hiding objects one at a time gave contradictory answers. If you add another
material variant to `makeMaterial`, give it its own key.

**Terrain height is `sampleMain() + mid + detail` — always all three, everywhere.** The
*generator* runs once into `this.heights` and the GLSL only samples that texture, so the
feature code (plateau, mesas, terraces, skylight, causeway) has no shader twin to drift from.
What does exist twice are the three **samplers**: JS (`terrain.heightAt`, drives physics) and
GLSL (`totalH`, drives rendering). They are two implementations of one contract and must agree.
If you change the sampling in one, change the other; `npm run verify` gate 4 checks they at
least share constants, but it cannot prove the math matches. **Both render tiers must also include the detail field** —
the far mesh originally omitted it, and at grazing angles that ±0.3 m offset made rocks on
far-side slopes poke over crests as specks floating in the sky.

**The near tile snaps to its own grid.** `TILE_SPAN/TILE_SEG` = 0.75 m; the tile position is
rounded to that step every frame so vertices never swim under the rover. The far mesh discards
fragments within 176 m of the rover so the two tiers don't z-fight.

**Real time vs sim time.** `dt` = real seconds (animation, particles, camera, **weather event
playback**). `dtSim = dt × 60 × warp` = Mars seconds (sol clock, battery, storm *scheduling*).
The sol clock runs at 60× so one sol ≈ 24.7 real minutes; `warp` is 300 while holding `T`.
Storm *phases* deliberately tick on real time — they originally used `dtSim` and a "five-minute"
dust storm blew through in five real seconds.

**Shader-uniform colors must be authored in linear space.** `new THREE.Color(0x8a5f41)` and
`.setHex()` apply an sRGB→linear conversion; a raw `ShaderMaterial` uniform does not undo it, so
hex-picked particle colors render near-black. Use `.setRGB(r, g, b)` with linear values for
anything feeding an unlit shader (see `dust.js`). Materials that go through the standard lighting
path are fine with hex.

**Wheel-track render target uv.** World → texture is `u = x/WORLD + 0.5`, `v = 0.5 − z/WORLD`.
The ortho stamp camera sets `up = (0,0,-1)` to make that hold. Note `readRenderTargetPixels` is
**bottom-origin**, which equals `v` directly — do not flip it when verifying stamps.

**Rover suspension offsets are derived, not typed in.** Wheel-center height in the chassis frame
is `WHEEL_R − RIDE_H`; every strut and pivot offset is computed from that plus `WZ_F/WZ_M/WZ_R`.
Change `WHEEL_R`, `RIDE_H` or the wheelbase and the geometry stays consistent. The first version
hardcoded the offsets and floated the rover ~0.7 m above the ground.

**Terrain does not cast shadows** (`castShadow = false` on both tiers). A displaced custom depth
material produced shadow acne across the plains plus a hard straight seam at the shadow-frustum
edge. Fragment-space normals carry all the relief that matters; rocks and the rover still cast.

**Mission task ids are the coupling** between `missions.js` and everything that completes them:

| id | Completed by |
|---|---|
| `reach` | `Missions.update` — automatic inside `m.radius` |
| `drive` | `Missions.update` — M1 special case, 40 m from spawn |
| `photo` / `devil` | `Instruments.capturePhoto` — M1 / M7 special cases |
| `scan` `drill` `relay` `uplink` | `Instruments.contextAction → start → finish` |

Adding a task id that nothing completes yields a mission that can never advance, and nothing
warns you.

## Story & sandbox

The 8-mission spine is deliberately thin; the sandbox is the POIs, the events and the arc.

**Beats** (`makeBeats()` in `story.js`) are `{id, when(ctx, story), run(ctx, story)}`; each fires
once, evaluated every 0.5 s of sim. `ctx` is built by `ctxNow()` in `main.js` — `rover, sky,
missions, terrain, layout, pois, audio, music, rig, hud, camera, elapsed (real play seconds),
newGame, dist(p)`. Add a state field there before reading it in a predicate. Lines go through
`story.say(who, text)` / `saySeq` and are paced by `Story.update` (typewriter length + 1.4 s +
0.7 s gap), so a burst of `say` calls plays as a conversation, not a wall. `offerChoice(prompt,
a, b, onA, onB)` queues a [1]/[2] prompt that blocks further lines until answered (keys handled
in `main.js`). **Flags** (`setFlag`/`has`) are the only cross-system memory and are saved.

**POIs** (`define()` in `pois.js`): `{id, title, x, z, r, kind, hintFlag?, prop?, onDiscover?,
action?}`. Discovery = rover inside `r`. `hintFlag` makes an undiscovered POI appear on the map
(purple `?`) once that story flag is set — that is how the debris trail is revealed after M2.
`action` = `{label, dur, pose, available?(story), onDone(story, ctx)}` and plugs into the same
hold-E machine as mission actions via `Instruments.contextAction` (mission actions win when both
apply). `ctx.science(sci)` from `onDone` shows the spectrometer panel AND offers a sample tube.

**Sample tubes**: `MAX_TUBES` = 10; every science result offers SEAL/LEAVE; sealed tubes are
listed at the ending and in the pause menu. ARGO's cache adds three without a prompt.

**World events** (`WorldEvents` in `story.js`), all progress-gated so a fast player still sees
them: impact after M2 on the first night (`terrain.punchCrater` + a POI + waypoint + map
rebake), Phobos transit at 14:20 on any sol ≥ 2 (`sky.forceTransit` scripts the moon across the
sun; a mastcam photo within 7° during the window sets `transit`), solar conjunction after M6
starts (one sol of `commsBlackout`: ops lines are dropped, ARGO logs still play), global dust
storm 60 s after its warning beat (M5+, 15 min in). Each records `done` in the save.

**ARGO-1 arc**: `argo_hint` (M2) → debris POIs reveal → `argo_known` → the baked trail beat
(`tracks_seen`, rover within 40 m of the polyline) → the wreck POI's choice → `argo_core_offered`
→ hold-E retrieval (`argo_core`, −144 Wh) → `ARGO_LOGS` unlock (first after 8 s, then every
200 s of play; `music.cue("ghost", 45)` each time) → `argo_logs_done`. The ending composes
paragraphs from `organics / shore_carbonates / ice / meteorite / argo_core|argo_known` and the
tube list, then the end overlay appears only after the last line has played (`S.endPending`).

**Testing the story without waiting for real time**: from the console,
`__RG.story.update(0.1, ctx)` / `__RG.pois.update(0.1, __RG.rover, __RG.story)` in a loop with a
hand-built `ctx` fast-forwards pacing and beats deterministically; `__RG.story.events.update`
likewise. This is how every event above was verified — an occluded automation window throttles
`requestAnimationFrame` to ~1 Hz, so waiting for real seconds does not work there.

## Traps

Things that cost me time and will cost the next agent the same.

- **Value-noise albedo masks show a rectilinear lattice.** Unrotated octaves align their grids
  and produce visible square blotches that read as "terrain facets" or a shadow bug. Rotate
  between octaves (`mat2(0.8,-0.6,0.6,0.8)`), as `tfbm` now does.
- **Headless-browser rAF throttling looks exactly like a physics bug.** When the automation
  window is occluded, `requestAnimationFrame` drops to ~1 Hz, the `dt` clamp pins it to 0.05 s,
  and the sim runs ~20× slow — "the rover barely moves". The tell is `__RG.S.fps` reading
  *exactly* 20. Screenshots still force frames, so stills look perfect. Verify motion through
  state probes (odometer deltas), not by watching.
- **`THREE.Color` has no `addScaledVector`.** Mixing fog colors that way throws at runtime inside
  the frame loop. Mix by components.
- **Every `ShaderMaterial` uniform you reference must be declared in that shader's source.**
  Adding `uFogColor` to the uniforms object without adding `uniform vec3 uFogColor;` to the
  fragment source fails compilation with an error only visible in the console.
- **`register_in_host` restarts the substrate tunnel**, which can drop the MCP transport
  mid-call. The call still completed. Verify the resulting state (registry + `curl -H "Host:"`
  against `:8000` + cloudflared config) before retrying — a blind retry risks a double register.
- Wheel `?v=` stamps are generated. **Never hand-edit them**; see Deploy.

## Common tasks

**Add a mission** → append to `missionDefs()` in `missions.js`. Give it a `site` (resolved from
terrain features in `resolveSites`, so it lands on real geography), a `radius`, `tasks` using only
the ids in the table above, `brief`/`done` strings, and optionally `science` for the spectrometer
panel. Sites must be reachable: check the slope with `terrain.slopeAt(x, z)` and keep waypoints
out of the dune band unless the mission is about sand.

**Add an instrument** → add the action to `durs` in `Instruments.start`, a branch in
`contextAction()` gating when it offers, and a branch in `finish()`. Arm poses live in
`ARM_POSES`.

**Add a camera mode** → add to `CAM_MODES` and handle it in `CameraRig.update`. Modes that mount
on the rover should drive the physical mast via `rover.mastCtl.aim()` so the model matches the
view.

**Change the world** → all terrain shaping is in `Terrain.generate()`. It is
**multi-resolution**: low-frequency bands (warp, regional relief, rolling plains, the rim's
ridged texture) are evaluated on 256²/512² grids and bilinearly upsampled, and only
high-frequency content runs per-texel at 2048² — that is why a 6 km world at 3 m/texel still
boots in well under a minute. Features are analytic on top, **in this order, and the order
matters** (later features overwrite earlier ones): rim wall (radial around the crater centre
`CX, CZ` = (900, 0) — the crater sits east of world centre so the plateau fits west of it —
with a softened corridor and bench for M5, and the outer flank descending onto the plateau at
`valley.plateauH` = 140 m) → plateau relief for `wx < −1200` (mesas with quantized benches,
the shoreline basin with three terraces, the skylight pit) → delta fan with quantized strata
benches → Kodiak butte → **inlet canyon**: a *set-to-ramp* causeway graded from
`plateauH + 6` at `valley.b` to `delta.topH + 1` at `valley.a` (the delta apex), applied
*after* the delta so the fan cannot wall off the apex — the first version only ever lowered
terrain and left a 37° step where the rim rose through it and a 31 m cliff at the apex →
distributary channel (a min-cut from the apex 960 m down-fan at bearing −0.3 rad, so the
causeway continues as an incised channel to the fan front) → playa → Séítah dunes → ~190
craters. `generate()` also writes the **material mask texture** (R strata + mesa benches,
G playa + shoreline terraces, B sand, A rim) that the terrain shader, the physics
(`inDuneBand`/`inBasin`/`onDelta` = mask lookups) and the rock scatter all read — if you add
a surface unit, add a channel or reuse one. `makeLayout(seed)` places the named features;
`resolveSites` derives mission points from them (the delta drill site literally walks a ray
until it falls off the strata mask). Changing the seed moves everything — re-verify M5's
bench is drivable, the M4 ray still finds a scarp, and the canyon profile is still monotonic
(probe `heightAt`/`slopeAt` along `layout.valley` for t = 0…1 and along the channel from the
apex: expect a steady descent, ≤ ~25° everywhere, no steps).

**The playable world is three zones, not a radius.** `Terrain.isPlayable(x, z)` =
`inCrater` (r < `PLAY_R` 1960 m around `CX, CZ`) ‖ `inValley` (two capsule segments — the
causeway and the distributary channel) ‖ `onPlateau` (x ∈ (−2950, −1450), |z| < 2900), minus
the skylight pit and anything beyond ±3000 m. `rover.js` restores `_lastValid` on a violation
and the HUD says "NO-GO TERRAIN"; `rocks.js`, `dust.js` (devil spawns) and the POIs all gate
on the same predicate, so extend the world by extending `isPlayable`, never by loosening the
clamp. The in-field wall rises from crater-r ≈ 1880 so it reads as a distant rampart rather
than a pit (first attempt started it at 1650 and the floor felt like standing in a hole);
`makeRimRing` silhouette rings continue the rim beyond the heightfield, with a gap at the
west (angle π) where the canyon breaches it. Jezero's real walls rise 800–1200 m — ours crest
at ~240–500 m, compressed for the stage.

**Tune the look** → terrain albedo in the `map_fragment` replacement in `terrain.js`; sky
gradients in the dome fragment shader in `sky.js`; grade/bloom in `post.js`. Lighting intensities
are in `Sky.update`.

## Music

Five ambient beds in `public/audio/`. The first four were generated with MiniMax music-2.6
(2026-08-13); **MiniMax's music API has since been withdrawn (HTTP 410, 2026-09-06)** — do not
retry it. Regenerate any track with Suno instead:

```
node tools/suno.mjs "<style / mood prompt>" public/audio/<name>.mp3
```

(~2 min; reads `SUNO_API_KEY` from the workspace `.secrets/suno.env`, which is outside this
repo — never commit a key.) They are content, not code — regenerate freely, keep the filenames:

| File | Context | Prompt gist |
|---|---|---|
| `beacon.mp3` | title screen | quiet piano motif + warm strings, NASA-documentary, restrained swell |
| `drift.mp3` | day | warm sparse analog pads, granular sand shimmer, meditative, no percussion |
| `nocturne.mp3` | night (`nightF > 0.55`) | cold sub-drone, icy distant shimmer, extremely minimal |
| `haze.mp3` | storm (`intensity > 0.45`) | low rumbling pressure drone, sits *under* the wind SFX |
| `ghost.mp3` | ARGO-1 log moments (`music.cue("ghost", 45)`) | degraded lonely piano fragment, tape hiss, radio static, sub hum (Suno V5) |

`src/music.js` streams them through `MediaElementAudioSourceNode` into its own gain bus under
`audio.master`, crossfading ~4.5 s with 3 s hysteresis so dawn/dusk/storm edges don't flap.
Contracts: **fail silent** — a missing/blocked file must never break the game (the `error`
listener marks the track failed and it is simply never faded in); **gesture-gated** — nothing
plays before `audio.init()`, which the title screen's first `pointerdown` triggers; **loop
seams are masked by low levels** (`LEVEL` in `music.js`), these are beds, not foreground.
`verify` gate 3b fails the build if any track is missing or truncated, because the fail-silent
contract otherwise turns a lost `public/audio/` into a silent deploy with no error anywhere.

## Deploy

`public/dist/bundle.js` is **committed on purpose** — the box has no npm and runs no build step.
That makes stale-bundle drift the main hazard, which is why gate 1 exists.

```bash
npm run build && npm run verify        # must be green
git add -A && git commit -m "..." && git push
```

Then on the box (via the `hetzner-deploy` MCP `run_command`):

```bash
git -C ~/apps/regolith pull --ff-only && git -C ~/apps/regolith log --oneline -1
```

No service to restart — app-host serves the directory directly. Finally:

```bash
npm run verify:live
```

That probes the **bare** URL, reads the `?v=` the live HTML actually references, and compares
the served bundle's sha256 against the local file. Checking a cache-busted URL of your own
choosing only proves the new file exists; it never proves what a normal visitor receives.

**Cache contract:** app-host serves HTML `no-cache` and any asset with a substituted `?v=` as
`immutable` for a year. So the `?v=` stamp *must* change whenever bytes change — `npm run build`
derives it from a hash of `bundle.js` + `styles.css`. A stamp that fails to change pins every
returning visitor to the old build permanently, with no server-side fix.

## Debugging

`window.__RG` exposes `{ scene, terrain, rover, sky, dust, missions, rocks, renderer, rig, S, THREE }`.

```js
__RG.sky.tSec = 88775 * (18.3 / 24.66);       // jump to sunset
__RG.sky.storm.phase = "active";               // force a dust storm
__RG.sky.storm.t = 45; __RG.sky.storm.dur = 400;
__RG.rover.pos.set(x, 0, z); __RG.rover.snapToGround();
__RG.rocks.group.visible = false;              // isolate terrain shading
__RG.S.fps                                     // exactly 20 ⇒ rAF is throttled, not a bug
__RG.renderer.info.render                      // draw calls / triangles
```

Errors are also surfaced on-page (bottom-left, red) by a `window.onerror` handler in `main.js`,
because a WebGL app that dies mid-frame otherwise just shows a frozen canvas.

## Performance

Quality tiers (`QUALITY` in `main.js`) scale pixel ratio, shadow map size, post on/off and
particle budget. Ultra targets a 1.5–2.0 device pixel ratio and a 4096 shadow map. The frame is
dominated by the near tile (512² segments = ~524k triangles), the 16 far tiles (frustum-culled,
~263k triangles total when all visible) and the terrain fragment shader, which samples the
heightfield four extra times per pixel for normals. Measured ~54 fps at HIGH on an Intel Arc
iGPU. If you need frames back, `TILE_SEG` is the cheapest lever; the shader normal taps are
next. Boot (terrain generation) is ~25 s, chunked with a progress bar — see the
multi-resolution note above before "optimizing" it back to per-pixel everything.

## References (the world is grounded in these)

- Jezero delta front strata ~25 m thick; margin unit ~85 m ([RIMFAX delta/floor contact](https://www.science.org/doi/10.1126/sciadv.adi8339))
- Kodiak remnant butte 80 m tall / 250 m wide ([Kodiak stratigraphy](https://essopenarchive.org/doi/full/10.22541/essoar.170688831.10785219/v1))
- Flood-transported boulders to 1.5 m in delta strata ([Science: delta-lake system](https://www.science.org/doi/10.1126/science.abl4051))
- Inner rim walls rise 800–1200 m above the floor ([Jezero, Wikipedia](https://en.wikipedia.org/wiki/Jezero_(crater)))
- Séítah: dune maze exposing the floor's oldest unit; Máaz lava flows above it ([imaging results](https://www.science.org/doi/10.1126/sciadv.abo4856))
- Twilight glows up to ~2 h after sunset from high-altitude dust ([NASA: Mars sunsets](https://science.nasa.gov/solar-system/planets/mars/what-does-a-sunrise-sunset-look-like-on-mars/))
