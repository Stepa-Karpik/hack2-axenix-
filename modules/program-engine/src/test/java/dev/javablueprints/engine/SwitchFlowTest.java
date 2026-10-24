package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;

import java.util.*;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

class SwitchFlowTest {
    private final ProgramEngine engine=new ProgramEngine();
    private SourceBundle bundle(String source){return new SourceBundle("r",Map.of("Main.java",source));}
    private String source(String body){return "class Main {void f(){"+body+"}int select(){return 1;}void a(){}void b(){}void c(){}void done(){}}";}
    private Analysis analyze(String source){Analysis a=engine.inspect(bundle(source));assertEquals("valid",a.parseStatus(),a.diagnostics().toString());return a;}
    private Method method(Analysis a){return a.graph().methods().stream().filter(m->m.fullyQualifiedName().endsWith(".f")).findFirst().orElseThrow();}
    private List<GraphNode> nodes(Analysis a){return a.graph().nodes().stream().filter(n->n.methodId().equals(method(a).id())).toList();}
    private GraphNode node(Analysis a,String id){return a.graph().nodes().stream().filter(n->n.id().equals(id)).findFirst().orElseThrow();}
    private Edge edge(Analysis a,GraphNode node,String kind){List<Edge> edges=a.graph().edges().stream().filter(e->e.source().equals(node.id())&&e.kind().equals(kind)).toList();assertEquals(1,edges.size());return edges.getFirst();}
    /** Branch choices are independent fixture oracles, never parsed/evaluated Java constants. */
    private List<String> trace(Analysis a,Function<GraphNode,String> choice){
        Map<String,GraphNode> nodes=a.graph().nodes().stream().collect(Collectors.toMap(GraphNode::id,Function.identity()));
        Map<String,List<Edge>> outgoing=a.graph().edges().stream().collect(Collectors.groupingBy(Edge::source));
        GraphNode current=nodes.get(method(a).entryNodeId());List<String> visited=new ArrayList<>();
        for(int i=0;i<1000;i++){
            assertNotEquals("ast_projection",current.executionRole());
            if(current.kind().equals("normal_exit")||current.kind().equals("exceptional_exit"))return visited;
            List<Edge> edges=outgoing.getOrDefault(current.id(),List.of());Edge selected;
            if(current.kind().equals("switch_selector")){
                visited.add("select:"+current.label());String decision=choice.apply(current);
                selected=edges.stream().filter(e->decision.equals("default")?e.kind().equals("default"):e.kind().equals("case")&&decision.equals(e.label())).findFirst().orElseThrow();
            }else if(current.kind().equals("condition_test")){
                visited.add("test:"+current.label());String decision=choice.apply(current);
                selected=edges.stream().filter(e->e.kind().equals(decision)).findFirst().orElseThrow();
            }else{
                if(current.executionRole().equals("statement"))visited.add(current.label());
                assertEquals(1,edges.size(),current.toString());selected=edges.getFirst();
            }
            current=nodes.get(selected.target());
        }
        fail("Unexpected graph cycle in bounded fixture");return List.of();
    }
    private Candidate insert(SourceBundle b,Analysis a,GraphNode n,String text){return engine.propose(b,a,new EditCommand(a.revisionId(),a.id(),n.methodId(),n.id(),"insert_statement",new InsertStatement(n.kind().equals("entry")?"body_start":"before",text),"semantic_edit"));}
    private void opaqueOrInvalid(String source){
        Analysis a=engine.inspect(bundle(source));
        if(a.parseStatus().equals("invalid")){assertTrue(a.graph().nodes().isEmpty());return;}
        assertTrue(nodes(a).stream().anyMatch(n->n.kind().equals("opaque")),source);
        assertTrue(nodes(a).stream().noneMatch(n->n.kind().equals("switch_selector")||n.kind().equals("switch_case")));
        assertTrue(nodes(a).stream().allMatch(n->n.allowedOperations().isEmpty()));
        assertEquals(source,engine.exportUnchanged(bundle(source)).get("Main.java"));
    }

