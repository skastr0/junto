import { Effect } from "effect"
import {
  classifyArchitectureRole,
  defineProcessor,
  defineProjectModule,
  readArchitectureRole,
  tuneTypeScriptNesting,
  tuneTypeScriptSize,
  type ResolvedCalibrationContext,
} from "@skastr0/pulsar-project-module-sdk"

/**
 * Vellum Command repository calibration.
 *
 * Not Pulsar product default behavior. Encodes this repo's process-boundary
 * and factory-physics layout so size/nesting pressure does not punish
 * Electron main/station orchestration that must stay locally coherent.
 */
type VellumArchitectureRole = "pure_utility" | "shared_contextual" | "integration"

const REPOSITORY_NAME = "vellum-command"
const CALIBRATION_SCOPE = "repo-local-vellum-command"
const ARCHITECTURE_ROLE_RULE_ID = "vellum-command.repository.architecture-role.v1"
const INTEGRATION_SIZE_RULE_ID = "vellum-command.repository.integration-size-policy.v1"
const INTEGRATION_NESTING_RULE_ID = "vellum-command.repository.integration-nesting-policy.v1"
const SHARED_CONTRACT_SIZE_RULE_ID = "vellum-command.repository.shared-contract-size-policy.v1"

const repoMetadata = (
  policy: string,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  repository: REPOSITORY_NAME,
  calibrationScope: CALIBRATION_SCOPE,
  productDefault: false,
  policy,
  ...extra,
})

const normalizePath = (file: string): string => file.replaceAll("\\", "/")

const pathHasPrefix = (file: string, prefix: string): boolean => {
  const path = normalizePath(file)
  return path === prefix || path.includes(`/${prefix}`) || path.startsWith(`${prefix}/`)
}

const architectureRoleRule = (
  file: string,
): { readonly id: string; readonly role: VellumArchitectureRole } | undefined => {
  const path = normalizePath(file)

  if (
    pathHasPrefix(path, "src/main/vellum-command/state") ||
    pathHasPrefix(path, "src/main/vellum-command/station") ||
    pathHasPrefix(path, "src/main/vellum-command/work") ||
    pathHasPrefix(path, "src/main/vellum-command/kernel") ||
    pathHasPrefix(path, "src/main/vellum-command/browser") ||
    pathHasPrefix(path, "src/main/vellum-command/term") ||
    pathHasPrefix(path, "src/cli")
  ) {
    return { id: "integration.process-boundary", role: "integration" }
  }

  if (pathHasPrefix(path, "src/shared")) {
    return { id: "shared.frozen-contracts", role: "shared_contextual" }
  }

  if (pathHasPrefix(path, "src/preload")) {
    return { id: "preload.ipc-bridge", role: "shared_contextual" }
  }

  if (
    pathHasPrefix(path, "src/renderer/lib") ||
    pathHasPrefix(path, "src/shared/theme") ||
    pathHasPrefix(path, "src/shared/physics")
  ) {
    return { id: "pure.projection-helpers", role: "pure_utility" }
  }

  if (pathHasPrefix(path, "src/main") || pathHasPrefix(path, "src/renderer")) {
    return { id: "integration.surface", role: "integration" }
  }

  return undefined
}

const architectureRoleClassificationForFile = (
  context: ResolvedCalibrationContext,
  file: string,
) =>
  context.runSlot("taxonomy.file-classifier", {
    path: file,
    categories: [],
  }).pipe(
    Effect.map((result) => {
      const role = readArchitectureRole(result.value.metadata)
      return role === "pure_utility" || role === "shared_contextual" || role === "integration"
        ? role
        : undefined
    }),
  )

