import { spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const outputPath = process.argv[3];
const self = fileURLToPath(import.meta.url);
// The reader polls for the file to exist, then parses it: write a sibling and
// rename it into place so the path never appears empty or half-written.
const writeReceipt = async (path: string, receipt: unknown): Promise<void> => {
  const partial = `${path}.partial`;
  await writeFile(partial, JSON.stringify(receipt), { mode: 0o600 });
  await rename(partial, path);
};
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
  await writeReceipt(outputPath, { parentPid: process.pid, grandchildPid: grandchild.pid });
  hardExitAfter(2_000);
  setInterval(() => undefined, 1_000);
} else if (
  (mode === "leader-exits-first-ignore-term" || mode === "leader-exits-first-closed") &&
  outputPath !== undefined
) {
  // Both bounded grandchildren remain in the leader's original process group.
  // One inherits output pipes; the other closes stdio before the leader exits.
  const grandchild = spawn("node", [
    "-e",
    "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 5000)",
  ], {
    stdio: mode === "leader-exits-first-ignore-term"
      ? ["ignore", "inherit", "inherit"]
      : "ignore",
  });
  if (grandchild.pid === undefined) throw new Error("fixture grandchild has no pid");
  grandchild.unref();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeReceipt(outputPath, { grandchildPid: grandchild.pid });
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
