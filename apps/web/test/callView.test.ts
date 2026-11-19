// Tests that the console shows the right things for a real call log.

import { describe, expect, it } from "vitest";
import { Store } from "../../server/src/data/store.js";
import { EventLog } from "../../server/src/events/log.js";
import { loadRecordings, MockLLM } from "../../server/src/providers/mock.js";
import { CallSession } from "../../server/src/session.js";
import { DATA_DIR, FIXTURES_DIR, loadScript } from "../../server/test/helpers.js";
import { applyEvent, buildView, emptyView } from "../src/state/callView.js";

async function recordCall(name: string, press: boolean) {
  const store = new Store(DATA_DIR);
  const log = new EventLog();
  const session = new CallSession("CALL-UI", { store, log, llm: new MockLLM(loadRecordings(FIXTURES_DIR)) }, name);
  for (const t of loadScript(name).turns) await session.addTurn(t.channel, t.text);
  const push = [...store.challenges.values()][0]!;
  await session.resolveChallenge(push.id, press);
  return log.forCall(session.id);
}

describe("console view built from the event log", () => {
  it("attack call: transcript, record, evidence, push and decision", async () => {
    const view = buildView(await recordCall("attack", false));
    expect(view.callId).toBe("CALL-UI");
    expect(view.employee?.name).toBe("Jane Doe");
    expect(view.devices.length).toBeGreaterThan(0);
    expect(view.turns.filter((t) => t.channel === "caller")).toHaveLength(3);
    expect(view.turns.filter((t) => t.channel === "verifier")).toHaveLength(2);
    const firstLine = view.turns.find((t) => t.channel === "verifier")!;
    expect(firstLine.why).toMatch(/MFA change needs a check/);
    expect(firstLine.source).toBe("ai");
    expect(view.turns.find((t) => t.evidence === "boarding in ten minutes")).toBeTruthy();
    expect(view.turns.filter((t) => t.channel === "caller").map((t) => t.stateAfter)).toEqual(["WATCH", "ALERT", "ALERT"]);
    expect(view.pushes[0]?.status).toBe("denied");
    expect(view.decision?.decision).toBe("blocked");
    expect(view.decision?.ticketId).toMatch(/^SEC-/);
    expect(view.assessment?.state).toBe("ALERT");
    expect(view.assessment?.checklist.decision).toBe(true);
  });

  it("benign call ends SAFE and approved", async () => {
    const view = buildView(await recordCall("benign", true));
    expect(view.assessment?.state).toBe("SAFE");
    expect(view.decision?.decision).toBe("approved");
    expect(view.turns.some((t) => t.stateAfter === "ALERT")).toBe(false);
  });

  it("ignores duplicate events (WebSocket + re-sync overlap)", async () => {
    const events = await recordCall("attack", false);
    const once = buildView(events);
    const twice = [...events, ...events].reduce(applyEvent, emptyView());
    expect(twice.turns).toHaveLength(once.turns.length);
    expect(twice.tools).toHaveLength(once.tools.length);
  });

  it("lists only the verification steps that happened, in order", async () => {
    const attack = buildView(await recordCall("attack", false));
    expect(attack.steps.map((x) => x.text)).toEqual([
      "Caller says they're Jane Doe",
      "Found in the directory: Jane Doe, Chief Financial Officer",
      "Story checked against devices and sign-in history",
      "Check sent to Jane's iPhone (registered)",
      "Employee answered on their phone: No, it's not me",
      expect.stringMatching(/^Request blocked, security ticket SEC-\d+ opened$/),
    ]);
    expect(attack.steps[2]!.tone).toBe("bad");
    expect(attack.steps[3]!.detail).toBe("Sent by VerifyDesk");

    const benign = buildView(await recordCall("benign", true));
    expect(benign.steps.at(-2)).toMatchObject({ text: "Employee answered on their phone: Yes, it's me", tone: "good" });
    expect(benign.steps.at(-1)).toMatchObject({ text: "Request allowed after verification", tone: "good" });
  });
});
