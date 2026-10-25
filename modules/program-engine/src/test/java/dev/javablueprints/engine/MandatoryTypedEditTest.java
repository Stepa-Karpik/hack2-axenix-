package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

/** Exact typed-source editing checks. Does not compile or execute fixture Java on this host. */
class MandatoryTypedEditTest {
    private final ProgramEngine engine = new ProgramEngine();
    private record Edited(SourceBundle base, Analysis before, GraphNode node, Candidate candidate, Analysis after) {}

    private Edited edit(String source, String anchor, String fragment, String replacement) {
        var bundle = new SourceBundle("typed-base", Map.of("Main.java", source));
        var analysis = engine.inspect(bundle);
        assertEquals("valid", analysis.parseStatus());
        int start = source.indexOf(fragment, source.indexOf(anchor));
        assertTrue(start >= 0, fragment);
        var node = analysis.graph().nodes().stream().filter(n -> n.kind().equals("expression")
                && n.sourceRange().startOffset() == start && n.sourceRange().endOffset() == start + fragment.length())
                .findFirst().orElseThrow(() -> new AssertionError("No exact expression projection: " + fragment));
        assertTrue(node.allowedOperations().contains("replace_expression"));
        assertEquals(List.of("expression"), node.editableFields());
        var candidate = engine.propose(bundle, analysis, new EditCommand(bundle.revisionId(), analysis.id(), node.methodId(), node.id(),
                "replace_expression", new ReplaceExpression("expression", replacement), "preserve_behavior"));
        assertEquals(1, candidate.changes().size());
        var change = candidate.changes().getFirst();
        assertEquals(fragment, change.before());
        assertEquals("(" + replacement + ")", change.after());
        assertEquals(source.substring(0,start)+change.after()+source.substring(start+fragment.length()),candidate.files().get("Main.java"));
        assertNotEquals(source,candidate.files().get("Main.java"));
        assertEquals(source, bundle.files().get("Main.java"));
        assertEquals("not_requested",candidate.compileStatus());
        assertEquals("unverified",candidate.verificationStatus());
        var after=engine.inspect(new SourceBundle("typed-candidate",candidate.files()));
        assertEquals("valid",after.parseStatus());
        assertNotEquals(analysis.id(),after.id());
        return new Edited(bundle,analysis,node,candidate,after);
    }

    @Test void editsNumericCastOperandWithoutNormalizingOverflowOrBoxing() {
        String source="class Main { static int f(Integer boxed) { int wrapped=(int)2147483648L; return wrapped+boxed; } }";
        var result=edit(source,"(int)","2147483648L","2147483647L + 1L");
        assertTrue(result.candidate().files().get("Main.java").contains("(int)(2147483647L + 1L)"));
        assertTrue(result.candidate().files().get("Main.java").contains("return wrapped+boxed"));
        assertTrue(result.after().semantics().references().stream().anyMatch(r->r.kind().equals("name")&&r.name().equals("boxed")
                &&r.resolution().equals("exact")&&"java.lang.Integer".equals(r.resolvedType())));
    }

    @Test void editsOnlyJaggedArrayIndexAndKeepsAliasingNullAndBoundsSemanticsInSource() {
        String source="class Main { static int f(int[][] rows,int index) { int[][] alias=rows; return alias[index][0]; } }";
        var result=edit(source,"return alias[","index","index + 0");
        assertTrue(result.candidate().files().get("Main.java").contains("int[][] alias=rows; return alias[(index + 0)][0]"));
        assertTrue(result.after().semantics().references().stream().filter(r->r.name().equals("alias")&&r.kind().equals("name"))
                .allMatch(r->r.resolution().equals("exact")));
    }

    @Test void editsCaseConstantProjectionAndRebuildsDispatchEdgeWithoutChangingFallthrough() {
        String source="class Main { static int f(int value) { int total=0; switch(value){case 1:total++;case 2:total+=2;break;default:total=-1;} return total; } }";
        var result=edit(source,"case ","1","0x1");
        assertTrue(result.after().graph().edges().stream().anyMatch(e->e.kind().equals("case")&&"(0x1)".equals(e.label())));
        assertEquals(2,result.after().graph().edges().stream().filter(e->e.kind().equals("case")).count());
        assertTrue(result.candidate().files().get("Main.java").contains("case (0x1):total++;case 2:total+=2;break;"));
        assertTrue(result.after().graph().nodes().stream().filter(n->n.kind().equals("switch_case")).allMatch(n->n.allowedOperations().isEmpty()));
    }

    @Test void editsMathArgumentAndStringCallWithoutInventingPurityOrComplexity() {
        String source="class Main { static int f(String text,int value) { return Math.abs(value)+text.length(); } }";
        var result=edit(source,"Math.abs(","value","value + 0");
        assertTrue(result.candidate().files().get("Main.java").contains("Math.abs((value + 0))+text.length()"));
        assertTrue(result.after().semantics().references().stream().filter(r->r.kind().equals("call")&&Set.of("abs","length").contains(r.name()))
                .allMatch(r->r.resolution().equals("exact")));
    }

