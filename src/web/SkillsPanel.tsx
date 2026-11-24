// The canonical skill library panel (SPEC-SKILLS). Lists the imported/authored skills; on select
// fetches the full SkillWithBody and renders its body in a <pre>. An "Import machine skills" button
// runs the one-time importer and shows its report inline.
//
// Phase 5b adds the "Assistant drafts" strip: OPEN drafts from the assistant's inert pad (name,
// target, age, size), expand-to-view body in a <pre>, and a session-token Discard. Rides the same
// reloadSignal/{t:'skills'} refresh as the library list.
//
// Phase 5b wave 2 grows the detail into an operator editor: prose+body edits through the existing
// PUT, a per-skill History list with preview + rollback, amber gate-sabotage advisory rows over
// assistant-authored text (computed client-side — the server never returns flags to the model), and
// the retype-the-name unlock for PROTECTED skills (the server's 409 is the boundary; the input here
// is the honest UX for it).

import { useCallback, useEffect, useState } from 'react';
import { tower } from './api.js';
import { escapeBodyText } from './assistant-api.js';
import { timeAgo } from './flightline-utils.js';
import { lintGateSabotage, skillProseScanText } from '../shared/skill-lint.js';
import type {
  Skill, SkillWithBody, SkillDraft, SkillDraftMeta, SkillImportReport,
  SkillHistoryEntry, SkillHistoryMeta,
} from '../shared/types.js';

