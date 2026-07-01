import { copyFileSync } from "node:fs";
import path from "node:path";

const dirname = import.meta.dirname!;

const buildDir = path.join(dirname, "../../build");

const result = await Deno.bundle({
  entrypoints: ["packages/api/src/main.ts"],
  outputDir: buildDir,
  platform: "deno",
  format: "esm",
  minify: true,
  codeSplitting: true,
  external: ["@earendil-works/pi-coding-agent"],
});

copyFileSync(path.join(dirname, "package.json"), path.join(buildDir, "package.json"));

console.log(result);
