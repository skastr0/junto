/**
 * proto-harness.ts — PROTO-1..9 protocol-loop test harness.
 *
 * The CUSTOMER-REPORT protocol defects (inject flood, inject-vs-admission
 * mismatch, re-drive loop) all live at the boundary between the canvas change
 * stream and the managed-terminal seat transport. This harness reproduces that
 * stack with REAL production classes:
 *
 *   canvases commit (CanvasesService.write — SQLite via StateEngine)
 *     -> subscribeChanges listener wired exactly like src/main/vellum/ipc.ts:987-991
 *     -> onCanvasChangeForEdgeMap -> deliverEdgeMapChangeNotices (real)
 *     -> WorkService.workSystemMailboxNotify (real, Command-Center gate)
 *     -> repository.appendMessage (real overlay projection)
 *     -> messageDelivery.notifyAppended (REAL singleton, same import service.ts uses)
 *     -> attemptOne -> transport.sendManagedTerminalPrompt -> REAL ManagedTerminalDrive
 *     -> ScriptedTui byte model -> REAL SessionObserver -> REAL SeatStateRuntime
 *
 * Fakes (documented; all at allowed boundaries):
 *  - node:os homedir -> temp dir (persistence boundary; pattern from
 *    tests/b5-races-canvases.test.ts).
 *  - ScriptedTui in-process TUI (PTY-process boundary; pattern from
 *    tests/pty-e2e/scripted-tui.ts, grounded in the 2026-08 managed-terminal probe reports).
 *  - vi fake timers for drive/observer clocks (clock boundary).
 *  - "wedged PTY" mode on the drive's writeFn: a paste write returns false,
 *    modelling a real PTY write failure (the drive reports write-failed and
 *    the message stays pending). This is the OS-boundary fake that makes the
 *    re-drive loop observable deterministically.
 *  - The delivery store implements the real MessageDeliveryStore interface
 *    over the REAL WorkRepository + canvases, replicating the production
 *    wiring at src/main/vellum/ipc.ts:1338-1405 (mailboxMessageDeliveryId
 *    receipts, authorial intent basis). No fake persistence.
 *
 * NOT faked: planEdgeMapChanges, composeEdgeMapChangeNotice,
 * deliverEdgeMapChangeNotices, WorkService, WorkRepository, CanvasesService,
 * PausePlane, MessageDeliveryService, ManagedTerminalDrive, SessionObserver,
 * SeatStateRuntime.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import type { CanvasDoc, Message } from "../../src/shared/canvas";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import { SessionObserver } from "../../src/main/vellum/term/observer";
import { SeatStateRuntime } from "../../src/main/vellum/term/agent-state/runtime";
import { ManagedTerminalDrive } from "../../src/main/vellum/term/drive";
import { ScriptedTui, type TuiHarness, type DriveLoopOptions } from "./scripted-tui";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  CR,
} from "../../src/main/vellum/term/drive/typing";
import { CanvasesLive, CanvasesService } from "../../src/main/vellum/canvases";
import { makeStateEngineLive } from "../../src/main/vellum/state/engine";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../../src/main/vellum/work/repository";
import { WorkLive, WorkService } from "../../src/main/vellum/work/service";
import { StationRepositoryLive } from "../../src/main/vellum/station/repository";
import { StationFleetTargetRepositoryLive } from "../../src/main/vellum/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../../src/main/vellum/station/session-registry";
import { SettingsLive, SettingsService } from "../../src/main/vellum/settings/service";
import { makeContentServiceLive } from "../../src/main/vellum/content/service";
import { makeInstallOpsLive } from "../../src/main/vellum/install-ops/engine";
import {
  FactoryPauseRepositoryLive,
} from "../../src/main/vellum/pause/repository";
import { PausePlane, PausePlaneLive } from "../../src/main/vellum/pause-plane";
import {
  messageDelivery,
  type MessageDeliveryTransport,
} from "../../src/main/vellum/work/message-delivery";
import { deliverEdgeMapChangeNotices, onCanvasChangeForEdgeMap } from "../../src/main/vellum/work/edge-map-notify";
import {
  mailboxMessageDeliveryId,
  mailboxMessageReadId,
} from "../../src/main/vellum/work/mailbox-receipts";
import { IntentFactBasis, type ActorRef } from "../../src/shared/work-protocol";
import { seatPaused } from "../../src/shared/pause";

export const makeProtoRuntime = (root: string) => {
  const stateLive = makeStateEngineLive(join(root, "state", "vellum-command.db"));
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
      FactoryPauseRepositoryLive,
      makeContentServiceLive({
        root: join(root, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
  const workLive = Layer.provideMerge(
    WorkLive,
    Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive),
  );
  const pauseLive = Layer.provideMerge(PausePlaneLive, repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(workLive, pauseLive));
};

export type SeatLoopOptions = {
  readonly bindingId?: string;
  readonly epoch?: string;
  readonly harness?: TuiHarness;
  readonly now: () => number;
  readonly stallTimeoutMs?: number;
  readonly pasteToCrSettleMs?: number;
  readonly tui?: DriveLoopOptions["tui"];
  readonly drive?: DriveLoopOptions["drive"];
  readonly cols?: number;
  readonly rows?: number;
  /** PTY write-failure mode: paste writes return false while wedged. */
  readonly wedged?: boolean;
};

