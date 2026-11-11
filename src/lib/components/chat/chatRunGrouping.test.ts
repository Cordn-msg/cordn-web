import { describe, expect, test } from 'vitest';
import { isRunContinuation, isRunTail } from './chatRunGrouping';
import type { ChatMessage } from './chat.types';

function row(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'author'>): ChatMessage {
	return {
		eventId: overrides.id,
		text: '',
		kind: 9,
		createdAt: 0,
		timeLabel: '',
		...overrides
	};
}

describe('isRunContinuation', () => {
	test('a same-author message continues the run', () => {
		expect(isRunContinuation(row({ id: 'a1', author: 'A' }), row({ id: 'a2', author: 'A' }))).toBe(
			true
		);
	});

	test('an author change does not continue the run', () => {
		expect(isRunContinuation(row({ id: 'a1', author: 'A' }), row({ id: 'b1', author: 'B' }))).toBe(
			false
		);
	});

	test('the last row does not continue a run', () => {
		expect(isRunContinuation(row({ id: 'a1', author: 'A' }), undefined)).toBe(false);
	});

	test('system rows never continue a run, even for the same author', () => {
		expect(
			isRunContinuation(
				row({ id: 'r1', author: 'A', systemKind: 'reaction' }),
				row({ id: 'r2', author: 'A', systemKind: 'reaction' })
			)
		).toBe(false);
	});

	test('a following system row ends the run', () => {
		expect(
			isRunContinuation(
				row({ id: 'a2', author: 'A' }),
				row({ id: 'r1', author: 'A', systemKind: 'reaction' })
			)
		).toBe(false);
	});
});

describe('isRunTail', () => {
	test('the last row is always a run tail (avatar anchors there)', () => {
		expect(isRunTail(row({ id: 'a2', author: 'A' }), undefined)).toBe(true);
	});

	test('a same-author message row does not end the run', () => {
		expect(isRunTail(row({ id: 'a1', author: 'A' }), row({ id: 'a2', author: 'A' }))).toBe(false);
	});

	test('another author ends the run', () => {
		expect(isRunTail(row({ id: 'a1', author: 'A' }), row({ id: 'b1', author: 'B' }))).toBe(true);
	});

	test('a same-author system row (own closing reaction marker) ends the run', () => {
		// The regression: the marker row carries the reactor's pubkey, so the
		// run's last real message lost its avatar to a row that shows none.
		expect(
			isRunTail(
				row({ id: 'a2', author: 'A' }),
				row({ id: 'r1', author: 'A', systemKind: 'reaction' })
			)
		).toBe(true);
	});

	test('any other system row (MLS commit note) ends the run regardless of author', () => {
		expect(
			isRunTail(
				row({ id: 'a2', author: 'A' }),
				row({ id: 's1', author: 'B', systemKind: 'member-added' })
			)
		).toBe(true);
		expect(
			isRunTail(
				row({ id: 'a2', author: 'A' }),
				row({ id: 's2', author: 'A', systemKind: 'metadata-changed' })
			)
		).toBe(true);
	});

	test('system rows themselves never anchor an avatar', () => {
		expect(isRunTail(row({ id: 'r1', author: 'A', systemKind: 'reaction' }), undefined)).toBe(
			false
		);
	});
});
