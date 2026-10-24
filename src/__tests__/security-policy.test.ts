/**
 * Security/PII policy — P0 remediation guards.
 *
 * Every value here is synthetic. A real credential or mobile number must never
 * appear in a test: tests are committed, and a fixture is exactly how a secret
 * slips into git history a second time.
 *
 * The synthetic PIN's digits deliberately occur inside the synthetic mobile
 * number, because that is the ordering bug redactValues exists to prevent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { useSampleApp } from './helpers/sample-app';

// Credentials live in the selected app's own .env — the Sample App's, here.
useSampleApp({ SIGNIN_MOBILE: '9000048261', SIGNIN_PIN: '4826', STAFF_MOBILE: '+91 80000 11112', STAFF_PIN: '1357' });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const envMod = require('../env') as typeof import('../env');
const { redactValues, redactSecrets, identifierValues, secretValues, ROOT } = envMod;

const ADMIN = { name: 'SIGNIN_MOBILE', digits: '9000048261' };
const CC = '91';

// ─── redactValues (pure) ─────────────────────────────────────────────────────

test('redacts a bare ten-digit mobile with a named token', () => {
  assert.equal(redactValues('typed "9000048261"', [], [ADMIN]), 'typed "«redacted:SIGNIN_MOBILE»"');
});

test('redacts the spaced form the sign-in field renders', () => {
  assert.equal(redactValues('No account for 90000 48261', [], [ADMIN]), 'No account for «redacted:SIGNIN_MOBILE»');
});

test('redacts +<cc>, <cc> and 0 prefixed and hyphenated forms, prefix included', () => {
  assert.equal(redactValues('+91 90000 48261', [], [ADMIN], CC), '«redacted:SIGNIN_MOBILE»');
  assert.equal(redactValues('919000048261', [], [ADMIN], CC), '«redacted:SIGNIN_MOBILE»');
  assert.equal(redactValues('09000048261', [], [ADMIN], CC), '«redacted:SIGNIN_MOBILE»');
  assert.equal(redactValues('90000-48261', [], [ADMIN], CC), '«redacted:SIGNIN_MOBILE»');
});

test('redacts the PIN with the existing «redacted» marker', () => {
  assert.equal(redactValues('typed "4826"', ['4826'], [ADMIN]), 'typed "«redacted»"');
});

test('a PIN occurring inside the mobile does not break mobile redaction', () => {
  const out = redactValues('mobile 9000048261 then pin 4826', ['4826'], [ADMIN]);
  assert.equal(out, 'mobile «redacted:SIGNIN_MOBILE» then pin «redacted»');
  assert.doesNotMatch(out, /9000/);
});

test('redaction is idempotent', () => {
  const once = redactValues('9000048261 / 4826', ['4826'], [ADMIN]);
  assert.equal(redactValues(once, ['4826'], [ADMIN]), once);
});

test('text without sensitive values is unchanged', () => {
  const text = 'clicked [data-testid="signin-continue"] after 1500ms';
  assert.equal(redactValues(text, ['4826'], [ADMIN]), text);
});

// ─── env wiring ──────────────────────────────────────────────────────────────

test('an email/username login is redacted literally and case-insensitively', () => {
  const EMAIL = { name: 'ADMIN_EMAIL', digits: '', text: 'ops@example.com' };
  assert.equal(redactValues('signed in as OPS@example.com', [], [EMAIL]), 'signed in as «redacted:ADMIN_EMAIL»');
});

test('identifierValues and secretValues come from the app .env', () => {
  assert.deepEqual(identifierValues(), [
    { name: 'SIGNIN_MOBILE', digits: '9000048261' },
    { name: 'STAFF_MOBILE', digits: '8000011112' },
  ]);
  assert.deepEqual(secretValues(), ['4826', '1357']);
});

test('redactSecrets covers both identities as a flow-run manifest would record them', () => {
  const input = 'typed "9000048261" · staff 80000 11112 · pins 4826 1357';
  assert.equal(
    redactSecrets(input),
    'typed "«redacted:SIGNIN_MOBILE»" · staff «redacted:STAFF_MOBILE» · pins «redacted» «redacted»',
  );
});

test('log lines are redacted before they reach the console', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { log } = require('../logger') as typeof import('../logger');
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.log = grab; console.warn = grab; console.error = grab;
  try {
    log.step('typed "9000048261"');
    log.error('admin sign-in failed — "No account for +91 90000 48261"', 'pin 4826');
    log.banner('run for 9000048261');
  } finally {
    Object.assign(console, orig);
  }
  const all = lines.join('\n');
  assert.doesNotMatch(all, /9000048261|90000 48261|4826(?!1)/);
  assert.match(all, /«redacted:SIGNIN_MOBILE»/);
  assert.match(all, /«redacted»/);
});

test('a credential set in the shell or the root .env is ignored, and said so', () => {
  process.env.SIGNIN_PIN = '9999';
  useSampleApp({ SIGNIN_MOBILE: '9000048261', SIGNIN_PIN: '4826' });
  try {
    assert.deepEqual(secretValues(), ['4826']);
    assert.ok(envMod.envWarnings().some((w) => w.startsWith('SIGNIN_PIN is set outside')));
  } finally {
    delete process.env.SIGNIN_PIN;
    useSampleApp({ SIGNIN_MOBILE: '9000048261', SIGNIN_PIN: '4826', STAFF_MOBILE: '+91 80000 11112', STAFF_PIN: '1357' });
  }
});

// ─── committed files ─────────────────────────────────────────────────────────

/** A line `KEY=value` whose key names a credential, a secret or an API key. */
const SENSITIVE_KEY = /(PIN|PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|MOBILE|PHONE|EMAIL|USERNAME)$/;

