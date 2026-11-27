// Answers for the extra questions on application forms, so a right swipe is the end of it.
//
// The stance is "optimistic, not over the top": lean yes on preferences and availability (relocation,
// office days, travel, start dates), say yes to skills the resume shows or something close to it, and
// write short, grounded answers to open-ended questions. A few things stay strictly accurate because a
// wrong answer can cost the job or cause legal trouble: work authorization, sponsorship, degrees,
// clearance and criminal history. Demographic questions get "prefer not to say".

import { extractSkills } from '../importer.js';

const lc = (s) => String(s || '').toLowerCase();
const YES_NO_START = /^(are|do|does|did|have|has|can|could|will|would|is|were|was|should|may)\b/;

// Related technologies: knowing one counts as "close enough" for a yes on another.
const FAMILIES = [
  ['javascript', 'typescript', 'node', 'react', 'vue', 'angular', 'svelte', 'next', 'express', 'frontend', 'front-end', 'web'],
  ['python', 'django', 'flask', 'fastapi', 'pandas'],
  ['aws', 'azure', 'gcp', 'google cloud', 'cloud', 'serverless', 'lambda'],
  ['sql', 'postgres', 'postgresql', 'mysql', 'sqlite', 'database', 'databases', 'mongodb', 'redis', 'dynamodb'],
  ['docker', 'kubernetes', 'k8s', 'terraform', 'ci/cd', 'ci', 'devops', 'azure devops', 'github actions', 'infrastructure'],
  ['jest', 'testing', 'react testing library', 'cypress', 'playwright', 'unit tests', 'tdd'],
  ['agile', 'scrum', 'lean', 'kanban'],
  ['llm', 'llms', 'ai', 'ml', 'machine learning', 'openai', 'gpt', 'pytorch', 'tensorflow', 'generative ai', 'genai'],
  ['ios', 'android', 'mobile', 'react native', 'swift', 'kotlin', 'flutter'],
  ['go', 'golang', 'rust', 'java', 'c#', '.net', 'c++', 'ruby', 'rails', 'php'],
  ['rest', 'api', 'apis', 'graphql', 'grpc', 'microservices'],
];

/** Everything the profile says, lowercased, for "does the resume show X?" checks. */
function resumeText(p) {
  return lc([p.headline, p.skills, p.bio, p.experience].filter(Boolean).join('\n'));
}

/** Technologies or practices a question asks about. */
function topicsOf(question) {
  const found = extractSkills(question, 10).map(lc);
  const extra = [...lc(question).matchAll(/\b(sql|apis?|graphql|ci\/cd|microservices|llms?|genai|generative ai|machine learning|devops|cloud|testing|agile|scrum|startups?|saas|b2b|fintech|healthcare|payments|security|kubernetes|docker)\b/g)].map((m) => m[1]);
  return [...new Set([...found, ...extra])];
}

