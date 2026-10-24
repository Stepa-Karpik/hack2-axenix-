package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;

import java.util.*;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

class SemanticAnalysisTest {
    private final ProgramEngine engine = new ProgramEngine();
    private Analysis inspect(String source) { return engine.inspect(new SourceBundle("r", Map.of("Main.java", source))); }
    private Symbol symbol(Analysis a, String kind, String name) {
        return a.semantics().symbols().stream().filter(s -> !s.external() && s.kind().equals(kind) && s.name().equals(name)).findFirst().orElseThrow();
    }
    private Reference refAt(Analysis a, String source, String expression, String kind) {
        int at = source.lastIndexOf(expression);
        return a.semantics().references().stream().filter(r -> r.kind().equals(kind) && r.sourceRange().startOffset() == at).findFirst().orElseThrow(() -> new AssertionError(a.semantics().references()));
    }
    private Symbol target(Analysis a, Reference ref) {
        assertEquals("exact", ref.resolution(), ref.toString());
        assertEquals(1, ref.targetIds().size());
        return a.semantics().symbols().stream().filter(s -> s.id().equals(ref.targetIds().getFirst())).findFirst().orElseThrow();
    }

    @Test void fieldParameterAndLocalIdentityAndThisAreDistinct() {
        String source = "class Main {int value=1; int parameter(int value){return this.value+value;} int local(){int value=3;return value;}}";
        Analysis a = inspect(source);
        Set<String> ids = a.semantics().symbols().stream().filter(s -> s.name().equals("value")).map(Symbol::id).collect(Collectors.toSet());
        assertEquals(3, ids.size());
        assertEquals("field", target(a, refAt(a, source, "this.value", "field")).kind());
        Reference param = a.semantics().references().stream().filter(r -> r.kind().equals("name") && r.sourceRange().startOffset() == source.indexOf("+value") + 1).findFirst().orElseThrow();
        assertEquals("parameter", target(a, param).kind());
        assertEquals("local", target(a, refAt(a, source, "value;", "name")).kind());
        for (Symbol s : a.semantics().symbols().stream().filter(s -> !s.external()).toList()) {
            assertEquals(s.name(), source.substring(s.sourceRange().startOffset(), s.sourceRange().endOffset()));
        }
    }

    @Test void nestedOwnersOverloadsAndConstructorsHaveQualifiedDistinctIdentities() {
        Analysis a = inspect("package p; class Outer {static class Inner {Inner(){} Inner(int n){} int f(int x){return x;} int f(String x){return 0;}}}");
        assertTrue(a.graph().methods().stream().allMatch(m -> m.fullyQualifiedName().startsWith("p.Outer.Inner.")));
        assertEquals(2, a.declarations().stream().filter(d -> d.kind().equals("constructor")).count());
        List<Symbol> methods = a.semantics().symbols().stream().filter(s -> s.kind().equals("method") || s.kind().equals("constructor")).toList();
        assertEquals(4, methods.stream().map(Symbol::signature).distinct().count());
        assertTrue(methods.stream().allMatch(s -> s.signature().startsWith("p.Outer.Inner.")));
    }

    @Test void sourceBundleImportsAndStaticAndVirtualBindingsAreSeparate() {
        String source = "package b; import a.Helper; class Main {int f(Helper h){return Helper.twice(2)+h.value();}}";
        Analysis a = engine.inspect(new SourceBundle("r", Map.of("b/Main.java", source,
                "a/Helper.java", "package a; public class Helper {public static int twice(int n){return n*2;} public int value(){return 1;}}")));
        Reference stat = refAt(a, source, "Helper.twice(2)", "call"), virtual = refAt(a, source, "h.value()", "call");
        assertEquals("a.Helper.twice", target(a, stat).qualifiedName());
        assertEquals("static", stat.dispatch());
        assertEquals("a.Helper.value", target(a, virtual).qualifiedName());
        assertEquals("virtual", virtual.dispatch());
        assertTrue(virtual.runtimeTargetIds().isEmpty());
    }

    @Test void jdkBindingsHaveStableExternalKeysAndPreserveParameterizedReceiverTypes() {
        String source = "import java.util.ArrayList; class Main {boolean f(String q){ArrayList<String> items=new ArrayList<>();items.add(q);return items.contains(q);}}";
        Analysis a = inspect(source);
        Symbol items = symbol(a, "local", "items");
        assertEquals("ArrayList<String>", items.declaredType());
        assertEquals("java.util.ArrayList<java.lang.String>", items.resolvedType());
        Symbol contains = target(a, refAt(a, source, "items.contains(q)", "call"));
        assertTrue(contains.external());
        assertEquals("method:java.util.ArrayList.contains(java.lang.Object)", contains.externalKey());
        assertNull(contains.sourceRange());
        assertEquals("virtual", refAt(a, source, "items.contains(q)", "call").dispatch());
        assertEquals("parameter", target(a, refAt(a, source, "q);", "name")).kind());
        Analysis repeat = inspect(source);
        assertEquals(contains.externalKey(), target(repeat, refAt(repeat, source, "items.contains(q)", "call")).externalKey());
    }

