package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;

import java.util.*;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

class EnhancedForFlowTest {
    private final ProgramEngine engine = new ProgramEngine();
    private SourceBundle bundle(String source) { return new SourceBundle("r", Map.of("Main.java", source)); }
    private String source(String body) {
        return "class Main {void f(){" + body + "}int[] values(){return new int[]{1,2};}void a(){}void b(){}void done(){}}";
    }
    private Analysis analyze(String text) {
        Analysis a = engine.inspect(bundle(text));
        assertEquals("valid", a.parseStatus(), a.diagnostics().toString());
        return a;
    }
    private Method method(Analysis a) { return a.graph().methods().stream().filter(m -> m.fullyQualifiedName().endsWith(".f")).findFirst().orElseThrow(); }
    private List<GraphNode> nodes(Analysis a) { return a.graph().nodes().stream().filter(n -> n.methodId().equals(method(a).id())).toList(); }
    private GraphNode node(Analysis a, String id) { return a.graph().nodes().stream().filter(n -> n.id().equals(id)).findFirst().orElseThrow(); }
    private GraphNode kind(Analysis a, String kind) { return nodes(a).stream().filter(n -> n.kind().equals(kind)).findFirst().orElseThrow(); }
    private Edge edge(Analysis a, GraphNode n, String kind) {
        List<Edge> edges = a.graph().edges().stream().filter(e -> e.source().equals(n.id()) && e.kind().equals(kind)).toList();
        assertEquals(1, edges.size(), n.toString()); return edges.getFirst();
    }
    /** The fixture supplies branch decisions; no Java source, values or protocol is evaluated. */
    private List<String> trace(Analysis a, Function<GraphNode, String> choice) {
        Map<String, GraphNode> index = a.graph().nodes().stream().collect(Collectors.toMap(GraphNode::id, Function.identity()));
        Map<String, List<Edge>> outgoing = a.graph().edges().stream().collect(Collectors.groupingBy(Edge::source));
        GraphNode current = index.get(method(a).entryNodeId()); List<String> visited = new ArrayList<>();
        for (int i = 0; i < 1000; i++) {
            assertNotEquals("ast_projection", current.executionRole());
            if (current.kind().equals("normal_exit") || current.kind().equals("exceptional_exit")) return visited;
            List<Edge> edges = outgoing.getOrDefault(current.id(), List.of()); Edge selected;
            if (current.kind().equals("foreach_check") || current.kind().equals("condition_test")) {
                visited.add(current.kind().equals("foreach_check") ? "check" : "test:" + current.label());
                String decision = choice.apply(current);
                selected = edges.stream().filter(e -> e.kind().equals(decision)).findFirst().orElseThrow();
            } else if (current.kind().equals("switch_selector")) {
                visited.add("select:" + current.label()); String decision = choice.apply(current);
                selected = edges.stream().filter(e -> decision.equals("default") ? e.kind().equals("default") : e.kind().equals("case") && decision.equals(e.label())).findFirst().orElseThrow();
            } else {
                if (current.kind().equals("foreach_source")) visited.add("source:" + current.label());
                else if (current.kind().equals("foreach_bind")) visited.add("bind");
                else if (current.kind().equals("foreach_advance")) visited.add("advance");
                else if (current.executionRole().equals("statement")) visited.add(current.label());
                assertEquals(1, edges.size(), current.toString()); selected = edges.getFirst();
            }
            current = index.get(selected.target());
        }
        fail("Unexpected graph cycle in bounded fixture"); return List.of();
    }
    private List<String> trace(Analysis a, String... checks) {
        Deque<String> choices = new ArrayDeque<>(List.of(checks));
        List<String> result = trace(a, n -> choices.removeFirst()); assertTrue(choices.isEmpty()); return result;
    }
    private Candidate insert(SourceBundle b, Analysis a, GraphNode n, String text) {
        return engine.propose(b, a, new EditCommand(a.revisionId(), a.id(), n.methodId(), n.id(), "insert_statement",
                new InsertStatement(n.kind().equals("entry") ? "body_start" : "before", text), "semantic_edit"));
    }
    private Candidate replace(SourceBundle b, Analysis a, GraphNode n, String text) {
        return engine.propose(b, a, new EditCommand(a.revisionId(), a.id(), n.methodId(), n.id(), "replace_expression",
                new ReplaceExpression("expression", text), "semantic_edit"));
    }

