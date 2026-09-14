/**
 * fingerprint.ts's normalise() is what makes DOM-fingerprint change detection
 * trustworthy: a wrong volatile-text pattern becomes a permanent source of
 * false "changed" flags (README's own stated core risk), or worse, masks a
 * real change by over-matching. Covers each VOLATILE pattern plus
 * compareFingerprint's new/unchanged/changed classification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, compareFingerprint, updateFingerprint } from '../fingerprint';
import type { Fingerprints } from '../types';

test('normalise collapses repeated whitespace', () => {
  assert.equal(normalise('a    b\tc'), 'a b c');
});

test('normalise replaces ISO datetimes', () => {
  assert.equal(normalise('seen 2026-08-10T14:30:00'), 'seen <DATETIME>');
});

test('normalise replaces plain dates (both / and - separators)', () => {
  assert.equal(normalise('on 10/08/2026'), 'on <DATE>');
  assert.equal(normalise('on 2026-08-10'), 'on <DATE>');
});

test('normalise replaces clock times with optional am/pm', () => {
  assert.equal(normalise('at 2:30 PM'), 'at <TIME>');
  assert.equal(normalise('at 14:30'), 'at <TIME>');
});

test('normalise replaces relative time phrases', () => {
  assert.equal(normalise('updated 5 minutes ago'), 'updated <RELTIME>');
  assert.equal(normalise('updated just now'), 'updated <RELTIME>');
});

test('normalise replaces currency amounts (rupee and dollar)', () => {
  assert.equal(normalise('fee ₹1,200.50'), 'fee <MONEY>');
  assert.equal(normalise('fee $1200'), 'fee <MONEY>');
});

test('normalise replaces UUIDs', () => {
  assert.equal(normalise('id 550e8400-e29b-41d4-a716-446655440000'), 'id <UUID>');
});

test('normalise replaces SCRSHOT_ run tags', () => {
  assert.equal(normalise('name SCRSHOT_2026-08-10T01-30-00Z_Test'), 'name <RUNTAG>');
});

test('normalise replaces 10-digit mobile numbers', () => {
  assert.equal(normalise('call 9994871158'), 'call <MOBILE>');
});

test('normalise leaves structural/stable content untouched (aside from whitespace collapse)', () => {
  const skeleton = '<div data-testid="attendance-list">\n<button>Mark Present</button>';
  assert.equal(normalise(skeleton), skeleton);
});

test('compareFingerprint: unseen key is "new"', () => {
  const baseline: Fingerprints = {};
  assert.equal(compareFingerprint(baseline, 'attendance/mark-attendance/01', 'sha256:aaa'), 'new');
});

test('compareFingerprint: same hash is "unchanged"', () => {
  const baseline: Fingerprints = {};
  updateFingerprint(baseline, 'k', 'sha256:aaa', []);
  assert.equal(compareFingerprint(baseline, 'k', 'sha256:aaa'), 'unchanged');
});

test('compareFingerprint: different hash is "changed"', () => {
  const baseline: Fingerprints = {};
  updateFingerprint(baseline, 'k', 'sha256:aaa', []);
  assert.equal(compareFingerprint(baseline, 'k', 'sha256:bbb'), 'changed');
});
