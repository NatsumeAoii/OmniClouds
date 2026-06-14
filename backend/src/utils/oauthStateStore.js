const STATE_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * In-memory store for short-lived OAuth `state` values used during provider
 * account linking. Entries are evicted automatically after STATE_TTL_MS to
 * keep memory bounded even when authorization flows are abandoned.
 */
export function createOAuthStateStore() {
	const states = new Map();

	function sweep(now = Date.now()) {
		for (const [state, entry] of states) {
			if (now - entry.createdAt > STATE_TTL_MS) {
				states.delete(state);
			}
		}
	}

	const sweepTimer = setInterval(() => sweep(), SWEEP_INTERVAL_MS);
	sweepTimer.unref?.();

	return {
		set(state, value) {
			states.set(state, { ...value, createdAt: Date.now() });
		},
		get(state) {
			const entry = states.get(state);
			if (!entry) return undefined;
			if (Date.now() - entry.createdAt > STATE_TTL_MS) {
				states.delete(state);
				return undefined;
			}
			return entry;
		},
		delete(state) {
			states.delete(state);
		},
	};
}
