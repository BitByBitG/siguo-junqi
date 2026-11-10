# Junqi Rules

## Free Texas Hold’em

The Hold’em navigation link appears only after an administrator enables your player account. Use `/holdem` to create or join a table. Unapproved, revoked and bot accounts cannot use Hold’em APIs. Accounts, theme, language, encrypted images and chat components are shared with Junqi; Hold’em never changes Junqi ratings. Tables support 2–9 players. The Rules section on the Hold’em page explains betting, hand rankings, all-ins and side pots. Chips persist per account. Buy-ins debit your wallet and settled departures return chips. No borrowing or negative balances. Administrators configure initial and daily grants; daily grants use Beijing midnight. There are no deposits, withdrawals, transfers, paid entries or real-world prizes; cash gambling and off-site settlement are prohibited.

## Automatic draws in games with bots

The old five-move bot loss rule has been removed. A game that started with a bot ends in a draw if either condition is reached:

- 16 consecutive legal moves across the whole board without a piece being removed.
- Total moves reach the initial number of participating seats × 128: 256 for two players, 384 for three, or 512 for four.

A move is one player's legal move, not a complete round. Human and bot moves both count. Captures, mutual destruction and elimination reset the no-capture counter; total moves do not reset. Invalid requests, duplicate requests, chat and deployment do not count. Undo restores the counters, and restarting the server preserves them. Eliminating a bot does not disable these limits. Human-only games do not use them. If the final move produces a normal victory, victory takes priority. Draws do not affect ratings. Bot timeouts still cause defeat.

## Starting a game

Create or join a room on the Games page. Modes include Free-for-All, Partnerships, Semi-Random Deployment, Random Deployment (Computer Lab Rules), and four-player Landlord. Before starting, the owner may change the room name, player count, mode and reveal rules. Changing rules cancels everyone's readiness and resets deployment. These settings are locked once play begins. The six-character room ID stays unchanged; invitations use `/room/CODE`.

Take an empty seat to play, or stay unseated to spectate. Deploy your pieces and click Ready. The owner starts when everyone is ready. Games are listed as Upcoming, Ongoing or Finished. Ongoing games survive server restarts. Finished-game retention follows the owner's group settings, disabled by default; retained history is limited to 1 GiB. Administrators may delete chat or rooms and abort games without rating changes. Owners cannot forcibly close a rated game in progress or replace its participants.

## Pieces and deployment

Each normal army has 25 pieces on a six-row, five-column territory. Row one is closest to the center; row six is the rear. Left and right are from that player's perspective.

| Piece | Count | Combat strength |
|---|---:|---:|
| Commander-in-Chief | 1 | 9 |
| Army Commander | 1 | 8 |
| Division Commander | 2 | 7 |
| Brigade Commander | 2 | 6 |
| Regiment Commander | 2 | 5 |
| Battalion Commander | 2 | 4 |
| Company Commander | 3 | 3 |
| Platoon Commander | 3 | 2 |
| Engineer | 3 | 1 |
| Bomb | 2 | Special |
| Landmine | 3 | Immobile |
| Flag | 1 | Immobile |

Camps must initially be empty. The flag must occupy either headquarters, in column two or four of the rear row. Mines must be in the rear two rows; bombs cannot be in the front row. Click two friendly pieces to swap them. The server validates deployment when you become ready.

Semi-Random Deployment generates a legal layout which cannot be edited, mirrored or replaced with a saved layout. Random Deployment (Computer Lab Rules) places the standard pieces randomly in all non-camp positions without normal deployment restrictions. Reveal Defender is its default. Movable pieces may leave headquarters in this mode. You may reroll if your flag is in the front two rows, or on a railway in the front four rows. In ordinary modes, Random Deployment generates a legal layout; Mirror Layout swaps columns one/five and two/four. You can save up to three private layouts.

## Landlord

Four human players are required. The initial pool contains 96 normal pieces: four standard armies excluding their flags. Each player receives 19 random pieces and a flag, with fewer than ten mines. The owner starts landlord selection after dealing. The first player to claim it becomes the landlord.

