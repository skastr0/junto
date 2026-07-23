import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { configureRemoteHost } from "../src/main/vellum/hosts/configure-remote";
import {
  mergeRemoteStationSettings,
  planRemoteStationFields,
} from "../src/shared/remote-station-config";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { defaultSettings } from "../src/shared/settings";

const remoteHost: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  endpoint: "studio-box",
  capabilities: ["herdr", "hermes"],
};

const localHost: RemoteHost = {
  id: "local",
  label: "local",
  kind: "local",
  capabilities: ["herdr", "hermes"],
};

const planned = planRemoteStationFields({
  remoteHostId: "studio",
  commandCenterRef: "local",
});

type Ssh = Parameters<typeof configureRemoteHost>[0];

/**
 * Sequential mock: warm → home lookup → cat existing → write → probe cat.
 * Call order is fixed by configureRemoteHost.
 */
const makeSsh = (options?: {
  readonly existingRaw?: string | null;
  readonly homeOutput?: string;
  readonly failWarm?: boolean;
  readonly failWrite?: boolean;
}): { readonly ssh: Ssh; readonly writes: string[]; readonly calls: { calls: number } } => {
  const writes: string[] = [];
  const calls = { calls: 0 };

  const ssh = {
    warm: () =>
      options?.failWarm
        ? Effect.fail({
            _tag: "SshTimeoutError",
            endpoint: "studio-box",
            operation: "warm",
            timeoutMs: 1,
        } as never)
        : Effect.void,
    run: () =>
      Effect.gen(function* () {
        calls.calls += 1;
        // 1: homeDirectoryLookup
        if (calls.calls === 1) {
          return { stdout: options?.homeOutput ?? "/Users/remote\n", stderr: "" };
        }
        // 2: cat existing settings
        if (calls.calls === 2) {
          if (options?.existingRaw === undefined || options.existingRaw === null) {
            return yield* Effect.fail({
              _tag: "SshExitError",
              endpoint: "studio-box",
              operation: "cat",
              code: 1,
            } as never);
          }
          return { stdout: options.existingRaw, stderr: "" };
        }
        // 3: write
        if (calls.calls === 3) {
          if (options?.failWrite) {
            return yield* Effect.fail({
              _tag: "SshExitError",
              endpoint: "studio-box",
              operation: "write",
              code: 1,
            } as never);
          }
          writes.push("written");
          return { stdout: "", stderr: "" };
        }
        // 4: probe cat — return the planned merge so probe succeeds
        const base =
          options?.existingRaw && options.existingRaw.trim().length > 0
            ? (JSON.parse(options.existingRaw) as ReturnType<typeof defaultSettings>)
            : defaultSettings();
        const merged = mergeRemoteStationSettings(base, {
          remoteHostId: "studio",
          commandCenterRef: "local",
        });
        return {
          stdout: `${JSON.stringify(merged, null, 2)}\n`,
          stderr: "",
        };
      }),
  } as unknown as Ssh;

  return { ssh, writes, calls };
};

describe("configureRemoteHost", () => {
  it("rejects local hosts", async () => {
    const { ssh } = makeSsh();
    const result = await Effect.runPromise(
      Effect.either(
        configureRemoteHost(ssh, localHost, { commandCenterRef: "local" }),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.code).toBe("validation");
      expect(result.left.message).toMatch(/local/);
    }
  });

  it("writes Remote station stamp when remote has no settings file", async () => {
    const { ssh, writes } = makeSsh({ existingRaw: null });
    const result = await Effect.runPromise(
      configureRemoteHost(ssh, remoteHost, { commandCenterRef: "local" }),
    );
    expect(result.ok).toBe(true);
    expect(writes).toEqual(["written"]);
    expect(result.station).toEqual(planned);
    expect(result.detail).toMatch(/configured studio/);
  });

  it("is idempotent when remote already matches plan", async () => {
    const existing = mergeRemoteStationSettings(defaultSettings(), {
      remoteHostId: "studio",
      commandCenterRef: "local",
    });
    const { ssh, writes } = makeSsh({
      existingRaw: `${JSON.stringify(existing, null, 2)}\n`,
    });
    const result = await Effect.runPromise(
      configureRemoteHost(ssh, remoteHost, { commandCenterRef: "local" }),
    );
    expect(result.ok).toBe(true);
    expect(writes).toEqual([]);
    expect(result.detail).toMatch(/already configured/);
  });

  it("merges station into existing remote settings", async () => {
    const existing = {
      ...defaultSettings(),
      appearance: { ...defaultSettings().appearance, theme: "system" as const },
      station: {
        role: "" as const,
        hostId: "local",
        commandCenterRef: "",
        supervisedPreferred: false,
      },
    };
    const { ssh, writes } = makeSsh({
      existingRaw: `${JSON.stringify(existing, null, 2)}\n`,
    });
    const result = await Effect.runPromise(
      configureRemoteHost(ssh, remoteHost, { commandCenterRef: "local" }),
    );
    expect(result.ok).toBe(true);
    expect(writes).toEqual(["written"]);
    expect(result.station?.role).toBe("remote");
    expect(result.station?.hostId).toBe("studio");
  });

  it("surfaces SSH warm failures on the error channel", async () => {
    const { ssh } = makeSsh({ failWarm: true });
    const result = await Effect.runPromise(
      Effect.either(
        configureRemoteHost(ssh, remoteHost, { commandCenterRef: "local" }),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toMatch(/Studio/);
    }
  });

  it.each([
    ["missing terminator", "/Users/remote"],
    ["leading whitespace", " /Users/remote\n"],
    ["trailing whitespace", "/Users/remote \n"],
    ["CRLF", "/Users/remote\r\n"],
    ["extra line terminator", "/Users/remote\n\n"],
    ["multiple records", "/Users/remote\n/Users/other\n"],
    ["empty", "\n"],
    ["root", "/\n"],
    ["relative", "Users/remote\n"],
    ["dot segment", "/Users/./remote\n"],
    ["dotdot segment", "/Users/../Applications\n"],
    ["double slash", "/Users//remote\n"],
    ["trailing slash", "/Users/remote/\n"],
    ["control byte", "/Users/rem\u0000ote\n"],
  ])("rejects %s remote home output after one SSH call", async (_case, homeOutput) => {
    const { ssh, writes, calls } = makeSsh({ homeOutput });
    const result = await Effect.runPromise(
      Effect.either(
        configureRemoteHost(ssh, remoteHost, { commandCenterRef: "local" }),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.code).toBe("io");
      expect(result.left.message).toMatch(/exactly one canonical absolute path/);
    }
    expect(writes).toEqual([]);
    expect(calls.calls).toBe(1);
  });
});
