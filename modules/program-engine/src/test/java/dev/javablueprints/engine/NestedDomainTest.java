package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/** Parser/source tests only. None of the fixture Java is compiled or executed on the host. */
class NestedDomainTest {
    private final ProgramEngine engine = new ProgramEngine();
    private static final String SOURCE = """
        import java.util.*;
        public class Main {
          public static void main(String[] args) {
            List<Integer> xs = new ArrayList<>(List.of(3, 1, 2));
            Collections.sort(xs, new Comparator<Integer>() {
              @Override public int compare(Integer a, Integer b) { if (a > b) return 1; return a < b ? -1 : 0; }
            });
            Collections.sort(xs, new Comparator<Integer>() {
              @Override public int compare(Integer a, Integer b) { return b - a; }
            });
            class Local { int twice(int v) { int r = v * 2; return r; } }
            int shown = new Local().twice(4);
            System.out.println(xs + " " + shown);
          }
          static class Inner { int add(int a) { return a + 1; } }
        }
        """;
    private Method method(Analysis a, String fqName) {
        return a.graph().methods().stream().filter(m -> m.fullyQualifiedName().equals(fqName)).findFirst()
                .orElseThrow(() -> new AssertionError(fqName + " not in " + a.graph().methods().stream().map(Method::fullyQualifiedName).toList()));
    }
    private GraphNode node(Analysis a, Method m, String label) {
        return a.graph().nodes().stream().filter(n -> n.methodId().equals(m.id()) && label.equals(n.label()) && n.allowedOperations().contains("replace_expression")).findFirst().orElseThrow();
    }

    @Test void nestedMethodsHaveDistinctOwnerPaths() {
        var a = engine.inspect(new SourceBundle("base", Map.of("Main.java", SOURCE)));
        assertEquals(List.of("Main.main", "Main.main().new Comparator<Integer>(){}#1.compare", "Main.main().new Comparator<Integer>(){}#2.compare",
                "Main.main().Local.twice", "Main.Inner.add"), a.graph().methods().stream().map(Method::fullyQualifiedName).toList());
    }

    @Test void localClassDeclarationIsAnAtomicReadOnlyStepNotAnOpaqueMethod() {
        var bundle = new SourceBundle("base", Map.of("Main.java", SOURCE));
        var a = engine.inspect(bundle);
        var main = method(a, "Main.main");
        var nodes = a.graph().nodes().stream().filter(n -> n.methodId().equals(main.id())).toList();
        assertTrue(nodes.stream().noneMatch(n -> n.kind().equals("opaque")));
        var local = nodes.stream().filter(n -> n.kind().equals("LocalClassDeclarationStmt")).findFirst().orElseThrow();
        assertEquals("class Local { … }", local.label());
        assertTrue(local.allowedOperations().isEmpty());
        // Neighbouring statements of the enclosing method are editable again.
        var shown = node(a, main, "4");
        var candidate = engine.propose(bundle, a, new EditCommand("base", a.id(), main.id(), shown.id(), "replace_expression",
                new ReplaceExpression("expression", "5"), "semantic_edit"));
        assertTrue(candidate.files().get("Main.java").contains("new Local().twice((5))") || candidate.files().get("Main.java").contains("twice(5)"));
        // Captures make bounded rename/extraction refuse the enclosing method.
        assertFalse(nodes.stream().anyMatch(n -> n.allowedOperations().contains("rename_local")));
        assertFalse(nodes.stream().anyMatch(n -> n.allowedOperations().contains("extract_method")));
    }

    @Test void anonymousAndLocalClassMethodsAcceptTypedEdits() {
        var bundle = new SourceBundle("base", Map.of("Main.java", SOURCE));
        var a = engine.inspect(bundle);
        var first = method(a, "Main.main().new Comparator<Integer>(){}#1.compare");
        var condition = node(a, first, "a > b");
        var edited = engine.propose(bundle, a, new EditCommand("base", a.id(), first.id(), condition.id(), "replace_expression",
                new ReplaceExpression("expression", "a >= b"), "semantic_edit")).files().get("Main.java");
        assertTrue(edited.contains("if ((a >= b)) return 1;") || edited.contains("if (a >= b) return 1;"), edited);
        assertTrue(edited.contains("return b - a;"), "second anonymous body untouched");
        var twice = method(a, "Main.main().Local.twice");
        var product = node(a, twice, "v * 2");
        var local = engine.propose(bundle, a, new EditCommand("base", a.id(), twice.id(), product.id(), "replace_expression",
                new ReplaceExpression("expression", "v * 3"), "semantic_edit")).files().get("Main.java");
        assertTrue(local.contains("v * 3"), local);
    }

    @Test void enclosingGraphDoesNotProjectNestedCallableOrFieldExpressions() {
        String source = "class Main { void run() { class Local { int field=71; int twice(int v) { return v*2; } }"
                + " Object anonymous = new Object() { int field=83; int value() { return 97; } }; int own=109; } }";
        var a = engine.inspect(new SourceBundle("base", Map.of("Main.java", source)));
        var outer = method(a, "Main.run");
        var expressions = a.graph().nodes().stream().filter(n -> n.methodId().equals(outer.id()) && n.kind().equals("expression")).toList();
        for (String nested : List.of("71", "v*2", "83", "97")) {
            int start = source.indexOf(nested), end = start + nested.length();
            assertTrue(expressions.stream().noneMatch(n -> n.sourceRange().startOffset() >= start && n.sourceRange().endOffset() <= end), nested);
        }
        assertNotNull(node(a, outer, "109"));
        assertNotNull(node(a, method(a, "Main.run().Local.twice"), "v*2"));
        assertNotNull(node(a, method(a, "Main.run().new Object(){}#1.value"), "97"));
    }
}
