import { useCallback, useEffect, useMemo, useState } from "react";

type WorldState = {
  characters: Record<string, Record<string, unknown>>;
  objects: Record<string, Record<string, unknown>>;
  locations: Record<string, Record<string, unknown>>;
  environment: Record<string, unknown>;
};

type StudioEvent = { revision: number; command: string; summary: string; created_at: string };
type StudioWorld = {
  id: string;
  name: string;
  description: string;
  initial_prompt: string;
  state: WorldState;
  current_revision: number;
  created_at: string;
  updated_at: string;
  events: StudioEvent[];
};
type StudioWorldListItem = Pick<StudioWorld, "id" | "name" | "description" | "current_revision" | "updated_at">;
type InspectableKind = "characters" | "objects" | "locations" | "environment";
type Selection = { kind: InspectableKind; name: string };

type Props = {
  onClose: () => void;
  onRender: (name: string, prompt: string) => void | Promise<void>;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...init?.headers }, ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || "The world service could not complete that request.");
  return payload as T;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default function WorldStudio({ onClose, onRender }: Props) {
  const [worlds, setWorlds] = useState<StudioWorldListItem[]>([]);
  const [world, setWorld] = useState<StudioWorld | null>(null);
  const [name, setName] = useState("Cyberpunk Tokyo");
  const [description, setDescription] = useState("A persistent neon city for connected stories and cinematic scenes.");
  const [initialPrompt, setInitialPrompt] = useState("A rainy futuristic city with neon lights.");
  const [command, setCommand] = useState("Add Alice");
  const [question, setQuestion] = useState("Where is Alice?");
  const [answer, setAnswer] = useState("");
  const [jsonDraft, setJsonDraft] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [replayState, setReplayState] = useState<WorldState | null>(null);
  const [replayRevision, setReplayRevision] = useState<number | null>(null);
  const [shot, setShot] = useState("cinematic");
  const [character, setCharacter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadWorlds = useCallback(async () => {
    try {
      setWorlds(await api<StudioWorldListItem[]>("/api/studio-worlds"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load saved worlds.");
    }
  }, []);

  const adoptWorld = useCallback((nextWorld: StudioWorld) => {
    setWorld(nextWorld);
    setJsonDraft(formatJson(nextWorld.state));
    setReplayState(null);
    setReplayRevision(null);
    setAnswer("");
    setError("");
  }, []);

  useEffect(() => { void loadWorlds(); }, [loadWorlds]);

  const selectedState = replayState || world?.state || null;
  const selectedDetails = useMemo(() => {
    if (!selection || !selectedState) return null;
    if (selection.kind === "environment") return selectedState.environment;
    return selectedState[selection.kind][selection.name] || null;
  }, [selection, selectedState]);

  const createWorld = async () => {
    setBusy(true);
    try {
      const created = await api<StudioWorld>("/api/studio-worlds", { method: "POST", body: JSON.stringify({ name, description, initial_prompt: initialPrompt }) });
      adoptWorld(created);
      await loadWorlds();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the world.");
    } finally {
      setBusy(false);
    }
  };

  const openWorld = async (worldId: string) => {
    setBusy(true);
    try {
      adoptWorld(await api<StudioWorld>(`/api/studio-worlds/${worldId}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open the world.");
    } finally {
      setBusy(false);
    }
  };

  const updateWorld = async (path: string, init: RequestInit) => {
    if (!world) return;
    setBusy(true);
    try {
      adoptWorld(await api<StudioWorld>(`/api/studio-worlds/${world.id}${path}`, init));
      await loadWorlds();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the world.");
    } finally {
      setBusy(false);
    }
  };

  const runCommand = () => void updateWorld("/commands", { method: "POST", body: JSON.stringify({ command }) });
  const undo = () => void updateWorld("/undo", { method: "POST" });
  const redo = () => void updateWorld("/redo", { method: "POST" });

  const saveJson = () => {
    try {
      const state = JSON.parse(jsonDraft);
      void updateWorld("/state", { method: "PUT", body: JSON.stringify({ state }) });
    } catch {
      setError("The world JSON is invalid.");
    }
  };

  const replay = async (revision: number) => {
    if (!world) return;
    setBusy(true);
    try {
      setReplayState(await api<WorldState>(`/api/studio-worlds/${world.id}/revisions/${revision}`));
      setReplayRevision(revision);
      setSelection(null);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not replay that revision.");
    } finally {
      setBusy(false);
    }
  };

  const runQuery = async () => {
    if (!world) return;
    setBusy(true);
    try {
      const result = await api<{ answer: string }>(`/api/studio-worlds/${world.id}/query`, { method: "POST", body: JSON.stringify({ question }) });
      setAnswer(result.answer);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not answer that question.");
    } finally {
      setBusy(false);
    }
  };

  const copyJson = async () => {
    if (!world) return;
    try {
      await navigator.clipboard.writeText(formatJson(world.state));
      setAnswer("Current world JSON copied.");
    } catch {
      setError("Could not copy JSON. Select it from the editor instead.");
    }
  };

  const requestRender = async () => {
    if (!world) return;
    setBusy(true);
    try {
      const payload = await api<{ prompt: string }>(`/api/studio-worlds/${world.id}/render-prompt`, {
        method: "POST",
        body: JSON.stringify({ shot, character: character || undefined, event_revision: shot === "event" ? replayRevision ?? world.current_revision : undefined }),
      });
      await onRender(world.name, payload.prompt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not prepare that render.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="studio-page">
      <header className="studio-header">
        <button className="studio-brand" type="button" onClick={onClose}><span aria-hidden="true">◇</span> LIVING WORLDS / STUDIO</button>
        <p>PERSISTENT WORLD STATE</p>
        <button className="studio-header-button" type="button" onClick={onClose}>Back to home</button>
      </header>

      <section className="studio-shell">
        <aside className="studio-world-list">
          <div className="studio-panel-heading"><p>WORLDS</p><button type="button" onClick={() => setWorld(null)}>+ New</button></div>
          {worlds.map((item) => <button className={world?.id === item.id ? "is-active" : ""} type="button" key={item.id} onClick={() => void openWorld(item.id)}><strong>{item.name}</strong><small>{item.current_revision} changes · {new Date(item.updated_at).toLocaleDateString()}</small></button>)}
          {!worlds.length && <p className="studio-empty">Create a world to keep its characters, objects, and events connected.</p>}
        </aside>

        {!world ? (
          <section className="studio-create-card">
            <p className="studio-kicker">WORLD CREATION</p>
            <h1>Build a world that <em>remembers.</em></h1>
            <p>Its state persists as JSON: characters, objects, locations, environment, and every change that connects them.</p>
            <label>World name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} /></label>
            <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={2000} /></label>
            <label>Initial prompt<textarea value={initialPrompt} onChange={(event) => setInitialPrompt(event.target.value)} rows={4} maxLength={2000} /></label>
            <button className="studio-primary" type="button" onClick={() => void createWorld()} disabled={busy}>Create world <span>→</span></button>
            {error && <p className="studio-error" role="alert">{error}</p>}
          </section>
        ) : (
          <section className="studio-workspace">
            <div className="studio-title-row"><div><p className="studio-kicker">WORLD #{world.id.slice(0, 8)}</p><h1>{world.name}</h1><p>{world.description || world.initial_prompt}</p></div><div className="studio-state-badge"><i /> revision {world.current_revision}</div></div>
            <div className="studio-command-bar"><input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") runCommand(); }} aria-label="World command" /><button className="studio-primary" type="button" onClick={runCommand} disabled={busy}>Apply command <span>↗</span></button></div>
            <p className="studio-hint">Try “Add Alice”, “Give Alice a red motorcycle”, “Move Alice to the bridge”, or “Make it rain”.</p>
            {error && <p className="studio-error" role="alert">{error}</p>}

            <div className="studio-content-grid">
              <aside className="studio-inspector">
                <div className="studio-panel-heading"><p>WORLD INSPECTOR</p>{replayRevision !== null && <button type="button" onClick={() => { setReplayState(null); setReplayRevision(null); }}>Exit replay</button>}</div>
                {(["characters", "objects", "locations"] as InspectableKind[]).map((kind) => <section key={kind}><h2>{kind}</h2>{Object.keys(selectedState?.[kind] || {}).map((item) => <button type="button" className={selection?.kind === kind && selection.name === item ? "is-active" : ""} onClick={() => setSelection({ kind, name: item })} key={item}>{item}</button>)}{!Object.keys(selectedState?.[kind] || {}).length && <small>None yet</small>}</section>)}
                <section><h2>environment</h2><button className={selection?.kind === "environment" ? "is-active" : ""} type="button" onClick={() => setSelection({ kind: "environment", name: "environment" })}>{String(selectedState?.environment.weather || "unspecified")}</button></section>
              </aside>

              <div className="studio-state-view">
                <div className="studio-panel-heading"><p>{replayRevision === null ? "CURRENT STATE" : `REPLAY / REVISION ${replayRevision}`}</p><button type="button" onClick={() => void copyJson()}>Copy JSON</button></div>
                {selection && selectedDetails ? <div className="studio-details"><h2>{selection.kind === "environment" ? "Environment" : selection.name}</h2><pre>{formatJson(selectedDetails)}</pre></div> : <div className="studio-state-summary"><div><span>Characters</span><strong>{Object.keys(selectedState?.characters || {}).length}</strong></div><div><span>Objects</span><strong>{Object.keys(selectedState?.objects || {}).length}</strong></div><div><span>Locations</span><strong>{Object.keys(selectedState?.locations || {}).length}</strong></div><div><span>Weather</span><strong>{String(selectedState?.environment.weather || "unspecified")}</strong></div><p>Select an item in the inspector to view its structured details.</p></div>}
                <label className="studio-json-label">Manual JSON edit<textarea value={jsonDraft} onChange={(event) => setJsonDraft(event.target.value)} rows={12} disabled={replayRevision !== null} /></label>
                <button className="studio-subtle-button" type="button" onClick={saveJson} disabled={busy || replayRevision !== null}>Save JSON state</button>
              </div>

              <aside className="studio-timeline">
                <div className="studio-panel-heading"><p>TIMELINE</p><span><button type="button" onClick={undo} disabled={busy || world.current_revision === 0}>↶</button><button type="button" onClick={redo} disabled={busy}>↷</button></span></div>
                <button className={replayRevision === 0 ? "is-active" : ""} type="button" onClick={() => void replay(0)}><small>START</small>World created</button>
                {world.events.map((event) => <button className={replayRevision === event.revision ? "is-active" : ""} type="button" key={event.revision} onClick={() => void replay(event.revision)}><small>#{event.revision} · {new Date(event.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>{event.summary}</button>)}
                {!world.events.length && <p className="studio-empty">Commands become replayable events.</p>}
              </aside>
            </div>

            <div className="studio-bottom-grid">
              <section className="studio-query"><p className="studio-kicker">WORLD QUERY</p><h2>Ask the structured world.</h2><div><input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runQuery(); }} /><button type="button" onClick={() => void runQuery()} disabled={busy}>Ask</button></div>{answer && <p className="studio-answer">{answer}</p>}</section>
              <section className="studio-render"><p className="studio-kicker">RENDER REQUEST</p><h2>Render a consistent scene.</h2><div><select value={shot} onChange={(event) => setShot(event.target.value)}><option value="current">Current world</option><option value="event">Replay selected event</option><option value="character">Character perspective</option><option value="cinematic">Cinematic shot</option><option value="drone">Drone shot</option><option value="close-up">Close-up</option></select>{shot === "character" && <input value={character} onChange={(event) => setCharacter(event.target.value)} placeholder="Character name" />}</div><button className="studio-primary" type="button" onClick={() => void requestRender()} disabled={busy || (shot === "character" && !character.trim())}>Render in Play <span>→</span></button></section>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
