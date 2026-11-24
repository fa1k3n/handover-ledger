# Target picture

**Not planned.** This is where the platform may go, written down so that today's choices do not close the way. Nothing here is built or decided unless [decisions.md](decisions.md) says so. What `howl` does is record and check, never steer; how it observes is in [observation.md](observation.md).

## The basic principle

The core records what happens. The packs say what is demanded.

Where something belongs:

- Does it record what happened? The core.
- Does it fetch data from another system? An adapter.
- Does it say what a standard or a law demands? A rule pack.

## Seeing the work as it happens

This stays, with `howl` recording and checking only:

- The agents' work is seen as it happens, across projects, repositories and machines, build hosts too.
- Each machine's hook sends its events live to the server of the organisation, which is witness, index and dashboard, as decided 2026-11-13 ([decisions.md](decisions.md)).
- `howl` may send a notice out, a broken rule or a session waiting for a person, for a person or a team's own tool to act on. Acting on it is never `howl`'s.

## Rule packs

- The core knows no standard. One pack per standard or law holds its control mapping, its rules, its extra fields in the ledger, its additions to the views and its export templates.
- The strictest rule wins. No pack can weaken the core.
- Building blocks that several packs need (traceability, the flow of a vulnerability) are in the core; the packs only map to them.
- Packs have versions, and the version of the rules is kept on every event.
- The texts of standards are under copyright: a pack points to clause numbers and never repeats the text. The text of a law can be quoted.
- The core and basic packs are open; packs and readings made for one client are consulting.
- Formats under consideration: OSCAL for the control mapping and export of security packs, CEL for rules. Until they are needed, rules are a few fixed kinds in the configuration.

## Traceability in three layers

- **The mechanism, in the core:** the links requirement → commit → test → review → release.
- **The source of the requirements, as an adapter:** a requirements tool, or only the tasks.
- **The demands, in the packs:** a pack for functional safety adds the hierarchy of requirements, tracing in both directions and the coverage a class demands. The packs decide which gaps block and which only warn.

## Vulnerabilities

- In the core only this: a vulnerability is a kind of task that goes through the same flow as everything else, and the moment the team came to know of it is an event. A ledger that cannot be changed unseen is then the evidence of that moment.
- Everything else is adapters and packs: the sources of vulnerabilities, the matching against a list of components, the team's existing vulnerability tool.
- A pack for the EU Cyber Resilience Act adds the reporting clocks and the support period. The system prepares a report and a person sends it. The dates and time limits of the act are to be checked against the act itself when the pack is written.

## Agents and their manifests

- The ledger records the provisioning of an agent and does not perform it ([commissioning.md](commissioning.md)).
- Every agent has a versioned manifest: identity, roles, model, tools, entitlements, signing identity. Every event points to a version of the manifest. A change to a manifest is reviewed and approved as code. This matters for confidence in the tool ([standards.md](standards.md)).
- Agents cut across repositories, so the manifests belong in a configuration repository of the organisation or the project, not in each code repository.
- The team's own tools grant the entitlements. The ledger compares what is approved with what is in force; a difference is a broken rule. The one who grants an entitlement is then not the one who checks it.

## Storage

- Millions of events are realistic. The truth and the search index are kept apart.
- **The truth:** a log that only grows, built as a Merkle tree, as certificate transparency logs are. It gives short proofs that an entry is in the log and that the log has only grown. The roots are signed and can be anchored elsewhere.
- **The index:** a database built from the log, which can always be built again.
- **Large data** (prompts, diffs, reports) is kept apart and addressed by its hash.
- This is a transparency log, not a blockchain: who writes is known, so signatures and witnesses are enough. Say "the same technique that protects the certificates of the web".

## A log that follows the repository

- The log can live with the code, on a branch of its own, `howl/log`, and not in the working tree. `.howl/` holds only configuration.
- It then follows the code, works offline and in closed networks, and a supplier can hand over the repository with its log for the client to check.
- Each event is a file named by its hash, so that two clones merge without conflict. This is why an event does not know its place in a ledger.
- Claims are signed when they are made, and each commit to the log is signed with the key of the machine that wrote it. The signed root is sent upwards at every push, so that a rewrite shows. The repository's log is the source of what sessions claim; the level of the organisation is the witness and the index.
- Only what sessions claim goes there, and no person's data. What the code host shows is observed by the one instance and kept there. Activity such as tool calls stays local and expires.
- Decided in its details on 2026-11-24 ([decisions.md](decisions.md), "The log that follows the repository, settled").

## People

- Data protection law applies in full to what the ledger holds about employees. The client is the controller.
- Agents are measured one by one; people only as a team. Traceability needs an identity, figures do not.
- People are named in the ledger by labels that hold within one subject only, and the work by the team that owns the code. The key that resolves a label is kept at the organisation, never in the repository, and every look is recorded. A stable pseudonym would let one person be followed across months and copies; this matters most where the log is copied to every clone ([architecture.md](architecture.md#the-actor-which-person-and-where)). The log that is copied holds no person's data: what names a person is kept at the instance ([decisions.md](decisions.md), "The log that follows the repository, settled", 2026-11-24).
- Who looks at the ledger is itself recorded.
- A system that can watch how employees work may need an impact assessment and a negotiation with the employees' representatives before it is brought in. Templates for both are a delivery with the product. A lawyer reviews before the first client.
