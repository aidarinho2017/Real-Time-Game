import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent } from "react";
import { HeliosModel } from "@reactor-models/helios";
import { LingbotWorld2Model } from "@reactor-models/lingbot-world-2";
import { X2Model } from "@reactor-models/x2";
import WorldStudio from "./WorldStudio";
import { appRouteFromPath, buildSharedSceneUrl, pathForAppRoute, parseSharedScene, type AppRoute, type SharedScene } from "./share-scene";
import { parseVoiceCommand } from "./voice-command";
import {
  DEFAULT_PROMPT,
  DEFAULT_SESSION_SECONDS,
  DEFAULT_WATCH_SECONDS,
  DEFAULT_WORLD_IMAGE,
  HELIOS_DOLLARS_PER_HOUR,
  MAX_IMAGE_BYTES,
  MAX_VOICE_AUDIO_BYTES,
  PROMPT_PRESETS,
  X2_DOLLARS_PER_HOUR,
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
const configuredWatchSeconds = Number(import.meta.env.VITE_MAX_WATCH_SECONDS);
const WATCH_SECONDS = Number.isFinite(configuredWatchSeconds) && configuredWatchSeconds > 0
  ? configuredWatchSeconds
  : DEFAULT_WATCH_SECONDS;

type Experience = "landing" | "studio" | "choose" | "gallery" | "gallery-preview" | "play" | "watch-setup" | "watch" | "edit-setup" | "edit";
type PromptPreset = (typeof PROMPT_PRESETS)[number];
type InitialWorld = Pick<PromptPreset, "playPrompt" | "image" | "name">;
type LaunchWorld = { prompt: string; image: File; name: string; seed: number; studioWorldId?: string };
type EditSourceType = "webcam" | "video" | "image";
type GalleryMode = "all" | "play" | "watch" | "edit";

interface GalleryWorld {
  id: string;
  mode: "play" | "watch" | "edit";
  prompt: string;
  seed: number;
  image_url: string;
  source_type: EditSourceType | null;
  keep_backlog: boolean | null;
  reference_image_url: string | null;
  created_at: string;
}

interface GalleryPage {
  items: GalleryWorld[];
  next_cursor: string | null;
}

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

async function setMovieConditioningAndWait(
  model: HeliosModel,
  conditioning: Parameters<HeliosModel["setConditioning"]>[0],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutId: number | undefined;
    let unsubscribeReady: () => void = () => {};
    let unsubscribeError: () => void = () => {};

    const cleanup = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      unsubscribeReady();
      unsubscribeError();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    unsubscribeReady = model.onConditionsReady((message) => {
      if (message.has_image && message.has_prompt) finish();
    });
    unsubscribeError = model.onCommandError((message) => {
      if (message.command === "set_conditioning") {
        finish(new Error(message.reason || "Helios could not prepare the movie scene."));
      }
    });
    timeoutId = window.setTimeout(() => {
      finish(new Error("Helios did not prepare the movie scene in time."));
    }, 15_000);

    void model.setConditioning(conditioning).catch((caught) => {
      finish(caught instanceof Error ? caught : new Error("Could not prepare the movie scene."));
    });
  });
}

async function setX2ReferenceImageAndWait(model: X2Model, image: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutId: number | undefined;
    let unsubscribeAccepted: () => void = () => {};
    let unsubscribeError: () => void = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      unsubscribeAccepted();
      unsubscribeError();
      error ? reject(error) : resolve();
    };
    unsubscribeAccepted = model.onReferenceImageAccepted(() => finish());
    unsubscribeError = model.onCommandError((message) => {
      if (message.command === "set_reference_image") finish(new Error(message.reason || "X2 could not decode the reference image."));
    });
    timeoutId = window.setTimeout(() => finish(new Error("X2 did not accept the reference image in time.")), 15_000);
    void model.setReferenceImage({ reference_image: image as never }).catch((caught) => {
      finish(caught instanceof Error ? caught : new Error("Could not set the reference image."));
    });
  });
}

async function defaultImageAsPng(): Promise<File> {
  return imageFileFromUrl(DEFAULT_WORLD_IMAGE, "default-fantasy-forest.png");
}

