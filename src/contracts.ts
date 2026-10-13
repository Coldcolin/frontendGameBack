// API + socket contracts. Mirrored in frontend/lib/contracts.ts — keep both in sync.

export type Slot = "A" | "B";
export type MatchStatus = "lobby" | "live" | "finished";

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Share of pixels inside the region that differ, 0–1 */
  density: number;
}

export interface ChallengeDTO {
  id: string;
  slug: string;
  title: string;
  kind: "html" | "image";
  /** 600×400 PNG used for grading */
  targetUrl: string;
  /** 1200×800 copy for crisp display */
  displayUrl: string;
  starterCode: string;
}

export interface PlayerDTO {
  slot: Slot;
  name: string;
  handle: string;
  avatarUrl?: string;
  connected: boolean;
  liveScore: number | null;
  officialScore: number | null;
  /** True once finished if the player never changed the starter code */
  didNotStart: boolean;
}

export interface MatchDTO {
  id: string;
  code: string;
  status: MatchStatus;
  durationSec: number;
  startedAt: string | null;
  endsAt: string | null;
  serverNow: string;
  /** Hidden (null) until the match starts, so nobody sees the target early */
  challenge: ChallengeDTO | null;
  /** Shared starter markup; visible in the lobby so the editor can load */
  starterCode: string;
  players: PlayerDTO[];
  winner: Slot | "tie" | null;
}

export interface GradeResult {
  slot: Slot;
  score: number;
  regions: Region[];
  diffUrl: string;
  renderUrl: string;
}

export interface CreateMatchResponse {
  match: MatchDTO;
  links: { a: string; b: string; spectator: string; admin: string };
}

export type Activity = "typing" | "idle";

export interface ServerToClient {
  session: (p: { slot: Slot | null }) => void;
  "match:state": (match: MatchDTO) => void;
  /** Live score for the scoreboard — sent to everyone in the match */
  "player:score": (p: { slot: Slot; liveScore: number; activity: Activity }) => void;
  /** Rendered canvas — sent to spectators only, never to the opponent */
  "player:snapshot": (p: { slot: Slot; png: string; liveScore: number; activity: Activity }) => void;
  "player:activity": (p: { slot: Slot; activity: Activity }) => void;
  "submit:result": (r: GradeResult) => void;
  "match:ended": (match: MatchDTO) => void;
}

export interface ClientToServer {
  "code:update": (p: { code: string }) => void;
  /** The server scores the image itself; clients never report their own score */
  snapshot: (p: { png: string }) => void;
}

export interface SocketAuth {
  matchId: string;
  token?: string;
}
