package dev.javablueprints.engine;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import dev.javablueprints.engine.EngineModel.*;

import java.util.*;
import java.util.function.Function;
import java.util.function.Supplier;

/** Source/AST containment only: deliberately independent of callable control-flow construction. */
final class InitializerProjection {
    private static final int MAX_PER_TYPE = 1024, MAX_PER_BUNDLE = 4096, MAX_NODES = 4096;
    private InitializerProjection() {}

    /** Allocate authoritative declaration identities even when the optional semantic symbol budget is exhausted. */
    static void declareFields(Collection<CompilationUnit> units, Map<Node, String> declarationIds,
                              Function<Node, SourceRange> ranges, Supplier<String> ids, List<Declaration> declarations) {
        for (CompilationUnit unit : units) for (ClassOrInterfaceDeclaration type : unit.findAll(ClassOrInterfaceDeclaration.class)) {
            if (!supportedType(type)) continue;
            for (BodyDeclaration<?> member : type.getMembers()) if (member instanceof FieldDeclaration field)
                for (VariableDeclarator variable : field.getVariables()) {
                    if (declarationIds.containsKey(variable)) continue;
                    String id = ids.get(); declarationIds.put(variable, id);
                    SourceRange range = ranges.apply(variable);
                    declarations.add(new Declaration(id, range.filePath(), "field", variable.getNameAsString(), declarationIds.get(type), range));
                }
        }
    }

    static List<InitializerContext> inspect(SourceBundle bundle, String analysisId,
            Collection<CompilationUnit> units, Map<Node, String> declarationIds, SemanticModel semantics,
            Function<Node, SourceRange> ranges, Supplier<String> ids, Map<String, Node> bindings) {
        List<InitializerContext> contexts = new ArrayList<>();
        Map<String, String> fieldSymbols = new HashMap<>();
        for (Symbol symbol : semantics.symbols()) if ("field".equals(symbol.kind()))
            fieldSymbols.put(symbol.declarationId(), symbol.id());
        for (CompilationUnit unit : units) for (ClassOrInterfaceDeclaration type : unit.findAll(ClassOrInterfaceDeclaration.class)) {
            if (!supportedType(type)) continue;
            int staticStream = 0, instanceStream = 0, typeCount = 0, staticBlocks = 0, instanceBlocks = 0;
            for (int memberIndex = 0; memberIndex < type.getMembers().size(); memberIndex++) {
                BodyDeclaration<?> member = type.getMember(memberIndex);
                List<Node> roots = new ArrayList<>();
                if (member instanceof FieldDeclaration field) {
                    for (VariableDeclarator variable : field.getVariables()) variable.getInitializer().ifPresent(roots::add);
                } else if (member instanceof InitializerDeclaration initializer) roots.add(initializer.getBody());
                for (Node root : roots) {
                    if (++typeCount > MAX_PER_TYPE || contexts.size() >= MAX_PER_BUNDLE)
                        throw new EngineException("ANALYSIS_LIMIT", "Initializer context budget exceeded (1024/type, 4096/bundle)");
                    FieldDeclaration field = member instanceof FieldDeclaration f ? f : null;
                    VariableDeclarator variable = root.getParentNode().orElse(null) instanceof VariableDeclarator v ? v : null;
                    boolean isStatic = field != null ? type.isInterface() || field.isStatic() : ((InitializerDeclaration) member).isStatic();
                    boolean isFinal = field != null && (type.isInterface() || field.isFinal());
                    String kind = field != null ? "field_initializer" : isStatic ? "static_initializer_block" : "instance_initializer_block";
                    String label = variable != null ? variable.getNameAsString() : isStatic ? "static block #" + (++staticBlocks) : "instance block #" + (++instanceBlocks);
                    String contextId = ids.get();
                    String declarationId = variable == null ? null : declarationIds.get(variable);
                    List<Node> selected = projectionNodes(root);
                    String reason = opaqueReason(root);
                    if (selected.size() > MAX_NODES) reason = "projection_node_budget";
                    boolean opaque = reason != null;
                    if (opaque) selected = List.of(root);
                    Map<Node, String> nodeIds = new IdentityHashMap<>();
                    List<InitializerNode> nodes = new ArrayList<>();
                    List<Edge> edges = new ArrayList<>();
                    for (Node node : selected) {
                        String id = ids.get();
                        nodeIds.put(node, id);
                        Node parent = node.getParentNode().orElse(null);
                        while (parent != null && !nodeIds.containsKey(parent)) parent = parent.getParentNode().orElse(null);
                        String parentId = parent == null ? null : nodeIds.get(parent);
                        SourceRange range = ranges.apply(node);
                        String text = bundle.files().get(range.filePath()).substring(range.startOffset(), range.endOffset());
                        if (text.length() > 180) text = text.substring(0, 177) + "...";
                        boolean editable = !opaque && editableExpression(node);
                        String nodeKind = opaque ? "opaque" : node instanceof Expression ? "expression" : node instanceof BlockStmt ? "block" : "statement";
                        nodes.add(new InitializerNode(id, bundle.revisionId(), analysisId, contextId,
                                nodeKind, text, range, id, parentId, node instanceof Expression ? "ast_projection" : "structural",
                                editable ? List.of("expression") : List.of(), editable ? Map.of("expression", range) : Map.of(),
                                editable ? List.of("replace_expression") : List.of()));
                        bindings.put(id, node);
                        if (parentId != null) edges.add(new Edge(ids.get(), parentId, id, "contains", null, null, "exact", "AST containment only"));
                    }
                    contexts.add(new InitializerContext(contextId, kind, declarationIds.get(type), declarationId,
                            fieldSymbols.get(declarationId), label, ranges.apply(root), ranges.apply(member),
                            isStatic, isFinal, memberIndex, variable == null ? null : field.getVariables().indexOf(variable),
                            isStatic ? staticStream++ : instanceStream++, "unknown", "ast_source",
                            opaque ? "opaque" : "supported", opaque ? reason : "Source/AST containment; no lifecycle or execution-order CFG", nodes, edges));
                }
            }
        }
        return List.copyOf(contexts);
    }

