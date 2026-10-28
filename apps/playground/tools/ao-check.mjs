// Real-GPU regression for AO contact shading, sky and transparent cards.
// Run against an existing dev server: node tools/ao-check.mjs [--url http://localhost:5173] [--out <scratch-dir>]
// The fixture is served only inside this browser; it never loads or writes a project.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadPlaywright } from "./_playwright.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const base = arg("url", "http://localhost:5173").replace(/\/$/, "");
const out = arg("out", null) ?? fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-ao-check-"));
const rendererUrl = `/@fs/${fileURLToPath(new URL("../../../packages/render/src/renderer.ts", import.meta.url)).replaceAll("\\", "/")}`;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });
fs.mkdirSync(out, { recursive: true });

function difference(a, b, skyOnly = false) {
  let sum = 0, changed = 0, black = 0;
  const end = skyOnly ? 640 * 80 * 3 : a.length;
  for (let i = 0; i < end; i += 3) {
    const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    sum += delta;
    if (delta > 30) changed++;
    if (b[i] < 10 && b[i + 1] < 10 && b[i + 2] < 10) black++;
  }
  return { mean: sum / end, changed, black };
}

try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /GPU|WGSL|shader|pipeline/i.test(message.text())) errors.push(message.text());
  });
  await page.route("**/__ao_check", (route) => route.fulfill({
    contentType: "text/html", body: '<html><body style="margin:0"><canvas></canvas></body></html>',
  }));
  await page.goto(`${base}/__ao_check`);
  for (const reversedDepth of [true, false]) {
    const backend = await page.evaluate(async ({ rendererUrl, reversedDepth }) => {
      window.aoCheck?.engine.dispose();
      const source = await (await fetch(rendererUrl)).text();
      const threeUrl = source.match(/from\s*["']([^"']*three_webgpu[^"']*)["']/)?.[1];
      if (!threeUrl) throw new Error("Cannot resolve the renderer's Three.js import");
      const THREE = await import(threeUrl);
      const { EngineRenderer } = await import(rendererUrl);
      const engine = new EngineRenderer(document.querySelector("canvas"), { reversedDepth });
      const backend = await engine.init();
      engine.setSize(640, 480);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#9ab0ce");
      scene.add(new THREE.HemisphereLight(0xffffff, 0x778899, 3));
      const sun = new THREE.DirectionalLight(0xffffff, 2);
      sun.position.set(4, 8, 5);
      scene.add(sun);
      const material = new THREE.MeshStandardNodeMaterial({ color: 0xaaaaaa, roughness: 1 });
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), material);
      floor.rotation.x = -Math.PI / 2;
      scene.add(floor);
      const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
      cube.position.set(-1, 1, 0);
      scene.add(cube);
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
      sphere.position.set(2, 1, -1);
      scene.add(sphere);
      // A particle/decal card that contributes neither colour nor depth must
      // not leave an AO rectangle over the geometry and sky behind it.
      const card = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicNodeMaterial({
        color: 0xff0000, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      }));
      card.position.set(2, 2, 1);
      scene.add(card);
      const camera = new THREE.PerspectiveCamera(50, 640 / 480, 0.1, 100);
      camera.position.set(6, 5, 9);
      camera.lookAt(0, 1, 0);
      window.aoCheck = { engine, scene, camera, card };
      return backend;
    }, { rendererUrl, reversedDepth });
    assert.equal(backend, "webgpu", "This regression must exercise real WebGPU, not silently fall back");

    for (const denoise of [true, false]) {
      const images = {};
      for (const [name, enabled, card] of [["off", false, false], ["ao", true, false], ["card", true, true]]) {
        const state = await page.evaluate(async ({ enabled, card, denoise }) => {
          const p = window.aoCheck;
          p.card.visible = card;
          p.engine.setPostFx({ ao: { enabled, intensity: 1, radius: 0.5, samples: 16, denoise } });
          for (let i = 0; i < 8; i++) {
            p.engine.render(p.scene, p.camera);
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          return { plan: p.engine.postFxPlan(), degraded: p.engine.postFxDegraded() };
        }, { enabled, card, denoise });
        assert.deepEqual(state.degraded, [], "AO must render without silently disabling a pass");
        assert.equal(state.plan.includes("ao"), enabled);
        const file = path.join(out, `${reversedDepth ? "reversed" : "standard"}-${denoise ? "denoised" : "raw"}-${name}.png`);
        await page.locator("canvas").screenshot({ path: file });
        images[name] = await sharp(file).removeAlpha().raw().toBuffer();
      }
      const sky = difference(images.off, images.card, true);
      const contact = difference(images.off, images.ao);
      const invisible = difference(images.ao, images.card);
      assert.ok(sky.mean < 0.1 && sky.black === 0, `AO must leave the sky unchanged: ${JSON.stringify(sky)}`);
      assert.ok(contact.changed > 100 && contact.black === 0, `AO must add contact shading: ${JSON.stringify(contact)}`);
      assert.equal(invisible.mean, 0, `Invisible cards must leave every pixel unchanged: ${JSON.stringify(invisible)}`);
      console.log(JSON.stringify({ reversedDepth, denoise, sky, contact, invisible }));
    }
  }
  assert.deepEqual(errors, [], "The GPU must accept every generated shader and pipeline");
  console.log(`AO checks passed. Pictures: ${out}`);
} finally {
  await browser.close();
}
