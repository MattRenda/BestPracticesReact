export type Role = '' | 'dev' | 'founder'
export type WorkPref = 'remote' | 'hybrid' | 'onsite' | 'any'
export type WorkMode = 'remote' | 'hybrid' | 'onsite'

export interface User {
  id: number
  email: string
  role: Role
  isAdmin: boolean
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
  visible?: boolean
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

export type StartupStatus = 'pending' | 'approved' | 'rejected' | 'listed' | 'retired'

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
  status?: StartupStatus
  review_note?: string
  /** False for startups imported from YC's directory whose founders haven't joined. */
  onHireMe?: boolean
}

export interface RoleListing {
  id: number
  title: string
  description: string
  location: string
  work_mode: WorkMode
  salary_min: number | null
  salary_max: number | null
  equity: string
  skills: string
  status: 'open' | 'closed'
  created_at: string
  interested?: number
  matches?: number
}

export interface MyStartup extends Startup {
  status: StartupStatus
  flags: string
  roles: RoleListing[]
  team: { email: string; title: string }[]
}

export interface Me {
  user: User | null
  counts?: { unread: number; interested?: number; pendingStartups?: number; openReports?: number; needsYou?: number }
  profile?: DevProfile | null
  profileComplete?: boolean
  startup?: Startup | null
  joinable?: { id: number; name: string; status: StartupStatus; claimable: boolean } | null
}

/** A role card in a developer's deck. */
export interface RoleCard extends Omit<RoleListing, 'interested' | 'matches'> {
  interested: boolean
  /** Set when the startup isn't on HireMe yet: apply on their own site. */
  external: { apply_url: string } | null
  posted_at: string | null
  sharedSkills: string[]
  startup: Startup
}

/** A developer card in a founder's deck. */
export interface DevCard {
  id: number
  name: string
  headline: string
  location: string
  work_pref: WorkPref
  years: number | null
  skills: string
  bio: string
  experience: string
  links: Links
  likedRole: boolean
  note: string
  sharedSkills: string[]
}

export interface SwipeResult {
  matched: boolean
  matchId: number | null
  external?: { apply_url: string } | null
  application?: Application | null
  applySetup?: { missing: ApplyField[]; consented: boolean } | null
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

export interface MatchSummary {
  id: number
  created_at: string
  closed: boolean
  role_title: string
  startup_name: string
  domain: string
  dev_name: string | null
  dev_headline: string | null
  last_body: string | null
  last_at: string | null
  unread: number
}

export interface Message {
  id: number
  body: string
  created_at: string
  sender_id: number
  mine: boolean
  side: 'dev' | 'startup'
}

export interface MatchDetail {
  id: number
  created_at: string
  closed: boolean
  role: RoleListing
  startup: Startup
  dev: Omit<DevCard, 'likedRole' | 'note' | 'sharedSkills'> | null
  messages: Message[]
}

export interface AdminStartup extends Startup {
  status: StartupStatus
  flags: string
  members: string | null
  reports: number
  created_at: string
}

export interface Report {
  id: number
  reporter: string | null
  target_type: 'startup' | 'dev'
  target_id: number
  target_name: string | null
  reason: string
  detail: string
  created_at: string
}

export interface AdminQueue {
  startups: AdminStartup[]
  reports: Report[]
  stats: { devs: number; founders: number; openRoles: number; matches: number; listed: number; importedRoles: number }
}
