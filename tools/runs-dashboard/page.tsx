/** @jsxImportSource preact */
// The dashboard's markup: the design spec of spy4x/dotfiles#256, library components only.

import type { ComponentChildren, JSX } from "preact"
import { renderToString } from "preact-render-to-string"
import { Badge, type BadgeColor } from "@spy4x/preact-ui/badge"
import { DataTable } from "@spy4x/preact-ui/data-table"
import { EmptyState } from "@spy4x/preact-ui/empty-state"
import { ErrorState } from "@spy4x/preact-ui/error-state"
import { When } from "@spy4x/preact-ui/format"
import { Grid, Page, Stack } from "@spy4x/preact-ui/layout"
import { Notice } from "@spy4x/preact-ui/notice"
import { PageHeader } from "@spy4x/preact-ui/page-header"
import { UsageMeter } from "@spy4x/preact-ui/usage-meter"
import { WidgetCard, type WidgetSize } from "@spy4x/preact-ui/widget-card"
import { Kpi, KpiGrid } from "@spy4x/preact-charts/kpi"
import { LineChart } from "@spy4x/preact-charts/line-chart"
import { type RankedBarColumns, RankedBars } from "@spy4x/preact-charts/ranked-bars"
import type { Dashboard, QueueItem, RankedRow, RunRow, Section } from "./data.ts"
import { DAILY_BUDGET_USD, RUN_ALERT_USD } from "../agent-budget.ts"
import { type Banner, type BannerItem, FAILED_STATUSES, needsYou } from "./needs-you.ts"

/** What the whole page shows: the data, or why there is none. */
export type PageState =
  | { kind: `missing`; path: string }
  | { kind: `unreadable`; path: string }
  | { kind: `ready`; path: string; data: Dashboard }

// ===== Formatting =====

const wholeUsd = new Intl.NumberFormat(`en-US`, {
  style: `currency`,
  currency: `USD`,
  maximumFractionDigits: 0,
})
const centsUsd = new Intl.NumberFormat(`en-US`, { style: `currency`, currency: `USD` })
/** Dollars, with cents below $10: "$4.20", "$142"; zero is "$0". */
export const usd = (value: number): string =>
  (value !== 0 && Math.abs(value) < 10 ? centsUsd : wholeUsd).format(value)
const durationFormat = new Intl.DurationFormat(`en`, { style: `short` })
/** "1 hr, 12 min"; seconds only under a minute. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return durationFormat.format({ seconds: total })
  const minutes = Math.round(total / 60)
  return durationFormat.format({ hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}
const timeFormat = new Intl.DateTimeFormat(`en-GB`, {
  weekday: `short`,
  hour: `2-digit`,
  minute: `2-digit`,
})
const dayFormat = new Intl.DateTimeFormat(`en-US`, { month: `short`, day: `numeric` })
const issueNumber = (issue: string) => `#${issue.split(`#`)[1] ?? issue}`
/** `owner/repo#n` → its GitHub address; anything else → no link. */
export function issueUrl(issue: string): string | undefined {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(issue)
  return match ? `https://github.com/${match[1]}/issues/${match[2]}` : undefined
}
/** The house focus ring for inline links: 2 px, 2 px from the text. */
const LINK =
  `rounded-xs underline underline-offset-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-focus`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ===== Page =====

/** The whole HTML document for `state`; `css` gets the body's markup and returns its stylesheet. */
export function renderDocument(state: PageState, css: (body: string) => string): string {
  const body = renderToString(<DashboardPage state={state} />)
  return `<!doctype html><html lang="en" data-theme-auto><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><title>Agent runs</title>` +
    `<style>${css(body)}</style></head><body class="theme-base bg-background text-foreground">` +
    `${body}</body></html>`
}

