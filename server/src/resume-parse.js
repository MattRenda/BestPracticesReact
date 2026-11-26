// Reads an uploaded resume PDF and suggests profile fields from it. The developer reviews the
// suggestions before anything is saved. Uses Claude when ANTHROPIC_API_KEY is set (it reads the PDF
// itself, layout and all); otherwise plain text heuristics. Either way, nothing is invented: a field
// we can't find stays empty.

import { extractLinks, extractText, getDocumentProxy } from 'unpdf';
import { extractSkills } from './importer.js';
import { aiEnabled, callClaude } from './apply/ai.js';

const FIELDS = ['name', 'headline', 'location', 'phone', 'years', 'skills', 'bio', 'experience', 'links'];

export async function pdfText(buf) {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  let links = [];
  try {
    links = (await extractLinks(pdf)).links || [];
  } catch {
    /* links are a bonus */
  }
  return { text: String(text || ''), links };
}

// ---------- ligatures ----------
// Many resume fonts draw "ft", "fi", "fl", "ff", "ffi", "ffl" as one glyph. When the PDF doesn't say
// which letters that glyph stands for, the text comes out as "Soware" or "prole". Known words are
// put back together; anything else is left as it is.

const LIGATURE_WORDS = `software microsoft after afternoon draft drafted drafting shift shifted shifting shifts swift swiftui craft crafted
crafting aircraft often fifty fifteen thrift uplift shaft profile profiles file files field fields final finally finance financial find finding
findings first fix fixed fixes fixing config configuration configurations configure configured certified certification certifications
certificate efficient efficiently efficiency office official officer benefit benefits specific specifically specification specifications
identify identified identifying verified verification modified modify modifying simplified notification notifications classification unified
refine refined refining define defined defining definition definitions confident confidence profit profitable scientific significant
significantly firebase firewall firm firmware figma fintech filter filters filtering infinite artificial satisfied satisfaction qualified
qualification qualifications diversified fiscal figure figured flow flows workflow workflows dataflow overflow tensorflow airflow webflow
flutter flexible flexibility flex flexbox influence influenced conflict conflicts reflect reflected flagship flag flags fleet flight flights
netflix fluent staff staffing effort efforts effective effectively offer offered offering offerings offline different difference differences
traffic buffer buffers coffee affiliate affiliates affordable effect effects handoff kickoff tariff sufficient difficult difficulty shuffle
platform fields fidelity fiber fibre filed filing fill filled filling finish finished finishing finalist fiction affinity amplify amplified
classified clarified justified rectified quantified simplify simplifying unify specified traffic efficient refactor refactored refactoring
fulfill fulfilled fulfillment`
  .split(/\s+/)
  .filter(Boolean);
const LIGATURES = ['ffi', 'ffl', 'ff', 'fi', 'fl', 'ft'];
const REAL = new Set(
  'ask ash utter eat ear ate aid art act add age ago air all and any are arm bed bet but can cat cut end eye for get hat her him his how ice ill its let lot low man men new not now old one our out own put ran red run saw say see set she sit six ten the too top two use was way who why win yes yet you ore oat ion ease ever lies late lags lex'.split(' '),
);
const BROKEN = (() => {
  const map = new Map();
  for (const w of LIGATURE_WORDS)
    for (const lig of LIGATURES) {
      let i = w.indexOf(lig);
      while (i >= 0) {
        const b = w.slice(0, i) + w.slice(i + lig.length);
        if (b.length >= 3 && !REAL.has(b) && !LIGATURE_WORDS.includes(b)) map.set(b, map.has(b) && map.get(b) !== w ? null : w);
        i = w.indexOf(lig, i + 1);
      }
    }
  return map;
})();
const matchCase = (src, word) => (src === src.toUpperCase() ? word.toUpperCase() : /^\p{Lu}/u.test(src) ? word[0].toUpperCase() + word.slice(1) : word);

export function fixLigatures(text) {
  return String(text)
    .normalize('NFKC') // ﬁ → fi, ﬂ → fl…
    .replace(/[-�]/g, '') // glyphs with no letters behind them
    .replace(/\p{L}+/gu, (w) => {
      const fixed = BROKEN.get(w.toLowerCase());
      return fixed ? matchCase(w, fixed) : w;
    });
}

