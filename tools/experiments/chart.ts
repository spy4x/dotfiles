// A hand-written SVG chart for the experiment report: one dot per arm (the median) with a whisker
// for its bootstrap 95% interval. No dependency; the file is plain SVG a browser or an image tag
// shows. Text and axes use `currentColor`, and the style block sets that colour for light and
// dark pages, which also holds when the file is shown through an `<img>` tag.

/** One arm's point and interval, in dollars. */
export interface ChartArm {
  readonly label: string
  readonly n: number
  readonly value: number
  readonly lo: number
  readonly hi: number
}

/** An arm placed on the canvas: pixel coordinates, y growing downwards. */
export interface PlacedArm extends ChartArm {
  readonly x: number
  readonly y: number
  readonly yLo: number
  readonly yHi: number
}

export const WIDTH = 480
export const HEIGHT = 340
/** The plot area, in pixels. */
export const PLOT = { left: 72, right: 456, top: 28, bottom: 260 }

const COLOURS = [`#3b82f6`, `#d97706`]
const round2 = (x: number) => Math.round(x * 100) / 100

/** A step of 1, 2 or 5 times a power of ten that gives about `ticks` gridlines up to `max`. */
export function niceStep(max: number, ticks = 4): number {
  const raw = max / ticks
  const power = 10 ** Math.floor(Math.log10(raw))
  const f = raw / power
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * power
}

/** The y axis: its top value in dollars and the gridline step. */
export function yAxis(arms: readonly ChartArm[]): { max: number; step: number } {
  const top = Math.max(...arms.map((a) => a.hi), ...arms.map((a) => a.value), 0.01)
  const step = niceStep(top)
  return { max: Math.ceil(top / step) * step, step }
}

/** Places each arm: its slot's centre on x, and value and interval ends on y. */
export function placeArms(arms: readonly ChartArm[]): PlacedArm[] {
  const { max } = yAxis(arms)
  const slot = (PLOT.right - PLOT.left) / arms.length
  const y = (v: number) => round2(PLOT.bottom - (v / max) * (PLOT.bottom - PLOT.top))
  return arms.map((a, i) => ({
    ...a,
    x: round2(PLOT.left + slot * (i + 0.5)),
    y: y(a.value),
    yLo: y(a.lo),
    yHi: y(a.hi),
  }))
}

const esc = (s: string) => s.replace(/&/g, `&amp;`).replace(/</g, `&lt;`).replace(/>/g, `&gt;`)
const dollars = (x: number) => `$${x.toFixed(2)}`

/**
 * Renders the chart. `title` and `desc` become the SVG's `<title>` and `<desc>`, which screen
 * readers announce.
 */
export function renderChart(
  arms: readonly ChartArm[],
  text: { title: string; desc: string; yLabel: string },
): string {
  const placed = placeArms(arms)
  const { max, step } = yAxis(arms)
  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" ` +
      `height="${HEIGHT}" role="img" aria-labelledby="t d" font-family="sans-serif" ` +
      `font-size="12">`,
    `<title id="t">${esc(text.title)}</title>`,
    `<desc id="d">${esc(text.desc)}</desc>`,
    `<style>svg{color:#1f2328}@media (prefers-color-scheme:dark){svg{color:#e6edf3}}</style>`,
    `<g fill="currentColor" stroke="currentColor">`,
  )
  for (let v = 0; v <= max + step / 1000; v += step) {
    const y = round2(PLOT.bottom - (v / max) * (PLOT.bottom - PLOT.top))
    out.push(
      `<line x1="${PLOT.left}" y1="${y}" x2="${PLOT.right}" y2="${y}" stroke-opacity="${
        v === 0 ? 0.9 : 0.2
      }"/>`,
      `<text x="${PLOT.left - 8}" y="${y + 4}" text-anchor="end" stroke="none">${
        dollars(v)
      }</text>`,
    )
  }
  out.push(
    `<text x="16" y="${
      (PLOT.top + PLOT.bottom) / 2
    }" text-anchor="middle" stroke="none" transform="rotate(-90 16 ${
      (PLOT.top + PLOT.bottom) / 2
    })">${esc(text.yLabel)}</text>`,
  )
  placed.forEach((a, i) => {
    const c = COLOURS[i % COLOURS.length]
    out.push(
      `<line x1="${a.x}" y1="${a.yHi}" x2="${a.x}" y2="${a.yLo}" stroke="${c}" stroke-width="3"/>`,
      `<line x1="${a.x - 10}" y1="${a.yHi}" x2="${
        a.x + 10
      }" y2="${a.yHi}" stroke="${c}" stroke-width="3"/>`,
      `<line x1="${a.x - 10}" y1="${a.yLo}" x2="${
        a.x + 10
      }" y2="${a.yLo}" stroke="${c}" stroke-width="3"/>`,
      `<circle cx="${a.x}" cy="${a.y}" r="6" fill="${c}" stroke="none"/>`,
      `<text x="${a.x + 14}" y="${a.y + 4}" stroke="none">${dollars(a.value)}</text>`,
      `<text x="${a.x}" y="${PLOT.bottom + 22}" text-anchor="middle" stroke="none">${
        esc(a.label)
      }</text>`,
      `<text x="${a.x}" y="${
        PLOT.bottom + 40
      }" text-anchor="middle" stroke="none" fill-opacity="0.75">n = ${a.n} PRs</text>`,
    )
  })
  out.push(
    `<text x="${(PLOT.left + PLOT.right) / 2}" y="${
      HEIGHT - 12
    }" text-anchor="middle" stroke="none" fill-opacity="0.75">dot: median, whisker: 95% bootstrap interval</text>`,
    `</g>`,
    `</svg>`,
  )
  return out.join(`\n`) + `\n`
}
