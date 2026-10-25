package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;

import java.util.*;

/** Model output is an untrusted proposal. This is the capability boundary. */
final class AssistantActions {
  static final Map<String,Map<String,Object>> LOCATIONS = loadLocations();
  static final Set<String> TOPICS = Set.copyOf(LOCATIONS.keySet());
  static final Set<String> WORKSPACE_ACTIONS = Set.of("create_file","create_folder","import","run_settings","test_settings","save_code","save_layout","restore_layout","base_layout","stop");
  @SuppressWarnings("unchecked")
  static Map<String,Map<String,Object>> loadLocations() {
    try(var in=AssistantActions.class.getResourceAsStream("/assistant-locations.json")) {
      if(in==null) throw new IllegalStateException("Missing assistant UI catalog");
      return (Map<String,Map<String,Object>>)(Map<?,?>) tools.jackson.databind.json.JsonMapper.builder().build().readValue(in,Map.class);
    } catch(Exception e) { throw new IllegalStateException("Cannot load assistant UI catalog",e); }
  }
  static List<Map<String,Object>> locationDescriptions() {
    return LOCATIONS.entrySet().stream().map(e->map("topic",e.getKey(),"name",e.getValue().get("label"),"description",e.getValue().get("description"))).toList();
  }
  static AssistantProvider.Reply knownRequest(String content) {
    String text=content.toLowerCase(Locale.ROOT);
    boolean lookup=text.matches("(?s).*(где|как |покаж|посмотр|куда|how |where ).*");
    if(!lookup) {
      String command=null;
      if(text.matches("(?s).*(оптимизируй|оптимизируешь).*")) command="optimize";
      if(text.matches("(?s).*запусти.*тест.*")) command="run_tests";
      else if(text.matches("(?s).*запусти.*программ.*")) command="run_program";
      if(command!=null) return new AssistantProvider.Reply("Подготовил действие для текущего файла и метода. Подтвердите выполнение ниже.",List.of(validate(command,map())));
      return null;
    }
    var match=LOCATIONS.entrySet().stream().sorted(Comparator.comparingInt(e->((Number)e.getValue().getOrDefault("lookupPriority",999)).intValue())).filter(e->{
      Object patterns=e.getValue().get("lookupPatterns");
      return patterns instanceof List<?> list && list.stream().anyMatch(p->java.util.regex.Pattern.compile(p.toString(),java.util.regex.Pattern.CASE_INSENSITIVE|java.util.regex.Pattern.UNICODE_CASE).matcher(text).find());
    }).findFirst();
    if(match.isEmpty()) return null;
    var e=match.get();
    boolean explain=(text.contains("расскажи") || text.contains("объясни")) && !text.contains("покаж");
    return new AssistantProvider.Reply(e.getValue().get("description").toString(), explain ? List.of() : List.of(validate("guide",map("topic",e.getKey(),"mode","locate"))));
  }
  static AssistantProvider.Reply knownLayoutRequest(String content) {
    String text=content.strip().toLowerCase(Locale.ROOT);
    if(text.matches("(?s).*(^|\\s)(как|где|куда)\\s.*")) return null;
    // Questions remain explanations; only explicit bounded imperatives become proposals.
    if(!text.matches("(?s)^(открой|покажи|скрой|закрой|спрячь|переключи|разверни|максимизируй|поменяй|переставь|обменяй|сделай|измени|уменьши|увеличь|сбрось|сохрани|восстанови|закрепи|открепи|сверни|верни)(?:\\s|$).*")) return null;
    var panels=new LinkedHashSet<String>();
    String[][] aliases={{"code","код(?:а|ом|у)?(?: java)?|code"},{"analysis","анализ(?:а|ом|у)?|analysis"},
      {"console","консол(?:ь|и|ью)|console"},{"tests","тест(?:ы|ов|ами|ам)?|tests"},{"history","истори(?:я|ю|и|ей)|history"},
      {"project","проект(?:а|ом)?|файл(?:ы|ов|ами)?|files"},{"palette","блок(?:и|ов|ами)?|палитр(?:а|у|ы)|palette"},
      {"changes","изменени(?:я|й|ями)|diff"},{"navigation","javablueprints|навигаци(?:я|ю|и|ей)|navigation"},
      {"graph","схем(?:а|у|ы|ой)|граф(?:а|ом)?|холст|graph"}};
    for(var alias:aliases) if(java.util.regex.Pattern.compile("(?iu)(?<![\\p{L}\\p{N}_])(?:"+alias[1]+")(?![\\p{L}\\p{N}_])").matcher(text).find()) panels.add(alias[0]);
    Map<String,Object> args=null;
    if(text.startsWith("верни") && text.contains("размер"))args=map("operation","unmaximize");
    else if(panels.contains("navigation") && text.matches("(?s)^(закрепи|открепи|сверни|разверни).*") && !text.contains("экран"))
      args=map("operation",text.startsWith("закрепи")?"dock_navigation":text.startsWith("открепи")?"undock_navigation":text.startsWith("сверни")?"collapse_navigation":"expand_navigation");
    else if(text.contains("местами") && panels.size()==2 && text.matches("(?s)^(поменяй|переставь|обменяй).*")) {
      var values=new ArrayList<>(panels);args=map("operation","swap","panel",values.get(0),"targetPanel",values.get(1));
    } else if(text.matches("(?s).*(расположени|компоновк|layout|окон).*")) {
      if(text.startsWith("сохрани"))args=map("operation",text.contains("базов")?"save_default":"save");
      else if(text.startsWith("восстанови"))args=map("operation","restore");
      else if(text.startsWith("сбрось"))args=map("operation","reset");
    }
    if(args==null && panels.size()==1 && (!panels.contains("project")||text.matches("(?s).*(панел|окн|файл).*"))) {
      String panel=panels.iterator().next();
      var percent=java.util.regex.Pattern.compile("(?<!\\d)(\\d{1,3})\\s*%").matcher(text);
      if(percent.find() && (text.contains("ширин")||text.contains("высот"))) {
        int size=Integer.parseInt(percent.group(1));
        if(size>=15&&size<=85)args=map("operation","resize","panel",panel,"axis",text.contains("ширин")?"width":"height","percent",size);
      } else {
        String operation=text.matches("(?s)^(открой|покажи).*" )?"open":text.matches("(?s)^(скрой|закрой|спрячь|сверни).*" )?"hide":text.startsWith("переключи")?"toggle":text.matches("(?s)^(разверни|максимизируй).*" )?"maximize":null;
        if(operation!=null)args=map("operation",operation,"panel",panel);
      }
    }
    return args==null?null:new AssistantProvider.Reply("Подготовил изменение окон. Проверьте параметры и подтвердите выполнение.",List.of(validate("layout_action",args)));
  }
  static final Set<String> PANELS =
      Set.of(
          "code",
          "graph",
          "tests",
          "console",
          "optimization",
          "files",
          "search",
          "diff",
          "history", "analysis", "project", "palette", "changes", "navigation");
  static final Set<String> LAYOUT_OPERATIONS=Set.of("open","hide","toggle","maximize","unmaximize","swap","resize","reset","save","save_default","restore","preset","dock_navigation","undock_navigation","collapse_navigation","expand_navigation");

