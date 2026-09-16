import type { Session, WebContents } from "electron";
import {
  browserTestOnlyExactOrigin,
  type BrowserTestOnlyExactOriginGrant,
} from "./web-policy";
import { startBrowserEgressProxy, type BrowserEgressProxyHandle } from "./egress-proxy";

export interface BrowserPartitionNetworkHandle {
  readonly partition: string;
  readonly session: Session;
  readonly proxy: BrowserEgressProxyHandle;
  readonly close: () => Promise<void>;
}

interface PartitionNetworkState {
  readonly partition: string;
  readonly grant?: BrowserTestOnlyExactOriginGrant;
  refCount: number;
  flight: Promise<BrowserPartitionNetworkHandle>;
}

const partitions = new Map<string, PartitionNetworkState>();
const credentialsByEndpoint = new Map<string, BrowserEgressProxyHandle>();
let loginInstalled = false;
let loginOwner: ((webContents: WebContents | undefined, details: Electron.AuthInfo) => BrowserEgressProxyHandle | undefined) | undefined;

const endpointKey = (host: string, port: number): string => `${host}:${String(port)}`;

const sameGrant = (
  left: BrowserTestOnlyExactOriginGrant | undefined,
  right: BrowserTestOnlyExactOriginGrant | undefined,
): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return browserTestOnlyExactOrigin(left) === browserTestOnlyExactOrigin(right);
};

const installLoginHandler = (app: Electron.App): void => {
  if (loginInstalled) return;
  loginInstalled = true;
  loginOwner = (_webContents, details) => {
    if (!details.isProxy) return undefined;
    return credentialsByEndpoint.get(endpointKey(details.host, details.port));
  };
  app.on("login", (event, _webContents, _authenticationResponseDetails, authInfo, callback) => {
    const proxy = loginOwner?.(_webContents, authInfo);
    if (proxy === undefined) return;
    if (
      authInfo.host !== proxy.host ||
      authInfo.port !== proxy.port ||
      authInfo.realm !== proxy.credentials.realm
    ) {
      return;
    }
    event.preventDefault();
    callback(proxy.credentials.username, proxy.credentials.password);
  });
};

export const installBrowserEgressProxyAuth = (app: Electron.App): void => {
  installLoginHandler(app);
};

const preparePartition = async (
  session: Session,
  partition: string,
  grant: BrowserTestOnlyExactOriginGrant | undefined,
): Promise<BrowserPartitionNetworkHandle> => {
  const proxy = await startBrowserEgressProxy({
    resolveHost: (hostname) =>
      session.resolveHost(hostname, {
        cacheUsage: "disallowed",
        secureDnsPolicy: "allow",
      }),
    grant,
  });
  credentialsByEndpoint.set(endpointKey(proxy.host, proxy.port), proxy);
  await session.setProxy({
    mode: "fixed_servers",
    proxyRules: proxy.proxyRules,
    proxyBypassRules: proxy.proxyBypassRules,
  });
  if (typeof session.forceReloadProxyConfig === "function") {
    await session.forceReloadProxyConfig();
  }
  await session.closeAllConnections();
  const close = async (): Promise<void> => {
    credentialsByEndpoint.delete(endpointKey(proxy.host, proxy.port));
    if (partitions.get(partition)?.flight !== undefined) partitions.delete(partition);
    await proxy.close();
  };
  return { partition, session, proxy, close };
};

export const ensureManagedBrowserPartitionNetwork = (
  session: Session,
  partition: string,
  grant?: BrowserTestOnlyExactOriginGrant,
): Promise<BrowserPartitionNetworkHandle> => {
  const existing = partitions.get(partition);
  if (existing !== undefined) {
    if (!sameGrant(existing.grant, grant)) {
      return Promise.reject(new Error("browser partition network grant mismatch"));
    }
    existing.refCount += 1;
    return existing.flight;
  }
  const state: PartitionNetworkState = {
    partition,
    grant,
    refCount: 1,
    flight: Promise.resolve().then(() => preparePartition(session, partition, grant)),
  };
  partitions.set(partition, state);
  state.flight.catch(() => {
    if (partitions.get(partition) === state) partitions.delete(partition);
  });
  return state.flight;
};

export const releaseManagedBrowserPartitionNetwork = async (partition: string): Promise<void> => {
  const existing = partitions.get(partition);
  if (existing === undefined) return;
  existing.refCount = Math.max(0, existing.refCount - 1);
  if (existing.refCount > 0 || partition.startsWith("persist:")) return;
  await closeManagedBrowserPartitionNetwork(partition);
};

export const closeManagedBrowserPartitionNetwork = async (partition: string): Promise<void> => {
  const existing = partitions.get(partition);
  if (existing === undefined) return;
  try {
    const handle = await existing.flight;
    await handle.close();
  } catch {
    partitions.delete(partition);
  }
};

export const closeAllManagedBrowserPartitionNetworks = async (): Promise<void> => {
  const states = [...partitions.values()];
  partitions.clear();
  await Promise.allSettled(
    states.map(async (state) => {
      try {
        const handle = await state.flight;
        await handle.close();
      } catch {
        // Partition never became ready.
      }
    }),
  );
};

export const managedBrowserProxyAuthForEndpoint = (
  host: string,
  port: number,
): BrowserEgressProxyHandle | undefined => credentialsByEndpoint.get(endpointKey(host, port));
