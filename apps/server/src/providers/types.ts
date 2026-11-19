// What every AI provider must be able to do, so they can be swapped.

import type { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCallRequest[];
}

export interface ToolCallRequest {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCallRequest[];
  ms: number;
}

// A request that must come back as JSON in a given shape. mock and fast are optional extras.
export interface JsonRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T, unknown>;
  jsonSchema: Record<string, unknown>;
  mockKey?: string;
  mock?: () => unknown;
  fast?: { timeoutMs: number };
}

export interface LLMProvider {
  readonly name: string;
  json<T>(req: JsonRequest<T>): Promise<{ value: T; ms: number }>;
  chat(messages: ChatMessage[], tools?: unknown[]): Promise<ChatResult>;
}

export interface STTProvider {
  readonly name: string;
  transcribe(audio: Buffer, filename: string, hint?: string): Promise<{ text: string; ms: number }>;
}
