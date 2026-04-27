// Tiny pub-sub for portal_status_update events. The webhook route emits
// once per persisted event; the worker waiter subscribes and resolves
// on match.
//
// IMPORTANT: pinned to globalThis. Next.js with `output: "standalone"`
// can bundle the same module into multiple chunks (one for the
// instrumentation hook that boots the worker, one for the route
// handler) and end up with TWO module instances at runtime — each with
// its own private `listeners` Set. The webhook would emit on one Set
// while the worker subscribed to the other, and the live-event path
// would silently miss every event. The DB-sweep fallback would catch
// it 30s later, but that defeats the point of the webhook signal.
//
// Pinning the Set to globalThis ensures both module instances see the
// same registry.

type Listener = (companyId: string, propertyValue: string, occurredAt: string) => void;

const GLOBAL_KEY = "__hsSelfServicePortalStatusListeners";

function getListeners(): Set<Listener> {
  const g = globalThis as unknown as Record<string, Set<Listener> | undefined>;
  let set = g[GLOBAL_KEY];
  if (!set) {
    set = new Set<Listener>();
    g[GLOBAL_KEY] = set;
  }
  return set;
}

export function onPortalStatusEvent(listener: Listener): () => void {
  const listeners = getListeners();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitPortalStatusEvent(
  companyId: string,
  propertyValue: string,
  occurredAt: string
): void {
  for (const l of getListeners()) {
    try {
      l(companyId, propertyValue, occurredAt);
    } catch (e) {
      console.error("[events] listener threw:", (e as Error).message);
    }
  }
}
