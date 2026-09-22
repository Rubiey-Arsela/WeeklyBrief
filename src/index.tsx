import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { AppEnv, Corpus, Edition, Note, Highlight, PdfMeta } from './types'
import { viewModel, weekOf, tokens, isoWeek } from './viewmodel'
import { ask } from './ask'
import { VOICES, synthesise } from './tts'
import { exportDocx, exportPdf } from './export'
import { extractEdition } from './pdfExtract'
import {
  isAuthConfigured, getCookie, buildSetCookie, buildClearCookie, verifySession,
  signSession, buildAuthorizeUrl, exchangeCodeForToken, fetchMicrosoftProfile,
  domainAllowed, SESSION_COOKIE, STATE_COOKIE,
} from './auth'
// The original static/index.html frontend, imported verbatim as a raw
// string at build time and served unchanged — see src/frontend.html.
// @ts-ignore - vite raw import
import frontendHtml from './frontend.html?raw'
// @ts-ignore - vite raw import
import loginHtml from './login.html?raw'

const app = new Hono<AppEnv>()

app.use('/api/*', cors())
app.use('/static/*', serveStatic({ root: './public' }))
app.use('/favicon.ico', serveStatic({ path: './public/favicon.ico' }))

// ------------------------------------------------------------------- auth
// Login is only enforced once MS_CLIENT_ID + MS_CLIENT_SECRET secrets are
// set (see src/auth.ts) — until then every route below is open, so the
// app keeps working in the sandbox / before the Azure App Registration
// exists. /auth/*, /login, and static assets are always reachable so the
// login page itself can render and the OAuth callback can complete.
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  const openPaths = path.startsWith('/auth/') || path === '/login' || path.startsWith('/static/') || path === '/favicon.ico'
  if (openPaths || !isAuthConfigured(c.env)) return next()

  const token = getCookie(c.req.raw, SESSION_COOKIE)
  const user = token ? await verifySession(c.env, token) : null
  if (!user) {
    if (path.startsWith('/api/')) return c.json({ ok: false, error: 'authentication required' }, 401)
    return c.redirect('/login')
  }
  c.set('user' as never, user as never)
  return next()
})

app.get('/login', (c) => {
  if (!isAuthConfigured(c.env)) {
    return c.html((loginHtml as string).replace('</body>', '<script>if(!location.search.includes("error="))location.search="error=not_configured";</script></body>'))
  }
  return c.html(loginHtml as string)
})

app.get('/auth/login', async (c) => {
  if (!isAuthConfigured(c.env)) return c.redirect('/login?error=not_configured')
  const state = crypto.randomUUID()
  const origin = new URL(c.req.url).origin
  const url = buildAuthorizeUrl(c.env, origin, state)
  c.header('Set-Cookie', buildSetCookie(STATE_COOKIE, state, 600))
  return c.redirect(url)
})

