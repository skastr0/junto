import { Schema } from "effect";
import {
  containsWorkProjection,
  decodeCanvasDoc,
  scrubCanvasDocInput,
  serializeCanvas,
  type CanvasDoc,
} from "@shared/canvas";
import { isCanonicalCanvasName } from "@shared/canvas-name";
import type { InstallationId } from "@shared/installation-id";
import { remoteStationContractVersion } from "@shared/remote-station-release";
import { STATION_API_MAX_PROJECTION_CHARS } from "@shared/station-api";
import {
  ActorSeatCompilationError,
  compileActorSeatRegistry,
  decodeActorSeatRegistry,
  validateActorSeatRegistry,
  type ProjectedActorSeat,
} from "./actor-seat-compiler";

export const STATION_PORTFOLIO_PROTOCOL_VERSION =
  remoteStationContractVersion("Station portfolio projection", 1);
export const STATION_PORTFOLIO_PROTOCOL =
  `vellum-command/station-portfolio/v${STATION_PORTFOLIO_PROTOCOL_VERSION}` as const;
/** Frozen v1 SQLite fixtures retain this body; never emit or negotiate it. */
const LEGACY_STATION_PORTFOLIO_PROTOCOL =
  "vellum/station-portfolio/v2" as const;
export const STATION_PORTFOLIO_MAX_CANVASES = 256;
export const STATION_PORTFOLIO_MAX_ACTOR_SEATS = 16_384;

export class StationPortfolioError extends Schema.TaggedErrorClass<StationPortfolioError>()(
  "StationPortfolioError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

type StationPortfolioDocument = {
  readonly name: string;
  readonly body: string;
};

type StationPortfolioEnvelope = {
  readonly protocol: typeof STATION_PORTFOLIO_PROTOCOL;
  readonly documents: ReadonlyArray<StationPortfolioDocument>;
  readonly actorSeats: ReadonlyArray<ProjectedActorSeat>;
};

export type DecodedStationPortfolio = {
  readonly documents: ReadonlyMap<string, CanvasDoc>;
  readonly actorSeats: ReadonlyArray<ProjectedActorSeat>;
};

const fail = (operation: string, message: string): never => {
  throw StationPortfolioError.make({ operation, message });
};

const isPlainRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
};

/** Code-unit order is stable across machine locale settings. */
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const actorSeatFailure = (
  operation: "compile" | "decode",
  error: unknown,
): never => {
  if (error instanceof ActorSeatCompilationError) {
    return fail(
      operation,
      `projection actor registry is invalid: ${error.message}`,
    );
  }
  throw error;
};

/**
 * True when loading this body rewrote its edges — the one-shot conversion from
 * the pre-verb wire areas, or an edge the grammar no longer holds at all.
 *
 * Such a body cannot be byte-equal to what it decodes into, and a frozen v1
 * projection is exactly that case: AGENTS.md keeps the historical decode open
 * for it. Everything written since the cut still has to be byte-canonical.
 */
const conversionRewroteEdges = (parsed: unknown): boolean => {
  const before = (parsed as { readonly edges?: unknown }).edges;
  const after = (scrubCanvasDocInput(parsed) as { readonly edges?: unknown })
    .edges;
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  if (before.length !== after.length) return true;
  return before.some((edge, index) => {
    const was = edge as Record<string, unknown> | null;
    const now = after[index] as Record<string, unknown> | null;
    if (was === null || now === null) return was !== now;
    return (
      was.fromNode !== now.fromNode ||
      was.toNode !== now.toNode ||
      JSON.stringify(was.ether ?? null) !== JSON.stringify(now.ether ?? null)
    );
  });
};

const decodeCanonicalCanvas = (
  name: string,
  body: string,
): CanvasDoc => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return fail(
      "decode",
      `projection canvas "${name}" is not valid JSON`,
    );
  }
  if (containsWorkProjection(parsed)) {
    return fail(
      "decode",
      `projection canvas "${name}" contains runtime work projection data`,
    );
  }
  const decoded = decodeCanvasDoc(parsed);
  if (decoded._tag === "Failure") {
    return fail(
      "decode",
      `projection canvas "${name}" violates the canvas contract`,
    );
  }
  if (
    serializeCanvas(decoded.success) !== body &&
    !conversionRewroteEdges(parsed)
  ) {
    return fail(
      "decode",
      `projection canvas "${name}" is not canonical authorial content`,
    );
  }
  return decoded.success;
};

