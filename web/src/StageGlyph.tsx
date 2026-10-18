import type { Status } from './types'

/** Growth-stage glyphs for each pipeline status: seed → sprout → leaf → bloom. */
export function StageGlyph({ status, size = 22 }: { status: Status; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true } as const
  switch (status) {
    case 'new':
    case 'queued':
      return (
        <svg {...common}>
          <path d="M3 19h18" stroke="var(--soil)" strokeWidth="1.6" strokeLinecap="round" />
          <ellipse cx="12" cy="15.5" rx="3.2" ry="2.2" fill="var(--moss)" />
        </svg>
      )
    case 'applied':
      return (
        <svg {...common}>
          <path d="M3 19h18" stroke="var(--soil)" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M12 19v-7" stroke="var(--moss)" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M12 13c0-3.2 2-5 5.5-5 0 3.2-2 5-5.5 5Z" fill="var(--pollen)" />
        </svg>
      )
    case 'interviewing':
      return (
        <svg {...common}>
          <path d="M3 21h18" stroke="var(--soil)" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M12 21V7" stroke="var(--moss)" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M12 11c0-3.5 2.2-5.5 6-5.5 0 3.5-2.2 5.5-6 5.5Z" fill="var(--moss)" />
          <path d="M12 15c0-3-2-4.8-5.4-4.8 0 3 2 4.8 5.4 4.8Z" fill="var(--moss)" />
        </svg>
      )
    case 'offer':
      return (
        <svg {...common}>
          <path d="M12 22V12" stroke="var(--moss)" strokeWidth="1.8" strokeLinecap="round" />
          {[0, 72, 144, 216, 288].map((r) => (
            <ellipse key={r} cx="12" cy="5.4" rx="2.4" ry="3.4" fill="var(--pollen)" transform={`rotate(${r} 12 8.6)`} />
          ))}
          <circle cx="12" cy="8.6" r="2" fill="var(--ink)" />
        </svg>
      )
    case 'rejected':
      return (
        <svg {...common}>
          <path d="M3 19h18" stroke="var(--soil)" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M7 19c1-3 3-4 5-4s4 1 5 4" fill="var(--muted)" opacity=".55" />
        </svg>
      )
    case 'skipped':
      return (
        <svg {...common}>
          <path d="M3 19h18" stroke="var(--soil)" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="2 3" />
        </svg>
      )
  }
}
