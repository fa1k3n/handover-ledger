# Observation

How `howl` observes: its sources, the hooks, the readers, and what each keeps and drops. Observation is not a mode. It is all `howl` does: it records what the team's people, agents and tools did, checks it, and steers nothing.

## What it is

The levels ([levels.md](levels.md)) are the team's: how much its agents may do. `howl` records at every level, and checks the work against the level declared. A team can let its agents do nearly everything and still see what they do during an assignment. That is what no code host shows.

Trying `howl` changes nothing in the team's flow.

## Two sources of events

| Source | Shows | How |
|---|---|---|
| Hooks of the coding agent (Claude Code first) | Session start, every tool call, waiting for a person, the end, per agent | `howl hook`, called from the agent's settings |
| The code host | Task given to a team member, change opened, checks, review, rounds, merge | `howl observe` reads the repository every minute |

The hooks are needed for a second reason. The code host sees accounts, not sessions: it cannot tell which model worked, in which role, or that a session waited for a person. The hook records the name a session was given, as the session's claim. Where sessions act through a person's account, the code host sees that person, and by the three kinds of contributor the work is the person's ([architecture.md](architecture.md#who-contributes)); the name is then a claim about a tool, not an agent the host knows.

An event from a hook is a claim by the agent's own session; an event read from the code host is observed. Each event is marked with which it is ([traceability.md](traceability.md)).

## The parts

1. **The schema and the ledger.** The event schema as JSON Schema, a ledger file with a hash chain kept outside the repository, and `howl verify`. An event does not know its place: the hash of the line before belongs to the line, not to the event.
2. **`howl hook`.** Reads the hook's JSON and puts an event in an inbox. Several sessions write at once, so only one process brings the events into the chain. `howl emit` lets a script do the same.
3. **`howl observe`.** The reader of the code host. It also empties the inbox.
4. **`howl watch` and `howl show <task>`.** The stream in the terminal, and the timeline of one assignment from the hand-over to the merge. `howl watch` shows the handovers of the ledger; `--activity` adds the tool calls. Both print local time; `--utc` prints the times as stored.

The first two already show the agents' work as it happens.

## What the observed repository needs

Two things, and nothing else:

- a `.howl/howl.yml` that names the project,
- the hook lines in the agent's settings.

A session with no actor named leaves nothing: people are not measured one by one. The rule is that only the sessions of agents are recorded, and an agent is a contributor with an account of its own ([architecture.md](architecture.md#who-contributes)); a session whose work reaches the code host under a person's account is that person's, with an assistant. Today `howl` does not hold to this yet: it records a session whenever an actor is named, as an agent's and under any account, and puts that agent on what a person's account did at the code host (#14). #95 changes both.

```yaml
# .howl/howl.yml
project: example
```

## Rules for observing

- **Do not record all content.** A tool call can hold keys and code. Keep the tool, the target and the outcome, not the whole command and its answer. Keep no plain hash of the input either: a short input (`ls`, a file path) can be guessed by hashing candidates. A step that needs to prove what a call's input was adds a keyed hash, with its key beside the ledger. A large organisation will demand the same. With `howl hook` the rest is dropped in the hook's own process. With the hook line that is only `curl`, the hook's JSON reaches `howl up` on the same machine, which keeps the event it builds and never writes, logs or sends back the rest. Before a server runs on another machine, it is decided again where the content is dropped.
- **This is a trial.** Where the agents run as the same user that keeps the ledger, it serves observation but is not evidence. The ledger says so in its first line.
- **Evidence and activity are kept apart.** The chain holds the handovers: a session's start and end, a wait for a person, and what the code host shows. Tool calls are activity: many, kept in a file of their own without a chain, and removed after a time.
- **People are not measured one by one.** A person is named by a pseudonym, kept beside the ledger and never in it. No figure is given per person.
- **One writer.** Hooks and scripts never write to the chain. They leave one file per event in an inbox, and one process brings them in. When that process runs as `howl up`, the hook hands the event to it over HTTP on the same machine, and the writer leaves it in the inbox itself; the file is the way when the writer cannot be reached.
- **A hook never disturbs the session.** It is quick, prints nothing and always ends without an error, also when the ledger cannot be reached.
- **No repository, no event.** Without a `.howl/` folder above the working directory the hook does nothing.

## Scripts

What a team programs itself is Python or a shell script ([architecture.md](architecture.md)). `howl emit` writes an event from a script without building the JSON by hand:

```sh
howl emit checks.passed --change 123 --data '{"check":"static-analysis"}'
```
