// The help-desk console: call controls, signal band, transcript, recommendations, microphone and side panels.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBlob, playUrl } from "./audio/playback";
import { loadKokoro } from "./audio/kokoro";
import { idle, onSpeaking, speak, type VoiceEngine } from "./audio/speaker";
import { SayThis, type LineStatus } from "./components/SayThis";
import { VerifyNow } from "./components/VerifyNow";
import { Composer } from "./components/Composer";
import { MicPanel } from "./components/MicPanel";
import { PhoneSim } from "./components/PhoneSim";
import { ActionLog, CallerRecord, Checklist, WarningSigns } from "./components/SidePanels";
import { SignalBanner } from "./components/SignalBanner";
import { Transcript } from "./components/Transcript";
import { api, type Health, type Scenario } from "./lib/api";
import { useCallEvents, type LinkStatus } from "./state/useCallEvents";

// Pause between script lines in Play the rest.
const AUTOPLAY_GAP_MS = 1400;
// Menu value for a live call (no script).
const LIVE = "__live";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stored<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
  }
}

// The whole console page.
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState("attack");
  const [callId, setCallId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [autoplay, setAutoplay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<"caller" | "agent">("caller");
  const [voices, setVoices] = useState(true);
  const [engine, setEngine] = useState<VoiceEngine>(() => stored("vd.engine", "kokoro"));
  const [lineStatus, setLineStatus] = useState<Record<string, LineStatus>>({});
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const { view, status } = useCallEvents(callId);

  useEffect(() => onSpeaking(setSpeakingId), []);
  useEffect(() => store("vd.engine", engine), [engine]);

  const say = useCallback(
    (id: string, text: string) => {
      setLineStatus((m) => ({ ...m, [id]: "preparing" }));
      void speak(id, text, engine, setError).then(() => setLineStatus((m) => ({ ...m, [id]: "spoken" })));
    },
    [engine],
  );

  useEffect(() => {
    setLineStatus({});
  }, [callId]);
  useEffect(() => {
    const fresh = view.turns.filter((t) => t.channel === "verifier" && !(t.id in lineStatus));
    if (!fresh.length) return;
    fresh.filter((t) => t.kind === "closing").forEach((t) => say(t.id, t.text));
    const suggest = fresh.filter((t) => t.kind !== "closing");
    if (suggest.length) setLineStatus((m) => ({ ...m, ...Object.fromEntries(suggest.map((t) => [t.id, "suggested" as const])) }));
  }, [view.turns, lineStatus, say]);

  const pending = view.turns.filter(
    (x) =>
      x.channel === "verifier" &&
      x.id !== speakingId &&
      (lineStatus[x.id] === "suggested" || lineStatus[x.id] === "preparing"),
  );
  const first = pending[0];
  const suggestion = first ? { id: first.id, text: first.text, status: lineStatus[first.id]!, turn: first, more: pending.length - 1 } : null;
  const shownStatus: Record<string, LineStatus> = { ...lineStatus, ...(speakingId ? { [speakingId]: "speaking" } : {}) };

  const autoplayRef = useRef(false);
  autoplayRef.current = autoplay;

  useEffect(() => {
    api.health().then(setHealth).catch(() => setError("The VerifyDesk server isn't reachable. Start it with npm run dev."));
    api.scenarios().then(setScenarios).catch(() => {});
  }, []);

  const live = scenarioId === LIVE;
  const scenario = scenarios.find((s) => s.id === scenarioId);
  const lines = scenario?.turns ?? [];
  const finished = cursor >= lines.length;
  const hasAudio = lines.some((l) => l.audio);
  const useVoices = voices && hasAudio;

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      setAutoplay(false);
    } finally {
      setBusy(false);
    }
  };

  const startCall = () =>
    run(async () => {
      setAutoplay(false);
      if (engine === "kokoro") void loadKokoro().catch(() => {});
      const { callId: id } = await api.startCall(live ? "live" : scenarioId);
      setCallId(id);
      setCursor(0);
    });

  const playNext = useCallback(async () => {
    if (!callId || cursor >= lines.length) return;
    const line = lines[cursor]!;
    await idle();
    if (useVoices && line.audio) {
      const wav = await fetchBlob(line.audio);
      await playUrl(line.audio);
      await api.addAudio(callId, line.channel, wav, line.text);
    } else {
      await api.addTurn(callId, line.channel, line.text);
    }
    await wait(400);
    setCursor((c) => c + 1);
  }, [callId, cursor, lines, useVoices]);

  useEffect(() => {
    if (!autoplay || busy) return;
    if (finished) {
      setAutoplay(false);
      return;
    }
    const t = setTimeout(() => run(playNext), cursor === 0 ? 300 : AUTOPLAY_GAP_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay, busy, cursor, finished]);

  const endCall = () =>
    run(async () => {
      setAutoplay(false);
      if (callId) await api.endCall(callId);
    });

  const sendTyped = async (channel: "caller" | "agent", text: string) => {
    if (!callId) return;
    await run(async () => {
      await api.addTurn(callId, channel, text);
    });
  };

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <Header health={health} status={status} lastMs={view.lastExtractionMs} />

      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-6 py-3">
        <label className="flex items-center gap-2 text-sm font-semibold">
          Call
          <select
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value)}
            disabled={autoplay}
            className="rounded-md border border-line bg-white px-2 py-1.5 font-normal"
          >
            <optgroup label="Scripted calls">
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </optgroup>
            <optgroup label="Simulate a call">
              <option value={LIVE}>Live call: you play the caller and the agent</option>
            </optgroup>
          </select>
        </label>
        <button onClick={startCall} disabled={busy || autoplay} className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
          {callId ? "Start a new call" : "Start call"}
        </button>
        {!live && (
          <>
            <Divider />
            <button
              onClick={() => run(playNext)}
              disabled={!callId || busy || autoplay || finished || view.ended}
              className="rounded-md border border-ink px-4 py-2 text-sm font-semibold disabled:opacity-40"
            >
              Play next line
            </button>
            <button
              onClick={() => setAutoplay((a) => !a)}
              disabled={!callId || finished || view.ended}
              className="rounded-md border border-ink px-4 py-2 text-sm font-semibold disabled:opacity-40"
            >
              {autoplay ? "Pause" : "Play the rest"}
            </button>
            <label className={`flex items-center gap-2 text-sm ${hasAudio ? "" : "text-muted"}`}>
              <input type="checkbox" checked={useVoices} disabled={!hasAudio || autoplay} onChange={(e) => setVoices(e.target.checked)} className="h-4 w-4 accent-[var(--color-ink)]" />
              Play voices
            </label>
            {!hasAudio && scenario && (
              <a href="/studio" className="text-sm font-semibold text-voice underline underline-offset-2">
                Record voices for this script
              </a>
            )}
          </>
        )}
        <Divider />
        <button onClick={endCall} disabled={!callId || busy || view.ended} className="rounded-md border border-line bg-white px-4 py-2 text-sm font-semibold disabled:opacity-40">
          End call
        </button>
        {callId && (view.decision || view.ended) && (
          <a href={`/report/${callId}`} target="_blank" rel="noreferrer" className="rounded-md bg-voice px-4 py-2 text-sm font-semibold text-white">
            Open the report
          </a>
        )}
        <label className="ml-auto flex items-center gap-2 text-sm">
          VerifyDesk voice
          <select value={engine} onChange={(e) => setEngine(e.target.value as VoiceEngine)} className="rounded-md border border-line bg-white px-2 py-1.5">
            <option value="kokoro">Natural (Kokoro)</option>
            <option value="browser">Built-in (instant)</option>
          </select>
        </label>
        <div className="basis-full">
          {live ? (
            callId ? (
              <p className="max-w-[95ch] text-sm text-muted">
                <span className="mr-2 font-semibold text-ink">{view.ended ? "Call ended." : "Live call."}</span>
                {view.ended
                  ? "Open the report, or start a new call."
                  : "Talk with the microphone on and switch Speaking as whenever the other person talks. Press Verify now in the coloured band for a check at any time."}
              </p>
            ) : (
              <ol className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted" aria-label="How to run a live call">
                <li><span className="font-semibold text-ink">1.</span> Press <span className="font-semibold text-ink">Start call</span></li>
                <li><span className="font-semibold text-ink">2.</span> Press <span className="font-semibold text-ink">Start listening</span> below and talk</li>
                <li><span className="font-semibold text-ink">3.</span> Switch <span className="font-semibold text-ink">Speaking as</span> between Caller and Agent</li>
                <li><span className="font-semibold text-ink">4.</span> Say the lines VerifyDesk recommends, or let it say them</li>
              </ol>
            )
          ) : (
            scenario && (
              <p className="max-w-[95ch] text-sm text-muted">
                {callId && (
                  <span className="mr-2 font-semibold text-ink">{view.ended ? "Call ended." : `Line ${Math.min(cursor, lines.length)} of ${lines.length}.`}</span>
                )}
                {scenario.description}
              </p>
            )
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="border-b border-alert/40 bg-alert/10 px-6 py-2 text-sm font-semibold text-alert">
          {error}
        </p>
      )}

      <SignalBanner view={view} action={<VerifyNow view={view} onError={setError} />} />

      <main className="grid flex-1 lg:min-h-0 lg:grid-cols-[1fr_25rem]">
        <div className="flex min-h-[24rem] flex-col border-line lg:min-h-0 lg:border-r">
          <div data-scroll className="flex-1 overflow-y-auto bg-white">
            <Transcript view={view} lineStatus={shownStatus} hideIds={pending.map((x) => x.id)} live={live} />
          </div>
          <SayThis
            line={suggestion}
            onReadOut={() => suggestion && say(suggestion.id, suggestion.text)}
            onSaidIt={() => suggestion && setLineStatus((m) => ({ ...m, [suggestion.id]: "agent" }))}
            onSkip={() => suggestion && setLineStatus((m) => ({ ...m, [suggestion.id]: "skipped" }))}
          />
          <MicPanel callId={callId} channel={channel} setChannel={setChannel} health={health} disabled={!callId || view.ended} onError={setError} />
          <Composer disabled={!callId || view.ended} onSend={sendTyped} channel={channel} />
        </div>
        <aside className="bg-panel lg:overflow-y-auto">
          <CallerRecord view={view} />
          <WarningSigns view={view} />
          <PhoneSim view={view} onError={setError} health={health} />
          <Checklist view={view} />
          <ActionLog view={view} />
        </aside>
      </main>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 hidden h-6 w-px bg-line sm:block" />;
}

