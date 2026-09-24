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
import {
  getReaderCode, getReaderCookie, verifyReaderSession, touchReaderSession,
  createReaderSession, buildReaderSetCookie, buildReaderClearCookie, logActivity,
  checkPersonalAdmin, getAdminCodeVersion,
} from './readerAuth'
import {
  checkAdminPassword, changeAdminPassword, signAdminSession, verifyAdminSession,
  getAdminCookie, buildAdminSetCookie, buildAdminClearCookie,
} from './adminAuth'
// The original static/index.html frontend, imported verbatim as a raw
// string at build time and served unchanged — see src/frontend.html.
// @ts-ignore - vite raw import
import frontendHtml from './frontend.html?raw'
// @ts-ignore - vite raw import
import loginHtml from './login.html?raw'
// @ts-ignore - vite raw import
import adminHtml from './admin.html?raw'

const app = new Hono<AppEnv>()

app.use('/api/*', cors())
app.use('/static/*', serveStatic({ root: './public' }))
app.use('/favicon.ico', serveStatic({ path: './public/favicon.ico' }))

// ------------------------------------------------------------------- auth
// Two independent ways in, both landing on the same report:
//   1. Microsoft SSO (src/auth.ts) — for Al Bukhary/Arsela staff. Only
//      enforced once MS_CLIENT_ID + MS_CLIENT_SECRET secrets are set.
//   2. Reader access (src/readerAuth.ts) — a name + shared code unlock
//      for the WhatsApp-distributed link, aimed at readers who won't
//      tolerate a repeated username/password. Always active (does not
//      depend on any secret being set), so it's the fallback whenever
//      MS SSO isn't configured or the visitor isn't MS-signed-in.
// /auth/*, /login, /admin/*, reader/admin API endpoints, and static
// assets are always reachable so those flows can complete.
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  const openPaths =
    path.startsWith('/auth/') || path === '/login' || path.startsWith('/static/') ||
    path === '/favicon.ico' || path.startsWith('/admin') || path.startsWith('/api/admin') ||
    path === '/api/reader-access' || path === '/api/admin-login' || path === '/api/track' ||
    path === '/api/me' || path === '/api/reader-me'
  if (openPaths) return next()

  // Path 1: Microsoft SSO session (only checked if MS SSO is configured).
  if (isAuthConfigured(c.env)) {
    const msToken = getCookie(c.req.raw, SESSION_COOKIE)
    const msUser = msToken ? await verifySession(c.env, msToken) : null
    if (msUser) {
      c.set('user' as never, msUser as never)
      return next()
    }
  }

  // Path 2: reader access session (name + shared code, long-lived cookie).
  const readerToken = getReaderCookie(c.req.raw)
  const readerSession = readerToken ? await verifyReaderSession(c.env.DB, readerToken) : null
  if (readerSession) {
    c.set('reader' as never, readerSession as never)
    await touchReaderSession(c.env.DB, readerSession.id)
    return next()
  }

  if (path.startsWith('/api/')) return c.json({ ok: false, error: 'authentication required' }, 401)
  const wasRevoked = !!readerToken // had a cookie but it no longer verifies -> code rotated or session revoked
  return c.redirect(wasRevoked ? '/login?error=reader_revoked' : '/login')
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
  // Reports who's viewing right now, across BOTH access paths, so the
  // frontend can (a) greet the visitor by name either way and (b) hide
  // editorial controls (Add/Manage Reports) from reader-access visitors
  // — those stay staff-only, since readers should only ever view, not
  // edit, the sensitive report content.
  if (isAuthConfigured(c.env)) {
    const token = getCookie(c.req.raw, SESSION_COOKIE)
    const user = token ? await verifySession(c.env, token) : null
    if (user) return c.json({ ok: true, configured: true, user: { email: user.email, name: user.name }, role: 'staff' })
  }
  const readerToken = getReaderCookie(c.req.raw)
  const readerSession = readerToken ? await verifyReaderSession(c.env.DB, readerToken) : null
  if (readerSession) {
    const role = readerSession.role === 'admin' ? 'admin' : 'reader'
    return c.json({ ok: true, configured: isAuthConfigured(c.env), user: { name: readerSession.name }, role })
  }
  return c.json({ ok: true, configured: isAuthConfigured(c.env), user: null, role: 'staff' })
})

