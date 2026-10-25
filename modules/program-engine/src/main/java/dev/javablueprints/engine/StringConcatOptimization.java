package dev.javablueprints.engine;

import com.github.javaparser.ast.*;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import dev.javablueprints.engine.EngineModel.*;
import java.util.*;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * OPT-STRBUILD-001: a closed local String accumulator ({@code s = s + a + b;} / {@code s += a;}) inside one loop
 * is redirected into one java.lang.StringBuilder created right before the loop and copied back right after it.
 * Every precondition is syntactic plus exact symbol/type facts; anything unknown makes the rule unavailable.
 */
final class StringConcatOptimization {
    static final String RULE_ID = "OPT-STRBUILD-001";
    static final String OPERATION = "optimize_string_builder";
    /** Static operand type -> the StringBuilder.append overload that string conversion must select. */
    private static final Map<String,String> APPEND = Map.ofEntries(
            Map.entry("char","char"), Map.entry("int","int"), Map.entry("short","int"), Map.entry("byte","int"),
            Map.entry("long","long"), Map.entry("float","float"), Map.entry("double","double"), Map.entry("boolean","boolean"),
            Map.entry("java.lang.String","java.lang.String"),
            Map.entry("java.lang.Character","java.lang.Object"), Map.entry("java.lang.Integer","java.lang.Object"),
            Map.entry("java.lang.Short","java.lang.Object"), Map.entry("java.lang.Byte","java.lang.Object"),
            Map.entry("java.lang.Long","java.lang.Object"), Map.entry("java.lang.Float","java.lang.Object"),
            Map.entry("java.lang.Double","java.lang.Object"), Map.entry("java.lang.Boolean","java.lang.Object"));
    private static final List<String> ASSUMPTIONS = List.of(
            "Локальная String-переменная внутри цикла только дописывается (s = s + a + b; или s += a;) и больше нигде в цикле не читается и не пишется; до цикла она получает ненулевое значение.",
            "Операнды остаются на месте и вычисляются в том же порядке и столько же раз; их типы — примитивы, обёртки или String, поэтому StringBuilder.append даёт те же символы, что и конкатенация (null → \"null\").",
            "Переводы строк не добавляются и не удаляются: номера строк исходника и стеков исключений сохраняются.",
            "После цикла значение копируется обратно только если что-то дописано (каждое дописывание доказуемо непустое), поэтому совпадает и содержимое, и идентичность строки при нуле итераций.",
            "Нет try/catch вокруг или внутри цикла, лямбд, локальных/анонимных классов и меток: частично дописанный буфер при исключении не наблюдаем.",
            "Расход памяти и момент OutOfMemoryError могут отличаться; ускорение не измерено. Применение требует сравнения версий на тестах.");
    private StringConcatOptimization() {}

    record Result(Graph graph, List<OptimizationOpportunity> opportunities, Map<String,Plan> plans) {}
    record Call(int startOffset, int endOffset, String parameter) {}
    record Rewrite(TextChange change, String name, int declarationEnd, List<Call> calls) {}
    record Append(SourceRange statement, List<SourceRange> operands, List<String> parameters) {}
    record Plan(GraphNode node, SourceRange loop, String variable, String name, List<Append> appends) {
        Rewrite rewrite(SourceBundle bundle) {
            // No newline is added or removed: every original line (and so every stack-trace line) keeps its number.
            String source=bundle.files().get(loop.filePath());
            int start=loop.startOffset();
            var out=new StringBuilder("StringBuilder "+name+" = new StringBuilder("+variable+");");
            int declarationEnd=start+out.length();
            out.append(' ');
            var calls=new ArrayList<Call>();
            int cursor=start;
            for(var append:appends) {
                out.append(source,cursor,append.statement().startOffset());
                int chain=start+out.length();
                out.append(name);
                for(int i=0;i<append.operands().size();i++) {
                    var operand=append.operands().get(i);
                    out.append(".append(").append(source,operand.startOffset(),operand.endOffset()).append(')');
                    calls.add(new Call(chain,start+out.length(),append.parameters().get(i)));
                }
                out.append(';');
                cursor=append.statement().endOffset();
            }
            out.append(source,cursor,loop.endOffset());
            out.append(" if (").append(name).append(".length() != ").append(variable)
                    .append(".length()) ").append(variable).append(" = ").append(name).append(".toString();");
            return new Rewrite(new TextChange(loop.filePath(),start,loop.endOffset(),source.substring(start,loop.endOffset()),out.toString()),
                    name,declarationEnd,List.copyOf(calls));
        }
        OptimizationOpportunity opportunity() {
            return new OptimizationOpportunity(RULE_ID,"1",node.id(),node.methodId(),variable,appends.size(),node.sourceRange(),ASSUMPTIONS);
        }
    }

