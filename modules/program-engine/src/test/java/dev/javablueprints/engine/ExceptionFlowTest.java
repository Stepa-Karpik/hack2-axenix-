package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;
import java.util.*;
import java.util.function.Predicate;
import static org.junit.jupiter.api.Assertions.*;

class ExceptionFlowTest {
    private final ProgramEngine engine = new ProgramEngine();
    private SourceBundle bundle(String text) { return new SourceBundle("exceptions", Map.of("Main.java", text)); }
    private Analysis inspect(String body) {
        Analysis analysis = engine.inspect(bundle("class Main { int f(boolean flag) { " + body + " } }"));
        assertEquals("valid", analysis.parseStatus(), analysis.diagnostics().toString());
        assertFalse(analysis.diagnostics().stream().anyMatch(d -> d.code().equals("UNSUPPORTED_CONTROL_FLOW")), analysis.diagnostics().toString());
        return analysis;
    }
    private GraphNode node(Analysis a, String id) { return a.graph().nodes().stream().filter(n -> n.id().equals(id)).findFirst().orElseThrow(); }
    private List<GraphNode> executable(Analysis a) { return a.graph().nodes().stream().filter(n -> !"ast_projection".equals(n.executionRole())).toList(); }
    private GraphNode find(Analysis a, String kind, String text) {
        return executable(a).stream().filter(n -> n.kind().equals(kind) && n.label().contains(text)).findFirst().orElseThrow();
    }
    private List<Edge> exact(Analysis a, String id) { return a.graph().edges().stream().filter(e -> e.source().equals(id) && !"conservative".equals(e.certainty())).toList(); }
    private List<GraphNode> trace(Analysis a, Map<String,Boolean> decisions) {
        List<GraphNode> result = new ArrayList<>();
        String current = a.graph().methods().getFirst().entryNodeId();
        for (int budget = 0; budget < 200; budget++) {
            GraphNode n = node(a, current); result.add(n);
            List<Edge> outgoing = exact(a, current);
            if (outgoing.isEmpty()) return result;
            if (outgoing.size() == 1) current = outgoing.getFirst().target();
            else {
                assertTrue(decisions.containsKey(n.label()), "Missing independent predicate decision: " + n.label());
                String kind = decisions.get(n.label()) ? "true" : "false";
                current = outgoing.stream().filter(e -> e.kind().equals(kind)).findFirst().orElseThrow().target();
            }
        }
        throw new AssertionError("Trace did not terminate");
    }
    private List<String> labels(List<GraphNode> path) { return path.stream().map(GraphNode::label).toList(); }
    private List<GraphNode> until(Analysis a, GraphNode start, Predicate<GraphNode> stop) {
        List<GraphNode> path = new ArrayList<>(); GraphNode current = start;
        for (int i=0;i<50;i++) {
            path.add(current); if (stop.test(current)) return path;
            List<Edge> outgoing = exact(a,current.id()); assertEquals(1,outgoing.size(), current.label());
            current = node(a,outgoing.getFirst().target());
        }
        throw new AssertionError("Continuation target not reached");
    }

    @Test void normalAndReturnedCompletionsCannotCrossThroughSharedFinally() {
        Analysis a = inspect("try { if(flag) return 1; step(); } finally { cleanup(); } after(); return 2;");
        List<GraphNode> returned = trace(a, Map.of("flag",true));
        List<GraphNode> normal = trace(a, Map.of("flag",false));
        assertTrue(labels(returned).contains("return 1;")); assertFalse(labels(returned).contains("after();"));
        assertTrue(labels(normal).containsAll(List.of("step();","cleanup();","after();","return 2;")));
        assertEquals(1, labels(returned).stream().filter("cleanup();"::equals).count());
        assertEquals(1, labels(normal).stream().filter("cleanup();"::equals).count());
        assertNotEquals(returned.stream().filter(n -> n.kind().equals("finally_entry")).findFirst().orElseThrow().id(), normal.stream().filter(n -> n.kind().equals("finally_entry")).findFirst().orElseThrow().id());
        assertTrue(a.graph().edges().stream().filter(e -> Set.of("finally","resume").contains(e.kind())).allMatch(e -> e.completionContext()!=null && e.certainty().equals("exact")));
    }

