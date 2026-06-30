# Chat kind rendering — architecture

Reference for the multi-kind chat rendering layer. Read before touching kind
parsing, message view-model aggregation, or message rendering.

## Mental model

The chat stream is the universal view: every kind lands as a message row. Each
kind has a compact **inline** renderer for the stream, and optionally a **rich**
renderer for full fidelity (right sidebar + dedicated route). Long-form content,
polls, calendar events, etc. all fit this shape.

## Two-renderer contract

Per kind, exactly two renderers:

| Renderer             | Required            | Lives in                           | Height                       | Context source                  |
| -------------------- | ------------------- | ---------------------------------- | ---------------------------- | ------------------------------- |
| **Inline** (compact) | yes, for every kind | chat stream row                    | bounded (line-clamp / max-h) | folded `ChatMessage` view model |
| **Rich** (detailed)  | optional            | sidebar + route (shared component) | unbounded, full fidelity     | self-queries storage            |

The sidebar and the route `/chat/[id]/e/[eventId]` are **two containers for the
same presentational component**. If anyone copies a renderer between them, the
design has failed.

## Registry

The kind registry is `Record<number, Component>`. Svelte 5 renders a component
held in a variable directly — no `svelte:component`, no dynamic-import dance.
A component gives each kind a full reactive surface (runes, lifecycle, child
components like `MarkdownContent`) — which reactive kinds need, e.g. a live
poll tally or a streaming thread view.

Registry shape:

```ts
// src/lib/chat/registry.ts
import type { Component } from 'svelte';

export interface InlineBodyProps {
	message: ChatMessage;
	onOpenRich?: (eventId: string) => void;
}
export type InlineBody = Component<InlineBodyProps>;

export const inlineBodies: Record<number, InlineBody> = {
	[ChatKinds.Text]: TextInline,
	[ChatKinds.LongForm]: LongFormInline
};
```

New kind = one file + one line in the map. Unknown inline kinds fall back to
`defaultInlineBody` (currently `TextInline`); unknown rich kinds fall back to
`DefaultRich`.

## Inline context — two sources

