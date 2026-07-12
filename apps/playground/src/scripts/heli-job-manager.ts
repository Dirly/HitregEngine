import * as THREE from "three/webgpu";
import { Script } from "@hitreg/scripting";

/**
 * Drives the whole "odd jobs" loop for the island: picks a random job
 * (delivery / firefighting / demolition / rescue), lights up the beacon(s)
 * relevant to its current phase, watches the helicopter's position via plain
 * proximity checks (the Door/FaceTarget idiom — no physics triggers needed),
 * and pays out on completion. Money is durable (ctx.playerData); job state
 * itself is session-only, like cube-rpg's enemy pools.
 *
 * Every interactive object in the world is pre-placed and pooled (chunks and
 * subscenes can't add entities at runtime) — this script only ever toggles
 * visibility and billboard-lit beacons on things that already exist.
 */

type JobType = "delivery" | "firefighting" | "demolition" | "rescue";

interface CargoPad {
  id: string;
  name: string;
}

const CARGO_PADS: CargoPad[] = [
  { id: "cargo-pad-1", name: "Ridgeline Pad" },
  { id: "cargo-pad-2", name: "West Shore Pad" },
  { id: "cargo-pad-3", name: "South Flats Pad" },
  { id: "cargo-pad-4", name: "North Fields Pad" },
];
const WATER_BUOYS = ["water-buoy-1", "water-buoy-2", "water-buoy-3"];
const FIRE_SITES = ["fire-1", "fire-2"];
const DEMOLITION_SITES = ["demolition-1", "demolition-2"];
const RESCUE_SITES = ["rescue-1", "rescue-2"];
const DEPOT_POS: [number, number, number] = [0, 6, 0];
// re-rendering a shadow map every single frame is expensive — with
// autoUpdate off, the sun only needs a fresh shadow render when it's moved
// far enough that the old frustum position would visibly be wrong, not on
// every tick just because the helicopter twitched a meter.
const SUN_UPDATE_DISTANCE_SQ = 80 * 80;

const REWARDS: Record<JobType, number> = {
  delivery: 120,
  firefighting: 180,
  demolition: 220,
  rescue: 200,
};
const FIRE_DUMPS_NEEDED = 2;
const PICKUP_RADIUS = 9;
const DEMOLITION_RADIUS = 7;
const DEPOT_RADIUS = 10;
const RESCUE_RADIUS = 7;
const RESCUE_DWELL = 1.2;
const CRASH_PENALTY = 40;

export default class HeliJobManager extends Script {
  static override scriptName = "heli-job-manager";
  static override params = {};

  private heliId = "";
  private money = 0;
  private moneyReady = false;

  private jobType: JobType | null = null;
  private jobPhase = "";
  private pickupPad: CargoPad | null = null;
  private dropoffPad: CargoPad | null = null;
  private waterBuoyId = "";
  private fireId = "";
  private fireDumpsDone = 0;
  private demolitionId = "";
  private rescueId = "";
  private rescueDwell = 0;
  private idleUntil = 0;
  private toast = "";
  private toastUntil = 0;
  private sunHeight = 220;
  private readonly lastSunUpdatePos = new THREE.Vector3();

  private hud: HTMLDivElement | null = null;

