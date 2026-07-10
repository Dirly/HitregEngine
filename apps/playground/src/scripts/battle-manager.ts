import { Script } from "@hitreg/scripting";

/**
 * Robot Battle game rules: the player fights one chasing robot. Walk up and
 * press F (or E) to punch — the bot takes damage and goes flying. The bot
 * hurts you when it catches you. Knock its health to zero to win the round;
 * each round the robot gets a little faster. Owns the bot's movement too, so
 * punches can stun it (a separate chaser script would overwrite knockback
 * velocity every tick).
 */
export default class BattleManager extends Script {
  static override scriptName = "battle-manager";
  static override params = {
    maxHp: { default: 100, min: 10, max: 1000 },
    punchDamage: { default: 25, min: 1, max: 100 },
    punchRange: { default: 2.8, min: 1, max: 10, description: "how close to land a punch" },
    punchKnockback: { default: 10, min: 0, max: 40 },
    punchCooldown: { default: 0.5, min: 0.1, max: 5 },
    botTag: { default: "battle-bot" },
    botSpeed: { default: 3.2, min: 0, max: 20 },
    botSpeedPerRound: { default: 0.6, min: 0, max: 5, description: "speed gained each round" },
    botDamage: { default: 10, min: 0, max: 100 },
    botAttackRange: { default: 1.9, min: 0.5, max: 10 },
    botAttackCooldown: { default: 1.2, min: 0.1, max: 10 },
    stunSeconds: { default: 0.7, min: 0, max: 5, description: "bot downtime after a punch" },
    restartAfter: { default: 4, min: 1, max: 30, description: "seconds after win/lose" },
  };

  private playerHp = 0;
  private botHp = 0;
  private round = 1;
  private punchReadyAt = 0;
  private botHitReadyAt = 0;
  private stunUntil = 0;
  private result: "win" | "lose" | null = null;
  private overUntil = 0;
  private message = "";
  private messageUntil = 0;
  private hud: HTMLDivElement | null = null;

  override onStart(): void {
    this.playerHp = this.param<number>("maxHp");
    this.botHp = this.param<number>("maxHp");
    this.round = 1;
    this.result = null;
    this.hud = (document.getElementById("battle-hud") as HTMLDivElement) ?? null;
    if (!this.hud) {
      this.hud = document.createElement("div");
      this.hud.id = "battle-hud";
      document.body.appendChild(this.hud);
    }
    this.hud.style.cssText =
      "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:800;width:420px;" +
      "font:700 15px ui-monospace,monospace;color:#e6edf3;background:rgba(13,17,23,.8);" +
      "padding:10px 16px;border:1px solid #30363d;border-radius:10px;pointer-events:none;text-align:center";
    this.render();
  }

  override onDispose(): void {
    this.hud?.remove();
    this.hud = null;
  }

  private bar(label: string, hp: number, color: string): string {
    const pct = Math.max(0, Math.round((hp / this.param<number>("maxHp")) * 100));
    return (
      `<div style="display:flex;align-items:center;gap:8px;margin:3px 0">` +
      `<span style="width:70px;text-align:left">${label}</span>` +
      `<div style="flex:1;height:12px;background:#21262d;border-radius:6px;overflow:hidden">` +
      `<div style="width:${pct}%;height:100%;background:${color};border-radius:6px"></div></div>` +
      `<span style="width:36px;text-align:right">${Math.max(0, hp)}</span></div>`
    );
  }

  private render(): void {
    if (!this.hud) return;
    const t = this.ctx.now() / 1000;
    let banner = `ROBOT BATTLE · round ${this.round}`;
    if (this.result === "win") banner = "🏆 YOU WIN! Next round…";
    else if (this.result === "lose") banner = "💀 THE ROBOT GOT YOU — restarting…";
    else if (t < this.messageUntil) banner = this.message;
    this.hud.innerHTML =
      `<div style="font-size:17px;margin-bottom:4px">${banner}</div>` +
      this.bar("😀 YOU", this.playerHp, "#3fb950") +
      this.bar("🤖 BOT", this.botHp, "#f85149") +
      `<div style="font-size:11px;font-weight:500;color:#8b949e;margin-top:4px">WASD move · SPACE jump · F punch</div>`;
  }

