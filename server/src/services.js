// Data operations shared by the HTTP API and the apply agent.
import { generateAnswer, generateCoverLetter, generateQuestions, tailorResume } from './ai.js';
import { bestSavedAnswer, profileAnswer } from './match.js';

export const DEFAULT_SETTINGS = {
  keywords: '',
  exclude: '',
  locations: '',
  remoteOk: true,
  maxAgeDays: 30,
  requireApproval: false,
  askQuestions: true,
  tailorResume: true,
  practiceMode: true, // fill forms but stop before Submit, until you turn it off
  dailyLimit: 30,
  autoRefreshHours: 6,
};

export function createServices(db) {
  const json = (s, fallback = {}) => {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  };

  const svc = {
    getProfile: () => json(db.prepare('SELECT data FROM profile WHERE id = 1').get().data),
    saveProfile(patch) {
      const data = { ...svc.getProfile(), ...patch };
      db.prepare("UPDATE profile SET data = ?, updated_at = datetime('now') WHERE id = 1").run(JSON.stringify(data));
      return data;
    },
    getSettings: () => ({ ...DEFAULT_SETTINGS, ...json(db.prepare('SELECT data FROM settings WHERE id = 1').get().data) }),
    saveSettings(patch) {
      const data = { ...svc.getSettings(), ...patch };
      db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(data));
      return data;
    },

    getJob(id) {
      const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      return j ? { ...j, context: json(j.context) } : undefined;
    },
    getJobByUrl(url) {
      const j = db.prepare('SELECT * FROM jobs WHERE url = ?').get(url);
      return j ? { ...j, context: json(j.context) } : undefined;
    },
    setJob(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return svc.getJob(id);
      const vals = keys.map((k) => (k === 'context' ? JSON.stringify(fields[k]) : fields[k]));
      db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, id);
      return svc.getJob(id);
    },
    logEvent: (jobId, kind, detail = '') => db.prepare('INSERT INTO events (job_id, kind, detail) VALUES (?, ?, ?)').run(jobId, kind, String(detail).slice(0, 500)),

    // ---- swipe flow ----
    async questionsFor(job) {
      if (job.context?.questions) return job.context.questions;
      let questions = [];
      try {
        questions = await generateQuestions(svc.getProfile(), job);
      } catch (e) {
        console.warn('questions failed:', e.message);
      }
      svc.setJob(job.id, { context: { ...job.context, questions } });
      return questions;
    },

    saveContextAnswers(job, answers) {
      const ctx = { ...job.context, answers: { ...(job.context?.answers || {}), ...answers } };
      // Answers to missing screening facts also fill in the profile for next time.
      const profilePatch = {};
      for (const q of ctx.questions || []) {
        const a = answers[q.id];
        if (q.profileKey && a) profilePatch[q.profileKey] = /^y/i.test(a) ? 'yes' : /^n/i.test(a) ? 'no' : a;
      }
      if (Object.keys(profilePatch).length) svc.saveProfile(profilePatch);
      return svc.setJob(job.id, { context: ctx });
    },

    approve(job) {
      return svc.setJob(job.id, { status: 'queued', apply_state: 'pending', apply_error: '' });
    },

    /** Makes the cover letter and tailored resume if they don't exist yet. */
    async prepare(job, { force = false } = {}) {
      const profile = svc.getProfile();
      const settings = svc.getSettings();
      const patch = {};
      if (force || !job.cover_letter) patch.cover_letter = await generateCoverLetter(profile, job, job.context);
      if (settings.tailorResume && (force || !job.tailored_resume)) {
        const r = await tailorResume(profile, job, job.context).catch((e) => {
          console.warn('resume tailoring failed:', e.message);
          return null;
        });
        if (r) patch.tailored_resume = r;
      }
      return svc.setJob(job.id, patch);
    },

    // ---- apply queue ----
    appliedToday: () => db.prepare("SELECT COUNT(*) n FROM jobs WHERE applied_at >= datetime('now', 'start of day')").get().n,

    /** After a right swipe (and any questions), where the job goes next. */
    releaseAfterQuestions(job) {
      const next = svc.getSettings().requireApproval ? 'review' : 'pending';
      return svc.setJob(job.id, { apply_state: next });
    },

    claimNext() {
      // Questions left unanswered for 30 minutes don't hold the job forever.
      const next = svc.getSettings().requireApproval ? 'review' : 'pending';
      db.prepare("UPDATE jobs SET apply_state = ? WHERE apply_state = 'questions' AND updated_at < datetime('now', '-30 minutes')").run(next);
      db.prepare("UPDATE jobs SET apply_state = 'pending' WHERE apply_state = 'running' AND apply_started_at < datetime('now', '-10 minutes')").run();
      const row = db.prepare("SELECT id FROM jobs WHERE status = 'queued' AND apply_state = 'pending' ORDER BY updated_at ASC LIMIT 1").get();
      if (!row) return null;
      db.prepare("UPDATE jobs SET apply_state = 'running', apply_started_at = datetime('now') WHERE id = ?").run(row.id);
      svc.logEvent(row.id, 'apply_started');
      return svc.getJob(row.id);
    },

    recordResult(job, { state, error = '', fieldsFilled = 0, screenshot = '' }) {
      if (state === 'done') {
        svc.setJob(job.id, { status: 'applied', apply_state: 'done', apply_error: '', screenshot, applied_at: job.applied_at || new Date().toISOString() });
        svc.logEvent(job.id, 'applied', `auto-applied, ${fieldsFilled} fields`);
      } else {
        svc.setJob(job.id, { apply_state: state, apply_error: error, screenshot });
        svc.logEvent(job.id, state, error);
      }
      return svc.getJob(job.id);
    },

    // ---- answering form questions ----
    // Order: profile rule → saved answer → this job's gap answers via AI → template.
    async answer(question, jobUrl, { generate = true } = {}) {
      const profile = svc.getProfile();
      const fromProfile = profileAnswer(question, profile);
      if (fromProfile) return { answer: fromProfile, source: 'profile' };
      const answers = db.prepare('SELECT * FROM answers').all();
      const saved = bestSavedAnswer(question, answers);
      if (saved) return { answer: saved.answer, source: 'saved', score: saved.score };
      if (!generate) return { answer: null, source: 'none' };
      const job = jobUrl ? svc.getJobByUrl(jobUrl) : null;
      const text = await generateAnswer(profile, job, question, answers.slice(0, 5), job?.context);
      return { answer: text || null, source: text ? (process.env.ANTHROPIC_API_KEY ? 'ai' : 'template') : 'none' };
    },
  };
  return svc;
}
