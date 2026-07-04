"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  GameState,
  PlayerState,
  STATUS_COMMIT,
  STATUS_REVEAL,
  STATUS_WAITING,
} from "@/lib/serializer";

declare global {
  interface Window {
    advanceTime?: (ms?: number) => void;
  }
}

type FourGodsSceneProps = {
  game: { state: GameState } | null;
  myLock: string;
  previewSeats: number;
  lobbyCount: number;
  openRoomCount: number;
};

const PLAYER_COLORS = [0xd4523c, 0x2f74b8, 0xe2aa38, 0x4c9f68, 0x8b5fbf, 0xd46f9f];

function sameLock(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function activePlayerIndex(state: GameState | null) {
  if (!state) return -1;
  if (state.status === STATUS_REVEAL) return state.revealOrder[state.revealCursor] ?? -1;
  if (state.status === STATUS_COMMIT) return state.players.findIndex((p) => !p.hasCommitted);
  return -1;
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose());
    } else if (material) {
      material.dispose();
    }
  });
}

function makeMaterial(color: number, roughness = 0.72, metalness = 0.04) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function addCylinder(
  group: THREE.Group,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  color: number,
  position: THREE.Vector3,
  rotation?: THREE.Euler
) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 18),
    makeMaterial(color)
  );
  mesh.position.copy(position);
  if (rotation) mesh.rotation.copy(rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function makePerson(index: number, player: PlayerState, isYou: boolean, isBanker: boolean, isActive: boolean) {
  const group = new THREE.Group();
  const alive = player.survived;
  const base = alive ? PLAYER_COLORS[index % PLAYER_COLORS.length] : 0x87908a;
  const cloth = makeMaterial(base);
  const skin = makeMaterial(0xf0c7a2);
  const dark = makeMaterial(0x17211f);

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.62, 8, 16), cloth);
  body.position.y = 0.76;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 24, 18), skin);
  head.position.y = 1.27;
  head.castShadow = true;
  group.add(head);

  const face = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), dark);
  face.position.set(0, 1.29, -0.17);
  group.add(face);

  addCylinder(group, 0.045, 0.045, 0.48, base, new THREE.Vector3(-0.23, 0.75, 0), new THREE.Euler(0, 0, 0.35));
  addCylinder(group, 0.045, 0.045, 0.48, base, new THREE.Vector3(0.23, 0.75, 0), new THREE.Euler(0, 0, -0.35));
  addCylinder(group, 0.055, 0.055, 0.5, 0x263330, new THREE.Vector3(-0.08, 0.26, 0), new THREE.Euler(0.16, 0, 0));
  addCylinder(group, 0.055, 0.055, 0.5, 0x263330, new THREE.Vector3(0.08, 0.26, 0), new THREE.Euler(-0.16, 0, 0));

  const haloColor = isActive ? 0xffcc4d : isYou ? 0x5ee0a0 : isBanker ? 0xf2b84b : 0x6d7a75;
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(isActive ? 0.55 : 0.46, 0.025, 10, 40),
    new THREE.MeshStandardMaterial({
      color: haloColor,
      emissive: haloColor,
      emissiveIntensity: isActive || isYou ? 0.55 : 0.12,
      roughness: 0.4,
    })
  );
  halo.rotation.x = Math.PI / 2;
  halo.position.y = 0.04;
  group.add(halo);

  const commit = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.12, 0.12),
    new THREE.MeshStandardMaterial({
      color: player.hasCommitted ? 0x5ee0a0 : 0x4b5652,
      emissive: player.hasCommitted ? 0x2aaa6f : 0x000000,
      emissiveIntensity: player.hasCommitted ? 0.35 : 0,
    })
  );
  commit.position.set(-0.28, 1.02, -0.05);
  group.add(commit);

  const reveal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.09),
    new THREE.MeshStandardMaterial({
      color: player.hasRevealed ? 0xf2b84b : 0x4b5652,
      emissive: player.hasRevealed ? 0xb87920 : 0x000000,
      emissiveIntensity: player.hasRevealed ? 0.35 : 0,
    })
  );
  reveal.position.set(0.28, 1.02, -0.05);
  group.add(reveal);

  if (!alive) group.rotation.z = -0.16;
  return group;
}

function makeEmptySeat(index: number) {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.028, 8, 42),
    new THREE.MeshStandardMaterial({
      color: 0x9fa9a4,
      transparent: true,
      opacity: 0.62,
      roughness: 0.85,
    })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.04;
  group.add(ring);

  const marker = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.16, 0.12, 5),
    makeMaterial(PLAYER_COLORS[index % PLAYER_COLORS.length], 0.78)
  );
  marker.position.y = 0.11;
  marker.castShadow = true;
  group.add(marker);
  return group;
}

