package dev.javablueprints.engine;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import dev.javablueprints.engine.EngineModel.*;
import java.util.*;
import java.util.function.Function;
import javax.lang.model.SourceVersion;

/** Bounded token-only rename. Source programs are never compiled or executed here. */
final class LocalRename {
    record Rewrite(Map<String,String> files, List<TextChange> changes) {}
    static Node declaration(Node target) {
        if (target instanceof ExpressionStmt statement && statement.getExpression() instanceof VariableDeclarationExpr declaration
                && declaration.getVariables().size() == 1) return declaration.getVariable(0);
        if (target instanceof BlockStmt && target.getParentNode().orElse(null) instanceof CallableDeclaration<?> callable
                && callable.getParameters().size() == 1) return callable.getParameter(0);
        return null;
    }
    static boolean eligible(Node target) {
        Node declaration = declaration(target);
        if (declaration == null) return false;
        // Mirror the nested-domain refusal in rewrite(): never advertise an operation that must fail.
        var callable = declaration.findAncestor(CallableDeclaration.class).orElse(null);
        return callable == null || callable.findAll(LambdaExpr.class).isEmpty() && callable.findAll(LocalClassDeclarationStmt.class).isEmpty()
                && callable.findAll(ObjectCreationExpr.class).stream().noneMatch(o -> o.getAnonymousClassBody().isPresent());
    }
    static Rewrite rewrite(SourceBundle bundle, Analysis analysis, GraphNode selected, Node target,
                           Function<Node,SourceRange> ranges, String newName) {
        if (newName == null || newName.length()>100 || !SourceVersion.isIdentifier(newName) || SourceVersion.isKeyword(newName)
                || Set.of("var","record","yield","sealed","permits").contains(newName)) refuse("Invalid local name");
        Node declaration = declaration(target);
        if (declaration == null) refuse("Select one local declaration or the entry of a method with one parameter");
        SimpleName name = declaration instanceof VariableDeclarator v ? v.getName() : ((Parameter) declaration).getName();
        String oldName = name.asString();
        if (oldName.equals(newName)) refuse("New name must differ from the selected declaration");
        CallableDeclaration<?> callable = declaration.findAncestor(CallableDeclaration.class).orElseThrow(() -> error("Local callable is unknown"));
        TypeDeclaration<?> owner = declaration.findAncestor(TypeDeclaration.class).orElseThrow(() -> error("Owning type is unknown"));
        if (!callable.findAll(LambdaExpr.class).isEmpty() || !callable.findAll(LocalClassDeclarationStmt.class).isEmpty()
                || callable.findAll(ObjectCreationExpr.class).stream().anyMatch(o -> o.getAnonymousClassBody().isPresent()))
            refuse("Nested semantic domains are outside bounded local rename");
        if (owner.findAll(SimpleName.class).stream().anyMatch(n -> n.asString().equals(newName)))
            refuse("New name collides with an existing name or may capture a reference");
        SourceRange declarationRange = ranges.apply(name);
        var symbols = analysis.semantics().symbols().stream().filter(s -> Set.of("local","parameter").contains(s.kind())
                && declarationRange.equals(s.sourceRange()) && oldName.equals(s.name())).toList();
        if (symbols.size() != 1) refuse("Selected local declaration has no unique semantic binding");
        String symbolId = symbols.getFirst().id();
        List<SourceRange> uses = new ArrayList<>();
        uses.add(declarationRange);
        for (NameExpr expression : callable.findAll(NameExpr.class)) {
            if (!expression.getNameAsString().equals(oldName)) continue;
            SourceRange range = ranges.apply(expression);
            var references = analysis.semantics().references().stream().filter(r -> r.kind().equals("name") && range.equals(r.sourceRange())).toList();
            if (references.size() != 1 || !references.getFirst().resolution().equals("exact") || references.getFirst().targetIds().size() != 1)
                refuse("An old-name reference is unresolved or ambiguous");
            if (references.getFirst().targetIds().getFirst().equals(symbolId)) uses.add(range);
        }
        // Refuse unsupported reference representations instead of leaving a bound use unchanged.
        for (Reference ref : analysis.semantics().references()) if (ref.targetIds().contains(symbolId)
                && (!ref.kind().equals("name") || !ref.resolution().equals("exact") || !uses.contains(ref.sourceRange())))
            refuse("A selected-local reference is outside supported NameExpr bindings");
        String path = declarationRange.filePath(), source = bundle.files().get(path);
        List<TextChange> changes = uses.stream().distinct().sorted(Comparator.comparingInt(SourceRange::startOffset))
                .map(r -> new TextChange(path,r.startOffset(),r.endOffset(),source.substring(r.startOffset(),r.endOffset()),newName)).toList();
        String result = source;
        for (int i=changes.size()-1;i>=0;i--) {
            TextChange change=changes.get(i);
            if (!change.before().equals(oldName)) refuse("Declaration token differs from semantic binding");
            result=result.substring(0,change.startOffset())+newName+result.substring(change.endOffset());
        }
        Map<String,String> files=new TreeMap<>(bundle.files()); files.put(path,result);
        Analysis checked=new ProgramEngine().inspect(new SourceBundle("rename-check",files));
        if (!checked.parseStatus().equals("valid")) refuse("Renamed source does not parse");
        int shift=0; String renamedId=null;
        for (TextChange change:changes) {
            int start=change.startOffset()+shift;
            if (change.startOffset()==declarationRange.startOffset()) {
                var renamed=checked.semantics().symbols().stream().filter(s -> s.kind().equals(symbols.getFirst().kind()) && s.name().equals(newName)
                        && s.sourceRange()!=null && s.sourceRange().filePath().equals(path) && s.sourceRange().startOffset()==start).toList();
                if(renamed.size()!=1)refuse("Renamed declaration binding is not exact");
                renamedId=renamed.getFirst().id();
            }
            shift+=newName.length()-oldName.length();
        }
        shift=0;
        for(TextChange change:changes) {
            int start=change.startOffset()+shift;
            if(change.startOffset()!=declarationRange.startOffset()) {
                String expected=renamedId;
                if(checked.semantics().references().stream().noneMatch(r -> r.kind().equals("name") && r.name().equals(newName)
                    && r.sourceRange().filePath().equals(path) && r.sourceRange().startOffset()==start && r.resolution().equals("exact")
                    && r.targetIds().equals(List.of(expected))))refuse("Renamed reference may change binding");
            }
            shift+=newName.length()-oldName.length();
        }
        return new Rewrite(files,changes);
    }
    private static EngineException error(String reason) { return new EngineException("UNSUPPORTED_OPERATION",reason); }
    private static void refuse(String reason) { throw error(reason); }
}