// ---------- sections ----------

const SECTIONS = [
  ['summary', /^(professional |career |personal )?(summary|profile|about( me)?|objective|overview)$/i],
  ['experience', /^((professional|work|relevant|employment|career) )?(experience|history|employment( history)?)$|^work history$/i],
  ['projects', /^((personal|selected|side|notable) )?projects$/i],
  ['education', /^education( (and|&) (training|certifications?))?$/i],
  ['skills', /^((technical|core|key|professional) )?(skills|competencies|technologies|tech stack|tools( (and|&) technologies)?)( (and|&) (tools|technologies|interests))?$/i],
  ['other', /^(certifications?|awards|honors|publications|volunteer(ing| experience)?|interests|languages|activities|references|leadership)$/i],
];

function sectionOf(line) {
  const t = line.replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim();
  if (t.length > 45) return null;
  for (const [key, re] of SECTIONS) if (re.test(t)) return key;
  return null;
}

function splitSections(lines) {
  const out = { header: [] };
  let cur = 'header';
  for (const line of lines) {
    const s = sectionOf(line);
    if (s) {
      cur = s;
      out[cur] ??= [];
      continue;
    }
    (out[cur] ??= []).push(line);
  }
  return out;
}

// ---------- dates ----------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
const POINT = `(?:${MONTH}\\s*\\d{4}|\\d{1,2}/(?:\\d{1,2}/)?\\d{4}|\\d{4})`;
const RANGE = new RegExp(`(${POINT})\\s*(?:[-–—]|to|until)\\s*(${POINT}|present|current|now|today)`, 'gi');
export const hasDateRange = (s) => new RegExp(RANGE.source, 'i').test(s);

/** Month number (year*12 + month). An end date counts through its month; a bare end year through December. */
function monthIndex(token, now, end = false) {
  const t = token.toLowerCase().trim();
  if (/present|current|now|today/.test(t)) return now.getFullYear() * 12 + now.getMonth();
  let m = t.match(/^([a-z]+)\.?\s*(\d{4})$/);
  if (m) return Number(m[2]) * 12 + (MONTHS[m[1].slice(0, 4)] ?? MONTHS[m[1].slice(0, 3)] ?? 0);
  m = t.match(/^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})$/);
  if (m) return Number(m[2]) * 12 + Math.min(11, Math.max(0, Number(m[1]) - 1));
  m = t.match(/^(\d{4})$/);
  return m ? Number(m[1]) * 12 + (end ? 11 : 0) : null;
}

/** Years worked, from the date ranges in the experience section. Overlapping jobs count once. */
export function yearsFrom(text, now = new Date()) {
  const spans = [];
  for (const m of String(text).matchAll(RANGE)) {
    const a = monthIndex(m[1], now);
    const endMonth = monthIndex(m[2], now, true);
    const b = endMonth == null ? null : endMonth + 1; // through the end month
    if (a == null || b == null || b < a || a < 1950 * 12 || b > now.getFullYear() * 12 + 13) continue;
    spans.push([a, b]);
  }
  if (!spans.length) return null;
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let [s, e] = spans[0];
  for (const [a, b] of spans.slice(1)) {
    if (a <= e) e = Math.max(e, b);
    else (total += e - s), ([s, e] = [a, b]);
  }
  total += e - s;
  return Math.max(0, Math.round(total / 12));
}

// ---------- fields ----------

const STATES =
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY ON BC QC AB';
const STATE_SET = new Set(STATES.split(' '));
const STATE_NAMES =
  /^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|ontario|british columbia)$/i;

const titleCase = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : s);

