---
name: scope-usecase
description: Scope one client use case before building it — gather its context from Notion and Slack, then grill the engineer until the problem, data, environment and success criteria are settled. Use when starting a use case, or turning call notes or a transcript into a scope.
---

Run the `/grilling` interview on **one** client use case. Problem before solution: settle what hurts
and what fixing it is worth before naming any architecture.

## Context first

Search Notion and Slack for the use case before asking anything: the account page, meeting notes and
transcripts, channel threads, specs of similar use cases. Feed what you find into the grilling as
your recommended answers, citing the source, so the engineer confirms rather than recalls. Dispatch
the search to a sub-agent and start on the questions that do not depend on it.

## What the grilling settles

- **Problem and value** — how it is done today, the pain in time, cost or error rate, who wants it
  fixed.
- **Scope** — what the AI does, what is explicitly out, who uses it. A slice provable in two to three
  months.
- **Data** — sources, format, volume, and whether access is open today.
- **Environment** — cloud, on-prem or private; systems to integrate; security constraints.
- **Success** — metrics, thresholds, and who validates the outputs.

When neither the engineer nor the sources know, record an open question for the customer and move on.

## Done

Every item above is settled or an open question. Then suggest the user run `/to-spec` to turn the
session into a spec. When `/create-usecase` started this session, return to it with the spec.
