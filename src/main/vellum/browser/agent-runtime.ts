import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { isValidProfileId } from "@shared/browser";
import {
  BROWSER_MAX_METADATA_BYTES,
  clampUtf8Bytes,
  isUtf8WithinLimit,
  isValidBrowserSessionId,
} from "@shared/browser-limits";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import {
  type BrowserAutomationEnableInput,
  type BrowserAutomationEnableResult,
  type BrowserAutomationErrorCode,
  type BrowserAutomationHerdrAgent,
  type BrowserAutomationListResult,
  type BrowserAutomationRevokeResult,
  type BrowserAutomationSummary,
} from "@shared/ipc";
import {
  formatNodeRef,
  parseNodeRef,
  type NodeRef,
  type NodeRefKey,
} from "@shared/node-ref";
import { buildAcpSpawnTarget } from "../chat/spawn";
import {
  BrowserAgentAuthority,
  type BrowserAutomationConfirmation,
  type BrowserAutomationDelivery,
  type BrowserAutomationDeliveryReceipt,
  type BrowserAutomationGrantSummary,
  type BrowserAutomationSubject,
} from "./agent-authority";
import {
  type BrowserCapabilityRegistry,
  type BrowserCapabilityTerminationNotice,
} from "./capabilities";
import {
  SUPPORTED_HERDR_BROWSER_AGENTS,
  type SupportedHerdrBrowserAgent,
} from "./herdr-agent-delivery";
import type { PageTargetResolver, ResolvedPageTarget } from "./page-target";

const MAX_PAGE_TARGETS = 64;
const MAX_SUBJECT_LABEL_BYTES = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const AUTOMATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUPPORTED_HERDR_AGENTS = new Set<string>(SUPPORTED_HERDR_BROWSER_AGENTS);

const HERMES_INPUT_KEYS = new Set(["kind", "ref"]);
const HERDR_INPUT_KEYS = new Set(["kind", "ref", "agent"]);

export interface BrowserAutomationHermesPlan {
  readonly kind: "hermes";
  readonly ref: NodeRefKey;
  readonly subject: BrowserAutomationSubject;
  readonly agentKey: string;
  readonly spawnTarget: {
    readonly command: string;
    readonly argv: ReadonlyArray<string>;
    readonly host: "local";
    readonly profile: string;
  };
  readonly targets: ReadonlyArray<ResolvedPageTarget>;
}

export interface BrowserAutomationHerdrPlan {
  readonly kind: "herdr";
  readonly ref: NodeRefKey;
  readonly subject: BrowserAutomationSubject;
  readonly agent: BrowserAutomationHerdrAgent;
  readonly paneId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly cwd: string;
  readonly targets: ReadonlyArray<ResolvedPageTarget>;
}

export type BrowserAutomationRuntimePlan =
  | BrowserAutomationHermesPlan
  | BrowserAutomationHerdrPlan;

export interface BrowserAutomationRuntimeDelivery {
  readonly plan: BrowserAutomationRuntimePlan;
  readonly capability: string;
  readonly controlHome: string;
  readonly expiresAt: number;
}

export interface BrowserAutomationHerdrPaneMeta {
  readonly paneId: string;
  readonly workspaceId?: string;
  readonly tabId?: string;
  readonly cwd?: string;
  readonly foregroundCwd?: string;
}

export type BrowserAutomationHerdrPaneMetaResult =
  | { readonly ok: true; readonly data: BrowserAutomationHerdrPaneMeta }
  | {
      readonly ok: false;
      readonly code: "invalid" | "not_found" | "missing" | "timeout" | "unreachable" | "failed";
      readonly message?: string;
    };

export interface BrowserAutomationRuntimeDependencies {
  readonly readCanvas: (name: string) => Promise<CanvasDoc>;
  readonly resolvePageTarget: PageTargetResolver;
  readonly getHerdrPaneMeta: (
    host: "local",
    session: null,
    paneId: string,
  ) => Promise<BrowserAutomationHerdrPaneMetaResult>;
  readonly confirm: (request: BrowserAutomationConfirmation) => Promise<boolean>;
  readonly deliver: (
    request: BrowserAutomationRuntimeDelivery,
  ) => Promise<BrowserAutomationDeliveryReceipt | void>;
  readonly controlHome?: string;
  readonly makeAutomationId?: () => string;
}

