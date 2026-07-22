import { Context, Effect, Either, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  defaultRemoteHostsDocument,
  RemoteHost,
  RemoteHostsError,
  type RemoteHost as RemoteHostT,
} from "@shared/remote-hosts";
import { SshTransport } from "../ssh";
import {
  configureRemoteHost,
  type ConfigureRemoteResult,
} from "./configure-remote";
import { deployRemoteHost, type DeployRemoteResult } from "./deploy-remote";
import { runRemoteHostsDoctor, testHostConnection } from "./doctor";
import {
  getDefaultHostsRegistry,
  type HostsRegistry,
} from "./registry";
import { setHostsSnapshot } from "./snapshot";

const decodeHost = Schema.decodeUnknownEither(RemoteHost);

export type { ConfigureRemoteResult, DeployRemoteResult };

export class HostsService extends Context.Tag("@vellum/HostsService")<
  HostsService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly list: Effect.Effect<ReadonlyArray<RemoteHostT>, RemoteHostsError>;
    readonly get: (
      id: string,
    ) => Effect.Effect<RemoteHostT | undefined, RemoteHostsError>;
    readonly upsert: (
      input: unknown,
    ) => Effect.Effect<ReadonlyArray<RemoteHostT>, RemoteHostsError>;
    readonly remove: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<RemoteHostT>, RemoteHostsError>;
    readonly test: (
      id: string,
    ) => Effect.Effect<{ readonly ok: boolean; readonly detail: string }, RemoteHostsError>;
    /** Command Center → SSH stamp Remote station fields on a registered remote host. */
    readonly configureRemote: (
      id: string,
      options: {
        readonly commandCenterRef: string;
        readonly supervisedPreferred?: boolean;
      },
    ) => Effect.Effect<ConfigureRemoteResult, RemoteHostsError>;
    /** Command Center → install/update .app over SSH + start Remote station. */
    readonly deployRemote: (id: string) => Effect.Effect<DeployRemoteResult>;
    readonly path: () => string;
  }
>() {}

const asRemoteHostsError = (error: unknown): RemoteHostsError =>
  error instanceof RemoteHostsError
    ? error
    : new RemoteHostsError(
        "io",
        error instanceof Error ? error.message : String(error),
      );

const loadHostsIntoRoutingSnapshot = (
  load: () => Promise<ReadonlyArray<RemoteHostT>>,
): Effect.Effect<ReadonlyArray<RemoteHostT>, RemoteHostsError> =>
  Effect.tryPromise({
    try: load,
    catch: asRemoteHostsError,
  }).pipe(
    Effect.tap((hosts) =>
      Effect.sync(() => {
        setHostsSnapshot(hosts);
      }),
    ),
  );

export const makeHostsService = (
  registry: HostsRegistry,
  ssh: Context.Tag.Service<typeof SshTransport>,
): Context.Tag.Service<typeof HostsService> => ({
  path: () => registry.path(),
  doctor: runRemoteHostsDoctor(registry, ssh),
  // Listing is the explicit durable reload boundary used by Settings and IPC.
  // Keep the synchronous routing snapshot in the same successful operation.
  list: loadHostsIntoRoutingSnapshot(() => registry.reload()),
  get: (id) =>
    Effect.tryPromise({
      try: () => registry.get(id),
      catch: asRemoteHostsError,
    }),
  upsert: (input) =>
    Effect.gen(function* () {
      const decoded = decodeHost(input);
      if (Either.isLeft(decoded)) {
        return yield* Effect.fail(
          new RemoteHostsError(
            "validation",
            `invalid host: ${decoded.left.message}`,
          ),
        );
      }
      const hosts = yield* Effect.tryPromise({
        try: () => registry.upsert(decoded.right),
        catch: asRemoteHostsError,
      });
      setHostsSnapshot(hosts);
      return hosts;
    }),
  remove: (id) =>
    Effect.gen(function* () {
      const hosts = yield* Effect.tryPromise({
        try: () => registry.remove(id),
        catch: asRemoteHostsError,
      });
      setHostsSnapshot(hosts);
      return hosts;
    }),
  test: (id) =>
    Effect.gen(function* () {
      const host = yield* Effect.tryPromise({
        try: () => registry.get(id),
        catch: asRemoteHostsError,
      });
      if (!host) {
        return yield* Effect.fail(
          new RemoteHostsError("not_found", `unknown host: ${id}`),
        );
      }
      return yield* testHostConnection(ssh, host);
    }),
  configureRemote: (id, options) =>
    Effect.gen(function* () {
      const host = yield* Effect.tryPromise({
        try: () => registry.get(id),
        catch: asRemoteHostsError,
      });
      if (!host) {
        return yield* Effect.fail(
          new RemoteHostsError("not_found", `unknown host: ${id}`),
        );
      }
      return yield* configureRemoteHost(ssh, host, options);
    }),
  deployRemote: (id) =>
    Effect.gen(function* () {
      const hostResult = yield* Effect.either(
        Effect.tryPromise({
          try: () => registry.get(id),
          catch: asRemoteHostsError,
        }),
      );
      if (hostResult._tag === "Left") {
        return {
          ok: false,
          detail: hostResult.left.message,
          code: hostResult.left.code,
          stages: [],
        } satisfies DeployRemoteResult;
      }
      const host = hostResult.right;
      if (!host) {
        return {
          ok: false,
          detail: `unknown host: ${id}`,
          code: "not_found" as const,
          stages: [],
        } satisfies DeployRemoteResult;
      }
      return yield* deployRemoteHost(ssh, host);
    }),
});

export const HostsServiceLive = Layer.effect(
  HostsService,
  Effect.gen(function* () {
    const ssh = yield* SshTransport;
    const registry = getDefaultHostsRegistry();
    // Layer acquisition is the normal-boot barrier: the persisted document is
    // visible to synchronous Herdr/Hermes routing before this layer can feed
    // either transport or plane.
    yield* loadHostsIntoRoutingSnapshot(() => registry.reload()).pipe(
      Effect.catchAll(() =>
        Effect.sync(() => {
          // An invalid/unreadable user registry must not brick the local app.
          // Keep the file untouched; list and Doctor retry it and surface the
          // exact error, while synchronous product routing fails closed to local.
          setHostsSnapshot(defaultRemoteHostsDocument().hosts);
        }),
      ),
    );
    return makeHostsService(registry, ssh);
  }),
);
