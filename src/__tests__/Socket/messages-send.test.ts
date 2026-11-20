import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import makeWASocket from '../../Socket'
import { buildStatusViewKey, closeFriendsStatusContent } from '../../Socket/messages-send'
import type { WAMessageKey } from '../../Types/Message'
import type { PossiblyExtendedCacheStore } from '../../Types/Socket'
import { generateWAMessageContent } from '../../Utils/messages.js'
import { makeSession, mockWebSocket } from '../TestUtils/session'

mockWebSocket()

type WebSocketSend = (data: Uint8Array | Buffer, callback: (error?: Error | null) => void) => void

const RETRY_PARTICIPANT = '2222222222:3@lid'

async function makeTestSocket(
	overrides: {
		getMessage?: (key: WAMessageKey) => Promise<proto.IMessage | undefined>
		userDevicesCache?: PossiblyExtendedCacheStore
		lidMappings?: Record<string, string>
	} = {}
) {
	const { state, clear } = await makeSession()
	state.creds.me = {
		id: '1111111111:1@s.whatsapp.net',
		lid: '1111111111:1@lid',
		name: 'Test User'
	}
	state.creds.account = {}

	// pre-seeded PN -> LID mappings so the send skips the live USync lookup
	if (overrides.lidMappings) {
		await state.keys.set({ 'lid-mapping': overrides.lidMappings })
	}

	const sock = makeWASocket({
		...DEFAULT_CONNECTION_CONFIG,
		auth: state,
		shouldSyncHistoryMessage: () => false,
		...overrides
	})

	// swap the raw socket for an open in-memory one, so relayMessage can "send" offline
	const client = sock.ws as unknown as { socket: unknown }
	const real = client.socket as {
		on: (e: string, f: () => void) => void
		removeAllListeners: () => void
		terminate: () => void
	} | null
	if (real) {
		real.removeAllListeners()
		real.on('error', () => {})
		real.terminate()
	}

	let onClose: (() => void) | undefined
	client.socket = {
		readyState: 1,
		send: jest.fn<WebSocketSend>((_data, callback) => callback()),
		once: (event: string, listener: () => void) => {
			if (event === 'close') onClose = listener
		},
		close: () => onClose?.()
	}

	const validateSession = jest.spyOn(sock.signalRepository, 'validateSession').mockResolvedValue({ exists: true })
	const encryptMessage = jest.spyOn(sock.signalRepository, 'encryptMessage').mockResolvedValue({
		type: 'msg',
		ciphertext: Buffer.from('encrypted')
	})
	jest.spyOn(sock.signalRepository, 'hasSenderKey').mockResolvedValue(false)

	const close = async () => {
		await sock.end(new Error('Test completed'))
		await clear()
	}

	return { sock, validateSession, encryptMessage, close }
}

describe('relayMessage retry resend', () => {
	it('encrypts a device-specific 1:1 retry exactly once', async () => {
		const { sock, validateSession, encryptMessage, close } = await makeTestSocket()

		await sock.relayMessage(
			'2222222222@lid',
			{ conversation: 'hello' },
			{ messageId: 'retry-1on1', participant: { jid: RETRY_PARTICIPANT, count: 1 } }
		)

		expect(validateSession).toHaveBeenCalledWith(RETRY_PARTICIPANT)
		expect(encryptMessage).toHaveBeenCalledTimes(1)
		expect(encryptMessage).toHaveBeenCalledWith(expect.objectContaining({ jid: RETRY_PARTICIPANT }))

		await close()
	})

	it('encrypts a group retry for one participant device exactly once', async () => {
		const { sock, validateSession, encryptMessage, close } = await makeTestSocket()

		await sock.relayMessage(
			'120363000000000000@g.us',
			{ conversation: 'hello group' },
			{ messageId: 'retry-group', participant: { jid: RETRY_PARTICIPANT, count: 2 } }
		)

		expect(validateSession).toHaveBeenCalledWith(RETRY_PARTICIPANT)
		expect(encryptMessage).toHaveBeenCalledTimes(1)
		expect(encryptMessage).toHaveBeenCalledWith(expect.objectContaining({ jid: RETRY_PARTICIPANT }))

		await close()
	})
})

const PIN_KEY = { remoteJid: '254143947797@s.whatsapp.net', fromMe: true, id: '3EB0PINMSG000000000001' }
const STATUS_KEY = {
	remoteJid: 'status@broadcast',
	fromMe: false,
	id: '3EB0STATUS000000000001',
	participant: '254732982940@s.whatsapp.net'
}
const noUpload = async () => {
	throw new Error('no upload expected for these contents')
}

describe('pin message content', () => {
	it('builds a pin message with key, type and duration', async () => {
		const message = await generateWAMessageContent(
			{ pin: PIN_KEY, type: proto.PinInChat.Type.PIN_FOR_ALL, time: 86400 },
			{ upload: noUpload }
		)
		expect(message.pinInChatMessage?.key).toEqual(PIN_KEY)
		expect(message.pinInChatMessage?.type).toBe(proto.PinInChat.Type.PIN_FOR_ALL)
		expect(message.messageContextInfo?.messageAddOnDurationInSecs).toBe(86400)
	})

	it('builds an unpin message with zero duration', async () => {
		const message = await generateWAMessageContent(
			{ pin: PIN_KEY, type: proto.PinInChat.Type.UNPIN_FOR_ALL },
			{ upload: noUpload }
		)
		expect(message.pinInChatMessage?.key).toEqual(PIN_KEY)
		expect(message.pinInChatMessage?.type).toBe(proto.PinInChat.Type.UNPIN_FOR_ALL)
		expect(message.messageContextInfo?.messageAddOnDurationInSecs).toBe(0)
	})
})