    @Test void catchPredicatesAreOrderedAndMultiCatchRetainsOriginalTypesAndBinding() {
        String text="class Main {int f(){try{throw new IllegalArgumentException();}catch(IllegalArgumentException | IllegalStateException e){first();}catch(RuntimeException e){second();}return 0;}}";
        Analysis a=engine.inspect(bundle(text));
        GraphNode thrown=find(a,"ThrowStmt","throw new");
        GraphNode first=node(a,exact(a,thrown.id()).getFirst().target());
        assertEquals("catch_test",first.kind()); assertTrue(first.label().contains("IllegalArgumentException | IllegalStateException"));
        GraphNode second=node(a,exact(a,first.id()).stream().filter(e->e.kind().equals("false")).findFirst().orElseThrow().target());
        assertTrue(second.label().contains("RuntimeException"));
        String selected=text.substring(first.sourceRange().startOffset(),first.sourceRange().endOffset());
        assertEquals("IllegalArgumentException | IllegalStateException e",selected);
        List<String> path=labels(trace(a,Map.of(first.label(),true)));
        assertTrue(path.contains("first();")); assertFalse(path.contains("second();"));
        assertTrue(first.editableFields().isEmpty());
    }

    @Test void lazilyBuiltOuterCatchDoesNotInheritAnInnerFinalizerContext() {
        Analysis a=inspect("try{try{return 1;}finally{cleanup();}}catch(RuntimeException e){return 9;}");
        GraphNode test=find(a,"catch_test","RuntimeException");
        assertTrue(a.graph().edges().stream().filter(e->e.source().equals(test.id())).allMatch(e->e.completionContext()==null));
    }

    @Test void returnExpressionIsEvaluatedBeforeCleanupAndCanFailIntoCatch() {
        Analysis a=inspect("try{return compute();}catch(RuntimeException e){return 3;}finally{cleanup();}");
        List<GraphNode> path=trace(a,Map.of());
        assertTrue(labels(path).indexOf("return compute();")<labels(path).indexOf("cleanup();"));
        GraphNode returned=find(a,"ReturnStmt","compute");
        Edge failure=a.graph().edges().stream().filter(e->e.source().equals(returned.id())&&e.kind().equals("exception")).findFirst().orElseThrow();
        assertEquals("catch_test",node(a,failure.target()).kind()); assertEquals("conservative",failure.certainty()); assertFalse(failure.reason().isBlank());
    }

    @Test void returnInFinallyOverridesPreviousReturnWithoutResumingIt() {
        Analysis a=inspect("try{return 1;}finally{return 2;}");
        List<GraphNode> path=trace(a,Map.of());
        assertTrue(labels(path).containsAll(List.of("return 1;","return 2;")));
        assertEquals("normal_exit",path.getLast().kind());
        assertTrue(path.stream().noneMatch(n->n.kind().equals("finally_resume")));
        assertEquals(1,executable(a).stream().filter(n->n.kind().equals("finally_entry")).count(),"Unused cleanup variants must not appear as executable components");
    }

    @Test void throwInFinallyOverridesReturnAndReachesOuterCatch() {
        Analysis a=inspect("try{try{return 1;}finally{throw new IllegalStateException();}}catch(IllegalStateException e){return 9;}");
        List<GraphNode> path=trace(a,Map.of("исключение instanceof IllegalStateException",true));
        assertEquals("normal_exit",path.getLast().kind());
        assertTrue(labels(path).containsAll(List.of("return 1;","throw new IllegalStateException();","return 9;")));
        assertTrue(labels(path).indexOf("throw new IllegalStateException();")<labels(path).indexOf("return 9;"));
    }

