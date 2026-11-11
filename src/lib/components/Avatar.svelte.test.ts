import { mount, unmount, flushSync } from 'svelte';
import { expect, test, vi } from 'vitest';
import Avatar from './Avatar.svelte';
import AvatarImage from './ui/avatar/avatar-image.svelte';
import { AVATAR_STATUS_KEY, loadedAvatarPictures } from './ui/avatar/avatar-context';

// 1×1 transparent GIF as a data URL — decodes without any network round trip.
const PICTURE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const LATE_PICTURE =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
// A second, distinct 1×1 GIF: sharing PICTURE would let an earlier test warm it.
const GROUP_PICTURE =
	'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

test('a late load after unmount does not read the destroyed picture prop', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	let reads = 0;
	const props = {
		pubkey: 'ee'.repeat(32),
		get picture() {
			reads += 1;
			return LATE_PICTURE;
		}
	};

	const instance = mount(Avatar, { target, props });
	flushSync();
	const img = target.querySelector('img')!;
	await unmount(instance);
	const readsAfterUnmount = reads;

	// A detached image may still finish loading after its row is gone.
	img.dispatchEvent(new Event('load'));
	expect(reads).toBe(readsAfterUnmount);
	target.remove();
});

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

test('a picture another avatar component warmed does not fade in again', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	let status: 'loading' | 'loaded' | 'error' = 'loading';
	const context = new Map([
		[
			AVATAR_STATUS_KEY,
			{
				get status() {
					return status;
				},
				set: (next: 'loading' | 'loaded' | 'error') => {
					status = next;
				}
			}
		]
	]);

	// A group/list avatar loads it first (AvatarImage's own preload)…
	const groupAvatar = mount(AvatarImage, { target, props: { src: GROUP_PICTURE }, context });
	flushSync();
	await vi.waitFor(() => expect(status).toBe('loaded'));
	await unmount(groupAvatar);

	// …so the profile bubble must paint it at full opacity on its first render.
	const bubble = mount(Avatar, {
		target,
		props: { pubkey: 'ee'.repeat(32), picture: GROUP_PICTURE }
	});
	flushSync();
	expect(target.querySelector('img')!.className).toContain('opacity-100');
	await unmount(bubble);
	target.remove();
});

test('a picture failing elsewhere must not hide it where it already painted', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const bubble = mount(Avatar, {
		target,
		props: { pubkey: 'ee'.repeat(32), picture: GROUP_PICTURE }
	});
	flushSync();
	const bubbleImg = target.querySelector('img')!;
	// The bitmap painted here (not merely warm in the shared cache), which latches it.
	bubbleImg.dispatchEvent(new Event('load'));
	flushSync();
	expect(bubbleImg.className).toContain('opacity-100');

	// Another avatar of the same person (sidebar, direct chat) errors and drops the
	// src from the shared cache: the painted bubble must stay visible.
	loadedAvatarPictures.delete(GROUP_PICTURE);
	flushSync();
	expect(bubbleImg.className).toContain('opacity-100');

	await unmount(bubble);
	target.remove();
});
