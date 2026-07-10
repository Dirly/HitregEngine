import * as THREE from "three/webgpu";
import { Script } from "@hitreg/scripting";

/**
 * Robot Survivors game rules — a tiny Vampire-Survivors-alike:
 *
 * - Bots attack in WAVES. Clear a wave, catch your breath, a bigger and
 *   stronger wave arrives. Bots come from a pre-placed pool of entities
 *   parked underground (scenes can't add entities at runtime), teleported
 *   in to "spawn" and parked again on death.
 * - Punching bots earns XP; each level-up pauses the fight and offers a
 *   choice of three upgrades (keys 1/2/3 or click).
 * - Juice: particle bursts on hits, emissive damage blinks, a red hurt
 *   vignette, knockback + stun, sounds.
 *
 * Owns bot movement so punches can stun (a separate chaser script would
 * overwrite knockback velocity every tick). Talks to the player's
 * third-person-controller through object.userData (speedMult, frozen).
 */

interface BotState {
  active: boolean;
  hp: number;
  maxHp: number;
  damage: number;
  speed: number;
  nextHitAt: number;
  stunUntil: number;
}

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

interface Upgrade {
  emoji: string;
  name: string;
  desc: string;
  once?: boolean;
  apply: () => void;
}

const BLINK_RED = 0xff2222;
const BLINK_WHITE = 0xffffff;

export default class SurvivorsManager extends Script {
  static override scriptName = "survivors-manager";
  static override params = {
    maxHp: { default: 100, min: 10, max: 1000 },
    punchDamage: { default: 20, min: 1, max: 200 },
    punchRange: { default: 3, min: 1, max: 12 },
    punchKnockback: { default: 10, min: 0, max: 40 },
    punchCooldown: { default: 0.55, min: 0.1, max: 5 },
    stunSeconds: { default: 0.6, min: 0, max: 5 },
    botTag: { default: "bot" },
    botBaseHp: { default: 25, min: 1, max: 500 },
    botHpPerWave: { default: 12, min: 0, max: 200 },
    botBaseSpeed: { default: 2.8, min: 0, max: 15 },
    botSpeedPerWave: { default: 0.25, min: 0, max: 3 },
    botMaxSpeed: { default: 6.5, min: 1, max: 20 },
    botBaseDamage: { default: 8, min: 0, max: 100 },
    botDamagePerWave: { default: 2, min: 0, max: 50 },
    botAttackRange: { default: 1.9, min: 0.5, max: 10 },
    botAttackCooldown: { default: 1.1, min: 0.1, max: 10 },
    firstWaveBots: { default: 3, min: 1, max: 10 },
    botsPerWave: { default: 1, min: 0, max: 5, description: "extra bots each wave" },
    spawnRadius: { default: 12.5, min: 5, max: 19 },
    breatherSeconds: { default: 4, min: 0, max: 30, description: "pause between waves" },
    xpPerKill: { default: 10, min: 1, max: 100 },
    restartAfter: { default: 6, min: 1, max: 30 },
  };

  // player progression
  private playerHp = 0;
  private playerMaxHp = 0;
  private level = 1;
  private xp = 0;
  private xpNeeded = 25;
  private kills = 0;
  private elapsed = 0;
  private punchDamage = 0;
  private punchRange = 0;
  private punchKnockback = 0;
  private punchCooldown = 0;
  private critChance = 0;
  private regen = 0;
  private shockwave = false;
  private takenOnce = new Set<string>();

  // waves
  private wave = 0;
  private toSpawn = 0;
  private spawnAt = 0;
  private breatherUntil = 0;

  // moment-to-moment
  private punchReadyAt = 0;
  private result: "over" | null = null;
  private overUntil = 0;
  private message = "";
  private messageUntil = 0;
  private bots = new Map<string, BotState>();

  // upgrade menu
  private menuOpen = false;
  private choices: Upgrade[] = [];
  private pendingChoice = -1;

  // juice
  private particles: Particle[] = [];
  private blinks: Array<{ obj: THREE.Object3D; until: number }> = [];
  private fx: THREE.Group | null = null;
  private particleGeo: THREE.SphereGeometry | null = null;
  private hurtFlashUntil = 0;
  private levelFlashUntil = 0;

  // dom
  private hud: HTMLDivElement | null = null;
  private vignette: HTMLDivElement | null = null;
  private levelFlash: HTMLDivElement | null = null;
  private menu: HTMLDivElement | null = null;

