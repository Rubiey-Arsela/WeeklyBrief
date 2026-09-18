// Port of app.py's view-model builders (build_sections, build_indicators,
// build_trends, build_delta, view_model). The stored shape is the flat item
// list as it was authored each week; this derives the grouped sections, the
// Pulse rows, the trends and the watchlist delta the UI renders — same
// division of labour as the original Flask app, see DEPLOY.md point 4.

import type {
  Corpus, Edition, ViewModel, ViewSection, PulseGroup, TrendView,
  DeltaItem, CarryItem,
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
      impact: GRADE_CLASS[grade.toLowerCase()] || 'low',
      impact_label: grade,
    })
  }
  return order.map((s) => ({ title: s, items: groups[s] }))
}

export function buildIndicators(corpus: Corpus, ed: Edition): PulseGroup[] {
  const seriesByLabel: Record<string, Corpus['indicators'][number]> = {}
  for (const i of corpus.indicators || []) seriesByLabel[i.label] = i

  const rows: PulseGroup['items'] = []
  for (const row of ed.pulse || []) {
    const label = row.indicator || ''
    const ind = seriesByLabel[label]
    let history: number[] = []
    let change: number | null = null
    if (ind) {
      history = (ind.series || []).map((p) => p.value)
      const pts = ind.series || []
      if (pts.length >= 2) {
        change = Math.round((pts[pts.length - 1].value - pts[pts.length - 2].value) * 10000) / 10000
      }
    }
    const avg = history.length ? Math.round((history.reduce((a, b) => a + b, 0) / history.length) * 100) / 100 : null
    const direction = row.direction || ''
    if (change === null) {
      change = direction.includes('↑') ? 1 : direction.includes('↓') ? -1 : 0
    }
    rows.push({
      name: label,
      current: row.weekly || '—',
      prior: row.previous || '—',
      change,
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
      rows.push({
        name: ind.label,
        current: last,
        prior: prev === null ? '—' : prev,
        change: prev === null ? 0 : Math.round((last - prev) * 10000) / 10000,
        avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
        history: vals,
        source: (ind.note || '').slice(0, 90),
        implication: '',
      })
    }
  }
  return rows.length ? [{ category: 'Weekly Pulse', items: rows }] : []
}

export function buildTrends(corpus: Corpus): TrendView[] {
  const seriesById: Record<string, Corpus['indicators'][number]> = {}
  for (const i of corpus.indicators || []) seriesById[i.id] = i

  const out: TrendView[] = []
  for (const t of corpus.trends || []) {
    const ind = t.indicator ? seriesById[t.indicator] : undefined
    const pts = (ind?.series || []).map((p) => p.value)
    const value: number | string = pts.length ? pts[pts.length - 1] : '—'
    const prior: number | string = pts.length > 1 ? pts[pts.length - 2] : '—'
    const change = pts.length > 1 ? pts[pts.length - 1] - pts[pts.length - 2] : 0
    out.push({
      title: t.title,
      value,
      unit: ind?.unit ? ' ' + ind.unit : '',
      change,
      points: pts,
      avg: pts.length ? Math.round((pts.reduce((a, b) => a + b, 0) / pts.length) * 100) / 100 : '—',
      prior,
      context: t.detail || '',
    })
  }
  return out
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
    const title = w.split('.')[0].slice(0, 110)
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
      delta.push({ status: 'resolved', title: prv[i].split('.')[0].slice(0, 110) })
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
    trends: buildTrends(corpus),
    delta,
    carry_forward: carry,
  }
  if (ed.pdf) vm.pdf = ed.pdf
  return vm
}
