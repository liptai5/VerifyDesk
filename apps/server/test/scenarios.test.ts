// Plays the scripted calls and the README test plan, and checks the results.

import { describe, expect, it } from "vitest";
import { heuristicExtract } from "../src/extractor.js";
import type { LLMProvider } from "../src/providers/types.js";
import { loadScript, makeSession, play } from "./helpers.js";

const rulesOnly: LLMProvider = {
  name: "rules",
  async json(req) {
    return { value: req.schema.parse(heuristicExtract(req.mockKey ?? "")), ms: 0 };
  },
  async chat() {
    return { content: "", toolCalls: [], ms: 0 };
  },
};

for (const [label, llm] of [["recorded LLM answers", undefined], ["rule-based fallback", rulesOnly]] as const) {
  describe(`end-to-end call scripts (${label})`, () => {
    for (const name of ["attack", "benign"]) {
      it(name, async () => {
        const script = loadScript(name);
        const { session, log, store } = makeSession(llm);
        const states = await play(session, script);
        const exp = script.expected;

        if (exp.alertByCallerTurn) {
          expect(states.slice(0, exp.alertByCallerTurn)).toContain("ALERT");
        }
        if (exp.neverAlert) expect(states).not.toContain("ALERT");

        const pushes = [...store.challenges.values()];
        expect(pushes).toHaveLength(1);
        expect(pushes[0]!.employeeId).toBe(exp.deviceEmployeeId);

        const final = await session.resolveChallenge(pushes[0]!.id, exp.devicePress === "approve");
        expect(final.state).toBe(exp.finalState);
        expect(session.facts.decision).toBe(exp.decision);

        const types = log.forCall(session.id).map((e) => e.type);
        expect(types).toContain("push_sent");
        expect(types).toContain("verifier_said");
        expect(types).toContain("decision");
        if (exp.decision === "blocked") expect(store.tickets).toHaveLength(1);
        else expect(store.tickets).toHaveLength(0);
      });
    }
  });
}

describe("free-form live call, rule-based fallback (regression from a real test)", () => {
  it("catches an improvised fake-CFO call without any AI", async () => {
    const { session, store } = makeSession(rulesOnly);
    const lines: [string, string][] = [
      ["agent", "Do IT Better Solutions service desk, this is Peter. How can I help?"],
      ["caller", "hi Mark"],
      ["caller", "I am the CFO"],
      ["caller", "and I am stuck in traffic"],
      ["caller", "could you send me mfa code"],
    ];
    const states: string[] = [];
    for (const [ch, text] of lines) {
      const a = await session.addTurn(ch as "caller" | "agent", text);
      if (ch === "caller") states.push(a?.state ?? "none");
    }
    expect(session.facts.employee?.name).toBe("Jane Doe");
    expect(states).toEqual(["SAFE", "SAFE", "WATCH", "ALERT"]);
    expect([...store.challenges.values()]).toHaveLength(1);
  });

  it("recognises 'no verification needed' as skipping checks", async () => {
    const { heuristicExtract } = await import("../src/extractor.js");
    expect(heuristicExtract("no verification needed").tactics).toContain("process_bypass");
    expect(heuristicExtract("give me my code please").requestedAction).toBe("send_code");
  });
});

describe("agent-initiated verification", () => {
  it("lets the agent verify a caller VerifyDesk thinks is safe", async () => {
    const { session, store, log } = makeSession(rulesOnly);
    await session.addTurn("caller", "hi, could you help me with something");
    expect(session.lastAssessment?.state).toBe("SAFE");
    const a = await session.manualVerify("E1001");
    expect(session.facts.employee?.name).toBe("Jane Doe");
    const pushes = [...store.challenges.values()];
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.reason).toContain("requested by the agent");
    expect(a.anomalies.length).toBeGreaterThanOrEqual(0);
    const toolEvents = log.forCall(session.id).filter((e) => e.type === "tool_call");
    expect(toolEvents.every((e) => e.payload.by === "agent")).toBe(true);
    await session.resolveChallenge(pushes[0]!.id, false);
    expect(session.facts.decision).toBe("blocked");
    expect(store.tickets).toHaveLength(1);
  });

  it("refuses without an employee, and refuses a second push while one is waiting", async () => {
    const { session } = makeSession(rulesOnly);
    await expect(session.manualVerify()).rejects.toThrow(/Choose which employee/);
    await session.manualVerify("E1004");
    await expect(session.manualVerify()).rejects.toThrow(/already waiting/);
  });

  it("VerifyDesk doesn't send its own push after the agent already did", async () => {
    const { session, store } = makeSession(rulesOnly);
    await session.manualVerify("E1001");
    await session.addTurn("caller", "This is Jane Doe, the CFO. Move my MFA to my new number right now!");
    expect([...store.challenges.values()]).toHaveLength(1);
  });
});

