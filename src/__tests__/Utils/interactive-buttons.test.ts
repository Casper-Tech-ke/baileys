import { proto } from '../../../WAProto/index.js'
import { getBizBinaryNode, type BinaryNode } from '../../WABinary'
import {
	generateWAMessageContent,
	hasValidInteractiveHeader,
	prepareNativeFlowButtons,
	shouldIncludeBizBinaryNode
} from '../../Utils/messages'

const JPEG_B64 =
	'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAIAAgDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q=='
const TINY_JPEG = Buffer.from(JPEG_B64, 'base64')

// minimal valid WAV: 44-byte header, 8kHz mono 16-bit, 400 silent samples
function tinyWav() {
	const dataSize = 800
	const buf = Buffer.alloc(44 + dataSize)
	buf.write('RIFF', 0)
	buf.writeUInt32LE(36 + dataSize, 4)
	buf.write('WAVE', 8)
	buf.write('fmt ', 12)
	buf.writeUInt32LE(16, 16)
	buf.writeUInt16LE(1, 20)
	buf.writeUInt16LE(1, 22)
	buf.writeUInt32LE(8000, 24)
	buf.writeUInt32LE(16000, 28)
	buf.writeUInt16LE(2, 32)
	buf.writeUInt16LE(16, 34)
	buf.write('data', 36)
	buf.writeUInt32LE(dataSize, 40)
	return buf
}

const upload = async () => ({ mediaUrl: 'https://mmg.test/enc', directPath: '/v/t62/enc' })
const OPTS = { upload } as never

/** encode + decode round-trip through the real wire format */
const wireRoundTrip = (m: proto.IMessage) => proto.Message.decode(proto.Message.encode(m).finish())

describe('prepareNativeFlowButtons', () => {
	it('maps all button shorthands', () => {
		const { buttons, messageParamsJson } = prepareNativeFlowButtons({
			nativeFlow: [
				{ text: 'Reply', id: 'r1', icon: 'reply' },
				{ text: 'Copy', copy: 'CODE-1', icon: 'copy' },
				{ text: 'Open', url: 'https://example.com', useWebview: true, icon: 'url' },
				{ text: 'Call', call: '+62111', icon: 'call' },
				{ text: 'Menu', sections: [{ title: 'S', rows: [{ title: 'a', id: 'a' }] }] },
				{ name: 'custom_flow', buttonParamsJson: '{"x":1}' }
			]
		})
		expect(buttons!.length).toBe(6)
		expect(JSON.parse(buttons![0]!.buttonParamsJson!)).toEqual({ display_text: 'Reply', id: 'r1', icon: 'REPLY' })
		expect(buttons![0]!.name).toBe('quick_reply')
		expect(JSON.parse(buttons![1]!.buttonParamsJson!)).toEqual({ display_text: 'Copy', copy_code: 'CODE-1', icon: 'COPY' })
		expect(buttons![1]!.name).toBe('cta_copy')
		expect(JSON.parse(buttons![2]!.buttonParamsJson!)).toEqual({
			display_text: 'Open',
			url: 'https://example.com',
			merchant_url: 'https://example.com',
			webview_interaction: true,
			icon: 'URL'
		})
		expect(buttons![2]!.name).toBe('cta_url')
		expect(JSON.parse(buttons![3]!.buttonParamsJson!)).toEqual({ display_text: 'Call', phone_number: '+62111', icon: 'CALL' })
		expect(buttons![3]!.name).toBe('cta_call')
		expect(buttons![4]!.name).toBe('single_select')
		expect(JSON.parse(buttons![4]!.buttonParamsJson!).sections[0].rows[0].title).toBe('a')
		// raw rows pass through untouched
		expect(buttons![5]).toEqual({ name: 'custom_flow', buttonParamsJson: '{"x":1}' })
		expect(messageParamsJson).toBe('{}')
	})

	it('adds offer + bottom-sheet extras', () => {
		const { messageParamsJson } = prepareNativeFlowButtons({
			nativeFlow: [{ id: 'a' }, { id: 'b' }],
			offerText: 'Sale!',
			offerUrl: 'https://shop.example',
			offerCode: 'PROMO',
			offerExpiration: 123,
			optionText: 'See options',
			optionTitle: 'Pick one'
		})
		const params = JSON.parse(messageParamsJson!)
		expect(params.limited_time_offer).toEqual({
			text: 'Sale!',
			url: 'https://shop.example',
			copy_code: 'PROMO',
			expiration_time: 123
		})
		expect(params.bottom_sheet.in_thread_buttons_limit).toBe(1)
		expect(params.bottom_sheet.divider_indices).toEqual([0, 1])
		expect(params.bottom_sheet.list_title).toBe('Pick one')
		expect(params.bottom_sheet.button_title).toBe('See options')
	})

	it('accepts { buttons: [...] } object form', () => {
		const { buttons } = prepareNativeFlowButtons({ nativeFlow: { buttons: [{ id: 'x', text: 'T' }] } })
		expect(buttons![0]!.name).toBe('quick_reply')
		expect(JSON.parse(buttons![0]!.buttonParamsJson!).id).toBe('x')
	})
})

