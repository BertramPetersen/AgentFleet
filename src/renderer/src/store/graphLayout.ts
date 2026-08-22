import type { ProjectTask } from './projects';

/**
 * Layered DAG layout for a project's tickets — dependencies flow left to
 * right, so the diagram reads as a pipeline toward completion. Hand-rolled
 * (Sugiyama-lite: longest-path layering + two median-ordering passes) because
 * project graphs are small (tens of cards) and a bundled graph library would
 * cost megabytes for edge-routing quality nobody needs at this scale.
 *
 * Cycle-safe by construction: layering walks memoized longest paths with an
 * on-stack guard, so a cycle (which the dep editor refuses to create, but a
 * hand-written tasks.json could) degrades into a broken edge, never a hang.
 */

export type NodeState = 'waiting' | 'ready' | 'doing' | 'blocked' | 'review' | 'done';

export interface GraphNode {
  task: ProjectTask;
  state: NodeState;
  layer: number;
  row: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** The dependency is finished — the edge no longer holds anything back. */
  satisfied: boolean;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /** Cards that could start RIGHT NOW: ready and unassigned — the
   *  spin-up-concurrency signal. */
  readyNow: number;
}

export const NODE_W = 216;
export const NODE_H = 58;
const GAP_X = 72;
const GAP_Y = 18;
const PAD = 16;

export function nodeState(t: ProjectTask, byId: Map<string, ProjectTask>): NodeState {
  if (t.status === 'done') return 'done';
  if (t.status === 'doing') return 'doing';
  if (t.status === 'review') return 'review';
  if (t.status === 'blocked') return 'blocked';
  const depsDone = (t.dependsOn ?? []).every((d) => {
    const dep = byId.get(d);
    return !dep || dep.status === 'done'; // a foreign/deleted dep never freezes its dependents
  });
  return depsDone ? 'ready' : 'waiting';
}

export function layoutGraph(tasks: ProjectTask[]): GraphLayout {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Longest-path layering, memoized, with an on-stack set so cycles terminate.
  const layerOf = new Map<string, number>();
  const onStack = new Set<string>();
  const layer = (id: string): number => {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    if (onStack.has(id)) return 0; // cycle — break it here
    onStack.add(id);
    const t = byId.get(id);
    const deps = (t?.dependsOn ?? []).filter((d) => byId.has(d));
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((d) => layer(d))) + 1;
    onStack.delete(id);
    layerOf.set(id, value);
    return value;
  };
  for (const t of tasks) layer(t.id);

  // Group by layer, then two median passes to pull children toward parents.
  const layers = new Map<number, ProjectTask[]>();
  for (const t of tasks) {
    const l = layerOf.get(t.id) ?? 0;
    if (!layers.has(l)) layers.set(l, []);
    (layers.get(l) as ProjectTask[]).push(t);
  }
  const layerKeys = [...layers.keys()].sort((a, b) => a - b);
  const rowOf = new Map<string, number>();
  for (const k of layerKeys) {
    (layers.get(k) as ProjectTask[])
      .sort((a, b) => String(a.rank ?? '').localeCompare(String(b.rank ?? '')) || a.id.localeCompare(b.id))
      .forEach((t, i) => rowOf.set(t.id, i));
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const k of layerKeys.slice(1)) {
      const list = layers.get(k) as ProjectTask[];
      const median = (t: ProjectTask): number => {
        const parents = (t.dependsOn ?? []).filter((d) => byId.has(d)).map((d) => rowOf.get(d) ?? 0);
        return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : (rowOf.get(t.id) ?? 0);
      };
      list.sort((a, b) => median(a) - median(b) || a.id.localeCompare(b.id));
      list.forEach((t, i) => rowOf.set(t.id, i));
    }
  }

  const nodes: GraphNode[] = tasks.map((t) => {
    const l = layerOf.get(t.id) ?? 0;
    const r = rowOf.get(t.id) ?? 0;
    return {
      task: t,
      state: nodeState(t, byId),
      layer: l,
      row: r,
      x: PAD + l * (NODE_W + GAP_X),
      y: PAD + r * (NODE_H + GAP_Y)
    };
  });

  const edges: GraphEdge[] = [];
  for (const t of tasks) {
    for (const d of t.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      edges.push({ from: d, to: t.id, satisfied: byId.get(d)?.status === 'done' });
    }
  }

  const maxLayer = Math.max(0, ...nodes.map((n) => n.layer));
  const maxRows = Math.max(1, ...layerKeys.map((k) => (layers.get(k) as ProjectTask[]).length));
  return {
    nodes,
    edges,
    width: PAD * 2 + (maxLayer + 1) * NODE_W + maxLayer * GAP_X,
    height: PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y,
    readyNow: nodes.filter((n) => n.state === 'ready' && !n.task.assignee).length
  };
}

/** Everything transitively downstream of `id` — the dep editor uses this to
 *  refuse choices that would close a cycle. */
export function descendantsOf(id: string, tasks: ProjectTask[]): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (out.has(t.id)) continue;
      if ((t.dependsOn ?? []).some((d) => d === id || out.has(d))) {
        out.add(t.id);
        grew = true;
      }
    }
  }
  return out;
}
