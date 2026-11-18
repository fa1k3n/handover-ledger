// The command `howl`. Each command loads only what it needs, so that `howl hook`
// starts quickly: it runs on every tool call of a session.
// @code_class recording
import { readFileSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { ACTIVITY_FILE, LEDGER_FILE } from "../ledger/names.ts";

const USAGE = `usage:
  howl verify [--project <name>] [--ledger <path>] [--issuer <fingerprint>] [--checkpoint <file | git>] [--signers <file>]
  howl verify --bundle <file> [--signers <file>]
  howl export (--change <id> | --task <id> | --since <time> --until <time>) [--out <file>]
  howl anchor [--project <name>] [--ledger <path>] [--to <git | file:path | ->] [--sign <ssh key>]
  howl key issue --actor <agent> [--task <id>] [--change <id>] [--role <name>] [--hours <n>]
  howl key revoke <key id>
  howl keyd [--project <name>] [--socket <path>] [--state <folder>]
  howl hook
  howl emit <type> [--task <id>] [--change <id>] [--data '<json object>']
  howl ingest [--project <name>] [--watch] [--interval <seconds>]
  howl observe [--once] [--interval <seconds>] [--since <date | now>] [--anchor-every <minutes>]
  howl up [--port <n>] [--interval <seconds>] [--since <date | now>] [--anchor-every <minutes>]
  howl watch [--since <time>] [--filter <field>=<value> ...] [--activity] [--utc] [--json] [--no-follow]
  howl show <task or change> [--utc] [--json]
  howl status [--follow] [--json]
  howl serve [--port <n>] [--all]
  howl classes [--check] [--json]
  howl trace [--at <commit>] [--check] [--json]

  verify    check every line of the ledger and the chain between the lines,
            then every signed claim against the key issued for it
  export    an evidence bundle (.tar.gz) of a change, a task or a period: the
            ledger up to its head, the lines selected, the timeline, what howl
            matched (inferred.json, not for a period), the checkpoints and a
            manifest; never the activity file or people.json.
            howl verify --bundle checks it offline
  anchor    keep the ledger's head outside this machine: a checkpoint (lines and
            head) as a commit on refs/howl/checkpoints, pushed to origin (the
            default), or in a file, or printed. --sign signs it with an SSH key
  key       issue a key for one assignment of an agent (8 hours by default),
            or revoke one. The private key goes to the session as HOWL_KEY;
            the hook then signs every event of the session. With HOWL_KEYD
            (keyd's socket) and HOWL_KEYD_ADMIN (its admin token file), keyd
            holds the key and the session gets a token instead
  keyd      a signing service that holds the keys, so a session never sees one.
            Run it as another user for the keys to be out of the sessions' reach
  hook      called by the hooks of Claude Code: hands an event to howl up
            when it runs, else leaves it in the inbox. Prints nothing and
            always ends with 0
  emit      an event from a script, delivered as the hook delivers one
  ingest    the one writer: bring the inbox into the ledger and the activity file
  observe   the one writer a team keeps running: each round brings the inbox in
            and records what happened at the code host since the last round.
            Read access is enough. GitHub: a token from $HOWL_GITHUB_TOKEN,
            else $GITHUB_TOKEN, else \`gh auth token\`
  up        observe and serve in one process, for a team to start once: the
            one writer of the project, the dashboard on http://127.0.0.1:4317
            and POST /api/events, where the hook and howl emit send their
            events while it runs. It says where it is, with a token, in
            server.json in the project's folder, and removes it when it stops.
            POST /api/hook takes the JSON of a hook of Claude Code as it
            stands, from a hook line that is only curl, and builds the event:
            no Node on the developer's side. Its token is the file token in
            the project's folder, made once and kept
  watch     print the events of the ledger, then follow them. --activity adds
            the tool calls of the activity file; a filter that names
            tool.used does too. A filter is a CEL expression over event:
            'event.type.startsWith("review.") && event.project == "a"';
            has(event.change) tests for a field. A field and a value still
            filter: type=review.*, actor=agent-1, kind=claimed, change=12.
            Colour unless NO_COLOR is set. Times
            in the local time zone (TZ), --utc as stored; --since without
            an offset is local time
  show      the timeline of one assignment, from the hand-over to the merge:
            12, task:12 or change:30. A change that is asked for is shown
            alone; the other changes of its task are named in one line
  status    one line per agent: NEEDS INPUT, working, waiting, idle or ended,
            what it works on, its model, its last tool and how long ago.
            NEEDS INPUT is a wait for a person, as a permission prompt; an
            agent that asks in the text of its answer looks done and shows
            as waiting. --follow redraws it every second
  serve     the dashboard on http://127.0.0.1:4317: the team right now and the
            event stream of the project (of the nearest howl.yml, or
            --project); --all serves every project, picked in the page, the
            project first; --ledger serves one ledger only. Read-only, on
            this machine only: a request that names another host is refused.
            Build the page first with npm run build:dashboard

  classes   the code class of every file git tracks, by path (classes in
            .howl/howl.yml) and from the file's header (class_header, in the
            files class_header_in matches); the higher one is in force.
            --check ends with 1 and names each file with no class by path,
            no header where one is needed, a header that names no class, or
            a header that differs from its path's class. Only reads
  trace     the requirements in the repository's Markdown tables
            (requirements_in in .howl/howl.yml) and the tests that name them
            (tests_in, test_pattern): a line per requirement, then the gaps.
            A test covers the requirement whose ID its name starts with and
            touches each ID in brackets; a comment line covers: or touches:
            counts for the next test. --check ends with 1 and names each
            built requirement by test that no test covers, each test that
            names an ID no table holds, and each ID given twice. --at reads
            one commit and nothing from the working tree. Only reads

watch, show, status, serve and verify also take --project <name> or --ledger <path>. They
only read: they take no lock and run while the writer appends.

The project is read from the nearest .howl/howl.yml, unless --project names it.
Its files are in $HOWL_HOME, else $XDG_STATE_HOME/howl, else ~/.local/state/howl,
in a folder named after the project: ${LEDGER_FILE}, ${ACTIVITY_FILE}, inbox/,
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
      await runHook(readFileSync(0, "utf8"), process.env, process.cwd());
    } catch {
      // Never disturb the session.
    }
    return 0;
  }

  try {
    switch (command) {
      case "verify":
        return await verifyCommand(rest);
      case "key":
        return await keyCommand(rest);
      case "keyd":
        return await keydCommand(rest);
      case "anchor":
        return await anchorCommand(rest);
      case "export":
        return await exportCommand(rest);
      case "emit":
        return await emitCommand(rest);
      case "ingest":
        return await ingestCommand(rest);
      case "observe":
        return await observeCommand(rest);
      case "up":
        return await upCommand(rest);
      case "watch":
        return await watchCommand(rest);
      case "show":
        return await showCommand(rest);
      case "status":
        return await statusCommand(rest);
      case "serve":
        return await serveCommand(rest);
      case "classes":
        return await classesCommand(rest);
      case "trace":
        return await traceCommand(rest);
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
  const { values } = parse(args, {
    project: { type: "string" },
    ledger: { type: "string" },
    issuer: { type: "string" },
    checkpoint: { type: "string" },
    signers: { type: "string" },
    bundle: { type: "string" },
  });
  // #19: a bundle is checked on its own, offline.
  if (values.bundle !== undefined) {
    const { verifyBundle } = await import("../export/export.ts");
    const r = verifyBundle(readFileSync(values.bundle), values.signers);
    console.log(values.bundle);
    for (const m of r.messages) console.log(m);
    console.log(r.ok ? "ok: the bundle holds" : "the bundle does not hold");
    if (r.trial) console.log("a trial: it does not count as evidence");
    return r.ok ? 0 : 1;
  }
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
  // #23: the signed claims, held to the keys issued for them.
  const { checkSignatures } = await import("../keys/keys.ts");
  if (values.issuer !== undefined && !/^[0-9a-f]{64}$/.test(values.issuer)) throw new UsageError("--issuer must be a key id: 64 hex digits");
  const { ledgerLines } = await import("../read/reader.ts");
  const lines = ledgerLines(path, { first: true }).map((r) => ({ n: r.n!, event: r.event }));
  const sigs = checkSignatures(lines, values.issuer);
  console.log(`signatures: ${sigs.signed} signed, ${sigs.unsigned} unsigned claimed${sigs.issuer ? `, issuer ${sigs.issuer}` : ""}`);
  for (const f of sigs.faults) console.log(`line ${f.line}: ${f.reason}`);
  let failed = sigs.faults.length > 0;
  // #18: the head held against a checkpoint kept elsewhere.
  if (values.checkpoint !== undefined) {
    const anchor = await import("../anchor/anchor.ts");
    const kept = values.checkpoint === "git" ? anchor.checkpointFromGit(process.cwd()) : readCheckpointFile(values.checkpoint);
    if (values.signers !== undefined) {
      if (kept.sig === undefined || !anchor.signatureHolds(kept.text, kept.sig, values.signers)) {
        console.log("checkpoint: its signature does not hold for the allowed signers");
        failed = true;
      }
    }
    const c = JSON.parse(kept.text) as import("../anchor/anchor.ts").Checkpoint;
    const result = anchor.checkLedger(path, c);
    console.log(result.message);
    if (!result.ok) failed = true;
  }
  return failed ? 1 : 0;
}

/** A checkpoint kept in a file, with its signature beside it (`<file>.sig`) when there is one. */
function readCheckpointFile(file: string): { text: string; sig?: string } {
  const text = readFileSync(file, "utf8");
  let sig: string | undefined;
  try {
    sig = readFileSync(`${file}.sig`, "utf8");
  } catch {
    sig = undefined;
  }
  return { text, sig };
}

/** howl's own version, for a checkpoint. */
function version(): string {
  return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

async function exportCommand(args: string[]): Promise<number> {
  const { values } = parse(args, {
    project: { type: "string" },
    ledger: { type: "string" },
    change: { type: "string" },
    task: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    out: { type: "string" },
  });
  const chosen = [values.change !== undefined, values.task !== undefined, values.since !== undefined || values.until !== undefined].filter(Boolean).length;
  if (chosen !== 1) throw new UsageError("export needs one of --change, --task, or --since with --until");
  if ((values.since === undefined) !== (values.until === undefined)) throw new UsageError("--since and --until go together");
  const ledger = await ledgerToRead(values);
  const { buildBundle } = await import("../export/export.ts");
  const { writeTar } = await import("../export/tar.ts");
  const { writeFileSync } = await import("node:fs");
  const selection =
    values.change !== undefined
      ? { kind: "change" as const, id: values.change }
      : values.task !== undefined
        ? { kind: "task" as const, id: values.task }
        : { since: values.since!, until: values.until! };
  const files = buildBundle(ledger, selection, { version: version(), repo: process.cwd() });
  const name = values.change ?? values.task ?? new Date().toISOString().slice(0, 10);
  const out = values.out ?? `howl-${values.change !== undefined ? "change" : values.task !== undefined ? "task" : "period"}-${name}.tar.gz`;
  writeFileSync(out, writeTar(files, true));
  console.log(`${out}: ${files.size} files; check it with howl verify --bundle ${out}`);
  if (JSON.parse(files.get("manifest.json")!.toString()).trial === true) console.log("a trial: it does not count as evidence");
  return 0;
}

async function anchorCommand(args: string[]): Promise<number> {
  const { values } = parse(args, { project: { type: "string" }, ledger: { type: "string" }, to: { type: "string" }, sign: { type: "string" } });
  const ledger = await ledgerToRead(values);
  const anchor = await import("../anchor/anchor.ts");
  const c = anchor.checkpointOf(ledger, version());
  const text = anchor.checkpointText(c);
  const sig = values.sign === undefined ? undefined : anchor.signText(text, values.sign);
  const to = values.to ?? "git";
  if (to === "-") {
    process.stdout.write(text);
    if (sig !== undefined) process.stderr.write(sig);
    return 0;
  }
  if (to.startsWith("file:")) {
    const { writeFileSync } = await import("node:fs");
    const file = to.slice("file:".length);
    writeFileSync(file, text);
    if (sig !== undefined) writeFileSync(`${file}.sig`, sig);
    console.log(`checkpoint: ${c.lines} lines, head ${c.head} → ${file}`);
    return 0;
  }
  if (to !== "git") throw new UsageError(`--to ${to}: give git, file:<path> or -`);
  const r = anchor.anchorToGit(process.cwd(), c, text, sig);
  console.log(`checkpoint: ${c.lines} lines, head ${c.head} → ${anchor.REF} ${r.commit.slice(0, 12)}${r.pushed ? ", pushed to origin" : ", not pushed: no origin"}`);
  return 0;
}

async function keyCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { values, positionals } = parse(
    rest,
    {
      project: { type: "string" },
      actor: { type: "string" },
      task: { type: "string" },
      change: { type: "string" },
      role: { type: "string" },
      hours: { type: "string" },
    },
    1,
  );
  const { findProject } = await import("../howl/project.ts");
  const { configDir, inboxPath, projectDir } = await import("../ledger/place.ts");
  const { leave } = await import("../inbox/inbox.ts");
  const { issueKey, revokeKey } = await import("../keys/keys.ts");
  const { join } = await import("node:path");
  const project = values.project ?? findProject(process.cwd())?.project;
  if (project === undefined) throw new UsageError("key needs --project, or a .howl/howl.yml above the working directory");
  const places = { configDir: configDir(project), keysDir: join(projectDir(project), "keys") };
  // #24: through keyd when it runs: it holds the keys; the session gets a token.
  const keyd = process.env.HOWL_KEYD;
  if (keyd) {
    const { request } = await import("../keys/keyd.ts");
    const adminFile = process.env.HOWL_KEYD_ADMIN ?? join(places.configDir, "keyd", "admin.token");
    const admin = readFileSync(adminFile, "utf8").trim();
    const { LedgerError } = await import("../ledger/errors.ts");
    if (sub === "issue") {
      if (!values.actor) throw new UsageError("key issue needs --actor");
      const a = await request(keyd, {
        op: "issue",
        admin,
        actor: values.actor,
        task: values.task,
        change: values.change,
        role: values.role,
        hours: values.hours === undefined ? 8 : Number(values.hours),
      });
      if (!a.ok) throw new LedgerError(`keyd refused: ${a.error}`);
      leave(inboxPath(project), a.event as import("../ledger/schema.ts").LedgerEvent);
      console.log(`key ${a.key} for ${values.actor}, held by keyd`);
      console.log(`HOWL_KEY=keyd:${keyd}#${a.key}:${a.token}`);
      return 0;
    }
    if (sub === "revoke") {
      const [keyId] = positionals;
      if (!keyId) throw new UsageError("key revoke needs a key id");
      const a = await request(keyd, { op: "revoke", admin, key: keyId });
      if (!a.ok) throw new LedgerError(`keyd refused: ${a.error}`);
      leave(inboxPath(project), a.event as import("../ledger/schema.ts").LedgerEvent);
      console.log(`key ${keyId} revoked by keyd`);
      return 0;
    }
  }
  if (sub === "issue") {
    if (!values.actor) throw new UsageError("key issue needs --actor");
    const r = issueKey(
      project,
      { actor: values.actor, task: values.task, change: values.change, role: values.role, hours: values.hours === undefined ? 8 : Number(values.hours) },
      places,
    );
    leave(inboxPath(project), r.event);
    if (r.issuerMade) console.log(`a new issuer key for ${project}: ${r.issuerId}. Keep this fingerprint somewhere else.`);
    console.log(`key ${r.keyId} for ${values.actor}`);
    console.log(`HOWL_KEY=${r.file}`);
    return 0;
  }
  if (sub === "revoke") {
    const [keyId] = positionals;
    if (!keyId) throw new UsageError("key revoke needs a key id");
    leave(inboxPath(project), revokeKey(project, keyId, places));
    console.log(`key ${keyId} revoked`);
    return 0;
  }
  throw new UsageError("key needs issue or revoke");
}

