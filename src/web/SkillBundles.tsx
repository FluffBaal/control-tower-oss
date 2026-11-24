// SPEC-SKILLS Phase 3 — the bundle editor (Settings → Routing, under the Skills panel). A named,
// reusable set of skills a project can select in Settings → Projects → Skills. A direct clone of the
// WorkflowsEditor/WorkflowCard pair (ProvidersPanel.tsx): a fetched list plus local drafts with
// client-minted ids, saved per-card (an abandoned Add leaves no junk bundle behind); a delete surfaces
// the server's 409 (naming the referencing projects) inline. The member picker is the skill META list
// as checkbox rows — a disabled or project-scope member is marked, since the library master switch still
// excludes a disabled skill and a project-scope skill is only DELIVERED to terminals in a later phase.

import { useCallback, useEffect, useState } from 'react';
import { tower, retypeGateMessage, type SkillBundleUpsert } from './api.js';
import type { Skill, SkillBundle } from '../shared/types.js';

export function SkillBundlesEditor({ onError, reloadSignal }: { onError: (m: string) => void; reloadSignal?: number }) {
  const [bundles, setBundles] = useState<SkillBundle[] | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [failed, setFailed] = useState(false);
  // Unsaved new bundles: local drafts with client-minted ids, saved on their card's Save.
  const [drafts, setDrafts] = useState<SkillBundleUpsert[]>([]);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [bs, sk] = await Promise.all([tower.listSkillBundles(), tower.listSkills()]);
      setBundles(bs);
      setSkills(sk);
    } catch (e) {
      setFailed(true);
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => {
    void load();
  }, [load, reloadSignal]);

  const addDraft = () => setDrafts((d) => [...d, { id: crypto.randomUUID(), name: '', skillIds: [] }]);
  const dropDraft = (id: string) => setDrafts((d) => d.filter((b) => b.id !== id));

  return (
    <section className="settings-section">
      <div className="acct-row">
        <h2 style={{ margin: 0 }}>Skill bundles</h2>
      </div>
      <p className="muted small">
        A bundle is a named set of skills a project can select in Settings → Projects → Skills. A project’s
        per-skill overrides beat it; the global (default-on) library is always included. A project-scoped
        skill is selected here but delivered to terminals in a later phase.
      </p>
      {failed ? (
        <div className="muted small">
          Couldn’t load bundles. <button className="btn-sm" onClick={() => void load()}>retry</button>
        </div>
      ) : bundles === null ? (
        <div className="muted small">Loading…</div>
      ) : (
        <>
          {bundles.map((b) => (
            <SkillBundleCard key={b.id} initial={b} saved skills={skills} onError={onError} onChanged={load} />
          ))}
          {drafts.map((b) => (
            <SkillBundleCard
              key={b.id}
              initial={b}
              saved={false}
              skills={skills}
              onError={onError}
              onChanged={async () => {
                dropDraft(b.id);
                await load();
              }}
              onDiscard={() => dropDraft(b.id)}
            />
          ))}
          {bundles.length === 0 && drafts.length === 0 && (
            <div className="muted small">No bundles yet — add one to select a whole set for a project in one pick.</div>
          )}
          <div>
            <button className="btn-sm" onClick={addDraft}>+ bundle</button>
          </div>
        </>
      )}
    </section>
  );
}

function SkillBundleCard({
  initial,
  saved,
  skills,
  onError,
  onChanged,
  onDiscard,
}: {
  initial: SkillBundleUpsert;
  /** false = a local draft (Save creates it; Discard drops it with no server call). */
  saved: boolean;
  skills: Skill[];
  onError: (m: string) => void;
  /** Fired after a successful save/delete so the parent reloads the list. */
  onChanged: () => void | Promise<void>;
  onDiscard?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [skillIds, setSkillIds] = useState<string[]>(initial.skillIds);
  const [busy, setBusy] = useState(false);
  // SPEC-SKILLS Phase 5b wave 2 — the selection-side retype gate's honest UX: a member removal that
  // would drop a protected skill from a selecting project's effective set 409s with the dropped
  // name(s); the operator retypes them here and saves again. The server's equality check is the
  // boundary — this input only carries the text (wire-only, never stored on the bundle).
  const [retypeMsg, setRetypeMsg] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');

  const toggle = (id: string) =>
    setSkillIds((cur) => (cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id]));

  const save = async () => {
    if (!name.trim()) {
      onError('A bundle needs a name.');
      return;
    }
    setBusy(true);
    try {
      await tower.upsertSkillBundle({
        id: initial.id,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        skillIds,
        ...(retypeMsg && confirmName ? { confirmName } : {}),
      });
      setRetypeMsg(null);
      setConfirmName('');
      await onChanged();
    } catch (e) {
      const gate = retypeGateMessage(e);
      if (gate) setRetypeMsg(gate);
      else onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Delete is server-refused (409, naming the referencing projects) while any project selects this
  // bundle — the message lands in onError, nothing is silently unassigned.
  const remove = async () => {
    setBusy(true);
    try {
      await tower.deleteSkillBundle(initial.id);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sorted = skills.slice().sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="wf-card">
      <div className="wf-head">
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Name</label>
          <input placeholder="docs-pack" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Description (optional)</label>
          <input
            placeholder="what this bundle is for"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label>Skills in this bundle</label>
        {sorted.length === 0 ? (
          <span className="hint">No skills in the library yet — import or author one first.</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 260, overflow: 'auto' }}>
            {sorted.map((s) => (
              <label key={s.id} className="settings-toggle" style={{ gap: 8 }}>
                <input type="checkbox" checked={skillIds.includes(s.id)} onChange={() => toggle(s.id)} />
                <span>{s.name}</span>
                <span className="muted small mono">{s.id}</span>
                {!s.enabled && <span className="chip hold" title="disabled in the library — the master switch still excludes it">library-disabled</span>}
                {s.scope === 'project' && <span className="chip" title="selected — delivered to terminals in a later phase">project scope</span>}
              </label>
            ))}
          </div>
        )}
      </div>
      {retypeMsg && (
        <div className="field">
          <span className="settings-warn">⚠ {retypeMsg}</span>
          <input
            className="mono small"
            style={{ maxWidth: 280 }}
            value={confirmName}
            placeholder="retype the protected skill name(s)"
            onChange={(e) => setConfirmName(e.target.value)}
          />
        </div>
      )}
      <div className="pv-actions">
        <button className="btn ok" disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? 'Working…' : saved ? 'Save bundle' : 'Create bundle'}
        </button>
        {saved ? (
          <button className="btn-sm danger" disabled={busy} onClick={() => void remove()}>
            delete
          </button>
        ) : (
          <button className="btn-sm ghost" disabled={busy} onClick={onDiscard}>
            discard
          </button>
        )}
      </div>
    </div>
  );
}
