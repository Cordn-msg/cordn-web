import { clientStateDecoder } from 'ts-mls';
import type { CordnBackgroundNotificationPreview, StagedMessage } from 'cordn-background';

import {
	formatChatNotificationBody,
	getChatGroupDisplayTitle
} from '$lib/components/chat/chatGroupDisplay';
import { listGroupMembers } from '$lib/services/chatAdminPolicy';
import type { StoredChatGroup } from '$lib/services/chatGroups.svelte';
import {
	ingestChatGroupMessages,
	type StoredChatMessage
} from '$lib/services/chatGroupMessages.svelte';
import { getCordnGroupMetadataExtension } from '$lib/services/chatMlsUtils';
import { getNotificationPreviewsEnabled } from '$lib/services/chatNotificationSettings';
import { selectNotificationPreview } from '$lib/services/chatNotificationPreviewText';
import { getChatStorage } from '$lib/storage/chatStorage';

interface PreviewMessage {
	cursor: number;
	createdAt: number;
	opaqueMessageBase64: string;
}

interface ColdPreviewRequest {
	accountPubkey: string;
	rows: StagedMessage[];
}

interface ColdPreviewBridge {
	getRequest(): string;
	postResult(payload: string): void;
	fail(reason: string): void;
}

type PreviewWindow = Window & { CordnPreviewBridge?: ColdPreviewBridge };

const PRESENCE_STORAGE_KEY = 'cordn-chat-group-presence';
const MAX_PREVIEW_GROUPS = 20;
const PREVIEW_BUDGET_MS = 8_000;

/**
 * Last read cursor, from the same durable presence record the app uses. The
 * preview path deliberately does not import the presence store (it drags the
 * reactive chat graph into a short-lived background WebView); the record shape
 * is the stable storage contract.
 */
function lastReadCursor(ownerPubkey: string, groupId: string): number {
	if (typeof localStorage === 'undefined') return 0;
	try {
		const ownerKey = `${PRESENCE_STORAGE_KEY}:${ownerPubkey}`;
		const raw = localStorage.getItem(ownerKey) ?? localStorage.getItem(PRESENCE_STORAGE_KEY);
		if (!raw) return 0;
		const parsed = JSON.parse(raw) as {
			groups?: Record<string, { lastReadCursor?: number }>;
		};
		return parsed.groups?.[groupId]?.lastReadCursor ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Entry point for the short-lived hidden WebView. Native injects a tiny JS
 * bridge, hands over the staged rows, and waits for one result (or a failure).
 * No Capacitor bridge or app shell is involved.
 */
export async function runColdNotificationPreviews(): Promise<void> {
	const bridge = (window as PreviewWindow).CordnPreviewBridge;
	if (!bridge) return;
	if (!getNotificationPreviewsEnabled()) {
		bridge.postResult(JSON.stringify({ previews: [] }));
		return;
	}
	try {
		const request = JSON.parse(bridge.getRequest()) as ColdPreviewRequest;
		const previews = await generateNotificationPreviews(request);
		bridge.postResult(JSON.stringify({ previews }));
	} catch (error) {
		bridge.fail(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Build notification text from a throwaway copy of each group's current MLS
 * state. This never persists the clone, never advances the authoritative
 * ratchet, and never clears the native sidecar: the ordinary foreground
 * ingestion still owns every state transition. Any group that cannot be
 * opened is simply left out, so the native count-only notification stands.
 *
 * shortcut: no persisted preview ratchet, so a large backlog re-clones and
 * replays once per fetch. Add a cached preview watermark if profiling shows
 * this cost on real bursts.
 */
export async function generateNotificationPreviews(input: {
	accountPubkey: string;
	rows: StagedMessage[];
}): Promise<CordnBackgroundNotificationPreview[]> {
	const ownerPubkey = input.accountPubkey.trim().toLowerCase();
	if (!ownerPubkey || input.rows.length === 0) return [];

	const rowsByGroup = new Map<string, PreviewMessage[]>();
	for (const row of input.rows) {
		if (!row.gid || !row.msg64 || row.cursor <= 0) continue;
		const list = rowsByGroup.get(row.gid) ?? [];
		list.push({
			cursor: row.cursor,
			createdAt: row.at,
			opaqueMessageBase64: row.msg64
		});
		rowsByGroup.set(row.gid, list);
	}
	if (rowsByGroup.size === 0) return [];

	const storage = await getChatStorage();
	const deadline = Date.now() + PREVIEW_BUDGET_MS;
	const groups = [...rowsByGroup.entries()]
		.map(([gid, rows]) => ({
			gid,
			rows: rows.sort((a, b) => a.cursor - b.cursor),
			latestCursor: rows[rows.length - 1]?.cursor ?? 0
		}))
		.sort((a, b) => b.latestCursor - a.latestCursor)
		.slice(0, MAX_PREVIEW_GROUPS);

	const previews: CordnBackgroundNotificationPreview[] = [];
	for (const { gid, rows } of groups) {
		if (Date.now() >= deadline) break;
		try {
			const data = await storage.getGroup(gid, { messageLimit: 0 });
			// Group ids can be shared across accounts. This runtime may only decrypt
			// the account the worker named; a mismatched record stays count-only.
			if (
				!data ||
				data.ownerPubkey !== ownerPubkey ||
				data.status === 'removed' ||
				data.status === 'poisoned'
			) {
				continue;
			}

			// A foreground ingest may already have handled these rows while the
			// preview was being prepared. Its state is authoritative; never replay
			// messages it has already advanced past.
			const freshRows = rows.filter((row) => row.cursor > data.fetchCursor);
			if (freshRows.length === 0) continue;

			const decoded = clientStateDecoder(data.stateBytes, 0);
			if (!decoded) continue;
			const state = decoded[0];
			const metadata = getCordnGroupMetadataExtension(state);
			const working = {
				id: data.id,
				state,
				metadata,
				lastCursor: data.lastCursor,
				fetchCursor: data.fetchCursor,
				messages: [] as StoredChatMessage[],
				syncIssues: [],
				status: data.status,
				removedAtCursor: data.removedAtCursor,
				poisonedAtCursor: data.poisonedAtCursor,
				formerPayloadKeys: data.formerPayloadKeys
			};
			const ingested = await ingestChatGroupMessages({
				group: working,
				messages: freshRows,
				localStablePubkey: ownerPubkey,
				mdActive: false,
				previewOnly: true
			});

			const selected = selectNotificationPreview(
				ingested.received,
				ownerPubkey,
				lastReadCursor(ownerPubkey, gid)
			);
			if (!selected) continue;
			const { count, thread } = selected;
			const messages = thread.map((message) => ({
				text: formatChatNotificationBody(message),
				at: message.createdAt
			}));
			const latest = messages[messages.length - 1]!;
			const memberPubkeys = listGroupMembers(working.state).map((member) => member.stablePubkey);
			const title = getChatGroupDisplayTitle({
				// Only id + metadata are read by the display helper. Use the replayed
				// metadata so a rename carried by this same batch is not lost.
				group: { id: data.id, metadata: working.metadata } as StoredChatGroup,
				activePubkey: ownerPubkey,
				memberPubkeys
			});
			previews.push({
				gid,
				title,
				body: latest.text,
				count,
				messages,
				cursor: freshRows[freshRows.length - 1]!.cursor
			});
		} catch (error) {
			// One unreadable group must not suppress the others; the count
			// notification for this group remains.
			console.warn('[notification-preview] group skipped', { gid, error });
		}
	}
	return previews;
}