function DashboardPage({ state }: { state: PageState }): JSX.Element {
  const data = state.kind === `ready` ? state.data : null
  return (
    <main class="py-6 sm:py-8">
      <Page class="max-w-5xl gap-6">
        <Stack gap="xs">
          <PageHeader
            title="Agent runs"
            headingLevel={1}
            subtitle={data?.banner.lastImport
              ? (
                <>
                  Updated <When at={data.banner.lastImport} now={data.now} />
                </>
              )
              : undefined}
          />
          <p class="text-sm text-muted">
            Background lead and Claude Code spend. Days end at midnight, local time.
          </p>
        </Stack>
        {state.kind === `missing`
          ? (
            <EmptyState
              title="Can't find the run database"
              headingLevel={2}
              description={`at ${state.path}.`}
              class="wrap-anywhere"
            />
          )
          : state.kind === `unreadable`
          ? (
            <ErrorState
              class="wrap-anywhere"
              message={`Can't read the run database at ${state.path}. Check that this user owns the folder and its mode is 0700, then reload.`}
            />
          )
          : <Cards data={state.data} />}
        <p class="text-xs text-muted">
          Read-only. Reads <code class="break-all">{state.path}</code>{" "}
          and changes nothing. Prompts and tool output are not shown.
        </p>
      </Page>
    </main>
  )
}

function Cards({ data }: { data: Dashboard }): JSX.Element {
  return (
    <Stack gap="lg">
      {data.empty
        ? (
          <Notice tone="info" title="No runs yet.">
            The database is ready. The lead starts a run on the next tick, every 30 minutes.
          </Notice>
        )
        : <NeedsYou banner={needsYou(data.banner)} />}
      <TodayCard data={data} />
      <KpiSection data={data} />
      <Card
        title="Spend per day, 30 days"
        section={data.daily}
        empty="No sessions imported yet."
        size="full"
      >
        {(daily) => (
          <LineChart
            series={Object.entries(daily.kinds).map(([kind, values]) => ({
              name: KIND_NAMES[kind] ?? kind,
              points: daily.days.map((day, i) => ({ x: day, y: values[i] })),
            }))}
            xFormat={(x) => dayFormat.format(new Date(`${x}T12:00:00`))}
            yFormat={usd}
            yDomain={[0, Math.max(DAILY_BUDGET_USD * 1.2, ...Object.values(daily.kinds).flat())]}
            referenceValue={DAILY_BUDGET_USD}
            referenceLabel={`Budget ${usd(DAILY_BUDGET_USD)}`}
            ariaLabel="Spend per day for the last 30 days, by kind of session"
            height={220}
          />
        )}
      </Card>
      <Card
        title="Lead runs"
        caption="Last 20, newest first"
        section={data.runs}
        empty="No runs yet."
      >
        {(runs) => <RunsTable runs={runs} now={data.now} />}
      </Card>
      <Grid minColumnWidth="lg" class="items-start">
        <Card
          title="Queue"
          caption={data.queue.status === `ready` ? queueCounts(data.queue.data.counts) : undefined}
          section={data.queue}
          empty="None open."
        >
          {(queue) => <QueueTable items={queue.open} />}
        </Card>
        <Card
          title="Spend by project, 7 days"
          section={data.projects}
          empty="No sessions imported yet."
        >
          {(rows) => (
            <Ranked
              rows={rows}
              title="Spend by project, last 7 days"
              format={usd}
              columns={{ label: `Project`, value: `Cost`, extra: [{ label: `Sessions` }] }}
            />
          )}
        </Card>
        <Card title="Time lost, 7 days" section={data.timeLost} empty="None in the last 7 days.">
          {(rows) => (
            <Ranked
              rows={rows}
              title="Time lost in the last 7 days"
              format={(m) => duration(m * 60)}
              columns={{
                label: `What`,
                value: `Time`,
                extra: [
                  { label: `Tokens`, format: (n) => n.toLocaleString(`en-US`) },
                  { label: `Cost`, format: usd },
                ],
              }}
            />
          )}
        </Card>
        <Card
          title="Slowest steps, 7 days"
          section={data.slowSteps}
          empty="None in the last 7 days."
        >
          {(rows) => (
            <Ranked
              rows={rows}
              title="Slowest steps in the last 7 days"
              format={duration}
              columns={{
                label: `Step`,
                value: `Time`,
                extra: [{ label: `Result`, format: (n) => (n ? `Failed` : `OK`) }],
              }}
            />
          )}
        </Card>
      </Grid>
    </Stack>
  )
}

