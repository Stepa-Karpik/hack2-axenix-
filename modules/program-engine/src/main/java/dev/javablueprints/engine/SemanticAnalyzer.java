package dev.javablueprints.engine;

import com.github.javaparser.ast.*;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.resolution.declarations.*;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.javaparsermodel.JavaParserFacade;
import com.github.javaparser.symbolsolver.javaparsermodel.declarations.*;
import com.github.javaparser.symbolsolver.resolution.typesolvers.*;
import dev.javablueprints.engine.EngineModel.*;

import java.util.*;
import java.util.function.Function;
import java.util.function.Supplier;

/** One snapshot, in memory. Never adds an application classloader, filesystem solver or jar path. */
final class SemanticAnalyzer {
    private static final String SCHEMA = "semantic-v1";
    private static final String RESOLVER = "javaparser-symbol-solver-3.28.2";
    private static final String CONFIG = "bundle-platform-java-javax-v1;java21;preview=false;types=1000;refs=10000;symbols=20000;astDepth=128;astNodes=100000";
    private static final int MAX_REFERENCES = 10000, MAX_SYMBOLS = 20000, MAX_TYPES = 1000;

    static SymbolEnvironment environment() {
        String jdk = Runtime.version().toString(), vendor = System.getProperty("java.vendor", "unknown");
        // Include the runtime module inventory, without machine paths or the ambient classpath.
        String modules = ModuleLayer.boot().modules().stream().filter(m -> m.getClassLoader() != ClassLoader.getSystemClassLoader())
                .map(m -> m.getDescriptor().toNameAndVersion()).sorted().reduce("", (a, b) -> a + "\n" + b);
        String hash = ProgramEngine.sourceHash(SCHEMA + "\n" + RESOLVER + "\n" + CONFIG + "\n" + jdk + "\n" + vendor + modules);
        return new SymbolEnvironment(SCHEMA, RESOLVER, CONFIG, jdk, vendor, hash);
    }

    record Result(SemanticModel model, List<Declaration> declarations) {}
    static synchronized Result inspect(String analysisId, Map<String, CompilationUnit> units,
                                       Function<Node, SourceRange> ranges, Map<Node, String> declarationIds) {
        // JavaParserFacade owns an internal process-wide cache. Serialize access and release all
        // facade/type-solver references after this analysis, including exceptional exits.
        try { return new SemanticAnalyzer(analysisId, units, ranges, declarationIds).analyze(); }
        finally { JavaParserFacade.clearInstances(); }
    }

    static String typeName(TypeDeclaration<?> type) {
        List<String> names = new ArrayList<>();
        for (Node node = type; node != null; node = node.getParentNode().orElse(null)) {
            if (node instanceof TypeDeclaration<?> owner) names.add(owner.getNameAsString());
        }
        Collections.reverse(names);
        String prefix = type.findCompilationUnit().flatMap(CompilationUnit::getPackageDeclaration).map(p -> p.getNameAsString() + ".").orElse("");
        return prefix + String.join(".", names);
    }
    static String ownerName(Node node) { return node.findAncestor(TypeDeclaration.class).map(SemanticAnalyzer::typeName).orElse("<unknown>"); }

    private final String analysisId;
    private final Map<String, CompilationUnit> units;
    private final Function<Node, SourceRange> ranges;
    private final Map<Node, String> declarationIds;
    private final Map<Node, Symbol> sourceSymbols = new IdentityHashMap<>();
    private final Map<String, Node> symbolNodes = new HashMap<>();
    private final Map<String, Symbol> externalSymbols = new LinkedHashMap<>();
    private final Map<String, Symbol> implicitConstructors = new HashMap<>();
    private final List<Symbol> symbols = new ArrayList<>();
    private final List<Reference> references = new ArrayList<>();
    private final List<Declaration> declarations = new ArrayList<>();
    private final Set<String> limitations = new LinkedHashSet<>();
    private final CombinedTypeSolver solver = new CombinedTypeSolver();
    private String sourceProblem;
    private int sequence;

