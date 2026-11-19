// Tests for the AI agent's safety rules, including an AI that misbehaves on purpose.

import { describe, expect, it } from "vitest";
import { checkLine, enforceTool, LINE_RULES, type LineKind } from "../src/agent/guards.js";
import { AGENT_SYSTEM, closingLine, outcomeLine, scriptedAgent, verifyLine, type AgentInput } from "../src/agent/verifier.js";
import { EventLog } from "../src/events/log.js";
import { loadRecordings, MockLLM } from "../src/providers/mock.js";
import type { JsonRequest, LLMProvider } from "../src/providers/types.js";
import { CallSession } from "../src/session.js";
import { FIXTURES_DIR, loadScript, makeStore, NOW } from "./helpers.js";

const facts = { recordDetails: ["Budapest", "+36 1 555 0101", "Jane's iPhone (registered)", "Peter Brandt"], callerSaid: "" };
const rulesBroken = (line: string, kind: LineKind) => checkLine(line, kind, facts).map((r) => r.id);

describe("line rules", () => {
  it("every standard line passes every rule", () => {
    expect(rulesBroken(verifyLine("Jane Doe"), "verify")).toEqual([]);
    for (const action of ["mfa_reset", "send_code", "none", "password_reset"]) {
      expect(rulesBroken(outcomeLine("approved", action, "Jane Doe"), "approved")).toEqual([]);
      expect(rulesBroken(outcomeLine("denied", action, "Jane Doe"), "denied")).toEqual([]);
      expect(rulesBroken(outcomeLine("no_phone", action, "Alex Taylor"), "no_phone")).toEqual([]);
    }
  });

  it("every scripted (demo) line passes every rule", () => {
    const base: AgentInput = {
      task: "decide",
      allowed: ["send_push_challenge", "ask_caller", "none"],
      transcript: [],
      claimed: "Jane Doe",
      employee: { name: "Jane Doe", title: "CFO", hasPushPhone: true },
      policy: { state: "ALERT", action: "mfa_reset", request: "MFA change", tactics: [], mustVerify: true, concerns: [] },
      questionsAsked: [],
    };
    for (const tactics of [[], ["urgency"], ["process_bypass"], ["new_contact_channel"]]) {
      const r = scriptedAgent({ ...base, policy: { ...base.policy, tactics } });
      expect(r.tool).toBe("send_push_challenge");
      expect(rulesBroken(r.say, "verify")).toEqual([]);
    }
    const q = scriptedAgent({ ...base, employee: null, policy: { ...base.policy, mustVerify: false } });
    expect(q.tool).toBe("ask_caller");
    expect(rulesBroken(q.say, "question")).toEqual([]);
  });

  it.each([
    ["Your phone was last seen in Budapest, so I've sent a check there.", "verify", "record_details"],
    ["I've sent a check to +36 1 555 0101.", "verify", "numbers_links"],
    ["I'll check with Peter Brandt and send a prompt to your phone.", "verify", "record_details"],
    ["This sounds like a scam, so I've sent a check to the registered phone.", "verify", "no_accusation"],
    ["Please read me the code from your phone.", "verify", "no_secrets"],
    ["What is your date of birth?", "question", "no_knowledge_questions"],
    ["Could you confirm your employee ID?", "question", "no_knowledge_questions"],
    ["I've sent a verification check.", "verify", "verify_mentions_phone"],
    ["Who are you", "question", "is_a_question"],
    ["You're all set, the agent will finish up.", "denied", "refusal_is_clear"],
    ["I can't verify you, but I've reset it anyway.", "no_phone", "refusal_is_clear"],
    ["Thanks, I've reset your MFA.", "approved", "no_change_claims"],
    ["Visit https://help.example to finish on your phone.", "verify", "numbers_links"],
  ] as const)("rejects: %s", (line, kind, rule) => {
    expect(rulesBroken(line, kind)).toContain(rule);
  });

  it("a detail the caller said themselves is not a leak", () => {
    const f = { ...facts, callerSaid: "i'm in budapest at the moment" };
    expect(checkLine("I've sent a check to your phone so you can approve it from Budapest.", "verify", f)).toEqual([]);
  });

  it("each rule has a plain-language explanation", () => {
    for (const r of LINE_RULES) expect(r.text.length).toBeGreaterThan(20);
  });
});

