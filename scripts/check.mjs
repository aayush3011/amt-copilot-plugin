import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

async function* modules(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* modules(path);
    else if (entry.isFile() && entry.name.endsWith(".mjs")) yield path;
  }
}

let failed = false;
for (const directory of ["src", "scripts", "test", ".github", ".maintainer", "plugin"]) {
  for await (const path of modules(directory)) {
    const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
    if (result.error) {
      process.stderr.write(`Could not check ${path}: ${result.error.message}\n`);
      failed = true;
    } else if (result.status !== 0) failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
