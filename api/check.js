import { collectState, methodAllowed, summarizeState, writeJson } from "../lib/vercel-shared.js";

export const config = {
  maxDuration: 300
};

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;

  try {
    const isCron = req.headers["user-agent"] === "vercel-cron/1.0";
    const manualNotify = req.query?.notify === "1";
    const cronSecret = process.env.CRON_SECRET || "";
    const secretOk = !manualNotify || !cronSecret || req.query?.secret === cronSecret;
    if (!secretOk) {
      writeJson(res, 401, { ok: false, error: "invalid_cron_secret" });
      return;
    }
    const state = await collectState({
      notify: isCron || manualNotify,
      source: isCron ? "vercel_cron" : "manual_vercel",
      ignoreSymbols: parseIgnoreSymbols(req.query?.ignore),
      orderIgnoreSymbols: parseIgnoreSymbols(req.query?.orderIgnore),
      missingTpSlIgnoreSymbols: parseIgnoreSymbols(req.query?.missingTpSlIgnore)
    });
    writeJson(res, 200, {
      ok: true,
      notified: state.telegram.sent,
      telegramError: state.telegram.error,
      ...summarizeState(state)
    });
  } catch (error) {
    writeJson(res, 500, { ok: false, error: error.message || String(error) });
  }
}

function parseIgnoreSymbols(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}
