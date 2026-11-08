import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupJuntoHarness,
  observeElectronApplicationClose,
  type HarnessCleanupOperations,
  type HarnessCleanupTimeouts,
} from "../e2e/harness/launch";
import { inheritedEnvForLaunch, launchEnvironment } from "../e2e/harness/launch-env";
import type { RendererServer } from "../e2e/harness/renderer-server";
import type { Sandbox } from "../e2e/harness/sandbox";

class FakeElectronProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  terminate(exitCode = 0): void {
    this.exitCode = exitCode;
    this.emit("exit", exitCode, null);
  }
}

class FakeElectronApplication extends EventEmitter {
  readonly child = new FakeElectronProcess();
  closeImplementation: () => Promise<void> = async () => undefined;

  close(): Promise<void> {
    return this.closeImplementation();
  }

  process(): FakeElectronProcess {
    return this.child;
  }

  terminate(): void {
    this.child.terminate();
    this.emit("close");
  }

  closeApplicationOnly(): void {
    this.emit("close");
  }

  terminateProcessOnly(): void {
    this.child.terminate();
  }
}

const sandbox: Sandbox = {
  root: "/tmp/junto-e2e-harness-test",
  userDataDir: "/tmp/junto-e2e-harness-test/user-data",
  homeDir: "/tmp/junto-e2e-harness-test/home",
};

const shortTimeouts: HarnessCleanupTimeouts = {
  applicationCloseMs: 10,
  rendererServerCloseMs: 10,
};

const makeOperations = (
  order: string[],
  overrides: Partial<HarnessCleanupOperations> = {},
): HarnessCleanupOperations => ({
  destroySandbox: async () => {
    order.push("sandbox.destroy");
  },
  sandboxExists: async () => {
    order.push("sandbox.exists");
    return false;
  },
  ...overrides,
});

const makeServer = (
  order: string[],
  close: () => Promise<void> = async () => undefined,
): RendererServer => ({
  url: "http://127.0.0.1:1234/",
  close: async () => {
    order.push("server.close");
    await close();
  },
});

const aggregateMessages = (error: unknown): readonly string[] => {
  expect(error).toBeInstanceOf(AggregateError);
  return (error as AggregateError).errors.map((entry: unknown) =>
    entry instanceof Error ? entry.message : String(entry),
  );
};

