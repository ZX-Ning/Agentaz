import { copyFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dirname = import.meta.dirname!;

const baseDir = path.join(dirname, "../..");
const buildDir = path.join(baseDir, "build");

const cpPkg = (name: string) => {
  cpSync(
    path.join(baseDir, "node_modules", name),
    path.join(buildDir, "node_modules", name),
    { recursive: true, dereference: true },
  );
};

const result = await Deno.bundle({
  entrypoints: ["packages/api/src/main.ts"],
  outputDir: buildDir,
  platform: "deno",
  format: "esm",
  minify: true,
  codeSplitting: true,
  external: ["@earendil-works/*", "@juicesharp/*", "@gotgenes/*"],
});

copyFileSync(
  path.join(dirname, "package.json"),
  path.join(buildDir, "package.json"),
);

cpPkg("@earendil-works");
cpPkg("@gotgenes");
cpPkg("@juicesharp");

const piPackageJsonDir = path.join(
  buildDir,
  "node_modules",
  "@earendil-works/pi-coding-agent/package.json",
);
const piPackageJson = JSON.parse(readFileSync(piPackageJsonDir, "utf-8"));
piPackageJson["piConfig"] = {
  name: "Agentaz",
  configDir: ".agentaz",
};
writeFileSync(piPackageJsonDir, JSON.stringify(piPackageJson));
console.log(result);
