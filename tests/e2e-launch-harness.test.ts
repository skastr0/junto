import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupVellumHarness,
  observeElectronApplicationClose,
  type HarnessCleanupOperations,
  type HarnessCleanupTimeouts,
} from "../e2e/harness/launch";
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
  root: "/tmp/vellum-command-e2e-harness-test",
  userDataDir: "/tmp/vellum-command-e2e-harness-test/user-data",
  canvasesDir: "/tmp/vellum-command-e2e-harness-test/canvases",
  homeDir: "/tmp/vellum-command-e2e-harness-test/home",
};

const shortTimeouts: HarnessCleanupTimeouts = {
  applicationCloseMs: 10,
  rendererServerCloseMs: 10,
};

const makeOperations = (
  order: string[],
  overrides: Partial<HarnessCleanupOperations> = {},
): HarnessCleanupOperations => ({
  shutdownHerdr: async () => {
    order.push("herdr.shutdown");
  },
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

describe("Vellum Command e2e harness cleanup", () => {
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

    await cleanupVellumHarness(
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
      "herdr.shutdown",
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

    const error = await cleanupVellumHarness(
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
      "herdr.shutdown",
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

    const error = await cleanupVellumHarness(
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
    expect(order).toEqual(["app.close", "server.close", "herdr.shutdown"]);
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

      const error = await cleanupVellumHarness(
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

    const error = await cleanupVellumHarness(
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
      "herdr.shutdown",
      "sandbox.destroy",
      "sandbox.exists",
    ]);
  });

  it("preserves the sandbox when Electron launch returned no observable handle", async () => {
    const order: string[] = [];
    const destroySandbox = vi.fn(async () => {
      order.push("sandbox.destroy");
    });

    const error = await cleanupVellumHarness(
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
    expect(order).toEqual(["server.close", "herdr.shutdown"]);
    expect(destroySandbox).not.toHaveBeenCalled();
  });

  it("bounds a stuck renderer close without skipping herdr or safe sandbox cleanup", async () => {
    const order: string[] = [];
    const app = new FakeElectronApplication();
    app.closeImplementation = async () => {
      order.push("app.close");
      app.terminate();
    };

    const error = await cleanupVellumHarness(
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
      "herdr.shutdown",
      "sandbox.destroy",
      "sandbox.exists",
    ]);
  });
});
