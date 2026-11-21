import { Boom } from '@hapi/boom'
import { buildNewsletterPollVotes } from '../Utils/process-message.js'
import { type BinaryNode } from '../WABinary/index.js'

/** Deps for the channel poll vote call — same shape as `ChannelStatusQueryDeps`. */
export type NewsletterPollVoteDeps = {
	query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>
	generateMessageTag: () => string
}

/**
 * Vote on a channel (newsletter) poll, by option name.
 *
 * Wire shape — a plain `<message>` stanza, NOT an encrypted
 * pollUpdateMessage like a group vote:
 *
 * ```xml
 * <message to="<channel JID>" id="<tag>" type="poll" server_id="<parent poll server id>">
 *   <meta polltype="vote" />
 *   <votes>
 *     <vote>SHA-256(option name)</vote>
 *     ...
 *   </votes>
 * </message>
 * ```
 *
 * The vote is UNENCRYPTED: each `<vote>` node carries the raw SHA-256
 * hash of the option name (see `buildNewsletterPollVotes`). Evidence:
 * @hanzofc/baileys `newsletterSendPollVote` builds exactly this stanza,
 * and the decompiled WhatsApp APK agrees — `C0936Imf` sets
 * `polltype="vote"` on the poll meta node, `C5390Kez`
 * (IncomingPollMessageHandler) routes on type `poll` + polltype `vote`,
 * and `C5497Kgl` parses an incoming newsletter `<message>`'s
 * `<votes><vote>` children as raw bytes.
 *
 * `parentServerId` is the server id of the poll creation message in the
 * channel — the same id `newsletterReactMessage` takes for a channel
 * message. No message secret is needed (there is nothing to encrypt),
 * so unlike `sendPollVote` this takes no `pollInfo`.
 * @param jid channel (newsletter) JID the poll was posted in
 * @param parentServerId server id of the poll creation message in the channel
 * @param options voted option name(s)
 * @returns the id of the vote stanza that went out
 */
export const newsletterSendPollVote = async (
	jid: string,
	parentServerId: string | number,
	options: string | string[],
	deps: NewsletterPollVoteDeps
): Promise<{ id: string }> => {
	const optionNames = Array.isArray(options) ? options : [options]
	if (!optionNames.length) {
		throw new Boom('newsletterSendPollVote needs at least one option', { statusCode: 400 })
	}

	if (optionNames.some(name => typeof name !== 'string' || !name.length)) {
		throw new Boom('newsletterSendPollVote needs non-empty option names', { statusCode: 400 })
	}

	if (parentServerId === undefined || parentServerId === null || String(parentServerId).length === 0) {
		throw new Boom('newsletterSendPollVote needs a parentServerId', { statusCode: 400 })
	}

	const messageId = deps.generateMessageTag()
	await deps.query({
		tag: 'message',
		attrs: {
			to: jid,
			id: messageId,
			type: 'poll',
			server_id: String(parentServerId)
		},
		content: [
			{ tag: 'meta', attrs: { polltype: 'vote' } },
			{ tag: 'votes', attrs: {}, content: buildNewsletterPollVotes(optionNames) }
		]
	})

	return { id: messageId }
}
