import { readFileSync } from "node:fs";
const input = readFileSync(0, "utf8").trim();
const packageJson = JSON.parse(input);
packageJson.piConfig = {
    name: "Agentaz",
    configDir: ".agentaz"
};
console.log(JSON.stringify(packageJson));
