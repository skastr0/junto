/**
 * The one sealed packaged-helper mode that admits the compatibility preface.
 *
 * Keep this transport token out of the Station wire contract: it selects the
 * helper entry path, not a second protocol version.
 */
export const STATION_PROTOCOL_NEGOTIATION_ARG =
  "--protocol-preface" as const;
