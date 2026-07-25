import * as THREE from "three/webgpu";

interface Entry {
  light: THREE.PointLight;
  importance: number;
  distanceSq: number;
}

function belongsToScene(object: THREE.Object3D, scene: THREE.Scene): boolean {
  let current: THREE.Object3D | null = object;
  while (current?.parent) current = current.parent;
  return current === scene;
}

function ancestorsVisible(object: THREE.Object3D): boolean {
  let current = object.parent;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

/**
 * Camera-relative cap for forward-rendered point lights. Three evaluates the
 * active light set in every affected material; dozens of decorative lights
 * can dominate fragment cost even when none casts a shadow. Registration is
 * build-time, while detached/rebuilt lights are pruned lazily against the
 * current scene so streamed content needs no per-frame scene traversal.
 */
export class LightBudgetSystem {
  private readonly lights = new Set<THREE.PointLight>();
  private readonly cameraPosition = new THREE.Vector3();
  private active = 0;

  constructor(private maxPointLights = 8) {}

  setMaxPointLights(max: number): void {
    this.maxPointLights = Math.max(0, Math.floor(max));
  }

  register(light: THREE.Light, importance = 1): void {
    if (!(light instanceof THREE.PointLight)) return;
    light.userData["lightImportance"] = importance;
    light.userData["runtimeEnabled"] ??= true;
    this.lights.add(light);
  }

  update(scene: THREE.Scene, camera: THREE.Camera): void {
    camera.getWorldPosition(this.cameraPosition);
    const candidates: Entry[] = [];
    for (const light of [...this.lights]) {
      if (!belongsToScene(light, scene)) {
        light.visible = false;
        this.lights.delete(light);
        continue;
      }
      const enabled = light.userData["runtimeEnabled"] !== false;
      if (!enabled || !ancestorsVisible(light)) {
        light.visible = false;
        continue;
      }
      const distanceSq = light.getWorldPosition(_lightPosition).distanceToSquared(this.cameraPosition);
      candidates.push({
        light,
        importance: Math.max(0.001, Number(light.userData["lightImportance"]) || 1),
        distanceSq,
      });
    }

    candidates.sort((a, b) => a.distanceSq / a.importance - b.distanceSq / b.importance);
    const allowed = Math.min(this.maxPointLights, candidates.length);
    for (let i = 0; i < candidates.length; i++) candidates[i]!.light.visible = i < allowed;
    this.active = allowed;
  }

  stats(): { registered: number; active: number; budget: number } {
    return { registered: this.lights.size, active: this.active, budget: this.maxPointLights };
  }
}

const _lightPosition = new THREE.Vector3();
