// Talks to Groq and Ollama (both use the same OpenAI-style API) for text and for speech-to-text.

import type { ChatMessage, ChatResult, JsonRequest, LLMProvider, STTProvider } from "./types.js";

export interface CompatOptions {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  speechFilter?: boolean;
  ollamaNativeUrl?: string;
  timeoutMs?: number;
}

async function post(url: string, body: unknown, apiKey: string | undefined, timeoutMs: number) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<any>;
}

// Gets the JSON out of a model answer, even if it added extra text.
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error(`Model did not return JSON: ${text.slice(0, 200)}`);
  }
}

// This calls the text AI.
export class CompatLLM implements LLMProvider {
  readonly name: string;
  constructor(private readonly o: CompatOptions) {
    this.name = o.name;
  }

  private async rawJson(
    system: string,
    user: string,
    jsonSchema: Record<string, unknown>,
    fast?: { timeoutMs: number },
  ): Promise<string> {
    const timeout = fast?.timeoutMs ?? this.o.timeoutMs ?? 60_000;
    if (this.o.ollamaNativeUrl) {
      const data = await post(
        `${this.o.ollamaNativeUrl}/api/chat`,
        {
          model: this.o.model,
          stream: false,
          format: jsonSchema,
          options: { temperature: 0 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        undefined,
        timeout,
      );
      return String(data?.message?.content ?? "");
    }
    const data = await post(
      `${this.o.baseUrl}/chat/completions`,
      {
        model: this.o.model,
        temperature: 0,
        response_format: { type: "json_object" },
        ...(fast && /gpt-oss/.test(this.o.model) ? { reasoning_effort: "low" } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      this.o.apiKey,
      timeout,
    );
    return String(data?.choices?.[0]?.message?.content ?? "");
  }

  async json<T>(req: JsonRequest<T>): Promise<{ value: T; ms: number }> {
    const t0 = performance.now();
    let user = req.user;
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.rawJson(req.system, user, req.jsonSchema, req.fast);
      try {
        const value = req.schema.parse(extractJson(text));
        return { value, ms: Math.round(performance.now() - t0) };
      } catch (err) {
        if (attempt === 1 || req.fast) throw err;
        user = `${req.user}\n\nYour previous answer was invalid (${String(err).slice(0, 200)}). Reply with ONLY valid JSON matching the schema.`;
      }
    }
    throw new Error("unreachable");
  }

  async chat(messages: ChatMessage[], tools?: unknown[]): Promise<ChatResult> {
    const t0 = performance.now();
    const data = await post(
      `${this.o.baseUrl}/chat/completions`,
      { model: this.o.model, temperature: 0.2, messages, ...(tools?.length ? { tools } : {}) },
      this.o.apiKey,
      this.o.timeoutMs ?? 60_000,
    );
    const msg = data?.choices?.[0]?.message ?? {};
    return {
      content: String(msg.content ?? ""),
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
      ms: Math.round(performance.now() - t0),
    };
  }
}

// This calls the speech-to-text AI.
export class CompatSTT implements STTProvider {
  readonly name: string;
  private useChatFallback = false;
  constructor(private readonly o: CompatOptions & { chatFallback?: boolean }) {
    this.name = o.name;
  }

  async transcribe(audio: Buffer, filename: string): Promise<{ text: string; ms: number }> {
    const t0 = performance.now();
    if (!this.useChatFallback) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), filename);
      form.append("model", this.o.model);
      form.append("response_format", this.o.speechFilter ? "verbose_json" : "json");
      form.append("language", "en");
      const res = await fetch(`${this.o.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { text?: string; segments?: WhisperSegment[] };
        return { text: cleanTranscript(speechOnly(data)), ms: Math.round(performance.now() - t0) };
      }
      const body = (await res.text()).slice(0, 300);
      if (!(this.o.chatFallback && (res.status === 404 || res.status === 405 || res.status === 501))) {
        throw new Error(`STT ${this.name} HTTP ${res.status}: ${body}`);
      }
      this.useChatFallback = true;
    }
    const text = await this.transcribeViaChat(audio);
    return { text, ms: Math.round(performance.now() - t0) };
  }

  private async transcribeViaChat(audio: Buffer): Promise<string> {
    const data = await post(
      `${this.o.baseUrl}/chat/completions`,
      {
        model: this.o.model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "input_audio", input_audio: { data: audio.toString("base64"), format: "wav" } },
              { type: "text", text: "Transcribe this audio exactly. Reply with only the words that were spoken." },
            ],
          },
        ],
      },
      this.o.apiKey,
      this.o.timeoutMs ?? 60_000,
    );
    return cleanTranscript(String(data?.choices?.[0]?.message?.content ?? ""));
  }
}

const PROMPT_ECHO = /(only output the transcri|follow these (specific )?instructions|transcribe this audio|when transcribing numbers|reply with only the words)/i;

export interface WhisperSegment {
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
}

// Drops pieces of audio Whisper thinks were just noise.
export function speechOnly(data: { text?: string; segments?: WhisperSegment[] }): string {
  if (!Array.isArray(data.segments) || data.segments.length === 0) return data.text ?? "";
  return data.segments
    .filter((g) => !((g.no_speech_prob ?? 0) > 0.6 && (g.avg_logprob ?? 0) < -1))
    .map((g) => g.text)
    .join("")
    .trim();
}

// Removes empty or junk transcripts so noise never becomes a call line.
export function cleanTranscript(text: string): string {
  if (PROMPT_ECHO.test(text)) return "";
  if (!/[\p{L}\p{N}]/u.test(text)) return "";
  return text
    .trim()
    .replace(/^(transcript(ion)?|here is the transcription)\s*:\s*/i, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
}
