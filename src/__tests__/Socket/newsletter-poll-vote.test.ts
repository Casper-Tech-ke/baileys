import { newsletterSendPollVote } from '../../Socket/channelPollVote.js'
import { sha256 } from '../../Utils/crypto'
import { buildNewsletterPollVotes } from '../../Utils/process-message'
import type { BinaryNode } from '../../WABinary/index.js'

const channelJid = '120363331321673219@newsletter'

const queryDeps = (queries: BinaryNode[]) => ({
	query: async (node: BinaryNode) => {
		queries.push(node)
		return { tag: 'iq', attrs: { type: 'result', id: 'test-tag-1' }, content: [] }
	},
	generateMessageTag: () => 'test-tag-1'
})

it('votes on a channel poll with an unencrypted <votes> stanza', async () => {
	const queries: BinaryNode[] = []
	const result = await newsletterSendPollVote(channelJid, '136', 'Yes', queryDeps(queries))

	expect(result).toEqual({ id: 'test-tag-1' })
	expect(queries).toHaveLength(1)
	const node = queries[0]!
	expect(node.tag).toBe('message')
	expect(node.attrs.to).toBe(channelJid)
	expect(node.attrs.type).toBe('poll')
	expect(node.attrs.server_id).toBe('136')
	expect(node.attrs.id).toBe('test-tag-1')

	const meta = node.content?.[0] as BinaryNode
	expect(meta.tag).toBe('meta')
	expect(meta.attrs.polltype).toBe('vote')

	const votes = node.content?.[1] as BinaryNode
	expect(votes.tag).toBe('votes')
	expect(votes.content).toHaveLength(1)
	const vote = (votes.content as BinaryNode[])[0]!
	expect(vote.tag).toBe('vote')
	expect(vote.attrs).toEqual({})
	// unencrypted: the vote content IS the SHA-256 of the option name —
	// no pollUpdateMessage, no encPayload / encIv anywhere in the stanza
	expect(Buffer.from(vote.content as Uint8Array)).toEqual(sha256(Buffer.from('Yes')))
	expect(JSON.stringify(node)).not.toContain('pollUpdateMessage')
	expect(JSON.stringify(node)).not.toContain('encPayload')
})

it('votes for several options, in order, from an array', async () => {
	const queries: BinaryNode[] = []
	await newsletterSendPollVote(channelJid, 136, ['Red', 'Blue'], queryDeps(queries))

	expect(queries).toHaveLength(1)
	const node = queries[0]!
	// a numeric parent server id is stringified onto the stanza
	expect(node.attrs.server_id).toBe('136')
	const votes = node.content?.[1] as BinaryNode
	const voteNodes = votes.content as BinaryNode[]
	expect(voteNodes).toHaveLength(2)
	expect(Buffer.from(voteNodes[0]!.content as Uint8Array)).toEqual(sha256(Buffer.from('Red')))
	expect(Buffer.from(voteNodes[1]!.content as Uint8Array)).toEqual(sha256(Buffer.from('Blue')))
})

it('refuses to vote with no options', async () => {
	await expect(newsletterSendPollVote(channelJid, '136', [], queryDeps([]))).rejects.toThrow(
		'newsletterSendPollVote needs at least one option'
	)
})

it('refuses to vote without a parent server id', async () => {
	await expect(
		newsletterSendPollVote(channelJid, undefined as unknown as string, 'Yes', queryDeps([]))
	).rejects.toThrow('newsletterSendPollVote needs a parentServerId')
	await expect(newsletterSendPollVote(channelJid, '', 'Yes', queryDeps([]))).rejects.toThrow(
		'newsletterSendPollVote needs a parentServerId'
	)
})

it('refuses an empty option name', async () => {
	await expect(newsletterSendPollVote(channelJid, '136', '', queryDeps([]))).rejects.toThrow(
		'newsletterSendPollVote needs non-empty option names'
	)
	await expect(newsletterSendPollVote(channelJid, '136', ['Yes', ''], queryDeps([]))).rejects.toThrow(
		'newsletterSendPollVote needs non-empty option names'
	)
})

it('buildNewsletterPollVotes hashes each option name with SHA-256', () => {
	const votes = buildNewsletterPollVotes(['Yes', 'No'])
	expect(votes).toHaveLength(2)
	expect(votes[0]!.tag).toBe('vote')
	expect(Buffer.from(votes[0]!.content as Uint8Array)).toEqual(sha256(Buffer.from('Yes')))
	expect(Buffer.from(votes[1]!.content as Uint8Array)).toEqual(sha256(Buffer.from('No')))
	expect(buildNewsletterPollVotes([])).toEqual([])
})
