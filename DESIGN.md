# REGOLITH — design

**A hyper-real 3D Mars rover survey sim.** repo `jonathanwxh-cell/regolith` · deployed static on the Hetzner box behind app-host.

## Premise
You operate a Perseverance-class rover on a 2 km² quad of Mars terrain across a multi-sol survey
campaign: seven mission objectives (traverse, spectrometry, drilling, relay deployment,
atmospheric photography, uplink). Open-world driving, persistent tracks, sol clock with real
day/night, weather (dust devils, regional dust events), and an RTG + battery power model that
makes night ops and slopes an actual resource decision.

## Realism pillars (what "hyper-real" means here)
1. **Terrain** — procedural 2048 m heightfield: domain-warped fBm plains, 34 explicit impact
   craters (bowl/rim/ejecta profile), a barchan dune band, a flattened lakebed basin, a ridged
   highland. Two-tier rendering: a 384 m high-res tile (0.75 m grid, snapped, shader-displaced
   from the height texture with an exact-match JS sampler for physics) over a full-world far
   mesh, plus a distant mesa ring for horizon scale. Fragment-space normals; albedo composed
   by slope/height/noise (regolith, basalt, bright dust, sand, playa), track darkening.
2. **Light + air** — sun position from sol clock; butterscotch day sky, the real *blue* Mars
   sunset glow around the sun, stars + Phobos (fast, rises west) + Deimos at night; tinted
   exponential fog as aerial perspective; PMREM environment relit as the sun moves; ACES.
3. **The rover** — procedural Perseverance-class build (gold MLI, finned RTG, mast with
   Mastcam-Z, articulated 3-joint arm with drill animations, HGA gimbal, corner-steer wheels
   with grousers). Rocker-bogie kinematics posed from 6 wheel raycasts; turn-in-place;
   slope/sand slip; persistent wheel tracks GPU-splatted into a world texture (storms bury them).
4. **Weather + particles** — wheel dust, roaming daytime dust devils (photographable),
   scheduled regional dust storms foreshadowed by a pressure drop; wind you can hear.
5. **Camera feel** — chase/orbit/mastcam (pointer-lock, 45°→8° zoom, drives the physical mast)/
   hazcam (mono); bloom + SMAA + film grade (grain, vignette, CA, lens dust in storms).
6. **Ops flavor** — JPL-style HUD: compass tape, minimap + full topo map with click waypoints,
   telemetry (LMST, temp, wind, pressure, tilt horizon, battery W-net), uplink log messages,
   spectrometer readouts with real Mars mineralogy (smectites, jarosite, olivine, perchlorates).

## Architecture
Vanilla three.js r185 bundled by esbuild into one IIFE; no runtime deps, no network fetches,
fully static. `src/`: `noise` (seeded simplex/fBm), `terrain`, `sky`, `rocks`, `rover`,
`cameras`, `dust`, `missions`, `instruments`, `hud`, `audio`, `post`, `main`. Physics is
raycast-on-heightfield (analytic, no physics engine) — deterministic and stable. Save state in
localStorage. Quality presets Low→Ultra (pixel ratio, shadows, particle pools, post on/off).

## Deploy
Build committed at `public/dist/bundle.js` so the box needs no npm. Box: clone under
`~/apps/regolith`, app-host `registry.json` static entry (`dir: .../public`), cloudflared route
`regolith.alyoechosys.dev` → :8000. HTML is no-cache via app-host; assets referenced with real
`?v=` strings, bumped every deploy.

## Non-goals
Multiplayer, real orbital mechanics, soft-body terrain deformation, mobile-first controls
(desktop first; basic touch fallback only).
