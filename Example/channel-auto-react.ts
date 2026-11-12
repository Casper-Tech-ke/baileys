/**
 * Follow a channel and auto-react to its new posts with a random emoji.
 *
 * Run with:  npx tsx Example/channel-auto-react.ts <channel-jid>
 *   e.g.     npx tsx Example/channel-auto-react.ts 120363331321673219@newsletter
 *
 * 1. Scan the QR code with WhatsApp (Linked Devices > Link a Device)
 * 2. The script follows the channel (if not already followed)
 * 3. Every new post in that channel gets a reaction with a random emoji,
 *    after a random delay of 45s–3min, so reactions do not land instantly.
 *    It skips your own posts and posts without a server_id.
 *
 * Uses the built-in sock.newsletterFollow and sock.newsletterReactMessage.
 * Pass the channel JID as an argument — never hardcode a channel you
 * follow into a shared script.
 */
import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore, useMultiFileAuthState } from '../src'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import P from 'pino'

const logger = P({ level: 'info' })

const channelJid = process.argv[2]
if (!channelJid || !channelJid.endsWith('@newsletter')) {
	logger.error('Usage: npx tsx Example/channel-auto-react.ts <channel-jid>')
	logger.error('Example: npx tsx Example/channel-auto-react.ts 120363331321673219@newsletter')
	process.exit(1)
}

const REACT_EMOJIS = ['❤️', '😂', '🔥', '👍', '🙏', '😍', '👏', '🎉', '💯', '😮', '😢', '🤔']
const REACT_DELAY_MIN_MS = 45 * 1000
const REACT_DELAY_MAX_MS = 3 * 60 * 1000
const reactDelay = () => REACT_DELAY_MIN_MS + Math.random() * (REACT_DELAY_MAX_MS - REACT_DELAY_MIN_MS)
const pickEmoji = () => REACT_EMOJIS[Math.floor(Math.random() * REACT_EMOJIS.length)]

async function startSock() {
	const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
	const sock = makeWASocket({
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger)
		},
		printQRInTerminal: true,
		logger
	})
	sock.ev.on('creds.update', saveCreds)
	sock.ev.on('connection.update', async update => {
		const { connection, lastDisconnect, qr } = update
		if (qr) {
			qrcode.generate(qr, { small: true })
		}
		if (connection === 'close') {
			const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
			logger.info('Connection closed, reconnecting:', shouldReconnect)
			if (shouldReconnect) {
				startSock()
			}
		} else if (connection === 'open') {
			logger.info('Connected as', sock.user?.id)
			try {
				const result = await sock.newsletterFollow(channelJid)
				logger.info({ result }, 'Followed channel')
			} catch (e) {
				logger.error({ err: e }, 'Failed to follow channel')
			}
			logger.info('Listening for new posts in', channelJid)
		}
	})
	sock.ev.on('messages.upsert', ({ messages }) => {
		for (const msg of messages) {
			if (msg.key.remoteJid !== channelJid) continue
			if (msg.key.fromMe) continue
			const serverId = msg.key.server_id
			if (!serverId) {
				logger.warn({ msgId: msg.key.id }, 'Channel post without server_id, skipping reaction')
				continue
			}
			const emoji = pickEmoji()
			const delayMs = Math.round(reactDelay())
			logger.info({ msgId: msg.key.id, serverId, emoji, delaySec: Math.round(delayMs / 1000) }, 'Reaction queued')
			setTimeout(async () => {
				try {
					await sock.newsletterReactMessage(channelJid, serverId, emoji)
					logger.info({ msgId: msg.key.id, serverId, emoji }, 'Reaction sent')
				} catch (e) {
					logger.error({ err: e, msgId: msg.key.id }, 'Reaction failed')
				}
			}, delayMs)
		}
	})
}

startSock()