async function keydCommand(args: string[]): Promise<number> {
  const { values } = parse(args, { project: { type: "string" }, socket: { type: "string" }, state: { type: "string" } });
  const { findProject } = await import("../howl/project.ts");
  const { configDir, projectDir } = await import("../ledger/place.ts");
  const { join } = await import("node:path");
  const project = values.project ?? findProject(process.cwd())?.project;
  if (project === undefined) throw new UsageError("keyd needs --project, or a .howl/howl.yml above the working directory");
  const socket = values.socket ?? (process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, `howl-${project}.sock`) : join(projectDir(project), "keyd.sock"));
  const state = values.state ?? join(configDir(project), "keyd");
  const signal = stopSignal();
  const { startKeyd } = await import("../keys/keyd.ts");
  const server = await startKeyd(project, socket, state);
  console.log(`howl keyd: ${socket}, keys in ${state}; admin token in ${join(state, "admin.token")}`);
  await new Promise<void>((resolve) => {
    if (signal.stopped) return resolve();
    signal.wake = resolve;
  });
  signal.off();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
    await emit({ type, ...values }, process.env, process.cwd());
    return 0;
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    console.error(`howl: ${e.message}`);
    return 1;
  }
}

async function ingestCommand(args: string[]): Promise<number> {
  const signal = stopSignal();
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

  return await repeat(values.watch ? interval : null, once, () => writer.close(), signal);
}

