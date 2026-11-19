// Loads the fictional company (people, devices, sign-ins, policies) and keeps pushes, tickets and decisions.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  Company,
  Device,
  Employee,
  IdentityEvent,
  Policy,
  type VerificationStatus,
} from "@verifydesk/shared";

export interface ResolvedDevice extends Device {
  lastSeenAt: number;
}
export interface ResolvedIdentityEvent extends IdentityEvent {
  at: number;
}

export interface PushChallenge {
  id: string;
  employeeId: string;
  deviceId: string;
  callId: string;
  reason: string;
  status: VerificationStatus;
  createdAt: number;
  resolvedAt?: number;
}

export interface Ticket {
  id: string;
  callId: string;
  employeeId: string | null;
  summary: string;
  evidence: string[];
  createdAt: number;
}

export interface ResetDecision {
  callId: string;
  employeeId: string;
  decision: "blocked" | "approved";
  reason: string;
  at: number;
}

function load<T>(dir: string, file: string, schema: z.ZodType<T>): T {
  const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
  return schema.parse(raw);
}

// The company data and everything that changed during calls.
export class Store {
  readonly company: Company;
  readonly employees: Employee[];
  readonly devices: ResolvedDevice[];
  readonly identityEvents: ResolvedIdentityEvent[];
  readonly policies: Policy[];
  readonly challenges = new Map<string, PushChallenge>();
  readonly tickets: Ticket[] = [];
  readonly decisions: ResetDecision[] = [];
  private counters = new Map<string, number>();

  constructor(dataDir: string, readonly now: () => number = Date.now) {
    const t0 = now();
    this.company = load(dataDir, "company.json", Company);
    this.employees = load(dataDir, "employees.json", z.array(Employee));
    this.policies = load(dataDir, "policies.json", z.array(Policy));
    this.devices = load(dataDir, "devices.json", z.array(Device)).map((d) => ({
      ...d,
      lastSeenAt: t0 - d.lastSeenMinutesAgo * 60_000,
    }));
    this.identityEvents = load(dataDir, "identity_events.json", z.array(IdentityEvent)).map(
      (e) => ({ ...e, at: t0 - e.minutesAgo * 60_000 }),
    );
  }

  nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, "0")}`;
  }

  employeeById(id: string): Employee | undefined {
    return this.employees.find((e) => e.id === id);
  }

  // Finds a person by name, role or ID, ignoring accents and small words.
  findEmployee(query: string): Employee | undefined {
    const q = normalize(query);
    if (!q) return undefined;
    const byId = this.employees.find((e) => normalize(e.id) === q);
    if (byId) return byId;
    const tokens = q.split(" ").filter((t) => t.length > 1 && !STOPWORDS.has(t));
    let best: { e: Employee; score: number } | undefined;
    for (const e of this.employees) {
      const acronym = e.title
        .split(" ")
        .filter((w) => /^[A-Z]/.test(w))
        .map((w) => w[0])
        .join("");
      const hayWords = new Set(normalize(`${e.name} ${e.title} ${acronym}`).split(" "));
      const nameWords = new Set(normalize(e.name).split(" "));
      const score = tokens.reduce(
        (s, t) => s + (nameWords.has(t) ? 2 : hayWords.has(t) ? 1 : 0),
        0,
      );
      if (score > 0 && (!best || score > best.score)) best = { e, score };
    }
    return best?.e;
  }

  // An employee's registered devices.
  devicesFor(employeeId: string): ResolvedDevice[] {
    return this.devices.filter((d) => d.employeeId === employeeId);
  }

  // An employee's account events from the last few hours.
  eventsFor(employeeId: string, hours = 24): ResolvedIdentityEvent[] {
    const since = this.now() - hours * 3_600_000;
    return this.identityEvents
      .filter((e) => e.employeeId === employeeId && e.at >= since)
      .sort((a, b) => b.at - a.at);
  }

  minutesAgo(ts: number): number {
    return Math.max(0, Math.round((this.now() - ts) / 60_000));
  }
}

const STOPWORDS = new Set([
  "the", "my", "from", "this", "is", "am", "im", "it", "its", "me", "of", "our", "and", "here", "speaking",
]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