    /**
     * Declared initialization order per class (JLS 12.4.2 static phase; 12.5 per constructor):
     * explicit this(...) delegates without running instance initializers itself; otherwise an
     * explicit or implicit super(...) precedes instance initializers in source order, then the body.
     */
    static List<InitializationOrder> orders(Collection<CompilationUnit> units, Map<Node, String> declarationIds,
            List<InitializerContext> contexts, List<Method> methods, Function<Node, SourceRange> ranges) {
        Map<String, String> methodByDeclaration = new HashMap<>();
        for (Method method : methods) methodByDeclaration.put(method.declarationId(), method.id());
        Map<String, List<InitializerContext>> byType = new HashMap<>();
        for (InitializerContext context : contexts)
            byType.computeIfAbsent(context.ownerTypeDeclarationId(), unused -> new ArrayList<>()).add(context);
        List<InitializationOrder> orders = new ArrayList<>();
        for (CompilationUnit unit : units) for (ClassOrInterfaceDeclaration type : unit.findAll(ClassOrInterfaceDeclaration.class)) {
            if (!supportedType(type)) continue;
            String typeId = declarationIds.get(type);
            if (typeId == null) continue;
            List<InitializerContext> own = byType.getOrDefault(typeId, List.of()).stream()
                    .sorted(Comparator.comparingInt(InitializerContext::streamIndex)).toList();
            Function<InitializerContext, InitializationStep> step = context -> new InitializationStep(context.kind(),
                    context.label(), context.id(), null, context.declarationRange());
            List<InitializationStep> staticPhase = own.stream().filter(InitializerContext::effectiveStatic).map(step).toList();
            List<InitializationStep> instancePhase = own.stream().filter(c -> !c.effectiveStatic()).map(step).toList();
            List<ConstructorInitialization> constructors = new ArrayList<>();
            String superLabel = type.getExtendedTypes().isEmpty() ? "super() → Object" : "super() → " + type.getExtendedTypes(0).getNameAsString();
            if (!type.isInterface() && type.getConstructors().isEmpty()) {
                List<InitializationStep> steps = new ArrayList<>();
                steps.add(new InitializationStep("implicit_super_call", superLabel, null, null, null));
                steps.addAll(instancePhase);
                constructors.add(new ConstructorInitialization(null, type.getNameAsString() + "()", true, "implicit_super", steps));
            }
            for (ConstructorDeclaration constructor : type.getConstructors()) {
                String methodId = methodByDeclaration.get(declarationIds.get(constructor));
                var first = constructor.getBody().getStatements().getFirst().orElse(null);
                List<InitializationStep> steps = new ArrayList<>();
                String delegation;
                if (first instanceof ExplicitConstructorInvocationStmt call) {
                    String text = call.toString().replaceAll("\\s+", " ");
                    if (text.length() > 120) text = text.substring(0, 117) + "...";
                    delegation = call.isThis() ? "this" : "super";
                    steps.add(new InitializationStep(call.isThis() ? "this_call" : "super_call", text, null, methodId, ranges.apply(call)));
                } else {
                    delegation = "implicit_super";
                    steps.add(new InitializationStep("implicit_super_call", superLabel, null, methodId, null));
                }
                if (!"this".equals(delegation)) steps.addAll(instancePhase);
                steps.add(new InitializationStep("constructor_body", constructor.getDeclarationAsString(false, false, false),
                        null, methodId, ranges.apply(constructor.getBody())));
                constructors.add(new ConstructorInitialization(methodId, constructor.getDeclarationAsString(false, false, false),
                        false, delegation, steps));
            }
            boolean opaque = own.stream().anyMatch(c -> !"supported".equals(c.coverage()));
            orders.add(new InitializationOrder(typeId, type.getNameAsString(), staticPhase, constructors,
                    opaque ? "partial" : "declared_order",
                    "Declared source order of this class; superclass phases, class-loading triggers and abrupt completion are not modeled"
                            + (opaque ? "; some initializers are opaque" : "")));
        }
        return List.copyOf(orders);
    }

