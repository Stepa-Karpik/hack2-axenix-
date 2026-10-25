package dev.javablueprints.engine;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.SwitchEntry;
import dev.javablueprints.engine.EngineModel.EngineException;
import java.util.Objects;

/** Literal case edits only. The isolated compiler still checks selector types and all constant expressions. */
final class CaseLabelEdits {
    private CaseLabelEdits() {}
    private record Constant(String category, Object value) {}

    static boolean eligible(Node node) {
        if (!(node instanceof Expression expression)) return false;
        Expression root = labelRoot(expression);
        return root == expression && constant(expression) != null && !InitializerProjection.hasInternalComment(expression);
    }

    static void validate(Expression original, Expression replacement) {
        Expression root = labelRoot(original);
        if (root == null) return;
        if (root != original || !eligible(original)) throw unsupported("Only an entire comment-free literal case label can be edited");
        Constant before = constant(original), after = constant(replacement);
        if (after == null || !Objects.equals(before.category(), after.category())
                || InitializerProjection.hasInternalComment(replacement))
            throw unsupported("Case replacement requires an int/char or String literal in the original label category");
        var entry = (SwitchEntry) original.getParentNode().orElseThrow();
        Node owner = entry.getParentNode().orElseThrow();
        for (SwitchEntry sibling : owner.getChildNodes().stream().filter(SwitchEntry.class::isInstance).map(SwitchEntry.class::cast).toList())
            for (Expression label : sibling.getLabels())
                if (label != original && after.equals(constant(label)))
                    throw unsupported("Replacement would duplicate an existing literal case value");
    }

    private static Expression labelRoot(Expression expression) {
        Node cursor = expression;
        while (cursor != null) {
            Node parent = cursor.getParentNode().orElse(null);
            if (parent instanceof SwitchEntry entry) {
                if (entry.getType() != SwitchEntry.Type.STATEMENT_GROUP || entry.getGuard().isPresent()) return null;
                return cursor instanceof Expression root && entry.getLabels().stream().anyMatch(label -> label == root) ? root : null;
            }
            cursor = parent;
        }
        return null;
    }

    private static Constant constant(Expression expression) {
        try {
            if (expression instanceof EnclosedExpr enclosed) return constant(enclosed.getInner());
            if (expression instanceof IntegerLiteralExpr integer) return new Constant("integral", integer.asNumber().intValue());
            if (expression instanceof CharLiteralExpr character) return new Constant("integral", (int) character.asChar());
            if (expression instanceof StringLiteralExpr string) return new Constant("string", string.asString());
            if (expression instanceof UnaryExpr unary && (unary.getOperator() == UnaryExpr.Operator.MINUS || unary.getOperator() == UnaryExpr.Operator.PLUS)) {
                Constant inner = constant(unary.getExpression());
                if (inner != null && inner.category().equals("integral"))
                    return new Constant("integral", unary.getOperator() == UnaryExpr.Operator.MINUS ? -(Integer) inner.value() : inner.value());
            }
        } catch (RuntimeException ignored) { /* unknown/invalid numeric literals remain compiler-gated */ }
        return null;
    }

    private static EngineException unsupported(String message) { return new EngineException("UNSUPPORTED_OPERATION", message); }
}
