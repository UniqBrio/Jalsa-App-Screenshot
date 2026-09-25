/**
 * Dummy-account write gates.
 *
 * Every app is read-only by default: a flow signed in as a real account can
 * never write, and validation refuses one that tries. The single exception is
 * the dummy account, in its own separate test tenant. A flow may write only
 * when ALL of these hold:
 *
 *   1. WRITE_MODE=dummy
 *   2. the flow declares `writes: true` AND `auth: dummy`
 *   3. the host is in the profile's writeAllowedHosts
 *   4. after sign-in, the tenant id AND name the app shows equal the profile's
 *      dummy fingerprint exactly
 *
 * 1 off → write flows are skipped with a reason (writes are simply off).
 * 1 on and any of 2-4 failing → the whole run aborts before the first action.
 *
 * Data hygiene rules enforced here and in flow-loader.ts:
 *   · every value that creates a record carries {{RUN_TAG}} (run_tag: true),
 *     so everything a run created is identifiable by its run id
 *   · teardown deletes only tagged records: the executor refuses an
 *     interactive teardown step unless the run tag is on screen
 *   · contact data is synthetic: @example.com-style emails, obviously fake phones
 *   · a write flow that sends email/SMS/WhatsApp is skipped and flagged unless
 *     the dummy tenant's messaging is switched off (dummyAccount.messagingSuppressed)
 */
import { Page } from '@playwright/test';
import type { AppProfile, TenantProbe } from './profile';
import { DUMMY_IDENTITY } from './profile';
import type { Flow, FlowStep } from './types';

export class DummyIdentityError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `DUMMY IDENTITY CHECK FAILED — aborting before any flow acts:\n` +
        problems.map((p) => `  • ${p}`).join('\n'),
    );
    this.name = 'DummyIdentityError';
  }
}

/** A step that creates data: explicitly flagged, or a typed value marked as tagged. */
export function isWriteStep(step: FlowStep): boolean {
  return step.creates_data === true || step.run_tag === true;
}

/** A flow that writes: it says so, or any of its steps does. */
export function isWriteFlow(flow: Flow): boolean {
  if (flow.writes === true) return true;
  const all = [...(flow.setup ?? []), ...(flow.steps ?? []), ...(flow.teardown ?? [])];
  return all.some((s) => s && typeof s === 'object' && isWriteStep(s));
}

export interface WriteGateContext {
  writeMode: 'dummy' | 'off';
  host: string;
  writeAllowedHosts: string[];
  profile: Pick<AppProfile, 'id' | 'dummyAccount'>;
}

/**
 * Gates 2 and 3, plus a configured fingerprint, for one write flow in dummy
 * mode. Gate 4 needs a browser (verifyDummyIdentity). Empty = pass.
 */
export function staticWriteGateProblems(flow: Flow, ctx: WriteGateContext): string[] {
  const where = `${flow.module}/${flow.flow}`;
  const p: string[] = [];
  if (ctx.writeMode !== 'dummy') p.push(`${where}: WRITE_MODE is not "dummy"`);
  if (flow.writes !== true) p.push(`${where}: writes a record but does not declare "writes: true"`);
  if (flow.auth !== DUMMY_IDENTITY) p.push(`${where}: writes but signs in as "${flow.auth ?? '(default)'}" — only "auth: ${DUMMY_IDENTITY}" may write`);
  if (!ctx.writeAllowedHosts.includes(ctx.host)) {
    p.push(`${where}: host "${ctx.host}" is not in writeAllowedHosts of apps/${ctx.profile.id}/app.config.json`);
  }
  const fp = ctx.profile.dummyAccount?.fingerprint;
  if (!fp) p.push(`${where}: apps/${ctx.profile.id}/app.config.json has no dummyAccount fingerprint`);
  else if (!fp.tenantId.trim() || !fp.tenantName.trim()) {
    p.push(`${where}: dummyAccount.fingerprint needs both tenantId and tenantName filled in`);
  }
  return p;
}

/** Why a write flow must be skipped because it would message real people, or null. */
export function messagingBlock(flow: Flow, profile: Pick<AppProfile, 'dummyAccount'>): string | null {
  const channels = flow.sends_messages ?? [];
  if (!channels.length) return null;
  if (profile.dummyAccount?.messagingSuppressed === true) return null;
  return (
    `sends ${channels.join('/')} and the dummy tenant's outbound messaging is not switched off ` +
    `(dummyAccount.messagingSuppressed is not true) — skipped so no real message can go out`
  );
}

