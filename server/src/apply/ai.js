// Writing for applications. Uses Claude when ANTHROPIC_API_KEY is set; otherwise plain templates.
// Claude only drafts open-ended answers and cover notes. Factual questions (work authorization,
// sponsorship, salary, start date, demographics…) are never sent here — the developer answers those.

const API_URL = 'https://api.anthropic.com/v1/messages';

export const aiEnabled = (env = process.env) => Boolean(env.ANTHROPIC_API_KEY);

/** Questions only the developer can answer truthfully. */
export const FACTUAL =
  /authori[sz]|sponsor|visa|citizen|green card|clearance|salary|compensation|\bpay\b|wage|relocat|start date|notice period|available to start|when can you start|years of|gender|pronoun|\bsex\b|race|ethnic|hispanic|latin|veteran|disabilit|criminal|convict|felony|\bage\b|18 years|over 18|degree|gpa|graduat|address|zip|postal|phone|referr|how did you hear|located|location|reside|live in|on-?site|in-?office|in person|commute|hybrid|time ?zone|hours|shift|travel|background check|drug|non-?compete|current(ly)? employ|notice/i;

/** `content` is a prompt string or an array of content blocks (text, document…). */
export async function callClaude(env, system, content, maxTokens) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

const SYSTEM = `You write job application material for the developer described below, in their voice.
Write in first person, plainly and specifically. Never invent employers, degrees, numbers, skills or
experience that are not in the developer's profile. No placeholders like [Company]. No preamble.`;

function profileBlock(p, email) {
  return [
    `Name: ${p.name}`,
    `Email: ${email}`,
    p.location && `Location: ${p.location}`,
    p.headline && `Headline: ${p.headline}`,
    p.years != null && `Years of experience: ${p.years}`,
    p.skills && `Skills: ${p.skills}`,
    p.bio && `About: ${p.bio}`,
    p.experience && `Experience:\n${p.experience.slice(0, 6000)}`,
    ...(p.saved_answers || []).slice(0, 8).map((a) => `Previously answered — Q: ${a.question} A: ${a.answer}`),
  ]
    .filter(Boolean)
    .join('\n');
}

const possessive = (name) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);
const jobBlock = (job) => `Company: ${job.company}\nRole: ${job.title}\n${job.description ? `Job post:\n${job.description.slice(0, 6000)}` : ''}`;

export async function coverNote(env, profile, email, job) {
  if (aiEnabled(env)) {
    try {
      return await callClaude(
        env,
        SYSTEM,
        `${profileBlock(profile, email)}\n\n${jobBlock(job)}\n\nWrite a short cover note (120-200 words) for this role: why this startup and role, two concrete things from the profile that fit the post, and a one-line close. Sign with the developer's name.`,
        700,
      );
    } catch {
      /* fall back to the template */
    }
  }
  const first = profile.name?.split(' ')[0] || '';
  return `Hi ${job.company} team,

I'd like to apply for the ${job.title} role. ${profile.headline ? `I'm a ${profile.headline.replace(/^(a|an) /i, '')}` : 'I build software'}${profile.years ? ` with ${profile.years} years of experience` : ''}${profile.skills ? `, working mostly with ${profile.skills.split(',').slice(0, 4).join(',')}` : ''}.

${profile.bio ? `${profile.bio}\n\n` : ''}I'd love to talk about how I can help ${job.company}.

Thanks,
${profile.name || first}`;
}

/** Drafts an answer. Returns '' when it shouldn't or can't. */
export async function draftAnswer(env, profile, email, job, question, short) {
  if (FACTUAL.test(question)) return factualAnswer(env, profile, job, question, short);
  if (!aiEnabled(env)) {
    if (/why.{0,40}(interest|want|join|apply|excite|us|company)/i.test(question))
      return `${possessive(job.company)} work lines up with what I want to build next${profile.headline ? ` as a ${profile.headline.replace(/^(a|an) /i, '')}` : ''}. ${profile.bio || ''}`.trim();
    return '';
  }
  try {
    const t = await callClaude(
      env,
      SYSTEM,
      `${profileBlock(profile, email)}\n\n${jobBlock(job)}\n\nApplication question: "${question}"\n\n${
        short ? 'Answer in one short line.' : 'Answer in 40-150 words.'
      } If it can't be answered truthfully from the profile, reply exactly: UNKNOWN`,
      400,
    );
    return t === 'UNKNOWN' || /^unknown\b/i.test(t) ? '' : t;
  } catch {
    return '';
  }
}

/**
 * Factual questions (relocation, on-site, location, salary, start date…) are answered only from the
 * developer's own facts and form answers — Claude picks the wording, never the fact. Without Claude,
 * the form rules cover the common ones and anything else goes back to the developer.
 */
async function factualAnswer(env, profile, job, question, short) {
  if (!aiEnabled(env) || !profile.facts) return '';
  if (/gender|pronoun|\bsex\b|race|ethnic|hispanic|latin|veteran|disabilit|criminal|convict|felony/i.test(question)) return '';
  try {
    const t = await callClaude(
      env,
      `You fill in job application forms for a developer using ONLY the facts below. If the facts don't answer the question, reply exactly: UNKNOWN. Never guess.`,
      `Facts about the developer:\n${profile.facts}\n\nCompany: ${job.company} — role: ${job.title}\n\nQuestion: "${question}"\n\n${short ? 'Answer in a few words (for a yes/no question, start with Yes or No).' : 'Answer in one or two sentences.'}`,
      120,
    );
    return t === 'UNKNOWN' || /^unknown\b/i.test(t) ? '' : t;
  } catch {
    return '';
  }
}
