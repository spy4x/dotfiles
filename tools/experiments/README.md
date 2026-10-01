# Experiment kit

Compares two ways of running agents (two models, two rules) from Claude Code transcripts and
`gh`, with intervals instead of bare ratios. It reproduces the 29-30 September 2026 Sonnet 5.5
trial's tables from its raw material.

Run data and every run's `plan.md` live outside this repo (they are private); the tools take a
folder path. No transcript text belongs in this repo, not even in test fixtures: transcripts can
carry environment values.

## 1. Collect

```bash
deno task experiment:collect --out <run>/lanes.jsonl \
  --since 2026-09-26T00:00:00Z --until 2026-09-30T10:30:00Z \
  --dotfiles ~/sync/code/dotfiles
```

One JSON row per implementer or reviewer lane (`schema.ts` lists the fields). Lanes are dated by
the timestamps of their messages, never by file modification time. The model is the one that
answered (`message.model`); the alias the Agent call asked for is kept apart. Each API response is
priced once (the last usage line sharing its message id). `--dotfiles` tags every lane with the
dotfiles commit live when it spawned. A failed `gh` or `git` call stops the run with exit 1, and so
does a call to a model with no price in `tools/session-cost.ts`, which would otherwise count as $0.

`baseCommit` is always `null`: neither the transcripts nor `gh` record it.

## 2. Write `plan.md` before looking at results

`analyse` refuses a run folder without one. It reads `key: value` lines:

```markdown
# One-line name of the run

- arm_a: claude-opus-5-5
- arm_b: claude-sonnet-5-5
- baseline_start: 2026-09-26T13:44:00Z
- trial_start: 2026-09-29T19:00:00Z
- odd_issues: arm_b
```

The issue number assigns the arm: odd to `odd_issues`, even to the other. A rule the lead cannot
bend keeps the arms comparable. A unit with no issue gets no arm: the lead chose its model, so it
stays out of the arm-to-arm comparison.

## 3. Analyse

```bash
deno task experiment:analyse <run folder> [--seed 1] [--iterations 10000]
```

Prints Markdown. Medians and rates carry a seeded percentile bootstrap 95% interval; each
arm-to-arm difference says whether its interval crosses zero. Cost is judged per PR; per-100-line
rows are kept to match the published trial tables. Flags go before or after the folder; a seed or
iteration count that is not a whole number stops the command with exit 2.

- Table 1 holds every unit of each period, whatever assigned its model.
- The headline and Table 2 compare only trial units whose issue number assigned the model they ran
  on. The units left out (no issue, or an issue that assigned the other model) print on their own
  lines under the headline: how many there are, how many were reviewed, and the median total cost
  per reviewed PR.

## 4. Report and chart

```bash
deno task experiment:report <run folder> [--seed 1] [--iterations 10000]
```

Writes `report.md` and `chart.svg` into the run folder. The report opens with one sentence
giving the cost difference per PR and its 95% interval, then the chart, the comparison table, "What
would change my mind" (an interval that crosses zero, an arm under 20 reviewed units, unbalanced
arms, units left out, and the plan's own `bar:` line if it has one), "The weirdest lane" (the trial
unit with the highest total cost, described from row numbers only) and a method note. The figures
are the ones `analyse` prints for the same seed. The chart is plain SVG: a dot per arm for the
median and a whisker for the interval, readable on light and dark pages. Its dark rule follows the operating system's colour scheme, not a site's theme toggle, so a page that forces a light theme over a dark system shows light text on light.

## Not here yet

The 14 and 30 day follow-up pass, paired runs, and the daily view
(`ai-memory/experiments/week-2026-10-01/daily.py`, which reads lead sessions too, not only
subagent lanes).

## Ported, not rewritten

`lane.ts`, `collect.ts` and `analyse.ts` port the trial's `lanes.py`, `prs.py`, `tokens.py`,
`reviews2.py`, `units2.py` and `compare4.py`: same patterns, grouping and column definitions.
`stats.ts` has no dependency on this repo and is a candidate for `spy4x/ts-libs`.
