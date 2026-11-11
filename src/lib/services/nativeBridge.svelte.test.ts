import { afterEach, expect, test } from 'vitest';
import { hasOpenEscapeOverlay } from './nativeBridge';

// Back first tries to dismiss an open overlay by dispatching Escape. An expanded
// Collapsible exposes the same `data-state="open"` but ignores Escape, so matching
// it made Back a no-op on pages with an opened advanced panel.
afterEach(() => {
	document.body.innerHTML = '';
});

test('an expanded collapsible is not treated as an escape-closable overlay', () => {
	document.body.innerHTML = '<div data-state="open" data-slot="collapsible-content"></div>';
	expect(hasOpenEscapeOverlay()).toBe(false);
});

test('dialogs and open menus are', () => {
	document.body.innerHTML = '<div role="dialog"></div>';
	expect(hasOpenEscapeOverlay()).toBe(true);

	document.body.innerHTML = '<div data-slot="dropdown-menu-content" data-state="closed"></div>';
	expect(hasOpenEscapeOverlay()).toBe(false);

	document.body.innerHTML = '<div data-slot="dropdown-menu-content" data-state="open"></div>';
	expect(hasOpenEscapeOverlay()).toBe(true);
});
