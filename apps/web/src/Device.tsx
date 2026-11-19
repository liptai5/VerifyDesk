// The employee's phone page: shows verification checks and the Yes / No buttons.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DeviceChallenge, type DeviceOwner } from "./lib/api";

export function Device() {
  const params = new URLSearchParams(location.search);
  const [owner, setOwner] = useState<string>(params.get("employee") ?? "");
  const [owners, setOwners] = useState<DeviceOwner[]>([]);
  const [list, setList] = useState<DeviceChallenge[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [alerts, setAlerts] = useState(false);
  const seen = useRef(new Set<string>());
  const ctx = useRef<AudioContext | null>(null);

  const refresh = useCallback(async () => {
    try {
      const l = await api.deviceChallenges(owner || undefined);
      setList(l);
      setError(null);
      const fresh = l.filter((c) => c.status === "pending" && !seen.current.has(c.id));
      l.forEach((c) => seen.current.add(c.id));
      if (fresh.length) ring();
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);

  useEffect(() => {
    api.deviceOwners().then(setOwners).catch(() => {});
  }, []);

  useEffect(() => {
    seen.current = new Set();
    void refresh();
    const url = new URL(location.href);
    if (owner) url.searchParams.set("employee", owner);
    else url.searchParams.delete("employee");
    history.replaceState(null, "", url);
  }, [owner, refresh]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => {
        setOnline(true);
        void refresh();
      };
      ws.onmessage = (m) => {
        const e = JSON.parse(String(m.data)) as { type: string };
        if (e.type === "push_sent" || e.type === "push_resolved") void refresh();
      };
      ws.onclose = () => {
        setOnline(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [refresh]);

  function ring() {
    navigator.vibrate?.([180, 80, 180]);
    const c = ctx.current;
    if (!c) return;
    [880, 1175].forEach((hz, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, c.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.25, c.currentTime + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + i * 0.16 + 0.14);
      o.connect(g).connect(c.destination);
      o.start(c.currentTime + i * 0.16);
      o.stop(c.currentTime + i * 0.16 + 0.15);
    });
  }

  const enableAlerts = () => {
    ctx.current ??= new AudioContext();
    void ctx.current.resume();
    setAlerts(true);
    ring();
  };

  const answer = async (c: DeviceChallenge, approved: boolean) => {
    setBusy(c.id);
    try {
      await api.resolvePush(c.id, approved);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pending = list.find((c) => c.status === "pending");
  const history_ = list.filter((c) => c !== pending).slice(0, 5);
  const ownerName = owners.find((o) => o.id === owner)?.name;
  const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex min-h-[100dvh] flex-col bg-ink text-white">
      <div className="flex items-center justify-between px-5 pt-3 text-sm text-white/80">
        <span>{time}</span>
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${online ? "bg-safe" : "bg-alert"}`} aria-hidden />
          {online ? "Online" : "Reconnecting"}
        </span>
      </div>

      <header className="px-5 pt-6">
        <p className="font-signal text-[2.1rem] leading-none font-bold">Do IT Better Verify</p>
        <label className="mt-3 block text-sm text-white/75">
          This is the registered phone of
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-white/25 bg-white/10 px-3 py-2.5 text-base text-white"
          >
            <option value="" className="text-ink">
              Any employee (demo)
            </option>
            {owners.map((o) => (
              <option key={o.id} value={o.id} className="text-ink">
                {o.name}, {o.title}
              </option>
            ))}
          </select>
        </label>
        {!alerts && (
          <button onClick={enableAlerts} className="mt-3 w-full rounded-lg border border-white/40 py-2.5 text-sm font-semibold">
            Turn on sound for new requests
          </button>
        )}
      </header>

      <main className="flex-1 px-5 py-6">
        {error && <p className="mb-4 rounded-lg bg-alert/90 px-3 py-2 text-sm font-semibold">{error}</p>}

        {pending ? (
          <section className="rounded-2xl bg-white p-5 text-ink" aria-live="assertive">
            <p className="text-sm font-semibold text-muted">Sign-in check for {pending.employeeName}</p>
            <h1 className="mt-2 text-[1.45rem] leading-tight font-bold">Is this you calling the IT help desk right now?</h1>
            <p className="mt-2 text-[0.95rem]">
              Someone on a call asked for: <span className="font-semibold">{pending.reason.replace(/^Help-desk /, "").replace(/ for .*$/, "")}</span>
            </p>
            <p className="mt-3 text-sm text-muted">If you're not on a call with the help desk, tap No. Your account stays safe.</p>
            <div className="mt-5 grid gap-3">
              <button
                onClick={() => answer(pending, false)}
                disabled={busy === pending.id}
                className="rounded-xl border-2 border-alert py-4 text-lg font-bold text-alert disabled:opacity-50"
              >
                No, it's not me
              </button>
              <button
                onClick={() => answer(pending, true)}
                disabled={busy === pending.id}
                className="rounded-xl bg-safe py-4 text-lg font-bold text-white disabled:opacity-50"
              >
                Yes, it's me
              </button>
            </div>
          </section>
        ) : (
          <section className="rounded-2xl border border-white/20 p-5 text-center">
            <p className="text-lg font-semibold">No requests right now</p>
            <p className="mt-1 text-sm text-white/70">
              {ownerName ? `When someone calls the help desk as ${ownerName}, the check appears here.` : "When the help desk sends a verification check, it appears here."}
            </p>
          </section>
        )}

        {history_.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold text-white/75">Earlier</h2>
            <ul className="mt-2 divide-y divide-white/15">
              {history_.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span>
                    {c.employeeName}
                    <span className="text-white/60"> {new Date(c.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
                  </span>
                  <span className={c.status === "approved" ? "text-[#7fd1a8]" : c.status === "denied" ? "text-[#ff9b91]" : "text-white/60"}>
                    {c.status === "approved" ? "Approved" : c.status === "denied" ? "Denied" : c.status}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="px-5 pb-5 text-xs text-white/55">
        Simulated phone for the VerifyDesk demo. The help desk can't see or tap this screen.
      </footer>
    </div>
  );
}
