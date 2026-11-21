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

/**
 * Fetch the answers people gave to a channel status question, or the
 * responses to a channel status.
 *
 * Two jobs in the app do this, both building the same IQ and differing
 * only in the `<question_responses>` child:
 *
 * - GetNewsletterQuestionResponsesJob (answers to a QUESTION status):
 *   `J9G $t=8` builds an IQ `xmlns="newsletter" type="get"` to the
 *   channel with a `<question_responses server_id="<question server id>"
 *   count="<count>">` child. Optional children, in order, are themselves
 *   `<question_responses>` nodes (that nesting is what the app sends):
 *   `<question_responses before="<beforeResponseServerId>"/>` for the
 *   next page (C1941J8e(str, 22)), `<question_responses><filters>
 *   <contacts|replied|starred/></filters></question_responses>` for a
 *   filter (C1946J8j: ordinal 0 = contacts, 1 = replied, 2 = starred),
 *   and `<question_responses><search text="<query>"/></question_responses>`
 *   for a text search (C1941J8e default case). The job hardcodes
 *   count = 30, rejects questionServerId < 0, and `server_id` is only
 *   written when 99 <= id <= 2147476647 (IHO.A0S); count is only written
 *   when 1 <= count <= 1000.
 * - GetNewsletterStatusResponsesJob (responses to a STATUS):
 *   `J9G $t=10` is the same IQ but the child carries `type="status"`
 *   and has no search child (only before + filter). The job rejects
 *   questionStatusServerId outside 99 <= id < 2147476648 and count
 *   outside 1..300 (J9G.A02).
 *
 * The result (parsed by J9S for questions, J9T for statuses) is the IQ
 * result with a `<question_responses server_id="..." [type="status"]>`
 * child holding 0..N `<question_response>` children (J9T caps the list
 * at 300). Each item (KG6.A0R + A0Q + A0C + A0H) is:
 *
 *   <question_response>
 *     <sender lid="<responder LID>" notify_name="<name>">
 *       <picture direct_path="..."/>
 *     </sender>
 *     <message id="<stanza id>" t="<unix secs>" type="text" [is_sender="true"]>
 *       <plaintext>proto.Message bytes</plaintext>
 *       <meta questiontype="response" response_server_id="<answer server id>"/>
 *     </message>
 *     [<flags> replied / starred markers </flags>]
 *     [<reactions><reaction code="..."/></reactions>]
 *   </question_response>
 *
 * The `<message>` is the same shape as a status stanza: `<plaintext>`
 * holds the plain proto.Message (a text answer is an
 * extendedTextMessage). `response_server_id` is the answer's own server
 * id — pass the last response's id as `before` for the next page.
 * The `replied`/`starred` flag encoding inside `<flags>` could not be
 * pinned down from the decompiled parser (child vs attr), so both are
 * accepted; a live check should confirm which one the server sends.
 */

/** Filter for fetching status responses (C1946J8j: 0 = contacts, 1 = replied, 2 = starred). */
export type ChannelStatusResponseFilter = 'contacts' | 'replied' | 'starred'

/**
 * Which responses to fetch. 'question' fetches the answers to a question
 * status (no `type` attr, search allowed); 'status' fetches responses to
 * a status (`type="status"` on the child, no search).
 */
export type ChannelStatusResponsesKind = 'question' | 'status'

/** Options for fetching channel status responses. */
export type ChannelStatusResponsesOptions = {
	/** how many responses to fetch; defaults to 30, the app's hardcoded question count */
	count?: number
	/** fetch responses older than this response server id (the `before` cursor) */
	before?: string
	/** only responses from contacts / that were replied to / that were starred */
	filter?: ChannelStatusResponseFilter
	/** free-text search over the answers; question kind only (the status job has no search) */
	searchQuery?: string
	/** 'question' (default) or 'status' */
	kind?: ChannelStatusResponsesKind
}

