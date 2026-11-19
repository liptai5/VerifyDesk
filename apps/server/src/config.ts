// All settings, read from the .env file. Change the defaults here.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envPath);
}

export type ProviderName = "mock" | "ollama" | "groq";

function provider(value: string | undefined, fallback: ProviderName): ProviderName {
  const v = (value ?? "").trim().toLowerCase();
  return v === "mock" || v === "ollama" || v === "groq" ? v : fallback;
}

const base = provider(process.env.PROVIDER, "mock");

// The settings the rest of the server uses.
export const config = {
  port: Number(process.env.PORT ?? 8787),
  provider: base,
  llmProvider: provider(process.env.LLM_PROVIDER, base),
  sttProvider: provider(process.env.STT_PROVIDER, base),
  ollama: {
    url: (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, ""),
    model: process.env.OLLAMA_MODEL ?? "gemma4:e4b",
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY ?? "",
    llmModel: process.env.GROQ_LLM_MODEL ?? "openai/gpt-oss-120b",
    sttModel: process.env.GROQ_STT_MODEL ?? "whisper-large-v3-turbo",
  },
  verifier: (process.env.VERIFIER ?? "").trim().toLowerCase() === "fixed" ? ("fixed" as const) : ("agent" as const),
  agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS ?? 15_000),
  dataDir: resolve(import.meta.dirname, "../data"),
  fixturesDir: process.env.FIXTURES_DIR ? resolve(process.env.FIXTURES_DIR) : resolve(import.meta.dirname, "../../../fixtures"),
  runsDir: resolve(import.meta.dirname, "../../../runs"),
};

export type Config = typeof config;