    @Test void zeroOneAndManyIterationsEvaluateSourceOnlyOnce() {
        Analysis a = analyze(source("for(int value:values()){a();}done();"));
        assertEquals(List.of("source:values()", "check", "done();"), trace(a, "false"));
        assertEquals(List.of("source:values()", "check", "bind", "a();", "advance", "check", "done();"), trace(a, "true", "false"));
        assertEquals(List.of("source:values()", "check", "bind", "a();", "advance", "check", "bind", "a();", "advance", "check", "done();"), trace(a, "true", "true", "false"));
        assertEquals("foreach_check", node(a, edge(a, kind(a, "foreach_advance"), "loop").target()).kind());
        assertEquals(1, nodes(a).stream().filter(n -> n.kind().equals("foreach_source")).count());
    }

    @Test void emptyBlockAndSingleStatementBodyStillBindAndAdvance() {
        for (String body : List.of("{}", ";")) {
            Analysis a = analyze(source("for(int value:values())" + body + "done();"));
            List<String> expected = new ArrayList<>(List.of("source:values()", "check", "bind"));
            if (body.equals(";")) expected.add(";");
            expected.addAll(List.of("advance", "check", "done();"));
            assertEquals(expected, trace(a, "true", "false"));
        }
    }

    @Test void continueAdvancesAndBreakExitsWithoutAnotherCheckOrSource() {
        Analysis continuing = analyze(source("for(int value:values()){continue;a();}done();"));
        assertEquals(List.of("source:values()", "check", "bind", "continue;", "advance", "check", "done();"), trace(continuing, "true", "false"));
        assertEquals("foreach_advance", node(continuing, edge(continuing, kind(continuing, "ContinueStmt"), "continue").target()).kind());
        Analysis breaking = analyze(source("for(int value:values()){break;a();}done();"));
        assertEquals(List.of("source:values()", "check", "bind", "break;", "done();"), trace(breaking, "true"));
    }

    @Test void returnAndThrowNeverReachBodyAftermathAdvanceOrDone() {
        for (String terminal : List.of("return;", "throw new RuntimeException();")) {
            Analysis a = analyze(source("for(int value:values()){" + terminal + "a();}done();"));
            assertEquals(List.of("source:values()", "check", "bind", terminal), trace(a, "true"));
            GraphNode n = kind(a, terminal.startsWith("return") ? "ReturnStmt" : "ThrowStmt");
            assertEquals(terminal.startsWith("return") ? "normal_exit" : "exceptional_exit", node(a, edge(a, n, terminal.startsWith("return") ? "return" : "throw").target()).kind());
        }
    }

    @Test void nestedSwitchBreakLeavesSwitchButContinueAdvancesEnclosingForeach() {
        Analysis a = analyze(source("for(int value:values()){switch(value){case 0:continue;default:break;}a();}done();"));
        Deque<String> checks = new ArrayDeque<>(List.of("true", "true", "false"));
        Deque<String> cases = new ArrayDeque<>(List.of("0", "default"));
        assertEquals(List.of("source:values()", "check", "bind", "select:value", "continue;", "advance", "check", "bind", "select:value", "break;", "a();", "advance", "check", "done();"),
                trace(a, n -> n.kind().equals("foreach_check") ? checks.removeFirst() : cases.removeFirst()));
        assertTrue(checks.isEmpty()); assertTrue(cases.isEmpty());
        assertEquals("a();", node(a, edge(a, kind(a, "BreakStmt"), "break").target()).label());
        assertEquals("foreach_advance", node(a, edge(a, kind(a, "ContinueStmt"), "continue").target()).kind());
    }