export function SkillsPanel({ onError, reloadSignal }: { onError: (m: string) => void; reloadSignal?: number }) {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillWithBody | null>(null);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<SkillImportReport | null>(null);
  const [drafts, setDrafts] = useState<SkillDraftMeta[]>([]);
  const [openDraft, setOpenDraft] = useState<SkillDraft | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setSkills(await tower.listSkills());
    } catch (e) {
      setFailed(true);
      onError((e as Error).message);
    }
    // The drafts strip degrades alone — a pad fetch failure must not brick the library list.
    try {
      setDrafts(await tower.listSkillDrafts());
    } catch {
      setDrafts([]);
    }
  }, [onError]);
  useEffect(() => {
    void load();
  }, [load, reloadSignal]);

  // Fetch the full body on select. Also re-fetched on a reload bump so a live edit shows without a click,
  // and cleared if the selected skill is no longer in the (refetched) list.
  const openDetail = useCallback(
    async (id: string) => {
      try {
        setDetail(await tower.getSkill(id));
      } catch (e) {
        onError((e as Error).message);
      }
    },
    [onError],
  );
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    if (skills && !skills.some((s) => s.id === selectedId)) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    void openDetail(selectedId);
  }, [selectedId, skills, openDetail]);

  const runImport = async () => {
    if (importing) return;
    setImporting(true);
    try {
      setReport(await tower.importSkills());
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const toggleDraft = async (id: string) => {
    if (openDraft?.id === id) {
      setOpenDraft(null);
      return;
    }
    try {
      setOpenDraft(await tower.getSkillDraft(id));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const discardDraft = async (id: string) => {
    try {
      await tower.discardSkillDraft(id);
      if (openDraft?.id === id) setOpenDraft(null);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const openDrafts = drafts.filter((d) => d.status === 'open');

  return (
    <section className="settings-section">
      <div className="acct-row">
        <h2 style={{ margin: 0 }}>Skills</h2>
        <span className="spacer" />
        <button className="btn-sm" disabled={importing} onClick={() => void runImport()}>
          {importing ? 'Importing…' : 'Import machine skills'}
        </button>
      </div>
      <p className="muted small">
        The shared library of named, reusable capabilities. Import brings in the skills already on this
        machine (a one-time copy; re-importing only adds skills the Tower does not already have). Select
        a skill to view or edit it, and to roll back to an earlier version.
      </p>

      {report && (
        <div className="muted small" style={{ marginBottom: 12 }}>
          Imported {report.imported.length} · skipped {report.skipped.length} · errors {report.errors.length}
          {report.errors.map((e, i) => (
            <div key={`e${i}`} className="settings-warn">⚠ {e.id}: {e.reason}</div>
          ))}
          {report.warnings.map((w, i) => (
            <div key={`w${i}`}>· {w}</div>
          ))}
        </div>
      )}

      {openDrafts.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 4px 0' }}>Assistant drafts</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            Skill bodies the assistant drafted. A draft is inert — no agent ever sees it; it enters the
            library only when you confirm its promote card, and even then it lands disabled.
          </p>
          {openDrafts.map((d) => (
            <div key={d.id} style={{ marginBottom: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span>{d.name}</span>
                <span className="muted small mono">
                  {d.targetSkillId ? `updates ${d.targetSkillId}` : 'new skill'} · {timeAgo(d.updatedAt)} ·{' '}
                  {(d.bodyBytes / 1024).toFixed(1)} KB
                </span>
                <span className="spacer" />
                <button className="btn-sm" onClick={() => void toggleDraft(d.id)}>
                  {openDraft?.id === d.id ? 'Hide' : 'View'}
                </button>
                <button className="btn-sm" onClick={() => void discardDraft(d.id)}>Discard</button>
              </div>
              {openDraft?.id === d.id && (
                <>
                  {/* Gate-sabotage advisory (SPEC-SKILLS Phase 5b wave 2) — amber, never blocking. */}
                  {lintGateSabotage(skillProseScanText(openDraft)).map((f) => (
                    <div key={f.cls} className="settings-warn small" style={{ margin: '6px 0 0 0' }}>
                      ⚠ possible gate sabotage: {f.label} — read the body carefully
                    </div>
                  ))}
                  <pre
                    className="mono small"
                    style={{ maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                             border: '1px solid var(--border, #333)', borderRadius: 4, padding: 10, margin: '6px 0 0 0' }}
                  >
                    {/* LLM-authored text on a review surface: bidi/zero-width/control chars render VISIBLY. */}
                    {escapeBodyText(openDraft.body)}
                  </pre>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {failed && (
        <div className="muted small">
          Couldn’t load skills.{' '}
          <button className="btn-sm" onClick={() => void load()}>retry</button>
        </div>
      )}

      {skills !== null && skills.length === 0 && !failed && (
        <div className="muted small">
          No skills yet. Click <span className="mono">Import machine skills</span> to bring in the skills on
          this machine.
        </div>
      )}

      {skills !== null && skills.length > 0 && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div style={{ flex: '0 0 240px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {skills
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((s) => (
                <button
                  key={s.id}
                  className={`tab ${selectedId === s.id ? 'active' : ''}`}
                  style={{ textAlign: 'left', justifyContent: 'flex-start' }}
                  onClick={() => setSelectedId(s.id)}
                >
                  <span>{s.name}</span>{' '}
                  <span className="muted small mono">{s.id} · v{s.version}</span>
                </button>
              ))}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {detail ? (
              <SkillDetail skill={detail} onError={onError} onChanged={() => void openDetail(detail.id)} />
            ) : (
              <div className="muted small">Select a skill.</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

interface SkillEditForm {
  name: string;
  description: string;
  trigger: string;
  tags: string; // comma-separated in the form; split on save
  body: string;
}

function SkillDetail({ skill, onError, onChanged }: { skill: SkillWithBody; onError: (m: string) => void; onChanged: () => void }) {
  const providers = skill.supportedProviders?.length ? skill.supportedProviders.join(', ') : 'any provider';
  const gate = skill.gate
    ? skill.gate.mode === 'blocking'
      ? `gate: blocking${skill.gate.blocks?.length ? ` (${skill.gate.blocks.join(', ')})` : ''}`
      : 'gate: advisory'
    : null;
  // Autonomy clearance (SPEC-SKILLS Phase 5b wave 2) — assistant-authored bodies only. The clearance
  // checkbox lives HERE, never on the promote Confirm card: the card executes exactly the pinned
  // action and nothing more, and a clearance rider on Confirm would collapse two distinct human acts
  // (review-and-publish vs open-it-to-ungated-agents) into one click.
  const assistant = skill.origin === 'assistant';
  const cleared = skill.autonomyCleared === true;
  // Derived protection — mirrors the server's isProtectedSkill (operator lock OR blocking gate).
  // Protected mutations demand the retype-the-name confirmName on every route; the unlock input
  // below is the UX for it, the server's 409 is the boundary.
  const isProtected = skill.protected === true || skill.gate?.mode === 'blocking';
  const [confirmInput, setConfirmInput] = useState('');
  const unlocked = !isProtected || confirmInput === skill.name;
  const confirmName = isProtected ? confirmInput : undefined;

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<SkillEditForm>({ name: '', description: '', trigger: '', tags: '', body: '' });
  const [history, setHistory] = useState<SkillHistoryMeta[]>([]);
  const [openEntry, setOpenEntry] = useState<SkillHistoryEntry | null>(null);

  // Selecting a different skill clears the transient edit/unlock state (an unlock never carries over).
  useEffect(() => {
    setEditing(false);
    setOpenEntry(null);
    setConfirmInput('');
  }, [skill.id]);

  // The history list degrades alone — a fetch failure must not brick the detail. Re-fetched when a
  // save/rollback bumps the version so the new entry shows without a reselect.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const h = await tower.getSkillHistory(skill.id);
        if (alive) setHistory(h);
      } catch {
        if (alive) setHistory([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [skill.id, skill.version]);

  // Gate-sabotage advisory over assistant-authored text (SPEC-SKILLS Phase 5b wave 2). Client-side
  // only — the server never returns flags to the model (the no-oracle rule); amber, never blocking.
  const sabotage = assistant ? lintGateSabotage(skillProseScanText(skill)) : [];

  const setCleared = async (v: boolean) => {
    try {
      await tower.setSkillAutonomyCleared(skill.id, v, confirmName);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const startEdit = () => {
    setForm({
      name: skill.name,
      description: skill.description,
      trigger: skill.trigger ?? '',
      tags: (skill.tags ?? []).join(', '),
      body: skill.body,
    });
    setEditing(true);
  };

  // Saves through the existing PUT: prose+body replace, everything else (invocation, gate,
  // overrides, assets, enabled, clearance-reset semantics) rides the store's patch rules.
  const save = async () => {
    try {
      await tower.upsertSkill({
        id: skill.id,
        name: form.name,
        description: form.description,
        body: form.body,
        trigger: form.trigger,
        tags: form.tags.split(',').map((t) => t.trim()).filter((t) => t !== ''),
        ...(confirmName !== undefined ? { confirmName } : {}),
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const toggleEntry = async (version: number) => {
    if (openEntry?.version === version) {
      setOpenEntry(null);
      return;
    }
    try {
      setOpenEntry(await tower.getSkillHistoryEntry(skill.id, version));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const rollback = async (version: number) => {
    if (!window.confirm(`Roll back "${skill.name}" to v${version}? The current content stays in history.`)) return;
    try {
      await tower.rollbackSkill(skill.id, version, confirmName);
      setOpenEntry(null);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const inputStyle = { width: '100%', boxSizing: 'border-box' as const };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong>{skill.name}</strong> <span className="muted small mono">v{skill.version} · {skill.id}</span>
        <span className="spacer" />
        {!editing && (
          <button className="btn-sm" disabled={isProtected && !unlocked} onClick={startEdit}>Edit</button>
        )}
      </div>
      <div className="skill-badges" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <span className="chip">{skill.scope}</span>
        <span className={`chip ${skill.enabled ? '' : 'hold'}`}>{skill.enabled ? 'enabled' : 'disabled'}</span>
        <span className="chip">{skill.invocation.user ? 'user' : 'no-user'}</span>
        <span className="chip">model: {skill.invocation.model}</span>
        {gate && <span className={`chip ${skill.gate?.mode === 'blocking' ? 'question' : ''}`}>{gate}</span>}
        <span className="chip">{providers}</span>
        <span className="chip">{skill.origin}</span>
        {assistant && <span className={`chip ${cleared ? '' : 'hold'}`}>{cleared ? 'autonomy: cleared' : 'interactive-only'}</span>}
        {skill.assets?.length ? <span className="chip">{skill.assets.length} asset{skill.assets.length === 1 ? '' : 's'}</span> : null}
      </div>
      {isProtected && (
        <div style={{ marginBottom: 8 }}>
          <p className="muted small" style={{ margin: '0 0 4px 0' }}>
            This skill is protected ({skill.gate?.mode === 'blocking' ? 'blocking gate' : 'operator lock'}).
            Retype its exact name to unlock editing, toggles, and rollback:
          </p>
          <input
            className="mono small"
            style={{ width: 280 }}
            value={confirmInput}
            placeholder={skill.name}
            onChange={(e) => setConfirmInput(e.target.value)}
          />
        </div>
      )}
      {assistant && (
        <div style={{ marginBottom: 8 }}>
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={cleared}
              disabled={isProtected && !unlocked}
              onChange={(e) => void setCleared(e.target.checked)}
            />
            Cleared for skip-permissions agents
          </label>
          <p className="muted small" style={{ margin: '2px 0 0 0' }}>
            Until cleared, this assistant-authored skill only reaches agents that keep the permission
            gate. Any content change resets it to interactive-only.
          </p>
        </div>
      )}
      {sabotage.map((f) => (
        <div key={f.cls} className="settings-warn small" style={{ marginBottom: 4 }}>
          ⚠ possible gate sabotage: {f.label} — read the body carefully
        </div>
      ))}
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="muted small">
            Name
            <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="muted small">
            Description
            <input style={inputStyle} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label className="muted small">
            When to use (trigger)
            <input style={inputStyle} value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })} />
          </label>
          <label className="muted small">
            Tags (comma-separated)
            <input style={inputStyle} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          </label>
          <textarea
            className="mono small"
            style={{ ...inputStyle, minHeight: 260, whiteSpace: 'pre' }}
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
          {/* The textarea must round-trip raw bytes, so it cannot render <U+XXXX> tokens — when the
              body carries chars escapeBodyText would surface, show them in an escaped read-only
              mirror so nothing invisible hides from the editing operator either. */}
          {form.body !== escapeBodyText(form.body) && (
            <div>
              <div className="settings-warn small">
                ⚠ this body contains invisible or bidirectional characters — shown escaped below (the
                textarea above edits the raw bytes)
              </div>
              <pre
                className="mono small"
                style={{ maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                         border: '1px solid var(--border, #333)', borderRadius: 4, padding: 10, margin: '4px 0 0 0' }}
              >
                {escapeBodyText(form.body)}
              </pre>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-sm" disabled={isProtected && !unlocked} onClick={() => void save()}>Save</button>
            <button className="btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          {skill.description && <p className="small" style={{ marginTop: 0 }}>{skill.description}</p>}
          {skill.trigger && <p className="muted small">When: {skill.trigger}</p>}
          <pre
            className="mono small"
            style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                     border: '1px solid var(--border, #333)', borderRadius: 4, padding: 10, marginBottom: 0 }}
          >
            {/* The detail pane is the wave-2 review-and-edit surface (its amber flags say "read the
                body carefully"), so bidi/zero-width/control chars render VISIBLY here too — the same
                posture as the draft and history panes. */}
            {escapeBodyText(skill.body)}
          </pre>
        </>
      )}
      {history.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ margin: '0 0 4px 0' }}>History</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            Earlier versions of this skill (newest first, last {history.length} kept). Rolling back
            restores that version&rsquo;s text as a NEW version — nothing is rewritten.
          </p>
          {history.map((h) => (
            <div key={h.version} style={{ marginBottom: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="mono small">v{h.version}</span>
                <span className="muted small">{timeAgo(h.ts)} · {(h.bodyBytes / 1024).toFixed(1)} KB · {h.name}</span>
                <span className="spacer" />
                <button className="btn-sm" onClick={() => void toggleEntry(h.version)}>
                  {openEntry?.version === h.version ? 'Hide' : 'View'}
                </button>
                <button className="btn-sm" disabled={isProtected && !unlocked} onClick={() => void rollback(h.version)}>
                  Roll back
                </button>
              </div>
              {openEntry?.version === h.version && (
                <pre
                  className="mono small"
                  style={{ maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                           border: '1px solid var(--border, #333)', borderRadius: 4, padding: 10, margin: '6px 0 0 0' }}
                >
                  {/* Historical text on a review surface — same visible-controls posture as the drafts. */}
                  {escapeBodyText(openEntry.body)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
