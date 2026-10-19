// @vitest-environment jsdom
/**
 * The onboarding's shell step: what it says for each status main reports,
 * that opening it asks status() (main's ensure) and Reload asks refresh()
 * and then the harnesses again, and that no variable value ever reaches it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellEnvironmentChange, ShellEnvironmentStatus } from "../src/shared/shell-environment";
import {
  RESOLVING_ESCAPE,
  changeSummary,
  escapeSnippet,
  failureWords,
  readShellStep,
  reloadShellStep,
  shellName,
  shellStepView,
} from "../src/renderer/lib/shell-environment-view";
import { ShellEnvironmentPanel } from "../src/renderer/components/onboarding/tour-shell";

const SECRET = "sk-ant-api03-DO-NOT-SHOW-1234567890";

const resolved = (extra: Partial<Extract<ShellEnvironmentStatus, { _tag: "Resolved" }>> = {}): ShellEnvironmentStatus => ({
  _tag: "Resolved",
  shell: "/bin/zsh",
  resolvedAt: 1_000,
  durationMs: 420,
  variableCount: 61,
  generation: 1,
  pathAdded: ["/opt/homebrew/bin", "/Users/op/.bun/bin"],
  ...extra,
});

const failed = (cause: Extract<ShellEnvironmentStatus, { _tag: "Failed" }>["cause"], usingPrevious = false): ShellEnvironmentStatus => ({
  _tag: "Failed",
  shell: "/bin/zsh",
  at: 1_000,
  cause,
  generation: 0,
  usingPrevious,
});

const harnesses = (found: ReadonlyArray<string>, missing: ReadonlyArray<string> = []) => ({
  harnesses: [
    ...found.map((displayName) => ({ harness: displayName.toLowerCase(), displayName, binary: displayName, installed: true })),
    ...missing.map((displayName) => ({ harness: displayName.toLowerCase(), displayName, binary: displayName, installed: false })),
  ],
}) as never;

describe("what the step says", () => {
  it("resolved: the shell, the time, the variable count and the PATH directories added", () => {
    const view = shellStepView(resolved());
    expect(view.tone).toBe("resolved");
    expect(view.headline).toBe("Junto read your zsh environment");
    expect(view.facts).toEqual(["zsh", "read in 420 ms", "61 variables"]);
    expect(view.pathAdded).toEqual(["/opt/homebrew/bin", "/Users/op/.bun/bin"]);
    expect(view.escape).toBe(false);
    expect(shellStepView(resolved({ durationMs: 2_500 })).facts).toContain("read in 2.5 s");
    expect(shellName("/usr/local/bin/bash")).toBe("bash");
  });

  it("failed: the cause in plain words, what seats use meanwhile, and the escape for heavy rc work", () => {
    const timedOut = shellStepView(failed({ _tag: "TimedOut", timeoutMs: 10_000 }));
    expect(timedOut.tone).toBe("failed");
    expect(timedOut.cause).toBe("Your shell took longer than 10 s to start. That is usually heavy work in an rc file.");
    expect(timedOut.fallback).toBe("Seats start with the PATH Junto itself was started with.");
    expect(timedOut.escape).toBe(true);

    const broken = shellStepView(failed({ _tag: "Exited", code: 1 }, true));
    expect(broken.cause).toBe("Your shell exited with code 1 before it printed its environment. An rc file likely stopped on an error.");
    expect(broken.fallback).toBe("Seats keep the environment Junto read before.");
    // An rc that stopped on an error is not heavy work: the escape would not help.
    expect(broken.escape).toBe(false);
    expect(shellStepView(failed({ _tag: "OutputTooLarge", maxBytes: 1024 })).escape).toBe(true);

    // No shell, or one that cannot start: an rc escape would not help.
    expect(shellStepView(failed({ _tag: "NoShell" })).escape).toBe(false);
    expect(shellStepView(failed({ _tag: "SpawnFailed", errno: "ENOENT" })).cause).toBe("Your shell could not start (ENOENT).");
    expect(failureWords({ _tag: "Exited", signal: "SIGKILL" })).toContain("exited on SIGKILL");
    expect(failureWords({ _tag: "NoEnvironment" })).toContain("could not read the environment");
    expect(failureWords({ _tag: "OutputTooLarge", maxBytes: 4 * 1024 * 1024 })).toContain("4096 KB");
  });

  it("the escape is written in the shell's own syntax", () => {
    expect(escapeSnippet("/bin/zsh")).toBe(`if [ -z "$${RESOLVING_ESCAPE}" ]; then\n  # heavy work: version managers, completions\nfi`);
    expect(escapeSnippet(undefined)).toContain("fi");
    expect(escapeSnippet("/opt/homebrew/bin/fish")).toBe(`if test -z "$${RESOLVING_ESCAPE}"\n  # heavy work: version managers, completions\nend`);
  });

  it("reading and inherited never show a value", () => {
    expect(shellStepView({ _tag: "Resolving", since: 5, generation: 1 }).headline).toBe("Reading your shell");
    const inherited = shellStepView({ _tag: "Inherited" });
    expect(inherited.headline).toBe("Junto uses the environment it was started with");
    expect(JSON.stringify(inherited)).not.toContain("=");
  });

  it("a reload's change is counted, never listed or valued", () => {
    const change: ShellEnvironmentChange = {
      generation: 2,
      added: ["ANTHROPIC_API_KEY"],
      removed: [],
      changed: ["PATH", "NODE_OPTIONS"],
      pathAdded: ["/opt/homebrew/bin"],
      pathRemoved: [],
    };
    expect(changeSummary(change)).toBe("3 variables changed, 1 PATH directory added.");
    expect(changeSummary(change)).not.toContain("ANTHROPIC_API_KEY");
    expect(changeSummary(undefined)).toBe("Nothing changed since the last read.");
  });
});

describe("opening and reloading", () => {
  it("opening asks status (main's ensure) and the harnesses that PATH finds", async () => {
    const api = {
      shellEnvironment: { status: vi.fn(async () => resolved()), refresh: vi.fn(), onChange: vi.fn() },
      managedTerminalHarnesses: vi.fn(async () => harnesses(["Claude Code", "Codex"], ["Grok"])),
    };
    const read = await readShellStep(api as never);
    expect(api.shellEnvironment.status).toHaveBeenCalledTimes(1);
    expect(api.shellEnvironment.refresh).not.toHaveBeenCalled();
    expect(read?.found).toEqual(["Claude Code", "Codex"]);
    expect(read?.missing).toEqual(["Grok"]);
  });

  it("reload re-reads the shell, then asks the harnesses again", async () => {
    const order: string[] = [];
    const api = {
      shellEnvironment: {
        status: vi.fn(),
        refresh: vi.fn(async () => (order.push("refresh"), failed({ _tag: "TimedOut", timeoutMs: 10_000 }, true))),
        onChange: vi.fn(),
      },
      managedTerminalHarnesses: vi.fn(async () => (order.push("harnesses"), harnesses(["Codex"]))),
    };
    const read = await reloadShellStep(api as never);
    expect(order).toEqual(["refresh", "harnesses"]);
    expect(read?.status._tag).toBe("Failed");
  });

  it("with no shell environment bridge there is nothing to read, and no crash", async () => {
    expect(await readShellStep({})).toBeUndefined();
    expect(await reloadShellStep({})).toBeUndefined();
  });
});

describe("the panel", () => {
  let root: Root;
  let host: HTMLDivElement;
  let emit: ((change: ShellEnvironmentChange) => void) | undefined;

  const mount = async (status: ShellEnvironmentStatus, refreshTo: ShellEnvironmentStatus = status) => {
    const api = {
      shellEnvironment: {
        status: vi.fn(async () => status),
        refresh: vi.fn(async () => {
          emit?.({ generation: 2, added: ["SECRET_TOKEN"], removed: [], changed: [], pathAdded: ["/opt/new/bin"], pathRemoved: [] });
          return refreshTo;
        }),
        onChange: vi.fn((listener: (change: ShellEnvironmentChange) => void) => {
          emit = listener;
          return () => (emit = undefined);
        }),
      },
      managedTerminalHarnesses: vi.fn(async () => harnesses(["Claude Code"], ["Grok"])),
    };
    vi.stubGlobal("junto", api);
    await act(async () => root.render(<ShellEnvironmentPanel />));
    return api;
  };
  const panel = (): HTMLElement => host.querySelector("[data-testid='shell-environment-step']")!;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("shows what Junto read, and Reload redraws it with the harnesses asked again", async () => {
    const api = await mount(resolved(), resolved({ generation: 2, pathAdded: ["/opt/homebrew/bin", "/opt/new/bin"] }));
    expect(panel().dataset.tone).toBe("resolved");
    expect(panel().textContent).toContain("Junto read your zsh environment");
    expect(panel().textContent).toContain("/opt/homebrew/bin");
    expect(panel().textContent).toContain("Claude Code");
    expect(panel().textContent).toContain("Not found: Grok");

    await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='shell-environment-reload']")!.click());
    expect(api.shellEnvironment.refresh).toHaveBeenCalledTimes(1);
    expect(api.managedTerminalHarnesses).toHaveBeenCalledTimes(2);
    expect(panel().textContent).toContain("/opt/new/bin");
    expect(panel().textContent).toContain("1 variable changed, 1 PATH directory added.");
    expect(panel().textContent).not.toContain("SECRET_TOKEN");
  });

  it("a failed read explains itself and offers the escape; it never blocks anything", async () => {
    await mount(failed({ _tag: "TimedOut", timeoutMs: 10_000 }));
    expect(panel().dataset.tone).toBe("failed");
    expect(panel().textContent).toContain("took longer than 10 s");
    expect(panel().textContent).toContain(`${RESOLVING_ESCAPE}=1`);
    expect(host.querySelector<HTMLButtonElement>("[data-testid='shell-environment-reload']")!.disabled).toBe(false);
  });

  it("a first read that fails says so in one sentence, and Reload can still retry", async () => {
    vi.stubGlobal("junto", {
      shellEnvironment: {
        status: vi.fn(async () => ({ _tag: "Resolved", shell: 7 })),
        refresh: vi.fn(async () => resolved()),
        onChange: vi.fn(() => () => undefined),
      },
      managedTerminalHarnesses: vi.fn(async () => harnesses(["Codex"])),
    });
    await act(async () => root.render(<ShellEnvironmentPanel />));
    expect(panel().textContent).toContain("Junto could not read the shell status.");
    expect(panel().textContent).not.toContain("Expected");
    const reload = host.querySelector<HTMLButtonElement>("[data-testid='shell-environment-reload']")!;
    expect(reload.disabled).toBe(false);
    await act(async () => reload.click());
    expect(panel().dataset.tone).toBe("resolved");
  });

  it("with no shell environment bridge it says so instead of reading for good", async () => {
    vi.stubGlobal("junto", { managedTerminalHarnesses: vi.fn() });
    await act(async () => root.render(<ShellEnvironmentPanel />));
    expect(panel().textContent).toContain("This build cannot show what Junto read from your shell");
    expect(host.querySelector<HTMLButtonElement>("[data-testid='shell-environment-reload']")!.disabled).toBe(true);
  });

  it("no value reaches the panel, even when main's answer carries a secret-shaped name", async () => {
    await mount(resolved({ pathAdded: ["/opt/homebrew/bin"] }));
    await act(async () => emit?.({ generation: 3, added: [SECRET], removed: [], changed: [], pathAdded: [], pathRemoved: [] }));
    expect(host.innerHTML).not.toContain(SECRET);
  });
});