interface PreparedPlan {
  readonly input: BrowserAutomationEnableInput;
  readonly plan: BrowserAutomationRuntimePlan;
  readonly fingerprint: string;
  deliveryStarted: boolean;
}

interface ActiveLocator {
  readonly kind: "hermes" | "herdr";
  readonly ref: NodeRefKey;
  readonly agent?: BrowserAutomationHerdrAgent;
}

class RuntimeDenied extends Error {
  override readonly name = "RuntimeDenied";

  constructor(readonly code: BrowserAutomationErrorCode) {
    super("browser automation runtime denied");
  }
}

const fail = (code: BrowserAutomationErrorCode): { readonly ok: false; readonly code: BrowserAutomationErrorCode } =>
  Object.freeze({ ok: false, code });

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
};

const isSupportedHerdrAgent = (value: unknown): value is SupportedHerdrBrowserAgent =>
  typeof value === "string" && SUPPORTED_HERDR_AGENTS.has(value);

const decodeInput = (value: unknown): BrowserAutomationEnableInput => {
  if (!isPlainRecord(value) || typeof value.ref !== "string") throw new RuntimeDenied("invalid");
  const parsed = parseNodeRef(value.ref);
  if (!parsed.ok || formatNodeRef(parsed.value) !== value.ref) throw new RuntimeDenied("invalid");
  if (value.kind === "hermes" && hasExactKeys(value, HERMES_INPUT_KEYS)) {
    return Object.freeze({ kind: "hermes", ref: value.ref });
  }
  if (
    value.kind === "herdr" &&
    hasExactKeys(value, HERDR_INPUT_KEYS) &&
    isSupportedHerdrAgent(value.agent)
  ) {
    return Object.freeze({ kind: "herdr", ref: value.ref, agent: value.agent });
  }
  throw new RuntimeDenied("invalid");
};

const subjectKey = (subject: BrowserAutomationSubject): string =>
  `${subject.kind}\u0000${subject.id}`;

const requestKey = (input: BrowserAutomationEnableInput): string =>
  `${input.kind}\u0000${input.ref}\u0000${input.kind === "herdr" ? input.agent : ""}`;

const stableDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("base64url");

const stableSubjectId = (...identity: ReadonlyArray<string>): string =>
  stableDigest(Object.freeze([...identity]));

const immutableSubject = (
  kind: "hermes" | "herdr",
  identity: ReadonlyArray<string>,
  label: string,
): BrowserAutomationSubject => {
  if (
    label.length === 0 ||
    CONTROL_CHARACTER.test(label) ||
    !isUtf8WithinLimit(label, MAX_SUBJECT_LABEL_BYTES)
  ) {
    throw new RuntimeDenied("invalid");
  }
  return Object.freeze({ kind, id: stableSubjectId(...identity), label });
};

const isCanonicalAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !CONTROL_CHARACTER.test(value) &&
  isUtf8WithinLimit(value, BROWSER_MAX_METADATA_BYTES) &&
  isAbsolute(value) &&
  normalize(value) === value;

const immutableTarget = (target: ResolvedPageTarget): ResolvedPageTarget =>
  Object.freeze({
    ref: target.ref,
    nodeId: target.nodeId,
    url: target.url,
    profile: target.profile,
  });

const matchingSelectedNodes = (doc: CanvasDoc, ref: NodeRef): ReadonlyArray<CanvasNode> =>
  doc.nodes.filter((node) => node.id === ref.nodeId);

const fingerprintPlan = (plan: BrowserAutomationRuntimePlan): string => {
  const targets = plan.targets.map((target) => ({
    ref: target.ref,
    nodeId: target.nodeId,
    url: target.url,
    profile: target.profile,
  }));
  return plan.kind === "hermes"
    ? stableDigest({
        kind: plan.kind,
        ref: plan.ref,
        subject: plan.subject,
        agentKey: plan.agentKey,
        spawnTarget: plan.spawnTarget,
        targets,
      })
    : stableDigest({
        kind: plan.kind,
        ref: plan.ref,
        subject: plan.subject,
        agent: plan.agent,
        paneId: plan.paneId,
        workspaceId: plan.workspaceId,
        tabId: plan.tabId,
        cwd: plan.cwd,
        targets,
      });
};

