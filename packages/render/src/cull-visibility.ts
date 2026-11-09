import type { Object3D } from "three/webgpu";

// Culling owns layer masks, while authored visibility and static batching own
// `visible`. Effects and pooled lights live outside their source hierarchy, so
// they need the source root's cull verdict without changing either writer.
const hiddenRoots = new WeakSet<Object3D>();

export function setCullRootHidden(root: Object3D, hidden: boolean): void {
  if (hidden) hiddenRoots.add(root);
  else hiddenRoots.delete(root);
}

export function hierarchyVisible(object: Object3D | null): boolean {
  for (let node = object; node; node = node.parent) {
    if (!node.visible || hiddenRoots.has(node)) return false;
  }
  return true;
}