// The dark top bar: company, active AI, connection.
function Header({ health, status, lastMs }: { health: Health | null; status: LinkStatus; lastMs: number | null }) {
  const dot = status === "live" ? "bg-safe" : status === "connecting" ? "bg-watch" : "bg-alert";
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-ink px-6 py-3 text-white">
      <div className="flex items-baseline gap-3">
        <span className="font-signal text-[1.9rem] leading-none font-bold">VerifyDesk</span>
        <span className="text-sm text-white/70">{health?.company ? `${health.company}, IT Service Desk` : "Help-desk call verifier"}</span>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-4 text-sm text-white/80">
        {health && (
          <>
            <span>AI model: {health.llm}</span>
            <span title="Who chooses VerifyDesk's next step and words its lines">
              Verifier: {health.verifier === "fixed" ? "standard steps" : health.llm === "mock" ? "AI agent (demo script)" : "AI agent"}
            </span>
            <span>Transcription: {health.stt}</span>
            {lastMs !== null && lastMs > 0 && (
              <span title="How long the AI took to read the last caller sentence">
                Last analysis: <span className={lastMs > 5000 ? "font-semibold text-[#ffb3ab]" : ""}>{(lastMs / 1000).toFixed(1)} s</span>
              </span>
            )}
          </>
        )}
        <a href="/reports" className="font-semibold text-white underline underline-offset-2">
          Reports
        </a>
        <span className="flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden />
          {status === "live" ? "Connected" : status === "connecting" ? "Connecting" : "Disconnected, retrying"}
        </span>
      </div>
    </header>
  );
}
