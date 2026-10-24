package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class MembershipOptimizationTest {
    private final ProgramEngine engine=new ProgramEngine();
    private final String setup="java.util.ArrayList<String> allowed = new java.util.ArrayList<>(); allowed.add(\"Aa\"); allowed.add(\"BB\"); allowed.add(null); allowed.add(\"Aa\");";
    private String source(String before,String loop,String after) {
        return "class Main { static int search(String[] queries) { "+before+" int result=0; "+loop+" "+after+" return result; } }";
    }
    private String loop(String body) { return "for(String query: queries) { "+body+" }"; }
    private Analysis inspect(String source) { return engine.inspect(new SourceBundle("r",Map.of("Main.java",source))); }
    private Candidate propose(String source, Analysis analysis, String intent) {
        var opportunity=analysis.optimizations().getFirst();
        return engine.propose(new SourceBundle("r",Map.of("Main.java",source)),analysis,new EditCommand("r",analysis.id(),opportunity.methodId(),opportunity.nodeId(),"optimize_membership",new OptimizeMembership(),intent));
    }
    @Test void preservesListAndQueriesAndBuildsOneStandardIndexBeforeTheLoop() {
        String source=source(setup,loop("// allowed.contains(query) stays in comment\nif(allowed.contains(query)) result++;"),"");
        var a=inspect(source);
        assertEquals(1,a.optimizations().size(),()->a.semantics().toString());
        var opportunity=a.optimizations().getFirst(); assertEquals("allowed",opportunity.receiverName()); assertEquals(1,opportunity.querySites());
        assertEquals("OPT-MEMBERSHIP-001",opportunity.ruleId());
        assertTrue(a.graph().nodes().stream().filter(n->n.id().equals(opportunity.nodeId())).findFirst().orElseThrow().allowedOperations().contains("optimize_membership"));
        String candidate=propose(source,a,"preserve_behavior").files().get("Main.java");
        assertTrue(candidate.contains(setup));
        assertTrue(candidate.contains("java.util.HashSet<java.lang.String> jbMembership = new java.util.HashSet<>(allowed);\nfor(String query: queries)"));
        assertTrue(candidate.contains("// allowed.contains(query) stays in comment"));
        assertTrue(candidate.contains("if(jbMembership.contains(query)) result++"));
        assertEquals(1,candidate.split("new java.util.HashSet",-1).length-1);
        assertEquals(source,engine.exportUnchanged(new SourceBundle("r",Map.of("Main.java",source))).get("Main.java"));
        assertEquals("unverified",propose(source,a,"preserve_behavior").verificationStatus());
    }
    @Test void supportsEmptyListsNullQueriesAndGeneratedNameCollisionsWithoutEditingOtherText() {
        String source=source("int jbMembership=0; java.util.ArrayList<String> allowed = new java.util.ArrayList<>();",
                "while(result<queries.length) { if(allowed.contains(null)) result++; else break; }","");
        var a=inspect(source);assertEquals(1,a.optimizations().size());
        String candidate=propose(source,a,"preserve_behavior").files().get("Main.java");
        assertTrue(candidate.contains("HashSet<java.lang.String> jbMembership2 ="));
        assertTrue(candidate.contains("jbMembership2.contains(null)"));
        assertTrue(candidate.contains("int jbMembership=0;"));
    }
    @Test void rejectsAliasEscapeReassignmentMutationAndOrderOrCountUses() {
        var cases=List.of(
                source(setup+" var alias=allowed;",loop("if(allowed.contains(query))result++;"),""),
                source(setup+" consume(allowed);",loop("if(allowed.contains(query))result++;"),""),
                source(setup+" allowed=new java.util.ArrayList<>();",loop("if(allowed.contains(query))result++;"),""),
                source(setup,loop("allowed.clear(); if(allowed.contains(query))result++;"),""),
                source(setup,loop("if(allowed.contains(query))result++;"),"allowed.add(\"later\");"),
                source(setup,loop("if(allowed.contains(query))result += allowed.size();"),""),
                source(setup,loop("if(allowed.contains(query))result += allowed.indexOf(query);"),""),
                source(setup,loop("System.out.println(allowed); if(allowed.contains(query))result++;"),""),
                source(setup+" allowed.add(queries[0]);",loop("if(allowed.contains(query))result++;"),"")
        );
        for(String source:cases) assertTrue(inspect(source).optimizations().isEmpty(),source);
    }
    @Test void rejectsNonStringAndUnknownQueriesCustomTypesAndNonLocalReceivers() {
        var cases=List.of(
                source(setup,loop("if(allowed.contains(new Object()))result++;"),""),
                source(setup,loop("if(allowed.contains(unknown))result++;"),""),
                source(setup.replace("ArrayList<String>","ArrayList<Object>"),loop("if(allowed.contains(query))result++;"),""),
                source(setup.replace("ArrayList<String>","ArrayList"),loop("if(allowed.contains(query))result++;"),""),
                "class Main { java.util.ArrayList<String> allowed=new java.util.ArrayList<>(); void m(String[] queries){for(String query:queries)if(allowed.contains(query))System.out.println(query);} }",
                "class Main { void m(String[] queries){ java.util.ArrayList<String> allowed = get(); for(String query:queries)if(allowed.contains(query))System.out.println(query); } java.util.ArrayList<String> get(){return null;} }",
                "class ArrayList<T>{boolean contains(T value){return true;}} class Main { void m(String[] queries){ArrayList<String> allowed=new ArrayList<>();for(String query:queries)if(allowed.contains(query))System.out.println(query);}}"
        );
        for(String source:cases)assertTrue(inspect(source).optimizations().isEmpty(),source);
    }
    @Test void rejectsClosuresFinallyLabelsNestedRegionsAndKnownTimeObservation() {
        var cases=List.of(
                source(setup+" Runnable task=()->allowed.clear();",loop("if(allowed.contains(query))result++;"),""),
                source(setup,"try {"+loop("if(allowed.contains(query))result++;")+"} finally { allowed.clear(); }",""),
                source(setup,"outer:"+loop("if(allowed.contains(query))result++;"),""),
                source(setup,"if(queries!=null){"+loop("if(allowed.contains(query))result++;")+"}",""),
                source(setup+" long start=System.nanoTime();",loop("if(allowed.contains(query))result++;"),"")
        );
        for(String source:cases)assertTrue(inspect(source).optimizations().isEmpty(),source);
    }
    @Test void onlyRepeatedRegionsAreEligibleAndSemanticEditCannotBypassVerification() {
        var once=inspect(source(setup,"for(boolean once=allowed.contains(null);once;once=false)result++;",""));
        assertTrue(once.optimizations().isEmpty());
        String source=source(setup,loop("if(allowed.contains(query))result++;"),""); var a=inspect(source);
        var error=assertThrows(EngineException.class,()->propose(source,a,"semantic_edit"));
        assertEquals("INVALID_EDIT",error.code());
        var op=a.optimizations().getFirst();
        assertThrows(EngineException.class,()->engine.propose(new SourceBundle("other",Map.of("Main.java",source)),a,new EditCommand("r",a.id(),op.methodId(),op.nodeId(),"optimize_membership",new OptimizeMembership(),"preserve_behavior")));
    }
    @Test void candidateRejectsAHashSetThatResolvesToSourceShadowing() {
        String source="import java.util.ArrayList; class Main { static class java {static class util {static class HashSet<T>{HashSet(Object value){}boolean contains(T value){return false;}}}} void m(String[] queries){ArrayList<String> allowed=new ArrayList<>();for(String query:queries){if(allowed.contains(query))System.out.println(query);}}}";
        var a=inspect(source);
        assertEquals(1,a.optimizations().size());
        var error=assertThrows(EngineException.class,()->propose(source,a,"preserve_behavior"));
        assertEquals("UNSUPPORTED_OPERATION",error.code());
    }
}