async function observeCommand(args: string[]): Promise<number> {
  const signal = stopSignal();
  const { values } = parse(args, {
    once: { type: "boolean" },
    interval: { type: "string" },
    since: { type: "string" },
    "anchor-every": { type: "string" },
  });
  const o = await observing("observe", values);
  return await repeat(values.once ? null : o.interval, o.once, () => o.writer.close(), signal);
}

/**
 * What `howl observe` and `howl up` share: the one writer of the project of
 * the working directory, held until its `writer` is closed, and one round.
 */
async function observing(command: "observe" | "up", values: { once?: boolean; interval?: string; since?: string; "anchor-every"?: string }) {
  const anchorEvery = values["anchor-every"] === undefined ? null : Number(values["anchor-every"]);
  if (anchorEvery !== null && !(anchorEvery > 0)) throw new UsageError("--anchor-every must be a number of minutes above 0");
  const { findProject, agentsProblems, settingPattern } = await import("../howl/project.ts");
  const { activityPath, cursorPath, inboxPath, ledgerPath, peoplePath } = await import("../ledger/place.ts");
  const { openLedger } = await import("../ledger/ledger.ts");
  const { People } = await import("../observe/people.ts");
  const { Observer } = await import("../observe/observe.ts");
  const { LedgerError } = await import("../ledger/errors.ts");

  const found = findProject(process.cwd());
  if (!found) throw new UsageError(`${command} needs a .howl/howl.yml above the working directory`);
  // #46: a list of agents that cannot be read as meant is refused before anything is written: a wrong entry would
  // write an agent as a person, in a ledger that cannot be mended.
  const faults = agentsProblems(found);
  if (faults.length > 0) throw new LedgerError(`${command} does not start: ${faults.join("; ")}`);
  const interval = values.interval === undefined ? 60 : Number(values.interval);
  if (!(interval > 0)) throw new UsageError("--interval must be a number of seconds above 0");
  // #41: said before anything is written; the one place that compiles them is project.ts.
  settingPattern(found, "task_from_branch");
  settingPattern(found, "review_comment_pattern");
  // #6: where the first round starts. Only without a cursor: it says where to go on.
  let start: string | undefined;
  if (values.since !== undefined) {
    const { existsSync } = await import("node:fs");
    if (existsSync(cursorPath(found.project))) {
      throw new UsageError(`--since is for the first round only: ${cursorPath(found.project)} already says where to go on`);
    }
    const text = values.since === "now" ? new Date().toISOString() : /^\d{4}-\d{2}-\d{2}$/.test(values.since) ? `${values.since}T00:00:00Z` : values.since;
    const time = /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : Number.NaN;
    if (Number.isNaN(time)) throw new UsageError(`--since ${values.since}: give a date (2026-11-01), a time in UTC or now`);
    start = new Date(time).toISOString();
  }
  const host = await codeHost(found);

  const { project } = found;
  const places = { project, inbox: inboxPath(project), activity: activityPath(project) };
  const writer = openLedger(ledgerPath(project), { project });
  let observer;
  try {
    observer = new Observer({
      host,
      writer,
      ledgerPath: ledgerPath(project),
      places,
      cursorPath: cursorPath(project),
      people: new People(peoplePath(project)),
      settings: found,
      warn: (message) => console.error(`howl: ${message}`),
      start,
      // #38: the tests of a head, read from the repository this runs in. Nothing without the settings of `howl trace`.
      traceAt: await traceReader(found.root),
    });
  } catch (e) {
    writer.close();
    throw e;
  }
  // #64: the lines written between two rounds, for an event that came in over HTTP: a round's checkpoint covers them.
  let wroteBetween = 0;
  const once = async () => {
    const round = await observer.round();
    const pass = round.ingested;
    if (round.appended > 0 || values.once || pass.ledger + pass.activity + pass.rejected > 0) {
      console.log(`${round.appended} from ${host.name}; inbox: ${summary(pass)}${round.complete ? "" : "; some calls failed, read again next round"}`);
    }
    if (pass.rejected > 0) console.error(`howl: ${pass.rejected} rejected, see ${inboxPath(project)}/rejected`);
    // #18: a checkpoint after a round that wrote lines, at most once per --anchor-every minutes.
    const sent = wroteBetween;
    wroteBetween = 0;
    if (anchorEvery !== null && round.appended + pass.ledger + sent > 0) {
      const { existsSync, readFileSync: read, writeFileSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      const marker = join(dirname(ledgerPath(project)), "anchor.json");
      const last = existsSync(marker) ? Date.parse((JSON.parse(read(marker, "utf8")) as { at: string }).at) : 0;
      if (Date.now() - last >= anchorEvery * 60_000) {
        try {
          const anchor = await import("../anchor/anchor.ts");
          const c = anchor.checkpointOf(ledgerPath(project), version());
          anchor.anchorToGit(found.root, c, anchor.checkpointText(c));
          writeFileSync(marker, `${JSON.stringify({ at: new Date().toISOString(), lines: c.lines, head: c.head })}\n`);
          console.log(`checkpoint: ${c.lines} lines, head ${c.head.slice(0, 12)}`);
        } catch (e) {
          console.error(`howl: no checkpoint this round: ${(e as Error).message}`);
        }
      }
    }
  };
  return { found, project, places, writer, interval, once, wrote: (lines: number) => void (wroteBetween += lines) };
}

/**
 * #64: `howl observe` and `howl serve` in one process, and the way in for the
 * events of the hook and of `howl emit` while it runs.
 */
async function upCommand(args: string[]): Promise<number> {
  const signal = stopSignal();
  const { values } = parse(args, {
    port: { type: "string" },
    interval: { type: "string" },
    since: { type: "string" },
    "anchor-every": { type: "string" },
  });
  const port = values.port === undefined ? 4317 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port must be a port number");
  const { randomBytes } = await import("node:crypto");
  const { chmodSync, existsSync, readFileSync: read, rmSync, writeFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { leave } = await import("../inbox/inbox.ts");
  const { ingestPass } = await import("../inbox/ingest.ts");
  const { LedgerError } = await import("../ledger/errors.ts");
  const { howlHome, projectDir, serverPath, tokenPath } = await import("../ledger/place.ts");
  const { join } = await import("node:path");
  const { startServer } = await import("../serve/server.ts");

  // The writer first: a second `howl up` or `howl observe` of the project is refused here, before anything else.
  const o = await observing("up", values);
  // An event that comes in is left in the inbox, as a hook leaves one, and the inbox is taken in at once:
  // those that come together in one pass. The old activity lines are left for the rounds.
  let soon: NodeJS.Timeout | undefined;
  const takeIn = () => {
    soon = undefined;
    try {
      const pass = ingestPass(o.places, o.writer, o.found.activityDays, Date.now(), { expire: false });
      o.wrote(pass.ledger);
      if (pass.rejected > 0) console.error(`howl: ${pass.rejected} rejected, see ${o.places.inbox}/rejected`);
    } catch (e) {
      console.error(`howl: the inbox was not taken in: ${(e as Error).message}`);
    }
  };
  const token = randomBytes(32).toString("hex");
  const file = serverPath(o.project);
  // #67: a token that lasts, for a hook line that is written once: made the first time, and kept.
  // The file holds the header line itself: `curl` reads it, and the token stands on no command line.
  const { tokenLine, tokenOfLine } = await import("../hook/line.ts");
  const lasting = (): string => {
    const path = tokenPath(o.project);
    try {
      const kept = tokenOfLine(read(path, "utf8"));
      if (kept !== null) {
        chmodSync(path, 0o600);
        return kept;
      }
    } catch {
      // Not there, or not to be read: a new one.
    }
    const made = randomBytes(32).toString("hex");
    // A file that holds no token is replaced. A folder of that name is not howl's to remove.
    try {
      rmSync(path, { force: true });
      writeFileSync(path, tokenLine(made), { mode: 0o600, flag: "wx" });
    } catch (e) {
      throw new LedgerError(`${path}: the token cannot be written there: ${(e as Error).message}`);
    }
    return made;
  };
  const root = fileURLToPath(new URL("../../dist/dashboard", import.meta.url));
  let server;
  try {
    server = await startServer({
      home: howlHome(),
      defaultProject: o.project,
      port,
      root,
      agents: await knownAgents(),
      write: {
        project: o.project,
        tokens: [token, lasting()],
        take: (event) => {
          try {
            leave(o.places.inbox, event);
          } catch (e) {
            // The sender is told 500; the one who runs the server is told why.
            console.error(`howl: an event that came in was not kept: ${(e as Error).message}`);
            throw e;
          }
          soon ??= setTimeout(takeIn, 50);
        },
      },
    });
    // The lock is held, so what is there was left by a server that did not stop cleanly: its file,
    // and the mark that it did not answer, which would keep the hooks from asking this one.
    rmSync(file, { force: true, recursive: true });
    rmSync(join(projectDir(o.project), "server.down"), { force: true, recursive: true });
    writeFileSync(file, `${JSON.stringify({ url: server.url, token, pid: process.pid })}\n`, { mode: 0o600, flag: "wx" });
  } catch (e) {
    signal.off();
    o.writer.close();
    await server?.close();
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new LedgerError(`port ${port} is taken: is howl serve or another howl up running? Give another with --port`);
    }
    throw e;
  }
  console.log(`howl up: ${server.url} (the writer of ${o.project}; every project in ${howlHome()} is shown, read-only)`);
  // #102: the other projects are shown and not written by this process: say which of them has events waiting,
  // also one that has no ledger yet.
  {
    const { projectsWriting, writingLine } = await import("../read/writing.ts");
    for (const p of projectsWriting(howlHome())) {
      if (p.name === o.project) continue;
      const line = writingLine(p.name, p, Date.now());
      if (line !== null) console.log(line);
    }
  }
  if (!existsSync(`${root}/index.html`)) {
    console.error("howl: the page is not built (npm run build:dashboard): the writer and the API run without it");
  }
  try {
    return await repeat(o.interval, o.once, () => {}, signal);
  } finally {
    // The file first, so that no hook sends to a server that is closing.
    rmSync(file, { force: true });
    await server.close();
    clearTimeout(soon);
    try {
      ingestPass(o.places, o.writer, o.found.activityDays, Date.now(), { expire: false });
    } catch {
      // What is left in the inbox is taken in by the next writer.
    }
    o.writer.close();
  }
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
    utc: { type: "boolean" },
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
        utc: values.utc ?? false,
        follow: !values["no-follow"],
        interval,
        colour,
      },
      (line) => process.stdout.write(`${line}\n`),
      (line) => console.error(`howl: ${line}`),
    );
  } catch (e) {
    if (e instanceof LedgerError) throw new UsageError(e.message);
    throw e;
  }
  return 0;
}

