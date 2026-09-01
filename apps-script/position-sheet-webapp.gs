const POSITION_SPREADSHEET_ID = "1-fhxWIpcplFMON_4hlTm3uQy8JG9RmEgcEgSld4YAoc";
const POSITION_SECRET_PROPERTY = "POSITION_SHEET_SECRET";
const POSITION_IGNORE_SHEETS = {
  ignoreSymbols: "Ignore",
  orderIgnoreSymbols: "OrderIgnore",
  missingTpSlIgnoreSymbols: "MissingTpSlIgnore"
};
const POSITION_SHEETS = [
  "Summary",
  "Positions",
  "Orders",
  "Alerts",
  "OrderAlerts",
  "MissingTpSlAlerts"
];
const POSITION_HEADERS = {
  Summary: ["Key", "Value"],
  Positions: ["Symbol", "Source", "Side", "Size", "Price", "Orders"],
  Orders: ["Symbol", "Source", "Side", "Size", "Price", "Trigger Price", "Watch Price", "Type", "Status"],
  Alerts: ["Symbol", "Reason", "Long", "Short", "Diff", "Rows"],
  OrderAlerts: ["Symbol", "Source", "Side", "Type", "Size", "Current Price", "Order Price", "Lower 0.5x", "Upper 2x", "Reason"],
  MissingTpSlAlerts: ["Symbol", "Source", "Side", "Size", "Current Price", "Missing TP", "Missing SL", "Reason"]
};
const RUNS_HEADER = ["Checked At", "Positions", "Alerts", "Errors", "Telegram Sent", "Telegram Error"];

function doGet() {
  return jsonResponse_({ ok: true, service: "position-sheet" });
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    locked = lock.tryLock(15000);
    if (!locked) throw new Error("busy");

    const payload = JSON.parse(event && event.postData && event.postData.contents || "{}");
    const expectedSecret = PropertiesService.getScriptProperties().getProperty(POSITION_SECRET_PROPERTY);
    if (!expectedSecret || String(payload.secret || "") !== expectedSecret) throw new Error("unauthorized");
    if (payload.action === "readIgnoreConfig") {
      return jsonResponse_({ ok: true, ignores: readIgnoreConfig_() });
    }
    if (payload.action !== "writePositionSnapshot") throw new Error("unsupported_action");

    const normalizedSheets = validateSnapshot_(payload.sheets);
    const run = normalizeRun_(payload.run);
    writePositionSnapshot_(normalizedSheets, run);
    return jsonResponse_({ ok: true });
  } catch (error) {
    return jsonResponse_({ ok: false, error: "request_rejected" });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function readIgnoreConfig_() {
  const workbook = SpreadsheetApp.openById(POSITION_SPREADSHEET_ID);
  const ignores = {};
  Object.keys(POSITION_IGNORE_SHEETS).forEach(function(key) {
    const sheet = workbook.getSheetByName(POSITION_IGNORE_SHEETS[key]);
    if (!sheet) throw new Error("missing_ignore_sheet");
    const rowCount = Math.max(sheet.getLastRow() - 1, 0);
    const values = rowCount > 0
      ? sheet.getRange(2, 1, rowCount, 1).getValues().map(function(row) { return row[0]; })
      : [];
    ignores[key] = Array.from(new Set(values.map(normalizeSymbol_).filter(Boolean)));
  });
  return ignores;
}

function validateSnapshot_(sheets) {
  if (!sheets || typeof sheets !== "object") throw new Error("invalid_sheets");
  const normalized = {};
  POSITION_SHEETS.forEach(function(name) {
    const rows = normalizeRows_(sheets[name], POSITION_HEADERS[name].length);
    if (!sameRow_(rows[0], POSITION_HEADERS[name])) throw new Error("invalid_header");
    normalized[name] = rows;
  });
  return normalized;
}

function normalizeRows_(rows, width) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 2000) throw new Error("invalid_rows");
  return rows.map(function(row) {
    if (!Array.isArray(row) || row.length !== width) throw new Error("invalid_width");
    return row.map(normalizeCell_);
  });
}

function normalizeRun_(run) {
  const rows = normalizeRows_([run], RUNS_HEADER.length);
  return rows[0];
}

function normalizeCell_(value) {
  if (typeof value === "number") return isFinite(value) ? value : "";
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (text.length > 50000) throw new Error("cell_too_long");
  return /^[=+\-@]/.test(text) && text.charAt(0) !== "'" ? "'" + text : text;
}

function sameRow_(left, right) {
  return left.length === right.length && left.every(function(value, index) {
    return value === right[index];
  });
}

function writePositionSnapshot_(sheets, run) {
  const workbook = SpreadsheetApp.openById(POSITION_SPREADSHEET_ID);
  POSITION_SHEETS.forEach(function(name) {
    const sheet = workbook.getSheetByName(name);
    if (!sheet) throw new Error("missing_sheet");
    const rows = sheets[name];
    ensureGridSize_(sheet, rows.length, rows[0].length);
    sheet.getDataRange().clearContent();
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    formatSnapshotSheet_(sheet, rows[0].length);
  });

  const runsSheet = workbook.getSheetByName("Runs");
  if (!runsSheet) throw new Error("missing_runs_sheet");
  ensureGridSize_(runsSheet, runsSheet.getLastRow() + 1, RUNS_HEADER.length);
  if (runsSheet.getLastRow() === 0) {
    runsSheet.getRange(1, 1, 1, RUNS_HEADER.length).setValues([RUNS_HEADER]);
  }
  if (!sameRow_(runsSheet.getRange(1, 1, 1, RUNS_HEADER.length).getValues()[0], RUNS_HEADER)) {
    throw new Error("invalid_runs_header");
  }
  runsSheet.appendRow(run);
  formatSnapshotSheet_(runsSheet, RUNS_HEADER.length);
  SpreadsheetApp.flush();
}

function ensureGridSize_(sheet, rows, columns) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < columns) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
}

function formatSnapshotSheet_(sheet, width) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, width)
    .setBackground("#303030")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setWrap(true);
  sheet.autoResizeColumns(1, width);
  for (let column = 1; column <= width; column += 1) {
    sheet.setColumnWidth(column, Math.min(Math.max(sheet.getColumnWidth(column), 90), 360));
  }
}

function normalizeSymbol_(value) {
  let normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[-_\/]/g, "");
  let previous = "";
  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized.replace(/(STOCK|USDT|USDC|USD|PERP|SWAP)$/g, "");
  }
  return normalized;
}

function jsonResponse_(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
