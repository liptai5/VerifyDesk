// Runs one call from start to end: reads each line, checks the rules, lets the AI pick the next step, and
// records everything.

import type { Assessment, Channel, Turn } from "@verifydesk/shared";
import { checkLine, enforceTool, recordDetailsFor, type AgentTool, type Allowed, type LineKind } from "./agent/guards.js";
import { ACTION_LABEL, askAgent, closingLine, outcomeLine, verifyLine, type AgentInput, type AgentTask } from "./agent/verifier.js";
import type { Store, PushChallenge } from "./data/store.js";
import type { EventLog } from "./events/log.js";
import { extract } from "./extractor.js";
import { analyzeContext, supportingContext } from "./policy/context.js";
import { assess, checklist, emptyFacts, mergeExtraction, type CallFacts } from "./policy/engine.js";
import type { LLMProvider } from "./providers/types.js";
import { runTool, type ToolContext, type ToolName } from "./tools/index.js";

export { outcomeLine } from "./agent/verifier.js";

export type VerifierMode = "agent" | "fixed";

// What a call needs: the company data, the log and the AI. verifier: "fixed" turns the AI agent off.
export interface SessionDeps {
  store: Store;
  log: EventLog;
  llm: LLMProvider;
  verifier?: VerifierMode;
  agentTimeoutMs?: number;
}

interface Line {
  text: string;
  why: string | null;
  notes: string[];
  source: "ai" | "fixed" | "fallback";
  kind?: "closing";
}

