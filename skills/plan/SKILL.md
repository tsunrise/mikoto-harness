---
name: plan
description: Research and write a decision-complete Markdown implementation plan. Use only when the user explicitly invokes this skill (for example, /skill:plan in Pi or $plan in a harness that supports it). Do not select for ordinary requests to plan or design work.
disable-model-invocation: true
---

# Plan

The user wants to agree on an implementation plan before implementation starts. Produce a Markdown plan file that is **decision complete**: another engineer or agent should be able to implement it without making material decisions.

Use this skill only when explicitly invoked. It applies to the **current planning request**, not to the entire session. A subsequent request to implement the plan is an ordinary implementation request; do not automatically reapply this skill to it. 

## Scope of this request

- Treat the user's task description as the subject of the plan, not permission to implement it now. Answers to planning questions refine the plan; they are not approval to implement.
- Research, questions, and the plan file are the deliverables. Do not write feature code, create branches, commit or stage files, generate or run migrations, deploy, or make unrelated external changes.
- You may read and search files, configs, schemas, manifests, types, and documentation; run static analysis, temporary probe scripts, dry runs, tests, and builds that improve the plan. Temporary files and narrowly scoped temporary edits to tracked files are allowed **only** to test a hypothesis or validate the plan. If an action would reasonably be described as "doing the work" rather than "planning the work", don't do it.
- If the request explicitly asks for both a plan and implementation now, clarify the intended scope rather than silently implementing under this skill.

### Clean up research changes

Prefer scratch files outside the repository. Before touching repository files, inspect existing changes and preserve their pre-research contents, including preexisting uncommitted edits. Keep track of exactly which changes and temporary files are yours.

Before publishing or revising the plan, remove your temporary files and undo **only** your research edits. Check the relevant diff afterward to confirm that the user's changes remain intact. Never use blanket reset, checkout, or clean commands, and never overwrite concurrent user edits. If safe cleanup is uncertain, report the remaining paths and resolve the conflict instead of calling the plan final.

Writing or revising the plan file is allowed. Filesystem changes are not rolled back automatically when the request ends, the session resumes, or the user navigates the session tree.

## Phase 1: Ground in the environment (explore first, ask second)

Begin by learning the actual environment. Resolve unknowns by discovering facts, not by asking the user. Answer every question that exploration or inspection can answer, and identify missing or ambiguous details only when the environment cannot resolve them. Silent exploration between turns is encouraged.

Before asking the user any question, do at least one targeted non-mutating exploration pass (for example: search relevant files, inspect likely entry points and configs, confirm the current implementation), unless no local environment or repository is available.

Exception: you may ask clarifying questions before exploring ONLY if the prompt itself has obvious ambiguities or contradictions. If exploring might resolve the ambiguity, explore first.

Do not ask questions the repository or system can answer (for example, "where is this struct?" or "which UI component should we use?" when exploration can make it clear). Ask only after reasonable exploration.

## Phase 2: Intent (what the user actually wants)

Keep asking until you can clearly state: goal and success criteria, audience, what is in and out of scope, constraints, current state, and the key preferences and tradeoffs. Prefer asking over guessing: if high-impact ambiguity remains, clarify it before finalizing the plan.

## Phase 3: Implementation (what to build and how)

Once intent is stable, keep clarifying until the spec is decision complete: approach, interfaces (APIs, schemas, inputs and outputs), data flow, edge cases and failure modes, testing and acceptance criteria, rollout and monitoring, and any migration or compatibility constraints relevant to the task.

## Asking questions

- Strongly prefer the `request_user_input` tool when available. If it is not available, ask in chat instead.
- With `request_user_input`, put the recommended option first and add "(Recommended)" to its label. Offer only meaningful options; leave out filler choices that are obviously wrong or irrelevant.
- If an unavoidable, important question can't be expressed as reasonable multiple-choice options, ask it directly.

Ask as many questions as needed, but each question must:

- materially change the plan, confirm or lock an assumption, or choose between meaningful tradeoffs; and
- not be answerable by non-mutating commands.

### Two kinds of unknowns

1. **Discoverable facts** (repository or system truth): explore first. Before asking, run targeted searches and check likely sources of truth (configs, manifests, entry points, schemas, types, constants). Ask only if there are several plausible candidates, nothing was found but you need a missing identifier or context, or the ambiguity is really about product intent. When asking, present concrete candidates and recommend one.
2. **Preferences and tradeoffs** (not discoverable): ask early. Offer 2–3 mutually exclusive options with a recommended default. If unanswered, proceed with the recommended option and record it as an assumption in the plan.

## Finalizing and revising the plan

Write the plan only when it is decision complete and research cleanup is verified. Write the complete plan to `docs/plans/<YYYYMMDD>-<short-kebab-task-name>.md` under the working directory where the planning request began (use its local date). Use that working directory as the workspace root even if you inspect nested Git repositories. Do not overwrite an unrelated existing plan; choose a distinct name if needed.

Summarize the plan and point to the file. Do not ask "should I proceed?"; the user can request implementation in a later message.

If the user invokes this skill to revise an existing plan, answer questions that do not change the plan without editing it; otherwise, edit the existing plan in place.
