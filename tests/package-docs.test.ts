import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { timeout } from './helpers/timeouts.js';

it('ships every relative Markdown document linked directly from either README', async () => {
  // Ask npm for its actual packlist: files declarations alone miss ignore rules.
  // Skip lifecycle scripts so this check neither rebuilds nor creates a tarball.
  const { stdout } = await promisify(exec)('npm pack --dry-run --ignore-scripts --json', { maxBuffer: 4 * 1024 * 1024 });
  const [manifest] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const packed = new Set(manifest!.files.map(file => file.path));
  for (const path of ['README.md', 'README.en.md']) {
    const readme = await readFile(path, 'utf8');
    const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)]
      .map(match => decodeURIComponent(match[1]!.split('#')[0]!))
      .filter(target => target.endsWith('.md') && !/^[a-z][a-z0-9+.-]*:/i.test(target));
    expect(links.length, path + ' Markdown links').toBeGreaterThan(0);
    const missing = [...new Set(links.map(target => posix.normalize(posix.join(posix.dirname(path), target))))]
      .filter(target => !packed.has(target));
    expect(missing, path + ' links missing from npm package').toEqual([]);
  }
}, timeout(30_000));
