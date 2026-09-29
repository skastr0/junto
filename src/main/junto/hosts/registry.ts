import { hostname } from "node:os";
import { isIP } from "node:net";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  LOCAL_HOST_ID,
  REMOTE_HOSTS_VERSION,
  RemoteHostsError,
  defaultRemoteHostsDocument,
  hermesKeyFor,
  hostHasCapability,
  makeLocalHost,
  projectHostsWithCodeDefaultLocal,
  type HostCapability,
  type RemoteHost,
  type RemoteHostsDocument,
} from "@shared/remote-hosts";

const HERMES_CAPABILITY_BIT = 8;
const MAX_HOSTS = 32;

// Bit 4 belonged to a retired capability; the numbering stays fixed so stored
// masks keep decoding the capabilities that are still real.
const CAPABILITY_BITS = {
  terminal: 1,
  browser: 2,
  hermes: HERMES_CAPABILITY_BIT,
} as const satisfies Record<HostCapability, number>;

const CAPABILITIES_IN_STORAGE_ORDER = [
  "terminal",
  "browser",
  "hermes",
] as const satisfies ReadonlyArray<HostCapability>;

type HostRow = {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly ssh_endpoint: string | null;
  readonly ssh_identity_file: string | null;
  readonly ssh_host_key_policy: "system" | "accept-new" | null;
  readonly capability_mask: number | null;
  readonly hermes_id: string | null;
  readonly appearance_color: string | null;
  readonly appearance_glyph: string | null;
  readonly sort_order: number;
};

