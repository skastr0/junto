/**
 * The git group over a window's link: the window's runtime on one end, main's
 * forward in the middle, and the core's real git handlers behind main's
 * client, reading a repository in a temp folder. Every read is the adapter's
 * own answer unchanged, and a payload the group's schema refuses is refused
 * at main's edge before the core is asked.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import { Rpc, RpcClient, RpcClientError, RpcGroup, RpcTest } from "effect/rpc";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { clientProtocol, heldForServer, type PortMessage, type RpcPort } from "../src/shared/rpc-port";

vi.mock("electron", () => ({ MessageChannelMain: class {} }));
vi.mock("../src/app/runtime", () => ({ AppRuntime: {} }));

const { windowServer } = await import("../src/app/window/ipc");
const { GitWindowHandlers } = await import("../src/app/git/ipc");
const { GitCore, GitRpcs } = await import("../src/contract/core/git");
const { GitWindow, GitWindowRpcs } = await import("../src/contract/window/git");
const { WindowRpcs } = await import("../src/contract/window/rpcs");
const { GitHandlers } = await import("../src/core/ops/git-ipc");
const { pageLink } = await import("../src/window/rpc/link");
const { makeWindowRuntime } = await import("../src/window/rpc/runtime");
const { notUnderTest } = await import("./support/window-groups");

const mainLinkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (event: MessageEvent) => handler(event.data as PortMessage);
    port.addEventListener("message", on);
    port.start();
    return () => port.removeEventListener("message", on);
  },
});

/** A page whose preload hands it `port` when it asks for its link. */
const pageWith = (port: MessagePort) => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const page = {
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.delete(listener),
  } as unknown as Window;
  const bridge = {
    openWindowLink: () => {
      const event = { source: page, data: { type: IPC_CHANNELS.windowLink }, ports: [port] } as unknown as MessageEvent;
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener(event);
      });
    },
  };
  return { page, bridge };
};

let repo: string;
let notRepo: string;
let sha: string;

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "junto-window-git-")));
  notRepo = realpathSync(mkdtempSync(join(tmpdir(), "junto-window-not-git-")));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), "one\n");
  git("add", "notes.md");
  git("commit", "-q", "-m", "First note");
  sha = git("rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "notes.md"), "one\ntwo\n");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(notRepo, { recursive: true, force: true });
});

let scope: Scope.Closeable;
let asks: Array<string>;
let serve: (port: MessagePort) => void;
let runtime: ReturnType<typeof makeWindowRuntime>;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
  asks = [];
  const handlers = await Effect.runPromise(Layer.buildWithScope(GitHandlers, scope));
  const core = await Effect.runPromise(
    RpcTest.makeClient(GitRpcs).pipe(Effect.provide(handlers), Effect.provideService(Scope.Scope, scope)),
  );
  // Main's client of the core, counting what reaches it.
  const counted = new Proxy(core, {
    get: (target, tag: string) => (payload: unknown) =>
      Effect.suspend(() => {
        asks.push(tag);
        return (target as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>)[tag]!(payload);
      }),
  });
  const mainHandlers = Layer.mergeAll(
    // Every other window group answers nothing here: they are not under test.
    notUnderTest(WindowRpcs.omit("GitStatus", "GitLog", "GitShow", "GitCommit", "GitSummary", "GitReview")),
    GitWindowHandlers.pipe(Layer.provide(Layer.succeed(GitCore, counted as never))),
  );
  serve = (port) => {
    const server = Effect.runFork(
      Layer.launch(windowServer(heldForServer(mainLinkOf(port)), mainHandlers as never, { id: 1, webContents: {} as never })),
    );
    cleanups.push(async () => {
      await Effect.runPromise(Fiber.interrupt(server));
      port.close();
    });
  };
  const { port1, port2 } = new MessageChannel();
  serve(port1);
  const { page, bridge } = pageWith(port2);
  runtime = makeWindowRuntime(pageLink(bridge, page));
  cleanups.push(async () => {
    await runtime.dispose();
    port2.close();
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const call = <A, E>(use: (git: RpcClient.FromGroup<typeof GitWindowRpcs, RpcClientError.RpcClientError>) => Effect.Effect<A, E>) =>
  runtime.runPromise(Effect.flatMap(GitWindow, use));

/** A client of a drifted contract: the same tag, with a payload main's schema refuses. */
const drifted = async (rpc: Rpc.Any, payload: unknown): Promise<Exit.Exit<unknown, unknown>> => {
  const { port1, port2 } = new MessageChannel();
  serve(port1);
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      RpcClient.make(RpcGroup.make(rpc)).pipe(
        Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(mainLinkOf(port2))),
        Effect.flatMap((client) => (client as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>)[rpc._tag]!(payload)),
      ),
    ),
  );
  port2.close();
  return exit;
};

describe("the git group over a window's link", () => {
  it("forwards every git read, and only those", () => {
    expect([...GitWindowRpcs.requests.keys()].sort()).toEqual([...GitRpcs.requests.keys()].sort());
  });

  it("answers a read with the adapter's own result, as the core read it", async () => {
    const log = await call((git) => git.GitLog({ cwd: repo, limit: 10 }));
    expect(log).toMatchObject({ ok: true, commits: [{ sha, subject: "First note" }] });
    const shown = await call((git) => git.GitShow({ cwd: repo, sha }));
    expect(shown).toMatchObject({ ok: true });
    const status = await call((git) => git.GitStatus({ cwd: repo }));
    expect(status).toMatchObject({ ok: true });
    const review = await call((git) => git.GitReview({ cwd: repo, view: "working" }));
    expect(review).toMatchObject({ ok: true, patch: expect.stringContaining("+two") });
    const commit = await call((git) => git.GitCommit({ cwd: repo, sha }));
    expect(commit).toMatchObject({ ok: true });
    const summary = await call((git) => git.GitSummary({ cwd: repo }));
    expect(summary).toMatchObject({ ok: true });
    expect(asks).toEqual(["GitLog", "GitShow", "GitStatus", "GitReview", "GitCommit", "GitSummary"]);
  });

  it("answers a folder that is not a repository in words, never a failure", async () => {
    const status = await call((git) => git.GitStatus({ cwd: notRepo }));
    expect(status).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("refuses at main's edge a view the group does not name, before the core is asked", async () => {
    const exit = await drifted(
      Rpc.make("GitReview", { payload: { cwd: Schema.String, view: Schema.String }, success: Schema.Unknown }),
      { cwd: repo, view: "both" },
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(asks).not.toContain("GitReview");
  });

  it("refuses at main's edge a payload with a field the group does not name", async () => {
    const exit = await drifted(
      Rpc.make("GitStatus", { payload: { cwd: Schema.String, extra: Schema.String }, success: Schema.Unknown }),
      { cwd: repo, extra: "x" },
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(asks).not.toContain("GitStatus");
  });

  it("asks the core with no hand decoding: a cwd that is not a string never becomes an empty folder", async () => {
    const exit = await drifted(
      Rpc.make("GitSummary", { payload: { cwd: Schema.Number }, success: Schema.Unknown }),
      { cwd: 7 },
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(asks).not.toContain("GitSummary");
  });
});
