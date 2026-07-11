import * as THREE from "three/webgpu";
import { Script } from "@hitreg/scripting";

export default class CubeRpgManager extends Script {
  static override scriptName = "cube-rpg-manager";
  static override params = {
    maxHp: { default: 100, min: 10, max: 500 },
    relicTag: { default: "rpg-relic" },
    chestTag: { default: "rpg-chest" },
    enemyTag: { default: "rpg-enemy" },
    npcTag: { default: "npc" },
    playerTag: { default: "player" },
    collectRange: { default: 1.6, min: 0.5, max: 5 },
    interactRange: { default: 2.3, min: 0.5, max: 6 },
    enemyRange: { default: 1.7, min: 0.5, max: 6 },
    enemyDamage: { default: 12, min: 0, max: 100 },
    enemyCooldown: { default: 1.1, min: 0.1, max: 10 },
    itemTag: { default: "rpg-item" },
    potionTag: { default: "rpg-potion" },
    attackRange: { default: 2.2, min: 0.5, max: 6 },
    attackDamage: { default: 30, min: 1, max: 200 },
    swordBonus: { default: 20, min: 0, max: 200 },
    shieldReduction: { default: 0.4, min: 0, max: 0.9 },
    attackCooldown: { default: 0.45, min: 0.1, max: 3 },
  };

