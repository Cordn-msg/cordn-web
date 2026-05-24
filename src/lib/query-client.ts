import { browser } from '$app/environment';
import { QueryClient } from '@tanstack/svelte-query';

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			enabled: browser,
			staleTime: 30 * 1000,
			gcTime: 10 * 60 * 1000,
			retry: 1,
			refetchOnWindowFocus: false
		},
		mutations: {
			retry: false
		}
	}
});
