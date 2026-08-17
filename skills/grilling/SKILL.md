---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any "grill" trigger phrases.
license: MIT; see NOTICE.md and ../../LICENSE
---

# Grilling

Interview the user relentlessly until you reach a shared understanding. Map
this as a **design tree**: every decision branches into the decisions that hang
off it.

Work the tree in **rounds**. The **frontier** is every decision whose
prerequisites are already settled: the questions you can ask now without
guessing at answers you have not heard yet. Use `request_user_input` to ask up
to three independent frontier questions in each round, preferring one when
possible. Give each question 2-3 concrete choices and put your recommended
answer first. Then wait for the user's answers before the next round.

Each round reshapes the tree: settled decisions push the frontier outward and
unblock questions that depended on them. Recompute the frontier and ask the
next round. A question whose answer depends on another question still open in
this round belongs to a later round, not this one.

Finding **facts** is your job, never the user's. Use the supplied context and
available tools to inspect the editor, filesystem, repository, and
documentation; parallelize independent lookups when possible. Do not ask the
user for anything you can discover yourself. The **decisions** are the user's:
put each to them and wait.

The session is done when the frontier is empty: every material branch of the
design tree has been visited and nothing is left silently assumed. Summarize
the shared understanding, then use `request_user_input` to ask the user to
confirm or revise it. Do not act on the plan until the user confirms.
