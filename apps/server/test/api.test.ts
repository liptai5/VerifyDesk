// Tests the server's web addresses end to end.

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { loadRecordings, MockLLM, MockSTT } from "../src/providers/mock.js";
import { FIXTURES_DIR, loadScript, makeStore } from "./helpers.js";

let base = "";
let close: () => void;

beforeAll(async () => {
  const { app } = createApp({
    cfg: { ...config, runsDir: "" },
    llm: new MockLLM(loadRecordings(FIXTURES_DIR)),
    stt: new MockSTT(),
    store: makeStore(),
  });
  await new Promise<void>((res) => {
    const server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      close = () => server.close();
      res();
    });
  });
});
afterAll(() => close?.());

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
    async (r) => ({ status: r.status, json: (await r.json()) as any }),
  );

describe("HTTP API", () => {
  it("health reports providers", async () => {
    const r = await fetch(`${base}/api/health`).then((x) => x.json());
    expect(r).toMatchObject({ ok: true, llm: "mock", stt: "mock" });
  });

  it("full attack flow over HTTP, including the employee's device", async () => {
    const { json } = await post("/api/calls", { scenario: "attack" });
    const callId = json.callId as string;
    let last: any;
    for (const t of loadScript("attack").turns) last = (await post(`/api/calls/${callId}/turns`, t)).json;
    expect(last.assessment.state).toBe("ALERT");

    const pending = await fetch(`${base}/api/device/E1001/challenges`).then((x) => x.json());
    expect(pending).toHaveLength(1);
    const res = await post(`/api/challenges/${pending[0].id}/resolve`, { approved: false });
    expect(res.json.assessment.state).toBe("ALERT");

    const events = await fetch(`${base}/api/calls/${callId}/events`).then((x) => x.json());
    expect(events.some((e: any) => e.type === "decision" && e.payload.decision === "blocked")).toBe(true);
  });

  it("validates input", async () => {
    const { json } = await post("/api/calls", {});
    const r = await post(`/api/calls/${json.callId}/turns`, { channel: "verifier", text: "x" });
    expect(r.status).toBe(400);
  });

  it("audio endpoint uses STT (mock uses the hint)", async () => {
    const { json } = await post("/api/calls", {});
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(44)], { type: "audio/wav" }), "u.wav");
    form.append("channel", "caller");
    form.append("hint", "Hi, this is Jane Doe, the CFO.");
    const r = await fetch(`${base}/api/calls/${json.callId}/audio`, { method: "POST", body: form }).then((x) => x.json());
    expect(r.text).toBe("Hi, this is Jane Doe, the CFO.");
  });
});

describe("phone page API", () => {
  it("lists push owners and pushes with names, newest first", async () => {
    const owners = await fetch(`${base}/api/device/owners`).then((x) => x.json());
    expect(owners.some((o: any) => o.name === "Jane Doe")).toBe(true);
    expect(owners.some((o: any) => o.id === "E1017")).toBe(false);

    const { json } = await post("/api/calls", {});
    for (const t of loadScript("benign").turns) await post(`/api/calls/${json.callId}/turns`, t);
    const all = await fetch(`${base}/api/device/challenges`).then((x) => x.json());
    expect(all[0]).toMatchObject({ employeeName: "Tom Becker", status: "pending" });
    expect(all[0].deviceLabel).toContain("Tom");
    const forTom = await fetch(`${base}/api/device/challenges?employeeId=E1004`).then((x) => x.json());
    expect(forTom.every((c: any) => c.employeeId === "E1004")).toBe(true);
  });

  it("health reports LAN addresses for the phone link", async () => {
    const h = await fetch(`${base}/api/health`).then((x) => x.json());
    expect(Array.isArray(h.lanAddresses)).toBe(true);
  });
});