async function showCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    args,
    { ledger: { type: "string" }, project: { type: "string" }, json: { type: "boolean" }, utc: { type: "boolean" } },
    1,
  );
  const [what] = positionals;
  if (what === undefined) throw new UsageError("show needs a task or a change: 12, task:12 or change:30");
  const ledger = await ledgerToRead(values);
  const { activityFrom, readAll } = await import("../read/reader.ts");
  const { parseAsked, render, show } = await import("../read/show.ts");
  const reads = readAll(ledger);
  const shown = show(
    reads.map((r) => r.event),
    parseAsked(what),
    activityFrom(reads),
  );
  if (shown === null) {
    console.error(`howl: nothing in the ledger names ${what}`);
    return 1;
  }
  console.log(values.json ? JSON.stringify(shown, null, 2) : render(shown, { utc: values.utc ?? false }));
  return 0;
}

async function classesCommand(args: string[]): Promise<number> {
  const { values } = parse(args, { check: { type: "boolean" }, json: { type: "boolean" } });
  const { findClasses, classify } = await import("../howl/classes.ts");
  const settings = findClasses(process.cwd());
  if (settings === null) throw new UsageError("no classes in .howl/howl.yml");
  const report = classify(settings);
  const summary = Object.entries(report.counts)
    .map(([name, n]) => `${name}: ${n}`)
    .join(", ");
  if (values.json) {
    console.log(JSON.stringify(values.check ? report : { files: report.files }, null, 2));
  } else if (values.check) {
    for (const problem of report.problems) console.log(problem);
    if (report.problems.length === 0) console.log(`ok: ${report.files.length} files; ${summary}`);
  } else {
    for (const f of report.files) {
      console.log(`${f.file}  ${f.class ?? "-"}  (path ${f.path ?? "-"}, header ${f.header ?? "-"})`);
    }
  }
  return values.check && report.problems.length > 0 ? 1 : 0;
}

