import { proto } from '../../../WAProto/index.js'
import {
	decodeChannelStatus,
	fetchChannelStatuses,
	reactChannelStatus,
	revokeChannelStatus,
	sendChannelStatus
} from '../../Socket/channelStatus.js'
import type { BinaryNode } from '../../WABinary/index.js'

const channelJid = '120363331321673219@newsletter'

const statusNode = (text: string, attrs: Record<string, string> = {}): BinaryNode => ({
	tag: 'status',
	attrs: {
		from: channelJid,
		type: 'text',
		id: '3EB079CA1FB41899DF027B',
		t: '1794223368',
		server_id: '136',
		...attrs
	},
	content: [
		{
			tag: 'plaintext',
			attrs: {},
			content: Buffer.from(
				proto.Message.encode({
					extendedTextMessage: { text, backgroundArgb: 0xffa3907e, font: 0 },
					messageContextInfo: {}
				}).finish()
			)
		}
	]
})

it('decodes a channel status text stanza from a newsletter JID', () => {
	const status = decodeChannelStatus(statusNode('baileys web test 3'))

	expect(status?.id).toBe('3EB079CA1FB41899DF027B')
	expect(status?.channelJid).toBe(channelJid)
	expect(status?.type).toBe('text')
	expect(status?.serverId).toBe('136')
	expect(status?.messageTimestamp).toBe(1794223368)
	expect(status?.text).toBe('baileys web test 3')
	expect(status?.backgroundArgb).toBe(0xffa3907e)
	expect(status?.font).toBe(0)
	expect(status?.offline).toBe(false)
})

it('marks offline backlog stanzas', () => {
	const status = decodeChannelStatus(statusNode('baileys recv test', { offline: '3' }))
	expect(status?.offline).toBe(true)
	expect(status?.text).toBe('baileys recv test')
})

it('ignores a status stanza that is not from a newsletter', () => {
	const node = statusNode('hello')
	node.attrs.from = '254700000000@s.whatsapp.net'
	expect(decodeChannelStatus(node)).toBeUndefined()
})

it('ignores a status stanza with no plaintext payload', () => {
	const node: BinaryNode = { tag: 'status', attrs: { from: channelJid, type: 'text', id: 'x', t: '1' }, content: [] }
	expect(decodeChannelStatus(node)).toBeUndefined()
})

it('sends a text channel status as a <status> stanza with a plaintext proto.Message', async () => {
	const sent: BinaryNode[] = []
	const result = await sendChannelStatus(
		channelJid,
		{ text: 'baileys send test' },
		{
			sendNode: async node => {
				sent.push(node)
			},
			waUploadToServer: async () => {
				throw new Error('Text statuses must not upload media')
			},
			userJid: '254181847643@s.whatsapp.net'
		},
		{ backgroundColor: '#a3907e' }
	)

	expect(sent).toHaveLength(1)
	const node = sent[0]!
	expect(node.tag).toBe('status')
	expect(node.attrs.to).toBe(channelJid)
	expect(node.attrs.type).toBe('text')
	expect(node.attrs.id).toBe(result.id)
	expect(result.channelJid).toBe(channelJid)

	const plaintext = node.content?.[0] as BinaryNode
	expect(plaintext.tag).toBe('plaintext')
	const message = proto.Message.decode(Buffer.from(plaintext.content as Uint8Array))
	expect(message.extendedTextMessage?.text).toBe('baileys send test')
	expect(message.extendedTextMessage?.backgroundArgb).toBe(0xffa3907e)

	// the sent stanza round-trips through the decoder, as the server echo does
	const echoed = decodeChannelStatus({
		tag: 'status',
		attrs: { from: channelJid, type: 'text', id: result.id, t: '1794225025', server_id: '139' },
		content: [{ tag: 'plaintext', attrs: {}, content: Buffer.from(plaintext.content as Uint8Array) }]
	})
	expect(echoed?.text).toBe('baileys send test')
})

const sendDeps = (sent: BinaryNode[]) => ({
	sendNode: async (node: BinaryNode) => {
		sent.push(node)
	},
	waUploadToServer: async () => {
		throw new Error('Text statuses must not upload media')
	},
	userJid: '254181847643@s.whatsapp.net'
})

const uploadMock = async () => ({ mediaUrl: undefined, directPath: '/test/direct/path' })

// 1x1 red PNG, for the image-status tests
const PNG_1X1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
)

