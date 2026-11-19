// The rules that decide Safe, Watch or Alert. Plain code, no AI calls here.

import type {
  Assessment,
  ChecklistItemId,
  Employee,
  Extraction,
  RequestedAction,
  RiskTier,
  SituationClaim,
  Tactic,
  VerificationStatus,
} from "@verifydesk/shared";
import type { ContextFinding } from "./context.js";

// Requests that always need a check on the registered phone.
export const HIGH_RISK_ACTIONS: ReadonlySet<RequestedAction> = new Set([
  "password_reset",
  "mfa_reset",
  "send_code",
  "new_device",
  "privilege_change",
  "payment_change",
  "remote_access",
]);

// Everything learned on the call so far.
export interface CallFacts {
  claimedIdentity: string | null;
  claims: string[];
  employee: Employee | undefined;
  requestedAction: RequestedAction;
  tactics: Tactic[];
  situation: SituationClaim[];
  lastConfidence: number;
  findings: ContextFinding[];
  verification: VerificationStatus;
  decision: "none" | "blocked" | "approved";
}

export function emptyFacts(): CallFacts {
  return {
    claimedIdentity: null,
    claims: [],
    employee: undefined,
    requestedAction: "none",
    tactics: [],
    situation: [],
    lastConfidence: 1,
    findings: [],
    verification: "none",
    decision: "none",
  };
}

// Adds the facts from a new sentence to what we already know.
export function mergeExtraction(facts: CallFacts, x: Extraction): CallFacts {
  return {
    ...facts,
    claimedIdentity: x.claimedIdentity ?? facts.claimedIdentity,
    claims: x.claimedIdentity ? union(facts.claims, [x.claimedIdentity]) : facts.claims,
    requestedAction: x.requestedAction !== "none" ? x.requestedAction : facts.requestedAction,
    tactics: union(facts.tactics, x.tactics),
    situation: union(facts.situation, x.situation),
    lastConfidence: x.confidence,
  };
}

// Findings that mean the caller's identity doesn't add up.
const IDENTITY_FINDINGS = new Set(["name_mismatch", "no_record"]);

// How much an account's risk level adds to the score. Raise these to be stricter.
const TIER_WEIGHT: Record<RiskTier, number> = { standard: 0, elevated: 0.5, high: 1 };

// Gives the verdict. A score of 2 or more with a risky request means Alert.
export function assess(f: CallFacts): Assessment {
  const reasons: string[] = [];
  const highRisk = HIGH_RISK_ACTIONS.has(f.requestedAction);
  const anomalies = f.findings.map((x) => (x.policyId ? `${x.text} (${x.policyId})` : x.text));
  const base = {
    requestedAction: f.requestedAction,
    tactics: f.tactics,
    anomalies,
  };

  if (f.verification === "denied") {
    return {
      ...base,
      state: "ALERT",
      reasons: ["The registered device holder denied the verification request."],
      whisper: "Real employee denied the push. Block the reset and escalate to security.",
      verifierShouldSpeak: false,
    };
  }
  if (f.verification === "approved") {
    return {
      ...base,
      state: "SAFE",
      reasons: ["Identity verified out-of-band on a registered device."],
      whisper: highRisk ? "Verified on the registered device. OK to proceed." : null,
      verifierShouldSpeak: false,
    };
  }

  const tierWeight = f.employee ? TIER_WEIGHT[f.employee.riskTier] : 0.5;
  const score = f.tactics.length + f.findings.length + tierWeight;

  if (f.tactics.length) reasons.push(`Pressure tactics: ${f.tactics.join(", ")}.`);
  reasons.push(...anomalies);
  if (f.employee?.riskTier === "high") reasons.push(`${f.employee.name} is a high-risk-tier account (POL-03).`);

  if (!highRisk && f.verification === "pending") {
    return {
      ...base,
      state: "WATCH",
      reasons: [...reasons, "Identity check sent to the registered device; waiting for the answer."],
      whisper: "Waiting for the employee to answer on their registered phone. Don't change anything yet.",
      verifierShouldSpeak: false,
    };
  }
  if (!highRisk) {
    const identityIssue = f.findings.find((x) => IDENTITY_FINDINGS.has(x.code) || x.code.startsWith("status_"));
    if (identityIssue) {
      return {
        ...base,
        state: "WATCH",
        reasons,
        whisper: `${identityIssue.text} Don't share anything until they're verified.`,
        verifierShouldSpeak: false,
      };
    }
    if (f.tactics.length > 0 && f.lastConfidence < 0.5) {
      return { ...base, state: "UNCERTAIN", reasons, whisper: null, verifierShouldSpeak: false };
    }
    if (f.tactics.length >= 2) {
      return {
        ...base,
        state: "WATCH",
        reasons,
        whisper: "Pressure tactics noticed. Stay on process.",
        verifierShouldSpeak: false,
      };
    }
    return { ...base, state: "SAFE", reasons, whisper: null, verifierShouldSpeak: false };
  }

  reasons.unshift(`High-risk request: ${f.requestedAction.replaceAll("_", " ")} (POL-01).`);
  const canVerify = Boolean(f.employee) && f.verification === "none";
  const pending = f.verification === "pending";

  if (score >= 2) {
    return {
      ...base,
      state: "ALERT",
      reasons,
      whisper: pending
        ? "Push sent to the registered device. Do not reset while waiting."
        : `Don't reset. ${anomalies[0] ?? "Verify via the registered device."}`,
      verifierShouldSpeak: canVerify,
    };
  }
  return {
    ...base,
    state: "WATCH",
    reasons,
    whisper: pending
      ? "Waiting for the employee to approve on their registered device."
      : "Standard check: verify on the registered device before resetting.",
    verifierShouldSpeak: canVerify,
  };
}

// Which basic steps have been done (sent along with each verdict).
export function checklist(f: CallFacts): Record<ChecklistItemId, boolean> {
  return {
    identity_claimed: Boolean(f.claimedIdentity),
    record_found: Boolean(f.employee),
    context_checked: Boolean(f.employee),
    out_of_band_sent: f.verification !== "none",
    out_of_band_result: f.verification === "approved" || f.verification === "denied" || f.verification === "timeout",
    decision: f.decision !== "none",
  };
}

function union<T>(a: T[], b: T[]): T[] {
  return [...new Set([...a, ...b])];
}
