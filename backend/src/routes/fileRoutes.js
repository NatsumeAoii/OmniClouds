import { Router } from 'express';
import { listFilesByPath, getFileById, getFileByRemoteId, getLocalFilesByRemoteId, listRecentFiles, listStarredFiles, setFileStarred, updateFileStarredByRemoteId, renameFileMetadata, deleteFileMetadataById, upsertFileByRemoteId } from '../services/fileService.js';
import { getAccountById, getActiveAccounts, adjustAccountUsage } from '../services/accountService.js';
import { createAdapter } from '../services/adapterRegistry.js';
import { selectBestAccount } from '../services/spaceAllocator.js';
import { syncAccount } from '../services/syncService.js';
import { requireAppUser } from '../middleware/authMiddleware.js';
import { contentDispositionHeader } from '../utils/httpHeaders.js';

const router = Router();

router.use(requireAppUser);

/**
 * Pipe a provider download stream to the HTTP response with end-to-end failure
 * handling. Errors before the first byte are surfaced via `next` (so the
 * central error handler can produce a JSON error). Once streaming has started
 * the headers are already flushed, so a later upstream error can only be
 * handled by destroying the response. The client-disconnect handler tears down
 * the upstream provider stream to avoid leaking that connection.
 */
function pipeDownloadStream(stream, res, next) {
	let streamingStarted = false;

	const destroyStream = () => {
		if (typeof stream.destroy === 'function') {
			stream.destroy();
		}
	};

	stream.on('data', () => {
		streamingStarted = true;
	});

	stream.on('error', (error) => {
		if (streamingStarted || res.headersSent) {
			// Headers are already flushed, so we cannot send a JSON error. Log the
			// upstream cause for diagnostics and abort the response socket. We do
			// not pass the error to res.destroy to avoid emitting an unhandled
			// 'error' event on the response.
			console.error('Download stream failed after streaming started:', error?.message || error);
			destroyStream();
			res.destroy();
			return;
		}
		next(error);
	});

	res.on('close', () => {
		if (!res.writableEnded) {
			destroyStream();
		}
	});

	stream.pipe(res);
}

function encodeSharedFileId(accountId, remoteFileId) {
	return `shared:${accountId}:${Buffer.from(String(remoteFileId)).toString('base64url')}`;
}

function mapSharedItem(userId, account, item, localFile = getFileByRemoteId(userId, account.id, item.remote_file_id)) {
	return {
		...(localFile || {}),
		...item,
		id: encodeSharedFileId(account.id, item.remote_file_id),
		cloud_account_id: account.id,
		provider: localFile?.provider || account.provider,
		email: item.owner_email || localFile?.email || account.email,
		createdTime: item.createdTime,
		modifiedTime: item.modifiedTime,
		capabilities: {
			starred: Boolean(item.capabilities?.starred ?? localFile?.capabilities?.starred ?? account.provider === 'google_drive'),
			rename: Boolean(item.capabilities?.rename ?? localFile?.capabilities?.rename ?? false),
			delete: Boolean(item.capabilities?.delete ?? localFile?.capabilities?.delete ?? false),
		},
	};
}

function decodeSharedFileId(fileId) {
	if (!fileId?.startsWith('shared:')) return null;
	const [, accountId, encodedRemoteFileId] = fileId.split(':');
	if (!accountId || !encodedRemoteFileId) return null;
	return {
		accountId,
		remoteFileId: Buffer.from(encodedRemoteFileId, 'base64url').toString('utf8'),
	};
}

async function getSharedFileContext(userId, fileId) {
	const parsed = decodeSharedFileId(fileId);
	if (!parsed) {
		return { file: null, account: null, adapter: null };
	}

	const account = getAccountById(userId, parsed.accountId);
	if (!account) {
		return { file: null, account: null, adapter: null };
	}

	const adapter = createAdapter(account);
	const sharedItems = await adapter.listSharedWithMe();
	let file = sharedItems.find((item) => item.remote_file_id === parsed.remoteFileId);
	if (!file) {
		try {
			const details = await adapter.getFileDetails({ remote_file_id: parsed.remoteFileId });
			if (details?.remote_file_id) {
				file = {
					file_name: details.file_name || details.name,
					is_folder: Boolean(details.is_folder),
					is_starred: 0,
					size: Number(details.size || 0),
					mime_type: details.mime_type || details.mimeType || null,
					remote_file_id: details.remote_file_id,
					remote_parent_id: details.remote_parent_id || null,
					remote_drive_id: details.remote_drive_id || null,
					createdTime: details.createdTime || null,
					modifiedTime: details.modifiedTime || null,
					owner_name: details.owner_name || null,
					owner_email: details.owner_email || account.email,
				};
			}
		} catch {
			file = null;
		}
	}
	if (!file) {
		return { file: null, account, adapter };
	}

	return {
		file: {
			...file,
			id: fileId,
			cloud_account_id: account.id,
			provider: account.provider,
			email: file.owner_email || account.email,
			capabilities: {
				starred: Boolean(file.capabilities?.starred ?? account.provider === 'google_drive'),
				rename: Boolean(file.capabilities?.rename ?? false),
				delete: Boolean(file.capabilities?.delete ?? false),
			},
		},
		account,
		adapter,
	};
}

