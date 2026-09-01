const rows = document.querySelector("#rows");
const alerts = document.querySelector("#alerts");
const errors = document.querySelector("#errors");
const meta = document.querySelector("#meta");
const positionCount = document.querySelector("#positionCount");
const alertCount = document.querySelector("#alertCount");
const wsState = document.querySelector("#wsState");
const checkNow = document.querySelector("#checkNow");

function formatSize(value) {
  return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadState() {
  const response = await fetch("/api/state");
  render(await response.json());
}

function render(state) {
  positionCount.textContent = state.positions.length;
  alertCount.textContent = (state.alerts || []).length + (state.orderAlerts || []).length + (state.missingTpSlAlerts || []).length;
  wsState.textContent = state.websocket.binance || "-";
  meta.textContent = state.lastCheckedAt
    ? `最近检查: ${new Date(state.lastCheckedAt).toLocaleString()}`
    : "等待第一次检查";

  const orderMap = (state.orders || []).reduce((map, order) => {
    const text = `${order.source} ${order.side} ${order.type} ${formatSize(order.watchPrice || order.price)}`;
    map[order.symbol] = map[order.symbol] ? `${map[order.symbol]}; ${text}` : text;
    return map;
  }, {});

  rows.innerHTML = state.positions.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.symbol)}</strong></td>
      <td>${escapeHtml(row.source)}</td>
      <td class="${escapeHtml(row.side)}">${escapeHtml(row.side)}</td>
      <td class="num">${formatSize(row.size)}</td>
      <td class="num">${row.price ? formatSize(row.price) : ""}</td>
      <td>${escapeHtml(orderMap[row.symbol] || "")}</td>
    </tr>
  `).join("");

  if ((state.alerts || []).length === 0 && (state.orderAlerts || []).length === 0 && (state.missingTpSlAlerts || []).length === 0) {
    alerts.innerHTML = '<div class="ok"><strong>无告警</strong><p>当前仓位 long/short size 平衡。</p></div>';
  } else {
    const positionHtml = (state.alerts || []).map((item) => {
      const reason = item.reason === "single_leg" ? "只有单腿方向" : "long/short size 不平衡";
      return `
        <div>
          <strong>${escapeHtml(item.symbol)} - ${reason}</strong>
          <p>Long ${formatSize(item.long)} / Short ${formatSize(item.short)} / Diff ${formatSize(item.diff)}</p>
        </div>
      `;
    }).join("");
    const orderHtml = (state.orderAlerts || []).map((item) => `
      <div>
        <strong>${escapeHtml(item.symbol)} - order inside 0.5x-2x band</strong>
        <p>${escapeHtml(item.source)} ${escapeHtml(item.side)} ${escapeHtml(item.type)}: current ${formatSize(item.currentPrice)} / order ${formatSize(item.orderPrice)}</p>
      </div>
    `).join("");
    const missingHtml = (state.missingTpSlAlerts || []).map((item) => `
      <div>
        <strong>${escapeHtml(item.symbol)} - missing TP/SL</strong>
        <p>${escapeHtml(item.source)} ${escapeHtml(item.side)}: ${escapeHtml(item.reason)}</p>
      </div>
    `).join("");
    alerts.innerHTML = positionHtml + orderHtml + missingHtml;
  }

  if (state.errors.length) {
    errors.style.display = "block";
    errors.textContent = state.errors.join("\n");
  } else {
    errors.style.display = "none";
    errors.textContent = "";
  }
}

checkNow.addEventListener("click", async () => {
  checkNow.disabled = true;
  try {
    const response = await fetch("/api/check", { method: "POST" });
    render(await response.json());
  } finally {
    checkNow.disabled = false;
  }
});

loadState().catch((error) => {
  errors.style.display = "block";
  errors.textContent = error.message;
});

setInterval(loadState, 5000);
