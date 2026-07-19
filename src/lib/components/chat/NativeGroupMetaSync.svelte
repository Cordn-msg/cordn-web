<script lang="ts">
	// Headless native-only component: keeps the native group-metadata cache (display title +
	// rendered icon bytes) in sync so the key-less background worker can post rich notifications
	// (roadmap §4.4). Profile data is reactive-only in this app, so the sync must live in a
	// component (where `useProfileHints` works), not in the service layer.
	import { syncGroupMeta } from '$lib/services/nativeBridge';
	import { listChatGroups, listChatGroupMembers } from '$lib/services/chatGroups.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { normalizePubKey } from '$lib/utils';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import {
		getChatGroupDisplayTitle,
		getChatGroupNotificationIcon,
		renderNotificationIconFromSrc
	} from '$lib/components/chat/chatGroupDisplay';

	const groups = $derived(listChatGroups());
	const activePubkey = $derived($activeAccount?.pubkey);

	// One profile-hint subscription over the union of every group's members.
	const allMemberPubkeys = $derived.by(() => {
		const active = activePubkey ? normalizePubKey(activePubkey) : '';
		const set = new SvelteSet<string>();
		for (const g of groups) {
			for (const m of listChatGroupMembers(g.id)) {
				const p = normalizePubKey(m.stablePubkey);
				if (p && p !== active) set.add(p);
			}
		}
		return [...set];
	});

	const profileHints = useProfileHints(() => allMemberPubkeys, { relays: metadataRelays });

	// Bridge-call dedup: skip a group whose (title, iconSignature) hasn't changed since last push.
	const lastSent = new SvelteMap<string, string>();
	// Rasterization cache keyed by icon source (URL/data-URL) — avoids re-fetching image URLs.
	const iconBytesBySrc = new SvelteMap<string, string | null>();

	/**
	 * Reactive dependency: a compact string that changes whenever ANY input the icon/title
	 * computation reads actually changes — group membership, metadata (icon/name/imageUrl), any
	 * member's loaded profile (picture/name/displayName), or the active identity.
	 *
	 * Reading these specific fields (not a coarse `void profileHints`) is what lets Svelte's
	 * fine-grained reactivity track deep mutations on the `$state` proxies — so a profile that
	 * loads AFTER the first pass, or a metadata edit, re-triggers the debounced flush. Replaces a
	 * timer backstop with the same reactivity the display layer already relies on.
	 */
	const metaSig = $derived.by(() => {
		let sig = (activePubkey ?? '') + '|';
		for (const g of groups) {
			sig +=
				g.id +
				':' +
				(g.metadata?.icon ?? '') +
				':' +
				(g.metadata?.name ?? '') +
				':' +
				(g.metadata?.imageUrl ?? '') +
				';';
			for (const m of listChatGroupMembers(g.id)) {
				const p = normalizePubKey(m.stablePubkey);
				const h = p ? profileHints[p] : undefined;
				sig += (p ?? '') + ',' + (h?.picture ?? '') + ',' + (h?.name ?? '') + ',' + (h?.displayName ?? '') + ';';
			}
		}
		return sig;
	});

	$effect(() => {
		// Track the signature (a primitive string), so any deep mutation above re-runs this effect.
		void metaSig;
		// Debounce: collapse a burst of profile re-emits into one sync pass.
		const t = setTimeout(() => void flush(), 400);
		return () => clearTimeout(t);
	});

	async function flush() {
		for (const g of groups) {
			const memberPubkeys = listChatGroupMembers(g.id)
				.map((m) => normalizePubKey(m.stablePubkey))
				.filter((p): p is string => Boolean(p));
			const title = getChatGroupDisplayTitle({
				group: g,
				activePubkey,
				profileHints,
				memberPubkeys
			});
			const src = getChatGroupNotificationIcon(g, {
				activePubkey,
				memberPubkeys,
				profileHints
			});
			let iconBytes: string | null = null;
			if (src) {
				iconBytes = iconBytesBySrc.get(src) ?? null;
				if (!iconBytesBySrc.has(src)) {
					iconBytes = await renderNotificationIconFromSrc(src);
					iconBytesBySrc.set(src, iconBytes);
				}
			}
			const sig = `${title}::${iconBytes ? iconBytes.length + ':' + iconBytes.slice(0, 24) : ''}`;
			if (lastSent.get(g.id) === sig) continue;
			lastSent.set(g.id, sig);
			void syncGroupMeta(g.id, title, iconBytes);
		}
	}
</script>
