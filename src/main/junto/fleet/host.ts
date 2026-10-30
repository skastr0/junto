/**
 * The host of this machine's canvas authorities (0.11/06 F2): one open
 * handle per canvas, opened as a batch first needs it. A handle is dropped
 * and the canvas opened again when it broke, and when the canvas it was
 * opened for is gone: a canvas deleted and made again under its name is
 * another canvas, with another id and its own log.
 *
 * Nothing drives ticks or carries messages yet; a canvas this machine rules
 * alone commits as it appends, which is every canvas until F6 lists a pair.
 */
import { Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { AuthorityMachineFacts, AuthorityMemberList, AuthorityRead } from "@shared/authority";
import type { InstallationId } from "@shared/installation-id";
import { MachineRepository } from "../machines/repository";
import { RulingRecorder } from "../work/ruling-recorder";
import { CanvasAuthorities } from "./authorities";
import { FleetDriverError, judgingCanvas, openCanvasAuthority, outsideTransactions, type CanvasAuthority } from "./driver";

export const makeCanvasAuthorities = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const recorder = yield* RulingRecorder;
  const machines = yield* MachineRepository;
  const held = new Map<string, { readonly authority: CanvasAuthority; readonly canvasId: string }>();
  const opening = Semaphore.makeUnsafe(1);

  /** The canvas's handle, as the canvas now stands: the one held, or a new one in place of a broken or stale one. */
  const authorityOf = (canvasName: string) =>
    opening.withPermits(1)(
      Effect.gen(function* () {
        const [row] = yield* sql<{ canvas_id: string }>`SELECT canvas_id FROM canvases WHERE canvas_name = ${canvasName}`.pipe(
          Effect.mapError((cause) => new FleetDriverError({ message: `the canvas ${canvasName} could not be read`, cause })),
        );
        const current = held.get(canvasName);
        if (current !== undefined && current.authority.usable() && current.canvasId === row?.canvas_id) return current.authority;
        if (current !== undefined) {
          // Closed before it is forgotten: a refused close leaves it held, never open and unheld.
          yield* current.authority.close();
          held.delete(canvasName);
        }
        if (row === undefined) return yield* Effect.fail(new FleetDriverError({ message: `there is no canvas ${canvasName}`, cause: canvasName }));
        const self: InstallationId = yield* machines.installationId.pipe(
          Effect.mapError((cause) => new FleetDriverError({ message: "this machine's installation could not be read", cause })),
        );
        const authority = yield* openCanvasAuthority({ canvasName, self }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(RulingRecorder, recorder),
        );
        held.set(canvasName, { authority, canvasId: row.canvas_id });
        return authority;
      }),
    );

  const failedRead = (message: string, cause: unknown) => new FleetDriverError({ message, cause });
  const asId = (id: string): InstallationId => id as InstallationId;
  const memberList = (members: {
    readonly list: ReadonlyArray<string>;
    readonly old?: ReadonlyArray<string>;
    readonly sole?: string;
  }): AuthorityMemberList => ({
    list: members.list.map(asId),
    ...(members.old === undefined ? {} : { old: members.old.map(asId) }),
    ...(members.sole === undefined ? {} : { sole: asId(members.sole) }),
  });

  /**
   * Names and reach for the machines on a list. This machine is `here`; a
   * pinned peer is named by its bound name but no link carries it yet, so it
   * reads `not-linked` until the link layer reports reach. A listed machine
   * this store does not know keeps its installation id.
   */
  const machineFacts = (ids: ReadonlyArray<InstallationId>): Effect.Effect<ReadonlyArray<AuthorityMachineFacts>, FleetDriverError> =>
    Effect.gen(function* () {
      const self = yield* machines.installationId.pipe(
        Effect.mapError((cause) => failedRead("this machine's installation could not be read", cause)),
      );
      const ownName = yield* machines.machineName.pipe(
        Effect.mapError((cause) => failedRead("this machine's name could not be read", cause)),
      );
      const peers = yield* machines.peers.pipe(
        Effect.mapError((cause) => failedRead("this machine's machines could not be read", cause)),
      );
      return ids.map((id): AuthorityMachineFacts => {
        if (id === self) return { installationId: id, name: ownName, label: ownName, reach: "here", since: null };
        const peer = peers.find((candidate) => candidate.installationId === id);
        const name = peer?.machineName ?? id;
        return { installationId: id, name, label: name, reach: "not-linked", since: null };
      });
    });

  const readOf = (canvasName: string): Effect.Effect<AuthorityRead, FleetDriverError> =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(canvasName);
      const status = authority.status();
      const self = yield* machines.installationId.pipe(
        Effect.mapError((cause) => failedRead("this machine's installation could not be read", cause)),
      );
      const [consensus] = yield* sql<{ last: number | null }>`
        SELECT last_applied_at_epoch_ms AS last FROM canvas_consensus WHERE canvas_name = ${canvasName}`.pipe(
        Effect.mapError((cause) => failedRead(`the authority of ${canvasName} could not be read`, cause)),
      );
      const [waiting] = yield* sql<{ total: number; commands: number; structure: number }>`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN kind = 'ruling' THEN 1 ELSE 0 END), 0) AS commands,
               COALESCE(SUM(CASE WHEN kind = 'structure.changed' THEN 1 ELSE 0 END), 0) AS structure
        FROM canvas_log_waiting WHERE canvas_name = ${canvasName}`.pipe(
        Effect.mapError((cause) => failedRead(`the changes kept for the operator on ${canvasName} could not be read`, cause)),
      );
      return {
        canvas: canvasName,
        self,
        role: status.role,
        term: status.term,
        leader: status.leader === null ? null : asId(status.leader),
        commit: status.commit,
        lastIndex: status.lastIndex,
        members: memberList(status.members),
        ...(status.pendingList === undefined ? {} : { pendingList: memberList(status.pendingList) }),
        fresh: status.fresh,
        canCommit: status.canCommit,
        lastCommitAt: consensus?.last ?? null,
        waitingForOperator: {
          total: waiting?.total ?? 0,
          commands: waiting?.commands ?? 0,
          structure: waiting?.structure ?? 0,
        },
        // No link carries a leader's heartbeat yet, so an authority on another machine is not heard here.
        authorityReachable: status.canCommit,
      } satisfies AuthorityRead;
    });

  const status = (canvasName?: string): Effect.Effect<ReadonlyArray<AuthorityRead>, FleetDriverError> =>
    canvasName === undefined
      ? sql<{ canvas_name: string }>`SELECT canvas_name FROM canvases ORDER BY canvas_name`.pipe(
        Effect.mapError((cause) => failedRead("this machine's canvases could not be read", cause)),
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => readOf(row.canvas_name))),
      )
      : Effect.map(readOf(canvasName), (read) => [read]);

  const setList = (canvasName: string, order: ReadonlyArray<string>): Effect.Effect<AuthorityRead, FleetDriverError> =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(canvasName);
      const self = yield* machines.installationId.pipe(
        Effect.mapError((cause) => failedRead("this machine's installation could not be read", cause)),
      );
      const ownName = yield* machines.machineName.pipe(
        Effect.mapError((cause) => failedRead("this machine's name could not be read", cause)),
      );
      const peers = yield* machines.peers.pipe(
        Effect.mapError((cause) => failedRead("this machine's machines could not be read", cause)),
      );
      const resolved = order.map((name): InstallationId | undefined =>
        name === ownName ? self : peers.find((peer) => peer.machineName === name)?.installationId,
      );
      const unknown = order.filter((_, at) => resolved[at] === undefined);
      if (unknown.length > 0) {
        return yield* Effect.fail(new FleetDriverError({ message: `there is no machine named ${unknown.join(", ")}`, cause: unknown }));
      }
      const list = resolved.filter((id): id is InstallationId => id !== undefined);
      if (new Set(list).size !== list.length) {
        return yield* Effect.fail(new FleetDriverError({ message: "a machine appears twice in the list", cause: order }));
      }
      yield* authority.proposeList(list);
      return yield* readOf(canvasName);
    });

  const alone = (canvasName: string): Effect.Effect<AuthorityRead, FleetDriverError> =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(canvasName);
      yield* authority.alone();
      return yield* readOf(canvasName);
    });

  /** This machine and every pinned peer, as the authority view names them. */
  const machinesView: Effect.Effect<{ self: AuthorityMachineFacts; machines: ReadonlyArray<AuthorityMachineFacts> }, FleetDriverError> =
    Effect.gen(function* () {
      const self = yield* machines.installationId.pipe(
        Effect.mapError((cause) => failedRead("this machine's installation could not be read", cause)),
      );
      const peers = yield* machines.peers.pipe(
        Effect.mapError((cause) => failedRead("this machine's machines could not be read", cause)),
      );
      const facts = yield* machineFacts([self, ...peers.map((peer) => peer.installationId)]);
      const own = facts.find((fact) => fact.installationId === self);
      if (own === undefined) return yield* Effect.fail(new FleetDriverError({ message: "this machine is not on its own machine list", cause: self }));
      return { self: own, machines: facts };
    });

  return CanvasAuthorities.of({
    status,
    setList,
    alone,
    machines: () => machinesView,
    judge: (canvasName, batch) =>
      Effect.flatMap(judgingCanvas, (outer) =>
        outer !== undefined
          // Opened inside a batch, a canvas's log would begin in a savepoint that rolls back.
          ? Effect.fail(new FleetDriverError({ message: `a batch for ${outer} reached the authority of ${canvasName}: a batch is judged by one canvas, and drives no authority itself`, cause: { outer, canvasName } }))
          : outsideTransactions(sql, canvasName).pipe(
            Effect.andThen(authorityOf(canvasName)),
            Effect.flatMap((authority) => authority.judge(batch)),
          )),
    // A canvas gone or not opened is a wait to try again, as a break is.
    landed: (canvasName, entry) =>
      authorityOf(canvasName).pipe(
        Effect.mapError((error) => new FleetDriverError({ message: error.message, cause: error.cause, retryable: true })),
        Effect.flatMap((authority) => authority.landed(entry)),
      ),
  });
});

export const CanvasAuthoritiesLive: Layer.Layer<CanvasAuthorities, never, SqlClient.SqlClient | RulingRecorder | MachineRepository> =
  Layer.effect(CanvasAuthorities, makeCanvasAuthorities);