/** One answer/response to a channel status, decoded from a `<question_response>` node. */
export type ChannelStatusResponse = {
	/** stanza id of the answer message (`<message id>`) */
	id: string
	/** the answer's own server id (`<meta response_server_id>`); the `before` cursor for the next page */
	responseServerId?: string
	/** responder's LID (`<sender lid>`) */
	senderLid?: string
	/** responder's display name (`<sender notify_name>`) */
	senderNotifyName?: string
	/** responder's profile picture path (`<sender><picture direct_path>`) */
	senderPictureDirectPath?: string
	/** unix timestamp (seconds) from the answer `<message t>` */
	messageTimestamp: number
	/** true when the answer is our own (`<message is_sender="true">`) */
	fromMe: boolean
	/** `<meta questiontype>`; the app requires this to be 'response' */
	questionType?: string
	/** text of a text answer, from extendedTextMessage.text (or conversation) */
	text?: string
	/** the full decoded proto.Message, for media / other answer kinds */
	message?: proto.IMessage
	/** the answer was replied to (from the `<flags>` child) */
	replied: boolean
	/** the answer was starred (from the `<flags>` child) */
	starred: boolean
	/** reaction code on the answer, if any (`<reactions><reaction code>`) */
	reaction?: string
	/** the raw `<question_response>` node */
	raw: BinaryNode
}

/** What fetchChannelStatusResponses returns: the parsed answers plus the raw IQ result. */
export type ChannelStatusResponsesResult = {
	responses: ChannelStatusResponse[]
	/** `server_id` of the `<question_responses>` envelope (the question/status asked about) */
	serverId?: string
	/** `type` of the `<question_responses>` envelope ('status' for the status kind) */
	type?: string
	raw: BinaryNode
}

/** The app's hardcoded count for the question-responses job. */
export const CHANNEL_STATUS_QUESTION_RESPONSES_DEFAULT_COUNT = 30
/** Max count the app writes for question responses (J9G $t=8: 1..1000). */
export const CHANNEL_STATUS_QUESTION_RESPONSES_MAX_COUNT = 1000
/** Max count the app writes for status responses (J9G.A02: 1..300). */
export const CHANNEL_STATUS_RESPONSES_MAX_COUNT = 300
/** `server_id` is only written on the wire inside this range (IHO.A0S). */
export const CHANNEL_STATUS_MIN_SERVER_ID = 99
export const CHANNEL_STATUS_MAX_SERVER_ID = 2147476647

/**
 * Decode one `<question_response>` node (KG6.A0R + A0Q + A0C + A0H).
 * Returns undefined when the item has no `<message>` child or its
 * `<plaintext>` payload is not a decodable proto.Message — the app's
 * parser requires both, so such an item is not a usable answer.
 */
export const decodeChannelStatusResponse = (node: BinaryNode): ChannelStatusResponse | undefined => {
	const messageNode = getBinaryNodeChild(node, 'message')
	if (!messageNode) {
		return undefined
	}

	let message: proto.IMessage | undefined
	let text: string | undefined
	const plaintextNode = getBinaryNodeChild(messageNode, 'plaintext')
	if (plaintextNode?.content) {
		const contentBuf =
			typeof plaintextNode.content === 'string'
				? Buffer.from(plaintextNode.content, 'binary')
				: Buffer.from(plaintextNode.content as Uint8Array)
		try {
			message = proto.Message.decode(contentBuf)
		} catch {
			return undefined
		}

		const extendedText = message.extendedTextMessage
		text = extendedText?.text || message.conversation || undefined
	}

	const senderNode = getBinaryNodeChild(node, 'sender')
	const metaNode = getBinaryNodeChild(messageNode, 'meta')
	const flagsNode = getBinaryNodeChild(node, 'flags')
	const hasFlag = (name: string): boolean => {
		if (!flagsNode) {
			return false
		}
		// the decompiled parser checks for a `replied`/`starred` marker
		// inside <flags> without saying whether it is a child or an
		// attr, so both shapes are accepted
		return !!getBinaryNodeChild(flagsNode, name) || flagsNode.attrs[name] !== undefined
	}
	const reactionsNode = getBinaryNodeChild(node, 'reactions')
	const reactionNode = reactionsNode ? getBinaryNodeChild(reactionsNode, 'reaction') : undefined
	const pictureNode = senderNode ? getBinaryNodeChild(senderNode, 'picture') : undefined

	return {
		id: messageNode.attrs.id || '',
		responseServerId: metaNode?.attrs.response_server_id,
		senderLid: senderNode?.attrs.lid,
		senderNotifyName: senderNode?.attrs.notify_name,
		senderPictureDirectPath: pictureNode?.attrs.direct_path,
		messageTimestamp: +(messageNode.attrs.t || 0),
		fromMe: messageNode.attrs.is_sender === 'true',
		questionType: metaNode?.attrs.questiontype,
		text,
		message,
		replied: hasFlag('replied'),
		starred: hasFlag('starred'),
		reaction: reactionNode?.attrs.code,
		raw: node
	}
}

