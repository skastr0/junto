/**
 * Packaged build (protect the main thread, 0.11.7): the terminal process's
 * entry, read from app.asar, runs as a utilityProcess, loads node-pty, and
 * spawns a PTY through node-pty's spawn-helper; node-pty's native module is
 * mapped from app.asar.unpacked. Runs only when JUNTO_PACKAGED_APP names a
 * built Junto.app:
 *   JUNTO_PACKAGED_APP=release/mac-arm64/Junto.app bun run test:e2e:fast e2e/scenarios/packaged-terminal-process.spec.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const APP = process.env.JUNTO_PACKAGED_APP;

test("the packaged terminal entry loads node-pty from app.asar.unpacked inside a utilityProcess", async () => {
  test.skip(APP === undefined, "JUNTO_PACKAGED_APP is not set");
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "junto-packaged-terminal-"));
  const app = await electron.launch({
    executablePath: join(resolve(APP!), "Contents/MacOS/Junto"),
    args: ["--mute-audio", `--user-data-dir=${join(root, "user-data")}`],
    env: { ...(process.env as Record<string, string>), HOME: root, TMPDIR: root, JUNTO_SECRET_STORE: "file", JUNTO_E2E: "1" },
    timeout: 60_000,
  });
  try {
    const started = await app.evaluate(async ({ app: electronApp, utilityProcess }) => {
      const fs = process.getBuiltinModule("node:fs");
      const path = process.getBuiltinModule("node:path");
      const chunks = path.join(electronApp.getAppPath(), "out/main/chunks");
      // The terminal entry is the one chunk that loads node-pty from a parent port.
      const entry = fs.readdirSync(chunks)
        .map((name) => path.join(chunks, name))
        .find((file) => {
          const text = fs.readFileSync(file, "utf8");
          return text.includes("node-pty") && text.includes("parentPort");
        });
      if (entry === undefined) return { error: `no terminal entry under ${chunks}` };
      const child = utilityProcess.fork(entry, [], { serviceName: "Junto Terminals check", stdio: "pipe" });
      let stderr = "";
      child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
      const g = globalThis as { __packagedTerminal?: unknown };
      g.__packagedTerminal = child;
      const outcome = await new Promise<Record<string, unknown>>((done) => {
        let data = "";
        let pid: unknown;
        const timer = setTimeout(() => done({ error: "timed out", data, pid, stderr }), 20_000);
        child.on("message", (message: { kind: string; id?: number; ok?: boolean; value?: { pid?: number }; failure?: unknown; channel?: string; payload?: { data?: string } }) => {
          if (message.kind === "answer" && message.id === 1) {
            if (message.ok !== true) {
              clearTimeout(timer);
              done({ error: "spawn refused", failure: message.failure, stderr });
              return;
            }
            pid = message.value?.pid;
          }
          if (message.kind === "push" && message.channel === "pty.data") {
            data += message.payload?.data ?? "";
            if (data.includes("pty-ok-42")) {
              clearTimeout(timer);
              done({ entry, pid, data, utilityPid: child.pid });
            }
          }
        });
        child.postMessage({
          kind: "call", id: 1, name: "pty.spawn",
          input: { id: 1, command: "/bin/sh", args: ["-c", "echo pty-ok-$((6*7)); sleep 5"], cols: 80, rows: 24, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME } },
        });
      });
      return outcome;
    });
    console.log("PKG-TERMINAL", JSON.stringify({ ...started, data: undefined }));
    expect(started.error, JSON.stringify(started)).toBeUndefined();
    expect(String(started.entry)).toContain("app.asar/out/main/chunks/");
    expect(typeof started.pid).toBe("number");
    const utilityPid = Number(started.utilityPid);
    const parent = execFileSync("ps", ["-o", "ppid=", "-p", String(started.pid)], { encoding: "utf8" }).trim();
    expect(Number(parent), "the PTY's child is the utility process's").toBe(utilityPid);
    const mapped = execFileSync("lsof", ["-p", String(utilityPid)], { encoding: "utf8" })
      .split("\n").filter((line) => line.includes("pty.node")).map((line) => line.slice(line.indexOf("/")));
    console.log("PKG-PTY-NODE", JSON.stringify(mapped));
    expect(mapped.length).toBeGreaterThan(0);
    for (const file of mapped) expect(file).toContain("app.asar.unpacked/node_modules/node-pty/");
  } finally {
    await app.evaluate(() => (globalThis as { __packagedTerminal?: { kill: () => void } }).__packagedTerminal?.kill()).catch(() => undefined);
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
