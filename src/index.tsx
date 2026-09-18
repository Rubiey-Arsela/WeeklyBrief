import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { AppEnv, Corpus, Edition, Note, PdfMeta } from './types'
import { viewModel, weekOf, tokens } from './viewmodel'
import { ask } from './ask'
import { VOICES, synthesise } from './tts'
import { exportDocx, exportPdf } from './export'
// The original static/index.html frontend, imported verbatim as a raw
// string at build time and served unchanged — see src/frontend.html.
// @ts-ignore - vite raw import
import frontendHtml from './frontend.html?raw'

const app = new Hono<AppEnv>()

app.use('/api/*', cors())
app.use('/static/*', serveStatic({ root: './public' }))
app.use('/favicon.ico', serveStatic({ path: './public/favicon.ico' }))

const MAX_PDF = 20 * 1024 * 1024

// ------------------------------------------------------------------ helpers
async function loadCorpus(db: D1Database): Promise<Corpus> {
  const row = await db.prepare('SELECT * FROM corpus WHERE id = 1').first<any>()
  if (!row) {
    return { source_note: '', entities: [], indicators: [], trends: [], sections: [] }
  }
  return {
    source_note: row.source_note || '',
    entities: JSON.parse(row.entities || '[]'),
    indicators: JSON.parse(row.indicators || '[]'),
    trends: JSON.parse(row.trends || '[]'),
    sections: JSON.parse(row.sections || '[]'),
  }
}

function rowToEdition(row: any): Edition {
  return {
    id: row.id,
    label: row.label || '',
    date: row.date || '',
    status: row.status || '',
    exec_summary: row.exec_summary || '',
    speed_read: JSON.parse(row.speed_read || '[]'),
    structural: row.structural || '',
    pulse: JSON.parse(row.pulse || '[]'),
    items: JSON.parse(row.items || '[]'),
    watchlist: JSON.parse(row.watchlist || '[]'),
    beyond: row.beyond || '',
    pdf: row.pdf ? JSON.parse(row.pdf) as PdfMeta : null,
  }
}

async function loadEditions(db: D1Database): Promise<Edition[]> {
  const { results } = await db.prepare('SELECT * FROM editions').all()
  return (results || []).map(rowToEdition).sort((a, b) => (a.date < b.date ? -1 : 1))
}

function upsertEditionSql() {
  return `INSERT INTO editions
    (id, label, date, status, exec_summary, speed_read, structural, pulse, items, watchlist, beyond, pdf, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      label=excluded.label, date=excluded.date, status=excluded.status,
      exec_summary=excluded.exec_summary, speed_read=excluded.speed_read,
      structural=excluded.structural, pulse=excluded.pulse, items=excluded.items,
      watchlist=excluded.watchlist, beyond=excluded.beyond, pdf=excluded.pdf,
      updated_at=datetime('now')`
}

function rowToNote(row: any): Note {
  return {
    id: row.id,
    edition: row.edition,
    anchor: row.anchor || '',
    x: row.x,
    y: row.y,
    text: row.text || '',
    author: row.author || 'Anonymous',
    colour: row.colour || 'yellow',
    resolved: !!row.resolved,
    created: row.created,
    updated: row.updated,
    replies: JSON.parse(row.replies || '[]'),
  }
}

function randId(prefix: string, len = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, len)
  return prefix + hex
}

// ------------------------------------------------------------------ frontend
app.get('/', (c) => c.html(frontendHtml as string))

// ------------------------------------------------------------------ editions
app.get('/api/editions', async (c) => {
  const eds = await loadEditions(c.env.DB)
  const out = eds.map((ed) => ({
    id: ed.id,
    week: weekOf(ed),
    label: ed.label,
    date: ed.date,
    sections: new Set(ed.items.map((i) => i.section)).size,
    items: ed.items.length,
    pdf: ed.pdf ?? null,
  }))
  return c.json(out)
})

app.get('/api/edition/:id', async (c) => {
  const db = c.env.DB
  const editions = await loadEditions(db)
  if (!editions.length) return c.json({ error: 'not found' }, 404)
  const id = c.req.param('id')
  const ed = id === 'latest' || id === 'current' ? editions[editions.length - 1] : editions.find((e) => e.id === id)
  if (!ed) return c.json({ error: 'not found' }, 404)
  const corpus = await loadCorpus(db)
  return c.json(viewModel(corpus, editions, ed))
})