const publicSummary = (
  grant: BrowserAutomationGrantSummary,
  locator: ActiveLocator,
): BrowserAutomationSummary =>
  locator.kind === "hermes"
    ? Object.freeze({
        automationId: grant.id,
        kind: "hermes" as const,
        ref: locator.ref,
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
      })
    : Object.freeze({
        automationId: grant.id,
        kind: "herdr" as const,
        ref: locator.ref,
        agent: locator.agent as BrowserAutomationHerdrAgent,
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
      });

/**
 * Main-process authority adapter. Renderer input remains locator-only; every
 * security-relevant identity, placement, target, and lifetime comes from a
 * freshly read canvas or current main-process service result.
 */
export class BrowserAutomationRuntime {
  readonly #authority: BrowserAgentAuthority;
  readonly #pendingByRequest = new Set<string>();
  readonly #pendingBySubject = new Map<string, PreparedPlan>();
  readonly #activeLocators = new Map<string, ActiveLocator>();
  #closed = false;

  constructor(
    registry: BrowserCapabilityRegistry,
    private readonly dependencies: BrowserAutomationRuntimeDependencies,
  ) {
    this.#authority = new BrowserAgentAuthority(registry, {
      confirm: dependencies.confirm,
      deliver: (delivery) => this.#deliver(delivery),
      ...(dependencies.controlHome === undefined
        ? {}
        : { controlHome: dependencies.controlHome }),
      ...(dependencies.makeAutomationId === undefined
        ? {}
        : { makeGrantId: dependencies.makeAutomationId }),
    });
  }

  async enable(inputValue: BrowserAutomationEnableInput): Promise<BrowserAutomationEnableResult> {
    if (this.#closed) return fail("closed");
    let input: BrowserAutomationEnableInput;
    try {
      input = decodeInput(inputValue);
    } catch (error) {
      return fail(error instanceof RuntimeDenied ? error.code : "invalid");
    }

    const reservationKey = requestKey(input);
    if (this.#pendingByRequest.has(reservationKey)) return fail("invalid");
    this.#pendingByRequest.add(reservationKey);
    let pendingSubjectKey: string | undefined;

    try {
      const plan = await this.#prepare(input);
      if (this.#closed) return fail("closed");
      pendingSubjectKey = subjectKey(plan.subject);
      if (this.#pendingBySubject.has(pendingSubjectKey)) return fail("invalid");
      const pending: PreparedPlan = {
        input,
        plan,
        fingerprint: fingerprintPlan(plan),
        deliveryStarted: false,
      };
      this.#pendingBySubject.set(pendingSubjectKey, pending);

      const issued = await this.#authority.issue(plan.subject, plan.targets);
      if (!issued.ok) return fail(issued.code);
      if (!AUTOMATION_ID.test(issued.data.id)) {
        this.#authority.revoke(issued.data.id);
        this.#pruneActiveLocators();
        return fail("delivery_failed");
      }

      this.#activeLocators.set(
        issued.data.id,
        Object.freeze({
          kind: plan.kind,
          ref: plan.ref,
          ...(plan.kind === "herdr" ? { agent: plan.agent } : {}),
        }),
      );
      return Object.freeze({ ok: true as const, data: publicSummary(issued.data, this.#activeLocators.get(issued.data.id)!) });
    } catch (error) {
      return fail(error instanceof RuntimeDenied ? error.code : "delivery_failed");
    } finally {
      this.#pendingByRequest.delete(reservationKey);
      if (pendingSubjectKey !== undefined) this.#pendingBySubject.delete(pendingSubjectKey);
    }
  }

  list(): BrowserAutomationListResult {
    if (this.#closed) return fail("closed");
    const grants = this.#pruneActiveLocators();
    const data = grants
      .map((grant) => {
        const locator = this.#activeLocators.get(grant.id);
        return locator === undefined ? undefined : publicSummary(grant, locator);
      })
      .filter((summary): summary is BrowserAutomationSummary => summary !== undefined);
    return Object.freeze({ ok: true as const, data: Object.freeze(data) });
  }

  revoke(automationId: string): BrowserAutomationRevokeResult {
    if (this.#closed) return fail("closed");
    if (typeof automationId !== "string" || !AUTOMATION_ID.test(automationId)) {
      return fail("invalid");
    }
    const result = this.#authority.revoke(automationId);
    this.#pruneActiveLocators();
    return result.ok
      ? Object.freeze({ ok: true as const, data: Object.freeze({ revoked: true as const }) })
      : fail(result.code);
  }

  handleTermination(notice: BrowserCapabilityTerminationNotice): void {
    this.#authority.handleTermination(notice);
    this.#pruneActiveLocators();
  }

  close(): number {
    if (this.#closed) return 0;
    this.#closed = true;
    const closed = this.#authority.close();
    this.#activeLocators.clear();
    return closed;
  }

  async #prepare(input: BrowserAutomationEnableInput): Promise<BrowserAutomationRuntimePlan> {
    const parsed = parseNodeRef(input.ref);
    if (!parsed.ok || formatNodeRef(parsed.value) !== input.ref) throw new RuntimeDenied("invalid");

    let doc: CanvasDoc;
    try {
      doc = await this.dependencies.readCanvas(parsed.value.canvasName);
    } catch {
      throw new RuntimeDenied("not_found");
    }
    if (typeof doc !== "object" || doc === null || !Array.isArray(doc.nodes)) {
      throw new RuntimeDenied("delivery_failed");
    }

    const matches = matchingSelectedNodes(doc, parsed.value);
    if (matches.length === 0) throw new RuntimeDenied("not_found");
    if (matches.length !== 1) throw new RuntimeDenied("invalid");
    const selected = matches[0];
    if (selected === undefined) throw new RuntimeDenied("not_found");

    const subjectPlan =
      input.kind === "hermes"
        ? this.#prepareHermes(input.ref, selected)
        : await this.#prepareHerdr(input, selected);
    const targets = await this.#resolvePageTargets(parsed.value.canvasName, doc);

    if (subjectPlan.kind === "hermes") {
      const plan: BrowserAutomationHermesPlan = Object.freeze({ ...subjectPlan, targets });
      return plan;
    }
    const plan: BrowserAutomationHerdrPlan = Object.freeze({ ...subjectPlan, targets });
    return plan;
  }

  #prepareHermes(
    ref: NodeRefKey,
    node: CanvasNode,
  ): Omit<BrowserAutomationHermesPlan, "targets"> {
    if (node.ether?.entity?.kind !== "agent" || typeof node.ether.entity.name !== "string") {
      throw new RuntimeDenied("invalid");
    }
    const agentKey = node.ether.entity.name;
    if (
      agentKey.length === 0 ||
      CONTROL_CHARACTER.test(agentKey) ||
      !isUtf8WithinLimit(agentKey, MAX_SUBJECT_LABEL_BYTES)
    ) {
      throw new RuntimeDenied("invalid");
    }
    const spawnTarget = buildAcpSpawnTarget(agentKey);
    if (spawnTarget === undefined || spawnTarget.host !== "local") {
      throw new RuntimeDenied("invalid");
    }
    return Object.freeze({
      kind: "hermes" as const,
      ref,
      subject: immutableSubject("hermes", ["hermes", agentKey], agentKey),
      agentKey,
      spawnTarget: Object.freeze({
        command: spawnTarget.command,
        argv: Object.freeze([...spawnTarget.argv]),
        host: "local" as const,
        profile: spawnTarget.profile,
      }),
    });
  }

  async #prepareHerdr(
    input: Extract<BrowserAutomationEnableInput, { readonly kind: "herdr" }>,
    node: CanvasNode,
  ): Promise<Omit<BrowserAutomationHerdrPlan, "targets">> {
    const binding = node.ether?.herdr;
    if (
      node.ether?.entity?.kind !== "herdr" ||
      binding === undefined ||
      binding.host !== "local" ||
      (binding.session !== undefined && binding.session !== null) ||
      !isValidBrowserSessionId(binding.paneId) ||
      (binding.workspaceId !== undefined && !isValidBrowserSessionId(binding.workspaceId)) ||
      (binding.tabId !== undefined && !isValidBrowserSessionId(binding.tabId)) ||
      (binding.tabId !== undefined && binding.workspaceId === undefined)
    ) {
      throw new RuntimeDenied("invalid");
    }

    let metaResult: BrowserAutomationHerdrPaneMetaResult;
    try {
      metaResult = await this.dependencies.getHerdrPaneMeta("local", null, binding.paneId);
    } catch {
      throw new RuntimeDenied("delivery_failed");
    }
    if (!metaResult.ok) {
      throw new RuntimeDenied(metaResult.code === "not_found" ? "not_found" : "delivery_failed");
    }
    const meta = metaResult.data;
    if (
      meta.paneId !== binding.paneId ||
      !isValidBrowserSessionId(meta.workspaceId) ||
      !isValidBrowserSessionId(meta.tabId) ||
      (binding.workspaceId !== undefined && binding.workspaceId !== meta.workspaceId) ||
      (binding.tabId !== undefined && binding.tabId !== meta.tabId)
    ) {
      throw new RuntimeDenied("invalid");
    }
    const cwd = meta.foregroundCwd ?? meta.cwd;
    if (!isCanonicalAbsolutePath(cwd)) throw new RuntimeDenied("invalid");

    const label = clampUtf8Bytes(`${input.agent} @ ${binding.paneId}`, MAX_SUBJECT_LABEL_BYTES);
    return Object.freeze({
      kind: "herdr" as const,
      ref: input.ref,
      subject: immutableSubject("herdr", ["herdr", input.ref, input.agent], label),
      agent: input.agent,
      paneId: binding.paneId,
      workspaceId: meta.workspaceId,
      tabId: meta.tabId,
      cwd,
    });
  }

  async #resolvePageTargets(
    canvasName: string,
    doc: CanvasDoc,
  ): Promise<ReadonlyArray<ResolvedPageTarget>> {
    const nodes = doc.nodes.filter((node) => node.ether?.entity?.kind === "page");
    if (nodes.length === 0 || nodes.length > MAX_PAGE_TARGETS) {
      throw new RuntimeDenied("invalid");
    }

    const expected = nodes.map((node) => {
      let ref: NodeRefKey;
      try {
        ref = formatNodeRef({ canvasName, nodeId: node.id });
      } catch {
        throw new RuntimeDenied("invalid");
      }
      const profile = node.ether?.browser?.profile;
      if (
        node.type !== "link" ||
        typeof profile !== "string" ||
        !isValidProfileId(profile)
      ) {
        throw new RuntimeDenied("invalid");
      }
      return Object.freeze({
        ref,
        nodeId: node.id,
        url: node.url,
        profile,
      });
    });
    if (new Set(expected.map((target) => target.ref)).size !== expected.length) {
      throw new RuntimeDenied("invalid");
    }

    let results: Awaited<ReturnType<PageTargetResolver>>[];
    try {
      results = await Promise.all(expected.map((target) => this.dependencies.resolvePageTarget(target.ref)));
    } catch {
      throw new RuntimeDenied("delivery_failed");
    }
    const resolved = results.map((result, index) => {
      const target = expected[index];
      if (target === undefined || !result.ok) {
        throw new RuntimeDenied(result.ok ? "invalid" : result.code === "not_found" ? "not_found" : "invalid");
      }
      if (
        result.data.ref !== target.ref ||
        result.data.nodeId !== target.nodeId ||
        result.data.url !== target.url ||
        result.data.profile !== target.profile
      ) {
        throw new RuntimeDenied("invalid");
      }
      return immutableTarget(result.data);
    });
    return Object.freeze([...resolved].sort((left, right) => left.ref.localeCompare(right.ref)));
  }

  async #deliver(
    delivery: BrowserAutomationDelivery,
  ): Promise<BrowserAutomationDeliveryReceipt | void> {
    const key = subjectKey(delivery.subject);
    const pending = this.#pendingBySubject.get(key);
    if (pending === undefined || pending.deliveryStarted || this.#closed) {
      throw new RuntimeDenied("delivery_failed");
    }
    const currentPlan = await this.#prepare(pending.input);
    if (
      this.#closed ||
      this.#pendingBySubject.get(key) !== pending ||
      pending.deliveryStarted ||
      subjectKey(currentPlan.subject) !== subjectKey(delivery.subject) ||
      fingerprintPlan(currentPlan) !== pending.fingerprint
    ) {
      throw new RuntimeDenied("delivery_failed");
    }

    pending.deliveryStarted = true;
    return this.dependencies.deliver(Object.freeze({
      plan: currentPlan,
      capability: delivery.secret,
      controlHome: delivery.controlHome,
      expiresAt: delivery.expiresAt,
    }));
  }

  #pruneActiveLocators(): ReadonlyArray<BrowserAutomationGrantSummary> {
    const grants = this.#authority.list();
    const live = new Set(grants.map((grant) => grant.id));
    for (const automationId of this.#activeLocators.keys()) {
      if (!live.has(automationId)) this.#activeLocators.delete(automationId);
    }
    return grants;
  }
}
