// Build: bundle src/ -> public/dist/bundle.js, then stamp index.html's ?v=
// query strings with a hash of the actual asset bytes.
//
// The stamp is derived, never hand-edited: app-host serves anything carrying a
// substituted ?v= as `immutable` for a year, so a version string that fails to
// change on a content change pins every returning visitor to the old build.
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
const p = (rel) => new URL(rel, pathToFileURL(ROOT));

const ESBUILD_OPTS = {
  entryPoints: [fileURLToPath(p("src/main.js"))],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  legalComments: "none",
};

/** Bundle to memory. Returns the bytes; never touches disk. */
export async function bundleToMemory() {
  const result = await esbuild.build({ ...ESBUILD_OPTS, write: false });
  return Buffer.from(result.outputFiles[0].contents);
}

export const shortHash = (...buffers) => {
  const h = createHash("sha256");
  for (const b of buffers) h.update(b);
  return BigInt("0x" + h.digest("hex").slice(0, 12)).toString(36).slice(0, 8);
};

/** The version string index.html *should* carry, given the assets on disk. */
export async function expectedVersion() {
  const [bundle, styles] = await Promise.all([
    readFile(p("public/dist/bundle.js")),
    readFile(p("public/styles.css")),
  ]);
  return shortHash(bundle, styles);
}

const VERSIONED = /(styles\.css|dist\/bundle\.js)\?v=[A-Za-z0-9]+/g;

/** Returns every ?v= value referenced by index.html. */
export async function stampedVersions() {
  const html = await readFile(p("public/index.html"), "utf8");
  return [...html.matchAll(VERSIONED)].map((m) => m[0].split("?v=")[1]);
}

/** Rewrite index.html's ?v= stamps to match the assets on disk. */
export async function stampAssets() {
  const v = await expectedVersion();
  const html = await readFile(p("public/index.html"), "utf8");
  const next = html.replace(VERSIONED, (_, asset) => `${asset}?v=${v}`);
  if (next !== html) await writeFile(p("public/index.html"), next);
  return { version: v, changed: next !== html };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bytes = await bundleToMemory();
  await writeFile(p("public/dist/bundle.js"), bytes);
  const { version, changed } = await stampAssets();
  const kb = (bytes.length / 1024).toFixed(0);
  console.log(`bundle.js  ${kb} kb`);
  console.log(`asset ?v=  ${version}${changed ? "  (index.html restamped)" : ""}`);
}