  private div(id: string): HTMLDivElement {
    let el = document.getElementById(id) as HTMLDivElement | null;
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      document.body.appendChild(el);
    }
    return el;
  }

  override onStart(): void {
    this.heliId = this.ctx.findByTag("player")[0] ?? "";
    const heli = this.ctx.getObject(this.heliId);
    if (heli) heli.userData.respawnPoint = DEPOT_POS;

    // NOTE: we tried driving shadow.autoUpdate=false + manual needsUpdate to
    // throttle the shadow re-render cost — it silently broke shadows
    // entirely (this renderer's per-light shadow path doesn't reliably honor
    // it), so we're back to the default (always refreshes). Repositioning
    // still happens in coarse steps below — that part was never the cost.
    const sun = this.ctx.getObject("sun");
    this.sunHeight = sun?.position.y ?? 220;
    if (sun) this.lastSunUpdatePos.copy(sun.position);

    for (const child of ["carry-crate", "carry-bucket", "carry-wreckingball"]) {
      for (const id of this.ctx.findByTag(child)) {
        const obj = this.ctx.getObject(id);
        if (obj) obj.visible = false;
      }
    }
    for (const pad of CARGO_PADS) this.setPoiBeacon(pad.id, false);
    for (const id of WATER_BUOYS) this.setPoiBeacon(id, false);
    for (const id of FIRE_SITES) {
      this.setPoiBeacon(id, false);
      this.setVisible(`${id}:fire-fx`, false);
    }
    for (const id of DEMOLITION_SITES) {
      this.setPoiBeacon(id, false);
      this.setVisible(`${id}:intact`, true);
      this.setVisible(`${id}:rubble`, false);
    }
    for (const id of RESCUE_SITES) {
      this.setPoiBeacon(id, false);
      this.setVisible(`${id}:victim`, true);
      this.setVisible(`${id}:victim-head`, true);
    }
    // hide pickup-pad crates that don't yet hold cargo (they'll reappear when a
    // delivery job actually assigns that pad as its pickup)
    for (const pad of CARGO_PADS) this.setVisible(`${pad.id}:crate`, false);

    void this.ctx.playerData?.get("heli-economy", "money").then((v) => {
      this.money = typeof v === "number" ? v : 750;
      this.moneyReady = true;
    });

    this.hud = this.div("heli-job-hud");
    this.hud.style.cssText =
      "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:800;width:520px;" +
      "font:700 14px ui-monospace,monospace;color:#e6edf3;background:rgba(13,17,23,.82);" +
      "padding:10px 18px;border:1px solid #30363d;border-radius:10px;pointer-events:none;text-align:center";
  }

  override onDispose(): void {
    this.hud?.remove();
    this.hud = null;
  }

  private setVisible(id: string, visible: boolean): void {
    const obj = this.ctx.getObject(id);
    if (obj) obj.visible = visible;
  }

  private setPoiBeacon(id: string, visible: boolean): void {
    this.setVisible(`${id}:beacon`, visible);
  }

  private dist(id: string): number {
    const heli = this.ctx.getObject(this.heliId);
    const other = this.ctx.getObject(id);
    if (!heli || !other) return Infinity;
    return heli.position.distanceTo(other.position);
  }

  private distToPoint(p: [number, number, number]): number {
    const heli = this.ctx.getObject(this.heliId);
    if (!heli) return Infinity;
    const dx = heli.position.x - p[0];
    const dy = heli.position.y - p[1];
    const dz = heli.position.z - p[2];
    return Math.hypot(dx, dy, dz);
  }

  private banner(text: string, seconds: number): void {
    this.toast = text;
    this.toastUntil = this.now() + seconds;
  }

  private now(): number {
    return this.ctx.now() / 1000;
  }

  private award(type: JobType): void {
    const amount = REWARDS[type];
    this.money += amount;
    this.banner(`💰 +$${amount} — job complete!`, 3);
    void this.ctx.playerData?.increment("heli-economy", "money", amount);
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]!;
  }

  private startNextJob(): void {
    const type = this.pick<JobType>(["delivery", "firefighting", "demolition", "rescue"]);
    this.jobType = type;
    if (type === "delivery") {
      const pickup = this.pick(CARGO_PADS);
      let dropoff = this.pick(CARGO_PADS);
      while (dropoff.id === pickup.id) dropoff = this.pick(CARGO_PADS);
      this.pickupPad = pickup;
      this.dropoffPad = dropoff;
      this.jobPhase = "pickup";
      this.setVisible(`${pickup.id}:crate`, true);
      this.setPoiBeacon(pickup.id, true);
      this.banner(`📦 DELIVERY — pick up cargo at ${pickup.name}`, 4);
    } else if (type === "firefighting") {
      this.waterBuoyId = this.pick(WATER_BUOYS);
      this.fireId = this.pick(FIRE_SITES);
      this.fireDumpsDone = 0;
      this.jobPhase = "getwater";
      this.setPoiBeacon(this.waterBuoyId, true);
      this.setVisible(`${this.fireId}:fire-fx`, true);
      this.setPoiBeacon(this.fireId, true);
      this.banner("🔥 WILDFIRE — scoop water at the buoy, then dump it on the fire", 4);
    } else if (type === "demolition") {
      this.demolitionId = this.pick(DEMOLITION_SITES);
      this.jobPhase = "demolish";
      this.setPoiBeacon(this.demolitionId, true);
      const heli = this.ctx.getObject(this.heliId);
      if (heli) heli.userData.carrying = "wreckingball";
      this.setVisibleTag("carry-wreckingball", true);
      this.banner("🏗️ DEMOLITION — swing the wrecking ball into the target", 4);
    } else {
      this.rescueId = this.pick(RESCUE_SITES);
      this.rescueDwell = 0;
      this.jobPhase = "rescue";
      this.setPoiBeacon(this.rescueId, true);
      this.banner("🚁 RESCUE — hover low over the stranded survivor", 4);
    }
  }

  private setVisibleTag(tag: string, visible: boolean): void {
    for (const id of this.ctx.findByTag(tag)) this.setVisible(id, visible);
  }

  private endJob(): void {
    this.jobType = null;
    this.jobPhase = "";
    this.idleUntil = this.now() + 2.5;
  }

  private handleCrash(): void {
    this.money = Math.max(0, this.money - CRASH_PENALTY);
    void this.ctx.playerData?.increment("heli-economy", "money", -CRASH_PENALTY);
    this.banner(`💥 CRASH! -$${CRASH_PENALTY}`, 2.5);
    // dropping cargo on a crash: hide whatever was being carried and clean up
    // any in-progress job state so a new one can start fresh
    this.setVisibleTag("carry-crate", false);
    this.setVisibleTag("carry-bucket", false);
    this.setVisibleTag("carry-wreckingball", false);
    if (this.pickupPad) this.setPoiBeacon(this.pickupPad.id, false);
    if (this.dropoffPad) this.setPoiBeacon(this.dropoffPad.id, false);
    if (this.waterBuoyId) this.setPoiBeacon(this.waterBuoyId, false);
    if (this.fireId) this.setPoiBeacon(this.fireId, false);
    if (this.demolitionId) this.setPoiBeacon(this.demolitionId, false);
    if (this.rescueId) this.setPoiBeacon(this.rescueId, false);
    this.endJob();
  }

  override onFixedUpdate(): void {
    const heli = this.ctx.getObject(this.heliId);
    if (!heli) return;

    // the sun's shadow camera is fixed in world space around wherever the
    // light entity sits — on an island this size that's a small, fixed patch
    // (it happened to land almost exactly on the Ridgeline cargo pad). Move
    // it toward the helicopter in coarse steps rather than every tick, so the
    // reposition itself stays cheap; the shadow map re-renders every frame
    // regardless (see the onStart note — throttling THAT broke shadows
    // outright, so we eat that cost for now).
    const sun = this.ctx.getObject("sun");
    if (sun && heli.position.distanceToSquared(this.lastSunUpdatePos) > SUN_UPDATE_DISTANCE_SQ) {
      sun.position.set(heli.position.x, this.sunHeight, heli.position.z);
      this.lastSunUpdatePos.copy(heli.position);
    }

    if (heli.userData.crashed) {
      this.handleCrash();
      return;
    }

    if (!this.jobType) {
      if (this.now() >= this.idleUntil) this.startNextJob();
      this.render();
      return;
    }

    if (this.jobType === "delivery") this.tickDelivery();
    else if (this.jobType === "firefighting") this.tickFirefighting();
    else if (this.jobType === "demolition") this.tickDemolition();
    else if (this.jobType === "rescue") this.tickRescue();

    this.render();
  }

  private tickDelivery(): void {
    if (!this.pickupPad || !this.dropoffPad) return;
    if (this.jobPhase === "pickup") {
      if (this.dist(this.pickupPad.id) < PICKUP_RADIUS) {
        this.setVisible(`${this.pickupPad.id}:crate`, false);
        this.setPoiBeacon(this.pickupPad.id, false);
        this.setVisibleTag("carry-crate", true);
        this.jobPhase = "dropoff";
        this.setPoiBeacon(this.dropoffPad.id, true);
        this.banner(`📦 now deliver it to ${this.dropoffPad.name}`, 3);
      }
    } else if (this.jobPhase === "dropoff") {
      if (this.dist(this.dropoffPad.id) < PICKUP_RADIUS) {
        this.setVisibleTag("carry-crate", false);
        this.setVisible(`${this.dropoffPad.id}:crate`, true);
        this.setPoiBeacon(this.dropoffPad.id, false);
        this.award("delivery");
        this.endJob();
      }
    }
  }

  private tickFirefighting(): void {
    if (this.jobPhase === "getwater") {
      if (this.dist(this.waterBuoyId) < PICKUP_RADIUS) {
        this.setVisibleTag("carry-bucket", true);
        this.jobPhase = "dump";
        this.banner("🔥 now dump it on the fire", 3);
      }
    } else if (this.jobPhase === "dump") {
      if (this.dist(this.fireId) < PICKUP_RADIUS) {
        this.setVisibleTag("carry-bucket", false);
        this.fireDumpsDone++;
        if (this.fireDumpsDone >= FIRE_DUMPS_NEEDED) {
          this.setVisible(`${this.fireId}:fire-fx`, false);
          this.setPoiBeacon(this.fireId, false);
          this.setPoiBeacon(this.waterBuoyId, false);
          this.award("firefighting");
          this.endJob();
        } else {
          this.jobPhase = "getwater";
          this.setPoiBeacon(this.waterBuoyId, true);
          this.banner("🔥 one more load of water needed!", 3);
        }
      }
    }
  }

  private tickDemolition(): void {
    if (this.dist(this.demolitionId) < DEMOLITION_RADIUS) {
      this.setVisible(`${this.demolitionId}:intact`, false);
      this.setVisible(`${this.demolitionId}:rubble`, true);
      this.setPoiBeacon(this.demolitionId, false);
      this.setVisibleTag("carry-wreckingball", false);
      this.award("demolition");
      this.endJob();
    }
  }

  private tickRescue(): void {
    if (this.jobPhase === "rescue") {
      if (this.dist(this.rescueId) < RESCUE_RADIUS) {
        this.rescueDwell += 1 / 60;
        if (this.rescueDwell >= RESCUE_DWELL) {
          this.setVisible(`${this.rescueId}:victim`, false);
          this.setVisible(`${this.rescueId}:victim-head`, false);
          this.setPoiBeacon(this.rescueId, false);
          this.jobPhase = "return";
          this.banner("🚁 survivor aboard — return to the depot", 3);
        }
      } else {
        this.rescueDwell = 0;
      }
    } else if (this.jobPhase === "return") {
      if (this.distToPoint(DEPOT_POS) < DEPOT_RADIUS) {
        this.award("rescue");
        this.endJob();
      }
    }
  }

  private jobLine(): string {
    if (!this.jobType) return "🛰️ dispatch standing by — a new job will come in shortly";
    if (this.jobType === "delivery") {
      return this.jobPhase === "pickup"
        ? `📦 pick up cargo at ${this.pickupPad?.name}`
        : `📦 deliver cargo to ${this.dropoffPad?.name}`;
    }
    if (this.jobType === "firefighting") {
      return this.jobPhase === "getwater"
        ? "🔥 scoop water from the glowing buoy"
        : `🔥 dump water on the fire (${this.fireDumpsDone}/${FIRE_DUMPS_NEEDED})`;
    }
    if (this.jobType === "demolition") return "🏗️ swing the wrecking ball into the marked building";
    return this.jobPhase === "rescue" ? "🚁 hover over the survivor" : "🚁 fly the survivor to the depot";
  }

  private render(): void {
    if (!this.hud) return;
    const t = this.now();
    const line = t < this.toastUntil ? this.toast : this.jobLine();
    const moneyText = this.moneyReady ? `$${Math.round(this.money)}` : "…";
    this.hud.innerHTML =
      `<div style="font-size:18px">💰 ${moneyText}</div>` +
      `<div style="margin-top:4px">${line}</div>` +
      `<div style="font-size:11px;font-weight:500;color:#8b949e;margin-top:6px">` +
      `WASD fly · Space/Ctrl up-down · Shift boost · mouse look</div>`;
  }
}
