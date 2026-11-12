import type { proto } from '../../WAProto/index.js'

/**
 * A channel status: the temporary (24h) update a channel admin posts from
 * the channel, shown in followers' Status tray and as a ring on the channel
 * profile picture. It is NOT a channel message and NOT a personal status.
 *
 * On the wire it arrives as a top-level `<status>` stanza from the channel's
 * `@newsletter` JID, with a `<plaintext>` child holding a `proto.Message`
 * (usually an `extendedTextMessage`). That is why the normal message stream
 * (`messages.upsert`, `status@broadcast`) never sees it.
 */
export type ChannelStatus = {
	/** stanza id, e.g. '3EB079CA1FB41899DF027B' */
	id: string
	/** channel JID, e.g. '120363331321673219@newsletter' */
	channelJid: string
	/** stanza type, usually 'text' */
	type: string
	/** server-assigned id, from the stanza `server_id` attr */
	serverId?: string
	/** unix timestamp (seconds) from the stanza `t` attr */
	messageTimestamp: number
	/** true when the stanza was delivered as offline backlog on connect */
	offline?: boolean
	/** text of a text status, from extendedTextMessage.text (or conversation) */
	text?: string
	/** text background colour, from extendedTextMessage.backgroundArgb */
	backgroundArgb?: number
	/** text font, from extendedTextMessage.font */
	font?: number
	/** the full decoded proto.Message, for media / other status kinds */
	message?: proto.IMessage
}
