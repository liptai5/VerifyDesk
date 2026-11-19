// Works out when someone starts and stops talking, so each sentence is sent on its own.

import { concat } from "./resample";

export interface VadOptions {
  sampleRate: number;
  frameMs?: number;
  marginDb?: number;
  minSpeechDb?: number;
  startFrames?: number;
  hangoverMs?: number;
  preRollMs?: number;
  minUtteranceMs?: number;
  maxUtteranceMs?: number;
}

export type VadEvent =
  | { type: "speech_start" }
  | { type: "speech_end"; samples: Float32Array; durationMs: number }
  | { type: "discarded"; durationMs: number };

// Loudness-based speech detector. Tune it with the numbers in the constructor (margin, pause length...).
export class EnergyVad {
  readonly o: Required<VadOptions>;
  private noiseDb = -60;
  private speaking = false;
  private aboveCount = 0;
  private silentMs = 0;
  private utterance: Float32Array[] = [];
  private utteranceMs = 0;
  private voicedMs = 0;
  private preRoll: Float32Array[] = [];
  levelDb = -100;

  constructor(opts: VadOptions) {
    this.o = {
      frameMs: 20,
      marginDb: 12,
      minSpeechDb: -50,
      startFrames: 3,
      hangoverMs: 700,
      preRollMs: 300,
      minUtteranceMs: 250,
      maxUtteranceMs: 25_000,
      ...opts,
    };
  }

  get isSpeaking() {
    return this.speaking;
  }

  get noiseFloorDb() {
    return this.noiseDb;
  }

  push(frame: Float32Array): VadEvent[] {
    const events: VadEvent[] = [];
    const db = rmsDb(frame);
    this.levelDb = db;
    const isSpeech = db > Math.max(this.noiseDb + this.o.marginDb, this.o.minSpeechDb);

    if (!this.speaking) {
      if (!isSpeech) this.noiseDb = Math.max(-90, this.noiseDb * 0.95 + db * 0.05);
      this.preRoll.push(frame);
      const keep = Math.ceil(this.o.preRollMs / this.o.frameMs);
      while (this.preRoll.length > keep) this.preRoll.shift();
      this.aboveCount = isSpeech ? this.aboveCount + 1 : 0;
      if (this.aboveCount >= this.o.startFrames) {
        this.speaking = true;
        this.utterance = [...this.preRoll];
        this.utteranceMs = this.utterance.length * this.o.frameMs;
        this.voicedMs = this.o.startFrames * this.o.frameMs;
        this.silentMs = 0;
        this.preRoll = [];
        events.push({ type: "speech_start" });
      }
      return events;
    }

    this.utterance.push(frame);
    this.utteranceMs += this.o.frameMs;
    this.silentMs = isSpeech ? 0 : this.silentMs + this.o.frameMs;
    if (isSpeech) this.voicedMs += this.o.frameMs;

    if (this.silentMs >= this.o.hangoverMs || this.utteranceMs >= this.o.maxUtteranceMs) {
      events.push(this.finish());
    }
    return events;
  }

  flush(): VadEvent[] {
    return this.speaking ? [this.finish()] : [];
  }

  private finish(): VadEvent {
    const tailFrames = Math.max(0, Math.floor((this.silentMs - 200) / this.o.frameMs));
    const kept = this.utterance.slice(0, this.utterance.length - tailFrames);
    const durationMs = kept.length * this.o.frameMs;
    const voiced = this.voicedMs;
    this.voicedMs = 0;
    this.speaking = false;
    this.aboveCount = 0;
    this.silentMs = 0;
    this.utterance = [];
    this.utteranceMs = 0;
    if (voiced < this.o.minUtteranceMs) return { type: "discarded", durationMs };
    return { type: "speech_end", samples: concat(kept), durationMs };
  }
}

// How loud a piece of sound is, in dB.
export function rmsDb(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}
