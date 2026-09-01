#!/usr/bin/env bash
set -euo pipefail

curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
  | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
. /etc/os-release
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ ${VERSION_CODENAME} main" \
  | sudo tee /etc/apt/sources.list.d/cloudflare-client.list >/dev/null
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cloudflare-warp
sudo systemctl enable --now warp-svc

sudo warp-cli --accept-tos registration new
sudo warp-cli --accept-tos mode warp+doh
sudo warp-cli --accept-tos connect

for _ in $(seq 1 30); do
  if curl -fsS https://www.cloudflare.com/cdn-cgi/trace | grep -q '^warp=on$'; then
    break
  fi
  sleep 2
done

curl -fsS https://www.cloudflare.com/cdn-cgi/trace | grep -q '^warp=on$'
status="$(curl -sS -o /dev/null -w '%{http_code}' https://fapi.binance.com/fapi/v1/time)"
if [[ "${status}" != "200" ]]; then
  echo "Binance public probe failed with HTTP ${status}"
  exit 1
fi
echo "Cloudflare WARP connected; Binance public probe HTTP 200"
