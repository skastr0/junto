/**
 * Native-runtime overseer adapters.
 *
 * Parent authenticates the live caller and rechecks the overseer grant before
 * routing here. This module executes agent/terminal/page/scheduler/git and
 * application-screenshot operations against existing main-owned services.
 * It never fakes a WebContents trusted sender, never uses a bare PID, and
 * never pans/zooms/focuses/resizes/switches the operator viewport.
 */
import { randomBytes } from "node:crypto";
import { Effect, Result } from "effect";
import { formatNodeRef } from "@shared/node-ref";
import { isValidProfileId } from "@shared/browser";
import {
  decodeOverseerArgs,
  type OverseerCaller,
  type OverseerErrorBody,
  type OverseerErrorType,
  type OverseerOperation,
  type OverseerRequest,
  type OverseerResult,
  type OverseerArgsFor,
} from "@shared/overseer-control";
import type { WorkErrorBody } from "@shared/work-control";
import { GIT_LOG_LIMIT_DEFAULT } from "@shared/git";
import {
  type OverseerDeleteResource,
} from "@shared/overseer-rules";
import { seatParts, type SeatParts } from "@shared/model/seat-parts";
import { INTERRUPT_BYTE } from "../term/drive";
import type { ControlLease } from "../term/local-host";
import { asNodeId, inPaintOrder, type Canvas, type Node, type NodeOf } from "@shared/model";
import { modelError } from "../model/records";
import type { ModelNodeReader } from "../node-ref-resolver";
import type { TermPlane } from "../term/plane";
import type { ChatService } from "../chat/service";
import type { ActorSeatOccupyApi } from "../term/actor-seat-occupy";
import { terminalObserverPlane } from "../term/observer";
import {
  BROWSER_UI_SESSION_OWNER,
  type BrowserSessionService,
} from "../browser/sessions";
import { makePageTargetResolver } from "../browser/page-target";
import { readGitLog, readGitShow, readGitStatus } from "../adapters/git";
import { getNextFire, getWatchers, overseerSchedulerFire } from "../kernel/cycle";
import {
  admitOverseerPage,
  overseerPageMessage,
  overseerPageNodeIds,
  overseerPageRefs,
} from "./authz";
import type { HarnessId } from "@shared/managed-terminal-templates";
import type { ManagedTerminalDrive } from "../term/drive";
import { makeManagedSpawnIntent } from "../term/managed-spawn-plan";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const hasPngSignature = (value: Uint8Array): boolean =>
  value.byteLength >= PNG_SIGNATURE.byteLength &&
  PNG_SIGNATURE.every((byte, index) => value[index] === byte);

const NATIVE_OPERATIONS = new Set<string>([
  "canvas.screenshot",
  "agent.list",
  "agent.get",
  "agent.reseat",
  "agent.start",
  "agent.wake",
  "agent.prompt",
  "agent.output",
  "agent.interrupt",
  "agent.stop",
  "terminal.list",
  "terminal.get",
  "terminal.start",
  "terminal.input",
  "terminal.output",
  "terminal.resize",
  "terminal.interrupt",
  "terminal.stop",
  "page.list",
  "page.get",
  "page.open",
  "page.goto",
  "page.eval",
  "page.screenshot",
  "page.close",
  "page.stop",
  "scheduler.fire",
  "scheduler.status",
  "scheduler.configure",
  "git.status",
  "git.log",
  "git.show",
]);

export const isOverseerNativeOperation = (operation: string): boolean =>
  NATIVE_OPERATIONS.has(operation);

export type ApplicationCaptureResult =
  | { readonly ok: true; readonly png: Uint8Array }
  | { readonly ok: false; readonly unavailable: true; readonly reason: string };

export type { OverseerDeleteResource };

export type OverseerDeletePrepareResult =
  | {
      readonly ok: true;
      readonly leaseId: string;
      readonly termLeaseId?: string;
      readonly chatLeaseId?: string;
      readonly pageStops: ReadonlyArray<{
        readonly sessionId: string;
        readonly stopped: boolean;
        readonly error?: string;
      }>;
    }
  | { readonly ok: false; readonly error: string };

export type OverseerDeleteFinishResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type OverseerNativeDeleteHooks = {
  readonly prepareOverseerNodeDelete: (
    resources: ReadonlyArray<OverseerDeleteResource>,
  ) => Promise<OverseerDeletePrepareResult>;
  readonly finishOverseerNodeDelete: (
    leaseId: string,
    outcome: "committed" | "aborted",
  ) => OverseerDeleteFinishResult;
};

export type AgentReseatCommitInput = {
  /** Authenticated overseer seat. Never the target node. */
  readonly caller: OverseerCaller;
  /** Target canvas of the reseat. */
  readonly canvasName: string;
  /** Target agent node id. */
  readonly nodeId: string;
  /** What the seat launch rules worked out from the choices named. */
  readonly parts: SeatParts;
};

export type SchedulerConfigureApplyInput = {
  /** Authenticated overseer seat. Never the target node. */
  readonly caller: OverseerCaller;
  /** Target canvas of the scheduler node. */
  readonly canvasName: string;
  /** Target scheduler node id. */
  readonly nodeId: string;
  readonly change: OverseerArgsFor<"scheduler.configure">["change"];
};

