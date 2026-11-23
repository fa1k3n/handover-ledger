# Vision

## The problem

Teams that develop software under safety and security regulation are asking how to bring AI into their development. Their question is "how do we run AI in our development?", not "where do we get an event log?". What stops them is seldom the model's ability. It is that they cannot answer an assessor:

- Which code may an agent touch?
- Who or what wrote this change, with which model, prompt and rules?
- Who checked it, and was that check independent?
- Which requirement does the change belong to, and which test would fail without it?
- Can the tool that wrote or reviewed the code be trusted, and on what grounds?

## Who it is for

Development of embedded and other software under functional safety and security standards: automotive first (ISO 26262, ISO/SAE 21434, Automotive SPICE), with the same pattern in IEC 61508, EN 50128, DO-178C, IEC 62304 and IEC 62443. These fields already demand independence between the one who develops and the one who verifies, and traceability from requirement to test to code. An agent team has to meet the same demands, and can.

## What it is

A platform, configured to the team's own environment, with three things that belong together:

1. **Levels of autonomy, as rules the ledger checks.** A team starts with no agents, then agents that only review code people write, then lets a few agents do small jobs with a person reviewing each merge request, and ends where agents do nearly everything and people decide what is built. The team declares its level per code class and its own tools do the work; the ledger checks that what happened stays within the level. See [levels.md](levels.md).
2. **One process, one trace chain.** The steps and the chain requirement → change → test → verification → review → release are the same at every level. The level only changes who performs each step. See [traceability.md](traceability.md).
3. **A ledger.** Every handover between team members, human or agent, is recorded in a tamper-evident log that can be exported as evidence per control of a standard. See [architecture.md](architecture.md) and [standards.md](standards.md).

An assessor who picks a sample (a change, a requirement, a CVE) is answered with the path, and how far each step of it is established: only the source's word, a second source that agrees, or what `howl` checked itself ([architecture.md](architecture.md#assurance)).

It also shows the agents' work as it happens, across projects, repositories and machines, build hosts too. Each machine's hook sends its events live to the server of the organisation, which is witness, index and dashboard ([decisions.md](decisions.md), 2026-11-13). `howl` may send a notice out, such as a broken rule or a session waiting for a person, for a person or a team's own tool to act on. Acting on it is never `howl`'s.

## What it is not

- Not another orchestrator. Code hosts and trackers are building orchestration of agents themselves, and it is becoming a commodity. The platform records whichever agents and tools the team uses, and steers none.
- Not a review bot. That field is crowded. At the first level the platform records any reviewer and checks the rules around it.
- Not a requirements tool. Requirements stay in the team's own tool and are read through a port.
- Not certified, and it cannot be. It supports the team's own certification. Say "supports ISO 26262 / ISO/IEC 27001 certification" or "audit-ready", never "ISO certified".

## The offer

Open source, with consulting for the integration at a client:

- **Mapping:** where the team stands, which code classes can go to which level, what their assessor will need.
- **Pilot with one team:** levels 0 and 1 in their own environment, with figures.
- **Custom rules and adapters.** New adapters can become open source.

The method is what a client can buy now: which code classes agents may touch, how independent review is arranged, how confidence in the tool is argued, which evidence the assessor needs. The tool makes that answer binding and measurable.

## The market

The building blocks exist: agents as team members in code hosts and trackers, and delegation to any coding agent. Sources given in the first discussion, not checked again here:

- https://github.blog/news-insights/product-news/welcome-home-agents/
- https://linear.app/agents
- https://www.atlassian.com/blog/ai-at-work/the-future-of-jira-isnt-just-tracking-work-its-delegating-it

Less covered: rules and governance independent of the tool, mixed teams of people and agents, independent review, traceability, and a guided path from "the agent only looks" to "the agent does nearly everything" in the team's own environment.

## Risks, said plainly

- **Scope.** Core, CLI, dashboard, editor extension and several adapters are too much for one person at once. Build the smallest thing that serves levels 0 and 1, and wait with the rest until someone asks. This is where it fails if it fails.
- **No reference yet.** Nothing has run with a team. The first real proof is a pilot with a client team, which is also the first that can show independence in the sense of a standard.
- **A hash chain proves little alone.** A file that the same party both writes and keeps convinces no auditor without signing or keeping the last hash elsewhere.
- **Noise at the first level.** A reviewing agent raises doubts that turn out to be unfounded, and developers stop reading a noisy reviewer. Measure the share of dismissed findings from the first day.
- **Complacency.** If people review less carefully because an agent already looked, the safety argument is undermined. Watch for it.
- **The name.** "Handover" alone is used by other products, and "Ledger" is a well-known brand. Check package names, the domain and trade marks before the repository becomes public ([decisions.md](decisions.md)).

## Testing the demand before building much

Ask every team the same questions:

1. What stops you today: code leaving the premises, tool qualification, liability and copyright, or the assessor's approval?
2. Which code comes first, unclassified or safety-classed?
3. Which tools are you in (GitLab, Gerrit, Bitbucket, Jira, Polarion, DOORS, codebeamer)? The answer decides which adapter comes after the first.
4. Who decides: the safety manager, quality, or the head of development?
5. Which evidence would your assessor need for a change written by an agent?

And show the control mapping ([standards.md](standards.md)) to two or three safety managers or an assessor: would they accept agent-written code in a safety-classed component with such evidence? If the answer is "not for years", this is still a good build system, but not yet a product.
