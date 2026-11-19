// The actions VerifyDesk can take (look up, send a check, block, approve, open a ticket), with their hard
// guards.

import type { Store, PushChallenge } from "../data/store.js";

export interface ToolContext {
  store: Store;
  callId: string;
  onPushSent?: (c: PushChallenge) => void;
}

export class ToolError extends Error {}

type Args = Record<string, unknown>;

function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`Missing argument "${key}"`);
  return v.trim();
}

// Each tool. approve_reset refuses unless the real employee approved on this call.
export const tools = {
  lookup_employee(ctx: ToolContext, args: Args) {
    const e = ctx.store.findEmployee(str(args, "query"));
    if (!e) return { found: false };
    const devices = ctx.store.devicesFor(e.id).map((d) => ({
      id: d.id,
      type: d.type,
      label: d.label,
      pushEnabled: d.pushEnabled,
      lastSeenMinutesAgo: ctx.store.minutesAgo(d.lastSeenAt),
      lastLocation: d.lastLocation,
    }));
    return { found: true, employee: e, devices };
  },

  get_recent_identity_events(ctx: ToolContext, args: Args) {
    const id = str(args, "employeeId");
    const hours = typeof args.hours === "number" ? args.hours : 24;
    return {
      employeeId: id,
      events: ctx.store.eventsFor(id, hours).map((e) => ({
        type: e.type,
        minutesAgo: ctx.store.minutesAgo(e.at),
        location: e.location,
        detail: e.detail ?? null,
      })),
    };
  },

  send_push_challenge(ctx: ToolContext, args: Args) {
    const employeeId = str(args, "employeeId");
    const reason = typeof args.reason === "string" ? args.reason : "Help-desk identity verification";
    if (!ctx.store.employeeById(employeeId)) throw new ToolError(`Unknown employee ${employeeId}`);
    const device = ctx.store
      .devicesFor(employeeId)
      .filter((d) => d.pushEnabled)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    if (!device) return { sent: false, reason: "No registered phone that can receive a verification push." };
    const existing = [...ctx.store.challenges.values()].find(
      (c) => c.callId === ctx.callId && c.employeeId === employeeId && c.status === "pending",
    );
    if (existing) return { sent: true, challengeId: existing.id, deviceLabel: device.label, duplicate: true };
    const challenge: PushChallenge = {
      id: ctx.store.nextId("PUSH"),
      employeeId,
      deviceId: device.id,
      callId: ctx.callId,
      reason,
      status: "pending",
      createdAt: ctx.store.now(),
    };
    ctx.store.challenges.set(challenge.id, challenge);
    ctx.onPushSent?.(challenge);
    return { sent: true, challengeId: challenge.id, deviceLabel: device.label };
  },

  block_reset(ctx: ToolContext, args: Args) {
    const employeeId = str(args, "employeeId");
    const reason = typeof args.reason === "string" ? args.reason : "Verification failed";
    ctx.store.decisions.push({ callId: ctx.callId, employeeId, decision: "blocked", reason, at: ctx.store.now() });
    return { blocked: true, employeeId, reason };
  },

  approve_reset(ctx: ToolContext, args: Args) {
    const employeeId = str(args, "employeeId");
    const verified = [...ctx.store.challenges.values()].some(
      (c) => c.callId === ctx.callId && c.employeeId === employeeId && c.status === "approved",
    );
    if (!verified) throw new ToolError("Refused: no approved out-of-band verification for this call (POL-01).");
    ctx.store.decisions.push({ callId: ctx.callId, employeeId, decision: "approved", reason: "Verified", at: ctx.store.now() });
    return { approved: true, employeeId };
  },

  create_incident_ticket(ctx: ToolContext, args: Args) {
    const summary = str(args, "summary");
    const evidence = Array.isArray(args.evidence) ? args.evidence.map(String) : [];
    const ticket = {
      id: ctx.store.nextId("SEC"),
      callId: ctx.callId,
      employeeId: typeof args.employeeId === "string" ? args.employeeId : null,
      summary,
      evidence,
      createdAt: ctx.store.now(),
    };
    ctx.store.tickets.push(ticket);
    return { created: true, ticketId: ticket.id };
  },
} as const;

export type ToolName = keyof typeof tools;
export const TOOL_NAMES = Object.keys(tools) as ToolName[];

export function isToolName(n: string): n is ToolName {
  return (TOOL_NAMES as string[]).includes(n);
}

// Runs a tool by name after checking its arguments.
export function runTool(ctx: ToolContext, name: ToolName, args: Args): unknown {
  return tools[name](ctx, args);
}

// The tools described in the standard AI tool format.
export const TOOL_DEFINITIONS = [
  def("lookup_employee", "Find an employee in the corporate directory by name, title or id.", {
    query: { type: "string", description: "Name, title or employee id, e.g. 'Jane Doe' or 'CFO'" },
  }, ["query"]),
  def("get_recent_identity_events", "Recent sign-in, MFA and device events for an employee.", {
    employeeId: { type: "string" },
    hours: { type: "number", description: "Look-back window, default 24" },
  }, ["employeeId"]),
  def("send_push_challenge", "Send a verification push to the employee's REGISTERED device (never to a number given on the call).", {
    employeeId: { type: "string" },
    reason: { type: "string" },
  }, ["employeeId"]),
  def("block_reset", "Block the requested credential change.", {
    employeeId: { type: "string" },
    reason: { type: "string" },
  }, ["employeeId", "reason"]),
  def("approve_reset", "Approve the credential change. Fails unless out-of-band verification was approved.", {
    employeeId: { type: "string" },
  }, ["employeeId"]),
  def("create_incident_ticket", "Open a security incident ticket with quoted evidence.", {
    summary: { type: "string" },
    employeeId: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
  }, ["summary"]),
];

function def(name: ToolName, description: string, properties: Record<string, unknown>, required: string[]) {
  return {
    type: "function" as const,
    function: { name, description, parameters: { type: "object", properties, required } },
  };
}
