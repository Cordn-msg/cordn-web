import { describe, expect, test } from 'vitest';
import { planDocumentRepairs } from './multiDeviceRepair.svelte';
import type { BlobProbe } from './multiDeviceDev.svelte';

function row(server: string, address: string, present: boolean): BlobProbe {
	return { server, address, kind: 'group', present, status: present ? 200 : 404, size: null };
}

describe('planDocumentRepairs', () => {
	test('copies only documents that still have a source replica', () => {
		const plan = planDocumentRepairs([
			row('a', 'available', true),
			row('b', 'available', false),
			row('a', 'lost', false),
			row('b', 'lost', false)
		]);

		expect(plan.missing).toEqual([row('b', 'available', false)]);
		expect(plan.lost).toEqual(['lost']);
	});

	test('an unreachable host is not a repair target and not a lost document', () => {
		const plan = planDocumentRepairs([
			row('a', 'doc', true),
			{ ...row('b', 'doc', false), status: 0, reason: 'unreachable' },
			row('c', 'gone', false),
			{ ...row('d', 'gone', false), status: 0, reason: 'unreachable' }
		]);

		expect(plan.missing).toEqual([]);
		expect(plan.lost).toEqual([]);
	});

	test('a document every host answered 404 for is lost', () => {
		const plan = planDocumentRepairs([row('a', 'gone', false), row('b', 'gone', false)]);

		expect(plan.missing).toEqual([]);
		expect(plan.lost).toEqual(['gone']);
	});
});
