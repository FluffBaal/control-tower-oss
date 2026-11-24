// Control Tower — Files rail view (SPEC-FILES §5a). Project-scope browsing: the picked
// project's repo root — "what LANDED" — vs the Cockpit files tab, which shows a live agent's
// worktree. Controlled-id pattern (the SettingsView `section`/`setSection` idiom): App owns
// `filesProjectId`, so the sector-head "files" shortcut can deep-link a project before this
// view mounts.

import { useEffect } from 'react';
import type { Project } from '../shared/types.js';
import { FilesPanel } from './FilesPanel.js';

export function FilesView({ projects, projectId, setProjectId, onError }: {
  projects: Project[];
  projectId: string;
  setProjectId: (id: string) => void;
  onError: (m: string) => void;
}) {
  // Keep a valid selection as projects arrive/change (the StoriesView guard, controlled here).
  useEffect(() => {
    const first = projects[0];
    if (first && !projects.some((p) => p.id === projectId)) setProjectId(first.id);
  }, [projects, projectId, setProjectId]);

  const project = projects.find((p) => p.id === projectId);
  return (
    <div className="files-view">
      <div className="view-title">
        <h1>Files</h1>
        <span className="sub">browse the project tree · view files · preview built artifacts</span>
        <div style={{ flex: 1 }} />
        {projects.length > 1 && (
          <select className="st-proj" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>
      {projects.length === 0 ? (
        <div className="empty-sector">No projects yet — add one on the Flightline to browse its files.</div>
      ) : project ? (
        <div className="files-view-body">
          {/* keyed remount: switching projects resets the tree/viewer wholesale */}
          <FilesPanel key={project.id} scope={{ projectId: project.id }} onError={onError} />
        </div>
      ) : null}
    </div>
  );
}