export class HostsStateError extends Schema.TaggedError<HostsStateError>()(
  "HostsStateError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

const isSupportedSshDestination = (endpoint: string): boolean => {
  const at = endpoint.indexOf("@");
  if (at !== endpoint.lastIndexOf("@")) return false;
  const user = at >= 0 ? endpoint.slice(0, at) : undefined;
  const destination = at >= 0 ? endpoint.slice(at + 1) : endpoint;
  if (!destination || (at >= 0 && !user) || user?.includes(":")) return false;
  if (!destination.includes(":")) return true;

  // macOS OpenSSH accepts raw IPv6 (including a scope id) but treats brackets
  // as hostname text. It also does not interpret host:port as destination+port.
  if (destination.startsWith("[") || destination.endsWith("]")) return false;
  return isIP(destination) === 6;
};

const validateHosts = (hosts: ReadonlyArray<RemoteHost>): void => {
  if (hosts.length > MAX_HOSTS) {
    throw new RemoteHostsError(
      "validation",
      `host registry exceeds the ${MAX_HOSTS}-host ceiling`,
    );
  }

  const ids = new Set<string>();
  const endpoints = new Set<string>();
  const hermesKeys = new Set<string>();

  for (const host of hosts) {
    if (ids.has(host.id)) {
      throw new RemoteHostsError("validation", `duplicate host id: ${host.id}`);
    }
    ids.add(host.id);

    if (new Set(host.capabilities).size !== host.capabilities.length) {
      throw new RemoteHostsError(
        "validation",
        `duplicate capability on host: ${host.id}`,
      );
    }

    if (host.kind === "local") {
      if (host.id !== LOCAL_HOST_ID) {
        throw new RemoteHostsError(
          "validation",
          `only id "${LOCAL_HOST_ID}" may use kind local (got ${host.id})`,
        );
      }
      if (host.sshEndpoint) {
        throw new RemoteHostsError(
          "validation",
          `local host ${host.id} must not set sshEndpoint`,
        );
      }
      if (host.sshIdentityFile || host.sshHostKeyPolicy) {
        throw new RemoteHostsError(
          "validation",
          `local host ${host.id} must not set SSH route policy`,
        );
      }
    } else {
      if (host.id === LOCAL_HOST_ID) {
        throw new RemoteHostsError(
          "validation",
          `host id "${LOCAL_HOST_ID}" must use kind local`,
        );
      }
      if (host.capabilities.length === 0) {
        throw new RemoteHostsError(
          "validation",
          `remote host ${host.id} requires at least one capability`,
        );
      }
      if (host.sshEndpoint !== undefined) {
        if (!isSupportedSshDestination(host.sshEndpoint)) {
          throw new RemoteHostsError(
            "validation",
            `remote host ${host.id} sshEndpoint must be an SSH config alias, user@host, or IPv6 literal; configure custom ports in ~/.ssh/config`,
          );
        }
        if (endpoints.has(host.sshEndpoint)) {
          throw new RemoteHostsError(
            "validation",
            "duplicate remote sshEndpoint",
          );
        }
        endpoints.add(host.sshEndpoint);
      } else if (host.sshIdentityFile || host.sshHostKeyPolicy) {
        throw new RemoteHostsError(
          "validation",
          `remote host ${host.id} cannot set SSH route policy without an endpoint`,
        );
      }
    }

    if (hostHasCapability(host, "hermes")) {
      const key = hermesKeyFor(host);
      if (hermesKeys.has(key)) {
        throw new RemoteHostsError(
          "validation",
          `duplicate hermes id: ${key}`,
        );
      }
      hermesKeys.add(key);
    }
  }
};

const thisMachineLabel = (): string => {
  try {
    const name = hostname().trim();
    return name.length > 0 ? name : LOCAL_HOST_ID;
  } catch {
    return LOCAL_HOST_ID;
  }
};

const projectDocument = (
  document: RemoteHostsDocument,
): RemoteHostsDocument => ({
  version: REMOTE_HOSTS_VERSION,
  hosts: projectHostsWithCodeDefaultLocal(document.hosts, {
    label: thisMachineLabel(),
  }),
});

const capabilityMask = (host: RemoteHost): number | null => {
  if (host.kind === "local") return null;
  return host.capabilities.reduce(
    (mask, capability) => mask | CAPABILITY_BITS[capability],
    0,
  );
};

const capabilitiesFromMask = (
  mask: number | null,
): ReadonlyArray<HostCapability> => {
  if (mask === null) return [];
  return CAPABILITIES_IN_STORAGE_ORDER.filter(
    (capability) => (mask & CAPABILITY_BITS[capability]) !== 0,
  );
};

const rowToHost = (row: HostRow): RemoteHost => {
  if (row.kind === "local") {
    return makeLocalHost({
      label: row.label,
      ...(row.hermes_id === null ? {} : { hermesId: row.hermes_id }),
      ...(row.appearance_color === null && row.appearance_glyph === null
        ? {}
        : {
            appearance: {
              ...(row.appearance_color === null
                ? {}
                : { color: row.appearance_color }),
              ...(row.appearance_glyph === null
                ? {}
                : { glyph: row.appearance_glyph }),
            },
          }),
    });
  }

  return {
    id: row.id,
    label: row.label,
    kind: "remote",
    ...(row.ssh_endpoint === null ? {} : { sshEndpoint: row.ssh_endpoint }),
    ...(row.ssh_identity_file === null
      ? {}
      : { sshIdentityFile: row.ssh_identity_file }),
    ...(row.ssh_host_key_policy === null
      ? {}
      : { sshHostKeyPolicy: row.ssh_host_key_policy }),
    capabilities: [...capabilitiesFromMask(row.capability_mask)],
    ...(row.hermes_id === null ? {} : { hermesId: row.hermes_id }),
    ...(row.appearance_color === null && row.appearance_glyph === null
      ? {}
      : {
          appearance: {
            ...(row.appearance_color === null
              ? {}
              : { color: row.appearance_color }),
            ...(row.appearance_glyph === null
              ? {}
              : { glyph: row.appearance_glyph }),
          },
        }),
  };
};

const HostRowSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["local", "remote"]),
  ssh_endpoint: Schema.NullOr(Schema.String),
  ssh_identity_file: Schema.NullOr(Schema.String),
  ssh_host_key_policy: Schema.NullOr(Schema.Literals(["system", "accept-new"])),
  capability_mask: Schema.NullOr(Schema.Number),
  hermes_id: Schema.NullOr(Schema.String),
  appearance_color: Schema.NullOr(Schema.String),
  appearance_glyph: Schema.NullOr(Schema.String),
  sort_order: Schema.Number,
});

