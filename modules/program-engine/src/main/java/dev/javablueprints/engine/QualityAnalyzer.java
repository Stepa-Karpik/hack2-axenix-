package dev.javablueprints.engine;

import com.github.javaparser.JavaToken;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import dev.javablueprints.engine.EngineModel.*;
import java.util.*;
import java.util.function.Function;

/** Bounded syntactic facts. Never estimates execution time or authorizes a transformation. */
final class QualityAnalyzer {
    private static final int MAX_FINDINGS = 400;
    private QualityAnalyzer() {}

    static QualityModel inspect(String analysisId, Map<Node,String> declarations, List<Method> methods,
                                Function<Node,SourceRange> range) {
        var callables = new HashMap<String,CallableDeclaration<?>>();
        declarations.forEach((node,id) -> { if (node instanceof CallableDeclaration<?> callable) callables.put(id,callable); });
        var metrics = new ArrayList<MethodMetrics>();
        var findings = new ArrayList<CodeFinding>();
        int proposed = 0;
        for (Method method : methods) {
            var callable = callables.get(method.declarationId());
            BlockStmt body = callable instanceof MethodDeclaration m ? m.getBody().orElse(null)
                    : callable instanceof ConstructorDeclaration c ? c.getBody() : null;
            if (body == null) continue;
            var counts = count(body);
            SourceRange bodyRange = range.apply(body);
            metrics.add(new MethodMetrics(method.id(),method.declarationId(),method.entryNodeId(),method.sourceRange(),
                    bodyRange.endLine()-bodyRange.startLine()+1,counts.lines.cardinality(),counts.statements,counts.branches,
                    counts.nesting,counts.loops,counts.loopNesting,counts.calls,"unknown","bounds_and_call_costs_unproven"));
            var pending = new ArrayList<CodeFinding>();
            if (counts.lines.cardinality() >= 40) pending.add(finding(analysisId,method,"LONG_METHOD","Длинный метод",
                    "В теле метода много строк с кодом.","Рассмотрите выделение самостоятельных шагов в методы.",
                    "Меньше деталей при чтении одного метода.",counts.lines.cardinality(),40,range.apply(callable.getName())));
            if (counts.nesting >= 4) pending.add(finding(analysisId,method,"DEEP_NESTING","Глубокая вложенность",
                    "Несколько управляющих конструкций вложены друг в друга.","Проверьте, можно ли упростить ветвления или выделить отдельный шаг.",
                    "Проще проследить условия выполнения.",counts.nesting,4,range.apply(counts.deepest)));
            if (counts.loopNesting >= 2) pending.add(finding(analysisId,method,"NESTED_LOOPS","Вложенные циклы",
                    "Один цикл находится внутри другого; число итераций и стоимость тела пока неизвестны.","Проверьте границы циклов и повторяющиеся вычисления на реальных данных.",
                    "Помогает выбрать участок для замеров; ускорение не гарантируется.",counts.loopNesting,2,range.apply(counts.deepestLoop)));
            if (counts.branches >= 10) pending.add(finding(analysisId,method,"HIGH_BRANCHING","Много ветвлений",
                    "Синтаксический показатель ветвления достиг порога; это не оценка времени выполнения.","Проверьте покрытие разных веток тестами и разделение ответственности.",
                    "Проще проверять и сопровождать варианты поведения.",counts.branches,10,range.apply(callable.getName())));
            proposed += pending.size();
            for (var finding : pending) if (findings.size() < MAX_FINDINGS) findings.add(finding);
        }
        return new QualityModel("quality-v1",metrics,findings,proposed>findings.size());
    }

    private static CodeFinding finding(String analysis, Method method, String code, String title, String explanation,
                                       String recommendation, String effect, int observed, int threshold, SourceRange range) {
        return new CodeFinding(analysis+":quality:"+method.id()+":"+code,method.id(),method.entryNodeId(),"info",code,
                title,explanation,recommendation,effect,observed,threshold,range);
    }

    private static final class Counts {
        int statements, branches=1, nesting, loops, loopNesting, calls;
        Node deepest, deepestLoop;
        final BitSet lines = new BitSet();
    }
    private record Visit(Node node, int nesting, int loops) {}
    private static Counts count(BlockStmt body) {
        var counts = new Counts();
        Set<JavaToken> excluded = Collections.newSetFromMap(new IdentityHashMap<>());
        var pending = new ArrayDeque<Visit>(); pending.push(new Visit(body,0,0));
        while (!pending.isEmpty()) {
            var visit = pending.pop(); var node = visit.node();
            if (node instanceof BodyDeclaration<?> || node instanceof LocalClassDeclarationStmt || node instanceof LambdaExpr) {
                node.getTokenRange().ifPresent(tokens -> tokens.forEach(excluded::add));
                continue;
            }
            boolean loop = node instanceof ForStmt || node instanceof ForEachStmt || node instanceof WhileStmt || node instanceof DoStmt;
            boolean control = loop || node instanceof IfStmt || node instanceof SwitchStmt || node instanceof SwitchExpr
                    || node instanceof TryStmt || node instanceof CatchClause || node instanceof SynchronizedStmt;
            int nesting = visit.nesting()+(control?1:0), loops = visit.loops()+(loop?1:0);
            if (nesting>counts.nesting) { counts.nesting=nesting; counts.deepest=node; }
            if (loops>counts.loopNesting) { counts.loopNesting=loops; counts.deepestLoop=node; }
            if (node instanceof Statement && !(node instanceof BlockStmt) && !(node instanceof EmptyStmt)) counts.statements++;
            if (loop) counts.loops++;
            if (loop || node instanceof IfStmt || node instanceof ConditionalExpr || node instanceof CatchClause
                    || node instanceof SwitchEntry entry && !entry.isDefault()
                    || node instanceof BinaryExpr binary && (binary.getOperator()==BinaryExpr.Operator.AND || binary.getOperator()==BinaryExpr.Operator.OR)) counts.branches++;
            if (node instanceof MethodCallExpr || node instanceof ObjectCreationExpr || node instanceof ExplicitConstructorInvocationStmt) counts.calls++;
            var children = node.getChildNodes();
            for (int i=children.size()-1;i>=0;i--) pending.push(new Visit(children.get(i),nesting,loops));
        }
        for (JavaToken token : body.getTokenRange().orElseThrow()) {
            if (!excluded.contains(token) && !token.getCategory().isComment() && !token.getText().isBlank())
                token.getRange().ifPresent(at -> counts.lines.set(at.begin.line,at.end.line+1));
        }
        return counts;
    }
}
