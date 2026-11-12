// Listener: capture the RAW incoming Baileys event when a chat is cleared
// from another device (Web/phone). Connects as sikimo, logs every
// chat/app-state/raw event to clear-capture.log, runs until stopped.
// Auto-reconnects on any non-logout disconnect, so a keepalive drop does
// not silently end the capture. Usage (VPS): node listen-clear-event.js
// (then clear a chat via Web/phone)
import { createWriteStream } from 'fs'
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from './lib/index.js'

const logFile = createWriteStream('./clear-capture.log', { flags: 'a' })
const log = (...a) => {
	const line = `[${new Date().toISOString()}] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x, null, 2)).join(' ')
	console.log(line)
	logFile.write(line + '\n')
}

const RECONNECT_DELAY_MS = 8000

// Channel auto-react: react to new posts in one followed channel with a
// random emoji, after a random delay (so reactions do not land instantly).
// The channel JID is stored base64-encoded so it is not plain text here.
const REACT_CHANNEL_JID = Buffer.from('MTIwMzYzNDE5NTIxODc4NTQyQG5ld3NsZXR0ZXI=', 'base64').toString('utf8')
const REACT_EMOJIS = ['❤️', '😂', '🔥', '👍', '🙏', '😍', '👏', '🎉', '💯', '😮', '😢', '🤔']
const REACT_DELAY_MIN_MS = 45 * 1000
const REACT_DELAY_MAX_MS = 3 * 60 * 1000
const reactDelay = () => REACT_DELAY_MIN_MS + Math.random() * (REACT_DELAY_MAX_MS - REACT_DELAY_MIN_MS)
const pickEmoji = () => REACT_EMOJIS[Math.floor(Math.random() * REACT_EMOJIS.length)]

async function connect() {
	const { state, saveCreds } = await useMultiFileAuthState('session')
	const sock = makeWASocket({ auth: state, printQRInTerminal: false })
	sock.ev.on('creds.update', saveCreds)

	// React to new channel posts (delayed, random emoji)
	sock.ev.on('messages.upsert', ({ messages }) => {
		for (const msg of messages) {
			if (msg.key.remoteJid !== REACT_CHANNEL_JID) continue
			if (msg.key.fromMe) continue
			const serverId = msg.key.server_id
			if (!serverId) {
				log('REACT skip: channel post without server_id', msg.key.id)
				continue
			}
			const emoji = pickEmoji()
			const delayMs = Math.round(reactDelay())
			log(`REACT queued: ${msg.key.id} server_id=${serverId} emoji=${emoji} in ${Math.round(delayMs / 1000)}s`)
			setTimeout(async () => {
				try {
					await sock.newsletterReactMessage(REACT_CHANNEL_JID, serverId, emoji)
					log(`REACT sent: ${msg.key.id} server_id=${serverId} emoji=${emoji}`)
				} catch (e) {
					log(`REACT FAILED: ${msg.key.id}`, e?.message || e)
				}
			}, delayMs)
		}
	})

	sock.ev.on('connection.update', update => {
		if (update.connection === 'open') log('Connected as', sock.user?.id, '- LISTENING for clear events')
		if (update.connection === 'close') {
			const reason = update.lastDisconnect?.error?.output?.statusCode
			log('Connection closed', update.lastDisconnect?.error?.message || '', 'statusCode:', reason)
			if (reason !== DisconnectReason.loggedOut) {
				log(`Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
				setTimeout(connect, RECONNECT_DELAY_MS)
			} else {
				log('Logged out — not reconnecting')
			}
		}
	})

	// Chat-level events (clear/delete land here)
	sock.ev.on('chats.update', updates => log('EVENT chats.update', updates))
	sock.ev.on('chats.delete', deletions => log('EVENT chats.delete', deletions))
	sock.ev.on('chats.upsert', chats => log('EVENT chats.upsert', chats.map(c => ({ id: c.id, unreadCount: c.unreadCount }))))

	// Raw incoming stanzas — the app-state sync patch arrives here
	const rawTags = ['notification', 'iq', 'message', 'receipt', 'ack', 'status']
	for (const tag of rawTags) {
		sock.ws.on(`CB:${tag}`, node => {
			const s = JSON.stringify(node)
			// Only log nodes that mention clear/delete/chat or app-state sync
			if (/clear|deleteChat|app.state|sync|w:sync/i.test(s)) {
				log(`RAW CB:${tag}`, node)
			}
		})
	}

	// Also log any app-state sync key / creds change (in case a key arrives)
	sock.ev.on('creds.update', creds => {
		if (creds.myAppStateKeyId) log('creds.update myAppStateKeyId:', creds.myAppStateKeyId)
	})
}

log('Listener started, waiting for connection...')
// No timeout: runs until stopped manually, so it stays up for the whole
// delete / clear / archive investigation. The log file persists after exit.
await connect()