const STATE_ALT = [
  ...STATE_NAMES.source.slice(2, -2).split('|').map((n) => n.replace(/\b[a-z]/g, (c) => c.toUpperCase())), // longest first: "West Virginia" before "VA"
  ...STATES.split(' '),
].join('|');
const CITY_STATE = new RegExp(`([\\p{Lu}][\\p{L}.'’-]*(?: [\\p{Lu}][\\p{L}.'’-]*){0,2}),?\\s+(${STATE_ALT})(?![\\p{L}])`, 'u');
const CITY_STATE_I = new RegExp(CITY_STATE.source, 'iu');
const looksLikePlace = (t) => /\bremote\b/i.test(t) || CITY_STATE_I.test(t.replace(/\b\d{5}(-\d{4})?\b/g, '').trim());
const NOT_NAME =
  /\b(engineer(ing)?|developer|programmer|architect|designer|manager|analyst|consultant|scientist|software|stack|resume|curriculum|vitae|summary|profile|experience|contact|portfolio|university|college|inc|llc|corp)\b/i;
const NAME_FILLER = /^(resume|cv|curriculum|vitae|final|updated?|new|copy|draft|latest|v\d+|pdf|doc|docx)$/i;

/** "M A T T H E W   R E N D A" → "MATTHEW RENDA" */
function unspace(line) {
  if (!/^(\p{L} +){3,}\p{L}$/u.test(line.trim())) return line;
  const words = line.trim().split(/ {2,}/);
  return words.map((w) => w.replace(/ /g, '')).join(' ');
}

/** A name guessed from a file like "MatthewRenda_Resume_2023 (2).pdf". */
export function nameFromFile(fileName) {
  const words = String(fileName || '')
    .replace(/(\.(pdf|docx?))+$/i, '')
    .replace(/\(\d+\)/g, ' ')
    .replace(/[_\-.]+/g, ' ')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .split(/\s+/)
    .filter((w) => /^\p{L}[\p{L}'’]+$/u.test(w) && !NAME_FILLER.test(w));
  return words.length >= 2 && words.length <= 4 ? words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') : '';
}

function findName(header, lines, { fileName, email } = {}) {
  const hints = [...nameFromFile(fileName).toLowerCase().split(' '), String(email || '').split('@')[0].toLowerCase()].filter((w) => w.length > 1);
  const overlap = (t) => t.toLowerCase().split(/\s+/).filter((w) => w.replace(/\.$/, '').length > 1 && hints.some((h) => h.includes(w.replace(/\.$/, '')))).length;
  let best = null;
  for (const raw of [...header.slice(0, 12), ...lines.slice(0, 3)]) {
    const t = unspace(raw).split(/\s[|•·]\s/)[0].trim();
    if (/[\d@/]|https?:|www\./i.test(t) || looksLikePlace(t) || NOT_NAME.test(t)) continue;
    const words = t.split(/\s+/);
    if (words.length < 2 || words.length > 5 || t.length > 50) continue;
    if (!words.every((w) => /^[\p{Lu}][\p{L}.'’-]*$/u.test(w))) continue;
    const score = overlap(t);
    if (!best || score > best.score) best = { t, score };
    if (!hints.length) break; // nothing to compare with: the first name-shaped line wins
  }
  const fromFile = nameFromFile(fileName);
  if (best && (best.score > 0 || !fromFile)) return titleCase(best.t);
  return fromFile; // the file name ("MatthewRenda_Resume.pdf") beats a line that shares nothing with it
}

function findLocation(lines) {
  for (const line of lines) {
    for (const raw of line.split(/\s*[|•·◦▪]\s*|\s{3,}/)) {
      const part = raw.replace(/\b\d{5}(-\d{4})?\b/g, '').trim();
      if (/@|https?:|www\./.test(part)) continue;
      const m = part.match(CITY_STATE);
      if (m && !NOT_NAME.test(m[1])) return `${m[1]}, ${m[2]}`;
      if (/^remote$/i.test(part)) return 'Remote';
    }
  }
  return '';
}

const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

function findLinks(text, annotations) {
  const all = [...annotations, ...(String(text).match(/(?:https?:\/\/|www\.)[^\s|•·,;)]+|\b(?:github\.com|linkedin\.com|gitlab\.com)\/[^\s|•·,;)]+/gi) || [])]
    .map((u) => u.replace(/[.,;:]+$/, ''))
    .filter((u) => !/^mailto:|^tel:/i.test(u));
  const norm = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
  const out = {};
  for (const u of all) {
    if (/github\.com\/[\w-]+/i.test(u)) out.github ??= norm(u.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+/i)[0]);
    else if (/linkedin\.com\/in\/[\w%-]+/i.test(u)) out.linkedin ??= norm(u.match(/(?:https?:\/\/)?(?:[\w]+\.)?linkedin\.com\/in\/[\w%-]+/i)[0]);
    else if (/^(https?:\/\/|www\.)/i.test(u) && !/linkedin\.com|github\.com|google\.com|mailto/i.test(u)) out.portfolio ??= norm(u);
  }
  return out;
}

/** "Languages: Go, Python" / "React, Express, HTML/CSS" → individual skills, keeping wrapped lines together. */
function skillsFromSection(lines) {
  const parts = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/^[•\-*▪◦]\s*/, '').replace(/^[\w &/]{2,30}:\s*/, (m) => (/[,;]/.test(m) ? m : ''));
    const prev = lines[i - 1];
    const wrapped =
      prev && !/[,;:]\s*$/.test(prev) && /[,|•]/.test(prev) && !/[,|•:]/.test(raw) && raw.trim().split(/\s+/).length <= 3 && parts.length;
    if (wrapped) parts[parts.length - 1] += ` ${line.trim()}`;
    else parts.push(line);
  });
  const out = [];
  for (const chunk of parts)
    for (const s of chunk.split(/\s*(?:[,;|•·]|\/(?!\w+\s*$)(?=\s*\p{Lu})|\s\/\s|\band\b)\s*/u)) {
      const t = s.replace(/\(.*?\)/g, '').replace(/[.]+$/, '').trim();
      if (t && t.length <= 30 && t.split(/\s+/).length <= 4 && !/^\p{Ll}+ \p{Ll}+ \p{Ll}+/u.test(t)) out.push(t);
    }
  return out;
}

