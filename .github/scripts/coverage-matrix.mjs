// Prints the CI matrix for the coverage audit, read from the app profiles —
// so registering an app (apps/<id>/app.config.json with a `source` block) is
// all it takes to audit it in CI. No app is named in the workflow itself.
//
//   { "include": [ { "app": "<id>", "repository": "<owner/name>", "env": "APP_REPO_PATH_<ID>" } ] }
//
// Apps without a `source` block are listed under "unconfigured" and reported
// by the workflow, never silently dropped.
import fs from 'node:fs';
import path from 'node:path';

const apps = path.resolve(process.argv[2] ?? 'apps');
const include = [];
const unconfigured = [];
// The same id rule as src/profile.ts — and it keeps a folder name from ever
// reaching a shell as anything but a plain word.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
for (const id of fs.readdirSync(apps).sort()) {
  if (id.startsWith('_')) continue;
  if (!ID_RE.test(id)) {
    unconfigured.push(id.replace(/[^\w.-]/g, '?'));
    continue;
  }
  const file = path.join(apps, id, 'app.config.json');
  if (!fs.existsSync(file)) continue;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const repository = cfg?.source?.repository;
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    unconfigured.push(id);
    continue;
  }
  include.push({ app: id, repository, env: `APP_REPO_PATH_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}` });
}
process.stdout.write(JSON.stringify({ include, unconfigured }));
