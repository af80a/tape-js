import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  type NodeTypes,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useNodesInitialized,
} from '@xyflow/react';
import { useEffect, useRef } from 'react';
import '@xyflow/react/dist/style.css';
import { StageNode } from './nodes/StageNode';
import { computeGraphLayout } from './GraphLayout';
import { ScopePanel } from './ScopePanel';
import { useAudioEngine } from '../../stores/audio-engine';

const nodeTypes: NodeTypes = {
  stage: StageNode,
};

const { nodes: initialNodes, edges: initialEdges } = computeGraphLayout();

function FitOnReady() {
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  const didFit = useRef(false);

  useEffect(() => {
    if (initialized && !didFit.current) {
      didFit.current = true;
      fitView({ padding: 0.05, maxZoom: 1.55 });
    }
  }, [initialized, fitView]);

  return null;
}

function LayoutFlow() {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges] = useEdgesState(initialEdges);
  const scopeOpen = useAudioEngine((s) => s.scopeOpen);

  return (
    <div className="graph-view">
      <div className="graph-view__canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          nodesConnectable={false}
          minZoom={0.45}
          maxZoom={1.9}
          fitView
          fitViewOptions={{ padding: 0.05, maxZoom: 1.55 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#171c22" gap={22} />
          <FitOnReady />
        </ReactFlow>
      </div>
      {scopeOpen && <ScopePanel />}
    </div>
  );
}

export function GraphView() {
  return (
    <ReactFlowProvider>
      <LayoutFlow />
    </ReactFlowProvider>
  );
}
