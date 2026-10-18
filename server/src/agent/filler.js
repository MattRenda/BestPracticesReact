// Injected by the apply agent into each frame of an application page.
// Maps every form field to your profile, fills what it can, and reports what's left.
// It does not click Submit — the agent decides that after checking the result.
//
// The agent exposes window.__sproutSend(type, payload) → { ok, data } for:
//   'answer' { question, short }  → { answer, source }
(() => {
  if (window.__sprout) return;

  const DECLINE = /decline|prefer not|don.?t wish|do not wish|not to (say|answer|disclose|self)|choose not/i;
  const send = (type, payload) => window.__sproutSend(type, payload);
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').replace(/[*✱]/g, '').trim();
  const textOf = (el) => clean(el?.innerText ?? el?.textContent);

  // ---------- reading the question for a field ----------

  function idsText(ids) {
    return clean(ids.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' '));
  }

  function containerQuestion(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const label = node.querySelector('label, legend, .label, [class*="label"], [class*="question"], .application-label');
      if (label && !label.contains(el) && textOf(label)) return textOf(label);
    }
    return '';
  }

  function questionFor(el) {
    if (el.type === 'radio' || el.type === 'checkbox') {
      const group = el.closest('fieldset, [role="radiogroup"], [role="group"]');
      const legend = group?.querySelector('legend');
      if (legend) return textOf(legend);
      if (group?.getAttribute('aria-labelledby')) return idsText(group.getAttribute('aria-labelledby'));
      if (group?.getAttribute('aria-label')) return clean(group.getAttribute('aria-label'));
      if (el.type === 'checkbox' && el.labels?.length) return textOf(el.labels[0]);
      return containerQuestion(el) || clean(el.name);
    }
    if (el.labels?.length && textOf(el.labels[0])) return textOf(el.labels[0]);
    if (el.getAttribute('aria-labelledby')) {
      const t = idsText(el.getAttribute('aria-labelledby'));
      if (t) return t;
    }
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    return containerQuestion(el) || clean(el.placeholder) || clean((el.name || el.id || '').replace(/[_\-[\]]+/g, ' '));
  }

  // ---------- profile rules ----------

  const yn = (v) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : null);

  // Ordered: first match wins. `q` is the lowercased question.
  const RULES = [
    { test: (q, el) => el.type === 'email' || /e-?mail/.test(q), value: (p) => p.email },
    { test: (q) => /(first|given|preferred) name|^first$/.test(q), value: (p) => p.firstName },
    { test: (q) => /(last|family) name|surname|^last$/.test(q), value: (p) => p.lastName },
    { test: (q) => /^(full |legal |your )?name$|full name|legal name/.test(q), value: (p) => [p.firstName, p.lastName].filter(Boolean).join(' ') },
    { test: (q, el) => el.type === 'tel' || /phone|mobile|cell/.test(q), value: (p) => p.phone },
    { test: (q) => /linkedin/.test(q), value: (p) => p.linkedin },
    { test: (q) => /github/.test(q), value: (p) => p.github },
    { test: (q) => /portfolio|personal (web)?site|^website|other (website|url|link)/.test(q), value: (p) => p.portfolio },
    { test: (q) => /zip|postal/.test(q), value: (p) => p.zip },
    { test: (q) => /^state$|state\/province|^province/.test(q), value: (p) => p.state },
    { test: (q) => /^city$/.test(q), value: (p) => p.city },
    { test: (q) => /^country$/.test(q), value: (p) => p.country || 'United States' },
    { test: (q) => /location|where are you (based|located)|current (city|address)|^address|city, state/.test(q), value: (p) => p.location },
    { test: (q) => /current (company|employer)|^(company|employer)( name)?$|most recent (company|employer)/.test(q), value: (p) => p.currentCompany },
    { test: (q) => /current (title|role|position)|^(job )?title$|most recent (title|role)/.test(q), value: (p) => p.currentTitle },
    { test: (q) => /sponsor/.test(q), value: (p) => yn(p.requireSponsorship) },
    { test: (q) => /(authori[sz]ed|eligible|right|legally able) to work/.test(q), value: (p) => yn(p.workAuthorized) },
    { test: (q) => /relocat/.test(q), value: (p) => yn(p.willingToRelocate) },
    { test: (q) => /years.{0,30}experience|experience.{0,15}years/.test(q), value: (p) => p.yearsExperience },
    { test: (q) => /salary|compensation|desired pay/.test(q), value: (p) => p.salaryExpectation },
    { test: (q) => /notice period|start date|when can you start|available to start/.test(q), value: (p) => p.noticePeriod },
    { test: (q) => /how did you (hear|find|learn)|where did you (hear|find)/.test(q), value: (p) => p.referralSource || 'Company website' },
    { test: (q) => /gender|\bsex\b/.test(q), value: (p) => p.eeoGender || 'decline', eeo: true },
    { test: (q) => /race|ethnic|hispanic|latino/.test(q), value: (p) => p.eeoRace || 'decline', eeo: true },
    { test: (q) => /veteran/.test(q), value: (p) => p.eeoVeteran || 'decline', eeo: true },
    { test: (q) => /disabilit/.test(q), value: (p) => p.eeoDisability || 'decline', eeo: true },
  ];
  const ruleFor = (q, el) => RULES.find((r) => r.test(q, el));

  // Consent boxes the applicant agrees to by using auto-apply.
  const CONSENT = /i (agree|acknowledge|certify|consent|confirm|have read)|privacy (policy|notice)|terms|accurate and complete/i;

  // ---------- writing ----------

  function setNative(el, value) {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      // A real click toggles state and fires the events frameworks listen for.
      if (el.checked !== Boolean(value)) el.click();
      return;
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /** Choose the option whose text best fits `wanted` (handles yes/no and "decline"). */
  function pickOption(options, wanted) {
    let w = clean(wanted).toLowerCase();
    if (!w) return null;
    const opts = options.filter((o) => clean(o.text) && !/^(select|choose|--|please)/i.test(clean(o.text)));
    if (w === 'decline' || DECLINE.test(w)) return opts.find((o) => DECLINE.test(o.text)) || null;
    const yesNo = w.match(/^(yes|no)\b/);
    if (yesNo) w = yesNo[1];
    if (w === 'yes' || w === 'no') return opts.find((o) => new RegExp(`^${w}\\b`, 'i').test(clean(o.text))) || null;
    const t = (o) => clean(o.text).toLowerCase();
    return opts.find((o) => t(o) === w) || opts.find((o) => t(o).startsWith(w)) || opts.find((o) => w.length > 2 && t(o).includes(w)) || null;
  }

  function attachFile(input, { name, type, data }) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- main ----------

  function usable(el) {
    if (el.disabled || el.readOnly) return false;
    if (el instanceof HTMLInputElement && /^(hidden|submit|button|reset|image|password|search)$/.test(el.type)) return false;
    if (el.closest('[aria-hidden="true"]') && el.type !== 'file') return false;
    if (el.type === 'file' || el.type === 'radio' || el.type === 'checkbox') return true; // often visually hidden behind custom UI
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  const isCombo = (el) =>
    el instanceof HTMLInputElement && (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' || /select__input/.test(el.className));

  const isRequired = (el) =>
    el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(textOf(el.labels?.[0])) || /\*/.test(el.closest('label, .field, [class*="question"]')?.querySelector('label')?.textContent || '');

  let seq = 0;

  /**
   * @param ctx.profile         your profile (with resumeFile / coverLetterFile as {name,type,data})
   * @param ctx.coverLetter     cover letter text for "enter manually" boxes
   * @returns {{filled, combos, missing, frame}}
   *   combos: custom dropdowns for the agent to drive with real clicks
   *   missing: required questions still empty after filling
   */
  async function run({ profile, coverLetter }) {
    const fields = [...document.querySelectorAll('input, textarea, select')].filter(usable);
    if (!fields.filter((f) => f.type !== 'hidden').length) return null;

    const out = { filled: 0, combos: [], missing: [], frame: location.href };
    const doneGroups = new Set();
    const fill = (el, v) => {
      setNative(el, v);
      out.filled++;
    };

    for (const el of fields) {
      el.dataset.sproutId ||= `s${++seq}`;
      const question = questionFor(el);
      const q = question.toLowerCase();

      if (el.type === 'file') {
        if (el.files?.length) continue;
        if (/cover/.test(q) && profile.coverLetterFile) attachFile(el, profile.coverLetterFile), out.filled++;
        else if (/resume|cv\b|curriculum/.test(q) && profile.resumeFile) attachFile(el, profile.resumeFile), out.filled++;
        continue;
      }

      if (el.type === 'radio') {
        if (doneGroups.has(el.name)) continue;
        doneGroups.add(el.name);
        const group = fields.filter((f) => f.type === 'radio' && f.name === el.name);
        if (group.some((g) => g.checked)) continue;
        let want = ruleFor(q, el)?.value(profile);
        if (!want) want = (await send('answer', { question, short: true }))?.data?.answer;
        const choice = want && pickOption(group.map((g) => ({ el: g, text: g.labels?.[0] ? textOf(g.labels[0]) : g.value })), want);
        if (choice) fill(choice.el, true);
        else if (group.some(isRequired)) out.missing.push(question);
        continue;
      }

      if (el.type === 'checkbox') {
        if (!el.checked && isRequired(el) && CONSENT.test(question)) fill(el, true);
        else if (!el.checked && isRequired(el) && !el.closest('fieldset')?.querySelector('input:checked')) out.missing.push(question);
        continue;
      }

      if (el instanceof HTMLSelectElement) {
        if (el.selectedIndex > 0 && el.value) continue;
        let want = ruleFor(q, el)?.value(profile);
        if (!want) want = (await send('answer', { question, short: true }))?.data?.answer;
        const choice = want && pickOption([...el.options].map((o) => ({ el: o, text: o.text })), want);
        if (choice) fill(el, choice.el.value);
        else if (isRequired(el)) out.missing.push(question);
        continue;
      }

      if (isCombo(el)) {
        let want = ruleFor(q, el)?.value(profile);
        if (!want) want = (await send('answer', { question, short: true }))?.data?.answer;
        out.combos.push({ id: el.dataset.sproutId, question, want: want || '', required: isRequired(el) });
        continue;
      }

      if (el.value) continue;

      if (/cover letter/.test(q) && el instanceof HTMLTextAreaElement) {
        if (coverLetter) fill(el, coverLetter);
        else if (isRequired(el)) out.missing.push(question);
        continue;
      }

      const rule = ruleFor(q, el);
      const value = rule?.value(profile);
      if (value) {
        fill(el, rule.eeo && value === 'decline' ? 'Decline to self-identify' : value);
        continue;
      }

      // Any other question: saved answer, profile, or an AI draft grounded in your resume.
      if (q.length > 3 && (el instanceof HTMLTextAreaElement || isRequired(el))) {
        const r = await send('answer', { question, short: !(el instanceof HTMLTextAreaElement) });
        if (r?.ok && r.data.answer) {
          fill(el, r.data.answer);
          continue;
        }
      }
      if (isRequired(el)) out.missing.push(question);
    }
    return out;
  }

  window.__sprout = { run, questionFor, pickOption };
})();
