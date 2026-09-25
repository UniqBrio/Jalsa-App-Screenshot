/**
 * App profiles, app selection, the host gate and login adapter configuration.
 * Everything runs against the synthetic Sample App profile or the committed
 * apps/_template — never a real app's profile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { useSampleApp, FIXTURE_APPS_DIR } from './helpers/sample-app';

/* eslint-disable @typescript-eslint/no-var-requires */
const prof = require('../profile') as typeof import('../profile');
const envMod = require('../env') as typeof import('../env');
const { createLoginAdapter } = require('../login-adapters') as typeof import('../login-adapters');
/* eslint-enable @typescript-eslint/no-var-requires */

const sampleRaw = () => JSON.parse(fs.readFileSync(path.join(FIXTURE_APPS_DIR, 'sample-app', 'app.config.json'), 'utf8'));
const parse = (patch: (c: any) => void) => {
  const c = sampleRaw();
  patch(c);
  return () => prof.parseProfile(c, 'sample-app', '/tmp/sample-app');
};

// ─── selection ───────────────────────────────────────────────────────────────

test('the app comes from --app, --app=, or APP — in that order', () => {
  const saved = process.env.APP;
  try {
    process.env.APP = 'from-env';
    assert.equal(prof.selectedAppId(['node', 'x', '--app', 'one']), 'one');
    assert.equal(prof.selectedAppId(['node', 'x', '--app=two']), 'two');
    assert.equal(prof.selectedAppId(['node', 'x']), 'from-env');
    delete process.env.APP;
    assert.equal(prof.selectedAppId(['node', 'x']), null);
  } finally {
    process.env.APP = saved;
  }
});

test('no app selected is an error naming the profiles — never a default app', () => {
  const saved = process.env.APP;
  try {
    delete process.env.APP;
    envMod.resetAppContext();
    assert.throws(() => envMod.env.appUrl, /No app selected[\s\S]*sample-app[\s\S]*no default app/);
  } finally {
    process.env.APP = saved;
    envMod.resetAppContext();
  }
});

test('an unknown app id is an error that lists the profiles', () => {
  assert.throws(() => prof.loadProfile(path.join(FIXTURE_APPS_DIR, '..', '..', '..', '..'), 'nope'), /App profile "nope" not found/);
});

// ─── profile parsing ─────────────────────────────────────────────────────────

test('the Sample App fixture profile parses', () => {
  const p = parse(() => undefined)();
  assert.equal(p.appName, 'Sample App');
  assert.deepEqual(Object.keys(p.accounts), ['admin', 'staff', 'dummy']);
  assert.equal(p.defaultAccount, 'admin');
});

test('the committed apps/_template profile parses and its login adapter is complete', () => {
  const root = path.resolve(__dirname, '..', '..');
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'apps', '_template', 'app.config.json'), 'utf8'));
  const p = prof.parseProfile(raw, '_template', path.join(root, 'apps', '_template'));
  assert.deepEqual(createLoginAdapter(p).configErrors(), []);
  assert.deepEqual(p.writeAllowedHosts, [], 'the template allows writes nowhere until someone decides otherwise');
});

test('missing required fields are all reported at once', () => {
  const err = (() => { try { parse((c) => { delete c.appName; delete c.baseUrl; c.allowedHosts = []; })(); } catch (e) { return (e as Error).message; } return ''; })();
  assert.match(err, /appName/);
  assert.match(err, /baseUrl/);
  assert.match(err, /allowedHosts/);
});

test('writeAllowedHosts must be a subset of allowedHosts', () => {
  assert.throws(parse((c) => { c.writeAllowedHosts = ['prod.example.com']; }), /writeAllowedHosts: "prod.example.com" must also be in allowedHosts/);
});

test('the dummy account can never be the default identity, and "none" is reserved', () => {
  assert.throws(parse((c) => { c.defaultAccount = 'dummy'; }), /may not be "dummy"/);
  assert.throws(parse((c) => { c.accounts.none = { userEnv: 'X_USER', secretEnv: 'X_PASS' }; }), /"none" is reserved/);
});

test('two accounts may not share a credential variable, and credentials are not extraEnvVars', () => {
  assert.throws(parse((c) => { c.accounts.staff.secretEnv = 'SIGNIN_PIN'; }), /already used by another account/);
  assert.throws(parse((c) => { c.extraEnvVars = ['SIGNIN_PIN']; }), /is a credential variable/);
});

test('a dummyAccount section needs an accounts.dummy entry and readable probes', () => {
  assert.throws(parse((c) => { delete c.accounts.dummy; }), /needs an accounts.dummy entry/);
  assert.throws(parse((c) => { c.dummyAccount.fingerprint.tenantIdProbe = {}; }), /tenantIdProbe: needs "selector" or "urlPattern"/);
  assert.throws(parse((c) => { c.dummyAccount.fingerprint.tenantIdProbe = { urlPattern: 't/[a-z]+' }; }), /needs one capture group/);
});

