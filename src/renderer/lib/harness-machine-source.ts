/**
 * Where Settings > Agents reads a machine's harnesses and writes its harness
 * config. Every machine, the window's own included, is asked the same way:
 * there is no local-only path (docs/machines.md, Harness inventory).
 *
 * Inventory comes from the machine's own core through `machineInventory`:
 * every machine is asked by name, and one the link cannot reach yet answers a
 * typed refusal. Native settings are the closed catalogue
 * (harness-domain/native-catalogue.ts); until the machine-side reader and
 * writer land, a read and a write answer a typed refusal. It never waits on a probe
 * and never reads this window's own CLIs in place of another machine's.
 */
import { Result } from "effect";
import {
  InventoryUnavailableError,
  NativeSettingRefusedError,
  type MachineInventory,
  type NativeSettingWrite,
} from "@shared/harness-domain";
import { NativeConfigWriteError } from "@shared/harness-domain/native-config-write";
import type { NativeSettingFailure } from "@shared/ipc";
import type { HarnessId } from "@shared/managed-terminal-templates";
import type { MachineInventoryFailure } from "@shared/ipc";

/** Why a native setting could not be read or written on its machine. */
export type NativeSettingError = InventoryUnavailableError | NativeSettingRefusedError | NativeConfigWriteError;

const errorOf = (failure: NativeSettingFailure): NativeSettingError => {
  switch (failure._tag) {
    case "InventoryUnavailableError":
      return new InventoryUnavailableError({ machine: failure.machine, reason: failure.reason, message: failure.message });
    case "NativeSettingRefusedError":
      return new NativeSettingRefusedError({
        harness: failure.harness, key: failure.key, reason: failure.reason, message: failure.message,
      });
    case "NativeConfigWriteError":
      return new NativeConfigWriteError({
        machine: failure.machine, harness: failure.harness, key: failure.key, reason: failure.reason, message: failure.message,
      });
  }
};

const unreachableCall = (machine: string, cause: unknown): NativeSettingFailure => ({
  _tag: "InventoryUnavailableError",
  machine,
  reason: "failed",
  message: cause instanceof Error ? cause.message : String(cause),
});

/**
 * Why a machine's inventory could not be read now, and what it last sent.
 * An unreachable machine is shown from `last` with its age; nothing waits.
 */
export type InventoryRefusal = {
  readonly error: InventoryUnavailableError;
  /** The typed failure behind the reason, e.g. LinkUnavailable. */
  readonly failure?: string;
  /** The operation both machines logged the request under. */
  readonly operationId?: string;
  /** The last snapshot that machine sent, and when this machine received it. */
  readonly last?: { readonly inventory: MachineInventory; readonly receivedAt: number };
};

export type HarnessMachineSource = {
  /** The machine's last inventory, cached; never a probe the caller waits on. */
  readonly inventory: (machine: string) => Promise<Result.Result<MachineInventory, InventoryRefusal>>;
  /**
   * The current value of each declared key in the harness's own config on that
   * machine, read by that machine. A key absent from the file is absent here.
   */
  readonly readNativeSettings: (
    machine: string,
    harness: HarnessId,
    keys: readonly string[],
  ) => Promise<Result.Result<Readonly<Record<string, NativeSettingWrite["value"]>>, NativeSettingError>>;
  /** Written by the machine's own Junto; answers the value read back. */
  readonly writeNativeSetting: (
    write: NativeSettingWrite,
  ) => Promise<Result.Result<NativeSettingWrite["value"], NativeSettingError>>;
};

const NOT_LANDED = "The machine inventory channel has not landed in this build.";
const NATIVE_NOT_LANDED = "Reading and writing harness config has not landed in this build.";

export const pendingHarnessMachineSource: HarnessMachineSource = {
  inventory: async (machine) =>
    Result.fail({ error: new InventoryUnavailableError({ machine, reason: "failed", message: NOT_LANDED }) }),
  readNativeSettings: async (machine, harness) =>
    Result.fail(new InventoryUnavailableError({ machine, harness, reason: "failed", message: NATIVE_NOT_LANDED })),
  writeNativeSetting: async (write) =>
    Result.fail(
      new InventoryUnavailableError({
        machine: write.machine,
        harness: write.harness,
        reason: "failed",
        message: NATIVE_NOT_LANDED,
      }),
    ),
};

/** Inventory from each machine's core; native config still pending. */
export const coreHarnessMachineSource: HarnessMachineSource = {
  ...pendingHarnessMachineSource,
  inventory: async (machine) => {
    const api = window.junto;
    if (api === undefined) return pendingHarnessMachineSource.inventory(machine);
    const answer = await api.machineInventory(machine).catch((cause: unknown) => ({
      ok: false as const,
      error: {
        _tag: "InventoryUnavailableError" as const,
        machine,
        reason: "failed" as const,
        message: cause instanceof Error ? cause.message : String(cause),
      },
    }));
    if (answer.ok) return Result.succeed(answer.inventory);
    const { failure, operationId, last } = answer.error as MachineInventoryFailure;
    return Result.fail({
      error: new InventoryUnavailableError({
        machine: answer.error.machine,
        reason: answer.error.reason,
        message: answer.error.message,
      }),
      ...(failure === undefined ? {} : { failure }),
      ...(operationId === undefined ? {} : { operationId }),
      ...(last === undefined ? {} : { last }),
    });
  },
  readNativeSettings: async (machine, harness, keys) => {
    const api = window.junto;
    if (api === undefined) return pendingHarnessMachineSource.readNativeSettings(machine, harness, keys);
    const answer = await api.nativeSettingsRead({ machine, harness, keys })
      .catch((cause: unknown) => ({ ok: false as const, error: unreachableCall(machine, cause) }));
    return answer.ok ? Result.succeed(answer.values) : Result.fail(errorOf(answer.error));
  },
  writeNativeSetting: async (write) => {
    const api = window.junto;
    if (api === undefined) return pendingHarnessMachineSource.writeNativeSetting(write);
    const answer = await api.nativeSettingWrite(write)
      .catch((cause: unknown) => ({ ok: false as const, error: unreachableCall(write.machine, cause) }));
    return answer.ok ? Result.succeed(answer.value) : Result.fail(errorOf(answer.error));
  },
};

let source: HarnessMachineSource = coreHarnessMachineSource;

export const harnessMachineSource = (): HarnessMachineSource => source;

/** The inventory channel installs its source here when it lands; tests swap one in. */
export const setHarnessMachineSource = (next: HarnessMachineSource): void => {
  source = next;
};