export type LoopWrite = {
  readonly t: number;
  readonly data: string;
  /** True when the PTY fake refused this write (wedged paste). */
  readonly refused?: boolean;
};

/**
 * Full production loop for the protocol harness — same wiring as
 * src/main/vellum/ipc.ts: drive.write → TUI byte model → real SessionObserver
 * → SeatStateRuntime; working → drive.onTurnStart, idle → drive.onSeatIdle +
 * messageDelivery.onManagedTerminalIdle (ipc.ts:1289-1294). The drive writeFn
 * is the OS-boundary: it forwards to the ScriptedTui but can be wedged
 * (paste writes return false) to model a PTY write failure.
 */
export class ProtoSeatLoop {
  readonly bindingId: string;
  readonly epoch: string;
  readonly observer: SessionObserver;
  readonly runtime: SeatStateRuntime;
  readonly tui: ScriptedTui;
  readonly drive: ManagedTerminalDrive;
  readonly writes: LoopWrite[] = [];
  readonly events: AgentSeatStateEvent[] = [];
  readonly attention: Array<{ readonly t: number; readonly reason: string }> = [];
  /** true while the PTY fake refuses paste writes (write-failed). */
  wedged: boolean;

  private seq = 0n;
  private readonly now: () => number;
  private readonly unsub: () => void;

  constructor(options: SeatLoopOptions) {
    this.bindingId = options.bindingId ?? "seat-b1";
    this.epoch = options.epoch ?? "gen-1";
    this.now = options.now;
    this.wedged = options.wedged ?? false;
    this.observer = new SessionObserver({
      bindingId: this.bindingId,
      epoch: this.epoch,
      cols: options.cols ?? 60,
      rows: options.rows ?? 24,
    });
    this.runtime = new SeatStateRuntime({ now: this.now });
    this.tui = new ScriptedTui({
      ...options.tui,
      harness: options.harness ?? options.tui?.harness ?? "claude",
      emit: (data) => {
        this.seq += 1n;
        this.observer.feed(data, this.seq);
      },
      now: this.now,
      schedule: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(t) };
      },
    });
    const writeFn = (bindingId: string, data: string): boolean => {
      const refused = this.wedged && data.includes(BRACKETED_PASTE_START);
      this.writes.push({ t: this.now(), data, refused });
      if (refused) return false;
      return this.tui.write(data);
    };
    this.drive = new ManagedTerminalDrive({
      ...options.drive,
      write: writeFn,
      isSeatIdle: () => this.runtime.isSeatIdle(this.bindingId),
      onAttention: (_bindingId, reason) => {
        this.attention.push({ t: this.now(), reason });
      },
      now: this.now,
      stallTimeoutMs: options.stallTimeoutMs,
      pasteToCrSettleMs: options.pasteToCrSettleMs,
    });
    this.unsub = this.observer.subscribe((snap) => {
      const event = this.runtime.observe(snap);
      if (event) {
        this.events.push(event);
        if (event.state === "working") this.drive.onTurnStart(event.bindingId);
        if (event.state === "idle") {
          this.drive.onSeatIdle(event.bindingId);
          // ipc.ts:1290 — every real idle transition re-drives pending mail.
          void messageDelivery.onManagedTerminalIdle(event.bindingId);
        }
      }
    });
    this.runtime.bindHarness(
      this.bindingId,
      options.harness ?? options.tui?.harness ?? "claude",
      this.epoch,
    );
    this.tui.boot();
  }

  /** Paste writes seen by the drive (payloads the delivery path actually sent). */
  pastePayloads(): string[] {
    return this.pasteWrites().map((w) => this.payloadOf(w.data));
  }

  /** Paste payloads the PTY accepted (refused/wedged attempts excluded). */
  deliveredPastePayloads(): string[] {
    return this.pasteWrites()
      .filter((w) => w.refused !== true)
      .map((w) => this.payloadOf(w.data));
  }

  private payloadOf(data: string): string {
    const start = data.indexOf(BRACKETED_PASTE_START) + BRACKETED_PASTE_START.length;
    const end = data.indexOf(BRACKETED_PASTE_END, start);
    return data.slice(start, end < 0 ? undefined : end);
  }

  pasteWrites(): LoopWrite[] {
    return this.writes.filter((w) => w.data.includes(BRACKETED_PASTE_START));
  }

  /** One real working→idle turn cycle (drives an idle event through the observer). */
  async runTurn(advance: (ms: number) => Promise<void>, flush: () => Promise<void>): Promise<void> {
    this.tui.write(`${BRACKETED_PASTE_START}status${BRACKETED_PASTE_END}`);
    this.tui.write(CR);
    await advance(1_100);
    await flush();
  }

  dispose(): void {
    this.unsub();
    this.tui.dispose();
    this.runtime.stop();
    this.observer.dispose();
  }
}

