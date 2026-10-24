package dev.javablueprints.engine;

import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Immutable boundary model. All offsets refer to canonical LF text in UTF-16 units. */
public final class EngineModel {
    private EngineModel() {}

    public record SourceBundle(String revisionId, Map<String, String> files) {
        public SourceBundle {
            Objects.requireNonNull(revisionId, "revisionId");
            files = Map.copyOf(files);
            if (files.isEmpty() || files.size() > 100) throw new IllegalArgumentException("Expected 1..100 source files");
            long bytes = 0;
            for (var entry : files.entrySet()) {
                String path = entry.getKey();
                if (!path.matches("[A-Za-z0-9_$.-]+(?:/[A-Za-z0-9_$.-]+)*\\.java")
                        || List.of(path.split("/")).contains("..") || List.of(path.split("/")).contains(".")) {
                    throw new IllegalArgumentException("Unsafe Java path");
                }
                String source = entry.getValue();
                if (source.indexOf('\r') >= 0 || source.startsWith("\uFEFF")) {
                    throw new IllegalArgumentException("Source must be canonical LF text without BOM");
                }
                bytes += source.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
            }
            if (bytes > 1024 * 1024) throw new IllegalArgumentException("Bundle exceeds 1 MiB");
        }
    }

    public record SourceRange(String filePath, int startOffset, int endOffset,
                              int startLine, int startColumn, int endLine, int endColumn) {}
    public record Diagnostic(String id, String severity, String code, String message, SourceRange sourceRange) {}
    public record Capability(String feature, String status, String reason) {}
    public record Declaration(String id, String filePath, String kind, String name,
                              String parentId, SourceRange sourceRange) {}
    public record Method(String id, String declarationId, String fullyQualifiedName, String signature,
                         SourceRange sourceRange, String entryNodeId, List<String> exitNodeIds) {
        public Method { exitNodeIds = List.copyOf(exitNodeIds); }
    }
    public record GraphNode(String id, String revisionId, String analysisId, String methodId,
                            String kind, String label, SourceRange sourceRange, String astBinding,
                            String parentId, boolean synthetic, List<String> editableFields,
                            Map<String, SourceRange> editableFieldRanges, List<String> allowedOperations,
                            List<String> insertionPositions, String executionRole) {
        public GraphNode {
            editableFields = List.copyOf(editableFields);
            editableFieldRanges = editableFieldRanges == null ? Map.of() : Map.copyOf(editableFieldRanges);
            allowedOperations = allowedOperations == null ? List.of() : List.copyOf(allowedOperations);
            insertionPositions = insertionPositions == null ? List.of() : List.copyOf(insertionPositions);
        }
        public GraphNode(String id, String revisionId, String analysisId, String methodId,
                         String kind, String label, SourceRange sourceRange, String astBinding,
                         String parentId, boolean synthetic, List<String> editableFields,
                         Map<String, SourceRange> editableFieldRanges) {
            this(id, revisionId, analysisId, methodId, kind, label, sourceRange, astBinding,
                    parentId, synthetic, editableFields, editableFieldRanges, List.of(), List.of(), null);
        }
        public GraphNode(String id, String revisionId, String analysisId, String methodId,
                         String kind, String label, SourceRange sourceRange, String astBinding,
                         String parentId, boolean synthetic, List<String> editableFields,
                         Map<String, SourceRange> editableFieldRanges, List<String> allowedOperations,
                         List<String> insertionPositions) {
            this(id, revisionId, analysisId, methodId, kind, label, sourceRange, astBinding,
                    parentId, synthetic, editableFields, editableFieldRanges, allowedOperations, insertionPositions, null);
        }
    }
    public record Edge(String id, String source, String target, String kind, String label, String completionContext) {}
    public record Graph(String revisionId, String analysisId, String sourceMapVersion,
                        List<Method> methods, List<GraphNode> nodes, List<Edge> edges) {
        public Graph { methods = List.copyOf(methods); nodes = List.copyOf(nodes); edges = List.copyOf(edges); }
    }
    public record Analysis(String id, String revisionId, String bundleHash, String analyzerVersion,
                           String parserVersion, String languageLevel, String parseStatus,
                           String compileStatus, String symbolStatus, String sourceMapVersion,
                           List<Diagnostic> diagnostics, List<Capability> coverage,
                           List<Declaration> declarations, Graph graph, String symbolEnvironmentHash,
                           SemanticModel semantics, QualityModel quality, List<OptimizationOpportunity> optimizations) {
        public Analysis {
            diagnostics = List.copyOf(diagnostics); coverage = List.copyOf(coverage); declarations = List.copyOf(declarations);
            semantics = semantics == null ? SemanticModel.empty() : semantics;
            quality = quality == null ? QualityModel.empty() : quality;
            optimizations = optimizations == null ? List.of() : List.copyOf(optimizations);
        }
        public Analysis(String id, String revisionId, String bundleHash, String analyzerVersion,
                        String parserVersion, String languageLevel, String parseStatus,
                        String compileStatus, String symbolStatus, String sourceMapVersion,
                        List<Diagnostic> diagnostics, List<Capability> coverage,
                        List<Declaration> declarations, Graph graph, String symbolEnvironmentHash,
                        SemanticModel semantics, QualityModel quality) {
            this(id, revisionId, bundleHash, analyzerVersion, parserVersion, languageLevel, parseStatus,
                    compileStatus, symbolStatus, sourceMapVersion, diagnostics, coverage, declarations,
                    graph, symbolEnvironmentHash, semantics, quality, null);
        }
        public Analysis(String id, String revisionId, String bundleHash, String analyzerVersion,
                        String parserVersion, String languageLevel, String parseStatus,
                        String compileStatus, String symbolStatus, String sourceMapVersion,
                        List<Diagnostic> diagnostics, List<Capability> coverage,
                        List<Declaration> declarations, Graph graph, String symbolEnvironmentHash,
                        SemanticModel semantics) {
            this(id, revisionId, bundleHash, analyzerVersion, parserVersion, languageLevel, parseStatus,
                    compileStatus, symbolStatus, sourceMapVersion, diagnostics, coverage, declarations,
                    graph, symbolEnvironmentHash, semantics, null);
        }
        public Analysis(String id, String revisionId, String bundleHash, String analyzerVersion,
                        String parserVersion, String languageLevel, String parseStatus,
                        String compileStatus, String symbolStatus, String sourceMapVersion,
                        List<Diagnostic> diagnostics, List<Capability> coverage,
                        List<Declaration> declarations, Graph graph) {
            this(id, revisionId, bundleHash, analyzerVersion, parserVersion, languageLevel, parseStatus,
                    compileStatus, symbolStatus, sourceMapVersion, diagnostics, coverage, declarations, graph, null, null);
        }
    }
    public record QualityModel(String schemaVersion, List<MethodMetrics> methods,
                               List<CodeFinding> findings, boolean findingsTruncated) {
        public QualityModel { methods = List.copyOf(methods); findings = List.copyOf(findings); }
        public static QualityModel empty() { return new QualityModel("quality-v1", List.of(), List.of(), false); }
    }
    /** Lexical/structural facts, not inferred runtime cost or a semantic-equivalence proof. */
    public record MethodMetrics(String methodId, String declarationId, String entryNodeId, SourceRange sourceRange,
                                int bodyLines, int codeLines, int statements, int branchingScore,
                                int maxNesting, int loops, int maxLoopNesting, int calls,
                                String asymptotic, String asymptoticReason) {}
    public record CodeFinding(String id, String methodId, String nodeId, String severity, String code,
                              String title, String explanation, String recommendation, String expectedEffect,
                              int observed, int threshold, SourceRange sourceRange) {}
    public record OptimizationOpportunity(String ruleId, String ruleVersion, String nodeId, String methodId,
                                           String receiverName, int querySites, SourceRange sourceRange,
                                           List<String> assumptions) {
        public OptimizationOpportunity { assumptions = List.copyOf(assumptions); }
    }
    public record SymbolEnvironment(String schemaVersion, String resolverVersion, String configVersion,
                                    String jdkVersion, String jdkVendor, String environmentHash) {}
    public record SemanticModel(String schemaVersion, SymbolEnvironment environment, List<Symbol> symbols,
                                List<Reference> references, List<String> limitations) {
        public SemanticModel {
            symbols = symbols == null ? List.of() : List.copyOf(symbols);
            references = references == null ? List.of() : List.copyOf(references);
            limitations = limitations == null ? List.of() : List.copyOf(limitations);
        }
        public static SemanticModel empty() { return new SemanticModel(null, null, List.of(), List.of(), List.of()); }
    }
    public record Symbol(String id, String declarationId, String kind, String name, String ownerId,
                         String qualifiedName, String signature, String declaredType, String resolvedType,
                         boolean external, String externalKey, SourceRange sourceRange) {}
    /** targetIds select compile-time declarations; runtimeTargetIds never imply a closed dispatch world. */
    public record Reference(String id, String kind, String name, SourceRange sourceRange,
                            String enclosingCallableId, String resolution, List<String> targetIds,
                            String resolvedType, String dispatch, List<String> runtimeTargetIds, String reason) {
        public Reference {
            targetIds = targetIds == null ? List.of() : List.copyOf(targetIds);
            runtimeTargetIds = runtimeTargetIds == null ? List.of() : List.copyOf(runtimeTargetIds);
        }
    }
    /** Typed operation payloads; no untyped AST or arbitrary graph mutation crosses this boundary. */
    public record EditCommand(String baseRevisionId, String analysisId, String methodId, String nodeId,
                              String operation, EditPayload payload, String intent) {}
    public sealed interface EditPayload permits ReplaceExpression, ReplaceStatement, InsertStatement, DeleteStatement,
            MoveStatement, WrapStatement, AddElse, RemoveElse, OptimizeMembership {}
    public record ReplaceExpression(String field, String expression) implements EditPayload {}
    public record ReplaceStatement(String source) implements EditPayload {}
    public record InsertStatement(String position, String source) implements EditPayload {}
    public record DeleteStatement() implements EditPayload {}
    public record MoveStatement(String targetNodeId, String position) implements EditPayload {}
    public record WrapStatement(String condition) implements EditPayload {}
    public record AddElse(String source) implements EditPayload {}
    public record RemoveElse() implements EditPayload {}
    public record OptimizeMembership() implements EditPayload {}
    public record TextChange(String filePath, int startOffset, int endOffset, String before, String after) {}
    public record Candidate(Map<String, String> files, List<TextChange> changes, String parseStatus,
                            String compileStatus, String verificationStatus, List<Diagnostic> diagnostics) {
        public Candidate { files = Map.copyOf(files); changes = List.copyOf(changes); diagnostics = List.copyOf(diagnostics); }
    }
    public static final class EngineException extends RuntimeException {
        private final String code;
        public EngineException(String code, String message) { super(message); this.code = code; }
        public String code() { return code; }
    }
}
