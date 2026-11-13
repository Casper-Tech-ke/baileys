import $protobuf from 'protobufjs/minimal.js'
import { proto } from '../../WAProto/index.js'

const { Writer } = $protobuf

/**
 * Group history sharing (native `messageHistoryBundle`).
 *
 * Reverse-engineered from the WhatsApp Android APK (decompiled 2026-11-09):
 * when an admin adds a member, the admin's client builds an encrypted bundle
 * file with the last messages, uploads it to WhatsApp's media servers and
 * sends a `messageHistoryBundle` message (plus a `messageHistoryNotice` as
 * the record) into the group. The new member's client downloads, decrypts
 * and imports the bundle.
 *
 * The bundle file is a protobuf `Ft1`:
 *   field 1: messages (repeated Fsf)
 *   field 2: uncountedAssociatedMessageLists (repeated FsJ)
 *   field 3: commentMessages (repeated Fsf)
 *   field 4: outOfWindowPinnedMessages (repeated Fsf)
 *   field 5: themeMessage (optional Fsf)
 * Each `Fsf` is:
 *   field 1: key (MessageKey)
 *   field 2: message (bytes — the serialised WebMessageInfo, which carries
 *   the content plus the timestamp/sender the importing client needs)
 * Each `FsJ` is:
 *   field 1: messages (repeated Fsf)
 *
 * The standalone `messageHistoryNotice` on its own is dropped by the server
 * — the bundle file is the actual history. No public Baileys fork, whatsmeow
 * or other library had implemented this (re-verified Sep 2026); this is the
 * first native implementation.
 */

export const GROUP_HISTORY_BUNDLE_MIMETYPE = 'application/octet-stream'

/**
 * Encode full messages (WebMessageInfo) into a group-history bundle file
 * (Ft1 protobuf). Only the `messages` list is populated; the
 * associated/comment/pinned/theme lists are left empty.
 */
export const encodeGroupHistoryBundle = (messages: proto.IWebMessageInfo[]): Buffer => {
	const writer = Writer.create()
	for (const info of messages) {
		if (!info.key) {
			continue
		}
		const keyBytes = proto.MessageKey.encode(info.key).finish()
		const messageBytes = proto.WebMessageInfo.encode(info).finish()
		// Fsf: field 1 = key, field 2 = message
		const fsf = Writer.create()
		fsf.uint32(0x0a).bytes(keyBytes)
		fsf.uint32(0x12).bytes(messageBytes)
		// Ft1 field 1: messages (repeated Fsf)
		writer.uint32(0x0a).bytes(fsf.finish())
	}
	return Buffer.from(writer.finish())
}