describe('close friends status content', () => {
	it('marks a text status with the close-friends audience', async () => {
		const message = await generateWAMessageContent(closeFriendsStatusContent({ text: 'Close friends test' }), {
			upload: noUpload
		})
		expect(message.extendedTextMessage?.text).toBe('Close friends test')
		expect(message.extendedTextMessage?.contextInfo?.statusAudienceMetadata?.audienceType).toBe(
			proto.ContextInfo.StatusAudienceMetadata.AudienceType.CLOSE_FRIENDS
		)
	})

	it('keeps existing context info on the content', async () => {
		const content = closeFriendsStatusContent({
			text: 'Hello',
			contextInfo: { stanzaId: '3EB0QUOTED000000000001' }
		})
		expect('contextInfo' in content && content.contextInfo?.stanzaId).toBe('3EB0QUOTED000000000001')
		expect('contextInfo' in content && content.contextInfo?.statusAudienceMetadata?.audienceType).toBe(1)
		const message = await generateWAMessageContent(content, { upload: noUpload })
		expect(message.extendedTextMessage?.contextInfo?.stanzaId).toBe('3EB0QUOTED000000000001')
		expect(message.extendedTextMessage?.contextInfo?.statusAudienceMetadata?.audienceType).toBe(1)
	})
})

describe('status reaction content', () => {
	it('builds a reaction message with the status key and emoji', async () => {
		const message = await generateWAMessageContent(
			{ react: { key: STATUS_KEY, text: '❤️' } },
			{
				upload: noUpload
			}
		)
		expect(message.reactionMessage?.key).toEqual(STATUS_KEY)
		expect(message.reactionMessage?.text).toBe('❤️')
	})
})

describe('buildStatusViewKey', () => {
	it('marks the key as someone else’s message with the author as participant', () => {
		expect(
			buildStatusViewKey(
				{ remoteJid: 'status@broadcast', fromMe: true, id: '3EB0STATUS000000000001' },
				'254732982940@s.whatsapp.net'
			)
		).toEqual({
			remoteJid: 'status@broadcast',
			fromMe: false,
			id: '3EB0STATUS000000000001',
			participant: '254732982940@s.whatsapp.net'
		})
	})

	it('keeps an undefined participant when none is given', () => {
		const key = buildStatusViewKey(
			{ remoteJid: '120363415416276985@g.us', fromMe: true, id: '3EB0GROUPSTATUS000001' },
			undefined
		)
		expect(key.participant).toBeUndefined()
		expect(key.fromMe).toBe(false)
	})
})

describe('pinMessage safety', () => {
	const CHAT_JID = '254143947797@s.whatsapp.net'

	it('sends the pin when the message exists in the chat', async () => {
		const getMessage = jest.fn(async (key: WAMessageKey) =>
			key.id === PIN_KEY.id ? { conversation: 'hello to pin' } : undefined
		)
		// pre-seeded device cache so the send skips the live device lookup
		const userDevicesCache: PossiblyExtendedCacheStore = {
			get: async () => undefined,
			set: async () => {},
			del: async () => {},
			flushAll: async () => {},
			mget: async () => ({
				// target chat + our own device (relayMessage re-enumerates both)
				'254143947797': [{ user: '254143947797', server: 's.whatsapp.net', device: 0 }],
				'1111111111': [{ user: '1111111111', server: 's.whatsapp.net', device: 1 }]
			})
		}
		const { sock, close } = await makeTestSocket({
			getMessage,
			userDevicesCache,
			lidMappings: { '254143947797': '33333333333333', '1111111111': '1111111111' }
		})

		const sent = await sock.pinMessage(CHAT_JID, PIN_KEY)

		expect(getMessage).toHaveBeenCalledWith({ ...PIN_KEY, remoteJid: CHAT_JID })
		expect(sent?.message?.pinInChatMessage?.key).toEqual(PIN_KEY)
		expect(sent?.message?.pinInChatMessage?.type).toBe(proto.PinInChat.Type.PIN_FOR_ALL)

		await close()
	})

	it('refuses to pin a message that is not in the chat', async () => {
		const getMessage = jest.fn(async () => undefined)
		const { sock, close } = await makeTestSocket({ getMessage })

		await expect(sock.pinMessage(CHAT_JID, PIN_KEY)).rejects.toThrow(
			`refusing to pin message ${PIN_KEY.id} in ${CHAT_JID}: message not found in this chat`
		)
		expect(getMessage).toHaveBeenCalledWith({ ...PIN_KEY, remoteJid: CHAT_JID })

		await close()
	})

	it('refuses to pin a message that belongs to another chat', async () => {
		const getMessage = jest.fn(async () => ({ conversation: 'somewhere else' }))
		const { sock, close } = await makeTestSocket({ getMessage })

		await expect(sock.pinMessage('120363415416276985@g.us', PIN_KEY)).rejects.toThrow(
			`refusing to pin message ${PIN_KEY.id}: it belongs to ${CHAT_JID}, not 120363415416276985@g.us`
		)
		expect(getMessage).not.toHaveBeenCalled()

		await close()
	})
})
