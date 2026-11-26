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

## Privacy

- Emails are never shown to the other side. People talk in the in-app chat and can share contact details when they choose.
- Founders only see developers once their startup is approved. Developers can hide their profile at any time.
- Anyone can delete their account, which removes their profile, swipes, matches and messages.

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
| `SMTP_URL`, `MAIL_FROM` | Outgoing email for sign-in links, matches and message nudges |
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
