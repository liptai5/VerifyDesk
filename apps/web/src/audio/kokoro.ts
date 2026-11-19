// The natural voice (Kokoro). The heavy work happens in kokoro.worker.ts so the page never freezes.

import type { WorkerReply, WorkerRequest } from "./kokoroProtocol";

// The Kokoro voices you can pick in the studio.
export const VOICES: { id: string; label: string }[] = [
  { id: "af_bella", label: "Bella (US, female)" },
  { id: "af_heart", label: "Heart (US, female)" },
  { id: "af_nicole", label: "Nicole (US, female, soft)" },
  { id: "bf_emma", label: "Emma (UK, female)" },
  { id: "am_michael", label: "Michael (US, male)" },
  { id: "am_adam", label: "Adam (US, male)" },
  { id: "am_fenrir", label: "Fenrir (US, male)" },
  { id: "bm_george", label: "George (UK, male)" },
  { id: "bm_lewis", label: "Lewis (UK, male)" },
];

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (r: Extract<WorkerReply, { type: "done" }>) => void; reject: (e: Error) => void }>();
const progressListeners = new Set<(pct: number) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<WorkerReply>) => {
    const m = e.data;
    if (m.type === "progress") return progressListeners.forEach((l) => l(m.pct));
    const job = waiting.get(m.id);
    if (!job) return;
    waiting.delete(m.id);
    if (m.type === "done") job.resolve(m);
    else job.reject(new Error(m.message));
  };
  w.onerror = (e) => {
    for (const job of waiting.values()) job.reject(new Error(e.message || "The natural voice stopped working."));
    waiting.clear();
    w.terminate();
    worker = null;
    loaded = null;
  };
  worker = w;
  return w;
}

type Job = { type: "load" } | { type: "generate"; text: string; voice: string };

function ask(req: Job, onProgress?: (pct: number) => void) {
  const id = nextId++;
  if (onProgress) progressListeners.add(onProgress);
  return new Promise<Extract<WorkerReply, { type: "done" }>>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ ...req, id } as WorkerRequest);
    } catch (e) {
      waiting.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  }).finally(() => {
    if (onProgress) progressListeners.delete(onProgress);
  });
}

let loaded: Promise<void> | null = null;

// Downloads and prepares the voice model once.
export function loadKokoro(onProgress?: (pct: number) => void): Promise<void> {
  loaded ??= ask({ type: "load" }, onProgress).then(() => undefined);
  loaded.catch(() => (loaded = null));
  return loaded;
}

// Turns text into audio.
export async function synthesize(text: string, voice: string, onProgress?: (pct: number) => void) {
  await loadKokoro(onProgress);
  const out = await ask({ type: "generate", text, voice });
  if (!out.samples || !out.sampleRate) throw new Error("The natural voice returned no audio.");
  return { samples: out.samples, sampleRate: out.sampleRate };
}