export type HostRegistryRowsError = HostsStateError | RemoteHostsError;

const hostRowsError = (operation: string, cause: unknown): HostRegistryRowsError =>
  cause instanceof RemoteHostsError || cause instanceof HostsStateError
    ? cause
    : HostsStateError.make({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

/** Host rows only. Every mutation participates in its caller's transaction. */
export class HostRegistryRows extends Context.Service<HostRegistryRows, {
  readonly initialized: Effect.Effect<boolean, HostsStateError>;
  readonly read: Effect.Effect<RemoteHostsDocument, HostRegistryRowsError>;
  readonly ensure: (initializedAt: string) => Effect.Effect<void, HostRegistryRowsError>;
  readonly upsert: (host: RemoteHost) => Effect.Effect<RemoteHostsDocument, HostRegistryRowsError>;
  readonly updateRoute: (id: string, endpoint: string, label: string) => Effect.Effect<void, HostRegistryRowsError>;
  readonly delete: (id: string) => Effect.Effect<void, HostRegistryRowsError>;
}>()("@junto/HostRegistryRows") {
  static readonly layer = Layer.effect(this, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const selectInitialized = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: Schema.Struct({ singleton: Schema.Number }),
      execute: () => sql`SELECT singleton FROM host_registry_state WHERE singleton = 1`,
    });
    const initialized = selectInitialized(undefined).pipe(
      Effect.map(Option.isSome),
      Effect.mapError((cause) => HostsStateError.make({ operation: "initialize-read", message: cause.message, cause })),
    );
    const selectHosts = SqlSchema.findAll({
      Request: Schema.Void,
      Result: HostRowSchema,
      execute: () => sql`SELECT id, label, kind, ssh_endpoint, ssh_identity_file,
        ssh_host_key_policy, capability_mask, hermes_id, appearance_color, appearance_glyph,
        sort_order FROM host_registry ORDER BY sort_order`,
    });
    const read = Effect.gen(function* () {
      const rows = yield* selectHosts(undefined);
      const hosts = rows.map(rowToHost);
      yield* Effect.try({ try: () => validateHosts(hosts), catch: (cause) => hostRowsError("read", cause) });
      return { version: REMOTE_HOSTS_VERSION, hosts };
    }).pipe(Effect.mapError((cause) => hostRowsError("read", cause)));
    const write = Effect.fn("HostRegistryRows.write")(function* (host: RemoteHost, sortOrder: number) {
      const mask = capabilityMask(host);
      const effectiveHermesId = hostHasCapability(host, "hermes") ? hermesKeyFor(host) : null;
      yield* sql`INSERT INTO host_registry(
        id, label, kind, ssh_endpoint, ssh_identity_file, ssh_host_key_policy,
        capability_mask, hermes_id, effective_hermes_id, appearance_color, appearance_glyph, sort_order
      ) VALUES (${host.id}, ${host.label}, ${host.kind},
        ${host.kind === "remote" ? host.sshEndpoint ?? null : null},
        ${host.kind === "remote" ? host.sshIdentityFile ?? null : null},
        ${host.kind === "remote" ? host.sshHostKeyPolicy ?? null : null},
        ${mask}, ${host.hermesId ?? null}, ${effectiveHermesId},
        ${host.appearance?.color ?? null}, ${host.appearance?.glyph ?? null}, ${sortOrder})
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label, kind = excluded.kind, ssh_endpoint = excluded.ssh_endpoint,
        ssh_identity_file = excluded.ssh_identity_file, ssh_host_key_policy = excluded.ssh_host_key_policy,
        capability_mask = excluded.capability_mask, hermes_id = excluded.hermes_id,
        effective_hermes_id = excluded.effective_hermes_id, appearance_color = excluded.appearance_color,
        appearance_glyph = excluded.appearance_glyph, sort_order = excluded.sort_order`;
    });
    const count = SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ count: Schema.Number }),
      execute: () => sql`SELECT count(*) AS count FROM host_registry`,
    });
    const ensure = Effect.fn("HostRegistryRows.ensure")(function* (initializedAt: string) {
      if (yield* initialized) return;
      if ((yield* count(undefined)).count !== 0) {
        return yield* HostsStateError.make({ operation: "initialize-write",
          message: "host registry rows exist without initialization metadata", cause: undefined });
      }
      yield* write(defaultRemoteHostsDocument().hosts[0]!, 0);
      yield* sql`INSERT INTO host_registry_state(singleton, version, initialized_at) VALUES (1, 1, ${initializedAt})`;
    }, Effect.mapError((cause) => hostRowsError("ensure", cause)));
    const selectOrder = SqlSchema.findOneOption({
      Request: Schema.String, Result: Schema.Struct({ sort_order: Schema.Number }),
      execute: (id) => sql`SELECT sort_order FROM host_registry WHERE id = ${id}`,
    });
    const selectMaxOrder = SqlSchema.findOne({
      Request: Schema.Void, Result: Schema.Struct({ max_order: Schema.NullOr(Schema.Number) }),
      execute: () => sql`SELECT max(sort_order) AS max_order FROM host_registry`,
    });
    const upsert = Effect.fn("HostRegistryRows.upsert")(function* (host: RemoteHost) {
      const current = yield* read;
      const entry = host.id === LOCAL_HOST_ID
        ? makeLocalHost({ label: host.label, hermesId: host.hermesId, appearance: host.appearance }) : host;
      const nextHosts = [...current.hosts];
      const index = nextHosts.findIndex((row) => row.id === entry.id);
      if (index >= 0) nextHosts[index] = entry;
      else nextHosts.push(entry);
      yield* Effect.try({ try: () => validateHosts(nextHosts), catch: (cause) => hostRowsError("upsert", cause) });
      const order = yield* selectOrder(entry.id);
      const maxOrder = (yield* selectMaxOrder(undefined)).max_order ?? 0;
      yield* write(entry, Option.isSome(order) ? order.value.sort_order : maxOrder + 1);
      return yield* read;
    }, Effect.mapError((cause) => hostRowsError("upsert", cause)));
    const updateRoute = Effect.fn("HostRegistryRows.updateRoute")(function* (id: string, endpoint: string, label: string) {
      yield* sql`UPDATE host_registry SET ssh_endpoint = ${endpoint}, label = ${label} WHERE id = ${id}`;
    }, Effect.mapError((cause) => hostRowsError("update-route", cause)));
    const deleteHost = Effect.fn("HostRegistryRows.delete")(function* (id: string) {
      yield* sql`DELETE FROM host_registry WHERE id = ${id}`;
    }, Effect.mapError((cause) => hostRowsError("delete", cause)));
    return { initialized, read, ensure, upsert, updateRoute, delete: deleteHost };
  }));
}

