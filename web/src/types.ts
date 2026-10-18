export const STATUSES = ['new', 'queued', 'applied', 'interviewing', 'offer', 'rejected', 'skipped'] as const
export type Status = (typeof STATUSES)[number]

export const STATUS_LABEL: Record<Status, string> = {
  new: 'In your deck',
  queued: 'Applying',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  skipped: 'Skipped',
}

export interface Job {
  id: number
  url: string | null
  company: string
  title: string
  location: string
  description: string
  status: Status
  apply_state: ApplyState
  apply_error: string
  source: string
  posted_at: string | null
  notes: string
  cover_letter: string
  tailored_resume: string
  context: JobContext
  has_screenshot?: number
  screenshot?: string
  applied_at: string | null
  created_at: string
  updated_at: string
}

export type ApplyState = '' | 'questions' | 'review' | 'pending' | 'running' | 'done' | 'needs_you' | 'failed' | 'practiced'

export interface GapQuestion {
  id: string
  question: string
  placeholder?: string
}

export interface JobContext {
  questions?: GapQuestion[]
  answers?: Record<string, string>
}

export interface JobEvent {
  id: number
  kind: string
  detail: string
  created_at: string
}

export interface SavedAnswer {
  id: number
  question: string
  answer: string
  tags: string
}

export type YesNo = '' | 'yes' | 'no'

export interface Profile {
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  location?: string
  city?: string
  state?: string
  zip?: string
  linkedin?: string
  github?: string
  portfolio?: string
  currentCompany?: string
  currentTitle?: string
  yearsExperience?: string
  skills?: string
  summary?: string
  resumeText?: string
  resumeFile?: { name: string; type: string; data: string } // data is base64
  country?: string
  workAuthorized?: YesNo
  requireSponsorship?: YesNo
  willingToRelocate?: YesNo
  workArrangement?: string
  salaryExpectation?: string
  noticePeriod?: string
  referralSource?: string
  eeoGender?: string
  eeoRace?: string
  eeoVeteran?: string
  eeoDisability?: string
}

export interface Stats {
  byStatus: Record<Status, number>
  appliedThisWeek: number
  appliedToday: number
  deck: number
  applying: number
  review: number
  needsYou: number
  ai: boolean
  practiceMode: boolean
}

export interface Settings {
  keywords: string
  exclude: string
  locations: string
  remoteOk: boolean
  maxAgeDays: number
  requireApproval: boolean
  askQuestions: boolean
  tailorResume: boolean
  practiceMode: boolean
  dailyLimit: number
  autoRefreshHours: number
}

export interface Source {
  id: number
  ats: 'greenhouse' | 'lever' | 'ashby'
  slug: string
  name: string
  last_fetched_at: string | null
  last_error: string
}

export interface AgentStatus {
  enabled: boolean
  running?: boolean
  current?: { id: number; company: string; title: string } | null
  last?: { id: number; company: string; title: string; state: ApplyState; error: string; at: string } | null
  note?: string
}
