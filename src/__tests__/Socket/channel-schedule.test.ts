import { proto } from '../../../WAProto/index.js'
import {
	cancelChannelPost,
	decodeChannelScheduledPost,
	fetchChannelScheduledPosts,
	rescheduleChannelPost,
	scheduleChannelPost,
	sendChannelPostNow,
	unwrapNewsletterScheduledMessage,
	wrapNewsletterScheduledMessage
} from '../../Socket/channelSchedule.js'
import type { BinaryNode } from '../../WABinary/index.js'

const channelJid = '120363331321673219@newsletter'

const sendDeps = (sent: BinaryNode[]) => ({
	sendNode: async (node: BinaryNode) => {
		sent.push(node)
	},
	waUploadToServer: async () => {
		throw new Error('Text posts must not upload media')
	},
	userJid: '254181847643@s.whatsapp.net'
})

const uploadMock = async () => ({ mediaUrl: undefined, directPath: '/test/direct/path' })

// 1x1 red PNG, for the image-post tests
const PNG_1X1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
)

const queryDeps = (queries: BinaryNode[], result: BinaryNode) => ({
	query: async (node: BinaryNode) => {
		queries.push(node)
		return result
	},
	generateMessageTag: () => 'test-tag-1'
})

const editDeps = (queries: BinaryNode[], result: BinaryNode) => ({
	...sendDeps([]),
	...queryDeps(queries, result)
})

const emptyResult: BinaryNode = { tag: 'iq', attrs: { type: 'result', id: 'test-tag-1' }, content: [] }

const futureMs = Date.now() + 3_600_000
const futureSeconds = Math.floor(futureMs / 1000)

it('wraps a message with the exact field 132/1 framing', () => {
	// inner: Message{ conversation: "hi" } -> 0x0A 0x02 'h' 'i'
	const inner = proto.Message.encode({ conversation: 'hi' }).finish()
	const wrapped = wrapNewsletterScheduledMessage(inner)

	// outer: field 132 wire 2 -> tag varint(1058) = A2 08, len 6
	// inner wrapper: field 1 wire 2 -> 0A 04, then the inner bytes
	expect(Buffer.from(wrapped).toString('hex')).toBe('a208060a040a026869')
})

it('unwrap returns undefined for plain (unwrapped) bytes', () => {
	const inner = proto.Message.encode({ conversation: 'hi' }).finish()
	expect(unwrapNewsletterScheduledMessage(inner)).toBeUndefined()
})

it('wrap then unwrap round-trips to the original message', () => {
	const inner = proto.Message.encode({
		extendedTextMessage: { text: 'scheduled hello', backgroundArgb: 0xffa3907e, font: 0 },
		messageContextInfo: {}
	}).finish()
	const unwrapped = unwrapNewsletterScheduledMessage(wrapNewsletterScheduledMessage(inner))

	expect(unwrapped).toBeDefined()
	const message = proto.Message.decode(unwrapped!)
	expect(message.extendedTextMessage?.text).toBe('scheduled hello')
	expect(message.extendedTextMessage?.backgroundArgb).toBe(0xffa3907e)
})

it('schedules a text post as a <message> stanza with <meta type="scheduled_message" st>', async () => {
	const sent: BinaryNode[] = []
	const result = await scheduleChannelPost(channelJid, { text: 'hello later' }, futureMs, sendDeps(sent))

	expect(sent).toHaveLength(1)
	const node = sent[0]!
	expect(node.tag).toBe('message')
	expect(node.attrs.to).toBe(channelJid)
	expect(node.attrs.id).toBe(result.id)
	expect(node.attrs.type).toBe('text')
	expect(node.attrs.edit).toBeUndefined()

	const meta = node.content?.[0] as BinaryNode
	expect(meta.tag).toBe('meta')
	expect(meta.attrs.type).toBe('scheduled_message')
	expect(meta.attrs.st).toBe(futureSeconds.toString())

	const plaintext = node.content?.[1] as BinaryNode
	expect(plaintext.tag).toBe('plaintext')
	const unwrapped = unwrapNewsletterScheduledMessage(Buffer.from(plaintext.content as Uint8Array))
	expect(unwrapped).toBeDefined()
	const message = proto.Message.decode(unwrapped!)
	expect(message.extendedTextMessage?.text || message.conversation).toBe('hello later')

	expect(result.channelJid).toBe(channelJid)
	expect(result.publishAtMs).toBe(futureMs)
	expect(result.publishAtSeconds).toBe(futureSeconds)
	expect(result.text).toBe('hello later')
})

