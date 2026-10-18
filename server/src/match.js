// Finds the best saved answer for an application question, or a profile-derived
// answer for common screening questions.

const STOP = new Set(
  'a an and are as at be by can do does for from have how i if in is it me my of on or our please the this to us we what when where which who why will with you your would'.split(' '),
);

export function tokens(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ''));
}

export function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function bestSavedAnswer(question, answers, threshold = 0.34) {
  let best = null;
  for (const a of answers) {
    const score = similarity(question, a.question);
    if (!best || score > best.score) best = { ...a, score };
  }
  return best && best.score >= threshold ? best : null;
}

const yn = (v) => (v === true || v === 'yes' ? 'Yes' : v === false || v === 'no' ? 'No' : null);

/** Profile-backed answers for the screening questions nearly every form asks. */
export function profileAnswer(question, p) {
  const q = question.toLowerCase();
  if (/sponsor/.test(q)) return yn(p.requireSponsorship);
  if (/(legally )?(authori[sz]ed|eligible|right) to work/.test(q)) return yn(p.workAuthorized);
  if (/relocat/.test(q)) return yn(p.willingToRelocate);
  if (/(remote|hybrid|on-?site|in.office)/.test(q) && p.workArrangement) return p.workArrangement;
  if (/(salary|compensation|pay) (expectation|requirement|range)|expected (salary|compensation)|desired (salary|pay)/.test(q))
    return p.salaryExpectation || null;
  if (/notice period|(when|how soon).*(start|available)|start date/.test(q)) return p.noticePeriod || null;
  if (/years.*experience|experience.*years/.test(q) && p.yearsExperience) return String(p.yearsExperience);
  if (/how did you hear|where did you (hear|find|learn)/.test(q)) return p.referralSource || 'Company website';
  if (/linkedin/.test(q)) return p.linkedin || null;
  if (/github/.test(q)) return p.github || null;
  if (/portfolio|personal (web)?site|website/.test(q)) return p.portfolio || null;
  return null;
}
