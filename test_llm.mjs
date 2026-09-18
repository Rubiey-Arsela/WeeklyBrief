import { extractText, getDocumentProxy } from 'unpdf'
import fs from 'fs'
import * as yaml from 'js-yaml'
import os from 'os'
import path from 'path'

const configPath = path.join(os.homedir(), '.genspark_llm.yaml')
const config = yaml.load(fs.readFileSync(configPath, 'utf8'))

const buf = fs.readFileSync('/home/user/uploaded_files/Maida Vale - Weekly Brief - 20260703.pdf')
const pdf = await getDocumentProxy(new Uint8Array(buf))
const { text } = await extractText(pdf, { mergePages: true })
console.log('extracted text length:', text.length)

const SYSTEM = `You convert a weekly industry brief PDF (plain text extracted from PDF) into a strict JSON object matching this TypeScript shape:

{
  "exec_summary": string,        // HTML allowed (<br><br> between paragraphs), the Executive Summary section verbatim
  "speed_read": string[],        // each bullet from "Speed Read (Top 10 Takeaways)"
  "structural": string,          // the "Structural Macroeconomic Positioning" paragraph text
  "beyond": string,               // "Beyond Seven Days" / outlook paragraph if present, else ""
  "watchlist": string[],          // each numbered item from "Watchlist (Next 7 Days)", full text including its explanation
  "pulse": [{ "indicator": string, "weekly": string, "previous": string, "direction": string, "implication": string }],  // from "1. Weekly Macroeconomic Pulse" table rows
  "items": [{
    "section": string,  // e.g. "Global - 1. Macroeconomics and Global Market", "Malaysia - 4. Ports/Logistics/Infrastructure Sector" — combine the region heading (Global/Asia Pacific/Malaysia) with the numbered subsection heading exactly as printed
    "headline": string,
    "source": string,   // e.g. "Reuters, 1 Jul 2026"
    "grade": "Positive"|"Negative"|"Mixed"|"Neutral",  // derived from the leading word of the "Near term Impact & Strategic Implications" cell
    "summary": string,  // the Summary cell text
    "impact": string,   // rest of the "Near term Impact & Strategic Implications" cell after the leading grade word
    "regulatory": string // the "Regulatory/Policy Changes" cell, "" if it was just "-"
  }]
}

Rules:
- Extract every item from every numbered subsection table across Global/Asia Pacific/Malaysia industry news pages. Do not skip or summarize items — one JSON item per table row.
- If a subsection says "No material ... developments were identified", do not create an item for it.
- Preserve numbers, dates and figures exactly as printed.
- Output ONLY the JSON object, no markdown fences, no commentary.`

const resp = await fetch(config.openai.base_url + '/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.openai.api_key },
  body: JSON.stringify({
    model: 'gpt-5-mini',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: text },
    ],
    response_format: { type: 'json_object' },
  }),
})
const data = await resp.json()
if (!resp.ok) { console.error(JSON.stringify(data)); process.exit(1) }
const content = data.choices[0].message.content
fs.writeFileSync('/tmp/extracted.json', content)
console.log('output length:', content.length)
const parsed = JSON.parse(content)
console.log('items:', parsed.items?.length)
console.log('pulse rows:', parsed.pulse?.length)
console.log('speed_read:', parsed.speed_read?.length)
console.log('watchlist:', parsed.watchlist?.length)
console.log(JSON.stringify(parsed.items?.[0], null, 2))
console.log(JSON.stringify(parsed.pulse?.[0], null, 2))
