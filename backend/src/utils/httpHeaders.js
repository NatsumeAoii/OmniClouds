/**
 * Helpers for building HTTP response headers that must safely carry
 * provider-supplied, user-controlled values (e.g. file names from a cloud
 * account). Header values in Node may only contain latin1 characters and must
 * not contain control characters or a stray quote/backslash, otherwise
 * res.setHeader throws ERR_INVALID_CHAR. Cloud file names routinely contain
 * non-latin1 characters (CJK, Cyrillic, emoji) and quotes, so the raw name can
 * never be interpolated directly into a header.
 */

// Strip characters that would either corrupt the header or be rejected by Node:
// control chars, CR/LF (header injection), quotes and backslashes (which break
// the quoted-string form of the filename parameter).
function toAsciiFallback(fileName) {
	const cleaned = String(fileName || '')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f-\uffff]/g, '_')
		.replace(/["\\]/g, '_')
		.trim();
	return cleaned || 'download';
}

/**
 * Build an RFC 6266 / RFC 5987 compliant Content-Disposition header value.
 *
 * Produces a latin1-safe ASCII `filename="..."` for legacy/simple clients and,
 * when the original name contains characters outside that set, additionally
 * emits `filename*=UTF-8''<percent-encoded>` so modern clients recover the
 * exact original name. ASCII-only names yield the same simple header as before,
 * preserving existing behavior for the common case.
 *
 * @param {'attachment'|'inline'} disposition
 * @param {string} fileName
 * @returns {string}
 */
export function contentDispositionHeader(disposition, fileName) {
	const type = disposition === 'inline' ? 'inline' : 'attachment';
	const original = String(fileName || '');
	const asciiName = toAsciiFallback(original);

	const header = `${type}; filename="${asciiName}"`;

	// Only add the extended form when the original differs from the ASCII
	// fallback (i.e. it contained characters that needed sanitizing).
	if (original && original !== asciiName) {
		const encoded = encodeURIComponent(original).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
		return `${header}; filename*=UTF-8''${encoded}`;
	}

	return header;
}