    private SemanticAnalyzer(String id, Map<String, CompilationUnit> units, Function<Node, SourceRange> ranges, Map<Node, String> declarationIds) {
        this.analysisId = id; this.units = units; this.ranges = ranges; this.declarationIds = declarationIds;
    }
    private String id(String kind) { return analysisId + ":" + kind + (++sequence); }

    private Result analyze() {
        limitations.add("Partial Java semantic analysis; compilation and runtime dispatch are separate checks");
        limitations.add("No alias, escape, effect, dominance, access-control or full generic-inference proof");
        if (Runtime.version().feature() != 21) sourceProblem = "unsupported_jdk_runtime";
        Map<String, List<ClassOrInterfaceDeclaration>> types = new LinkedHashMap<>();
        for (CompilationUnit unit : units.values()) {
            if (unit.getPackageDeclaration().map(p -> p.getNameAsString().equals("java") || p.getNameAsString().startsWith("java.")
                    || p.getNameAsString().equals("javax") || p.getNameAsString().startsWith("javax.")).orElse(false)) sourceProblem = "reserved_source_package";
            for (ClassOrInterfaceDeclaration type : unit.findAll(ClassOrInterfaceDeclaration.class)) {
                if (!supportedType(type)) { limitations.add("Local/anonymous classes are outside semantic binding scope"); continue; }
                types.computeIfAbsent(typeName(type), unused -> new ArrayList<>()).add(type);
            }
        }
        if (types.values().stream().anyMatch(v -> v.size() > 1)) sourceProblem = "ambiguous_source_declarations";
        if (types.size() > MAX_TYPES) sourceProblem = "semantic_type_budget";
        else if (cyclicInheritance(types)) sourceProblem = "cyclic_source_inheritance";
        MemoryTypeSolver memory = new MemoryTypeSolver();
        solver.add(memory);
        solver.add(new ClassLoaderTypeSolver(ClassLoader.getPlatformClassLoader()) {
            @Override protected boolean filterName(String name) { return name.startsWith("java.") || name.startsWith("javax."); }
        });
        JavaSymbolSolver resolver = new JavaSymbolSolver(solver);
        units.values().forEach(resolver::inject);
        if (sourceProblem == null) types.forEach((name, found) -> {
            ClassOrInterfaceDeclaration type = found.getFirst();
            memory.addDeclaration(name, type.isInterface() ? new JavaParserInterfaceDeclaration(type, solver) : new JavaParserClassDeclaration(type, solver));
        });
        // Declare before resolving uses, so source-backed targets always use this analysis's IDs.
        for (CompilationUnit unit : units.values()) {
            for (Node node : unit.findAll(Node.class)) {
                if (symbols.size() >= MAX_SYMBOLS) { sourceProblem = "semantic_symbol_budget"; break; }
                if (isDeclaration(node)) declare(node);
            }
        }
        detectDuplicateMembers();
        for (CompilationUnit unit : units.values()) {
            for (Node node : unit.findAll(Node.class)) {
                if (!isReference(node)) continue;
                if (references.size() >= MAX_REFERENCES) { limitations.add("semantic_reference_budget"); break; }
                reference(node);
            }
        }
        if (sourceProblem != null) limitations.add(sourceProblem);
        return new Result(new SemanticModel(SCHEMA, environment(), symbols, references, List.copyOf(limitations)), declarations);
    }

