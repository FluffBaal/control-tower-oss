// OS notifications + app-icon badge so the "summon me" loop works when the window
// is backgrounded (SPEC P6). Best-effort: everything degrades silently if the
// browser/PWA doesn't support it.

export async function requestNotifyPermission(): Promise<void> {
  if ('Notification' in window && Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      /* ignore */
    }
  }
}

export function notify(title: string, body: string): void {
  // Only surface a toast when the user isn't already looking at the tab.
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  try {
    new Notification(title, { body, icon: '/icon.svg', tag: 'control-tower-attention' });
  } catch {
    /* ignore */
  }
}

export function setBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) nav.setAppBadge?.(count);
    else nav.clearAppBadge?.();
  } catch {
    /* ignore */
  }
}
