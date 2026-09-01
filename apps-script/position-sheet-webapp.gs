const POSITION_SPREADSHEET_ID = "1-fhxWIpcplFMON_4hlTm3uQy8JG9RmEgcEgSld4YAoc";
const FUNDING_SPREADSHEET_ID = "1zblziMpkQcoEBoRJEyVmJG1zLaRTMTSXyn6ob4KOVxU";
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
const FUNDING_TABS = {
  equity: "Account_Equity",
  funding: "Account_Funding",
  health: "Account_Health",
  runs: "Account_Runs"
};
const FUNDING_HEADERS = {
  equity: [
    "Checked At", "Exchange", "Futures USDT", "Futures USDC", "Spot USDT",
    "Spot USDC", "Funding USDT", "Funding USDC", "Unrealized PnL", "Total"
  ],
  funding: [
    "Checked At", "Symbol", "Source", "Side", "Size", "Current Price",
    "Entry Price", "Position Value", "uPnL", "Cnt", "Interval h", "3d Funding",
    "Funding Records", "Orders", "Start Time", "End Time"
  ],
  health: [
    "Checked At", "Class", "Symbol", "Net Funding", "Long Size", "Short Size",
    "Long Funding", "Short Funding", "Long Orders", "Short Orders", "Details"
  ],
  runs: [
    "Checked At", "Status", "Positions", "Exchanges", "Total Equity",
    "Elapsed ms", "Rows Written", "Error"
  ]
};

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
    if (payload.action === "writeAccountFunding") {
      const snapshot = validateFundingSnapshot_(payload.snapshot);
      const rowsWritten = writeFundingSnapshot_(snapshot);
      return jsonResponse_({ ok: true, rowsWritten: rowsWritten });
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

function validateFundingSnapshot_(snapshot) {
  if (!snapshot || snapshot.success !== true) throw new Error("invalid_funding_snapshot");
  if (!Array.isArray(snapshot.equity) || snapshot.equity.length > 50) {
    throw new Error("invalid_funding_equity");
  }
  if (!Array.isArray(snapshot.positions) || snapshot.positions.length > 2000) {
    throw new Error("invalid_funding_positions");
  }
  const health = snapshot.hedgeHealth || {};
  ["noProtection", "fundingLoss", "misaligned"].forEach(function(name) {
    if (!Array.isArray(health[name] || []) || (health[name] || []).length > 2000) {
      throw new Error("invalid_funding_health");
    }
  });
  fundingDate_(snapshot.checkedAt);
  return snapshot;
}

function writeFundingSnapshot_(snapshot) {
  const workbook = SpreadsheetApp.openById(FUNDING_SPREADSHEET_ID);
  const checkedAt = fundingDate_(snapshot.checkedAt);
  const equityRows = buildFundingEquityRows_(snapshot, checkedAt);
  const positionRows = buildFundingPositionRows_(snapshot, checkedAt);
  const healthRows = buildFundingHealthRows_(snapshot, checkedAt);
  const rowsWritten = equityRows.length + positionRows.length + healthRows.length;

  replaceFundingRows_(workbook, FUNDING_TABS.equity, FUNDING_HEADERS.equity, equityRows, {
    widths: [170, 100, 110, 110, 100, 100, 110, 110, 115, 115],
    dateColumns: [1],
    numericColumns: [3, 4, 5, 6, 7, 8, 9, 10]
  });
  replaceFundingRows_(workbook, FUNDING_TABS.funding, FUNDING_HEADERS.funding, positionRows, {
    widths: [170, 90, 90, 70, 90, 105, 105, 115, 105, 60, 80, 105, 260, 240, 150, 150],
    dateColumns: [1, 15, 16],
    numericColumns: [5, 6, 7, 8, 9, 10, 11, 12]
  });
  replaceFundingRows_(workbook, FUNDING_TABS.health, FUNDING_HEADERS.health, healthRows, {
    widths: [170, 105, 90, 105, 95, 95, 105, 105, 90, 90, 280],
    dateColumns: [1],
    numericColumns: [4, 5, 6, 7, 8, 9, 10]
  });
  appendFundingRun_(workbook, [
    checkedAt,
    "OK",
    snapshot.positions.length,
    snapshot.equity.length,
    fundingNumber_(snapshot.totalEquity),
    fundingInteger_(snapshot.elapsedMs),
    rowsWritten,
    ""
  ]);
  SpreadsheetApp.flush();
  return rowsWritten;
}

function buildFundingEquityRows_(snapshot, checkedAt) {
  return snapshot.equity.map(function(row) {
    return [
      checkedAt,
      fundingText_(row.exchange),
      fundingNumber_(row.futuresUsdt),
      fundingNumber_(row.futuresUsdc),
      fundingNumber_(row.spotUsdt),
      fundingNumber_(row.spotUsdc),
      fundingNumber_(row.fundingUsdt),
      fundingNumber_(row.fundingUsdc),
      fundingNumber_(row.unrealizedPnl),
      fundingNumber_(row.total)
    ];
  });
}

function buildFundingPositionRows_(snapshot, checkedAt) {
  return snapshot.positions.map(function(row) {
    return [
      checkedAt,
      fundingText_(row.symbol),
      fundingText_(row.source),
      fundingText_(row.side),
      fundingNumber_(row.positionSize),
      fundingNumber_(row.currentPrice),
      fundingNumber_(row.entryPrice),
      fundingNumber_(row.positionValue),
      fundingNumber_(row.unrealizedPnl),
      fundingInteger_(row.count),
      fundingNumber_(row.fundingIntervalHours),
      fundingNumber_(row.totalFunding),
      fundingText_(JSON.stringify(row.fundingRecords || [])),
      fundingText_(JSON.stringify(row.orders || [])),
      fundingOptionalDate_(row.startTime),
      fundingOptionalDate_(row.endTime)
    ];
  });
}

function buildFundingHealthRows_(snapshot, checkedAt) {
  const health = snapshot.hedgeHealth || {};
  const rows = [];
  [
    ["No Protection", health.noProtection || []],
    ["Funding Loss", health.fundingLoss || []],
    ["Misaligned", health.misaligned || []]
  ].forEach(function(group) {
    group[1].forEach(function(row) {
      rows.push([
        checkedAt,
        group[0],
        fundingText_(row.symbol),
        fundingNumber_(row.netFunding),
        fundingNumber_(row.longSize),
        fundingNumber_(row.shortSize),
        fundingNumber_(row.longFunding),
        fundingNumber_(row.shortFunding),
        fundingInteger_(row.longOrderCount),
        fundingInteger_(row.shortOrderCount),
        fundingText_((row.problems || []).join("; "))
      ]);
    });
  });
  return rows;
}

function replaceFundingRows_(workbook, name, headers, rows, options) {
  const sheet = workbook.getSheetByName(name);
  if (!sheet) throw new Error("missing_funding_sheet");
  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  styleFundingSheet_(sheet, headers.length, rows.length, options);
}

function appendFundingRun_(workbook, row) {
  const sheet = workbook.getSheetByName(FUNDING_TABS.runs);
  if (!sheet) throw new Error("missing_funding_runs_sheet");
  const headers = FUNDING_HEADERS.runs;
  if (String(sheet.getRange(1, 1).getDisplayValue() || "") !== headers[0]) {
    sheet.clearContents();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sheet.appendRow(row);
  if (sheet.getLastRow() > 1001) sheet.deleteRows(2, sheet.getLastRow() - 1001);
  styleFundingSheet_(sheet, headers.length, Math.max(0, sheet.getLastRow() - 1), {
    widths: [170, 90, 80, 85, 115, 90, 95, 340],
    dateColumns: [1],
    numericColumns: [3, 4, 5, 6, 7]
  });
}

function styleFundingSheet_(sheet, columnCount, rowCount, options) {
  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.getRange(1, 1, 1, columnCount)
    .setBackground("#303030")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold")
    .setVerticalAlignment("middle")
    .setWrap(true);
  sheet.setRowHeight(1, 34);
  sheet.setFrozenRows(1);
  sheet.setHiddenGridlines(true);
  (options.widths || []).forEach(function(width, index) {
    sheet.setColumnWidth(index + 1, width);
  });
  if (rowCount > 0) {
    sheet.getRange(2, 1, rowCount, columnCount).setVerticalAlignment("middle").setFontSize(10);
    (options.dateColumns || []).forEach(function(column) {
      sheet.getRange(2, column, rowCount, 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
    });
    (options.numericColumns || []).forEach(function(column) {
      sheet.getRange(2, column, rowCount, 1)
        .setNumberFormat("#,##0.00;[Red]-#,##0.00;0.00");
    });
    sheet.getRange(1, 1, rowCount + 1, columnCount).createFilter();
  }
}

function fundingDate_(value) {
  const date = new Date(String(value || ""));
  if (isNaN(date.getTime())) throw new Error("invalid_funding_date");
  return date;
}

function fundingOptionalDate_(value) {
  if (!value) return "";
  const date = new Date(String(value));
  return isNaN(date.getTime()) ? fundingText_(value) : date;
}

function fundingNumber_(value) {
  const parsed = Number(value);
  return isFinite(parsed) ? parsed : 0;
}

function fundingInteger_(value) {
  return Math.max(0, Math.floor(fundingNumber_(value)));
}

function fundingText_(value) {
  return normalizeCell_(value);
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