  record Proposal(
      String type, Map<String, Object> args, String risk, String label, String description) {}

  static Proposal validate(String type, Map<String, Object> input) {
    var args = new LinkedHashMap<String, Object>();
    String risk = "none", label;
    switch (type) {
      case "navigate" -> {
        args.put(
            "route",
            choice(
                input,
                "route",
                Set.of(
                    "projects", "profile", "security", "appearance", "friends", "integrations")));
        label = "Открыть";
      }
      case "set_theme" -> {
        args.put(
            "preset",
            choice(
                input,
                "preset",
                Set.of("oled", "dark", "light", "pearl", "blue", "amber", "slate")));
        label = "Применить тему";
      }
      case "show_panel" -> {
        args.put("panel", choice(input, "panel", PANELS));
        label = "Показать панель";
      }
      case "guide", "explain" -> {
        args.put("topic", choice(input, "topic", TOPICS));
        if(type.equals("guide") && input.containsKey("mode")) args.put("mode",choice(input,"mode",Set.of("locate","walkthrough")));
        risk = "confirm";
        label = type.equals("guide") ? "Показать" : "Рассказать";
      }
      case "find_symbol" -> {
        args.put("query", text(input, "query", 120));
        label = "Найти";
      }
      case "workspace_action" -> {
        args.put("action",choice(input,"action",WORKSPACE_ACTIONS));
        risk="confirm";label="Выполнить";
      }
      case "layout_action" -> {
        String operation=choice(input,"operation",LAYOUT_OPERATIONS); args.put("operation",operation);
        if(Set.of("open","hide","toggle","maximize","swap","resize").contains(operation)) args.put("panel",panel(input,"panel"));
        if(operation.equals("swap")) {
          args.put("targetPanel",panel(input,"targetPanel"));
          if(args.get("panel").equals(args.get("targetPanel"))) throw invalid();
        }
        if(operation.equals("resize")) {
          args.put("axis",choice(input,"axis",Set.of("width","height")));
          int percent=offset(input,"percent"); if(percent<15 || percent>85) throw invalid();args.put("percent",percent);
        }
        if(operation.equals("preset")) args.put("preset",choice(input,"preset",Set.of("default","code","review")));
        risk="confirm";label="Изменить расположение окон";
      }
      case "run_program", "run_tests", "optimize" -> {
        risk = "confirm";
        label = type.equals("run_tests") ? "Запустить тесты" : type.equals("run_program") ? "Запустить программу" : "Оптимизировать";
      }
      case "set_visibility" -> {
        args.put("visibility", choice(input, "visibility", Set.of("public", "private")));
        args.put("projectId", uuid(text(input, "projectId", 36)).toString());
        risk = "typed";
        label = "Изменить видимость";
      }
      case "pin_project" -> {
        args.put("projectId", uuid(text(input, "projectId", 36)).toString());
        if (!(input.get("pinned") instanceof Boolean)) throw invalid();
        args.put("pinned", input.get("pinned"));
        risk = "confirm";
        label = "Изменить закрепление";
      }
      case "update_profile" -> {
        Object bio = input.get("bio");
        if (!(bio instanceof String s) || s.length() > 1000) throw invalid();
        args.put("bio", bio);
        risk = "confirm";
        label = "Изменить описание профиля";
      }
      case "friend_request", "friend_remove" -> {
        args.put("username", username(input));
        risk="confirm";
        label=type.equals("friend_request") ? "Отправить заявку в друзья" : "Удалить из друзей";
      }
      case "friend_accept", "friend_decline" -> {
        args.put("requestId", uuid(text(input,"requestId",36)).toString());
        risk="confirm";
        label=type.equals("friend_accept") ? "Принять заявку" : "Отклонить заявку";
      }
      case "project_role" -> {
        args.put("projectId",uuid(text(input,"projectId",36)).toString());
        args.put("username",username(input));
        args.put("role",choice(input,"role",Set.of("viewer","editor","remove")));
        risk="typed"; label="Изменить доступ к проекту";
      }
      case "code_edit" -> {
        args.put("baseRevisionId",uuid(text(input,"baseRevisionId",36)).toString());
        String path=text(input,"filePath",240);
        // Canonical exact path only, never host filesystem paths.
        if(!path.endsWith(".java") || path.startsWith("/") || path.contains("\\") || path.contains(":")
            || Arrays.stream(path.split("/",-1)).anyMatch(p->p.isEmpty()||p.equals(".")||p.equals(".."))) throw invalid();
        args.put("filePath",path);
        args.put("startOffset",offset(input,"startOffset"));
        args.put("endOffset",offset(input,"endOffset"));
        if((int)args.get("endOffset") < (int)args.get("startOffset")) throw invalid();
        args.put("expectedText",source(input,"expectedText"));
        args.put("replacement",source(input,"replacement"));
        args.put("intent",choice(input,"intent",Set.of("semantic_edit","preserve_behavior")));
        if(args.get("expectedText").equals(args.get("replacement"))) throw invalid();
        risk="confirm"; label="Подготовить правку кода";
      }
      default -> throw invalid();
    }
    if (!input.keySet().equals(args.keySet())) throw invalid();
    return new Proposal(
        type,
        args,
        risk,
        label,
        "Предложение: " + label + ". Выполнение требует отдельного действия.");
  }