describe('shouldIncludeBizBinaryNode', () => {
	it('covers all interactive shapes', () => {
		expect(shouldIncludeBizBinaryNode({ buttonsMessage: {} })).toBe(true)
		expect(shouldIncludeBizBinaryNode({ listMessage: {} })).toBe(true)
		expect(shouldIncludeBizBinaryNode({ templateMessage: {} })).toBe(true)
		expect(shouldIncludeBizBinaryNode({ interactiveMessage: { nativeFlowMessage: {} } })).toBe(true)
		expect(shouldIncludeBizBinaryNode({ interactiveMessage: {} })).toBe(false)
		expect(shouldIncludeBizBinaryNode({ extendedTextMessage: {} })).toBe(false)
	})
})

describe('getBizBinaryNode', () => {
	it('selects the right biz payload', () => {
		const list = getBizBinaryNode({ listMessage: {} })
		expect(list.tag).toBe('biz')
		const listNodes = list.content as BinaryNode[]
		expect(listNodes[0]!.tag).toBe('list')
		expect(listNodes[0]!.attrs.type).toBe('product_list')
		expect(listNodes[1]!.tag).toBe('quality_control')

		const mixed = getBizBinaryNode({ buttonsMessage: {} })
		const mixedFlow = (mixed.content as any[]).find(n => n.tag === 'interactive')
		expect(mixedFlow.content[0].attrs.name).toBe('mixed')

		const flow = getBizBinaryNode({
			interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'mpm' }] } }
		})
		const flowNode = (flow.content as any[]).find(n => n.tag === 'interactive')
		expect(flowNode.content[0].attrs.name).toBe('mpm')
		expect(flowNode.content[0].attrs.v).toBe('2')

		const pay = getBizBinaryNode({
			interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'review_and_pay' }] } }
		})
		expect(pay.attrs.native_flow_name).toBe('order_details')

		const fallback = getBizBinaryNode({ extendedTextMessage: {} })
		expect(fallback.tag).toBe('biz')
		const fallbackNodes = fallback.content as BinaryNode[]
		expect(fallbackNodes.length).toBe(1)
		expect(fallbackNodes[0]!.tag).toBe('quality_control')
	})

	it('returns the mixed node for cta_url / cta_copy first buttons', () => {
		const url = getBizBinaryNode({
			interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'cta_url' }] } }
		})
		const urlFlow = (url.content as any[]).find(n => n.tag === 'interactive')
		expect(urlFlow.content[0].attrs.name).toBe('mixed')
		const copy = getBizBinaryNode({
			interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'cta_copy' }] } }
		})
		const copyFlow = (copy.content as any[]).find(n => n.tag === 'interactive')
		expect(copyFlow.content[0].attrs.name).toBe('mixed')
	})
})

