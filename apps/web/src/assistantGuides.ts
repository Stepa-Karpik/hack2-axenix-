import locations from "../../server/src/main/resources/assistant-locations.json";
import type { TourStep } from "./tourSteps";
import { homeSteps, workspaceSteps, accountSteps } from "./tourSteps";

export type AssistantGuideStep = TourStep & {
  waitFor?: "comparison" | "run";
  afterJobId?: string;
};
export type GuideTopic = keyof typeof locations;
export const guideTopics = Object.keys(locations) as GuideTopic[];
export const isGuideTopic = (value: unknown): value is GuideTopic =>
  typeof value === "string" && Object.hasOwn(locations, value);
export const explanations = Object.fromEntries(
  Object.entries(locations).map(([key, value]) => [key, value.description]),
) as Record<GuideTopic, string>;
export function assistantGuideSteps(
  topic: GuideTopic,
  inProject: boolean,
  afterJobId?: string,
): AssistantGuideStep[] {
  if (topic === "profile" || topic.startsWith("profile_"))
    return accountSteps.slice(1, 5);
  if (topic === "appearance") return accountSteps.slice(8, 10);
  const prefix: AssistantGuideStep[] = inProject ? [] : homeSteps;
  if (topic === "search")
    return [
      ...prefix,
      {
        id: "assistant-search",
        target: ".project-command-search input",
        title: "Найдите нужное",
        text: "Введите имя метода, файла, выражение или тип блока. Результаты появятся под поиском.",
        action: "input",
      },
      {
        id: "assistant-search-result",
        target: '.project-search-results [role="option"]',
        title: "Откройте результат",
        text: "Выберите совпадение: сервис покажет соответствующий файл и участок кода или схемы.",
        action: "click",
      },
    ];
  if (topic === "files")
    return [
      ...prefix,
      workspaceSteps[0],
      {
        id: "assistant-files",
        target: ".explorer-tools",
        panel: "project",
        title: "Работа с файлами",
        text: "Здесь создание файла и папки, переименование, перенос, удаление и скачивание. При создании введите имя и нажмите Enter. Изменения исходников сохраняются отдельно.",
        action: "inspect",
      },
    ];
  if (topic === "optimization")
    return [
      ...prefix,
      workspaceSteps[0],
      workspaceSteps[1],
      {
        id: "assistant-optimization",
        target: ".insight-tabs",
        panel: "analysis",
        title: "Рекомендации по коду",
        text: "Откройте рекомендации. Поддерживаемая оптимизация сначала создаёт отдельный кандидат: просмотр разницы, проверка компиляции, сравнение на тестах и только затем применение.",
        action: "inspect",
      },
    ];
  const compare = topic === "tests";
  return [
    ...prefix,
    workspaceSteps[0],
    workspaceSteps[1],
    {
      id: "assistant-open-run",
      target: compare
        ? 'button[aria-label="Сравнить"]:not(:disabled)'
        : ".dock-run:not(:disabled)",
      title: compare ? "Откройте тесты" : "Откройте запуск",
      text: compare
        ? "Нажмите сравнение. Здесь проверяется программа через main на заданных входах; выбранный метод помогает ориентироваться в коде."
        : "Откройте параметры запуска выбранного файла.",
      action: "click",
    },
    {
      id: "assistant-entry",
      target: "#entrypoint",
      title: "Класс с main",
      text: "Проверьте полное имя класса с main, с учётом регистра. Файл без main запускается через основной класс проекта. Нажмите на поле.",
      action: "focus",
    },
    ...(compare
      ? [
          {
            id: "assistant-versions",
            target: ".version-pair",
            title: "Выберите версии",
            text: "Укажите базовую и проверяемую версии. Для одной версии добавьте ожидаемые результаты в тестах. Когда готовы, продолжите.",
            action: "inspect" as const,
          },
        ]
      : [
          {
            id: "assistant-argv",
            target: "#argv",
            title: "Аргументы запуска",
            text: "Аргументы задаются JSON-массивом строк. Если аргументов нет, оставьте [].",
            action: "inspect" as const,
          },
        ]),
    {
      id: "assistant-parameters",
      target: compare ? ".cases-editor" : "#stdin",
      title: compare ? "Параметры тестов" : "Вход программы",
      text: compare
        ? "Выберите версии выше и настройте входы в редакторе тестов. Ожидаемый вывод добавляйте только если он известен. Когда параметры готовы, продолжите."
        : "Задайте начальный ввод. Позже программа сможет запросить ответы в интерактивной консоли. Когда готовы, продолжите.",
      action: "inspect",
    },
    {
      id: "assistant-start",
      target: "[data-assistant-start]:not(:disabled)",
      title: compare ? "Начните проверку" : "Запустите программу",
      text: "Нажмите выделенную кнопку. Пока запрос не принят сервисом, выполнение ещё не началось.",
      action: "click",
    },
    {
      id: "assistant-wait",
      target: compare
        ? "[data-assistant-test-result]"
        : "[data-assistant-run-result]",
      panel: compare ? "tests" : "console",
      title: "Дождитесь результата",
      text: compare
        ? "Здесь появляются статусы и время каждого теста. Дождёмся завершения именно нового прогона."
        : "Программа выполняется. Если нужен ввод, отвечайте в консоли. Остановить выполнение и отправить EOF можно там же.",
      action: "wait",
      waitFor: compare ? "comparison" : "run",
      afterJobId,
    },
    {
      id: "assistant-finished",
      target: compare
        ? "[data-assistant-test-result]"
        : "[data-assistant-run-result]",
      panel: compare ? "tests" : "console",
      title: "Результат выполнения",
      text: "Проверьте итог, версию и входные данные. Ошибка, отмена или различие версий тоже являются результатом; это не означает успешного прохождения тестов.",
      action: "inspect",
    },
  ];
}

export type AssistantLocation = {
  label: string;
  description: string;
  selectors: string[];
  panels: string[];
  route?: string;
  tab?: string;
  menu?: string;
};
export function assistantLocation(topic: GuideTopic): AssistantLocation {
  return locations[topic];
}
