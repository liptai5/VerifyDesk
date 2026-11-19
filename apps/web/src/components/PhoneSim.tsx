// The small copy of the employee's phone in the console's right column.

import { useState } from "react";
import type { CallView } from "../state/callView";
import { api, type Health } from "../lib/api";
import { phoneUrl, qrSvg } from "../lib/qr";

export function PhoneSim({ view, onError, health }: { view: CallView; onError: (m: string) => void; health: Health | null }) {
  const push = view.pushes[view.pushes.length - 1];
  const [busy, setBusy] = useState(false);
  const owner = view.employee?.name ?? "the employee";
  const [showQr, setShowQr] = useState(false);
  const url = phoneUrl(health?.lanAddresses, view.employee?.id);

  const answer = async (approved: boolean) => {
    if (!push) return;
    setBusy(true);
    try {
      await api.resolvePush(push.challengeId, approved);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border-b border-line px-5 py-5">
      <h2 className="text-[0.95rem] font-semibold">{owner === "the employee" ? "Employee's phone" : `${owner}'s real phone`}</h2>
      <p className="mt-0.5 text-sm text-muted">The registered device, held by the real employee, not the caller.</p>

      <div className="mx-auto mt-3 w-full max-w-[17rem] rounded-[1.6rem] border-[6px] border-ink bg-ink p-1.5">
        <div className="min-h-[9.5rem] rounded-[1.1rem] bg-panel p-3.5">
          {!push && <p className="pt-8 text-center text-sm text-muted">No verification requests.</p>}
          {push && (
            <div>
              <p className="text-xs font-semibold text-muted">Do IT Better sign-in check</p>
              <p className="mt-1 leading-snug font-semibold">Is this you calling the IT help desk?</p>
              <p className="mt-1 text-sm text-muted">{push.reason}</p>
              {push.status === "pending" ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => answer(false)}
                    disabled={busy}
                    className="rounded-lg border-2 border-alert py-2 text-sm font-semibold text-alert disabled:opacity-50"
                  >
                    No, deny
                  </button>
                  <button
                    onClick={() => answer(true)}
                    disabled={busy}
                    className="rounded-lg bg-safe py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    Yes, approve
                  </button>
                </div>
              ) : (
                <p className={`mt-3 text-sm font-semibold ${push.status === "approved" ? "text-safe" : "text-alert"}`}>
                  {push.status === "approved" ? "You approved this request." : "You denied this request."}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 text-sm">
        <button type="button" onClick={() => setShowQr((v) => !v)} aria-expanded={showQr} className="font-semibold text-voice underline underline-offset-2">
          {showQr ? "Hide" : "Open this phone on your real phone"}
        </button>
        {showQr && (
          <div className="mt-3">
            {url ? (
              <>
                <div className="w-40 rounded bg-white p-1" aria-label={`QR code for ${url}`} dangerouslySetInnerHTML={{ __html: qrSvg(url) }} />
                <p className="mt-2 break-all text-muted">
                  Scan with your phone's camera (same Wi-Fi as this laptop), or open <span className="font-semibold text-ink">{url}</span>.
                  You can also open <a className="underline" href="/device" target="_blank" rel="noreferrer">/device</a> in a second tab.
                </p>
              </>
            ) : (
              <p className="text-muted">
                No Wi-Fi address found. Open <a className="underline" href="/device" target="_blank" rel="noreferrer">/device</a> in a second tab instead.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
