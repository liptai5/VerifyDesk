#!/usr/bin/env node
// Checks the setup (Node, packages, .env, AI key or Ollama, port) and says how to fix problems.

import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") process.loadEnvFile(envPath);

const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✘\x1b[0m ${m}`);
const hint = (m) => console.log(`      \x1b[2m→ ${m}\x1b[0m`);
let failures = 0;

const pick = (v, f) => (["mock", "ollama", "groq"].includes((v ?? "").toLowerCase()) ? v.toLowerCase() : f);
const provider = pick(process.env.PROVIDER, "mock");
const llm = pick(process.env.LLM_PROVIDER, provider);
const stt = pick(process.env.STT_PROVIDER, provider);
const ollamaUrl = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
const ollamaModel = process.env.OLLAMA_MODEL ?? "gemma4:e4b";
const port = Number(process.env.PORT ?? 8787);

console.log("\nVerifyDesk doctor\n");

const [maj, min] = process.versions.node.split(".").map(Number);
if (maj > 20 || (maj === 20 && min >= 12)) ok(`Node ${process.versions.node}`);
else {
  bad(`Node ${process.versions.node} is too old`);
  hint("Install Node 20.12+ (LTS) from https://nodejs.org");
  failures++;
}

if (existsSync(join(root, "node_modules"))) ok("Dependencies installed");
else {
  bad("Dependencies missing");
  hint("Run: npm install");
  failures++;
}

if (existsSync(envPath)) ok(".env found");
else {
  warn("No .env file, using defaults (PROVIDER=mock, demo mode)");
  hint("For local AI: npm run setup:local   |   For cloud: copy .env.example to .env and add GROQ_API_KEY");
}
const verifier = (process.env.VERIFIER ?? "").trim().toLowerCase() === "fixed" ? "standard steps (VERIFIER=fixed)" : "AI agent";
console.log(`\n  Active providers:  LLM=${llm}  STT=${stt}  Verifier=${verifier}\n`);

if (llm === "ollama" || stt === "ollama") {
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const tags = await res.json();
    ok(`Ollama reachable at ${ollamaUrl}`);
    const names = (tags.models ?? []).map((m) => m.name);
    if (names.some((n) => n === ollamaModel || n.startsWith(`${ollamaModel}`))) ok(`Model ${ollamaModel} is pulled`);
    else {
      bad(`Model ${ollamaModel} not found (have: ${names.join(", ") || "none"})`);
      hint(`Run: ollama pull ${ollamaModel}`);
      failures++;
    }
    try {
      const ps = await fetch(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
      const loaded = (ps.models ?? []).find((m) => m.name.startsWith(ollamaModel));
      if (loaded) {
        const gpu = loaded.size_vram && loaded.size ? Math.round((loaded.size_vram / loaded.size) * 100) : 0;
        if (gpu >= 99) ok(`Model loaded 100% on GPU`);
        else warn(`Model loaded ${gpu}% on GPU (the rest on CPU, so slower)`);
        if (gpu < 99) hint("Close other GPU apps, or set LLM_PROVIDER=groq and keep STT local");
      } else warn("Model not loaded yet (the first request will take longer)");
    } catch {}
  } catch {
    bad(`Ollama not reachable at ${ollamaUrl}`);
    hint("Install from https://ollama.com/download, start it, then run: npm run setup:local");
    failures++;
  }
}

if (llm === "groq" || stt === "groq") {
  const key = process.env.GROQ_API_KEY ?? "";
  if (!key) {
    bad("GROQ_API_KEY is empty");
    hint("Free key, no credit card: https://console.groq.com/keys, then add it to .env");
    failures++;
  } else {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) ok("Groq key works");
      else {
        bad(`Groq rejected the key (HTTP ${r.status})`);
        failures++;
      }
    } catch {
      warn("Could not reach api.groq.com (offline?)");
    }
  }
}

await new Promise((resolve) => {
  const s = createServer()
    .once("error", () => {
      warn(`Port ${port} is busy (maybe the server is already running)`);
      hint("Set PORT=8788 in .env to use another port");
      resolve();
    })
    .once("listening", () => {
      s.close();
      ok(`Port ${port} is free`);
      resolve();
    })
    .listen(port);
});

console.log(
  failures
    ? `\n\x1b[31m${failures} problem(s) found.\x1b[0m Fix them, or run \x1b[1mnpm run demo\x1b[0m (no AI needed).\n`
    : `\n\x1b[32mAll good.\x1b[0m Next: \x1b[1mnpm run simulate -- attack\x1b[0m or \x1b[1mnpm run dev\x1b[0m\n`,
);
process.exit(failures ? 1 : 0);
