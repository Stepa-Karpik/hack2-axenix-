package dev.javablueprints.engine;

import com.github.javaparser.ast.*;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import dev.javablueprints.engine.EngineModel.*;
import java.util.*;
import java.util.function.Function;

/** Closed local String-membership rule. Unknown dependencies make the rule unavailable. */
final class MembershipOptimization {
    private static final String LIST = "java.util.ArrayList<java.lang.String>";
    private static final String SET = "java.util.HashSet<java.lang.String>";
    private static final List<String> ASSUMPTIONS = List.of(
            "Создаётся отдельный HashSet; исходный список и порядок запросов сохраняются.",
            "Индекс требует дополнительной памяти. Равенство при нехватке ресурсов и наблюдении времени не доказано.",
            "Выигрыш зависит от размеров данных; ускорение не измерено. Применение требует сравнения версий на тестах.");
    private MembershipOptimization() {}
    record Result(Graph graph, List<OptimizationOpportunity> opportunities, Map<String,Plan> plans) {}
    record Rewrite(TextChange change, String name, int initializerEnd) {}
    record Plan(GraphNode node, String receiver, List<SourceRange> queries, String name) {
        Rewrite rewrite(SourceBundle bundle) {
            var at=node.sourceRange(); String source=bundle.files().get(at.filePath());
            String before=source.substring(at.startOffset(),at.endOffset());
            var replaced=new StringBuilder(before);
            queries.stream().sorted(Comparator.comparingInt(SourceRange::startOffset).reversed()).forEach(use ->
                    replaced.replace(use.startOffset()-at.startOffset(),use.endOffset()-at.startOffset(),name));
            int line=source.lastIndexOf('\n',Math.max(0,at.startOffset()-1))+1;
            String indent=source.substring(line,at.startOffset());
            if(!indent.isBlank()) indent="";
            String index="java.util.HashSet<java.lang.String> "+name+" = new java.util.HashSet<>("+receiver+");";
            return new Rewrite(new TextChange(at.filePath(),at.startOffset(),at.endOffset(),before,index+"\n"+indent+replaced),
                    name,at.startOffset()+index.length());
        }
        OptimizationOpportunity opportunity() {
            return new OptimizationOpportunity("OPT-MEMBERSHIP-001","1",node.id(),node.methodId(),receiver,queries.size(),node.sourceRange(),ASSUMPTIONS);
        }
    }
    private record Key(String file, int start, int end) {
        static Key of(SourceRange range) { return new Key(range.filePath(),range.startOffset(),range.endOffset()); }
    }
    private static final class Facts {
        final SemanticModel semantics;
        final Map<Key,Reference> references=new HashMap<>();
        final Map<Key,Symbol> names=new HashMap<>();
        final Map<String,Symbol> symbols=new HashMap<>();
        final Function<Node,SourceRange> range;
        int proofVisits;
        Facts(SemanticModel semantics, Function<Node,SourceRange> range) {
            this.semantics=semantics;
            Map<Node,SourceRange> cached=new IdentityHashMap<>();
            this.range=node->cached.computeIfAbsent(node,range);
            for(var reference:semantics.references()) references.put(Key.of(reference.sourceRange()),reference);
            for(var symbol:semantics.symbols()) {
                symbols.put(symbol.id(),symbol);
                if(!symbol.external() && symbol.sourceRange()!=null) names.put(Key.of(symbol.sourceRange()),symbol);
            }
        }
        Reference reference(Node node) { return references.get(Key.of(range.apply(node))); }
        boolean target(NameExpr use, Symbol symbol) {
            var reference=reference(use);
            return reference!=null&&reference.resolution().equals("exact")&&reference.targetIds().equals(List.of(symbol.id()));
        }
        boolean constructor(ObjectCreationExpr creation, String owner) {
            var reference=reference(creation);
            return standardConstructor(reference,symbols,owner);
        }
        boolean string(Expression query) {
            while(query instanceof EnclosedExpr enclosed)query=enclosed.getInner();
            if(query instanceof StringLiteralExpr || query instanceof NullLiteralExpr) return true;
            if(!(query instanceof NameExpr name))return false;
            var reference=reference(name);
            if(reference==null||!reference.resolution().equals("exact")||!"java.lang.String".equals(reference.resolvedType())||reference.targetIds().size()!=1)return false;
            var symbol=symbols.get(reference.targetIds().getFirst());
            return symbol!=null&&!symbol.external()&&Set.of("local","parameter").contains(symbol.kind())&&"java.lang.String".equals(symbol.resolvedType());
        }
    }

