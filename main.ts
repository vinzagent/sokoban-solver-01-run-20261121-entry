// Sokoban solver, room by room, push-optimal: a level is a hallway with
// independent rooms off it (a box pushed out of a door is lost), so the
// level optimum is the sum of the rooms' optima. Each room is solved with a
// breadth-first search over pushes, pruning dead squares and frozen 2x2
// blocks; the first solved state met is push-optimal. Work is budgeted by
// states, never by the clock, so two runs write identical bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DIRS: [number, number, string][] = [[0, -1, 'u'], [0, 1, 'd'], [-1, 0, 'l'], [1, 0, 'r']];
const ROOM_STATES = 250_000; // a room search's cap; rooms are drawn solvable inside it
const ROOM_RETRY = 1_000_000; // one retry cap for a room the first cap misses
const TOTAL_STATES = 4_000_000; // whole-run work budget, states across all rooms
let used = 0; // states spent so far this run

type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

function parse(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
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
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

// Squares a lone box can be pulled back from onto some goal, walls only.
function liveSquares(lv: Level): Uint8Array {
  const { w, wall, goals } = lv;
  const live = new Uint8Array(wall.length);
  const q = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let i = 0; i < q.length; i++) {
    const x = q[i]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        q.push(y);
      }
    }
  }
  return live;
}

// The squares the player reaches from `from` around walls and `occupied`,
// marked in `seen` with `stamp`; returns the region's lowest square.
function reach(lv: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = lv;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const a = p - w;
    const b = p + w;
    const c = p - 1;
    const d = p + 1;
    if (!wall[a] && !occupied[a] && seen[a] !== stamp) { seen[a] = stamp; stack[n++] = a; }
    if (!wall[b] && !occupied[b] && seen[b] !== stamp) { seen[b] = stamp; stack[n++] = b; }
    if (!wall[c] && !occupied[c] && seen[c] !== stamp) { seen[c] = stamp; stack[n++] = c; }
    if (!wall[d] && !occupied[d] && seen[d] !== stamp) { seen[d] = stamp; stack[n++] = d; }
  }
  return low;
}

// Whether the box just pushed to `t` sits in a frozen 2x2 block of walls
// and boxes holding a box off its goal.
function frozen(lv: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = lv;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if ((wall[a] || occupied[a]) && (wall[b] || occupied[b]) && (wall[c] || occupied[c]) && (wall[d] || occupied[d]) &&
      ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d]))) return true;
  }
  return false;
}

// The shortest walk from `from` to `to` around walls and boxes, lower LURD.
function walkTo(lv: Level, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const { w, wall } = lv;
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const q = [from];
  prev[from] = from;
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const n = p + dy * w + dx;
      if (wall[n] || occupied[n] || prev[n] !== -1) continue;
      prev[n] = p;
      how[n] = letter;
      q.push(n);
    }
  }
  if (prev[to] === -1) return '';
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

// Push-optimal solution of `lv` within `maxStates` states, or null. A state
// is the boxes' squares plus the player's reachable region, named by its
// lowest square; states expand in order of pushes made, so the first solved
// state met is optimal.
function solvePush(lv: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = lv;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(lv);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  const keyOf = (bs: number[], low: number): number => {
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };
  if (lv.boxes.some((b) => !live[b])) return null;
  const start = lv.boxes.slice().sort((a, b) => a - b);
  const qBoxes: number[][] = [start];
  const qPlayer: number[] = [lv.player];
  const parent: number[] = [-1];
  const index = new Map<number, number>();
  for (const b of start) occupied[b] = 1;
  index.set(keyOf(start, reach(lv, occupied, lv.player, seen, ++stamp, stack)), 0);
  for (const b of start) occupied[b] = 0;
  let found = solved(start) ? 0 : -1;
  for (let head = 0; found < 0 && head < qBoxes.length; head++) {
    const bs = qBoxes[head]!;
    for (const b of bs) occupied[b] = 1;
    reach(lv, occupied, qPlayer[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < bs.length && found < 0; bi++) {
      const b = bs[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const fz = frozen(lv, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        if (!fz) {
          next = bs.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(lv, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (fz || index.has(key)) continue;
        if (qBoxes.length >= maxStates) {
          for (const x of bs) occupied[x] = 0;
          used += qBoxes.length;
          return null;
        }
        index.set(key, qBoxes.length);
        qBoxes.push(next!);
        qPlayer.push(b);
        parent.push(head);
        if (solved(next!)) {
          found = qBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of bs) occupied[x] = 0;
  }
  used += qBoxes.length;
  if (found < 0) return null;
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = lv.player;
  let bs = start;
  for (const s of path) {
    const nb = qBoxes[s]!;
    const from = bs.find((b) => !nb.includes(b))!;
    const to = nb.find((b) => !bs.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of bs) occupied[b] = 1;
    moves += walkTo(lv, occupied, player, from - d);
    for (const b of bs) occupied[b] = 0;
    moves += dir[2];
    player = from;
    bs = nb;
  }
  return { pushes: path.length, moves };
}

// The level's rooms: cut the hallway's dead squares (the player's row, where
// a box reaches no goal) out of the floor; each remaining part holding boxes
// is a room. Null when the level is no set of rooms.
function roomsOf(lv: Level): { boxes: number[]; goals: number[]; done?: boolean }[] | null {
  const { w, wall, goals, boxes, player } = lv;
  const live = liveSquares(lv);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { boxes: number[]; goals: number[]; done?: boolean }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

function solveLevel(text: string): string {
  const lv = parse(text);
  const rooms = roomsOf(lv);
  if (rooms === null) {
    const s = solvePush(lv, ROOM_STATES);
    return s ? s.moves : '';
  }
  let player = lv.player;
  let moves = '';
  for (const room of rooms) {
    const wall2 = lv.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall2[b] = 1;
    }
    const sub: Level = {
      w: lv.w,
      h: lv.h,
      wall: wall2,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const cap = Math.min(ROOM_STATES, Math.max(0, TOTAL_STATES - used));
    let s = cap > 0 ? solvePush(sub, cap) : null;
    if (s === null && TOTAL_STATES - used > 0) s = solvePush(sub, Math.min(ROOM_RETRY, TOTAL_STATES - used));
    if (s === null) return '';
    moves += s.moves;
    player = endOf(lv.w, player, s.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
