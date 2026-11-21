import { proto } from '../../../WAProto/index.js'
import {
	decodeChannelStatusResponse,
	fetchChannelStatusResponses,
	sendChannelStatusViewReceipt
} from '../../Socket/channelStatus.js'
import type { BinaryNode } from '../../WABinary/index.js'

const channelJid = '120363331321673219@newsletter'

const answerNode = (
	text: string,
	attrs: Record<string, string> = {},
	extraChildren: BinaryNode[] = [],
	plaintextContent?: Uint8Array
): BinaryNode => ({
	tag: 'question_response',
	attrs: {},
	content: [
		{
			tag: 'sender',
			attrs: { lid: '254700000001@lid', notify_name: 'Answer Person' },
			content: [{ tag: 'picture', attrs: { direct_path: '/pic/direct/path' } }]
		},
		{
			tag: 'message',
			attrs: { id: '3EB079CA1FB41899DF027B', t: '1794223368', type: 'text', ...attrs },
			content: [
				{
					tag: 'plaintext',
					attrs: {},
					content:
						plaintextContent ??
						Buffer.from(
							proto.Message.encode({
								extendedTextMessage: { text, backgroundArgb: 0xffa3907e, font: 0 },
								messageContextInfo: {}
							}).finish()
						)
				},
				{
					tag: 'meta',
					attrs: { questiontype: 'response', response_server_id: '201' }
				}
			]
		},
		...extraChildren
	]
})

const queryDeps = (queries: BinaryNode[], result: BinaryNode) => ({
	query: async (node: BinaryNode) => {
		queries.push(node)
		return result
	},
	generateMessageTag: () => 'test-tag-1'
})

const responsesResult = (responses: BinaryNode[], attrs: Record<string, string> = {}): BinaryNode => ({
	tag: 'iq',
	attrs: { type: 'result', id: 'test-tag-1' },
	content: [{ tag: 'question_responses', attrs: { server_id: '140', ...attrs }, content: responses }]
})

it('decodes a question response with sender, meta, flags and reaction', () => {
	const response = decodeChannelStatusResponse(
		answerNode('Yes, definitely', {}, [
			{ tag: 'flags', attrs: {}, content: [{ tag: 'replied', attrs: {} }] },
			{
				tag: 'reactions',
				attrs: {},
				content: [{ tag: 'reaction', attrs: { code: '❤️' } }]
			}
		])
	)

	expect(response?.id).toBe('3EB079CA1FB41899DF027B')
	expect(response?.responseServerId).toBe('201')
	expect(response?.senderLid).toBe('254700000001@lid')
	expect(response?.senderNotifyName).toBe('Answer Person')
	expect(response?.senderPictureDirectPath).toBe('/pic/direct/path')
	expect(response?.messageTimestamp).toBe(1794223368)
	expect(response?.fromMe).toBe(false)
	expect(response?.questionType).toBe('response')
	expect(response?.text).toBe('Yes, definitely')
	expect(response?.replied).toBe(true)
	expect(response?.starred).toBe(false)
	expect(response?.reaction).toBe('❤️')
})

it('decodes a starred flag given as an attr and marks our own answers', () => {
	const response = decodeChannelStatusResponse(
		answerNode('My own answer', { is_sender: 'true' }, [{ tag: 'flags', attrs: { starred: 'true' } }])
	)

	expect(response?.fromMe).toBe(true)
	expect(response?.starred).toBe(true)
	expect(response?.replied).toBe(false)
})

it('ignores a question response with no message child', () => {
	const node: BinaryNode = { tag: 'question_response', attrs: {}, content: [] }
	expect(decodeChannelStatusResponse(node)).toBeUndefined()
})

