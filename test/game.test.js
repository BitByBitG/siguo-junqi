import test from "node:test";
import assert from "node:assert/strict";
import {
  BOARD,
  createArmy,
  resolveBattle,
  validateMove,
  validateSetup,
} from "../server/game.js";

test("每个阵营生成一套合法的 25 枚棋子", () => {
  for (const seat of ["north", "east", "south", "west"]) {
    const army = createArmy(seat);
    assert.equal(army.length, 25);
    assert.equal(new Set(army.map((piece) => piece.position)).size, 25);
    assert.deepEqual(validateSetup(army, seat), { ok: true });
    assert.equal(army.find((piece) => piece.type === "flag").position.includes(`${seat}-5-`), true);
  }
});

test("战斗大小、工兵排雷和炸弹同归于尽", () => {
  const piece = (type) => ({ type });
  assert.equal(resolveBattle(piece("commander"), piece("army")), "attacker");
  assert.equal(resolveBattle(piece("platoon"), piece("company")), "defender");
  assert.equal(resolveBattle(piece("engineer"), piece("mine")), "attacker");
  assert.equal(resolveBattle(piece("commander"), piece("mine")), "defender");
  assert.equal(resolveBattle(piece("bomb"), piece("commander")), "both");
  assert.equal(resolveBattle(piece("division"), piece("division")), "both");
  assert.equal(resolveBattle(piece("platoon"), piece("flag")), "attacker");
});

test("普通棋子可走直线铁路但不能转弯", () => {
  const room = {
    phase: "playing",
    turn: "north",
    mode: "ffa",
    pieces: [{ id: "a", owner: "north", type: "platoon", position: "north-0-0" }],
  };
  assert.equal(validateMove(room, "north", "north-0-0", "south-0-4").ok, true);
  assert.equal(validateMove(room, "north", "north-0-0", "north-4-4").ok, false);
});

test("工兵可在连通铁路上转弯，路径不能穿过棋子", () => {
  const room = {
    phase: "playing",
    turn: "north",
    mode: "ffa",
    pieces: [{ id: "a", owner: "north", type: "engineer", position: "north-0-0" }],
  };
  assert.equal(validateMove(room, "north", "north-0-0", "north-4-4").ok, true);
  for (const [index, position] of BOARD.railNeighbors.get("north-0-0").entries()) {
    room.pieces.push({ id: `block-${index}`, owner: "south", type: "platoon", position });
  }
  assert.equal(validateMove(room, "north", "north-0-0", "north-4-4").ok, false);
});

test("大本营中的棋子不能移动，行营中的敌军不能被攻击", () => {
  const room = {
    phase: "playing",
    turn: "north",
    mode: "ffa",
    pieces: [
      { id: "hq", owner: "north", type: "commander", position: "north-5-1" },
      { id: "a", owner: "north", type: "platoon", position: "north-1-0" },
      { id: "b", owner: "south", type: "platoon", position: "north-1-1" },
    ],
  };
  assert.equal(validateMove(room, "north", "north-5-1", "north-5-0").ok, false);
  assert.equal(BOARD.byId.get("north-1-1").kind, "camp");
  assert.equal(validateMove(room, "north", "north-1-0", "north-1-1").ok, false);
});

test("中央保留九点，并由第 1、3、5 列形成六条贯通直道", () => {
  assert.equal(BOARD.nodes.filter((node) => node.id.startsWith("center-")).length, 9);
  for (const seat of ["north", "east", "south", "west"]) {
    for (const col of [1, 3]) {
      assert.equal(BOARD.neighbors.get(`${seat}-0-${col}`).some((next) => next.startsWith("center-")), false);
    }
  }
  const room = {
    phase: "playing", turn: "north", mode: "ffa",
    pieces: [{ id: "a", owner: "north", type: "platoon", position: "north-0-0" }],
  };
  assert.equal(validateMove(room, "north", "north-0-0", "south-0-4").ok, true);
  room.pieces.push({ id: "block", owner: "east", type: "platoon", position: "center-1-0" });
  assert.equal(validateMove(room, "north", "north-0-0", "south-0-4").ok, false);
});

test("相邻两方边缘铁路通过唯一角点接成一条逻辑直道", () => {
  const seats = ["north", "east", "south", "west"];
  for (let index = 0; index < seats.length; index += 1) {
    const seat = seats[index];
    const leftSeat = seats[(index + 1) % seats.length];
    assert.equal(BOARD.neighbors.get(`${seat}-0-4`).includes(`${leftSeat}-0-0`), true);
    assert.equal(BOARD.neighbors.get(`${seat}-1-4`).includes(`${leftSeat}-1-0`), false);
  }
  const room = {
    phase: "playing", turn: "north", mode: "ffa",
    pieces: [{ id: "a", owner: "north", type: "platoon", position: "north-4-4" }],
  };
  assert.equal(validateMove(room, "north", "north-4-4", "east-4-0").ok, true);
  room.pieces.push({ id: "block", owner: "south", type: "platoon", position: "north-2-4" });
  assert.equal(validateMove(room, "north", "north-4-4", "east-4-0").ok, false);
});

test("每方最后一行与倒数第二行之间没有铁路", () => {
  for (const seat of ["north", "east", "south", "west"]) {
    for (let col = 0; col < 5; col += 1) {
      assert.equal(BOARD.railNeighbors.get(`${seat}-5-${col}`).length, 0);
      assert.equal(BOARD.neighbors.get(`${seat}-5-${col}`).includes(`${seat}-4-${col}`), true);
    }
  }
});

test("每方第三行第三列的中央行营不与铁路相连", () => {
  for (const seat of ["north", "east", "south", "west"]) {
    const position = `${seat}-2-2`;
    assert.equal(BOARD.byId.get(position).kind, "camp");
    assert.deepEqual(BOARD.railNeighbors.get(position), []);
  }
});
