// Project Files (SPEC-FILES): browse a project's directory tree, view a file, download raw
// bytes, and serve the sandboxed artifact preview — for the project repo or a terminal/loop
// worktree. READ-ONLY by design: write/edit/delete/mkdir are an explicit NON-GOAL (SPEC-FILES
// §8) — a repo write from here would bypass the worktree→review→land pipeline, dirty the main
// checkout (land refuses a dirty main), and need Leases. Do not add a write route to this module.
//
// Containment (§2): resolveContained() is the single gate every requested path crosses. It
// realpaths both the root and the candidate (resolving EVERY symlink, final component included)
// and requires the candidate to sit at/under the real root. Both the containment-fail and the
// plain-missing paths return the SAME byte-identical `{error:'not-found'}` 404 body — a probe
// for `../../.ssh/id_ed25519` must be indistinguishable from a typo (no oracle).
// The `.git` policy is applied to the RESOLVED path's segments, never the request string, so
// `ln -s .git gitlink` cannot expose git internals.
//
// TOCTOU acceptance (§2, deliberate): between realpath and open, a LOCAL writer could swap a
// path component for a symlink. The only principal with that power pre-M4 is an agent running
// as this user — which can already read any file directly (SPEC §14 / D14). The adversary these
// routes defend against is the network/browser side, which cannot race the filesystem. So
// realpath + prefix check + fstat-on-the-open-fd is the correct level of rigor here.
//
// FIFO/device hazard: a plain blocking open() of an attacker-placed FIFO would
// wedge before any fstat gate can run. Every open of a request-derived path in this module uses
// async fs with O_RDONLY|O_NONBLOCK, then fstats the fd and rejects non-regular files.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { token as makeToken } from './ids.js';
import { audit } from './audit.js';
import type { Store } from './store.js';
import { authRoutePath, type Auth } from './auth.js';
import type { FileContent, FileEntry, FileListing, PreviewMintResponse } from '../shared/types.js';

// ---- errors ----

/** Containment/lookup failure. 'not-found' → 404 (byte-identical body, no oracle);
 *  'root-gone' → 409 (repoPath moved or worktree removed). */
export class FileAccessError extends Error {
  constructor(readonly kind: 'not-found' | 'root-gone') {
    super(kind);
  }
}

/** fstat said the opened fd is not S_ISREG (FIFO, device, socket, directory) → 400. */
export class NotRegularFileError extends Error {
  constructor() {
    super('not a regular file');
  }
}

// The one 404 body every not-found path serializes: containment escape, plain
// missing file, `.git` probe, and unknown project are all byte-identical on the wire.
const NOT_FOUND_BODY = { error: 'not-found' } as const;
const ROOT_GONE_BODY = { error: 'root-gone' } as const;

// ---- §2 path containment (load-bearing) ----

/**
 * Resolve `rel` strictly inside `rootAbs`. Returns the fully-symlink-resolved candidate
 * (`real`), the normalized request path (`relNorm`, '.' for the root itself), and the resolved
 * root (`rootReal`, a convenience superset of the frozen §9 signature — listDir needs it for
 * the resolved-segment `.git` test). Throws FileAccessError('root-gone') when the root itself
 * no longer resolves, FileAccessError('not-found') for everything else that must not be
 * distinguishable (missing, escaped, `.git`).
 */
export function resolveContained(
  rootAbs: string,
  rel: string,
): { real: string; relNorm: string; rootReal: string } {
  if (rel.includes('\0')) throw new FileAccessError('not-found');
  if (path.isAbsolute(rel)) throw new FileAccessError('not-found');
  const norm = path.normalize(rel === '' ? '.' : rel);
  if (norm === '..' || norm.startsWith('..' + path.sep)) throw new FileAccessError('not-found');
  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    throw new FileAccessError('root-gone');
  }
  let candReal: string;
  try {
    candReal = realpathSync(path.resolve(rootReal, norm));
  } catch {
    throw new FileAccessError('not-found');
  }
  if (!(candReal === rootReal || candReal.startsWith(rootReal + path.sep))) {
    throw new FileAccessError('not-found');
  }
  // `.git` policy on the RESOLVED path: testing the request string instead would
  // let `ln -s .git gitlink` + `gitlink/config` through (the symlink target passes containment).
  const relResolved = path.relative(rootReal, candReal);
  if (relResolved.split(path.sep).some((seg) => seg === '.git')) {
    throw new FileAccessError('not-found');
  }
  return { real: candReal, relNorm: norm, rootReal };
}

