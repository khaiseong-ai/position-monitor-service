import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig, loadDotEnv } from "./lib/config.js";
import { alertSignature, analyzePositions } from "./lib/position-utils.js";
import { buildAlertMessage, sendTelegram } from "./lib/telegram.js";
import { createBinanceListenKey, fetchAllPositions, keepAliveBinanceListenKey } from "./lib/exchanges.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(__dirname, ".env"));
const config = buildConfig();

const state = {
  startedAt: new Date().toISOString(),
  lastCheckedAt: null,
  lastEventAt: null,
  positions: [],
  alerts: [],
  errors: [],
  exchangeStatus: {},
  telegram: { lastSentAt: null, lastError: null },
  websocket: { binance: "disabled" }
};

let lastSignature = "";
let lastSentAt = 0;
let polling = false;

async function check(source = "poll") {
  if (polling) return;
  polling = true;
  try {
    const { positions, errors } = await fetchAllPositions(config);
    const analysis = analyzePositions(positions, config.tolerance);
    state.lastCheckedAt = new Date().toISOString();
    state.positions = positions.map(({ raw, ...position }) => position);
    state.alerts = analysis.alerts.map((alert) => ({
      ...alert,
      rows: alert.rows.map(({ raw, ...position }) => position)
    }));
    state.errors = errors;

    const signature = alertSignature(analysis.alerts);
    const shouldSend = analysis.alerts.length > 0 &&
      (signature !== lastSignature || Date.now() - lastSentAt > config.alertRepeatMs);

    if (shouldSend) {
      await sendTelegram(config.telegram, buildAlertMessage(analysis.alerts, source));
      lastSignature = signature;
      lastSentAt = Date.now();
      state.telegram.lastSentAt = new Date().toISOString();
      state.telegram.lastError = null;
    }

    if (analysis.alerts.length === 0) {
      lastSignature = "";
    }
  } catch (error) {
    state.errors = [error.message || String(error)];
    state.telegram.lastError = null;
  } finally {
    polling = false;
  }
}

async function startBinanceStream() {
  if (!config.exchanges.binance.websocket) return;
  if (!config.exchanges.binance.apiKey || !config.exchanges.binance.apiSecret) return;
  try {
    const listenKey = await createBinanceListenKey(config.exchanges.binance);
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${listenKey}`);
    state.websocket.binance = "connecting";

    const keepAlive = setInterval(() => {
      keepAliveBinanceListenKey(config.exchanges.binance, listenKey).catch(() => {});
    }, 30 * 60 * 1000);

    ws.addEventListener("open", () => {
      state.websocket.binance = "connected";
    });

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.e === "ACCOUNT_UPDATE" || data.e === "ORDER_TRADE_UPDATE") {
          state.lastEventAt = new Date().toISOString();
          check("binance_ws").catch(() => {});
        }
      } catch {
        state.lastEventAt = new Date().toISOString();
      }
    });

    ws.addEventListener("close", () => {
      clearInterval(keepAlive);
      state.websocket.binance = "closed_reconnecting";
      setTimeout(startBinanceStream, 10_000);
    });

    ws.addEventListener("error", () => {
      state.websocket.binance = "error";
    });
  } catch (error) {
    state.websocket.binance = `error: ${error.message}`;
    setTimeout(startBinanceStream, 30_000);
  }
}

function serveStatic(req, res) {
  const publicDir = path.join(__dirname, "public");
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const type = filePath.endsWith(".html") ? "text/html; charset=utf-8" :
    filePath.endsWith(".css") ? "text/css; charset=utf-8" :
      filePath.endsWith(".js") ? "application/javascript; charset=utf-8" :
        "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/state") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(state));
    return;
  }
  if (req.url === "/api/check" && req.method === "POST") {
    await check("manual");
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(state));
    return;
  }
  serveStatic(req, res);
});

server.listen(config.port, () => {
  console.log(`Position monitor: http://localhost:${config.port}`);
});

check("startup").catch(() => {});
setInterval(() => check("poll"), config.pollIntervalMs);
startBinanceStream();
