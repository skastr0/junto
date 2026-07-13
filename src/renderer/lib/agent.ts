import type { AgentIdentity } from "@shared/ipc";
import { getVellumApi } from "./vellum-api";

// Module-level so every agent card and inspector section sharing a hermes key
// share one in-flight (then settled) fetch instead of hammering the fleet.
// Cached forever for the session: avatars and identity are effectively
// static, unlike the tower/quasar browse data in lib/browse.ts.
const avatarCache = new Map<string, Promise<string | null>>();
const identityCache = new Map<string, Promise<AgentIdentity | null>>();

export const getAgentAvatar = (key: string): Promise<string | null> => {
  const cached = avatarCache.get(key);
  if (cached) return cached;
  const api = getVellumApi();
  const promise = api && typeof api.agentAvatar === "function"
    ? api.agentAvatar(key).catch(() => null)
    : Promise.resolve(null);
  avatarCache.set(key, promise);
  return promise;
};

export const getAgentIdentity = (key: string): Promise<AgentIdentity | null> => {
  const cached = identityCache.get(key);
  if (cached) return cached;
  const api = getVellumApi();
  const promise = api && typeof api.agentIdentity === "function"
    ? api.agentIdentity(key).catch(() => null)
    : Promise.resolve(null);
  identityCache.set(key, promise);
  return promise;
};
