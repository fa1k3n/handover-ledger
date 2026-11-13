// The command `howl`. Each command loads only what it needs, so that `howl hook`
// starts quickly: it runs on every tool call of a session.
import { readFileSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";

const USAGE = `usage:
  howl verify [--project <name>] [--ledger <path>]
  howl hook
  howl emit <type> [--task <id>] [--change <id>] [--data '<json object>']
  howl ingest [--project <name>] [--watch] [--interval <seconds>]

  verify    check every line of the ledger and the chain between the lines
  hook      called by the hooks of Claude Code: leaves an event in the inbox.
            Prints nothing and always ends with 0
  emit      leave an event in the inbox from a script
  ingest    the one writer: bring the inbox into the ledger and the activity file

The project is read from the nearest .howl/howl.yml, unless --project names it.
Its files are in $HOWL_HOME, else $XDG_STATE_HOME/howl, else ~/.local/state/howl,
in a folder named after the project: ledger.jsonl, activity.jsonl and inbox/.

verify ends with 0 when the ledger holds, 1 when it does not, and 2 when it
could not be read. It cannot show lines cut off the end: compare the head it
prints with one kept somewhere else.`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  // The hook comes first and alone: whatever happens, it prints nothing and ends with 0.
  if (command === "hook") {
    try {
      const { runHook } = await import("../hook/hook.ts");
      runHook(readFileSync(0, "utf8"), process.env, process.cwd());
    } catch {
      // Never disturb the session.
    }
    return 0;
  }

  try {
    switch (command) {
      case "verify":
        return await verifyCommand(rest);
      case "emit":
        return await emitCommand(rest);
      case "ingest":
        return await ingestCommand(rest);
      case "-h":
      case "--help":
      case "help":
        console.log(USAGE);
        return 0;
      case undefined:
        throw new UsageError("no command");
      default:
        throw new UsageError(`no command ${command}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`howl: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    const { LedgerError, isCode } = await import("../ledger/errors.ts");
    if (e instanceof LedgerError || ["ENOENT", "EACCES", "EISDIR", "ENOTDIR"].some((c) => isCode(e, c))) {
      console.error(`howl: ${(e as Error).message}`);
      return 2;
    }
    throw e;
  }
}

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: T, positionals = 0) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (parsed.positionals.length > positionals) {
    throw new UsageError(`too many arguments: ${parsed.positionals.slice(positionals).join(" ")}`);
  }
  return parsed;
}

async function verifyCommand(args: string[]): Promise<number> {
  const { values } = parse(args, { project: { type: "string" }, ledger: { type: "string" } });
  const { ledgerPath } = await import("../ledger/place.ts");
  const { verify } = await import("../ledger/verify.ts");
  let path = values.ledger;
  if (path === undefined) {
    if (values.project === undefined) throw new UsageError("verify needs --project or --ledger");
    path = ledgerPath(values.project);
  }
  const verdict = verify(path);
  console.log(path);
  if (!verdict.ok) {
    console.log(`line ${verdict.line}: ${verdict.faults.join("; ")}`);
    console.log(`failed at line ${verdict.line}, after ${count(verdict.lines, "line")} that hold`);
    return 1;
  }
  console.log(`ok: ${count(verdict.lines, "line")} checked, head ${verdict.head}`);
  if (verdict.trial) console.log("a trial: it does not count as evidence");
  return 0;
}

async function emitCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    args,
    { task: { type: "string" }, change: { type: "string" }, data: { type: "string" } },
    1,
  );
  const [type] = positionals;
  if (type === undefined) {
    console.error(`howl: emit needs a type\n\n${USAGE}`);
    return 1;
  }
  const { emit } = await import("../howl/emit.ts");
  const { LedgerError } = await import("../ledger/errors.ts");
  try {
    emit({ type, ...values }, process.env, process.cwd());
    return 0;
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    console.error(`howl: ${e.message}`);
    return 1;
  }
}

async function ingestCommand(args: string[]): Promise<number> {
  const { values } = parse(args, {
    project: { type: "string" },
    watch: { type: "boolean" },
    interval: { type: "string" },
  });
  const { findProject, DEFAULT_ACTIVITY_DAYS } = await import("../howl/project.ts");
  const { activityPath, inboxPath, ledgerPath } = await import("../ledger/place.ts");
  const { openLedger } = await import("../ledger/ledger.ts");
  const { ingestPass } = await import("../inbox/ingest.ts");

  const found = findProject(process.cwd());
  const project = values.project ?? found?.project;
  if (project === undefined) throw new UsageError("ingest needs --project, or a .howl/howl.yml above the working directory");
  const activityDays = found && found.project === project ? found.activityDays : DEFAULT_ACTIVITY_DAYS;
  const interval = values.interval === undefined ? 1 : Number(values.interval);
  if (!(interval > 0)) throw new UsageError("--interval must be a number of seconds above 0");

  const places = { project, inbox: inboxPath(project), activity: activityPath(project) };
  const writer = openLedger(ledgerPath(project), { project });

  const once = () => {
    const pass = ingestPass(places, writer, activityDays);
    if (pass.ledger + pass.activity + pass.rejected + pass.expired > 0 || !values.watch) {
      console.log(
        `${pass.ledger} to the ledger, ${pass.activity} to activity, ${pass.expired} expired, ${pass.rejected} rejected`,
      );
    }
    if (pass.rejected > 0) console.error(`howl: ${pass.rejected} rejected, see ${places.inbox}/rejected`);
  };

  if (!values.watch) {
    try {
      once();
    } finally {
      writer.close();
    }
    return 0;
  }

  return await new Promise<number>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const stop = () => {
      clearTimeout(timer);
      writer.close();
      resolve(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const tick = () => {
      try {
        once();
      } catch (e) {
        writer.close();
        reject(e);
        return;
      }
      timer = setTimeout(tick, interval * 1000);
    };
    tick();
  });
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

process.exitCode = await main(process.argv.slice(2));
