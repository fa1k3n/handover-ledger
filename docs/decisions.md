# Decisions

Written 2026-11-12 from the first discussions. Newest decisions are added at the end of each list, with their date.

## Decided

- **Name:** Handover Ledger. The repository was first named Handoff Ledger by mistake and was renamed the same day; "handoff" also collides with a well-known product feature and with the broad term "agent handoff". The command is `howl`, short for Handover Ledger; it was first `how` and was changed 2026-11-13. (2026-11-12)
- **Own repository that stands entirely on its own.** It is tied to no other project: no shared code, field names or plans. (2026-11-13)
- **Private first,** public when the event schema and `howl verify` work and the licence is chosen. (2026-11-12)
- **Several parts:** core, adapters, CLI, dashboard, VS Code extension. (2026-11-12)
- **Open source with consulting** for the integration at clients. (2026-11-12)
- **Levels of autonomy** as the way in for a team, combined with traceability so that it fits ISO and similar standards. (2026-11-12)
- **Helpers are short-lived and start cold; orchestration is deterministic code; no hidden agent memory.** (2026-11-12)
- **Named agents:** identity is lasting, memory is not; role, model and effort belong to the assignment. (2026-11-12)
- **Safe defaults:** agents never merge, high risk needs a person. (2026-11-12)
- **Wording:** "supports certification" or "audit-ready", never "ISO certified". (2026-11-12)
- **Languages:** the engine, the CLI, the dashboard and the VS Code extension are built in TypeScript. Whatever a development team itself programs (checks, adapters to in-house tools, scripts in `.howl/`) is Python: embedded developers do not know TypeScript. (2026-11-13)

## Proposed, not yet answered

- The level is set per code class, not per company.
- A level 0 that only records.
- Shadow mode before every step up, and an automatic step down.
- "Safety-classed code needs a human verifier" belongs to the core and cannot be switched off.
- No reviewer of our own at level 1: govern and record any reviewer.
- Events are observed by adapters and not sent by the agents themselves.
- Requirements stay in the team's tool; the platform only links.
- The boundary to what a team programs is a protocol between processes (JSON in, JSON out), not an API inside the engine; the event schema is JSON Schema, from which both the TypeScript types and a Python package are generated; the Python package has no dependencies and runs on old Python versions; `howl` is delivered so that a developer's machine needs no Node. (2026-11-13)
- Commissioning ([commissioning.md](commissioning.md)): one instance per R&D organisation with the project as the boundary for rules and evidence; the repository declares in `.howl/` and the instance decides; discovery only proposes an enrolment; ownership lies on paths, never on a binding of team to repository; a repository belongs to one project; an agent is an identity, a runner and a computed entitlement with a short-lived key per assignment. (2026-11-13)

## Open

- **Licence:** Apache 2.0 for the widest spread, or AGPL as protection against hosted copies. The income is consulting and not hosting, and legal departments in regulated industries often stop AGPL, which speaks for Apache 2.0. To be checked with a lawyer.
- **Name check:** GitHub, npm, the VS Code Marketplace and the domain, and a trade mark search at EUIPO and PRV. "Handover" alone is already used by other products. Check also that `howl` is free as a package name and is not the command of another program; a scoped package that installs the command `howl` solves the first.
- **Accounts for agents:** an app of the code host (cannot be assigned tasks everywhere), one machine account per agent (check the host's terms), or one shared bot account with the name in comment and label. Separation of duties needs more than a person's own account.
- **Own account or an organisation** for the repository when it becomes public. It can be moved later.
- **The second adapter:** GitLab seems the likely one for the first clients. The answers to the five questions in [vision.md](vision.md) decide.
- **Which standard is mapped first.** The draft in [standards.md](standards.md) starts with ISO 26262 and ISO/SAE 21434.
- **The number of review rounds** before a person is asked: two or three.
- **A separate test author** as a role of its own, or tests written by the one who builds.
- **The name of the configuration:** a `.howl/` folder in the repository is the suggestion, with `howl.yml` in it.
- **Signing or anchoring** of the ledger.

## The order of the work

0. Before code: check the clause numbers of the control mapping and show it to two or three safety managers or an assessor; ask every team the five questions.
1. The event schema, the hash chain, `howl verify` and the local file adapter, which is also the test environment.
2. An adapter that reads merge and pull requests. This is level 0.
3. Level 1: a runner for a reviewer, the rules around it, the share of dismissed findings.
4. The evidence export and the control mapping for one safety standard.
5. The requirements port: tables in the repository first, then one requirements tool.
6. Level 2: the tracker adapter, the dispatcher, named agents.
7. Level 3: conditional merge, with shadow mode first.
8. Dashboard and VS Code extension when someone asks for them. An init command and documentation along the way.

The order in the first discussion was: core with ledger and two adapters, dashboard, documentation and init command, Jira adapter, control mapping. It was changed because levels 0 and 1 need only the ledger, a reader of merge requests and a runner, and because the control mapping decides what the ledger has to hold.

## Before going public

- A licence file.
- The name check.
- Read every document once more for anything that names a client or a person.
