/** Minimal, dependency-free console logger with consistent prefixes. */

const t = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`[${t()}] ${msg}`, ...rest),
  step: (msg: string, ...rest: unknown[]) => console.log(`[${t()}]   → ${msg}`, ...rest),
  ok: (msg: string, ...rest: unknown[]) => console.log(`[${t()}] ✓ ${msg}`, ...rest),
  skip: (msg: string, ...rest: unknown[]) => console.log(`[${t()}] ⊘ ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`[${t()}] ! ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`[${t()}] ✗ ${msg}`, ...rest),
  banner: (msg: string) => {
    const line = '─'.repeat(Math.max(8, Math.min(76, msg.length + 2)));
    console.log(`\n┌${line}┐\n│ ${msg} │\n└${line}┘`);
  },
};
