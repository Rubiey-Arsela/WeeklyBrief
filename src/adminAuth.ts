// Admin dashboard authentication — a dedicated password gate for the
// /admin/access reader-activity dashboard, independent of Microsoft SSO
// (which is not yet configured — see src/auth.ts). Once MS_CLIENT_ID /
// MS_CLIENT_SECRET are set, signed-in Microsoft staff can ALSO reach the
// dashboard (checked separately in index.tsx); this module only covers
// the standalone password path so the director/admin can use the
// dashboard today without waiting on Azure AD credentials.
//
// The password lives in app_settings.admin_password (D1), so it can be
// changed from the dashboard itself without a redeploy. Session is a
// short-lived (12h) HMAC-signed cookie, same signing approach as
// src/auth.ts's session cookie.

import type { Bindings } from './types'

const ADMIN_COOKIE = 'mvb_admin'
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60 // 12 hours

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let str = ''
  for (const b of arr) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function sessionSecret(env: Bindings): string {
  return env.SESSION_SECRET || env.MS_CLIENT_SECRET || 'dev-only-insecure-secret'
}

export async function signAdminSession(env: Bindings): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload = { role: 'admin', iat: now, exp: now + ADMIN_SESSION_TTL_SECONDS }
  const payloadStr = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await hmacKey(sessionSecret(env))
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadStr))
  return `${payloadStr}.${b64url(sig)}`
}

export async function verifyAdminSession(env: Bindings, token: string): Promise<boolean> {
  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [payloadStr, sigStr] = parts
  try {
    const key = await hmacKey(sessionSecret(env))
    const sig = b64urlDecode(sigStr)
    const ok = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(payloadStr))
    if (!ok) return false
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadStr)))
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return false
    return payload.role === 'admin'
  } catch {
    return false
  }
}

export function getAdminCookie(req: Request): string | undefined {
  const header = req.headers.get('Cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === ADMIN_COOKIE) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return undefined
}

export function buildAdminSetCookie(value: string): string {
  return `${ADMIN_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`
}

export function buildAdminClearCookie(): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export async function checkAdminPassword(db: D1Database, password: string): Promise<boolean> {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind('admin_password').first<{ value: string }>()
  const expected = row?.value ?? ''
  if (!expected) return false
  return password === expected
}

export async function changeAdminPassword(db: D1Database, newPassword: string): Promise<void> {
  await db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('admin_password', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(newPassword).run()
}

export { ADMIN_COOKIE }
