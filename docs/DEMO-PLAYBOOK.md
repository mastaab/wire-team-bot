# Demo playbook: premium truck support with a Wire App

A presenter's script for showing a truck manufacturer what an app built with the Wire Apps SDK can do for their premium support, with AI in the loop. The bot is a showcase, not a product offer: the point is what the platform makes possible, told through their use case.

## The story in one paragraph

The manufacturer sells premium support with its trucks. Drivers, possibly in defence or other security-sensitive roles, talk in an end-to-end encrypted Wire channel. An app sits in that channel as a member: it notices when a driver has a question, a fault or a part to order, drafts the request, and sends it to the manufacturer's service desk only after the driver says yes. When the desk answers or changes the ticket, the update arrives in the channel as a reply to the conversation about it. When an agent picks the request up, the app opens a private Wire conversation between the driver and that agent, hands it over and leaves. The AI model runs locally on the presenter's laptop, so no conversation text goes to a cloud AI provider.

## Key messages

1. **Wire Apps are full members of encrypted conversations.** The app joins the channel, receives messages through the SDK and replies, quotes, mentions and reacts like any member, over the same end-to-end encryption (MLS) as everyone else.
2. **AI helps; people decide.** The model classifies messages and drafts requests, but nothing leaves Wire without an explicit yes from the driver, and the bot shows the full text first.
3. **Your systems, your data.** The app connects Wire to the tools the customer already runs (here Jira Service Management). It sends only what the driver confirmed, stores only short extracts, and can run the model on the customer's own infrastructure.
4. **Two-way, not a form.** Desk replies and status changes come back into the conversation on their own, threaded under the ticket's earlier messages.
5. **Apps organise conversations, not only take part in them.** The app creates a private group for the driver and the responsible agent, makes them its owners and steps out, so the personal contact is theirs alone.

## Before the demo

**Environment (the day before).**
- Bot running from this checkout with `npm run build && npm start`; `.env` has Wire staging, Jira, `WIRE_TEAM_BOT_JIRA_PASSIVE=on`, the request types, the service scope and `WIRE_TEAM_BOT_JIRA_WATCH_SECONDS=30`. See README for the settings.
- The desk agent is mapped in `WIRE_TEAM_BOT_JIRA_AGENTS` (Jira account ID = Wire handle), and both driver and agent are in the app's Wire team with a signed-in client.
- Ollama running with the local model (`qwen3.5-4b`) if you present the local-AI story; otherwise the chat slots point at the Claude API (faster and more fluent, but conversation text then goes to the API provider).
- Jira DS project: SLAs on the 24/7 calendar, so SLA lines show real times at any hour. No open test requests left (open ones show breached SLAs after a few hours).
- The demo channel must not use Wire Cells: the SDK cannot read Cells file messages yet, so the photo step would silently do nothing.
- A fresh demo channel with Driver A and Driver B, without the app yet: you add it live in step 1, which shows its welcome. The welcome appears only in a channel without a saved purpose, so do not reuse a channel the app has been in.

**Cast.**
- **Driver A** (presenter) in Wire, main screen.
- **Driver B**, a second account in the same channel, to show that any member can follow and close requests.
- **Desk agent** in Jira (browser, second screen or a colleague), logged into the DS service desk queue, and signed in to Wire with the mapped account on a second screen, so the audience sees the private group arrive. The agent is not a member of the drivers' channel.

**Ten minutes before.**
- In a scratch channel with the app, `@<bot> status`: state active, no open support requests.
- Do not restart the bot from now on: a message sent while it restarts may never be processed.
- Close other chats on the shared screen. DS is visible to all Wire Jira users, so type only synthetic truck data.

`<bot>` stands for the app's display name in Wire (for example `STCO-Support-Demo`); the bot uses whatever name the app currently has.

## Run of show (about 40 minutes)

Timing assumes the local model, which takes around 10 to 20 seconds per answer. Fill the pause with the talking point for that step.

### 1. Meet the app (4 min)

Add the app to the demo channel.

Show: its welcome. It leads with the service desk ("Tell me about a fault, a question or a part you need, and I'll offer to raise it with the service desk; nothing is sent without your yes."), says how to follow requests and that desk updates appear in the channel, and then covers decisions, actions and the privacy controls.

Then type `@<bot> timezone Europe/Berlin` and `@<bot> context: premium support for our truck fleet`, and optionally `@<bot> what can you do`, which lists record commands (no mention needed), channel commands and support-request commands (mention needed), in the app's current name.

Say: this is a Wire App. It was added to the channel like a colleague, it sees messages because it is a member of the encrypted group, and the SDK gives it events (messages, members joining and leaving, the conversation being deleted) and ways to answer (text, replies, mentions, reactions).

### 2. A fault, noticed without being asked, and the desk answers (6 min)

Type, without mentioning the bot: `the brake warning light on truck 12 came on this morning`

