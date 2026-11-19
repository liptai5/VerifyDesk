// Picks which AI does the work: demo (mock), Ollama on this computer, or Groq in the cloud.

import type { Config, ProviderName } from "../config.js";
import { CompatLLM, CompatSTT } from "./openaiCompat.js";
import { loadRecordings, MockLLM, MockSTT } from "./mock.js";
import type { LLMProvider, STTProvider } from "./types.js";

// The AI that reads text.
export function createLLM(cfg: Config, name: ProviderName = cfg.llmProvider): LLMProvider {
  switch (name) {
    case "ollama":
      return new CompatLLM({
        name: `ollama:${cfg.ollama.model}`,
        baseUrl: `${cfg.ollama.url}/v1`,
        ollamaNativeUrl: cfg.ollama.url,
        model: cfg.ollama.model,
        timeoutMs: 120_000,
      });
    case "groq":
      if (!cfg.groq.apiKey) throw new Error("LLM_PROVIDER=groq but GROQ_API_KEY is empty. Run `npm run doctor`.");
      return new CompatLLM({
        name: `groq:${cfg.groq.llmModel}`,
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: cfg.groq.apiKey,
        model: cfg.groq.llmModel,
      });
    default:
      return new MockLLM(loadRecordings(cfg.fixturesDir));
  }
}

// The AI that turns speech into text.
export function createSTT(cfg: Config, name: ProviderName = cfg.sttProvider): STTProvider {
  switch (name) {
    case "ollama":
      return new CompatSTT({
        name: `ollama:${cfg.ollama.model}`,
        baseUrl: `${cfg.ollama.url}/v1`,
        model: cfg.ollama.model,
        timeoutMs: 120_000,
        chatFallback: true,
      });
    case "groq":
      if (!cfg.groq.apiKey) throw new Error("STT_PROVIDER=groq but GROQ_API_KEY is empty. Run `npm run doctor`.");
      return new CompatSTT({
        name: `groq:${cfg.groq.sttModel}`,
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: cfg.groq.apiKey,
        model: cfg.groq.sttModel,
        speechFilter: true,
      });
    default:
      return new MockSTT();
  }
}

export type { LLMProvider, STTProvider } from "./types.js";
