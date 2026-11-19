// Shared helpers for the tests: the company data, the scripts, a ready call.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../src/data/store.js";
import { EventLog } from "../src/events/log.js";
import { loadRecordings, MockLLM } from "../src/providers/mock.js";
import type { LLMProvider } from "../src/providers/types.js";
import { CallSession } from "../src/session.js";

export const ROOT = resolve(import.meta.dirname, "../../..");
export const DATA_DIR = join(ROOT, "apps/server/data");
export const FIXTURES_DIR = join(ROOT, "fixtures");
export const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

export function makeStore() {
  return new Store(DATA_DIR, () => NOW);
}

export interface Script {
  title: string;
  expected: {
    finalState: string;
    alertByCallerTurn?: number;
    neverAlert?: boolean;
    deviceEmployeeId: string;
    devicePress: "approve" | "deny";
    decision: "blocked" | "approved";
  };
  turns: { channel: "caller" | "agent"; text: string }[];
}

export function loadScript(name: string): Script {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "calls", name, "script.json"), "utf8"));
}

export function makeSession(llm: LLMProvider = new MockLLM(loadRecordings(FIXTURES_DIR))) {
  const store = makeStore();
  const log = new EventLog({ now: () => NOW });
  const session = new CallSession("CALL-TEST", { store, log, llm });
  return { store, log, session };
}

export async function play(session: CallSession, script: Script) {
  const states: string[] = [];
  for (const t of script.turns) {
    const a = await session.addTurn(t.channel, t.text);
    if (t.channel === "caller") states.push(a?.state ?? "none");
  }
  return states;
}