    private record Key(String file, int start, int end) {
        static Key of(SourceRange range) { return new Key(range.filePath(),range.startOffset(),range.endOffset()); }
    }
    private static final class Facts {
        final Map<Key,Reference> references=new HashMap<>();
        final Map<Key,Symbol> names=new HashMap<>();
        final Map<String,Symbol> symbols=new HashMap<>();
        final Function<Node,SourceRange> range;
        int visits;
        Facts(SemanticModel semantics, Function<Node,SourceRange> range) {
            Map<Node,SourceRange> cached=new IdentityHashMap<>();
            this.range=node->cached.computeIfAbsent(node,range);
            for(var reference:semantics.references()) references.put(Key.of(reference.sourceRange()),reference);
            for(var symbol:semantics.symbols()) {
                symbols.put(symbol.id(),symbol);
                if(!symbol.external()&&symbol.sourceRange()!=null) names.put(Key.of(symbol.sourceRange()),symbol);
            }
        }
        Symbol local(NameExpr use) {
            var reference=references.get(Key.of(range.apply(use)));
            if(reference==null||!reference.resolution().equals("exact")||reference.targetIds().size()!=1)return null;
            var symbol=symbols.get(reference.targetIds().getFirst());
            return symbol!=null&&!symbol.external()&&symbol.kind().equals("local")?symbol:null;
        }
    }
    /** One accumulation statement: the target, the left-spine read of the same name, and appended operands. */
    private record Accumulation(ExpressionStmt statement, NameExpr target, NameExpr read, List<Expression> operands) {}

    static Result inspect(Graph graph, Map<String,Node> bindings, SemanticModel semantics,
                          Collection<CompilationUnit> units, Function<Node,SourceRange> range) {
        var facts=new Facts(semantics,range);
        var names=new HashSet<String>();
        for(var unit:units)for(var name:unit.findAll(SimpleName.class))names.add(name.asString());
        String name="jbText";int suffix=2;while(names.contains(name))name="jbText"+(suffix++);
        var plans=new LinkedHashMap<String,Plan>();int examined=0;
        for(var node:graph.nodes()) {
            if(!node.allowedOperations().contains("insert_statement"))continue;
            Node bound=bindings.get(node.id());
            if(!(bound instanceof ForStmt||bound instanceof ForEachStmt||bound instanceof WhileStmt||bound instanceof DoStmt))continue;
            if(++examined>1024||facts.visits>400_000)break;
            Plan plan;
            try { plan=prove(node,(Statement)bound,name,facts); }
            catch(RuntimeException|StackOverflowError unknown) { plan=null; }
            if(plan!=null)plans.put(node.id(),plan);
        }
        var nodes=graph.nodes().stream().map(node->{
            if(!plans.containsKey(node.id()))return node;
            var operations=new ArrayList<>(node.allowedOperations());operations.add(OPERATION);
            return new GraphNode(node.id(),node.revisionId(),node.analysisId(),node.methodId(),node.kind(),node.label(),node.sourceRange(),node.astBinding(),node.parentId(),node.synthetic(),node.editableFields(),node.editableFieldRanges(),operations,node.insertionPositions(),node.executionRole());
        }).toList();
        return new Result(new Graph(graph.revisionId(),graph.analysisId(),graph.sourceMapVersion(),graph.methods(),nodes,graph.edges(),graph.initializerContexts(),graph.initializationOrders()),
                plans.values().stream().map(Plan::opportunity).toList(),Map.copyOf(plans));
    }

    private static Plan prove(GraphNode node, Statement loop, String generated, Facts facts) {
        if(!(loop.getParentNode().orElse(null) instanceof BlockStmt block))return null;
        var callable=loop.findAncestor(CallableDeclaration.class).orElse(null);
        if(callable==null)return null;
        // Captures, labels, monitors and nested classes are outside this closed proof.
        if(callable.findFirst(Node.class,n->n instanceof LambdaExpr||n instanceof MethodReferenceExpr||n instanceof LocalClassDeclarationStmt
                ||n instanceof LocalRecordDeclarationStmt||n instanceof LabeledStmt||n instanceof SynchronizedStmt
                ||n instanceof ObjectCreationExpr creation&&creation.getAnonymousClassBody().isPresent()).isPresent())return null;
        // A handler could observe the accumulator after a partial append; refuse any try around or inside the loop.
        for(Node cursor=loop;cursor!=null&&cursor!=callable;cursor=cursor.getParentNode().orElse(null))
            if(cursor instanceof TryStmt||cursor instanceof CatchClause)return null;
        if(loop.findFirst(TryStmt.class).isPresent())return null;
        var groups=new LinkedHashMap<String,List<Accumulation>>();
        for(var statement:loop.findAll(ExpressionStmt.class)) {
            if(++facts.visits>400_000)return null;
            var accumulation=accumulation(statement);
            if(accumulation!=null)groups.computeIfAbsent(accumulation.target().getNameAsString(),k->new ArrayList<>()).add(accumulation);
        }
        int loopIndex=block.getStatements().indexOf(loop);
        for(var entry:groups.entrySet()) {
            Plan plan=prove(node,loop,block,loopIndex,entry.getKey(),entry.getValue(),generated,facts);
            if(plan!=null)return plan;
        }
        return null;
    }

