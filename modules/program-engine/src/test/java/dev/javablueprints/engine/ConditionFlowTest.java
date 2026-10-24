package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;

import java.util.*;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

class ConditionFlowTest {
    private final ProgramEngine engine = new ProgramEngine();
    private SourceBundle bundle(String source) { return new SourceBundle("r", Map.of("Main.java",source)); }
    private Analysis analyze(String source) {
        Analysis a=engine.inspect(bundle(source));
        assertEquals("valid",a.parseStatus(),a.diagnostics().toString());
        return a;
    }
    private String source(String expression) {
        return "class Main {void f(){if("+expression+"){yes();}else{no();}} boolean a(){return true;}boolean b(){return true;}boolean c(){return true;}void yes(){}void no(){}}";
    }
    private Method method(Analysis a) { return a.graph().methods().stream().filter(m->m.signature().equals("f()")).findFirst().orElseThrow(); }
    private GraphNode node(Analysis a,String id) { return a.graph().nodes().stream().filter(n->n.id().equals(id)).findFirst().orElseThrow(); }
    private List<GraphNode> nodes(Analysis a) { return a.graph().nodes().stream().filter(n->n.methodId().equals(method(a).id())).toList(); }
    private Edge outgoing(Analysis a,GraphNode node,String kind) {
        List<Edge> matches=a.graph().edges().stream().filter(e->e.source().equals(node.id())&&e.kind().equals(kind)).toList();
        assertEquals(1,matches.size(),node+" "+kind);
        return matches.getFirst();
    }
    /** Traces graph decisions supplied by the fixture; it does not interpret or execute source Java. */
    private List<String> trace(Analysis a, Function<String,Boolean> outcomes) {
        Map<String,GraphNode> nodes=a.graph().nodes().stream().collect(Collectors.toMap(GraphNode::id,Function.identity()));
        Map<String,List<Edge>> edges=a.graph().edges().stream().collect(Collectors.groupingBy(Edge::source));
        List<String> visited=new ArrayList<>();
        GraphNode current=nodes.get(method(a).entryNodeId());
        for(int steps=0;steps<1000;steps++) {
            assertNotEquals("ast_projection",current.executionRole(),"AST projections must not be executed");
            if(current.kind().equals("normal_exit")||current.kind().equals("exceptional_exit")) return visited;
            List<Edge> next=edges.getOrDefault(current.id(),List.of());
            if(current.executionRole().equals("condition_test")) {
                visited.add(current.label());
                String chosen=outcomes.apply(current.label())?"true":"false";
                current=nodes.get(next.stream().filter(e->e.kind().equals(chosen)).findFirst().orElseThrow().target());
            } else {
                if(current.executionRole().equals("statement")) visited.add(current.label());
                assertEquals(1,next.size(),current.toString());
                current=nodes.get(next.getFirst().target());
            }
        }
        fail("Fixture exceeded bounded graph trace");return List.of();
    }

    @Test void truthTablesSkipRhsAndPreserveSingleEvaluationOfAtoms() {
        for(boolean a:List.of(false,true))for(boolean b:List.of(false,true)) {
            Map<String,Boolean> values=Map.of("a()",a,"b()",b);
            List<String> and=new ArrayList<>(List.of("a()"));if(a)and.add("b()");and.add(a&&b?"yes();":"no();");
            assertEquals(and,trace(analyze(source("a()&&b()")),values::get));
            List<String> or=new ArrayList<>(List.of("a()"));if(!a)or.add("b()");or.add(a||b?"yes();":"no();");
            assertEquals(or,trace(analyze(source("a()||b()")),values::get));
        }
    }

    @Test void precedenceGroupingAndNegationChooseTheExpectedPathsWithoutExtraTests() {
        for(boolean a:List.of(false,true))for(boolean b:List.of(false,true))for(boolean c:List.of(false,true)) {
            Map<String,Boolean> values=Map.of("a()",a,"b()",b,"c()",c);
            List<String> first=new ArrayList<>(List.of("a()"));if(!a){first.add("b()");if(b)first.add("c()");}first.add(a||b&&c?"yes();":"no();");
            assertEquals(first,trace(analyze(source("a()||b()&&c()")),values::get));
            List<String> second=new ArrayList<>(List.of("a()"));if(!a)second.add("b()");if(a||b)second.add("c()");second.add((a||b)&&c?"yes();":"no();");
            assertEquals(second,trace(analyze(source("(a()||b())&&c()")),values::get));
            List<String> negated=new ArrayList<>(List.of("a()"));if(a)negated.add("b()");negated.add(!(a&&b)?"yes();":"no();");
            assertEquals(negated,trace(analyze(source("!(a()&&b())")),values::get));
            assertEquals(List.of("a()",a?"yes();":"no();"),trace(analyze(source("!!((a()))")),values::get));
        }
    }

