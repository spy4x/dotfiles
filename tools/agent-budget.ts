// The background lead's money limits and its day, shared by agent-run.ts and the run dashboard.
// No top-level side effects: importing this module only defines what it exports.

/** Today's spend at or past this many dollars stops new runs (the lead's daily budget). */
export const DAILY_BUDGET_USD = 200
/** A single run past this many dollars is worth a look: one urgent push, a line on the dashboard. */
export const RUN_ALERT_USD = 100

/**
 * The local calendar day around `now`, as ISO bounds: `start` is local midnight of that day and
 * `end` the next local midnight, so a time `t` is on that day when `start <= t < end`.
 */
export function localDay(now: Date): { start: string; end: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}
