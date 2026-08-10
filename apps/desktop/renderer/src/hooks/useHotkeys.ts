import { useEffect, useRef } from 'react';

/**
 * Window-level keyboard shortcuts.
 *
 * Bindings are written platform-neutrally as `mod+k`, where `mod` is ⌘ on
 * macOS and Ctrl elsewhere. Handlers run unless the event came from a text
 * field, except for bindings that opt in with a leading `!` — the composer's
 * own submit key has to fire while the user is typing in it.
 */

export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function describe(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase());
  return parts.join('+');
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function useHotkeys(map: HotkeyMap): void {
  const ref = useRef(map);
  ref.current = map;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const combo = describe(event);
      const always = ref.current[`!${combo}`];
      if (always) {
        event.preventDefault();
        always(event);
        return;
      }
      if (isTextEntry(event.target)) return;
      const handler = ref.current[combo];
      if (!handler) return;
      event.preventDefault();
      handler(event);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Render a shortcut for display: `mod+k` → `⌘K` / `Ctrl K`. */
export function keyLabel(combo: string): string {
  return combo
    .replace(/^!/, '')
    .split('+')
    .map((part) => {
      if (part === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (part === 'shift') return isMac ? '⇧' : 'Shift';
      if (part === 'alt') return isMac ? '⌥' : 'Alt';
      if (part === 'enter') return '↵';
      if (part === 'escape') return 'Esc';
      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(isMac ? '' : ' ');
}
