/**
 * Actor metadata sidecar files.
 *
 * Each persistent actor has a sidecar at
 * `<sessionsDir>/actor-pool-meta/<name>.json` that preserves what the
 * SessionManager itself does NOT save (role id, persistence flag, createdAt),
 * so the actor can be fully restored on boot with the correct role context.
 *
 * Why a subdirectory?
 *   The sessions directory is scanned by `listSavedSessions()` (core), which
 *   filters by `.json` only. Older versions of this plugin wrote sidecars as
 *   `actor-<name>.meta.json` next to the session file. Because of the broad
 *   filter, every restart would treat each `.meta.json` as a brand-new actor
 *   session label (`actor-<name>.meta`), spawn a phantom actor for it, and
 *   then write ANOTHER sidecar `actor-<name>.meta.meta.json`, cascading on
 *   every boot (`.meta.meta.meta.json` …).
 *
 * Moving sidecars into a dedicated subdir (`actor-pool-meta/`) keeps them
 * outside the session scanner's reach and prevents the cascade entirely.
 *
 * Backwards compatibility:
 *   On read/list/delete we transparently look for the legacy path
 *   `<sessionsDir>/actor-<name>.meta.json` and migrate it into the new
 *   location. The migration is idempotent and removes the old file.
 *
 * Lifecycle:
 *  - Written when a session becomes persistent (creation with persistent:true
 *    or toggle ON).
 *  - Deleted when the session stops being persistent (toggle OFF, kill, or
 *    shutdown of an ephemeral actor whose saved session file is being removed).
 */

import {
  readFileSync, writeFileSync, existsSync, unlinkSync,
  mkdirSync, readdirSync, renameSync,
} from "node:fs";
import { join } from "node:path";

export interface ActorMeta {
  /** Role id (matches ~/.jarvis/roles/<id>.md filename or a BUILT_IN_ROLES id). */
  roleId: string;
  /** Mirrors Actor.persistent at write time. */
  persistent: boolean;
  /** Epoch millis — when the actor was first created. */
  createdAt: number;
}

// ─── Paths ────────────────────────────────────────────────────

const SESSIONS_DIR = join(process.cwd(), ".jarvis", "sessions");
const META_DIR = join(SESSIONS_DIR, "actor-pool-meta");

/** Current canonical path for an actor's sidecar. */
function metaPath(name: string): string {
  return join(META_DIR, `${name}.json`);
}

/** Legacy path used by older versions of the plugin. */
function legacyMetaPath(name: string): string {
  return join(SESSIONS_DIR, `actor-${name}.meta.json`);
}

function ensureMetaDir(): void {
  if (!existsSync(META_DIR)) {
    mkdirSync(META_DIR, { recursive: true });
  }
}

// ─── Migration ────────────────────────────────────────────────

/**
 * One-shot migration: move every legacy `actor-<name>.meta.json` from
 * SESSIONS_DIR into META_DIR/<name>.json. Also cleans up the cascade artifacts
 * (`actor-<name>.meta.meta*.json`) that were created by previous boots before
 * this fix.
 *
 * Safe to call any number of times; it does nothing once SESSIONS_DIR is clean.
 * Returns the count of migrated and cleaned files for logging.
 */
