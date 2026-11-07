/**
 * The window's library: squads, seat guidance and agent profiles, and the
 * three reads the preview makes (a signal, a page box comment's shot, a
 * signal's files pulled from the seat's machine). Every call asks the core's
 * library group (src/contract/core/library.ts). What the window sends is
 * normalized here by its shared decoder, so the core is only handed what it
 * can store; a refusal comes back as a message, never a throw.
 *
 * Squads and profiles push the whole list to every window after each change,
 * so each window's add picker stays current. Seat guidance is an install-local
 * preference like portrait overrides (no canvas authoring), so it runs outside
 * the main-authoring gate; `junto onboard` reads the stored rows, so a write is
 * broadcast as it is stored.
 *
 * Returns the three reads the preview handler of main makes through the same
 * group.
 */
import type { IpcMain } from "electron";
import { Context, Effect, Result } from "effect";
import { decodeProfileBody, PROFILE_NAME_MAX, type ProfileDeleteResult, type ProfileResult } from "@shared/agent-profiles";
import { IPC_CHANNELS } from "@shared/ipc";
import type { PageShotAt } from "@shared/page-shot";
import {
  isSeatGuidanceSeatId,
  normalizeSeatGuidance,
  type SeatGuidanceSetResult,
} from "@shared/seat-guidance";
import { decodeSquadBody, type SquadDeleteResult, type SquadResult } from "@shared/squads";
import type { AgentSignal } from "@shared/wire/agent-signals";
import type { ContentRef } from "@shared/wire/content-ref";
import { LibraryCore } from "../../contract/core/library";
import { AppRuntime } from "../runtime";

/** What a call failed with: the core's refusal, or the core leaving. Either way, words. */
type Failure = { readonly message: string };

type Settled<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string };

/** A page box comment's shot as the preview reads it: the bytes are a Buffer, as `nativeImage` takes them. */
export type PageShotAnswer =
  | { readonly ok: true; readonly ref: ContentRef; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: "not-named" | "missing" | "removed" };

export type LibraryAsks = {
  /** The signal a preview names. */
  readonly signal: (signalId: string) => Promise<AgentSignal | undefined>;
  /** A page box comment's shot; the operator reaches every page, and the core serves it only while its thread holds the claim. */
  readonly pageShot: (at: PageShotAt) => Promise<PageShotAnswer>;
  /** Only the operator's open of a file reaches here: the seat's machine is asked for it now. */
  readonly pullFiles: (signal: AgentSignal, away: ReadonlyArray<ContentRef>) => Promise<AgentSignal | undefined>;
};

const idOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.length >= 1 && value.length <= 64 ? value : undefined;

