import { extractText, getDocumentProxy } from 'unpdf'
import fs from 'fs'
import * as yaml from 'js-yaml'
import os from 'os'
import path from 'path'

const configPath = path.join(os.homedir(), '.genspark_llm.yaml')
const config = yaml.load(fs.readFileSync(configPath, 'utf8'))

let activeLLM = 0
const MAX_CONCURRENT = 4
const queue = []
function runQueued(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject })
    pump()
  })
}
function pump() {
  while (activeLLM < MAX_CONCURRENT && queue.length) {
    const { fn, resolve, reject } = queue.shift()
    activeLLM++
    fn().then(resolve, reject).finally(() => { activeLLM--; pump() })
  }
}

async function callLLMRaw(system, user, model='gpt-5-mini') {
  const resp = await fetch(config.openai.base_url + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.openai.api_key },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
    }),
  })
  const raw = await resp.text()
  if (!resp.ok) throw new Error('LLM error ' + resp.status + ': ' + raw.slice(0,500))
  const data = JSON.parse(raw)
  return JSON.parse(data.choices[0].message.content)
}

async function callLLM(system, user, model='gpt-5-mini') {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await runQueued(() => callLLMRaw(system, user, model))
    } catch (e) {
      if (String(e.message).includes('429') && attempt < 3) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
        continue
      }
      throw e
    }
  }
}

function getBody(text) {
  const first = text.indexOf('Executive Summary')
  const second = text.indexOf('Executive Summary', first + 1)
  return second === -1 ? text : text.slice(second)
}

const HEADS = [
  'Weekly Macroeconomic Pulse','Structural Macroeconomic Positioning','Macroeconomics and Local Market',
  'Ports/Logistics/Infrastructure Sector','Automotive/Services Sector','Agribusiness/Plantation/Food Security Sector',
  'Energy/Utilities/Sustainability Sector','Digital Economy/Technology/Media Sector','Property Sector',
  'Aviation Sector','Financial Services Sector',
]
function findHeadingIdx(body, title, fromIdx) {
  const re = new RegExp('\\d{1,2}\\.\\s*' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g,'\\s+'))
  const m = re.exec(body.slice(fromIdx))
  return m ? fromIdx + m.index : -1
}

const ITEMS_SYSTEM = `Extract every news item row from this industry-news table section into JSON: {"items":[{"section":"<full heading exactly as printed, e.g. \"Macroeconomics and Local Market\">","headline":"...","source":"...","grade":"Positive|Negative|Mixed|Neutral","summary":"...","impact":"...","regulatory":"..."}]}.
One item per table row. "source" is the parenthetical citation e.g. "Reuters, 1 Jul 2026" (no parentheses). "grade" is the leading word of the "Near term Impact & Strategic Implications" cell. "impact" is that cell's text AFTER the leading grade word and its period. "regulatory" is the "Regulatory/Policy Changes" cell text, or "" if it was just "-".
If the section states "No material ... developments were identified", output {"items":[]}.
Preserve figures/dates exactly as printed. Output ONLY the JSON object, no commentary, no markdown fences.`

const PULSE_SYSTEM = `Extract the Weekly Macroeconomic Pulse table rows into JSON: {"pulse":[{"indicator":"...","weekly":"...","previous":"...","direction":"...","implication":"..."}]}.
Ignore chart/axis noise (numbers like axis labels, month names). "direction" should include the arrow (↑/↓/→) plus the % or descriptive text next to it, e.g. "↓ 1.5% wow". "weekly"/"previous" are the This-week/Previous-week cell values (may be multi-line bullet lists — join with "; "). "implication" is the Strategic Implication cell.
Output ONLY the JSON object, no commentary.`

const WATCH_SYSTEM = `Extract each numbered Watchlist item into JSON: {"watchlist":["...", ...]}. Each array entry is one full numbered item's complete text (title + explanation), with the leading number removed. Output ONLY the JSON object, no commentary.`

