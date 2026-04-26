/**
 * Actor metadata sidecar files.
 *
 * Each persistent actor has a sidecar `<sessionsDir>/actor-<name>.meta.json`
 * alongside its session file. The sidecar preserves the information the
 * SessionManager does NOT save (role id, persistence flag, createdAt), so the
 * actor can be fully restored on boot with the correct role context.
 *
 * Lifecycle:
 *  - Written when a session becomes persistent (creation with persistent:true
 *    or toggle ON).
 *  - Deleted when the session stops being persistent (toggle OFF, kill, or
 *    shutdown of an ephemeral actor whose saved session file is being removed).
 *
 * The sidecar lives in the SAME directory as the session JSON so both appear
 * and disappear together. Path resolution matches conversation-store.ts:
 * `join(process.cwd(), ".jarvis", "sessions")`.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ActorMeta {
  /** Role id (matches ~/.jarvis/roles/<id>.md filename or a BUILT_IN_ROLES id). */
  roleId: string;
  /** Mirrors Actor.persistent at write time. */
  persistent: boolean;
  /** Epoch millis — when the actor was first created. */
  createdAt: number;
}

const SESSIONS_DIR = join(process.cwd(), ".jarvis", "sessions");

function metaPath(name: string): string {
  return join(SESSIONS_DIR, `actor-${name}.meta.json`);
}

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/** Read the sidecar for an actor. Returns null if missing or malformed. */
export function readActorMeta(name: string): ActorMeta | null {
  const path = metaPath(name);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
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
  ensureDir();
  const path = metaPath(name);
  writeFileSync(path, JSON.stringify(meta, null, 2), "utf-8");
}

/** Delete the sidecar for an actor. Safe to call if file doesn't exist. */
export function deleteActorMeta(name: string): void {
  const path = metaPath(name);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

/** List all actor names that have a sidecar on disk. */
export function listActorMetas(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter(f => f.startsWith("actor-") && f.endsWith(".meta.json"))
    .map(f => f.slice("actor-".length, -".meta.json".length));
}
