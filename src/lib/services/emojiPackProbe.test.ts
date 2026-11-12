import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchEmojiImage = vi.hoisted(() =>
	vi.fn(async () => ({ mime: 'image/png', bytes: new Uint8Array([1]) }))
);

vi.mock('$lib/services/chatEmojiImage', () => ({ fetchEmojiImage }));

import { emojiProbeState, probeEmojiUrl } from './emojiPackProbe.svelte';

const HOST = 'https://cdn.example';
const FAILING_HOST = 'https://blocked.example';

describe('emoji pack probe', () => {
	beforeEach(() => {
		fetchEmojiImage.mockClear();
		fetchEmojiImage.mockImplementation(async () => ({
			mime: 'image/png',
			bytes: new Uint8Array([1])
		}));
	});

	it('asks a host once, however many of its emoji are looked at', async () => {
		// One origin shared by 30 emoji is the case that must not become 30 requests.
		for (let i = 0; i < 30; i++) probeEmojiUrl(`${HOST}/a/cat_${i}.png`);
		await Promise.resolve();

		expect(fetchEmojiImage).toHaveBeenCalledTimes(1);
		expect(emojiProbeState(`${HOST}/a/cat_29.png`)).toBe('ok');
	});

	it('keeps a failure for a while, and a forced recheck asks again', async () => {
		fetchEmojiImage.mockRejectedValueOnce(new Error('blocked'));
		probeEmojiUrl(`${FAILING_HOST}/a/cat.png`);
		await Promise.resolve();
		await Promise.resolve();
		expect(emojiProbeState(`${FAILING_HOST}/a/cat.png`)).toBe('failed');

		probeEmojiUrl(`${FAILING_HOST}/a/cat.png`);
		expect(fetchEmojiImage).toHaveBeenCalledTimes(1);

		probeEmojiUrl(`${FAILING_HOST}/a/cat.png`, { force: true });
		await Promise.resolve();
		expect(fetchEmojiImage).toHaveBeenCalledTimes(2);
		expect(emojiProbeState(`${FAILING_HOST}/a/cat.png`)).toBe('ok');
	});
});
