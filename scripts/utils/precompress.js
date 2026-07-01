#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const rootDir = process.argv[2] ?? "dist";

const MIN_SIZE = 512;

const COMPRESSIBLE_EXTS = new Set([
    ".html",
    ".css",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".svg",
    ".xml",
    ".wasm",
    ".txt",
    ".map",
    ".webmanifest",
]);

const SKIP_EXTS = new Set([
    ".br",
    ".gz",
    ".zst",
    ".zip",
    ".7z",
    ".rar",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".avif",
    ".gif",
    ".mp4",
    ".mp3",
    ".ogg",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
]);

function run(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            stdio: options.stdio ?? "ignore",
            shell: false,
        });

        child.on("error", reject);

        child.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
            }
        });
    });
}

async function commandExists(cmd) {
    try {
        if (process.platform === "win32") {
            await run("where", [cmd]);
        } else {
            await run("sh", ["-c", `command -v ${cmd}`]);
        }

        return true;
    } catch {
        return false;
    }
}

async function* walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            yield* walk(fullPath);
        } else if (entry.isFile()) {
            yield fullPath;
        }
    }
}

async function shouldCompress(file) {
    const ext = path.extname(file).toLowerCase();

    if (SKIP_EXTS.has(ext)) return false;
    if (!COMPRESSIBLE_EXTS.has(ext)) return false;

    const stat = await fs.stat(file);
    if (stat.size <= MIN_SIZE) return false;

    return true;
}

async function collectFiles(root) {
    const files = [];

    for await (const file of walk(root)) {
        if (await shouldCompress(file)) {
            files.push(file);
        }
    }

    return files;
}

async function compressFile(file, tools) {
    const jobs = [];

    if (tools.brotli) {
        jobs.push(run("brotli", ["-f", "-q", "11", file]));
    }

    if (tools.gzip) {
        jobs.push(run("gzip", ["-f", "-k", "-9", file]));
    }

    if (tools.zstd) {
        jobs.push(run("zstd", ["-f", "-19", "--keep", file, "-o", `${file}.zst`]));
    }

    await Promise.all(jobs);
}

async function runPool(items, concurrency, worker) {
    let index = 0;
    let failed = 0;

    async function loop() {
        while (index < items.length) {
            const current = items[index++];

            try {
                await worker(current);
                console.log(`compressed: ${current}`);
            } catch (err) {
                failed++;
                console.error(`failed: ${current}`);
                console.error(`  ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        () => loop(),
    );

    await Promise.all(workers);

    if (failed > 0) {
        throw new Error(`${failed} file(s) failed to compress`);
    }
}

async function main() {
    const tools = {
        brotli: await commandExists("brotli"),
        gzip: await commandExists("gzip"),
        zstd: await commandExists("zstd"),
    };

    console.log("available compressors:");
    console.log(`  brotli: ${tools.brotli ? "yes" : "no"}`);
    console.log(`  gzip:   ${tools.gzip ? "yes" : "no"}`);
    console.log(`  zstd:   ${tools.zstd ? "yes" : "no"}`);

    if (!tools.brotli && !tools.gzip && !tools.zstd) {
        throw new Error("no compressor found: install brotli, gzip, or zstd");
    }

    const files = await collectFiles(rootDir);

    console.log(`found ${files.length} compressible file(s)`);

    if (files.length === 0) {
        return;
    }

    const concurrency = Math.max(1, os.cpus().length);

    await runPool(files, concurrency, (file) => compressFile(file, tools));

    console.log("done");
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
