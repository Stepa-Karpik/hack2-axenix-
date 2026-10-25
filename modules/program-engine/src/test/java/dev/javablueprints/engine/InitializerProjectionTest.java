package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;

import java.util.*;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.*;

/** Parser/source tests only. None of the fixture Java is compiled or executed on the host. */
class InitializerProjectionTest {
    private final ProgramEngine engine = new ProgramEngine();
    private SourceBundle bundle(String source) { return new SourceBundle("base", Map.of("Main.java", source)); }
    private InitializerContext context(Analysis analysis, String label) {
        return analysis.graph().initializerContexts().stream().filter(c -> label.equals(c.label())).findFirst().orElseThrow();
    }
    private InitializerNode expression(InitializerContext context, String label) {
        return context.nodes().stream().filter(n -> label.equals(n.label()) && n.allowedOperations().contains("replace_expression")).findFirst().orElseThrow();
    }
    private EditCommand edit(Analysis analysis, InitializerContext context, InitializerNode node, String value) {
        return new EditCommand("base", analysis.id(), null, node.id(), "replace_expression",
                new ReplaceExpression("expression", value), "semantic_edit", context.id());
    }
    private String slice(String source, SourceRange range) { return source.substring(range.startOffset(), range.endOffset()); }

    @Test void declaredInitializationOrderFollowsJlsPerConstructor() {
        String source = "class Base {} class Main extends Base { static int a=1; int x=3; static { a++; } Main() { this(1); x++; }"
                + " Main(int v) { super(); x=v; } { x+=4; } static int c=5; int y; Main(String s) { x=s.length(); } }"
                + " class Plain { int p=1; }";
        var orders = engine.inspect(bundle(source)).graph().initializationOrders();
        var main = orders.stream().filter(o -> o.typeName().equals("Main")).findFirst().orElseThrow();
        Function<List<InitializationStep>, List<String>> labels = steps -> steps.stream().map(s -> s.kind() + ":" + s.label()).toList();
        assertEquals(List.of("field_initializer:a", "static_initializer_block:static block #1", "field_initializer:c"), labels.apply(main.staticPhase()));
        assertEquals(3, main.constructors().size());
        var delegating = main.constructors().get(0);
        assertEquals("this", delegating.delegation());
        assertEquals(List.of("this_call:this(1);", "constructor_body:Main()"), labels.apply(delegating.steps()));
        var explicitSuper = main.constructors().get(1);
        assertEquals(List.of("super_call:super();", "field_initializer:x", "instance_initializer_block:instance block #1", "constructor_body:Main(int)"),
                labels.apply(explicitSuper.steps()));
        var implicit = main.constructors().get(2);
        assertEquals("implicit_super_call:super() → Base", labels.apply(implicit.steps()).getFirst());
        assertNotNull(implicit.steps().getLast().methodId());
        var plain = orders.stream().filter(o -> o.typeName().equals("Plain")).findFirst().orElseThrow();
        assertTrue(plain.constructors().getFirst().implicitDefault());
        assertEquals(List.of("implicit_super_call:super() → Object", "field_initializer:p"), labels.apply(plain.constructors().getFirst().steps()));
        assertEquals("declared_order", main.coverage());
    }

