import { describe, expect, test } from 'vitest';

import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';
import {
	capWindowRows,
	MAX_WINDOW_ROWS,
	TAIL_WINDOW_ROWS,
	windowHasNewRows
} from '$lib/services/chatGroupWindows';

function makeMessage(cursor: number): StoredChatMessage {
	return {
		cursor,
		createdAt: cursor,
		direction: 'inbound',
		sender: 'cc'.repeat(32),
		id: `ev-${cursor}`,
		kind: 9,
		tags: [],
		content: `message ${cursor}`
	};
}

const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, index) => makeMessage(from + index));

describe('capWindowRows', () => {
	test('leaves windows under the cap untouched', () => {
		const rows = range(1, 100);
		expect(capWindowRows(rows, 'low')).toBe(rows);
		expect(capWindowRows(rows, 'high')).toBe(rows);
	});

	test("'low' (ingest growth) trims the oldest rows", () => {
		const rows = range(1, MAX_WINDOW_ROWS + 10);
		const capped = capWindowRows(rows, 'low');
		expect(capped).toHaveLength(MAX_WINDOW_ROWS);
		expect(capped[0].cursor).toBe(11);
		expect(capped.at(-1)?.cursor).toBe(MAX_WINDOW_ROWS + 10);
	});

	test("'high' (history growth) trims just below the protected tail", () => {
		const rows = range(1, MAX_WINDOW_ROWS + 10);
		const capped = capWindowRows(rows, 'high');
		expect(capped).toHaveLength(MAX_WINDOW_ROWS);
		// The newest TAIL_WINDOW_ROWS stay contiguous; the 10 rows go from the
		// cold side next to the tail window (a hole, not the reading edge).
		expect(capped.slice(-TAIL_WINDOW_ROWS)[0].cursor).toBe(rows.at(-TAIL_WINDOW_ROWS)!.cursor);
		expect(capped).not.toContainEqual(makeMessage(MAX_WINDOW_ROWS + 10 - TAIL_WINDOW_ROWS));
		expect(capped.at(-1)?.cursor).toBe(MAX_WINDOW_ROWS + 10);
		expect(capped[0].cursor).toBe(1);
	});

	test("'high' never touches the protected tail even for huge overshoot", () => {
		const rows = range(1, MAX_WINDOW_ROWS + TAIL_WINDOW_ROWS + 5);
		const capped = capWindowRows(rows, 'high');
		expect(capped).toHaveLength(MAX_WINDOW_ROWS);
		expect(capped.slice(-TAIL_WINDOW_ROWS)[0].cursor).toBe(rows.at(-TAIL_WINDOW_ROWS)!.cursor);
	});
});

describe('windowHasNewRows', () => {
	test('a page the window already holds adds nothing', () => {
		// The regression this guards: an idempotent re-read used to rewrite the
		// group object, re-triggering the ensure effect in an unbounded loop.
		expect(windowHasNewRows(range(1, 50), range(1, 50))).toBe(false);
		expect(windowHasNewRows(range(1, 50), range(20, 30))).toBe(false);
		expect(windowHasNewRows(range(1, 50), [])).toBe(false);
	});

	test('a cursor outside the window is new', () => {
		expect(windowHasNewRows(range(1, 50), range(45, 60))).toBe(true);
		expect(windowHasNewRows([], range(1, 5))).toBe(true);
	});
});
