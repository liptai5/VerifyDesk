// Turns a call log into the audit report (summary, evidence, policies, timeline). No AI calls here: the report is
// put together from the logged events.

import type { AuditEvent, Policy } from "@verifydesk/shared";
import { ACTION_LABEL, SPEAKER, STATE_COPY, TACTIC_LABEL, TOOL_LABEL } from "../lib/labels";
import { buildView, type CallView } from "./callView";

export interface TimelineEntry {
  ts: number;
  kind: "line" | "state" | "action" | "push" | "decision" | "verifier" | "agent";
  who?: string;
  text: string;
  tone?: "SAFE" | "WATCH" | "ALERT" | "UNCERTAIN" | "bad" | "good";
}

export interface Report {
  view: CallView;
  title: string;
  startedAt: number;
  endedAt: number;
  mode: string;
  model: string | null;
  claims: string[];
  summary: string;
  outcome: "blocked" | "approved" | "open";
  firstAlertLine: number | null;
  tactics: { labels: string[]; quote: string }[];
  policies: Policy[];
  timeline: TimelineEntry[];
}

const MODE_LABEL: Record<string, string> = {
  live: "Live call (simulated)",
  attack: "Scripted call: attack",
  benign: "Scripted call: genuine employee",
};

const AGENT_TOOL_LABEL: Record<string, string> = {
  send_push_challenge: "send the verification check",
  ask_caller: "ask the caller a question",
  none: "wait",
};

// Writes the report from the events, so it can never disagree with what happened.
export function buildReport(events: AuditEvent[], policies: Policy[] = []): Report {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const view = buildView(sorted);
  const timeline: TimelineEntry[] = [];
  const claims: string[] = [];
  const tactics: { labels: string[]; quote: string }[] = [];
  const seenTactics = new Set<string>();
  const policyIds = new Set<string>();
  let lastState: string | null = null;
  let callerLine = 0;
  let firstAlertLine: number | null = null;

  for (const e of sorted) {
    const p = e.payload as Record<string, any>;
    switch (e.type) {
      case "turn":
        if (p.channel === "caller") callerLine++;
        timeline.push({ ts: e.ts, kind: "line", who: SPEAKER[p.channel] ?? p.channel, text: p.text });
        break;
      case "verifier_said":
        timeline.push({ ts: e.ts, kind: "verifier", who: "VerifyDesk", text: p.text });
        break;
      case "agent_decision": {
        const notes: string[] = Array.isArray(p.notes) ? p.notes : [];
        if (p.task === "decide" && p.why && p.applied?.tool !== "none") {
          timeline.push({ ts: e.ts, kind: "agent", who: "VerifyDesk AI", text: `Chose: ${AGENT_TOOL_LABEL[p.applied?.tool] ?? p.applied?.tool}. ${p.why}` });
        }
        for (const n of notes) timeline.push({ ts: e.ts, kind: "agent", who: "Safety rule", text: n, tone: "WATCH" });
        break;
      }
      case "extraction":
        if (p.claimedIdentity && !claims.includes(p.claimedIdentity)) claims.push(p.claimedIdentity);
        {
          const fresh = (p.tactics ?? []).filter((t: string) => !seenTactics.has(t));
          fresh.forEach((t: string) => seenTactics.add(t));
          if (fresh.length) tactics.push({ labels: fresh.map((t: string) => TACTIC_LABEL[t] ?? t), quote: p.evidenceQuote ?? "" });
        }
        break;
      case "assessment":
        for (const r of [...(p.reasons ?? []), ...(p.anomalies ?? [])]) for (const m of String(r).matchAll(/POL-\d+/g)) policyIds.add(m[0]);
        if (p.state !== lastState) {
          timeline.push({ ts: e.ts, kind: "state", text: `Risk: ${STATE_COPY[p.state as keyof typeof STATE_COPY]?.word ?? p.state}${p.whisper ? `. ${p.whisper}` : ""}`, tone: p.state });
          if (p.state === "ALERT" && firstAlertLine === null) firstAlertLine = callerLine || null;
          lastState = p.state;
        }
        break;
      case "tool_call":
        timeline.push({
          ts: e.ts,
          kind: "action",
          who: p.by === "agent" ? "Agent" : "VerifyDesk",
          text: `${TOOL_LABEL[p.name] ?? p.name}${p.error ? ` (refused: ${p.error})` : ""}`,
          tone: p.error ? "bad" : undefined,
        });
        break;
      case "push_resolved":
        timeline.push({ ts: e.ts, kind: "push", who: "Employee's phone", text: p.approved ? "The real employee approved the check." : "The real employee denied the check.", tone: p.approved ? "good" : "bad" });
        break;
      case "decision":
        timeline.push({
          ts: e.ts,
          kind: "decision",
          text: p.decision === "approved" ? "Decision: approved after verification." : `Decision: blocked${p.ticketId ? `, security ticket ${p.ticketId} opened` : ""}.`,
          tone: p.decision === "approved" ? "good" : "bad",
        });
        break;
    }
  }

  const start = sorted.find((e) => e.type === "call_started");
  const outcome = view.decision?.decision ?? "open";
  const who = view.employee ? `${view.employee.name} (${view.employee.title})` : claims[0] ? `"${claims[0]}"` : "an unidentified person";
  const request = view.assessment?.requestedAction && view.assessment.requestedAction !== "none" ? ACTION_LABEL[view.assessment.requestedAction] : null;
  const push = view.pushes[view.pushes.length - 1];
  const pushedBy = sorted.some((e) => e.type === "tool_call" && (e.payload as any).name === "send_push_challenge" && (e.payload as any).by === "agent") ? "the agent" : "VerifyDesk";

  const parts = [`A caller claiming to be ${who} ${request ? `asked for: ${/^[A-Z][a-z]/.test(request) ? request.charAt(0).toLowerCase() + request.slice(1) : request}` : "contacted the help desk"}.`];
  if (firstAlertLine) parts.push(`VerifyDesk raised an alert after caller line ${firstAlertLine}.`);
  if (push) {
    const device = view.devices.find((d) => d.id === push.deviceId)?.label ?? "the registered phone";
    parts.push(
      `${pushedBy === "the agent" ? "The agent" : "VerifyDesk"} sent a verification push to ${device}` +
        (push.status === "approved" ? ", and the real employee approved it." : push.status === "denied" ? ", and the real employee denied it." : ", which was not answered."),
    );
  }
  if (outcome === "blocked") parts.push(`The request was blocked${view.decision?.ticketId ? ` and security ticket ${view.decision.ticketId} was opened` : ""}.`);
  if (outcome === "approved") parts.push("The caller was verified and the request was allowed.");
  if (outcome === "open") parts.push("No decision was made before the call ended.");

  return {
    view,
    title: outcome === "blocked" ? "Security incident report" : "Call verification report",
    startedAt: start?.ts ?? sorted[0]?.ts ?? 0,
    endedAt: sorted[sorted.length - 1]?.ts ?? 0,
    mode: MODE_LABEL[view.scenario ?? ""] ?? (view.scenario ? `Scripted call: ${view.scenario}` : "Call"),
    model: view.llm,
    claims,
    summary: parts.join(" "),
    outcome,
    firstAlertLine,
    tactics,
    policies: policies.filter((p) => policyIds.has(p.id)),
    timeline,
  };
}
