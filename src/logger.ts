/**
 * Minimal console logger with consistent prefixes.
 *
 * Every line passes through redactSecrets here, once, rather than at each call
 * site: log output ends up in CI logs and pasted bug reports, and a login error
 * that quotes page text ("No account for +91 …") must not carry the operator's
 * number with it just because that call site forgot.
 */
import { redactSecrets } from './env';

const t = () => new Date().toISOString().slice(11, 19);
const r = (rest: unknown[]) => rest.map((x) => (typeof x === 'string' ? redactSecrets(x) : x));

export const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`[${t()}] ${redactSecrets(msg)}`, ...r(rest)),
  step: (msg: string, ...rest: unknown[]) => console.log(`[${t()}]   → ${redactSecrets(msg)}`, ...r(rest)),
  ok: (msg: string, ...rest: unknown[]) => console.log(`[${t()}] ✓ ${redactSecrets(msg)}`, ...r(rest)),
  skip: (msg: string, ...rest: unknown[]) => console.log(`[${t()}] ⊘ ${redactSecrets(msg)}`, ...r(rest)),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`[${t()}] ! ${redactSecrets(msg)}`, ...r(rest)),
  error: (msg: string, ...rest: unknown[]) => console.error(`[${t()}] ✗ ${redactSecrets(msg)}`, ...r(rest)),
  banner: (msg: string) => {
    const safe = redactSecrets(msg);
    const line = '─'.repeat(Math.max(8, Math.min(76, safe.length + 2)));
    console.log(`\n┌${line}┐\n│ ${safe} │\n└${line}┘`);
  },
};
