import { Boom } from '@hapi/boom'
import $protobuf from 'protobufjs/minimal.js'
import { proto } from '../../WAProto/index.js'
import type { AnyMessageContent } from '../Types/index.js'
import type { MediaGenerationOptions } from '../Types/Message.js'
import { encodeNewsletterMessage, generateMessageIDV2 } from '../Utils/generics.js'
import { generateWAMessageContent, normalizeMessageContent } from '../Utils/index.js'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildren } from '../WABinary/index.js'
import type { ChannelStatusDeps, ChannelStatusQueryDeps } from './channelStatus.js'

/** Deps for scheduling a channel post (fire-and-forget send). Same shape as the channel-status send deps. */
export type ChannelScheduleDeps = ChannelStatusDeps

/** Deps for the scheduled-post calls that ask the server something (reschedule / cancel / send-now / fetch). */
export type ChannelScheduleQueryDeps = ChannelStatusQueryDeps

/** Deps for reschedule / send-now: content has to be built (like a send) and the edit stanza waits for the server ack. */
export type ChannelScheduleEditDeps = ChannelScheduleDeps & ChannelScheduleQueryDeps

export type ChannelScheduleOptions = Pick<MediaGenerationOptions, 'backgroundColor' | 'font'> & {
	/** Mark image/video content as AI-generated (same marker as channel statuses). Text and audio have no AI marker in the proto. */
	aiContent?: boolean
}

/**
 * A scheduled channel post.
 *
 * `id` is the client id — the stanza id the post was scheduled under, and
 * the id reschedule / cancel / send-now all key on. `scheduledMessageId`
 * is the server-assigned id, which only a fetch record carries (a fresh
 * schedule has not heard back from the server yet).
 */
export type ChannelScheduledPost = {
	/** client id of the scheduled post */
	id: string
	channelJid: string
	/** the built proto.Message (inner content, unwrapped) */
	message: proto.IMessage
	/** publish time, ms epoch — what the caller passed in */
	publishAtMs?: number
	/** publish time, seconds epoch — the `st` value that actually went on the wire */
	publishAtSeconds?: number
	/** server-assigned id, from a fetch record's `server_id` attr */
	scheduledMessageId?: string
	/** creation time, ms epoch — only from a fetch record (`t` attr, seconds) */
	createdTimestampMs?: number
	/** true when a fetch record says the post is the caller's own (`is_sender`) */
	isSender?: boolean
	/** admin profile id, from a fetch record's `<admin_profile>` child */
	adminProfileId?: string
	/** terminal reason, from a fetch record's `terminal_reason` attr (a cancelled / already-sent post) */
	terminalReason?: string
	/** text of a text post, when the message has one */
	text?: string
	/** the server ack (reschedule / send-now / cancel) or the raw record node (fetch) */
	raw?: BinaryNode
}

/** Options for fetching a channel's scheduled posts. */
export type ChannelScheduleFetchOptions = {
	/** how many scheduled posts to fetch (1..100) */
	count: number
	/** fetch scheduled posts with a server id below this one (paging cursor) */
	before?: string
}

/** What fetchChannelScheduledPosts returns: the parsed posts plus the raw IQ result. */
export type ChannelScheduleFetchResult = {
	posts: ChannelScheduledPost[]
	raw: BinaryNode
}

/**
 * Proto field numbers, from the decompiled WhatsApp APK (dex-rest/classes10.dex,
 * verified against the generated classes' FIELD_NUMBER constants — the
 * sanity check being conversation=1, extendedText=6, image=3):
 * `Message.newsletterScheduledMessage` = 132, and
 * `NewsletterScheduledMessage.message` = 1. The scheduled-message wrapper
 * is a proto of its own: a `Message` whose only field is
 * `newsletterScheduledMessage`, which holds the real message.
 */
export const NEWSLETTER_SCHEDULED_MESSAGE_FIELD_NUMBER = 132
export const SCHEDULED_MESSAGE_INNER_FIELD_NUMBER = 1

