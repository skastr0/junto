import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { configureRemoteHost } from "../src/main/vellum/hosts/configure-remote";
import { migrateSettingsDocument } from "../src/main/vellum/settings/migrate";
import {
  mergeRemoteStationSettings,
  planRemoteStationFields,
  remoteStationAlreadyConfigured,
} from "../src/shared/remote-station-config";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { defaultSettings } from "../src/shared/settings";

const remoteHost: RemoteHost = {
  id: "studio",
  hermesId: "fleet-studio",
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
  agentHostId: "fleet-studio",
  commandCenterRef: "local",
});

const planInput = {
  remoteHostId: "studio",
  agentHostId: "fleet-studio",
  commandCenterRef: "local",
} as const;

type Ssh = Parameters<typeof configureRemoteHost>[0];

const settingsMatchPlan = (raw: string | null | undefined): boolean => {
  if (raw === undefined || raw === null || raw.trim().length === 0) return false;
  try {
    const migrated = migrateSettingsDocument(JSON.parse(raw) as unknown);
    if (Either.isLeft(migrated)) return false;
    return remoteStationAlreadyConfigured(migrated.right, planInput);
  } catch {
    return false;
  }
};

/**
 * Sequential mock: warm → home → cat existing → [seal probe if match] → write → probe cat.
 */
const makeSsh = (options?: {
  readonly existingRaw?: string | null;
  readonly homeOutput?: string;
  readonly failWarm?: boolean;
  readonly failWrite?: boolean;
  /** When settings match plan: SEALED early-return vs UNSEALED force re-stamp. */
  readonly topologySealed?: boolean;
}): { readonly ssh: Ssh; readonly writes: string[]; readonly calls: { calls: number } } => {
  const writes: string[] = [];
  const calls = { calls: 0 };
  const match = settingsMatchPlan(options?.existingRaw);

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

        if (match) {
          // 3: topology seal presence probe
          if (calls.calls === 3) {
            return {
              stdout: options?.topologySealed ? "SEALED\n" : "UNSEALED\n",
              stderr: "",
            };
          }
          if (options?.topologySealed) {
            return yield* Effect.fail(
              new Error(`unexpected SSH call after SEALED early-return: #${calls.calls}`),
            );
          }
          // 4: write (force re-stamp)
          if (calls.calls === 4) {
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
          // 5: probe cat
        } else {
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
          // 4: probe cat
        }

        const base =
          options?.existingRaw && options.existingRaw.trim().length > 0
            ? (JSON.parse(options.existingRaw) as ReturnType<typeof defaultSettings>)
            : defaultSettings();
        const merged = mergeRemoteStationSettings(base, planInput);
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

  it("is idempotent when remote already matches plan AND topology seals present", async () => {
    const existing = mergeRemoteStationSettings(defaultSettings(), planInput);
    const { ssh, writes } = makeSsh({
      existingRaw: `${JSON.stringify(existing, null, 2)}\n`,
      topologySealed: true,
    });
    const result = await Effect.runPromise(
      configureRemoteHost(ssh, remoteHost, { commandCenterRef: "local" }),
    );
    expect(result.ok).toBe(true);
    expect(writes).toEqual([]);
    expect(result.detail).toMatch(/already configured/);
  });

  it("force re-stamps when settings match but topology seals are absent", async () => {
    const existing = mergeRemoteStationSettings(defaultSettings(), planInput);
    const { ssh, writes } = makeSsh({
      existingRaw: `${JSON.stringify(existing, null, 2)}\n`,
      topologySealed: false,
    });
    const result = await Effect.runPromise(
      configureRemoteHost(ssh, remoteHost, { commandCenterRef: "local" }),
    );
    expect(result.ok).toBe(true);
    expect(writes).toEqual(["written"]);
    expect(result.detail).not.toMatch(/already configured/);
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
        topologyIntegrity: "ok" as const,
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
    expect(result.station?.agentHostId).toBe("fleet-studio");
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
      expect(result.left.code).toBe("io");
    }
  });
});
