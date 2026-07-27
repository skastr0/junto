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
 * Sequential mock:
 * warm → home → cat existing
 *   | match → seal presence (SEALED early-return | UNSEALED refuse)
 *   | non-match with settings → refuse (no further calls)
 *   | settings absent → topology evidence (ABSENT write | EVIDENCE refuse)
 *   → write → probe cat
 */
const makeSsh = (options?: {
  readonly existingRaw?: string | null;
  readonly homeOutput?: string;
  readonly failWarm?: boolean;
  readonly failWrite?: boolean;
  /** When settings match plan: SEALED early-return vs UNSEALED refuse. */
  readonly topologySealed?: boolean;
  /**
   * When settings are absent: ABSENT (pristine enroll) vs EVIDENCE (refuse).
   * Defaults to ABSENT.
   */
  readonly topologyEvidence?: "ABSENT" | "EVIDENCE";
}): { readonly ssh: Ssh; readonly writes: string[]; readonly calls: { calls: number } } => {
  const writes: string[] = [];
  const calls = { calls: 0 };
  const match = settingsMatchPlan(options?.existingRaw);
  const settingsPresent =
    options?.existingRaw !== undefined &&
    options?.existingRaw !== null &&
    options.existingRaw.trim().length > 0;

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
          return yield* Effect.fail(
            new Error(`unexpected SSH call after match path: #${calls.calls}`),
          );
        }

        if (settingsPresent) {
          return yield* Effect.fail(
            new Error(`unexpected SSH call after non-matching settings refuse: #${calls.calls}`),
          );
        }

        // Settings absent: 3 = topology evidence probe
        if (calls.calls === 3) {
          return {
            stdout: `${options?.topologyEvidence ?? "ABSENT"}\n`,
            stderr: "",
          };
        }
        if ((options?.topologyEvidence ?? "ABSENT") === "EVIDENCE") {
          return yield* Effect.fail(
            new Error(`unexpected SSH call after topology evidence refuse: #${calls.calls}`),
          );
        }
        // 4: write (pristine enroll)
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
        const next = mergeRemoteStationSettings(defaultSettings(), planInput);
        return {
          stdout: `${JSON.stringify(next, null, 2)}\n`,
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

  it("writes Remote station stamp when remote is pristine (no settings, no seal evidence)", async () => {
    const { ssh, writes } = makeSsh({ existingRaw: null, topologyEvidence: "ABSENT" });
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

  it("refuses when settings match but topology seals are incomplete", async () => {
    const existing = mergeRemoteStationSettings(defaultSettings(), planInput);
    const { ssh, writes } = makeSsh({
      existingRaw: `${JSON.stringify(existing, null, 2)}\n`,
      topologySealed: false,
    });
    const result = await Effect.runPromise(
      configureRemoteHost(ssh, remoteHost, { commandCenterRef: "local" }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("conflict");
    expect(writes).toEqual([]);
    expect(result.detail).toMatch(/seals are incomplete|refuse overwrite/i);
  });

  it("refuses enroll when remote already has non-matching settings", async () => {
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
    expect(result.ok).toBe(false);
    expect(result.code).toBe("conflict");
    expect(writes).toEqual([]);
    expect(result.detail).toMatch(/already has settings|refuse enroll/i);
  });

  it("refuses enroll when settings are absent but topology evidence remains", async () => {
    const { ssh, writes } = makeSsh({
      existingRaw: null,
      topologyEvidence: "EVIDENCE",
    });
    const result = await Effect.runPromise(
      configureRemoteHost(ssh, remoteHost, { commandCenterRef: "local" }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("conflict");
    expect(writes).toEqual([]);
    expect(result.detail).toMatch(/topology\.key\/seal evidence|not pristine/i);
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