    static Result inspect(Graph graph, Map<String,Node> bindings, SemanticModel semantics,
                          Collection<CompilationUnit> units, Function<Node,SourceRange> range) {
        var facts=new Facts(semantics,range);
        var names=new HashSet<String>();
        for(var unit:units)for(var name:unit.findAll(SimpleName.class))names.add(name.asString());
        String name="jbMembership";int suffix=2;while(names.contains(name))name="jbMembership"+(suffix++);
        var plans=new LinkedHashMap<String,Plan>(); int examined=0;
        for(var node:graph.nodes()) {
            if(!node.allowedOperations().contains("insert_statement"))continue;
            Node bound=bindings.get(node.id());
            if(!(bound instanceof ForStmt || bound instanceof ForEachStmt || bound instanceof WhileStmt || bound instanceof DoStmt))continue;
            if(++examined>64)break;
            Plan plan=prove(node,(Statement)bound,name,facts);
            if(plan!=null)plans.put(node.id(),plan);
        }
        var nodes=graph.nodes().stream().map(node->{
            if(!plans.containsKey(node.id()))return node;
            var operations=new ArrayList<>(node.allowedOperations());operations.add("optimize_membership");
            return new GraphNode(node.id(),node.revisionId(),node.analysisId(),node.methodId(),node.kind(),node.label(),node.sourceRange(),node.astBinding(),node.parentId(),node.synthetic(),node.editableFields(),node.editableFieldRanges(),operations,node.insertionPositions(),node.executionRole());
        }).toList();
        return new Result(new Graph(graph.revisionId(),graph.analysisId(),graph.sourceMapVersion(),graph.methods(),nodes,graph.edges()),
                plans.values().stream().map(Plan::opportunity).toList(),Map.copyOf(plans));
    }

