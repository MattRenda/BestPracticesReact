# Sprout

Swipe right on a job and Sprout applies for you. Swipe left to skip.

It's a self-hosted take on the swipe-to-apply idea: one web app you can install on your phone, plus an agent that fills and submits applications in a headless browser on your own machine.

## How it works

1. **Pick companies.** Paste their careers board links in Settings. Sprout pulls open roles from their Greenhouse, Lever and Ashby boards (their public job APIs) every few hours. It keeps the ones that match your title keywords, exclusions and locations.
2. **Swipe.** Each job is a card. Drag right or press → to apply. Drag left or press ← to skip. Press Z to undo.
3. **Answer a couple of questions (optional).** After a right swipe, Sprout may ask about gaps between your resume and the job. Your answers feed into that application. Skipping is fine, and unanswered questions never block applying for more than 30 minutes.
4. **Sprout applies.** The agent prepares a cover letter and, with an Anthropic API key, a resume tailored to the job (as a PDF). It opens the application, fills every field it can from your profile, saved answers and resume, attaches the files, submits, and waits for the confirmation.
5. **Anything it can't do honestly goes to Review.** That covers CAPTCHAs, required questions it can't answer truthfully, and validation errors. You get the reason, a screenshot of where it stopped, and a link to finish it yourself.

**Practice mode is on by default.** Sprout fills each form but stops before Submit, so you can check its work in Review. Turn it off in Settings when you trust it.

Other settings: approve each application before it's sent, a daily cap (default 30), and how often to check for new jobs.

## Run it

Requires Node 22.13+.

```bash
npm run setup          # installs everything, including the browser the agent uses
cp .env.example .env   # optional: add ANTHROPIC_API_KEY for tailored writing
npm start              # builds the app and serves it at http://localhost:4317
```

Then fill in your **Profile** first: contact info, screening answers, your resume file and resume text. Next, add companies in **Settings**, and go swipe.

For development, `npm run dev` runs the API with reload and Vite on :5173.

### From your phone

Set these in `.env`, restart, and open `http://<your-computer's-LAN-IP>:4317` on your phone:

```
HOST=0.0.0.0
SPROUT_TOKEN=some-long-access-code
```

Use your browser's "Add to Home Screen" to install it like an app. The server refuses to listen on the network without `SPROUT_TOKEN`, because it holds your personal data. Keep it on your home network, or put it behind something like Tailscale rather than exposing it to the internet.

The agent needs the computer (or a Raspberry Pi) running Sprout to stay on. That's where applications happen.

## What gets submitted

- **Profile fields:** name, email, phone, links, location, current role, years of experience, work authorization, sponsorship, relocation, salary expectation, start date. These come from your profile exactly as you set them.
- **Voluntary EEO questions:** "decline to self-identify" unless you set otherwise.
- **Required consent checkboxes** ("I acknowledge the privacy policy"): ticked on your behalf. Using auto-apply means you agree to them.
- **Open questions:** your saved answer if one matches. Otherwise Claude drafts an answer from your resume and your answers for that job. If it can't answer truthfully, the job goes to Review instead of getting a made-up answer.
- **Resume:** the tailored PDF if one was made, otherwise your uploaded file.

Sprout never tries to get around CAPTCHAs or bot checks. Some employers' boards discourage automated applications. Review those sites' terms if that matters to you.

## Project layout

```
web/      React + Vite installable web app (swipe deck, review, applications, profile, settings)
server/   Express + SQLite API, job feed, and the apply agent
  src/feed.js           Greenhouse / Lever / Ashby board fetching and filters
  src/ai.js             Claude prompts (questions, cover letter, tailored resume, answers) + offline templates
  src/services.js       swipe → questions → review → apply-queue state
  src/agent/agent.js    headless browser worker: fill, upload, submit, verify
  src/agent/filler.js   in-page form reader/filler
  test/                 API tests and end-to-end agent tests against local forms
```

`npm test` runs the API tests, end-to-end agent tests in a real browser (skipped if none is installed), and lint.