describe("Junto e2e harness cleanup", () => {
  it("keeps teardown free of bare pid discovery, process signalling, and suppressed close failures", async () => {
    const source = await readFile(
      new URL("../e2e/harness/launch.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/\bprocess\.kill\s*\(/u);
    expect(source).not.toMatch(/\.kill\s*\(/u);
    expect(source).not.toMatch(/\.pid\b/u);
    expect(source).not.toMatch(/\.close\(\)\.catch\(\(\)\s*=>\s*undefined\)/u);
  });

  it("requires both exact Electron witnesses before ordered sandbox removal", async () => {
    const order: string[] = [];
    const app = new FakeElectronApplication();
    app.closeImplementation = async () => {
      order.push("app.close");
      app.terminate();
    };

    await cleanupJuntoHarness(
      {
        sandbox,
        server: makeServer(order),
        application: {
          kind: "observed",
          witness: observeElectronApplicationClose(app),
        },
      },
      makeOperations(order),
      shortTimeouts,
    );

    expect(order).toEqual([
      "app.close",
      "server.close",
      "sandbox.destroy",
      "sandbox.exists",
    ]);
  });

  it("reports close failures while continuing later safe cleanup", async () => {
    const order: string[] = [];
    const app = new FakeElectronApplication();
    app.closeImplementation = async () => {
      order.push("app.close");
      app.terminate();
      throw new Error("Playwright transport rejected close");
    };
    const server = makeServer(order, async () => {
      throw new Error("renderer socket refused close");
    });

    const error = await cleanupJuntoHarness(
      {
        sandbox,
        server,
        application: {
          kind: "observed",
          witness: observeElectronApplicationClose(app),
        },
      },
      makeOperations(order),
      shortTimeouts,
    ).catch((failure: unknown) => failure);

    expect(aggregateMessages(error)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Playwright transport rejected close"),
        expect.stringContaining("renderer socket refused close"),
      ]),
    );
    expect(order).toEqual([
      "app.close",
      "server.close",
      "sandbox.destroy",
      "sandbox.exists",
    ]);
  });

  it("preserves the diagnostic sandbox when Playwright cannot prove termination", async () => {
    const order: string[] = [];
    const app = new FakeElectronApplication();
    app.closeImplementation = async () => {
      order.push("app.close");
      // Deliberately omit both terminal events.
    };
    const destroySandbox = vi.fn(async () => {
      order.push("sandbox.destroy");
    });

    const error = await cleanupJuntoHarness(
      {
        sandbox,
        server: makeServer(order),
        application: {
          kind: "observed",
          witness: observeElectronApplicationClose(app),
        },
      },
      makeOperations(order, { destroySandbox }),
      shortTimeouts,
    ).catch((failure: unknown) => failure);

    expect(aggregateMessages(error)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("terminal witness failed: timed out"),
        expect.stringContaining(`sandbox preserved at ${sandbox.root}`),
      ]),
    );
    expect((error as AggregateError).message).toContain(
      `sandbox preserved at ${sandbox.root}`,
    );
    expect(order).toEqual(["app.close", "server.close"]);
    expect(destroySandbox).not.toHaveBeenCalled();
  });

  it.each(["application-close", "process-exit"] as const)(
    "preserves the sandbox when only the %s witness arrives",
    async (terminalEvent) => {
      const order: string[] = [];
      const app = new FakeElectronApplication();
      app.closeImplementation = async () => {
        order.push("app.close");
        if (terminalEvent === "application-close") app.closeApplicationOnly();
        else app.terminateProcessOnly();
      };
      const destroySandbox = vi.fn(async () => {
        order.push("sandbox.destroy");
      });

      const error = await cleanupJuntoHarness(
        {
          sandbox,
          server: makeServer(order),
          application: {
            kind: "observed",
            witness: observeElectronApplicationClose(app),
          },
        },
        makeOperations(order, { destroySandbox }),
        shortTimeouts,
      ).catch((failure: unknown) => failure);

      expect(aggregateMessages(error)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("terminal witness failed: timed out"),
          expect.stringContaining(`sandbox preserved at ${sandbox.root}`),
        ]),
      );
      expect(destroySandbox).not.toHaveBeenCalled();
    },
  );

  it("bounds a stuck Electron close while honoring exact terminal witnesses", async () => {
    const order: string[] = [];
    const app = new FakeElectronApplication();
    app.closeImplementation = () => {
      order.push("app.close");
      app.terminate();
      return new Promise<void>(() => undefined);
    };

    const error = await cleanupJuntoHarness(
      {
        sandbox,
        server: makeServer(order),
        application: {
          kind: "observed",
          witness: observeElectronApplicationClose(app),
        },
      },
      makeOperations(order),
      shortTimeouts,
    ).catch((failure: unknown) => failure);

    expect(aggregateMessages(error)).toContain(
      "ElectronApplication.close failed: timed out after 10ms",
    );
    expect(order).toEqual([
      "app.close",
      "server.close",
      "sandbox.destroy",
      "sandbox.exists",
    ]);
  });

  it("preserves the sandbox when Electron launch returned no observable handle", async () => {
    const order: string[] = [];
    const destroySandbox = vi.fn(async () => {
      order.push("sandbox.destroy");
    });

    const error = await cleanupJuntoHarness(
      {
        sandbox,
        server: makeServer(order),
        application: { kind: "launch-unobserved" },
      },
      makeOperations(order, { destroySandbox }),
      shortTimeouts,
    ).catch((failure: unknown) => failure);

    expect(aggregateMessages(error)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Electron launch returned no application handle"),
        expect.stringContaining(`sandbox preserved at ${sandbox.root}`),
      ]),
    );
    expect((error as AggregateError).message).toContain(
      `sandbox preserved at ${sandbox.root}`,
    );
    expect(order).toEqual(["server.close"]);
    expect(destroySandbox).not.toHaveBeenCalled();
  });

  it("bounds a stuck renderer close without skipping safe sandbox cleanup", async () => {
    const order: string[] = [];
    const app = new FakeElectronApplication();
    app.closeImplementation = async () => {
      order.push("app.close");
      app.terminate();
    };

    const error = await cleanupJuntoHarness(
      {
        sandbox,
        server: makeServer(order, () => new Promise<void>(() => undefined)),
        application: {
          kind: "observed",
          witness: observeElectronApplicationClose(app),
        },
      },
      makeOperations(order),
      shortTimeouts,
    ).catch((failure: unknown) => failure);

    expect(aggregateMessages(error)).toContain(
      "renderer server close failed: timed out after 10ms",
    );
    expect(order).toEqual([
      "app.close",
      "server.close",
      "sandbox.destroy",
      "sandbox.exists",
    ]);
  });
});

