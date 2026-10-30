/**
 * The window's status reads (junto/ipc.ts): the authority banner, a canvas
 * digest, usage, and the kernel snapshot. Each answer is plain data; the
 * authority read answers null when the plane is off or cannot be read, as it
 * did on main.
 */
import { Effect, Option } from "effect";
import type { AuthorityWindowData } from "@shared/authority";
import { AUTHORITY_ENABLED } from "@shared/features";
import { CanvasAuthorities } from "../../junto/fleet/authorities";
import { KernelService } from "../../junto/kernel/service";
import { readModelDigest } from "../../junto/model/digest";
import { UsageService } from "../../junto/usage/usage-service";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "ipc.status.authority": CoreOp<Record<string, never>, AuthorityWindowData | null>;
    "ipc.status.digest": CoreOp<{ readonly name: string }, { readonly digest: string }>;
    /** The usage shapes are the service's own; the window reads them as data. */
    "ipc.status.usageCurrent": CoreOp<Record<string, never>, unknown>;
    "ipc.status.usageRefresh": CoreOp<Record<string, never>, unknown>;
    "ipc.status.kernel": CoreOp<Record<string, never>, unknown>;
  }
}

coreOps({
  "ipc.status.authority": () =>
    Effect.gen(function* () {
      if (!AUTHORITY_ENABLED) return null;
      const host = yield* Effect.serviceOption(CanvasAuthorities);
      if (Option.isNone(host)) return null;
      const machines = yield* host.value.machines();
      const canvases = yield* host.value.status();
      return { self: machines.self, machines: machines.machines, canvases } satisfies AuthorityWindowData;
    }).pipe(Effect.catch(() => Effect.succeed(null))),
  "ipc.status.digest": ({ name }) =>
    Effect.map(readModelDigest(name), (digest) => ({ digest })),
  "ipc.status.usageCurrent": () =>
    Effect.flatMap(UsageService, (usage) => usage.current),
  "ipc.status.usageRefresh": () =>
    Effect.flatMap(UsageService, (usage) => usage.refresh()),
  "ipc.status.kernel": () =>
    Effect.map(KernelService, (kernel) => kernel.getSnapshot()),
});
