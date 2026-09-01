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

/**
 * Returns the exit code, stdout and stderr, without throwing on a non-zero exit.
 *
 * `stdout` is captured because the pass line is itself an assertion target: the guard used to print
 * "OK" identically whether it had read every source file or none.
 */
function runGuard(
  root: string,
  guardSrc = 'src',
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      env: { ...process.env, GUARD_ROOT: root, GUARD_SRC: guardSrc },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stdout: String(stdout), stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    };
  }
}

/** A root with no source tree at all — the shape that used to pass. */
function emptyRoot(): string {
  dir = mkdtempSync(join(tmpdir(), 'r36-empty-'));
  return dir;
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

    expect(runGuard(root)).toMatchObject({ status: 0, stderr: '' });
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

  // A guard that reports success on a tree it never opened is worse than no guard: it is a green
  // CI job asserting nothing. Measured before this was fixed — with no src/ directory, and with
  // GUARD_SRC pointing at a name that does not exist, the guard printed
  // "no-local-bucketing OK" and exited 0 having read zero files.

  it('fails when the source root does not exist, rather than scanning nothing', () => {
    const result = runGuard(emptyRoot());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source root(s) not found');
  });

  it('fails when GUARD_SRC names a directory that is not there', () => {
    const result = runGuard(REPO_ROOT, 'definitely-not-a-directory');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scanned 0 source files');
  });

  it('blames the missing tree, not the allowlist, when it scans nothing', () => {
    // Ordering matters. With zero files read, every allowlist entry also "matches nothing", so the
    // stale-entry check would fire and send the reader to fix a file that is not the problem.
    const result = runGuard(emptyRoot());

    expect(result.stderr).toContain('source root(s) not found');
    expect(result.stderr).not.toContain('allowlist entries that no longer match');
  });

  it('states how many files it read, so a pass can be told from a vacuous one', () => {
    const result = runGuard(REPO_ROOT);

    expect(result.status).toBe(0);
    const match = /scanned (\d+) file\(s\)/.exec(result.stdout);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThan(0);
  });
});
