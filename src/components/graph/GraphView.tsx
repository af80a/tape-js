import { useCallback } from 'react';
import {
  ReactFlow,
  Background,
  type NodeTypes,
  type ReactFlowInstance,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { StageNode } from './nodes/StageNode';
import { computeGraphLayout } from './GraphLayout';
import { ScopePanel } from './ScopePanel';
import { useAudioEngine } from '../../stores/audio-engine';

const nodeTypes: NodeTypes = {
  stage: StageNode,
};

// Static layout — computed once, nodes read live state from the store
const { initialNodes, initialEdges } = computeGraphLayout();

export function GraphView() {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges] = useEdgesState(initialEdges);
  const scopeOpen = useAudioEngine((s) => s.scopeOpen);

  const handleInit = useCallback((instance: ReactFlowInstance) => {
    requestAnimationFrame(() => {
      instance.fitView({ padding: 0.08, duration: 450, maxZoom: 1.55 });
    });
  }, []);

  return (
    <div className="graph-view">
      <div className="graph-view__canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onInit={handleInit}
          nodesConnectable={false}
          minZoom={0.45}
          maxZoom={1.9}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#171c22" gap={22} />
        </ReactFlow>
      </div>
      {scopeOpen && <ScopePanel />}
    </div>
  );
}
