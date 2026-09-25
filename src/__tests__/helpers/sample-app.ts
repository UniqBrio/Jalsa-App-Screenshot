/**
 * Test app selection. Every test runs against the synthetic "Sample App"
 * profile in fixtures/apps/sample-app — never a real app's profile.
 *
 * `useSampleApp(appEnv)` copies that profile to a temp apps/ directory, writes
 * the given values as its .env (credentials are read from an app's .env and
 * nowhere else), points APPS_DIR/APP at it, and makes env.ts reload. Every
 * value a test passes is synthetic.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const FIXTURE_APPS_DIR = path.join(__dirname, '..', 'fixtures', 'apps');
export const SAMPLE_APP = 'sample-app';

const made: string[] = [];

export function useSampleApp(appEnv: Record<string, string> = {}, patchConfig?: (cfg: any) => void): string {
  const apps = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-apps-'));
  made.push(apps);
  const dir = path.join(apps, SAMPLE_APP);
  fs.cpSync(path.join(FIXTURE_APPS_DIR, SAMPLE_APP), dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.env'),
    Object.entries(appEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
  );
  if (patchConfig) {
    const file = path.join(dir, 'app.config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    patchConfig(cfg);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  }
  process.env.APPS_DIR = apps;
  process.env.APP = SAMPLE_APP;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (require('../../env') as typeof import('../../env')).resetAppContext();
  return dir;
}

process.on('exit', () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
