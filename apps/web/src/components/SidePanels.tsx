// The right column: caller record, warning signs, verification steps and actions taken.

import type { ReactNode } from "react";
import type { CallView, StepView } from "../state/callView";
import { ago, clock } from "../lib/format";
import { EVENT_LABEL, TACTIC_LABEL, TOOL_LABEL } from "../lib/labels";

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="border-b border-line px-5 py-5">
      <h2 className="text-[0.95rem] font-semibold">{title}</h2>
      {note && <p className="mt-0.5 text-sm text-muted">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

const TIER_LABEL: Record<string, string> = {
  high: "High-risk account",
  elevated: "Elevated-risk account",
  standard: "Standard account",
};

const TIER_STYLE: Record<string, string> = {
  high: "bg-alert/10 text-alert",
  elevated: "bg-watch/10 text-watch",
  standard: "bg-ink/5 text-muted",
};

// The directory record of who the caller claims to be.
export function CallerRecord({ view }: { view: CallView }) {
  const e = view.employee;
  if (!e) {
    return (
      <Section title="Caller on file">
        <p className="text-sm text-muted">No one identified yet. VerifyDesk looks the caller up as soon as they give a name.</p>
      </Section>
    );
  }
  return (
    <Section title="Caller on file">
      <p className="font-signal text-[2rem] leading-none font-semibold">{e.name}</p>
      <p className="mt-1 text-sm">
        {e.title}, {e.department}. Based in {e.location}.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs font-semibold">
        <span className={`rounded px-2 py-0.5 ${TIER_STYLE[e.riskTier]}`}>{TIER_LABEL[e.riskTier]}</span>
        {e.status !== "active" && <span className="rounded bg-alert/10 px-2 py-0.5 text-alert">{e.status.replace("_", " ")}</span>}
        <span className="rounded bg-ink/5 px-2 py-0.5 text-muted">Phone on file {e.phoneOnFile}</span>
      </div>

      {view.devices.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold text-muted">Registered devices</h3>
          <ul className="mt-1 text-sm">
            {view.devices.map((d) => (
              <li key={d.id} className="flex justify-between gap-3 py-1">
                <span>
                  {d.label}
                  {d.pushEnabled ? "" : " (no push)"}
                </span>
                <span className="shrink-0 text-muted">
                  {ago(d.lastSeenMinutesAgo)}, {d.lastLocation}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {view.identityEvents.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold text-muted">Last 24 hours</h3>
          <ul className="mt-1 text-sm">
            {view.identityEvents.slice(0, 4).map((ev, i) => (
              <li key={i} className="flex justify-between gap-3 py-1">
                <span>{EVENT_LABEL[ev.type] ?? ev.type}</span>
                <span className="shrink-0 text-muted">
                  {ago(ev.minutesAgo)}, {ev.location}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

const STEP_STYLE: Record<StepView["tone"], { mark: string; cls: string; label: string }> = {
  done: { mark: "✓", cls: "border-ink bg-ink text-white", label: "done" },
  good: { mark: "✓", cls: "border-safe bg-safe text-white", label: "passed" },
  bad: { mark: "!", cls: "border-alert bg-alert text-white", label: "problem" },
  wait: { mark: "…", cls: "border-line bg-white text-muted", label: "waiting" },
};

// The verification steps that actually happened, in order.
export function Checklist({ view }: { view: CallView }) {
  const waiting = view.pushes.some((x) => x.status === "pending") && !view.decision;
  const steps: StepView[] = [
    ...view.steps,
    ...(waiting ? [{ key: "waiting", text: "Waiting for the employee to answer on their phone", tone: "wait" as const }] : []),
  ];
  return (
    <Section title="Verification steps">
      {steps.length === 0 ? (
        <p className="text-sm text-muted">Each step appears here as it happens, in order.</p>
      ) : (
        <ol className="space-y-2 text-sm">
          {steps.map((st, i) => {
            const style = STEP_STYLE[st.tone];
            return (
              <li key={st.key} className="flex gap-2.5">
                <span className="w-4 shrink-0 pt-0.5 text-right text-xs text-muted tabular-nums">{i + 1}</span>
                <span aria-hidden className={`mt-0.5 grid h-4.5 w-4.5 shrink-0 place-items-center rounded-full border text-[0.65rem] font-bold ${style.cls}`}>
                  {style.mark}
                </span>
                <span className={st.tone === "wait" ? "text-muted" : ""}>
                  {st.text}
                  <span className="sr-only"> ({style.label})</span>
                  {st.detail && <span className="block text-muted">{st.detail}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

// Pressure tactics, contradictions and supporting facts.
export function WarningSigns({ view }: { view: CallView }) {
  const a = view.assessment;
  const tactics = a?.tactics ?? [];
  const anomalies = a?.anomalies ?? [];
  const supporting = a?.supporting ?? [];
  return (
    <Section title="What VerifyDesk noticed">
      {tactics.length === 0 && anomalies.length === 0 && supporting.length === 0 && (
        <p className="text-sm text-muted">No pressure tactics or contradictions so far.</p>
      )}
      {tactics.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Pressure tactics">
          {tactics.map((t) => (
            <li key={t} className="rounded-full border border-watch/50 bg-watch/10 px-2.5 py-0.5 text-sm font-semibold text-[#8a5a06]">
              {TACTIC_LABEL[t] ?? t}
            </li>
          ))}
        </ul>
      )}
      {anomalies.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm" aria-label="Contradictions">
          {anomalies.map((x) => (
            <li key={x} className="border-l-[3px] border-alert pl-2.5">
              {x}
            </li>
          ))}
        </ul>
      )}
      {supporting.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm" aria-label="Consistent with the caller's story">
          {supporting.map((x) => (
            <li key={x} className="border-l-[3px] border-safe pl-2.5">
              {x}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// Every tool VerifyDesk used, with the time.
export function ActionLog({ view }: { view: CallView }) {
  return (
    <Section title="Actions taken">
      {view.tools.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet.</p>
      ) : (
        <ol className="space-y-1.5 text-sm">
          {view.tools.map((t) => (
            <li key={t.seq} className="grid grid-cols-[4.2rem_1fr] gap-2">
              <span className="text-muted">{clock(t.ts)}</span>
              <span className={t.error ? "text-alert" : ""}>
                {TOOL_LABEL[t.name] ?? t.name}
                {t.error ? `: refused (${t.error})` : summarize(t.name, t.result)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function summarize(name: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, any>;
  if (name === "lookup_employee") return r.found ? `: ${r.employee?.name}` : ": no match";
  if (name === "get_recent_identity_events") return `: ${r.events?.length ?? 0} events`;
  if (name === "send_push_challenge") return r.sent ? `: ${r.deviceLabel}` : ": no push device";
  if (name === "create_incident_ticket") return r.ticketId ? `: ${r.ticketId}` : "";
  return "";
}
