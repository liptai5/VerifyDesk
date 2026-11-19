// The printable audit report of one call, and the list of all calls.

import { useEffect, useState, type ReactNode } from "react";
import type { AuditEvent, Policy } from "@verifydesk/shared";
import { ago } from "./lib/format";
import { STATE_COLOR, STATE_COPY } from "./lib/labels";
import { buildReport, type Report as ReportData } from "./state/report";

// One call's report.
export function Report() {
  const id = reportIdFromPath(location.pathname);
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/reports/${encodeURIComponent(id)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `Couldn't load the report (${r.status})`);
        return body as { events: AuditEvent[]; policies: Policy[] };
      })
      .then((b) => setData(buildReport(b.events, b.policies)))
      .catch((e) => setError((e as Error).message));
  }, [id]);

  if (!id) return <Reports />;

  return (
    <div className="min-h-screen bg-paper py-8 print:bg-white print:py-0">
      <Toolbar />
      <article className="mx-auto max-w-[52rem] bg-white px-10 py-10 print:max-w-none print:px-0 print:py-0">
        {error && <p className="font-semibold text-alert">{error}</p>}
        {!data && !error && <p className="text-muted">Loading the report…</p>}
        {data && <ReportBody r={data} id={id} />}
      </article>
    </div>
  );
}

function Toolbar() {
  return (
    <div className="mx-auto mb-4 flex max-w-[52rem] flex-wrap items-center gap-3 px-1 print:hidden">
      <a href="/" className="text-sm font-semibold underline underline-offset-2">
        Back to the console
      </a>
      <a href="/reports" className="text-sm font-semibold underline underline-offset-2">
        All calls
      </a>
      <button onClick={() => window.print()} className="ml-auto rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white">
        Print or save as PDF
      </button>
    </div>
  );
}

