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

`howl verify` checks a ledger: every line is JSON, follows the schema in [schema/event.v0.schema.json](schema/event.v0.schema.json), and holds the SHA-256 of the line before.

```sh
npm run howl -- verify --project example       # the ledger of a project
npm run howl -- verify --ledger path/to/ledger.jsonl
```

It ends with 0 when the ledger holds, 1 when it does not, naming the first line that fails and why, and 2 when there is no ledger to read. It writes nothing and takes no lock.

The ledger of a project lies in `$HOWL_HOME`, else `$XDG_STATE_HOME/howl`, else `~/.local/state/howl`, as `<project>/ledger.jsonl`. Never inside a repository. Nothing writes to it from the command line yet: `howl hook` and `howl ingest` come next.

The chain can also be checked without `howl`. The `prev` of line 3 is the hash of line 2 without its line break:

```sh
sed -n 2p ledger.jsonl | tr -d '\n' | sha256sum
```

A chain shows a line that was changed, removed or moved. It does not show lines cut off the end: compare the head that `howl verify` prints with one kept somewhere else.

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