Show: the bot replies "Shall I report this to the service desk?" with the full text it would send, ending "(yes or no)?". Answer `yes`. It replies "Raised **DS-N** with the service desk" with the link.

Say: the model read an ordinary chat message and recognised a fault. The driver saw exactly what would be sent and decided. Only this text went to Jira; the rest of the conversation did not.

Follow the link to Jira and, as the desk agent, look at the ticket: point out the request type "Submit a request or incident", the driver named as requester and both SLA clocks running. Then, on the ticket:
1. Add a **public reply**, for example "Please check the brake fluid level and send a photo."
2. Add an **internal note**, for example "Likely the sensor; check stock."

Back in Wire, show: within about 30 seconds the reply arrives as a reply quoting the "Raised" message: "New reply from the service desk" with the text. The internal note never appears.

Say: the app checks the tracker for changes and threads each update under the ticket's earlier messages. Internal notes stay internal. No webhook or public endpoint was needed.

### 3. The driver answers with a photo (3 min)

The desk asked for a photo, so post one in the channel: any picture of a dashboard or an engine bay from the phone (never a real vehicle's plate or a person).

Show: the bot replies to the photo "Shall I add this photo to **DS-N** "Brake warning light on truck 12"?" and "(yes or no)?". Answer `yes`. It replies "Added the photo to **DS-N** in Jira." In Jira, the desk agent sees the photo on the ticket with a public reply "Photo from Wire, sent by <name>." The update check does not echo it back into the channel.

Say: the app receives the file through the SDK, downloads and decrypts it as a member of the channel, and passes it to the desk only after the driver's yes. It is held in memory for the upload and never stored. A self-deleting photo is never forwarded, and the same works for documents such as a PDF delivery note.

### 4. The agent takes over, in a private conversation (5 min)

The photo confirms it needs a closer look, so in Jira, as the desk agent:
1. **Assign** the ticket to yourself (the account mapped in `WIRE_TEAM_BOT_JIRA_AGENTS`).
2. Move it to **In progress**.

Show: within about 30 seconds the channel gets "Contact with the responsible support agent (<name>) has been initiated", then "Now in progress.", both as replies in the ticket's thread. On the agent's Wire screen, show the new group named after the ticket (for example "DS-N The brake warning light on truck 12") with the bot's introduction: the agent has picked up the request, the two can talk here directly, the conversation is not recorded in the ticket, and the bot is leaving. The member list shows the driver and the agent, both admins, and no bot. Let the agent write one line there, for example "Hi, I've seen the photo. Are you safe to drive to the depot?", and the driver answer.

Say: when an agent picks a request up, the app creates a private conversation for the two of them in the customer's own Wire team, hands it over and leaves: the bot cannot read it, nothing of it is recorded, and the agent did not have to join the drivers' channel. Ticket updates keep coming in the channel, so the whole team stays informed.

### 5. A part order, completed in conversation (5 min)

Type: `we need a new left mirror for truck 7`

Show: the bot asks only for what is missing ("To order it I need the quantity and the delivery location. What are they?"). Answer `two, deliver to depot north`. The bot shows "Shall I order this part?" with the lines Vehicle, Part, Quantity and Deliver to. Answer `yes`. In Jira the request has the type "Replacement part" and the same lines.

Say: the essentials are checked in code, not left to the model: the order cannot be sent until vehicle, part, quantity and delivery location are known, and every value must come from the driver's own words. A correction such as `actually three` updates the draft.

### 6. A question for the desk (2 min)

Type: `how do I reset the AdBlue warning after a refill?`

Show: "Shall I ask the service desk?"; `yes` raises an "Ask a question" request.

Say: three kinds of request, three queues for the desk, sorted by the AI and confirmed by the driver.

### 7. Follow up in plain language (4 min)

As Driver B, type: `has anyone heard back about the brake light?`

Show: the live status, SLAs and the desk's latest reply.

Then as Driver A: `it only happens when the trailer is attached`

Show: "Shall I add this to **DS-N** …?" with the text; `yes` sends it to the ticket as a reply "Sent from Wire."

Say: no ticket numbers or forms needed; the model matches the message to the right request, and still asks before sending.

### 8. Close the loop (3 min)

Type: `the brake light is fine now, please close it`

Show: the resolve offer with the closing remark as a comment; `yes` resolves the ticket and reports the SLA outcome ("Time to done: met in …").

Alternatively resolve it in Jira as the desk agent and show "Resolved by the service desk." arriving in the channel.

### 9. Off the record (3 min)

Type: `@<bot> secure mode`

Show: the bot confirms it has cleared its short-term memory and will disregard everything. Chat about something sensitive; the bot neither answers nor records anything, even when mentioned. Meanwhile the desk agent moves the part order to In progress. Then type `@<bot> resume`.

Show: after resume, the held-back update about the part order arrives.

Say: security-minded teams can switch the app off for part of a conversation, provably; Wire's encryption is unaffected and always on. `pause` is the lighter version: the bot steps out but still says it is standing by when mentioned.

### 10. Optional: team memory (3 min)

Type: `decision: truck 12 stays off the road until the brakes are checked` and `action: book the brake inspection for truck 12`

Show: the bot records both (a 📝 reaction marks captured actions from ordinary chat, ✅ a completion). `@<bot> status` shows the counts.

Say: the same app keeps decisions, actions and reminders for the team; support is one use case of many.

## What sits behind each moment

| What the audience sees | Wire Apps SDK capability | Customer value |
|---|---|---|
| The app in the channel, reading and replying | App membership of MLS-encrypted conversations; message events | Automation inside the secure channel, not beside it |
| "Shall I …?" replies under the driver's message | Text messages with native replies (quotes) | Clear, threaded conversation |
| A private group for driver and agent when the ticket is picked up | Creating group conversations, member roles and leaving (`createGroupConversation`, `updateConversationMemberRole`, `leaveConversation`), user search by handle | Direct, secure contact without adding the desk to every channel |
| A photo from the driver arriving on the Jira ticket | File messages received and decrypted by the app (`onAssetMessageReceived`, `downloadAsset`) | Evidence from the field reaches the desk without leaving the secure channel first |
| Desk updates quoting the earlier ticket message | Replies to the app's own earlier messages | Each ticket reads as one thread |
| The app's name and members' names in texts, @mentions | User profile lookup, mentions | Natural, correct addressing |
| 📝 and ✅ | Reactions | Lightweight feedback without noise |
| Welcome on joining, clean-up when the channel goes | Conversation and member events | Behaves well in the team's space |

The integration with Jira and the local model are the app's own code: the SDK handles Wire, and the app decides what to connect it to.

## Data and security talking points

- **Messages** stay end-to-end encrypted in Wire. The app decrypts them as a member of the group, like any participant.
- **AI model:** in this demo a small open model runs locally (Ollama, Qwen 3.5 4B), so conversation text does not leave the laptop for AI processing. Any OpenAI-compatible endpoint works, including one hosted by the customer.
- **Service desk:** only what a driver confirmed is sent (the request, a reply, a closing comment). Jira Cloud is used for the demo; for defence customers a customer-hosted tracker would be the production choice.
- **What the app keeps:** short extracts (a request's summary, decisions and actions), not the raw conversation. Secure-mode periods are never used as context.
- **Private groups:** created in the customer's own Wire team, with the driver and the agent as admins; the app leaves before anyone writes there, so it never sees that conversation. The app keeps only the time it opened the group, not the group's ID, and the ticket is not changed.

## Honest limits (say them before the audience finds them)

- It is a showcase built for this story, not a product; the customer's own app would be built for their systems and processes.
- The local model is slow and its wording is sometimes rough; the facts it may state are fixed in code or prompt, and every write needs a yes. The Claude API is faster and more fluent when data policy allows.
- Bot texts are English; it understands drivers in other languages.
- No "typing" indicator while the model works: the SDK does not offer sending one yet.
- Files are picked up only in conversations without Wire Cells: the SDK does not read Cells file messages yet.
- Desk updates arrive within the check interval (30 seconds in the demo), not instantly.
- For the demo, desk agents are mapped to Wire accounts in a setting; a production app would take this from the customer's directory. Driver and agent must be in the app's Wire team and have a signed-in Wire client.
- One private group per request: reassigning the ticket to another agent does not open a second one. The private conversation is not part of the ticket, by design, so agents note outcomes in Jira themselves.

## If something goes wrong

- **No offer after a fault message:** mention the bot and ask directly, `@<bot> can you report this to the service desk?`, or use the direct command `@<bot> support: brake warning light on truck 12` (raises at once, without an offer).
- **An offer you did not want:** answer `no`; nothing is sent.
- **The bot is silent:** wait 30 seconds (the local model can be slow), then try `@<bot> status`. Do not restart during the demo. The log shows errors without message content.
- **A desk update does not appear:** check the change was public (not an internal note) and that the channel is not paused or in secure mode.
- **No private group after assigning:** check that the ticket went to the mapped Jira account and that the agent's Wire account is in the app's team with a signed-in client, then wait for the next check (30 seconds). A ticket that was already assigned when the bot first saw it opens nothing; unassign it, wait for a check, and assign it again.
- **SLA lines say "under a minute":** the SLA ran on a working-hours calendar; switch DS to the 24/7 calendar and use a fresh request.

## After the demo

- Resolve the demo tickets in Jira (or from Wire with `@<bot> resolve DS-N`).
- Delete the private demo groups from the driver's or agent's Wire client (both are admins; the bot has already left).
- Remove the demo channel's records if the channel will be reused.
- Note what the customer asked about in PLAN.md, section 6.
