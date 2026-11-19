// The microphone controls: Speaking as, Start listening, and what it's hearing.

import { useEffect, useRef, useState } from "react";
import { browserSpeechAvailable, startBrowserSpeech } from "../audio/browserSpeech";
import { startMic, type MicHandle } from "../audio/mic";
import { isPlaying, onPlayingChange } from "../audio/playback";
import { resample } from "../audio/resample";
import { EnergyVad } from "../audio/vad";
import { encodeWav } from "../audio/wav";
import { api, type Health } from "../lib/api";

type Mode = "server" | "browser";
type Status =
  | { kind: "off" }
  | { kind: "listening" }
  | { kind: "hearing" }
  | { kind: "paused" }
  | { kind: "transcribing" }
  | { kind: "heard"; text: string; ms?: number }
  | { kind: "interim"; text: string };

// Sends each sentence to the server (or uses the browser's recognition) as the chosen speaker.
export function MicPanel({
  callId,
  channel,
  setChannel,
  health,
  disabled,
  onError,
}: {
  callId: string | null;
  channel: "caller" | "agent";
  setChannel: (c: "caller" | "agent") => void;
  health: Health | null;
  disabled: boolean;
  onError: (m: string) => void;
}) {
  const serverStt = Boolean(health && health.stt !== "mock");
  const browserStt = browserSpeechAvailable();
  const [mode, setMode] = useState<Mode>(serverStt ? "server" : "browser");
  const [status, setStatus] = useState<Status>({ kind: "off" });
  const [on, setOn] = useState(false);
  const onRef = useRef(false);
  onRef.current = on;
  const [level, setLevel] = useState(0);

  const channelRef = useRef(channel);
  channelRef.current = channel;
  const callRef = useRef(callId);
  callRef.current = callId;
  const stopRef = useRef<(() => void) | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => setMode(serverStt ? "server" : "browser"), [serverStt]);

  const available = mode === "server" ? serverStt : browserStt;

  const stop = () => {
    stopRef.current?.();
    stopRef.current = null;
    onRef.current = false;
    setOn(false);
    setStatus((st) => (st.kind === "transcribing" ? st : { kind: "off" }));
    setLevel(0);
  };

  useEffect(() => {
    if (disabled) stop();
  }, [disabled, callId]);
  useEffect(() => () => stopRef.current?.(), []);

  useEffect(
    () =>
      onPlayingChange((p) =>
        setStatus((s) => (!onRef.current ? s : p ? { kind: "paused" } : s.kind === "paused" ? { kind: "listening" } : s)),
      ),
    [],
  );

  const send = (wav: Blob, who: "caller" | "agent") => {
    queue.current = queue.current.then(async () => {
      const id = callRef.current;
      if (!id) return;
      setStatus({ kind: "transcribing" });
      try {
        const r = await api.addAudio(id, who, wav);
        const idle: Status = onRef.current ? { kind: "listening" } : { kind: "off" };
        setStatus(r.text ? { kind: "heard", text: r.text, ms: r.sttMs } : idle);
      } catch (e) {
        onError((e as Error).message);
        setStatus(onRef.current ? { kind: "listening" } : { kind: "off" });
      }
    });
  };

  const startServerMode = async () => {
    let mic: MicHandle | null = null;
    const vad = { current: null as EnergyVad | null };
    let frames = 0;
    let speakerAtStart: "caller" | "agent" = channelRef.current;
    mic = await startMic((frame) => {
      if (isPlaying()) return;
      const v = vad.current!;
      for (const e of v.push(frame)) {
        if (e.type === "speech_start") {
          speakerAtStart = channelRef.current;
          setStatus({ kind: "hearing" });
        }
        if (e.type === "discarded") {
          setStatus({ kind: "listening" });
        }
        if (e.type === "speech_end") {
          const pcm = resample(e.samples, mic!.sampleRate, 16000);
          send(new Blob([encodeWav(pcm, 16000) as BlobPart], { type: "audio/wav" }), speakerAtStart);
        }
      }
      if (++frames % 4 === 0) setLevel(Math.max(0, Math.min(1, (v.levelDb + 60) / 50)));
    });
    vad.current = new EnergyVad({ sampleRate: mic.sampleRate, frameMs: 20 });
    stopRef.current = () => {
      for (const e of vad.current?.flush() ?? []) {
        if (e.type === "speech_end") send(new Blob([encodeWav(resample(e.samples, mic!.sampleRate), 16000) as BlobPart], { type: "audio/wav" }), speakerAtStart);
      }
      mic?.stop();
    };
  };

  const startBrowserMode = () => {
    let speakerAtStart: "caller" | "agent" | null = null;
    const rec = startBrowserSpeech({
      onInterim: (text) => {
        speakerAtStart ??= channelRef.current;
        setStatus({ kind: "interim", text });
      },
      onFinal: (text) => {
        const id = callRef.current;
        if (!id || isPlaying()) return;
        setStatus({ kind: "heard", text });
        const who = speakerAtStart ?? channelRef.current;
        speakerAtStart = null;
        api.addTurn(id, who, text).catch((e) => onError((e as Error).message));
      },
      onError,
    });
    stopRef.current = () => rec.stop();
  };

  const start = async () => {
    try {
      if (mode === "server") await startServerMode();
      else startBrowserMode();
      onRef.current = true;
      setOn(true);
      setStatus({ kind: "listening" });
    } catch (e) {
      const msg = (e as Error).message;
      onError(
        /denied|NotAllowed/i.test(msg)
          ? "Microphone access was blocked. Click the lock icon in the address bar, allow the microphone, then try again."
          : msg,
      );
      stop();
    }
  };

  const who = channel === "caller" ? "the caller" : "the agent";
  const statusText: Record<Status["kind"], string> = {
    off: disabled ? "Start a call first, then press Start listening and talk." : available ? `Press Start listening and speak as ${who}.` : "",
    listening: `Listening as ${who}… just talk. A sentence ends when you pause.`,
    hearing: `Hearing ${who}…`,
    paused: "Paused while the script audio plays",
    transcribing: on ? "Transcribing and checking…" : "Transcribing and checking your last sentence…",
    heard: "",
    interim: "",
  };

  const engine =
    mode === "server"
      ? `Transcribed by ${health?.stt ?? "the server"}${health?.stt.startsWith("ollama") ? " on this computer" : ""}`
      : "Transcribed by your browser (Chrome and Edge send the audio to their speech service)";

  return (
    <div className="border-t border-line bg-panel px-6 pt-4 pb-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <SpeakingAs channel={channel} setChannel={setChannel} />
        <button
          type="button"
          onClick={on ? stop : start}
          disabled={disabled || !available}
          aria-pressed={on}
          className={`flex items-center gap-2.5 rounded-md px-5 py-2.5 text-[0.95rem] font-semibold disabled:opacity-40 ${on ? "bg-alert text-white" : "bg-ink text-white"}`}
        >
          <span aria-hidden className={`h-3 w-3 rounded-full ${on ? "animate-pulse bg-white" : "bg-[#ff6b5e]"}`} />
          {on ? "Stop listening" : "Start listening"}
        </button>

        {mode === "server" && on && (
          <div className="h-2 w-28 overflow-hidden rounded-full bg-line" aria-label="Microphone level" role="meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-safe transition-[width] duration-75" style={{ width: `${level * 100}%` }} />
          </div>
        )}

        <p className="min-w-[14rem] flex-1 text-sm" aria-live="polite">
          {status.kind === "heard" ? (
            <>
              <span className="text-muted">Heard: </span>“{status.text}”
              {status.ms !== undefined && status.ms > 0 && <span className="text-muted"> ({(status.ms / 1000).toFixed(1)} s to transcribe)</span>}
            </>
          ) : status.kind === "interim" ? (
            <span className="text-muted italic">{status.text}</span>
          ) : (
            <span className="text-muted">{statusText[status.kind]}</span>
          )}
        </p>

        {serverStt && browserStt && !on && (
          <label className="flex items-center gap-2 text-sm text-muted">
            Speech to text
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} className="rounded-md border border-line bg-white px-2 py-1">
              <option value="server">Server ({health?.stt})</option>
              <option value="browser">Browser</option>
            </select>
          </label>
        )}
      </div>

      <p className="mt-2 text-xs text-muted">
        {available
          ? `${engine}. Switch Speaking as when the other person talks. Use a headset so the mic doesn't pick up the speakers.`
          : "No speech-to-text available: the server is in demo mode and this browser has no built-in speech recognition. Use Chrome or Edge, or run with Ollama or Groq. You can still type below."}
      </p>
    </div>
  );
}

function SpeakingAs({ channel, setChannel }: { channel: "caller" | "agent"; setChannel: (c: "caller" | "agent") => void }) {
  return (
    <fieldset className="flex items-center gap-2">
      <legend className="sr-only">Speaking as</legend>
      <span aria-hidden className="text-sm font-semibold">
        Speaking as
      </span>
      <div className="flex overflow-hidden rounded-md border border-ink">
        {(["caller", "agent"] as const).map((c) => (
          <label
            key={c}
            className={`cursor-pointer px-4 py-2 text-sm font-semibold focus-within:outline-2 focus-within:outline-voice ${channel === c ? "bg-ink text-white" : "bg-white text-ink hover:bg-paper"}`}
          >
            <input type="radio" name="speaking-as" value={c} checked={channel === c} onChange={() => setChannel(c)} className="sr-only" />
            {c === "caller" ? "Caller" : "Agent"}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