async function getFileContext(userId, fileId) {
	const file = getFileById(userId, fileId);
	if (!file) {
		return getSharedFileContext(userId, fileId);
	}

	const account = getAccountById(userId, file.cloud_account_id);
	if (!account) {
		return { file, account: null, adapter: null };
	}

	return {
		file,
		account,
		adapter: createAdapter(account),
	};
}

function ensureFileContext(context, res) {
	if (!context.file) {
		res.status(404).json({ error: 'File not found' });
		return false;
	}

	if (!context.account || context.account.status !== 'active' || !context.adapter) {
		res.status(409).json({ error: 'The file account is no longer connected' });
		return false;
	}

	return true;
}

async function deleteContextFile(userId, context, options = {}) {
	const { adjustUsage = true } = options;
	await context.adapter.deleteFile(context.file);

	// Surgically remove the item (and any descendants for folders) from the
	// local mirror instead of triggering a full account re-walk. Shared items
	// are not mirrored locally, so this no-ops for them.
	const { deletedSize, cloudAccountId } = deleteFileMetadataById(userId, context.file.id);

	if (adjustUsage && cloudAccountId && deletedSize) {
		adjustAccountUsage(userId, cloudAccountId, -deletedSize);
	}

	return { deletedSize, cloudAccountId };
}

async function listSharedWithMeFiles(userId) {
	const accounts = getActiveAccounts(userId);
	const settled = await Promise.allSettled(accounts.map(async (account) => {
		const adapter = createAdapter(account);
		const items = await adapter.listSharedWithMe();

		const localByRemoteId = getLocalFilesByRemoteId(userId, account.id);
		return items
			.map((item) => mapSharedItem(userId, account, item, localByRemoteId.get(item.remote_file_id) || null))
			.filter((item) => Boolean(item.remote_file_id));
	}));

	const seenIds = new Set();
	return settled
		.filter((result) => result.status === 'fulfilled')
		.flatMap((result) => result.value)
		.filter((item) => Boolean(item.remote_file_id))
		.filter((item) => {
			if (seenIds.has(item.id)) return false;
			seenIds.add(item.id);
			return true;
		})
		.sort((left, right) => {
			const leftTime = new Date(left.modifiedTime || left.createdTime || 0).getTime();
			const rightTime = new Date(right.modifiedTime || right.createdTime || 0).getTime();
			if (leftTime !== rightTime) return rightTime - leftTime;
			return (left.file_name || '').localeCompare(right.file_name || '', 'id');
		});
}

router.get('/files', async (req, res, next) => {
	try {
		const files = req.query.starred === '1'
			? listStarredFiles(req.user.id)
			: req.query.recent === '1'
				? listRecentFiles(req.user.id)
				: req.query.shared === '1'
					? await listSharedWithMeFiles(req.user.id)
					: listFilesByPath(req.user.id, req.query.path || '/');
		res.json({ data: files });
	} catch (error) {
		next(error);
	}
});

router.get('/files/:id/shared-children', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		if (!context.file.is_folder) {
			return res.status(400).json({ error: 'Only folders can be opened' });
		}

		const items = await context.adapter.listSharedFolderChildren(context.file);
		const localByRemoteId = getLocalFilesByRemoteId(req.user.id, context.account.id);
		return res.json({
			data: items.map((item) => mapSharedItem(req.user.id, context.account, item, localByRemoteId.get(item.remote_file_id) || null)).filter((item) => Boolean(item.remote_file_id)),
		});
	} catch (error) {
		next(error);
	}
});

router.patch('/files/:id/star', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		const isStarred = Boolean(req.body?.is_starred ?? req.body?.isStarred ?? true);
		const supportsStarred = Boolean(context.adapter.getCapabilities?.().starred);

		if (supportsStarred) {
			await context.adapter.setFileStarred(context.file, isStarred);
			// The provider is the source of truth for starred state, but a single
			// flag flip does not warrant a full account re-walk: update the local
			// mirror directly. Shared items have no local row, so this no-ops.
			if (!decodeSharedFileId(context.file.id)) {
				updateFileStarredByRemoteId(req.user.id, context.account.id, context.file.remote_file_id, isStarred);
			}
		} else {
			setFileStarred(req.user.id, context.file.id, isStarred);
		}
		return res.json({ data: { success: true, is_starred: isStarred, provider_sync: supportsStarred } });
	} catch (error) {
		next(error);
	}
});

