// The big coloured band: the risk level and what to tell the agent.

import type React from "react";
import type { RiskState } from "@verifydesk/shared";
import type { CallView } from "../state/callView";
import { ACTION_LABEL, STATE_COLOR, STATE_COPY } from "../lib/labels";

export function SignalBanner({ view, action }: { view: CallView; action?: React.ReactNode }) {
  const a = view.assessment;
  const state: RiskState | null = a?.state ?? null;
  const bg = state ? STATE_COLOR[state] : "var(--color-ink)";
  const history = view.turns.filter((t) => t.channel === "caller" && t.stateAfter).map((t) => t.stateAfter!);

  let instruction = "Waiting for the caller.";
  if (!view.callId) instruction = "No call in progress.";
  else if (view.decision?.decision === "blocked") {
    const what =
      a?.requestedAction === "send_code"
        ? "No code or sign-in details shared."
        : !a?.requestedAction || a.requestedAction === "none"
          ? "Verification failed. Nothing was shared or changed."
          : "Change blocked.";
    instruction = `${what}${view.decision.ticketId ? ` Security ticket ${view.decision.ticketId} opened.` : ""}`;
  }
  else if (view.decision?.decision === "approved")
    instruction = a?.requestedAction && a.requestedAction !== "none" ? "Verified on the registered phone. Change approved." : "Verified on the registered phone.";
  else if (a?.whisper) instruction = a.whisper;
  else if (a) instruction = "Keep the conversation going.";

  return (
    <section
      aria-live="polite"
      aria-label="Call risk"
      className="signal grid gap-x-8 gap-y-3 px-6 py-5 text-white md:grid-cols-[minmax(11rem,auto)_1fr_auto] md:items-center"
      style={{ backgroundColor: bg }}
    >
      <div>
        <p className="font-signal text-[4.5rem] leading-[0.85] font-bold tracking-tight">
          {state ? STATE_COPY[state].word : view.callId ? "Listening" : "Idle"}
        </p>
        <p className="mt-2 text-sm text-white/85">{state ? STATE_COPY[state].meaning : "VerifyDesk joins when the call starts"}</p>
      </div>

      <div className="max-w-[60ch]">
        <p className="text-sm text-white/80">Tell the agent</p>
        <p className="text-xl leading-snug font-semibold">{instruction}</p>
      </div>

      <div className="flex flex-col gap-2 md:items-end">
        <p className="text-sm">
          <span className="text-white/80">Request: </span>
          <span className="font-semibold">{ACTION_LABEL[a?.requestedAction ?? "none"]}</span>
        </p>
        {action}
        {history.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/80">Each caller line</span>
            <ol className="flex items-center gap-1 rounded bg-white px-1.5 py-1" aria-label="Risk after each caller line">
              {history.map((s, i) => (
                <li
                  key={i}
                  title={`Line ${i + 1}: ${STATE_COPY[s].word}`}
                  className="h-3.5 w-5 rounded-[2px]"
                  style={{ backgroundColor: STATE_COLOR[s] }}
                >
                  <span className="sr-only">{`Line ${i + 1}: ${STATE_COPY[s].word}`}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </section>
  );
}
