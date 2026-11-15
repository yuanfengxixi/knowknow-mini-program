const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const functionsRoot = path.join(projectRoot, "miniprogram", "cloudfunctions");
const sharedSource = path.join(functionsRoot, "_shared");

if (!fs.existsSync(sharedSource)) {
  throw new Error(`Shared CloudBase function sources are missing: ${sharedSource}`);
}

for (const entry of fs.readdirSync(functionsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "_shared") continue;
  const functionRoot = path.join(functionsRoot, entry.name);
  if (!fs.existsSync(path.join(functionRoot, "index.js"))) continue;

  const target = path.join(functionRoot, "_shared");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(sharedSource, target, { recursive: true });
}
