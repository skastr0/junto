/**
 * The core's handlers of the picker reads (src/contract/core/term-templates.ts):
 * the managed harnesses installed on this machine, their profiles, and the
 * launch flags a harness offers. They ask the filesystem and the shells, so
 * they run in the core, where the terminal plane's own spawn paths already
 * read the same templates.
 */
import { Effect } from "effect";
import type { ManagedTerminalFlagsResult, ManagedTerminalProfilesResult } from "@shared/ipc";
import { TermTemplatesRpcs } from "../../contract/core/term-templates";
import type { HarnessInstallProbe } from "../term/templates/harness-install";
import { harnessLaunchFlags, probeManagedHarnessInstalls } from "../term/templates/harness-install";
import { enumerateManagedProfiles } from "../term/templates/enumerate-dispatch";

/** A probe that throws answers nothing installed, as the window showed before. */
const probed = <A>(ask: () => Promise<A>, empty: A): Effect.Effect<A> =>
  Effect.tryPromise({ try: ask, catch: () => new Error("the harness probe failed") }).pipe(
    Effect.orElseSucceed(() => empty),
  );

export const TermTemplatesHandlers = TermTemplatesRpcs.toLayer({
  TermTemplatesManagedProfiles: () =>
    probed<ManagedTerminalProfilesResult>(() => enumerateManagedProfiles(), { profiles: [], source: "empty" }),
  TermTemplatesHarnessInstalls: () =>
    Effect.map(
      probed<ReadonlyArray<HarnessInstallProbe>>(() => probeManagedHarnessInstalls(), []),
      (harnesses) => ({ harnesses }),
    ),
  TermTemplatesHarnessFlags: ({ harness, cwd }) =>
    probed<ManagedTerminalFlagsResult>(() => harnessLaunchFlags(harness, cwd), { installed: false, flags: [] }),
});
