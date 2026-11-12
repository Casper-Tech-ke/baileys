// Follow a channel and fetch its metadata + recent messages, so we can
// see what is there to react to. Uses session/ (sikimo).
// The channel JID is stored base64-encoded so it is not plain text here.
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from './lib/index.js'
import fs from 'fs'
const jid = Buffer.from('MTIwMzYzNDE5NTIxODc4NTQyQG5ld3NsZXR0ZXI=', 'base64').toString('utf8')
const logFile = fs.createWriteStream('follow-channel.log', { flags: 'a' })
function log(...args) {
	const line = `[${new Date().toISOString()}] ` + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ')
	console.log(line)
	logFile.write(line + '\n')
}
let attempts = 0
let done = false
async function startSock() {
	attempts++
	log(`Attempt ${attempts}/3: connecting…`)
	const { state, saveCreds } = await useMultiFileAuthState('session')
	const sock = makeWASocket({ auth: state, printQRInTerminal: false })
	sock.ev.on('creds.update', saveCreds)
	sock.ev.on('connection.update', async update => {
		const { connection, lastDisconnect } = update
		log('connection update:', connection || '')
		if (connection === 'close') {
			const sc = lastDisconnect?.error?.output?.statusCode
			log('Connection closed, statusCode:', sc, 'done:', done)
			if (sc !== DisconnectReason.loggedOut && attempts < 3 && !done) {
				log('Reconnecting in 2s…')
				setTimeout(startSock, 2000)
			} else {
				process.exit(done ? 0 : 1)
			}
		}
		if (connection === 'open' && !done) {
			done = true
			log('Connected as:', sock.user?.id)
			try {
				const meta = await sock.newsletterFetchMetadata('invite', jid)
				log('metadata:', meta)
			} catch (e) {
				log('metadata FAILED:', e?.message || e)
			}
			try {
				const follow = await sock.newsletterFollow(jid)
				log('follow result:', follow)
			} catch (e) {
				log('follow FAILED:', e?.message || e)
			}
			try {
				const msgs = await sock.newsletterFetchMessages(jid, 5)
				log('recent messages:', msgs)
			} catch (e) {
				log('fetch messages FAILED:', e?.message || e)
			}
			process.exit(0)
		}
	})
}
startSock()
