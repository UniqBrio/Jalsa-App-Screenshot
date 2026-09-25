/**
 * Preloaded by `npm test` (node -r) into every test process: selects the
 * synthetic Sample App profile, whatever APP the shell happens to export, so
 * no test can ever read a real app's profile or credentials.
 */
import * as path from 'path';

process.env.APPS_DIR = path.join(__dirname, 'fixtures', 'apps');
process.env.APP = 'sample-app';
