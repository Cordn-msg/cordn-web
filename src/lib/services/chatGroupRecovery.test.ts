import { describe, expect, test } from 'vitest';
import {
	chatGroupUnopenedCursor,
	classifyChatGroupUnopened,
	deriveLineCursor
} from './chatGroupRecovery';

describe('classifyChatGroupUnopened()', () => {
	test('poisoned state owns the verdict even with an unopened cursor', () => {
		expect(
			classifyChatGroupUnopened({ poisoned: true, firstUnopenedCursor: 10, lineCursor: 20 })
		).toBe('poisoned');
	});

	test('nothing unopened means no verdict', () => {
		expect(classifyChatGroupUnopened({ poisoned: false })).toBeUndefined();
	});

	test('any third-party message at our epoch makes it foreign keys', () => {
		expect(
			classifyChatGroupUnopened({ poisoned: false, firstUnopenedCursor: 10, lineCursor: 11 })
		).toBe('foreign-keys');
		expect(
			classifyChatGroupUnopened({ poisoned: false, firstUnopenedCursor: 10, lineCursor: 3 })
		).toBe('foreign-keys');
	});

	test('no line evidence means this device may be behind', () => {
		expect(classifyChatGroupUnopened({ poisoned: false, firstUnopenedCursor: 10 })).toBe('behind');
	});

	test('an adopted current state with old drop issues needs history catch-up', () => {
		expect(
			classifyChatGroupUnopened({
				poisoned: false,
				firstUnopenedCursor: 205,
				durableFrontier: undefined,
				adoptedCursor: 457
			})
		).toBe('catch-up');
		expect(
			classifyChatGroupUnopened({
				poisoned: false,
				firstUnopenedCursor: 205,
				durableFrontier: 205,
				adoptedCursor: 457
			})
		).toBe('behind');
		expect(
			classifyChatGroupUnopened({
				poisoned: false,
				firstUnopenedCursor: 205,
				adoptedCursor: 457,
				stateBehind: true
			})
		).toBe('behind');
	});
});

describe('chatGroupUnopenedCursor()', () => {
	test('prefers the durable frontier, then the drop horizon, then staleMark', () => {
		expect(
			chatGroupUnopenedCursor({
				firstUnopenedCursor: 10,
				dropHorizon: 5,
				staleMarkCursor: 3
			})
		).toBe(10);
		expect(chatGroupUnopenedCursor({ dropHorizon: 5, staleMarkCursor: 3 })).toBe(5);
		expect(chatGroupUnopenedCursor({ staleMarkCursor: 3 })).toBe(3);
		expect(chatGroupUnopenedCursor({})).toBeUndefined();
	});
});

describe('deriveLineCursor()', () => {
	const owner = 'aa'.repeat(32);

	test('takes the newest inbound message from another member after the epoch start', () => {
		expect(
			deriveLineCursor({
				epochStartCursor: 5,
				ownerPubkey: owner,
				messages: [
					{ cursor: 3, direction: 'inbound', sender: 'bb'.repeat(32) },
					{ cursor: 6, direction: 'outbound', sender: owner },
					{ cursor: 7, direction: 'inbound', sender: 'bb'.repeat(32) },
					{ cursor: 9, direction: 'inbound', sender: 'cc'.repeat(32) }
				]
			})
		).toBe(9);
	});

	test('ignores own echoes and messages before the epoch start', () => {
		expect(
			deriveLineCursor({
				epochStartCursor: 5,
				ownerPubkey: owner,
				messages: [
					{ cursor: 4, direction: 'inbound', sender: 'bb'.repeat(32) },
					{ cursor: 6, direction: 'inbound', sender: owner }
				]
			})
		).toBeUndefined();
	});

	test('ignores synthetic rows with no sender', () => {
		expect(
			deriveLineCursor({
				epochStartCursor: 0,
				ownerPubkey: owner,
				messages: [{ cursor: 6, direction: 'inbound', sender: '' }]
			})
		).toBeUndefined();
	});

	test('no epoch start or owner means no evidence', () => {
		expect(
			deriveLineCursor({ epochStartCursor: undefined, ownerPubkey: owner, messages: [] })
		).toBeUndefined();
		expect(
			deriveLineCursor({
				epochStartCursor: 0,
				ownerPubkey: undefined,
				messages: [{ cursor: 1, direction: 'inbound', sender: 'bb'.repeat(32) }]
			})
		).toBeUndefined();
	});
});