const KIND_NAMES: Record<string, string> = {
  interactive: `Interactive`,
  headless: `Headless`,
  subagent: `Subagents`,
}

/** A `WidgetCard` whose state follows its section: ready draws `children`, else the state line. */
function Card<T>(
  { title, caption, section, empty, size = `full`, children }: {
    title: string
    caption?: ComponentChildren
    section: Section<T>
    empty: string
    size?: WidgetSize
    children: (data: T) => ComponentChildren
  },
): JSX.Element {
  return (
    <WidgetCard
      title={title}
      caption={caption}
      status={section.status}
      size={section.status === `ready` ? size : `stat`}
      loadingLabel="Loading"
      emptyLabel={empty}
      errorMessage={`Can't read this part of the database: ${
        section.status === `error` ? section.message : ``
      }`}
    >
      {section.status === `ready` ? children(section.data) : null}
    </WidgetCard>
  )
}

// ===== Needs you =====

function NeedsYou({ banner }: { banner: Banner | null }): JSX.Element {
  if (!banner) return <p class="text-sm text-muted">Nothing needs you</p>
  return (
    <Notice tone={banner.tone} title="Needs you">
      <ul class="flex list-disc flex-col gap-1 ps-5">
        {banner.items.map((item, i) => <li key={i}>{bannerLine(item)}</li>)}
      </ul>
    </Notice>
  )
}

function bannerLine(item: BannerItem): ComponentChildren {
  switch (item.kind) {
    case `paused`:
      return (
        <>
          <strong>The lead is paused:</strong> {item.reason}. No new run starts until you run{" "}
          <code>agent-run unpause</code>.
        </>
      )
    case `over-budget`:
      return (
        <>
          <strong>Today's budget is spent:</strong> {usd(item.todayUsd)} of{" "}
          {usd(DAILY_BUDGET_USD)}. A run already going will finish. No new run starts until
          midnight.
        </>
      )
    case `run`:
      return (
        <>
          <RunLink run={item.run} /> {item.failed ? `failed` : null}
          {item.failed && item.expensive ? ` and ` : null}
          {item.expensive ? `cost ${usd(item.run.costUsd)}` : null}.
        </>
      )
    case `blocked`:
      return (
        <>
          <IssueLink issue={item.issue} /> is blocked: it failed twice and needs a look.
        </>
      )
    case `stalls`:
      return (
        <>{plural(item.count, `session`)} stalled for 10 minutes or more in the last 24 hours.</>
      )
    case `stale-import`:
      return item.lastImport
        ? (
          <>
            Nothing imported since <When at={item.lastImport} />.
          </>
        )
        : <>No sessions imported yet.</>
  }
}

/** "Run #12 (Sat 00:00)": the start time, as in the runs table, tells two runs of one issue apart. */
function RunLink(
  { run }: { run: { id: string; issue: string | null; startedAt: string } },
): JSX.Element {
  return (
    <a class={LINK} href={`#run-${run.id}`}>
      {`Run ${run.issue ? issueNumber(run.issue) : run.id.slice(-6)} (${
        timeFormat.format(new Date(run.startedAt))
      })`}
    </a>
  )
}

function IssueLink({ issue }: { issue: string }): JSX.Element {
  const href = issueUrl(issue)
  return href ? <a class={LINK} href={href}>{issueNumber(issue)}</a> : <span>{issue}</span>
}

// ===== Today =====

function TodayCard({ data }: { data: Dashboard }): JSX.Element {
  return (
    <Card title="Today's budget" section={data.today} empty="No sessions imported yet." size="stat">
      {(today) => (
        <UsageMeter
          label="Spent"
          used={today.usd}
          limit={DAILY_BUDGET_USD}
          warnAt={75}
          format={usd}
          labels={{ value: (used, limit) => `${used} of ${limit}` }}
        />
      )}
    </Card>
  )
}