describe("launch environment isolation", () => {
  it("drops every inherited JUNTO_ variable, known today or added later", () => {
    const env = launchEnvironment({
      inherited: {
        PATH: "/operator/bin:/usr/bin",
        HOME: "/Users/operator",
        LANG: "en_US.UTF-8",
        // The seat this run is executed from. None of these may reach an app.
        JUNTO_HOME: "/Users/operator/.junto",
        JUNTO_WORK_TOKEN: "seat-credential",
        JUNTO_WORK_HOME: "/Users/operator/.junto/work",
        JUNTO_CLI: "/usr/local/bin/junto",
        JUNTO_NODE_REF: "junto://canvas/factory?node=agent-1",
        // Not a key anyone lists today: the prefix is the rule.
        JUNTO_SOMETHING_ADDED_NEXT_MONTH: "1",
      },
      home: "/tmp/e2e-home",
      tempRoot: "/tmp/e2e-root",
      rendererUrl: "http://127.0.0.1:5199/",
      path: "/repo/e2e/fakes/bin:/usr/bin:/bin",
    });

    expect(Object.keys(env).filter((key) => key.startsWith("JUNTO_")).sort()).toEqual([
      "JUNTO_E2E",
      "JUNTO_SECRET_STORE",
    ]);
    expect(env.JUNTO_E2E).toBe("1");
    expect(env.JUNTO_SECRET_STORE).toBe("file");
    expect(env.JUNTO_HOME).toBeUndefined();
    expect(env.JUNTO_WORK_TOKEN).toBeUndefined();
    expect(env.JUNTO_CLI).toBeUndefined();
    expect(env.JUNTO_SOMETHING_ADDED_NEXT_MONTH).toBeUndefined();
    // The launch's own roots, never the operator's.
    expect(env.HOME).toBe("/tmp/e2e-home");
    expect(env.TMPDIR).toBe("/tmp/e2e-root");
    expect(env.TMP).toBe("/tmp/e2e-root");
    expect(env.TEMP).toBe("/tmp/e2e-root");
    expect(env.SHELL).toBe("/bin/sh");
    expect(env.PATH).toBe("/repo/e2e/fakes/bin:/usr/bin:/bin");
    expect(env.ELECTRON_RENDERER_URL).toBe("http://127.0.0.1:5199");
  });

  it("passes JUNTO_E2E_SHOW=1 through by name, the operator's ask for visible windows", () => {
    const base = { home: "/tmp/e2e-home", tempRoot: "/tmp/e2e-root", rendererUrl: "http://127.0.0.1:5199", path: "/fakes/bin" };
    expect(launchEnvironment({ ...base, inherited: { JUNTO_E2E_SHOW: "1" } }).JUNTO_E2E_SHOW).toBe("1");
    expect(launchEnvironment({ ...base, inherited: { JUNTO_E2E_SHOW: "yes" } }).JUNTO_E2E_SHOW).toBeUndefined();
    expect(launchEnvironment({ ...base, inherited: {} }).JUNTO_E2E_SHOW).toBeUndefined();
  });

  it("lets a spec's own extraEnv win last, and still never an inherited JUNTO_ key", () => {
    const env = launchEnvironment({
      inherited: { JUNTO_HOME: "/Users/operator/.junto", PATH: "/operator/bin" },
      home: "/tmp/e2e-home",
      tempRoot: "/tmp/e2e-root",
      rendererUrl: "http://127.0.0.1:5199",
      path: "/fakes/bin",
      extraEnv: { PATH: "/spec/bin", JUNTO_DEMO: "1" },
    });
    expect(env.PATH).toBe("/spec/bin");
    expect(env.JUNTO_DEMO).toBe("1");
    expect(env.JUNTO_HOME).toBeUndefined();
  });

  it("keeps a demo launch marked and an ordinary launch unmarked", () => {
    const base = {
      inherited: {},
      home: "/tmp/h",
      tempRoot: "/tmp/r",
      rendererUrl: "http://127.0.0.1:1",
      path: "/fakes/bin",
    } as const;
    expect(inheritedEnvForLaunch({ JUNTO_SEAT: "s", KEEP: "1" })).toEqual({ KEEP: "1" });
    expect(launchEnvironment({ ...base, demo: true }).JUNTO_DEMO).toBe("1");
    expect(launchEnvironment(base).JUNTO_DEMO).toBeUndefined();
  });
});

