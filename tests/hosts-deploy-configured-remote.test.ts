import { Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { remoteStationSettingsFromScratch } from "../src/shared/remote-station-config";
import {
  deployConfiguredRemoteHost,
  type ConfiguredRemoteDeployOperations,
} from "../src/main/vellum/hosts/deploy-configured-remote";
import {
  captureRemoteSettingsSnapshot,
  restoreRemoteSettingsSnapshot,
  stampRemoteSettingsSnapshot,
} from "../src/main/vellum/hosts/remote-settings-transaction";

const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  endpoint: "studio-box",
  capabilities: ["herdr", "hermes"],
};

type Ssh = Parameters<typeof deployConfiguredRemoteHost>[0];

const presentSnapshot = (body: string, mode = "600"): string => {
  const bytes = Buffer.from(body, "utf8");
  return `PRESENT ${mode} ${bytes.byteLength}\n${bytes.toString("base64")}\n`;
};

const configuredSettingsBody = `${JSON.stringify(
  remoteStationSettingsFromScratch({
    remoteHostId: "studio",
    commandCenterRef: "local",
  }),
  null,
  2,
)}\n`;

const makeSsh = (
  responses: ReadonlyArray<
    | { readonly stdout: string }
    | { readonly error: { readonly _tag: string; readonly [key: string]: unknown } }
  >,
): { readonly ssh: Ssh; readonly calls: { count: number } } => {
  const calls = { count: 0 };
  const ssh = {
    run: () => {
      const response = responses[calls.count];
      calls.count += 1;
      if (!response) return Effect.die(new Error("unexpected SSH call"));
      if ("error" in response) return Effect.fail(response.error as never);
      return Effect.succeed({ stdout: response.stdout, stderr: "" });
    },
  } as unknown as Ssh;
  return { ssh, calls };
};

const operations = (input: {
  readonly deploy: ConfiguredRemoteDeployOperations["deploy"];
  readonly stamp?: ConfiguredRemoteDeployOperations["stamp"];
}): ConfiguredRemoteDeployOperations => ({
  capture: captureRemoteSettingsSnapshot,
  restore: restoreRemoteSettingsSnapshot,
  stamp: input.stamp ?? stampRemoteSettingsSnapshot,
  deploy: input.deploy,
});

