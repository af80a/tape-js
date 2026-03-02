import type { Node, Edge } from '@xyflow/react';
import { STAGE_DEFS, type StageId } from '../../types/stages';

const NODE_WIDTH = 232;
const NODE_HEIGHT = 214;
const GAP_X = 24;
const GAP_Y = 72;

const ROW1: StageId[] = ['inputXfmr', 'recordAmp', 'recordEQ', 'bias', 'hysteresis', 'head'];
const ROW2: StageId[] = ['transport', 'noise', 'playbackAmp', 'playbackEQ', 'outputXfmr', 'output'];

export function computeGraphLayout() {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  for (let i = 0; i < ROW1.length; i++) {
    const id = ROW1[i];
    const def = STAGE_DEFS[id];
    nodes.push({
      id,
      type: 'stage',
      position: { x: i * (NODE_WIDTH + GAP_X), y: 0 },
      data: { stageId: id, label: def.label, def },
    });
  }

  for (let i = 0; i < ROW2.length; i++) {
    const id = ROW2[i];
    const def = STAGE_DEFS[id];
    nodes.push({
      id,
      type: 'stage',
      position: { x: i * (NODE_WIDTH + GAP_X), y: NODE_HEIGHT + GAP_Y },
      data: { stageId: id, label: def.label, def },
    });
  }

  const chain = [...ROW1, ...ROW2];
  for (let i = 0; i < chain.length - 1; i++) {
    const sourceId = chain[i];
    const targetId = chain[i + 1];
    const isCrossRow = sourceId === 'head';

    edges.push({
      id: `${sourceId}-${targetId}`,
      source: sourceId,
      target: targetId,
      sourceHandle: isCrossRow ? 'bottom' : 'right',
      targetHandle: isCrossRow ? 'top' : 'left',
      animated: true,
      style: {
        stroke: '#4f7773',
        strokeWidth: 1.7,
        strokeDasharray: '5 3',
        opacity: 0.62,
      },
    });
  }

  return { initialNodes: nodes, initialEdges: edges };
}
