/**
 * The window's terminal-picker reads (term/ipc.ts): the managed harnesses
 * installed on this machine, their profiles, and the launch flags a harness
 * offers. They ask the filesystem and the shells, so they run in the core,
 * where the terminal plane's own spawn paths already read the same templates.
 */
import { Effect } from "effect";
import type { HarnessId } from "@shared/managed-terminal-templates";
import type { ManagedTerminalFlagsResult, ManagedTerminalProfilesResult } from "@shared/ipc";
import type { HarnessInstallProbe } from "../../junto/term/templates/harness-install";
import { harnessLaunchFlags, probeManagedHarnessInstalls } from "../../junto/term/templates/harness-install";
import { enumerateManagedProfiles } from "../../junto/term/templates/enumerate-dispatch";
import { coreOps, type CoreOp } from "../ops";

/** A probe that throws answers nothing installed, as the window showed before. */
const probed = <A>(ask: () => Promise<A>, empty: A): Effect.Effect<A> =>
  Effect.tryPromise({ try: ask, catch: () => new Error("the harness probe failed") }).pipe(
    Effect.orElseSucceed(() => empty),
  );

declare module "../ops" {
  interface CoreOps {
    "term.managedProfiles": CoreOp<Record<string, never>, ManagedTerminalProfilesResult>;
    "term.harnessInstalls": CoreOp<Record<string, never>, { readonly harnesses: ReadonlyArray<HarnessInstallProbe> }>;
    "term.harnessFlags": CoreOp<{ readonly harness: HarnessId; readonly cwd?: string }, ManagedTerminalFlagsResult>;
  }
}

coreOps({
  "term.managedProfiles": () =>
    probed<ManagedTerminalProfilesResult>(() => enumerateManagedProfiles(), { profiles: [], source: "empty" }),
  "term.harnessInstalls": () =>
    Effect.map(
      probed<ReadonlyArray<HarnessInstallProbe>>(() => probeManagedHarnessInstalls(), []),
      (harnesses) => ({ harnesses }),
    ),
  "term.harnessFlags": ({ harness, cwd }) =>
    probed<ManagedTerminalFlagsResult>(() => harnessLaunchFlags(harness, cwd), { installed: false, flags: [] }),
});