// ---- listing ----

/** Dirs the web de-emphasizes; tagged server-side so the flag survives any client. */
const HEAVY_DIRS = new Set(['node_modules', 'dist', 'coverage']);

/**
 * List ONE directory (lazy — no recursion). Dirs-first alphabetical; `.git` omitted by the
 * same resolved-segment test as reads (a symlink whose TARGET is .git is omitted too); heavy
 * dirs tagged; capped at `maxEntries` with `truncated`. Entries that vanish mid-listing
 * (concurrent land) are skipped, never a crash (§7).
 */
export async function listDir(
  dirReal: string,
  rootReal: string,
  maxEntries: number,
): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  const dirents = (await fsp.readdir(dirReal, { withFileTypes: true })).filter(
    (d) => d.name !== '.git',
  );
  dirents.sort(
    (a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name),
  );
  const truncated = dirents.length > maxEntries;
  const sliced = dirents.slice(0, maxEntries);
  const built = await Promise.all(
    sliced.map(async (d): Promise<FileEntry | null> => {
      const full = path.join(dirReal, d.name);
      try {
        if (d.isSymbolicLink()) {
          let targetReal: string;
          try {
            targetReal = await fsp.realpath(full);
          } catch {
            return { name: d.name, type: 'symlink', broken: true };
          }
          // Same resolved-segment .git test as resolveContained: omit links INTO .git.
          const relT = path.relative(rootReal, targetReal);
          if (relT.split(path.sep).some((seg) => seg === '.git')) return null;
          // A link whose target ESCAPES the root is reported broken, NOT stat'd: stating it would
          // leak the out-of-root target's size/mtime/existence to the browser, which the read path
          // (resolveContained) deliberately 404s. Containment mirrors resolveContained's prefix test.
          if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
            return { name: d.name, type: 'symlink', broken: true };
          }
          const st = await fsp.stat(full).catch(() => null);
          if (!st) return { name: d.name, type: 'symlink', broken: true };
          return {
            name: d.name,
            type: 'symlink',
            ...(st.isFile() ? { size: st.size } : {}),
            mtime: st.mtime.toISOString(),
          };
        }
        if (d.isDirectory()) {
          const st = await fsp.lstat(full);
          return {
            name: d.name,
            type: 'dir',
            mtime: st.mtime.toISOString(),
            ...(HEAVY_DIRS.has(d.name) ? { heavy: true } : {}),
          };
        }
        if (d.isFile()) {
          const st = await fsp.lstat(full);
          return { name: d.name, type: 'file', size: st.size, mtime: st.mtime.toISOString() };
        }
        return { name: d.name, type: 'other' };
      } catch {
        return null; // vanished mid-listing
      }
    }),
  );
  return { entries: built.filter((e): e is FileEntry => e !== null), truncated };
}

// ---- file envelope ----

/** ext → mime for the inline base64 image path of route B (an <img> can't send the token). */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};
const IMG_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_SNIFF_BYTES = 8 * 1024;

const OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;

async function readFully(fh: FileHandle, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  return off === len ? buf : buf.subarray(0, off);
}

/**
 * Open + classify + read one file (route B). O_NONBLOCK open, fstat the fd, reject non-regular
 *. Small image by extension → base64; text (no NUL in the first 8 KiB) → utf8
 * truncated at `fileMaxBytes`; anything else → encoding:'none' (client offers the raw route).
 */
export async function readFileEnvelope(
  real: string,
  relNorm: string,
  fileMaxBytes: number,
): Promise<FileContent> {
  const fh = await fsp.open(real, OPEN_FLAGS);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new NotRegularFileError();
    const mtime = st.mtime.toISOString();
    const ext = path.extname(real).slice(1).toLowerCase();
    const imgMime = IMAGE_MIME[ext];
    if (imgMime && st.size <= IMG_MAX_BYTES) {
      const buf = await readFully(fh, st.size);
      return {
        path: relNorm,
        size: st.size,
        mtime,
        binary: true,
        truncated: false,
        encoding: 'base64',
        content: buf.toString('base64'),
        mime: imgMime,
      };
    }
    const sniff = await readFully(fh, Math.min(TEXT_SNIFF_BYTES, st.size));
    if (sniff.includes(0)) {
      return {
        path: relNorm,
        size: st.size,
        mtime,
        binary: true,
        truncated: false,
        encoding: 'none',
        content: '',
      };
    }
    const body = await readFully(fh, Math.min(st.size, fileMaxBytes));
    return {
      path: relNorm,
      size: st.size,
      mtime,
      binary: false,
      truncated: st.size > fileMaxBytes,
      encoding: 'utf8',
      content: body.toString('utf8'),
    };
  } finally {
    await fh.close();
  }
}