/** Owning operations composed above the SQL row leaves in hosts/service.ts. */
export class HostsPersistence extends Context.Service<HostsPersistence, {
  readonly initialize: Effect.Effect<void, RemoteHostsError>;
  readonly read: Effect.Effect<RemoteHostsDocument, RemoteHostsError>;
  readonly upsert: (host: RemoteHost) => Effect.Effect<RemoteHostsDocument, RemoteHostsError>;
  readonly remove: (id: string) => Effect.Effect<RemoteHostsDocument, RemoteHostsError>;
}>()("@junto/HostsPersistence") {}

/**
 * Host-injected Promise bridge. Product code passes AppRuntime/RemoteRuntime
 * (via Effect.runPromiseWith from HostsServiceLive); tests may pass bare
 * Effect.runPromise outside the src/main lint scan.
 */
export type HostsRegistryRunPromise = <A, E>(
  effect: Effect.Effect<A, E, never>,
) => Promise<A>;

/**
 * The registry retains its Promise contract for existing transport callers,
 * but Effect's default Promise runner wraps typed failures in FiberFailure.
 * Keep domain errors intact at this boundary so callers can branch on
 * RemoteHostsError.code without inspecting Effect internals.
 */
const makeRunRegistryEffect = (
  runPromise: HostsRegistryRunPromise,
) =>
  async <A>(effect: Effect.Effect<A, RemoteHostsError>): Promise<A> => {
    const result = await runPromise(Effect.result(effect));
    if (result._tag === "Failure") throw result.failure;
    return result.success;
  };

