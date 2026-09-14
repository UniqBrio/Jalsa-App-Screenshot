/**
 * The on-disk shape of `recordings/<flow>.json`.
 *
 * This is the contract between `src/recorder.ts` (which only observes) and
 * `src/record-convert.ts` (which is a pure function over it). Keeping the
 * recording as structured data rather than emitted code is the whole point:
 * `playwright codegen` throws away the element metadata the converter needs to
 * pick a selector, derive an id, and decide a capture mode.
 */

export const RECORDER_VERSION = 1;

/** First line of every generated draft. validate refuses a promoted file that still has it. */
export const GENERATED_HEADER = '# GENERATED — review before use';
/** Emitted when an element has no test id and no unique role/name selector. */
export const TODO_SELECTOR = 'TODO_SELECTOR';

/**
 * How a sample of url/overlay ended.
 *   stable      — a change was observed and then stopped moving
 *   navigation  — a real navigation arrived (any delay) and was attributed here
 *   next-event  — the user interacted again before anything changed
 *   no-change   — the watch window elapsed with nothing changing
 *   timeout     — something changed and never stopped moving; SUSPECT
 */
export type SampleEnd = 'stable' | 'navigation' | 'next-event' | 'no-change' | 'timeout';

export interface OverlayState {
  open: boolean;
  /** Stable identity of the topmost overlay, e.g. `testid:modal-add-student`. */
  key: string | null;
  /** A selector that resolves to it, when one is derivable. */
  selector: string | null;
}

export interface SelectorCandidate {
  selector: string;
  strategy: string;
}

export interface RecordedElement {
  testid: string | null;
  role: string;
  name: string;
  tag: string;
  input_type: string | null;
  box: { x: number; y: number; w: number; h: number };
  in_viewport: boolean;
  /** CSS candidates, each proven unique in-page by querySelectorAll. */
  selector_candidates: SelectorCandidate[];
  /** Playwright role-engine form, when role and name are both usable. */
  role_selector: string | null;
  /**
   * Whether `role_selector` resolved to exactly one element at record time.
   * querySelectorAll cannot evaluate a Playwright role selector, so this is
   * filled in from Node. null = not checked (a testid was already available).
   * The converter only trusts a role selector that was verified unique;
   * otherwise it emits TODO_SELECTOR rather than a selector that won't resolve.
   */
  role_selector_unique: boolean | null;
}

export interface RecordedScroll {
  target_key: string;
  selector: string | null;
  top: number;
  left: number;
  scroll_height: number;
  client_height: number;
  is_window: boolean;
}

export type RecordedEventType = 'click' | 'input' | 'change' | 'scroll' | 'navigation';

export interface RecordedEvent {
  seq: number;
  /** ms since recording started. Stable across re-records in a way wall clock isn't. */
  t_ms: number;
  ts: string;
  type: RecordedEventType;

  url_before: string;
  url_after: string;
  overlay_before: OverlayState;
  overlay_after: OverlayState;

  /**
   * How the "after" values were obtained. A fixed delay would let a slow route
   * transition read back as "no change", silently dropping the assertion and
   * leaving a flow that looks correct while asserting nothing — so the sampler
   * polls until stable and records how it ended.
   */
  after_sample: {
    ended_by: SampleEnd;
    settled: boolean;
    waited_ms: number;
  };

  element: RecordedElement | null;
  scroll: RecordedScroll | null;

  value: string | null;
  value_redacted: boolean;
  redaction_reason: string | null;
}

export interface Recording {
  recorder_version: number;
  flow: string;
  module: string;
  recorded_at: string;
  app_url: string;
  identity: string;
  viewport: { width: number; height: number };
  start_url: string;
  stopped_by: 'context-closed' | 'sigint' | 'api';
  redacted_values: number;
  events: RecordedEvent[];
}
