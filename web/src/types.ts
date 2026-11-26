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
}

export type StartupStatus = 'pending' | 'approved' | 'rejected'

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
  counts?: { unread: number; interested?: number; pendingStartups?: number; openReports?: number }
  profile?: DevProfile | null
  profileComplete?: boolean
  startup?: Startup | null
  joinable?: { id: number; name: string; status: StartupStatus } | null
}

/** A role card in a developer's deck. */
export interface RoleCard extends Omit<RoleListing, 'interested' | 'matches'> {
  interested: boolean
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
  stats: { devs: number; founders: number; openRoles: number; matches: number }
}
