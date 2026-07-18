import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [join(root, "src"), join(root, "scripts")];

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".sh"].includes(
      extname(path),
    )
      ? [path]
      : [];
  });

const files = sourceRoots.flatMap(sourceFiles);
const display = (path: string): string => relative(root, path);

describe("SSH architecture", () => {
  it("keeps OpenSSH process construction inside the transport kernel", () => {
    const forbidden = [
      /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|runCli)\s*\(\s*["'`](?:\/[^"'`]+\/)?ssh(?:\s|["'`])/u,
      /\bBun\.spawn(?:Sync)?\s*\(\s*(?:\[\s*)?["'`](?:\/[^"'`]+\/)?ssh["'`]/u,
      /\bCommand\.make\s*\(\s*["'`](?:\/[^"'`]+\/)?ssh["'`]/u,
      /\bcommand\s*:\s*["'`](?:\/[^"'`]+\/)?ssh["'`]/u,
      /\b(?:ControlMaster|ControlPath|ControlPersist|ServerAliveInterval|ServerAliveCountMax)=/u,
    ];
    const allowedBinaryMentions = new Set([
      "scripts/packaged-runtime-smoke.ts",
      // Doctor only checks executability of the OpenSSH client path; spawn stays in kernel.
      "src/main/vellum/hosts/doctor.ts",
    ]);
    const violations = files.flatMap((path) => {
      const name = display(path);
      if (name.startsWith("src/main/vellum/ssh/")) return [];
      const source = readFileSync(path, "utf8");
      const shellInvocation = extname(path) === ".sh" &&
        /(?:^|[\n;&|()])\s*(?:\/\S+\/)?ssh(?:\s|\\)/u.test(source);
      const binaryIndirection = !allowedBinaryMentions.has(name) &&
        /["'`](?:\/[^"'`]+\/)?ssh["'`]/u.test(source);
      return shellInvocation || binaryIndirection || forbidden.some((pattern) => pattern.test(source))
        ? [name]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it("reserves private SSH constructors for product policy renderers", () => {
    const renderers = new Set([
      "src/main/vellum/herdr/transport.ts",
      "src/main/vellum/hermes/transport.ts",
      "src/main/vellum/hosts/doctor.ts",
    ]);
    const privateImport = /(?:from\s+|import\s*\()["'][^"']*\/ssh\/[^"']+["']/u;
    const violations = files.flatMap((path) => {
      const name = display(path);
      // hosts/doctor is a policy renderer (warm + home + closed binary probes).
      if (
        name.startsWith("src/main/vellum/ssh/") ||
        renderers.has(name) ||
        name === "src/main/vellum/hosts/doctor.ts"
      ) {
        return [];
      }
      return privateImport.test(readFileSync(path, "utf8")) ? [name] : [];
    });

    expect(violations).toEqual([]);
  });

  it("does not dispose shared ControlMaster sockets with -O exit", () => {
    // Shared masters are process-global (ControlPersist=600). A headless CLI
    // and the GUI share the same ControlPath; exit-on-dispose races them.
    const service = readFileSync(join(root, "src/main/vellum/ssh/service.ts"), "utf8");
    expect(service).not.toMatch(/master-exit|masterExit\(/u);
    expect(service).toMatch(/ControlPersist=600|do not track or -O exit/iu);
  });
});
