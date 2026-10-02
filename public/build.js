const fs = require("fs");
const path = require("path");

const sourceDir = __dirname;
const outputDir = path.join(sourceDir, "dist");
const apiBaseUrl = (process.env.API_BASE_URL || "").replace(/\/$/, "");

if (!/^https:\/\/[^\s/$.?#][^\s]*$/i.test(apiBaseUrl)) {
  throw new Error("API_BASE_URL must be the HTTPS URL of the Render API, for example https://your-api.onrender.com.");
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
for (const entry of fs.readdirSync(sourceDir)) {
  if (entry === "dist") continue;
  fs.cpSync(path.join(sourceDir, entry), path.join(outputDir, entry), { recursive: true });
}
fs.writeFileSync(path.join(outputDir, "config.js"), `window.PROMA_API_URL = ${JSON.stringify(apiBaseUrl)};\n`);
