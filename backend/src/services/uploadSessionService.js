import { randomUUID } from 'crypto';

const sessions = new Map();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function sweepExpiredSessions(now = Date.now()) {
	for (const [id, session] of sessions) {
		const createdAt = Date.parse(session.createdAt) || 0;
		if (now - createdAt > SESSION_TTL_MS) {
			sessions.delete(id);
		}
	}
}

const sweepTimer = setInterval(() => sweepExpiredSessions(), SWEEP_INTERVAL_MS);
sweepTimer.unref?.();

export function createUploadSession(payload) {
	const id = randomUUID();
	const session = {
		id,
		...payload,
		token: randomUUID(),
		status: 'pending',
		createdAt: new Date().toISOString(),
	};

	sessions.set(id, session);
	return session;
}

export function getUploadSessionForUser(userId, id) {
	const session = sessions.get(id);
	if (!session || session.user_id !== userId) return null;
	return session;
}

export function updateUploadSession(id, patch) {
	const session = sessions.get(id);
	if (!session) return null;
	const next = { ...session, ...patch };
	sessions.set(id, next);
	return next;
}

export function removeUploadSession(id) {
	sessions.delete(id);
}
