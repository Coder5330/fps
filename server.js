import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(__dirname, "public");
const indexFile = path.join(publicDirectory, "index.html");

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const TICK_RATE = 30;
const SNAPSHOT_RATE = 15;
const MAX_PLAYERS = 12;
const MAX_MESSAGE_SIZE = 2_048;
const MAGAZINE_SIZE = 32;

const clamp = (value, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, value));

const random = (minimum, maximum) =>
  minimum + Math.random() * (maximum - minimum);

const planarDistance = (a, b) =>
  Math.hypot(a.x - b.x, a.z - b.z);

const send = (socket, data) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
};

const server = http.createServer((request, response) => {
  const requestUrl = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`
  );

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });

    response.end(JSON.stringify({
      status: "ok",
      players: players.size,
      wave
    }));
    return;
  }

  if (
    request.method === "GET" &&
    (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html")
  ) {
    fs.readFile(indexFile, (error, content) => {
      if (error) {
        console.error("Unable to read public/index.html:", error);
        response.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8"
        });
        response.end("Unable to load the game.");
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin"
      });

      response.end(content);
    });

    return;
  }

  response.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end("Not found");
});

const websocketServer = new WebSocketServer({
  server,
  maxPayload: MAX_MESSAGE_SIZE,
  perMessageDeflate: false
});

const coverDefinitions = [
  [0, 0, 5, 3, 2.5],
  [-12, -9, 5, 2.5, 2.4],
  [12, 9, 5, 2.5, 2.4],
  [-12, 9, 2.5, 5, 2.4],
  [12, -9, 2.5, 5, 2.4],
  [-15, 1, 3, 3, 1.45],
  [15, -1, 3, 3, 1.45],
  [0, -15, 6, 2, 1.45],
  [0, 15, 6, 2, 1.45],
  [-5, 12, 2, 3.5, 1.7],
  [5, -12, 2, 3.5, 1.7]
];

const collisionBoxes = coverDefinitions.map(([x, z, width, depth, height]) => ({
  minX: x - width / 2,
  maxX: x + width / 2,
  minY: 0,
  maxY: height,
  minZ: z - depth / 2,
  maxZ: z + depth / 2
}));

collisionBoxes.push(
  {
    minX: -26,
    maxX: 26,
    minY: 0,
    maxY: 6,
    minZ: -26,
    maxZ: -25
  },
  {
    minX: -26,
    maxX: 26,
    minY: 0,
    maxY: 6,
    minZ: 25,
    maxZ: 26
  },
  {
    minX: -26,
    maxX: -25,
    minY: 0,
    maxY: 6,
    minZ: -26,
    maxZ: 26
  },
  {
    minX: 25,
    maxX: 26,
    minY: 0,
    maxY: 6,
    minZ: -26,
    maxZ: 26
  }
);

function isBlocked(x, z, radius) {
  if (
    Math.abs(x) > 24.5 - radius ||
    Math.abs(z) > 24.5 - radius
  ) {
    return true;
  }

  return collisionBoxes.some((box) => {
    const nearestX = clamp(x, box.minX, box.maxX);
    const nearestZ = clamp(z, box.minZ, box.maxZ);

    return (
      (x - nearestX) ** 2 +
      (z - nearestZ) ** 2 <
      radius ** 2
    );
  });
}

function moveEntity(entity, deltaX, deltaZ, radius) {
  let moved = false;

  if (!isBlocked(entity.x + deltaX, entity.z, radius)) {
    entity.x += deltaX;
    moved = true;
  }

  if (!isBlocked(entity.x, entity.z + deltaZ, radius)) {
    entity.z += deltaZ;
    moved = true;
  }

  return moved;
}

/**
 * Returns the intersection fraction along segment A→B.
 * Infinity means the segment did not intersect the box.
 */
function segmentBoxIntersection(a, b, box) {
  let minimumFraction = 0;
  let maximumFraction = 1;

  for (const axis of ["x", "y", "z"]) {
    const delta = b[axis] - a[axis];
    const axisName = axis.toUpperCase();
    const minimum = box[`min${axisName}`];
    const maximum = box[`max${axisName}`];

    if (Math.abs(delta) < 1e-9) {
      if (a[axis] < minimum || a[axis] > maximum) {
        return Infinity;
      }

      continue;
    }

    let first = (minimum - a[axis]) / delta;
    let second = (maximum - a[axis]) / delta;

    if (first > second) {
      [first, second] = [second, first];
    }

    minimumFraction = Math.max(minimumFraction, first);
    maximumFraction = Math.min(maximumFraction, second);

    if (minimumFraction > maximumFraction) {
      return Infinity;
    }
  }

  return minimumFraction;
}

function getWallIntersectionFraction(start, end) {
  let nearest = Infinity;

  for (const box of collisionBoxes) {
    nearest = Math.min(
      nearest,
      segmentBoxIntersection(start, end, box)
    );
  }

  return nearest;
}

function pointAlongSegment(start, end, fraction) {
  return {
    x: start.x + (end.x - start.x) * fraction,
    y: start.y + (end.y - start.y) * fraction,
    z: start.z + (end.z - start.z) * fraction
  };
}

let nextEntityId = 1;
let wave = 0;
let enemiesRemainingToSpawn = 0;
let spawnTimer = 0;
let nextWaveTimer = -1;
let rpgRespawnTimer = -1;
let snapshotCounter = 0;
let events = [];

const players = new Map();
let enemies = [];
let pickups = [];
let enemyBolts = [];
let rockets = [];

function emitEvent(type, x, y, z, extra = {}) {
  events.push({
    type,
    x,
    y,
    z,
    ...extra
  });
}

function addPickup(type, x, z, permanent = false) {
  pickups.push({
    id: nextEntityId++,
    type,
    x,
    z,
    life: permanent ? Infinity : 25
  });
}

function resetArena() {
  wave = 0;
  enemiesRemainingToSpawn = 0;
  spawnTimer = 0;
  nextWaveTimer = -1;
  rpgRespawnTimer = -1;
  enemies = [];
  pickups = [];
  enemyBolts = [];
  rockets = [];
  events = [];

  addPickup("rpg", 0, 3.2, true);
}

function getFreePosition(minimumPlayerDistance = 4, onEdge = false) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    let x;
    let z;

    if (onEdge) {
      const side = Math.floor(Math.random() * 4);
      const along = random(-21, 21);

      x = side < 2
        ? side === 0
          ? -21.5
          : 21.5
        : along;

      z = side >= 2
        ? side === 2
          ? -21.5
          : 21.5
        : along;
    } else {
      x = random(-20, 20);
      z = random(-20, 20);
    }

    if (isBlocked(x, z, 1.2)) {
      continue;
    }

    const tooCloseToPlayer = [...players.values()].some(
      (player) =>
        player.health > 0 &&
        Math.hypot(player.x - x, player.z - z) < minimumPlayerDistance
    );

    if (tooCloseToPlayer) {
      continue;
    }

    const tooCloseToEnemy = enemies.some(
      (enemy) =>
        Math.hypot(enemy.x - x, enemy.z - z) < 2.5
    );

    if (!tooCloseToEnemy) {
      return { x, z };
    }
  }

  return { x: -20, z: -20 };
}

function startWave() {
  wave += 1;

  enemiesRemainingToSpawn = Math.min(
    3 + wave * 2 + Math.max(0, players.size - 1) * 2,
    24
  );

  spawnTimer = 0.6;
  nextWaveTimer = -1;

  if (wave > 1) {
    for (const player of players.values()) {
      player.reserve = Math.min(240, player.reserve + 28);
    }

    for (const type of ["health", "ammo"]) {
      const position = getFreePosition();
      addPickup(type, position.x, position.z);
    }
  }

  emitEvent("wave", 0, 0, 0, { wave });
}

function spawnEnemy() {
  const position = getFreePosition(10, true);
  const maximumHealth = 46 + wave * 12;

  enemies.push({
    id: nextEntityId++,
    x: position.x,
    z: position.z,
    health: maximumHealth,
    maximumHealth,
    speed: Math.min(2.1 + wave * 0.16, 3.5),
    cooldown: random(0.8, 2),
    strafeDirection: Math.random() < 0.5 ? -1 : 1,
    stuckTimer: 0,
    color: (wave + enemiesRemainingToSpawn) % 3,
    yaw: 0
  });
}

function killEnemy(enemy, ownerId) {
  const enemyIndex = enemies.indexOf(enemy);

  if (enemyIndex === -1) {
    return;
  }

  enemies.splice(enemyIndex, 1);

  const owner = players.get(ownerId);
  if (owner) {
    owner.score += 100 + wave * 25;
  }

  emitEvent("kill", enemy.x, 1.2, enemy.z);

  const dropChance = Math.random();

  if (dropChance < 0.16) {
    addPickup("health", enemy.x, enemy.z);
  } else if (dropChance < 0.36) {
    addPickup("ammo", enemy.x, enemy.z);
  }
}

function hurtPlayer(player, amount) {
  if (
    player.health <= 0 ||
    player.invulnerableTimer > 0
  ) {
    return;
  }

  player.health = Math.max(0, player.health - amount);
  player.invulnerableTimer = 0.35;

  send(player.socket, { type: "hurt" });

  if (player.health === 0) {
    player.firing = false;
    emitEvent("down", player.x, 1, player.z);
    send(player.socket, { type: "down" });
  }
}

function getAimDirection(player) {
  const pitchCosine = Math.cos(player.pitch);

  return {
    x: -Math.sin(player.yaw) * pitchCosine,
    y: Math.sin(player.pitch),
    z: -Math.cos(player.yaw) * pitchCosine
  };
}

function fireWeapon(player) {
  if (
    player.health <= 0 ||
    player.weaponCooldown > 0 ||
    player.reloadTimer > 0
  ) {
    return;
  }

  const direction = getAimDirection(player);
  const start = {
    x: player.x,
    y: player.y + 1.65,
    z: player.z
  };

  if (player.hasRpg) {
    player.hasRpg = false;
    player.weaponCooldown = 0.6;
    rpgRespawnTimer = 18;

    rockets.push({
      id: nextEntityId++,
      x: start.x + direction.x * 0.65,
      y: start.y + direction.y * 0.65,
      z: start.z + direction.z * 0.65,
      directionX: direction.x,
      directionY: direction.y,
      directionZ: direction.z,
      ownerId: player.id,
      life: 2.8
    });

    send(player.socket, {
      type: "fired",
      weapon: "rpg"
    });

    return;
  }

  if (player.ammo <= 0) {
    if (player.reserve > 0) {
      player.reloadTimer = 1.32;
    }

    return;
  }

  player.ammo -= 1;
  player.weaponCooldown = 0.115;

  const end = {
    x: start.x + direction.x * 85,
    y: start.y + direction.y * 85,
    z: start.z + direction.z * 85
  };

  let nearestFraction = getWallIntersectionFraction(start, end);
  let targetEnemy = null;

  for (const enemy of enemies) {
    const intersection = segmentBoxIntersection(start, end, {
      minX: enemy.x - 0.55,
      maxX: enemy.x + 0.55,
      minY: 0,
      maxY: 2.3,
      minZ: enemy.z - 0.48,
      maxZ: enemy.z + 0.48
    });

    if (intersection < nearestFraction) {
      nearestFraction = intersection;
      targetEnemy = enemy;
    }
  }

  const impactFraction = Number.isFinite(nearestFraction)
    ? nearestFraction
    : 0.82;

  const impact = pointAlongSegment(start, end, impactFraction);

  emitEvent("tracer", start.x, start.y, start.z, {
    end: impact
  });

  send(player.socket, {
    type: "fired",
    weapon: "carbine"
  });

  if (targetEnemy) {
    targetEnemy.health -= 28;

    const killed = targetEnemy.health <= 0;

    send(player.socket, {
      type: "hit",
      kill: killed
    });

    emitEvent("hit", impact.x, impact.y, impact.z);

    if (killed) {
      killEnemy(targetEnemy, player.id);
    }
  } else if (Number.isFinite(nearestFraction)) {
    emitEvent("impact", impact.x, impact.y, impact.z);
  }

  if (player.ammo === 0 && player.reserve > 0) {
    player.reloadTimer = 1.32;
  }
}

function explodeRocket(x, y, z, ownerId) {
  emitEvent("explosion", x, y, z);

  const explosionCenter = { x, y, z };

  for (const enemy of [...enemies]) {
    const enemyCenter = {
      x: enemy.x,
      y: 1.3,
      z: enemy.z
    };

    const distance = Math.hypot(
      enemyCenter.x - x,
      enemyCenter.y - y,
      enemyCenter.z - z
    );

    if (distance > 5.4) {
      continue;
    }

    const protectedByCover =
      distance >= 0.8 &&
      getWallIntersectionFraction(explosionCenter, enemyCenter) < 0.99;

    if (!protectedByCover) {
      killEnemy(enemy, ownerId);
    }
  }
}

function updatePlayers(deltaTime) {
  for (const player of players.values()) {
    player.invulnerableTimer = Math.max(
      0,
      player.invulnerableTimer - deltaTime
    );

    player.weaponCooldown = Math.max(
      0,
      player.weaponCooldown - deltaTime
    );

    if (player.reloadTimer > 0) {
      player.reloadTimer -= deltaTime;

      if (player.reloadTimer <= 0) {
        const reloadAmount = Math.min(
          MAGAZINE_SIZE - player.ammo,
          player.reserve
        );

        player.ammo += reloadAmount;
        player.reserve -= reloadAmount;
        player.reloadTimer = 0;
      }
    }

    if (player.health <= 0) {
      continue;
    }

    const keys = player.keys;
    let forward =
      Number(keys.forward) -
      Number(keys.backward);

    let sideways =
      Number(keys.right) -
      Number(keys.left);

    const inputLength = Math.hypot(forward, sideways);

    if (inputLength > 0) {
      forward /= inputLength;
      sideways /= inputLength;

      const speed = keys.sprint ? 9.5 : 6.7;

      moveEntity(
        player,
        (
          -Math.sin(player.yaw) * forward +
          Math.cos(player.yaw) * sideways
        ) * speed * deltaTime,
        (
          -Math.cos(player.yaw) * forward -
          Math.sin(player.yaw) * sideways
        ) * speed * deltaTime,
        0.43
      );
    }

    if (keys.jump && player.y <= 0) {
      player.verticalVelocity = 7.3;
    }

    player.verticalVelocity -= 19 * deltaTime;
    player.y = Math.max(
      0,
      player.y + player.verticalVelocity * deltaTime
    );

    if (player.y === 0) {
      player.verticalVelocity = 0;
    }

    if (player.firing) {
      fireWeapon(player);
    }
  }
}

function updateEnemies(deltaTime) {
  const livingPlayers = [...players.values()].filter(
    (player) => player.health > 0
  );

  if (livingPlayers.length === 0) {
    return;
  }

  for (const enemy of enemies) {
    let target = livingPlayers[0];

    for (const player of livingPlayers) {
      if (
        planarDistance(enemy, player) <
        planarDistance(enemy, target)
      ) {
        target = player;
      }
    }

    const targetDistance = Math.max(
      0.001,
      planarDistance(enemy, target)
    );

    const directionX = (target.x - enemy.x) / targetDistance;
    const directionZ = (target.z - enemy.z) / targetDistance;

    enemy.yaw = Math.atan2(-directionX, -directionZ);

    let movementX =
      targetDistance > 5
        ? directionX
        : targetDistance < 3
          ? -directionX * 0.6
          : 0;

    let movementZ =
      targetDistance > 5
        ? directionZ
        : targetDistance < 3
          ? -directionZ * 0.6
          : 0;

    if (enemy.stuckTimer > 0.15) {
      movementX = -directionZ * enemy.strafeDirection;
      movementZ = directionX * enemy.strafeDirection;
    }

    for (const otherEnemy of enemies) {
      if (otherEnemy === enemy) {
        continue;
      }

      const separation = planarDistance(enemy, otherEnemy);

      if (separation > 0.001 && separation < 1.4) {
        movementX +=
          ((enemy.x - otherEnemy.x) / separation) * 0.6;

        movementZ +=
          ((enemy.z - otherEnemy.z) / separation) * 0.6;
      }
    }

    const movementLength = Math.hypot(movementX, movementZ);

    if (movementLength > 0.01) {
      const previousX = enemy.x;
      const previousZ = enemy.z;

      moveEntity(
        enemy,
        (movementX / movementLength) *
          enemy.speed *
          deltaTime,
        (movementZ / movementLength) *
          enemy.speed *
          deltaTime,
        0.55
      );

      const movementProgress = Math.hypot(
        enemy.x - previousX,
        enemy.z - previousZ
      );

      enemy.stuckTimer =
        movementProgress < enemy.speed * deltaTime * 0.28
          ? enemy.stuckTimer + deltaTime
          : Math.max(0, enemy.stuckTimer - deltaTime * 1.5);

      if (enemy.stuckTimer > 1.3) {
        enemy.strafeDirection *= -1;
        enemy.stuckTimer = 0.18;
      }
    }

    enemy.cooldown -= deltaTime;

    if (enemy.cooldown <= 0 && targetDistance < 21) {
      const start = {
        x: enemy.x,
        y: 1.7,
        z: enemy.z
      };

      const end = {
        x: target.x,
        y: target.y + 1.4,
        z: target.z
      };

      if (getWallIntersectionFraction(start, end) >= 1) {
        const magnitude = Math.hypot(
          end.x - start.x,
          end.y - start.y,
          end.z - start.z
        );

        enemyBolts.push({
          id: nextEntityId++,
          ...start,
          directionX: (end.x - start.x) / magnitude,
          directionY: (end.y - start.y) / magnitude,
          directionZ: (end.z - start.z) / magnitude,
          speed: 12 + Math.min(wave, 8),
          life: 3
        });

        emitEvent("enemyShot", enemy.x, 1.7, enemy.z);

        enemy.cooldown =
          Math.max(1.25, 2.55 - wave * 0.08) +
          Math.random() * 0.65;
      } else {
        enemy.cooldown = 0.35;
      }
    }

    if (targetDistance < 1.05) {
      hurtPlayer(target, 5 + Math.min(wave, 7));
    }
  }
}

function updateProjectiles(deltaTime) {
  for (
    let boltIndex = enemyBolts.length - 1;
    boltIndex >= 0;
    boltIndex -= 1
  ) {
    const bolt = enemyBolts[boltIndex];

    const start = {
      x: bolt.x,
      y: bolt.y,
      z: bolt.z
    };

    const end = {
      x: bolt.x + bolt.directionX * bolt.speed * deltaTime,
      y: bolt.y + bolt.directionY * bolt.speed * deltaTime,
      z: bolt.z + bolt.directionZ * bolt.speed * deltaTime
    };

    let nearestFraction = getWallIntersectionFraction(start, end);
    let victim = null;

    for (const player of players.values()) {
      if (player.health <= 0) {
        continue;
      }

      const intersection = segmentBoxIntersection(start, end, {
        minX: player.x - 0.43,
        maxX: player.x + 0.43,
        minY: player.y + 0.25,
        maxY: player.y + 1.85,
        minZ: player.z - 0.43,
        maxZ: player.z + 0.43
      });

      if (intersection < nearestFraction) {
        nearestFraction = intersection;
        victim = player;
      }
    }

    bolt.life -= deltaTime;

    if (nearestFraction <= 1 || bolt.life <= 0) {
      if (victim) {
        hurtPlayer(victim, 8 + Math.min(wave, 8));
      }

      enemyBolts.splice(boltIndex, 1);
    } else {
      Object.assign(bolt, end);
    }
  }

  for (
    let rocketIndex = rockets.length - 1;
    rocketIndex >= 0;
    rocketIndex -= 1
  ) {
    const rocket = rockets[rocketIndex];

    const start = {
      x: rocket.x,
      y: rocket.y,
      z: rocket.z
    };

    const end = {
      x: rocket.x + rocket.directionX * 30 * deltaTime,
      y: rocket.y + rocket.directionY * 30 * deltaTime,
      z: rocket.z + rocket.directionZ * 30 * deltaTime
    };

    let nearestFraction = getWallIntersectionFraction(start, end);

    for (const enemy of enemies) {
      nearestFraction = Math.min(
        nearestFraction,
        segmentBoxIntersection(start, end, {
          minX: enemy.x - 0.55,
          maxX: enemy.x + 0.55,
          minY: 0,
          maxY: 2.3,
          minZ: enemy.z - 0.5,
          maxZ: enemy.z + 0.5
        })
      );
    }

    rocket.life -= deltaTime;

    if (nearestFraction <= 1 || rocket.life <= 0) {
      const impactFraction = nearestFraction <= 1
        ? Math.max(0, nearestFraction - 0.08)
        : 1;

      const impact = pointAlongSegment(
        start,
        end,
        impactFraction
      );

      explodeRocket(
        impact.x,
        impact.y,
        impact.z,
        rocket.ownerId
      );

      rockets.splice(rocketIndex, 1);
    } else {
      Object.assign(rocket, end);
    }
  }
}

function updatePickups(deltaTime) {
  for (
    let pickupIndex = pickups.length - 1;
    pickupIndex >= 0;
    pickupIndex -= 1
  ) {
    const pickup = pickups[pickupIndex];

    if (pickup.type !== "rpg") {
      pickup.life -= deltaTime;
    }

    for (const player of players.values()) {
      if (
        player.health <= 0 ||
        planarDistance(player, pickup) >= 1.2
      ) {
        continue;
      }

      let collected = false;

      if (pickup.type === "health" && player.health < 100) {
        player.health = Math.min(100, player.health + 32);
        collected = true;
      } else if (
        pickup.type === "ammo" &&
        player.reserve < 240
      ) {
        player.reserve = Math.min(240, player.reserve + 48);
        collected = true;
      } else if (
        pickup.type === "rpg" &&
        !player.hasRpg
      ) {
        player.hasRpg = true;
        collected = true;

        send(player.socket, {
          type: "pickup",
          item: "rpg"
        });
      }

      if (collected) {
        emitEvent("pickup", pickup.x, 0.8, pickup.z, {
          item: pickup.type
        });

        pickup.life = 0;
        break;
      }
    }

    if (pickup.life <= 0) {
      pickups.splice(pickupIndex, 1);
    }
  }
}

function createPlayer(socket) {
  const playerOffset = players.size;

  const player = {
    id: nextEntityId++,
    socket,
    x: playerOffset % 2 === 0 ? 0 : 2,
    y: 0,
    z: 8 + Math.floor(playerOffset / 2) * 2,
    verticalVelocity: 0,
    yaw: 0,
    pitch: 0,
    health: 100,
    ammo: MAGAZINE_SIZE,
    reserve: 160,
    score: 0,
    hasRpg: false,
    reloadTimer: 0,
    weaponCooldown: 0,
    invulnerableTimer: 0,
    firing: false,
    keys: {
      forward: false,
      backward: false,
      left: false,
      right: false,
      sprint: false,
      jump: false
    },
    lastMessageTime: Date.now()
  };

  if (isBlocked(player.x, player.z, 0.5)) {
    const position = getFreePosition();
    player.x = position.x;
    player.z = position.z;
  }

  return player;
}

websocketServer.on("connection", (socket) => {
  if (players.size >= MAX_PLAYERS) {
    socket.close(1013, "Arena full");
    return;
  }

  if (players.size === 0) {
    resetArena();
  }

  const player = createPlayer(socket);
  players.set(player.id, player);

  send(socket, {
    type: "hello",
    id: player.id
  });

  if (wave === 0) {
    startWave();
  }

  socket.on("message", (rawMessage) => {
    // Basic per-player input throttling.
    const now = Date.now();

    if (now - player.lastMessageTime < 8) {
      return;
    }

    player.lastMessageTime = now;

    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      return;
    }

    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "input") {
      if (Number.isFinite(message.yaw)) {
        player.yaw = clamp(message.yaw, -1_000_000, 1_000_000);
      }

      if (Number.isFinite(message.pitch)) {
        player.pitch = clamp(message.pitch, -1.47, 1.47);
      }

      const keys =
        message.keys && typeof message.keys === "object"
          ? message.keys
          : {};

      player.keys = {
        forward: keys.forward === true,
        backward: keys.backward === true,
        left: keys.left === true,
        right: keys.right === true,
        sprint: keys.sprint === true,
        jump: keys.jump === true
      };

      player.firing = message.firing === true;
      return;
    }

    if (
      message.type === "reload" &&
      player.health > 0 &&
      player.reloadTimer <= 0 &&
      player.ammo < MAGAZINE_SIZE &&
      player.reserve > 0
    ) {
      player.reloadTimer = 1.32;
      return;
    }

    if (
      message.type === "respawn" &&
      player.health <= 0
    ) {
      const position = getFreePosition(5);

      player.x = position.x;
      player.z = position.z;
      player.y = 0;
      player.verticalVelocity = 0;
      player.health = 100;
      player.ammo = MAGAZINE_SIZE;
      player.reserve = 160;
      player.hasRpg = false;
      player.reloadTimer = 0;
      player.weaponCooldown = 0;
      player.invulnerableTimer = 2;
      player.firing = false;

      send(socket, { type: "respawned" });
    }
  });

  socket.on("close", () => {
    players.delete(player.id);

    if (players.size === 0) {
      resetArena();
    }
  });

  socket.on("error", (error) => {
    console.warn(`WebSocket error for player ${player.id}:`, error.message);
  });
});

function broadcastSnapshot() {
  const snapshot = {
    type: "snapshot",
    wave,
    players: [...players.values()].map((player) => ({
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      health: player.health,
      ammo: player.ammo,
      reserve: player.reserve,
      score: player.score,
      hasRpg: player.hasRpg,
      reloadTimer: player.reloadTimer
    })),
    enemies: enemies.map((enemy) => ({
      id: enemy.id,
      x: enemy.x,
      z: enemy.z,
      yaw: enemy.yaw,
      health: enemy.health,
      maximumHealth: enemy.maximumHealth,
      color: enemy.color
    })),
    pickups: pickups.map((pickup) => ({
      id: pickup.id,
      x: pickup.x,
      z: pickup.z,
      type: pickup.type
    })),
    bolts: enemyBolts.map((bolt) => ({
      id: bolt.id,
      x: bolt.x,
      y: bolt.y,
      z: bolt.z
    })),
    rockets: rockets.map((rocket) => ({
      id: rocket.id,
      x: rocket.x,
      y: rocket.y,
      z: rocket.z,
      directionX: rocket.directionX,
      directionY: rocket.directionY,
      directionZ: rocket.directionZ
    })),
    events
  };

  const payload = JSON.stringify(snapshot);

  for (const client of websocketServer.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }

  events = [];
}

let previousTick = performance.now();

const gameLoop = setInterval(() => {
  const now = performance.now();
  const deltaTime = clamp(
    (now - previousTick) / 1000,
    0,
    0.05
  );

  previousTick = now;

  if (players.size === 0) {
    return;
  }

  updatePlayers(deltaTime);

  if (enemiesRemainingToSpawn > 0) {
    spawnTimer -= deltaTime;

    if (spawnTimer <= 0) {
      spawnEnemy();
      enemiesRemainingToSpawn -= 1;
      spawnTimer = 0.48;
    }
  }

  updateEnemies(deltaTime);
  updateProjectiles(deltaTime);
  updatePickups(deltaTime);

  if (rpgRespawnTimer > 0) {
    rpgRespawnTimer -= deltaTime;

    if (rpgRespawnTimer <= 0) {
      const rpgAlreadyExists = pickups.some(
        (pickup) => pickup.type === "rpg"
      );

      const playerHasRpg = [...players.values()].some(
        (player) => player.hasRpg
      );

      if (!rpgAlreadyExists && !playerHasRpg) {
        addPickup("rpg", 0, 3.2, true);
        emitEvent("rpgRespawn", 0, 0.8, 3.2);
      }

      rpgRespawnTimer = -1;
    }
  }

  if (
    enemiesRemainingToSpawn === 0 &&
    enemies.length === 0
  ) {
    if (nextWaveTimer < 0) {
      nextWaveTimer = 3;
      emitEvent("clear", 0, 0, 0);
    } else {
      nextWaveTimer -= deltaTime;

      if (nextWaveTimer <= 0) {
        startWave();
      }
    }
  }

  snapshotCounter += 1;

  if (snapshotCounter >= TICK_RATE / SNAPSHOT_RATE) {
    snapshotCounter = 0;
    broadcastSnapshot();
  }
}, 1000 / TICK_RATE);

function shutdown(signal) {
  console.log(`${signal} received. Shutting down.`);

  clearInterval(gameLoop);

  for (const client of websocketServer.clients) {
    client.close(1001, "Server shutting down");
  }

  websocketServer.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });

  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Neon Breach listening on http://0.0.0.0:${PORT}`);
});