    private static boolean supportedType(ClassOrInterfaceDeclaration type) {
        Node parent = type.getParentNode().orElse(null);
        return parent instanceof CompilationUnit || parent instanceof ClassOrInterfaceDeclaration outer && supportedType(outer);
    }
    private static boolean isDeclaration(Node node) {
        return node instanceof TypeDeclaration<?> || node instanceof CallableDeclaration<?> || node instanceof Parameter
                || node instanceof VariableDeclarator;
    }
    private static boolean isReference(Node node) {
        return node instanceof NameExpr || node instanceof FieldAccessExpr || node instanceof MethodCallExpr
                || node instanceof ObjectCreationExpr || node instanceof ThisExpr || node instanceof ClassOrInterfaceType;
    }
    private String kind(Node node) {
        if (node instanceof TypeDeclaration<?>) return "type";
        if (node instanceof ConstructorDeclaration) return "constructor";
        if (node instanceof MethodDeclaration) return "method";
        if (node instanceof Parameter) return "parameter";
        return node.getParentNode().orElse(null) instanceof FieldDeclaration ? "field" : "local";
    }
    private Node nameNode(Node node) {
        if (node instanceof TypeDeclaration<?> n) return n.getName();
        if (node instanceof CallableDeclaration<?> n) return n.getName();
        if (node instanceof Parameter n) return n.getName();
        return ((VariableDeclarator) node).getName();
    }
    private String name(Node node) { return nameNode(node).toString(); }
    private Symbol enclosing(Node node) {
        for (Node parent = node.getParentNode().orElse(null); parent != null; parent = parent.getParentNode().orElse(null)) {
            if (sourceSymbols.containsKey(parent)) return sourceSymbols.get(parent);
        }
        return null;
    }
    private void declare(Node node) {
        String kind = kind(node), name = name(node);
        Symbol owner = enclosing(node);
        String declaredType = node instanceof VariableDeclarator v ? v.getTypeAsString() : node instanceof Parameter p ? p.getTypeAsString()
                : node instanceof MethodDeclaration m ? m.getTypeAsString() : null;
        String resolvedType = sourceProblem == null ? attempt(() -> {
            if (node instanceof VariableDeclarator v) return v.getType().resolve().describe();
            if (node instanceof Parameter p) return p.getType().resolve().describe();
            if (node instanceof MethodDeclaration m) return m.getType().resolve().describe();
            if (node instanceof TypeDeclaration<?> t) return typeName(t);
            return null;
        }) : null;
        String signature = null;
        if (node instanceof CallableDeclaration<?> callable) {
            signature = sourceProblem == null ? attempt(() -> callable instanceof MethodDeclaration m ? m.resolve().getQualifiedSignature()
                    : ((ConstructorDeclaration) callable).resolve().getQualifiedSignature()) : null;
            if (signature == null) signature = ownerName(node) + "." + callable.getSignature().asString();
        }
        String qualifiedName = node instanceof TypeDeclaration<?> t ? typeName(t)
                : node instanceof CallableDeclaration<?> ? ownerName(node) + "." + name
                : (owner == null ? "<unknown>" : owner.qualifiedName()) + "." + name;
        String declarationId = declarationIds.get(node);
        if (declarationId == null) {
            declarationId = id("d");
            declarationIds.put(node, declarationId);
            SourceRange range = ranges.apply(node);
            declarations.add(new Declaration(declarationId, range.filePath(), kind, name,
                    owner == null ? null : owner.declarationId(), range));
        }
        Symbol symbol = new Symbol(id("s"), declarationId, kind, name, owner == null ? null : owner.id(), qualifiedName,
                signature, declaredType, resolvedType, false, null, ranges.apply(nameNode(node)));
        symbols.add(symbol); sourceSymbols.put(node, symbol); symbolNodes.put(symbol.id(), node);
        if (node instanceof TypeDeclaration<?> && !(node instanceof ClassOrInterfaceDeclaration)) limitations.add("Unsupported semantic type domain: " + node.getClass().getSimpleName());
    }

