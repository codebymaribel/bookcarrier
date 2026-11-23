import type { FicMeta, FicStatus } from "../fanfic/index.js";
import type { JsonFileStore } from "../shared/index.js";

/** A followed fic: its delivery metadata plus when it was followed and last updated (R5.1). */
export type FollowedFic = FicMeta & { followedAt: number; updatedAt: number };

/** Contents of the follows file: followed fics, and the last delivered fics that offered Follow (R3.5). */
export type FollowsState = { version: 1; followed: FollowedFic[]; recent: FicMeta[] };

/** What `onDelivered` decided, so the bot can pick the delivery message and keyboard. */
export type DeliveryOutcome =
  | { kind: "offer" }
  | { kind: "updated"; chapters: number }
  | { kind: "completed" }
  | { kind: "none" };

export type FollowResult = { kind: "followed" | "already"; fic: FollowedFic } | { kind: "unknown" };
export type UnfollowResult = { kind: "unfollowed"; title: string } | { kind: "not-followed" };

export type Follows = {
  onDelivered(meta: FicMeta | undefined): Promise<DeliveryOutcome>;
  follow(workId: string): Promise<FollowResult>;
  unfollow(workId: string): Promise<UnfollowResult>;
};

/** How many delivered fics keep a usable Follow button (R3.5). */
const RECENT_LIMIT = 10;

export function emptyFollowsState(): FollowsState {
  return { version: 1, followed: [], recent: [] };
}

const STATUSES: readonly FicStatus[] = ["in-progress", "completed", "unknown"];

function parseMeta(raw: unknown): FicMeta | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const { workId, url, title, author, chapters, status } = r;
  if (typeof workId !== "string" || typeof url !== "string") return undefined;
  if (typeof title !== "string" || typeof author !== "string") return undefined;
  if (typeof chapters !== "number" || !Number.isInteger(chapters) || chapters <= 0) return undefined;
  if (typeof status !== "string" || !STATUSES.includes(status as FicStatus)) return undefined;
  return { workId, url, title, author, chapters, status: status as FicStatus };
}

function parseFollowed(raw: unknown): FollowedFic | undefined {
  const meta = parseMeta(raw);
  if (meta === undefined) return undefined;
  const { followedAt, updatedAt } = raw as Record<string, unknown>;
  if (typeof followedAt !== "number" || !Number.isFinite(followedAt)) return undefined;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined;
  return { ...meta, followedAt, updatedAt };
}

function parseList<T>(raw: unknown, parseItem: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: T[] = [];
  for (const entry of raw) {
    const item = parseItem(entry);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
}

/**
 * Validates the parsed contents of the follows file (R5.2). Returns `undefined` on a wrong version or
 * any malformed entry, which `createJsonFileStore` treats as a corrupt file.
 */
export function parseFollowsState(raw: unknown): FollowsState | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r["version"] !== 1) return undefined;
  const followed = parseList(r["followed"], parseFollowed);
  const recent = parseList(r["recent"], parseMeta);
  if (followed === undefined || recent === undefined) return undefined;
  return { version: 1, followed, recent };
}

/**
 * The followed fics and the recent-delivery list (R3.5, R5), persisted through `store`.
 *
 * Every mutation runs through one promise chain, so a queue retry and a button tap never overlap and
 * each starts from the latest state. The in-memory state is replaced only after `store.write`
 * succeeds; a failed write rejects the call and leaves memory (and the file) as they were.
 */
export function createFollows(
  store: JsonFileStore<FollowsState>,
  initial: FollowsState,
  now: () => number = Date.now,
): Follows {
  let state = initial;
  let chain: Promise<unknown> = Promise.resolve();

  /** Runs `fn` after every earlier mutation; `fn` returns the next state to persist and its result. */
  function mutate<R>(fn: (current: FollowsState) => { next?: FollowsState; result: R }): Promise<R> {
    const run = async (): Promise<R> => {
      const { next, result } = fn(state);
      if (next !== undefined) {
        await store.write(next);
        state = next;
      }
      return result;
    };
    const result = chain.then(run, run);
    chain = result.catch(() => undefined);
    return result;
  }

  return {
    onDelivered(meta) {
      return mutate((current): { next?: FollowsState; result: DeliveryOutcome } => {
        if (meta === undefined) return { result: { kind: "none" } };
        const existing = current.followed.find((f) => f.workId === meta.workId);
        if (existing !== undefined) {
          if (meta.status === "completed") {
            const followed = current.followed.filter((f) => f.workId !== meta.workId);
            return { next: { ...current, followed }, result: { kind: "completed" } };
          }
          const updated: FollowedFic = {
            ...existing,
            chapters: meta.chapters,
            status: meta.status,
            title: meta.title,
            updatedAt: now(),
          };
          const followed = current.followed.map((f) => (f.workId === meta.workId ? updated : f));
          return { next: { ...current, followed }, result: { kind: "updated", chapters: meta.chapters } };
        }
        if (meta.status !== "in-progress") return { result: { kind: "none" } };
        const recent = [meta, ...current.recent.filter((m) => m.workId !== meta.workId)].slice(0, RECENT_LIMIT);
        return { next: { ...current, recent }, result: { kind: "offer" } };
      });
    },

    follow(workId) {
      return mutate((current): { next?: FollowsState; result: FollowResult } => {
        const existing = current.followed.find((f) => f.workId === workId);
        if (existing !== undefined) return { result: { kind: "already", fic: existing } };
        const meta = current.recent.find((m) => m.workId === workId);
        if (meta === undefined) return { result: { kind: "unknown" } };
        const at = now();
        const fic: FollowedFic = { ...meta, followedAt: at, updatedAt: at };
        const next: FollowsState = {
          ...current,
          followed: [...current.followed, fic],
          recent: current.recent.filter((m) => m.workId !== workId),
        };
        return { next, result: { kind: "followed", fic } };
      });
    },

    unfollow(workId) {
      return mutate((current): { next?: FollowsState; result: UnfollowResult } => {
        const existing = current.followed.find((f) => f.workId === workId);
        if (existing === undefined) return { result: { kind: "not-followed" } };
        const followed = current.followed.filter((f) => f.workId !== workId);
        return { next: { ...current, followed }, result: { kind: "unfollowed", title: existing.title } };
      });
    },
  };
}
