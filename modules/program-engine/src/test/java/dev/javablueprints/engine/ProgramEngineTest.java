package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class ProgramEngineTest {
    private final ProgramEngine engine = new ProgramEngine();
    private SourceBundle bundle(String source) { return new SourceBundle("revision-1", Map.of("Main.java", source)); }
    private GraphNode expression(Analysis analysis, String label) {
        return analysis.graph().nodes().stream().filter(n -> n.kind().equals("expression") && n.label().equals(label)).findFirst().orElseThrow();
    }
    private EditCommand edit(Analysis analysis, GraphNode node, String replacement) {
        return new EditCommand(analysis.revisionId(), analysis.id(), node.methodId(), node.id(), "replace_expression",
                new ReplaceExpression("expression", replacement), "semantic_edit");
    }

    @Test void preservesExactCanonicalUtf8AndCommentsOnNoOp() {
        String source = "/* до класса 😀 */\n\tclass Main {\n\t// комментарий\n\tString f() { return \"Привет 😀\"; }\n}\n";
        SourceBundle bundle = bundle(source);
        Analysis analysis = engine.inspect(bundle);
        assertEquals("valid", analysis.parseStatus());
        assertArrayEquals(source.getBytes(StandardCharsets.UTF_8), engine.exportUnchanged(bundle).get("Main.java").getBytes(StandardCharsets.UTF_8));
        assertEquals("not_requested", analysis.compileStatus());
        assertEquals("partial", analysis.symbolStatus());
    }

    @Test void utf16RangesUseActualCanonicalOffsetsForTabsAndSurrogates() {
        String source = "// 😀\nclass Main {\n\tString f() { String x = \"😀\"; return \"Кириллица\"; }\n}\n";
        Analysis analysis = engine.inspect(bundle(source));
        GraphNode node = expression(analysis, "\"Кириллица\"");
        SourceRange range = node.sourceRange();
        assertEquals(source.indexOf("\"Кириллица\""), range.startOffset());
        assertEquals("\"Кириллица\"", source.substring(range.startOffset(), range.endOffset()));
        assertEquals(3, range.startLine());
        assertEquals(source.substring(source.lastIndexOf('\n', range.startOffset()) + 1, range.startOffset()).length() + 1, range.startColumn());
    }

    @Test void invalidSyntaxProducesNoMisleadingPartialGraph() {
        Analysis analysis = engine.inspect(new SourceBundle("invalid", Map.of("Main.java", "class Main { int f( {", "Other.java", "class Other { int f(){return 1;} }")));
        assertEquals("invalid", analysis.parseStatus());
        assertFalse(analysis.diagnostics().isEmpty());
        assertTrue(analysis.graph().nodes().isEmpty());
        assertTrue(analysis.graph().methods().isEmpty());
    }

    @Test void invalidMultiFileDiagnosticRetainsExactFileAndUtf16Location() {
        String broken = "// 😀\nclass Broken {\n\tint f() { return 1 + ; }\n}\n";
        Analysis analysis = engine.inspect(new SourceBundle("invalid-multi", Map.of(
                "ok/Good.java", "package ok; class Good {int f(){return 1;}}",
                "broken/Broken.java", broken)));
        Diagnostic diagnostic = analysis.diagnostics().stream().filter(d -> d.code().equals("PARSE_ERROR")).findFirst().orElseThrow();
        SourceRange range = diagnostic.sourceRange();
        assertNotNull(range, "Parser supplied a token location for the syntax error");
        assertEquals("broken/Broken.java", range.filePath());
        assertEquals(3, range.startLine());
        assertTrue(range.startOffset() >= broken.indexOf("return"));
        assertTrue(range.endOffset() <= broken.length());
        assertTrue(range.endOffset() >= range.startOffset());
        assertEquals(broken.substring(broken.lastIndexOf('\n', range.startOffset()) + 1, range.startOffset()).length() + 1, range.startColumn());
        assertTrue(analysis.graph().nodes().isEmpty());
    }

    @Test void discoversMultiFileDeclarationsAndMethods() {
        Analysis analysis = engine.inspect(new SourceBundle("multi", Map.of("a/A.java", "package a; class A { int f(){return 1;} }", "a/B.java", "package a; class B { B(){} int g(){return 2;} }")));
        assertEquals(3, analysis.graph().methods().size());
        assertTrue(analysis.graph().methods().stream().anyMatch(m -> m.fullyQualifiedName().equals("a.B.g")));
        assertTrue(analysis.declarations().stream().anyMatch(d -> d.name().equals("A")));
    }

    @Test void createsLocalizedUnverifiedCandidatePreservingOutsideTriviaAndPrecedence() {
        String source = "// before\nclass Main { int f(int n) { /* keep */ return n * 2; } }\n";
        SourceBundle bundle = bundle(source);
        Analysis analysis = engine.inspect(bundle);
        GraphNode two = expression(analysis, "2");
        Candidate candidate = engine.propose(bundle, analysis, edit(analysis, two, "1 + 2"));
        assertEquals(source.replace("n * 2", "n * (1 + 2)"), candidate.files().get("Main.java"));
        assertEquals("2", candidate.changes().getFirst().before());
        assertEquals("valid", candidate.parseStatus());
        assertEquals("not_requested", candidate.compileStatus());
        assertEquals("unverified", candidate.verificationStatus());
        assertEquals(source, bundle.files().get("Main.java"));
    }

    @Test void rejectsStaleAnalysisRevisionAndMethodBindings() {
        SourceBundle bundle = bundle("class Main {int f(){return 1;}}");
        Analysis analysis = engine.inspect(bundle), newerAnalysis = engine.inspect(bundle);
        GraphNode one = expression(analysis, "1");
        assertEquals("ANALYSIS_CONFLICT", assertThrows(EngineException.class,
                () -> engine.propose(bundle, newerAnalysis, edit(analysis, one, "2"))).code());
        assertEquals("ANALYSIS_CONFLICT", assertThrows(EngineException.class,
                () -> engine.propose(new SourceBundle("revision-2", bundle.files()), analysis, edit(analysis, one, "2"))).code());
        EditCommand wrongMethod = new EditCommand(analysis.revisionId(), analysis.id(), "other", one.id(), "replace_expression", new ReplaceExpression("expression", "2"), "semantic_edit");
        assertEquals("ANALYSIS_CONFLICT", assertThrows(EngineException.class, () -> engine.propose(bundle, analysis, wrongMethod)).code());
    }

    @Test void rejectsMalformedReplacementWithoutMutation() {
        SourceBundle bundle = bundle("class Main {int f(){return 1;}}");
        Analysis analysis = engine.inspect(bundle);
        assertEquals("INVALID_EDIT", assertThrows(EngineException.class,
                () -> engine.propose(bundle, analysis, edit(analysis, expression(analysis, "1"), "1; return 9;"))).code());
        assertEquals("class Main {int f(){return 1;}}", bundle.files().get("Main.java"));
    }

    @Test void rejectsInternalCommentLoss() {
        SourceBundle bundle = bundle("class Main {int f(){return 1 /* retain */ + 2;}}");
        Analysis analysis = engine.inspect(bundle);
        GraphNode expression = analysis.graph().nodes().stream().filter(n -> n.kind().equals("expression") && n.label().contains("retain")).findFirst().orElseThrow();
        assertEquals("UNSUPPORTED_OPERATION", assertThrows(EngineException.class,
                () -> engine.propose(bundle, analysis, edit(analysis, expression, "3"))).code());
    }

    @Test void modelsIfLoopReturnsAndExplicitNormalAndExceptionalExit() {
        Analysis analysis = engine.inspect(bundle("class Main { int f(int n) { while(n > 0) { if(n == 2) return n; n--; } return 0; } }"));
        List<Edge> edges = analysis.graph().edges();
        assertTrue(edges.stream().anyMatch(e -> e.kind().equals("true")));
        assertTrue(edges.stream().anyMatch(e -> e.kind().equals("false")));
        assertTrue(edges.stream().anyMatch(e -> e.kind().equals("loop")));
        assertEquals(2, edges.stream().filter(e -> e.kind().equals("return")).count());
        assertEquals(2, analysis.graph().methods().getFirst().exitNodeIds().size());
        assertTrue(analysis.graph().nodes().stream().filter(GraphNode::synthetic).allMatch(n -> n.sourceRange() == null));
        assertTrue(analysis.graph().nodes().stream().allMatch(n -> n.analysisId().equals(analysis.id()) && n.revisionId().equals(analysis.revisionId())));
    }

    @Test void forContinueGoesThroughUpdateAndInitIsOutsideBackEdge() {
        Analysis analysis = engine.inspect(bundle("class Main { void f(){for(int i=0;i<3;i++){if(i==1)continue;}} }"));
        Edge continuation = analysis.graph().edges().stream().filter(e -> e.kind().equals("continue")).findFirst().orElseThrow();
        GraphNode update = analysis.graph().nodes().stream().filter(n -> n.id().equals(continuation.target())).findFirst().orElseThrow();
        assertEquals("for_update", update.kind());
        GraphNode init = analysis.graph().nodes().stream().filter(n -> n.kind().equals("for_init")).findFirst().orElseThrow();
        assertFalse(analysis.graph().edges().stream().anyMatch(e -> e.kind().equals("loop") && e.target().equals(init.id())));
    }

    @Test void preservesOpaqueSynchronizationAndBlocksGraphEdits() {
        String source = "class Main {int f(){synchronized(this) {return 1;}}}";
        SourceBundle bundle = bundle(source);
        Analysis analysis = engine.inspect(bundle);
        assertEquals("valid", analysis.parseStatus());
        assertTrue(analysis.diagnostics().stream().anyMatch(d -> d.code().equals("UNSUPPORTED_CONTROL_FLOW")));
        assertTrue(analysis.graph().nodes().stream().allMatch(n -> n.editableFields().isEmpty()));
        assertEquals(source, engine.exportUnchanged(bundle).get("Main.java"));
        assertEquals("UNSUPPORTED_OPERATION", assertThrows(EngineException.class,
                () -> engine.propose(bundle, analysis, edit(analysis, expression(analysis, "1"), "2"))).code());
    }

    @Test void bundleHashIsOrderIndependentAndContentSensitive() {
        SourceBundle first = new SourceBundle("r", Map.of("A.java", "class A {}", "B.java", "class B {}"));
        var reversed = new java.util.LinkedHashMap<String, String>();
        reversed.put("B.java", "class B {}"); reversed.put("A.java", "class A {}");
        assertEquals(ProgramEngine.bundleHash(first), ProgramEngine.bundleHash(new SourceBundle("other-revision", reversed)));
        assertNotEquals(ProgramEngine.bundleHash(first), ProgramEngine.bundleHash(new SourceBundle("r", Map.of("A.java", "class A {} ", "B.java", "class B {}"))));
    }

    @Test void refusesUnsafeOrNoncanonicalInput() {
        assertThrows(IllegalArgumentException.class, () -> new SourceBundle("r", Map.of("../A.java", "class A{}")));
        assertThrows(IllegalArgumentException.class, () -> new SourceBundle("r", Map.of("C:/A.java", "class A{}")));
        assertThrows(IllegalArgumentException.class, () -> bundle("class A{}\r\n"));
    }

    @Test void unicodeEscapesAndModernDeclarationsPreserveRawCanonicalSpelling() {
        String source = "record Main(int x) { int f(){ int " + "\\" + "u0061 = 1; return " + "\\" + "u0061 + x; } }\n";
        SourceBundle bundle = bundle(source);
        Analysis analysis = engine.inspect(bundle);
        assertEquals("valid", analysis.parseStatus());
        assertEquals(source, engine.exportUnchanged(bundle).get("Main.java"));
        for (GraphNode node : analysis.graph().nodes()) {
            if (node.sourceRange() != null) {
                SourceRange range = node.sourceRange();
                assertTrue(range.startOffset() >= 0 && range.endOffset() <= source.length());
            }
        }
    }

    @Test void conditionCommandUsesOnlyConditionRange() {
        SourceBundle bundle = bundle("class Main {int f(int n){if(n>0)return 1;return 0;}}");
        Analysis analysis = engine.inspect(bundle);
        GraphNode branch = analysis.graph().nodes().stream().filter(n -> n.kind().equals("IfStmt")).findFirst().orElseThrow();
        EditCommand command = new EditCommand(analysis.revisionId(), analysis.id(), branch.methodId(), branch.id(), "replace_expression", new ReplaceExpression("condition", "n >= 0"), "semantic_edit");
        Candidate candidate = engine.propose(bundle, analysis, command);
        assertEquals("class Main {int f(int n){if((n >= 0))return 1;return 0;}}", candidate.files().get("Main.java"));
        assertEquals("n>0", candidate.changes().getFirst().before());
    }

    @Test void editableConditionRangesAreExactForIfAndForWithUtf16Trivia() {
        String source = "// 😀\nclass Main {\n\tint f(int n){if(n > 0){n++;} for(int i=0;i < n;i++){n--;} return n;}\n}";
        Analysis analysis = engine.inspect(bundle(source));
        for (String kind : List.of("IfStmt", "ForStmt")) {
            GraphNode node = analysis.graph().nodes().stream().filter(n -> n.kind().equals(kind)).findFirst().orElseThrow();
            SourceRange condition = node.editableFieldRanges().get("condition");
            assertNotNull(condition);
            String expected = kind.equals("IfStmt") ? "n > 0" : "i < n";
            assertEquals(expected, source.substring(condition.startOffset(), condition.endOffset()));
            assertEquals(source.indexOf(expected), condition.startOffset());
            assertTrue(condition.startOffset() > node.sourceRange().startOffset());
            assertTrue(condition.endOffset() < node.sourceRange().endOffset());
            assertEquals(3, condition.startLine());
            assertEquals(source.substring(source.lastIndexOf('\n', condition.startOffset()) + 1, condition.startOffset()).length() + 1, condition.startColumn());
        }
        GraphNode update = analysis.graph().nodes().stream().filter(n -> n.kind().equals("for_update")).findFirst().orElseThrow();
        assertEquals(update.sourceRange(), update.editableFieldRanges().get("expression"));
        GraphNode declaration = analysis.graph().nodes().stream().filter(n -> n.kind().equals("for_init")).findFirst().orElseThrow();
        assertTrue(declaration.editableFields().isEmpty(), "A variable declaration is not a replaceable expression");
        assertTrue(declaration.editableFieldRanges().isEmpty());
    }

    @Test void opaqueAndSyntheticNodesExposeNoEditableRanges() {
        Analysis opaque = engine.inspect(bundle("class Main {int f(){synchronized(this){return 1;}}}"));
        assertTrue(opaque.graph().nodes().stream().allMatch(n -> n.editableFieldRanges().isEmpty()));
        Analysis simple = engine.inspect(bundle("class Main {int f(){return 1;}}"));
        assertTrue(simple.graph().nodes().stream().filter(GraphNode::synthetic).allMatch(n -> n.editableFieldRanges().isEmpty()));
        GraphNode one = expression(simple, "1");
        assertEquals(one.sourceRange(), one.editableFieldRanges().get("expression"));
    }

    @Test void wholeStandaloneMethodCallReplacementRemainsAStatementExpression() {
        String source = "class Main {void f(){System.out.println(1);}}";
        SourceBundle bundle = bundle(source);
        Analysis analysis = engine.inspect(bundle);
        GraphNode call = expression(analysis, "System.out.println(1)");
        Candidate candidate = engine.propose(bundle, analysis, edit(analysis, call, "System.out.println(2)"));
        assertEquals("class Main {void f(){System.out.println(2);}}", candidate.files().get("Main.java"));
        assertEquals("INVALID_EDIT", assertThrows(EngineException.class,
                () -> engine.propose(bundle, analysis, edit(analysis, call, "1 + 2"))).code());
    }

    @Test void forUpdateReplacementDoesNotAddIllegalParentheses() {
        SourceBundle bundle = bundle("class Main {void f(){for(int i=0;i<3;i++){}}}");
        Analysis analysis = engine.inspect(bundle);
        GraphNode update = analysis.graph().nodes().stream().filter(n -> n.kind().equals("for_update")).findFirst().orElseThrow();
        Candidate candidate = engine.propose(bundle, analysis, edit(analysis, update, "i += 2"));
        assertEquals("class Main {void f(){for(int i=0;i<3;i += 2){}}}", candidate.files().get("Main.java"));
        assertEquals("INVALID_EDIT", assertThrows(EngineException.class,
                () -> engine.propose(bundle, analysis, edit(analysis, update, "i + 2"))).code());
    }

    @Test void oldPersistedNodesWithoutFieldRangeMapRemainReadable() {
        GraphNode oldNode = new GraphNode("n", "r", "a", "m", "IfStmt", "if", null, "binding", null,
                false, List.of("condition"), null);
        assertEquals(Map.of(), oldNode.editableFieldRanges());
    }
}