async function traceCommand(args: string[]): Promise<number> {
  const { values } = parse(args, { at: { type: "string" }, check: { type: "boolean" }, json: { type: "boolean" } });
  const { countsLine, findTrace, gapLine, trace, traceRoot, treeAt, workingTree } = await import("../howl/trace.ts");
  const root = traceRoot(process.cwd());
  if (root === null) throw new UsageError("no requirements_in in .howl/howl.yml");
  const source = values.at === undefined ? workingTree(root) : treeAt(root, values.at);
  if (source.at !== null && source.read(".howl/howl.yml") === null) {
    const { LedgerError } = await import("../ledger/errors.ts");
    throw new LedgerError(`no .howl/howl.yml at ${source.at}`);
  }
  const settings = findTrace(root, source);
  if (settings === null) throw new UsageError("no requirements_in in .howl/howl.yml");
  const report = trace(settings, source);
  const gaps = report.gaps.map((gap) => gapLine(gap, report));
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (values.check) {
    for (const gap of gaps) console.log(gap);
    if (gaps.length === 0) console.log(`ok: ${countsLine(report)}`);
  } else {
    const width = (texts: string[]) => Math.max(0, ...texts.map((t) => t.length));
    const ids = width(report.requirements.map((r) => r.id));
    const methods = width(report.requirements.map((r) => r.method ?? ""));
    const statuses = width(report.requirements.map((r) => r.status ?? ""));
    for (const r of report.requirements) {
      const n = r.covered_by.length;
      const tests = !r.by_test ? "-" : n === 0 ? "no test" : `${n} test${n === 1 ? "" : "s"}`;
      const columns = [r.id.padEnd(ids), ...(methods > 0 ? [(r.method ?? "").padEnd(methods)] : []), ...(statuses > 0 ? [(r.status ?? "").padEnd(statuses)] : []), tests];
      console.log(columns.join("  "));
    }
    const n = gaps.length;
    console.log(`\n${countsLine(report)}, ${n === 0 ? "no gap" : `${n} gap${n === 1 ? "" : "s"}`}, ${report.at === null ? "in the working tree" : `at ${report.at.slice(0, 12)}`}`);
    if (n > 0) console.log("");
    for (const gap of gaps) console.log(gap);
  }
  return values.check && gaps.length > 0 ? 1 : 0;
}

