import { jest } from '@jest/globals'
import fs from 'fs/promises'
import { sendStickerPack } from '../../Socket/stickerPack'
import type { StickerPack } from '../../Types/StickerPack'
import { encryptedStream } from '../../Utils/messages-media'

const JID = '254143947797@s.whatsapp.net'
const USER_JID = '254181847643@s.whatsapp.net'

const makePack = (overrides: Partial<StickerPack> = {}): StickerPack => ({
	name: 'Test Pack',
	publisher: 'wolfsocket',
	description: 'a test pack',
	stickers: [
		{ data: Buffer.from('RIFF....WEBP sticker one'), emojis: ['😀'] },
		{ data: Buffer.from('RIFF....WEBP sticker two'), emojis: ['😂'], isAnimated: true }
	],
	trayIcon: Buffer.from('PNG tray icon'),
	...overrides
})

describe('sendStickerPack', () => {
	const relayMessage = jest.fn(async () => {})
	const upload = jest.fn(async () => ({ mediaUrl: 'https://mmg.whatsapp.net/d/fake', directPath: 'fake-direct-path' }))

	beforeEach(() => {
		jest.clearAllMocks()
	})

	const deps = { relayMessage, upload, userJid: USER_JID } as any

	it('rejects a pack with no stickers', async () => {
		await expect(sendStickerPack(JID, makePack({ stickers: [] }), deps)).rejects.toThrow('1-60 stickers')
	})

	it('rejects a pack with more than 60 stickers', async () => {
		const stickers = Array.from({ length: 61 }, (_, i) => ({ data: Buffer.from(`sticker ${i}`) }))
		await expect(sendStickerPack(JID, makePack({ stickers }), deps)).rejects.toThrow('1-60 stickers')
	})

	it('rejects a pack with no name or publisher', async () => {
		await expect(sendStickerPack(JID, makePack({ name: '' }), deps)).rejects.toThrow('name and a publisher')
		await expect(sendStickerPack(JID, makePack({ publisher: '' }), deps)).rejects.toThrow('name and a publisher')
	})

	it('uploads the ZIP as sticker-pack and the tray icon as thumbnail-sticker-pack, then relays the pack message', async () => {
		const { message, stickerPackId } = await sendStickerPack(JID, makePack(), deps)

		expect(stickerPackId).toMatch(/^[0-9a-f-]{36}$/)
		expect(message.key.remoteJid).toBe(JID)

		// two uploads: the pack ZIP, then the tray icon
		expect(upload).toHaveBeenCalledTimes(2)
		expect(upload.mock.calls[0]![1].mediaType).toBe('sticker-pack')
		expect(upload.mock.calls[1]![1].mediaType).toBe('thumbnail-sticker-pack')

		expect(relayMessage).toHaveBeenCalledTimes(1)
		const [relayJid, relayed] = relayMessage.mock.calls[0]!
		expect(relayJid).toBe(JID)

		const packMsg = (relayed as any).stickerPackMessage
		expect(packMsg.stickerPackId).toBe(stickerPackId)
		expect(packMsg.name).toBe('Test Pack')
		expect(packMsg.publisher).toBe('wolfsocket')
		expect(packMsg.packDescription).toBe('a test pack')
		expect(packMsg.stickers).toHaveLength(2)
		expect(packMsg.stickers[0].fileName).toBe('sticker-0.webp')
		expect(packMsg.stickers[0].emojis).toEqual(['😀'])
		expect(packMsg.stickers[1].isAnimated).toBe(true)
		expect(packMsg.trayIconFileName).toBe('tray.png')
		expect(packMsg.stickerPackOrigin).toBe(1) // THIRD_PARTY
		expect(packMsg.directPath).toBe('fake-direct-path')
		expect(packMsg.thumbnailDirectPath).toBe('fake-direct-path')
		expect(packMsg.mediaKey).toBeInstanceOf(Buffer)
		expect(packMsg.mediaKey.length).toBe(32)
		expect(packMsg.fileSha256).toBeInstanceOf(Buffer)
		expect(packMsg.fileEncSha256).toBeInstanceOf(Buffer)
		expect(packMsg.thumbnailSha256).toBeInstanceOf(Buffer)
		expect(packMsg.thumbnailEncSha256).toBeInstanceOf(Buffer)
		expect(packMsg.fileLength).toBeGreaterThan(0)
		expect(packMsg.stickerPackSize).toBeGreaterThan(0)
	})

	it('uses the provided pack id and origin', async () => {
		await sendStickerPack(JID, makePack({ stickerPackId: 'my-pack-id', origin: 'USER_CREATED' }), deps)
		const packMsg = (relayMessage.mock.calls[0]![1] as any).stickerPackMessage
		expect(packMsg.stickerPackId).toBe('my-pack-id')
		expect(packMsg.stickerPackOrigin).toBe(2) // USER_CREATED
	})
})

describe('encryptedStream mediaKey option', () => {
	it('reuses a provided media key instead of generating a random one', async () => {
		const mediaKey = Buffer.alloc(32, 7)
		const first = await encryptedStream(Buffer.from('hello'), 'sticker-pack', { mediaKey })
		const second = await encryptedStream(Buffer.from('hello'), 'thumbnail-sticker-pack', { mediaKey })
		try {
			expect(first.mediaKey.equals(mediaKey)).toBe(true)
			expect(second.mediaKey.equals(mediaKey)).toBe(true)
			expect(first.fileEncSha256.equals(second.fileEncSha256)).toBe(false) // different HKDF info
		} finally {
			await fs.unlink(first.encFilePath).catch(() => {})
			await fs.unlink(second.encFilePath).catch(() => {})
		}
	})
})
