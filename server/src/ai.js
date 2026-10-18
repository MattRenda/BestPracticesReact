// Writing: uses the Claude API when ANTHROPIC_API_KEY is set, otherwise falls back
// to deterministic templates so the app still works offline.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

async function callClaude(system, prompt, maxTokens = 800) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

const SYSTEM = `You write job application material for the applicant described below.
Write in first person, plainly and specifically. Never invent employers, degrees,
certifications, numbers or skills that are not in the applicant's profile, resume or
their answers. No placeholders like [Company]. No preamble — return only what is asked.`;

function profileBlock(p) {
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
  return [
    `Name: ${name || 'unknown'}`,
    p.email && `Email: ${p.email}`,
    p.phone && `Phone: ${p.phone}`,
    p.location && `Location: ${p.location}`,
    [p.linkedin, p.github, p.portfolio].filter(Boolean).length && `Links: ${[p.linkedin, p.github, p.portfolio].filter(Boolean).join(' | ')}`,
    p.currentTitle && `Current title: ${p.currentTitle}${p.currentCompany ? ` at ${p.currentCompany}` : ''}`,
    p.yearsExperience && `Years of experience: ${p.yearsExperience}`,
    p.skills && `Skills: ${p.skills}`,
    p.summary && `Summary: ${p.summary}`,
    p.resumeText && `Resume:\n${p.resumeText.slice(0, 12000)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function jobBlock(job) {
  if (!job) return 'Job: (not specified)';
  return [
    `Company: ${job.company || 'unknown'}`,
    `Role: ${job.title || 'unknown'}`,
    job.location && `Location: ${job.location}`,
    job.description && `Description:\n${job.description.slice(0, 8000)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function contextBlock(ctx) {
  const qs = ctx?.questions || [];
  const lines = qs.filter((q) => ctx.answers?.[q.id]).map((q) => `Q: ${q.question}\nA: ${ctx.answers[q.id]}`);
  return lines.length ? `\n\nThe applicant answered these about this specific job:\n${lines.join('\n\n')}` : '';
}

function parseJsonArray(text) {
  const m = text.match(/\[[\s\S]*\]/);
  try {
    return m ? JSON.parse(m[0]) : [];
  } catch {
    return [];
  }
}

// ---------- gap questions (asked right after you swipe right) ----------

export async function generateQuestions(profile, job) {
  const missing = heuristicQuestions(profile, job);
  if (!aiEnabled()) return missing;
  const text = await callClaude(
    SYSTEM,
    `${profileBlock(profile)}\n\n${jobBlock(job)}\n\nCompare the applicant to this job. Return a JSON array of at most 3 short questions whose answers would most strengthen this application — gaps the resume doesn't cover (a required skill, domain, or experience the posting stresses), or things to highlight. Each item: {"id": "q1", "question": "...", "placeholder": "a short example answer"}. If the resume already covers everything, return []. JSON only.`,
    600,
  );
  const ai = parseJsonArray(text)
    .filter((q) => q?.question)
    .slice(0, 3)
    .map((q, i) => ({ id: q.id || `q${i + 1}`, question: String(q.question), placeholder: q.placeholder ? String(q.placeholder) : '' }));
  return [...missing, ...ai].slice(0, 4);
}

// Without AI, only ask for screening facts the profile is missing.
export function heuristicQuestions(p, job) {
  const out = [];
  const d = `${job?.title} ${job?.description}`.toLowerCase();
  if (!p.yearsExperience && /\d\+?\s*years/.test(d)) out.push({ id: 'years', question: 'How many years of relevant experience do you have?', placeholder: '5', profileKey: 'yearsExperience' });
  if (!p.workAuthorized) out.push({ id: 'auth', question: 'Are you authorized to work in the US? (yes/no)', placeholder: 'yes', profileKey: 'workAuthorized' });
  if (!p.requireSponsorship) out.push({ id: 'sponsor', question: 'Will you need visa sponsorship? (yes/no)', placeholder: 'no', profileKey: 'requireSponsorship' });
  return out;
}

// ---------- documents ----------

export async function generateCoverLetter(profile, job, ctx) {
  if (aiEnabled()) {
    return callClaude(
      SYSTEM,
      `${profileBlock(profile)}\n\n${jobBlock(job)}${contextBlock(ctx)}\n\nWrite a cover letter of 180-260 words for this role. Open with why this role, connect two or three concrete things from the resume to the job's needs, close with a short call to action. Sign with the applicant's name.`,
      900,
    );
  }
  return templateCoverLetter(profile, job);
}

/** Returns a resume in a light markdown format (#, ##, -), or null when AI is off. */
export async function tailorResume(profile, job, ctx) {
  if (!aiEnabled() || !profile.resumeText) return null;
  return callClaude(
    SYSTEM,
    `${profileBlock(profile)}\n\n${jobBlock(job)}${contextBlock(ctx)}\n\nRewrite the resume for this job. Keep every fact true to the original — reorder, re-emphasize and reword bullets so the most relevant experience leads, and mirror the posting's terminology where the applicant genuinely has the skill. One page.
Format exactly:
# Full Name
contact line (email | phone | location | links)
## Summary
2-3 sentences
## Experience
### Title — Company (dates)
- bullet
## Skills
comma-separated
## Education
...`,
    2000,
  );
}

export async function generateAnswer(profile, job, question, examples = [], ctx) {
  if (aiEnabled()) {
    const ex = examples.length
      ? `\n\nPrevious answers the applicant wrote (match their voice):\n${examples.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')}`
      : '';
    return callClaude(
      SYSTEM,
      `${profileBlock(profile)}\n\n${jobBlock(job)}${contextBlock(ctx)}${ex}\n\nApplication question: "${question}"\n\nAnswer it in 40-150 words unless the question clearly wants a short factual answer, in which case answer in one line. If it cannot be answered truthfully from the information given, reply exactly: UNKNOWN`,
      500,
    ).then((t) => (t === 'UNKNOWN' ? '' : t));
  }
  return templateAnswer(profile, job, question);
}

// ---------- offline templates ----------

export function templateCoverLetter(p, job) {
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Applicant';
  const company = job?.company || 'your team';
  const role = job?.title || 'this role';
  const exp = p.yearsExperience ? `${p.yearsExperience} years of experience` : 'hands-on experience';
  const current = p.currentTitle ? ` In my current role as ${p.currentTitle}${p.currentCompany ? ` at ${p.currentCompany}` : ''}, I` : ' I';
  const skills = p.skills ? ` My core skills include ${p.skills}.` : '';
  return `Dear ${company} hiring team,

I'm excited to apply for ${role} at ${company}. I bring ${exp} building and shipping software, and the work described in this posting lines up closely with what I do best.
${current} focus on delivering reliable, well-tested features end to end, from design through deployment.${skills}

${p.summary ? p.summary + '\n\n' : ''}I'd welcome the chance to talk about how I can contribute to ${company}. Thank you for your time and consideration.

Sincerely,
${name}`;
}

export function templateAnswer(p, job, question) {
  const q = question.toLowerCase();
  const company = job?.company || 'your company';
  if (/why.*(interest|want|join|apply|us|company)/.test(q)) {
    return `I'm drawn to ${company} because the role matches the work I enjoy most and want to grow in.${p.summary ? ' ' + p.summary : ''}`;
  }
  if (/(tell us about|describe).*(yourself|background)/.test(q)) {
    return p.summary || `I'm a ${p.currentTitle || 'software developer'} with ${p.yearsExperience || 'several'} years of experience.`;
  }
  return '';
}
