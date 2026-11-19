// Builds everything the console shows from the call log, one event at a time.

import type { AuditEvent, Employee, RiskState } from "@verifydesk/shared";

export interface TurnView {
  id: string;
  channel: "caller" | "agent" | "verifier";
  text: string;
  seq: number;
  evidence?: string;
  stateAfter?: RiskState;
  why?: string;
  notes?: string[];
  source?: "ai" | "fixed" | "fallback";
  kind?: "closing";
}

export interface DeviceView {
  id: string;
  type: string;
  label: string;
  pushEnabled: boolean;
  lastSeenMinutesAgo: number;
  lastLocation: string;
}

export interface IdentityEventView {
  type: string;
  minutesAgo: number;
  location: string;
  detail: string | null;
}

export interface ToolView {
  seq: number;
  ts: number;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  error: string | null;
  ms: number;
}

export interface PushView {
  challengeId: string;
  employeeId: string;
  deviceId: string;
  reason: string;
  status: "pending" | "approved" | "denied";
}

export interface AssessmentView {
  state: RiskState;
  reasons: string[];
  anomalies: string[];
  supporting: string[];
  tactics: string[];
  requestedAction: string;
  whisper: string | null;
  checklist: Record<string, boolean>;
  employeeId: string | null;
}

export interface StepView {
  key: string;
  text: string;
  detail?: string;
  tone: "done" | "good" | "bad" | "wait";
}

export interface CallView {
  callId: string | null;
  scenario: string | null;
  llm: string | null;
  verifier: "agent" | "fixed" | null;
  turns: TurnView[];
  assessment: AssessmentView | null;
  employee: Employee | null;
  devices: DeviceView[];
  identityEvents: IdentityEventView[];
  tools: ToolView[];
  pushes: PushView[];
  decision: { decision: "approved" | "blocked"; ticketId?: string } | null;
  steps: StepView[];
  lastExtractionMs: number | null;
  ended: boolean;
  seen: Set<number>;
}

export const emptyView = (): CallView => ({
  callId: null,
  scenario: null,
  llm: null,
  verifier: null,
  turns: [],
  assessment: null,
  employee: null,
  devices: [],
  identityEvents: [],
  tools: [],
  pushes: [],
  decision: null,
  steps: [],
  lastExtractionMs: null,
  ended: false,
  seen: new Set(),
});

type P = Record<string, any>;

const addStep = (v: CallView, step: StepView): CallView =>
  v.steps.some((x) => x.key === step.key) ? v : { ...v, steps: [...v.steps, step] };
const updateStep = (v: CallView, key: string, patch: Partial<StepView>): CallView =>
  v.steps.some((x) => x.key === key) ? { ...v, steps: v.steps.map((x) => (x.key === key ? { ...x, ...patch } : x)) } : v;

