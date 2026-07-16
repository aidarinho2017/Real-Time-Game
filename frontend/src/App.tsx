import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { HeliosModel } from "@reactor-models/helios";
import { LingbotWorld2Model } from "@reactor-models/lingbot-world-2";
import { parseVoiceCommand } from "./voice-command";
import {
  DEFAULT_PROMPT,
  DEFAULT_SESSION_SECONDS,
  DEFAULT_WATCH_SECONDS,
  DEFAULT_WORLD_IMAGE,
  MAX_IMAGE_BYTES,
  MAX_VOICE_AUDIO_BYTES,
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

type Experience = "choose" | "play" | "watch-setup" | "watch";

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

function imageValidationError(image: File): string | null {
  if (!image.type.startsWith("image/")) return "Choose an image file.";
  if (image.size > MAX_IMAGE_BYTES) return "Images must be 10 MB or smaller.";
  return null;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const modelRef = useRef<LingbotModel | null>(null);
  const movieModelRef = useRef<HeliosModel | null>(null);
  const activeImageRef = useRef<File | null>(null);
  const movieImageRef = useRef<File | null>(null);
  const basePromptRef = useRef(DEFAULT_PROMPT);
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

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [experience, setExperience] = useState<Experience>("choose");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [draftPrompt, setDraftPrompt] = useState(DEFAULT_PROMPT);
  const [moviePrompt, setMoviePrompt] = useState(DEFAULT_PROMPT);
  const [movieImage, setMovieImage] = useState<File | null>(null);
  const [movieSetupError, setMovieSetupError] = useState("");
  const [activeImageName, setActiveImageName] = useState("Dawn forest seed");
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [error, setError] = useState("");
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(SESSION_SECONDS);
  const [watchRemainingSeconds, setWatchRemainingSeconds] = useState(WATCH_SECONDS);
  const [chunk, setChunk] = useState(0);
  const [lastAction, setLastAction] = useState("still");
  const [actionDraft, setActionDraft] = useState("");
  const [isActionPending, setIsActionPending] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceFeedback, setVoiceFeedback] = useState("");

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

  const startMovie = useCallback(async () => {
    try {
      setModelStatus("connecting");
      const jwt = await getToken();
      const model = new HeliosModel();
      movieModelRef.current = model;
      attachMovieListeners(model);
      await model.connect(jwt);

      const image = movieImageRef.current || await defaultImageAsPng();
      movieImageRef.current = image;
      const fileRef = await model.uploadFile(image);
      await model.setSeed({ seed: seedRef.current });
      await setMovieConditioningAndWait(model, { image: fileRef, prompt: moviePrompt.trim() });
      await model.start();
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Could not start the movie.");
    }
  }, [attachMovieListeners, getToken, moviePrompt, setModelStatus]);

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
    const model = experience === "play" ? modelRef.current : movieModelRef.current;
    try {
      if (model && status === "generating") await model.pause();
      if (model) await model.reset();
      if (model) await model.disconnect();
    } catch {
      // The screen can still safely return to the chooser if the session is already closed.
    }
    modelRef.current = null;
    movieModelRef.current = null;
    pendingActionRef.current = null;
    sessionStartedAtRef.current = null;
    sessionLimitPendingRef.current = false;
    sessionExpiredRef.current = false;
    setIsActionPending(false);
    setPanelOpen(false);
    setExperience("choose");
    setStatus("idle");
    setError("");
    setFrozenFrame(null);
    setHasVideo(false);
    setChunk(0);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  }, [experience, status]);

  const choosePlay = useCallback(() => {
    setExperience("play");
    setPanelOpen(true);
    setRemainingSeconds(SESSION_SECONDS);
    sessionStartedAtRef.current = null;
    void startSession();
  }, [startSession]);

  const chooseWatch = useCallback(() => {
    setExperience("watch-setup");
    setPanelOpen(false);
    setMovieSetupError("");
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
    setExperience("choose");
  }, []);

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

  useEffect(() => {
    const interval = window.setInterval(() => {
      if ((experience !== "play" && experience !== "watch") || !sessionStartedAtRef.current || status === "paused" || status === "expired" || status === "idle" || sessionLimitPendingRef.current) return;
      const elapsed = Math.floor((Date.now() - sessionStartedAtRef.current) / 1000);
      const limit = experience === "watch" ? WATCH_SECONDS : SESSION_SECONDS;
      const remaining = Math.max(0, limit - elapsed);
      if (experience === "watch") setWatchRemainingSeconds(remaining);
      else setRemainingSeconds(remaining);
      const model = experience === "watch" ? movieModelRef.current : modelRef.current;
      if (remaining === 0 && model) {
        sessionLimitPendingRef.current = true;
        sessionExpiredRef.current = true;
        void model.pause().catch(() => {
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

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void applyChanges();
  };

  const canUseVoice = status === "generating" || status === "ready";

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /></div>
          <div>
            <p className="eyebrow">{experience === "watch" || experience === "watch-setup" ? "REACTOR / HELIOS" : "REACTOR / LINGBOT WORLD 2"}</p>
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

        {experience === "choose" && (
          <div className="entry-card">
            <p className="eyebrow accent">CHOOSE YOUR EXPERIENCE</p>
            <h2>Enter the unknown.</h2>
            <p>Play inside a living world, or watch a real-time AI movie unfold from the same scene.</p>
            <div className="entry-choices">
              <button className="experience-choice play-choice" onClick={choosePlay}>
                <span className="eyebrow accent">PLAY</span>
                <strong>Step into the world <b>↗</b></strong>
                <small>Move, explore, and direct the scene in real time.</small>
              </button>
              <button className="experience-choice watch-choice" onClick={chooseWatch}>
                <span className="eyebrow accent">WATCH</span>
                <strong>Real-time movie <b>▶</b></strong>
                <small>Set a cinematic direction, then let Helios roll.</small>
              </button>
            </div>
            <p className="microcopy">Play: 10 minute demo window · Watch: 2 minute Helios stream</p>
          </div>
        )}

        {experience === "watch-setup" && (
          <div className="entry-card movie-setup-card">
            <p className="eyebrow accent">HELIOS MOVIE SETUP</p>
            <h2>Direct the opening shot.</h2>
            <p>Choose a prompt and optional visual anchor before the live movie begins.</p>
            <label className="field-label" htmlFor="movie-prompt">Movie direction</label>
            <textarea
              id="movie-prompt"
              value={moviePrompt}
              onChange={(event) => { setMoviePrompt(event.target.value); setMovieSetupError(""); }}
              placeholder="A cinematic journey through a moonlit forest…"
              rows={5}
            />
            <label className="field-label movie-image-label" htmlFor="movie-image">Reference image</label>
            <label className="upload-zone" htmlFor="movie-image">
              <span className="upload-icon">↥</span>
              <span><strong>{movieImage?.name || "Default movie image"}</strong><small>{movieImage ? "Ready to anchor the opening shot" : "Optional visual anchor"}</small></span>
              <input id="movie-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleMovieImageChange} />
            </label>
            {movieSetupError && <p className="movie-setup-error" role="alert">{movieSetupError}</p>}
            <div className="button-row movie-setup-actions">
              <button className="primary-button" onClick={startConfiguredMovie} disabled={!moviePrompt.trim()}>Start real-time movie <span>▶</span></button>
              <button className="ghost-button" onClick={cancelMovieSetup}>Back</button>
            </div>
          </div>
        )}

        {(status === "connecting" || status === "reshaping") && (
          <div className="loading-card">
            <span className="loader" />
            <div>
              <p className="eyebrow accent">{status === "reshaping" ? "RESTARTING" : "OPENING PORTAL"}</p>
              <h2>{status === "reshaping" ? "Letting the next scene begin…" : experience === "watch" ? "Rolling the first frames…" : "Finding a place to begin…"}</h2>
              <p>{status === "reshaping" ? "Your last view is held while a new beginning takes shape." : "The first frames will arrive as soon as they are ready."}</p>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="message-card error-card">
            <span className="message-icon">!</span>
            <div>
              <p className="eyebrow danger">{experience === "watch" ? "MOVIE MODEL ERROR" : "WORLD MODEL ERROR"}</p>
              <h2>We lost the thread.</h2>
              <p>{error}</p>
              <div className="button-row">
                <button className="primary-button small" onClick={() => void (experience === "watch" ? (movieModelRef.current ? restartMovie() : startMovie()) : (modelRef.current ? handleReset() : startSession()))}>Retry</button>
                <button className="ghost-button small" onClick={() => { setError(""); setStatus(experience === "watch" ? (movieModelRef.current ? "ready" : "idle") : (modelRef.current ? "ready" : "idle")); }}>Dismiss</button>
              </div>
            </div>
          </div>
        )}

        {status === "expired" && (
          <div className="message-card">
            <span className="message-icon">◷</span>
            <div>
              <p className="eyebrow accent">{experience === "watch" ? "MOVIE WINDOW COMPLETE" : "DEMO WINDOW COMPLETE"}</p>
              <h2>{experience === "watch" ? "Hold this frame?" : "Keep the memory?"}</h2>
              <p>{experience === "watch" ? "The movie is paused after two minutes to protect your Helios budget." : "The world is paused to protect your Reactor session budget. Resume to continue or reset to make a new beginning."}</p>
              <div className="button-row">
                <button className="primary-button small" onClick={() => void (experience === "watch" ? toggleMoviePause() : togglePause())}>Resume</button>
                <button className="ghost-button small" onClick={() => void (experience === "watch" ? restartMovie() : handleReset())}>{experience === "watch" ? "Restart movie" : "Reset world"}</button>
                {experience === "watch" && <button className="ghost-button small" onClick={() => void returnToChoice()}>Back</button>}
              </div>
            </div>
          </div>
        )}

        {experience === "play" && status !== "idle" && status !== "connecting" && status !== "error" && status !== "expired" && (
          <div className="stage-bottom">
            <div className="control-hint"><span className="keycap">W</span><span className="keycap">A</span><span className="keycap">S</span><span className="keycap">D</span><span>move</span><span className="arrow-hint">← ↑ ↓ →</span><span>look</span></div>
            <button className="view-button" onClick={() => setPanelOpen((open) => !open)}>
              {panelOpen ? "Close world controls" : "Open world controls"} <span>{panelOpen ? "×" : "＋"}</span>
            </button>
          </div>
        )}

        {experience === "watch" && status !== "idle" && status !== "connecting" && status !== "error" && status !== "expired" && (
          <div className="stage-bottom movie-stage-controls">
            <span className="movie-label">PASSIVE REAL-TIME MOVIE · {formatTime(watchRemainingSeconds)}</span>
            <div className="movie-controls">
              <button className="view-button" onClick={() => void toggleMoviePause()}>{status === "paused" ? "Resume" : "Pause"}</button>
              <button className="view-button" onClick={() => void restartMovie()}>Restart</button>
              <button className="view-button" onClick={() => void returnToChoice()}>Back</button>
            </div>
          </div>
        )}
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
            <p className="voice-command-hint">Say an action, or “Change world to …” for a new scene.</p>
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
      <footer className="footer-note">A real-time world model experiment <span>·</span> No saved sessions</footer>
    </main>
  );
}
