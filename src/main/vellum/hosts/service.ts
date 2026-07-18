import { Context, Effect, Either, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  RemoteHost,
  RemoteHostsError,
  type RemoteHost as RemoteHostT,
} from "@shared/remote-hosts";
import { SshTransport } from "../ssh";
import { runRemoteHostsDoctor, testHostConnection } from "./doctor";
import {
  getDefaultHostsRegistry,
  type HostsRegistry,
} from "./registry";
import { setHostsSnapshot } from "./snapshot";

const decodeHost = Schema.decodeUnknownEither(RemoteHost);

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

export const makeHostsService = (
  registry: HostsRegistry,
  ssh: Context.Tag.Service<typeof SshTransport>,
): Context.Tag.Service<typeof HostsService> => ({
  path: () => registry.path(),
  doctor: runRemoteHostsDoctor(registry, ssh),
  list: Effect.tryPromise({
    try: () => registry.list(),
    catch: asRemoteHostsError,
  }),
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
});

export const HostsServiceLive = Layer.effect(
  HostsService,
  Effect.gen(function* () {
    const ssh = yield* SshTransport;
    return makeHostsService(getDefaultHostsRegistry(), ssh);
  }),
);
