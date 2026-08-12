/**
 * Bundle the CLI into a single self-contained dist/cli.js (all workspace
 * packages + express + MCP SDK inlined; only node builtins external) and
 * ship the built web UI alongside it. Zero runtime dependencies → `npx -y
 * backstop-mcp` starts in seconds with no install step worth naming.
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, "src/cli.ts")],
  outfile: path.join(here, "dist/cli.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // CJS deps (express) use require/dynamic patterns; give the ESM bundle a
  // working require.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});

const webSrc = path.join(here, "../web/dist");
const webDest = path.join(here, "web");
fs.rmSync(webDest, { recursive: true, force: true });
if (!fs.existsSync(webSrc)) {
  console.error("web/dist missing — run the workspace build first");
  process.exit(1);
}
fs.cpSync(webSrc, webDest, { recursive: true });
console.log("bundled dist/cli.js + web UI");