    private static boolean supportedType(ClassOrInterfaceDeclaration type) {
        Node parent = type.getParentNode().orElse(null);
        return parent instanceof CompilationUnit || parent instanceof ClassOrInterfaceDeclaration outer && supportedType(outer);
    }

    private static List<Node> projectionNodes(Node root) {
        List<Node> result = new ArrayList<>();
        Deque<Node> pending = new ArrayDeque<>(); pending.push(root);
        while (!pending.isEmpty()) {
            Node node = pending.pop();
            if (node instanceof Expression || node instanceof Statement) result.add(node);
            if (result.size() > MAX_NODES) break;
            // Unsupported callable domains are represented by the opaque root, never expanded.
            if (node instanceof LambdaExpr || node instanceof TypeDeclaration<?> || node instanceof CallableDeclaration<?>
                    || node instanceof ObjectCreationExpr creation && creation.getAnonymousClassBody().isPresent()) continue;
            var children = node.getChildNodes();
            for (int i = children.size() - 1; i >= 0; i--) pending.push(children.get(i));
        }
        return result;
    }

    static String opaqueReason(Node root) {
        for (Node node : root.findAll(Node.class)) {
            if (node instanceof LambdaExpr || node instanceof MethodReferenceExpr || node instanceof SwitchExpr
                    || node instanceof AnnotationExpr || node instanceof TypeDeclaration<?> || node instanceof LocalClassDeclarationStmt
                    || node instanceof ObjectCreationExpr creation && creation.getAnonymousClassBody().isPresent())
                return "unsupported_nested_domain";
        }
        return null;
    }

    /** Shared source-expression gate; comment and Java-only pseudo-expression roots are read-only. */
    static boolean editableExpression(Node node) {
        if (!(node instanceof Expression expression) || expression instanceof ArrayInitializerExpr
                || expression instanceof VariableDeclarationExpr || expression instanceof TypeExpr
                || expression instanceof PatternExpr || expression instanceof SuperExpr
                || expression instanceof AnnotationExpr || expression instanceof LambdaExpr || expression instanceof SwitchExpr
                || expression instanceof MethodReferenceExpr) return false;
        // Case constants and annotation arguments carry additional context restrictions; do not advertise them.
        for (Node cursor = node; cursor != null; cursor = cursor.getParentNode().orElse(null)) {
            if (cursor instanceof AnnotationExpr) return false;
            if (cursor instanceof SwitchEntry entry && entry.getLabels().stream().anyMatch(label -> label == node || label.isAncestorOf(node))) return false;
            if (cursor instanceof Statement || cursor instanceof VariableDeclarator) break;
        }
        return !hasInternalComment(node);
    }

    static boolean hasInternalComment(Node node) {
        return node.getTokenRange().map(tokens -> {
            for (var token : tokens) if (token.getCategory().isComment()) return true;
            return false;
        }).orElse(true);
    }

    static SemanticModel attachReferences(SemanticModel model, List<InitializerContext> contexts) {
        Map<String, NavigableMap<Integer, InitializerContext>> byFile = new HashMap<>();
        for (InitializerContext context : contexts) if ("supported".equals(context.coverage()))
            byFile.computeIfAbsent(context.sourceRange().filePath(), unused -> new TreeMap<>())
                    .put(context.sourceRange().startOffset(), context);
        List<Reference> references = model.references().stream().map(reference -> {
            if (reference.enclosingCallableId() != null || reference.sourceRange() == null) return reference;
            SourceRange range = reference.sourceRange();
            var fileContexts = byFile.get(range.filePath());
            var nearest = fileContexts == null ? null : fileContexts.floorEntry(range.startOffset());
            String contextId = nearest != null && contains(nearest.getValue().sourceRange(), range) ? nearest.getValue().id() : null;
            return new Reference(reference.id(), reference.kind(), reference.name(), range, null, reference.resolution(),
                    reference.targetIds(), reference.resolvedType(), reference.dispatch(), reference.runtimeTargetIds(), reference.reason(), contextId);
        }).toList();
        return new SemanticModel(model.schemaVersion(), model.environment(), model.symbols(), references, model.limitations());
    }

    private static boolean contains(SourceRange outer, SourceRange inner) {
        return outer.filePath().equals(inner.filePath()) && outer.startOffset() <= inner.startOffset() && outer.endOffset() >= inner.endOffset();
    }
}
