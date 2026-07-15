import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { LingbotWorld2Model } from "@reactor-models/lingbot-world-2";
import {
  DEFAULT_PROMPT,
  DEFAULT_SESSION_SECONDS,
  DEFAULT_WORLD_IMAGE,
  MAX_IMAGE_BYTES,
} from "./constants";
import type {
  LingbotError,
  LingbotModel,
  LingbotState,
  LookHorizontal,
  LookVertical,
  MoveLateral,
  MoveLongitudinal,
  SessionStatus,
} from "./types";

const configuredSessionSeconds = Number(import.meta.env.VITE_MAX_SESSION_SECONDS);
const SESSION_SECONDS = Number.isFinite(configuredSessionSeconds) && configuredSessionSeconds > 0
  ? configuredSessionSeconds
  : DEFAULT_SESSION_SECONDS;

const statusLabels: Record<SessionStatus, string> = {
  idle: "Waiting to enter",
  connecting: "Connecting to world model",
  generating: "World is alive",
  ready: "World ready",
  paused: "Paused",
  reshaping: "Re-anchoring world",
  error: "Needs attention",
  expired: "Session limit reached",
};

function normalizeModel(model: LingbotWorld2Model): LingbotModel {
  return model as unknown as LingbotModel;
}

async function setImageAndWaitForAcceptance(model: LingbotModel, image: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutId: number | undefined;
    let unsubscribeAccepted: () => void = () => {};
    let unsubscribeError: () => void = () => {};

    const cleanup = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      unsubscribeAccepted();
      unsubscribeError();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    unsubscribeAccepted = model.onImageAccepted(() => finish());
    unsubscribeError = model.onCommandError((error) => {
      if (error.command && error.command !== "set_image") return;
      finish(new Error(error.reason || "The world model could not decode the reference image."));
    });
    timeoutId = window.setTimeout(() => {
      finish(new Error("The world model did not confirm the reference image in time."));
    }, 15_000);

    void model.setImage({ image }).catch((caught) => {
      finish(caught instanceof Error ? caught : new Error("Could not set the reference image."));
    });
  });
}

