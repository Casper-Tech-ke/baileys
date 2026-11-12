import { proto } from '../../../WAProto/index.js'
import { decodeChannelStatus, sendChannelStatus } from '../../Socket/channelStatus.js'
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
