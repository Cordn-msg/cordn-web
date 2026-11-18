import { describe, expect, it } from 'vitest';

import { ChatKinds } from '$lib/chat/kinds';
import {
	buildPollTally,
	createPollMessageTags,
	createPollResponseTags,
	describePollVote,
	getMessagePollDefinition,
	getMessagePollResponseReference,
	validatePollDraft,
	type PollDraft
} from '$lib/chat/polls';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';

const ME = '1'.repeat(64);
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);

// StoredChatMessage.createdAt is unix MILLISECONDS (coordinator `at`); poll
// `endsAt` is NIP-88 unix SECONDS. Fixtures mirror that split on purpose — a
// unit regression here is exactly the bug that once zeroed every tally.
const POLL_AT_MS = 1_750_000_000_000;
const POLL_AT_S = POLL_AT_MS / 1000;

function draft(overrides: Partial<PollDraft> = {}): PollDraft {
	return {
		question: 'Pineapple on pizza?',
		optionLabels: ['Yay', 'Nay'],
		pollType: 'singlechoice',
		endsAt: null,
		...overrides
	};
}

let cursor = 0;
function message(overrides: Partial<StoredChatMessage> & { id: string }): StoredChatMessage {
	return {
		cursor: ++cursor,
		createdAt: POLL_AT_MS,
		direction: 'inbound',
		sender: ALICE,
		kind: ChatKinds.Text,
		tags: [],
		content: '',
		...overrides
	};
}

function pollMessage(id: string, overrides: Partial<StoredChatMessage> = {}): StoredChatMessage {
	return message({
		id,
		kind: ChatKinds.Poll,
		content: 'Pineapple on pizza?',
		createdAt: POLL_AT_MS,
		tags: createPollMessageTags(draft()),
		...overrides
	});
}

function voteMessage(
	id: string,
	sender: string,
	optionIds: string[],
	overrides: Partial<StoredChatMessage> = {}
): StoredChatMessage {
	return message({
		id,
		sender,
		kind: ChatKinds.PollResponse,
		createdAt: POLL_AT_MS + 50_000,
		tags: createPollResponseTags({ id: 'poll1', pubkey: ALICE, kind: ChatKinds.Poll }, optionIds),
		...overrides
	});
}

describe('poll drafts', () => {
	it('accepts a sane draft and rejects the marmot gotcha cases', () => {
		const now = 1000;
		expect(validatePollDraft(draft(), now)).toBeNull();
		expect(validatePollDraft(draft({ question: ' padded ' }), now)).toMatch(/Question/);
		expect(validatePollDraft(draft({ question: 'q\u202eevil' }), now)).toMatch(/Question/);
		expect(validatePollDraft(draft({ optionLabels: ['only'] }), now)).toMatch(/options/);
		expect(validatePollDraft(draft({ optionLabels: ['a', '  '] }), now)).toMatch(/Options/);
		expect(validatePollDraft(draft({ endsAt: now }), now)).toMatch(/End time/);
		expect(validatePollDraft(draft({ endsAt: now + 31 * 24 * 3600 }), now)).toMatch(/End time/);
		expect(validatePollDraft(draft({ endsAt: now + 3600 }), now)).toBeNull();
	});

	it('accepts long text without field-size caps', () => {
		const longQuestion = 'Q'.repeat(4_000);
		const longOption = 'O'.repeat(2_000);
		const long = draft({ question: longQuestion, optionLabels: [longOption, 'Nay'] });
		expect(validatePollDraft(long, 1000)).toBeNull();

		const tags = createPollMessageTags(long, 1000);
		const parsed = getMessagePollDefinition(ChatKinds.Poll, longQuestion, tags);
		expect(parsed?.question).toBe(longQuestion);
		expect(parsed?.options[0].label).toBe(longOption);
	});
});

