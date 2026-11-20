import { proto } from '../../../WAProto/index.js'
import { generateWAMessageContent } from '../../Utils/messages'
import { sha256 } from '../../Utils/crypto'

const upload = async () => ({ mediaUrl: 'https://mmg.test/enc', directPath: '/v/t62/enc' })
const OPTS = { upload } as never

/** encode + decode round-trip through the real wire format */
const wireRoundTrip = (m: proto.IMessage) => proto.Message.decode(proto.Message.encode(m).finish())

const POLL_KEY = { remoteJid: '120363415416276985@g.us', fromMe: true, id: 'POLL123' }
const SECRET = new Uint8Array(32).fill(7)

describe('generateWAMessageContent poll creation', () => {
	const base = { name: 'Favorite Color?', values: ['Red', 'Blue', 'Green'], messageSecret: SECRET }

	it('builds a multi-select poll as pollCreationMessage', async () => {
		const m = await generateWAMessageContent({ poll: { ...base, selectableCount: 2 } }, OPTS)
		const c = m.pollCreationMessage
		expect(c).toBeTruthy()
		expect(c?.name).toBe('Favorite Color?')
		expect(c?.selectableOptionsCount).toBe(2)
		expect(c?.options?.map(o => o.optionName)).toEqual(['Red', 'Blue', 'Green'])
		expect(m.pollCreationMessageV3).toBeFalsy()
		expect(m.pollCreationMessageV2).toBeFalsy()
	})

	it('builds a single-select poll as pollCreationMessageV3', async () => {
		const m = await generateWAMessageContent({ poll: { ...base, selectableCount: 1 } }, OPTS)
		expect(m.pollCreationMessageV3?.selectableOptionsCount).toBe(1)
		expect(m.pollCreationMessage).toBeFalsy()
	})

	it('builds an announcement-group poll as pollCreationMessageV2', async () => {
		const m = await generateWAMessageContent({ poll: { ...base, selectableCount: 1, toAnnouncementGroup: true } }, OPTS)
		expect(m.pollCreationMessageV2?.selectableOptionsCount).toBe(1)
		expect(m.pollCreationMessageV3).toBeFalsy()
	})

	it('accepts selectableOptionsCount as an alias for selectableCount', async () => {
		const m = await generateWAMessageContent({ poll: { ...base, selectableOptionsCount: 1 } }, OPTS)
		expect(m.pollCreationMessageV3?.selectableOptionsCount).toBe(1)
	})

	it('prefers selectableOptionsCount when both are given', async () => {
		const m = await generateWAMessageContent({ poll: { ...base, selectableCount: 2, selectableOptionsCount: 1 } }, OPTS)
		expect(m.pollCreationMessageV3?.selectableOptionsCount).toBe(1)
	})

	it('rejects a selectable count outside the values range', async () => {
		await expect(generateWAMessageContent({ poll: { ...base, selectableCount: 5 } }, OPTS)).rejects.toThrow(
			'poll.selectableCount'
		)
	})

	it('rejects non-array poll values', async () => {
		await expect(generateWAMessageContent({ poll: { ...base, values: 'Red' as never } }, OPTS)).rejects.toThrow(
			'Invalid poll values'
		)
	})
})

describe('generateWAMessageContent quiz polls', () => {
	const quiz = {
		name: 'What is 2+2?',
		values: ['3', '4', '5'],
		selectableOptionsCount: 1,
		pollType: proto.Message.PollType.QUIZ,
		correctAnswer: '4',
		messageSecret: SECRET
	}

	it('builds a quiz poll with pollType and correctAnswer', async () => {
		const m = await generateWAMessageContent({ poll: quiz }, OPTS)
		const c = m.pollCreationMessageV3
		expect(c?.pollType).toBe(proto.Message.PollType.QUIZ)
		expect(c?.correctAnswer?.optionName).toBe('4')
	})

	it('survives a wire round-trip', async () => {
		const m = await generateWAMessageContent({ poll: quiz }, OPTS)
		const decoded = wireRoundTrip(m)
		expect(decoded.pollCreationMessageV3?.pollType).toBe(1)
		expect(decoded.pollCreationMessageV3?.correctAnswer?.optionName).toBe('4')
	})

	it('rejects a quiz poll that allows more than one selection', async () => {
		await expect(generateWAMessageContent({ poll: { ...quiz, selectableOptionsCount: 2 } }, OPTS)).rejects.toThrow(
			'quiz polls must allow exactly one selection'
		)
	})

	it('rejects a quiz poll without a correctAnswer', async () => {
		await expect(
			generateWAMessageContent(
				{
					poll: {
						name: 'What is 2+2?',
						values: ['3', '4', '5'],
						selectableOptionsCount: 1,
						pollType: proto.Message.PollType.QUIZ,
						messageSecret: SECRET
					}
				},
				OPTS
			)
		).rejects.toThrow('quiz polls need a correctAnswer')
	})

	it('rejects a correctAnswer that is not one of the values', async () => {
		await expect(generateWAMessageContent({ poll: { ...quiz, correctAnswer: '6' } }, OPTS)).rejects.toThrow(
			'quiz correctAnswer must be one of the poll values'
		)
	})
})