export default defineProjectModule({
  id: "vellum-command",
  version: "1.0.0",
  scope: "repository",
  processors: [
    defineProcessor({
      id: "vellum-command-architecture-role-classifier",
      slot: "taxonomy.file-classifier",
      role: "enricher",
      priority: 20,
      fingerprint: "vellum-command-architecture-role-classifier-v1",
      process: (current, _context, runtime) =>
        Effect.sync(() => {
          const rule = architectureRoleRule(current.value.path)
          if (rule === undefined) return current

          return classifyArchitectureRole(current, runtime, rule.role, {
            ruleId: ARCHITECTURE_ROLE_RULE_ID,
            reason:
              "Vellum Command classifies Electron main, renderer, preload, CLI, and frozen shared contracts so size and nesting detectors interpret process-boundary code as integration rather than generic taste.",
            evidence: [
              { kind: "path", value: current.value.path },
              { kind: "architecture-role", value: rule.role },
              { kind: "role-rule", value: rule.id },
            ],
            metadata: repoMetadata("architecture-role", { ruleId: rule.id }),
          })
        }),
    }),
    defineProcessor({
      id: "vellum-command-integration-size-policy",
      slot: "typescript.size-policy",
      role: "factor-policy",
      priority: 20,
      fingerprint: "vellum-command-integration-size-policy-v1",
      process: (current, context, runtime) =>
        Effect.gen(function* () {
          const role = yield* architectureRoleClassificationForFile(context, current.value.file)
          if (role !== "integration") return current

          return tuneTypeScriptSize(current, runtime, {
            severity: "info",
            penaltyWeight: 0.35,
            maxLoc: current.value.kind === "file" ? 900 : 140,
            ruleId: INTEGRATION_SIZE_RULE_ID,
            reason:
              "Station, state, work, kernel, browser, and CLI files are process-boundary orchestration; splitting them to satisfy generic LOC budgets would scatter one authority decision.",
            evidence: [
              { kind: "path", value: current.value.file },
              { kind: "architecture-role", value: role },
              { kind: "size-kind", value: current.value.kind },
              { kind: "loc", value: String(current.value.loc) },
            ],
            metadata: repoMetadata("integration-size", { architectureRole: role }),
          })
        }),
    }),
    defineProcessor({
      id: "vellum-command-shared-contract-size-policy",
      slot: "typescript.size-policy",
      role: "factor-policy",
      priority: 20,
      fingerprint: "vellum-command-shared-contract-size-policy-v1",
      process: (current, context, runtime) =>
        Effect.gen(function* () {
          const role = yield* architectureRoleClassificationForFile(context, current.value.file)
          if (role !== "shared_contextual") return current

          return tuneTypeScriptSize(current, runtime, {
            severity: "warn",
            penaltyWeight: 0.6,
            maxLoc: current.value.kind === "file" ? 700 : 100,
            ruleId: SHARED_CONTRACT_SIZE_RULE_ID,
            reason:
              "src/shared is the frozen document and physics contract. Slightly larger files are expected; unbounded growth is still a review concern.",
            evidence: [
              { kind: "path", value: current.value.file },
              { kind: "architecture-role", value: role },
              { kind: "loc", value: String(current.value.loc) },
            ],
            metadata: repoMetadata("shared-contract-size", { architectureRole: role }),
          })
        }),
    }),
    defineProcessor({
      id: "vellum-command-integration-nesting-policy",
      slot: "typescript.nesting-policy",
      role: "factor-policy",
      priority: 20,
      fingerprint: "vellum-command-integration-nesting-policy-v1",
      process: (current, context, runtime) =>
        Effect.gen(function* () {
          const role = yield* architectureRoleClassificationForFile(context, current.value.file)
          if (role !== "integration") return current

          return tuneTypeScriptNesting(current, runtime, {
            severity: "info",
            penaltyWeight: 0.35,
            threshold: 8,
            ruleId: INTEGRATION_NESTING_RULE_ID,
            reason:
              "Effect.gen, IPC, and Station protocol routing produce irreducible nesting at process boundaries; track it without forcing helper extraction that hides authority.",
            evidence: [
              { kind: "path", value: current.value.file },
              { kind: "architecture-role", value: role },
              { kind: "observed-nesting", value: String(current.value.observedNesting) },
            ],
            metadata: repoMetadata("integration-nesting", { architectureRole: role }),
          })
        }),
    }),
  ],
})
