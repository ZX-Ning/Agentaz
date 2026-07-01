import fs from "node:fs";
import path from "node:path";

const dirname = import.meta.dirname!;

const baseDir = path.join(dirname, "../..");
const buildDir = path.join(baseDir, "build");

const result = await Deno.bundle({
    entrypoints: ["packages/api/src/main.ts"],
    outputDir: buildDir,
    platform: "deno",
    format: "esm",
    minify: true,
    codeSplitting: true,
    external: ["@earendil-works/*", "@juicesharp/*", "@gotgenes/*"],
});

fs.copyFileSync(
    path.join(dirname, "package.json"),
    path.join(buildDir, "package.json"),
);

console.log(result);