export function FourGodsScene({
  game,
  myLock,
  previewSeats,
  lobbyCount,
  openRoomCount,
}: FourGodsSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef({ game, myLock, previewSeats, lobbyCount, openRoomCount });

  useEffect(() => {
    snapshotRef.current = { game, myLock, previewSeats, lobbyCount, openRoomCount };
  }, [game, myLock, previewSeats, lobbyCount, openRoomCount]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xf4f6f3, 8, 14);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 4.7, 7.4);
    camera.lookAt(0, 0.55, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setClearColor(0xf4f6f3, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.replaceChildren(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const ambient = new THREE.HemisphereLight(0xffffff, 0x7d8a84, 2.1);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    keyLight.position.set(3.8, 6, 4.2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(5.4, 72),
      new THREE.MeshStandardMaterial({ color: 0xe7ece8, roughness: 0.86 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(9.5, 18, 0xc9d2cd, 0xdce3df);
    grid.position.y = 0.012;
    scene.add(grid);

    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(1.92, 2.12, 0.28, 6),
      new THREE.MeshStandardMaterial({ color: 0x263b37, roughness: 0.7, metalness: 0.08 })
    );
    table.position.y = 0.22;
    table.castShadow = true;
    table.receiveShadow = true;
    scene.add(table);

    const tableTop = new THREE.Mesh(
      new THREE.CylinderGeometry(1.82, 1.88, 0.05, 6),
      new THREE.MeshStandardMaterial({ color: 0x31564e, roughness: 0.82 })
    );
    tableTop.position.y = 0.39;
    tableTop.receiveShadow = true;
    scene.add(tableTop);

    const north = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.42, 4), makeMaterial(0xe6b74c));
    north.position.set(0, 0.5, -1.25);
    north.rotation.y = Math.PI / 4;
    scene.add(north);

    const actorRoot = new THREE.Group();
    scene.add(actorRoot);

    let lastSeatKey = "";
    let elapsed = 0;

    const rebuildActors = () => {
      const { game: currentGame, myLock: currentLock, previewSeats: seatsPreview } = snapshotRef.current;
      const state = currentGame?.state ?? null;
      const seatCount = state?.maxPlayers ?? seatsPreview;
      const key = JSON.stringify({
        seatCount,
        status: state?.status ?? "lobby",
        players: state?.players.map((p) => [
          p.lockScript,
          p.survived,
          p.hasCommitted,
          p.hasRevealed,
          p.revealedDirection,
        ]),
        myLock: currentLock,
        banker: state?.bankerIndex ?? -1,
        cursor: state?.revealCursor ?? -1,
      });
      if (key === lastSeatKey) return;
      lastSeatKey = key;

      actorRoot.clear();
      const active = activePlayerIndex(state);
      const radius = seatCount <= 2 ? 2.75 : seatCount <= 4 ? 3.05 : 3.28;
      for (let i = 0; i < seatCount; i++) {
        const player = state?.players[i];
        const actor = player
          ? makePerson(
              i,
              player,
              Boolean(currentLock && sameLock(player.lockScript, currentLock)),
              i === (state?.bankerIndex ?? -1),
              i === active
            )
          : makeEmptySeat(i);
        const angle = -Math.PI / 2 + (i / seatCount) * Math.PI * 2;
        actor.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
        actor.lookAt(0, 0.5, 0);
        actor.userData.baseY = actor.position.y;
        actor.userData.seed = i * 0.73;
        actorRoot.add(actor);
      }
    };

    const resize = () => {
      const rect = mount.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };

    const renderFrame = (deltaMs: number) => {
      elapsed += deltaMs / 1000;
      rebuildActors();

      const { game: currentGame, lobbyCount: rooms, openRoomCount: openRooms } = snapshotRef.current;
      const state = currentGame?.state ?? null;
      const pulse = state?.status === STATUS_WAITING ? openRooms : rooms;
      tableTop.rotation.y = elapsed * 0.08;
      north.position.y = 0.52 + Math.sin(elapsed * 1.6) * 0.035;
      north.scale.setScalar(1 + Math.min(5, pulse) * 0.018);

      for (const actor of actorRoot.children) {
        const seed = actor.userData.seed ?? 0;
        actor.position.y = (actor.userData.baseY ?? 0) + Math.sin(elapsed * 2 + seed) * 0.035;
      }

      renderer.render(scene, camera);
    };

    let raf = 0;
    let last = performance.now();
    const animate = (now: number) => {
      raf = requestAnimationFrame(animate);
      const delta = Math.min(50, now - last);
      last = now;
      renderFrame(delta);
    };

    resize();
    renderFrame(0);
    raf = requestAnimationFrame(animate);
    window.addEventListener("resize", resize);
    window.advanceTime = (ms = 1000 / 60) => {
      renderFrame(ms);
    };

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      delete window.advanceTime;
      disposeScene(scene);
      renderer.dispose();
      mount.replaceChildren();
    };
  }, []);

  return <div ref={mountRef} className="absolute inset-0" aria-hidden="true" />;
}
