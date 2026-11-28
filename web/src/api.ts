import type { FoundAccount, FoundLinkedin, AdminQueue, ApplyMethod, Application, DevProfile, Hiring, HiringCompany, HiringRole, ImportRun, Me, RoleCard, SavedRole, Startup, SwipeResult } from './types'

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
  config: () => call<{ googleClientId: string | null }>('GET', '/config'),
  googleSignIn: (credential: string) => call<{ ok: boolean; sent: string[] }>('POST', '/auth/google', { credential }),
  startGuest: () => call<{ ok: boolean }>('POST', '/auth/guest'),
  startSignIn: (email: string, intent?: 'hiring') => call<{ sent: boolean; devLink?: string }>('POST', '/auth/start', { email, intent }),
  verify: (token: string) => call<{ ok: boolean; sent: string[]; intent: string }>('POST', '/auth/verify', { token }),
  logout: () => call<void>('POST', '/auth/logout'),
  deleteAccount: () => call<void>('DELETE', '/me'),

  profile: () => call<DevProfile>('GET', '/profile'),
  saveProfile: (p: DevProfile) => call<DevProfile>('PUT', '/profile', p),
  uploadResume: (name: string, data: string, parse = false) =>
    call<{ resume_name: string; parsed?: Partial<DevProfile>; unreadable?: boolean }>('POST', '/profile/resume', { name, data, parse }),
  deleteResume: () => call<void>('DELETE', '/profile/resume'),
  applications: () => call<Application[]>('GET', '/applications'),
  apply: (roleId: number) => call<Application>('POST', '/applications', { roleId }),
  answerApplication: (id: number, answers: { question: string; answer: string }[]) => call<Application>('POST', `/applications/${id}/answers`, { answers }),
  retryApplication: (id: number) => call<Application>('POST', `/applications/${id}/retry`),
  answerAll: (answers: { question: string; answer: string }[]) => call<{ requeued: number }>('POST', '/applications/answers', { answers }),
  sendApplication: (id: number, answers: { question: string; answer: string }[] = []) => call<Application>('POST', `/applications/${id}/send`, { answers }),
  selfApplied: (id: number) => call<void>('POST', `/applications/${id}/self`),
  cancelApplication: (id: number) => call<void>('DELETE', `/applications/${id}`),

  roleDeck: () => call<RoleCard[]>('GET', '/deck'),
  swipeRole: (roleId: number, liked: boolean) => call<SwipeResult>('POST', `/deck/${roleId}`, { liked }),
  undoRole: (roleId: number) => call<void>('DELETE', `/deck/${roleId}`),
  saved: () => call<SavedRole[]>('GET', '/saved'),

  report: (id: number, reason: string, detail = '') => call<{ ok: boolean }>('POST', '/reports', { type: 'startup', id, reason, detail }),

  findLinks: (who: { name?: string; email?: string; location?: string; website?: string }) =>
    call<{ candidates: FoundAccount[]; linkedin: { url: string; from: string } | null; linkedinMatches: FoundLinkedin[] | null; linkedinSearch?: { enabled: boolean; name: string } }>('POST', '/profile/find-links', who),

  hiring: () => call<Hiring>('GET', '/hiring'),
  createCompany: (c: Partial<HiringCompany>) => call<Hiring>('POST', '/hiring/startup', c),
  saveCompany: (c: Partial<HiringCompany>) => call<Hiring>('PUT', '/hiring/startup', c),
  postRole: (r: Partial<HiringRole>) => call<Hiring>('POST', '/hiring/roles', r),
  saveRole: (id: number, r: Partial<HiringRole>) => call<Hiring>('PUT', `/hiring/roles/${id}`, r),

  adminQueue: () => call<AdminQueue>('GET', '/admin/queue'),
  applyMethods: () => call<ApplyMethod[]>('GET', '/admin/apply-methods'),
  setApplyMethods: (enabled: string[]) => call<{ enabled: string[] }>('POST', '/admin/apply-methods', { enabled }),
  setListed: (id: number, listed: boolean) => call<Startup>('POST', `/admin/startups/${id}`, { status: listed ? 'listed' : 'rejected' }),
  resolveReport: (id: number) => call<void>('POST', `/admin/reports/${id}/resolve`),
  importStatus: () => call<{ running: boolean; runs: ImportRun[] }>('GET', '/admin/import'),
  applierStatus: () =>
    call<{ running: boolean; current: { id: number } | null; last: { id: number; state: string; error: string; at: string } | null; counts: Record<string, number>; ai: boolean }>(
      'GET',
      '/admin/applier',
    ),
  applierTest: (roleId?: number) =>
    call<{ role: { id: number; title: string; startup: string; url: string }; state: string; error: string; missing: string[]; answers: Application['answers']; fieldsFilled: number; screenshot: string }>(
      'POST',
      '/admin/applier-test',
      { roleId },
    ),
  runImport: () => call<{ running: boolean; already: boolean }>('POST', '/admin/import'),
}

/** Reads a PDF the person picked and uploads it as their resume. */
/** Uploads a resume PDF. With `parse`, the response also suggests profile fields read from it. */
export async function uploadResumeFile(file: File, parse = false) {
  if (file.size > 4 * 1024 * 1024) throw new ApiError('That PDF is over 4 MB', 400, {})
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return api.uploadResume(file.name, btoa(bin), parse)
}

export const money = (n: number | null | undefined) => (n ? `$${n >= 1000 ? `${Math.round(n / 1000)}k` : n}` : '')
export const salaryRange = (min: number | null, max: number | null) =>
  min && max ? `${money(min)}–${money(max)}` : min ? `${money(min)}+` : max ? `up to ${money(max)}` : ''
export const WORK_LABEL = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', any: 'Open to anything' } as const
