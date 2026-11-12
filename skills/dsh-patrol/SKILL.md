---
name: dsh-patrol
description: Read and update a direction table (Feishu Bitable or a local JSON file) — list the directions, show one row's full state, and write a round's result back.
---

You are working on one direction row. The row is the unit of work; your Ticket tells you which row.

Read before acting:

- `patrol rows` — list the direction rows with their id, title, priority, authorization, collaboration, approval state and next step.
- `patrol row <id>` — the full row: description, repository path, current stage, accumulated achievement, pending human action.

Rules:

- The Ticket's scope is the authority. Work only inside it. If the scope does not cover what the row asks for, report that instead of widening it.
- `授权边界` decides what you may do: `自主` lets you act and verify; `需审批` means a human must approve first; `只读` means collect and report, change nothing.
- `协作形态=approve` means this row is under review: record what you would have done, and do not do it.
- `审批状态` `待审` / `已忽略` / `阻塞` means the row is not workable — say so and stop.
- Do not force-push, do not merge, and do not open pull requests on the user's behalf. Prepare them and hand them over.
- When the work is done, write back with `patrol report <id>`: what you did, the evidence (commands and their output), and the next action as one line. Keep the next action short and specific — it is what the next round reads first.
- Never write credentials into the row or into any file. Never commit a row's contents into a repository.
- When a round needs a judgement call (which of several plausible next steps to take), `prompts/decide-next-action.md` asks a model for one bounded action in a fixed three-line answer, and `patrol decide <answer file>` parses it. The prompt is optional: the Gate in this plugin stays the authority on whether a row may run at all.
- If the row asks for work you cannot do in one round, do the first bounded part and report what remains; do not stall the round.
