import { mount, unmount, flushSync } from 'svelte';
import { beforeEach, expect, test } from 'vitest';
import PetnameEditor from './PetnameEditor.svelte';
import {
	getChatPetname,
	loadChatPetnamesForOwner,
	setChatPetname
} from '$lib/services/chatPetnames.svelte';

const OWNER = 'dd'.repeat(32);
const ALICE = 'aa'.repeat(32);

beforeEach(() => {
	localStorage.clear();
	loadChatPetnamesForOwner(OWNER);
});

function mountEditor() {
	const target = document.createElement('div');
	document.body.append(target);
	let closed = 0;
	const instance = mount(PetnameEditor, {
		target,
		props: { pubkey: ALICE, onClose: () => (closed += 1) }
	});
	flushSync();
	return { target, instance, closedCount: () => closed };
}

async function typeInto(target: HTMLElement, value: string) {
	const input = target.querySelector('input')!;
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

test('saves a normalized petname and closes the form', async () => {
	const { target, instance, closedCount } = mountEditor();
	await typeInto(target, '  Mom   ');
	target.querySelector('form')!.requestSubmit();
	flushSync();
	expect(getChatPetname(ALICE)).toBe('Mom');
	expect(closedCount()).toBe(1);
	await unmount(instance);
	target.remove();
});

test('prefills the saved petname and removes it', async () => {
	setChatPetname(ALICE, 'Mom');
	const { target, instance, closedCount } = mountEditor();
	expect(target.querySelector('input')!.value).toBe('Mom');

	const remove = [...target.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Remove'
	);
	remove!.click();
	flushSync();
	expect(getChatPetname(ALICE)).toBeUndefined();
	expect(closedCount()).toBe(1);
	await unmount(instance);
	target.remove();
});
