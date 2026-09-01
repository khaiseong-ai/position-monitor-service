import { buildConfig, loadDotEnv } from "./config.js";
import { fetchAllOrders, fetchAllPositions } from "./exchanges.js";
import { fetchPositionRelay } from "./position-relay.js";
import { analyzeMissingTpSl, analyzeOrders, analyzePositions, extractPositionOrders, formatSize, normalizeSymbol } from "./position-utils.js";
import { buildAlertMessage, sendTelegram } from "./telegram.js";

loadDotEnv();

export async function collectState({ notify = false, source = "vercel", ignoreSymbols = [], orderIgnoreSymbols = [], missingTpSlIgnoreSymbols = [] } = {}) {
  const config = buildConfig();
  const startedAt = new Date().toISOString();
  const relayEnabled = Boolean(config.positionRelay.url || config.positionRelay.token);
  const relayExchanges = relayEnabled ? config.positionRelay.exchanges : [];
  const relayPromise = relayEnabled
    ? fetchPositionRelay(config.positionRelay)
      .then((value) => ({ value, error: null }))
      .catch((error) => ({ value: emptyRelayState(), error }))
    : Promise.resolve({ value: emptyRelayState(), error: null });
  const localPositionsPromise = fetchAllPositions(config, { exclude: relayExchanges });
  const [{ value: relayState, error: relayError }, localPositionState] = await Promise.all([
    relayPromise,
    localPositionsPromise
  ]);
  const positions = [...localPositionState.positions, ...relayState.positions];
  const { orders: localOrders, errors: orderErrors } = await fetchAllOrders(config, positions, { exclude: relayExchanges });
  const orders = [...localOrders, ...relayState.orders];
  const positionErrors = [
    ...localPositionState.errors,
    ...(relayError ? [`position_relay: ${relayError.message || String(relayError)}`] : [])
  ];
  const ignored = new Set(ignoreSymbols.map(normalizeSymbol).filter(Boolean));
  const orderIgnored = new Set(orderIgnoreSymbols.map(normalizeSymbol).filter(Boolean));
  const missingTpSlIgnored = new Set(missingTpSlIgnoreSymbols.map(normalizeSymbol).filter(Boolean));
  const incompleteOrderSources = new Set(Object.entries(relayState.coverage)
    .filter(([, coverage]) => coverage.orders !== "complete")
    .map(([name]) => name));
  const filteredPositions = positions.filter((position) => !ignored.has(normalizeSymbol(position.symbol)));
  const attachedOrders = extractPositionOrders(positions);
  const allOrders = [...orders, ...attachedOrders];
  const filteredOrders = allOrders.filter((order) => !orderIgnored.has(normalizeSymbol(order.symbol)));
  const missingTpSlPositions = positions.filter((position) => !incompleteOrderSources.has(position.source));
  const missingTpSlOrders = allOrders.filter((order) => !incompleteOrderSources.has(order.source)
    && !missingTpSlIgnored.has(normalizeSymbol(order.symbol)));
  const analysis = analyzePositions(filteredPositions, config.tolerance);
  const orderAlerts = analyzeOrders(positions, filteredOrders, [...orderIgnored]);
  const missingTpSlAlerts = analyzeMissingTpSl(missingTpSlPositions, missingTpSlOrders, [...missingTpSlIgnored]);
  const telegram = { sent: false, error: null };

  if (notify && (analysis.alerts.length > 0 || orderAlerts.length > 0 || missingTpSlAlerts.length > 0)) {
    try {
      await sendTelegram(config.telegram, buildAlertMessage(analysis.alerts, source, orderAlerts, missingTpSlAlerts));
      telegram.sent = true;
    } catch (error) {
      telegram.error = error.message || String(error);
    }
  }

  return {
    startedAt,
    lastCheckedAt: new Date().toISOString(),
    positions: filteredPositions.map(stripRaw),
    orders: filteredOrders.map(stripRaw),
    alerts: analysis.alerts.map((alert) => ({
      ...alert,
      rows: alert.rows.map(stripRaw)
    })),
    orderAlerts,
    missingTpSlAlerts,
    errors: [...positionErrors, ...orderErrors],
    ignoredSymbols: [...ignored],
    orderIgnoredSymbols: [...orderIgnored],
    missingTpSlIgnoredSymbols: [...missingTpSlIgnored],
    integrity: {
      coverage: relayState.coverage,
      warnings: relayState.warnings
    },
    telegram,
    websocket: {
      binance: relayState.coverage.binance?.transport === "websocket"
        ? "relay_positions_only"
        : "disabled_on_vercel"
    }
  };
}

export function writeJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export function methodAllowed(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.statusCode = 405;
  res.setHeader("allow", methods.join(", "));
  res.end("Method not allowed");
  return false;
}

export function summarizeState(state) {
  return {
    positions: state.positions.length,
    orders: state.orders.length,
    alerts: state.alerts.length,
    orderAlerts: state.orderAlerts.length,
    missingTpSlAlerts: state.missingTpSlAlerts.length,
    errors: state.errors,
    topAlerts: state.alerts.slice(0, 10).map((alert) => ({
      symbol: alert.symbol,
      reason: alert.reason,
      long: formatSize(alert.long),
      short: formatSize(alert.short),
      diff: formatSize(alert.diff)
    })),
    topOrderAlerts: state.orderAlerts.slice(0, 10).map((alert) => ({
      symbol: alert.symbol,
      source: alert.source,
      currentPrice: formatSize(alert.currentPrice),
      orderPrice: formatSize(alert.orderPrice),
      lowerBound: formatSize(alert.lowerBound),
      upperBound: formatSize(alert.upperBound)
    })),
    topMissingTpSlAlerts: state.missingTpSlAlerts.slice(0, 10).map((alert) => ({
      symbol: alert.symbol,
      source: alert.source,
      side: alert.side,
      reason: alert.reason
    }))
  };
}

function stripRaw({ raw, ...position }) {
  return position;
}

function emptyRelayState() {
  return { positions: [], orders: [], coverage: {}, warnings: [] };
}
