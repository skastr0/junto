import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { Either, Schema } from "effect";
import {
  BROWSER_HOST_CAPABILITY,
  REMOTE_HOSTS_VERSION,
  RemoteHostsDocument,
  RemoteHostsError,
  defaultRemoteHostsDocument,
  hermesKeyFor,
  hostHasCapability,
  type HostCapability,
  type RemoteHost,
  type RemoteHostsDocument as RemoteHostsDocumentT,
} from "@shared/remote-hosts";

const decodeDocument = Schema.decodeUnknownEither(RemoteHostsDocument);
const MAX_BYTES = 64 * 1024;

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

export const remoteHostsFilePath = (): string =>
  process.env.VELLUM_HOSTS_PATH || join(homedir(), ".vellum", "hosts.json");

const validateHosts = (hosts: ReadonlyArray<RemoteHost>): void => {
  const ids = new Set<string>();
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
      if (host.endpoint) {
        throw new RemoteHostsError(
          "validation",
          `local host ${host.id} must not set endpoint`,
        );
      }
    } else if (!host.endpoint) {
      throw new RemoteHostsError(
        "validation",
        `remote host ${host.id} requires endpoint`,
      );
    } else if (!isSupportedSshDestination(host.endpoint)) {
      throw new RemoteHostsError(
        "validation",
        `remote host ${host.id} endpoint must be an SSH config alias, user@host, or IPv6 literal; configure custom ports in ~/.ssh/config`,
      );
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

    // local is reserved as the sole kind=local host.
    if (host.kind === "local" && host.id !== "local") {
      throw new RemoteHostsError(
        "validation",
        `only id "local" may use kind local (got ${host.id})`,
      );
    }
    if (host.id === "local" && host.kind !== "local") {
      throw new RemoteHostsError(
        "validation",
        `host id "local" must use kind local`,
      );
    }
  }

  if (!hosts.some((host) => host.id === "local" && host.kind === "local")) {
    throw new RemoteHostsError(
      "validation",
      "registry must include the local host",
    );
  }
};

/**
 * V1 documents predate the explicit browser capability. This machine's
 * reserved local record is the only capability we can migrate from product
 * fact; remote SSH records remain exactly user-authored.
 */
const migrateBrowserCapability = (
  document: RemoteHostsDocumentT,
): RemoteHostsDocumentT => {
  let changed = false;
  const hosts = document.hosts.map((host) => {
    if (
      host.id !== "local" ||
      host.kind !== "local" ||
      host.capabilities.includes(BROWSER_HOST_CAPABILITY)
    ) {
      return host;
    }
    changed = true;
    return {
      ...host,
      capabilities: [...host.capabilities, BROWSER_HOST_CAPABILITY],
    };
  });
  return changed ? { ...document, hosts } : document;
};

const atomicWrite = async (
  path: string,
  document: RemoteHostsDocumentT,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_BYTES) {
    throw new RemoteHostsError(
      "validation",
      `hosts document exceeds ${MAX_BYTES} byte ceiling`,
    );
  }
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
};

