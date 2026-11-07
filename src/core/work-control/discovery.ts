/**
 * The core's handlers for the work socket's discovery ops (`DiscoveryRpcs`).
 * Owned by cli-performance. Each reads the seat its call was admitted as
 * (`WorkSeat`), as `src/core/work-control/msg.ts` does, and refuses with the
 * v1 error body as a `WorkFailure`.
 */
import { Effect, Option, Result } from "effect";
import { ulid } from "ulid";
import { DiscoveryRpcs } from "../../contract/work/discovery";
import { workFailure } from "../../contract/work/failure";
import {
  AGENT_SIGNAL_MAX_DETAIL_LENGTH,
  AGENT_SIGNAL_MAX_TEXT_LENGTH,
  type AgentSignalAttachment,
  compareSignalListOrder,
  normalizeSignalText,
} from "@shared/agent-signals";
import { sinceCursorOf } from "@shared/mail-list-filter";
import { asNodeId, taskBoardTitle, type Canvas, type Node } from "@shared/model";
import { regionStack } from "@shared/model/canvas";
import { flowDestinations } from "@shared/flow-graph";
import { boardContractOf, regionContractOf, rulesInForce } from "@shared/rules";
import { TASKS_ENABLED } from "@shared/features";
import { isThisMachine } from "@shared/machine-identity";
import { recoverDocumentLaunchChoices } from "@shared/launch-choices";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { formatNodeRef } from "@shared/node-ref";
import {
  coMembersByRegion,
  compileConnectionInstructions,
  compileFilesReach,
  compileReach,
  onboardGuidanceFor,
  renderSince,
  toolsBeyondGuidance,
} from "@shared/seat-onboarding";
import { SINCE_PER_SECTION } from "@shared/seat-since";
import {
  CONTINUATION_FRAMING,
  PAST_SESSIONS_FRAMING,
  PREVIOUS_WITHOUT_NOTES_FRAMING,
  SEAT_SESSION_CONTINUATION_MAX_CHARS,
  SEAT_SESSION_NOTES_MAX_CHARS,
  type SeatSession,
  describeSessionDrain,
  gistOfNotes,
  type OffboardMode,
  describeTranscriptMissing,
  sessionDrainCaution,
} from "@shared/seat-sessions";
import type { OpListResult, OpView } from "@shared/op-control";
import { isResourceKind, reaches, resourcesInReach, resourcesSeatReaches } from "@shared/region-reach";
import { levelOfSignal, rankOf } from "@shared/wire/urgency";
import { type SignalListResult, WORK_PROTOCOL_VERSION, type WorkErrorBody } from "@shared/work-control";
import { ContentService } from "../content/service";
import { operatorAttachmentLines } from "../content/operator-attachments";
import { claimSignalAttachments, releaseSignalAttachments, signalAttachmentOwner } from "../signals/attachments";
import { resolveSignalForm, signalKindTakesForm } from "../signals/form-rule";
import { AgentSignalRepository, type AgentSignalRepositoryError } from "../signals/repository";
import { signalResourcesFor } from "../signals/resource-refs";
import {
  connectedCapabilities,
  containingRegion,
  factoryRoleOfNode,
  findNode,
  regionVisibility,
  summarizeNode,
} from "../work/authz";
import { onboardSinceSection } from "../work/seat-since-read";
import { filesNodeName } from "../work/subject-people";
import { MachineRepository } from "../machines/repository";
import { onboardReferenceFields } from "../references/seat-reads";
import { briefingMentionsOn, mentionsField } from "../references/briefing-mentions";
import { SeatGuidanceRepository } from "../seat-guidance/repository";
import { PortraitOverrideRepository } from "../portraits/repository";
import { probeManagedHarnessInstalls } from "../term/templates/harness-install";
import { handleOpOp } from "../work/op-control";
import { announcedSessionRefusal } from "../seat-sessions/announced-session";
import { SeatSessionRepository, type SeatSessionNotes } from "../seat-sessions/repository";
import { listSeatSessions } from "../seat-sessions/service";
import { harnessSessionExists } from "../term/session-existence";
import { offeredCapturedSessionId } from "../term/session-id-store";
import { resolveJuntoHome } from "@shared/junto-home";
import { readMachineLog, seatLogScope } from "../../node/observability/log-file";
import { WorkAdmission, WorkSeat } from "./seat";
import { lookForSeatSession } from "./session-lookup";

/** What a seat does next once its signal is raised, by the signal's kind. */
const SIGNAL_NEXT_STEP = {
  blocked:
    "stop and wait: the operator's answer arrives in this seat as operator mail; junto signal list shows it",
  escalate:
    "keep working: the operator's answer arrives in this seat as operator mail; junto signal list shows it",
  feedback:
    "keep going or wrap up: any review arrives as operator mail; junto signal clear withdraws this if it no longer applies",
  notice:
    "read and clear it: junto signal clear withdraws it; the operator sees it in the feed, not this seat",
  work:
    "it stays open until the operator's reply meets its condition; junto signal clear withdraws it if it no longer applies",
} as const;

