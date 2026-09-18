// Extracts a Weekly Brief PDF's own content into the structured Edition
// shape (exec_summary, speed_read, structural, pulse, items, watchlist)
// so an uploaded PDF fully populates the Report/Ask/Trends/Indicators
// tabs, not just a PDF-viewer attachment.
//
// Design (validated against all 9 real Maida Vale weekly briefs before
// being ported here):
//  1. Extract raw text with `unpdf` (Workers-compatible, no fs/native deps).
//  2. Parse the week-range and publish-date straight from the PDF's own
//     printed header ("Week Update: X - Y" / "Date: Z") — NOT from the
//     upload timestamp, so past and future editions can be backfilled.
//  3. Strip the cover/TOC by slicing from the *second* occurrence of
//     "Executive Summary" (the first is the TOC entry).
//  4. Split the body deterministically using the report's own fixed
//     subsection headings as anchors (same order/wording in every edition's
//     Table of Content) — small bounded chunks, not one giant prompt.
//  5. Extract each chunk with a small parallel LLM call (OpenAI-compatible
//     chat.completions, response_format=json_object). Small bounded
//     context avoids the hallucination/mis-numbering a single large-prompt
//     extraction produced during prototyping.
//
// The OpenAI-compatible credentials are read from c.env.OPENAI_API_KEY /
// c.env.OPENAI_BASE_URL (Cloudflare secrets the user has already set),
// mirroring the existing GEMINI_API_KEY pattern used by tts.ts.

import { extractText, extractTextItems, getDocumentProxy } from 'unpdf'
import type { NewsItem, PulseRow } from './types'

export interface ExtractedEdition {
  weekStart: string // e.g. "29 Jun 2026"
  weekEnd: string // e.g. "03 Jul 2026"
  date: string // ISO yyyy-mm-dd, derived from weekEnd
  label: string // "29 Jun 2026 to 03 Jul 2026"
  exec_summary: string
  speed_read: string[]
  structural: string
  pulse: PulseRow[]
  items: NewsItem[]
  watchlist: string[]
  beyond: string
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6,
  aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
}

// "29 Jun 2026" / "03 Jul. 2026" / "03 Sept 2026" -> "2026-07-03"
function parseHeaderDate(s: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/.exec(s.trim())
  if (!m) return null
  const day = parseInt(m[1], 10)
  const monKey = m[2].toLowerCase().replace(/\.$/, '')
  const mon = MONTHS[monKey]
  if (mon === undefined) return null
  const year = parseInt(m[3], 10)
  const dt = new Date(Date.UTC(year, mon, day))
  return dt.toISOString().slice(0, 10)
}

function getBody(text: string): string {
  const first = text.indexOf('Executive Summary')
  const second = text.indexOf('Executive Summary', first + 1)
  return second === -1 ? text : text.slice(second)
}

// `extractText({ mergePages: true })` collapses every line break to a single
// "\n" and discards the vertical whitespace between paragraphs, so the
// Executive Summary's Global / Asia-Pacific / Malaysia paragraphs (and any
// further paragraphs, e.g. a "Results week" wrap-up) always come back as one
// run-on block — there is no "\n\n" to split on. Rebuild paragraph breaks
// from the PDF's own per-line Y coordinates instead: a gap between
// consecutive lines that is meaningfully larger than the normal line-height
// for that block marks a paragraph break, matching exactly how the source
// PDF (and `pdftotext -layout`) visually separates them with a blank line.
interface TextItem {
  str: string
  x: number
  y: number
  height: number
  hasEOL: boolean
}

