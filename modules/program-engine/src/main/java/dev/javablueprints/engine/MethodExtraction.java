package dev.javablueprints.engine;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import dev.javablueprints.engine.EngineModel.*;
import java.util.*;
import java.util.function.Function;
import javax.lang.model.SourceVersion;

/** Bound contiguous statements, moved within their existing declaring class. */
final class MethodExtraction {
    private MethodExtraction() {}
    record Rewrite(TextChange change, ExtractionSummary summary) {}
    private record Key(String file, int start, int end) {
        static Key of(SourceRange range) { return new Key(range.filePath(),range.startOffset(),range.endOffset()); }
    }
    private static EngineException unsupported(String message) { return new EngineException("UNSUPPORTED_OPERATION",message); }
    private static EngineException invalid(String message) { return new EngineException("INVALID_EDIT",message); }
    static boolean eligible(Node node) {
        if (!(node instanceof Statement) || !(node.getParentNode().orElse(null) instanceof BlockStmt)) return false;
        var method=node.findAncestor(MethodDeclaration.class).orElse(null);
        return method!=null && method.getParentNode().orElse(null) instanceof ClassOrInterfaceDeclaration owner
                && !owner.isInterface() && method.getTypeParameters().isEmpty();
    }
    static Rewrite rewrite(SourceBundle bundle, Analysis analysis, GraphNode start, Node first,
                           GraphNode end, Node last, Function<Node,SourceRange> range, String name) {
        if (name==null || name.length()>100 || !SourceVersion.isIdentifier(name) || SourceVersion.isKeyword(name)
                || Set.of("_","var","yield","record","sealed","permits","when").contains(name))
            throw invalid("Укажите допустимое новое имя метода");
        if (!eligible(first) || !eligible(last) || !start.methodId().equals(end.methodId())
                || first.getParentNode().orElse(null)!=last.getParentNode().orElse(null))
            throw unsupported("Выделите последовательные операторы одного блока и одного метода");
        var block=(BlockStmt)first.getParentNode().orElseThrow();
        int from=identityIndex(block,first), to=identityIndex(block,last);
        if (to<from || to-from>=256) throw unsupported("Диапазон должен идти по порядку и содержать не более 256 операторов");
        var statements=new ArrayList<>(block.getStatements().subList(from,to+1));
        var method=first.findAncestor(MethodDeclaration.class).orElseThrow();
        var owner=(ClassOrInterfaceDeclaration)method.getParentNode().orElseThrow();
        for (var unit:first.findCompilationUnit().orElseThrow().findRootNode().findAll(com.github.javaparser.ast.CompilationUnit.class)) {
            // The entire source bundle is checked below; this also covers the current AST.
            if (unit.findAll(SimpleName.class).stream().anyMatch(n->n.asString().equals(name)))
                throw invalid("Имя уже используется в проекте: "+name);
        }
        for (String source:bundle.files().values()) {
            var parsed=new JavaParser().parse(source);
            if(parsed.getResult().isPresent() && parsed.getResult().get().findAll(SimpleName.class).stream().anyMatch(n->n.asString().equals(name)))
                throw invalid("Имя уже используется в проекте: "+name);
        }
        try {
            if(owner.resolve().getAllMethods().stream().anyMatch(m->m.getDeclaration().getName().equals(name)))
                throw invalid("Имя конфликтует с методом класса или его предка: "+name);
        } catch (EngineException e) { throw e; }
        catch (RuntimeException e) { throw unsupported("Не удалось проверить методы предков класса"); }
        if (method.findAll(LambdaExpr.class).size()>0 || method.findAll(LocalClassDeclarationStmt.class).size()>0
                || method.findAll(ObjectCreationExpr.class).stream().anyMatch(n->n.getAnonymousClassBody().isPresent()))
            throw unsupported("Сначала вынесите код без захватов лямбд, локальных и анонимных классов");
        boolean tail=block==method.getBody().orElseThrow() && to==block.getStatements().size()-1;
        var returns=statements.stream().flatMap(n->n.findAll(ReturnStmt.class).stream()).toList();
        boolean returning=!returns.isEmpty();
        if(returning && !tail) throw unsupported("return можно переносить только вместе с концом тела метода");
        if(returning && returns.stream().anyMatch(n->n.findAncestor(com.github.javaparser.ast.body.CallableDeclaration.class).orElse(null)!=method))
            throw unsupported("Нельзя переносить return другого метода");
        for(var statement:statements) for(var jump:statement.findAll(Statement.class)) {
            if(jump instanceof YieldStmt || jump instanceof ExplicitConstructorInvocationStmt || jump instanceof LabeledStmt)
                throw unsupported("В этом диапазоне есть неподдерживаемый переход управления");
            if(jump instanceof BreakStmt b && b.getLabel().isPresent() || jump instanceof ContinueStmt c && c.getLabel().isPresent())
                throw unsupported("Переходы по меткам пока нельзя выносить в метод");
            if(jump instanceof BreakStmt || jump instanceof ContinueStmt) {
                Node cursor=jump.getParentNode().orElse(null); boolean found=false;
                while(cursor!=null && cursor!=block) {
                    if(cursor instanceof ForStmt || cursor instanceof ForEachStmt || cursor instanceof WhileStmt || cursor instanceof DoStmt
                            || jump instanceof BreakStmt && cursor instanceof SwitchStmt) { found=true;break; }
                    cursor=cursor.getParentNode().orElse(null);
                }
                if(!found) throw unsupported("break/continue выходит за границы выделенного фрагмента");
            }
        }
        SourceRange begin=range.apply(first), finish=range.apply(last), methodRange=range.apply(method);
        if(!begin.filePath().equals(finish.filePath())) throw invalid("Операторы относятся к разным файлам");
        var facts=new Facts(analysis.semantics(),range);
        var used=new LinkedHashMap<String,Symbol>();
        var written=new HashSet<String>();
        for(var statement:statements) for(var use:statement.findAll(NameExpr.class)) {
            Symbol symbol=facts.symbol(use);
            if(symbol==null) {
                // A name may qualify a type (System.out), but an unresolved value
                // cannot safely become an implicit field in the new method.
                Reference reference=facts.reference(use);
                if(reference==null || !"exact".equals(reference.resolution()))
                    throw unsupported("Не удалось однозначно разрешить имя "+use.getNameAsString());
                continue;
            }
            if(!Set.of("local","parameter").contains(symbol.kind())) continue;
            used.putIfAbsent(symbol.id(),symbol);
            if(writes(use)) written.add(symbol.id());
        }
        facts.symbols.values().stream().filter(s->s.kind().equals("local") && inside(s.sourceRange(),begin.startOffset(),finish.endOffset()))
                .sorted(Comparator.comparingInt(s->s.sourceRange().startOffset())).forEach(s->used.putIfAbsent(s.id(),s));
        var outputs=new ArrayList<Symbol>();
        for(var symbol:used.values()) {
            boolean internal=inside(symbol.sourceRange(),begin.startOffset(),finish.endOffset());
            // A loop backedge can read a written local at an earlier source offset.
            // Conservatively retain all external uses, not only the textual suffix.
            boolean live=internal?facts.usedAfter(symbol,finish.endOffset(),methodRange.endOffset())
                    :facts.usedOutside(symbol,begin.startOffset(),finish.endOffset(),methodRange.startOffset(),methodRange.endOffset());
            if((internal || written.contains(symbol.id())) && live) outputs.add(symbol);
        }
        if(returning && !outputs.isEmpty()) throw unsupported("return и выходные локальные переменные нельзя объединить в одном результате");
        if(outputs.size()>1) throw unsupported("Фрагмент изменяет несколько переменных, используемых дальше. Выделите фрагмент с одним результатом");
        Symbol output=outputs.isEmpty()?null:outputs.getFirst();
        if(output!=null && inside(output.sourceRange(),begin.startOffset(),finish.endOffset())
                && constantLocal(method,output,range))
            throw unsupported("Константная локальная переменная должна сохранить исходный инициализатор вне выделения");
        if(output!=null && !inside(output.sourceRange(),begin.startOffset(),finish.endOffset()) && first.findAncestor(TryStmt.class).isPresent())
            throw unsupported("Изменяемая локальная переменная доступна обработчику исключений за пределами фрагмента");
        var inputs=new ArrayList<Symbol>(); var locals=new ArrayList<Symbol>(); var names=new HashSet<String>();
        for(var symbol:used.values()) {
            if(inside(symbol.sourceRange(),begin.startOffset(),finish.endOffset())) continue;
            boolean defined=false, read=false;
            for(var statement:statements) {
                for(var use:statement.findAll(NameExpr.class)) if(facts.targets(use,symbol) && !writeOnly(use) && !defined) read=true;
                if(defines(statement,symbol,facts)) defined=true;
            }
            if(output!=null && output.id().equals(symbol.id()) && !defined) read=true;
            if(!names.add(symbol.name())) throw unsupported("Одноимённые локальные переменные имеют разные области видимости");
            if(read && constantLocal(method,symbol,range))
                throw unsupported("Передача локальной константы параметром может изменить вычисление константных выражений");
            if(read) inputs.add(symbol); else locals.add(symbol);
        }
        String returnType=returning?type(method.getTypeAsString()):output==null?"void":type(output.resolvedType());
        var parameters=inputs.stream().map(s->new ExtractionParameter(s.name(),type(s.resolvedType()))).toList();
        String arguments=String.join(", ",inputs.stream().map(Symbol::name).toList());
        String invocation=name+"("+arguments+")";
        String replacement;
        if(returning && !returnType.equals("void")) replacement="return "+invocation+";";
        else if(output==null) replacement=invocation+";";
        else if(inside(output.sourceRange(),begin.startOffset(),finish.endOffset()))
            replacement=returnType+" "+output.name()+" = "+invocation+";";
        else replacement=output.name()+" = "+invocation+";";
        String source=bundle.files().get(begin.filePath());
        String indent=indent(source,methodRange.startOffset()), inner=indent+"    ";
        String body=source.substring(begin.startOffset(),finish.endOffset());
        var throwsTypes=new LinkedHashSet<String>();
        method.getThrownExceptions().forEach(t->throwsTypes.add(type(t.asString())));
        for(var statement:statements) {
            for(var call:statement.findAll(MethodCallExpr.class)) try {
                for(var exception:call.resolve().getSpecifiedExceptions())
                    if(!caughtWithin(call,exception,statements)) throwsTypes.add(type(exception.describe()));
            } catch(EngineException e) { throw e; } catch(RuntimeException e) { throw unsupported("Не удалось определить исключения вызова "+call.getNameAsString()); }
            for(var creation:statement.findAll(ObjectCreationExpr.class)) try {
                for(var exception:creation.resolve().getSpecifiedExceptions())
                    if(!caughtWithin(creation,exception,statements)) throwsTypes.add(type(exception.describe()));
            } catch(EngineException e) { throw e; } catch(RuntimeException e) { throw unsupported("Не удалось определить исключения конструктора"); }
            for(var thrown:statement.findAll(ThrowStmt.class)) try {
                var exception=thrown.getExpression().calculateResolvedType();
                if(!exception.isNull() && !caughtWithin(thrown,exception,statements)) throwsTypes.add(type(exception.describe()));
            } catch(EngineException e) { throw e; } catch(RuntimeException e) { throw unsupported("Не удалось определить тип throw"); }
            for(var scope:statement.findAll(TryStmt.class)) for(var resource:scope.getResources()) {
                for(var exception:implicitCloseExceptions(resource))
                    if(!caughtWithin(resource,exception,statements)) throwsTypes.add(type(exception.describe()));
            }
        }
        String localText=String.join("",locals.stream().map(s->inner+type(s.resolvedType())+" "+s.name()+";\n").toList());
        String result=output==null?"":"\n"+inner+"return "+output.name()+";";
        String helper="\n\n"+indent+"private "+(method.isStatic()?"static ":"")+returnType+" "+name+"("
                +String.join(", ",parameters.stream().map(p->p.type()+" "+p.name()).toList())+")"
                +(throwsTypes.isEmpty()?"":" throws "+String.join(", ",throwsTypes))+" {\n"+localText+inner+body+result+"\n"+indent+"}";
        String before=source.substring(begin.startOffset(),methodRange.endOffset());
        String after=replacement+source.substring(finish.endOffset(),methodRange.endOffset())+helper;
        return new Rewrite(new TextChange(begin.filePath(),begin.startOffset(),methodRange.endOffset(),before,after),
                new ExtractionSummary(begin.filePath(),name,parameters,returnType,output==null?null:output.name(),method.isStatic()));
    }
    private static int identityIndex(BlockStmt block,Node node) {
        for(int i=0;i<block.getStatements().size();i++) if(block.getStatement(i)==node)return i;
        throw invalid("Оператор не принадлежит блоку");
    }
    private static boolean inside(SourceRange range,int from,int to) { return range!=null && range.startOffset()>=from && range.endOffset()<=to; }
    private static boolean constantLocal(MethodDeclaration method,Symbol symbol,Function<Node,SourceRange> range) {
        return method.findAll(VariableDeclarator.class).stream().anyMatch(v->v.getNameAsString().equals(symbol.name())
                && inside(range.apply(v.getName()),symbol.sourceRange().startOffset(),symbol.sourceRange().endOffset())
                && v.getParentNode().orElse(null) instanceof VariableDeclarationExpr declaration && declaration.isFinal()
                && v.getInitializer().isPresent() && (v.getType().isPrimitiveType()
                || Set.of("boolean","byte","short","int","long","char","float","double","String","java.lang.String")
                    .contains(symbol.resolvedType()==null?"":symbol.resolvedType())));
    }
    private static String indent(String source,int offset) {
        int line=source.lastIndexOf('\n',Math.max(0,offset-1))+1;
        String text=source.substring(line,offset); return text.isBlank()?text:"    ";
    }
    private static String type(String value) {
        if(value==null || value.equals("var") || value.contains("capture") || value.contains("?") || value.contains("&"))
            throw unsupported("Тип параметра или результата нельзя выразить в сигнатуре метода");
        if(!new JavaParser().parseType(value).isSuccessful()) throw unsupported("Не удалось записать тип "+value);
        return value;
    }
    private static boolean writeOnly(NameExpr use) {
        return use.getParentNode().orElse(null) instanceof AssignExpr assignment
                && assignment.getTarget()==use && assignment.getOperator()==AssignExpr.Operator.ASSIGN;
    }
    private static boolean writes(NameExpr use) {
        return use.getParentNode().orElse(null) instanceof AssignExpr assignment && assignment.getTarget()==use
                || use.getParentNode().orElse(null) instanceof UnaryExpr unary && Set.of(UnaryExpr.Operator.PREFIX_INCREMENT,
                UnaryExpr.Operator.PREFIX_DECREMENT,UnaryExpr.Operator.POSTFIX_INCREMENT,UnaryExpr.Operator.POSTFIX_DECREMENT).contains(unary.getOperator());
    }
    private static boolean defines(Statement statement,Symbol symbol,Facts facts) {
        return statement instanceof ExpressionStmt expression && expression.getExpression() instanceof AssignExpr assignment
                && assignment.getOperator()==AssignExpr.Operator.ASSIGN && assignment.getTarget() instanceof NameExpr use && facts.targets(use,symbol);
    }
    private static List<com.github.javaparser.resolution.types.ResolvedType> implicitCloseExceptions(Expression resource) {
        try {
            com.github.javaparser.resolution.types.ResolvedType resourceType;
            if(resource instanceof VariableDeclarationExpr declaration && declaration.getVariables().size()==1) {
                var variable=declaration.getVariable(0);
                // The declared type determines the checked contract. An initializer subtype may
                // override close() without throws, but AutoCloseable still requires Exception.
                resourceType=variable.getType().isVarType()
                        ?variable.getInitializer().orElseThrow().calculateResolvedType():variable.getType().resolve();
            } else if(resource instanceof NameExpr || resource instanceof FieldAccessExpr) {
                resourceType=resource.calculateResolvedType();
            } else throw unsupported("Неподдерживаемая форма ресурса для определения implicit close()");
            if(!resourceType.isReferenceType()) throw unsupported("Тип implicit close() должен быть однозначным ссылочным типом");
            var reference=resourceType.asReferenceType();
            var ancestors=reference.getAllAncestors();
            if(ancestors.size()>256 || !(reference.getQualifiedName().equals("java.lang.AutoCloseable")
                    || ancestors.stream().anyMatch(a->a.getQualifiedName().equals("java.lang.AutoCloseable"))))
                throw unsupported("Ресурс implicit close() должен разрешаться в AutoCloseable без неизвестных предков");
            // getAllMethods() can collapse override-equivalent declarations from unrelated
            // interfaces. Keep each declaring type so an intersection contract is not guessed.
            var all=new ArrayList<com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration>();
            reference.getDeclaredMethods().forEach(usage->all.add(usage.getDeclaration()));
            for(var ancestor:ancestors) ancestor.getDeclaredMethods().forEach(usage->all.add(usage.getDeclaration()));
            if(all.size()>4096)throw unsupported("Превышен лимит методов для определения implicit close()");
            var candidates=new TreeMap<String,com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration>();
            for(var candidate:all) if(candidate.getName().equals("close") && candidate.getNumberOfParams()==0 && !candidate.isStatic()
                    && (candidate.accessSpecifier()==com.github.javaparser.ast.AccessSpecifier.PUBLIC
                        || candidate.declaringType().isInterface() && candidate.accessSpecifier()==com.github.javaparser.ast.AccessSpecifier.NONE)
                    && candidate.getReturnType().isVoid())
                candidates.putIfAbsent(candidate.getQualifiedSignature(),candidate);
            var mostSpecific=candidates.values().stream().filter(candidate->candidates.values().stream().noneMatch(other->
                    !other.declaringType().getQualifiedName().equals(candidate.declaringType().getQualifiedName())
                    && other.declaringType().getAllAncestors().stream().anyMatch(parent->parent.getQualifiedName().equals(candidate.declaringType().getQualifiedName())))).toList();
            // Incomparable inherited interface contracts need intersection-of-throws inference.
            // Decline instead of widening throws and rejecting an otherwise safe extraction.
            if(mostSpecific.size()!=1 || !mostSpecific.getFirst().getTypeParameters().isEmpty())
                throw unsupported("Для implicit close() требуется один наиболее конкретный контракт без параметров типов");
            var exceptions=new ArrayList<com.github.javaparser.resolution.types.ResolvedType>();
            for(var exception:mostSpecific.getFirst().getSpecifiedExceptions()) {
                if(!exception.isReferenceType())throw unsupported("Параметризованный или неизвестный тип исключения implicit close() не поддерживается");
                var thrownType=exception.asReferenceType();
                var parents=thrownType.getAllAncestors();
                boolean unchecked=Set.of("java.lang.RuntimeException","java.lang.Error").contains(thrownType.getQualifiedName())
                        || parents.stream().anyMatch(p->Set.of("java.lang.RuntimeException","java.lang.Error").contains(p.getQualifiedName()));
                if(!unchecked)exceptions.add(exception);
            }
            return exceptions;
        } catch(EngineException failure) { throw failure; }
        catch(RuntimeException | StackOverflowError failure) {
            throw unsupported("Не удалось однозначно определить checked-исключения implicit close()");
        }
    }
    private static boolean caughtWithin(Node node,com.github.javaparser.resolution.types.ResolvedType exception,List<Statement> selected) {
        for(Node cursor=node.getParentNode().orElse(null);cursor!=null;cursor=cursor.getParentNode().orElse(null)) {
            if(cursor instanceof TryStmt scope && selected.stream().anyMatch(s->s==scope || s.isAncestorOf(scope))
                    && (scope.getTryBlock().isAncestorOf(node)
                        || scope.getResources().stream().anyMatch(resource -> resource==node || resource.isAncestorOf(node)))) {
                for(var handler:scope.getCatchClauses()) {
                    var type=handler.getParameter().getType();
                    var alternatives=type.isUnionType()?type.asUnionType().getElements():List.of(type);
                    for(var alternative:alternatives) try { if(alternative.resolve().isAssignableBy(exception))return true; }
                    catch(RuntimeException ignored) { }
                }
            }
            if(cursor instanceof MethodDeclaration)break;
        }
        return false;
    }
    private static final class Facts {
        final Map<Key,Reference> references=new HashMap<>(); final Map<String,Symbol> symbols=new HashMap<>();
        final Function<Node,SourceRange> range;
        Facts(SemanticModel semantics,Function<Node,SourceRange> range) {
            this.range=range;
            semantics.references().forEach(r->references.put(Key.of(r.sourceRange()),r));
            semantics.symbols().forEach(s->symbols.put(s.id(),s));
        }
        Reference reference(Node node) { return references.get(Key.of(range.apply(node))); }
        Symbol symbol(NameExpr node) {
            var reference=reference(node);
            return reference!=null && reference.resolution().equals("exact") && reference.targetIds().size()==1?symbols.get(reference.targetIds().getFirst()):null;
        }
        boolean targets(NameExpr use,Symbol symbol) { return symbol.equals(symbol(use)); }
        boolean usedAfter(Symbol symbol,int after,int end) {
            return references.values().stream().anyMatch(r->r.sourceRange().startOffset()>=after && r.sourceRange().endOffset()<=end && r.targetIds().contains(symbol.id()));
        }
        boolean usedOutside(Symbol symbol,int from,int to,int methodStart,int methodEnd) {
            return references.values().stream().anyMatch(r->r.sourceRange().startOffset()>=methodStart
                    && r.sourceRange().endOffset()<=methodEnd
                    && !inside(r.sourceRange(),from,to) && r.targetIds().contains(symbol.id()));
        }
    }
}
