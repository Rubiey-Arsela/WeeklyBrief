# Maida Vale — Weekly Brief

## Project Overview
- **Name**: Weekly Brief (Maida Vale)
- **Goal**: Interactive weekly industry brief for Al Bukhary Group — report viewer, sourced Q&A ("Ask"), cross-edition trends, a Pulse indicator table, sticky notes for reviewer feedback, and PDF/Word export. Originally a Flask + JSON-file prototype; ported to Hono + Cloudflare D1/R2 for edge deployment.
- **Features**:
  - Report viewer with 11 Malaysia subsections preserved, sector filter, three reading modes (wording / table / visual card)
  - Executive Summary tab: this-week paragraph, sector heat, watch-list delta vs last week, carry-forward flags
  - **Ask**: retrieval-only Q&A over the structured edition data — every answer is sourced, no generated content; links the same subject across editions when it recurs
  - **Trends** tab: cross-edition indicator series with sparklines
  - **Indicators** tab: the published weekly Pulse table (Brent, USD/MYR, CNY/MYR, 10Y MGS yield, diesel, KLCI, net foreign flow, palm oil stocks)
  - **Sticky notes**: click-to-drop notes anywhere on the report, shared across all readers (D1-backed), with replies and resolve/reopen
  - **Admin**: add/edit/delete editions (JSON or PDF upload), stored in D1/R2
  - **Export**: PDF and Word documents, same reading order as the report tab, including open reader notes
  - **Read Aloud**: narration via Gemini TTS (requires a `GEMINI_API_KEY` secret — see below); degrades to a clear "not configured" message otherwise

## URLs
- **Production (Cloudflare Pages)**: https://Maida-Vale-Weekly-Brief.pages.dev
  - Domain names are case-insensitive, so this is identical to `maida-vale-weekly-brief.pages.dev` — either capitalisation works.
- **Legacy (Genspark-hosted)**: https://4885e888-466b-40fb-921f-d42d91dc863a.vip.gensparksite.com
- **GitHub**: https://github.com/Rubiey-Arsela/WeeklyBrief

## API Endpoints
| Route | Purpose |
|---|---|
| `GET /` | the app |
| `GET /api/editions` | edition list |
| `GET /api/edition/<id\|latest>` | one edition, view-model shape (sections/indicators/trends/delta) |
| `POST /api/edition` | create/replace an edition from JSON |
| `POST /api/edition/upload-pdf` | create an edition from a PDF (multipart, 20 MB cap, stored in R2) |
| `PUT /api/edition/<id>` | update an edition |
| `DELETE /api/edition/<id>` | delete an edition (also removes its PDF from R2) |
| `POST /api/ask` | `{query}` → `{answer, sources[], editions_referenced[]}` |
| `GET/POST /api/notes`, `PUT/DELETE /api/notes/<id>` | sticky notes (shared, D1-backed) |
| `GET /api/voices` | narration voices |
| `POST /api/tts/plan` | split an edition into narration chunks |
| `POST /api/tts` | `{text, voice}` → cached audio URL (R2) |
| `GET /api/export/<id>.pdf` / `.docx` | generated document |
| `GET /pdf/<name>`, `GET /audio/<name>` | files stored in R2 |
| `POST /api/feedback`, `GET /api/feedback` | free-text feedback log |

## Data Architecture
- **Storage**: Cloudflare D1 (editions, notes, feedback, corpus reference data) + Cloudflare R2 (uploaded PDFs, generated narration audio cache)
- **Data model**: `editions` keep the flat, as-authored item list per week (same shape as the original `editions.json`); a `corpus` singleton row holds entities/indicators/trends/published-section-order shared across editions. A TypeScript port of the original Python `view_model()` derives the grouped sections, Pulse rows, trends, and watch-list delta at read time — the stored shape is never reshaped.
- **Ask**: pure retrieval over `corpus` + `editions` (token-overlap scoring, entity/grade/trend detection, cross-edition linking) — no LLM call, so every answer is traceable to a stored row.

## User Guide
1. Open the production URL. The latest edition loads by default; switch editions from the masthead dropdown.
2. Use the tab bar (Executive Summary / Report / Ask / Trends / Indicators) to navigate.
3. In **Report**, filter by sector, switch reading mode (Wording/Table/Visual), or click **Add note** then click anywhere on the report to drop a sticky note — visible to every reader of that edition.
4. Use **Ask** to type a question or click a suggested chip; answers cite the specific news items and indicator series behind them.
5. Use **Export ▾** to download the edition as PDF or Word, or use **Add Report** / **Manage Reports** to create/edit/delete editions (JSON or PDF upload).
6. **Read Aloud** narrates the report section by section — requires the `GEMINI_API_KEY` secret to be set (see Deployment below); without it, the button reports "narration not configured" instead of failing silently.

## Deployment
- **Platform**: Cloudflare Pages, deployed directly to the client's own Cloudflare account via `wrangler` (BYOK)
  - Project name: `maida-vale-weekly-brief`
  - D1 database: `maida-vale-weekly-brief-db`
  - R2 bucket: `maida-vale-weekly-brief-bucket`
  - A previous deployment also exists on Genspark-hosted Workers for Platforms (`gsk hosted deploy`) — kept live as a legacy/backup URL, not the primary link.
- **Status**: ✅ Active
- **Tech Stack**: Hono + TypeScript, Cloudflare D1, Cloudflare R2, `pdf-lib` (PDF export), `docx` (Word export)
- **Enabling narration**: set a Gemini API key as a Worker secret on the Pages project, e.g. `npx wrangler pages secret put GEMINI_API_KEY --project-name maida-vale-weekly-brief`
- **Last Updated**: 2026-09-18

## Porting notes (from the original Flask prototype)
The original app (`app.py` + `modules.py`, Flask + JSON files) is preserved for reference. Key differences in this port:
- Storage moved from JSON files (`data/editions.json`, `data/notes.json`) to Cloudflare D1; PDF/audio files moved from local disk to R2.
- TTS moved from shelling out to the `gsk` CLI (sandbox-only) to a direct Gemini TTS REST API call, gated on a `GEMINI_API_KEY` secret.
- PDF/Word export moved from `reportlab`/`python-docx` (Python-only) to `pdf-lib`/`docx` (pure JS, runs on Workers) — same content and reading order, not pixel-identical to the original.
- The frontend (`static/index.html`) is served **unchanged** — no UI code was modified during the port.
