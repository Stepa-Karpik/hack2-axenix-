package dev.javablueprints.engine;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import dev.javablueprints.engine.EngineModel.*;

import javax.lang.model.SourceVersion;
import java.util.*;
import java.util.function.Function;
import java.util.regex.Pattern;

/** Closed primitive static helpers only; original declarations remain forwarding wrappers. */
final class ClassDecomposition {
    private ClassDecomposition() {}

    record Result(Map<String, String> files, List<TextChange> changes, String filePath,
                  String className, String originalMethodName) {
        Result { files = Map.copyOf(files); changes = List.copyOf(changes); }
    }

    static Result rewrite(SourceBundle bundle, Analysis analysis, GraphNode selected, Node target,
                          Function<Node, SourceRange> range, String className) {
        if (className == null || !className.matches("[A-Za-z_$][A-Za-z0-9_$]{0,79}")
                || !SourceVersion.isIdentifier(className) || SourceVersion.isKeyword(className)
                || Set.of("var", "yield", "record", "sealed", "permits", "when").contains(className))
            throw unsupported("Utility class name must be a non-keyword Java identifier of at most80 ASCII characters");
        if (!(target instanceof BlockStmt body)
                || !(body.getParentNode().orElse(null) instanceof MethodDeclaration method)
                || !"entry".equals(selected.kind()))
            throw unsupported("Select the entry of a concrete static method");
        if (!(method.getParentNode().orElse(null) instanceof ClassOrInterfaceDeclaration owner)
                || !(owner.getParentNode().orElse(null) instanceof CompilationUnit unit)
                || owner.isInterface() || !owner.getExtendedTypes().isEmpty()
                || !owner.getImplementedTypes().isEmpty() || !owner.getTypeParameters().isEmpty())
            throw unsupported("Utility extraction requires a top-level ordinary class without inheritance or generic owner parameters");
        if (!method.isStatic() || method.isAbstract() || method.isNative() || method.isSynchronized()
                || !method.getAnnotations().isEmpty() || !method.getTypeParameters().isEmpty()
                || !method.getThrownExceptions().isEmpty() || method.getReceiverParameter().isPresent()
                || !primitive(method.getTypeAsString()))
            throw unsupported("Only unannotated concrete static int/boolean helpers without generics, throws or synchronization are supported");
        for (Parameter parameter : method.getParameters()) {
            if (parameter.isVarArgs() || !parameter.getAnnotations().isEmpty()
                    || !primitive(parameter.getTypeAsString()))
                throw unsupported("Parameters must be explicit int/boolean values without annotations or varargs");
        }
        if (method.findAll(com.github.javaparser.ast.expr.AnnotationExpr.class).size() != 0)
            throw unsupported("Annotated declarations and types cannot be relocated");
        SourceRange bodyRange = range.apply(body);
        if (!Objects.equals(bodyRange, selected.sourceRange()))
            throw new EngineException("ANALYSIS_CONFLICT", "Selected entry does not bind to the exact method body");
        String originalPath = bodyRange.filePath();
        String source = bundle.files().get(originalPath);
        if (source == null || bodyRange.startOffset() < 0 || bodyRange.endOffset() > source.length())
            throw new EngineException("ANALYSIS_CONFLICT", "Method source is unavailable");
        if (analysis.graph().nodes().stream().anyMatch(n -> n.methodId().equals(selected.methodId()) && n.kind().equals("opaque")))
            throw unsupported("Opaque or budget-limited methods cannot be decomposed");
        if (body.findAll(Node.class).size() > 4096)
            throw unsupported("Utility extraction is limited to4096 AST nodes");
        checkStatements(body);
        checkExpressions(body);
        checkBindings(analysis, body, bodyRange, range);

        String directory = originalPath.contains("/") ? originalPath.substring(0, originalPath.lastIndexOf('/') + 1) : "";
        String newPath = directory + className + ".java";
        if (bundle.files().keySet().stream().anyMatch(path -> path.equalsIgnoreCase(newPath)))
            throw unsupported("Utility target file already exists, including a case-insensitive path collision");
        // A new same-package type can shadow wildcard imports in any bundle file. Refuse existing
        // identifiers conservatively, even in unsupported methods, rather than rewriting bindings.
        Pattern name = Pattern.compile("(?<![\\p{javaJavaIdentifierPart}])" + Pattern.quote(className) + "(?![\\p{javaJavaIdentifierPart}])");
        if (bundle.files().values().stream().anyMatch(text -> name.matcher(text).find())
                || analysis.declarations().stream().anyMatch(d -> d.kind().equals("type") && d.name().equalsIgnoreCase(className)))
            throw unsupported("Utility class name collides with an existing project identifier or type");
        String packageName = unit.getPackageDeclaration().map(p -> p.getNameAsString()).orElse("");
        String qualifier = packageName.isEmpty() ? className : packageName + "." + className;
        if (!packageName.isEmpty()) {
            String first = packageName.split("\\.")[0];
            if (owner.findAll(com.github.javaparser.ast.expr.SimpleName.class).stream().anyMatch(n -> n.asString().equals(first)))
                throw unsupported("A declaration shadows the utility call's package qualifier");
        }
        // Package annotations do not belong in the generated unit and can depend on annotation
        // processing. Decline instead of silently changing the package annotation environment.
        if (unit.getPackageDeclaration().filter(p -> !p.getAnnotations().isEmpty()).isPresent())
            throw unsupported("Annotated packages are outside utility extraction scope");
        String parameters = String.join(", ", method.getParameters().stream()
                .map(p -> p.getTypeAsString() + " " + p.getNameAsString()).toList());
        String arguments = String.join(", ", method.getParameters().stream().map(Parameter::getNameAsString).toList());
        String before = source.substring(bodyRange.startOffset(), bodyRange.endOffset());
        String wrapper = "{ return " + qualifier + "." + method.getNameAsString() + "(" + arguments + "); }";
        String added = (packageName.isEmpty() ? "" : "package " + packageName + ";\n\n")
                + "final class " + className + " {\n"
                + "    private " + className + "() {}\n"
                + "    static " + method.getTypeAsString() + " " + method.getNameAsString()
                + "(" + parameters + ") " + before + "\n}\n";
        Map<String, String> files = new TreeMap<>(bundle.files());
        files.put(originalPath, source.substring(0, bodyRange.startOffset()) + wrapper + source.substring(bodyRange.endOffset()));
        files.put(newPath, added);
        try { new SourceBundle(bundle.revisionId(), files); }
        catch (IllegalArgumentException failure) { throw unsupported("Utility candidate exceeds source bundle limits: " + failure.getMessage()); }
        return new Result(files, List.of(
                new TextChange(originalPath, bodyRange.startOffset(), bodyRange.endOffset(), before, wrapper),
                new TextChange(newPath, 0, 0, "", added)), newPath, className, method.getNameAsString());
    }