    @Test void mixedSourceStreamsDoNotBecomeMethodsOrExecutionEdges() {
        String source = "class Main { static int a=1, b=2; int x=3; static { a++; } Main() { x++; } { x+=4; } static int c=5; int empty; void f(){} }";
        var analysis = engine.inspect(bundle(source));
        var contexts = analysis.graph().initializerContexts();
        assertEquals(List.of("a", "b", "x", "static block #1", "instance block #1", "c"), contexts.stream().map(InitializerContext::label).toList());
        assertEquals(List.of(0,1,0,2,1,3), contexts.stream().map(InitializerContext::streamIndex).toList());
        assertEquals(List.of(0,0,1,2,4,5), contexts.stream().map(InitializerContext::memberIndex).toList());
        assertEquals(0, contexts.get(0).declaratorIndex()); assertEquals(1, contexts.get(1).declaratorIndex());
        assertEquals(2, analysis.graph().methods().size());
        assertEquals(2, analysis.quality().methods().size());
        assertTrue(contexts.stream().flatMap(c -> c.edges().stream()).allMatch(e -> e.kind().equals("contains")));
        assertTrue(contexts.stream().allMatch(c -> c.projectionKind().equals("ast_source") && c.constantStatus().equals("unknown")));
        assertTrue(contexts.stream().flatMap(c -> c.nodes().stream()).allMatch(n ->
                Set.of("structural", "ast_projection").contains(n.executionRole()) && n.allowedOperations().stream().allMatch("replace_expression"::equals)));
    }

    @Test void fieldIdsAreRealSeparateSemanticDeclarationsAndSymbols() {
        var analysis = engine.inspect(bundle("class Main { static int a=1,b=a+2; }"));
        for (InitializerContext context : analysis.graph().initializerContexts()) {
            var field = analysis.semantics().symbols().stream().filter(s -> s.id().equals(context.fieldSymbolId())).findFirst().orElseThrow();
            assertEquals("field", field.kind()); assertEquals(context.fieldDeclarationId(), field.declarationId());
            assertNotEquals(context.fieldSymbolId(), context.id()); assertNotEquals(context.fieldSymbolId(), context.fieldDeclarationId());
            assertTrue(analysis.declarations().stream().anyMatch(d -> d.id().equals(context.ownerTypeDeclarationId())));
            assertTrue(analysis.declarations().stream().anyMatch(d -> d.id().equals(context.fieldDeclarationId())));
        }
        var reference = analysis.semantics().references().stream().filter(r -> "a".equals(r.name())).findFirst().orElseThrow();
        assertEquals(context(analysis,"b").id(), reference.enclosingInitializerContextId());
        assertNull(reference.enclosingCallableId()); assertEquals(List.of(context(analysis,"a").fieldSymbolId()), reference.targetIds());
    }

    @Test void interfaceModifiersAreEffectiveAndConstantStatusStaysUnknown() {
        var analysis = engine.inspect(bundle("interface Main { int A=1; Object B=new Object(); int NO_INIT=2; }"));
        assertTrue(analysis.graph().initializerContexts().stream().allMatch(c -> c.effectiveStatic() && c.effectiveFinal()));
        assertTrue(analysis.graph().initializerContexts().stream().allMatch(c -> c.constantStatus().equals("unknown")));
    }

    @Test void siblingFieldReplacementPreservesEveryUnrelatedByteIncludingUnicodeAndComments() {
        String source = "// 😀 Сохранить\nclass Main {\n\tstatic final int a = 1, b = /* before */ 2 /* after */;\n\tMain() { super(); }\n}\n";
        var bundle = bundle(source); var analysis = engine.inspect(bundle); var context = context(analysis,"b");
        var node = expression(context,"2"); var candidate = engine.propose(bundle,analysis,edit(analysis,context,node,"7 + 8"));
        assertEquals(source.replace("/* before */ 2", "/* before */ (7 + 8)"), candidate.files().get("Main.java"));
        assertEquals(1,candidate.changes().size()); assertEquals("2",candidate.changes().getFirst().before());
        assertEquals("not_requested",candidate.compileStatus()); assertEquals("unverified",candidate.verificationStatus());
        assertEquals(source.indexOf("2 /* after */"),node.sourceRange().startOffset());
        assertEquals("2",slice(source,node.sourceRange()));
    }