async function imageFileFromUrl(url: string, name: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not prepare the reference image.");
  const image = await response.blob();
  return new File([image], name, { type: image.type || "image/png" });
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

function downloadVideoFrame(video: HTMLVideoElement, experience: "play" | "watch" | "edit"): boolean {
  const frame = captureVideoFrame(video);
  if (!frame) return false;
  const link = document.createElement("a");
  link.href = frame;
  link.download = `living-world-${experience}-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
  document.body.append(link);
  link.click();
  link.remove();
  return true;
}

async function captureVideoFrameFile(video: HTMLVideoElement, filename: string): Promise<File | null> {
  const frame = captureVideoFrame(video);
  if (!frame) return null;
  const blob = await (await fetch(frame)).blob();
  return new File([blob], filename, { type: "image/jpeg" });
}

function formatDollars(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function formatGalleryDate(date: string): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(date));
}

function promptExcerpt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 90);
}

function experienceForRoute(route: AppRoute, sharedScene: SharedScene | null): Experience {
  if (route === "studio") return "studio";
  if (route === "choose") return "choose";
  if (sharedScene?.mode === "watch") return "watch-setup";
  if (sharedScene?.mode === "edit") return "edit-setup";
  return "landing";
}

function imageValidationError(image: File): string | null {
  if (!image.type.startsWith("image/")) return "Choose an image file.";
  if (image.size > MAX_IMAGE_BYTES) return "Images must be 10 MB or smaller.";
  return null;
}

export default function App() {
  const sharedScene = parseSharedScene(window.location.search);
  const initialRoute = appRouteFromPath(window.location.pathname);
  const initialPlayPrompt = sharedScene?.mode === "play" ? sharedScene.prompt : DEFAULT_PROMPT;
  const initialMoviePrompt = sharedScene?.mode === "watch" ? sharedScene.prompt : DEFAULT_PROMPT;
  const initialEditPrompt = sharedScene?.mode === "edit" ? sharedScene.prompt : "Make the video look like a hand-painted animated film.";
  const sharedPlayLaunchRef = useRef(sharedScene?.mode === "play" && initialRoute === "landing");
  const appShellRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const modelRef = useRef<LingbotModel | null>(null);
  const movieModelRef = useRef<HeliosModel | null>(null);
  const editModelRef = useRef<X2Model | null>(null);
  const activeImageRef = useRef<File | null>(null);
  const movieImageRef = useRef<File | null>(null);
  const basePromptRef = useRef(initialPlayPrompt);
  const seedRef = useRef(42);
  const sessionStartedAtRef = useRef<number | null>(null);
  const heldKeysRef = useRef(new Set<string>());
  const lastCompletedChunkRef = useRef<number | null>(null);
  const pendingActionRef = useRef<{ basePrompt: string; submittedChunk: number | null } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceCaptureActiveRef = useRef(false);
  const sessionLimitPendingRef = useRef(false);
  const sessionExpiredRef = useRef(false);
  const stageFeedbackTimerRef = useRef<number | undefined>(undefined);
  const editSourceStreamRef = useRef<MediaStream | null>(null);
  const editSourceUrlRef = useRef<string | null>(null);
  const editCanvasTimerRef = useRef<number | undefined>(undefined);
  const lastPointerSentAtRef = useRef(0);
  const studioRenderWorldIdRef = useRef<string | null>(null);
  const studioFrameSavedRef = useRef(false);

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [experience, setExperience] = useState<Experience>(() => experienceForRoute(initialRoute, sharedScene));
  const [prompt, setPrompt] = useState(initialPlayPrompt);
  const [draftPrompt, setDraftPrompt] = useState(initialPlayPrompt);
  const [moviePrompt, setMoviePrompt] = useState(initialMoviePrompt);
  const [movieImage, setMovieImage] = useState<File | null>(null);
  const [movieSetupError, setMovieSetupError] = useState("");
  const [editPrompt, setEditPrompt] = useState(initialEditPrompt);
  const [editSourceType, setEditSourceType] = useState<EditSourceType>("webcam");
  const [editSourceFile, setEditSourceFile] = useState<File | null>(null);
  const [editReferenceImage, setEditReferenceImage] = useState<File | null>(null);
  const [editKeepBacklog, setEditKeepBacklog] = useState(false);
  const [editSetupError, setEditSetupError] = useState("");
  const [activeImageName, setActiveImageName] = useState("Dawn forest seed");
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [error, setError] = useState("");
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(SESSION_SECONDS);
  const [watchRemainingSeconds, setWatchRemainingSeconds] = useState(WATCH_SECONDS);
  const [editRemainingSeconds, setEditRemainingSeconds] = useState(WATCH_SECONDS);
  const [chunk, setChunk] = useState(0);
  const [lastAction, setLastAction] = useState("still");
  const [actionDraft, setActionDraft] = useState("");
  const [isActionPending, setIsActionPending] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const [hasCapturableFrame, setHasCapturableFrame] = useState(false);
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const [stageFeedback, setStageFeedback] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceFeedback, setVoiceFeedback] = useState("");
  const [galleryMode, setGalleryMode] = useState<GalleryMode>("all");
  const [galleryWorlds, setGalleryWorlds] = useState<GalleryWorld[]>([]);
  const [galleryNextCursor, setGalleryNextCursor] = useState<string | null>(null);
  const [galleryStatus, setGalleryStatus] = useState<"idle" | "loading" | "error">("idle");
  const [galleryError, setGalleryError] = useState("");
  const [selectedGalleryWorld, setSelectedGalleryWorld] = useState<GalleryWorld | null>(null);
  const [isSavingWorld, setIsSavingWorld] = useState(false);

  const setModelStatus = useCallback((nextStatus: SessionStatus) => {
    setStatus(nextStatus);
    if (nextStatus !== "error") setError("");
  }, []);

  const navigate = useCallback((route: AppRoute) => {
    const path = pathForAppRoute(route);
    if (window.location.pathname !== path || window.location.search || window.location.hash) {
      window.history.pushState(null, "", path);
    }
    setExperience(experienceForRoute(route, null));
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setExperience(experienceForRoute(appRouteFromPath(window.location.pathname), parseSharedScene(window.location.search)));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
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
      setHasCapturableFrame(false);
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
      sessionLimitPendingRef.current = false;
      sessionExpiredRef.current = false;
      setFrozenFrame(null);
      setStatus("generating");
    });
    model.onGenerationPaused(() => setStatus(sessionExpiredRef.current ? "expired" : "paused"));
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

  const attachMovieListeners = useCallback((model: HeliosModel) => {
    model.onMainVideo((_track, stream) => {
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      setHasVideo(true);
      setHasCapturableFrame(false);
      void videoRef.current.play().catch(() => undefined);
    });
    model.onState((state) => {
      setChunk(state.current_chunk);
      if (state.running) setStatus("generating");
      else if (state.paused) setStatus("paused");
      else if (state.started) setStatus("ready");
    });
    model.onCommandError((message) => {
      setError(message.reason || `Helios rejected ${message.command || "that command"}.`);
      setStatus("error");
    });
    model.onGenerationStarted(() => {
      sessionStartedAtRef.current = Date.now();
      sessionLimitPendingRef.current = false;
      sessionExpiredRef.current = false;
      setFrozenFrame(null);
      setStatus("generating");
    });
    model.onGenerationPaused(() => setStatus(sessionExpiredRef.current ? "expired" : "paused"));
    model.onGenerationResumed(() => setStatus("generating"));
    model.onChunkComplete((message) => setChunk(message.chunk_index));
  }, []);

  const attachEditListeners = useCallback((model: X2Model) => {
    model.onMainVideo((_track, stream) => {
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      setHasVideo(true);
      setHasCapturableFrame(false);
      void videoRef.current.play().catch(() => undefined);
    });
    model.onStateUpdate((state) => {
      if (state.generating) setStatus("generating");
      else setStatus((current) => current === "connecting" ? "ready" : current);
      setEditKeepBacklog(state.keep_backlog);
    });
    model.onCommandError((message) => {
      setError(message.reason || `X2 rejected ${message.command || "that command"}.`);
      setStatus("error");
    });
    model.onGenerationStarted(() => {
      if (!sessionStartedAtRef.current) sessionStartedAtRef.current = Date.now();
      sessionLimitPendingRef.current = false;
      sessionExpiredRef.current = false;
      setFrozenFrame(null);
      setStatus("generating");
    });
    model.onGenerationStopped(() => {
      setStatus(sessionExpiredRef.current ? "expired" : "ready");
    });
  }, []);

  const getToken = useCallback(async (): Promise<string> => {
    const response = await fetch("/api/reactor/token", { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || "Could not authenticate with Reactor.");
    if (!payload.jwt) throw new Error("Reactor did not return a session token.");
    return payload.jwt as string;
  }, []);

  const stopEditSource = useCallback(() => {
    if (editCanvasTimerRef.current !== undefined) window.clearInterval(editCanvasTimerRef.current);
    editCanvasTimerRef.current = undefined;
    editSourceStreamRef.current?.getTracks().forEach((track) => track.stop());
    editSourceStreamRef.current = null;
    if (sourceVideoRef.current) {
      sourceVideoRef.current.pause();
      sourceVideoRef.current.removeAttribute("src");
      sourceVideoRef.current.load();
    }
    if (editSourceUrlRef.current) URL.revokeObjectURL(editSourceUrlRef.current);
    editSourceUrlRef.current = null;
  }, []);

  const publishEditSource = useCallback(async (model: X2Model) => {
    stopEditSource();
    if (editSourceType === "webcam") {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("Could not access a camera video track.");
      track.contentHint = "detail";
      editSourceStreamRef.current = stream;
      await model.publishSource(track);
      return;
    }
    if (!editSourceFile) throw new Error(`Choose a ${editSourceType === "video" ? "video" : "still image"} first.`);
    if (editSourceType === "video") {
      const sourceVideo = sourceVideoRef.current;
      if (!sourceVideo) throw new Error("The video source is unavailable.");
      const sourceUrl = URL.createObjectURL(editSourceFile);
      editSourceUrlRef.current = sourceUrl;
      sourceVideo.src = sourceUrl;
      await sourceVideo.play();
      const capture = (sourceVideo as HTMLVideoElement & { captureStream?: () => MediaStream; webkitCaptureStream?: () => MediaStream }).captureStream
        || (sourceVideo as HTMLVideoElement & { webkitCaptureStream?: () => MediaStream }).webkitCaptureStream;
      const stream = capture?.call(sourceVideo);
      const track = stream?.getVideoTracks()[0];
      if (!stream || !track) throw new Error("Video streaming is not supported in this browser.");
      editSourceStreamRef.current = stream;
      await model.publishSource(track);
      return;
    }
    const sourceUrl = URL.createObjectURL(editSourceFile);
    editSourceUrlRef.current = sourceUrl;
    const image = new Image();
    image.src = sourceUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not read the still image."));
    });
    const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(2, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas video sources are not supported in this browser.");
    const draw = () => context.drawImage(image, 0, 0, canvas.width, canvas.height);
    draw();
    const stream = canvas.captureStream(24);
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("Could not create a video source from this image.");
    editCanvasTimerRef.current = window.setInterval(draw, 1000 / 24);
    editSourceStreamRef.current = stream;
    await model.publishSource(track);
  }, [editSourceFile, editSourceType, stopEditSource]);

  const startSession = useCallback(async (initialWorld?: InitialWorld | LaunchWorld) => {
    try {
      studioRenderWorldIdRef.current = initialWorld && "studioWorldId" in initialWorld ? initialWorld.studioWorldId || null : null;
      studioFrameSavedRef.current = false;
      setModelStatus("connecting");
      const jwt = await getToken();
      const model = normalizeModel(new LingbotWorld2Model());
      modelRef.current = model;
      attachModelListeners(model);
      await model.connect(jwt);

      const image = initialWorld
        ? initialWorld.image instanceof File
          ? initialWorld.image
          : await imageFileFromUrl(initialWorld.image, `${initialWorld.name.toLowerCase().replaceAll(" ", "-")}.png`)
        : activeImageRef.current || await defaultImageAsPng();
      activeImageRef.current = image;
      if (initialWorld) setActiveImageName(initialWorld.name);
      if (!activeImageRef.current) throw new Error("No reference image is ready.");

      if (initialWorld && "seed" in initialWorld) seedRef.current = initialWorld.seed;
      await model.setSeed({ seed: seedRef.current });
      const fileRef = await model.uploadFile(image);
      await setImageAndWaitForAcceptance(model, fileRef);
      await model.setPrompt({ prompt: initialWorld ? ("playPrompt" in initialWorld ? initialWorld.playPrompt : initialWorld.prompt) : prompt });
      await model.start();
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not start the world.");
    }
  }, [attachModelListeners, getToken, modelRef, prompt, setModelStatus]);

  const startMovie = useCallback(async (initialWorld?: LaunchWorld) => {
    try {
      setModelStatus("connecting");
      const jwt = await getToken();
      const model = new HeliosModel();
      movieModelRef.current = model;
      attachMovieListeners(model);
      await model.connect(jwt);

      const image = initialWorld?.image || movieImageRef.current || await defaultImageAsPng();
      movieImageRef.current = image;
      const fileRef = await model.uploadFile(image);
      if (initialWorld) seedRef.current = initialWorld.seed;
      await model.setSeed({ seed: seedRef.current });
      await setMovieConditioningAndWait(model, { image: fileRef, prompt: initialWorld?.prompt || moviePrompt.trim() });
      await model.start();
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not start the movie.");
    }
  }, [attachMovieListeners, getToken, moviePrompt, setModelStatus]);

  const startEdit = useCallback(async () => {
    if (!editPrompt.trim()) {
      setEditSetupError("Describe the edit first.");
      return;
    }
    if (editSourceType !== "webcam" && !editSourceFile) {
      setEditSetupError(`Choose a ${editSourceType === "video" ? "video" : "still image"} first.`);
      return;
    }
    let model: X2Model | null = null;
    try {
      setEditSetupError("");
      setModelStatus("connecting");
      const jwt = await getToken();
      model = new X2Model();
      editModelRef.current = model;
      attachEditListeners(model);
      await model.connect(jwt);
      await publishEditSource(model);
      await model.setKeepBacklog({ keep_backlog: editKeepBacklog });
      if (editReferenceImage) {
        const fileRef = await model.uploadFile(editReferenceImage);
        await setX2ReferenceImageAndWait(model, fileRef);
      }
      await model.setPrompt({ prompt: editPrompt.trim() });
    } catch (caught) {
      stopEditSource();
      void model?.disconnect().catch(() => undefined);
      editModelRef.current = null;
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not start the X2 edit.");
    }
  }, [attachEditListeners, editKeepBacklog, editPrompt, editReferenceImage, editSourceFile, editSourceType, getToken, publishEditSource, setModelStatus, stopEditSource]);

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

  const applySceneDirection = useCallback(async (sceneDirection: string) => {
    if (!sceneDirection.trim()) {
      setError("Give the world a short description before applying changes.");
      setStatus("error");
      return;
    }
    const nextPrompt = sceneDirection.trim();
    basePromptRef.current = nextPrompt;
    setPrompt(nextPrompt);
    setDraftPrompt(nextPrompt);
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
  }, [modelRef, restartWithImage, selectedImage]);

  const applyChanges = useCallback(async () => {
    await applySceneDirection(draftPrompt);
  }, [applySceneDirection, draftPrompt]);

  const sendPlayerAction = useCallback(async (rawAction: string) => {
    const model = modelRef.current;
    const action = rawAction.trim();
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
  }, [isActionPending]);

  const performAction = useCallback(async () => {
    const action = actionDraft.trim();
    if (!action) return;
    setActionDraft("");
    await sendPlayerAction(action);
  }, [actionDraft, sendPlayerAction]);

  const releaseMicrophone = useCallback(() => {
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current = null;
  }, []);

  const transcribeVoice = useCallback(async (recording: Blob) => {
    if (!recording.size) {
      setVoiceStatus("idle");
      setVoiceFeedback("No audio was captured. Hold the button while you speak.");
      return;
    }
    if (recording.size > MAX_VOICE_AUDIO_BYTES) {
      setVoiceStatus("idle");
      setVoiceFeedback("Voice recordings must be 10 MB or smaller.");
      return;
    }

    setVoiceStatus("transcribing");
    setVoiceFeedback("Transcribing…");
    try {
      const response = await fetch("/api/voice/transcribe", {
        method: "POST",
        headers: { "Content-Type": recording.type || "audio/webm" },
        body: recording,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Could not transcribe the recording.");
      if (typeof payload.transcript !== "string") throw new Error("The transcription was invalid.");

      const transcript = payload.transcript.trim();
      const command = parseVoiceCommand(transcript);
      if (!command) {
        setVoiceFeedback("No speech was recognized. Try again.");
        return;
      }

      if (command.kind === "scene") {
        setVoiceFeedback(`Changing world to: “${command.value}”`);
        await applySceneDirection(command.value);
      } else {
        setVoiceFeedback(`Action: “${command.value}”`);
        await sendPlayerAction(command.value);
      }
    } catch (caught) {
      setVoiceFeedback(caught instanceof Error ? caught.message : "Could not transcribe the recording.");
    } finally {
      setVoiceStatus("idle");
    }
  }, [applySceneDirection, sendPlayerAction]);

  const startVoiceRecording = useCallback(async () => {
    if (voiceCaptureActiveRef.current || voiceStatus !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceFeedback("Voice recording is not supported in this browser.");
      return;
    }

    voiceCaptureActiveRef.current = true;
    setVoiceFeedback("");
    setVoiceStatus("recording");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!voiceCaptureActiveRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      microphoneStreamRef.current = stream;
      voiceChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) voiceChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        mediaRecorderRef.current = null;
        releaseMicrophone();
        const recording = new Blob(voiceChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        voiceChunksRef.current = [];
        void transcribeVoice(recording);
      };
      recorder.start();
    } catch (caught) {
      voiceCaptureActiveRef.current = false;
      releaseMicrophone();
      setVoiceStatus("idle");
      setVoiceFeedback(caught instanceof Error ? caught.message : "Could not access the microphone.");
    }
  }, [releaseMicrophone, transcribeVoice, voiceStatus]);

  const stopVoiceRecording = useCallback(() => {
    if (!voiceCaptureActiveRef.current) return;
    voiceCaptureActiveRef.current = false;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }
    releaseMicrophone();
    setVoiceStatus("idle");
  }, [releaseMicrophone]);

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

  const restartMovie = useCallback(async () => {
    const model = movieModelRef.current;
    if (!model) {
      await startMovie();
      return;
    }
    try {
      const frame = videoRef.current ? captureVideoFrame(videoRef.current) : null;
      setFrozenFrame(frame);
      setModelStatus("reshaping");
      const nextSeed = Math.floor(Math.random() * 2_000_000_000);
      seedRef.current = nextSeed;
      const image = movieImageRef.current || await defaultImageAsPng();
      movieImageRef.current = image;
      await model.reset();
      await model.setSeed({ seed: nextSeed });
      const fileRef = await model.uploadFile(image);
      await setMovieConditioningAndWait(model, { image: fileRef, prompt: moviePrompt.trim() });
      sessionStartedAtRef.current = null;
      setWatchRemainingSeconds(WATCH_SECONDS);
      sessionExpiredRef.current = false;
      await model.start();
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not restart the movie.");
    }
  }, [moviePrompt, setModelStatus, startMovie]);

  const applyEditPrompt = useCallback(async () => {
    const nextPrompt = editPrompt.trim();
    if (!nextPrompt) {
      setError("Describe the edit first.");
      return;
    }
    const model = editModelRef.current;
    if (!model) return;
    try {
      await model.setPrompt({ prompt: nextPrompt });
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not apply the edit prompt.");
      setStatus("error");
    }
  }, [editPrompt]);

  const applyEditReferenceImage = useCallback(async (image: File) => {
    setEditReferenceImage(image);
    const model = editModelRef.current;
    if (!model) return;
    try {
      setFrozenFrame(videoRef.current ? captureVideoFrame(videoRef.current) : null);
      setModelStatus("reshaping");
      const fileRef = await model.uploadFile(image);
      await setX2ReferenceImageAndWait(model, fileRef);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not apply the reference image.");
      setStatus("error");
    }
  }, [setModelStatus]);

  const setEditBacklog = useCallback(async (keepBacklog: boolean) => {
    setEditKeepBacklog(keepBacklog);
    const model = editModelRef.current;
    if (!model) return;
    try {
      await model.setKeepBacklog({ keep_backlog: keepBacklog });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the source buffering setting.");
      setStatus("error");
    }
  }, []);

  const resetEdit = useCallback(async () => {
    const model = editModelRef.current;
    if (!model) {
      await startEdit();
      return;
    }
    try {
      setFrozenFrame(videoRef.current ? captureVideoFrame(videoRef.current) : null);
      setModelStatus("reshaping");
      await model.reset();
      sessionStartedAtRef.current = null;
      setEditRemainingSeconds(WATCH_SECONDS);
      sessionExpiredRef.current = false;
      if (editReferenceImage) {
        const fileRef = await model.uploadFile(editReferenceImage);
        await setX2ReferenceImageAndWait(model, fileRef);
      }
      await model.setPrompt({ prompt: editPrompt.trim() });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reset the edit.");
      setStatus("error");
    }
  }, [editPrompt, editReferenceImage, setModelStatus, startEdit]);

  const togglePause = useCallback(async () => {
    const model = modelRef.current;
    if (!model) return;
    try {
      if (status === "paused" || status === "expired") {
        if (status === "expired") {
          sessionStartedAtRef.current = Date.now();
          setRemainingSeconds(SESSION_SECONDS);
          sessionLimitPendingRef.current = false;
          sessionExpiredRef.current = false;
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

  const toggleMoviePause = useCallback(async () => {
    const model = movieModelRef.current;
    if (!model) return;
    try {
      if (status === "paused" || status === "expired") {
        if (status === "expired") {
          sessionStartedAtRef.current = Date.now();
          setWatchRemainingSeconds(WATCH_SECONDS);
          sessionLimitPendingRef.current = false;
          sessionExpiredRef.current = false;
        }
        await model.resume();
      } else {
        await model.pause();
      }
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not change movie playback.");
    }
  }, [status]);

  const returnToChoice = useCallback(async () => {
    if (document.fullscreenElement === appShellRef.current) void document.exitFullscreen();
    try {
      if (experience === "play" && modelRef.current) {
        if (status === "generating") await modelRef.current.pause();
        await modelRef.current.reset();
        await modelRef.current.disconnect();
      }
      if (experience === "watch" && movieModelRef.current) {
        if (status === "generating") await movieModelRef.current.pause();
        await movieModelRef.current.reset();
        await movieModelRef.current.disconnect();
      }
      if (experience === "edit" && editModelRef.current) {
        await editModelRef.current.reset();
        await editModelRef.current.unpublishSource();
        await editModelRef.current.disconnect();
      }
    } catch {
      // The screen can still safely return to the chooser if the session is already closed.
    }
    modelRef.current = null;
    movieModelRef.current = null;
    editModelRef.current = null;
    stopEditSource();
    pendingActionRef.current = null;
    sessionStartedAtRef.current = null;
    sessionLimitPendingRef.current = false;
    sessionExpiredRef.current = false;
    setIsActionPending(false);
    setPanelOpen(false);
    navigate("landing");
    setStatus("idle");
    setError("");
    setFrozenFrame(null);
    setHasVideo(false);
    setHasCapturableFrame(false);
    setChunk(0);
    setSelectedGalleryWorld(null);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  }, [experience, navigate, status, stopEditSource]);

  const choosePlay = useCallback(() => {
    setExperience("play");
    setPanelOpen(true);
    setRemainingSeconds(SESSION_SECONDS);
    sessionStartedAtRef.current = null;
    void startSession();
  }, [startSession]);

  const chooseFeaturedWorld = useCallback((preset: PromptPreset) => {
    basePromptRef.current = preset.playPrompt;
    setPrompt(preset.playPrompt);
    setDraftPrompt(preset.playPrompt);
    setSelectedImage(null);
    setActiveImageName(preset.name);
    setExperience("play");
    setPanelOpen(true);
    setRemainingSeconds(SESSION_SECONDS);
    sessionStartedAtRef.current = null;
    void startSession(preset);
  }, [startSession]);

  const chooseWatch = useCallback(() => {
    setExperience("watch-setup");
    setPanelOpen(false);
    setMovieSetupError("");
  }, []);

  const chooseEdit = useCallback(() => {
    setExperience("edit-setup");
    setPanelOpen(false);
    setEditSetupError("");
  }, []);

  const startConfiguredMovie = useCallback(() => {
    if (!moviePrompt.trim()) {
      setMovieSetupError("Give the movie a short direction first.");
      return;
    }
    setExperience("watch");
    setWatchRemainingSeconds(WATCH_SECONDS);
    sessionStartedAtRef.current = null;
    void startMovie();
  }, [moviePrompt, startMovie]);

  const cancelMovieSetup = useCallback(() => {
    setMovieSetupError("");
    navigate("landing");
  }, [navigate]);

  const cancelEditSetup = useCallback(() => {
    setEditSetupError("");
    navigate("landing");
  }, [navigate]);

  const openGallery = useCallback(() => {
    setSelectedGalleryWorld(null);
    setExperience("gallery");
  }, []);

  const openGalleryWorld = useCallback((world: GalleryWorld) => {
    setSelectedGalleryWorld(world);
    setExperience("gallery-preview");
  }, []);

  const loadMoreGallery = useCallback(async () => {
    if (!galleryNextCursor || galleryStatus === "loading") return;
    setGalleryStatus("loading");
    try {
      const params = new URLSearchParams({ limit: "24", cursor: galleryNextCursor });
      if (galleryMode !== "all") params.set("mode", galleryMode);
      const response = await fetch(`/api/worlds?${params}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Could not load more worlds.");
      setGalleryWorlds((worlds) => [...worlds, ...(payload.items || [])]);
      setGalleryNextCursor(payload.next_cursor || null);
      setGalleryStatus("idle");
    } catch (caught) {
      setGalleryStatus("error");
      setGalleryError(caught instanceof Error ? caught.message : "Could not load more worlds.");
    }
  }, [galleryMode, galleryNextCursor, galleryStatus]);

  const launchGalleryWorld = useCallback(async () => {
    if (!selectedGalleryWorld) return;
    try {
      setGalleryError("");
      if (selectedGalleryWorld.mode === "edit") {
        const referenceImage = selectedGalleryWorld.reference_image_url
          ? await imageFileFromUrl(selectedGalleryWorld.reference_image_url, `world-${selectedGalleryWorld.id}-reference.png`)
          : null;
        setEditPrompt(selectedGalleryWorld.prompt);
        setEditSourceType(selectedGalleryWorld.source_type || "webcam");
        setEditKeepBacklog(selectedGalleryWorld.keep_backlog ?? false);
        setEditReferenceImage(referenceImage);
        setEditSourceFile(null);
        setEditSetupError("Choose a fresh source. Saved source video is never public.");
        setExperience("edit-setup");
        return;
      }
      const image = await imageFileFromUrl(selectedGalleryWorld.image_url, `world-${selectedGalleryWorld.id}.png`);
      const world: LaunchWorld = {
        prompt: selectedGalleryWorld.prompt,
        image,
        name: promptExcerpt(selectedGalleryWorld.prompt),
        seed: selectedGalleryWorld.seed,
      };
      if (selectedGalleryWorld.mode === "play") {
        basePromptRef.current = world.prompt;
        setPrompt(world.prompt);
        setDraftPrompt(world.prompt);
        setActiveImageName(world.name);
        setExperience("play");
        setPanelOpen(true);
        setRemainingSeconds(SESSION_SECONDS);
        sessionStartedAtRef.current = null;
        void startSession(world);
      } else if (selectedGalleryWorld.mode === "watch") {
        setMoviePrompt(world.prompt);
        movieImageRef.current = image;
        setMovieImage(image);
        setExperience("watch");
        setWatchRemainingSeconds(WATCH_SECONDS);
        sessionStartedAtRef.current = null;
        void startMovie(world);
      }
    } catch (caught) {
      setGalleryError(caught instanceof Error ? caught.message : "Could not prepare this saved world.");
    }
  }, [selectedGalleryWorld, startMovie, startSession]);

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
      if (experience !== "play") return;
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
  }, [experience, syncControls]);

  useEffect(() => () => {
    voiceCaptureActiveRef.current = false;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    releaseMicrophone();
  }, [releaseMicrophone]);

  useEffect(() => () => stopEditSource(), [stopEditSource]);

  useEffect(() => {
    const onFullscreenChange = () => setIsTheaterMode(document.fullscreenElement === appShellRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => () => {
    if (stageFeedbackTimerRef.current !== undefined) window.clearTimeout(stageFeedbackTimerRef.current);
  }, []);

  useEffect(() => {
    if (!sharedPlayLaunchRef.current) return;
    const timeoutId = window.setTimeout(() => {
      sharedPlayLaunchRef.current = false;
      choosePlay();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [choosePlay]);

  useEffect(() => {
    if (experience !== "gallery") return;
    const controller = new AbortController();
    const loadGallery = async () => {
      setGalleryStatus("loading");
      setGalleryError("");
      try {
        const params = new URLSearchParams({ limit: "24" });
        if (galleryMode !== "all") params.set("mode", galleryMode);
        const response = await fetch(`/api/worlds?${params}`, { signal: controller.signal });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || "Could not load the gallery.");
        setGalleryWorlds(payload.items || []);
        setGalleryNextCursor(payload.next_cursor || null);
        setGalleryStatus("idle");
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setGalleryStatus("error");
        setGalleryError(caught instanceof Error ? caught.message : "Could not load the gallery.");
      }
    };
    void loadGallery();
    return () => controller.abort();
  }, [experience, galleryMode]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if ((experience !== "play" && experience !== "watch" && experience !== "edit") || !sessionStartedAtRef.current || status === "paused" || status === "expired" || status === "idle" || sessionLimitPendingRef.current) return;
      const elapsed = Math.floor((Date.now() - sessionStartedAtRef.current) / 1000);
      const limit = experience === "play" ? SESSION_SECONDS : WATCH_SECONDS;
      const remaining = Math.max(0, limit - elapsed);
      if (experience === "watch") setWatchRemainingSeconds(remaining);
      else if (experience === "edit") setEditRemainingSeconds(remaining);
      else setRemainingSeconds(remaining);
      const model = experience === "watch" ? movieModelRef.current : experience === "edit" ? editModelRef.current : modelRef.current;
      if (remaining === 0 && model) {
        sessionLimitPendingRef.current = true;
        sessionExpiredRef.current = true;
        const stop = experience === "edit"
          ? editModelRef.current!.reset()
          : (experience === "watch" ? movieModelRef.current : modelRef.current)!.pause();
        void stop.catch(() => {
          sessionLimitPendingRef.current = false;
          sessionExpiredRef.current = false;
        });
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [experience, status]);

  const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const image = event.target.files?.[0];
    if (!image) return;
    const validationError = imageValidationError(image);
    if (validationError) {
      setError(validationError);
      setStatus("error");
      return;
    }
    setSelectedImage(image);
    setError("");
  };

  const handleMovieImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const image = event.target.files?.[0];
    if (!image) return;
    const validationError = imageValidationError(image);
    if (validationError) {
      setMovieSetupError(validationError);
      return;
    }
    movieImageRef.current = image;
    setMovieImage(image);
    setMovieSetupError("");
  };

  const handleEditSourceChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const expectedType = editSourceType === "video" ? "video/" : "image/";
    if (!file.type.startsWith(expectedType)) {
      setEditSetupError(`Choose a ${editSourceType === "video" ? "video" : "still image"} file.`);
      return;
    }
    if (editSourceType === "image" && imageValidationError(file)) {
      setEditSetupError(imageValidationError(file) || "Choose an image file.");
      return;
    }
    setEditSourceFile(file);
    setEditSetupError("");
  };

  const handleEditReferenceImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const image = event.target.files?.[0];
    if (!image) return;
    const validationError = imageValidationError(image);
    if (validationError) {
      setEditSetupError(validationError);
      return;
    }
    setEditSetupError("");
    void applyEditReferenceImage(image);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void applyChanges();
  };

  const canUseVoice = status === "generating" || status === "ready";
  const watchEstimate = formatDollars((WATCH_SECONDS / 3600) * HELIOS_DOLLARS_PER_HOUR);
  const editEstimate = formatDollars((WATCH_SECONDS / 3600) * X2_DOLLARS_PER_HOUR);
  const showStageFeedback = (message: string) => {
    setStageFeedback(message);
    if (stageFeedbackTimerRef.current !== undefined) window.clearTimeout(stageFeedbackTimerRef.current);
    stageFeedbackTimerRef.current = window.setTimeout(() => setStageFeedback(""), 2_500);
  };
  const saveWorld = async () => {
    if (isSavingWorld || (experience !== "play" && experience !== "watch" && experience !== "edit")) return;
    const mode = experience === "watch" ? "watch" : experience === "edit" ? "edit" : "play";
    const savedPrompt = (mode === "watch" ? moviePrompt : mode === "edit" ? editPrompt : prompt).trim();
    if (!savedPrompt) return;
    setIsSavingWorld(true);
    try {
      const image = mode === "edit"
        ? videoRef.current ? await captureVideoFrameFile(videoRef.current, "edited-frame.jpg") : null
        : mode === "watch"
        ? movieImageRef.current || await defaultImageAsPng()
        : activeImageRef.current || await defaultImageAsPng();
      if (!image) throw new Error("Wait for an edited frame before saving to the gallery.");
      const body = new FormData();
      body.set("mode", mode);
      body.set("prompt", savedPrompt);
      body.set("seed", String(seedRef.current));
      body.set("image", image, image.name || "reference.png");
      if (mode === "edit") {
        body.set("source_type", editSourceType);
        body.set("keep_backlog", String(editKeepBacklog));
        if (editReferenceImage) body.set("reference_image", editReferenceImage, editReferenceImage.name);
      }
      const response = await fetch("/api/worlds", { method: "POST", body });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Could not save this world.");
      showStageFeedback("Saved permanently to public gallery");
    } catch (caught) {
      showStageFeedback(caught instanceof Error ? caught.message : "Could not save this world.");
    } finally {
      setIsSavingWorld(false);
    }
  };
  const takeSnapshot = () => {
    const snapshotMode = experience === "watch" ? "watch" : experience === "edit" ? "edit" : "play";
    if (!videoRef.current || !downloadVideoFrame(videoRef.current, snapshotMode)) {
      setHasCapturableFrame(false);
      return;
    }
    showStageFeedback("Snapshot saved");
  };
  const toggleTheaterMode = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        setPanelOpen(false);
        await appShellRef.current?.requestFullscreen();
      }
    } catch {
      showStageFeedback("Fullscreen is unavailable");
    }
  };
  const shareScene = async () => {
    const mode = experience === "watch" ? "watch" : experience === "edit" ? "edit" : "play";
    const scenePrompt = (mode === "watch" ? moviePrompt : mode === "edit" ? editPrompt : prompt).trim();
    if (!scenePrompt) return;
    const url = buildSharedSceneUrl(window.location.href, { mode, prompt: scenePrompt });
    try {
      if (navigator.share) {
        await navigator.share({ title: "Living Worlds", text: "Enter this Living World", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      showStageFeedback("Link copied");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      window.prompt("Copy your scene link:", url);
    }
  };

  const sendEditPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>, active: boolean) => {
    const model = editModelRef.current;
    if (!model) return;
    const now = performance.now();
    if (active && now - lastPointerSentAtRef.current < 33) return;
    lastPointerSentAtRef.current = now;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
    void model.setPointer({ x, y, active }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "Could not steer the edit.");
      setStatus("error");
    });
  }, []);

  const saveStudioFrame = useCallback(async (video: HTMLVideoElement) => {
    const worldId = studioRenderWorldIdRef.current;
    if (!worldId || studioFrameSavedRef.current) return;
    const frame = await captureVideoFrameFile(video, "studio-render.jpg");
    if (!frame) return;
    studioFrameSavedRef.current = true;
    try {
      const body = new FormData();
      body.set("image", frame, frame.name);
      const response = await fetch(`/api/studio-worlds/${worldId}/last-render`, { method: "POST", body });
      if (!response.ok) studioFrameSavedRef.current = false;
    } catch {
      studioFrameSavedRef.current = false;
    }
  }, []);

  const handleMainVideoLoaded = useCallback((video: HTMLVideoElement) => {
    setHasCapturableFrame(Boolean(video.videoWidth && video.videoHeight));
    void saveStudioFrame(video);
  }, [saveStudioFrame]);

  const renderStudioWorld = useCallback(async (worldId: string, name: string, studioPrompt: string) => {
    try {
      const image = await defaultImageAsPng();
      basePromptRef.current = studioPrompt;
      setPrompt(studioPrompt);
      setDraftPrompt(studioPrompt);
      setSelectedImage(null);
      setActiveImageName(name);
      setExperience("play");
      setPanelOpen(true);
      setRemainingSeconds(SESSION_SECONDS);
      sessionStartedAtRef.current = null;
      void startSession({ name, prompt: studioPrompt, image, seed: 42, studioWorldId: worldId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not prepare the structured world for rendering.");
      navigate("landing");
    }
  }, [navigate, startSession]);

  if (experience === "studio") {
    return <WorldStudio onClose={() => navigate("landing")} onRender={renderStudioWorld} />;
  }

  if (experience === "landing") {
    return (
      <main ref={appShellRef} className="landing-page">
        <header className="landing-header">
          <a className="landing-brand" href="#top" aria-label="Living Worlds home">
            <span className="landing-brand-mark" aria-hidden="true" />
            <span>LIVING WORLDS</span>
          </a>
          <nav className="landing-nav" aria-label="Page sections">
            <button type="button" onClick={() => navigate("studio")}>World Studio</button>
            <a href="#capabilities">Capabilities</a>
            <a href="#builders">For builders</a>
            <a href="#use-cases">Use cases</a>
          </nav>
          <button className="landing-header-cta" type="button" onClick={() => navigate("choose")}>Get started <span>↗</span></button>
        </header>

        <section id="top" className="landing-hero">
          <div className="landing-hero-copy">
            <p className="landing-kicker">REAL-TIME AI VIDEO, MADE INTERACTIVE</p>
            <h1>Edit reality <em>with AI.</em></h1>
            <p className="landing-lede">Build experiences where video becomes editable, playable, and responsive to the people inside it.</p>
            <p className="landing-body">Living Worlds brings Reactor world, movie, and editing models into one browser-native demo—so the first frame is only the beginning.</p>
            <button className="landing-primary-cta" type="button" onClick={() => navigate("choose")}>Get started <span>→</span></button>
            <button className="landing-primary-cta landing-studio-cta" type="button" onClick={() => navigate("studio")}>Open World Studio <span>→</span></button>
            <p className="landing-trust">BUILT WITH REACTOR WORLD, MOVIE, AND EDIT MODELS</p>
          </div>

          <div className="landing-demo" aria-label="Living Worlds product preview">
            <figure className="landing-preview-frame">
              <img src={DEFAULT_WORLD_IMAGE} alt="A cinematic forest world ready to explore" />
              <span className="landing-preview-live"><i /> LIVE WORLD</span>
              <span className="landing-preview-target" aria-hidden="true" />
              <figcaption><span>▶</span><b /> 00:04 / LIVE</figcaption>
            </figure>
            <div className="landing-code-panel">
              <p>POST /v1/worlds/start</p>
              <pre>{'{\n  "mode": "play",\n  "prompt": "A world that reacts",\n  "model": "lingbot-world-2"\n}'}</pre>
              <footer><span>200&nbsp; OK</span><span>REAL-TIME</span></footer>
            </div>
          </div>
        </section>

        <section id="capabilities" className="landing-section landing-capabilities">
          <div className="landing-section-intro">
            <p className="landing-kicker">ONE MEDIUM. FOUR WAYS TO WORK.</p>
            <h2>Everything you need to make video <em>do more.</em></h2>
          </div>
          <div className="landing-capability-grid">
            <button className="landing-capability" type="button" onClick={choosePlay}><span>✦</span><h3>Generate</h3><p>Enter a new world from a prompt, image, or featured starting point.</p><small>START A WORLD ↗</small></button>
            <button className="landing-capability" type="button" onClick={chooseEdit}><span>⌁</span><h3>Edit</h3><p>Transform a webcam, video clip, or still image live with X2.</p><small>OPEN THE EDITOR ↗</small></button>
            <button className="landing-capability" type="button" onClick={choosePlay}><span>▷</span><h3>Play</h3><p>Move through a living scene, change its direction, and influence what happens next.</p><small>EXPLORE A WORLD ↗</small></button>
            <button className="landing-capability" type="button" onClick={chooseWatch}><span>◉</span><h3>Watch</h3><p>Direct a real-time movie and hold onto its most memorable frame.</p><small>START A MOVIE ↗</small></button>
          </div>
        </section>

        <section id="builders" className="landing-section landing-builder-strip">
          <p className="landing-kicker">BUILT FOR DEVELOPERS</p>
          <div className="landing-builder-grid">
            <article><span>⌘</span><h3>Simple API</h3><p>Clear model sessions and direct controls for the experience you are making.</p></article>
            <article><span>ϟ</span><h3>Fast integration</h3><p>Go from a starting image to a live generated frame in minutes.</p></article>
            <article><span>◇</span><h3>Production-minded</h3><p>Short-lived browser tokens keep provider keys on the server.</p></article>
            <article><span>□</span><h3>Flexible</h3><p>Use a single mode or combine worlds, movies, and edits into your own flow.</p></article>
          </div>
        </section>

        <section id="use-cases" className="landing-section landing-use-cases">
          <div>
            <p className="landing-kicker">WHAT CAN YOU BUILD?</p>
            <h2>Interfaces for a more <em>playable medium.</em></h2>
          </div>
          <ul>
            <li>AI video editors</li><li>Interactive storytelling</li><li>Creative tools</li><li>World model experiments</li><li>AI games</li><li>Marketing generators</li><li>Virtual production workflows</li><li>Research prototypes</li>
          </ul>
        </section>

        <section className="landing-section landing-closing">
          <div>
            <p className="landing-kicker">WHY LIVING WORLDS?</p>
            <h2>Traditional video is static.<br />Living Worlds turns it into something <em>programmable.</em></h2>
            <button className="landing-primary-cta" type="button" onClick={() => navigate("choose")}>Try the live demo <span>→</span></button>
          </div>
          <div className="landing-closing-list">
            <p><span>✓</span> Generate it.</p><p><span>✓</span> Edit it.</p><p><span>✓</span> Play it.</p><p><span>✓</span> Build on top of it.</p>
            <hr />
            <p className="landing-muted">Designed for experimentation. Prototype new interfaces, ship AI-powered products, and push interactive media further.</p>
          </div>
        </section>

        <footer className="landing-footer"><span>LIVING WORLDS</span><span>REAL-TIME AI VIDEO DEMO</span></footer>
      </main>
    );
  }

  return (
    <main ref={appShellRef} className={`app-shell ${isTheaterMode ? "is-theater" : ""}`}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /></div>
          <div>
            <p className="eyebrow">{experience === "watch" || experience === "watch-setup" ? "REACTOR / HELIOS" : experience === "edit" || experience === "edit-setup" ? "REACTOR / X2" : "REACTOR / LINGBOT WORLD 2"}</p>
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
        <video
          ref={videoRef}
          className={`world-video ${hasVideo ? "has-video" : ""}`}
          autoPlay
          playsInline
          muted
          onLoadedData={(event) => handleMainVideoLoaded(event.currentTarget)}
        />
        <video ref={sourceVideoRef} className="source-video" muted playsInline />
        {frozenFrame && <img className="frozen-frame" src={frozenFrame} alt="The last frame of the world" />}
        {experience === "edit" && status !== "error" && (
          <div
            className="edit-pointer-layer"
            onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); sendEditPointer(event, true); }}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) sendEditPointer(event, true); }}
            onPointerUp={(event) => sendEditPointer(event, false)}
            onPointerCancel={(event) => sendEditPointer(event, false)}
            onLostPointerCapture={(event) => sendEditPointer(event, false)}
            aria-label="Drag to steer the edited subject"
          />
        )}
        <div className="vignette" />
        <div className="scanline" />

        {experience === "choose" && (
          <div className="entry-card">
            <p className="eyebrow accent">CHOOSE YOUR EXPERIENCE</p>
            <h2>Enter the unknown.</h2>
            <p>Choose a featured world, direct a real-time movie, or edit your own video live.</p>
            <div className="featured-worlds" aria-label="Featured worlds">
              {PROMPT_PRESETS.map((preset) => (
                <button type="button" key={preset.name} onClick={() => chooseFeaturedWorld(preset)}>
                  <img src={preset.image} alt="" />
                  <span><strong>{preset.name}</strong><small>Play now ↗</small></span>
                </button>
              ))}
            </div>
            <div className="entry-choices">
              <button className="experience-choice play-choice" onClick={choosePlay}>
                <span className="eyebrow accent">PLAY</span>
                <strong>Start from scratch <b>↗</b></strong>
                <small>Move, explore, and direct your own scene in real time.</small>
              </button>
              <button className="experience-choice watch-choice" onClick={chooseWatch}>
                <span className="eyebrow accent">WATCH</span>
                <strong>Real-time movie <b>▶</b></strong>
                <small>Set a cinematic direction, then let Helios roll.</small>
              </button>
              <button className="experience-choice edit-choice" onClick={chooseEdit}>
                <span className="eyebrow accent">EDIT</span>
                <strong>Live video editor <b>✦</b></strong>
                <small>Transform a webcam, clip, or still image with X2.</small>
              </button>
            </div>
            <button className="ghost-button gallery-link" onClick={openGallery}>Browse public gallery</button>
            <p className="microcopy">Play: 10 minute demo window · Watch and Edit: 2 minute streams</p>
          </div>
        )}

        {experience === "gallery" && (
          <div className="entry-card gallery-card">
            <p className="eyebrow accent">PUBLIC GALLERY</p>
            <h2>Worlds worth revisiting.</h2>
            <p>Saved prompts and reference images. Launching one begins a new real-time session.</p>
            <div className="gallery-filters" aria-label="Gallery filters">
              {(["all", "play", "watch", "edit"] as GalleryMode[]).map((mode) => (
                <button key={mode} className={galleryMode === mode ? "is-active" : ""} onClick={() => setGalleryMode(mode)}>{mode}</button>
              ))}
            </div>
            {galleryStatus === "loading" && !galleryWorlds.length && <p className="gallery-message">Loading worlds…</p>}
            {galleryError && <p className="movie-setup-error" role="alert">{galleryError}</p>}
            {!galleryStatus || galleryWorlds.length > 0 ? (
              <div className="gallery-grid">
                {galleryWorlds.map((world) => (
                  <button className="gallery-world" key={world.id} onClick={() => openGalleryWorld(world)}>
                    <img src={world.image_url} alt="" />
                    <span><small>{world.mode} · {formatGalleryDate(world.created_at)}</small><strong>{promptExcerpt(world.prompt)}</strong><em>{world.mode === "edit" ? `${world.source_type || "webcam"} · ${world.keep_backlog ? "smooth" : "low latency"}` : `Seed ${world.seed}`}</em></span>
                  </button>
                ))}
              </div>
            ) : null}
            {galleryStatus === "idle" && !galleryWorlds.length && !galleryError && <p className="gallery-message">No saved worlds yet.</p>}
            {galleryNextCursor && <button className="ghost-button gallery-link" onClick={() => void loadMoreGallery()} disabled={galleryStatus === "loading"}>{galleryStatus === "loading" ? "Loading…" : "Load more"}</button>}
            <button className="ghost-button gallery-back" onClick={() => navigate("landing")}>Back</button>
          </div>
        )}

        {experience === "gallery-preview" && selectedGalleryWorld && (
          <div className="entry-card movie-setup-card gallery-preview-card">
            <p className="eyebrow accent">{selectedGalleryWorld.mode === "edit" ? "SAVED EDIT" : `SAVED ${selectedGalleryWorld.mode} WORLD`}</p>
            <img className="gallery-preview-image" src={selectedGalleryWorld.image_url} alt={selectedGalleryWorld.mode === "edit" ? "Saved edited frame" : "Saved world reference"} />
            <h2>{promptExcerpt(selectedGalleryWorld.prompt)}</h2>
            <p>{selectedGalleryWorld.prompt}</p>
            <p className="watch-budget">{selectedGalleryWorld.mode === "edit" ? `${selectedGalleryWorld.source_type || "webcam"} SOURCE · ${selectedGalleryWorld.keep_backlog ? "SMOOTH" : "LOW LATENCY"}` : `SEED ${selectedGalleryWorld.seed}`} · {formatGalleryDate(selectedGalleryWorld.created_at)}</p>
            {galleryError && <p className="movie-setup-error" role="alert">{galleryError}</p>}
            <div className="button-row movie-setup-actions">
              <button className="primary-button" onClick={() => void launchGalleryWorld()}>{selectedGalleryWorld.mode === "edit" ? "Open edit" : `Launch ${selectedGalleryWorld.mode}`} <span>↗</span></button>
              <button className="ghost-button" onClick={() => { setGalleryError(""); setExperience("gallery"); }}>Back</button>
            </div>
          </div>
        )}

        {experience === "watch-setup" && (
          <div className="entry-card movie-setup-card">
            <p className="eyebrow accent">HELIOS MOVIE SETUP</p>
            <h2>Direct the opening shot.</h2>
            <p>Your prompt directs the movie. An image is optional and anchors its opening shot.</p>
            <label className="field-label" htmlFor="movie-prompt">Movie direction</label>
            <textarea
              id="movie-prompt"
              value={moviePrompt}
              onChange={(event) => { setMoviePrompt(event.target.value); setMovieSetupError(""); }}
              placeholder="A cinematic journey through a moonlit forest…"
              rows={5}
            />
            <div className="prompt-presets" aria-label="Movie prompt presets">
              {PROMPT_PRESETS.map((preset) => (
                <button type="button" key={preset.name} onClick={() => { setMoviePrompt(preset.watchPrompt); setMovieSetupError(""); }}>
                  <img src={preset.image} alt="" />
                  <span>{preset.name}</span>
                </button>
              ))}
            </div>
            <label className="field-label movie-image-label" htmlFor="movie-image">Reference image</label>
            <label className="upload-zone" htmlFor="movie-image">
              <span className="upload-icon">↥</span>
              <span><strong>{movieImage?.name || "Default movie image"}</strong><small>{movieImage ? "Ready to anchor the opening shot" : "Optional visual anchor"}</small></span>
              <input id="movie-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleMovieImageChange} />
            </label>
            {movieSetupError && <p className="movie-setup-error" role="alert">{movieSetupError}</p>}
            <p className="watch-budget">{formatTime(WATCH_SECONDS)} session · {watchEstimate} estimated at $6/hour</p>
            <div className="button-row movie-setup-actions">
              <button className="primary-button" onClick={startConfiguredMovie} disabled={!moviePrompt.trim()}>Start real-time movie <span>▶</span></button>
              <button className="ghost-button" onClick={cancelMovieSetup}>Back</button>
            </div>
          </div>
        )}

        {experience === "edit-setup" && (
          <div className="entry-card movie-setup-card edit-setup-card">
            <p className="eyebrow accent">X2 VIDEO EDITOR</p>
            <h2>Edit what you bring.</h2>
            <p>Choose a live camera, clip, or still image. Your source stays in this browser.</p>
            <label className="field-label" htmlFor="edit-prompt">Edit instruction</label>
            <textarea id="edit-prompt" value={editPrompt} onChange={(event) => { setEditPrompt(event.target.value); setEditSetupError(""); }} placeholder="Turn the person into a clay character…" rows={4} />
            <div className="edit-source-choices" aria-label="Edit source">
              {(["webcam", "video", "image"] as EditSourceType[]).map((source) => (
                <button key={source} type="button" className={editSourceType === source ? "is-active" : ""} onClick={() => { setEditSourceType(source); setEditSourceFile(null); setEditKeepBacklog(source !== "webcam"); setEditSetupError(""); }}>
                  {source === "webcam" ? "Webcam" : source === "video" ? "Video clip" : "Still image"}
                </button>
              ))}
            </div>
            {editSourceType !== "webcam" && (
              <label className="upload-zone" htmlFor="edit-source">
                <span className="upload-icon">↥</span>
                <span><strong>{editSourceFile?.name || `Choose ${editSourceType === "video" ? "a video clip" : "a still image"}`}</strong><small>Sent only to the live X2 session</small></span>
                <input id="edit-source" type="file" accept={editSourceType === "video" ? "video/*" : "image/png,image/jpeg,image/webp,image/gif"} onChange={handleEditSourceChange} />
              </label>
            )}
            <label className="field-label movie-image-label" htmlFor="edit-reference-image">Reference image</label>
            <label className="upload-zone" htmlFor="edit-reference-image">
              <span className="upload-icon">↥</span>
              <span><strong>{editReferenceImage?.name || "No reference image"}</strong><small>Optional character or object to insert or swap</small></span>
              <input id="edit-reference-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleEditReferenceImageChange} />
            </label>
            <label className="backlog-toggle"><input type="checkbox" checked={editKeepBacklog} onChange={(event) => void setEditBacklog(event.target.checked)} /> Keep every source frame <small>Use for clips and drag animation; webcam is lower latency with this off.</small></label>
            {editSetupError && <p className="movie-setup-error" role="alert">{editSetupError}</p>}
            <p className="watch-budget">{formatTime(WATCH_SECONDS)} session · {editEstimate} estimated at $6/hour</p>
            <div className="button-row movie-setup-actions">
              <button className="primary-button" onClick={() => { setExperience("edit"); setEditRemainingSeconds(WATCH_SECONDS); sessionStartedAtRef.current = null; void startEdit(); }} disabled={!editPrompt.trim() || (editSourceType !== "webcam" && !editSourceFile)}>Start editing <span>▶</span></button>
              <button className="ghost-button" onClick={cancelEditSetup}>Back</button>
            </div>
          </div>
        )}

        {(status === "connecting" || status === "reshaping") && (
          <div className="loading-card">
            <span className="loader" />
            <div>
              <p className="eyebrow accent">{status === "reshaping" ? "RESTARTING" : "OPENING PORTAL"}</p>
              <h2>{status === "reshaping" ? "Letting the next scene begin…" : experience === "watch" ? "Rolling the first frames…" : experience === "edit" ? "Connecting the edit stream…" : "Finding a place to begin…"}</h2>
              <p>{status === "reshaping" ? "Your last view is held while a new beginning takes shape." : "The first frames will arrive as soon as they are ready."}</p>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="message-card error-card">
            <span className="message-icon">!</span>
            <div>
              <p className="eyebrow danger">{experience === "watch" ? "MOVIE MODEL ERROR" : experience === "edit" ? "X2 EDITOR ERROR" : "WORLD MODEL ERROR"}</p>
              <h2>We lost the thread.</h2>
              <p>{error}</p>
              <div className="button-row">
                <button className="primary-button small" onClick={() => void (experience === "watch" ? (movieModelRef.current ? restartMovie() : startMovie()) : experience === "edit" ? (editModelRef.current ? resetEdit() : startEdit()) : (modelRef.current ? handleReset() : startSession()))}>Retry</button>
                <button className="ghost-button small" onClick={() => { setError(""); setStatus(experience === "watch" ? (movieModelRef.current ? "ready" : "idle") : experience === "edit" ? (editModelRef.current ? "ready" : "idle") : (modelRef.current ? "ready" : "idle")); }}>Dismiss</button>
              </div>
            </div>
          </div>
        )}

        {status === "expired" && (
          <div className="message-card">
            <span className="message-icon">◷</span>
            <div>
              <p className="eyebrow accent">{experience === "watch" ? "MOVIE WINDOW COMPLETE" : experience === "edit" ? "EDIT WINDOW COMPLETE" : "DEMO WINDOW COMPLETE"}</p>
              <h2>{experience === "watch" ? "Hold this frame?" : experience === "edit" ? "Make another edit?" : "Keep the memory?"}</h2>
              <p>{experience === "watch" ? "The movie is paused after two minutes to protect your Helios budget." : experience === "edit" ? "X2 stopped after two minutes to protect your editing budget. Start again with the same private source." : "The world is paused to protect your Reactor session budget. Resume to continue or reset to make a new beginning."}</p>
              <div className="button-row">
                <button className="primary-button small" onClick={() => void (experience === "watch" ? toggleMoviePause() : experience === "edit" ? resetEdit() : togglePause())}>{experience === "edit" ? "Start again" : "Resume"}</button>
                <button className="ghost-button small" onClick={() => void (experience === "watch" ? restartMovie() : experience === "edit" ? returnToChoice() : handleReset())}>{experience === "watch" ? "Restart movie" : experience === "edit" ? "Back" : "Reset world"}</button>
                <button className="ghost-button small" onClick={() => void saveWorld()} disabled={isSavingWorld}>{isSavingWorld ? "Saving…" : "Save to gallery"}</button>
                {experience === "watch" && <button className="ghost-button small" onClick={() => void returnToChoice()}>Back</button>}
              </div>
            </div>
          </div>
        )}

        {experience === "play" && status !== "idle" && status !== "connecting" && status !== "error" && status !== "expired" && (
          <div className="stage-bottom">
            <div className="control-hint"><span className="keycap">W</span><span className="keycap">A</span><span className="keycap">S</span><span className="keycap">D</span><span>move</span><span className="arrow-hint">← ↑ ↓ →</span><span>look</span></div>
            <div className="stage-actions">
              <button className="view-button" onClick={takeSnapshot} disabled={!hasCapturableFrame}>{hasCapturableFrame ? "Snapshot" : "Waiting for video"}</button>
              <button className="view-button" onClick={() => void saveWorld()} disabled={isSavingWorld}>{isSavingWorld ? "Saving…" : "Save to gallery"}</button>
              <button className="view-button" onClick={() => void shareScene()}>Share scene</button>
              <button className="view-button" onClick={() => void toggleTheaterMode()}>{isTheaterMode ? "Exit theater" : "Theater mode"}</button>
              <button className="view-button" onClick={() => setPanelOpen((open) => !open)}>
                {panelOpen ? "Close world controls" : "Open world controls"} <span>{panelOpen ? "×" : "＋"}</span>
              </button>
            </div>
          </div>
        )}

        {experience === "watch" && status !== "idle" && status !== "connecting" && status !== "error" && status !== "expired" && (
          <div className="stage-bottom movie-stage-controls">
            <span className="movie-label">PASSIVE REAL-TIME MOVIE · {formatTime(watchRemainingSeconds)} · {watchEstimate} EST.</span>
            <div className="movie-controls">
              <button className="view-button" onClick={takeSnapshot} disabled={!hasCapturableFrame}>{hasCapturableFrame ? "Snapshot" : "Waiting for video"}</button>
              <button className="view-button" onClick={() => void saveWorld()} disabled={isSavingWorld}>{isSavingWorld ? "Saving…" : "Save to gallery"}</button>
              <button className="view-button" onClick={() => void shareScene()}>Share scene</button>
              <button className="view-button" onClick={() => void toggleTheaterMode()}>{isTheaterMode ? "Exit theater" : "Theater mode"}</button>
              <button className="view-button" onClick={() => void toggleMoviePause()}>{status === "paused" ? "Resume" : "Pause"}</button>
              <button className="view-button" onClick={() => void restartMovie()}>Restart</button>
              <button className="view-button" onClick={() => void returnToChoice()}>Back</button>
            </div>
          </div>
        )}
        {experience === "edit" && status !== "idle" && status !== "connecting" && status !== "error" && status !== "expired" && (
          <div className="stage-bottom movie-stage-controls">
            <span className="movie-label">X2 LIVE VIDEO EDIT · {formatTime(editRemainingSeconds)} · {editEstimate} EST. · DRAG OUTPUT TO STEER</span>
            <div className="movie-controls">
              <button className="view-button" onClick={takeSnapshot} disabled={!hasCapturableFrame}>{hasCapturableFrame ? "Snapshot" : "Waiting for video"}</button>
              <button className="view-button" onClick={() => void saveWorld()} disabled={isSavingWorld}>{isSavingWorld ? "Saving…" : "Save to gallery"}</button>
              <button className="view-button" onClick={() => void shareScene()}>Share edit</button>
              <button className="view-button" onClick={() => void toggleTheaterMode()}>{isTheaterMode ? "Exit theater" : "Theater mode"}</button>
              <button className="view-button" onClick={() => void resetEdit()}>Reset</button>
              <button className="view-button" onClick={() => void returnToChoice()}>Back</button>
              <button className="view-button" onClick={() => setPanelOpen((open) => !open)}>{panelOpen ? "Close controls" : "Edit controls"}</button>
            </div>
          </div>
        )}
        {stageFeedback && <p className="stage-feedback" role="status">{stageFeedback}</p>}
      </section>

      {experience === "play" && <aside className={`control-panel ${panelOpen ? "is-open" : ""}`}>
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
          <div className="prompt-presets" aria-label="Scene prompt presets">
            {PROMPT_PRESETS.map((preset) => (
              <button type="button" key={preset.name} onClick={() => setDraftPrompt(preset.playPrompt)}>
                <img src={preset.image} alt="" />
                <span>{preset.name}</span>
              </button>
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
          <div className="voice-section">
            <button
              className={`voice-button ${voiceStatus === "recording" ? "is-recording" : ""}`}
              type="button"
              disabled={!canUseVoice || isActionPending || voiceStatus === "transcribing"}
              aria-pressed={voiceStatus === "recording"}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                void startVoiceRecording();
              }}
              onPointerUp={stopVoiceRecording}
              onPointerCancel={stopVoiceRecording}
              onLostPointerCapture={stopVoiceRecording}
              onKeyDown={(event) => {
                if (!event.repeat && (event.key === " " || event.key === "Enter")) {
                  event.preventDefault();
                  void startVoiceRecording();
                }
              }}
              onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  stopVoiceRecording();
                }
              }}
            >
              {voiceStatus === "recording" ? "Release to send" : voiceStatus === "transcribing" ? "Transcribing…" : "Hold to talk"}
            </button>
            <p className="voice-command-hint">Try “find shelter” or “turn left”. Say “Change world to snowy ruins” for a new scene.</p>
            {voiceFeedback && <p className="voice-feedback" role="status">{voiceFeedback}</p>}
          </div>
        </div>
        <div className="panel-divider" />
        <div className="session-row"><span>Session time</span><strong className={remainingSeconds < 60 ? "warning-text" : ""}>{formatTime(remainingSeconds)}</strong></div>
        <div className="session-row"><span>Seed</span><strong className="mono">{seedRef.current}</strong></div>
        <div className="panel-actions">
          <button className="secondary-button" disabled={!modelRef.current || status === "reshaping"} onClick={() => void togglePause()}>{status === "paused" ? "Resume" : "Pause"}</button>
          <button className="secondary-button" disabled={status === "connecting" || status === "reshaping"} onClick={() => void handleReset()}>New world</button>
          <button className="secondary-button back-button" onClick={() => void returnToChoice()}>Back to choice</button>
        </div>
        <p className="panel-footnote">{lastAction === "still" ? "The camera is at rest." : `Current movement: ${lastAction.replaceAll("+", " · ")}`}</p>
      </aside>}
      {experience === "edit" && <aside className={`control-panel ${panelOpen ? "is-open" : ""}`}>
        <div className="panel-header">
          <div>
            <p className="eyebrow accent">X2 EDIT CONTROLS</p>
            <h2>Direct the change</h2>
          </div>
          <button className="close-button" onClick={() => setPanelOpen(false)} aria-label="Close edit controls">×</button>
        </div>
        <p className="panel-intro">Apply a new instruction at any time. Drag directly on the output to steer the edited subject.</p>
        <form onSubmit={(event) => { event.preventDefault(); void applyEditPrompt(); }}>
          <label className="field-label" htmlFor="live-edit-prompt">Edit instruction</label>
          <textarea id="live-edit-prompt" value={editPrompt} onChange={(event) => setEditPrompt(event.target.value)} placeholder="Make the subject follow the pointer…" rows={5} />
          <button className="apply-button" type="submit" disabled={!editPrompt.trim() || status === "reshaping"}>Apply edit <span>↗</span></button>
        </form>
        <div className="action-section">
          <label className="field-label" htmlFor="live-edit-reference">Reference image</label>
          <label className="upload-zone" htmlFor="live-edit-reference">
            <span className="upload-icon">↥</span>
            <span><strong>{editReferenceImage?.name || "No reference image"}</strong><small>Replacing it restarts X2 with the new subject</small></span>
            <input id="live-edit-reference" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleEditReferenceImageChange} />
          </label>
          <label className="backlog-toggle"><input type="checkbox" checked={editKeepBacklog} onChange={(event) => void setEditBacklog(event.target.checked)} /> Keep every source frame <small>Smoother motion, but growing delay.</small></label>
        </div>
        <div className="panel-divider" />
        <div className="session-row"><span>Session time</span><strong className={editRemainingSeconds < 60 ? "warning-text" : ""}>{formatTime(editRemainingSeconds)}</strong></div>
        <div className="session-row"><span>Source</span><strong className="mono">{editSourceType}</strong></div>
        <div className="panel-actions">
          <button className="secondary-button" disabled={status === "reshaping"} onClick={() => void resetEdit()}>Reset edit</button>
          <button className="secondary-button" onClick={() => void returnToChoice()}>Back to choice</button>
        </div>
        <p className="panel-footnote">Input video is sent only while this X2 session is live.</p>
      </aside>}
      <footer className="footer-note">A real-time world model experiment <span>·</span> Public recipe gallery</footer>
    </main>
  );
}
