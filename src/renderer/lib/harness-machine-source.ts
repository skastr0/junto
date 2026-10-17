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
  type NativeSettingRefusedError,
  type MachineInventory,
  type NativeSettingWrite,
} from "@shared/harness-domain";
import type { HarnessId } from "@shared/managed-terminal-templates";

export type HarnessMachineSource = {
  /** The machine's last inventory, cached; never a probe the caller waits on. */
  readonly inventory: (machine: string) => Promise<Result.Result<MachineInventory, InventoryUnavailableError>>;
  /**
   * The current value of each declared key in the harness's own config on that
   * machine, read by that machine. A key absent from the file is absent here.
   */
  readonly readNativeSettings: (
    machine: string,
    harness: HarnessId,
    keys: readonly string[],
  ) => Promise<Result.Result<Readonly<Record<string, NativeSettingWrite["value"]>>, InventoryUnavailableError>>;
  /** Written by the machine's own Junto; answers the value read back. */
  readonly writeNativeSetting: (
    write: NativeSettingWrite,
  ) => Promise<Result.Result<NativeSettingWrite["value"], NativeSettingRefusedError | InventoryUnavailableError>>;
};

const NOT_LANDED = "The machine inventory channel has not landed in this build.";
const NATIVE_NOT_LANDED = "Reading and writing harness config has not landed in this build.";

export const pendingHarnessMachineSource: HarnessMachineSource = {
  inventory: async (machine) =>
    Result.fail(new InventoryUnavailableError({ machine, reason: "failed", message: NOT_LANDED })),
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
    return answer.ok
      ? Result.succeed(answer.inventory)
      : Result.fail(new InventoryUnavailableError({
        machine: answer.error.machine,
        reason: answer.error.reason,
        message: answer.error.message,
      }));
  },
};

let source: HarnessMachineSource = coreHarnessMachineSource;

export const harnessMachineSource = (): HarnessMachineSource => source;

/** The inventory channel installs its source here when it lands; tests swap one in. */
export const setHarnessMachineSource = (next: HarnessMachineSource): void => {
  source = next;
};
