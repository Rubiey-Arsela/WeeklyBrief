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
  - **Admin**: add/edit/delete editions, **PDF-only upload** — week number, date **and the full report content** (Executive Summary, Speed Read, Structural Positioning, Weekly Pulse table, all graded news items, Watchlist) are extracted straight from the PDF's own text; no manual entry, no JSON upload option, and no dependency on the upload date, so past editions can be backfilled and future ones uploaded ahead of time
  - **Export**: PDF and Word documents, same reading order as the report tab, including open reader notes; Word export now hyperlinks "Source: X" straight to the article's exact URL when one is on file (PDF export source lines remain plain text — `pdf-lib` has no top-level hyperlink helper, flagged as outstanding)
  - **Read Aloud**: narration via Gemini TTS (requires a `GEMINI_API_KEY` secret — see below); degrades to a clear "not configured" message otherwise
  - **Lead-with-what-changed**: a card at the top of Executive Summary surfacing new/escalated Watch List items and the biggest indicator moves since last week, each clickable straight to its source
  - **Ranked, clickable Speed Read**: Speed Read lines are matched back to their full report item (token-overlap scoring), sorted so critical/high-impact items surface first, and clicking a line jumps to and highlights that item in the Report tab
  - **Sticky section rail + reading progress**: a desktop-only scrollspy rail alongside the Report tab (with a live progress-fill bar) plus a thin mobile progress strip under the tab bar
  - **Glossary**: a shared, admin-maintained term list (BNM, OPR, DOSM, CPO, etc.); terms found in report text get a dotted-underline hover tooltip, and a toolbar button opens the full glossary modal
  - **Archive Search**: a dedicated "Search Archive" tab that ranks matching news items across *every* loaded edition (not just the current week), distinct from the edition-locked Ask tab
  - **Shareable links**: the current edition/tab/sector/search-query are kept in the URL; a masthead "🔗 Share" button copies a link that reopens the exact same view, and browser back/forward works as expected
  - **Mobile toolbar fixes**: Ask's scope toggle, the export dropdown, the highlight toolbar and the search bar all stack/clamp correctly on narrow screens

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
| `POST /api/edition/upload-pdf` | create/replace an edition from a PDF (multipart, 20 MB cap, stored in R2); week, date and full report content are extracted from the PDF's own text server-side |
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
| `GET /api/search?q=` | ranked archive search across all editions → `{query, hits[]}` (title/body token-overlap match, no synthesis) |
| `GET /api/glossary` | public — all glossary terms, sorted alphabetically |
| `POST /api/glossary` | staff-only — upsert a term `{display_term, definition}` |
| `DELETE /api/glossary/:term` | staff-only — remove a term |

## Data Architecture
- **Storage**: Cloudflare D1 (editions, notes, feedback, corpus reference data, glossary) + Cloudflare R2 (uploaded PDFs, generated narration audio cache)
- **Glossary**: a small shared D1 table (`glossary`), not per-edition — `term` (lowercase key), `display_term`, `definition`. Seeded via `migrations/0007_glossary.sql` with ~24 Malaysia/sector terms (OPR, BNM, DOSM, SST, GDP, FDI, IPP, FiT, NEM, PTP, Bursa Malaysia, FBM KLCI, RON95/97, MOF, EPF, Khazanah, Petronas, Brent Crude, CPO, MCO, Data Centre, etc). Reader-facing GET is public; POST/DELETE are staff-gated. No admin UI exists yet to add/edit terms outside the migration — only the raw API routes.
- **Data model**: `editions` keep the flat, as-authored item list per week (same shape as the original `editions.json`); a `corpus` singleton row holds entities/indicators/trends/published-section-order shared across editions. A TypeScript port of the original Python `view_model()` derives the grouped sections, Pulse rows, trends, and watch-list delta at read time — the stored shape is never reshaped.
- **Ask**: pure retrieval over `corpus` + `editions` (token-overlap scoring, entity/grade/trend detection, cross-edition linking) — no LLM call, so every answer is traceable to a stored row.
- **PDF content extraction** (`src/pdfExtract.ts`): runs once per upload, entirely server-side.
  1. Extracts raw text with `unpdf` (Workers-compatible, no filesystem/native deps).
  2. Reads the week-range and publish-date straight from the PDF's own printed header (`Week Update: <start> – <end>` / `Date: <end>`) — never from the upload timestamp.
  3. Strips the cover/Table of Content by slicing from the second occurrence of "Executive Summary" in the text.
  4. Splits the body deterministically using the report's own fixed subsection headings as anchors (same 11 Malaysia subsections + Global + Asia Pacific in every edition) into small bounded chunks.
  5. Extracts each chunk with a small, parallel OpenAI-compatible chat-completion call (`response_format: json_object`) — small bounded context avoids the hallucination/mis-numbering a single large-prompt extraction produced in testing.
  6. Writes the combined result into the edition's `exec_summary`, `speed_read`, `structural`, `pulse`, `items`, `watchlist` columns via the same upsert used by manual edits — so Report/Ask/Trends/Indicators are populated exactly as if the edition had been entered by hand.
  - Requires an `OPENAI_API_KEY` Cloudflare secret (see Deployment below). If missing, `upload-pdf` returns a clear 500 instead of silently storing an empty edition.

