import { Result, Schema } from "effect";

/**
 * The independently deployed Station wire contract.
 *
 * This number is deliberately separate from the application and SQLite state
 * schema versions. A peer advertises one contiguous supported range, then a
 * connection selects one exact wire version from the overlap.
 */
/**
 * Station protocol 4 is the content-capable wire cut: Work records carry
 * ContentRef parts, control frames stay bounded, and media bytes never ride
 * Station NDJSON. Protocol 3 is retired with no partial down-conversion.
 */
export const STATION_PROTOCOL_BASELINE = 4 as const;

export const StationProtocolVersion = Schema.Number.pipe(Schema.check(Schema.isInt()), 
  Schema.check(Schema.isGreaterThan(0)),
  Schema.check(Schema.makeFilter(Number.isSafeInteger, {
    message: "Station protocol version must be a safe integer",
  })),
);
export type StationProtocolVersion = typeof StationProtocolVersion.Type;

export const StationProtocolSupport = Schema.Struct({
  preferred: StationProtocolVersion,
  compatibleFrom: StationProtocolVersion,
  warnBelow: StationProtocolVersion,
}).pipe(
  Schema.check(Schema.makeFilter(({ compatibleFrom, warnBelow, preferred }) =>
    compatibleFrom <= warnBelow && warnBelow <= preferred,
  {
    message: "Station protocol support must satisfy compatibleFrom <= warnBelow <= preferred",
  },)),
);
export type StationProtocolSupport = typeof StationProtocolSupport.Type;

export const CURRENT_STATION_PROTOCOL_SUPPORT = StationProtocolSupport.make({
  preferred: STATION_PROTOCOL_BASELINE,
  compatibleFrom: STATION_PROTOCOL_BASELINE,
  warnBelow: STATION_PROTOCOL_BASELINE,
});

export type StationProtocolNegotiation =
  | {
      readonly _tag: "selected";
      readonly selected: StationProtocolVersion;
      readonly deprecatedForLocal: boolean;
      readonly deprecatedForPeer: boolean;
      readonly warning: boolean;
    }
  | {
      readonly _tag: "no-common";
      readonly local: StationProtocolSupport;
      readonly peer: StationProtocolSupport;
    };

/** Select the highest exact version both peers can decode. */
export const negotiateStationProtocol = (
  local: StationProtocolSupport,
  peer: StationProtocolSupport,
): StationProtocolNegotiation => {
  const compatibleFrom = Math.max(local.compatibleFrom, peer.compatibleFrom);
  const selected = Math.min(local.preferred, peer.preferred);
  if (compatibleFrom > selected) {
    return { _tag: "no-common", local, peer };
  }
  const deprecatedForLocal = selected < local.warnBelow;
  const deprecatedForPeer = selected < peer.warnBelow;
  return {
    _tag: "selected",
    selected,
    deprecatedForLocal,
    deprecatedForPeer,
    warning: deprecatedForLocal || deprecatedForPeer,
  };
};

/** Diagnostics only; these versions do not participate in wire selection. */
export const StationAppVersion = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(64)),
);
export type StationAppVersion = typeof StationAppVersion.Type;

export const StationStateSchemaVersion = Schema.Number.pipe(Schema.check(Schema.isInt()), 
  Schema.check(Schema.isGreaterThan(0)),
  Schema.check(Schema.makeFilter(Number.isSafeInteger, {
    message: "state schema version must be a safe integer",
  })),
);
export type StationStateSchemaVersion = typeof StationStateSchemaVersion.Type;

export const STATION_PROTOCOL_PREFACE =
  "vellum/station-protocol-preface/v1" as const;

const StationProtocolPeerDiagnostics = {
  appVersion: StationAppVersion,
  stateSchemaVersion: StationStateSchemaVersion,
  support: StationProtocolSupport,
};

/**
 * The preface is transport framing, before and outside StationSessionFrame.
 * Only its selected version authorizes the frozen versioned session codec.
 */
export const StationProtocolOffer = Schema.Struct({
  protocol: Schema.Literal(STATION_PROTOCOL_PREFACE),
  frame: Schema.Literal("offer"),
  ...StationProtocolPeerDiagnostics,
});
export type StationProtocolOffer = typeof StationProtocolOffer.Type;

