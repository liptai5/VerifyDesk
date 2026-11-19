// The Verify now button: the agent can send a check at any time.

import { useEffect, useState } from "react";
import type { CallView } from "../state/callView";
import { api } from "../lib/api";

export function VerifyNow({ view, onError }: { view: CallView; onError: (m: string) => void }) {
  const [people, setPeople] = useState<{ id: string; name: string; title: string }[]>([]);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.employees().then(setPeople).catch(() => {});
  }, []);

  if (!view.callId || view.ended) return null;
  const pending = view.pushes.some((p) => p.status === "pending");
  if (view.decision) return null;
  if (pending) return <p className="text-sm text-white/85">Waiting for the employee to answer on their phone</p>;

  const send = async () => {
    setBusy(true);
    try {
      await api.verify(view.callId!, view.employee ? undefined : choice);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 md:justify-end">
      {!view.employee && (
        <select
          aria-label="Who does the caller claim to be?"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="rounded-md border border-white/60 bg-white/15 px-2 py-1.5 text-sm text-white"
        >
          <option value="" className="text-ink">
            Who does the caller claim to be?
          </option>
          {people.map((p) => (
            <option key={p.id} value={p.id} className="text-ink">
              {p.name}, {p.title}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={send}
        disabled={busy || (!view.employee && !choice)}
        className="rounded-md border-2 border-white bg-white/10 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/20 disabled:opacity-50"
      >
        {view.employee ? `Verify ${view.employee.name} now` : "Verify now"}
      </button>
    </div>
  );
}
