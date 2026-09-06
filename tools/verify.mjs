// Verification gate. Run before every commit; run with --live after every deploy.
//
//   node tools/verify.mjs           # repo gates only
//   node tools/verify.mjs --live    # + prove the deployed bytes match this repo
//
// Exits non-zero and prints WHY on failure. A gate that cannot say why it is
// red is barely a gate.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleToMemory, expectedVersion, stampedVersions, ROOT } from "./build.mjs";

const LIVE = "https://regolith.alyoechosys.dev";
const p = (rel) => new URL(rel, pathToFileURL(ROOT));
const sha = (b) => createHash("sha256").update(b).digest("hex");

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// --- Gate 1: the committed bundle is what src/ actually compiles to.
// public/dist/bundle.js is committed (the box has no npm), so a source edit
// that skips `npm run build` ships stale code with every other check green.
check("dist/bundle.js is in sync with src/", async () => {
  const [fresh, committed] = await Promise.all([
    bundleToMemory(),
    readFile(p("public/dist/bundle.js")),
  ]);
  if (sha(fresh) !== sha(committed)) {
    throw new Error(
      `committed bundle is STALE (src ${sha(fresh).slice(0, 12)} vs dist ${sha(committed).slice(0, 12)}).\n` +
      `       Run: npm run build`
    );
  }
  return `${(committed.length / 1024).toFixed(0)} kb`;
});

// --- Gate 2: cache-busting stamps match the bytes they claim to version.
// A ?v= that does not change on a content change is served immutable for a
// year, pinning returning visitors to the old build with no way to reach them.
check("index.html ?v= stamps match asset contents", async () => {
  const want = await expectedVersion();
  const got = await stampedVersions();
  if (got.length === 0) throw new Error("index.html references no versioned assets");
  const wrong = got.filter((v) => v !== want);
  if (wrong.length) {
    throw new Error(`stamped ?v=${wrong.join(",")} but assets hash to ${want}.\n` +
      `       Run: npm run build  (never hand-edit ?v=)`);
  }
  return `?v=${want} on ${got.length} assets`;
});

// --- Gate 3: the page is self-contained. No CDNs, no external fetches: the
// box serves this as flat files and offline/blocked-CDN must not break it.
check("no external asset references", async () => {
  const html = await readFile(p("public/index.html"), "utf8");
  const ext = [...html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)].map((m) => m[0]);
  if (ext.length) throw new Error(`index.html loads external assets:\n       ${ext.join("\n       ")}`);
  return "self-contained";
});

// --- Gate 3b: music tracks are present and non-trivial. The game fails
// silent without them (by design), which means a checkout that lost
// public/audio/ ships a silent build with no error anywhere.
check("music tracks present", async () => {
  const tracks = ["beacon", "drift", "nocturne", "haze", "ghost"];
  const sizes = [];
  for (const name of tracks) {
    const buf = await readFile(p(`public/audio/${name}.mp3`)).catch(() => null);
    if (!buf || buf.length < 100_000) {
      throw new Error(`public/audio/${name}.mp3 is ${buf ? buf.length + " bytes" : "MISSING"}.\n` +
        `       Regenerate via generate_music — prompts are in AGENTS.md "Music".`);
    }
    sizes.push(Math.round(buf.length / 1024));
  }
  return tracks.map((t, i) => `${t} ${sizes[i]}kb`).join(", ");
});

// --- Gate 4: terrain height sampling agrees between JS (physics) and GLSL
// (rendering). They are two implementations of one contract; if they drift the
// rover floats or sinks. Cheap proxy: both read the same constants.
check("terrain JS/GLSL samplers share constants", async () => {
  const src = await readFile(p("src/terrain.js"), "utf8");
  const js = {
    world: /export const WORLD = (\d+)/.exec(src)?.[1],
    hm: /export const HM = (\d+)/.exec(src)?.[1],
    detN: /export const DETAIL_N = (\d+)/.exec(src)?.[1],
    detSpan: /export const DETAIL_SPAN = (\d+)/.exec(src)?.[1],
  };
  const glsl = {
    world: /WORLD_M = \$\{WORLD\.toFixed/.test(src),
    hm: /HM_N = \$\{HM\.toFixed/.test(src),
    detN: /DET_N = \$\{DETAIL_N\.toFixed/.test(src),
    detSpan: /DET_SPAN = \$\{DETAIL_SPAN\.toFixed/.test(src),
  };
  const missing = Object.entries(glsl).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length) {
    throw new Error(`GLSL hardcodes constants instead of interpolating: ${missing.join(", ")}.\n` +
      `       The shader must derive them from the JS exports or physics desyncs from rendering.`);
  }
  if (Object.values(js).some((v) => !v)) throw new Error("terrain constants missing from src/terrain.js");
  return `WORLD=${js.world} HM=${js.hm} detail=${js.detN}/${js.detSpan}m`;
});

// --- Gate 5 (--live): the deployed bytes ARE these bytes.
// Probes the BARE url, then follows the ?v= the live HTML actually references:
// checking a cache-busted url of your own choosing proves the new file works,
// never what a normal visitor receives.
check("live deploy serves this commit  [--live]", async () => {
  if (!process.argv.includes("--live")) return "skipped (pass --live)";
  const htmlRes = await fetch(LIVE + "/", { headers: { "cache-control": "no-cache" } });
  if (!htmlRes.ok) throw new Error(`${LIVE}/ returned ${htmlRes.status}`);
  const cc = htmlRes.headers.get("cache-control") || "";
  if (!/no-cache|max-age=0/.test(cc)) {
    throw new Error(`live HTML is cached without revalidation (cache-control: ${cc}).\n` +
      `       Deploys will not reach returning visitors.`);
  }
  const html = await htmlRes.text();
  const ref = /dist\/bundle\.js\?v=([A-Za-z0-9]+)/.exec(html);
  if (!ref) throw new Error("live HTML references no versioned bundle");
  const local = await readFile(p("public/dist/bundle.js"));
  const liveRes = await fetch(`${LIVE}/dist/bundle.js?v=${ref[1]}`);
  const liveBytes = Buffer.from(await liveRes.arrayBuffer());
  if (sha(liveBytes) !== sha(local)) {
    throw new Error(`live bundle differs from local (live ${sha(liveBytes).slice(0, 12)} vs local ${sha(local).slice(0, 12)}).\n` +
      `       The box has not pulled this commit: git -C ~/apps/regolith pull --ff-only`);
  }
  return `${LIVE} matches local @ ?v=${ref[1]}`;
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    const detail = await fn();
    console.log(`  PASS  ${name}${detail ? `  —  ${detail}` : ""}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
console.log(failed ? `\n${failed}/${checks.length} gate(s) FAILED` : `\nall ${checks.length} gates pass`);
process.exit(failed ? 1 : 0);