    private static Plan prove(GraphNode node, Statement loop, BlockStmt block, int loopIndex, String variable,
                              List<Accumulation> accumulations, String generated, Facts facts) {
        Symbol symbol=facts.local(accumulations.getFirst().target());
        if(symbol==null||!"java.lang.String".equals(symbol.resolvedType()))return null;
        int declaredAt=-1;Expression initializer=null;
        for(int i=0;i<loopIndex&&declaredAt<0;i++)
            if(block.getStatement(i) instanceof ExpressionStmt statement&&statement.getExpression() instanceof VariableDeclarationExpr variables)
                for(var declarator:variables.getVariables())
                    if(symbol.equals(facts.names.get(Key.of(facts.range.apply(declarator.getName()))))) {
                        declaredAt=i;initializer=declarator.getInitializer().orElse(null);
                    }
        if(declaredAt<0||!nonNullString(initializer))return null;
        // Between declaration and loop the value must stay the proven non-null initializer.
        for(int i=declaredAt+1;i<loopIndex;i++)
            if(mentions(block.getStatement(i),variable))return null;
        // Inside the loop: every mention of the name is an accumulation target or its left-spine read.
        var allowed=Collections.newSetFromMap(new IdentityHashMap<Node,Boolean>());
        for(var accumulation:accumulations) {
            allowed.add(accumulation.target());allowed.add(accumulation.read());
            if(!symbol.equals(facts.local(accumulation.target()))||!symbol.equals(facts.local(accumulation.read())))return null;
        }
        for(var use:loop.findAll(NameExpr.class)) {
            if(++facts.visits>400_000)return null;
            if(use.getNameAsString().equals(variable)&&!allowed.contains(use))return null;
        }
        if(loop.findAll(SimpleName.class).stream().anyMatch(n->n.asString().equals(variable)&&!(n.getParentNode().orElse(null) instanceof NameExpr use&&allowed.contains(use))))return null;
        var appends=new ArrayList<Append>();
        for(var accumulation:accumulations) {
            if(!accumulation.statement().getAllContainedComments().isEmpty())return null;
            // Line preservation: the dropped "s = s +" / "+" separators must not contain line breaks.
            var statementRange=accumulation.statement().getRange().orElse(null);
            if(statementRange==null)return null;
            int operandBreaks=0;
            for(var operand:accumulation.operands()) {
                var r=operand.getRange().orElse(null);
                if(r==null)return null;
                operandBreaks+=r.end.line-r.begin.line;
            }
            if(operandBreaks!=statementRange.end.line-statementRange.begin.line)return null;
            var operands=new ArrayList<SourceRange>();var parameters=new ArrayList<String>();boolean nonEmpty=false;
            for(var operand:accumulation.operands()) {
                String type=type(operand);
                String parameter=type==null?null:APPEND.get(type);
                if(parameter==null)return null;
                Expression inner=operand;while(inner instanceof EnclosedExpr enclosed)inner=enclosed.getInner();
                if(!type.equals("java.lang.String")||inner instanceof StringLiteralExpr literal&&!literal.getValue().isEmpty())nonEmpty=true;
                operands.add(facts.range.apply(operand));parameters.add(parameter);
            }
            if(!nonEmpty)return null;
            appends.add(new Append(facts.range.apply(accumulation.statement()),List.copyOf(operands),List.copyOf(parameters)));
        }
        appends.sort(Comparator.comparingInt(append->append.statement().startOffset()));
        SourceRange loopRange=facts.range.apply(loop);
        if(!loopRange.equals(node.sourceRange()))return null;
        return new Plan(node,loopRange,variable,generated,List.copyOf(appends));
    }