it('refuses to schedule a post in the past', async () => {
	await expect(scheduleChannelPost(channelJid, { text: 'too late' }, Date.now() - 1000, sendDeps([]))).rejects.toThrow(
		'must be in the future'
	)
})

it('refuses to schedule with a non-finite publish time', async () => {
	await expect(scheduleChannelPost(channelJid, { text: 'never' }, NaN, sendDeps([]))).rejects.toThrow('finite')
})

it('schedules an image post with type=media and a mediatype plaintext attr', async () => {
	const sent: BinaryNode[] = []
	const result = await scheduleChannelPost(
		channelJid,
		{ image: PNG_1X1, caption: 'pic later' },
		futureMs,
		{
			sendNode: async node => {
				sent.push(node)
			},
			waUploadToServer: uploadMock,
			userJid: '254181847643@s.whatsapp.net'
		}
	)

	expect(sent).toHaveLength(1)
	const node = sent[0]!
	expect(node.attrs.type).toBe('media')
	const meta = node.content?.[0] as BinaryNode
	expect(meta.attrs.st).toBe(futureSeconds.toString())
	const plaintext = node.content?.[1] as BinaryNode
	expect(plaintext.attrs.mediatype).toBe('image')
	const message = proto.Message.decode(unwrapNewsletterScheduledMessage(Buffer.from(plaintext.content as Uint8Array))!)
	expect(message.imageMessage?.caption).toBe('pic later')
	expect(result.text).toBeUndefined()
})

it('reschedules a post with an edit=3 stanza carrying the new st', async () => {
	const queries: BinaryNode[] = []
	const newTime = Date.now() + 7_200_000
	const result = await rescheduleChannelPost(
		channelJid,
		'3EB079CA1FB41899DF027B',
		{ text: 'moved later' },
		newTime,
		editDeps(queries, emptyResult)
	)

	expect(result.raw).toBe(emptyResult)
	expect(queries).toHaveLength(1)
	const node = queries[0]!
	expect(node.tag).toBe('message')
	expect(node.attrs.to).toBe(channelJid)
	expect(node.attrs.type).toBe('text')
	expect(node.attrs.id).toBe('3EB079CA1FB41899DF027B')
	expect(node.attrs.edit).toBe('3')
	const meta = node.content?.[0] as BinaryNode
	expect(meta.tag).toBe('meta')
	expect(meta.attrs.type).toBe('scheduled_message')
	expect(meta.attrs.st).toBe(Math.floor(newTime / 1000).toString())
	expect(meta.attrs.send_now).toBeUndefined()
	const plaintext = node.content?.[1] as BinaryNode
	const message = proto.Message.decode(unwrapNewsletterScheduledMessage(Buffer.from(plaintext.content as Uint8Array))!)
	expect(message.extendedTextMessage?.text || message.conversation).toBe('moved later')
	expect(result.id).toBe('3EB079CA1FB41899DF027B')
	expect(result.publishAtMs).toBe(newTime)
})

it('refuses to reschedule without a clientId or with a past time', async () => {
	const deps = editDeps([], emptyResult)
	await expect(rescheduleChannelPost(channelJid, '', { text: 'x' }, futureMs, deps)).rejects.toThrow('clientId is required')
	await expect(
		rescheduleChannelPost(channelJid, '3EB079CA1FB41899DF027B', { text: 'x' }, Date.now() - 1000, deps)
	).rejects.toThrow('must be in the future')
})

