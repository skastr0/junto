/**
 * Amp thread provisioning — the public CLI, and nothing else.
 *
 * An Amp seat's session id is not a value Junto may invent: Amp mints
 * it. `amp threads new --visibility private` prints one thread receipt and
 * exits. On 0.0.1789113641 that receipt is a sole
 * `https://ampcode.com/threads/T-<uuid>` line; older binaries print a bare
 * `T-<uuid>` line. Either form becomes the seat's `ether.terminal.sessionId`
 * before the PTY is opened, so a cold wake can resume the same thread by id.
 *
 * Boundaries this module keeps:
 * - public CLI only — never amp's settings file under `~/.config/amp/`, the
 *   cache, logs, or any undocumented endpoint;
 * - `execFile` with an argv array, so no shell ever sees the arguments;
 * - bounded — a hung network call fails with a typed error the seat surfaces
 *   as attention rather than blocking a spawn forever;
 * - read-only with respect to Amp's own state: this creates a thread, and
 *   never renames, archives, deletes, or shares one.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Amp thread ids are `T-` + a UUID. Anything else is not a receipt. */
const AMP_THREAD_ID = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Live 0.0.1789113641 stdout: a sole thread URL whose path is the T-id. */
const AMP_THREAD_URL_PREFIX = "https://ampcode.com/threads/";

const threadIdFromLine = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (AMP_THREAD_ID.test(trimmed)) return trimmed;
  if (!trimmed.startsWith(AMP_THREAD_URL_PREFIX)) return undefined;
  const candidate = trimmed.slice(AMP_THREAD_URL_PREFIX.length);
  return AMP_THREAD_ID.test(candidate) ? candidate : undefined;
};

export const isAmpThreadId = (value: string): boolean =>
  AMP_THREAD_ID.test(value.trim());

export type AmpThreadProvisionFailure = {
  readonly code: "amp_thread_unprovisioned";
  /** Operator-facing, already free of credentials and paths. */
  readonly reason: string;
};

export type AmpThreadProvisionResult =
  | { readonly ok: true; readonly threadId: string }
  | { readonly ok: false; readonly failure: AmpThreadProvisionFailure };

const failure = (reason: string): AmpThreadProvisionResult => ({
  ok: false,
  failure: { code: "amp_thread_unprovisioned", reason },
});

/**
 * The one line of output that is a thread receipt.
 *
 * Strict on purpose: Amp may print a banner, an update notice, or a warning
 * around the receipt, but exactly one line must be a thread id — either a
 * bare `T-<uuid>` or `https://ampcode.com/threads/T-<uuid>`. Zero means the
 * call did not produce a thread; more than one means the output is not what
 * this parser was written against, and guessing which is the receipt would
 * durably pin a seat to the wrong thread.
 */
export const parseAmpThreadReceipt = (
  stdout: string,
): string | undefined => {
  const ids = stdout
    .split("\n")
    .map(threadIdFromLine)
    .filter((id): id is string => id !== undefined);
  if (ids.length !== 1) return undefined;
  return ids[0];
};

export type AmpThreadProvisionOptions = {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Test seam — the real runner is `execFile`, never a shell. */
  readonly run?: (
    binary: string,
    args: readonly string[],
    options: { readonly cwd?: string; readonly timeoutMs: number },
  ) => Promise<string>;
};

const DEFAULT_TIMEOUT_MS = 20_000;

const runAmp = async (
  binary: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs: number },
): Promise<string> => {
  const { stdout } = await execFileAsync(binary, [...args], {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: process.env,
  });
  return typeof stdout === "string" ? stdout : "";
};

/**
 * Mint one private Amp thread and return its id.
 *
 * Private is the only visibility Junto asks for: a seat provisioned
 * by the factory must not publish anything to a workspace or a group on the
 * operator's behalf.
 */
export const provisionAmpThread = async (
  options: AmpThreadProvisionOptions = {},
): Promise<AmpThreadProvisionResult> => {
  const run = options.run ?? runAmp;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let stdout: string;
  try {
    stdout = await run("amp", ["threads", "new", "--visibility", "private"], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Authentication, network, and missing-binary failures all land here and
    // all become one operator-visible reason. None of them fall back to a
    // different thread, and none of them start a PTY.
    return failure(`amp threads new failed: ${message}`);
  }
  const threadId = parseAmpThreadReceipt(stdout);
  if (threadId === undefined) {
    return failure(
      "amp threads new did not print exactly one thread id",
    );
  }
  return { ok: true, threadId };
};
