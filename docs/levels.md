# Levels of autonomy

A team gets used to agents one level at a time. The process and its trace chain are the same at every level ([traceability.md](traceability.md)); the level only changes who performs each step.

## The levels are the team's

A team declares a level per code class, and a person approves it; the approval is recorded in the ledger. The team's own tools do the work of the level. `howl` does not run a level: it checks that the observed work stays within the declared one. A step outside it is a hole, as any broken rule.

`howl` records and checks at every level, so recording names no level.

Each level is a set of conditions on observed events:

| Level | Who may author | Who must verify | Who merges | Minimum assurance of each link |
|---|---|---|---|---|
| 0 No agents | People, with any AI tool declared on each change by its author | A person | People | Set by the code class (#182) |
| 1 Review | People only, with any AI tool declared, as at level 0 | A person; an agent may add a review | People | Set by the code class (#182) |
| 2 Small jobs | People (AI tool declared), and agents within the paths and size the class allows | A person, for every agent's change | People | Set by the code class (#182) |
| 3 Agent team | People (AI tool declared) and agents | Agents review each other; a person where a rule names one | The team's own program, on the conditions of the table; people take the exceptions | Set by the code class (#182) |

An agent's change in a class declared at level 1 is then a hole.

## Level 0: no agents

People do the work, as before. An AI tool used under a person's own account is that person's tool, and the author declares it on each change. A team with no agents is a full case, not a lesser one.

`howl` checks that no agent's account authors, verifies or merges, and that each change declares its tool or "none". The ledger gives figures on lead time and review rounds *before* agents come in, which the team needs to justify the next step.

## Level 1: agents review

The team's own tools run a reviewer, any reviewer, also one built into the code host. It comments on changes written by people. It is an addition to the human review and replaces nothing, so it cannot bring a fault into the product. This is the safe way in.

- `howl` checks that a person authored, a person verified and people merged. It has no reviewer of its own.
- Measure the share of dismissed findings from the first day. A noisy reviewer loses the developers' trust quickly.
- Watch that people do not review less carefully because the agent already looked.

## Level 2: agents do small jobs

The team's own tools give a few agents bounded tasks. A person reviews every agent's change and merges it.

- "Small" is a rule, not a feeling: size and risk of the task, the paths it may touch, no safety-classed code unless the level of that code class allows it.
- `howl` checks that an agent's change stays within the paths and size of its class, and that a person verified it and merged it. It reads the tracker and writes nothing to it.

## Level 3: an agent team

Agents build and review each other in a bounded number of rounds. The team's own deterministic program, never a model, merges a change that passes every condition of one table, and leaves every other change to a person. People decide what is built (breakdown, requirements, order), take what the rules name (changed tests, large deletes, changes to the rules, the prompts and the program itself, anything high risk) and what is stuck (open findings after the last round, a red main branch).

The program that merges is the team's. `howl` checks that each merge met the table, and records a broken rule where one did not.

## Rules for moving between levels

- **The level is set per code class, not per company.** Unclassified code can be at level 3 while safety-classed code stays at level 1. This is what lets a safety manager say yes. A code class is a set of paths with a classification (for example QM, ASIL A–D, or the team's own classes).
- **Shadow mode before every step up.** `howl` says which changes would have met the next level's conditions, while people still do the work as the level in force asks. The figures are the grounds for the step.
- **A step up is a recorded decision by a person.** The ledger shows that a code class went from one level to the next, who approved it and on which figures. This is change management of the tool, which the standards ask for.
- **A step down is a broken rule and a notice.** A red main branch, or too many wrong findings, is recorded as a broken rule, and a notice goes out. Stopping a merge is the code host's (a ruleset) or the team's own tool's, never `howl`'s.
- **Some rules are not configuration.** A change in safety-classed code needs a human verifier at every level. The core always checks such rules, and no project can switch the check off.

## What varies with the level

Two arguments, and nothing else, change from level to level:

| Level | Confidence in the tool | Independence |
|---|---|---|
| 0 No agents | An AI tool, where one is declared, is the person's tool | A person reviews a person |
| 1 Review | The agent is an addition and cannot introduce a fault | A person reviews a person, as before |
| 2 Small jobs | The agent can introduce a fault; the human review and the tests catch it | The person is independent of the agent |
| 3 Agent team | The same, but detection rests more on tests and rules | Has to be shown: one agent does not count as independent of another |

See [standards.md](standards.md) for how these arguments are made.
