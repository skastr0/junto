/**
 * The frozen state schemas, version 13 through version 29, built only from
 * frozen text and frozen steps so no later schema change can move a
 * historical witness.
 * Version 14 is its frozen fragments; version 13 is version 14 with the mail
 * trigger put back; each later version is the one before with its own step
 * run on it. Tests build historical databases from these to prove each step.
 */
import {
  PROPOSAL_STORAGE_V14_TEXTS,
  STATE_SCHEMA_V14_FRAGMENTS,
} from "./v14-fragments";
import { DatabaseSync } from "node:sqlite";
import { migrateOneMachineLog } from "../../../src/main/junto/work/migrate-one-machine-log";
import { STATE_SCHEMA_MIGRATIONS } from "../../../src/main/junto/state/migrations";

const STATE_SCHEMA_FRAGMENTS: ReadonlyArray<string> = Object.values(STATE_SCHEMA_V14_FRAGMENTS);

/** Every composition leaves the proposal storage out, by exact text. */
const withoutProposalStorage = (sql: string): string => {
  let corrected = sql;
  for (const text of PROPOSAL_STORAGE_V14_TEXTS) {
    if (!corrected.includes(text)) throw new Error("frozen schema composition lost a proposal storage text");
    corrected = corrected.replace(text, "");
  }
  return corrected;
};

export const STATE_SCHEMA_V14_SQL = withoutProposalStorage(STATE_SCHEMA_FRAGMENTS.join("\n"));

/**
 * A later version is the earlier one with that step's own migration run on
 * it. A step never follows the head, so the result is frozen with the step.
 */
export const stepped = (
  sql: string,
  migrate: (database: DatabaseSync) => void,
): string => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(sql);
    migrate(database);
    // A full-text table's shadow tables are its own: creating it makes them.
    return (
      database
        .prepare(
          `SELECT sql FROM sqlite_schema
            WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'
              AND name NOT IN (SELECT name FROM pragma_table_list WHERE type = 'shadow')
            ORDER BY rowid`,
        )
        .all()
        .map((row) => `${String(row.sql)};`)
        .join("\n")
    );
  } finally {
    database.close();
  }
};

// Version 15 dropped the tables that carried tasks between machines (14 -> 15).
export const STATE_SCHEMA_V15_SQL = stepped(STATE_SCHEMA_V14_SQL, migrateOneMachineLog);

// Version 16 added the row exchange cursors (15 -> 16).
export const STATE_SCHEMA_V16_SQL = stepped(
  STATE_SCHEMA_V15_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 16)!.migrate,
);

// Version 17 added peers (16 -> 17).
export const STATE_SCHEMA_V17_SQL = stepped(
  STATE_SCHEMA_V16_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 17)!.migrate,
);

// Version 18 named the machine that edits each canvas (17 -> 18).
export const STATE_SCHEMA_V18_SQL = stepped(
  STATE_SCHEMA_V17_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 18)!.migrate,
);

// Version 19 added what the editing machine remembers of the copies it sent (18 -> 19).
export const STATE_SCHEMA_V19_SQL = stepped(
  STATE_SCHEMA_V18_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 19)!.migrate,
);

// Version 20 moved each seat's session pin into the seat sessions store (19 -> 20).
export const STATE_SCHEMA_V20_SQL = stepped(
  STATE_SCHEMA_V19_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 20)!.migrate,
);

// Version 21 gave every machine a real name (20 -> 21).
export const STATE_SCHEMA_V21_SQL = stepped(
  STATE_SCHEMA_V20_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 21)!.migrate,
);

// Version 22 kept seat session notes and marks in the database (21 -> 22).
export const STATE_SCHEMA_V22_SQL = stepped(
  STATE_SCHEMA_V21_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 22)!.migrate,
);

// Version 23 added the harness model cache (22 -> 23).
export const STATE_SCHEMA_V23_SQL = stepped(
  STATE_SCHEMA_V22_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 23)!.migrate,
);

// Version 24 retired seats.session_id and said stop, not kill-session (23 -> 24).
export const STATE_SCHEMA_V24_SQL = stepped(
  STATE_SCHEMA_V23_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 24)!.migrate,
);

// Version 14 dropped this trigger (13 -> 14), so version 13 is version 14 with it.
const MAIL_HOME_TRIGGER_V13_SQL = `
  CREATE TRIGGER IF NOT EXISTS work_messages_require_cc_home
  BEFORE INSERT ON work_messages
  WHEN
    NOT EXISTS (
      SELECT 1
      FROM station_configuration AS configuration
      JOIN station_installation AS installation
        ON installation.singleton = configuration.singleton
      WHERE configuration.singleton = 1
        AND configuration.role = 'command-center'
        AND NEW.entity_home = installation.installation_id
    )
  BEGIN
    SELECT RAISE(
      ABORT,
      'work mailbox messages must be Command Center-homed'
    );
  END;
`;
export const STATE_SCHEMA_V13_SQL = `${STATE_SCHEMA_V14_SQL}\n${MAIL_HOME_TRIGGER_V13_SQL}`;

// Version 25 retired on_remove from seats and terminals (24 -> 25).
export const STATE_SCHEMA_V25_SQL = stepped(
  STATE_SCHEMA_V24_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 25)!.migrate,
);

