// Voice studio: makes or records the audio for the scripted calls.

import { useEffect, useRef, useState } from "react";
import { synthesize, VOICES } from "./audio/kokoro";
import { startMic, type MicHandle } from "./audio/mic";
import { concat, resample } from "./audio/resample";
import { encodeWav } from "./audio/wav";
import { api, type Scenario } from "./lib/api";

const DEFAULT_VOICE: Record<string, { caller: string; agent: string }> = {
  attack: { caller: "af_bella", agent: "am_michael" },
  benign: { caller: "am_adam", agent: "am_michael" },
};

type LineState = { busy?: "generating" | "recording" | "saving"; error?: string; savedAt?: number };

const toWav = (samples: Float32Array, rate: number) =>
  new Blob([encodeWav(resample(samples, rate, 16000), 16000) as BlobPart], { type: "audio/wav" });

export function Studio() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [voices, setVoices] = useState<Record<string, { caller: string; agent: string }>>(DEFAULT_VOICE);
  const [lines, setLines] = useState<Record<string, LineState>>({});
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const rec = useRef<{ key: string; mic: MicHandle; chunks: Float32Array[] } | null>(null);

  const reload = () => api.scenarios().then(setScenarios).catch((e) => setMessage((e as Error).message));
  useEffect(() => {
    reload();
  }, []);

  const patch = (key: string, s: LineState) => setLines((l) => ({ ...l, [key]: s }));
  const voiceFor = (id: string, channel: "caller" | "agent") => voices[id]?.[channel] ?? (channel === "caller" ? "af_bella" : "am_michael");

  const save = async (s: Scenario, i: number, wav: Blob, voice: string) => {
    const key = `${s.id}:${i}`;
    patch(key, { busy: "saving" });
    await api.saveStudioAudio(s.id, i, wav, voice);
    patch(key, { savedAt: Date.now() });
  };

  const generate = async (s: Scenario, i: number) => {
    const key = `${s.id}:${i}`;
    const line = s.turns[i]!;
    const voice = voiceFor(s.id, line.channel);
    patch(key, { busy: "generating" });
    try {
      const { samples, sampleRate } = await synthesize(line.text, voice, (p) => setProgress(p));
      setProgress(null);
      await save(s, i, toWav(samples, sampleRate), `kokoro:${voice}`);
    } catch (e) {
      setProgress(null);
      patch(key, { error: (e as Error).message });
      throw e;
    }
  };

  const generateAll = async (s: Scenario, onlyMissing: boolean) => {
    setMessage(null);
    try {
      for (let i = 0; i < s.turns.length; i++) {
        if (onlyMissing && s.turns[i]!.audio) continue;
        await generate(s, i);
      }
      await reload();
      setMessage(`Saved voices for "${s.title}". Commit the new files in fixtures/calls/${s.id}/audio/.`);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const toggleRecord = async (s: Scenario, i: number) => {
    const key = `${s.id}:${i}`;
    if (rec.current?.key === key) {
      const { mic, chunks } = rec.current;
      rec.current = null;
      mic.stop();
      try {
        await save(s, i, toWav(concat(chunks), mic.sampleRate), "recorded");
        await reload();
      } catch (e) {
        patch(key, { error: (e as Error).message });
      }
      return;
    }
    if (rec.current) return;
    try {
      const chunks: Float32Array[] = [];
      const mic = await startMic((f) => chunks.push(f));
      rec.current = { key, mic, chunks };
      patch(key, { busy: "recording" });
    } catch (e) {
      patch(key, { error: (e as Error).message });
    }
  };

  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-ink px-6 py-3 text-white">
        <a href="/" className="font-signal text-[1.9rem] leading-none font-bold">
          VerifyDesk
        </a>
        <span className="text-sm text-white/70">Voice studio: make the audio for the scripted calls</span>
        <a href="/" className="ml-auto text-sm font-semibold underline underline-offset-2">
          Back to the console
        </a>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="max-w-[70ch] space-y-2 text-[0.95rem]">
          <p>
            Each line of a script needs an audio file so the console can play it and send it through speech-to-text.
            Generate a line with a synthetic voice, or record it yourself. Files are saved in{" "}
            <code className="rounded bg-ink/5 px-1">fixtures/calls/&lt;script&gt;/audio/</code>; commit them so everyone
            (and the judges) get the same voices.
          </p>
          <p className="text-muted">
            Synthetic voices use Kokoro, which runs in this browser. The first time, it downloads about 80 MB from Hugging
            Face, so it needs internet once. Only record voices of people who agreed to it.
          </p>
        </div>

        {progress !== null && (
          <div className="mt-5 max-w-md" role="status">
            <p className="text-sm font-semibold">Downloading the voice model: {Math.round(progress)}%</p>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-voice" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
        {message && (
          <p role="status" className="mt-5 border-l-[3px] border-voice pl-3 text-sm font-semibold">
            {message}
          </p>
        )}

        {scenarios.map((s) => (
          <section key={s.id} className="mt-10">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3 border-b border-ink pb-3">
              <h2 className="font-signal text-[1.8rem] leading-none font-semibold">{s.title}</h2>
              {(["caller", "agent"] as const).map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  {c === "caller" ? "Caller voice" : "Agent voice"}
                  <select
                    value={voiceFor(s.id, c)}
                    onChange={(e) => setVoices((v) => ({ ...v, [s.id]: { ...voiceFor2(v, s.id), [c]: e.target.value } }))}
                    className="rounded-md border border-line bg-white px-2 py-1"
                  >
                    {VOICES.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <div className="ml-auto flex gap-2">
                <button onClick={() => generateAll(s, true)} className="rounded-md border border-ink px-3 py-1.5 text-sm font-semibold">
                  Generate missing
                </button>
                <button onClick={() => generateAll(s, false)} className="rounded-md bg-ink px-3 py-1.5 text-sm font-semibold text-white">
                  Generate all
                </button>
              </div>
            </div>

            <ol>
              {s.turns.map((t, i) => {
                const key = `${s.id}:${i}`;
                const st = lines[key] ?? {};
                const src = t.audio ? `${t.audio}?v=${st.savedAt ?? 0}` : null;
                return (
                  <li key={key} className="grid gap-3 border-b border-line py-4 md:grid-cols-[5rem_1fr_auto] md:items-center">
                    <span className={`text-sm font-semibold ${t.channel === "caller" ? "" : "text-muted"}`}>
                      {t.channel === "caller" ? "Caller" : "Agent"}
                    </span>
                    <div>
                      <p className="max-w-[65ch]">{t.text}</p>
                      <p className="mt-1 text-xs text-muted">
                        {st.error ? (
                          <span className="text-alert">{st.error}</span>
                        ) : st.busy ? (
                          { generating: "Generating…", recording: "Recording… press Stop when done", saving: "Saving…" }[st.busy]
                        ) : t.audio ? (
                          `Saved${t.voice ? ` (${t.voice})` : ""}`
                        ) : (
                          "No audio yet"
                        )}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {src && <audio controls src={src} className="h-9 w-56" />}
                      <button
                        onClick={() => generate(s, i).then(reload).catch(() => {})}
                        disabled={Boolean(st.busy)}
                        className="rounded-md border border-ink px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
                      >
                        Generate
                      </button>
                      <button
                        onClick={() => toggleRecord(s, i)}
                        disabled={Boolean(st.busy) && st.busy !== "recording"}
                        className={`rounded-md px-3 py-1.5 text-sm font-semibold disabled:opacity-40 ${st.busy === "recording" ? "bg-alert text-white" : "border border-ink"}`}
                      >
                        {st.busy === "recording" ? "Stop" : "Record"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

function voiceFor2(v: Record<string, { caller: string; agent: string }>, id: string) {
  return v[id] ?? { caller: "af_bella", agent: "am_michael" };
}
