import { describe, expect, test } from 'vitest';

import { ChatKinds, isAnnotationKind, isSystemKind, SYSTEM_MESSAGE_KIND } from './kinds';
import {
	buildAnnotationIndex,
	getMessageDeleteReference,
	getMessageEditReference,
	getMessagePinReference,
	getMessageReactionReference,
	getMessageThreadReference,
	resolveOutboundMessage
} from './references';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';

function msg(
	overrides: Partial<StoredChatMessage> & Pick<StoredChatMessage, 'id' | 'kind'>
): StoredChatMessage {
	return {
		cursor: 0,
		createdAt: 0,
		direction: 'inbound',
		sender: 'aaaaaaaa',
		tags: [],
		content: '',
		...overrides
	} as StoredChatMessage;
}

describe('kind catalog', () => {
	test('classifies annotation and system kinds', () => {
		expect(isAnnotationKind(ChatKinds.Reaction)).toBe(true);
		expect(isAnnotationKind(ChatKinds.Edit)).toBe(true);
		expect(isAnnotationKind(ChatKinds.Deletion)).toBe(true);
		expect(isAnnotationKind(ChatKinds.Pin)).toBe(true);
		expect(isSystemKind(SYSTEM_MESSAGE_KIND)).toBe(true);
		// unknown future kinds are not annotations — they render
		expect(isAnnotationKind(30023)).toBe(false);
	});
});

describe('reference parsers', () => {
	test('reaction reference needs kind 7, e/p/k tags, and content', () => {
		expect(
			getMessageReactionReference(7, '🔥', [
				['e', 't1'],
				['p', 'pk'],
				['k', '9']
			])
		).toEqual({
			targetId: 't1',
			targetPubkey: 'pk',
			targetKind: 9,
			reaction: '🔥'
		});
		expect(getMessageReactionReference(9, '🔥', [])).toBeNull();
		expect(
			getMessageReactionReference(7, '   ', [
				['e', 't1'],
				['p', 'pk'],
				['k', '9']
			])
		).toBeNull();
	});

	test('thread reference needs uppercase root (E/K) and lowercase parent (e/k) tags', () => {
		expect(
			getMessageThreadReference([
				['E', 'root', '', 'rootpk'],
				['K', '9'],
				['P', 'rootpk'],
				['e', 'parent', '', 'parentpk'],
				['k', '1111'],
				['p', 'parentpk']
			])
		).not.toBeNull();
		expect(
			getMessageThreadReference([
				['e', 'parent'],
				['k', '1111']
			])
		).toBeNull();
	});

	test('edit reference needs kind 1010 and an e tag', () => {
		expect(getMessageEditReference(1010, 'new', [['e', 't1']])).toEqual({ targetId: 't1' });
		expect(getMessageEditReference(1010, '   ', [['e', 't1']])).toBeNull();
		expect(getMessageEditReference(9, 'new', [['e', 't1']])).toBeNull();
	});

	test('delete reference needs kind 5 and an e + k tag', () => {
		expect(
			getMessageDeleteReference(5, [
				['e', 't1'],
				['k', '9']
			])
		).toEqual({
			targetId: 't1',
			targetKind: 9
		});
		expect(getMessageDeleteReference(5, [['e', 't1']])).toBeNull();
	});

	test('pin reference needs kind 1011, an e tag, and an op tag of add/remove', () => {
		expect(
			getMessagePinReference(1011, [
				['e', 't1'],
				['op', 'add']
			])
		).toEqual({ targetId: 't1', op: 'add' });
		expect(
			getMessagePinReference(1011, [
				['e', 't1'],
				['op', 'remove']
			])
		).toEqual({ targetId: 't1', op: 'remove' });
		expect(
			getMessagePinReference(9, [
				['e', 't1'],
				['op', 'add']
			])
		).toBeNull();
		expect(getMessagePinReference(1011, [['op', 'add']])).toBeNull();
		expect(
			getMessagePinReference(1011, [
				['e', 't1'],
				['op', 'toggle']
			])
		).toBeNull();
	});
});

