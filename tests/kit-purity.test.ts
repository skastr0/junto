/**
 * The kit (src/renderer/kit) is what the website and docs draw seats with.
 * It must never reach the app: no store, no canvas camera, no IPC. Bundles
 * its real import graph (type imports drop out, as in a build) and fails on
 * the first module that would.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build, type Metafile } from "esbuild";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");

const FORBIDDEN_PACKAGES = [/^@legendapp\/state/, /^@xyflow\//, /^electron$/];
const FORBIDDEN_MODULES = ["src/renderer/lib/state.ts", "src/renderer/lib/junto-api.ts"];
/** What the kit may ask its host for; everything else is bundled in. */
const PEERS = ["react", "react-dom", "react/jsx-runtime", "lucide-react", "effect", "ulid"];

const kitGraph = async (): Promise<Metafile> => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/renderer/kit/index.ts"],
    tsconfig: "tsconfig.json",
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    packages: "external",
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  return result.metafile;
};

describe("kit purity", () => {
  it("reaches no store, camera or IPC, and asks its host only for its peers", async () => {
    const graph = await kitGraph();
    const modules = Object.keys(graph.inputs);
    expect(modules).toContain("src/renderer/kit/index.ts");
    expect(modules.filter((path) => FORBIDDEN_MODULES.includes(path))).toEqual([]);

    const packages = new Set<string>();
    for (const [path, input] of Object.entries(graph.inputs)) {
      // A relative import left external is one the bundle dropped (a type).
      for (const used of input.imports) if (used.external && !used.path.startsWith(".")) packages.add(`${used.path} <- ${path}`);
    }
    const reached = [...packages];
    expect(reached.filter((line) => FORBIDDEN_PACKAGES.some((rule) => rule.test(line)))).toEqual([]);
    const peerOf = (line: string): string => line.split(" <- ")[0]!;
    expect(reached.filter((line) => !PEERS.some((peer) => peerOf(line) === peer || peerOf(line).startsWith(`${peer}/`)))).toEqual([]);
    expect(modules.filter((path) => readFileSync(resolve(root, path), "utf8").includes("window.junto"))).toEqual([]);
  });
});
