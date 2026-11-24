// Per-project e2e testing config (SPEC-TESTING §4) — the deterministic suite invocation, the
// regression-gate suite, and the phase toggles, persisted in ~/.ct/config/testing.json. NOT
// provider/model (that is routing.json): this is the "what command runs the suite" half.
//
// The store mirrors RoutingStore's load discipline (routing.ts §6): per-entry salvage on a
// versioned file, a .bak + keep-empty on anything corrupt/foreign/future, and NO eager rewrite
// at load — only a real operator mutation persists, so a bad file can never be clobbered by
// merely starting the Tower. Written atomically at 0600 (Tower-owned config).

import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { z } from 'zod';
import { paths } from '../paths.js';
import { writeJsonAtomic } from '../store.js';
import type { ProjectTestingConfig } from '../../shared/types.js';

// EVERY field of ProjectTestingConfig listed (the M6 strip trap: an unlisted optional field is
// stripped on load). Commands are trimmed, non-empty, ~500-char capped — but NEVER sanitized:
// suiteCommand/gateSuite are agent-shell-exec'd by design (the checkCommand trust class),
// so the store's only job is bounding, not escaping. The routes stay session-token ONLY.
const projectTestingSchema = z.object({
  suiteCommand: z.string().trim().min(1).max(500).optional(),
  gateSuite: z.string().trim().min(1).max(500).optional(),
  docsPhase: z.boolean().optional(),
  autoFileFailures: z.boolean().optional(),
  // SPEC-LOOP W5 — release-time log capture (both MUST be listed or the M6 strip trap drops them on
  // load). logSources: repo-relative file/dir entries, trimmed non-empty, ≤300 chars, ≤12 entries.
  logSources: z.array(z.string().trim().min(1).max(300)).max(12).optional(),
  captureDocker: z.boolean().optional(),
});

/**
 * Persists every project's testing config in ~/.ct/config/testing.json v1
 * (`{ version: 1, projects: Record<projectId, ProjectTestingConfig> }`). The get/set/prune
 * methods ARE the testing-config API surface — the integrator registers thin routes over them
 * (GET/PUT /api/projects/:id/testing) and prunes on project delete.
 */
export class TestingConfigStore {
  private projects: Record<string, ProjectTestingConfig> = {};

  constructor(private readonly file: string = paths.testing) {
    this.load();
  }

  /** Detection order (the RoutingStore §6 discipline, minus a legacy step — there is no legacy
   *  testing.json format): (1) version===1 → salvaged PER-ENTRY, each project independently, bad
   *  dropped, rest kept, no rewrite at load; (2) anything else object-shaped → corrupt, downgraded,
   *  or FUTURE — keep empty in memory, back the file up, and NEVER persist over it at load. */
  private load(): void {
    if (!existsSync(this.file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      console.error(`[testing] cannot read ${this.file}: ${(err as Error).message}`);
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`[testing] ${this.file} is not an object — ignoring it`);
      return;
    }
    const obj = parsed as Record<string, unknown>;

    // (1) A versioned v1 file — salvaged PER-ENTRY (the readJsonArray idiom): each project entry
    // is validated INDEPENDENTLY, keeping the good and dropping only the bad. We do NOT rewrite
    // the file here — the salvaged-good state is in memory, and the next real mutation persists
    // exactly that, so a bad entry can never clobber the rest at load.
    if (obj.version === 1) {
      let dropped = 0;
      this.projects = {};
      const projects =
        obj.projects && typeof obj.projects === 'object' && !Array.isArray(obj.projects)
          ? (obj.projects as Record<string, unknown>)
          : {};
      for (const [pid, entry] of Object.entries(projects)) {
        const p = projectTestingSchema.safeParse(entry);
        if (p.success) this.projects[pid] = p.data;
        else dropped++;
      }
      if (dropped > 0) {
        console.error(
          `[testing] ${this.file} had ${dropped} unparseable project entr${dropped === 1 ? 'y' : 'ies'} — ` +
            `kept the rest; the file is rewritten cleanly on the next testing-config change`,
        );
      }
      return;
    }

    // (2) No version:1 → a corrupt, downgraded, or FUTURE format we don't understand. Refuse:
    // keep testing config empty in memory, back the file up, do NOT write it at load.
    this.backupBadFile();
    console.error(
      `[testing] ${this.file} looks like a corrupt or foreign testing-config file — ` +
        `keeping testing config EMPTY and NOT persisting over it (original saved to ${this.file}.bak)`,
    );
  }

  /** Best-effort copy of an unreadable/foreign file to testing.json.bak BEFORE any possible write. */
  private backupBadFile(): void {
    try {
      copyFileSync(this.file, `${this.file}.bak`);
    } catch (err) {
      console.error(`[testing] could not back up ${this.file}: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    writeJsonAtomic(this.file, { version: 1, projects: this.projects }, 0o600);
  }

  /** A defensive copy of one project's testing config, or undefined when none is stored. */
  get(projectId: string): ProjectTestingConfig | undefined {
    const p = this.projects[projectId];
    return p ? { ...p } : undefined;
  }

  /**
   * REPLACE a project's testing config (PUT semantics — every field, not a patch). An invalid
   * shape throws (the route maps it to 400); an empty / all-undefined overlay DROPS the entry
   * entirely (= no testing config). Returns the stored view, undefined when dropped.
   */
  setProjectTesting(projectId: string, cfg: unknown): ProjectTestingConfig | undefined {
    if (!projectId) throw new Error('projectId is required');
    const res = projectTestingSchema.safeParse(cfg ?? {});
    if (!res.success) throw new Error(`invalid testing config: ${res.error.message}`);
    const entry = res.data;
    const hasAny = Object.values(entry).some((v) => v !== undefined);
    const next = { ...this.projects };
    if (!hasAny) delete next[projectId];
    else next[projectId] = entry;
    this.projects = next;
    this.persist();
    return this.get(projectId);
  }

  /** Drop a project's entry. Provided for symmetry with RoutingStore.pruneProject and a FUTURE
   *  project-delete route — nothing calls it today (stale entries are inert anyway — §4). */
  pruneProject(projectId: string): boolean {
    if (!(projectId in this.projects)) return false;
    const next = { ...this.projects };
    delete next[projectId];
    this.projects = next;
    this.persist();
    return true;
  }
}
