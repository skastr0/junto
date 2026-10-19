/**
 * Boat's HTTP API, the few calls Junto makes (docs/machines.md, Boat
 * machines). The origin is compiled in and no redirect is followed, so the key
 * only ever goes to Boat. A failure carries Boat's status and code and a fixed
 * sentence: never the key, never a response body.
 */
import { Effect, Schema } from "effect";
import { BoatSandboxId, type BoatSandboxId as SandboxId, type BoatSize } from "@shared/boat";

export const BOAT_API_ORIGIN = "https://boat.dev";
const API_PATH = "/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;
/** A sandbox answer is a few kilobytes; anything far larger is not one. */
const RESPONSE_MAX_BYTES = 256 * 1024;

export type BoatFetch = (url: URL, init: RequestInit) => Promise<Response>;

export const BoatApiCheck = Schema.Literals([
  "unreachable", "unauthorized", "forbidden", "not-found", "rate-limited", "refused", "server", "unreadable",
]);
export type BoatApiCheck = typeof BoatApiCheck.Type;

export class BoatApiFailed extends Schema.TaggedError<BoatApiFailed>()("BoatApiFailed", {
  check: BoatApiCheck,
  /** Boat's own error code, when it gave one in its shape. */
  code: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(64)), Schema.check(Schema.isPattern(/^[a-z0-9_.-]+$/)))),
  status: Schema.optionalKey(Schema.Number),
  message: Schema.String,
}) {}

const SENTENCES: Record<BoatApiCheck, string> = {
  unreachable: "Cannot reach Boat. Check the internet connection",
  unauthorized: "Boat did not accept Junto's key. Connect the Boat account again",
  forbidden: "Junto's Boat key may not do that",
  "not-found": "Boat has no such sandbox",
  "rate-limited": "Boat asked Junto to slow down. Try again in a minute",
  refused: "Boat refused the request",
  server: "Boat failed to answer. Try again in a minute",
  unreadable: "Boat's answer could not be read",
};

const failed = (check: BoatApiCheck, extra: { readonly code?: string; readonly status?: number } = {}): BoatApiFailed => {
  const code = extra.code !== undefined && /^[a-z0-9_.-]{1,64}$/.test(extra.code) ? extra.code : undefined;
  return new BoatApiFailed({ check, message: SENTENCES[check], ...(code === undefined ? {} : { code }), ...(extra.status === undefined ? {} : { status: extra.status }) });
};

const PASSED_ON_TAGS: ReadonlySet<string> = new Set([
  "BoatApiFailed", "BoatKeyFailed", "BoatMachineRefused", "BoatFileRefused", "LinkUnavailable", "BoatMachineCommandFailed",
]);
/**
 * What a Boat failure may say in an answer or a log row, else `fallback`.
 * Boat's own errors carry fixed sentences. BoatMachineCommandFailed carries the
 * machine command's own answer (machine-owner.ts), the same words that command
 * gives the operator when called directly; a log row still scrubs it as a detail.
 */
export const boatFailureMessage = (cause: unknown, fallback = "The Boat machine command failed"): string =>
  cause instanceof Error && PASSED_ON_TAGS.has((cause as { _tag?: string })._tag ?? "") ? cause.message.slice(0, 1024) : fallback;

/** The core's runner: a Boat request is run in the warm runtime, never a bare one. */
export type BoatRun = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/** The client's key when none is stored: the account is not connected. */
export const boatKeyMissing = (): BoatApiFailed =>
  new BoatApiFailed({ check: "unauthorized", message: "Connect the Boat account first: junto machine boat-connect '{}'" });

const checkOf = (status: number): BoatApiCheck =>
  status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found"
    : status === 429 ? "rate-limited" : status >= 500 ? "server" : "refused";

const Bounded = Schema.String.pipe(Schema.check(Schema.isMaxLength(64)));

/** The fields of a sandbox Junto reads; Boat's others are ignored. */
export const BoatSandbox = Schema.Struct({
  id: BoatSandboxId,
  state: Bounded,
  ttlSeconds: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  archiveAfter: Schema.optionalKey(Schema.NullOr(Bounded)),
  dataExpiredAt: Schema.optionalKey(Schema.NullOr(Bounded)),
  updatedAt: Schema.optionalKey(Schema.NullOr(Bounded)),
  type: Schema.optionalKey(Schema.NullOr(Bounded)),
  /** The last stop, for when the machine fell asleep. */
  stop: Schema.optionalKey(Schema.NullOr(Schema.Struct({ endedAt: Schema.optionalKey(Schema.NullOr(Bounded)) }))),
});
export type BoatSandbox = typeof BoatSandbox.Type;

const SandboxAnswer = Schema.Struct({ sandbox: BoatSandbox });
const CreatedAnswer = Schema.Struct({ sandbox: Schema.optionalKey(Schema.Struct({ id: BoatSandboxId })), id: Schema.optionalKey(BoatSandboxId) });

