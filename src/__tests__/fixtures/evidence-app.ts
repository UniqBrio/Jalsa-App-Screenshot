/**
 * "Sample App": a synthetic, offline app (sign in → courses → course roster →
 * member), served to Playwright by request interception at
 * https://fixture.test — no network, no live account.
 *
 * Its test ids match the Sample App fixture profile
 * (fixtures/apps/sample-app/config/pii-regions.json), and it deliberately contains
 * every hazard the classifier must handle: a member list, an email, the
 * operator's number echoed on screen, a PIN field, a record-screen heading that
 * is a person's name, an app placeholder that looks like a name, and a fixed
 * bottom bar lying over a roster row.
 *
 * Every name, email and number here is synthetic.
 */
import type { BrowserContext, Route } from '@playwright/test';

export const FIXTURE_ORIGIN = 'https://fixture.test';
export const SYNTHETIC_MOBILE = '9000048261';
export const SYNTHETIC_PIN = '4826';
export const COURSE_ID = '6f1c2a9e-1111-4a3b-9c2d-000000000001';
export const MEMBER_ID = '7a2b3c4d-2222-4b5c-8d6e-000000000009';

/** Strings that must never appear raw in any evidence file. */
export const FIXTURE_PII = [
  'Priya Raman', 'priya.raman@example.com', 'Zoya Khan', 'Meera Iyer', 'Arjun Menon',
  SYNTHETIC_MOBILE, '90000 48261', COURSE_ID, MEMBER_ID,
];

const ROSTER = [
  'Priya Raman', 'Arjun Menon', 'Divya Nair', 'Kavya Rao', 'Rahul Das', 'Sneha Pillai',
  'Vikram Shah', 'Anita Joseph', 'Farah Ali', 'Zoya Khan', 'Nikhil Bose', 'Leela Varma',
];

