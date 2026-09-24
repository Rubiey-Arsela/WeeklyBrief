// Reader access gate — lightweight name + shared-code unlock for the
// WhatsApp-distributed report link. This is intentionally NOT a
// per-person password system: older readers open the same group link
// on their personal phone and will not tolerate re-typing credentials
// on every visit. Instead:
//
//   1. First visit on a device: reader types their NAME + the shared
//      CODE (set by app_settings.reader_code, default seeded to 6170).
//   2. On success, a long-lived signed cookie is set (default 60 days,
//      app_settings.reader_session_days) and a `reader_sessions` row is
//      created, tying that device to the name they typed.
//   3. Every subsequent visit on that device skips the gate entirely —
//      no repeat prompts — until the cookie expires, an admin revokes
//      that specific session, or the admin rotates the shared code
//      (which invalidates every existing session at once).
//
// This is a distinct, parallel gate to Microsoft SSO (src/auth.ts) —
// MS-signed-in staff never see this screen. It exists purely to attach
// a name to WhatsApp-group readers for accountability/audit, per the
// director's requirement, without breaking the low-friction UX older
// readers need.

import type { Bindings } from './types'

const READER_COOKIE = 'mvb_reader'
const DEFAULT_SESSION_DAYS = 60

export interface ReaderSession {
  id: string
  name: string
  code_version: number
  revoked: number
}

async function getSetting(db: D1Database, key: string, fallback: string): Promise<string> {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? fallback
}

export async function getReaderCode(db: D1Database): Promise<{ code: string; version: number }> {
  const code = await getSetting(db, 'reader_code', '6170')
  const version = parseInt(await getSetting(db, 'reader_code_version', '1'), 10) || 1
  return { code, version }
}

export async function getSessionDays(db: D1Database): Promise<number> {
  const raw = await getSetting(db, 'reader_session_days', String(DEFAULT_SESSION_DAYS))
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_DAYS
}

export function getReaderCookie(req: Request): string | undefined {
  const header = req.headers.get('Cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === READER_COOKIE) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return undefined
}

export function buildReaderSetCookie(sessionId: string, days: number): string {
  const maxAge = days * 24 * 60 * 60
  return `${READER_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

export function buildReaderClearCookie(): string {
  return `${READER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export async function verifyReaderSession(db: D1Database, sessionId: string | undefined): Promise<ReaderSession | null> {
  if (!sessionId) return null
  const row = await db.prepare(
    'SELECT id, name, code_version, revoked FROM reader_sessions WHERE id = ?',
  ).bind(sessionId).first<ReaderSession>()
  if (!row || row.revoked) return null
  const { version: currentVersion } = await getReaderCode(db)
  if (row.code_version !== currentVersion) return null // code was rotated since this device unlocked
  return row
}

export async function touchReaderSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare(
    `UPDATE reader_sessions SET last_seen = datetime('now'), visit_count = visit_count + 1 WHERE id = ?`,
  ).bind(sessionId).run()
}

export async function createReaderSession(db: D1Database, name: string, userAgent: string): Promise<{ id: string; days: number }> {
  const id = crypto.randomUUID()
  const { version } = await getReaderCode(db)
  const days = await getSessionDays(db)
  await db.prepare(
    `INSERT INTO reader_sessions (id, name, code_version, user_agent) VALUES (?,?,?,?)`,
  ).bind(id, name.trim().slice(0, 120), version, userAgent.slice(0, 300)).run()
  return { id, days }
}

export async function logActivity(
  db: D1Database,
  sessionId: string,
  name: string,
  edition: string,
  action: string,
  detail: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO activity_log (session_id, name, edition, action, detail) VALUES (?,?,?,?,?)`,
  ).bind(sessionId, name, edition, action, detail.slice(0, 300)).run()
}

export { READER_COOKIE }
