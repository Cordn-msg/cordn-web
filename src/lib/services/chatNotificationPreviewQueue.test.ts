import { describe, expect, test } from 'vitest';
import type { CordnBackgroundDrainResult } from 'cordn-background';
import { createWarmPreviewQueue } from './chatNotificationPreviewQueue';

function event(cursor: number): CordnBackgroundDrainResult {
	return {
		accountPubkey: 'aa'.repeat(32),
		messages: [{ gid: 'g1', cursor, msg64: 'x', at: 0 }]
	};
}

describe('warm notification-preview queue', () => {
	test('runs one pass at a time and keeps only the newest queued request', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const seen: number[] = [];
		let active = 0;
		let maxActive = 0;
		const queue = createWarmPreviewQueue(async (next) => {
			active++;
			maxActive = Math.max(maxActive, active);
			seen.push(next.messages[0]!.cursor);
			if (seen.length === 1) await gate;
			active--;
		});

		const first = queue(event(1));
		void queue(event(2));
		void queue(event(3));

		expect(seen).toEqual([1]);
		release();
		await first;

		expect(seen).toEqual([1, 3]);
		expect(maxActive).toBe(1);
	});

	test('a later request starts a fresh pass after the queue settles', async () => {
		const seen: number[] = [];
		const queue = createWarmPreviewQueue(async (next) => {
			seen.push(next.messages[0]!.cursor);
		});

		await queue(event(1));
		await queue(event(2));

		expect(seen).toEqual([1, 2]);
	});
});
