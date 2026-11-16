<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo-light.svg" width="96" height="96" alt="The mark of Handover Ledger: two overlapping rounded squares, the overlap filled">
  </picture>
</p>

# Handover Ledger

Audit-ready ledger of handovers in mixed teams of people and AI agents. The command is `howl`.

**Status: early, and a trial.** This is version 0. The event schema may still change, nothing is published as a package, and a ledger written today is not evidence. What is built runs from a checkout, beside a team whose agents already work, and only records ([docs/observation.md](docs/observation.md)). The levels of autonomy and the rules around them are written down, not built.

## The idea in short

Teams in regulated development want to use AI agents but cannot show an assessor who did what, with which model, under which rules, and who checked it. Handover Ledger is a platform that

- runs in the team's own environment (their code host, tracker, requirements tool and model),
- lets the team get used to agents one level at a time, from agents that only review what people write to agents that do nearly everything,
- keeps the process and its trace chain the same at every level, so only *who performs each step* changes,
- records every handover between team members, human or agent, in a tamper-evident ledger that can be exported as evidence for a standard.

The method is the offer. The tool makes the method binding and measurable.

## The parts

| Part | Does | Built today | Planned |
|---|---|---|---|
| `ledger` (core) | The event schema, the hash chain, the one writer | The schema (version 0), the chain, signed claims, checkpoints | Rules and levels |
| Adapters | Read what happened in the team's tools and turn it into events | The hooks of Claude Code, GitHub (read only), and a code host kept in local files, which the tests use | GitLab, a tracker, a requirements tool |
| `howl` (CLI) | Records, checks and reads | `hook`, `ingest`, `emit`, `observe`, `up`, `verify`, `watch`, `show`, `status`, `serve`, `key`, `keyd`, `anchor`, `export` | `howl init`, a `howl` that needs no Node |
| Dashboard | Views over the ledger; it never writes | The overview, which starts with the team right now; the event log of every project; one change or task | The rest of the design, when the ledger holds its data |
| VS Code extension | The team and the chain per change, in the editor | Nothing | All of it, when someone asks for it |

One repository, TypeScript throughout. The order of the work is in [docs/decisions.md](docs/decisions.md), and each step is an issue.

## Running it

Node 24 or later is needed to build and test. A `howl` that needs no Node on the developer's machine comes later. Nothing installs a `howl` command yet: where an example below says `howl`, run `npm run howl --` in this checkout, or `node /path/to/handover-ledger/src/cli/howl.ts` from another folder.

```sh
npm install
npm test            # every test
npm run check       # type check, generated types up to date, every test
```

The dashboard is a page built with React and Tailwind; howl serves it on this machine only and reads the ledger without writing:

```sh
npm run build:dashboard                         # into dist/dashboard, at most 300 kB gzipped
npm run howl -- serve --project example         # http://127.0.0.1:4317, every project, example first
npm run dev:dashboard                           # while working on the page, beside a running howl serve
```

The event log of the page is one list of every project the server serves, in the order of time. Tool calls are in it when the box "Show tool calls" is ticked, or when a filter names `tool.used`. The filter line starts empty, and "Clear" empties it. A filter is a CEL expression over `event` (see `howl watch` below), and a click anywhere on a row opens the event in a dialog: what the page reads of it on the left, the line as it is stored on the right, to be held against each other. "Copy line" copies the line byte for byte, "Older" and "Newer" and the arrow keys step through the list, and "Show only this" beside the project or the repository adds it to the filter. A column for the project shows when more than one is served, and one for the repository when the rows come from more than one. The list is a view: each project keeps its own ledger and its own chain, so a line number and a hash are named with their project. The team, the overview and one change are shown for the project picked in the menu.

A line of the ledger is `{"prev", "hash", "event"}`. The event does not know its place: `prev` and `hash` belong to the line ([schema/line.v0.schema.json](schema/line.v0.schema.json)). `hash` is the SHA-256 of the event in its fixed form, the JSON Canonicalization Scheme (RFC 8785), and the event stands in the line in that form.

`howl verify` checks every line: it is JSON, it follows the line schema, its event follows [schema/event.v0.schema.json](schema/event.v0.schema.json), `hash` is the hash of the event, and `prev` is the SHA-256 of the line before.

The schema holds only what something writes. Seven types (`tests.written`, `finding.fixed`, `finding.dismissed`, `finding.left_open`, `level.changed`, `rule.broken`, `escalation.raised`) and seven fields (`requirements`, `clauses`, `tests`, `level`, `class`, `rules`, `team`) of the first draft were removed on 2026-11-14: no step wrote them. Each comes back with the step that writes it. A ledger that holds one of them no longer verifies, and `howl verify` names the line.

```sh
npm run howl -- verify --project example       # the ledger of a project
npm run howl -- verify --ledger path/to/ledger.jsonl
```

It ends with 0 when the ledger holds, 1 when it does not, naming the first line that fails and why, and 2 when there is no ledger to read. It writes nothing and takes no lock.

The ledger of a project lies in `$HOWL_HOME`, else `$XDG_STATE_HOME/howl`, else `~/.local/state/howl`, as `<project>/ledger.jsonl`. Never inside a repository. Beside it are `activity.jsonl` and the `inbox/`.

