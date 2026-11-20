import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type { ChannelStatus } from '../Types/ChannelStatus.js'
import type { AnyMessageContent } from '../Types/index.js'
import type { MediaGenerationOptions, WAMediaUploadFunction } from '../Types/Message.js'
import { generateMessageIDV2 } from '../Utils/generics.js'
import { generateWAMessageContent } from '../Utils/index.js'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildren } from '../WABinary/index.js'

export type ChannelStatusContent = AnyMessageContent & {
	/** Post the status as a question (ContextInfo.isQuestion on the inner message). */
	question?: boolean
}

export type ChannelStatusOptions = Pick<MediaGenerationOptions, 'backgroundColor' | 'font'> & {
	/** Mark image/video content as AI-generated (imageSourceType / videoSourceType). Text and audio have no AI marker in the proto. */
	aiContent?: boolean
	/**
	 * Answer a status question instead of posting a new status.
	 * The content must be text (the answer); parentServerId is required.
	 */
	interactionType?: 'question_response'
	/** Server id of the question status being answered. */
	parentServerId?: string
}

export type ChannelStatusDeps = {
	sendNode: (node: BinaryNode) => Promise<unknown>
	waUploadToServer: WAMediaUploadFunction
	userJid?: string
}

/** Deps for the channel-status calls that ask the server something (react / revoke / fetch). */
export type ChannelStatusQueryDeps = {
	query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>
	generateMessageTag: () => string
}

/** What sendChannelStatus returns: the stanza id and the message that went out. */
export type ChannelStatusSent = {
	id: string
	channelJid: string
	message: proto.IMessage
}

/**
 * What newsletterSendStatus returns: everything sendChannelStatus returns,
 * plus the server-assigned id of the posted status — the id reactions,
 * revokes and fetches use. It comes from the server echo of the posted
 * status, so it is undefined when the echo does not arrive in time.
 */
export type NewsletterStatusSent = ChannelStatusSent & {
	newsletterStatusServerId?: string
}

/** Options for fetching a channel's published statuses. */
export type ChannelStatusFetchOptions = {
	/** how many statuses to fetch */
	count: number
	/** fetch statuses older than this server id */
	before?: string
	/** fetch statuses newer than this server id */
	after?: string
}

/** What newsletterFetchStatus returns: the parsed statuses plus the raw IQ result. */
export type ChannelStatusFetchResult = {
	statuses: ChannelStatus[]
	raw: BinaryNode
}

/** How long newsletterSendStatus waits for the server echo carrying the posted status's server id. */
export const CHANNEL_STATUS_ECHO_TIMEOUT_MS = 10_000

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
 * Set ContextInfo.isQuestion (proto field 63) on the inner message of a
 * built status. The flag lives on the inner message's contextInfo — not
 * on MessageContextInfo, which has no such field (an isQuestion set
 * there is dropped on encode). A view-once envelope is unwrapped first
 * so the flag lands on the real message, not the wrapper.
 */
