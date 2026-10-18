// Runs the API (with reload) and the Vite dev server together. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  ['api', 'npm', ['--prefix', 'server', 'run', 'dev']],
  ['web', 'npm', ['--prefix', 'web', 'run', 'dev', '--', '--host']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const tag = (chunk) => chunk.toString().replace(/^(?=.)/gm, `[${name}] `);
  p.stdout.on('data', (d) => process.stdout.write(tag(d)));
  p.stderr.on('data', (d) => process.stderr.write(tag(d)));
  p.on('exit', (code) => {
    console.log(`[${name}] exited (${code})`);
    procs.forEach((q) => q !== p && q.kill());
    process.exit(code ?? 0);
  });
  return p;
});

process.on('SIGINT', () => procs.forEach((p) => p.kill('SIGINT')));
