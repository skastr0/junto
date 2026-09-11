import { hostname } from "node:os";
import { isIP } from "node:net";
import { Context, Effect, Schema } from "effect";
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
import {
  StateEngine,
  StateEngineError,
  type StateReader,
  type StateWriter,
} from "../state/service";

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

type StateService = Context.Service.Shape<typeof StateEngine>;

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

type RegistryStateRow = {
  readonly singleton: number;
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

const readStoredDocument = (reader: StateReader): RemoteHostsDocument => {
  const hosts = reader
    .all<HostRow>(`
      SELECT
        id,
        label,
        kind,
        ssh_endpoint,
        ssh_identity_file,
        ssh_host_key_policy,
        capability_mask,
        hermes_id,
        appearance_color,
        appearance_glyph,
        sort_order
      FROM host_registry
      ORDER BY sort_order
    `)
    .map(rowToHost);
  validateHosts(hosts);
  return { version: REMOTE_HOSTS_VERSION, hosts };
};

const writeHost = (
  writer: StateWriter,
  host: RemoteHost,
  sortOrder: number,
): void => {
  const mask = capabilityMask(host);
  const effectiveHermesId = hostHasCapability(host, "hermes")
    ? hermesKeyFor(host)
    : null;
  writer.run(
    `
      INSERT INTO host_registry(
        id,
        label,
        kind,
        ssh_endpoint,
        ssh_identity_file,
        ssh_host_key_policy,
        capability_mask,
        hermes_id,
        effective_hermes_id,
        appearance_color,
        appearance_glyph,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        kind = excluded.kind,
        ssh_endpoint = excluded.ssh_endpoint,
        ssh_identity_file = excluded.ssh_identity_file,
        ssh_host_key_policy = excluded.ssh_host_key_policy,
        capability_mask = excluded.capability_mask,
        hermes_id = excluded.hermes_id,
        effective_hermes_id = excluded.effective_hermes_id,
        appearance_color = excluded.appearance_color,
        appearance_glyph = excluded.appearance_glyph,
        sort_order = excluded.sort_order
    `,
    [
      host.id,
      host.label,
      host.kind,
      host.kind === "remote" ? (host.sshEndpoint ?? null) : null,
      host.kind === "remote" ? (host.sshIdentityFile ?? null) : null,
      host.kind === "remote" ? (host.sshHostKeyPolicy ?? null) : null,
      mask,
      host.hermesId ?? null,
      effectiveHermesId,
      host.appearance?.color ?? null,
      host.appearance?.glyph ?? null,
      sortOrder,
    ],
  );
};

const stateError = (
  operation: string,
  error: StateEngineError,
): HostsStateError =>
  HostsStateError.make({
    operation,
    message: error.message,
    cause: error,
  });

const toRemoteHostsError = (
  error: HostsStateError | RemoteHostsError,
): RemoteHostsError =>
  error instanceof RemoteHostsError
    ? error
    : new RemoteHostsError(
        "io",
        `hosts database ${error.operation} failed: ${error.message}`,
      );

const stateMutationError = (
  operation: string,
  error: StateEngineError,
): RemoteHostsError =>
  error.cause instanceof RemoteHostsError
    ? error.cause
    : toRemoteHostsError(stateError(operation, error));

const registryState = (
  reader: StateReader,
): RegistryStateRow | undefined =>
  reader.get<RegistryStateRow>(`
    SELECT singleton
    FROM host_registry_state
    WHERE singleton = 1
  `);

/**
 * Establish the exact-current host registry inside an existing StateEngine
 * transaction. Station configuration and the normal HostsService bootstrap
 * share this construction so neither can create a partial registry.
 */
export const ensureHostRegistryState = (
  writer: StateWriter,
  initializedAt: string,
): void => {
  if (registryState(writer) !== undefined) return;
  const existing = writer.get<{ readonly count: number }>(
    "SELECT count(*) AS count FROM host_registry",
  )?.count ?? 0;
  if (existing !== 0) {
    throw new Error(
      "host registry rows exist without initialization metadata",
    );
  }
  writeHost(writer, defaultRemoteHostsDocument().hosts[0]!, 0);
  writer.run(
    `
      INSERT INTO host_registry_state(
        singleton,
        version,
        initialized_at
      )
      VALUES (1, 1, ?)
    `,
    [initializedAt],
  );
};

/**
 * Canonical host mutation used by both operator enrollment and authenticated
 * Remote configuration. Validation is against the complete resulting
 * registry, so endpoint and Hermes-key uniqueness remain transaction facts.
 */
export const upsertHostState = (
  writer: StateWriter,
  host: RemoteHost,
): RemoteHostsDocument => {
  const current = readStoredDocument(writer);
  const entry =
    host.id === LOCAL_HOST_ID
      ? makeLocalHost({
          label: host.label,
          hermesId: host.hermesId,
          appearance: host.appearance,
        })
      : host;
  const nextHosts = [...current.hosts];
  const index = nextHosts.findIndex((row) => row.id === entry.id);
  if (index >= 0) nextHosts[index] = entry;
  else nextHosts.push(entry);
  validateHosts(nextHosts);

  const currentOrder = writer.get<{ readonly sort_order: number }>(
    "SELECT sort_order FROM host_registry WHERE id = ?",
    [entry.id],
  )?.sort_order;
  const maxOrder = writer.get<{
    readonly max_order: number | null;
  }>(
    "SELECT max(sort_order) AS max_order FROM host_registry",
  )?.max_order ?? 0;
  writeHost(writer, entry, currentOrder ?? maxOrder + 1);
  return readStoredDocument(writer);
};

const initializeRegistry = (
  state: StateService,
): Effect.Effect<void, HostsStateError> =>
  Effect.gen(function* () {
    const initialized = yield* state
      .read("hosts.initialized", registryState)
      .pipe(Effect.mapError((error) => stateError("initialize-read", error)));
    if (initialized !== undefined) return;

    const initializedAt = new Date().toISOString();
    yield* state
      .transaction("hosts.initialize", (writer) => {
        ensureHostRegistryState(writer, initializedAt);
      })
      .pipe(Effect.mapError((error) => stateError("initialize-write", error)));
  }).pipe(Effect.withSpan("hosts.initialize"));

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
  state: StateService,
  runPromise: HostsRegistryRunPromise,
): HostsRegistry => {
  const runRegistryEffect = makeRunRegistryEffect(runPromise);
  let initialization: Promise<void> | undefined;

  const ensure = (): Promise<void> => {
    if (initialization) return initialization;
    initialization = runRegistryEffect(
      initializeRegistry(state).pipe(Effect.mapError(toRemoteHostsError)),
    ).catch((error) => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  };

  const load = async (): Promise<RemoteHostsDocument> => {
    await ensure();
    return runRegistryEffect(
      state
        .read("hosts.list", readStoredDocument)
        .pipe(
          Effect.map(projectDocument),
          Effect.mapError((error) =>
            toRemoteHostsError(stateError("list", error))
          ),
        ),
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
        state
          .transaction("hosts.upsert", (writer) => {
            return upsertHostState(writer, host);
          })
          .pipe(
            Effect.map(projectDocument),
            Effect.mapError((error) => stateMutationError("upsert", error)),
          ),
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
        state
          .transaction("hosts.remove", (writer) => {
            const current = readStoredDocument(writer);
            if (!current.hosts.some((host) => host.id === id)) {
              throw new RemoteHostsError(
                "not_found",
                `unknown host: ${id}`,
              );
            }
            // Dependent product rows that RESTRICT host_registry deletion.
            for (const sql of [
              "DELETE FROM box_resources WHERE host_id = ?",
              "DELETE FROM station_fleet_targets WHERE host_id = ?",
            ] as const) {
              try {
                writer.run(sql, [id]);
              } catch {
                // Table may be absent on older isolated fixtures; continue.
              }
            }
            writer.run("DELETE FROM host_registry WHERE id = ?", [id]);
            return readStoredDocument(writer);
          })
          .pipe(
            Effect.map(projectDocument),
            Effect.mapError((error) => stateMutationError("remove", error)),
          ),
      );
      return next.hosts;
    },
    reload: async () => (await load()).hosts,
  };
};

let defaultRegistry: HostsRegistry | undefined;

export const getDefaultHostsRegistry = (
  state?: StateService,
  runPromise?: HostsRegistryRunPromise,
): HostsRegistry => {
  if (!defaultRegistry && state && runPromise) {
    defaultRegistry = makeHostsRegistry(state, runPromise);
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