export interface HostsRegistry {
  readonly list: () => Promise<ReadonlyArray<RemoteHost>>;
  readonly get: (id: string) => Promise<RemoteHost | undefined>;
  readonly findByHermesId: (hermesId: string) => Promise<RemoteHost | undefined>;
  readonly withCapability: (
    capability: HostCapability,
  ) => Promise<ReadonlyArray<RemoteHost>>;
  readonly upsert: (host: RemoteHost) => Promise<ReadonlyArray<RemoteHost>>;
  readonly remove: (id: string) => Promise<ReadonlyArray<RemoteHost>>;
  readonly reload: () => Promise<ReadonlyArray<RemoteHost>>;
}

export const makeHostsRegistry = (
  persistence: HostsPersistence["Service"],
  runPromise: HostsRegistryRunPromise,
): HostsRegistry => {
  const runRegistryEffect = makeRunRegistryEffect(runPromise);
  let initialization: Promise<void> | undefined;

  const ensure = (): Promise<void> => {
    if (initialization) return initialization;
    initialization = runRegistryEffect(
      persistence.initialize,
    ).catch((error) => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  };

  const load = async (): Promise<RemoteHostsDocument> => {
    await ensure();
    return runRegistryEffect(
      persistence.read.pipe(Effect.map(projectDocument)),
    );
  };

  return {
    list: async () => (await load()).hosts,
    get: async (id) => (await load()).hosts.find((host) => host.id === id),
    findByHermesId: async (hermesId) =>
      (await load()).hosts.find(
        (host) =>
          hostHasCapability(host, "hermes") && hermesKeyFor(host) === hermesId,
      ),
    withCapability: async (capability) =>
      (await load()).hosts.filter((host) =>
        hostHasCapability(host, capability)
      ),
    upsert: async (host) => {
      await ensure();
      if (
        (host.kind === "local" && host.id !== LOCAL_HOST_ID) ||
        (host.id === LOCAL_HOST_ID && host.kind !== "local")
      ) {
        throw new RemoteHostsError(
          "validation",
          `host id "${LOCAL_HOST_ID}" and kind local are an immutable pair`,
        );
      }
      if (host.kind === "local" && host.sshEndpoint !== undefined) {
        throw new RemoteHostsError(
          "validation",
          "the local host cannot carry an enrollment sshEndpoint",
        );
      }

      const next = await runRegistryEffect(
        persistence.upsert(host).pipe(Effect.map(projectDocument)),
      );
      return next.hosts;
    },
    remove: async (id) => {
      await ensure();
      if (id === LOCAL_HOST_ID) {
        throw new RemoteHostsError(
          "conflict",
          "cannot remove the local station host",
        );
      }

      const next = await runRegistryEffect(
        persistence.remove(id).pipe(Effect.map(projectDocument)),
      );
      return next.hosts;
    },
    reload: async () => (await load()).hosts,
  };
};

let defaultRegistry: HostsRegistry | undefined;

export const getDefaultHostsRegistry = (
  persistence?: HostsPersistence["Service"],
  runPromise?: HostsRegistryRunPromise,
): HostsRegistry => {
  if (!defaultRegistry && persistence && runPromise) {
    defaultRegistry = makeHostsRegistry(persistence, runPromise);
  }
  if (!defaultRegistry) {
    throw new RemoteHostsError(
      "io",
      "hosts registry requested before StateEngine hydration",
    );
  }
  return defaultRegistry;
};

export const resetDefaultHostsRegistryForTests = (): void => {
  defaultRegistry = undefined;
};