function KpiSection({ data }: { data: Dashboard }): JSX.Element {
  if (data.kpis.status !== `ready`) {
    return (
      <Card title="Key figures" section={data.kpis} empty="No runs yet." size="stat">
        {() => null}
      </Card>
    )
  }
  const k = data.kpis.data
  const perHundred = (merged: number, cost: number) =>
    merged === 0 || cost === 0 ? { value: `–`, sub: `No merged issues yet` } : {
      value: ((merged / cost) * 100).toFixed(1),
      sub: `${plural(merged, `issue`)} for ${usd(cost)}`,
    }
  const week = perHundred(k.merged7, k.cost7)
  const month = perHundred(k.merged30, k.cost30)
  return (
    <KpiGrid minWidth="9rem">
      <Kpi tone="neutral" label="Merged per $100, 7 days" value={week.value} sub={week.sub} />
      <Kpi tone="neutral" label="Merged per $100, 30 days" value={month.value} sub={month.sub} />
      <Kpi
        tone="neutral"
        label="Runs today"
        value={k.runsToday}
        sub={k.runningNow > 0 ? `${k.runningNow} running now` : `None running`}
      />
      <Kpi
        tone="neutral"
        label="Failed runs, 7 days"
        value={k.failed7}
        sub="2 in a row pause the lead"
      />
    </KpiGrid>
  )
}

// ===== Runs =====

const RUN_STATUS: Record<string, { text: string; color: BadgeColor; title?: string }> = {
  running: { text: `Running`, color: `blue` },
  done: { text: `Done`, color: `green` },
  blocked: { text: `Blocked`, color: `orange`, title: `Failed twice. Needs a look.` },
  parked: {
    text: `Parked`,
    color: `gray`,
    title: `Waiting for slow CI. A later tick picks it up.`,
  },
  stopped: { text: `Stopped`, color: `gray` },
}
const FAILED_BADGE = { text: `Failed`, color: `red` as BadgeColor }

function runStatus(status: string) {
  return FAILED_STATUSES.includes(status)
    ? { ...FAILED_BADGE, title: `Ended as "${status}"` }
    : RUN_STATUS[status] ?? { text: status, color: `gray` as BadgeColor }
}

function StatusBadge(
  { status }: { status: { text: string; color: BadgeColor; title?: string } },
): JSX.Element {
  return (
    <span title={status.title}>
      <Badge text={status.text} color={status.color} type="outline" />
    </span>
  )
}

function RunsTable({ runs, now }: { runs: RunRow[]; now: number }): JSX.Element {
  return (
    <DataTable<RunRow, `id`>
      caption="Lead runs"
      captionHidden
      mode="server"
      rows={runs}
      sort={[]}
      onSortChange={() => {}}
      rowKey={(run) => run.id}
      columns={[
        { id: `run`, header: `Run`, render: (run) => <RunCell run={run} now={now} /> },
        {
          // Status and cost share a column: three columns do not fit a 390 px phone in DataTable.
          id: `status`,
          header: `Status, cost`,
          align: `right`,
          render: (run) => (
            <div class="flex flex-col items-end gap-1">
              <StatusBadge status={runStatus(run.status)} />
              {run.costUsd > RUN_ALERT_USD
                ? <Badge text={`Over ${usd(RUN_ALERT_USD)}`} color="red" type="filled" />
                : null}
              {run.status === `running` && run.costUsd === 0
                ? (
                  <span>
                    <span aria-hidden="true">–</span>
                    <span class="sr-only">No spend yet</span>
                  </span>
                )
                : <span class="tabular-nums">{usd(run.costUsd)}</span>}
            </div>
          ),
        },
      ]}
    />
  )
}

const MODE_NAMES: Record<number, string> = { 1: `Read`, 2: `Write`, 3: `Lead` }