const shell = (body: string, script = '') => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { margin: 0; font: 16px/1.3 system-ui, sans-serif; background: #111; color: #eee; }
  button, [role=button] { font: inherit; display: block; margin: 8px 16px; padding: 10px; background: #333; color: #eee; border: 0; }
  input { font: inherit; margin: 8px 16px; padding: 10px; width: 300px; }
  [hidden] { display: none !important; }
</style>
<script>
  // Counts every install of the evidence probes, so a test can prove normal capture never injects them.
  (function () {
    var v;
    Object.defineProperty(window, '__ubProbe', { configurable: true, get: function () { return v; },
      set: function (x) { v = x; try { fetch('/__probe-installed', { method: 'POST', keepalive: true }); } catch (e) {} } });
  })();
</script></head>
<body>${body}<script>${script}</script></body></html>`;

function signIn(): string {
  return shell(
    `<h1>Welcome back</h1>
     <p>Your number, then your 4-digit PIN.</p>
     <input data-testid="signin-phone" type="tel" aria-label="Mobile number" placeholder="Mobile number">
     <div data-testid="signin-echo" id="echo"></div>
     <button data-testid="signin-continue" onclick="location.href='/pin'">Continue</button>`,
    `document.querySelector('[data-testid=signin-phone]').addEventListener('input', function (e) {
       var d = e.target.value.replace(/\\D/g, '');
       document.getElementById('echo').textContent = d ? '+91 ' + d.slice(0, 5) + (d.length > 5 ? ' ' + d.slice(5) : '') : '';
     });`,
  );
}

function pin(): string {
  return shell(
    `<h1>Enter your PIN</h1>
     <p>+91 90000 48261</p>
     <input data-testid="signin-pin" type="password" inputmode="numeric" aria-label="PIN">`,
    `document.querySelector('[data-testid=signin-pin]').addEventListener('input', function (e) {
       if (e.target.value.length === 4) setTimeout(function () { location.href = '/courses'; }, 150);
     });`,
  );
}

function courses(): string {
  return shell(
    `<header data-testid="shell-org" data-tenant-id="sample-tenant-0001">Sample Org (test)</header>
     <nav role="tablist">
       <button role="tab" data-testid="nav-tab-overview">Overview</button>
       <button role="tab" aria-selected="true" data-testid="nav-tab-attendance">Attendance</button>
     </nav>
     <button data-testid="courses-add-member">Add member</button>
     <div role="list">
       <button data-testid="courses-open-${COURSE_ID}" onclick="location.href='/course/${COURSE_ID}'">General · Coach Meera Iyer</button>
       <button data-testid="courses-open-6f1c2a9e-1111-4a3b-9c2d-000000000002">Postnatal · Coach Meera Iyer</button>
     </div>
     <div role="dialog" data-testid="member-form" hidden>
       <h2>Welcome a new member</h2>
       <input aria-label="Member name" placeholder="e.g. Anitha Rajesh">
       <button data-testid="member-close" aria-label="Close">×</button>
     </div>`,
    `document.querySelector('[data-testid=courses-add-member]').onclick = function () { document.querySelector('[data-testid=member-form]').hidden = false; };
     document.querySelector('[data-testid=member-close]').onclick = function () { document.querySelector('[data-testid=member-form]').hidden = true; };`,
  );
}

function course(): string {
  const rows = ROSTER.map((name, i) =>
    `<div role="button" tabindex="0"${i === 9 ? ' data-testid="roster-row-under-bar"' : ''} data-name="${name}" aria-label="${name}, ${i % 3 ? 'active' : 'inactive'}. 3 expected, 2 attended"
       style="position:absolute;left:0;right:0;top:${i * 64}px;height:60px;margin:0 16px;background:#222"
       onclick="location.href='/member/${MEMBER_ID}'"><span>${name}</span> <span>${name.split(' ')[0].toLowerCase()}.${name.split(' ')[1].toLowerCase()}@example.com</span></div>`,
  ).join('');
  return shell(
    `<button data-testid="course-back" aria-label="Back" onclick="history.back()">←</button>
     <h1 style="margin:0 16px">General</h1>
     <input data-testid="course-member-search" placeholder="Search members">
     <div role="list" id="roster" style="position:absolute;top:180px;left:0;right:0;height:900px">${rows}</div>
     <nav role="tablist" data-testid="bottom-bar" style="position:fixed;left:0;right:0;bottom:0;height:100px;background:#000;z-index:10">
       <button role="tab">Home</button><button role="tab">Reports</button><button role="tab">More</button>
     </nav>`,
    `var all = Array.from(document.querySelectorAll('#roster > [role=button]'));
     document.querySelector('[data-testid=course-member-search]').addEventListener('input', function (e) {
       var q = e.target.value.toLowerCase(); var roster = document.getElementById('roster');
       all.forEach(function (row) { var keep = row.getAttribute('data-name').toLowerCase().indexOf(q) !== -1;
         if (keep && !row.parentNode) roster.appendChild(row); if (!keep && row.parentNode) row.remove(); });
     });`,
  );
}

function member(): string {
  return shell(
    `<div role="dialog">
       <h1>Priya Raman</h1>
       <div data-testid="member-details"><p>priya.raman@example.com</p><p>Member since 2025</p></div>
       <button data-testid="member-close" onclick="history.back()">Close</button>
     </div>`,
  );
}

export interface FixtureServer {
  probeInstalls: number;
}

/** Serves the fixture on every page of `context`. Nothing reaches the network. */
export async function serveFixture(context: BrowserContext): Promise<FixtureServer> {
  const server: FixtureServer = { probeInstalls: 0 };
  await context.route('**/*', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin !== FIXTURE_ORIGIN) return route.abort();
    const html = (body: string) => route.fulfill({ status: 200, contentType: 'text/html', body });
    if (url.pathname === '/__probe-installed') { server.probeInstalls += 1; return route.fulfill({ status: 204, body: '' }); }
    if (url.pathname === '/') return html(signIn());
    if (url.pathname === '/pin') return html(pin());
    if (url.pathname === '/courses') return html(courses());
    if (url.pathname.startsWith('/course/')) return html(course());
    if (url.pathname.startsWith('/member/')) return html(member());
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  });
  return server;
}
