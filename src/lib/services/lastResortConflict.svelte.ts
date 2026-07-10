/**
 * Promise-based singleton state for the foreign-last-resort conflict prompt.
 *
 * ensureLastResortPublished returns 'foreign' when another device published a
 * last-resort this device doesn't hold; call sites trigger
 * promptForeignLastResort and the globally-mounted LastResortConflictDialog
 * resolves it. Resolves to the published keyPackageRef on take-over, or null on
 * link / cancel (caller aborts the original operation).
 */
export type ForeignLastResortOutcome = string | null;

interface PendingPrompt {
	coordinatorKey: string;
	resolve: (ref: ForeignLastResortOutcome) => void;
}

export const foreignLastResortPrompt = $state<{ pending: PendingPrompt | null }>({
	pending: null
});

export function promptForeignLastResort(coordinatorKey: string): Promise<ForeignLastResortOutcome> {
	return new Promise((resolve) => {
		foreignLastResortPrompt.pending = { coordinatorKey, resolve };
	});
}

export function resolveForeignLastResortPrompt(ref: ForeignLastResortOutcome): void {
	const pending = foreignLastResortPrompt.pending;
	foreignLastResortPrompt.pending = null;
	pending?.resolve(ref);
}
