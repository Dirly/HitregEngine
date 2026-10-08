# Storage, worlds, and leaving the game

Main owns accounts and durable data. Layers and dungeon instances simulate gameplay and send saves to main over the authenticated cluster link; browsers send intent and never supply a save identity. See [hosting](hosting.md) for placement and transfers and ARCHITECTURE §3c for the platform/game-data boundary.

## World ownership

A world is a stable main-server identity, independent of its scene, zones, and copies. Configure it with --world-id and --world-name. Keep the id stable across restarts and content updates: changing it creates a different character roster. A layer transfer stays inside that world's main; selecting another world happens before entering play.

Accounts can have one live character on each world. Main filters both live and restorable rosters to its world and rejects play, deletion, or restoration of a character from another world. Restoring requires a free slot on that world. Existing deletion grace and reserved-name rules still apply. A character whose body is connected or retained for reconnect cannot be deleted.

Characters created before world ownership existed bind permanently to the first main that reads the authenticated account. Do the first login against their original world. Existing legacy rosters with several characters are preserved rather than discarded; they cannot create another character on that world until the slot is free.

GET /worlds is an authenticated directory. It lists the serving world and the other mains configured in --worlds (a JSON array with id, name, and gateway URL). The current main reports its layer population; other mains have unknown availability until selected. The client checks the destination's roster and world id before committing a selection. An unavailable or misconfigured destination leaves the current selection intact.

Worlds that share sign-in must share the account database and session-signing secret. Their game experience id determines the player-data scope; new character identities keep saves separate even when worlds share an experience. Use distinct main and layer ports on a shared host.

## Save identities and conflicts

Account ids identify people: authentication and friendships remain account scoped. New gameplay saves use a separate, server-owned identity for each character. Main includes it in signed join and transfer tickets, and layers use that identity when loading and committing through PlayerStore. Progress, inventory, persisted gameplay records, and saved positions therefore belong to that character. Deleting and replacing a character creates a fresh save identity; restoring keeps the original one.

Legacy characters retain their account-based save identity, so existing progress remains accessible. Old tickets without a save identity also retain their existing account-based behavior. This is a compatibility path, not a copy of old progress into every newly created character.

PlayerStore stores the character snapshot and scene positions through the revisioned PlayerDataBackend contract. The core PERSISTED_PLAYER_NAMESPACES declaration defines which gameplay records accompany the sheet; consult its schema/spec rather than maintaining a second list here. Transfer tickets carry committed revisions, and destinations wait for a save at least that recent before spawning.

Account roster changes use compare-and-swap against the record read by the request. A stale change returns HTTP 409 and asks the client to refresh, preventing one world's creation/deletion from overwriting another world's roster. Memory and file stores support this within one process. Postgres performs the comparison in the UPDATE itself, across mains.

Files under the playground's .hitreg/data directory are the default single-main backend. File locks are process local: do not point multiple mains at the same directory. Use a shared Postgres backend (--database or HITREG_DATABASE_URL) for multiple worlds sharing accounts. Memory stores are for tests. Back up the accounts and player-data store together, preserve world ids and experience ids, and retain the signing secret when restarting a deployment.

## Camp versus disconnect

The core player.logout event is a request to the authority (its validated surface is in spec.json). The server selects the caller's body from the authenticated peer; a client cannot nominate somebody else's character.

Camp takes 20 uninterrupted seconds on the server clock. Movement, actions, combat, downed state, looting, transfer, or disconnect cancel it. The client shows the server's countdown and offers cancellation. At zero it shows saving; the server waits for an older in-flight write, captures a fresh snapshot, and confirms logout only after that save succeeds. The client then closes its session and returns to the selected world's character screen while retaining sign-in. A failed save leaves the player connected and reports that camp should be retried.

Closing a tab or losing a connection is not a completed camp. The body remains for a default 60-second reconnect window (--grace can configure it). Reconnecting during that window reclaims the existing body. Combat and loot locks may hold it longer. Transfers have their own save-before-departure path and remove the source body without this reconnect grace.

## Browser caches

The gateway session, selected main, and last character per world are browser-local caches, not ownership records. Main still validates every character action and ticket. After a page reload the remembered main keeps play and social calls on the selected world; the original gateway remains the directory for changing worlds.

Player-created map markers currently live in localStorage, scoped to character/world/scene. They are not stored in the database and do not follow a player to another browser. Database-backed markers would require a separate authenticated, per-character record and synchronization path; this work does not add that service.
