/**
 * The window's library reads and writes (junto/ipc.ts): a signal named by a
 * preview, a page box comment's shot, a signal's files pulled from the seat's
 * machine, seat guidance, squads and agent profiles. Each answer is plain
 * data; a repository refusal crosses as a CoreCallError carrying its message,
 * which the window shows as before.
 */
import { Effect, Option } from "effect";
import type { AgentProfile, ProfileSaveInput } from "@shared/agent-profiles";
import type { SeatGuidance, SeatGuidanceMap } from "@shared/seat-guidance";
import type { Squad, SquadSaveInput } from "@shared/squads";
import type { AgentSignal } from "@shared/wire/agent-signals";
import type { ContentRef } from "@shared/wire/content-ref";
import { ProfileRepository } from "../../junto/profiles/repository";
import { SeatGuidanceRepository } from "../../junto/seat-guidance/repository";
import { SignalFilePuller } from "../../junto/signals/file-puller";
import { AgentSignalRepository } from "../../junto/signals/repository";
import { SquadRepository } from "../../junto/squads/repository";
import { readPageShot, type PageShotAt, type PageShotRead } from "../../junto/work/page-shot-read";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "ipc.library.signal": CoreOp<{ readonly signalId: string }, AgentSignal | undefined>;
    "ipc.library.pageShot": CoreOp<PageShotAt, PageShotRead>;
    "ipc.library.pullSignalFiles": CoreOp<
      { readonly signal: AgentSignal; readonly away: ReadonlyArray<ContentRef> },
      AgentSignal | undefined
    >;
    "ipc.library.guidanceList": CoreOp<Record<string, never>, SeatGuidanceMap>;
    "ipc.library.guidanceSet": CoreOp<{ readonly seatId: string; readonly guidance: unknown }, SeatGuidance | null>;
    "ipc.library.squadsList": CoreOp<Record<string, never>, ReadonlyArray<Squad>>;
    "ipc.library.squadSave": CoreOp<{ readonly name: string; readonly body: SquadSaveInput["body"] }, Squad>;
    "ipc.library.squadRename": CoreOp<{ readonly squadId: string; readonly name: string }, Squad>;
    "ipc.library.squadRemove": CoreOp<{ readonly squadId: string }, string>;
    "ipc.library.profilesList": CoreOp<Record<string, never>, ReadonlyArray<AgentProfile>>;
    "ipc.library.profileSave": CoreOp<{ readonly profileId?: string; readonly body: ProfileSaveInput["body"] }, AgentProfile>;
    "ipc.library.profileRename": CoreOp<{ readonly profileId: string; readonly name: string }, AgentProfile>;
    "ipc.library.profileRemove": CoreOp<{ readonly profileId: string }, string>;
  }
}

coreOps({
  "ipc.library.signal": ({ signalId }) =>
    Effect.flatMap(AgentSignalRepository, (signals) => signals.get(signalId)).pipe(
      Effect.map((signal): AgentSignal | undefined => signal),
      Effect.orElseSucceed(() => undefined),
    ),
  "ipc.library.pageShot": (at) => readPageShot(at),
  // Only the operator's open of a file reaches here: the seat's machine is asked for it now.
  "ipc.library.pullSignalFiles": ({ signal, away }) =>
    Effect.serviceOption(SignalFilePuller).pipe(
      Effect.flatMap((puller) =>
        Option.isNone(puller)
          ? Effect.succeed(undefined)
          : Effect.forEach(away, (ref) => puller.value.pull({ signal, ref })).pipe(
              Effect.andThen(Effect.flatMap(AgentSignalRepository, (signals) => signals.get(signal.signalId))),
            ),
      ),
      Effect.orElseSucceed(() => undefined),
    ),
  "ipc.library.guidanceList": () => Effect.flatMap(SeatGuidanceRepository, (repository) => repository.list()),
  "ipc.library.guidanceSet": ({ seatId, guidance }) =>
    Effect.flatMap(SeatGuidanceRepository, (repository) => repository.set(seatId, guidance)),
  "ipc.library.squadsList": () => Effect.flatMap(SquadRepository, (repository) => repository.list()),
  "ipc.library.squadSave": (input) => Effect.flatMap(SquadRepository, (repository) => repository.save(input)),
  "ipc.library.squadRename": ({ squadId, name }) =>
    Effect.flatMap(SquadRepository, (repository) => repository.rename(squadId, name)),
  "ipc.library.squadRemove": ({ squadId }) => Effect.flatMap(SquadRepository, (repository) => repository.remove(squadId)),
  "ipc.library.profilesList": () => Effect.flatMap(ProfileRepository, (repository) => repository.list()),
  "ipc.library.profileSave": (input) => Effect.flatMap(ProfileRepository, (repository) => repository.save(input)),
  "ipc.library.profileRename": ({ profileId, name }) =>
    Effect.flatMap(ProfileRepository, (repository) => repository.rename(profileId, name)),
  "ipc.library.profileRemove": ({ profileId }) =>
    Effect.flatMap(ProfileRepository, (repository) => repository.remove(profileId)),
});