/**
 * #38: the reading of a commit's tests for the observer, in a process of its own with a time limit. The settings of
 * the working tree only say whether to read at all, and are looked at for each head: a team that adds them while
 * `howl up` runs is read from the next head. A fault in them is said once.
 */
async function traceReader(root: string) {
  const { findTrace } = await import("../howl/trace.ts");
  const { readTrace } = await import("../howl/trace-read.ts");
  let said = false;
  return (sha: string): import("../howl/trace-read.ts").TraceResult => {
    try {
      if (findTrace(root) === null) return { state: "never", why: "no settings", quiet: true };
    } catch (e) {
      if (!said) console.error(`howl: the settings of howl trace in .howl/howl.yml cannot be read, so no head is read against a requirement: ${(e as Error).message}`);
      said = true;
      return { state: "never", why: "settings", quiet: true };
    }
    return readTrace(root, sha);
  };
}

async function serveCommand(args: string[]): Promise<number> {
  const { values } = parse(args, { ledger: { type: "string" }, project: { type: "string" }, all: { type: "boolean" }, port: { type: "string" } });
  const port = values.port === undefined ? 4317 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port must be a port number");
  if (values.ledger !== undefined && values.all) throw new UsageError("give --ledger or --all, not both");
  // #54: one project unless --all asks for every one; the project is found before anything is started.
  const { howlHome, isProjectName } = await import("../ledger/place.ts");
  const { findProject } = await import("../howl/project.ts");
  if (values.project !== undefined && !isProjectName(values.project)) throw new UsageError(`no project ${values.project}`);
  const project = values.ledger === undefined ? (values.project ?? findProject(process.cwd())?.project) : undefined;
  if (values.ledger === undefined && !values.all && project === undefined) {
    throw new UsageError("no project here: no howl.yml above this folder. Give --project <name> for one project, or --all for every project");
  }
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../dist/dashboard", import.meta.url));
  if (!existsSync(`${root}/index.html`)) {
    const { LedgerError } = await import("../ledger/errors.ts");
    throw new LedgerError(`no built dashboard in ${root}: run npm run build:dashboard first`);
  }
  const { startServer } = await import("../serve/server.ts");
  const agents = await knownAgents(values);
  let server;
  if (values.ledger !== undefined) {
    const { statSync } = await import("node:fs");
    statSync(values.ledger);
    server = await startServer({ ledger: values.ledger, port, root, agents });
    console.log(`howl serve: ${server.url} (read-only, ${values.ledger})`);
  } else if (values.all) {
    // Every project of the howl home; first the one asked for, else that of the nearest howl.yml.
    const home = howlHome();
    const defaultProject = project;
    server = await startServer({ home, defaultProject, port, root, agents });
    console.log(`howl serve: ${server.url} (read-only, every project in ${home}${defaultProject ? `, ${defaultProject} first` : ""})`);
  } else {
    // #54: the one project, and no other.
    const home = howlHome();
    server = await startServer({ home, project, port, root, agents });
    console.log(`howl serve: ${server.url} (read-only, the project ${project} in ${home})`);
  }
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
  return 0;
}

