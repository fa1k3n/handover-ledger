# Handover Ledger

Audit-ready ledger of handovers in mixed teams of people and AI agents.

**Status:** an idea written down, nothing built yet. This repository is private until the event schema and `how verify` work and a licence is chosen. No licence yet: all rights reserved until then.

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
| `how` (CLI) | `how init`, `how verify`, `how status`, `how export` | Yes, through the core |
| Dashboard | Views over the ledger | No |
| VS Code extension | The team and the chain per change, in the editor | No |

One repository, TypeScript throughout.

## Documents

- [docs/vision.md](docs/vision.md): the problem, who it is for, the offer, the market, the risks.
- [docs/levels.md](docs/levels.md): the levels of autonomy and how a team moves between them.
- [docs/traceability.md](docs/traceability.md): the trace chain, the rules around it and the evidence package.
- [docs/standards.md](docs/standards.md): how the functions map to ISO 26262, ISO/SAE 21434, ISO/IEC 27001 and others. A draft, clause numbers not yet verified.
- [docs/architecture.md](docs/architecture.md): principles, core concepts, ports and adapters, the event fields, the ledger's demands.
- [docs/decisions.md](docs/decisions.md): what is decided, what is open, and the order of the work.

## A rule for this repository

It holds only general material. Never a client's rules, flows, names or data, and nothing from a private project's issues or requirements.