    @Test void executionRolesSeparateHeadersAndProjectionsFromNonEditableTests() {
        Analysis a=analyze(source("a()&&b()"));
        GraphNode header=nodes(a).stream().filter(n->n.kind().equals("IfStmt")).findFirst().orElseThrow();
        assertEquals("structural",header.executionRole());
        assertEquals(List.of("condition"),header.editableFields());
        assertEquals("condition_test",node(a,outgoing(a,header,"normal").target()).executionRole());
        for(GraphNode n:nodes(a)) {
            assertNotNull(n.executionRole());
            if(n.kind().equals("condition_test")) {
                assertFalse(n.synthetic());assertNotNull(n.sourceRange());assertNotNull(n.astBinding());
                assertTrue(n.editableFields().isEmpty());assertTrue(n.editableFieldRanges().isEmpty());
                assertTrue(n.allowedOperations().isEmpty());assertTrue(n.insertionPositions().isEmpty());
            }
            if(n.kind().equals("expression"))assertEquals("ast_projection",n.executionRole());
            if(n.kind().equals("block")||n.kind().equals("entry"))assertEquals("structural",n.executionRole());
            if(n.synthetic())assertEquals("synthetic",n.executionRole());
        }
        assertTrue(a.graph().edges().stream().noneMatch(e->node(a,e.source()).executionRole().equals("ast_projection")||node(a,e.target()).executionRole().equals("ast_projection")));
    }

    @Test void absentElseAndEmptyBodiesMergeWithoutDuplicateEvaluation() {
        Analysis a=analyze("class Main {void f(){if(a()&&b()){}done();}boolean a(){return true;}boolean b(){return true;}void done(){}}");
        assertEquals(List.of("a()","done();"),trace(a,s->false));
        assertEquals(List.of("a()","b()","done();"),trace(a,s->true));
    }

    @Test void forZeroAndRepeatedIterationsKeepInitUpdateAndContinueInOrder() {
        Analysis a=analyze("class Main {void f(){for(int i=0;left()&&right();i++){if(skip())continue;work();}done();}boolean left(){return true;}boolean right(){return true;}boolean skip(){return false;}void work(){}void done(){}}");
        assertEquals(List.of("int i=0","left()","done();"),trace(a,label->false));
        Map<String,Deque<Boolean>> values=new HashMap<>();
        values.put("left()",new ArrayDeque<>(List.of(true,true,true,false)));
        values.put("right()",new ArrayDeque<>(List.of(true,true,true)));
        values.put("skip()",new ArrayDeque<>(List.of(true,false,true)));
        assertEquals(List.of("int i=0","left()","right()","skip()","continue;","i++",
                "left()","right()","skip()","work();","i++","left()","right()","skip()","continue;","i++","left()","done();"),
                trace(a,label->values.get(label).removeFirst()));
        GraphNode jump=nodes(a).stream().filter(n->n.kind().equals("ContinueStmt")).findFirst().orElseThrow();
        assertEquals("for_update",node(a,outgoing(a,jump,"continue").target()).kind());
        assertEquals("statement",nodes(a).stream().filter(n->n.kind().equals("for_init")).findFirst().orElseThrow().executionRole());
    }

