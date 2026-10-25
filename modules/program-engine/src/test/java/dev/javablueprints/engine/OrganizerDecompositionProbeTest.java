package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/**
 * Probe of the existing decompose_class feature on the organizer monoliths (text only; nothing is
 * compiled or run here). Every candidate must keep the original file's global state and counters:
 * the moved helper stays reachable through a forwarding declaration and no static field moves.
 * With -Dorganizer.decompositionDir=DIR the per-method outcomes and candidate files are written.
 */
class OrganizerDecompositionProbeTest {
    private final ProgramEngine engine=new ProgramEngine();
    private static final Map<String,String> TARGETS=Map.of("NumberCruncherMess","NumberMath","TextAnalyzerMess","TextHelpers","LibraryManagerMess","LibraryText");
    private static final Map<String,List<String>> STATE=Map.of(
        "NumberCruncherMess",List.of("static long seed","static int callsFib","static int callsDet","static int callsPrime","static int totalSteps"),
        "TextAnalyzerMess",List.of("static String globalText","static List<String> allWords","static int operationsCounter","static int errorsCounter"),
        "LibraryManagerMess",List.of("static Map<String, String> bookTitles","static List<String> eventLog","static Map<String, Integer> errorStats","static int commandsProcessed","static int linearSteps"));

    @Test void decomposeClassOnEveryMonolithMethodKeepsGlobalStateInTheOriginal() throws IOException {
        String dir=System.getProperty("organizer.decompositionDir");
        var summary=new StringBuilder();
        for(var name:List.of("NumberCruncherMess","TextAnalyzerMess","LibraryManagerMess")) {
            String path=name+".java",source=StringConcatOptimizationTest.resource(name);
            var bundle=new SourceBundle("r",Map.of(path,source));
            var analysis=engine.inspect(bundle);
            int moved=0;var reasons=new TreeMap<String,List<String>>();
            for(var method:analysis.graph().methods()) {
                var entry=analysis.graph().nodes().stream().filter(n->n.id().equals(method.entryNodeId())).findFirst().orElseThrow();
                String label=method.fullyQualifiedName();
                if(!entry.allowedOperations().contains("decompose_class")){reasons.computeIfAbsent("not offered",k->new ArrayList<>()).add(label);continue;}
                try {
                    var candidate=engine.propose(bundle,analysis,new EditCommand("r",analysis.id(),method.id(),entry.id(),"decompose_class",new DecomposeClass(TARGETS.get(name)),"preserve_behavior"));
                    assertEquals("valid",candidate.parseStatus(),label);
                    String original=candidate.files().get(path);
                    // Global state and counters never leave the original class.
                    for(String field:STATE.get(name)) assertTrue(original.contains(field),label+" lost "+field);
                    for(var file:candidate.files().entrySet()) if(!file.getKey().equals(path))
                        for(String field:STATE.get(name)) assertFalse(file.getValue().contains(field),label+" moved "+field);
                    moved++;
                    reasons.computeIfAbsent("candidate",k->new ArrayList<>()).add(label);
                    if(dir!=null) {
                        var out=new File(dir,name);out.mkdirs();
                        for(var file:candidate.files().entrySet()) if(!file.getValue().equals(bundle.files().get(file.getKey())))
                            try(var w=new OutputStreamWriter(new FileOutputStream(new File(out,method.fullyQualifiedName().replaceAll("[^A-Za-z0-9_.]","_")+"--"+file.getKey()+".txt")),StandardCharsets.UTF_8)){w.write(file.getValue());}
                    }
                } catch(EngineException refused) {
                    reasons.computeIfAbsent("refused: "+refused.getMessage(),k->new ArrayList<>()).add(label);
                }
            }
            summary.append("## ").append(name).append(": ").append(moved).append(" decompose_class candidates of ").append(analysis.graph().methods().size()).append(" callables\n");
            reasons.forEach((reason,methods)->summary.append("- ").append(reason).append(" (").append(methods.size()).append("): ").append(String.join(", ",methods.stream().map(m->m.substring(m.lastIndexOf('.')+1)).toList())).append('\n'));
        }
        System.out.println(summary);
        if(dir!=null) {
            new File(dir).mkdirs();
            try(var w=new OutputStreamWriter(new FileOutputStream(new File(dir,"SUMMARY.md")),StandardCharsets.UTF_8)){w.write(summary.toString());}
        }
    }
}
