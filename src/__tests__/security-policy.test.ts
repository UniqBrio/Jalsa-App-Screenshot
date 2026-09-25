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

// node --test runs each file in its own process, so these land before env.ts
// (and dotenv, which never overrides an existing variable) is first loaded.
process.env.SIGNIN_MOBILE = '9000048261';
process.env.SIGNIN_PIN = '4826';
process.env.STAFF_MOBILE = '+91 80000 11112';
process.env.STAFF_PIN = '1357';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const envMod = require('../env') as typeof import('../env');
const { redactValues, redactSecrets, identifierValues, secretValues, ROOT } = envMod;

const ADMIN = { name: 'SIGNIN_MOBILE', digits: '9000048261' };

// ─── redactValues (pure) ─────────────────────────────────────────────────────

test('redacts a bare ten-digit mobile with a named token', () => {
  assert.equal(redactValues('typed "9000048261"', [], [ADMIN]), 'typed "«redacted:SIGNIN_MOBILE»"');
});

test('redacts the spaced form the sign-in field renders', () => {
  assert.equal(redactValues('No account for 90000 48261', [], [ADMIN]), 'No account for «redacted:SIGNIN_MOBILE»');
});

test('redacts +91, 91 and 0 prefixed and hyphenated forms, prefix included', () => {
  assert.equal(redactValues('+91 90000 48261', [], [ADMIN]), '«redacted:SIGNIN_MOBILE»');
  assert.equal(redactValues('919000048261', [], [ADMIN]), '«redacted:SIGNIN_MOBILE»');
  assert.equal(redactValues('09000048261', [], [ADMIN]), '«redacted:SIGNIN_MOBILE»');
  assert.equal(redactValues('90000-48261', [], [ADMIN]), '«redacted:SIGNIN_MOBILE»');
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

test('identifierValues and secretValues come from the environment', () => {
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

// ─── committed files ─────────────────────────────────────────────────────────

const SENSITIVE_KEYS = ['SIGNIN_MOBILE', 'SIGNIN_PIN', 'STAFF_MOBILE', 'STAFF_PIN', 'ANTHROPIC_API_KEY'];

test('.env.example carries placeholders only for credentials and identifiers', () => {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const key of SENSITIVE_KEYS) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*#?\\s*${key}=(.*)$`));
      if (!m) continue;
      assert.equal(m[1].trim(), '', `.env.example ${key} must be empty — real values belong in .env only`);
    }
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

test('committed run manifests, docs and recordings contain no mobile-shaped number', () => {
  for (const file of ['runs', 'docs', 'recordings'].flatMap(textFilesUnder)) {
    const m = fs.readFileSync(file, 'utf8').match(MOBILE_SHAPE);
    // Report the file, never the match — the match may be real personal data.
    assert.equal(m, null, `mobile-shaped number in ${path.relative(ROOT, file)}`);
  }
});