function RunCell({ run, now }: { run: RunRow; now: number }): JSX.Element {
  const end = run.endedAt ? Date.parse(run.endedAt) : now
  const started = timeFormat.format(new Date(run.startedAt))
  // A run without an issue has no title of its own: its mode and start time name it.
  const title = run.title ??
    (run.issue ? run.name : `${MODE_NAMES[run.mode ?? 0] ?? `Agent`} run, ${started}`)
  const details = [
    run.issue ? started : null,
    duration((end - Date.parse(run.startedAt)) / 1000),
    run.reviewRounds ? plural(run.reviewRounds, `review round`) : null,
    run.ciWaitSec ? `CI wait ${duration(run.ciWaitSec)}` : null,
    run.parent
      ? `child of run ${run.parentIssue ? issueNumber(run.parentIssue) : run.parent.slice(-6)}`
      : null,
  ].filter(Boolean)
  return (
    <div id={`run-${run.id}`} class="flex min-w-0 flex-col gap-1">
      <span class="line-clamp-2 font-medium">
        {run.issue
          ? (
            <>
              <IssueLink issue={run.issue} />
              {` `}
            </>
          )
          : null}
        {title}
      </span>
      <span class="text-xs text-muted">{details.join(` · `)}</span>
    </div>
  )
}

// ===== Queue =====

const QUEUE_COUNT_ORDER = [`blocked`, `declined`, `queued`, `claimed`, `done`, `dropped`]

function queueCounts(counts: Record<string, number>): string {
  const known = QUEUE_COUNT_ORDER.filter((status) => counts[status])
  const other = Object.keys(counts).filter((status) => !QUEUE_COUNT_ORDER.includes(status))
  return [...known, ...other].map((status) => `${counts[status]} ${status}`).join(` · `)
}

const QUEUE_STATUS: Record<string, { text: string; color: BadgeColor; title?: string }> = {
  blocked: { text: `Blocked`, color: `orange`, title: `Failed twice. Needs a look.` },
  declined: {
    text: `Declined`,
    color: `purple`,
    title: `Not startable yet. Back in the queue once the issue changes.`,
  },
  claimed: { text: `Claimed`, color: `blue` },
  queued: { text: `Queued`, color: `gray` },
}
const PARKED = {
  text: `Parked`,
  color: `gray` as BadgeColor,
  title: `Waiting for slow CI. A later tick picks it up.`,
}

function QueueTable({ items }: { items: QueueItem[] }): JSX.Element {
  return (
    <DataTable<QueueItem, `issue`>
      caption="Open queue items"
      captionHidden
      mode="server"
      rows={items}
      sort={[]}
      onSortChange={() => {}}
      rowKey={(item) => item.issue}
      empty={<p class="text-sm text-muted">None open.</p>}
      columns={[
        {
          id: `item`,
          header: `Issue`,
          render: (item) => (
            <div class="flex min-w-0 flex-col gap-1">
              <span class="line-clamp-2">
                <IssueLink issue={item.issue} /> {item.title}
              </span>
              {item.reason || item.attempts
                ? (
                  <span class="text-xs text-muted">
                    {[item.reason, item.attempts ? `${item.attempts} of 2 failed` : null]
                      .filter(Boolean).join(` · `)}
                  </span>
                )
                : null}
            </div>
          ),
        },
        {
          id: `status`,
          header: `Status`,
          render: (item) => (
            <StatusBadge
              status={/^parked/i.test(item.reason ?? ``) &&
                  ![`blocked`, `declined`].includes(item.status)
                ? PARKED
                : QUEUE_STATUS[item.status] ?? { text: item.status, color: `gray` }}
            />
          ),
        },
      ]}
    />
  )
}

// ===== Top-5 lists =====

function Ranked(
  { rows, title, format, columns }: {
    rows: RankedRow[]
    title: string
    format: (value: number) => string
    columns: RankedBarColumns
  },
): JSX.Element {
  return <RankedBars data={rows} columns={columns} format={format} ariaLabel={title} />
}
