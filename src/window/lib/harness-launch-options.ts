import { useEffect, useState } from "react";
import type { ManagedTerminalFlagsResult } from "@shared/ipc";
import type { HarnessId } from "@shared/managed-terminal-templates";
import { getJuntoApi } from "./junto-api";

/** Public CLI options and mode keys for the selected harness and folder. */
export const useHarnessLaunchOptions = (harness: HarnessId | undefined, cwd?: string) => {
  const [state, setState] = useState<
    Pick<ManagedTerminalFlagsResult, "flags" | "modes"> & { readonly loading: boolean }
  >({ flags: [], loading: harness !== undefined });

  useEffect(() => {
    if (!harness) {
      setState({ flags: [], loading: false });
      return;
    }
    let live = true;
    setState({ flags: [], loading: true });
    const load = getJuntoApi()?.managedTerminalFlags?.(harness, cwd);
    if (!load) {
      setState({ flags: [], loading: false });
      return;
    }
    void load
      .then((result) => {
        if (live) setState({ flags: result.flags, modes: result.modes, loading: false });
      })
      .catch(() => {
        if (live) setState({ flags: [], loading: false });
      });
    return () => {
      live = false;
    };
  }, [harness, cwd]);

  return state;
};
