# HireMe

Sprout-style job applying, for startups only. Developers swipe through engineering roles at startups with 50 or fewer people; swipe right and HireMe fills out and submits the application for them. No recruiters, no big companies, nothing for companies to sign up for.

- **Discover:** one role per card, ranked by shared skills, work style and salary floor.
- **Swipe right:** HireMe applies. Nothing to fill in at swipe time; everything applications need is gathered while getting started. **Swipe left:** skip. Undo works until HireMe starts the application.
- **Applications:** every application, its status, what was sent and a screenshot of the form. Questions HireMe can't answer truthfully show up as "Needs you".
- **Getting started:** no sign-up form. "Find a startup job" starts a guest session and asks a few one-tap questions (what you build, skills, years, how you like to work, US work authorization and sponsorship, LinkedIn/GitHub/portfolio, name, and where startups should reach you), or reads a resume and asks only what's left. Then you're swiping.
- **Email confirmation, without stopping the swiping:** guests get a one-tap link to confirm their email (valid 24 hours). Right swipes are kept until then and all go out when it's tapped, even on another device; "Continue with Google" confirms instantly. Signing in to an existing account keeps that account's profile and brings the swipes along. Guests that never confirm are deleted after 30 days.
- **No resume needed:** without an uploaded PDF, HireMe builds a resume from the profile.

## How the startup-only rule is enforced

