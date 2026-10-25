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

    @Test void indexesStandardLinkedListsAndInterfaceDeclarationsWithImmutableScalarKeys() {
        for(String owner:List.of("java.util.ArrayList","java.util.LinkedList")) {
            for(String declared:List.of(owner,"java.util.List")) {
                String source="class Main { static int search(Integer[] queries) { "+declared+"<Integer> allowed=new "+owner+"<>(); allowed.add(1); allowed.add(-2); allowed.add(null); int result=0; for(Integer query:queries) { if(allowed.contains(query))result++; } return result; } }";
                var a=inspect(source);
                assertEquals(1,a.optimizations().size(),source);
                String candidate=propose(source,a,"preserve_behavior").files().get("Main.java");
                assertTrue(candidate.contains("java.util.HashSet<java.lang.Integer> jbMembership = new java.util.HashSet<>(allowed);"));
                assertTrue(candidate.contains("allowed.add(-2)"));
                assertTrue(candidate.contains("jbMembership.contains(query)"));
            }
        }
    }

    @Test void acceptsOnlyBoundImmutableQueriesAndMatchingLiteralConstruction() {
        for(var scalar:List.of(new String[]{"Long","long","1L"},new String[]{"Boolean","boolean","true"},new String[]{"Character","char","'Ж'"},new String[]{"Integer","int","7"})) {
            String source="class Main { static int search("+scalar[1]+" query) { java.util.List<"+scalar[0]+"> allowed=new java.util.LinkedList<>(); allowed.add("+scalar[2]+"); int result=0; while(result<2) { if(allowed.contains(query))result++; else break; } return result; } }";
            var a=inspect(source);
            assertEquals(1,a.optimizations().size(),source);
            assertTrue(propose(source,a,"preserve_behavior").files().get("Main.java").contains("HashSet<java.lang."+scalar[0]+">"));
        }
        for(String declaration:List.of("java.util.List<Object> allowed=new java.util.ArrayList<>();", "java.util.List<Integer> allowed=java.util.List.of(1);")) {
            String source="class Main { static int search(Integer query) { "+declaration+" int result=0; while(result<2) { if(allowed.contains(query))result++; else break; } return result; } }";
            assertTrue(inspect(source).optimizations().isEmpty(),source);
        }
    }

    @Test void preservesEffectfulMethodQuerySourceCountAndShortCircuitPositionExactly() {
        String source="class Main { static int calls; static String next(String query){calls++;System.out.print(calls);return query;}"
                +" static int search(String[] queries){ "+setup+" int result=0; for(String query:queries){"
                +"if(query!=null && allowed.contains(next(query)))result++;"
                +"if(allowed.contains(next(query)) || allowed.contains(next(null)))result++;} return result; } }";
        var a=inspect(source);
        assertEquals(1,a.optimizations().size());
        assertEquals(3,a.optimizations().getFirst().querySites());
        String candidate=propose(source,a,"preserve_behavior").files().get("Main.java");
        assertTrue(candidate.contains("if(query!=null && jbMembership.contains(next(query)))result++;"));
        assertTrue(candidate.contains("if(jbMembership.contains(next(query)) || jbMembership.contains(next(null)))result++;"));
        assertEquals(source.split("next\\(",-1).length,candidate.split("next\\(",-1).length);
        assertTrue(candidate.contains("static String next(String query){calls++;System.out.print(calls);return query;}"));
    }

    @Test void retainsThrowingQueryAndPrimitiveBoxingWithoutMovingOrDuplicatingCalls() {
        for(var query:List.of(new String[]{"String","String","\"Aa\"","if(++calls==2)throw new IllegalStateException(\"query\");return value;"},
                new String[]{"Integer","int","7","calls++;return value;"})) {
            String source="class Main {static int calls;static "+query[1]+" next("+query[1]+" value){"+query[3]+"}"
                    +"static int search(){java.util.ArrayList<"+query[0]+"> allowed=new java.util.ArrayList<>();allowed.add("+query[2]+");int result=0;"
                    +"while(result<3){if(allowed.contains(next("+query[2]+")))result++;else break;}return result;} }";
            var a=inspect(source);assertEquals(1,a.optimizations().size(),source);
            String candidate=propose(source,a,"preserve_behavior").files().get("Main.java");
            assertTrue(candidate.contains("if(jbMembership.contains(next("+query[2]+")))result++;else break;"));
            assertEquals(source.split("next\\(",-1).length,candidate.split("next\\(",-1).length);
        }
    }

    @Test void effectfulQueriesStillRefuseListEscapeMutationAndUnknownResultTypes() {
        for(String source:List.of(
                "class Main {static String next(java.util.List<String> list){list.clear();return \"Aa\";}static int search(){"+setup+"int result=0;while(result<2){if(allowed.contains(next(allowed)))result++;else break;}return result;}}",
                "class Main {static Object next(){return \"Aa\";}static int search(){"+setup+"int result=0;while(result<2){if(allowed.contains(next()))result++;else break;}return result;}}",
                "class Main {static String next(){return \"Aa\";}static int search(){"+setup+"int result=0;while(result<2){allowed.add(\"change\");if(allowed.contains(next()))result++;else break;}return result;}}",
                "class Main {static int search(){"+setup+"int result=0;while(result<2){if(allowed.contains(missing()))result++;else break;}return result;}}"))
            assertTrue(inspect(source).optimizations().isEmpty(),source);
    }
}