/**
 * #46: the names of the agents of the project that is read, for the gap "not a known agent". Only the project of the
 * working directory has its settings at hand: for another project, or a ledger named by its path, none. A list that
 * is refused gives none, and is said once.
 */
async function knownAgents(reading: { project?: string; ledger?: string } = {}): Promise<ReadonlySet<string> | undefined> {
  if (reading.ledger !== undefined) return undefined;
  const { findProject, agentsProblems, agentNames } = await import("../howl/project.ts");
  const found = findProject(process.cwd());
  if (found === null || (reading.project !== undefined && reading.project !== found.project)) return undefined;
  const faults = agentsProblems(found);
  if (faults.length > 0) {
    console.error(`howl: the settings of agents in .howl/howl.yml are refused, so no gap "not a known agent" is shown:\n${faults.map((f) => `  ${f}`).join("\n")}`);
    return undefined;
  }
  return agentNames(found.agents);
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
  const agents = await knownAgents(values);
  const rows = () => agentStates(readAll(ledger).map((r) => r.event), Date.now(), { agents });
  if (values.json) {
    console.log(JSON.stringify(rows(), null, 2));
    return 0;
  }
  // #102: said when events wait in the project's inbox and nothing writes them.
  const { writingLine, writingOf } = await import("../read/writing.ts");
  const { basename, dirname } = await import("node:path");
  const unwritten = () => writingLine(basename(dirname(ledger)), writingOf(ledger), Date.now());
  if (!values.follow) {
    console.log(renderStatus(rows(), Date.now()));
    const line = unwritten();
    if (line !== null) console.log(`\n${line}`);
    return 0;
  }
  const clear = process.stdout.isTTY ? "\u001b[H\u001b[2J" : "";
  return await repeat(1, () => {
    const line = unwritten();
    process.stdout.write(`${clear}${renderStatus(rows(), Date.now())}\n${line === null ? "" : `\n${line}\n`}`);
  }, () => {});
}

