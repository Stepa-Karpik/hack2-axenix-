package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;

import java.net.http.HttpClient;
import java.nio.ByteBuffer;
import java.util.*;
import java.util.concurrent.Flow;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

class AssistantProviderTest {
  AssistantProvider provider =
      new AssistantProvider("", "deepseek-flash", HttpClient.newHttpClient());

  @Test
  void targetedLookupAndExplicitWalkthroughAreBoundedCapabilities() {
    var photo=AssistantActions.validate("guide",map("topic","profile_photo","mode","locate"));
    assertEquals("confirm",photo.risk());assertEquals("profile_photo",photo.args().get("topic"));
    assertEquals("walkthrough",AssistantActions.validate("guide",map("topic","tests","mode","walkthrough")).args().get("mode"));
    assertThrows(ApiError.class,()->AssistantActions.validate("guide",map("topic","profile_photo","mode","click_arbitrary_selector")));
    assertThrows(ApiError.class,()->AssistantActions.validate("guide",map("topic","profile_photo","selector","body")));
  }

  @Test
  void allLocationTopicsRemainBoundedAndRequireConfirmation() {
    for(String topic : AssistantActions.TOPICS) {
      var proposal=AssistantActions.validate("guide",map("topic",topic,"mode","locate"));
      assertEquals("confirm",proposal.risk());
      assertEquals(topic,proposal.args().get("topic"));
    }
    assertThrows(ApiError.class,()->AssistantActions.validate("guide",map("topic","integrations_shell","mode","locate")));
  }

  @Test
  void uiCatalogIsTheSourceOfTruthAndCommandsAreBounded() {
    assertEquals("metrics",AssistantActions.LOCATIONS.get("analysis_metrics").get("tab"));
    assertEquals("problems",AssistantActions.LOCATIONS.get("analysis_problems").get("tab"));
    assertEquals("recommendations",AssistantActions.LOCATIONS.get("optimization").get("tab"));
    for(String action:AssistantActions.WORKSPACE_ACTIONS) assertEquals("confirm",AssistantActions.validate("workspace_action",map("action",action)).risk());
    assertThrows(ApiError.class,()->AssistantActions.validate("workspace_action",map("action","arbitrary_click")));
    assertEquals("confirm",AssistantActions.validate("run_program",map()).risk());
  }

  @Test
  void knownQuestionsCannotLoseButtonsOrConfuseAnalysisWithTests() {
    var questions=Map.of("где метрики посмотреть?","analysis_metrics","а где проблемы?","analysis_problems","а где посмотреть результаты анализа?","analysis","как оптимизировать код?","optimization","где рекомендации?","analysis_recommendations","где метрики тестов?","tests_results","где импортировать из GitHub?","files_import");
    questions.forEach((question,topic)->{
      var reply=AssistantActions.knownRequest(question);
      assertNotNull(reply,question);
      assertEquals(1,reply.actions().size());
      assertEquals(topic,reply.actions().getFirst().args().get("topic"),question);
      assertEquals("locate",reply.actions().getFirst().args().get("mode"));
    });
    assertEquals("optimize",AssistantActions.knownRequest("Оптимизируешь?").actions().getFirst().type());
    assertEquals("run_program",AssistantActions.knownRequest("Запусти программу").actions().getFirst().type());
    assertTrue(AssistantActions.knownRequest("Расскажи как оптимизировать код").actions().isEmpty());
    assertNull(AssistantActions.knownRequest("Расскажи как работает система"));
  }

  @Test
  void unconfiguredProviderFailsBeforeNetwork() {
    assertFalse(provider.configured());
    assertEquals(
        "ASSISTANT_NOT_CONFIGURED",
        assertThrows(ApiError.class, () -> provider.complete(List.of(), map())).code);
  }

  @Test
  void socialAndCodeToolsCannotChooseTargetsOutsideTheirBoundedSchemas() {
    for(String type:List.of("friend_request","friend_remove")) {
      assertEquals("confirm",AssistantActions.validate(type,map("username","some_user")).risk());
      assertThrows(ApiError.class,()->AssistantActions.validate(type,map("username","some_user","risk","none")));
    }
    assertEquals("typed",AssistantActions.validate("project_role",map("projectId",id(),"username","some_user","role","editor")).risk());
    assertThrows(ApiError.class,()->AssistantActions.validate("project_role",map("projectId",id(),"username","some_user","role","owner")));
    for(String path:List.of("C:/Users/Main.java","../Main.java","/Main.java","src\\Main.java","src//Main.java"))
      assertThrows(ApiError.class,()->AssistantActions.validate("code_edit",map("baseRevisionId",id(),"filePath",path,"startOffset",0,"endOffset",1,"expectedText","1","replacement","2","intent","semantic_edit")));
    assertThrows(ApiError.class,()->AssistantActions.validate("code_edit",map("baseRevisionId",id(),"filePath","Main.java","startOffset",0.5,"endOffset",1,"expectedText","1","replacement","2","intent","semantic_edit")));
    assertEquals("confirm",AssistantActions.validate("code_edit",map("baseRevisionId",id(),"filePath","src/Main.java","startOffset",0,"endOffset",1,"expectedText","1","replacement","2","intent","semantic_edit")).risk());
  }

