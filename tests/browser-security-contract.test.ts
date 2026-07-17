import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const contract = readFileSync(join(root, "docs/browser-security.md"), "utf8");
const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const mainProcess = readFileSync(join(root, "src/main/index.ts"), "utf8");
const headlessProbe = readFileSync(join(root, "scripts/kernel-headless-probe.ts"), "utf8");

const marker = "<!-- vellum-browser-credential-gate:v1 -->";
const requiredEvidence = [
  "uds_only_transport",
  "scoped_revocable_authority",
  "webcontents_containment",
  "bounded_execution",
  "profile_storage",
  "packaged_runtime",
  "adversarial_suite",
  "independent_reviews",
  "isolated_canary",
] as const;

type EvidenceKey = (typeof requiredEvidence)[number];
type EvidenceState = "unverified" | "verified";
type AccountClass = "synthetic" | "canary" | "primary";

interface EvidenceEntry {
  readonly state: EvidenceState;
  readonly refs: ReadonlyArray<string>;
}

interface Approval {
  readonly operator: string;
  readonly security_review: string;
  readonly verification_review: string;
  readonly approved_at: string;
}

interface CredentialGate {
  readonly schema: "vellum/browser-credential-gate/v1";
  readonly decision: "blocked" | "approved";
  readonly allowed_account_classes: ReadonlyArray<AccountClass>;
  readonly primary_account_providers: ReadonlyArray<string>;
  readonly evidence: Readonly<Record<EvidenceKey, EvidenceEntry>>;
  readonly approval: Approval | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (value: Record<string, unknown>, expected: ReadonlyArray<string>): void => {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error("unexpected object keys");
  }
};

const isAccountClass = (value: unknown): value is AccountClass =>
  value === "synthetic" || value === "canary" || value === "primary";

const parseEvidenceEntry = (input: unknown, key: EvidenceKey): EvidenceEntry => {
  if (!isRecord(input)) throw new Error(`invalid evidence entry: ${key}`);
  assertExactKeys(input, ["state", "refs"]);
  if (input.state !== "unverified" && input.state !== "verified") {
    throw new Error(`invalid evidence state: ${key}`);
  }
  if (!Array.isArray(input.refs) || !input.refs.every((ref) => typeof ref === "string" && ref.length > 0)) {
    throw new Error(`invalid evidence refs: ${key}`);
  }
  return { state: input.state, refs: input.refs };
};

const parseApproval = (input: unknown): Approval | null => {
  if (input === null) return null;
  if (!isRecord(input)) throw new Error("invalid approval");
  assertExactKeys(input, ["operator", "security_review", "verification_review", "approved_at"]);
  const { operator, security_review, verification_review, approved_at } = input;
  if (
    typeof operator !== "string" ||
    operator.length === 0 ||
    typeof security_review !== "string" ||
    security_review.length === 0 ||
    typeof verification_review !== "string" ||
    verification_review.length === 0 ||
    typeof approved_at !== "string" ||
    approved_at.length === 0
  ) {
    throw new Error("invalid approval value");
  }
  return { operator, security_review, verification_review, approved_at };
};

const parseGate = (input: unknown): CredentialGate => {
  expect(isRecord(input)).toBe(true);
  if (!isRecord(input)) throw new Error("credential gate must be an object");

  assertExactKeys(input, [
    "schema",
    "decision",
    "allowed_account_classes",
    "primary_account_providers",
    "evidence",
    "approval",
  ]);
  if (input.schema !== "vellum/browser-credential-gate/v1") throw new Error("invalid schema");
  if (input.decision !== "blocked" && input.decision !== "approved") {
    throw new Error("invalid decision");
  }
  if (!Array.isArray(input.allowed_account_classes)) throw new Error("invalid account classes");
  if (!Array.isArray(input.primary_account_providers)) throw new Error("invalid providers");
  if (!isRecord(input.evidence)) throw new Error("invalid evidence");

  const allowedAccountClasses = input.allowed_account_classes.filter(isAccountClass);
  if (allowedAccountClasses.length !== input.allowed_account_classes.length) {
    throw new Error("invalid account class");
  }
  const primaryAccountProviders = input.primary_account_providers.filter(
    (provider): provider is string => typeof provider === "string" && provider.length > 0,
  );
  if (primaryAccountProviders.length !== input.primary_account_providers.length) {
    throw new Error("invalid primary account provider");
  }

  assertExactKeys(input.evidence, requiredEvidence);
  const evidence: Record<EvidenceKey, EvidenceEntry> = {
    uds_only_transport: parseEvidenceEntry(input.evidence.uds_only_transport, "uds_only_transport"),
    scoped_revocable_authority: parseEvidenceEntry(
      input.evidence.scoped_revocable_authority,
      "scoped_revocable_authority",
    ),
    webcontents_containment: parseEvidenceEntry(
      input.evidence.webcontents_containment,
      "webcontents_containment",
    ),
    bounded_execution: parseEvidenceEntry(input.evidence.bounded_execution, "bounded_execution"),
    profile_storage: parseEvidenceEntry(input.evidence.profile_storage, "profile_storage"),
    packaged_runtime: parseEvidenceEntry(input.evidence.packaged_runtime, "packaged_runtime"),
    adversarial_suite: parseEvidenceEntry(input.evidence.adversarial_suite, "adversarial_suite"),
    independent_reviews: parseEvidenceEntry(
      input.evidence.independent_reviews,
      "independent_reviews",
    ),
    isolated_canary: parseEvidenceEntry(input.evidence.isolated_canary, "isolated_canary"),
  };

  return {
    schema: input.schema,
    decision: input.decision,
    allowed_account_classes: allowedAccountClasses,
    primary_account_providers: primaryAccountProviders,
    evidence,
    approval: parseApproval(input.approval),
  };
};

