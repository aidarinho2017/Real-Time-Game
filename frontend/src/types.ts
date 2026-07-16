export type SessionStatus =
  | "idle"
  | "connecting"
  | "generating"
  | "ready"
  | "paused"
  | "reshaping"
  | "error"
  | "expired";

export type MoveLongitudinal = "idle" | "forward" | "back";
export type MoveLateral = "idle" | "strafe_left" | "strafe_right";
export type LookHorizontal = "idle" | "left" | "right";
export type LookVertical = "idle" | "up" | "down";

export interface LingbotState {
  paused?: boolean;
  running?: boolean;
  started?: boolean;
  current_chunk?: number;
  current_prompt?: string | null;
  current_action?: string;
}

export interface LingbotError {
  command?: string;
  reason?: string;
}

export interface LingbotModel {
  connect(jwt: string): Promise<void>;
  disconnect(recoverable?: boolean): Promise<void>;
  uploadFile(file: File): Promise<unknown>;
  setImage(payload: { image: unknown }): Promise<void>;
  setPrompt(payload: { prompt: string }): Promise<void>;
  setSeed(payload: { seed: number }): Promise<void>;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  reset(): Promise<void>;
  setMoveLongitudinal(payload: { move_longitudinal: MoveLongitudinal }): Promise<void>;
  setMoveLateral(payload: { move_lateral: MoveLateral }): Promise<void>;
  setLookHorizontal(payload: { look_horizontal: LookHorizontal }): Promise<void>;
  setLookVertical(payload: { look_vertical: LookVertical }): Promise<void>;
  setRotationSpeedDeg(payload: { rotation_speed_deg: number }): Promise<void>;
  onMainVideo(callback: (track: unknown, stream: MediaStream) => void): void;
  onState(callback: (state: LingbotState) => void): void;
  onCommandError(callback: (error: LingbotError) => void): () => void;
  onImageAccepted(callback: (message: { width: number; height: number }) => void): () => void;
  onGenerationStarted(callback: () => void): void;
  onGenerationPaused(callback: () => void): void;
  onGenerationResumed(callback: () => void): void;
  onGenerationReset(callback: () => void): void;
  onPromptAccepted(callback: (message: { prompt?: string }) => void): void;
  onChunkComplete(callback: (message: { chunk_index?: number; active_prompt?: string; active_action?: string }) => void): void;
}
