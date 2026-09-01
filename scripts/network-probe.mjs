const endpoints = [
  ["binance_fapi", "https://fapi.binance.com/fapi/v1/time"],
  ["binance_fapi1", "https://fapi1.binance.com/fapi/v1/time"],
  ["binance_fapi2", "https://fapi2.binance.com/fapi/v1/time"],
  ["binance_fapi3", "https://fapi3.binance.com/fapi/v1/time"],
  ["binance_fapi4", "https://fapi4.binance.com/fapi/v1/time"],
  ["bybit_api", "https://api.bybit.com/v5/market/time"],
  ["bybit_bytick", "https://api.bytick.com/v5/market/time"]
];

for (const [name, url] of endpoints) {
  let result = "network";
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000)
    });
    result = `http_${response.status}`;
  } catch {
    // The status category is enough for diagnosing runner reachability.
  }
  console.log(`${name}=${result}`);
}