for (const example of ['.env.example', 'apps/_template/.env.example']) {
  test(`${example} carries placeholders only for credentials and identifiers`, () => {
    const text = fs.readFileSync(path.join(ROOT, example), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)=(.*)$/);
      if (!m || !SENSITIVE_KEY.test(m[1])) continue;
      assert.equal(m[2].trim(), '', `${example} ${m[1]} must be empty — real values belong in apps/<app-id>/.env only`);
    }
  });
}

test('the root .env.example holds no credential variables at all', () => {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/);
    if (m && m[1] !== 'ANTHROPIC_API_KEY') assert.doesNotMatch(m[1], SENSITIVE_KEY, `root .env.example declares ${m[1]} — credentials go in apps/<app-id>/.env`);
  }
});

test('.env.example keeps discovery page-content LLM calls off', () => {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(text, /^DISCOVERY_LLM_SEND_PAGE_CONTENT=false$/m);
});

/** A mobile-shaped number (Indian 10-digit, optional +91, optional 5+5 split) standing alone. */
const MOBILE_SHAPE = /(?<![0-9A-Za-z])(?:[+]?91[ -]*)?[6-9][0-9]{4}[ -]?[0-9]{5}(?![0-9A-Za-z])/;

function textFilesUnder(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(json|md|ya?ml)$/i.test(e.name)) out.push(f);
    }
  };
  walk(abs);
  return out;
}

test('committed docs, flows and app profiles contain no mobile-shaped number', () => {
  // apps/ is committed (profiles, flows, inventories), so every profile is held to this too.
  for (const file of ['docs', 'flows', 'apps'].flatMap(textFilesUnder)) {
    const m = fs.readFileSync(file, 'utf8').match(MOBILE_SHAPE);
    // Report the file, never the match — the match may be real personal data.
    assert.equal(m, null, `mobile-shaped number in ${path.relative(ROOT, file)}`);
  }
});

// ─── app-agnostic core ───────────────────────────────────────────────────────

test('no tracked file outside docs/ names a local app profile or its hosts', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const appsRoot = path.join(ROOT, 'apps');
  if (!fs.existsSync(appsRoot)) return;
  const needles = new Set<string>();
  for (const id of fs.readdirSync(appsRoot)) {
    const cfg = path.join(appsRoot, id, 'app.config.json');
    if (id === '_template' || !fs.existsSync(cfg)) continue;
    const c = JSON.parse(fs.readFileSync(cfg, 'utf8')) as { appName?: string; allowedHosts?: string[] };
    if (c.appName && c.appName.length >= 4) needles.add(c.appName.toLowerCase());
    for (const h of c.allowedHosts ?? []) if (!['localhost', '127.0.0.1'].includes(h)) needles.add(h.toLowerCase());
  }
  if (!needles.size) return;
  let tracked: string[];
  try {
    tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return; // not a git checkout
  }
  for (const rel of tracked) {
    if (rel.startsWith('docs/') || /\.(png|zip|jpe?g)$/i.test(rel)) continue;
    // An app's own committed profile folder is exactly where its details belong.
    if (/^apps\/(?!_template\/)[^/]+\//.test(rel)) continue;
    // So is its own capture output, where a repo's owner chooses to commit it.
    if (/^runs\/[^/]+\//.test(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8').toLowerCase();
    for (const n of needles) assert.equal(text.includes(n), false, `${rel} mentions a local app profile ("${n}") — app details belong in apps/<app-id>/`);
  }
});