/** This seat's signal store, or why this runtime has none. */
const signalStore = Effect.gen(function* () {
  const signalsOption = yield* Effect.serviceOption(AgentSignalRepository);
  if (Option.isNone(signalsOption)) {
    return yield* Effect.fail<WorkErrorBody>({
      type: "RuntimeDown",
      message: "agent signals are unavailable in this Junto runtime",
      details: { retryable: false },
    });
  }
  return signalsOption.value;
});

const signalError = (error: AgentSignalRepositoryError): WorkErrorBody =>
  error._tag === "AgentSignalNotFound"
    ? {
        type: "UnknownTarget",
        message: error.message,
        details: {
          target: error.signalId,
          retryable: false,
          next_step: "run junto signal list to see this seat's open signals",
        },
      }
    : {
        type: "InternalError",
        message: error.message,
        details: { retryable: true },
      };

const PREAMBLE_TOOL = Object.freeze({
  id: "preamble",
  command: "junto preamble",
  description: "Show a short-lived thought bubble above this agent node.",
  input: { text: "..." },
});

/** Universal on every seat: how a seat raises its hand to the operator. */
const SIGNAL_TOOLS = Object.freeze([
  Object.freeze({
    id: "escalate",
    command: "junto escalate",
    description: "Needs the operator's attention; you keep working.",
    input: { text: "...", detail: "optional markdown" },
  }),
  Object.freeze({
    id: "blocked",
    command: "junto blocked",
    description: "Work is entirely blocked on the operator; stop and wait.",
    input: { text: "...", detail: "optional markdown" },
  }),
  Object.freeze({
    id: "feedback",
    command: "junto feedback",
    description: "Not blocked; the work is ready for the operator to review.",
    input: { text: "...", detail: "optional markdown" },
  }),
  Object.freeze({
    id: "signal",
    command: "junto signal list | junto signal clear [id]",
    description: "Read the operator's answers, or withdraw your own open signal.",
  }),
]);

const OVERSEER_TOOL = Object.freeze({
  id: "overseer",
  command: "junto overseer skill",
  description: "Learn Junto canvas and node administration. Human-granted authority; independent of pause/play.",
});

const taskIdentity = (node: Node | undefined, id: string) => {
  const identity = taskBoardTitle(node?.kind === "task" ? node : undefined, id);
  return { ...identity, ...(identity.source === "id" ? { namingHint: "Name this node to name the board." } : {}) };
};
const taskName = (node: Node | undefined, id: string) => taskIdentity(node, id).name;

/**
 * Trimmed contract guidance for one board. Blank or whitespace-only authored
 * values never surface (authored fields can hold them even though the editor
 * normalizes).
 */
const boardGuidance = (
  doc: Canvas,
  board: string,
): {
  instructions?: string;
  incomingHandling?: string;
  incomingDescription?: string;
  outgoingHandoff?: string;
  outgoingDescription?: string;
} => {
  const contract = boardContractOf(doc, board);
  const instructions = contract?.instructions?.trim();
  const incomingHandling = contract?.incoming?.handling?.trim();
  const incomingDescription = contract?.incoming?.description?.trim();
  // Handoff prose only surfaces when the board can send the task on.
  const hasNext = flowDestinations(doc, board).length > 0;
  const outgoingHandoff = hasNext ? contract?.outgoing?.handoff?.trim() : undefined;
  const outgoingDescription = hasNext
    ? contract?.outgoing?.description?.trim()
    : undefined;
  return {
    ...(instructions ? { instructions } : {}),
    ...(incomingHandling ? { incomingHandling } : {}),
    ...(incomingDescription ? { incomingDescription } : {}),
    ...(outgoingHandoff ? { outgoingHandoff } : {}),
    ...(outgoingDescription ? { outgoingDescription } : {}),
  };
};

/**
 * Onboard's per-board summary: what this board stands for, how many rules
 * it carries, and where work goes next. Undefined for nodes that carry no
 * board contract and no flow edges, so plain nodes stay quiet.
 */
const boardBriefing = (doc: Canvas, nodeId: string) => {
  // Tasks are a product surface: a tasks-off build carries no board summary.
  if (!TASKS_ENABLED) return undefined;
  const node = doc.nodes.get(asNodeId(nodeId));
  const identity = taskIdentity(node, nodeId);
  const contract = boardContractOf(doc, node?.id ?? "");
  const next = flowDestinations(doc, nodeId).map((destination) => {
    const destinationNode = doc.nodes.get(asNodeId(destination));
    const incoming = boardContractOf(doc, destination)?.incoming;
    return {
      board: destination,
      name: taskName(destinationNode, destination),
      ...(incoming?.description !== undefined
        ? { description: incoming.description }
        : {}),
    };
  });
  if (contract === undefined && next.length === 0) return undefined;
  return {
    board: {
      name: identity.name,
      ...(identity.namingHint ? { namingHint: identity.namingHint } : {}),
    },
    contract: {
      ...boardGuidance(doc, nodeId),
      rules: rulesInForce(doc, nodeId).length,
    },
    next,
  };
};

