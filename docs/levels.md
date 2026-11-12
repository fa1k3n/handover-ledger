# Levels of autonomy

A team gets used to agents one level at a time. The process and its trace chain are the same at every level ([traceability.md](traceability.md)); the level only changes who performs each step.

| Level | The agents | The people |
|---|---|---|
| 0 Records | None. The ledger only reads the flow as it is today | Do everything as before |
| 1 Review | Comment on code that people wrote | Write, review, merge |
| 2 Small jobs | Build bounded tasks | Review every merge request and merge |
| 3 Agent team | Build, and review each other; the program merges on conditions | Decide what is built, take the exceptions |

## Level 0: records

No agent runs. Adapters read the team's tools and the ledger fills with what already happens. This gives figures on lead time and review rounds *before* AI comes in, which the team needs to justify the next step, and it lets a team try the platform without changing how it works.

## Level 1: agents review

An agent comments on merge requests written by people. It is an addition to the human review and replaces nothing, so it cannot bring a fault into the product. This is the safe way in.

- The platform does not need a reviewer of its own. It governs and records any reviewer, also one built into the code host.
- Measure the share of dismissed findings from the first day. A noisy reviewer loses the developers' trust quickly.
- Watch that people do not review less carefully because the agent already looked.

## Level 2: agents do small jobs

A few agents build bounded tasks. A person reviews every merge request and merges it.

- "Small" is a rule, not a feeling: size and risk of the task, the paths it may touch, no safety-classed code unless the level of that code class allows it.
- Here the tracker adapter, the dispatcher and the named agents come in. Levels 0 and 1 need none of them.

## Level 3: an agent team

Agents build and review each other in a bounded number of rounds. A deterministic program, never a model, merges a change that passes every condition of one table, and leaves every other change to a person. People decide what is built (breakdown, requirements, order), take what the rules name (changed tests, large deletes, changes to the rules, the prompts and the program itself, anything high risk) and what is stuck (open findings after the last round, a red main branch).

## Rules for moving between levels

- **The level is set per code class, not per company.** Unclassified code can be at level 3 while safety-classed code stays at level 1. This is what lets a safety manager say yes. A code class is a set of paths with a classification (for example QM, ASIL A–D, or the team's own classes).
- **Shadow mode before every step up.** The platform says what it would have done at the next level while people still do it, and keeps what they then did. The figures on how often the two agreed are the grounds for the step.
- **A step up is a recorded decision by a person.** The ledger shows that a code class went from one level to the next, who approved it and on which figures. This is change management of the tool, which the standards ask for.
- **Automatic step down.** A red main branch, or too many wrong findings, lowers the level or stops merging until a person has looked. Only a person lifts the stop.
- **Some rules are not configuration.** A change in safety-classed code needs a human verifier at every level. This is enforced by the core and cannot be switched off in a project's configuration.

## What varies with the level

Two arguments, and nothing else, change from level to level:

| Level | Confidence in the tool | Independence |
|---|---|---|
| 1 Review | The agent is an addition and cannot introduce a fault | A person reviews a person, as before |
| 2 Small jobs | The agent can introduce a fault; the human review and the tests catch it | The person is independent of the agent |
| 3 Agent team | The same, but detection rests more on tests and rules | Has to be shown: one agent does not count as independent of another |

See [standards.md](standards.md) for how these arguments are made.