export type OverseerNativeLiveOptions = {
  readonly termPlane: TermPlane;
  readonly chats: ChatService;
  readonly pages?: BrowserSessionService;
  readonly captureApplicationPage: () => Promise<ApplicationCaptureResult>;
  readonly liveOverseerGrant: (caller: OverseerCaller) => Promise<boolean>;
  /** Every canvas as the model holds it now, by name. */
  readonly listCanvases: () => Promise<ReadonlyMap<string, Canvas>>;
  /**
   * Promise form of ActorSeatOccupy.occupy. Native never calls Effect.runPromise.
   * Occupied seats activate; vacant seats occupy. Host comes from the node.
   */
  readonly occupySeat: (
    spec: Parameters<ActorSeatOccupyApi["occupy"]>[0],
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly managedDrive?: Pick<ManagedTerminalDrive, "writePrompt" | "interrupt">;
  /**
   * Canvas-owned document mutation. Native kills the prior generation and
   * builds the reseated node; canvas commits. Missing → Unsupported.
   */
  readonly commitAgentReseat?: (
    input: AgentReseatCommitInput,
    signal: AbortSignal,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /**
   * Canvas-owned scheduler timer/watch mutation. Missing → Unsupported.
   */
  readonly applySchedulerConfigure?: (
    input: SchedulerConfigureApplyInput,
    signal: AbortSignal,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  readonly stationScope?: () => {
    readonly hostId: string;
    readonly installationId: string;
    readonly role: string;
  };
  readonly now?: () => number;
};

type NativeOk = { readonly ok: true; readonly data: unknown };
type NativeErr = { readonly ok: false; readonly error: OverseerErrorBody };
type NativeOutcome = NativeOk | NativeErr;

const fail = (
  type: OverseerErrorType,
  message: string,
  details?: unknown,
): NativeErr => ({
  ok: false,
  error: details === undefined ? { type, message } : { type, message, details },
});

const ok = (data: unknown): NativeOk => ({ ok: true, data });

const asWorkError = (error: OverseerErrorBody): WorkErrorBody => {
  const type: WorkErrorBody["type"] =
    error.type === "Forbidden"
      ? "AuthError"
      : error.type === "InvalidArguments"
        ? "InputError"
        : error.type === "NotFound"
          ? "UnknownTarget"
          : error.type === "Conflict"
            ? "InvalidTransition"
            : error.type === "Unsupported"
              ? "InputError"
              : error.type === "RuntimeDown"
                ? "RuntimeDown"
                : "InternalError";
  return {
    type,
    message: error.message,
    ...(error.details === undefined ? {} : { details: { hint: String(error.details) } }),
  };
};

const OVERSEER_PAGE_OWNER = "overseer";

const canvasOf = (
  caller: OverseerCaller,
  args: { readonly canvas?: string },
): string => args.canvas ?? caller.canvasName;

type Seat = NodeOf<"agent">;

const isAgentNode = (node: Node | undefined): node is Seat => node?.kind === "agent";

const tailText = (text: string, tailBytes: number | undefined): string => {
  if (tailBytes === undefined) return text;
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= tailBytes) return text;
  return encoded.subarray(encoded.byteLength - tailBytes).toString("utf8");
};

const decodeInputBytes = (
  data: string,
  encoding: "utf8" | "base64" | undefined,
): { readonly ok: true; readonly text: string } | NativeErr => {
  if (encoding === "base64") {
    try {
      return { ok: true, text: Buffer.from(data, "base64").toString("utf8") };
    } catch {
      return fail("InvalidArguments", "terminal input is not valid base64");
    }
  }
  return { ok: true, text: data };
};

const abortedGrant = (): NativeErr =>
  fail("Forbidden", "overseer invocation was interrupted");

const bindLiveGrant = (
  liveOverseerGrant: OverseerNativeLiveOptions["liveOverseerGrant"],
  signal: AbortSignal,
): OverseerNativeLiveOptions["liveOverseerGrant"] =>
  async (caller) => {
    if (signal.aborted) return false;
    const granted = await liveOverseerGrant(caller);
    if (signal.aborted) return false;
    return granted;
  };

const requireGrant = async (
  ctx: NativeContext,
  caller: OverseerCaller,
): Promise<NativeErr | undefined> => {
  if (ctx.signal.aborted) return abortedGrant();
  const granted = await ctx.liveOverseerGrant(caller);
  if (ctx.signal.aborted) return abortedGrant();
  if (!granted) return fail("Forbidden", "overseer grant is no longer live");
  return undefined;
};

type NativeContext = OverseerNativeLiveOptions & {
  readonly now: () => number;
  readonly signal: AbortSignal;
};

const modelReader = (
  listCanvases: OverseerNativeLiveOptions["listCanvases"],
): ModelNodeReader => ({
  listCanvases: () =>
    Effect.tryPromise({
      try: async () => [...(await listCanvases()).values()].map((canvas) => canvas.name),
      catch: (error) => modelError("overseer.listCanvases", error),
    }),
  canvas: (name: string) =>
    Effect.tryPromise({
      try: async () => {
        const found = (await listCanvases()).get(name);
        if (found === undefined) throw new Error(`canvas not found: ${name}`);
        return found;
      },
      catch: (error) => modelError("overseer.canvas", error),
    }),
});

const resolveTargetNode = async (
  ctx: NativeContext,
  caller: OverseerCaller,
  args: { readonly canvas?: string; readonly nodeId: string },
): Promise<{ readonly canvasName: string; readonly canvas: Canvas; readonly node: Node } | NativeErr> => {
  const canvasName = canvasOf(caller, args);
  const canvas = (await ctx.listCanvases()).get(canvasName);
  if (canvas === undefined) return fail("NotFound", `canvas not found: ${canvasName}`);
  const node = canvas.nodes.get(asNodeId(args.nodeId));
  if (node === undefined) return fail("NotFound", `node not found: ${args.nodeId}`);
  return { canvasName, canvas, node };
};

/** The session a seat or a terminal holds. */
const bindingOf = (node: Node): { readonly bindingId: string; readonly hostId: string } | undefined =>
  node.kind === "agent" || node.kind === "terminal"
    ? { bindingId: node.bindingId, hostId: node.host }
    : undefined;

const sessionSummary = async (
  ctx: NativeContext,
  bindingId: string,
  hostId: string,
) => ctx.termPlane.router.get(bindingId, hostId);

const inspectOutput = async (
  ctx: NativeContext,
  bindingId: string,
  hostId: string,
  tailBytes: number | undefined,
): Promise<{ readonly text: string; readonly seq?: string; readonly epoch?: string }> => {
  if (ctx.termPlane.router.isLocalHostId(hostId)) {
    const snap = terminalObserverPlane.snapshot(bindingId);
    if (snap !== undefined) {
      return {
        text: tailText(snap.text, tailBytes),
        seq: snap.seq.toString(),
        epoch: snap.epoch,
      };
    }
  }
  const attached = await ctx.termPlane.router.attach({
    bindingId,
    hostId,
    mode: "observe",
  });
  if (!attached.ok) return { text: "" };
  await ctx.termPlane.router.release(attached.lease, hostId);
  const serialized = attached.screen?.serialized ?? "";
  return {
    text: tailText(serialized, tailBytes),
    ...(attached.screen?.seq !== undefined ? { seq: attached.screen.seq.toString() } : {}),
    ...(attached.screen?.epoch !== undefined ? { epoch: attached.screen.epoch } : {}),
  };
};

const withControlLease = async (
  ctx: NativeContext,
  bindingId: string,
  hostId: string,
  use: (lease: ControlLease) => Promise<boolean>,
): Promise<boolean> => {
  if (ctx.signal.aborted) return false;
  const attached = await ctx.termPlane.router.attach({
    bindingId,
    hostId,
    mode: "control",
    takeover: true,
  });
  if (!attached.ok) return false;
  try {
    if (ctx.signal.aborted) return false;
    return await use(attached.lease);
  } finally {
    await ctx.termPlane.router.release(attached.lease, hostId);
  }
};

const writeSeat = async (
  ctx: NativeContext,
  bindingId: string,
  hostId: string,
  data: string,
): Promise<boolean> => {
  if (ctx.signal.aborted) return false;
  if (ctx.termPlane.router.isLocalHostId(hostId)) {
    if (ctx.termPlane.host.writeManagedSeat(bindingId, data)) return true;
  }
  return withControlLease(ctx, bindingId, hostId, async (lease) => {
    if (ctx.signal.aborted) return false;
    return ctx.termPlane.router.write(lease, data, hostId);
  });
};

const interruptSeat = async (
  ctx: NativeContext,
  bindingId: string,
  hostId: string,
): Promise<boolean> => {
  if (ctx.managedDrive !== undefined && ctx.termPlane.router.isLocalHostId(hostId)) {
    return ctx.managedDrive.interrupt(bindingId);
  }
  return writeSeat(ctx, bindingId, hostId, INTERRUPT_BYTE);
};

const promptSeat = async (
  ctx: NativeContext,
  bindingId: string,
  hostId: string,
  text: string,
): Promise<boolean | "uncertain"> => {
  if (ctx.managedDrive !== undefined && ctx.termPlane.router.isLocalHostId(hostId)) {
    // Non-retaining: a revoked overseer request must not land later via drainOne.
    const outcome = await ctx.managedDrive.writePrompt(bindingId, text, {
      queueIfBusy: false,
      signal: ctx.signal,
    });
    if (outcome.status === "submitted") return true;
    if (outcome.status === "unresolved" || outcome.reason === "written-unresolved") return "uncertain";
    return false;
  }
  if (ctx.termPlane.router.isLocalHostId(hostId)) return false;
  // Remote seats deliver through the destination's managed drive, never as
  // raw text+CR over a control lease. No cancellation identity crosses the
  // socket: a transport timeout is uncertain and the caller must not repaste
  // (agent.prompt performs a single attempt). The caller signal is still
  // honored router-side before any bytes are sent.
  return ctx.termPlane.router.managedPrompt(bindingId, text, false, hostId, ctx.signal);
};

const occupySeat = async (
  ctx: NativeContext,
  canvasName: string,
  node: Seat,
): Promise<boolean> => {
  if (ctx.signal.aborted) return false;
  try {
    const occupied = await ctx.occupySeat(
      {
        bindingId: node.bindingId,
        hostId: node.host,
        canvasName,
        nodeId: node.id,
        harness: node.harness,
        agentKey: node.agentKey,
        spawnIntent: makeManagedSpawnIntent({
          nodeId: node.id,
          harness: node.harness,
          documentLaunch: node.launch,
          agentKey: node.agentKey,
          cwd: node.launch?.cwd,
          resume: true,
        }),
      },
      ctx.signal,
    );
    return occupied && !ctx.signal.aborted;
  } catch {
    return false;
  }
};

const startOrWakeAgent = async (
  ctx: NativeContext,
  canvasName: string,
  node: Node,
): Promise<NativeOutcome> => {
  if (!isAgentNode(node)) {
    return fail("InvalidArguments", "node is not a managed agent seat");
  }
  const surface = { bindingId: node.bindingId, hostId: node.host };
  // Operator occupy route: ActorSeatOccupy admits Remote projection then
  // occupies the target host. Never fabricate deriveActorSeatId(CC, remoteBinding).
  const occupied = await occupySeat(ctx, canvasName, node);
  if (!occupied) {
    return ctx.signal.aborted
      ? abortedGrant()
      : fail("RuntimeDown", "managed seat could not start");
  }
  const still = ctx.signal.aborted ? abortedGrant() : undefined;
  if (still) return still;
  let summary: Awaited<ReturnType<typeof sessionSummary>>;
  try {
    summary = await sessionSummary(ctx, surface.bindingId, surface.hostId);
  } catch {
    summary = undefined;
  }
  if (ctx.signal.aborted) return abortedGrant();
  return ok({
    started: true,
    hostId: surface.hostId,
    session: summary ?? { bindingId: surface.bindingId, hostId: surface.hostId },
  });
};

const handleAgent = async (
  ctx: NativeContext,
  caller: OverseerCaller,
  operation: OverseerOperation,
  args: Record<string, unknown>,
): Promise<NativeOutcome> => {
  if (operation === "agent.list") {
    const canvasName = canvasOf(caller, args as { canvas?: string });
    const canvas = (await ctx.listCanvases()).get(canvasName);
    if (canvas === undefined) return fail("NotFound", `canvas not found: ${canvasName}`);
    const agents = [];
    for (const node of inPaintOrder(canvas)) {
      if (!isAgentNode(node)) continue;
      const session = await sessionSummary(ctx, node.bindingId, node.host);
      agents.push({
        nodeId: node.id,
        agentKey: node.agentKey,
        bindingId: node.bindingId,
        hostId: node.host,
        harness: node.harness,
        live: session?.status === "running" || session?.status === "starting",
        session,
      });
    }
    return ok({ canvas: canvasName, agents });
  }

  const targeted = await resolveTargetNode(
    ctx,
    caller,
    args as { canvas?: string; nodeId: string },
  );
  if ("error" in targeted) return targeted;
  const { canvasName, node } = targeted;
  if (!isAgentNode(node)) return fail("InvalidArguments", "node is not an agent seat");
  const binding = { bindingId: node.bindingId, hostId: node.host };
  const agentKey: string | undefined = node.agentKey;

  switch (operation) {
    case "agent.get": {
      const session = binding === undefined
        ? undefined
        : await sessionSummary(ctx, binding.bindingId, binding.hostId);
      return ok({
        nodeId: node.id,
        canvas: canvasName,
        agentKey,
        bindingId: binding.bindingId,
        hostId: binding.hostId,
        harness: node.harness,
        session,
        chatLive: agentKey !== undefined ? ctx.chats.isLive(agentKey) : false,
      });
    }
    case "agent.start":
    case "agent.wake": {
      const started = await startOrWakeAgent(ctx, canvasName, node);
      if (!started.ok) return started;
      const still = await requireGrant(ctx, caller);
      if (still) return still;
      return started;
    }
    case "agent.prompt": {
      const text = String((args as { text: string }).text);
      if (binding === undefined) return fail("InvalidArguments", "agent has no terminal binding");
      const revoked = await requireGrant(ctx, caller);
      if (revoked) return revoked;
      const delivered = await promptSeat(ctx, binding.bindingId, binding.hostId, text);
      // "uncertain" is a named outcome, not a refusal: transport may already
      // have delivered, so it must never read as "did not reach" (which
      // would invite a repaste) and must never be retried automatically.
      if (delivered === "uncertain") {
        const still = await requireGrant(ctx, caller);
        if (still) return still;
        return ok({
          delivered: false,
          uncertain: true,
          bindingId: binding.bindingId,
          message: "prompt submission is unconfirmed — inspect the terminal and do not repaste automatically",
        });
      }
      if (!delivered) return fail("RuntimeDown", "prompt submission was not confirmed");
      const still = await requireGrant(ctx, caller);
      if (still) return still;
      return ok({ delivered: true, bindingId: binding.bindingId });
    }
    case "agent.output": {
      if (binding === undefined) return fail("InvalidArguments", "agent has no terminal binding");
      return ok({
        bindingId: binding.bindingId,
        ...(await inspectOutput(
          ctx,
          binding.bindingId,
          binding.hostId,
          (args as { tailBytes?: number }).tailBytes,
        )),
      });
    }
    case "agent.interrupt": {
      if (binding === undefined) return fail("InvalidArguments", "agent has no terminal binding");
      const revoked = await requireGrant(ctx, caller);
      if (revoked) return revoked;
      const interrupted = await interruptSeat(ctx, binding.bindingId, binding.hostId);
      if (!interrupted) return fail("RuntimeDown", "interrupt did not reach the managed seat");
      const still = await requireGrant(ctx, caller);
      if (still) return still;
      return ok({ interrupted: true, bindingId: binding.bindingId });
    }
    case "agent.stop": {
      if (binding === undefined) return fail("InvalidArguments", "agent has no terminal binding");
      const revoked = await requireGrant(ctx, caller);
      if (revoked) return revoked;
      const stopped = await ctx.termPlane.router.kill(binding.bindingId, binding.hostId);
      const still = await requireGrant(ctx, caller);
      if (still) return still;
      return ok({ stopped, bindingId: binding.bindingId, hostId: binding.hostId });
    }
    case "agent.reseat": {
      if (ctx.commitAgentReseat === undefined) {
        return fail(
          "Unsupported",
          "agent.reseat requires canvas-owned commitAgentReseat",
        );
      }
      const origin = (await ctx.listCanvases())
        .get(caller.canvasName)
        ?.nodes.get(asNodeId(caller.nodeId));
      const originBinding = origin === undefined ? undefined : bindingOf(origin);
      const sameSeat =
        caller.canvasName === canvasName && caller.nodeId === node.id;
      const sameBinding =
        originBinding !== undefined &&
        originBinding.bindingId === binding.bindingId &&
        originBinding.hostId === binding.hostId;
      if (sameSeat || sameBinding) {
        return fail(
          "Forbidden",
          // The model's own sentence for this rule, so an agent reads one.
          "Only the operator can change what an overseer seat runs or remove it.",
        );
      }
      const beforeBuild = await requireGrant(ctx, caller);
      if (beforeBuild) return beforeBuild;
      // The agent names what the seat should run; the launch is worked out
      // here with the one set of seat launch rules, never sent by the agent.
      const choices = args as OverseerArgsFor<"agent.reseat">;
      const priorCwd = node.launch?.cwd?.trim();
      let parts: SeatParts;
      try {
        parts = seatParts({
          harness: choices.harness,
          host: choices.host ?? node.host,
          ...(choices.profile ? { profile: choices.profile } : {}),
          ...(choices.model ? { model: choices.model } : {}),
          ...(choices.effort ? { effort: choices.effort } : {}),
          ...(choices.mode ? { mode: choices.mode } : {}),
          ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {}),
          ...(priorCwd ? { cwd: priorCwd } : {}),
          // A reseat changes what runs in the seat, never what it is called.
          label: node.label,
        });
      } catch (error) {
        return fail(
          "InvalidArguments",
          error instanceof Error ? error.message : String(error),
        );
      }
      const revoked = await requireGrant(ctx, caller);
      if (revoked) return revoked;
      await ctx.termPlane.router.kill(binding.bindingId, binding.hostId);
      const stillAfterKill = await requireGrant(ctx, caller);
      if (stillAfterKill) return stillAfterKill;
      const committed = await ctx.commitAgentReseat({
        caller,
        canvasName,
        nodeId: node.id,
        parts,
      }, ctx.signal);
      const still = await requireGrant(ctx, caller);
      if (still) return still;
      if (!committed.ok) {
        return fail("Conflict", committed.message);
      }
      return ok({
        reseated: true,
        nodeId: node.id,
        priorBindingId: binding.bindingId,
        bindingId: parts.bindingId,
        harness: parts.harness,
      });
    }
    default:
      return fail("Unsupported", `native adapter does not handle ${operation}`);
  }
};

const handleTerminal = async (
  ctx: NativeContext,
  caller: OverseerCaller,
  operation: OverseerOperation,
  args: Record<string, unknown>,
): Promise<NativeOutcome> => {
  if (operation === "terminal.list") {
    const canvasName = canvasOf(caller, args as { canvas?: string });
    const nodeId = (args as { nodeId?: string }).nodeId;
    if (nodeId !== undefined) {
      const targeted = await resolveTargetNode(ctx, caller, { canvas: canvasName, nodeId });
      if ("error" in targeted) return targeted;
      const binding = bindingOf(targeted.node);
      if (binding === undefined) return fail("InvalidArguments", "node has no terminal binding");
      const session = await sessionSummary(ctx, binding.bindingId, binding.hostId);
      return ok({ canvas: canvasName, terminals: session === undefined ? [] : [session] });
    }
    const canvas = (await ctx.listCanvases()).get(canvasName);
    if (canvas === undefined) return fail("NotFound", `canvas not found: ${canvasName}`);
    const terminals = [];
    for (const node of inPaintOrder(canvas)) {
      const binding = bindingOf(node);
      if (binding === undefined) continue;
      const session = await sessionSummary(ctx, binding.bindingId, binding.hostId);
      terminals.push({
        nodeId: node.id,
        kind: node.kind,
        bindingId: binding.bindingId,
        hostId: binding.hostId,
        session,
      });
    }
    return ok({ canvas: canvasName, terminals });
  }

  const targeted = await resolveTargetNode(
    ctx,
    caller,
    args as { canvas?: string; nodeId: string },
  );
  if ("error" in targeted) return targeted;
  const { canvasName, node } = targeted;
  const binding = bindingOf(node);
  if (binding === undefined) return fail("InvalidArguments", "node has no terminal binding");

  switch (operation) {
    case "terminal.get": {
      const session = await sessionSummary(ctx, binding.bindingId, binding.hostId);
      if (session === undefined) return fail("NotFound", `no live terminal for ${binding.bindingId}`);
      return ok(session);
    }
    case "terminal.start": {
      if (node.kind === "agent") {
        const started = await startOrWakeAgent(ctx, canvasName, node);
        if (!started.ok) return started;
        const still = await requireGrant(ctx, caller);
        if (still) return still;
        return started;
      }
      const created = await ctx.termPlane.router.create({
        bindingId: binding.bindingId,
        hostId: binding.hostId,
        canvasName,
        nodeId: node.id,
      });
      const stillCreate = await requireGrant(ctx, caller);
      if (stillCreate) return stillCreate;
      return ok(created);
    }
    case "terminal.input": {
      const decoded = decodeInputBytes(
        String((args as { data: string }).data),
        (args as { encoding?: "utf8" | "base64" }).encoding,
      );
      if (!decoded.ok) return decoded;
      const revoked = await requireGrant(ctx, caller);
      if (revoked) return revoked;
      const written = await writeSeat(ctx, binding.bindingId, binding.hostId, decoded.text);
      if (!written) {
        return fail("RuntimeDown", "terminal input did not reach the seat");
      }
      const still = await requireGrant(ctx, caller);
      if (still) return still;
      return ok({ written: true, bindingId: binding.bindingId, hostId: binding.hostId });
    }
    case "terminal.output": {
      return ok({
        bindingId: binding.bindingId,
        ...(await inspectOutput(
          ctx,
          binding.bindingId,
          binding.hostId,
          (args as { tailBytes?: number }).tailBytes,
        )),
      });
    }
    case "terminal.resize": {
      const cols = (args as { cols: number }).cols;
      const rows = (args as { rows: number }).rows;
      const revoked = await requireGrant(ctx, caller);
      if (revoked) return revoked;
      let resized = false;
      if (ctx.termPlane.router.isLocalHostId(binding.hostId)) {
        resized = ctx.termPlane.host.resizeManagedSeat(binding.bindingId, cols, rows);
      }
      if (!resized) {
        resized = await withControlLease(ctx, binding.bindingId, binding.hostId, (lease) =>
          ctx.termPlane.router.resize(lease, cols, rows, binding.hostId),
        );
      }
      if (!resized) {
        return fail("RuntimeDown", "terminal resize did not reach the seat");
      }
      const still = await requireGrant(ctx, caller);
      if (still) return still;
      return ok({ resized: true, bindingId: binding.bindingId, hostId: binding.hostId, cols, rows });
    }
    case "terminal.interrupt": {
      const revoked = await requireGrant(ctx, caller);
      if (revoked) return revoked;
      const interrupted = await interruptSeat(ctx, binding.bindingId, binding.hostId);
      if (!interrupted) return fail("RuntimeDown", "interrupt did not reach the managed seat");
      const stillInterrupt = await requireGrant(ctx, caller);
      if (stillInterrupt) return stillInterrupt;
      return ok({ interrupted: true, bindingId: binding.bindingId });
    }
    case "terminal.stop": {
      const revoked = await requireGrant(ctx, caller);
      if (revoked) return revoked;
      const stopped = await ctx.termPlane.router.kill(binding.bindingId, binding.hostId);
      const stillStop = await requireGrant(ctx, caller);
      if (stillStop) return stillStop;
      return ok({ stopped, bindingId: binding.bindingId, hostId: binding.hostId });
    }
    default:
      return fail("Unsupported", `native adapter does not handle ${operation}`);
  }
};

const pagesOrDown = (ctx: NativeContext): BrowserSessionService | NativeErr => {
  if (ctx.pages === undefined) {
    return fail(
      "RuntimeDown",
      "browser runtime is unavailable on this installation",
    );
  }
  return ctx.pages;
};

const pageOwner = (): string => OVERSEER_PAGE_OWNER;

const pageRefOf = (
  canvasName: string,
  nodeId: string,
): string | undefined => {
  try {
    return formatNodeRef({ canvasName, nodeId });
  } catch {
    return undefined;
  }
};

const resolveAllLivePageSessions = (
  pages: BrowserSessionService,
  canvasName: string,
  nodeId: string,
): ReadonlyArray<{ readonly owner: string; readonly sessionId: string }> => {
  const ref = pageRefOf(canvasName, nodeId);
  if (ref === undefined) return [];
  return [...pages.overseerSessionsForRef(ref)];
};

const resolveDeletePageSessions = (
  pages: BrowserSessionService,
  canvasName: string,
  nodeId: string,
): ReadonlyArray<{ readonly owner: string; readonly sessionId: string }> => {
  const ref = pageRefOf(canvasName, nodeId);
  if (ref === undefined) return [];
  return [...pages.overseerDeleteSessionsForRef(ref)];
};

const resolveLivePageSession = (
  pages: BrowserSessionService,
  canvasName: string,
  nodeId: string,
): { readonly owner: string; readonly sessionId: string } | undefined =>
  resolveAllLivePageSessions(pages, canvasName, nodeId)[0];

const handlePage = async (
  ctx: NativeContext,
  caller: OverseerCaller,
  operation: OverseerOperation,
  args: Record<string, unknown>,
): Promise<NativeOutcome> => {
  if (operation === "page.list") {
    const canvasName = canvasOf(caller, args as { canvas?: string });
    const canvas = (await ctx.listCanvases()).get(canvasName);
    if (canvas === undefined) return fail("NotFound", `canvas not found: ${canvasName}`);
    const pages = ctx.pages;
    const listed = [];
    for (const nodeId of overseerPageNodeIds(canvas)) {
      const admitted = admitOverseerPage(canvas, nodeId);
      if (!admitted.ok) continue;
      const live = pages === undefined ? undefined : resolveLivePageSession(pages, canvasName, nodeId);
      listed.push({
        nodeId,
        url: admitted.node.url,
        profile: admitted.node.profile,
        hostId: admitted.node.host,
        sessionId: live?.sessionId,
      });
    }
    return ok({ canvas: canvasName, pages: listed, refs: overseerPageRefs(canvas, canvasName) });
  }

  if (operation === "page.get") {
    const targeted = await resolveTargetNode(
      ctx,
      caller,
      args as { canvas?: string; nodeId: string },
    );
    if ("error" in targeted) return targeted;
    const admitted = admitOverseerPage(targeted.canvas, targeted.node.id);
    if (!admitted.ok) return fail("NotFound", overseerPageMessage(admitted.denial));
    const pages = ctx.pages;
    let session = undefined;
    if (pages !== undefined) {
      const live = resolveLivePageSession(pages, targeted.canvasName, targeted.node.id);
      if (live !== undefined) {
        const state = pages.stateForOwner(live.owner, live.sessionId);
        session = state.ok ? state.data : undefined;
      }
    }
    return ok({
      nodeId: targeted.node.id,
      canvas: targeted.canvasName,
      url: admitted.node.url,
      profile: admitted.node.profile,
      hostId: admitted.node.host,
      session,
    });
  }

  if (operation === "page.open") {
    const pages = pagesOrDown(ctx);
    if ("error" in pages) return pages;
    const targeted = await resolveTargetNode(
      ctx,
      caller,
      args as { canvas?: string; nodeId: string },
    );
    if ("error" in targeted) return targeted;
    const admitted = admitOverseerPage(targeted.canvas, targeted.node.id);
    if (!admitted.ok) return fail("NotFound", overseerPageMessage(admitted.denial));
    const hostAdmission = pages.admitAutomationHost(admitted.node.host);
    if (!hostAdmission.ok) {
      return fail(
        hostAdmission.reason === "browser-not-declared" ||
          hostAdmission.reason === "station-identity-unavailable"
          ? "RuntimeDown"
          : "Forbidden",
        hostAdmission.message,
      );
    }
    const resolver = makePageTargetResolver(modelReader(ctx.listCanvases));
    let ref: string;
    try {
      ref = formatNodeRef({ canvasName: targeted.canvasName, nodeId: targeted.node.id });
    } catch (error) {
      return fail("InvalidArguments", error instanceof Error ? error.message : String(error));
    }
    const resolved = await resolver(ref);
    if (!resolved.ok) return fail("NotFound", resolved.message);
    const revoked = await requireGrant(ctx, caller);
    if (revoked) return revoked;
    const opened = await pages.openForOwner(pageOwner(), resolved.data, ctx.signal, async () => {
      if (ctx.signal.aborted) {
        return { ok: false, code: "failed", message: "overseer invocation was interrupted" };
      }
      const stillGranted = await ctx.liveOverseerGrant(caller);
      if (ctx.signal.aborted || !stillGranted) {
        return { ok: false, code: "failed", message: "overseer grant is no longer live" };
      }
      const current = (await ctx.listCanvases()).get(targeted.canvasName);
      if (current === undefined) {
        return { ok: false, code: "not_found", message: "canvas not found" };
      }
      const still = admitOverseerPage(current, targeted.node.id);
      if (!still.ok) {
        return { ok: false, code: "not_found", message: overseerPageMessage(still.denial) };
      }
      return resolver(ref);
    });
    if (!opened.ok) return fail("RuntimeDown", opened.message);
    return ok(opened.data);
  }

  const pages = pagesOrDown(ctx);
  if ("error" in pages) return pages;
  const sessionId = String((args as { sessionId: string }).sessionId);
  const liveOwner =
    typeof pages.overseerSessionOwner === "function"
      ? pages.overseerSessionOwner(sessionId)
      : undefined;
  const owner = liveOwner ?? pageOwner();

  switch (operation) {
    case "page.goto": {
      const revoked = await requireGrant(ctx, caller);
      if (revoked) return revoked;
      const result = pages.gotoForOwner(owner, sessionId, String((args as { url: string }).url));
      if (!result.ok) return fail("RuntimeDown", result.message);
      return ok(result.data);
    }
    case "page.eval": {
      const revoked = await requireGrant(ctx, caller);
      if (revoked) return revoked;
      const result = await pages.evalForOwner(
        owner,
        sessionId,
        String((args as { code: string }).code),
        ctx.signal,
      );
      if (!result.ok) return fail("RuntimeDown", result.message);
      return ok(result.data);
    }
    case "page.screenshot": {
      const result = await pages.screenshotForOwner(owner, sessionId, ctx.signal);
      if (!result.ok) return fail("RuntimeDown", result.message);
      return ok({
        pngBase64: Buffer.from(result.data.png).toString("base64"),
        bytes: result.data.png.byteLength,
      });
    }
    case "page.close": {
      const result = pages.closeForOwner(owner, sessionId);
      if (!result.ok) return fail("RuntimeDown", result.message);
      return ok(result.data);
    }
    case "page.stop": {
      const revoked = await requireGrant(ctx, caller);
      if (revoked) return revoked;
      const result = await pages.stopForOwner(owner, sessionId);
      if (!result.ok) return fail("RuntimeDown", result.message);
      return ok(result.data);
    }
    default:
      return fail("Unsupported", `native adapter does not handle ${operation}`);
  }
};

const handleScheduler = async (
  ctx: NativeContext,
  caller: OverseerCaller,
  operation: OverseerOperation,
  args: Record<string, unknown>,
): Promise<NativeOutcome> => {
  const targeted = await resolveTargetNode(
    ctx,
    caller,
    args as { canvas?: string; nodeId: string },
  );
  if ("error" in targeted) return targeted;
  const { canvasName, node } = targeted;
  if (node.kind !== "cron" && node.kind !== "relay" && node.kind !== "watcher") {
    return fail("InvalidArguments", "node is not a scheduler (cron, relay, or watcher)");
  }

  if (operation === "scheduler.status") {
    const key = `${canvasName}::${node.id}`;
    const watcher = getWatchers().get(key);
    const nextFire = getNextFire().get(key);
    return ok({
      nodeId: node.id,
      canvas: canvasName,
      kind: node.kind,
      // What the scheduler is set to: a cron's expression, a watcher's rule.
      ...(node.kind === "cron" ? { expression: node.expression ?? null } : {}),
      ...(node.kind === "watcher"
        ? { rule: { key: node.key ?? null, stat: node.stat ?? null, op: node.op ?? null, value: node.value ?? null } }
        : {}),
      // What it last saw and when it next fires.
      watcher: watcher ?? null,
      nextFire: nextFire ?? null,
    });
  }

  if (operation === "scheduler.fire") {
    const revoked = await requireGrant(ctx, caller);
    if (revoked) return revoked;
    const fireInput = {
      canvasName,
      sourceNodeId: node.id,
      liveGrant: async () => {
        if (ctx.signal.aborted) return false;
        const granted = await ctx.liveOverseerGrant(caller);
        return !ctx.signal.aborted && granted;
      },
    };
    const fired = await overseerSchedulerFire(fireInput);
    if (!fired.ok) {
      return fail("RuntimeDown", fired.message);
    }
    if (fired.applied === 0) {
      const still = await requireGrant(ctx, caller);
      if (still) return still;
    }
    return ok(fired);
  }

  if (operation === "scheduler.configure") {
    if (ctx.applySchedulerConfigure === undefined) {
      return fail(
        "Unsupported",
        "scheduler.configure requires canvas-owned applySchedulerConfigure",
      );
    }
    const revoked = await requireGrant(ctx, caller);
    if (revoked) return revoked;
    const applied = await ctx.applySchedulerConfigure({
      caller,
      canvasName,
      nodeId: node.id,
      change: (args as OverseerArgsFor<"scheduler.configure">).change,
    }, ctx.signal);
    if (!applied.ok) return fail("Conflict", applied.message);
    return ok({ configured: true, nodeId: node.id, canvas: canvasName });
  }

  return fail("Unsupported", `native adapter does not handle ${operation}`);
};

const handleGit = async (
  ctx: NativeContext,
  caller: OverseerCaller,
  operation: OverseerOperation,
  args: Record<string, unknown>,
): Promise<NativeOutcome> => {
  const targeted = await resolveTargetNode(
    ctx,
    caller,
    args as { canvas?: string; nodeId: string },
  );
  if ("error" in targeted) return targeted;
  if (targeted.node.kind !== "git") {
    return fail("InvalidArguments", "node is not a git node");
  }
  const cwd = targeted.node.cwd.trim();
  if (cwd === undefined || cwd.length === 0) {
    return fail("InvalidArguments", "git node has no cwd");
  }

  if (operation === "git.status") {
    const result = await readGitStatus(cwd);
    if (!result.ok) return fail("RuntimeDown", result.error);
    return ok(result.status);
  }
  if (operation === "git.log") {
    const limit = (args as { limit?: number }).limit ?? GIT_LOG_LIMIT_DEFAULT;
    const result = await readGitLog(cwd, limit);
    if (!result.ok) return fail("RuntimeDown", result.error);
    return ok({ commits: result.commits });
  }
  const sha = String((args as { sha: string }).sha);
  const result = await readGitShow(cwd, sha);
  if (!result.ok) return fail("RuntimeDown", result.error);
  return ok({ sha: result.sha, patch: result.patch });
};

const handleScreenshot = async (
  ctx: NativeContext,
  caller: OverseerCaller,
): Promise<NativeOutcome> => {
  const revoked = await requireGrant(ctx, caller);
  if (revoked) return revoked;
  const captured = await ctx.captureApplicationPage();
  if (!captured.ok) {
    return fail("RuntimeDown", captured.reason, { unavailable: true });
  }
  if (!hasPngSignature(captured.png)) {
    return fail("InternalError", "application capture did not return a PNG");
  }
  return ok({
    pngBase64: Buffer.from(captured.png).toString("base64"),
    bytes: captured.png.byteLength,
  });
};

const dispatchNative = async (
  ctx: NativeContext,
  caller: OverseerCaller,
  request: OverseerRequest,
): Promise<NativeOutcome> => {
  const decoded = decodeOverseerArgs(request.operation, request.args);
  if (Result.isFailure(decoded)) {
    return fail("InvalidArguments", decoded.failure.message);
  }
  const args = decoded.success as Record<string, unknown>;
  const family = request.operation.split(".")[0];
  switch (request.operation) {
    case "canvas.screenshot":
      return handleScreenshot(ctx, caller);
    default:
      break;
  }
  switch (family) {
    case "agent":
      return handleAgent(ctx, caller, request.operation, args);
    case "terminal":
      return handleTerminal(ctx, caller, request.operation, args);
    case "page":
      return handlePage(ctx, caller, request.operation, args);
    case "scheduler":
      return handleScheduler(ctx, caller, request.operation, args);
    case "git":
      return handleGit(ctx, caller, request.operation, args);
    default:
      return fail("Unsupported", `native adapter does not handle ${request.operation}`);
  }
};

type ActiveDeleteLease = {
  readonly id: string;
  readonly termLeaseId?: string;
  readonly chatLeaseId?: string;
  readonly pageRefs: ReadonlyArray<string>;
};

const makeDeleteHooks = (
  ctx: {
    readonly termPlane: TermPlane;
    readonly chats: ChatService;
    readonly pages: () => BrowserSessionService | undefined;
  },
): OverseerNativeDeleteHooks => {
  const leases = new Map<string, ActiveDeleteLease>();

  return {
    prepareOverseerNodeDelete: async (resources) => {
      const agents = resources.filter((resource) => resource.kind === "agent");
      const terminals = resources.filter((resource) => resource.kind === "terminal");
      const pages = resources.filter((resource) => resource.kind === "page");
      if (agents.length + terminals.length + pages.length === 0) {
        return { ok: false, error: "no overseer resources to delete" };
      }

      let termLeaseId: string | undefined;
      let chatLeaseId: string | undefined;
      const pageStops: Array<{ sessionId: string; stopped: boolean; error?: string }> = [];
      const pageRefs: string[] = [];
      const leaseId = `odl-${randomBytes(12).toString("hex")}`;

      try {
        const pageRuntime = pages.length > 0 ? ctx.pages() : undefined;
        if (pages.length > 0 && pageRuntime === undefined) {
          return {
            ok: false,
            error: "browser runtime is unavailable on this installation",
          };
        }
        const liveSessions: Array<{ readonly owner: string; readonly sessionId: string }> = [];
        const seenLive = new Set<string>();
        if (pageRuntime !== undefined) {
          for (const page of pages) {
            const ref = pageRefOf(page.canvasName, page.nodeId);
            if (ref === undefined) {
              const runtime = ctx.pages();
              if (runtime !== undefined) {
                for (const held of pageRefs) runtime.finishOverseerPageDelete(held, leaseId);
              }
              return {
                ok: false,
                error: `page ${page.canvasName}/${page.nodeId} is not a canonical node ref`,
              };
            }
            pageRuntime.beginOverseerPageDelete(ref, leaseId);
            pageRefs.push(ref);
            for (const live of resolveDeletePageSessions(
              pageRuntime,
              page.canvasName,
              page.nodeId,
            )) {
              const key = `${live.owner}\0${live.sessionId}`;
              if (seenLive.has(key)) continue;
              seenLive.add(key);
              liveSessions.push(live);
            }
          }
          const stopLive = async (
            sessions: ReadonlyArray<{ readonly owner: string; readonly sessionId: string }>,
          ): Promise<void> => {
            for (const live of sessions) {
              const stopped = await pageRuntime.stopForOwner(live.owner, live.sessionId);
              if (stopped.ok) {
                pageStops.push({ sessionId: live.sessionId, stopped: true });
                continue;
              }
              if (stopped.code === "not_found") continue;
              pageStops.push({
                sessionId: live.sessionId,
                stopped: false,
                error: stopped.message,
              });
            }
          };
          await stopLive(liveSessions);
          if (!pageStops.some((stop) => !stop.stopped)) {
            const leftover: Array<{ readonly owner: string; readonly sessionId: string }> = [];
            for (const page of pages) {
              for (const live of resolveDeletePageSessions(
                pageRuntime,
                page.canvasName,
                page.nodeId,
              )) {
                const key = `${live.owner}\0${live.sessionId}`;
                if (seenLive.has(key)) continue;
                seenLive.add(key);
                leftover.push(live);
              }
            }
            await stopLive(leftover);
          }
          if (pageStops.some((stop) => !stop.stopped)) {
            leases.set(leaseId, {
              id: leaseId,
              pageRefs: Object.freeze([...pageRefs]),
            });
            return {
              ok: true,
              leaseId,
              pageStops: Object.freeze(pageStops),
            };
          }
        }
        const releasePageFences = (): void => {
          const runtime = ctx.pages();
          if (runtime === undefined) return;
          for (const ref of pageRefs) runtime.finishOverseerPageDelete(ref, leaseId);
        };
        if (terminals.length > 0) {
          const began = await ctx.termPlane.nodeDelete.beginNodeDelete(
            terminals.map((resource) => ({
              bindingId: resource.bindingId,
              ...(resource.hostId !== undefined ? { hostId: resource.hostId } : {}),
            })),
          );
          if (!began.ok) {
            releasePageFences();
            return { ok: false, error: began.error };
          }
          termLeaseId = began.leaseId;
        }
        if (agents.length > 0) {
          const began = await ctx.chats.nodeDelete.beginNodeDelete(
            agents.map((resource) => ({ kind: "agent" as const, agentKey: resource.agentKey })),
          );
          if (!began.ok) {
            if (termLeaseId !== undefined) {
              ctx.termPlane.nodeDelete.finishNodeDelete(termLeaseId, "aborted");
            }
            releasePageFences();
            return { ok: false, error: began.error };
          }
          chatLeaseId = began.leaseId;
        }
      } catch (error) {
        if (termLeaseId !== undefined) {
          ctx.termPlane.nodeDelete.finishNodeDelete(termLeaseId, "aborted");
        }
        if (chatLeaseId !== undefined) {
          ctx.chats.nodeDelete.finishNodeDelete(chatLeaseId, "aborted");
        }
        const runtime = ctx.pages();
        if (runtime !== undefined) {
          for (const ref of pageRefs) runtime.finishOverseerPageDelete(ref, leaseId);
        }
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      leases.set(leaseId, {
        id: leaseId,
        pageRefs: Object.freeze([...pageRefs]),
        ...(termLeaseId !== undefined ? { termLeaseId } : {}),
        ...(chatLeaseId !== undefined ? { chatLeaseId } : {}),
      });
      return {
        ok: true,
        leaseId,
        ...(termLeaseId !== undefined ? { termLeaseId } : {}),
        ...(chatLeaseId !== undefined ? { chatLeaseId } : {}),
        pageStops: Object.freeze(pageStops),
      };
    },
    finishOverseerNodeDelete: (leaseId, outcome) => {
      const id = leaseId.trim();
      if (id.length === 0) return { ok: false, error: "invalid lease id" };
      const lease = leases.get(id);
      if (lease === undefined) return { ok: true };
      const runtime = ctx.pages();
      if (runtime !== undefined) {
        for (const ref of lease.pageRefs) runtime.finishOverseerPageDelete(ref, id);
      }
      if (lease.termLeaseId !== undefined) {
        const finished = ctx.termPlane.nodeDelete.finishNodeDelete(lease.termLeaseId, outcome);
        if (!finished.ok) return finished;
      }
      if (lease.chatLeaseId !== undefined) {
        const finished = ctx.chats.nodeDelete.finishNodeDelete(lease.chatLeaseId, outcome);
        if (!finished.ok) return finished;
      }
      leases.delete(id);
      return { ok: true };
    },
  };
};

export type OverseerNative = OverseerNativeDeleteHooks & {
  readonly execute: (
    caller: OverseerCaller,
    request: OverseerRequest,
  ) => Effect.Effect<unknown, WorkErrorBody>;
  readonly executeResult: (
    caller: OverseerCaller,
    request: OverseerRequest,
  ) => Effect.Effect<OverseerResult>;
};

/**
 * Live constructor. Parent / composition worker constructs this after
 * TermPlane, ChatService, BrowserSessionService, and ManagedTerminalDrive exist.
 *
 * Fence identity: `termPlane.nodeDelete` and `chats.nodeDelete` are the same
 * instances renderer IPC uses. Do not construct a second TerminalNodeDeleteService
 * or chat NodeDeleteService.
 */
export const makeOverseerNativeLive = (
  options: OverseerNativeLiveOptions,
): OverseerNative => {
  const hooks = makeDeleteHooks({
    termPlane: options.termPlane,
    chats: options.chats,
    pages: () => options.pages,
  });

  const executeResult = (
    caller: OverseerCaller,
    request: OverseerRequest,
  ): Effect.Effect<OverseerResult> =>
    Effect.gen(function* () {
      if (!isOverseerNativeOperation(request.operation)) {
        return {
          ok: false as const,
          operation: request.operation,
          error: {
            type: "Unsupported" as const,
            message: `native adapter does not handle ${request.operation}`,
          },
        };
      }
      const outcome: NativeOutcome = yield* Effect.callback<NativeOutcome>(
        (resume, signal) => {
          const ctx: NativeContext = {
            ...options,
            now: options.now ?? Date.now,
            liveOverseerGrant: bindLiveGrant(options.liveOverseerGrant, signal),
            signal,
          };
          const flight = Promise.resolve(dispatchNative(ctx, caller, request));
          let settled = false;
          const finish = (result: NativeOutcome): void => {
            if (settled) return;
            settled = true;
            resume(Effect.succeed(result));
          };
          void flight.then(
            (value) => finish(value),
            (error) =>
              finish(
                fail(
                  "InternalError",
                  error instanceof Error ? error.message : String(error),
                ),
              ),
          );
          // Keep the Effect pending until the native flight (including lease
          // release) actually settles. AbortSignal only refuses later
          // mutations; it cannot roll back work already in flight.
          return Effect.promise(() =>
            flight.then(
              () => undefined,
              () => undefined,
            ),
          );
        },
      );
      return outcome.ok
        ? { ok: true as const, operation: request.operation, data: outcome.data }
        : { ok: false as const, operation: request.operation, error: outcome.error };
    });

  const execute = (
    caller: OverseerCaller,
    request: OverseerRequest,
  ): Effect.Effect<unknown, WorkErrorBody> =>
    executeResult(caller, request).pipe(
      Effect.flatMap((result) =>
        result.ok
          ? Effect.succeed(result.data)
          : Effect.fail(asWorkError(result.error)),
      ),
    );

  return {
    execute,
    executeResult,
    prepareOverseerNodeDelete: hooks.prepareOverseerNodeDelete,
    finishOverseerNodeDelete: hooks.finishOverseerNodeDelete,
  };
};

export const OVERSEER_PAGE_SESSION_OWNER = OVERSEER_PAGE_OWNER;
