import crypto from 'crypto'
import { proto } from '../../WAProto/index.js'
import { generateWAMessageContent, generateWAMessageFromContent } from '../Utils/index.js'
import { getUrlInfo } from '../Utils/link-preview.js'
import type { AnyMessageContent, WAMessage } from '../Types/index.js'
import type { MediaGenerationOptions, WAMediaUploadFunction } from '../Types/Message.js'
import type { SocketConfig } from '../Types/Socket.js'
import type { ILogger } from '../Utils/logger.js'

export type GroupStatusOptions = Pick<MediaGenerationOptions, 'backgroundColor' | 'font'>

export type GroupStatusDeps = {
	relayMessage: (jid: string, message: proto.IMessage, opts: { messageId: string }) => Promise<unknown>
	waUploadToServer: WAMediaUploadFunction
	userJid?: string
	// Link-preview config, same values sendMessage uses (SocketConfig).
	linkPreviewImageThumbnailWidth?: number
	generateHighQualityLinkPreview?: boolean
	httpRequestOptions?: SocketConfig['options']
	logger?: ILogger
}

/**
 * Post a "Group Status" update — a status/story visible only within a single
 * group (proto field: groupStatusMessageV2), distinct from the regular
 * status@broadcast story that goes to your contact list.
 *
 * Accepts the same content shapes as sendMessage: { text }, { image, caption },
 * { video, caption, gifPlayback }, { audio, ptt, mimetype }, { sticker }, etc.
 * Options support backgroundColor for text/voice statuses and font for text.
 */
export const sendGroupStatus = async (
	jid: string,
	content: AnyMessageContent,
	deps: GroupStatusDeps,
	options: GroupStatusOptions = {}
): Promise<WAMessage> => {
	const {
		relayMessage,
		waUploadToServer,
		userJid,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		httpRequestOptions,
		logger
	} = deps

	// generateWAMessageContent builds/uploads the inner message (handles
	// media upload, thumbnails, waveform, etc. same as a normal send).
	// getUrlInfo is wired in exactly like sendMessage does, so a text
	// group status containing a URL gets the same link preview card
	// (title / description / thumbnail) a regular message would.
	const inner = await generateWAMessageContent(content, {
		...options,
		upload: waUploadToServer,
		getUrlInfo: text =>
			getUrlInfo(text, {
				thumbnailWidth: linkPreviewImageThumbnailWidth ?? 192,
				fetchOpts: {
					timeout: 3_000,
					...(httpRequestOptions || {})
				},
				logger,
				uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
			})
	})

	const messageSecret = crypto.randomBytes(32)

	const wrapped = generateWAMessageFromContent(
		jid,
		{
			messageContextInfo: { messageSecret },
			groupStatusMessageV2: {
				message: {
					...inner,
					messageContextInfo: { messageSecret }
				}
			}
		},
		{ userJid } as any
	)

	await relayMessage(jid, wrapped.message!, { messageId: wrapped.key.id! })

	return wrapped
}
