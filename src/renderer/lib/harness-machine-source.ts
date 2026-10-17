/**
 * Where Settings > Agents reads a machine's harnesses and writes its harness
 * config. Every machine, the window's own included, is asked the same way:
 * there is no local-only path (docs/machines.md, Harness inventory).
 *
 * The inventory channel and the native config writer have not landed yet, so
 * the source answers every machine alike: no inventory yet, no declared
 * native settings, and a typed refusal for a write. It never waits on a
 * probe and never reads this window's own CLIs in place of another machine's.
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

let source: HarnessMachineSource = pendingHarnessMachineSource;

export const harnessMachineSource = (): HarnessMachineSource => source;

/** The inventory channel installs its source here when it lands; tests swap one in. */
export const setHarnessMachineSource = (next: HarnessMachineSource): void => {
  source = next;
};
