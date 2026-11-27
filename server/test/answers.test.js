import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoAnswer } from '../src/apply/answers.js';
import { formDefaults } from '../src/apply/agent.js';

const profile = {
  name: 'Matthew J Renda', headline: 'Senior Software Engineer · React, Express, JavaScript', location: 'Sacramento, CA', years: 10,
  skills: 'React, Express, JavaScript, Node, HTML, CSS, Azure, Azure DevOps, AWS, Jest', work_pref: 'any', work_authorized: 'yes', needs_sponsorship: 'no',
  experience: 'Senior Software Engineer — California DMV · 7/14/2022 – Present\n- Build and maintain the DMV website with React and Node.\n\nEducation\nBS Computer Science, California State University, Sacramento',
  links: { linkedin: 'https://linkedin.com/in/matt' },
};
const job = { company: 'Acme', title: 'Senior Full-Stack Engineer', description: 'We use TypeScript, React and Postgres.' };
const ask = (question, options = [], short = true) => autoAnswer({ question, options, short, profile, defaults: formDefaults(profile), job });
const YN = ['Select...', 'Yes', 'No'];

test('preferences and availability lean yes', () => {
  assert.equal(ask('Are you willing to relocate to New York?', YN), 'Yes');
  assert.equal(ask('Are you able to work from our SF office 4 days a week?', YN), 'Yes');
  assert.equal(ask('Are you comfortable working in a fast-paced startup environment?', YN), 'Yes');
  assert.equal(ask('When can you start?'), '2 weeks');
  assert.equal(ask('Are you currently located in New York?'), "No, I'm based in Sacramento, CA, and I'm open to relocating");
  assert.equal(ask('Are you currently located in the US?', YN), 'Yes');
});

test('skills: yes when the resume shows it or something close; honest otherwise', () => {
  assert.equal(ask('Do you have experience with React?', YN), 'Yes');
  assert.equal(ask('Do you have experience with TypeScript?', YN), 'Yes', 'JavaScript is close enough');
  assert.equal(ask('Do you have hands-on experience with Postgres?', YN), 'No', 'nothing database-related on the resume');
  assert.equal(ask('How many years of experience do you have with React?', ['0-2', '3-5', '6-9', '10+']), '10+');
  assert.equal(ask('Rate your Kubernetes experience', ['Beginner', 'Intermediate', 'Advanced', 'Expert']), 'Intermediate', 'Azure DevOps is related; never "Expert"');
  assert.equal(ask('What level are you?', ['Junior', 'Mid-level', 'Senior', 'Staff']), 'Senior');
});

test('the few things that stay strictly accurate', () => {
  assert.equal(ask('Are you legally authorized to work in the United States?', YN), 'Yes');
  assert.equal(ask('Will you now or in the future require visa sponsorship?', YN), 'No');
  assert.equal(ask('Are you a US citizen?', YN), '', 'not on the profile: asks instead of guessing');
  assert.equal(ask('Do you have a Bachelor’s degree in Computer Science?', YN), 'Yes', 'from the education on the resume');
  assert.equal(ask('Do you hold an active security clearance?', YN), 'No');
  assert.equal(ask('Have you ever been convicted of a felony?', YN), '');
  assert.equal(ask('Gender', ['Male', 'Female', 'Decline to self-identify']), 'Decline to self-identify');
});

test('everything else gets a positive, grounded answer', () => {
  assert.equal(ask('I consent to a background check', YN), 'Yes');
  assert.equal(ask('Have you previously applied to Acme?', YN), 'No');
  assert.equal(ask('How did you hear about us?', ['LinkedIn', 'Job board', 'Friend']), 'Job board');
  assert.equal(ask('What are your salary expectations?'), 'Flexible — happy to discuss');
  const why = ask('Why do you want to work at Acme?', [], false);
  assert.match(why, /^Acme's work lines up/);
  assert.match(why, /10 years of experience, working mostly with React/);
  assert.ok(why.length < 500, 'not over the top');
  assert.match(ask('Tell us about a project you are proud of', [], false), /Build and maintain the DMV website/);
  assert.equal(ask('Which team are you most interested in?', ['Select...', 'Platform', 'Growth']), 'Platform');
});
