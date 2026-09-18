// Port of app.py's /api/ask retrieval logic — scores items and trends by
// token overlap, does light entity/grade/trend detection, and links the
// same subject across editions when it appears in more than one. No LLM
// call: every answer is sourced from the structured edition data, same as
// the original ("no generated content").

import type { Corpus, Edition } from './types'
import { tokens } from './viewmodel'

export interface AskSource {
  ref: string
  text: string
  edition?: string
  section?: string
  kind?: string
}

export interface AskResult {
  answer: string
  sources: AskSource[]
  editions_referenced: string[]
}

function scoreItem(item: Edition['items'][number], entNames: Record<string, string>, qtok: string[]): number {
  const hay = [
    item.headline || '', item.summary || '', item.impact || '',
    item.regulatory || '', item.section || '',
    (item.entities || []).map((e) => entNames[e] || '').join(' '),
  ].join(' ').toLowerCase()
  let s = 0
  for (const t of qtok) {
    const n = hay.split(t).length - 1
    if (n) s += 3 + n
    if ((item.headline || '').toLowerCase().includes(t)) s += 4
  }
  return s
}

export function ask(corpus: Corpus, editions: Edition[], q: string): AskResult {
  q = (q || '').trim()
  if (!q) return { answer: 'Ask a question about the brief.', sources: [], editions_referenced: [] }

  const qtok = tokens(q)
  const entNames: Record<string, string> = {}
  for (const e of corpus.entities || []) entNames[e.id] = e.name

  const ql = q.toLowerCase()
  const hitsEnt = (corpus.entities || []).filter((e) => {
    const nm = e.name.toLowerCase()
    if (ql.includes(nm) || ql.includes(e.id.replace(/_/g, ' '))) return true
    const short = nm.split(' ')[0]
    return short.length > 4 && ql.includes(short)
  })

  const trendWords = new Set(['trend', 'change', 'changed', 'over', 'time', 'worse', 'better',
    'compare', 'comparison', 'direction', 'week', 'weeks', 'moving', 'pattern'])
  const wantsTrend = qtok.some((t) => trendWords.has(t))

  let gradeFilter: string | null = null
  for (const [word, grade] of [['negative', 'Negative'], ['critical', 'Negative'],
    ['risk', 'Negative'], ['positive', 'Positive'], ['good', 'Positive'], ['mixed', 'Mixed']] as const) {
    if (ql.includes(word)) { gradeFilter = grade; break }
  }

  type Scored = [number, Edition, Edition['items'][number]]
  const scored: Scored[] = []
  for (const ed of editions) {
    for (const item of ed.items || []) {
      let s = scoreItem(item, entNames, qtok)
      if (hitsEnt.length) {
        const ids = new Set(hitsEnt.map((e) => e.id))
        if ((item.entities || []).some((e) => ids.has(e))) s += 12
      }
      if (gradeFilter && item.grade === gradeFilter) s += 8
      if (s > 0) scored.push([s, ed, item])
    }
  }
  scored.sort((a, b) => b[0] - a[0])

  type ScoredTrend = [number, Corpus['trends'][number]]
  const trendsScored: ScoredTrend[] = []
  for (const t of corpus.trends || []) {
    let s = 0
    const hay = (t.title + ' ' + t.detail).toLowerCase()
    for (const tok of qtok) if (hay.includes(tok)) s += 3
    if (hitsEnt.length) {
      const ids = new Set(hitsEnt.map((e) => e.id))
      if ((t.entities || []).some((e) => ids.has(e))) s += 10
    }
    if (wantsTrend) s += 2
    if (s > 0) trendsScored.push([s, t])
  }
  trendsScored.sort((a, b) => b[0] - a[0])

  const parts: string[] = []
  const sources: AskSource[] = []

  if (wantsTrend && trendsScored.length) {
    for (const [, t] of trendsScored.slice(0, 3)) {
      parts.push(`<strong>${t.title}</strong><br><br>${t.detail}`)
      sources.push({ ref: 'Trend', text: t.title })
    }
  }

  if (scored.length) {
    if (parts.length) parts.push('<hr>')
    for (const [, ed, item] of scored.slice(0, 4)) {
      const flag = item.flag ? `<br><br><em>Note: ${item.flag}</em>` : ''
      parts.push(
        `<strong>${item.headline}</strong><br>` +
        `<em>${ed.label} · ${item.section} · ${item.source}</em>` +
        `<br><br>${item.summary}<br><br>` +
        `<strong>${item.grade}.</strong> ${item.impact || ''}${flag}`,
      )
      sources.push({
        ref: `${ed.id} · ${item.grade}`,
        text: `${item.headline} — ${item.source}`,
        edition: ed.id,
        section: item.section || '',
      })
    }
  }

  if (!parts.length && trendsScored.length) {
    const t = trendsScored[0][1]
    parts.push(`<strong>${t.title}</strong><br><br>${t.detail}`)
    sources.push({ ref: 'Trend', text: t.title })
  }

  // Indicator lookup goes first — a number answers a number question.
  for (const ind of corpus.indicators || []) {
    if (qtok.some((tok) => ind.label.toLowerCase().includes(tok)) || ql.includes(ind.id)) {
      const ser = ind.series || []
      if (!ser.length) break
      const first = ser[0], last = ser[ser.length - 1]
      const chg = last.value - first.value
      const pct = first.value ? (chg / first.value * 100) : 0
      parts.unshift(
        `<strong>${ind.label}</strong> is ${last.value}` +
        `${ind.unit ? ' ' + ind.unit : ''} as at ${last.date}, ` +
        `from ${first.value} on ${first.date} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% over the period).` +
        `<br><br>${ind.note || ''}`,
      )
      sources.unshift({ ref: 'Pulse', text: `${ind.label} — published Pulse series` })
      break
    }
  }

  if (!parts.length) {
    const names = [...new Set((corpus.entities || []).map((e) => e.name))].sort().join(', ')
    return {
      answer: 'Nothing in the loaded editions matches that. The app currently holds ' +
        `${editions.length} editions covering these businesses: ${names}.` +
        '<br><br>Try asking about Brent and fuel cost, the PTP cyberattack, ' +
        'Bank Muamalat funding, palm oil stocks, or what changed over the ' +
        'last two weeks.',
      sources: [],
      editions_referenced: [],
    }
  }

  // Cross-edition linking: an executive question is rarely about one week.
  // When the same subject appears in more than one edition, say how it
  // moved and name the weeks.
  const edsSeen: string[] = []
  for (const [, ed] of scored.slice(0, 12)) {
    if (!edsSeen.includes(ed.id)) edsSeen.push(ed.id)
  }
  if (edsSeen.length > 1) {
    const byEd: Record<string, [Edition, Edition['items'][number]][]> = {}
    for (const [, ed, item] of scored.slice(0, 12)) {
      (byEd[ed.id] = byEd[ed.id] || []).push([ed, item])
    }
    const order = Object.keys(byEd).sort((a, b) => (byEd[a][0][0].date || '') < (byEd[b][0][0].date || '') ? -1 : 1)
    const lines: string[] = []
    for (const eid of order) {
      const [ed0, it0] = byEd[eid][0]
      const grades = [...new Set(byEd[eid].map(([, i]) => i.grade || ''))].sort()
      lines.push(`<strong>${ed0.label}</strong> (${eid}, ${grades.join(', ')}): ${it0.headline || ''}`)
    }
    const dominant = (eid: string): string | null => {
      const gs = new Set(byEd[eid].map(([, i]) => i.grade || '').filter(Boolean))
      return gs.size === 1 ? [...gs][0] : null
    }
    const firstG = dominant(order[0]), lastG = dominant(order[order.length - 1])
    let shift: string
    if (firstG && lastG && firstG !== lastG) {
      shift = `<br><br>The read moved from <strong>${firstG}</strong> in ${order[0]} to <strong>${lastG}</strong> in ${order[order.length - 1]}.`
    } else if (firstG && lastG) {
      shift = `<br><br>The read has stayed <strong>${lastG}</strong> across ${order.length} editions.`
    } else {
      shift = '<br><br>These weeks carry a mix of readings — open the editions above rather than reading one direction into them.'
    }
    parts.push('<hr><strong>Across past briefs</strong><br><br>' + lines.join('<br><br>') + shift)
    sources.push({ kind: 'history', ref: 'History', text: 'Linked across ' + order.join(', ') })
  }

  return { answer: parts.join('<br><br>'), sources: sources.slice(0, 8), editions_referenced: edsSeen }
}
