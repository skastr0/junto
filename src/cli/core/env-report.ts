import { Effect } from "effect";
import { executeJsonCommand, setExitCode } from "./output";

/**
 * The exit rule shared by `junto overseer env doctor` and `junto env report`.
 *
 * Both print the resolver's report whole, as the JSON result. The exit code
 * is non-zero when any source is `required` and could not be read (`missing`
 * or `error`): a seat depending on it would be refused at launch.
 *
 * The report's shape belongs to the resolver. This reads only the three
 * fields the rule needs, wherever a source row appears in it, so a report
 * for one seat and one for the whole canvas obey the same rule.
 */
const isBlockingSource = (value: Record<string, unknown>): boolean =>
  typeof value.sourceId === "string" &&
  value.required === true &&
  (value.status === "missing" || value.status === "error");

export const reportBlocksLaunch = (report: unknown): boolean => {
  if (Array.isArray(report)) return report.some(reportBlocksLaunch);
  if (typeof report !== "object" || report === null) return false;
  const record = report as Record<string, unknown>;
  return isBlockingSource(record) || Object.values(record).some(reportBlocksLaunch);
};

export const executeReportCommand = <E, R>(
  command: string,
  report: Effect.Effect<unknown, E, R>,
) =>
  executeJsonCommand(
    command,
    report.pipe(
      Effect.tap((data) => (reportBlocksLaunch(data) ? setExitCode(1) : Effect.void)),
    ),
  );