    @Test void staticAndInstanceBlocksProjectRealConditionsAndBodyExpressions() {
        String source = "class Main { static int a=1; static { if(a>0) { a=2; } for(int i=0;i<2;i++) a++; } { while(a<3) a++; } }";
        var bundle = bundle(source); var analysis=engine.inspect(bundle);
        var block=context(analysis,"static block #1");
        assertEquals("static_initializer_block",block.kind()); assertTrue(block.effectiveStatic()); assertNull(block.fieldDeclarationId());
        assertEquals('{',slice(source,block.sourceRange()).charAt(0));
        var candidate=engine.propose(bundle,analysis,edit(analysis,block,expression(block,"a>0"),"a>=0"));
        assertEquals(source.replace("a>0","(a>=0)"),candidate.files().get("Main.java"));
        var instance=context(analysis,"instance block #1"); assertFalse(instance.effectiveStatic());
        assertEquals("instance_initializer_block",instance.kind()); assertNotNull(expression(instance,"a<3"));
        assertTrue(block.nodes().stream().allMatch(n -> block.id().equals(n.contextId())));
    }

    @Test void commentsInsideExpressionRemainReadOnlyWhileSafeChildrenCanBeEdited() {
        String source="class Main { int a=1 /* retain */ + 2; }"; var bundle=bundle(source); var analysis=engine.inspect(bundle);
        var context=context(analysis,"a"); var root=context.nodes().getFirst();
        assertTrue(root.allowedOperations().isEmpty());
        assertThrows(EngineException.class,()->engine.propose(bundle,analysis,edit(analysis,context,root,"8")));
        var candidate=engine.propose(bundle,analysis,edit(analysis,context,expression(context,"2"),"3"));
        assertEquals(source.replace("+ 2","+ (3)"),candidate.files().get("Main.java"));
    }

    @Test void bareArrayInitializerIsReadOnlyButElementsHaveExactIndependentEdits() {
        String source="class Main { int[] a={1,2}; }"; var bundle=bundle(source); var analysis=engine.inspect(bundle); var context=context(analysis,"a");
        assertEquals("{1,2}",context.nodes().getFirst().label()); assertTrue(context.nodes().getFirst().allowedOperations().isEmpty());
        var candidate=engine.propose(bundle,analysis,edit(analysis,context,expression(context,"2"),"3"));
        assertEquals("class Main { int[] a={1,(3)}; }",candidate.files().get("Main.java"));
    }

    @Test void unsupportedNestedDomainsAreOpaqueWithoutHidingNeighborContextsOrMethods() {
        var analysis=engine.inspect(bundle("class Main { Runnable a=()->{}; Object b=new Object(){ int hidden=1; }; int c=3; { class Local {int x=1;} } void f(){int x=1;} class Named {int y=2;} }"));
        assertEquals(List.of("a","b","c","instance block #1","y"),analysis.graph().initializerContexts().stream().map(InitializerContext::label).toList());
        for(String label:List.of("a","b","instance block #1")) {
            var context=context(analysis,label); assertEquals("opaque",context.coverage()); assertEquals(1,context.nodes().size());
            assertTrue(context.nodes().getFirst().allowedOperations().isEmpty());
        }
        assertEquals("supported",context(analysis,"c").coverage());
        assertTrue(analysis.graph().methods().stream().anyMatch(m -> m.signature().contains("f(")));
        assertTrue(analysis.semantics().references().stream().filter(r -> r.sourceRange()!=null &&
                r.sourceRange().startOffset()>=context(analysis,"b").sourceRange().startOffset() &&
                r.sourceRange().endOffset()<=context(analysis,"b").sourceRange().endOffset()).allMatch(r -> r.enclosingInitializerContextId()==null));
    }

    @Test void repeatedNamesInSiblingBlocksRemainDistinctAndLexicallyBound() {
        var analysis=engine.inspect(bundle("class Main { { int x=1; System.out.println(x); } { int x=2; System.out.println(x); } }"));
        var locals=analysis.semantics().symbols().stream().filter(s -> s.kind().equals("local") && s.name().equals("x")).toList();
        assertEquals(2,locals.size()); assertNotEquals(locals.get(0).id(),locals.get(1).id());
        var uses=analysis.semantics().references().stream().filter(r -> r.name().equals("x")).toList(); assertEquals(2,uses.size());
        assertEquals(List.of(locals.get(0).id()),uses.get(0).targetIds()); assertEquals(List.of(locals.get(1).id()),uses.get(1).targetIds());
        assertNotEquals(uses.get(0).enclosingInitializerContextId(),uses.get(1).enclosingInitializerContextId());
        assertFalse(analysis.semantics().limitations().contains("ambiguous_source_declarations"));
    }