    @Test void nestedWhileJumpsRetainNearestLoopTargets() {
        Analysis a=analyze("class Main {void f(){while(outer()){while(inner()){if(stop())break;continue;}continue;}done();}boolean outer(){return true;}boolean inner(){return true;}boolean stop(){return true;}void done(){}}");
        List<GraphNode> loops=nodes(a).stream().filter(n->n.kind().equals("WhileStmt")).toList();
        GraphNode outer=loops.stream().filter(n->n.label().startsWith("while(outer" )).findFirst().orElseThrow();
        GraphNode inner=loops.stream().filter(n->n.label().startsWith("while(inner" )).findFirst().orElseThrow();
        List<Edge> jumps=a.graph().edges().stream().filter(e->e.kind().equals("continue")).toList();
        assertEquals(Set.of(outer.id(),inner.id()),jumps.stream().map(Edge::target).collect(Collectors.toSet()));
        GraphNode breaking=nodes(a).stream().filter(n->n.kind().equals("BreakStmt")).findFirst().orElseThrow();
        GraphNode target=node(a,outgoing(a,breaking,"break").target());
        assertEquals("ContinueStmt",target.kind());
        assertEquals(outer.id(),outgoing(a,target,"continue").target());
    }

    @Test void whileRepeatedContinueAndSkippedRhsPreserveConditionEvaluationOrder() {
        Analysis a=analyze("class Main {void f(){while(left()||right()){work();continue;}done();}boolean left(){return false;}boolean right(){return false;}void work(){}void done(){}}");
        assertEquals(List.of("left()","right()","done();"),trace(a,label->false));
        Map<String,Deque<Boolean>> values=new HashMap<>();
        values.put("left()",new ArrayDeque<>(List.of(true,false,false)));
        values.put("right()",new ArrayDeque<>(List.of(true,false)));
        assertEquals(List.of("left()","work();","continue;","left()","right()","work();","continue;","left()","right()","done();"),
                trace(a,label->values.get(label).removeFirst()));
    }

    @Test void doBodyRunsBeforeConditionAndContinueGoesToConditionHeader() {
        Analysis a=analyze("class Main {void f(){do{work();continue;}while(left()||right());done();}boolean left(){return false;}boolean right(){return false;}void work(){}void done(){}}");
        assertEquals(List.of("work();","continue;","left()","right()","done();"),trace(a,label->false));
        GraphNode jump=nodes(a).stream().filter(n->n.kind().equals("ContinueStmt")).findFirst().orElseThrow();
        GraphNode header=node(a,outgoing(a,jump,"continue").target());
        assertEquals("DoStmt",header.kind());assertEquals("structural",header.executionRole());
        assertEquals("condition_test",node(a,outgoing(a,header,"normal").target()).kind());
        Map<String,Deque<Boolean>> values=new HashMap<>();
        values.put("left()",new ArrayDeque<>(List.of(true,false)));
        values.put("right()",new ArrayDeque<>(List.of(false)));
        assertEquals(List.of("work();","continue;","left()","work();","continue;","left()","right()","done();"),
                trace(a,label->values.get(label).removeFirst()));
    }

    @Test void unconditionalForHasNoFalseExitAndAbruptStatementsHaveNoFallthrough() {
        Analysis a=analyze("class Main {void f(){for(;;){break;}done();}void done(){}}");
        GraphNode loop=nodes(a).stream().filter(n->n.kind().equals("ForStmt")).findFirst().orElseThrow();
        assertTrue(nodes(a).stream().noneMatch(n->n.kind().equals("condition_test")));
        assertEquals("normal",a.graph().edges().stream().filter(e->e.source().equals(loop.id())).findFirst().orElseThrow().kind());
        assertTrue(a.graph().edges().stream().noneMatch(e->e.source().equals(loop.id())&&e.kind().equals("false")));
        Analysis abrupt=analyze("class Main {void f(){if(a())return;else throw new RuntimeException();}boolean a(){return true;}}");
        for(GraphNode n:nodes(abrupt))if(n.kind().equals("ReturnStmt")||n.kind().equals("ThrowStmt")) {
            List<Edge> exits=abrupt.graph().edges().stream().filter(e->e.source().equals(n.id())).toList();
            assertEquals(1,exits.size());
            assertEquals(n.kind().equals("ReturnStmt")?"normal_exit":"exceptional_exit",node(abrupt,exits.getFirst().target()).kind());
        }
    }

