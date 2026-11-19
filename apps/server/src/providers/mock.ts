// Demo mode: stands in for the AI with recorded answers for the scripted calls and keyword rules for everything
// else. No AI calls here, so no key is needed.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Extraction } from "@verifydesk/shared";
import { heuristicExtract } from "../extractor.js";
import type { ChatMessage, ChatResult, JsonRequest, LLMProvider, STTProvider } from "./types.js";

export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Reads the recorded AI answers from the script files.
export function loadRecordings(fixturesDir: string): Map<string, Extraction> {
  const map = new Map<string, Extraction>();
  const callsDir = join(fixturesDir, "calls");
  if (!existsSync(callsDir)) return map;
  for (const name of readdirSync(callsDir)) {
    const file = join(callsDir, name, "script.json");
    if (!existsSync(file)) continue;
    const script = JSON.parse(readFileSync(file, "utf8")) as {
      turns: { text: string; extraction?: unknown }[];
    };
    for (const t of script.turns) {
      if (t.extraction) map.set(normalizeKey(t.text), Extraction.parse(t.extraction));
    }
  }
  return map;
}

export class MockLLM implements LLMProvider {
  readonly name = "mock";
  constructor(private readonly recordings: Map<string, Extraction>) {}

  async json<T>(req: JsonRequest<T>): Promise<{ value: T; ms: number }> {
    if (req.mock) return { value: req.schema.parse(req.mock()), ms: 0 };
    const key = normalizeKey(req.mockKey ?? "");
    const recorded = this.recordings.get(key) ?? heuristicExtract(req.mockKey ?? "");
    return { value: req.schema.parse(recorded), ms: 0 };
  }

  async chat(_messages: ChatMessage[]): Promise<ChatResult> {
    return { content: "", toolCalls: [], ms: 0 };
  }
}

export class MockSTT implements STTProvider {
  readonly name = "mock";
  async transcribe(_audio: Buffer, _filename: string, hint?: string) {
    return { text: hint ?? "", ms: 0 };
  }
}