    @Test void refusesCrossContextStaleAndMixedCallableTargets() {
        var bundle=bundle("class Main { int a=1,b=2; void f(){} }");var a=engine.inspect(bundle); var left=context(a,"a"); var right=context(a,"b"); var node=expression(left,"1");
        assertThrows(EngineException.class,()->engine.propose(bundle,a,edit(a,right,node,"3")));
        assertThrows(EngineException.class,()->engine.propose(bundle,a,new EditCommand("base",a.id(),a.graph().methods().getFirst().id(),node.id(),"replace_expression",new ReplaceExpression("expression","3"),"semantic_edit",left.id())));
        var old=engine.inspect(bundle);assertThrows(EngineException.class,()->engine.propose(bundle,a,edit(a,left,expression(context(old,"a"),"1"),"3")));
        assertThrows(EngineException.class,()->engine.propose(bundle,a,new EditCommand("base",a.id(),null,node.id(),"replace_expression",new ReplaceExpression("expression","3"),"semantic_edit")));
    }

    @Test void refusesWholeBlockAndStructuralOperationsAndMalformedOrUnsupportedReplacements() {
        var bundle=bundle("class Main { int a=1; { int x=2; } }");var a=engine.inspect(bundle); var field=context(a,"a"); var node=expression(field,"1");
        for(String operation:List.of("extract_method","rename_local","replace_statement","delete_statement","optimize_membership","decompose_class"))
            assertThrows(EngineException.class,()->engine.propose(bundle,a,new EditCommand("base",a.id(),null,node.id(),operation,new ReplaceExpression("expression","3"),"preserve_behavior",field.id())));
        for(String source:List.of("1; int injected=2", "()->1", "new Object(){int x=1;}", "switch(1){default -> 2;}", "1\r\n+2"))
            assertThrows(EngineException.class,()->engine.propose(bundle,a,edit(a,field,node,source)),source);
        var block=context(a,"instance block #1"); assertThrows(EngineException.class,()->engine.propose(bundle,a,edit(a,block,block.nodes().getFirst(),"3")));
    }

    @Test void projectionBudgetMakesAnExplicitOpaqueContextAndContextBudgetRefuses() {
        String statements="int x=0;"+"x++;".repeat(1400);
        var a=engine.inspect(bundle("class Main { {"+statements+"} int good=1; }"));
        var block=context(a,"instance block #1"); assertEquals("opaque",block.coverage()); assertEquals("projection_node_budget",block.reason());
        assertEquals("supported",context(a,"good").coverage());
        String fields=""; for(int i=0;i<1025;i++) fields+="int f"+i+"=1;";
        var excessive=bundle("class Main {"+fields+"}");
        var failure=assertThrows(EngineException.class,()->engine.inspect(excessive)); assertEquals("ANALYSIS_LIMIT",failure.code());
    }

    @Test void invalidBundleHasNoInitializerGraphAndLegacyGraphDefaultsEmpty() {
        var a=engine.inspect(new SourceBundle("base",Map.of("Main.java","class Main {int x=1;}","Bad.java","class Bad { int x=; }")));
        assertEquals("invalid",a.parseStatus()); assertTrue(a.graph().initializerContexts().isEmpty());
        assertTrue(new Graph("r","a","v",List.of(),List.of(),List.of()).initializerContexts().isEmpty());
        assertTrue(new Graph("r","a","v",List.of(),List.of(),List.of(),null).initializerContexts().isEmpty());
    }
}