const rulingsForRegionStack = (doc: Canvas, nodeId: string) =>
  regionStack(doc, asNodeId(nodeId)).flatMap((group) => {
    const rulings = regionContractOf(group)?.rulings ?? [];
    if (rulings.length === 0) return [];
    return [{
      region: group.id,
      label: group.label?.trim() || group.id,
      rulings,
    }];
  });

/**
 * An agent seat's configuration for `junto onboard`. The operator's soul,
 * instructions, and look come from their stores when this runtime has them;
 * a store that cannot answer leaves its field out rather than failing onboard.
 */
const seatConfigurationOf = (node: Node) =>
  Effect.gen(function* () {
    const terminal = node.kind === "agent" ? node : undefined;
    const harness = terminal?.harness;
    if (!harness) return undefined;
    const choices = isHarnessId(harness) ? recoverDocumentLaunchChoices(harness, terminal.launch) : {};
    const name = terminal.label.trim();
    const guidanceStore = yield* Effect.serviceOption(SeatGuidanceRepository);
    const guidance = Option.isSome(guidanceStore)
      ? yield* guidanceStore.value.get(node.id).pipe(Effect.orElseSucceed(() => null))
      : null;
    const portraitStore = yield* Effect.serviceOption(PortraitOverrideRepository);
    const look = Option.isSome(portraitStore)
      ? (yield* portraitStore.value.list().pipe(Effect.orElseSucceed(() => ({}) as Record<string, never>)))[node.id]
      : undefined;
    return {
      ...(name ? { name } : {}),
      harness,
      ...(choices.profile ? { harness_profile: choices.profile } : {}),
      ...(choices.model ? { model: choices.model } : {}),
      ...(choices.effort ? { effort: choices.effort } : {}),
      ...(choices.mode ? { mode: choices.mode } : {}),
      ...(look ? { look } : {}),
      ...(guidance?.soul ? { soul: guidance.soul } : {}),
      ...(guidance?.instructions ? { instructions: guidance.instructions } : {}),
    };
  });

/**
 * The caller seat's current harness session: its store pin, or an id
 * the seat announced that the harness's own files already prove. An
 * announced id the capture path refused, or would refuse (another seat's,
 * one this seat ended), is never offered: notes, a record or a commit
 * saved under it would belong to a session that is not this seat's.
 */
const currentSeatSession = (node: Node, repository: SeatSessionRepository["Service"]) => Effect.gen(function* () {
  const named = node.kind === "agent"
    ? yield* repository.current(node.id, node.bindingId).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  if (named?.harness === (node.kind === "agent" ? node.harness : undefined)) return named;
  const surface = node.kind === "agent" ? node : undefined;
  if (surface === undefined) return undefined;
  const captured = offeredCapturedSessionId(surface.bindingId);
  const cwd = surface?.launch?.cwd?.trim();
  if (!captured || !harnessSessionExists({ harness: surface.harness, sessionId: captured, ...(cwd ? { cwd } : {}) })) {
    return undefined;
  }
  const refusal = yield* announcedSessionRefusal(repository, { seatId: node.id, harness: surface.harness, sessionId: captured }).pipe(
    Effect.orElseSucceed(() => "the seat's sessions could not be read"),
  );
  if (refusal !== undefined) return undefined;
  return { seatId: node.id, bindingId: surface.bindingId, sessionId: captured, harness: surface.harness, ...(cwd ? { cwd } : {}) };
});

const isoAt = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString();

/**
 * What became of a session's process after its seat moved on, for the session
 * that follows it: one line, and a caution when the transcript's tail cannot
 * be trusted (still being written, or cut mid-turn). Nothing for a session
 * that was never detached.
 */
const windDownOf = (session: SeatSession) => {
  if (session.drain === undefined) return {};
  const caution = sessionDrainCaution(session.drain);
  return {
    wind_down: describeSessionDrain(session.drain),
    ...(caution === undefined ? {} : { transcript_caution: caution }),
  };
};

/** A session's transcript, or a plain line on why it has none, never a bare null. */
const transcriptOf = (session: SeatSession) => ({
  transcript_path: session.transcriptPath ?? null,
  ...(session.transcriptMissing === undefined
    ? {}
    : { transcript_missing: describeTranscriptMissing(session.harness, session.transcriptMissing) }),
});

/** What a session that left no notes says in their place: who closed it. */
const closedWithoutNotes = (session: SeatSession): string => {
  switch (session.endedBy) {
    case "automatic":
      return "closed by Junto, no notes";
    case "operator":
      return "ended by the operator, no notes";
    case "overseer":
      return "ended by an overseer, no notes";
    case undefined:
      return "ended without notes";
    default:
      return session.endedBy satisfies never;
  }
};

/**
 * `junto onboard`'s past sessions: the last one before this session, with its
 * gist, notes and transcript, and a count of the earlier ones. Framed as
 * history, never as work to resume, with one exception: the handoff, the
 * continuation note the previous session left for this one. Absent when this
 * runtime keeps no seat sessions.
 */