    @Test void nestedForeachAndBasicLoopsHaveIndependentTargets() {
        Analysis a = analyze(source("for(int outer:values()){for(int inner:values()){continue;}while(true){break;}break;}done();"));
        GraphNode outer = nodes(a).stream().filter(n -> n.kind().equals("ForEachStmt") && n.label().contains("outer")).findFirst().orElseThrow();
        GraphNode inner = nodes(a).stream().filter(n -> n.kind().equals("ForEachStmt") && n.label().startsWith("for(int inner")).findFirst().orElseThrow();
        GraphNode advancing = node(a, edge(a, kind(a, "ContinueStmt"), "continue").target());
        assertEquals(inner.id(), advancing.parentId()); assertNotEquals(outer.id(), advancing.parentId());
        Set<String> targets = nodes(a).stream().filter(n -> n.kind().equals("BreakStmt")).map(n -> node(a, edge(a, n, "break").target()).label()).collect(Collectors.toSet());
        assertEquals(Set.of("break;", "done();"), targets);
        Analysis basic = analyze(source("for(int i=0;i<2;i++){for(int v:values()){break;}continue;}done();"));
        assertEquals("for_update", node(basic, edge(basic, kind(basic, "ContinueStmt"), "continue").target()).kind());
    }

    @Test void bodyShortCircuitAndSourceReassignmentKeepNormalEvaluationOrder() {
        Analysis a = analyze(source("int[] items=values();for(int value:items){items=values();value=7;if(true&&false)a();}done();"));
        Deque<String> choices = new ArrayDeque<>(List.of("true", "true", "false", "false"));
        assertEquals(List.of("int[] items=values();", "source:items", "check", "bind", "items=values();", "value=7;", "test:true", "test:false", "advance", "check", "done();"), trace(a, n -> choices.removeFirst()));
        assertTrue(choices.isEmpty());
    }

    @Test void readonlySourceAndSyntheticStagesCannotBeMutatedOrHaveFabricatedRanges() {
        String text = "// 😀\n" + source("for(int value: /* keep */ values())a();done();");
        SourceBundle b = bundle(text); Analysis a = analyze(text);
        GraphNode source = kind(a, "foreach_source");
        assertEquals("values()", text.substring(source.sourceRange().startOffset(), source.sourceRange().endOffset()));
        assertEquals(text.indexOf("values()"), source.sourceRange().startOffset());
        assertEquals("statement", source.executionRole()); assertFalse(source.synthetic());
        for (GraphNode n : nodes(a).stream().filter(n -> n.kind().startsWith("foreach_")).toList()) {
            assertTrue(n.editableFields().isEmpty()); assertTrue(n.editableFieldRanges().isEmpty());
            assertTrue(n.allowedOperations().isEmpty()); assertTrue(n.insertionPositions().isEmpty());
            if (!n.kind().equals("foreach_source")) { assertNull(n.sourceRange()); assertTrue(n.synthetic()); assertEquals("synthetic", n.executionRole()); }
            assertThrows(EngineException.class, () -> replace(b, a, n, "values()"));
            assertThrows(EngineException.class, () -> insert(b, a, n, "a();"));
            assertThrows(EngineException.class, () -> engine.propose(b, a, new EditCommand(a.revisionId(), a.id(), n.methodId(), n.id(), "delete_statement", new DeleteStatement(), "semantic_edit")));
        }
        GraphNode header = kind(a, "ForEachStmt");
        assertEquals("structural", header.executionRole()); assertTrue(header.editableFields().isEmpty());
        assertTrue(header.allowedOperations().contains("insert_statement"));
        List<GraphNode> variable = nodes(a).stream().filter(n -> n.kind().equals("expression") && n.label().equals("int value")).toList();
        assertEquals(1, variable.size()); assertTrue(variable.getFirst().allowedOperations().isEmpty());
        GraphNode directBody = nodes(a).stream().filter(n -> n.kind().equals("ExpressionStmt") && n.label().equals("a();")).findFirst().orElseThrow();
        assertFalse(directBody.allowedOperations().contains("insert_statement"));
        assertEquals(text, engine.exportUnchanged(b).get("Main.java"));
    }

