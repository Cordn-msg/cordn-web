/**
 * Kind render registries. See `src/lib/chat/README.md`.
 *
 * Adding a kind's compact or rich renderer is one file + one entry here. The
 * dispatchers (`ChatInlineBody.svelte`, `ChatRichBody.svelte`) look up by kind
 * and fall back to the default when a kind has no specific renderer.
 *
 * ponytail: today every dispatch resolves to the default — `inlineBodies`
 * maps both live kinds to `TextInline` (which is also `defaultInlineBody`),
 * and `richBodies` is empty. Kept as the documented extension seam
 * (README.md § Registry); collapse to direct `<TextInline>`/`<DefaultRich>`
 * only if the multi-kind plan is abandoned.
 */
import type { Component } from 'svelte';

import { ChatKinds } from '$lib/chat/kinds';
import TextInline from '$lib/chat/inline/TextInline.svelte';
import DefaultRich from '$lib/chat/rich/DefaultRich.svelte';

// ---------------------------------------------------------------------------
// Inline (compact) bodies — rendered inside the chat stream row.
// ---------------------------------------------------------------------------

export interface InlineBodyProps {
	message: import('$lib/components/chat/chat.types').ChatMessage;
	/** Open the rich view for this event (sidebar / dedicated route). */
	onOpenRich?: (eventId: string) => void;
}
export type InlineBody = Component<InlineBodyProps>;

/** Kind → compact body. TextInline also serves as the fallback for unknown
 *  primary kinds until they gain a dedicated compact renderer. */
export const inlineBodies: Record<number, InlineBody> = {
	[ChatKinds.Text]: TextInline,
	[ChatKinds.ThreadReply]: TextInline
};

export const defaultInlineBody: InlineBody = TextInline;

// ---------------------------------------------------------------------------
// Rich bodies — rendered in the detail sidebar and on /chat/[id]/e/[eventId].
// ---------------------------------------------------------------------------

export interface RichBodyProps {
	groupId: string;
	eventId: string;
	/** Swap the viewed event (e.g. follow a thread link). Transport-specific. */
	onNavigate?: (eventId: string) => void;
	/** Jump the chat shell to this event and close the inspector. Sidebar only. */
	onJumpToMessage?: (eventId: string) => void;
}
export type RichBody = Component<RichBodyProps>;

/** Kind → rich body. Empty until kinds gain dedicated rich renderers; until
 *  then DefaultRich (the lifted message-info view) handles everything. */
export const richBodies: Record<number, RichBody> = {};

export const defaultRichBody: RichBody = DefaultRich;
