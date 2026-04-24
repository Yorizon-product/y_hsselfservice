// Thin wrapper around the Web Notifications API. Everything no-ops safely
// when the API is missing, permission isn't granted, or the tab is visible
// — the inline UI in app/page.tsx is always authoritative.

const DEFAULT_TAG = "hsselfservice-create";

export function isSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getPermission(): NotificationPermission | null {
  if (!isSupported()) return null;
  return window.Notification.permission;
}

// Prompts only when state is "default". Returns the resulting permission
// without throwing — callers should fire-and-forget this at submit time.
export async function ensurePermission(): Promise<NotificationPermission | null> {
  if (!isSupported()) return null;
  const current = window.Notification.permission;
  if (current !== "default") return current;
  try {
    return await window.Notification.requestPermission();
  } catch {
    return current;
  }
}

export type NotifyOptions = {
  title: string;
  body?: string;
  tag?: string;
  onClick?: () => void;
};

// Returns true if a notification was dispatched, false otherwise.
// Gates: API support, permission === "granted", tab hidden.
export function notify({ title, body, tag = DEFAULT_TAG, onClick }: NotifyOptions): boolean {
  if (!isSupported()) return false;
  if (window.Notification.permission !== "granted") return false;
  if (typeof document !== "undefined" && document.visibilityState !== "hidden") return false;
  try {
    const n = new window.Notification(title, { body, tag });
    n.onclick = () => {
      try { window.focus(); } catch {}
      if (onClick) {
        try { onClick(); } catch {}
      }
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
