/**
 * Who can ask for another machine's bytes (0.12.1, X3, remote-security term
 * 6): the operator's window alone. A byte request is built in one place, the
 * link client, which only the files router asks, which only the core's Files
 * handlers ask, which only main's trusted renderer IPC and its `junto-file:`
 * resolver call. No seat, CLI or overseer path names any of them. A new
 * caller fails this scan, whatever it is named.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const walk = (root: string, suffix: RegExp): ReadonlyArray<string> => {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "node_modules" && !entry.startsWith(".")) visit(path);
      } else if (suffix.test(entry)) {
        out.push(path);
      }
    }
  };
  visit(root);
  return out;
};
const sources = walk("src", /\.tsx?$/).map((path) => ({ path, source: readFileSync(path, "utf8") }));
const naming = (test: (source: string) => boolean): ReadonlyArray<string> =>
  sources.filter(({ source }) => test(source)).map(({ path }) => path).sort();

describe("byte requests come from the operator's window only", () => {
  it("the file-bytes contract is named by its channel, the core that binds it, and the link client alone", () => {
    expect(naming((source) => /\bFileBytesLink\b|\bmakeFileBytesLinkChannel\b/u.test(source))).toEqual([
      "src/core/core.ts",
      "src/core/files/bytes-link.ts",
      "src/core/files/link-client.ts",
    ]);
  });

  it("the core's bytes and import ops are called by main's Files IPC alone, which is the trusted renderer's", () => {
    expect(naming((source) => /\bFilesBytesOpen\(|\bFilesImport\(/u.test(source))).toEqual(["src/app/files/ipc.ts"]);
    const ipc = readFileSync("src/app/files/ipc.ts", "utf8");
    expect(ipc).toContain("const ipc = trustedRendererIpc(ipcMain);");
    expect(ipc).not.toMatch(/ipcMain\.handle\(/u);
  });

  it("the router's bytes and import are asked by the core's Files handlers alone", () => {
    expect(naming((source) => /\brouter\.(?:bytes|import)\(/u.test(source))).toEqual(["src/core/ops/files.ts"]);
    expect(naming((source) => /\bremote\.(?:bytes|import)\(/u.test(source))).toEqual(["src/core/files/router.ts"]);
  });

  it("no seat, CLI or overseer source names a byte request", () => {
    const words = /\bFileBytesLink\b|\bFilesBytesOpen\b|\bFilesImport\b|\bReadOpen\b|\bImportOpen\b|\bfile-bytes\b/u;
    const outside = naming((source) => words.test(source)).filter((path) =>
      /^src\/(?:core\/overseer|core\/seats?|cli|core\/cli|core\/operator)\//u.test(path));
    expect(outside).toEqual([]);
  });
});