const pastSessionsOf = (node: Node) =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(SeatSessionRepository);
    if (Option.isNone(store)) return undefined;
    const current = yield* currentSeatSession(node, store.value);
    const recorded = yield* listSeatSessions(node.id, current?.cwd).pipe(
      Effect.provideService(SeatSessionRepository, store.value),
    );
    const mine = recorded.find((session) => session.sessionId === current?.sessionId);
    const past = recorded.filter((session) => session !== mine);
    // The one exception to history: a continuation the session just before
    // this one left for it. Only the next session gets it, and only here.
    // It is complete by itself, in the order an agent needs it: what to do
    // next, then what happened, then where the full record lives.
    const previous = past[0];
    // Notes are read for the last session only, never the whole history.
    const notesOf = yield* store.value.notesOf(
      node.id,
      previous?.offboardedAt === undefined ? [] : [previous.sessionId],
    ).pipe(Effect.orElseSucceed((): ReadonlyMap<string, SeatSessionNotes> => new Map()));
    const continuation =
      previous?.endReason === "offboard" ? notesOf.get(previous.sessionId)?.continuation : undefined;
    const handoffNotes =
      previous !== undefined && continuation ? notesOf.get(previous.sessionId)?.notes : undefined;
    const handoff =
      previous !== undefined && continuation
        ? {
            note: CONTINUATION_FRAMING,
            from_session: previous.sessionId,
            left_at: isoAt(previous.offboardedAt ?? previous.endedAt),
            continuation,
            gist: previous.gist ?? null,
            ...(handoffNotes === undefined ? {} : { notes: handoffNotes }),
            ...transcriptOf(previous),
            ...windDownOf(previous),
          }
        : undefined;
    // A session that follows one which ended with no notes at all (Junto or
    // the operator ended it without an agent turn, or its id just changed) is
    // told so, with the one reference there is: the previous transcript.
    const endedBy = previous?.endedBy;
    const previousWithoutNotes =
      previous !== undefined &&
      previous.endedAt !== undefined &&
      previous.offboardedAt === undefined
        ? {
            note: PREVIOUS_WITHOUT_NOTES_FRAMING,
            session_id: previous.sessionId,
            harness: previous.harness,
            ended_at: isoAt(previous.endedAt),
            ended_because: previous.endReason,
            // Who ended it, when Junto did so itself: the operator, an
            // overseer, or the idle rule. Absent when nothing recorded it.
            ...(endedBy === undefined ? {} : { ended_by: endedBy }),
            ...transcriptOf(previous),
            ...windDownOf(previous),
          }
        : undefined;
    // The last session: gist and notes only when it wrote them, and who
    // closed it when it did not. The handoff already carries its notes in
    // full, so the entry points there instead of printing them twice.
    const last = previous === undefined
      ? null
      : {
          session_id: previous.sessionId,
          harness: previous.harness,
          started_at: isoAt(previous.startedAt),
          ...(previous.endedAt === undefined ? {} : { ended_at: isoAt(previous.endedAt), ended_because: previous.endReason }),
          ...(previous.offboardedAt === undefined
            ? { closed: closedWithoutNotes(previous) }
            : {
                ...(previous.gist === undefined ? {} : { gist: previous.gist }),
                ...(handoffNotes !== undefined
                  ? { notes_in: "handoff" as const }
                  : (() => {
                      const notes = notesOf.get(previous.sessionId)?.notes;
                      return notes === undefined ? {} : { notes };
                    })()),
              }),
          ...transcriptOf(previous),
          ...(previous.drain === undefined ? {} : { wind_down: describeSessionDrain(previous.drain) }),
        };
    const sessions = {
      note: PAST_SESSIONS_FRAMING,
      current: current
        ? {
            session_id: current.sessionId,
            harness: current.harness,
            transcript_path: mine?.transcriptPath ?? null,
            offboarded: mine?.offboardedAt !== undefined,
          }
        : null,
      last,
      // The sessions before the last one, counted, never listed.
      earlier: Math.max(0, past.length - 1),
    };
    return {
      sessions,
      ...(handoff ? { handoff } : {}),
      ...(previousWithoutNotes ? { previousWithoutNotes } : {}),
      ...(previous === undefined ? {} : { previousStartedAt: previous.startedAt }),
    };
  });

/** The discovery ops as this core serves them: each handler is handed its admitted seat. */
export const DiscoveryServed = DiscoveryRpcs.middleware(WorkAdmission);

