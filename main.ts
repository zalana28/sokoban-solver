// sokoban-solver-01 entry: a push-optimal Sokoban solver.
//
// Idea. Every level this contest draws is a hallway with one to four small
// rooms off it, each room holding 3-4 boxes and as many goals, and a box
// pushed out of a room through its door can never come back, so the rooms
// are independent problems joined only by the player's walk between them.
// This program therefore splits a level into its rooms, solves each room
// push-optimally on its own, and concatenates the walks and pushes.
//
// A room is solved by A* over pushes. A state is the boxes' squares plus
// the player's reachable region (named by its lowest square: where exactly
// the player stands inside the region does not matter, only which pushes
// it can reach). The heuristic is the cheapest assignment of boxes to
// goals by walking distance ignoring boxes, which never overestimates:
// one push moves one box one square. Dead states are pruned two ways: a
// box on a dead square (one no pull-back from any goal reaches) and a
// frozen 2x2 block of walls and boxes holding a box off its goal. When
// A* runs out of its work budget, a plain breadth-first search over pushes
// takes over with the same pruning; both are deterministic, and no clock
// is read anywhere, so two runs write the same bytes.
//
// main.ts runs as `node /bot/main.ts` (Node 22): it reads every level
// under /input/<id>/level.txt and writes /output/<id>/solution.txt, the
// player's moves in LURD (a capital letter marks a push; the checker
// decides pushes by replay, so the case is cosmetic).
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One step: [dx, dy, walk letter, push letter]. */
const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

/** Work budgets: states, never seconds, so a run is reproducible. */
const ASTAR_BUDGET = 300_000;
const BFS_BUDGET = 250_000;

/** A parsed level: width, height, walls (1 wall), goals, boxes, player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever the text shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Walking distances from one square over open floor (walls only, boxes
 * ignored): -1 where no walk reaches.
 */
function walkDistances(w, wall, from) {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k].dy * w + DIRS[k].dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p] + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * Live squares: a square is live when a box on it can still be pushed
 * onto some goal. Computed backwards: from each goal, a box can be pulled
 * onto the square behind it when both that square and the one behind it
 * are open floor. A square no pull-back reaches is dead: a box there is
 * stuck forever, whatever the other boxes do.
 */
function liveSquares(w, wall, goals) {
  const live = new Uint8Array(wall.length);
  const queue = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k].dy * w + DIRS[k].dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || behind < 0 || behind >= wall.length) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The player's reachable region from `from` around walls and boxes,
 * marked in `seen` with `stamp`; returns its lowest square, which names
 * the region: any player square in the same region reaches the same pushes.
 */
function floodRegion(w, wall, occupied, from, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k].dy * w + DIRS[k].dx;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed onto `t` sits frozen in a 2x2 block of
 * walls and boxes holding a box off its goal: no push ever moves it again.
 */
function frozenBlock(w, wall, occupied, isGoal, t) {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (d >= wall.length) continue;
    if (
      !(
        (wall[a] || occupied[a]) &&
        (wall[b] || occupied[b]) &&
        (wall[c] || occupied[c]) &&
        (wall[d] || occupied[d])
      )
    )
      continue;
    if (
      (occupied[a] && !isGoal[a]) ||
      (occupied[b] && !isGoal[b]) ||
      (occupied[c] && !isGoal[c]) ||
      (occupied[d] && !isGoal[d])
    )
      return true;
  }
  return false;
}

/**
 * Cheapest assignment of boxes to goals by walking distance (each box to
 * a different goal), by branch and bound over the boxes in order. A push
 * moves one box one square, so the cheapest assignment never exceeds the
 * pushes still needed: the heuristic is admissible.
 */
function assignmentCost(boxes, dists) {
  const n = boxes.length;
  // Hardest boxes first: the ones with the fewest goals in reach.
  const order = boxes.map((b, i) => i);
  order.sort((a, b) => {
    const ra = dists.reduce((s, d) => s + (d[boxes[a]] >= 0 ? 1 : 0), 0);
    const rb = dists.reduce((s, d) => s + (d[boxes[b]] >= 0 ? 1 : 0), 0);
    return ra - rb;
  });
  let best = Infinity;
  const used = new Uint8Array(n);
  const assign = (k, cost) => {
    if (cost >= best) return;
    if (k === n) {
      best = cost;
      return;
    }
    const bi = order[k];
    for (let gj = 0; gj < n; gj++) {
      if (used[gj]) continue;
      const d = dists[gj][boxes[bi]];
      if (d < 0) continue;
      used[gj] = 1;
      assign(k + 1, cost + d);
      used[gj] = 0;
    }
  };
  assign(0, 0);
  return best;
}