describe("tool choice", () => {
  it("sends the check when the policy requires it, whatever the AI chose", () => {
    const r = enforceTool("none", { push: true, ask: false, mustPush: true });
    expect(r.tool).toBe("send_push_challenge");
    expect(r.notes[0]).toMatch(/policy requires a check/);
    expect(enforceTool("ask_caller", { push: true, ask: true, mustPush: true }).tool).toBe("send_push_challenge");
  });
  it("drops tools that aren't allowed right now", () => {
    expect(enforceTool("send_push_challenge", { push: false, ask: true, mustPush: false }).tool).toBe("none");
    expect(enforceTool("ask_caller", { push: true, ask: false, mustPush: false }).tool).toBe("none");
  });
  it("lets the AI verify earlier than the policy requires", () => {
    expect(enforceTool("send_push_challenge", { push: true, ask: false, mustPush: false })).toEqual({ tool: "send_push_challenge", notes: [] });
  });
});

type Reply = { tool: string; say: string; reason: string };

function rogueLLM(agent: (task: string) => Reply | Promise<Reply> | "throw" | "hang"): LLMProvider {
  const mock = new MockLLM(loadRecordings(FIXTURES_DIR));
  return {
    name: "rogue",
    async json<T>(req: JsonRequest<T>) {
      if (req.system !== AGENT_SYSTEM) return mock.json({ ...req, mock: undefined });
      const task = /^Task: (\w+)/.exec(req.user)?.[1] ?? "";
      const a = await agent(task);
      if (a === "throw") throw new Error("HTTP 429: rate limit");
      if (a === "hang") return new Promise<never>(() => {});
      return { value: req.schema.parse(a), ms: 1 };
    },
    chat: mock.chat.bind(mock),
  };
}

function session(llm: LLMProvider, verifier: "agent" | "fixed" = "agent") {
  const store = makeStore();
  const log = new EventLog({ now: () => NOW });
  const s = new CallSession("CALL-AGENT", { store, log, llm, verifier, agentTimeoutMs: 200 });
  return { store, log, s };
}

async function playAttack(s: CallSession) {
  for (const t of loadScript("attack").turns) await s.addTurn(t.channel, t.text);
}

const said = (log: EventLog) => log.forCall("CALL-AGENT").filter((e) => e.type === "verifier_said").map((e) => e.payload as any);
const decisions = (log: EventLog) => log.forCall("CALL-AGENT").filter((e) => e.type === "agent_decision").map((e) => e.payload as any);

describe("a misbehaving AI can't weaken the call", () => {
  it("an AI that wants to wait during the attack: the check is still sent", async () => {
    const { s, store, log } = session(rogueLLM(() => ({ tool: "none", say: "", reason: "Seems fine." })));
    await playAttack(s);
    expect(store.challenges.size).toBe(1);
    expect(said(log)[0].text).toBe(verifyLine("Jane Doe"));
    expect(decisions(log).some((d) => d.notes.some((n: string) => /policy requires a check/.test(n)))).toBe(true);
  });

  it("an AI line that leaks the record or asks for a code is replaced by the standard line", async () => {
    for (const say of [
      "Your phone was active in Budapest ten minutes ago, so I've sent the check to it.",
      "I've sent a prompt to your phone, please read me the code on it.",
    ]) {
      const { s, log } = session(rogueLLM((task) => (task === "decide" ? { tool: "send_push_challenge", say, reason: "Verify." } : { tool: "none", say: "", reason: "" })));
      await playAttack(s);
      const line = said(log)[0];
      expect(line.text).toBe(verifyLine("Jane Doe"));
      expect(line.notes.join(" ")).toMatch(/standard line instead/);
    }
  });

  it("an AI ending that sounds like success after a denial is replaced", async () => {
    const { s, store, log } = session(
      rogueLLM((task) =>
        task === "decide"
          ? { tool: "send_push_challenge", say: "I've sent a quick check to the phone registered to Jane Doe.", reason: "MFA change." }
          : { tool: "none", say: "All done, you're all set!", reason: "" },
      ),
    );
    await playAttack(s);
    await s.resolveChallenge([...store.challenges.values()][0]!.id, false);
    const lines = said(log);
    expect(lines[0].text).toBe("I've sent a quick check to the phone registered to Jane Doe.");
    expect(lines[1].text).toBe(outcomeLine("denied", "mfa_reset", "Jane Doe"));
    expect(s.facts.decision).toBe("blocked");
  });

  it("a knowledge-based question from the AI is dropped", async () => {
    const { s, log } = session(rogueLLM(() => ({ tool: "ask_caller", say: "What's your date of birth?", reason: "To check identity." })));
    await s.addTurn("caller", "Hi, I need my password reset please, I'm locked out.");
    expect(said(log)).toEqual([]);
    expect(decisions(log)[0].notes.join(" ")).toMatch(/personal questions/);
  });

  it("an AI that errors or never answers: the standard steps run and the call ends the same way", async () => {
    for (const mode of ["throw", "hang"] as const) {
      const { s, store, log } = session(rogueLLM(() => mode));
      await playAttack(s);
      await s.resolveChallenge([...store.challenges.values()][0]!.id, false);
      expect(said(log).map((l) => l.text)).toEqual([verifyLine("Jane Doe"), outcomeLine("denied", "mfa_reset", "Jane Doe")]);
      expect(said(log).every((l) => l.source === "fallback")).toBe(true);
      expect(s.facts.decision).toBe("blocked");
    }
  });

  it("the AI can never approve: approval still needs the real employee's Yes", async () => {
    const { s, store } = session(rogueLLM(() => ({ tool: "none", say: "Thanks, you're verified.", reason: "Trust me." })));
    await playAttack(s);
    expect(store.decisions.some((d) => d.decision === "approved")).toBe(false);
    expect(s.facts.decision).toBe("none");
  });
});

