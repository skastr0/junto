import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const outputPath = process.argv[3];
const self = fileURLToPath(import.meta.url);

if (mode === "parent" && outputPath !== undefined) {
  const grandchild = spawn(process.execPath, [self, "grandchild"], {
    stdio: "ignore",
  });
  if (grandchild.pid === undefined) throw new Error("fixture grandchild has no pid");
  await writeFile(
    outputPath,
    JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid }),
    { mode: 0o600 },
  );
  setInterval(() => undefined, 1_000);
} else if (mode === "grandchild") {
  setInterval(() => undefined, 1_000);
} else if (mode === "marker" && outputPath !== undefined) {
  await writeFile(outputPath, "spawned", { mode: 0o600 });
} else {
  process.exitCode = 2;
}
