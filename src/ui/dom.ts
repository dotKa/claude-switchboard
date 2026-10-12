// Minimal typed DOM helpers. Every user-data string goes through textContent (never innerHTML).

type Attrs = {
  [key: string]: string | boolean | (() => void) | undefined;
};
type Child = Node | string | null | undefined;

/**
 * Create an element. `attrs.on*` become event listeners, `attrs.class` the className.
 * Numbers are coerced where the property expects a value (`value`, `valueAsNumber`, `checked`).
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val === undefined) continue;
    if (key.startsWith('on') && typeof val === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), val as EventListener);
    } else if (key === 'class') {
      el.className = String(val);
    } else if (key === 'style') {
      // CSSOM write: allowed under the pages' CSP (style-src 'self'), unlike a style="" attribute.
      el.style.cssText = String(val);
    } else if (typeof val === 'boolean') {
      if (val) {
        el.setAttribute(key, '');
        if (key in el) {
          try {
            (el as unknown as Record<string, unknown>)[key] = true;
          } catch {
            /* read-only property; attribute is enough */
          }
        }
      }
    } else {
      el.setAttribute(key, String(val));
      if ((key === 'value' || key === 'valueAsNumber') && key in el) {
        (el as unknown as Record<string, unknown>)[key] = val;
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.append(child);
  }
  return el;
}

/** Set value + checked on form controls without tripping TS. */
export function setControlValue(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
  checked = false,
): void {
  el.value = value;
  if (el instanceof HTMLInputElement) el.checked = checked;
}

/** Remove all children. */
export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Wrap a trusted, STATIC inline SVG string (never pass user input) in a span. */
export function icon(svg: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = svg; // trusted, static markup only
  return span;
}