describe("configured Remote deploy transaction", () => {
  it("CAS-stamps before launch and gates readiness on a final exact snapshot", async () => {
    const { ssh, calls } = makeSsh([
      { stdout: "/Users/remote\n" },
      { stdout: "ABSENT\n" },
      { stdout: "STAMPED\n" },
      { stdout: "/Users/remote\n" },
      { stdout: presentSnapshot(configuredSettingsBody) },
    ]);
    const stamp = vi.fn(stampRemoteSettingsSnapshot);
    const deploy = vi.fn(() =>
      Effect.succeed({
        ok: true,
        detail: "station ready",
        stages: ["ready"],
        disposition: "ready" as const,
        version: "0.1.0",
      }),
    );

    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        ssh,
        host,
        { commandCenterRef: "local" },
        operations({ stamp, deploy }),
      ),
    );

    expect(stamp).toHaveBeenCalledWith(
      ssh,
      host,
      expect.any(Object),
      expect.objectContaining({
        remoteHostId: "studio",
        commandCenterRef: "local",
        supervisedPreferred: true,
      }),
    );
    expect(deploy).toHaveBeenCalledOnce();
    expect(calls.count).toBe(5);
    expect(result).toMatchObject({
      ok: true,
      hostEndpoint: "studio-box",
      outcome: "ready",
      packageState: "present",
      role: "remote",
      version: "0.1.0",
      rollback: "not-required",
      configuration: { ok: true },
    });
    expect(result.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("restores the exact previous settings after a proven package rollback", async () => {
    const previousBody = '{"station":{"role":"command-center"}}\n';
    const { ssh, calls } = makeSsh([
      { stdout: "/Users/remote\n" },
      { stdout: presentSnapshot(previousBody, "640") },
      { stdout: "STAMPED\n" },
      { stdout: "RESTORED\n" },
    ]);

    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        ssh,
        host,
        { commandCenterRef: "local" },
        operations({
          deploy: () =>
            Effect.succeed({
              ok: false,
              detail: "new generation failed; app rollback proven",
              code: "io" as const,
              stages: ["transfer"],
              disposition: "rolled-back" as const,
              version: "0.1.0",
            }),
        }),
      ),
    );

    expect(calls.count).toBe(4);
    expect(result).toMatchObject({
      ok: false,
      outcome: "rolled-back",
      packageState: "previous",
      role: "previous",
      rollback: "restored",
    });
    expect(result.version).toBeUndefined();
    expect(result.detail).toMatch(/prior Remote settings restored/u);
  });

  it("returns indeterminate when conditional settings compensation is refused", async () => {
    const { ssh } = makeSsh([
      { stdout: "/Users/remote\n" },
      { stdout: "ABSENT\n" },
      { stdout: "STAMPED\n" },
      {
        error: {
          _tag: "SshExitError",
          endpoint: "studio-box",
          operation: "settings-rollback",
          code: 24,
        },
      },
    ]);

    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        ssh,
        host,
        { commandCenterRef: "local" },
        operations({
          deploy: () =>
            Effect.succeed({
              ok: false,
              detail: "launch failed",
              code: "io" as const,
              stages: [],
              disposition: "rolled-back" as const,
            }),
        }),
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      outcome: "indeterminate",
      packageState: "previous",
      role: "unknown",
      rollback: "failed",
      code: "conflict",
    });
    expect(result.detail).toMatch(/Inspect the host before retrying/u);
  });

  it("does not launch or overwrite when the settings preimage changes before stamp", async () => {
    const { ssh, calls } = makeSsh([
      { stdout: "/Users/remote\n" },
      { stdout: "ABSENT\n" },
      {
        error: {
          _tag: "SshExitError",
          endpoint: "studio-box",
          operation: "settings-stamp",
          code: 34,
        },
      },
      { stdout: "/Users/remote\n" },
      { stdout: presentSnapshot('{"external":"edit"}\n') },
    ]);
    const deploy = vi.fn(() =>
      Effect.succeed({ ok: true, detail: "should not run", stages: [] }),
    );

    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        ssh,
        host,
        { commandCenterRef: "local" },
        operations({ deploy }),
      ),
    );

    expect(deploy).not.toHaveBeenCalled();
    expect(calls.count).toBe(5);
    expect(result).toMatchObject({
      ok: false,
      outcome: "indeterminate",
      packageState: "previous",
      role: "unknown",
      rollback: "failed",
      code: "conflict",
    });
  });

  it("retains the stamp when a returned result cannot prove package rollback", async () => {
    const { ssh, calls } = makeSsh([
      { stdout: "/Users/remote\n" },
      { stdout: "ABSENT\n" },
      { stdout: "STAMPED\n" },
    ]);
    const restore = vi.fn(restoreRemoteSettingsSnapshot);

    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        ssh,
        host,
        { commandCenterRef: "local" },
        {
          ...operations({
            deploy: () =>
              Effect.succeed({
                ok: false,
                detail: "SSH disconnected during activation",
                code: "io" as const,
                stages: [],
                disposition: "indeterminate" as const,
              }),
          }),
          restore,
        },
      ),
    );

    expect(restore).not.toHaveBeenCalled();
    expect(calls.count).toBe(3);
    expect(result).toMatchObject({
      ok: false,
      outcome: "indeterminate",
      packageState: "unknown",
      rollback: "not-required",
      role: "unknown",
    });
    expect(result.detail).toMatch(/Remote stamp was retained/u);
  });

  it("does not restore settings around a committed package with an uncleared deploy lock", async () => {
    const { ssh, calls } = makeSsh([
      { stdout: "/Users/remote\n" },
      { stdout: "ABSENT\n" },
      { stdout: "STAMPED\n" },
      { stdout: "/Users/remote\n" },
      { stdout: presentSnapshot(configuredSettingsBody) },
    ]);

    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        ssh,
        host,
        { commandCenterRef: "local" },
        operations({
          deploy: () =>
            Effect.succeed({
              ok: false,
              detail: "station ready; deploy lock release failed",
              code: "io" as const,
              stages: [],
              disposition: "ready" as const,
              version: "0.1.0",
            }),
        }),
      ),
    );

    expect(calls.count).toBe(5);
    expect(result).toMatchObject({
      outcome: "indeterminate",
      packageState: "present",
      role: "remote",
      rollback: "not-required",
      version: "0.1.0",
    });
  });

  it("withholds ready when settings change after package commit", async () => {
    const { ssh } = makeSsh([
      { stdout: "/Users/remote\n" },
      { stdout: "ABSENT\n" },
      { stdout: "STAMPED\n" },
      { stdout: "/Users/remote\n" },
      { stdout: presentSnapshot('{"external":"edit"}\n') },
    ]);

    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        ssh,
        host,
        { commandCenterRef: "local" },
        operations({
          deploy: () =>
            Effect.succeed({
              ok: true,
              detail: "station ready",
              stages: [],
              disposition: "ready" as const,
              version: "0.1.0",
            }),
        }),
      ),
    );

    expect(result).toMatchObject({
      outcome: "indeterminate",
      packageState: "present",
      role: "unknown",
      rollback: "not-required",
      version: "0.1.0",
    });
  });

  it("retains the stamp when the package commits before the deploy receipt returns", async () => {
    const { ssh, calls } = makeSsh([
      { stdout: "/Users/remote\n" },
      { stdout: "ABSENT\n" },
      { stdout: "STAMPED\n" },
    ]);
    let signalRemoteCommitted: (() => void) | undefined;
    const remoteCommitted = new Promise<void>((resolve) => {
      signalRemoteCommitted = resolve;
    });
    const deploy = () =>
      Effect.sync(() => signalRemoteCommitted?.()).pipe(
        // Models the remote script crossing commit_deploy, followed by a lost
        // or interrupted SSH readiness receipt.
        Effect.zipRight(Effect.never),
      );
    const restore = vi.fn(restoreRemoteSettingsSnapshot);

    const fiber = Effect.runFork(
      deployConfiguredRemoteHost(
        ssh,
        host,
        { commandCenterRef: "local" },
        { ...operations({ deploy }), restore },
      ),
    );
    await remoteCommitted;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(restore).not.toHaveBeenCalled();
    expect(calls.count).toBe(3);
  });
});
