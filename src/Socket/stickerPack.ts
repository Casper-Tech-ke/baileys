import { Boom } from '@hapi/boom'
import crypto from 'crypto'
import fs from 'fs/promises'
import { proto } from '../../WAProto/index.js'
import type { StickerPack, StickerPackResult, WAMediaUpload, WAMediaUploadFunction } from '../Types/index.js'
import { encryptedStream, generateWAMessageFromContent, getStream, unixTimestampSeconds } from '../Utils/index.js'
import type { ILogger } from '../Utils/logger.js'
import { createZip } from '../Utils/zip.js'

export type StickerPackDeps = {
	relayMessage: (jid: string, message: proto.IMessage, opts: { messageId: string }) => Promise<unknown>
	upload: WAMediaUploadFunction
	userJid?: string
	logger?: ILogger
}

/** WhatsApp caps a pack at 60 stickers. */
const MAX_STICKERS = 60

const STICKER_PACK_ORIGIN = {
	FIRST_PARTY: 0,
	THIRD_PARTY: 1,
	USER_CREATED: 2
} as const

const readMedia = async (media: WAMediaUpload): Promise<Buffer> => {
	const { stream } = await getStream(media)
	const chunks: Buffer[] = []
	for await (const chunk of stream) {
		chunks.push(chunk as Buffer)
	}

	return Buffer.concat(chunks)
}

const uploadEncrypted = async (
	data: Buffer,
	mediaType: 'sticker-pack' | 'thumbnail-sticker-pack',
	mediaKey: Buffer | undefined,
	deps: Pick<StickerPackDeps, 'upload' | 'logger'>
) => {
	const {
		mediaKey: key,
		encFilePath,
		fileEncSha256,
		fileSha256,
		fileLength
	} = await encryptedStream(data, mediaType, {
		logger: deps.logger,
		mediaKey
	})

	try {
		const { directPath } = await deps.upload(encFilePath, {
			fileEncSha256B64: fileEncSha256.toString('base64'),
			mediaType
		})
		return { mediaKey: key, fileEncSha256, fileSha256, fileLength, directPath }
	} finally {
		await fs.unlink(encFilePath).catch(() => {})
	}
}

/**
 * Send a sticker pack — a ZIP of up to 60 WebP stickers plus a tray icon,
 * delivered as a `stickerPackMessage` the receiver can add to their sticker
 * collection.
 *
 * Wire shape, recovered from the official app's `FMessageStickerPack`
 * builder: the pack ZIP is uploaded as media type `sticker-pack`
 * (HKDF info "WhatsApp Sticker Pack Keys"), the tray icon is uploaded as
 * `thumbnail-sticker-pack` ("WhatsApp Sticker Pack Thumbnail Keys") and is
 * encrypted under the pack's own mediaKey — the proto carries no separate
 * mediaKey for it, so the receiver derives it from the pack's key. The
 * message carries the pack id, name, publisher, description, the per-sticker
 * metadata (file name in the ZIP, emojis, animated/lottie flags) and the
 * thumbnail's direct path + hashes; the tray icon is also inside the ZIP
 * under `trayIconFileName`.
 */
export const sendStickerPack = async (
	jid: string,
	pack: StickerPack,
	deps: StickerPackDeps
): Promise<StickerPackResult> => {
	const { relayMessage, userJid, logger } = deps

	if (!pack.name || !pack.publisher) {
		throw new Boom('sticker pack needs a name and a publisher', { statusCode: 400 })
	}

	if (!pack.stickers?.length || pack.stickers.length > MAX_STICKERS) {
		throw new Boom(`sticker pack needs 1-${MAX_STICKERS} stickers`, { statusCode: 400 })
	}

	if (!pack.trayIcon) {
		throw new Boom('sticker pack needs a tray icon', { statusCode: 400 })
	}

	const stickerPackId = pack.stickerPackId || crypto.randomUUID()
	const trayIconFileName = pack.trayIconFileName || 'tray.png'

	logger?.debug({ stickerPackId, count: pack.stickers.length }, 'building sticker pack')

	// read every sticker + the tray icon into memory, then zip them
	const stickerData = await Promise.all(pack.stickers.map(s => readMedia(s.data)))
	const trayIconData = await readMedia(pack.trayIcon)

	const zip = createZip([
		...pack.stickers.map((sticker, i) => ({
			name: sticker.fileName || `sticker-${i}.webp`,
			data: stickerData[i]!
		})),
		{ name: trayIconFileName, data: trayIconData }
	])

	// upload the pack ZIP, then the tray icon (encrypted under the pack key)
	const packUpload = await uploadEncrypted(zip, 'sticker-pack', undefined, deps)
	const iconUpload = await uploadEncrypted(trayIconData, 'thumbnail-sticker-pack', packUpload.mediaKey, deps)

	const messageSecret = crypto.randomBytes(32)

	const wrapped = generateWAMessageFromContent(
		jid,
		{
			messageContextInfo: { messageSecret },
			stickerPackMessage: {
				stickerPackId,
				name: pack.name,
				publisher: pack.publisher,
				packDescription: pack.description,
				stickers: pack.stickers.map((sticker, i) => ({
					fileName: sticker.fileName || `sticker-${i}.webp`,
					isAnimated: !!sticker.isAnimated,
					emojis: sticker.emojis || [],
					accessibilityLabel: sticker.accessibilityLabel || '',
					isLottie: !!sticker.isLottie,
					mimetype: sticker.mimetype || 'image/webp'
				})),
				fileLength: packUpload.fileLength,
				fileSha256: packUpload.fileSha256,
				fileEncSha256: packUpload.fileEncSha256,
				mediaKey: packUpload.mediaKey,
				directPath: packUpload.directPath,
				mediaKeyTimestamp: unixTimestampSeconds(),
				trayIconFileName,
				// the app hardcodes the thumbnail at 252x252
				thumbnailDirectPath: iconUpload.directPath,
				thumbnailSha256: iconUpload.fileSha256,
				thumbnailEncSha256: iconUpload.fileEncSha256,
				thumbnailHeight: 252,
				thumbnailWidth: 252,
				stickerPackSize: zip.length,
				stickerPackOrigin: STICKER_PACK_ORIGIN[pack.origin || 'THIRD_PARTY'],
				caption: pack.caption
			}
		},
		{ userJid } as any
	)

	await relayMessage(jid, wrapped.message!, { messageId: wrapped.key.id! })

	return { message: wrapped, stickerPackId }
}
