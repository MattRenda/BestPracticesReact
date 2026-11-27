import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResumeText, yearsFrom, clean } from '../src/resume-parse.js';

const NOW = new Date('2026-11-26');

test('resume text: contact, skills, experience, years', () => {
  const text = `ALEX SAMPLE
Full Stack Developer
CONTACT
Austin, Texas
alex@example.com
+1 555 010 4455
alexsample.dev
SKILLS
• React • TypeScript
• Node.js • GraphQL
WORK EXPERIENCE
Full Stack Developer | Tiny Startup Co
Mar 2022 - Present
• Shipped the mobile app from zero to 20k users, owning the API and
the deploy pipeline.
Junior Developer | Agency Example
Sep 2020 - Feb 2022
• Built client sites in Next.js.
EDUCATION
Bootcamp Example, 2020`;
  const p = parseResumeText(text, ['https://alexsample.dev'], NOW);
  assert.equal(p.name, 'Alex Sample');
  assert.equal(p.location, 'Austin, Texas');
  assert.equal(p.phone, '+1 555 010 4455');
  assert.equal(p.headline, 'Full Stack Developer · React, TypeScript, Node.js');
  assert.equal(p.years, 6);
  assert.match(p.skills, /^React, TypeScript, Node\.js, GraphQL/);
  assert.equal(p.links.portfolio, 'https://alexsample.dev');
  assert.match(p.experience, /^Full Stack Developer \| Tiny Startup Co · Mar 2022 - Present\n- Shipped .* the deploy pipeline\.\n/);
  assert.match(p.experience, /\nEducation\nBootcamp Example, 2020$/);
});

test('years: overlapping jobs count once, end dates count through their month', () => {
  assert.equal(yearsFrom('Jan 2018 – Dec 2020\n2019 - 2021\n', NOW), 4);
  assert.equal(yearsFrom('7/14/2022 – Present', NOW), 4);
  assert.equal(yearsFrom('Jun 2024 - May 2025', NOW), 1);
  assert.equal(yearsFrom('no dates here', NOW), null);
});

test('nothing is invented: unreadable text gives no fields, and bad values are dropped', () => {
  assert.deepEqual(parseResumeText('', [], NOW), {});
  assert.deepEqual(clean({ years: 99, links: { github: 'javascript:alert(1)' }, name: '  ', skills: ['Go', 'Rust'] }), { skills: 'Go, Rust' });
});

test('fonts that draw "ft"/"fi"/"fl" as one glyph: words are put back together', async () => {
  const { fixLigatures } = await import('../src/resume-parse.js');
  assert.equal(fixLigatures('Senior Soware Engineer, Microso, workows, prole, oine'), 'Senior Software Engineer, Microsoft, workflows, profile, offline');
  assert.equal(fixLigatures('Ask about utter ﬁxes'), 'Ask about utter fixes');
});

test('name: never a city, and the file name helps when the layout hides it', async () => {
  const { nameFromFile } = await import('../src/resume-parse.js');
  assert.equal(nameFromFile('MatthewRenda_Resume_2023 (2).pdf.PDF'), 'Matthew Renda');
  assert.equal(nameFromFile('resume.pdf'), '');
  const hints = { fileName: 'JordanExample_Resume.pdf', email: 'jordan@example.com' };
  const a = parseResumeText('Portland OR 97201\n555-010-2233\nJORDAN Q EXAMPLE\nExperience\nEngineer, X Jan 2020 - Present', [], NOW, hints);
  assert.equal(a.name, 'Jordan Q Example');
  assert.equal(a.location, 'Portland, OR');
  const b = parseResumeText('Portland OR\nSoftware Engineer\nExperience\nEngineer, X Jan 2020 - Present', [], NOW, hints);
  assert.equal(b.name, 'Jordan Example');
});

test('LinkedIn "Save to PDF": link, headline, location, summary, roles (several at one company), education, top skills', async () => {
  const { parseResumeText, isLinkedInPdf } = await import('../src/resume-parse.js');
  const text = `Contact
dana@example.com
www.linkedin.com/in/dana-
smith-1a2b3c (LinkedIn)
dana.dev (Personal)
Top Skills
React.js
Node.js
TypeScript
Languages
English (Native or Bilingual)
Dana Smith
Senior Software Engineer at Lumen | React, Node,
TypeScript
Sacramento, California, United States
Summary
I build web apps for small teams. Ten years of shipping React and
Node.js products.
Experience
Lumen Labs
Senior Software Engineer
March 2021 - Present (3 years 9 months)
Sacramento, California, United States
Led the move to TypeScript across the web app and cut build times
in half.
Built the billing service in Node.js.
Acme Corp
4 years 1 month
Software Engineer
January 2019 - February 2021 (2 years 2 months)
Shipped the React dashboard.
Junior Developer
February 2017 - January 2019 (2 years)
Page 1 of 2
Education
California State University-Sacramento
Bachelor of Science - BS, Computer Science · (2012 - 2016)
Page 2 of 2`;
  assert.ok(isLinkedInPdf(text));
  const r = parseResumeText(text, [], new Date('2026-11-27'));
  assert.equal(r.name, 'Dana Smith');
  assert.equal(r.headline, 'Senior Software Engineer at Lumen | React, Node, TypeScript');
  assert.equal(r.location, 'Sacramento, California, United States');
  assert.equal(r.links.linkedin, 'https://www.linkedin.com/in/dana-smith-1a2b3c');
  assert.equal(r.links.portfolio, 'https://dana.dev');
  assert.equal(r.skills, 'React.js, Node.js, TypeScript');
  assert.match(r.bio, /^I build web apps for small teams\. Ten years of shipping React and Node\.js products\.$/);
  assert.equal(
    r.experience.split('\n').slice(0, 6).join('\n'),
    [
      'Senior Software Engineer — Lumen Labs · March 2021 - Present',
      '- Led the move to TypeScript across the web app and cut build times in half.',
      '- Built the billing service in Node.js.',
      'Software Engineer — Acme Corp · January 2019 - February 2021',
      '- Shipped the React dashboard.',
      'Junior Developer — Acme Corp · February 2017 - January 2019',
    ].join('\n'),
  );
  assert.match(r.experience, /Education\nCalifornia State University-Sacramento/);
  assert.ok(!/Page \d/.test(r.experience));
});

test('links broken across lines are rejoined; real words are not "fixed"', async () => {
  const { joinWrappedLinks, fixLigatures } = await import('../src/resume-parse.js');
  assert.equal(joinWrappedLinks('www.linkedin.com/in/matthew-\nrenda-123 (LinkedIn)'), 'www.linkedin.com/in/matthew-renda-123 (LinkedIn)');
  assert.equal(joinWrappedLinks('linkedin.com/in/matthew\u2010renda'), 'linkedin.com/in/matthew-renda');
  assert.equal(joinWrappedLinks('github.com/dana\nReact, Node'), 'github.com/dana\nReact, Node');
  assert.equal(fixLigatures('Led a team. Ran git rebase. Checked the sha.'), 'Led a team. Ran git rebase. Checked the sha.');
});