    @Test void eagerAndTernarySubtreesRemainSingleAtomsAndExceptionCoverageStaysPartial() {
        for(String expression:List.of("a()&b()","a()|b()","a()^b()","a()?b():c()")) {
            Analysis a=analyze(source(expression));
            List<GraphNode> atoms=nodes(a).stream().filter(n->n.kind().equals("condition_test")).toList();
            assertEquals(1,atoms.size());assertEquals(expression,atoms.getFirst().label());
        }
        Analysis mixed=analyze(source("(a()&b())||c()"));
        assertEquals(List.of("a()&b()","yes();"),trace(mixed,label->true));
        assertTrue(mixed.coverage().stream().anyMatch(c->c.feature().equals("condition_flow")&&c.status().equals("partial")&&c.reason().contains("exceptional")));
        assertTrue(mixed.coverage().stream().anyMatch(c->c.feature().equals("control_flow")&&c.status().equals("partial")));
    }

    @Test void skippedThrowingRhsIsAbsentFromNormalPathWithoutInventedExceptionEdges() {
        Analysis a=analyze("class Main {void f(){if(left()&&throwsNow())yes();else no();}boolean left(){return false;}boolean throwsNow(){throw new RuntimeException();}void yes(){}void no(){}}");
        assertEquals(List.of("left()","no();"),trace(a,label->false));
        assertEquals(List.of("left()","throwsNow()","yes();"),trace(a,label->true));
        // This second trace asserts only normal-completion topology, not that throwsNow returns.
        assertTrue(a.graph().edges().stream().noneMatch(e->nodes(a).stream().anyMatch(n->n.kind().equals("condition_test")&&n.id().equals(e.source()))&&e.kind().equals("throw")));
    }

    @Test void nullableUnboxingAndNonConditionBooleanExpressionsDoNotGainFalsePrecision() {
        Analysis a=analyze("class Main {Boolean boxed; void f(){boolean value=a()&&b();if(boxed&&a())yes();}boolean a(){return true;}boolean b(){return true;}void yes(){}}");
        assertEquals(Set.of("boxed","a()"),nodes(a).stream().filter(n->n.kind().equals("condition_test")).map(GraphNode::label).collect(Collectors.toSet()));
        assertTrue(nodes(a).stream().filter(n->n.label().equals("a()&&b()")).allMatch(n->n.executionRole().equals("ast_projection")));
        assertTrue(a.coverage().stream().anyMatch(c->c.feature().equals("condition_flow")&&c.reason().contains("unboxing")));
        assertEquals("partial",a.symbolStatus());
        assertTrue(a.coverage().stream().anyMatch(c->c.feature().equals("complexity")&&c.status().equals("unknown")));
    }

    @Test void opaqueDomainsDoNotGainConditionTestsOrEditableFlow() {
        for(String statement:List.of("try{if(a()&&b())yes();}finally{}","switch(1){default:if(a()&&b())yes();}",
                "outer:while(a()&&b()){break outer;}","for(String s:new String[0]){if(a()&&b())yes();}")) {
            String source="class Main {void f(){"+statement+"}boolean a(){return true;}boolean b(){return true;}void yes(){}}";
            Analysis a=analyze(source);
            assertTrue(nodes(a).stream().anyMatch(n->n.kind().equals("opaque")));
            assertTrue(nodes(a).stream().noneMatch(n->n.kind().equals("condition_test")));
            assertTrue(nodes(a).stream().allMatch(n->n.allowedOperations().isEmpty()));
            assertEquals(source,engine.exportUnchanged(bundle(source)).get("Main.java"));
        }
    }

    @Test void exactUtf16RangesAndExistingConditionEditRebuildOnlyCurrentDecisionTree() {
        String source="// 😀\nclass Main {void f(){\tif(a() /* сохранить */ && b())yes();else no();}boolean a(){return true;}boolean b(){return true;}void yes(){}void no(){}}\n";
        SourceBundle b=bundle(source);Analysis a=engine.inspect(b);
        for(GraphNode atom:nodes(a).stream().filter(n->n.kind().equals("condition_test")).toList()) {
            assertEquals(atom.label(),source.substring(atom.sourceRange().startOffset(),atom.sourceRange().endOffset()));
            assertEquals(source.indexOf(atom.label()),atom.sourceRange().startOffset());
        }
        GraphNode header=nodes(a).stream().filter(n->n.kind().equals("IfStmt")).findFirst().orElseThrow();
        EditCommand edit=new EditCommand(a.revisionId(),a.id(),header.methodId(),header.id(),"replace_expression",new ReplaceExpression("condition","a()||b()"),"semantic_edit");
        assertEquals("UNSUPPORTED_OPERATION",assertThrows(EngineException.class,()->engine.propose(b,a,edit)).code());
        String clean=source.replace(" /* сохранить */ ","");SourceBundle c=bundle(clean);Analysis base=engine.inspect(c);
        GraphNode branch=nodes(base).stream().filter(n->n.kind().equals("IfStmt")).findFirst().orElseThrow();
        Candidate candidate=engine.propose(c,base,new EditCommand(base.revisionId(),base.id(),branch.methodId(),branch.id(),"replace_expression",new ReplaceExpression("condition","a()||b()"),"semantic_edit"));
        Analysis changed=engine.inspect(new SourceBundle("candidate",candidate.files()));
        assertEquals(List.of("a()","yes();"),trace(changed,label->true));
        assertEquals("not_requested",candidate.compileStatus());assertEquals("unverified",candidate.verificationStatus());
        assertNotEquals(base.id(),changed.id());assertEquals(clean,c.files().get("Main.java"));
        assertEquals(source,engine.exportUnchanged(b).get("Main.java"));
    }