const markQuestion = (message: proto.IMessage): void => {
	let target: proto.IMessage | null | undefined = message
	while (target && (target.viewOnceMessageV2 || target.viewOnceMessageV2Extension || target.viewOnceMessage)) {
		const wrapped: proto.Message.IFutureProofMessage | null | undefined =
			target.viewOnceMessageV2 || target.viewOnceMessageV2Extension || target.viewOnceMessage
		target = wrapped?.message
	}
	if (!target) {
		return
	}
	const type = Object.keys(target).find(key => key !== 'messageContextInfo' && key !== 'conversation')
	if (!type) {
		return
	}
	// The inner message is a plain object here (Message.create does not
	// convert nested objects into instances), so there is no 'contextInfo'
	// property to test for — set it directly. A type without a
	// contextInfo field ignores it on encode.
	const inner = (target as Record<string, unknown>)[type] as { contextInfo?: proto.IContextInfo } | undefined
	if (inner && typeof inner === 'object') {
		inner.contextInfo = { ...inner.contextInfo, isQuestion: true }
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
 *
 * Extras, same send path:
 * - `question: true` on the content posts the status as a question
 *   (ContextInfo.isQuestion, proto field 63, on the inner message's
 *   contextInfo — not on MessageContextInfo).
 * - `aiContent: true` marks image/video content as AI-generated
 *   (imageSourceType / videoSourceType); text and audio have no AI
 *   marker in the proto.
 * - `interactionType: 'question_response'` with `parentServerId` posts
 *   a statusQuestionAnswerMessage (proto field 105) answering the
 *   question status with that server id; the content must be the answer
 *   text. The key points at the question by its server id, as channel
 *   statuses are addressed by server id everywhere else.
 */
export const sendChannelStatus = async (
	jid: string,
	content: ChannelStatusContent,
	deps: ChannelStatusDeps,
	options: ChannelStatusOptions = {}
): Promise<ChannelStatusSent> => {
	const { sendNode, waUploadToServer, userJid } = deps

	let inner: proto.IMessage
	if (options.interactionType === 'question_response') {
		if (!options.parentServerId) {
			throw new Boom('parentServerId is required to answer a status question', { statusCode: 400 })
		}
		const answerText = 'text' in content ? content.text : undefined
		if (!answerText) {
			throw new Boom('a question_response status needs text content (the answer)', { statusCode: 400 })
		}
		inner = proto.Message.create({
			statusQuestionAnswerMessage: {
				key: { remoteJid: jid, id: options.parentServerId, fromMe: false },
				text: answerText
			}
		})
	} else {
		// generateWAMessageContent builds/uploads the inner message (handles
		// media upload, thumbnails, etc. same as a normal send)
		inner = await generateWAMessageContent(content, { ...options, upload: waUploadToServer })

		// A status posted as a question carries ContextInfo.isQuestion on
		// the inner message (proto field 63). generateWAMessageContent
		// does not set it, so it is merged in here — after the build, so
		// a contextInfo already on the message (mentions, reporting
		// token secret) is kept.
		if (content.question) {
			markQuestion(inner)
		}

		// AI-generated content is marked on the media itself. Text and audio
		// have no AI marker in the proto, so aiContent is a no-op for them.
		if (options.aiContent) {
			if (inner.imageMessage) {
				inner.imageMessage.imageSourceType = proto.Message.ImageMessage.ImageSourceType.AI_GENERATED
			} else if (inner.videoMessage) {
				inner.videoMessage.videoSourceType = proto.Message.VideoMessage.VideoSourceType.AI_GENERATED
			}
		}
	}

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

/**
 * React to a channel status, or remove the reaction with null.
 * `serverId` is the status's server-assigned id (from the status echo
 * after posting, or from newsletterFetchStatus).
 *
 * Same wire shape as reacting to a channel message — a `<message
 * type="reaction">` stanza to the channel JID with the status's server
 * id; the server routes by server_id within the newsletter. Removing a
 * reaction sends edit='7' with an empty reaction, exactly like
 * newsletterReactMessage does for messages.
 */
export const reactChannelStatus = async (
	jid: string,
	serverId: string,
	reaction: string | null,
	deps: ChannelStatusQueryDeps
): Promise<void> => {
	await deps.query({
		tag: 'message',
		attrs: {
			to: jid,
			...(reaction ? {} : { edit: '7' }),
			type: 'reaction',
			server_id: serverId,
			id: deps.generateMessageTag()
		},
		content: [
			{
				tag: 'reaction',
				attrs: reaction ? { code: reaction } : {}
			}
		]
	})
}

/**
 * Revoke (delete) one of the channel's own statuses, by server id.
 *
 * Wire shape: a newsletter IQ with a `<revoke server_id>` child — the
 * same IQ family as the status fetch (status_updates) and live_updates.
 * This shape could not be confirmed from the decompiled app (stanza tag
 * names are token-encoded there), so it needs a live check against a
 * real channel before it is trusted.
 */
export const revokeChannelStatus = async (
	jid: string,
	statusId: string,
	deps: ChannelStatusQueryDeps
): Promise<BinaryNode> => {
	return deps.query({
		tag: 'iq',
		attrs: {
			id: deps.generateMessageTag(),
			type: 'set',
			xmlns: 'newsletter',
			to: jid
		},
		content: [{ tag: 'revoke', attrs: { server_id: statusId } }]
	})
}

/**
 * Fetch the channel's published statuses, paginated by server id.
 * `before` fetches statuses older than that server id, `after` newer
 * ones.
 *
 * Wire shape, from the app: an IQ to the channel with a `<status_updates>`
 * child carrying count and the before/after cursors (the app also sends
 * a `since` timestamp there; this API pages by server id instead).
 * The result carries the statuses as `<status>` children of
 * `<status_updates>`, in the same shape as the live `<status>` stanzas
 * decodeChannelStatus reads. A fetched status node may not carry a
 * `from` attr (the IQ is already addressed to the channel), so the
 * channel JID is filled in for the decoder.
 */
export const fetchChannelStatuses = async (
	jid: string,
	options: ChannelStatusFetchOptions,
	deps: ChannelStatusQueryDeps
): Promise<ChannelStatusFetchResult> => {
	const attrs: Record<string, string> = { count: options.count.toString() }
	if (options.before) {
		attrs.before = options.before
	}
	if (options.after) {
		attrs.after = options.after
	}

	const raw = await deps.query({
		tag: 'iq',
		attrs: {
			id: deps.generateMessageTag(),
			type: 'get',
			xmlns: 'newsletter',
			to: jid
		},
		content: [{ tag: 'status_updates', attrs }]
	})

	const updatesNode = getBinaryNodeChild(raw, 'status_updates') ?? raw
	const statuses = getBinaryNodeChildren(updatesNode, 'status')
		.map(node =>
			decodeChannelStatus({
				...node,
				attrs: { ...node.attrs, from: node.attrs.from || jid }
			})
		)
		.filter((status): status is ChannelStatus => !!status)

	return { statuses, raw }
}
