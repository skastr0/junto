import { describe, expect, it } from "vitest";
import {
  decodeShellEnvironmentChange,
  decodeShellEnvironmentStatus,
  type ShellEnvironmentChange,
} from "@shared/shell-environment";
import type { ToolCall, ToolResult } from "../src/main/junto/region-env/tool";
import { makeShellEnvironment } from "../src/main/junto/shell-environment";

// The module against a scripted shell: every read is a ToolResult the test
// hands back when it chooses, and the clock is a counter.

const dump = (variables: Readonly<Record<string, string>>): ToolResult => ({
  kind: "ok",
  stdout: `motd\nJUNTO_ENV_BEGIN\n${Object.entries(variables).map(([k, v]) => `${k}=${v}\0`).join("")}JUNTO_ENV_END\n`,
});

const harness = (options: {
  readonly launched?: NodeJS.ProcessEnv;
  readonly turnedOff?: boolean;
  readonly shell?: string;
} = {}) => {
  const calls: ToolCall[] = [];
  const mtimes = new Map<string, number>();
  const statted: string[] = [];
  const pending: Array<(result: ToolResult) => void> = [];
  const target: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: "/home/t", ...options.launched };
  let clock = 1_000;
  const environment = makeShellEnvironment({
    runTool: (call) => {
      calls.push(call);
      return new Promise((resolve) => pending.push(resolve));
    },
    target,
    home: () => "/home/t",
    now: () => (clock += 5),
    shell: () => options.shell ?? "/bin/zsh",
    turnedOff: () => options.turnedOff === true,
    cwd: async () => "/app/.junto",
    mtimeMs: async (path) => {
      statted.push(path);
      return mtimes.get(path);
    },
  });
  const changes: ShellEnvironmentChange[] = [];
  environment.onChange((change) => changes.push(change));
  /** Answer the oldest read still waiting, then let the module settle. */
  const answer = async (result: ToolResult): Promise<void> => {
    for (let turn = 0; turn < 100 && pending.length === 0; turn += 1) await Promise.resolve();
    const next = pending.shift();
    if (!next) throw new Error("no read is waiting");
    next(result);
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
  };
  return { environment, target, calls, changes, answer, mtimes, statted, clock: () => clock };
};

describe("ensure", () => {
  it("reads once, and concurrent callers share that one read", async () => {
    const h = harness();
    const first = h.environment.ensure();
    const second = h.environment.ensure();
    expect(h.environment.state()._tag).toBe("Unresolved");
    await h.answer(dump({ PATH: "/shell/bin:/usr/bin", EDITOR: "vim" }));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ command: "/bin/zsh", args: ["-l", "-i", "-c", expect.stringContaining("env -0")], cwd: "/app/.junto" });
    expect(a.PATH?.split(":").slice(0, 3)).toEqual(["/shell/bin", "/usr/bin", "/bin"]);
    expect(h.target.EDITOR).toBe("vim");
    // Idempotent: settled, it reads nothing more.
    await h.environment.ensure();
    expect(h.calls).toHaveLength(1);
  });

  it("is fail-open: no environment still gives seats the inherited PATH and the floor", async () => {
    const h = harness();
    const ensured = h.environment.ensure();
    await h.answer({ kind: "timeout" });
    const env = await ensured;
    expect(env.PATH?.startsWith("/usr/bin:/bin:")).toBe(true);
    expect(env.PATH).toContain("/home/t/.local/bin");
    expect(h.environment.state()).toMatchObject({
      _tag: "Failed",
      shell: "/bin/zsh",
      cause: { _tag: "TimedOut", timeoutMs: 10_000 },
      generation: 0,
      usingPrevious: false,
    });
  });

  it("does not read when the probe is turned off", async () => {
    const h = harness({ turnedOff: true });
    await h.environment.ensure();
    expect(h.calls).toHaveLength(0);
    expect(await h.environment.status()).toEqual({ _tag: "Inherited" });
  });
});

describe("refresh", () => {
  it("swaps the environment in one step and announces the names that changed", async () => {
    const h = harness({ launched: { GONE_LATER: "launch" } });
    const ensured = h.environment.ensure();
    await h.answer(dump({ PATH: "/shell/bin:/usr/bin", KEEP: "1", EDIT: "a", DROP: "x" }));
    await ensured;
    expect(h.environment.generation()).toBe(1);

    const refreshed = h.environment.refresh("operator");
    // While it reads, status answers at once with the environment still in use.
    expect(await h.environment.status()).toMatchObject({ _tag: "Resolving", generation: 1 });
    expect(h.target.DROP).toBe("x");
    await h.answer(dump({ PATH: "/new/bin:/usr/bin", KEEP: "1", EDIT: "b", ADDED: "y" }));
    const status = await refreshed;

    expect(status).toMatchObject({ _tag: "Resolved", generation: 2, shell: "/bin/zsh", variableCount: 4 });
    expect(h.target).toMatchObject({ KEEP: "1", EDIT: "b", ADDED: "y" });
    expect(h.target.DROP).toBeUndefined();
    expect(h.target.PATH?.split(":")[0]).toBe("/new/bin");
    expect(h.changes.at(-1)).toEqual({
      generation: 2,
      added: ["ADDED"],
      removed: ["DROP"],
      changed: ["EDIT"],
      pathAdded: ["/new/bin"],
      pathRemoved: ["/shell/bin"],
    });
  });

  it("keeps the previous environment when a later read fails", async () => {
    const h = harness();
    const ensured = h.environment.ensure();
    await h.answer(dump({ PATH: "/shell/bin:/usr/bin", TOKEN: "t1" }));
    const before = await ensured;
    const refreshed = h.environment.refresh("operator");
    await h.answer({ kind: "exit", code: 2, stdout: "", stderr: "boom" });
    expect(await refreshed).toMatchObject({
      _tag: "Failed",
      cause: { _tag: "Exited", code: 2 },
      generation: 1,
      usingPrevious: true,
    });
    expect(h.target.TOKEN).toBe("t1");
    expect(await h.environment.ensure()).toEqual(before);
    expect(h.changes).toHaveLength(1);
  });

  it("an identical read keeps its generation and announces nothing", async () => {
    const h = harness();
    const ensured = h.environment.ensure();
    await h.answer(dump({ PATH: "/shell/bin", A: "1" }));
    await ensured;
    const refreshed = h.environment.refresh("operator");
    await h.answer(dump({ PATH: "/shell/bin", A: "1" }));
    expect(await refreshed).toMatchObject({ _tag: "Resolved", generation: 1 });
    expect(h.changes).toHaveLength(1);
  });
});

