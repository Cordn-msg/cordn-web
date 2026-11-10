import { describe, expect, it } from 'vitest';
import {
	foldReactionMarkers,
	mergeAdjacentReactionMarkers,
	pruneAdjacentReactionTargets
} from './reactionMarkers';
import type { ChatMessage } from './chat.types';

function row(partial: Partial<ChatMessage>): ChatMessage {
	return {
		id: 'r',
		eventId: 'r',
		author: 'a',
		text: '',
		kind: -1,
		createdAt: 0,
		timeLabel: '',
		...partial
	};
}

const marker = (id: string, target: string | undefined, at: number, emoji = '👍') =>
	row({
		id,
		systemKind: 'reaction',
		reactionTarget: target,
		reactionEmojis: [emoji],
		reactionSenders: ['pk-' + id],
		createdAt: at,
		timeLabel: String(at)
	});

const message = (id: string) => row({ id, kind: 9, text: 'hello' });

describe('mergeAdjacentReactionMarkers', () => {
	it('merges adjacent markers with the same target', () => {
		const result = mergeAdjacentReactionMarkers([
			message('m1'),
			marker('r1', 't', 10),
			marker('r2', 't', 11),
			marker('r3', 't', 12)
		]);
		expect(result).toHaveLength(2);
		expect(result[1].id).toBe('r1'); // stable key from the first member
		expect(result[1].createdAt).toBe(12); // recency from the last member
		expect(result[1].reactionSenders).toEqual(['pk-r1', 'pk-r2', 'pk-r3']);
		expect(result[1].reactionItems?.map((entry) => entry.id)).toEqual(['r1', 'r2', 'r3']);
	});

	it('does not merge across a message or across targets', () => {
		const result = mergeAdjacentReactionMarkers([
			marker('r1', 't1', 10),
			message('m1'),
			marker('r2', 't1', 11),
			marker('r3', 't2', 12)
		]);
		expect(result.map((entry) => entry.id)).toEqual(['r1', 'm1', 'r2', 'r3']);
	});

	it('never merges targetless markers', () => {
		const result = mergeAdjacentReactionMarkers([
			marker('r1', undefined, 10),
			marker('r2', undefined, 11)
		]);
		expect(result).toHaveLength(2);
	});

	it('dedupes repeated emoji and sender within a run', () => {
		const same = marker('r2', 't', 11);
		const result = mergeAdjacentReactionMarkers([
			marker('r1', 't', 10),
			{ ...same, reactionSenders: ['pk-r1'], reactionEmojis: ['👍'] }
		]);
		expect(result).toHaveLength(1);
		expect(result[0].reactionEmojis).toEqual(['👍']);
		expect(result[0].reactionSenders).toEqual(['pk-r1']);
	});

	it('collapses a same-sender burst across different targets', () => {
		const result = mergeAdjacentReactionMarkers([
			message('m1'),
			{ ...marker('r1', 't1', 10), reactionSenders: ['pk-bob'] },
			{ ...marker('r2', 't2', 11), reactionSenders: ['pk-bob'] },
			{ ...marker('r3', 't3', 12, '❤️'), reactionSenders: ['pk-bob'] }
		]);
		expect(result).toHaveLength(2);
		expect(result[1].id).toBe('r1'); // stable key from the first member
		expect(result[1].reactionTarget).toBe('t1'); // See keeps the first member's target
		expect(result[1].createdAt).toBe(12); // recency from the last member
		expect(result[1].reactionSenders).toEqual(['pk-bob']);
		expect(result[1].reactionEmojis).toEqual(['👍', '❤️']);
		expect(result[1].reactionItems?.map((entry) => entry.id)).toEqual(['r1', 'r2', 'r3']);
	});

	it('keeps different senders on different targets as separate rows', () => {
		const result = mergeAdjacentReactionMarkers([
			{ ...marker('r1', 't1', 10), reactionSenders: ['pk-bob'] },
			{ ...marker('r2', 't2', 11), reactionSenders: ['pk-alice'] }
		]);
		expect(result.map((entry) => entry.id)).toEqual(['r1', 'r2']);
	});

	it('never merges targetless markers from the same sender', () => {
		const result = mergeAdjacentReactionMarkers([
			{ ...marker('r1', undefined, 10), reactionSenders: ['pk-bob'] },
			{ ...marker('r2', undefined, 11), reactionSenders: ['pk-bob'] }
		]);
		expect(result).toHaveLength(2);
	});
});

describe('pruneAdjacentReactionTargets', () => {
	const chat = (id: string) => row({ id, kind: 9, text: 'hello' });

	it('drops a row whose target is the nearest preceding message', () => {
		const result = pruneAdjacentReactionTargets([chat('t'), marker('r1', 't', 10)]);
		expect(result.map((entry) => entry.id)).toEqual(['t']);
	});

	it('drops consecutive rows targeting the adjacent message', () => {
		const result = pruneAdjacentReactionTargets([
			chat('x'),
			chat('t'),
			marker('r1', 't', 10),
			marker('r2', 't', 11)
		]);
		expect(result.map((entry) => entry.id)).toEqual(['x', 't']);
	});

	it('keeps rows whose target is further back', () => {
		const result = pruneAdjacentReactionTargets([chat('t'), chat('m'), marker('r1', 't', 10)]);
		expect(result.map((entry) => entry.id)).toEqual(['t', 'm', 'r1']);
	});

	it('skips system rows when finding the nearest message', () => {
		const result = pruneAdjacentReactionTargets([
			chat('t'),
			row({ id: 'sys', kind: -1, text: '', systemKind: 'member-added' }),
			marker('r1', 't', 10)
		]);
		expect(result.map((entry) => entry.id)).toEqual(['t', 'sys']);
	});

	it('keeps rows with unresolvable targets', () => {
		const result = pruneAdjacentReactionTargets([chat('t'), marker('r1', undefined, 10)]);
		expect(result.map((entry) => entry.id)).toEqual(['t', 'r1']);
	});
});

describe('foldReactionMarkers', () => {
	it('keeps older targets of a burst when the first target is the adjacent message', () => {
		const result = foldReactionMarkers([
			message('t'),
			{ ...marker('r1', 't', 10), reactionSenders: ['pk-bob'] },
			{ ...marker('r2', 'x', 11), reactionSenders: ['pk-bob'] }
		]);
		// The run must not swallow r2 just because r1 targets the adjacent message.
		expect(result.map((entry) => entry.id)).toEqual(['t', 'r2']);
	});

	it('collapses surviving same-sender rows and drops adjacent-target rows', () => {
		const result = foldReactionMarkers([
			message('t'),
			{ ...marker('r1', 'x', 10), reactionSenders: ['pk-bob'] },
			{ ...marker('r2', 'y', 11), reactionSenders: ['pk-bob'] },
			{ ...marker('r3', 't', 12), reactionSenders: ['pk-bob'] }
		]);
		expect(result.map((entry) => entry.id)).toEqual(['t', 'r1']);
		expect(result[1].reactionTarget).toBe('x');
		expect(result[1].reactionSenders).toEqual(['pk-bob']);
		expect(result[1].reactionItems?.map((entry) => entry.id)).toEqual(['r1', 'r2']);
	});
});