describe('resolveOutboundMessage', () => {
	const target = { id: 't1', pubkey: 'pk', kind: 9, content: 'hi', tags: [] };

	test('plain text → kind 9, trimmed', () => {
		expect(resolveOutboundMessage({ content: '  hi  ' })).toEqual({
			kind: 9,
			content: 'hi',
			tags: []
		});
	});

	test('reply → kind 1111 with thread tags', () => {
		const out = resolveOutboundMessage({ content: 'reply', replyTo: target });
		expect(out.kind).toBe(1111);
		expect(out.tags.some((t) => t[0] === 'E')).toBe(true);
	});

	test('reaction → kind 7, content preserved untrimmed', () => {
		expect(resolveOutboundMessage({ content: '🔥', reactionTo: target }).kind).toBe(7);
	});

	test('edit → kind 1010, trimmed, with extra tags appended', () => {
		const out = resolveOutboundMessage({
			content: ' edited ',
			editTo: target,
			tags: [['x', 'custom']]
		});
		expect(out.kind).toBe(1010);
		expect(out.content).toBe('edited');
		expect(out.tags.some((t) => t[0] === 'x')).toBe(true);
	});

	test('delete → kind 5, empty content', () => {
		const out = resolveOutboundMessage({ content: '', deleteTo: target });
		expect(out.kind).toBe(5);
		expect(out.content).toBe('');
	});

	test('pin → kind 1011, empty content, op tag defaults to add', () => {
		const add = resolveOutboundMessage({ content: '', pinTo: target });
		expect(add.kind).toBe(1011);
		expect(add.content).toBe('');
		expect(add.tags.find((t) => t[0] === 'op')?.[1]).toBe('add');
		const remove = resolveOutboundMessage({ content: '', pinTo: target, pinOp: 'remove' });
		expect(remove.tags.find((t) => t[0] === 'op')?.[1]).toBe('remove');
	});
});

describe('buildAnnotationIndex', () => {
	test('folds reactions, edits, and deletes onto their targets', () => {
		const original = msg({ id: 'orig', kind: 9, content: 'hello', sender: 'aaaa' });
		const editTarget = msg({ id: 'editTarget', kind: 9, content: 'hello', sender: 'aaaa' });
		const reaction = msg({
			id: 'r1',
			kind: 7,
			content: '🔥',
			sender: 'bbbb',
			tags: [
				['e', 'orig', '', 'aaaa'],
				['p', 'aaaa'],
				['k', '9']
			]
		});
		const edit = msg({
			id: 'e1',
			kind: 1010,
			content: 'hello (edited)',
			createdAt: 2,
			sender: 'aaaa',
			tags: [
				['e', 'editTarget', '', 'aaaa'],
				['p', 'aaaa'],
				['k', '9']
			]
		});
		const del = msg({
			id: 'd1',
			kind: 5,
			sender: 'aaaa',
			tags: [
				['e', 'orig', '', 'aaaa'],
				['k', '9']
			]
		});

		const index = buildAnnotationIndex([original, editTarget, reaction, edit, del]);
		expect(index.reactionMap.get('orig')?.get('🔥')?.authors.has('bbbb')).toBe(true);
		expect(index.editMap.get('editTarget')?.content).toBe('hello (edited)');
		expect(index.deletedIds.has('orig')).toBe(true);
	});

	test('rejects edit/delete from a sender who did not author the target', () => {
		const original = msg({ id: 'orig', kind: 9, content: 'hi', sender: 'aaaa' });
		const forgedDelete = msg({
			id: 'd1',
			kind: 5,
			sender: 'bbbb',
			tags: [
				['e', 'orig', '', 'aaaa'],
				['k', '9']
			]
		});
		const index = buildAnnotationIndex([original, forgedDelete]);
		expect(index.deletedIds.has('orig')).toBe(false);
	});

	test('pin set is last-write-wins, any-member, and tracks who/when', () => {
		const original = msg({ id: 'orig', kind: 9, content: 'hi', sender: 'aaaa' });
		const pinByB = msg({
			id: 'p1',
			kind: 1011,
			createdAt: 1,
			cursor: 1,
			sender: 'bbbb', // any member, not the author
			tags: [
				['e', 'orig', '', 'aaaa'],
				['op', 'add']
			]
		});
		const unpinByC = msg({
			id: 'p2',
			kind: 1011,
			createdAt: 2,
			cursor: 2,
			sender: 'cccc',
			tags: [
				['e', 'orig', '', 'aaaa'],
				['op', 'remove']
			]
		});

		const afterPin = buildAnnotationIndex([original, pinByB]);
		expect(afterPin.pinSet.get('orig')?.op).toBe('add');
		expect(afterPin.pinSet.get('orig')?.pinnedBy).toBe('bbbb');

		// Later unpin by a different member wins (no author check).
		const afterUnpin = buildAnnotationIndex([original, pinByB, unpinByC]);
		expect(afterUnpin.pinSet.get('orig')?.op).toBe('remove');
	});
});
