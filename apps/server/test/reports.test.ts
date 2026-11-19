// Tests that saved calls can be read back for reports.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/events/log.js";
import { listCalls, readCall, summarize } from "../src/events/reports.js";
import { CallSession } from "../src/session.js";
import { loadRecordings, MockLLM } from "../src/providers/mock.js";
import { FIXTURES_DIR, loadScript, makeStore, NOW } from "./helpers.js";

async function recordedAttack(runsDir: string) {
  const store = makeStore();
  const log = new EventLog({ runsDir, now: () => NOW });
  const s = new CallSession("CALL-REPORT-1", { store, log, llm: new MockLLM(loadRecordings(FIXTURES_DIR)) }, "attack");
  for (const t of loadScript("attack").turns) await s.addTurn(t.channel, t.text);
  await s.resolveChallenge([...store.challenges.values()][0]!.id, false);
  await s.end();
  return log;
}

describe("audit report data", () => {
  it("summarises a blocked attack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vd-runs-"));
    const log = await recordedAttack(dir);
    const sum = summarize(log.forCall("CALL-REPORT-1"))!;
    expect(sum).toMatchObject({ scenario: "attack", employeeName: "Jane Doe", finalState: "ALERT", decision: "blocked" });
    expect(sum.ticketId).toMatch(/^SEC-/);
    expect(sum.lines).toBe(6);
  });

  it("reads saved calls back after a restart, and skips a broken last line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vd-runs-"));
    await recordedAttack(dir);
    writeFileSync(join(dir, "CALL-BROKEN.jsonl"), '{"seq":1,"ts":1,"callId":"CALL-BROKEN","type":"call_started","payload":{}}\n{"seq":2,"ts":2,');
    const fresh = new EventLog();
    expect(readCall(fresh, dir, "CALL-REPORT-1").length).toBeGreaterThan(10);
    expect(readCall(fresh, dir, "CALL-BROKEN")).toHaveLength(1);
    const list = listCalls(fresh, dir, []);
    expect(list.map((c) => c.callId)).toEqual(expect.arrayContaining(["CALL-REPORT-1", "CALL-BROKEN"]));
  });

  it("refuses odd call ids (no path tricks)", () => {
    expect(readCall(new EventLog(), "/tmp", "../etc/passwd")).toEqual([]);
  });
});