// ─── host gate ───────────────────────────────────────────────────────────────

test('the safety gate passes the profile host and refuses any other', () => {
  useSampleApp({});
  assert.doesNotThrow(() => envMod.assertTargetEnvironment());
  useSampleApp({ APP_URL: 'https://evil.example.net' });
  assert.throws(() => envMod.assertTargetEnvironment(), /Host "evil.example.net" is not in allowedHosts of apps\/sample-app/);
  useSampleApp({ APP_URL: 'http://fixture.test' });
  assert.throws(() => envMod.assertTargetEnvironment(), /must be https unless it points at localhost/);
  useSampleApp({});
});

test('write mode is off unless the app .env (or shell) says exactly dummy', () => {
  useSampleApp({});
  assert.equal(envMod.env.writeMode, 'off');
  useSampleApp({ WRITE_MODE: 'yes' });
  assert.equal(envMod.env.writeMode, 'off');
  useSampleApp({ WRITE_MODE: 'dummy' });
  assert.equal(envMod.env.writeMode, 'dummy');
  useSampleApp({});
});

// ─── login adapters ──────────────────────────────────────────────────────────

test('each adapter names the selectors it is missing and rejects ones it does not use', () => {
  const mobile = parse(() => undefined)();
  assert.deepEqual(createLoginAdapter(mobile).configErrors(), []);

  const noPin = parse((c) => { delete c.loginAdapter.selectors.pin; })();
  assert.ok(createLoginAdapter(noPin).configErrors().some((e) => /selectors\.pin: required/.test(e)));

  const email = parse((c) => {
    c.loginAdapter = { type: 'email-password', selectors: { email: '#e', password: '#p', submit: '#s', signedIn: '#in', phone: '#x' }, options: { typing: 'slow' } };
  })();
  const errs = createLoginAdapter(email).configErrors();
  assert.ok(errs.some((e) => /selectors\.phone: not used by this adapter/.test(e)));
  assert.ok(errs.some((e) => /typing: "fill" or "sequential"/.test(e)));

  const user = parse((c) => {
    c.loginAdapter = { type: 'username-password', selectors: { username: '#u', password: '#p', submit: '#s', signedIn: '#in' }, options: {} };
  })();
  assert.deepEqual(createLoginAdapter(user).configErrors(), []);
});

test('adapter preflight explains a missing credential without quoting any value', () => {
  const creds = (user: string, secret: string) => ({ user, secret, userEnv: 'U_ENV', secretEnv: 'S_ENV', optional: false });
  const mobile = createLoginAdapter(parse(() => undefined)());
  assert.equal(mobile.preflight('admin', creds('9000048261', '4826')), null);
  assert.match(mobile.preflight('admin', creds('90000', '4826'))!, /U_ENV is not set .* 10-digit/);
  assert.match(mobile.preflight('admin', creds('9000048261', '48'))!, /S_ENV .* 4 digits/);

  const email = createLoginAdapter(parse((c) => {
    c.loginAdapter = { type: 'email-password', selectors: { email: '#e', password: '#p', submit: '#s', signedIn: '#in' }, options: {} };
  })());
  assert.equal(email.preflight('admin', creds('ops@example.com', 'pw')), null);
  const bad = email.preflight('admin', creds('not-an-email', 'pw'))!;
  assert.match(bad, /U_ENV .* is not an email address/);
  assert.doesNotMatch(bad, /not-an-email/);
});

test('email logins are identifiers (redacted literally); mobile logins keep the digit form', () => {
  useSampleApp({ SIGNIN_MOBILE: '+91 90000 48261', SIGNIN_PIN: '4826' });
  assert.deepEqual(envMod.identifierValues(), [{ name: 'SIGNIN_MOBILE', digits: '9000048261' }]);
  useSampleApp({ ADMIN_EMAIL: 'ops@example.com', ADMIN_PASSWORD: 'correct horse' }, (c) => {
    c.loginAdapter = { type: 'email-password', selectors: { email: '#e', password: '#p', submit: '#s', signedIn: '#in' }, options: {} };
    c.accounts = { admin: { userEnv: 'ADMIN_EMAIL', secretEnv: 'ADMIN_PASSWORD' } };
    delete c.dummyAccount;
  });
  assert.deepEqual(envMod.identifierValues(), [{ name: 'ADMIN_EMAIL', digits: '', text: 'ops@example.com' }]);
  assert.equal(envMod.redactSecrets('Ops@Example.com typed correct horse'), '«redacted:ADMIN_EMAIL» typed «redacted»');
  useSampleApp({});
});
