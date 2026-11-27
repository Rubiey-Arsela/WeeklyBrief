// Port of app.py's /api/ask retrieval logic — scores items and trends by
// token overlap, does light entity/grade/trend detection. No LLM call:
// every answer is sourced from the structured edition data, same as the
// original ("no generated content").
//
// By default this is LOCKED to the currently open edition, matching the
// Ask tab's own promise ("about this week's brief"): scoring only looks at
// that edition's items/pulse, the answer leads with the edition's own
// label/date, and an explicit "not covered this week" message is returned
// when nothing in that edition scores above a sensible threshold — instead
// of silently surfacing an unrelated item from a different week. Passing
// searchAll=true opts back into scoring every loaded edition and, when the
// same subject spans more than one of them, narrating how it moved
// (the "search all issues" toggle in the UI).

import type { Corpus, Edition } from './types'
import { tokens, derivePulseChange, labelTokens, shortIndicatorLabel } from './viewmodel'

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
  // The edition the answer is locked to (label + date), so the UI can print
  // it above the answer even when the question matched nothing and the
  // "not covered" message is returned.
  locked_edition?: { id: string; label: string; date: string }
  searched_all: boolean
}

// A match has to clear this score to count as "this week's brief actually
// covers that" — low-scoring noise (one incidental token overlap) must not
// be presented as a real answer; it should fall through to the explicit
// "not covered" message instead.
const COVERAGE_THRESHOLD = 6

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

export function ask(
  corpus: Corpus,
  editions: Edition[],
  q: string,
  opts?: { editionId?: string; searchAll?: boolean },
): AskResult {
  q = (q || '').trim()
  const searchAll = !!opts?.searchAll
  const sorted = [...editions].sort((a, b) => (a.date < b.date ? -1 : 1))
  const lockedEd = opts?.editionId
    ? sorted.find((e) => e.id === opts.editionId) || sorted[sorted.length - 1]
    : sorted[sorted.length - 1]
  const lockedMeta = lockedEd ? { id: lockedEd.id, label: lockedEd.label, date: lockedEd.date } : undefined

  if (!q) {
    return {
      answer: 'Ask a question about the brief.', sources: [], editions_referenced: [],
      locked_edition: lockedMeta, searched_all: searchAll,
    }
  }

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

  let gradeFilter: string | null = null
  for (const [word, grade] of [['negative', 'Negative'], ['critical', 'Negative'],
    ['risk', 'Negative'], ['positive', 'Positive'], ['good', 'Positive'], ['mixed', 'Mixed']] as const) {
    if (ql.includes(word)) { gradeFilter = grade; break }
  }

  // Scope: locked to one edition by default; every loaded edition only
  // when the reader explicitly asked to search all issues.
  const pool = searchAll ? sorted : (lockedEd ? [lockedEd] : [])

  type Scored = [number, Edition, Edition['items'][number]]
  const scored: Scored[] = []
  for (const ed of pool) {
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

  const parts: string[] = []
  const sources: AskSource[] = []

  // Indicator lookup — a number answers a number question. Always reads
  // the matched edition's OWN pulse row via derivePulseChange(), never the
  // legacy static corpus.indicators series, so this can't disagree with
  // the Indicators tab for the same week.
  let indicatorAnswer: string | null = null
  if (lockedEd) {
    const indEds = searchAll ? pool : [lockedEd]
    for (const ed of indEds) {
      const match = (ed.pulse || []).find((row) =>
        qtok.some((tok) => (row.indicator || '').toLowerCase().includes(tok)))
      if (match) {
        const { current, prior } = derivePulseChange(match)
        indicatorAnswer =
          `<strong>${shortIndicatorLabel(match.indicator)}</strong> is ${current} in ${ed.label} (${ed.id}), ` +
          `up from ${prior} the week before.<br><br>${match.implication || ''}`
        sources.push({ ref: 'Pulse', text: `${match.indicator} — ${ed.id} Weekly Pulse`, edition: ed.id })
        break
      }
    }
  }

  const covered = scored.length > 0 && scored[0][0] >= COVERAGE_THRESHOLD
  const leadEd = lockedEd

  if (!covered && !indicatorAnswer) {
    const scopeNote = searchAll
      ? `Nothing across the ${pool.length} loaded editions matches that.`
      : `<strong>${leadEd ? leadEd.label : 'This week\u2019s brief'} (${leadEd ? leadEd.id : ''}) does not cover this.</strong> ` +
        'Nothing in the currently open edition matches your question closely enough to answer from it.'
    const names = [...new Set((corpus.entities || []).map((e) => e.name))].sort().join(', ')
    const suggestion = searchAll
      ? `The app holds ${editions.length} editions covering: ${names}.`
      : 'Turn on "Search all issues" to check past editions, or ask about something in this week\u2019s Report tab.'
    return {
      answer: `${scopeNote}<br><br>${suggestion}`,
      sources: [],
      editions_referenced: [],
      locked_edition: lockedMeta,
      searched_all: searchAll,
    }
  }

  // Lead with a one-sentence answer before the supporting detail, per the
  // Ask tab's own promise of a direct answer first.
  if (covered) {
    const [, topEd, topItem] = scored[0]
    const leadSentence =
      `<strong>In brief:</strong> ${topItem.headline} ` +
      `(${topItem.grade || 'Neutral'}${!searchAll ? '' : `, ${topEd.label}`}).`
    parts.push(leadSentence)
  } else if (indicatorAnswer) {
    parts.push(`<strong>In brief:</strong> ${indicatorAnswer}`)
    indicatorAnswer = null // already shown as the lead, don't repeat below
  }

  if (indicatorAnswer) {
    parts.push(indicatorAnswer)
  }

  if (covered) {
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

  const edsSeen: string[] = []
  for (const [, ed] of scored.slice(0, 12)) {
    if (!edsSeen.includes(ed.id)) edsSeen.push(ed.id)
  }

  // Cross-edition linking only ever runs when the reader explicitly turned
  // on "search all issues" — the default, locked mode never narrates
  // history across weeks, since the Ask tab promises an answer about THIS
  // week's brief.
  if (searchAll && edsSeen.length > 1) {
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

  return {
    answer: parts.join('<br><br>'),
    sources: sources.slice(0, 8),
    editions_referenced: edsSeen,
    locked_edition: lockedMeta,
    searched_all: searchAll,
  }
}
