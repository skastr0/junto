/**
 * K2 (plan 0.11/05, Code steps): a code step runs on this machine's runtime,
 * reads its input from stdin, answers on fd 3, and holds the doctrine's run
 * rules (docs/security-doctrine.md, Code steps). The runtime here is the bun
 * that runs the suite, standing in for the machine's `junto` binary as bun.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentRef } from "@shared/content";
import {
  makeCodeRunner,
  type CodeInput,
  type CodeLanguage,
  type CodeResult,
  type CodeRunRequest,
} from "../src/main/junto/automation/code-runner";

const BUN = execFileSync("/usr/bin/env", ["which", "bun"], { encoding: "utf8" }).trim();
const CANVAS = "factory";

let root: string;
let runRoot: string;
let childHome: string;
const sources = new Map<string, Uint8Array>();

const refOf = (text: string): ContentRef => {
  const bytes = new TextEncoder().encode(text);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  sources.set(sha256, bytes);
  return { sha256, byteLength: bytes.byteLength, mediaType: "text/plain" } as ContentRef;
};

const INPUT: CodeInput = {
  automation: { automationId: "automation-1", name: "Check done tasks", nodeId: "automations-1" },
  firing: { firingId: "firing-1", at: 1_793_224_014_508, cause: "change" },
  trigger: { kind: "task", becomes: "done" },
  event: { kind: "task", taskId: "task-7" },
  values: { "task.title": "Ship the quit handshake" },
};

const runner = (overrides: { readonly runtime?: () => string | undefined } = {}) => makeCodeRunner({
  machine: "mac-mini",
  runRoot,
  readSource: (ref) => Effect.succeed(sources.get(ref.sha256) ?? { state: "missing" }),
  runtime: overrides.runtime ?? (() => BUN),
  baseEnv: {
    PATH: process.env.PATH,
    HOME: childHome,
    TMPDIR: runRoot,
    LANG: "en_US.UTF-8",
    JUNTO_SOCKET: "/should/not/reach/the/child",
    JUNTO_WORK_TOKEN: "core-token-that-must-not-reach-the-child",
  },
});

const request = (language: CodeLanguage, source: string, more: Partial<CodeRunRequest> = {}): CodeRunRequest => ({
  canvasName: CANVAS,
  source: refOf(source),
  language,
  input: INPUT,
  timeoutMs: 20_000,
  maxOutputBytes: 65_536,
  env: {},
  ...more,
});

const run = (req: CodeRunRequest, r = runner()): Promise<CodeResult> => Effect.runPromise(r.runCode(req));
const runExit = (req: CodeRunRequest) => Effect.runPromiseExit(runner().runCode(req));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "code-runner-test-"));
  runRoot = join(root, "parent");
  childHome = join(root, "home");
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(childHome, { recursive: true });
  sources.clear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a TypeScript code step", () => {
  it("reads its input through the SDK and continues with an output", async () => {
    const result = await run(request("typescript", `
      import { input, value, cont } from "junto/automation";
      const { firing } = input();
      cont({ summary: \`\${value("task.title")} checked\`, firing: firing.firingId, count: 2, ok: true });
    `));
    expect(result).toMatchObject({
      kind: "continue",
      output: { summary: "Ship the quit handshake checked", firing: "firing-1", count: 2, ok: true },
    });
  }, 30_000);

  it("reads the artifact that fired it, its body as data", async () => {
    const artifact = { artifactId: "artifact-1", nodeId: "artifacts-1", title: "Release notes", version: 4, labels: ["ready"], body: { sections: [{ heading: "Fixes" }] } };
    const result = await run(request("typescript", `
      import { input, cont } from "junto/automation";
      const { artifact } = input();
      cont({ title: artifact?.title ?? "none", heading: (artifact?.body as { sections: Array<{ heading: string }> }).sections[0]!.heading, labels: artifact?.labels.join(",") ?? "" });
    `, { input: { ...INPUT, artifact } }));
    expect(result).toMatchObject({ kind: "continue", output: { title: "Release notes", heading: "Fixes", labels: "ready" } });
  }, 30_000);

  it("never carries the trigger in argv, and runs in its own removed directory", async () => {
    const result = await run(request("typescript", `
      import { cont } from "junto/automation";
      cont({ argv: process.argv.join(" "), cwd: process.cwd() });
    `));
    expect(result.kind).toBe("continue");
    const output = (result as Extract<CodeResult, { kind: "continue" }>).output;
    expect(String(output.argv)).not.toContain("Ship the quit handshake");
    expect(String(output.cwd)).toContain("junto-code-");
    expect(readdirSync(runRoot)).toEqual([]);
  }, 30_000);

  it("stops with a reason, and fails with a message", async () => {
    expect(await run(request("typescript", `import { stop } from "junto/automation"; stop("nothing to do");`)))
      .toMatchObject({ kind: "stop", reason: "nothing to do" });
    expect(await run(request("typescript", `import { fail } from "junto/automation"; fail("the board is gone");`)))
      .toMatchObject({ kind: "fail", message: "the board is gone" });
  }, 30_000);

  it("decides by exit code when it never answers", async () => {
    expect(await run(request("typescript", `console.log("hello");`)))
      .toMatchObject({ kind: "continue", output: {} });
    expect(await run(request("typescript", `process.exit(3);`)))
      .toMatchObject({ kind: "fail", exitCode: 3 });
  }, 30_000);

  it("refuses an answer that is not a result", async () => {
    const result = await run(request("typescript", `
      require("node:fs").writeSync(3, JSON.stringify({ kind: "continue", output: { "Bad-Name": 1 } }) + "\\n");
    `));
    expect(result.kind).toBe("fail");
  }, 30_000);

  it("times out, and the timeout ends what the code started", async () => {
    const marker = join(root, "grandchild-pid");
    const result = await run(request("typescript", `
      const child = Bun.spawn(["sleep", "60"]);
      require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(child.pid));
      setInterval(() => {}, 1000);
    `, { timeoutMs: 1_500 }));
    expect(result.kind).toBe("timeout");
    const pid = Number(require("node:fs").readFileSync(marker, "utf8"));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  }, 30_000);

  it("ends what the code left running when it exits", async () => {
    const marker = join(root, "leftover-pid");
    const result = await run(request("typescript", `
      const child = Bun.spawn(["sleep", "60"]);
      require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(child.pid));
      child.unref();
    `));
    expect(result.kind).toBe("continue");
    const pid = Number(require("node:fs").readFileSync(marker, "utf8"));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  }, 30_000);

  it("is too_large past the output bound", async () => {
    const result = await run(request("typescript", `
      import { cont } from "junto/automation";
      cont({ a: "x".repeat(7000), b: "x".repeat(7000) });
    `, { maxOutputBytes: 4_096 }));
    expect(result.kind).toBe("too_large");
  }, 30_000);

  it("gets the region environment and the base names, nothing of the core's, and an empty work token", async () => {
    const result = await run(request("typescript", `
      import { cont } from "junto/automation";
      cont({
        // A region value is a secret to the output check, so the step reports only that it saw it.
        region: process.env.REGION_NAME === "release",
        socket: process.env.JUNTO_SOCKET ?? "absent",
        token: process.env.JUNTO_WORK_TOKEN === undefined ? "absent" : \`[\${process.env.JUNTO_WORK_TOKEN}]\`,
        home: process.env.HOME ?? "absent",
      });
    `, { env: { REGION_NAME: "release" } }));
    expect(result).toMatchObject({
      kind: "continue",
      output: { region: true, socket: "absent", token: "[]", home: childHome },
    });
  }, 30_000);

  it("fails an output that carries a region secret, and scrubs the secret from the log tail", async () => {
    const secret = "s3cr3t-region-value-91";
    const result = await run(request("typescript", `
      import { cont } from "junto/automation";
      console.error("token is " + process.env.API_TOKEN);
      cont({ leaked: "before " + process.env.API_TOKEN });
    `, { env: { API_TOKEN: secret } }));
    expect(result).toMatchObject({ kind: "fail", message: "output_carries_secret" });
    expect(result.logTail?.text).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain(secret);
  }, 30_000);

  it("imports only the SDK and the runtime's built-ins", async () => {
    mkdirSync(join(runRoot, "node_modules", "leftpad"), { recursive: true });
    writeFileSync(join(runRoot, "node_modules", "leftpad", "index.js"), "module.exports = 'planted';");
    writeFileSync(join(runRoot, "node_modules", "leftpad", "package.json"), JSON.stringify({ name: "leftpad", main: "index.js" }));
    const statically = await run(request("typescript", `import pad from "leftpad"; console.log(pad);`));
    expect(statically).toMatchObject({ kind: "fail" });
    expect((statically as { message: string }).message).toContain("imports only junto/automation");
    const computed = await run(request("typescript", `const name = ["left", "pad"].join(""); await import(name);`));
    expect((computed as { message: string }).message).toContain("computed name");
    const required = await run(request("typescript", `
      import { cont } from "junto/automation";
      const name = ["left", "pad"].join("");
      let got = "refused";
      try { got = require(name); } catch {}
      cont({ got });
    `));
    expect(required).toMatchObject({ kind: "continue", output: { got: "refused" } });
    const builtins = await run(request("typescript", `
      import { cont } from "junto/automation";
      import { join } from "node:path";
      import os from "os";
      cont({ joined: join("a", "b"), platform: typeof os.platform() });
    `));
    expect(builtins).toMatchObject({ kind: "continue", output: { joined: "a/b", platform: "string" } });
  }, 60_000);

  it("reads no .env, bunfig.toml, package.json or tsconfig.json of the parent folder or HOME, and installs nothing", async () => {
    const markers = join(root, "markers");
    mkdirSync(markers);
    for (const [dir, label] of [[runRoot, "parent"], [childHome, "home"]] as const) {
      const evil = join(dir, "evil.ts");
      writeFileSync(evil, `require("node:fs").writeFileSync(${JSON.stringify(join(markers, label))}, "loaded");`);
      writeFileSync(join(dir, ".env"), `PLANTED=${label}\n`);
      writeFileSync(join(dir, "bunfig.toml"), `preload = [${JSON.stringify(evil)}]\n`);
      writeFileSync(join(dir, ".bunfig.toml"), `preload = [${JSON.stringify(evil)}]\n`);
      mkdirSync(join(dir, ".config"), { recursive: true });
      writeFileSync(join(dir, ".config", ".bunfig.toml"), `preload = [${JSON.stringify(evil)}]\n`);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", imports: { "#planted": "./evil.ts" } }));
      writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { planted: ["./evil.ts"] } } }));
    }
    const result = await run(request("typescript", `
      import { cont } from "junto/automation";
      const tried = (name: string): string => { try { require(name); return "loaded"; } catch { return "refused"; } };
      cont({
        planted: process.env.PLANTED ?? "absent",
        alias: tried("planted"),
        hash: tried("#planted"),
        esm: typeof require === "function" && typeof import.meta.url === "string",
      });
    `));
    expect(result).toMatchObject({ kind: "continue", output: { planted: "absent", alias: "refused", hash: "refused", esm: true } });
    expect(readdirSync(markers)).toEqual([]);

    const install = await run(request("typescript", `import isOdd from "is-odd-junto-planted"; console.log(isOdd);`));
    expect(install.kind).toBe("fail");
    expect(existsSync(join(runRoot, "node_modules"))).toBe(false);
    expect(existsSync(join(childHome, "node_modules"))).toBe(false);
  }, 60_000);
});

describe("a shell code step", () => {
  it("reads its input on stdin, answers on fd 3, and is run from a file", async () => {
    const result = await run(request("shell", [
      "input=$(cat)",
      "case \"$input\" in *'Ship the quit handshake'*) seen=yes ;; *) seen=no ;; esac",
      "printf '{\"kind\":\"continue\",\"output\":{\"seen\":\"%s\",\"args\":\"%s\"}}\\n' \"$seen\" \"$#\" >&3",
    ].join("\n")));
    expect(result).toMatchObject({ kind: "continue", output: { seen: "yes", args: "0" } });
  }, 30_000);

  it("fails with its exit code", async () => {
    expect(await run(request("shell", "exit 4"))).toMatchObject({ kind: "fail", exitCode: 4 });
  }, 30_000);
});

describe("admission", () => {
  const refused = async (req: CodeRunRequest) => {
    const exit = await runExit(req);
    expect(Exit.isFailure(exit)).toBe(true);
    return Exit.isFailure(exit) ? JSON.parse(JSON.stringify(exit.cause)) : undefined;
  };

  it("reads the answer it wrote even when the step swaps the path for a FIFO, and never stalls on it", async () => {
    const result = await run(request("shell", [
      `printf '{"kind":"continue","output":{"swapped":true}}\\n' >&3`,
      "rm -f answer && mkfifo answer",
      "exit 0",
    ].join("\n")));
    expect(result).toMatchObject({ kind: "continue", output: { swapped: true } });
  }, 30_000);

  it("refuses bytes that do not match the digest", async () => {
    const req = request("shell", "exit 0");
    sources.set(req.source.sha256, new TextEncoder().encode("exit 1"));
    expect(JSON.stringify(await refused(req))).toContain("\"check\":\"digest\"");
  });

  it("names a machine with no runtime", async () => {
    const exit = await Effect.runPromiseExit(runner({ runtime: () => undefined }).runCode(request("typescript", "")));
    expect(JSON.stringify(Exit.isFailure(exit) ? exit.cause : null)).toContain("CodeRuntimeMissing");
  });
});
