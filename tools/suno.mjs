// Generate a music bed with Suno via sunoapi.org and save it as an mp3.
//
//   node tools/suno.mjs "<style / mood prompt>" public/audio/<name>.mp3
//
// Reads SUNO_API_KEY (and optional SUNO_API_BASE) from the environment, or
// from ../.secrets/suno.env two levels up (the workspace .secrets dir — never
// committed). MiniMax's music API was withdrawn for new users (HTTP 410,
// 2026-09-06); this is the replacement path for every track in public/audio/.
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
async function loadEnv() {
  const env = { ...process.env };
  const f = path.resolve(here, "../../.secrets/suno.env");
  if (!env.SUNO_API_KEY && existsSync(f)) {
    for (const line of (await readFile(f, "utf8")).split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
  }
  if (!env.SUNO_API_KEY) throw new Error("SUNO_API_KEY not set and .secrets/suno.env not found");
  return { key: env.SUNO_API_KEY, base: env.SUNO_API_BASE || "https://api.sunoapi.org" };
}

const [prompt, outFile] = process.argv.slice(2);
if (!prompt || !outFile) {
  console.error('usage: node tools/suno.mjs "<prompt>" <out.mp3>');
  process.exit(2);
}
const { key, base } = await loadEnv();
const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const gen = await fetch(`${base}/api/v1/generate`, {
  method: "POST", headers,
  body: JSON.stringify({
    customMode: false, instrumental: true, model: "V5",
    prompt, callBackUrl: "https://httpbin.org/post",
  }),
});
const genJson = await gen.json();
if (!genJson.data || !genJson.data.taskId) {
  console.error("generate failed:", JSON.stringify(genJson));
  process.exit(1);
}
const taskId = genJson.data.taskId;
console.log("task", taskId);

const started = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 12000));
  const res = await fetch(`${base}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, { headers });
  const j = await res.json();
  const status = j.data && j.data.status;
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`  ${elapsed}s  ${status}`);
  if (status === "SUCCESS") {
    const clips = (j.data.response && j.data.response.sunoData) || [];
    if (!clips.length) { console.error("no clips in response", JSON.stringify(j).slice(0, 500)); process.exit(1); }
    // longest clip wins (Suno returns two variations)
    clips.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    const c = clips[0];
    const url = c.audio_url || c.source_audio_url;
    console.log(`  clip "${c.title}" ${c.duration}s -> ${url}`);
    const audio = await fetch(url);
    const buf = Buffer.from(await audio.arrayBuffer());
    await writeFile(outFile, buf);
    console.log(`wrote ${outFile} (${(buf.length / 1024).toFixed(0)} kb)`);
    process.exit(0);
  }
  if (status && /FAILED|ERROR|EXCEPTION/.test(status) && status !== "CALLBACK_EXCEPTION") {
    console.error("generation failed:", JSON.stringify(j).slice(0, 800));
    process.exit(1);
  }
  if (Date.now() - started > 15 * 60 * 1000) { console.error("timeout"); process.exit(1); }
}
