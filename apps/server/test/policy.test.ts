// Tests the Safe / Watch / Alert rules.

import { describe, expect, it } from "vitest";
import { assess, emptyFacts, mergeExtraction, type CallFacts } from "../src/policy/engine.js";
import { makeStore } from "./helpers.js";

const store = makeStore();
const jane = store.employeeById("E1001")!;
const tom = store.employeeById("E1004")!;

const facts = (over: Partial<CallFacts>): CallFacts => ({ ...emptyFacts(), ...over });
const finding = (code: string) => ({ code, text: code });

describe("policy engine (deterministic verdict)", () => {
  it("small talk is SAFE", () => {
    expect(assess(facts({})).state).toBe("SAFE");
  });

  it("pressure without a credential request is WATCH", () => {
    const a = assess(facts({ tactics: ["urgency", "authority"] }));
    expect(a.state).toBe("WATCH");
    expect(a.verifierShouldSpeak).toBe(false);
  });

  it("low-confidence tactics without a request are UNCERTAIN", () => {
    expect(assess(facts({ tactics: ["urgency"], lastConfidence: 0.3 })).state).toBe("UNCERTAIN");
  });

  it("a clean credential request is WATCH and still requires verification", () => {
    const a = assess(facts({ employee: tom, claimedIdentity: "Tom", requestedAction: "password_reset" }));
    expect(a.state).toBe("WATCH");
    expect(a.verifierShouldSpeak).toBe(true);
  });

  it("credential request + pressure + anomalies is ALERT", () => {
    const a = assess(
      facts({
        employee: jane,
        requestedAction: "mfa_reset",
        tactics: ["urgency"],
        findings: [finding("phone_active_contradiction")],
      }),
    );
    expect(a.state).toBe("ALERT");
    expect(a.verifierShouldSpeak).toBe(true);
    expect(a.whisper).toMatch(/Don't reset/);
  });

  it("high-risk tier alone tips a pressured request into ALERT", () => {
    expect(assess(facts({ employee: jane, requestedAction: "mfa_reset", tactics: ["urgency"] })).state).toBe("ALERT");
    expect(assess(facts({ employee: tom, requestedAction: "mfa_reset", tactics: ["urgency"] })).state).toBe("WATCH");
  });

  it("verifier does not speak twice once a push is pending", () => {
    const a = assess(facts({ employee: jane, requestedAction: "mfa_reset", tactics: ["urgency"], verification: "pending" }));
    expect(a.verifierShouldSpeak).toBe(false);
  });

  it("a pending agent-initiated check shows WATCH even with no request", () => {
    const a = assess(facts({ employee: tom, verification: "pending" }));
    expect(a.state).toBe("WATCH");
    expect(a.whisper).toMatch(/Waiting for the employee/);
  });

  it("out-of-band result overrides everything", () => {
    expect(assess(facts({ employee: tom, requestedAction: "password_reset", verification: "approved" })).state).toBe("SAFE");
    expect(assess(facts({ employee: tom, requestedAction: "password_reset", verification: "denied" })).state).toBe("ALERT");
  });

  it("merges extractions across turns", () => {
    let f = emptyFacts();
    f = mergeExtraction(f, { claimedIdentity: "Jane Doe", requestedAction: "none", tactics: ["urgency"], situation: [], evidenceQuote: "", confidence: 1 });
    f = mergeExtraction(f, { claimedIdentity: null, requestedAction: "mfa_reset", tactics: ["urgency", "isolation"], situation: ["phone_lost"], evidenceQuote: "", confidence: 1 });
    f = mergeExtraction(f, { claimedIdentity: null, requestedAction: "none", tactics: [], situation: [], evidenceQuote: "", confidence: 1 });
    expect(f.claimedIdentity).toBe("Jane Doe");
    expect(f.requestedAction).toBe("mfa_reset");
    expect(f.tactics).toEqual(["urgency", "isolation"]);
    expect(f.situation).toEqual(["phone_lost"]);
  });
});

describe("identity doesn't add up", () => {
  it("a wrong name for the record is WATCH straight away, before any request", () => {
    const a = assess(facts({ employee: jane, claims: ["Mark, the CFO"], findings: [{ code: "name_mismatch", text: 'Caller gave the name "Mark".' }] }));
    expect(a.state).toBe("WATCH");
    expect(a.whisper).toMatch(/Don't share anything/);
  });
  it("an inactive account is WATCH too", () => {
    expect(assess(facts({ findings: [{ code: "status_on_leave", text: "on leave" }] })).state).toBe("WATCH");
  });
});
