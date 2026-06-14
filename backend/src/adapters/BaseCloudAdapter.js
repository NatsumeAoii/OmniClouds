import { Transform } from 'stream';

export class BaseCloudAdapter {
	constructor(account) {
		this.account = account;
	}

	getCapabilities() {
		return {
			starred: false,
			rename: true,
			delete: true,
		};
	}

	async fetchStructure() {
		return [];
	}

	async getStorageSummary() {
		return {
			totalSpace: Number(this.account.total_space || 0),
			usedSpace: Number(this.account.used_space || 0),
		};
	}

	createProgressStream(onProgress) {
		let bytes = 0;

		return new Transform({
			transform(chunk, _encoding, callback) {
				bytes += chunk.length;
				onProgress(bytes);
				callback(null, chunk);
			},
		});
	}

	async uploadStream() {
		throw new Error(`Upload is not implemented for provider ${this.account.provider}`);
	}

	async createFolder() {
		throw new Error(`Create folder is not implemented for provider ${this.account.provider}`);
	}

	async getDownloadStream() {
		throw new Error(`Download is not implemented for provider ${this.account.provider}`);
	}

	async renameFile() {
		throw new Error(`Rename is not supported for provider ${this.account.provider}`);
	}

	async deleteFile() {
		throw new Error(`Delete is not supported for provider ${this.account.provider}`);
	}

	async getFileDetails(fileRecord) {
		return {
			name: fileRecord.file_name,
			mime_type: fileRecord.mime_type,
			size: fileRecord.size,
			virtual_path: fileRecord.virtual_path,
			remote_file_id: fileRecord.remote_file_id,
			provider: this.account.provider,
			owner_email: this.account.email,
			createdTime: fileRecord.remote_created_time,
			modifiedTime: fileRecord.remote_modified_time,
		};
	}

	async getDeltaChanges() {
		return [];
	}

	async listSharedWithMe() {
		return [];
	}

	async listSharedFolderChildren() {
		return [];
	}

	async setFileStarred() {
		throw new Error(`Starred state is not supported for provider ${this.account.provider}`);
	}
}