    @Test void customRawAndSubclassCollectionsAreDistinguishableWithoutOptimizerClaims() {
        String source = "import java.util.ArrayList; class Main {static class Custom {boolean contains(String q){return true;}} static class Sub extends ArrayList<String>{} boolean f(String q){ArrayList raw=new ArrayList();Sub sub=new Sub();Custom custom=new Custom();return custom.contains(q);}}";
        Analysis a = inspect(source);
        assertEquals("java.util.ArrayList", symbol(a, "local", "raw").resolvedType());
        assertEquals("Main.Sub", symbol(a, "local", "sub").resolvedType());
        assertFalse(target(a, refAt(a, source, "custom.contains(q)", "call")).external());
        assertTrue(a.coverage().stream().anyMatch(c -> c.feature().equals("OPT-MEMBERSHIP-001") && c.status().equals("unsupported")));
    }

    @Test void nullAmbiguityIsExplicitAndMostSpecificAndOtherArgumentsAreRespected() {
        String source = "class Main {static int f(String s){return 1;} static int f(Integer i){return 2;} int g(){return f(null);}}";
        Analysis a = inspect(source);
        Reference ambiguous = refAt(a, source, "f(null)", "call");
        assertEquals("candidates", ambiguous.resolution());
        assertEquals("ambiguous_overload", ambiguous.reason());
        assertEquals(2, ambiguous.targetIds().size());
        String specific = "class Main {static int f(Object s){return 1;} static int f(String s){return 2;} int g(){return f(null);}}";
        Analysis b = inspect(specific);
        assertEquals("Main.f(java.lang.String)", target(b, refAt(b, specific, "f(null)", "call")).signature());
        String mixed = "class Main {static int f(String s,int n){return 1;} static int f(Integer i,String s){return 2;} int g(){return f(null,1);}}";
        Analysis c = inspect(mixed);
        assertEquals("Main.f(java.lang.String, int)", target(c, refAt(c, mixed, "f(null,1)", "call")).signature());
    }

    @Test void primitiveWrapperVarargsAndConstructorCallsAreBoundOrExplicitlyUnresolved() {
        String source = "class Main {Main(int n){} static int f(int n){return 1;} static int f(Integer n){return 2;} static int many(String... s){return s.length;} int g(){Main m=new Main(1);return f(1)+f(Integer.valueOf(2))+many(\"a\",\"b\");}}";
        Analysis a = inspect(source);
        assertEquals("Main.f(int)", target(a, refAt(a, source, "f(1)", "call")).signature());
        assertEquals("Main.f(java.lang.Integer)", target(a, refAt(a, source, "f(Integer.valueOf(2))", "call")).signature());
        assertEquals("constructor", target(a, refAt(a, source, "new Main(1)", "constructor")).kind());
        Reference variadic = refAt(a, source, "many(\"a\",\"b\")", "call");
        if (variadic.resolution().equals("exact")) assertEquals("Main.many", target(a, variadic).qualifiedName());
        else assertNotNull(variadic.reason());
    }

    @Test void inheritedCompileTimeMethodDoesNotInventRuntimeCandidates() {
        String source = "class Base {int f(){return 1;}} class Main extends Base {int f(){return 2;} int g(Base b){return b.f();}}";
        Analysis a = inspect(source);
        Reference call = refAt(a, source, "b.f()", "call");
        assertEquals("Base.f", target(a, call).qualifiedName());
        assertEquals("virtual", call.dispatch());
        assertTrue(call.runtimeTargetIds().isEmpty());
    }

    @Test void beforeDeclarationSiblingBlockAndForInitNamesCannotLeak() {
        String source = "class Main {void f(){System.out.println(before);int before=1;{int sibling=2;}System.out.println(sibling);for(int i=0;i<2;i++){}System.out.println(i);}}";
        Analysis a = inspect(source);
        for (String expression : List.of("before);", "sibling);", "i);")) {
            Reference r = refAt(a, source, expression, "name");
            assertEquals("unresolved", r.resolution(), r.toString());
            assertNotNull(r.reason());
        }
        assertEquals("partial", a.symbolStatus());
    }