describe('poll tag round trip', () => {
	it('assigns display-order ids and defaults to singlechoice on parse', () => {
		const tags = createPollMessageTags(draft({ pollType: 'multiplechoice', endsAt: 5000 }), 4000);
		const parsed = getMessagePollDefinition(ChatKinds.Poll, 'Pineapple on pizza?', tags);
		expect(parsed).toEqual({
			question: 'Pineapple on pizza?',
			options: [
				{ id: '0', label: 'Yay' },
				{ id: '1', label: 'Nay' }
			],
			pollType: 'multiplechoice',
			endsAt: 5000
		});
	});

	it('parses a poll without polltype as singlechoice and ignores extension tags', () => {
		const tags = [
			['option', 'qj518h583', 'Yay'],
			['option', 'gga6cdnqj', 'Nay'],
			['relay', 'wss://example.test'],
			['future-extension', 'value']
		];
		expect(getMessagePollDefinition(ChatKinds.Poll, 'Q?', tags)).toMatchObject({
			pollType: 'singlechoice',
			endsAt: null
		});
	});

	it('rejects malformed known tags strictly', () => {
		const base = createPollMessageTags(draft());
		expect(getMessagePollDefinition(ChatKinds.Poll, 'Q?', [['option', '0']])).toBeNull();
		expect(
			getMessagePollDefinition(ChatKinds.Poll, 'Q?', [...base, ['polltype', 'approval']])
		).toBeNull();
		expect(
			getMessagePollDefinition(ChatKinds.Poll, 'Q?', [...base, ['polltype', 'singlechoice']])
		).toBeNull(); // duplicate
		expect(
			getMessagePollDefinition(ChatKinds.Poll, 'Q?', [...base, ['endsAt', 'soon']])
		).toBeNull();
		expect(getMessagePollDefinition(ChatKinds.Poll, '  ', base)).toBeNull(); // empty question
		expect(getMessagePollDefinition(ChatKinds.Text, 'Q?', base)).toBeNull();
		expect(
			getMessagePollDefinition(
				ChatKinds.Poll,
				'Q?',
				Array.from({ length: 33 }, () => ['x', 'y'])
			)
		).toBeNull(); // tag bound
	});
});

describe('poll responses', () => {
	const target = { id: 'poll1', pubkey: ALICE, kind: ChatKinds.Poll };

	it('round-trips through the parser', () => {
		const tags = createPollResponseTags(target, ['0', '1']);
		expect(getMessagePollResponseReference(ChatKinds.PollResponse, tags)).toEqual({
			targetId: 'poll1',
			optionIds: ['0', '1']
		});
	});

	it('rejects empty and duplicate selections on send', () => {
		expect(() => createPollResponseTags(target, [])).toThrow(/selection/);
		expect(() => createPollResponseTags(target, ['0', '0'])).toThrow(/selection/);
	});

	it('rejects malformed responses on parse', () => {
		expect(getMessagePollResponseReference(ChatKinds.PollResponse, [])).toBeNull();
		expect(getMessagePollResponseReference(ChatKinds.PollResponse, [['e', 'poll1']])).toBeNull(); // no response tag
		expect(
			getMessagePollResponseReference(ChatKinds.PollResponse, [
				['e', 'poll1'],
				['response', 'bad id!']
			])
		).toBeNull();
	});
});

describe('unsupported-client fallbacks (NIP-31 alt + content)', () => {
	it('appends alt summaries for clients that cannot render the kinds', () => {
		expect(createPollMessageTags(draft()).at(-1)).toEqual(['alt', 'Poll: Pineapple on pizza?']);
		expect(
			createPollResponseTags({ id: 'poll1', pubkey: ALICE, kind: ChatKinds.Poll }, ['0']).at(-1)
		).toEqual(['alt', 'Poll vote']);
	});

	it('describes votes from the definition when it can, plainly when not', () => {
		const definition = getMessagePollDefinition(
			ChatKinds.Poll,
			'Pineapple on pizza?',
			createPollMessageTags(draft())
		);
		expect(describePollVote(definition, ['1', '0'])).toBe('Voted: Nay, Yay');
		expect(describePollVote(definition, ['7'])).toBe('Voted');
		expect(describePollVote(null, ['0'])).toBe('Voted');
	});
});

