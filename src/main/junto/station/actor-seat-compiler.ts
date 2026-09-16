import { createHash } from "node:crypto";
import { Result, SchemaIssue, Schema } from "effect";
import { ActorSeatId, type ActorSeatId as ActorSeatIdValue } from "@shared/actor-seat";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import {
  EtherTerminalLaunch,
  type CanvasDoc,
  type EtherTerminalLaunch as EtherTerminalLaunchValue,
} from "@shared/canvas";
import { isCanonicalCanvasName } from "@shared/canvas-name";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "@shared/installation-id";
import { HarnessId } from "@shared/managed-terminal-templates";
import { StationHostId } from "@shared/station-api";
import { SinkRef } from "@shared/work-protocol";

export const ACTOR_SEAT_ID_PROTOCOL = "junto/actor-seat/v1" as const;

export const ActorSeatCanvasRef = SinkRef;
export type ActorSeatCanvasRef = typeof ActorSeatCanvasRef.Type;

/**
 * Projection-only description of one executable actor principal.
 *
 * Canvas references retain capability geography. The execution descriptor is
 * held once so aliases cannot silently disagree about which process they name.
 */
export const ProjectedActorSeat = Schema.Struct({
  seatId: ActorSeatId,
  authorityInstallationId: InstallationId,
  hostId: StationHostId,
  overseer: Schema.optionalKey(Schema.Literal(true)),
  bindingId: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(512))),
  agentKey: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(512))),
  harness: HarnessId,
  launch: Schema.optionalKey(EtherTerminalLaunch),
  sessionId: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(512)))),
  primaryRef: ActorSeatCanvasRef,
  refs: Schema.Array(ActorSeatCanvasRef),
});
export type ProjectedActorSeat = typeof ProjectedActorSeat.Type;

const ProjectedActorSeatRegistry = Schema.Array(ProjectedActorSeat);

export const ActorSeatCompilationReason = Schema.Literals(["invalid-actor", "invalid-binding",
"invalid-reference",
"invalid-topology",
"unresolved-placement",
"duplicate-reference",
"conflicting-descriptor",
"identity-conflict",
"invalid-registry",
"unsorted-registry",]);
export type ActorSeatCompilationReason =
  typeof ActorSeatCompilationReason.Type;

export class ActorSeatCompilationError extends Schema.TaggedError<ActorSeatCompilationError>()(
  "ActorSeatCompilationError",
  {
    reason: ActorSeatCompilationReason,
    message: Schema.String,
  },
) {}

type ActorSeatExecutableDescriptor = Omit<
  ProjectedActorSeat,
  "seatId" | "primaryRef" | "refs"
>;

type MutableActorSeat = {
  readonly descriptor: ActorSeatExecutableDescriptor;
  readonly descriptorKey: string;
  readonly refs: Array<ActorSeatCanvasRef>;
};

type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

const fail = (
  reason: ActorSeatCompilationReason,
  message: string,
): never => {
  throw ActorSeatCompilationError.make({ reason, message });
};

/** Code-unit order is locale-independent on every installation. */
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareRefs = (
  left: ActorSeatCanvasRef,
  right: ActorSeatCanvasRef,
): number =>
  compareText(left.canvasName, right.canvasName) ||
  compareText(left.nodeId, right.nodeId);

const sameRef = (
  left: ActorSeatCanvasRef,
  right: ActorSeatCanvasRef,
): boolean =>
  left.canvasName === right.canvasName && left.nodeId === right.nodeId;

const canonicalJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fail("invalid-registry", "actor-seat data contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (typeof value === "object") {
    const canonical: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareText)) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) canonical[key] = canonicalJsonValue(member);
    }
    return canonical;
  }
  return fail(
    "invalid-registry",
    `actor-seat data cannot encode ${typeof value}`,
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalJsonValue(value));

const canonicalLaunch = (
  launch: EtherTerminalLaunchValue | undefined,
): EtherTerminalLaunchValue | undefined => {
  if (launch === undefined) return undefined;
  return {
    kind: launch.kind,
    ...(launch.argv === undefined ? {} : { argv: [...launch.argv] }),
    ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
    ...(launch.env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(launch.env).sort(([left], [right]) =>
              compareText(left, right)
            ),
          ),
        }),
  };
};

const decodeRegistryStructure = (
  input: unknown,
): ReadonlyArray<ProjectedActorSeat> => {
  const decoded = Schema.decodeUnknownResult(ProjectedActorSeatRegistry, {
    onExcessProperty: "error",
  })(input);
  if (Result.isFailure(decoded)) {
    return fail(
      "invalid-registry",
      String(decoded.failure),
    );
  }
  return decoded.success;
};

