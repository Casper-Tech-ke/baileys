import { crc32, createZip } from '../../Utils/zip'

// Minimal ZIP reader for the tests: walks the central directory and
// returns each entry's name, CRC and data (STORE entries only).
const readZip = (zip: Buffer) => {
	const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
	expect(endOffset).toBeGreaterThanOrEqual(0)
	const totalEntries = zip.readUInt16LE(endOffset + 10)
	const centralOffset = zip.readUInt32LE(endOffset + 16)

	const entries: { name: string; crc: number; size: number; data: Buffer }[] = []
	let offset = centralOffset
	for (let i = 0; i < totalEntries; i++) {
		expect(zip.readUInt32LE(offset)).toBe(0x02014b50)
		const crc = zip.readUInt32LE(offset + 16)
		const size = zip.readUInt32LE(offset + 24)
		const nameLen = zip.readUInt16LE(offset + 28)
		const extraLen = zip.readUInt16LE(offset + 30)
		const commentLen = zip.readUInt16LE(offset + 32)
		const localOffset = zip.readUInt32LE(offset + 42)
		const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString('utf-8')

		expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50)
		const localNameLen = zip.readUInt16LE(localOffset + 26)
		const localExtraLen = zip.readUInt16LE(localOffset + 28)
		const dataStart = localOffset + 30 + localNameLen + localExtraLen
		const data = zip.subarray(dataStart, dataStart + size)

		entries.push({ name, crc, size, data })
		offset += 46 + nameLen + extraLen + commentLen
	}

	return entries
}

describe('crc32', () => {
	it('returns 0 for empty input', () => {
		expect(crc32(Buffer.alloc(0))).toBe(0)
	})

	it('matches the standard check value for "123456789"', () => {
		expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
	})
})

describe('createZip', () => {
	it('produces a valid ZIP whose entries round-trip', () => {
		const sticker = Buffer.from('RIFF....WEBP fake sticker bytes')
		const tray = Buffer.from('PNG fake tray icon bytes')
		const zip = createZip([
			{ name: 'sticker-0.webp', data: sticker },
			{ name: 'tray.png', data: tray }
		])

		const entries = readZip(zip)
		expect(entries.map(e => e.name)).toEqual(['sticker-0.webp', 'tray.png'])
		expect(entries[0]!.data.equals(sticker)).toBe(true)
		expect(entries[1]!.data.equals(tray)).toBe(true)
		expect(entries[0]!.crc).toBe(crc32(sticker))
		expect(entries[1]!.crc).toBe(crc32(tray))
	})

	it('handles an empty entry list', () => {
		const zip = createZip([])
		expect(readZip(zip)).toEqual([])
	})
})