    @Test void handlerThrowBypassesSiblingCatchesAndRunsBothFinalizersInOrder() {
        Analysis a=inspect("try{try{throw new IllegalArgumentException();}catch(IllegalArgumentException e){throw new IllegalStateException();}catch(IllegalStateException e){wrong();}finally{inner();}}catch(IllegalStateException e){outer();}finally{last();}return 0;");
        List<String> path=labels(trace(a,Map.of("исключение instanceof IllegalArgumentException",true,"исключение instanceof IllegalStateException",true)));
        assertFalse(path.contains("wrong();"));
        assertTrue(path.indexOf("inner();")<path.indexOf("outer();"));
        assertTrue(path.indexOf("outer();")<path.indexOf("last();"));
        assertEquals(1,path.stream().filter("inner();"::equals).count()); assertEquals(1,path.stream().filter("last();"::equals).count());
    }

    @Test void exceptionInFinallyDoesNotReenterSameTryCatch() {
        Analysis a=inspect("try{try{step();}catch(RuntimeException e){wrong();}finally{cleanup();}}catch(RuntimeException e){outer();}return 0;");
        GraphNode cleanup=find(a,"ExpressionStmt","cleanup();");
        GraphNode target=node(a,a.graph().edges().stream().filter(e->e.source().equals(cleanup.id())&&e.kind().equals("exception")).findFirst().orElseThrow().target());
        assertEquals("catch_test",target.kind());
        GraphNode caught=node(a,exact(a,target.id()).stream().filter(e->e.kind().equals("true")).findFirst().orElseThrow().target());
        assertTrue(caught.label().contains("RuntimeException"));
        List<GraphNode> handler=until(a,caught,n->n.kind().equals("ReturnStmt"));
        assertTrue(labels(handler).contains("outer();")); assertFalse(labels(handler).contains("wrong();"));
    }

    @Test void outwardContinueAndBreakCleanUpBeforeForUpdateOrExit() {
        Analysis a=inspect("for(int i=0;i<2;i++){try{if(flag)continue;break;}finally{cleanup();}}return 0;");
        List<GraphNode> continued=until(a,find(a,"ContinueStmt","continue"),n->n.kind().equals("for_update"));
        List<GraphNode> broken=until(a,find(a,"BreakStmt","break"),n->n.kind().equals("ReturnStmt"));
        assertTrue(labels(continued).contains("cleanup();")); assertTrue(labels(broken).contains("cleanup();"));
        assertEquals(1,continued.stream().filter(n->n.kind().equals("finally_entry")).count());
        assertEquals(1,broken.stream().filter(n->n.kind().equals("finally_entry")).count());
    }

    @Test void finallyJumpOverridesPendingReturnAndTargetsTheEnclosingLoop() {
        Analysis a=inspect("for(int i=0;i<3;i++){try{return 7;}finally{if(flag)continue;break;}}return 9;");
        GraphNode continued=find(a,"ContinueStmt","continue"),broken=find(a,"BreakStmt","break");
        assertEquals("for_update",node(a,exact(a,continued.id()).getFirst().target()).kind());
        assertEquals("return 9;",node(a,exact(a,broken.id()).getFirst().target()).label());
        GraphNode pending=find(a,"ReturnStmt","return 7;");
        List<GraphNode> toContinue=until(a,pending,n->n.kind().equals("condition_test"));
        assertTrue(toContinue.stream().anyMatch(n->n.kind().equals("finally_entry")));
        assertTrue(executable(a).stream().noneMatch(n->n.kind().equals("finally_resume")),"Every cleanup path overrides this pending return");
    }

    @Test void jumpsWhollyInsideTryDoNotPrematurelyRunCleanup() {
        Analysis a=inspect("try{while(flag){if(flag)continue;break;}afterLoop();}finally{cleanup();}return 0;");
        GraphNode continued=find(a,"ContinueStmt","continue"),broken=find(a,"BreakStmt","break");
        assertEquals("WhileStmt",node(a,exact(a,continued.id()).getFirst().target()).kind());
        assertEquals("afterLoop();",node(a,exact(a,broken.id()).getFirst().target()).label());
    }

