/**
 * Fixed packaged content helper surface.
 *
 * The helper never accepts host paths or free-form shell.  Modes are closed
 * argv records that operate only on the local Junto content layout under
 * `$HOME/.junto/content/…`.  Bytes travel on stdin/stdout; control/status is
 * a single bounded JSON line on the opposite stream of the byte direction.
 */

/** Unified CLI subcommand for content transfer (`vellum-command content-transfer …`). */
export const CONTENT_TRANSFER_COMMAND = "content-transfer" as const;

/** Packaged entry is `vellum-command content-transfer`; name retained for status labels. */
export const CONTENT_HELPER_NAME = CONTENT_TRANSFER_COMMAND;

/** First argv token selecting the sealed content mode. */
export const CONTENT_HELPER_MODE_ARG = {
  receive: "receive",
  send: "send",
  stat: "stat",
} as const;

export type ContentHelperMode =
  (typeof CONTENT_HELPER_MODE_ARG)[keyof typeof CONTENT_HELPER_MODE_ARG];

/** Max JSON control/status line written by the helper (bytes). */
export const CONTENT_HELPER_STATUS_MAX_BYTES = 4 * 1024;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const BYTE_LENGTH_RE = /^(0|[1-9][0-9]{0,15})$/u;
const OFFSET_RE = /^(0|[1-9][0-9]{0,15})$/u;

export type ContentHelperReceiveArgs = {
  readonly mode: "receive";
  readonly sha256: string;
  readonly byteLength: number;
  /** Resume offset; must equal existing partial size when partial is present. */
  readonly offset: number;
};

export type ContentHelperSendArgs = {
  readonly mode: "send";
  readonly sha256: string;
  readonly byteLength: number;
  readonly offset: number;
};

export type ContentHelperStatArgs = {
  readonly mode: "stat";
  readonly sha256: string;
  readonly byteLength: number;
};

export type ContentHelperArgs =
  | ContentHelperReceiveArgs
  | ContentHelperSendArgs
  | ContentHelperStatArgs;

export type ContentHelperParseError = {
  readonly ok: false;
  readonly error: string;
  readonly exitCode: 64;
};

/**
 * Parse and admit the closed content-helper argv.  Rejects unknown modes,
 * free-form paths, and out-of-range numeric tokens.
 */
export const parseContentHelperArgs = (
  argv: ReadonlyArray<string>,
): ContentHelperArgs | ContentHelperParseError => {
  if (argv.length === 0) {
    return { ok: false, error: "content helper mode is required", exitCode: 64 };
  }
  const mode = argv[0];
  if (
    mode !== CONTENT_HELPER_MODE_ARG.receive &&
    mode !== CONTENT_HELPER_MODE_ARG.send &&
    mode !== CONTENT_HELPER_MODE_ARG.stat
  ) {
    return {
      ok: false,
      error: "content helper mode is not admitted",
      exitCode: 64,
    };
  }

  if (mode === CONTENT_HELPER_MODE_ARG.stat) {
    if (argv.length !== 3) {
      return {
        ok: false,
        error: "content helper stat requires <sha256> <byteLength>",
        exitCode: 64,
      };
    }
    const sha256 = argv[1]!;
    const lengthToken = argv[2]!;
    if (!SHA256_RE.test(sha256) || !BYTE_LENGTH_RE.test(lengthToken)) {
      return {
        ok: false,
        error: "content helper identity tokens are invalid",
        exitCode: 64,
      };
    }
    const byteLength = Number(lengthToken);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      return {
        ok: false,
        error: "content helper byteLength is not a safe integer",
        exitCode: 64,
      };
    }
    return { mode: "stat", sha256, byteLength };
  }

  // receive | send: <sha256> <byteLength> [offset]
  if (argv.length !== 3 && argv.length !== 4) {
    return {
      ok: false,
      error: `content helper ${mode} requires <sha256> <byteLength> [offset]`,
      exitCode: 64,
    };
  }
  const sha256 = argv[1]!;
  const lengthToken = argv[2]!;
  const offsetToken = argv[3] ?? "0";
  if (
    !SHA256_RE.test(sha256) ||
    !BYTE_LENGTH_RE.test(lengthToken) ||
    !OFFSET_RE.test(offsetToken)
  ) {
    return {
      ok: false,
      error: "content helper identity tokens are invalid",
      exitCode: 64,
    };
  }
  const byteLength = Number(lengthToken);
  const offset = Number(offsetToken);
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > byteLength
  ) {
    return {
      ok: false,
      error: "content helper offset/byteLength is out of range",
      exitCode: 64,
    };
  }
  if (mode === CONTENT_HELPER_MODE_ARG.receive) {
    return { mode: "receive", sha256, byteLength, offset };
  }
  return { mode: "send", sha256, byteLength, offset };
};

/** Build the exact argv record for a content helper invocation. */
export const contentHelperArgv = (args: ContentHelperArgs): string[] => {
  switch (args.mode) {
    case "stat":
      return [
        CONTENT_HELPER_MODE_ARG.stat,
        args.sha256,
        String(args.byteLength),
      ];
    case "receive":
      return [
        CONTENT_HELPER_MODE_ARG.receive,
        args.sha256,
        String(args.byteLength),
        String(args.offset),
      ];
    case "send":
      return [
        CONTENT_HELPER_MODE_ARG.send,
        args.sha256,
        String(args.byteLength),
        String(args.offset),
      ];
  }
};
