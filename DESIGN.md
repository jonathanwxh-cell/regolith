# REGOLITH — design

What this is and why it's built this way. For *how to work on it*, see
[AGENTS.md](AGENTS.md).

## Premise

You operate a Perseverance-class rover in a 6 km sandbox: a crater modeled on Jezero,
Perseverance's real site, with its signature landmarks — the west-wall river delta with
terraced strata, a remnant butte, a Séítah-style dune maze, a playa — plus the inlet
canyon that breaches the western rim and the plateau it climbs to, with mesas, the
shoreline of a second lake, and a lava-tube skylight. Eight objectives — checkout,
crater-rim spectrometry, dune-outcrop sampling, coring the delta front, a relay deploy on
a rim bench, the climb up the inlet, atmospheric photography, and a final uplink — and a
story that surfaces from the terrain between them (see "Story design"). Open-world driving
throughout, a real sol clock with day/night, weather, and an RTG + battery model that makes
night operations and steep grades an actual decision rather than a texture. Grounded numbers
and sources are listed in AGENTS.md "References".

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

**Procedural everything** (with one deliberate exception). No asset pipeline, no CDN, and
the whole thing is a static directory the box serves as flat files; the world is
reproducible from a seed, so a bug is always re-creatable. The exception is music: five
generated ambient beds (four MiniMax, one Suno), chosen over procedural music because a
generative score good enough to disappear into the background is a project of its own. They
stream lazily, crossfade by context (title / day / night / storm, plus a story-cued ghost
theme), and the game runs fine without them.

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

## Story design

The narrative is a **found-object mystery** that pays off in the science, not a scripted
cutscene track. A prior rover, ARGO-1 (solar-powered, killed by a global dust storm — the
Opportunity story, transposed), is discovered through physical evidence in the order a real
survey would find it: entry debris near the fresh crater, wind-softened wheel tracks baked
into the same track map your own wheels write to, then the wreck itself. The emotional core
is its recovered logs — its ops team's uplinks *to* it during the storm — which arrive one at
a time over the rest of the campaign so they color everything you do afterward. Three ops
voices give the survey a crew without ever showing a face; each has one thing they care
about (procedure, rocks, the battery) so their reactions write themselves from game state.

Choices are few and consequential rather than many and cosmetic: retrieve the core or leave
her; which ten samples go home; whether to spend a sol's battery on a discovery instead of
the mission. World events are progress-gated so a fast player and a slow one both meet them,
and each one changes the terrain, the sky, or the comms rather than just posting text. The
ending is composed from flags so it reads back the player's own campaign.

## Non-goals

Multiplayer. Real orbital mechanics. Soft-body or deformable terrain (tracks are a texture,
not geometry). Mobile-first controls — desktop is the target; touch is a fallback.
Photorealistic asset fidelity; the realism budget goes to behavior and light.

## Known limitations

- The rocker-bogie is posed, not simulated (above). Sharp crests can look stiff.
- Two biomes (crater floor, plateau). No polar terrain; the lava-tube skylight is a pit you
  photograph from the lip, not a cave you enter.
- Dust devils are billboard columns with scrolling noise, not fluid simulation.
- The far mesh is a 6×6 grid of 128² tiles over the whole 6 km, so distant relief is coarser
  than the near tile.
- The story is linear in its reveals; choices change the ending's composition and a few
  resources, not the geography.