/** OpenSSH's one-line public key: an algorithm and base64, nothing after. */
const HostKeyLine = Schema.String.pipe(Schema.check(Schema.isPattern(/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}$/)));
export const BoatSshRoute = Schema.Struct({
  sshUser: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z_][a-z0-9_-]{0,31}$/))),
  /** `host:port`, an IPv4 forward; absent when the machine has a public IPv4. */
  sshEndpoint: Schema.optionalKey(Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/))))),
  machineIp: Schema.optionalKey(Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9A-Fa-f:.]{2,45}$/))))),
  hostKey: HostKeyLine,
});
export type BoatSshRoute = typeof BoatSshRoute.Type;

export interface BoatCreate {
  readonly size: BoatSize;
  readonly ttlSeconds: number;
  /** Undefined means none of the account's stored secrets. */
  readonly environment?: string;
  readonly idempotencyKey: string;
}

export interface BoatClient {
  readonly sandbox: (id: SandboxId) => Effect.Effect<BoatSandbox, BoatApiFailed>;
  readonly create: (input: BoatCreate) => Effect.Effect<SandboxId, BoatApiFailed>;
  readonly resume: (id: SandboxId, ttlSeconds: number) => Effect.Effect<void, BoatApiFailed>;
  readonly stop: (id: SandboxId) => Effect.Effect<void, BoatApiFailed>;
  /** Sets the deadline to now plus `ttlSeconds`. */
  readonly lease: (id: SandboxId, ttlSeconds: number) => Effect.Effect<BoatSandbox, BoatApiFailed>;
  readonly installSshKey: (id: SandboxId, publicKey: string) => Effect.Effect<BoatSshRoute, BoatApiFailed>;
  readonly remove: (id: SandboxId) => Effect.Effect<void, BoatApiFailed>;
}

export const makeBoatClient = (input: {
  /** Read at each call, so a reconnected account takes effect at once. */
  readonly key: Effect.Effect<string, BoatApiFailed>;
  /** The test seam; the origin is always Boat's. */
  readonly fetch?: BoatFetch;
}): BoatClient => {
  const fetchImpl: BoatFetch = input.fetch ?? ((url, init) => fetch(url, init));

  const call = <A>(method: string, path: string, answer: Schema.Codec<A, unknown> | undefined, options: { readonly body?: unknown; readonly headers?: Record<string, string> } = {}) =>
    Effect.gen(function* () {
      const key = yield* input.key;
      const url = new URL(`${API_PATH}${path}`, BOAT_API_ORIGIN);
      const response = yield* Effect.tryPromise({
        try: (signal) => fetchImpl(url, {
          method, redirect: "error", credentials: "omit",
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          headers: {
            Authorization: `Bearer ${key}`, Accept: "application/json",
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
        catch: () => failed("unreachable"),
      });
      const text = yield* Effect.tryPromise({
        try: async () => {
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength > RESPONSE_MAX_BYTES) throw new Error("too large");
          return new TextDecoder().decode(bytes);
        },
        catch: () => failed("unreadable", { status: response.status }),
      });
      let body: unknown;
      try { body = text.length === 0 ? {} : JSON.parse(text); } catch { body = undefined; }
      if (!response.ok) {
        const code = typeof body === "object" && body !== null && typeof (body as { code?: unknown }).code === "string"
          ? (body as { code: string }).code : undefined;
        return yield* Effect.fail(failed(checkOf(response.status), { status: response.status, ...(code === undefined ? {} : { code }) }));
      }
      if (answer === undefined) return undefined as A;
      return yield* Schema.decodeUnknownEffect(answer)(body).pipe(Effect.mapError(() => failed("unreadable", { status: response.status })));
    });

  const sandboxPath = (id: SandboxId) => `/sandboxes/${encodeURIComponent(id)}`;
  return {
    sandbox: (id) => call("GET", sandboxPath(id), SandboxAnswer).pipe(Effect.map((a) => a.sandbox)),
    create: (create) => call("POST", "/sandboxes", CreatedAnswer, {
      body: {
        type: create.size, ttlSeconds: create.ttlSeconds, snapshots: true,
        ...(create.environment === undefined ? { noEnv: true } : { environment: create.environment }),
      },
      headers: { "Idempotency-Key": create.idempotencyKey },
    }).pipe(Effect.flatMap((a) => {
      const id = a.sandbox?.id ?? a.id;
      return id === undefined ? Effect.fail(failed("unreadable")) : Effect.succeed(id);
    })),
    resume: (id, ttlSeconds) => call("POST", `${sandboxPath(id)}/resume`, undefined, { body: { ttlSeconds } }),
    stop: (id) => call("POST", `${sandboxPath(id)}/stop`, undefined),
    lease: (id, ttlSeconds) => call("PATCH", sandboxPath(id), SandboxAnswer, { body: { ttlSeconds } }).pipe(Effect.map((a) => a.sandbox)),
    installSshKey: (id, publicKey) => call("POST", `${sandboxPath(id)}/sshkey`, BoatSshRoute, { body: { key: publicKey } }),
    remove: (id) => call("DELETE", sandboxPath(id), undefined, { headers: { "X-Ascii-Confirm-Delete": id } }),
  };
};
