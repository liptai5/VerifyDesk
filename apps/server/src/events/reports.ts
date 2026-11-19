// Reads saved calls back from runs/ for the reports page.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent } from "@verifydesk/shared";
import type { EventLog } from "./log.js";

export const SAFE_CALL_ID = /^[A-Za-z0-9-]{3,80}$/;

export interface CallSummary {
  callId: string;
  startedAt: number;
  scenario: string | null;
  employeeName: string | null;
  finalState: string | null;
  decision: string | null;
  ticketId: string | null;
  lines: number;
}

// All events of one call, from memory or from its file. Broken lines are skipped.
export function readCall(log: EventLog, runsDir: string, callId: string): AuditEvent[] {
  if (!SAFE_CALL_ID.test(callId)) return [];
  const live = log.forCall(callId);
  if (live.length) return live;
  const file = runsDir ? join(runsDir, `${callId}.jsonl`) : "";
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditEvent];
      } catch {
        return [];
      }
    });
}

export function summarize(events: AuditEvent[]): CallSummary | null {
  const start = events.find((e) => e.type === "call_started");
  if (!start) return null;
  let employeeName: string | null = null;
  let finalState: string | null = null;
  let decision: string | null = null;
  let ticketId: string | null = null;
  let lines = 0;
  for (const e of events) {
    const p = e.payload as Record<string, any>;
    if (e.type === "turn") lines++;
    if (e.type === "assessment") finalState = p.state ?? finalState;
    if (e.type === "tool_call" && p.name === "lookup_employee" && p.result?.found) employeeName = p.result.employee?.name ?? employeeName;
    if (e.type === "decision") {
      decision = p.decision ?? decision;
      ticketId = p.ticketId ?? ticketId;
    }
  }
  return {
    callId: start.callId,
    startedAt: start.ts,
    scenario: ((start.payload as any).scenario as string | null) ?? null,
    employeeName,
    finalState,
    decision,
    ticketId,
    lines,
  };
}

// Every call, newest first, with a short summary.
export function listCalls(log: EventLog, runsDir: string, inMemory: string[]): CallSummary[] {
  const ids = new Set(inMemory);
  if (runsDir && existsSync(runsDir)) {
    for (const f of readdirSync(runsDir)) if (f.endsWith(".jsonl")) ids.add(f.slice(0, -6));
  }
  return [...ids]
    .map((id) => summarize(readCall(log, runsDir, id)))
    .filter((s): s is CallSummary => Boolean(s))
    .sort((a, b) => b.startedAt - a.startedAt);
}
