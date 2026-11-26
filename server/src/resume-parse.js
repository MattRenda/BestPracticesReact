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

function findName(header, lines) {
  for (const line of [...header.slice(0, 4), ...lines.slice(0, 2)]) {
    const t = line.split(/\s[|•·]\s/)[0].trim();
    if (/[\d@/]|https?:|www\./i.test(t)) continue;
    const words = t.split(/\s+/);
    if (words.length < 2 || words.length > 5 || t.length > 50) continue;
    if (!words.every((w) => /^[\p{Lu}][\p{L}.'’-]*$/u.test(w) || /^\p{Lu}+$/u.test(w))) continue;
    return titleCase(t);
  }
  return '';
}

function findLocation(lines) {
  for (const line of lines) {
    for (const part of line.split(/\s*[|•·◦▪]\s*|\s{3,}/)) {
      if (/@|\d{3}|https?:|www\./.test(part)) continue;
      const m = part.match(/([\p{Lu}][\p{L}.'’-]*(?: [\p{Lu}][\p{L}.'’-]*){0,3}),\s*([A-Z]{2}|[A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/u);
      if (m && (STATE_SET.has(m[2]) || STATE_NAMES.test(m[2]))) return `${m[1]}, ${m[2]}`;
      if (/^remote$/i.test(part.trim())) return 'Remote';
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
export function parseResumeText(text, linkAnnotations = [], now = new Date()) {
  const lines = String(text)
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
    name: findName(header, lines),
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
export async function parseResume(buf, { env = process.env, log = console, now = new Date() } = {}) {
  let heur = {};
  let empty = false;
  try {
    const { text, links } = await pdfText(buf);
    empty = text.replace(/\s/g, '').length < 40;
    heur = parseResumeText(text, links.map((l) => (typeof l === 'string' ? l : l?.url)).filter(Boolean), now);
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