1. **50 people or fewer.** Every listing comes from a company whose team size is 50 or fewer (from YC's directory), and the deck only shows roles at those companies. Startups that grow past 50 are retired at the next import.
2. **No agencies.** Companies whose description mentions recruiting, staffing or outsourcing are skipped at import.
3. **Reports.** Developers can report a company as a recruiter, too big, or a closed job. Three "recruiter" or "too big" reports from different people hide the company until an admin looks, and a reporter stops seeing that company right away. Admins can remove a company or put it back from the **Admin** tab.

## Sign in

A one-time link by email, or **Continue with Google**. Set `GOOGLE_CLIENT_ID` to a Google OAuth **Web application** client ID whose authorized JavaScript origins include your site (e.g. `https://hireme-startups.fly.dev`). Only the client ID is needed — no client secret. The browser gets a signed ID token from Google, and the server checks its signature against Google's published keys, the audience, issuer and expiry, and that Google verified the email.

## Imported jobs

So developers have roles to swipe on from day one, the server imports engineering roles from startups with 50 or fewer people (`server/src/importer.js`), shortly after it starts and then twice a day:

1. **Companies** come from the open [YC company dataset](https://github.com/yc-oss/api) (YC companies that are hiring, with team sizes). Only basic facts are used: name, website, size, one-liner. Anything over 50 people, inactive, or that looks like a staffing agency is skipped.
2. **Job boards** are found from links on the company's website (homepage, `/careers`, `/jobs`, respecting robots.txt). If there's no link, the company's name is tried on Ashby, Greenhouse and Lever, and a guessed board only counts if its posts mention the company.
3. **Roles** come from those boards' public APIs. Only engineering titles are kept; skills are picked out of the description. Roles that come down from the board are closed, and startups that grow past 50 are retired.

ycombinator.com itself is never scraped; its terms of use don't allow it.

Admins can run or watch imports from the Admin tab. Set `IMPORT_JOBS=off` to disable the schedule.

## Applying for developers

Like Sprout, HireMe applies for the developer (`server/src/apply/`):

1. Getting started collects what forms need (phone, US work authorization, sponsorship, links; a resume is optional). Swiping right is the go-ahead.
2. Every right swipe queues an application. If a detail is missing, the swipe waits and goes out as soon as the profile is complete. A background worker opens the company's form in headless Chromium, fills it from the profile, attaches their resume (uploaded, or generated from the profile) and a cover note, and submits. It checks for a confirmation and keeps a screenshot.
3. Open-ended questions ("Why do you want to work here?") are drafted by Claude from the profile and job post when `ANTHROPIC_API_KEY` is set (otherwise a short template). **Factual questions are never drafted**: work authorization, sponsorship, salary, start date, location, demographics and similar come only from the developer.
4. Common questions are answered from the profile and its **form answers** (salary expectations, notice period/start date, open to office work, willing to relocate, "are you based in…"), with defaults the developer can see and change. With `ANTHROPIC_API_KEY`, Claude also answers factual questions strictly from those facts.
5. Anything it still can't finish (a CAPTCHA a person has to solve, a question only the developer can answer, a form error) shows up under **Applications**. Each waiting question is asked once, however many applications need it; the answer is saved, reused on later forms, and sends every application that was waiting on it. LinkedIn/GitHub/website answers also go into the profile. Invisible CAPTCHAs (like Ashby's reCAPTCHA badge) don't stop an application.
6. **Review before sending** (optional, on the profile): HireMe fills each form but waits; the developer checks the answers, edits any, and taps Send.

The importer also skips job boards shared by several companies (VC portfolio boards, recruiters), so only a startup's own roles are listed.

Limits: one application at a time, 30 per developer per day. HireMe never solves CAPTCHAs. Admins can check compatibility with **Test on a real job form**, which fills a real imported role's form with a made-up applicant and never submits.

| Variable | What it does |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Optional. Shows “Continue with Google” on the sign-in page (see below) |
| `ANTHROPIC_API_KEY` | Optional. Drafts open-ended answers and cover notes (`ANTHROPIC_MODEL` defaults to `claude-haiku-5-5`) |
| `CHROME_PATH` | Optional. Use an installed Chrome instead of Playwright's Chromium |

## Privacy

- Profiles aren't public. Companies only get what HireMe sends in an application the developer swiped right on.
- Anyone can delete their account, which removes their profile, swipes, applications, resume file and screenshots.
- Resumes and form screenshots are stored on the server's disk next to the database and are only served to their owner.

## Run it locally

Requires Node 22.13+.

```bash
npm run setup
npm run demo     # fictional startups and developers, at http://localhost:4317
```

In the demo, sign in as `jo@dev.example` (profile already filled in), as `admin@hireme.example` for the Admin tab, or with any other email for a new account. Demo job links point at `.example` sites, so applications there will fail. Without email configured, the sign-in link appears on screen.

To run with your own data instead:

```bash
cp .env.example .env   # set ADMIN_EMAILS to your email
npm start
```

`npm run dev` runs the API with reload and Vite on :5173. `npm test` runs the API tests and lint.

## Put it online

It's one Node server with a SQLite file, so it needs a host with a persistent disk.

**Fly.io** (config included):

```bash
fly launch --no-deploy          # keep the existing fly.toml; pick an app name
fly volumes create hireme_data --size 1
fly secrets set PUBLIC_URL=https://<app>.fly.dev ADMIN_EMAILS=you@example.com \
  SMTP_URL='smtps://resend:<API_KEY>@smtp.resend.com:465' MAIL_FROM='HireMe <hello@yourdomain.com>'
fly deploy
```

Any host that runs a Dockerfile with a volume mounted at `/data` works the same way (Railway, Render, a VPS, or a Raspberry Pi behind Cloudflare Tunnel).

**Email is required in production.** Sign-in links can't be delivered without `SMTP_URL`; the server refuses sign-ins rather than failing silently. Any SMTP provider works. Resend and Postmark both have free tiers and need you to verify a sending domain.

| Variable | What it does |
| --- | --- |
| `PUBLIC_URL` | Public address, used in emails and to mark cookies `Secure` |
| `ADMIN_EMAILS` | Comma-separated emails that get the Admin tab and report emails |
| `SMTP_URL`, `SMTP_PASS`, `MAIL_FROM` | Outgoing email for sign-in links and application updates. For Gmail: `SMTP_URL=smtps://you%40gmail.com@smtp.gmail.com:465`, `SMTP_PASS=<app password>`, `MAIL_FROM=HireMe <you@gmail.com>` |
| `DB_PATH` | SQLite file (default `server/data/hireme.db`; `/data/hireme.db` in Docker) |

Back up the SQLite file regularly (for example `fly ssh console -C "sqlite3 /data/hireme.db .dump"` or a volume snapshot).

## Project layout

```
web/      React + Vite installable web app
  src/views/        Landing, Discover (the deck), Applications, Profile, Admin
  src/components/   Swipe deck, apply setup sheet, sheets, report button
server/   Express + SQLite API
  src/auth.js       Magic-link sign-in, sessions, rate limits, cross-site request guard
  src/rules.js      Agency check and domain helpers
  src/app.js        Profiles, resume upload, deck, swipes, applications, reports, admin
  src/importer.js   Startup jobs from YC's dataset and Ashby/Greenhouse/Lever boards
  src/apply/        The applying worker (headless Chromium), form filler, Claude drafts
  src/resume-parse.js  Reads a resume PDF into suggested profile fields
  src/mail.js       SMTP (or log to console when not configured)
  scripts/demo.js   Fictional demo data
  test/             API tests
```

The earlier single-user auto-apply version (the first Sprout clone) is on the `sprout` branch.