function ReportBody({ r, id }: { r: ReportData; id: string }) {
  const v = r.view;
  const state = v.assessment?.state ?? null;
  const color = r.outcome === "blocked" ? "var(--color-alert)" : r.outcome === "approved" ? "var(--color-safe)" : state ? STATE_COLOR[state] : "var(--color-ink)";
  const minutes = Math.max(1, Math.round((r.endedAt - r.startedAt) / 60000));
  const when = new Date(r.startedAt).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" });

  return (
    <>
      <header className="flex items-baseline justify-between gap-4 border-b-2 border-ink pb-3">
        <span className="font-signal text-[1.6rem] leading-none font-bold">VerifyDesk</span>
        <span className="text-sm text-muted">Do IT Better Solutions Ltd., IT Service Desk</span>
      </header>

      <h1 className="mt-6 font-signal text-[2.6rem] leading-none font-bold">{r.title}</h1>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
        <dt className="text-muted">Call</dt>
        <dd className="font-semibold">{id}</dd>
        <dt className="text-muted">Date</dt>
        <dd>{when}</dd>
        <dt className="text-muted">Type</dt>
        <dd>{r.mode}</dd>
        <dt className="text-muted">Length</dt>
        <dd>about {minutes} min</dd>
        <dt className="text-muted">AI model</dt>
        <dd>{r.model ?? "unknown"}</dd>
        <dt className="text-muted">Final risk</dt>
        <dd>{state ? STATE_COPY[state].word : "none"}</dd>
        <dt className="text-muted">Verifier</dt>
        <dd>{r.view.verifier === "fixed" ? "Standard steps" : r.view.verifier === "agent" ? "AI agent, checked by safety rules" : "Standard steps"}</dd>
      </dl>

      <section className="mt-6 border-l-[6px] py-1 pl-4" style={{ borderColor: color }}>
        <p className="text-sm font-semibold" style={{ color }}>
          {r.outcome === "blocked" ? "Request blocked" : r.outcome === "approved" ? "Caller verified" : "No decision"}
          {v.decision?.ticketId ? `, security ticket ${v.decision.ticketId}` : ""}
        </p>
        <p className="mt-1 max-w-[70ch] text-[1.05rem] leading-relaxed">{r.summary}</p>
      </section>

      <Section title="Who the caller claimed to be">
        <p className="text-sm">
          <span className="text-muted">Said on the call: </span>
          {r.claims.length ? r.claims.map((c) => `"${c}"`).join(", ") : "no name or role given"}
        </p>
        {v.employee ? (
          <p className="mt-1 text-sm">
            <span className="text-muted">Directory record: </span>
            <span className="font-semibold">{v.employee.name}</span>, {v.employee.title}, {v.employee.department}, {v.employee.location}. Risk level:{" "}
            {v.employee.riskTier}. Status: {v.employee.status.replace("_", " ")}.
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">No matching directory record.</p>
        )}
        {v.devices.length > 0 && (
          <p className="mt-1 text-sm">
            <span className="text-muted">Registered devices: </span>
            {v.devices.map((d) => `${d.label} (seen ${ago(d.lastSeenMinutesAgo)}, ${d.lastLocation})`).join("; ")}
          </p>
        )}
      </Section>

      <Section title="Warning signs">
        {r.tactics.length === 0 && !v.assessment?.anomalies.length && <p className="text-sm text-muted">None found.</p>}
        {r.tactics.length > 0 && (
          <ul className="space-y-1 text-sm">
            {r.tactics.map((t) => (
              <li key={t.labels.join()}>
                <span className="font-semibold">{t.labels.join(", ")}</span>
                {t.quote && <span className="text-muted">: "{t.quote}"</span>}
              </li>
            ))}
          </ul>
        )}
        {v.assessment?.anomalies.length ? (
          <>
            <h3 className="mt-3 text-sm font-semibold">Contradictions with company records</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {v.assessment.anomalies.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </>
        ) : null}
        {v.assessment?.supporting.length ? (
          <>
            <h3 className="mt-3 text-sm font-semibold">Consistent with the caller's story</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {v.assessment.supporting.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </>
        ) : null}
      </Section>

      {r.policies.length > 0 && (
        <Section title="Policies applied">
          <ul className="space-y-1.5 text-sm">
            {r.policies.map((p) => (
              <li key={p.id}>
                <span className="font-semibold">
                  {p.id} {p.title}.
                </span>{" "}
                {p.text}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Timeline">
        <table className="w-full text-left text-sm">
          <thead className="text-muted">
            <tr>
              <th className="w-[5.5rem] pb-1 font-normal">Time</th>
              <th className="w-[8rem] pb-1 font-normal">Who</th>
              <th className="pb-1 font-normal">What happened</th>
            </tr>
          </thead>
          <tbody>
            {r.timeline.map((t, i) => (
              <tr key={i} className="border-t border-line align-top break-inside-avoid">
                <td className="py-1.5 text-muted">{new Date(t.ts).toLocaleTimeString("en-GB")}</td>
                <td className="py-1.5 font-semibold">{t.who ?? ""}</td>
                <td
                  className={`py-1.5 ${t.kind === "line" || t.kind === "verifier" || t.kind === "agent" ? "" : "font-semibold"}`}
                  style={{ color: toneColor(t.tone) }}
                >
                  {t.kind === "line" || t.kind === "verifier" ? `"${t.text}"` : t.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <footer className="mt-10 border-t border-line pt-3 text-xs text-muted">
        Generated by the VerifyDesk prototype from the call's event log. Fictional company, people and data.
      </footer>
    </>
  );
}

function toneColor(t?: string) {
  if (!t) return undefined;
  if (t === "bad") return "var(--color-alert)";
  if (t === "good") return "var(--color-safe)";
  return STATE_COLOR[t as keyof typeof STATE_COLOR];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8 break-inside-avoid-page">
      <h2 className="border-b border-line pb-1 text-[1.05rem] font-semibold">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

interface CallSummary {
  callId: string;
  startedAt: number;
  scenario: string | null;
  employeeName: string | null;
  finalState: string | null;
  decision: string | null;
  ticketId: string | null;
  lines: number;
}

// The list of all calls.
function Reports() {
  const [list, setList] = useState<CallSummary[] | null>(null);
  useEffect(() => {
    fetch("/api/reports")
      .then((r) => r.json())
      .then(setList)
      .catch(() => setList([]));
  }, []);
  return (
    <div className="min-h-screen bg-paper py-8">
      <div className="mx-auto max-w-[52rem] bg-white px-10 py-10">
        <a href="/" className="text-sm font-semibold underline underline-offset-2">
          Back to the console
        </a>
        <h1 className="mt-4 font-signal text-[2.6rem] leading-none font-bold">Call reports</h1>
        <p className="mt-2 text-sm text-muted">Every call is saved in the project's runs/ folder. Open one to see and print its report.</p>
        {list === null && <p className="mt-6 text-muted">Loading…</p>}
        {list?.length === 0 && <p className="mt-6">No calls yet. Start one in the console.</p>}
        <ul className="mt-6 divide-y divide-line">
          {list?.map((c) => (
            <li key={c.callId}>
              <a href={`/report/${c.callId}`} className="grid gap-1 py-3 hover:bg-paper sm:grid-cols-[10rem_1fr_auto] sm:items-baseline sm:gap-4">
                <span className="text-sm text-muted">{new Date(c.startedAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}</span>
                <span>
                  <span className="font-semibold">{c.employeeName ?? "Unidentified caller"}</span>
                  <span className="text-muted"> {c.scenario === "live" ? "live call" : c.scenario ? `script: ${c.scenario}` : ""}, {c.lines} {c.lines === 1 ? "line" : "lines"}</span>
                </span>
                <span
                  className="text-sm font-semibold"
                  style={{ color: c.decision === "blocked" ? "var(--color-alert)" : c.decision === "approved" ? "var(--color-safe)" : "var(--color-muted)" }}
                >
                  {c.decision === "blocked" ? `Blocked${c.ticketId ? `, ${c.ticketId}` : ""}` : c.decision === "approved" ? "Verified" : "No decision"}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// "/report/CALL-001-…" gives the call ID; "/reports" (or "/report") gives "" for the list of all calls.
export function reportIdFromPath(path: string): string {
  return decodeURIComponent(path.replace(/^\/reports?\/?/, "").split("/")[0] ?? "");
}