app.post('/api/edition', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const week = body.week
  const date = body.date
  if (!week || !date) return c.json({ ok: false, error: 'week and date are required' }, 400)

  const id = body.id || `W${parseInt(week, 10)}`
  const ed: Edition = {
    id,
    label: body.label || `Week ${week}`,
    date,
    status: body.status || 'draft',
    exec_summary: body.exec_summary || '',
    speed_read: body.speed_read || [],
    structural: body.structural || '',
    pulse: body.pulse || [],
    items: body.items || [],
    watchlist: body.watchlist || [],
    beyond: body.beyond || '',
    pdf: body.pdf || null,
  }

  const db = c.env.DB
  await db.prepare(upsertEditionSql()).bind(
    ed.id, ed.label, ed.date, ed.status, ed.exec_summary,
    JSON.stringify(ed.speed_read), ed.structural, JSON.stringify(ed.pulse),
    JSON.stringify(ed.items), JSON.stringify(ed.watchlist), ed.beyond,
    ed.pdf ? JSON.stringify(ed.pdf) : null,
  ).run()

  // Track any new section names on the corpus so the published order grows.
  const corpus = await loadCorpus(db)
  const known = new Set(corpus.sections)
  let changed = false
  for (const it of ed.items) {
    if (it.section && !known.has(it.section)) { known.add(it.section); corpus.sections.push(it.section); changed = true }
  }
  if (changed) {
    await db.prepare('UPDATE corpus SET sections = ? WHERE id = 1').bind(JSON.stringify(corpus.sections)).run()
  }

  const editions = await loadEditions(db)
  return c.json(viewModel(await loadCorpus(db), editions, ed))
})

app.post('/api/edition/upload-pdf', async (c) => {
  const form = await c.req.formData()
  const week = form.get('week') as string | null
  const date = form.get('date') as string | null
  const file = form.get('pdf') as File | null

  if (!week || !date) return c.json({ ok: false, error: 'week and date are required' }, 400)
  if (!file || !file.name) return c.json({ ok: false, error: 'no pdf file in request' }, 400)
  if (!file.name.toLowerCase().endsWith('.pdf')) return c.json({ ok: false, error: 'file must be a .pdf' }, 400)
  if (file.size > MAX_PDF) return c.json({ ok: false, error: 'pdf exceeds 20 MB' }, 413)

  const safe = file.name.replace(/[^A-Za-z0-9._-]/g, '_')
  const eid = `W${parseInt(week, 10)}`
  const stored = `pdf/${eid}-${date}-${safe}`
  const buf = await file.arrayBuffer()
  await c.env.R2.put(stored, buf, { httpMetadata: { contentType: 'application/pdf' } })

  const pdf: PdfMeta = { name: safe, url: `/pdf/${eid}-${date}-${safe}`, size: file.size, r2_key: stored }

  const db = c.env.DB
  const existing = await db.prepare('SELECT id FROM editions WHERE id = ?').bind(eid).first()
  if (!existing) {
    await db.prepare(upsertEditionSql()).bind(
      eid, `Week ${week}`, date, 'pdf', '', '[]', '', '[]', '[]', '[]', '', JSON.stringify(pdf),
    ).run()
  } else {
    await db.prepare('UPDATE editions SET date = ?, pdf = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .bind(date, JSON.stringify(pdf), eid).run()
  }

  const editions = await loadEditions(db)
  const ed = editions.find((e) => e.id === eid)!
  return c.json(viewModel(await loadCorpus(db), editions, ed))
})

app.put('/api/edition/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const editions = await loadEditions(db)
  const ed = editions.find((e) => e.id === id)
  if (!ed) return c.json({ error: 'not found' }, 404)
  const body = await c.req.json().catch(() => ({}))

  const merged: Edition = {
    ...ed,
    ...('label' in body ? { label: body.label } : {}),
    ...('date' in body ? { date: body.date } : {}),
    ...('status' in body ? { status: body.status } : {}),
    ...('exec_summary' in body ? { exec_summary: body.exec_summary } : {}),
    ...('speed_read' in body ? { speed_read: body.speed_read } : {}),
    ...('structural' in body ? { structural: body.structural } : {}),
    ...('pulse' in body ? { pulse: body.pulse } : {}),
    ...('items' in body ? { items: body.items } : {}),
    ...('watchlist' in body ? { watchlist: body.watchlist } : {}),
    ...('beyond' in body ? { beyond: body.beyond } : {}),
    ...('pdf' in body ? { pdf: body.pdf } : {}),
  }

  await db.prepare(upsertEditionSql()).bind(
    merged.id, merged.label, merged.date, merged.status, merged.exec_summary,
    JSON.stringify(merged.speed_read), merged.structural, JSON.stringify(merged.pulse),
    JSON.stringify(merged.items), JSON.stringify(merged.watchlist), merged.beyond,
    merged.pdf ? JSON.stringify(merged.pdf) : null,
  ).run()

  const freshEditions = await loadEditions(db)
  return c.json(viewModel(await loadCorpus(db), freshEditions, merged))
})