    @Test void dispatchHitDefaultAndFallthroughEvaluateSelectorOnce(){
        Analysis a=analyze(source("switch(select()){case 1:a();break;case 2:b();default:c();}done();"));
        assertEquals(List.of("select:select()","a();","break;","done();"),trace(a,n->"1"));
        assertEquals(List.of("select:select()","b();","c();","done();"),trace(a,n->"2"));
        assertEquals(List.of("select:select()","c();","done();"),trace(a,n->"default"));
        GraphNode selector=nodes(a).stream().filter(n->n.kind().equals("switch_selector")).findFirst().orElseThrow();
        List<Edge> dispatch=a.graph().edges().stream().filter(e->e.source().equals(selector.id())).toList();
        assertEquals(2,dispatch.stream().filter(e->e.kind().equals("case")).count());
        assertEquals(1,dispatch.stream().filter(e->e.kind().equals("default")).count());
    }

    @Test void missingDefaultAndEmptySwitchGoToNextAfterSelector(){
        Analysis noDefault=analyze(source("switch(select()){case 1:a();break;}done();"));
        assertEquals(List.of("select:select()","done();"),trace(noDefault,n->"default"));
        Analysis empty=analyze(source("switch(select()){}done();"));
        assertEquals(List.of("select:select()","done();"),trace(empty,n->"default"));
        assertTrue(nodes(empty).stream().noneMatch(n->n.kind().equals("switch_case")));
    }

    @Test void groupedLabelsAndSeparateEmptyEntriesReachOnlyOneBody(){
        Analysis a=analyze(source("switch(select()){case 1:case 2:a();break;case 3 /* keep */,  4:b();break;default:c();}done();"));
        assertEquals(List.of("select:select()","a();","break;","done();"),trace(a,n->"1"));
        assertEquals(List.of("select:select()","a();","break;","done();"),trace(a,n->"2"));
        assertEquals(List.of("select:select()","b();","break;","done();"),trace(a,n->"3 /* keep */,  4"));
        assertEquals(4,nodes(a).stream().filter(n->n.kind().equals("switch_case")).count());
        assertTrue(a.graph().edges().stream().anyMatch(e->e.kind().equals("case")&&e.label().equals("3 /* keep */,  4")));
    }

    @Test void defaultFirstMiddleAndLastRemainOrdinaryFallthroughEntries(){
        Analysis first=analyze(source("switch(select()){default:a();case 1:b();case 2:c();}done();"));
        assertEquals(List.of("select:select()","a();","b();","c();","done();"),trace(first,n->"default"));
        assertEquals(List.of("select:select()","b();","c();","done();"),trace(first,n->"1"));
        Analysis middle=analyze(source("switch(select()){case 1:a();default:b();case 2:c();}done();"));
        assertEquals(List.of("select:select()","a();","b();","c();","done();"),trace(middle,n->"1"));
        assertEquals(List.of("select:select()","b();","c();","done();"),trace(middle,n->"default"));
        Analysis last=analyze(source("switch(select()){case 1:a();case 2:b();default:c();}done();"));
        assertEquals(List.of("select:select()","a();","b();","c();","done();"),trace(last,n->"1"));
        assertEquals(List.of("select:select()","c();","done();"),trace(last,n->"default"));
    }

    @Test void forSwitchContinueGoesThroughUpdateButBreakLeavesOnlySwitch(){
        Analysis a=analyze(source("for(int i=0;i<2;i++){switch(i){case 0:continue;default:break;}a();}done();"));
        Deque<String> conditions=new ArrayDeque<>(List.of("true","true","false"));
        Deque<String> choices=new ArrayDeque<>(List.of("0","default"));
        assertEquals(List.of("int i=0","test:i<2","select:i","continue;","i++","test:i<2","select:i","break;","a();","i++","test:i<2","done();"),
                trace(a,n->n.kind().equals("condition_test")?conditions.removeFirst():choices.removeFirst()));
        GraphNode continuing=nodes(a).stream().filter(n->n.kind().equals("ContinueStmt")).findFirst().orElseThrow();
        assertEquals("for_update",node(a,edge(a,continuing,"continue").target()).kind());
        GraphNode breaking=nodes(a).stream().filter(n->n.kind().equals("BreakStmt")).findFirst().orElseThrow();
        assertEquals("a();",node(a,edge(a,breaking,"break").target()).label());
    }