  private respawnAll(): void {
    const sim = this.ctx.sim;
    for (const id of this.ctx.findByTag("player")) sim?.setPosition?.(id, [0, 1.2, 6]);
    for (const id of this.ctx.findByTag(this.param<string>("botTag"))) {
      sim?.setPosition?.(id, [0, 0.6, -6]);
      const obj = this.ctx.getObject(id);
      if (obj) obj.visible = true;
    }
  }

  override onFixedUpdate(): void {
    const sim = this.ctx.sim;
    if (!sim) return;
    const t = this.ctx.now() / 1000;

    const playerId = this.ctx.findByTag("player")[0];
    const botId = this.ctx.findByTag(this.param<string>("botTag"))[0];
    if (!playerId || !botId) return;
    const player = this.ctx.getObject(playerId);
    const bot = this.ctx.getObject(botId);
    if (!player || !bot) return;

    if (this.result) {
      if (t >= this.overUntil) {
        this.round = this.result === "win" ? this.round + 1 : 1;
        this.playerHp = this.param<number>("maxHp");
        this.botHp = this.param<number>("maxHp");
        this.result = null;
        this.respawnAll();
      }
      this.render();
      return;
    }

    // safety net: fell out of the world
    if (player.position.y < -5) sim.setPosition?.(playerId, [0, 1.2, 6]);
    if (bot.position.y < -5) sim.setPosition?.(botId, [0, 0.6, -6]);

    const dx = player.position.x - bot.position.x;
    const dz = player.position.z - bot.position.z;
    const dist = Math.hypot(dx, dz);

    // the hero always squares up to the robot (body rotations are locked;
    // the visual is ours to steer)
    player.rotation.set(0, Math.atan2(-dx, -dz), 0);

    // bot brain: chase the player unless stunned from a punch
    if (t >= this.stunUntil) {
      const speed =
        this.param<number>("botSpeed") + (this.round - 1) * this.param<number>("botSpeedPerRound");
      const vel = sim.getLinvel(botId);
      if (vel && dist > 0.01) {
        sim.setLinvel(botId, [(dx / dist) * speed, vel[1], (dz / dist) * speed]);
        bot.rotation.set(0, Math.atan2(dx, dz), 0);
      }
    }

    // bot lands a hit
    if (dist < this.param<number>("botAttackRange") && t >= this.botHitReadyAt) {
      this.botHitReadyAt = t + this.param<number>("botAttackCooldown");
      this.playerHp -= this.param<number>("botDamage");
      this.message = "🤖 OUCH!";
      this.messageUntil = t + 0.7;
      this.ctx.playSound?.("thud.wav");
    }

    // player punch
    const input = this.ctx.input;
    if ((input.isDown("KeyF") || input.isDown("KeyE")) && t >= this.punchReadyAt) {
      this.punchReadyAt = t + this.param<number>("punchCooldown");
      if (dist < this.param<number>("punchRange")) {
        this.botHp -= this.param<number>("punchDamage");
        this.stunUntil = t + this.param<number>("stunSeconds");
        const kb = this.param<number>("punchKnockback");
        const nx = dist > 0.01 ? -dx / dist : 0;
        const nz = dist > 0.01 ? -dz / dist : 1;
        sim.setLinvel(botId, [nx * kb, 5, nz * kb]);
        this.message = "💥 POW!";
        this.messageUntil = t + 0.7;
        this.ctx.playSound?.("thud.wav");
      }
    }

    if (this.botHp <= 0) {
      this.result = "win";
      bot.visible = false;
      this.ctx.playSound?.("chime.wav");
    } else if (this.playerHp <= 0) {
      this.result = "lose";
    }
    if (this.result) this.overUntil = t + this.param<number>("restartAfter");

    this.render();
  }
}