describe("live call: wrong name for the role", () => {
  it("'my name is Mark, I am the CFO' finds Jane and flags the mismatch", async () => {
    const { session } = makeSession(rulesOnly);
    await session.addTurn("caller", "Hi, my name is Mark. I am the CFO of");
    expect(session.facts.employee?.name).toBe("Jane Doe");
    expect(session.facts.findings.map((f) => f.code)).toContain("name_mismatch");
    const a = await session.addTurn("caller", "Can you give me my login code please?");
    expect(a?.state).toBe("ALERT");
  });
});

describe("no registered phone", () => {
  it("blocks the change and opens a ticket instead of any other way of verifying", async () => {
    const { session, store, log } = makeSession(rulesOnly);
    await session.addTurn("caller", "This is Alex Taylor from IT security. Please reset my MFA right now, I'm locked out.");
    expect(session.facts.employee?.name).toBe("Alex Taylor");
    expect(store.challenges.size).toBe(0);
    expect(session.facts.decision).toBe("blocked");
    expect(store.tickets).toHaveLength(1);
    const tools = log.forCall(session.id).filter((e) => e.type === "tool_call").map((e) => e.payload.name);
    expect(tools).not.toContain("place_callback");
    expect(tools).toContain("block_reset");
  });
});

describe("ending lines fit the request", () => {
  it("covers changes, codes and plain account help", async () => {
    const { outcomeLine } = await import("../src/session.js");
    expect(outcomeLine("denied", "mfa_reset", "Jane Doe")).toMatch(/can't make this change/);
    expect(outcomeLine("denied", "send_code", "Jane Doe")).toMatch(/can't send any codes or sign-in details/);
    expect(outcomeLine("denied", "none", "Jane Doe")).toMatch(/can't help with this account/);
    expect(outcomeLine("approved", "send_code", "Jane Doe")).toMatch(/registered phone only/);
    expect(outcomeLine("approved", "none", "Jane Doe")).toBe("Thanks, you're verified.");
    expect(outcomeLine("no_phone", "send_code", "Alex Taylor")).toMatch(/no registered phone.*codes/);
  });

  it("'this is Mark, the CFO' is WATCH on the first line", async () => {
    const { session } = makeSession(rulesOnly);
    const a = await session.addTurn("caller", "Hi, this is Mark, the CFO. I can't seem to log in.");
    expect(session.facts.employee?.name).toBe("Jane Doe");
    expect(a?.state).toBe("WATCH");
  });
});

describe("README test plan, demo mode", () => {
  const run = async (lines: string[]) => {
    const ctx = makeSession(rulesOnly);
    const states: string[] = [];
    for (const l of lines) states.push((await ctx.session.addTurn("caller", l))?.state ?? "none");
    return { ...ctx, states };
  };

  it("test 1: fake CFO", async () => {
    const { session, states, store } = await run([
      "Hi, this is Mark, the CFO.",
      "I'm at the airport and my phone was stolen.",
      "Can you just send me my login code? I'm boarding now.",
    ]);
    expect(states).toEqual(["WATCH", "WATCH", "ALERT"]);
    expect(session.facts.requestedAction).toBe("send_code");
    await session.resolveChallenge([...store.challenges.values()][0]!.id, false);
    expect(session.facts.decision).toBe("blocked");
  });

  it("test 2: the real Tom", async () => {
    const { session, states, store } = await run([
      "Hi, it's Tom Becker from the Debrecen warehouse.",
      "I think I'm locked out. Could you reset my password?",
    ]);
    expect(states).toEqual(["SAFE", "WATCH"]);
    await session.resolveChallenge([...store.challenges.values()][0]!.id, true);
    expect(session.lastAssessment?.state).toBe("SAFE");
    expect(session.facts.decision).toBe("approved");
  });

  it("test 3: polite Lucas", async () => {
    const { states } = await run(["Hello, Lucas Carter here. Sorry to bother you, I got a new phone, could you help me enrol it?"]);
    expect(states).toEqual(["ALERT"]);
  });

  it("test 4: harmless caller, agent verifies anyway", async () => {
    const { session, states, store } = await run(["Hi, I have a question about my account."]);
    expect(states).toEqual(["SAFE"]);
    await session.manualVerify("E1001");
    await session.resolveChallenge([...store.challenges.values()][0]!.id, false);
    expect(session.facts.decision).toBe("blocked");
  });

  it("test 5: Alex has no registered phone", async () => {
    const { session } = await run(["This is Alex Taylor from IT security. Please reset my MFA right now."]);
    expect(session.facts.decision).toBe("blocked");
  });
});
