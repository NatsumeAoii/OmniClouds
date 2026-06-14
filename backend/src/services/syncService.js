import cron from 'node-cron';
import { env } from '../config/env.js';
import { LOCAL_USER_ID } from '../config/database.js';
import { getActiveAccounts, listUserIdsWithActiveAccounts, markAccountStatus, updateAccountStorage } from './accountService.js';
import { createAdapter } from './adapterRegistry.js';
import { clearFilesForAccount, replaceFilesForAccount } from './fileService.js';
import { isAuthError, withRetry } from '../utils/providerErrors.js';

async function fetchAccountSnapshot(account) {
	return withRetry(
		async () => {
			const adapter = createAdapter(account);
			const remoteFiles = await adapter.fetchStructure();
			const storage = await adapter.getStorageSummary();
			const providerStarred = Boolean(adapter.getCapabilities?.().starred);
			return { remoteFiles, storage, providerStarred };
		},
		{
			retries: 3,
			onRetry: (error, attempt) => {
				console.warn(
					`Transient sync error for ${account.email} (attempt ${attempt}), retrying:`,
					error?.message || error,
				);
			},
		},
	);
}

function handleSyncFailure(account, error) {
	if (isAuthError(error)) {
		clearFilesForAccount(account.user_id, account.id);
		markAccountStatus(account.user_id, account.id, 'invalid_token');
		console.error(`Auth error for account ${account.email}, marked invalid_token:`, error.message);
		return;
	}

	console.error(
		`Transient sync failure for account ${account.email} (kept connected):`,
		error.message,
	);
}

let lastSyncReport = {
	lastRunAt: null,
	userId: null,
	scannedAccounts: 0,
	changesDetected: 0,
};

const activeSyncPromises = new Map();

export async function runDeltaSync(userId) {
	const inFlight = activeSyncPromises.get(userId);
	if (inFlight) {
		return inFlight;
	}

	const syncPromise = (async () => {
		const accounts = getActiveAccounts(userId);

		// Each account is an independent provider round-trip. Fetching them in
		// parallel turns total sync latency from the sum of all account times
		// into the slowest single account's time. The per-account local DB
		// writes (replace/update) are synchronous in better-sqlite3 and touch
		// disjoint rows keyed by cloud_account_id, so concurrent resolution is
		// safe. Each task captures its own failure so one bad account never
		// rejects the batch.
		const perAccountChanges = await Promise.all(
			accounts.map(async (account) => {
				try {
					const { remoteFiles, storage, providerStarred } = await fetchAccountSnapshot(account);

					replaceFilesForAccount(userId, account.id, remoteFiles, { preserveStarred: !providerStarred });
					updateAccountStorage(userId, account.id, storage.totalSpace, storage.usedSpace);
					return remoteFiles.length;
				} catch (error) {
					handleSyncFailure(account, error);
					return 0;
				}
			}),
		);

		const changesDetected = perAccountChanges.reduce((sum, count) => sum + count, 0);

		lastSyncReport = {
			lastRunAt: new Date().toISOString(),
			userId,
			scannedAccounts: accounts.length,
			changesDetected,
		};

		return lastSyncReport;
	})();

	activeSyncPromises.set(userId, syncPromise);

	try {
		return await syncPromise;
	} finally {
		activeSyncPromises.delete(userId);
	}
}

export function scheduleSync() {
	const interval = Math.max(1, env.syncIntervalMinutes);
	cron.schedule(`*/${interval} * * * *`, () => {
		if (env.appMode === 'local') {
			runDeltaSync(LOCAL_USER_ID).catch((error) => {
				console.error('Delta sync failed:', error);
			});
			return;
		}

		for (const userId of listUserIdsWithActiveAccounts()) {
			runDeltaSync(userId).catch((error) => {
				console.error(`Delta sync failed for user ${userId}:`, error);
			});
		}
	});
}

export function getLastSyncReport() {
	return {
		...lastSyncReport,
		isRunning: activeSyncPromises.size > 0,
	};
}

export async function syncAccount(userId, account) {
	try {
		const { remoteFiles, storage, providerStarred } = await fetchAccountSnapshot(account);

		replaceFilesForAccount(userId, account.id, remoteFiles, { preserveStarred: !providerStarred });
		updateAccountStorage(userId, account.id, storage.totalSpace, storage.usedSpace);

		return {
			accountId: account.id,
			filesSynced: remoteFiles.length,
			totalSpace: storage.totalSpace,
			usedSpace: storage.usedSpace,
		};
	} catch (error) {
		handleSyncFailure(account, error);
		throw error;
	}
}