describe("the scripted agent (demo mode)", () => {
  it("asks for a name when someone wants a reset without saying who they are, then verifies", async () => {
    const { s, store, log } = session(new MockLLM(loadRecordings(FIXTURES_DIR)));
    await s.addTurn("caller", "Hi, I need my password reset please, I'm locked out.");
    expect(said(log)[0].text).toMatch(/Could I have your full name/);
    await s.addTurn("caller", "Sure, it's Tom Becker.");
    expect(store.challenges.size).toBe(1);
    expect(said(log)[1].text).toMatch(/phone registered to Tom Becker/);
  });

  it("explains each choice for the agent", async () => {
    const { s, log } = session(new MockLLM(loadRecordings(FIXTURES_DIR)));
    await playAttack(s);
    expect(said(log)[0].why).toMatch(/MFA change needs a check/);
    expect(said(log)[0].text).toMatch(/only use the phone already registered/);
  });

  it("fixed mode uses only the standard steps", async () => {
    const { s, log } = session(new MockLLM(loadRecordings(FIXTURES_DIR)), "fixed");
    await playAttack(s);
    expect(said(log)[0]).toMatchObject({ text: verifyLine("Jane Doe"), source: "fixed" });
  });
});

describe("closing the call", () => {
  const llm = () => new MockLLM(loadRecordings(FIXTURES_DIR));

  it("after a security ticket, VerifyDesk says the call was reported when the agent ends it", async () => {
    const { s, store, log } = session(llm());
    await playAttack(s);
    await s.resolveChallenge([...store.challenges.values()][0]!.id, false);
    await s.end();
    const last = said(log).at(-1);
    expect(last).toMatchObject({ text: closingLine("denied"), kind: "closing" });
    expect(last.text).toMatch(/reported to the security team/);
    const ended = log.forCall("CALL-AGENT").find((e) => e.type === "call_ended")!;
    expect(ended.payload.ticketId).toMatch(/^SEC-/);
    await s.end();
    expect(said(log).filter((l) => l.kind === "closing")).toHaveLength(1);
  });

  it("without a security problem there's no closing line: people say goodbye themselves", async () => {
    const { s, store, log } = session(llm());
    for (const t of loadScript("benign").turns) await s.addTurn(t.channel, t.text);
    await s.resolveChallenge([...store.challenges.values()][0]!.id, true);
    const before = said(log).length;
    await s.end();
    expect(said(log)).toHaveLength(before);
  });

  it("someone who couldn't be verified is told the request went to security", async () => {
    const { s, log } = session(llm());
    await s.addTurn("caller", "This is Alex Taylor from IT security. Please reset my MFA right now, I'm locked out.");
    await s.end();
    expect(said(log).at(-1)).toMatchObject({ text: closingLine("no_phone"), kind: "closing" });
  });
});