/** A state's key: the region's lowest square, then the boxes' squares. */
function stateKey(boxes, low, size) {
  let k = low;
  for (const b of boxes) k = k * size + b;
  return k;
}

/** A binary heap of node indices, ordered by (f, h, insertion order). */
class Heap {
  constructor() {
    this.a = [];
    this.f = [];
    this.h = [];
  }
  get size() {
    return this.a.length;
  }
  push(node, f, h) {
    const a = this.a;
    const fs = this.f;
    const hs = this.h;
    let i = a.length;
    a.push(node);
    fs.push(f);
    hs.push(h);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fs[p] < f || (fs[p] === f && (hs[p] < h || (hs[p] === h && a[p] <= node)))) break;
      a[i] = a[p];
      fs[i] = fs[p];
      hs[i] = hs[p];
      i = p;
    }
    a[i] = node;
    fs[i] = f;
    hs[i] = h;
  }
  pop() {
    const a = this.a;
    const fs = this.f;
    const hs = this.h;
    const top = a[0];
    const last = a.pop();
    const lf = fs.pop();
    const lh = hs.pop();
    if (a.length > 0) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= a.length) break;
        if (
          c + 1 < a.length &&
          (fs[c + 1] < fs[c] ||
            (fs[c + 1] === fs[c] && (hs[c + 1] < hs[c] || (hs[c + 1] === hs[c] && a[c + 1] < a[c]))))
        )
          c++;
        if (lf < fs[c] || (lf === fs[c] && (lh < hs[c] || (lh === hs[c] && last <= a[c])))) break;
        a[i] = a[c];
        fs[i] = fs[c];
        hs[i] = hs[c];
        i = c;
      }
      a[i] = last;
      fs[i] = lf;
      hs[i] = lh;
    }
    return top;
  }
}

/**
 * The shortest walk from `from` to `to` around walls and boxes, in lower
 * LURD letters (first direction first on ties). Empty when already there.
 */
