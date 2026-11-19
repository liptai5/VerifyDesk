// Compares the caller's story with the company records and lists what doesn't add up.

import type { Employee, SituationClaim, Tactic } from "@verifydesk/shared";
import type { Store } from "../data/store.js";

export interface ContextFinding {
  code: string;
  text: string;
  policyId?: string;
}

// Checks the name, the account status, devices and recent sign-ins against what the caller said.
export function analyzeContext(
  store: Store,
  employee: Employee | undefined,
  claimedIdentity: string | null,
  situation: SituationClaim[],
  tactics: Tactic[],
  claims: string[] = claimedIdentity ? [claimedIdentity] : [],
): ContextFinding[] {
  const findings: ContextFinding[] = [];

  if (employee) {
    const own = new Set(nameWords(employee.name));
    const companyWords = new Set(nameWords(`${store.company.name} ${store.company.helpdeskName}`));
    const wrong = claims
      .flatMap(personalNames)
      .filter((n) => !own.has(nameWords(n)[0] ?? "") && !companyWords.has(nameWords(n)[0] ?? ""));
    if (wrong.length) {
      findings.push({
        code: "name_mismatch",
        text: `Caller gave the name "${wrong[0]}", but the matching record is ${employee.name} (${employee.title}).`,
      });
    }
  }

  if (claimedIdentity && !employee) {
    findings.push({ code: "no_record", text: `No directory record matches "${claimedIdentity}".` });
  }

  if (tactics.includes("new_contact_channel")) {
    findings.push({
      code: "new_contact_channel",
      text: "Caller wants codes or links sent to contact details that are not on file.",
      policyId: "POL-02",
    });
  }

  if (!employee) return findings;

  if (employee.status !== "active") {
    findings.push({
      code: `status_${employee.status}`,
      text: `${employee.name} is marked "${employee.status.replace("_", " ")}" in the directory.`,
      policyId: "POL-04",
    });
  }

  const pushDevices = store.devicesFor(employee.id).filter((d) => d.pushEnabled);
  const freshest = pushDevices.sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];

  if (freshest) {
    const mins = store.minutesAgo(freshest.lastSeenAt);
    if (situation.includes("phone_lost") && mins <= 30) {
      findings.push({
        code: "phone_active_contradiction",
        text: `Caller says the phone is lost, but the registered phone was active ${mins} min ago in ${freshest.lastLocation}.`,
      });
    }
    if (situation.includes("traveling") && mins <= 30 && freshest.lastLocation === employee.location) {
      findings.push({
        code: "travel_contradiction",
        text: `Caller claims to be travelling, but the registered device was seen ${mins} min ago at the home office (${employee.location}).`,
      });
    }
  }

  const recent = store.eventsFor(employee.id, 24);
  const newDevice = recent.find((e) => e.type === "device_added" && e.location !== employee.location);
  if (newDevice) {
    findings.push({
      code: "recent_foreign_device",
      text: `A device was enrolled ${store.minutesAgo(newDevice.at)} min ago from ${newDevice.location} (home: ${employee.location}).`,
    });
  }
  const travelFlag = recent.find((e) => e.detail?.toLowerCase().includes("impossible travel"));
  if (travelFlag) {
    findings.push({ code: "impossible_travel", text: `Impossible-travel flag ${store.minutesAgo(travelFlag.at)} min ago.` });
  }

  return findings;
}

// Words that look like names but aren't (roles, small words).
const NOT_NAMES = new Set([
  "the", "a", "an", "of", "and", "i", "im", "it", "its", "this", "is", "my", "from", "here", "speaking", "mr", "mrs", "ms", "dr",
  "cfo", "ceo", "cto", "coo", "it", "vp", "chief", "head", "director", "manager", "officer", "financial", "executive", "technology",
  "operations", "sales", "finance", "people", "hr", "team", "lead", "specialist", "analyst", "president",
]);

function nameWords(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter(Boolean);
}

// Picks the people's names out of what the caller said.
export function personalNames(claim: string): string[] {
  const plain = claim.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return (plain.match(/\b[A-Z][a-zA-Z'’-]+/g) ?? []).filter((w) => !NOT_NAMES.has(nameWords(w)[0] ?? ""));
}

// Facts that back up the caller's story. Shown to the agent, never approve anything.
export function supportingContext(store: Store, employee: Employee | undefined, situation: SituationClaim[]): string[] {
  if (!employee) return [];
  const out: string[] = [];
  const recent = store.eventsFor(employee.id, 24);
  const locked = recent.find((e) => e.type === "account_locked");
  if (situation.includes("locked_out") && locked) {
    out.push(`Account locked ${store.minutesAgo(locked.at)} min ago in ${locked.location}, consistent with the caller's story.`);
  }
  return out;
}
