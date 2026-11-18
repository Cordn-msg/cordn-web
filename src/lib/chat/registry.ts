/**
 * Kind render registries. See `src/lib/chat/README.md`.
 *
 * Adding a kind's compact or rich renderer is one file + one entry here. The
 * dispatchers (`ChatInlineBody.svelte`, `ChatRichBody.svelte`) look up by kind
 * and fall back to the default when a kind has no specific renderer.
 *
 * Text, polls and calendar events have dedicated bodies; unknown kinds fall
 * back to the default renderers. Kept as the documented extension seam
 * (README.md § Registry).
 */
import type { Component } from 'svelte';

import { ChatKinds } from '$lib/chat/kinds';
import TextInline from '$lib/chat/inline/TextInline.svelte';
import PollInline from '$lib/chat/inline/PollInline.svelte';
import CalendarEventInline from '$lib/chat/inline/CalendarEventInline.svelte';
import CallInline from '$lib/chat/inline/CallInline.svelte';
import DefaultRich from '$lib/chat/rich/DefaultRich.svelte';
import PollRich from '$lib/chat/rich/PollRich.svelte';
import CalendarEventRich from '$lib/chat/rich/CalendarEventRich.svelte';

// ---------------------------------------------------------------------------
// Inline (compact) bodies — rendered inside the chat stream row.
// ---------------------------------------------------------------------------

export interface InlineBodyProps {
	message: import('$lib/components/chat/chat.types').ChatMessage;
	/** Group the message belongs to — sparse-aggregate kinds (polls) self-query
	 *  their group's message store from here. */
	groupId?: string;
	/** Cast a poll vote (kind 1018): complete selection of option ids. */
	onVote?: (
		message: import('$lib/components/chat/chat.types').ChatMessage,
		optionIds: string[]
	) => void | Promise<boolean>;
	/** Open the rich view for this event (sidebar / dedicated route). */
	onOpenRich?: (eventId: string) => void;
}
export type InlineBody = Component<InlineBodyProps>;

/** Kind → compact body. TextInline also serves as the fallback for unknown
 *  primary kinds until they gain a dedicated compact renderer. */
export const inlineBodies: Record<number, InlineBody> = {
	[ChatKinds.Text]: TextInline,
	[ChatKinds.ThreadReply]: TextInline,
	[ChatKinds.Poll]: PollInline,
	[ChatKinds.Call]: CallInline,
	[ChatKinds.CalendarDate]: CalendarEventInline,
	[ChatKinds.CalendarTime]: CalendarEventInline
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

/** Kind → rich body. PollRich shares one presentational surface between the
 *  detail sidebar and /chat/[id]/e/[eventId] (README § Rich context). */
export const richBodies: Record<number, RichBody> = {
	[ChatKinds.Poll]: PollRich,
	[ChatKinds.CalendarDate]: CalendarEventRich,
	[ChatKinds.CalendarTime]: CalendarEventRich
};

export const defaultRichBody: RichBody = DefaultRich;
