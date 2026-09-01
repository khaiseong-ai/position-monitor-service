import { collectState, methodAllowed, writeJson } from "../lib/vercel-shared.js";

export const config = {
  maxDuration: 300
};

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;

  try {
    const state = await collectState({
      notify: false,
      source: "vercel_state",
      ignoreSymbols: parseIgnoreSymbols(req.query?.ignore),
      orderIgnoreSymbols: parseIgnoreSymbols(req.query?.orderIgnore),
      missingTpSlIgnoreSymbols: parseIgnoreSymbols(req.query?.missingTpSlIgnore)
    });
    writeJson(res, 200, state);
  } catch (error) {
    writeJson(res, 500, {
      startedAt: new Date().toISOString(),
      lastCheckedAt: null,
      positions: [],
      orders: [],
      alerts: [],
      orderAlerts: [],
      missingTpSlAlerts: [],
      errors: [error.message || String(error)],
      ignoredSymbols: [],
      orderIgnoredSymbols: [],
      missingTpSlIgnoredSymbols: [],
      telegram: { sent: false, error: null },
      websocket: { binance: "disabled_on_vercel" }
    });
  }
}

function parseIgnoreSymbols(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}
