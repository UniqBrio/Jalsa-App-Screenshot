/**
 * Shared type definitions for the capture project.
 * The flow YAML schema lives here — flow-loader.ts validates against it at load
 * time so a malformed manifest fails fast, before a browser is ever launched.
 */

/**
 * Schema v2 vocabulary. The v1 actions below it are RETAINED, not deprecated —
 * `press` and `scroll` are load-bearing in the shipped flows and `fill` has
 * different semantics from `type` (see performAction in flow-executor.ts).
 */
export type StepAction =
  // ── v2 ─────────────────────────────────────────────────────────────────────
  | 'goto'               // navigate to a path (relative to the app's base URL)
  | 'click'
  | 'type'               // clear + pressSequentially — real per-character key events
  | 'select'             // <select> option by value/label
  | 'check'
  | 'uncheck'
  | 'scrollTo'           // selector into view, or position: top | bottom
  | 'scrollUntilVisible' // scroll the nearest scrollable ancestor until selector is visible
  | 'waitFor'            // wait for selector to reach state: visible | hidden | attached
  | 'expect'             // assert one condition about a selector
  | 'hover'
  | 'goBack'
  | 'setViewport'        // preset: mobile | tablet | desktop
  | 'swipe'              // dispatched touch drag across a selector — direction + distance + duration
  | 'tap'                // trusted touch tap at a selector's centre (mobile equivalent of click)
  | 'sleep'              // discouraged — requires `reason` in v2
  // ── v1, retained ───────────────────────────────────────────────────────────
  | 'fill'               // clear + fill() — one shot, no key events
  | 'press'              // keyboard key
  | 'scroll'             // scroll selector into view, or window by pixels
  | 'wait'               // wait for selector / timeout
  | 'snapshot';          // no interaction — capture the current state only

/** `expect` step payload: a bare state, or a single-key condition object. */
export type StepExpect =
  | 'visible'
  | 'hidden'
  | 'enabled'
  | 'disabled'
  | { text: string }
  | { count: { min?: number; max?: number } };

export type ViewportPreset = 'mobile' | 'tablet' | 'desktop';

export const VIEWPORT_PRESETS: Record<ViewportPreset, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 900 },
};

export type ScenarioClass =
  | 'happy'
  | 'validation'
  | 'duplicate'
  | 'empty'
  | 'permission'
  | 'offline';

/** Normalised capture instruction, resolved by the loader from `screenshot:`. */
export type CaptureSpec =
  | { mode: 'none' }
  | { mode: 'viewport' }
  | { mode: 'full' }
  | { mode: 'auto' }
  | { mode: 'element'; selector: string };

/** Which block of the manifest a step came from. */
export type StepPhase = 'setup' | 'steps' | 'teardown';

export interface StepAssert {
  /** Page (or scoped selector) must contain this text. */
  text_contains?: string;
  /** Page must NOT contain this text. */
  text_not_contains?: string;
  /** Selector must be visible. */
  selector_visible?: string;
  /** Selector must be absent or hidden. */
  selector_hidden?: string;
  /** URL must contain this fragment. */
  url_contains?: string;
  /** Element count for a selector. */
  count?: { selector: string; min?: number; max?: number };
}

