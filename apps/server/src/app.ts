// The web addresses (API) the browser talks to: start calls, add lines, verify, phone answers, reports.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { Channel } from "@verifydesk/shared";
import type { Config } from "./config.js";
import { Store } from "./data/store.js";
import { EventLog } from "./events/log.js";
import { listCalls, readCall, SAFE_CALL_ID } from "./events/reports.js";
import type { LLMProvider, STTProvider } from "./providers/types.js";
import { SessionManager } from "./session.js";
import { isToolName } from "./tools/index.js";

export interface AppDeps {
  cfg: Config;
  llm: LLMProvider;
  stt: STTProvider;
  store?: Store;
  log?: EventLog;
}

// Builds the server and all its routes.
export function createApp(deps: AppDeps) {
  const store = deps.store ?? new Store(deps.cfg.dataDir);
  const log = deps.log ?? new EventLog({ runsDir: deps.cfg.runsDir });
  const sessions = new SessionManager({
    store,
    log,
    llm: deps.llm,
    verifier: deps.cfg.verifier,
    agentTimeoutMs: deps.cfg.agentTimeoutMs,
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  const call = (req: Request) => {
    const s = sessions.get(String(req.params.id));
    if (!s) throw new HttpError(404, `Unknown call ${req.params.id}`);
    return s;
  };

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      llm: deps.llm.name,
      stt: deps.stt.name,
      verifier: deps.cfg.verifier,
      company: store.company.name,
      lanAddresses: lanAddresses(),
    });
  });

  app.get("/api/company", (_req, res) => res.json({ company: store.company, policies: store.policies }));
  app.get("/api/employees", (_req, res) => res.json(store.employees));

  app.get("/api/scenarios", (_req, res) => {
    const dir = join(deps.cfg.fixturesDir, "calls");
    const list = existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => existsSync(join(dir, n, "script.json")))
          .map((n) => {
            const s = JSON.parse(readFileSync(join(dir, n, "script.json"), "utf8"));
            return {
              id: n,
              title: s.title,
              description: s.description,
              turns: s.turns.map((t: any) => ({
                channel: t.channel,
                text: t.text,
                audio: t.audio ? `/api/scenarios/${n}/audio/${t.audio}` : null,
                voice: t.voice ?? null,
              })),
            };
          })
      : [];
    res.json(list);
  });

  const SAFE_NAME = /^[a-z0-9][a-z0-9_-]*$/;
  const SAFE_FILE = /^[a-z0-9][a-z0-9_-]*\.wav$/;
  app.get("/api/scenarios/:id/audio/:file", (req, res) => {
    const { id, file } = req.params as { id: string; file: string };
    if (!SAFE_NAME.test(id) || !SAFE_FILE.test(file)) throw new HttpError(400, "Bad audio path");
    const path = join(deps.cfg.fixturesDir, "calls", id, "audio", file);
    if (!existsSync(path)) throw new HttpError(404, "No such audio file");
    res.setHeader("content-type", "audio/wav");
    res.sendFile(path);
  });

  app.put("/api/studio/:id/:index", express.raw({ type: "audio/wav", limit: "8mb" }), (req, res) => {
    const ip = req.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) throw new HttpError(403, "The voice studio only works on the local machine");
    const id = String(req.params.id);
    const index = Number(req.params.index);
    if (!SAFE_NAME.test(id)) throw new HttpError(400, "Bad script name");
    const scriptPath = join(deps.cfg.fixturesDir, "calls", id, "script.json");
    if (!existsSync(scriptPath)) throw new HttpError(404, `Unknown script ${id}`);
    const script = JSON.parse(readFileSync(scriptPath, "utf8"));
    const turn = script.turns?.[index];
    if (!turn) throw new HttpError(404, `Script ${id} has no line ${index}`);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 44 || body.subarray(0, 4).toString() !== "RIFF") {
      throw new HttpError(400, "Send a WAV file (content-type audio/wav)");
    }
    const file = `${String(index + 1).padStart(2, "0")}-${turn.channel}.wav`;
    const dir = join(deps.cfg.fixturesDir, "calls", id, "audio");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), body);
    turn.audio = file;
    if (typeof req.query.voice === "string") turn.voice = req.query.voice.slice(0, 60);
    writeFileSync(scriptPath, JSON.stringify(script, null, 2) + "\n");
    res.json({ saved: true, file, bytes: body.length });
  });

  app.post("/api/calls", (req, res) => {
    const scenario = typeof req.body?.scenario === "string" ? req.body.scenario : undefined;
    const s = sessions.start(scenario);
    res.status(201).json({ callId: s.id });
  });

  const TurnBody = z.object({ channel: Channel.exclude(["verifier"]), text: z.string().min(1).max(2000) });

  app.post("/api/calls/:id/turns", async (req, res) => {
    const body = TurnBody.parse(req.body);
    const assessment = await call(req).addTurn(body.channel, body.text);
    res.json({ assessment });
  });

  app.post("/api/calls/:id/audio", upload.single("audio"), async (req, res) => {
    const s = call(req);
    const channel = Channel.exclude(["verifier"]).parse(req.body?.channel);
    if (!req.file) throw new HttpError(400, "Missing 'audio' file");
    const { text, ms } = await deps.stt.transcribe(req.file.buffer, req.file.originalname || "utterance.wav", req.body?.hint);
    if (!text) return void res.json({ text: "", sttMs: ms, assessment: s.lastAssessment });
    const assessment = await s.addTurn(channel, text);
    res.json({ text, sttMs: ms, assessment });
  });

  app.post("/api/calls/:id/verify", async (req, res) => {
    const employeeId = z.object({ employeeId: z.string().optional() }).parse(req.body ?? {}).employeeId;
    try {
      res.json({ assessment: await call(req).manualVerify(employeeId) });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(409, (e as Error).message);
    }
  });

  app.get("/api/calls/:id/events", (req, res) => res.json(log.forCall(call(req).id)));

  app.get("/api/reports", (_req, res) => res.json(listCalls(log, deps.cfg.runsDir, sessions.ids())));
  app.get("/api/reports/:id", (req, res) => {
    const id = String(req.params.id);
    if (!SAFE_CALL_ID.test(id)) throw new HttpError(400, "Bad call id");
    const events = readCall(log, deps.cfg.runsDir, id);
    if (!events.length) throw new HttpError(404, `No record of call ${id}`);
    res.json({ events, policies: store.policies, company: store.company });
  });

  app.post("/api/calls/:id/end", async (req, res) => {
    await call(req).end();
    res.json({ ok: true });
  });

  app.get("/api/device/challenges", (req, res) => {
    const only = typeof req.query.employeeId === "string" && req.query.employeeId ? req.query.employeeId : null;
    const list = [...store.challenges.values()]
      .filter((c) => !only || c.employeeId === only)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map((c) => {
        const e = store.employeeById(c.employeeId);
        const d = store.devices.find((x) => x.id === c.deviceId);
        return { ...c, employeeName: e?.name ?? c.employeeId, deviceLabel: d?.label ?? c.deviceId };
      });
    res.json(list);
  });

  app.get("/api/device/owners", (_req, res) => {
    const ids = new Set(store.devices.filter((d) => d.pushEnabled).map((d) => d.employeeId));
    res.json(store.employees.filter((e) => ids.has(e.id)).map((e) => ({ id: e.id, name: e.name, title: e.title })));
  });

  app.get("/api/device/:employeeId/challenges", (req, res) => {
    const list = [...store.challenges.values()].filter((c) => c.employeeId === req.params.employeeId);
    res.json(list);
  });

  app.post("/api/challenges/:id/resolve", async (req, res) => {
    const approved = z.object({ approved: z.boolean() }).parse(req.body).approved;
    const s = sessions.findByChallenge(String(req.params.id));
    if (!s) throw new HttpError(404, "Unknown challenge");
    try {
      res.json({ assessment: await s.resolveChallenge(String(req.params.id), approved) });
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  });

  app.post("/api/calls/:id/tools/:name", (req, res) => {
    const name = String(req.params.name);
    if (!isToolName(name)) throw new HttpError(404, `Unknown tool ${name}`);
    res.json({ result: call(req).tool(name, req.body ?? {}) });
  });

  const webDist = join(deps.cfg.dataDir, "../../web/dist");
  if (existsSync(join(webDist, "index.html"))) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/|ws).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : err instanceof z.ZodError ? 400 : 500;
    const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
    if (status === 500) console.error(err);
    res.status(status).json({ error: message });
  });

  return { app, store, log, sessions };
}

// This computer's addresses on the Wi-Fi, so a real phone can open the phone page.
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(a.address);
    }
  }
  return out;
}

// An error with a status code (404, 409...) for the browser.
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
