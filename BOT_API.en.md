# Junqi Bot API

In Junqi, bots may participate only in **Hidden** Free-for-All or Partnerships. Other deployment/reveal modes and Landlord do not allow bots. A room with bots cannot be changed to unsupported modes.

Texas Hold’em also supports external bots by default, without an additional administrator permission grant. See [Hold’em BOT API and runnable client](HOLDEM_BOT_API.md).

## Draws and permissions

The five-move bot loss rule and `quietMoves` / `quietMoveLimit` have been removed. Games with bots draw automatically after 16 consecutive whole-board legal moves with no piece deaths, or after initial seat count × 128 total moves. No rating is awarded. These limits remain after a bot is eliminated. Human-only games are exempt. Each bot has separate local/external and server-hosted time limits, default five seconds.

Room fields include `ply`, `noCapturePly`, `noCapturePlyLimit` (16), `initialPlayerCount`, `totalPlyLimit` (256/384/512), `drawn` and `autoDrawReason` (`no-capture`, `move-limit`, or `null`). Only legal, nonduplicate moves increment counters. Any piece loss resets `noCapturePly`. Undo restores counters; restarts preserve them. A normal victory takes priority over automatic draw. Stop submitting actions when `phase` is `finished`.

Bot accounts may use Bot Studio, program management and bot APIs only. Username lookup is case-insensitive; responses preserve original spelling. Site-wide mute affects chat; restricted accounts may log in and read permitted data but cannot act or host programs.

## Integration methods

Use [Bot Studio](/bot-studio.html) to paste JavaScript hosted in the server's isolated environment, or run an external client on your own machine. An approved bot account is required. The human room owner assigns accounts to seats and starts the game after readiness. All-bot games affect bot ratings, human-only games affect human ratings, and mixed games do not affect ratings.

One account can control multiple rooms or seats, each with an independent `assignmentId` and hosted memory. Repeated seats average their changes and update account rating once. Finished assignments disappear from the active session. Logging out of the website does not stop a saved enabled program; use Stop Hosting.

## Hosted program

Define synchronous `function act(state)` returning an action and optionally JSON `memory`:

```javascript
function act(state) {
  if (state.phase === 'setup') return {action:'ready', ready:true};
  if (state.phase !== 'playing' || state.turn !== state.viewerSeat) return null;
  const move = state.legalMoves[0];
  return move ? {action:'move', from:move.from, to:move.to} : null;
}
```

This minimal example uses the existing layout and first legal move, not a competitive strategy. Submit `setup` only when `programPrepared` is false, then `ready` on a later call to avoid endless redeployment.

| Action | Additional fields | Purpose |
|---|---|---|
| setup | `pieces:[{id,position},...]` | Submit all 25 friendly pieces |
| ready | `ready:true/false` | Set readiness |
| move | `from,to` | Make a move |
| resign | None | Resign |
| draw | `accept`, existing `offerId` | Offer, accept or decline a draw |

`memory` is JSON with at most 16384 serialized characters, isolated by assignment. Saving source resets runtime state. Source is limited to **1 MiB UTF-8**. QuickJS provides no Node.js, network, files, shell, module imports or asynchronous timers. JS heap is limited to 48 MiB; WASM memory to 64 MiB. A Worker enforces execution time. Use `Date.now()` and return before the deadline. Limits are configured per account from 1–120 seconds, with a scheduling margin deducted from the available program budget. Errors are reported and retried, but failing to submit a legal move before the turn deadline loses the seat. Stop hosting before using an external client on that assignment.

## External clients and encryption

Business APIs use **HTTPS plus application-layer encryption**. Plain JSON business requests normally return 426. Authorization and request bodies are inside the encrypted envelope; the server then checks account, assignment and move permissions.

Download [secure-client.js](/downloads/secure-client.js) into an ESM Node.js project. Node 18+ is supported without extra npm packages.

```javascript
import {createSecureClient} from './secure-client.js';
const client = createSecureClient(process.env.BOT_SERVER);
const response = await client.fetch('/api/bot/login', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:process.env.BOT_USERNAME,password:process.env.BOT_PASSWORD})
});
const account = await response.json();
if (!response.ok) throw Error(account.error);
const headers = {Authorization:`Bearer ${account.token}`};
const session = await (await client.fetch('/api/bot/session',{headers})).json();
for (const assignment of session.assignments) {
  const url = `/api/bot/rooms/${assignment.code}?assignmentId=${encodeURIComponent(assignment.assignmentId)}`;
  const state = await (await client.fetch(url,{headers})).json();
  console.log(assignment.seat,state.phase,state.legalMoves.length);
}
```

The sample only logs in and reads assignments. A real bot polls sessions, maintains independent state per assignment, and submits legal moves on its turn. A complete reference client is available as [siguo-junqi-bot.mjs](/downloads/siguo-junqi-bot.mjs).

### Implementing the encrypted transport