/** How many scheduled posts the fetch IQ asks for in one page (the app asks 100; the request validates count 1..100). */
export const CHANNEL_SCHEDULE_FETCH_MAX_COUNT = 100

/**
 * Wrap a built message for a scheduled send: the plaintext bytes of a
 * scheduled post are NOT the message itself, but the message wrapped in
 * `Message{ newsletterScheduledMessage: { message: <inner> } }`
 * (KC6.A00 in the app — it wraps unless the 4096 presence bit is already
 * set). The fork's WAProto has no `newsletterScheduledMessage` field, so
 * the framing is built by hand with protobufjs's Writer; the field numbers
 * above are the only thing that has to stay in sync with the app.
 */
export const wrapNewsletterScheduledMessage = (innerMessageBytes: Uint8Array): Uint8Array => {
	const wrapped = $protobuf.Writer.create()
		.uint32((SCHEDULED_MESSAGE_INNER_FIELD_NUMBER << 3) | 2)
		.bytes(innerMessageBytes)
		.finish()
	return $protobuf.Writer.create()
		.uint32((NEWSLETTER_SCHEDULED_MESSAGE_FIELD_NUMBER << 3) | 2)
		.bytes(wrapped)
		.finish()
}

/**
 * Undo wrapNewsletterScheduledMessage: pull the inner message bytes out of
 * a wrapped `Message`. Returns undefined when the bytes are not wrapped
 * (a plain message) or the wrapper holds no message — callers fall back to
 * the bytes as given. `proto.Message.decode` on its own cannot do this:
 * protobufjs silently drops the unknown field 132.
 */
export const unwrapNewsletterScheduledMessage = (bytes: Uint8Array): Uint8Array | undefined => {
	const reader = $protobuf.Reader.create(bytes)
	while (reader.pos < reader.len) {
		const tag = reader.uint32()
		const field = tag >>> 3
		const wire = tag & 7
		if (field === NEWSLETTER_SCHEDULED_MESSAGE_FIELD_NUMBER && wire === 2) {
			const wrapped = reader.bytes()
			const inner = $protobuf.Reader.create(wrapped)
			while (inner.pos < inner.len) {
				const innerTag = inner.uint32()
				if ((innerTag >>> 3) === SCHEDULED_MESSAGE_INNER_FIELD_NUMBER && (innerTag & 7) === 2) {
					return inner.bytes()
				}
				inner.skipType(innerTag & 7)
			}
			return undefined
		}
		reader.skipType(wire)
	}
	return undefined
}

/** ms epoch → seconds epoch: the unit the `st` attr carries (the app divides by 1000 — 2GP.A07). */
const toPublishSeconds = (publishAtMs: number): number => Math.floor(publishAtMs / 1000)

const textOf = (message: proto.IMessage): string | undefined =>
	message.extendedTextMessage?.text || message.conversation || undefined

/**
 * The `mediatype` plaintext attr, mirroring messages-send.ts's local
 * getMediaType. A scheduled post carries the same plaintext attrs as a
 * normal newsletter message.
 */
const getScheduledMediaType = (message: proto.IMessage): string => {
	if (message.imageMessage) {
		return 'image'
	} else if (message.videoMessage) {
		return message.videoMessage.gifPlayback ? 'gif' : 'video'
	} else if (message.audioMessage) {
		return message.audioMessage.ptt ? 'ptt' : 'audio'
	} else if (message.contactMessage) {
		return 'vcard'
	} else if (message.documentMessage) {
		return 'document'
	} else if (message.contactsArrayMessage) {
		return 'contact_array'
	} else if (message.liveLocationMessage) {
		return 'livelocation'
	} else if (message.stickerMessage) {
		return 'sticker'
	} else if (message.listMessage) {
		return 'list'
	} else if (message.listResponseMessage) {
		return 'list_response'
	} else if (message.buttonsResponseMessage) {
		return 'buttons_response'
	} else if (message.orderMessage) {
		return 'order'
	} else if (message.productMessage) {
		return 'product'
	} else if (message.interactiveResponseMessage) {
		return 'native_flow_response'
	} else if (message.groupInviteMessage) {
		return 'url'
	}

	return ''
}

