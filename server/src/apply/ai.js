// Writing for applications. Uses a language model when one is set up: your own Ollama (OLLAMA_URL, e.g.
// http://hireme-ollama.internal:11434, OLLAMA_MODEL) or Claude (ANTHROPIC_API_KEY); otherwise plain templates.
// Claude only drafts open-ended answers and cover notes. Factual questions (work authorization,
// sponsorship, salary, start date, demographics…) are never sent here — the developer answers those.

const API_URL = 'https://api.anthropic.com/v1/messages';

export const aiEnabled = (env = process.env) => Boolean(env.OLLAMA_URL || env.ANTHROPIC_API_KEY);

/** A short text reply from whichever model is set up: Ollama first (it's yours and free to run), else Claude. */
export async function callModel(env, system, prompt, maxTokens) {
  if (!env.OLLAMA_URL) return callClaude(env, system, prompt, maxTokens);
  const res = await fetch(`${env.OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.OLLAMA_MODEL || 'qwen2.5:3b',
      stream: false,
      options: { num_predict: maxTokens, temperature: 0.3 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(Number(env.OLLAMA_TIMEOUT_MS) || 90_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return String((await res.json())?.message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}

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
      return await callModel(
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

I'd like to apply for the ${job.title} role. ${profile.headline ? `I'm ${/^[aeiou]/i.test(profile.headline.replace(/^(a|an) /i, '')) ? 'an' : 'a'} ${profile.headline.replace(/^(a|an) /i, '').split(' · ')[0]}` : 'I build software'}${profile.years ? ` with ${profile.years} years of experience` : ''}${profile.skills ? `, working mostly with ${profile.skills.split(',').slice(0, 4).join(',')}` : ''}.

${profile.bio ? `${profile.bio}\n\n` : ''}I'd love to talk about how I can help ${job.company}.

Thanks,
${profile.name || first}`;
}

const ANSWER_RULES = `You fill in a job application for the developer below, in their voice. Be optimistic but not over the top:
- Preferences and availability (relocating, office days, travel, hours, start date): lean yes, unless the facts say otherwise.
- Skills and experience: say yes when the resume shows it or something closely related; otherwise say so briefly and positively.
- Open questions: 2-4 plain, specific sentences grounded in the resume. No buzzwords, no exaggeration.
- Never misstate work authorization, visa sponsorship, citizenship, degrees, certifications, security clearance or criminal history:
  use the facts, and if they don't say, reply exactly UNKNOWN.
- Demographic questions (gender, race, veteran, disability): pick "prefer not to say" or reply UNKNOWN.
- Never invent employers, titles, numbers or credentials.`;

/**
 * Claude's answer to a form question, or '' (no API key, an error, or UNKNOWN). With `options`,
 * the reply is one of them, word for word.
 */
export async function draftAnswer(env, profile, email, job, question, short, options = []) {
  if (!aiEnabled(env)) return '';
  try {
    const choices = options.filter((o) => o && !/^(select|choose|--|please)/i.test(o));
    const t = await callModel(
      env,
      `${ANSWER_RULES}\n\n${SYSTEM}`,
      `${profileBlock(profile, email)}\n${profile.facts ? `\nFacts and form answers:\n${profile.facts}\n` : ''}\n${jobBlock(job)}\n\nApplication question: "${question}"\n\n${
        choices.length ? `Choose one of these options and reply with it exactly:\n${choices.map((c) => `- ${c}`).join('\n')}` : short ? 'Answer in one short line (yes/no questions start with Yes or No).' : 'Answer in 2-4 sentences.'
      }`,
      short || choices.length ? 120 : 400,
    );
    if (t === 'UNKNOWN' || /^unknown\b/i.test(t)) return '';
    return choices.length ? choices.find((c) => c.toLowerCase() === t.toLowerCase().replace(/^- /, '')) || '' : t;
  } catch {
    return '';
  }
}
