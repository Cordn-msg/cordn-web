import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchEmojiImage } from './chatEmojiImage';

function responseWithReader(reader: {
	read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
	cancel: () => Promise<void>;
}): Response {
	return {
		ok: true,
		headers: new Headers(),
		body: { getReader: () => reader }
	} as unknown as Response;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('custom emoji image fetch', () => {
	it('times out a response whose body never finishes', async () => {
		vi.useFakeTimers();
		const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}));
		const cancel = vi.fn(async () => {});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => responseWithReader({ read, cancel }))
		);

		const pending = fetchEmojiImage('https://stall.example/cat.png');
		const rejected = expect(pending).rejects.toThrow('timed out');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(8000);

		await rejected;
	});

	it('stops a body that crosses the byte cap mid-stream', async () => {
		const chunk = new Uint8Array(300 * 1024);
		let reads = 0;
		const read = vi.fn(async () => {
			reads += 1;
			return reads <= 2
				? { done: false as const, value: chunk }
				: { done: true as const, value: undefined };
		});
		const cancel = vi.fn(async () => {});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => responseWithReader({ read, cancel }))
		);

		await expect(fetchEmojiImage('https://large.example/cat.png')).rejects.toThrow('too large');
		expect(cancel).toHaveBeenCalled();
	});
});
