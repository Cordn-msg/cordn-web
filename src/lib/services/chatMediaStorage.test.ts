import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64 } from 'ts-mls';

const mediaState = vi.hoisted(() => ({ epoch: 1, uploads: 0 }));

vi.mock('$lib/services/chatGroups.svelte', () => ({
	getChatGroup: () => ({ epoch: mediaState.epoch }),
	decodeStoredGroupState: (group: { epoch: number }) => ({
		groupContext: { epoch: group.epoch }
	}),
	sendChatGroupMessage: async () => {}
}));

vi.mock('$lib/services/chatRuntime', () => ({
	requireActiveAccount: () => ({ pubkey: 'aa'.repeat(32) })
}));

vi.mock('$lib/services/chatMediaCrypto', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/services/chatMediaCrypto')>()),
	deriveMediaKey: async () => new Uint8Array(32).fill(mediaState.epoch)
}));

const uploadBlob = vi.hoisted(() =>
	vi.fn(async () => {
		mediaState.uploads += 1;
		// Simulate a commit landing between the seal and the post.
		mediaState.epoch = 2;
		return {
			url: `https://blossom.example/${mediaState.uploads}.bin`,
			sha256: 'a'.repeat(64)
		};
	})
);

vi.mock('$lib/services/chatBlossomClient', () => ({
	BlossomUploadError: class extends Error {},
	ephemeralBlossomSigner: () => ({}),
	fetchBlob: async () => new Uint8Array(),
	uploadBlob,
	verifyBlobRoundtrip: async () => {}
}));

vi.mock('$lib/services/chatEmojiImage', () => ({
	fetchEmojiImage: vi.fn(async () => ({
		mime: 'image/png',
		bytes: new Uint8Array([1, 2, 3])
	}))
}));

import { prepareEmojiMediaTags } from './chatMediaStorage.svelte';
import { fetchEmojiImage } from './chatEmojiImage';

describe('prepareEmojiMediaTags', () => {
	beforeEach(() => {
		mediaState.epoch = 1;
		mediaState.uploads = 0;
		vi.clearAllMocks();
	});

	it('re-seals the tag when the epoch moves before the send', async () => {
		const result = await prepareEmojiMediaTags('group-epoch-test', [
			{ name: 'cat', url: 'https://cdn.example/cat-epoch.png' }
		]);

		expect(fetchEmojiImage).toHaveBeenCalledTimes(1);
		expect(uploadBlob).toHaveBeenCalledTimes(2);
		expect(result.tags).toHaveLength(1);
		expect(result.tags[0]).toContain('name cat');
		expect(result.tags[0]).toContain('url https://blossom.example/2.bin');
		expect(result.mediaKeyBase64).toBe(bytesToBase64(new Uint8Array(32).fill(2)));

		const again = await prepareEmojiMediaTags('group-epoch-test', [
			{ name: 'cat', url: 'https://cdn.example/cat-epoch.png' }
		]);
		expect(uploadBlob).toHaveBeenCalledTimes(2);
		expect(again.tags).toEqual(result.tags);
	});
});
