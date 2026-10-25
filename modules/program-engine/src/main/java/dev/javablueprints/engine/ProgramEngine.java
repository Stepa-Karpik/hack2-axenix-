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
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import dev.javablueprints.engine.EngineModel.*;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.function.Function;
import java.util.function.Supplier;

/** Source-first, side-effect-free Java 21 analysis. Never compiles or executes input programs. */
public final class ProgramEngine {
    // Runtime read prevents javac inlining an older engine version into incremental server builds.
    public static final String VERSION = analyzerVersion();
    private static String analyzerVersion() { return "engine-0.13.1"; }
    public static final String SOURCE_MAP_VERSION = "utf16-token-v1";
    private static final int MAX_CONDITION_TESTS_PER_METHOD = 4096;
    private static final int MAX_SWITCH_ENTRIES_PER_METHOD = 1024;
    private static final int MAX_SWITCH_LABELS_PER_METHOD = 4096;
    private static final int MAX_FOREACH_LOOPS_PER_METHOD = 1024;
    private static final int MAX_FLOW_NODES_PER_METHOD = 8192;
    private static final int MAX_FLOW_EDGES_PER_METHOD = 24576;
    private static final int MAX_RESOURCES_PER_TRY = 64;
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
        if (!Set.of("replace_expression", "replace_statement", "insert_statement", "delete_statement", "move_statement", "wrap_if", "wrap_while", "add_else", "remove_else", "optimize_membership", "extract_method", "decompose_class", "rename_local").contains(command.operation())) {
            throw failure("UNSUPPORTED_OPERATION", "Operation is not implemented");
        }
        if (!Set.of("semantic_edit", "preserve_behavior").contains(command.intent())) throw failure("INVALID_EDIT", "Unknown intent");
        GraphNode selected = analysis.graph().nodes().stream().filter(n -> n.id().equals(command.nodeId())).findFirst()
                .orElseThrow(() -> failure("ANALYSIS_CONFLICT", "Node does not belong to this analysis"));
        if (!selected.methodId().equals(command.methodId())) throw failure("ANALYSIS_CONFLICT", "Node does not belong to the selected method");
        Node target = parsed.bindings().get(selected.id());
        if ("rename_local".equals(command.operation())) {
            if (!(command.payload() instanceof RenameLocal payload)) throw failure("INVALID_EDIT","Expected new local name");
            if (!"preserve_behavior".equals(command.intent())) throw failure("INVALID_EDIT","Local rename requires exact behavior comparison");
            requireOperation(selected,"rename_local");
            var rewrite=LocalRename.rewrite(bundle,analysis,selected,target,
                node->parsed.maps().get(selected.sourceRange().filePath()).range(node),payload.newName());
            Analysis checked=inspect(new SourceBundle(UUID.randomUUID().toString(),rewrite.files()));
            return new Candidate(rewrite.files(),rewrite.changes(),"valid","not_requested","unverified",checked.diagnostics());
        }
        if ("decompose_class".equals(command.operation())) {
            if (!(command.payload() instanceof DecomposeClass payload)) throw failure("INVALID_EDIT","Expected new class name");
            if (!"preserve_behavior".equals(command.intent())) throw failure("INVALID_EDIT","Class decomposition requires exact behavior comparison");
            requireOperation(selected,"decompose_class");
            var rewrite=ClassDecomposition.rewrite(bundle,analysis,selected,target,
                node->parsed.maps().get(selected.sourceRange().filePath()).range(node),payload.className());
            Analysis checked=inspect(new SourceBundle(UUID.randomUUID().toString(),rewrite.files()));
            if(!"valid".equals(checked.parseStatus()))throw failure("INVALID_EDIT","Decomposed candidate does not parse");
            return new Candidate(rewrite.files(),rewrite.changes(),"valid","not_requested","unverified",checked.diagnostics(),null,
                new DecompositionSummary(rewrite.filePath(),rewrite.className(),rewrite.originalMethodName()));
        }
        MembershipOptimization.Rewrite membership = null;
        MethodExtraction.Rewrite extraction = null;
        TextChange change = switch (command.operation()) {
            case "extract_method" -> {
                if (!(command.payload() instanceof ExtractMethod payload)) throw failure("INVALID_EDIT", "Expected extraction name and final statement");
                if (!"preserve_behavior".equals(command.intent())) throw failure("INVALID_EDIT", "Extraction requires preserve_behavior and exact comparison before apply");
                requireOperation(selected,"extract_method");
                GraphNode end = analysis.graph().nodes().stream().filter(n->n.id().equals(payload.endNodeId())).findFirst()
                    .orElseThrow(()->failure("ANALYSIS_CONFLICT","Final statement does not belong to this analysis"));
                requireOperation(end,"extract_method");
                extraction = MethodExtraction.rewrite(bundle,analysis,selected,target,end,parsed.bindings().get(end.id()),
                    node->parsed.maps().get(selected.sourceRange().filePath()).range(node),payload.methodName());
                yield extraction.change();
            }
            case "optimize_membership" -> {
                if (!(command.payload() instanceof OptimizeMembership)) throw failure("INVALID_EDIT", "Expected empty optimization payload");
                if (!"preserve_behavior".equals(command.intent())) throw failure("INVALID_EDIT", "Optimization requires preserve_behavior and exact comparison before apply");
                requireOperation(selected,"optimize_membership");
                var plan=parsed.optimizations().get(selected.id());
                if(plan==null)throw failure("UNSUPPORTED_OPERATION","Membership preconditions are not proven");
                membership=plan.rewrite(bundle);
                yield membership.change();
            }
            case "replace_expression" -> {
                if (!(command.payload() instanceof ReplaceExpression payload)) throw failure("INVALID_EDIT", "Expected expression payload");
                yield replaceExpression(bundle, parsed, selected, target, payload);
            }
            case "replace_statement" -> {
                if (!(command.payload() instanceof ReplaceStatement payload)) throw failure("INVALID_EDIT", "Expected statement payload");
                yield replaceStatement(bundle, parsed, selected, target, payload);
            }
            case "insert_statement" -> {
                if (!(command.payload() instanceof InsertStatement payload)) throw failure("INVALID_EDIT", "Expected insertion payload");
                yield insertStatement(parsed, selected, target, payload);
            }
            case "delete_statement" -> {
                if (!(command.payload() instanceof DeleteStatement)) throw failure("INVALID_EDIT", "Expected deletion payload");
                yield deleteStatement(bundle, parsed, selected, target);
            }
            case "move_statement" -> {
                if (!(command.payload() instanceof MoveStatement payload)) throw failure("INVALID_EDIT", "Expected move payload");
                yield moveStatement(bundle, parsed, selected, target, payload);
            }
            case "wrap_if", "wrap_while" -> {
                if (!(command.payload() instanceof WrapStatement payload)) throw failure("INVALID_EDIT", "Expected wrap payload");
                yield wrapStatement(bundle, parsed, selected, target, payload, command.operation());
            }
            case "add_else" -> {
                if (!(command.payload() instanceof AddElse payload)) throw failure("INVALID_EDIT", "Expected else payload");
                yield addElse(bundle, parsed, selected, target, payload);
            }
            case "remove_else" -> {
                if (!(command.payload() instanceof RemoveElse)) throw failure("INVALID_EDIT", "Expected empty else-removal payload");
                yield removeElse(bundle, parsed, selected, target);
            }
            default -> throw failure("UNSUPPORTED_OPERATION", "Operation is not implemented");
        };
        String source = bundle.files().get(change.filePath());
        Map<String, String> files = new TreeMap<>(bundle.files());
        files.put(change.filePath(), source.substring(0, change.startOffset()) + change.after() + source.substring(change.endOffset()));
        Analysis candidate = inspect(new SourceBundle(UUID.randomUUID().toString(), files));
        if (!"valid".equals(candidate.parseStatus())) throw failure("INVALID_EDIT", "Candidate does not parse in its project context");
        if (membership!=null&&!MembershipOptimization.validCandidate(candidate,membership)) throw failure("UNSUPPORTED_OPERATION","Generated index must resolve to the standard JDK HashSet<String>");
        return new Candidate(files, List.of(change), "valid", "not_requested", "unverified", candidate.diagnostics(),extraction==null?null:extraction.summary());
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