it('marks a question status with ContextInfo.isQuestion', async () => {
	const sent: BinaryNode[] = []
	const result = await sendChannelStatus(channelJid, { text: 'Ask me anything', question: true }, sendDeps(sent))

	expect(sent).toHaveLength(1)
	expect(result.message.extendedTextMessage?.contextInfo?.isQuestion).toBe(true)
	const plaintext = sent[0]!.content?.[0] as BinaryNode
	const message = proto.Message.decode(Buffer.from(plaintext.content as Uint8Array))
	expect(message.extendedTextMessage?.contextInfo?.isQuestion).toBe(true)
	expect(message.extendedTextMessage?.text).toBe('Ask me anything')
})

it('marks an AI image status with imageSourceType AI_GENERATED', async () => {
	const sent: BinaryNode[] = []
	const result = await sendChannelStatus(
		channelJid,
		{ image: PNG_1X1, caption: 'AI pic' },
		{
			sendNode: async node => {
				sent.push(node)
			},
			waUploadToServer: uploadMock,
			userJid: '254181847643@s.whatsapp.net'
		},
		{ aiContent: true }
	)

	expect(sent).toHaveLength(1)
	expect(result.message.imageMessage?.imageSourceType).toBe(proto.Message.ImageMessage.ImageSourceType.AI_GENERATED)
})

it('marks an AI video status with videoSourceType AI_GENERATED', async () => {
	const sent: BinaryNode[] = []
	const result = await sendChannelStatus(
		channelJid,
		{
			video: Buffer.from('fake video bytes'),
			caption: 'AI vid',
			jpegThumbnail: Buffer.from('fake-thumb').toString('base64')
		},
		{
			sendNode: async node => {
				sent.push(node)
			},
			waUploadToServer: uploadMock,
			userJid: '254181847643@s.whatsapp.net'
		},
		{ aiContent: true }
	)

	expect(sent).toHaveLength(1)
	expect(result.message.videoMessage?.videoSourceType).toBe(proto.Message.VideoMessage.VideoSourceType.AI_GENERATED)
})

it('sends a question answer as a statusQuestionAnswerMessage keyed by the question server id', async () => {
	const sent: BinaryNode[] = []
	await sendChannelStatus(channelJid, { text: 'My answer' }, sendDeps(sent), {
		interactionType: 'question_response',
		parentServerId: '140'
	})

	expect(sent).toHaveLength(1)
	const plaintext = sent[0]!.content?.[0] as BinaryNode
	const message = proto.Message.decode(Buffer.from(plaintext.content as Uint8Array))
	expect(message.statusQuestionAnswerMessage?.text).toBe('My answer')
	expect(message.statusQuestionAnswerMessage?.key?.remoteJid).toBe(channelJid)
	expect(message.statusQuestionAnswerMessage?.key?.id).toBe('140')
	expect(message.statusQuestionAnswerMessage?.key?.fromMe).toBe(false)
})

it('refuses a question answer without a parentServerId', async () => {
	await expect(
		sendChannelStatus(channelJid, { text: 'My answer' }, sendDeps([]), { interactionType: 'question_response' })
	).rejects.toThrow('parentServerId is required')
})

it('refuses a question answer without text content', async () => {
	await expect(
		sendChannelStatus(
			channelJid,
			{ image: PNG_1X1 },
			{
				sendNode: async () => {},
				waUploadToServer: uploadMock,
				userJid: '254181847643@s.whatsapp.net'
			},
			{ interactionType: 'question_response', parentServerId: '140' }
		)
	).rejects.toThrow('needs text content')
})

const queryDeps = (queries: BinaryNode[], result: BinaryNode) => ({
	query: async (node: BinaryNode) => {
		queries.push(node)
		return result
	},
	generateMessageTag: () => 'test-tag-1'
})

const emptyResult: BinaryNode = { tag: 'iq', attrs: { type: 'result', id: 'test-tag-1' }, content: [] }

it('reacts to a channel status with a <message type="reaction"> stanza', async () => {
	const queries: BinaryNode[] = []
	await reactChannelStatus(channelJid, '139', '❤️', queryDeps(queries, emptyResult))

	expect(queries).toHaveLength(1)
	const node = queries[0]!
	expect(node.tag).toBe('message')
	expect(node.attrs.to).toBe(channelJid)
	expect(node.attrs.type).toBe('reaction')
	expect(node.attrs.server_id).toBe('139')
	expect(node.attrs.id).toBe('test-tag-1')
	const reaction = node.content?.[0] as BinaryNode
	expect(reaction.tag).toBe('reaction')
	expect(reaction.attrs.code).toBe('❤️')
})

