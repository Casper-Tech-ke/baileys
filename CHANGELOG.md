# Changelog

## Unreleased

### Features

- **Delete and clear chat** (`sock.clearChat()`, `sock.deleteChat()`,
  `sock.deleteMessage()`, `sock.deleteMessageForMe()`)

  `deleteMessage(jid, key)` deletes a message for everyone (revoke; in
  a group an admin can delete someone else's message).
  `deleteMessageForMe(jid, key, timestamp, deleteMedia?)` deletes one
  message for yourself only. `clearChat(jid, lastMessages)` removes
  the WHOLE conversation — all its messages — for you, the chat stays
  in the list; this is not deleting one message. `clearChat` takes an
  optional third argument `{ deleteStarred: false }` to keep starred
  messages — the app's "Clear starred messages" checkbox unticked;
  by default starred messages are cleared too. `deleteChat(jid,
  lastMessages)` removes the whole chat for you. The chat functions
  are named wrappers around the existing `chatModify` app-state
  patches (same pattern as `star`). `lastMessages` is the chat's
  messages (at least the latest one) — the server clears everything
  up to the last message's timestamp, so pass the latest message to
  clear the whole conversation.

  ```ts
  await sock.deleteMessage('254143947797@s.whatsapp.net', msg.key)
  await sock.deleteMessageForMe('254143947797@s.whatsapp.net', msg.key, msg.messageTimestamp)
  await sock.clearChat('254143947797@s.whatsapp.net', [latestMessage])
  await sock.deleteChat('254143947797@s.whatsapp.net', [latestMessage])
  ```

  Live test 2026-11-10 07:53 EAT (VPS, sikimo.254 → baba hany):
  **delete for everyone works** — test message 3EB06041462A45DD1CC03B
  sent and revoked. The other three are **blocked, not by the code**
  (unit tests 5/5 pass, patches are well-formed) but by the session:
  the app-state sync key (`myAppStateKeyId` AAAAAKKa) was never
  shared to Baileys — the session was imported from CASPER-XD-ULTRA,
  so `session/` has no `app-state-sync-key` file and `appPatch`
  fails with `myAppStateKey ("AAAAAKKa") not present`. A full
  `resyncAppState` + 60s wait did not make the phone share the key;
  it is only shared when a companion links. To live-test those
  three, Baileys needs to link via pairing code so the phone shares
  the key. Research 2026-11-10 (online code + decompiled APK)
  confirmed there is **no other way** to clear a chat: every library
  uses this same app-state patch, and the app's own `ClearChatMutation`
  matches it exactly — so the blocker is the missing key, not the
  function.

- **Clear done on another device is now surfaced** (`chats.update` with empty `messages`)

  Incoming app-state patches flow through `processSyncAction`, which
  already emitted `deleteChatAction` as `chats.delete` and
  `archiveChatAction` as `chats.update`, but had no branch for
  `clearChatAction` — a clear from another device was decoded and
  silently dropped. A `clearChatAction` now emits `chats.update` with
  `[{ id, messages: [] }]` (the empty `messages` is the "cleared"
  signal), gated on non-initial sync like the delete branch. Live
  retest 2026-11-11 confirmed Baileys surfaces no discrete clear
  event from another device — only a generic app-state `server_sync`
  notice — so this branch also needs the app-state sync key to
  decrypt the patch before it can fire; unit tests 3/3 pass.

- **Ask the phone for a missing app-state sync key** (`sock.requestAppStateSyncKey(keyIds)`)

  Sends a peer `APP_STATE_SYNC_KEY_REQUEST` protocol message to our
  own JID — the same shape whatsmeow sends (`appstate.go`
  `requestAppStateKeys` via `SendPeerMessage`). Baileys already
  handles the expected answer, `APP_STATE_SYNC_KEY_SHARE`, by storing
  the key and emitting `creds.update` with `myAppStateKeyId`. The
  general peer-message sender was factored out as `sock.sendPeerMessage()`
  (the existing `sendPeerDataOperationMessage` now uses it; the TODO in
  `messages-send.ts` calling for exactly this is resolved). Key IDs are
  the base64 IDs Baileys uses, e.g. `['AAAAAKKZ', 'AAAAAKKa']` — the
  rotated current key first, then the old one. Runner script
  `request-appstate-key.js` sends the request and watches 90s for the
  key file to appear. **Unproven, not a fix yet:** nobody has published
  proof the phone answers this for a rotated key on an imported session,
  and WhatsApp throttles it to one request per key per 24h — run at most
  once a day. If no key arrives, re-linking via pairing code remains the
  documented fix. Unit test: wire shape 2/2 pass (key bytes round-trip).

  ```ts
  await sock.requestAppStateSyncKey(['AAAAAKKZ', 'AAAAAKKa'])
  ```

- **Full-image profile picture (uncropped DP)** — `generateProfilePicture`
  now takes `options: { full?: boolean; width?; height?; quality? }`,
  passed through `sock.updateProfilePicture(jid, content, options)`.
  With `{ full: true }` the image goes up **as it is — no crop, no
  padding, no background**: a JPEG within the server's limit is sent
  byte-for-byte, anything else is converted to JPEG at quality 92.
  WhatsApp rejects profile pictures whose longest side is over 640
  (`not-acceptable`), so a bigger image is scaled down to fit 640
  with the aspect ratio kept and nothing cut off. Jimp is **0.16.3**
  (downgraded from 1.6.1 at the user's direction) and is preferred
  over sharp for this; `extractImageThumb` was updated to the 0.16.3
  API as well. The default (no options) is the standard Baileys
  behaviour: 640×640 center crop, quality 50.

  ```ts
  await sock.updateProfilePicture(sock.user.id, imageBuffer, { full: true })
  ```

  Live-tested 2026-11-10 08:10 EAT: the user's own 1008×2304 photo
  (IMG-20261109-WA1104.jpg) was set as sikimo.254's DP with
  `{ full: true }` — it was scaled to 280×640 to fit the server's
  640 limit and accepted. Earlier probes showed the 1008×2304
  original and a 447×1024 version are both rejected
  (`not-acceptable`), while a 280×640 version is accepted, so 640 on
  the longest side is the server's limit. The earlier
  contain+white-padding version was rejected by the user and replaced
  by this.

- **Payment messages** (`sock.requestPayment()`, `sock.sendPayment()`, `sock.declinePaymentRequest()`, `sock.cancelPaymentRequest()`, `sock.sendPaymentInvite()`)

  Sends WhatsApp payment cards: a payment request (`requestPaymentMessage`
  with amount, currency, note and a 7-day expiry as the app uses), a
  payment against a request (`sendPaymentMessage`, referencing the
  request's key), declining or cancelling a request, and inviting someone
  to a payment service (`paymentInviteMessage`: 1 = FBPAY, 2 = NOVI,
  3 = UPI). Amounts are given in the currency's major units (500 =
  500 KES) and sent as `amount1000` (thousandths) plus a `Money` value
  in the currency's minor units (2 decimals by default, 0 for JPY/KRW,
  3 for KWD/BHD). The background is a colour/id background only in v1
  (no image upload). This only sends the request/message — moving money
  still needs a payment provider; the library does not settle it.

  ```ts
  await sock.requestPayment('254143947797@s.whatsapp.net', {
    amount: 500,
    currency: 'KES',
    note: 'lunch money'
  })
  ```

  Live-tested 2026-11-10 on the VPS: a 100 KES request ("wolfsocket
  payment test") sent from sikimo.254 to baba hany — the server
  accepted it (message id 3EB00BA765F8DB265415EC). Whether it renders
  as a proper payment request card on the phone is still to be
  confirmed by the user.

- **Send sticker packs** (`sock.sendStickerPack(jid, pack)`)

  Sends a whole sticker pack — up to 60 WebP stickers plus a tray icon —
  as one `stickerPackMessage` the receiver can add to their sticker
  collection. The pack is zipped in-memory (new dependency-free STORE
  writer in `src/Utils/zip.ts`, with CRC-32), uploaded as media type
  `sticker-pack`, and the tray icon is uploaded as
  `thumbnail-sticker-pack`, encrypted under the pack's own mediaKey (the
  proto carries no separate key for it, so the receiver derives it from
  the pack's key — `encryptedStream` now accepts a `mediaKey` option for
  this). Both media types are registered in `src/Defaults` with the
  HKDF info strings from the official app ("WhatsApp Sticker Pack Keys"
  / "WhatsApp Sticker Pack Thumbnail Keys") and the `/mms/sticker-pack`
  upload path. The wire shape follows the app's `FMessageStickerPack`
  builder: pack id, name, publisher, description, per-sticker metadata
  (file name in the ZIP, emojis, animated/lottie flags), the pack ZIP's
  hashes/direct path, and the tray icon's direct path + hashes
  (thumbnail fixed at 252x252, as the app does).

  ```ts
  await sock.sendStickerPack('254143947797@s.whatsapp.net', {
    name: 'My Pack',
    publisher: 'wolfsocket',
    description: 'a test pack',
    stickers: [
      { data: stickerWebpBuffer, emojis: ['😀'] },
      { data: animatedWebpBuffer, emojis: ['😂'], isAnimated: true }
    ],
    trayIcon: trayIconPngBuffer
  })
  ```

  Live-tested 2026-11-10 on the VPS: a 3-sticker pack ("wolfsocket
  test", tray icon) sent from sikimo.254 to baba hany — the server
  accepted it (message id 3EB047F4BEBAD498E3A91B), and the user
  confirmed it renders as a proper pack on his phone.

- **LID ↔ phone-number mapping** (`sock.getPNForLID()`, `sock.getLIDForPN()`, `sock.getPNsForLIDs()`, `sock.getLIDsForPNs()`)

  WhatsApp now addresses users by LID (a long-lived id) instead of their
  phone number, and the two are only linked by a mapping the client
  learns. The mapping store (`LIDMappingStore`) already existed, but the
  lookups were buried in `sock.signalRepository.lidMapping`, and
  `getPNForLID` returned the phone number with a `:0` device suffix
  (`254181847643:0@s.whatsapp.net`) while `getLIDForPN` returned the LID
  without one — so a plain `===` comparison against the phone number
  failed. Fixed: device 0 is now omitted on the PN side too, matching
  the LID side. The four lookups are now first-class socket functions.

  - `sock.getPNForLID(lid)` — phone number for a LID, or `null`. Learned
    only: the server does not disclose a phone number for a LID, so an
    unlearned LID stays `null` (verified live: a username that resolves
    to a LID with no shared history gives `null`).
  - `sock.getLIDForPN(pn)` — LID for a phone number, or `null`. This one
    has a server fallback: when the store misses, it asks the server via
    USync and stores the answer.
  - `sock.getPNsForLIDs(lids)` / `sock.getLIDsForPNs(pns)` — batch versions.

  Mappings are learned from messages where both appear (group messages
  carry `participant` LID + `participantAlt` phone number; 1:1 envelopes
  carry the sender's LID alongside the chat's phone number) and persist
  in the auth state (`lid-mapping` keys), so they survive restarts.

  Live-tested 2026-11-09 on the VPS from baba hany's session: after
  sikimo.254 sent a message to baba hany, `getPNForLID` on sikimo's LID
  returned the phone number in canonical form and `getLIDForPN` returned
  the LID back — the mapping works both ways. A LID with no shared
  history still returns `null`, as designed.

- **Report spam — all types** (`sock.reportSpam()`, `sock.reportContact()`, `sock.reportGroup()`, `sock.reportStatus()`, `sock.reportNewsletter()`, `sock.reportChannelStatus()`, `sock.reportEvent()`, `sock.reportAndBlock()`)

  Reporting is a single client→server IQ, never a message to the reported
  person — which is why the reported account's socket sees nothing. No
  Baileys fork implemented sending one; only whatsapp-rust did, and the
  exact shape was confirmed against the official client's own code,
  recovered from the decompiled WhatsApp app (`SpamReportRepo` →
  per-type RPCs → `SpamRPCManager` → `MessageClientSmaxWrapper`).

  ```xml
  <iq xmlns="spam" type="set" to="s.whatsapp.net">
    <spam_list spam_flow="…" wi_trace_id="…">
      <message id="…" t="…" from="…">
        <raw v="3" mediatype="…">…</raw>
      </message>
    </spam_list>
  </iq>
  ```

  Per whatsapp-rust and the decompiled app, the server answers with a
  `<report_id>`; the reported account is not notified. One IQ is sent
  per reported message (up to 5, per WhatsApp's FAQ). The `<raw>` bytes
  are the whitelisted-field content the reporting token is an HMAC over
  (via `extractReportingTokenContentForMessage`, newly exported from
  `reporting-utils.ts`), so the server can verify the reported content —
  the token itself is never sent in the IQ. Flow strings are the app's
  own (`chat`, `message_menu`, `group_info_report`, `status_post_report`,
  `newsletter_info_report`, `channel_status_report`, `event_info_report`,
  …), exposed as `sock.SPAM_FLOWS`; the reason codes (`spam` = 3,
  `scam_or_fraud` = 6, …) are documented in `sock.SPAM_REPORT_REASONS`
  but are **not** sent on the wire — the report IQ carries no reason
  field. `reportAndBlock` sends the report, then blocks via
  `updateBlockStatus`, the way the app's "Report and block" dialog does.

  #### Usage

  `messages` are the `WAMessage` objects to report — usually taken from
  `messages.upsert`, from a group/event/status you just sent, or from a
  channel fetch. Every call returns `Promise<{ reportId: string | null,
  messageId: string }[]>`, one entry per reported message.

  ```ts
  // 1:1 chat
  await sock.reportContact('254700000001@s.whatsapp.net', [message])

  // Group — the group JID (and subject, if passed) goes on the spam_list
  await sock.reportGroup('120363000000000000@g.us', [message], { groupSubject: 'My Group' })

  // Personal status post
  await sock.reportStatus('status@broadcast', [statusMessage])

  // Channel / newsletter
  await sock.reportNewsletter('120363000000000000@newsletter', [channelMessage])

  // Channel status
  await sock.reportChannelStatus('120363000000000000@newsletter', [statusMessage])

  // Event
  await sock.reportEvent('120363000000000000@g.us', [eventMessage])

  // Any flow, with an explicit flow string or trace id
  await sock.reportSpam([message], { spamFlow: 'message_menu' })
  await sock.reportSpam([message], { traceId: '...' }) // 24 chars, else generated

  // Report and block, like the app's dialog (two separate IQs)
  await sock.reportAndBlock('254700000001@s.whatsapp.net', [message])
  ```

  #### Live test

  Live-tested 2026-11-09 from the test account: a group message, a group
  event, and a personal status were all reported — the IQs went out with
  no error, but the server answered each with an empty
  `<iq type="result">` (no `<report_id>` at all, confirmed by dumping the
  raw reply), so `reportId` came back `null`. Whether that is because
  every reported message was the reporter's own, or because the stanza
  differs from the app's in some small way, is still open — it needs a
  report of someone else's message to tell. The channel phase could not
  run: fetching the test channel's messages times out with no server
  reply.

- **WhatsApp usernames** (`sock.checkUsername()`, `sock.getMyUsername()`, `sock.findUserByUsername()`, and more)

  The `@username` handles, separate from phone numbers: check availability,
  claim one, and look people up by theirs. Implemented from the public
  Baileys forks' username API (MEX queries + USync), not from the flagged
  `@jexkcode/baileys` package.

  - `sock.checkUsername(username)` — availability check via MEX
    (`xwa2_username_check`); returns `{ available, username, session_id }`,
    plus `suggestions` and `rejectionReasons` when taken.
  - `sock.checkUsernameMulti(usernames)` — check several at once
    (`xwa2_username_check_multi`).
  - `sock.setUsername(username, { source, sessionId, pin })` — claim a
    username (`xwa2_username_set`, `reserved: true`).
  - `sock.deleteUsername()` — give up the account's username
    (`xwa2_username_delete`).
  - `sock.getMyUsername()` — this account's username, or `null`
    (`xwa2_username_get`).
  - `sock.getUsernameRecommendations(source?)` — suggestions for this account
    (`xwa2_username_get_recommendations`).
  - `sock.setUsernamePin(pin | null)` — set or clear the username PIN
    (`xwa2_username_pin_set`).
  - `sock.findUserByUsername(username, pin?)` — resolve a username to a JID
    via USync (`contact` protocol with the username; returns
    `{ jid, contact }` or `null`).
  - `sock.fetchContactUsernames(...jids)` — look up usernames for JIDs via
    USync (`username` protocol).
  - `sock.setUsernameQueryIds({ ... })` — patch the MEX query IDs at runtime.
    WhatsApp rotates these server-side, so a stale ID shows up as a
    `GraphQL server error: Bad Request`; patching avoids a new release.
    The current IDs are exported as `sock.USERNAME_QUERY_IDS`.

  Live-tested 2026-11-09 on the VPS: `checkUsername('courtney')` → taken
  (suggestions `courtney132`, `courtney838`, `courtney969`),
  `checkUsername('wolfsocket_test_xyz_987')` → free,
  `getMyUsername()` → the test account's own username,
  `findUserByUsername('courtney')` → `null` (a taken username is not always
  resolvable without its PIN), `fetchContactUsernames` on baba hany →
  no username set. Only read-only calls were tested live; `setUsername`,
  `deleteUsername` and `setUsernamePin` change account state and were not
  run.

- **Channel statuses — receive and send** (`newsletter.status` event and `sock.sendChannelStatus()`)

  Channel statuses are the temporary (24h) updates a channel admin posts from
  the channel. They are **not** channel messages (`sock.sendMessage` to the
  `@newsletter` JID) and **not** personal statuses (`sock.sendMessage` to
  `status@broadcast`). They were previously invisible to this library: no
  function, no event, no proto field, and no MEX query existed for them.

  #### Wire format (captured live 2026-11-09, Techword 401🦅)

  A channel status arrives as a top-level `<status>` stanza from the channel's
  `@newsletter` JID — not as a `<message>`:

  ```xml
  <status from="120363331321673219@newsletter" type="text"
          id="3EB079CA1FB41899DF027B" t="1794223368" server_id="136">
    <plaintext><!-- proto.Message bytes --></plaintext>
  </status>
  ```

  The `<plaintext>` child holds a plain `proto.Message` (same encoding as a
  newsletter message): a text status is an `extendedTextMessage` (text,
  `backgroundArgb`, `font`), an image status an `imageMessage`, an audio
  status an `audioMessage`; `messageContextInfo` carries a `messageSecret`.
  Delivered statuses also carry `contextInfo.statusAttributions` with
  `type: 9` (`NEWSLETTER_STATUS` — that value is not in `WAProto.proto` yet,
  which only goes up to `LAYOUTS = 8`).

  Sending mirrors the delivery format: a top-level `<status>` stanza **to**
  the channel JID, same `<plaintext>` payload, id from
  `generateMessageIDV2`. The server assigns `t` and `server_id`.

  #### Receive

  - New `ChannelStatus` type (`src/Types/ChannelStatus.ts`): `id`,
    `channelJid`, `type`, `serverId`, `messageTimestamp`, `offline`, `text`,
    `backgroundArgb`, `font`, `message`.
  - New `decodeChannelStatus(node)` (`src/Socket/channelStatus.ts`) and new
    `'newsletter.status'` event (`src/Types/Events.ts`), wired up in
    `src/Socket/messages-recv.ts` via `ws.on('CB:status', ...)`. No ack is
    sent — the socket delivers live and offline stanzas without it.
  - The handler does not go through the offline processor (its `MessageType`
    is only `'message' | 'call' | 'receipt' | 'notification'`).
  - `proto.Message.decode` is used without `.toJSON()`: `toJSON()` turns the
    font enum `0` into the string `'SYSTEM'`.

  #### Send

  ```ts
  await sock.sendChannelStatus(channelJid, { text: 'Hello' }, { backgroundColor: '#ff0000', font: 2 })
  await sock.sendChannelStatus(channelJid, { image: buffer, caption: 'Photo' })
  await sock.sendChannelStatus(channelJid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true })
  ```

  `sendChannelStatus(jid, content, options)` (`src/Socket/channelStatus.ts`,
  wired into `src/Socket/messages-send.ts` next to `sendGroupStatus`) accepts
  the same content shapes as `sendMessage`. Options: `backgroundColor` for
  text statuses, `font` for text. Returns `{ id, channelJid, message }`.

  #### How to tell whether a post published

  The server's ack for the `<status>` stanza tells you:

  - ack **with `server_id`** (and no `error`) — the status was published.
    Proven live on Techword 401🦅, server ids 139–142, each then delivered
    back to a follower socket as a `newsletter.status` event.
  - ack **without `server_id`** (and no `error`) — the stanza was accepted
    but the status was **not** published. Seen on a brand-new channel
    created via `newsletterCreate` ("Baileys Test Channel",
    `120363412722391397@newsletter`): four posts acked clean and never
    appeared anywhere. A new channel created through the API apparently
    does not have the server-gated channel-status feature enabled.
  - ack with `error: '401'` — the sender is not an admin/owner of the
    channel (only admins can post a channel status).
  - ack with `error: '479'` — the stanza carried a client-set `t`
    attribute; `t` must be left for the server to assign.

  A `<message>` stanza to the channel JID — even with a
  `statusAttributions: [{ type: 9 }]` context — is accepted as a **regular
  channel message** (ack class `message`, with a `server_id`), not a status.
  A `<status>` stanza with the same attribution acks clean as a status.

  #### Tests

  - `src/__tests__/Socket/channel-status.test.ts`: 5 tests — decode of a
    text stanza, offline backlog marking, ignoring non-newsletter stanzas,
    ignoring stanzas with no plaintext, and a send test asserting the stanza
    shape and that it round-trips through the decoder.
  - Live-tested on Techword 401🦅 (2026-11-09): text, coloured text
    (`#ff0000`, font 2), image, and audio statuses all published
    (server ids 139–142) and received by a follower socket.

- **Channel auto-react example** (`Example/channel-auto-react.ts`)

  Follows a channel and reacts to each new post with a random emoji,
  after a random delay of 45s–3min so reactions do not land instantly.
  Uses the built-in `sock.newsletterFollow` and
  `sock.newsletterReactMessage` (the reaction is a `<message
  type="reaction">` IQ carrying the post's `server_id`). Run with the
  channel JID as an argument — never hardcode a channel into a shared
  script. Skips your own posts and posts without a `server_id`.

### Fixed

- **`getStatusCodeForMediaRetry` broke `npm run build`:** it indexed the
  retry-status map with a plain `number`, which `tsc` rejects (TS7053).
  The lookup is now typed to the map's keys; runtime behaviour is
  unchanged.

# 7.0.0-rc14 (2026-07-29)
