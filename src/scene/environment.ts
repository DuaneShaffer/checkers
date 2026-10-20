import { DirectionalLight, HemisphereLight, PMREMGenerator, type Scene, type Texture, type WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export interface Lighting {
  key: DirectionalLight;
  setShadowQuality(mapSize: number, radius: number): void;
  /** Re-renders the PMREM environment, whose render-target contents a lost WebGL context discards. */
  rebuildEnvironment(): void;
  dispose(): void;
}

const SHADOW_EXTENT = 7.6;

function bakeRoomEnvironment(renderer: WebGLRenderer): Texture {
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envMap = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  return envMap;
}

export function createLighting(renderer: WebGLRenderer, scene: Scene, mapSize: number, radius: number): Lighting {
  let envMap = bakeRoomEnvironment(renderer);
  scene.environment = envMap;
  scene.environmentIntensity = 0.38;

  const key = new DirectionalLight('#ffe2bf', 3.4);
  key.position.set(-7, 7.5, 2.5);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  const cam = key.shadow.camera;
  cam.left = -SHADOW_EXTENT;
  cam.right = SHADOW_EXTENT;
  cam.top = SHADOW_EXTENT;
  cam.bottom = -SHADOW_EXTENT;
  cam.near = 4;
  cam.far = 22;
  key.shadow.bias = -0.0001;
  key.shadow.normalBias = 0.004;

  const rim = new DirectionalLight('#a9bdf5', 0.45);
  rim.position.set(6, 5, 8);

  const sky = new HemisphereLight('#fff1dd', '#2a1a10', 0.12);

  scene.add(key, key.target, rim, sky);

  const setShadowQuality = (size: number, r: number) => {
    key.shadow.radius = r;
    if (key.shadow.mapSize.x === size) return;
    key.shadow.mapSize.set(size, size);
    key.shadow.map?.dispose();
    key.shadow.map = null;
  };
  setShadowQuality(mapSize, radius);

  return {
    key,
    setShadowQuality,
    rebuildEnvironment() {
      const stale = envMap;
      envMap = bakeRoomEnvironment(renderer);
      scene.environment = envMap;
      stale.dispose();
    },
    dispose() {
      scene.remove(key, key.target, rim, sky);
      key.shadow.map?.dispose();
      envMap.dispose();
    },
  };
}