function walkTo(w, wall, occupied, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k].dy * w + DIRS[k].dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k].step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The player's square after playing `moves` (LURD, case aside) from `from`. */
function endSquare(w, from, moves) {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The push-optimal solution of one problem (a room, or a whole level):
 * {pushes, moves} (moves in LURD, capitals mark pushes), or null when the
 * search runs out of its work budget or the problem has no solution.
 * `astar` picks A* with the assignment heuristic; false is plain
 * breadth-first search over pushes with the same pruning.
 */
function solvePushes(prob, maxExpand, astar) {
  const { w, wall, goals } = prob;
  const size = wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const live = liveSquares(w, wall, goals);
  for (const b of prob.boxes) if (!live[b]) return null;
  if (prob.boxes.every((b) => isGoal[b])) return { pushes: 0, moves: '' };
  const dists = goals.map((g) => walkDistances(w, wall, g));

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // Nodes, in insertion order: the boxes (sorted), the player's square
  // after the push that made the node, the pushes so far, and the push
  // from the parent (box from -> to, direction index).
  const nodeBoxes = [prob.boxes.slice()];
  const nodePlayer = [prob.player];
  const nodeG = [0];
  const nodeParent = [-1];
  const nodeFrom = [-1];
  const nodeTo = [-1];
  const nodeDir = [-1];

  const startKey = (() => {
    for (const b of prob.boxes) occupied[b] = 1;
    const low = floodRegion(w, wall, occupied, prob.player, seen, ++stamp, stack);
    for (const b of prob.boxes) occupied[b] = 0;
    return stateKey(prob.boxes, low, size);
  })();
  const best = new Map();
  best.set(startKey, 0);
  const heap = new Heap();
  const h0 = astar ? assignmentCost(prob.boxes, dists) : 0;
  if (!Number.isFinite(h0)) return null;
  heap.push(0, h0, h0);

  let goalNode = -1;
  let expanded = 0;
  while (heap.size > 0 && goalNode < 0) {
    const ni = heap.pop();
    const boxes = nodeBoxes[ni];
    const g = nodeG[ni];
    if (best.get(stateKey(boxes, regionLowOf(ni), size)) < g) continue;
    if (expanded >= maxExpand) break;
    expanded++;
    if (boxes.every((b) => isGoal[b])) {
      goalNode = ni;
      break;
    }
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    floodRegion(w, wall, occupied, nodePlayer[ni], seen, here, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k].dy * w + DIRS[k].dx;
        const stand = b - d;
        const t = b + d;
        if (seen[stand] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, isGoal, t);
        let key = -1;
        let low = -1;
        let next = null;
        let h = 0;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          low = floodRegion(w, wall, occupied, b, mark, ++stamp, stack);
          key = stateKey(next, low, size);
          if (best.has(key) && best.get(key) <= g + 1) next = null;
          else if (astar) {
            h = assignmentCost(next, dists);
            if (!Number.isFinite(h)) next = null;
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (next === null) continue;
        best.set(key, g + 1);
        nodeBoxes.push(next);
        nodePlayer.push(b);
        nodeG.push(g + 1);
        nodeParent.push(ni);
        nodeFrom.push(b);
        nodeTo.push(t);
        nodeDir.push(k);
        heap.push(nodeBoxes.length - 1, g + 1 + h, h);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (goalNode < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, push.
  const path = [];
  for (let s = goalNode; s > 0; s = nodeParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = prob.player;
  let boxes = prob.boxes.slice();
  for (const s of path) {
    const from = nodeFrom[s];
    const to = nodeTo[s];
    const k = nodeDir[s];
    const d = DIRS[k].dy * w + DIRS[k].dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[k].push;
    player = from;
    boxes = boxes.map((b) => (b === from ? to : b));
    boxes.sort((a, b) => a - b);
  }
  return { pushes: path.length, moves };

  // The region's lowest square for node `ni`, recomputed from its boxes
  // and player square (used only to name the state for the stale check).
  function regionLowOf(ni) {
    const bs = nodeBoxes[ni];
    for (const b of bs) occupied[b] = 1;
    const low = floodRegion(w, wall, occupied, nodePlayer[ni], seen, ++stamp, stack);
    for (const b of bs) occupied[b] = 0;
    return low;
  }
}

/**
 * A level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room, with its boxes and goals. Null when the level is
 * no set of rooms: a box in the hallway, a goal cut off, or a room whose
 * boxes and goals do not match.
 */
function splitRooms(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k].dy * w + DIRS[k].dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  const withBoxes = rooms.filter((r) => r.boxes.length > 0);
  if (withBoxes.some((r) => r.boxes.length !== r.goals.length)) return null;
  return withBoxes;
}

/** Replay `moves` on a level: true when every box ends on a goal. */
function replayOk(level, moves) {
  const { w, wall, goals } = level;
  const isGoal = new Uint8Array(wall.length);
  for (const g of goals) isGoal[g] = 1;
  const box = new Uint8Array(wall.length);
  for (const b of level.boxes) box[b] = 1;
  let player = level.player;
  for (const ch of moves.toLowerCase()) {
    const k = ch === 'u' ? 0 : ch === 'd' ? 1 : ch === 'l' ? 2 : 3;
    const d = DIRS[k].dy * w + DIRS[k].dx;
    const next = player + d;
    if (wall[next]) return false;
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return false;
      box[next] = 0;
      box[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !isGoal[i]) return false;
  return true;
}

/**
 * One level's solution: split into rooms, solve each room push-optimally
 * in turn (the other rooms' boxes standing as walls), and join the moves.
 * Falls back to solving the whole level at once when it is no set of
 * rooms. Returns '' when a room cannot be solved: a valid, scoreless
 * answer is safer than an illegal move string.
 */
function solveLevel(text) {
  const level = parseLevel(text);
  const rooms = splitRooms(level);
  if (rooms === null) {
    const r = solvePushes(level, ASTAR_BUDGET, true) ?? solvePushes(level, BFS_BUDGET, false);
    return r !== null && replayOk(level, r.moves) ? r.moves : '';
  }
  let player = level.player;
  let boxes = level.boxes.slice();
  let moves = '';
  for (const room of rooms) {
    if (room.boxes.every((b) => room.goals.includes(b))) continue;
    const wall = level.wall.slice();
    for (const b of boxes) if (!room.boxes.includes(b)) wall[b] = 1;
    const sub = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushes(sub, ASTAR_BUDGET, true) ?? solvePushes(sub, BFS_BUDGET, false);
    if (solved === null) return '';
    moves += solved.moves;
    player = endSquare(level.w, player, solved.moves);
    boxes = boxes.filter((b) => !room.boxes.includes(b)).concat(room.goals);
    boxes.sort((a, b) => a - b);
  }
  return replayOk(level, moves) ? moves : '';
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
