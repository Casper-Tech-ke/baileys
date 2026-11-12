import { proto } from '../../WAProto/index.js'
import type { ChannelStatus } from '../Types/ChannelStatus.js'
import type { AnyMessageContent } from '../Types/index.js'
import type { MediaGenerationOptions, WAMediaUploadFunction } from '../Types/Message.js'
import { generateMessageIDV2 } from '../Utils/generics.js'
import { generateWAMessageContent } from '../Utils/index.js'
import { type BinaryNode, getBinaryNodeChild } from '../WABinary/index.js'

export type ChannelStatusOptions = Pick<MediaGenerationOptions, 'backgroundColor' | 'font'>

export type ChannelStatusDeps = {
	sendNode: (node: BinaryNode) => Promise<unknown>
	waUploadToServer: WAMediaUploadFunction
	userJid?: string
}

/** What sendChannelStatus returns: the stanza id and the message that went out. */
export type ChannelStatusSent = {
	id: string
	channelJid: string
	message: proto.IMessage
}

/**
 * Decode a channel status from its incoming `<status>` stanza.
 *
 * Wire shape, captured live 2026-11-09 from Techword 401
 * (120363331321673219@newsletter):
 *
 *   <status from="120363331321673219@newsletter" type="text"
 *           id="3EB079CA1FB41899DF027B" t="1794223368" server_id="136">
 *     <plaintext>proto.Message bytes</plaintext>
 *   </status>
 *
 * The plaintext payload is a standard proto.Message — a text status is an
 * extendedTextMessage (field 6) whose field 1 is the text, field 8 the
 * backgroundArgb and field 9 the font; field 35 is messageContextInfo.
 * Non-newsletter `<status>` stanzas are ignored here: Baileys already
 * handles personal statuses through the message stream.
 */
export const decodeChannelStatus = (node: BinaryNode): ChannelStatus | undefined => {
	const from = node.attrs.from
	if (!from?.endsWith('@newsletter')) {
		return undefined
	}

	const plaintextNode = getBinaryNodeChild(node, 'plaintext')
	if (!plaintextNode?.content) {
		return undefined
	}

	const contentBuf =
		typeof plaintextNode.content === 'string'
			? Buffer.from(plaintextNode.content, 'binary')
			: Buffer.from(plaintextNode.content as Uint8Array)

	let message: proto.IMessage
	try {
		// no toJSON(): it turns the font enum into its name ('SYSTEM' for 0)
		message = proto.Message.decode(contentBuf)
	} catch {
		return undefined
	}

	const extendedText = message.extendedTextMessage

	return {
		id: node.attrs.id || '',
		channelJid: from,
		type: node.attrs.type || 'text',
		serverId: node.attrs.server_id,
		messageTimestamp: +(node.attrs.t || 0),
		offline: !!node.attrs.offline,
		text: extendedText?.text || message.conversation || undefined,
		backgroundArgb: extendedText?.backgroundArgb ?? undefined,
		font: extendedText?.font ?? undefined,
		message
	}
}

/**
 * Post a channel status — the temporary (24h) update a channel admin posts
 * from the channel, shown in followers' Status tray. It is NOT a channel
 * message (that is sendMessage to the @newsletter JID) and NOT a personal
 * status (that is sendMessage to status@broadcast).
 *
 * Wire shape, proven live 2026-11-09: a top-level `<status>` stanza to the
 * channel JID, mirroring the ones received, with a `<plaintext>` child
 * holding the plain proto.Message bytes (same encoding as a newsletter
 * message). The server acks it (no error) when the sender is an admin or
 * owner of the channel, and answers error 401 when they are not — that is
 * what happened posting to Techword 401 from an account that is not its
 * admin. Accepts the same content shapes as sendMessage: { text } for a
 * text status, { image, caption } etc. for media. Options support
 * backgroundColor for text statuses and font for text.
 */
export const sendChannelStatus = async (
	jid: string,
	content: AnyMessageContent,
	deps: ChannelStatusDeps,
	options: ChannelStatusOptions = {}
): Promise<ChannelStatusSent> => {
	const { sendNode, waUploadToServer, userJid } = deps

	// generateWAMessageContent builds/uploads the inner message (handles
	// media upload, thumbnails, etc. same as a normal send)
	const inner = await generateWAMessageContent(content, { ...options, upload: waUploadToServer })

	const id = generateMessageIDV2(userJid)
	const bytes = proto.Message.encode(inner).finish()

	await sendNode({
		tag: 'status',
		attrs: {
			to: jid,
			id,
			type: 'text'
		},
		content: [{ tag: 'plaintext', attrs: {}, content: bytes }]
	})

	return { id, channelJid: jid, message: inner }
}
