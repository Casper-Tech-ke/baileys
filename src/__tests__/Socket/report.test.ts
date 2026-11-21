import {
	buildSpamReportNode,
	buildTargetReportNode,
	reportAndBlock,
	reportChannelStatus,
	reportContact,
	type ReportDeps,
	reportGroup,
	reportSpam,
	reportTarget
} from '../../Socket/report.js'
import { SPAM_FLOWS } from '../../Types/Report.js'
import type { WAMessage } from '../../Types/index.js'
import type { BinaryNode } from '../../WABinary/index.js'

const textMessage = (overrides: Partial<WAMessage> = {}): WAMessage => ({
	key: { remoteJid: '254700000001@s.whatsapp.net', fromMe: false, id: '3EB0TESTMSG00001' },
	messageTimestamp: 1794223368,
	message: { conversation: 'hello spam' },
	...overrides
})

const reportIdResult = (reportId?: string): BinaryNode => ({
	tag: 'iq',
	attrs: {},
	content: reportId ? [{ tag: 'report_id', attrs: {}, content: Buffer.from(reportId, 'utf-8') }] : []
})

/** The app's own reply shape: `<report id="…"/>`. */
const reportAttrResult = (reportId?: string): BinaryNode => ({
	tag: 'iq',
	attrs: {},
	content: reportId ? [{ tag: 'report', attrs: { id: reportId } }] : []
})

const mockDeps = (handler?: (node: BinaryNode) => BinaryNode): { deps: ReportDeps; sent: BinaryNode[] } => {
	const sent: BinaryNode[] = []
	return {
		sent,
		deps: {
			query: async (node: BinaryNode) => {
				sent.push(node)
				return handler ? handler(node) : reportIdResult('REPORT_123')
			},
			meJid: '254181847643@s.whatsapp.net'
		}
	}
}

const spamList = (node: BinaryNode) => (node.content as BinaryNode[])[0]!
const messageNode = (node: BinaryNode) => (spamList(node).content as BinaryNode[])[0]!

it('builds a contact report IQ with the spam namespace and a raw payload', () => {
	const node = buildSpamReportNode(textMessage(), { spamFlow: 'chat' })

	expect(node.tag).toBe('iq')
	expect(node.attrs.xmlns).toBe('spam')
	expect(node.attrs.to).toBe('@s.whatsapp.net') // S_WHATSAPP_NET, the server JID in Baileys form
	expect(node.attrs.type).toBe('set')

	const list = spamList(node)
	expect(list.tag).toBe('spam_list')
	expect(list.attrs.spam_flow).toBe('chat')
	expect((list.attrs.wi_trace_id as string).length).toBe(24)

	const message = messageNode(node)
	expect(message.tag).toBe('message')
	expect(message.attrs.id).toBe('3EB0TESTMSG00001')
	expect(message.attrs.t).toBe('1794223368')
	expect(message.attrs.from).toBe('254700000001@s.whatsapp.net')

	const raw = (message.content as BinaryNode[])[0]!
	expect(raw.tag).toBe('raw')
	expect(raw.attrs.v).toBe('3')
	expect(Buffer.from(raw.content as Uint8Array).toString()).toContain('hello spam')
})

it('sends one IQ per message and returns the server report ids', async () => {
	const { deps, sent } = mockDeps()
	const results = await reportSpam(
		[
			textMessage(),
			textMessage({ key: { remoteJid: '254700000002@s.whatsapp.net', fromMe: false, id: '3EB0TESTMSG00002' } })
		],
		deps
	)

	expect(sent).toHaveLength(2)
	expect(results).toEqual([
		{ reportId: 'REPORT_123', messageId: '3EB0TESTMSG00001' },
		{ reportId: 'REPORT_123', messageId: '3EB0TESTMSG00002' }
	])
})

it('returns a null report id when the server sends none', async () => {
	const { deps } = mockDeps(() => reportIdResult())
	const results = await reportSpam([textMessage()], deps)
	expect(results[0]!.reportId).toBeNull()
})

it('reports a contact with the chat flow and a group with participant and jid', async () => {
	const { deps, sent } = mockDeps()
	await reportContact('254700000001@s.whatsapp.net', [textMessage()], deps)
	expect(spamList(sent[0]!).attrs.spam_flow).toBe('chat')

	const groupMessage = textMessage({
		key: {
			remoteJid: '120363000000000000@g.us',
			fromMe: false,
			id: '3EB0GROUPMSG00001',
			participant: '254700000001@s.whatsapp.net'
		}
	})
	await reportGroup('120363000000000000@g.us', [groupMessage], deps, { groupSubject: 'Test Group' })
	const groupNode = sent[1]!
	expect(spamList(groupNode).attrs.spam_flow).toBe('group_info_report')
	expect(spamList(groupNode).attrs.jid).toBe('120363000000000000@g.us')
	expect(spamList(groupNode).attrs.subject).toBe('Test Group')
	const groupMessageNode = messageNode(groupNode)
	expect(groupMessageNode.attrs.from).toBe('120363000000000000@g.us')
	expect(groupMessageNode.attrs.participant).toBe('254700000001@s.whatsapp.net')
})

