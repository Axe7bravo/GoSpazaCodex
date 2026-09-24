import { randomBytes } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const targets = [".env", "apps/backend/.env", ...["customer", "merchant", "driver", "admin"].map((app) => "apps/" + app + "/.env.local")];
for (const target of targets) {
  try {
    await access(path.join(root, target));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  throw new Error("Environment setup stopped: " + target + " already exists. Preserve it and configure missing files manually using the examples.");
}
const password = randomBytes(24).toString("hex");
for (const target of targets) {
  const example = target.endsWith(".env.local") ? target.replace(".env.local", ".env.example") : target + ".example";
  let content = await readFile(path.join(root, example), "utf8");
  content = content
    .replace("replace-me-with-a-generated-secret", randomBytes(32).toString("hex"))
    .replace("replace-me-with-a-different-generated-secret", randomBytes(32).toString("hex"))
    .replaceAll("replace-me", password);
  await writeFile(path.join(root, target), content, { flag: "wx", mode: 0o600 });
}
console.log("Created local environment files with generated secrets. Existing files are never overwritten.");