export type ProtoHarnessOptions = {
  readonly root: string;
  readonly loop?: boolean;
  readonly harness?: TuiHarness;
  readonly now?: () => number;
  readonly stallTimeoutMs?: number;
  readonly pasteToCrSettleMs?: number;
  readonly tui?: DriveLoopOptions["tui"];
  readonly drive?: DriveLoopOptions["drive"];
  readonly wedged?: boolean;
  /**
   * Wire the canvases change listener to onCanvasChangeForEdgeMap exactly
   * like ipc.ts:987-991 (auto-generates notices on authorial writes).
   */
  readonly wireChangeListener?: boolean;
};

export class ProtoHarness {
  readonly root: string;
  readonly runtime: ReturnType<typeof makeProtoRuntime>;
  readonly canvases!: Context.Service.Shape<typeof CanvasesService>;
  readonly work!: Context.Service.Shape<typeof WorkService>;
  readonly repository!: Context.Service.Shape<typeof WorkRepository>;
  readonly pause!: Context.Service.Shape<typeof PausePlane>;
  readonly settings!: Context.Service.Shape<typeof SettingsService>;
  readonly loop: ProtoSeatLoop | undefined;
  readonly transport: MessageDeliveryTransport;
  /** Every payload handed to sendManagedTerminalPrompt (recording boundary). */
  readonly deliveredPayloads: string[] = [];

  private unsubChanges: (() => void) | undefined;
  private readonly wireChangeListener: boolean;
  private disposed = false;

  constructor(options: ProtoHarnessOptions) {
    this.root = options.root;
    this.runtime = makeProtoRuntime(options.root);
    this.transport = {
      wakeManagedSeat: async () => true,
      sendManagedTerminalPrompt: async (bindingId, text) => {
        this.deliveredPayloads.push(text);
        if (this.loop && this.loop.bindingId === bindingId) {
          return this.loop.drive.writePrompt(bindingId, text, { ready: true });
        }
        return false;
      },
    };
    this.loop = options.loop
      ? new ProtoSeatLoop({
          harness: options.harness ?? "claude",
          now: options.now ?? (() => Date.now()),
          stallTimeoutMs: options.stallTimeoutMs,
          pasteToCrSettleMs: options.pasteToCrSettleMs,
          tui: options.tui,
          drive: options.drive,
          wedged: options.wedged,
        })
      : undefined;
    // Singleton delivery service: same instance service.ts calls from
    // workSystemMailboxNotify. Configure per harness; reset on dispose.
    messageDelivery.resetForTest();
    this.wireChangeListener = options.wireChangeListener ?? false;
  }