Each farmer receives five additional platoon commanders, for 25 pieces total, and deploys on non-camp positions using ordinary restrictions. Farmers' flags are public throughout play. The landlord draws 19 pieces without replacement from the remaining 20 normal pieces plus one Marshal, one Missile and one Fortress. Each special piece can occur at most once. The landlord has 39 pieces, occupying all 30 positions in their territory and the nine central positions. They may swap pieces in camps as well. Only the flag must be in headquarters; the landlord's flag does not become public when their commander dies. Farmers are allied. Eliminating the landlord wins for the farmers; eliminating all farmers wins for the landlord.

A Marshal outranks the Commander-in-Chief. A Missile turns on railways like an Engineer, defeats Battalion Commanders and weaker pieces, and mutually destroys Brigade Commanders and stronger pieces. A Fortress cannot move and cannot be destroyed by normal pieces or Missiles; a Bomb destroys it mutually. After a battle, deaths of Commanders-in-Chief and Marshals are announced separately, without revealing their cause or number.

## Roads, railways and camps

Road moves go to one directly connected adjacent position. Railway moves may traverse any number of consecutive empty points without jumping pieces. An enemy at the destination causes combat; friendly or allied pieces block entry.

Only Engineers and Landlord Missiles may turn at railway intersections. Corner connections between neighboring territories count as a continuous straight railway, even though they bend visually. A turning Engineer or Missile becomes publicly identified.

The nine central points form straight railway connections along rows and columns. Front-row columns one, three and five connect to the center; two and four do not. Side railways exclude the rear row. The central camp at row three, column three does not connect to railways. Opposite territories can attack along an unobstructed continuous side railway.

Pieces in camps cannot be attacked. Empty camps may be entered. Pieces entering headquarters cannot move again, except in Computer Lab Rules. Flags and mines never move. In two- and three-player games, unused territories cannot be entered or crossed. A territory vacated during the game remains part of the board.

## Combat and reveal rules

Stronger normal pieces defeat weaker ones. Equal ranks destroy each other. An Engineer attacking a mine survives and removes it; other normal attackers die. A Bomb on either side destroys both pieces, including when attacking a flag; losing the flag eliminates that army.

Hidden is the default: you see your own pieces, but not hidden enemy or allied identities. Reveal Defender permanently reveals the attacked piece after combat. Reveal Both permanently reveals both participants. These modes do not reveal all pieces at the start. Turning Engineers/Missiles and flag revelation still follow their special rules. Commander death reveals the flag, except the landlord's flag.

## Results, leaving seats and undo

Capturing a flag, resignation or having no legal move eliminates an army. The last surviving side wins. A draw requires agreement from all surviving players, not eliminated players, and does not affect rating. Before the next player moves, a non-capturing move can be undone; a move that removes any piece cannot be undone. Finished games cannot be undone.

Ordinary unranked games allow players to leave seats while their pieces stay in place for replacements. Leaving a rated game counts as resignation and its participants cannot be replaced. Finished games offer full-information replay and downloadable logs. In-game history retains the viewer's information restrictions. Personal marks are not shown in replay.

## Ratings

All-human games affect human ratings; all-bot games affect separate bot ratings; mixed games are not rated. The Elo base factor is 512. A winner with a higher rating receives the larger of the normal Elo gain and 70 points. For equal ratings, the base win gain is 256. Upsets and losing-side changes use normal Elo calculations. Team results calculate the two sides separately. Repeated seats using one account are averaged and update that account once. Ratings are bounded between 0 and 8000; accounts with no rated games show Unrated.

## Bots and spectators

Bots support Hidden Free-for-All and Partnerships only. An approved bot can use a local API client or JavaScript hosted in Bot Studio. Local and hosted limits are set separately per account, defaulting to five seconds. Only humans own rooms. One bot account can occupy multiple independent seats. Spectators cannot see hidden identities unless the owner enables debug in an all-bot game; bot API responses remain restricted.

## Chat and display

Chat supports Markdown, LaTeX, image links and pasted uploads, mentions and emoji reactions. Long messages fold after ten lines. Copy Source copies the original message. Chat can expand to fill the browser. Group chat is visible to its members and administrators. Moderators can mute or delete messages; authors can recall their own messages. Notification, avatar, theme and discreet-mode preferences are available in Settings. Discreet mode is only used on the game screen. User content is not translated by the language switch.