  private hp = 100;
  private collected = new Set<string>();
  private inventory = new Set<string>();
  private enemyHp = new Map<string, number>();
  private defeated = new Set<string>();
  private potions = 0;
  private nextHitAt = 0;
  private nextAttackAt = 0;
  private message = "Find the three crystals, then open the chest.";
  private messageUntil = 0;
  private won = false;
  private hud: HTMLDivElement | null = null;
  private inventoryPanel: HTMLDivElement | null = null;
  private dialoguePanel: HTMLDivElement | null = null;
  private inventoryOpen = false;
  private toggleWasDown = false;
  private interactWasDown = false;
  private equippedWeapon = "";
  private shieldEquipped = false;
  private readonly distanceA = new THREE.Vector3();
  private readonly distanceB = new THREE.Vector3();
  private readonly weaponDamage = new Map([
    ["Stone Sword", 12],
    ["Gold Sword", 24],
    ["Wood Axe", 16],
    ["Relic Pickaxe", 10],
  ]);
  private readonly weaponVisuals = new Map([
    ["Stone Sword", "player-hand-stone-sword"],
    ["Gold Sword", "player-hand-gold-sword"],
    ["Wood Axe", "player-hand-wood-axe"],
    ["Relic Pickaxe", "player-hand-relic-pickaxe"],
  ]);
  private readonly dialogue = new Map([
    ["elder", "The valley crystals keep the old chest sealed. Bring all three back before the wilds grow darker."],
    ["blacksmith", "A sword is only useful when equipped. Open your pack with I and choose the blade you want in hand."],
    ["traveler", "The town is safe. Trouble starts past the road stones, where the skeletons patrol the outer field."],
  ]);
  private readonly onInventoryClick = (event: MouseEvent): void => {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-equip]") : null;
    if (!target) return;
    this.equip(target.dataset.equip ?? "");
  };

  override onStart(): void {
    this.hp = this.param<number>("maxHp");
    this.hud = document.createElement("div");
    this.hud.id = "cube-rpg-hud";
    this.hud.style.cssText =
      "position:fixed;left:18px;bottom:18px;z-index:800;width:330px;" +
      "font:600 14px ui-monospace,monospace;color:#f4f7fb;background:rgba(15,20,28,.78);" +
      "border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:12px 14px;pointer-events:none;" +
      "box-shadow:0 12px 32px rgba(0,0,0,.28)";
    document.body.appendChild(this.hud);
    this.inventoryPanel = document.createElement("div");
    this.inventoryPanel.id = "cube-rpg-inventory";
    this.inventoryPanel.style.cssText =
      "position:fixed;right:18px;top:18px;z-index:801;width:360px;max-width:calc(100vw - 36px);" +
      "font:600 14px ui-monospace,monospace;color:#f4f7fb;background:rgba(15,20,28,.9);" +
      "border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:12px 14px;display:none;" +
      "box-shadow:0 14px 38px rgba(0,0,0,.34);pointer-events:auto";
    this.inventoryPanel.addEventListener("click", this.onInventoryClick);
    document.body.appendChild(this.inventoryPanel);
    this.dialoguePanel = document.createElement("div");
    this.dialoguePanel.id = "cube-rpg-dialogue";
    this.dialoguePanel.style.cssText =
      "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:802;width:560px;max-width:calc(100vw - 36px);" +
      "font:600 15px ui-monospace,monospace;color:#f4f7fb;background:rgba(15,20,28,.88);" +
      "border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:13px 16px;display:none;" +
      "box-shadow:0 14px 38px rgba(0,0,0,.34);pointer-events:none";
    document.body.appendChild(this.dialoguePanel);
    for (const id of this.ctx.findByTag(this.param<string>("enemyTag"))) {
      this.enemyHp.set(id, this.ctx.getEntity(id)?.tags.includes("elite") ? 120 : 80);
    }

    // Multiplayer combat contracts. "npc.hit" is a to-authority request:
    // peers' attacks route to the session host, which applies damage from
    // ITS hp table (never trusting the sender). "npc.defeated" broadcasts
    // back to-peers so every tab hides the corpse and counts the kill.
    // Single-player: both simply deliver locally — same code either way.
    this.ctx.events?.on("npc.hit", (payload) => {
      const p = payload as { npc: string; damage: number };
      this.applyNpcHit(p.npc, p.damage);
    });
    this.ctx.events?.on("npc.defeated", (payload) => {
      const p = payload as { npc: string; name: string };
      this.applyNpcDefeated(p.npc, p.name);
    });

    this.refreshWeaponVisuals();
    this.render();
  }

  override onDispose(): void {
    this.inventoryPanel?.removeEventListener("click", this.onInventoryClick);
    this.inventoryPanel?.remove();
    this.inventoryPanel = null;
    this.dialoguePanel?.remove();
    this.dialoguePanel = null;
    this.hud?.remove();
    this.hud = null;
  }

  private render(): void {
    if (!this.hud) return;
    const total = this.ctx.findByTag(this.param<string>("relicTag")).length;
    const hpPct = Math.max(0, Math.round((this.hp / this.param<number>("maxHp")) * 100));
    const t = this.ctx.now() / 1000;
    const line =
      t < this.messageUntil || this.won ? this.message : "WASD move, Space jump, F attack, I inventory, H potion, E chest.";
    const items = [...this.inventory].join(", ") || "empty";
    const weapon = this.equippedWeapon || "None";
    const shield = this.shieldEquipped ? "Shield" : "None";
    this.hud.innerHTML =
      `<div style="font-size:16px;margin-bottom:8px">Cube Vale Quest</div>` +
      `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">` +
      `<span style="width:54px">HP</span><div style="flex:1;height:10px;background:#27303d;border-radius:5px;overflow:hidden">` +
      `<div style="width:${hpPct}%;height:100%;background:#58d68d"></div></div><span>${Math.max(0, Math.ceil(this.hp))}</span></div>` +
      `<div>Crystals: ${this.collected.size}/${total}</div>` +
      `<div>Equipped: ${weapon} / ${shield}</div>` +
      `<div>Inventory: ${items}${this.potions > 0 ? `, Potion x${this.potions}` : ""}</div>` +
      `<div style="margin-top:7px;color:#c6d3e1;font-weight:500">${line}</div>`;
    this.renderInventory();
  }

  private renderInventory(): void {
    if (!this.inventoryPanel) return;
    this.inventoryPanel.style.display = this.inventoryOpen ? "block" : "none";
    if (!this.inventoryOpen) return;

    const items = [...this.inventory];
    const weapons = items.filter((item) => this.weaponDamage.has(item));
    const otherItems = items.filter((item) => !this.weaponDamage.has(item) && item !== "Shield");
    const buttonStyle =
      "width:100%;min-height:34px;margin-top:7px;border:1px solid rgba(255,255,255,.16);" +
      "border-radius:6px;background:#263241;color:#f4f7fb;font:600 13px ui-monospace,monospace;text-align:left;padding:8px 10px;cursor:pointer";
    const weaponRows =
      weapons
        .map((item, index) => {
          const suffix = this.equippedWeapon === item ? " equipped" : ` +${this.weaponDamage.get(item)} damage`;
          return `<button style="${buttonStyle}" data-equip="${item}">${index + 1}. ${item} - ${suffix}</button>`;
        })
        .join("") || `<div style="color:#93a4b8;margin-top:7px">No weapons found.</div>`;
    const shieldRow = this.inventory.has("Shield")
      ? `<button style="${buttonStyle}" data-equip="Shield">Shield - ${this.shieldEquipped ? "equipped" : "equip"}</button>`
      : `<div style="color:#93a4b8;margin-top:7px">No shield found.</div>`;
    const other = otherItems.length ? otherItems.join(", ") : "None";
    this.inventoryPanel.innerHTML =
      `<div style="font-size:16px;margin-bottom:8px">Inventory</div>` +
      `<div style="color:#c6d3e1;font-weight:500;margin-bottom:10px">Press I to close. Click an item or press 1-4 to equip weapons.</div>` +
      `<div style="margin-top:8px;color:#c6d3e1">Weapons</div>${weaponRows}` +
      `<div style="margin-top:12px;color:#c6d3e1">Armor</div>${shieldRow}` +
      `<div style="margin-top:12px;color:#c6d3e1">Items</div><div style="margin-top:5px">${other}${this.potions > 0 ? `, Potion x${this.potions}` : ""}</div>`;
  }

  private equip(item: string): void {
    if (!this.inventory.has(item)) return;
    if (this.weaponDamage.has(item)) {
      this.equippedWeapon = item;
      this.message = `${item} equipped.`;
    } else if (item === "Shield") {
      this.shieldEquipped = !this.shieldEquipped;
      this.message = this.shieldEquipped ? "Shield equipped." : "Shield unequipped.";
    } else {
      return;
    }
    this.messageUntil = this.ctx.now() / 1000 + 1.2;
    this.refreshWeaponVisuals();
  }

  private refreshWeaponVisuals(): void {
    for (const [item, id] of this.weaponVisuals) {
      const object = this.ctx.getObject(id);
      if (object) object.visible = this.equippedWeapon === item;
    }
    const playerId = this.playerId();
    const player = playerId ? this.ctx.getObject(playerId) : undefined;
    if (player) player.userData["holdingWeapon"] = this.equippedWeapon !== "";
  }

  private renderDialogue(speaker: string, text: string): void {
    if (!this.dialoguePanel) return;
    this.dialoguePanel.style.display = "block";
    this.dialoguePanel.innerHTML =
      `<div style="font-size:13px;color:#9fb2c8;margin-bottom:5px">${speaker}</div>` +
      `<div style="line-height:1.42">${text}</div>`;
  }

  private hideDialogue(): void {
    if (this.dialoguePanel) this.dialoguePanel.style.display = "none";
  }

  private playerId(): string | undefined {
    return this.ctx.findByTag(this.param<string>("playerTag"))[0];
  }

  private dist(a: string, b: string): number {
    const ao = this.ctx.getObject(a);
    const bo = this.ctx.getObject(b);
    if (!ao || !bo) return Infinity;
    return ao.getWorldPosition(this.distanceA).distanceTo(bo.getWorldPosition(this.distanceB));
  }

  private pickup(playerId: string, tag: string): void {
    const t = this.ctx.now() / 1000;
    for (const id of this.ctx.findByTag(tag)) {
      const object = this.ctx.getObject(id);
      if (!object?.visible || this.dist(playerId, id) > this.param<number>("collectRange")) continue;
      object.visible = false;
      const entity = this.ctx.getEntity(id);
      if (entity?.tags.includes(this.param<string>("potionTag"))) {
        this.potions++;
        this.message = "Potion added to inventory.";
      } else {
        this.inventory.add(entity?.name ?? id);
        const name = entity?.name ?? id;
        if (!this.equippedWeapon && this.weaponDamage.has(name)) {
          this.equippedWeapon = name;
          this.refreshWeaponVisuals();
        }
        this.message = `${entity?.name ?? "Item"} added to inventory.`;
      }
      this.messageUntil = t + 1.6;
    }
  }

  private attack(playerId: string): void {
    const t = this.ctx.now() / 1000;
    if (!this.ctx.input.isDown("KeyF") || t < this.nextAttackAt) return;
    this.nextAttackAt = t + this.param<number>("attackCooldown");
    this.playAttackAnimation(playerId, t);

    let targetId: string | null = null;
    let targetDist = Infinity;
    for (const id of this.ctx.findByTag(this.param<string>("enemyTag"))) {
      const object = this.ctx.getObject(id);
      if (!object?.visible || this.defeated.has(id)) continue;
      const d = this.dist(playerId, id);
      if (d < targetDist) {
        targetId = id;
        targetDist = d;
      }
    }
    if (!targetId || targetDist > this.param<number>("attackRange")) {
      this.message = "No enemy in range.";
      this.messageUntil = t + 0.8;
      return;
    }

    const weaponBonus = this.equippedWeapon
      ? this.weaponDamage.get(this.equippedWeapon) ?? this.param<number>("swordBonus")
      : 0;
    const damage = this.param<number>("attackDamage") + weaponBonus;
    this.message = `Hit for ${damage}.`;
    this.messageUntil = t + 1;

    // the swing is a REQUEST — the authority applies it (on the host and in
    // single-player this delivers straight to our own applyNpcHit)
    this.ctx.events?.emit("npc.hit", { npc: targetId, damage });
  }

  /** AUTHORITY-side damage: runs from our own swings and peers' requests. */
  private applyNpcHit(targetId: string, damage: number): void {
    if (this.defeated.has(targetId)) return;
    const hp = (this.enemyHp.get(targetId) ?? 80) - damage;
    this.enemyHp.set(targetId, hp);

    // knock the enemy away from whoever is closest (good enough for a shove)
    const target = this.ctx.getObject(targetId);
    let nearest: { x: number; z: number } | null = null;
    let nearestDist = Infinity;
    if (target) {
      for (const pid of this.ctx.findByTag("player")) {
        const p = this.ctx.getObject(pid);
        if (!p) continue;
        const dx = target.position.x - p.position.x;
        const dz = target.position.z - p.position.z;
        const d = dx * dx + dz * dz;
        if (d < nearestDist) {
          nearestDist = d;
          nearest = { x: dx, z: dz };
        }
      }
    }
    if (nearest) {
      const len = Math.hypot(nearest.x, nearest.z) || 1;
      this.ctx.sim?.setLinvel(targetId, [(nearest.x / len) * 8, 3, (nearest.z / len) * 8]);
    }

    if (hp <= 0) {
      // broadcast the kill — every tab (including us) buries it identically
      this.ctx.events?.emit("npc.defeated", {
        npc: targetId,
        name: this.ctx.getEntity(targetId)?.name ?? "Enemy",
      });
    }
  }

  /** Runs on EVERY tab (to-peers): hide the corpse, count the kill. */
  private applyNpcDefeated(targetId: string, name: string): void {
    if (this.defeated.has(targetId)) return;
    this.defeated.add(targetId);
    const target = this.ctx.getObject(targetId);
    if (target) target.visible = false;
    this.ctx.sim?.setPosition?.(targetId, [0, -30, 0]); // no body locally = no-op
    this.message = `${name} defeated.`;
    this.messageUntil = this.ctx.now() / 1000 + 1;
  }

  private usePotion(): void {
    if (!this.ctx.input.isDown("KeyH") || this.potions <= 0 || this.hp >= this.param<number>("maxHp")) return;
    this.potions--;
    this.hp = Math.min(this.param<number>("maxHp"), this.hp + 40);
    this.message = "Potion used.";
    this.messageUntil = this.ctx.now() / 1000 + 1.2;
  }

  private playAttackAnimation(playerId: string, t: number): void {
    const player = this.ctx.getObject(playerId);
    const vel = this.ctx.sim?.getLinvel(playerId);
    const moving = vel ? Math.hypot(vel[0], vel[2]) > 0.3 : false;
    if (player) {
      player.userData["actionClip"] = moving ? "Run_Attack" : "Idle_Attack";
      player.userData["actionUntil"] = t + 0.42;
      player.userData["holdingWeapon"] = this.equippedWeapon !== "";
    }
  }

  private nearestNpc(playerId: string): string | null {
    let nearest: string | null = null;
    let nearestDist = Infinity;
    for (const id of this.ctx.findByTag(this.param<string>("npcTag"))) {
      const object = this.ctx.getObject(id);
      if (!object?.visible) continue;
      const distance = this.dist(playerId, id);
      if (distance < nearestDist) {
        nearest = id;
        nearestDist = distance;
      }
    }
    return nearestDist <= this.param<number>("interactRange") ? nearest : null;
  }

  private talkToNpc(playerId: string, interactPressed: boolean): boolean {
    const npcId = this.nearestNpc(playerId);
    if (!npcId) {
      this.hideDialogue();
      return false;
    }

    const npc = this.ctx.getEntity(npcId);
    const speaker = npc?.name ?? "Villager";
    const line = this.dialogue.get(npcId) ?? "Stay close to town until you are ready for a fight.";
    this.message = interactPressed ? `${speaker} is talking.` : `Press E to talk to ${speaker}.`;
    this.messageUntil = this.ctx.now() / 1000 + 0.2;
    if (interactPressed) this.renderDialogue(speaker, line);
    return true;
  }

  private respawn(playerId: string): void {
    this.hp = this.param<number>("maxHp");
    this.ctx.sim?.setPosition?.(playerId, [0, 1.2, 8]);
    this.message = "You were knocked back to camp.";
    this.messageUntil = this.ctx.now() / 1000 + 2;
  }

  override onFixedUpdate(): void {
    const playerId = this.playerId();
    if (!playerId) return;
    const t = this.ctx.now() / 1000;

    this.pickup(playerId, this.param<string>("itemTag"));
    for (const id of this.ctx.findByTag(this.param<string>("relicTag"))) {
      if (this.collected.has(id) || this.dist(playerId, id) > this.param<number>("collectRange")) continue;
      this.collected.add(id);
      const object = this.ctx.getObject(id);
      if (object) object.visible = false;
      this.message = "Crystal recovered.";
      this.messageUntil = t + 1.5;
    }
    this.attack(playerId);
    this.usePotion();

    if (!this.won) {
      for (const id of this.ctx.findByTag(this.param<string>("enemyTag"))) {
        const object = this.ctx.getObject(id);
        if (!object?.visible || this.dist(playerId, id) > this.param<number>("enemyRange") || t < this.nextHitAt) continue;
        this.nextHitAt = t + this.param<number>("enemyCooldown");
        const blocked = this.shieldEquipped;
        this.hp -= this.param<number>("enemyDamage") * (blocked ? 1 - this.param<number>("shieldReduction") : 1);
        this.message = "An enemy hit you.";
        this.messageUntil = t + 1;
      }
    }

    if (this.hp <= 0) this.respawn(playerId);
    this.refreshWeaponVisuals();

    const interactDown = this.ctx.input.isDown("KeyE");
    const interactPressed = interactDown && !this.interactWasDown;
    this.interactWasDown = interactDown;
    const talked = this.talkToNpc(playerId, interactPressed);

    const inventoryDown = this.ctx.input.isDown("KeyI");
    if (inventoryDown && !this.toggleWasDown) {
      this.inventoryOpen = !this.inventoryOpen;
      this.renderInventory();
    }
    this.toggleWasDown = inventoryDown;
    if (this.inventoryOpen) {
      const weapons = [...this.inventory].filter((item) => this.weaponDamage.has(item));
      for (let i = 0; i < weapons.length && i < 4; i++) {
        const weapon = weapons[i];
        if (weapon && this.ctx.input.isDown(`Digit${i + 1}`)) this.equip(weapon);
      }
    }

    const total = this.ctx.findByTag(this.param<string>("relicTag")).length;
    const nearChest = this.ctx.findByTag(this.param<string>("chestTag")).some((id) => {
      return this.dist(playerId, id) <= this.param<number>("interactRange");
    });
    if (!this.won && nearChest && interactPressed && !talked) {
      if (this.collected.size >= total) {
        this.won = true;
        this.message = "Quest complete. The valley chest is open.";
        for (const id of this.ctx.findByTag(this.param<string>("chestTag"))) {
          const object = this.ctx.getObject(id);
          if (object) object.rotation.y = Math.PI * 0.08;
        }
      } else {
        this.message = "The chest needs all three crystals.";
        this.messageUntil = t + 1.5;
      }
    }

    this.render();
  }
}
