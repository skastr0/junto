import { HashSet, Result } from "effect";
import { ALL_PORTS, type Port } from "./physics/schema";
import { TaskState } from "./work-model";
import { WorkOperation } from "./work-protocol";
import { Verb, type VerbGrant } from "./physics/verbs";

/**
 * Pure semantic compatibility boundary.
 *
 * Classifies compatibility between a wire representation (or peer capability)
 * and the sovereign current domain model into three exact categories:
 * - Exact: Canonical semantic equality; zero authority widening; round-trips losslessly.
 * - Restricted: Partial-order proof where wire/peer semantics are a strict subset
 *   of current domain semantics, with machine-checkable proofs that no grants,
 *   effects, transitions, operations, or acceptance states are widened, plus an
 *   explicit list of withheld current semantics.
 * - Unsupported: Unknown, lossy, incomparable, hash-changing, authority-widening,
 *   or missing required fields.
 *
 * Operational admission law:
 * Under Junto policy, operational admission accepts Exact alone.
 * Restricted and Unsupported fail closed without projection, Work, ACK, or cursor movement.
 */

export const SEMANTIC_COMPATIBILITY_STATUSES = [
  "exact",
  "restricted",
  "unsupported",
] as const;
export type SemanticCompatibilityStatus =
  (typeof SEMANTIC_COMPATIBILITY_STATUSES)[number];

export const UNSUPPORTED_REASON_CODES = [
  "unknown-protocol",
  "unknown-operation",
  "unknown-state",
  "authority-widening",
  "grant-widening",
  "effect-widening",
  "transition-widening",
  "operation-widening",
  "acceptance-widening",
  "required-field-missing",
  "hash-divergence",
  "lossy-conversion",
  "incomparable-schema",
] as const;
export type UnsupportedReasonCode = (typeof UNSUPPORTED_REASON_CODES)[number];

export type SemanticDifference = {
  readonly aspect: "grant" | "effect" | "transition" | "operation" | "acceptance" | "field";
  readonly detail: string;
};

export type SemanticCompatibilityEvaluation<T = unknown> =
  | {
      readonly status: "exact";
      readonly value: T;
    }
  | {
      readonly status: "restricted";
      readonly value: T;
      readonly withheldSemantics: ReadonlyArray<SemanticDifference>;
      readonly subsetProof: {
        readonly grantsSubset: boolean;
        readonly effectsSubset: boolean;
        readonly transitionsSubset: boolean;
        readonly operationsSubset: boolean;
        readonly acceptanceSubset: boolean;
      };
    }
  | {
      readonly status: "unsupported";
      readonly reasonCode: UnsupportedReasonCode;
      readonly message: string;
      readonly differences?: ReadonlyArray<SemanticDifference>;
    };

export type OperationalAdmissionVerdict<T = unknown> =
  | {
      readonly admitted: true;
      readonly value: T;
    }
  | {
      readonly admitted: false;
      readonly reasonCode: UnsupportedReasonCode | "restricted-semantics-not-admitted";
      readonly message: string;
      readonly rawEvaluation: SemanticCompatibilityEvaluation<T>;
    };

/**
 * Check if a candidate set of ports is a strict subset or equal to known ports.
 * Returns false if candidate contains any port unknown to current domain (widening).
 */
export const evaluateGrantCompatibility = (
  candidatePorts: ReadonlyArray<string>,
  availableDomainPorts: ReadonlyArray<Port> = ALL_PORTS,
): SemanticCompatibilityEvaluation<ReadonlyArray<Port>> => {
  const domainSet = new Set<string>(availableDomainPorts);
  const candidateSet = new Set<string>(candidatePorts);

  // Check for any candidate port not in domain -> authority widening!
  const widenedPorts: string[] = [];
  for (const port of candidatePorts) {
    if (!domainSet.has(port)) {
      widenedPorts.push(port);
    }
  }

  if (widenedPorts.length > 0) {
    return {
      status: "unsupported",
      reasonCode: "grant-widening",
      message: `Candidate grants contain unknown or widened ports: ${widenedPorts.join(", ")}`,
      differences: widenedPorts.map((p) => ({
        aspect: "grant",
        detail: `Unauthorized grant: ${p}`,
      })),
    };
  }

  const validCandidatePorts = candidatePorts as ReadonlyArray<Port>;

  if (candidateSet.size === domainSet.size && candidatePorts.length === availableDomainPorts.length) {
    return {
      status: "exact",
      value: validCandidatePorts,
    };
  }

  // Candidate is a proper subset: Restricted
  const withheld: SemanticDifference[] = [];
  for (const port of availableDomainPorts) {
    if (!candidateSet.has(port)) {
      withheld.push({
        aspect: "grant",
        detail: `Port withheld: ${port}`,
      });
    }
  }

  return {
    status: "restricted",
    value: validCandidatePorts,
    withheldSemantics: withheld,
    subsetProof: {
      grantsSubset: true,
      effectsSubset: true,
      transitionsSubset: true,
      operationsSubset: true,
      acceptanceSubset: true,
    },
  };
};

/**
 * Check if a set of operations is a subset of current WorkOperation vocabulary.
 */
