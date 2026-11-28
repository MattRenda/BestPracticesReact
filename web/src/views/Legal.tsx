// Plain-language privacy policy and terms. Keep these in sync with what the server actually does.
const UPDATED = 'November 26, 2026'
const CONTACT = 'matthewjrenda@gmail.com'

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="landing legal">
      <header className="landing-top">
        <a className="brand" href="/">
          <img src="/hireme.svg" alt="" width={32} height={32} />
          <span>HireMe</span>
        </a>
      </header>
      <article className="legal-body">
        <h1>{title}</h1>
        <p className="muted">Last updated {UPDATED}</p>
        {children}
      </article>
    </div>
  )
}

export function Privacy() {
  return (
    <Shell title="Privacy policy">
      <p>
        HireMe helps developers apply to engineering jobs at startups with 50 or fewer people. It’s run by Matthew Renda. Questions or requests: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Your email address</strong>, to sign you in. If you use “Continue with Google,” Google tells us your email address and that it’s verified; we don’t get your
          password or access to anything else in your Google account.
        </li>
        <li>
          <strong>Developer profiles:</strong> what you enter, such as name, headline, location, skills, experience, links, salary floor, and optionally phone, US work
          authorization, sponsorship needs, a resume PDF, and answers you save for application questions.
        </li>
        <li>
          <strong>Activity:</strong> your swipes, reports, and the applications HireMe sends for you, including a screenshot of each application form.
        </li>
        <li>
          <strong>Technical:</strong> a sign-in cookie and the time you were last active. We use your IP address briefly to limit abuse; we don’t store it.
        </li>
      </ul>

      <h2>How it’s used and who sees it</h2>
      <ul>
        <li>To fill in where you’re based, your browser asks BigDataCloud for the city of your connection (or, if you tap “Use my location” and allow it, of your device). Only the city and state are kept.</li>
        <li>When you tap “Find me”, HireMe looks up your name, email and city on GitHub and in Brave Search’s web results, and reads the website you list, to suggest your GitHub and LinkedIn. Nothing is saved unless you confirm it.</li>
        <li>Your profile isn’t public and isn’t shown to companies on HireMe. Companies only receive what HireMe sends in an application you asked for.</li>
        <li>
          <strong>Applying for you:</strong> when you swipe right on a role, we send your name, email, phone, links, location, work
          authorization answers, resume, a cover note, and answers to the form’s questions to that company’s job application. We only do this for roles you swipe right
          on, and only after you’ve confirmed your email.
        </li>
        <li>We email you sign-in links and updates about your applications.</li>
        <li>We don’t sell your information or use it for advertising.</li>
      </ul>

      <h2>Services we use</h2>
      <ul>
        <li>Fly.io hosts HireMe and stores its data in the United States.</li>
        <li>Google sends our emails (Gmail) and provides “Continue with Google.”</li>
        <li>
          Anthropic (Claude) may draft cover notes and answers to open-ended application questions. When it does, your profile and the job post are sent to Anthropic’s API
          for that purpose.
        </li>
        <li>Job listings come from startups’ public job boards and public company information.</li>
      </ul>

      <h2>Keeping and deleting your data</h2>
      <p>
        We keep your data while you have an account. Deleting your account (from your Profile page) removes your profile, resume, swipes, applications and screenshots. Applications already sent to companies are held by those companies under their own policies. To ask what we have about you, or to
        correct or delete it, email <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <h2>Changes</h2>
      <p>If we change this policy in a meaningful way, we’ll update the date above and let signed-up users know by email.</p>
    </Shell>
  )
}

export function Terms() {
  return (
    <Shell title="Terms of service">
      <p>
        These terms cover your use of HireMe, run by Matthew Renda. By signing in you agree to them. Questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <h2>Who can use HireMe</h2>
      <ul>
        <li>Developers looking for work.</li>
        <li>Listings are only from startups with 50 or fewer people hiring for themselves. Startups that post roles on HireMe must sign in with an email at the company’s domain and confirm their size. We remove recruiters, staffing agencies and companies that don’t meet this.</li>
        <li>You need to be at least 18.</li>
      </ul>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Keep your information accurate. You’re responsible for what you post and send.</li>
        <li>Don’t spam, harass, scrape, impersonate anyone, or misuse other people’s information.</li>
      </ul>

      <h2>Applying for you</h2>
      <p>
        Swiping right on a role authorizes HireMe to submit an application to it in your name, using your profile and saved answers, including accepting those forms’ standard privacy acknowledgments. When a startup takes applications by email, HireMe emails it for you from HireMe’s address, with your name, a short note, your resume and your links, and copies you so replies come to you. HireMe answers other questions on the form for you, favorably but
        grounded in your profile and the defaults on your profile page, which you can change. It answers work authorization, sponsorship, citizenship, degrees, clearance and
        criminal-history questions only from what you’ve told it, and asks you when it doesn’t know. Review your profile so what’s sent is accurate. Undo a swipe before HireMe starts the application to stop it.
      </p>

      <h2>Listings and outcomes</h2>
      <p>
        Listings come from startups’ public job boards and may be out of date. HireMe doesn’t guarantee interviews, offers, or that any application is received or
        answered. HireMe isn’t a party to any hiring decision or employment relationship.
      </p>

      <h2>The service</h2>
      <p>
        HireMe is provided as is, without warranties, and may change or stop. To the extent the law allows, HireMe isn’t liable for indirect or consequential losses
        arising from using it. We may suspend accounts that break these terms. You can delete your account at any time.
      </p>
    </Shell>
  )
}
