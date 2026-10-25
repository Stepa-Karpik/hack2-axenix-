package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

/** Acceptance source is parsed/edited only here. Its Java programs must run only in the isolated runner. */
class MandatoryScopeAcceptanceTest {
    private static ProgramEngine engine;
    private static SourceBundle bundle;
    private static Analysis analysis;
    private static String source;
    private static Path fixture;

    @BeforeAll static void inspectPublicFixture() throws Exception {
        fixture = Path.of("fixtures/mandatory");
        if (!Files.isDirectory(fixture)) fixture = Path.of("../../fixtures/mandatory");
        source = Files.readString(fixture.resolve("Main.java"), StandardCharsets.UTF_8);
        bundle = new SourceBundle("mandatory-fixture", Map.of("Main.java", source));
        engine = new ProgramEngine();
        analysis = engine.inspect(bundle);
    }

    @Test void substantialDiverseFixtureParsesWithoutExecutingAnyInputProgram() {
        assertTrue(source.lines().count() >= 1000);
        assertEquals("valid", analysis.parseStatus());
        assertEquals("not_requested", analysis.compileStatus());
        assertTrue(analysis.graph().methods().size() >= 100);
        assertEquals(analysis.graph().methods().size(), analysis.quality().methods().size());
        assertTrue(analysis.graph().nodes().size() > 1000);
        assertArrayEquals(source.getBytes(StandardCharsets.UTF_8), engine.exportUnchanged(bundle).get("Main.java").getBytes(StandardCharsets.UTF_8));
    }

    @Test void mandatoryLanguageAndLibraryBodiesHaveRealSourceBoundCallables() {
        Set<String> names = new HashSet<>();
        analysis.graph().methods().forEach(method -> names.add(method.fullyQualifiedName()));
        for (String name : List.of("Main.dispatch", "Main.numeric", "Main.arrays", "Main.conditions",
                "Main.strings", "Main.console", "Main.formatting", "Main.collections", "Main.comparator",
                "Main.optional", "Main.exceptions", "Main.loopCases", "Main.initializerOrder",
                "Main.anonymousComparator", "AlgorithmCases.binarySearch", "AlgorithmCases.editDistance",
                "AlgorithmCases.flood", "AlgorithmCases.nextPermutation", "NamedComparator.compare"))
            assertTrue(names.contains(name), name);
        assertTrue(analysis.graph().edges().stream().anyMatch(edge -> edge.kind().equals("loop")));
        assertTrue(analysis.semantics().symbols().stream().anyMatch(symbol -> symbol.kind().equals("field") && symbol.name().equals("x")));
    }

    @Test void initializerLifecycleFixtureHasSeparateSourceOrderStreamsAndNoFakeCallable() {
        String owner = analysis.declarations().stream().filter(declaration -> declaration.name().equals("InitOrder")
                && declaration.kind().equals("ClassOrInterfaceDeclaration")).findFirst().orElseThrow().id();
        var contexts = analysis.graph().initializerContexts().stream().filter(context -> owner.equals(context.ownerTypeDeclarationId())).toList();
        assertEquals(List.of("a", "static block #1", "b", "x", "instance block #1", "y"),contexts.stream().map(InitializerContext::label).toList());
        assertEquals(List.of(0,1,2,0,1,2),contexts.stream().map(InitializerContext::streamIndex).toList());
        assertTrue(contexts.stream().allMatch(context -> context.coverage().equals("supported")));
        Set<String> callableIds = new HashSet<>(); analysis.graph().methods().forEach(method -> callableIds.add(method.id()));
        assertTrue(contexts.stream().noneMatch(context -> callableIds.contains(context.id())));
    }

    @Test void preparesExactDetachedInitializerCallWithoutTouchingConstructorDelegation() {
        var context = analysis.graph().initializerContexts().stream().filter(c -> c.label().equals("a") &&
                slice(c.sourceRange()).equals("InitLog.mark(\"S1\")")).findFirst().orElseThrow();
        var node = context.nodes().getFirst();
        var command = new EditCommand(bundle.revisionId(), analysis.id(), null, node.id(), "replace_expression",
                new ReplaceExpression("expression", "InitLog.mark(\"S1\")"), "preserve_behavior", context.id());
        var candidate = engine.propose(bundle, analysis, command);
        assertEquals(source.replace("= InitLog.mark(\"S1\")", "= (InitLog.mark(\"S1\"))"), candidate.files().get("Main.java"));
        assertTrue(candidate.files().get("Main.java").contains("this();\n    InitLog.mark(\"C1\");"));
        assertEquals("unverified", candidate.verificationStatus());
        assertEquals("not_requested", candidate.compileStatus());
    }

    @Test void preparesActualArrayIndexEditAndLoopBoundEditAtExactOffsets() {
        int indexOffset = source.indexOf("values[1][1]") + "values[1][".length();
        var index = analysis.graph().nodes().stream().filter(node -> node.sourceRange()!=null &&
                node.sourceRange().startOffset()==indexOffset && node.sourceRange().endOffset()==indexOffset+1 &&
                node.editableFields().contains("expression")).findFirst().orElseThrow();
        var candidate = engine.propose(bundle,analysis,new EditCommand(bundle.revisionId(),analysis.id(),index.methodId(),index.id(),
                "replace_expression",new ReplaceExpression("expression","1"),"preserve_behavior"));
        assertEquals(source.substring(0,indexOffset)+"(1)"+source.substring(indexOffset+1),candidate.files().get("Main.java"));
        int loopOffset = source.indexOf("i < 5; i++") + "i < ".length();
        var bound = analysis.graph().nodes().stream().filter(node -> node.sourceRange()!=null &&
                node.sourceRange().startOffset()==loopOffset && node.sourceRange().endOffset()==loopOffset+1 &&
                node.editableFields().contains("expression")).findFirst().orElseThrow();
        var loopCandidate = engine.propose(bundle,analysis,new EditCommand(bundle.revisionId(),analysis.id(),bound.methodId(),bound.id(),
                "replace_expression",new ReplaceExpression("expression","5"),"preserve_behavior"));
        assertEquals(source.substring(0,loopOffset)+"(5)"+source.substring(loopOffset+1),loopCandidate.files().get("Main.java"));
    }

    @Test void fixedIndependentOraclesCoverEveryRunnableModeAndExplicitUnsupportedComparatorEdit() throws Exception {
        String oracles = Files.readString(fixture.resolve("oracles.json"),StandardCharsets.UTF_8);
        assertEquals(21,Pattern.compile("\"expectedStdout\"\\s*:").matcher(oracles).results().count());
        for (String id : List.of("dispatch","numeric","arrays","conditions-true","conditions-false","strings",
                "console-utf8","console-empty","console-invalid","format","collections","comparator",
                "optional-present","optional-empty","exceptions-checked","exceptions-unchecked","exceptions-normal",
                "initializer-order","loops","anonymous-comparator","algorithm-edges"))
            assertTrue(Pattern.compile("\"id\"\\s*:\\s*\""+Pattern.quote(id)+"\"").matcher(oracles).find(),id);
        assertTrue(oracles.contains("algorithms:138"));
        assertTrue(oracles.contains("unchanged round-trip only"));
        assertTrue(source.contains("new Comparator<Item>() {"));
        assertEquals(source,engine.exportUnchanged(bundle).get("Main.java"));
    }

    private static String slice(SourceRange range) { return source.substring(range.startOffset(),range.endOffset()); }
}
