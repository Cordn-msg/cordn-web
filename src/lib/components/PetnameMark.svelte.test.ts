import { mount, unmount, flushSync } from 'svelte';
import { beforeEach, expect, test } from 'vitest';
import PetnameMark from './PetnameMark.svelte';
import { loadChatPetnamesForOwner, setChatPetname } from '$lib/services/chatPetnames.svelte';

const OWNER = 'dd'.repeat(32);
const ALICE = 'aa'.repeat(32);

beforeEach(() => {
	localStorage.clear();
	loadChatPetnamesForOwner(OWNER);
});

test('marks a name only while it is a local petname', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const instance = mount(PetnameMark, { target, props: { pubkey: ALICE } });
	flushSync();
	expect(target.querySelector('svg')).toBeNull();

	// Setting the petname must repaint an already-mounted name cell.
	setChatPetname(ALICE, 'Mom');
	flushSync();
	const mark = target.querySelector('svg');
	expect(mark?.getAttribute('aria-label')).toBe('Your petname for this person');

	await unmount(instance);
	target.remove();
});
