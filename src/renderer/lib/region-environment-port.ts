/**
 * The region environment screen's port, bound to the running app. Secrets
 * and the report go to main through JuntoApi; a restart is the renderer's own
 * seat restart. A build whose bridge lacks a method answers in words instead
 * of throwing, so the screen still opens and says what it cannot do.
 */
import type { CanvasNode } from "@shared/canvas";
import { getJuntoApi } from "./junto-api";
import type { PortResult, RegionEnvironmentPort } from "./region-environment";

const UNAVAILABLE = "This build of Junto cannot do that yet.";

const guarded = async <T>(run: (() => Promise<PortResult<T>>) | undefined): Promise<PortResult<T>> => {
  if (run === undefined) return { ok: false, message: UNAVAILABLE };
  try {
    return await run();
  } catch {
    // Never the thrown text: an IPC error can quote its arguments.
    return { ok: false, message: "Junto could not complete that. Try again." };
  }
};

/** What the port needs from the renderer around it. */
export type RegionEnvironmentHost = {
  readonly canvasName: () => string;
  /**
   * Main answers from the canvas as saved, so an edit must be on disk before
   * the report is asked for.
   */
  readonly flushSave: () => Promise<unknown>;
  readonly findNode: (id: string) => CanvasNode | undefined;
  /** The one seat restart: same binding, same session. */
  readonly restartSeat: (
    node: CanvasNode & { readonly type: "text" },
  ) => Promise<{ readonly ok: true; readonly restarted: boolean } | { readonly ok: false; readonly message: string }>;
};

export const regionEnvironmentPort = (host: RegionEnvironmentHost): RegionEnvironmentPort => {
  const saved = async (): Promise<void> => {
    await host.flushSave().catch(() => undefined);
  };
  return {
    saveSecret: (input) => {
      const call = getJuntoApi()?.regionEnvSaveSecret;
      return guarded(call ? () => call(input) : undefined);
    },
    removeSecret: (secretId) => {
      const call = getJuntoApi()?.regionEnvRemoveSecret;
      return guarded(call ? () => call(secretId) : undefined);
    },
    report: (regionId) => {
      const call = getJuntoApi()?.regionEnvReport;
      return guarded(
        call
          ? async () => {
              await saved();
              return call(host.canvasName(), regionId);
            }
          : undefined,
      );
    },
    staleSeats: (regionId) => {
      const call = getJuntoApi()?.regionEnvStaleSeats;
      return guarded(
        call
          ? async () => {
              await saved();
              return call(host.canvasName(), regionId);
            }
          : undefined,
      );
    },
    restartSeat: (seatId) =>
      guarded(async () => {
        const node = host.findNode(seatId);
        if (node === undefined || node.type !== "text") {
          return { ok: false, message: "That seat is no longer on the canvas." };
        }
        const outcome = await host.restartSeat(node);
        // A seat that is not running has nothing to restart: it starts on the
        // current environment the next time it starts.
        return outcome.ok ? { ok: true } : outcome;
      }),
  };
};
