import fs from "node:fs";
import path from "node:path";

const dirname = import.meta.dirname!;

const baseDir = path.join(dirname, "../..");
const buildDir = path.join(baseDir, "build");

const packages = JSON.parse(
    fs.readFileSync(path.join(dirname, "package.json"), "utf-8"),
) as Record<string, unknown>;
const requires = packages.dependencies as Record<string, string>;

console.log(`external packages: [${Object.keys(requires)}]`);

const result = await Deno.bundle({
    entrypoints: ["packages/api/src/main.ts"].map((p) => path.join(baseDir, p)),
    outputDir: buildDir,
    platform: "deno",
    format: "esm",
    minify: true,
    codeSplitting: true,
    external: Object.keys(requires),
});

fs.copyFileSync(
    path.join(dirname, "package.json"),
    path.join(buildDir, "package.json"),
);

console.log(result);