    @Test void sourceProjectionEditRegeneratesDetachedCandidateAndDefersTypeValidity() {
        String text = source("for(int value:values()){a();}done();"); SourceBundle b = bundle(text); Analysis a = analyze(text);
        GraphNode projection = nodes(a).stream().filter(n -> n.kind().equals("expression") && n.label().equals("values()")).findFirst().orElseThrow();
        Candidate candidate = replace(b, a, projection, "new int[]{3,4}");
        assertEquals(text.replace("value:values()", "value:(new int[]{3,4})"), candidate.files().get("Main.java"));
        Analysis changed = engine.inspect(new SourceBundle("candidate", candidate.files()));
        assertEquals("(new int[]{3,4})", kind(changed, "foreach_source").label()); assertNotEquals(a.id(), changed.id());
        assertEquals(text, b.files().get("Main.java")); assertEquals("values()", kind(a, "foreach_source").label());
        Candidate invalidType = replace(b, a, projection, "42");
        assertEquals("valid", invalidType.parseStatus()); assertEquals("not_requested", invalidType.compileStatus()); assertEquals("unverified", invalidType.verificationStatus());
        assertEquals("INVALID_EDIT", assertThrows(EngineException.class, () -> replace(b, a, projection, "new int[]{")).code());
        assertEquals("ANALYSIS_CONFLICT", assertThrows(EngineException.class, () -> replace(b, engine.inspect(b), projection, "values()")).code());
    }

    @Test void realBodyAnchorsAndWholeLoopInsertionRetainSpliceAndJumpRules() {
        String text = source("for(int value:values()){a();}done();"); SourceBundle b = bundle(text); Analysis a = analyze(text);
        GraphNode anchor = nodes(a).stream().filter(n -> n.label().equals("a();")).findFirst().orElseThrow();
        Candidate candidate = insert(b, a, anchor, "continue;"); Analysis changed = engine.inspect(new SourceBundle("candidate", candidate.files()));
        assertEquals("foreach_advance", node(changed, edge(changed, kind(changed, "ContinueStmt"), "continue").target()).kind());
        assertEquals("valid", insert(b, a, anchor, "break;").parseStatus());
        for (String jump : List.of("break;", "continue;")) assertEquals("INVALID_EDIT", assertThrows(EngineException.class,
                () -> insert(b, a, anchor, "new Object(){void other(){" + jump + "}};")).code());
        String empty = "// 😀 keep\nclass Main {void f(){/* keep */}}"; SourceBundle eb = bundle(empty); Analysis ea = analyze(empty);
        Candidate loop = insert(eb, ea, kind(ea, "entry"), "for(String s:new String[0]){continue;}");
        assertEquals(empty.replace("/* keep */", "\nfor(String s:new String[0]){continue;}\n/* keep */"), loop.files().get("Main.java"));
        assertEquals("foreach_source", kind(engine.inspect(new SourceBundle("new", loop.files())), "foreach_source").kind());
    }

    @Test void arraysIterableNullAndUnknownSourcesUseSameHonestAbstraction() {
        for (String expression : List.of("new int[0]", "null", "missing", "java.util.List.of(1,2)")) {
            Analysis a = analyze(source("for(int value:" + expression + "){a();}"));
            assertEquals(expression, kind(a, "foreach_source").label());
            assertEquals(Set.of("foreach_source", "foreach_check", "foreach_bind", "foreach_advance"), nodes(a).stream().map(GraphNode::kind).filter(k -> k.startsWith("foreach_")).collect(Collectors.toSet()));
            Capability c = a.coverage().stream().filter(x -> x.feature().equals("enhanced_for_flow")).findFirst().orElseThrow();
            assertEquals("partial", c.status()); assertTrue(c.reason().contains("protocol details and exceptional flow are unknown"));
            assertEquals("not_requested", a.compileStatus());
            assertTrue(a.coverage().stream().anyMatch(x -> x.feature().equals("complexity") && x.status().equals("unknown")));
            for (GraphNode n : nodes(a).stream().filter(n -> n.kind().startsWith("foreach_")).toList())
                assertTrue(a.graph().edges().stream().filter(e -> e.source().equals(n.id())).noneMatch(e -> e.kind().equals("throw")));
        }
    }