  // ---------------------------------------------------------------- setup

  override onStart(): void {
    this.playerMaxHp = this.param<number>("maxHp");
    this.punchDamage = this.param<number>("punchDamage");
    this.punchRange = this.param<number>("punchRange");
    this.punchKnockback = this.param<number>("punchKnockback");
    this.punchCooldown = this.param<number>("punchCooldown");

    this.fx = new THREE.Group();
    this.fx.name = "survivors-fx";
    this.object.parent?.add(this.fx);
    this.particleGeo = new THREE.SphereGeometry(0.1, 6, 4);

    this.hud = this.div("survivors-hud");
    this.hud.style.cssText =
      "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:800;width:440px;" +
      "font:700 15px ui-monospace,monospace;color:#e6edf3;background:rgba(13,17,23,.8);" +
      "padding:10px 16px;border:1px solid #30363d;border-radius:10px;pointer-events:none;text-align:center";

    this.vignette = this.div("survivors-vignette");
    this.vignette.style.cssText =
      "position:fixed;inset:0;z-index:790;pointer-events:none;opacity:0;" +
      "box-shadow:inset 0 0 140px 50px rgba(248,81,73,.85)";

    this.levelFlash = this.div("survivors-levelflash");
    this.levelFlash.style.cssText =
      "position:fixed;inset:0;z-index:790;pointer-events:none;opacity:0;" +
      "box-shadow:inset 0 0 160px 60px rgba(255,223,90,.7)";

    this.menu = this.div("survivors-menu");
    this.menu.style.cssText =
      "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:810;display:none;" +
      "font:700 15px ui-monospace,monospace;color:#e6edf3;background:rgba(13,17,23,.95);" +
      "padding:18px 20px;border:2px solid #e3b341;border-radius:14px;text-align:center;width:560px";

    this.resetGame();
  }

  override onDispose(): void {
    // pooled bots were hidden at runtime; don't leave them invisible for the editor
    for (const id of this.botIds()) {
      const obj = this.ctx.getObject(id);
      if (obj) obj.visible = true;
    }
    for (const el of [this.hud, this.vignette, this.levelFlash, this.menu]) el?.remove();
    this.hud = this.vignette = this.levelFlash = this.menu = null;
    if (this.fx) {
      this.fx.parent?.remove(this.fx);
      for (const p of this.particles) (p.mesh.material as THREE.Material).dispose();
      this.fx = null;
    }
    this.particles = [];
    this.particleGeo?.dispose();
    this.particleGeo = null;
  }

