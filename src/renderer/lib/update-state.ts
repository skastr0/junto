import { observable } from "@legendapp/state";
import { idleUpdateStatus, type UpdateStatus } from "@shared/update";

export const updateState$ = observable({
  status: idleUpdateStatus("0.0.0") as UpdateStatus,
  busy: false,
});

let bridgeStarted = false;

export const startUpdateBridge = (): (() => void) | undefined => {
  if (bridgeStarted || !window.vellum?.updateGetState) return undefined;
  bridgeStarted = true;

  const unsub = window.vellum.onUpdateStateChanged((status) => {
    updateState$.status.set(status);
    updateState$.busy.set(
      status.phase === "checking" ||
        status.phase === "downloading" ||
        status.phase === "installing",
    );
  });

  void (async () => {
    try {
      const status = await window.vellum!.updateGetState();
      updateState$.status.set(status);
    } catch {
      // Fail soft — update UI is optional chrome.
    }
  })();

  return () => {
    unsub();
    bridgeStarted = false;
  };
};

export const checkForUpdates = async (): Promise<UpdateStatus | undefined> => {
  if (!window.vellum?.updateCheck) return undefined;
  updateState$.busy.set(true);
  try {
    const status = await window.vellum.updateCheck();
    updateState$.status.set(status);
    return status;
  } finally {
    updateState$.busy.set(false);
  }
};

export const restartAndInstallUpdate = async (): Promise<
  UpdateStatus | undefined
> => {
  if (!window.vellum?.updateRestartAndInstall) return undefined;
  updateState$.busy.set(true);
  try {
    const status = await window.vellum.updateRestartAndInstall();
    updateState$.status.set(status);
    return status;
  } finally {
    // installing may keep busy true if process is about to exit
    const phase = updateState$.status.phase.peek();
    if (phase !== "installing") {
      updateState$.busy.set(false);
    }
  }
};
