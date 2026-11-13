# Commissioning

How Handover Ledger is set up in an organisation: where it runs, who owns what, what lives in the repository and what lives centrally, how agents are provisioned, and the steps from a first trial to a whole organisation.

**In short:** one instance per R&D organisation, with the project as the boundary for rules and evidence inside it. The repository declares what is true about its code in a `.howl/` folder, and the instance decides. Teams and agents are kept centrally and are tied to code through paths, not through repositories.

## Who owns what

| Level | Owns |
|---|---|
| The company's IT | Operation, login, network and backup. Not the rules |
| The R&D organisation (quality and safety) | The instance: basic rules, the ceiling for levels, who may approve a step up |
| The project | The safety plan as rules: code classes, demands on independence, standards. The project is also the boundary for isolation and for the evidence package |
| The team | The work and its paths. A team can ask for a level, never grant itself one |

The instance must not be owned by the team: the ledger would then be kept by those it records, and independent review needs a model of the organisation above the teams. An instance of its own for one project is needed only when a client agreement or export control demands it.

## The structure

- **Instance:** the engine and the ledger of one R&D organisation.
- **Project:** a product development with its safety plan. Holds the rules for its repositories and is what an evidence package is exported for.
- **Repository:** belongs to exactly one project. A shared platform component is a project of its own that delivers its evidence package to the projects that use it.
- **Teams and agents:** defined once in the instance and cut across projects and repositories.

## What lives where

The repository declares, the instance decides.

**In `.howl/` in the repository:** the paths of each code class, the owning team, the level asked for, the source of the requirements, the checks that are mandatory, and the role prompts. The folder is versioned with the code, and a change to it counts as high risk.

**In the instance:** which repositories are enrolled, the rules of each project, teams and agents, keys, and the levels that are approved.

- **Discovery only proposes.** The code host adapter finds repositories with a `.howl/` folder and lists them as waiting. A responsible person enrols them, and that is a ledger entry. Otherwise anyone could start agents by adding a folder.
- **The repository can only be stricter than the rules,** never freer. The level in force is the lower of what the repository asks for and what the instance has approved.

```yaml
# .howl/howl.yml
project: brake-controller
classes:
  - name: asil-b
    paths: [src/control/**]
    owner: team-control
    level: 1            # the level asked for; the ceiling is set in the instance
    checks: [misra, coverage]
  - name: qm
    paths: [tools/**]
    owner: team-tools
    level: 3
```

## Teams and repositories

A team is never bound to a repository. Ownership lies on the path, as in the example above.

- A team with five repositories is named as owner in five `.howl/` files.
- A repository with three teams has at least three code classes.
- A change that touches the paths of two teams follows the rules of both.
- Independence is computed from the model of the organisation: the reviewer must not belong to the owning team, or at a higher demand not to the same department.

## Provisioning agents

An agent is three things, set up separately:

- **Identity.** Created centrally by a responsible person, with an account of its own at the code host, and placed in teams just as a person is. It is a ledger entry.
- **Runner.** Registered with the instance at the level of the organisation, a project or a repository, in the way CI runners are. The runner decides which model is reached (a cloud agreement or a local model) and which toolchain is at hand. Sensitive projects get runners of their own in a network of their own.
- **Entitlement.** Computed from team membership, the level of the code class and the rules. An agent gets a short-lived key per assignment, limited to one repository and one branch. It holds no standing credentials.

## The steps

1. **A trial in an afternoon.** `howl init` creates `.howl/` and runs locally against a ledger file, with no server. The ledger is marked as a trial and does not count as evidence.
2. **A pilot with one team.** One instance in the R&D network, one or two enrolled repositories, level 0. It needs only read access, so the approval from IT is small.
3. **The organisation.** Rules from quality and safety, teams imported from the login service, more repositories.

The rights grow with the level:

| Level | The instance needs |
|---|---|
| 0 Records | To read repositories and merge requests |
| 1 Review | To comment, and a runner with a model |
| 2 Small jobs | To write branches, the tracker, agent identities |
| 3 Agent team | To merge, for the program only |

## A change to `.howl/` is high risk

`howl observe` records a `config.changed` event for every head of a change that touches `.howl/`, with the paths, and the dashboard's overview lists them. Recording shows the change; the code host is where it is stopped until a person has looked. On GitHub:

```
# .github/CODEOWNERS
/.howl/ @the-owner
```

and a rule for the default branch that requires a review from code owners (a ruleset with "Require review from Code Owners", or branch protection). On GitLab, a protected path with an approval rule for `.howl/` does the same.

The keys that sign the agents' claims are held to the ledger's one issuer: `howl verify` fails every key from another issuer, so a new issuer is never taken quietly.

## Commissioning is itself recorded

The first entries of the ledger are the commissioning: the instance created, the version of the rules, each enrolment, each agent provisioned. The installation can then be audited like any other change, and a commissioning report made from those entries is a natural consulting delivery.

## What to build first

Only the trial mode and one instance with one project. But give every event a project ID and a team ID from the first version: cheap now, costly to add later.
