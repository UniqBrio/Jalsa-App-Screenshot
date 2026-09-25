/**
 * Loads and validates config/pii-regions.json. Fails fast: a malformed region
 * silently classifying nothing would let personal data through as U or L.
 */
import * as fs from 'fs';
import { paths } from '../env';
import type { RegionRule } from './census-probe';

export interface PiiConfig {
  data_regions: RegionRule[];
  /** Normalised: lower-case, whitespace collapsed. */
  label_texts: string[];
}

export function normaliseLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function parsePiiConfig(raw: unknown, source = 'pii config'): PiiConfig {
  const errs: string[] = [];
  const obj = raw as { data_regions?: unknown; label_texts?: unknown };
  if (typeof raw !== 'object' || raw === null) throw new Error(`${source}: must be a JSON object`);

  const regions: RegionRule[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(obj.data_regions)) errs.push('data_regions: array required');
  else obj.data_regions.forEach((r: any, i: number) => {
    const where = `data_regions[${i}]`;
    if (!r || typeof r.id !== 'string' || !r.id) { errs.push(`${where}.id: required`); return; }
    if (ids.has(r.id)) errs.push(`${where}.id: duplicate "${r.id}"`);
    ids.add(r.id);
    if (!['P', 'O', 'I'].includes(r.class)) errs.push(`${where}.class: must be P, O or I`);
    const m = r.match ?? {};
    const hasTestid = typeof m.testid === 'string' && m.testid;
    const hasFamily = typeof m.testid_family === 'string' && /-\*$/.test(m.testid_family);
    const hasRole = typeof m.role === 'string' && typeof m.name_regex === 'string';
    if (m.testid_family !== undefined && !hasFamily) errs.push(`${where}.match.testid_family: must end in "-*"`);
    if ((m.role === undefined) !== (m.name_regex === undefined)) errs.push(`${where}.match: role and name_regex go together`);
    if (hasRole) {
      try { new RegExp(m.name_regex); } catch { errs.push(`${where}.match.name_regex: invalid regular expression`); }
    }
    if (!hasTestid && !hasFamily && !hasRole) errs.push(`${where}.match: needs testid, testid_family, or role + name_regex`);
    regions.push({ id: r.id, class: r.class, match: { testid: m.testid, testid_family: m.testid_family, role: m.role, name_regex: m.name_regex } });
  });

  if (!Array.isArray(obj.label_texts) || !obj.label_texts.every((t) => typeof t === 'string' && t.trim())) {
    errs.push('label_texts: array of non-empty strings required');
  }

  if (errs.length) throw new Error(`${source} is invalid:\n  ${errs.join('\n  ')}`);
  return { data_regions: regions, label_texts: (obj.label_texts as string[]).map(normaliseLabel) };
}

export function loadPiiConfig(file = paths.piiRegions): PiiConfig {
  if (!fs.existsSync(file)) throw new Error(`PII config not found at ${file} — evidence mode cannot classify without it.`);
  return parsePiiConfig(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}
