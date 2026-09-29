import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const scripts = path.resolve(import.meta.dirname, '..');

test('restore verification reports equality and detects changed bytes without exposing file names', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cbm-restore-check-'));
  const snapshot = path.join(root, 'snapshot');
  const restored = path.join(root, 'restored');
  try {
    await mkdir(path.join(snapshot, 'data'), { recursive: true });
    await mkdir(path.join(restored, 'data'), { recursive: true });
    await writeFile(path.join(snapshot, 'data', 'private-example'), 'sample-A');
    await writeFile(path.join(restored, 'data', 'private-example'), 'sample-A');
    const args = [path.join(scripts, 'verify-staged-restore.mjs'), '--snapshot-root', snapshot, '--restored-root', restored, '--sections', 'data'];
    const equal = await run(process.execPath, args);
    assert.equal(JSON.parse(equal.stdout).verified, true);
    assert.doesNotMatch(equal.stdout, /private-example|sample-A/);

    await writeFile(path.join(restored, 'data', 'private-example'), 'sample-B');
    await assert.rejects(run(process.execPath, args), error => {
      assert.equal(JSON.parse(error.stdout).verified, false);
      assert.doesNotMatch(error.stdout, /private-example|sample-B/);
      return true;
    });

    await rm(path.join(restored, 'data', 'private-example'));
    await symlink(path.join(snapshot, 'data', 'private-example'), path.join(restored, 'data', 'private-example'));
    await assert.rejects(run(process.execPath, args), error => {
      assert.match(error.stderr, /Symlink in data/);
      assert.doesNotMatch(error.stderr, /private-example/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Ollama benchmark validates limits before sending synthetic requests', async () => {
  const script = path.join(scripts, 'benchmark-ollama-runtime.mjs');
  const help = await run(process.execPath, [script, '--help']);
  assert.match(help.stdout, /Synthetic input only/);
  await assert.rejects(run(process.execPath, [script, '--model', 'sample', '--concurrency', '8']), error => {
    assert.match(error.stderr, /--concurrency must be an integer/);
    return true;
  });
});
