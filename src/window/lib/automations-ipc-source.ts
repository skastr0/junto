/**
 * The Automations source over main's IPC (plan 0.10/07): main reads the store
 * and rules the operator's writes, and tells every window after each change.
 */
import type { JuntoApi } from "@shared/ipc";
import { setAutomationsSource, type AutomationsSource } from "./automations-source";

type AutomationsApi = Pick<
  JuntoApi,
  "automationList" | "automationFirings" | "automationApply" | "automationCodePut" | "automationCodeRead" | "onAutomationsChanged"
>;

export const makeIpcAutomationsSource = (api: AutomationsApi): AutomationsSource => ({
  list: (canvasName, nodeId) => api.automationList(canvasName, { nodeId }),
  firings: (canvasName, request) => api.automationFirings(canvasName, request),
  apply: (canvasName, nodeId, automationId, op) => api.automationApply(canvasName, { nodeId, automationId, op }),
  codePut: (canvasName, text) => api.automationCodePut(canvasName, { text }),
  codeRead: (canvasName, ref) => api.automationCodeRead(canvasName, { ref }),
  subscribe: (listener) => api.onAutomationsChanged(() => listener()),
});

/** Serve the window from main when it is there; without it the local stand-in stays. */
export const installIpcAutomationsSource = (api: Partial<AutomationsApi> | undefined): void => {
  if (
    api?.automationList &&
    api.automationFirings &&
    api.automationApply &&
    api.automationCodePut &&
    api.automationCodeRead &&
    api.onAutomationsChanged
  ) {
    setAutomationsSource(makeIpcAutomationsSource(api as AutomationsApi));
  }
};