    @Test void whileAndDoSwitchContinueInheritTheActualLoopConditionHeader(){
        for(String loop:List.of("while(true){switch(select()){default:continue;}}","do{switch(select()){default:continue;}}while(true);")){
            Analysis a=analyze(source(loop));
            GraphNode continuing=nodes(a).stream().filter(n->n.kind().equals("ContinueStmt")).findFirst().orElseThrow();
            GraphNode target=node(a,edge(a,continuing,"continue").target());
            assertEquals(loop.startsWith("while")?"WhileStmt":"DoStmt",target.kind());
            assertEquals("condition_test",node(a,edge(a,target,"normal").target()).kind());
        }
    }

    @Test void nestedSwitchAndLoopBreakTargetsStayIndependent(){
        Analysis nested=analyze(source("switch(select()){case 1:switch(select()){case 2:a();break;default:b();}c();break;default:done();}done();"));
        Deque<String> choices=new ArrayDeque<>(List.of("1","2"));
        assertEquals(List.of("select:select()","select:select()","a();","break;","c();","break;","done();"),trace(nested,n->choices.removeFirst()));
        Analysis loop=analyze(source("switch(select()){case 1:while(true){break;}a();break;default:b();}done();"));
        List<GraphNode> breaks=nodes(loop).stream().filter(n->n.kind().equals("BreakStmt")).toList();
        assertEquals(Set.of("a();","done();"),breaks.stream().map(n->node(loop,edge(loop,n,"break").target()).label()).collect(Collectors.toSet()));
    }

    @Test void returnAndThrowInCaseNeverFallThroughToAnotherCase(){
        Analysis a=analyze(source("switch(select()){case 1:return;case 2:throw new RuntimeException();default:a();}done();"));
        assertEquals(List.of("select:select()","return;"),trace(a,n->"1"));
        assertEquals(List.of("select:select()","throw new RuntimeException();"),trace(a,n->"2"));
        for(GraphNode n:nodes(a))if(n.kind().equals("ReturnStmt")||n.kind().equals("ThrowStmt")){
            List<Edge> out=a.graph().edges().stream().filter(e->e.source().equals(n.id())).toList();assertEquals(1,out.size());
            assertEquals(n.kind().equals("ReturnStmt")?"normal_exit":"exceptional_exit",node(a,out.getFirst().target()).kind());
        }
    }

    @Test void selectorAndCaseAreReadOnlyButRealNestedBlocksRetainStructuralAnchors(){
        String text=source("switch(select()){case 1:a();{b();}break;default:c();}done();");SourceBundle b=bundle(text);Analysis a=engine.inspect(b);
        for(GraphNode n:nodes(a))if(n.kind().equals("switch_selector")||n.kind().equals("switch_case")){
            assertEquals(n.kind().equals("switch_case")?"structural":"statement",n.executionRole());
            assertNotNull(n.sourceRange());assertFalse(n.synthetic());assertTrue(n.editableFields().isEmpty());assertTrue(n.allowedOperations().isEmpty());
            assertThrows(EngineException.class,()->engine.propose(b,a,new EditCommand(a.revisionId(),a.id(),n.methodId(),n.id(),"replace_expression",new ReplaceExpression("expression","2"),"semantic_edit")));
            assertThrows(EngineException.class,()->engine.propose(b,a,new EditCommand(a.revisionId(),a.id(),n.methodId(),n.id(),"delete_statement",new DeleteStatement(),"semantic_edit")));
        }
        GraphNode direct=nodes(a).stream().filter(n->n.kind().equals("ExpressionStmt")&&n.label().equals("a();")).findFirst().orElseThrow();
        assertFalse(direct.allowedOperations().contains("insert_statement"));assertFalse(direct.allowedOperations().contains("delete_statement"));
        GraphNode nested=nodes(a).stream().filter(n->n.kind().equals("ExpressionStmt")&&n.label().equals("b();")).findFirst().orElseThrow();
        assertTrue(nested.allowedOperations().contains("insert_statement"));assertTrue(nested.allowedOperations().contains("delete_statement"));
        GraphNode header=nodes(a).stream().filter(n->n.kind().equals("SwitchStmt")).findFirst().orElseThrow();
        assertEquals("structural",header.executionRole());assertTrue(header.allowedOperations().contains("delete_statement"));assertTrue(header.editableFields().isEmpty());
    }

