// The "VerifyDesk recommends" bar: the next line to say, oldest first.

import type { TurnView } from "../state/callView";
import { WhyAndRules } from "./Transcript";

export type LineStatus = "suggested" | "preparing" | "speaking" | "spoken" | "agent" | "skipped";

export function SayThis({
  line,
  onReadOut,
  onSaidIt,
  onSkip,
}: {
  line: { id: string; text: string; status: LineStatus; turn?: TurnView; more?: number } | null;
  onReadOut: () => void;
  onSaidIt: () => void;
  onSkip: () => void;
}) {
  const waiting = line?.status === "preparing";
  return (
    <section
      aria-live="polite"
      aria-label="VerifyDesk recommends"
      className={`min-h-[7.25rem] shrink-0 border-t-[3px] px-6 py-3 ${line ? "border-voice bg-voice/5" : "border-line bg-panel"}`}
    >
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-[28rem]">
          <p className={`text-sm font-semibold ${line ? "text-voice" : "text-muted"}`}>
            {line ? (waiting ? "VerifyDesk is about to say this" : "VerifyDesk recommends you say") : "VerifyDesk recommends"}
            {line && (line.more ?? 0) > 0 && (
              <span className="ml-2 font-normal text-muted">
                then {line.more} more {line.more === 1 ? "line" : "lines"}
              </span>
            )}
          </p>
          {line ? (
            <>
              <p className="mt-0.5 max-w-[75ch] text-[1.05rem] leading-snug font-semibold">{line.text}</p>
              {line.turn && <WhyAndRules turn={line.turn} />}
            </>
          ) : (
            <p className="mt-0.5 max-w-[75ch] text-sm text-muted">
              Nothing to say right now. When VerifyDesk has a line for the caller, it appears here.
            </p>
          )}
        </div>
        {line && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 self-center">
            <button onClick={onSaidIt} disabled={waiting} className="rounded-md bg-voice px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              I said it
            </button>
            <button onClick={onReadOut} disabled={waiting} className="rounded-md border border-voice px-4 py-2 text-sm font-semibold text-voice disabled:opacity-50">
              Let VerifyDesk say it
            </button>
            {!waiting && (
              <button onClick={onSkip} className="rounded-md px-3 py-2 text-sm font-semibold text-muted underline underline-offset-2">
                Skip
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
