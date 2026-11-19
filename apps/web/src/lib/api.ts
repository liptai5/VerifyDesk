// Every request the web app sends to the server.

import type { AuditEvent } from "@verifydesk/shared";

export interface Health {
  ok: boolean;
  llm: string;
  stt: string;
  company: string;
  lanAddresses?: string[];
  verifier?: "agent" | "fixed";
}

export interface DeviceChallenge {
  id: string;
  employeeId: string;
  employeeName: string;
  deviceLabel: string;
  callId: string;
  reason: string;
  status: "pending" | "approved" | "denied" | "timeout" | "none";
  createdAt: number;
}

export interface DeviceOwner {
  id: string;
  name: string;
  title: string;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  turns: { channel: "caller" | "agent"; text: string; audio: string | null; voice: string | null }[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  health: () => req<Health>("/api/health"),
  scenarios: () => req<Scenario[]>("/api/scenarios"),
  startCall: (scenario?: string) =>
    req<{ callId: string }>("/api/calls", { method: "POST", body: JSON.stringify({ scenario }) }),
  addTurn: (callId: string, channel: "caller" | "agent", text: string) =>
    req<unknown>(`/api/calls/${callId}/turns`, { method: "POST", body: JSON.stringify({ channel, text }) }),
  addAudio: async (callId: string, channel: "caller" | "agent", wav: Blob, hint?: string) => {
    const form = new FormData();
    form.append("audio", wav, "utterance.wav");
    form.append("channel", channel);
    if (hint) form.append("hint", hint);
    const res = await fetch(`/api/calls/${callId}/audio`, { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `Transcription failed (${res.status})`);
    return body as { text: string; sttMs: number };
  },
  saveStudioAudio: async (scenario: string, index: number, wav: Blob, voice: string) => {
    const res = await fetch(`/api/studio/${scenario}/${index}?voice=${encodeURIComponent(voice)}`, {
      method: "PUT",
      headers: { "content-type": "audio/wav" },
      body: wav,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `Save failed (${res.status})`);
    return body as { saved: boolean; file: string };
  },
  verify: (callId: string, employeeId?: string) =>
    req<unknown>(`/api/calls/${callId}/verify`, { method: "POST", body: JSON.stringify(employeeId ? { employeeId } : {}) }),
  employees: () => req<{ id: string; name: string; title: string }[]>("/api/employees"),
  deviceChallenges: (employeeId?: string) =>
    req<DeviceChallenge[]>(`/api/device/challenges${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ""}`),
  deviceOwners: () => req<DeviceOwner[]>("/api/device/owners"),
  events: (callId: string) => req<AuditEvent[]>(`/api/calls/${callId}/events`),
  endCall: (callId: string) => req<unknown>(`/api/calls/${callId}/end`, { method: "POST", body: "{}" }),
  resolvePush: (challengeId: string, approved: boolean) =>
    req<unknown>(`/api/challenges/${challengeId}/resolve`, { method: "POST", body: JSON.stringify({ approved }) }),
};
