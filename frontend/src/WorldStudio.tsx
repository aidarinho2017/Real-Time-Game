import { useCallback, useEffect, useMemo, useState } from "react";

type WorldState = {
  characters: Record<string, Record<string, unknown>>;
  objects: Record<string, Record<string, unknown>>;
  locations: Record<string, Record<string, unknown>>;
  environment: Record<string, unknown>;
};

type StudioEvent = { revision: number; command: string; summary: string; created_at: string; affected_characters: string[] };
type StudioWorld = {
  id: string;
  name: string;
  description: string;
  initial_prompt: string;
  state: WorldState;
  current_revision: number;
  last_render_url: string | null;
  last_rendered_at: string | null;
  created_at: string;
  updated_at: string;
  events: StudioEvent[];
};
type StudioWorldListItem = Pick<StudioWorld, "id" | "name" | "description" | "current_revision" | "updated_at">;
type InspectableKind = "characters" | "objects" | "locations" | "environment";
type Selection = { kind: InspectableKind; name: string };

type Props = {
  onClose: () => void;
  onRender: (worldId: string, name: string, prompt: string) => void | Promise<void>;
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
  const [selectedCharacterName, setSelectedCharacterName] = useState<string | null>(null);
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
    setSelectedCharacterName((selected) => selected && nextWorld.state.characters[selected] ? selected : Object.keys(nextWorld.state.characters)[0] || null);
  }, []);

  useEffect(() => { void loadWorlds(); }, [loadWorlds]);

  const selectedState = replayState || world?.state || null;
  const selectedCharacter = selectedCharacterName ? world?.state.characters[selectedCharacterName] || null : null;
  const characterHistory = selectedCharacterName ? world?.events.filter((event) => event.affected_characters.includes(selectedCharacterName)) || [] : [];
  const characterInventory = Array.isArray(selectedCharacter?.inventory) ? selectedCharacter.inventory.map(String) : [];
  const characterRelationships = selectedCharacter?.relationships && typeof selectedCharacter.relationships === "object"
    ? Object.entries(selectedCharacter.relationships as Record<string, string>)
    : [];
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
      await onRender(world.id, world.name, payload.prompt);
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
        <p>WORLD TO PLAY</p>
        <button className="studio-header-button" type="button" onClick={onClose}>Back to home</button>
      </header>

      <section className="studio-shell">
        <aside className="studio-world-list">
          <div className="studio-panel-heading"><p>SAVED WORLDS</p><button type="button" onClick={() => setWorld(null)}>+ New</button></div>
          {worlds.map((item) => <button className={world?.id === item.id ? "is-active" : ""} type="button" key={item.id} onClick={() => void openWorld(item.id)}><strong>{item.name}</strong><small>{item.current_revision} changes · {new Date(item.updated_at).toLocaleDateString()}</small></button>)}
          {!worlds.length && <p className="studio-empty">Create a world to keep its characters, objects, and events connected.</p>}
        </aside>

        {!world ? (
          <section className="studio-create-card">
            <p className="studio-kicker">STEP 1 / WORLD FOUNDATION</p>
            <h1>Build a world ready to <em>play.</em></h1>
            <p>Name its story, describe the premise, and set the visual world. You can add characters and events next.</p>
            <label>01 / World name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} /></label>
            <label>02 / Story premise<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={2000} /></label>
            <label>03 / Visual world<textarea value={initialPrompt} onChange={(event) => setInitialPrompt(event.target.value)} rows={4} maxLength={2000} /></label>
            <button className="studio-primary" type="button" onClick={() => void createWorld()} disabled={busy}>Continue to world <span>→</span></button>
            {error && <p className="studio-error" role="alert">{error}</p>}
          </section>
        ) : (
          <section className="studio-workspace">
            <div className="studio-title-row"><div><p className="studio-kicker">STEP 2 / SHAPE THE WORLD</p><h1>{world.name}</h1><p>{world.description || world.initial_prompt}</p></div><div className="studio-state-badge"><i /> revision {world.current_revision}</div></div>
            <section className="studio-simulation" aria-label="Live world graph">
              <div className="studio-graph">
                <div className="studio-panel-heading"><p>LIVE WORLD GRAPH</p><span className="studio-live-status"><i /> updates with every change</span></div>
                <div className="studio-graph-root"><strong>World</strong><small>{world.name}</small></div>
                <div className="studio-graph-branches">
                  <section><p>Characters ({Object.keys(world.state.characters).length})</p><div>{Object.keys(world.state.characters).map((characterName) => <button className={selectedCharacterName === characterName ? "is-active" : ""} type="button" key={characterName} onClick={() => setSelectedCharacterName(characterName)}>{characterName}</button>)}{!Object.keys(world.state.characters).length && <small>None yet</small>}</div></section>
                  <section><p>Objects ({Object.keys(world.state.objects).length})</p></section>
                  <section><p>Locations ({Object.keys(world.state.locations).length})</p></section>
                  <section><p>Events ({world.events.length})</p></section>
                </div>
              </div>
              <aside className="studio-character-inspector">
                <div className="studio-panel-heading"><p>CHARACTER INSPECTOR</p>{selectedCharacter && <span>{selectedCharacterName}</span>}</div>
                {selectedCharacter ? <>
                  <div className="studio-character-facts"><div><span>Current location</span><strong>{String(selectedCharacter.location || "Not placed")}</strong></div><div><span>Emotion</span><strong>{String(selectedCharacter.emotion || "neutral")}</strong></div><div><span>Inventory</span><strong>{characterInventory.join(", ") || "Empty"}</strong></div><div><span>Relationships</span><strong>{characterRelationships.map(([name, relation]) => `${name}: ${relation}`).join(" · ") || "None yet"}</strong></div></div>
                  <section className="studio-character-history"><p className="studio-kicker">HISTORY</p>{characterHistory.length ? characterHistory.map((event) => <div key={event.revision}><small>#{event.revision} · {new Date(event.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small><span>{event.summary}</span></div>) : <p>No recorded changes yet.</p>}</section>
                  <section className="studio-character-frame"><p className="studio-kicker">LAST RENDERED FRAME</p>{world.last_render_url ? <img src={world.last_render_url} alt={`Last rendered frame of ${world.name}`} /> : <p>Render in Play to attach the first frame.</p>}</section>
                </> : <p className="studio-empty">Add a character, then select it here to inspect its simulation state.</p>}
              </aside>
            </section>
            <section className="studio-command-step">
              <p className="studio-kicker">NEXT WORLD CHANGE</p>
              <div className="studio-command-bar"><input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") runCommand(); }} aria-label="World command" /><button className="studio-primary" type="button" onClick={runCommand} disabled={busy}>Apply change <span>↗</span></button></div>
              <p className="studio-hint">Try “Add Alice”, “Give Alice a red motorcycle”, “Move Alice to the bridge”, or “Make it rain”.</p>
            </section>
            {error && <p className="studio-error" role="alert">{error}</p>}

            <div className="studio-bottom-grid">
              <section className="studio-render"><p className="studio-kicker">STEP 3 / PLAY</p><h2>Bring this world to life.</h2><p>Start a live scene from its current saved state.</p><div><select value={shot} onChange={(event) => setShot(event.target.value)} aria-label="Play scene view"><option value="current">Current world</option><option value="event">Replay selected event</option><option value="character">Character perspective</option><option value="cinematic">Cinematic shot</option><option value="drone">Drone shot</option><option value="close-up">Close-up</option></select>{shot === "character" && <input value={character} onChange={(event) => setCharacter(event.target.value)} placeholder="Character name" />}</div><button className="studio-primary" type="button" onClick={() => void requestRender()} disabled={busy || (shot === "character" && !character.trim())}>Render in Play <span>→</span></button></section>
            </div>

            <details className="studio-advanced">
              <summary>Advanced world controls <span>JSON, timeline, inspector, and queries</span></summary>
              <div className="studio-content-grid">
                <aside className="studio-inspector">
                  <div className="studio-panel-heading"><p>WORLD INSPECTOR</p>{replayRevision !== null && <button type="button" onClick={() => { setReplayState(null); setReplayRevision(null); }}>Exit replay</button>}</div>
                  {(["characters", "objects", "locations"] as InspectableKind[]).map((kind) => <section key={kind}><h2>{kind}</h2>{Object.keys(selectedState?.[kind] || {}).map((item) => <button type="button" className={selection?.kind === kind && selection.name === item ? "is-active" : ""} onClick={() => { setSelection({ kind, name: item }); if (kind === "characters") setSelectedCharacterName(item); }} key={item}>{item}</button>)}{!Object.keys(selectedState?.[kind] || {}).length && <small>None yet</small>}</section>)}
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
              <section className="studio-query"><p className="studio-kicker">WORLD QUERY</p><h2>Ask the structured world.</h2><div><input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runQuery(); }} /><button type="button" onClick={() => void runQuery()} disabled={busy}>Ask</button></div>{answer && <p className="studio-answer">{answer}</p>}</section>
            </details>
          </section>
        )}
      </section>
    </main>
  );
}
