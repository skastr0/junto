import { Schema } from "effect";
import {
  containsWorkProjection,
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
} from "@shared/canvas";
import { isCanonicalCanvasName } from "@shared/canvas-name";
import { STATION_API_MAX_PROJECTION_CHARS } from "@shared/station-api";

export const STATION_PORTFOLIO_PROTOCOL =
  "vellum/station-portfolio/v1" as const;
export const STATION_PORTFOLIO_MAX_CANVASES = 256;

export class StationPortfolioError extends Schema.TaggedError<StationPortfolioError>()(
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
  if (decoded._tag === "Left") {
    return fail(
      "decode",
      `projection canvas "${name}" violates the canvas contract`,
    );
  }
  if (serializeCanvas(decoded.right) !== body) {
    return fail(
      "decode",
      `projection canvas "${name}" is not canonical authorial content`,
    );
  }
  return decoded.right;
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
): string => {
  if (documents.size > STATION_PORTFOLIO_MAX_CANVASES) {
    return fail(
      "compile",
      `projection exceeds ${STATION_PORTFOLIO_MAX_CANVASES} canvases`,
    );
  }

  const records = [...documents.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, document]) => {
      if (!isCanonicalCanvasName(name)) {
        return fail("compile", `invalid projection canvas name "${name}"`);
      }
      return {
        name,
        body: serializeCanvas(document),
      } satisfies StationPortfolioDocument;
    });
  const body = JSON.stringify({
    protocol: STATION_PORTFOLIO_PROTOCOL,
    documents: records,
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
): ReadonlyMap<string, CanvasDoc> => {
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
    !hasExactKeys(parsed, ["protocol", "documents"]) ||
    parsed.protocol !== STATION_PORTFOLIO_PROTOCOL ||
    !Array.isArray(parsed.documents) ||
    parsed.documents.length > STATION_PORTFOLIO_MAX_CANVASES
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
      raw.name.localeCompare(previousName) <= 0
    ) {
      return fail(
        "decode",
        "projection canvas names are not strictly sorted",
      );
    }
    previousName = raw.name;
    documents.set(raw.name, decodeCanonicalCanvas(raw.name, raw.body));
  }
  return documents;
};