const SAME = (a) => a.toLowerCase().replace(/\.js$|\s+/g, '').replace(/^postgresql$/, 'postgres').replace(/^golang$/, 'go');

function mergeSkills(...lists) {
  const seen = new Set();
  const out = [];
  for (const s of lists.flat()) {
    const k = SAME(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.slice(0, 20);
}

const TITLE_WORD =
  /\b(engineer(ing)?|developer|programmer|architect|lead|manager|designer|scientist|analyst|consultant|cto|ceo|founder|co-?founder|director|administrator|devops|sre|intern|specialist|head of|vp)\b/i;

function titleFrom(line) {
  const noDates = line.replace(new RegExp(RANGE.source, 'gi'), '').replace(/\(\s*\)/g, '');
  const parts = noDates.split(/\s+[—–-]\s+|\s*[|,·•]\s*|\s+at\s+|\s+@\s+/);
  const t = parts.find((x) => TITLE_WORD.test(x) && x.split(/\s+/).length <= 7);
  return t ? t.trim() : '';
}

/** Experience text in the profile's format: entry lines as-is, details as "- " bullets. */
function formatExperience(lines, education) {
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/^[•\-*▪◦]\s*/, '').trim();
    if (!line) continue;
    const bullet = /^[•\-*▪◦]/.test(raw.trim());
    const datesOnly = hasDateRange(line) && line.replace(new RegExp(RANGE.source, 'gi'), '').replace(/[\s,|·•()-]/g, '').length < 3;
    const entry = !bullet && (hasDateRange(line) || (TITLE_WORD.test(line) && line.split(/\s+/).length <= 10 && !/\.$/.test(line)));
    if (datesOnly && out.length && !out[out.length - 1].startsWith('- ')) out[out.length - 1] += ` · ${line}`;
    else if (entry) out.push(line);
    else if (out.length && out[out.length - 1].startsWith('- ') && /^\p{Ll}/u.test(line)) out[out.length - 1] += ` ${line}`; // wrapped bullet
    else out.push(`- ${line}`);
  }
  if (education?.length) out.push('', 'Education', ...education.map((l) => l.replace(/^[•\-*▪◦]\s*/, '').trim()).filter(Boolean));
  return out.join('\n').trim().slice(0, 6000);
}