    @Test void duplicateTypesMembersAndCyclicInheritanceNeverProduceArbitraryExactTargets() {
        for (String source : List.of("class Main {int f(){return 1;} int f(){return 2;}int g(){return f();}}",
                "class Main {int x;int x;int f(){return x;}}", "class Main extends Main {int f(){return f();}}",
                "class Main {int f(int x,int x){return x;}}", "class Main {int f(){int x=1;int x=2;return x;}}",
                "class A extends B {} class B extends A {} class Main {int f(A a){return a.hashCode();}}")) {
            Analysis a = inspect(source);
            assertEquals("valid", a.parseStatus());
            assertTrue(a.semantics().references().stream().noneMatch(r -> r.resolution().equals("exact")), source);
            assertTrue(a.semantics().limitations().stream().anyMatch(s -> s.contains("ambiguous_source") || s.contains("cyclic_source")), a.semantics().limitations().toString());
        }
        Analysis duplicate = engine.inspect(new SourceBundle("r", Map.of("One.java", "class Same {}", "Two.java", "class Same {}")));
        assertTrue(duplicate.semantics().limitations().contains("ambiguous_source_declarations"));
    }

    @Test void dependencyFailuresHostClasspathAndReservedPackagesRemainExplicit() {
        for (String source : List.of("import missing.Library;class Main {Library x;void f(){x.run();}}",
                "import dev.javablueprints.engine.ProgramEngine;class Main {Object f(){return new ProgramEngine();}}",
                "import com.github.javaparser.JavaParser;class Main {Object f(){return new JavaParser();}}")) {
            Analysis a = inspect(source);
            assertEquals("valid", a.parseStatus());
            assertTrue(a.semantics().references().stream().anyMatch(r -> r.resolution().equals("unresolved")));
            assertTrue(a.semantics().symbols().stream().filter(Symbol::external).allMatch(s -> s.externalKey().contains("java.") || s.externalKey().contains("javax.")));
        }
        Analysis reserved = inspect("package java.lang; class String {int f(){return hashCode();}}");
        assertTrue(reserved.semantics().limitations().contains("reserved_source_package"));
        assertTrue(reserved.semantics().references().stream().noneMatch(r -> r.resolution().equals("exact")));
    }

    @Test void rangesAndExportAreExactForUtf16TriviaAndEscapedIdentifiers() {
        String name = "\\" + "u0061";
        String source = "// 😀\nclass Main {int f(){\tint " + name + "=1;return " + name + ";}}\n";
        SourceBundle b = new SourceBundle("r", Map.of("Main.java", source));
        Analysis a = engine.inspect(b);
        assertEquals(source, engine.exportUnchanged(b).get("Main.java"));
        Symbol local = a.semantics().symbols().stream().filter(s -> s.kind().equals("local")).findFirst().orElseThrow();
        assertEquals(name, source.substring(local.sourceRange().startOffset(), local.sourceRange().endOffset()));
        Reference use = refAt(a, source, name + ";", "name");
        assertEquals(local.id(), target(a, use).id());
        assertEquals(2, use.sourceRange().startLine());
    }

    @Test void independentAnalysesHaveScopedTargetsWithStableSemanticMeaningAndEnvironment() {
        String source = "class Main {int x;int f(int y){return x+y;}}";
        Analysis a = inspect(source), b = inspect(source);
        assertNotEquals(a.id(), b.id());
        assertEquals(ProgramEngine.currentSymbolEnvironmentHash(), a.symbolEnvironmentHash());
        assertEquals(a.symbolEnvironmentHash(), b.symbolEnvironmentHash());
        assertEquals(ProgramEngine.currentSymbolEnvironment(), a.semantics().environment());
        assertEquals(normalized(a), normalized(b));
        for (Analysis snapshot : List.of(a,b)) {
            Set<String> ids = snapshot.semantics().symbols().stream().map(Symbol::id).collect(Collectors.toSet());
            assertTrue(ids.stream().allMatch(s -> s.startsWith(snapshot.id() + ":")));
            assertTrue(snapshot.semantics().references().stream().flatMap(r -> r.targetIds().stream()).allMatch(ids::contains));
        }
    }
    private List<String> normalized(Analysis a) {
        Map<String,String> names = a.semantics().symbols().stream().collect(Collectors.toMap(Symbol::id, s -> s.kind()+":"+s.qualifiedName()+":"+s.signature()+":"+s.sourceRange()));
        return a.semantics().references().stream().map(r -> r.kind()+":"+r.sourceRange()+":"+r.resolution()+":"+r.targetIds().stream().map(names::get).toList()).toList();
    }

