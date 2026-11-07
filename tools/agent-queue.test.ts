import { assert, assertEquals } from "jsr:@std/assert@1.0.19"
import {
  buildPlan,
  buildPlans,
  byDue,
  focusRepos,
  isCandidate,
  type Issue,
  urgentHash,
} from "./agent-queue.ts"

const issue = (number: number, labels: string[] = [], milestone?: string): Issue => ({
  number,
  title: `Issue ${number}`,
  labels: labels.map((name) => ({ name })),
  author: { login: `spy4x` },
  milestone: milestone ? { title: milestone } : null,
  createdAt: `2026-11-${String(number).padStart(2, `0`)}T00:00:00Z`,
  updatedAt: `2026-11-${String(number).padStart(2, `0`)}T00:00:00Z`,
})

Deno.test(`the focus repositories are the one-word bold names under "Focus now", in order`, () => {
  const text = `## Stack\n\n**Deno** first.\n\n## Focus now\n\n- **Financy**, with Seed.\n` +
    `- **A background lead**, a trial.\n- **Seed** next, then **financy** again.\n\n## Next\n`
  assertEquals(focusRepos(text), [`spy4x/financy`, `spy4x/seed`])
  assertEquals(focusRepos(`## Focus now\n\nNothing bold.\n## Next\n**Seed**`), [])
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

Deno.test(`several focus repositories plan each in its own order, as listed, no issue twice`, () => {
  const financy = {
    repo: `spy4x/financy`,
    issues: [issue(2), issue(1, [`p1-critical`])],
    milestones: [],
  }
  const seed = { repo: `spy4x/seed`, issues: [issue(3), issue(4, [`p1-critical`])], milestones: [] }
  const tooling = [issue(5, [`p2-high`])]
  const one = buildPlan(financy, tooling, new Map(), new Set())
  assertEquals(buildPlans([financy], tooling, new Map(), new Set()), one)
  assertEquals(buildPlans([financy, seed], tooling, new Map(), new Set()).map((c) => c.issue), [
    `spy4x/financy#1`,
    `spy4x/dotfiles#5`,
    `spy4x/financy#2`,
    `spy4x/seed#4`,
    `spy4x/seed#3`,
  ])
  // spy4x/dotfiles as a later focus repository: its p2-high fix is already planned as tooling.
  const dotfiles = { repo: `spy4x/dotfiles`, issues: tooling, milestones: [] }
  const twice = buildPlans([financy, dotfiles], tooling, new Map(), new Set())
  assertEquals(twice.filter((c) => c.issue === `spy4x/dotfiles#5`).length, 1)
})

Deno.test(`the backlog holds only issues in no milestone, never one from a later milestone`, () => {
  const focus = {
    repo: `spy4x/financy`,
    issues: [
      issue(1, [], `Now`),
      issue(2, [], `Later`),
      issue(3, [`p3-medium`], `Later`),
      issue(4),
    ],
    milestones: [
      { number: 1, title: `Now`, due_on: `2026-11-20T00:00:00Z` },
      { number: 2, title: `Later`, due_on: null },
    ],
  }
  assertEquals(buildPlan(focus, [], new Map(), new Set()), [
    { issue: `spy4x/financy#1`, title: `Issue 1`, source: `milestone:Now` },
    { issue: `spy4x/financy#4`, title: `Issue 4`, source: `backlog` },
  ])
})

Deno.test(`a milestone whose only issue was declined falls through to the next one`, () => {
  const focus = {
    repo: `spy4x/financy`,
    issues: [issue(1, [], `Now`), issue(2, [], `Later`)],
    milestones: [
      { number: 1, title: `Now`, due_on: `2026-11-20T00:00:00Z` },
      { number: 2, title: `Later`, due_on: null },
    ],
  }
  const statuses = new Map([[`spy4x/financy#1`, `declined`]])
  assertEquals(buildPlan(focus, [], statuses, new Set()).map((c) => c.source), [
    `milestone:Later`,
  ])
})

Deno.test(`the urgent hash changes with a new p1-critical or p2-high tooling issue only`, async () => {
  const focus = [{ repo: `spy4x/financy`, issues: [issue(1)], milestones: [] }]
  const base = await urgentHash(focus, [issue(5, [`p2-high`])])
  assertEquals(await urgentHash(focus, [issue(5, [`p2-high`]), issue(6, [`p3-medium`])]), base)
  assertEquals(
    await urgentHash(focus, [issue(5, [`p2-high`]), issue(6, [`manual`, `p2-high`])]),
    base,
  )
  assert(await urgentHash(focus, [issue(5, [`p2-high`]), issue(6, [`p2-high`])]) !== base)
  assert(await urgentHash(focus, [issue(5, [`p2-high`]), issue(6, [`p1-critical`])]) !== base)
  const critical = [{ ...focus[0], issues: [issue(1), issue(2, [`p1-critical`])] }]
  assert(await urgentHash(critical, [issue(5, [`p2-high`])]) !== base)
  // A p2-high issue in a focus repository other than spy4x/dotfiles is no tooling fix.
  const high = [{ ...focus[0], issues: [issue(1), issue(2, [`p2-high`])] }]
  assertEquals(await urgentHash(high, [issue(5, [`p2-high`])]), base)
})
