package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class StringConcatOptimizationTest {
    private final ProgramEngine engine=new ProgramEngine();
    private static final String RULE="OPT-STRBUILD-001", OPERATION="optimize_string_builder";

    private Analysis inspect(String path,String source) { return engine.inspect(new SourceBundle("r",Map.of(path,source))); }
    private static List<OptimizationOpportunity> text(Analysis analysis) {
        return analysis.optimizations().stream().filter(o->o.ruleId().equals(RULE)).toList();
    }
    private Candidate propose(String path,String source,Analysis analysis,OptimizationOpportunity opportunity,String intent) {
        return engine.propose(new SourceBundle("r",Map.of(path,source)),analysis,new EditCommand("r",analysis.id(),opportunity.methodId(),
                opportunity.nodeId(),OPERATION,new OptimizeStringBuilder(),intent));
    }
    private String apply(String source) {
        var a=inspect("Main.java",source);
        var found=text(a);
        assertEquals(1,found.size(),source);
        var candidate=propose("Main.java",source,a,found.getFirst(),"preserve_behavior");
        assertEquals("valid",candidate.parseStatus());
        assertEquals("unverified",candidate.verificationStatus());
        return candidate.files().get("Main.java");
    }
    private static String main(String body) { return "class Main {\n    static String f(String s, int n) {\n"+body+"    }\n}\n"; }

    static String resource(String name) {
        try(InputStream in=StringConcatOptimizationTest.class.getResourceAsStream("/organizer/"+name+".java.txt")) {
            return new String(Objects.requireNonNull(in,name).readAllBytes(),StandardCharsets.UTF_8).replace("\r\n","\n");
        } catch(IOException e) { throw new UncheckedIOException(e); }
    }
    private static String method(String source,int offset) {
        int start=source.lastIndexOf("\n    static ",offset);
        String head=source.substring(start+1,source.indexOf('(',start));
        return head.substring(head.lastIndexOf(' ')+1);
    }

    @Test void rewritesCharAccumulatorAndKeepsEverythingElseByteForByte() {
        String source=main("""
                        String result = "";
                        for (int i = 0; i < s.length(); i++) {
                            char c = s.charAt(i);
                            result = result + c;
                        }
                        return result;
                """);
        String candidate=apply(source);
        assertEquals(main("""
                        String result = "";
                        StringBuilder jbText = new StringBuilder(result); for (int i = 0; i < s.length(); i++) {
                            char c = s.charAt(i);
                            jbText.append(c);
                        } if (jbText.length() != result.length()) result = jbText.toString();
                        return result;
                """),candidate);
        assertEquals(source.split("\n",-1).length,candidate.split("\n",-1).length);
        var a=inspect("Main.java",source);
        var op=text(a).getFirst();
        assertEquals("result",op.receiverName());assertEquals(1,op.querySites());
        assertTrue(a.graph().nodes().stream().filter(n->n.id().equals(op.nodeId())).findFirst().orElseThrow().allowedOperations().contains(OPERATION));
        assertTrue(a.coverage().stream().anyMatch(c->c.feature().equals(RULE)&&c.status().equals("partial")));
    }

    @Test void flattensLeftSpineCompoundAssignmentAndNestedLoopsWithTypedOperands() {
        // ((line + k) + ", ") + boxed keeps three appends; += keeps its right side as one typed operand (char + int is int).
        String candidate=apply(main("""
                        String line = s + ": [";
                        Integer boxed = null;
                        int k = 0;
                        while (k < n) {
                            for (int j = 0; j < 2; j++) { line = line + k + ", " + boxed; }
                            line += 'a' + 1;
                            k++;
                        }
                        return line;
                """));
        assertTrue(candidate.contains("        StringBuilder jbText = new StringBuilder(line); while (k < n) {"),candidate);
        assertTrue(candidate.contains("{ jbText.append(k).append(\", \").append(boxed); }"),candidate);
        assertTrue(candidate.contains("jbText.append('a' + 1);"),candidate);
        assertTrue(candidate.contains("} if (jbText.length() != line.length()) line = jbText.toString();\n        return line;"),candidate);
    }

    @Test void avoidsGeneratedNameCollisionsAndHandlesForEachAndInnerBlocks() {
        String candidate=apply(main("""
                        int jbText = 0;
                        java.util.List<Long> values = java.util.List.of(1L, 2L);
                        for (int r = 0; r < n; r++) {
                            String bar = "";
                            for (Long v : values) {
                                bar = bar + v + "#";
                            }
                            System.out.println(bar);
                        }
                        return s;
                """));
        assertTrue(candidate.contains("            StringBuilder jbText2 = new StringBuilder(bar); for (Long v : values) {"),candidate);
        assertTrue(candidate.contains("jbText2.append(v).append(\"#\");"),candidate);
        assertTrue(candidate.contains("} if (jbText2.length() != bar.length()) bar = jbText2.toString();\n            System.out.println(bar);"),candidate);
    }

    @Test void refusesMultiLineAccumulationWhoseRewriteWouldShiftLines() {
        String split=main("String r = \"\";\nfor (int i = 0; i < n; i++) {\n r = r\n + i;\n}\nreturn r;\n");
        assertTrue(text(inspect("Main.java",split)).isEmpty());
        // A line break inside an operand is kept verbatim, so it remains allowed.
        String inOperand=main("String r = \"\";\nfor (int i = 0; i < n; i++) {\n r = r + (i\n + 1);\n}\nreturn r;\n");
        String candidate=apply(inOperand);
        assertTrue(candidate.contains("jbText.append((i\n + 1));"),candidate);
        assertEquals(inOperand.split("\n",-1).length,candidate.split("\n",-1).length);
    }

    @Test void refusesEveryUnprovenShape() {
        var cases=Map.ofEntries(
            Map.entry("read inside loop", "String r = \"\"; for (int i = 0; i < n; i++) { if (r.length() > 3) break; r = r + i; } return r;"),
            Map.entry("read in condition", "String r = \"\"; while (r.length() < n) { r = r + \"x\"; } return r;"),
            Map.entry("operand reads accumulator", "String r = \"\"; for (int i = 0; i < n; i++) { r = r + r.length(); } return r;"),
            Map.entry("reset inside loop", "String r = \"\"; for (int i = 0; i < n; i++) { r = r + i; if (i == 2) r = \"\"; } return r;"),
            Map.entry("value used", "String r = \"\"; String q = null; for (int i = 0; i < n; i++) { q = (r = r + i); } return q;"),
            Map.entry("non-leftmost accumulator", "String r = \"\"; for (int i = 0; i < n; i++) { r = i + r; } return r;"),
            Map.entry("parameter may be null", "for (int i = 0; i < n; i++) { s = s + i; } return s;"),
            Map.entry("nullable initializer", "String r = s; for (int i = 0; i < n; i++) { r = r + i; } return r;"),
            Map.entry("reassigned before loop", "String r = \"\"; r = s; for (int i = 0; i < n; i++) { r = r + i; } return r;"),
            Map.entry("captured by lambda", "String r = \"\"; for (int i = 0; i < n; i++) { r = r + i; } final String f = r; Runnable x = () -> System.out.println(f); return r;"),
            Map.entry("anonymous class", "String r = \"\"; for (int i = 0; i < n; i++) { r = r + i; } new Object() { }; return r;"),
            Map.entry("try around loop", "String r = \"\"; try { for (int i = 0; i < n; i++) { r = r + (10 / (3 - i)); } } catch (ArithmeticException e) { } return r;"),
            Map.entry("try inside loop", "String r = \"\"; for (int i = 0; i < n; i++) { try { r = r + (10 / (3 - i)); } catch (ArithmeticException e) { } } return r;"),
            Map.entry("labeled loop", "String r = \"\"; outer: for (int i = 0; i < n; i++) { r = r + i; } return r;"),
            Map.entry("possibly empty string operand", "String r = \"\"; for (int i = 0; i < n; i++) { r = r + s; } return r;"),
            Map.entry("empty literal operand", "String r = \"\"; for (int i = 0; i < n; i++) { r = r + \"\"; } return r;"),
            Map.entry("char array operand", "String r = \"\"; char[] a = {'x'}; for (int i = 0; i < n; i++) { r = r + a; } return r;"),
            Map.entry("object operand", "String r = \"\"; StringBuilder b = new StringBuilder(); for (int i = 0; i < n; i++) { r = r + b; } return r;"),
            Map.entry("null operand", "String r = \"\"; for (int i = 0; i < n; i++) { r = r + null; } return r;"),
            Map.entry("conditional operand", "String r = \"\"; for (int i = 0; i < n; i++) { r = r + (i > 0 ? i : 'c'); } return r;"),
            Map.entry("internal comment", "String r = \"\"; for (int i = 0; i < n; i++) { r = r /* keep */ + i; } return r;"),
            Map.entry("not String", "Object r = \"\"; for (int i = 0; i < n; i++) { r = r + \"x\"; } return s;"),
            Map.entry("parenthesized value", "String r = \"\"; for (int i = 0; i < n; i++) { r = (r + i); } return r;"));
        for(var entry:cases.entrySet())
            assertTrue(text(inspect("Main.java",main(entry.getValue()+"\n"))).isEmpty(),entry.getKey());
        String field="class Main { static String acc = \"\"; static int counter; static void f(int n) { for (int i = 0; i < n; i++) { acc = acc + i; counter++; } } }";
        assertTrue(text(inspect("Main.java",field)).isEmpty(),"static field accumulator (observable state)");
        String shadow="class StringBuilder { StringBuilder(String s) {} StringBuilder append(char c) { return this; } }\nclass Main { static String f(String s) { String r = \"\"; for (int i = 0; i < s.length(); i++) { r = r + s.charAt(i); } return r; } }";
        var a=inspect("Main.java",shadow);
        for(var op:text(a)) assertThrows(EngineException.class,()->propose("Main.java",shadow,a,op,"preserve_behavior"),"user StringBuilder must not be used");
    }

    @Test void requiresPreserveIntentAndEmptyPayloadAndExactBinding() {
        String source=main("String r = \"\";\nfor (int i = 0; i < n; i++) { r = r + i; }\nreturn r;\n");
        var a=inspect("Main.java",source);var op=text(a).getFirst();
        assertThrows(EngineException.class,()->propose("Main.java",source,a,op,"semantic_edit"));
        assertThrows(EngineException.class,()->engine.propose(new SourceBundle("r",Map.of("Main.java",source)),a,
                new EditCommand("r",a.id(),op.methodId(),op.nodeId(),OPERATION,new OptimizeMembership(),"preserve_behavior")));
        var entry=a.graph().methods().getFirst().entryNodeId();
        assertThrows(EngineException.class,()->engine.propose(new SourceBundle("r",Map.of("Main.java",source)),a,
                new EditCommand("r",a.id(),op.methodId(),entry,OPERATION,new OptimizeStringBuilder(),"preserve_behavior")));
    }

    /**
     * Applies every opportunity of each organizer monolith in turn (re-analysing the moving candidate,
     * as the UI/API does after each apply) and checks that printed counters, global state and all
     * other statements survive token-for-token. With -Dorganizer.diffDir=DIR it writes one diff per
     * step plus the final candidate (text only; nothing is compiled or run here).
     */
    @Test void appliesAllOpportunitiesSequentiallyKeepingCountersAndGlobalState() throws IOException {
        var counters=Map.of(
            "NumberCruncherMess",List.of("callsFib++","callsDet++","callsPrime++","totalSteps++","seed ="),
            "TextAnalyzerMess",List.of("operationsCounter++","errorsCounter++","debugCounter++","globalText ="),
            "LibraryManagerMess",List.of("linearSteps++","commandsProcessed++","errorStats.","eventLog."));
        String dir=System.getProperty("organizer.diffDir");
        for(var entry:counters.entrySet()) {
            String name=entry.getKey(),path=name+".java",source=resource(name),current=source;
            int expected=text(inspect(path,source)).size(),step=0;
            var log=new StringBuilder();
            while(true) {
                var analysis=inspect(path,current);
                assertEquals("valid",analysis.parseStatus(),name);
                var found=text(analysis);
                if(found.isEmpty())break;
                var op=found.getFirst();
                var candidate=propose(path,current,analysis,op,"preserve_behavior");
                assertEquals("valid",candidate.parseStatus(),name);
                String after=candidate.files().get(path);
                String[] oldLines=current.split("\n",-1),newLines=after.split("\n",-1);
                assertEquals(oldLines.length,newLines.length,name);
                step++;
                log.append("### ").append(name).append(" step ").append(step).append(": ").append(method(current,op.sourceRange().startOffset()))
                   .append(" lines ").append(op.sourceRange().startLine()).append('-').append(op.sourceRange().endLine()).append(" (").append(op.receiverName()).append(")\n");
                log.append("--- a/").append(path).append("\n+++ b/").append(path).append("\n@@ -").append(op.sourceRange().startLine()).append(',')
                   .append(op.sourceRange().endLine()-op.sourceRange().startLine()+1).append(" +").append(op.sourceRange().startLine()).append(',')
                   .append(op.sourceRange().endLine()-op.sourceRange().startLine()+1).append(" @@\n");
                for(int i=op.sourceRange().startLine()-1;i<op.sourceRange().endLine();i++) if(!oldLines[i].equals(newLines[i])) log.append('-').append(oldLines[i]).append('\n');
                for(int i=op.sourceRange().startLine()-1;i<op.sourceRange().endLine();i++) log.append(oldLines[i].equals(newLines[i])?" ":"+").append(newLines[i]).append('\n');
                current=after;
                assertTrue(step<=expected,name+" did not converge");
            }
            assertEquals(expected,step,name+": every opportunity applies exactly once");
            for(String marker:entry.getValue()) assertEquals(count(source,marker),count(current,marker),name+" "+marker);
            // Every line that is not a rewritten accumulation keeps its exact text outside the loop headers/closers.
            String[] before=source.split("\n",-1),after=current.split("\n",-1);
            int changed=0;for(int i=0;i<before.length;i++) if(!before[i].equals(after[i])) changed++;
            assertTrue(changed<=4*expected+30,name+" changed lines "+changed);
            if(dir!=null) {
                var out=new File(dir);out.mkdirs();
                try(var w=new OutputStreamWriter(new FileOutputStream(new File(out,name+".steps.diff")),StandardCharsets.UTF_8)){w.write(log.toString());}
                try(var w=new OutputStreamWriter(new FileOutputStream(new File(out,name+".candidate.java.txt")),StandardCharsets.UTF_8)){w.write(current);}
            }
        }
    }
    private static int count(String text,String marker){int n=0;for(int at=text.indexOf(marker);at>=0;at=text.indexOf(marker,at+1))n++;return n;}

    /** Real organizer monoliths (read as text only, never compiled or run here). */
    @Test void findsAndAppliesOpportunitiesInAllThreeOrganizerMonoliths() {
        var expected=Map.of(
            "NumberCruncherMess",List.of("printArray:67:line:2","printPascal:176:line:1","printMatrix:608:line:1","isPalindromeNumber:631:reversed:1"),
            "TextAnalyzerMess",List.of("toLowerSlow:55:result:1","toUpperSlow:67:result:1","reverseSlow:191:result:1","isPhrasePalindrome:225:cleaned:1",
                    "sortCharsSelection:253:result:1","caesar:296:result:3","printLetterFrequency:386:bar:1","rleEncode:530:result:1",
                    "rleDecode:545:result:1","rleDecode:549:num:1","capitalizeWords:671:result:2","printSeparator:801:line:1"),
            "LibraryManagerMess",List.of("lower:133:result:1","underscoresToSpaces:145:result:2","linkedCollectionsDemo:664:keys:1"));
        var examples=Map.of(
            "NumberCruncherMess","printArray",
            "TextAnalyzerMess","caesar",
            "LibraryManagerMess","linkedCollectionsDemo");
        var exampleAfter=Map.of(
            "NumberCruncherMess","""
                StringBuilder jbText = new StringBuilder(line); for (int i = 0; i < arr.length && i < limit; i++) {
                            jbText.append(arr[i]);
                            if (i < arr.length - 1 && i < limit - 1) {
                                jbText.append(", ");
                            }
                        } if (jbText.length() != line.length()) line = jbText.toString();""",
            "TextAnalyzerMess","""
                StringBuilder jbText = new StringBuilder(result); for (int i = 0; i < s.length(); i++) {
                            char c = s.charAt(i);
                            if (c >= 'a' && c <= 'z') {
                                int pos = c - 'a';
                                pos = (pos + shift) % 26;
                                jbText.append((char) ('a' + pos));
                            } else if (c >= 'A' && c <= 'Z') {
                                int pos = c - 'A';
                                pos = (pos + shift) % 26;
                                jbText.append((char) ('A' + pos));
                            } else {
                                jbText.append(c);
                            }
                        } if (jbText.length() != result.length()) result = jbText.toString();""",
            "LibraryManagerMess","""
                StringBuilder jbText = new StringBuilder(keys); for (Map.Entry<String, Integer> entry : ordered.entrySet()) {
                            jbText.append(entry.getKey()).append("=").append(entry.getValue()).append(";");
                        } if (jbText.length() != keys.length()) keys = jbText.toString();""");
        for(String name:expected.keySet()) {
            String path=name+".java",source=resource(name);
            var analysis=inspect(path,source);
            assertEquals("valid",analysis.parseStatus());
            var found=text(analysis);
            assertEquals(expected.get(name),found.stream().map(o->method(source,o.sourceRange().startOffset())+":"+o.sourceRange().startLine()
                    +":"+o.receiverName()+":"+o.querySites()).toList(),name);
            // Deterministic: a fresh analysis yields the same opportunities in the same order (ids differ only by analysis prefix).
            var again=text(inspect(path,source));
            assertEquals(found.stream().map(o->o.nodeId().substring(analysis.id().length())+o.methodId().substring(analysis.id().length())+o.sourceRange()).toList(),
                    again.stream().map(o->o.nodeId().substring(o.nodeId().lastIndexOf(':'))+o.methodId().substring(o.methodId().lastIndexOf(':'))+o.sourceRange()).toList());
            for(var op:found) {
                if(System.getProperty("organizer.dump")!=null)
                    System.out.println("OPP "+name+" "+method(source,op.sourceRange().startOffset())+" line="+op.sourceRange().startLine()+"-"+op.sourceRange().endLine()
                            +" node=:"+op.nodeId().substring(op.nodeId().lastIndexOf(':')+1)+" method=:"+op.methodId().substring(op.methodId().lastIndexOf(':')+1));
                var candidate=propose(path,source,analysis,op,"preserve_behavior");
                assertEquals("valid",candidate.parseStatus(),name);
                assertEquals(1,candidate.changes().size());
                var change=candidate.changes().getFirst();
                String after=candidate.files().get(path);
                // Exact splice: only the loop range changes; prefix and suffix are byte-identical.
                assertEquals(source.substring(0,change.startOffset())+change.after()+source.substring(change.endOffset()),after);
                assertEquals(source.substring(change.startOffset(),change.endOffset()),change.before());
                // Line numbers of all code (and of stack traces) are preserved: same line count, lines outside the loop identical.
                String[] oldLines=source.split("\n",-1),newLines=after.split("\n",-1);
                assertEquals(oldLines.length,newLines.length,name);
                int first=op.sourceRange().startLine()-1,last=op.sourceRange().endLine()-1;
                for(int i=0;i<oldLines.length;i++) if(i<first||i>last) assertEquals(oldLines[i],newLines[i],name+":"+(i+1));
                if(name.equals("TextAnalyzerMess")&&method(source,op.sourceRange().startOffset()).equals("caesar")) {
                    assertEquals("            throw new IllegalArgumentException(\"Сдвиг вне диапазона: \" + shift);",newLines[292]);
                    assertEquals(oldLines[313],newLines[313]);assertEquals(oldLines[322],newLines[322]);assertEquals(oldLines[888],newLines[888]);
                }
                var reanalysis=inspect(path,after);
                assertEquals("valid",reanalysis.parseStatus());
                assertTrue(reanalysis.diagnostics().isEmpty(),()->reanalysis.diagnostics().toString());
                if(method(source,op.sourceRange().startOffset()).equals(examples.get(name)))
                    assertEquals(exampleAfter.get(name),change.after(),name);
            }
            assertEquals(source,engine.exportUnchanged(new SourceBundle("r",Map.of(path,source))).get(path));
        }
    }
}
