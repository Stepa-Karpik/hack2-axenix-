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
          "history", "analysis", "project", "palette", "changes");

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

  static String choice(Map<String, Object> m, String k, Set<String> options) {
    String s = text(m, k, 120);
    if (!options.contains(s)) throw invalid();
    return s;
  }

  static ApiError invalid() {
    return new ApiError(400, "INVALID_ASSISTANT_ACTION", "Unsupported assistant action");
  }

  static boolean serverMutation(String type) {
    return Set.of("set_visibility", "pin_project", "update_profile").contains(type);
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
            "update_profile")) {
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
                      new ArrayList<>(props.keySet()),
                      "additionalProperties",
                      false))));
    }
    return tools;
  }

  private static Map<String, Object> enumeration(Set<String> values) {
    return map("type", "string", "enum", values.stream().sorted().toList());
  }
}