    @Test void exactUtf16RawLabelsAndRangesDoNotSplitOnColonInStringsOrComments(){
        String text="// 😀\nclass Main {void f(){\tswitch(select()){case \"К:😀\":a();break;case \"b\" /* : keep */,  \"c\":b();}done();}String select(){return \"К:😀\";}void a(){}void b(){}void done(){}}\n";
        Analysis a=analyze(text);
        GraphNode selector=nodes(a).stream().filter(n->n.kind().equals("switch_selector")).findFirst().orElseThrow();
        assertEquals("select()",text.substring(selector.sourceRange().startOffset(),selector.sourceRange().endOffset()));
        assertEquals(text.indexOf("select()"),selector.sourceRange().startOffset());
        assertTrue(a.graph().edges().stream().anyMatch(e->"\"b\" /* : keep */,  \"c\"".equals(e.label())));
        for(GraphNode entry:nodes(a).stream().filter(n->n.kind().equals("switch_case")).toList())assertTrue(text.substring(entry.sourceRange().startOffset(),entry.sourceRange().endOffset()).startsWith("case "));
        assertEquals(text,engine.exportUnchanged(bundle(text)).get("Main.java"));
    }

    @Test void constantShapesAreSyntacticAndUnknownLabelsAreNeverEvaluated(){
        for(String label:List.of("1","-1","~1","(1 << 2)","(int)1","true ? 1 : 2","Named.VALUE","UNKNOWN","\"a\" + \"b\"")){
            Analysis a=analyze(source("switch(select()){case "+label+":a();break;default:b();}"));
            assertTrue(nodes(a).stream().anyMatch(n->n.kind().equals("switch_selector")),label);
            assertTrue(a.graph().edges().stream().anyMatch(e->e.kind().equals("case")&&e.label().equals(label)));
            assertEquals("not_requested",a.compileStatus());
        }
        Analysis duplicate=analyze(source("switch(select()){case 1:a();case 0x1:b();}"));
        assertEquals(2,duplicate.graph().edges().stream().filter(e->e.kind().equals("case")).count());
        assertEquals("not_requested",duplicate.compileStatus());
        assertTrue(duplicate.coverage().stream().anyMatch(c->c.feature().equals("switch_flow")&&c.status().equals("partial")&&c.reason().contains("compilation")));
    }

    @Test void modernPatternsNullGuardsAndUnsafeConstantDescendantsStayOpaque(){
        for(String body:List.of("switch(select()){case 1 -> a();default -> b();}","int x=switch(select()){case 1 -> 2;default -> 3;};",
                "switch(select()){case null:a();default:b();}","switch(select()){case String s:a();default:b();}",
                "switch(select()){case String s when s.isEmpty():a();default:b();}",
                "switch(select()){case lab():a();}","switch(select()){case (x=1):a();}","switch(select()){case ++x:a();}",
                "switch(select()){case new Integer(1):a();}","switch(select()){case true ? 1 : lab():a();}",
                "switch(select()){case (int)(Object)null:a();}","switch(select()){case (@A(value=probe()) int) 1:a();}",
                "switch(select()){case (@A(value=null) int) 1:a();}","switch(select()){default:a();default:b();}",
                "try{switch(select()){case 1:a();}}finally{}","outer:switch(select()){case 1:break outer;}"))opaqueOrInvalid(source(body));
    }

    @Test void annotationExpressionsInsideCastTypesCannotHideUnsafeLabelDescendants(){
        for(String value:List.of("probe()","null")){
            Analysis a=analyze(source("switch(select()){case (@A(value="+value+") int) 1:a();}"));
            assertTrue(nodes(a).stream().anyMatch(n->n.kind().equals("opaque")));
            assertTrue(nodes(a).stream().noneMatch(n->n.kind().equals("switch_selector")));
        }
    }