1. Generate RSA-OAEP keys (reference: 3072 bits, SHA-256). POST plain JSON `{publicKey: publicJWK}` to `/api/crypto`.
2. Receive channel `id` and Base64 `key`. RSA-decrypt `key` to obtain the 32-byte AES key.
3. Encrypt each UTF-8 JSON request with AES-256-GCM, a random 12-byte IV, 128-bit authentication tag, and UTF-8 AAD `client-v1`. Plaintext: `{kind:"http",url:"/api/...",method:"GET",authorization:"Bearer ...",body:{},time:millisecondTimestamp,nonce:uniqueString}`. Login has no authorization; GET may omit body.
4. POST `{id,iv:Base64,data:Base64}` to `/api/secure`. `data` is ciphertext followed by the GCM tag, matching WebCrypto output.
5. Decrypt responses with the same AES key and AAD `server-v1`. The decrypted JSON `value` is the business response. Validate time and nonce. HTTP status preserves the business status.

The server allows at most two minutes of time skew and rejects repeated nonces. Recreate lost or expired channels. Do not log credentials or keys. Encryption protects transport integrity; the server still processes plaintext and compromised endpoints are outside this protection. Validate HTTPS certificates.

## Authentication and directory

`POST /api/bot/login` with `{username,password}` returns `token,username,accountType`. Use Bearer authorization for business requests. Tokens normally last seven days; log in again after logout, password changes, deletion or server restart. Human tokens receive 403 on bot-only routes.

`GET /api/bots` returns approved bots with `username,rating,online,seats,localTurnLimitMs,serverTurnLimitMs,runtimeMode`. `seats` counts occupied assignments; the two time limits apply to external and hosted clients. Bot and human rankings are separate.

## Reading state

| Endpoint | Response |
|---|---|
| GET /api/bot/board | `nodes,roads,rails,straightRailLines,pieceInfo,turnLimitMs` |
| GET /api/bot/session | `apiVersion:2,username,assignments` |
| GET /api/bot/rooms/CODE?assignmentId=ID | Assignment-specific state |

Each assignment is `{code,seat,assignmentId}`. With no seat the array is empty. Legacy `assignment` is an object only with exactly one seat, otherwise null. Always send `assignmentId`. Board and room responses currently use `apiVersion:1`, separately from the session version.

| Field | Meaning |
|---|---|
| code / assignmentId / revision | Room, seat allocation and state revision |
| viewerSeat / turn | Your seat / active seat (`north,east,south,west`) |
| phase / mode | `setup,playing,finished`; `ffa,alliance` |
| activeSeats | Territories enabled for this game |
| occupiedSeats / livingSeats | Noneliminated occupied seats / territories with surviving pieces |
| ready / eliminated / winner | Your readiness, elimination and winning side |
| serverTime / deadline | Server milliseconds / turn deadline or null |
| pieces / records | Board pieces / all records including null positions |
| battles | Public attacker/defender IDs and outcomes |
| legalMoves | Legal `{from,to}` pairs; empty outside your turn |
| logs / lastMove | Visible battle log / last move |

Pieces are `{id,owner,position,initialPosition,moved,type}`. Only friendly or publicly revealed identities have a real `type`; hidden enemies and allies have null. Debug and finished games do not disclose additional information through bot APIs. IDs are identifiers; do not infer identities from array ordering.

Territory positions use IDs such as `north-0-0`, with zero-based rows/columns, row zero at the front and row five at the rear. Read central positions from `board.nodes`. Use `straightRailLines` for corner railways rather than screen geometry.

## Submitting actions

POST `/api/bot/rooms/CODE/ACTION` with `assignmentId,revision,requestId` plus action fields. Supported external actions are `setup`, `ready`, `move` and `resign`. Setup requires all 25 friendly IDs and unique positions; it cannot change types. Move requires your turn, a valid move and an unexpired deadline.

Success returns `{ok:true,requestId,revision}`. Request IDs contain 6–80 letters, digits, underscores or hyphens; UUIDs are recommended. If a network failure makes success uncertain, retry the same ID and identical body. The most recent 128 successful requests are deduplicated. Never reuse an ID for a different action.

Revision changes for gameplay, deployment, readiness and participant updates, but not chat or heartbeats. On 409 reread state. Removing and readding a bot creates a new assignment ID; old allocations cannot act for it.

## Errors and recovery

| Status | Action |
|---|---|
| 400 | Inspect `error`: invalid data, layout, move or envelope |
| 401 | Log in again |
| 403 | Check account and assignment permission |
| 404 | Resource or endpoint missing |
| 409 | Reread changed state or check hosting conflict |
| 426 | Use encrypted transport |
| 429 | Back off before retrying |

The effective turn limit depends on the account's current runtime mode and includes polling and network time. Use `deadline-serverTime` and leave a margin. The server eliminates timed-out bots instead of making random moves. After server restart, login tokens expire; saved enabled hosted programs reconnect. For offline programs check enabled state, assigned seats, reported errors and server logs.

## Program management

These encrypted routes use the bot's web-login token and affect only its own program:

| Endpoint | Request / response |
|---|---|
| GET /api/program | `source,enabled,message,assignments` and status |
| PUT /api/program | `{source}`: validate, save, stop and reset memory |
| POST /api/program/run | `{enabled:true/false}`: start or stop |

[Download this document](/BOT_API.en.md).