async function processFile(fname) {
  const buf = fs.readFileSync('/home/user/uploaded_files/' + fname)
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(pdf, { mergePages: true })
  const body = getBody(text)

  const m = /Week Update:\s*([\d]{1,2}\s+\w+\.?\s+\d{4})\s*(?:[–\-—]|to)\s*([\d]{1,2}\s+\w+\.?\s+\d{4})/i.exec(text)

  const idxExecEnd = body.indexOf('Speed Read')
  const idxGlobal = body.indexOf('Global Industry News')
  const idxAsia = body.indexOf('Asia Pacific Industry News')
  const idxMy = body.indexOf('Malaysia Industry News')
  const idxWatch = body.lastIndexOf('Watchlist (Next 7 Days)')

  const execSummary = body.slice(0, idxExecEnd).replace(/^Executive Summary\s*/, '').trim().split('\n\n').map(p=>p.trim()).filter(Boolean).join('<br><br>')

  const speedReadRaw = body.slice(idxExecEnd, idxGlobal)
  const bulletJoined = []
  let cur = null
  for (const line of speedReadRaw.split('\n')) {
    const t = line.trim()
    if (!t || /^Speed Read/.test(t) || /^\d+$/.test(t)) continue
    if (t.startsWith('•')) { if (cur) bulletJoined.push(cur.trim()); cur = t.replace(/^•\s*/, '') }
    else if (cur !== null) cur += ' ' + t
  }
  if (cur) bulletJoined.push(cur.trim())

  const globalChunk = body.slice(idxGlobal, idxAsia)
  const asiaChunk = body.slice(idxAsia, idxMy)

  const idxPulse = findHeadingIdx(body, HEADS[0], idxMy)
  const idxStruct = findHeadingIdx(body, HEADS[1], idxPulse)
  const idxLocal = findHeadingIdx(body, HEADS[2], idxStruct)
  const idxPorts = findHeadingIdx(body, HEADS[3], idxLocal)
  const idxAuto = findHeadingIdx(body, HEADS[4], idxPorts)
  const idxAgri = findHeadingIdx(body, HEADS[5], idxAuto)
  const idxEnergy = findHeadingIdx(body, HEADS[6], idxAgri)
  const idxDigital = findHeadingIdx(body, HEADS[7], idxEnergy)
  const idxProp = findHeadingIdx(body, HEADS[8], idxDigital)
  const idxAviation = findHeadingIdx(body, HEADS[9], idxProp)
  const idxFinance = findHeadingIdx(body, HEADS[10], idxAviation)

  const pulseChunk = body.slice(idxPulse, idxStruct)
  const structuralChunk = body.slice(idxStruct, idxLocal).replace(/^\d+\.\s*Structural Macroeconomic Positioning\s*/, '').trim()
  const secChunks = {
    'Malaysia - 3. Macroeconomics and Local Market': body.slice(idxLocal, idxPorts),
    'Malaysia - 4. Ports/Logistics/Infrastructure Sector': body.slice(idxPorts, idxAuto),
    'Malaysia - 5. Automotive/Services Sector': body.slice(idxAuto, idxAgri),
    'Malaysia - 6. Agribusiness/Plantation/Food Security Sector': body.slice(idxAgri, idxEnergy),
    'Malaysia - 7. Energy/Utilities/Sustainability Sector': body.slice(idxEnergy, idxDigital),
    'Malaysia - 8. Digital Economy/Technology/Media Sector': body.slice(idxDigital, idxProp),
    'Malaysia - 9. Property Sector': body.slice(idxProp, idxAviation),
    'Malaysia - 10. Aviation Sector': body.slice(idxAviation, idxFinance),
    'Malaysia - 11. Financial Services Sector': body.slice(idxFinance, idxWatch),
    'Global - 1. Macroeconomics and Global Market': globalChunk,
    'Asia Pacific - 1. Macroeconomics and Regional Market': asiaChunk,
  }
  const watchChunk = body.slice(idxWatch)

  // Parallel LLM calls
  const sectionKeys = Object.keys(secChunks)
  const [sectionResults, pulseResult, watchResult] = await Promise.all([
    Promise.all(sectionKeys.map(k => callLLM(ITEMS_SYSTEM, secChunks[k]).then(r => ({k, items: r.items||[]})))),
    callLLM(PULSE_SYSTEM, pulseChunk),
    callLLM(WATCH_SYSTEM, watchChunk),
  ])

  const items = []
  for (const {k, items: its} of sectionResults) {
    for (const it of its) items.push({ ...it, section: k })
  }

  return {
    id: null,
    label: m ? `${m[1]} to ${m[2]}` : '',
    date: null,
    week_start: m?.[1], week_end: m?.[2],
    exec_summary: execSummary,
    speed_read: bulletJoined,
    structural: structuralChunk,
    pulse: pulseResult.pulse || [],
    items,
    watchlist: watchResult.watchlist || [],
    beyond: '',
  }
}


const files = fs.readdirSync('/home/user/uploaded_files').filter(f=>f.endsWith('.pdf'))
const results = {}
await Promise.all(files.map(async (f) => {
  const t0 = Date.now()
  try {
    const r = await processFile(f)
    results[f] = { ok: true, elapsed: Date.now()-t0, label: r.label, exec_len: r.exec_summary.length,
      speed_read: r.speed_read.length, structural_len: r.structural.length, pulse: r.pulse.length,
      items: r.items.length, watchlist: r.watchlist.length, full: r }
    console.log(f, 'OK', Date.now()-t0, 'ms', 'items:', r.items.length, 'pulse:', r.pulse.length, 'watch:', r.watchlist.length, 'speedread:', r.speed_read.length)
  } catch (e) {
    results[f] = { ok: false, error: e.message }
    console.log(f, 'FAIL', e.message)
  }
}))
fs.writeFileSync('/tmp/all_results.json', JSON.stringify(results, null, 2))
