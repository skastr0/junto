/**
 * Linux release audit for an installed Electron resources directory.
 *
 * Usage: bun scripts/linux-packaged-pty-smoke.ts /path/to/resources /path/to/electron
 *
 * The Electron executable is run with --runAsNode so node-pty loads with the
 * packaged Electron ABI, never Bun's ABI. This script intentionally has no
 * package-script wiring; the Linux packaging lane owns that integration.
 */
import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const nodePtyRoot = (resources: string): string =>
  join(resources, "app.asar.unpacked", "node_modules", "node-pty");

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const auditLinuxPtyPlacement = (resources: string): {
  readonly nodePtyRoot: string;
  readonly nativeModule: string;
  readonly spawnHelper: string;
} => {
  const root = resolve(nodePtyRoot(resources));
  if (!root.includes("app.asar.unpacked")) {
    throw new Error("node-pty must be unpacked outside app.asar");
  }
  const nativeCandidates = [
    join(root, "prebuilds", "linux-x64", "pty.node"),
    join(root, "build", "Release", "pty.node"),
  ];
  const helperCandidates = [
    join(root, "prebuilds", "linux-x64", "spawn-helper"),
    join(root, "build", "Release", "spawn-helper"),
  ];
  const nativeModule = nativeCandidates.find((path) => existsSync(path) && statSync(path).isFile());
  const spawnHelper = helperCandidates.find(isExecutable);
  if (!nativeModule) throw new Error("packaged Linux node-pty binary is missing");
  if (!spawnHelper) throw new Error("packaged Linux node-pty spawn-helper is missing or not executable");
  return { nodePtyRoot: root, nativeModule, spawnHelper };
};

const probeSource = `
const pty = require("node-pty");
const expected = ["PTY-ECHO:ok", "UTF8:✓", "TERM:xterm-256color", "COLORTERM:truecolor", "SIZE:101 41", "LOGIN:yes"];
const child = pty.spawn("/bin/bash", ["-l"], {
  name: "xterm-256color", cols: 80, rows: 24,
  env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
});
let output = "";
let settled = false;
const finish = (code) => { if (settled) return; settled = true; clearTimeout(deadline); process.exitCode = code; };
const deadline = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(1); }, 500); }, 3000);
child.onData((chunk) => { output += chunk; });
child.onExit(({ exitCode }) => {
  const normalized = output.replace(/\\r/g, "");
  if (exitCode !== 23 || expected.some((line) => !normalized.includes(line))) {
    console.error(JSON.stringify({ exitCode, missing: expected.filter((line) => !normalized.includes(line)), output: normalized.slice(0, 8192) }));
    finish(1); return;
  }
  console.log("linux packaged PTY smoke passed"); finish(0);
});
child.resize(101, 41);
child.write("printf 'PTY-ECHO:ok\\nUTF8:✓\\nTERM:%s\\nCOLORTERM:%s\\n' \\\"$TERM\\\" \\\"$COLORTERM\\\"; printf 'SIZE:'; stty size | awk '{print $2, $1}'; printf '\\n'; case \\\"$-\\\" in *l*) printf 'LOGIN:yes\\n';; *) printf 'LOGIN:no\\n';; esac; exit 23\\r");
`;

export const smokeLinuxPackagedPty = (resources: string, electron: string): void => {
  if (process.platform !== "linux") throw new Error("Linux packaged PTY smoke requires Linux");
  const layout = auditLinuxPtyPlacement(resources);
  const temp = mkdtempSync(join(tmpdir(), "vellum-linux-pty-smoke-"));
  const probe = join(temp, "probe.cjs");
  try {
    writeFileSync(probe, probeSource, { mode: 0o600 });
    const result = spawnSync(electron, ["--runAsNode", probe], {
      env: { ...process.env, NODE_PATH: join(layout.nodePtyRoot, "..") },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`packaged PTY probe failed: ${(result.stderr || result.stdout || String(result.error)).trim().slice(0, 4096)}`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const [resources, electron] = process.argv.slice(2);
  if (!resources || !electron) {
    console.error("usage: bun scripts/linux-packaged-pty-smoke.ts /path/to/resources /path/to/electron");
    process.exitCode = 2;
  } else {
    try {
      smokeLinuxPackagedPty(resources, electron);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