    private static Accumulation accumulation(ExpressionStmt statement) {
        if(!(statement.getExpression() instanceof AssignExpr assign)||!(assign.getTarget() instanceof NameExpr target))return null;
        if(assign.getOperator()==AssignExpr.Operator.PLUS) {
            // s += e is s = (String)(s + (e)): e keeps its own static type as one operand.
            return new Accumulation(statement,target,target,List.of(assign.getValue()));
        }
        if(assign.getOperator()!=AssignExpr.Operator.ASSIGN)return null;
        var operands=new ArrayDeque<Expression>();
        Expression cursor=assign.getValue();
        while(cursor instanceof BinaryExpr binary&&binary.getOperator()==BinaryExpr.Operator.PLUS) {
            operands.addFirst(binary.getRight());cursor=binary.getLeft();
        }
        if(operands.isEmpty()||!(cursor instanceof NameExpr read)||!read.getNameAsString().equals(target.getNameAsString()))return null;
        return new Accumulation(statement,target,read,List.copyOf(operands));
    }

    private static boolean nonNullString(Expression initializer) {
        if(initializer instanceof StringLiteralExpr||initializer instanceof TextBlockLiteralExpr)return true;
        // A String-typed + is a string concatenation; its result is a new, never-null String.
        return initializer instanceof BinaryExpr binary&&binary.getOperator()==BinaryExpr.Operator.PLUS
                &&"java.lang.String".equals(type(binary));
    }
    private static boolean mentions(Node node,String variable) {
        return node.findFirst(SimpleName.class,n->n.asString().equals(variable)).isPresent();
    }
    /** Static type of an operand when its overload choice cannot depend on the new argument position. */
    private static String type(Expression expression) {
        Expression inner=expression;while(inner instanceof EnclosedExpr enclosed)inner=enclosed.getInner();
        if(inner instanceof ConditionalExpr||inner instanceof SwitchExpr||inner instanceof NullLiteralExpr
                ||inner instanceof LambdaExpr||inner instanceof MethodReferenceExpr)return null;
        if(inner instanceof MethodCallExpr call) {
            var method=attempt(call::resolve);
            if(method==null||method.getTypeParameters().size()!=0)return null;
        }
        final Expression typed=inner;
        var resolved=attempt(()->typed.calculateResolvedType().describe());
        return resolved;
    }
    private static <T> T attempt(Supplier<T> action) {
        try { return action.get(); }
        catch(RuntimeException|StackOverflowError unknown) { return null; }
    }

    static boolean validCandidate(Analysis candidate, Rewrite rewrite) {
        if(candidate.semantics()==null)return false;
        var symbols=new HashMap<String,Symbol>();
        candidate.semantics().symbols().forEach(symbol->symbols.put(symbol.id(),symbol));
        String file=rewrite.change().filePath();int start=rewrite.change().startOffset();
        var locals=candidate.semantics().symbols().stream().filter(symbol->!symbol.external()&&symbol.kind().equals("local")
                &&symbol.name().equals(rewrite.name())&&symbol.sourceRange()!=null&&symbol.sourceRange().filePath().equals(file)
                &&symbol.sourceRange().startOffset()>=start&&symbol.sourceRange().endOffset()<=rewrite.declarationEnd()).toList();
        if(locals.size()!=1||!"java.lang.StringBuilder".equals(locals.getFirst().resolvedType()))return false;
        boolean constructor=candidate.semantics().references().stream().anyMatch(reference->reference.sourceRange().filePath().equals(file)
                &&reference.sourceRange().startOffset()>=start&&reference.sourceRange().endOffset()<=rewrite.declarationEnd()
                &&jdk(reference,symbols,"constructor","java.lang.StringBuilder.StringBuilder(java.lang.String)"));
        if(!constructor)return false;
        var calls=new HashMap<Key,Reference>();
        for(var reference:candidate.semantics().references())
            if(reference.kind().equals("call")&&reference.sourceRange().filePath().equals(file))calls.put(Key.of(reference.sourceRange()),reference);
        for(var call:rewrite.calls()) {
            var reference=calls.get(new Key(file,call.startOffset(),call.endOffset()));
            if(!jdk(reference,symbols,"method","java.lang.StringBuilder.append("+call.parameter()+")"))return false;
        }
        return true;
    }
    private static boolean jdk(Reference reference, Map<String,Symbol> symbols, String kind, String signature) {
        if(reference==null||!reference.resolution().equals("exact")||reference.targetIds().size()!=1)return false;
        var symbol=symbols.get(reference.targetIds().getFirst());
        return symbol!=null&&symbol.external()&&symbol.kind().equals(kind)&&signature.equals(symbol.signature());
    }
}
