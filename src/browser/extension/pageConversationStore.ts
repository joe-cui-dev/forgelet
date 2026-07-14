import {
  PAGE_CONVERSATION_PROJECTION_SCHEMA_VERSION,
  type PageConversationProjection,
} from "./pageConversationProjection.js";

/** Matches the subset of `chrome.storage.session`/`chrome.storage.local`
 * Browser Workbench actually needs, so this module stays testable without
 * Chrome globals (Node tests must load it without `chrome`). */
export interface PageConversationSessionStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const PROJECTIONS_STORAGE_KEY = "forgeletPageConversationProjectionsByWindow";

type StoredProjectionsByWindow = Record<string, unknown>;

/** Reads the Page Conversation Projection reattached for one Chrome window
 * (ADR 0053). Old or unversioned state (`schemaVersion !== 3`, ADR 0054) is
 * discarded rather than migrated: callers must prompt for a new toolbar
 * capture instead of rendering it. */
export async function loadPageConversationProjection(
  storage: PageConversationSessionStorage,
  windowId: number,
): Promise<PageConversationProjection | undefined> {
  const byWindow = await readByWindow(storage);
  const candidate = byWindow[String(windowId)];
  return isValidProjection(candidate) ? candidate : undefined;
}

/** Persists one window's projection without disturbing any other window's
 * state: a toolbar gesture in one window never replaces another window's
 * projection (ADR 0053). */
export async function savePageConversationProjection(
  storage: PageConversationSessionStorage,
  windowId: number,
  projection: PageConversationProjection,
): Promise<void> {
  const byWindow = await readByWindow(storage);
  await storage.set({
    [PROJECTIONS_STORAGE_KEY]: { ...byWindow, [String(windowId)]: projection },
  });
}

/** Discards a window's projection (e.g. a fresh toolbar capture replacing
 * it outright); other windows are untouched. */
export async function clearPageConversationProjection(
  storage: PageConversationSessionStorage,
  windowId: number,
): Promise<void> {
  const byWindow = await readByWindow(storage);
  const next = { ...byWindow };
  delete next[String(windowId)];
  await storage.set({ [PROJECTIONS_STORAGE_KEY]: next });
}

async function readByWindow(
  storage: PageConversationSessionStorage,
): Promise<StoredProjectionsByWindow> {
  const stored = await storage.get([PROJECTIONS_STORAGE_KEY]);
  const byWindow = stored[PROJECTIONS_STORAGE_KEY];
  return isRecord(byWindow) ? byWindow : {};
}

function isValidProjection(value: unknown): value is PageConversationProjection {
  return isRecord(value) && value.schemaVersion === PAGE_CONVERSATION_PROJECTION_SCHEMA_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True only for transitions worth a durable write: attempt lifecycle
 * changes, new turns, new terminal cards, or a head/eviction change.
 * Streamed presentation deltas (liveText, turnIndex, model, activity)
 * return false so they never trigger a storage write per token. */
export function isMeaningfulPageConversationTransition(
  previous: PageConversationProjection | undefined,
  next: PageConversationProjection,
): boolean {
  if (!previous) return true;
  if (previous.turns.length !== next.turns.length) return true;
  if (previous.terminalCards.length !== next.terminalCards.length) return true;
  if (previous.headSessionId !== next.headSessionId) return true;
  if (previous.historyEvicted !== next.historyEvicted) return true;

  const prevAttempt = previous.currentAttempt;
  const nextAttempt = next.currentAttempt;
  if ((prevAttempt === undefined) !== (nextAttempt === undefined)) return true;
  if (prevAttempt && nextAttempt) {
    if (prevAttempt.invocationId !== nextAttempt.invocationId) return true;
    if (prevAttempt.status !== nextAttempt.status) return true;
    if (prevAttempt.sessionId !== nextAttempt.sessionId) return true;
  }
  return false;
}
