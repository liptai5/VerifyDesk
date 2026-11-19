// Tests the audit report for both scripted calls.

import { describe, expect, it } from "vitest";
import { Store } from "../../server/src/data/store.js";
import { EventLog } from "../../server/src/events/log.js";
import { loadRecordings, MockLLM } from "../../server/src/providers/mock.js";
import { CallSession } from "../../server/src/session.js";
import { DATA_DIR, FIXTURES_DIR, loadScript } from "../../server/test/helpers.js";
import { reportIdFromPath } from "../src/Report.js";
import { buildReport } from "../src/state/report.js";

async function record(name: string, approve: boolean) {
  const store = new Store(DATA_DIR);
  const log = new EventLog();
  const s = new CallSession("CALL-R", { store, log, llm: new MockLLM(loadRecordings(FIXTURES_DIR)) }, name);
  for (const t of loadScript(name).turns) await s.addTurn(t.channel, t.text);
  await s.resolveChallenge([...store.challenges.values()][0]!.id, approve);
  await s.end();
  return { events: log.forCall("CALL-R"), policies: store.policies };
}

describe("audit report", () => {
  it("attack: incident report with summary, evidence, policies and timeline", async () => {
    const { events, policies } = await record("attack", false);
    const r = buildReport(events, policies);
    expect(r.title).toBe("Security incident report");
    expect(r.outcome).toBe("blocked");
    expect(r.mode).toBe("Scripted call: attack");
    expect(r.firstAlertLine).toBe(2);
    expect(r.summary).toMatch(/Jane Doe \(Chief Financial Officer\) asked for: MFA moved/);
    expect(r.summary).toMatch(/real employee denied it/);
    expect(r.summary).toMatch(/security ticket SEC-\d+ was opened/);
    expect(r.tactics[0]).toEqual({ labels: ["Time pressure", "Pulling rank"], quote: "boarding in ten minutes" });
    expect(r.policies.map((p) => p.id)).toEqual(expect.arrayContaining(["POL-01", "POL-02", "POL-03"]));
    expect(r.timeline.filter((t) => t.kind === "line")).toHaveLength(6);
    expect(r.timeline.some((t) => t.kind === "decision" && t.tone === "bad")).toBe(true);
    const agent = r.timeline.filter((t) => t.kind === "agent");
    expect(agent).toHaveLength(1);
    expect(agent[0]!.text).toMatch(/^Chose: send the verification check\. This MFA change needs a check/);
    expect(r.view.verifier).toBe("agent");
  });

  it("benign: verification report, approved", async () => {
    const { events, policies } = await record("benign", true);
    const r = buildReport(events, policies);
    expect(r.title).toBe("Call verification report");
    expect(r.outcome).toBe("approved");
    expect(r.firstAlertLine).toBeNull();
    expect(r.summary).toMatch(/verified and the request was allowed/);
  });
});

describe("report addresses", () => {
  it("opens one call's report or the list of all calls", () => {
    expect(reportIdFromPath("/report/CALL-001-abc")).toBe("CALL-001-abc");
    expect(reportIdFromPath("/reports")).toBe("");
    expect(reportIdFromPath("/report")).toBe("");
    expect(reportIdFromPath("/reports/")).toBe("");
  });
});