    private TextChange replaceStatement(SourceBundle bundle, Parsed parsed, GraphNode selected, Node target, ReplaceStatement payload) {
        requireOperation(selected,"replace_statement");
        if(statementContainer(target)==null || containsComment(target)) throw failure("UNSUPPORTED_OPERATION","Replacement requires a comment-free statement in a real block");
        if(payload.source()==null || payload.source().isBlank() || payload.source().indexOf('\r')>=0 || payload.source().indexOf('\uFEFF')>=0) throw failure("INVALID_EDIT","One canonical LF Java statement required");
        var replacement=parser().parseBlock("{\n"+payload.source()+"\n}");
        if(!replacement.isSuccessful() || replacement.getResult().isEmpty() || replacement.getResult().orElseThrow().getStatements().size()!=1) throw failure("INVALID_EDIT","Replacement must be exactly one Java statement");
        if(unsupportedFlow(replacement.getResult().orElseThrow().getStatement(0))) throw failure("UNSUPPORTED_OPERATION","Unsupported replacement flow");
        String path=selected.sourceRange().filePath();
        SourceRange range=parsed.maps().get(path).range(target);
        String source=bundle.files().get(path);
        return new TextChange(path,range.startOffset(),range.endOffset(),source.substring(range.startOffset(),range.endOffset()),payload.source());
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

    private TextChange moveStatement(SourceBundle bundle, Parsed parsed, GraphNode selected, Node target, MoveStatement payload) {
        requireOperation(selected, "move_statement");
        if (!Set.of("before", "after").contains(Objects.toString(payload.position(), ""))) throw failure("INVALID_EDIT", "Move position must be before or after");
        GraphNode destination = parsed.analysis().graph().nodes().stream().filter(n -> n.id().equals(payload.targetNodeId())).findFirst()
                .orElseThrow(() -> failure("ANALYSIS_CONFLICT", "Move target does not belong to this analysis"));
        if (!destination.methodId().equals(selected.methodId())) throw failure("ANALYSIS_CONFLICT", "Move target belongs to another method");
        Node anchor = parsed.bindings().get(destination.id());
        BlockStmt block = statementContainer(target);
        if (block == null || statementContainer(anchor) != block || !destination.allowedOperations().contains("move_statement")) {
            throw failure("UNSUPPORTED_OPERATION", "Move requires direct siblings in the same block");
        }
        int from = statementIndex(block, target), to = statementIndex(block, anchor);
        if (from == to || (payload.position().equals("before") && from + 1 == to)
                || (payload.position().equals("after") && to + 1 == from)) throw failure("INVALID_EDIT", "Move would not change statement order");
        String path = selected.sourceRange().filePath(), source = bundle.files().get(path);
        SourceMap map = parsed.maps().get(path);
        SourceRange moving = map.range(target), at = map.range(anchor);
        int offset = payload.position().equals("before") ? at.startOffset() : at.endOffset();
        String moved = source.substring(moving.startOffset(), moving.endOffset());
        int start = Math.min(moving.startOffset(), offset), end = Math.max(moving.endOffset(), offset);
        String after = offset < moving.startOffset()
                ? "\n" + moved + "\n" + source.substring(offset, moving.startOffset())
                : source.substring(moving.endOffset(), offset) + "\n" + moved + "\n";
        return new TextChange(path, start, end, source.substring(start, end), after);
    }

    private TextChange wrapStatement(SourceBundle bundle, Parsed parsed, GraphNode selected, Node target, WrapStatement payload, String operation) {
        requireOperation(selected, operation);
        if (statementContainer(target) == null) throw failure("UNSUPPORTED_OPERATION", "Wrap requires a direct block statement");
        canonicalEditText(payload.condition());
        // A complete wrapper enforces EOF and prevents condition text from escaping its syntactic slot.
        var conditionCheck = parser().parseBlock("{ if (" + payload.condition() + ") {} }");
        if (!conditionCheck.isSuccessful() || conditionCheck.getResult().isEmpty()
                || conditionCheck.getResult().orElseThrow().getStatements().size() != 1
                || !(conditionCheck.getResult().orElseThrow().getStatement(0) instanceof IfStmt check)
                || check.getElseStmt().isPresent() || !(check.getThenStmt() instanceof BlockStmt then) || !then.isEmpty()) {
            throw failure("INVALID_EDIT", "Condition must be exactly one Java expression");
        }
        if (operation.equals("wrap_while") && capturesJump(target)) throw failure("UNSUPPORTED_OPERATION", "Loop wrapper would retarget an existing break or continue");
        String path = selected.sourceRange().filePath();
        SourceRange range = parsed.maps().get(path).range(target);
        String before = bundle.files().get(path).substring(range.startOffset(), range.endOffset());
        String keyword = operation.equals("wrap_if") ? "if" : "while";
        return new TextChange(path, range.startOffset(), range.endOffset(), before, keyword + " (" + payload.condition() + ") {\n" + before + "\n}");
    }

    private TextChange addElse(SourceBundle bundle, Parsed parsed, GraphNode selected, Node target, AddElse payload) {
        requireOperation(selected, "add_else");
        if (!canAddElse(target)) throw failure("UNSUPPORTED_OPERATION", "Else requires a direct if statement with a braced then and no else");
        canonicalEditText(payload.source());
        var result = parser().parseBlock("{\n" + payload.source() + "\n}");
        if (!result.isSuccessful() || result.getResult().isEmpty() || result.getResult().orElseThrow().getStatements().size() != 1
                || !(result.getResult().orElseThrow().getStatement(0) instanceof BlockStmt body)) throw failure("INVALID_EDIT", "Else source must be exactly one braced block");
        if (unsupportedFlow(body)) throw failure("UNSUPPORTED_OPERATION", "Else body uses unsupported control flow");
        validateJumps(body, statementContainer(target));
        SourceRange range = parsed.maps().get(selected.sourceRange().filePath()).range(target);
        return new TextChange(range.filePath(), range.endOffset(), range.endOffset(), "", "\nelse " + payload.source() + "\n");
    }

    private TextChange removeElse(SourceBundle bundle, Parsed parsed, GraphNode selected, Node target) {
        requireOperation(selected, "remove_else");
        if (!canRemoveElse(target)) throw failure("UNSUPPORTED_OPERATION", "Else removal requires a comment-free braced branch");
        String path = selected.sourceRange().filePath();
        SourceMap map = parsed.maps().get(path);
        int start = map.offsets.get(elseToken((IfStmt) target))[0], end = map.range(target).endOffset();
        return new TextChange(path, start, end, bundle.files().get(path).substring(start, end), "");
    }

    private static void requireOperation(GraphNode node, String operation) {
        if (!node.allowedOperations().contains(operation)) throw failure("UNSUPPORTED_OPERATION", "Operation is not available on this node");
    }

    private static int statementIndex(BlockStmt block, Node node) {
        for (int i = 0; i < block.getStatements().size(); i++) if (block.getStatement(i) == node) return i;
        throw failure("ANALYSIS_CONFLICT", "Statement is not bound to its block");
    }

    private static void canonicalEditText(String text) {
        if (text == null || text.isBlank() || text.indexOf('\r') >= 0 || text.indexOf('\uFEFF') >= 0) throw failure("INVALID_EDIT", "Canonical LF edit text is required");
        try {
            int size = StandardCharsets.UTF_8.newEncoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .encode(java.nio.CharBuffer.wrap(text)).remaining();
            if (size > 1024 * 1024) throw failure("INVALID_EDIT", "Edit text exceeds 1 MiB");
        } catch (java.nio.charset.CharacterCodingException e) { throw failure("INVALID_EDIT", "Edit text must contain valid Unicode"); }
    }

    /** A new while would capture jumps whose nearest original target lies outside the selected subtree. */
    private static boolean capturesJump(Node selected) {
        for (Statement jump : selected.findAll(Statement.class)) {
            if (!(jump instanceof BreakStmt || jump instanceof ContinueStmt)) continue;
            Node cursor = jump;
            boolean internal = false;
            while (cursor != selected) {
                cursor = cursor.getParentNode().orElse(null);
                if (cursor == null || jumpBoundary(cursor)) { internal = true; break; }
                if (jumpTarget(jump, cursor)) { internal = true; break; }
            }
            if (!internal) return true;
        }
        return false;
    }

    private static boolean canAddElse(Node node) {
        return statementContainer(node) != null && node instanceof IfStmt branch
                && branch.getThenStmt() instanceof BlockStmt && branch.getElseStmt().isEmpty();
    }

    private static JavaToken elseToken(IfStmt branch) {
        JavaToken thenEnd = branch.getThenStmt().getTokenRange().orElseThrow().getEnd();
        boolean afterThen = false;
        for (JavaToken token : branch.getTokenRange().orElseThrow()) {
            if (afterThen && token.getText().equals("else")) return token;
            if (token == thenEnd) afterThen = true;
        }
        throw failure("ANALYSIS_CONFLICT", "Missing else token");
    }

    private static boolean canRemoveElse(Node node) {
        if (statementContainer(node) == null || !(node instanceof IfStmt branch) || !(branch.getThenStmt() instanceof BlockStmt)
                || branch.getElseStmt().isEmpty() || !(branch.getElseStmt().orElseThrow() instanceof BlockStmt)) return false;
        JavaToken start = elseToken(branch);
        boolean removing = false;
        for (JavaToken token : branch.getTokenRange().orElseThrow()) {
            if (token == start) removing = true;
            if (removing && token.getCategory().isComment()) return false;
        }
        return true;
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
        return body.findAll(Statement.class).stream().anyMatch(s -> s instanceof TryStmt t && t.getResources().stream().anyMatch(r -> !supportedResource(r)) || s instanceof SwitchStmt sw && !supportedSwitch(sw)
                || s instanceof LabeledStmt || s instanceof SynchronizedStmt
                || s instanceof LocalClassDeclarationStmt || s instanceof YieldStmt
                || s instanceof BreakStmt b && b.getLabel().isPresent() || s instanceof ContinueStmt c && c.getLabel().isPresent())
                || body.findAll(Expression.class).stream().anyMatch(e -> e.isLambdaExpr() || e.isSwitchExpr());
    }

    private static boolean supportedResource(Expression resource) {
        return resource instanceof NameExpr || resource instanceof FieldAccessExpr
                || resource instanceof VariableDeclarationExpr declaration && declaration.getVariables().size() == 1
                && declaration.getVariable(0).getInitializer().isPresent();
    }

    private static boolean supportedSwitch(SwitchStmt statement) {
        int defaults = 0;
        for (SwitchEntry entry : statement.getEntries()) {
            if (entry.getType() != SwitchEntry.Type.STATEMENT_GROUP || entry.getGuard().isPresent()) return false;
            if (entry.isDefault()) {
                if (++defaults > 1 || !entry.getLabels().isEmpty()) return false;
            } else if (entry.getLabels().isEmpty()) return false;
            if (entry.getLabels().stream().anyMatch(label -> !label.findAll(AnnotationExpr.class).isEmpty() || !constantLabelShape(label))) return false;
        }
        return true;
    }

    /** Syntactic constant-expression shapes only; the isolated compiler decides validity/value. */
    private static boolean constantLabelShape(Expression expression) {
        if (expression instanceof NullLiteralExpr) return false;
        if (expression instanceof LiteralExpr || expression instanceof NameExpr) return true;
        if (expression instanceof FieldAccessExpr field) return constantLabelShape(field.getScope());
        if (expression instanceof EnclosedExpr enclosed) return constantLabelShape(enclosed.getInner());
        if (expression instanceof UnaryExpr unary) {
            return switch (unary.getOperator()) {
                case PLUS, MINUS, LOGICAL_COMPLEMENT, BITWISE_COMPLEMENT -> constantLabelShape(unary.getExpression());
                default -> false;
            };
        }
        if (expression instanceof BinaryExpr binary) return constantLabelShape(binary.getLeft()) && constantLabelShape(binary.getRight());
        if (expression instanceof CastExpr cast) return constantLabelShape(cast.getExpression());
        if (expression instanceof ConditionalExpr conditional) return constantLabelShape(conditional.getCondition())
                && constantLabelShape(conditional.getThenExpr()) && constantLabelShape(conditional.getElseExpr());
        return false;
    }

    private static boolean isLoop(Node node) {
        return node instanceof ForStmt || node instanceof WhileStmt || node instanceof DoStmt || node instanceof ForEachStmt;
    }

    private static void validateJumps(Statement inserted, BlockStmt destination) {
        for (Statement jump : inserted.findAll(Statement.class).stream().filter(s -> s instanceof BreakStmt || s instanceof ContinueStmt).toList()) {
            boolean found = false, boundary = false;
            Node cursor = jump;
            while (cursor != inserted) {
                cursor = cursor.getParentNode().orElseThrow();
                if (jumpBoundary(cursor)) { boundary = true; break; }
                if (jumpTarget(jump, cursor)) { found = true; break; }
            }
            for (cursor = destination; !found && !boundary && cursor != null; cursor = cursor.getParentNode().orElse(null)) {
                if (jumpBoundary(cursor)) break;
                if (jumpTarget(jump, cursor)) found = true;
            }
            if (!found) throw failure("INVALID_EDIT", jump instanceof BreakStmt
                    ? "break requires an enclosing supported loop or switch" : "continue requires an enclosing supported loop");
        }
    }
    private static boolean jumpTarget(Statement jump, Node target) {
        return isLoop(target) || jump instanceof BreakStmt && target instanceof SwitchStmt sw && supportedSwitch(sw);
    }
    private static boolean jumpBoundary(Node node) {
        return node instanceof CallableDeclaration<?> || node instanceof TypeDeclaration<?> || node instanceof LambdaExpr
                || node instanceof ObjectCreationExpr creation && creation.getAnonymousClassBody().isPresent();
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
            // JavaParser can synthesize a compact class even at JAVA_21. Its
            // implicit name has no source tokens and is outside our non-preview
            // compiler profile; reject it before symbol/source-map traversal.
            if (unit.findAll(com.github.javaparser.ast.body.ClassOrInterfaceDeclaration.class)
                    .stream().anyMatch(com.github.javaparser.ast.body.ClassOrInterfaceDeclaration::isCompact)) {
                builder.invalid = true;
                SourceRange range = unit.findFirst(CallableDeclaration.class)
                        .flatMap(Node::getTokenRange)
                        .map(tokens -> diagnosticRange(entry.getKey(), entry.getValue(), tokens)).orElse(null);
                builder.diagnostics.add(new Diagnostic(builder.id(), "error", "PARSE_ERROR",
                        "Methods must be inside an explicit class in the Java 21 non-preview profile", range));
                continue;
            }
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
        Function<Node,SourceRange> ranges = node -> {
            CompilationUnit unit = node.findCompilationUnit().orElseThrow();
            String path = builder.units.entrySet().stream().filter(e -> e.getValue() == unit).findFirst().orElseThrow().getKey();
            return builder.maps.get(path).range(node);
        };
        var membership = builder.invalid ? new MembershipOptimization.Result(graph,List.of(),Map.of())
                : MembershipOptimization.inspect(graph,builder.bindings,semantic.model(),builder.units.values(),ranges);
        graph=membership.graph();
        QualityModel quality = builder.invalid ? QualityModel.empty() : QualityAnalyzer.inspect(id,
                builder.declarationBindings, graph.methods(), node -> {
                    CompilationUnit unit = node.findCompilationUnit().orElseThrow();
                    String path = builder.units.entrySet().stream().filter(e -> e.getValue() == unit).findFirst().orElseThrow().getKey();
                    return builder.maps.get(path).range(node);
                });
        List<Capability> coverage = List.of(
                new Capability("parse", builder.invalid ? "failed" : "passed", "JavaParser 3.28.2, Java 21, preview disabled"),
                new Capability("control_flow", "partial", "Structured conditions/loops/colon switch, try/catch/finally and try-with-resources cleanup. Calls/expressions and resource methods remain atomic; opaque constructs and runtime type inference are not complete CFG"),
                new Capability("exception_flow", builder.invalid ? "not_requested" : "partial", "Ordered catches and context-specific finally/resource cleanup: left-to-right acquisition, reverse close, null skip, primary/suppressed exceptions, return/throw/break/continue overrides. Atomic-expression/close/addSuppressed failures conservative, no interprocedural type proof. Bounded to64 resources per try and8192 nodes/24576edges per method"),
                new Capability("condition_flow", builder.invalid ? "not_requested" : "partial", "Short-circuit &&/||/!/parentheses in supported if/while/do/for conditions, at most4096 tests/method; each atom evaluated once. In try-containing methods conservative exceptional exits (including unboxing) target active handler, otherwise normal-only projection. Opaque methods unsupported"),
                new Capability("switch_flow", builder.invalid ? "not_requested" : "partial", "Normal-completion colon statement switch, selector once, raw case/default alternatives and fallthrough; at most 1024 entries/4096 labels per method. Constant/type validity requires isolated compilation; modern/null/pattern/exceptional flow remains unsupported"),
                new Capability("enhanced_for_flow", builder.invalid ? "not_requested" : "partial", "Normal iteration abstraction, source evaluated once, synthetic check/bind/advance; at most 1024 enhanced-for loops per method. Advance means continuation, not Iterator.next; array/Iterable protocol details and exceptional flow are unknown. Type validity requires isolated compilation"),
                new Capability("replace_expression", "partial", "Expressions in supported methods; syntax checked, compile/type/scope validation requires isolated runner"),
                new Capability("replace_statement", "partial", "One comment-free supported block statement; exact source replacement and isolated compilation required"),
                new Capability("insert_statement", "partial", "One supported statement before/after a block element or at a callable body boundary; isolated compilation required"),
                new Capability("delete_statement", "partial", "Supported block statement elements without internal comments; isolated compilation required"),
                new Capability("decompose_class", builder.invalid ? "not_requested" : "partial", "Closed static int/boolean helper moved into a fresh package-private utility type; original declaration remains a forwarding wrapper. No state/calls/inheritance/unknown flow; isolated compilation and exact comparison required"),
                new Capability("extract_method", builder.invalid ? "not_requested" : "partial", "Bound contiguous statements in one class method; inferred typed parameters, at most one live local result or tail return; rejects escaping jumps, captures, unresolved names and unsafe exception-observed local writes. Detached compilation and exact comparison required"),
                new Capability("symbols", builder.invalid ? "not_requested" : "partial", "Bounded source-bundle and platform JDK bindings; unknown or unsupported domains remain explicit"),
                new Capability("complexity", "unknown", "No asymptotic guarantee without bounds and resolved calls"),
                new Capability("code_insights", builder.invalid ? "not_requested" : "passed", "Lexical body lines, structural statements/nesting/branching/calls; bounded recommendations are heuristic reading aids, not runtime cost or safe automatic refactoring"),
                new Capability("OPT-MEMBERSHIP-001", builder.invalid ? "not_requested" : "partial", "Closed local standard ArrayList<String>, literal construction writes, no alias/escape/reassignment/other uses; one HashSet index before a direct loop. At most64 loop candidates; resource/timing equivalence and performance gain unproven; exact comparison required before preserve apply"));
        Analysis analysis = new Analysis(id, bundle.revisionId(), bundleHash(bundle), VERSION, "3.28.2", "JAVA_21",
                builder.invalid ? "invalid" : "valid", "not_requested", builder.invalid ? "not_requested" : "partial", SOURCE_MAP_VERSION,
                builder.diagnostics, coverage, builder.declarations, graph, currentSymbolEnvironmentHash(), semantic.model(), quality, membership.opportunities());
        return new Parsed(analysis, builder.bindings, builder.maps, membership.plans());
    }

    private record Parsed(Analysis analysis, Map<String, Node> bindings, Map<String, SourceMap> maps, Map<String,MembershipOptimization.Plan> optimizations) {}
    private record FlowContext(Supplier<String> returned, Supplier<String> thrown, Supplier<String> broken,
                               Supplier<String> continued, String tag, boolean exceptions) {
        FlowContext jumps(String breakTarget, String continueTarget) {
            return new FlowContext(returned, thrown, () -> breakTarget, () -> continueTarget, tag, exceptions);
        }
        FlowContext tagged(String value) { return new FlowContext(returned, thrown, broken, continued, value, exceptions); }
    }
    private static final class FlowLimit extends RuntimeException {
        FlowLimit() { super(null, null, false, false); }
    }
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
        private final SourcePositions positions;
        private final Map<JavaToken, int[]> offsets = new IdentityHashMap<>();
        SourceMap(String path, String source, CompilationUnit unit) {
            this.path = path; this.source = source; this.positions = new SourcePositions(source);
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
            return positions.at(offset);
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
        private boolean buildingFlow;
        private int methodNodeStart;
        private int methodEdgeStart;
        private String completionContext;
        Builder(SourceBundle bundle, String analysisId) { this.bundle = bundle; this.analysisId = analysisId; }
        String id() { return analysisId + ":" + (++sequence); }
        String node(Node ast, String kind, String parent) {
            return node(ast, kind, parent, null);
        }
        String node(Node ast, String kind, String parent, String caption) {
            if (buildingFlow && nodes.size() - methodNodeStart >= MAX_FLOW_NODES_PER_METHOD) throw new FlowLimit();
            String id = id();
            Map<String, SourceRange> fieldRanges = Map.of();
            boolean readOnly = Set.of("condition_test", "switch_selector", "switch_case", "foreach_source", "catch_test", "catch_entry", "finally_entry", "try_entry", "resource_init").contains(kind);
            if (!opaqueMethod && !readOnly && ast instanceof Expression expression && !expression.isVariableDeclarationExpr()) {
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
                if (ast.getParentNode().orElse(null) instanceof MethodDeclaration method && method.isStatic()
                        && Set.of("int","boolean").contains(method.getTypeAsString())) operations.add("decompose_class");
                positions = List.of("body_start", "body_end");
            } else if (!opaqueMethod && !"expression".equals(kind) && statementContainer(ast) != null) {
                if (!containsComment(ast)) operations.add("replace_statement");
                operations.add("insert_statement");
                if (!containsComment(ast)) operations.add("delete_statement");
                operations.add("move_statement");
                if (MethodExtraction.eligible(ast)) operations.add("extract_method");
                operations.add("wrap_if");
                if (!capturesJump(ast)) operations.add("wrap_while");
                if (canAddElse(ast)) operations.add("add_else");
                if (canRemoveElse(ast)) operations.add("remove_else");
                positions = List.of("before", "after");
            }
            if (!opaqueMethod && !readOnly && ("entry".equals(kind) || ast instanceof ExpressionStmt) && LocalRename.eligible(ast)) operations.add("rename_local");
            String text = caption != null ? caption : ast == null || "entry".equals(kind) ? kind : raw(ast);
            if (text.length() > 180) text = text.substring(0, 177) + "...";
            nodes.add(new GraphNode(id, bundle.revisionId(), analysisId, methodId, kind, text,
                    ast == null ? null : map.range(ast), id, parent, ast == null, fields, fieldRanges, operations, positions, executionRole(ast, kind)));
            if (ast != null) { bindings.put(id, ast); astIds.put(ast, id); }
            return id;
        }
        String raw(Node ast) {
            SourceRange range = map.range(ast);
            return map.source.substring(range.startOffset(), range.endOffset());
        }
        String rawLabels(SwitchEntry entry) {
            if (entry.isDefault()) return "default";
            SourceRange first = map.range(entry.getLabels().getFirst().orElseThrow());
            SourceRange last = map.range(entry.getLabels().getLast().orElseThrow());
            return map.source.substring(first.startOffset(), last.endOffset());
        }
        String executionRole(Node ast, String kind) {
            if ("condition_test".equals(kind) || "catch_test".equals(kind)) return "condition_test";
            if ("expression".equals(kind)) return "ast_projection";
            if (ast == null) return "synthetic";
            if ("entry".equals(kind) || "block".equals(kind) || "switch_case".equals(kind) || ast instanceof IfStmt || ast instanceof WhileStmt
                    || ast instanceof DoStmt || ast instanceof ForStmt || ast instanceof ForEachStmt || ast instanceof SwitchStmt
                    || Set.of("opaque", "try_entry", "catch_entry", "finally_entry").contains(kind)) return "structural";
            return "statement";
        }
        void edge(String source, String target, String kind) {
            edge(source, target, kind, null);
        }
        void edge(String source, String target, String kind, String label) {
            edge(source, target, kind, label, completionContext, "exact", null);
        }
        void edge(String source, String target, String kind, String label, String context, String certainty, String reason) {
            if (source != null && target != null) {
                if (buildingFlow && edges.size() - methodEdgeStart >= MAX_FLOW_EDGES_PER_METHOD) throw new FlowLimit();
                edges.add(new Edge(id(), source, target, kind, label, context, certainty, reason));
            }
        }
        void method(CallableDeclaration<?> callable, BlockStmt body, String declaration, String fqName, SourceMap sourceMap) {
            methodId = id(); map = sourceMap; astIds.clear(); completionContext = null;
            methodNodeStart = nodes.size(); methodEdgeStart = edges.size();
            boolean conditionLimit = conditionLimitExceeded(body);
            boolean switchLimit = switchLimitExceeded(body);
            boolean iterationLimit = body.findAll(ForEachStmt.class).size() > MAX_FOREACH_LOOPS_PER_METHOD;
            opaqueMethod = unsupportedFlow(body) || conditionLimit || switchLimit || iterationLimit;
            root = node(body, "entry", null);
            normalExit = node(null, "normal_exit", null);
            exceptionalExit = node(null, "exceptional_exit", null);
            String first;
            if (opaqueMethod) {
                first = node(body, "opaque", root);
                String code = conditionLimit ? "CONDITION_FLOW_LIMIT" : switchLimit ? "SWITCH_FLOW_LIMIT" : iterationLimit ? "ITERATION_FLOW_LIMIT" : "UNSUPPORTED_CONTROL_FLOW";
                String reason = conditionLimit ? "Method preserved; condition-flow test budget exceeded"
                        : switchLimit ? "Method preserved; switch entry/label budget exceeded"
                        : iterationLimit ? "Method preserved; enhanced-for iteration budget exceeded" : "Method preserved; precise flow and graph edits unavailable for this control structure";
                diagnostics.add(new Diagnostic(id(), "warning", code, reason, map.range(body)));
                edge(first, normalExit, "normal", null, null, "conservative", "Opaque method may complete normally");
                edge(first, exceptionalExit, "throw", null, null, "conservative", "Opaque method may complete exceptionally");
            } else {
                buildingFlow = true;
                try { first = flow(body, normalExit, null, null, root); }
                catch (FlowLimit limit) {
                    Set<String> discarded = new HashSet<>();
                    nodes.subList(methodNodeStart, nodes.size()).forEach(n -> discarded.add(n.id()));
                    nodes.subList(methodNodeStart, nodes.size()).clear(); edges.subList(methodEdgeStart, edges.size()).clear();
                    discarded.forEach(bindings::remove); astIds.clear(); opaqueMethod = true; buildingFlow = false; completionContext = null;
                    root = node(body, "entry", null); normalExit = node(null, "normal_exit", null); exceptionalExit = node(null, "exceptional_exit", null);
                    first = node(body, "opaque", root);
                    diagnostics.add(new Diagnostic(id(), "warning", "EXCEPTION_FLOW_LIMIT", "Method preserved; context-specific control-flow expansion exceeded its node/edge budget", map.range(body)));
                    edge(first, normalExit, "normal", null, null, "conservative", "Opaque method may complete normally");
                    edge(first, exceptionalExit, "throw", null, null, "conservative", "Opaque method may complete exceptionally");
                } finally { buildingFlow = false; completionContext = null; }
            }
            edge(root, first, "normal");
            if (!opaqueMethod && !body.findAll(TryStmt.class).isEmpty()) pruneUnreachableFlow();
            // Expressions are selectable source-bound AST projections, not additional executable CFG statements.
            for (Expression expression : body.findAll(Expression.class)) {
                Node ancestor = expression.getParentNode().orElse(null);
                while (ancestor != null && !astIds.containsKey(ancestor)) ancestor = ancestor.getParentNode().orElse(null);
                node(expression, "expression", ancestor == null ? root : astIds.get(ancestor));
            }
            methods.add(new Method(methodId, declaration, fqName, callable.getSignature().asString(), map.range(callable),
                    root, List.of(normalExit, exceptionalExit)));
        }
        void pruneUnreachableFlow() {
            Set<String> keep = new HashSet<>(List.of(root));
            Map<String,List<String>> successors = new HashMap<>();
            for (int i = methodEdgeStart; i < edges.size(); i++) {
                Edge e = edges.get(i); successors.computeIfAbsent(e.source(), ignored -> new ArrayList<>()).add(e.target());
            }
            Deque<String> pending = new ArrayDeque<>(); pending.add(root);
            while (!pending.isEmpty()) for (String target : successors.getOrDefault(pending.remove(), List.of())) if (keep.add(target)) pending.add(target);
            Map<String,GraphNode> current = new HashMap<>();
            nodes.subList(methodNodeStart, nodes.size()).forEach(n -> current.put(n.id(), n));
            for (String id : List.copyOf(keep)) {
                GraphNode n = current.get(id);
                while (n != null && n.parentId() != null && keep.add(n.parentId())) n = current.get(n.parentId());
            }
            keep.add(normalExit); keep.add(exceptionalExit);
            Set<String> discarded = new HashSet<>(current.keySet()); discarded.removeAll(keep);
            nodes.subList(methodNodeStart, nodes.size()).removeIf(n -> discarded.contains(n.id()));
            edges.subList(methodEdgeStart, edges.size()).removeIf(e -> discarded.contains(e.source()) || discarded.contains(e.target()));
            discarded.forEach(bindings::remove); astIds.clear();
            for (GraphNode n : nodes.subList(methodNodeStart, nodes.size())) if (bindings.containsKey(n.id())) astIds.put(bindings.get(n.id()), n.id());
        }
        boolean conditionLimitExceeded(BlockStmt body) {
            int total = 0;
            for (Statement statement : body.findAll(Statement.class)) {
                Expression expression = condition(statement);
                if (expression != null) {
                    total += conditionAtoms(expression);
                    if (total > MAX_CONDITION_TESTS_PER_METHOD) return true;
                }
            }
            return false;
        }
        boolean switchLimitExceeded(BlockStmt body) {
            int entries = 0, labels = 0;
            for (SwitchStmt statement : body.findAll(SwitchStmt.class)) {
                entries += statement.getEntries().size();
                for (SwitchEntry entry : statement.getEntries()) labels += entry.getLabels().size();
                if (entries > MAX_SWITCH_ENTRIES_PER_METHOD || labels > MAX_SWITCH_LABELS_PER_METHOD) return true;
            }
            return false;
        }
        int conditionAtoms(Expression expression) {
            if (expression instanceof EnclosedExpr enclosed) return conditionAtoms(enclosed.getInner());
            if (expression instanceof UnaryExpr unary && unary.getOperator() == UnaryExpr.Operator.LOGICAL_COMPLEMENT) return conditionAtoms(unary.getExpression());
            if (expression instanceof BinaryExpr binary && (binary.getOperator() == BinaryExpr.Operator.AND || binary.getOperator() == BinaryExpr.Operator.OR)) {
                return conditionAtoms(binary.getLeft()) + conditionAtoms(binary.getRight());
            }
            return 1;
        }
        String flow(Statement stmt, String next, String breakTarget, String continueTarget, String parent) {
            boolean exceptions = !stmt.findAll(TryStmt.class).isEmpty();
            return flow(stmt, next, new FlowContext(() -> normalExit, () -> exceptionalExit,
                    () -> breakTarget, () -> continueTarget, null, exceptions), parent);
        }
        String flow(Statement stmt, String next, FlowContext context, String parent) {
            String previous = completionContext; completionContext = context.tag();
            try { return statementFlow(stmt, next, context, parent); }
            finally { completionContext = previous; }
        }
        String statementFlow(Statement stmt, String next, FlowContext context, String parent) {
            if (stmt instanceof BlockStmt block) {
                String blockId = node(block, "block", parent), cursor = next;
                List<Statement> children = block.getStatements();
                for (int i = children.size() - 1; i >= 0; i--) cursor = flow(children.get(i), cursor, context, blockId);
                return cursor;
            }
            if (stmt instanceof TryStmt statement) return tryFlow(statement, next, context, parent);
            String current = node(stmt, stmt.getClass().getSimpleName(), parent);
            if (stmt instanceof IfStmt branch) {
                String yes = flow(branch.getThenStmt(), next, context, current);
                String no = branch.getElseStmt().map(s -> flow(s, next, context, current)).orElse(next);
                edge(current, conditionFlow(branch.getCondition(), yes, no, current, context), "normal");
            } else if (stmt instanceof WhileStmt loop) {
                String back = node(null, "loop_back", current); edge(back, current, "loop");
                String body = flow(loop.getBody(), back, context.jumps(next, current), current);
                edge(current, conditionFlow(loop.getCondition(), body, next, current, context), "normal");
            } else if (stmt instanceof DoStmt loop) {
                String back = node(null, "loop_back", current);
                String body = flow(loop.getBody(), current, context.jumps(next, current), current);
                edge(back, body, "loop");
                edge(current, conditionFlow(loop.getCondition(), back, next, current, context), "normal"); return body;
            } else if (stmt instanceof ForStmt loop) {
                String back = node(null, "loop_back", current); edge(back, current, "loop");
                String update = back;
                for (int i = loop.getUpdate().size() - 1; i >= 0; i--) {
                    Expression expression = loop.getUpdate().get(i);
                    String step = node(expression, "for_update", current); edge(step, update, "normal"); mayThrow(step, expression, context); update = step;
                }
                String body = flow(loop.getBody(), update, context.jumps(next, update), current);
                edge(current, loop.getCompare().map(compare -> conditionFlow(compare, body, next, current, context)).orElse(body), "normal");
                String init = current;
                for (int i = loop.getInitialization().size() - 1; i >= 0; i--) {
                    Expression expression = loop.getInitialization().get(i);
                    String step = node(expression, "for_init", current); edge(step, init, "normal"); mayThrow(step, expression, context); init = step;
                }
                return init;
            } else if (stmt instanceof ForEachStmt loop) {
                String source = node(loop.getIterable(), "foreach_source", current);
                String check = node(null, "foreach_check", current);
                String bind = node(null, "foreach_bind", current);
                String advance = node(null, "foreach_advance", current);
                // Common normal iteration only: advance is continuation, not an Iterator method.
                edge(advance, check, "loop");
                String body = flow(loop.getBody(), advance, context.jumps(next, advance), current);
                edge(current, source, "normal");
                edge(source, check, "normal");
                edge(check, bind, "true"); edge(check, next, "false");
                edge(bind, body, "normal");
                mayThrow(source, loop.getIterable(), context);
                possibleException(check, context, "Array/Iterable iteration may fail; concrete protocol and runtime exception type are not inferred");
                possibleException(bind, context, "Element binding may cast or unbox; runtime exception type is not inferred");
                possibleException(advance, context, "Iterator advancement may fail; concrete protocol and runtime exception type are not inferred");
            } else if (stmt instanceof SwitchStmt statement) {
                String selector = node(statement.getSelector(), "switch_selector", current);
                List<String> entryIds = new ArrayList<>();
                List<String> labels = new ArrayList<>();
                for (SwitchEntry entry : statement.getEntries()) {
                    String label = rawLabels(entry);
                    labels.add(label);
                    entryIds.add(node(entry, "switch_case", current, entry.isDefault() ? "default:" : "case " + label + ":"));
                }
                String cursor = next;
                for (int i = statement.getEntries().size() - 1; i >= 0; i--) {
                    String first = cursor;
                    List<Statement> body = statement.getEntry(i).getStatements();
                    FlowContext branchContext = new FlowContext(context.returned(), context.thrown(), () -> next, context.continued(), context.tag(), context.exceptions());
                    for (int j = body.size() - 1; j >= 0; j--) first = flow(body.get(j), first, branchContext, entryIds.get(i));
                    edge(entryIds.get(i), first, "normal");
                    cursor = entryIds.get(i);
                }
                boolean hasDefault = false;
                for (int i = 0; i < statement.getEntries().size(); i++) {
                    boolean fallback = statement.getEntry(i).isDefault();
                    hasDefault |= fallback;
                    edge(selector, entryIds.get(i), fallback ? "default" : "case", labels.get(i));
                }
                if (!hasDefault) edge(selector, next, "default", "нет совпадения");
                edge(current, selector, "normal");
                possibleException(selector, context, "Selector evaluation, unboxing or null selector may fail; runtime exception type is not inferred");
            } else if (stmt instanceof ReturnStmt returned) {
                edge(current, context.returned().get(), "return");
                returned.getExpression().ifPresent(expression -> mayThrow(current, expression, context));
            } else if (stmt instanceof ThrowStmt) edge(current, context.thrown().get(), "throw", "исключение");
            else if (stmt instanceof BreakStmt) edge(current, context.broken().get(), "break");
            else if (stmt instanceof ContinueStmt) edge(current, context.continued().get(), "continue");
            else {
                edge(current, next, "normal");
                if (stmt instanceof ExpressionStmt expression) mayThrow(current, expression.getExpression(), context);
                else if (!(stmt instanceof EmptyStmt)) possibleException(current, context, "Atomic statement evaluation may fail; runtime exception type is not inferred");
            }
            return current;
        }
        String tryFlow(TryStmt statement, String next, FlowContext outer, String parent) {
            if (statement.getResources().size() > MAX_RESOURCES_PER_TRY) throw new FlowLimit();
            String entry = node(statement, "try_entry", parent, "try");
            Finalizer cleanup = new Finalizer(statement.getFinallyBlock().orElse(null), outer, entry);
            FlowContext handler = new FlowContext(() -> cleanup.to("return", outer.returned()),
                    () -> cleanup.to("throw", outer.thrown()), () -> cleanup.to("break", outer.broken()),
                    () -> cleanup.to("continue", outer.continued()), outer.tag(), true);
            String after = cleanup.to("normal", () -> next);
            LazyTarget dispatch = new LazyTarget(() -> inContext(outer.tag(), () -> {
                String cursor = handler.thrown().get();
                for (int i = statement.getCatchClauses().size() - 1; i >= 0; i--) {
                    CatchClause clause = statement.getCatchClauses().get(i);
                    String type = raw(clause.getParameter().getType());
                    String test = node(clause.getParameter(), "catch_test", entry, "исключение instanceof " + type);
                    String caught = node(clause, "catch_entry", entry, "catch (" + raw(clause.getParameter()) + ")");
                    edge(caught, flow(clause.getBody(), after, handler, caught), "catch", type);
                    edge(test, caught, "true", type); edge(test, cursor, "false", "другой тип");
                    cursor = test;
                }
                return cursor;
            }));
            FlowContext body = new FlowContext(handler.returned(), dispatch, handler.broken(), handler.continued(), outer.tag(), true);
            edge(entry, resourceFlow(statement, 0, after, body, entry), "normal");
            return entry;
        }
        String resourceFlow(TryStmt statement, int index, String next, FlowContext outer, String parent) {
            if (index == statement.getResources().size()) return flow(statement.getTryBlock(), next, outer, parent);
            Expression resource = statement.getResources().get(index);
            String name = resource instanceof VariableDeclarationExpr declaration
                    ? declaration.getVariable(0).getNameAsString() : raw(resource);
            String init = node(resource, "resource_init", parent, raw(resource));
            ResourceFinalizer cleanup = new ResourceFinalizer(name, outer, init);
            FlowContext acquired = new FlowContext(() -> cleanup.to("return", outer.returned()),
                    () -> cleanup.to("throw", outer.thrown()), () -> cleanup.to("break", outer.broken()),
                    () -> cleanup.to("continue", outer.continued()), outer.tag(), true);
            String after = cleanup.to("normal", () -> next);
            edge(init, resourceFlow(statement, index + 1, after, acquired, init), "normal");
            // Initialization failure is outside this resource's cleanup, but inside earlier resources.
            mayThrow(init, resource, outer);
            return init;
        }
        String inContext(String tag, Supplier<String> build) {
            String previous = completionContext; completionContext = tag;
            try { return build.get(); }
            finally { completionContext = previous; }
        }
        private final class LazyTarget implements Supplier<String> {
            private final Supplier<String> factory;
            private String value;
            private boolean built;
            LazyTarget(Supplier<String> factory) { this.factory = factory; }
            public String get() { if (!built) { value = factory.get(); built = true; } return value; }
        }
        private final class Finalizer {
            private final BlockStmt body;
            private final FlowContext outer;
            private final String parent;
            private final Map<String,String> copies = new HashMap<>();
            Finalizer(BlockStmt body, FlowContext outer, String parent) { this.body = body; this.outer = outer; this.parent = parent; }
            String to(String completion, Supplier<String> continuation) {
                String target = continuation.get();
                if (body == null || target == null) return target;
                String key = completion + ":" + target;
                if (copies.containsKey(key)) return copies.get(key);
                String tag = parent + ":" + key;
                String title = switch (completion) {
                    case "return" -> "возврат"; case "throw" -> "исключение";
                    case "break" -> "выход из цикла"; case "continue" -> "следующая итерация";
                    default -> "продолжение";
                };
                String entry = node(body, "finally_entry", parent, "finally · " + title);
                copies.put(key, entry);
                String resume = node(null, "finally_resume", entry, "Продолжить: " + title);
                edge(resume, target, "resume", title, tag, "exact", "Resume the saved completion only when finally completes normally");
                String first = flow(body, resume, outer.tagged(tag), entry);
                edge(entry, first, "finally", title, tag, "exact", "Execute cleanup before resuming the saved completion");
                return entry;
            }
        }
        /** JLS14.20.3 resource wrapper, applied recursively in acquisition order. */
        private final class ResourceFinalizer {
            private final String name;
            private final FlowContext outer;
            private final String parent;
            private final Map<String,String> copies = new HashMap<>();
            ResourceFinalizer(String name, FlowContext outer, String parent) {
                this.name = name; this.outer = outer; this.parent = parent;
            }
            String to(String completion, Supplier<String> continuation) {
                String target = continuation.get();
                if (target == null) return null;
                String key = completion + ":" + target;
                if (copies.containsKey(key)) return copies.get(key);
                return inContext(outer.tag(), () -> {
                    String tag = parent + ":resource:" + key;
                    boolean primary = completion.equals("throw");
                    String title = switch (completion) {
                        case "return" -> "возврат"; case "throw" -> "исключение";
                        case "break" -> "выход из цикла"; case "continue" -> "следующая итерация";
                        default -> "продолжение";
                    };
                    String check = node(null, "resource_check", parent, name + " != null");
                    String entry = primary ? node(null, "resource_primary", parent, "Сохранить основное исключение · " + name) : check;
                    copies.put(key, entry);
                    String resume = node(null, "resource_resume", parent, "Продолжить: " + title + " · " + name);
                    String close = node(null, "resource_close", parent, name + ".close()");
                    String thrown = outer.thrown().get();
                    if (primary) edge(entry, check, "resource_close", "сохранить исключение", tag, "exact", "Capture the pending Throwable before closing this resource");
                    edge(check, close, "true", "да", tag, "exact", "Close the captured resource snapshot only when non-null; do not reevaluate its initializer/reference");
                    edge(check, resume, "false", "нет", tag, "exact", "Null resource is skipped");
                    edge(close, resume, "normal", "закрыт", tag, "exact", "close completed normally; retain the pending completion");
                    edge(resume, target, "resume", primary ? "основное исключение" : title, tag, "exact", "Resume only this saved completion after resource cleanup");
                    String failed = node(null, "resource_throw", parent, "Ошибка " + (primary ? "addSuppressed" : "close") + " заменяет " + title + " · " + name);
                    edge(failed, thrown, "resource_exception", "новое исключение", tag, "exact", "The newly thrown close/suppression exception replaces the pending completion; enclosing acquired resources still close");
                    if (!primary) {
                        edge(close, failed, "exception", "ошибка close", tag, "conservative", "The atomic captured resource.close() call may throw; runtime exception type is not inferred");
                    } else {
                        String same = node(null, "resource_suppression_check", parent, "ошибка close == основное исключение · " + name);
                        String suppress = node(null, "resource_suppress", parent, "основное.addSuppressed(ошибка close) · " + name);
                        String self = node(null, "resource_throw", parent, "IllegalArgumentException · самоподавление · " + name);
                        edge(close, same, "exception", "ошибка close", tag, "conservative", "close may throw while a primary Throwable is pending; compare exception identity before adding suppression");
                        edge(same, self, "true", "да", tag, "exact", "Self-suppression throws a new IllegalArgumentException even when suppression is disabled");
                        edge(self, thrown, "resource_exception", "новое исключение", tag, "exact", "Self-suppression replaces the primary Throwable; enclosing resources receive the new exception");
                        edge(same, suppress, "false", "нет", tag, "exact", "Distinct close failure is passed to primary.addSuppressed");
                        edge(suppress, resume, "suppressed", "основное сохранено", tag, "exact", "Atomic addSuppressed returns normally: preserve the primary; append the close failure only if suppression is enabled");
                        edge(suppress, failed, "exception", "ошибка addSuppressed", tag, "conservative", "addSuppressed may fail, for example due to allocation failure; the newly thrown exception replaces the primary");
                    }
                    return entry;
                });
            }
        }
        void mayThrow(String source, Expression expression, FlowContext context) {
            if (expression instanceof LiteralExpr || expression instanceof ThisExpr || expression instanceof SuperExpr || expression instanceof ClassExpr) return;
            if (expression instanceof VariableDeclarationExpr declaration && declaration.getVariables().stream().allMatch(v -> v.getInitializer().isEmpty() || v.getInitializer().orElseThrow() instanceof LiteralExpr)) return;
            possibleException(source, context, "Atomic Java expression may throw (including calls, dereference, casts, arithmetic or unboxing); runtime type is not inferred");
        }
        void possibleException(String source, FlowContext context, String reason) {
            if (context.exceptions()) edge(source, context.thrown().get(), "exception", "возможно исключение", context.tag(), "conservative", reason);
        }
        /** Each atom is evaluated once; exceptional completion goes to the current handler chain. */
        String conditionFlow(Expression expression, String yes, String no, String parent, FlowContext context) {
            if (expression instanceof EnclosedExpr enclosed) return conditionFlow(enclosed.getInner(), yes, no, parent, context);
            if (expression instanceof UnaryExpr unary && unary.getOperator() == UnaryExpr.Operator.LOGICAL_COMPLEMENT) {
                return conditionFlow(unary.getExpression(), no, yes, parent, context);
            }
            if (expression instanceof BinaryExpr binary) {
                if (binary.getOperator() == BinaryExpr.Operator.AND) {
                    String right = conditionFlow(binary.getRight(), yes, no, parent, context);
                    return conditionFlow(binary.getLeft(), right, no, parent, context);
                }
                if (binary.getOperator() == BinaryExpr.Operator.OR) {
                    String right = conditionFlow(binary.getRight(), yes, no, parent, context);
                    return conditionFlow(binary.getLeft(), yes, right, parent, context);
                }
            }
            String test = node(expression, "condition_test", parent);
            edge(test, yes, "true"); edge(test, no, "false");
            if (!(expression instanceof BooleanLiteralExpr)) possibleException(test, context, "Atomic condition evaluation or unboxing may throw; runtime type is not inferred");
            return test;
        }
    }
}
