import { Script } from "@hitreg/scripting";

/** Play-mode selector for the generated longsword atlas gallery. */
export default class AtlasCarousel extends Script {
  static override scriptName = "atlas-carousel";

  private index = 0;
  private wasNext = false;
  private wasPrevious = false;

  override onStart(): void {
    this.apply();
  }

  override onFixedUpdate(): void {
    const ids = this.ctx.findByTag("atlas-carousel-item");
    if (!ids.length) return;

    const next = this.ctx.input.isDown("ArrowRight") || this.ctx.input.isDown("KeyN");
    const previous = this.ctx.input.isDown("ArrowLeft") || this.ctx.input.isDown("KeyP");
    if (next && !this.wasNext) {
      this.index = (this.index + 1) % ids.length;
      this.apply(ids);
    } else if (previous && !this.wasPrevious) {
      this.index = (this.index - 1 + ids.length) % ids.length;
      this.apply(ids);
    }
    this.wasNext = next;
    this.wasPrevious = previous;
  }

  private apply(ids = this.ctx.findByTag("atlas-carousel-item")): void {
    for (const [i, id] of ids.entries()) {
      const object = this.ctx.getObject(id);
      if (object) object.visible = i === this.index;
    }
  }
}
