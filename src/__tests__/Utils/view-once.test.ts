import { proto } from '../../../WAProto/index.js'
import { generateWAMessageContent, isViewOnceMessage } from '../../Utils/messages'

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

describe('isViewOnceMessage', () => {
	const image = { imageMessage: { caption: 'hi' } }

	it('detects every view once wrapper', () => {
		expect(isViewOnceMessage({ viewOnceMessage: { message: image } })).toBe(true)
		expect(isViewOnceMessage({ viewOnceMessageV2: { message: image } })).toBe(true)
		expect(isViewOnceMessage({ viewOnceMessageV2Extension: { message: { audioMessage: { ptt: true } } } })).toBe(true)
		expect(isViewOnceMessage({ viewOnceMessage: { message: { ptvMessage: { seconds: 5 } } } })).toBe(true)
	})

	it('looks through a disappearing message wrapper', () => {
		expect(isViewOnceMessage({ ephemeralMessage: { message: { viewOnceMessageV2: { message: image } } } })).toBe(true)
		expect(isViewOnceMessage({ ephemeralMessage: { message: image } })).toBe(false)
	})

	it('ignores view once wrappers around non-media content', () => {
		const buttons = { buttonsMessage: { contentText: 'pick one' } }
		expect(isViewOnceMessage({ viewOnceMessage: { message: buttons } })).toBe(false)
		expect(isViewOnceMessage({ viewOnceMessageV2: { message: { conversation: 'hi' } } })).toBe(false)
		expect(isViewOnceMessage({ viewOnceMessage: {} })).toBe(false)
	})

	it('ignores regular and empty content', () => {
		expect(isViewOnceMessage(image)).toBe(false)
		expect(isViewOnceMessage({ conversation: 'hello' })).toBe(false)
		expect(isViewOnceMessage(undefined)).toBe(false)
		expect(isViewOnceMessage(null)).toBe(false)
	})

	it('works on decoded protobuf messages', () => {
		const encoded = proto.Message.encode({ viewOnceMessageV2: { message: image } }).finish()
		expect(isViewOnceMessage(proto.Message.decode(encoded))).toBe(true)
		const plain = proto.Message.encode({ conversation: 'hello' }).finish()
		expect(isViewOnceMessage(proto.Message.decode(plain))).toBe(false)
	})
})

describe('generateWAMessageContent view once', () => {
	it('wraps an image in the V1 envelope with the inner viewOnce flag', async () => {
		const m = await generateWAMessageContent(
			{ image: TINY_JPEG, jpegThumbnail: JPEG_B64, caption: 'hi', viewOnce: true },
			OPTS
		)
		expect(m.viewOnceMessage).toBeTruthy()
		expect(m.viewOnceMessage?.message?.imageMessage).toBeTruthy()
		// the media build carries the flag onto the inner message itself
		expect(m.viewOnceMessage?.message?.imageMessage?.viewOnce).toBe(true)
	})

	it('wraps text in V2 with the inner viewOnce flag', async () => {
		const m = await generateWAMessageContent({ text: 'secret', viewOnceV2: true }, OPTS)
		expect(m.viewOnceMessageV2).toBeTruthy()
		expect(m.viewOnceMessageV2?.message?.extendedTextMessage?.viewOnce).toBe(true)
		// wire round-trip: the envelope and the flag survive the real proto
		const dec = wireRoundTrip(m)
		expect(dec.viewOnceMessageV2?.message?.extendedTextMessage?.viewOnce).toBe(true)
	})

	it('wraps an image in V2 with the inner viewOnce flag', async () => {
		const m = await generateWAMessageContent(
			{ image: TINY_JPEG, jpegThumbnail: JPEG_B64, caption: 'hi', viewOnceV2: true },
			OPTS
		)
		expect(m.viewOnceMessageV2?.message?.imageMessage?.viewOnce).toBe(true)
	})

	it('wraps a video in V2 with the inner viewOnce flag', async () => {
		const m = await generateWAMessageContent(
			{ video: Buffer.from('fake-video-bytes'), jpegThumbnail: JPEG_B64, viewOnceV2: true },
			OPTS
		)
		expect(m.viewOnceMessageV2?.message?.videoMessage?.viewOnce).toBe(true)
	})

	it('wraps a voice note in the V2 extension with the inner viewOnce flag', async () => {
		const m = await generateWAMessageContent(
			{ audio: tinyWav(), ptt: true, seconds: 1, waveform: Buffer.from([0, 1, 2]), viewOnceV2Extension: true },
			OPTS
		)
		expect(m.viewOnceMessageV2Extension?.message?.audioMessage?.viewOnce).toBe(true)
		expect(m.viewOnceMessageV2Extension?.message?.audioMessage?.ptt).toBe(true)
	})

	it('wraps a round video in V2 with the inner viewOnce flag on ptvMessage', async () => {
		const m = await generateWAMessageContent(
			{ video: Buffer.from('fake-ptv-bytes'), ptv: true, jpegThumbnail: JPEG_B64, viewOnceV2: true },
			OPTS
		)
		expect(m.viewOnceMessageV2?.message?.ptvMessage?.viewOnce).toBe(true)
		expect(m.viewOnceMessageV2?.message?.videoMessage).toBeFalsy()
	})
})
