// The call transcript. Keeps the newest line in view.

import { useEffect, useRef } from "react";
import type { CallView, TurnView } from "../state/callView";
import { splitEvidence } from "../lib/format";
import { SPEAKER, STATE_COLOR, STATE_COPY } from "../lib/labels";
import type { LineStatus } from "./SayThis";

const VERIFIER_NOTE: Record<LineStatus, string> = {
  suggested: "Suggested to the agent, not said",
  preparing: "VerifyDesk is about to say this",
  speaking: "Speaking on the call now",
  spoken: "Spoken on the call by VerifyDesk",
  agent: "Said by the agent",
  skipped: "Skipped by the agent",
};

const SPEAKER_COLOR: Record<TurnView["channel"], string> = {
  caller: "var(--color-ink)",
  agent: "var(--color-muted)",
  verifier: "var(--color-voice)",
};

export function Transcript({
  view,
  lineStatus = {},
  hideIds = [],
  live = false,
}: {
  view: CallView;
  lineStatus?: Record<string, LineStatus>;
  hideIds?: string[];
  live?: boolean;
}) {
  const turns = view.turns.filter((t) => !hideIds.includes(t.id));
  const end = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const box = end.current?.closest<HTMLElement>("[data-scroll]");
    if (!box) return;
    const toBottom = () => {
      box.scrollTop = box.scrollHeight;
    };
    const onScroll = () => {
      pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    };
    const ro = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    ro.observe(box);
    box.addEventListener("scroll", onScroll);
    return () => {
      ro.disconnect();
      box.removeEventListener("scroll", onScroll);
    };
  }, [turns.length > 0]);

  useEffect(() => {
    const box = end.current?.closest<HTMLElement>("[data-scroll]");
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    pinned.current = true;
  }, [turns.length]);

  if (turns.length === 0) {
    return (
      <div className="flex h-full items-center px-8 py-16">
        <p className="max-w-[48ch] text-lg text-muted">
          {view.callId
            ? live
              ? "The call is open. Press Start listening and speak as the caller or the agent, or type what they say below."
              : "The call is open. Play the next line of the script, or record or type what the caller says below."
            : live
              ? "Press Start call, then Start listening and talk: switch Speaking as between the caller and the agent."
              : "Press Start call to begin the script. You can also record or type your own lines once the call is open."}
        </p>
      </div>
    );
  }

  return (
    <ol className="flex flex-col" aria-label="Call transcript">
      {turns.map((t) => (
        <Line key={t.id} turn={t} status={lineStatus[t.id]} />
      ))}
      <div ref={end} />
    </ol>
  );
}

function Line({ turn, status }: { turn: TurnView; status?: LineStatus }) {
  const speaking = status === "speaking";
  const parts = turn.channel === "caller" ? splitEvidence(turn.text, turn.evidence) : null;
  const stateColor = turn.stateAfter ? STATE_COLOR[turn.stateAfter] : undefined;

  return (
    <li
      className={`grid gap-1 border-b sm:grid-cols-[6.5rem_1fr] sm:gap-4 border-line px-6 py-4 ${turn.channel === "verifier" ? "bg-voice/5" : ""}`}
    >
      <span className="pt-0.5 text-sm font-semibold" style={{ color: SPEAKER_COLOR[turn.channel] }}>
        {SPEAKER[turn.channel]}
      </span>
      <div>
        <p
          className={`max-w-[68ch] leading-relaxed ${turn.channel === "caller" ? "text-[1.08rem]" : "text-base"} ${turn.channel === "agent" ? "text-muted" : ""}`}
          style={turn.channel === "verifier" ? { color: "var(--color-voice)" } : undefined}
        >
          {parts ? (
            <>
              {parts[0]}
              <mark className="evidence" style={{ textDecorationColor: stateColor ?? "var(--color-watch)" }}>
                {parts[1]}
              </mark>
              {parts[2]}
            </>
          ) : (
            turn.text
          )}
        </p>
        {turn.channel === "verifier" && <WhyAndRules turn={turn} />}
        {turn.channel === "verifier" && (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-voice/80">
            {speaking && <span aria-hidden className="inline-block h-2 w-2 animate-pulse rounded-full bg-voice" />}
            {VERIFIER_NOTE[status ?? "suggested"]}
          </p>
        )}
        {turn.stateAfter && (
          <p className="mt-1.5 flex items-center gap-1.5 text-sm" style={{ color: stateColor }}>
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: stateColor }} />
            {STATE_COPY[turn.stateAfter].word} after this line
          </p>
        )}
      </div>
    </li>
  );
}

// Under a VerifyDesk line: why the AI chose it, and any safety rule that changed it.
export function WhyAndRules({ turn }: { turn: TurnView }) {
  if (!turn.why && !turn.notes?.length) return null;
  return (
    <div className="mt-1.5 max-w-[68ch] space-y-1 text-sm">
      {turn.why && (
        <p className="text-ink/75">
          <span className="font-semibold">Why: </span>
          {turn.why}
        </p>
      )}
      {turn.notes?.map((n, i) => (
        <p key={i} className="border-l-[3px] border-watch pl-2 text-ink/80">
          <span className="font-semibold">Safety rule: </span>
          {n}
        </p>
      ))}
    </div>
  );
}
