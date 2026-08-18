/** THROWAWAY — decision-gate scale specs. Delete after the gate. */
import type { ScaleSpec } from "../scale-bench/fixture";

/**
 * The operator's stated extreme: 5000 nodes / 500 agents / 2000 non-agent
 * sinks / 250k messages. 2500 nodes of furniture (regions + labels) make up
 * the balance, matching the committed specs' "sinks are not all of the
 * document" shape.
 */
export const SPEC_5000: ScaleSpec = {
  id: "synthetic-5000",
  label: "5000 nodes / 500 agents / 2000 sinks / 250k messages",
  agents: 500,
  taskSinks: 1000,
  requestSinks: 500,
  artifactSinks: 499,
  boardSinks: 1,
  regions: 200,
  labels: 2300,
  messagesPerAgent: 500,
  receiptFraction: 0.6,
  tasksPerTaskSink: 20,
  requestsPerRequestSink: 5,
  artifactsPerArtifactSink: 10,
  topicsPerBoard: 8,
  postsPerTopic: 3,
  messageBytes: 1200,
};

/** Committed shapes, restated so the gate reuses the cached fixtures. */
export const SPEC_1000: ScaleSpec = {
  id: "synthetic-1000",
  label: "1000 nodes",
  agents: 200,
  taskSinks: 400,
  requestSinks: 200,
  artifactSinks: 199,
  boardSinks: 1,
  regions: 0,
  labels: 0,
  messagesPerAgent: 250,
  receiptFraction: 0.6,
  tasksPerTaskSink: 20,
  requestsPerRequestSink: 5,
  artifactsPerArtifactSink: 10,
  topicsPerBoard: 8,
  postsPerTopic: 3,
  messageBytes: 1200,
};

export const SPEC_500: ScaleSpec = {
  ...SPEC_1000,
  id: "synthetic-500",
  label: "500 nodes",
  agents: 100,
  taskSinks: 200,
  requestSinks: 100,
  artifactSinks: 99,
};
