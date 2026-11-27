export type Role = 'dev'
export type WorkPref = 'remote' | 'hybrid' | 'onsite' | 'any'
export type WorkMode = 'remote' | 'hybrid' | 'onsite'

export interface User {
  id: number
  email: string
  role: Role
  isAdmin: boolean
  /** Started without signing up; email is '' until they add one. */
  isGuest: boolean
}

export interface Links {
  github?: string
  linkedin?: string
  portfolio?: string
}

export interface DevProfile {
  name?: string
  headline?: string
  location?: string
  work_pref?: WorkPref
  years?: number | null
  skills?: string
  bio?: string
  experience?: string
  links?: Links
  salary_min?: number | null
  complete?: boolean
  // Applying for you
  phone?: string
  work_authorized?: '' | 'yes' | 'no'
  needs_sponsorship?: '' | 'yes' | 'no'
  has_resume?: boolean
  resume_name?: string | null
  auto_apply?: boolean
  saved_answers?: { question: string; answer: string }[]
  applyMissing?: ApplyField[]
}

export type ApplyField = 'name' | 'phone' | 'work_authorized' | 'needs_sponsorship' | 'resume'

export type ApplicationState = 'queued' | 'running' | 'submitted' | 'needs_you' | 'failed' | 'canceled' | 'self_applied'

export interface Application {
  id: number
  role_id: number
  state: ApplicationState
  error: string
  missing: string[]
  answers: { question: string; answer: string; source: 'saved' | 'drafted' }[]
  cover_note: string
  has_screenshot: boolean
  created_at: string
  updated_at: string
  submitted_at: string | null
  // list only
  title?: string
  apply_url?: string
  role_status?: 'open' | 'closed'
  startup_name?: string
  domain?: string
  headcount?: number
}

/** 'listed' is shown; 'pending' was hidden after reports; 'rejected' was removed by an admin. */
export type StartupStatus = 'listed' | 'retired' | 'pending' | 'rejected' | 'approved'

export interface Startup {
  id: number
  name: string
  website: string
  domain: string
  headcount: number
  stage: string
  one_liner: string
  about: string
  location: string
}

export interface Me {
  user: User | null
  counts?: { needsYou: number; openReports?: number }
  profile?: DevProfile | null
  profileComplete?: boolean
}

/** A job in the deck: an open engineering role at a startup with 50 or fewer people. */
export interface RoleCard {
  id: number
  title: string
  description: string
  location: string
  work_mode: WorkMode
  salary_min: number | null
  salary_max: number | null
  equity: string
  skills: string
  created_at: string
  posted_at: string | null
  apply_url: string
  sharedSkills: string[]
  startup: Startup
}

export interface SwipeResult {
  apply_url: string
  /** A guest swiped right: ask for an email so HireMe can send it. */
  needsAccount: boolean
  application: Application | null
  applySetup: { missing: ApplyField[]; consented: boolean } | null
}

export interface SavedRole {
  id: number
  title: string
  apply_url: string
  status: 'open' | 'closed'
  liked_at: string
  startup_name: string
  domain: string
  headcount: number
}

export interface ImportRun {
  id: number
  started_at: string
  finished_at: string | null
  companies: number | null
  startups_added: number | null
  boards: number | null
  roles_added: number | null
  roles_updated: number | null
  roles_closed: number | null
  errors: string[]
}

export interface Report {
  id: number
  reporter: string | null
  target_id: number
  target_name: string
  target_status: StartupStatus
  domain: string
  website: string
  reason: string
  detail: string
  created_at: string
}

export interface HiddenStartup {
  id: number
  name: string
  domain: string
  website: string
  status: StartupStatus
  flags: string
  headcount: number
}

export interface AdminQueue {
  reports: Report[]
  hidden: HiddenStartup[]
  stats: { devs: number; openRoles: number; listed: number; submitted: number }
}
