# Decisions

Written 2026-11-12 from the first discussions. Newest decisions are added at the end of each list, with their date.

## Decided

- **Name:** Handover Ledger. The repository was first named Handoff Ledger by mistake and was renamed the same day; "handoff" also collides with a well-known product feature and with the broad term "agent handoff". The command is `howl`, short for Handover Ledger; it was first `how` and was changed 2026-11-13. (2026-11-12)
- **Own repository that stands entirely on its own.** It is tied to no other project: no shared code, field names or plans. (2026-11-13)
- **Private first,** public when the event schema and `howl verify` work and the licence is chosen. (2026-11-12) Replaced 2026-11-14 by "Public now", at the end of this list.
- **Several parts:** core, adapters, CLI, dashboard, VS Code extension. (2026-11-12)
- **Open source with consulting** for the integration at clients. (2026-11-12)
- **Levels of autonomy** as the way in for a team, combined with traceability so that it fits ISO and similar standards. (2026-11-12)
- **Helpers are short-lived and start cold; orchestration is deterministic code; no hidden agent memory.** (2026-11-12)
- **Named agents:** identity is lasting, memory is not; role, model and effort belong to the assignment. (2026-11-12)
- **Safe defaults:** agents never merge, high risk needs a person. (2026-11-12)
- **Wording:** "supports certification" or "audit-ready", never "ISO certified". (2026-11-12)
- **Languages:** the engine, the CLI, the dashboard and the VS Code extension are built in TypeScript. Whatever a development team itself programs (checks, adapters to in-house tools, scripts in `.howl/`) is Python, and a shell script shall work as well: embedded developers do not know TypeScript. (2026-11-13)
- **Observation mode first:** `howl` is tried beside a team whose agents already work, recording only, for what it shows of the agents' work ([observation.md](observation.md)). (2026-11-13)
- **The core records what happens, the packs say what is demanded.** The core knows no standard. (2026-11-13)
- **An event does not know its place in a ledger:** `prev` and the hash of the event belong to the line. (2026-11-13)
- **Agents are measured one by one, people only as a team.** Only an agent's session is recorded; a person is named by a pseudonym kept beside the ledger. (2026-11-13)
- **Evidence and activity are kept apart:** the chain holds the handovers, tool calls go to a file of their own and expire. (2026-11-13)
- **A first dashboard now,** to see a first trial: the team right now and the event stream, then the overview, and only what the ledger already holds (#10 to #13). The rest of the design waits for its data. (2026-11-13)
- **The dashboard is React with Tailwind,** in TypeScript, built with Vite, in the same package. (2026-11-13)
- **CEL filters later:** the first filters are `field=value` pairs; a CEL expression filter replaces them when more is needed. (2026-11-13)
- **Anchoring first, signing optional.** The ledger's head is kept outside the machine that writes it as checkpoints on `refs/howl/checkpoints` of the observed repository, pushed to its remote; a checkpoint may be signed with an SSH key. What a session claims is signed with a key per assignment. A Merkle tree and a transparency log come later. (2026-11-13)
- **The log follows the repository; a central server is witness, index and dashboard.** Evidence is kept in a git reference of its own in the observed repository (not in the working tree) and travels with every push, so it works offline and in closed networks and a supplier can hand the repository over with its log. A push reaches the code host, not howl's server: the server reads `refs/howl/*` from the code host, or is told by a webhook when they move. When a session can reach the server, its hook also sends each event live, and keeps it locally when it cannot; the reference is the durable path, the live stream is for seeing at once. The server keeps the signed roots it has seen, as a witness that a reference was not rewritten, and the code host refuses force pushes to `refs/howl/*`. Tool calls stay local. The tie of a pseudonym to a person never goes into the repository. Before the server is built, the storage changes from one writer's chain to events as files named by their hash, with signed roots (#27). (2026-11-13)
- **Licence: Apache 2.0,** for the widest spread. Legal departments in regulated industries often stop AGPL, and the income is consulting, not hosting. The check with a lawyer is still to be made. (2026-11-14)
- **Public now.** The event schema and `howl verify` work and the licence is chosen, as first asked. The name check was also to come before; it follows instead. The work is done in the open from here on, and the code host's checks cost nothing on a public repository. (2026-11-14)
- **A code class for every file:** declared by path in `.howl/howl.yml` and read from the file's header with a pattern the project sets; the higher of the two is in force, and `howl classes --check` names every file where they disagree. This repository is classified in both ways: `evidence`, `rules`, `recording`, `reading`, `tests`, `documents`. (2026-11-14)
- **A local server first, as a stand-in.** `howl up` is the writer, the dashboard and the way in for a session's events over HTTP, in one process on 127.0.0.1, started by hand, on the one-file ledger (#64). It is not the central server of "The log follows the repository": that one still waits for the storage of #27, and for #32 before it. (2026-11-14)
- **The filter is a CEL expression,** evaluated by the library `@marcbachmann/cel-js` (MIT, no dependencies of its own), howl's second runtime dependency. The event is `event`, as in `event.type`; a field it does not have is an error, as in CEL; a filter never sees a person's pseudonym. The `field=value` pairs still work. This takes up "CEL filters later" of 2026-11-13. (2026-11-14)
- **The requirements port starts with a reader, before level 1.** `howl trace` reads the requirements in the repository's Markdown tables and the tests that name them, and gives the gaps; it writes nothing. This is the first half of step 5 of the order below, taken before step 3: it needs nothing from the ledger, and it is what a safety manager recognises first. The link in the ledger follows (#38). (2026-11-15)

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
- **The business model: an open core, standards packs on a yearly licence, consulting.** The core (ledger, hooks, adapters, dashboard, `howl verify` and `howl export`) is open and fully useful alone; it builds trust. The standards packs (control mappings, rules, export templates and a tool qualification kit per version, per ISO 26262-8) are sold as yearly licences that keep them current as standards, editions and laws change. Consulting takes a client up the levels. Conditions (2026-11-13):
  - **Evidence is never locked by a licence.** Without a licence a pack stops being updated; everything already recorded or exported stays verifiable for ever, and the client keeps the pack version it paid for. An audit can come years after the code was written.
  - **No text of a standard** in a pack: clause numbers, our own interpretation, rules and templates only. The interpretation is what is worth paying for.
  - **The licence works offline:** a signed licence file checked locally, never a call home, as clients run closed networks.
  - **The core and the packs are kept apart in law as in code:** the copyright of the core is held by one party, so a contributor signs a CLA, which lets an open core and closed packs stand side by side.
  - **"Kept current" is a promise with a time:** for example updated within six months of a new edition, and reviewed by an assessor.
  - **The unit of the licence** is the organisation and the pack, or the product with its own safety case; not the developer, as agents do much of the work.

## Open

- **Where agents' keys live for good:** `howl keyd` on the developer's machine as another user, a service of the organisation's instance, or a hardware key (TPM, a token); and how an agent proves to it which assignment it holds. A first form of keyd exists (2026-11-13).

- **The licence checked with a lawyer:** Apache 2.0 is chosen (see Decided); the check is still to be made, also of the contributor agreement.
- **Name check:** GitHub, npm, the VS Code Marketplace and the domain, and a trade mark search at EUIPO and PRV. "Handover" alone is already used by other products. Check also that `howl` is free as a package name and is not the command of another program; a scoped package that installs the command `howl` solves the first.
- **Accounts for agents:** an app of the code host (cannot be assigned tasks everywhere), one machine account per agent (check the host's terms), or one shared bot account with the name in comment and label. Separation of duties needs more than a person's own account.
- **Own account or an organisation** for the repository. It is on the owner's own account and can be moved later.
- **The second adapter:** GitLab seems the likely one for the first clients. The answers to the five questions in [vision.md](vision.md) decide.
- **Which standard is mapped first.** The draft in [standards.md](standards.md) starts with ISO 26262 and ISO/SAE 21434.
- **The number of review rounds** before a person is asked: two or three.
- **A separate test author** as a role of its own, or tests written by the one who builds.
- **The name of the configuration:** a `.howl/` folder in the repository is the suggestion, with `howl.yml` in it.
- **From the target picture** ([target.md](target.md)): which rule pack comes first; OSCAL and CEL, or simpler forms; how much of the handling of vulnerabilities belongs to the core; where the agents' manifests live.

## The order of the work

0. Before code: check the clause numbers of the control mapping and show it to two or three safety managers or an assessor; ask every team the five questions.
1. The event schema, the hash chain, `howl verify` and the local file adapter, which is also the test environment. Then the split of event and line, and `howl hook` with the inbox ([observation.md](observation.md), steps 1 and 2).
2. An adapter that reads merge and pull requests. This is level 0.
3. Level 1: a runner for a reviewer, the rules around it, the share of dismissed findings.
4. The evidence export and the control mapping for one safety standard.
5. The requirements port: tables in the repository first, then one requirements tool.
6. Level 2: the tracker adapter, the dispatcher, named agents.
7. Level 3: conditional merge, with shadow mode first.
8. A first dashboard came forward on 2026-11-13 (see Decided); the rest of it and the VS Code extension when someone asks for them. An init command and documentation along the way.

The order in the first discussion was: core with ledger and two adapters, dashboard, documentation and init command, Jira adapter, control mapping. It was changed because levels 0 and 1 need only the ledger, a reader of merge requests and a runner, and because the control mapping decides what the ledger has to hold.

## Before going public

- A licence file. Done: Apache 2.0, in `LICENSE`. (2026-11-14)
- The name check. Not made before going public; it follows (see Open).
- Read every document, test and comment in the code once more for anything that names a client, a person or another project. Read 2026-11-14; what it found is #34.
