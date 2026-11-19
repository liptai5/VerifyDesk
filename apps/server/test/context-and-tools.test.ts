// Tests the record checks and every tool guard.

import { describe, expect, it } from "vitest";
import { analyzeContext } from "../src/policy/context.js";
import { runTool, ToolError } from "../src/tools/index.js";
import { makeStore } from "./helpers.js";

describe("directory lookup", () => {
  const store = makeStore();
  it.each([
    ["Jane Doe", "E1001"],
    ["jane", "E1001"],
    ["the CFO", "E1001"],
    ["Tom Becker", "E1004"],
    ["Lucas Carter", "E1003"],
    ["E1012", "E1012"],
  ])("%s -> %s", (q, id) => {
    expect(store.findEmployee(q)?.id).toBe(id);
  });
  it("unknown names are not matched", () => {
    expect(store.findEmployee("Zoltan Nobody")).toBeUndefined();
  });
});

describe("context analysis", () => {
  const store = makeStore();
  const codes = (id: string, ...args: Parameters<typeof analyzeContext>[3][]) =>
    analyzeContext(store, store.employeeById(id), "x", args[0] ?? [], []).map((f) => f.code);

  it("Jane: 'phone stolen' contradicts a phone active 10 min ago", () => {
    expect(codes("E1001", ["phone_lost"])).toContain("phone_active_contradiction");
  });
  it("Jane: 'at the airport' contradicts a device seen at the home office", () => {
    expect(codes("E1001", ["traveling"])).toContain("travel_contradiction");
  });
  it("Tom: genuine lock-out has no anomalies", () => {
    expect(codes("E1004", ["locked_out"])).toEqual([]);
  });
  it("Lucas: foreign device enrolment + impossible travel", () => {
    expect(codes("E1003", ["new_phone"])).toEqual(expect.arrayContaining(["recent_foreign_device", "impossible_travel"]));
  });
  it("Sarah: on leave is flagged", () => {
    expect(codes("E1005")).toContain("status_on_leave");
  });
  it("unknown claimed identity is flagged", () => {
    expect(analyzeContext(store, undefined, "Zoltan", [], []).map((f) => f.code)).toEqual(["no_record"]);
  });
});

describe("mock enterprise tools", () => {
  it("push goes to the freshest registered push device", () => {
    const store = makeStore();
    const r = runTool({ store, callId: "C1" }, "send_push_challenge", { employeeId: "E1001" }) as any;
    expect(r.sent).toBe(true);
    expect(store.challenges.get(r.challengeId)?.deviceId).toBe("D-1001-P");
  });

  it("duplicate pushes in one call are not re-sent", () => {
    const store = makeStore();
    const a = runTool({ store, callId: "C1" }, "send_push_challenge", { employeeId: "E1001" }) as any;
    const b = runTool({ store, callId: "C1" }, "send_push_challenge", { employeeId: "E1001" }) as any;
    expect(b.challengeId).toBe(a.challengeId);
    expect(b.duplicate).toBe(true);
  });

  it("approve_reset is refused without an approved out-of-band check", () => {
    const store = makeStore();
    expect(() => runTool({ store, callId: "C1" }, "approve_reset", { employeeId: "E1004" })).toThrow(ToolError);
  });

  it("employees without a registered push phone can't be sent a push", () => {
    const store = makeStore();
    const r = runTool({ store, callId: "C1" }, "send_push_challenge", { employeeId: "E1017" }) as any;
    expect(r.sent).toBe(false);
  });
});

describe("name mismatch", () => {
  const store = makeStore();
  const jane = store.employeeById("E1001")!;
  const codes = (claims: string[]) => analyzeContext(store, jane, claims[0] ?? null, [], [], claims).map((f) => f.code);
  it("flags 'Mark, the CFO' when the CFO is Jane Doe", () => {
    expect(codes(["Mark, the CFO"])).toContain("name_mismatch");
    expect(codes(["Mark", "the CFO"])).toContain("name_mismatch");
  });
  it("accepts the right name, a role alone, or accents", () => {
    expect(codes(["Jane Doe"])).not.toContain("name_mismatch");
    expect(codes(["the CFO"])).not.toContain("name_mismatch");
    expect(codes(["Jane, the CFO"])).not.toContain("name_mismatch");
    const daniel = store.employeeById("E1003")!;
    expect(analyzeContext(store, daniel, "Lúcas Cárter", [], [], ["Lúcas Cárter"]).map((f) => f.code)).not.toContain("name_mismatch");
  });
  it("doesn't mistake the company's name for a person's name", () => {
    expect(codes(["Jane Doe from Do IT Better Solutions Ltd.", "the CFO"])).not.toContain("name_mismatch");
    expect(codes(["Mark from Do IT Better Solutions"])).toContain("name_mismatch");
  });
});
