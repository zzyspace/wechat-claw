import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const sourceDir = path.join(projectRoot, "src", "admin", "public");
const targetDir = path.join(projectRoot, "dist", "admin", "public");

if (!fs.existsSync(sourceDir)) {
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.cpSync(sourceDir, targetDir, {
  force: true,
  recursive: true,
});
