// Where Kokoro is downloaded from, and the messages between the page and its worker.

export const KOKORO_URL = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

export type WorkerRequest = { id: number; type: "load" } | { id: number; type: "generate"; text: string; voice: string };

export type WorkerReply =
  | { type: "progress"; pct: number }
  | { type: "done"; id: number; samples?: Float32Array; sampleRate?: number }
  | { type: "error"; id: number; message: string };
