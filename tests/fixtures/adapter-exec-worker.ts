import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const outputPath = process.argv[3];
const self = fileURLToPath(import.meta.url);
const hardExitAfter = (milliseconds: number): void => {
  const timer = setTimeout(() => process.exit(0), milliseconds);
  timer.unref();
};

if ((mode === "parent" || mode === "parent-ignore-term") && outputPath !== undefined) {
  if (mode === "parent-ignore-term") process.on("SIGTERM", () => undefined);
  const grandchild = mode === "parent-ignore-term"
    ? spawn("node", ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 2000).unref()"], {
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
  hardExitAfter(2_000);
  setInterval(() => undefined, 1_000);
} else if (mode === "leader-exits-first-ignore-term" && outputPath !== undefined) {
  // Bounded orphan fixture: it outlives the leader briefly, then self-expires.
  const grandchild = spawn("node", ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 2000)"], {
    stdio: ["ignore", "inherit", "inherit"],
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
  hardExitAfter(2_000);
  setInterval(() => undefined, 1_000);
} else if (mode === "graceful-100") {
  await new Promise((resolve) => setTimeout(resolve, 100));
} else if (mode === "marker" && outputPath !== undefined) {
  await writeFile(outputPath, "spawned", { mode: 0o600 });
} else {
  process.exitCode = 2;
}