    @Test void unsupportedBodiesPreserveWholeMethodWithoutPartialIterationNodesOrEdits() {
        for (String body : List.of("try{a();}finally{}", "outer:while(true){break outer;}", "switch(1){default -> a();}", "Runnable r=()->a();", "synchronized(this){a();}")) {
            String text = source("for(int v:values()){" + body + "}done();"); Analysis a = analyze(text);
            assertTrue(nodes(a).stream().anyMatch(n -> n.kind().equals("opaque")));
            assertTrue(nodes(a).stream().noneMatch(n -> n.kind().startsWith("foreach_")));
            assertTrue(nodes(a).stream().allMatch(n -> n.allowedOperations().isEmpty()));
            assertEquals(text, engine.exportUnchanged(bundle(text)).get("Main.java"));
        }
        Analysis invalid = engine.inspect(bundle(source("for(int v:){a();}")));
        assertEquals("invalid", invalid.parseStatus()); assertTrue(invalid.graph().nodes().isEmpty());
        assertTrue(invalid.coverage().stream().anyMatch(x -> x.feature().equals("enhanced_for_flow") && x.status().equals("not_requested")));
    }

    @Test void iterationBudgetInclusiveAndMethodWideWithWholeMethodOpaquePreflight() {
        String loop = "for(int v:new int[0]){}";
        Analysis boundary = analyze(source(loop.repeat(1024)));
        assertEquals(1024, nodes(boundary).stream().filter(n -> n.kind().equals("foreach_source")).count());
        assertEquals(4096, nodes(boundary).stream().filter(n -> n.kind().startsWith("foreach_")).count());
        for (String body : List.of(loop.repeat(1025), "{" + loop.repeat(513) + "}{" + loop.repeat(512) + "}")) {
            Analysis a = analyze(source(body));
            assertTrue(a.diagnostics().stream().anyMatch(d -> d.code().equals("ITERATION_FLOW_LIMIT")));
            assertTrue(nodes(a).stream().anyMatch(n -> n.kind().equals("opaque")));
            assertTrue(nodes(a).stream().noneMatch(n -> n.kind().startsWith("foreach_")));
            assertTrue(nodes(a).stream().allMatch(n -> n.allowedOperations().isEmpty()));
        }
        String text = source(loop.repeat(1024)); SourceBundle b = bundle(text);
        Candidate candidate = insert(b, boundary, kind(boundary, "entry"), loop);
        assertTrue(candidate.diagnostics().stream().anyMatch(d -> d.code().equals("ITERATION_FLOW_LIMIT")));
        Analysis changed = engine.inspect(new SourceBundle("candidate", candidate.files()));
        assertTrue(nodes(changed).stream().noneMatch(n -> n.kind().startsWith("foreach_")));
        assertEquals(1024, nodes(boundary).stream().filter(n -> n.kind().equals("foreach_source")).count());
    }

    @Test void iterationBudgetsResetPerCallableAndOldEngineSnapshotCannotEdit() {
        String text = "class Main {void f(){" + "for(int v:new int[0]){}".repeat(600)
                + "}void g(){" + "for(int v:new int[0]){}".repeat(600) + "}}";
        Analysis a = analyze(text);
        assertEquals(1200, a.graph().nodes().stream().filter(n -> n.kind().equals("foreach_source")).count());
        assertTrue(a.diagnostics().stream().noneMatch(d -> d.code().equals("ITERATION_FLOW_LIMIT")));
        String small = source("for(int v:values())a();"); SourceBundle b = bundle(small); Analysis fresh = analyze(small);
        Analysis old = new Analysis(fresh.id(), fresh.revisionId(), fresh.bundleHash(), "engine-0.5.0", fresh.parserVersion(), fresh.languageLevel(),
                fresh.parseStatus(), fresh.compileStatus(), fresh.symbolStatus(), fresh.sourceMapVersion(), fresh.diagnostics(), fresh.coverage(),
                fresh.declarations(), fresh.graph(), fresh.symbolEnvironmentHash(), fresh.semantics());
        assertEquals("ANALYSIS_CONFLICT", assertThrows(EngineException.class, () -> insert(b, old, kind(old, "entry"), "a();")).code());
    }
}