    @Test void wholeSwitchInsertionDistinguishesBreakFromContinueAndPreservesComments(){
        String text="// keep 😀\nclass Main {void f(){/* leading */a(); // trailing\n}void a(){}}";SourceBundle b=bundle(text);Analysis a=engine.inspect(b);
        GraphNode anchor=nodes(a).stream().filter(n->n.kind().equals("ExpressionStmt")).findFirst().orElseThrow();
        Candidate candidate=insert(b,a,anchor,"switch(1){default:break;}");
        assertEquals(text.replace("a(); // trailing","\nswitch(1){default:break;}\na(); // trailing"),candidate.files().get("Main.java"));
        Analysis c=engine.inspect(new SourceBundle("candidate",candidate.files()));assertTrue(nodes(c).stream().anyMatch(n->n.kind().equals("switch_selector")));
        assertEquals("not_requested",candidate.compileStatus());assertEquals("unverified",candidate.verificationStatus());
        assertEquals("INVALID_EDIT",assertThrows(EngineException.class,()->insert(b,a,anchor,"switch(1){default:continue;}")).code());
        assertEquals(text,b.files().get("Main.java"));
    }

    @Test void insertIntoCaseBlockAllowsBreakButRequiresLoopForContinue(){
        String text=source("switch(select()){default:{a();}}");SourceBundle b=bundle(text);Analysis a=engine.inspect(b);
        GraphNode anchor=nodes(a).stream().filter(n->n.kind().equals("ExpressionStmt")&&n.label().equals("a();")).findFirst().orElseThrow();
        assertEquals("valid",insert(b,a,anchor,"break;").parseStatus());
        assertEquals("INVALID_EDIT",assertThrows(EngineException.class,()->insert(b,a,anchor,"continue;")).code());
        String loop=source("for(int i=0;i<2;i++){switch(i){default:{a();}}}");SourceBundle lb=bundle(loop);Analysis la=engine.inspect(lb);
        GraphNode nested=nodes(la).stream().filter(n->n.kind().equals("ExpressionStmt")&&n.label().equals("a();")).findFirst().orElseThrow();
        Candidate candidate=insert(lb,la,nested,"continue;");Analysis changed=engine.inspect(new SourceBundle("candidate",candidate.files()));
        GraphNode jump=nodes(changed).stream().filter(n->n.kind().equals("ContinueStmt")).findFirst().orElseThrow();
        assertEquals("for_update",node(changed,edge(changed,jump,"continue").target()).kind());
    }

    @Test void insertedJumpsCannotBorrowTargetsAcrossAnonymousCallableBoundary(){
        String text=source("while(true){a();}");SourceBundle b=bundle(text);Analysis a=engine.inspect(b);
        GraphNode anchor=nodes(a).stream().filter(n->n.kind().equals("ExpressionStmt")&&n.label().equals("a();")).findFirst().orElseThrow();
        for(String jump:List.of("break;","continue;")){
            assertEquals("INVALID_EDIT",assertThrows(EngineException.class,()->insert(b,a,anchor,"new Object(){void other(){"+jump+"}};")).code());
            assertEquals("INVALID_EDIT",assertThrows(EngineException.class,()->insert(b,a,anchor,"switch(1){default:new Object(){void other(){"+jump+"}};}")).code());
        }
    }

