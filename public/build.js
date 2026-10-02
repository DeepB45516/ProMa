const fs = require("fs");
const path = require("path");

const sourceDir = __dirname;
const outputDir = path.join(sourceDir, "dist");

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
for (const entry of fs.readdirSync(sourceDir)) {
  if (entry === "dist") continue;
  fs.cpSync(path.join(sourceDir, entry), path.join(outputDir, entry), { recursive: true });
}
// Vercel proxies /api to Render (see vercel.json), keeping authentication
// cookies first-party on the Vercel domain.
fs.writeFileSync(path.join(outputDir, "config.js"), 'window.PROMA_API_URL = "";\n');