describe("beforeSpawn", () => {
  const settle = async (h: ReturnType<typeof harness>) => {
    const ensured = h.environment.ensure();
    await h.answer(dump({ PATH: "/shell/bin", ZDOTDIR: "/home/t/.config/zsh", A: "1" }));
    await ensured;
  };

  it("reads again first when a startup file is newer than the last read", async () => {
    const h = harness();
    await settle(h);
    h.mtimes.set("/home/t/.config/zsh/.zshrc", h.clock() + 1);
    const spawn = h.environment.beforeSpawn();
    await h.answer(dump({ PATH: "/shell/bin", ZDOTDIR: "/home/t/.config/zsh", A: "2" }));
    expect(await spawn).toBe(2);
    expect(h.calls).toHaveLength(2);
    expect(h.target.A).toBe("2");
    // That read covers the edit: the next spawn reads nothing.
    expect(await h.environment.beforeSpawn()).toBe(2);
    expect(h.calls).toHaveLength(2);
  });

  it("does not read when every startup file is older than the last read", async () => {
    const h = harness();
    h.mtimes.set("/home/t/.zshrc", 1);
    await settle(h);
    expect(await h.environment.beforeSpawn()).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect([...h.statted].sort()).toEqual([
      "/home/t/.config/zsh/.zlogin",
      "/home/t/.config/zsh/.zprofile",
      "/home/t/.config/zsh/.zshenv",
      "/home/t/.config/zsh/.zshrc",
      "/home/t/.zlogin",
      "/home/t/.zprofile",
      "/home/t/.zshenv",
      "/home/t/.zshrc",
    ]);
  });

  it("watches bash's own files for bash", async () => {
    const h = harness({ shell: "/bin/bash" });
    await settle(h);
    h.mtimes.set("/home/t/.bashrc", h.clock() + 1);
    const spawn = h.environment.beforeSpawn();
    await h.answer({ kind: "timeout" });
    // A failed read keeps generation 1, and is the read the edit is measured against.
    expect(await spawn).toBe(1);
    expect(await h.environment.beforeSpawn()).toBe(1);
    expect(h.calls).toHaveLength(2);
    expect(h.statted).toContain("/home/t/.bash_profile");
    expect(h.statted).toContain("/home/t/.profile");
  });
});

describe("what leaves the module", () => {
  const SECRET = "sk-ant-api03-SECRETVALUE-do-not-ship";

  it("never carries a value: not in the change, the status, or the log", async () => {
    const lines: string[] = [];
    const h = harness();
    const environment = makeShellEnvironment({
      runTool: async () => dump({ PATH: `/shell/bin`, ANTHROPIC_API_KEY: SECRET }),
      target: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-old-secret" },
      home: () => "/home/t",
      now: () => 1,
      shell: () => "/bin/zsh",
      turnedOff: () => false,
      cwd: async () => "/app",
      mtimeMs: async () => undefined,
      log: (line) => lines.push(line),
      warn: (line) => lines.push(line),
    });
    const changes: ShellEnvironmentChange[] = [];
    environment.onChange((change) => changes.push(change));
    await environment.ensure();
    const surfaced = JSON.stringify([changes, await environment.status(), lines]);
    expect(changes[0]?.changed).toEqual(["ANTHROPIC_API_KEY"]);
    expect(surfaced).not.toContain(SECRET);
    expect(surfaced).not.toContain("sk-old-secret");
    expect(h.calls).toHaveLength(0);
  });

  it("speaks the wire schemas", async () => {
    const h = harness();
    const ensured = h.environment.ensure();
    await h.answer(dump({ PATH: "/shell/bin:/usr/bin", A: "1" }));
    await ensured;
    expect(decodeShellEnvironmentStatus(await h.environment.status())).toMatchObject({
      _tag: "Resolved",
      pathAdded: ["/shell/bin"],
    });
    expect(() => decodeShellEnvironmentChange(h.changes[0])).not.toThrow();
    const refreshed = h.environment.refresh("operator");
    await h.answer({ kind: "failed", why: "output-limit" });
    expect(decodeShellEnvironmentStatus(await refreshed)).toMatchObject({
      _tag: "Failed",
      cause: { _tag: "OutputTooLarge", maxBytes: 1024 * 1024 },
    });
  });
});
