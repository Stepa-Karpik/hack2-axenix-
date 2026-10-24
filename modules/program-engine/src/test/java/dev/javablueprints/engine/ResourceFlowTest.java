package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import java.util.*;
import java.util.function.Predicate;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ResourceFlowTest {
    final ProgramEngine engine = new ProgramEngine();
    SourceBundle bundle(String text) { return new SourceBundle("resources", Map.of("Main.java", text)); }
    Analysis inspect(String body) {
        Analysis a = engine.inspect(bundle("class Main {int f(boolean flag){" + body + "}}"));
        assertEquals("valid", a.parseStatus(), a.diagnostics().toString());
        assertFalse(a.diagnostics().stream().anyMatch(d -> d.code().equals("UNSUPPORTED_CONTROL_FLOW")), a.diagnostics().toString());
        return a;
    }
    GraphNode node(Analysis a, String id) { return a.graph().nodes().stream().filter(n -> n.id().equals(id)).findFirst().orElseThrow(); }
    List<GraphNode> trace(Analysis a, Map<String,Boolean> decisions, Set<String> failures) {
        return trace(a, decisions, failures, n -> n.kind().equals("normal_exit") || n.kind().equals("exceptional_exit"));
    }
    List<GraphNode> trace(Analysis a, Map<String,Boolean> decisions, Set<String> failures, Predicate<GraphNode> stop) {
        List<GraphNode> path = new ArrayList<>();
        String cursor = a.graph().methods().getFirst().entryNodeId();
        for (int i = 0; i < 300; i++) {
            GraphNode current = node(a,cursor); path.add(current);
            if (stop.test(current)) return path;
            List<Edge> out = a.graph().edges().stream().filter(e -> e.source().equals(current.id())).toList();
            if (failures.contains(current.label()) && out.stream().anyMatch(e -> e.kind().equals("exception"))) {
                cursor = out.stream().filter(e -> e.kind().equals("exception")).findFirst().orElseThrow().target();
            } else {
                List<Edge> exact = out.stream().filter(e -> !"conservative".equals(e.certainty())).toList();
                if (exact.size() == 1) cursor = exact.getFirst().target();
                else {
                    boolean yes = decisions.getOrDefault(current.label(), !current.kind().equals("resource_suppression_check"));
                    cursor = exact.stream().filter(e -> e.kind().equals(yes ? "true" : "false")).findFirst().orElseThrow(() -> new AssertionError(current.label()+" "+exact)).target();
                }
            }
        }
        throw new AssertionError("Nonterminating trace " + path.stream().map(GraphNode::label).toList());
    }
    List<String> labels(List<GraphNode> nodes) { return nodes.stream().map(GraphNode::label).toList(); }
    List<String> closes(List<GraphNode> nodes) { return nodes.stream().filter(n -> n.kind().equals("resource_close")).map(GraphNode::label).toList(); }

    @Test void acquisitionIsLeftToRightAndEveryAcquiredResourceClosesOnceInReverseOrder() {
        Analysis a=inspect("try(R a=openA();R b=openB()){work();}after();return 1;");
        var path=trace(a,Map.of(),Set.of());var names=labels(path);
        assertTrue(names.indexOf("R a=openA()") < names.indexOf("R b=openB()"));
        assertTrue(names.indexOf("R b=openB()") < names.indexOf("work();"));
        assertEquals(List.of("b.close()","a.close()"),closes(path));
        assertTrue(names.indexOf("a.close()") < names.indexOf("after();"));
        assertEquals("normal_exit",path.getLast().kind());
    }
    @Test void nullResourceIsNotClosedAndDoesNotPreventEarlierCleanup() {
        Analysis a=inspect("try(R a=openA();R b=null){work();}return 1;");
        assertEquals(List.of("a.close()"),closes(trace(a,Map.of("b != null",false),Set.of())));
        assertEquals(List.of(),closes(trace(a,Map.of("b != null",false,"a != null",false),Set.of())));
    }
    @Test void failingInitializerClosesOnlyTheAlreadyAcquiredPrefixBeforeSameTryCatchAndFinally() {
        Analysis a=inspect("try(R a=openA();R b=openB()){work();}catch(Exception e){handled();}finally{last();}return 1;");
        var path=trace(a,Map.of(),Set.of("R b=openB()"));var names=labels(path);
        assertEquals(List.of("a.close()"),closes(path));assertFalse(names.contains("work();"));
        assertTrue(names.indexOf("a.close()") < names.indexOf("handled();"));
        assertTrue(names.indexOf("handled();") < names.indexOf("last();"));
        assertEquals(List.of(),closes(trace(a,Map.of(),Set.of("R a=openA()"))));
    }
    @Test void primaryFailureSurvivesTwoDistinctCloseFailuresInReverseSuppressionOrder() {
        Analysis a=inspect("try(R a=openA();R b=openB()){throw problem;}catch(Exception e){handled();}return 1;");
        var path=trace(a,Map.of(),Set.of("a.close()","b.close()"));
        assertEquals(List.of("b.close()","a.close()"),closes(path));
        var suppressed=path.stream().filter(n->n.kind().equals("resource_suppress")).toList();
        assertEquals(2,suppressed.size());assertTrue(suppressed.get(0).label().endsWith("· b"));assertTrue(suppressed.get(1).label().endsWith("· a"));
        assertEquals(2,path.stream().filter(n->n.kind().equals("resource_primary")).count());
        assertTrue(path.stream().filter(n->n.kind().equals("resource_resume")).allMatch(n->n.label().contains("исключение")));
        assertTrue(labels(path).contains("handled();"));
    }
    @Test void firstCloseFailureBecomesPrimaryAndOverridesReturnBeforeRemainingResourcesAndHandler() {
        Analysis a=inspect("try(R a=openA();R b=openB()){return 7;}catch(Exception e){handled();}finally{last();}return 9;");
        var path=trace(a,Map.of(),Set.of("a.close()","b.close()"));
        assertEquals(List.of("b.close()","a.close()"),closes(path));
        assertEquals(1,path.stream().filter(n->n.kind().equals("resource_suppress")).count());
        assertTrue(path.stream().anyMatch(n->n.kind().equals("resource_throw")&&n.label().contains("возврат")));
        assertTrue(labels(path).containsAll(List.of("handled();","last();","return 9;")));
        assertFalse(path.stream().anyMatch(n->n.kind().equals("resource_resume")&&n.label().contains("возврат")));
    }
    @Test void selfSuppressionReplacesPrimaryButOuterResourceStillClosesAgainstTheNewException() {
        Analysis a=inspect("try(R a=openA();R b=openB()){throw problem;}catch(Exception e){handled();}return 1;");
        var path=trace(a,Map.of("ошибка close == основное исключение · b",true),Set.of("b.close()","a.close()"));
        assertEquals(List.of("b.close()","a.close()"),closes(path));
        assertTrue(path.stream().anyMatch(n->n.kind().equals("resource_throw")&&n.label().contains("самоподавление")));
        assertEquals(1,path.stream().filter(n->n.kind().equals("resource_suppress")).count());
        assertTrue(path.stream().filter(n->n.kind().equals("resource_suppress")).allMatch(n->n.label().endsWith("· a")));
    }
    @Test void suppressionCallIsAtomicAndDoesNotClaimDisabledSuppressionAlwaysAppends() {
        Analysis a=inspect("try(R a=openA()){throw problem;}return 1;");
        var path=trace(a,Map.of(),Set.of("a.close()"));
        GraphNode add=path.stream().filter(n->n.kind().equals("resource_suppress")).findFirst().orElseThrow();
        Edge success=a.graph().edges().stream().filter(e->e.source().equals(add.id())&&e.kind().equals("suppressed")).findFirst().orElseThrow();
        assertTrue(success.reason().contains("only if suppression is enabled"));
        Edge failure=a.graph().edges().stream().filter(e->e.source().equals(add.id())&&e.kind().equals("exception")).findFirst().orElseThrow();
        assertEquals("conservative",failure.certainty());assertEquals("resource_throw",node(a,failure.target()).kind());
        assertEquals("exceptional_exit",path.getLast().kind());
    }
    @Test void loopExitAndContinuationCloseResourcesButInternalLoopJumpDoesNot() {
        Analysis a=inspect("for(int i=0;i<2;i++){try(R a=openA()){if(flag)continue;break;}}return 1;");
        var continued=trace(a,Map.of("flag",true),Set.of(),n->n.kind().equals("for_update"));
        assertEquals(List.of("a.close()"),closes(continued));assertEquals("for_update",continued.getLast().kind());
        assertEquals(List.of("a.close()"),closes(trace(a,Map.of("flag",false),Set.of())));
        Analysis inner=inspect("try(R a=openA()){while(flag){break;}work();}return 1;");
        var path=trace(inner,Map.of("flag",true),Set.of());
        assertTrue(labels(path).indexOf("work();") < labels(path).indexOf("a.close()"));
    }
    @Test void existingResourceReferenceIsCapturedOnceAndGeneratedCleanupNeverPretendsToBeSource() {
        String source="class Main {R reader;int f(){try(this.reader){return 3;}}}";
        Analysis a=engine.inspect(bundle(source));
        var init=a.graph().nodes().stream().filter(n->n.kind().equals("resource_init")).toList();
        assertEquals(1,init.size());assertEquals("this.reader",source.substring(init.getFirst().sourceRange().startOffset(),init.getFirst().sourceRange().endOffset()));
        for(GraphNode n:a.graph().nodes().stream().filter(n->n.kind().startsWith("resource_")).toList()) {
            assertTrue(n.allowedOperations().isEmpty());assertTrue(n.editableFields().isEmpty());
            if(!n.kind().equals("resource_init")){assertTrue(n.synthetic());assertNull(n.sourceRange());}
        }
        assertTrue(a.graph().nodes().stream().anyMatch(n->n.kind().equals("resource_close")&&n.label().equals("this.reader.close()")));
    }
    @Test void enhancedIterationJumpsCloseOnlyWhenLeavingTheResourceScope() {
        Analysis outerLoop=inspect("for(int value:values()){try(R a=openA()){continue;}}return 1;");
        var leaving=trace(outerLoop,Map.of(),Set.of(),n->n.kind().equals("foreach_advance"));
        assertEquals(List.of("a.close()"),closes(leaving));
        Analysis innerLoop=inspect("try(R a=openA()){for(int value:values()){continue;}}return 1;");
        var staying=trace(innerLoop,Map.of(),Set.of(),n->n.kind().equals("foreach_advance"));
        assertEquals(List.of(),closes(staying));
    }
    @Test void initializerExpressionEditsRetainOriginalTriviaAndRegenerateResourceProtocol() {
        String source="// 😀\nclass Main {int f(){try(R r=open(\"old\")){return 3;}}}";
        SourceBundle b=bundle(source);Analysis a=engine.inspect(b);
        GraphNode literal=a.graph().nodes().stream().filter(n->n.kind().equals("expression")&&n.label().equals("\"old\"")).findFirst().orElseThrow();
        Candidate c=engine.propose(b,a,new EditCommand(b.revisionId(),a.id(),literal.methodId(),literal.id(),"replace_expression",new ReplaceExpression("expression","\"new\""),"semantic_edit"));
        assertEquals(source.replace("\"old\"","(\"new\")"),c.files().get("Main.java"));
        assertEquals(source,engine.exportUnchanged(b).get("Main.java"));
        assertTrue(engine.inspect(new SourceBundle("candidate",c.files())).graph().nodes().stream().anyMatch(n->n.kind().equals("resource_close")));
    }
    @Test void resourceCountBudgetRollsBackEveryPartialNodeEdgeAndBinding() {
        String resources=String.join(";",java.util.stream.IntStream.range(0,65).mapToObj(i->"R r"+i+"=open()").toList());
        Analysis a=inspect("try("+resources+"){return 1;}");
        assertTrue(a.diagnostics().stream().anyMatch(d->d.code().equals("EXCEPTION_FLOW_LIMIT")));
        assertTrue(a.graph().nodes().stream().anyMatch(n->n.kind().equals("opaque")));
        assertTrue(a.graph().nodes().stream().noneMatch(n->n.kind().startsWith("resource_")));
        assertTrue(a.graph().nodes().stream().allMatch(n->n.allowedOperations().isEmpty()));
        Set<String> ids=new HashSet<>();a.graph().nodes().forEach(n->ids.add(n.id()));
        assertTrue(a.graph().edges().stream().allMatch(e->ids.contains(e.source())&&ids.contains(e.target())));
    }
    @Test void returnEvaluationFailureEntersPrimaryCleanupAndDoesNotResumeTheReturn() {
        Analysis a=inspect("try(R a=openA()){return calculate();}catch(Exception e){return 9;}");
        var path=trace(a,Map.of(),Set.of("return calculate();"));
        assertEquals(List.of("a.close()"),closes(path));
        assertTrue(path.stream().anyMatch(n->n.kind().equals("resource_primary")));
        assertTrue(path.stream().noneMatch(n->n.kind().equals("resource_resume")&&n.label().contains("возврат")));
        assertTrue(labels(path).contains("return 9;"));
    }
}