/** 'yes' (shown on the resume), 'close' (something related is), or 'no'. */
function evidence(p, topics) {
  if (!topics.length) return 'close';
  const text = resumeText(p);
  if (topics.some((t) => text.includes(t))) return 'yes';
  if (topics.some((t) => FAMILIES.some((f) => f.includes(t) && f.some((x) => x !== t && text.includes(x))))) return 'close';
  if (topics.every((t) => /startups?|saas|b2b/.test(t))) return 'close';
  return 'no';
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const isPlaceholder = (o) => !clean(o) || /^(select|choose|--|please|pick)/i.test(clean(o));

/** Picks the option that best matches a wanted answer, or the most positive one. */
function choose(options, wanted, { positive = true } = {}) {
  const opts = options.filter((o) => !isPlaceholder(o));
  if (!opts.length) return wanted || '';
  const w = lc(wanted);
  if (w) {
    const exact = opts.find((o) => lc(o) === w) || opts.find((o) => lc(o).startsWith(w)) || opts.find((o) => w.length > 2 && lc(o).includes(w));
    if (exact) return exact;
  }
  if (!positive) return '';
  return (
    opts.find((o) => /^(yes|i agree|agree|i do|i am|i have|absolutely|definitely|sure)\b/i.test(clean(o))) ||
    opts.find((o) => /\b(interested|open|willing|flexible|available|immediately|comfortable)\b/i.test(o)) ||
    opts[0]
  );
}

const DECLINE_OPT = /decline|prefer not|don.?t wish|do not wish|not to (say|answer|disclose|self)|choose not/i;

function firstName(p) {
  return String(p.name || '').trim().split(/\s+/)[0] || '';
}

/** A few grounded sentences about the developer, tuned to the job when the skills overlap. */
function aboutMe(p, job) {
  const skills = String(p.skills || '').split(',').map((s) => s.trim()).filter(Boolean);
  const jobText = lc(`${job?.title} ${job?.description}`);
  const overlap = skills.filter((s) => jobText.includes(lc(s))).slice(0, 3);
  const lead = (overlap.length ? overlap : skills.slice(0, 3)).join(', ');
  const headline = String(p.headline || 'software engineer').split('·')[0].trim().replace(/^(a|an) /i, '');
  const firstBullet = String(p.experience || '')
    .split('\n')
    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
    .find((l) => l.length > 30 && /^[A-Z]/.test(l) && !/[—–|]/.test(l));
  const title = /^[A-Z][a-z]+( [A-Z][a-z]+)*$/.test(headline) ? headline.toLowerCase() : headline;
  const parts = [`I'm a ${title}${p.years ? ` with ${p.years} years of experience` : ''}${lead ? `, working mostly with ${lead}` : ''}.`];
  if (p.bio) parts.push(clean(p.bio).split(/(?<=\.)\s/).slice(0, 2).join(' '));
  else if (firstBullet) {
    const verb = firstBullet.split(' ')[0];
    const rest = firstBullet.charAt(0).toLowerCase() + firstBullet.slice(1).replace(/\.?$/, '.');
    parts.push(/ed$|^(Led|Built|Ran|Wrote|Made|Took|Grew|Drove|Won)$/.test(verb) ? `Recently I ${rest}` : `Right now I ${rest}`);
  }
  return parts.join(' ');
}

function openEnded(question, p, job) {
  const q = lc(question);
  const company = job?.company || 'your team';
  if (/\bai\b|llm|chatgpt|copilot|claude|gpt|cursor|automation/.test(q))
    return `I use AI assistants as part of everyday work: drafting tests and boilerplate, exploring unfamiliar APIs, and reviewing my own changes before a PR. I treat what they produce as a first draft and verify it, which lets me spend more time on design and less on busywork.`;
  if (/learn(ed|ing)? (recently|lately)|recently learned|currently learning|what are you learning|teach(ing)? yourself/.test(q)) {
    const skills = String(p.skills || '').split(',').map((x) => x.trim()).filter(Boolean);
    const jobSkill = extractSkills(`${job?.title} ${job?.description}`, 6).find((k) => !lc(p.skills).includes(lc(k)));
    return `Lately I've been going deeper on AI-assisted development and ${jobSkill || skills[0] || 'modern web tooling'}, and folding what I learn into real work right away. It's changed how quickly I can prototype and ship.`;
  }
  if (/anything else|additional (info|information|comments)|cover letter|note to/.test(q)) return `Thanks for considering my application. I'd be glad to talk about how I can help ${company}.`;
  if (/why.{0,40}(interest|want|join|apply|excite|us|company|role|position|here)|excit|interest(s|ed) you|draws? you|appeals? to you|motivat|attract/.test(q))
    return `${company}'s work lines up with what I want to build next, and a small team where I can own things end to end is exactly where I do my best work. ${aboutMe(p, job)}`;
  if (/project|proud|accomplish|built|challenge|problem you solved|example of/.test(q))
    return `${aboutMe(p, job)} I like shipping in small, steady steps, measuring what changed, and keeping the codebase easy for the next person.`;
  if (/salary|compensation/.test(q)) return '';
  return aboutMe(p, job);
}

/**
 * Answers one form question. `options` are the choices for a dropdown or radio group (empty for text).
 * Returns '' only for the few things HireMe won't answer without the developer.
 */
export function autoAnswer({ question, options = [], short = true, profile: p, defaults: d, job }) {
  const q = lc(question);
  const yes = (positive = true) => (options.length ? choose(options, positive ? 'yes' : 'no') : positive ? 'Yes' : 'No');

  // Demographics: always decline
  if (/gender|pronoun|\bsex\b|race|ethnic|hispanic|latin[oax]|veteran|disabilit|sexual orientation|transgender/.test(q))
    return options.length ? options.find((o) => DECLINE_OPT.test(o)) || '' : 'Prefer not to say';

  // Strictly accurate
  if (/authori[sz]|eligible to work|legally (able|permitted)|right to work/.test(q)) return p.work_authorized ? yes(p.work_authorized === 'yes') : '';
  if (/sponsor|visa/.test(q)) return p.needs_sponsorship ? yes(p.needs_sponsorship === 'yes') : '';
  if (/citizen|green card|permanent resident|immigration/.test(q)) {
    // Say only what they've told HireMe: authorized, and whether they need sponsorship.
    if (p.work_authorized !== 'yes' || p.needs_sponsorship !== 'no') return '';
    if (!options.length) return "Authorized to work in the US; I don't need sponsorship";
    return options.find((o) => /authori[sz]ed.*(without|no|not).*sponsor|do(es)? not (require|need) sponsorship|citizen or (permanent|green)|(permanent|green card).{0,20}or.{0,20}citizen/i.test(o)) || '';
  }
  if (/criminal|convict|felony|misdemeanor/.test(q)) return options.length ? options.find((o) => DECLINE_OPT.test(o)) || '' : '';
  if (/clearance/.test(q)) return options.length ? choose(options, 'no', { positive: false }) || choose(options, 'none', { positive: false }) || '' : 'None';
  if (/\b(bachelor|master|ph\.?d|degree|diploma|graduat|gpa)\b/.test(q)) {
    const text = resumeText(p);
    const has = /\b(b\.?s\.?|b\.?a\.?|bachelor|m\.?s\.?|master|ph\.?d|degree)\b/.test(text);
    if (/gpa/.test(q)) return '';
    if (YES_NO_START.test(q) || options.length) return yes(has);
    const line = String(p.experience || '').split('\n').find((l) => /\b(b\.?s\.?|b\.?a\.?|bachelor|master|degree|university|college)\b/i.test(l));
    return line ? clean(line.replace(/^[-•*]\s*/, '')) : '';
  }

  // Agreements and simple facts
  if (/18 (years|or older)|over 18|at least 18|legal (working )?age/.test(q)) return yes(true);
  if (/background check|drug (test|screen)|consent|agree|acknowledge|certify|confirm that|accurate/.test(q)) return yes(true);
  if (/previously (applied|worked|been employed)|former employee|worked (here|for us) before|currently employed (here|by us)|related to anyone|referred by|referral|who referred/.test(q))
    return options.length ? choose(options, 'no', { positive: false }) || yes(false) : /who|name/.test(q) ? '' : 'No';
  if (/how did you (hear|find|learn)|where did you (hear|find|see)/.test(q)) return options.length ? choose(options, 'job board', { positive: false }) || choose(options, 'online', { positive: false }) || choose(options, 'other', { positive: false }) || options.filter((o) => !isPlaceholder(o)).at(-1) || '' : 'Job board';
  if (/preferred (first )?name|nickname|what should we call you/.test(q)) return firstName(p);

  // Preferences and availability: lean yes (unless the developer said otherwise on their profile)
  if (/relocat/.test(q)) return yes(d.relocate !== 'no');
  if (/in[- ]?(the )?office|on[- ]?site|onsite|in[- ]person|hybrid|commut|days (a|per|each) week/.test(q)) return yes(d.onsite !== 'no');
  if (/travel|time ?zone|overlap|hours|shift|weekend|overtime|on[- ]?call|work schedule|full[- ]time|fast[- ]paced|startup environment|ambiguity/.test(q) && (YES_NO_START.test(q) || options.length)) return yes(true);
  if (/notice period|start date|when can you start|available to start|earliest (start|date)|availability/.test(q)) return options.length ? choose(options, 'immediately', { positive: false }) || choose(options, d.notice, { positive: false }) || choose(options, '2 weeks') : d.notice;
  if (/salary|compensation|pay (range|expectation)|desired pay|expected (pay|comp)/.test(q)) {
    if (!options.length) return d.salary;
    const want = p.salary_min || 0;
    const nums = options.map((o) => ({ o, n: Number((o.match(/\$?\s?(\d[\d,]*)\s*(k|K)?/) || [])[1]?.replace(/,/g, '') || NaN) * ((o.match(/\d\s*(k|K)\b/) && 1000) || 1) }));
    const fit = want && nums.find((x) => x.n >= want * 0.9);
    return fit ? fit.o : choose(options, 'flexible', { positive: false }) || options.filter((o) => !isPlaceholder(o))[Math.floor(options.filter((o) => !isPlaceholder(o)).length / 2)] || '';
  }
  if (/(are|do) you (currently )?(located|based|live|living|reside|residing)|where (are you|do you) (located|based|live)/.test(q) && !/relocat|willing/.test(q)) {
    if (!YES_NO_START.test(q) && !options.length) return p.location || '';
    const place = lc(p.location);
    const city = place.split(',')[0].trim();
    const local = (city && q.includes(city)) || /\b(us|u\.s\.|usa|united states|america)\b/.test(q);
    // Not local, but open to moving there: say so rather than a flat no.
    if (!local && d.relocate !== 'no' && !options.length) return `No, I'm based in ${p.location}, and I'm open to relocating`;
    return yes(local);
  }

  // Seniority / proficiency scales
  if (options.length && options.some((o) => /\b(beginner|basic|novice|intermediate|advanced|expert|proficient)\b/i.test(o))) {
    const e = evidence(p, topicsOf(question));
    const want = e === 'yes' ? 'advanced' : e === 'close' ? 'intermediate' : 'beginner';
    return choose(options, want, { positive: false }) || choose(options, e === 'yes' ? 'proficient' : 'basic');
  }
  if (options.length && options.some((o) => /\b(junior|mid|senior|staff|principal|lead)\b/i.test(o)) && /level|seniority/.test(q)) {
    const y = Number(p.years) || 0;
    return choose(options, y >= 6 ? 'senior' : y >= 3 ? 'mid' : 'junior');
  }

  // Years with something
  if (/how many years|years of (professional )?experience|years.{0,30}experience|experience.{0,15}years/.test(q)) {
    const e = evidence(p, topicsOf(question));
    const total = Number(p.years) || 1;
    const n = e === 'yes' ? total : e === 'close' ? Math.max(1, Math.round(total / 2)) : 1;
    if (!options.length) return String(n);
    const ranged = options.filter((o) => !isPlaceholder(o)).find((o) => {
      const m = o.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
      if (m) return n >= Number(m[1]) && n <= Number(m[2]);
      const plus = o.match(/(\d+)\s*\+/);
      return plus && n >= Number(plus[1]);
    });
    return ranged || choose(options, String(n));
  }

  // "Do you have experience with X?": yes when the resume shows it or something close
  if (/experience (with|in|using)|familiar|proficien|worked with|knowledge of|comfortable (with|using)|used .{0,20}before|hands[- ]on/.test(q) && (YES_NO_START.test(q) || options.length)) {
    const e = evidence(p, topicsOf(question));
    if (e !== 'no') return yes(true);
    const soft = { positive: false };
    return options.length ? choose(options, 'some', soft) || choose(options, 'familiar', soft) || choose(options, 'learning', soft) || yes(false) : 'No, but I pick up new tools quickly';
  }

  // Anything else with choices: the most positive one that fits
  if (options.length) return choose(options, '');

  // Yes/no in a text box
  if (YES_NO_START.test(q) && short) return 'Yes';

  // Links
  if (/url|link|website|profile|portfolio/.test(q)) return p.links?.portfolio || p.links?.github || p.links?.linkedin || '';

  return short ? clean(aboutMe(p, job).split(/(?<=\.)\s/)[0]) : openEnded(question, p, job);
}
