import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { draftAnswer, aiEnabled } from '../src/apply/ai.js';

test('answers come from your own Ollama when OLLAMA_URL is set', async () => {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      const q = seen.at(-1).body.messages.at(-1).content;
      res.end(JSON.stringify({ message: { role: 'assistant', content: /favorite stack/.test(q) ? '<think>hmm</think>React and Node.js, which I use every day.' : 'Yes' } }));
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const env = { OLLAMA_URL: `http://127.0.0.1:${srv.address().port}/`, OLLAMA_MODEL: 'qwen2.5:3b' };
  assert.ok(aiEnabled(env));
  const profile = { name: 'Dana Dev', skills: 'React, Node.js', experience: 'Engineer at X' };
  const job = { company: 'Lumen', title: 'Engineer' };
  assert.equal(await draftAnswer(env, profile, 'dana@example.com', job, 'What is your favorite stack?', true), 'React and Node.js, which I use every day.');
  assert.equal(await draftAnswer(env, profile, 'dana@example.com', job, 'Do you enjoy pairing?', true, ['Yes', 'No']), 'Yes');
  assert.equal(seen[0].url, '/api/chat');
  assert.equal(seen[0].body.model, 'qwen2.5:3b');
  assert.equal(seen[0].body.stream, false);
  assert.equal(seen[0].body.messages[0].role, 'system');
  srv.close();
});