    private <T> T attempt(Supplier<T> action) {
        if (sourceProblem != null) return null;
        try { return action.get(); }
        catch (StackOverflowError failure) { sourceProblem = "solver_recursion_limit"; return null; }
        catch (LinkageError failure) { sourceProblem = "solver_linkage_failure"; return null; }
        catch (RuntimeException failure) { return null; }
    }
    private String callableId(Node node) {
        for (Node cursor = node; cursor != null; cursor = cursor.getParentNode().orElse(null)) {
            if (cursor instanceof CallableDeclaration<?> && sourceSymbols.containsKey(cursor)) return sourceSymbols.get(cursor).id();
        }
        return null;
    }
    private String unsupportedDomain(Node node) {
        for (Node cursor = node; cursor != null; cursor = cursor.getParentNode().orElse(null)) {
            if (cursor instanceof LambdaExpr || cursor instanceof LocalClassDeclarationStmt
                    || cursor instanceof ObjectCreationExpr o && o.getAnonymousClassBody().isPresent()
                    || cursor instanceof TypeDeclaration<?> t && !(t instanceof ClassOrInterfaceDeclaration)) return "unsupported_semantic_domain";
        }
        return null;
    }
    private void reference(Node node) {
        String kind = node instanceof MethodCallExpr ? "call" : node instanceof ObjectCreationExpr ? "constructor"
                : node instanceof FieldAccessExpr ? "field" : node instanceof ThisExpr ? "this" : node instanceof ClassOrInterfaceType ? "type" : "name";
        String name = node instanceof MethodCallExpr n ? n.getNameAsString() : node instanceof FieldAccessExpr n ? n.getNameAsString()
                : node instanceof NameExpr n ? n.getNameAsString() : node instanceof ClassOrInterfaceType n ? n.getNameAsString() : node.toString();
        List<String> targets = List.of();
        String resolution = "unresolved", dispatch = kind.equals("call") || kind.equals("constructor") ? "unknown" : "none";
        String reason = sourceProblem != null ? sourceProblem : unsupportedDomain(node), type = null;
        if (reason == null && (node instanceof MethodCallExpr || node instanceof FieldAccessExpr || node instanceof ObjectCreationExpr)) {
            for (NameExpr use : node.findAll(NameExpr.class)) {
                ResolvedDeclaration value = attempt(use::resolve);
                Symbol valueTarget = value == null ? null : attempt(() -> target(value));
                if (valueTarget != null && !lexicallyVisible(use, valueTarget)) { reason = "out_of_scope_or_before_declaration"; break; }
            }
        }
        if (reason == null) {
            // A conservative ambiguity guard complements the solver: it must not select an
            // arbitrary null overload or an invalid use-before-declaration binding.
            List<Symbol> ambiguous = nullOverloadCandidates(node);
            if (ambiguous.size() > 1) {
                targets = ambiguous.stream().map(Symbol::id).toList(); resolution = "candidates"; reason = "ambiguous_overload";
            } else if (node instanceof MethodCallExpr call && call.getArguments().stream().anyMatch(SemanticAnalyzer::isUntypedNull)
                    && ambiguous.isEmpty()) {
                // No proof that an external/inherited/null overload set is unique in this bounded pass.
                reason = "null_overload_not_proven";
            } else {
                ResolvedDeclaration resolved = ambiguous.size() == 1 && node instanceof MethodCallExpr call
                        && call.getArguments().stream().anyMatch(SemanticAnalyzer::isUntypedNull)
                        ? attempt(() -> ((MethodDeclaration) symbolNodes.get(ambiguous.getFirst().id())).resolve()) : attempt(() -> resolve(node));
                Symbol target = resolved == null ? null : attempt(() -> target(resolved));
                if (target != null && node instanceof NameExpr && !lexicallyVisible(node, target)) {
                    target = null; reason = "out_of_scope_or_before_declaration";
                }
                if (target != null) {
                    targets = List.of(target.id()); resolution = "exact";
                    if (resolved instanceof ResolvedMethodDeclaration method) dispatch = method.isStatic() ? "static"
                            : node instanceof MethodCallExpr call && call.getScope().filter(s -> s instanceof SuperExpr).isPresent() ? "direct" : "virtual";
                    else if (resolved instanceof ResolvedConstructorDeclaration) dispatch = "direct";
                    type = attempt(() -> node instanceof Expression expr ? expr.calculateResolvedType().describe()
                            : ((ClassOrInterfaceType) node).resolve().describe());
                } else if (reason == null) reason = "unresolved_or_unsupported";
            }
        }
        if (!resolution.equals("exact")) limitations.add("Some references are unresolved, ambiguous or outside the bounded semantic scope");
        references.add(new Reference(id("r"), kind, name, ranges.apply(node), callableId(node), resolution, targets, type, dispatch, List.of(), reason));
    }

