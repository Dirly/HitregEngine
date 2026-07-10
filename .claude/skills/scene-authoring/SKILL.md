---
name: scene-authoring
description: Author or modify HitReg Engine scene documents, prefabs, and data assets. Use when creating/editing scenes, adding entities or components, defining prefabs with props, or building ops batches — in this repo or any project using @hitreg/core.
---

# Scene Authoring

Everything is JSON documents mutated through ops batches. Never hand-edit a
scene doc's internals; build an `Op[]` and run `applyOps(doc, ops, registry)` —
it is atomic (all-or-nothing), schema-validates every component, and returns
inverse ops for undo.

## Ops vocabulary

```
add-entity { id, entity }          remove-entity { id }        // cascades to subtree
reparent { id, parent }            rename { id, name }
set-tags { id, tags }              set-component { id, component, data }
remove-component { id, component }
```

An entity: `{ name, parent: id|null, tags: string[], components: { [type]: data } }`.
Components are validated against the `ComponentRegistry` — unknown types and
out-of-schema data reject the whole batch. Defaults are filled in for you, so
minimal data is idiomatic: `transform: {}` is a valid identity transform.

## Core components

- `transform` — `{ position: [x,y,z], rotation: quat [x,y,z,w], scale: [x,y,z] }`, all optional.
- `mesh` — `{ source: { kind: "primitive", shape: box|sphere|plane|cylinder|capsule|cone|torus, size: [x,y,z] } | { kind: "asset", assetId }, castShadow, receiveShadow, static }`.
- `light` — `{ kind: directional|point|spot|ambient, color: "#rrggbb", intensity, range, angle, castShadow }`.
- `camera` — `{ fov, near, far, active, rig?: { mode: "follow", targetTag, distance, height, damping } }` (follow rig tracks the first entity with targetTag in play mode).
- `prefab` — makes the entity a prefab instance (below).
- `rigidbody` — `{ kind: dynamic|kinematic|static, lockRotations, ccd, ... }`; `collider` — `{ shape: box|sphere|capsule|cylinder, size, offset, friction, restitution, isTrigger }` (collider without rigidbody = static). `joint` — `{ kind: fixed|hinge|slider|ball, target, anchorA, anchorB, axis, limits?, motor? }`.
- `script` — `{ name, params }`: attach registered behaviors (spinner, oscillator, player-controller, collectible, anim-cycler + project scripts in src/scripts/). Script context: setAnimation(clip, fade), playSound(id?), setActiveCamera(id), viewForward(), sim velocity APIs.
- `animator` — `{ play?: clipName, fade, speed }` for glTF asset meshes; clips crossfade Unity-style.
- `audio` — `{ src: soundAssetId, volume, loop, autoplay, positional, refDistance }` (files in assets/audio/).
- Scenes: multiple `assets/scenes/<name>.scene.json` files; the editor toolbar picks between them. Only the scene being edited live-syncs; creating a new scene file adds it to the picker.

Get the full machine-readable spec: `registry.jsonSchemas()`.

## Prefabs (React-style)

Definition = entity subtree + declared props bound by path into it:

```ts
assets.addPrefab("prefab-streetlight", {
  version: 1, name: "Streetlight", root: "pole",
  entities: { pole: {...}, lamp: { parent: "pole", ... } },
  props: { lightColor: { default: "#ffcc88", bindings: ["lamp/components/light/color"] } },
});
```

Instance = one entity with a `prefab` component:

```ts
components: {
  transform: { position: [5, 0, 0] },        // instance components replace root's, per component
  prefab: {
    prefabId: "prefab-streetlight",
    props: { lightColor: "#ff2200" },         // unknown prop names are errors
    overrides: [{ path: "lamp/components/light/intensity", value: 3 }],
  },
}
```

Rules:
- Scene docs keep instances **collapsed**; `expandScene(doc, assets, registry)`
  resolves them (children namespaced `instanceId:localId`). Never store an
  expanded scene as source.
- Definition edits (`assets.updatePrefab`) propagate to all instances on next
  expand; overrides survive.
- Prefabs nest; cycles are rejected. Prefab roots may not themselves be
  instances (variants unsupported so far).

## Data assets (ScriptableObjects)

```ts
assets.defineDataType("weapon-stats", zodSchema);
assets.addDataAsset({ id: "pistol", type: "weapon-stats", name: "Pistol", data: { damage: 10 } });
```

Reference by GUID from components/scripts. `updateDataAsset` = every referent
sees new values. Schemas for AI: `assets.dataTypeJsonSchemas()`.

## Pitfalls

- `remove-entity` deletes the whole subtree — reparent children first if not intended.
- Colors are strict `#rrggbb` strings; `rotation` is a quaternion, not Euler.
- A failing op anywhere rejects the entire batch — build large batches
  confidently, but validate prop names against the prefab's declared props.
- Working example: `apps/playground/src/street-scene.ts`; runnable pipeline
  demo: `pnpm -F @hitreg/core demo`.
