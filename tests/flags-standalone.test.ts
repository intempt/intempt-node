import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * F33: the flags module builds and runs with tracking removed. The source is compiled to a scratch
 * directory, every tracking module is deleted from the output, and a fresh Node process loads
 * `flags.js` and serves a flag from a loopback server. A static import check could not see a
 * runtime `require` added later; deleting the files can.
 *
 * Nock-free on purpose (it runs in a child process anyway): the child talks to a real socket.
 */
const ROOT = resolve(__dirname, '..');
const TRACKING = [
  'batcher',
  'ingest',
  'delivery',
  'consent',
  'ecommerce',
  'recommend',
  'legacy',
  'client',
  'index',
];

let pkg = '';
let out = '';

beforeAll(() => {
  // Laid out like the package (dist/ beside package.json): stamp.ts reads ../package.json.
  pkg = mkdtempSync(join(tmpdir(), 'intempt-flags-only-'));
  out = join(pkg, 'dist');
  copyFileSync(join(ROOT, 'package.json'), join(pkg, 'package.json'));
  execFileSync(
    process.execPath,
    [
      join(ROOT, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(ROOT, 'tsconfig.json'),
      '--outDir',
      out,
    ],
    { stdio: 'pipe' },
  );
  for (const name of TRACKING) {
    for (const ext of ['.js', '.d.ts']) rmSync(join(out, name + ext), { force: true });
  }
}, 60_000);

afterAll(() => {
  if (pkg) rmSync(pkg, { recursive: true, force: true });
});

const CHILD = `
const http = require('node:http');
const seen = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    seen.push({ url: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: 'new_checkout', value: true, valueType: 'boolean' }));
  });
});
server.listen(0, '127.0.0.1', async () => {
  const { IntemptFlags } = require(process.argv[1] + '/flags.js');
  const flags = IntemptFlags.init({
    org: 'acme', project: 'web', apiKey: 'pfx0123456789abcdef.sec0123456789abcdef',
    host: '127.0.0.1:' + server.address().port, protocol: 'http', sourceId: '1841503112918048768',
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
  });
  const value = await flags.boolVariation('new_checkout', { userId: 'u-1' }, false);
  await flags.close();
  server.close();
  const loaded = Object.keys(require.cache)
    .filter((p) => p.startsWith(process.argv[1]))
    .map((p) => require('node:path').basename(p, '.js'));
  const exported = Object.keys(require(process.argv[1] + '/flags.js')).sort();
  process.stdout.write(JSON.stringify({ value, seen, loaded, exported }));
});
`;

describe('the flags module with tracking removed', () => {
  it('has no tracking module left in the build it runs from', () => {
    const left = readdirSync(out).map((f) => f.replace(/\.d\.ts$|\.js$/, ''));
    for (const name of TRACKING) expect(left).not.toContain(name);
    expect(left).toContain('flags');
  });

  it('loads and serves a flag', () => {
    const result = JSON.parse(
      execFileSync(process.execPath, ['-e', CHILD, out], {
        encoding: 'utf8',
        timeout: 20_000,
        // The build lives outside the repo, so its one runtime dependency resolves through here.
        env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') },
      }),
    ) as {
      value: unknown;
      seen: { url: string; body: unknown }[];
      loaded: string[];
      exported: string[];
    };

    expect(result.value).toBe(true);
    expect(result.seen).toEqual([
      {
        url: '/v1/acme/projects/web/flags/evaluate',
        body: {
          identification: { userId: 'u-1', sourceId: '1841503112918048768' },
          key: 'new_checkout',
          device: 'all',
        },
      },
    ]);
    expect(result.loaded).toContain('flags');
    expect(result.loaded).toContain('flag-evaluator');
    // The entry is public npm API: the evaluator, its cache constants and its test hook stay
    // internal, so they can change without a breaking release.
    expect(result.exported).toEqual([
      'IntemptApiError',
      'IntemptFlags',
      'IntemptFlagsClient',
    ]);
    for (const name of TRACKING) expect(result.loaded).not.toContain(name);
  });
});
