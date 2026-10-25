// @ts-nocheck -- Node-only tests follow the existing application test convention.
import test from "node:test";
import assert from "node:assert/strict";
import {
  groupByMethod,
  routeNeighborhoodIndex,
  overviewDashPattern,
} from "./flowScene.ts";
import { RouteCrowdingIndex } from "./flowCrowding.ts";
import { placeManualFlow } from "./flowLayout.ts";

test("overview preserves conservative, provisional and limited dash semantics across zoom", () => {
  assert.deepEqual(overviewDashPattern("5 4", false, false, 0.1), [50, 40]);
  assert.deepEqual(overviewDashPattern(undefined, true, false, 0.2), [20, 20]);
  assert.deepEqual(overviewDashPattern(undefined, false, true, 0.1), [40, 40]);
  assert.deepEqual(overviewDashPattern("none", false, false, 0.1), []);
  assert.deepEqual(overviewDashPattern(undefined, false, false, 0.1), []);
  assert.deepEqual(overviewDashPattern("2, 3", false, false, 1), [2, 3]);
});

test("method grouping retains every node in original order and identity", () => {
  const nodes = [
    { id: "a", methodId: "one" },
    { id: "b", methodId: "two" },
    { id: "c", methodId: "one" },
  ];
  const groups = groupByMethod(nodes);
  assert.deepEqual([...groups.keys()], ["one", "two"]);
  assert.deepEqual(groups.get("one"), [nodes[0], nodes[2]]);
  assert.equal(groups.get("one")![0], nodes[0]);
});

test("spatial route neighborhood equals exhaustive predicate including negatives and strict boundaries", () => {
  const boxes = Array.from({ length: 600 }, (_, i) => ({
    id: String(i),
    x: (i % 30) * 125 - 2000,
    y: Math.floor(i / 30) * 125 - 1000,
  }));
  const query = routeNeighborhoodIndex(boxes);
  for (let i = 0; i < boxes.length; i += 17) {
    const own = [boxes[i], boxes[(i + 111) % boxes.length]];
    const expected = boxes.filter((box) =>
      own.some(
        (origin) =>
          Math.abs(origin.x - box.x) < 500 && Math.abs(origin.y - box.y) < 250,
      ),
    );
    assert.deepEqual(query(own), expected);
  }
});

test("indexed crowding preserves exact prior-route overlap scoring including long and zero segments", () => {
  const index = new RouteCrowdingIndex();
  const prior: { x: number; y: number }[][] = [];
  const score = (points: { x: number; y: number }[]) => {
    let total = 0;
    for (let i = 1; i < points.length; i++)
      for (const route of prior)
        for (let j = 1; j < route.length; j++) {
          const a = points[i - 1],
            b = points[i],
            c = route[j - 1],
            d = route[j];
          if (a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < 10)
            total += Math.max(
              0,
              Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) -
                Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)),
            );
          if (a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < 10)
            total += Math.max(
              0,
              Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) -
                Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)),
            );
        }
    return total;
  };
  let seed = 7123;
  const next = () =>
    ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % 2000) - 1000;
  for (let i = 0; i < 180; i++) {
    const x = next(),
      y = next(),
      right = i % 19 === 0 ? 100000 : next();
    const points = [
      { x, y },
      { x: right, y },
      { x: right, y: next() },
      { x: right, y: next() },
    ];
    assert.equal(index.score(points), score(points));
    prior.push(points);
    index.add(points);
  }
  assert.equal(
    index.score([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]),
    0,
  );
});

test("indexed manual placement preserves exhaustive collision and row shifting behavior", () => {
  const automatic = new Map(
    Array.from({ length: 350 }, (_, i) => [
      String(i),
      { x: ((i % 5) - 2) * 320, y: Math.floor(i / 5) * 128 },
    ]),
  );
  const manual = new Map([
    ["5", { x: -300, y: 10 }],
    ["19", { x: 70, y: 910 }],
    ["88", { x: 0, y: 1500 }],
  ]);
  const expected = new Map([...manual].filter(([id]) => automatic.has(id)));
  const rows = new Map<number, [string, { x: number; y: number }][]>();
  for (const [id, point] of automatic)
    if (!expected.has(id)) {
      const row = rows.get(point.y) ?? [];
      row.push([id, point]);
      rows.set(point.y, row);
    }
  let shift = 0;
  for (const [rank, members] of [...rows].sort(([a], [b]) => a - b)) {
    let y = rank + shift;
    while (
      members.some(([, p]) =>
        [...expected.values()].some(
          (other) =>
            p.x < other.x + 288 &&
            p.x + 288 > other.x &&
            y < other.y + 108 &&
            y + 108 > other.y,
        ),
      )
    )
      y += 128;
    shift = y - rank;
    for (const [id, point] of members) expected.set(id, { x: point.x, y });
  }
  assert.deepEqual(placeManualFlow(automatic, manual), expected);
});
