import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const outputPath = process.argv[3];
const self = fileURLToPath(import.meta.url);

if ((mode === "parent" || mode === "parent-ignore-term") && outputPath !== undefined) {
  const grandchild = mode === "parent-ignore-term"
    ? spawn("node", ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    })
    : spawn(process.execPath, [self, "grandchild"], {
      stdio: "ignore",
    });
  if (grandchild.pid === undefined) throw new Error("fixture grandchild has no pid");
  if (mode === "parent-ignore-term") {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(
    outputPath,
    JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid }),
    { mode: 0o600 },
  );
  setInterval(() => undefined, 1_000);
} else if (mode === "leader-exits-first-ignore-term" && outputPath !== undefined) {
  const grandchild = spawn("node", ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  if (grandchild.pid === undefined) throw new Error("fixture grandchild has no pid");
  grandchild.unref();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(
    outputPath,
    JSON.stringify({ grandchildPid: grandchild.pid }),
    { mode: 0o600 },
  );
} else if (mode === "grandchild") {
  setInterval(() => undefined, 1_000);
} else if (mode === "marker" && outputPath !== undefined) {
  await writeFile(outputPath, "spawned", { mode: 0o600 });
} else {
  process.exitCode = 2;
}
