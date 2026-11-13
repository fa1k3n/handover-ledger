# Handover Ledger

Audit-ready ledger of handovers in mixed teams of people and AI agents.

**Status:** an idea written down. The first step is built: the event schema, the ledger file and `howl verify`. This repository is private until the event schema and `howl verify` work and a licence is chosen. No licence yet: all rights reserved until then.

## The idea in short

Teams in regulated development want to use AI agents but cannot show an assessor who did what, with which model, under which rules, and who checked it. Handover Ledger is a platform that

- runs in the team's own environment (their code host, tracker, requirements tool and model),
- lets the team get used to agents one level at a time, from agents that only review what people write to agents that do nearly everything,
- keeps the process and its trace chain the same at every level, so only *who performs each step* changes,
- records every handover between team members, human or agent, in a tamper-evident ledger that can be exported as evidence for a standard.

The method is the offer. The tool makes the method binding and measurable.

## The parts

| Part | Does | Writes to the ledger |
|---|---|---|
| `ledger` (core) | Event schema, hash chain, rules, levels | Yes |
| Adapters | Read what happened in the team's tools and turn it into events | Yes, through the core |
| `howl` (CLI) | `howl init`, `howl verify`, `howl status`, `howl export` | Yes, through the core |
| Dashboard | Views over the ledger | No |
| VS Code extension | The team and the chain per change, in the editor | No |

One repository, TypeScript throughout.

## Running it

Node 24 or later is needed to build and test. A `howl` that needs no Node on the developer's machine comes later.

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

A line of the ledger is `{"prev", "hash", "event"}`. The event does not know its place: `prev` and `hash` belong to the line ([schema/line.v0.schema.json](schema/line.v0.schema.json)). `hash` is the SHA-256 of the event in its fixed form, the JSON Canonicalization Scheme (RFC 8785), and the event stands in the line in that form.

`howl verify` checks every line: it is JSON, it follows the line schema, its event follows [schema/event.v0.schema.json](schema/event.v0.schema.json), `hash` is the hash of the event, and `prev` is the SHA-256 of the line before.

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

**2. Name the agent.** Only an agent's session is recorded; a person's session leaves nothing. Set `HOWL_ACTOR` in the agent's environment, or put the agent's name as the one line of `.howl/actor` and let git ignore that file:

```sh
echo agent-1 > .howl/actor
echo .howl/actor >> .gitignore
```

Whoever starts a session may also name its work: `HOWL_CHANGE` and `HOWL_TASK` in its environment go onto every event of the session. This matters for a reviewer that works in a folder of its own on the default branch, where the branch says nothing:

```sh
HOWL_ACTOR=agent-2 HOWL_CHANGE=30 HOWL_TASK=12 HOWL_ROLE=review HOWL_ROLE_PROMPT=roles/review.md claude …
```

`HOWL_ROLE` names the session's role, a name the team chooses; the dashboard, `howl status` and `howl show` show it. `HOWL_ROLE_PROMPT` is the role prompt's path in the repository: each event records its file and the SHA-256 of its content, so a change shows which prompt the agent ran with.

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

A hook takes about 0.2 seconds, most of it the start of Node. The tool calls run `async`, so a session does not wait for them. `howl hook` prints nothing and always ends with 0: it never disturbs the session, also when the ledger cannot be reached.

**4. Bring the events in.** Hooks only leave files in the inbox. One process writes them into the ledger:

```sh
cd the/observed/repository
node /path/to/handover-ledger/src/cli/howl.ts ingest --watch      # or without --watch, for one pass
node /path/to/handover-ledger/src/cli/howl.ts verify --project example
```

A session's start, its end and every wait for a person go into the chain. Tool calls are activity: they go to `activity.jsonl`, one event per line with no chain, and are removed after `activity_days`. A tool call keeps the tool, the path within the repository or the name of the program, the outcome and a hash of the input; never the input, the answer or a message. A file in the inbox that is not a valid event is moved to `inbox/rejected/` with the reason beside it.

**From a script.** `howl emit` leaves an event in the inbox, with the agent from `HOWL_ACTOR` or `.howl/actor` when there is one. It ends with 1 and says why when the type or the JSON is wrong:

