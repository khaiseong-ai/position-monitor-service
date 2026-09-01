import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(filePath = path.resolve(".env")) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function listEnv(name, fallback) {
  return env(name, fallback).split(",").map((item) => item.trim()).filter(Boolean);
}

function mapEnv(name, fallback = "") {
  return Object.fromEntries(
    env(name, fallback)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [key, value] = item.split(":");
        return [String(key || "").trim().toUpperCase(), Number(value)];
      })
      .filter(([key, value]) => key && Number.isFinite(value))
  );
}

export function buildConfig() {
  return {
    port: numberEnv("PORT", 8787),
    pollIntervalMs: numberEnv("POLL_INTERVAL_SECONDS", 300) * 1000,
    tolerance: numberEnv("TOLERANCE", 0),
    alertRepeatMs: numberEnv("ALERT_REPEAT_MINUTES", 30) * 60 * 1000,
    exchanges: {
      binance: {
        apiKey: env("BINANCE_API_KEY"),
        apiSecret: env("BINANCE_API_SECRET"),
        restBase: env("BINANCE_REST_BASE", "https://fapi.binance.com"),
        websocket: env("BINANCE_WS_ENABLED", "true").toLowerCase() === "true"
      },
      mexc: {
        apiKey: env("MEXC_API_KEY"),
        apiSecret: env("MEXC_API_SECRET"),
        restBase: env("MEXC_REST_BASE", "https://contract.mexc.com"),
        sizeMultipliers: mapEnv("MEXC_SIZE_MULTIPLIERS")
      },
      bybit: {
        apiKey: env("BYBIT_API_KEY"),
        apiSecret: env("BYBIT_API_SECRET"),
        restBase: env("BYBIT_REST_BASE", "https://api.bybit.com"),
        settleCoins: listEnv("BYBIT_SETTLE_COINS", "USDT,USDC")
      },
      bitget: {
        apiKey: env("BITGET_API_KEY"),
        apiSecret: env("BITGET_API_SECRET"),
        passphrase: env("BITGET_API_PASSPHRASE"),
        restBase: env("BITGET_REST_BASE", "https://api.bitget.com"),
        productType: env("BITGET_PRODUCT_TYPE", "USDT-FUTURES"),
        marginCoin: env("BITGET_MARGIN_COIN", "USDT")
      },
      phemex: {
        apiKey: env("PHEMEX_API_KEY"),
        apiSecret: env("PHEMEX_API_SECRET"),
        restBase: env("PHEMEX_REST_BASE", "https://api.phemex.com"),
        currency: env("PHEMEX_CURRENCY", "USDT")
      },
      hyperliquid: {
        wallet: env("HYPERLIQUID_WALLET"),
        restBase: env("HYPERLIQUID_REST_BASE", "https://api.hyperliquid.xyz"),
        dexes: listEnv("HYPERLIQUID_DEXS", "xyz")
      },
      backpack: {
        apiKey: env("BACKPACK_API_KEY"),
        apiSecret: env("BACKPACK_API_SECRET"),
        restBase: env("BACKPACK_REST_BASE", "https://api.backpack.exchange"),
        proxyUrl: env("BACKPACK_PROXY_URL", "https://ks-vercel.vercel.app/api/funding")
      }
    },
    telegram: {
      botToken: env("TELEGRAM_BOT_TOKEN"),
      chatId: env("TELEGRAM_CHAT_ID")
    },
    positionRelay: {
      url: env("POSITION_RELAY_URL"),
      token: env("POSITION_RELAY_TOKEN"),
      exchanges: listEnv("POSITION_RELAY_EXCHANGES", "binance,bybit")
        .map((name) => name.toLowerCase()),
      credentials: {
        binance: {
          apiKey: env("BINANCE_API_KEY"),
          apiSecret: env("BINANCE_API_SECRET")
        },
        bybit: {
          apiKey: env("BYBIT_API_KEY"),
          apiSecret: env("BYBIT_API_SECRET")
        }
      }
    }
  };
}