    @Test void shortCircuitAtomsHaveOwnExceptionalTargetsWithoutExecutingSkippedRhs() {
        Analysis a=inspect("try{if(flag&&explode())yes();}catch(RuntimeException e){handled();}finally{cleanup();}return 0;");
        List<String> skipped=labels(trace(a,Map.of("flag",false)));
        assertFalse(skipped.contains("explode()")); assertFalse(skipped.contains("yes();")); assertTrue(skipped.contains("cleanup();"));
        GraphNode atom=find(a,"condition_test","explode()");
        Edge failure=a.graph().edges().stream().filter(e->e.source().equals(atom.id())&&e.kind().equals("exception")).findFirst().orElseThrow();
        assertEquals("catch_test",node(a,failure.target()).kind()); assertEquals("conservative",failure.certainty());
    }

    @Test void catchAndFinallyEditsStillUseExactOriginalSourceAndRebuildContextCopies() {
        String source="// 😀\nclass Main {int f(){try{return 1;}catch(RuntimeException e){return 2;}finally{cleanup(3);}}}";
        SourceBundle b=bundle(source);Analysis a=engine.inspect(b);
        GraphNode three=a.graph().nodes().stream().filter(n->n.kind().equals("expression")&&n.label().equals("3")).findFirst().orElseThrow();
        Candidate c=engine.propose(b,a,new EditCommand(b.revisionId(),a.id(),three.methodId(),three.id(),"replace_expression",new ReplaceExpression("expression","4"),"semantic_edit"));
        assertEquals(source.replace("cleanup(3)","cleanup((4))"),c.files().get("Main.java"));
        assertEquals(source,engine.exportUnchanged(b).get("Main.java"));
        Analysis rebuilt=engine.inspect(new SourceBundle("candidate",c.files()));
        assertTrue(rebuilt.graph().nodes().stream().anyMatch(n->n.kind().equals("finally_entry")));
        assertTrue(rebuilt.graph().nodes().stream().noneMatch(n->n.kind().equals("opaque")));
        assertFalse(rebuilt.graph().nodes().stream().anyMatch(n->n.label().equals("cleanup(3);")));
    }

    @Test void synchronizedRemainsExplicitlyOpaqueInsteadOfInventingMonitorSemantics() {
        String source="class Main {int f(){synchronized(this){return 1;}}}";
        Analysis a=engine.inspect(bundle(source));
        assertTrue(a.graph().nodes().stream().anyMatch(n->n.kind().equals("opaque")));
        assertTrue(a.graph().nodes().stream().allMatch(n->n.allowedOperations().isEmpty()));
        assertTrue(a.diagnostics().stream().anyMatch(d->d.code().equals("UNSUPPORTED_CONTROL_FLOW")));
    }

    @Test void expansionLimitRollsBackAllPartialFlowAndLeavesReadonlySourceBoundFallback() {
        Analysis a=inspect("int x=0;try{if(flag)return 1;throw new RuntimeException();}finally{"+"x++;".repeat(3000)+"}");
        assertTrue(a.diagnostics().stream().anyMatch(d->d.code().equals("EXCEPTION_FLOW_LIMIT")));
        assertTrue(a.graph().nodes().stream().anyMatch(n->n.kind().equals("opaque")));
        assertTrue(a.graph().nodes().stream().allMatch(n->n.allowedOperations().isEmpty()));
        assertTrue(a.graph().nodes().stream().noneMatch(n->n.kind().equals("finally_entry")));
        Set<String> ids=new HashSet<>();a.graph().nodes().forEach(n->ids.add(n.id()));
        assertTrue(a.graph().edges().stream().allMatch(e->ids.contains(e.source())&&ids.contains(e.target())));
    }

    @Test void legacyEdgeConstructorDoesNotInventCertaintyForHistoricalStoredGraphs() {
        Edge legacy=new Edge("e","from","to","throw",null,null);
        assertNull(legacy.certainty());assertNull(legacy.reason());
    }
}