    private static Plan prove(GraphNode node, Statement loop, String generated, Facts facts) {
        if(facts.proofVisits>=100_000)return null;
        if(!(loop.getParentNode().orElse(null) instanceof BlockStmt body))return null;
        Node owner=body.getParentNode().orElse(null);
        if(!(owner instanceof MethodDeclaration method&&method.getBody().orElse(null)==body)
                &&!(owner instanceof ConstructorDeclaration constructor&&constructor.getBody()==body))return null;
        if(body.findAll(Node.class).stream().anyMatch(n->n instanceof TryStmt||n instanceof LabeledStmt||n instanceof LambdaExpr
                ||n instanceof LocalClassDeclarationStmt||n instanceof SynchronizedStmt||n instanceof MethodReferenceExpr
                ||n instanceof ObjectCreationExpr creation&&creation.getAnonymousClassBody().isPresent()))return null;
        if(body.findAll(MethodCallExpr.class).stream().anyMatch(call->Set.of("nanoTime","currentTimeMillis","freeMemory","totalMemory","maxMemory","gc","identityHashCode").contains(call.getNameAsString())))return null;
        int loopIndex=body.getStatements().indexOf(loop);
        var tried=new HashSet<String>();
        for(var possible:loop.findAll(MethodCallExpr.class)) {
            if(++facts.proofVisits>100_000)return null;
            if(!possible.getNameAsString().equals("contains")||possible.getArguments().size()!=1||!(possible.getScope().orElse(null) instanceof NameExpr receiver))continue;
            var ref=facts.reference(receiver);
            if(ref==null||!ref.resolution().equals("exact")||ref.targetIds().size()!=1)continue;
            var symbol=facts.symbols.get(ref.targetIds().getFirst());
            if(symbol==null||!symbol.kind().equals("local")||!LIST.equals(symbol.resolvedType()))continue;
            if(!tried.add(symbol.id()))continue;
            VariableDeclarator declaration=null;int declaredAt=-1;
            for(int i=0;i<loopIndex;i++)if(body.getStatement(i) instanceof ExpressionStmt statement&&statement.getExpression() instanceof VariableDeclarationExpr variables&&variables.getVariables().size()==1) {
                var candidate=variables.getVariable(0);
                if(symbol.equals(facts.names.get(Key.of(facts.range.apply(candidate.getName()))))) {declaration=candidate;declaredAt=i;break;}
            }
            if(declaration==null||!(declaration.getInitializer().orElse(null) instanceof ObjectCreationExpr creation)
                    ||!creation.getArguments().isEmpty()||creation.getAnonymousClassBody().isPresent()||!facts.constructor(creation,"java.util.ArrayList"))continue;
            var queries=new ArrayList<SourceRange>();boolean valid=true;
            for(var use:body.findAll(NameExpr.class)) {
                if(++facts.proofVisits>100_000)return null;
                if(!use.getNameAsString().equals(receiver.getNameAsString()))continue;
                if(!facts.target(use,symbol)||!(use.getParentNode().orElse(null) instanceof MethodCallExpr call)
                        ||call.getScope().orElse(null)!=use||call.getArguments().size()!=1) {valid=false;break;}
                if(call.getNameAsString().equals("contains")&&repeatedIn(call,loop)&&facts.string(call.getArgument(0)))queries.add(facts.range.apply(use));
                else if(call.getNameAsString().equals("add")&&literalString(call.getArgument(0))
                        &&call.getParentNode().orElse(null) instanceof ExpressionStmt statement&&statement.getParentNode().orElse(null)==body
                        &&body.getStatements().indexOf(statement)>declaredAt&&body.getStatements().indexOf(statement)<loopIndex) { /* discarded boolean add result */ }
                else {valid=false;break;}
            }
            if(valid&&!queries.isEmpty())return new Plan(node,receiver.getNameAsString(),List.copyOf(queries),generated);
        }
        return null;
    }
    private static boolean literalString(Expression expression) {
        while(expression instanceof EnclosedExpr enclosed)expression=enclosed.getInner();
        return expression instanceof StringLiteralExpr || expression instanceof NullLiteralExpr;
    }
    private static boolean inside(Node child,Node parent) {
        for(Node cursor=child;cursor!=null;cursor=cursor.getParentNode().orElse(null))if(cursor==parent)return true;
        return false;
    }
    private static boolean repeatedIn(Node query,Statement loop) {
        if(!inside(query,loop))return false;
        if(loop instanceof ForStmt forLoop&&forLoop.getInitialization().stream().anyMatch(init->inside(query,init)))return false;
        return !(loop instanceof ForEachStmt each&&inside(query,each.getIterable()));
    }
    private static boolean standardConstructor(Reference reference,Map<String,Symbol> symbols,String owner) {
        if(reference==null||!reference.kind().equals("constructor")||!reference.resolution().equals("exact")||reference.targetIds().size()!=1)return false;
        var symbol=symbols.get(reference.targetIds().getFirst());
        String simple=owner.substring(owner.lastIndexOf('.')+1);
        return symbol!=null&&symbol.external()&&symbol.kind().equals("constructor")&&(owner+"."+simple).equals(symbol.qualifiedName());
    }
    static boolean validCandidate(Analysis candidate,Rewrite rewrite) {
        if(candidate.optimizations()==null||candidate.semantics()==null)return false;
        var symbols=new HashMap<String,Symbol>();
        candidate.semantics().symbols().forEach(symbol->symbols.put(symbol.id(),symbol));
        var locals=candidate.semantics().symbols().stream().filter(symbol->!symbol.external()&&symbol.kind().equals("local")&&symbol.name().equals(rewrite.name())&&symbol.sourceRange()!=null&&symbol.sourceRange().filePath().equals(rewrite.change().filePath())&&symbol.sourceRange().startOffset()>=rewrite.change().startOffset()&&symbol.sourceRange().endOffset()<=rewrite.initializerEnd()).toList();
        if(locals.size()!=1||!SET.equals(locals.getFirst().resolvedType()))return false;
        return candidate.semantics().references().stream().anyMatch(reference->reference.sourceRange().filePath().equals(rewrite.change().filePath())
                &&reference.sourceRange().startOffset()>=rewrite.change().startOffset()&&reference.sourceRange().endOffset()<=rewrite.initializerEnd()
                &&standardConstructor(reference,symbols,"java.util.HashSet"));
    }
}
