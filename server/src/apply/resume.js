// Turns a developer's HireMe profile into a one-page resume, and renders resumes and cover notes as HTML for PDF.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** A light-markdown resume (#, ##, ###, -) built only from what the developer wrote in their profile. */
export function profileResume(p, email) {
  const links = Object.values(p.links || {}).filter(Boolean);
  const contact = [email, p.phone, p.location, ...links].filter(Boolean).join(' | ');
  const out = [`# ${p.name || 'Applicant'}`, contact];
  if (p.headline || p.bio) out.push('## Summary', [p.headline, p.bio].filter(Boolean).join('. ').replace(/\.\./g, '.'));
  if (p.experience) {
    out.push('## Experience');
    for (const line of String(p.experience).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/^[•\-*]\s*/.test(t)) out.push(`- ${t.replace(/^[•\-*]\s*/, '')}`);
      else if (/^education$/i.test(t)) out.push('## Education');
      else out.push(`### ${t}`);
    }
  }
  if (p.skills) out.push('## Skills', p.skills);
  return out.join('\n');
}

export function resumeHtml(md) {
  const lines = String(md).split('\n');
  let html = '';
  let inList = false;
  const closeList = () => {
    if (inList) html += '</ul>';
    inList = false;
  };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) return closeList();
    if (line.startsWith('### ')) closeList(), (html += `<h3>${esc(line.slice(4))}</h3>`);
    else if (line.startsWith('## ')) closeList(), (html += `<h2>${esc(line.slice(3))}</h2>`);
    else if (line.startsWith('# ')) closeList(), (html += `<h1>${esc(line.slice(2))}</h1>`);
    else if (/^[-•*] /.test(line)) {
      if (!inList) (html += '<ul>'), (inList = true);
      html += `<li>${esc(line.slice(2))}</li>`;
    } else {
      closeList();
      html += `<p${i === 1 ? ' class="contact"' : ''}>${esc(line)}</p>`;
    }
  });
  closeList();
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 0.55in 0.6in; }
    body { font: 10.5pt/1.38 Georgia, 'Times New Roman', serif; color: #111; }
    h1 { font-size: 20pt; margin: 0 0 2pt; }
    .contact { margin: 0 0 8pt; color: #333; font-size: 9.5pt; }
    h2 { font-size: 11pt; margin: 11pt 0 4pt; padding-bottom: 2pt; border-bottom: 1px solid #999; }
    h3 { font-size: 10.5pt; margin: 7pt 0 2pt; }
    p { margin: 0 0 4pt; }
    ul { margin: 2pt 0 4pt; padding-left: 14pt; }
    li { margin: 0 0 2pt; }
  </style></head><body>${html}</body></html>`;
}

export function letterHtml(text) {
  const paras = String(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 1in; }
    body { font: 11pt/1.5 Georgia, serif; color: #111; }
    p { margin: 0 0 11pt; }
  </style></head><body>${paras}</body></html>`;
}
