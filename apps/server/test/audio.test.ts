// Tests audio uploads, speech-to-text and the noise filters.

import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { MockLLM, MockSTT } from "../src/providers/mock.js";
import { cleanTranscript, CompatSTT, speechOnly } from "../src/providers/openaiCompat.js";
import { FIXTURES_DIR, makeStore } from "./helpers.js";

function wav(): Buffer {
  const b = Buffer.alloc(44 + 20);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + 20, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(20, 40);
  return b;
}

describe("script audio + voice studio routes", () => {
  let base = "";
  let server: Server;
  const fixtures = mkdtempSync(join(tmpdir(), "vd-fixtures-"));

  beforeAll(async () => {
    cpSync(FIXTURES_DIR, fixtures, { recursive: true });
    const { app } = createApp({
      cfg: { ...config, runsDir: "", fixturesDir: fixtures },
      llm: new MockLLM(new Map()),
      stt: new MockSTT(),
      store: makeStore(),
    });
    await new Promise<void>((res) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        res();
      });
    });
  });
  afterAll(() => server?.close());

  it("saves a WAV for a script line and serves it back", async () => {
    const r = await fetch(`${base}/api/studio/attack/1?voice=af_bella`, {
      method: "PUT",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(wav()),
    }).then((x) => x.json());
    expect(r).toMatchObject({ saved: true, file: "02-caller.wav" });

    const script = JSON.parse(readFileSync(join(fixtures, "calls/attack/script.json"), "utf8"));
    expect(script.turns[1].audio).toBe("02-caller.wav");
    expect(script.turns[1].voice).toBe("af_bella");
    expect(script.turns[1].extraction).toBeTruthy();

    const list = await fetch(`${base}/api/scenarios`).then((x) => x.json());
    const url = list.find((s: any) => s.id === "attack").turns[1].audio;
    expect(url).toBe("/api/scenarios/attack/audio/02-caller.wav");
    const audio = await fetch(base + url);
    expect(audio.headers.get("content-type")).toContain("audio/wav");
    expect(Buffer.from(await audio.arrayBuffer()).subarray(0, 4).toString()).toBe("RIFF");
  });

  it("rejects non-WAV uploads and unknown lines", async () => {
    const notWav = await fetch(`${base}/api/studio/attack/0`, {
      method: "PUT",
      headers: { "content-type": "audio/wav" },
      body: new TextEncoder().encode("hello world, definitely not a wav file at all!!"),
    });
    expect(notWav.status).toBe(400);
    const noLine = await fetch(`${base}/api/studio/attack/99`, { method: "PUT", headers: { "content-type": "audio/wav" }, body: new Uint8Array(wav()) });
    expect(noLine.status).toBe(404);
  });

  it("blocks path tricks", async () => {
    const r = await fetch(`${base}/api/scenarios/attack/audio/..%2F..%2Fscript.json`);
    expect(r.status).toBe(400);
  });
});

describe("Ollama transcription", () => {
  it("falls back to sending audio to the chat endpoint when /audio/transcriptions is missing", async () => {
    let chatBody: any;
    const fake = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        if (req.url === "/v1/audio/transcriptions") {
          res.writeHead(404).end("not found");
        } else if (req.url === "/v1/chat/completions") {
          chatBody = JSON.parse(data);
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ choices: [{ message: { content: '"Hi, this is Jane Doe."' } }] }),
          );
        } else res.writeHead(500).end();
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    const port = (fake.address() as AddressInfo).port;
    const stt = new CompatSTT({ name: "ollama:test", baseUrl: `http://127.0.0.1:${port}/v1`, model: "gemma4:e4b", chatFallback: true });

    const first = await stt.transcribe(wav(), "u.wav");
    expect(first.text).toBe("Hi, this is Jane Doe.");
    expect(chatBody.messages[0].content[0].type).toBe("input_audio");
    expect(chatBody.messages[0].content[0].input_audio.format).toBe("wav");

    chatBody = undefined;
    await stt.transcribe(wav(), "u.wav");
    expect(chatBody).toBeTruthy();
    fake.close();
  });

  it("cleans chatty transcripts", () => {
    expect(cleanTranscript('Transcription: "Move my MFA now."')).toBe("Move my MFA now.");
  });
});

describe("transcript safety", () => {
  it("drops a model repeating its own instructions instead of transcribing", () => {
    expect(cleanTranscript("Follow these specific instructions for formatting the answer. * Only output the transcription, with no newlines.")).toBe("");
    expect(cleanTranscript("Hi Mark, this is Peter.")).toBe("Hi Mark, this is Peter.");
  });
});

describe("noise never becomes a call line", () => {
  it("drops transcripts without any words", () => {
    expect(cleanTranscript(".")).toBe("");
    expect(cleanTranscript(" ... ")).toBe("");
    expect(cleanTranscript("I'm locked out.")).toBe("I'm locked out.");
  });
  it("drops Whisper segments it scores as not speech", () => {
    const data = {
      text: " Thank you. I need my password reset.",
      segments: [
        { text: " Thank you.", no_speech_prob: 0.92, avg_logprob: -1.4 },
        { text: " I need my password reset.", no_speech_prob: 0.02, avg_logprob: -0.2 },
      ],
    };
    expect(speechOnly(data)).toBe("I need my password reset.");
    expect(speechOnly({ text: "Hello there." })).toBe("Hello there.");
  });
});