it('sends a scheduled post now with an edit=3 stanza carrying send_now=true', async () => {
	const queries: BinaryNode[] = []
	const result = await sendChannelPostNow(
		channelJid,
		'3EB079CA1FB41899DF027B',
		{ text: 'go now' },
		editDeps(queries, emptyResult)
	)

	expect(result.raw).toBe(emptyResult)
	expect(queries).toHaveLength(1)
	const node = queries[0]!
	expect(node.tag).toBe('message')
	expect(node.attrs.to).toBe(channelJid)
	expect(node.attrs.type).toBe('text')
	expect(node.attrs.id).toBe('3EB079CA1FB41899DF027B')
	expect(node.attrs.edit).toBe('3')
	const meta = node.content?.[0] as BinaryNode
	expect(meta.attrs.type).toBe('scheduled_message')
	expect(meta.attrs.send_now).toBe('true')
	expect(meta.attrs.st).toBeUndefined()
	const plaintext = node.content?.[1] as BinaryNode
	const message = proto.Message.decode(unwrapNewsletterScheduledMessage(Buffer.from(plaintext.content as Uint8Array))!)
	expect(message.extendedTextMessage?.text || message.conversation).toBe('go now')
	expect(result.publishAtMs).toBeUndefined()
})

it('refuses to send now without a clientId', async () => {
	await expect(sendChannelPostNow(channelJid, '', { text: 'x' }, editDeps([], emptyResult))).rejects.toThrow(
		'clientId is required'
	)
})

it('cancels a scheduled post with an edit=8 stanza, type=text, and an empty plaintext', async () => {
	const queries: BinaryNode[] = []
	const result = await cancelChannelPost(channelJid, '3EB079CA1FB41899DF027B', queryDeps(queries, emptyResult))

	expect(result).toBe(emptyResult)
	expect(queries).toHaveLength(1)
	const node = queries[0]!
	expect(node.tag).toBe('message')
	expect(node.attrs.to).toBe(channelJid)
	expect(node.attrs.type).toBe('text')
	expect(node.attrs.id).toBe('3EB079CA1FB41899DF027B')
	expect(node.attrs.edit).toBe('8')
	const meta = node.content?.[0] as BinaryNode
	expect(meta.tag).toBe('meta')
	expect(meta.attrs.type).toBe('scheduled_message')
	expect(meta.attrs.st).toBeUndefined()
	const plaintext = node.content?.[1] as BinaryNode
	expect(plaintext.tag).toBe('plaintext')
	expect(plaintext.content).toBeUndefined()
})

it('refuses to cancel without a clientId', async () => {
	await expect(cancelChannelPost(channelJid, '', queryDeps([], emptyResult))).rejects.toThrow('clientId is required')
})

const scheduledRecord = (attrs: Record<string, string> = {}): BinaryNode => ({
	tag: 'message',
	attrs: {
		id: '3EB079CA1FB41899DF027B',
		server_id: '42',
		t: '1794223368',
		is_sender: 'true',
		...attrs
	},
	content: [
		{ tag: 'meta', attrs: { type: 'scheduled_message', st: '1794226968' } },
		{
			tag: 'plaintext',
			attrs: {},
			content: Buffer.from(
				wrapNewsletterScheduledMessage(
					proto.Message.encode({
						extendedTextMessage: { text: 'fetched post', backgroundArgb: 0xffa3907e, font: 0 },
						messageContextInfo: {}
					}).finish()
				)
			)
		}
	]
})