async function defaultImageAsPng(): Promise<File> {
  const response = await fetch(DEFAULT_WORLD_IMAGE);
  const sourceBlob = await response.blob();
  const bitmap = await createImageBitmap(sourceBlob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not prepare the default image"))), "image/png");
  });
  return new File([png], "default-fantasy-forest.png", { type: "image/png" });
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = Math.max(0, seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function captureVideoFrame(video: HTMLVideoElement): string | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const modelRef = useRef<LingbotModel | null>(null);
  const activeImageRef = useRef<File | null>(null);
  const basePromptRef = useRef(DEFAULT_PROMPT);
  const seedRef = useRef(42);
  const sessionStartedAtRef = useRef<number | null>(null);
  const heldKeysRef = useRef(new Set<string>());
  const lastCompletedChunkRef = useRef<number | null>(null);
  const pendingActionRef = useRef<{ basePrompt: string; submittedChunk: number | null } | null>(null);

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [draftPrompt, setDraftPrompt] = useState(DEFAULT_PROMPT);
  const [activeImageName, setActiveImageName] = useState("Dawn forest seed");
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [error, setError] = useState("");
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(SESSION_SECONDS);
  const [chunk, setChunk] = useState(0);
  const [lastAction, setLastAction] = useState("still");
  const [actionDraft, setActionDraft] = useState("");
  const [isActionPending, setIsActionPending] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);

  const setModelStatus = useCallback((nextStatus: SessionStatus) => {
    setStatus(nextStatus);
    if (nextStatus !== "error") setError("");
  }, []);

  const handleModelError = useCallback((message: LingbotError) => {
    if (message.command === "set_prompt" && pendingActionRef.current) {
      pendingActionRef.current = null;
      setIsActionPending(false);
    }
    setError(message.reason || `The world model rejected ${message.command || "that action"}.`);
    setStatus("error");
  }, []);

  const attachModelListeners = useCallback((model: LingbotModel) => {
    model.onMainVideo((_track, stream) => {
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      setHasVideo(true);
      void videoRef.current.play().catch(() => undefined);
    });
    model.onState((state: LingbotState) => {
      setChunk(state.current_chunk ?? 0);
      if (state.running) setStatus("generating");
      else if (state.paused) setStatus("paused");
      else if (state.started) setStatus("ready");
    });
    model.onCommandError(handleModelError);
    model.onGenerationStarted(() => {
      if (!sessionStartedAtRef.current) sessionStartedAtRef.current = Date.now();
      setFrozenFrame(null);
      setStatus("generating");
    });
    model.onGenerationPaused(() => setStatus("paused"));
    model.onGenerationResumed(() => setStatus("generating"));
    model.onPromptAccepted((message) => {
      if (message.prompt && !pendingActionRef.current) {
        basePromptRef.current = message.prompt;
        setPrompt(message.prompt);
        setDraftPrompt(message.prompt);
      }
    });
    model.onChunkComplete((message) => {
      const completedChunk = message.chunk_index;
      if (completedChunk !== undefined) {
        lastCompletedChunkRef.current = completedChunk;
      }
      setChunk(completedChunk ?? 0);
      setLastAction(message.active_action || "still");

      const pendingAction = pendingActionRef.current;
      const actionChunkReached = pendingAction && (
        pendingAction.submittedChunk === null
        || completedChunk === undefined
        || completedChunk > pendingAction.submittedChunk
      );
      if (pendingAction && actionChunkReached) {
        pendingActionRef.current = null;
        setIsActionPending(false);
        void model.setPrompt({ prompt: pendingAction.basePrompt }).catch((caught) => {
          setStatus("error");
          setError(caught instanceof Error ? caught.message : "Could not restore the scene prompt.");
        });
      }
    });
  }, [handleModelError]);

  const getToken = useCallback(async (): Promise<string> => {
    const response = await fetch("/api/reactor/token", { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || "Could not authenticate with Reactor.");
    if (!payload.jwt) throw new Error("Reactor did not return a session token.");
    return payload.jwt as string;
  }, []);

  const startSession = useCallback(async () => {
    try {
      setModelStatus("connecting");
      const jwt = await getToken();
      const model = normalizeModel(new LingbotWorld2Model());
      modelRef.current = model;
      attachModelListeners(model);
      await model.connect(jwt);

      const image = activeImageRef.current || await defaultImageAsPng();
      activeImageRef.current = image;
      if (!activeImageRef.current) throw new Error("No reference image is ready.");

      await model.setSeed({ seed: seedRef.current });
      const fileRef = await model.uploadFile(image);
      await setImageAndWaitForAcceptance(model, fileRef);
      await model.setPrompt({ prompt });
      await model.start();
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not start the world.");
    }
  }, [attachModelListeners, getToken, modelRef, prompt, setModelStatus]);

  const restartWithImage = useCallback(async (image: File, nextPrompt = prompt) => {
    const model = modelRef.current;
    if (!model) {
      activeImageRef.current = image;
      setActiveImageName(image.name);
      return;
    }

    try {
      const frame = videoRef.current ? captureVideoFrame(videoRef.current) : null;
      setFrozenFrame(frame);
      setModelStatus("reshaping");
      await model.reset();
      const fileRef = await model.uploadFile(image);
      await model.setSeed({ seed: seedRef.current });
      await setImageAndWaitForAcceptance(model, fileRef);
      await model.setPrompt({ prompt: nextPrompt });
      activeImageRef.current = image;
      setActiveImageName(image.name);
      await model.start();
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not re-anchor the world.");
    }
  }, [modelRef, prompt, setModelStatus]);

  const applyChanges = useCallback(async () => {
    if (!draftPrompt.trim()) {
      setError("Give the world a short description before applying changes.");
      setStatus("error");
      return;
    }
    const nextPrompt = draftPrompt.trim();
    basePromptRef.current = nextPrompt;
    setPrompt(nextPrompt);
    if (selectedImage) {
      await restartWithImage(selectedImage, nextPrompt);
      setSelectedImage(null);
      return;
    }
    if (!modelRef.current) return;
    try {
      await modelRef.current.setPrompt({ prompt: nextPrompt });
      setError("");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not apply the prompt.");
    }
  }, [draftPrompt, modelRef, restartWithImage, selectedImage]);

  const performAction = useCallback(async () => {
    const model = modelRef.current;
    const action = actionDraft.trim();
    if (!model || !action || isActionPending) return;

    const basePrompt = basePromptRef.current;
    pendingActionRef.current = {
      basePrompt,
      submittedChunk: lastCompletedChunkRef.current,
    };
    setIsActionPending(true);
    setActionDraft("");
    try {
      await model.setPrompt({ prompt: `${basePrompt}. Player action: ${action}.` });
    } catch (caught) {
      pendingActionRef.current = null;
      setIsActionPending(false);
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not send the player action.");
    }
  }, [actionDraft, isActionPending]);

  const handleReset = useCallback(async () => {
    const model = modelRef.current;
    if (!model) {
      await startSession();
      return;
    }
    try {
      pendingActionRef.current = null;
      setIsActionPending(false);
      lastCompletedChunkRef.current = null;
      setModelStatus("reshaping");
      const nextSeed = Math.floor(Math.random() * 2_000_000_000);
      seedRef.current = nextSeed;
      const image = activeImageRef.current || await defaultImageAsPng();
      await model.reset();
      await model.setSeed({ seed: nextSeed });
      const fileRef = await model.uploadFile(image);
      await setImageAndWaitForAcceptance(model, fileRef);
      await model.setPrompt({ prompt });
      await model.start();
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not reset the world.");
    }
  }, [modelRef, prompt, setModelStatus, startSession]);

  const togglePause = useCallback(async () => {
    const model = modelRef.current;
    if (!model) return;
    try {
      if (status === "paused" || status === "expired") {
        if (status === "expired") {
          sessionStartedAtRef.current = Date.now();
          setRemainingSeconds(SESSION_SECONDS);
        }
        await model.resume();
      } else {
        await model.pause();
      }
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not change playback state.");
    }
  }, [modelRef, status]);

  const syncControls = useCallback(() => {
    const model = modelRef.current;
    if (!model) return;
    const keys = heldKeysRef.current;
    const longitudinal: MoveLongitudinal = keys.has("w") && !keys.has("s")
      ? "forward"
      : keys.has("s") && !keys.has("w") ? "back" : "idle";
    const lateral: MoveLateral = keys.has("a") && !keys.has("d")
      ? "strafe_left"
      : keys.has("d") && !keys.has("a") ? "strafe_right" : "idle";
    const horizontal: LookHorizontal = keys.has("arrowleft") && !keys.has("arrowright")
      ? "left"
      : keys.has("arrowright") && !keys.has("arrowleft") ? "right" : "idle";
    const vertical: LookVertical = keys.has("arrowup") && !keys.has("arrowdown")
      ? "up"
      : keys.has("arrowdown") && !keys.has("arrowup") ? "down" : "idle";
    void model.setMoveLongitudinal({ move_longitudinal: longitudinal });
    void model.setMoveLateral({ move_lateral: lateral });
    void model.setLookHorizontal({ look_horizontal: horizontal });
    void model.setLookVertical({ look_vertical: vertical });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const key = event.key.toLowerCase();
      if (!["w", "a", "s", "d", "arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) return;
      event.preventDefault();
      heldKeysRef.current.add(key);
      syncControls();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const key = event.key.toLowerCase();
      if (!["w", "a", "s", "d", "arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) return;
      heldKeysRef.current.delete(key);
      syncControls();
    };
    const onBlur = () => {
      heldKeysRef.current.clear();
      syncControls();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [syncControls]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!sessionStartedAtRef.current || status === "paused" || status === "expired" || status === "idle") return;
      const elapsed = Math.floor((Date.now() - sessionStartedAtRef.current) / 1000);
      const remaining = Math.max(0, SESSION_SECONDS - elapsed);
      setRemainingSeconds(remaining);
      if (remaining === 0 && modelRef.current) {
        void modelRef.current.pause().catch(() => undefined);
        setStatus("expired");
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [modelRef, status]);

  const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const image = event.target.files?.[0];
    if (!image) return;
    if (!image.type.startsWith("image/")) {
      setError("Choose an image file.");
      setStatus("error");
      return;
    }
    if (image.size > MAX_IMAGE_BYTES) {
      setError("Images must be 10 MB or smaller.");
      setStatus("error");
      return;
    }
    setSelectedImage(image);
    setError("");
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void applyChanges();
  };

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /></div>
          <div>
            <p className="eyebrow">REACTOR / LINGBOT WORLD 2</p>
            <h1>Living Worlds</h1>
          </div>
        </div>
        <div className="topbar-meta">
          <span className={`status-dot status-${status}`} />
          <span>{statusLabels[status]}</span>
          <span className="topbar-divider" />
          <span className="mono">CHUNK {chunk.toString().padStart(3, "0")}</span>
        </div>
      </header>

      <section className="world-stage">
        <div className="world-backdrop" aria-hidden="true" style={{ backgroundImage: `url(${DEFAULT_WORLD_IMAGE})` }} />
        <video ref={videoRef} className={`world-video ${hasVideo ? "has-video" : ""}`} autoPlay playsInline muted />
        {frozenFrame && <img className="frozen-frame" src={frozenFrame} alt="The last frame of the world" />}
        <div className="vignette" />
        <div className="scanline" />

        {status === "idle" && (
          <div className="entry-card">
            <p className="eyebrow accent">A WORLD THAT LISTENS</p>
            <h2>Step into the unknown.</h2>
            <p>Explore an AI-generated forest in real time. Move through it, then change its weather, mood, and identity while you play.</p>
            <button className="primary-button" onClick={(event) => { event.stopPropagation(); void startSession(); }}>
              Enter the world <span>↗</span>
            </button>
            <p className="microcopy">Starts with a misty forest at dawn · 10 minute demo window</p>
          </div>
        )}

        {(status === "connecting" || status === "reshaping") && (
          <div className="loading-card">
            <span className="loader" />
            <div>
              <p className="eyebrow accent">{status === "reshaping" ? "RE-ANCHORING" : "OPENING PORTAL"}</p>
              <h2>{status === "reshaping" ? "Letting the world remember…" : "Finding a place to begin…"}</h2>
              <p>{status === "reshaping" ? "Your last view is held while the new identity takes root." : "The first frames will arrive as soon as they are ready."}</p>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="message-card error-card">
            <span className="message-icon">!</span>
            <div>
              <p className="eyebrow danger">WORLD MODEL ERROR</p>
              <h2>We lost the thread.</h2>
              <p>{error}</p>
              <div className="button-row">
                <button className="primary-button small" onClick={() => void (modelRef.current ? handleReset() : startSession())}>Retry</button>
                <button className="ghost-button small" onClick={() => { setError(""); setStatus(modelRef.current ? "ready" : "idle"); }}>Dismiss</button>
              </div>
            </div>
          </div>
        )}

        {status === "expired" && (
          <div className="message-card">
            <span className="message-icon">◷</span>
            <div>
              <p className="eyebrow accent">DEMO WINDOW COMPLETE</p>
              <h2>Keep the memory?</h2>
              <p>The world is paused to protect your Reactor session budget. Resume to continue or reset to make a new beginning.</p>
              <div className="button-row">
                <button className="primary-button small" onClick={() => void togglePause()}>Resume</button>
                <button className="ghost-button small" onClick={() => void handleReset()}>Reset world</button>
              </div>
            </div>
          </div>
        )}

        {status !== "idle" && status !== "connecting" && status !== "error" && status !== "expired" && (
          <div className="stage-bottom">
            <div className="control-hint"><span className="keycap">W</span><span className="keycap">A</span><span className="keycap">S</span><span className="keycap">D</span><span>move</span><span className="arrow-hint">← ↑ ↓ →</span><span>look</span></div>
            <button className="view-button" onClick={() => setPanelOpen((open) => !open)}>
              {panelOpen ? "Close world controls" : "Open world controls"} <span>{panelOpen ? "×" : "＋"}</span>
            </button>
          </div>
        )}
      </section>

      <aside className={`control-panel ${panelOpen ? "is-open" : ""}`}>
        <div className="panel-header">
          <div>
            <p className="eyebrow accent">WORLD EDITOR</p>
            <h2>Shape the moment</h2>
          </div>
          <button className="close-button" onClick={() => setPanelOpen(false)} aria-label="Close world controls">×</button>
        </div>
        <p className="panel-intro">Describe what should change. The world will absorb it on the next beat.</p>
        <form onSubmit={handleSubmit}>
          <label className="field-label" htmlFor="world-prompt">Scene direction</label>
          <textarea id="world-prompt" value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} placeholder="Make it snow…" rows={5} />
          <div className="suggestions">
            {["make it snow", "ancient ruins", "turn into a desert"].map((suggestion) => (
              <button type="button" key={suggestion} onClick={() => setDraftPrompt((current) => `${current}. ${suggestion}.`)}>{suggestion}</button>
            ))}
          </div>
          <label className="field-label" htmlFor="world-image">Reference image</label>
          <label className="upload-zone" htmlFor="world-image">
            <span className="upload-icon">↥</span>
            <span><strong>{selectedImage?.name || activeImageName}</strong><small>{selectedImage ? "Ready to re-anchor on Apply" : "Visual identity anchor"}</small></span>
            <input id="world-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleImageChange} />
          </label>
          <button className="apply-button" type="submit" disabled={status === "connecting" || status === "reshaping" || isActionPending}>
            Apply changes <span>↗</span>
          </button>
        </form>
        <div className="action-section">
          <label className="field-label" htmlFor="player-action">Player action</label>
          <form className="action-form" onSubmit={(event) => { event.preventDefault(); void performAction(); }}>
            <input
              id="player-action"
              className="action-input"
              value={actionDraft}
              onChange={(event) => setActionDraft(event.target.value)}
              placeholder="get a battle axe"
              disabled={isActionPending}
            />
            <button
              className="action-button"
              type="submit"
              disabled={!actionDraft.trim() || isActionPending || (status !== "generating" && status !== "ready")}
            >
              {isActionPending ? "..." : "Act"}
            </button>
          </form>
          <p className="action-footnote">A one-shot event for the next beat.</p>
        </div>
        <div className="panel-divider" />
        <div className="session-row"><span>Session time</span><strong className={remainingSeconds < 60 ? "warning-text" : ""}>{formatTime(remainingSeconds)}</strong></div>
        <div className="session-row"><span>Seed</span><strong className="mono">{seedRef.current}</strong></div>
        <div className="panel-actions">
          <button className="secondary-button" disabled={!modelRef.current || status === "reshaping"} onClick={() => void togglePause()}>{status === "paused" ? "Resume" : "Pause"}</button>
          <button className="secondary-button" disabled={status === "connecting" || status === "reshaping"} onClick={() => void handleReset()}>New world</button>
        </div>
        <p className="panel-footnote">{lastAction === "still" ? "The camera is at rest." : `Current movement: ${lastAction.replaceAll("+", " · ")}`}</p>
      </aside>
      <footer className="footer-note">A real-time world model experiment <span>·</span> No saved sessions</footer>
    </main>
  );
}
