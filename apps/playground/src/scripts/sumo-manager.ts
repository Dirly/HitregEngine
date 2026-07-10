import { Script } from "@hitreg/scripting";

/**
 * Sumo Bots game rules: knock bots off the platform to score, fall off and
 * lose a life. Win at winScore knockouts; lose at zero lives; auto-restarts.
 * Renders a minimal DOM HUD — a stopgap that documents the engine's missing
 * game-UI layer.
 */
export default class SumoManager extends Script {
  static override scriptName = "sumo-manager";
  static override params = {
    winScore: { default: 5, min: 1, max: 50 },
    lives: { default: 3, min: 1, max: 10 },
    fallY: { default: 0, description: "below this = knocked out" },
    spawnY: { default: 4.6 },
    spawnRadius: { default: 6 },
    restartAfter: { default: 5, description: "seconds after win/lose" },
  };

  private score = 0;
  private lives = 0;
  private overUntil = 0;
  private result: "win" | "lose" | null = null;
  private hud: HTMLDivElement | null = null;

  override onStart(): void {
    this.score = 0;
    this.lives = this.param<number>("lives");
    this.result = null;
    this.hud = (document.getElementById("sumo-hud") as HTMLDivElement) ?? null;
    if (!this.hud) {
      this.hud = document.createElement("div");
      this.hud.id = "sumo-hud";
      document.body.appendChild(this.hud);
    }
    this.hud.style.cssText =
      "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:800;" +
      "font:600 18px ui-monospace,monospace;color:#e6edf3;background:rgba(13,17,23,.75);" +
      "padding:8px 18px;border:1px solid #30363d;border-radius:6px;pointer-events:none;text-align:center";
    this.render();
  }

  override onDispose(): void {
    this.hud?.remove();
    this.hud = null;
  }

  private respawn(id: string): void {
    const angle = Math.random() * Math.PI * 2;
    const r = this.param<number>("spawnRadius") * (0.4 + Math.random() * 0.6);
    this.ctx.sim?.setPosition?.(id, [
      Math.cos(angle) * r,
      this.param<number>("spawnY"),
      Math.sin(angle) * r,
    ]);
  }

  private render(): void {
    if (!this.hud) return;
    if (this.result === "win") {
      this.hud.textContent = `🏆 YOU WIN — restarting…`;
    } else if (this.result === "lose") {
      this.hud.textContent = `💀 KNOCKED OUT — restarting…`;
    } else {
      this.hud.textContent = `SUMO BOTS · knockouts ${this.score}/${this.param<number>("winScore")} · lives ${"❤".repeat(this.lives)}`;
    }
  }

  override onFixedUpdate(): void {
    const t = this.ctx.now() / 1000;

    if (this.result) {
      if (t >= this.overUntil) {
        // reset round
        this.score = 0;
        this.lives = this.param<number>("lives");
        this.result = null;
        for (const id of this.ctx.findByTag("sumo-bot")) this.respawn(id);
        for (const id of this.ctx.findByTag("player")) this.respawn(id);
        this.render();
      }
      return;
    }

    const fallY = this.param<number>("fallY");

    for (const id of this.ctx.findByTag("sumo-bot")) {
      const object = this.ctx.getObject(id);
      if (object && object.position.y < fallY) {
        this.score++;
        this.ctx.playSound?.("chime.wav");
        this.respawn(id);
      }
    }

    for (const id of this.ctx.findByTag("player")) {
      const object = this.ctx.getObject(id);
      if (object && object.position.y < fallY) {
        this.lives--;
        this.ctx.playSound?.("thud.wav");
        this.respawn(id);
      }
    }

    if (this.score >= this.param<number>("winScore")) this.result = "win";
    if (this.lives <= 0) this.result = "lose";
    if (this.result) this.overUntil = t + this.param<number>("restartAfter");
    this.render();
  }
}