/**
 * The message-type string for a newsletter `<message>` stanza:
 * poll / media / text (KC6.A02 in the app). Reactions and events are not
 * scheduled posts; they fall through to 'text' here, as they do there.
 */
const getScheduledMessageType = (message: proto.IMessage): string => {
	const normalized = normalizeMessageContent(message)
	if (!normalized) {
		return 'text'
	}
	if (
		normalized.pollCreationMessage ||
		normalized.pollCreationMessageV2 ||
		normalized.pollCreationMessageV3 ||
		normalized.pollUpdateMessage ||
		normalized.pollAddOptionMessage
	) {
		return 'poll'
	}
	if (getScheduledMediaType(normalized) !== '') {
		return 'media'
	}
	return 'text'
}

/** Build the inner message for a scheduled post, exactly like sendChannelStatus builds a status. */
const buildScheduledContent = async (
	content: AnyMessageContent,
	deps: ChannelScheduleDeps,
	options: ChannelScheduleOptions
): Promise<proto.IMessage> => {
	const inner = await generateWAMessageContent(content, { ...options, upload: deps.waUploadToServer })

	if (options.aiContent) {
		if (inner.imageMessage) {
			inner.imageMessage.imageSourceType = proto.Message.ImageMessage.ImageSourceType.AI_GENERATED
		} else if (inner.videoMessage) {
			inner.videoMessage.videoSourceType = proto.Message.VideoMessage.VideoSourceType.AI_GENERATED
		}
	}

	return inner
}

/** The envelope a scheduled send / reschedule / send-now carries: the wrapped bytes plus the stanza attrs they need. */
type ScheduledEnvelope = {
	type: string
	plaintextAttrs: Record<string, string>
	bytes: Uint8Array
}

const buildScheduledEnvelope = (inner: proto.IMessage): ScheduledEnvelope => {
	const bytes = wrapNewsletterScheduledMessage(encodeNewsletterMessage(inner))
	const mediaType = getScheduledMediaType(normalizeMessageContent(inner) || inner)
	return {
		type: getScheduledMessageType(inner),
		plaintextAttrs: mediaType ? { mediatype: mediaType } : {},
		bytes
	}
}

/** `<meta type="scheduled_message" ...>`, the child that marks a stanza as a scheduled post. */
const scheduledMeta = (extra: Record<string, string> = {}): BinaryNode => ({
	tag: 'meta',
	attrs: { type: 'scheduled_message', ...extra }
})

const checkPublishAt = (publishAtMs: number): number => {
	if (!Number.isFinite(publishAtMs)) {
		throw new Boom('publishAtMs must be a finite ms-epoch timestamp', { statusCode: 400 })
	}
	const publishAtSeconds = toPublishSeconds(publishAtMs)
	if (publishAtSeconds * 1000 <= Date.now()) {
		throw new Boom('publishAtMs must be in the future', { statusCode: 400 })
	}
	return publishAtSeconds
}

const checkClientId = (clientId: string, action: string): void => {
	if (!clientId) {
		throw new Boom(`clientId is required to ${action} a scheduled channel post`, { statusCode: 400 })
	}
}