function findParagraphs(flatItems: TextItem[], headingStr: string, endStr: string): string[] | null {
  // The heading appears twice: once as a Table-of-Content entry (with a
  // trailing "…… <page>" and a different, smaller font height) and once as
  // the real section heading. Skip the TOC entry.
  const idxs: number[] = []
  flatItems.forEach((it, i) => {
    if (it.str === headingStr || it.str.startsWith(headingStr + ' ')) idxs.push(i)
  })
  if (idxs.length < 2) return null
  const startIdx = idxs[1] + 1
  let endIdx = flatItems.findIndex((it, i) => i > startIdx && it.str.startsWith(endStr))
  if (endIdx === -1) endIdx = flatItems.length
  const body = flatItems.slice(startIdx, endIdx)

  // Reassemble wrapped words on the same visual line (pdf.js emits one item
  // per word/run, only the final run on a line has hasEOL=true) into lines
  // tagged with that line's Y coordinate.
  const lines: { y: number; text: string }[] = []
  let curY: number | null = null
  let curParts: string[] = []
  for (const it of body) {
    if (curY === null && it.str.trim() === '') continue
    if (curY === null) curY = it.y
    curParts.push(it.str)
    if (it.hasEOL) {
      const t = curParts.join('').trim()
      if (t) lines.push({ y: curY, text: t })
      curY = null
      curParts = []
    }
  }
  const tail = curParts.join('').trim()
  if (tail) lines.push({ y: curY ?? 0, text: tail })
  if (lines.length === 0) return []

  // The normal single-line-spacing gap is the median consecutive-line Y
  // delta; a paragraph break is a gap noticeably (50%+) larger than that.
  const gaps: number[] = []
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y)
  const sorted = [...gaps].sort((a, b) => a - b)
  const normalGap = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 14.64
  const threshold = normalGap * 1.5

  const paragraphs: string[] = []
  let curPara = [lines[0].text]
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y
    if (gap > threshold) {
      paragraphs.push(curPara.join(' '))
      curPara = []
    }
    curPara.push(lines[i].text)
  }
  if (curPara.length) paragraphs.push(curPara.join(' '))
  return paragraphs.filter((p) => p.trim().length > 0)
}

const MALAYSIA_HEADS = [
  'Weekly Macroeconomic Pulse',
  'Structural Macroeconomic Positioning',
  'Macroeconomics and Local Market',
  'Ports/Logistics/Infrastructure Sector',
  'Automotive/Services Sector',
  'Agribusiness/Plantation/Food Security Sector',
  'Energy/Utilities/Sustainability Sector',
  'Digital Economy/Technology/Media Sector',
  'Property Sector',
  'Aviation Sector',
  'Financial Services Sector',
]

function findHeadingIdx(body: string, title: string, fromIdx: number): number {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const re = new RegExp('\\d{1,2}\\.\\s*' + escaped)
  const m = re.exec(body.slice(fromIdx))
  return m ? fromIdx + m.index : -1
}

const ITEMS_SYSTEM = `Extract every news item row from this industry-news table section into JSON: {"items":[{"headline":"...","source":"...","grade":"Positive|Negative|Mixed|Neutral","summary":"...","impact":"...","regulatory":"..."}]}.
One item per table row. "source" is the parenthetical citation e.g. "Reuters, 1 Jul 2026" (no parentheses). "grade" is the leading word of the "Near term Impact & Strategic Implications" cell. "impact" is that cell's text AFTER the leading grade word and its period. "regulatory" is the "Regulatory/Policy Changes" cell text, or "" if it was just "-".
If the section states "No material ... developments were identified", output {"items":[]}.
Preserve figures/dates exactly as printed. Output ONLY the JSON object, no commentary, no markdown fences.`

const PULSE_SYSTEM = `Extract the Weekly Macroeconomic Pulse table rows into JSON: {"pulse":[{"indicator":"...","weekly":"...","previous":"...","direction":"...","implication":"..."}]}.
Ignore chart/axis noise (numbers like axis labels, month names). "direction" should include the arrow (up/down/flat) plus the % or descriptive text next to it, e.g. "down 1.5% wow". "weekly"/"previous" are the This-week/Previous-week cell values (may be multi-line bullet lists - join with "; "). "implication" is the Strategic Implication cell.
Output ONLY the JSON object, no commentary.`

const WATCH_SYSTEM = `Extract each numbered Watchlist item into JSON: {"watchlist":["...", ...]}. Each array entry is one full numbered item's complete text (title + explanation), with the leading number removed. Output ONLY the JSON object, no commentary.`

interface LlmCreds {
  apiKey: string
  baseUrl: string
  model: string
}

