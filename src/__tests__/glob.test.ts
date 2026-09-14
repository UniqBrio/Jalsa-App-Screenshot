/**
 * The git-diff skip filter's entire correctness rests on globToRegExp /
 * matchesAny — a wrong translation here either skips flows that should have
 * run (missing real app changes) or runs everything (silently disabling the
 * cost-saving the layer exists for). Covers the patterns actually used in
 * config/routes.map.json plus the edge cases the implementation calls out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchesAny } from '../change-detector';

test('trailing ** matches everything below the prefix, not the prefix itself', () => {
  const re = globToRegExp('components/attendance/**');
  assert.ok(re.test('components/attendance/Foo.tsx'));
  assert.ok(re.test('components/attendance/sub/Bar.tsx'));
  assert.ok(!re.test('components/attendance'));
  assert.ok(!re.test('components/other/Foo.tsx'));
});

test('**/ matches zero or more directory levels', () => {
  const re = globToRegExp('app/**/index.ts');
  assert.ok(re.test('app/index.ts'));
  assert.ok(re.test('app/a/index.ts'));
  assert.ok(re.test('app/a/b/index.ts'));
  assert.ok(!re.test('app/index.tsx'));
});

test('single * stays inside one path segment', () => {
  const re = globToRegExp('app/_layout*');
  assert.ok(re.test('app/_layout.tsx'));
  assert.ok(re.test('app/_layoutFoo.ts'));
  assert.ok(!re.test('app/_layoutFoo/bar.tsx'), 'a single * must not cross a slash');
});

test('literal parentheses in Expo Router group folders are escaped', () => {
  const re = globToRegExp('app/(tabs)/index*');
  assert.ok(re.test('app/(tabs)/index.tsx'));
  assert.ok(!re.test('app/tabs/index.tsx'), 'parens are literal, not a regex group');
});

test('? matches exactly one non-slash character', () => {
  const re = globToRegExp('a?c');
  assert.ok(re.test('abc'));
  assert.ok(!re.test('ac'));
  assert.ok(!re.test('a/c'));
});

test('matchesAny is true if any glob in the list matches', () => {
  const globs = ['components/attendance/**', 'hooks/useAttendance*'];
  assert.ok(matchesAny('hooks/useAttendanceHistory.ts', globs));
  assert.ok(matchesAny('components/attendance/Row.tsx', globs));
  assert.ok(!matchesAny('components/enquiry/Row.tsx', globs));
});

test('matchesAny with an empty glob list never matches', () => {
  assert.ok(!matchesAny('anything.ts', []));
});
