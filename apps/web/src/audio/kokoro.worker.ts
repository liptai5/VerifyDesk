// Runs the Kokoro voice model in a background thread.

import { KOKORO_URL, MODEL_ID, type WorkerReply, type WorkerRequest } from "./kokoroProtocol";

type Tts = { generate: (text: string, o: { voice: string; speed?: number }) => Promise<{ audio: Float32Array; sampling_rate: number }> };
let loading: Promise<Tts> | null = null;
const post = (m: WorkerReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function load(): Promise<Tts> {
  loading ??= (async () => {
    const mod = await import(/* @vite-ignore */ KOKORO_URL).catch(() => {
      throw new Error("Couldn't load the Kokoro voice engine. Check your internet connection (it's downloaded once).");
    });
    return mod.KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (p: { status: string; progress?: number }) => {
        if (p.status === "progress" && typeof p.progress === "number") post({ type: "progress", pct: p.progress });
      },
    }) as Promise<Tts>;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  try {
    const tts = await load();
    if (m.type === "load") return post({ type: "done", id: m.id });
    const out = await tts.generate(m.text, { voice: m.voice });
    const samples = out.audio;
    post({ type: "done", id: m.id, samples, sampleRate: out.sampling_rate }, [samples.buffer]);
  } catch (err) {
    post({ type: "error", id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
