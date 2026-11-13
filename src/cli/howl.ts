// The command `howl`. Each command loads only what it needs, so that `howl hook`
// starts quickly: it runs on every tool call of a session.
import { readFileSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";

const USAGE = `usage:
  howl verify [--project <name>] [--ledger <path>]
  howl hook
  howl emit <type> [--task <id>] [--change <id>] [--data '<json object>']
  howl ingest [--project <name>] [--watch] [--interval <seconds>]
  howl observe [--once] [--interval <seconds>]
  howl watch [--since <time>] [--filter <field>=<value> ...] [--activity] [--json] [--no-follow]
  howl show <task or change> [--json]
  howl status [--follow] [--json]
  howl serve [--port <n>]

  verify    check every line of the ledger and the chain between the lines
  hook      called by the hooks of Claude Code: leaves an event in the inbox.
            Prints nothing and always ends with 0
  emit      leave an event in the inbox from a script
  ingest    the one writer: bring the inbox into the ledger and the activity file
  observe   the one writer a team keeps running: each round brings the inbox in
            and records what happened at the code host since the last round.
            Read access is enough. GitHub: a token from $HOWL_GITHUB_TOKEN,
            else $GITHUB_TOKEN, else \`gh auth token\`
  watch     print the events of the ledger, then follow them. --activity adds
            the tool calls of the activity file; a filter on type=tool.used
            does too. A field and a value filter: type=review.*, actor=agent-1,
            kind=claimed, change=12. Colour unless NO_COLOR is set
  show      the timeline of one assignment, from the hand-over to the merge:
            12, task:12 or change:30
  status    one line per agent: NEEDS INPUT, working, waiting, idle or ended,
            what it works on, its model, its last tool and how long ago.
            NEEDS INPUT is a wait for a person, as a permission prompt; an
            agent that asks in the text of its answer looks done and shows
            as waiting. --follow redraws it every second
  serve     the dashboard on http://127.0.0.1:4317: the team right now and the
            event stream. Read-only, on this machine only. Build the page
            first with npm run build:dashboard

watch, show, status, serve and verify also take --project <name> or --ledger <path>. They
only read: they take no lock and run while the writer appends.

The project is read from the nearest .howl/howl.yml, unless --project names it.
Its files are in $HOWL_HOME, else $XDG_STATE_HOME/howl, else ~/.local/state/howl,
in a folder named after the project: ledger.jsonl, activity.jsonl, inbox/,
people.json (the pseudonyms of people, never in the ledger) and observe.json.

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
      case "observe":
        return await observeCommand(rest);
      case "watch":
        return await watchCommand(rest);
      case "show":
        return await showCommand(rest);
      case "status":
        return await statusCommand(rest);
      case "serve":
        return await serveCommand(rest);
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
    if (pass.ledger + pass.activity + pass.rejected + pass.expired + pass.duplicates > 0 || !values.watch) {
      console.log(summary(pass));
    }
    if (pass.rejected > 0) console.error(`howl: ${pass.rejected} rejected, see ${places.inbox}/rejected`);
  };

  return await repeat(values.watch ? interval : null, once, () => writer.close());
}

async function observeCommand(args: string[]): Promise<number> {
  const { values } = parse(args, { once: { type: "boolean" }, interval: { type: "string" } });
  const { findProject } = await import("../howl/project.ts");
  const { activityPath, cursorPath, inboxPath, ledgerPath, peoplePath } = await import("../ledger/place.ts");
  const { openLedger } = await import("../ledger/ledger.ts");
  const { People } = await import("../observe/people.ts");
  const { Observer } = await import("../observe/observe.ts");
  const { LedgerError } = await import("../ledger/errors.ts");

  const found = findProject(process.cwd());
  if (!found) throw new UsageError("observe needs a .howl/howl.yml above the working directory");
  const interval = values.interval === undefined ? 60 : Number(values.interval);
  if (!(interval > 0)) throw new UsageError("--interval must be a number of seconds above 0");
  if (found.taskFromBranch !== undefined) {
    try {
      new RegExp(found.taskFromBranch);
    } catch {
      throw new LedgerError(`task_from_branch in .howl/howl.yml is not a regular expression: ${found.taskFromBranch}`);
    }
  }
  const host = await codeHost(found);

  const { project } = found;
  const writer = openLedger(ledgerPath(project), { project });
  let observer;
  try {
    observer = new Observer({
      host,
      writer,
      ledgerPath: ledgerPath(project),
      places: { project, inbox: inboxPath(project), activity: activityPath(project) },
      cursorPath: cursorPath(project),
      people: new People(peoplePath(project)),
      settings: found,
      warn: (message) => console.error(`howl: ${message}`),
    });
  } catch (e) {
    writer.close();
    throw e;
  }
  const once = async () => {
    const round = await observer.round();
    const pass = round.ingested;
    if (round.appended > 0 || values.once || pass.ledger + pass.activity + pass.rejected > 0) {
      console.log(`${round.appended} from ${host.name}; inbox: ${summary(pass)}${round.complete ? "" : "; some calls failed, read again next round"}`);
    }
    if (pass.rejected > 0) console.error(`howl: ${pass.rejected} rejected, see ${inboxPath(project)}/rejected`);
  };
  return await repeat(values.once ? null : interval, once, () => writer.close());
}

/** The ledger to read: --ledger, else that of --project, else that of the nearest .howl/howl.yml. */
async function ledgerToRead(values: { ledger?: string; project?: string }): Promise<string> {
  if (values.ledger !== undefined) return values.ledger;
  const { ledgerPath } = await import("../ledger/place.ts");
  if (values.project !== undefined) return ledgerPath(values.project);
  const { findProject } = await import("../howl/project.ts");
  const found = findProject(process.cwd());
  if (!found) throw new UsageError("give --ledger or --project, or run it below a .howl/howl.yml");
  return ledgerPath(found.project);
}

async function watchCommand(args: string[]): Promise<number> {
  const { values } = parse(args, {
    ledger: { type: "string" },
    project: { type: "string" },
    since: { type: "string" },
    filter: { type: "string", multiple: true },
    activity: { type: "boolean" },
    json: { type: "boolean" },
    "no-follow": { type: "boolean" },
    interval: { type: "string" },
  });
  const ledger = await ledgerToRead(values);
  const { statSync } = await import("node:fs");
  statSync(ledger);
  const interval = values.interval === undefined ? 0.5 : Number(values.interval);
  if (!(interval > 0)) throw new UsageError("--interval must be a number of seconds above 0");
  const { watch } = await import("../read/watch.ts");
  const { LedgerError } = await import("../ledger/errors.ts");
  const force = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "" && process.env.FORCE_COLOR !== "0";
  const colour = (process.stdout.isTTY || force) && !process.env.NO_COLOR;
  try {
    await watch(
      ledger,
      {
        since: values.since,
        filters: values.filter ?? [],
        activity: values.activity ?? false,
        json: values.json ?? false,
        follow: !values["no-follow"],
        interval,
        colour,
      },
      (line) => process.stdout.write(`${line}\n`),
    );
  } catch (e) {
    if (e instanceof LedgerError) throw new UsageError(e.message);
    throw e;
  }
  return 0;
}

async function showCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { ledger: { type: "string" }, project: { type: "string" }, json: { type: "boolean" } }, 1);
  const [what] = positionals;
  if (what === undefined) throw new UsageError("show needs a task or a change: 12, task:12 or change:30");
  const ledger = await ledgerToRead(values);
  const { readAll } = await import("../read/reader.ts");
  const { parseAsked, render, show } = await import("../read/show.ts");
  const reads = readAll(ledger);
  const activity = reads.filter((r) => r.from === "activity");
  const shown = show(
    reads.map((r) => r.event),
    parseAsked(what),
    activity.length > 0 ? activity[0]!.event.time : null,
  );
  if (shown === null) {
    console.error(`howl: nothing in the ledger names ${what}`);
    return 1;
  }
  console.log(values.json ? JSON.stringify(shown, null, 2) : render(shown));
  return 0;
}

async function serveCommand(args: string[]): Promise<number> {
  const { values } = parse(args, { ledger: { type: "string" }, project: { type: "string" }, port: { type: "string" } });
  const ledger = await ledgerToRead(values);
  const port = values.port === undefined ? 4317 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port must be a port number");
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../dist/dashboard", import.meta.url));
  if (!existsSync(`${root}/index.html`)) {
    const { LedgerError } = await import("../ledger/errors.ts");
    throw new LedgerError(`no built dashboard in ${root}: run npm run build:dashboard first`);
  }
  const { startServer } = await import("../serve/server.ts");
  const server = await startServer({ ledger, port, root, taskFromBranch: await branchPattern() });
  console.log(`howl serve: ${server.url} (read-only, ${ledger})`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
  return 0;
}

/** The project's task_from_branch, when there is a valid one. */
async function branchPattern(): Promise<RegExp | undefined> {
  const { findProject } = await import("../howl/project.ts");
  const found = findProject(process.cwd());
  try {
    return found?.taskFromBranch === undefined ? undefined : new RegExp(found.taskFromBranch);
  } catch {
    return undefined;
  }
}

async function statusCommand(args: string[]): Promise<number> {
  const { values } = parse(args, {
    ledger: { type: "string" },
    project: { type: "string" },
    json: { type: "boolean" },
    follow: { type: "boolean" },
  });
  const ledger = await ledgerToRead(values);
  const { statSync } = await import("node:fs");
  statSync(ledger);
  const { readAll } = await import("../read/reader.ts");
  const { agentStates, renderStatus } = await import("../read/state.ts");
  const taskFromBranch = await branchPattern();
  const rows = () => agentStates(readAll(ledger).map((r) => r.event), Date.now(), { taskFromBranch });
  if (values.json) {
    console.log(JSON.stringify(rows(), null, 2));
    return 0;
  }
  if (!values.follow) {
    console.log(renderStatus(rows(), Date.now()));
    return 0;
  }
  const clear = process.stdout.isTTY ? "\u001b[H\u001b[2J" : "";
  return await repeat(1, () => {
    process.stdout.write(`${clear}${renderStatus(rows(), Date.now())}\n`);
  }, () => {});
}

/** The code host of a project: from howl.yml, else from the remote origin. */
async function codeHost(found: import("../howl/project.ts").Project) {
  const { LedgerError } = await import("../ledger/errors.ts");
  const { originUrl } = await import("../howl/git.ts");
  const { originRepository, GitHub } = await import("../observe/github.ts");
  const { resolve } = await import("node:path");

  const origin = found.host === undefined || found.repository === undefined ? originRepository(originUrl(found.root)) : null;
  const host = found.host ?? origin?.host;
  if (host === "local") {
    if (found.local === undefined) throw new LedgerError("host: local needs local: <folder> in .howl/howl.yml");
    const { LocalHost } = await import("../observe/local.ts");
    return new LocalHost(resolve(found.root, found.local), found.repository ?? "local");
  }
  if (host === "github") {
    const repository = found.repository ?? origin?.repository;
    if (repository === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
      throw new LedgerError("no repository: set repository: <owner>/<name> in .howl/howl.yml");
    }
    return new GitHub({ repository, token: await githubToken() });
  }
  if (host === undefined) throw new LedgerError("no code host: set host: in .howl/howl.yml, or a remote origin at GitHub");
  throw new LedgerError(`no adapter for host: ${host}; there are github and local`);
}

/** A token with read access: $HOWL_GITHUB_TOKEN, else $GITHUB_TOKEN, else \`gh auth token\`. */
async function githubToken(): Promise<string> {
  const fromEnv = process.env.HOWL_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  const { spawnSync } = await import("node:child_process");
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  const token = gh.status === 0 ? gh.stdout.trim() : "";
  if (token) return token;
  const { LedgerError } = await import("../ledger/errors.ts");
  throw new LedgerError("no GitHub token: set HOWL_GITHUB_TOKEN or GITHUB_TOKEN, or sign in with gh auth login");
}

/**
 * Runs `once`, then again every `interval` seconds until the process is stopped;
 * with no interval, only once. `close` runs at the end, whatever happens.
 */
async function repeat(interval: number | null, once: () => void | Promise<void>, close: () => void): Promise<number> {
  if (interval === null) {
    try {
      await once();
    } finally {
      close();
    }
    return 0;
  }
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      await once();
      if (stopped) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, interval * 1000);
      });
    }
  } finally {
    close();
  }
  return 0;
}

function summary(pass: import("../inbox/ingest.ts").Pass): string {
  const parts = [`${pass.ledger} to the ledger`, `${pass.activity} to activity`, `${pass.expired} expired`, `${pass.rejected} rejected`];
  if (pass.duplicates > 0) parts.push(`${pass.duplicates} already in the ledger`);
  return parts.join(", ");
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

process.exitCode = await main(process.argv.slice(2));