/**
 * Schedule a channel post for later — the temporary-held update a channel
 * admin queues from the channel, published by the server at `publishAtMs`.
 * It is NOT a channel status (that is newsletterSendStatus) and NOT an
 * immediate channel message (that is sendMessage to the @newsletter JID).
 *
 * Wire shape, from the decompiled app (SendNewsletterMessageJob.A0R/A02,
 * KDT.A06 — the local queue row — and C4538KEr, "ScheduledMessageManager/
 * sendScheduleMessage"): the post goes out NOW as a normal newsletter
 * `<message>` stanza, with the publish time on a `<meta>` child and the
 * content wrapped — the server holds it until then:
 *
 *   <message to="<channel>" id="<clientId>" type="text|poll|media">
 *     <meta type="scheduled_message" st="<publishAtSeconds>"/>
 *     <plaintext [mediatype="..."]><wrapped proto.Message bytes></plaintext>
 *   </message>
 *
 * - `st` is epoch SECONDS (the app stores ms and divides by 1000).
 * - the plaintext bytes are the message wrapped in
 *   `Message{ newsletterScheduledMessage: { message } }` (field 132/1);
 *   the server stores the wrapped bytes and the app unwraps them on read.
 * - the stanza id is the client id: reschedule / cancel / send-now all
 *   key on it, NOT on the server-assigned scheduled id (the local table
 *   `newsletter_scheduled_message` keeps `scheduled_server_id` alongside
 *   it, but no operation addresses the post by it).
 *
 * The app's meta also carries KC6.A03/A04 extras (contenttype, polltype,
 * questiontype, ai_content, parent/response server ids) — all conditional
 * on the message kind, and all omitted here, exactly as the fork's normal
 * newsletter send omits the `<meta>` child entirely and still delivers.
 * Accepts the same content shapes as sendMessage: { text } for a text
 * post, { image, caption } etc. for media.
 */
export const scheduleChannelPost = async (
	jid: string,
	content: AnyMessageContent,
	publishAtMs: number,
	deps: ChannelScheduleDeps,
	options: ChannelScheduleOptions = {}
): Promise<ChannelScheduledPost> => {
	const publishAtSeconds = checkPublishAt(publishAtMs)

	const inner = await buildScheduledContent(content, deps, options)
	const id = generateMessageIDV2(deps.userJid)
	const envelope = buildScheduledEnvelope(inner)

	await deps.sendNode({
		tag: 'message',
		attrs: {
			to: jid,
			id,
			type: envelope.type
		},
		content: [
			scheduledMeta({ st: publishAtSeconds.toString() }),
			{ tag: 'plaintext', attrs: envelope.plaintextAttrs, content: envelope.bytes }
		]
	})

	return { id, channelJid: jid, message: inner, publishAtMs, publishAtSeconds, text: textOf(inner) }
}

/**
 * Move a scheduled channel post to another time.
 *
 * Wire shape, from the app (RescheduleNewsletterScheduledUpdateJob's onRun,
 * inlined into the base Job.A0O by the app's optimiser, via JVX.A00 —
 * the shared builder for reschedule and send-now): the queued post is
 * re-sent in full (the envelope is re-composed from the stored message by
 * C3672Jra, the "NewsletterScheduledUpdateEnvelopeFactory") as an edit of
 * the original stanza, with the new publish time on the meta:
 *
 *   <message to="<channel>" type="<original type>" id="<clientId>" edit="3">
 *     <meta type="scheduled_message" st="<newPublishAtSeconds>"/>
 *     <plaintext [mediatype="..."]><wrapped proto.Message bytes></plaintext>
 *   </message>
 *
 * `edit="3"` is the app's edit code for editing a scheduled message (the
 * fork uses 1 = edit, 2 = pin, 7 = delete own, 8 = delete as admin).
 * The call waits for the server ack (query) and throws on a nack, like the
 * app, which throws "reschedule nacked, error=". The content is the post
 * as scheduled — pass the same content again; media is re-uploaded, where
 * the app reuses its stored bytes.
 */
export const rescheduleChannelPost = async (
	jid: string,
	clientId: string,
	content: AnyMessageContent,
	publishAtMs: number,
	deps: ChannelScheduleEditDeps,
	options: ChannelScheduleOptions = {}
): Promise<ChannelScheduledPost> => {
	checkClientId(clientId, 'reschedule')
	const publishAtSeconds = checkPublishAt(publishAtMs)

	const inner = await buildScheduledContent(content, deps, options)
	const envelope = buildScheduledEnvelope(inner)

	const raw = await deps.query({
		tag: 'message',
		attrs: {
			to: jid,
			type: envelope.type,
			id: clientId,
			edit: '3'
		},
		content: [
			scheduledMeta({ st: publishAtSeconds.toString() }),
			{ tag: 'plaintext', attrs: envelope.plaintextAttrs, content: envelope.bytes }
		]
	})

	return { id: clientId, channelJid: jid, message: inner, publishAtMs, publishAtSeconds, text: textOf(inner), raw }
}

