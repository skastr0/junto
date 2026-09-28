import { describe, expect, it } from "vitest";
import {
  admitOperationally,
  evaluateGrantCompatibility,
  evaluateSemanticCompatibility,
} from "../src/shared/semantic-compatibility-adapter";
import { ALL_PORTS, type Port } from "../src/shared/physics/schema";
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
      const subset: Port[] = ["msg.list", "msg.send"];
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
      if (!admission.admitted) {
        expect(admission.reasonCode).toBe("restricted-semantics-not-admitted");
      }
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
      if (!admission.admitted) {
        expect(admission.reasonCode).toBe("grant-widening");
      }
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
