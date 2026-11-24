/**
 * Open state of the notifications dialog. Lives here rather than in the tab bar
 * because a web notification tap opens it from outside the tab bar's subtree
 * (and the tab bar is hidden on conversation routes, so the tap navigates home
 * first and the freshly mounted bar reads this flag).
 */
export const notificationsDialog = $state<{ open: boolean }>({ open: false });