// Takes the current screen state and one event, and returns the new state.
export function applyEvent(view: CallView, e: AuditEvent): CallView {
  if (view.seen.has(e.seq)) return view;
  const v: CallView = { ...view, seen: new Set(view.seen).add(e.seq) };
  const p = e.payload as P;

  switch (e.type) {
    case "call_started":
      return { ...v, callId: e.callId, scenario: p.scenario ?? null, llm: p.llm ?? null, verifier: p.verifier ?? null };

    case "turn":
      return { ...v, turns: [...v.turns, { id: p.id, channel: p.channel, text: p.text, seq: e.seq }] };

    case "verifier_said":
      return {
        ...v,
        turns: [
          ...v.turns,
          {
            id: `v-${e.seq}`,
            channel: "verifier",
            text: p.text,
            seq: e.seq,
            why: p.why || undefined,
            notes: Array.isArray(p.notes) && p.notes.length ? p.notes : undefined,
            source: p.source,
            kind: p.kind === "closing" ? "closing" : undefined,
          },
        ],
      };

    case "extraction": {
      const claim = typeof p.claimedIdentity === "string" && p.claimedIdentity ? p.claimedIdentity : null;
      const withClaim = claim ? addStep(v, { key: `claim:${claim.toLowerCase()}`, text: `Caller says they're ${claim}`, tone: "done" }) : v;
      return {
        ...withClaim,
        lastExtractionMs: typeof p.ms === "number" ? p.ms : v.lastExtractionMs,
        turns: v.turns.map((t) => (t.id === p.turnId ? { ...t, evidence: p.evidenceQuote || undefined } : t)),
      };
    }

    case "assessment": {
      const a: AssessmentView = {
        state: p.state,
        reasons: p.reasons ?? [],
        anomalies: p.anomalies ?? [],
        supporting: p.supporting ?? [],
        tactics: p.tactics ?? [],
        requestedAction: p.requestedAction ?? "none",
        whisper: p.whisper ?? null,
        checklist: p.checklist ?? {},
        employeeId: p.employeeId ?? null,
      };
      const lastCaller = [...v.turns].reverse().find((t) => t.channel === "caller" && !t.stateAfter);
      const n = a.anomalies.length;
      const withContext = updateStep(v, "context", {
        detail: n === 0 ? "Nothing contradicts the story" : `${n} ${n === 1 ? "thing doesn't" : "things don't"} add up (see What VerifyDesk noticed)`,
        tone: n === 0 ? "done" : "bad",
      });
      return {
        ...withContext,
        assessment: a,
        turns: lastCaller ? v.turns.map((t) => (t.id === lastCaller.id ? { ...t, stateAfter: a.state } : t)) : v.turns,
      };
    }

    case "tool_call": {
      const tool: ToolView = { seq: e.seq, ts: e.ts, name: p.name, args: p.args ?? {}, result: p.result, error: p.error ?? null, ms: p.ms ?? 0 };
      let next: CallView = { ...v, tools: [...v.tools, tool] };
      const byAgent = p.by === "agent";
      if (p.name === "lookup_employee" && p.result?.found) {
        next = { ...next, employee: p.result.employee, devices: p.result.devices ?? [] };
        const who = `${p.result.employee.name}, ${p.result.employee.title}`;
        next = addStep(next, {
          key: `found:${p.result.employee.id}`,
          text: byAgent ? `The agent picked who the caller claims to be: ${who}` : `Found in the directory: ${who}`,
          tone: "done",
        });
      } else if (p.name === "lookup_employee" && !p.error) {
        next = addStep(next, { key: `notfound:${String(p.args?.query ?? "").toLowerCase()}`, text: `No one called "${p.args?.query}" in the directory`, tone: "bad" });
      }
      if (p.name === "get_recent_identity_events" && p.result?.events) {
        next = { ...next, identityEvents: p.result.events };
        next = addStep(next, { key: "context", text: "Story checked against devices and sign-in history", tone: "done" });
      }
      if (p.name === "send_push_challenge") {
        const by = byAgent ? "by the agent" : "by VerifyDesk";
        next = p.result?.sent
          ? addStep(next, { key: `push:${p.result.challengeId}`, text: `Check sent to ${p.result.deviceLabel ?? "the registered phone"}`, detail: `Sent ${by}`, tone: "done" })
          : addStep(next, { key: "nophone", text: "No registered phone can get a check, so the caller can't be verified", tone: "bad" });
      }
      return next;
    }

    case "push_sent":
      return {
        ...v,
        pushes: [
          ...v.pushes,
          { challengeId: p.challengeId, employeeId: p.employeeId, deviceId: p.deviceId, reason: p.reason, status: "pending" },
        ],
      };

    case "push_resolved":
      return {
        ...addStep(v, {
          key: `answer:${p.challengeId}`,
          text: p.approved ? "Employee answered on their phone: Yes, it's me" : "Employee answered on their phone: No, it's not me",
          tone: p.approved ? "good" : "bad",
        }),
        pushes: v.pushes.map((x) =>
          x.challengeId === p.challengeId ? { ...x, status: p.approved ? "approved" : "denied" } : x,
        ),
      };

    case "decision":
      return {
        ...addStep(v, {
          key: "decision",
          text: p.decision === "approved" ? "Request allowed after verification" : `Request blocked${p.ticketId ? `, security ticket ${p.ticketId} opened` : ""}`,
          tone: p.decision === "approved" ? "good" : "bad",
        }),
        decision: { decision: p.decision, ticketId: p.ticketId },
      };

    case "agent_decision":
      return p.applied?.tool === "ask_caller" && p.applied?.say
        ? addStep(v, { key: `ask:${e.seq}`, text: "VerifyDesk asked the caller a question", detail: `"${p.applied.say}"`, tone: "done" })
        : v;

    case "call_ended":
      return { ...v, ended: true };

    default:
      return v;
  }
}

// Builds the screen state from a whole list of events.
export function buildView(events: AuditEvent[]): CallView {
  return [...events].sort((a, b) => a.seq - b.seq).reduce(applyEvent, emptyView());
}
