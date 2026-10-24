export interface Project {
  ownerId?: string | null;
  visibility?: "private" | "public" | "legacy_local";
  role?: "owner" | "editor" | "viewer" | "local_guest";
  canEdit?: boolean;
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
  bundleHash: string | null;
  origin: string;
  sourceRevisionId?: string;
  files: SourceFile[];
  directories?: string[];
  treeHash?: string;
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
  executionRole?:
    | "structural"
    | "statement"
    | "condition_test"
    | "ast_projection"
    | "synthetic"
    | null;
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
    completionContext?: string | null;
    certainty?: "exact" | "conservative" | null;
    reason?: string | null;
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
  symbolEnvironmentHash?: string;
  semantics?: SemanticModel | null;
  quality?: {
    schemaVersion: string;
    methods: MethodMetrics[];
    findings: CodeFinding[];
    findingsTruncated: boolean;
  } | null;
  optimizations?: OptimizationOpportunity[];
}
export interface OptimizationOpportunity {
  ruleId: string;
  ruleVersion: string;
  nodeId: string;
  methodId: string;
  receiverName: string;
  querySites: number;
  sourceRange: SourceRange;
  assumptions: string[];
}
export interface MethodMetrics {
  methodId: string;
  declarationId: string;
  entryNodeId: string;
  sourceRange: SourceRange;
  bodyLines: number;
  codeLines: number;
  statements: number;
  branchingScore: number;
  maxNesting: number;
  loops: number;
  maxLoopNesting: number;
  calls: number;
  asymptotic: string;
  asymptoticReason: string;
}
export interface CodeFinding {
  id: string;
  methodId: string;
  nodeId: string;
  severity: string;
  code: string;
  title: string;
  explanation: string;
  recommendation: string;
  expectedEffect: string;
  observed: number;
  threshold: number;
  sourceRange: SourceRange;
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
  elapsedMs?: number | null;
  caseId: string;
  input?: { id: string; name?: string; stdinUtf8: string; argv: string[] };
  verdict: string;
  reasons: string[];
  baseExecutions: Execution[];
  candidateExecutions: Execution[];
  difference?: unknown;
}
export interface Report {
  completed?: number;
  wallTimeMs?: number;
  interactive?: boolean;
  inputLines?: { id: string; text: string; eof: boolean }[];
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
export interface LiveRun {
  interactive: boolean;
  phase: string;
  inputOpen: boolean;
  stdoutUtf8: string;
  stderrUtf8: string;
  elapsedMs: number;
}
export interface Job {
  progress?: ComparisonProgress | null;
  cancelRequestedAt?: string | null;
  live?: LiveRun | null;
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
export interface ComparisonProgress {
  phase: string;
  finished: boolean;
  outcome?: string | null;
  reason?: string | null;
  total: number;
  completed: number;
  matched: number;
  elapsedMs: number;
  plannedRepeatCount: number;
  binding: {
    baseRevisionId?: string;
    candidateRevisionId?: string;
    suiteVersionId?: string;
    executionProfileId?: string;
  };
  cases: {
    caseId: string;
    name: string;
    status: string;
    baseObserved: number;
    candidateObserved: number;
    completed: boolean;
    elapsedMs: number | null;
    reasons: string[];
  }[];
}
export interface Proposal {
  compileExecution?: Execution | null;
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

export interface SymbolDefinition {
  id: string;
  declarationId?: string | null;
  kind: string;
  name: string;
  ownerId?: string | null;
  qualifiedName?: string | null;
  signature?: string | null;
  declaredType?: string | null;
  resolvedType?: string | null;
  external: boolean;
  externalKey?: string | null;
  sourceRange: SourceRange | null;
}
export interface SymbolReference {
  id: string;
  kind: string;
  name: string;
  sourceRange: SourceRange;
  enclosingCallableId?: string | null;
  resolution: string;
  targetIds: string[];
  resolvedType?: string | null;
  dispatch: string;
  runtimeTargetIds: string[];
  reason?: string | null;
}
export interface SemanticModel {
  schemaVersion: string;
  environment: {
    schemaVersion: string;
    resolverVersion: string;
    configVersion: string;
    jdkVersion: string;
    jdkVendor: string;
    environmentHash: string;
  };
  symbols: SymbolDefinition[];
  references: SymbolReference[];
  limitations: string[];
}