router.post('/files/bulk/delete', async (req, res, next) => {
	try {
		const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.filter(Boolean))] : [];
		if (!ids.length) {
			return res.status(400).json({ error: 'At least one file id is required' });
		}

		const contexts = await Promise.all(ids.map(async (id) => ({ id, ...await getFileContext(req.user.id, id) })));
		const invalid = contexts.find((context) => !context.file || !context.account || context.account.status !== 'active' || !context.adapter);
		if (invalid) {
			return res.status(invalid.file ? 409 : 404).json({ error: invalid.file ? 'One or more file accounts are no longer connected' : 'One or more files were not found' });
		}

		for (const context of contexts) {
			await deleteContextFile(req.user.id, context);
		}

		return res.json({ data: { success: true, count: contexts.length } });
	} catch (error) {
		next(error);
	}
});

router.get('/files/:id', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		const details = await context.adapter.getFileDetails(context.file);
		return res.json({
			data: {
				...context.file,
				...details,
			},
		});
	} catch (error) {
		next(error);
	}
});

router.get('/files/:id/download', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}
		const stream = await context.adapter.getDownloadStream(context.file);

		res.setHeader('Content-Disposition', contentDispositionHeader('attachment', context.file.file_name));
		res.setHeader('Content-Type', context.file.mime_type || 'application/octet-stream');
		if (!context.file.is_folder && context.file.size) {
			res.setHeader('Content-Length', String(context.file.size));
		}
		pipeDownloadStream(stream, res, next);
	} catch (error) {
		next(error);
	}
});

router.get('/files/:id/preview', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		if (context.file.is_folder) {
			return res.status(400).json({ error: 'Folder preview is not supported' });
		}

		const mimeType = context.file.mime_type || 'application/octet-stream';
		const isPreviewable = /^(image|video|audio|text)\//.test(mimeType)
			|| mimeType === 'application/pdf'
			|| mimeType === 'application/json';

		if (!isPreviewable) {
			return res.status(415).json({ error: 'Preview is not supported for this file type' });
		}

		const stream = await context.adapter.getDownloadStream(context.file);

		res.setHeader('Content-Disposition', contentDispositionHeader('inline', context.file.file_name));
		res.setHeader('Content-Type', mimeType);
		if (context.file.size) {
			res.setHeader('Content-Length', String(context.file.size));
		}

		pipeDownloadStream(stream, res, next);
	} catch (error) {
		next(error);
	}
});

router.patch('/files/:id/rename', async (req, res, next) => {
	try {
		const { name } = req.body;
		if (!name?.trim()) {
			return res.status(400).json({ error: 'New name is required' });
		}

		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		await context.adapter.renameFile(context.file, name.trim());
		// Rename in the local mirror in place (and remap descendant paths for
		// folders) rather than re-walking the entire provider account.
		renameFileMetadata(req.user.id, context.file.id, name.trim());

		return res.json({ data: { success: true } });
	} catch (error) {
		next(error);
	}
});

router.delete('/files/:id', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		await deleteContextFile(req.user.id, context);

		return res.json({ data: { success: true } });
	} catch (error) {
		next(error);
	}
});

router.post('/files/folders', async (req, res, next) => {
	try {
		const { name, virtual_path = '/' } = req.body;

		if (!name?.trim()) {
			return res.status(400).json({ error: 'Folder name is required' });
		}

		const { selected } = selectBestAccount(req.user.id, 0);
		const account = getAccountById(req.user.id, selected.id);
		const adapter = createAdapter(account);

		const created = await adapter.createFolder({
			name: name.trim(),
			virtualPath: virtual_path,
		});

		// Mirror just the new folder instead of re-walking the whole account.
		if (created?.remoteFileId) {
			upsertFileByRemoteId({
				user_id: req.user.id,
				virtual_path: virtual_path,
				file_name: created.fileName || name.trim(),
				is_folder: true,
				size: 0,
				mime_type: null,
				cloud_account_id: account.id,
				remote_file_id: created.remoteFileId,
				remote_parent_id: created.remoteParentId,
				remote_created_time: new Date().toISOString(),
				remote_modified_time: new Date().toISOString(),
			});
		} else {
			// Adapter could not report a stable remote id; fall back to a full
			// resync so the folder still appears.
			await syncAccount(req.user.id, account);
		}

		return res.status(201).json({ data: { success: true } });
	} catch (error) {
		next(error);
	}
});

export default router;