/** The code host of a project: from howl.yml, else from the remote origin. */
async function codeHost(found: import("../howl/project.ts").Project) {
  const { LedgerError } = await import("../ledger/errors.ts");
  const { settingPattern } = await import("../howl/project.ts");
  const { originUrl } = await import("../howl/git.ts");
  const { originRepository, GitHub } = await import("../observe/github.ts");
  const { resolve } = await import("node:path");

  const reviewCommentPattern = settingPattern(found, "review_comment_pattern");
  const origin = found.host === undefined || found.repository === undefined ? originRepository(originUrl(found.root)) : null;
  const host = found.host ?? origin?.host;
  if (host === "local") {
    if (found.local === undefined) throw new LedgerError("host: local needs local: <folder> in .howl/howl.yml");
    const { LocalHost } = await import("../observe/local.ts");
    return new LocalHost(resolve(found.root, found.local), found.repository ?? "local", reviewCommentPattern);
  }
  if (host === "github") {
    const repository = found.repository ?? origin?.repository;
    if (repository === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
      throw new LedgerError("no repository: set repository: <owner>/<name> in .howl/howl.yml");
    }
    return new GitHub({ repository, token: await githubToken(), reviewCommentPattern });
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
 * A stop asked for by SIGINT or SIGTERM, listened for from the moment it is made:
 * made before a writer takes the lock, a signal in between is never the
 * default kill that leaves the lock behind (#7).
 */
function stopSignal() {
  const s = { stopped: false, wake: undefined as (() => void) | undefined, off: () => {} };
  const stop = () => {
    s.stopped = true;
    s.wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  s.off = () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
  return s;
}

/**
 * Runs `once`, then again every `interval` seconds until the process is stopped;
 * with no interval, only once. `close` runs at the end, whatever happens.
 */
async function repeat(
  interval: number | null,
  once: () => void | Promise<void>,
  close: () => void,
  signal: ReturnType<typeof stopSignal> = stopSignal(),
): Promise<number> {
  if (interval === null) {
    try {
      if (!signal.stopped) await once();
    } finally {
      signal.off();
      close();
    }
    return 0;
  }
  // #7: the wait's timer is cleared when stopped, so the process ends at once instead of after the interval.
  let timer: NodeJS.Timeout | undefined;
  try {
    while (!signal.stopped) {
      await once();
      if (signal.stopped) break;
      await new Promise<void>((resolve) => {
        signal.wake = () => {
          clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(resolve, interval * 1000);
      });
    }
  } finally {
    clearTimeout(timer);
    signal.off();
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