    private ResolvedDeclaration resolve(Node node) {
        if (node instanceof MethodCallExpr n) return n.resolve();
        if (node instanceof ObjectCreationExpr n) return n.resolve();
        if (node instanceof FieldAccessExpr n) return n.resolve();
        if (node instanceof ThisExpr n) return n.calculateResolvedType().asReferenceType().getTypeDeclaration().orElseThrow();
        if (node instanceof ClassOrInterfaceType n) return n.resolve().asReferenceType().getTypeDeclaration().orElseThrow();
        NameExpr n = (NameExpr) node;
        ResolvedDeclaration value = attempt(n::resolve);
        if (value != null) return value;
        // Type qualifiers such as System or a source class are NameExpr in call/field scopes.
        if (n.getParentNode().orElse(null) instanceof FieldAccessExpr || n.getParentNode().orElse(null) instanceof MethodCallExpr) {
            return n.calculateResolvedType().asReferenceType().getTypeDeclaration().orElseThrow();
        }
        return null;
    }

    private Symbol target(ResolvedDeclaration resolved) {
        Node ast = resolved.toAst().orElse(null);
        if (resolved instanceof ResolvedConstructorDeclaration constructor && (ast == null || ast instanceof TypeDeclaration<?>)) {
            Node ownerAst = constructor.declaringType().toAst().orElse(null);
            Symbol owner = sourceSymbols.get(ownerAst);
            if (owner != null) {
                String signature = constructor.getQualifiedSignature();
                Symbol existing = implicitConstructors.get(signature);
                if (existing != null) return existing;
                Symbol implicit = new Symbol(id("s"), owner.declarationId(), "constructor", constructor.getName(), owner.id(),
                        owner.qualifiedName() + "." + constructor.getName(), signature, null, owner.qualifiedName(), false, null, owner.sourceRange());
                implicitConstructors.put(signature, implicit); symbols.add(implicit);
                limitations.add("Implicit constructors navigate to their source type declaration");
                return implicit;
            }
        }
        if (ast != null) {
            Symbol source = sourceSymbols.get(ast);
            // Field resolution can associate the whole multi-variable FieldDeclaration.
            if (source == null && ast instanceof FieldDeclaration field) {
                source = field.getVariables().stream().filter(v -> v.getNameAsString().equals(resolved.getName())).map(sourceSymbols::get).filter(Objects::nonNull).findFirst().orElse(null);
            }
            if (source == null && ast instanceof VariableDeclarationExpr variables) {
                source = variables.getVariables().stream().filter(v -> v.getNameAsString().equals(resolved.getName())).map(sourceSymbols::get).filter(Objects::nonNull).findFirst().orElse(null);
            }
            return source;
        }
        String key, kind, ownerName, type = null, signature = null;
        if (resolved instanceof ResolvedMethodLikeDeclaration method) {
            ownerName = method.declaringType().getQualifiedName(); signature = method.getQualifiedSignature();
            kind = resolved instanceof ResolvedConstructorDeclaration ? "constructor" : "method"; key = kind + ":" + signature;
            if (resolved instanceof ResolvedMethodDeclaration m) type = attempt(() -> m.getReturnType().describe());
        } else if (resolved instanceof ResolvedFieldDeclaration field) {
            ownerName = field.declaringType().getQualifiedName(); kind = "field"; key = kind + ":" + ownerName + "." + field.getName(); type = field.getType().describe();
        } else if (resolved instanceof ResolvedReferenceTypeDeclaration declaration) {
            ownerName = declaration.getQualifiedName(); kind = "type"; key = "type:" + ownerName; type = ownerName;
        } else return null;
        if (!(ownerName.startsWith("java.") || ownerName.startsWith("javax."))) return null;
        Symbol found = externalSymbols.get(key);
        if (found != null) return found;
        if (symbols.size() >= MAX_SYMBOLS) { limitations.add("semantic_symbol_budget"); return null; }
        Symbol symbol = new Symbol(id("s"), null, kind, resolved.getName(), null,
                kind.equals("type") ? ownerName : ownerName + "." + resolved.getName(), signature, null, type, true, key, null);
        externalSymbols.put(key, symbol); symbols.add(symbol); return symbol;
    }

