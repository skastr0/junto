/**
 * Unified CLI subcommand for the station wire endpoint.
 * Packaged path is always `bin/vellum-command station-stdio`.
 */
export const STATION_STDIO_COMMAND = "station-stdio" as const;

/**
 * The one sealed packaged-helper mode that admits the compatibility preface.
 *
 * Keep this transport token out of the Station wire contract: it selects the
 * helper entry path, not a second protocol version.
 */
export const STATION_PROTOCOL_NEGOTIATION_ARG =
  "--protocol-preface" as const;

/** Explicit peer-door selector. Default session already selects peer. */
export const STATION_PEER_ARG = "--peer" as const;
