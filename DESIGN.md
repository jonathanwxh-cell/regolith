# REGOLITH — design

What this is and why it's built this way. For *how to work on it*, see
[AGENTS.md](AGENTS.md).

## Premise

You operate a Perseverance-class rover on a 2 km² quad of Mars across a multi-sol survey
campaign. Seven objectives — checkout, crater-rim spectrometry, dune sampling, lakebed
coring, a summit relay deploy, atmospheric photography, and a final uplink. Open-world
driving between them, a real sol clock with day/night, weather, and an RTG + battery model
that makes night operations and steep grades an actual decision rather than a texture.

## What "hyper-real" means here

Not photorealism — this is code-generated, with no scanned assets. It means **the world
behaves like the real thing at the level a rover operator would notice**:

1. **Terrain that is geology, not noise.** Impact craters have bowls, raised rims and ejecta
   blankets. The dune field is barchan — shallow windward slope, steep lee face — and
   migrates the way transverse dunes do. The basin is a closed depression with a flat playa
   floor and polygonal desiccation cracks, because that is what a paleolake leaves behind.
   Each mission site is *resolved from the generated terrain* rather than placed on it: the
   dune objective finds a real local maximum, the summit objective finds the actual highest
   point in the highland.
2. **Light and air that are Martian, not orange-tinted Earth.** Butterscotch daytime sky,
   and the real inversion at sunset — Mars scatters *blue* forward, so the glow around the
   setting sun is cool while the sky stays dusty. Aerial perspective is tinted exponential
   fog that thickens in storms. The environment map is re-baked as the sun moves.
3. **A rover with a mechanism.** Rocker-bogie suspension articulates from six independent
   wheel contacts. It turns in place by splaying the corner wheels. It slips in sand and
   loses traction on grades. The mast physically points where the mast camera looks; the arm
   unfolds through real poses to drill.
4. **Consequence.** Wheel tracks persist in the world and dust storms slowly bury them.
   Battery depletes faster uphill, in sand, and when the heaters fight a −85 °C night. The
   quad is small enough to learn and large enough to get stranded in.
5. **Ops framing.** The interface is a mission console, not a game HUD: LMST clock, net
   watts, tilt horizon, compass tape, a topographic map you set waypoints on, an uplink log,
   and spectrometer readouts naming real Mars mineralogy — smectites, jarosite, olivine,
   perchlorates.

## Why these technical choices

**Procedural everything.** No asset pipeline, no loading, no CDN, and the whole thing is a
static directory the box serves as flat files. It also means the world is reproducible from
a seed — a bug is always re-creatable.

**Two-tier terrain instead of a quadtree LOD.** A single high-resolution tile snapped to a
grid under the rover, over one coarse full-world mesh, gets ~95% of the visual benefit of a
chunked LOD system for a fraction of the complexity and with no popping or seam-stitching
logic. The trade is a hard cutover at 176 m, hidden by fog and a fragment discard.

**Raycast-on-heightfield instead of a physics engine.** The terrain is an analytic height
function, so wheel contacts are four texture reads rather than a collision pipeline. It is
deterministic, stable at any framerate, and adds no dependency. The cost is that the
rocker-bogie is a *posed approximation* driven by contact heights — it looks and responds
correctly but is not a constraint solver, and can be stiff on sharp convex crests.

**Fragment-space normals, no shadow-casting terrain.** Deriving normals per-pixel from the
height function gives relief that a vertex normal at 0.75 m spacing cannot, and sidesteps
the shadow acne and frustum seams that displaced depth passes produce.

## Non-goals

Multiplayer. Real orbital mechanics. Soft-body or deformable terrain (tracks are a texture,
not geometry). Mobile-first controls — desktop is the target; touch is a fallback.
Photorealistic asset fidelity; the realism budget goes to behavior and light.

## Known limitations

- The rocker-bogie is posed, not simulated (above). Sharp crests can look stiff.
- One biome set. There is no polar, canyon, or lava-tube terrain.
- Dust devils are billboard columns with scrolling noise, not fluid simulation.
- The far mesh is 512² for the whole 2 km, so distant relief is coarser than the near tile.
