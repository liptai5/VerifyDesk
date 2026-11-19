// Starts the server: picks the AI providers, opens the web server and the live event stream.

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { createLLM, createSTT } from "./providers/index.js";

// If a provider can't start (e.g. no key), use demo mode instead and say why.
function withFallback<T>(make: () => T, fallback: () => T, what: string): T {
  try {
    return make();
  } catch (e) {
    console.warn(`\n  ! ${what}: ${(e as Error).message}\n    Falling back to demo mode (mock) for ${what}. Run \`npm run doctor\` to fix it.\n`);
    return fallback();
  }
}
const llm = withFallback(() => createLLM(config), () => createLLM(config, "mock"), "AI model");
const stt = withFallback(() => createSTT(config), () => createSTT(config, "mock"), "speech-to-text");
const { app, log } = createApp({ cfg: config, llm, stt });

const server = createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });
log.subscribe((event) => {
  const msg = JSON.stringify(event);
  for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(msg);
});

server.listen(config.port, () => {
  console.log(`\n  VerifyDesk server  http://localhost:${config.port}`);
  console.log(`  LLM: ${llm.name}   STT: ${stt.name}`);
  console.log(`  Events: ws://localhost:${config.port}/ws\n`);
});
