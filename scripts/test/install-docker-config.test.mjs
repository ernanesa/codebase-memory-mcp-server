import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const installer = path.resolve(import.meta.dirname, '../../install.sh');

test('Docker cgroup migration replaces conflicting drivers and preserves other configuration', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cbm-docker-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'daemon.json');
  const cases = [
    {},
    { 'exec-opts': [] },
    { 'exec-opts': ['native.cgroupdriver=systemd'] },
    { 'exec-opts': ['native.cgroupdriver=cgroupfs', 'native.cgroupdriver=systemd', 'native.umask=0022'] },
    { 'exec-opts': ['native.cgroupdriver=cgroupfs', 'native.cgroupdriver=cgroupfs'] }
  ];
  for (const options of cases) {
    const config = { ...options, runtimes: { nvidia: { path: 'nvidia-container-runtime', runtimeArgs: [] } }, 'log-driver': 'json-file' };
    await writeFile(file, JSON.stringify(config));
    const args = ['-c', 'source "$1"; merge_docker_cgroupfs_config "$2"', 'test', installer, file];
    const result = JSON.parse((await run('bash', args)).stdout);
    assert.deepEqual(result, {
      ...config,
      'exec-opts': [...(config['exec-opts'] ?? []).filter(value => !value.startsWith('native.cgroupdriver=')), 'native.cgroupdriver=cgroupfs']
    });
    await writeFile(file, JSON.stringify(result));
    assert.deepEqual(JSON.parse((await run('bash', args)).stdout), result);
  }
});