The chain can also be checked without `howl`. The `prev` of line 3 is the hash of line 2 without its line break:

```sh
sed -n 2p ledger.jsonl | tr -d '\n' | sha256sum
```

A chain shows a line that was changed, removed or moved. It does not show lines cut off the end: compare the head that `howl verify` prints with one kept somewhere else.

## Recording a coding agent

`howl` beside a repository where Claude Code works, recording only ([docs/observation.md](docs/observation.md)). Below, `/path/to/handover-ledger` is where this repository is checked out.

**1. Name the project** in the repository that is observed:

```yaml
# .howl/howl.yml
project: example
activity_days: 30     # how long tool calls are kept; 30 when left out
```

**2. Name the agent.** A session with no actor named leaves nothing. An agent is a contributor with an account of its own at the code host ([docs/architecture.md](docs/architecture.md#who-contributes)); a session that works under a person's account is that person's, helped by a tool. Today `howl` does not hold to this yet: it records a session whenever an actor is named, as an agent's and under any account, and puts that agent on what a person's account did at the code host (#14). #95 changes both. Set `HOWL_ACTOR` in the agent's environment, or put the agent's name as the one line of `.howl/actor` and let git ignore that file:

```sh
echo agent-1 > .howl/actor
echo .howl/actor >> .gitignore
```

Whoever starts a session may also name its work: `HOWL_CHANGE` and `HOWL_TASK` in its environment go onto every event of the session. This matters for a reviewer that works in a folder of its own on the default branch, where the branch says nothing:

```sh
HOWL_ACTOR=agent-2 HOWL_CHANGE=30 HOWL_TASK=12 HOWL_ROLE=review HOWL_ROLE_PROMPT=roles/review.md claude …
```

`HOWL_ROLE` names the session's role, a name the team chooses; the dashboard, `howl status` and `howl show` show it. `HOWL_ROLE_PROMPT` is the role prompt's path in the repository: each event records its file and the SHA-256 of its content, so a change shows which prompt the agent ran with.

**Signing a session's claims.** Whoever starts an agent's session can issue a key for that one assignment and hand it over; the hook then signs every event of the session, and `howl verify` holds each signed event to its key: the agent, the task and change, the time window, and no use after a revocation.

```sh
howl key issue --actor agent-2 --change 30 --task 12 --role review --hours 8
# key 3f…  for agent-2
# HOWL_KEY=/home/you/.local/state/howl/example/keys/3f….pem
HOWL_KEY=… HOWL_ACTOR=agent-2 HOWL_CHANGE=30 claude …
howl key revoke 3f…
```

**Keys held by a service.** `howl keyd` holds the issuer key and every assignment's key and signs on a local socket, so a session never sees a private key: with `HOWL_KEYD=<socket>` and `HOWL_KEYD_ADMIN=<admin token file>`, `howl key issue` asks keyd and prints `HOWL_KEY=keyd:<socket>#<key>:<token>`, and the hook signs through it. keyd refuses a claim for another agent, change or task, after the window, or after a revocation. A keyd that hangs or is gone never slows a session: the hook waits at most 0.5 s, and after a failure writes `keyd.down` beside the ledger and does not ask keyd for 60 s; the events of that time are written unsigned, and `howl status` shows them so. Run as the same user as the sessions it keeps keys out of files and enforces the assignment; run it as another user, or on another machine, for the keys to be out of the sessions' reach. Where it should live for good (the developer's machine, the organisation's instance, a hardware key) is still to be decided.

The project's issuer key is made on first use in `~/.config/howl/<project>/issuer.key` (or `$HOWL_CONFIG`); keep the fingerprint it prints somewhere else and give it to `howl verify --issuer`. Said plainly: on one machine with one user, that user can read an agent's key. Signing binds each claim to an issued assignment, makes a later change show and bounds misuse to the key's window; keeping keys out of the user's reach is a step of its own.

**3. Add the hooks** to `.claude/settings.json` of the repository:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/handover-ledger/src/cli/howl.ts hook", "timeout": 5 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/handover-ledger/src/cli/howl.ts hook", "async": true }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/handover-ledger/src/cli/howl.ts hook", "async": true }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node /path/to/handover-ledger/src/cli/howl.ts hook", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/handover-ledger/src/cli/howl.ts hook", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /path/to/handover-ledger/src/cli/howl.ts hook", "timeout": 5 }] }]
  }
}
```

A hook takes about 0.2 seconds, most of it the start of Node. The tool calls run `async`, so a session does not wait for them. `howl hook` prints nothing and always ends with 0: it never disturbs the session, also when the ledger cannot be reached. A wait is written in howl's words, `waits_for: person` (it stands still until someone answers) or `waits_for: instructions` (it is done and waits for more), beside the tool's own kind; the readers use only howl's words, so another agent tool needs only a hook of its own. Waits written before this are read by the tool's kind as before.

**Without Node on the developer's machine.** While `howl up` runs (step 4), the hook can be one `curl` that sends the hook's JSON to it as it stands. The server builds the event, with the code of `howl hook`. Put the line in a script of its own that the settings call as the `command` of each hook above, for a project named `example`:

```sh
#!/bin/sh
( curl -s -o /dev/null -m 1 -X POST -H 'Content-Type: application/json' -H @"$HOME/.local/state/howl/example/token" -H "X-Howl-Actor: $HOWL_ACTOR" -H "X-Howl-Task: $HOWL_TASK" -H "X-Howl-Change: $HOWL_CHANGE" -H "X-Howl-Role: $HOWL_ROLE" -H "X-Howl-Role-Prompt: $HOWL_ROLE_PROMPT" --data-binary @- http://127.0.0.1:4317/api/hook ) 2>/dev/null || true
```

It prints nothing, waits at most a second and always ends with 0, also on a machine with no `curl`. `howl up` makes the file `token` in the project's folder once, for its owner only. The file holds the header line itself and `curl` reads it (`-H @file`), so the token stands on no command line, where every user of the machine could read it. The agent, and the task, change and role a session names, travel as headers; with no `HOWL_ACTOR` and no `.howl/actor` nothing is recorded, as with `howl hook`.

| | `howl hook` | `curl` to `howl up` |
|---|---|---|
| Starts on every call | Node, from a checkout of howl | `curl` |
| Takes, per call | about 0.2 seconds | about 0.03 seconds |
| When the server does not take it | the event waits in the inbox | the event is lost |
| Signed with the session's key | yes, when it has one | no |
| The tool's input and answer are dropped | in the hook's own process | in the server, on the same machine |

With the `curl` line an event is lost whenever the server does not answer 200 within the second: no `howl up` runs, another program has its port, the token file is missing, or the hook's JSON is too large to send in that time (a tool call that read several megabytes). That is a limit of this first version: the rule is that it is stored, and the step that stores it follows. Until then `howl hook` is the way where no event may be lost.

`howl up` itself still needs Node, and for now it runs on the same machine. What goes with the `curl` line is Node on every tool call, and Node on a machine that only records once the server runs elsewhere.

**4. Bring the events in.** One process writes the events into the ledger. `howl up` is that process and the dashboard in one, and the hooks send their events to it as they happen (see "One process: howl up"):

```sh
cd the/observed/repository
node /path/to/handover-ledger/src/cli/howl.ts up                  # the writer and the dashboard, started once
node /path/to/handover-ledger/src/cli/howl.ts verify --project example
```

While no `howl up` runs, `howl hook` leaves a file in the inbox, and nothing is lost (the `curl` line has no inbox): `howl up` takes the inbox in when it starts and at every round. `howl ingest --watch` (or without `--watch`, for one pass) is the writer alone, without the code host and the dashboard.

A session's start, its end and every wait for a person go into the chain. Tool calls are activity: they go to `activity.jsonl`, one event per line with no chain, and are removed after `activity_days`. A tool call keeps the tool, the path within the repository or the name of the program, and the outcome; never the input, the answer or a message, and no hash of the input, which a short input could be guessed from. Lines written by a howl from before this change hold a hash and the time the call took; they stay until they expire. A file in the inbox that is not a valid event is moved to `inbox/rejected/` with the reason beside it.

**From a script.** `howl emit` delivers an event as a hook does (to `howl up` when it runs, else into the inbox), with the agent from `HOWL_ACTOR` or `.howl/actor` when there is one. It ends with 1 and says why when the type or the JSON is wrong:

```sh
#!/bin/sh
if make check; then result=checks.passed; else result=checks.failed; fi
node /path/to/handover-ledger/src/cli/howl.ts emit "$result" --change "$CHANGE" --data '{"check":"make check"}'
```

## Recording the code host

`howl observe` is the writer that also reads the code host; `howl up` runs the same rounds, with the dashboard. Each round brings the inbox in, as `howl ingest` does, then reads what has changed at the code host since the last round and records it as observed events:

| Seen at the host | Event |
|---|---|
| A task opened, given to someone, closed | `task.opened`, `task.assigned`, `task.closed` |
| A change opened, a new head commit, closed without merge | `change.opened`, `change.updated`, `change.closed` |
| The checks of a head commit finished | `checks.passed`, `checks.failed` |
| A review handed in | `review.approved`, `review.changes_requested`, `review.commented` |
| A comment on a change | `review.commented` when its first line matches `review_comment_pattern`, else `change.commented` |
| A change merged | `change.merged` |

```sh
cd the/observed/repository
node /path/to/handover-ledger/src/cli/howl.ts observe              # a round every minute, until stopped
node /path/to/handover-ledger/src/cli/howl.ts observe --once       # one round
```

**Settings**, all optional, in `.howl/howl.yml`:

```yaml
host: github                      # else read from the remote origin
repository: owner/name            # else read from the remote origin
task_from_branch: '^task-(\d+)'   # takes a task's number from a branch name: the first group
agents: [agent-1, agent-2=agent-2-bot]   # the agents: a name, or name=account at the host
review_comment_pattern: '^\[review\]'   # a comment whose first line matches counts as a review; quote it
```

**One name for an agent (#46).** An entry of `agents` is a plain `name`, which is both the agent's name and its account at the host, or `name=account`, for an agent whose account is not its name, as `agent-2=agent-2-bot`. `howl observe` writes the name as the actor of what that account did, so its reviews and its sessions (which say `HOWL_ACTOR=agent-2`) are one agent in the state, in `howl show`, in the handovers and in the figures. For `name=account` the account is kept in `data.account`; for a plain entry it is left out, as it is the name. An account that appears in two entries keeps the name of the first; a name may have several accounts. An entry with an empty side or two `=` is passed over. A session whose actor is no name in `agents` is marked in `howl status` and on the dashboard as missing "not a known agent"; with no `agents` listed nothing is marked, and `howl hook` refuses nothing. The ledger is append-only, so an event written before this step keeps its actor: an agent's observed events from then name its account (`agent-2-bot`) and its sessions name `agent-2`. To read them as one, put `agent-2=agent-2-bot` in `agents` and read the old events with that account as the name. Nothing is counted per person.

**A review is a review.** Formal reviews of the host are always `review.*`. A plain comment on a change counts as a review only when its first line matches `review_comment_pattern`; any other comment, and every comment when there is no pattern, is `change.commented`. The adapter tests the text as it reads the comment and keeps only the outcome, never the text. Review rounds, handovers and the overview's figures count reviews only. In the overview's table of handovers a reviewer's reviews that follow each other on one head of a change are one row with a count, `Implementation → review ×16`, with the time and the hash of the first; `howl show` and the change view give the comments apart, as a count per change. The ledger is append-only: comments recorded before this step are `review.commented` and are still counted as reviews.

**Keeping the head elsewhere.** A hash chain shows a changed line, but not a ledger cut back or rewritten whole with a new chain. `howl anchor` writes a checkpoint (the number of lines and the hash of the last) as a commit on `refs/howl/checkpoints` of the repository and pushes it to `origin`, touching no branch; `--to file:<path>` or `--to -` keeps it elsewhere, and `--sign <ssh key>` signs it. `howl observe --anchor-every 60` anchors after rounds that wrote lines, at most once an hour. `howl verify --checkpoint git` (or a file) then checks that the ledger still holds the line the checkpoint names, and with `--signers <allowed signers>` its signature.

**An evidence bundle.** `howl export --change 30` (or `--task 12`, or `--since … --until …`) writes one `.tar.gz` for an auditor: the ledger up to its head, the numbers of the lines selected (by the rules of `howl show`: for a change, that change alone), the timeline (what the events say), `inferred.json` (what howl matched: the agent behind a person's account or a head that named no one, with the session, the rule and the window; howl's reading, not evidence; not for a period), the checkpoints on `refs/howl/checkpoints` that cover the head, a manifest with the SHA-256 of every file, and a README. A bundle of a trial ledger says so: `trial: true` in the manifest, the first line of the README, `howl export`, and `howl verify --bundle` after its verdict. The check reads the trial from the first line of the bundled ledger, which the chain covers, a manifest that says otherwise does not hold, and one with no `trial` holds. The activity file and `people.json` never go in. `howl verify --bundle <file>` checks it offline, with nothing but the bundle: every file against the manifest, the chain, that each selected line is in the ledger, and the head against the checkpoints (`--signers` for their signatures). A hash chain proves a line only with every line before it, so the bundle carries the ledger up to its head.

**Starting at a date.** On a repository with a long history the first round reads all of it. `howl observe --since 2026-11-01` (or `--since now`) starts the first round at that date instead, and records an `observe.started` event saying so, so a reader knows nothing before it was looked at. It is refused once `observe.json` exists: the cursor says where to go on.

**Access: read only.** `howl observe` never writes to the host. For GitHub it needs a token that can read the repository's issues, pull requests, commits and checks; a fine-grained token with read access to *Issues*, *Pull requests*, *Contents*, *Commit statuses* and *Checks* is enough. It takes `HOWL_GITHUB_TOKEN`, else `GITHUB_TOKEN`, else the token of `gh auth token`. While it runs, a call that is asked again sends the answer's ETag, so a quiet round costs next to nothing; when the limit is reached it waits until the limit is lifted.

**People are not named.** An account in `agents`, or an app account, is an agent and is named by its account. Any other account is a person, named by a pseudonym that is made up the first time the account is seen and kept in `people.json` beside the ledger, never in it. Removing a row there cuts the link between the ledger and that person. An account that no longer exists, which the host shows with no user or as `ghost`, is no one: its events have no actor and say `data.account_removed: true`, so removed accounts are not one person in the ledger.

**Nothing twice.** An observed event's id is made from the host, the repository's lasting id and the thing, so the same thing read again is passed over. The lasting id is the host's own: for GitHub the numeric id of the repository, which stays when the repository is renamed or moved to another owner; `repo` on the event stays the name, as people read it. A ledger written before this holds ids made from `owner/name`. At its start the observer reads from the ledger which names those ids were made from. A name is taken for this repository only when it is the name in the settings now, or the host confirms that it is the same repository: for GitHub, asked for the old name it answers with the same id (a renamed repository answers under its old name); another id, or no such repository, means another repository. The ids made from the name of another repository are left as they are and nothing of them is matched. When a name is the same repository, an id of either form is the same event, so a rename writes nothing twice. Where the last round ended is kept in `observe.json` beside the ledger; without it the host is read from the start and still nothing is written twice. A call that fails is named on standard error, the rest of the round is written, and the next round reads again what was missed; when the host does not tell the repository's id, or cannot say whether an old name in the ledger is this repository, nothing observed is written and the cursor stays until it can, and `howl` names the old name it needs an answer on (the inbox is still brought in).

The code host kept in local files (`host: local`) takes its lasting id from `repository.json` in its folder, `{"id": 4711, "was": ["owner/old-name"]}`; `was` is the list of the names the repository had before, which the host confirms as the same repository. Without the file the id is the repository's name, and no other name is the same repository.

**Known limit:** a repository that is renamed, with a new one then made under its old name, is recorded again: the old name now answers with the other repository's id, so the ledger's old ids are not matched, and what the host shows is written with ids of the new form. The same happens to a local host that is renamed without `was`. A reader then sees the history twice in the ledger, the old copy and the new; the readers go by a change's number, so the two copies are shown as one history, and the figures count it twice.

The first round reads the whole history of the repository: on a repository with hundreds of issues and pull requests it takes minutes.

**Known limit:** when the repository belongs to a person's account and not to an organisation, `repo`, and the ids of a ledger from before the lasting ids, hold that account's name. It names the repository, not who did what.

## One process: howl up

`howl up` is `howl observe` and `howl serve` in one process, for a team to start once in the observed repository:

```sh
cd the/observed/repository
node /path/to/handover-ledger/src/cli/howl.ts up        # the writer, and the dashboard on http://127.0.0.1:4317
```

It is the one writer of the project: it runs the rounds of `howl observe`, with the same options, and a second `howl up` or `howl observe` of the same project is refused. It serves the dashboard and its read-only calls for every project, as `howl serve` does.

**It writes one project and shows every project.** A project of howl's home whose repository has no `howl up` running is on the page and is not written: its sessions' events wait in its inbox until a writer is started there. The page says so under its header, `example: 57 events wait and nothing writes them. Start howl up in its repository.`, and marks the project in the menu and in the event log. `howl status` prints the same line for its project, and `howl up` prints it at its start for each other project. A project that has events waiting and no ledger yet, as a team's second repository has before its first `howl up`, is said in the same way. With a writer running, the line comes only when events have waited for it for over five minutes, well beyond a round of `howl observe`. When the ledger's lock was left by a process that no longer runs, the line says to run `howl verify` and remove the lock, since a new writer is refused until then.

While it runs, a session's hook and `howl emit` send each event to it with a POST of `/api/events`, so the event is in the ledger and on the page within a second or two, not at the next round. The server leaves the event in the inbox and takes the inbox in at once, so there is still one way into the chain. When it does not answer within half a second, or answers anything but 200, the event is left in the inbox as before; nothing is lost, and a server that does not answer is not asked again for a minute.

`howl up` says where it is in `server.json` in the project's folder, with a token that is new at every start, and removes the file when it stops. Only its owner can read the file, and a hook uses it only while the process that wrote it runs. The POST is refused without the token, from a page in a browser, for another project, and for an event that says `observed`: what a session sends is a claim. `POST /api/hook` takes the hook's own JSON from the `curl` line (see "Recording a coding agent") under the same refusals, and keeps only the event it builds from it. Both POSTs take two tokens: the one of `server.json`, new at every start, and the lasting one of the file `token`. It answers on 127.0.0.1 only. A server on another machine is not built.

## Reading the ledger

`howl watch` and `howl show` only read. They take no lock and run while the writer appends. They read the ledger and the activity file together, in the order of time; a half-written last line is left until it is whole. Both find the ledger from `.howl/howl.yml`, or take `--project <name>` or `--ledger <path>`.

**`howl watch`** prints the events, then follows them. One line per event: the time, `claimed` or `observed`, the actor, the type, what it concerns, and the short of its data:

```
$ howl watch --filter type=review.* --filter change=30
times in Europe/Stockholm (UTC+01:00); --utc for UTC
2026-01-01 09:20:00 observed person-0a0a0a0a  review.changes_requested task 12  change 30  aaaaaaa
2026-01-01 09:55:00 observed person-0a0a0a0a  review.approved          task 12  change 30  ccccccc
```

Times are in the local time zone (`TZ`); `--utc` prints them as stored, `2026-01-01T08:20:00Z`. Tool calls are left out unless `--activity` is given or a filter names `tool.used`.

`--filter` takes a CEL expression over `event`, the event as it stands in the ledger:

```sh
howl watch --filter 'event.project == "example" && event.type.startsWith("review.")'
howl watch --filter 'event.type == "tool.used" && event.data.tool == "Bash" && event.actor.id != "agent-1"'
howl watch --filter 'has(event.change) && (event.source.kind == "claimed" || event.type == "checks.failed")'
```

- It is CEL as the library `@marcbachmann/cel-js` speaks it: `==`, `!=`, `<`, `>`, `&&`, `||`, `!`, parentheses, `in` with a list, and on text `startsWith`, `endsWith`, `contains` and `matches`. A time is compared as text: `event.time >= "2026-11-14T14:00"`.
- A field the event does not have is an error, as in CEL, and most events have no `change`. Such an event is left out, and howl says once how many were and why. `has(event.change)` tests for a field: `has(event.change) && event.change == "30"`.
- A wrong expression is refused before anything is read, with its place: `filter at 15: Unterminated string`. A method that no text has, as `event.type.nope()`, shows only when the first event is read: every event is then left out, and howl says why.
- A filter never sees a person's pseudonym: for a person, `event.actor.id` reads `"a person"`, so no expression follows one person.
- `field=value` still filters, as before: `--filter type=review.* --filter change=30`. A value may end in `*`; the fields are those of the event, with `actor`, `kind` (claimed or observed) and `adapter` besides.

`--filter` can be given more than once, and all must match. `--since <time>` passes over what came before (without an offset it is local time); `--json` prints the lines as they stand in the files; `--no-follow` stops after what is there. A wait for a person, failed checks and a review that asks for changes stand out in colour; not when the output is not a terminal, or when `NO_COLOR` is set.

**`howl show <task or change>`** gives the timeline of one assignment: `12`, `task:12` or `change:30`. Asked for a task, it gathers what names the task, its changes, the hook events on their branches and commits, and the rest of those sessions; never what names another task. Where the task has more than one change, each review round and each end says which change it is of. The end of a task is the end of its last change: the task is open while one of its changes is open, merged when every change has ended and one was merged, and closed when every change was closed without a merge. The summary measures to that end. Only a change the code host showed counts. In `--json` the end of a task of several changes has `change`, the change whose end it is; a task of one change has none. A merged task whose last change was closed without a merge has the time of that closing and no `actor`. The tracker's closing of the task is shown as `task closed` and decides neither the state nor the time.

```
$ howl show 12 --utc
Task 12: merged

Hand-over
  2026-01-01T07:50:00Z  observed  task opened by person-0a0a0a0a
  2026-01-01T08:00:00Z  observed  given to agent-1

Sessions
  session s1  claimed  agent-1  2026-01-01T08:02:00Z to 2026-01-01T08:10:00Z, 8m
    tool calls: Bash 2, Edit 1, Read 1
    files: src/a.ts
    2026-01-01T08:05:00Z  waited for a person (permission_prompt): 1m
    2026-01-01T08:09:00Z  waited for instructions (idle_prompt): 1m
  session s2  claimed  agent-1  2026-01-01T08:22:00Z to 2026-01-01T08:30:00Z, 8m
    tool calls: Edit 1
    files: src/b.ts

Change 30  branch task-12-x
  2026-01-01T08:10:00Z  observed  opened by agent-1
  2026-01-01T08:10:00Z  observed  head aaaaaaa, checks passed at 2026-01-01T08:12:00Z
  2026-01-01T08:30:00Z  observed  new head bbbbbbb, checks failed at 2026-01-01T08:33:00Z
  2026-01-01T08:40:00Z  observed  new head ccccccc, checks passed at 2026-01-01T08:45:00Z

Reviews
  round 1: person-0a0a0a0a changes requested; followed by a new head
  round 2: person-0a0a0a0a approved; followed by the merge

End
  2026-01-01T09:00:00Z  observed  merged by person-0b0b0b0b

Summary
  hand-over to the end: 1h 0m
  work 15m, waiting for a person 6m, waiting for instructions 11m, waiting for checks 10m, waiting for review 18m
  review rounds: 2
  taking part: person-0a0a0a0a, agent-1, person-0b0b0b0b
```

The summary divides the time from the hand-over to the end of the task (the end of its last change, a merge or a closing) so that every second is in one part, by the state after the last event before it: an agent working is *work*; an agent that stands still until a person answers, and an approved change not yet merged, is *waiting for a person*; a change whose head waits for its checks or for a review is *waiting for checks* or *waiting for review*; an agent that is done and waits for its next instruction is *waiting for instructions*. A person is shown by the pseudonym of `howl observe`, and no figure is given per person. `--json` gives the parts and the summary as one JSON document.

Asked for a change (`change:30`, or a number that names no task), it gives that change alone: what names it, what sits on its commits, its sessions, and the task's opening and giving as the hand-over. The other changes of the task are named in one line, `Task 40 has another change: 63`, and not mixed in. The heading is `Change 65 of task 40: merged`. The end is the change's own, and the task's closing stands with the task's opening.

Where one branch holds two changes, an event of a session that does not name a change is placed by its time. It is of the change whose life holds that time. Its commit does not decide against the time: a checkout still holds the head of a change after that change is merged, so a commit places an event only inside that change's life. The life of a change runs from the end of the change before it on that branch (from the beginning, for the first) to its own end. A session that works on across the end of one change is in both views, each with its own part, and says `also under change 65`. An event after the last change of the branch has ended is of none of them, and is shown with the task only.

The summary of the task's first change starts at the hand-over. A later change is measured from its own first event.

## Code classes

Every file has a code class: declared by path in `.howl/howl.yml`, and read from the file's own header where a team's files carry one. The two are compared. The class in force is the higher of them, so a repository can only be stricter.

```yaml
classes:                                   # from the highest demand to the lowest
  - name: evidence
    paths: [src/ledger/**, src/keys/**]
  - name: tests
    paths: [test/**]
class_header: '@code_class\s+(\S+)'        # the first group is the class
class_header_in: ['*.ts', '*.tsx', '*.sh'] # the files that must carry the header
```

A path is a glob: `*` within a folder, `**` across folders, and a pattern with no `/` matches the file's name in any folder. The first class with a matching path wins. The header is looked for in the first 50 lines, and the first match counts. Class names and header values are compared without regard to case, with spaces and `_` read as `-`.

A team that already writes its safety class in a file header sets the pattern to match it. For example this header:

```c
/**
 * @file    brake_control.c
 * @brief   Example only.
 * @safety_class ASIL-B
 */
```

is read with `class_header: '@safety_class\s+(ASIL[- _]?[A-D]|QM)'` and the classes `asil-d`, `asil-c`, `asil-b`, `asil-a` and `qm`, in that order.

`howl classes` prints each file git tracks with its class. `howl classes --check` ends with 1 and names each file that has no class by path, lacks a header where `class_header_in` asks for one, has a header that names no class, or has a header that differs from its path's class. With `--json` both give JSON. The command only reads.

## Requirements

`howl trace` reads the requirements a team keeps as Markdown tables in its repository and the tests that name them, and prints the trace matrix and its gaps. It reads the repository alone: no event is written, and the ledger is not needed.

```yaml
requirements_in: ['requirements/*.md']       # the files that hold the tables
requirement_pattern: 'REQ-[A-Z]+-[0-9]+'     # what an ID looks like
requirement_columns: [ID, Ver, Status]       # the headings of the ID, the method and the status
requirement_by_test: [T]                     # the methods that ask for a test
requirement_done: [Implemented, Verified]    # the statuses that say it is built
tests_in: ['src/**/*.rs', 'test/**/*.test.ts']
test_pattern:                                # each finds a test; the first group is its name
  - '#\[test\]\s*(?:#\[[^\]]*\]\s*)*fn\s+(\w+)'
  - '\btest\(\s*"([^"]+)"'
test_covers: [covers, REQ]                   # the words of a covering comment; covers when left out
test_touches: [touches]                      # the words of a touching comment; touches when left out
tests_not_in: ['test/fixtures/**']           # files of tests_in that are not read
requirements_not_in: ['requirements/old-*.md']
```

A table counts when its heading row holds the ID's heading, and each row whose ID cell is an ID is a requirement. The pipes at the edges of a row may be left out, and an ID may stand in bold or in backticks. A table inside a block of code is an example and is passed over. When no file matches `requirements_in`, or the files hold no requirement, the command says so and ends with 2: it is never taken as a trace with no gap. `requirement_columns` may name the ID's heading alone: every requirement then asks for a test and is taken as built. With a method or a status heading, `requirement_by_test` or `requirement_done` says which values count. Headings and values are compared ignoring case.

A test is each match of a `test_pattern` in a file of `tests_in`. A pattern is matched over the whole text of a file, so a name may stand on the line after its mark. A test's name is read ignoring case, as it is written and with `_` as `-`, since a function's name cannot hold `-`. `requirement_pattern` is looked for inside a name, so a `^` at its start and a `$` at its end are taken off. For names that must start with a word, as `def test_req_brk_012_…` in Python, put the group after it: `'def\s+test_(\w+)'`.

- it **covers** the requirement whose ID its name starts with, or each of several IDs it starts with (`REQ-BRK-012 REQ-BRK-013 the rise and the fall`): `test("REQ-BRK-012 a rise is limited", …)`, `fn req_brk_012_a_rise_is_limited()`;
- it **touches** each ID in round brackets in its name: `test("REQ-BRK-012 a rise is limited (REQ-BRK-013)", …)`;
- a comment line of its own, `// covers: REQ-BRK-011, REQ-BRK-012` or `/// touches: REQ-BRK-013`, counts for the next test below it in the file. A team that writes another word sets it: with `test_covers: [covers, REQ]`, `// REQ: REQ-BRK-012 REQ-BRK-013 the rise and the fall` covers both. The IDs stand first, parted by spaces or commas, and the words after them are passed over, also a word that looks like an ID (a colon or a full stop after an ID ends the IDs, and `covers: R-1 and R-2` covers `R-1` only); brackets, backticks and asterisks around the IDs are passed over; a part after a `;` may start with IDs of its own (`REQ: REQ-BRK-012 the rise; REQ-BRK-013 the fall`). The word is compared ignoring case. The line must start with a comment's mark (`//`, `#`, `*`, `--`, `;`, `%`); the words in a line of code, or after a test on its own line, count for nothing.

The gaps are: a requirement that asks for a test, is built, and has no test that covers it (a test that only touches it does not close the gap); a test that names an ID no table holds; an ID given in two rows. Tests that name no requirement are counted and are no gap. A test whose name is worked out when the tests run, as ``test(`${row.id} the page`, …)``, cannot be read: when nothing is read from its name or from a comment above it, it is counted apart (a `test_pattern` must find it first: the one above reads a name in double quotes only, and needs a backtick beside the quote to read a template), `5 with a name worked out at run time`, and marked `computed` in `--json`. Reading those needs a test run (#38).

```
REQ-BRK-012  T  Verified     2 tests
REQ-BRK-020  T  Implemented  no test
REQ-BRK-021  I  Implemented  -

3 requirements, 4 tests (1 names no requirement), 2 gaps, in the working tree

requirements/brake.md:9 REQ-BRK-020: built and by test, and no test covers it
src/diag/mod.rs:43 req_brk_051_a_fault_is_counted_once: names REQ-BRK-051, which no table holds
```

`howl trace --check` prints only the gaps and ends with 1 when there is one. `--json` gives the requirements with their tests, the tests and the gaps, and never the text of a requirement. Each requirement has a version, the SHA-256 of its row with the cells trimmed and the status left out: it holds when a table is lined up again or a requirement is marked built, and changes with the text. `--at <commit>` reads the files and the settings of that commit and nothing from the working tree; without it the files git tracks are read as they stand.

In `howl.yml` a `#` after white space starts a comment, also inside quotes, and a list in square brackets is split at every comma. A pattern with a comma goes on a line of its own under the key, as above. A quote inside a quoted value is taken as it stands: `''` is two quotes and not one, so write a pattern that needs a `'` between double quotes.

**In the ledger.** When `howl observe` or `howl up` writes a change's head and the repository it runs in has the settings above, it reads the requirements and the tests of that commit with the same code and writes one `trace.read` for the head: the IDs covered, the IDs only touched, the number of tests that name a requirement and a hash of the sorted list of them. It is observed, not a claim, and holds no test name and no file name. The hash is the SHA-256 of the sorted lines `file<TAB>name<TAB>covers<TAB>touches` of the tests that name a requirement: `howl trace --at <sha> --json` gives those lines, so an auditor can make the hash again and see that the names are the list that was recorded. With a single test the line is short, and whoever knows its file and its IDs could test a guess of its name. `howl show` prints it under each head (`requirements: R-1, R-3 covered by 2 tests`, `no test names a requirement`, or `requirements: not recorded`), the change view in the page the same, and the overview has a figure for the share of the changes merged in the last 30 days whose merged head names a requirement.

The settings are the commit's own, and a pull request's author writes them, so each commit is read in a process of its own with a time limit of 20 seconds (`HOWL_TRACE_LIMIT_MS`): a pattern that never ends, or a file that overflows the stack, stops that one reading, is said once in the output of `howl observe` and is not tried again, and the round goes on. At most ten heads are read in one round; the rest wait for the next.

Nothing is written when the commit's settings do not have `howl trace`, or when its tables cannot be read. A commit that is not on the machine (howl only reads: it never fetches) waits: it is asked for again at every round while its change is open and once more after it is closed, so a branch that is fetched later is read then; until it is, the head is `not recorded`. A fault in the settings of the working tree is said once. A `trace.read` that a session or a script sends is a claim and counts for nothing.

The type is new in schema version 0: a `howl` from before it refuses a ledger that holds one, and `howl verify` names the line.

Not read yet: whether the tests passed, which needs a test run, and requirements kept in a tool of their own.

## Documents

- [docs/vision.md](docs/vision.md): the problem, who it is for, the offer, the market, the risks.
- [docs/levels.md](docs/levels.md): the levels of autonomy and how a team moves between them.
- [docs/traceability.md](docs/traceability.md): the trace chain, the rules around it and the evidence package.
- [docs/standards.md](docs/standards.md): how the functions map to ISO 26262, ISO/SAE 21434, ISO/IEC 27001 and others. A draft, clause numbers not yet verified.
- [docs/architecture.md](docs/architecture.md): principles, core concepts, ports and adapters, the event fields, the ledger's demands.
- [docs/observation.md](docs/observation.md): the first thing to build: `howl` beside a working team, recording only.
- [docs/commissioning.md](docs/commissioning.md): where it runs, who owns what, the `.howl/` folder, how agents are provisioned, the steps from a trial to an organisation.
- [docs/target.md](docs/target.md): where the platform may go: rule packs, vulnerabilities, storage, a log that follows the repository, people. Not planned.
- [docs/decisions.md](docs/decisions.md): what is decided, what is open, and the order of the work.

## Howl on itself

Run `node src/cli/howl.ts observe` (or `up`, for the dashboard as well) in this repository, and it records its own pull requests and reviews (see `.howl/howl.yml`).
Changes reach `main` only through a pull request with the check green; `scripts/ruleset.sh` sets that rule at the code host.
The ledger it writes is a trial, and not evidence.

## Taking part

Issues are welcome: a question, a fault, what a team would need. Open an issue before a pull request: each step is an issue first. A contributor agreement is proposed and not yet settled ([docs/decisions.md](docs/decisions.md)); until it is, a pull request from outside may have to wait. A change reaches `main` only through a pull request with the check green, and the rule below holds for everything sent here.

## A rule for this repository

It holds only general material. Never a client's rules, flows, names or data.

## Licence

Apache License 2.0, see [LICENSE](LICENSE).