it('removes a channel status reaction with edit=7 and an empty reaction', async () => {
	const queries: BinaryNode[] = []
	await reactChannelStatus(channelJid, '139', null, queryDeps(queries, emptyResult))

	expect(queries).toHaveLength(1)
	const node = queries[0]!
	expect(node.attrs.edit).toBe('7')
	const reaction = node.content?.[0] as BinaryNode
	expect(reaction.tag).toBe('reaction')
	expect(reaction.attrs.code).toBeUndefined()
})

it('revokes a channel status with a newsletter IQ carrying <revoke server_id>', async () => {
	const queries: BinaryNode[] = []
	const result = await revokeChannelStatus(channelJid, '139', queryDeps(queries, emptyResult))

	expect(result).toBe(emptyResult)
	expect(queries).toHaveLength(1)
	const node = queries[0]!
	expect(node.tag).toBe('iq')
	expect(node.attrs.type).toBe('set')
	expect(node.attrs.xmlns).toBe('newsletter')
	expect(node.attrs.to).toBe(channelJid)
	const revoke = node.content?.[0] as BinaryNode
	expect(revoke.tag).toBe('revoke')
	expect(revoke.attrs.server_id).toBe('139')
})

it('fetches published statuses with <status_updates> and parses them', async () => {
	const queries: BinaryNode[] = []
	// the second status node carries no `from` attr (the IQ is already
	// addressed to the channel) — the fetch fills the channel JID in
	const noFromNode: BinaryNode = {
		tag: 'status',
		attrs: { type: 'text', id: '3EB079CA1FB41899DF027C', t: '1794223369', server_id: '151' },
		content: [
			{
				tag: 'plaintext',
				attrs: {},
				content: Buffer.from(
					proto.Message.encode({
						extendedTextMessage: { text: 'second status', backgroundArgb: 0xffa3907e, font: 0 },
						messageContextInfo: {}
					}).finish()
				)
			}
		]
	}
	const fetchResult: BinaryNode = {
		tag: 'iq',
		attrs: { type: 'result', id: 'test-tag-1' },
		content: [
			{
				tag: 'status_updates',
				attrs: {},
				content: [statusNode('first status', { server_id: '150' }), noFromNode]
			}
		]
	}
	const { statuses, raw } = await fetchChannelStatuses(
		channelJid,
		{ count: 20, before: '160' },
		queryDeps(queries, fetchResult)
	)

	expect(raw).toBe(fetchResult)
	expect(queries).toHaveLength(1)
	const node = queries[0]!
	expect(node.tag).toBe('iq')
	expect(node.attrs.type).toBe('get')
	expect(node.attrs.xmlns).toBe('newsletter')
	expect(node.attrs.to).toBe(channelJid)
	const updates = node.content?.[0] as BinaryNode
	expect(updates.tag).toBe('status_updates')
	expect(updates.attrs.count).toBe('20')
	expect(updates.attrs.before).toBe('160')
	expect(updates.attrs.after).toBeUndefined()

	expect(statuses).toHaveLength(2)
	expect(statuses[0]?.text).toBe('first status')
	expect(statuses[0]?.serverId).toBe('150')
	expect(statuses[0]?.channelJid).toBe(channelJid)
	expect(statuses[1]?.text).toBe('second status')
	expect(statuses[1]?.serverId).toBe('151')
	expect(statuses[1]?.channelJid).toBe(channelJid)
})

it('fetches newer statuses with an after cursor', async () => {
	const queries: BinaryNode[] = []
	const fetchResult: BinaryNode = {
		tag: 'iq',
		attrs: { type: 'result', id: 'test-tag-1' },
		content: [{ tag: 'status_updates', attrs: {}, content: [] }]
	}
	const { statuses } = await fetchChannelStatuses(
		channelJid,
		{ count: 20, after: '140' },
		queryDeps(queries, fetchResult)
	)

	expect(statuses).toHaveLength(0)
	const updates = queries[0]!.content?.[0] as BinaryNode
	expect(updates.attrs.count).toBe('20')
	expect(updates.attrs.after).toBe('140')
	expect(updates.attrs.before).toBeUndefined()
})
