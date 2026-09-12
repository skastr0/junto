// Browser hard limits shared by the document, IPC, Electron, control, and CLI
// boundaries. Keep this module platform-pure: no Node or Electron imports.

export type BrowserLimitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: "invalid"; readonly message: string };

export interface BrowserSurfaceBoundsValue {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// Runtime pool and concurrency limits.
export const BROWSER_MAX_WARM_SESSIONS_HARD = 32;
export const BROWSER_MAX_VISIBLE_SURFACES_HARD = 8;
export const BROWSER_MAX_ACTIVE_OPERATIONS = 16;
export const BROWSER_MAX_ACTIVE_OPERATIONS_PER_SESSION = 1;
export const BROWSER_MAX_ACTIVE_HTTP_HANDLERS = 32;
export const BROWSER_MAX_LIST_ROWS = 10_000;
export const BROWSER_MAX_CANVAS_QUERY_ROWS = 10_000;
export const BROWSER_MAX_CANVAS_QUERY_BYTES = 64 * 1024 * 1024;
export const BROWSER_MAX_PENDING_DNS_HOSTS = 32;
export const BROWSER_MAX_EGRESS_SOCKETS = 64;
export const BROWSER_MAX_EGRESS_PENDING_CONNECTS = 32;
export const BROWSER_EGRESS_CONNECT_TIMEOUT_MS = 10_000;
export const BROWSER_EGRESS_HAPPY_EYEBALLS_DELAY_MS = 250;
export const BROWSER_MAX_EGRESS_HAPPY_EYEBALLS_INFLIGHT = 2;

// Operation deadlines. The outer control deadline exceeds every inner page
// operation so the session service wins the race and releases its lane first.
export const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
export const BROWSER_EVAL_TIMEOUT_MS = 30_000;
export const BROWSER_CAPTURE_TIMEOUT_MS = 15_000;
export const BROWSER_CONTROL_HANDLER_TIMEOUT_MS = 35_000;
export const BROWSER_CLI_REQUEST_TIMEOUT_MS = 40_000;
export const BROWSER_DNS_POLICY_TIMEOUT_MS = 5_000;

// Transport admission and response limits.
export const BROWSER_CONTROL_MAX_HEADER_BYTES = 16 * 1024;
export const BROWSER_CONTROL_HEADERS_TIMEOUT_MS = 5_000;
export const BROWSER_CONTROL_REQUEST_BODY_TIMEOUT_MS = 10_000;
export const BROWSER_CONTROL_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const BROWSER_CONTROL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const BROWSER_MAX_CANVAS_SOURCE_BYTES = 16 * 1024 * 1024;
export const BROWSER_MAX_EVAL_RESULT_BYTES = 1024 * 1024;
export const BROWSER_MAX_EVAL_RESULT_DEPTH = 64;
export const BROWSER_MAX_EVAL_RESULT_NODES = 10_000;
export const BROWSER_MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;

// Powerful request fields and user-visible metadata.
export const BROWSER_MAX_REF_BYTES = 4 * 1024;
export const BROWSER_MAX_SESSION_ID_BYTES = 256;
export const BROWSER_MAX_URL_BYTES = 16 * 1024;
export const BROWSER_MAX_EVAL_CODE_BYTES = 256 * 1024;
export const BROWSER_MAX_TITLE_BYTES = 4 * 1024;
export const BROWSER_MAX_ERROR_BYTES = 4 * 1024;
export const BROWSER_MAX_METADATA_BYTES = 4 * 1024;

// Native surface geometry. Pixel count is independently bounded so accepting
// each dimension at its individual maximum cannot allocate a giant surface.
export const BROWSER_MAX_ABS_COORDINATE = 1_000_000;
export const BROWSER_MAX_SURFACE_WIDTH = 16_384;
export const BROWSER_MAX_SURFACE_HEIGHT = 16_384;
export const BROWSER_MAX_SURFACE_PIXELS = 67_108_864;

const encoder = new TextEncoder();

export const utf8ByteLength = (value: string): number => encoder.encode(value).byteLength;

export const isUtf8WithinLimit = (value: string, maxBytes: number): boolean =>
  Number.isInteger(maxBytes) && maxBytes >= 0 && utf8ByteLength(value) <= maxBytes;

/** Clamp by Unicode code point so the result never ends with partial UTF-8. */
export const clampUtf8Bytes = (value: string, maxBytes: number): string => {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return "";
  if (isUtf8WithinLimit(value, maxBytes)) return value;

  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
};

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const isValidBrowserSessionId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  isUtf8WithinLimit(value, BROWSER_MAX_SESSION_ID_BYTES) &&
  SESSION_ID.test(value);

export const parseBrowserSessionId = (value: unknown): BrowserLimitResult<string> =>
  isValidBrowserSessionId(value)
    ? { ok: true, value }
    : {
        ok: false,
        code: "invalid",
        message: "browser session id must be nonempty, bounded ASCII",
      };

const isExactBoundsObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === "height,width,x,y";

const isFiniteInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);

export const parseBrowserSurfaceBounds = (
  input: unknown,
): BrowserLimitResult<BrowserSurfaceBoundsValue> => {
  if (!isExactBoundsObject(input)) {
    return { ok: false, code: "invalid", message: "browser bounds must contain exactly x, y, width, height" };
  }
  const { x, y, width, height } = input;
  if (
    !isFiniteInteger(x) ||
    !isFiniteInteger(y) ||
    !isFiniteInteger(width) ||
    !isFiniteInteger(height)
  ) {
    return { ok: false, code: "invalid", message: "browser bounds must be finite integers" };
  }
  if (Math.abs(x) > BROWSER_MAX_ABS_COORDINATE || Math.abs(y) > BROWSER_MAX_ABS_COORDINATE) {
    return { ok: false, code: "invalid", message: "browser bounds coordinates exceed the hard limit" };
  }
  if (
    width <= 0 ||
    height <= 0 ||
    width > BROWSER_MAX_SURFACE_WIDTH ||
    height > BROWSER_MAX_SURFACE_HEIGHT ||
    width * height > BROWSER_MAX_SURFACE_PIXELS
  ) {
    return { ok: false, code: "invalid", message: "browser bounds dimensions exceed the hard limit" };
  }
  return { ok: true, value: { x, y, width, height } };
};
