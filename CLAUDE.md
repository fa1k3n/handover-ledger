# Working rules

Handover Ledger: an audit-ready ledger of handovers in teams of people and AI agents. The command is `howl`. The ideas are in [docs/](docs/); what is decided and the order of the work are in [docs/decisions.md](docs/decisions.md).

## The repository

- Only general material. Never a client's rules, flows, names or data, in code, tests or documents.
- It stands alone: no code, field names or plans from any other project.
- Say "audit-ready" or "supports certification", never "ISO certified".
- Documents are short, plain sentences, British spelling (organisation, licence).

## The work

- Each step is an issue. The issue is the spec: build what it says, and write any deviation into the issue before or with the code.
- Tests first, from the issue's list, with `node:test`. No test framework. Few dependencies.
- `npm test` runs every test from the root; `npm run check` also type-checks and checks the generated types.
- One package, not workspaces: `src/ledger` (schema, writer, check) and `src/cli` (`howl`).
- A change goes to `main` only through a pull request, from a branch `issue-<number>-<words>`. The session that wrote it does not merge it; the owner merges, with a squash.
- The review is a fresh session that starts from the issue and the diff, never from the author's summary. It writes its findings as one comment on the pull request whose first line starts with `[review]`.
- An existing test is changed only when the issue says so, and the pull request names each one.
- A session never applies the ruleset (`scripts/ruleset.sh`) and never merges.

## Languages

- The engine, the CLI, the dashboard and the extension are TypeScript.
- What a team programs itself (checks, adapters to in-house tools, scripts in `.howl/`) is Python or shell. The boundary is a process: JSON on standard input, JSON on standard output. No API inside the engine for it.
- The event types are a fixed list in the schema. A step that needs a new type adds it to the list, in the same change.
- The event schema in `schema/` is the source. The TypeScript types are generated from it (`npm run gen`) and never edited by hand.
- Node is needed to build and test. A `howl` that needs no Node on the developer's machine comes later.

## The ledger

- Append-only, one JSON line per event, each line holding the SHA-256 of the line before.
- An event does not know its place: `prev` and the hash of the event belong to the line, not to the event.
- The fixed form of an event is JCS (RFC 8785). Only `fixedForm` and `eventHash` in `src/ledger/fixed.ts` make it.
- Test vectors that must match byte for byte, escapes included, are kept in `test/fixtures/`, not written into the tests.
- The chain holds evidence. Activity (tool calls) goes to a file of its own without a chain and expires.
- Only an agent's session is recorded. A person is named by a pseudonym kept beside the ledger, and no figure is given per person.
- Kept outside the repository, never under the working directory.
- One writer at a time. Hooks and scripts never write to the chain; they leave events in an inbox.
- An event the schema does not accept is refused and nothing is written.
- Mark every event as observed (read from the team's tools) or claimed (sent by a session about itself).
- Do not record all content: the tool, the target and the outcome, never keys, whole commands or answers, and no plain hash of an input, which a short input can be guessed from.
- A hook never disturbs the session: quick, silent, always status 0.

## Safe defaults

- Agents never merge. High risk needs a person.
- A trial ledger says so in its first line and is not evidence.