/**
 * Stable seat identity. This is an identity encoding, not a credential.
 */
export const deriveActorSeatId = (
  authorityInstallationId: InstallationIdValue,
  bindingId: string,
): ActorSeatIdValue => {
  const canonicalBindingId = bindingId.trim();
  if (canonicalBindingId.length === 0) {
    return fail("invalid-binding", "actor bindingId must be non-empty");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        ACTOR_SEAT_ID_PROTOCOL,
        authorityInstallationId,
        canonicalBindingId,
      ]),
      "utf8",
    )
    .digest("hex");
  return Schema.decodeUnknownSync(ActorSeatId)(`seat_${digest}`);
};

const descriptorFor = (
  authorityInstallationId: InstallationIdValue,
  surface: NonNullable<ReturnType<typeof actorDeliverySurfaceOf>>,
  sessionId: string | undefined,
  overseer: boolean | undefined,
): ActorSeatExecutableDescriptor => {
  const decodedHostId = Schema.decodeUnknownResult(StationHostId)(surface.hostId);
  if (Result.isFailure(decodedHostId)) {
    return fail(
      "invalid-topology",
      `actor host ${JSON.stringify(surface.hostId)} is not a canonical HostId`,
    );
  }
  const canonicalSessionId = sessionId?.trim();
  return {
    authorityInstallationId,
    hostId: decodedHostId.success,
    ...(overseer === true ? { overseer: true as const } : {}),
    bindingId: surface.bindingId,
    agentKey: surface.agentKey,
    harness: surface.harness,
    ...(surface.launch === undefined
      ? {}
      : { launch: canonicalLaunch(surface.launch) }),
    ...(canonicalSessionId === undefined || canonicalSessionId.length === 0
      ? {}
      : { sessionId: canonicalSessionId }),
  };
};

/**
 * Compile the complete deterministic actor registry for one portfolio.
 *
 * The topology map is explicit policy input. The compiler never reaches into
 * fleet state and never infers durable authority from HostId.
 */
export const compileActorSeatRegistry = (
  documents: ReadonlyMap<string, CanvasDoc>,
  installationByHostId: ReadonlyMap<string, InstallationIdValue>,
): ReadonlyArray<ProjectedActorSeat> => {
  const groups = new Map<string, MutableActorSeat>();

  for (
    const [canvasName, document] of [...documents.entries()].sort(
      ([left], [right]) => compareText(left, right),
    )
  ) {
    if (!isCanonicalCanvasName(canvasName)) {
      return fail(
        "invalid-reference",
        `actor reference uses invalid canvas name ${JSON.stringify(canvasName)}`,
      );
    }
    const identitiesOnCanvas = new Set<string>();
    for (const node of document.nodes) {
      if (node.ether?.entity?.kind !== "agent") continue;
      const surface = actorDeliverySurfaceOf(node);
      if (surface === undefined) {
        return fail(
          "invalid-actor",
          `actor "${canvasName}/${node.id}" has no complete managed execution surface`,
        );
      }
      const authorityInstallationId = installationByHostId.get(surface.hostId);
      if (authorityInstallationId === undefined) {
        return fail(
          "unresolved-placement",
          `actor "${canvasName}/${node.id}" is placed on unresolved host ${JSON.stringify(surface.hostId)}`,
        );
      }
      if (!Schema.is(InstallationId)(authorityInstallationId)) {
        return fail(
          "invalid-topology",
          `host ${JSON.stringify(surface.hostId)} maps to an invalid InstallationId`,
        );
      }

      const identityKey = JSON.stringify([
        authorityInstallationId,
        surface.bindingId,
      ]);
      if (identitiesOnCanvas.has(identityKey)) {
        return fail(
          "duplicate-reference",
          `actor seat "${surface.bindingId}" appears more than once on canvas "${canvasName}"`,
        );
      }
      identitiesOnCanvas.add(identityKey);

      const descriptor = descriptorFor(
        authorityInstallationId,
        surface,
        node.ether?.terminal?.sessionId,
        node.ether?.overseer,
      );
      const descriptorKey = canonicalJson(descriptor);
      const existing = groups.get(identityKey);
      if (
        existing !== undefined &&
        existing.descriptorKey !== descriptorKey
      ) {
        return fail(
          "conflicting-descriptor",
          `actor seat "${surface.bindingId}" has conflicting executable descriptors across canvas references`,
        );
      }
      const decodedRef = Schema.decodeUnknownResult(ActorSeatCanvasRef)({
        canvasName,
        nodeId: node.id,
      });
      if (Result.isFailure(decodedRef)) {
        return fail(
          "invalid-reference",
          `actor "${canvasName}/${node.id}" cannot be represented as a canonical SinkRef`,
        );
      }
      const ref = decodedRef.success;
      if (existing === undefined) {
        groups.set(identityKey, {
          descriptor,
          descriptorKey,
          refs: [ref],
        });
      } else {
        existing.refs.push(ref);
      }
    }
  }

  const seatIds = new Map<ActorSeatIdValue, string>();
  const registry = [...groups.entries()].map(([identityKey, group]) => {
    const refs = [...group.refs].sort(compareRefs);
    const seatId = deriveActorSeatId(
      group.descriptor.authorityInstallationId,
      group.descriptor.bindingId,
    );
    const establishedIdentity = seatIds.get(seatId);
    if (
      establishedIdentity !== undefined &&
      establishedIdentity !== identityKey
    ) {
      return fail(
        "identity-conflict",
        `derived actor seat identity "${seatId}" names more than one executable principal`,
      );
    }
    seatIds.set(seatId, identityKey);
    return {
      seatId,
      ...group.descriptor,
      primaryRef: refs[0]!,
      refs,
    } satisfies ProjectedActorSeat;
  });

  return decodeRegistryStructure(
    registry.sort((left, right) => compareText(left.seatId, right.seatId)),
  );
};