/**
 * Publish a scheduled channel post right now instead of at its publish time.
 *
 * Wire shape, from the app (SendNewsletterScheduledUpdateNowJob's onRun,
 * via the same JVX.A00 builder as reschedule): the same edit="3" re-send
 * of the full envelope, but the meta carries `send_now="true"` instead of
 * a new `st`:
 *
 *   <message to="<channel>" type="<original type>" id="<clientId>" edit="3">
 *     <meta type="scheduled_message" send_now="true"/>
 *     <plaintext [mediatype="..."]><wrapped proto.Message bytes></plaintext>
 *   </message>
 *
 * Waits for the server ack and throws on a nack ("send now nacked" in the app).
 */
export const sendChannelPostNow = async (
	jid: string,
	clientId: string,
	content: AnyMessageContent,
	deps: ChannelScheduleEditDeps,
	options: ChannelScheduleOptions = {}
): Promise<ChannelScheduledPost> => {
	checkClientId(clientId, 'send now')

	const inner = await buildScheduledContent(content, deps, options)
	const envelope = buildScheduledEnvelope(inner)

	const raw = await deps.query({
		tag: 'message',
		attrs: {
			to: jid,
			type: envelope.type,
			id: clientId,
			edit: '3'
		},
		content: [
			scheduledMeta({ send_now: 'true' }),
			{ tag: 'plaintext', attrs: envelope.plaintextAttrs, content: envelope.bytes }
		]
	})

	return { id: clientId, channelJid: jid, message: inner, text: textOf(inner), raw }
}

/**
 * Cancel a scheduled channel post so it is never published.
 *
 * Wire shape, from the app (CancelNewsletterScheduledUpdateJob's onRun,
 * inlined into the base Job.A0O): a delete of the scheduled message — an
 * edit="8" stanza (the same code the fork uses for delete-as-admin) with
 * only the scheduled marker on the meta and an empty plaintext child. The
 * `type="text"` is a literal in the app's cancel path, mirrored here even
 * for media posts:
 *
 *   <message to="<channel>" type="text" id="<clientId>" edit="8">
 *     <meta type="scheduled_message"/>
 *     <plaintext/>
 *   </message>
 *
 * Waits for the server ack and throws on a nack ("cancel nacked" in the app).
 */
export const cancelChannelPost = async (
	jid: string,
	clientId: string,
	deps: ChannelScheduleQueryDeps
): Promise<BinaryNode> => {
	checkClientId(clientId, 'cancel')

	return deps.query({
		tag: 'message',
		attrs: {
			to: jid,
			type: 'text',
			id: clientId,
			edit: '8'
		},
		content: [
			scheduledMeta(),
			{ tag: 'plaintext', attrs: {} }
		]
	})
}

/**
 * Decode one scheduled post from a fetch result's `<message>` record.
 *
 * Record shape, reconstructed from the app's fetch mapping
 * (L0a.invokeSuspend → K0B: clientMessageId, scheduledMessageId,
 * createdTimestampMs, scheduledTimestampMs, message proto, adminProfileId,
 * isSender; the generic record parser's vocabulary — server_id, is_sender,
 * admin_profile, meta, t — from Kji.ABZ) and from the send shape above:
 *
 *   <message id="<clientId>" server_id="<serverId>" t="<createdSeconds>"
 *            [is_sender="true"] [terminal_reason="..."]>
 *     <meta type="scheduled_message" st="<publishSeconds>"/>
 *     <plaintext><wrapped proto.Message bytes></plaintext>
 *     [<admin_profile id="..."/>]
 *   </message>
 *
 * The timestamps come back in seconds (the app multiplies both by 1000).
 * A record with no decodable plaintext is skipped, like a status stanza
 * with no plaintext is. This decode has NOT been checked against a live
 * fetch yet — the record's exact attrs are the one part of this file the
 * APK's generic parser does not spell out, so treat the field mapping as
 * provisional until a real fetch is seen.
 */
