import {
	buildSpamReportNode,
	reportAndBlock,
	reportChannelStatus,
	reportContact,
	type ReportDeps,
	reportGroup,
	reportSpam
} from '../../Socket/report.js'
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