export function migrateLegacyMetaSidecars(): { migrated: number; cleaned: number } {
  if (!existsSync(SESSIONS_DIR)) return { migrated: 0, cleaned: 0 };
  const entries = readdirSync(SESSIONS_DIR);
  let migrated = 0;
  let cleaned = 0;

  for (const entry of entries) {
    // Match only files at the sessions root that follow the legacy pattern.
    if (!entry.startsWith("actor-") || !entry.endsWith(".json")) continue;

    // ──  Cascade artifacts: actor-X.meta.meta.json, .meta.meta.meta.json, etc.
    //     The phantom actors they refer to were never real — drop them and
    //     also drop any matching session JSON that was created for them.
    if (/\.meta(\.meta)+\.json$/.test(entry)) {
      try {
        unlinkSync(join(SESSIONS_DIR, entry));
        cleaned++;
      } catch { /* ignore */ }
      continue;
    }

    // Phantom session files: `actor-<x>.meta.json` (without the cascade suffix)
    // that exist because listSavedSessions returned <x>.meta as a label and
    // SessionManager wrote a session JSON for it. We can identify these as
    // session files whose name contains `.meta` BUT only when the legacy
    // sidecar pattern matched. Easiest test: name has `.meta` in the stem.
    // Treat them as cleanup, NOT migration.
    const stem = entry.slice(0, -".json".length); // e.g. actor-jarvis-imp.meta
    if (stem.endsWith(".meta")) {
      // Could be a sidecar (legacy) OR a phantom session. Disambiguate by
      // peeking at the JSON shape: sidecar has {roleId, persistent, createdAt};
      // phantom session has {messages: [...]} or sessionId.
      const fullPath = join(SESSIONS_DIR, entry);
      let isSidecar = false;
      try {
        const raw = readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(raw);
        isSidecar = typeof parsed?.roleId === "string";
      } catch { /* treat as phantom on parse failure */ }

      if (isSidecar) {
        // Migrate: actor-<name>.meta.json → actor-pool-meta/<name>.json
        const name = stem.slice("actor-".length, -".meta".length);
        if (!name) continue;
        ensureMetaDir();
        const target = metaPath(name);
        try {
          if (existsSync(target)) {
            // Newer sidecar already exists — keep new, drop legacy.
            unlinkSync(fullPath);
          } else {
            renameSync(fullPath, target);
          }
          migrated++;
        } catch { /* ignore */ }
      } else {
        // Phantom session — drop it.
        try {
          unlinkSync(fullPath);
          cleaned++;
        } catch { /* ignore */ }
      }
    }
  }

  return { migrated, cleaned };
}

// ─── CRUD ─────────────────────────────────────────────────────

/** Read the sidecar for an actor. Returns null if missing or malformed. */
export function readActorMeta(name: string): ActorMeta | null {
  const path = metaPath(name);
  // Auto-migrate legacy sidecar on read (covers any straggler not caught
  // by migrateLegacyMetaSidecars()).
  if (!existsSync(path)) {
    const legacy = legacyMetaPath(name);
    if (existsSync(legacy)) {
      try {
        ensureMetaDir();
        renameSync(legacy, path);
      } catch { /* fall through; we'll read from legacy below */ }
    }
  }

  const target = existsSync(path) ? path : legacyMetaPath(name);
  if (!existsSync(target)) return null;

  try {
    const raw = readFileSync(target, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ActorMeta>;
    if (typeof parsed?.roleId !== "string" || !parsed.roleId) return null;
    return {
      roleId: parsed.roleId,
      persistent: parsed.persistent === true,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/** Write (or overwrite) the sidecar for an actor. */
export function writeActorMeta(name: string, meta: ActorMeta): void {
  ensureMetaDir();
  writeFileSync(metaPath(name), JSON.stringify(meta, null, 2), "utf-8");

  // Belt-and-suspenders: if a stale legacy file is still around for this
  // actor, remove it now to keep the sessions root clean.
  const legacy = legacyMetaPath(name);
  if (existsSync(legacy)) {
    try { unlinkSync(legacy); } catch { /* ignore */ }
  }
}

/** Delete the sidecar for an actor. Safe to call if file doesn't exist. */
export function deleteActorMeta(name: string): void {
  for (const path of [metaPath(name), legacyMetaPath(name)]) {
    if (existsSync(path)) {
      try { unlinkSync(path); } catch { /* ignore */ }
    }
  }
}

/** List all actor names that have a sidecar on disk. */
export function listActorMetas(): string[] {
  const names = new Set<string>();

  // Canonical location.
  if (existsSync(META_DIR)) {
    for (const f of readdirSync(META_DIR)) {
      if (f.endsWith(".json")) names.add(f.slice(0, -".json".length));
    }
  }

  // Legacy fallback (still readable until migration runs).
  if (existsSync(SESSIONS_DIR)) {
    for (const f of readdirSync(SESSIONS_DIR)) {
      if (f.startsWith("actor-") && f.endsWith(".meta.json")
          && !/\.meta\.meta(\.meta)*\.json$/.test(f)) {
        names.add(f.slice("actor-".length, -".meta.json".length));
      }
    }
  }

  return [...names];
}
