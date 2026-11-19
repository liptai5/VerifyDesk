// The AI verifier agent: what it's told, how we ask it, and the standard lines it falls back to.

import { z } from "zod";
import type { LLMProvider } from "../providers/types.js";
import type { AgentTool, LineKind } from "./guards.js";

export type AgentTask = "decide" | Exclude<LineKind, "question">;

// The AI's answer: which tool, what to say, and why.
export const AgentReply = z.object({
  tool: z.enum(["send_push_challenge", "ask_caller", "none"]),
  say: z.string(),
  reason: z.string(),
});
export type AgentReply = z.infer<typeof AgentReply>;

const AGENT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    tool: { type: "string", enum: ["send_push_challenge", "ask_caller", "none"] },
    say: { type: "string" },
    reason: { type: "string" },
  },
  required: ["tool", "say", "reason"],
};

// Instructions for the AI agent. Change the wording rules here.
export const AGENT_SYSTEM = `You are VerifyDesk, an AI identity verifier on an IT help-desk phone call. The help-desk agent says your lines to the caller.
Tools:
- send_push_challenge: send a verification check to the claimed employee's registered phone. "say" tells the caller it was sent and asks them to approve it.
- ask_caller: ask ONE short question to learn who the caller is or what they need.
- none: do nothing now ("say" is "").
Only use a tool listed under "Allowed tools". If the task is not "decide", use tool "none" and only write "say".
Rules for "say":
- One or two short sentences, warm and plain, max 40 words. Fit what the caller just said (e.g. acknowledge time pressure).
- The registered phone is the only way to verify. Never verify with personal questions (birthday, address, manager, employee ID).
- Never mention what the records say (locations, devices, numbers, colleagues). Never accuse the caller: the real employee may be on the line.
- Never ask for or give out passwords or codes. Never say a change was made: the agent makes changes after verification.
"reason": one sentence for the help-desk agent (not the caller) explaining your choice.
Return JSON: {"tool": ..., "say": ..., "reason": ...}`;

export interface AgentInput {
  task: AgentTask;
  allowed: AgentTool[];
  transcript: { channel: "caller" | "agent" | "verifier"; text: string }[];
  claimed: string | null;
  employee: { name: string; title: string; hasPushPhone: boolean } | null;
  policy: {
    state: string;
    action: string;
    request: string;
    tactics: string[];
    mustVerify: boolean;
    concerns: string[];
  };
  questionsAsked: string[];
}

const SPEAKER = { caller: "Caller", agent: "Agent", verifier: "VerifyDesk" } as const;

const TASK_TEXT: Record<AgentTask, string> = {
  decide: "decide: choose what to do after the caller's last line.",
  verify: "verify: the help-desk agent has just sent a check to the registered phone. Write the line telling the caller.",
  approved: "approved: the real employee approved the check on their registered phone. Write the line telling the caller they're verified and the agent can now help with their request.",
  denied: "denied: the check was declined on the registered phone. Write the line refusing the request; suggest contacting the service desk from their registered phone if it's a mistake.",
  no_phone: "no_phone: the employee has no registered phone that can get a check, so they can't be verified on this call. Write the line refusing the request and saying it was passed to the security team.",
};