const extractGate = (source: string): CredentialGate => {
  expect(source.split(marker)).toHaveLength(2);
  const match = source.match(
    /<!-- vellum-browser-credential-gate:v1 -->\s*```json\s*([\s\S]*?)\s*```/,
  );
  expect(match).not.toBeNull();
  if (!match) throw new Error("credential gate block missing");
  return parseGate(JSON.parse(match[1]));
};

const canUsePrimaryAccounts = (gate: CredentialGate): boolean => {
  if (gate.decision !== "approved") return false;
  if (!gate.allowed_account_classes.includes("primary")) return false;
  if (gate.approval === null) return false;
  return requiredEvidence.every((key) => {
    const entry = gate.evidence[key];
    return entry.state === "verified" && entry.refs.length > 0;
  });
};

const approvedFixture = (): CredentialGate => ({
  schema: "vellum/browser-credential-gate/v1",
  decision: "approved",
  allowed_account_classes: ["synthetic", "canary", "primary"],
  primary_account_providers: ["gmail", "github"],
  evidence: {
    uds_only_transport: { state: "verified", refs: ["receipt:uds-only-transport"] },
    scoped_revocable_authority: { state: "verified", refs: ["receipt:scoped-authority"] },
    webcontents_containment: { state: "verified", refs: ["receipt:webcontents"] },
    bounded_execution: { state: "verified", refs: ["receipt:bounded-execution"] },
    profile_storage: { state: "verified", refs: ["receipt:profile-storage"] },
    packaged_runtime: { state: "verified", refs: ["receipt:packaged-runtime"] },
    adversarial_suite: { state: "verified", refs: ["receipt:adversarial-suite"] },
    independent_reviews: { state: "verified", refs: ["receipt:independent-reviews"] },
    isolated_canary: { state: "verified", refs: ["receipt:isolated-canary"] },
  },
  approval: {
    operator: "operator-receipt",
    security_review: "security-review-receipt",
    verification_review: "verification-review-receipt",
    approved_at: "2026-07-17T00:00:00.000Z",
  },
});

describe("browser credential security contract", () => {
  it("commits exactly one canonical fail-closed gate", () => {
    const gate = extractGate(contract);
    expect(gate.decision).toBe("blocked");
    expect(gate.allowed_account_classes).toEqual(["synthetic"]);
    expect(gate.primary_account_providers).toEqual(["gmail", "github"]);
    expect(gate.approval).toBeNull();
    expect(canUsePrimaryAccounts(gate)).toBe(false);
    for (const key of requiredEvidence) {
      expect(gate.evidence[key]).toEqual({ state: "unverified", refs: [] });
    }
  });

  it("fails closed until every evidence and approval condition is present", () => {
    const complete = approvedFixture();
    expect(canUsePrimaryAccounts(complete)).toBe(true);

    expect(canUsePrimaryAccounts({ ...complete, decision: "blocked" })).toBe(false);
    expect(
      canUsePrimaryAccounts({
        ...complete,
        allowed_account_classes: ["synthetic", "canary"],
      }),
    ).toBe(false);
    expect(canUsePrimaryAccounts({ ...complete, approval: null })).toBe(false);

    const missingRefBase = approvedFixture();
    const missingRef: CredentialGate = {
      ...missingRefBase,
      evidence: {
        ...missingRefBase.evidence,
        uds_only_transport: { state: "verified", refs: [] },
      },
    };
    expect(canUsePrimaryAccounts(missingRef)).toBe(false);

    const partialBase = approvedFixture();
    const partial: CredentialGate = {
      ...partialBase,
      evidence: {
        ...partialBase.evidence,
        webcontents_containment: {
          ...partialBase.evidence.webcontents_containment,
          state: "unverified",
        },
      },
    };
    expect(canUsePrimaryAccounts(partial)).toBe(false);
  });

  it("rejects malformed and widened gate shapes", () => {
    const complete = approvedFixture();
    expect(() => parseGate({ ...complete, surprise: true })).toThrow();
    expect(() => parseGate({ ...complete, decision: "maybe" })).toThrow();
    expect(() =>
      parseGate({
        ...complete,
        evidence: { ...complete.evidence, unknown_gate: { state: "verified", refs: [] } },
      }),
    ).toThrow();
    expect(() => extractGate(`${contract}\n${contract}`)).toThrow();
  });

  it("places the same visible prohibition on agent and operator surfaces", () => {
    for (const surface of [agents, readme]) {
      expect(surface).toMatch(/primary Gmail and GitHub credentials/i);
      expect(surface).toContain("docs/browser-security.md");
      expect(surface).toMatch(/not (?:a )?runtime interception/i);
    }
  });

  it("keeps headless qualification off TCP and Chrome DevTools Protocol", () => {
    expect(mainProcess).not.toContain("remote-debugging-port");
    expect(mainProcess).not.toContain("openDevTools");
    expect(headlessProbe).not.toMatch(/connectOverCDP|\/json\/close|\/json\/list/);
    expect(mainProcess).toContain('--vellum-headless');
    expect(headlessProbe).toContain('"--vellum-headless"');
  });
});