  static String text(Map<String, Object> m, String k, int max) {
    Object v = m.get(k);
    if (!(v instanceof String s) || s.isBlank() || s.length() > max) throw invalid();
    return s;
  }

  static String username(Map<String,Object> input) {
    String name=text(input,"username",40);
    if(!name.matches("[A-Za-z0-9_]{3,32}")) throw invalid();
    return name;
  }

  static String panel(Map<String,Object> input,String key) {
    String value=text(input,key,60).strip().toLowerCase(Locale.ROOT).replaceAll("\\s+"," ");
    String panel=switch(value) {
      case "код", "код java", "java", "code" -> "code";
      case "анализ", "analysis", "optimization" -> "analysis";
      case "консоль", "console" -> "console";
      case "тесты", "tests" -> "tests";
      case "история", "history" -> "history";
      case "проект", "файлы", "files", "project" -> "project";
      case "схема", "граф", "холст", "graph" -> "graph";
      case "блоки", "палитра", "palette" -> "palette";
      case "изменения", "разница", "diff", "changes" -> "changes";
      case "javablueprints", "навигация", "navigation" -> "navigation";
      default -> throw invalid();
    };return panel;
  }

  static String source(Map<String,Object> input,String key) {
    if(!(input.get(key) instanceof String s) || s.length()>12000 || s.contains("\u0000")) throw invalid();
    return s;
  }

