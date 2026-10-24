package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class QualityAnalysisTest {
    private final ProgramEngine engine = new ProgramEngine();
    private Analysis inspect(String source) { return engine.inspect(new SourceBundle("revision",Map.of("Main.java",source))); }
    private MethodMetrics method(Analysis a, String signature) {
        String id=a.graph().methods().stream().filter(m->m.signature().equals(signature)).findFirst().orElseThrow().id();
        return a.quality().methods().stream().filter(m->m.methodId().equals(id)).findFirst().orElseThrow();
    }

    @Test void reportsSourceBoundCountsAndNeverGuessesRuntimeCost() {
        String source="""
                class Main {
                  int work(int n) {
                    int result = 0;
                    for (int i = 0; i < n; i++) {
                      if (i > 0 && n > 1) {
                        result += help(i);
                      }
                    }
                    return result;
                  }
                  int help(int n) { return n; }
                }
                """;
        var a=inspect(source); var m=method(a,"work(int)");
        assertEquals(9,m.bodyLines()); assertEquals(9,m.codeLines());
        assertEquals(5,m.statements()); assertEquals(4,m.branchingScore());
        assertEquals(2,m.maxNesting()); assertEquals(1,m.loops()); assertEquals(1,m.maxLoopNesting()); assertEquals(1,m.calls());
        assertEquals("unknown",m.asymptotic()); assertEquals("bounds_and_call_costs_unproven",m.asymptoticReason());
        assertTrue(a.graph().nodes().stream().anyMatch(n->n.id().equals(m.entryNodeId())&&n.methodId().equals(m.methodId())));
        assertEquals("Main.java",m.sourceRange().filePath()); assertEquals(2,m.sourceRange().startLine());
        assertEquals(Map.of("Main.java",source),engine.exportUnchanged(new SourceBundle("revision",Map.of("Main.java",source))));
    }

    @Test void commentsAndBlankLinesAreExcludedButMultilineLiteralTokensAreRetained() {
        String source="class Main { void m() {\n// ignored\n/* two\n comment lines */\n\nint n=0;\nString s = \"\"\"\n\ntext\n\"\"\";\n}\n}";
        var m=method(inspect(source),"m()");
        assertEquals(11,m.bodyLines()); assertEquals(7,m.codeLines()); assertEquals(2,m.statements());
    }

    @Test void nestedBodiesNeverInflateTheEnclosingCallable() {
        String source="""
                class Main {
                  Main() { this(1); }
                  Main(int n) {}
                  void outer() {
                    Runnable task = () -> { while (true) { System.out.println(1); } };
                    class Local { void inner() { for (;;) { System.out.println(2); } } }
                    Runnable anonymous = new Runnable() { public void run() { do { System.out.println(3); } while (true); } };
                  }
                }
                """;
        var a=inspect(source); var outer=method(a,"outer()");
        assertEquals(0,outer.loops()); assertEquals(0,outer.maxNesting());
        assertEquals(1,outer.branchingScore()); assertEquals(1,outer.calls()); assertEquals(2,outer.statements());
        assertEquals(1,method(a,"inner()").loops()); assertEquals(1,method(a,"run()").loops());
        assertEquals(1,method(a,"Main()").calls());
    }

    @Test void syntacticScoreIncludesSwitchAlternativesCatchAndConditionalOperators() {
        var a=inspect("class Main { int m(int n) { try { switch(n) { case 1: case 2: return n>0 || n<0 ? 1 : 0; default: return 0; } } catch (RuntimeException e) { return -1; } } }");
        var m=method(a,"m(int)");
        assertEquals(6,m.branchingScore()); // 1 + two cases + || + ?: + catch
        assertEquals(2,m.maxNesting()); assertEquals(0,m.loops());
        assertTrue(a.diagnostics().stream().anyMatch(d->d.code().equals("UNSUPPORTED_CONTROL_FLOW")));
        assertEquals("unknown",m.asymptotic());
    }

    @Test void recommendationsHaveDeterministicEvidenceAndExactUnicodeRanges() {
        String source="class Main { void длинный() {\nint n=0;\n"+"n++;\n".repeat(40)
                +"for (;;) { for (;;) { if(n>0){if(n>1){if(n>2){if(n>3){break;}}}} break; } break; }\n"
                +"if(n>0) n++;\n".repeat(10)+"} }";
        var a=inspect(source); var b=inspect(source); var m=method(a,"длинный()");
        assertEquals(Set.of("LONG_METHOD","DEEP_NESTING","NESTED_LOOPS","HIGH_BRANCHING"),a.quality().findings().stream().map(CodeFinding::code).collect(java.util.stream.Collectors.toSet()));
        assertEquals(a.quality().findings().stream().map(f->List.of(f.code(),f.observed(),f.threshold(),f.sourceRange())).toList(),
                b.quality().findings().stream().map(f->List.of(f.code(),f.observed(),f.threshold(),f.sourceRange())).toList());
        var length=a.quality().findings().stream().filter(f->f.code().equals("LONG_METHOD")).findFirst().orElseThrow();
        assertEquals("длинный",source.substring(length.sourceRange().startOffset(),length.sourceRange().endOffset()));
        assertEquals(m.methodId(),length.methodId()); assertEquals(m.entryNodeId(),length.nodeId());
        assertTrue(length.observed()>=length.threshold()); assertFalse(length.expectedEffect().isBlank());
        assertFalse(a.diagnostics().stream().anyMatch(d->d.code().equals("LONG_METHOD")));
    }

    @Test void bundleFailureAndBodylessDeclarationsNeverProduceFakeMeasurements() {
        var bodyless=inspect("abstract class Main { abstract int absent(); Main(){} }");
        assertEquals(1,bodyless.quality().methods().size());
        var bad=engine.inspect(new SourceBundle("r",Map.of("Main.java","class Main { void m(){} }","Broken.java","class Broken { !!! }")));
        assertEquals("invalid",bad.parseStatus()); assertTrue(bad.quality().methods().isEmpty()); assertTrue(bad.quality().findings().isEmpty());
    }

    @Test void findingsAreBoundedWithoutDroppingMethodMetrics() {
        String body="int n=0;\n"+"n++;\n".repeat(40)+"for(;;){for(;;){if(n>0){if(n>1){n++;}}break;}break;}\n"+"if(n>0)n++;\n".repeat(10);
        var source=new StringBuilder("class Main {\n");
        for(int i=0;i<101;i++) source.append("void m").append(i).append("(){\n").append(body).append("}\n");
        source.append('}'); var a=inspect(source.toString());
        assertEquals(101,a.quality().methods().size()); assertEquals(400,a.quality().findings().size()); assertTrue(a.quality().findingsTruncated());
    }
}