describe('buildPollTally', () => {
	it('projects one vote per account, latest response wins', () => {
		const tally = buildPollTally(
			[
				pollMessage('poll1'),
				voteMessage('v1', ALICE, ['0'], { createdAt: POLL_AT_MS + 150_000 }),
				voteMessage('v2', ALICE, ['1'], { createdAt: POLL_AT_MS + 160_000 }), // re-vote
				voteMessage('v3', BOB, ['1'], { createdAt: POLL_AT_MS + 155_000 })
			],
			'poll1',
			ME,
			POLL_AT_S + 200
		);
		expect(tally?.options).toEqual([
			{ id: '0', label: 'Yay', votes: 0 },
			{ id: '1', label: 'Nay', votes: 2 }
		]);
		expect(tally?.participants).toBe(2);
		expect(tally?.open).toBe(true);
	});

	it('breaks same-second ties on cursor (multi-device same account)', () => {
		const tally = buildPollTally(
			[
				pollMessage('poll1'),
				voteMessage('v1', ME, ['0'], { createdAt: POLL_AT_MS + 50_000, cursor: 5 }),
				voteMessage('v2', ME, ['1'], { createdAt: POLL_AT_MS + 50_000, cursor: 9 })
			],
			'poll1',
			ME,
			POLL_AT_S + 200
		);
		expect(tally?.participants).toBe(1);
		expect(tally?.selection).toEqual(['1']);
		expect(tally?.options.map((option) => option.votes)).toEqual([0, 1]);
	});

	it('ignores responses outside the poll window or with invalid selections', () => {
		const withDeadline = pollMessage('poll1', {
			tags: createPollMessageTags(draft({ endsAt: POLL_AT_S + 200 }), POLL_AT_S)
		});
		const tally = buildPollTally(
			[
				withDeadline,
				voteMessage('early', ALICE, ['0'], { createdAt: POLL_AT_MS - 1_000 }), // before the poll
				voteMessage('late', BOB, ['0'], { createdAt: POLL_AT_MS + 201_000 }), // after endsAt
				voteMessage('multi', ME, ['0', '1'], { createdAt: POLL_AT_MS + 150_000 }), // singlechoice violation
				voteMessage('unknown', 'c'.repeat(64), ['7'], { createdAt: POLL_AT_MS + 150_000 }) // no such option
			],
			'poll1',
			ME,
			POLL_AT_S + 250
		);
		expect(tally?.participants).toBe(0);
		expect(tally?.selection).toEqual([]);
		expect(tally?.open).toBe(false);
	});

	it('counts millisecond createdAt votes against a seconds deadline (unit regression)', () => {
		const tally = buildPollTally(
			[
				pollMessage('poll1', {
					tags: createPollMessageTags(draft({ endsAt: POLL_AT_S + 100 }), POLL_AT_S)
				}),
				voteMessage('v1', ALICE, ['0'], { createdAt: POLL_AT_MS + 50_000 })
			],
			'poll1',
			ME,
			POLL_AT_S + 50
		);
		expect(tally?.participants).toBe(1);
		expect(tally?.options.map((option) => option.votes)).toEqual([1, 0]);
		expect(tally?.open).toBe(true);
	});

	it('accepts multi selections for multiplechoice polls and orders votes deterministically', () => {
		const tally = buildPollTally(
			[
				pollMessage('poll1', {
					tags: createPollMessageTags(draft({ pollType: 'multiplechoice' }))
				}),
				voteMessage('v1', BOB, ['0', '1'], { createdAt: POLL_AT_MS + 150_000 }),
				voteMessage('v2', ALICE, ['1'], { createdAt: POLL_AT_MS + 150_000 })
			],
			'poll1',
			ME,
			POLL_AT_S + 200
		);
		expect(tally?.options.map((option) => option.votes)).toEqual([1, 2]);
		expect(tally?.votes.map((vote) => vote.voter)).toEqual([ALICE, BOB]);
	});

	it('returns null for missing or unsupported polls', () => {
		expect(buildPollTally([pollMessage('poll1')], 'other', ME)).toBeNull();
		const broken = message({
			id: 'poll1',
			kind: ChatKinds.Poll,
			content: 'Q?',
			tags: [['option', '0']]
		});
		expect(buildPollTally([broken], 'poll1', ME)).toBeNull();
	});
});