/** Strict structural decode before cross-record portfolio validation. */
export const decodeActorSeatRegistry = (
  input: unknown,
): ReadonlyArray<ProjectedActorSeat> => decodeRegistryStructure(input);

/**
 * Validate that an inbound registry is sorted, complete, and exactly describes
 * the managed actor surfaces in the projected documents.
 */
export const validateActorSeatRegistry = (
  documents: ReadonlyMap<string, CanvasDoc>,
  registry: ReadonlyArray<ProjectedActorSeat>,
): ReadonlyArray<ProjectedActorSeat> => {
  const installationByHostId = new Map<string, InstallationIdValue>();
  let previousSeatId: ActorSeatIdValue | undefined;

  for (const seat of registry) {
    if (
      previousSeatId !== undefined &&
      compareText(previousSeatId, seat.seatId) >= 0
    ) {
      return fail(
        "unsorted-registry",
        "projection actor seats are not strictly sorted by seatId",
      );
    }
    previousSeatId = seat.seatId;

    if (seat.refs.length === 0) {
      return fail(
        "invalid-registry",
        `actor seat "${seat.seatId}" has no canvas references`,
      );
    }
    if (!sameRef(seat.primaryRef, seat.refs[0]!)) {
      return fail(
        "invalid-registry",
        `actor seat "${seat.seatId}" primaryRef is not its first sorted reference`,
      );
    }

    let previousRef: ActorSeatCanvasRef | undefined;
    const canvases = new Set<string>();
    for (const ref of seat.refs) {
      if (previousRef !== undefined && compareRefs(previousRef, ref) >= 0) {
        return fail(
          "unsorted-registry",
          `actor seat "${seat.seatId}" references are not strictly sorted`,
        );
      }
      if (canvases.has(ref.canvasName)) {
        return fail(
          "duplicate-reference",
          `actor seat "${seat.seatId}" appears more than once on canvas "${ref.canvasName}"`,
        );
      }
      previousRef = ref;
      canvases.add(ref.canvasName);
    }

    const expectedSeatId = deriveActorSeatId(
      seat.authorityInstallationId,
      seat.bindingId,
    );
    if (expectedSeatId !== seat.seatId) {
      return fail(
        "identity-conflict",
        `actor seat "${seat.seatId}" does not match its installation and binding identity`,
      );
    }
    const establishedHome = installationByHostId.get(seat.hostId);
    if (
      establishedHome !== undefined &&
      establishedHome !== seat.authorityInstallationId
    ) {
      return fail(
        "invalid-topology",
        `host ${JSON.stringify(seat.hostId)} maps to conflicting InstallationIds`,
      );
    }
    installationByHostId.set(
      seat.hostId,
      seat.authorityInstallationId,
    );
  }

  const expected = compileActorSeatRegistry(
    documents,
    installationByHostId,
  );
  if (canonicalJson(expected) !== canonicalJson(registry)) {
    return fail(
      "invalid-registry",
      "projection actor registry does not exactly describe its canvas actors",
    );
  }
  return expected;
};