async function callLlmRaw(creds: LlmCreds, system: string, user: string): Promise<any> {
  const resp = await fetch(`${creds.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify({
      model: creds.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
    }),
  })
  const raw = await resp.text()
  if (!resp.ok) throw new Error(`LLM error ${resp.status}: ${raw.slice(0, 500)}`)
  const data = JSON.parse(raw)
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('LLM returned no content')
  return JSON.parse(content)
}

// Small concurrency-limited retry wrapper. Real LLM providers (OpenAI) have
// per-account rate limits; this keeps a modest number of chunk calls in
// flight at once and backs off on 429s instead of failing the whole upload.
async function callLlm(creds: LlmCreds, system: string, user: string): Promise<any> {
  const MAX_ATTEMPTS = 4
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await callLlmRaw(creds, system, user)
    } catch (e) {
      const msg = String((e as Error).message || '')
      const retryable = /\b429\b/.test(msg) || /\b5\d\d\b/.test(msg)
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        continue
      }
      throw e
    }
  }
  throw new Error('unreachable')
}

class Semaphore {
  private active = 0
  private queue: (() => void)[] = []
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

export async function extractEdition(
  pdfBuf: ArrayBuffer,
  apiKey: string,
  baseUrl = 'https://api.openai.com/v1',
  model = 'gpt-5-mini',
): Promise<ExtractedEdition> {
  // pdf.js (via unpdf) detaches/transfers the underlying ArrayBuffer while
  // parsing it — pass a copy so the caller's original `pdfBuf` (which also
  // needs to be written to R2 as the stored attachment) stays intact.
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuf.slice(0)))
  const { text } = await extractText(pdf, { mergePages: true })
  // Also pull the raw per-line items (with Y coordinates) so the Executive
  // Summary's paragraph breaks — lost by the merged/flattened `text` above —
  // can be reconstructed. See findParagraphs().
  const { items: itemsPerPage } = await extractTextItems(pdf)
  const flatItems: TextItem[] = []
  for (const page of itemsPerPage) for (const it of page) flatItems.push(it)

  const headerMatch = /Week Update:\s*([\d]{1,2}\s+\w+\.?\s+\d{4})\s*(?:[–\-—]|to)\s*([\d]{1,2}\s+\w+\.?\s+\d{4})/i.exec(text)
  if (!headerMatch) {
    throw new Error(
      'Could not find "Week Update: <start> - <end>" in the PDF header. ' +
      'This upload flow expects the standard Maida Vale weekly brief template.',
    )
  }
  const weekStart = headerMatch[1].trim()
  const weekEnd = headerMatch[2].trim()
  const isoDate = parseHeaderDate(weekEnd)
  if (!isoDate) {
    throw new Error(`Could not parse the week-end date "${weekEnd}" from the PDF header.`)
  }

  const body = getBody(text)

  const idxExecEnd = body.indexOf('Speed Read')
  const idxGlobal = body.indexOf('Global Industry News')
  const idxAsia = body.indexOf('Asia Pacific Industry News')
  const idxMy = body.indexOf('Malaysia Industry News')
  const idxWatch = body.lastIndexOf('Watchlist (Next 7 Days)')

  if (idxExecEnd === -1 || idxGlobal === -1 || idxAsia === -1 || idxMy === -1 || idxWatch === -1) {
    throw new Error('Could not locate one or more expected section headings in the PDF body.')
  }

  // Reconstruct the Executive Summary's real paragraph breaks (Global /
  // Asia-Pacific / Malaysia / etc., one per topic) from line Y-coordinates —
  // the merged `text` above has none. Fall back to the flattened text as a
  // single paragraph if the PDF's layout doesn't match the expected pattern
  // (e.g. a non-standard template) rather than failing the whole upload.
  const execParas = findParagraphs(flatItems, 'Executive Summary', 'Speed Read')
  const execSummary = execParas && execParas.length
    ? execParas.join('<br><br>')
    : body.slice(0, idxExecEnd).replace(/^Executive Summary\s*/, '').trim()

  const speedReadRaw = body.slice(idxExecEnd, idxGlobal)
  const speedRead: string[] = []
  let cur: string | null = null
  for (const line of speedReadRaw.split('\n')) {
    const t = line.trim()
    if (!t || /^Speed Read/.test(t) || /^\d+$/.test(t)) continue
    if (t.startsWith('•')) {
      if (cur) speedRead.push(cur.trim())
      cur = t.replace(/^•\s*/, '')
    } else if (cur !== null) {
      cur += ' ' + t
    }
  }
  if (cur) speedRead.push(cur.trim())

  const globalChunk = body.slice(idxGlobal, idxAsia)
  const asiaChunk = body.slice(idxAsia, idxMy)

  const idxPulse = findHeadingIdx(body, MALAYSIA_HEADS[0], idxMy)
  const idxStruct = findHeadingIdx(body, MALAYSIA_HEADS[1], idxPulse)
  const idxLocal = findHeadingIdx(body, MALAYSIA_HEADS[2], idxStruct)
  const idxPorts = findHeadingIdx(body, MALAYSIA_HEADS[3], idxLocal)
  const idxAuto = findHeadingIdx(body, MALAYSIA_HEADS[4], idxPorts)
  const idxAgri = findHeadingIdx(body, MALAYSIA_HEADS[5], idxAuto)
  const idxEnergy = findHeadingIdx(body, MALAYSIA_HEADS[6], idxAgri)
  const idxDigital = findHeadingIdx(body, MALAYSIA_HEADS[7], idxEnergy)
  const idxProp = findHeadingIdx(body, MALAYSIA_HEADS[8], idxDigital)
  const idxAviation = findHeadingIdx(body, MALAYSIA_HEADS[9], idxProp)
  const idxFinance = findHeadingIdx(body, MALAYSIA_HEADS[10], idxAviation)

  const idxList = [idxPulse, idxStruct, idxLocal, idxPorts, idxAuto, idxAgri, idxEnergy, idxDigital, idxProp, idxAviation, idxFinance]
  if (idxList.some((i) => i === -1)) {
    throw new Error('Could not locate one or more Malaysia subsection headings in the PDF body.')
  }

  const pulseChunk = body.slice(idxPulse, idxStruct)
  const structuralChunk = body.slice(idxStruct, idxLocal)
    .replace(/^\d+\.\s*Structural Macroeconomic Positioning\s*/, '').trim()

  const secChunks: Record<string, string> = {
    'Global - 1. Macroeconomics and Global Market': globalChunk,
    'Asia Pacific - 1. Macroeconomics and Regional Market': asiaChunk,
    'Malaysia - 3. Macroeconomics and Local Market': body.slice(idxLocal, idxPorts),
    'Malaysia - 4. Ports/Logistics/Infrastructure Sector': body.slice(idxPorts, idxAuto),
    'Malaysia - 5. Automotive/Services Sector': body.slice(idxAuto, idxAgri),
    'Malaysia - 6. Agribusiness/Plantation/Food Security Sector': body.slice(idxAgri, idxEnergy),
    'Malaysia - 7. Energy/Utilities/Sustainability Sector': body.slice(idxEnergy, idxDigital),
    'Malaysia - 8. Digital Economy/Technology/Media Sector': body.slice(idxDigital, idxProp),
    'Malaysia - 9. Property Sector': body.slice(idxProp, idxAviation),
    'Malaysia - 10. Aviation Sector': body.slice(idxAviation, idxFinance),
    'Malaysia - 11. Financial Services Sector': body.slice(idxFinance, idxWatch),
  }
  const watchChunk = body.slice(idxWatch)

  const creds: LlmCreds = { apiKey, baseUrl, model }
  const sem = new Semaphore(4)
  const sectionKeys = Object.keys(secChunks)

  const [sectionResults, pulseResult, watchResult] = await Promise.all([
    Promise.all(sectionKeys.map((k) =>
      sem.run(() => callLlm(creds, ITEMS_SYSTEM, secChunks[k])).then((r) => ({ k, items: r.items || [] })),
    )),
    sem.run(() => callLlm(creds, PULSE_SYSTEM, pulseChunk)),
    sem.run(() => callLlm(creds, WATCH_SYSTEM, watchChunk)),
  ])

  const items: NewsItem[] = []
  for (const { k, items: its } of sectionResults) {
    for (const it of its) items.push({ ...it, section: k })
  }

  return {
    weekStart,
    weekEnd,
    date: isoDate,
    label: `${weekStart} to ${weekEnd}`,
    exec_summary: execSummary,
    speed_read: speedRead,
    structural: structuralChunk,
    pulse: (pulseResult.pulse || []) as PulseRow[],
    items,
    watchlist: (watchResult.watchlist || []) as string[],
    beyond: '',
  }
}
