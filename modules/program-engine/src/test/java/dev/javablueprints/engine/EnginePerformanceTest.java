package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

/** Measures source analysis only. Fixture Java is parsed, never compiled or executed by this test. */
class EnginePerformanceTest {
    @Test
    @EnabledIfSystemProperty(named="jb.engine.perf",matches="true")
    void recordsColdWarmAnalysisSamplesForTheDeterministicLargeFixture() throws Exception {
        Path root = Path.of("fixtures/synthetic/large");
        if (!Files.isDirectory(root)) root = Path.of("../../fixtures/synthetic/large");
        Map<String,String> files = new TreeMap<>();
        final Path fixtureRoot = root;
        try (var paths = Files.walk(root)) {
            paths.filter(p -> p.toString().endsWith(".java")).sorted().forEach(p -> {
                try { files.put(fixtureRoot.relativize(p).toString().replace('\\','/'), Files.readString(p, StandardCharsets.UTF_8)); }
                catch (java.io.IOException e) { throw new java.io.UncheckedIOException(e); }
            });
        }
        assertEquals(10,files.size());
        int lines=files.values().stream().mapToInt(text -> (int)text.chars().filter(c -> c=='\n').count()).sum();
        assertTrue(lines>=1000 && lines<=1300, "Real source lines without padding");
        var bundle=new SourceBundle("large-fixture",files);
        var engine=new ProgramEngine();
        long start=System.nanoTime();Analysis first=engine.inspect(bundle);
        double cold=(System.nanoTime()-start)/1_000_000.0;
        assertEquals("valid",first.parseStatus());assertEquals(50,first.graph().methods().size());
        for(int i=0;i<5;i++) assertEquals("valid",engine.inspect(bundle).parseStatus());
        double[] samples=new double[30];
        for(int i=0;i<samples.length;i++) {
            start=System.nanoTime();Analysis next=engine.inspect(bundle);samples[i]=(System.nanoTime()-start)/1_000_000.0;
            assertEquals("valid",next.parseStatus());assertEquals(50,next.graph().methods().size());
            assertEquals(first.bundleHash(),next.bundleHash());
        }
        double[] sorted=samples.clone();Arrays.sort(sorted);
        String json="{\n  \"engine\":\""+ProgramEngine.VERSION+"\",\n  \"bundleHash\":\""+first.bundleHash()+"\",\n"
                +"  \"files\":"+files.size()+",\"lines\":"+lines+",\"methods\":"+first.graph().methods().size()+",\"graphNodes\":"+first.graph().nodes().size()+",\n"
                +"  \"jdk\":\""+System.getProperty("java.version")+"\",\"processors\":"+Runtime.getRuntime().availableProcessors()+",\n"
                +"  \"coldFirstInJvmMs\":"+cold+",\"warmupCount\":5,\"warmSamplesMs\":"+Arrays.toString(samples)+",\n"
                +"  \"warmMedianMs\":"+((sorted[14]+sorted[15])/2)+",\"warmP95Ms\":"+sorted[28]+",\"warmMaxMs\":"+sorted[29]+"\n}\n";
        Path output=Path.of("target/engine-benchmark.json");Files.createDirectories(output.getParent());Files.writeString(output,json,StandardCharsets.UTF_8);
        System.out.println("Engine source analysis benchmark: "+output+"; cold="+cold+"ms, warm p95="+sorted[28]+"ms");
    }
}