    private boolean lexicallyVisible(Node reference, Symbol target) {
        if (!target.kind().equals("local") && !target.kind().equals("parameter")) return true;
        Node declaration = symbolNodes.get(target.id());
        if (declaration == null) return false;
        if (target.kind().equals("parameter")) {
            Node owner = declaration.getParentNode().orElse(null);
            return owner != null && ancestor(reference, owner);
        }
        if (ranges.apply(reference).startOffset() < ranges.apply(declaration).endOffset()) return false;
        for (Node parent = declaration.getParentNode().orElse(null); parent != null; parent = parent.getParentNode().orElse(null)) {
            if (parent instanceof BlockStmt || parent instanceof ForStmt || parent instanceof ForEachStmt || parent instanceof TryStmt) return ancestor(reference, parent);
        }
        return false;
    }
    private static boolean ancestor(Node node, Node expected) {
        for (Node current = node; current != null; current = current.getParentNode().orElse(null)) if (current == expected) return true;
        return false;
    }

    private void detectDuplicateMembers() {
        Set<String> signatures = new HashSet<>();
        for (Symbol symbol : symbols) {
            if (!List.of("type", "method", "constructor", "field").contains(symbol.kind())) continue;
            String key = symbol.kind() + ":" + (symbol.signature() == null ? symbol.qualifiedName() : symbol.signature());
            if (!signatures.add(key)) sourceProblem = "ambiguous_source_declarations";
        }
        Map<String, List<Node>> variables = new HashMap<>();
        for (var entry : sourceSymbols.entrySet()) {
            Symbol symbol = entry.getValue();
            if (!symbol.kind().equals("parameter") && !symbol.kind().equals("local")) continue;
            String callable = callableId(entry.getKey());
            String key = callable + ":" + symbol.name();
            Node scope = variableScope(entry.getKey());
            for (Node prior : variables.getOrDefault(key, List.of())) {
                if (scope != null && (ancestor(scope, prior) || ancestor(prior, scope))) sourceProblem = "ambiguous_source_declarations";
            }
            if (scope != null) variables.computeIfAbsent(key, unused -> new ArrayList<>()).add(scope);
        }
    }
    private static Node variableScope(Node declaration) {
        if (declaration instanceof Parameter) return declaration.getParentNode().orElse(null);
        for (Node cursor = declaration; cursor != null; cursor = cursor.getParentNode().orElse(null)) {
            if (cursor instanceof BlockStmt || cursor instanceof ForStmt || cursor instanceof ForEachStmt || cursor instanceof TryStmt) return cursor;
        }
        return null;
    }
    private List<Symbol> nullOverloadCandidates(Node node) {
        if (!(node instanceof MethodCallExpr call) || call.getArguments().stream().noneMatch(SemanticAnalyzer::isUntypedNull)) return List.of();
        // Return source candidates only for this lexical owner; unrelated same-name methods do not count.
        String owner = ownerName(node);
        if (call.getScope().isPresent() && !(call.getScope().orElseThrow() instanceof ThisExpr)) {
            String resolvedOwner = attempt(() -> call.getScope().orElseThrow().calculateResolvedType().asReferenceType().getQualifiedName());
            if (resolvedOwner == null) return List.of();
            owner = resolvedOwner;
        }
        String qualified = owner + "." + call.getNameAsString();
        String finalOwner = owner;
        boolean inherited = sourceSymbols.keySet().stream().filter(n -> n instanceof ClassOrInterfaceDeclaration)
                .map(n -> (ClassOrInterfaceDeclaration) n).filter(t -> typeName(t).equals(finalOwner))
                .anyMatch(t -> !t.getExtendedTypes().isEmpty() || !t.getImplementedTypes().isEmpty());
        if (inherited) return List.of();
        List<Symbol> overloads = symbols.stream().filter(s -> s.kind().equals("method") && qualified.equals(s.qualifiedName())).toList();
        for (Symbol symbol : overloads) {
            Node declaration = symbolNodes.get(symbol.id());
            if (!(declaration instanceof MethodDeclaration method) || !method.getTypeParameters().isEmpty()
                    || method.getParameters().stream().anyMatch(Parameter::isVarArgs)
                    || method.getParameters().stream().anyMatch(p -> attempt(() -> p.getType().resolve()) == null)) return List.of();
        }
        List<Symbol> applicable = symbols.stream().filter(s -> s.kind().equals("method") && qualified.equals(s.qualifiedName()))
                .filter(s -> {
                    Node declaration = symbolNodes.get(s.id());
                    if (!(declaration instanceof MethodDeclaration method) || !method.getTypeParameters().isEmpty()
                            || method.getParameters().stream().anyMatch(Parameter::isVarArgs) || method.getParameters().size() != call.getArguments().size()) return false;
                    Boolean matches = attempt(() -> java.util.stream.IntStream.range(0, call.getArguments().size()).allMatch(i ->
                            method.getParameter(i).getType().resolve().isAssignableBy(call.getArgument(i).calculateResolvedType())));
                    return Boolean.TRUE.equals(matches);
                }).toList();
        // Invocation phases (strict invocation before boxing) need more than assignability.
        // Do not call such mixed applicable candidates ambiguous or select an arbitrary one.
        for (int i = 0; i < call.getArguments().size() && applicable.size() > 1; i++) {
            if (isUntypedNull(call.getArgument(i))) continue;
            int position = i;
            if (applicable.stream().map(s -> ((MethodDeclaration) symbolNodes.get(s.id())).getParameter(position).getType().isPrimitiveType()).distinct().count() > 1) return List.of();
        }
        return applicable.stream().filter(candidate -> applicable.stream().noneMatch(other -> other != candidate && moreSpecific(other, candidate))).toList();
    }
    private static boolean isUntypedNull(Expression expression) {
        while (expression instanceof EnclosedExpr enclosed) expression = enclosed.getInner();
        return expression.isNullLiteralExpr();
    }