The shell folds dense annotations into the view model once, because they can hit
any message and the chat is a virtualized list (N rows — re-querying per row is
O(N²) and fights the virtualizer's measurement budget).

| Annotation   | Inline rendering                            | Fold                                             |
| ------------ | ------------------------------------------- | ------------------------------------------------ |
| Edit         | replaces text on the row, pencil badge      | `editMap.get(id).content → text`, `edited: true` |
| Delete       | row stays, body "deleted", actions grey out | `deletedMessageIds → deleted`                    |
| Reaction     | chips under the row, own-or-not styling     | `reactionMap → reactions[]`                      |
| Thread reply | preview chip at row top                     | `getMessageThreadReference → replyTo`            |

### Dense vs sparse — the rule for new primary kinds

- **Dense uniform annotations** (reactions, edits, deletes — can hit any message)
  → shell folds them into the view model, one global pass.
- **Kind-specific sparse aggregates** (a poll's votes, a thread's children)
  → that kind's inline body self-queries a targeted filter
  (`messages.filter(m => rootId(m.tags) === targetId)`). Only that kind pays,
  only when it is present.

Never extend the shell fold with a new kind's aggregation. The shell is not a
god-object; new kinds own their own sparse aggregates.

## Rich context — self-contained

Rich renderers take `(groupId, eventId)` and self-query storage. This gives
**transport symmetry**: the sidebar and the route are one-liners, both rendering
the same component unchanged. Reactivity is preserved because the renderer reads
the live message store inside `$derived` — streaming thread replies or live poll
tallies update as messages arrive over the subscription.

```svelte
<!-- ThreadRich.svelte — works identically in sidebar and route -->
<script lang="ts">
	let { groupId, eventId } = $props();
	const subject = $derived(byEventId(groupId, eventId));
	const thread = $derived(messagesOf(groupId).filter((m) => rootId(m.tags) === eventId));
</script>
```

## Shared layer (phase 1)

The only thing shared across the shell (inline fold), search, and
self-contained rich renderers:

- **`kinds.ts`** — kind catalog + primary/annotation split. Single source of
  truth. Kills every magic number (`7`/`9`/`5`/`1010`/`1111`) currently scattered
  across 4 files.
- **`references.ts`** — parsers (`getMessage{Reaction,Thread,Edit,Delete}Reference`)
  and send-tag builders (`create{Reaction,Reply,Edit,Delete}MessageTags`).

Aggregation _strategy_ is per-consumer: the shell folds for inline, rich bodies
self-query, search builds its own search-scoped map. All three import the same
parsers.

## Route

`/chat/[id]/e/[eventId]` — the `/e/` segment is a clean discriminator that keeps
the per-event detail route in its own namespace and leaves room for sibling
routes that render or filter the group's content by kind: future
`/chat/[id]/blog` (long-form), `/chat/[id]/cal` (calendar), etc.

Resolves via **local group storage lookup**, not a relay/nip19 fetch — messages
are MLS-encrypted and stored locally per group, not globally-addressable relay
events. Resolves to the `StoredChatMessage` (carries `kind`, `tags`, raw
`content` un-flattened), which is what rich renderers need.

Identifier decision: event id today. Accept `naddr` later for relay-synced
replaceable kinds (e.g. long-form NIP-23/30023), whose stable id is
`(pubkey, d-tag)`. Decide now so the `[eventId]` param can later accept either
form; implement only event-id resolution until naddr lands.

## Rules

- Inline never grows unbounded — it breaks the virtualizer. Line-clamp +
  "show more → opens rich" is the compact contract.
- Rich is **read-only** on day 1. Reply / react / edit stay in the chat row's
  actions menu. Interactivity in the rich view only when a real workflow demands it.
- Unknown kinds fall back to `DefaultInline` / `DefaultRich` — graceful
  degradation comes for free if the registry defaults to the generic renderers.
- The `ChatMessage` view model must carry `kind` (currently dropped by
  `toChatMessage`) so renderers can dispatch.
- Do not touch `ChatMessageList` virtualization, `scrollToMessage`, stable
  message keys, or `data-message-id` anchors — load-bearing per AGENTS.md.

## Folder home

```
src/lib/chat/
  README.md                 this doc
  kinds.ts                  catalog + primary/annotation split
  references.ts             parsers + send-tag builders + buildAnnotationIndex (shell+search helper)
  registry.ts               Record<number, Component> maps
  ChatInlineBody.svelte     compact dispatcher
  ChatRichBody.svelte       rich dispatcher
  inline/
    TextInline.svelte        kind 9/1111 body; also the default fallback
    LongFormInline.svelte   (added when the kind lands)
  rich/
    DefaultRich.svelte      evolved message-info dialog (the fallback)
    LongFormRich.svelte     full markdown + images, reuses MarkdownContent.svelte
```

Transport wrappers (thin, ~15 lines each):

- `src/lib/components/chat/ChatDetailSidebar.svelte` — right panel
- `src/routes/chat/[id]/e/[eventId]/+page.svelte` — dedicated route

## Phasing

1. **Consolidation (no new features).** `kinds.ts`, `references.ts`, dedupe
   Shell↔Search aggregation (they already drifted), replace every magic number.
   Pays for itself today, fixes the drift, is the foundation.
2. **Rich infrastructure (existing kinds).** Add `kind` to the `ChatMessage`
   view model, extract `ChatInlineBody.svelte`, add `ChatRichBody.svelte` +
   `DefaultRich.svelte` (lift the existing message-info dialog out of
   `ChatMessageItem`), wire the right sidebar + `/chat/[id]/e/[eventId]` route.
   Prove both transports with kind 9 (message + reactions + thread context)
   before any new kind lands — de-risk on familiar ground.
3. **First new kind (e.g. long-form).** `LongFormInline` + `LongFormRich`. Two
   files, both transports work automatically.
4. **View switcher (chat / long-form tabs).** Filter over the message array into
   a different container. Deferred until long-form volume justifies it. No new
   renderers — the bodies are already presentational.
