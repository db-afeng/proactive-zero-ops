import dagre from '@dagrejs/dagre';
import { Button, ButtonGroup, Tooltip, TooltipContent, TooltipTrigger } from '@databricks/appkit-ui/react';
import {
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Focus, LocateFixed } from 'lucide-react';
import { useMemo } from 'react';

import type { AssessmentChange, AssessmentGraphEdge, AssessmentGraphNode, AssessmentImpact } from '@/lib/contracts';

import { operationLabel } from './impact-copy';

import '@xyflow/react/dist/style.css';

const NODE_WIDTH = 280;
const NODE_HEIGHT = 72;

interface GraphNodeData extends Record<string, unknown> {
  graphNode: AssessmentGraphNode;
  detail: string;
}

interface GraphEdgeData extends Record<string, unknown> {
  graphEdge: AssessmentGraphEdge;
}

type FlowNode = Node<GraphNodeData, 'impact'>;
type FlowEdge = Edge<GraphEdgeData, 'evidence'>;

export function ImpactGraph({
  nodes,
  edges,
  impacts,
  changes,
  selectedId,
  onSelect,
}: {
  nodes: AssessmentGraphNode[];
  edges: AssessmentGraphEdge[];
  impacts: AssessmentImpact[];
  changes: AssessmentChange[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const layout = useMemo(() => layoutGraph(nodes, edges, impacts, changes), [nodes, edges, impacts, changes]);
  return (
    <ReactFlowProvider>
      <div
        className="impact-graph-canvas relative h-[23rem] overflow-hidden rounded-sm border border-border bg-background"
        aria-label="Impact lineage graph"
      >
        <ReactFlow<FlowNode, FlowEdge>
          nodes={layout.nodes.map((node) => ({ ...node, selected: node.id === selectedId }))}
          edges={layout.edges.map((edge) => ({ ...edge, selected: edge.id === selectedId }))}
          nodeTypes={{ impact: ImpactNode }}
          edgeTypes={{ evidence: EvidenceEdge }}
          onNodeClick={(_event, node) => onSelect(node.id)}
          onEdgeClick={(_event, edge) => onSelect(edge.id)}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1.05 }}
          minZoom={0.35}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          elevateEdgesOnSelect
          proOptions={{ hideAttribution: true }}
        >
          <GraphControls changedNodeId={nodes.find((node) => node.role === 'changed')?.id} />
        </ReactFlow>
        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-4 gap-y-1.5 bg-background/90 px-2 py-1.5 text-xs text-muted-foreground">
          <LegendLine label="Observed lineage" />
          <LegendLine label="Proposed-code lineage" dashed />
        </div>
      </div>
    </ReactFlowProvider>
  );
}

function GraphControls({ changedNodeId }: { changedNodeId?: string }) {
  const flow = useReactFlow<FlowNode, FlowEdge>();
  return (
    <div className="absolute right-2 top-2 z-10">
      <ButtonGroup aria-label="Graph view controls">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Fit impact graph to view"
              onClick={() => void flow.fitView({ padding: 0.18, duration: 0 })}
            >
              <Focus aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Fit graph</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Centre graph on changed column"
              disabled={changedNodeId === undefined}
              onClick={() => {
                const node = changedNodeId === undefined ? undefined : flow.getNode(changedNodeId);
                if (node !== undefined) {
                  void flow.setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + NODE_HEIGHT / 2, {
                    zoom: 1,
                    duration: 0,
                  });
                }
              }}
            >
              <LocateFixed aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Centre on change</TooltipContent>
        </Tooltip>
      </ButtonGroup>
    </div>
  );
}

function ImpactNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.graphNode;
  const roleLabel = {
    changed: 'Proposed contract change',
    direct_break: 'Direct break',
    transitive_impact: 'Transitive impact',
    context: 'Supporting context',
    restricted: 'Restricted lineage',
  }[node.role];
  const roleClass = {
    changed: 'border-warning bg-warning/15',
    direct_break: 'border-destructive/50 bg-destructive/10',
    transitive_impact: 'border-destructive/60 bg-background',
    context: 'border-border bg-muted/30',
    restricted: 'border-dashed border-border bg-muted/30',
  }[node.role];
  const roleLabelClass = {
    changed: 'text-warning',
    direct_break: 'text-destructive',
    transitive_impact: 'text-destructive',
    context: 'text-muted-foreground',
    restricted: 'text-muted-foreground',
  }[node.role];
  return (
    <div
      className={`h-[72px] w-[280px] rounded-sm border px-3 py-2 text-left shadow-none ${roleClass} ${selected ? 'impact-node-selected' : ''}`}
      aria-label={`${roleLabel}: ${node.label}`}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-background !bg-muted-foreground" />
      <p className={`text-xs font-semibold uppercase tracking-wide ${roleLabelClass}`}>{roleLabel}</p>
      <p className="mt-0.5 truncate font-mono text-sm font-medium leading-5" title={node.label}>
        {node.label}
      </p>
      <p className="truncate text-xs leading-4 text-muted-foreground" title={data.detail}>
        {data.detail}
      </p>
      <Handle type="source" position={Position.Right} className="!size-2 !border-background !bg-muted-foreground" />
    </div>
  );
}

function EvidenceEdge(props: EdgeProps<FlowEdge>) {
  const [path] = getBezierPath(props);
  const evidence = props.data?.graphEdge;
  const proposed = evidence?.origin === 'proposed_code';
  return (
    <BaseEdge
      path={path}
      markerEnd={props.markerEnd}
      style={{
        stroke: props.selected ? 'var(--ring)' : 'var(--muted-foreground)',
        strokeWidth: props.selected ? 2.5 : 1.5,
        strokeDasharray: proposed ? '7 5' : undefined,
      }}
    />
  );
}

function LegendLine({ label, dashed = false }: { label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="24" height="8" aria-hidden="true">
        <line
          x1="1"
          x2="23"
          y1="4"
          y2="4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray={dashed ? '5 4' : undefined}
        />
      </svg>
      {label}
    </span>
  );
}

function layoutGraph(
  nodes: AssessmentGraphNode[],
  edges: AssessmentGraphEdge[],
  impacts: AssessmentImpact[],
  changes: AssessmentChange[]
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', ranksep: 112, nodesep: 18, marginx: 32, marginy: 36 });
  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of [...edges].reverse()) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  return {
    nodes: nodes.map((node) => {
      const position = graph.node(node.id) as { x: number; y: number } | undefined;
      const restrictedTarget =
        node.role === 'restricted' ? edges.find((edge) => edge.source === node.id)?.target : undefined;
      const restrictedTargetPosition =
        restrictedTarget === undefined ? undefined : (graph.node(restrictedTarget) as { y: number } | undefined);
      return {
        id: node.id,
        type: 'impact',
        position: {
          x: (position?.x ?? 0) - NODE_WIDTH / 2,
          y:
            node.role === 'restricted' && restrictedTargetPosition !== undefined
              ? restrictedTargetPosition.y - NODE_HEIGHT / 2 - 92
              : (position?.y ?? 0) - NODE_HEIGHT / 2,
        },
        data: { graphNode: node, detail: nodeDetail(node, impacts, changes) },
        ariaLabel: `${node.role.replaceAll('_', ' ')}: ${node.label}`,
      };
    }),
    edges: edges.map((edge) => ({
      id: edge.id,
      type: 'evidence',
      source: edge.source,
      target: edge.target,
      data: { graphEdge: edge },
      markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--muted-foreground)', width: 14, height: 14 },
      animated: false,
      ariaLabel: `${edge.origin.replaceAll('_', ' ')} ${edge.evidenceLevel} evidence`,
    })),
  };
}

function nodeDetail(node: AssessmentGraphNode, impacts: AssessmentImpact[], changes: AssessmentChange[]): string {
  if (node.role === 'restricted') return 'Hidden from your identity';
  if (node.changeId !== undefined) {
    const change = changes.find((candidate) => candidate.id === node.changeId);
    return change === undefined ? 'Proposed contract update' : `${change.beforeType} → ${change.afterType}`;
  }
  if (node.impactId !== undefined) {
    const impact = impacts.find((candidate) => candidate.id === node.impactId);
    if (impact !== undefined) {
      const evidence = impact.evidenceLevel === 'definition' ? 'definition evidence' : 'lineage evidence';
      return `${operationLabel(impact.operation)} · ${evidence}`;
    }
  }
  return node.role === 'context' ? 'Non-blocking lineage context' : 'Verified downstream impact';
}
