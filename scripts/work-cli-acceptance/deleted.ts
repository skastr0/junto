/**
 * Deleted commands are gone from discovery. Owner: pty-contract. Each is
 * absent from help, has no schema in schema list, and schema show refuses it
 * as unknown. Discovery runs with every feature flag on, so a command hidden
 * only by a flag still counts as present.
 *
 * cli-lead confirmed the `deleted` set gone; the `unverified` set is pending on
 * cli-skill, auditing discovery against dispatch, while any of it still shows.
 */
import type { WorkCliCommandResult } from "../work-cli-acceptance";
import { casesFor, type AcceptanceArea, type CaseVerdict } from "./area";
import { envelopeOf } from "./envelope";

const { check, pass, pending } = casesFor("deleted");

const FLAGS_ON = { JUNTO_BOARD: "1", JUNTO_REQUESTS: "1", JUNTO_TASKS: "1", JUNTO_ARTIFACTS: "1", JUNTO_BROWSER: "1" } as const;

/** A command as typed: a family, or a family and its verb. */
type Gone = { readonly command: string; readonly confirmed: boolean };

const GONE: ReadonlyArray<Gone> = [
  ...["pad", "sheet", "cron", "relay", "watcher", "timer", "task claim"].map((command) => ({ command, confirmed: true })),
  ...["board", "requests", "verdict post", "chat"].map((command) => ({ command, confirmed: false })),
];

/** The subcommand names a help screen lists, one per line under SUBCOMMANDS. */
const subcommandsOf = (result: WorkCliCommandResult): ReadonlySet<string> => {
  const lines = `${result.stdout}\n${result.stderr}`.split("\n");
  const start = lines.findIndex((line) => line.trim() === "SUBCOMMANDS");
  if (start < 0) return new Set();
  const names = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    const match = /^ {2}(\S+)(\s|$)/.exec(line);
    if (match === null) break;
    names.add(match[1]!);
  }
  return names;
};

export const deletedArea: AcceptanceArea = {
  name: "deleted",
  owner: "pty-contract",
  run: async ({ cli, log }) => {
    const ask = (args: ReadonlyArray<string>) => cli(args, undefined, FLAGS_ON);
    const rootHelp = await ask(["--help"]);
    log("help", rootHelp.stdout || rootHelp.stderr);
    const root = subcommandsOf(rootHelp);
    const schemaList = await ask(["schema", "list"]);
    const schemas: ReadonlyArray<{ readonly command?: unknown }> = envelopeOf(schemaList)?.data?.schemas ?? [];
    const familyHelp = new Map<string, ReadonlySet<string>>();

    const verdicts: CaseVerdict[] = [
      check("help lists commands", root.has("schema") && root.has("msg"), rootHelp),
      check("schema list reads", schemas.length > 0, schemaList),
    ];
    for (const { command, confirmed } of GONE) {
      const [family, verb] = command.split(" ") as [string, string | undefined];
      let inHelp: boolean;
      if (verb === undefined) {
        inHelp = root.has(family);
      } else {
        if (!familyHelp.has(family)) familyHelp.set(family, root.has(family) ? subcommandsOf(await ask([family, "--help"])) : new Set());
        inHelp = familyHelp.get(family)!.has(verb);
      }
      const inSchemas = schemas.some((entry) => entry.command === command || String(entry.command).startsWith(`${command} `));
      const shown = await ask(["schema", "show", command]);
      const refusal = envelopeOf(shown);
      const unknown = shown.code === 1 && refusal?.ok === false && refusal.error?.type === "InputError" &&
        refusal.error?.details?.path === "target" && String(refusal.error?.message).includes(`No schema found for ${command}`);
      const gone = !inHelp && !inSchemas && unknown;
      const name = `${command} is gone`;
      if (gone) verdicts.push(pass(name));
      else if (!confirmed) verdicts.push(pending(name, "cli-skill"));
      else verdicts.push(check(name, false, { ...shown, stdout: JSON.stringify({ inHelp, inSchemas, schemaShow: refusal }) }));
    }

    // No command on main is named for connected boards, so they are looked for in what onboard and capabilities print.
    const onboard = await ask(["onboard"]);
    const capabilities = await ask(["capabilities"]);
    const boards = /connected[ _-]?boards/i;
    verdicts.push(
      boards.test(onboard.stdout) || boards.test(capabilities.stdout)
        ? pending("connected boards are gone", "cli-skill")
        : check("connected boards are gone", onboard.code === 0 && capabilities.code === 0, onboard.code === 0 ? capabilities : onboard),
    );
    return verdicts;
  },
};