export const loadRemoteHostsDocument = async (
  path: string = remoteHostsFilePath(),
): Promise<RemoteHostsDocumentT> => {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new RemoteHostsError("io", "hosts path is not a regular file");
    }
    if (info.size > MAX_BYTES) {
      throw new RemoteHostsError("io", "hosts file exceeds size ceiling");
    }
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new RemoteHostsError(
        "validation",
        `hosts.json unreadable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const decoded = decodeDocument(parsed);
    if (Either.isLeft(decoded)) {
      throw new RemoteHostsError(
        "validation",
        `hosts.json schema invalid: ${decoded.left.message}`,
      );
    }
    const migrated = migrateBrowserCapability(decoded.right);
    validateHosts(migrated.hosts);
    if (migrated !== decoded.right) await atomicWrite(path, migrated);
    return migrated;
  } catch (error) {
    if (error instanceof RemoteHostsError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const fresh = defaultRemoteHostsDocument();
      await atomicWrite(path, fresh);
      return fresh;
    }
    throw new RemoteHostsError(
      "io",
      error instanceof Error ? error.message : String(error),
    );
  }
};

export const saveRemoteHostsDocument = async (
  document: RemoteHostsDocumentT,
  path: string = remoteHostsFilePath(),
): Promise<RemoteHostsDocumentT> => {
  if (document.version !== REMOTE_HOSTS_VERSION) {
    throw new RemoteHostsError(
      "validation",
      `unsupported hosts document version: ${document.version}`,
    );
  }
  validateHosts(document.hosts);
  await atomicWrite(path, document);
  return document;
};

export interface HostsRegistry {
  readonly path: () => string;
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
  path: string = remoteHostsFilePath(),
): HostsRegistry => {
  let cached: RemoteHostsDocumentT | undefined;
  let inFlight: Promise<RemoteHostsDocumentT> | null = null;
  let writeChain: Promise<unknown> = Promise.resolve();

  const ensure = async (): Promise<RemoteHostsDocumentT> => {
    if (cached) return cached;
    if (inFlight) return inFlight;
    const promise = loadRemoteHostsDocument(path)
      .then((document) => {
        cached = document;
        return document;
      })
      .finally(() => {
        if (inFlight === promise) inFlight = null;
      });
    inFlight = promise;
    return promise;
  };

  const withWrite = <A>(fn: () => Promise<A>): Promise<A> => {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    path: () => path,
    list: async () => (await ensure()).hosts,
    get: async (id) => (await ensure()).hosts.find((host) => host.id === id),
    findByHermesId: async (hermesId) =>
      (await ensure()).hosts.find(
        (host) =>
          hostHasCapability(host, "hermes") && hermesKeyFor(host) === hermesId,
      ),
    withCapability: async (capability) =>
      (await ensure()).hosts.filter((host) => hostHasCapability(host, capability)),
    upsert: (host) =>
      withWrite(async () => {
        const current = await ensure();
        const nextHosts = [...current.hosts];
        const index = nextHosts.findIndex((entry) => entry.id === host.id);
        if (index >= 0) nextHosts[index] = host;
        else nextHosts.push(host);
        const next = await saveRemoteHostsDocument(
          { version: REMOTE_HOSTS_VERSION, hosts: nextHosts },
          path,
        );
        cached = next;
        return next.hosts;
      }),
    remove: (id) =>
      withWrite(async () => {
        if (id === "local") {
          throw new RemoteHostsError("conflict", "cannot remove the local host");
        }
        const current = await ensure();
        if (!current.hosts.some((host) => host.id === id)) {
          throw new RemoteHostsError("not_found", `unknown host: ${id}`);
        }
        const next = await saveRemoteHostsDocument(
          {
            version: REMOTE_HOSTS_VERSION,
            hosts: current.hosts.filter((host) => host.id !== id),
          },
          path,
        );
        cached = next;
        return next.hosts;
      }),
    reload: () =>
      withWrite(async () => {
        // A reload is an ordered disk boundary, not merely a cache clear. Wait
        // for an earlier initial read, then force a fresh read after all prior
        // writes so callers cannot publish an older routing snapshot.
        if (inFlight) {
          try {
            await inFlight;
          } catch {
            // The fresh read below is the retry and owns the surfaced error.
          }
        }
        cached = undefined;
        return (await ensure()).hosts;
      }),
  };
};

/** Process-wide default registry (overridable in tests via VELLUM_HOSTS_PATH). */
let defaultRegistry: HostsRegistry | undefined;

export const getDefaultHostsRegistry = (): HostsRegistry => {
  if (!defaultRegistry) defaultRegistry = makeHostsRegistry();
  return defaultRegistry;
};

/** Test seam — reset the process-wide registry after pointing VELLUM_HOSTS_PATH. */
export const resetDefaultHostsRegistryForTests = (): void => {
  defaultRegistry = undefined;
};