```sh
#!/bin/sh
if make check; then result=checks.passed; else result=checks.failed; fi
node /path/to/handover-ledger/src/cli/howl.ts emit "$result" --change "$CHANGE" --data '{"check":"make check"}'
```

## Recording the code host

`howl observe` is the one process a team keeps running. Each round brings the inbox in, as `howl ingest` does, then reads what has changed at the code host since the last round and records it as observed events:

| Seen at the host | Event |
|---|---|
| A task opened, given to someone, closed | `task.opened`, `task.assigned`, `task.closed` |
| A change opened, a new head commit, closed without merge | `change.opened`, `change.updated`, `change.closed` |
| The checks of a head commit finished | `checks.passed`, `checks.failed` |
| A review handed in | `review.approved`, `review.changes_requested`, `review.commented` |
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
agents: [agent-1, agent-2]        # the accounts at the host that are agents
```

**Access: read only.** `howl observe` never writes to the host. For GitHub it needs a token that can read the repository's issues, pull requests, commits and checks; a fine-grained token with read access to *Issues*, *Pull requests*, *Contents*, *Commit statuses* and *Checks* is enough. It takes `HOWL_GITHUB_TOKEN`, else `GITHUB_TOKEN`, else the token of `gh auth token`. While it runs, a call that is asked again sends the answer's ETag, so a quiet round costs next to nothing; when the limit is reached it waits until the limit is lifted.

**People are not named.** An account in `agents`, or an app account, is an agent and is named by its account. Any other account is a person, named by a pseudonym that is made up the first time the account is seen and kept in `people.json` beside the ledger, never in it. Removing a row there cuts the link between the ledger and that person.

**Nothing twice.** An observed event's id is made from the host, the repository and the thing, so the same thing read again is passed over. Where the last round ended is kept in `observe.json` beside the ledger; without it the host is read from the start and still nothing is written twice. A call that fails is named on standard error, the rest of the round is written, and the next round reads again what was missed.

The first round reads the whole history of the repository: on a repository with hundreds of issues and pull requests it takes minutes.

**Known limit:** when the repository belongs to a person's account and not to an organisation, `repo` and every id hold that account's name. It names the repository, not who did what.

## Reading the ledger

`howl watch` and `howl show` only read. They take no lock and run while the writer appends. They read the ledger and the activity file together, in the order of time; a half-written last line is left until it is whole. Both find the ledger from `.howl/howl.yml`, or take `--project <name>` or `--ledger <path>`.

**`howl watch`** prints the events, then follows them. One line per event: the time, `claimed` or `observed`, the actor, the type, what it concerns, and the short of its data:

```
$ howl watch --filter type=review.* --filter change=30
times in Europe/Stockholm (UTC+01:00); --utc for UTC
2026-01-01 09:20:00 observed person-0a0a0a0a  review.changes_requested task 12  change 30  aaaaaaa
2026-01-01 09:55:00 observed person-0a0a0a0a  review.approved          task 12  change 30  ccccccc
```

Times are in the local time zone (`TZ`); `--utc` prints them as stored, `2026-01-01T08:20:00Z`. Tool calls are left out unless `--activity` is given or a filter asks for `type=tool.used`.

`--filter field=value` can be given more than once, and all must match; a value may end in `*`. The fields are those of the event, with `actor`, `kind` (claimed or observed) and `adapter` besides. `--since <time>` passes over what came before (without an offset it is local time); `--json` prints the lines as they stand in the files; `--no-follow` stops after what is there. A wait for a person, failed checks and a review that asks for changes stand out in colour; not when the output is not a terminal, or when `NO_COLOR` is set.

**`howl show <task or change>`** gives the timeline of one assignment: `12`, `task:12` or `change:30`. It gathers what names the task, its changes, the hook events on their branches and commits, and the rest of those sessions; never what names another task.

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

The summary divides the time from the hand-over to the merge so that every second is in one part, by the state after the last event before it: an agent working is *work*; an agent that stands still until a person answers, and an approved change not yet merged, is *waiting for a person*; a change whose head waits for its checks or for a review is *waiting for checks* or *waiting for review*; an agent that is done and waits for its next instruction is *waiting for instructions*. A person is shown by the pseudonym of `howl observe`, and no figure is given per person. `--json` gives the parts and the summary as one JSON document.

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

## A rule for this repository

It holds only general material. Never a client's rules, flows, names or data.
