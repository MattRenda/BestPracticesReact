# HireMe

Startups with 50 or fewer people meet developers directly. No recruiters, no big companies.

- **Developers** swipe on open roles at verified startups.
- **Founders** swipe on developers, one role at a time. Developers who already said yes to that role show up first.
- **When both say yes**, it's a match and a chat opens. Nobody gets cold applications or cold messages.

## How the startup-only rule is enforced

1. **Work email.** Founders sign in with a one-time link sent to their email, which proves they own that inbox. The startup's website domain has to match the email domain. Personal addresses (Gmail, Outlook, iCloud and so on) can't create a startup.
2. **50 people or fewer.** Headcount is required at signup and can't be edited above 50 later.
3. **Not an agency.** Founders confirm they're hiring for their own startup. Signups that mention recruiting, staffing or outsourcing, or that are close to the size limit, are flagged for you.
4. **You approve every startup.** New startups stay hidden (roles aren't shown, and they can't browse developers) until an admin approves them in the **Admin** tab.
5. **Reports.** Anyone can report a startup as a recruiter or as too big. A startup reported for those reasons by three different people is hidden again until you review it. Reporters stop seeing who they reported right away.

Teammates join an existing startup by signing in with an email on the same domain.

## Sign in with Google

Set `GOOGLE_CLIENT_ID` to a Google OAuth **Web application** client ID whose authorized JavaScript origins include your site (e.g. `https://hireme-startups.fly.dev`). Only the client ID is needed — no client secret. The browser gets a signed ID token from Google, and the server checks its signature against Google's published keys, the audience, issuer and expiry, and that Google verified the email. Founders still need a work email on their startup's domain, so a Google Workspace account works and a personal Gmail can't create a startup.

## Imported jobs

So developers have roles to swipe on from day one, the server imports engineering roles from startups with 50 or fewer people (`server/src/importer.js`), shortly after it starts and then twice a day:

1. **Companies** come from the open [YC company dataset](https://github.com/yc-oss/api) (YC companies that are hiring, with team sizes). Only basic facts are used: name, website, size, one-liner. Anything over 50 people, inactive, or that looks like a staffing agency is skipped.
2. **Job boards** are found from links on the company's website (homepage, `/careers`, `/jobs`, respecting robots.txt). If there's no link, the company's name is tried on Ashby, Greenhouse and Lever, and a guessed board only counts if its posts mention the company.
3. **Roles** come from those boards' public APIs. Only engineering titles are kept; skills are picked out of the description. Roles that come down from the board are closed, and startups that grow past 50 are retired.

ycombinator.com itself is never scraped; its terms of use don't allow it.

Imported startups are **listed**, not verified members. When a developer says yes to one of their roles, HireMe points them to the company's own application page and keeps the yes. A founder who signs in with a work email on that startup's domain can **claim** it: it goes live right away (the email proves they work there, and the size comes from YC's directory), they see every developer who already said yes, and their job board keeps syncing. Admins get an email for each claim and can run or watch imports from the Admin tab. Set `IMPORT_JOBS=off` to disable the schedule.

## Applying for developers

For imported startups (not on HireMe yet), HireMe can apply for the developer, like Sprout (`server/src/apply/`):

1. The first time a developer says yes to one, HireMe asks for what forms need (phone, US work authorization, sponsorship, a resume PDF or their experience) and for consent to apply automatically.
2. After that, every yes queues an application. A background worker opens the company's form in headless Chromium, fills it from the profile, attaches their resume (uploaded, or generated from the profile) and a cover note, and submits. It checks for a confirmation and keeps a screenshot.
3. Open-ended questions ("Why do you want to work here?") are drafted by Claude from the profile and job post when `ANTHROPIC_API_KEY` is set (otherwise a short template). **Factual questions are never drafted**: work authorization, sponsorship, salary, start date, location, demographics and similar come only from the developer.
4. Anything it can't finish (a CAPTCHA, a question only the developer can answer, a form error) shows up under **Matches → Applications** as "Needs you". Answers given there are saved and reused on later forms. Developers can always finish on the company's site instead.

Limits: one application at a time, 30 per developer per day. HireMe never solves CAPTCHAs. Admins can check compatibility with **Test on a real job form**, which fills a real imported role's form with a made-up applicant and never submits.

| Variable | What it does |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Optional. Shows “Continue with Google” on the sign-in page (see below) |
| `ANTHROPIC_API_KEY` | Optional. Drafts open-ended answers and cover notes (`ANTHROPIC_MODEL` defaults to `claude-haiku-5-5`) |
| `CHROME_PATH` | Optional. Use an installed Chrome instead of Playwright's Chromium |

## Privacy

- Emails are never shown to the other side. People talk in the in-app chat and can share contact details when they choose.
- Founders only see developers once their startup is approved. Developers can hide their profile at any time.
- Anyone can delete their account, which removes their profile, swipes, matches, messages, applications, resume file and screenshots.
- Resumes and form screenshots are stored on the server's disk next to the database and are only served to their owner.

## Run it locally

Requires Node 22.13+.

```bash
npm run setup
npm run demo     # fictional startups and developers, at http://localhost:4317
```

In the demo, sign in as the founder `ana@tinyrocket.example`, as `admin@hireme.example` for the Admin tab, or with any other email as a developer. Without email configured, the sign-in link appears on screen.

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
| `ADMIN_EMAILS` | Comma-separated emails that get the Admin tab and new-startup emails |
| `SMTP_URL`, `SMTP_PASS`, `MAIL_FROM` | Outgoing email for sign-in links, matches and message nudges. For Gmail: `SMTP_URL=smtps://you%40gmail.com@smtp.gmail.com:465`, `SMTP_PASS=<app password>`, `MAIL_FROM=HireMe <you@gmail.com>` |
| `DB_PATH` | SQLite file (default `server/data/hireme.db`; `/data/hireme.db` in Docker) |

Back up the SQLite file regularly (for example `fly ssh console -C "sqlite3 /data/hireme.db .dump"` or a volume snapshot).

## Project layout

```
web/      React + Vite installable web app
  src/views/        Landing, Discover (both decks), Matches + chat, Profile, Startup, Admin
  src/components/   Swipe deck, sheets, report button
server/   Express + SQLite API
  src/auth.js       Magic-link sign-in, sessions, rate limits, cross-site request guard
  src/rules.js      Work-email, headcount and agency checks
  src/app.js        Profiles, startups, roles, swipes, matches, chat, reports, admin
  src/mail.js       SMTP (or log to console when not configured)
  scripts/demo.js   Fictional demo data
  test/             API tests
```

The earlier single-user auto-apply version (the Sprout clone) is on the `sprout` branch.