describe('hasValidInteractiveHeader', () => {
	it('accepts image/video/document/product/location, rejects audio', () => {
		expect(hasValidInteractiveHeader({ imageMessage: {} })).toBe(true)
		expect(hasValidInteractiveHeader({ videoMessage: {} })).toBe(true)
		expect(hasValidInteractiveHeader({ documentMessage: {} })).toBe(true)
		expect(hasValidInteractiveHeader({ productMessage: {} })).toBe(true)
		expect(hasValidInteractiveHeader({ locationMessage: {} })).toBe(true)
		expect(hasValidInteractiveHeader({ audioMessage: {} })).toBe(false)
		expect(hasValidInteractiveHeader({})).toBe(false)
	})
})

describe('generateWAMessageContent with nativeFlow', () => {
	it('builds a text-only interactive message', async () => {
		const m = await generateWAMessageContent(
			{
				nativeFlow: [{ id: 'r1', text: 'Yes' }],
				text: 'body text',
				footer: 'foot'
			},
			OPTS
		)
		const im = m.interactiveMessage
		expect(im).toBeTruthy()
		expect(im!.body?.text).toBe('body text')
		expect(im!.footer?.text).toBe('foot')
		expect(im!.nativeFlowMessage?.buttons?.[0]?.name).toBe('quick_reply')
		expect(im!.nativeFlowMessage?.messageParamsJson).toBe('{}')
		// wire round-trip: the proto really carries it
		const dec = wireRoundTrip(m)
		expect(dec.interactiveMessage?.nativeFlowMessage?.buttons?.length).toBe(1)
		expect(dec.interactiveMessage?.body?.text).toBe('body text')
	})

	it('builds the .tourl shape: cta_url + cta_copy', async () => {
		const m = await generateWAMessageContent(
			{
				text: 'Here is your file:',
				footer: 'tourl',
				interactiveButtons: [
					{ text: 'Open file', url: 'https://u.pone.rs/hbfrzbrb.png' },
					{ text: 'Copy link', copy: 'https://u.pone.rs/hbfrzbrb.png' }
				]
			},
			OPTS
		)
		const im = m.interactiveMessage
		expect(im).toBeTruthy()
		expect(im!.body?.text).toBe('Here is your file:')
		expect(im!.footer?.text).toBe('tourl')
		const buttons = im!.nativeFlowMessage?.buttons ?? []
		expect(buttons.length).toBe(2)
		expect(buttons[0]!.name).toBe('cta_url')
		expect(JSON.parse(buttons[0]!.buttonParamsJson!).url).toBe('https://u.pone.rs/hbfrzbrb.png')
		expect(buttons[1]!.name).toBe('cta_copy')
		expect(JSON.parse(buttons[1]!.buttonParamsJson!).copy_code).toBe('https://u.pone.rs/hbfrzbrb.png')
		const dec = wireRoundTrip(m)
		expect(dec.interactiveMessage?.nativeFlowMessage?.buttons?.length).toBe(2)
	})

	it('interactiveButtons is an alias for nativeFlow', async () => {
		const a = await generateWAMessageContent(
			{ nativeFlow: [{ id: 'r1', text: 'Yes' }], text: 'same' },
			OPTS
		)
		const b = await generateWAMessageContent(
			{ interactiveButtons: [{ id: 'r1', text: 'Yes' }], text: 'same' },
			OPTS
		)
		expect(JSON.stringify(b.interactiveMessage)).toBe(JSON.stringify(a.interactiveMessage))
	})

	it('merges an image header, rejects an audio header', async () => {
		const ok = await generateWAMessageContent(
			{
				image: TINY_JPEG,
				jpegThumbnail: JPEG_B64,
				caption: 'pic caption',
				title: 'hdr',
				nativeFlow: [{ id: 'r1', text: 'Yes' }]
			},
			OPTS
		)
		const im = ok.interactiveMessage
		expect(im!.header?.title).toBe('hdr')
		expect(im!.header?.hasMediaAttachment).toBe(true)
		expect(im!.header?.imageMessage).toBeTruthy()
		expect(im!.body?.text).toBe('pic caption')
		await expect(
			generateWAMessageContent(
				{ audio: tinyWav(), seconds: 1, caption: 'x', nativeFlow: [{ id: 'r' }] },
				OPTS
			)
		).rejects.toThrow('Invalid media type for interactive message header')
	})
})
