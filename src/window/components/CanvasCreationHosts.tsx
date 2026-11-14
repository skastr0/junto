/**
 * The canvas's creation hosts: the terminal, git and files wizards, the squad
 * and profile dialogs, and the profile draft editor.
 *
 * They belong to the canvas but not to a canvas implementation. The field
 * tools beside the canvas ask for them with window events and the shared
 * stores (`junto:new-terminal`, `junto:new-git`, `junto:new-files`,
 * `squadDialog$`, `profileDialog$`, `profileDraft$`), and the draws they make
 * are board positions both canvases speak. Mounted once, above the canvas, so
 * +Add Item → Terminal / Git / Files and Save as Squad work whichever canvas
 * is drawing; mounted inside the old canvas they went dead the moment the GPU
 * canvas was switched on.
 */
import { useEffect, useState } from "react";
import { FLEET_UI_ENABLED } from "@shared/features";
import { featureOnNow } from "../lib/experimental-features";
import { TerminalWizard, createTerminalAt } from "./terminal/TerminalWizard";
import { GitWizard, createGitFromRegion } from "./git/GitWizard";
import { FilesWizard, createFilesFromRegion } from "./files/FilesWizard";
import { SquadDialogHost } from "./squads/SquadDialog";
import { ProfileDialogHost } from "./profiles/ProfileDialog";
import { ProfileDraftEditorHost } from "./profiles/ProfileDraftEditor";

export function CanvasCreationHosts() {
  const [terminalAnchor, setTerminalAnchor] = useState<{ x: number; y: number } | null>(null);
  const [gitAnchor, setGitAnchor] = useState<{ x: number; y: number } | null>(null);
  const [filesAnchor, setFilesAnchor] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const openTerminal = (event: Event) => {
      const anchor = (event as CustomEvent<{ x: number; y: number }>).detail;
      // Host choice is a fleet surface; without it there is nothing to ask.
      if (!FLEET_UI_ENABLED) {
        void createTerminalAt(anchor);
        return;
      }
      setTerminalAnchor(anchor);
    };
    window.addEventListener("junto:new-terminal", openTerminal);
    return () => {
      window.removeEventListener("junto:new-terminal", openTerminal);
    };
  }, []);

  useEffect(() => {
    const openGit = (event: Event) => {
      const anchor = (event as CustomEvent<{ x: number; y: number }>).detail;
      if (createGitFromRegion(anchor)) return;
      setGitAnchor(anchor);
    };
    window.addEventListener("junto:new-git", openGit);
    return () => {
      window.removeEventListener("junto:new-git", openGit);
    };
  }, []);

  useEffect(() => {
    const openFiles = (event: Event) => {
      if (!featureOnNow("files")) return;
      const anchor = (event as CustomEvent<{ x: number; y: number }>).detail;
      if (createFilesFromRegion(anchor)) return;
      setFilesAnchor(anchor);
    };
    window.addEventListener("junto:new-files", openFiles);
    return () => {
      window.removeEventListener("junto:new-files", openFiles);
    };
  }, []);

  return (
    <>
      {terminalAnchor ? <TerminalWizard anchor={terminalAnchor} onClose={() => setTerminalAnchor(null)} /> : null}
      {gitAnchor ? <GitWizard anchor={gitAnchor} onClose={() => setGitAnchor(null)} /> : null}
      {filesAnchor ? <FilesWizard anchor={filesAnchor} onClose={() => setFilesAnchor(null)} /> : null}
      <SquadDialogHost />
      <ProfileDialogHost />
      <ProfileDraftEditorHost />
    </>
  );
}
