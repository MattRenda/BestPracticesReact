// Applying through a startup's own applicant tracking system, with the API key the startup gave HireMe.
// These are the official "custom careers page" endpoints Greenhouse, Lever and Ashby offer for exactly this,
// so there's no form, no browser and no CAPTCHA: the application lands in the startup's ATS.
//
//   Greenhouse  POST boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}   Job Board API key (Basic auth)
//   Lever       POST api.lever.co/v0/postings/{site}/{id}?key=…             Postings API key
//   Ashby       POST api.ashbyhq.com/applicationForm.submit                   API key with candidatesWrite (Basic)
//
// Questions the job asks are answered the same way as on forms (saved answers first, then HireMe's rules);
// a required one that can't be answered comes back to the developer.

export const ATS_SYSTEMS = ['greenhouse', 'lever', 'ashby'];

const basic = (key) => `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
const SKIP_GH = new Set(['first_name', 'last_name', 'email', 'phone', 'resume', 'resume_text', 'cover_letter', 'cover_letter_text']);

export function createAtsApi({ fetchImpl = fetch } = {}) {
  async function call(url, init = {}) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* some success responses have no JSON body */
    }
    return { status: res.status, ok: res.ok, body };
  }

  /** Checks a key and board before saving them. Returns an error message, or '' when they work. */
  async function verify({ system, key, board }) {
    if (!ATS_SYSTEMS.includes(system)) return 'Pick Greenhouse, Lever or Ashby';
    if (!key || key.length < 8) return 'Paste the API key';
    if (!board) return 'Add your job board name';
    if (system === 'ashby') {
      const r = await call('https://api.ashbyhq.com/apiKey.info', { method: 'POST', headers: { authorization: basic(key), 'content-type': 'application/json' }, body: '{}' });
      if (r.status === 401 || r.body?.success === false) return 'Ashby didn’t accept that API key';
      const jobs = await call(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`);
      if (!jobs.ok) return `There’s no Ashby job board called “${board}”`;
      return '';
    }
    if (system === 'greenhouse') {
      const r = await call(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs`);
      return r.ok ? '' : `There’s no Greenhouse job board called “${board}”`;
    }
    const r = await call(`https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json&limit=1`);
    return r.ok ? '' : `There’s no Lever job site called “${board}”`;
  }

  /**
   * Submits one application.
   * `answer(question, options, short)` → an answer string or '' (saved answers, then HireMe's rules).
   * Returns { state: 'submitted' | 'needs_you' | 'failed', error, missing, answers, retryLater }.
   */
  async function submit({ system, key, board, externalId, profile, resume, note, answer }) {
    const id = String(externalId || '').split(':').slice(1).join(':');
    if (!id) return { state: 'failed', error: 'This role isn’t linked to the startup’s job board' };
    const [first, ...rest] = String(profile.name || '').trim().split(/\s+/);
    const answers = [];
    const missing = [];
    const pdf = new Blob([resume.buffer], { type: 'application/pdf' });

    if (system === 'greenhouse') {
      const job = await call(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}?questions=true`);
      if (!job.ok) return { state: 'failed', error: 'This role is no longer on the startup’s Greenhouse board' };
      const form = new FormData();
      form.set('first_name', first || '');
      form.set('last_name', rest.join(' '));
      form.set('email', profile.email);
      if (profile.phone) form.set('phone', profile.phone);
      form.set('resume', pdf, resume.name);
      form.set('cover_letter_text', note);
      for (const q of job.body?.questions || []) {
        for (const f of q.fields || []) {
          if (SKIP_GH.has(f.name) || f.type === 'input_hidden') continue;
          if (f.type === 'input_file') {
            if (q.required) missing.push(q.label);
            continue;
          }
          const options = (f.values || []).map((v) => v.label);
          const a = await answer(q.label, options, f.type === 'input_text');
          if (!a) {
            if (q.required) missing.push(q.label);
            continue;
          }
          if (f.type === 'multi_value_single_select' || f.type === 'multi_value_multi_select') {
            const picked = (f.values || []).filter((v) => String(a).toLowerCase().split(/\s*[,;]\s*/).includes(String(v.label).toLowerCase()));
            if (!picked.length) {
              if (q.required) missing.push(q.label);
              continue;
            }
            if (f.type === 'multi_value_multi_select') for (const v of picked) form.append(`${f.name}[]`, String(v.value));
            else form.set(f.name, String(picked[0].value));
            answers.push({ question: q.label, answer: picked.map((v) => v.label).join(', '), source: 'drafted' });
          } else {
            form.set(f.name, a);
            answers.push({ question: q.label, answer: a, source: 'drafted' });
          }
        }
      }
      if (missing.length) return { state: 'needs_you', error: `${missing.length === 1 ? 'A question' : `${missing.length} questions`} only you can answer`, missing, answers };
      const r = await call(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { authorization: basic(key) },
        body: form,
      });
      return done(r, answers, 'Greenhouse');
    }

    if (system === 'lever') {
      const form = new FormData();
      form.set('name', profile.name);
      form.set('email', profile.email);
      if (profile.phone) form.set('phone', profile.phone);
      const org = String(profile.experience || '').split('\n').find((l) => l.trim())?.match(/[—–-]\s+(.+?)(?:\s*[·(]|$)/)?.[1];
      if (org) form.set('org', org);
      for (const [k, v] of [['LinkedIn', profile.links?.linkedin], ['GitHub', profile.links?.github], ['Portfolio', profile.links?.portfolio]]) if (v) form.set(`urls[${k}]`, v);
      form.set('comments', note);
      form.set('source', 'HireMe');
      form.set('resume', pdf, resume.name);
      const r = await call(`https://api.lever.co/v0/postings/${encodeURIComponent(board)}/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`, { method: 'POST', body: form });
      if (r.status === 429) return { state: 'queued', retryLater: true };
      return done(r, answers, 'Lever');
    }

    if (system === 'ashby') {
      const info = await call('https://api.ashbyhq.com/jobPosting.info', {
        method: 'POST',
        headers: { authorization: basic(key), 'content-type': 'application/json' },
        body: JSON.stringify({ jobPostingId: id }),
      });
      if (!info.ok || info.body?.success === false) return { state: 'failed', error: 'This role is no longer on the startup’s Ashby board' };
      const def = info.body?.results?.applicationFormDefinition || info.body?.results || {};
      const entries = [...(def.sections || []).flatMap((s) => s.fields || []), ...(def.fields || [])];
      const subs = [];
      const form = new FormData();
      for (const e of entries) {
        const f = e.field || e;
        const req = !!(e.isRequired ?? !f.isNullable);
        const title = f.title || f.humanReadablePath || f.path;
        const value = await (async () => {
          if (f.path === '_systemfield_name') return profile.name;
          if (f.path === '_systemfield_email' || f.type === 'Email') return profile.email;
          if (f.path === '_systemfield_resume') {
            form.set('resume_1', pdf, resume.name);
            return 'resume_1';
          }
          if (f.type === 'Phone') return profile.phone || '';
          if (f.type === 'SocialLink' || /linkedin/i.test(title)) return /github/i.test(title) ? profile.links?.github || '' : /linkedin/i.test(title) ? profile.links?.linkedin || '' : profile.links?.portfolio || '';
          if (f.type === 'File') return '';
          const options = (f.selectableValues || []).map((v) => v.label);
          const a = await answer(title, options, f.type !== 'LongText');
          if (!a) return '';
          if (f.type === 'ValueSelect') return (f.selectableValues || []).find((v) => v.label.toLowerCase() === a.toLowerCase())?.value || '';
          if (f.type === 'MultiValueSelect') {
            const want = a.toLowerCase().split(/\s*[,;]\s*/);
            const vals = (f.selectableValues || []).filter((v) => want.includes(v.label.toLowerCase())).map((v) => v.value);
            return vals.length ? vals : '';
          }
          if (f.type === 'Boolean') return /^y(es)?$|^true$/i.test(a) ? true : /^no?$|^false$/i.test(a) ? false : '';
          if (f.type === 'Number') return Number.isFinite(Number(a)) ? Number(a) : '';
          return a;
        })();
        if (value === '' || value == null) {
          if (req) missing.push(title);
          continue;
        }
        subs.push({ path: f.path, value });
        if (!String(f.path).startsWith('_systemfield_')) answers.push({ question: title, answer: Array.isArray(value) ? value.join(', ') : String(value), source: 'drafted' });
      }
      if (!subs.some((s) => s.path === '_systemfield_resume') && entries.some((e) => (e.field || e).path === '_systemfield_resume')) missing.push('Resume');
      if (missing.length) return { state: 'needs_you', error: `${missing.length === 1 ? 'A question' : `${missing.length} questions`} only you can answer`, missing, answers };
      form.set('jobPostingId', id);
      form.set('applicationForm', JSON.stringify({ fieldSubmissions: subs }));
      form.set('utmData', JSON.stringify({ utm_source: 'HireMe' }));
      const r = await call('https://api.ashbyhq.com/applicationForm.submit', { method: 'POST', headers: { authorization: basic(key) }, body: form });
      return done(r, answers, 'Ashby');
    }
    return { state: 'failed', error: 'Unknown job board system' };
  }

  function done(r, answers, name) {
    const failed = !r.ok || r.body?.ok === false || r.body?.success === false;
    if (!failed) return { state: 'submitted', answers: [{ question: `Sent through ${name}`, answer: 'The startup’s own applicant system', source: 'api' }, ...answers] };
    if (r.status === 401 || r.status === 403) return { state: 'failed', error: `Didn’t go through: the startup’s ${name} connection stopped working`, keyRejected: true, answers };
    const why = r.body?.error || r.body?.errors?.join?.('; ') || r.body?.errorInfo?.message || `${name} returned ${r.status}`;
    return { state: 'failed', error: `Didn’t go through: ${String(why).slice(0, 160)}`, answers };
  }

  return { verify, submit };
}