/**
 * Fetch the answers to a channel status question (`kind: 'question'`,
 * default), or the responses to a channel status (`kind: 'status'`).
 * `serverId` is the server id of the question/status being asked about.
 * Page with `before` set to the last response's `responseServerId`.
 * The `searchQuery` option is only valid for the question kind — the
 * status job in the app has no search parameter.
 */
export const fetchChannelStatusResponses = async (
	jid: string,
	serverId: string,
	options: ChannelStatusResponsesOptions,
	deps: ChannelStatusQueryDeps
): Promise<ChannelStatusResponsesResult> => {
	const kind = options.kind ?? 'question'
	const count = options.count ?? CHANNEL_STATUS_QUESTION_RESPONSES_DEFAULT_COUNT

	const serverIdNum = Number(serverId)
	if (!Number.isInteger(serverIdNum)) {
		throw new Boom('serverId must be an integer server id', { statusCode: 400 })
	}

	if (kind === 'question') {
		if (serverIdNum < 0) {
			throw new Boom('serverId must not be negative', { statusCode: 400 })
		}
		if (count < 1 || count > CHANNEL_STATUS_QUESTION_RESPONSES_MAX_COUNT) {
			throw new Boom(
				`count must be between 1 and ${CHANNEL_STATUS_QUESTION_RESPONSES_MAX_COUNT} for question responses`,
				{ statusCode: 400 }
			)
		}
	} else {
		if (serverIdNum < CHANNEL_STATUS_MIN_SERVER_ID || serverIdNum >= CHANNEL_STATUS_MAX_SERVER_ID + 1) {
			throw new Boom(
				`serverId must be between ${CHANNEL_STATUS_MIN_SERVER_ID} and ${CHANNEL_STATUS_MAX_SERVER_ID} for status responses`,
				{ statusCode: 400 }
			)
		}
		if (count < 1 || count > CHANNEL_STATUS_RESPONSES_MAX_COUNT) {
			throw new Boom(
				`count must be between 1 and ${CHANNEL_STATUS_RESPONSES_MAX_COUNT} for status responses`,
				{ statusCode: 400 }
			)
		}
		if (options.searchQuery !== undefined) {
			throw new Boom('searchQuery is only supported for question responses', { statusCode: 400 })
		}
	}

	if (options.before !== undefined && options.before.length === 0) {
		throw new Boom('before must not be empty', { statusCode: 400 })
	}
	if (options.searchQuery !== undefined && options.searchQuery.length === 0) {
		throw new Boom('searchQuery must not be empty', { statusCode: 400 })
	}

	const responsesAttrs: Record<string, string> = { count: count.toString() }
	if (kind === 'status') {
		responsesAttrs.type = 'status'
	}
	// the app only writes server_id inside 99..2147476647 (IHO.A0S)
	if (serverIdNum >= CHANNEL_STATUS_MIN_SERVER_ID && serverIdNum <= CHANNEL_STATUS_MAX_SERVER_ID) {
		responsesAttrs.server_id = String(serverIdNum)
	}

	// the optional children are <question_responses> nodes nested inside
	// the outer <question_responses> — that nesting is what the app
	// sends (C1941J8e / C1946J8j), in before, filter, search order
	const children: BinaryNode[] = []
	if (options.before) {
		children.push({ tag: 'question_responses', attrs: { before: options.before } })
	}
	if (options.filter) {
		children.push({
			tag: 'question_responses',
			attrs: {},
			content: [
				{
					tag: 'filters',
					attrs: {},
					content: [{ tag: options.filter, attrs: {} }]
				}
			]
		})
	}
	if (options.searchQuery) {
		children.push({
			tag: 'question_responses',
			attrs: {},
			content: [
				{
					tag: 'search',
					attrs: { text: options.searchQuery }
				}
			]
		})
	}

	const raw = await deps.query({
		tag: 'iq',
		attrs: {
			id: deps.generateMessageTag(),
			type: 'get',
			xmlns: 'newsletter',
			to: jid
		},
		content: [{ tag: 'question_responses', attrs: responsesAttrs, content: children }]
	})

	const responsesNode = getBinaryNodeChild(raw, 'question_responses') ?? raw
	const responses = getBinaryNodeChildren(responsesNode, 'question_response')
		.map(node => decodeChannelStatusResponse(node))
		.filter((response): response is ChannelStatusResponse => !!response)

	return {
		responses,
		serverId: responsesNode.attrs.server_id,
		type: responsesNode.attrs.type,
		raw
	}
}