    private static boolean primitive(String type) { return type.equals("int") || type.equals("boolean"); }

    private static void checkStatements(BlockStmt body) {
        for (Statement statement : body.findAll(Statement.class)) {
            if (!(statement instanceof BlockStmt || statement instanceof ExpressionStmt || statement instanceof ReturnStmt
                    || statement instanceof IfStmt || statement instanceof ForStmt || statement instanceof WhileStmt
                    || statement instanceof DoStmt || statement instanceof BreakStmt || statement instanceof ContinueStmt
                    || statement instanceof EmptyStmt))
                throw unsupported("Statement is outside the closed primitive utility scope: " + statement.getClass().getSimpleName());
            if (statement instanceof BreakStmt breakJump && breakJump.getLabel().isPresent()
                    || statement instanceof ContinueStmt continueJump && continueJump.getLabel().isPresent())
                throw unsupported("Labelled control transfers cannot be relocated");
            if (statement instanceof ReturnStmt returned && returned.getExpression().isEmpty())
                throw unsupported("Utility extraction requires an int/boolean return value");
        }
        for (VariableDeclarator variable : body.findAll(VariableDeclarator.class))
            if (!primitive(variable.getTypeAsString()))
                throw unsupported("Local variables must have explicit int/boolean types");
    }

    private static void checkExpressions(BlockStmt body) {
        for (Expression expression : body.findAll(Expression.class)) {
            if (!(expression instanceof IntegerLiteralExpr || expression instanceof BooleanLiteralExpr
                    || expression instanceof NameExpr || expression instanceof EnclosedExpr || expression instanceof UnaryExpr
                    || expression instanceof BinaryExpr || expression instanceof AssignExpr
                    || expression instanceof VariableDeclarationExpr || expression instanceof ConditionalExpr))
                throw unsupported("Expression has a call, state, type or exceptional dependency outside primitive utility scope: " + expression.getClass().getSimpleName());
            if (expression instanceof BinaryExpr binary
                    && (binary.getOperator() == BinaryExpr.Operator.DIVIDE || binary.getOperator() == BinaryExpr.Operator.REMAINDER)
                    && !nonzeroLiteral(binary.getRight()))
                throw unsupported("Division and remainder require a statically nonzero integer literal divisor");
            if (expression instanceof AssignExpr assignment
                    && (assignment.getOperator() == AssignExpr.Operator.DIVIDE || assignment.getOperator() == AssignExpr.Operator.REMAINDER)
                    && !nonzeroLiteral(assignment.getValue()))
                throw unsupported("Compound division and remainder require a statically nonzero integer literal divisor");
        }
    }