    @Test void invalidUnsupportedAndBudgetedDomainsNeverClaimResolvedByEmptyList() {
        Analysis invalid = inspect("class Main { int f( {");
        assertEquals("not_requested", invalid.symbolStatus());
        assertTrue(invalid.semantics().symbols().isEmpty());
        assertTrue(invalid.semantics().references().isEmpty());
        Analysis empty = inspect("class Main {}");
        assertEquals("partial", empty.symbolStatus());
        Analysis lambda = inspect("class Main {void f(){Runnable r=()->System.out.println(1);}}");
        assertTrue(lambda.semantics().references().stream().anyMatch(r -> "unsupported_semantic_domain".equals(r.reason())));
        String many = java.util.stream.IntStream.range(0,1001).mapToObj(i -> "class T"+i+"{}\n").collect(Collectors.joining());
        Analysis budget = inspect(many);
        assertTrue(budget.semantics().limitations().contains("semantic_type_budget"));
        assertEquals("partial", budget.symbolStatus());
        assertEquals("invalid", inspect("class Main {int f(){return " + "(".repeat(140) + "1" + ")".repeat(140) + ";}}").parseStatus());
    }

    @Test void legacySemanticsDefaultEmptyAndEnvironmentMismatchRejectsCommands() {
        Analysis a = inspect("class Main {int f(){return 1;}}");
        Analysis legacy = new Analysis(a.id(),a.revisionId(),a.bundleHash(),a.analyzerVersion(),a.parserVersion(),a.languageLevel(),a.parseStatus(),a.compileStatus(),a.symbolStatus(),a.sourceMapVersion(),a.diagnostics(),a.coverage(),a.declarations(),a.graph());
        assertNull(legacy.symbolEnvironmentHash());
        assertNull(legacy.semantics().environment());
        assertTrue(legacy.semantics().symbols().isEmpty());
        GraphNode n = a.graph().nodes().stream().filter(node -> node.kind().equals("expression") && node.label().equals("1")).findFirst().orElseThrow();
        EditCommand command = new EditCommand(a.revisionId(),a.id(),n.methodId(),n.id(),"replace_expression",new ReplaceExpression("expression","2"),"semantic_edit");
        assertEquals("ANALYSIS_CONFLICT", assertThrows(EngineException.class, () -> engine.propose(new SourceBundle("r",Map.of("Main.java","class Main {int f(){return 1;}}")), legacy, command)).code());
    }

    @Test void siblingLocalsAreDistinctAndInvalidReceiverScopeCannotGiveAnExactCall() {
        String source = "class Main {void f(){ {int x=1;System.out.println(x);} {int x=2;System.out.println(x);} later.toString();String later=\"x\";}}";
        Analysis a = inspect(source);
        assertFalse(a.semantics().limitations().contains("ambiguous_source_declarations"));
        List<Reference> uses = a.semantics().references().stream().filter(r -> r.kind().equals("name") && r.name().equals("x")).toList();
        assertEquals(2, uses.size());
        assertNotEquals(target(a,uses.get(0)).id(),target(a,uses.get(1)).id());
        assertEquals("unresolved", refAt(a,source,"later.toString()","call").resolution());
    }

    @Test void implicitConstructorHasConstructorIdentityAndTypeNavigation() {
        String source="class Main {Object f(){return new Main();}}";
        Analysis a=inspect(source);
        Symbol constructor=target(a,refAt(a,source,"new Main()","constructor"));
        assertEquals("constructor",constructor.kind());
        assertFalse(constructor.external());
        assertEquals("Main",source.substring(constructor.sourceRange().startOffset(),constructor.sourceRange().endOffset()));
    }

    @Test void unsupportedNullOverloadContendersAndInvocationPhasesFailClosed() {
        for (String source : List.of(
                "class Main {static int f(Object a,Object b){return 1;} static <T> int f(String a,T b){return 2;} int g(){return f(null,\"s\");}}",
                "class Main {static int f(Object a,Object b){return 1;} static int f(String a,String... b){return 2;} int g(){return f(null,\"s\");}}",
                "class Main {static int f(String a,long b){return 1;} static int f(Object a,Integer b){return 2;} int g(){return f(null,1);}}",
                "class Main {static int f(Missing s){return 1;} static int f(String s){return 2;} int g(){return f(null);}}")) {
            Analysis a = inspect(source);
            Reference call = a.semantics().references().stream().filter(r -> r.kind().equals("call") && r.name().equals("f")).findFirst().orElseThrow();
            assertEquals("unresolved",call.resolution(),call.toString());
            assertEquals("null_overload_not_proven",call.reason());
        }
        String enclosed="class Main {int f(String s){return 1;}int f(Integer i){return 2;}int g(){return f((null));}}";
        Analysis a=inspect(enclosed);
        assertEquals("candidates",refAt(a,enclosed,"f((null))","call").resolution());
    }

    @Test void explicitSuperCallHasDirectDispatchRatherThanVirtualOverrideClaim() {
        String source="class Base {int f(){return 1;}} class Main extends Base {int f(){return super.f();}}";
        Analysis a=inspect(source);
        Reference call=refAt(a,source,"super.f()","call");
        assertEquals("Base.f",target(a,call).qualifiedName());
        assertEquals("direct",call.dispatch());
        assertTrue(call.runtimeTargetIds().isEmpty());
    }
}
