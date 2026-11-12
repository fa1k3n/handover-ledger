# Standards

**A draft.** The clause numbers below are written from memory and have to be checked against the edition in use before anything goes to a client. Nothing here is a claim of compliance.

## What may be said

The platform cannot be certified. It makes the team's own certification possible. Say "supports ISO 26262 / ISO/SAE 21434 / ISO/IEC 27001 certification" or "audit-ready". Never "ISO certified".

## The central argument: confidence in the use of software tools

ISO 26262-8 clause 11 classes a tool by its impact (TI: can a malfunction introduce a fault, or fail to detect one?) and by how surely such a malfunction is detected (TD), which gives a tool confidence level (TCL1–TCL3). TCL1 needs no qualification.

- **An agent that writes code** can introduce a fault (TI2). If everything it writes goes through independent verification with high detection (a person, tests, static analysis), detection is high (TD1) and the result is TCL1. The ledger is the evidence that this verification took place for every change.
- **An agent that reviews** and is the only review can fail to detect a fault with nothing behind it (TI2, TD3, so TCL3), and a language model can hardly be qualified. It therefore has to be an addition to the human review, never its replacement. As an addition it removes nothing from the existing verification.

Consequences for the platform:

- "A change in safety-classed code needs a human verifier" is logic of the core, not a project's choice.
- The argument is delivered as a ready evidence package: for each change, the verification that covered the agent's output.
- The same reasoning exists in DO-330 (tool qualification for DO-178C) and IEC 61508-3 (tool classes T1–T3).

## Independence

"Another agent and a higher model level" is a rule for quality. It is not evidence of independence: two agents of the same model family are not independent in the sense of a standard, and neither are two sessions run under one person's account.

- ISO 26262-2 asks for confirmation measures with independence I0–I3 depending on the ASIL: from "another person" up to a person or organisation independent in management, resources and release authority.
- For I2 and I3 the reviewer stands outside the team. That needs real identities in the ledger, and an agent never counts as the independent party.
- Agents need accounts of their own. While agents comment through a person's account, separation cannot be shown.

## First mapping: ISO 26262 and ISO/SAE 21434

| Demand | What the platform has to show |
|---|---|
| ISO 26262-2, confirmation measures with independence I0–I3 | Who reviewed, and for I2/I3 that the person stands outside the team. Real identities; an agent is never the independent party |
| ISO 26262-6, software development: requirements, design, unit verification, integration, testing | The same steps at every level, each with who performed it |
| ISO 26262-8 clause 6, management of safety requirements | The link requirement → test → change per event, both ways. Needs the port to the requirements tool |
| ISO 26262-8 clauses 7–8, configuration and change management | Model ID, role prompt and rule version per change, fixed and reproducible; level changes as recorded decisions |
| ISO 26262-8 clause 9, verification | Which method was used and the result, per clause |
| ISO 26262-8 clause 11, confidence in the use of software tools | The argument above as an evidence package |
| ISO/SAE 21434, tool management and product development | Who has access to the agents' keys and prompts; that the ledger cannot be changed unseen |

## ISO/IEC 27001 and ISO/IEC 42001

From ISO/IEC 27001 Annex A:

| Control | What the platform has to show |
|---|---|
| A 5.3 Segregation of duties | Author and reviewer are different identities; an agent does not merge its own work |
| A 8.15 Logging | The ledger: who, what, when and why per change, with model, role prompt and rule version |
| A 8.25 Secure development life cycle | The rules and the levels as the defined process |
| A 8.29 Security testing in development and acceptance | Test and check results linked to each change |
| A 8.32 Change management | Every change through the same gates; level changes recorded |

ISO/IEC 42001 is the management system standard for AI and applies to the team's use of agents. SOC 2 asks for similar evidence for clients in the United States.

## Automotive SPICE

Teams in the automotive industry are usually assessed against Automotive SPICE as well. It asks for traceability in both directions and consistency through the software engineering processes (SWE.1–SWE.6) and for configuration and change request management (SUP.8, SUP.10). It belongs in the same mapping.

## Other standards with the same pattern

Not mapped yet: IEC 61508, EN 50128, DO-178C with DO-330, IEC 62304, IEC 62443-4-1. All of them ask for independence between development and verification, traceability, and controlled changes.

## Demands on the ledger that follow

- Who, what, when and why per change, including model, role prompt and rule version.
- Shown separation of duties.
- Tamper-evident: a hash chain, and signing or keeping the last hash outside the machine that writes it.
- Configurable retention.
- Evidence packages that can be exported per control.
