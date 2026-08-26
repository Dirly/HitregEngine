import { useState } from "react";
import type { Pin, Pins } from "../state.js";
import { buttonStyle, useObservable } from "./common.js";

/**
 * The notes attached to the selected entity, in its inspector.
 *
 * A viewport marker is good for "what's wrong with this corner of the level"
 * but useless the moment you are working through the hierarchy — you would
 * have to find the thing in 3D to discover anyone had commented on it. Notes
 * belong wherever the object does, so they appear here too, and the hierarchy
 * flags which rows carry one.
 */
export function EntityNotes(props: {
  entityId: string;
  pins: Pins;
  onCreate: (entityId: string) => void;
  onUpdate: (id: string, patch: Partial<Pin>) => void;
  onDelete: (id: string) => void;
}) {
  const all = useObservable(props.pins);
  const mine = all.filter((pin) => pin.entityId === props.entityId);
  const open = mine.filter((pin) => !pin.resolved);

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <strong style={{ color: "#e6edf3", flex: 1 }}>
          Notes{open.length > 0 ? ` · ${open.length} open` : ""}
        </strong>
        <button
          style={buttonStyle}
          title="Attach a note to this entity and send it to an agent"
          onClick={() => props.onCreate(props.entityId)}
        >
          + note
        </button>
      </div>
      {mine.length === 0 ? (
        <div style={{ color: "#8b949e", fontSize: 10, marginTop: 2 }}>
          none — a note is how you tell an agent what to change about this
          entity, in place. "Send to AI" puts it in the agent inbox immediately.
        </div>
      ) : (
        mine.map((pin) => (
          <NoteRow
            key={pin.id}
            pin={pin}
            onUpdate={(patch) => props.onUpdate(pin.id, patch)}
            onDelete={() => props.onDelete(pin.id)}
          />
        ))
      )}
    </div>
  );
}

function NoteRow(props: {
  pin: Pin;
  onUpdate: (patch: Partial<Pin>) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(props.pin.text);
  const dirty = text !== props.pin.text;

  return (
    <div style={{ marginTop: 6, padding: 6, background: "#161b22", borderRadius: 3 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ color: "#8b949e", fontSize: 10, flex: 1 }}>
          {/* status reads as a word, never as colour alone */}
          {props.pin.resolved ? "resolved" : props.pin.sentAt ? "sent to AI" : "draft"} ·{" "}
          {props.pin.author}
        </span>
        <span
          style={{ color: "#8b949e", cursor: "pointer" }}
          title="Delete this note"
          onClick={props.onDelete}
        >
          ✕
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => dirty && props.onUpdate({ text })}
        rows={2}
        placeholder="what should change about this?"
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "#0d1117",
          border: "1px solid #30363d",
          borderRadius: 3,
          color: "#c9d1d9",
          font: "11px ui-monospace, monospace",
          resize: "vertical",
        }}
      />
      {props.pin.reply && (
        <div
          style={{
            marginTop: 4,
            padding: 5,
            background: "#0d1117",
            borderLeft: "2px solid #79c0ff",
            fontSize: 10,
            color: "#c9d1d9",
          }}
        >
          <div style={{ color: "#8b949e", marginBottom: 2 }}>agent replied</div>
          {props.pin.reply}
        </div>
      )}
      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
        {!props.pin.resolved && (
          <button
            style={{
              ...buttonStyle,
              flex: 1,
              padding: "2px 6px",
              ...(props.pin.sentAt ? {} : { borderColor: "#79c0ff", color: "#e6edf3" }),
            }}
            disabled={text.trim().length === 0}
            title={
              props.pin.sentAt
                ? `Sent ${new Date(props.pin.sentAt).toLocaleTimeString()} — press again to re-send`
                : "Put this note in the agent inbox now"
            }
            onClick={() =>
              props.onUpdate(
                dirty
                  ? { text, sentAt: new Date().toISOString() }
                  : { sentAt: new Date().toISOString() },
              )
            }
          >
            {props.pin.sentAt ? "↑ re-send" : "↑ send to AI"}
          </button>
        )}
        <button
          style={{ ...buttonStyle, padding: "2px 6px" }}
          onClick={() => props.onUpdate({ resolved: !props.pin.resolved })}
        >
          {props.pin.resolved ? "reopen" : "resolve"}
        </button>
      </div>
    </div>
  );
}