it('reports a channel status with the channel status flow', async () => {
	const { deps, sent } = mockDeps()
	const statusMessage = textMessage({
		key: { remoteJid: '120363331321673219@newsletter', fromMe: false, id: '3EB0STATUSMSG001' }
	})
	await reportChannelStatus('120363331321673219@newsletter', [statusMessage], deps)
	expect(spamList(sent[0]!).attrs.spam_flow).toBe('channel_status_report')
	expect(messageNode(sent[0]!).attrs.from).toBe('120363331321673219@newsletter')
})

it('report and block reports first, then blocks', async () => {
	const { deps, sent } = mockDeps()
	const blocked: { jid: string; action: string }[] = []
	deps.updateBlockStatus = async (jid: string, action: 'block' | 'unblock') => {
		blocked.push({ jid, action })
	}

	await reportAndBlock('254700000001@s.whatsapp.net', [textMessage()], deps)
	expect(sent).toHaveLength(1)
	expect(blocked).toEqual([{ jid: '254700000001@s.whatsapp.net', action: 'block' }])
})

it('refuses report and block without a block function', async () => {
	const { deps } = mockDeps()
	await expect(reportAndBlock('254700000001@s.whatsapp.net', [textMessage()], deps)).rejects.toThrow(
		'needs updateBlockStatus'
	)
})

it('accepts the flow alias and lets spamFlow win when both are given', () => {
	expect(spamList(buildSpamReportNode(textMessage(), { flow: 'overflow_menu_report' })).attrs.spam_flow).toBe(
		'overflow_menu_report'
	)
	expect(
		spamList(buildSpamReportNode(textMessage(), { spamFlow: 'chat', flow: 'overflow_menu_report' })).attrs.spam_flow
	).toBe('chat')
})

it('sets the source attribute for a reported group member', () => {
	const node = buildSpamReportNode(textMessage(), {
		spamFlow: 'group_info_report',
		groupJid: '120363000000000000@g.us',
		source: '254700000001@s.whatsapp.net'
	})
	expect(spamList(node).attrs.source).toBe('254700000001@s.whatsapp.net')
	expect(spamList(node).attrs.jid).toBe('120363000000000000@g.us')
})

it('exposes the PascalCase flow aliases with the same wire values', () => {
	expect(SPAM_FLOWS.GroupInfoReport).toBe('group_info_report')
	expect(SPAM_FLOWS.OverflowMenuReport).toBe('overflow_menu_report')
	expect(SPAM_FLOWS.MessageMenu).toBe('message_menu')
	expect(SPAM_FLOWS.ContactInfo).toBe('account_info_report')
	expect(SPAM_FLOWS.ChatInfoReport).toBe('account_info_report')
	expect(SPAM_FLOWS.StatusReport).toBe('status_post_report')
	expect(SPAM_FLOWS.GroupSpamBannerReport).toBe('group_spam_banner_report')
	expect(SPAM_FLOWS.Chat).toBe('chat')
})

it('covers every report flow in the app validated enum', () => {
	// The app's own flow enum (decompiled APK, C1938J8b) holds 36 values
	// containing `_report` (27 ending in it, plus 9 `_report_upsell` /
	// `_as_guest_user` / `_suspicious` variants); every one of them is a
	// value in SPAM_FLOWS.
	const reportFlows = new Set(Object.values(SPAM_FLOWS).filter(value => value.includes('_report')))
	expect(reportFlows.size).toBe(36)
	expect(SPAM_FLOWS.CHAT_LIST_SWIPE_DELETE_REPORT_UPSELL).toBe('chat_list_swipe_delete_report_upsell')
	expect(SPAM_FLOWS.CHAT_FMX_CARD_SAFETY_TOOLS_REPORT_SUSPICIOUS).toBe('chat_fmx_card_safety_tools_report_suspicious')
	expect(SPAM_FLOWS.CALL_SPAM_DIALOG_REPORT).toBe('call_spam_dialog_report')
	expect(SPAM_FLOWS.GUEST_CALL_REPORT).toBe('guest_call_report')
	expect(SPAM_FLOWS.GUEST_CALL_PARTICIPANT_REPORT).toBe('guest_call_participant_report')
	expect(SPAM_FLOWS.PAYMENT_TRANSACTION_REPORT).toBe('payment_transaction_report')
	expect(SPAM_FLOWS.LEFT_GROUP_SPAM_BANNER_REPORT).toBe('left_group_spam_banner_report')
	expect(SPAM_FLOWS.OVERFLOW_MENU_COMMUNITY_REPORT).toBe('overflow_menu_community_report')
	expect(SPAM_FLOWS.NEWSLETTER_QUESTION_RESPONSE_REPORT).toBe('newsletter_question_response_report')
	expect(SPAM_FLOWS.ACCOUNT_INFO_REPORT_AS_GUEST_USER).toBe('account_info_report_as_guest_user')
})