  static int offset(Map<String,Object> input,String key) {
    Object value=input.get(key);
    if(!(value instanceof Number n) || n.doubleValue()!=n.intValue() || n.intValue()<0 || n.intValue()>2000000) throw invalid();
    return n.intValue();
  }

  static String choice(Map<String, Object> m, String k, Set<String> options) {
    String s = text(m, k, 120);
    if (!options.contains(s)) throw invalid();
    return s;
  }

  static ApiError invalid() {
    return new ApiError(400, "INVALID_ASSISTANT_ACTION", "Unsupported assistant action");
  }

  static boolean serverMutation(String type) {
    return Set.of("set_visibility", "pin_project", "update_profile", "friend_request", "friend_accept", "friend_decline", "friend_remove", "project_role").contains(type);
  }

  static List<Map<String, Object>> tools() {
    var tools = new ArrayList<Map<String, Object>>();
    for (String type :
        List.of(
            "navigate",
            "set_theme",
            "show_panel",
            "guide",
            "explain",
            "find_symbol",
            "run_tests",
            "optimize",
            "run_program",
            "workspace_action",
            "set_visibility",
            "pin_project",
            "update_profile", "friend_request", "friend_accept", "friend_decline", "friend_remove", "project_role", "code_edit", "layout_action")) {
      Map<String, Object> props =
          switch (type) {
            case "navigate" ->
                map(
                    "route",
                    enumeration(
                        Set.of(
                            "projects",
                            "profile",
                            "security",
                            "appearance",
                            "friends",
                            "integrations")));
            case "set_theme" ->
                map(
                    "preset",
                    enumeration(
                        Set.of("oled", "dark", "light", "pearl", "blue", "amber", "slate")));
            case "show_panel" -> map("panel", enumeration(PANELS));
            case "workspace_action" -> map("action",enumeration(WORKSPACE_ACTIONS));
            case "layout_action" -> map("operation",enumeration(LAYOUT_OPERATIONS),"panel",map("type","string"),"targetPanel",map("type","string"),"axis",enumeration(Set.of("width","height")),"percent",map("type","integer","minimum",15,"maximum",85),"preset",enumeration(Set.of("default","code","review")));
            case "guide" -> map("topic", enumeration(TOPICS), "mode", enumeration(Set.of("locate","walkthrough")));
            case "explain" -> map("topic", enumeration(TOPICS));
            case "find_symbol" -> map("query", map("type", "string", "maxLength", 120));
            case "set_visibility" ->
                map(
                    "projectId",
                    map("type", "string"),
                    "visibility",
                    enumeration(Set.of("public", "private")));
            case "pin_project" ->
                map("projectId", map("type", "string"), "pinned", map("type", "boolean"));
            case "update_profile" -> map("bio", map("type", "string", "maxLength", 1000));
            case "friend_request", "friend_remove" -> map("username",map("type","string","maxLength",32));
            case "friend_accept", "friend_decline" -> map("requestId",map("type","string"));
            case "project_role" -> map("projectId",map("type","string"),"username",map("type","string"),"role",enumeration(Set.of("viewer","editor","remove")));
            case "code_edit" -> map("baseRevisionId",map("type","string"),"filePath",map("type","string"),
                "startOffset",map("type","integer","minimum",0),"endOffset",map("type","integer","minimum",0),
                "expectedText",map("type","string","maxLength",12000),"replacement",map("type","string","maxLength",12000),
                "intent",enumeration(Set.of("semantic_edit","preserve_behavior")));
            default -> map();
          };
      tools.add(
          map(
              "type",
              "function",
              "function",
              map(
                  "name",
                  type,
                  "description",
                  "Offer an executable application command (executed after confirmation): "
                      + type
                      + "; never execute or claim success. guide shows UI steps; explain explains"
                      + " steps.",
                  "parameters",
                  map(
                      "type",
                      "object",
                      "properties",
                      props,
                      "required",
                      type.equals("layout_action") ? List.of("operation") : new ArrayList<>(props.keySet()),
                      "additionalProperties",
                      false))));
    }
    return tools;
  }

  private static Map<String, Object> enumeration(Set<String> values) {
    return map("type", "string", "enum", values.stream().sorted().toList());
  }
}
