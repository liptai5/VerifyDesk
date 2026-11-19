// VerifyDesk's voice. It only speaks when the agent hands it a line, one line at a time.

import { synthesize } from "./kokoro";
import { holdMic } from "./playback";
import { encodeWav } from "./wav";

export type VoiceEngine = "browser" | "kokoro";
// VerifyDesk's voice. Change it to any voice in kokoro.ts.
export const VERIFIER_KOKORO_VOICE = "bf_emma";

type Listener = (speaking: string | null) => void;
const listeners = new Set<Listener>();
let queue: Promise<void> = Promise.resolve();
let pending = 0;
let current: string | null = null;

function notify(id: string | null) {
  current = id;
  for (const l of listeners) l(id);
}

export function onSpeaking(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function speakingId() {
  return current;
}

export function idle(): Promise<void> {
  return queue;
}

export function browserVoicesAvailable() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function pickBrowserVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
  const prefer = [/natural/i, /aria|jenny|sonia|libby/i, /google uk english female/i, /en-gb/i, /female/i];
  for (const re of prefer) {
    const v = voices.find((x) => re.test(`${x.name} ${x.lang}`));
    if (v) return v;
  }
  return voices[0];
}

function speakBrowser(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (speechSynthesis.getVoices().length === 0 && !("onvoiceschanged" in speechSynthesis)) return resolve();
    const words = text.split(/\s+/).length;
    const guard = setTimeout(resolve, 2000 + words * 450);
    const done = () => {
      clearTimeout(guard);
      resolve();
    };
    const u = new SpeechSynthesisUtterance(text);
    const v = pickBrowserVoice();
    if (v) u.voice = v;
    u.rate = 1.02;
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  });
}

async function playSamples(samples: Float32Array, sampleRate: number): Promise<void> {
  const url = URL.createObjectURL(new Blob([encodeWav(samples, sampleRate) as BlobPart], { type: "audio/wav" }));
  try {
    await new Promise<void>((resolve, reject) => {
      const a = new Audio(url);
      a.onended = () => resolve();
      a.onerror = () => reject(new Error("Couldn't play VerifyDesk's voice"));
      a.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Says one line, with the microphone paused.
export function speak(id: string, text: string, engine: VoiceEngine, onError?: (m: string) => void): Promise<void> {
  pending++;
  queue = queue.then(async () => {
    const ready = engine === "kokoro" ? synthesize(text, VERIFIER_KOKORO_VOICE).catch(() => null) : Promise.resolve(null);
    const release = holdMic();
    notify(id);
    try {
      if (engine === "kokoro") {
        try {
          const audio = await ready;
          if (!audio) throw new Error("The natural voice isn't available.");
          await playSamples(audio.samples, audio.sampleRate);
        } catch (e) {
          onError?.(`${(e as Error).message} Using the browser voice instead.`);
          if (browserVoicesAvailable()) await speakBrowser(text);
        }
      } else if (browserVoicesAvailable()) {
        await speakBrowser(text);
      }
    } finally {
      release();
      pending--;
      notify(null);
    }
  });
  return queue;
}

export function hush() {
  if (browserVoicesAvailable()) speechSynthesis.cancel();
}
