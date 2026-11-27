// Port of app.py's view-model builders (build_sections, build_indicators,
// build_trends, build_delta, view_model). The stored shape is the flat item
// list as it was authored each week; this derives the grouped sections, the
// Pulse rows, the trends and the watchlist delta the UI renders — same
// division of labour as the original Flask app, see DEPLOY.md point 4.

import type {
  Corpus, Edition, ViewModel, ViewSection, PulseGroup, PulseViewItem, TrendView,
  DeltaItem, CarryItem, PulseRow,
} from './types'

// The brief grades items Positive / Neutral / Mixed / Negative. The front
// end styles a four-step badge. Map grade -> badge weight without inflating
// it: a Negative item is the one an executive must act on.
// Palette: critical = red, high = amber, medium = green, low = grey.
const GRADE_CLASS: Record<string, string> = {
  negative: 'critical',
  mixed: 'high',
  neutral: 'low',
  positive: 'medium',
}

export function weekOf(ed: Edition): number {
  const m = /W(\d+)/.exec(ed.id || '')
  if (m) return parseInt(m[1], 10)
  try {
    const dt = new Date(ed.date)
    return isoWeek(dt)
  } catch {
    return 0
  }
}

// Standard ISO-8601 week number: move to the Thursday of the same week,
// then count weeks since that Thursday's year started. Verified against
// Python's datetime.isocalendar() for week-boundary and year-boundary dates.
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7 // ISO weekday: Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

const STOP = new Set(('the a an of for and or to in on at is are was were be been what how ' +
  'why when which who whom that this these those do does did with from ' +
  'as by it its we our you your about tell me show give s').split(' '))

