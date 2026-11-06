import { assertEquals } from "jsr:@std/assert@1.0.19"
import { buildPlan, byDue, focusRepo, isCandidate, type Issue } from "./agent-queue.ts"

const issue = (number: number, labels: string[] = [], milestone?: string): Issue => ({
  number,
  title: `Issue ${number}`,
  labels: labels.map((name) => ({ name })),
  author: { login: `spy4x` },
  milestone: milestone ? { title: milestone } : null,
  createdAt: `2026-11-${String(number).padStart(2, `0`)}T00:00:00Z`,
})

Deno.test(`the focus repository is the first bold word under "Focus now"`, () => {
  const text =
    `## Stack\n\n**Deno** first.\n\n## Focus now\n\n- **Financy**, with Seed.\n\n## Next\n`
  assertEquals(focusRepo(text), `spy4x/financy`)
  assertEquals(focusRepo(`## Focus now\n\nNothing bold.\n## Next\n**Seed**`), null)
})

Deno.test(`low priorities count only inside a milestone, other authors never`, () => {
  assertEquals(isCandidate(issue(1, [`p4-low`]), false), false)
  assertEquals(isCandidate(issue(1, [`p4-low`]), true), true)
  assertEquals(isCandidate({ ...issue(1), author: { login: `stranger` } }, true), false)
  assertEquals(isCandidate(issue(1, [`in-progress`]), true), false)
  assertEquals(isCandidate(issue(1, [`in-progress`]), true, true), true)
  assertEquals(isCandidate(issue(1, [`needs-decision`]), true, true), false)
})

Deno.test(`milestones run due first, undated last`, () => {
  const order = byDue([
    { number: 1, title: `undated`, due_on: null },
    { number: 2, title: `december`, due_on: `2026-12-01T00:00:00Z` },
    { number: 3, title: `november`, due_on: `2026-11-20T00:00:00Z` },
  ])
  assertEquals(order.map((m) => m.title), [`november`, `december`, `undated`])
})

Deno.test(`an issue the loop itself claimed stays planned despite its in-progress label`, () => {
  const focus = {
    repo: `spy4x/financy`,
    issues: [issue(1, [`in-progress`]), issue(2, [`in-progress`])],
    milestones: [],
  }
  const plan = buildPlan(focus, [], new Map(), new Set([`spy4x/financy#1`]))
  assertEquals(plan, [{ issue: `spy4x/financy#1`, title: `Issue 1`, source: `backlog` }])
})