export const registerLibraryIpc = (
  ipc: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: unknown) => void,
  core: Context.Context<LibraryCore>,
): LibraryAsks => {
  const library = Context.get(core, LibraryCore);

  /** Run one call and settle it into an answer the handlers below read: its value, or its words. */
  const settle = async <A>(call: Effect.Effect<A, Failure>): Promise<Settled<A>> => {
    const result = await AppRuntime.runPromise(Effect.result(call));
    return Result.isFailure(result) ? { ok: false, message: result.failure.message } : { ok: true, value: result.success };
  };

  // Squads: the operator's reusable seat templates. Every change pushes the
  // whole list so each window's add picker stays current. Refusals (taken
  // name, bad template, gone squad) come back as a message, never a throw.
  const squadsNow = () => AppRuntime.runPromise(library.LibrarySquadsList());
  const runSquad = async <A>(call: Effect.Effect<A, Failure>): Promise<Settled<A>> => {
    const settled = await settle(call);
    if (settled.ok) {
      void squadsNow()
        .then((squads) => broadcast(IPC_CHANNELS.squadsChanged, { squads }))
        .catch(() => undefined);
    }
    return settled;
  };
  ipc.handle(IPC_CHANNELS.squadsList, () => squadsNow());
  ipc.handle(IPC_CHANNELS.squadSave, async (_event, input: unknown): Promise<SquadResult> => {
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const body = decodeSquadBody(raw.body);
    if (Result.isFailure(body)) return { ok: false, message: "the squad template is not valid" };
    const saved = await runSquad(library.LibrarySquadSave({ name: String(raw.name ?? ""), body: body.success }));
    return saved.ok ? { ok: true, squad: saved.value } : saved;
  });
  ipc.handle(IPC_CHANNELS.squadRename, async (_event, squadId: unknown, name: unknown): Promise<SquadResult> => {
    const id = idOf(squadId);
    if (id === undefined) return { ok: false, message: "squad id is invalid" };
    const renamed = await runSquad(library.LibrarySquadRename({ squadId: id, name: String(name ?? "") }));
    return renamed.ok ? { ok: true, squad: renamed.value } : renamed;
  });
  ipc.handle(IPC_CHANNELS.squadDelete, async (_event, squadId: unknown): Promise<SquadDeleteResult> => {
    const id = idOf(squadId);
    if (id === undefined) return { ok: false, message: "squad id is invalid" };
    const removed = await runSquad(library.LibrarySquadRemove({ squadId: id }));
    return removed.ok ? { ok: true, squadId: removed.value } : removed;
  });

  // Seat guidance: the operator's per-seat soul and instructions. An
  // install-local preference like portrait overrides (no canvas authoring), so
  // it runs outside the main-authoring gate. `junto onboard` reads the stored
  // rows, so a write is broadcast as it is stored.
  ipc.handle(IPC_CHANNELS.seatGuidanceList, () => AppRuntime.runPromise(library.LibraryGuidanceList()));
  ipc.handle(
    IPC_CHANNELS.seatGuidanceSet,
    async (_event, seatId: unknown, guidance: unknown): Promise<SeatGuidanceSetResult> => {
      if (!isSeatGuidanceSeatId(seatId)) return { ok: false, message: "seat id is invalid" };
      const normalized = normalizeSeatGuidance(guidance);
      if (!normalized.ok) return { ok: false, message: normalized.message };
      const set = await settle(library.LibraryGuidanceSet({ seatId, guidance: normalized.guidance }));
      if (!set.ok) return { ok: false, message: set.message };
      broadcast(IPC_CHANNELS.seatGuidance, { seatId, guidance: set.value });
      return { ok: true, seatId, guidance: set.value };
    },
  );

  // Agent profiles: saved agents placed from the add picker. Every change
  // pushes the whole list; refusals come back as a message, never a throw.
  const profilesNow = () => AppRuntime.runPromise(library.LibraryProfilesList());
  const runProfile = async <A>(call: Effect.Effect<A, Failure>): Promise<Settled<A>> => {
    const settled = await settle(call);
    if (settled.ok) {
      void profilesNow()
        .then((profiles) => broadcast(IPC_CHANNELS.profilesChanged, profiles))
        .catch(() => undefined);
    }
    return settled;
  };
  ipc.handle(IPC_CHANNELS.profilesList, () => profilesNow());
  ipc.handle(IPC_CHANNELS.profileSave, async (_event, input: unknown): Promise<ProfileResult> => {
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const profileId = raw.profileId === undefined ? undefined : idOf(raw.profileId);
    if (raw.profileId !== undefined && profileId === undefined) return { ok: false, message: "profile id is invalid" };
    const body = decodeProfileBody(raw.body);
    if (body === null) {
      return { ok: false, message: `a profile needs a name of 1 to ${PROFILE_NAME_MAX} characters and a harness` };
    }
    const saved = await runProfile(library.LibraryProfileSave({ ...(profileId === undefined ? {} : { profileId }), body }));
    return saved.ok ? { ok: true, profile: saved.value } : saved;
  });
  ipc.handle(IPC_CHANNELS.profileRename, async (_event, profileId: unknown, name: unknown): Promise<ProfileResult> => {
    const id = idOf(profileId);
    if (id === undefined) return { ok: false, message: "profile id is invalid" };
    const renamed = await runProfile(library.LibraryProfileRename({ profileId: id, name: String(name ?? "") }));
    return renamed.ok ? { ok: true, profile: renamed.value } : renamed;
  });
  ipc.handle(IPC_CHANNELS.profileDelete, async (_event, profileId: unknown): Promise<ProfileDeleteResult> => {
    const id = idOf(profileId);
    if (id === undefined) return { ok: false, message: "profile id is invalid" };
    const removed = await runProfile(library.LibraryProfileRemove({ profileId: id }));
    return removed.ok ? { ok: true, profileId: removed.value } : removed;
  });

  return {
    signal: (signalId) => AppRuntime.runPromise(library.LibrarySignal({ signalId })).then((signal) => signal ?? undefined),
    pageShot: (at) =>
      AppRuntime.runPromise(library.LibraryPageShot(at)).then(
        (shot): PageShotAnswer => (shot.ok ? { ok: true, ref: shot.ref, bytes: Buffer.from(shot.bytes) } : shot),
      ),
    pullFiles: (signal, away) =>
      AppRuntime.runPromise(library.LibraryPullSignalFiles({ signal, away })).then((pulled) => pulled ?? undefined),
  };
};