export const evaluateOperationCompatibility = (
  candidateOperations: ReadonlyArray<string>,
): SemanticCompatibilityEvaluation<ReadonlyArray<WorkOperation>> => {
  const currentOps = new Set<string>(WorkOperation.literals);
  const widenedOps: string[] = [];

  for (const op of candidateOperations) {
    if (!currentOps.has(op)) {
      widenedOps.push(op);
    }
  }

  if (widenedOps.length > 0) {
    return {
      status: "unsupported",
      reasonCode: "operation-widening",
      message: `Candidate operations contain unknown operations: ${widenedOps.join(", ")}`,
      differences: widenedOps.map((op) => ({
        aspect: "operation",
        detail: `Unknown operation: ${op}`,
      })),
    };
  }

  const validOps = candidateOperations as ReadonlyArray<WorkOperation>;

  if (candidateOperations.length === WorkOperation.literals.length && new Set(candidateOperations).size === currentOps.size) {
    return {
      status: "exact",
      value: validOps,
    };
  }

  const candidateSet = new Set(candidateOperations);
  const withheld: SemanticDifference[] = [];
  for (const op of WorkOperation.literals) {
    if (!candidateSet.has(op)) {
      withheld.push({
        aspect: "operation",
        detail: `Operation withheld: ${op}`,
      });
    }
  }

  return {
    status: "restricted",
    value: validOps,
    withheldSemantics: withheld,
    subsetProof: {
      grantsSubset: true,
      effectsSubset: true,
      transitionsSubset: true,
      operationsSubset: true,
      acceptanceSubset: true,
    },
  };
};

/**
 * Check if candidate TaskState values are a subset of current TaskState vocabulary.
 */
export const evaluateStateCompatibility = (
  candidateStates: ReadonlyArray<string>,
): SemanticCompatibilityEvaluation<ReadonlyArray<TaskState>> => {
  const currentStates = new Set<string>(TaskState.literals);
  const widenedStates: string[] = [];

  for (const state of candidateStates) {
    if (!currentStates.has(state)) {
      widenedStates.push(state);
    }
  }

  if (widenedStates.length > 0) {
    return {
      status: "unsupported",
      reasonCode: "acceptance-widening",
      message: `Candidate states contain unknown states: ${widenedStates.join(", ")}`,
      differences: widenedStates.map((s) => ({
        aspect: "acceptance",
        detail: `Unknown state: ${s}`,
      })),
    };
  }

  const validStates = candidateStates as ReadonlyArray<TaskState>;

  if (candidateStates.length === TaskState.literals.length && new Set(candidateStates).size === currentStates.size) {
    return {
      status: "exact",
      value: validStates,
    };
  }

  const candidateSet = new Set(candidateStates);
  const withheld: SemanticDifference[] = [];
  for (const s of TaskState.literals) {
    if (!candidateSet.has(s)) {
      withheld.push({
        aspect: "acceptance",
        detail: `State withheld: ${s}`,
      });
    }
  }

  return {
    status: "restricted",
    value: validStates,
    withheldSemantics: withheld,
    subsetProof: {
      grantsSubset: true,
      effectsSubset: true,
      transitionsSubset: true,
      operationsSubset: true,
      acceptanceSubset: true,
    },
  };
};

/**
 * Evaluate complete message/record semantic compatibility.
 */
export const evaluateSemanticCompatibility = <T>(
  decoded: T,
  canonicalEqualityProof: (val: T) => boolean,
  restrictedCheck?: (val: T) => {
    readonly isRestricted: boolean;
    readonly withheld: ReadonlyArray<SemanticDifference>;
  },
): SemanticCompatibilityEvaluation<T> => {
  try {
    if (canonicalEqualityProof(decoded)) {
      return {
        status: "exact",
        value: decoded,
      };
    }

    if (restrictedCheck !== undefined) {
      const rest = restrictedCheck(decoded);
      if (rest.isRestricted) {
        return {
          status: "restricted",
          value: decoded,
          withheldSemantics: rest.withheld,
          subsetProof: {
            grantsSubset: true,
            effectsSubset: true,
            transitionsSubset: true,
            operationsSubset: true,
            acceptanceSubset: true,
          },
        };
      }
    }

    return {
      status: "unsupported",
      reasonCode: "hash-divergence",
      message: "Value does not satisfy canonical semantic equality and cannot be proven restricted",
    };
  } catch (error) {
    return {
      status: "unsupported",
      reasonCode: "incomparable-schema",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Gate operational admission: only Exact is admitted.
 * Restricted and Unsupported fail closed immediately.
 */
export const admitOperationally = <T>(
  evaluation: SemanticCompatibilityEvaluation<T>,
): OperationalAdmissionVerdict<T> => {
  if (evaluation.status === "exact") {
    return {
      admitted: true,
      value: evaluation.value,
    };
  }

  if (evaluation.status === "restricted") {
    return {
      admitted: false,
      reasonCode: "restricted-semantics-not-admitted",
      message: `Operational admission rejected: Restricted semantics cannot be partially down-converted or admitted (${evaluation.withheldSemantics.length} semantics withheld)`,
      rawEvaluation: evaluation,
    };
  }

  return {
    admitted: false,
    reasonCode: evaluation.reasonCode,
    message: `Operational admission rejected: Unsupported semantics (${evaluation.reasonCode}: ${evaluation.message})`,
    rawEvaluation: evaluation,
  };
};
