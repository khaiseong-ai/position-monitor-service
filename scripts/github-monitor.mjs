import { buildConfig } from "../lib/config.js";
import {
  buildFailureMessage,
  buildSheetRows,
  envFlag,
  failedExchangeDiagnostics,
  failedExchangeNames,
  missingRequiredSecrets,
  writePositionSheet
} from "../lib/github-monitor.js";
import { sendTelegram } from "../lib/telegram.js";
import { collectState } from "../lib/vercel-shared.js";

const missing = missingRequiredSecrets();
if (missing.length > 0) {
  console.error(`Configuration incomplete: ${missing.join(", ")}`);
  process.exitCode = 1;
} else {
  await run();
}

async function run() {
  const notify = envFlag(process.env.POSITION_NOTIFY);
  const state = await collectState({ notify: false, source: "github-actions" });
  const config = buildConfig();

  if (state.errors.length > 0) {
    const failed = failedExchangeNames(state.errors);
    const diagnostics = failedExchangeDiagnostics(state.errors);
    console.error(`Monitor failed closed for ${failed.length} exchange(s): ${diagnostics.join(", ") || "unknown"}`);
    if (notify) {
      try {
        await sendTelegram(config.telegram, buildFailureMessage(state.errors, state.lastCheckedAt));
        console.log("Sanitized health alert sent to Telegram.");
      } catch {
        console.error("Telegram health alert failed.");
      }
    }
    process.exitCode = 1;
    return;
  }

  const rows = buildSheetRows(state);
  await writePositionSheet({
    url: process.env.POSITION_SHEET_WEBAPP_URL,
    secret: process.env.POSITION_SHEET_SECRET,
    sheetName: process.env.POSITION_SHEET_NAME || "Position_Monitor",
    rows
  });
  console.log(`Sheet updated: ${state.positions.length} position(s), ${state.orders.length} order(s), ${rows.length - 2} detail row(s).`);

  const alertCount = state.alerts.length + state.orderAlerts.length + state.missingTpSlAlerts.length;
  if (notify && alertCount > 0) {
    const { buildAlertMessage } = await import("../lib/telegram.js");
    await sendTelegram(
      config.telegram,
      buildAlertMessage(state.alerts, "github-actions", state.orderAlerts, state.missingTpSlAlerts)
    );
    console.log(`Telegram alert sent for ${alertCount} alert(s).`);
  } else {
    console.log(`Telegram alert not required; notify=${notify}, alerts=${alertCount}.`);
  }
}
