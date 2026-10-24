package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class StructuralEditTest {
    private final ProgramEngine engine = new ProgramEngine();
    private SourceBundle bundle(String source) { return new SourceBundle("base", Map.of("Main.java", source)); }
    private GraphNode node(Analysis analysis, String kind, String label) {
        return analysis.graph().nodes().stream().filter(n -> n.kind().equals(kind) && (label == null || n.label().equals(label))).findFirst().orElseThrow();
    }
    private EditCommand command(Analysis a, GraphNode n, String operation, EditPayload payload) {
        return new EditCommand(a.revisionId(), a.id(), n.methodId(), n.id(), operation, payload, "semantic_edit");
    }
    private Candidate insert(SourceBundle b, Analysis a, GraphNode n, String position, String source) {
        return engine.propose(b, a, command(a, n, "insert_statement", new InsertStatement(position, source)));
    }
    private void fails(String code, Runnable action) {
        assertEquals(code, assertThrows(EngineException.class, action::run).code());
    }

    @Test void emptyBodyHasRealEntryInsertionBindingAndDetachedCandidate() {
        SourceBundle b = bundle("class Main {void f(){}}\n");
        Analysis a = engine.inspect(b);
        GraphNode entry = node(a, "entry", null);
        assertFalse(entry.synthetic());
        assertNotNull(entry.sourceRange());
        assertEquals(List.of("insert_statement"), entry.allowedOperations());
        assertEquals(List.of("body_start", "body_end"), entry.insertionPositions());
        for (String position : entry.insertionPositions()) {
            Candidate c = insert(b, a, entry, position, "System.out.println(\"Привет 😀\");");
            assertEquals("class Main {void f(){\nSystem.out.println(\"Привет 😀\");\n}}\n", c.files().get("Main.java"));
            assertEquals("valid", c.parseStatus());
            assertEquals("not_requested", c.compileStatus());
            assertEquals("unverified", c.verificationStatus());
            assertEquals("", c.changes().getFirst().before());
        }
        assertEquals("class Main {void f(){}}\n", b.files().get("Main.java"));
    }

    @Test void beforeAndAfterRespectExactNestedBlockAndUtf16Offsets() {
        String source = "// 😀\nclass Main {void f(boolean ok){int x=0;if(ok){\tx++;} x--;}}\n";
        SourceBundle b = bundle(source);
        Analysis a = engine.inspect(b);
        GraphNode increment = node(a, "ExpressionStmt", "x++;");
        assertTrue(increment.allowedOperations().containsAll(List.of("insert_statement", "delete_statement")));
        Candidate before = insert(b, a, increment, "before", "x += 2;");
        assertEquals(source.replace("\tx++;", "\t\nx += 2;\nx++;"), before.files().get("Main.java"));
        Candidate after = insert(b, a, increment, "after", "x += 2;");
        assertEquals(source.replace("x++;", "x++;\nx += 2;\n"), after.files().get("Main.java"));
        assertEquals(source.indexOf("x++;"), before.changes().getFirst().startOffset());
        assertEquals(source.indexOf("x++;") + 4, after.changes().getFirst().startOffset());
    }

    @Test void deletionPreservesAdjacentCommentsWhitespaceAndOtherFilesExactly() {
        String source = "// 😀\nclass Main {void f(){/* leading */ int x=0; // trailing\n System.out.println(1);}}\n";
        SourceBundle b = new SourceBundle("base", Map.of("Main.java", source, "Other.java", "/* keep */ class Other{}\n"));
        Analysis a = engine.inspect(b);
        GraphNode declaration = node(a, "ExpressionStmt", "int x=0;");
        Candidate c = engine.propose(b, a, command(a, declaration, "delete_statement", new DeleteStatement()));
        assertEquals(source.replace("int x=0;", ""), c.files().get("Main.java"));
        assertEquals(b.files().get("Other.java"), c.files().get("Other.java"));
        assertEquals("int x=0;", c.changes().getFirst().before());
        assertEquals("", c.changes().getFirst().after());
        assertEquals(source.indexOf("int x"), c.changes().getFirst().startOffset());
    }

    @Test void deletingCompoundStatementCannotDiscardItsInternalComments() {
        SourceBundle b = bundle("class Main {void f(){if(true){/* keep */System.out.println(1);}}}");
        Analysis a = engine.inspect(b);
        GraphNode branch = node(a, "IfStmt", null);
        assertFalse(branch.allowedOperations().contains("delete_statement"));
        assertTrue(branch.allowedOperations().contains("insert_statement"));
        fails("UNSUPPORTED_OPERATION", () -> engine.propose(b, a, command(a, branch, "delete_statement", new DeleteStatement())));
    }

    @Test void deletingNestedStatementKeepsOuterControlAndAllowsEmptyBody() {
        SourceBundle b = bundle("class Main {void f(){while(true){System.out.println(1);}}}");
        Analysis a = engine.inspect(b);
        Candidate c = engine.propose(b, a, command(a, node(a, "ExpressionStmt", "System.out.println(1);"), "delete_statement", new DeleteStatement()));
        assertEquals("class Main {void f(){while(true){}}}", c.files().get("Main.java"));
    }

    @Test void insertionNewlinesProtectLineCommentsAtEveryBoundary() {
        SourceBundle b = bundle("class Main {void f(){// first\nSystem.out.println(1); // last\n}}");
        Analysis a = engine.inspect(b);
        GraphNode statement = node(a, "ExpressionStmt", "System.out.println(1);");
        Candidate after = insert(b, a, statement, "after", "System.out.println(2); // inserted");
        assertEquals("class Main {void f(){// first\nSystem.out.println(1);\nSystem.out.println(2); // inserted\n // last\n}}", after.files().get("Main.java"));
        Candidate end = insert(b, a, node(a, "entry", null), "body_end", "System.out.println(3); // inserted");
        assertTrue(end.files().get("Main.java").contains("// last\n\nSystem.out.println(3); // inserted\n}"));
        assertEquals("valid", engine.inspect(new SourceBundle("candidate", end.files())).parseStatus());
    }

    @Test void supportsIfForWhileAndDoAsSingleInsertedStatement() {
        SourceBundle b = bundle("class Main {void f(){}}");
        Analysis a = engine.inspect(b);
        for (String statement : List.of("if (true) { System.out.println(1); } else { System.out.println(2); }",
                "for(int i=0;i<3;i++){if(i==1)continue;System.out.println(i);}",
                "while(true){break;}", "do {break;} while(false);", "{int x=1; System.out.println(x);}")) {
            Candidate c = insert(b, a, node(a, "entry", null), "body_start", statement);
            Analysis candidate = engine.inspect(new SourceBundle("candidate", c.files()));
            assertFalse(candidate.graph().nodes().stream().anyMatch(n -> n.kind().equals("opaque")), statement);
        }
    }

    @Test void rejectsEmptyMultipleMalformedAndNoncanonicalStatementPayloads() {
        SourceBundle b = bundle("class Main {void f(){}}");
        Analysis a = engine.inspect(b);
        GraphNode entry = node(a, "entry", null);
        for (String statement : List.of("", "// only comment", "int x=1; int y=2;", "int = ;", "} class Escaped {} {", "x++;\r\n", "\uFEFFx++;")) {
            fails("INVALID_EDIT", () -> insert(b, a, entry, "body_start", statement));
        }
        fails("INVALID_EDIT", () -> insert(b, a, entry, "body_start", null));
    }

    @Test void rejectsUnsupportedInsertedControlWithoutWideningOpaqueScope() {
        SourceBundle b = bundle("class Main {void f(){}}");
        Analysis a = engine.inspect(b);
        for (String statement : List.of("synchronized(this){}", "switch(1){default -> {}}", "outer: while(true){break outer;}",
                "for(String s : new String[0]){synchronized(this){}}", "Runnable r = () -> {};", "class Local {}")) {
            fails("UNSUPPORTED_OPERATION", () -> insert(b, a, node(a, "entry", null), "body_end", statement));
        }
    }

    @Test void jumpsRequireActualLoopAroundDestinationOrInsideInsertedStatement() {
        SourceBundle b = bundle("class Main {void f(){while(true){System.out.println(1);}}}");
        Analysis a = engine.inspect(b);
        GraphNode loop = node(a, "WhileStmt", null);
        GraphNode bodyStatement = node(a, "ExpressionStmt", "System.out.println(1);");
        for (String jump : List.of("break;", "continue;", "if(true)break;")) {
            fails("INVALID_EDIT", () -> insert(b, a, loop, "before", jump));
            fails("INVALID_EDIT", () -> insert(b, a, loop, "after", jump));
            fails("INVALID_EDIT", () -> insert(b, a, node(a, "entry", null), "body_start", jump));
            assertEquals("valid", insert(b, a, bodyStatement, "before", jump).parseStatus());
        }
    }

    @Test void expressionsUpdatesUnbracedBodiesAndSyntheticExitsAreNotStructuralAnchors() {
        SourceBundle b = bundle("class Main {void f(){for(int i=0;i<3;i++)System.out.println(i);}}");
        Analysis a = engine.inspect(b);
        for (GraphNode n : a.graph().nodes()) {
            if (n.kind().equals("expression") || n.kind().equals("for_init") || n.kind().equals("for_update")
                    || n.synthetic() || n.kind().equals("ExpressionStmt")) {
                assertFalse(n.allowedOperations().contains("insert_statement"), n.kind());
                assertFalse(n.allowedOperations().contains("delete_statement"), n.kind());
                fails("UNSUPPORTED_OPERATION", () -> insert(b, a, n, "before", "System.out.println(2);"));
                fails("UNSUPPORTED_OPERATION", () -> engine.propose(b, a, command(a, n, "delete_statement", new DeleteStatement())));
            }
        }
    }

    @Test void opaqueMethodCannotAdvertiseOrPerformStructuralChanges() {
        SourceBundle b = bundle("class Main {void f(){synchronized(this){System.out.println(1);}}}");
        Analysis a = engine.inspect(b);
        for (GraphNode n : a.graph().nodes()) {
            assertTrue(n.allowedOperations().isEmpty());
            assertTrue(n.insertionPositions().isEmpty());
        }
        fails("UNSUPPORTED_OPERATION", () -> insert(b, a, node(a, "entry", null), "body_end", "System.out.println(2);"));
    }

    @Test void validatesPayloadPositionBindingVersionAndExactGraphBeforeMutation() {
        SourceBundle b = bundle("class Main {void f(){System.out.println(1);}}");
        Analysis a = engine.inspect(b);
        GraphNode n = node(a, "ExpressionStmt", "System.out.println(1);");
        fails("INVALID_EDIT", () -> insert(b, a, n, "body_start", "System.out.println(2);"));
        fails("INVALID_EDIT", () -> insert(b, a, node(a, "entry", null), "before", "System.out.println(2);"));
        fails("INVALID_EDIT", () -> engine.propose(b, a, command(a, n, "delete_statement", new InsertStatement("before", ";"))));
        fails("INVALID_EDIT", () -> engine.propose(b, a, command(a, n, "insert_statement", new DeleteStatement())));
        fails("ANALYSIS_CONFLICT", () -> engine.propose(b, engine.inspect(b), command(a, n, "delete_statement", new DeleteStatement())));
        fails("ANALYSIS_CONFLICT", () -> engine.propose(new SourceBundle("other", b.files()), a, command(a, n, "insert_statement", new InsertStatement("before", ";"))));
        EditCommand wrongMethod = new EditCommand(a.revisionId(), a.id(), "wrong", n.id(), "delete_statement", new DeleteStatement(), "semantic_edit");
        fails("ANALYSIS_CONFLICT", () -> engine.propose(b, a, wrongMethod));
        assertEquals("class Main {void f(){System.out.println(1);}}", b.files().get("Main.java"));
    }

    @Test void leavesTypeReachabilityAndDefiniteAssignmentToIsolatedCompilation() {
        SourceBundle b = bundle("class Main {void f(){}}");
        Analysis a = engine.inspect(b);
        for (String statement : List.of("int x = missing;", "return 3;", "if(1){}")) {
            Candidate c = insert(b, a, node(a, "entry", null), "body_start", statement);
            assertEquals("valid", c.parseStatus());
            assertEquals("not_requested", c.compileStatus());
            assertEquals("unverified", c.verificationStatus());
        }
    }

    @Test void olderPersistedGraphNodesDefaultNewCapabilitiesToEmpty() {
        GraphNode old = new GraphNode("n", "r", "a", "m", "entry", "entry", null, "n", null, true, List.of(), null);
        assertTrue(old.allowedOperations().isEmpty());
        assertTrue(old.insertionPositions().isEmpty());
        GraphNode missingJsonFields = new GraphNode("n", "r", "a", "m", "entry", "entry", null, "n", null, true, List.of(), null, null, null);
        assertTrue(missingJsonFields.allowedOperations().isEmpty());
        assertTrue(missingJsonFields.insertionPositions().isEmpty());
    }

    @Test void unsupportedUnicodeEscapedDelimitersCannotAdvertiseAnInsertionAnchor() {
        String open = "\\" + "u007b", close = "\\" + "u007d";
        String source = "class Main {void f()" + open + "System.out.println(1);" + close + "}";
        SourceBundle b = bundle(source);
        Analysis a = engine.inspect(b);
        assertEquals("invalid", a.parseStatus());
        assertTrue(a.graph().nodes().isEmpty());
        assertEquals(source, engine.exportUnchanged(b).get("Main.java"));
    }

    @Test void oldEngineAndForgedCapabilitiesCannotAuthorizeStructuralEdits() {
        SourceBundle b = bundle("class Main {void f(){System.out.println(1);}}");
        Analysis a = engine.inspect(b);
        GraphNode n = node(a, "ExpressionStmt", "System.out.println(1);");
        Analysis old = new Analysis(a.id(), a.revisionId(), a.bundleHash(), "engine-0.1.1", a.parserVersion(),
                a.languageLevel(), a.parseStatus(), a.compileStatus(), a.symbolStatus(), a.sourceMapVersion(),
                a.diagnostics(), a.coverage(), a.declarations(), a.graph());
        fails("ANALYSIS_CONFLICT", () -> engine.propose(b, old, command(a, n, "delete_statement", new DeleteStatement())));
        GraphNode forged = new GraphNode(n.id(), n.revisionId(), n.analysisId(), n.methodId(), n.kind(), n.label(),
                n.sourceRange(), n.astBinding(), n.parentId(), n.synthetic(), n.editableFields(), n.editableFieldRanges(),
                List.of("insert_statement", "delete_statement", "extract_method"), List.of("body_end"));
        Graph graph = new Graph(a.graph().revisionId(), a.graph().analysisId(), a.graph().sourceMapVersion(),
                a.graph().methods(), a.graph().nodes().stream().map(item -> item.id().equals(n.id()) ? forged : item).toList(), a.graph().edges());
        Analysis altered = new Analysis(a.id(), a.revisionId(), a.bundleHash(), a.analyzerVersion(), a.parserVersion(),
                a.languageLevel(), a.parseStatus(), a.compileStatus(), a.symbolStatus(), a.sourceMapVersion(),
                a.diagnostics(), a.coverage(), a.declarations(), graph);
        fails("ANALYSIS_CONFLICT", () -> engine.propose(b, altered, command(a, n, "insert_statement", new InsertStatement("body_end", ";"))));
    }

    @Test void methodEntryInsertionStaysInSelectedConstructorOrMethod() {
        SourceBundle b = bundle("class Main {Main(){} void f(){} void g(){}}");
        Analysis a = engine.inspect(b);
        for (Method method : a.graph().methods()) {
            GraphNode entry = a.graph().nodes().stream().filter(n -> n.id().equals(method.entryNodeId())).findFirst().orElseThrow();
            Candidate c = insert(b, a, entry, "body_end", "System.out.println(1);");
            String declaration = method.signature().startsWith("Main") ? "Main()" : "void " + method.signature();
            assertEquals(b.files().get("Main.java").replace(declaration + "{}", declaration + "{\nSystem.out.println(1);\n}"), c.files().get("Main.java"));
        }
    }
}
