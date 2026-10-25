package dev.javablueprints.server;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.body.*;
import com.fasterxml.jackson.databind.JsonNode;
import dev.javablueprints.verification.MethodContract;
import static dev.javablueprints.verification.RunnerProtocol.JSON;
import java.util.*;

/** Bounded direct invocation. No reflection-based method lookup, source expressions or host execution. */
final class MethodHarness {
    static final String MAIN="__JbMethodHarness",ACCESS="__JbMethodAccess";
    static String profileHash(){return Workspace.hash(MethodContract.PROFILE_HASH+"|typed-adapters-v2|"+TEMPLATE+"|"+ACCESS_TEMPLATE);}
    static final Set<String> SCALARS=Set.of("boolean","byte","short","int","long","char","float","double","String");
    static final Map<String,String> BOXED=Map.of("Boolean","boolean","Byte","byte","Short","short","Integer","int","Long","long","Character","char","Float","float","Double","double");
    // Declared JDK collection type -> concrete type constructed for input arguments.
    static final Map<String,String> COLLECTIONS=Map.ofEntries(Map.entry("Collection","ArrayList"),Map.entry("List","ArrayList"),Map.entry("ArrayList","ArrayList"),Map.entry("LinkedList","LinkedList"),
        Map.entry("Set","HashSet"),Map.entry("HashSet","HashSet"),Map.entry("LinkedHashSet","LinkedHashSet"),Map.entry("SortedSet","TreeSet"),Map.entry("NavigableSet","TreeSet"),Map.entry("TreeSet","TreeSet"),
        Map.entry("Queue","LinkedList"),Map.entry("Deque","ArrayDeque"),Map.entry("ArrayDeque","ArrayDeque"));
    static final Map<String,String> MAPS=Map.of("Map","HashMap","HashMap","HashMap","LinkedHashMap","LinkedHashMap","SortedMap","TreeMap","NavigableMap","TreeMap","TreeMap","TreeMap");
    static final Set<String> NON_NULL=Set.of("TreeSet","ArrayDeque","TreeMap");
    static final int INPUT_ITEMS=256,OUTPUT_ITEMS=4096;
    static String type(String value) {return value.replace("java.lang.String","String");}
    static String simple(String fq) {String raw=raw(fq);return raw.substring(raw.lastIndexOf('.')+1);}
    static String raw(String fq) {int at=fq.indexOf('<');return at<0?fq:fq.substring(0,at);}
    /** Top-level type arguments of an approved fully qualified adapter spelling. */
    static List<String> typeArgs(String fq) {
        int at=fq.indexOf('<');if(at<0)return List.of();
        var out=new ArrayList<String>();int depth=0,start=at+1;
        for(int i=start;i<fq.length()-1;i++){char c=fq.charAt(i);if(c=='<')depth++;else if(c=='>')depth--;else if(c==','&&depth==0){out.add(fq.substring(start,i));start=i+1;}}
        out.add(fq.substring(start,fq.length()-1));return out;
    }
    /** Fully qualified adapter spelling of an approved type, or null. Names resolve only to java.lang/java.util. */
    static String javaType(com.github.javaparser.ast.type.Type t,java.util.function.UnaryOperator<String> names,boolean top) {
        if(t.isPrimitiveType())return t.asString();
        if(t.isArrayType()){String c=javaType(t.asArrayType().getComponentType(),names,false);return c==null||c.contains("<")||c.equals("java.util.Scanner")?null:c+"[]";}
        if(!t.isClassOrInterfaceType())return null;
        var c=t.asClassOrInterfaceType();String fq=names.apply(c.getNameWithScope());if(fq==null)return null;
        String name=simple(fq);int arity=fq.equals("java.lang.String")||fq.startsWith("java.lang.")?0:COLLECTIONS.containsKey(name)||name.equals("Optional")?1:MAPS.containsKey(name)?2:0;
        if(fq.equals("java.util.Scanner")&&!top)return null;
        var args=c.getTypeArguments().orElse(null);
        if(args==null?arity!=0:args.size()!=arity)return null;
        if(arity==0)return fq;
        var parts=new ArrayList<String>();
        for(var arg:args){String part=arg.isWildcardType()?null:javaType(arg,names,false);if(part==null||part.equals("java.util.Scanner"))return null;parts.add(part);}
        // Sorted/non-null containers only accept naturally comparable scalar keys.
        if(NON_NULL.contains(COLLECTIONS.getOrDefault(name,MAPS.getOrDefault(name,"")))&&!(parts.getFirst().equals("java.lang.String")||parts.getFirst().startsWith("java.lang.")&&BOXED.containsKey(simple(parts.getFirst()))))return null;
        return fq+"<"+String.join(",",parts)+">";
    }
    static String knownName(String fq) {
        if(fq.startsWith("java.lang.")){String n=fq.substring(10);return n.equals("String")||BOXED.containsKey(n)?fq:null;}
        if(fq.startsWith("java.util.")){String n=fq.substring(10);return COLLECTIONS.containsKey(n)||MAPS.containsKey(n)||n.equals("Optional")||n.equals("Scanner")?fq:null;}
        return null;
    }
    /** Already-approved fully qualified spellings, plus the legacy String alias. */
    static String trustedJavaType(String declared) {
        declared=type(declared);if(declared.equals("void"))return declared;
        return javaType(com.github.javaparser.StaticJavaParser.parseType(declared),n->n.equals("String")?"java.lang.String":knownName(n),true);
    }
    static java.util.function.UnaryOperator<String> sourceNames(com.github.javaparser.ast.CompilationUnit unit,Set<String> projectTypes) {
        return name->{
            if(name.contains("."))return knownName(name);
            if(projectTypes.contains(name))return null;
            for(var imported:unit.getImports()) if(!imported.isStatic()&&!imported.isAsterisk()&&imported.getName().getIdentifier().equals(name))return knownName(imported.getNameAsString());
            if(name.equals("String")||BOXED.containsKey(name))return "java.lang."+name;
            boolean util=unit.getImports().stream().anyMatch(v->!v.isStatic()&&v.isAsterisk()&&v.getNameAsString().equals("java.util"));
            return util?knownName("java.util."+name):null;
        };
    }
    static List<Map<String,Object>> targets(Map<String,String> files) {
        var rows=new ArrayList<Map<String,Object>>();var units=new LinkedHashMap<String,com.github.javaparser.ast.CompilationUnit>();var projectTypes=new HashSet<String>();
        files.forEach((path,source)->{
            if(source.length()>262144) return;
            var parsedResult=new com.github.javaparser.JavaParser(new com.github.javaparser.ParserConfiguration().setLanguageLevel(com.github.javaparser.ParserConfiguration.LanguageLevel.JAVA_21)).parse(source);
            if(!parsedResult.isSuccessful())throw new IllegalArgumentException("Parse-valid Java required");
            var parsed=parsedResult.getResult().orElseThrow(()->new IllegalArgumentException("Parse-valid Java required"));
            units.put(path,parsed);parsed.findAll(TypeDeclaration.class).forEach(v->projectTypes.add(v.getNameAsString()));
        });
        units.forEach((path,parsed)->{
            String pkg=parsed.getPackageDeclaration().map(v->v.getNameAsString()+".").orElse("");var names=sourceNames(parsed,projectTypes);
            for(var declaration:parsed.getTypes()) if(declaration instanceof ClassOrInterfaceDeclaration owner) {
                // Instance targets get a fresh receiver per case through an accessible
                // no-argument constructor; no receiver state is supplied or serialized.
                // Non-public members are reached only from the owner's own package: the
                // default-package driver directly, named packages through a generated bridge.
                boolean constructible=!owner.isAbstract()&&(owner.getConstructors().isEmpty()||owner.getConstructors().stream().anyMatch(c->!c.isPrivate()&&c.getParameters().isEmpty()));
                boolean publicCtor=owner.getConstructors().isEmpty()||owner.getConstructors().stream().anyMatch(c->c.isPublic()&&c.getParameters().isEmpty());
                for(var method:owner.getMethods()) {
                    var params=method.getParameters().stream().map(v->type(v.getType().asString())).toList();
                    var javaParams=method.getParameters().stream().map(v->javaType(v.getType(),names,true)).toList();
                    String javaReturn=method.getType().isVoidType()?"void":javaType(method.getType(),names,false);
                    String reason=owner.isInterface()?"interface_owner_unsupported":method.isPrivate()?"method_private":!method.isStatic()&&!constructible?"receiver_constructor_unsupported":!owner.getTypeParameters().isEmpty()||!method.getTypeParameters().isEmpty()?"generic_method_unsupported":method.isAbstract()?"abstract_method_unsupported":method.getParameters().size()>16?"parameter_budget":method.getParameters().stream().anyMatch(v->v.isVarArgs())?"varargs_unsupported":javaParams.contains(null)||javaReturn==null?"type_adapter_unsupported":null;
                    boolean bridge=!pkg.isEmpty()&&(!owner.isPublic()||!method.isPublic()||!method.isStatic()&&!(publicCtor&&owner.isPublic()));
                    var row=new LinkedHashMap<String,Object>();
                    row.put("ownerType",pkg+owner.getNameAsString());row.put("methodName",method.getNameAsString());row.put("parameterTypes",params);row.put("returnType",type(method.getType().asString()));row.put("receiver",method.isStatic()?"static":"fresh_no_arg_instance");
                    row.put("access",owner.isPublic()&&method.isPublic()?"public":"package");row.put("invocation",bridge?"package_bridge":"direct");
                    if(reason==null){row.put("javaParameterTypes",javaParams);row.put("javaReturnType",javaReturn);}
                    row.put("filePath",path);row.put("startLine",method.getBegin().map(v->v.line).orElse(0));row.put("signature",method.getDeclarationAsString(false,false,false));row.put("supported",reason==null);row.put("reason",reason);rows.add(row);
                }
            }
        });
        return rows;
    }
    static Map<String,Object> validateTarget(Map<String,String> files,Map<String,Object> target) {
        if(!target.keySet().equals(Set.of("ownerType","methodName","parameterTypes"))) throw new IllegalArgumentException("Target requires ownerType, methodName, parameterTypes only");
        var matches=targets(files).stream().filter(v->Objects.equals(v.get("ownerType"),target.get("ownerType"))&&Objects.equals(v.get("methodName"),target.get("methodName"))&&Objects.equals(v.get("parameterTypes"),target.get("parameterTypes"))).toList();
        if(matches.size()!=1)throw new IllegalArgumentException("Exact method overload not found");
        var method=matches.getFirst();if(!Boolean.TRUE.equals(method.get("supported")))throw new IllegalArgumentException(method.get("reason").toString());return method;
    }
    /** Java expression for an approved fully qualified adapter type; only literal JSON values are accepted. */
    static String literal(String type,JsonNode value) {
        String spelled=type;type=type(type);
        if(spelled.endsWith("[]")) {
            if(value.isNull())return "null";
            if(!value.isArray()||value.size()>INPUT_ITEMS)throw new IllegalArgumentException("Array adapter expects <=256 items");
            String component=spelled.substring(0,spelled.length()-2);var items=new ArrayList<String>();value.forEach(v->items.add(literal(component,v)));return "new "+spelled+"{"+String.join(",",items)+"}";
        }
        if(type.startsWith("java.lang.")&&BOXED.containsKey(type.substring(10))) return value.isNull()?"null":type+".valueOf("+literal(BOXED.get(type.substring(10)),value)+")";
        if(type.startsWith("java.util.")) {
            String name=simple(type);var args=typeArgs(spelled);
            if(value.isNull())return "null";
            if(name.equals("Scanner")) {
                if(!value.isTextual())throw new IllegalArgumentException("Scanner adapter expects its input text");
                return "new java.util.Scanner("+literal("String",value)+")";
            }
            if(name.equals("Optional")) {
                if(!value.isObject()||!value.path("present").isBoolean())throw new IllegalArgumentException("Optional adapter expects {present,value}");
                if(!value.path("present").booleanValue()){if(value.size()!=1)throw new IllegalArgumentException("Empty Optional has no value");return "java.util.Optional.empty()";}
                if(value.size()!=2||!value.has("value")||value.get("value").isNull())throw new IllegalArgumentException("Present Optional requires a non-null value");
                return "java.util.Optional.of("+literal(args.getFirst(),value.get("value"))+")";
            }
            boolean map=MAPS.containsKey(name);String concrete=map?MAPS.get(name):COLLECTIONS.get(name);
            if(concrete==null||!value.isArray()||value.size()>INPUT_ITEMS)throw new IllegalArgumentException("Collection adapter expects <=256 items");
            var items=new ArrayList<String>();var keys=new HashSet<JsonNode>();
            for(var item:value) {
                if(map) {
                    if(!item.isArray()||item.size()!=2)throw new IllegalArgumentException("Map adapter expects [key,value] pairs");
                    if(!keys.add(item.get(0)))throw new IllegalArgumentException("Map adapter keys must be distinct");
                    if(NON_NULL.contains(concrete)&&item.get(0).isNull())throw new IllegalArgumentException(concrete+" rejects null keys");
                    items.add(literal(args.get(0),item.get(0)));items.add(literal(args.get(1),item.get(1)));
                } else {
                    if(NON_NULL.contains(concrete)&&item.isNull())throw new IllegalArgumentException(concrete+" rejects null elements");
                    items.add(literal(args.getFirst(),item));
                }
            }
            // Containers are filled in JSON order: insertion order is the input contract.
            String created="new java.util."+concrete+"<"+String.join(",",args)+">()";
            return MAIN+"."+(map?"put":"fill")+"("+created+",new java.lang.Object[]{"+String.join(",",items)+"})";
        }
        if(type.equals("String")) {
            if(value.isNull())return "null";
            if(!value.isTextual()||value.textValue().length()>1024)throw new IllegalArgumentException("String adapter expects <=1024 UTF16 units");
            var chars=new ArrayList<String>();for(char c:value.textValue().toCharArray())chars.add("(char)"+(int)c);return "new java.lang.String(new char[]{"+String.join(",",chars)+"})";
        }
        if(type.equals("char")) {if(!value.isTextual()||value.textValue().length()!=1)throw new IllegalArgumentException("char expects one UTF16 unit");return "(char)"+(int)value.textValue().charAt(0);}
        if(type.equals("boolean")) {if(!value.isBoolean())throw new IllegalArgumentException("boolean required");return value.booleanValue()?"true":"false";}
        if(value.isNull() || !(value.isNumber()||value.isTextual()))throw new IllegalArgumentException("Numeric value required");
        String raw=value.asText();
        try {return switch(type) {
            case "byte" -> "(byte)"+Byte.parseByte(raw);case "short" -> "(short)"+Short.parseShort(raw);case "int" -> Integer.toString(Integer.parseInt(raw));case "long" -> Long.parseLong(raw)+"L";
            case "float" -> {float v=Float.parseFloat(raw);if(!Float.isFinite(v))throw new IllegalArgumentException("Finite float input required");yield Float.toHexString(v)+"f";}
            case "double" -> {double v=Double.parseDouble(raw);if(!Double.isFinite(v))throw new IllegalArgumentException("Finite double input required");yield Double.toHexString(v);}
            default -> throw new IllegalArgumentException("Unsupported adapter");
        };}catch(NumberFormatException invalid){throw new IllegalArgumentException("Numeric argument outside exact "+type+" domain");}
    }
    static JsonNode canonical(String declared,JsonNode value) {
        declared=type(declared);
        if(declared.equals("void")){if(!value.isNull())throw new IllegalArgumentException("Void expected return must be null");return value;}
        if(declared.endsWith("[]")) {
            if(value.isNull())return value;
            if(!value.isArray()||value.size()>OUTPUT_ITEMS)throw new IllegalArgumentException("Expected array budget");
            var array=JSON.createArrayNode();for(var item:value)array.add(canonical(declared.substring(0,declared.length()-2),item));return array;
        }
        if(declared.equals("String")){if(!value.isNull()&&!value.isTextual())throw new IllegalArgumentException("String expected");return value;}
        if(declared.startsWith("java.lang.")&&BOXED.containsKey(declared.substring(10)))return value.isNull()?value:canonical(BOXED.get(declared.substring(10)),value);
        if(declared.startsWith("java.util.")) {
            String name=simple(declared);var args=typeArgs(declared);
            // A Scanner argument's poststate is opaque and always observed as null.
            if(value.isNull())return value;
            if(name.equals("Scanner"))throw new IllegalArgumentException("Scanner poststate is observed as null");
            if(name.equals("Optional")) {
                if(!value.isObject()||!value.path("present").isBoolean())throw new IllegalArgumentException("Expected Optional {present,value}");
                var optional=JSON.createObjectNode();optional.put("present",value.get("present").booleanValue());
                if(value.get("present").booleanValue())optional.set("value",canonical(args.getFirst(),value.path("value")));
                else if(value.size()!=1)throw new IllegalArgumentException("Empty Optional has no value");
                return optional;
            }
            if(!value.isArray()||value.size()>OUTPUT_ITEMS)throw new IllegalArgumentException("Expected collection budget");
            var array=JSON.createArrayNode();
            for(var item:value) {
                if(MAPS.containsKey(name)){if(!item.isArray()||item.size()!=2)throw new IllegalArgumentException("Expected map as [key,value] pairs");var pair=JSON.createArrayNode();pair.add(canonical(args.get(0),item.get(0)));pair.add(canonical(args.get(1),item.get(1)));array.add(pair);}
                else array.add(canonical(args.getFirst(),item));
            }
            return array;
        }
        if((declared.equals("float")||declared.equals("double"))&&value.isTextual()&&Set.of("NaN","Infinity","-Infinity").contains(value.asText()))return value;
        literal(declared,value);
        return switch(declared){
            case "byte","short","int" -> JSON.valueToTree(Integer.parseInt(value.asText()));
            case "long" -> JSON.valueToTree(Long.parseLong(value.asText()));
            case "float" -> JSON.valueToTree(Float.parseFloat(value.asText()));
            case "double" -> JSON.valueToTree(Double.parseDouble(value.asText()));
            default -> value;
        };
    }
    // Bindings recorded before typed-adapters-v2 only carry scalar/array spellings.
    @SuppressWarnings("unchecked")
    static List<String> javaParameterTypes(Map<String,Object> binding){
        var types=(List<String>)binding.getOrDefault("javaParameterTypes",binding.get("parameterTypes"));return types.stream().map(MethodHarness::trustedJavaType).toList();
    }
    static String javaReturnType(Map<String,Object> binding){return trustedJavaType(binding.getOrDefault("javaReturnType",binding.get("returnType")).toString());}
    static Object normalizeExpected(Map<String,Object> binding,Object raw) {
        var value=JSON.valueToTree(raw);
        if(!value.isObject()||!value.path("complete").asBoolean()||!value.has("returnValue")||!value.has("exception")||!value.path("argumentsAfter").isArray())throw new IllegalArgumentException("Complete expected method-v1 schema required");
        var expected=(com.fasterxml.jackson.databind.node.ObjectNode)value;
        if(value.path("completion").asText().equals("return")) {
            if(!value.get("exception").isNull())throw new IllegalArgumentException("Returned result cannot contain an exception");
            expected.set("returnValue",canonical(javaReturnType(binding),value.get("returnValue")));
        } else if(!value.path("completion").asText().equals("throw")||!value.get("returnValue").isNull()||!value.get("exception").isObject())throw new IllegalArgumentException("Expected throw schema required");
        var types=javaParameterTypes(binding);var args=value.get("argumentsAfter");
        if(args.size()!=types.size())throw new IllegalArgumentException("Expected argumentsAfter count mismatch");
        var after=JSON.createArrayNode();for(int i=0;i<types.size();i++)after.add(canonical(types.get(i),args.get(i)));expected.set("argumentsAfter",after);
        // Workspace/Spring use Jackson3: never pass a Jackson2 JsonNode across that boundary.
        return JSON.convertValue(expected,Object.class);
    }
    @SuppressWarnings("unchecked")
    static Map<String,String> prepare(Map<String,String> files,Map<String,Object> target,List<Map<String,Object>> cases) {
        var method=validateTarget(files,target);
        if(files.keySet().stream().anyMatch(v->v.endsWith(MAIN+".java")||v.endsWith(ACCESS+".java"))||files.values().stream().anyMatch(v->v.contains("class "+MAIN)||v.contains("class "+ACCESS)))throw new IllegalArgumentException("Reserved harness type collision");
        var params=javaParameterTypes(method);StringBuilder dispatch=new StringBuilder();
        String ownerType=target.get("ownerType").toString();int dot=ownerType.lastIndexOf('.');
        boolean bridge="package_bridge".equals(method.get("invocation")),instance=!"static".equals(method.get("receiver"));
        String access=bridge?ownerType.substring(0,dot+1)+ACCESS:null;
        for(int i=0;i<cases.size();i++) {
            JsonNode args=JSON.valueToTree(cases.get(i).get("arguments"));
            if(!args.isArray()||args.size()!=params.size())throw new IllegalArgumentException("Method argument count mismatch");
            dispatch.append("case ").append(i).append(": {\n");var names=new ArrayList<String>();
            for(int n=0;n<params.size();n++){String name="p"+n;names.add(name);dispatch.append(params.get(n)).append(' ').append(name).append('=').append(literal(params.get(n),args.get(n))).append(";\n");}
            dispatch.append("java.lang.Object[] inputs=new java.lang.Object[]{").append(String.join(",",names)).append("};\n");
            String owner=ownerType,receiver=owner;
            if(instance) {
                // A constructor failure is not a method completion: record it as incomplete.
                receiver="__jbReceiver";
                dispatch.append(bridge?"java.lang.Object":owner).append(" __jbReceiver;\ntry {__jbReceiver=").append(bridge?access+".receiver()":"new "+owner+"()").append(";}catch(java.lang.Throwable error){java.nio.file.Files.writeString(java.nio.file.Path.of(\"/tmp/jb-method-result.json\"),\"{\"+q(\"complete\")+\":false}\",java.nio.charset.StandardCharsets.UTF_8);break;}\n");
            }
            dispatch.append("try {\n");
            var actual=new ArrayList<String>(names);if(bridge&&instance)actual.addFirst(receiver);
            String call=(bridge?access+".call":receiver+"."+target.get("methodName"))+"("+String.join(",",actual)+")";
            if(method.get("returnType").equals("void"))dispatch.append(call).append(";finish(null,null,inputs);\n");else dispatch.append("java.lang.Object returned=").append(call).append(";finish(returned,null,inputs);\n");
            dispatch.append("}catch(java.lang.Throwable error){finish(null,error,inputs);}break;\n}\n");
        }
        String generated=TEMPLATE.replace("__DISPATCH__",dispatch);
        if(generated.length()>262144)throw new IllegalArgumentException("Generated method harness exceeds bounded source budget");
        var output=new TreeMap<>(files);output.put(MAIN+".java",generated);
        if(bridge) {
            // Same-package bridge: Java access rules, not reflection, grant package-private access.
            String ret=javaReturnType(method),simpleOwner=ownerType.substring(dot+1);var formals=new ArrayList<String>();var actuals=new ArrayList<String>();
            for(int n=0;n<params.size();n++){formals.add(params.get(n)+" a"+n);actuals.add("a"+n);}
            if(instance)formals.addFirst("java.lang.Object receiver");
            String invoke=(instance?"(("+simpleOwner+")receiver)":simpleOwner)+"."+target.get("methodName")+"("+String.join(",",actuals)+")";
            String source=ACCESS_TEMPLATE.replace("__PACKAGE__",ownerType.substring(0,dot))
                .replace("__RECEIVER__",instance?"  public static java.lang.Object receiver() throws java.lang.Throwable {return new "+simpleOwner+"();}\n":"")
                .replace("__CALL__","  public static "+ret+" call("+String.join(",",formals)+") throws java.lang.Throwable {"+(ret.equals("void")?"":"return ")+invoke+";}\n");
            output.put(ownerType.substring(0,dot).replace('.','/')+"/"+ACCESS+".java",source);
        }
        if(output.size()>100||output.values().stream().mapToLong(v->v.getBytes(java.nio.charset.StandardCharsets.UTF_8).length).sum()>1048576)throw new IllegalArgumentException("Sources plus harness exceed runner source budget");
        return output;
    }
    static final String ACCESS_TEMPLATE="""
package __PACKAGE__;
public final class __JbMethodAccess {
  private __JbMethodAccess() {}
__RECEIVER____CALL__}
""";
    static final String TEMPLATE="""
public final class __JbMethodHarness {
  static int budget;
  public static void main(java.lang.String[] args) throws java.lang.Exception {
    switch(java.lang.Integer.parseInt(args[0])) { __DISPATCH__ default: throw new java.lang.IllegalArgumentException("case"); }
  }
  static java.lang.String q(java.lang.String s) {
    if(s==null)return "null";java.lang.StringBuilder b=new java.lang.StringBuilder();b.append((char)34);
    for(char c:s.toCharArray()) {if(c==34||c==92)b.append((char)92).append(c);else if(c<32||java.lang.Character.isSurrogate(c))b.append((char)92).append('u').append(java.lang.String.format("%04x",(int)c));else b.append(c);}return b.append((char)34).toString();
  }
  static java.lang.String value(java.lang.Object v) {
    if(++budget>16384)throw new java.lang.IllegalArgumentException("value budget");
    if(v==null)return "null";if(v instanceof java.lang.String||v instanceof java.lang.Character)return q(v.toString());
    if(v instanceof java.lang.Number||v instanceof java.lang.Boolean){java.lang.String s=v.toString();return s.equals("NaN")||s.contains("Infinity")?q(s):s;}
    if(v.getClass().isArray()){int n=java.lang.reflect.Array.getLength(v);if(n>4096)throw new java.lang.IllegalArgumentException("array budget");java.util.ArrayList<java.lang.String> a=new java.util.ArrayList<>();for(int i=0;i<n;i++)a.add(value(java.lang.reflect.Array.get(v,i)));return "["+java.lang.String.join(",",a)+"]";}
    if(v instanceof java.util.Scanner)return "null";
    if(v instanceof java.util.Optional<?>){java.util.Optional<?> o=(java.util.Optional<?>)v;return o.isPresent()?"{"+q("present")+":true,"+q("value")+":"+value(o.get())+"}":"{"+q("present")+":false}";}
    if(v instanceof java.util.Map<?,?>){java.util.Map<?,?> m=(java.util.Map<?,?>)v;if(m.size()>4096)throw new java.lang.IllegalArgumentException("map budget");java.util.ArrayList<java.lang.String> a=new java.util.ArrayList<>();for(java.util.Map.Entry<?,?> e:m.entrySet())a.add("["+value(e.getKey())+","+value(e.getValue())+"]");return "["+java.lang.String.join(",",a)+"]";}
    if(v instanceof java.util.Collection<?>){java.util.Collection<?> c=(java.util.Collection<?>)v;if(c.size()>4096)throw new java.lang.IllegalArgumentException("collection budget");java.util.ArrayList<java.lang.String> a=new java.util.ArrayList<>();for(java.lang.Object e:c)a.add(value(e));return "["+java.lang.String.join(",",a)+"]";}
    throw new java.lang.IllegalArgumentException("unsupported result");
  }
  @java.lang.SuppressWarnings("unchecked")
  static <C> C fill(C target,java.lang.Object[] items) {for(java.lang.Object item:items)((java.util.Collection<java.lang.Object>)target).add(item);return target;}
  @java.lang.SuppressWarnings("unchecked")
  static <M> M put(M target,java.lang.Object[] pairs) {for(int i=0;i<pairs.length;i+=2)((java.util.Map<java.lang.Object,java.lang.Object>)target).put(pairs[i],pairs[i+1]);return target;}
  static java.lang.String error(java.lang.Throwable e,int depth,java.util.IdentityHashMap<java.lang.Throwable,java.lang.Boolean> seen) {
    if(e==null)return "null";if(depth>8||++budget>64||seen.put(e,true)!=null)throw new java.lang.IllegalArgumentException("exception graph incomplete");
    java.util.ArrayList<java.lang.String> suppressed=new java.util.ArrayList<>();if(e.getSuppressed().length>16)throw new java.lang.IllegalArgumentException("suppressed budget");
    for(java.lang.Throwable s:e.getSuppressed())suppressed.add(error(s,depth+1,seen));
    return "{"+q("type")+":"+q(e.getClass().getName())+","+q("message")+":"+q(e.getMessage())+","+q("cause")+":"+error(e.getCause(),depth+1,seen)+","+q("suppressed")+":"+"["+java.lang.String.join(",",suppressed)+"]}";
  }
  static void finish(java.lang.Object result,java.lang.Throwable failure,java.lang.Object[] args) throws java.lang.Exception {
    java.lang.String json;try {budget=0;
      java.util.ArrayList<java.lang.String> after=new java.util.ArrayList<>();for(java.lang.Object a:args)after.add(value(a));
      java.lang.String returned=failure==null?value(result):"null";budget=0;
      java.lang.String exception=error(failure,0,new java.util.IdentityHashMap<>());
      json="{"+q("complete")+":true,"+q("completion")+":"+q(failure==null?"return":"throw")+","+q("returnValue")+":"+returned+","+q("exception")+":"+exception+","+q("argumentsAfter")+":["+java.lang.String.join(",",after)+"]}";
      if(json.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>65536)throw new java.lang.IllegalArgumentException("result budget");
    }catch(java.lang.Throwable unsupported){json="{"+q("complete")+":false}";}
    java.nio.file.Files.writeString(java.nio.file.Path.of("/tmp/jb-method-result.json"),json,java.nio.charset.StandardCharsets.UTF_8);
  }
}
""";
}
