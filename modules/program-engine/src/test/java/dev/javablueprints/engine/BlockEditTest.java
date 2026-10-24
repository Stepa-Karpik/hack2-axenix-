package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class BlockEditTest {
    final ProgramEngine engine = new ProgramEngine();
    SourceBundle bundle(String body) { return new SourceBundle("base", Map.of("Main.java", "// 😀\nclass Main {void f(boolean ok){" + body + "}}\n", "Keep.java", "/* untouched */ class Keep{}\n")); }
    GraphNode node(Analysis a, String label) { return a.graph().nodes().stream().filter(n -> n.label().equals(label)).findFirst().orElseThrow(); }
    GraphNode kind(Analysis a, String kind) { return a.graph().nodes().stream().filter(n -> n.kind().equals(kind)).findFirst().orElseThrow(); }
    Candidate edit(SourceBundle b, Analysis a, GraphNode n, String op, EditPayload p) { return engine.propose(b, a, new EditCommand(b.revisionId(), a.id(), n.methodId(), n.id(), op, p, "semantic_edit")); }
    void fails(String code, Runnable r) { assertEquals(code, assertThrows(EngineException.class, r::run).code()); }

    @Test void movesBothDirectionsPreservingExactSelectedTextAndAllOtherSource() {
        SourceBundle b = bundle("a(/*inside*/); // anchored\n b(); c();"); Analysis a = engine.inspect(b);
        GraphNode first = node(a, "a(/*inside*/);"), last = node(a, "c();");
        Candidate forward = edit(b,a,first,"move_statement",new MoveStatement(last.id(),"after"));
        assertEquals(b.files().get("Main.java").replace("a(/*inside*/); // anchored\n b(); c();", " // anchored\n b(); c();\na(/*inside*/);\n"), forward.files().get("Main.java"));
        Candidate backward = edit(b,a,last,"move_statement",new MoveStatement(first.id(),"before"));
        assertEquals(b.files().get("Main.java").replace("a(/*inside*/); // anchored\n b(); c();", "\nc();\na(/*inside*/); // anchored\n b(); "), backward.files().get("Main.java"));
        assertEquals(b.files().get("Keep.java"), forward.files().get("Keep.java"));
        assertEquals("not_requested", forward.compileStatus()); assertEquals("unverified", forward.verificationStatus());
        assertEquals(1, forward.changes().size());
    }

    @Test void rejectsSelfNoopOtherBlocksMethodsAndStaleDestination() {
        SourceBundle b = bundle("a();b();if(ok){c();}"); Analysis a=engine.inspect(b);
        GraphNode first=node(a,"a();"), second=node(a,"b();"), nested=node(a,"c();");
        fails("INVALID_EDIT",()->edit(b,a,first,"move_statement",new MoveStatement(first.id(),"before")));
        fails("INVALID_EDIT",()->edit(b,a,first,"move_statement",new MoveStatement(second.id(),"before")));
        fails("INVALID_EDIT",()->edit(b,a,second,"move_statement",new MoveStatement(first.id(),"after")));
        fails("UNSUPPORTED_OPERATION",()->edit(b,a,first,"move_statement",new MoveStatement(nested.id(),"after")));
        fails("ANALYSIS_CONFLICT",()->edit(b,a,first,"move_statement",new MoveStatement(engine.inspect(b).graph().nodes().getFirst().id(),"after")));
        fails("INVALID_EDIT",()->edit(b,a,first,"move_statement",new MoveStatement(second.id(),"body_end")));
        SourceBundle two=new SourceBundle("base",Map.of("Main.java","class Main{void f(){a();}void g(){b();}}")); Analysis both=engine.inspect(two);
        fails("ANALYSIS_CONFLICT",()->edit(two,both,node(both,"a();"),"move_statement",new MoveStatement(node(both,"b();").id(),"after")));
    }

    @Test void duplicateStatementsUseIdentityForBothSourceAndDestinationIndices() {
        SourceBundle b=bundle("a(); b(); a();"); Analysis a=engine.inspect(b);
        var duplicates=a.graph().nodes().stream().filter(n->n.label().equals("a();")).sorted(Comparator.comparingInt(n->n.sourceRange().startOffset())).toList();
        GraphNode middle=node(a,"b();");
        Candidate moved=edit(b,a,duplicates.getLast(),"move_statement",new MoveStatement(middle.id(),"before"));
        assertEquals(b.files().get("Main.java").replace("a(); b(); a();","a(); \na();\nb(); "),moved.files().get("Main.java"));
        Candidate destination=edit(b,a,middle,"move_statement",new MoveStatement(duplicates.getLast().id(),"after"));
        assertTrue(destination.files().get("Main.java").contains("a();  a();\nb();\n"));
        fails("INVALID_EDIT",()->edit(b,a,middle,"move_statement",new MoveStatement(duplicates.getLast().id(),"before")));
    }

    @Test void wrapsExactTokenSpanWithCommentsAndReparsesIfAndWhile() {
        SourceBundle b=bundle("a(/* keep */); // outside\n"); Analysis a=engine.inspect(b); GraphNode n=node(a,"a(/* keep */);");
        for(String op:List.of("wrap_if","wrap_while")) {
            Candidate c=edit(b,a,n,op,new WrapStatement("ok && test()"));
            assertEquals(b.files().get("Main.java").replace("a(/* keep */);",(op.equals("wrap_if")?"if":"while")+" (ok && test()) {\na(/* keep */);\n}"),c.files().get("Main.java"));
            assertEquals("valid",engine.inspect(new SourceBundle("next",c.files())).parseStatus());
            assertEquals(b.files().get("Keep.java"),c.files().get("Keep.java"));
        }
    }

    @Test void wrapperRejectsConditionEscapesMalformedUnicodeAndNoncanonicalText() {
        SourceBundle b=bundle("a();"); Analysis a=engine.inspect(b); GraphNode n=node(a,"a();");
        for(String condition:List.of("", "true) {} if (true", "true) {evil();} else if(true", "true\r", "\uFEFFtrue", "\uD800"))
            fails("INVALID_EDIT",()->edit(b,a,n,"wrap_if",new WrapStatement(condition)));
        fails("INVALID_EDIT",()->edit(b,a,n,"wrap_if",new DeleteStatement()));
    }

    @Test void whileCannotCaptureExternalBreakOrContinueEvenThroughSwitch() {
        SourceBundle b=bundle("while(ok){if(ok){continue;} if(ok){break;} switch(1){default:continue;}}"); Analysis a=engine.inspect(b);
        for(GraphNode n:a.graph().nodes().stream().filter(n->n.kind().equals("IfStmt")||n.kind().equals("SwitchStmt")).toList()) {
            assertTrue(n.allowedOperations().contains("wrap_if")); assertFalse(n.allowedOperations().contains("wrap_while"));
            fails("UNSUPPORTED_OPERATION",()->edit(b,a,n,"wrap_while",new WrapStatement("ok")));
        }
    }

    @Test void whileAllowsInternalLoopJumpsAndInternalSwitchBreak() {
        for(String statement:List.of("while(ok){if(ok)continue;break;}","switch(1){default:break;}")) {
            SourceBundle b=bundle(statement); Analysis a=engine.inspect(b); GraphNode n=kind(a,statement.startsWith("while")?"WhileStmt":"SwitchStmt");
            assertTrue(n.allowedOperations().contains("wrap_while"));
            assertEquals("valid",edit(b,a,n,"wrap_while",new WrapStatement("ok")).parseStatus());
        }
    }

    @Test void whileRejectsBareBreakAndCompoundBlockWithOuterContinue() {
        SourceBundle b=bundle("while(ok){break; {switch(1){default:continue;}}}"); Analysis a=engine.inspect(b);
        GraphNode jump=kind(a,"BreakStmt");
        assertFalse(jump.allowedOperations().contains("wrap_while"));
        fails("UNSUPPORTED_OPERATION",()->edit(b,a,jump,"wrap_while",new WrapStatement("ok")));
        GraphNode block=a.graph().nodes().stream().filter(n->n.kind().equals("block") && n.allowedOperations().contains("wrap_if") && n.label().startsWith("{switch")).findFirst().orElseThrow();
        assertFalse(block.allowedOperations().contains("wrap_while"));
        fails("UNSUPPORTED_OPERATION",()->edit(b,a,block,"wrap_while",new WrapStatement("ok")));
    }

    @Test void addsOneBracedElseAndRemovesOnlyExactBranchSpan() {
        SourceBundle b=bundle("if(ok){a();} /* retained */ b();"); Analysis a=engine.inspect(b); GraphNode n=kind(a,"IfStmt");
        Candidate added=edit(b,a,n,"add_else",new AddElse("{\n// inside new branch\nb();\n}"));
        assertEquals(b.files().get("Main.java").replace("if(ok){a();}","if(ok){a();}\nelse {\n// inside new branch\nb();\n}\n"),added.files().get("Main.java"));
        SourceBundle empty=bundle("if(ok){/*then*/a();} /* keep */ else {b();} // outside\n"); Analysis e=engine.inspect(empty); GraphNode branch=kind(e,"IfStmt");
        Candidate removed=edit(empty,e,branch,"remove_else",new RemoveElse());
        assertEquals(empty.files().get("Main.java").replace("else {b();}",""),removed.files().get("Main.java"));
        assertTrue(edit(b,a,n,"add_else",new AddElse("{}" )).files().get("Main.java").contains("else {}"));
    }

    @Test void elseRejectsUnbracedBodiesMultipleBlocksAndCommentLoss() {
        SourceBundle b=bundle("if(ok){a();}"); Analysis a=engine.inspect(b); GraphNode n=kind(a,"IfStmt");
        for(String source:List.of("a();", "{} {}", "{a();} b();", "{if(ok)break;}")) fails("INVALID_EDIT",()->edit(b,a,n,"add_else",new AddElse(source)));
        for(String statement:List.of("if(ok)a();", "if(ok){a();}else b();", "if(ok){a();}else /*keep*/ {b();}","if(ok){a();}else {b(/*keep*/);}")) {
            SourceBundle other=bundle(statement); Analysis analysis=engine.inspect(other); GraphNode branch=kind(analysis,"IfStmt");
            assertFalse(branch.allowedOperations().contains("remove_else"));
            fails("UNSUPPORTED_OPERATION",()->edit(other,analysis,branch,"remove_else",new RemoveElse()));
            assertFalse(branch.allowedOperations().contains("add_else"));
        }
    }

    @Test void opaqueUnbracedAndProjectionNodesNeverAdvertiseNewStructuralEdits() {
        for(String body:List.of("synchronized(this){}","for(int i=0;i<2;i++)a();")) {
            Analysis a=engine.inspect(bundle(body));
            for(GraphNode n:a.graph().nodes()) if(body.startsWith("synchronized")||n.kind().equals("for_init")||n.kind().equals("for_update")||n.kind().equals("expression")||n.kind().equals("ExpressionStmt")) {
                assertFalse(n.allowedOperations().contains("move_statement")); assertFalse(n.allowedOperations().contains("wrap_if"));
            }
        }
    }
}