// Writes the call summary the AI reads.
export function renderInput(i: AgentInput): string {
  const lines = i.transcript.slice(-8).map((t) => `${SPEAKER[t.channel]}: ${t.text}`);
  return [
    `Task: ${TASK_TEXT[i.task]}`,
    `Allowed tools: ${i.task === "decide" ? i.allowed.join(", ") : "none"}`,
    `Risk: ${i.policy.state}. Request: ${i.policy.request}. Pressure tactics: ${i.policy.tactics.join(", ") || "none"}. Check required by policy: ${i.policy.mustVerify ? "yes" : "no"}.`,
    `Caller claims to be: ${i.claimed ?? "not said yet"}. Matching record: ${i.employee ? `${i.employee.name}, ${i.employee.title} (registered phone for checks: ${i.employee.hasPushPhone ? "yes" : "no"})` : "none found"}.`,
    i.policy.concerns.length ? `Concerns (for your reasoning only, never tell the caller): ${i.policy.concerns.join(" ")}` : "",
    `Questions already asked: ${i.questionsAsked.length ? i.questionsAsked.map((q) => `"${q}"`).join(", ") : "none"}`,
    "Call so far:",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface AgentAnswer {
  reply: AgentReply | null;
  ms: number;
  error: string | null;
}

// This calls the AI agent. Never fails: on any problem the standard step is used.
export async function askAgent(llm: LLMProvider, input: AgentInput, timeoutMs = 15_000): Promise<AgentAnswer> {
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${+(timeoutMs / 1000).toFixed(1)} s`)), timeoutMs);
  });
  try {
    const ask = llm.json({
      system: AGENT_SYSTEM,
      user: renderInput(input),
      schema: AgentReply,
      jsonSchema: AGENT_JSON_SCHEMA,
      mock: () => scriptedAgent(input),
      fast: { timeoutMs },
    });
    const { value } = await Promise.race([ask, timeout]);
    return { reply: value, ms: Math.round(performance.now() - t0), error: null };
  } catch (e) {
    return { reply: null, ms: Math.round(performance.now() - t0), error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Plain words for each request.
export const ACTION_LABEL: Record<string, string> = {
  password_reset: "password reset",
  mfa_reset: "MFA change",
  send_code: "login code",
  new_device: "device enrolment",
  privilege_change: "access change",
  payment_change: "payment change",
  remote_access: "remote session",
};

// Standard ending lines, matched to what the caller asked for.
export function outcomeLine(outcome: "approved" | "denied" | "no_phone", action: string, name: string): string {
  const refused =
    action === "send_code"
      ? "I can't send any codes or sign-in details on this call"
      : action === "none"
        ? "I can't help with this account on this call"
        : "I can't make this change on this call";
  if (outcome === "approved") {
    if (action === "none") return "Thanks, you're verified.";
    if (action === "send_code") return "Thanks, you're verified. Any code will go to your registered phone only.";
    return `Thanks, you're verified. The agent can now complete your ${ACTION_LABEL[action] ?? "request"}.`;
  }
  if (outcome === "denied") {
    return `The verification was declined on the registered phone, so ${refused}. If this is a mistake, please contact the service desk from your registered phone.`;
  }
  return `I can't verify ${name} on this call because there's no registered phone to send a check to, so ${refused}. I've passed the request to the security team.`;
}

// Standard line when a check is sent.
export function verifyLine(name: string): string {
  return `For security, I've sent a verification prompt to the phone registered to ${name}. Please approve it there and we'll continue.`;
}

// What VerifyDesk says when the agent ends a call that opened a security ticket.
export function closingLine(reason: "denied" | "no_phone"): string {
  return reason === "denied"
    ? "The agent has ended this call. This call and the number it came from have been reported to the security team."
    : "The agent has ended this call. Your request has been passed to the security team.";
}

// Demo mode: picks a check line that fits the caller's pressure.
function tailoredVerifyLine(name: string, tactics: string[]): string {
  if (tactics.includes("new_contact_channel")) {
    return `For security, I can only use the phone already registered to ${name}, so I've sent a verification prompt there. Please approve it and we'll continue.`;
  }
  if (tactics.includes("process_bypass")) {
    return `I can't skip this step, but it's quick: I've sent a verification prompt to the phone registered to ${name}. Please approve it there and we'll continue.`;
  }
  if (tactics.includes("urgency")) {
    return `I know you're short on time, so this will be quick: I've sent a verification prompt to the phone registered to ${name}. Please approve it there and we'll continue.`;
  }
  return verifyLine(name);
}

const TACTIC_WORDS: Record<string, string> = {
  urgency: "time pressure",
  authority: "seniority",
  isolation: "secrecy",
  process_bypass: "skipping the checks",
  sympathy: "an emotional appeal",
  new_contact_channel: "a new contact number",
};

const listWords = (w: string[]) => (w.length < 2 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`);

// Demo mode and tests: gives the same kind of answer as the AI agent, without calling an AI.
export function scriptedAgent(i: AgentInput): AgentReply {
  const name = i.employee?.name ?? "the employee";
  const first = i.employee?.name.split(" ")[0];
  switch (i.task) {
    case "decide": {
      if (i.allowed.includes("send_push_challenge") && i.policy.mustVerify) {
        const pressure = i.policy.tactics.map((t) => TACTIC_WORDS[t] ?? t);
        return {
          tool: "send_push_challenge",
          say: tailoredVerifyLine(name, i.policy.tactics),
          reason: `This ${i.policy.request} needs a check on the registered phone${pressure.length ? `, and the caller is using ${listWords(pressure)}` : ""}.`,
        };
      }
      if (i.allowed.includes("ask_caller") && !i.employee && i.policy.request !== "nothing yet" && i.questionsAsked.length === 0) {
        return {
          tool: "ask_caller",
          say: "Happy to help with that. Could I have your full name, please?",
          reason: "The caller asked for something but hasn't said who they are, so there's no one to send a check to yet.",
        };
      }
      return { tool: "none", say: "", reason: "Nothing to act on yet." };
    }
    case "verify":
      return { tool: "none", say: tailoredVerifyLine(name, i.policy.tactics), reason: "The agent sent a check." };
    case "approved":
    case "denied":
    case "no_phone": {
      const say = outcomeLine(i.task, i.policy.action, name);
      const personal = i.task === "approved" && first ? say.replace("Thanks, you're", `Thanks, ${first}, you're`) : say;
      return { tool: "none", say: personal, reason: `Ending line for: ${i.task.replace("_", " ")}.` };
    }
  }
}
