# Architecture

## Principles

- **Agents do the work, code steers the flow.** Orchestration is deterministic code. State is owned by the program, never by a model.
- **Agents are short-lived.** Every assignment is a new session that starts cold. A review needs independence, a test author starts from the requirement and not from the code, and memory kept in a clone gathers faults.
- **No hidden agent memory.** State per task lives in the task, the change and its comments. Lasting learning is written into the repository (instructions, role files).
- **Observed before claimed.** Events come from adapters that read what happened in the team's tools. An event an agent sends about itself is marked as a claim.
- **Identity and memory are separate.** A named agent is a lasting identity; each assignment is a new session. Its "memory" is its history in the team's tools.
- **Role, model and effort belong to the assignment.** Any team member can take any role. The dispatcher sets role, model and effort from the task (for example its size and risk).
- **People are full team members.** When a task is assigned to a person no session starts; the dispatcher waits for a real event. People keep working in their usual tools: a review in the code host becomes a core event.
- **Safe defaults.** Agents never merge. High risk needs a human approver. At the highest level a deterministic program may merge on conditions; a model never does.

## Core concepts

The core knows only its own concepts: task, team member (agent or person), assignment, role, event, rules, level and code class. It knows nothing about any one code host or tracker.

## Ports and adapters

| Port | Examples |
|---|---|
| Code host | GitHub, GitLab, Gerrit, Bitbucket |
| Tracker | GitHub Projects, Jira, Linear |
| Requirements | Tables in the repository, Polarion, DOORS, codebeamer, Jama |
| Runner | Claude Code CLI, an agent SDK; locally, in CI, in a container; a model through the team's own cloud agreement |
| Bus | Polling, webhooks, a queue |
| Identity | Accounts of people and agents |

- Adapters translate both ways.
- An adapter announces what it can do beyond the port, so the core does not sink to the lowest common level.
- Do not abstract ahead of need. Build at least two adapters of a port at once: a real one and a local, file-based one that is also the test environment.
- Teams in regulated development seldom have their code on a public host and often may not send code off the premises. Independence from one code host and one model provider is a condition, not a nicety.

## The parts

| Part | Does | Writes to the ledger |
|---|---|---|
| `ledger` (core) | Event schema, hash chain, rules, levels | Yes |
| Adapters | Read what happened and turn it into events | Yes, through the core |
| `howl` (CLI) | `howl init`, `howl verify`, `howl status`, `howl export` | Yes, through the core |
| Dashboard | Views over the ledger | No |
| VS Code extension | The team and the chain per change, in the editor | No |

The dashboard and the extension read only the ledger, so they work whatever the tracker. One repository. The engine, the CLI, the dashboard and the extension are TypeScript; what a team programs itself is Python (below).

The first version only **records**: a ledger over a flow that exists (level 0). Steering comes after.

## What a team programs itself

Embedded developers know Python and shell, not TypeScript. So everything a development team writes or changes itself is Python or a shell script:

- mandatory checks before a review (a wrapper around a static analyser, a coverage limit),
- adapters to in-house tools (an export from a requirements tool, an internal tracker),
- scripts in `.howl/`.

Rules are configuration first, and code only where configuration is not enough.

The boundary is a protocol between processes, not an API inside the engine: the engine starts the script, sends JSON on standard input and reads JSON on standard output. Python then needs no place inside the TypeScript code, and a shell script or any other language works as well. `howl emit` writes an event from a script without building the JSON by hand.

- The event schema is written as JSON Schema. The TypeScript types and a Python package are generated from it.
- The Python package has no dependencies, runs on old Python versions and can be copied in as files: development networks are often closed and their Python environments locked.
- `howl` is delivered so that a developer's machine and a CI runner need no Node.

## The event

An own schema; a CloudEvents envelope is an option. First draft of the fields:

| Field | Holds |
|---|---|
| `v` | Version of the line format |
| `time` | When it happened |
| `type` | What happened (below) |
| `source` | The adapter that read it, and whether it was observed or claimed |
| `actor` | The team member: person or agent, with its identity |
| `model`, `effort` | For an agent: the model ID and effort of the session |
| `prompt` | For an agent: the role prompt, as `file` and `sha256` of its content |
| `rules` | Version of the rules in force (the commit they ran from) |
| `task`, `change`, `sha` | The task, the merge or pull request, and its head commit |
| `requirements`, `clauses`, `tests` | The trace links ([traceability.md](traceability.md)) |
| `level`, `class` | The level in force and the code class |
| `prev` | SHA-256 of the line before |

Types, to begin with: task assigned, change opened or updated, tests written, checks passed or failed, review approved or changes requested, finding fixed, dismissed or left open, change merged, level changed, rule broken, escalated to a person.

An event says what happened, not who shall do the next step. The dispatcher applies the rules.

## Rules

- A review is done by another team member than the author, and for an agent at a higher model level. This is a rule for quality, not evidence of independence ([standards.md](standards.md)).
- A bounded number of review rounds, then escalation to a person.
- Every finding gets a fix or a reason. Not everything a reviewer doubts is a fault.
- Idempotent per event and commit.
- A wrong reviewer model, or a step taken by one who may not take it, is recorded as a broken rule.
- A fix never changes an existing test without a person having asked for it.
- Project rules come on top, for example "high risk needs a human approver". Some rules belong to the core and cannot be switched off ([levels.md](levels.md)).

## Named agents

- Agents have names and appear on the board, in the log and in the history as colleagues.
- Every comment shows what ran, for example "agent-1 (Opus, high effort) reviewed".
- A few lines of working style per agent (tests first, asks before guessing). They may never lower the quality demands. Start empty and add one line at a time.
- Files: one per agent (identity, style) and one per role (instructions, tools), in the project's configuration.
- Quality figures per agent say little while any agent can take any role and model. Measure per model and per role first.

## Configuration

In two places ([commissioning.md](commissioning.md)). A `.howl/` folder in the repository declares what is true about its code: the code classes with their paths, owners and the levels asked for, the mandatory checks, the role prompts. The instance holds what decides: the enrolled repositories, the rules of each project, the teams and agents, the table of model and effort per size and risk, the adapters, the approved levels.

## The ledger

- Append-only, one line per event.
- Each line holds the hash of the line before. `howl verify` names the first line that does not match.
- A chain shows a changed or removed line, not lines cut off the end, and a file that one party both writes and keeps proves little. Signing the lines, or keeping the last hash somewhere else, is needed before it counts as evidence.
- Only one writer at a time.
- Configurable retention and export ([traceability.md](traceability.md)).

## Dashboard views

The team right now; the flow (lead time, review rounds, escalations); quality per model, role and style; cost per task and model; the audit chain per change.