// ---- preview grants (§4) ----

interface PreviewGrant {
  id: string;
  projectId: string;
  /** dirname(realpath(entry)) captured at mint — the granted subtree. */
  rootReal: string;
  expiresAt: number;
}

const GRANT_CAP = 32;

/** Extension → Content-Type allowlist for route E. Anything else streams as octet-stream +
 *  attachment. Deliberately NO wasm (it can't run under this CSP anyway). */
const PREVIEW_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

/** RFC 6266 attachment disposition with a CR/LF-free ascii fallback. */
function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ---- registration ----

export interface FileRouteDeps {
  store: Store;
  /** For frame-ancestors: only the Tower app's own origins may embed a preview. */
  auth: Auth;
  /** Resolved env caps (server.ts intEnv — passed in, not re-parsed here). */
  caps: {
    /** CT_FILES_MAX_ENTRIES */ maxEntries: number;
    /** CT_FILE_MAX_BYTES */ fileMaxBytes: number;
    /** CT_RAW_MAX_BYTES */ rawMaxBytes: number;
    /** CT_PREVIEW_TTL_MS */ previewTtlMs: number;
  };
}

type FilesQuery = { path?: string; wt?: string };

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  const { store, caps } = deps;
  const grants = new Map<string, PreviewGrant>();

  const sweepGrants = (now = Date.now()) => {
    for (const [k, g] of grants) if (g.expiresAt <= now) grants.delete(k);
  };

  /** Root selection shared by routes A–D: repo, or a term/loop worktree (`?wt=`). */
  const resolveRoot = (
    projectId: string,
    wt: string | undefined,
  ):
    | { ok: true; abs: string; kind: 'repo' | 'worktree'; label: string }
    | { ok: false; code: number; body: object } => {
    const project = store.getProject(projectId);
    if (!project) return { ok: false, code: 404, body: NOT_FOUND_BODY };
    if (wt === undefined || wt === '') {
      return { ok: true, abs: project.repoPath, kind: 'repo', label: project.name };
    }
    const m = /^(term|loop):(.+)$/.exec(wt);
    if (!m) return { ok: false, code: 400, body: { error: 'bad wt' } };
    const rec = m[1] === 'term' ? store.getTerminal(m[2]!) : store.getLoop(m[2]!);
    // Inverse of withTermProject: the record must belong to :id, or the wt param would let a
    // caller walk another project's worktree under this project's URL.
    if (!rec || rec.projectId !== projectId) return { ok: false, code: 400, body: { error: 'bad wt' } };
    if (!rec.worktreePath) return { ok: false, code: 409, body: ROOT_GONE_BODY };
    return {
      ok: true,
      abs: rec.worktreePath,
      kind: 'worktree',
      label: rec.branch ?? path.basename(rec.worktreePath),
    };
  };

  /** Map fs/containment failures to HTTP. Unlisted errors rethrow → 500. */
  const sendFsError = (reply: FastifyReply, e: unknown): FastifyReply => {
    if (e instanceof FileAccessError) {
      return e.kind === 'root-gone'
        ? reply.code(409).send(ROOT_GONE_BODY)
        : reply.code(404).send(NOT_FOUND_BODY);
    }
    if (e instanceof NotRegularFileError) {
      return reply.code(400).send({ error: 'not a regular file' });
    }
    const code = (e as NodeJS.ErrnoException)?.code;
    // Same body as containment failure — EACCES/ELOOP etc. must not become a different oracle.
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') {
      return reply.code(404).send(NOT_FOUND_BODY);
    }
    throw e;
  };

  /** Query params arrive typed as string, but a repeated ?path=&path= is an array at runtime. */
  const qstr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  // ---- A. list one directory ----
  app.get<{ Params: { id: string }; Querystring: FilesQuery }>(
    '/api/projects/:id/files',
    async (req, reply) => {
      const root = resolveRoot(req.params.id, qstr(req.query.wt));
      if (!root.ok) return reply.code(root.code).send(root.body);
      try {
        const rc = resolveContained(root.abs, qstr(req.query.path) ?? '');
        const { entries, truncated } = await listDir(rc.real, rc.rootReal, caps.maxEntries);
        const listing: FileListing = {
          root: root.kind,
          rootLabel: root.label,
          path: rc.relNorm === '.' ? '' : rc.relNorm,
          entries,
          truncated,
        };
        return listing;
      } catch (e) {
        return sendFsError(reply, e);
      }
    },
  );

  // ---- B. view one file ----
  app.get<{ Params: { id: string }; Querystring: FilesQuery }>(
    '/api/projects/:id/file',
    async (req, reply) => {
      const root = resolveRoot(req.params.id, qstr(req.query.wt));
      if (!root.ok) return reply.code(root.code).send(root.body);
      try {
        const rc = resolveContained(root.abs, qstr(req.query.path) ?? '');
        return await readFileEnvelope(rc.real, rc.relNorm === '.' ? '' : rc.relNorm, caps.fileMaxBytes);
      } catch (e) {
        return sendFsError(reply, e);
      }
    },
  );

  // ---- C. raw download (streamed, never buffered) ----
  app.get<{ Params: { id: string }; Querystring: FilesQuery }>(
    '/api/projects/:id/file/raw',
    async (req, reply) => {
      const root = resolveRoot(req.params.id, qstr(req.query.wt));
      if (!root.ok) return reply.code(root.code).send(root.body);
      try {
        const rc = resolveContained(root.abs, qstr(req.query.path) ?? '');
        const fh = await fsp.open(rc.real, OPEN_FLAGS);
        let st;
        try {
          st = await fh.stat();
          if (!st.isFile()) throw new NotRegularFileError();
          if (st.size > caps.rawMaxBytes) {
            await fh.close();
            return reply.code(413).send({ error: 'file too large' });
          }
        } catch (e) {
          await fh.close().catch(() => {});
          throw e;
        }
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', attachmentDisposition(path.basename(rc.real)));
        reply.header('X-Content-Type-Options', 'nosniff');
        // createReadStream(autoClose) owns the fd from here. Bound the stream to the size the cap
        // was checked against, so a file grown after the fstat gate can't ship past rawMaxBytes.
        return reply.send(fh.createReadStream(st.size > 0 ? { end: st.size - 1 } : {}));
      } catch (e) {
        return sendFsError(reply, e);
      }
    },
  );

  // ---- D. mint a preview grant ----
  app.post<{ Params: { id: string }; Body: { path?: string; wt?: string } }>(
    '/api/projects/:id/preview',
    async (req, reply) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as {
        path?: unknown;
        wt?: unknown;
      };
      const relPath = qstr(body.path);
      if (!relPath) return reply.code(400).send({ error: 'path required' });
      const root = resolveRoot(req.params.id, qstr(body.wt));
      if (!root.ok) return reply.code(root.code).send(root.body);
      try {
        const rc = resolveContained(root.abs, relPath);
        // Regular-file check AT MINT: a grant must never be rooted on a dir
        // symlink trick or point route E at a FIFO. Same O_NONBLOCK+fstat gate as reads.
        const fh = await fsp.open(rc.real, OPEN_FLAGS);
        try {
          const st = await fh.stat();
          if (!st.isFile()) throw new NotRegularFileError();
        } finally {
          await fh.close();
        }
        sweepGrants();
        while (grants.size >= GRANT_CAP) {
          const oldest = grants.keys().next().value;
          if (oldest === undefined) break;
          grants.delete(oldest);
        }
        const pid = makeToken();
        const expiresAt = Date.now() + caps.previewTtlMs;
        grants.set(pid, {
          id: pid,
          projectId: req.params.id,
          rootReal: path.dirname(rc.real),
          expiresAt,
        });
        // Audit a prefix only — the full id is a live capability and must not persist on disk.
        audit('preview.mint', {
          projectId: req.params.id,
          path: rc.relNorm,
          wt: qstr(body.wt) ?? null,
          previewId: pid.slice(0, 8),
        });
        const resp: PreviewMintResponse = {
          previewId: pid,
          url: `/preview/${pid}/${encodeURIComponent(path.basename(rc.real))}`,
          expiresAt: new Date(expiresAt).toISOString(),
        };
        return resp;
      } catch (e) {
        return sendFsError(reply, e);
      }
    },
  );

  // ---- E. serve the granted subtree (capability URL, no token) ----
  app.get<{ Params: { pid: string; '*': string } }>('/preview/:pid/*', async (req, reply) => {
    sweepGrants();
    const grant = grants.get(req.params.pid);
    if (!grant) return reply.code(404).send(NOT_FOUND_BODY);
    try {
      const rc = resolveContained(grant.rootReal, req.params['*'] ?? '');
      const fh = await fsp.open(rc.real, OPEN_FLAGS);
      let size = 0;
      try {
        const st = await fh.stat();
        // Non-regular (incl. a directory request) is a plain 404 on this unauthenticated
        // surface — less shape information than the 400 the session routes return.
        if (!st.isFile()) {
          await fh.close();
          return reply.code(404).send(NOT_FOUND_BODY);
        }
        size = st.size;
      } catch (e) {
        await fh.close().catch(() => {});
        throw e;
      }
      const ext = path.extname(rc.real).slice(1).toLowerCase();
      const mime = PREVIEW_MIME[ext];
      if (mime) {
        reply.header('Content-Type', mime);
      } else {
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', attachmentDisposition(path.basename(rc.real)));
      }
      return reply.send(fh.createReadStream(size > 0 ? { end: size - 1 } : {}));
    } catch (e) {
      // Uniform 404 on this unauthenticated capability surface: a vanished grant dir (root-gone
      // → normally 409) or an escaping/missing path must look identical to an unknown pid — no
      // existence oracle for a caller holding a valid capability.
      if (e instanceof FileAccessError) return reply.code(404).send(NOT_FOUND_BODY);
      return sendFsError(reply, e);
    }
  });

  // ---- §4 security headers: the SINGLE wrapper for EVERY /preview response ----
  // onSend runs after handlers, notFound, hook-rejections, and error paths alike, so no
  // /preview response — 200, 404, 403, or 500 — can ship without this block (no-store per
  // SPEC S14). The fetch-directives use the EXPLICIT host-source
  // `<ORIGIN>/preview/<pid>/`, NOT 'self': `sandbox allow-scripts` gives the
  // document an opaque origin, and 'self' never matches an opaque origin — it would block
  // every external <script src>/<img> and break multi-file artifacts. A host-source matches
  // by URL, so relative subresources under the grant load while /api/*, the app bundle, and
  // other grants stay blocked. <ORIGIN> is rebuilt per response from the request's Host
  // (httpGuard-validated for routed /preview requests); pid and host are character-checked
  // before being embedded so a hostile URL/Host can't inject CSP source expressions.
  const frameAncestors = deps.auth.origins.join(' ');
  // The CSP host-source is built from the request Host — require it to be an ALLOWLISTED app host
  // (not merely char-class valid), so the served artifact's script-src integrity never depends on
  // httpGuard's Host check having run first: a DNS-rebind Host that passed the char class alone must
  // not be embeddable into a preview's CSP. Anything else falls the fetch-directives back to 'none'.
  const previewHosts = new Set(deps.auth.hosts);
  const PID_RE = /^[A-Za-z0-9_-]+$/;
  const HOST_RE = /^[A-Za-z0-9.\-:[\]]+$/;
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    // Apply the preview sandbox to the same route that the request guard authorized.
    const p = authRoutePath(req.url, req.routeOptions?.url);
    if (p !== '/preview' && !p.startsWith('/preview/')) return payload;
    const rawPid = (req.params as { pid?: string } | undefined)?.pid;
    const pid = rawPid && PID_RE.test(rawPid) ? rawPid : null;
    const rawHost = req.headers.host ?? '';
    const host = HOST_RE.test(rawHost) && previewHosts.has(rawHost) ? rawHost : null;
    // The Tower serves plain http on loopback; a TLS-terminating front proxy is out of scope.
    const self = pid && host ? `http://${host}/preview/${pid}/` : null;
    const csp = [
      'sandbox allow-scripts',
      "default-src 'none'",
      self ? `script-src ${self} 'unsafe-inline'` : "script-src 'none'",
      self ? `style-src ${self} 'unsafe-inline'` : "style-src 'none'",
      self ? `img-src ${self} data: blob:` : "img-src 'none'",
      self ? `font-src ${self} data:` : "font-src 'none'",
      self ? `media-src ${self} data: blob:` : "media-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${frameAncestors}`,
    ].join('; ');
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
}
