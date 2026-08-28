import { describe, expect, it } from "vitest";
import {
  admitOperationally,
  evaluateGrantCompatibility,
  evaluateOperationCompatibility,
  evaluateSemanticCompatibility,
  evaluateStateCompatibility,
  evaluateVerbGrantCompatibility,
} from "../src/shared/semantic-compatibility-adapter";
import { ALL_PORTS, type Port } from "../src/shared/physics/schema";
import { TaskState } from "../src/shared/work-model";
import { WorkOperation } from "../src/shared/work-protocol";
import type { VerbGrant } from "../src/shared/physics/verbs";

describe("Semantic compatibility adapter boundary", () => {
  describe("Grant compatibility & anti-widening", () => {
    it("proves Exact for identical grant sets", () => {
      const evalResult = evaluateGrantCompatibility(ALL_PORTS, ALL_PORTS);
      expect(evalResult.status).toBe("exact");
      if (evalResult.status === "exact") {
        expect(evalResult.value).toEqual(ALL_PORTS);
      }

      const admission = admitOperationally(evalResult);
      expect(admission.admitted).toBe(true);
      if (admission.admitted) {
        expect(admission.value).toEqual(ALL_PORTS);
      }
    });

    it("proves Restricted for strict subset of grants with machine-checkable proof", () => {
      const subset: Port[] = ["tasks.list", "tasks.claim"];
      const evalResult = evaluateGrantCompatibility(subset, ALL_PORTS);

      expect(evalResult.status).toBe("restricted");
      if (evalResult.status === "restricted") {
        expect(evalResult.subsetProof.grantsSubset).toBe(true);
        expect(evalResult.withheldSemantics.length).toBe(
          ALL_PORTS.length - subset.length,
        );
        expect(evalResult.withheldSemantics.every((s) => s.aspect === "grant")).toBe(
          true,
        );
      }

      // Operational admission must fail closed
      const admission = admitOperationally(evalResult);
      expect(admission.admitted).toBe(false);
      if (admission.admitted) throw new Error("Restricted semantics were admitted");
      expect(admission.reasonCode).toBe("restricted-semantics-not-admitted");
    });

    it("fails closed with Unsupported on authority-widening grants", () => {
      const widened = [...ALL_PORTS, "system.root_exec", "admin.privilege"];
      const evalResult = evaluateGrantCompatibility(widened, ALL_PORTS);

      expect(evalResult.status).toBe("unsupported");
      if (evalResult.status === "unsupported") {
        expect(evalResult.reasonCode).toBe("grant-widening");
        expect(evalResult.differences?.length).toBe(2);
      }

      const admission = admitOperationally(evalResult);
      expect(admission.admitted).toBe(false);
      if (admission.admitted) throw new Error("Widened grants were admitted");
      expect(admission.reasonCode).toBe("grant-widening");
    });

    it("adversarial property testing: randomly generated port sets never widen authority", () => {
      const knownPorts = [...ALL_PORTS];
      const unknownCandidates = [
        "shell.exec",
        "raw.eval",
        "file.wipe",
        "process.killBare",
        "network.raw_listen",
      ];

      for (let i = 0; i < 100; i++) {
        const pickKnown = knownPorts.filter(() => Math.random() > 0.5);
        const hasWidening = Math.random() > 0.5;
        const candidate = hasWidening
          ? [...pickKnown, unknownCandidates[i % unknownCandidates.length]!]
          : pickKnown;

        const evalResult = evaluateGrantCompatibility(candidate, ALL_PORTS);
        const admission = admitOperationally(evalResult);

        if (hasWidening) {
          expect(evalResult.status).toBe("unsupported");
          expect(admission.admitted).toBe(false);
        } else if (pickKnown.length === knownPorts.length) {
          expect(evalResult.status).toBe("exact");
          expect(admission.admitted).toBe(true);
        } else {
          expect(evalResult.status).toBe("restricted");
          expect(admission.admitted).toBe(false);
        }
      }
    });
  });

  describe("Operation compatibility & anti-widening", () => {
    it("proves Exact for full WorkOperation vocabulary", () => {
      const evalResult = evaluateOperationCompatibility(WorkOperation.literals);
      expect(evalResult.status).toBe("exact");
      expect(admitOperationally(evalResult).admitted).toBe(true);
    });

    it("proves Restricted for subset of WorkOperations", () => {
      const subset = ["task.create", "task.claim", "task.transition"];
      const evalResult = evaluateOperationCompatibility(subset);
      expect(evalResult.status).toBe("restricted");
      if (evalResult.status === "restricted") {
        expect(evalResult.subsetProof.operationsSubset).toBe(true);
        expect(evalResult.withheldSemantics.length).toBe(
          WorkOperation.literals.length - subset.length,
        );
      }
      expect(admitOperationally(evalResult).admitted).toBe(false);
    });

    it("rejects unknown / widened operations with Unsupported", () => {
      const widened = ["task.create", "task.arbitrary_eval"];
      const evalResult = evaluateOperationCompatibility(widened);
      expect(evalResult.status).toBe("unsupported");
      if (evalResult.status === "unsupported") {
        expect(evalResult.reasonCode).toBe("operation-widening");
      }
      expect(admitOperationally(evalResult).admitted).toBe(false);
    });
  });

  describe("State / Acceptance compatibility", () => {
    it("proves Exact for full TaskState vocabulary", () => {
      const evalResult = evaluateStateCompatibility(TaskState.literals);
      expect(evalResult.status).toBe("exact");
      expect(admitOperationally(evalResult).admitted).toBe(true);
    });

    it("proves Restricted for subset of TaskStates", () => {
      const subset = ["submitted", "working", "completed"];
      const evalResult = evaluateStateCompatibility(subset);
      expect(evalResult.status).toBe("restricted");
      expect(admitOperationally(evalResult).admitted).toBe(false);
    });

    it("rejects unknown / widened states", () => {
      const widened = ["submitted", "bypassed_gate"];
      const evalResult = evaluateStateCompatibility(widened);
      expect(evalResult.status).toBe("unsupported");
      if (evalResult.status === "unsupported") {
        expect(evalResult.reasonCode).toBe("acceptance-widening");
      }
      expect(admitOperationally(evalResult).admitted).toBe(false);
    });
  });

  describe("VerbGrant compatibility", () => {
    const fullGrant: VerbGrant = {
      ports: ["tasks.list", "tasks.create", "tasks.claim", "tasks.update"],
      assignable: true,
      wake: true,
      flow: true,
      chain: false,
    };

    it("proves Exact when grants and flags match", () => {
      const res = evaluateVerbGrantCompatibility(fullGrant, fullGrant);
      expect(res.status).toBe("exact");
      expect(admitOperationally(res).admitted).toBe(true);
    });

    it("proves Restricted when candidate has subset of capability", () => {
      const narrower: VerbGrant = {
        ports: ["tasks.list", "tasks.claim"],
        assignable: false,
        wake: false,
        flow: true,
        chain: false,
      };
      const res = evaluateVerbGrantCompatibility(narrower, fullGrant);
      expect(res.status).toBe("restricted");
      if (res.status === "restricted") {
        expect(res.subsetProof.grantsSubset).toBe(true);
        expect(res.withheldSemantics.length).toBeGreaterThan(0);
      }
      expect(admitOperationally(res).admitted).toBe(false);
    });

    it("rejects when candidate attempts to widen flags (e.g. assignable true when current is false)", () => {
      const unprivilegedCurrent: VerbGrant = {
        ports: ["tasks.list"],
        assignable: false,
        wake: false,
        flow: false,
        chain: false,
      };
      const widenedCandidate: VerbGrant = {
        ports: ["tasks.list"],
        assignable: true,
        wake: false,
        flow: false,
        chain: false,
      };
      const res = evaluateVerbGrantCompatibility(widenedCandidate, unprivilegedCurrent);
      expect(res.status).toBe("unsupported");
      if (res.status === "unsupported") {
        expect(res.reasonCode).toBe("authority-widening");
      }
      expect(admitOperationally(res).admitted).toBe(false);
    });
  });

  describe("General semantic compatibility evaluator", () => {
    it("evaluates Exact when canonical equality holds", () => {
      const item = { id: "item-1", hash: "abc" };
      const res = evaluateSemanticCompatibility(item, (v) => v.hash === "abc");
      expect(res.status).toBe("exact");
      expect(admitOperationally(res).admitted).toBe(true);
    });

    it("evaluates Restricted when equality fails but restricted check passes", () => {
      const item = { id: "item-1", hash: "xyz", flags: ["a"] };
      const res = evaluateSemanticCompatibility(
        item,
        (v) => v.hash === "abc",
        (v) => ({
          isRestricted: v.flags.length < 2,
          withheld: [{ aspect: "field", detail: "Missing flag b" }],
        }),
      );
      expect(res.status).toBe("restricted");
      expect(admitOperationally(res).admitted).toBe(false);
    });

    it("evaluates Unsupported when equality fails and no restricted proof exists", () => {
      const item = { id: "item-1", hash: "corrupt" };
      const res = evaluateSemanticCompatibility(item, (v) => v.hash === "abc");
      expect(res.status).toBe("unsupported");
      if (res.status === "unsupported") {
        expect(res.reasonCode).toBe("hash-divergence");
      }
      expect(admitOperationally(res).admitted).toBe(false);
    });
  });
});