it('exposes the bare entry-point flows from the same enum', () => {
	expect(SPAM_FLOWS.ACCOUNT_INFO_SCREEN).toBe('account_info')
	expect(SPAM_FLOWS.GROUP_INFO_SCREEN).toBe('group_info')
	expect(SPAM_FLOWS.OVERFLOW_MENU_SCREEN).toBe('overflow_menu')
	expect(SPAM_FLOWS.CALL_LOG).toBe('call_log')
	expect(SPAM_FLOWS.MEDIA_VIEWER).toBe('media_viewer')
	expect(SPAM_FLOWS.VIEW_ONCE_VIEWER).toBe('view_once_viewer')
	expect(SPAM_FLOWS.COMMUNITY_HOME).toBe('community_home')
})

it('reads the report id from the <report id="…"/> reply shape', async () => {
	const { deps, sent } = mockDeps(() => reportAttrResult('REPORT_456'))
	const results = await reportSpam([textMessage()], deps)
	expect(sent).toHaveLength(1)
	expect(results).toEqual([{ reportId: 'REPORT_456', messageId: '3EB0TESTMSG00001' }])
})

it('reads the report id from the <report_id> reply shape', async () => {
	const { deps } = mockDeps(() => reportIdResult('REPORT_789'))
	const results = await reportSpam([textMessage()], deps)
	expect(results[0]!.reportId).toBe('REPORT_789')
})

it('reports a contact by JID with the overflow-menu flow by default', async () => {
	const { deps, sent } = mockDeps()
	const result = await reportTarget('254700000001@s.whatsapp.net', deps)
	expect(sent).toHaveLength(1)
	const list = spamList(sent[0]!)
	expect(list.attrs.jid).toBe('254700000001@s.whatsapp.net')
	expect(list.attrs.spam_flow).toBe('overflow_menu_report')
	expect(list.content).toEqual([])
	expect(result).toEqual({
		jid: '254700000001@s.whatsapp.net',
		flow: 'overflow_menu_report',
		reported: true,
		reportId: 'REPORT_123',
		node: sent[0]
	})
})

it('reports a group member by JID with flow and source', async () => {
	const { deps, sent } = mockDeps()
	const result = await reportTarget('120363000000000000@g.us', deps, {
		flow: SPAM_FLOWS.GroupInfoReport,
		source: '254700000001@s.whatsapp.net'
	})
	const list = spamList(sent[0]!)
	expect(list.attrs.jid).toBe('120363000000000000@g.us')
	expect(list.attrs.spam_flow).toBe('group_info_report')
	expect(list.attrs.source).toBe('254700000001@s.whatsapp.net')
	expect(result.jid).toBe('120363000000000000@g.us')
	expect(result.flow).toBe('group_info_report')
	expect(result.reported).toBe(true)
})

it('attaches messages to a target report when given', async () => {
	const { deps, sent } = mockDeps()
	await reportTarget('254700000001@s.whatsapp.net', deps, { messages: [textMessage()] })
	expect(spamList(sent[0]!).content as BinaryNode[]).toHaveLength(1)
	expect(messageNode(sent[0]!).attrs.id).toBe('3EB0TESTMSG00001')
})

it('builds a target report node with jid, flow, source and subject', () => {
	const node = buildTargetReportNode('120363000000000000@g.us', {
		spamFlow: 'group_info_report',
		source: '254700000001@s.whatsapp.net',
		groupSubject: 'Test Group'
	})
	const list = spamList(node)
	expect(list.attrs.jid).toBe('120363000000000000@g.us')
	expect(list.attrs.spam_flow).toBe('group_info_report')
	expect(list.attrs.source).toBe('254700000001@s.whatsapp.net')
	expect(list.attrs.subject).toBe('Test Group')
})
