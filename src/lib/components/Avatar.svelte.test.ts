import { mount, unmount, flushSync } from 'svelte';
import { expect, test, vi } from 'vitest';
import Avatar from './Avatar.svelte';

// 1×1 transparent GIF as a data URL — decodes without any network round trip.
const PICTURE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

test('a known picture paints at full opacity on remount instead of replaying the fade', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const props = { pubkey: 'ee'.repeat(32), picture: PICTURE };

	const first = mount(Avatar, { target, props });
	flushSync();
	const firstImg = target.querySelector('img')!;
	// First-ever sight of a picture fades it in after the load.
	expect(firstImg.className).toContain('opacity-0');
	await vi.waitFor(() => expect(firstImg.className).toContain('opacity-100'));
	await unmount(first);

	// Remount (group open, scrolling back in, the run avatar hopping to a newer
	// message): the fade must not replay — full opacity from the very first
	// render, with no wait for onload.
	const second = mount(Avatar, { target, props });
	flushSync();
	expect(target.querySelector('img')!.className).toContain('opacity-100');
	await unmount(second);
	target.remove();
});