/**
 * Compile one deterministic, complete portfolio body for Station API project.
 *
 * Work rows are deliberately absent: callers supply authorial documents and
 * the receiving installation projects its own stationed work rows at read
 * time. Names are sorted so the exact body is a stable content identity.
 */
export const compileStationPortfolioBody = (
  documents: ReadonlyMap<string, CanvasDoc>,
  installationByHostId: ReadonlyMap<string, InstallationId>,
): string => {
  if (documents.size > STATION_PORTFOLIO_MAX_CANVASES) {
    return fail(
      "compile",
      `projection exceeds ${STATION_PORTFOLIO_MAX_CANVASES} canvases`,
    );
  }

  const records = [...documents.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, document]) => {
      if (!isCanonicalCanvasName(name)) {
        return fail("compile", `invalid projection canvas name "${name}"`);
      }
      return {
        name,
        body: serializeCanvas(document),
      } satisfies StationPortfolioDocument;
    });
  let actorSeats: ReadonlyArray<ProjectedActorSeat>;
  try {
    actorSeats = compileActorSeatRegistry(
      documents,
      installationByHostId,
    );
  } catch (error) {
    return actorSeatFailure("compile", error);
  }
  if (actorSeats.length > STATION_PORTFOLIO_MAX_ACTOR_SEATS) {
    return fail(
      "compile",
      `projection exceeds ${STATION_PORTFOLIO_MAX_ACTOR_SEATS} actor seats`,
    );
  }
  const body = JSON.stringify({
    protocol: STATION_PORTFOLIO_PROTOCOL,
    documents: records,
    actorSeats,
  } satisfies StationPortfolioEnvelope);
  if (body.length > STATION_API_MAX_PROJECTION_CHARS) {
    return fail(
      "compile",
      `projection exceeds ${STATION_API_MAX_PROJECTION_CHARS} characters`,
    );
  }

  // Keep compiler and decoder as one contract, not two approximations.
  decodeStationPortfolioBody(body);
  return body;
};

/** Decode and verify the exact complete portfolio stored by a Remote. */
export const decodeStationPortfolioBody = (
  body: string,
): DecodedStationPortfolio => {
  if (
    typeof body !== "string" ||
    body.length === 0 ||
    body.length > STATION_API_MAX_PROJECTION_CHARS
  ) {
    return fail("decode", "projection body length is out of bounds");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return fail("decode", "projection body is not valid JSON");
  }
  if (
    !isPlainRecord(parsed) ||
    !hasExactKeys(parsed, ["protocol", "documents", "actorSeats"]) ||
    parsed.protocol !== STATION_PORTFOLIO_PROTOCOL &&
      parsed.protocol !== LEGACY_STATION_PORTFOLIO_PROTOCOL ||
    !Array.isArray(parsed.documents) ||
    parsed.documents.length > STATION_PORTFOLIO_MAX_CANVASES ||
    !Array.isArray(parsed.actorSeats) ||
    parsed.actorSeats.length > STATION_PORTFOLIO_MAX_ACTOR_SEATS
  ) {
    return fail("decode", "projection body violates the portfolio contract");
  }

  const documents = new Map<string, CanvasDoc>();
  let previousName: string | undefined;
  for (const raw of parsed.documents) {
    if (
      !isPlainRecord(raw) ||
      !hasExactKeys(raw, ["name", "body"]) ||
      typeof raw.name !== "string" ||
      typeof raw.body !== "string" ||
      !isCanonicalCanvasName(raw.name)
    ) {
      return fail("decode", "projection contains an invalid canvas record");
    }
    if (
      previousName !== undefined &&
      compareText(raw.name, previousName) <= 0
    ) {
      return fail(
        "decode",
        "projection canvas names are not strictly sorted",
      );
    }
    previousName = raw.name;
    documents.set(raw.name, decodeCanonicalCanvas(raw.name, raw.body));
  }

  let actorSeats: ReadonlyArray<ProjectedActorSeat>;
  try {
    actorSeats = validateActorSeatRegistry(
      documents,
      decodeActorSeatRegistry(parsed.actorSeats),
    );
  } catch (error) {
    return actorSeatFailure("decode", error);
  }
  return { documents, actorSeats };
};