it('ignores a question response whose plaintext is not a proto.Message', () => {
	// 0xff bytes fail the varint/wire-type framing, so the proto decode throws
	const node = answerNode('x', {}, [], Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
	expect(decodeChannelStatusResponse(node)).toBeUndefined()
})

it('fetches question answers with <question_responses server_id count> and parses them', async () => {
	const queries: BinaryNode[] = []
	const result = responsesResult([answerNode('first answer'), answerNode('second answer', { id: '3EB079CA1FB41899DF027C' })])
	const { responses, serverId, type, raw } = await fetchChannelStatusResponses(
		channelJid,
		'140',
		{ count: 30 },
		queryDeps(queries, result)
	)

	expect(raw).toBe(result)
	expect(serverId).toBe('140')
	expect(type).toBeUndefined()
	expect(queries).toHaveLength(1)
	const node = queries[0]!
	expect(node.tag).toBe('iq')
	expect(node.attrs.type).toBe('get')
	expect(node.attrs.xmlns).toBe('newsletter')
	expect(node.attrs.to).toBe(channelJid)
	expect(node.attrs.id).toBe('test-tag-1')
	const questionResponses = node.content?.[0] as BinaryNode
	expect(questionResponses.tag).toBe('question_responses')
	expect(questionResponses.attrs.server_id).toBe('140')
	expect(questionResponses.attrs.count).toBe('30')
	expect(questionResponses.attrs.type).toBeUndefined()

	expect(responses).toHaveLength(2)
	expect(responses[0]?.text).toBe('first answer')
	expect(responses[0]?.responseServerId).toBe('201')
	expect(responses[1]?.text).toBe('second answer')
	expect(responses[1]?.id).toBe('3EB079CA1FB41899DF027C')
})

it('fetches question answers with before, filter and search as nested <question_responses> children', async () => {
	const queries: BinaryNode[] = []
	const result = responsesResult([])
	await fetchChannelStatusResponses(
		channelJid,
		'140',
		{ count: 10, before: '201', filter: 'replied', searchQuery: 'yes' },
		queryDeps(queries, result)
	)

	const questionResponses = queries[0]!.content?.[0] as BinaryNode
	expect(questionResponses.attrs.count).toBe('10')
	const children = (questionResponses.content ?? []) as BinaryNode[]
	expect(children).toHaveLength(3)
	// before
	expect(children[0]?.tag).toBe('question_responses')
	expect(children[0]?.attrs.before).toBe('201')
	// filter
	expect(children[1]?.tag).toBe('question_responses')
	const filters = children[1]?.content?.[0] as BinaryNode
	expect(filters.tag).toBe('filters')
	expect((filters.content?.[0] as BinaryNode).tag).toBe('replied')
	// search
	expect(children[2]?.tag).toBe('question_responses')
	const search = children[2]?.content?.[0] as BinaryNode
	expect(search.tag).toBe('search')
	expect(search.attrs.text).toBe('yes')
})

it('fetches status responses with type="status" on the child', async () => {
	const queries: BinaryNode[] = []
	const result = responsesResult([answerNode('status reply')], { type: 'status' })
	const { responses, type } = await fetchChannelStatusResponses(
		channelJid,
		'140',
		{ count: 20, before: '201', filter: 'starred', kind: 'status' },
		queryDeps(queries, result)
	)

	expect(type).toBe('status')
	expect(responses).toHaveLength(1)
	expect(responses[0]?.text).toBe('status reply')
	const questionResponses = queries[0]!.content?.[0] as BinaryNode
	expect(questionResponses.attrs.type).toBe('status')
	expect(questionResponses.attrs.server_id).toBe('140')
	expect(questionResponses.attrs.count).toBe('20')
	const children = (questionResponses.content ?? []) as BinaryNode[]
	expect(children).toHaveLength(2)
	expect(children[0]?.attrs.before).toBe('201')
	expect(((children[1]?.content?.[0] as BinaryNode).content?.[0] as BinaryNode).tag).toBe('starred')
})

it('returns no responses when the result carries none', async () => {
	const queries: BinaryNode[] = []
	const result = responsesResult([])
	const { responses } = await fetchChannelStatusResponses(
		channelJid,
		'140',
		{},
		queryDeps(queries, result)
	)

	expect(responses).toHaveLength(0)
	// default count is the app's hardcoded 30
	const questionResponses = queries[0]!.content?.[0] as BinaryNode
	expect(questionResponses.attrs.count).toBe('30')
})

it('refuses a search query for status responses', async () => {
	await expect(
		fetchChannelStatusResponses(
			channelJid,
			'140',
			{ searchQuery: 'yes', kind: 'status' },
			queryDeps([], responsesResult([]))
		)
	).rejects.toThrow('searchQuery is only supported for question responses')
})

it('refuses out-of-range counts', async () => {
	const deps = queryDeps([], responsesResult([]))
	await expect(fetchChannelStatusResponses(channelJid, '140', { count: 0 }, deps)).rejects.toThrow(
		'count must be between 1 and 1000'
	)
	await expect(fetchChannelStatusResponses(channelJid, '140', { count: 1001 }, deps)).rejects.toThrow(
		'count must be between 1 and 1000'
	)
	await expect(
		fetchChannelStatusResponses(channelJid, '140', { count: 301, kind: 'status' }, deps)
	).rejects.toThrow('count must be between 1 and 300')
})

it('refuses invalid server ids', async () => {
	const deps = queryDeps([], responsesResult([]))
	await expect(fetchChannelStatusResponses(channelJid, '-1', {}, deps)).rejects.toThrow(
		'serverId must not be negative'
	)
	await expect(fetchChannelStatusResponses(channelJid, 'not-a-number', {}, deps)).rejects.toThrow(
		'serverId must be an integer'
	)
	await expect(
		fetchChannelStatusResponses(channelJid, '50', { kind: 'status' }, deps)
	).rejects.toThrow('serverId must be between 99 and 2147476647')
})

it('sends a channel status view receipt as a <receipt type="view"> stanza', async () => {
	const sent: BinaryNode[] = []
	const before = Math.floor(Date.now() / 1000)
	await sendChannelStatusViewReceipt(channelJid, '3EB079CA1FB41899DF027B', 42, {
		sendNode: async node => {
			sent.push(node)
		}
	})
	const after = Math.floor(Date.now() / 1000)

	expect(sent).toHaveLength(1)
	const node = sent[0]!
	expect(node.tag).toBe('receipt')
	expect(node.attrs.to).toBe(channelJid)
	expect(node.attrs.id).toBe('3EB079CA1FB41899DF027B')
	expect(node.attrs.type).toBe('view')
	const t = Number(node.attrs.t)
	expect(Number.isInteger(t)).toBe(true)
	expect(t).toBeGreaterThanOrEqual(before)
	expect(t).toBeLessThanOrEqual(after)
	// sortId is validated but never placed on the wire
	expect(node.attrs.sort_id).toBeUndefined()
	expect(node.attrs.sortId).toBeUndefined()
})

it('refuses a view receipt without a stanza id or with a non-positive sortId', async () => {
	const deps = { sendNode: async () => {} }
	await expect(sendChannelStatusViewReceipt(channelJid, '', 42, deps)).rejects.toThrow(
		'receiptStanzaId is required'
	)
	await expect(
		sendChannelStatusViewReceipt(channelJid, '3EB079CA1FB41899DF027B', 0, deps)
	).rejects.toThrow('sortId must be a positive integer')
	await expect(
		sendChannelStatusViewReceipt(channelJid, '3EB079CA1FB41899DF027B', -3, deps)
	).rejects.toThrow('sortId must be a positive integer')
})
