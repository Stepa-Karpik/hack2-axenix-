export interface Project {
  id: string;
  name: string;
  headRevisionId: string | null;
  originalRevisionId: string | null;
  updatedAt: string;
}
export interface SourceFile {
  path: string;
  canonicalText: string;
  content?: string;
  sourceHash: string;
}
export interface Revision {
  id: string;
  projectId: string;
  parentRevisionId: string | null;
  createdAt: string;
  bundleHash: string;
  origin: string;
  sourceRevisionId?: string;
  files: SourceFile[];
}
export interface SourceRange {
  filePath: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}
export interface GraphNode {
  id: string;
  revisionId: string;
  analysisId: string;
  methodId: string;
  kind: string;
  label: string;
  sourceRange: SourceRange | null;
  synthetic: boolean;
  editableFields: string[];
  allowedOperations?: string[];
  insertionPositions?: string[];
  editableFieldRanges?: Record<string, SourceRange>;
  parentId: string | null;
}
export interface Method {
  id: string;
  fullyQualifiedName: string;
  signature: string;
  sourceRange: SourceRange;
  entryNodeId: string;
}
export interface Graph {
  revisionId: string;
  analysisId: string;
  sourceMapVersion: string;
  methods: Method[];
  nodes: GraphNode[];
  edges: {
    id: string;
    source: string;
    target: string;
    kind: string;
    label: string | null;
  }[];
}
export interface Diagnostic {
  id: string;
  severity: string;
  code: string;
  message: string;
  sourceRange: SourceRange | null;
}
export interface Analysis {
  id: string;
  revisionId: string;
  parseStatus: string;
  compileStatus: string;
  diagnostics: Diagnostic[];
  graph: Graph | null;
  sourceMapVersion: string;
}
export interface Execution {
  outcome: string;
  stdoutUtf8?: string;
  stderrUtf8?: string;
  exitCode?: number;
  wallTimeMs?: number;
  truncated?: boolean;
}
export interface TestResult {
  caseId: string;
  input?: { id: string; name?: string; stdinUtf8: string; argv: string[] };
  verdict: string;
  reasons: string[];
  baseExecutions: Execution[];
  candidateExecutions: Execution[];
  difference?: unknown;
}
export interface Report {
  revisionId?: string;
  entryPoint?: string;
  argv?: string[];
  stdinUtf8?: string;
  outcome?: string;
  matched?: number;
  total?: number;
  coverageComplete?: boolean;
  inconclusiveReasons?: string[];
  baseRevisionId?: string;
  candidateRevisionId?: string;
  suiteVersionId?: string;
  executionProfileId?: string;
  testResults?: TestResult[];
  compileExecution?: Execution;
  runtimeExecution?: Execution;
  baseCompile?: Execution;
  candidateCompile?: Execution;
}
export interface Job {
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error?: { code?: string; message?: string } | null;
  result?: {
    analysisId?: string;
    comparisonId?: string;
    resultKind?: string;
    report?: Report;
  } | null;
}
export interface Proposal {
  id: string;
  jobId: string;
  baseRevisionId: string;
  candidateRevisionId?: string;
  status: string;
  intent: string;
  diff?: {
    filePath: string;
    before: string;
    after: string;
    startOffset: number;
    endOffset: number;
  }[];
  checks?: {
    parseStatus: string;
    compileStatus: string;
    verificationStatus: string;
  };
  diagnostics?: Diagnostic[];
  error?: { code?: string; message?: string };
}
export interface Layout {
  analysisId: string;
  methodId: string;
  sourceMapVersion: string;
  layoutVersion: number;
  positions: { nodeId: string; x: number; y: number }[];
  collapsedNodeIds: string[];
  viewport: { x: number; y: number; zoom: number };
}