  @Test
  void realWindowCommandsAreBoundedGroundedAndQuestionsStayExplanations() {
    var hide=AssistantActions.knownLayoutRequest("Скрой панель анализа").actions().getFirst();
    assertEquals("layout_action",hide.type());assertEquals("hide",hide.args().get("operation"));assertEquals("analysis",hide.args().get("panel"));assertEquals("confirm",hide.risk());
    var swap=AssistantActions.knownLayoutRequest("Поменяй местами код и консоль").actions().getFirst();
    assertEquals("swap",swap.args().get("operation"));assertEquals("console",swap.args().get("targetPanel"));
    var resize=AssistantActions.knownLayoutRequest("Сделай ширину кода 35%").actions().getFirst();
    assertEquals(35,resize.args().get("percent"));assertEquals("width",resize.args().get("axis"));
    assertEquals("save_default",AssistantActions.knownLayoutRequest("Сохрани базовое расположение окон").actions().getFirst().args().get("operation"));
    assertEquals("undock_navigation",AssistantActions.knownLayoutRequest("Открепи панель JavaBlueprints").actions().getFirst().args().get("operation"));
    assertNull(AssistantActions.knownLayoutRequest("Как скрыть панель анализа?"));
    assertNull(AssistantActions.knownLayoutRequest("Покажи как скрыть панель анализа"));
    assertNull(AssistantActions.knownLayoutRequest("Не скрывай код"));
    assertNull(AssistantActions.knownLayoutRequest("Открой проект Demo"));
    assertEquals("navigation",AssistantActions.validate("layout_action",map("operation","open","panel","JavaBlueprints")).args().get("panel"));
    assertThrows(ApiError.class,()->AssistantActions.validate("layout_action",map("operation","resize","panel","code","axis","width","percent",90)));
    assertThrows(ApiError.class,()->AssistantActions.validate("layout_action",map("operation","open","panel","произвольный DOM selector")));
    assertThrows(ApiError.class,()->AssistantActions.validate("layout_action",map("operation","save","script","alert(1)")));
  }

  @Test
  void modelCannotSelectRiskOrInventActions() {
    assertThrows(
        ApiError.class, () -> AssistantActions.validate("delete_project", map("projectId", id())));
    assertThrows(
        ApiError.class,
        () -> AssistantActions.validate("set_theme", map("preset", "oled", "risk", "none")));
    assertThrows(
        ApiError.class,
        () -> AssistantActions.validate("navigate", map("route", "https://evil.invalid")));
    assertEquals(
        "typed",
        AssistantActions.validate("set_visibility", map("projectId", id(), "visibility", "public"))
            .risk());
    assertEquals("confirm", AssistantActions.validate("guide", map("topic", "tests")).risk());
    assertEquals("none", AssistantActions.validate("set_theme", map("preset", "oled")).risk());
  }

  @Test
  void providerRejectsTruncationAndFiltersUnrecognizedCapabilities() {
    var result =
        provider.parse(
            map(
                "choices",
                List.of(
                    map(
                        "finish_reason",
                        "tool_calls",
                        "message",
                        map(
                            "content",
                            null,
                            "tool_calls",
                            List.of(
                                map("function", map("name", "shell", "arguments", "{}")),
                                map("function", map("name", "run_tests", "arguments", "{}"))))))));
    assertEquals(1, result.actions().size());
    assertEquals("run_tests", result.actions().getFirst().type());
    assertThrows(
        ApiError.class,
        () ->
            provider.parse(
                map(
                    "choices",
                    List.of(
                        map("finish_reason", "length", "message", map("content", "partial"))))));
  }

  @Test
  void secretsAreRemovedFromMessagesAndResponses() {
    String text =
        "api_key=super-secret-value password: hunter22 sk-123456789012345678901234"
            + " github_pat_12345678901234567890 Authorization: Bearer opaque-access-secret"
            + " https://user:urlsecret@example.invalid\n"
            + "-----BEGIN PRIVATE KEY-----\n"
            + "abc\n"
            + "-----END PRIVATE KEY-----";
    String clean = AssistantProvider.redact(text);
    assertFalse(clean.contains("super-secret-value"));
    assertFalse(clean.contains("hunter22"));
    assertFalse(clean.contains("123456789012"));
    assertFalse(clean.contains("abc"));
    assertFalse(clean.contains("opaque-access-secret"));
    assertFalse(clean.contains("urlsecret"));
  }

  @Test
  void bodyLimitCancelsBeforeAccumulation() {
    AtomicBoolean cancelled = new AtomicBoolean();
    var body = new AssistantProvider.BoundedBody(4);
    body.onSubscribe(
        new Flow.Subscription() {
          public void request(long n) {}

          public void cancel() {
            cancelled.set(true);
          }
        });
    body.onNext(List.of(ByteBuffer.wrap(new byte[5])));
    assertTrue(cancelled.get());
    assertTrue(body.result.isCompletedExceptionally());
    assertEquals(0, body.bytes.size());
  }
}