export const DiscoveryHandlers = DiscoveryServed.toLayer(
  DiscoveryServed.of({
    "signal.list": (args) =>
      Effect.gen(function* () {
        const { caller } = yield* WorkSeat;
        const signals = yield* signalStore;
        const seat = { canvasName: caller.canvasName, nodeId: caller.nodeId };
        const since = args.since === undefined ? undefined : sinceCursorOf(args.since);
        if (since !== undefined && Result.isFailure(since)) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: since.failure.message,
            details: { path: "args.since", expected: since.failure.expected, retryable: false },
          });
        }
        const listed = yield* signals.listSeat(seat, since?.success).pipe(Effect.mapError(signalError));
        // The capped listing says what it left out and how to page to it.
        const closedListed = listed.filter((signal) => signal.state !== "open").length;
        const closedTotal = since === undefined
          ? yield* signals.countClosedSeat(seat).pipe(Effect.mapError(signalError))
          : closedListed;
        // The operator's answer files, each placed where this seat opens it.
        const store = yield* Effect.serviceOption(ContentService);
        const filesOf = (signal: (typeof listed)[number]) => {
          const refs = signal.response?.attachments ?? [];
          if (refs.length === 0 || Option.isNone(store)) return Effect.succeed({});
          return operatorAttachmentLines(store.value, {
            canvasName: signal.canvasName,
            nodeId: signal.nodeId,
            messageId: `answer-${signal.signalId}`,
            refs,
          }).pipe(
            Effect.map((responseFiles) => ({ responseFiles })),
            Effect.orElseSucceed(() => ({})),
          );
        };
        const sorted = [...listed].sort(compareSignalListOrder);
        const files = yield* Effect.forEach(sorted, filesOf);
        const result: SignalListResult = {
          signals: sorted.map((signal, index) => {
            // A work signal's level is its timing's: due once urgent or past its time, todo before.
            const level = levelOfSignal(signal.kind, signal.work, Date.now());
            return { ...signal, level, rank: rankOf(level), ...files[index] };
          }),
          open: listed.filter((signal) => signal.state === "open").length,
          ...(closedTotal > closedListed
            ? {
                closed_not_listed: closedTotal - closedListed,
                next_step: "junto signal list --since <ISO time or signal id> lists every closed signal from then on",
              }
            : {}),
        };
        return result;
      }).pipe(Effect.mapError(workFailure)),

    "signal.clear": (args) =>
      Effect.gen(function* () {
        const { caller } = yield* WorkSeat;
        const signals = yield* signalStore;
        const seat = { canvasName: caller.canvasName, nodeId: caller.nodeId };
        const withdrawn = yield* signals.withdraw(seat, args.signalId).pipe(Effect.mapError(signalError));
        yield* Effect.forEach(withdrawn, releaseSignalAttachments, { discard: true });
        return { signals: withdrawn, disposition: "applied" as const };
      }).pipe(Effect.mapError(workFailure)),

    "signal.raise": (args) =>
      Effect.gen(function* () {
        const { caller, board } = yield* WorkSeat;
        const signals = yield* signalStore;
        const seat = { canvasName: caller.canvasName, nodeId: caller.nodeId };
        const text = normalizeSignalText(args.text);
        if (!text || text.length > AGENT_SIGNAL_MAX_TEXT_LENGTH) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: `text must be one sentence of 1 to ${AGENT_SIGNAL_MAX_TEXT_LENGTH} characters`,
            details: {
              path: "args.text",
              retryable: false,
              hint: "put the longer explanation in --detail",
            },
          });
        }
        const detail = args.detail?.trim() || undefined;
        if (detail !== undefined && detail.length > AGENT_SIGNAL_MAX_DETAIL_LENGTH) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: `detail must be at most ${AGENT_SIGNAL_MAX_DETAIL_LENGTH} characters`,
            details: { path: "args.detail", retryable: false },
          });
        }
        // The reply the signal asks for (0.11, 07 N1). The wire lets a form ride
        // any raise; here is where it is resolved, and only the kinds that ask
        // the operator to produce something may carry one.
        const request = args.form;
        if (request !== undefined && !signalKindTakesForm(args.kind)) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: `${args.kind} asks for no form: a notice is read and cleared, a review asks the operator to look`,
            details: { path: "args.form", retryable: false, next_step: "raise blocked or escalate to ask for something" },
          });
        }
        const form =
          request === undefined
            ? undefined
            : yield* Effect.fromResult(
                resolveSignalForm({
                  board,
                  reaches: resourcesSeatReaches(board, asNodeId(caller.nodeId)).map((node) => node.id),
                  text,
                  request,
                }),
              );
        // Attached files: the seat uploaded them already. They are judged here,
        // whatever the CLI already checked, and held under the signal's id
        // before the signal itself is written.
        const signalId = ulid();
        let attachments: ReadonlyArray<AgentSignalAttachment> = [];
        if (args.attach !== undefined && args.attach.length > 0) {
          const contentOption = yield* Effect.serviceOption(ContentService);
          if (Option.isNone(contentOption)) {
            return yield* Effect.fail<WorkErrorBody>({
              type: "RuntimeDown",
              message: "attachments are unavailable in this Junto runtime",
              details: { retryable: false, next_step: "raise the signal without --attach" },
            });
          }
          // A task or an artifact is named as the seat typed it: resolved here
          // in its reach to the canonical ref, then judged with the rest.
          const named = yield* signalResourcesFor(board, caller.canvasName, asNodeId(caller.nodeId), args.attach);
          attachments = yield* claimSignalAttachments(
            contentOption.value,
            { ...seat, signalId },
            named.inputs,
            named.resources,
          ).pipe(
            Effect.mapError((refused): WorkErrorBody => ({
              type: "InputError",
              message: refused.message,
              details: { path: `args.${refused.path}`, retryable: false },
            })),
          );
        }
        // Pre-baked replies: each one line the operator can send as-is. The
        // wire already bounds their count and length; what is left to do here
        // is fold each to a single line and drop the ones that fold to none.
        const suggestions = args.suggest
          ?.map((suggestion) => normalizeSignalText(suggestion))
          .filter((suggestion): suggestion is string => suggestion.length > 0);
        const signal = yield* signals
          .raise({
            ...seat,
            signalId,
            kind: args.kind,
            text,
            ...(detail ? { detail } : {}),
            ...(form === undefined ? {} : { form }),
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(suggestions !== undefined && suggestions.length > 0 ? { suggestions } : {}),
          })
          .pipe(
            Effect.mapError(signalError),
            // The signal was not written: nothing may keep holding its files.
            Effect.tapError(() =>
              attachments.length === 0
                ? Effect.void
                : Effect.serviceOption(ContentService).pipe(
                    Effect.flatMap((content) =>
                      Option.isNone(content)
                        ? Effect.void
                        : content.value.releaseOwner(signalAttachmentOwner({ ...seat, signalId })).pipe(Effect.ignore),
                    ),
                  ),
            ),
          );
        return {
          signal,
          disposition: "applied" as const,
          next_step: SIGNAL_NEXT_STEP[signal.kind],
        };
      }).pipe(Effect.mapError(workFailure)),

    "op.show": (args) =>
      Effect.gen(function* () {
        const { caller, board } = yield* WorkSeat;
        // op.show answers one write, as handleOpOp's op.show branch returns it.
        return (yield* handleOpOp("op.show", args, { canvasName: caller.canvasName, nodeId: asNodeId(caller.nodeId), canvas: board })) as {
          readonly op: OpView;
        };
      }).pipe(Effect.mapError(workFailure)),

    "op.list": (args) =>
      Effect.gen(function* () {
        const { caller, board } = yield* WorkSeat;
        // op.list answers a page of writes, as handleOpOp's op.list branch returns it.
        return (yield* handleOpOp("op.list", args, { canvasName: caller.canvasName, nodeId: asNodeId(caller.nodeId), canvas: board })) as OpListResult;
      }).pipe(Effect.mapError(workFailure)),

    "env.report": () =>
      Effect.gen(function* () {
        const { caller, board } = yield* WorkSeat;
        // The seat's own resolution, from the same service the region screen
        // and the overseer doctor read. Names, origins and status only.
        const { regionEnvironmentService } = yield* Effect.promise(() => import("../region-env/live"));
        const report = yield* Effect.promise(() =>
          regionEnvironmentService()
            .seatReportFor(board, caller.nodeId)
            .catch(() => undefined),
        );
        if (report === undefined) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "RuntimeDown",
            message: "this seat's region environment could not be read",
            details: { retryable: true },
          });
        }
        return report;
      }).pipe(Effect.mapError(workFailure)),

    "logs.read": (args) =>
      Effect.gen(function* () {
        const { caller, board, machine: machineName } = yield* WorkSeat;
        const machine = yield* machineName;
        // The caller is the credential's seat; `seat` in the query only narrows
        // inside what that seat may read: its own rows, seats it holds
        // terminal.read to, and rows that name no seat.
        const visible = new Set([
          caller.nodeId,
          ...connectedCapabilities(board, caller.nodeId)
            .filter((peer) => peer.grants.includes("terminal.read"))
            .map((peer) => peer.id),
        ]);
        return yield* readMachineLog(resolveJuntoHome(), machine, args, seatLogScope(visible)).pipe(
          Effect.mapError((error): WorkErrorBody => ({
            type: "RuntimeDown",
            message: "this machine's log could not be read",
            details: { retryable: true, ...(error.code === undefined ? {} : { reason: error.code }) },
          })),
        );
      }).pipe(Effect.mapError(workFailure)),

    // The same projection as onboard's since, capped the same way, or
    // uncapped with all.
    since: (args) =>
      Effect.gen(function* () {
        const { caller, board, readSince } = yield* WorkSeat;
        const history = yield* pastSessionsOf(findNode(board, caller.nodeId)!);
        const perSection = args.all === true ? Number.POSITIVE_INFINITY : SINCE_PER_SECTION;
        return renderSince(
          yield* readSince(history?.previousStartedAt, perSection).pipe(
            Effect.mapError((): WorkErrorBody => ({
              type: "RuntimeDown",
              message: "since your last session could not be read",
              details: { retryable: true },
            })),
          ),
        );
      }).pipe(Effect.mapError(workFailure)),

    offboard: (args) =>
      Effect.gen(function* () {
        const { caller, board } = yield* WorkSeat;
        const notes = args.notes.trim();
        const gist = gistOfNotes(notes);
        if (!gist) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: "notes must say what happened in this session",
            details: {
              path: "args.notes",
              retryable: false,
              hint: "start with one line that sums the session up, then what is relevant and why it matters",
            },
          });
        }
        if (notes.length > SEAT_SESSION_NOTES_MAX_CHARS) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: `notes must be at most ${SEAT_SESSION_NOTES_MAX_CHARS} characters`,
            details: { path: "args.notes", retryable: false, hint: "keep what the next session needs; link files instead of pasting them" },
          });
        }
        const continuation = args.continuation?.trim();
        if (continuation !== undefined && !gistOfNotes(continuation)) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: "the continuation must tell the next session what to pick up and why",
            details: {
              path: "args.continuation",
              retryable: false,
              hint: "or leave out --continue to close this session and let the seat rest",
            },
          });
        }
        if (continuation !== undefined && continuation.length > SEAT_SESSION_CONTINUATION_MAX_CHARS) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: `the continuation must be at most ${SEAT_SESSION_CONTINUATION_MAX_CHARS} characters`,
            details: { path: "args.continuation", retryable: false, hint: "say what to pick up and why; the notes carry the rest" },
          });
        }
        const mode: OffboardMode = continuation === undefined ? "rest" : "continue";
        const store = yield* Effect.serviceOption(SeatSessionRepository);
        if (Option.isNone(store)) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "RuntimeDown",
            message: "seat sessions are unavailable in this Junto runtime",
            details: { retryable: false },
          });
        }
        // Seat identity is the credentialed caller, never an argument: a seat
        // writes only its own current session's notes.
        const self = findNode(board, caller.nodeId)!;
        // Not known yet: look once, now, before refusing.
        const current = (yield* currentSeatSession(self, store.value)) ?? (yield* lookForSeatSession(self));
        if (current === undefined) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InvalidTransition",
            message: "Junto does not know this session's id yet",
            details: {
              caller: caller.nodeId,
              retryable: true,
              next_step: "finish your current turn, then run junto offboard again",
            },
          });
        }
        const session = yield* store.value.offboard({ ...current, notes, gist, ...(continuation ? { continuation } : {}) }).pipe(
          Effect.mapError((error): WorkErrorBody => ({
            type: "InternalError",
            message: error.message,
            details: { retryable: true },
          })),
        );
        // The session is closed from the transport, once this reply has been
        // written back (control.ts, after dispatch): the notes are in
        // junto.db by now, and that is the only thing the close waits for.
        return {
          session_id: session.sessionId,
          gist: session.gist ?? gist,
          mode,
          disposition: "applied" as const,
          next_step:
            mode === "continue"
              ? "your notes and continuation are saved and your seat has moved on to a fresh session, which reads your continuation first; this session may finish what it is saying, but it receives nothing more and its junto commands are refused"
              : "your notes are saved and your seat has moved on: it rests until its next wake, which starts a fresh session that reads your notes; this session may finish what it is saying, but it receives nothing more and its junto commands are refused",
        };
      }).pipe(Effect.mapError(workFailure)),

    capabilities: () =>
      Effect.gen(function* () {
        const { caller, board, paused } = yield* WorkSeat;
        const self = findNode(board, caller.nodeId)!;
        const connected = connectedCapabilities(board, caller.nodeId);
        const overseer = self.kind === "agent" && self.overseer === true;
        return {
          node: summarizeNode(self),
          harnesses: yield* Effect.promise(() => probeManagedHarnessInstalls()),
          // Additive: derived factory role of the credentialed seat.
          role: factoryRoleOfNode(self),
          tools: overseer
            ? [PREAMBLE_TOOL, ...SIGNAL_TOOLS, OVERSEER_TOOL]
            : [PREAMBLE_TOOL, ...SIGNAL_TOOLS],
          overseer: { enabled: overseer, affectedByPause: false as const },
          protocol_version: WORK_PROTOCOL_VERSION,
          connected,
          co_members: regionVisibility(board, caller.nodeId),
          // Pause surface: a paused seat must distinguish pause from a broken
          // grant. Reads stay open; mutating ops still refuse with Paused.
          paused,
          ...(paused
            ? { next_step: "wait for the operator to play the canvas" }
            : {}),
        };
      }).pipe(Effect.mapError(workFailure)),

    onboard: () =>
      Effect.gen(function* () {
        const { caller, board, paused, readSince } = yield* WorkSeat;
        const self = findNode(board, caller.nodeId)!;
        const seat = yield* seatConfigurationOf(self);
        const history = yield* pastSessionsOf(self);
        const region = containingRegion(board, caller.nodeId);
        const connected = connectedCapabilities(board, caller.nodeId);
        const reach = resourcesInReach(board, asNodeId(caller.nodeId)).flatMap((node) =>
          isResourceKind(node.kind) ? [{ id: node.id as string, kind: node.kind }] : [],
        );
        // Files nodes in reach, never a resource kind: the root only on the
        // machine that holds it, and none when this machine's name is unread.
        const machines = yield* Effect.serviceOption(MachineRepository);
        const here = Option.isSome(machines)
          ? yield* machines.value.machineName.pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        const folders = [...board.nodes.values()].flatMap((node) =>
          node.kind === "files" && reaches(board, asNodeId(caller.nodeId), node.id)
            ? [{ id: node.id as string, name: filesNodeName(node), ...(here !== undefined && isThisMachine(node.host, here) ? { root: node.root } : {}) }]
            : [],
        );
        const overseer = self.kind === "agent" && self.overseer === true;
        const guidance = onboardGuidanceFor(seat);
        const tools = toolsBeyondGuidance(
          overseer ? [PREAMBLE_TOOL, ...SIGNAL_TOOLS, OVERSEER_TOOL] : [PREAMBLE_TOOL, ...SIGNAL_TOOLS],
          guidance,
        );
        const { briefing, references } = yield* onboardReferenceFields({ canvasName: caller.canvasName, nodeId: caller.nodeId });
        // Beside each text the operator wrote, what it links, parsed, never expanded into it (0.11/08 B2).
        const briefingMentions = typeof briefing === "string" ? yield* briefingMentionsOn(board, caller, briefing) : undefined;
        const regionMentions = region?.instruction === undefined ? undefined : yield* briefingMentionsOn(board, caller, region.instruction);
        // Most stable first: what changes only when the operator edits it, then
        // who and what this seat is, then what changed since its last session,
        // then the note its last session left.
        return {
          // The few lines every seat needs. Nothing is sent to a harness at
          // session start, so this is where a seat learns what Junto asks of it.
          guidance,
          // The operator's app briefing, or why it could not be read.
          ...(briefing === undefined ? {} : { briefing }),
          ...(briefingMentions === undefined ? {} : { briefing_mentions: briefingMentions }),
          // The innermost region, with every region's instruction outer to inner.
          region: region === undefined ? null : { ...region, ...mentionsField(regionMentions) },
          // The seat as the operator configured it: name, harness and launch
          // dials, look, and the operator-authored soul and standing
          // instructions. Onboard is their only carrier, the same for every
          // harness, read live so an edit shows on the next onboard.
          ...(seat ? { seat } : {}),
          nodeRef: formatNodeRef({
            canvasName: caller.canvasName,
            nodeId: caller.nodeId,
          }),
          node: summarizeNode(self),
          // Additive: derived factory role of the credentialed seat.
          role: factoryRoleOfNode(self),
          overseer: { enabled: overseer, affectedByPause: false as const },
          protocol_version: WORK_PROTOCOL_VERSION,
          // Pause surface: a paused seat must distinguish pause from a broken
          // grant. Reads stay open; mutating ops still refuse with Paused.
          paused,
          ...(paused
            ? { next_step: "wait for the operator to play the canvas" }
            : {}),
          connected: connected.map((c) => ({
            id: c.id,
            kind: c.kind,
            title: c.title,
            name: c.name,
            regions: c.regions,
            role: c.role,
            grants: c.grants,
            ...(boardBriefing(board, c.id) ?? {}),
          })),
          // What each connection allows, compiled from the ports held over it:
          // a seat is never taught a command its edge does not grant.
          commands: compileConnectionInstructions(
            connected.map((c) => ({ id: c.id, kind: c.kind, ports: c.grants })),
          ),
          // The resources in this seat's region reach, by kind, each with every
          // command its kind allows: reach admits, with no edge and no port.
          reach: [...compileReach(reach), ...compileFilesReach(folders)],
          ...(references === undefined ? {} : { references }),
          // Operator-pinned precedent from the seat's own region stack. Region
          // rulings ride the Tasks gate: a tasks-off build names none.
          ...(TASKS_ENABLED
            ? { rulings: rulingsForRegionStack(board, caller.nodeId) }
            : {}),
          // The other seats in this seat's regions, by name.
          co_members: coMembersByRegion(regionVisibility(board, caller.nodeId)),
          // The seat tools the guidance does not already teach.
          tools,
          // Since your last session: replies owed and awaited, open signals,
          // silent answers since the previous session started, unread mail.
          // A read that fails or dies is logged and marked unavailable, and
          // onboard stands without it.
          since: yield* onboardSinceSection(
            readSince(history?.previousStartedAt).pipe(Effect.map(renderSince)),
            `${caller.canvasName}/${caller.nodeId}`,
          ),
          // This seat's last session and a count of the earlier ones: history
          // for continuity, never work to resume.
          ...(history ? { sessions: history.sessions } : {}),
          // Last, the note the previous session left for this one, when it
          // continued rather than rested.
          ...(history?.handoff ? { handoff: history.handoff } : {}),
          // Or, when the previous session left nothing: say so, and where its
          // transcript is.
          ...(history?.previousWithoutNotes
            ? { previous_session_without_notes: history.previousWithoutNotes }
            : {}),
        };
      }).pipe(Effect.mapError(workFailure)),
  }),
);