/** Suggested profile fields from a resume's text. Fields it can't find are left out. */
export function parseResumeText(text, linkAnnotations = [], now = new Date(), hints = {}) {
  const lines = fixLigatures(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) return {};
  const sec = splitSections(lines);
  const header = sec.header.slice(0, 12);
  const expLines = [...(sec.experience || []), ...(sec.projects || [])];
  const sectionSkills = skillsFromSection(sec.skills || []);
  const skills = mergeSkills(sectionSkills, extractSkills(lines.join('\n'), 20));
  const phone = (header.join(' ').match(PHONE) || lines.slice(0, 15).join(' ').match(PHONE) || [''])[0];
  const title = (sec.experience || []).map(titleFrom).find(Boolean) || '';
  const out = {
    name: findName(header, lines, hints),
    location: findLocation(header.length ? header : lines.slice(0, 6)),
    phone: phone.trim(),
    links: findLinks(header.join(' ') + '\n' + lines.join(' '), linkAnnotations),
    skills: skills.join(', '),
    bio: (sec.summary || []).join(' ').slice(0, 1500),
    experience: expLines.length ? formatExperience(expLines, sec.education) : '',
    years: yearsFrom((sec.experience || lines).join('\n'), now),
    headline: title ? [title, skills.slice(0, 3).join(', ')].filter(Boolean).join(' · ').slice(0, 120) : '',
  };
  return clean(out);
}

/** Keeps only non-empty, well-typed fields. */
export function clean(p) {
  const out = {};
  for (const k of FIELDS) {
    const v = p?.[k];
    if (k === 'years') {
      const n = Number(v);
      if (v != null && v !== '' && Number.isFinite(n) && n >= 0 && n <= 60) out.years = Math.round(n);
    } else if (k === 'links') {
      const l = {};
      for (const key of ['github', 'linkedin', 'portfolio']) if (typeof v?.[key] === 'string' && /^https?:\/\/\S+$/.test(v[key])) l[key] = v[key];
      if (Object.keys(l).length) out.links = l;
    } else if (k === 'skills' && Array.isArray(v)) {
      if (v.length) out.skills = v.map(String).join(', ');
    } else if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

const AI_SYSTEM = `You read resumes and extract profile fields as JSON. Only use what the resume says; never guess or
invent. Leave a field out when the resume doesn't state it.`;

async function parseWithClaude(env, buf) {
  const reply = await callClaude(
    env,
    AI_SYSTEM,
    [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(buf).toString('base64') } },
      {
        type: 'text',
        text: `Return only a JSON object with these keys:
name, location ("City, ST"), phone,
headline (most recent job title, then " · " and their 3 main technologies, under 100 characters),
years (whole number of years of professional work, from the job dates),
skills (array of technologies and practices, most important first, at most 20),
bio (their summary section, or "" if there isn't one),
experience (each job as "Title — Company · dates" on its own line followed by "- " bullet lines, then a line "Education" and their education lines),
links ({"github","linkedin","portfolio"} full URLs, only ones that appear).`,
      },
    ],
    3000,
  );
  const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  return clean(JSON.parse(json));
}

/** Suggested fields for a resume PDF, plus `empty` when the PDF has no text (a scanned image). */
/** `hints`: { fileName, email } help find the name when the PDF's layout hides it. */
export async function parseResume(buf, { env = process.env, log = console, now = new Date(), hints = {} } = {}) {
  let heur = {};
  let empty = false;
  try {
    const { text, links } = await pdfText(buf);
    empty = text.replace(/\s/g, '').length < 40;
    heur = parseResumeText(text, links.map((l) => (typeof l === 'string' ? l : l?.url)).filter(Boolean), now, hints);
  } catch (e) {
    log.warn?.(`resume text: ${e.message}`);
  }
  if (aiEnabled(env)) {
    try {
      const ai = await parseWithClaude(env, buf);
      return { fields: { ...heur, ...ai, links: { ...heur.links, ...ai.links } }, empty: false, source: 'ai' };
    } catch (e) {
      log.warn?.(`resume via Claude: ${e.message}`);
    }
  }
  return { fields: heur, empty, source: 'text' };
}