    @Test void selectorAstEditProducesFreshDetachedGraphAndRejectsOldOrForgedBinding(){
        String text=source("switch(select()){case 1:a();break;default:b();}done();");SourceBundle b=bundle(text);Analysis a=engine.inspect(b);
        GraphNode selector=nodes(a).stream().filter(n->n.kind().equals("expression")&&n.label().equals("select()")).findFirst().orElseThrow();
        EditCommand command=new EditCommand(a.revisionId(),a.id(),selector.methodId(),selector.id(),"replace_expression",new ReplaceExpression("expression","2"),"semantic_edit");
        Candidate candidate=engine.propose(b,a,command);Analysis c=engine.inspect(new SourceBundle("candidate",candidate.files()));
        assertEquals(List.of("select:(2)","b();","done();"),trace(c,n->"default"));
        Analysis old=new Analysis(a.id(),a.revisionId(),a.bundleHash(),"engine-0.4.0",a.parserVersion(),a.languageLevel(),a.parseStatus(),a.compileStatus(),a.symbolStatus(),a.sourceMapVersion(),a.diagnostics(),a.coverage(),a.declarations(),a.graph(),a.symbolEnvironmentHash(),a.semantics());
        assertEquals("ANALYSIS_CONFLICT",assertThrows(EngineException.class,()->engine.propose(b,old,command)).code());
        assertEquals("ANALYSIS_CONFLICT",assertThrows(EngineException.class,()->engine.propose(b,engine.inspect(b),command)).code());
        Graph original=a.graph();
        List<Edge> forgedEdges=original.edges().stream().map(e->e.kind().equals("case")?new Edge(e.id(),e.source(),e.target(),e.kind(),"guessed_value",e.completionContext()):e).toList();
        Graph forgedGraph=new Graph(original.revisionId(),original.analysisId(),original.sourceMapVersion(),original.methods(),original.nodes(),forgedEdges);
        Analysis forged=new Analysis(a.id(),a.revisionId(),a.bundleHash(),a.analyzerVersion(),a.parserVersion(),a.languageLevel(),a.parseStatus(),a.compileStatus(),a.symbolStatus(),a.sourceMapVersion(),a.diagnostics(),a.coverage(),a.declarations(),forgedGraph,a.symbolEnvironmentHash(),a.semantics());
        assertEquals("ANALYSIS_CONFLICT",assertThrows(EngineException.class,()->engine.propose(b,forged,command)).code());
        assertNotEquals(a.id(),c.id());assertEquals(text,b.files().get("Main.java"));
    }

    @Test void switchEntryAndLabelBudgetsAreMethodWideAndFailClosed(){
        String entries=java.util.stream.IntStream.range(0,1025).mapToObj(i->"case "+i+":;").collect(Collectors.joining());
        String grouped=java.util.stream.IntStream.range(0,4097).mapToObj(Integer::toString).collect(Collectors.joining(","));
        for(String body:List.of("switch(select()){"+entries+"}","switch(select()){case "+grouped+":;}",
                "switch(select()){"+entries.substring(0,entries.indexOf("case 513:"))+"}switch(select()){"+entries.substring(entries.indexOf("case 513:"))+"}")){
            Analysis a=analyze(source(body));assertTrue(a.diagnostics().stream().anyMatch(d->d.code().equals("SWITCH_FLOW_LIMIT")));
            assertTrue(nodes(a).stream().anyMatch(n->n.kind().equals("opaque")));assertTrue(nodes(a).stream().noneMatch(n->n.kind().equals("switch_selector")));
            assertTrue(nodes(a).stream().allMatch(n->n.allowedOperations().isEmpty()));
        }
        String boundary=java.util.stream.IntStream.range(0,1024).mapToObj(i->"case "+i+":;").collect(Collectors.joining());
        Analysis accepted=analyze(source("switch(select()){"+boundary+"}"));
        assertEquals(1024,nodes(accepted).stream().filter(n->n.kind().equals("switch_case")).count());
        assertTrue(accepted.diagnostics().stream().noneMatch(d->d.code().equals("SWITCH_FLOW_LIMIT")));
        String labelBoundary=java.util.stream.IntStream.range(0,4096).mapToObj(Integer::toString).collect(Collectors.joining(",  "));
        Analysis acceptedLabels=analyze(source("switch(select()){case "+labelBoundary+":;}"));
        assertEquals(labelBoundary,acceptedLabels.graph().edges().stream().filter(e->e.kind().equals("case")).findFirst().orElseThrow().label());
        assertTrue(acceptedLabels.diagnostics().stream().noneMatch(d->d.code().equals("SWITCH_FLOW_LIMIT")));
    }
}
