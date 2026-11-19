#!/usr/bin/env node
// Sets up the local AI: downloads the Ollama model and switches .env to Ollama.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const model = process.env.OLLAMA_MODEL ?? "gemma4:e4b";
const url = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");

const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });

console.log("\nVerifyDesk local setup (Ollama)\n");

const v = spawnSync("ollama", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
if (v.status !== 0) {
  console.error("Ollama is not installed or not on PATH.");
  console.error("  Windows: winget install Ollama.Ollama   (or https://ollama.com/download)");
  console.error("  macOS/Linux: https://ollama.com/download");
  process.exit(1);
}
console.log(`Found ${v.stdout.trim()}`);

console.log(`\nPulling ${model} (about 5-6 GB the first time)...`);
if (run("ollama", ["pull", model]).status !== 0) process.exit(1);

if (!existsSync(envPath)) {
  copyFileSync(join(root, ".env.example"), envPath);
  console.log("\nCreated .env from .env.example");
}
let env = readFileSync(envPath, "utf8");
env = /^PROVIDER=.*/m.test(env) ? env.replace(/^PROVIDER=.*/m, "PROVIDER=ollama") : `PROVIDER=ollama\n${env}`;
writeFileSync(envPath, env);
console.log("Set PROVIDER=ollama in .env");

console.log("\nWarming up the model (first load into GPU memory)...");
const t0 = Date.now();
try {
  await fetch(`${url}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "Say OK.", stream: false, keep_alive: "30m" }),
    signal: AbortSignal.timeout(180_000),
  });
  console.log(`Ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (e) {
  console.error(`Warm-up failed: ${e.message}. Is the Ollama app running?`);
  process.exit(1);
}

console.log("\nDone. Next: npm run doctor, then npm run simulate -- attack\n");
