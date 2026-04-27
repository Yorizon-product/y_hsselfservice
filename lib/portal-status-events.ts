// Tiny pub-sub for portal_status_update events. The webhook route emits
// once per persisted event; the worker waiter (Phase 2) subscribes and
// resolves on match. Module-scoped so the in-process worker and the
// webhook handler share the same emitter without going through the DB
// for the wake-up signal (the DB already has the data).

type Listener = (companyId: string, propertyValue: string, occurredAt: string) => void;

const listeners = new Set<Listener>();

export function onPortalStatusEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitPortalStatusEvent(
  companyId: string,
  propertyValue: string,
  occurredAt: string
): void {
  for (const l of listeners) {
    try {
      l(companyId, propertyValue, occurredAt);
    } catch (e) {
      console.error("[events] listener threw:", (e as Error).message);
    }
  }
}
