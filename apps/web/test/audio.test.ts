// Tests the speech detector, WAV files and resampling.

import { describe, expect, it, vi } from "vitest";
import { resample } from "../src/audio/resample.js";
import { EnergyVad, rmsDb, type VadEvent } from "../src/audio/vad.js";
import { decodeWav, encodeWav } from "../src/audio/wav.js";

const RATE = 16000;
const FRAME = 320;

function tone(ms: number, amp = 0.3, hz = 220): Float32Array {
  const n = Math.round((RATE * ms) / 1000);
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / RATE));
}
function noise(ms: number, amp = 0.002): Float32Array {
  const n = Math.round((RATE * ms) / 1000);
  let seed = 7;
  return Float32Array.from({ length: n }, () => {
    seed = (seed * 16807) % 2147483647;
    return amp * ((seed / 2147483647) * 2 - 1);
  });
}
function feed(vad: EnergyVad, ...parts: Float32Array[]): VadEvent[] {
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  const events: VadEvent[] = [];
  for (let i = 0; i + FRAME <= all.length; i += FRAME) events.push(...vad.push(all.subarray(i, i + FRAME)));
  return events;
}

describe("WAV encoding", () => {
  it("round-trips samples and sample rate", () => {
    const s = tone(100);
    const wav = encodeWav(s, RATE);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(wav.length).toBe(44 + s.length * 2);
    const back = decodeWav(wav);
    expect(back.sampleRate).toBe(RATE);
    expect(back.samples.length).toBe(s.length);
    expect(Math.abs(back.samples[100]! - s[100]!)).toBeLessThan(1e-3);
  });
  it("clips out-of-range values instead of wrapping", () => {
    const back = decodeWav(encodeWav(Float32Array.from([2, -2]), RATE));
    expect(back.samples[0]).toBeGreaterThan(0.99);
    expect(back.samples[1]).toBeLessThan(-0.99);
  });
});

describe("resampling to 16 kHz", () => {
  it("48 kHz -> 16 kHz keeps duration", () => {
    expect(resample(new Float32Array(48000), 48000).length).toBe(16000);
  });
  it("same rate is a no-op", () => {
    const s = tone(10);
    expect(resample(s, RATE)).toBe(s);
  });
});

describe("voice activity detection", () => {
  it("finds one utterance between silences", () => {
    const vad = new EnergyVad({ sampleRate: RATE });
    const events = feed(vad, noise(1000), tone(1500), noise(1200));
    expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
    const end = events[1] as Extract<VadEvent, { type: "speech_end" }>;
    expect(end.durationMs).toBeGreaterThan(1400);
    expect(end.durationMs).toBeLessThan(2200);
    expect(end.samples.length).toBe((end.durationMs / 1000) * RATE);
  });

  it("splits two sentences separated by a pause", () => {
    const vad = new EnergyVad({ sampleRate: RATE });
    const events = feed(vad, noise(600), tone(900), noise(1000), tone(900), noise(1000));
    expect(events.filter((e) => e.type === "speech_end")).toHaveLength(2);
  });

  it("keeps short pauses inside one utterance", () => {
    const vad = new EnergyVad({ sampleRate: RATE });
    const events = feed(vad, noise(600), tone(600), noise(300), tone(600), noise(1000));
    expect(events.filter((e) => e.type === "speech_end")).toHaveLength(1);
  });

  it("drops clicks shorter than the minimum", () => {
    const vad = new EnergyVad({ sampleRate: RATE });
    const events = feed(vad, noise(600), tone(80), noise(1000));
    expect(events.map((e) => e.type)).toEqual(["speech_start", "discarded"]);
  });

  it("cuts very long speech to stay under the 30 s model limit", () => {
    const vad = new EnergyVad({ sampleRate: RATE, maxUtteranceMs: 3000 });
    const events = feed(vad, noise(500), tone(7000));
    expect(events.filter((e) => e.type === "speech_end").length).toBeGreaterThanOrEqual(2);
  });

  it("flush() ends an utterance when the mic stops", () => {
    const vad = new EnergyVad({ sampleRate: RATE });
    feed(vad, noise(500), tone(1000));
    expect(vad.isSpeaking).toBe(true);
    expect(vad.flush()[0]?.type).toBe("speech_end");
  });

  it("measures level in dBFS", () => {
    expect(rmsDb(new Float32Array(10))).toBe(-100);
    expect(Math.round(rmsDb(Float32Array.from({ length: 100 }, () => 1)))).toBe(0);
  });
});