app.delete('/api/edition/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const row = await db.prepare('SELECT pdf FROM editions WHERE id = ?').bind(id).first<any>()
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.pdf) {
    try {
      const pdf = JSON.parse(row.pdf) as PdfMeta
      if (pdf.r2_key) await c.env.R2.delete(pdf.r2_key)
    } catch { /* ignore */ }
  }
  await db.prepare('DELETE FROM editions WHERE id = ?').bind(id).run()
  return c.json({ ok: true, deleted: id })
})

app.get('/pdf/:name', async (c) => {
  const name = c.req.param('name')
  const obj = await c.env.R2.get(`pdf/${name}`)
  if (!obj) return c.notFound()
  return new Response(obj.body, { headers: { 'Content-Type': 'application/pdf' } })
})

// ------------------------------------------------------------------------ ask
app.post('/api/ask', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const q = body.query || body.q || ''
  const db = c.env.DB
  const corpus = await loadCorpus(db)
  const editions = await loadEditions(db)
  return c.json(ask(corpus, editions, q))
})

// ---------------------------------------------------------------------- notes
app.get('/api/notes', async (c) => {
  const edition = c.req.query('edition')
  const db = c.env.DB
  let query = 'SELECT * FROM notes'
  const binds: any[] = []
  if (edition) { query += ' WHERE edition = ?'; binds.push(edition) }
  query += ' ORDER BY created ASC'
  const { results } = await db.prepare(query).bind(...binds).all()
  return c.json((results || []).map(rowToNote))
})

app.post('/api/notes', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (!(body.text || '').trim()) return c.json({ ok: false, error: 'note text is required' }, 400)
  const now = new Date().toISOString()
  const note: Note = {
    id: randId('n'),
    edition: body.edition || '',
    anchor: body.anchor || '',
    x: parseFloat(body.x ?? 0.5),
    y: parseFloat(body.y ?? 0.5),
    text: (body.text || '').slice(0, 2000),
    author: (body.author || 'Anonymous').slice(0, 60),
    colour: body.colour || 'yellow',
    resolved: false,
    created: now,
    updated: now,
    replies: [],
  }
  await c.env.DB.prepare(
    `INSERT INTO notes (id, edition, anchor, x, y, text, author, colour, resolved, replies, created, updated)
     VALUES (?,?,?,?,?,?,?,?,0,'[]',?,?)`,
  ).bind(note.id, note.edition, note.anchor, note.x, note.y, note.text, note.author, note.colour, note.created, note.updated).run()
  return c.json(note)
})

app.put('/api/notes/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const row = await db.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first<any>()
  if (!row) return c.notFound()
  const note = rowToNote(row)
  const body = await c.req.json().catch(() => ({}))

  for (const k of ['text', 'x', 'y', 'colour', 'resolved', 'anchor'] as const) {
    if (k in body) (note as any)[k] = body[k]
  }
  if (body.reply) {
    note.replies.push({
      author: (body.author || 'Anonymous').slice(0, 60),
      text: String(body.reply).slice(0, 2000),
      ts: new Date().toISOString(),
    })
  }
  note.updated = new Date().toISOString()

  await db.prepare(
    'UPDATE notes SET text=?, x=?, y=?, colour=?, resolved=?, anchor=?, replies=?, updated=? WHERE id=?',
  ).bind(note.text, note.x, note.y, note.colour, note.resolved ? 1 : 0, note.anchor, JSON.stringify(note.replies), note.updated, id).run()

  return c.json(note)
})