  /** Initialize the service handles (must run before any use). */
  async start(): Promise<void> {
    const [canvases, work, repository, pause, settings] = await Promise.all([
      this.runtime.runPromise(CanvasesService),
      this.runtime.runPromise(WorkService),
      this.runtime.runPromise(WorkRepository),
      this.runtime.runPromise(PausePlane),
      this.runtime.runPromise(SettingsService),
    ]);
    (this as { canvases: unknown }).canvases = canvases;
    (this as { work: unknown }).work = work;
    (this as { repository: unknown }).repository = repository;
    (this as { pause: unknown }).pause = pause;
    (this as { settings: unknown }).settings = settings;
    await this.runtime.runPromise(this.pause.start);
    this.canvases.start();
    if (this.wireChangeListener) {
      // ipc.ts:987-991 — ONE edge-notification theory per authorial commit.
      this.unsubChanges = this.canvases.subscribeChanges((name, detail) => {
        void this.runtime.runPromise(onCanvasChangeForEdgeMap(name, detail));
      });
    }
    this.configureDelivery();
  }

  private configureDelivery(): void {
    const runtime = this.runtime;
    const deliveryStore = {
      listCanvasNames: () =>
        runtime.runPromise(
          this.canvases.list.pipe(Effect.map((entries) => entries.map((e) => e.name))),
        ),
      readDoc: (name: string) =>
        runtime.runPromise(
          this.canvases.read(name).pipe(
            Effect.map((r) => r.doc),
            Effect.catch(() => Effect.succeed(undefined as CanvasDoc | undefined)),
          ),
        ),
      // Same real service the app wires, so the protocol scenarios exercise
      // the node-scoped routing read rather than a hand-written stand-in.
      readNodeStructure: (name: string, nodeId: string) =>
        runtime.runPromise(
          this.canvases
            .readNodeStructure(name, nodeId)
            .pipe(
              Effect.map((found) =>
                found === undefined
                  ? undefined
                  : { node: found.node, structure: found.structure },
              ),
            ),
        ),
      hasAcceptedMessageDelivery: (canvas: string, nodeId: string, messageId: string) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const repo = yield* WorkRepository;
            return yield* repo.hasAcceptedDelivery(
              { canvasName: canvas, nodeId },
              mailboxMessageDeliveryId(canvas, nodeId, messageId),
            );
          }).pipe(Effect.catch(() => Effect.succeed(false))),
        ),
      hasAcceptedMessageRead: (canvas: string, nodeId: string, messageId: string) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const repo = yield* WorkRepository;
            return yield* repo.hasAcceptedDelivery(
              { canvasName: canvas, nodeId },
              mailboxMessageReadId(canvas, nodeId, messageId),
            );
          }).pipe(Effect.catch(() => Effect.succeed(false))),
        ),
      acceptMessageDelivery: async (canvas: string, nodeId: string, messageId: string) => {
        try {
          const canvases = this.canvases;
          const accept = Effect.gen(function* () {
            const repo = yield* WorkRepository;
            const sink = { canvasName: canvas, nodeId };
            const deliveryId = mailboxMessageDeliveryId(canvas, nodeId, messageId);
            if (yield* repo.hasAcceptedDelivery(sink, deliveryId)) return true;
            const read = yield* canvases.read(canvas);
            const actor = read.actorRefs.find(
              (ref) => ref.canvasName === canvas && ref.nodeId === nodeId,
            );
            if (actor === undefined) return false;
            const witness = yield* canvases.activeIntentWitness();
            const basis = Schema.decodeUnknownSync(IntentFactBasis)({
              kind: "authorial-intent",
              generation: witness.generation,
              contentSha256: witness.contentSha256,
            });
            yield* repo.acceptDelivery({
              sink,
              basis,
              receipt: {
                deliveryId,
                deliveredItem: {
                  kind: "message",
                  itemId: messageId,
                  sink,
                },
                actor: actor as ActorRef,
                acceptedAt: new Date().toISOString(),
              },
            });
            return true;
          });
          return await runtime.runPromise(
            accept as Effect.Effect<boolean, unknown, never>,
          );
        } catch {
          return false;
        }
      },
      acceptMessageRead: async (canvas: string, nodeId: string, messageId: string) => {
        try {
          const canvases = this.canvases;
          const accept = Effect.gen(function* () {
            const repo = yield* WorkRepository;
            const sink = { canvasName: canvas, nodeId };
            const deliveryId = mailboxMessageReadId(canvas, nodeId, messageId);
            if (yield* repo.hasAcceptedDelivery(sink, deliveryId)) return true;
            const read = yield* canvases.read(canvas);
            const actor = read.actorRefs.find(
              (ref) => ref.canvasName === canvas && ref.nodeId === nodeId,
            );
            if (actor === undefined) return false;
            const witness = yield* canvases.activeIntentWitness();
            const basis = Schema.decodeUnknownSync(IntentFactBasis)({
              kind: "authorial-intent",
              generation: witness.generation,
              contentSha256: witness.contentSha256,
            });
            yield* repo.acceptDelivery({
              sink,
              basis,
              receipt: {
                deliveryId,
                deliveredItem: {
                  kind: "message",
                  itemId: messageId,
                  sink,
                },
                actor: actor as ActorRef,
                acceptedAt: new Date().toISOString(),
              },
            });
            return true;
          });
          return await runtime.runPromise(
            accept as Effect.Effect<boolean, unknown, never>,
          );
        } catch {
          return false;
        }
      },
    };
    messageDelivery.configure({
      transport: this.transport,
      store: deliveryStore,
      now: () => Date.now(),
      seatPaused: (canvas, doc, nodeId) =>
        seatPaused(this.pause.stateFor(canvas), doc, nodeId),
    });
  }

  /** Play the canvas — the factory pause law: canvases are born paused and
   * delivery is seatPaused-gated, so delivery scenarios must play the canvas
   * exactly as an operator does before the factory runs. */
  async playCanvas(name: string): Promise<void> {
    await this.runtime.runPromise(this.pause.setPlaying(name, true));
  }

  async setStationCommandCenter(): Promise<void> {
    await this.runtime.runPromise(
      this.settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );
  }

  async writeDoc(name: string, doc: CanvasDoc): Promise<void> {
    await this.runtime.runPromise(this.canvases.write(name, doc));
  }

  async readDoc(name: string): Promise<CanvasDoc | undefined> {
    const read = await this.runtime.runPromise(
      this.canvases.read(name).pipe(Effect.catch(() => Effect.succeed(undefined))),
    );
    return read?.doc;
  }

  /** Real deliverEdgeMapChangeNotices over the real WorkService. */
  async notifyEdgeMap(canvas: string, previous: CanvasDoc, next: CanvasDoc): Promise<number> {
    return this.runtime.runPromise(
      deliverEdgeMapChangeNotices({ canvas, previous, next }),
    );
  }

  /** Pending (unreceipted) edge-map notices in one seat's mailbox. */
  async pendingEdgeNotices(canvas: string, seatId?: string): Promise<
    Array<{ readonly nodeId: string; readonly message: Message }>
  > {
    const doc = await this.readDoc(canvas);
    if (!doc) return [];
    const out: Array<{ nodeId: string; message: Message }> = [];
    for (const node of doc.nodes) {
      if (seatId !== undefined && node.id !== seatId) continue;
      for (const message of node.ether?.messages?.items ?? []) {
        if (message.metadata?.edgeMapChange === true) {
          out.push({ nodeId: node.id, message });
        }
      }
    }
    return out;
  }

  async hasReceipt(canvas: string, nodeId: string, messageId: string): Promise<boolean> {
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* WorkRepository;
        return yield* repo.hasAcceptedDelivery(
          { canvasName: canvas, nodeId },
          mailboxMessageDeliveryId(canvas, nodeId, messageId),
        );
      }).pipe(Effect.catch(() => Effect.succeed(false))),
    );
  }

  /** Let fire-and-forget attempts (notifyAppended -> attemptOne) settle. */
  async settle(ms = 50): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubChanges?.();
    this.loop?.dispose();
    messageDelivery.resetForTest();
    await this.runtime.dispose();
    await rm(this.root, { recursive: true, force: true });
  }
}

/** One temp root per harness (persistence boundary). */
export const makeProtoRoot = (label: string): string =>
  join(tmpdir(), `vellum-proto-${label}-${randomUUID()}`);
