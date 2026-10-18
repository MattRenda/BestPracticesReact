import type { AgentStatus, GapQuestion, Job, JobEvent, Profile, SavedAnswer, Settings, Source, Stats } from './types'

const TOKEN_KEY = 'sprout-token'

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}
export function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t)
  } catch {
    /* private mode */
  }
}

export class AuthError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body) headers['content-type'] = 'application/json'
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  } catch {
    throw new Error("Can't reach Sprout. Make sure the server is running.")
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) throw new AuthError(data.error || 'Enter your access code')
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data as T
}

/** For <img>/<a> URLs that can't send headers. */
export const withToken = (path: string) => {
  const t = getToken()
  return `/api${path}${t ? `${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}` : ''}`
}

type JobDetail = Job & { events: JobEvent[] }

export const api = {
  stats: () => call<Stats>('GET', '/stats'),
  agent: () => call<AgentStatus>('GET', '/agent'),
  runAgent: () => call<AgentStatus>('POST', '/agent/run'),

  profile: () => call<Profile>('GET', '/profile'),
  saveProfile: (p: Profile) => call<Profile>('PUT', '/profile', p),
  settings: () => call<Settings>('GET', '/settings'),
  saveSettings: (s: Partial<Settings>) => call<Settings>('PUT', '/settings', s),

  sources: () => call<Source[]>('GET', '/sources'),
  addSource: (url: string) => call<Source>('POST', '/sources', { url }),
  deleteSource: (id: number) => call<void>('DELETE', `/sources/${id}`),
  refreshFeed: () => call<{ added: number; report: { source: string; found?: number; added?: number; error?: string }[] }>('POST', '/feed/refresh'),

  deck: () => call<Job[]>('GET', '/deck'),
  swipe: (id: number, direction: 'left' | 'right' | 'undo') => call<Job>('POST', `/jobs/${id}/swipe`, { direction }),
  questions: (id: number) => call<{ questions: GapQuestion[]; answers: Record<string, string> }>('GET', `/jobs/${id}/questions`),
  saveContext: (id: number, answers: Record<string, string>, done: boolean) => call<Job>('PUT', `/jobs/${id}/context`, { answers, done }),
  prepare: (id: number, force = false) => call<Job>('POST', `/jobs/${id}/prepare`, { force }),
  approve: (id: number) => call<Job>('POST', `/jobs/${id}/approve`),
  retry: (id: number) => call<Job>('POST', `/jobs/${id}/retry`),

  answers: () => call<SavedAnswer[]>('GET', '/answers'),
  addAnswer: (a: Pick<SavedAnswer, 'question' | 'answer'>) => call<SavedAnswer>('POST', '/answers', a),
  updateAnswer: (id: number, a: Partial<SavedAnswer>) => call<SavedAnswer>('PUT', `/answers/${id}`, a),
  deleteAnswer: (id: number) => call<void>('DELETE', `/answers/${id}`),

  jobs: (q: { status?: string; apply_state?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()
    return call<Job[]>('GET', `/jobs${qs ? `?${qs}` : ''}`)
  },
  job: (id: number) => call<JobDetail>('GET', `/jobs/${id}`),
  addJob: (j: Partial<Job>) => call<Job>('POST', '/jobs', j),
  updateJob: (id: number, j: Partial<Job>) => call<Job>('PATCH', `/jobs/${id}`, j),
  deleteJob: (id: number) => call<void>('DELETE', `/jobs/${id}`),
  coverLetter: (id: number) => call<{ cover_letter: string; ai: boolean }>('POST', `/jobs/${id}/cover-letter`),
}
