/**
 * Which step actions EXERCISE the element their selector names, as opposed to
 * merely finding it. Shared by the executor (which records the test id of what
 * it actually pressed) and the coverage check (which counts it), so the two can
 * never disagree about what "tested" means.
 *
 *   exercising — click, tap, type, fill, select, check, uncheck, press, swipe
 *   locating   — everything else that names a selector: hover, scrollTo,
 *                scrollUntilVisible, waitFor, expect, wait, snapshot, assertions,
 *                masks and element screenshots
 *
 * Hover is deliberately locating: it proves the element is there and reachable,
 * not that its action was taken.
 */
import type { StepAction } from '../types';

export const EXERCISING_ACTIONS: ReadonlySet<StepAction> = new Set<StepAction>([
  'click', 'tap', 'type', 'fill', 'select', 'check', 'uncheck', 'press', 'swipe',
]);

export function exercises(action: StepAction): boolean {
  return EXERCISING_ACTIONS.has(action);
}
