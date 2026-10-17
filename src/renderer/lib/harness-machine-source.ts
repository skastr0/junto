/**
 * Where Settings > Agents reads a machine's harnesses and writes its harness
 * config. Every machine, the window's own included, is asked the same way:
 * there is no local-only path (docs/machines.md, Harness inventory).
 *
 * Inventory comes from the machine's own core through `machineInventory`:
 * every machine is asked by name, and one the link cannot reach yet answers a
 * typed refusal. The native config writer has not landed, so there are no
 * declared native settings and a write is refused. It never waits on a probe
 * and never reads this window's own CLIs in place of another machine's.
 */
import { Result } from "effect";
import {
  InventoryUnavailableError,
  NativeSettingRefusedError,
  type MachineInventory,
  type NativeSettingSpec,
  type NativeSettingWrite,
} from "@shared/harness-domain";
import type { HarnessId } from "@shared/managed-terminal-templates";

export type HarnessMachineSource = {
  /** The machine's last inventory, cached; never a probe the caller waits on. */
  readonly inventory: (machine: string) => Promise<Result.Result<MachineInventory, InventoryUnavailableError>>;
  /** Native settings declared for this harness at the machine's installed version. */
  readonly nativeSettings: (machine: string, harness: HarnessId) => Promise<readonly NativeSettingSpec[]>;
  /** Written by the machine's own Junto; answers the value read back. */
  readonly writeNativeSetting: (
    write: NativeSettingWrite,
  ) => Promise<Result.Result<NativeSettingWrite["value"], NativeSettingRefusedError | InventoryUnavailableError>>;
};

const NOT_LANDED = "The machine inventory channel has not landed in this build.";

export const pendingHarnessMachineSource: HarnessMachineSource = {
  inventory: async (machine) =>
    Result.fail(new InventoryUnavailableError({ machine, reason: "failed", message: NOT_LANDED })),
  nativeSettings: async () => [],
  writeNativeSetting: async (write) =>
    Result.fail(
      new NativeSettingRefusedError({
        harness: write.harness,
        key: write.key,
        reason: "undeclared",
        message: `${write.key} is not declared for ${write.harness} in this build`,
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
