import { proto } from '../../../WAProto/index.js'
import { chatModificationToAppPatch } from '../../Utils/chat-utils.js'
import { generateWAMessageContent } from '../../Utils/messages.js'

const JID = '254143947797@s.whatsapp.net'
const KEY = { remoteJid: JID, fromMe: true, id: '3EB0DELETEME000000000000' }
const LAST_MESSAGES = [
	{ key: { remoteJid: JID, fromMe: true, id: '3EB0LASTMSG000000000001' }, messageTimestamp: 1794284000 },
	{ key: { remoteJid: JID, fromMe: false, id: '3EB0LASTMSG000000000002' }, messageTimestamp: 1794283900 }
]

describe('clearChat patch', () => {
	it('builds a clearChatAction patch with the message range', () => {
		const patch = chatModificationToAppPatch({ clear: true, lastMessages: LAST_MESSAGES }, JID)
		expect(patch.syncAction?.clearChatAction).toBeDefined()
		expect(patch.syncAction?.clearChatAction?.messageRange?.lastMessageTimestamp).toBe(1794283900)
		expect(patch.index).toEqual(['clearChat', JID, '1', '0'])
		expect(patch.type).toBe('regular_high')
	})

	it('clears starred messages by default (deleteStarred not given)', () => {
		const patch = chatModificationToAppPatch(
			{ clear: true, lastMessages: LAST_MESSAGES, deleteStarred: undefined },
			JID
		)
		expect(patch.index).toEqual(['clearChat', JID, '1', '0'])
	})

	it('keeps starred messages when deleteStarred is false', () => {
		const patch = chatModificationToAppPatch(
			{ clear: true, lastMessages: LAST_MESSAGES, deleteStarred: false },
			JID
		)
		expect(patch.syncAction?.clearChatAction).toBeDefined()
		expect(patch.index).toEqual(['clearChat', JID, '0', '0'])
	})
})

describe('deleteChat patch', () => {
	it('builds a deleteChatAction patch with the message range', () => {
		const patch = chatModificationToAppPatch({ delete: true, lastMessages: LAST_MESSAGES }, JID)
		expect(patch.syncAction?.deleteChatAction).toBeDefined()
		expect(patch.syncAction?.deleteChatAction?.messageRange?.lastMessageTimestamp).toBe(1794283900)
		expect(patch.index).toEqual(['deleteChat', JID, '1'])
		expect(patch.type).toBe('regular_high')
	})
})

describe('deleteMessageForMe patch', () => {
	it('builds a deleteMessageForMeAction patch with the key in the index', () => {
		const patch = chatModificationToAppPatch(
			{ deleteForMe: { deleteMedia: false, key: KEY, timestamp: 1794284000 } },
			JID
		)
		expect(patch.syncAction?.deleteMessageForMeAction).toEqual({
			deleteMedia: false,
			messageTimestamp: 1794284000
		})
		expect(patch.index).toEqual(['deleteMessageForMe', JID, KEY.id, '1', '0'])
		expect(patch.type).toBe('regular_high')
	})

	it('marks media for deletion when deleteMedia is true', () => {
		const patch = chatModificationToAppPatch(
			{ deleteForMe: { deleteMedia: true, key: KEY, timestamp: 1794284000 } },
			JID
		)
		expect(patch.syncAction?.deleteMessageForMeAction?.deleteMedia).toBe(true)
	})
})

describe('deleteMessage content', () => {
	it('builds a REVOKE protocol message for the key', async () => {
		const message = await generateWAMessageContent(
			{ delete: KEY },
			{
				upload: async () => {
					throw new Error('no upload for a delete')
				}
			}
		)
		expect(message.protocolMessage?.key).toEqual(KEY)
		expect(message.protocolMessage?.type).toBe(proto.Message.ProtocolMessage.Type.REVOKE)
	})
})
