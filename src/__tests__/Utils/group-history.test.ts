import { Reader } from 'protobufjs/minimal'
import { proto } from '../../../WAProto/index.js'
import { encodeGroupHistoryBundle } from '../../Utils/group-history.js'

describe('encodeGroupHistoryBundle', () => {
	const makeInfo = (id: string, text: string, ts: number): proto.IWebMessageInfo => ({
		key: { remoteJid: '120363432773315685@g.us', fromMe: false, id, participant: '254181847643@s.whatsapp.net' },
		message: { conversation: text },
		messageTimestamp: ts,
		pushName: 'sikimo'
	})

	it('encodes messages as an Ft1 bundle with Fsf key+message pairs', () => {
		const infos = [makeInfo('MSG1', 'hello', 1794560000), makeInfo('MSG2', 'world', 1794560060)]
		const buf = encodeGroupHistoryBundle(infos)
		expect(buf.length).toBeGreaterThan(0)

		// Decode the Ft1 by hand: field 1 (0x0A) = repeated Fsf
		const reader = Reader.create(buf)
		const fsfs: Buffer[] = []
		while (reader.pos < reader.len) {
			const tag = reader.uint32()
			expect(tag).toBe(0x0a)
			fsfs.push(Buffer.from(reader.bytes()))
		}
		expect(fsfs).toHaveLength(2)

		// Each Fsf: field 1 (0x0A) = key, field 2 (0x12) = message
		fsfs.forEach((fsfBuf, i) => {
			const r = Reader.create(fsfBuf)
			let keyBytes: Buffer | undefined
			let msgBytes: Buffer | undefined
			while (r.pos < r.len) {
				const t = r.uint32()
				if (t === 0x0a) keyBytes = Buffer.from(r.bytes())
				else if (t === 0x12) msgBytes = Buffer.from(r.bytes())
				else throw new Error(`unexpected Fsf tag ${t}`)
			}
			expect(keyBytes).toBeDefined()
			expect(msgBytes).toBeDefined()
			const key = proto.MessageKey.decode(keyBytes!)
			expect(key.id).toBe(infos[i].key!.id)
			expect(key.remoteJid).toBe('120363432773315685@g.us')
			const info = proto.WebMessageInfo.decode(msgBytes!)
			expect(info.message?.conversation).toBe(infos[i].message?.conversation)
			expect(Number(info.messageTimestamp)).toBe(infos[i].messageTimestamp)
		})
	})

	it('skips messages without a key', () => {
		const infos: proto.IWebMessageInfo[] = [
			{ message: { conversation: 'no key' }, messageTimestamp: 1 },
			makeInfo('MSG1', 'has key', 2)
		]
		const buf = encodeGroupHistoryBundle(infos)
		const reader = Reader.create(buf)
		let count = 0
		while (reader.pos < reader.len) {
			reader.uint32()
			reader.bytes()
			count++
		}
		expect(count).toBe(1)
	})

	it('returns an empty buffer for no messages', () => {
		expect(encodeGroupHistoryBundle([]).length).toBe(0)
	})
})