/**
 * Send a view receipt for a channel status — the receipt the app sends
 * when a channel status is viewed (SendNewsletterStatusViewReceiptJob).
 *
 * What the APK pins down:
 * - The job is enqueued from StatusManager.markStatusAsSeenInternal when
 *   a newsletter status is marked seen, carrying `newsletterRawJid`
 *   (the channel JID), `receiptStanzaId` (the status message's stanza
 *   id — the `<status id>`, e.g. '3EB079CA1FB41899DF027B', NOT the
 *   server_id) and `sortId` (the message's local sort_id), and only
 *   when sortId > 0. Its job id is `status-view-receipt-<rawJid>`.
 * - The receiving side (StatusMessageStateUpdateReceiptHandler /
 *   processNewsletterStatusViewReceipt, C1U8) expects a receipt stanza
 *   with type "view" (or "read-self"), `from` the viewer, `id` the
 *   status stanza id, and a `t` (unix seconds) attr, and looks the
 *   status up by (newsletter JID, stanza id). It never reads a sort id
 *   off the stanza.
 *
 * What the APK does NOT show: the job class defines no onRun in the dex
 * (verified by parsing classes10.dex — only <init>, A00 and Ct8 exist),
 * so the stanza the app actually sends could not be read from it. The
 * shape sent here is the generic receipt the fork already builds in
 * sendReceipt (`<receipt to id [type] [t]>`, fire-and-forget via
 * sendNode) with type "view", which is exactly the shape the receiving
 * handler expects. This needs a live check against a real channel
 * before it is trusted.
 *
 * `sortId` is accepted because the app's job carries it and only fires
 * when it is positive; it is validated the same way but is NOT placed
 * on the wire, because no APK evidence puts it there.
 */
export const sendChannelStatusViewReceipt = async (
	jid: string,
	receiptStanzaId: string,
	sortId: number,
	deps: Pick<ChannelStatusDeps, 'sendNode'>
): Promise<void> => {
	if (!receiptStanzaId) {
		throw new Boom('receiptStanzaId is required to send a channel status view receipt', { statusCode: 400 })
	}
	if (!Number.isInteger(sortId) || sortId <= 0) {
		throw new Boom('sortId must be a positive integer', { statusCode: 400 })
	}

	await deps.sendNode({
		tag: 'receipt',
		attrs: {
			to: jid,
			id: receiptStanzaId,
			type: 'view',
			t: Math.floor(Date.now() / 1000).toString()
		}
	})
}
