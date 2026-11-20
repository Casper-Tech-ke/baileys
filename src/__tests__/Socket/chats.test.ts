import { proto } from '../../../WAProto/index.js'
import {
	buildProfilePictureQueryContent,
	privacySettingsToCategories,
	statusDistributionModePatch
} from '../../Socket/chats'
import { chatModificationToAppPatch } from '../../Utils/chat-utils.js'
import type { BinaryNode } from '../../WABinary'

describe('buildProfilePictureQueryContent', () => {
	it('builds a profile picture query without tctoken content', () => {
		expect(buildProfilePictureQueryContent('preview')).toEqual([
			{
				tag: 'picture',
				attrs: { type: 'preview', query: 'url' }
			}
		])
	})

	it('nests tctoken under the picture node', () => {
		const tcToken: BinaryNode = {
			tag: 'tctoken',
			attrs: { t: '1770000000' },
			content: Buffer.from([4, 1, 33])
		}

		expect(buildProfilePictureQueryContent('image', [tcToken])).toEqual([
			{
				tag: 'picture',
				attrs: { type: 'image', query: 'url' },
				content: [tcToken]
			}
		])
	})
})

const PIN_JID = '254143947797@s.whatsapp.net'
const PIN_LAST_MESSAGES = [
	{ key: { remoteJid: PIN_JID, fromMe: true, id: '3EB0LASTMSG000000000001' }, messageTimestamp: 1794284000 },
	{ key: { remoteJid: PIN_JID, fromMe: false, id: '3EB0LASTMSG000000000002' }, messageTimestamp: 1794283900 }
]

describe('pinChat patch', () => {
	it('builds a pinAction patch when pinning a chat', () => {
		const patch = chatModificationToAppPatch({ pin: true }, PIN_JID)
		expect(patch.syncAction?.pinAction).toEqual({ pinned: true })
		expect(patch.index).toEqual(['pin_v1', PIN_JID])
		expect(patch.type).toBe('regular_low')
	})

	it('builds an unpin patch when pin is false', () => {
		const patch = chatModificationToAppPatch({ pin: false }, PIN_JID)
		expect(patch.syncAction?.pinAction).toEqual({ pinned: false })
		expect(patch.index).toEqual(['pin_v1', PIN_JID])
	})
})

describe('archiveChat patch', () => {
	it('builds an archiveChatAction patch with the message range', () => {
		const patch = chatModificationToAppPatch({ archive: true, lastMessages: PIN_LAST_MESSAGES }, PIN_JID)
		expect(patch.syncAction?.archiveChatAction?.archived).toBe(true)
		expect(patch.syncAction?.archiveChatAction?.messageRange?.lastMessageTimestamp).toBe(1794283900)
		expect(patch.index).toEqual(['archive', PIN_JID])
		expect(patch.type).toBe('regular_low')
	})

	it('builds an unarchive patch when archive is false', () => {
		const patch = chatModificationToAppPatch({ archive: false, lastMessages: PIN_LAST_MESSAGES }, PIN_JID)
		expect(patch.syncAction?.archiveChatAction?.archived).toBe(false)
		expect(patch.index).toEqual(['archive', PIN_JID])
	})
})

describe('privacySettingsToCategories', () => {
	it('maps each present category to its privacy IQ name', () => {
		expect(
			privacySettingsToCategories({
				call: 'known',
				status: 'contacts',
				last: 'contacts',
				online: 'match_last_seen',
				profile: 'contacts',
				groupadd: 'contacts',
				readreceipts: 'none',
				messages: 'contacts'
			})
		).toEqual([
			{ name: 'calladd', value: 'known' },
			{ name: 'status', value: 'contacts' },
			{ name: 'last', value: 'contacts' },
			{ name: 'online', value: 'match_last_seen' },
			{ name: 'profile', value: 'contacts' },
			{ name: 'groupadd', value: 'contacts' },
			{ name: 'readreceipts', value: 'none' },
			{ name: 'messages', value: 'contacts' }
		])
	})

	it('only includes the categories present', () => {
		expect(privacySettingsToCategories({ call: 'all' })).toEqual([{ name: 'calladd', value: 'all' }])
		expect(privacySettingsToCategories({})).toEqual([])
	})
})

describe('statusDistributionModePatch', () => {
	it('builds a close-friends default patch with the status_privacy index', () => {
		const patch = statusDistributionModePatch(
			proto.SyncActionValue.StatusPrivacyAction.StatusDistributionMode.CLOSE_FRIENDS
		)
		expect(patch.syncAction?.statusPrivacy).toEqual({ mode: 3 })
		expect(patch.index).toEqual(['status_privacy'])
		expect(patch.type).toBe('critical_block')
		expect(patch.apiVersion).toBe(1)
		expect(patch.operation).toBe(proto.SyncdMutation.SyncdOperation.SET)
	})

	it('builds a contacts default patch', () => {
		const patch = statusDistributionModePatch(proto.SyncActionValue.StatusPrivacyAction.StatusDistributionMode.CONTACTS)
		expect(patch.syncAction?.statusPrivacy?.mode).toBe(2)
		expect(patch.index).toEqual(['status_privacy'])
	})

	it('carries the allow list for ALLOW_LIST mode', () => {
		const patch = statusDistributionModePatch(
			proto.SyncActionValue.StatusPrivacyAction.StatusDistributionMode.ALLOW_LIST,
			['254143947797@s.whatsapp.net']
		)
		expect(patch.syncAction?.statusPrivacy).toEqual({
			mode: 0,
			userJid: ['254143947797@s.whatsapp.net']
		})
	})
})
