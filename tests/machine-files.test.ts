/**
 * Files for a seat on another machine: the queue that pushes each one once per
 * machine and retries a failure, and a whole push against the real
 * content-transfer command, run here in place of the far machine.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import * as Command from "effect/unstable/process/ChildProcess";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMachineFiles, MACHINE_FILE_PIECE_BYTES, pushFileToMachine } from "../src/main/junto/content/machine-files";
import { contentObjectPath, contentStoreRoot } from "../src/main/junto/content/paths";
import { ContentService } from "../src/main/junto/content/service";
import { HostsService } from "../src/main/junto/hosts/service";
import { SshTransport } from "../src/main/junto/ssh";
import { createSshProgramCompiler, type OneShotProgram } from "../src/main/junto/ssh/program";
import type { ContentRef } from "../src/shared/wire/content-ref";

const ref = (n: number) => ({ sha256: String(n).repeat(64).slice(0, 64), byteLength: n, mediaType: "image/png" }) as ContentRef;
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("the push queue", () => {
  afterEach(() => vi.useRealTimers());

  it("pushes each file once per machine, one at a time, and drops it once it lands", async () => {
    const runs: string[] = [];
    let inFlight = 0;
    let most = 0;
    const files = makeMachineFiles(async (machine, file) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      runs.push(`${machine}:${file.byteLength}`);
      await settle();
      inFlight -= 1;
    });
    files.push("mini", [ref(1), ref(2), ref(1)]);
    files.push("mini", [ref(2)]);
    for (let i = 0; i < 10; i += 1) await settle();
    expect(runs).toEqual(["mini:1", "mini:2"]);
    expect(most).toBe(1);
    expect(files.waiting("mini")).toBe(0);
  });

  it("retries a failure later on its own, and at once when the mail is routed again", async () => {
    vi.useFakeTimers();
    let fail = true;
    const runs: number[] = [];
    const files = makeMachineFiles(async () => {
      runs.push(Date.now());
      if (fail) throw new Error("unreachable");
    });
    files.push("mini", [ref(3)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runs).toHaveLength(2);
    // Routed again (the link came back): it goes now, not after its wait.
    fail = false;
    files.push("mini", [ref(3)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(3);
    expect(files.waiting("mini")).toBe(0);
    files.stop();
  });
});

describe("a push against the real content-transfer", () => {
  const roots: string[] = [];
  afterEach(async () => {
    while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
  });

  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-content-mux", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });

  const rigged = async (size: number) => {
    const root = await mkdtemp(join(tmpdir(), "junto-machine-files-"));
    roots.push(root);
    const location = { juntoHome: join(root, "far/.junto"), installRoot: join(root, "install") };
    await mkdir(join(location.installRoot, "current/bin"), { recursive: true });
    const bun = execFileSync("/usr/bin/which", ["bun"], { encoding: "utf8" }).trim();
    const junto = join(location.installRoot, "current/bin/junto");
    await writeFile(junto, `#!/bin/sh\nexec ${quote(bun)} ${quote(resolve("src/cli/main.ts"))} "$@"\n`);
    await chmod(junto, 0o755);
    // This machine's store holds the object.
    const here = join(root, "here");
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 7) % 256;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const object = contentObjectPath(here, sha256);
    await mkdir(dirname(object), { recursive: true });
    await writeFile(object, bytes);
    const runs: string[] = [];
    const ssh = Layer.succeed(SshTransport, {
      run: (program: OneShotProgram) =>
        Effect.sync(() => {
          const compiled = compiler.oneShot(program);
          if (!Command.isStandardCommand(compiled.command)) throw new Error("expected argv command");
          const text = compiled.command.args.at(-1)!;
          runs.push(/\bstat\b/.test(text) ? "stat" : "receive");
          const result = spawnSync("/bin/sh", ["-c", text], { input: compiled.input, encoding: "utf8" });
          return { stdout: result.stdout, stderr: result.stderr };
        }),
    } as never);
    const hosts = Layer.succeed(HostsService, {
      get: () => Effect.succeed({ id: "mini", sshEndpoint: "user@fixture", juntoHome: location.juntoHome, installRoot: location.installRoot, isThisMachine: false }),
    } as never);
    const content = Layer.succeed(ContentService, { root: here } as never);
    const push = () =>
      Effect.runPromise(
        pushFileToMachine("mini", { sha256, byteLength: size, mediaType: "application/octet-stream" } as ContentRef).pipe(
          Effect.provide(Layer.mergeAll(ssh, hosts, content)),
        ),
      );
    const far = () => readFile(contentObjectPath(contentStoreRoot(location.juntoHome), sha256));
    return { push, far, bytes, runs };
  };

  it("lands the object in pieces, and a second push asks once and sends nothing", async () => {
    const r = await rigged(MACHINE_FILE_PIECE_BYTES + 10);
    await r.push();
    expect(Buffer.compare(await r.far(), r.bytes)).toBe(0);
    expect(r.runs).toEqual(["stat", "receive", "receive"]);
    await r.push();
    expect(r.runs).toEqual(["stat", "receive", "receive", "stat"]);
  }, 60_000);
});