it('fetches scheduled posts with <scheduled_messages> and parses the records', async () => {
	const queries: BinaryNode[] = []
	const fetchResult: BinaryNode = {
		tag: 'iq',
		attrs: { type: 'result', id: 'test-tag-1' },
		content: [
			{
				tag: 'scheduled_messages',
				attrs: {},
				content: [scheduledRecord(), { ...scheduledRecord({ id: 'OTHERID', server_id: '43' }), content: [] }]
			}
		]
	}
	const { posts, raw } = await fetchChannelScheduledPosts(channelJid, { count: 20 }, queryDeps(queries, fetchResult))

	expect(raw).toBe(fetchResult)
	expect(queries).toHaveLength(1)
	const node = queries[0]!
	expect(node.tag).toBe('iq')
	expect(node.attrs.type).toBe('get')
	expect(node.attrs.xmlns).toBe('newsletter')
	expect(node.attrs.to).toBe(channelJid)
	expect(node.attrs.id).toBe('test-tag-1')
	const scheduled = node.content?.[0] as BinaryNode
	expect(scheduled.tag).toBe('scheduled_messages')
	expect(scheduled.attrs.count).toBe('20')
	expect(scheduled.content).toBeUndefined()

	// the second record has no plaintext, so only the first parses
	expect(posts).toHaveLength(1)
	const post = posts[0]!
	expect(post.id).toBe('3EB079CA1FB41899DF027B')
	expect(post.channelJid).toBe(channelJid)
	expect(post.scheduledMessageId).toBe('42')
	expect(post.publishAtSeconds).toBe(1794226968)
	expect(post.publishAtMs).toBe(1794226968000)
	expect(post.createdTimestampMs).toBe(1794223368000)
	expect(post.isSender).toBe(true)
	expect(post.text).toBe('fetched post')
	expect(post.message.extendedTextMessage?.text).toBe('fetched post')
})

it('fetches older scheduled posts with a nested <scheduled_messages before> child', async () => {
	const queries: BinaryNode[] = []
	const fetchResult: BinaryNode = {
		tag: 'iq',
		attrs: { type: 'result', id: 'test-tag-1' },
		content: [{ tag: 'scheduled_messages', attrs: {}, content: [] }]
	}
	const { posts } = await fetchChannelScheduledPosts(channelJid, { count: 100, before: '12345' }, queryDeps(queries, fetchResult))

	expect(posts).toHaveLength(0)
	const scheduled = queries[0]!.content?.[0] as BinaryNode
	expect(scheduled.attrs.count).toBe('100')
	const before = scheduled.content?.[0] as BinaryNode
	expect(before.tag).toBe('scheduled_messages')
	expect(before.attrs.before).toBe('12345')
})

it('refuses a fetch with an out-of-range count or before cursor', async () => {
	const deps = queryDeps([], emptyResult)
	await expect(fetchChannelScheduledPosts(channelJid, { count: 0 }, deps)).rejects.toThrow('count must be between 1 and 100')
	await expect(fetchChannelScheduledPosts(channelJid, { count: 101 }, deps)).rejects.toThrow('count must be between 1 and 100')
	await expect(fetchChannelScheduledPosts(channelJid, { count: 20, before: '98' }, deps)).rejects.toThrow(
		'before must be a scheduled message id between 99 and 2147476647'
	)
	await expect(fetchChannelScheduledPosts(channelJid, { count: 20, before: '2147476648' }, deps)).rejects.toThrow(
		'before must be a scheduled message id between 99 and 2147476647'
	)
})

it('decodes a plain (unwrapped) record and ignores a record with no id', () => {
	const plain: BinaryNode = {
		tag: 'message',
		attrs: { id: 'PLAINID', server_id: '44', t: '1794223368' },
		content: [
			{ tag: 'meta', attrs: { type: 'scheduled_message', st: '1794226968' } },
			{
				tag: 'plaintext',
				attrs: {},
				content: Buffer.from(proto.Message.encode({ conversation: 'plain record' }).finish())
			}
		]
	}
	const post = decodeChannelScheduledPost(plain, channelJid)
	expect(post?.text).toBe('plain record')
	expect(post?.scheduledMessageId).toBe('44')

	expect(decodeChannelScheduledPost({ tag: 'message', attrs: {}, content: [] }, channelJid)).toBeUndefined()
})
