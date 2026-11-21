import { randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import type { WAMessage } from '../Types/Message'
import {
	SPAM_FLOWS,
	type SpamFlow,
	type SpamReportOptions,
	type SpamReportResult,
	type SpamReportTargetResult
} from '../Types/Report'
import { extractReportingTokenContentForMessage } from '../Utils/reporting-utils'
import { type BinaryNode, getBinaryNodeChild, isJidGroup, S_WHATSAPP_NET } from '../WABinary'

export type ReportDeps = {
	query: (node: BinaryNode) => Promise<BinaryNode>
	meJid?: string
	updateBlockStatus?: (jid: string, action: 'block' | 'unblock') => Promise<void>
}

const TRACE_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** The app sends a 24-character `wi_trace_id` with each report. */
const generateTraceId = () => {
	const bytes = randomBytes(24)
	let id = ''
	for (const byte of bytes) {
		id += TRACE_ID_ALPHABET[byte % TRACE_ID_ALPHABET.length]
	}

	return id
}

const mediaTypeOf = (message: WAMessage['message']): string | undefined => {
	if (!message) {
		return undefined
	}

	if (message.videoMessage?.gifPlayback) {
		return 'gif'
	}

	if (message.imageMessage) {
		return 'image'
	}

	if (message.videoMessage) {
		return 'video'
	}

	if (message.audioMessage) {
		return 'audio'
	}

	return undefined
}

const messageTimestamp = (message: WAMessage): string => {
	const ts = message.messageTimestamp
	if (!ts) {
		return '0'
	}

	return typeof ts === 'number' ? String(ts) : ts.toString()
}

/** `spamFlow` is the established name here; `flow` is the alias other forks use. */
const resolveSpamFlow = (options: SpamReportOptions, fallback: SpamFlow): SpamFlow =>
	options.spamFlow ?? options.flow ?? fallback

/**
 * Build one `<message>` node for a report: the message id, timestamp and
 * sender, plus the `<raw>` payload the reporting token is an HMAC over.
 */
const buildSpamMessageNode = (message: WAMessage, meJid?: string): BinaryNode => {
	const senderJid =
		message.key.participantAlt ?? message.key.participant ?? (message.key.fromMe ? meJid : message.key.remoteJid)
	const isGroup = !!message.key.remoteJid && isJidGroup(message.key.remoteJid)

	const messageAttrs: Record<string, string> = {
		id: message.key.id!,
		t: messageTimestamp(message)
	}
	if (senderJid) {
		if (isGroup) {
			// in a group the stanza is from the group, the sender is the participant
			messageAttrs.from = message.key.remoteJid!
			messageAttrs.participant = senderJid
		} else {
			messageAttrs.from = senderJid
		}
	}

	const messageContent: BinaryNode[] = []
	if (message.message) {
		// Unpadded encoding: encodeWAMessage appends random pad bytes, and
		// the field-walk in extractReportingTokenContent misreads the pad as
		// a field, so it returns null most of the time. The whitelisted
		// fields are identical either way.
		const raw = extractReportingTokenContentForMessage(Buffer.from(proto.Message.encode(message.message).finish()))
		if (raw && raw.length > 0) {
			const mediatype = mediaTypeOf(message.message)
			messageContent.push({
				tag: 'raw',
				attrs: { v: '3', ...(mediatype ? { mediatype } : {}) },
				content: raw
			})
		}
	}

	return {
		tag: 'message',
		attrs: messageAttrs,
		content: messageContent
	}
}

/**
 * Build the report IQ for one message. Shape from whatsapp-rust (the only
 * public client that sends one) plus the official app's flow strings and
 * `wi_trace_id`:
 *
 * <iq xmlns="spam" type="set" to="s.whatsapp.net">
 *   <spam_list spam_flow="…" wi_trace_id="…" [jid="…"] [source="…"] [subject="…"]>
 *     <message id="…" t="…" from="…">
 *       <raw v="3" mediatype="…">…</raw>
 *     </message>
 *   </spam_list>
 * </iq>
 *
 * The `<raw>` bytes are the whitelisted-field content the reporting token is
 * an HMAC over, so the server can verify the reported content. The token
 * itself is NOT sent here — it was attached to the original message.
 * The `source` attribute (the reported member inside a group) and the `jid`
 * attribute come from the app's own spam report builder (`J9G`).
 */
export const buildSpamReportNode = (message: WAMessage, options: SpamReportOptions, meJid?: string): BinaryNode => {
	const spamListAttrs: Record<string, string> = {
		spam_flow: resolveSpamFlow(options, SPAM_FLOWS.CHAT),
		wi_trace_id: options.traceId ?? generateTraceId()
	}
	if (options.groupJid) {
		spamListAttrs.jid = options.groupJid
	}

	if (options.source) {
		spamListAttrs.source = options.source
	}

	if (options.groupSubject) {
		spamListAttrs.subject = options.groupSubject
	}

	return {
		tag: 'iq',
		attrs: {
			xmlns: 'spam',
			to: S_WHATSAPP_NET,
			type: 'set'
		},
		content: [
			{
				tag: 'spam_list',
				attrs: spamListAttrs,
				content: [buildSpamMessageNode(message, meJid)]
			}
		]
	}
}

/**
 * Build the report IQ for a target JID (contact, group, channel) with no
 * fixed message list: the `spam_list` carries the target `jid` plus the
 * flow, `source` (reported member inside a group) and `subject`, and any
 * messages passed in `options.messages`. This is the shape the app sends
 * for an overflow-menu report, whose default flow is `overflow_menu_report`.
 */
export const buildTargetReportNode = (jid: string, options: SpamReportOptions = {}, meJid?: string): BinaryNode => {
	const spamListAttrs: Record<string, string> = {
		spam_flow: resolveSpamFlow(options, SPAM_FLOWS.OVERFLOW_MENU),
		wi_trace_id: options.traceId ?? generateTraceId(),
		jid
	}
	if (options.source) {
		spamListAttrs.source = options.source
	}

	if (options.groupSubject) {
		spamListAttrs.subject = options.groupSubject
	}

	return {
		tag: 'iq',
		attrs: {
			xmlns: 'spam',
			to: S_WHATSAPP_NET,
			type: 'set'
		},
		content: [
			{
				tag: 'spam_list',
				attrs: spamListAttrs,
				content: (options.messages ?? []).map(message => buildSpamMessageNode(message, meJid))
			}
		]
	}
}

/**
 * Read the report id out of the server's reply. The app's own parser reads
 * `<report id="…"/>`; older clients (and the doc comment in whatsapp-rust)
 * describe a `<report_id>…</report_id>` text node. Both shapes are accepted
 * so the id comes back whichever form the server sends.
 */
const parseReportId = (result: BinaryNode): string | null => {
	const report = getBinaryNodeChild(result, 'report')
	if (report) {
		if (report.attrs.id) {
			return report.attrs.id
		}

		if (typeof report.content === 'string' && report.content) {
			return report.content
		}
	}

	const node = getBinaryNodeChild(result, 'report_id')
	if (!node?.content) {
		return null
	}

	return typeof node.content === 'string' ? node.content : node.content.toString()
}

/**
 * Report one or more messages (one spam IQ per message — the only shape
 * demonstrated in public code). Returns the server's `report_id` per
 * message. The reported account receives nothing; the report goes only to
 * the server for review.
 */
export const reportSpam = async (
	messages: WAMessage[],
	deps: ReportDeps,
	options: SpamReportOptions = {}
): Promise<SpamReportResult[]> => {
	const results: SpamReportResult[] = []
	for (const message of messages) {
		const node = buildSpamReportNode(message, options, deps.meJid)
		const result = await deps.query(node)
		results.push({ reportId: parseReportId(result), messageId: message.key.id! })
	}

	return results
}

/**
 * Report a target by JID (contact, group, channel) in a single IQ — the
 * overflow-menu report shape. `options.flow` picks the flow (default
 * `overflow_menu_report`); `options.source` names the reported member
 * inside a group; `options.messages` attaches messages to the report.
 * Returns one summary: the target, the flow, whether the server accepted
 * it, the `report_id`, and the stanza that was sent.
 */
export const reportTarget = async (
	jid: string,
	deps: ReportDeps,
	options: SpamReportOptions = {}
): Promise<SpamReportTargetResult> => {
	const node = buildTargetReportNode(jid, options, deps.meJid)
	const result = await deps.query(node)
	return {
		jid,
		flow: resolveSpamFlow(options, SPAM_FLOWS.OVERFLOW_MENU),
		reported: true,
		reportId: parseReportId(result),
		node
	}
}

/** Report a 1:1 contact (flow `chat`). */
export const reportContact = async (
	jid: string,
	messages: WAMessage[],
	deps: ReportDeps,
	options: SpamReportOptions = {}
): Promise<SpamReportResult[]> => {
	void jid
	return reportSpam(messages, deps, { spamFlow: SPAM_FLOWS.CHAT, ...options })
}

/** Report a group (flow `group_info_report`). */
export const reportGroup = async (
	jid: string,
	messages: WAMessage[],
	deps: ReportDeps,
	options: SpamReportOptions = {}
): Promise<SpamReportResult[]> =>
	reportSpam(messages, deps, { spamFlow: SPAM_FLOWS.GROUP_INFO, groupJid: jid, ...options })

/** Report a personal status post (flow `status_post_report`). */
export const reportStatus = async (
	jid: string,
	messages: WAMessage[],
	deps: ReportDeps,
	options: SpamReportOptions = {}
): Promise<SpamReportResult[]> => {
	void jid
	return reportSpam(messages, deps, { spamFlow: SPAM_FLOWS.STATUS_POST, ...options })
}

/** Report a channel / newsletter (flow `newsletter_info_report`). */
export const reportNewsletter = async (
	jid: string,
	messages: WAMessage[],
	deps: ReportDeps,
	options: SpamReportOptions = {}
): Promise<SpamReportResult[]> => {
	void jid
	return reportSpam(messages, deps, { spamFlow: SPAM_FLOWS.NEWSLETTER_INFO, ...options })
}

/** Report a channel status (flow `channel_status_report`). */
export const reportChannelStatus = async (
	jid: string,
	messages: WAMessage[],
	deps: ReportDeps,
	options: SpamReportOptions = {}
): Promise<SpamReportResult[]> => {
	void jid
	return reportSpam(messages, deps, { spamFlow: SPAM_FLOWS.CHANNEL_STATUS, ...options })
}

/** Report an event (flow `event_info_report`). */
export const reportEvent = async (
	jid: string,
	messages: WAMessage[],
	deps: ReportDeps,
	options: SpamReportOptions = {}
): Promise<SpamReportResult[]> => {
	void jid
	return reportSpam(messages, deps, { spamFlow: SPAM_FLOWS.EVENT_INFO, ...options })
}

/**
 * Report a contact and block them — the "Report and block" dialog action.
 * The report and the block are separate IQs; reporting alone blocks nobody.
 */
export const reportAndBlock = async (
	jid: string,
	messages: WAMessage[],
	deps: ReportDeps,
	options: SpamReportOptions = {}
): Promise<SpamReportResult[]> => {
	if (!deps.updateBlockStatus) {
		throw new Error('reportAndBlock needs updateBlockStatus')
	}

	const results = await reportContact(jid, messages, deps, options)
	await deps.updateBlockStatus(jid, 'block')
	return results
}