export function tokens(text: string): string[] {
  const raw = (text || '').toLowerCase().match(/[a-z0-9']+/g) || []
  return raw.filter((w) => !STOP.has(w) && w.length > 1)
}

function key(text: string): string {
  return tokens(text).slice(0, 2).join(' ')
}

function sameWatch(a: string, b: string): boolean {
  const ta = new Set(tokens(a).slice(0, 8))
  const tb = new Set(tokens(b).slice(0, 8))
  if (ta.size === 0 || tb.size === 0) return false
  let overlap = 0
  for (const t of ta) if (tb.has(t)) overlap++
  return overlap / Math.min(ta.size, tb.size) >= 0.5
}

function stripTags(html: string): string {
  return (html || '').replace(/<[^>]+>/g, '')
}

// --------------------------------------------------------------- Pulse math
// Shared by buildIndicators() and buildTrends() (and exported for ask.ts)
// so the Indicators table, the Trends cards, and the Ask tab's indicator
// lookups can never disagree with each other about a week's own numbers.

// Pull the first plain number out of a Pulse row's printed value, e.g.
// "USD92.57/bbl" -> 92.57, "RM4,141/t" -> 4141, "1,556.51" -> 1556.51,
// "3.82%" -> 3.82, "4.1138" -> 4.1138. Strips thousands separators before
// matching so "4,141" isn't read as two numbers.
export function firstNumber(s: string): number | null {
  const cleaned = (s || '').replace(/,(?=\d{3}(?:\D|$))/g, '')
  const m = /-?\d+(?:\.\d+)?/.exec(cleaned)
  return m ? parseFloat(m[0]) : null
}

// A Pulse row's `weekly`/`previous` string is reliable for a single-number
// diff only when each side reduces to exactly one plain number — rows that
// print several prices in one cell (fuel: RON95/RON97/diesel) or embed a
// second number via a date/week-ending phrase must not be diffed naively,
// since that number is not a second measurement of the same quantity.
export function countNumbers(s: string): number {
  const cleaned = (s || '').replace(/,(?=\d{3}(?:\D|$))/g, '')
  return (cleaned.match(/-?\d+(?:\.\d+)?/g) || []).length
}

// Direction/colour purely from the sign of a numeric change — never from a
// separately-stored field, so the arrow can never contradict the two
// numbers printed beside it.
export function dirFromChange(change: number): 'up' | 'down' | 'flat' {
  return change > 0 ? 'up' : change < 0 ? 'down' : 'flat'
}

// Fallback when the row's own weekly/previous text can't be reduced to one
// clean number pair (see countNumbers above): read the authored direction
// arrow/phrase instead of guessing. This still derives from data the
// edition itself printed for this row — it is a last resort, not a stale
// series.
export function dirFromArrowText(direction: string): 'up' | 'down' | 'flat' {
  if (direction.includes('↑')) return 'up'
  if (direction.includes('↓')) return 'down'
  const low = direction.toLowerCase()
  if (/\bup\b|\brose\b|\brise[sn]?\b|\bhigher\b|\bwider\b|\bincreas/.test(low)) return 'up'
  if (/\bdown\b|\bfell\b|\bfall[sn]?\b|\blower\b|\bnarrow/.test(low)) return 'down'
  return 'flat'
}

export interface PulseChange {
  current: string
  prior: string
  change: number
  dir: 'up' | 'down' | 'flat'
}

// The single authoritative way to read a Pulse row's week-over-week move:
// diff the row's own two printed values when that is safe (see
// countNumbers), otherwise fall back to the row's own authored arrow/phrase
// — NEVER a separately-stored series that may be stale or mismatched.
// Used by buildIndicators (Indicators tab + Sector Heat upstream data),
// buildTrends (Trends cards), and ask.ts (Ask tab indicator lookups) so all
// three can never disagree about what a given week's row says.
export function derivePulseChange(row: PulseRow): PulseChange {
  const weeklyStr = row.weekly || ''
  const previousStr = row.previous || ''
  const direction = row.direction || ''
  let change: number | null = null
  if (countNumbers(weeklyStr) === 1 && countNumbers(previousStr) === 1) {
    const cur = firstNumber(weeklyStr)
    const prev = firstNumber(previousStr)
    if (cur !== null && prev !== null) {
      change = Math.round((cur - prev) * 10000) / 10000
    }
  }
  const dir = change !== null ? dirFromChange(change) : dirFromArrowText(direction)
  if (change === null) change = dir === 'up' ? 1 : dir === 'down' ? -1 : 0
  return { current: weeklyStr || '—', prior: previousStr || '—', change, dir }
}

// Strip an indicator label down to its plain name for display, dropping
// the parenthetical dating/context PDFs print week to week, e.g.
// "Brent Crude (Jan 2027 contract; 12 Nov settlement)" -> "Brent Crude".
export function shortIndicatorLabel(label: string): string {
  return (label || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[-,;:]+$/, '')
    .trim()
}

// Words that carry no identifying signal for matching a PDF-printed
// indicator label (e.g. "Brent Crude (18 Sept settlement)") against another
// week's label for the same measure — dates, units of time, and generic
// descriptors that appear across many labels.
const LABEL_STOP = new Set([
  'the', 'a', 'an', 'of', 'per', 'at', 'on', 'in', 'for', 'and', 'or',
  'pm', 'am', 'rate', 'price', 'prices', 'index', 'close', 'closing',
  'settlement', 'sept', 'week', 'weekly', 'previous', 'note', 'bnm', 'ftse',
])

export function labelTokens(s: string): Set<string> {
  return new Set(
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .filter((w) => !LABEL_STOP.has(w))
      .filter((w) => !/^\d+$/.test(w)),
  )
}

// Generic "best unambiguous token-overlap match" used to pair a PDF-printed
// label against a list of candidates (either the legacy corpus indicator
// catalogue, or another edition's own Pulse rows) — only returns a match
// when it's a strict best (beats any other candidate), so a weak/ambiguous
// signal is left unmatched rather than risk pairing the wrong series/row.
export function bestTokenMatch<T>(
  items: T[],
  getLabel: (item: T) => string,
  targetTokens: Set<string>,
): T | undefined {
  let best: T | undefined
  let bestScore = 0
  let runnerUp = 0
  for (const it of items) {
    const itTokens = labelTokens(getLabel(it))
    let overlap = 0
    for (const t of targetTokens) if (itTokens.has(t)) overlap++
    if (overlap > bestScore) { runnerUp = bestScore; bestScore = overlap; best = it } else if (overlap > runnerUp) runnerUp = overlap
  }
  return bestScore > 0 && bestScore > runnerUp ? best : undefined
}

// Find the corpus indicator series matching a PDF-printed label — used only
// for cosmetic metadata now (unit suffix, sparkline history for the
// Indicators tab's mini trend column), never for this week's own
// current/prior/change, which always comes from derivePulseChange() above.
function findIndicatorSeries(corpus: Corpus, label: string): Corpus['indicators'][number] | undefined {
  const list = corpus.indicators || []
  const exact = list.find((i) => i.label === label)
  if (exact) return exact

  const low = label.toLowerCase()
  const sub = list.find((i) => {
    const l2 = i.label.toLowerCase()
    return low.includes(l2) || l2.includes(low)
  })
  if (sub) return sub

  const rowTokens = labelTokens(label)
  if (rowTokens.size === 0) return undefined
  return bestTokenMatch(list, (ind) => ind.label + ' ' + ind.id.replace(/_/g, ' '), rowTokens)
}

export function buildSections(ed: Edition): ViewSection[] {
  const order: string[] = []
  const groups: Record<string, ViewSection['items']> = {}
  for (const item of ed.items || []) {
    const sec = item.section || 'Unclassified'
    if (!groups[sec]) {
      groups[sec] = []
      order.push(sec)
    }
    const grade = item.grade || 'Neutral'
    const body = item.summary || ''
    const impact = item.impact || ''
    const reg = item.regulatory || ''
    const parts: string[] = [body]
    if (impact) parts.push('<strong>Impact.</strong> ' + impact)
    if (reg) parts.push('<strong>Regulatory.</strong> ' + reg)
    if (item.flag) parts.push('<strong>Note.</strong> ' + item.flag)
    const plain = stripTags(body)
    groups[sec].push({
      title: item.headline || '',
      plain,
      grade,
      body: parts.filter(Boolean).join('<br><br>'),
      source: item.source || '',
      source_url: item.source_url || undefined,
      impact: GRADE_CLASS[grade.toLowerCase()] || 'low',
      impact_label: grade,
    })
  }
  return order.map((s) => ({ title: s, items: groups[s] }))
}

export function buildIndicators(corpus: Corpus, ed: Edition): PulseGroup[] {
  const rows: PulseViewItem[] = []
  for (const row of ed.pulse || []) {
    const label = row.indicator || ''
    // Sparkline history and the "source" footnote still draw on the corpus
    // series when a match is found (it's the only place a multi-point
    // history lives) — but this week's own current/prior/change/arrow
    // NEVER come from that possibly-stale series; see derivePulseChange().
    const ind = findIndicatorSeries(corpus, label)
    const history: number[] = ind ? (ind.series || []).map((p) => p.value) : []
    const avg = history.length ? Math.round((history.reduce((a, b) => a + b, 0) / history.length) * 100) / 100 : null

    const { current, prior, change, dir } = derivePulseChange(row)
    rows.push({
      name: label,
      current,
      prior,
      change,
      dir,
      avg: avg === null ? '—' : avg,
      history,
      source: (ind?.note || '').slice(0, 90),
      implication: row.implication || '',
    })
  }
  if (rows.length === 0) {
    for (const ind of corpus.indicators || []) {
      const pts = ind.series || []
      if (!pts.length) continue
      const vals = pts.map((p) => p.value)
      const last = vals[vals.length - 1]
      const prev = vals.length > 1 ? vals[vals.length - 2] : null
      const change = prev === null ? 0 : Math.round((last - prev) * 10000) / 10000
      rows.push({
        name: ind.label,
        current: last,
        prior: prev === null ? '—' : prev,
        change,
        dir: dirFromChange(change),
        avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
        history: vals,
        source: (ind.note || '').slice(0, 90),
        implication: '',
      })
    }
  }
  return rows.length ? [{ category: 'Weekly Pulse', items: rows }] : []
}

// Trends are rebuilt entirely from the editions' own Pulse rows — the
// currently open edition's row supplies the authoritative current/prior/
// change (via derivePulseChange, same as the Indicators tab), and up to
// five earlier editions' matching rows (found by token overlap on the
// indicator label, since PDF wording drifts week to week) supply the
// history for the chart's x-axis. The old static corpus.trends/indicators
// tables are no longer read here at all, so every edition's Trends tab
// reflects its own data instead of a frozen snapshot from whichever week
// last touched the corpus.
export function buildTrends(corpus: Corpus, allEditions: Edition[], ed: Edition): TrendView[] {
  const eds = [...allEditions]
    .filter((e) => e.date <= ed.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  const idx = eds.findIndex((e) => e.id === ed.id)
  const windowEds = idx === -1 ? [ed] : eds.slice(Math.max(0, idx - 5), idx + 1)

  const out: TrendView[] = []
  for (const row of ed.pulse || []) {
    const label = row.indicator || ''
    if (!label) continue
    const { current, prior, change, dir } = derivePulseChange(row)
    const targetTokens = labelTokens(label)

    const points: number[] = []
    const weeks: string[] = []
    for (const histEd of windowEds) {
      if (histEd.id === ed.id) {
        if (countNumbers(current) === 1) {
          const v = firstNumber(current)
          if (v !== null) { points.push(v); weeks.push(histEd.id) }
        }
        continue
      }
      const match = bestTokenMatch(histEd.pulse || [], (r) => r.indicator || '', targetTokens)
      if (match && countNumbers(match.weekly || '') === 1) {
        const v = firstNumber(match.weekly || '')
        if (v !== null) { points.push(v); weeks.push(histEd.id) }
      }
    }

    // Unit suffix only — cosmetic metadata from the legacy corpus catalogue,
    // never used for the actual current/prior/change numbers above.
    const ind = findIndicatorSeries(corpus, label)
    const curN = firstNumber(current)
    const priN = firstNumber(prior)
    const pct = curN !== null && priN !== null && priN !== 0 && countNumbers(current) === 1 && countNumbers(prior) === 1
      ? Math.round(((curN - priN) / Math.abs(priN)) * 1000) / 10
      : null
    const verb = dir === 'up' ? 'rose' : dir === 'down' ? 'fell' : 'held steady'
    const pctText = pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct}%)` : ''
    const unitSuffix = ind?.unit ? ` ${ind.unit}` : ''
    const headline = `${shortIndicatorLabel(label)} ${verb}${pctText} to ${current}${unitSuffix} this week, from ${prior} previously.`
    const context = [headline, row.implication || ''].filter(Boolean).join(' ')

    out.push({
      title: shortIndicatorLabel(label),
      value: current,
      unit: '',
      change,
      points,
      weeks,
      avg: points.length ? Math.round((points.reduce((a, b) => a + b, 0) / points.length) * 100) / 100 : '—',
      prior,
      context,
    })
  }
  return out
}

// A Watch List line is already authored as a single, complete sentence (or
// two) — this must never silently cut it mid-sentence. When the line
// contains a recognisable "<fact> ... on <Day DD Mon>..." date phrase, lead
// with that date (the format the director asked for, e.g. "Mon 23 Nov: ..."),
// otherwise show the line exactly as written. The original phrase is removed
// from its mid-sentence position once it leads the line, to avoid repeating
// the date twice; if that surgery would leave an unusable fragment, the
// safety net below falls back to the full original sentence with the date
// simply prefixed, rather than ever truncating or dropping it.
function formatWatchLine(raw: string): string {
  const text = (raw || '').trim()
  if (!text) return text
  const m = /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+[A-Za-z]{3,9})\b/.exec(text)
  if (!m) return text

  const datePart = m[1]
  const idx = m.index
  let rest = text.slice(0, idx) + text.slice(idx + datePart.length)
  rest = rest
    // Remove a now-dangling "on" left right before the punctuation that
    // used to follow the date (e.g. "published on , the first" -> "published, the first").
    .replace(/\s+on\s*,/g, ',')
    .replace(/\s+on\s*\./g, '.')
    .replace(/\s+on\s*$/g, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^,\s*/, '')
    .replace(/^\.\s*/, '')

  if (rest.length < 8) return `${datePart}: ${text}` // safety net — never collapse to nothing
  rest = rest.charAt(0).toUpperCase() + rest.slice(1)
  return `${datePart}: ${rest}`
}

export function buildDelta(allEditions: Edition[], ed: Edition): [DeltaItem[], CarryItem[]] {
  const eds = [...allEditions].sort((a, b) => (a.date < b.date ? -1 : 1))
  const idx = eds.findIndex((e) => e.id === ed.id)
  const prev = idx > 0 ? eds[idx - 1] : null
  const cur = ed.watchlist || []
  const prv = prev?.watchlist || []
  const delta: DeltaItem[] = []
  const carry: CarryItem[] = []
  if (!prev) return [delta, carry]

  const matchedPrev = new Set<number>()
  for (const w of cur) {
    const title = formatWatchLine(w)
    let hit = -1
    for (let i = 0; i < prv.length; i++) {
      if (matchedPrev.has(i)) continue
      if (key(prv[i]) === key(w) || sameWatch(prv[i], w)) { hit = i; break }
    }
    if (hit === -1) {
      delta.push({ status: 'new', title })
    } else {
      matchedPrev.add(hit)
      carry.push({ title, since_week: weekOf(prev) })
    }
  }
  for (let i = 0; i < prv.length; i++) {
    if (!matchedPrev.has(i)) {
      delta.push({ status: 'resolved', title: formatWatchLine(prv[i]) })
    }
  }
  return [delta, carry]
}

export function viewModel(corpus: Corpus, allEditions: Edition[], ed: Edition): ViewModel {
  const [delta, carry] = buildDelta(allEditions, ed)
  const vm: ViewModel = {
    id: ed.id,
    week: weekOf(ed),
    label: ed.label || '',
    date: ed.date || '',
    status: ed.status || '',
    exec_summary: ed.exec_summary || '',
    speed_read: ed.speed_read || [],
    structural: ed.structural || '',
    beyond: ed.beyond || '',
    sections: buildSections(ed),
    indicators: buildIndicators(corpus, ed),
    trends: buildTrends(corpus, allEditions, ed),
    delta,
    carry_forward: carry,
  }
  if (ed.pdf) vm.pdf = ed.pdf
  return vm
}
