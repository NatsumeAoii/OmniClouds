const uploadSockets = new Map();

export function registerUploadSocket(uploadId, socket) {
	if (!uploadSockets.has(uploadId)) {
		uploadSockets.set(uploadId, new Set());
	}

	uploadSockets.get(uploadId).add(socket);
}

export function unregisterUploadSocket(uploadId, socket) {
	const sockets = uploadSockets.get(uploadId);
	if (!sockets) return;
	sockets.delete(socket);
	if (!sockets.size) {
		uploadSockets.delete(uploadId);
	}
}

export function emitUploadEvent(uploadId, event) {
	const sockets = uploadSockets.get(uploadId);
	if (!sockets) return;

	const payload = JSON.stringify(event);
	for (const socket of sockets) {
		if (socket.readyState !== 1) continue;
		try {
			socket.send(payload);
		} catch (error) {
			// A failed progress emit (e.g. a socket that closed mid-flight) must
			// never break the critical upload path that calls this hook.
			unregisterUploadSocket(uploadId, socket);
			console.warn(`Failed to emit upload event for ${uploadId}:`, error?.message || error);
		}
	}
}