    @Test void conditionTestsAreReadOnlyAndForgedRolesOrStaleAnalysisCannotAuthorizeEdits() {
        String source=source("a()&&b()");SourceBundle b=bundle(source);Analysis a=engine.inspect(b);
        GraphNode atom=nodes(a).stream().filter(n->n.kind().equals("condition_test")).findFirst().orElseThrow();
        EditCommand command=new EditCommand(a.revisionId(),a.id(),atom.methodId(),atom.id(),"replace_expression",new ReplaceExpression("expression","true"),"semantic_edit");
        assertEquals("UNSUPPORTED_OPERATION",assertThrows(EngineException.class,()->engine.propose(b,a,command)).code());
        GraphNode changed=new GraphNode(atom.id(),atom.revisionId(),atom.analysisId(),atom.methodId(),atom.kind(),atom.label(),atom.sourceRange(),atom.astBinding(),atom.parentId(),atom.synthetic(),atom.editableFields(),atom.editableFieldRanges(),atom.allowedOperations(),atom.insertionPositions(),"statement");
        Graph graph=new Graph(a.graph().revisionId(),a.graph().analysisId(),a.graph().sourceMapVersion(),a.graph().methods(),a.graph().nodes().stream().map(n->n.id().equals(atom.id())?changed:n).toList(),a.graph().edges());
        Analysis forged=new Analysis(a.id(),a.revisionId(),a.bundleHash(),a.analyzerVersion(),a.parserVersion(),a.languageLevel(),a.parseStatus(),a.compileStatus(),a.symbolStatus(),a.sourceMapVersion(),a.diagnostics(),a.coverage(),a.declarations(),graph,a.symbolEnvironmentHash(),a.semantics());
        assertEquals("ANALYSIS_CONFLICT",assertThrows(EngineException.class,()->engine.propose(b,forged,command)).code());
        assertEquals("ANALYSIS_CONFLICT",assertThrows(EngineException.class,()->engine.propose(b,engine.inspect(b),command)).code());
        GraphNode old=new GraphNode("n","r","a","m","expression","a",null,"n",null,false,List.of(),null);
        assertNull(old.executionRole());
    }

    @Test void depthAndPerMethodConditionBudgetsFailClosedWithoutTruncatedPreciseGraph() {
        String source="class Main {void f(boolean a){"+"if(a){}".repeat(4097)+"}}";
        Analysis a=analyze(source);
        assertTrue(a.diagnostics().stream().anyMatch(d->d.code().equals("CONDITION_FLOW_LIMIT")));
        List<GraphNode> all=a.graph().nodes();assertTrue(all.stream().anyMatch(n->n.kind().equals("opaque")));
        assertTrue(all.stream().noneMatch(n->n.kind().equals("condition_test")));
        assertTrue(all.stream().allMatch(n->n.allowedOperations().isEmpty()));
        Analysis deep=engine.inspect(bundle("class Main {void f(boolean a){if("+"!".repeat(140)+"a){}}}"));
        assertEquals("invalid",deep.parseStatus());assertTrue(deep.graph().nodes().isEmpty());
        assertTrue(deep.diagnostics().stream().anyMatch(d->d.code().equals("ANALYSIS_LIMIT")));
    }
}