export interface FlowStep {
  /** Stable id — also the screenshot filename stem. Convention: `010-open-attendance`. */
  id: string;
  action: StepAction;
  /** Selector. Supports {{VAR}} interpolation from env + flow vars. */
  selector?: string;
  /** Path for `goto`, text for `type`/`fill`, option for `select`, key for `press`, ms/px otherwise. */
  value?: string | number;
  /** Human label used in generated docs. Falls back to a prettified `id`. */
  label?: string;
  /** Logical screen name reached after this step — used by fingerprinting + docs. */
  expect_screen?: string;
  /**
   * v1: true | false. v2: 'viewport' | 'full' | 'auto' | 'element:<selector>' | false.
   * Resolved into `_capture` by the loader; never read directly by the executor.
   */
  screenshot?: boolean | string;
  /** v1 only — `screenshot: true` + `full_page: true` normalises to mode 'full'. */
  full_page?: boolean;
  /** Settle time (ms) after the action. Falls back to the flow's settle_ms, then 350. */
  settle_ms?: number;
  assert?: StepAssert;
  /** Payload for action `expect`. */
  expect?: StepExpect;
  /** Selectors whose text is masked before hashing AND blacked out in the PNG. */
  mask?: string[];
  /** If true, a failure here logs and continues instead of aborting the flow. */
  optional?: boolean;
  /**
   * This step CONFIRMS an outbound message (the second press that actually
   * sends an email, SMS, WhatsApp or push). It is refused unless the app
   * profile carries an outboundKillSwitch attestation — in dummy mode too,
   * because a separate tenant still sends to whatever address it holds.
   */
  sends?: boolean;
  /**
   * Marks a step that writes data. Allowed only in a flow that declares
   * `writes: true` and `auth: dummy` (see write-gates.ts); anywhere else it is
   * a hard validation error. A recorder draft also uses it to flag a suspected
   * write for a human to review.
   */
  creates_data?: boolean;
  /**
   * `type`/`fill` only. Does the value this step enters create a record?
   *   false — it does not (a search box, a filter, the sign-in field)
   *   true  — it does: the value must contain {{RUN_TAG}} so the record is
   *           identifiable by run id, and the flow must be a dummy write flow
   *   'TODO' — emitted by the recorder's converter; a human has not decided yet
   * The converter cannot know which typed value creates a record, so it refuses
   * to guess and leaves the marker for review.
   */
  run_tag?: boolean | 'TODO';

  // ── action-specific fields ─────────────────────────────────────────────────
  /** `waitFor`. Default 'visible'. */
  state?: 'visible' | 'hidden' | 'attached';
  /** `scrollTo`, when no selector is given. */
  position?: 'top' | 'bottom';
  /** `scrollUntilVisible`. Default 10. */
  max_scrolls?: number;
  /** `setViewport`. */
  preset?: ViewportPreset;
  /** `swipe` — gesture direction across the target element. */
  direction?: 'left' | 'right' | 'up' | 'down';
  /** `swipe` — travel distance in CSS px. Default 200. */
  distance?: number;
  /** `swipe` — gesture duration in ms (interpolated across the drag). Default 300. */
  duration?: number;
  /** `sleep` — mandatory in v2, since a fixed wait always needs justifying. */
  reason?: string;

  /**
   * Escape hatch for the selector policy: a control with no test id and no
   * usable role/name pair. Requires a reason, and validate warns about it on
   * every run so an exemption can never quietly become permanent.
   */
  selector_exempt?: string;

  /** Injected by the loader — never written in YAML. */
  _capture?: CaptureSpec;
  /** Injected by the loader — which block this step came from. */
  _phase?: StepPhase;
}

export interface Flow {
  /** Absent => 1. v2 adds required `title`, mandatory `sleep.reason`. */
  schema_version?: number;
  module: string;
  flow: string;
  /** Short human name — required in v2. */
  title?: string;
  description?: string;
  /** Who the generated documentation is FOR. Distinct from `auth`, which is who we log in AS. */
  audience?: string;
  tags?: string[];
  scenario_class?: ScenarioClass;
  /** Default settle time (ms) after every step in this flow. Default 350. */
  settle_ms?: number;
  /**
   * Which identity the runner signs in AS: an account name from the app
   * profile (apps/<app-id>/app.config.json `accounts`), or `none` for a FRESH,
   * signed-out context per flow (sign-in screens). Absent means the profile's
   * `defaultAccount`. Only `dummy` may ever write.
   */
  auth?: string;
  /**
   * This flow creates records. Requires `auth: dummy`, and at run time
   * WRITE_MODE=dummy, a write-allowed host and a verified dummy tenant.
   * A write flow must have a `teardown` that deletes what it tagged.
   */
  writes?: boolean;
  /**
   * Outbound channels a write flow triggers. Such a flow is skipped (and
   * flagged in the run report) unless the dummy tenant's messaging is off.
   */
  sends_messages?: MessageChannel[];
  /** App routes this flow exercises — documentation + discovery cross-check. */
  depends_on_routes?: string[];
  /** Flow-local variables, interpolatable as {{name}}. Env vars win on collision. */
  vars?: Record<string, string>;
  /** Skip without deleting the file. */
  disabled?: boolean;
  /**
   * Device profiles (config/devices.json ids) this flow makes sense on. Absent
   * means every device the run selected. A flow pinned to one form factor — a
   * phone-only gesture, a desktop-only wide table — names it here.
   */
  devices?: string[];
  /** Runs before `steps`. Same vocabulary; screenshots default to off. */
  setup?: FlowStep[];
  steps: FlowStep[];
  /**
   * Runs after `steps`, including after a failure. Failures here never fail
   * the flow. In a write flow, every interactive teardown step requires the
   * run tag to be on screen, so only records this run created can be deleted.
   */
  teardown?: FlowStep[];
  /** Relative path the flow was loaded from — injected by the loader. */
  _sourcePath?: string;
}

