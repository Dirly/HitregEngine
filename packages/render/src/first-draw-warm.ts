import type * as THREE from "three/webgpu";

/**
 * A mesh's first draw in the real scene pass can build its shader on the main thread, 60-140 ms each, and a precompile
 * does not always save it: 59 of 67 builds on a walk through a town were loaded, visible meshes that were only ever
 * off-screen. Turning the camera met them a dozen at once (a 470 ms frame). So the frame draws them ahead of the camera
 * and the real pass builds exactly the shader it needs: freely while the load screen hides it, then one mesh every few
 * frames, because most of a town streams in after the cover lifts and a lone build is a far smaller stall than a burst.
 */
export const FIRST_DRAWS_PER_FRAME = 6;
/** Once play is showing, one mesh is drawn ahead every this many frames. */
export const FIRST_DRAW_TRICKLE_FRAMES = 4;

export class FirstDrawWarm {
  private readonly drawn = new WeakSet<THREE.Object3D>();
  private readonly lent: THREE.Object3D[] = [];
  /** For probes: frames stepped and meshes lent. */
  readonly stats = { frames: 0, meshes: 0 };

  /** Did the last step find meshes still to draw? */
  get busy(): boolean {
    return this.lent.length > 0;
  }

  /** Before a frame renders: return last frame's meshes to culling and lend it the next that have not been drawn. */
  step(scene: THREE.Object3D, covered: boolean): void {
    this.returnLent();
    this.stats.frames++;
    if (covered) this.visit(scene, FIRST_DRAWS_PER_FRAME);
    else if (this.stats.frames % FIRST_DRAW_TRICKLE_FRAMES === 0) this.visit(scene, 1);
  }

  /** Put every lent mesh back. */
  returnLent(): void {
    for (const object of this.lent) object.frustumCulled = true;
    this.lent.length = 0;
  }

  private visit(object: THREE.Object3D, perFrame: number): void {
    if (!object.visible) return;
    if ((object as THREE.Mesh).isMesh && object.frustumCulled && !this.drawn.has(object)) {
      this.drawn.add(object);
      object.frustumCulled = false;
      this.lent.push(object);
      this.stats.meshes++;
    }
    for (const child of object.children) {
      if (this.lent.length >= perFrame) return;
      this.visit(child, perFrame);
    }
  }
}