## User Guide
1. Open the production URL. The latest edition loads by default; switch editions from the masthead dropdown.
2. Use the tab bar (Executive Summary / Report / Ask / Trends / Indicators) to navigate.
3. In **Report**, filter by sector, switch reading mode (Wording/Table/Visual), or click **Add note** then click anywhere on the report to drop a sticky note — visible to every reader of that edition.
4. Use **Ask** to type a question or click a suggested chip; answers cite the specific news items and indicator series behind them.
5. Use **Export ▾** to download the edition as PDF or Word, or use **Add Report** to upload a new week's PDF — week number, date and the full report content are extracted automatically from the PDF itself (takes up to a minute; works for past or future editions, not just the current week). **Manage Reports** lets you edit an edition's date, replace its PDF (which re-extracts everything from the new file), or delete it.
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
- **Enabling PDF content extraction**: set an OpenAI-compatible API key as a Worker secret, e.g. `npx wrangler pages secret put OPENAI_API_KEY --project-name maida-vale-weekly-brief`. If the account's base URL differs from `https://api.openai.com/v1`, also set `OPENAI_BASE_URL`. Without `OPENAI_API_KEY`, PDF upload is disabled with a clear error rather than silently creating a content-free edition.
- **Last Updated**: 2026-11-28 (engagement batch: shareable URLs, archive search, section rail + reading progress, lead-with-what-changed, ranked/clickable Speed Read, glossary, mobile toolbar fixes, Word export source hyperlinks — `0007_glossary.sql` applied to production D1)

## Not yet implemented
- **Notes author/reply polish**: replies exist (author field, reply UI) but have not been reviewed/extended this round — revisit if the director wants more than the current baseline.
- **Friday-rhythm notification**: no reminder/notification mechanism yet. Since this app deploys BYOK (direct `wrangler pages deploy`, not Genspark hosted deploy), Cloudflare `triggers` (cron) are usable here if wanted — needs a decision on delivery channel (email/WhatsApp/in-app banner) before building.
- **Board-pack PDF**: a distinct, more presentation-ready export than the existing `exportPdf()` — not started.
- **PDF export source hyperlinks**: Word (`docx`) export now links "Source: X" to the article URL; the PDF export (`pdf-lib`) has no top-level hyperlink helper, so this still renders as plain text — would need manual `PDFAnnotation`/link-annotation construction.
- **Admin glossary editor UI**: `POST`/`DELETE /api/glossary` exist and are staff-gated, but there's no admin.html screen to call them yet — new/changed terms currently require a DB migration or a manual API call.

## Porting notes (from the original Flask prototype)
The original app (`app.py` + `modules.py`, Flask + JSON files) is preserved for reference. Key differences in this port:
- Storage moved from JSON files (`data/editions.json`, `data/notes.json`) to Cloudflare D1; PDF/audio files moved from local disk to R2.
- TTS moved from shelling out to the `gsk` CLI (sandbox-only) to a direct Gemini TTS REST API call, gated on a `GEMINI_API_KEY` secret.
- PDF/Word export moved from `reportlab`/`python-docx` (Python-only) to `pdf-lib`/`docx` (pure JS, runs on Workers) — same content and reading order, not pixel-identical to the original.
- The frontend (`static/index.html`) is served **unchanged** — no UI code was modified during the port.

## Admin workflow: PDF-only uploads
Since the client only ever supplies weekly reports as PDF, JSON-based edition creation was removed entirely:
- **Add Report**: drop/select a PDF only. The server reads the week/date from the PDF's own header text and extracts the full report content — the modal simply shows a "reading the PDF…" status while this happens, then the detected week/date once done. Because it reads the PDF's own header, editions can be uploaded in any order — backfilling old weeks and uploading future weeks both work the same way.
- **Manage Reports → Edit**: change the date directly (content untouched), and/or drop a replacement PDF — which re-runs full extraction and can change which edition (`W<week>`) is updated if the new PDF is for a different week.
- The edition id is always `W<week>`, where `week` is the ISO-8601 week number of the date printed in the PDF's own header (not the upload date). Uploading a PDF for a week that already has an edition updates it in place rather than creating a duplicate.
- `isoWeek()` (in `src/viewmodel.ts`) implements the standard ISO-8601 rule (Thursday-of-the-week anchoring), verified against Python's `datetime.isocalendar()`.
- Extraction expects the standard Maida Vale weekly brief template (the same Table of Content structure across all 9 real editions tested: Global → Asia Pacific → Malaysia's 11 subsections → Watchlist). A PDF that doesn't match this structure fails upload with a specific error naming the missing section, rather than silently creating a blank edition.