async function readProbe(page: Page, probe: TenantProbe): Promise<string | null> {
  if (probe.urlPattern) {
    const m = page.url().match(new RegExp(probe.urlPattern));
    return m?.[1] ?? null;
  }
  if (!probe.selector) return null;
  const loc = page.locator(probe.selector).first();
  await loc.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => undefined);
  if (probe.attribute) return loc.getAttribute(probe.attribute, { timeout: 2_000 }).catch(() => null);
  const text = await loc.innerText({ timeout: 2_000 }).catch(() => null);
  return text === null ? null : text;
}

const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Compares what the app shows against the expected fingerprint. Pure. */
export function compareTenant(
  expected: { tenantId: string; tenantName: string },
  actual: { tenantId: string | null; tenantName: string | null },
): string[] {
  const p: string[] = [];
  if (!expected.tenantId.trim() || !expected.tenantName.trim()) {
    p.push('the dummy fingerprint in app.config.json is incomplete (tenantId and tenantName are both required)');
    return p;
  }
  if (actual.tenantId === null) p.push('could not read the tenant id after sign-in (check tenantIdProbe)');
  else if (norm(actual.tenantId) !== norm(expected.tenantId)) {
    p.push(`signed-in tenant id "${norm(actual.tenantId)}" is not the dummy tenant "${expected.tenantId}"`);
  }
  if (actual.tenantName === null) p.push('could not read the tenant name after sign-in (check tenantNameProbe)');
  else if (norm(actual.tenantName) !== norm(expected.tenantName)) {
    p.push(`signed-in tenant name "${norm(actual.tenantName)}" is not the dummy tenant "${expected.tenantName}"`);
  }
  return p;
}

/** Gate 4: reads the tenant off the signed-in page and compares it exactly. */
export async function verifyDummyIdentity(
  page: Page,
  profile: Pick<AppProfile, 'id' | 'dummyAccount'>,
): Promise<{ ok: boolean; problems: string[] }> {
  const d = profile.dummyAccount;
  if (!d) return { ok: false, problems: [`apps/${profile.id}/app.config.json has no dummyAccount section`] };
  const actual = {
    tenantId: await readProbe(page, d.fingerprint.tenantIdProbe),
    tenantName: await readProbe(page, d.fingerprint.tenantNameProbe),
  };
  const problems = compareTenant(d.fingerprint, actual);
  return { ok: problems.length === 0, problems };
}

// ─── synthetic contact data ──────────────────────────────────────────────────

/** RFC 2606 / 6761 reserved names: mail to them can never reach a person. */
const RESERVED_EMAIL_DOMAIN = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org)|[a-z0-9-]+\.(?:example|test|invalid|localhost))$/i;
const EMAIL_TOKEN = /[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g;
/** A run of 7+ digits, allowing the usual separators. */
const PHONE_TOKEN = /\+?\d[\d\s().-]{5,}\d/g;

/** An obviously fake phone number: NANP 555, a long run of one digit, or listed in the profile. */
export function isSyntheticPhone(raw: string, allowed: string[] = []): boolean {
  const d = raw.replace(/\D/g, '');
  if (d.length < 7) return true; // not a phone number
  if (allowed.some((a) => a.replace(/\D/g, '') === d)) return true;
  // NANP: area code 555 is never assigned to a subscriber, so the whole range is
  // unroutable — not only numbers that END 555-01xx (an area code sits at the front).
  const national = d.replace(/^1(?=\d{10}$)/, '');
  if (/^555\d{7}$/.test(national)) return true;
  if (/55501\d{2}$/.test(d)) return true;
  if (/(\d)\1{5,}/.test(d)) return true;
  return false;
}

/**
 * Problems with a literal a write flow would type. `{{VAR}}` placeholders are
 * removed first: they are the run tag or credentials, checked elsewhere.
 */
export function syntheticDataProblems(value: string, allowedPhones: string[] = []): string[] {
  const text = value.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, ' ');
  const p: string[] = [];
  for (const email of text.match(EMAIL_TOKEN) ?? []) {
    if (!RESERVED_EMAIL_DOMAIN.test(email)) p.push(`email "${email}" is not on a reserved domain (use @example.com)`);
  }
  for (const phone of text.match(PHONE_TOKEN) ?? []) {
    if (!isSyntheticPhone(phone, allowedPhones)) {
      p.push(`phone "${phone.trim()}" is not an obviously fake number (use 555-01xx, a repeated digit, or list it in dummyAccount.syntheticPhones)`);
    }
  }
  return p;
}