app.get('/auth/callback', async (c) => {
  const url = new URL(c.req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const err = url.searchParams.get('error')
  if (err) return c.redirect('/login?error=access_denied')

  const expectedState = getCookie(c.req.raw, STATE_COOKIE)
  if (!code || !state || !expectedState || state !== expectedState) {
    return c.redirect('/login?error=auth_failed')
  }

  try {
    const tokenResp = await exchangeCodeForToken(c.env, url.origin, code)
    const profile = await fetchMicrosoftProfile(tokenResp.access_token)
    if (!profile.email) throw new Error('Microsoft account has no email/UPN')
    if (!domainAllowed(c.env, profile.email)) return c.redirect('/login?error=domain_not_allowed')

    const now = new Date().toISOString()
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, name, first_login, last_login, login_count)
       VALUES (?,?,?,?,?,1)
       ON CONFLICT(id) DO UPDATE SET
         email=excluded.email, name=excluded.name, last_login=excluded.last_login,
         login_count = users.login_count + 1`,
    ).bind(profile.id, profile.email, profile.name, now, now).run()

    const session = await signSession(c.env, { sub: profile.id, email: profile.email, name: profile.name })
    c.header('Set-Cookie', buildSetCookie(SESSION_COOKIE, session, 12 * 60 * 60))
    c.header('Set-Cookie', buildClearCookie(STATE_COOKIE), { append: true })
    return c.redirect('/')
  } catch (e) {
    console.error('OAuth callback failed:', (e as Error).message)
    return c.redirect('/login?error=auth_failed')
  }
})

app.get('/auth/logout', (c) => {
  c.header('Set-Cookie', buildClearCookie(SESSION_COOKIE))
  return c.redirect('/login')
})

app.get('/api/me', async (c) => {
  if (!isAuthConfigured(c.env)) return c.json({ ok: true, configured: false, user: null })
  const token = getCookie(c.req.raw, SESSION_COOKIE)
  const user = token ? await verifySession(c.env, token) : null
  return c.json({ ok: true, configured: true, user: user ? { email: user.email, name: user.name } : null })
})

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

function rowToHighlight(row: any): Highlight {
  return {
    id: row.id,
    edition: row.edition,
    item_key: row.item_key,
    start_offset: row.start_offset,
    end_offset: row.end_offset,
    colour: row.colour || 'yellow',
    text_snippet: row.text_snippet || '',
    author: row.author || 'Anonymous',
    created: row.created,
    updated: row.updated,
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

app.post('/api/edition/upload-pdf', async (c) => {
  const form = await c.req.formData()
  const file = form.get('pdf') as File | null
  const db = c.env.DB

  if (!file || !file.name) return c.json({ ok: false, error: 'no pdf file in request' }, 400)
  if (!file.name.toLowerCase().endsWith('.pdf')) return c.json({ ok: false, error: 'file must be a .pdf' }, 400)
  if (file.size > MAX_PDF) return c.json({ ok: false, error: 'pdf exceeds 20 MB' }, 413)

  const buf = await file.arrayBuffer()

  // Week and date are read from the PDF's own printed header ("Week
  // Update: X - Y" / "Date: Z"), not the upload timestamp — this is what
  // lets the admin backfill past editions and upload future ones out of
  // order, instead of always landing on "this week".
  const apiKey = c.env.OPENAI_API_KEY
  if (!apiKey) {
    return c.json({
      ok: false,
      error: 'Content extraction is not configured — set the OPENAI_API_KEY secret to enable PDF upload.',
    }, 500)
  }
  const baseUrl = c.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'

  let extracted
  try {
    extracted = await extractEdition(buf, apiKey, baseUrl)
  } catch (e) {
    return c.json({ ok: false, error: `Could not extract report content: ${(e as Error).message}` }, 422)
  }

  const weekNum = isoWeek(new Date(extracted.date + 'T00:00:00Z'))
  const eid = `W${weekNum}`
  const safe = file.name.replace(/[^A-Za-z0-9._-]/g, '_')
  const stored = `pdf/${eid}-${extracted.date}-${safe}`
  await c.env.R2.put(stored, buf, { httpMetadata: { contentType: 'application/pdf' } })
  const pdf: PdfMeta = { name: safe, url: `/pdf/${eid}-${extracted.date}-${safe}`, size: file.size, r2_key: stored }

  await db.prepare(upsertEditionSql()).bind(
    eid,
    extracted.label,
    extracted.date,
    'pdf',
    extracted.exec_summary,
    JSON.stringify(extracted.speed_read),
    extracted.structural,
    JSON.stringify(extracted.pulse),
    JSON.stringify(extracted.items),
    JSON.stringify(extracted.watchlist),
    extracted.beyond,
    JSON.stringify(pdf),
  ).run()

  const freshEditions = await loadEditions(db)
  const ed = freshEditions.find((e) => e.id === eid)!
  return c.json(viewModel(await loadCorpus(db), freshEditions, ed))
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

// ------------------------------------------------------------------ highlights
app.get('/api/highlights', async (c) => {
  const edition = c.req.query('edition')
  const db = c.env.DB
  let query = 'SELECT * FROM highlights'
  const binds: any[] = []
  if (edition) { query += ' WHERE edition = ?'; binds.push(edition) }
  query += ' ORDER BY created ASC'
  const { results } = await db.prepare(query).bind(...binds).all()
  return c.json((results || []).map(rowToHighlight))
})

app.post('/api/highlights', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (!body.edition || !body.item_key) {
    return c.json({ ok: false, error: 'edition and item_key are required' }, 400)
  }
  const startOff = parseInt(body.start_offset, 10)
  const endOff = parseInt(body.end_offset, 10)
  if (!Number.isFinite(startOff) || !Number.isFinite(endOff) || endOff <= startOff) {
    return c.json({ ok: false, error: 'invalid start_offset/end_offset' }, 400)
  }
  const now = new Date().toISOString()
  const h: Highlight = {
    id: randId('h'),
    edition: body.edition,
    item_key: body.item_key,
    start_offset: startOff,
    end_offset: endOff,
    colour: (body.colour || 'yellow').slice(0, 20),
    text_snippet: (body.text_snippet || '').slice(0, 500),
    author: (body.author || 'Anonymous').slice(0, 60),
    created: now,
    updated: now,
  }
  await c.env.DB.prepare(
    `INSERT INTO highlights (id, edition, item_key, start_offset, end_offset, colour, text_snippet, author, created, updated)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(h.id, h.edition, h.item_key, h.start_offset, h.end_offset, h.colour, h.text_snippet, h.author, h.created, h.updated).run()
  return c.json(h)
})

app.put('/api/highlights/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const row = await db.prepare('SELECT * FROM highlights WHERE id = ?').bind(id).first<any>()
  if (!row) return c.notFound()
  const h = rowToHighlight(row)
  const body = await c.req.json().catch(() => ({}))
  if ('colour' in body) h.colour = String(body.colour).slice(0, 20)
  h.updated = new Date().toISOString()
  await db.prepare('UPDATE highlights SET colour=?, updated=? WHERE id=?')
    .bind(h.colour, h.updated, id).run()
  return c.json(h)
})

app.delete('/api/highlights/:id', async (c) => {
  const id = c.req.param('id')
  const res = await c.env.DB.prepare('DELETE FROM highlights WHERE id = ?').bind(id).run()
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
