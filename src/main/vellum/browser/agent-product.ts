import type { CanvasDoc } from "@shared/canvas";
import type { BrowserAutomationConfirmation } from "./agent-authority";
import {
  BrowserAutomationRuntime,
  type BrowserAutomationHerdrPaneMetaResult,
  type BrowserAutomationRuntimeDelivery,
} from "./agent-runtime";
import {
  makeBrowserCapabilityRegistry,
  type BrowserCapabilityRegistry,
} from "./capabilities";
import { startLocalHerdrBrowserAgent } from "./herdr-agent-delivery";
import type { PageTargetResolver } from "./page-target";
import type { BrowserSessionService } from "./sessions";
import type { ChatService } from "../chat/service";
import { LocalMirrorTransport } from "../herdr/mirror-transport";
import type { HerdrService } from "../herdr/service";

const TERMINATION_REASON = "browser authority ended";
const DELIVERY_FAILURE_MESSAGE = "browser automation delivery failed";

type BrowserOwnerSessions = Pick<BrowserSessionService, "destroyOwnerSessions">;
type BrowserAuthorityChat = Pick<
  ChatService,
  "chatRestartWithLocalBrowserAuthority" | "chatRevokeLocalBrowserAuthority"
>;
type BrowserAuthorityHerdr = Pick<HerdrService, "killPane">;

export interface BrowserAutomationProductDependencies {
  readonly sessions: BrowserOwnerSessions;
  readonly chat: BrowserAuthorityChat;
  readonly herdr: BrowserAuthorityHerdr;
  readonly readCanvas: (name: string) => Promise<CanvasDoc>;
  readonly resolvePageTarget: PageTargetResolver;
  readonly getHerdrPaneMeta: (
    host: "local",
    session: null,
    paneId: string,
  ) => Promise<BrowserAutomationHerdrPaneMetaResult>;
  readonly confirm: (request: BrowserAutomationConfirmation) => Promise<boolean>;
  readonly controlHome?: string;
  readonly makeAutomationId?: () => string;
  /** Test seam; production omits this and gets a fresh real local transport. */
  readonly makeLocalTransport?: () => LocalMirrorTransport;
}

export interface BrowserAutomationProduct {
  readonly registry: BrowserCapabilityRegistry;
  readonly runtime: BrowserAutomationRuntime;
  readonly reapAfterResume: () => number;
  readonly close: () => number;
}

class BrowserAutomationDeliveryFailure extends Error {
  override readonly name = "BrowserAutomationDeliveryFailure";

  constructor() {
    super(DELIVERY_FAILURE_MESSAGE);
  }
}

const swallowCleanup = async (operation: () => unknown | Promise<unknown>): Promise<void> => {
  try {
    await operation();
  } catch {
    // Cleanup is best-effort and must never relay service-controlled errors.
  }
};

const makeHermesCleanup = (
  chat: BrowserAuthorityChat,
  agentKey: string,
): (() => Promise<void>) =>
  () => swallowCleanup(() => chat.chatRevokeLocalBrowserAuthority(agentKey));

const makeHerdrCleanup = (
  herdr: BrowserAuthorityHerdr,
  paneId: string,
): (() => Promise<void>) =>
  () => swallowCleanup(() => herdr.killPane("local", null, paneId));

const deliverHermes = async (
  dependencies: BrowserAutomationProductDependencies,
  delivery: BrowserAutomationRuntimeDelivery & {
    readonly plan: Extract<BrowserAutomationRuntimeDelivery["plan"], { readonly kind: "hermes" }>;
  },
) => {
  const agentKey = delivery.plan.agentKey;
  const revoke = makeHermesCleanup(dependencies.chat, agentKey);

  try {
    const result = await dependencies.chat.chatRestartWithLocalBrowserAuthority(
      agentKey,
      {
        capability: delivery.capability,
        home: delivery.controlHome,
      },
    );
    if (!result.ok) {
      throw new BrowserAutomationDeliveryFailure();
    }
  } catch (error) {
    await revoke();
    if (error instanceof BrowserAutomationDeliveryFailure) throw error;
    throw new BrowserAutomationDeliveryFailure();
  }

  return Object.freeze({ cleanup: revoke });
};

const deliverHerdr = async (
  dependencies: BrowserAutomationProductDependencies,
  delivery: BrowserAutomationRuntimeDelivery & {
    readonly plan: Extract<BrowserAutomationRuntimeDelivery["plan"], { readonly kind: "herdr" }>;
  },
) => {
  const transport = dependencies.makeLocalTransport?.() ?? new LocalMirrorTransport();
  let spawned: Awaited<ReturnType<typeof startLocalHerdrBrowserAgent>>;
  try {
    spawned = await startLocalHerdrBrowserAgent(transport, {
      agent: delivery.plan.agent,
      capability: delivery.capability,
      controlHome: delivery.controlHome,
      cwd: delivery.plan.cwd,
      workspaceId: delivery.plan.workspaceId,
      tabId: delivery.plan.tabId,
    });
  } catch {
    throw new BrowserAutomationDeliveryFailure();
  } finally {
    try {
      transport.dispose();
    } catch {
      // The one-shot transport owns no persistent process or socket.
    }
  }

  if (
    spawned.workspaceId !== delivery.plan.workspaceId ||
    spawned.tabId !== delivery.plan.tabId ||
    spawned.paneId === delivery.plan.paneId
  ) {
    throw new BrowserAutomationDeliveryFailure();
  }

  return Object.freeze({ cleanup: makeHerdrCleanup(dependencies.herdr, spawned.paneId) });
};

/**
 * Owns the one capability registry used by both agent issuance and the browser
 * control server. The caller passes `registry` to `startBrowserControlServer`.
 */
export const makeBrowserAutomationProduct = (
  dependencies: BrowserAutomationProductDependencies,
): BrowserAutomationProduct => {
  let terminationRuntime: BrowserAutomationRuntime | undefined;
  const registry = makeBrowserCapabilityRegistry({
    onTerminate: (notice) => {
      try {
        dependencies.sessions.destroyOwnerSessions(notice.auditId, TERMINATION_REASON);
      } catch {
        // Browser-owner teardown cannot suppress authority cleanup.
      }
      try {
        terminationRuntime?.handleTermination(notice);
      } catch {
        // Registry termination must remain complete if an observer fails.
      }
    },
  });

  const runtime = new BrowserAutomationRuntime(registry, {
    readCanvas: dependencies.readCanvas,
    resolvePageTarget: dependencies.resolvePageTarget,
    getHerdrPaneMeta: dependencies.getHerdrPaneMeta,
    confirm: dependencies.confirm,
    deliver: (delivery) =>
      delivery.plan.kind === "hermes"
        ? deliverHermes(dependencies, {
            ...delivery,
            plan: delivery.plan,
          })
        : deliverHerdr(dependencies, {
            ...delivery,
            plan: delivery.plan,
          }),
    ...(dependencies.controlHome === undefined
      ? {}
      : { controlHome: dependencies.controlHome }),
    ...(dependencies.makeAutomationId === undefined
      ? {}
      : { makeAutomationId: dependencies.makeAutomationId }),
  });
  terminationRuntime = runtime;

  let closed = false;
  return Object.freeze({
    registry,
    runtime,
    reapAfterResume: (): number => registry.reapAfterResume(),
    close: (): number => {
      if (closed) return 0;
      closed = true;
      return runtime.close();
    },
  });
};