    private boolean moreSpecific(Symbol first, Symbol second) {
        MethodDeclaration a = (MethodDeclaration) symbolNodes.get(first.id()), b = (MethodDeclaration) symbolNodes.get(second.id());
        Boolean result = attempt(() -> {
            boolean strict = false;
            for (int i = 0; i < a.getParameters().size(); i++) {
                var at = a.getParameter(i).getType().resolve(); var bt = b.getParameter(i).getType().resolve();
                if (!bt.isAssignableBy(at)) return false;
                strict |= !at.describe().equals(bt.describe());
            }
            return strict;
        });
        return Boolean.TRUE.equals(result);
    }

    private boolean cyclicInheritance(Map<String, List<ClassOrInterfaceDeclaration>> types) {
        Map<String, Set<String>> graph = new LinkedHashMap<>();
        for (var entry : types.entrySet()) {
            Set<String> parents = new HashSet<>();
            for (ClassOrInterfaceDeclaration type : entry.getValue()) {
                List<ClassOrInterfaceType> supers = new ArrayList<>(type.getExtendedTypes()); supers.addAll(type.getImplementedTypes());
                for (ClassOrInterfaceType parent : supers) for (String name : types.keySet()) {
                    if (name.equals(parent.getNameWithScope()) || name.endsWith("." + parent.getNameWithScope()) || name.equals(ownerPackage(type) + parent.getNameWithScope())) parents.add(name);
                }
            }
            graph.put(entry.getKey(), parents);
        }
        for (String start : graph.keySet()) {
            Set<String> seen = new HashSet<>(); Deque<String> pending = new ArrayDeque<>(graph.get(start));
            while (!pending.isEmpty()) {
                String next = pending.pop();
                if (next.equals(start)) return true;
                if (seen.add(next)) pending.addAll(graph.getOrDefault(next, Set.of()));
            }
        }
        return false;
    }
    private static String ownerPackage(Node node) { return node.findCompilationUnit().flatMap(CompilationUnit::getPackageDeclaration).map(p -> p.getNameAsString() + ".").orElse(""); }
}