    @Test void editsIteratorMutationArgumentWhileRetainingOrderAndProtocolOperations() {
        String source="class Main { static int f(){ java.util.List<Integer> values=new java.util.ArrayList<>(); values.add(4); values.add(7); java.util.Iterator<Integer> iterator=values.iterator(); int total=0; while(iterator.hasNext()){int value=iterator.next();if(value<5)iterator.remove();else total+=value;}return total+values.size();} }";
        var result=edit(source,"values.add(","4","2 + 2");
        assertTrue(result.candidate().files().get("Main.java").contains("values.add((2 + 2)); values.add(7)"));
        for(String call:List.of("hasNext","next","remove")) {
            var references=result.after().semantics().references().stream().filter(r->r.kind().equals("call")&&r.name().equals(call)).toList();
            assertFalse(references.isEmpty());
            assertTrue(references.stream().allMatch(r->r.resolution().equals("exact")),call);
        }
        assertTrue(result.after().graph().nodes().stream().anyMatch(n->n.kind().equals("WhileStmt")));
    }

    @Test void editsNamedComparatorOperandRetainingImplementsAndExactJdkCallBinding() {
        String source="class Main implements java.util.Comparator<Integer> { public int compare(Integer left,Integer right){return Integer.compare(left,right);} }";
        var result=edit(source,"Integer.compare(","left","left + 0");
        assertTrue(result.candidate().files().get("Main.java").contains("implements java.util.Comparator<Integer>"));
        var compare=result.after().semantics().references().stream().filter(r->r.kind().equals("call")&&r.name().equals("compare")).findFirst().orElseThrow();
        assertEquals("exact",compare.resolution());
        assertTrue(result.after().semantics().symbols().stream().anyMatch(s->compare.targetIds().contains(s.id())&&s.external()&&s.qualifiedName().equals("java.lang.Integer.compare")));
    }

    @Test void editsOptionalFallbackArgumentWithoutEliminatingEagerSideEffects() {
        String source="class Main { static int calls; static int fallback(int n){calls++;return n;} static int f(Integer input){java.util.Optional<Integer> optional=java.util.Optional.ofNullable(input);return optional.orElse(fallback(9))+calls;} }";
        var result=edit(source,"orElse(fallback(","9","3 * 3");
        assertTrue(result.candidate().files().get("Main.java").contains("orElse(fallback((3 * 3)))+calls"));
        assertEquals(1,result.after().semantics().references().stream().filter(r->r.kind().equals("call")&&r.name().equals("fallback")&&r.resolution().equals("exact")).count());
        assertEquals(1,result.after().semantics().references().stream().filter(r->r.kind().equals("call")&&r.name().equals("orElse")&&r.resolution().equals("exact")).count());
    }

    @Test void rejectsOldNodeWhenCandidateReanalysisHasNewSourceBindings() {
        var result=edit("class Main { int f(int[] values,int index){return values[index];} }","values[","index","index + 0");
        var error=assertThrows(EngineException.class,()->engine.propose(new SourceBundle("typed-candidate",result.candidate().files()),result.after(),
                new EditCommand("typed-candidate",result.after().id(),result.node().methodId(),result.node().id(),"replace_expression",new ReplaceExpression("expression","0"),"preserve_behavior")));
        assertEquals("ANALYSIS_CONFLICT",error.code());
    }

    @Test void unsafeHoistIsExplicitlyUnavailableForExceptionalAndSideEffectingLoops() {
        for(String source:List.of(
                "class Main { int f(int denominator){int total=0;for(int i=0;i<3;i++){total+=10/denominator;}return total;} }",
                "class Main { int calls;int next(){return calls++;} int f(){int total=0;for(int i=0;i<3;i++){total+=next();}return total;} }")) {
            var bundle=new SourceBundle("unsafe",Map.of("Main.java",source));
            var analysis=engine.inspect(bundle);
            assertTrue(analysis.optimizations().isEmpty());
            var loop=analysis.graph().nodes().stream().filter(n->n.kind().equals("ForStmt")).findFirst().orElseThrow();
            assertFalse(loop.allowedOperations().contains("hoist_expression"));
            var unsupported=assertThrows(EngineException.class,()->engine.propose(bundle,analysis,new EditCommand("unsafe",analysis.id(),loop.methodId(),loop.id(),"hoist_expression",new OptimizeMembership(),"preserve_behavior")));
            assertEquals("UNSUPPORTED_OPERATION",unsupported.code());
            var forged=assertThrows(EngineException.class,()->engine.propose(bundle,analysis,new EditCommand("unsafe",analysis.id(),loop.methodId(),loop.id(),"optimize_membership",new OptimizeMembership(),"preserve_behavior")));
            assertEquals("UNSUPPORTED_OPERATION",forged.code());
            assertEquals(source,bundle.files().get("Main.java"));
        }
    }
}
