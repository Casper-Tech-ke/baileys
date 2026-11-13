import { promises as fs } from 'fs'
import { proto } from '../../WAProto/index.js'
import type { WAMessage } from '../Types/index.js'
import type { WAMediaUploadFunction } from '../Types/Message.js'
import { encryptedStream, generateWAMessageFromContent, unixTimestampSeconds } from '../Utils/index.js'
import { encodeGroupHistoryBundle, GROUP_HISTORY_BUNDLE_MIMETYPE } from '../Utils/group-history.js'
import type { ILogger } from '../Utils/logger.js'

export type GroupHistoryDeps = {
	relayMessage: (jid: string, message: proto.IMessage, opts: { messageId: string }) => Promise<unknown>
	waUploadToServer: WAMediaUploadFunction
	userJid?: string
	logger?: ILogger
}

export type SendGroupHistoryOptions = {
	/** Timestamp (seconds) of the oldest message in the bundle. Defaults to the oldest message's own timestamp. */
	oldestMessageTimestamp?: number
	/** Upload timeout in ms. */
	mediaUploadTimeoutMs?: number
}

export type SendGroupHistoryResult = {
	bundle: WAMessage
	notice: WAMessage
	messageCount: number
}

/**
 * Share a group's recent message history with new members — the native
 * `messageHistoryBundle` flow WhatsApp's own client uses when an admin adds
 * someone (last 25–100 messages, E2EE).
 *
 * Builds the encrypted bundle file (Ft1 protobuf of the given messages),
 * uploads it as document media, sends the `messageHistoryBundle` message
 * into the group, then the `messageHistoryNotice` record. The receivers'
 * clients download, decrypt and import the bundle.
 *
 * NOTE: a standalone `messageHistoryNotice` without the bundle is dropped
 * by the server — the bundle file is the actual history.
 */
export const sendGroupHistory = async (
	jid: string,
	receivers: string[],
	messages: proto.IWebMessageInfo[],
	deps: GroupHistoryDeps,
	options: SendGroupHistoryOptions = {}
): Promise<SendGroupHistoryResult> => {
	const { relayMessage, waUploadToServer, userJid, logger } = deps

	if (!messages.length) {
		throw new Error('sendGroupHistory: no messages to share')
	}
	if (!receivers.length) {
		throw new Error('sendGroupHistory: no receivers')
	}

	// 1. Build the bundle file (Ft1 protobuf)
	const bundleBytes = encodeGroupHistoryBundle(messages)
	logger?.debug({ bytes: bundleBytes.length, count: messages.length }, 'built group history bundle')

	// 2. Encrypt it like document media
	const { mediaKey, encFilePath, fileEncSha256, fileSha256 } = await encryptedStream(bundleBytes, 'document', {
		logger
	})

	// 3. Upload the encrypted file
	const fileEncSha256B64 = fileEncSha256.toString('base64')
	let directPath: string
	try {
		const uploaded = await waUploadToServer(encFilePath, {
			fileEncSha256B64,
			mediaType: 'document',
			timeoutMs: options.mediaUploadTimeoutMs
		})
		directPath = uploaded.directPath
	} finally {
		try {
			await fs.unlink(encFilePath)
		} catch {
			// already gone
		}
	}

	// 4. Metadata: who gets it, how far back it goes, how many messages
	const timestamps = messages
		.map(m => (typeof m.messageTimestamp === 'number' ? m.messageTimestamp : Number(m.messageTimestamp || 0)))
		.filter(t => t > 0)
	const oldestMessageTimestamp =
		options.oldestMessageTimestamp ?? (timestamps.length ? Math.min(...timestamps) : unixTimestampSeconds())
	const metadata: proto.Message.IMessageHistoryMetadata = {
		historyReceivers: receivers,
		oldestMessageTimestamp,
		messageCount: messages.length
	}
	const mediaKeyTimestamp = unixTimestampSeconds()

	// 5. Send the bundle message into the group
	const bundleMsg = generateWAMessageFromContent(
		jid,
		{
			messageHistoryBundle: {
				mimetype: GROUP_HISTORY_BUNDLE_MIMETYPE,
				fileSha256,
				mediaKey,
				fileEncSha256,
				directPath,
				mediaKeyTimestamp,
				messageHistoryMetadata: metadata
			}
		},
		{ userJid } as any
	)
	await relayMessage(jid, bundleMsg.message!, { messageId: bundleMsg.key.id! })
	logger?.debug({ id: bundleMsg.key.id }, 'sent group history bundle')

	// 6. Send the notice record (same metadata)
	const noticeMsg = generateWAMessageFromContent(
		jid,
		{
			messageHistoryNotice: {
				messageHistoryMetadata: metadata
			}
		},
		{ userJid } as any
	)
	await relayMessage(jid, noticeMsg.message!, { messageId: noticeMsg.key.id! })
	logger?.debug({ id: noticeMsg.key.id }, 'sent group history notice')

	return { bundle: bundleMsg, notice: noticeMsg, messageCount: messages.length }
}
