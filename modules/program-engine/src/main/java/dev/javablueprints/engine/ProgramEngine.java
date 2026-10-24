package dev.javablueprints.engine;

import com.github.javaparser.JavaParser;
import com.github.javaparser.JavaToken;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.stmt.*;
import dev.javablueprints.engine.EngineModel.*;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Source-first, side-effect-free Java 21 analysis. Never compiles or executes input programs. */
public final class ProgramEngine {
    public static final String VERSION = "engine-0.3.0";
    public static final String SOURCE_MAP_VERSION = "utf16-token-v1";
    public static SymbolEnvironment currentSymbolEnvironment() { return SemanticAnalyzer.environment(); }
    public static String currentSymbolEnvironmentHash() { return currentSymbolEnvironment().environmentHash(); }

    private JavaParser parser() {
        return new JavaParser(new ParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21)
                .setStoreTokens(true).setTabSize(1));
    }

    public Analysis inspect(SourceBundle bundle) { return analyze(bundle, UUID.randomUUID().toString()).analysis(); }

    /** Exact unchanged export; no pretty-printer is allowed to rewrite preserved source. */
    public Map<String, String> exportUnchanged(SourceBundle bundle) { return bundle.files(); }

    public Candidate propose(SourceBundle bundle, Analysis analysis, EditCommand command) {
        Objects.requireNonNull(command, "command");
        if (!bundle.revisionId().equals(command.baseRevisionId()) || !analysis.revisionId().equals(bundle.revisionId())
                || !analysis.id().equals(command.analysisId()) || !analysis.bundleHash().equals(bundleHash(bundle))
                || !SOURCE_MAP_VERSION.equals(analysis.sourceMapVersion()) || !VERSION.equals(analysis.analyzerVersion())) {
            throw failure("ANALYSIS_CONFLICT", "Command requires its exact revision and analysis binding");
        }
        if (!currentSymbolEnvironmentHash().equals(analysis.symbolEnvironmentHash())) {
            throw failure("ANALYSIS_CONFLICT", "Symbol environment changed; analysis must be refreshed");
        }
        if (!"valid".equals(analysis.parseStatus())) throw failure("INVALID_EDIT", "A parse-valid analysis is required");
        Parsed parsed = analyze(bundle, analysis.id());
        if (!analysis.graph().equals(parsed.analysis().graph())) throw failure("ANALYSIS_CONFLICT", "Graph binding differs from source");
        if (!Set.of("replace_expression", "insert_statement", "delete_statement").contains(command.operation())) {
            throw failure("UNSUPPORTED_OPERATION", "Operation is not implemented");
        }
        if (!Set.of("semantic_edit", "preserve_behavior").contains(command.intent())) throw failure("INVALID_EDIT", "Unknown intent");
        GraphNode selected = analysis.graph().nodes().stream().filter(n -> n.id().equals(command.nodeId())).findFirst()
                .orElseThrow(() -> failure("ANALYSIS_CONFLICT", "Node does not belong to this analysis"));
        if (!selected.methodId().equals(command.methodId())) throw failure("ANALYSIS_CONFLICT", "Node does not belong to the selected method");
        Node target = parsed.bindings().get(selected.id());
        TextChange change = switch (command.operation()) {
            case "replace_expression" -> {
                if (!(command.payload() instanceof ReplaceExpression payload)) throw failure("INVALID_EDIT", "Expected expression payload");
                yield replaceExpression(bundle, parsed, selected, target, payload);
            }
            case "insert_statement" -> {
                if (!(command.payload() instanceof InsertStatement payload)) throw failure("INVALID_EDIT", "Expected insertion payload");
                yield insertStatement(parsed, selected, target, payload);
            }
            case "delete_statement" -> {
                if (!(command.payload() instanceof DeleteStatement)) throw failure("INVALID_EDIT", "Expected deletion payload");
                yield deleteStatement(bundle, parsed, selected, target);
            }
            default -> throw failure("UNSUPPORTED_OPERATION", "Operation is not implemented");
        };
        String source = bundle.files().get(change.filePath());
        Map<String, String> files = new TreeMap<>(bundle.files());
        files.put(change.filePath(), source.substring(0, change.startOffset()) + change.after() + source.substring(change.endOffset()));
        Analysis candidate = inspect(new SourceBundle(UUID.randomUUID().toString(), files));
        if (!"valid".equals(candidate.parseStatus())) throw failure("INVALID_EDIT", "Candidate does not parse in its project context");
        return new Candidate(files, List.of(change), "valid", "not_requested", "unverified", candidate.diagnostics());
    }

    private TextChange replaceExpression(SourceBundle bundle, Parsed parsed, GraphNode selected, Node target, ReplaceExpression payload) {
        if (payload == null || payload.expression() == null || payload.expression().isBlank()) throw failure("INVALID_EDIT", "Replacement expression is required");
        Expression expression;
        if ("condition".equals(payload.field())) {
            expression = condition(target);
            if (expression == null) throw failure("INVALID_EDIT", "Node has no editable condition");
        } else if ("expression".equals(payload.field()) && target instanceof Expression expr) {
            expression = expr;
        } else throw failure("INVALID_EDIT", "Target must be an expression or a supported condition");
        if (!selected.editableFields().contains(payload.field())) throw failure("UNSUPPORTED_OPERATION", "Expression is outside editable scope");
        var replacement = parser().parseExpression(payload.expression());
        if (!replacement.isSuccessful() || replacement.getResult().isEmpty()) throw failure("INVALID_EDIT", "Replacement must parse as one Java expression");
        if (containsComment(expression)) throw failure("UNSUPPORTED_OPERATION", "Replacement would discard an internal comment");
        String path = selected.sourceRange().filePath();
        SourceRange range = parsed.maps().get(path).range(expression);
        String source = bundle.files().get(path);
        String before = source.substring(range.startOffset(), range.endOffset());
        String after;
        if (statementExpressionContext(expression)) {
            if (!isStatementExpression(replacement.getResult().orElseThrow())) {
                throw failure("INVALID_EDIT", "This context requires a Java statement expression");
            }
            // A complete expression statement or for update cannot be parenthesized in Java.
            after = payload.expression();
        } else {
            // Preserve surrounding operator precedence for expressions nested inside a larger tree.
            after = "(" + payload.expression() + ")";
        }
        return new TextChange(path, range.startOffset(), range.endOffset(), before, after);
    }

    private TextChange insertStatement(Parsed parsed, GraphNode selected, Node target, InsertStatement payload) {
        if (!selected.allowedOperations().contains("insert_statement")) throw failure("UNSUPPORTED_OPERATION", "Node is not an insertion anchor");
        if (payload.position() == null || !selected.insertionPositions().contains(payload.position())) throw failure("INVALID_EDIT", "Position is not available on this anchor");
        if (payload.source() == null || payload.source().isBlank() || payload.source().indexOf('\r') >= 0 || payload.source().indexOf('\uFEFF') >= 0) {
            throw failure("INVALID_EDIT", "One canonical LF Java statement is required");
        }
        // Parsing a wrapper also verifies EOF and prevents a second statement or trailing tokens.
        var result = parser().parseBlock("{\n" + payload.source() + "\n}");
        if (!result.isSuccessful() || result.getResult().isEmpty() || result.getResult().orElseThrow().getStatements().size() != 1) {
            throw failure("INVALID_EDIT", "Insertion must contain exactly one Java statement");
        }
        Statement inserted = result.getResult().orElseThrow().getStatement(0);
        if (unsupportedFlow(inserted)) throw failure("UNSUPPORTED_OPERATION", "Inserted statement uses unsupported control flow");
        boolean bodyAnchor = selected.kind().equals("entry");
        BlockStmt block = bodyAnchor && target instanceof BlockStmt body ? body : statementContainer(target);
        if (block == null) throw failure("UNSUPPORTED_OPERATION", "Insertion requires a real block binding");
        validateJumps(inserted, block);
        String path = selected.sourceRange().filePath();
        SourceMap map = parsed.maps().get(path);
        SourceRange range = map.range(target);
        int offset = switch (payload.position()) {
            case "before" -> range.startOffset();
            case "after" -> range.endOffset();
            case "body_start" -> map.offsets.get(block.getTokenRange().orElseThrow().getBegin())[1];
            case "body_end" -> map.offsets.get(block.getTokenRange().orElseThrow().getEnd())[0];
            default -> throw failure("INVALID_EDIT", "Unknown insertion position");
        };
        // Newlines isolate inserted text from adjacent // comments, including one-line bodies.
        return new TextChange(path, offset, offset, "", "\n" + payload.source() + "\n");
    }

    private TextChange deleteStatement(SourceBundle bundle, Parsed parsed, GraphNode selected, Node target) {
        if (!selected.allowedOperations().contains("delete_statement") || statementContainer(target) == null) {
            throw failure("UNSUPPORTED_OPERATION", "Deletion requires a statement element of a supported block");
        }
        if (containsComment(target)) throw failure("UNSUPPORTED_OPERATION", "Deletion would discard an internal comment");
        String path = selected.sourceRange().filePath();
        SourceRange range = parsed.maps().get(path).range(target);
        return new TextChange(path, range.startOffset(), range.endOffset(),
                bundle.files().get(path).substring(range.startOffset(), range.endOffset()), "");
    }

    private static BlockStmt statementContainer(Node target) {
        if (!(target instanceof Statement statement) || !(target.getParentNode().orElse(null) instanceof BlockStmt block)) return null;
        return block.getStatements().stream().anyMatch(s -> s == statement) ? block : null;
    }

    private static boolean containsComment(Node node) {
        for (JavaToken token : node.getTokenRange().orElseThrow()) {
            if (token.getCategory().isComment()) return true;
        }
        return false;
    }

    private static boolean unsupportedFlow(Node body) {
        return body.findAll(Statement.class).stream().anyMatch(s -> s instanceof TryStmt || s instanceof SwitchStmt
                || s instanceof LabeledStmt || s instanceof SynchronizedStmt || s instanceof ForEachStmt
                || s instanceof LocalClassDeclarationStmt || s instanceof YieldStmt
                || s instanceof BreakStmt b && b.getLabel().isPresent() || s instanceof ContinueStmt c && c.getLabel().isPresent())
                || body.findAll(Expression.class).stream().anyMatch(e -> e.isLambdaExpr() || e.isSwitchExpr());
    }

    private static boolean isLoop(Node node) {
        return node instanceof ForStmt || node instanceof WhileStmt || node instanceof DoStmt || node instanceof ForEachStmt;
    }

    private static void validateJumps(Statement inserted, BlockStmt destination) {
        for (Statement jump : inserted.findAll(Statement.class).stream().filter(s -> s instanceof BreakStmt || s instanceof ContinueStmt).toList()) {
            boolean loop = false;
            Node cursor = jump;
            while (cursor != inserted) {
                cursor = cursor.getParentNode().orElseThrow();
                if (isLoop(cursor)) { loop = true; break; }
            }
            for (cursor = destination; !loop && cursor != null; cursor = cursor.getParentNode().orElse(null)) {
                if (cursor instanceof CallableDeclaration<?>) break;
                if (isLoop(cursor)) loop = true;
            }
            if (!loop) throw failure("INVALID_EDIT", "break/continue requires an enclosing supported loop");
        }
    }

    private Expression condition(Node node) {
        if (node instanceof IfStmt stmt) return stmt.getCondition();
        if (node instanceof WhileStmt stmt) return stmt.getCondition();
        if (node instanceof DoStmt stmt) return stmt.getCondition();
        if (node instanceof ForStmt stmt) return stmt.getCompare().orElse(null);
        return null;
    }

    private static boolean statementExpressionContext(Expression expression) {
        Node parent = expression.getParentNode().orElse(null);
        if (parent instanceof ExpressionStmt statement) {
            return statement.getExpression() == expression;
        }
        if (parent instanceof ForStmt loop) {
            return loop.getInitialization().stream().anyMatch(item -> item == expression)
                    || loop.getUpdate().stream().anyMatch(item -> item == expression);
        }
        return false;
    }

    private static boolean isStatementExpression(Expression expression) {
        if (expression.isAssignExpr() || expression.isMethodCallExpr() || expression.isObjectCreationExpr()) {
            return true;
        }
        if (expression.isUnaryExpr()) {
            return switch (expression.asUnaryExpr().getOperator()) {
                case PREFIX_INCREMENT, PREFIX_DECREMENT, POSTFIX_INCREMENT, POSTFIX_DECREMENT -> true;
                default -> false;
            };
        }
        return false;
    }

    private Parsed analyze(SourceBundle bundle, String id) {
        Builder builder = new Builder(bundle, id);
        for (var entry : new TreeMap<>(bundle.files()).entrySet()) {
            com.github.javaparser.ParseResult<CompilationUnit> result;
            try { result = parser().parse(entry.getValue()); }
            catch (StackOverflowError tooDeep) {
                builder.invalid = true;
                builder.diagnostics.add(new Diagnostic(builder.id(), "error", "ANALYSIS_LIMIT", "Source exceeds parser nesting budget", null));
                continue;
            }
            if (!result.isSuccessful() || result.getResult().isEmpty()) {
                builder.invalid = true;
                result.getProblems().forEach(problem -> builder.diagnostics.add(new Diagnostic(builder.id(), "error", "PARSE_ERROR",
                        problem.getMessage(), problem.getLocation().map(location -> diagnosticRange(entry.getKey(), entry.getValue(), location)).orElse(null))));
                continue;
            }
            CompilationUnit unit = result.getResult().orElseThrow();
            if (!boundedAst(unit)) {
                builder.invalid = true;
                builder.diagnostics.add(new Diagnostic(builder.id(), "error", "ANALYSIS_LIMIT", "Source exceeds AST depth or node budget", null));
                continue;
            }
            builder.units.put(entry.getKey(), unit);
            SourceMap map = new SourceMap(entry.getKey(), entry.getValue(), unit);
            builder.maps.put(entry.getKey(), map);
            Map<Node, String> typeIds = new IdentityHashMap<>();
            for (TypeDeclaration<?> type : unit.findAll(TypeDeclaration.class)) {
                String typeId = builder.id();
                String parentType = type.findAncestor(TypeDeclaration.class).map(typeIds::get).orElse(null);
                typeIds.put(type, typeId);
                builder.declarationBindings.put(type, typeId);
                builder.declarations.add(new Declaration(typeId, entry.getKey(), type.getClass().getSimpleName(),
                        type.getNameAsString(), parentType, map.range(type)));
            }
            for (CallableDeclaration<?> callable : unit.findAll(CallableDeclaration.class)) {
                BlockStmt body = callable instanceof MethodDeclaration m ? m.getBody().orElse(null)
                        : callable instanceof ConstructorDeclaration c ? c.getBody() : null;
                String declaration = builder.id();
                String fqName = SemanticAnalyzer.ownerName(callable) + "." + callable.getNameAsString();
                String parentType = callable.findAncestor(TypeDeclaration.class).map(typeIds::get).orElse(null);
                builder.declarationBindings.put(callable, declaration);
                builder.declarations.add(new Declaration(declaration, entry.getKey(), callable instanceof ConstructorDeclaration ? "constructor" : "method", callable.getNameAsString(), parentType, map.range(callable)));
                if (body != null) builder.method(callable, body, declaration, fqName, map);
            }
        }
        if (builder.invalid) { builder.methods.clear(); builder.nodes.clear(); builder.edges.clear(); builder.bindings.clear(); }
        Graph graph = new Graph(bundle.revisionId(), id, SOURCE_MAP_VERSION, builder.methods, builder.nodes, builder.edges);
        SemanticAnalyzer.Result semantic = builder.invalid ? new SemanticAnalyzer.Result(SemanticModel.empty(), List.of())
                : SemanticAnalyzer.inspect(id, builder.units, node -> {
                    CompilationUnit unit = node.findCompilationUnit().orElseThrow();
                    String path = builder.units.entrySet().stream().filter(e -> e.getValue() == unit).findFirst().orElseThrow().getKey();
                    return builder.maps.get(path).range(node);
                }, builder.declarationBindings);
        builder.declarations.addAll(semantic.declarations());
        List<Capability> coverage = List.of(
                new Capability("parse", builder.invalid ? "failed" : "passed", "JavaParser 3.28.2, Java 21, preview disabled"),
                new Capability("control_flow", "partial", "Structured if/while/do/for, return/throw and unlabeled loop jumps; exceptional calls and opaque constructs are not complete CFG"),
                new Capability("replace_expression", "partial", "Expressions in supported methods; syntax checked, compile/type/scope validation requires isolated runner"),
                new Capability("insert_statement", "partial", "One supported statement before/after a block element or at a callable body boundary; isolated compilation required"),
                new Capability("delete_statement", "partial", "Supported block statement elements without internal comments; isolated compilation required"),
                new Capability("symbols", builder.invalid ? "not_requested" : "partial", "Bounded source-bundle and platform JDK bindings; unknown or unsupported domains remain explicit"),
                new Capability("complexity", "unknown", "No asymptotic guarantee without bounds and resolved calls"),
                new Capability("OPT-MEMBERSHIP-001", "unsupported", "Alias, escape, dominance and effect proof not implemented"));
        Analysis analysis = new Analysis(id, bundle.revisionId(), bundleHash(bundle), VERSION, "3.28.2", "JAVA_21",
                builder.invalid ? "invalid" : "valid", "not_requested", builder.invalid ? "not_requested" : "partial", SOURCE_MAP_VERSION,
                builder.diagnostics, coverage, builder.declarations, graph, currentSymbolEnvironmentHash(), semantic.model());
        return new Parsed(analysis, builder.bindings, builder.maps);
    }

    private record Parsed(Analysis analysis, Map<String, Node> bindings, Map<String, SourceMap> maps) {}
    private static boolean boundedAst(Node root) {
        record AtDepth(Node node, int depth) {}
        Deque<AtDepth> pending = new ArrayDeque<>(); pending.push(new AtDepth(root, 0));
        int count = 0;
        while (!pending.isEmpty()) {
            AtDepth current = pending.pop();
            if (++count > 100000 || current.depth() > 128) return false;
            for (Node child : current.node().getChildNodes()) pending.push(new AtDepth(child, current.depth() + 1));
        }
        return true;
    }
    private static EngineException failure(String code, String message) { return new EngineException(code, message); }

    /** Problems can retain a token chain even when no compilation unit was produced. */
    private static SourceRange diagnosticRange(String path, String source, com.github.javaparser.TokenRange location) {
        JavaToken token = location.getBegin();
        while (token.getPreviousToken().isPresent()) token = token.getPreviousToken().orElseThrow();
        int offset = 0, start = -1;
        while (true) {
            String text = token.getText();
            if (!source.startsWith(text, offset)) return null;
            if (token == location.getBegin()) start = offset;
            offset += text.length();
            if (token == location.getEnd()) {
                if (start < 0) return null;
                int[] begin = sourcePosition(source, start), end = sourcePosition(source, offset);
                return new SourceRange(path, start, offset, begin[0], begin[1], end[0], end[1]);
            }
            if (token.getNextToken().isEmpty()) return null;
            token = token.getNextToken().orElseThrow();
        }
    }

    private static int[] sourcePosition(String source, int offset) {
        int line = 1, column = 1;
        for (int i = 0; i < offset; i++) { if (source.charAt(i) == '\n') { line++; column = 1; } else column++; }
        return new int[]{line, column};
    }

    public static String sourceHash(String source) { return sha256(source.getBytes(StandardCharsets.UTF_8)); }
    public static String bundleHash(SourceBundle bundle) {
        try {
            var bytes = new ByteArrayOutputStream();
            var out = new DataOutputStream(bytes);
            writeField(out, "java21-v1");
            out.writeInt(bundle.files().size());
            for (var entry : new TreeMap<>(bundle.files()).entrySet()) { writeField(out, entry.getKey()); writeField(out, sourceHash(entry.getValue())); }
            return sha256(bytes.toByteArray());
        } catch (java.io.IOException impossible) { throw new IllegalStateException(impossible); }
    }
    private static void writeField(DataOutputStream out, String value) throws java.io.IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8); out.writeInt(bytes.length); out.write(bytes);
    }
    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    /** Token text, including trivia, maps directly onto source: parser columns are deliberately unused. */
    private static final class SourceMap {
        private final String path;
        private final String source;
        private final Map<JavaToken, int[]> offsets = new IdentityHashMap<>();
        SourceMap(String path, String source, CompilationUnit unit) {
            this.path = path; this.source = source;
            int offset = 0;
            for (JavaToken token : unit.getTokenRange().orElseThrow()) {
                String text = token.getText();
                if (!source.startsWith(text, offset)) throw failure("SOURCE_MAP_UNAVAILABLE", "Parser tokens differ from canonical source");
                offsets.put(token, new int[]{offset, offset + text.length()}); offset += text.length();
            }
            if (offset != source.length()) throw failure("SOURCE_MAP_UNAVAILABLE", "Parser token coverage is incomplete");
        }
        SourceRange range(Node node) {
            var tokens = node.getTokenRange().orElseThrow();
            int start = offsets.get(tokens.getBegin())[0], end = offsets.get(tokens.getEnd())[1];
            int[] begin = position(start), finish = position(end);
            return new SourceRange(path, start, end, begin[0], begin[1], finish[0], finish[1]);
        }
        int[] position(int offset) {
            return sourcePosition(source, offset);
        }
    }

    private final class Builder {
        private final SourceBundle bundle;
        private final String analysisId;
        private int sequence;
        private boolean invalid;
        private final List<Diagnostic> diagnostics = new ArrayList<>();
        private final List<Declaration> declarations = new ArrayList<>();
        private final List<Method> methods = new ArrayList<>();
        private final List<GraphNode> nodes = new ArrayList<>();
        private final List<Edge> edges = new ArrayList<>();
        private final Map<String, Node> bindings = new HashMap<>();
        private final Map<Node, String> astIds = new IdentityHashMap<>();
        private final Map<String, SourceMap> maps = new HashMap<>();
        private final Map<String, CompilationUnit> units = new TreeMap<>();
        private final Map<Node, String> declarationBindings = new IdentityHashMap<>();
        private String methodId;
        private String normalExit;
        private String exceptionalExit;
        private SourceMap map;
        private String root;
        private boolean opaqueMethod;
        Builder(SourceBundle bundle, String analysisId) { this.bundle = bundle; this.analysisId = analysisId; }
        String id() { return analysisId + ":" + (++sequence); }
        String node(Node ast, String kind, String parent) {
            String id = id();
            Map<String, SourceRange> fieldRanges = Map.of();
            if (!opaqueMethod && ast instanceof Expression expression && !expression.isVariableDeclarationExpr()) {
                fieldRanges = Map.of("expression", map.range(expression));
            } else if (!opaqueMethod && condition(ast) != null) {
                fieldRanges = Map.of("condition", map.range(condition(ast)));
            }
            List<String> fields = List.copyOf(fieldRanges.keySet());
            List<String> operations = new ArrayList<>();
            List<String> positions = List.of();
            if (!fields.isEmpty()) operations.add("replace_expression");
            if (!opaqueMethod && "entry".equals(kind) && ast instanceof BlockStmt) {
                operations.add("insert_statement");
                positions = List.of("body_start", "body_end");
            } else if (!opaqueMethod && !"expression".equals(kind) && statementContainer(ast) != null) {
                operations.add("insert_statement");
                if (!containsComment(ast)) operations.add("delete_statement");
                positions = List.of("before", "after");
            }
            String text = ast == null || "entry".equals(kind) ? kind : map.source.substring(map.range(ast).startOffset(), map.range(ast).endOffset());
            if (text.length() > 180) text = text.substring(0, 177) + "...";
            nodes.add(new GraphNode(id, bundle.revisionId(), analysisId, methodId, kind, text,
                    ast == null ? null : map.range(ast), id, parent, ast == null, fields, fieldRanges, operations, positions));
            if (ast != null) { bindings.put(id, ast); astIds.put(ast, id); }
            return id;
        }
        void edge(String source, String target, String kind) {
            if (source != null && target != null) edges.add(new Edge(id(), source, target, kind, null, null));
        }
        void method(CallableDeclaration<?> callable, BlockStmt body, String declaration, String fqName, SourceMap sourceMap) {
            methodId = id(); map = sourceMap; astIds.clear();
            opaqueMethod = unsupportedFlow(body);
            root = node(body, "entry", null);
            normalExit = node(null, "normal_exit", null);
            exceptionalExit = node(null, "exceptional_exit", null);
            String first;
            if (opaqueMethod) {
                first = node(body, "opaque", root);
                diagnostics.add(new Diagnostic(id(), "warning", "UNSUPPORTED_CONTROL_FLOW", "Method preserved; precise flow and graph edits unavailable for this control structure", map.range(body)));
                edge(first, normalExit, "normal"); edge(first, exceptionalExit, "throw");
            } else first = flow(body, normalExit, null, null, root);
            edge(root, first, "normal");
            // Expressions are selectable source-bound AST projections, not additional executable CFG statements.
            for (Expression expression : body.findAll(Expression.class)) {
                Node ancestor = expression.getParentNode().orElse(null);
                while (ancestor != null && !astIds.containsKey(ancestor)) ancestor = ancestor.getParentNode().orElse(null);
                node(expression, "expression", ancestor == null ? root : astIds.get(ancestor));
            }
            methods.add(new Method(methodId, declaration, fqName, callable.getSignature().asString(), map.range(callable),
                    root, List.of(normalExit, exceptionalExit)));
        }
        String flow(Statement stmt, String next, String breakTarget, String continueTarget, String parent) {
            if (stmt instanceof BlockStmt block) {
                String blockId = node(block, "block", parent), cursor = next;
                List<Statement> children = block.getStatements();
                for (int i = children.size() - 1; i >= 0; i--) cursor = flow(children.get(i), cursor, breakTarget, continueTarget, blockId);
                return cursor;
            }
            String current = node(stmt, stmt.getClass().getSimpleName(), parent);
            if (stmt instanceof IfStmt branch) {
                edge(current, flow(branch.getThenStmt(), next, breakTarget, continueTarget, current), "true");
                edge(current, branch.getElseStmt().map(s -> flow(s, next, breakTarget, continueTarget, current)).orElse(next), "false");
            } else if (stmt instanceof WhileStmt loop) {
                String back = node(null, "loop_back", current); edge(back, current, "loop");
                edge(current, flow(loop.getBody(), back, next, current, current), "true"); edge(current, next, "false");
            } else if (stmt instanceof DoStmt loop) {
                String back = node(null, "loop_back", current);
                String body = flow(loop.getBody(), current, next, current, current);
                edge(current, back, "true"); edge(back, body, "loop"); edge(current, next, "false"); return body;
            } else if (stmt instanceof ForStmt loop) {
                String back = node(null, "loop_back", current); edge(back, current, "loop");
                String update = back;
                for (int i = loop.getUpdate().size() - 1; i >= 0; i--) { String step = node(loop.getUpdate().get(i), "for_update", current); edge(step, update, "normal"); update = step; }
                edge(current, flow(loop.getBody(), update, next, update, current), "true");
                if (loop.getCompare().isPresent()) edge(current, next, "false");
                String init = current;
                for (int i = loop.getInitialization().size() - 1; i >= 0; i--) { String step = node(loop.getInitialization().get(i), "for_init", current); edge(step, init, "normal"); init = step; }
                return init;
            } else if (stmt instanceof ReturnStmt) edge(current, normalExit, "return");
            else if (stmt instanceof ThrowStmt) edge(current, exceptionalExit, "throw");
            else if (stmt instanceof BreakStmt) edge(current, breakTarget, "break");
            else if (stmt instanceof ContinueStmt) edge(current, continueTarget, "continue");
            else edge(current, next, "normal");
            return current;
        }
    }
}
