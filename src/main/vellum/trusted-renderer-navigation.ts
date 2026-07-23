import type { TrustedRendererOrigin } from "@shared/trusted-renderer-origin";

export interface PreventableNavigationEvent {
  readonly preventDefault: () => void;
}

export interface TrustedRendererNavigationOptions {
  readonly origin: TrustedRendererOrigin;
  readonly currentUrl: () => string;
  readonly available: () => boolean;
  readonly trust: () => void;
  readonly revoke: () => void;
  readonly rejectCommittedUrl: (url: string) => void;
  readonly documentStarted?: () => void;
  readonly committedDocumentRestored?: () => void;
  readonly trustedDocumentCommitted?: () => void;
}

/**
 * Main-document navigation is a trust-generation boundary. Keep the event
 * choreography outside index.ts so canceled redirects and failed reloads can
 * be proved without a BrowserWindow fixture.
 */
export const createTrustedRendererNavigation = (
  options: TrustedRendererNavigationOptions,
) => {
  let mainDocumentPending = false;
  let hasCommittedDocument = false;

  const restoreCommittedDocument = (): void => {
    const wasPending = mainDocumentPending;
    mainDocumentPending = false;
    if (!wasPending || !hasCommittedDocument || !options.available()) return;
    const current = options.currentUrl();
    if (options.origin.allows(current)) {
      options.trust();
      options.committedDocumentRestored?.();
    }
  };

  return {
    willNavigate(event: PreventableNavigationEvent, url: string): void {
      if (options.origin.allows(url)) return;
      event.preventDefault();
      // A denied navigation leaves the previously committed document in
      // place. Preserve (or restore, under adversarial event ordering) its
      // authority instead of stranding a live black/stuck renderer.
      restoreCommittedDocument();
    },

    didStartNavigation(inPlace: boolean, isMainFrame: boolean): void {
      if (!isMainFrame || inPlace) return;
      mainDocumentPending = true;
      options.revoke();
      options.documentStarted?.();
    },

    willRedirect(event: PreventableNavigationEvent, isMainFrame: boolean): void {
      // Redirects are outside the boot contract. Cancel them without leaving
      // the still-committed application document untrusted.
      event.preventDefault();
      if (isMainFrame) restoreCommittedDocument();
    },

    /**
     * Main-frame commit (Electron `did-navigate`). Mint IPC trust here — not
     * only on `did-finish-load` — so renderer module evaluation that runs
     * between commit and load-complete is not refused as untrusted.
     * Mount readiness still waits for `didFinishLoad` → surface challenge.
     */
    didNavigate(url: string): void {
      if (!options.available()) return;
      if (!options.origin.allows(url)) {
        mainDocumentPending = false;
        options.revoke();
        options.rejectCommittedUrl(url);
        return;
      }
      options.trust();
      hasCommittedDocument = true;
    },

    didFinishLoad(): void {
      if (!options.available()) return;
      mainDocumentPending = false;
      const current = options.currentUrl();
      if (!options.origin.allows(current)) {
        options.revoke();
        options.rejectCommittedUrl(current);
        return;
      }
      options.trust();
      hasCommittedDocument = true;
      options.trustedDocumentCommitted?.();
    },

    didFailLoad(isMainFrame: boolean): void {
      if (isMainFrame && mainDocumentPending) restoreCommittedDocument();
    },

    didStopLoading(): void {
      if (mainDocumentPending) restoreCommittedDocument();
    },

    documentLost(): void {
      mainDocumentPending = false;
      hasCommittedDocument = false;
      options.revoke();
      // Electron may replace a renderer after process loss without a fresh
      // user navigation. Arm the same absolute load boundary immediately so
      // a clean-exit or failed replacement cannot leave a black live window.
      options.documentStarted?.();
    },
  } as const;
};