  private div(id: string): HTMLDivElement {
    let el = document.getElementById(id) as HTMLDivElement | null;
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      document.body.appendChild(el);
    }
    return el;
  }

  private resetGame(): void {
    this.playerMaxHp = this.param<number>("maxHp");
    this.playerHp = this.playerMaxHp;
    this.level = 1;
    this.xp = 0;
    this.xpNeeded = 25;
    this.kills = 0;
    this.elapsed = 0;
    this.punchDamage = this.param<number>("punchDamage");
    this.punchRange = this.param<number>("punchRange");
    this.punchKnockback = this.param<number>("punchKnockback");
    this.punchCooldown = this.param<number>("punchCooldown");
    this.critChance = 0;
    this.regen = 0;
    this.shockwave = false;
    this.takenOnce.clear();
    this.wave = 0;
    this.toSpawn = 0;
    this.breatherUntil = 0;
    this.result = null;
    this.menuOpen = false;
    this.pendingChoice = -1;

    const playerId = this.ctx.findByTag("player")[0];
    if (playerId) {
      this.ctx.sim?.setPosition?.(playerId, [0, 0.2, 6]);
      const obj = this.ctx.getObject(playerId);
      if (obj) {
        obj.userData.speedMult = 1;
        obj.userData.frozen = false;
      }
    }
    this.bots.clear();
    for (const id of this.botIds()) {
      this.bots.set(id, {
        active: false,
        hp: 0,
        maxHp: 1,
        damage: 0,
        speed: 0,
        nextHitAt: 0,
        stunUntil: 0,
      });
      this.parkBot(id);
    }
  }

  private botIds(): string[] {
    return this.ctx.findByTag(this.param<string>("botTag"));
  }

  // ---------------------------------------------------------------- waves

  private parkBot(id: string): void {
    const idx = Math.max(0, this.botIds().indexOf(id));
    this.ctx.sim?.setPosition?.(id, [-13.5 + idx * 3, -31, 0]);
    const obj = this.ctx.getObject(id);
    if (obj) obj.visible = false;
    const s = this.bots.get(id);
    if (s) s.active = false;
  }

  private spawnBot(id: string, t: number): void {
    const angle = Math.random() * Math.PI * 2;
    const r = this.param<number>("spawnRadius") * (0.85 + Math.random() * 0.15);
    const x = Math.max(-13.5, Math.min(13.5, Math.cos(angle) * r));
    const z = Math.max(-13.5, Math.min(13.5, Math.sin(angle) * r));
    this.ctx.sim?.setPosition?.(id, [x, 0.6, z]);
    const obj = this.ctx.getObject(id);
    if (obj) obj.visible = true;
    const w = this.wave - 1;
    const s = this.bots.get(id);
    if (!s) return;
    s.active = true;
    s.maxHp = this.param<number>("botBaseHp") + this.param<number>("botHpPerWave") * w;
    s.hp = s.maxHp;
    s.damage = this.param<number>("botBaseDamage") + this.param<number>("botDamagePerWave") * w;
    s.speed = Math.min(
      this.param<number>("botMaxSpeed"),
      this.param<number>("botBaseSpeed") + this.param<number>("botSpeedPerWave") * w,
    );
    s.nextHitAt = t + 0.5;
    s.stunUntil = 0;
    // spawn poof so arrivals read even at the arena edge
    if (obj) this.burst(obj.position.clone().setY(1), 0x58a6ff, 8, 3);
  }

  private startWave(t: number): void {
    this.wave++;
    this.toSpawn =
      this.param<number>("firstWaveBots") + (this.wave - 1) * this.param<number>("botsPerWave");
    this.spawnAt = t + 0.8;
    this.banner(`🌊 WAVE ${this.wave}!`, 2);
    this.ctx.playSound?.("chime.wav");
  }

  private waveSpawnInterval(): number {
    return Math.max(0.8, 2.4 - this.wave * 0.1);
  }

  // ---------------------------------------------------------------- juice

  private banner(text: string, seconds: number): void {
    this.message = text;
    this.messageUntil = this.now() + seconds;
  }

  private now(): number {
    return this.ctx.now() / 1000;
  }

  private burst(pos: THREE.Vector3, color: number, count: number, power: number): void {
    if (!this.fx || !this.particleGeo) return;
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.copy(pos);
      const scale = 0.7 + Math.random() * 0.9;
      mesh.scale.setScalar(scale);
      this.fx.add(mesh);
      const dir = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() * 0.8 + 0.2,
        Math.random() - 0.5,
      ).normalize();
      const life = 0.45 + Math.random() * 0.3;
      this.particles.push({
        mesh,
        vel: dir.multiplyScalar(power * (0.6 + Math.random() * 0.8)),
        life,
        maxLife: life,
      });
    }
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.parent?.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.y -= 12 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      const k = p.life / p.maxLife;
      p.mesh.scale.setScalar(Math.max(0.01, k));
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = k;
    }
  }

  /** Emissive flash on every mesh under obj; materials are cloned once so the
   * blink can't leak onto other entities sharing the glTF materials. */
  private blink(obj: THREE.Object3D, color: number): void {
    if (!obj.userData.__blinkCloned) {
      obj.userData.__blinkCloned = true;
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((m) => m.clone())
          : mesh.material.clone();
      });
    }
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const std = m as THREE.MeshStandardMaterial;
        if (!std.emissive) continue;
        if (std.userData.__baseEmissive === undefined) {
          std.userData.__baseEmissive = std.emissive.getHex();
          std.userData.__baseEmissiveIntensity = std.emissiveIntensity;
        }
        std.emissive.setHex(color);
        std.emissiveIntensity = 0.9;
      }
    });
    this.blinks.push({ obj, until: this.now() + 0.13 });
  }

  private updateBlinks(t: number): void {
    for (let i = this.blinks.length - 1; i >= 0; i--) {
      const b = this.blinks[i]!;
      if (t < b.until) continue;
      b.obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const std = m as THREE.MeshStandardMaterial;
          if (!std.emissive || std.userData.__baseEmissive === undefined) continue;
          std.emissive.setHex(std.userData.__baseEmissive as number);
          std.emissiveIntensity = std.userData.__baseEmissiveIntensity as number;
        }
      });
      this.blinks.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------- upgrades

  private upgradePool(): Upgrade[] {
    return [
      {
        emoji: "💪",
        name: "Power Punch",
        desc: "+8 punch damage",
        apply: () => (this.punchDamage += 8),
      },
      {
        emoji: "⚡",
        name: "Fast Hands",
        desc: "punch 15% faster",
        apply: () => (this.punchCooldown *= 0.85),
      },
      {
        emoji: "🥊",
        name: "Long Arms",
        desc: "+punch reach & knockback",
        apply: () => {
          this.punchRange += 0.6;
          this.punchKnockback += 2;
        },
      },
      {
        emoji: "❤️",
        name: "Big Heart",
        desc: "+30 max HP and heal 30",
        apply: () => {
          this.playerMaxHp += 30;
          this.playerHp = Math.min(this.playerMaxHp, this.playerHp + 30);
        },
      },
      {
        emoji: "👟",
        name: "Speedy Shoes",
        desc: "run 12% faster",
        apply: () => {
          const obj = this.ctx.getObject(this.ctx.findByTag("player")[0] ?? "");
          if (obj) obj.userData.speedMult = ((obj.userData.speedMult as number) ?? 1) * 1.12;
        },
      },
      {
        emoji: "🌀",
        name: "Shockwave",
        desc: "punches hit EVERY bot in reach",
        once: true,
        apply: () => (this.shockwave = true),
      },
      {
        emoji: "🎯",
        name: "Critical Hits",
        desc: "+15% chance of DOUBLE damage",
        apply: () => (this.critChance = Math.min(0.9, this.critChance + 0.15)),
      },
      {
        emoji: "🌿",
        name: "Regrow",
        desc: "heal 1.5 HP every second",
        apply: () => (this.regen += 1.5),
      },
    ].filter((u) => !(u.once && this.takenOnce.has(u.name)));
  }

  private openMenu(): void {
    const pool = this.upgradePool();
    this.choices = [];
    while (this.choices.length < Math.min(3, pool.length)) {
      const pick = pool[Math.floor(Math.random() * pool.length)]!;
      if (!this.choices.includes(pick)) this.choices.push(pick);
    }
    this.menuOpen = true;
    this.pendingChoice = -1;
    this.setFrozen(true);
    this.ctx.playSound?.("chime.wav");
    this.levelFlashUntil = this.now() + 0.6;
    if (!this.menu) return;
    this.menu.style.display = "block";
    this.menu.innerHTML =
      `<div style="font-size:22px;margin-bottom:2px">⭐ LEVEL ${this.level}! ⭐</div>` +
      `<div style="font-size:12px;color:#8b949e;margin-bottom:12px">pick an upgrade — press 1, 2 or 3 (or click)</div>` +
      `<div style="display:flex;gap:12px">` +
      this.choices
        .map(
          (u, i) =>
            `<div data-pick="${i}" style="flex:1;cursor:pointer;background:#161b22;border:1px solid #30363d;` +
            `border-radius:10px;padding:14px 10px">` +
            `<div style="font-size:34px">${u.emoji}</div>` +
            `<div style="margin:6px 0 4px">${u.name}</div>` +
            `<div style="font-weight:500;font-size:12px;color:#8b949e">${u.desc}</div>` +
            `<div style="margin-top:8px;font-size:12px;color:#e3b341">[ ${i + 1} ]</div></div>`,
        )
        .join("") +
      `</div>`;
    for (const card of Array.from(this.menu.querySelectorAll("[data-pick]"))) {
      (card as HTMLDivElement).onclick = () => {
        // only records the intent — gameplay state changes stay in onFixedUpdate
        this.pendingChoice = Number((card as HTMLDivElement).dataset.pick);
      };
    }
  }

  private closeMenu(choice: number): void {
    const picked = this.choices[choice];
    if (picked) {
      picked.apply();
      if (picked.once) this.takenOnce.add(picked.name);
      this.banner(`${picked.emoji} ${picked.name}!`, 1.6);
    }
    this.menuOpen = false;
    this.setFrozen(false);
    if (this.menu) this.menu.style.display = "none";
  }

  private setFrozen(frozen: boolean): void {
    const obj = this.ctx.getObject(this.ctx.findByTag("player")[0] ?? "");
    if (obj) obj.userData.frozen = frozen;
  }

  private gainXp(amount: number): void {
    this.xp += amount;
    if (this.xp >= this.xpNeeded) {
      this.xp -= this.xpNeeded;
      this.level++;
      this.xpNeeded = 25 + (this.level - 1) * 20;
      this.openMenu();
    }
  }

  // ---------------------------------------------------------------- HUD

  private barRow(label: string, frac: number, text: string, color: string): string {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    return (
      `<div style="display:flex;align-items:center;gap:8px;margin:3px 0">` +
      `<span style="width:52px;text-align:left">${label}</span>` +
      `<div style="flex:1;height:12px;background:#21262d;border-radius:6px;overflow:hidden">` +
      `<div style="width:${pct}%;height:100%;background:${color};border-radius:6px"></div></div>` +
      `<span style="width:76px;text-align:right;font-size:12px">${text}</span></div>`
    );
  }

  private render(): void {
    if (!this.hud) return;
    const t = this.now();
    const alive = [...this.bots.values()].filter((b) => b.active).length;
    let bannerText = `🌊 wave ${Math.max(1, this.wave)} · 🤖 ${alive + this.toSpawn} left`;
    if (this.result === "over") {
      bannerText = `💀 GAME OVER — you reached wave ${this.wave} with ${this.kills} bonks!`;
    } else if (t < this.messageUntil) {
      bannerText = this.message;
    } else if (t < this.breatherUntil) {
      bannerText = `✨ wave cleared! next one in ${Math.ceil(this.breatherUntil - t)}…`;
    }
    const m = Math.floor(this.elapsed / 60);
    const s = Math.floor(this.elapsed % 60);
    this.hud.innerHTML =
      `<div style="font-size:17px;margin-bottom:4px">${bannerText}</div>` +
      this.barRow(
        "❤️ HP",
        this.playerHp / this.playerMaxHp,
        `${Math.max(0, Math.ceil(this.playerHp))}/${this.playerMaxHp}`,
        "#3fb950",
      ) +
      this.barRow("⭐ XP", this.xp / this.xpNeeded, `lvl ${this.level}`, "#58a6ff") +
      `<div style="font-size:12px;font-weight:500;color:#8b949e;margin-top:4px">` +
      `⏱ ${m}:${String(s).padStart(2, "0")} · 💥 ${this.kills} bonks · WASD move · mouse look · SPACE jump · F punch</div>`;
    if (this.vignette) {
      this.vignette.style.opacity = String(Math.max(0, (this.hurtFlashUntil - t) / 0.45));
    }
    if (this.levelFlash) {
      this.levelFlash.style.opacity = String(Math.max(0, (this.levelFlashUntil - t) / 0.6));
    }
  }

  // ---------------------------------------------------------------- tick

  override onFixedUpdate(dt: number): void {
    const sim = this.ctx.sim;
    if (!sim) return;
    const t = this.now();
    this.updateParticles(dt);
    this.updateBlinks(t);

    const playerId = this.ctx.findByTag("player")[0];
    if (!playerId) return;
    const player = this.ctx.getObject(playerId);
    if (!player) return;

    if (this.result === "over") {
      if (t >= this.overUntil) this.resetGame();
      this.render();
      return;
    }

    // upgrade menu: world holds its breath until a choice lands
    if (this.menuOpen) {
      for (const id of this.botIds()) {
        if (this.bots.get(id)?.active) sim.setLinvel(id, [0, 0, 0]);
      }
      let choice = this.pendingChoice;
      if (this.ctx.input.isDown("Digit1") || this.ctx.input.isDown("Numpad1")) choice = 0;
      if (this.ctx.input.isDown("Digit2") || this.ctx.input.isDown("Numpad2")) choice = 1;
      if (this.ctx.input.isDown("Digit3") || this.ctx.input.isDown("Numpad3")) choice = 2;
      if (choice >= 0 && choice < this.choices.length) this.closeMenu(choice);
      this.render();
      return;
    }

    this.elapsed += dt;
    if (this.regen > 0) this.playerHp = Math.min(this.playerMaxHp, this.playerHp + this.regen * dt);
    if (player.position.y < -5) sim.setPosition?.(playerId, [0, 0.2, 6]);

    // wave director
    const activeBots = this.botIds().filter((id) => this.bots.get(id)?.active);
    if (this.wave === 0) {
      this.startWave(t);
    } else if (this.toSpawn > 0 && t >= this.spawnAt) {
      const free = this.botIds().find((id) => !this.bots.get(id)?.active);
      if (free) {
        this.spawnBot(free, t);
        this.toSpawn--;
        this.spawnAt = t + this.waveSpawnInterval();
      }
    } else if (this.toSpawn === 0 && activeBots.length === 0) {
      if (this.breatherUntil === 0) {
        this.breatherUntil = t + this.param<number>("breatherSeconds");
        this.playerHp = Math.min(this.playerMaxHp, this.playerHp + 10);
        this.ctx.playSound?.("chime.wav");
      } else if (t >= this.breatherUntil) {
        this.breatherUntil = 0;
        this.startWave(t);
      }
    }

    // bot brains: chase, bite, never fall out of the world
    for (const id of activeBots) {
      const s = this.bots.get(id)!;
      const bot = this.ctx.getObject(id);
      if (!bot) continue;
      if (bot.position.y < -5) {
        this.parkBot(id);
        continue;
      }
      const dx = player.position.x - bot.position.x;
      const dz = player.position.z - bot.position.z;
      const dist = Math.hypot(dx, dz);
      if (t >= s.stunUntil && dist > 0.01) {
        const vel = sim.getLinvel(id);
        if (vel) {
          sim.setLinvel(id, [(dx / dist) * s.speed, vel[1], (dz / dist) * s.speed]);
          bot.rotation.set(0, Math.atan2(dx, dz), 0);
        }
      }
      if (dist < this.param<number>("botAttackRange") && t >= s.nextHitAt) {
        s.nextHitAt = t + this.param<number>("botAttackCooldown");
        this.playerHp -= s.damage;
        this.hurtFlashUntil = t + 0.45;
        this.blink(player, BLINK_RED);
        this.burst(player.position.clone().setY(1.2), 0xf85149, 6, 3);
        this.banner("🤖 OUCH!", 0.6);
        this.ctx.playSound?.("thud.wav");
      }
    }

    // punch!
    const input = this.ctx.input;
    if ((input.isDown("KeyF") || input.isDown("KeyE")) && t >= this.punchReadyAt) {
      this.punchReadyAt = t + this.punchCooldown;
      const inRange = activeBots
        .map((id) => {
          const bot = this.ctx.getObject(id);
          if (!bot) return null;
          const dx = bot.position.x - player.position.x;
          const dz = bot.position.z - player.position.z;
          return { id, bot, dist: Math.hypot(dx, dz), dx, dz };
        })
        .filter((h): h is NonNullable<typeof h> => h !== null && h.dist < this.punchRange)
        .sort((a, b) => a.dist - b.dist);
      const targets = this.shockwave ? inRange : inRange.slice(0, 1);
      for (const hit of targets) {
        const s = this.bots.get(hit.id)!;
        const crit = Math.random() < this.critChance;
        s.hp -= this.punchDamage * (crit ? 2 : 1);
        s.stunUntil = t + this.param<number>("stunSeconds");
        const n = hit.dist > 0.01 ? hit.dist : 1;
        sim.setLinvel(hit.id, [
          (hit.dx / n) * this.punchKnockback,
          5,
          (hit.dz / n) * this.punchKnockback,
        ]);
        this.blink(hit.bot, BLINK_WHITE);
        this.burst(
          hit.bot.position.clone().setY(1.2),
          crit ? 0xffd93d : 0xffffff,
          crit ? 16 : 10,
          crit ? 6 : 4,
        );
        this.banner(crit ? "🎯 CRIT!" : "💥 POW!", 0.5);
        this.ctx.playSound?.("thud.wav");
        if (s.hp <= 0) {
          this.kills++;
          this.burst(hit.bot.position.clone().setY(1), 0xf85149, 20, 6);
          this.parkBot(hit.id);
          this.gainXp(this.param<number>("xpPerKill"));
          if (this.menuOpen) break; // level-up popped mid-swing
        }
      }
    }

    if (this.playerHp <= 0) {
      this.result = "over";
      this.overUntil = t + this.param<number>("restartAfter");
      this.setFrozen(true);
      this.burst(player.position.clone().setY(1.2), 0xf85149, 24, 7);
    }

    this.render();
  }
}
