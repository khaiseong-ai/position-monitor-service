import { fetchWeeklyPnl } from "../lib/weekly-pnl.js";

function queryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function defaultWeeklyRange(now = Date.now()) {
  const offsetMs = 8 * 60 * 60 * 1000;
  const local = new Date(now + offsetMs);
  const day = local.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const currentMondayLocalMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - daysSinceMonday,
    0, 0, 0, 0
  );
  const endMs = currentMondayLocalMs - offsetMs;
  return { startMs: endMs - 7 * 24 * 60 * 60 * 1000, endMs };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const providedSecret = req.headers["x-cron-secret"] || queryValue(req.query?.secret);
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const defaults = defaultWeeklyRange();
  const requestedStart = queryValue(req.query?.start);
  const requestedEnd = queryValue(req.query?.end);
  const startMs = requestedStart ? Date.parse(requestedStart) : defaults.startMs;
  const endMs = requestedEnd ? Date.parse(requestedEnd) : defaults.endMs;

  try {
    const result = await fetchWeeklyPnl({ startMs, endMs });
    const status = result.errors.length === 0 ? 200 : 502;
    res.status(status).json(result);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
}