// One help-desk call.
export class CallSession {
  readonly turns: Turn[] = [];
  facts: CallFacts = emptyFacts();
  lastAssessment: Assessment | null = null;
  private pushSent = false;
  private ended = false;
  private incident: { ticketId: string; reason: "denied" | "no_phone" } | null = null;
  private questions: string[] = [];
  private turnCounter = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly id: string, private readonly d: SessionDeps, readonly scenario?: string) {
    this.d.log.append(id, "call_started", { scenario: scenario ?? null, llm: d.llm.name, verifier: this.mode });
  }

  get mode(): VerifierMode {
    return this.d.verifier ?? "agent";
  }

  // Runs steps one at a time, in order, so two things can't happen at once.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get toolCtx(): ToolContext {
    return {
      store: this.d.store,
      callId: this.id,
      onPushSent: (c: PushChallenge) =>
        this.d.log.append(this.id, "push_sent", {
          challengeId: c.id,
          employeeId: c.employeeId,
          deviceId: c.deviceId,
          reason: c.reason,
        }),
    };
  }

  // Runs a tool and writes it to the log.
  tool(name: ToolName, args: Record<string, unknown>, by: "verifydesk" | "agent" = "verifydesk"): unknown {
    const t0 = performance.now();
    let result: unknown;
    let error: string | null = null;
    try {
      result = runTool(this.toolCtx, name, args);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.d.log.append(this.id, "tool_call", { name, args, result: result ?? null, error, by, ms: Math.round(performance.now() - t0) });
    if (error) throw new Error(error);
    return result;
  }

  // Adds a VerifyDesk line to the call.
  private say(line: Line) {
    this.d.log.append(this.id, "verifier_said", {
      text: line.text,
      why: line.why,
      notes: line.notes,
      source: line.source,
      ...(line.kind ? { kind: line.kind } : {}),
    });
    this.turns.push({ id: this.nextTurnId(), channel: "verifier", text: line.text });
  }

  private nextTurnId() {
    this.turnCounter += 1;
    return `${this.id}-t${this.turnCounter}`;
  }

  private refreshContext() {
    const f = this.facts;
    this.facts = {
      ...f,
      findings: analyzeContext(this.d.store, f.employee, f.claimedIdentity, f.situation, f.tactics, f.claims),
    };
  }

  // Asks the rules for a verdict and logs it.
  private publishAssessment(): Assessment {
    const a = assess(this.facts);
    this.lastAssessment = a;
    this.d.log.append(this.id, "assessment", {
      ...a,
      checklist: checklist(this.facts),
      supporting: supportingContext(this.d.store, this.facts.employee, this.facts.situation),
      employeeId: this.facts.employee?.id ?? null,
    });
    return a;
  }

  // A new line on the call. Only caller lines are analysed.
  addTurn(channel: Channel, text: string): Promise<Assessment | null> {
    const turn: Turn = { id: this.nextTurnId(), channel, text };
    const previous = this.turns[this.turns.length - 1];
    this.turns.push(turn);
    this.d.log.append(this.id, "turn", { ...turn });
    if (channel !== "caller") return Promise.resolve(this.lastAssessment);
    return this.serial(() => this.handleCallerLine(turn, previous));
  }

  // AI reads the sentence, we look the person up, check the story, then decide the next step.
  private async handleCallerLine(turn: Turn, previous: Turn | undefined): Promise<Assessment | null> {
    const { value: x, ms } = await extract(this.d.llm, turn, previous);
    this.d.log.append(this.id, "extraction", { turnId: turn.id, ...x, ms, provider: this.d.llm.name });
    this.facts = mergeExtraction(this.facts, x);

    if (this.facts.claimedIdentity && !this.facts.employee) {
      const r = this.tool("lookup_employee", { query: this.facts.claimedIdentity }) as {
        found: boolean;
        employee?: CallFacts["employee"];
      };
      if (r.found && r.employee) {
        this.facts = { ...this.facts, employee: r.employee };
        this.tool("get_recent_identity_events", { employeeId: r.employee.id, hours: 24 });
      }
    }

    this.refreshContext();
    const a = this.publishAssessment();
    await this.decideNext(a);
    return this.lastAssessment;
  }

  // What VerifyDesk is allowed to do right now. The AI only gets these options.
  private allowed(a: Assessment): Allowed {
    const open = this.facts.decision === "none" && this.facts.verification === "none" && !this.pushSent;
    const emp = this.facts.employee;
    return {
      push: open && Boolean(emp),
      ask: open && !emp && this.questions.length < 2,
      mustPush: open && Boolean(emp) && a.verifierShouldSpeak,
    };
  }

  // The short summary of the call that the AI agent gets.
  private agentInput(task: AgentTask, allowed: Allowed): AgentInput {
    const a = this.lastAssessment;
    const emp = this.facts.employee;
    const tools: AgentTool[] = [
      ...(allowed.push ? (["send_push_challenge"] as const) : []),
      ...(allowed.ask ? (["ask_caller"] as const) : []),
      "none",
    ];
    return {
      task,
      allowed: tools,
      transcript: this.turns.map((t) => ({ channel: t.channel, text: t.text })),
      claimed: this.facts.claimedIdentity,
      employee: emp
        ? { name: emp.name, title: emp.title, hasPushPhone: this.d.store.devicesFor(emp.id).some((dv) => dv.pushEnabled) }
        : null,
      policy: {
        state: a?.state ?? "SAFE",
        action: this.facts.requestedAction,
        request: ACTION_LABEL[this.facts.requestedAction] ?? "nothing yet",
        tactics: this.facts.tactics,
        mustVerify: allowed.mustPush,
        concerns: a?.anomalies ?? [],
      },
      questionsAsked: this.questions,
    };
  }

  // Record details the caller must never hear.
  private lineFacts() {
    const emp = this.facts.employee;
    const manager = emp?.managerId ? this.d.store.employeeById(emp.managerId)?.name : null;
    const devices = emp ? this.d.store.devicesFor(emp.id) : [];
    const places = emp ? this.d.store.eventsFor(emp.id, 24 * 30).map((e) => e.location) : [];
    return {
      recordDetails: recordDetailsFor(emp ? { ...emp, managerName: manager } : null, devices, places),
      callerSaid: this.turns
        .filter((t) => t.channel === "caller")
        .map((t) => t.text.toLowerCase())
        .join(" "),
    };
  }

  // Asks the AI what to do next, checks its answer with the safety rules, then does it.
  private async decideNext(a: Assessment) {
    const allowed = this.allowed(a);
    const emp = this.facts.employee;
    const worthAsking = allowed.mustPush || ((allowed.push || allowed.ask) && (a.state !== "SAFE" || a.requestedAction !== "none"));
    if (!worthAsking) return;

    const standard = { tool: (allowed.mustPush ? "send_push_challenge" : "none") as AgentTool, say: emp ? verifyLine(emp.name) : "" };
    let tool = standard.tool;
    let text = standard.say;
    let why: string | null = null;
    const notes: string[] = [];
    let source: Line["source"] = "fixed";
    let proposed: unknown = null;
    let ms = 0;
    let error: string | null = null;

    if (this.mode === "agent") {
      const ans = await askAgent(this.d.llm, this.agentInput("decide", allowed), this.d.agentTimeoutMs);
      ms = ans.ms;
      error = ans.error;
      proposed = ans.reply;
      if (!ans.reply) {
        source = "fallback";
        notes.push("The AI didn't give a usable answer in time, so VerifyDesk followed its standard steps.");
      } else {
        source = "ai";
        why = ans.reply.reason.trim() || null;
        const enforced = enforceTool(ans.reply.tool, allowed);
        tool = enforced.tool;
        notes.push(...enforced.notes);
        if (tool === ans.reply.tool) {
          text = ans.reply.say.trim();
          const kind: LineKind = tool === "ask_caller" ? "question" : "verify";
          const broken = tool === "none" ? [] : checkLine(text, kind, this.lineFacts());
          if (broken.length) {
            notes.push(...broken.map((r) => r.text));
            if (tool === "ask_caller") {
              tool = "none";
              notes.push("The question was dropped.");
            } else {
              text = standard.say;
              notes.push("VerifyDesk used its standard line instead.");
            }
          }
        } else {
          text = tool === "send_push_challenge" ? standard.say : "";
        }
      }
    }

    this.d.log.append(this.id, "agent_decision", { task: "decide", proposed, applied: { tool, say: text }, why, notes, source, ms, error });

    if (tool === "send_push_challenge" && emp) {
      this.pushSent = true;
      const r = this.tool("send_push_challenge", {
        employeeId: emp.id,
        reason: `Help-desk ${ACTION_LABEL[this.facts.requestedAction] ?? "request"} for ${emp.name}`,
      }) as { sent: boolean };
      if (r.sent) {
        this.facts = { ...this.facts, verification: "pending" };
        this.say({ text, why, notes, source });
      } else {
        await this.cannotVerify(emp);
      }
      this.publishAssessment();
    } else if (tool === "ask_caller" && text) {
      this.questions.push(text);
      this.say({ text, why, notes, source });
    }
  }

  // Asks the AI to word a line whose action is already decided (e.g. the ending).
  private async wordLine(task: Exclude<AgentTask, "decide">, emp: NonNullable<CallFacts["employee"]>): Promise<Line> {
    const standard = task === "verify" ? verifyLine(emp.name) : outcomeLine(task, this.facts.requestedAction, emp.name);
    if (this.mode === "fixed") return { text: standard, why: null, notes: [], source: "fixed" };

    const none: Allowed = { push: false, ask: false, mustPush: false };
    const ans = await askAgent(this.d.llm, this.agentInput(task, none), this.d.agentTimeoutMs);
    let line: Line;
    if (!ans.reply) {
      line = { text: standard, why: null, notes: ["The AI didn't give a usable answer in time, so VerifyDesk used its standard line."], source: "fallback" };
    } else {
      const text = ans.reply.say.trim();
      const broken = checkLine(text, task, this.lineFacts());
      line = broken.length
        ? { text: standard, why: null, notes: [...broken.map((r) => r.text), "VerifyDesk used its standard line instead."], source: "ai" }
        : { text, why: null, notes: [], source: "ai" };
    }
    this.d.log.append(this.id, "agent_decision", {
      task,
      proposed: ans.reply,
      applied: { tool: "none", say: line.text },
      why: null,
      notes: line.notes,
      source: line.source,
      ms: ans.ms,
      error: ans.error,
    });
    return line;
  }

  // The agent pressed Verify now.
  manualVerify(employeeId?: string): Promise<Assessment> {
    return this.serial(async () => {
      if (employeeId && employeeId !== this.facts.employee?.id) {
        const r = this.tool("lookup_employee", { query: employeeId }, "agent") as { found: boolean; employee?: CallFacts["employee"] };
        if (!r.found || !r.employee) throw new Error(`Unknown employee ${employeeId}`);
        this.facts = { ...this.facts, employee: r.employee, claimedIdentity: this.facts.claimedIdentity ?? r.employee.name };
        this.tool("get_recent_identity_events", { employeeId: r.employee.id, hours: 24 }, "agent");
        this.refreshContext();
      }
      const emp = this.facts.employee;
      if (!emp) throw new Error("Choose which employee the caller claims to be first.");
      if (this.facts.verification === "pending") throw new Error("A verification request is already waiting for an answer.");
      if (this.facts.decision !== "none") throw new Error("This call already has a decision.");

      this.pushSent = true;
      const r = this.tool(
        "send_push_challenge",
        { employeeId: emp.id, reason: `Help-desk identity check for ${emp.name} (requested by the agent)` },
        "agent",
      ) as { sent: boolean };
      if (r.sent) {
        this.facts = { ...this.facts, verification: "pending" };
        this.publishAssessment();
        this.say(await this.wordLine("verify", emp));
      } else {
        await this.cannotVerify(emp, "agent");
      }
      return this.publishAssessment();
    });
  }

  // No registered phone: block the request and open a ticket.
  private async cannotVerify(emp: NonNullable<CallFacts["employee"]>, by: "verifydesk" | "agent" = "verifydesk") {
    this.tool("block_reset", { employeeId: emp.id, reason: "No registered phone for out-of-band verification" }, by);
    const t = this.tool(
      "create_incident_ticket",
      {
        summary: `Help-desk request for ${emp.name} could not be verified: no registered phone for a verification push.`,
        employeeId: emp.id,
        evidence: this.collectEvidence(),
      },
      by,
    ) as { ticketId: string };
    this.facts = { ...this.facts, verification: "denied", decision: "blocked" };
    this.incident = { ticketId: t.ticketId, reason: "no_phone" };
    this.d.log.append(this.id, "decision", { decision: "blocked", employeeId: emp.id, ticketId: t.ticketId, reason: "no_push_device" });
    this.publishAssessment();
    this.say(await this.wordLine("no_phone", emp));
  }

  // The real employee tapped Yes or No on their phone. The code decides, the AI only words it.
  resolveChallenge(challengeId: string, approved: boolean): Promise<Assessment> {
    const c = this.d.store.challenges.get(challengeId);
    if (!c || c.callId !== this.id) return Promise.reject(new Error(`Unknown challenge ${challengeId}`));
    if (c.status !== "pending") return Promise.reject(new Error(`Challenge already ${c.status}`));
    c.status = approved ? "approved" : "denied";
    c.resolvedAt = this.d.store.now();

    return this.serial(async () => {
      this.d.log.append(this.id, "push_resolved", { challengeId, approved });
      this.facts = { ...this.facts, verification: c.status === "approved" ? "approved" : "denied" };

      const emp = this.facts.employee;
      const action = ACTION_LABEL[this.facts.requestedAction] ?? "request";
      if (emp && approved) {
        this.tool("approve_reset", { employeeId: emp.id });
        this.facts = { ...this.facts, decision: "approved" };
        this.d.log.append(this.id, "decision", { decision: "approved", employeeId: emp.id });
        const a = this.publishAssessment();
        this.say(await this.wordLine("approved", emp));
        return a;
      }
      if (emp) {
        const evidence = this.collectEvidence();
        this.tool("block_reset", { employeeId: emp.id, reason: "Out-of-band verification denied by registered device" });
        const t = this.tool("create_incident_ticket", {
          summary: `Suspected help-desk vishing: ${action} requested for ${emp.name}, push denied by the real employee.`,
          employeeId: emp.id,
          evidence,
        }) as { ticketId: string };
        this.facts = { ...this.facts, decision: "blocked" };
        this.incident = { ticketId: t.ticketId, reason: "denied" };
        this.d.log.append(this.id, "decision", { decision: "blocked", employeeId: emp.id, ticketId: t.ticketId });
        const a = this.publishAssessment();
        this.say(await this.wordLine("denied", emp));
        return a;
      }
      return this.publishAssessment();
    });
  }

  // The caller's quotes and the contradictions, for the security ticket.
  private collectEvidence(): string[] {
    const quotes = this.d.log
      .forCall(this.id)
      .filter((e) => e.type === "extraction" && typeof e.payload.evidenceQuote === "string" && e.payload.evidenceQuote)
      .map((e) => `"${e.payload.evidenceQuote as string}"`);
    return [...quotes, ...this.facts.findings.map((f) => f.text)];
  }

  // The agent ended the call. After a security ticket, VerifyDesk says the closing line.
  end(): Promise<void> {
    return this.serial(async () => {
      if (this.ended) return;
      this.ended = true;
      if (this.incident) {
        this.say({ text: closingLine(this.incident.reason), why: null, notes: [], source: "fixed", kind: "closing" });
      }
      this.d.log.append(this.id, "call_ended", { decision: this.facts.decision, ticketId: this.incident?.ticketId ?? null });
    });
  }
}

// Keeps track of all open calls.
export class SessionManager {
  private sessions = new Map<string, CallSession>();
  private n = 0;
  constructor(private readonly deps: SessionDeps) {}

  start(scenario?: string): CallSession {
    this.n += 1;
    const id = `CALL-${String(this.n).padStart(3, "0")}-${Date.now().toString(36)}`;
    const s = new CallSession(id, this.deps, scenario);
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): CallSession | undefined {
    return this.sessions.get(id);
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  findByChallenge(challengeId: string): CallSession | undefined {
    const c = this.deps.store.challenges.get(challengeId);
    return c ? this.sessions.get(c.callId) : undefined;
  }
}
