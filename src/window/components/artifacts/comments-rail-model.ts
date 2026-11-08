import type { NodeId } from "@shared/physics/schema";
import type { SubjectThread } from "../../lib/subject-threads-source";

/** Every post on the artifact, replies included: the number the rail shows. */
export const commentCount = (threads: ReadonlyArray<SubjectThread>): number =>
  threads.reduce((count, thread) => count + thread.posts.length, 0);

/**
 * The seats that took part, latest post first, each once. The operator and
 * automations are not seats, so they wear no portrait here.
 */
export const commentSeats = (threads: ReadonlyArray<SubjectThread>): ReadonlyArray<NodeId> => {
  const latest = new Map<NodeId, number>();
  for (const thread of threads) {
    for (const post of thread.posts) {
      if (post.author.kind !== "seat") continue;
      const at = latest.get(post.author.nodeId);
      if (at === undefined || post.at > at) latest.set(post.author.nodeId, post.at);
    }
  }
  return [...latest].sort((a, b) => b[1] - a[1]).map(([nodeId]) => nodeId);
};