// Version 26 added versioned artifacts and resource rulings (25 -> 26).
export const STATE_SCHEMA_V26_SQL = stepped(
  STATE_SCHEMA_V25_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 26)!.migrate,
);

// Version 27 put the actor on resource rulings (26 -> 27).
export const STATE_SCHEMA_V27_SQL = stepped(
  STATE_SCHEMA_V26_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 27)!.migrate,
);

// Version 28 added the automations node and its store (27 -> 28).
export const STATE_SCHEMA_V28_SQL = stepped(
  STATE_SCHEMA_V27_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 28)!.migrate,
);

// Version 29 named artifact bodies by content ref (28 -> 29).
export const STATE_SCHEMA_V29_SQL = stepped(
  STATE_SCHEMA_V28_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 29)!.migrate,
);

// Version 30 added stubs (29 -> 30).
export const STATE_SCHEMA_V30_SQL = stepped(
  STATE_SCHEMA_V29_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 30)!.migrate,
);

// Version 31 added the 0.10 task tables and copied every task in (30 -> 31).
export const STATE_SCHEMA_V31_SQL = stepped(
  STATE_SCHEMA_V30_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 31)!.migrate,
);

// Version 32 deleted what 0.10 deletes (31 -> 32).
export const STATE_SCHEMA_V32_SQL = stepped(
  STATE_SCHEMA_V31_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 32)!.migrate,
);

// Version 33 named each review verdict's reviewer kind (32 -> 33).
export const STATE_SCHEMA_V33_SQL = stepped(
  STATE_SCHEMA_V32_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 33)!.migrate,
);

// Version 34 remembered the automations a node delete archived (33 -> 34).
export const STATE_SCHEMA_V34_SQL = stepped(
  STATE_SCHEMA_V33_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 34)!.migrate,
);

// Version 35 took relay.trigger out of every wire mask (34 -> 35).
export const STATE_SCHEMA_V35_SQL = stepped(
  STATE_SCHEMA_V34_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 35)!.migrate,
);

// Version 36 kept when each task's state began (35 -> 36).
export const STATE_SCHEMA_V36_SQL = stepped(
  STATE_SCHEMA_V35_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 36)!.migrate,
);

// Version 37 kept the check runs on each task (36 -> 37).
export const STATE_SCHEMA_V37_SQL = stepped(
  STATE_SCHEMA_V36_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 37)!.migrate,
);

// Version 38 kept the origins a seat ran code in (37 -> 38).
export const STATE_SCHEMA_V38_SQL = stepped(
  STATE_SCHEMA_V37_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 38)!.migrate,
);

// Version 39 deleted the bulletin board and the requests node (38 -> 39).
export const STATE_SCHEMA_V39_SQL = stepped(
  STATE_SCHEMA_V38_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 39)!.migrate,
);

// Version 40 let a full touched-origin record admit an origin it holds (39 -> 40).
export const STATE_SCHEMA_V40_SQL = stepped(
  STATE_SCHEMA_V39_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 40)!.migrate,
);

// Version 41 remembered the tasks a seat delete sent back to the backlog (40 -> 41).
export const STATE_SCHEMA_V41_SQL = stepped(
  STATE_SCHEMA_V40_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 41)!.migrate,
);

// Version 42 kept the page comments whose shot was purged (41 -> 42).
export const STATE_SCHEMA_V42_SQL = stepped(
  STATE_SCHEMA_V41_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 42)!.migrate,
);

// Version 43 kept what each archived task was archived from (42 -> 43).
export const STATE_SCHEMA_V43_SQL = stepped(
  STATE_SCHEMA_V42_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 43)!.migrate,
);

// Version 44 kept how far automations have read each canvas's task rulings (43 -> 44).
export const STATE_SCHEMA_V44_SQL = stepped(
  STATE_SCHEMA_V43_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 44)!.migrate,
);

// Version 45 kept what each finish cited and the note it left (44 -> 45).
export const STATE_SCHEMA_V45_SQL = stepped(
  STATE_SCHEMA_V44_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 45)!.migrate,
);

// Version 46 kept where each seat, task, artifact and page is mentioned (45 -> 46).
export const STATE_SCHEMA_V46_SQL = stepped(
  STATE_SCHEMA_V45_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 46)!.migrate,
);

// Version 47 gave a signal's files an owner kind of their own (46 -> 47).
export const STATE_SCHEMA_V47_SQL = stepped(
  STATE_SCHEMA_V46_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 47)!.migrate,
);

// Version 48 took the task and artifact ports out of every wire mask (47 -> 48).
export const STATE_SCHEMA_V48_SQL = stepped(
  STATE_SCHEMA_V47_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 48)!.migrate,
);

// Version 49 let the operator name a page, a file or a link (48 -> 49).
export const STATE_SCHEMA_V49_SQL = stepped(
  STATE_SCHEMA_V48_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 49)!.migrate,
);

// Version 50 let a task board derive into another (49 -> 50).
export const STATE_SCHEMA_V50_SQL = stepped(
  STATE_SCHEMA_V49_SQL,
  STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 50)!.migrate,
);
