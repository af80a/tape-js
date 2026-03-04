import type { Node, Edge } from '@xyflow/react';
import { STAGE_DEFS, type StageId } from '../../types/stages';

const KNOB_W = 60;
const KNOB_GAP = 6;
const NODE_CHROME = 42; // padding (20) + meters (10) + content gaps (12)
const MIN_NODE_W = 220;
const NODE_HEIGHT = 270;
const GAP_X = 28;
const GAP_Y = 48;

const ROW1: StageId[] = ['inputXfmr', 'recordAmp', 'recordEQ', 'bias', 'hysteresis', 'head'];
const ROW2: StageId[] = ['transport', 'noise', 'playbackEQ', 'playbackAmp', 'outputXfmr', 'output'];

const edgeStyle = {
  stroke: '#4f7773',
  strokeWidth: 1.7,
  strokeDasharray: '5 3',
  opacity: 0.62,
};

function estimateNodeWidth(id: StageId): number {
  const def = STAGE_DEFS[id];
  const numKnobs = Object.keys(def.params).length;
  const knobsWidth = numKnobs * (KNOB_W + KNOB_GAP);
  return Math.max(MIN_NODE_W, knobsWidth + NODE_CHROME);
}

export function computeGraphLayout() {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Compute per-node widths
  const row1Widths = ROW1.map(estimateNodeWidth);
  const row2Widths = ROW2.map(estimateNodeWidth);

  // Row 1: left → right, cumulative x positions
  const row1Xs: number[] = [];
  let x = 0;
  for (let i = 0; i < ROW1.length; i++) {
    row1Xs.push(x);
    x += row1Widths[i] + GAP_X;
  }
  const row1RightEdge = row1Xs[ROW1.length - 1] + row1Widths[ROW1.length - 1];

  for (let i = 0; i < ROW1.length; i++) {
    const id = ROW1[i];
    const def = STAGE_DEFS[id];
    nodes.push({
      id,
      type: 'stage',
      position: { x: row1Xs[i], y: 0 },
      data: { stageId: id, label: def.label, def },
    });
  }

  // Row 2: right → left (snake turn), aligned so transport's right edge = head's right edge
  const row2Xs: number[] = [];
  let x2 = row1RightEdge;
  for (let i = 0; i < ROW2.length; i++) {
    x2 -= row2Widths[i];
    row2Xs.push(x2);
    x2 -= GAP_X;
  }

  for (let i = 0; i < ROW2.length; i++) {
    const id = ROW2[i];
    const def = STAGE_DEFS[id];
    nodes.push({
      id,
      type: 'stage',
      position: { x: row2Xs[i], y: NODE_HEIGHT + GAP_Y },
      data: { stageId: id, label: def.label, def },
    });
  }

  // Edges
  const chain = [...ROW1, ...ROW2];
  for (let i = 0; i < chain.length - 1; i++) {
    const sourceId = chain[i];
    const targetId = chain[i + 1];
    const isCrossRow = sourceId === 'head';
    const isRow2 = ROW2.includes(sourceId as StageId);

    edges.push({
      id: `${sourceId}-${targetId}`,
      source: sourceId,
      target: targetId,
      sourceHandle: isCrossRow ? 'source-bottom' : isRow2 ? 'source-left' : 'source-right',
      targetHandle: isCrossRow ? 'target-top' : isRow2 ? 'target-right' : 'target-left',
      animated: true,
      style: edgeStyle,
    });
  }

  return { nodes, edges };
}