// Staff-or-admin check: Microsoft SSO session, the admin dashboard
// password session, OR a reader-access session personally elevated to
// role='admin' (Rubiey's name + her private code — see readerAuth.ts).
// Ordinary reader-access sessions never satisfy this — used to gate
// editorial actions (uploading/editing/deleting edition content) so the
// WhatsApp-distributed reader access stays view-only for everyone else.
async function isStaffRequest(c: any): Promise<boolean> {
  if (isAuthConfigured(c.env)) {
    const msToken = getCookie(c.req.raw, SESSION_COOKIE)
    const msUser = msToken ? await verifySession(c.env, msToken) : null
    if (msUser) return true
  }
  const adminToken = getAdminCookie(c.req.raw)
  if (adminToken && await verifyAdminSession(c.env, adminToken)) return true
  const readerToken = getReaderCookie(c.req.raw)
  const readerSession = readerToken ? await verifyReaderSession(c.env.DB, readerToken) : null
  if (readerSession && readerSession.role === 'admin') return true
  return false
}

// -------------------------------------------------------------- reader access
// Name + shared-code unlock for the WhatsApp-distributed report link.
// See src/readerAuth.ts for the full rationale.
app.post('/api/reader-access', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const name = (body.name || '').trim()
  const code = (body.code || '').trim()
  if (!name) return c.json({ ok: false, error: 'Please enter your name.' }, 400)
  if (!code) return c.json({ ok: false, error: 'Please enter the access code.' }, 400)

  // Personal admin elevation: the exact name + a private code (distinct
  // from the shared WhatsApp-group code) grants an admin-role session
  // through the same low-friction box everyone else uses. Checked first
  // so it takes priority; the shared reader_code alone — even paired with
  // the admin's name — never elevates, since that check requires the
  // separate personal code to also match.
  if (await checkPersonalAdmin(c.env.DB, name, code)) {
    const ua = c.req.header('User-Agent') || ''
    const { id, days } = await createReaderSession(c.env.DB, name, ua, 'admin')
    c.header('Set-Cookie', buildReaderSetCookie(id, days))
    return c.json({ ok: true, role: 'admin' })
  }

  const { code: expected } = await getReaderCode(c.env.DB)
  if (code !== expected) {
    return c.json({ ok: false, error: 'That access code is not correct. Please check with your director.' }, 401)
  }

  const ua = c.req.header('User-Agent') || ''
  const { id, days } = await createReaderSession(c.env.DB, name, ua)
  c.header('Set-Cookie', buildReaderSetCookie(id, days))
  return c.json({ ok: true, role: 'reader' })
})

app.get('/api/reader-me', async (c) => {
  const token = getReaderCookie(c.req.raw)
  const session = token ? await verifyReaderSession(c.env.DB, token) : null
  return c.json({ ok: true, reader: session ? { name: session.name, id: session.id, role: session.role } : null })
})

app.get('/auth/reader-logout', (c) => {
  c.header('Set-Cookie', buildReaderClearCookie())
  return c.redirect('/login')
})

// Fire-and-forget activity beacon from the frontend (tab switches, sector
// filters, exports, read-aloud, ask). Never blocks the reading UI.
app.post('/api/track', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const readerToken = getReaderCookie(c.req.raw)
  const readerSession = readerToken ? await verifyReaderSession(c.env.DB, readerToken) : null

  let sessionId = ''
  let name = ''
  if (readerSession) {
    sessionId = readerSession.id
    name = readerSession.name
  } else if (isAuthConfigured(c.env)) {
    const msToken = getCookie(c.req.raw, SESSION_COOKIE)
    const msUser = msToken ? await verifySession(c.env, msToken) : null
    if (msUser) { sessionId = `ms:${msUser.sub}`; name = `${msUser.name} (staff)` }
  }
  if (!sessionId) return c.json({ ok: false }, 401)

  const edition = (body.edition || '').toString().slice(0, 40)
  const action = (body.action || '').toString().slice(0, 40)
  const detail = (body.detail || '').toString()
  if (!action) return c.json({ ok: false }, 400)

  await logActivity(c.env.DB, sessionId, name, edition, action, detail)
  return c.json({ ok: true })
})

// ------------------------------------------------------------------- admin
// Standalone password gate for /admin/access (works even before
// Microsoft SSO is configured). MS-signed-in staff can also reach it —
// checked inline below rather than via the global auth middleware,
// since /admin* is deliberately left out of that middleware's gate.
async function isAdminRequest(c: any): Promise<boolean> {
  const adminToken = getAdminCookie(c.req.raw)
  if (adminToken && await verifyAdminSession(c.env, adminToken)) return true
  if (isAuthConfigured(c.env)) {
    const msToken = getCookie(c.req.raw, SESSION_COOKIE)
    const msUser = msToken ? await verifySession(c.env, msToken) : null
    if (msUser) return true
  }
  const readerToken = getReaderCookie(c.req.raw)
  const readerSession = readerToken ? await verifyReaderSession(c.env.DB, readerToken) : null
  if (readerSession && readerSession.role === 'admin') return true
  return false
}

