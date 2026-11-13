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
