import { useEffect, useRef, useState } from "react";
import { KILL_ARM_MS } from "./terminal-kill-ux";

/**
 * Two-click destructive arm shared by page stop chrome: the first press arms
 * (crimson confirm), the second fires. The arm window expires after
 * KILL_ARM_MS; every re-arm restarts it.
 */
export const useTwoClickArm = (fire: () => void) => {
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);

  const disarm = (): void => {
    if (armTimer.current !== null) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    setArmed(false);
  };

  const arm = (): void => {
    if (armed) {
      disarm();
      fire();
      return;
    }
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    setArmed(true);
    armTimer.current = window.setTimeout(() => {
      armTimer.current = null;
      setArmed(false);
    }, KILL_ARM_MS);
  };

  useEffect(
    () => () => {
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    },
    [],
  );

  return { armed, arm, disarm };
};
