// Control Tower — the ONE reasoning-effort picker (SPEC-EFFORT §4), rendered beside <ModelSelect>
// everywhere a model is chosen. Mirrors ModelSelect's discipline: a neutral "— not set —" default (the
// Tower imposes NO effort — unset means the CLI's own default), and NO new fetch — the codex effort sets
// ride the SAME cached (provider, profileId) roster ModelSelect already loads via useProviderModels.
//
// A CLOSED per-model dropdown for both CLIs — no free text. The reasoning-effort backend HARD-REJECTS any
// value outside a model's supported enum (a stray token 400s the run — the earlier "codex is lenient"
// premise only ever held for the CLI's own config parser, never the backend), so the picker offers exactly
// a model's captured effort set: claude-code the pinned CLAUDE_EFFORTS, codex the model's `efforts` from
// the cached catalog (every seeded value is inside the backend's set, so options are never invalid).
// gemini/shell/custom have no effort surface, so the picker is disabled there. A value already stored but
// not in the current set (a stale pin, or a model/account switch) renders as its own selected option so a
// saved route stays truthful and can be re-picked to a supported value.

import type { ProviderId } from '../shared/types.js';
import { CLAUDE_EFFORTS } from '../shared/types.js';
import { useProviderModels } from './ModelSelect.js';

export interface EffortSelectProps {
  provider?: ProviderId;
  /** Scopes the codex roster read (effort sets are per account/tier). */
  profileId?: string;
  /** When set, the codex options are THIS model's captured effort set (+ its defaultEffort hint); with no
   *  model, the deduped union across the account's catalog (both CLIs apply effort session-wide). */
  model?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Drop the hint line for tight inline rows (routing grid / sortie). */
  compact?: boolean;
  id?: string;
  ariaLabel?: string;
}

/** The unified effort picker. Enabled for codex + claude-code (both apply effort even to their own default
 *  model); disabled/inert for gemini/shell/custom (no effort surface). */
export function EffortSelect({ provider, profileId, model, value, onChange, disabled, compact, id, ariaLabel }: EffortSelectProps) {
  const isClaude = provider === 'claude-code';
  const isCodex = provider === 'codex';
  const supported = isClaude || isCodex;

  // Only codex reads a roster; claude's options are the pinned enum. Passing an undefined provider keeps
  // the hook from fetching for claude/unsupported. NOTE: options come from the CACHED catalog, so a just-
  // connected or never-refreshed codex account offers only the curated seed until the sibling ModelSelect's
  // ↻ refresh populates the true per-model set — spec-conformant (no imposed values), refresh first then pick.
  const { view } = useProviderModels(isCodex ? provider : undefined, isCodex ? profileId : undefined);
  const roster = view?.models ?? [];

  let options: string[] = [];
  let defaultEffort: string | undefined;
  if (isClaude) {
    options = [...CLAUDE_EFFORTS];
  } else if (isCodex) {
    if (model) {
      const entry = roster.find((m) => m.id === model);
      options = entry?.efforts ?? [];
      defaultEffort = entry?.defaultEffort;
    } else {
      // No model chosen: the deduped UNION of efforts across the account's catalog (no defaultEffort hint).
      const set = new Set<string>();
      for (const m of roster) for (const e of m.efforts ?? []) set.add(e);
      options = [...set];
    }
  }
  const inOptions = (v: string) => options.includes(v);

  if (!supported) {
    // gemini/shell/custom/unset — no effort surface. A disabled, empty picker (validation guarantees no
    // effort ever resolves for these); rendered with ModelSelect's chrome for layout parity in the grid.
    return (
      <div className={`model-select${compact ? ' compact' : ''}`}>
        <div className="model-select-row">
          <select id={id} aria-label={ariaLabel} disabled value="">
            <option value="">— not set —</option>
          </select>
        </div>
      </div>
    );
  }

  // A value set but not (yet) an option — a stale pin, a not-yet-loaded roster, or a value from another
  // model's set — renders as its own option so a saved route stays truthful and is re-pickable to a
  // supported value (this is how a stranded value like a rejected effort is corrected). A closed-list
  // claude value out of range stays visible the same way.
  const showTransient = !!value && !inOptions(value);

  return (
    <div className={`model-select${compact ? ' compact' : ''}`}>
      <div className="model-select-row">
        <select
          id={id}
          aria-label={ariaLabel}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {/* Always "— not set —", never pre-selected: unset ⇒ the Tower passes no effort flag (§0). */}
          <option value="">— not set —</option>
          {options.map((eff) => (
            <option key={eff} value={eff}>
              {eff}
            </option>
          ))}
          {/* Label the off-list value "(current)" — the closed dropdown otherwise renders a stranded pin
              indistinguishable from a real option (the free-text input used to mark it foreign). Asserts
              only currency, never validity, so it reads true in every transient case: a stale-catalog pin
              awaiting ↻, a value carried across a model switch, one still resolving mid-load, or a claude
              value out of range. The value attribute stays the raw token, so onChange/save are untouched. */}
          {showTransient && <option value={value}>{value} (current)</option>}
        </select>
      </div>
      {/* A per-account catalog pulled BEFORE effort-capture replaces the seed with efforts-less models
          (model-catalog.ts serves a stored roster wholesale), so a healthy-looking model list can still
          carry an empty effort set — the picker must say why it's bare and point at the fix. Gated on
          view!==null so it never flashes while the roster loads; a failed first load leaves view null and
          the sibling ModelSelect owns that hint. Dropped in compact rows per the compact contract — the
          sentence can't fit a ~120px grid cell, the same empty state is diagnosed in every full-width
          surface, and unset remains a valid route (no effort flag passed). Worded as a POSSIBILITY, not a
          promise — an empty set can also be a genuinely level-less or an uncataloged model, where a
          refresh won't help, so "may load them" stays honest and avoids a fruitless ↻-loop. */}
      {isCodex && !compact && view !== null && options.length === 0 && (
        <span className="hint model-select-hint model-select-warn">no effort levels captured — refreshing the model list (↻) may load them</span>
      )}
      {/* Gated on options.length > 0: the catalog captures efforts and defaultEffort independently
          (model-catalog.ts), so a default can exist with no level set — the gate stops that freak pairing
          from co-rendering with the empty-hint above as a contradiction. */}
      {!compact && defaultEffort && options.length > 0 && (
        <span className="hint model-select-hint">default: {defaultEffort} (the CLI’s own — never applied by the Tower)</span>
      )}
    </div>
  );
}
