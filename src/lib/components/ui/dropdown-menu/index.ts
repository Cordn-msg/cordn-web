import { DropdownMenu } from 'bits-ui';
import Content from './dropdown-menu-content.svelte';
import Item from './dropdown-menu-item.svelte';

const Root = DropdownMenu.Root;
const Trigger = DropdownMenu.Trigger;

export {
	Root,
	Trigger,
	Content,
	Item,
	Root as DropdownMenuRoot,
	Trigger as DropdownMenuTrigger,
	Content as DropdownMenuContent,
	Item as DropdownMenuItem
};
