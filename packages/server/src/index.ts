export { ASSET_KINDS, loadContent, playgroundRoots, type LoadedContent } from "./assets.js";
export { loadProjectScripts, isClientOnlyScript, type ScriptLoadReport } from "./scripts.js";
export {
  HeadlessWorld,
  NULL_INPUT,
  applyBodyState,
  defaultRegistry,
  defaultEvents,
  defaultScripts,
  type HeadlessWorldOptions,
  type AddEntitiesOptions,
} from "./world.js";
export {
  TerrainStreamer,
  resolveServerVoxelWorld,
  type TerrainStreamerOptions,
  type ResolvedServerWorld,
} from "./terrain.js";
export {
  PLAYER_TAG,
  CLIENT_CONTROLLER,
  extractPlayerTemplate,
  instantiatePlayer,
  playerBodyId,
  PlayerDriver,
  type PlayerTemplate,
  type SpawnedPlayerDocs,
  type MovementIntent,
  type PlayerRecord,
  type PlayerDriverOptions,
} from "./players.js";
export {
  GameServer,
  WORLD_MODULE,
  type GameServerOptions,
  type WorldModuleMessage,
  type PlayerIdentity,
  type PlayerPersistence,
  type LeaveReason,
} from "./server.js";
export { NpcManager, type NpcManagerOptions, type NpcRecord, type NpcTemplate } from "./npcs.js";
export { SpawnAreaManager, type SpawnAreaRecord, type SpawnAreaManagerOptions } from "./spawn-areas.js";
export { handleAdmin, type AdminDeps } from "./admin.js";
export { serve, type ServeOptions, type ServeHandle } from "./serve.js";
// -- hosting: cluster, persistence, main --------------------------------------
export { signTicket, verifyTicket, signSession, verifySession, type TicketClaims, type TicketVerdict } from "./cluster/ticket.js";
export { ClusterLink, type ClusterLinkOptions, type Registered } from "./cluster/link.js";
export { PlayerStore, NS_CHARACTER, NS_WORLD, type PlayerSave, type CommitInput } from "./cluster/player-store.js";
export {
  CLUSTER_PATH,
  parseClusterMessage,
  type ServerKind,
  type PlayerPresence,
  type LayerToMain,
  type LayerRpc,
  type MainToLayer,
  type TransferTarget,
} from "./cluster/protocol.js";
export {
  ACCOUNT_NAME,
  CHARACTER_NAME,
  MAX_CHARACTERS,
  MemoryAccountStore,
  hashPassword,
  checkPassword,
  newId,
  type AccountRecord,
  type AccountStore,
  type CharacterRecord,
} from "./persistence/accounts.js";
export { FilePlayerDataBackend, FileAccountStore } from "./persistence/file.js";
export { PostgresStore } from "./persistence/postgres.js";
export { ServerRegistry, type ServerEntry, type Placement, type PlacementOptions } from "./main/registry.js";
export { Supervisor, type SupervisorOptions, type ChildInfo, type SpawnChildOptions } from "./main/supervisor.js";
export { startMain, type MainOptions, type MainHandle } from "./main/main.js";
export { VoxelPool, defaultWorkerCount, type VoxelPoolOptions, type GeneratedCell } from "./voxel-pool.js";
export { SOCIAL_MODULE, socialLine, type SocialEvent } from "./cluster/protocol.js";
export { SocialStore, isBlocked, normalizeSocial, SOCIAL_NAMESPACE, type FriendRef, type SocialRecord, type GuildMembership } from "./main/social.js";
