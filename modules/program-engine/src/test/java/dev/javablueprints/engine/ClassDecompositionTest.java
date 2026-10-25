package dev.javablueprints.engine;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.MethodDeclaration;
import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.*;

/** Source analysis only: fixture Java is never compiled or executed on this host. */
class ClassDecompositionTest {
    private final ProgramEngine engine = new ProgramEngine();
    private record Input(SourceBundle bundle, Analysis analysis, GraphNode entry, Node target,
                         Function<Node, SourceRange> ranges) {}

    private Input input(String path, String source, String methodName, Map<String,String> extra) {
        var files = new java.util.TreeMap<>(extra);
        files.put(path, source);
        var bundle = new SourceBundle("decomposition-source", files);
        var analysis = engine.inspect(bundle);
        assertEquals("valid", analysis.parseStatus());
        var method = analysis.graph().methods().stream()
                .filter(m -> m.signature().startsWith(methodName + "(")).findFirst().orElseThrow();
        var entry = analysis.graph().nodes().stream().filter(n -> n.id().equals(method.entryNodeId())).findFirst().orElseThrow();
        var parser = new JavaParser(new ParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21)
                .setStoreTokens(true).setTabSize(1));
        var unit = parser.parse(source).getResult().orElseThrow();
        var declaration = unit.findAll(MethodDeclaration.class).stream().filter(m -> m.getNameAsString().equals(methodName)).findFirst().orElseThrow();
        Function<Node,SourceRange> ranges = node -> {
            var r = node.getRange().orElseThrow();
            return new SourceRange(path, offset(source,r.begin.line,r.begin.column), offset(source,r.end.line,r.end.column)+1,
                    r.begin.line,r.begin.column,r.end.line,r.end.column+1);
        };
        return new Input(bundle,analysis,entry,declaration.getBody().orElseThrow(),ranges);
    }
    private static int offset(String source, int line, int column) {
        int at = 0;
        for (int n=1;n<line;n++) at=source.indexOf('\n',at)+1;
        return at+column-1;
    }
    private ClassDecomposition.Result rewrite(Input in, String name) {
        return ClassDecomposition.rewrite(in.bundle(),in.analysis(),in.entry(),in.target(),in.ranges(),name);
    }
    private void refuses(String declaration, String expectedReason) {
        var source = "class Main { " + declaration + " }\n";
        var in = input("Main.java",source,"total",Map.of());
        var error = assertThrows(EngineException.class,() -> rewrite(in,"TotalsPart"));
        assertEquals("UNSUPPORTED_OPERATION",error.code());
        assertTrue(error.getMessage().contains(expectedReason),error.getMessage());
        assertEquals(source,in.bundle().files().get("Main.java"));
    }

    @Test void createsSeparateUtilityAndExactWrapperWithoutRewritingCallersOrBody() {
        String body = "{\n\t// Сумма 😀\n\tint result = 0;\n\tfor (int next=0; next<=count; next++) {\n\t  if (next % 2 != 0) continue;\n\t  result += next;\n\t}\n\treturn result;\n  }";
        String source = "package sample;\npublic class Main {\n  /** retained */\n  public static int total(int count) " + body
                + "\n  static int caller() { return total(6); }\n}\n";
        var in = input("sample/Main.java",source,"total",Map.of("sample/Keep.java","package sample; class Keep {}\n"));
        var result = rewrite(in,"TotalsPart");
        assertEquals("sample/TotalsPart.java",result.filePath());
        assertEquals("TotalsPart",result.className());
        assertEquals("total",result.originalMethodName());
        assertEquals(3,result.files().size());
        assertEquals(in.bundle().files().get("sample/Keep.java"),result.files().get("sample/Keep.java"));
        assertEquals(source.replace(body,"{ return sample.TotalsPart.total(count); }"),result.files().get("sample/Main.java"));
        assertEquals("package sample;\n\nfinal class TotalsPart {\n    private TotalsPart() {}\n    static int total(int count) " + body + "\n}\n",
                result.files().get("sample/TotalsPart.java"));
        assertEquals(2,result.changes().size());
        assertEquals(body,result.changes().getFirst().before());
        assertEquals("",result.changes().getLast().before());
        assertEquals(0,result.changes().getLast().startOffset());
        assertEquals(0,result.changes().getLast().endOffset());
        var candidate = engine.inspect(new SourceBundle("candidate",result.files()));
        assertEquals("valid",candidate.parseStatus());
        assertEquals(4,candidate.graph().methods().size()); // wrapper, caller, private constructor, implementation
        var delegate = candidate.semantics().references().stream().filter(r -> r.kind().equals("call") && r.name().equals("total")
                && r.sourceRange().filePath().equals("sample/Main.java") && r.sourceRange().startOffset()<source.indexOf("caller")).findFirst().orElseThrow();
        assertEquals("exact",delegate.resolution());
        var target = candidate.semantics().symbols().stream().filter(s -> delegate.targetIds().contains(s.id())).findFirst().orElseThrow();
        assertEquals("sample.TotalsPart.total",target.qualifiedName());
    }

    @Test void supportsBooleanControlFlowAndDefaultPackageWithoutFieldDependencies() {
        var in = input("Main.java","class Main { static boolean total(int value, boolean enabled) { if (!enabled) return false; return value > 2; } }\n","total",Map.of());
        var result = rewrite(in,"DecisionPart");
        assertTrue(result.files().get("Main.java").contains("{ return DecisionPart.total(value, enabled); }"));
        assertTrue(result.files().get("DecisionPart.java").contains("static boolean total(int value, boolean enabled)"));
        assertEquals("valid",engine.inspect(new SourceBundle("candidate",result.files())).parseStatus());
    }

    @Test void originalOwnerInitializationAndUnrelatedStateRemainAtOriginalOwner() {
        var in = input("Main.java","class Main { static int state = 9; static { state++; } static int total(int n) { return n + 3; } }\n","total",Map.of());
        var result = rewrite(in,"TotalsPart");
        assertTrue(result.files().get("Main.java").contains("static int state = 9; static { state++; }"));
        assertFalse(result.files().get("TotalsPart.java").contains("state"));
        assertFalse(result.files().get("TotalsPart.java").contains("static {"));
    }

    @Test void rejectsStateCallsTypesAndExceptionalDependencies() {
        refuses("static int state; static int total(int n) { return n + state; }","state dependency");
        refuses("static int total(int n) { return Math.abs(n); }","MethodCallExpr");
        refuses("static int total(int n) { return total(n-1); }","MethodCallExpr");
        refuses("static int total(int[] n) { return 1; }","Parameters");
        refuses("static int total(int n) { int[] values = {1}; return values[0]; }","Local variables");
        refuses("static int total(int n) { return n / n; }","nonzero integer literal");
        refuses("static int total(int n) { n %= 0; return n; }","nonzero integer literal");
        refuses("static int total(int n) { throw new RuntimeException(); }","Statement");
        refuses("static int total(int n) { return missing; }","exact local or parameter binding");
        refuses("static int total(int n) { try { return n; } finally {} }","Statement");
    }

    @Test void rejectsDeclarationMetadataAndUnknownControlFlow() {
        refuses("@Deprecated static int total(int n) { return n; }","unannotated");
        refuses("static synchronized int total(int n) { return n; }","synchronization");
        refuses("static <T> int total(int n) { return n; }","generics");
        refuses("static int total(int n) throws Exception { return n; }","throws");
        refuses("static int total(int n) { outer: while(n>0) { break outer; } return n; }","Opaque");
        var generic = input("Main.java","class Main<T> { static int total(int n) { return n; } }\n","total",Map.of());
        assertThrows(EngineException.class,() -> rewrite(generic,"TotalsPart"));
        var inherited = input("Main.java","class Main extends Number { static int total(int n) { return n; } }\n","total",Map.of());
        assertThrows(EngineException.class,() -> rewrite(inherited,"TotalsPart"));
    }

    @Test void retainsInstanceDispatchAndVisibilityWhileMovingOnlyClosedComputation() {
        String source="class Main { private int state=7; public final long total(long n, int shift) { long result=n << shift; return result + 1L; } int keep(){return state;} }";
        var in=input("Main.java",source,"total",Map.of());
        var result=rewrite(in,"LongTotals");
        assertTrue(result.files().get("Main.java").contains("public final long total(long n, int shift) { return LongTotals.total(n, shift); }"));
        assertTrue(result.files().get("Main.java").contains("private int state=7;"));
        assertTrue(result.files().get("LongTotals.java").contains("static long total(long n, int shift) { long result=n << shift; return result + 1L; }"));
        var candidate=engine.inspect(new SourceBundle("candidate",result.files()));
        assertEquals("valid",candidate.parseStatus());
        var delegate=candidate.semantics().references().stream().filter(r->r.kind().equals("call")&&r.name().equals("total")).findFirst().orElseThrow();
        assertEquals("exact",delegate.resolution());
        assertTrue(candidate.semantics().symbols().stream().anyMatch(s->delegate.targetIds().contains(s.id())&&s.qualifiedName().equals("LongTotals.total")));
        refuses("int state; int total(int n) { return state+n; }","state dependency");
        refuses("int total(int n) { return this.hashCode()+n; }","MethodCallExpr");
    }

    @Test void supportsEveryPrimitiveSignatureCastsAndVoidEarlyReturns() {
        for(String declaration:java.util.List.of(
                "static byte total(byte value) { return (byte)(value+1); }",
                "static short total(short value) { return (short)(value+1); }",
                "static char total(char value) { return (char)(value+1); }",
                "static float total(float value) { return value+1.25f; }",
                "double total(double value) { return value+1.25d; }",
                "void total(int value) { if(value<0)return; int next=value+1; }")) {
            var in=input("Main.java","class Main { "+declaration+" }","total",Map.of());
            var result=rewrite(in,"PrimitivePart");
            assertEquals("valid",engine.inspect(new SourceBundle("candidate",result.files())).parseStatus(),declaration);
            assertTrue(result.files().get("PrimitivePart.java").contains("static "));
            if(declaration.startsWith("void"))assertTrue(result.files().get("Main.java").contains("{ PrimitivePart.total(value); }"));
        }
        refuses("static int total(int value) { return (Integer)value; }","primitive casts");
    }

    @Test void extractsTransitivePrivateStaticResponsibilityAndRetainsAllOriginalEntryPoints() {
        String source="package finance; class Main { int state=9; public long total(int quantity, long price) { return subtotal(quantity,price) + fee(quantity); }"
                +" private static long subtotal(int quantity,long price) { return clamp(quantity)*price; }"
                +" private static int clamp(int quantity) { return quantity<0 ? 0 : quantity; }"
                +" private static long fee(int quantity) { return clamp(quantity)>3 ? 2L : 0L; }"
                +" int unrelated() { return state; } }";
        var in=input("finance/Main.java",source,"total",Map.of());
        var result=rewrite(in,"Pricing");
        assertEquals(5,result.changes().size());
        String original=result.files().get("finance/Main.java"), utility=result.files().get("finance/Pricing.java");
        assertTrue(original.contains("public long total(int quantity, long price) { return finance.Pricing.total(quantity, price); }"));
        assertTrue(original.contains("private static long subtotal(int quantity,long price) { return finance.Pricing.subtotal(quantity, price); }"));
        assertTrue(original.contains("int unrelated() { return state; }"));
        assertEquals(1,utility.split("static int clamp",-1).length-1);
        assertTrue(utility.contains("return subtotal(quantity,price) + fee(quantity)"));
        var candidate=engine.inspect(new SourceBundle("candidate",result.files()));
        assertEquals("valid",candidate.parseStatus());
        for(var reference:candidate.semantics().references()) if(reference.kind().equals("call")) {
            assertEquals("exact",reference.resolution(),reference.toString());
            assertTrue(candidate.semantics().symbols().stream().anyMatch(symbol->reference.targetIds().contains(symbol.id())
                    && symbol.qualifiedName().startsWith("finance.Pricing.")),reference.toString());
        }
    }

    @Test void refusesUnsafeOrCyclicTransitiveDependenciesWithoutPartialChanges() {
        refuses("static int total(int n) { return helper(n); } static int helper(int n){return n;}","private static");
        refuses("int total(int n) { return helper(n); } private int helper(int n){return n;}","private static");
        refuses("static int state; static int total(int n) { return helper(n); } private static int helper(int n){return state+n;}","state dependency");
        refuses("static int total(int n) { return helper(n); } private static int helper(int n){return total(n);}","Recursive");
        refuses("static int total(int n) { return helper(n); } private static synchronized int helper(int n){return n;}","synchronization");
        refuses("static int total(int n) { return helper(n); } private static int helper(int n){return Math.abs(n);}","MethodCallExpr");
    }

    @Test void refusesObjectInstanceSignatureThatCannotBecomeAStaticUtilityMethod() {
        var in=input("Main.java","class Main { public int hashCode(){return 7;} }","hashCode",Map.of());
        var error=assertThrows(EngineException.class,()->rewrite(in,"HashPart"));
        assertTrue(error.getMessage().contains("Object method"));
    }

    @Test void rejectsNamesPathCollisionsAndPackageQualifierShadowing() {
        var in = input("Main.java","class Main { static int total(int n) { return n; } }\n","total",Map.of());
        for (String name : new String[]{"class","record","var","x/y","Main","total",""})
            assertThrows(EngineException.class,() -> rewrite(in,name),name);
        var collided = input("Main.java",in.bundle().files().get("Main.java"),"total",Map.of("totalspart.java","class Other {}\n"));
        assertThrows(EngineException.class,() -> rewrite(collided,"TotalsPart"));
        var shadowed = input("pkg/Main.java","package pkg; class Main { static int total(int pkg) { return pkg; } }\n","total",Map.of());
        var error=assertThrows(EngineException.class,() -> rewrite(shadowed,"TotalsPart"));
        assertTrue(error.getMessage().contains("package qualifier"));
    }

    @Test void allowsOnlyProvenNonzeroLiteralDivisorsAndRetainsOverloadSignatures() {
        var in = input("Main.java","class Main { static int total(int n) { n /= 2; return n % 3; } static int total(boolean flag) { return 7; } }\n","total",Map.of());
        var result = rewrite(in,"TotalsPart");
        assertTrue(result.files().get("Main.java").contains("static int total(boolean flag) { return 7; }"));
        assertTrue(result.files().get("TotalsPart.java").contains("n /= 2; return n % 3;"));
    }
}