    private static boolean nonzeroLiteral(Expression expression) {
        if (!(expression instanceof IntegerLiteralExpr literal)) return false;
        try { return literal.asNumber().intValue() != 0; }
        catch (RuntimeException failure) { return false; }
    }

    private static void checkBindings(Analysis analysis, BlockStmt body, SourceRange bodyRange,
                                      Function<Node, SourceRange> range) {
        Map<String, Symbol> symbols = new HashMap<>();
        analysis.semantics().symbols().forEach(symbol -> symbols.put(symbol.id(), symbol));
        for (NameExpr name : body.findAll(NameExpr.class)) {
            SourceRange use = range.apply(name);
            List<Reference> matches = analysis.semantics().references().stream()
                    .filter(reference -> reference.kind().equals("name") && Objects.equals(reference.sourceRange(), use)).toList();
            if (matches.size() != 1 || !matches.getFirst().resolution().equals("exact")
                    || matches.getFirst().targetIds().size() != 1)
                throw unsupported("Every primitive name must have one exact local or parameter binding: " + name.getNameAsString());
            Symbol symbol = symbols.get(matches.getFirst().targetIds().getFirst());
            if (symbol == null || symbol.external() || !Set.of("local", "parameter").contains(symbol.kind())
                    || !primitive(symbol.resolvedType() == null ? "" : symbol.resolvedType()))
                throw unsupported("Field, external or unknown state dependency: " + name.getNameAsString());
            if (symbol.sourceRange() == null || !symbol.sourceRange().filePath().equals(bodyRange.filePath()))
                throw unsupported("Primitive binding belongs to another source file");
            // Parameters precede the body; ownerId still binds both locals and parameters to the
            // selected callable, so a same-named value from another scope cannot be accepted.
            Method selectedMethod = analysis.graph().methods().stream()
                    .filter(method -> method.sourceRange().filePath().equals(bodyRange.filePath())
                            && method.sourceRange().startOffset() <= bodyRange.startOffset()
                            && method.sourceRange().endOffset() >= bodyRange.endOffset()).findFirst().orElseThrow();
            Symbol callable = analysis.semantics().symbols().stream()
                    .filter(candidate -> Objects.equals(candidate.declarationId(), selectedMethod.declarationId()))
                    .findFirst().orElse(null);
            if (callable == null || !Objects.equals(symbol.ownerId(), callable.id()))
                throw unsupported("Primitive binding is not owned by the selected method");
        }
    }

    private static EngineException unsupported(String reason) {
        return new EngineException("UNSUPPORTED_OPERATION", reason);
    }
}
