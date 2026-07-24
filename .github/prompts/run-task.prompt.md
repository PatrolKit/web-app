---
mode: agent
description: Implement a single PatrolKit task from docs/plan/TASKS.md end to end.
---

Implement task **${input:taskId:Task ID, e.g. P2-T4}** from [TASKS.md](../../docs/plan/TASKS.md).

Follow these rules:

1. Read the task card for **${input:taskId}** in `docs/plan/TASKS.md`, plus the **Global
   Conventions**, **Global Guardrails**, and **Definition of Done** at the top of that file.
2. Consult [IMPLEMENTATION_PLAN.md](../../docs/plan/IMPLEMENTATION_PLAN.md) for any sections the
   card references (e.g. §5, §7).
3. Confirm the task's **Depends on** prerequisites appear complete. If they are not, stop and say
   so instead of implementing them.
4. Implement only what the card specifies — stay within its **Touches** paths and respect the
   repo `.github/copilot-instructions.md` guardrails (foundation only; hash all tokens/secrets;
   scope every query by `orgId`; single origin).
5. Add/adjust tests for the task.
6. Verify before finishing:
   ```bash
   pnpm -r build && pnpm -r lint && pnpm -r test
   ```
7. Ensure every **Acceptance criteria** checkbox on the card is satisfied.

When done, output a short summary: files changed, how each acceptance criterion is met, and the
suggested conventional-commit message.
