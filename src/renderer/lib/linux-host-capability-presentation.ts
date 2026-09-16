import type {
  LinuxHostCapabilityCheck,
  LinuxHostCapabilityId,
  LinuxHostCapabilityObservation,
  LinuxHostCapabilityProjection,
  LinuxHostCapabilityStatus,
  LinuxHostRemediation,
  LinuxHostRemediationAnchor,
} from "@shared/linux-host-capabilities";

export const LINUX_HOST_PREPARATION_DOC =
  "docs/linux-host-preparation.md" as const;
export const LINUX_HOST_PREPARATION_URL =
  `https://github.com/skastr0/junto/blob/main/${LINUX_HOST_PREPARATION_DOC}` as const;

const FINDINGS_ANCHOR =
  "docs/linux-host-preparation.md#how-are-host-findings-reported" as const satisfies LinuxHostRemediationAnchor;

const STATUS_LABELS: Readonly<Record<LinuxHostCapabilityStatus, string>> = {
  ready: "Ready",
  "requires-admin": "Needs administrator",
  declined: "Declined",
  unavailable: "Unavailable",
  misconfigured: "Misconfigured",
};

export type LinuxHostCapabilityDisplayId =
  | "core-station"
  | "browser"
  | "reboot-persistence"
  | "native-pty"
  | "secure-browser-credentials";

export interface LinuxHostCapabilityDisplay {
  readonly id: LinuxHostCapabilityDisplayId;
  readonly label: string;
  readonly status: LinuxHostCapabilityStatus;
  readonly statusLabel: string;
  readonly summary: string;
  readonly consequence?: string;
  readonly remediation?: {
    readonly authority: LinuxHostRemediation["authority"];
    readonly summary: string;
    readonly reference: LinuxHostRemediationAnchor;
    readonly href: string;
  };
}

export interface LinuxHostCapabilityPresentation {
  readonly coreStatus: LinuxHostCapabilityStatus;
  readonly coreStatusLabel: string;
  readonly optionalLimitCount: number;
  readonly summary: string;
  readonly capabilities: ReadonlyArray<LinuxHostCapabilityDisplay>;
}

const FALLBACK_REMEDIATION: LinuxHostRemediation = {
  authority: "operator",
  anchor: FINDINGS_ANCHOR,
  summary: "Review the incomplete host observation before retrying this capability.",
};

export const linuxHostPreparationHref = (
  anchor: LinuxHostRemediationAnchor,
): string => {
  const fragment = anchor.slice(LINUX_HOST_PREPARATION_DOC.length);
  return `${LINUX_HOST_PREPARATION_URL}${fragment}`;
};

export const linuxHostCapabilityStatusLabel = (
  status: LinuxHostCapabilityStatus,
): string => STATUS_LABELS[status];

const remediationView = (remediation: LinuxHostRemediation) => ({
  authority: remediation.authority,
  summary: remediation.summary,
  reference: remediation.anchor,
  href: linuxHostPreparationHref(remediation.anchor),
});

const displayFromProjection = (
  id: LinuxHostCapabilityDisplayId,
  label: string,
  projection: LinuxHostCapabilityProjection,
  consequence: string,
): LinuxHostCapabilityDisplay =>
  projection.status === "ready"
    ? {
        id,
        label,
        status: projection.status,
        statusLabel: linuxHostCapabilityStatusLabel(projection.status),
        summary: projection.summary,
      }
    : {
        id,
        label,
        status: projection.status,
        statusLabel: linuxHostCapabilityStatusLabel(projection.status),
        summary: projection.summary,
        consequence,
        remediation: remediationView(projection.remediation),
      };

const findCheck = (
  observation: LinuxHostCapabilityObservation,
  id: LinuxHostCapabilityId,
): LinuxHostCapabilityCheck | undefined =>
  observation.checks.find((check) => check.id === id);

const displayFromCheck = (
  observation: LinuxHostCapabilityObservation,
  checkId: LinuxHostCapabilityId,
  id: LinuxHostCapabilityDisplayId,
  label: string,
  consequence: string,
): LinuxHostCapabilityDisplay => {
  const check = findCheck(observation, checkId);
  if (check === undefined) {
    return {
      id,
      label,
      status: "unavailable",
      statusLabel: linuxHostCapabilityStatusLabel("unavailable"),
      summary: `The host probe did not report ${label.toLowerCase()} readiness.`,
      consequence,
      remediation: remediationView(FALLBACK_REMEDIATION),
    };
  }
  return check.status === "ready"
    ? {
        id,
        label,
        status: check.status,
        statusLabel: linuxHostCapabilityStatusLabel(check.status),
        summary: check.summary,
      }
    : {
        id,
        label,
        status: check.status,
        statusLabel: linuxHostCapabilityStatusLabel(check.status),
        summary: check.summary,
        consequence,
        remediation: remediationView(check.remediation),
      };
};

const coreDisplay = (
  observation: LinuxHostCapabilityObservation,
): LinuxHostCapabilityDisplay => {
  if (observation.status === "ready") {
    return {
      id: "core-station",
      label: "Core Station",
      status: observation.status,
      statusLabel: linuxHostCapabilityStatusLabel(observation.status),
      summary: observation.summary,
    };
  }

  return {
    id: "core-station",
    label: "Core Station",
    status: observation.status,
    statusLabel: linuxHostCapabilityStatusLabel(observation.status),
    summary: observation.summary,
    consequence:
      "Install, update, and core Remote work remain unavailable on this host.",
    remediation: remediationView(observation.remediation),
  };
};

export const presentLinuxHostCapabilities = (
  observation: LinuxHostCapabilityObservation,
): LinuxHostCapabilityPresentation => {
  const capabilities: ReadonlyArray<LinuxHostCapabilityDisplay> = [
    coreDisplay(observation),
    displayFromProjection(
      "browser",
      "Browser",
      observation.browser,
      "Browser automation stays disabled; unrelated core Station work can continue.",
    ),
    displayFromCheck(
      observation,
      "persistence",
      "reboot-persistence",
      "Reboot persistence",
      "The Remote can run for this login, but it may stop after logout and will not return unattended after reboot.",
    ),
    displayFromProjection(
      "native-pty",
      "Native PTY",
      observation.terminal,
      "Native terminal sessions stay unavailable; other ready Station capabilities can continue.",
    ),
    displayFromCheck(
      observation,
      "secret-storage",
      "secure-browser-credentials",
      "Secure browser credentials",
      "Persistent browser credentials stay unavailable; browser sessions that require secure storage remain disabled.",
    ),
  ];
  const optionalLimitCount = capabilities
    .slice(1)
    .filter((capability) => capability.status !== "ready").length;
  const coreStatusLabel = linuxHostCapabilityStatusLabel(observation.status);
  return {
    coreStatus: observation.status,
    coreStatusLabel,
    optionalLimitCount,
    summary:
      observation.status === "ready"
        ? optionalLimitCount === 0
          ? "Core Station ready - all requested host capabilities ready"
          : `Core Station ready - ${optionalLimitCount} optional ${
              optionalLimitCount === 1 ? "limit" : "limits"
            }`
        : `Core Station ${coreStatusLabel.toLowerCase()}`,
    capabilities,
  };
};
