// Plays a scripted call in the terminal and prints every step, with PASS or FAIL.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config, type ProviderName } from "../apps/server/src/config.js";
import { Store } from "../apps/server/src/data/store.js";
import { EventLog } from "../apps/server/src/events/log.js";
import { createLLM } from "../apps/server/src/providers/index.js";
import { CallSession } from "../apps/server/src/session.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const which = args.find((a) => !a.startsWith("--") && a !== flag("provider")) ?? "attack";
const provider = (flag("provider") as ProviderName | undefined) ?? config.llmProvider;
const names = which === "all" ? ["attack", "benign"] : [which];

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", b: "\x1b[34m", m: "\x1b[35m", d: "\x1b[2m", x: "\x1b[0m", B: "\x1b[1m" };
const stateColor: Record<string, string> = { SAFE: C.g, WATCH: C.y, ALERT: C.r, UNCERTAIN: C.m };

let failures = 0;
for (const name of names) {
  const script = JSON.parse(readFileSync(join(config.fixturesDir, "calls", name, "script.json"), "utf8"));
  const store = new Store(config.dataDir);
  const log = new EventLog();
  const llm = createLLM(config, provider);
  const session = new CallSession(
    `SIM-${name}`,
    { store, log, llm, verifier: config.verifier, agentTimeoutMs: config.agentTimeoutMs },
    name,
  );

  console.log(`\n${C.B}${script.title}${C.x}  ${C.d}(LLM: ${llm.name}, verifier: ${config.verifier === "fixed" ? "standard steps" : "AI agent"})${C.x}\n`);
  log.subscribe((e) => {
    const p = e.payload as any;
    if (e.type === "turn") console.log(`${p.channel === "caller" ? C.B + "CALLER" : "AGENT "}${C.x}  ${p.text}`);
    if (e.type === "extraction")
      console.log(`${C.d}        extracted in ${p.ms} ms: action=${p.requestedAction} tactics=[${p.tactics.join(", ")}] situation=[${p.situation.join(", ")}]${C.x}`);
    if (e.type === "tool_call") console.log(`${C.b}        ⚙ ${p.name}(${JSON.stringify(p.args)})${p.error ? C.r + " ERROR " + p.error : ""}${C.x}`);
    if (e.type === "assessment") {
      const col = stateColor[p.state] ?? "";
      console.log(`        ${col}■ ${p.state}${C.x}${p.whisper ? `  whisper: "${p.whisper}"` : ""}`);
      for (const a of p.anomalies) console.log(`${C.d}          · ${a}${C.x}`);
    }
    if (e.type === "push_sent") console.log(`${C.m}        📱 push sent to ${p.employeeId} (${p.deviceId})${C.x}`);
    if (e.type === "agent_decision" && p.task === "decide" && p.why && p.applied?.tool !== "none")
      console.log(`${C.d}        AI chose ${p.applied.tool}: ${p.why}${C.x}`);
    if (e.type === "agent_decision") for (const n of p.notes ?? []) console.log(`${C.y}        safety rule: ${n}${C.x}`);
    if (e.type === "verifier_said") console.log(`${C.m}VERIFIER${C.x} ${p.text}`);
    if (e.type === "decision") console.log(`${C.B}        DECISION: ${p.decision.toUpperCase()}${p.ticketId ? ` (ticket ${p.ticketId})` : ""}${C.x}`);
  });

  const t0 = performance.now();
  try {
    for (const t of script.turns) await session.addTurn(t.channel, t.text);
    const push = [...store.challenges.values()][0];
    if (push) {
      const approve = script.expected.devicePress === "approve";
      console.log(`${C.m}        📱 real ${push.employeeId} taps ${approve ? "APPROVE" : "DENY"} on the registered phone${C.x}`);
      await session.resolveChallenge(push.id, approve);
    }
  } catch (e) {
    console.error(`${C.r}Error: ${(e as Error).message}${C.x}`);
    console.error(`${C.d}Run \`npm run doctor\` to check your setup.${C.x}`);
    process.exit(1);
  }

  const final = session.lastAssessment?.state;
  const pass = final === script.expected.finalState && session.facts.decision === script.expected.decision;
  if (!pass) failures++;
  console.log(
    `\n${pass ? C.g + "PASS" : C.r + "FAIL"}${C.x}  final=${final} decision=${session.facts.decision}  ` +
      `(expected ${script.expected.finalState}/${script.expected.decision})  ${C.d}${Math.round(performance.now() - t0)} ms total${C.x}\n`,
  );
}
process.exit(failures ? 1 : 0);