describe("every e2e launch of the app filters the inherited environment", () => {
  const E2E = join(import.meta.dirname, "..", "e2e");

  const files = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const full = join(directory, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.(ts|tsx)$/u.test(name) ? [full] : [];
    });

  /** Whitespace out, so formatting cannot hide a raw spread. */
  const compact = (text: string): string => text.replace(/\s+/gu, "");

  const launchers = files(E2E).filter((file) => compact(readFileSync(file, "utf8")).includes("electron.launch("));

  it("finds the launch sites (a guard against the guard passing on an empty set)", () => {
    expect(launchers.length).toBeGreaterThan(0);
  });

  it("never spreads process.env into a launched app, cast or not", () => {
    const offending = launchers.filter((file) => {
      const text = compact(readFileSync(file, "utf8"));
      return text.includes("...process.env") || text.includes("...(process.env");
    });
    expect(offending).toEqual([]);
  });

  it("builds every launch env through the harness filter, or from the launched app's own env", () => {
    // Three accepted shapes, each named in the file it uses:
    //   - the harness filter on this process's env (a raw launch, or launchJunto);
    //   - an env read out of the first app the harness launched, which is already
    //     filtered, for a relaunch that must match the app it replaces.
    const unfiltered = launchers.filter((file) => {
      const text = compact(readFileSync(file, "utf8"));
      const harnessFilter = text.includes("inheritedEnvForLaunch(process.env)") || text.includes("launchEnvironment(");
      const appOwnEnv = (text.includes("mainEnvOf(") || text.includes(".app.evaluate(") || text.includes(".evaluate(()=>"))
        && text.includes("Object.entries(process.env)");
      return !harnessFilter && !appOwnEnv;
    });
    expect(unfiltered).toEqual([]);
  });
});

describe("every e2e companion CLI launch filters the seat's identity", () => {
  const E2E = join(import.meta.dirname, "..", "e2e");
  const files = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const full = join(directory, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.(ts|tsx)$/u.test(name) ? [full] : [];
    });
  const compact = (text: string): string => text.replace(/\s+/gu, "");

  it("drops every JUNTO_ variable from a spawned companion, or says why it keeps the seat's", () => {
    // The companion is a phone, not a seat. Seat spawns (crew-fixture,
    // browser-seat-probe) carry the seat credential on purpose and live in
    // e2e/harness; this rule is for scenario files that start the phone.
    // A spec that starts the phone spawns its CLI directly. The guard asks for
    // one at least, so it cannot pass on an empty set.
    const phones = files(join(E2E, "scenarios"))
      .filter((file) => compact(readFileSync(file, "utf8")).includes("src/cli/main.ts"));
    expect(phones.length).toBeGreaterThan(0);
    const leaking = phones.filter((file) => {
      const text = compact(readFileSync(file, "utf8"));
      const filters = text.includes("inheritedEnvForLaunch(process.env)")
        || text.includes('key.startsWith("JUNTO_")');
      return !filters;
    });
    expect(leaking).toEqual([]);
  });
});
