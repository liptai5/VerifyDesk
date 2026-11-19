// The call log. Every step is added here and saved to runs/; the screen listens to it live.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent, AuditEventType } from "@verifydesk/shared";

type Listener = (e: AuditEvent) => void;

// Keeps events in memory, writes them to a file and tells listeners.
export class EventLog {
  private events: AuditEvent[] = [];
  private listeners = new Set<Listener>();
  private seq = 0;

  constructor(
    private readonly opts: { runsDir?: string; now?: () => number } = {},
  ) {
    if (opts.runsDir) mkdirSync(opts.runsDir, { recursive: true });
  }

  append(callId: string, type: AuditEventType, payload: Record<string, unknown>): AuditEvent {
    const e: AuditEvent = { seq: ++this.seq, ts: (this.opts.now ?? Date.now)(), callId, type, payload };
    this.events.push(e);
    if (this.opts.runsDir) {
      appendFileSync(join(this.opts.runsDir, `${callId}.jsonl`), JSON.stringify(e) + "\n");
    }
    for (const l of this.listeners) l(e);
    return e;
  }

  forCall(callId: string): AuditEvent[] {
    return this.events.filter((e) => e.callId === callId);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