describe('generateWAMessageContent timed polls', () => {
	const future = Math.floor(Date.now() / 1000) + 3600
	const timed = {
		name: 'Quick vote!',
		values: ['Yes', 'No'],
		selectableOptionsCount: 1,
		endTime: future,
		hideParticipantName: true,
		allowAddOption: false,
		messageSecret: SECRET
	}

	it('carries endTime, hideParticipantName and allowAddOption', async () => {
		const m = await generateWAMessageContent({ poll: timed }, OPTS)
		const c = m.pollCreationMessageV3
		expect(Number(c?.endTime)).toBe(future)
		expect(c?.hideParticipantName).toBe(true)
		expect(c?.allowAddOption).toBe(false)
	})

	it('survives a wire round-trip', async () => {
		const m = await generateWAMessageContent({ poll: timed }, OPTS)
		const decoded = wireRoundTrip(m)
		expect(Number(decoded.pollCreationMessageV3?.endTime)).toBe(future)
		expect(decoded.pollCreationMessageV3?.hideParticipantName).toBe(true)
		expect(decoded.pollCreationMessageV3?.allowAddOption).toBe(false)
	})

	it('rejects an endTime in the past', async () => {
		await expect(
			generateWAMessageContent({ poll: { ...timed, endTime: Math.floor(Date.now() / 1000) - 10 } }, OPTS)
		).rejects.toThrow('poll endTime must be in the future')
	})
})

describe('generateWAMessageContent poll add-option', () => {
	it('builds a pollAddOptionMessage with the option name and its hash', async () => {
		const m = await generateWAMessageContent(
			{ pollAddOption: { pollCreationMessageKey: POLL_KEY, option: 'New Option' } },
			OPTS
		)
		const add = m.pollAddOptionMessage
		expect(add?.pollCreationMessageKey?.id).toBe('POLL123')
		expect(add?.addOption?.optionName).toBe('New Option')
		expect(add?.addOption?.optionHash).toBe(sha256(Buffer.from('New Option')).toString())
	})

	it('survives a wire round-trip', async () => {
		const m = await generateWAMessageContent(
			{ pollAddOption: { pollCreationMessageKey: POLL_KEY, option: 'New Option' } },
			OPTS
		)
		const decoded = wireRoundTrip(m)
		expect(decoded.pollAddOptionMessage?.addOption?.optionName).toBe('New Option')
		expect(decoded.pollAddOptionMessage?.pollCreationMessageKey?.id).toBe('POLL123')
	})

	it('rejects an empty option', async () => {
		await expect(
			generateWAMessageContent({ pollAddOption: { pollCreationMessageKey: POLL_KEY, option: '' } }, OPTS)
		).rejects.toThrow('pollAddOption needs an option')
	})

	it('passes a raw pollAddOptionMessage through untouched', async () => {
		const raw = {
			pollCreationMessageKey: POLL_KEY,
			addOption: { optionName: 'Raw Option', optionHash: 'deadbeef' }
		}
		const m = await generateWAMessageContent({ pollAddOptionMessage: raw }, OPTS)
		expect(m.pollAddOptionMessage?.addOption?.optionName).toBe('Raw Option')
		expect(m.pollAddOptionMessage?.addOption?.optionHash).toBe('deadbeef')
	})
})

describe('generateWAMessageContent poll update passthrough', () => {
	const vote = { encPayload: Buffer.from('payload'), encIv: Buffer.from('iv123456789012') }
	const update = {
		pollCreationMessageKey: POLL_KEY,
		vote,
		senderTimestampMs: 1234567890000
	}

	it('passes a pollUpdateMessage through untouched', async () => {
		const m = await generateWAMessageContent({ pollUpdateMessage: update }, OPTS)
		const upd = m.pollUpdateMessage
		expect(upd?.pollCreationMessageKey?.id).toBe('POLL123')
		expect(Number(upd?.senderTimestampMs)).toBe(1234567890000)
	})

	it('survives a wire round-trip', async () => {
		const m = await generateWAMessageContent({ pollUpdateMessage: update }, OPTS)
		const decoded = wireRoundTrip(m)
		expect(decoded.pollUpdateMessage?.pollCreationMessageKey?.id).toBe('POLL123')
		expect(Number(decoded.pollUpdateMessage?.senderTimestampMs)).toBe(1234567890000)
	})
})