app.delete('/api/notes/:id', async (c) => {
  const id = c.req.param('id')
  const res = await c.env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run()
  if (!res.meta.changes) return c.notFound()
  return c.json({ ok: true, deleted: id })
})

// ------------------------------------------------------------------------- tts
app.get('/api/voices', (c) => c.json(VOICES))

app.get('/audio/:name', async (c) => {
  const name = c.req.param('name')
  const obj = await c.env.R2.get(`audio/${name}`)
  if (!obj) return c.notFound()
  return new Response(obj.body, { headers: { 'Content-Type': 'audio/wav' } })
})

app.post('/api/tts', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const text = (body.text || '').trim()
  const voice = body.voice || 'Charon'
  if (!text) return c.json({ ok: false, error: 'no text' }, 400)

  const result = await synthesise(c.env.R2, c.env.GEMINI_API_KEY, text, voice)
  if (result.error) return c.json({ ok: false, error: result.error }, 502)
  const fname = result.key.replace(/^audio\//, '')
  return c.json({ ok: true, url: `/audio/${fname}`, cached: true, voice })
})

app.post('/api/tts/plan', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const eid = body.edition || 'latest'
  const db = c.env.DB
  const editions = await loadEditions(db)
  if (!editions.length) return c.notFound()
  const ed = eid === 'latest' || eid === 'current' ? editions[editions.length - 1] : editions.find((e) => e.id === eid)
  if (!ed) return c.notFound()
  const corpus = await loadCorpus(db)
  const vm = viewModel(corpus, editions, ed)

  const chunks: { label: string; text: string }[] = []
  if (vm.exec_summary) chunks.push({ label: 'Executive Summary', text: vm.exec_summary })
  for (const sec of vm.sections) {
    const parts = [sec.title + '.']
    for (const item of sec.items) {
      parts.push(item.title || '')
      parts.push((item.body || '').replace(/<[^>]+>/g, ' '))
    }
    chunks.push({ label: sec.title, text: parts.join(' ') })
  }
  if (vm.beyond) chunks.push({ label: 'Beyond Seven Days', text: vm.beyond })

  return c.json({ edition: vm.id, chunks })
})

// --------------------------------------------------------------------- export
app.get('/api/export/:idfmt', async (c) => {
  const idfmt = c.req.param('idfmt')
  const m = /^(.+)\.(pdf|docx)$/.exec(idfmt)
  if (!m) return c.notFound()
  const [, editionId, fmt] = m

  const db = c.env.DB
  const editions = await loadEditions(db)
  if (!editions.length) return c.notFound()
  const ed = editionId === 'latest' || editionId === 'current' ? editions[editions.length - 1] : editions.find((e) => e.id === editionId)
  if (!ed) return c.notFound()
  const corpus = await loadCorpus(db)
  const vm = viewModel(corpus, editions, ed)

  const { results: noteRows } = await db.prepare('SELECT * FROM notes WHERE edition = ?').bind(ed.id).all()
  const notes = (noteRows || []).map(rowToNote)

  const stem = `Weekly-Brief-${vm.id}-${vm.date}`

  if (fmt === 'docx') {
    const buf = await exportDocx(vm, notes)
    return new Response(buf, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${stem}.docx"`,
      },
    })
  }
  const buf = await exportPdf(vm, notes)
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${stem}.pdf"`,
    },
  })
})

// ------------------------------------------------------------------- feedback
app.post('/api/feedback', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await c.env.DB.prepare(
    `INSERT INTO feedback (edition, item, type, section, status, text)
     VALUES (?,?,?,?,'pending',?)`,
  ).bind(
    body.edition || null, body.item || null, body.type || body.kind || 'comment',
    body.section || '', (body.text || '').slice(0, 4000),
  ).run()
  return c.json({ ok: true })
})

app.get('/api/feedback', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT 100').all()
  return c.json(results || [])
})

export default app