export type MessageChannel = 'email' | 'sms' | 'whatsapp' | 'push';

export type StepStatus = 'ok' | 'failed' | 'skipped';

export interface StepResult {
  id: string;
  action: StepAction;
  phase: StepPhase;
  selector: string | null;
  input: string | null;
  result: string;
  status: StepStatus;
  next_screen: string | null;
  /** First captured file — retained so doc-generator keeps working unchanged. */
  screenshot_path: string | null;
  /** Every file this step captured. `full` produces a viewport shot and a full shot. */
  screenshot_paths: string[];
  capture_mode: CaptureSpec['mode'] | null;
  /** For `screenshot: auto` — which visual signals differed, or why nothing was captured. */
  visual_signals: string[] | null;
  capture_skipped_reason: string | null;
  dom_hash: string | null;
  /** 'new' | 'unchanged' | 'changed' vs fingerprints/baseline.json */
  fingerprint: 'new' | 'unchanged' | 'changed' | null;
  /** True when the stability gate expired — the shot was taken mid-load and named .loading.png. */
  unstable?: boolean;
  duration_ms: number;
  error?: string;
}

export type FlowStatus = 'changed' | 'unchanged' | 'skipped' | 'failed' | 'new';

export interface FlowRun {
  module: string;
  flow: string;
  /** Device profile id this run captured on — also the top output folder. */
  device: string;
  run_id: string;
  app_git_sha: string | null;
  status: FlowStatus;
  /** Why the runner chose to run or skip this flow. */
  reason: string;
  started_at: string;
  duration_ms: number;
  steps: StepResult[];
  screenshots: string[];
  errors: string[];
  /** Present only on a dummy write flow that passed every write gate. */
  write_mode?: 'dummy';
}

export interface RunSummary {
  run_id: string;
  /** apps/<app-id> the run targeted. */
  app_id: string;
  started_at: string;
  finished_at: string;
  app_git_sha: string | null;
  app_repo_available: boolean;
  env: { app_url: string; app_host: string };
  /** `dummy` only when write flows were allowed to run. */
  write_mode: 'dummy' | 'off';
  /** The marker every record created by this run carries. */
  run_tag: string;
  totals: {
    flows_total: number;
    flows_run: number;
    flows_skipped: number;
    flows_failed: number;
    flows_changed: number;
    screenshots: number;
  };
  devices: string[];
  flows: Array<Pick<FlowRun, 'module' | 'flow' | 'device' | 'status' | 'reason' | 'duration_ms'>>;
  /** Flows that were skipped for a safety reason a human must look at. */
  flagged: Array<{ module: string; flow: string; reason: string }>;
}

export interface RoutesMapEntry {
  flows: string[];
  source_paths: string[];
}
export type RoutesMap = Record<string, RoutesMapEntry>;

export interface KnownRoute {
  path: string;
  label: string;
  tab?: boolean;
  module?: string;
  /** Set when discovery found it but no flow covers it yet. */
  uncovered?: boolean;
}
export interface KnownRoutes {
  last_checked: string;
  routes: KnownRoute[];
}

export interface FingerprintEntry {
  dom_hash: string;
  masked_selectors: string[];
  last_updated: string;
}
export type Fingerprints = Record<string, FingerprintEntry>;

export interface LastRunState {
  last_successful_run_id: string | null;
  last_successful_app_git_sha: string | null;
  /** Per-flow sha at last successful run — lets one failing flow re-run alone. */
  per_flow_sha: Record<string, string>;
}
