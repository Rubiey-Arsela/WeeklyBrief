// Microsoft Entra ID (Azure AD) "Sign in with Microsoft" — OAuth 2.0
// authorization-code flow for a confidential web client, plus a small
// signed-cookie session on top (no external session store; Workers-only
// primitives, no Node crypto).
//
// Enabling this in production requires three secrets to be set via
// `wrangler pages secret put`:
//   MS_CLIENT_ID       - Application (client) ID from the Azure App Registration
//   MS_CLIENT_SECRET   - a client secret created for that app
//   MS_TENANT_ID       - the Azure AD tenant ID (or 'common' / 'organizations')
// Optional:
//   MS_REDIRECT_URI    - defaults to `${origin}/auth/callback`; set this
//                        explicitly if the app is served behind a custom
//                        domain that differs from the deploy URL.
//   MS_ALLOWED_DOMAIN  - comma-separated list of email domains allowed to
//                        sign in (e.g. "albukharygroup.com,arsela.com.my").
//                        Leave unset to allow any Microsoft account.
//   SESSION_SECRET     - HMAC key for signing the session cookie. Falls
//                        back to MS_CLIENT_SECRET if unset (fine, but a
//                        dedicated secret is cleaner to rotate independently).
//
// Until MS_CLIENT_ID + MS_CLIENT_SECRET are both set, isAuthConfigured()
// returns false and the whole login requirement is skipped app-wide —
// this lets the app run unauthenticated in the sandbox / before IT has
// created the Azure App Registration.

import type { Bindings } from './types'

const SESSION_COOKIE = 'mvb_session'
const STATE_COOKIE = 'mvb_oauth_state'
const SESSION_TTL_SECONDS = 12 * 60 * 60 // 12 hours

export interface SessionUser {
  sub: string   // Microsoft object id (oid)
  email: string
  name: string
  iat: number
  exp: number
}

export function isAuthConfigured(env: Bindings): boolean {
  return !!(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET)
}

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

function utf8ToB64url(s: string): string {
  return b64url(new TextEncoder().encode(s))
}

function b64urlToUtf8(s: string): string {
  return new TextDecoder().decode(b64urlDecode(s))
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

export async function signSession(env: Bindings, user: Omit<SessionUser, 'iat' | 'exp'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: SessionUser = { ...user, iat: now, exp: now + SESSION_TTL_SECONDS }
  const payloadStr = utf8ToB64url(JSON.stringify(payload))
  const key = await hmacKey(sessionSecret(env))
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadStr))
  return `${payloadStr}.${b64url(sig)}`
}

export async function verifySession(env: Bindings, token: string): Promise<SessionUser | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadStr, sigStr] = parts
  try {
    const key = await hmacKey(sessionSecret(env))
    const sig = b64urlDecode(sigStr)
    const ok = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(payloadStr))
    if (!ok) return null
    const payload = JSON.parse(b64urlToUtf8(payloadStr)) as SessionUser
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

export function getCookie(req: Request, name: string): string | undefined {
  return parseCookies(req.headers.get('Cookie'))[name]
}

function cookieAttrs(maxAgeSeconds: number): string {
  return `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

export function buildSetCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; ${cookieAttrs(maxAgeSeconds)}`
}

export function buildClearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export function tenantSegment(env: Bindings): string {
  return env.MS_TENANT_ID || 'common'
}

export function redirectUri(env: Bindings, origin: string): string {
  return env.MS_REDIRECT_URI || `${origin}/auth/callback`
}

export function buildAuthorizeUrl(env: Bindings, origin: string, state: string): string {
  const tenant = tenantSegment(env)
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`
  const params = new URLSearchParams({
    client_id: env.MS_CLIENT_ID!,
    response_type: 'code',
    redirect_uri: redirectUri(env, origin),
    response_mode: 'query',
    scope: 'openid profile email User.Read',
    state,
  })
  return `${base}?${params.toString()}`
}

export async function exchangeCodeForToken(env: Bindings, origin: string, code: string): Promise<any> {
  const tenant = tenantSegment(env)
  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID!,
    client_secret: env.MS_CLIENT_SECRET!,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(env, origin),
    scope: 'openid profile email User.Read',
  })
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const json = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    throw new Error((json as any).error_description || (json as any).error || `token exchange failed (${resp.status})`)
  }
  return json
}

export async function fetchMicrosoftProfile(accessToken: string): Promise<{ id: string; email: string; name: string }> {
  const resp = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!resp.ok) throw new Error(`Microsoft Graph /me failed (${resp.status})`)
  const j = await resp.json() as any
  const email = j.mail || j.userPrincipalName || ''
  return { id: j.id, email, name: j.displayName || email }
}

export function domainAllowed(env: Bindings, email: string): boolean {
  const allow = (env.MS_ALLOWED_DOMAIN || '').trim()
  if (!allow) return true
  const domains = allow.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
  if (!domains.length) return true
  const emailDomain = email.split('@')[1]?.toLowerCase() || ''
  return domains.includes(emailDomain)
}

export { SESSION_COOKIE, STATE_COOKIE }
