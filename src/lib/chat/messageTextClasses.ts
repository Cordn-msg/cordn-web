/**
 * Shared text-rendering class strings for message body parts. Used by both the
 * inline body (`TextInline`) and the chat row (`ChatMessageItem` reply preview)
 * so wrapping/break behavior cannot drift between them.
 */
export const MESSAGE_TEXT_WRAP_CLASS =
	'min-w-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]';
export const MESSAGE_LINK_WRAP_CLASS =
	'inline max-w-full whitespace-normal break-words text-left align-baseline underline underline-offset-2 [overflow-wrap:anywhere] [word-break:break-word]';
export const MESSAGE_PART_CONTAINER_CLASS =
	'min-w-0 max-w-full break-words [overflow-wrap:anywhere] [word-break:break-word]';
