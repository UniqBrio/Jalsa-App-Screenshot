/**
 * Terminal and Markdown renderings of a CoverageReport. The JSON report is the
 * machine contract; these are for people (a terminal, a CI job summary).
 */
import type { CoverageReport, IdItem, RouteItem } from './engine';

function groupByModule<T extends { module: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(i.module, [...(m.get(i.module) ?? []), i]);
  return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

const idLine = (i: IdItem) =>
  `${i.key} — ${i.file}:${i.line} <${i.element}>${i.locatedBy ? ` (located by ${i.locatedBy.join(', ')}, never exercised)` : ''}`;
const routeLine = (r: RouteItem) =>
  `${r.path} — ${r.files.join(', ') || '(no file)'}${r.declaredBy ? ` (declared by ${r.declaredBy.join(', ')}, never visited)` : ''}`;

export function renderText(r: CoverageReport, opts: { verbose?: boolean } = {}): string {
  const out: string[] = [];
  const t = r.testids;
  const ro = r.routes;
  out.push(`Coverage — ${r.appName} (${r.app}) — ${r.mode === 'static' ? 'static (from the flow manifests)' : 'run evidence (from recorded runs)'}`);
  if (r.source) {
    out.push(
      `  Source      ${r.source.repository} @ ${r.source.commit ? r.source.commit.slice(0, 10) : 'unknown commit'} — ${r.source.root} ` +
        `(${r.source.identity}, from ${r.source.origin})`,
    );
    for (const n of r.source.notes) out.push(`              note: ${n}`);
  }
  out.push(
    `  Inventory   ${t.inventory.filesParsed}/${t.inventory.filesListed} files parsed · ${t.inventory.ids} test ids · ` +
      `${t.inventory.interactive} interactive · ${t.inventory.display} display · ${t.inventory.patterns} dynamic families · ` +
      `${t.inventory.unresolved} unresolved`,
  );
  for (const p of t.inventory.parseErrors) out.push(`              parse error: ${p.file} — ${p.message}`);
  out.push(`  Flows       ${r.flows.executable} executable${r.flows.withEvidence !== undefined ? ` · ${r.flows.withEvidence} with run evidence (runs: ${r.flows.runs?.join(', ') || 'none'})` : ''}`);
  out.push(
    `  Test ids    ${t.covered}/${t.required} exercised (${t.coveragePercent}%) · NEW uncovered ${t.newUncovered.length} · ` +
      `backlog ${t.existingUncovered.length} · excepted ${t.excepted.length}`,
  );

  if (t.newUncovered.length) {
    out.push('');
    for (const [m, items] of groupByModule(t.newUncovered)) {
      out.push(`  ${m}: ${items.length} NEW uncovered test id${items.length === 1 ? '' : 's'}`);
      for (const i of items) out.push(`    ✗ ${idLine(i)}`);
    }
  }
  if (t.existingUncovered.length) {
    out.push('');
    const g = groupByModule(t.existingUncovered);
    out.push(`  Adoption backlog (uncovered before the check existed — debt, not approval):`);
    for (const [m, items] of g) {
      out.push(`    ${m}: ${items.length}`);
      if (opts.verbose) for (const i of items) out.push(`      · ${idLine(i)}`);
    }
  }
  if (t.excepted.length && opts.verbose) {
    out.push('', '  Approved exceptions:');
    for (const i of t.excepted) out.push(`    ○ ${i.key} — ${i.reason}${i.expires ? ` (expires ${i.expires})` : ''}`);
  }
  if (t.staleReferences.length) {
    out.push('', `  Stale flow references (${t.staleReferences.length}) — the flow names a test id the source no longer has:`);
    for (const s of t.staleReferences) out.push(`    ✗ ${s.selector} — ${s.file} step ${s.step} (${s.field})`);
  }
  if (t.ambiguous.length) {
    out.push('', `  Ambiguous selectors (${t.ambiguous.length}) — they match several ids, so they cover none:`);
    for (const s of t.ambiguous) out.push(`    ? ${s.selector} — ${s.file} step ${s.step} → ${s.candidates?.slice(0, 5).join(', ')}${(s.candidates?.length ?? 0) > 5 ? ', …' : ''}`);
  }
  if (t.duplicates.length) {
    out.push('', `  Possible duplicate test ids (${t.duplicates.length}) — one id at several places (fine if they never render together):`);
    for (const d of t.duplicates.slice(0, opts.verbose ? undefined : 10)) out.push(`    ~ ${d.key} — ${d.sites.join(', ')}`);
    if (!opts.verbose && t.duplicates.length > 10) out.push(`    … ${t.duplicates.length - 10} more (--verbose)`);
  }
  if (opts.verbose && t.unresolved.length) {
    out.push('', `  Unresolved test-id attributes (${t.unresolved.length}) — forwarded props; the call sites carry the ids:`);
    for (const u of t.unresolved) out.push(`    · ${u.file}:${u.line} <${u.element} ${u.attribute}={${u.expression}}>`);
  }

  out.push('');
  if (ro.strategy === 'none') out.push('  Pages       not applicable (source.routes.strategy "none")');
  else {
    out.push(
      `  Pages       ${ro.pages} pages (+${ro.redirects} redirects) via ${ro.strategy} · ${ro.covered} visited · ` +
        `NEW unregistered ${ro.newUnregistered.length} · removed ${ro.removed.length} · NEW uncovered ${ro.newUncovered.length} · ` +
        `backlog ${ro.existingUncovered.length} · excepted ${ro.excepted.length}`,
    );
    for (const p of ro.newUnregistered) out.push(`    ✗ NEW page not in known_routes.json: ${routeLine(p)}`);
    for (const p of ro.removed) out.push(`    ✗ REMOVED page still in known_routes.json: ${p.path} (${p.module})`);
    for (const p of ro.newUncovered) out.push(`    ✗ NEW page no flow visits: ${routeLine(p)}`);
    for (const v of ro.unmatchedVisits) out.push(`    ✗ goto ${v.path} in ${v.flow} step ${v.step} matches no page`);
    if (opts.verbose) for (const p of ro.existingUncovered) out.push(`    · backlog: ${routeLine(p)}`);
    for (const d of ro.duplicates) out.push(`    ~ duplicate route ${d.path}: ${d.files.join(' + ')}`);
    for (const u of ro.unclassifiable) out.push(`    ? unclassifiable: ${u.file} — ${u.why}`);
    for (const u of ro.unverifiable) out.push(`    · virtual (not verified against source): ${u.path}`);
    if (opts.verbose) for (const g of ro.ignored) out.push(`    · not a page: ${g.file} — ${g.why}`);
  }

  out.push('');
  const ex = r.exceptions;
  out.push(`  Exceptions  ${ex.total} (${ex.outstanding.filter((o) => o.status === 'active').length} active · ${ex.expired.length} expired · ${ex.unneeded.length} no longer needed · ${ex.errors.length} invalid)`);
  for (const e of ex.errors) out.push(`    ✗ ${e}`);
  for (const u of ex.unneeded) out.push(`    ✗ ${u.exception}: ${u.why}`);
  const bl = r.backlog;
  out.push(bl.present ? `  Backlog     created ${bl.created} · ${bl.testids} test ids · ${bl.routes} pages · ${bl.resolved.length} resolved but still listed` : '  Backlog     none');
  for (const x of bl.resolved.slice(0, opts.verbose ? undefined : 10)) out.push(`    ✗ ${x.entry} ${x.why}`);
  if (!opts.verbose && bl.resolved.length > 10) out.push(`    … ${bl.resolved.length - 10} more (--verbose)`);
  for (const e of bl.errors) out.push(`    ✗ ${e}`);
  for (const e of r.flows.errors) out.push(`  ✗ flow: ${e}`);

  if (r.notes.length) {
    out.push('');
    for (const n of r.notes) out.push(`  note: ${n}`);
  }
  out.push('', `  VERDICT ${r.verdict}${r.blocking.length ? ` — ${r.blocking.length} blocking finding${r.blocking.length === 1 ? '' : 's'}` : ''}`);
  return out.join('\n');
}

const md = (s: string) => s.replace(/\|/g, '\\|');

export function renderMarkdown(r: CoverageReport): string {
  const t = r.testids;
  const ro = r.routes;
  const out: string[] = [];
  out.push(`### ${r.verdict === 'PASS' ? '✅' : '❌'} ${md(r.appName)} (\`${r.app}\`) — ${r.verdict}`);
  if (r.source) out.push(`Source \`${r.source.repository}\` @ \`${r.source.commit?.slice(0, 10) ?? 'unknown'}\` · mode: ${r.mode}`);
  out.push('', '| | total | covered | NEW uncovered | backlog | excepted |', '|---|---|---|---|---|---|');
  out.push(`| Interactive test ids | ${t.required} | ${t.covered} (${t.coveragePercent}%) | ${t.newUncovered.length} | ${t.existingUncovered.length} | ${t.excepted.length} |`);
  if (ro.strategy !== 'none') out.push(`| Pages (${ro.strategy}) | ${ro.pages} | ${ro.covered} | ${ro.newUncovered.length} | ${ro.existingUncovered.length} | ${ro.excepted.length} |`);
  if (r.blocking.length) {
    out.push('', `<details open><summary>${r.blocking.length} blocking finding(s)</summary>`, '');
    for (const b of r.blocking.slice(0, 200)) out.push(`- ${md(b)}`);
    if (r.blocking.length > 200) out.push(`- … ${r.blocking.length - 200} more in the JSON report`);
    out.push('', '</details>');
  }
  if (r.notes.length) {
    out.push('');
    for (const n of r.notes) out.push(`> ${md(n)}`);
  }
  return out.join('\n');
}
