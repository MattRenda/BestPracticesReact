import type {
  AdminQueue,
  DevCard,
  DevProfile,
  MatchDetail,
  MatchSummary,
  Me,
  MyStartup,
  RoleCard,
  RoleListing,
  Startup,
  StartupStatus,
  SwipeResult,
} from './types'

export class ApiError extends Error {
  status: number
  data: Record<string, unknown>
  constructor(message: string, status: number, data: Record<string, unknown>) {
    super(message)
    this.status = status
    this.data = data
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      // Every write is JSON; the server refuses anything else (blocks cross-site form posts).
      headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    })
  } catch {
    throw new ApiError('Can’t reach HireMe. Check your connection.', 0, {})
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data)
  return data as T
}

export const api = {
  me: () => call<Me>('GET', '/me'),
  startSignIn: (email: string, intent: 'dev' | 'founder') => call<{ sent: boolean; devLink?: string }>('POST', '/auth/start', { email, intent }),
  verify: (token: string) => call<{ ok: boolean }>('POST', '/auth/verify', { token }),
  logout: () => call<void>('POST', '/auth/logout'),
  setRole: (role: 'dev' | 'founder') => call<{ role: string }>('POST', '/me/role', { role }),
  deleteAccount: () => call<void>('DELETE', '/me'),

  profile: () => call<DevProfile>('GET', '/profile'),
  saveProfile: (p: DevProfile) => call<DevProfile>('PUT', '/profile', p),

  startup: () => call<MyStartup | null>('GET', '/startup'),
  createStartup: (s: Partial<Startup> & { confirmNotAgency: boolean; title?: string }) => call<Startup>('POST', '/startup', s),
  joinStartup: (id: number, title: string) => call<Startup>('POST', '/startup/join', { id, title }),
  saveStartup: (s: Partial<Startup>) => call<Startup>('PUT', '/startup', s),
  createRole: (r: Partial<RoleListing>) => call<RoleListing>('POST', '/roles', r),
  saveRole: (id: number, r: Partial<RoleListing>) => call<RoleListing>('PUT', `/roles/${id}`, r),

  roleDeck: () => call<RoleCard[]>('GET', '/deck'),
  swipeRole: (roleId: number, liked: boolean, note = '') => call<SwipeResult>('POST', `/deck/${roleId}`, { liked, note }),
  undoRole: (roleId: number) => call<void>('DELETE', `/deck/${roleId}`),
  devDeck: (roleId: number) => call<DevCard[]>('GET', `/deck/devs?role=${roleId}`),
  swipeDev: (roleId: number, devId: number, liked: boolean) => call<SwipeResult>('POST', `/deck/devs/${devId}`, { role: roleId, liked }),
  undoDev: (roleId: number, devId: number) => call<void>('DELETE', `/deck/devs/${devId}?role=${roleId}`),

  matches: () => call<MatchSummary[]>('GET', '/matches'),
  match: (id: number, after = 0) => call<MatchDetail>('GET', `/matches/${id}${after ? `?after=${after}` : ''}`),
  send: (id: number, body: string) => call<{ id: number }>('POST', `/matches/${id}/messages`, { body }),
  markRead: (id: number, lastId: number) => call<void>('POST', `/matches/${id}/read`, { lastId }),
  closeMatch: (id: number) => call<void>('POST', `/matches/${id}/close`),

  report: (type: 'startup' | 'dev', id: number, reason: string, detail = '') => call<{ ok: boolean }>('POST', '/reports', { type, id, reason, detail }),

  adminQueue: () => call<AdminQueue>('GET', '/admin/queue'),
  review: (id: number, status: StartupStatus, note = '') => call<Startup>('POST', `/admin/startups/${id}`, { status, note }),
  resolveReport: (id: number) => call<void>('POST', `/admin/reports/${id}/resolve`),
}

export const money = (n: number | null | undefined) => (n ? `$${n >= 1000 ? `${Math.round(n / 1000)}k` : n}` : '')
export const salaryRange = (min: number | null, max: number | null) =>
  min && max ? `${money(min)}–${money(max)}` : min ? `${money(min)}+` : max ? `up to ${money(max)}` : ''
export const WORK_LABEL = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', any: 'Open to anything' } as const
