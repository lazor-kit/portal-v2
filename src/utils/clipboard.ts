/**
 * Copies `text`. The Clipboard API is often unavailable to a page inside
 * another site's frame, so a selected, off-screen text area is copied
 * instead. Resolves to whether the copy went through.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Not allowed here (a frame without clipboard-write): fall back.
  }
  const focused = document.activeElement as HTMLElement | null;
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const done = document.execCommand('copy');
    area.remove();
    return done;
  } catch {
    return false;
  } finally {
    focused?.focus?.();
  }
}
