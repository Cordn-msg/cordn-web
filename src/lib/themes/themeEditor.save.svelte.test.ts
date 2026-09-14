import { describe, it, expect } from 'vitest';
import { mount, unmount } from 'svelte';
import EditorHost from './editorHost.svelte';
import { initAppearance, appearance, getThemeById } from './appearance.svelte';

/**
 * The editor save/cancel flow through a page-faithful host (same conditional
 * render + onsaved/oncancel clears as the appearance page). Regression test
 * for the bug where the teardown restore clobbered freshly-saved themes.
 */
describe('ThemeEditor save flow', () => {
	it('saving applies and persists the fork; cancel restores the active theme', async () => {
		localStorage.clear();
		document.getElementById('cordn-theme')?.remove();
		await initAppearance();
		expect(appearance.activeThemeId).toBe('soft');

		const target = document.createElement('div');
		document.body.appendChild(target);
		const host = mount(EditorHost, { target });
		const api = host as unknown as { openEditor: () => void };
		api.openEditor();
		await new Promise((r) => setTimeout(r, 20));

		const saveBtn = [...target.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Save theme')
		);
		const cancelBtn = [...target.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Cancel')
		);
		expect(saveBtn).toBeTruthy();
		expect(cancelBtn).toBeTruthy();

		// Change the background color like a real session.
		const bgPicker = target.querySelector<HTMLInputElement>(
			'input[type="color"][aria-label="Pick Background color"]'
		);
		expect(bgPicker).toBeTruthy();
		bgPicker!.value = '#123456';
		bgPicker!.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 20));
		expect(cssVar('--background')).toBe('#123456'); // live preview

		// Cancel first: the app must fall back to the still-active theme.
		cancelBtn!.click();
		await new Promise((r) => setTimeout(r, 20));
		expect(cssVar('--background')).toBe('#f5f5f2');
		expect(appearance.activeThemeId).toBe('soft');

		// Now save: the fork becomes active, applied, and persisted.
		api.openEditor();
		await new Promise((r) => setTimeout(r, 20));
		const picker2 = target.querySelector<HTMLInputElement>(
			'input[type="color"][aria-label="Pick Background color"]'
		);
		picker2!.value = '#123456';
		picker2!.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 20));
		const saveBtn2 = [...target.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Save theme')
		)!;
		saveBtn2.click();
		await new Promise((r) => setTimeout(r, 50));

		expect(appearance.activeThemeId).not.toBe('soft');
		const saved = getThemeById(appearance.activeThemeId)!;
		expect(saved.name).toBe('Soft (custom)');
		expect(saved.light.background).toBe('#123456');
		expect(cssVar('--background')).toBe('#123456');
		expect(localStorage.getItem('cordn.theme')).toBe(appearance.activeThemeId);
		expect(localStorage.getItem('cordn.themeCss')).toContain('#123456');

		unmount(host);
		target.remove();
	});

	it('pasting edited JSON applies it to the draft preview', async () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		const host = mount(EditorHost, { target });
		const api = host as unknown as { openEditor: () => void };
		api.openEditor();
		await new Promise((r) => setTimeout(r, 20));

		// Open the Advanced section and paste an edited JSON object.
		const advTrigger = [...target.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Advanced')
		);
		advTrigger!.click();
		await new Promise((r) => setTimeout(r, 20));
		const area = target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Theme JSON"]')!;
		expect(area).toBeTruthy();
		const parsedBefore = JSON.parse(area.value);
		parsedBefore.light.background = '#654321';
		parsedBefore.dark.background = '#0f1a2b';
		area.value = JSON.stringify(parsedBefore);
		area.dispatchEvent(new Event('input', { bubbles: true }));

		const applyBtn = [...target.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Apply JSON')
		)!;
		applyBtn.click();
		await new Promise((r) => setTimeout(r, 20));

		// Live preview updated; the dark half applies with .dark.
		expect(cssVar('--background')).toBe('#654321');
		document.documentElement.classList.add('dark');
		expect(cssVar('--background')).toBe('#0f1a2b');
		document.documentElement.classList.remove('dark');

		// The textarea normalizes to the merged draft.
		expect(JSON.parse(area.value).light.background).toBe('#654321');

		// Garbage shows an inline error and changes nothing.
		area.value = '{not json';
		area.dispatchEvent(new Event('input', { bubbles: true }));
		applyBtn.click();
		await new Promise((r) => setTimeout(r, 20));
		expect(target.textContent).toContain('Not a valid theme JSON object');
		expect(cssVar('--background')).toBe('#654321');

		unmount(host);
		target.remove();
	});
});

function cssVar(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
