/**
 * The core's handlers of the library group (src/contract/core/library.ts):
 * the window's library reads and writes (junto/ipc.ts). A signal named by a
 * preview, a page box comment's shot, a signal's files pulled from the seat's
 * machine, seat guidance, squads and agent profiles. Each answer is plain
 * data; a repository refusal fails with `LibraryRefused` carrying its message,
 * which the window shows as before.
 */
import { Effect, Option } from "effect";
import { LibraryRefused, LibraryRpcs } from "../../contract/core/library";
import { ProfileRepository } from "../profiles/repository";
import { SeatGuidanceRepository } from "../seat-guidance/repository";
import { SignalFilePuller } from "../signals/file-puller";
import { AgentSignalRepository } from "../signals/repository";
import { SquadRepository } from "../squads/repository";
import { readPageShot } from "../work/page-shot-read";

/** What the repository refused or failed on, in its own words. */
const refused = (error: { readonly message: string }) => new LibraryRefused({ message: error.message });

export const LibraryHandlers = LibraryRpcs.toLayer(
  Effect.gen(function* () {
    const signals = yield* AgentSignalRepository;
    const guidance = yield* SeatGuidanceRepository;
    const squads = yield* SquadRepository;
    const profiles = yield* ProfileRepository;
    return {
      LibrarySignal: ({ signalId }) => signals.get(signalId).pipe(Effect.orElseSucceed(() => null)),
      LibraryPageShot: (at) => readPageShot(at),
      // Only the operator's open of a file reaches here: the seat's machine is asked for it now.
      LibraryPullSignalFiles: ({ signal, away }) =>
        Effect.serviceOption(SignalFilePuller).pipe(
          Effect.flatMap((puller) =>
            Option.isNone(puller)
              ? Effect.succeed(null)
              : Effect.forEach(away, (ref) => puller.value.pull({ signal, ref })).pipe(
                  Effect.andThen(signals.get(signal.signalId)),
                ),
          ),
          Effect.orElseSucceed(() => null),
        ),
      LibraryGuidanceList: () => guidance.list().pipe(Effect.mapError(refused)),
      LibraryGuidanceSet: ({ seatId, guidance: next }) => guidance.set(seatId, next).pipe(Effect.mapError(refused)),
      LibrarySquadsList: () => squads.list().pipe(Effect.mapError(refused)),
      LibrarySquadSave: (input) => squads.save(input).pipe(Effect.mapError(refused)),
      LibrarySquadRename: ({ squadId, name }) => squads.rename(squadId, name).pipe(Effect.mapError(refused)),
      LibrarySquadRemove: ({ squadId }) => squads.remove(squadId).pipe(Effect.mapError(refused)),
      LibraryProfilesList: () => profiles.list().pipe(Effect.mapError(refused)),
      LibraryProfileSave: (input) => profiles.save(input).pipe(Effect.mapError(refused)),
      LibraryProfileRename: ({ profileId, name }) => profiles.rename(profileId, name).pipe(Effect.mapError(refused)),
      LibraryProfileRemove: ({ profileId }) => profiles.remove(profileId).pipe(Effect.mapError(refused)),
    };
  }),
);
