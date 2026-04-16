const router = require("express").Router();
const { google } = require("googleapis");
const { db } = require("../firebase");

function getOAuthClient(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "https://goswft.com/api/auth/google/callback"
  );
  client.setCredentials(tokens);
  return client;
}

const VALID_TYPES = ["customers", "jobs", "quotes", "invoices"];

router.post("/sheets", async (req, res) => {
  try {
    const uid = req.orgId || req.uid;
    const { data_type, status } = req.body;

    if (!data_type || !VALID_TYPES.includes(data_type)) {
      return res.status(400).json({ error: "Invalid data type. Must be one of: " + VALID_TYPES.join(", ") });
    }

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const integrations = userDoc.data().integrations || {};
    const sheets = integrations.google_sheets;
    if (!sheets?.connected || !sheets?.tokens) {
      return res.status(400).json({ error: "Google Sheets is not connected. Connect it in Settings → Integrations." });
    }

    const auth = getOAuthClient(sheets.tokens);
    const sheetsApi = google.sheets({ version: "v4", auth });

    let snap = await db.collection(data_type).where("userId", "==", uid).get();
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (status) {
      rows = rows.filter(r => r.status === status);
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: `No ${data_type} found to export` });
    }

    const exclude = ["userId"];
    const keys = Object.keys(rows[0]).filter(k => !exclude.includes(k));
    const headerRow = keys;
    const dataRows = rows.map(r => keys.map(k => {
      const val = r[k];
      if (val === null || val === undefined) return "";
      if (typeof val === "object") return JSON.stringify(val);
      return String(val);
    }));

    const now = new Date();
    const title = `SWFT ${data_type.charAt(0).toUpperCase() + data_type.slice(1)} Export — ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

    const spreadsheet = await sheetsApi.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [{ properties: { title: data_type } }],
      },
    });

    const spreadsheetId = spreadsheet.data.spreadsheetId;
    const sheetUrl = spreadsheet.data.spreadsheetUrl;

    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${data_type}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [headerRow, ...dataRows] },
    });

    res.json({
      success: true,
      url: sheetUrl,
      title,
      rows_exported: rows.length,
    });
  } catch (err) {
    console.error("Export error:", err);
    if (err.code === 401 || err.message?.includes("invalid_grant")) {
      return res.status(401).json({ error: "Google Sheets authorization expired. Please reconnect in Settings → Integrations." });
    }
    res.status(500).json({ error: "Export failed: " + err.message });
  }
});

module.exports = router;
