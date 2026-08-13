# REGOLITH — a Mars survey

A hyper-real 3D Mars rover survey sim in the browser. Drive a Perseverance-class rover
across a 2 km procedural quad — craters, a barchan dune field, an ancient lakebed, a
ridged highland — through a 7-mission survey campaign on a real sol clock.

**Live:** https://regolith.alyoechosys.dev

## What's in it

- Procedural 2048 m heightfield (domain-warped fBm, 34 impact craters with rim/ejecta,
  dune band, playa basin, ridged highland) rendered as a two-tier surface: a 384 m
  high-resolution shader-displaced tile riding the rover over a full-world far mesh,
  with exact-match JS sampling for wheel physics.
- Rocker-bogie rover: 6-wheel raycast suspension, turn-in-place, corner steering, slope
  and sand slip, persistent wheel tracks GPU-splatted into a world texture (dust storms
  slowly bury them), articulated arm with drill animation, mast that physically aims
  where the mastcam looks, HGA gimbal.
- Atmosphere: sol clock (1 sol ≈ 24.7 real minutes), sun arc with butterscotch days and
  the real *blue* Martian sunset, stars + Phobos (rises in the west) + Deimos, roaming
  photographable dust devils, regional dust storms foreshadowed by a pressure drop,
  temperature/wind/pressure telemetry, RTG + battery power model with night heater load.
- Ops-style HUD: compass tape, minimap + full topographic map (click to set waypoints),
  tilt ball, power/net-watts, mission log, spectrometer readouts with real Mars
  mineralogy, mastcam photo mode with a burned-in caption gallery.
- Procedural WebAudio (wind, motor, drill, radio) — no audio assets. No network calls.
  Saves to localStorage.

## Controls

W A S D drive (turns in place when stopped) · SPACE brake · SHIFT precision · mouse
orbit + scroll zoom · C camera (chase/orbit/mastcam/hazcam) · F photo mode · G / click
capture · E hold — contextual action (scan/drill/relay/uplink) · M map · L lamps ·
T hold — wait ×300 · ESC pause.

## Dev

```
npm install
npm run dev     # esbuild serve on :8971
npm run build   # writes public/dist/bundle.js (committed, so the box needs no npm)
```

Deploy: push to `main`, then on the box `git -C ~/apps/regolith pull --ff-only`.
Served statically by the shared app-host (no per-app service). Bump the `?v=` query
on `styles.css` / `bundle.js` in `public/index.html` on every deploy.

Stack: three.js r185, esbuild, vanilla everything else.