export const StationProtocolAccept = Schema.Struct({
  protocol: Schema.Literal(STATION_PROTOCOL_PREFACE),
  frame: Schema.Literal("accept"),
  ...StationProtocolPeerDiagnostics,
  selected: StationProtocolVersion,
});
export type StationProtocolAccept = typeof StationProtocolAccept.Type;

export const StationProtocolReject = Schema.Struct({
  protocol: Schema.Literal(STATION_PROTOCOL_PREFACE),
  frame: Schema.Literal("reject"),
  ...StationProtocolPeerDiagnostics,
  reason: Schema.Literal("no-common-version"),
  retryable: Schema.Literal(false),
});
export type StationProtocolReject = typeof StationProtocolReject.Type;

export const StationProtocolPreface = Schema.Union([StationProtocolOffer,
StationProtocolAccept,
StationProtocolReject,]);
export type StationProtocolPreface = typeof StationProtocolPreface.Type;

export const decodeStationProtocolPreface = Schema.decodeUnknownResult(
  StationProtocolPreface,
  { onExcessProperty: "error" },
);

export type StationProtocolPrefaceDecision =
  | {
      readonly _tag: "accepted";
      readonly selected: StationProtocolVersion;
      readonly warning: boolean;
      readonly deprecatedForOfferer: boolean;
      readonly deprecatedForAcceptor: boolean;
    }
  | { readonly _tag: "no-common" }
  | {
      readonly _tag: "invalid-accept";
      readonly expected: StationProtocolVersion;
      readonly received: StationProtocolVersion;
    }
  | { readonly _tag: "invalid-reject" };

/**
 * Recompute every response against the offer. Accepts cannot select a
 * convenient lower version, and rejects cannot become retry loops.
 */
export const decideStationProtocolPreface = (
  offer: StationProtocolOffer,
  response: StationProtocolAccept | StationProtocolReject,
): StationProtocolPrefaceDecision => {
  const negotiation = negotiateStationProtocol(offer.support, response.support);
  if (response.frame === "accept") {
    if (negotiation._tag === "no-common" || response.selected !== negotiation.selected) {
      return {
        _tag: "invalid-accept",
        expected: negotiation._tag === "selected"
          ? negotiation.selected
          : offer.support.compatibleFrom,
        received: response.selected,
      };
    }
    return {
      _tag: "accepted",
      selected: negotiation.selected,
      warning: negotiation.warning,
      deprecatedForOfferer: negotiation.deprecatedForLocal,
      deprecatedForAcceptor: negotiation.deprecatedForPeer,
    };
  }
  return negotiation._tag === "no-common"
    ? { _tag: "no-common" }
    : { _tag: "invalid-reject" };
};

export const stationProtocolAccept = (
  offer: StationProtocolOffer,
  diagnostics: Omit<StationProtocolAccept, "protocol" | "frame" | "selected">,
): StationProtocolAccept => {
  const negotiation = negotiateStationProtocol(offer.support, diagnostics.support);
  if (negotiation._tag === "no-common") {
    throw new TypeError("Cannot accept Station protocol with no common version");
  }
  return StationProtocolAccept.make({
    protocol: STATION_PROTOCOL_PREFACE,
    frame: "accept",
    ...diagnostics,
    selected: negotiation.selected,
  });
};

export const stationProtocolReject = (
  diagnostics: Omit<StationProtocolReject, "protocol" | "frame" | "reason" | "retryable">,
): StationProtocolReject =>
  StationProtocolReject.make({
    protocol: STATION_PROTOCOL_PREFACE,
    frame: "reject",
    ...diagnostics,
    reason: "no-common-version",
    retryable: false,
  });

/** Only the exact current codec is admitted; incompatible peers update first. */
export const selectStationProtocolCodec = (
  version: StationProtocolVersion,
): Result.Result<typeof STATION_PROTOCOL_BASELINE, "unsupported-station-protocol"> =>
  version === STATION_PROTOCOL_BASELINE
    ? Result.succeed(STATION_PROTOCOL_BASELINE)
    : Result.fail("unsupported-station-protocol");