app.get('/admin', (c) => c.redirect('/admin/access'))

app.get('/admin/access', async (c) => {
  const authed = await isAdminRequest(c)
  return c.html((adminHtml as string).replace('__AUTHED__', authed ? 'true' : 'false'))
})

app.post('/api/admin-login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const password = (body.password || '').toString()
  const ok = await checkAdminPassword(c.env.DB, password)
  if (!ok) return c.json({ ok: false, error: 'Incorrect password.' }, 401)
  const session = await signAdminSession(c.env)
  c.header('Set-Cookie', buildAdminSetCookie(session))
  return c.json({ ok: true })
})

app.get('/admin/logout', (c) => {
  c.header('Set-Cookie', buildAdminClearCookie())
  return c.redirect('/admin/access')
})

app.post('/api/admin/change-password', async (c) => {
  if (!(await isAdminRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const newPassword = (body.password || '').toString()
  if (newPassword.length < 6) return c.json({ ok: false, error: 'Password must be at least 6 characters.' }, 400)
  await changeAdminPassword(c.env.DB, newPassword)
  return c.json({ ok: true })
})

app.get('/api/admin/readers', async (c) => {
  if (!(await isAdminRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
  const rows = await c.env.DB.prepare(
    `SELECT id, name, first_seen, last_seen, visit_count, revoked, code_version, role
     FROM reader_sessions ORDER BY last_seen DESC`,
  ).all()
  const { version: currentVersion } = await getReaderCode(c.env.DB)
  const adminVersion = await getAdminCodeVersion(c.env.DB)
  const readers = (rows.results || []).map((r: any) => ({
    ...r,
    active: !r.revoked && r.code_version === (r.role === 'admin' ? adminVersion : currentVersion),
  }))
  return c.json({ ok: true, readers, current_code_version: currentVersion })
})

app.get('/api/admin/reader/:id/activity', async (c) => {
  if (!(await isAdminRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
  const id = c.req.param('id')
  const rows = await c.env.DB.prepare(
    `SELECT edition, action, detail, ts FROM activity_log WHERE session_id = ? ORDER BY ts DESC LIMIT 200`,
  ).bind(id).all()
  return c.json({ ok: true, activity: rows.results || [] })
})

app.post('/api/admin/reader/:id/revoke', async (c) => {
  if (!(await isAdminRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE reader_sessions SET revoked = 1 WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

app.post('/api/admin/reader/:id/unrevoke', async (c) => {
  if (!(await isAdminRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE reader_sessions SET revoked = 0 WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

app.get('/api/admin/code', async (c) => {
  if (!(await isAdminRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
  const { code, version } = await getReaderCode(c.env.DB)
  return c.json({ ok: true, code, version })
})

app.post('/api/admin/code', async (c) => {
  if (!(await isAdminRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const newCode = (body.code || '').toString().trim()
  if (!newCode || newCode.length < 4) return c.json({ ok: false, error: 'Code must be at least 4 characters.' }, 400)
  const { version } = await getReaderCode(c.env.DB)
  const newVersion = version + 1
  await c.env.DB.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('reader_code', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(newCode).run()
  await c.env.DB.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('reader_code_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(String(newVersion)).run()
  return c.json({ ok: true, code: newCode, version: newVersion })
})

// Rubiey's personal elevation code — separate from the shared reader
// code above. Rotating it invalidates her existing admin-role sessions
// (code_version bump) without touching the WhatsApp group's shared code
// or their sessions.
app.post('/api/admin/personal-code', async (c) => {
  if (!(await isAdminRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const newCode = (body.code || '').toString().trim()
  if (!newCode || newCode.length < 4) return c.json({ ok: false, error: 'Code must be at least 4 characters.' }, 400)
  const version = await getAdminCodeVersion(c.env.DB)
  const newVersion = version + 1
  await c.env.DB.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('admin_personal_code', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(newCode).run()
  await c.env.DB.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('admin_personal_code_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(String(newVersion)).run()
  return c.json({ ok: true, code: newCode, version: newVersion })
})

app.get('/api/admin/activity-summary', async (c) => {
  if (!(await isAdminRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
  const rows = await c.env.DB.prepare(
    `SELECT edition, action, detail, COUNT(*) as cnt
     FROM activity_log
     WHERE ts >= datetime('now', '-30 days')
     GROUP BY edition, action, detail
     ORDER BY edition DESC, cnt DESC`,
  ).all()
  return c.json({ ok: true, summary: rows.results || [] })
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
  if (!(await isStaffRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
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
  if (!(await isStaffRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
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
  if (!(await isStaffRequest(c))) return c.json({ ok: false, error: 'unauthorised' }, 401)
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
  const voice = body.voice || 'Kore'
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