export const decodeChannelScheduledPost = (node: BinaryNode, channelJid: string): ChannelScheduledPost | undefined => {
	const id = node.attrs.id
	if (!id) {
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

	const innerBytes = unwrapNewsletterScheduledMessage(contentBuf) ?? contentBuf

	let message: proto.IMessage
	try {
		message = proto.Message.decode(innerBytes)
	} catch {
		return undefined
	}

	const meta = getBinaryNodeChild(node, 'meta')
	const stSeconds = meta?.attrs.st ? Number(meta.attrs.st) : undefined
	const createdSeconds = node.attrs.t ? Number(node.attrs.t) : undefined
	const adminProfile = getBinaryNodeChild(node, 'admin_profile')

	return {
		id,
		channelJid,
		message,
		publishAtSeconds: Number.isFinite(stSeconds) ? stSeconds : undefined,
		publishAtMs: Number.isFinite(stSeconds) ? stSeconds! * 1000 : undefined,
		scheduledMessageId: node.attrs.server_id,
		createdTimestampMs: Number.isFinite(createdSeconds) ? createdSeconds! * 1000 : undefined,
		isSender: node.attrs.is_sender === 'true' ? true : node.attrs.is_sender === 'false' ? false : undefined,
		adminProfileId: adminProfile?.attrs.id,
		terminalReason: node.attrs.terminal_reason,
		text: textOf(message),
		raw: node
	}
}

/**
 * Fetch the channel's scheduled posts, paginated by server id.
 * `before` fetches scheduled posts with a server id below that one.
 *
 * Wire shape, from the app (J9G constructor $t=9, via
 * NewslettersRPCManager.A00 "GetNewsletterScheduledMessages", driven by
 * NewsletterScheduledMessagesSyncManager.fetchAll — pages of 100, and
 * `beforeScheduledMessageId` must be between 99 and 2147476647):
 *
 *   <iq xmlns="newsletter" type="get" to="<channel>" id="<tag>">
 *     <scheduled_messages count="1..100">
 *       [<scheduled_messages before="<beforeScheduledMessageId>"/>]
 *     </scheduled_messages>
 *   </iq>
 *
 * The nested same-tag `<scheduled_messages before>` child is verbatim
 * from the app (J8e(J,I) builds it; IHL.A1E appends it as a child of the
 * outer `<scheduled_messages>`); it is only present when paging. The
 * result carries the posts as `<message>` children of
 * `<scheduled_messages>`, decoded by decodeChannelScheduledPost.
 */
export const fetchChannelScheduledPosts = async (
	jid: string,
	options: ChannelScheduleFetchOptions,
	deps: ChannelScheduleQueryDeps
): Promise<ChannelScheduleFetchResult> => {
	if (!Number.isInteger(options.count) || options.count < 1 || options.count > CHANNEL_SCHEDULE_FETCH_MAX_COUNT) {
		throw new Boom(`count must be between 1 and ${CHANNEL_SCHEDULE_FETCH_MAX_COUNT}`, { statusCode: 400 })
	}
	if (options.before !== undefined) {
		const before = Number(options.before)
		if (!Number.isInteger(before) || before < 99 || before > 2147476647) {
			throw new Boom('before must be a scheduled message id between 99 and 2147476647', { statusCode: 400 })
		}
	}

	const scheduledMessages: BinaryNode = {
		tag: 'scheduled_messages',
		attrs: { count: options.count.toString() }
	}
	if (options.before) {
		scheduledMessages.content = [{ tag: 'scheduled_messages', attrs: { before: options.before } }]
	}

	const raw = await deps.query({
		tag: 'iq',
		attrs: {
			id: deps.generateMessageTag(),
			type: 'get',
			xmlns: 'newsletter',
			to: jid
		},
		content: [scheduledMessages]
	})

	const updatesNode = getBinaryNodeChild(raw, 'scheduled_messages') ?? raw
	const posts = getBinaryNodeChildren(updatesNode, 'message')
		.map(node => decodeChannelScheduledPost(node, jid))
		.filter((post): post is ChannelScheduledPost => !!post)

	return { posts, raw }
}
