# Traceability

## The principle

> The process and its trace chain are the same at every level. The level only changes who performs each step.

A standard cares that a step is done, by someone with the right independence, and that there is evidence. So the mapping to a standard is written once and holds all the way up the levels ([levels.md](levels.md)).

## The chain the ledger carries

Every change can be followed:

requirement → change → test → verification → review → release

For each link the ledger says who or what performed the step (a person, or an agent with its model, effort and role prompt), when, and under which version of the rules.

## Rules

- **Requirements stay with the team.** The platform reads requirement IDs from the team's own tool (Polarion, DOORS, codebeamer, Jama, or tables in the repository) through a port, and records the links. It never becomes a requirements tool.
- **The same gate for people and agents.** In a code class that demands it, a change without a link to a requirement does not go on. The check is mechanical.
- **A link an agent claims is not enough.** An agent that writes the code and also states "this covers requirement X" is reporting on itself. The link is confirmed by the name of the test and by the reviewer, clause by clause. Otherwise a clause without a test easily becomes a clause that is not built and still reported as done.
- **Per clause, not per requirement.** A review answers, for each clause of each requirement of the task, which test would fail if the clause were not built.
- **Tests name what they cover.** A test's name or comment starts with the ID of the requirement it covers, so the link can be read from the code and not only from a tool.
- **The level is itself a recorded change.** The ledger shows which level was in force for the code class when the change was made, and who approved that level.

## What is observed and what is claimed

An event that an agent sends about itself is the agent's claim. An event that an adapter reads from the code host, the tracker or the CI is evidence. The ledger prefers the second and marks every event with which of the two it is. See [architecture.md](architecture.md).

## The evidence package

Per release, and per control of a standard, the platform exports:

- the trace matrix: requirement, clauses, changes, tests, verification results, reviewers,
- the gaps: requirements without a test, tests without a requirement, changes without a requirement. The gaps are what an assessor looks at first,
- per change: who or what wrote it (model, role prompt, rule version), who verified it and with which independence, the level in force,
- the level changes of the period and their approvals,
- the result of the chain check ([architecture.md](architecture.md)).

A document that maps each control of a standard to the function and the part of the ledger that shows it is delivered with the platform ([standards.md](standards.md)).
