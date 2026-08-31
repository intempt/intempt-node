import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The R36 guard, tested against a planted violation.
 *
 * `scripts/` is excluded from both `GUARD_SRC` and Stryker's `mutate` globs, so nothing else in
 * this repo exercises this 109-line script — it was a gate whose only evidence of working lived in
 * a review comment. A guard nobody has seen fail is not a guard: the failure mode is that a regex
 * stops matching, the job stays green, and local bucketing lands unnoticed.
 */

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-no-local-bucketing.mjs');

// A wrong cwd would make every assertion below pass against a script that never ran, so the path
// is asserted rather than assumed. `import.meta` is unavailable here: tsconfig compiles to
// commonjs, and `npm run typecheck` covers the test files.
if (!existsSync(SCRIPT)) {
  throw new Error(`no-local-bucketing test: guard script not found at ${SCRIPT}`);
}

let dir: string | undefined;

function fixture(contents: string): string {
  dir = mkdtempSync(join(tmpdir(), 'r36-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'thing.ts'), contents);
  return dir;
}

/** Returns the exit code and stderr, without throwing on a non-zero exit. */
function runGuard(root: string): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [SCRIPT], {
      env: { ...process.env, GUARD_ROOT: root, GUARD_SRC: 'src' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    return { status: e.status ?? -1, stderr: String(e.stderr ?? '') };
  }
}

describe('the no-local-bucketing guard', () => {
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('fails on bucket arithmetic and names the file and line', () => {
    const root = fixture(
      [
        'export function bucket(id: string): number {',
        '  return hashOf(id) % 10000;',
        '}',
      ].join('\n'),
    );

    const { status, stderr } = runGuard(root);

    expect(status).toBe(1);
    expect(stderr).toContain('no-local-bucketing FAILED');
    expect(stderr).toContain('src/thing.ts:2');
    expect(stderr).toContain('modulo the platform bucket count');
  });

  it('fails on a hash construction', () => {
    const root = fixture('const h = createHash("sha256").update(id).digest("hex");');

    expect(runGuard(root).status).toBe(1);
  });

  it('passes on a file that does no bucketing', () => {
    const root = fixture('export const answer = 42;');

    expect(runGuard(root)).toEqual({ status: 0, stderr: '' });
  });

  it('does not count a comment explaining the rule as a breach', () => {
    // Otherwise the rule could not be documented in the code it governs — which is where every
    // other SDK explains it.
    const root = fixture('// No SDK may hash an identifier and take it modulo 10000.');

    expect(runGuard(root).status).toBe(0);
  });

  it('passes on this repo, which is what CI asserts', () => {
    expect(runGuard(REPO_ROOT).status).toBe(0);
  });
});
